#!/usr/bin/env node
// smoke-test.mjs - end-to-end smoke test for a running Letter by Letter server.
//
// Usage:
//   node smoke-test.mjs [url]        # url defaults to http://127.0.0.1:4000
//   SMOKE_URL=http://127.0.0.1:14000 node smoke-test.mjs
//
// What it verifies:
//   * HTTP  /health       -> { status: 'ok' }
//   * HTTP  /random-word  -> { word: <non-empty string> }
//   * HTTP  /             -> index.html is served (client build present)
//   * Socket.IO (websocket transport only):
//       - 3 players connect, one creates a room, two join
//       - a round starts and exactly one host is selected
//       - the host submits ORANGE
//       - the two NON-host players receive letters that collectively spell ORANGE
//       - the host receives host_word === ORANGE
//       - the host receives no letters
//
// Exit code is 0 only when every assertion passes. A hard timeout guarantees a
// non-zero exit (never a hang), and every socket is always disconnected.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// socket.io-client is a dependency of the client workspace, so resolve it from
// there regardless of whether the workspace root has its own node_modules.
const requireFromClient = createRequire(path.join(__dirname, 'client', 'package.json'));
const { io } = requireFromClient('socket.io-client');

const BASE_URL = String(
    process.argv[2] || process.env.SMOKE_URL || 'http://127.0.0.1:4000',
).replace(/\/+$/, '');

const HARD_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 30_000);
const STEP_TIMEOUT_MS = Number(process.env.SMOKE_STEP_TIMEOUT_MS || 8_000);
const WORD = 'ORANGE';
const PLAYER_COUNT = 3;

/** @type {import('socket.io-client').Socket[]} */
const sockets = [];
let hardTimer = null;

const log = (...args) => console.log('[smoke]', ...args);

function cleanup() {
    for (const socket of sockets) {
        try {
            socket.removeAllListeners();
            socket.disconnect();
        } catch {
            /* already gone */
        }
    }
}

function fail(message) {
    throw new Error(message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(pathname, timeoutMs = STEP_TIMEOUT_MS) {
    const url = new URL(pathname, BASE_URL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal, redirect: 'follow' });
    } finally {
        clearTimeout(timer);
    }
}

async function checkHttp() {
    // /health
    const healthRes = await fetchWithTimeout('/health');
    if (healthRes.status !== 200) fail(`GET /health returned ${healthRes.status}`);
    const health = await healthRes.json();
    if (health?.status !== 'ok') fail(`GET /health body was ${JSON.stringify(health)}`);

    // /random-word
    const wordRes = await fetchWithTimeout('/random-word');
    if (wordRes.status !== 200) fail(`GET /random-word returned ${wordRes.status}`);
    const wordBody = await wordRes.json();
    if (typeof wordBody?.word !== 'string' || wordBody.word.trim().length === 0) {
        fail(`GET /random-word body was ${JSON.stringify(wordBody)}`);
    }

    // / (client build / SPA fallback)
    const indexRes = await fetchWithTimeout('/');
    if (indexRes.status !== 200) fail(`GET / returned ${indexRes.status}`);
    const indexBody = await indexRes.text();
    if (!/<!doctype html/i.test(indexBody)) {
        fail('GET / did not return an HTML document (client build missing?)');
    }

    log(`HTTP ok: /health, /random-word ("${wordBody.word}"), / (${indexBody.length} bytes)`);
}

function connectPlayer(name) {
    return new Promise((resolve, reject) => {
        const socket = io(BASE_URL, {
            transports: ['websocket'], // force websocket, skip polling upgrade
            upgrade: false,
            forceNew: true,
            reconnection: false,
            timeout: STEP_TIMEOUT_MS,
        });
        sockets.push(socket);

        let settled = false;
        const timer = setTimeout(
            () => finish(new Error(`${name}: timed out connecting to ${BASE_URL}`)),
            STEP_TIMEOUT_MS,
        );

        const onConnect = () => finish(null);
        const onConnectError = (err) =>
            finish(new Error(`${name}: connect_error: ${err?.message || String(err)}`));
        const onError = (err) => finish(new Error(`${name}: error: ${err?.message || String(err)}`));

        function finish(err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('connect', onConnect);
            socket.off('connect_error', onConnectError);
            socket.off('error', onError);
            if (err) reject(err);
            else resolve(socket);
        }

        socket.once('connect', onConnect);
        socket.once('connect_error', onConnectError);
        socket.once('error', onError);
    });
}

/** Wait for one socket event that satisfies an optional predicate. */
function waitFor(socket, event, { predicate = () => true, timeout = STEP_TIMEOUT_MS, label = event } = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, handler);
            reject(new Error(`timed out waiting for "${label}"`));
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

