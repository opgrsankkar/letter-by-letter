import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { randomInt, randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
    ClientToServerEvents,
    ServerToClientEvents,
    Room,
    Player,
    PublicRoomView,
} from './types.js';
import {
    WORD_MAX_LENGTH,
    WORD_MIN_LENGTH,
    createSlidingWindowLimiter,
    normalizeRoomCode,
    portFromEnv,
    positiveIntFromEnv,
    sanitizeName,
    validateWord,
} from './validation.js';

// ---------------------------------------------------------------------------
// Runtime configuration
//
// Every quota / limit is env-injectable so the isolated integration suite can
// exercise the boundaries deterministically without touching the defaults used
// in production.
// ---------------------------------------------------------------------------
const PORT = portFromEnv(process.env.PORT, 4000);
const MAX_ROOMS = positiveIntFromEnv(process.env.MAX_ROOMS, 100);
const MAX_PLAYERS_PER_ROOM = positiveIntFromEnv(process.env.MAX_PLAYERS_PER_ROOM, 8);
const MIN_PLAYERS_PER_ROOM = positiveIntFromEnv(process.env.MIN_PLAYERS_PER_ROOM, 3);
const MAX_ROOMS_PER_SOCKET = positiveIntFromEnv(process.env.MAX_ROOMS_PER_SOCKET, 1);
const MAX_CONNECTIONS = positiveIntFromEnv(process.env.MAX_CONNECTIONS, 1000);
const RATE_LIMIT_MAX = positiveIntFromEnv(process.env.RATE_LIMIT_MAX, 30);
const RATE_LIMIT_WINDOW_MS = positiveIntFromEnv(process.env.RATE_LIMIT_WINDOW_MS, 10_000);

const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const app = express();
app.use(cors());
app.get('/health', (_req: express.Request, res: express.Response) => res.json({ status: 'ok' }));

// API endpoint for getting random word
app.get('/random-word', async (_req: express.Request, res: express.Response) => {
    //Get from words_list.txt
    const wordsFilePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../words_list.txt');
    fs.readFile(wordsFilePath, 'utf-8', (err, data) => {
        if (err) {
            console.error('Error reading words file:', err);
            return res.status(500).json({ error: 'Failed to read words file' });
        }
        const words = data.split('\n').map(word => word.trim()).filter(word => word.length > 0);
        const randomWord = words[Math.floor(Math.random() * words.length)];
        res.json({ word: randomWord });
    });
});

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
});

// In-memory store (OK for local facilitator usage)
const rooms = new Map<string, Room>();
// socketId -> set of room codes it is a member of. Bounds "pending" memberships
// so a single socket cannot allocate unbounded rooms.
const socketRooms = new Map<string, Set<string>>();

let activeConnections = 0;

// Connection quota: reject new handshakes once the process is at capacity.
io.use((_socket, next) => {
    if (activeConnections >= MAX_CONNECTIONS) {
        next(new Error('Server is at connection capacity.'));
        return;
    }
    next();
});

function generateRoomCode(): string {
    let code = '';
    for (let i = 0; i < 4; i += 1) {
        code += ROOM_CODE_ALPHABET.charAt(randomInt(0, ROOM_CODE_ALPHABET.length));
    }
    return code;
}

function generateUniqueRoomCode(): string {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
        const code = generateRoomCode();
        if (!rooms.has(code)) return code;
    }
    // Fail closed: never overwrite or alias an existing room.
    throw new Error('Unable to allocate a unique room code (namespace exhausted)');
}

function registerMembership(socketId: string, roomId: string): void {
    let memberships = socketRooms.get(socketId);
    if (!memberships) {
        memberships = new Set<string>();
        socketRooms.set(socketId, memberships);
    }
    memberships.add(roomId);
}

function roomIdForSocket(socket: Socket): string | undefined {
    for (const candidate of socket.rooms) {
        if (rooms.has(candidate)) return candidate;
    }
    return undefined;
}

function publicView(room: Room): PublicRoomView {
    return {
        id: room.id,
        players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score, team: p.team })),
        state: room.state,
        round: room.round,
        hostId: room.hostId,
    };
}

function chooseHost(room: Room): Player | undefined {
    if (room.players.length === 0) return undefined;
    const idx = Math.floor(Math.random() * room.players.length);
    const host = room.players[idx];
    room.hostId = host.id;
    io.to(room.id).emit('host_selected', host.id);
    broadcastRoom(room.id);
    return host;
}

function broadcastRoom(roomId: string) {
    const room = rooms.get(roomId);
    if (!room) return;
    io.to(roomId).emit('room_update', publicView(room));
}

