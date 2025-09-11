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

## Monorepo layout

```
server/  # Express + Socket.IO backend
client/  # React frontend
```
