import type { Request, Response } from "express";
import fs from "fs";
import path from "path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { z } from "zod";

type GmgnPayload = {
    new_creation?: {
        filters: string[];
        creation_tools?: string[];
        launchpad_platform: string[];
        launchpad_platform_v2: boolean;
        limit: number;
        quote_address_type: number[];
    };
    near_completion?: {
        filters: string[];
        creation_tools?: string[];
        launchpad_platform: string[];
        launchpad_platform_v2: boolean;
        limit: number;
        quote_address_type: number[];
    };
    completed?: {
        filters: string[];
        creation_tools?: string[];
        launchpad_platform: string[];
        launchpad_platform_v2: boolean;
        limit: number;
        quote_address_type: number[];
    };
};

type GmgnPageResponse = {
    status: number;
    text: string;
};

type SearchResponse = {
    data: {
        coins?: any[];
        wallets?: any[];
    };
};

type GmgnTradeHistoryItem = {
    maker: string;
    base_amount: string;
    quote_amount: string;
    amount_usd: string;
    timestamp: number;
    event: "buy" | "sell";
    tx_hash: string;
    price_usd: string;
    id: string;
    token_address: string;
    maker_tags?: string[];
    maker_token_tags?: string[];
    quote_address?: string;
    quote_symbol?: string;
    total_trade?: number;
    balance?: string;
    history_bought_amount?: string;
    history_sold_income?: string;
    history_sold_amount?: string;
    realized_profit?: string;
    unrealized_profit?: string;
    maker_name?: string;
    maker_twitter_username?: string;
    maker_twitter_name?: string;
    maker_avatar?: string;
    maker_ens?: string;
    [key: string]: unknown;
};

type GmgnTokenTradesResponse = {
    code: number;
    message?: string;
    reason?: string;
    data?: {
        history?: GmgnTradeHistoryItem[];
    };
};

type TokenTradesOptions = {
    limit?: number;
    maker?: string | null;
};

type TokenTradesOptions = {
    limit?: number;
    maker?: string | null;
};

const GMGN_ENDPOINT =
    "https://gmgn.ai/vas/api/v1/rank/sol?device_id=49b22ff5-7016-40e2-8e02-d44bd418ffbc&fp_did=48c16a59351f207653dee11a1d5a84e4&client_id=gmgn_web_20251029-6163-7261a63&from_app=gmgn&app_ver=20251029-6163-7261a63&tz_name=Africa%2FLagos&tz_offset=3600&app_lang=en-US&os=web";
const GMGN_SEARCH_ENDPOINT = "https://gmgn.ai/vas/api/v1/search_v2";
const GMGN_SEARCH_V3_ENDPOINT = "https://gmgn.ai/vas/api/v1/search_v3";
const GMGN_TOKEN_TRADES_BASE = "https://gmgn.ai/vas/api/v1/token_trades/sol";
const GMGN_TOKEN_HOLDERS_BASE = "https://gmgn.ai/vas/api/v1/token_holders/sol";
const GMGN_SEARCH_DEFAULT_PARAMS = {
    device_id: "49b22ff5-7016-40e2-8e02-d44bd418ffbc",
    fp_did: "48c16a59351f207653dee11a1d5a84e4",
    client_id: "gmgn_web_20251113-7127-3452e32",
    from_app: "gmgn",
    app_ver: "20251113-7127-3452e32",
    tz_name: "Africa/Lagos",
    tz_offset: "3600",
    app_lang: "en-US",
    os: "web",
    worker: "0",
};
const GMGN_HEADERS = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    origin: "https://gmgn.ai",
    referer: "https://gmgn.ai/?chain=sol",
    "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
} as const;
const GMGN_HOME_URL = "https://gmgn.ai/?chain=sol";

// Allow overriding the Puppeteer profile directory via env var for scripts/tests so
// multiple processes can run without colliding on the same userDataDir.
const PUPPETEER_PROFILE_DIR = process.env.PUPPETEER_PROFILE_DIR
    ? path.resolve(process.env.PUPPETEER_PROFILE_DIR)
    : path.resolve(process.cwd(), ".local", "puppeteer_profile");
const PUPPETEER_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-web-security",
    "--disable-gpu",
] as const;

