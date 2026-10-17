#!/usr/bin/env node
// Isolated integration suite for the Letter by Letter server.
//
// Every test forks the *compiled* server (server/dist/index.js) as a child
// process on PORT=0 (an ephemeral loopback port) with its own environment.
// Nothing here ever talks to a production server, and coordinates/limits are
// injected per test so the assertions are deterministic.
//
// Run with: npm test            (root: installs client deps, builds, runs)
//           npm run test:integration   (assumes server/dist is already built)

import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'dist', 'index.js');

// socket.io-client is declared by the client workspace; resolve it from there
// so the suite works whether or not the repo root has its own node_modules.
const requireFromClient = createRequire(path.join(__dirname, '..', 'client', 'package.json'));
const { io } = requireFromClient('socket.io-client');

const CONNECT_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 5_000;
const EVENT_TIMEOUT_MS = 5_000;
// Bound every test so a stuck child process can never hang the whole run.
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 30_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startServer(envOverrides) {
    const child = fork(SERVER_ENTRY, [], {
        // Bind the test server to loopback only: malformed-input tests must
        // never expose a listener on a public interface.
        env: { ...process.env, NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', ...envOverrides },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    const logs = [];
    child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
    child.stderr?.on('data', (chunk) => logs.push(String(chunk)));

    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`server did not report a listening port.\n${logs.join('')}`));
            }, CONNECT_TIMEOUT_MS);

            function cleanup() {
                clearTimeout(timer);
                child.off('error', onError);
                child.off('message', onMessage);
                child.off('exit', onExit);
            }
            function onError(err) {
                cleanup();
                reject(err);
            }
            function onMessage(message) {
                if (message && message.type === 'listening' && Number.isInteger(message.port)) {
                    cleanup();
                    resolve(message.port);
                }
            }
            function onExit(code, signal) {
                cleanup();
                reject(new Error(`server exited early (code=${code}, signal=${signal}).\n${logs.join('')}`));
            }

            child.on('error', onError);
            child.on('message', onMessage);
            child.on('exit', onExit);
        });

        return { child, port, logs };
    } catch (err) {
        // Never leak a half-started subprocess on startup failure/timeout.
        await stopServer(child);
        throw err;
    }
}

