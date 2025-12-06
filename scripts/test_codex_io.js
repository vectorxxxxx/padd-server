const https = require('https');
const url = require('url');

const CODEX_API_KEY = process.env.CODEX_API_KEY;
const ENDPOINT = process.env.CODEX_ENDPOINT || 'https://api.codex.io/subscriptions/onBarsUpdated';

if (!CODEX_API_KEY) {
    console.error('Missing Codex API key. Set environment variable CODEX_API_KEY.');
    console.error('You can add it to `padd-ui/.env.local` or set it in your shell before running.');
    process.exit(1);
}

// Example payload: a minimal onBarsUpdated event body.
const payload = {
    symbol: 'BTCUSD',
    timeframe: '1m',
    bars: [
        { t: Date.now(), o: 50000.0, h: 50050.0, l: 49900.0, c: 50010.0, v: 1.234 }
    ]
};

const parsed = url.parse(ENDPOINT);
const postData = JSON.stringify(payload);

const options = {
    hostname: parsed.hostname,
    path: parsed.path,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${CODEX_API_KEY}`
    }
};

const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
        console.log('HTTP', res.statusCode, res.statusMessage);
        try {
            const json = JSON.parse(body);
            console.log('Response JSON:');
            console.log(JSON.stringify(json, null, 2));
        } catch (err) {
            console.log('Response (raw):');
            console.log(body);
        }
    });
});

req.on('error', (e) => {
    console.error('Request error:', e);
});

req.write(postData);
req.end();

// Usage (PowerShell, from repo root):
// $env:CODEX_API_KEY = 'your_key_here'; node "server\\scripts\\test_codex_io.js"
