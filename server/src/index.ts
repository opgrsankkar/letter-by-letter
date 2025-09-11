import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { nanoid } from 'nanoid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ClientToServerEvents, ServerToClientEvents, Room, Player, PublicRoomView } from './types.js';

const app = express();
app.use(cors());
app.get('/health', (_req: express.Request, res: express.Response) => res.json({ status: 'ok' }));

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
});

// In-memory store (OK for local facilitator usage)
const rooms = new Map<string, Room>();

function createRoomCode(): string {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function publicView(room: Room): PublicRoomView {
    return {
        id: room.id,
        players: room.players.map((p) => ({ id: p.id, name: p.name })),
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
    room.state = 'waiting';
    broadcastRoom(room.id);
}

io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
    console.log('socket connected', socket.id);

    socket.on('create_room', (playerName: string, cb: (resp: { roomId: string; playerId: string }) => void) => {
        let code = createRoomCode();
        while (rooms.has(code)) code = createRoomCode();

        const player: Player = { id: nanoid(8), name: playerName, socketId: socket.id };
        const room: Room = {
            id: code,
            players: [player],
            state: 'waiting',
            round: 0,
            hostId: undefined,
            letters: {},
        };
        rooms.set(code, room);
        socket.join(code);
        cb({ roomId: code, playerId: player.id });
        broadcastRoom(code);
    });

    socket.on('join_room', (roomId: string, playerName: string, cb: (resp: { ok: boolean; playerId?: string }) => void) => {
        const room = rooms.get(roomId);
        if (!room) {
            cb({ ok: false });
            return;
        }
        if (room.players.find((p) => p.socketId === socket.id)) {
            cb({ ok: true, playerId: room.players.find((p) => p.socketId === socket.id)!.id });
            return;
        }
        const player: Player = { id: nanoid(8), name: playerName, socketId: socket.id };
        room.players.push(player);
        socket.join(roomId);
        cb({ ok: true, playerId: player.id });
        broadcastRoom(roomId);
    });

    socket.on('start_round', () => {
        // Determine room from socket rooms (skip its own id)
        const roomId = [...socket.rooms].find((r) => rooms.has(r));
        if (!roomId) return;
        const room = rooms.get(roomId)!;
        // Clear previous word when a new round actually starts
        delete room.word;
        if (room.players.length < 3 || room.players.length > 8) {
            socket.emit('error_message', 'Need 3-8 players to start round.');
            return;
        }
        room.round += 1;
        room.state = 'in-round';
        room.letters = {};
        for (const p of room.players) {
            const sock = io.sockets.sockets.get(p.socketId);
            sock?.emit('assigned_letters', []); // clear previous letters
            sock?.emit('host_word', ''); // clear previous host word
        }
        chooseHost(room);
        broadcastRoom(roomId);
    });

    socket.on('submit_word', (word: string) => {
        const roomId = [...socket.rooms].find((r) => rooms.has(r));
        if (!roomId) return;
        const room = rooms.get(roomId)!;
        if (socket.id !== room.players.find((p) => p.id === room.hostId)?.socketId) {
            socket.emit('error_message', 'Not host');
            return;
        }
        const cleaned = word.trim();
        if (!/^[a-zA-Z ]{3,}$/.test(cleaned)) {
            socket.emit('error_message', 'Word must be letters only (min 3).');
            return;
        }
        room.word = cleaned;
        distributeLetters(room, room.word!);
        // Send the word ONLY to host
        const hostPlayer = room.players.find((p) => p.id === room.hostId);
        if (hostPlayer) {
            const hostSock = io.sockets.sockets.get(hostPlayer.socketId);
            hostSock?.emit('host_word', cleaned);
        }
    });

    socket.on('disconnect', () => {
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

const PORT = Number(process.env.PORT) || 4000;
const HOST = '0.0.0.0';
httpServer.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
});
