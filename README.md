# Letter by Letter

Multiplayer facilitator web app per PRD.

## Stack

-   Server: Node.js + Express + Socket.IO
-   Client: React + Vite + TypeScript + TailwindCSS

## Quick Start

Install dependencies (from repo root run both):

Server (port 4000 default) and client (port 5173 default) run separately.

From two terminals:

```
cd server && npm install && npm run dev
```

```
cd client && npm install && npm run dev
```

### Server

1. `cd server`
2. Install: `npm install`
3. Dev: `npm run dev`

### Client

1. `cd client`
2. Install: `npm install`
3. Dev: `npm run dev`

Open the client in the browser and point it to the server URL if different (set `VITE_SERVER_URL`).

### Gameplay Flow

1. Player A creates room, shares code.
2. Others join.
3. Start round -> random host.
4. Host enters word -> letters distributed.
5. Verbal play; start another round when ready.

## Single-Port (Server + Client) Production Build
1. Build client:
```
cd client && npm install && npm run build
```
2. Build server:
```
cd ../server && npm install && npm run build
```
3. Start server (serves API + static client on same port):
```
npm start
```
Open http://localhost:4000 (or your LAN IP). The server will serve `client/dist` automatically if present.

### Root Convenience Scripts
From repo root (`package.json` added):
```
npm run build:all   # installs & builds client then server
npm run start:prod  # runs server/dist (after build)
npm run dev         # runs server dev + client dev concurrently
```

You do NOT need an extra copy step: the server looks for `client/dist` directly. Only add an automatic copy if you ever restructure the folders or want to decouple artifacts. For now this is simpler and fine.

## Deploying to Vercel (Single Server + Static Client)
Because Vercel treats Node serverless functions differently than persistent WebSocket servers, to use Socket.IO you must deploy as a single Node server (e.g. via the Vercel Node runtime with `"output": "standalone"` or a build output). Simplest path:

1. Ensure root scripts (already present) build and copy the client into `server/dist/static`.
2. Set Vercel Build Command:
```
npm run build:all
```
3. Set Vercel Output / Start Command:
```
npm run start:prod
```
4. Specify Node version (optional) in a `engines` field or `.nvmrc`.

The server at runtime serves static assets from `dist/static` automatically (fallback path added). WebSocket endpoint stays under the same origin.

NOTE: Vercel serverless functions are not ideal for long-lived WebSocket connections; if you need scalability, consider a small VPS / Fly.io / Render deployment or enable Vercel Edge + a separate WebSocket provider (e.g. Ably / Pusher). For casual in-room play, a single Node process is sufficient.

## Monorepo layout

```
server/  # Express + Socket.IO backend
client/  # React frontend
```
