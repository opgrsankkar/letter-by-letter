export type Player = {
    id: string; // internal id
    name: string;
    score: number;
    team: 'Red' | 'Blue';
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

// Failure responses are additive: successful create/join still return the
// original `roomId`/`playerId` fields so the existing client keeps working.
export interface CreateRoomResponse {
    ok?: boolean;
    roomId?: string;
    playerId?: string;
    error?: string;
}

export interface JoinRoomResponse {
    ok: boolean;
    playerId?: string;
    error?: string;
}

export interface ServerToClientEvents {
    room_update: (room: PublicRoomView) => void;
    assigned_letters: (letters: string[]) => void;
    host_selected: (hostId: string) => void;
    error_message: (msg: string) => void;
    host_word: (word: string) => void; // sent only to host after distribution
    new_round_started: (round: number) => void;
}

export interface ClientToServerEvents {
    // Arguments are typed `unknown` because they originate from the network and
    // are validated at runtime before any mutation.
    create_room: (playerName: unknown, cb: (resp: CreateRoomResponse) => void) => void;
    join_room: (
        roomId: unknown,
        playerName: unknown,
        cb: (resp: JoinRoomResponse) => void,
    ) => void;
    start_round: () => void; // server chooses host
    submit_word: (word: unknown) => void; // host only
    add_point: () => void; // non-host only
    disconnecting?: () => void;
}

export type PublicPlayer = { id: string; name: string; score: number; team: 'Red' | 'Blue' };
export interface PublicRoomView {
    id: string;
    players: PublicPlayer[];
    state: RoomState;
    round: number;
    hostId?: string;
}