function distributeLetters(room: Room, word: string) {
    // Remove spaces, uppercase
    const letters = word.replace(/\s+/g, '').toUpperCase().split('');
    const recipients = room.players.filter((p) => p.id !== room.hostId);
    if (recipients.length === 0) return;
    // Random shuffle letters
    for (let i = letters.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    // Initialize
    for (const r of recipients) room.letters[r.id] = [];
    let ptr = 0;
    while (ptr < letters.length) {
        for (const r of recipients) {
            if (ptr >= letters.length) break;
            room.letters[r.id].push(letters[ptr]);
            ptr++;
        }
    }
    // Send letters privately
    for (const r of recipients) {
        const sock = io.sockets.sockets.get(r.socketId);
        if (sock) sock.emit('assigned_letters', room.letters[r.id]);
    }
    // Keep the word in memory until next round so host can still view it; don't broadcast it
    // Allow UI to start a new round while players play verbally
    broadcastRoom(room.id);
}

function getTeamWithFewerPlayers(room: Room): 'Red' | 'Blue' {
    const redCount = room.players.filter((p) => p.team === 'Red').length;
    const blueCount = room.players.filter((p) => p.team === 'Blue').length;
    return redCount <= blueCount ? 'Red' : 'Blue';
}

function startNewRound(socket: Socket): void {
    const roomId = roomIdForSocket(socket);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    // Clear previous word when a new round actually starts
    delete room.word;
    if (room.players.length < MIN_PLAYERS_PER_ROOM || room.players.length > MAX_PLAYERS_PER_ROOM) {
        socket.emit('error_message', `Need ${MIN_PLAYERS_PER_ROOM}-${MAX_PLAYERS_PER_ROOM} players to start round.`);
        return;
    }
    room.round += 1;
    room.state = 'in-round';
    room.letters = {};
    chooseHost(room);
    broadcastRoom(roomId);
    io.to(roomId).emit('new_round_started', room.round);
}

// ---------------------------------------------------------------------------
// Socket boundary helpers
//
// Handlers never trust argument shapes or the presence of an acknowledgement
// callback. `takeAck` pulls a trailing function (if any) off the raw argument
// list; everything else is validated by the pure helpers in validation.ts.
// ---------------------------------------------------------------------------
type AckFunction = (response: unknown) => void;

function isAck(value: unknown): value is AckFunction {
    return typeof value === 'function';
}

function takeAck(args: unknown[]): AckFunction | undefined {
    if (args.length > 0 && isAck(args[args.length - 1])) {
        return args.pop() as AckFunction;
    }
    return undefined;
}

function safeAck(ack: AckFunction | undefined, payload: unknown): void {
    if (!ack) return;
    try {
        ack(payload);
    } catch (err) {
        console.error('ack callback failed:', err);
    }
}

io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
    activeConnections += 1;
    console.log('socket connected', socket.id);

    const limiter = createSlidingWindowLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

    // Register an event with (a) a per-socket rate limit and (b) a validated
    // acknowledgement. `socket` is widened here because the runtime argument
    // list is intentionally untyped until it has been validated.
    const register = (
        event: keyof ClientToServerEvents,
        handler: (args: unknown[], ack: AckFunction | undefined) => void,
    ): void => {
        (socket as unknown as { on: (name: string, listener: (...a: unknown[]) => void) => void }).on(
            event,
            (...incoming: unknown[]) => {
                const ack = takeAck(incoming);
                if (!limiter.allow()) {
                    socket.emit('error_message', 'Too many requests; please slow down.');
                    safeAck(ack, { ok: false, error: 'rate_limited' });
                    return;
                }
                try {
                    handler(incoming, ack);
                } catch (err) {
                    console.error(`Unhandled error in "${String(event)}":`, err);
                    safeAck(ack, { ok: false, error: 'internal_error' });
                }
            },
        );
    };

    register('create_room', (args, ack) => {
        if (!ack) {
            socket.emit('error_message', 'create_room requires an acknowledgement callback.');
            return;
        }
        const name = sanitizeName(args[0]);
        if (name === null) {
            safeAck(ack, { ok: false, error: 'invalid_name' });
            return;
        }
        const memberships = socketRooms.get(socket.id);
        if (memberships && memberships.size >= MAX_ROOMS_PER_SOCKET) {
            safeAck(ack, { ok: false, error: 'already_in_room' });
            return;
        }
        if (rooms.size >= MAX_ROOMS) {
            safeAck(ack, { ok: false, error: 'room_capacity_reached' });
            return;
        }
        const code = generateUniqueRoomCode();
        const team = Math.random() < 0.5 ? 'Red' : 'Blue';
        const player: Player = { id: randomUUID(), name, socketId: socket.id, score: 0, team };
        const room: Room = {
            id: code,
            players: [player],
            state: 'waiting',
            round: 0,
            hostId: undefined,
            letters: {},
        };
        rooms.set(code, room);
        registerMembership(socket.id, code);
        socket.join(code);
        safeAck(ack, { roomId: code, playerId: player.id });
        broadcastRoom(code);
    });

    register('join_room', (args, ack) => {
        if (!ack) {
            socket.emit('error_message', 'join_room requires an acknowledgement callback.');
            return;
        }
        const roomId = normalizeRoomCode(args[0]);
        const name = sanitizeName(args[1]);
        if (roomId === null || name === null) {
            safeAck(ack, { ok: false, error: 'invalid_input' });
            return;
        }
        const room = rooms.get(roomId);
        if (!room) {
            safeAck(ack, { ok: false, error: 'room_not_found' });
            return;
        }
        const existing = room.players.find((p) => p.socketId === socket.id);
        if (existing) {
            safeAck(ack, { ok: true, playerId: existing.id });
            return;
        }
        const memberships = socketRooms.get(socket.id);
        if (memberships && memberships.size >= MAX_ROOMS_PER_SOCKET) {
            safeAck(ack, { ok: false, error: 'already_in_room' });
            return;
        }
        if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
            safeAck(ack, { ok: false, error: 'room_full' });
            return;
        }
        const player: Player = {
            id: randomUUID(),
            name,
            socketId: socket.id,
            score: 0,
            team: getTeamWithFewerPlayers(room),
        };
        room.players.push(player);
        registerMembership(socket.id, roomId);
        socket.join(roomId);
        safeAck(ack, { ok: true, playerId: player.id });
        broadcastRoom(roomId);
    });

    register('start_round', () => {
        startNewRound(socket);
    });

    register('submit_word', (args) => {
        const roomId = roomIdForSocket(socket);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const hostPlayer = room.players.find((p) => p.id === room.hostId);
        if (!hostPlayer || hostPlayer.socketId !== socket.id) {
            socket.emit('error_message', 'Not host');
            return;
        }
        const cleaned = validateWord(args[0]);
        if (cleaned === null) {
            socket.emit(
                'error_message',
                `Word must be ${WORD_MIN_LENGTH}-${WORD_MAX_LENGTH} letters/spaces.`,
            );
            return;
        }
        room.word = cleaned;
        distributeLetters(room, cleaned);
        // Send the word ONLY to host
        const hostSock = io.sockets.sockets.get(hostPlayer.socketId);
        hostSock?.emit('host_word', cleaned);
    });

    register('add_point', () => {
        const roomId = roomIdForSocket(socket);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.find((p) => p.socketId === socket.id);
        if (!player) return;
        if (player.id === room.hostId) {
            socket.emit('error_message', 'Host cannot add points.');
            return;
        }
        player.score += 1;
        startNewRound(socket);
    });

    socket.on('disconnect', () => {
        activeConnections = Math.max(0, activeConnections - 1);
        socketRooms.delete(socket.id);
        // Remove player from rooms
        for (const [roomId, room] of rooms) {
            const idx = room.players.findIndex((p) => p.socketId === socket.id);
            if (idx >= 0) {
                const leaving = room.players[idx];
                room.players.splice(idx, 1);
                // Reassign host if needed
                if (leaving.id === room.hostId) {
                    room.hostId = undefined;
                    if (room.players.length > 0 && room.state === 'in-round') {
                        chooseHost(room);
                    }
                }
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                } else {
                    broadcastRoom(roomId);
                }
            }
        }
    });
});

