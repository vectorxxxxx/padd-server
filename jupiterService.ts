import type { Request, Response } from "express";
import { log } from "./vite";

const JUPITER_RECENT_URL = "https://lite-api.jup.ag/tokens/v2/recent";
const JUPITER_SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search";

export interface JupiterToken {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  launchpad?: string;
  metaLaunchpad?: string;
  [key: string]: unknown;
}

export interface JupiterSearchTokenStats {
  priceChange: number;
  holderChange: number;
  liquidityChange: number;
  volumeChange: number;
  buyVolume: number;
  sellVolume: number;
  buyOrganicVolume: number;
  sellOrganicVolume: number;
  numBuys: number;
  numSells: number;
  numTraders: number;
  numOrganicBuyers: number;
  numNetBuyers: number;
}

export interface JupiterSearchTokenFirstPool {
  id: string;
  createdAt: string;
}

export interface JupiterSearchTokenAudit {
  isSus: boolean;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  topHoldersPercentage: number;
  devBalancePercentage: number;
  devMigrations: number;
}

export interface JupiterSearchToken {
  id: string;
  name: string;
  symbol: string;
  icon: string;
  decimals: number;
  twitter: string;
  telegram: string;
  website: string;
  dev: string;
  circSupply: number;
  totalSupply: number;
  tokenProgram: string;
  launchpad: string;
  partnerConfig: string;
  graduatedPool: string;
  graduatedAt: string;
  holderCount: number;
  fdv: number;
  mcap: number;
  usdPrice: number;
  priceBlockId: number;
  liquidity: number;
  stats5m: JupiterSearchTokenStats;
  stats1h: JupiterSearchTokenStats;
  stats6h: JupiterSearchTokenStats;
  stats24h: JupiterSearchTokenStats;
  firstPool: JupiterSearchTokenFirstPool;
  audit: JupiterSearchTokenAudit;
  organicScore: number;
  organicScoreLabel: "high" | "medium" | "low";
  isVerified: boolean;
  cexes: string[];
  tags: string[];
  updatedAt: string;
}

interface JupiterBroadcastPayload {
  tokens: JupiterToken[];
  fetchedAt: string | null;
  error?: string;
}

interface JupiterServiceOptions {
  fetchIntervalMs?: number;
  maxTokens?: number;
  requestTimeoutMs?: number;
}

