export type Player = {
    id: string; // internal id
    name: string;
    socketId: string;
};

export type RoomState = 'waiting' | 'in-round';

export interface Room {
    id: string; // room code
    players: Player[];
    state: RoomState;
    round: number;
    hostId?: string;
    word?: string; // only stored temporarily for distribution
    letters: Record<string, string[]>; // playerId -> letters
}

export interface ServerToClientEvents {
    room_update: (room: PublicRoomView) => void;
    assigned_letters: (letters: string[]) => void;
    host_selected: (hostId: string) => void;
    error_message: (msg: string) => void;
    host_word: (word: string) => void; // sent only to host after distribution
}

export interface ClientToServerEvents {
    create_room: (playerName: string, cb: (resp: { roomId: string; playerId: string }) => void) => void;
    join_room: (roomId: string, playerName: string, cb: (resp: { ok: boolean; playerId?: string }) => void) => void;
    start_round: () => void; // server chooses host
    submit_word: (word: string) => void; // host only
    disconnecting?: () => void;
}

export type PublicPlayer = { id: string; name: string };
export interface PublicRoomView {
    id: string;
    players: PublicPlayer[];
    state: RoomState;
    round: number;
    hostId?: string;
}
