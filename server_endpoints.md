# Server endpoints

This file lists the HTTP endpoints exposed by the server in the `server/` folder (as scanned in `routes.ts`, `replitAuth.ts`, and `launchpadRoutes.ts`). It includes the HTTP verb, path, a short description and whether the endpoint requires authentication.

---

## Auth

- GET /api/login — (dev only) create a mock dev session and redirect to `/` (enabled only in development)
- GET /api/logout — log out current session and redirect to `/`
- POST /api/auth/wallet-connect — create/update a user session when a wallet is connected (body: { publicKey, walletType })
- GET /api/auth/user — returns current user/session info or `null` if not authenticated

## Wallets / Signing (requires authentication where noted)

- GET /api/wallet/balance — (auth) fetch and update the connected user's wallet balance from the blockchain
- GET /api/wallet/export-key — (auth) export (decrypt) private key for the user's wallet (sensitive)
- POST /api/wallet/create — (auth) create a new custodial wallet for the authenticated user
- POST /api/wallet/withdraw — (auth) withdraw SOL from custodial wallet (body: { recipientAddress, amount })
- GET /api/wallets — (auth) list all wallets for authenticated user
- POST /api/wallets — (auth) create an additional wallet (body: { name })
- PATCH /api/wallets/:walletId — (auth) update wallet metadata (rename/archive)
- GET /api/wallets/:walletId/balance — (auth) refresh a specific wallet balance from chain
- GET /api/wallets/:walletId/export-key — (auth) export private key for specific wallet
- POST /api/wallet/sign-transaction — (auth) sign a serialized transaction server-side (body: { transaction, publicKey })
- GET /api/wallet/balance/:publicKey — (auth) get balance for arbitrary public key (permission guarded)
- POST /api/wallet/transfer — (auth) transfer SOL between wallets (body: { fromPublicKey, toPublicKey, amount })

## Jupiter / Token discovery & proxy

- GET /api/jupiter/recent — return cached recent Jupiter tokens snapshot
- GET /api/jupiter/recent/stream — SSE stream of recent Jupiter tokens (text/event-stream)
- GET /api/jupiter/search?q=... — search tokens via Jupiter service
- GET /api/jupiter/ultra/order?... — proxy GET order request to Jupiter Ultra API
- POST /api/jupiter/ultra/execute — proxy POST execute request to Jupiter Ultra API
- GET /api/jupiter/top-trending — cached top-trending tokens snapshot
- GET /api/jupiter/top-trending/stream — SSE stream for top-trending tokens

## GMGN (token discovery / trades / holders)

- GET /api/gmgn/tokens — return snapshot: { new, nearCompletion, completed, lastNewUpdate, lastStatusUpdate, counts }
- GET /api/gmgn/tokens/stream — SSE stream (text/event-stream) for GMGN events
- POST /api/gmgn/polling/start — start server-side GMGN polling
- POST /api/gmgn/polling/stop — stop GMGN polling
- GET /api/gmgn/polling/status — return GMGN polling status
- POST /api/gmgn/cache/clear — clear GMGN caches
- GET /api/gmgn/search?q=... — search GMGN (proxy to gmgnService.search)
- GET /api/gmgn/test — run gmgnService.testFetch and return raw result (debug)
- GET /api/gmgn/lookup?q={query}&chain={sol|...} — GMGN v3 lookup (used by UI to lookup token-by-mint)
- GET /api/gmgn/trades/:mint — fetch token trades for given mint from GMGN
- GET /api/gmgn/holders/:mint — fetch token holders for given mint from GMGN

Note: SSE payloads observed in the code include event types: `initial_state` (snapshot), `new_tokens`, `token_updates`, `near_completion_snapshot`, `completed_snapshot`.

## Utilities

- GET /api/proxy-image?url={remoteUrl} — proxy a remote image (follows redirects, sets Content-Type and CORS header `Access-Control-Allow-Origin: *`) — useful to fix remote GIF/CORS issues

## Prices

- GET /api/prices — return cached/all prices (BTC/ETH/SOL etc)
- GET /api/prices/:symbol — get price for a specific symbol
- POST /api/prices/batch — get prices for a list of symbols (body: { symbols: [...] })
- POST /api/prices/refresh — force refresh of prices (admin)
- GET /api/prices/status — return price service status

## Launchpad (mounted at `/api/launchpad`)
The root router is mounted at `/api/launchpad` via `app.use('/api/launchpad', launchpadRoutes)`.

- POST /api/launchpad/metadata — host token image & metadata on Arweave (via Bundlr). Accepts: name, symbol, imageUrl or imageDataUrl, description, attributes, etc.
- POST /api/launchpad/create — prepare parameters for client-side Raydium SDK launchpad creation (returns generated mint keypair + params)
- GET /api/launchpad/config — return platform configuration (platform IDs, network, thresholds)
- POST /api/launchpad/validate — validate launch parameters before submission

## Static / catch-all (vite / static middleware)

- GET / (when in API-only mode) — returns a small JSON status object when Vite/static serving isn't enabled (registered conditionally)
- Vite dev middleware and static file serving are registered in `server/vite.ts`; there are `app.use('*', ...)` handlers used for dev-time client rendering and static fallbacks.

---

If you want, I can extend this file with example request/response bodies for key endpoints (e.g. `/api/gmgn/lookup`, `/api/gmgn/trades/:mint`, `/api/proxy-image`) or generate a Postman/OpenAPI spec from these routes. Tell me which you'd prefer next.
