// HTTP + WebSocket transport around the game engine.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameError, Registry, type Deps, type Room } from './game.ts';
import { loadStatic, type StaticFile } from './static.ts';
import {
  LIMITS,
  cleanCode,
  cleanName,
  type ClientMessage,
  type ServerMessage,
  GUESS_KINDS,
  type GuessKind,
} from '../shared/protocol.ts';

export interface ServerOptions {
  port: number;
  host: string;
  staticDir: string | null;
  maxRooms: number;
  maxConnections: number;
  abandonAfterMs: number;
  awayAfterMs: number;
  sweepEveryMs: number;
  heartbeatMs: number;
  /** Token bucket per socket: burst size and refill per second. */
  rateBurst: number;
  ratePerSecond: number;
  /** Per client address: open sockets, and rooms created per 10 minutes. */
  maxConnectionsPerIp: number;
  maxRoomsPerIpPer10Min: number;
  /** Take the client address from the last X-Forwarded-For hop (behind Caddy). */
  trustProxy: boolean;
  deps?: Partial<Deps>;
  log?: (msg: string) => void;
}

export interface RunningServer {
  port: number;
  registry: Registry;
  sweep: () => void;
  close: () => Promise<void>;
}

interface Session {
  room: Room;
  playerId: string;
}

const defaultDeps: Deps = {
  rand: Math.random,
  now: Date.now,
  secret: () => randomBytes(18).toString('base64url'),
};