export class JupiterService {
  private static readonly allowedLaunchpadSlugs = new Set([
    "pumpfun",
    "letsbonkfun",
    "bonk",
    "jupiterstudio",
  ]);
  private static normalizeLaunchpad(value: unknown): string {
    if (typeof value !== "string") {
      return "";
    }
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  private static looksLikeMintAddress(value: string | undefined | null): boolean {
    if (!value) {
      return false;
    }

    const candidate = value.trim();
    if (candidate.length < 32 || candidate.length > 44) {
      return false;
    }

    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(candidate);
  }

  private tokens: JupiterToken[] = [];
  private fetchedAt: Date | null = null;
  private lastError: string | undefined;
  private interval: NodeJS.Timeout | null = null;
  private readonly subscribers = new Set<Response>();
  private readonly fetchIntervalMs: number;
  private readonly maxTokens: number;

  // Cache for search results
  private searchCache = new Map<string, { tokens: JupiterSearchToken[]; timestamp: number }>();
  private readonly searchCacheTTL = 30000; // 30 seconds cache
  private readonly requestTimeoutMs: number;

  constructor(options: JupiterServiceOptions = {}) {
    this.fetchIntervalMs = Math.max(options.fetchIntervalMs ?? 1_000, 250);
    this.maxTokens = options.maxTokens ?? 200;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async start() {
    if (this.interval) {
      return;
    }

    await this.refresh();
    this.interval = setInterval(() => {
      void this.refresh();
    }, this.fetchIntervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.subscribers.forEach((res) => {
      res.end();
    });
    this.subscribers.clear();
    this.cleanupCache();
  }

  private cleanupCache() {
    const now = Date.now();
    this.searchCache.forEach((entry, key) => {
      if (now - entry.timestamp > this.searchCacheTTL) {
        this.searchCache.delete(key);
      }
    });
  }

  getSnapshot(): JupiterBroadcastPayload {
    return {
      tokens: this.tokens,
      fetchedAt: this.fetchedAt?.toISOString() ?? null,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async searchTokens(query?: string): Promise<JupiterSearchToken[]> {
    const cacheKey = query || 'all';
    const now = Date.now();

    // Check cache first
    const cached = this.searchCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < this.searchCacheTTL) {
      log(`[JupiterService] Returning cached search results for query: "${cacheKey}"`);
      return cached.tokens;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      // Build URL with query parameter if provided
      let url = JUPITER_SEARCH_URL;
      if (query && query.trim()) {
        // Ensure query is properly encoded
        const encodedQuery = encodeURIComponent(query.trim());
        url = `${JUPITER_SEARCH_URL}?query=${encodedQuery}`;
      }

      log(`[JupiterService] Searching with URL: ${url}`);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "slab-trade/1.0 (+https://slab.trade)",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error response');
        log(`[JupiterService] API Error ${response.status}: ${errorText}`);
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const fallbackTokens = cached?.tokens ?? [];
          this.lastError = `Jupiter rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""}`;
          log(
            `[JupiterService] Rate limited. Serving ${fallbackTokens.length} cached tokens for query "${cacheKey}".`
          );
          this.searchCache.set(cacheKey, { tokens: fallbackTokens, timestamp: now });
          return fallbackTokens;
        }
        throw new Error(`Jupiter Search API responded with ${response.status}: ${errorText}`);
      }

      const tokens = (await response.json()) as JupiterSearchToken[];
      const looksLikeMint = JupiterService.looksLikeMintAddress(query);

      const filtered = looksLikeMint
        ? tokens
        : tokens.filter((token) => this.isLaunchpadAllowed(token as unknown as JupiterToken));

      // Cache the results
      this.searchCache.set(cacheKey, { tokens: filtered, timestamp: now });

      log(
        `[JupiterService] Search returned ${filtered.length}/${tokens.length} tokens for query: "${cacheKey}" (cached)`
      );

      return filtered;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error searching Jupiter tokens";
      log(`[JupiterService] search error: ${message}`);
      if (cached?.tokens) {
        log(
          `[JupiterService] Returning ${cached.tokens.length} cached tokens after error for query "${cacheKey}".`
        );
        this.lastError = message;
        return cached.tokens;
      }
      this.lastError = message;
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }

  handleStream(req: Request, res: Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.flushHeaders?.();

    this.subscribers.add(res);

    this.dispatch(res, "init", this.getSnapshot());

    const onClose = () => {
      this.subscribers.delete(res);
      res.end();
    };

    req.on("close", onClose);
    req.on("end", onClose);
  }

  private async refresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(JUPITER_RECENT_URL, {
        signal: controller.signal,
        headers: {
          "User-Agent": "slab-trade/1.0 (+https://slab.trade)",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Jupiter API responded with ${response.status}`);
      }

      const rawData = (await response.json()) as JupiterToken[];
      const filteredTokens = rawData.filter((token) => this.isLaunchpadAllowed(token));

      if (filteredTokens.length !== rawData.length) {
        log(
          `[JupiterService] filtered ${rawData.length - filteredTokens.length} tokens by launchpad`
        );
      }

      const uniqueTokens = this.dedupe(filteredTokens).slice(0, this.maxTokens);

      this.tokens = uniqueTokens;
      this.fetchedAt = new Date();
      this.lastError = undefined;

      this.broadcast("update", this.getSnapshot());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error fetching Jupiter tokens";

      // Don't spam logs with rate limit errors - they're expected
      if (!message.includes('429') && !message.includes('rate limit')) {
        this.lastError = message;
        log(`[JupiterService] fetch error: ${message}`);
        this.broadcast("error", this.getSnapshot());
      } else {
        // Just use cached data for rate limits, don't broadcast errors
        this.lastError = undefined;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private dedupe(tokens: JupiterToken[]): JupiterToken[] {
    const map = new Map<string, JupiterToken>();
    for (const token of tokens) {
      if (token?.id && this.isLaunchpadAllowed(token)) {
        map.set(token.id, token);
      }
    }
    return Array.from(map.values());
  }

  private isLaunchpadAllowed(token: JupiterToken): boolean {
    const normalizedLaunchpad = JupiterService.normalizeLaunchpad(token.launchpad);
    if (normalizedLaunchpad && JupiterService.allowedLaunchpadSlugs.has(normalizedLaunchpad)) {
      return true;
    }

    // Fall back to metaLaunchpad only when launchpad is missing
    if (!normalizedLaunchpad) {
      const metaNormalized = JupiterService.normalizeLaunchpad(token.metaLaunchpad);
      if (metaNormalized && JupiterService.allowedLaunchpadSlugs.has(metaNormalized)) {
        return true;
      }
    }

    return false;
  }

  private broadcast(event: string, payload: JupiterBroadcastPayload) {
    if (!this.subscribers.size) {
      return;
    }

    const data = JSON.stringify(payload);
    this.subscribers.forEach((res) => {
      if (res.writableEnded) {
        this.subscribers.delete(res);
        return;
      }
      this.dispatch(res, event, data);
    });
  }

  private dispatch(res: Response, event: string, payload: JupiterBroadcastPayload | string) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  }
}

export const jupiterService = new JupiterService();
