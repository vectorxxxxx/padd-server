import { Codex } from '@codex-data/sdk';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const apiKey = process.env.CODEX_API_KEY;
if (!apiKey) {
    console.error('Missing CODEX_API_KEY. Set it in env or .env file.');
    process.exit(1);
}

const pairId = process.env.PAIR_ID || process.argv[2];
if (!pairId) {
    console.error('Missing pairId. Set PAIR_ID env or pass as first CLI arg.');
    console.error('Example:');
    console.error('  $env:CODEX_API_KEY = "..."; npx tsx server\\scripts\\test_onBarsUpdated.ts "0xpairaddress:1"');
    process.exit(1);
}

const sdk = new Codex(apiKey);

async function main() {
    try {
        console.log('Calling subscriptions.onBarsUpdated for pairId=' + pairId);
        const resp = await (sdk as any).subscriptions.onBarsUpdated({
            input: {
                pairId,
                // optional: you can send quoteToken: 'token0' or 'token1'
            },
        });

        console.log('\n--- Response ---\n');
        console.log(JSON.stringify(resp, null, 2));

        // Save the full response to a JSON file for inspection
        try {
            const outDir = path.resolve(process.cwd(), 'server', 'samples');
            fs.mkdirSync(outDir, { recursive: true });
            const safePair = pairId.replace(/[^a-z0-9_.-]/gi, '_');
            const outFile = path.join(outDir, `${safePair}.onBarsUpdated.json`);
            fs.writeFileSync(outFile, JSON.stringify(resp, null, 2), 'utf8');
            console.log('\nSaved response to:', outFile);
        } catch (fsErr) {
            console.error('Failed to write response to file:', fsErr);
        }
    } catch (err: any) {
        console.error('Request failed:');
        if (err?.response) console.error(JSON.stringify(err.response, null, 2));
        else console.error(err);
        process.exit(1);
    }
}

main();

// Usage (PowerShell, from repo root):
// $env:CODEX_API_KEY = 'your_key_here'
// npx tsx server\scripts\test_onBarsUpdated.ts <pairId>
// or set PAIR_ID env var instead of passing CLI arg.
