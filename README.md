# Walkie Talkie Web App

Production-ready monorepo scaffold for a mobile-first, low-latency walkie-talkie web app.

## Requirements
- Node.js 18+ (20+ recommended)
- npm 9+

## Local Development
1. Install dependencies from the repo root:
   - `npm install`

2. Create environment files:
   - `cp client/.env.example client/.env`
   - `cp server/.env.example server/.env`

3. Start the server (Terminal 1):
   - `npm run dev:server`

4. Start the client (Terminal 2):
   - `npm run dev:client`

Client runs at `http://localhost:5173` and server at `http://localhost:3001` by default.

## Build
- `npm run build`

## Workspace Layout
- `client/` React 18 + Vite + TypeScript + Tailwind CSS
- `server/` Node.js + Express + TypeScript + Socket.io
- `shared/` Shared TypeScript types

## Deployment (Railway)
Railway deploys the server only (client can be hosted separately).

1. Create a new Railway service pointing to this repo.
2. Set environment variables:
   - `PORT` (Railway sets this automatically)
   - `CLIENT_ORIGIN` (e.g. `https://your-client-domain.com`)
   - `RATE_LIMIT_WINDOW_MS` (optional, default `60000`)
   - `RATE_LIMIT_MAX` (optional, default `120`)
   - `NODE_ENV=production`
3. Deploy using Nixpacks (default) or the provided `Dockerfile`.

Health check: `GET /health`.
