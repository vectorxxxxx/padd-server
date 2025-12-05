import fetch from 'node-fetch';

const JUP_URL = 'https://lite-api.jup.ag/ultra/v1/order';
const DEFAULT_TAKER = 'vBXNsd5SRtTPpW7GWv3wREA6Ztm2jCWp5eqqTsVhyG5';

const MIN_INTERVAL_MS = 15000;
let lastRequestAt = 0;
let backoffUntil = 0;
let lastCached: { key: string; res: JupiterResponse } | null = null;

type JupiterResponse = {
    outAmount: string | null;
    raw: any;
    status: number;
    ok: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJupiterQuoteServer(params: { inMint: string; outMint: string; amount: string | number; taker?: string }): Promise<JupiterResponse | null> {
    const { inMint, outMint, amount, taker = DEFAULT_TAKER } = params;
    if (!inMint || !outMint || amount == null) return null;
    const a = String(amount);
    const key = `${inMint}:${outMint}:${a}`;

    const now = Date.now();
    if (now < backoffUntil) {
        if (lastCached && lastCached.key === key) return lastCached.res;
        return { outAmount: null, raw: 'rate-limit-backoff', status: 429, ok: false };
    }

    const earliest = Math.max(backoffUntil, lastRequestAt + MIN_INTERVAL_MS);
    if (now < earliest) {
        await sleep(earliest - now);
    }

    const url = `${JUP_URL}?${new URLSearchParams({
        inputMint: inMint,
        outputMint: outMint,
        amount: a,
        taker,
    }).toString()}`;

    try {
        const res = await fetch(url);
        lastRequestAt = Date.now();
        const text = await res.text();
        const json = (() => {
            try { return JSON.parse(text); } catch { return null; }
        })();
        const outAmount = json?.outAmount ?? json?.out_amount ?? null;
        if (res.status === 429) {
            backoffUntil = Date.now() + 20000;
        } else {
            backoffUntil = 0;
        }
        const payload: JupiterResponse = { outAmount: outAmount != null ? String(outAmount) : null, raw: json ?? text, status: res.status, ok: res.ok };
        if (res.ok) lastCached = { key, res: payload };
        return payload;
    } catch (err) {
        return null;
    }
}
