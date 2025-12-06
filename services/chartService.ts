import { URLSearchParams } from "url";

export interface FetchChartCandlesOpts {
    interval?: string;
    limit?: number | string;
    currency?: string;
    createdTs?: string | number;
    program?: string;
    timeoutMs?: number;
}

export async function fetchChartCandles(coin: string, opts: FetchChartCandlesOpts = {}) {
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 15000;

    const base = `https://swap-api.pump.fun/v2/coins/${encodeURIComponent(coin)}/candles`;

    const params = new URLSearchParams();
    if (opts.interval) params.set('interval', String(opts.interval));
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.currency) params.set('currency', String(opts.currency));
    if (opts.createdTs !== undefined && opts.createdTs !== null) {
        const num = Number(opts.createdTs);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
            // ensure we send an integer (pump API validates integer values)
            params.set('createdTs', String(Math.floor(num)));
        }
    }
    if (opts.program) params.set('program', String(opts.program));

    const url = params.toString() ? `${base}?${params.toString()}` : base;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": "slab-trade/1.0 (+https://slab.trade)",
                Accept: "application/json",
            },
        });

        const text = await response.text();
        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }

        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            rawText: text,
            json,
            headers: response.headers,
        };
    } catch (err) {
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}
