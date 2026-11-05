// Production entrypoint. Node runs this TypeScript directly (type stripping).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './server.ts';

function int(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

const staticDir = process.env.STATIC_DIR ?? resolve(import.meta.dirname, '../../dist/client');
const minute = 60_000;

const server = await startServer({
  port: int('PORT', 4000, 0, 65535),
  host: process.env.HOST?.trim() || '0.0.0.0',
  staticDir: existsSync(staticDir) ? staticDir : null,
  maxRooms: int('MAX_ROOMS', 200, 1),
  maxConnections: int('MAX_CONNECTIONS', 1000, 1),
  abandonAfterMs: int('ABANDON_AFTER_MIN', 15, 1) * minute,
  awayAfterMs: int('AWAY_AFTER_MIN', 30, 1) * minute,
  sweepEveryMs: 30_000,
  heartbeatMs: 25_000,
  rateBurst: int('RATE_BURST', 20, 1),
  ratePerSecond: int('RATE_PER_SECOND', 5, 1),
  maxConnectionsPerIp: int('MAX_CONNECTIONS_PER_IP', 40, 1),
  maxRoomsPerIpPer10Min: int('MAX_ROOMS_PER_IP', 10, 1),
  trustProxy: process.env.TRUST_PROXY === '1',
});

if (typeof process.send === 'function') process.send({ type: 'listening', port: server.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close().then(() => process.exit(0));
  });
}