function stopServer(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
        child.once('exit', () => {
            clearTimeout(killTimer);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

/**
 * Fork a server, run `fn(ctx)`, then reliably disconnect every client and kill
 * the server even when the body throws.
 */
async function withServer(envOverrides, fn) {
    const server = await startServer(envOverrides);
    const sockets = new Set();

    const connect = (options = {}) =>
        new Promise((resolve, reject) => {
            const socket = io(`http://127.0.0.1:${server.port}`, {
                transports: ['websocket'],
                upgrade: false,
                forceNew: true,
                reconnection: false,
                timeout: CONNECT_TIMEOUT_MS,
                ...options,
            });
            sockets.add(socket);

            const timer = setTimeout(() => reject(new Error('connect timed out')), CONNECT_TIMEOUT_MS);
            socket.once('connect', () => {
                clearTimeout(timer);
                resolve(socket);
            });
            socket.once('connect_error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

    try {
        await fn({ server, port: server.port, logs: server.logs, connect });
    } finally {
        for (const socket of sockets) {
            try {
                socket.removeAllListeners();
                socket.disconnect();
            } catch {
                /* already gone */
            }
        }
        await stopServer(server.child);
    }
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

function emitAck(socket, event, ...args) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ack timed out for "${event}"`)), ACK_TIMEOUT_MS);
        socket.emit(event, ...args, (response) => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

function waitFor(socket, event, { predicate = () => true, timeout = EVENT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, handler);
            reject(new Error(`timed out waiting for "${event}"`));
        }, timeout);

        function handler(...args) {
            let matches = false;
            try {
                matches = predicate(...args);
            } catch {
                matches = false;
            }
            if (!matches) return;
            clearTimeout(timer);
            socket.off(event, handler);
            resolve(args.length <= 1 ? args[0] : args);
        }

        socket.on(event, handler);
    });
}

/** Create a room with a brand-new socket. Returns { socket, roomId, playerId }. */
async function createRoom(ctx, name = 'Creator') {
    const socket = await ctx.connect();
    const response = await emitAck(socket, 'create_room', name);
    assert.ok(response?.roomId, `create_room should return a roomId, got ${JSON.stringify(response)}`);
    assert.ok(response?.playerId, `create_room should return a playerId, got ${JSON.stringify(response)}`);
    return { socket, roomId: response.roomId, playerId: response.playerId };
}

async function joinRoom(ctx, roomId, name) {
    const socket = await ctx.connect();
    const response = await emitAck(socket, 'join_room', roomId, name);
    return { socket, response };
}

/** Set up a 3-player room and start a round; resolves with host ownership. */
async function startThreePlayerRound(ctx) {
    const creator = await createRoom(ctx, 'P1');
    const guests = [];
    for (const name of ['P2', 'P3']) {
        const guest = await joinRoom(ctx, creator.roomId, name);
        assert.equal(guest.response.ok, true, `join ${name} should succeed`);
        guests.push({ socket: guest.socket, playerId: guest.response.playerId });
    }

    const hostSelected = waitFor(creator.socket, 'host_selected');
    const roundStarted = waitFor(creator.socket, 'new_round_started');
    const inRound = waitFor(creator.socket, 'room_update', {
        predicate: (room) => room?.state === 'in-round' && Boolean(room?.hostId),
    });
    creator.socket.emit('start_round');

    const hostId = await hostSelected;
    const round = await roundStarted;
    const view = await inRound;

    const byId = new Map([[creator.playerId, creator.socket]]);
    for (const guest of guests) byId.set(guest.playerId, guest.socket);
    assert.equal(byId.size, 3, 'three distinct player ids expected');

    const hostSocket = byId.get(hostId);
    assert.ok(hostSocket, 'selected host must be one of the connected sockets');
    const nonHosts = [...byId.entries()].filter(([id]) => id !== hostId);

    return { roomId: creator.roomId, round, view, hostId, hostSocket, nonHosts, byId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('valid 3-player round: letters distributed, host gets word, point advances round', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({}, async (ctx) => {
        const { round, view, hostId, hostSocket, nonHosts, byId } = await startThreePlayerRound(ctx);

        assert.equal(round, 1);
        assert.equal(view.players.length, 3);
        assert.equal(view.hostId, hostId);
        assert.equal(view.round, 1);

        // Host must be the only recipient of host_word.
        const hostReceivedLetters = [];
        hostSocket.on('assigned_letters', (letters) => hostReceivedLetters.push(letters));

        const lettersPromises = nonHosts.map(([, socket]) => waitFor(socket, 'assigned_letters'));
        const hostWordPromise = waitFor(hostSocket, 'host_word');
        hostSocket.emit('submit_word', 'ORANGE');

        const [hostWord, ...lettersArrays] = await Promise.all([hostWordPromise, ...lettersPromises]);
        assert.equal(hostWord, 'ORANGE');

        const collected = lettersArrays.flat();
        assert.equal(collected.length, 'ORANGE'.length, 'every letter must be handed out exactly once');
        assert.deepEqual(
            [...collected].sort(),
            [...'ORANGE'].sort(),
            'the union of assigned letters must spell the submitted word',
        );
        assert.deepEqual(hostReceivedLetters, [], 'host must not receive assigned_letters');

        // Non-host submit_word is rejected.
        const nonHostSocket = nonHosts[0][1];
        const notHostError = waitFor(nonHostSocket, 'error_message');
        nonHostSocket.emit('submit_word', 'BANANA');
        assert.match(await notHostError, /host/i);

        // A non-host claiming a point increments their score and starts a new round.
        const [nonHostId] = nonHosts[0];
        const observer = [...byId.values()][0];
        const scoreUpdate = waitFor(observer, 'room_update', {
            predicate: (room) => (room?.players ?? []).some((p) => p.id === nonHostId && p.score === 1),
        });
        const nextRound = waitFor(nonHostSocket, 'new_round_started');
        nonHostSocket.emit('add_point');

        assert.equal(await nextRound, 2, 'add_point should advance the round');
        assert.ok(await scoreUpdate, 'add_point should increment the player score');
    });
});

test('missing and malformed ACKs never crash the server', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({}, async (ctx) => {
        const socket = await ctx.connect();

        // No acknowledgement callback at all.
        socket.emit('create_room', 'NoAck');
        socket.emit('join_room', 'ZZZZ', 'NoAck');

        // Last argument is not a function, so it is treated as a bad argument.
        socket.emit('create_room', 'BadAck', 'definitely-not-a-function');
        socket.emit('join_room', 'ABCD', 'BadAck', 12_345);

        await sleep(200);

        // The socket is still usable and the server is still alive.
        const created = await emitAck(socket, 'create_room', 'StillWorks');
        assert.ok(created?.roomId, 'server must keep serving valid requests after malformed input');
    });
});

test('invalid and oversized names are rejected without creating a room', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({}, async (ctx) => {
        const socket = await ctx.connect();

        const blank = await emitAck(socket, 'create_room', '   ');
        assert.equal(blank?.ok, false);
        assert.equal(blank?.error, 'invalid_name');

        const nonString = await emitAck(socket, 'create_room', { name: 'x' });
        assert.equal(nonString?.ok, false);

        const oversized = await emitAck(socket, 'create_room', 'x'.repeat(41));
        assert.equal(oversized?.ok, false);
        assert.equal(oversized?.error, 'invalid_name');

        // Exactly at the boundary is accepted (trimmed to 40 chars).
        const boundary = await emitAck(socket, 'create_room', `  ${'y'.repeat(40)}  `);
        assert.ok(boundary?.roomId, '40-character name should be accepted');

        // Oversized/invalid names are also rejected on join.
        const guest = await ctx.connect();
        const joinOver = await emitAck(guest, 'join_room', boundary.roomId, 'x'.repeat(41));
        assert.equal(joinOver?.ok, false);
        assert.equal(joinOver?.error, 'invalid_input');
    });
});

test('invalid room codes are rejected; codes are normalised case-insensitively', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({}, async (ctx) => {
        const { socket: creator, roomId } = await createRoom(ctx, 'Owner');

        const guest = await ctx.connect();
        for (const badCode of ['ABC', 'ABCDE', 'AB!D', 'ABCD!', 42, null, '    ']) {
            const response = await emitAck(guest, 'join_room', badCode, 'Guest');
            assert.equal(response?.ok, false, `code ${JSON.stringify(badCode)} must be rejected`);
            assert.equal(response?.error, 'invalid_input');
        }

        // A syntactically valid but non-existent code returns room_not_found.
        const missing = await emitAck(guest, 'join_room', 'ZZZZ', 'Guest');
        assert.equal(missing?.ok, false);
        assert.equal(missing?.error, 'room_not_found');

        // Lower-case + whitespace is normalised to the canonical code.
        const normalised = await emitAck(guest, 'join_room', `  ${roomId.toLowerCase()}  `, 'Guest');
        assert.equal(normalised?.ok, true);
        assert.ok(normalised.playerId);

        // The same socket re-joining its own room stays idempotent.
        const repeat = await emitAck(guest, 'join_room', roomId, 'Guest');
        assert.equal(repeat?.ok, true);
        assert.equal(repeat?.playerId, normalised.playerId);
    });
});

test('malformed submit_word is rejected; oversize word never distributes letters', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({}, async (ctx) => {
        const { hostSocket, nonHosts } = await startThreePlayerRound(ctx);

        const lettersBySocket = nonHosts.map(() => []);
        nonHosts.forEach(([, socket], index) => {
            socket.on('assigned_letters', (letters) => lettersBySocket[index].push(...letters));
        });

        // Each malformed payload must produce an error and no host_word/letters.
        const malformed = [42, {}, [], 'ab', 'a'.repeat(65), 'abc123', '   '];
        for (const payload of malformed) {
            const error = waitFor(hostSocket, 'error_message');
            hostSocket.emit('submit_word', payload);
            assert.match(await error, /Word must be/i, `payload ${JSON.stringify(payload)} must be rejected`);
        }
        assert.deepEqual(lettersBySocket.flat(), [], 'malformed words must not distribute letters');

        // Boundary: exactly 64 letters is accepted.
        const good = 'Z'.repeat(64);
        const hostWord = waitFor(hostSocket, 'host_word');
        const letters = nonHosts.map(([, socket]) => waitFor(socket, 'assigned_letters'));
        hostSocket.emit('submit_word', good);
        assert.equal(await hostWord, good);
        await Promise.all(letters);

        await sleep(100);
        assert.ok(lettersBySocket.some((l) => l.length > 0), 'valid word should distribute letters');
        assert.deepEqual(
            [...lettersBySocket.flat()].sort(),
            [...good].sort(),
            'valid word letters must all be distributed exactly once',
        );
    });
});

test('start_round ignores malformed extra arguments and enforces player bounds', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({}, async (ctx) => {
        const { socket: creator } = await createRoom(ctx, 'Solo');

        // Fewer than the minimum number of players: an error, no round start.
        const tooFew = waitFor(creator, 'error_message');
        creator.emit('start_round', 'garbage', { nonsense: true });
        assert.match(await tooFew, /players/i);

        // No listener should ever see a round start.
        let started = false;
        creator.on('new_round_started', () => {
            started = true;
        });
        await sleep(150);
        assert.equal(started, false);
    });
});

test('players per room are capped at 8', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({ MAX_PLAYERS_PER_ROOM: '8' }, async (ctx) => {
        const { roomId } = await createRoom(ctx, 'P0');
        for (let i = 1; i < 8; i += 1) {
            const { response } = await joinRoom(ctx, roomId, `P${i}`);
            assert.equal(response.ok, true, `player ${i} should join`);
        }

        const ninth = await joinRoom(ctx, roomId, 'P8');
        assert.equal(ninth.response.ok, false);
        assert.equal(ninth.response.error, 'room_full');
    });
});

test('global room cap rejects new rooms but frees capacity on disconnect', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({ MAX_ROOMS: '2' }, async (ctx) => {
        const first = await createRoom(ctx, 'A');
        const second = await createRoom(ctx, 'B');

        const third = await ctx.connect();
        const rejected = await emitAck(third, 'create_room', 'C');
        assert.equal(rejected?.ok, false);
        assert.equal(rejected?.error, 'room_capacity_reached');

        // Disconnecting a single-player room releases its slot for reuse.
        first.socket.removeAllListeners();
        first.socket.disconnect();
        await sleep(200);

        const retry = await emitAck(third, 'create_room', 'C');
        assert.ok(retry?.roomId, 'room slot should be reusable after disconnect');

        // The released code no longer resolves.
        const stale = await joinRoom(ctx, first.roomId, 'Late');
        assert.equal(stale.response.ok, false);
        assert.equal(stale.response.error, 'room_not_found');

        // second still owns its room.
        assert.ok(second.roomId);
    });
});

test('a socket cannot accumulate multiple room memberships', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({ MAX_ROOMS_PER_SOCKET: '1' }, async (ctx) => {
        const first = await createRoom(ctx, 'Owner');

        // Same socket cannot create a second room...
        const secondCreate = await emitAck(first.socket, 'create_room', 'OwnerAgain');
        assert.equal(secondCreate?.ok, false);
        assert.equal(secondCreate?.error, 'already_in_room');

        // ...nor join somebody else's room.
        const other = await createRoom(ctx, 'Other');
        const secondJoin = await emitAck(first.socket, 'join_room', other.roomId, 'Owner');
        assert.equal(secondJoin?.ok, false);
        assert.equal(secondJoin?.error, 'already_in_room');

        // Re-joining the socket's own room stays idempotent (existing protocol).
        const idempotent = await emitAck(first.socket, 'join_room', first.roomId, 'Owner');
        assert.equal(idempotent?.ok, true);
        assert.equal(idempotent?.playerId, first.playerId);
    });
});

test('per-socket event rate limit rejects the surplus event', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({ RATE_LIMIT_MAX: '4', RATE_LIMIT_WINDOW_MS: '60000' }, async (ctx) => {
        const socket = await ctx.connect();

        // Four no-op events exhaust the budget (start_round without a room).
        for (let i = 0; i < 4; i += 1) socket.emit('start_round');
        await sleep(200);

        const limited = await emitAck(socket, 'create_room', 'Rider');
        assert.equal(limited?.ok, false);
        assert.equal(limited?.error, 'rate_limited');

        // No room should have been created.
        const probe = await ctx.connect();
        const probeJoin = await emitAck(probe, 'join_room', 'ABCD', 'Probe');
        assert.equal(probeJoin?.ok, false);
        assert.equal(probeJoin?.error, 'room_not_found');
    });
});

test('connection quota rejects handshakes beyond the limit', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({ MAX_CONNECTIONS: '1' }, async (ctx) => {
        const first = await ctx.connect();
        assert.equal(first.connected, true);

        await assert.rejects(ctx.connect(), /capacity/i);
    });
});

test('disconnect cleans up players and reassigns the host mid-round', { timeout: TEST_TIMEOUT_MS }, async () => {
    await withServer({}, async (ctx) => {
        const { roomId, hostId, hostSocket, byId } = await startThreePlayerRound(ctx);

        // Observe from a socket that is NOT the one being disconnected.
        const survivorSocket = [...byId.values()].find((socket) => socket !== hostSocket);
        assert.ok(survivorSocket, 'a non-host survivor socket must exist');
        const survivor = waitFor(survivorSocket, 'room_update', {
            predicate: (room) => room?.players?.length === 2 && Boolean(room?.hostId),
        });

        // Drop the current host; the round should continue with a new host.
        hostSocket.removeAllListeners();
        hostSocket.disconnect();

        const view = await survivor;
        assert.equal(view.players.length, 2);
        assert.notEqual(view.hostId, hostId, 'a new host must be selected');
        assert.ok(
            view.players.some((p) => p.id === view.hostId),
            'the new host must still be in the room',
        );

        // The room is still joinable afterwards.
        const late = await joinRoom(ctx, roomId, 'Late');
        assert.equal(late.response.ok, true);
    });
});
