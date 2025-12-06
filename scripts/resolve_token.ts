import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { sdk } from '../lib/codex-sdk';

async function graphqlSearch(queryStr: string) {
    const endpoint = process.env.CODEX_ENDPOINT || 'https://api.codex.io/graphql';
    const apiKey = process.env.CODEX_API_KEY;
    if (!apiKey) throw new Error('CODEX_API_KEY not set');

    const graphql = `query SearchTokens($filter: SearchTokensFilter) { searchTokens(filter: $filter) { results { id symbol networkId } } }`;
    const body = { query: graphql, variables: { filter: { query: queryStr } } };

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`GraphQL request failed: ${res.status} ${res.statusText} - ${txt}`);
    }

    const json = await res.json();
    return json?.data?.searchTokens?.results || json?.data || json;
}

async function main() {
    const q = process.argv[2] || process.env.QUERY;
    if (!q) {
        console.error('Usage: npx tsx server\\scripts\\resolve_token.ts <query>');
        console.error('Example: npx tsx server\\scripts\\resolve_token.ts "So11111111111111111111111111111111111111112"');
        process.exit(1);
    }

    console.log('Resolving token for query:', q);

    try {
        // Introspect sdk to show available methods (helpful for debugging)
        console.log('\n--- SDK keys preview ---');
        try {
            console.log(Object.keys(sdk));
            if ((sdk as any).queries) console.log('sdk.queries keys:', Object.keys((sdk as any).queries));
        } catch (e) {
            console.log('Could not introspect sdk:', e);
        }

        // Try several SDK query methods dynamically to handle different SDK shapes
        let results: any[] | undefined;
        const trySdkMethods = async () => {
            const candidateMethods = ['searchTokens', 'filterTokens', 'tokens', 'getToken', 'token'];
            const sdkQueries = (sdk as any).queries || sdk;

            for (const name of candidateMethods) {
                try {
                    const fn = sdkQueries?.[name];
                    if (!fn || typeof fn !== 'function') continue;

                    // try a few different argument shapes
                    const shapes = [
                        { input: { query: q, limit: 5 } },
                        { input: { filter: { query: q }, limit: 5 } },
                        { filter: { query: q }, limit: 5 },
                        { query: q },
                    ];

                    for (const args of shapes) {
                        try {
                            const res = await fn(args);
                            // normalize common shapes
                            const maybeResults = res?.results || res?.data?.results || res?.data || res;
                            if (maybeResults && (Array.isArray(maybeResults) ? maybeResults.length > 0 : true)) {
                                return maybeResults;
                            }
                        } catch (innerErr) {
                            // continue trying other shapes
                        }
                    }
                } catch (e) {
                    // continue to next method
                }
            }
            return undefined;
        };

        try {
            results = await trySdkMethods();
        } catch (e) {
            console.log('SDK dynamic calls failed:', e?.message || e);
        }

        if (!results) {
            // fallback to direct GraphQL HTTP request
            results = await graphqlSearch(q);
        }

        // Save raw results to a file for inspection
        try {
            const outDir = path.resolve(process.cwd(), 'server', 'samples');
            fs.mkdirSync(outDir, { recursive: true });
            const safeQuery = q.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 120);
            const outFile = path.join(outDir, `${safeQuery}.resolve.json`);
            fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
            console.log('\nSaved raw results to:', outFile);
        } catch (writeErr) {
            console.error('Failed to save raw results to file:', writeErr);
        }

        // Normalize results into an array if possible
        let normalized: any[] = [];
        console.log('\n--- Raw results variable ---\n');
        console.log(JSON.stringify(results, null, 2));

        if (!results) {
            console.log('\nNo matching tokens found.');
            process.exit(0);
        }

        if (Array.isArray(results)) normalized = results;
        else if (results.results && Array.isArray(results.results)) normalized = results.results;
        else if (results.data && Array.isArray(results.data)) normalized = results.data;
        else if (results.items && Array.isArray(results.items)) normalized = results.items;
        else if (typeof results === 'object') {
            // maybe it's a single object representing the token
            normalized = [results];
        }

        if (normalized.length === 0) {
            console.log('\nNo matching tokens found (normalized array empty).');
            process.exit(0);
        }

        console.log('\n--- Candidates ---\n');
        normalized.forEach((t: any, i: number) => {
            console.log(`#${i + 1}: id=${t.id} symbol=${t.symbol} networkId=${t.networkId}`);
        });

        const first = normalized[0];
        console.log('\n--- First candidate (JSON) ---\n');
        console.log(JSON.stringify(first, null, 2));
    } catch (err: any) {
        console.error('Error while resolving token:', err?.message || err);
        if (err?.response) console.error(JSON.stringify(err.response, null, 2));
        process.exit(1);
    }
}

main();

// Run from repo root (PowerShell):
// $env:CODEX_API_KEY = 'your_key_here'
// npx tsx server\scripts\resolve_token.ts "solana:So11111111111111111111111111111111111111112"