/** Emit an event that expects an acknowledgement callback. */
function emitAck(socket, event, ...args) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ack timed out for "${event}"`)), STEP_TIMEOUT_MS);
        socket.emit(event, ...args, (resp) => {
            clearTimeout(timer);
            resolve(resp);
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

async function runGameFlow() {
    const players = await Promise.all(
        Array.from({ length: PLAYER_COUNT }, (_, i) => connectPlayer(`P${i + 1}`)),
    );
    log(`${players.length} players connected over websocket`);

    // Surface server-side errors instead of letting them look like timeouts.
    for (const socket of players) {
        socket.on('error_message', (msg) => console.error(`[smoke] server error_message: ${msg}`));
    }

    // 1) Player 1 creates the room.
    const created = await emitAck(players[0], 'create_room', 'P1');
    if (!created?.roomId || !created?.playerId) {
        fail(`create_room returned ${JSON.stringify(created)}`);
    }
    const { roomId } = created;
    log(`room created: ${roomId}`);

    // 2) The rest join.
    const idToSocket = new Map([[created.playerId, players[0]]]);
    for (let i = 1; i < players.length; i++) {
        const joined = await emitAck(players[i], 'join_room', roomId, `P${i + 1}`);
        if (!joined?.ok || !joined.playerId) {
            fail(`join_room for P${i + 1} returned ${JSON.stringify(joined)}`);
        }
        idToSocket.set(joined.playerId, players[i]);
    }
    if (idToSocket.size !== PLAYER_COUNT) fail('not all players registered in the room');
    log(`${idToSocket.size} players registered in room ${roomId}`);

    // 3) Start a round; attach listeners before emitting.
    const hostSelected = waitFor(players[0], 'host_selected', { label: 'host_selected' });
    const roundStarted = waitFor(players[0], 'new_round_started', { label: 'new_round_started' });
    const inRoundView = waitFor(players[0], 'room_update', {
        predicate: (room) => room?.state === 'in-round' && Boolean(room?.hostId),
        label: 'room_update(in-round)',
    });

    players[0].emit('start_round');

    const hostId = await hostSelected;
    const round = await roundStarted;
    const view = await inRoundView;

    if (view.hostId !== hostId) fail(`room_update.hostId ${view.hostId} != host_selected ${hostId}`);
    if (view.players.length !== PLAYER_COUNT) fail(`expected ${PLAYER_COUNT} players, saw ${view.players.length}`);

    const hostSocket = idToSocket.get(hostId);
    if (!hostSocket) fail(`selected host ${hostId} is not one of the connected players`);
    const nonHostSockets = players.filter((socket) => socket !== hostSocket);
    log(`round ${round} started; host is player id ${hostId} (${nonHostSockets.length} recipients)`);

    // 4) Host submits the target word; collect letters from every non-host.
    let hostReceivedLetters = false;
    hostSocket.on('assigned_letters', () => {
        hostReceivedLetters = true;
    });

    const lettersPromises = nonHostSockets.map((socket, i) =>
        waitFor(socket, 'assigned_letters', { label: `assigned_letters#${i + 1}` }),
    );
    const hostWordPromise = waitFor(hostSocket, 'host_word', { label: 'host_word' });

    hostSocket.emit('submit_word', WORD);

    const [hostWord, ...lettersArrays] = await Promise.all([hostWordPromise, ...lettersPromises]);
    await sleep(150); // allow any (incorrect) host letters to arrive before asserting

    // 5) Assertions.
    if (hostWord !== WORD) fail(`host_word was ${JSON.stringify(hostWord)}, expected ${JSON.stringify(WORD)}`);

    for (const letters of lettersArrays) {
        if (!Array.isArray(letters) || letters.some((l) => typeof l !== 'string')) {
            fail(`assigned_letters payload was ${JSON.stringify(letters)}`);
        }
    }

    const collected = lettersArrays.flat();
    const expected = [...WORD].sort().join('');
    const actual = [...collected].sort().join('');
    if (collected.length !== WORD.length) {
        fail(`expected ${WORD.length} letters across non-hosts, got ${collected.length} (${collected.join('')})`);
    }
    if (actual !== expected) {
        fail(`letters spell ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }

    if (hostReceivedLetters) fail('host incorrectly received assigned_letters');

    log(`host received word "${hostWord}"`);
    log(`non-hosts hold [${lettersArrays.map((l) => l.join('')).join(' | ')}] -> "${actual}"`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
    log(`target ${BASE_URL}`);
    await checkHttp();
    await runGameFlow();
}

async function run() {
    try {
        await main();
        if (hardTimer) clearTimeout(hardTimer);
        log(`SMOKE TEST PASSED (${WORD} round reproduced end-to-end)`);
    } catch (err) {
        if (hardTimer) clearTimeout(hardTimer);
        console.error('[smoke] FAILED:', err && err.stack ? err.stack : String(err));
        process.exitCode = 1;
    } finally {
        cleanup();
    }
}

hardTimer = setTimeout(() => {
    console.error(`[smoke] HARD TIMEOUT after ${HARD_TIMEOUT_MS}ms`);
    cleanup();
    process.exit(1);
}, HARD_TIMEOUT_MS);

process.on('unhandledRejection', (reason) => {
    console.error('[smoke] unhandled rejection:', reason);
    cleanup();
    process.exit(1);
});
process.on('uncaughtException', (err) => {
    console.error('[smoke] uncaught exception:', err && err.stack ? err.stack : String(err));
    cleanup();
    process.exit(1);
});

run().then(() => {
    // Deterministic termination once everything is torn down (lets stdio flush).
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
});