let gmgnBrowser: Browser | null = null;
let gmgnPage: Page | null = null;
let gmgnPageReadyPromise: Promise<Page> | null = null;

let newTokenCache: any[] = [];
let nearCompletionCache: any[] = [];
let completedCache: any[] = [];
let lastNewFetchTime = 0;
let lastStatusFetchTime = 0;
let lastNearCompletionSignature = "";
let lastCompletedSignature = "";
let isFetchingNew = false;
let isFetchingStatus = false;
let newPollingInterval: NodeJS.Timeout | null = null;
let statusPollingInterval: NodeJS.Timeout | null = null;
let isPollingActive = false;
const seenTokenAddresses = new Set<string>();
const sseClients: Set<Response> = new Set();

const MAX_STATUS_CACHE_SIZE = 120;

function resolveTokenKey(token: any): string | null {
    if (!token || typeof token !== "object") {
        return null;
    }

    const candidates = [token.address, token.token, token.mint, token.id, token.signature, token.txHash];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }

    return null;
}

function computeSignature(tokens: any[]): string {
    return tokens
        .map((token) => {
            const address = resolveTokenKey(token) ?? "";
            const progress = typeof token?.progress === "number" ? token.progress : "";
            const cap =
                typeof token?.usd_market_cap === "number"
                    ? token.usd_market_cap
                    : typeof token?.market_cap === "number"
                        ? token.market_cap
                        : "";
            return `${address}:${progress}:${cap}`;
        })
        .join("|");
}

async function ensureProfileDir() {
    try {
        await fs.promises.mkdir(PUPPETEER_PROFILE_DIR, { recursive: true });
    } catch {
        // ignore errors creating profile directory
    }
}

async function initGmgnBrowser(): Promise<Browser> {
    if (gmgnBrowser) {
        try {
            if (gmgnBrowser.isConnected()) {
                return gmgnBrowser;
            }
        } catch {
            // fall through and relaunch
        }
    }

    await ensureProfileDir();
    gmgnBrowser = await puppeteer.launch({
        headless: true,
        userDataDir: PUPPETEER_PROFILE_DIR,
        args: [...PUPPETEER_ARGS],
    });

    gmgnBrowser.on("disconnected", () => {
        gmgnBrowser = null;
    });

    return gmgnBrowser;
}

async function createGmgnPage(browser: Browser): Promise<Page> {
    const page = await browser.newPage();
    await page.setUserAgent(GMGN_HEADERS["user-agent"]);
    await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-CH-UA": '"Google Chrome";v="120", "Chromium";v="120", "Not=A?Brand";v="24"',
        "Sec-CH-UA-Platform": '"Windows"',
        "Sec-CH-UA-Mobile": "?0",
    });

    await page.goto(GMGN_HOME_URL, {
        waitUntil: "networkidle2",
        timeout: 60_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return page;
}

async function getGmgnPage(force = false): Promise<Page> {
    if (force && gmgnPage) {
        if (!gmgnPage.isClosed()) {
            try {
                await gmgnPage.close();
            } catch {
                // ignore close errors
            }
        }
        gmgnPage = null;
    }

    if (gmgnPage && !gmgnPage.isClosed()) {
        return gmgnPage;
    }

    if (!gmgnPageReadyPromise) {
        gmgnPageReadyPromise = (async () => {
            const browser = await initGmgnBrowser();
            const page = await createGmgnPage(browser);
            page.on("close", () => {
                if (gmgnPage === page) {
                    gmgnPage = null;
                }
            });
            gmgnPage = page;
            return page;
        })();
    }

    try {
        return await gmgnPageReadyPromise;
    } finally {
        gmgnPageReadyPromise = null;
    }
}

let gmgnShuttingDown = false;

async function shutdownGmgnResources() {
    if (gmgnShuttingDown) {
        return;
    }

    gmgnShuttingDown = true;

    if (gmgnPage && !gmgnPage.isClosed()) {
        try {
            await gmgnPage.close();
        } catch {
            // ignore close errors
        }
    }

    gmgnPage = null;

    if (gmgnBrowser) {
        try {
            await gmgnBrowser.close();
        } catch {
            // ignore close errors
        }
    }

    gmgnBrowser = null;
}

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];