// Static client serving (production build) if available
try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const packagedStatic = path.resolve(__dirname, './static');
    const externalDist = path.resolve(__dirname, '../../client/dist');
    let staticRoot: string | null = null;
    if (fs.existsSync(packagedStatic)) {
        staticRoot = packagedStatic;
    } else if (fs.existsSync(externalDist)) {
        staticRoot = externalDist;
    }
    if (staticRoot) {
        app.use(express.static(staticRoot));
        app.get(/^(?!\/socket\.io\/|\/health).+/, (_req, res) => {
            res.sendFile(path.join(staticRoot!, 'index.html'));
        });
        console.log('Serving client build from', staticRoot);
    } else {
        console.log('No client build found (looked in', packagedStatic, 'and', externalDist, ')');
    }
} catch (e) {
    console.warn('Static client serve setup failed:', e);
}

const HOST = process.env.HOST?.trim() || '0.0.0.0';
httpServer.listen(PORT, HOST, () => {
    const address = httpServer.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : PORT;
    console.log(`Server listening on http://${HOST}:${actualPort}`);
    // When spawned with an IPC channel (integration tests) report the bound
    // port so callers can discover the ephemeral port chosen for PORT=0.
    if (typeof process.send === 'function') {
        process.send({ type: 'listening', port: actualPort });
    }
});
