import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface PublicPlayer {
    id: string;
    name: string;
    score: number;
    team?: 'Red' | 'Blue';
}
interface PublicRoomView {
    id: string;
    players: PublicPlayer[];
    state: 'waiting' | 'in-round';
    round: number;
    hostId?: string;
}

// Server acknowledgement shapes. Failure responses are additive: `ok:false`
// plus a machine-readable `error` code; success keeps the original fields.
interface CreateRoomResponse {
    ok?: boolean;
    roomId?: string;
    playerId?: string;
    error?: string;
}
interface JoinRoomResponse {
    ok: boolean;
    playerId?: string;
    error?: string;
}

// Map server error codes to short, user-facing toast messages. Unknown codes
// fall back to a generic message so we never surface an empty toast.
const ACK_ERROR_MESSAGES: Record<string, string> = {
    invalid_name: 'Please enter a valid name (1-40 characters).',
    invalid_input: 'Invalid name or room code.',
    room_not_found: 'Room not found.',
    room_full: 'That room is full (max 8 players).',
    already_in_room: 'You are already in a room.',
    room_capacity_reached: 'The server is at room capacity. Please try again shortly.',
    rate_limited: 'Too many requests — please slow down.',
    internal_error: 'Something went wrong. Please try again.',
};
function ackErrorMessage(error?: string): string {
    if (error && ACK_ERROR_MESSAGES[error]) return ACK_ERROR_MESSAGES[error];
    return 'Something went wrong. Please try again.';
}

interface ServerToClientEvents {
    room_update: (room: PublicRoomView) => void;
    new_round_started: (round: number) => void;
    assigned_letters: (letters: string[]) => void;
    host_selected: (hostId: string) => void;
    error_message: (msg: string) => void;
    host_word: (word: string) => void;
}
interface ClientToServerEvents {
    create_room: (playerName: string, cb: (resp: CreateRoomResponse) => void) => void;
    join_room: (roomId: string, playerName: string, cb: (resp: JoinRoomResponse) => void) => void;
    start_round: () => void;
    submit_word: (word: string) => void;
    add_point: () => void;
    change_team: () => void;
}

// VITE_SERVER_URL wins if set; in prod use the current origin as-is,
// in dev target the API server on port 4000 at the same host.
const SERVER_URL =
    (import.meta as any).env.VITE_SERVER_URL ||
    ((import.meta as any).env.PROD
        ? window.location.origin
        : window.location.origin.replace(/:\d+$/, ':4000'));

export function useGameSocket() {
    const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
    const [room, setRoom] = useState<PublicRoomView | null>(null);
    const [letters, setLetters] = useState<string[]>([]);
    const [playerId, setPlayerId] = useState<string>('');
    const [messages, setMessages] = useState<{ id: string; text: string }[]>([]);
    const [hostWord, setHostWord] = useState<string>('');
    const autoTriedRef = useRef(false);

    // localStorage keys
    const LS_KEY = 'lbl_identity_v1';

    type Identity = { name: string; roomId: string; playerId: string };

    const saveIdentity = useCallback((data: Identity) => {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(data));
        } catch {}
    }, []);

    const loadIdentity = useCallback((): Identity | null => {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return null;
            return JSON.parse(raw) as Identity;
        } catch {
            return null;
        }
    }, []);

    const clearIdentity = useCallback(() => {
        try {
            localStorage.removeItem(LS_KEY);
        } catch {}
    }, []);

    const pushMessage = useCallback((text: string) => {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), text }]);
    }, []);

    useEffect(() => {
        if (!socketRef.current) {
            const s = io(SERVER_URL, { autoConnect: false });
            socketRef.current = s;
            s.on('room_update', (r) => setRoom(r));
            s.on('assigned_letters', (l) => setLetters(l));
            s.on('error_message', (m) => pushMessage(m));
            s.on('host_word', (w) => setHostWord(w));
            s.on('new_round_started', (round) => {
                setLetters([]);
                setHostWord('');
            });
        }
        return () => {
            socketRef.current?.disconnect();
        };
    }, [pushMessage]);

    // Attempt auto rejoin once on mount
    useEffect(() => {
        if (autoTriedRef.current) return;
        autoTriedRef.current = true;
        const ident = loadIdentity();
        if (ident && ident.name && ident.roomId) {
            // attempt rejoin with stored name (playerId may change)
            const s = socketRef.current!;
            if (!s.connected) s.connect();
            s.emit('join_room', ident.roomId, ident.name, ({ ok, playerId }) => {
                if (ok && playerId) {
                    setPlayerId(playerId);
                    saveIdentity({ name: ident.name, roomId: ident.roomId, playerId });
                } else {
                    // stale room, clear storage
                    clearIdentity();
                }
            });
        }
    }, [loadIdentity, saveIdentity, clearIdentity]);

    const connectCreate = useCallback(
        (name: string) => {
            const s = socketRef.current!;
            if (!s.connected) s.connect();
            s.emit('create_room', name, ({ playerId, error }: CreateRoomResponse) => {
                if (!playerId) {
                    // Server rejected the request (invalid name, room cap, rate limit...).
                    pushMessage(ackErrorMessage(error));
                    return;
                }
                setPlayerId(playerId);
                // The room id arrives via the subsequent room_update; delay storing
                // so we never persist an invalid identity.
                setTimeout(() => {
                    const currentRoom = roomRef.current;
                    if (currentRoom) saveIdentity({ name, roomId: currentRoom.id, playerId });
                }, 50);
            });
        },
        [saveIdentity, pushMessage],
    );

    const connectJoin = useCallback(
        (roomId: string, name: string) => {
            const s = socketRef.current!;
            if (!s.connected) s.connect();
            s.emit('join_room', roomId, name, ({ ok, playerId, error }: JoinRoomResponse) => {
                if (!ok || !playerId) {
                    // Surface the real reason (full room, rate limit, bad code...).
                    pushMessage(ackErrorMessage(error));
                    return;
                }
                setPlayerId(playerId);
                saveIdentity({ name, roomId, playerId });
            });
        },
        [saveIdentity, pushMessage],
    );

    const startRound = useCallback(() => {
        socketRef.current?.emit('start_round');
    }, []);

    const submitWord = useCallback((w: string) => {
        socketRef.current?.emit('submit_word', w);
    }, []);

    const addPoint = useCallback(() => {
        socketRef.current?.emit('add_point');
    }, []);

    const isHost = room?.hostId === playerId;

    // Keep a ref for delayed operations
    const roomRef = useRef<PublicRoomView | null>(null);
    useEffect(() => {
        roomRef.current = room;
    }, [room]);

    const dismissMessage = useCallback((id: string) => {
        setMessages((prev) => prev.filter((m) => m.id !== id));
    }, []);

    return { room, letters, connectCreate, connectJoin, startRound, submitWord, addPoint, isHost, playerId, messages, dismissMessage, hostWord };
}