TERMINATION_SIGNALS.forEach((signal) => {
    process.once(signal, () => {
        shutdownGmgnResources()
            .catch((error) => {
                console.error("[GMGN] Error shutting down Puppeteer:", error);
            })
            .finally(() => {
                process.exit(0);
            });
    });
});

process.once("beforeExit", () => {
    void shutdownGmgnResources();
});

async function requestGmgn<T>(payload: GmgnPayload, attempt = 0): Promise<T> {
    const page = await getGmgnPage(attempt > 0);

    try {
        const result = (await page.evaluate(
            async ({ url, body }: { url: string; body: GmgnPayload }) => {
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        accept: "application/json, text/plain, */*",
                        "content-type": "application/json",
                        origin: "https://gmgn.ai",
                        referer: "https://gmgn.ai/?chain=sol",
                    },
                    body: JSON.stringify(body),
                    credentials: "include",
                });

                const text = await response.text();
                return { status: response.status, text };
            },
            { url: GMGN_ENDPOINT, body: payload },
        )) as GmgnPageResponse;

        if (
            result.status === 403 ||
            result.text.includes("Attention Required") ||
            result.text.includes("cf-error-details")
        ) {
            if (attempt < 2) {
                console.warn("[GMGN] Cloudflare block detected; refreshing Puppeteer session");
                await getGmgnPage(true);
                return requestGmgn(payload, attempt + 1);
            }

            throw new Error(`[GMGN] Request blocked by Cloudflare (status ${result.status})`);
        }

        if (result.status < 200 || result.status >= 300) {
            throw new Error(`[GMGN] Request failed with status ${result.status} :: ${result.text.slice(0, 200)}`);
        }

        try {
            return JSON.parse(result.text) as T;
        } catch (error) {
            if (attempt < 2) {
                console.warn("[GMGN] Non-JSON response received; resetting page");
                await getGmgnPage(true);
                return requestGmgn(payload, attempt + 1);
            }

            throw new Error(`[GMGN] Invalid JSON response :: ${result.text.slice(0, 200)}`);
        }
    } catch (error) {
        if (attempt < 2) {
            console.warn(`[GMGN] Puppeteer evaluation failed (attempt ${attempt + 1}):`, error);
            await getGmgnPage(true);
            return requestGmgn(payload, attempt + 1);
        }

        throw error instanceof Error ? error : new Error(`[GMGN] Unknown error: ${String(error)}`);
    }
}

async function searchGmgnCoins(query: string, chain = "sol", attempt = 0): Promise<SearchResponse> {
    if (!query.trim()) {
        return { data: { coins: [], wallets: [] } };
    }

    const page = await getGmgnPage(attempt > 0);

    const params = new URLSearchParams({
        ...GMGN_SEARCH_DEFAULT_PARAMS,
        chain,
        q: query.trim(),
    }).toString();

    // Use the v3 search endpoint which accepts the richer set of query params
    const url = `${GMGN_SEARCH_V3_ENDPOINT}?${params}`;

    try {
        const result = (await page.evaluate(
            async ({ url }: { url: string }) => {
                const response = await fetch(url, {
                    method: "GET",
                    headers: {
                        accept: "application/json, text/plain, */*",
                        "content-type": "application/json",
                        origin: "https://gmgn.ai",
                        referer: "https://gmgn.ai/?chain=sol",
                    },
                    credentials: "include",
                });

                const text = await response.text();
                return { status: response.status, text };
            },
            { url },
        )) as GmgnPageResponse;

        if (
            result.status === 403 ||
            result.text.includes("Attention Required") ||
            result.text.includes("cf-error-details")
        ) {
            if (attempt < 2) {
                console.warn("[GMGN] Search blocked by Cloudflare; refreshing Puppeteer session");
                await getGmgnPage(true);
                return searchGmgnCoins(query, chain, attempt + 1);
            }

            throw new Error(`[GMGN] Search request blocked (status ${result.status})`);
        }

        if (result.status < 200 || result.status >= 300) {
            throw new Error(`[GMGN] Search failed with status ${result.status} :: ${result.text.slice(0, 200)}`);
        }

        try {
            return JSON.parse(result.text) as SearchResponse;
        } catch (error) {
            if (attempt < 2) {
                console.warn("[GMGN] Search returned invalid JSON; refreshing page");
                await getGmgnPage(true);
                return searchGmgnCoins(query, chain, attempt + 1);
            }

            throw new Error(`[GMGN] Invalid search JSON :: ${result.text.slice(0, 200)}`);
        }
    } catch (error) {
        if (attempt < 2) {
            console.warn(`[GMGN] Search request failed (attempt ${attempt + 1}):`, error);
            await getGmgnPage(true);
            return searchGmgnCoins(query, chain, attempt + 1);
        }

        throw error instanceof Error ? error : new Error(String(error));
    }
}

