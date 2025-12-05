const https = require('https');
const fs = require('fs');
const path = require('path');

const urlBase = 'https://lite-api.jup.ag/tokens/v2/toptrending/5m';
const limit = 50;
const url = `${urlBase}?limit=${limit}`;
const headers = { 'User-Agent': 'slab-trade/1.0 (+https://slab.trade)', Accept: 'application/json' };

function fetchJson(u) {
    return new Promise((resolve, reject) => {
        const req = https.get(u, { headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                try {
                    const json = JSON.parse(body);
                    resolve(json);
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function tryFetchWithRetries(retries = 4) {
    let attempt = 0;
    while (attempt <= retries) {
        try {
            const data = await fetchJson(url);
            const outPath = path.resolve(__dirname, '..', 'toptrending sample.json');
            fs.writeFileSync(outPath, JSON.stringify({ fetchedAt: new Date().toISOString(), tokens: data }, null, 2));
            console.log('Saved to', outPath);
            return 0;
        } catch (err) {
            attempt += 1;
            const msg = err && err.message ? err.message : String(err);
            console.error(`Attempt ${attempt} failed:`, msg);
            if (attempt > retries) {
                console.error('All attempts failed');
                return 1;
            }
            // exponential backoff
            const wait = 1000 * Math.pow(2, attempt);
            console.log(`Waiting ${wait}ms before retrying...`);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
}

(async () => {
    const code = await tryFetchWithRetries(4);
    process.exit(code);
})();
