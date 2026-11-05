// Integration tests: a real HTTP + WebSocket server on an ephemeral loopback port.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, type RunningServer, type ServerOptions } from '../src/server/server.ts';
import type { ClientMessage, ServerMessage, View } from '../src/shared/protocol.ts';

let staticDir: string;

before(async () => {
  staticDir = await mkdtemp(join(tmpdir(), 'lbl-static-'));
  await mkdir(join(staticDir, 'assets'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>LBL</title>');
  await writeFile(join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  await writeFile(join(staticDir, 'favicon.svg'), '<svg/>');
});
after(() => rm(staticDir, { recursive: true, force: true }));

async function boot(overrides: Partial<ServerOptions> = {}): Promise<RunningServer & { url: string; ws: string }> {
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    staticDir,
    maxRooms: 50,
    maxConnections: 50,
    abandonAfterMs: 60_000,
    awayAfterMs: 60_000,
    sweepEveryMs: 60_000,
    heartbeatMs: 60_000,
    rateBurst: 50,
    ratePerSecond: 50,
    log: () => {},
    ...overrides,
  });
  return { ...server, url: `http://127.0.0.1:${server.port}`, ws: `ws://127.0.0.1:${server.port}/ws` };
}

class Client {
  readonly socket: WebSocket;
  readonly inbox: ServerMessage[] = [];
  readonly raw: string[] = [];
  private waiters: Array<() => void> = [];
  closed: { code: number } | null = null;
  view: View | null = null;
  token = '';
  code = '';
  id = '';

  constructor(url: string, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      const msg = JSON.parse(text) as ServerMessage;
      this.inbox.push(msg);
      if (msg.type === 'view') this.view = msg.view;
      if (msg.type === 'joined') Object.assign(this, { token: msg.token, code: msg.code, id: msg.playerId });
      this.waiters.splice(0).forEach((w) => w());
    });
    this.socket.on('error', () => {}); // surfaced through `closed`
    this.socket.on('close', (code) => {
      this.closed = { code };
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  static async open(url: string, headers?: Record<string, string>): Promise<Client> {
    const c = new Client(url, headers);
    await new Promise<void>((resolve, reject) => {
      c.socket.once('open', () => resolve());
      c.socket.once('error', reject);
    });
    return c;
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Wait for (and consume) the first message matching `pred`. */
  async next<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, ms?: number): Promise<T>;
  async next(pred: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  async next(pred: (m: ServerMessage) => boolean, ms = 2000): Promise<ServerMessage> {
    const deadline = Date.now() + ms;
    for (;;) {
      const idx = this.inbox.findIndex(pred);
      if (idx >= 0) return this.inbox.splice(idx, 1)[0];
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) while waiting`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; inbox: ${JSON.stringify(this.inbox)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  error(code?: string) {
    return this.next((m) => m.type === 'error' && (!code || m.code === code)) as Promise<
      Extract<ServerMessage, { type: 'error' }>
    >;
  }

  async viewWhere(pred: (v: View) => boolean): Promise<View> {
    const msg = await this.next((m) => m.type === 'view' && pred(m.view));
    return (msg as Extract<ServerMessage, { type: 'view' }>).view;
  }

  async waitClosed(ms = 2000): Promise<number> {
    const deadline = Date.now() + ms;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('socket did not close');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closed.code;
  }

  close() {
    this.socket.terminate();
  }
}

async function table(server: { ws: string }, names: string[]) {
  const clients: Client[] = [];
  const first = await Client.open(server.ws);
  first.send({ type: 'create', name: names[0] });
  await first.next((m) => m.type === 'joined');
  clients.push(first);
  for (const name of names.slice(1)) {
    const c = await Client.open(server.ws);
    c.send({ type: 'join', code: first.code.toLowerCase(), name });
    await c.next((m) => m.type === 'joined');
    clients.push(c);
  }
  await Promise.all(clients.map((c) => c.viewWhere((v) => v.players.length === names.length)));
  return clients;
}

// ---------------------------------------------------------------------------

test('HTTP: health, static files, client routes and headers', async () => {
  const s = await boot();
  try {
    const health = await fetch(`${s.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const index = await fetch(`${s.url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type')!, /text\/html/);
    assert.equal(index.headers.get('cache-control'), 'no-cache');
    const csp = index.headers.get('content-security-policy')!;
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, new RegExp(`connect-src 'self' wss://127\\.0\\.0\\.1:${s.port}`));
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');

    const route = await fetch(`${s.url}/r/ACDE`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /<title>LBL<\/title>/);

    const asset = await fetch(`${s.url}/assets/app-abc123.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control')!, /immutable/);
    assert.match(asset.headers.get('content-type')!, /javascript/);

    assert.equal((await fetch(`${s.url}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${s.url}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${s.url}/`, { method: 'POST' })).status, 405);
  } finally {
    await s.close();
  }
});

test('WebSocket upgrades: path, origin and connection cap are enforced', async () => {
  const s = await boot({ maxConnections: 2 });
  try {
    await assert.rejects(Client.open(`ws://127.0.0.1:${s.port}/elsewhere`));
    await assert.rejects(Client.open(s.ws, { Origin: 'https://evil.example' }));
    const ok = await Client.open(s.ws, { Origin: `http://127.0.0.1:${s.port}` });
    const ok2 = await Client.open(s.ws);
    await assert.rejects(Client.open(s.ws));
    ok.close();
    ok2.close();
  } finally {
    await s.close();
  }
});

test('a full round over the wire keeps the word private until the reveal', async () => {
  const s = await boot();
  const clients = await table(s, ['Asha', 'Ben', 'Chen', 'Dev']);
  try {
    const [asha] = clients;
    asha.send({ type: 'set-timer', seconds: 60 });
    await asha.viewWhere((v) => v.timerSeconds === 60);
    asha.send({ type: 'start' });
    const views = await Promise.all(clients.map((c) => c.viewWhere((v) => v.phase === 'choosing')));
    const hostId = views[0].hostId!;
    const host = clients.find((c) => c.id === hostId)!;
    const holders = clients.filter((c) => c !== host);

    holders[0].send({ type: 'deal', word: 'BANANA' });
    assert.equal((await holders[0].error('not_allowed')).code, 'not_allowed');

    const rawMark = holders.map((c) => c.raw.length);
    host.send({ type: 'deal', word: 'lobster' });
    const hostView = await host.viewWhere((v) => v.phase === 'playing');
    assert.equal(hostView.word, 'LOBSTER');
    assert.ok(hostView.deadline! > Date.now());

    const dealt: string[] = [];
    for (const h of holders) {
      const v = await h.viewWhere((v) => v.phase === 'playing');
      assert.equal(v.word, null);
      assert.equal(v.holdings, null);
      dealt.push(...v.letters!);
    }
    assert.deepEqual(dealt.sort(), 'LOBSTER'.split('').sort());
    holders.forEach((h, i) => {
      const seen = h.raw.slice(rawMark[i]).join('');
      assert.ok(!seen.includes('LOBSTER'), 'holders never receive the word while playing');
    });

    host.send({ type: 'award', playerId: holders[1].id });
    const reveals = await Promise.all(clients.map((c) => c.viewWhere((v) => v.phase === 'reveal')));
    for (const r of reveals) {
      assert.equal(r.last!.word, 'LOBSTER');
      assert.equal(r.last!.guesserId, holders[1].id);
      assert.equal(r.players.find((p) => p.id === holders[1].id)!.score, 1);
    }

    holders[2].send({ type: 'next' });
    const nextRound = await asha.viewWhere((v) => v.phase === 'choosing');
    assert.equal(nextRound.round, 2);
    assert.notEqual(nextRound.hostId, hostId);
  } finally {
    clients.forEach((c) => c.close());
    await s.close();
  }
});

test('a dropped player resumes their seat, letters and score', async () => {
  const s = await boot();
  const clients = await table(s, ['Ann', 'Bo', 'Cy']);
  try {
    clients[0].send({ type: 'start' });
    const v = await clients[0].viewWhere((v) => v.phase === 'choosing');
    const host = clients.find((c) => c.id === v.hostId)!;
    host.send({ type: 'deal', word: 'GUITAR' });
    const holder = clients.find((c) => c !== host)!;
    const before = await holder.viewWhere((v) => v.phase === 'playing');

    holder.close();
    const away = await host.viewWhere((v) => v.players.some((p) => p.id === holder.id && !p.connected));
    assert.equal(away.phase, 'playing');

    const back = await Client.open(s.ws);
    back.send({ type: 'resume', code: holder.code, token: holder.token });
    const joined = await back.next((m) => m.type === 'joined');
    assert.equal((joined as Extract<ServerMessage, { type: 'joined' }>).playerId, holder.id);
    const after = await back.viewWhere((v) => v.phase === 'playing');
    assert.deepEqual(after.letters, before.letters);
    await host.viewWhere((v) => v.players.every((p) => p.connected));

    // Opening the same seat a second time retires the older socket.
    const twin = await Client.open(s.ws);
    twin.send({ type: 'resume', code: holder.code, token: holder.token });
    await twin.next((m) => m.type === 'joined');
    assert.equal(await back.waitClosed(), 4001);

    const bad = await Client.open(s.ws);
    bad.send({ type: 'resume', code: holder.code, token: 'not-a-token' });
    assert.equal((await bad.error()).code, 'not_found');
    twin.close();
    bad.close();
  } finally {
    clients.forEach((c) => c.close());
    await s.close();
  }
});

test('bad input is rejected without disturbing the room', async () => {
  const s = await boot();
  try {
    const c = await Client.open(s.ws);
    c.socket.send('not json');
    assert.equal((await c.error()).code, 'bad_request');
    c.send({ type: 'explode' });
    assert.equal((await c.error()).code, 'bad_request');
    c.send({ type: 'create', name: { $gt: '' } });
    assert.equal((await c.error()).code, 'bad_request');
    c.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal((await c.error()).code, 'bad_request');
    c.send({ type: 'create', name: '   ' });
    assert.equal((await c.error()).code, 'bad_name');
    c.send({ type: 'start' });
    assert.equal((await c.error()).code, 'not_in_room');
    c.send({ type: 'join', code: 'ZZZZ', name: 'Al' });
    assert.equal((await c.error()).code, 'not_found');
    c.send({ type: 'create', name: 'Al' });
    await c.next((m) => m.type === 'joined');
    c.send({ type: 'create', name: 'Al' });
    assert.equal((await c.error()).code, 'already_in_room');
    c.send({ type: 'start' });
    assert.equal((await c.error()).code, 'too_few_players');
    c.send({ type: 'set-timer', seconds: 7 });
    assert.equal((await c.error()).code, 'bad_request');

    c.socket.send(JSON.stringify({ type: 'create', name: 'x'.repeat(10_000) }));
    assert.equal(await c.waitClosed(), 1009);
  } finally {
    await s.close();
  }
});

test('flooding a socket is rate limited', async () => {
  const s = await boot({ rateBurst: 5, ratePerSecond: 1 });
  try {
    const c = await Client.open(s.ws);
    for (let i = 0; i < 12; i += 1) c.send({ type: 'start' });
    assert.equal((await c.error('rate_limited')).code, 'rate_limited');
    c.close();
  } finally {
    await s.close();
  }
});

test('leaving removes the player; the last one out closes the room', async () => {
  const s = await boot();
  const clients = await table(s, ['Ann', 'Bo']);
  try {
    const code = clients[0].code;
    clients[1].send({ type: 'leave' });
    await clients[1].next((m) => m.type === 'left');
    await clients[0].viewWhere((v) => v.players.length === 1);
    clients[0].send({ type: 'leave' });
    await clients[0].next((m) => m.type === 'left');
    assert.ok(!s.registry.rooms.has(code));
  } finally {
    clients.forEach((c) => c.close());
    await s.close();
  }
});

test('sweeping drops long-gone players and tells the table', async () => {
  let now = 1_000;
  const s = await boot({ awayAfterMs: 5_000, abandonAfterMs: 10_000, deps: { now: () => now } });
  const clients = await table(s, ['Ann', 'Bo', 'Cy']);
  try {
    clients[2].close();
    await clients[0].viewWhere((v) => v.players.some((p) => !p.connected));
    now += 6_000;
    s.sweep();
    await clients[0].viewWhere((v) => v.players.length === 2);
  } finally {
    clients.forEach((c) => c.close());
    await s.close();
  }
});