async function fetchTokenTrades(mint: string, opts: TokenTradesOptions = {}, attempt = 0): Promise<GmgnTokenTradesResponse> {
    if (!mint || typeof mint !== "string") {
        throw new Error("Invalid mint address");
    }

    const page = await getGmgnPage(attempt > 0);

    const params = new URLSearchParams({
        ...GMGN_SEARCH_DEFAULT_PARAMS,
        limit: String(opts.limit ?? 50),
        maker: typeof opts.maker === "string" ? opts.maker : "",
    }).toString();

    const url = `${GMGN_TOKEN_TRADES_BASE}/${encodeURIComponent(mint)}?${params}`;

    try {
        const result = (await page.evaluate(
            async ({ url }: { url: string }) => {
                const response = await fetch(url, {
                    method: "GET",
                    headers: {
                        accept: "application/json, text/plain, */*",
                        "content-type": "application/json",
                        origin: "https://gmgn.ai",
                        referer: "https://gmgn.ai/?chain=sol",
                    },
                    credentials: "include",
                });

                const text = await response.text();
                return { status: response.status, text };
            },
            { url },
        )) as GmgnPageResponse;

        if (
            result.status === 403 ||
            result.text.includes("Attention Required") ||
            result.text.includes("cf-error-details")
        ) {
            if (attempt < 2) {
                console.warn("[GMGN] Cloudflare block detected; refreshing Puppeteer session");
                await getGmgnPage(true);
                return fetchTokenTrades(mint, opts, attempt + 1);
            }

            throw new Error(`[GMGN] Request blocked by Cloudflare (status ${result.status})`);
        }

        if (result.status < 200 || result.status >= 300) {
            throw new Error(`[GMGN] Token trades request failed with status ${result.status} :: ${result.text.slice(0, 200)}`);
        }

        try {
            return JSON.parse(result.text) as GmgnTokenTradesResponse;
        } catch (error) {
            if (attempt < 2) {
                console.warn("[GMGN] Non-JSON response received; resetting Puppeteer page");
                await getGmgnPage(true);
                return fetchTokenTrades(mint, opts, attempt + 1);
            }

            throw new Error(`[GMGN] Invalid JSON response :: ${result.text.slice(0, 200)}`);
        }
    } catch (error) {
        if (attempt < 2) {
            console.warn(`[GMGN] fetchTokenTrades failed (attempt ${attempt + 1}):`, error);
            await getGmgnPage(true);
            return fetchTokenTrades(mint, opts, attempt + 1);
        }

        throw error instanceof Error ? error : new Error(String(error));
    }
}

