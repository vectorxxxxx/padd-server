# SLAB Server (standalone)

This folder contains a self-sufficient copy of the SLAB server that can be copied and run independently of the full repository.

Quick start:

1. Copy the `server/` folder to a new location.
2. Install dependencies:

```powershell
npm install
```

3. Copy the example env and edit if needed:

```powershell
cp .env.example .env
```

4. Start in development (uses `tsx` to run TypeScript directly):

```powershell
npm run dev
```

Notes:
- The server uses in-memory storage and in-process session storage, so no external database is required.
- If the client folder (frontend) is not present next to the server, the server will still start and serve a minimal placeholder in development mode.
- Environment variables include `SESSION_SECRET` and `WALLET_ENCRYPTION_KEY` (both have dev fallbacks but should be set in production).
