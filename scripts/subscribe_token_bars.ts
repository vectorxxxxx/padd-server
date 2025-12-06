import 'dotenv/config';
import fs from 'fs';
import { createClient } from 'graphql-ws';
import path from 'path';
import WebSocket from 'ws';

const API_KEY = process.env.CODEX_API_KEY;
if (!API_KEY) {
    console.error('Missing CODEX_API_KEY in env. Set it before running.');
    process.exit(1);
}

const tokenId = process.env.TOKEN_ID || process.argv[2];
if (!tokenId) {
    console.error('Usage: npx tsx server\\scripts\\subscribe_token_bars.ts <tokenId> [networkId]');
    console.error('Example: npx tsx server\\scripts\\subscribe_token_bars.ts "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN:1399811149"');
    process.exit(1);
}

const networkIdArg = process.env.NETWORK_ID || process.argv[3];
const networkId = networkIdArg ? parseInt(String(networkIdArg), 10) : undefined;

const WS_URL = process.env.CODEX_WS_URL || 'wss://graph.codex.io/graphql';

const SUBSCRIPTION = `
subscription OnTokenBarsUpdated($tokenId: String!, $networkId: Int) {
  onTokenBarsUpdated(tokenId: $tokenId, networkId: $networkId) {
    tokenId
    tokenAddress
    networkId
    timestamp
    statsType
    eventSortKey
    aggregates {
      resolution
      open
      high
      low
      close
      volume
    }
  }
}
`;

const outDir = path.resolve(process.cwd(), 'server', 'samples');
fs.mkdirSync(outDir, { recursive: true });
const safeToken = tokenId.replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 160);
const outFile = path.join(outDir, `${safeToken}.bars.json`);

const client = createClient({
    url: WS_URL,
    webSocketImpl: WebSocket as any,
    // Some GraphQL WebSocket servers expect the API key in different shapes.
    // Send several common forms so the Codex gateway accepts at least one.
    connectionParams: () => ({
        // Standard bearer token header
        Authorization: `Bearer ${API_KEY}`,
        // Some servers expect an `apiKey` field in the connection init payload
        apiKey: API_KEY,
        // Another common header name
        'x-api-key': API_KEY,
    }),
});

console.log('Connecting to', WS_URL);
console.log('Subscribing to onTokenBarsUpdated for', tokenId, 'networkId=', networkId);

const appendBars = (payload: any) => {
    try {
        let store: any = { events: [] };
        if (fs.existsSync(outFile)) {
            try {
                const raw = fs.readFileSync(outFile, 'utf8');
                store = JSON.parse(raw);
            } catch (e) {
                console.warn('Corrupt existing file, overwriting.');
                store = { events: [] };
            }
        }

        // Normalize incoming structure
        const event = payload?.data?.onTokenBarsUpdated || payload?.onTokenBarsUpdated || payload;
        if (!event) return;

        // Push event (timestamp + aggregates) for later charting
        store.events.push({ receivedAt: Date.now(), event });
        fs.writeFileSync(outFile, JSON.stringify(store, null, 2), 'utf8');
        console.log('Appended event to', outFile);
    } catch (err) {
        console.error('Failed to append bars:', err);
    }
};

const dispose = client.subscribe(
    {
        query: SUBSCRIPTION,
        variables: { tokenId, networkId },
    },
    {
        next: (data) => {
            console.log('Received payload');
            appendBars(data);
        },
        error: (err) => {
            console.error('Subscription error', err);
        },
        complete: () => {
            console.log('Subscription complete');
        },
    }
);

// Keep process alive. The graphql-ws client returns an unsubscribe function, but
// `dispose` here is an unsubscribe callback when called.
process.on('SIGINT', () => {
    console.log('\nSIGINT - unsubscribing and exiting');
    try {
        if (typeof dispose === 'function') dispose();
    } catch (e) { }
    process.exit(0);
});