async function fetchTokenHolders(
    mint: string,
    opts: { limit?: number; orderby?: string; direction?: string; cost?: number } = {},
    attempt = 0,
): Promise<any> {
    if (!mint || typeof mint !== "string") {
        throw new Error("Invalid mint address");
    }

    const page = await getGmgnPage(attempt > 0);

    // Build params. If the caller explicitly provides a `limit`, use it.
    // Otherwise set a large default (1000) to avoid GMGN's small default of
    // 20 holders which caused the UI to appear capped. Keep sensible
    // defaults for ordering/direction and a default `cost` when not provided.
    const paramsObj: Record<string, string> = { ...GMGN_SEARCH_DEFAULT_PARAMS };
    paramsObj.limit = String(typeof opts.limit === 'number' ? opts.limit : 1000);
    paramsObj.orderby = String(opts.orderby ?? "amount_percentage");
    paramsObj.direction = String(opts.direction ?? "desc");
    paramsObj.cost = String(typeof opts.cost === "number" ? opts.cost : 20);
    const params = new URLSearchParams(paramsObj).toString();

    const url = `${GMGN_TOKEN_HOLDERS_BASE}/${encodeURIComponent(mint)}?${params}`;

    try {
        const result = (await page.evaluate(
            async ({ url }: { url: string }) => {
                const response = await fetch(url, {
                    method: "GET",
                    headers: {
                        accept: "application/json, text/plain, */*",
                        "content-type": "application/json",
                        origin: "https://gmgn.ai",
                        referer: "https://gmgn.ai/?chain=sol",
                    },
                    credentials: "include",
                });

                const text = await response.text();
                return { status: response.status, text };
            },
            { url },
        )) as GmgnPageResponse;

        if (
            result.status === 403 ||
            result.text.includes("Attention Required") ||
            result.text.includes("cf-error-details")
        ) {
            if (attempt < 2) {
                console.warn("[GMGN] Cloudflare block detected; refreshing Puppeteer session");
                await getGmgnPage(true);
                return fetchTokenHolders(mint, opts, attempt + 1);
            }

            throw new Error(`[GMGN] Request blocked by Cloudflare (status ${result.status})`);
        }

        if (result.status < 200 || result.status >= 300) {
            throw new Error(`[GMGN] Token holders request failed with status ${result.status} :: ${result.text.slice(0, 200)}`);
        }

        try {
            return JSON.parse(result.text) as any;
        } catch (error) {
            if (attempt < 2) {
                console.warn("[GMGN] Non-JSON response received; resetting Puppeteer page");
                await getGmgnPage(true);
                return fetchTokenHolders(mint, opts, attempt + 1);
            }

            throw new Error(`[GMGN] Invalid JSON response :: ${result.text.slice(0, 200)}`);
        }
    } catch (error) {
        if (attempt < 2) {
            console.warn(`[GMGN] fetchTokenHolders failed (attempt ${attempt + 1}):`, error);
            await getGmgnPage(true);
            return fetchTokenHolders(mint, opts, attempt + 1);
        }

        throw error instanceof Error ? error : new Error(String(error));
    }
}

function broadcastSse(message: Record<string, unknown>) {
    const payload = `data: ${JSON.stringify(message)}\n\n`;

    sseClients.forEach((client) => {
        try {
            client.write(payload);
        } catch (error) {
            console.error("[SSE] Error sending to client:", error);
            sseClients.delete(client);
        }
    });
}

async function fetchStatusTokens() {
    if (isFetchingStatus) {
        return;
    }

    isFetchingStatus = true;

    try {
        const payload: GmgnPayload = {
            new_creation: {
                filters: ["offchain", "onchain"],
                launchpad_platform: ["Pump.fun", "letsbonk", "bags", "moonshot_app", "heaven", "sugar", "token_mill", "believe"],
                launchpad_platform_v2: true,
                limit: 80,
                quote_address_type: [4, 5, 3, 1],
            },
            near_completion: {
                filters: ["offchain", "onchain"],
                launchpad_platform: ["Pump.fun", "letsbonk", "bags", "moonshot_app", "heaven", "sugar", "token_mill", "believe"],
                launchpad_platform_v2: true,
                limit: 160,
                quote_address_type: [4, 5, 3, 1],
            },
            completed: {
                filters: ["offchain", "onchain"],
                launchpad_platform: ["Pump.fun", "letsbonk", "bags", "moonshot_app", "heaven", "sugar", "token_mill", "believe"],
                launchpad_platform_v2: true,
                limit: 60,
                quote_address_type: [4, 5, 3, 1],
            },
        };

        const json = await requestGmgn<any>(payload);

        if (!json?.data) {
            console.warn("[Token Cache] No data in GMGN status response");
            return;
        }

        const pumpTokens = json.data.pump || [];
        const nearCompletionTokens = json.data.near_completion || [];
        const nearTokens = (pumpTokens.length > 0 ? pumpTokens : nearCompletionTokens).slice(
            0,
            MAX_STATUS_CACHE_SIZE,
        );
        const completedTokens = (json.data.completed || []).slice(0, MAX_STATUS_CACHE_SIZE);

        const nearSignature = computeSignature(nearTokens);
        const completedSignature = computeSignature(completedTokens);
        const now = Date.now();
        let broadcastCount = 0;

        if (nearSignature !== lastNearCompletionSignature) {
            nearCompletionCache = nearTokens;
            lastNearCompletionSignature = nearSignature;
            broadcastSse({
                type: "near_completion_snapshot",
                tokens: nearCompletionCache,
                timestamp: now,
            });
            broadcastCount += 1;
        }

        if (completedSignature !== lastCompletedSignature) {
            completedCache = completedTokens;
            lastCompletedSignature = completedSignature;
            broadcastSse({
                type: "completed_snapshot",
                tokens: completedCache,
                timestamp: now,
            });
            broadcastCount += 1;
        }

        if (broadcastCount > 0) {
            lastStatusFetchTime = now;
            console.log(
                `[Token Cache] Refreshed status buckets (near_completion: ${nearCompletionCache.length}, completed: ${completedCache.length})`,
            );
        }
    } catch (error) {
        console.error("[Token Cache] Error fetching status buckets:", error);
    } finally {
        isFetchingStatus = false;
    }
}

