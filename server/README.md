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

-   `PORT` (default 4000)

Ephemeral in-memory storage only (OK for local party usage).