const HOST_HEADER = /^[a-z0-9.\-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/i;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const deps: Deps = { ...defaultDeps, ...opts.deps };
  const registry = new Registry(deps, {
    maxRooms: opts.maxRooms,
    abandonAfterMs: opts.abandonAfterMs,
    awayAfterMs: opts.awayAfterMs,
  });
  const files = opts.staticDir ? await loadStatic(opts.staticDir) : new Map<string, StaticFile>();
  if (opts.staticDir) log(`serving ${files.size} client files from ${opts.staticDir}`);

  const sessions = new Map<WebSocket, Session>();
  const socketsByPlayer = new Map<string, WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();
  const addressOf = new WeakMap<WebSocket, string>();
  const connectionsByIp = new Map<string, number>();
  const createdByIp = new Map<string, number[]>();

  const clientIp = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1];
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const allowCreate = (ip: string): boolean => {
    const now = Date.now();
    const recent = (createdByIp.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= opts.maxRoomsPerIpPer10Min) {
      createdByIp.set(ip, recent);
      return false;
    }
    recent.push(now);
    createdByIp.set(ip, recent);
    return true;
  };

  // ---------------------------------------------------------------- HTTP
  const http = createServer((req, res) => {
    try {
      handleHttp(req, res, files);
    } catch (err) {
      log(`http error for ${JSON.stringify(req.url)}: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad request');
    }
  });

  // ----------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    const ip = clientIp(req);
    if (
      path !== '/ws' ||
      !sameOrigin(req) ||
      wss.clients.size >= opts.maxConnections ||
      (connectionsByIp.get(ip) ?? 0) >= opts.maxConnectionsPerIp
    ) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      addressOf.set(ws, ip);
      connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
      ws.once('close', () => {
        const left = (connectionsByIp.get(ip) ?? 1) - 1;
        if (left <= 0) connectionsByIp.delete(ip);
        else connectionsByIp.set(ip, left);
      });
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    alive.set(ws, true);
    let tokens = opts.rateBurst;
    let lastRefill = Date.now();
    let strikes = 0;

    ws.on('pong', () => alive.set(ws, true));
    // Oversized frames and protocol violations surface here; ws closes the
    // socket itself, we only need to keep the error from crashing the process.
    ws.on('error', () => {});

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(opts.rateBurst, tokens + ((now - lastRefill) / 1000) * opts.ratePerSecond);
      lastRefill = now;
      if (tokens < 1) {
        strikes += 1;
        if (strikes > 50) ws.terminate();
        else send(ws, { type: 'error', code: 'rate_limited', message: 'Slow down a little.' });
        return;
      }
      tokens -= 1;

      let msg: ClientMessage | null = null;
      if (!isBinary) {
        try {
          msg = parseMessage(JSON.parse(data.toString()));
        } catch {
          msg = null;
        }
      }
      if (!msg) {
        send(ws, { type: 'error', code: 'bad_request', message: 'Malformed message.' });
        return;
      }
      try {
        handleMessage(ws, msg);
      } catch (err) {
        if (err instanceof GameError) {
          send(ws, { type: 'error', code: err.code, message: err.message });
        } else {
          log(`unexpected error handling ${msg.type}: ${(err as Error).stack ?? String(err)}`);
          send(ws, { type: 'error', code: 'bad_request', message: 'Something went wrong.' });
        }
      }
    });

    ws.on('close', () => {
      const session = sessions.get(ws);
      sessions.delete(ws);
      if (!session) return;
      if (socketsByPlayer.get(session.playerId) === ws) {
        socketsByPlayer.delete(session.playerId);
        session.room.setConnected(session.playerId, false);
        broadcast(session.room);
      }
    });
  });

  function attach(ws: WebSocket, room: Room, playerId: string, token: string): void {
    const previous = socketsByPlayer.get(playerId);
    if (previous && previous !== ws) {
      // Same seat opened elsewhere (another tab): the newest connection wins.
      sessions.delete(previous);
      previous.close(4001, 'replaced');
    }
    sessions.set(ws, { room, playerId });
    socketsByPlayer.set(playerId, ws);
    room.setConnected(playerId, true);
    send(ws, { type: 'joined', code: room.code, token, playerId });
    broadcast(room);
  }

  function handleMessage(ws: WebSocket, msg: ClientMessage): void {
    const session = sessions.get(ws);
    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' });
        return;
      case 'create':
      case 'join':
      case 'resume': {
        if (session) throw new GameError('already_in_room', 'Leave your current room first.');
        if (msg.type === 'resume') {
          const code = cleanCode(msg.code);
          if (!code) throw new GameError('not_found', 'That game has ended.');
          const { room, player } = registry.resume(code, msg.token);
          attach(ws, room, player.id, player.token);
          return;
        }
        const name = cleanName(msg.name);
        if (!name) throw new GameError('bad_name', `Names are 1-${LIMITS.nameMax} characters.`);
        if (msg.type === 'create') {
          if (!allowCreate(addressOf.get(ws) ?? 'unknown')) {
            throw new GameError('rate_limited', 'Too many new rooms from here. Join an existing one or try later.');
          }
          const { room, player } = registry.create(name);
          log(`room ${room.code} created`);
          attach(ws, room, player.id, player.token);
        } else {
          const code = cleanCode(msg.code);
          if (!code) throw new GameError('not_found', 'Room codes are four letters.');
          const { room, player } = registry.join(code, name);
          attach(ws, room, player.id, player.token);
        }
        return;
      }
    }

    if (!session) throw new GameError('not_in_room', 'Join a room first.');
    const { room, playerId } = session;
    switch (msg.type) {
      case 'leave':
        sessions.delete(ws);
        socketsByPlayer.delete(playerId);
        room.removePlayer(playerId);
        if (room.isEmpty()) {
          registry.rooms.delete(room.code);
          log(`room ${room.code} closed`);
        }
        send(ws, { type: 'left' });
        break;
      case 'switch-team':
        room.switchTeam(playerId);
        break;
      case 'shuffle-teams':
        room.shuffleTeams(playerId);
        break;
      case 'set-timer':
        room.setTimer(playerId, msg.seconds);
        break;
      case 'start':
        room.start(playerId);
        break;
      case 'deal':
        room.deal(playerId, msg.word);
        break;
      case 'pass':
        room.pass(playerId);
        break;
      case 'award':
        room.award(playerId, msg.playerId, msg.kind);
        break;
      case 'next':
        room.next(playerId);
        break;
      case 'hinted':
        room.markHinted(playerId, msg.done);
        break;
      case 'unlock':
        room.unlock(playerId);
        break;
      case 'end':
        room.end(playerId);
        break;
      default: {
        const unhandled: never = msg;
        throw new GameError('bad_request', `Unknown message ${(unhandled as { type: string }).type}`);
      }
    }
    broadcast(room);
  }

  function broadcast(room: Room): void {
    for (const p of room.players) {
      const ws = socketsByPlayer.get(p.id);
      if (ws) send(ws, { type: 'view', view: room.viewFor(p.id), now: deps.now() });
    }
  }

  // ---------------------------------------------------- housekeeping
  const sweep = () => {
    for (const room of registry.sweep()) broadcast(room);
    const now = Date.now();
    for (const [ip, times] of createdByIp) {
      if (times.every((t) => now - t >= 10 * 60_000)) createdByIp.delete(ip);
    }
  };
  const sweepTimer = setInterval(sweep, opts.sweepEveryMs);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs);
  sweepTimer.unref();
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  log(`letter-by-letter listening on http://${opts.host}:${port}`);

  return {
    port,
    registry,
    sweep,
    close: async () => {
      clearInterval(sweepTimer);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Browsers always send Origin on WebSocket upgrades; it must match the Host. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) return true; // non-browser clients (tests, curl) have no ambient credentials anyway
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function parseMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const str = (k: string) => typeof m[k] === 'string' && (m[k] as string).length <= 128;
  switch (m.type) {
    case 'create':
      return str('name') ? { type: 'create', name: m.name as string } : null;
    case 'join':
      return str('name') && str('code')
        ? { type: 'join', name: m.name as string, code: m.code as string }
        : null;
    case 'resume':
      return str('code') && str('token')
        ? { type: 'resume', code: m.code as string, token: m.token as string }
        : null;
    case 'deal':
      return str('word') ? { type: 'deal', word: m.word as string } : null;
    case 'set-timer':
      return typeof m.seconds === 'number' ? { type: 'set-timer', seconds: m.seconds } : null;
    case 'hinted':
      return typeof m.done === 'boolean' ? { type: 'hinted', done: m.done } : null;
    case 'award': {
      if (!(m.playerId === null || str('playerId'))) return null;
      if (m.kind !== undefined && !GUESS_KINDS.includes(m.kind as GuessKind)) return null;
      return m.kind
        ? { type: 'award', playerId: m.playerId as string | null, kind: m.kind as GuessKind }
        : { type: 'award', playerId: m.playerId as string | null };
    }
    case 'leave':
    case 'ping':
    case 'switch-team':
    case 'shuffle-teams':
    case 'start':
    case 'pass':
    case 'next':
    case 'unlock':
    case 'end':
      return { type: m.type };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ static

function handleHttp(req: IncomingMessage, res: ServerResponse, files: Map<string, StaticFile>): void {
  // Deliberately not `new URL()`: it throws on paths such as `//`.
  const path = (req.url ?? '/').split('?')[0].split('#')[0];

  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"status":"ok"}');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }

  // Exact asset match, otherwise any extension-less path is a client route.
  let file = files.get(path);
  if (!file && !/\.[a-z0-9]+$/i.test(path)) file = files.get('/index.html');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const hostHeader = req.headers.host && HOST_HEADER.test(req.headers.host) ? req.headers.host : null;
  const sockets = hostHeader ? ` wss://${hostHeader} ws://${hostHeader}` : '';
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': file.body.length,
    'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy':
      `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; ` +
      `connect-src 'self'${sockets}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
  res.end(req.method === 'HEAD' ? undefined : file.body);
}