async function fetchNewTokens() {
    if (isFetchingNew) {
        return;
    }

    isFetchingNew = true;

    try {
        const payload: GmgnPayload = {
            new_creation: {
                filters: ["offchain", "onchain"],
                launchpad_platform: ["Pump.fun", "letsbonk", "bags", "moonshot_app", "heaven", "sugar", "token_mill", "believe"],
                launchpad_platform_v2: true,
                limit: 80,
                quote_address_type: [4, 5, 3, 1],
            },
        };

        const json = await requestGmgn<any>(payload);

        if (!json?.data) {
            console.warn("[Token Cache] No data in GMGN response");
            return;
        }

        const tokens = Array.isArray(json.data.new_creation) ? json.data.new_creation : [];

        if (tokens.length === 0) {
            return;
        }

        const newTokens: any[] = [];
        const seenThisBatch = new Set<string>();

        tokens.forEach((token: any) => {
            const key = resolveTokenKey(token);
            if (!key || seenThisBatch.has(key)) {
                return;
            }

            seenThisBatch.add(key);

            if (!seenTokenAddresses.has(key)) {
                newTokens.push(token);
            }
        });
        const existingTokensWithUpdates: any[] = [];

        tokens.forEach((token: any) => {
            const key = resolveTokenKey(token);
            if (!key) {
                return;
            }

            if (seenTokenAddresses.has(key)) {
                const index = newTokenCache.findIndex((existing) => resolveTokenKey(existing) === key);
                if (index !== -1) {
                    newTokenCache[index] = token;
                    existingTokensWithUpdates.push(token);
                }
            }
        });

        if (existingTokensWithUpdates.length > 0) {
            broadcastSse({
                type: "token_updates",
                tokens: existingTokensWithUpdates,
                timestamp: Date.now(),
            });
        }

        if (newTokens.length > 0) {
            newTokens.forEach((token: any) => {
                const key = resolveTokenKey(token);
                if (key) {
                    seenTokenAddresses.add(key);
                }
            });
            newTokenCache = [...newTokens, ...newTokenCache].slice(0, 50);
            lastNewFetchTime = Date.now();

            broadcastSse({
                type: "new_tokens",
                tokens: newTokens,
                timestamp: lastNewFetchTime,
            });

            console.log(
                `[Token Cache] Added ${newTokens.length} new tokens (cache size: ${newTokenCache.length}, seen: ${seenTokenAddresses.size})`,
            );
        }
    } catch (error) {
        console.error("[Token Cache] Error fetching new_creation tokens:", error);
    } finally {
        isFetchingNew = false;
    }
}

function startServerPolling() {
    if (isPollingActive) {
        return;
    }

    isPollingActive = true;

    if (!newPollingInterval) {
        newPollingInterval = setInterval(fetchNewTokens, 400);
    }

    if (!statusPollingInterval) {
        statusPollingInterval = setInterval(fetchStatusTokens, 1000);
    }

    void fetchNewTokens();
    void fetchStatusTokens();
    console.log("[Token Cache] GMGN polling started");
}

function stopServerPolling() {
    if (newPollingInterval) {
        clearInterval(newPollingInterval);
        newPollingInterval = null;
    }

    if (statusPollingInterval) {
        clearInterval(statusPollingInterval);
        statusPollingInterval = null;
    }

    isPollingActive = false;
    console.log("[Token Cache] GMGN polling stopped");
}

