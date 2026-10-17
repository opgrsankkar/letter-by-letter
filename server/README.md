# Server

Express + Socket.IO backend for Letter by Letter.

Development:
```
npm install
npm run dev
```

Serve client and server together on one port (production):
```
cd client && npm install && npm run build
cd ../server && npm run build && npm start
```
Then open: http://localhost:4000

Any unmatched route (except /health and websocket paths) will serve the built SPA.

Environment:

-   `PORT` (default `4000`; `0` requests an ephemeral port)
-   `MAX_ROOMS` (default `100`) — global room cap
-   `MAX_PLAYERS_PER_ROOM` (default `8`)
-   `MIN_PLAYERS_PER_ROOM` (default `3`) — minimum to start a round
-   `MAX_ROOMS_PER_SOCKET` (default `1`) — pending room memberships per socket
-   `MAX_CONNECTIONS` (default `1000`) — concurrent socket connections
-   `RATE_LIMIT_MAX` (default `30`) — events per socket per window
-   `RATE_LIMIT_WINDOW_MS` (default `10000`)

All socket inputs (names, room codes, words) and acknowledgement callbacks are
validated at the boundary before any state mutation. Player IDs use
`crypto.randomUUID()`.

Tests (from the repo root; forks the compiled server on an ephemeral port):

```
npm test
```

Ephemeral in-memory storage only (OK for local party usage).
