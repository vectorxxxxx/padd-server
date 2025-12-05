import type { Request, Response } from "express";
import { log } from "./vite";

const DEFAULT_TIMEFRAME = "5m";
const BASE_URL = "https://lite-api.jup.ag/tokens/v2/toptrending";

export interface JupiterTopTrendingStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface JupiterTopTrendingToken {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  launchpad?: string;
  metaLaunchpad?: string;
  usdPrice?: number;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  holderCount?: number;
  tags?: string[];
  stats5m?: JupiterTopTrendingStats;
  stats1h?: JupiterTopTrendingStats;
  stats6h?: JupiterTopTrendingStats;
  stats24h?: JupiterTopTrendingStats;
  stats7d?: { priceChange?: number };
  stats30d?: { priceChange?: number };
  organicScore?: number;
  organicScoreLabel?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface JupiterTopTrendingBroadcastPayload {
  timeframe: string;
  limit: number;
  tokens: JupiterTopTrendingToken[];
  fetchedAt: string | null;
  error?: string;
}

interface JupiterTopTrendingServiceOptions {
  fetchIntervalMs?: number;
  limit?: number;
  timeframe?: string;
  requestTimeoutMs?: number;
}

export class JupiterTopTrendingService {
  private tokens: JupiterTopTrendingToken[] = [];
  private fetchedAt: Date | null = null;
  private lastError: string | undefined;
  private interval: NodeJS.Timeout | null = null;
  private readonly subscribers = new Set<Response>();
  private readonly fetchIntervalMs: number;
  private readonly limit: number;
  private readonly timeframe: string;
  private readonly requestTimeoutMs: number;

  constructor(options: JupiterTopTrendingServiceOptions = {}) {
    this.fetchIntervalMs = Math.max(options.fetchIntervalMs ?? 5_000, 1_000);
    this.limit = Math.max(options.limit ?? 100, 1);
    this.timeframe = options.timeframe ?? DEFAULT_TIMEFRAME;
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
  }

  getSnapshot(): JupiterTopTrendingBroadcastPayload {
    return {
      timeframe: this.timeframe,
      limit: this.limit,
      tokens: this.tokens,
      fetchedAt: this.fetchedAt?.toISOString() ?? null,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
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
      const url = `${BASE_URL}/${this.timeframe}?limit=${this.limit}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "slab-trade/1.0 (+https://slab.trade)",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Jupiter top trending API responded with ${response.status}`);
      }

      const tokens = (await response.json()) as JupiterTopTrendingToken[];
      this.tokens = tokens;
      this.fetchedAt = new Date();
      this.lastError = undefined;

      this.broadcast("update", this.getSnapshot());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error fetching Jupiter top trending tokens";

      // Don't spam logs with rate limit errors - they're expected
      if (!message.includes('429') && !message.includes('rate limit')) {
        this.lastError = message;
        log(`[JupiterTopTrendingService] fetch error: ${message}`);
        this.broadcast("error", this.getSnapshot());
      } else {
        // Just use cached data for rate limits, don't broadcast errors
        this.lastError = undefined;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private broadcast(event: string, payload: JupiterTopTrendingBroadcastPayload) {
    if (!this.subscribers.size) {
      return;
    }

    const data = JSON.stringify(payload);
    for (const res of this.subscribers) {
      if (res.writableEnded) {
        this.subscribers.delete(res);
        continue;
      }
      this.dispatch(res, event, data);
    }
  }

  private dispatch(res: Response, event: string, payload: JupiterTopTrendingBroadcastPayload | string) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  }
}

export const jupiterTopTrendingService = new JupiterTopTrendingService();