function clearCache() {
    newTokenCache = [];
    nearCompletionCache = [];
    completedCache = [];
    seenTokenAddresses.clear();
    lastNewFetchTime = 0;
    lastStatusFetchTime = 0;
    lastNearCompletionSignature = "";
    lastCompletedSignature = "";
}

function getSnapshot() {
    return {
        new: newTokenCache,
        nearCompletion: nearCompletionCache,
        completed: completedCache,
        lastNewUpdate: lastNewFetchTime,
        lastStatusUpdate: lastStatusFetchTime,
        counts: {
            new: newTokenCache.length,
            nearCompletion: nearCompletionCache.length,
            completed: completedCache.length,
        },
    };
}

function getStatus() {
    return {
        isPolling: isPollingActive,
        lastNewUpdate: lastNewFetchTime,
        lastStatusUpdate: lastStatusFetchTime,
        counts: {
            new: newTokenCache.length,
            nearCompletion: nearCompletionCache.length,
            completed: completedCache.length,
        },
    };
}

function handleStream(req: Request, res: Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const origin = req.headers.origin;
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Vary", "Origin");

    const initialMessage = {
        type: "initial_state",
        data: {
            new: newTokenCache,
            nearCompletion: nearCompletionCache,
            completed: completedCache,
        },
        timestamp: Date.now(),
    };
    res.write(`data: ${JSON.stringify(initialMessage)}\n\n`);

    sseClients.add(res);
    console.log(`[SSE] Client connected (total: ${sseClients.size})`);

    req.on("close", () => {
        sseClients.delete(res);
        console.log(`[SSE] Client disconnected (total: ${sseClients.size})`);
    });
}

async function testGmgnFetch() {
    const payload: GmgnPayload = {
        new_creation: {
            filters: ["offchain", "onchain"],
            launchpad_platform: ["Pump.fun", "letsbonk", "bags", "moonshot_app", "heaven", "sugar", "token_mill", "believe"],
            launchpad_platform_v2: true,
            limit: 80,
            quote_address_type: [4, 5, 3, 1],
        },
    };

    return requestGmgn<any>(payload);
}

async function validateSearchParams(query: string | undefined, chain: string | undefined) {
    const schema = z.object({
        query: z.string().min(1),
        chain: z.string().min(1).default("sol"),
    });

    return schema.parseAsync({ query, chain });
}

export const gmgnService = {
    start: () => startServerPolling(),
    stop: () => stopServerPolling(),
    clear: () => clearCache(),
    getSnapshot: () => getSnapshot(),
    getStatus: () => getStatus(),
    handleStream: (req: Request, res: Response) => handleStream(req, res),
    search: async (query: string, chain = "sol") => {
        await validateSearchParams(query, chain).catch((error) => {
            throw new Error(error instanceof Error ? error.message : String(error));
        });

        const json = await searchGmgnCoins(query, chain);
        const data = json?.data ?? {};
        return {
            coins: Array.isArray(data.coins) ? data.coins : [],
            wallets: Array.isArray(data.wallets) ? data.wallets : [],
        };
    },
    testFetch: () => testGmgnFetch(),
    getTokenTrades: (mint: string, opts: TokenTradesOptions = {}) => fetchTokenTrades(mint, opts),
    getTokenHolders: (mint: string, opts: { limit?: number; orderby?: string; direction?: string; cost?: number } = {}) => fetchTokenHolders(mint, opts),
    shutdown: () => shutdownGmgnResources(),
    isPolling: () => isPollingActive,
    // Direct v3 lookup (simple GET JSON) - preferred for token-by-mint lookups
    lookup: async (query: string, chain = 'sol') => {
        if (!query || typeof query !== 'string') return null;

        const params = new URLSearchParams({
            ...GMGN_SEARCH_DEFAULT_PARAMS,
            chain,
            q: query,
        }).toString();

        const url = `${GMGN_SEARCH_V3_ENDPOINT}?${params}`;

        try {
            const response = await fetch(url, { headers: GMGN_HEADERS });
            if (!response.ok) {
                throw new Error(`GMGN v3 lookup failed: ${response.status}`);
            }
            const json = await response.json();
            const coins = json?.data?.coins ?? [];
            // Return first matching coin or null
            return Array.isArray(coins) && coins.length > 0 ? coins : null;
        } catch (error) {
            console.error('[GMGN] lookup v3 error:', error);
            return null;
        }
    },
};
