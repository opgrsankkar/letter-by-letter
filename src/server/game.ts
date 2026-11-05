// Pure game engine: rooms, players, rounds. No I/O, no timers, no sockets.
// Randomness, clock and id generation are injected so tests are deterministic.

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  LIMITS,
  TEAMS,
  cleanWord,
  type ErrorCode,
  type Phase,
  type RoundSummary,
  type Team,
  type View,
} from '../shared/protocol.ts';

export class GameError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Deps {
  rand: () => number;
  now: () => number;
  secret: () => string;
}

export interface Player {
  id: string;
  token: string;
  name: string;
  team: Team;
  score: number;
  connected: boolean;
  /** When the player last dropped off (ms), null while connected. */
  awaySince: number | null;
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export class Room {
  readonly code: string;
  readonly players: Player[] = [];
  phase: Phase = 'lobby';
  round = 0;
  hostId: string | null = null;
  timerSeconds = 0;
  deadline: number | null = null;
  last: RoundSummary | null = null;
  /** Secret state for the round in progress. */
  private word: string | null = null;
  private holdings = new Map<string, string[]>();
  /** Fair host rotation: everybody hosts once before anyone hosts twice. */
  private hostBag: string[] = [];
  private readonly deps: Deps;

  constructor(code: string, deps: Deps) {
    this.code = code;
    this.deps = deps;
  }

  // -- queries ---------------------------------------------------------------

  player(id: string): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  byToken(token: string): Player | undefined {
    return this.players.find((p) => p.token === token);
  }

  connectedPlayers(): Player[] {
    return this.players.filter((p) => p.connected);
  }

  isEmpty(): boolean {
    return this.players.length === 0;
  }

  /** Since when the whole room has been empty, or null if anyone is connected. */
  abandonedSince(): number | null {
    if (this.players.some((p) => p.connected)) return null;
    return Math.max(...this.players.map((p) => p.awaySince ?? 0));
  }

  scores(): Record<Team, number> {
    const out = { ember: 0, tide: 0 } as Record<Team, number>;
    for (const p of this.players) out[p.team] += p.score;
    return out;
  }

  // -- membership --------------------------------------------------------------

  addPlayer(name: string): Player {
    if (this.players.length >= LIMITS.maxPlayers) {
      throw new GameError('room_full', `This room already has ${LIMITS.maxPlayers} players.`);
    }
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('bad_name', 'Someone in this room already has that name.');
    }
    const player: Player = {
      id: this.deps.secret().slice(0, 12),
      token: this.deps.secret(),
      name,
      team: this.smallerTeam(),
      score: 0,
      connected: true,
      awaySince: null,
    };
    this.players.push(player);
    return player;
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p) return;
    p.connected = connected;
    p.awaySince = connected ? null : this.deps.now();
  }

  removePlayer(id: string): void {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.players.splice(idx, 1);
    this.hostBag = this.hostBag.filter((pid) => pid !== id);

    if (this.phase === 'playing') {
      if (id === this.hostId) {
        // The clue-giver walked away: show everyone the word and move on.
        this.finishRound(null);
      } else {
        this.rehome(id);
      }
    } else if (this.phase === 'choosing' && id === this.hostId) {
      this.beginChoosing(false);
    }
    if (this.players.length === 0) this.phase = 'lobby';
  }

  // -- player actions ------------------------------------------------------------

  switchTeam(id: string): void {
    this.requirePhase(['lobby', 'reveal']);
    const p = this.requirePlayer(id);
    p.team = p.team === 'ember' ? 'tide' : 'ember';
  }

  shuffleTeams(id: string): void {
    this.requirePlayer(id);
    this.requirePhase(['lobby', 'reveal']);
    const order = shuffle([...this.players], this.deps.rand);
    const firstTeam = TEAMS[Math.floor(this.deps.rand() * 2)];
    order.forEach((p, i) => {
      p.team = i % 2 === 0 ? firstTeam : firstTeam === 'ember' ? 'tide' : 'ember';
    });
  }

  setTimer(id: string, seconds: number): void {
    this.requirePlayer(id);
    this.requirePhase(['lobby', 'reveal']);
    if (!LIMITS.timerChoices.includes(seconds)) {
      throw new GameError('bad_request', 'Unsupported timer length.');
    }
    this.timerSeconds = seconds;
  }

  start(id: string): void {
    this.requirePlayer(id);
    this.requirePhase(['lobby']);
    this.beginChoosing(true);
  }

  /** Host submits the secret word; letters are dealt to everyone else who is here. */
  deal(id: string, rawWord: unknown): void {
    this.requirePhase(['choosing']);
    this.requireHost(id);
    const word = cleanWord(rawWord);
    if (!word) {
      throw new GameError('bad_word', `Words are ${LIMITS.wordMin}-${LIMITS.wordMax} letters, A to Z only.`);
    }
    const holders = shuffle(
      this.connectedPlayers().filter((p) => p.id !== id).map((p) => p.id),
      this.deps.rand,
    );
    if (holders.length < LIMITS.minPlayers - 1) {
      throw new GameError('too_few_players', 'Need at least two other players here to deal letters.');
    }
    const letters = shuffle(word.split(''), this.deps.rand);
    this.holdings = new Map(holders.map((pid) => [pid, [] as string[]]));
    letters.forEach((letter, i) => {
      this.holdings.get(holders[i % holders.length])!.push(letter);
    });
    this.word = word;
    this.phase = 'playing';
    this.deadline = this.timerSeconds > 0 ? this.deps.now() + this.timerSeconds * 1000 : null;
  }

  /** Host credits whoever guessed (or nobody). Ends the round. */
  award(id: string, guesserId: string | null): void {
    this.requirePhase(['playing']);
    this.requireHost(id);
    if (guesserId !== null) {
      const guesser = this.player(guesserId);
      if (!guesser || guesser.id === id) {
        throw new GameError('bad_request', 'Pick one of the other players.');
      }
      guesser.score += 1;
    }
    this.finishRound(guesserId);
  }

  /**
   * Skip the current clue-giver. The host can always pass; anyone else may
   * pass only when the host has dropped off, so a vanished phone never stalls
   * the table.
   */
  pass(id: string): void {
    this.requirePlayer(id);
    this.requirePhase(['choosing', 'playing']);
    const host = this.hostId ? this.player(this.hostId) : undefined;
    if (id !== this.hostId && host?.connected) {
      throw new GameError('not_allowed', 'Only the clue-giver can pass while they are here.');
    }
    if (this.phase === 'playing') this.finishRound(null);
    else this.beginChoosing(false);
  }

  next(id: string): void {
    this.requirePlayer(id);
    this.requirePhase(['reveal']);
    this.beginChoosing(true);
  }

  // -- views -------------------------------------------------------------------

  viewFor(id: string): View {
    const playing = this.phase === 'playing';
    const isHost = id === this.hostId;
    const holdingsObj = Object.fromEntries(this.holdings);
    return {
      code: this.code,
      you: id,
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        score: p.score,
        connected: p.connected,
        tileCount: playing ? (this.holdings.get(p.id)?.length ?? 0) : 0,
      })),
      scores: this.scores(),
      timerSeconds: this.timerSeconds,
      deadline: playing ? this.deadline : null,
      letters: playing ? (this.holdings.get(id) ?? null) : null,
      word: playing && isHost ? this.word : null,
      holdings: playing && isHost ? holdingsObj : null,
      last: this.last,
    };
  }

  // -- internals ---------------------------------------------------------------

  private beginChoosing(newRound: boolean): void {
    this.word = null;
    this.holdings = new Map();
    this.deadline = null;
    if (this.connectedPlayers().length < LIMITS.minPlayers) {
      if (this.phase === 'lobby') {
        throw new GameError('too_few_players', `Need at least ${LIMITS.minPlayers} players here to play.`);
      }
      this.phase = 'lobby';
      this.hostId = null;
      return;
    }
    if (newRound || this.round === 0) this.round += 1;
    this.hostId = this.drawHost();
    this.phase = 'choosing';
  }

  private drawHost(): string {
    const here = new Set(this.connectedPlayers().map((p) => p.id));
    this.hostBag = this.hostBag.filter((pid) => here.has(pid));
    if (this.hostBag.length === 0) {
      const fresh = shuffle([...here], this.deps.rand);
      // Never let the refill hand the role straight back to the outgoing host.
      if (fresh.length > 1 && fresh[fresh.length - 1] === this.hostId) {
        [fresh[0], fresh[fresh.length - 1]] = [fresh[fresh.length - 1], fresh[0]];
      }
      this.hostBag = fresh;
    }
    return this.hostBag.pop()!;
  }

  private finishRound(guesserId: string | null): void {
    this.last = {
      round: this.round,
      word: this.word ?? '',
      hostId: this.hostId ?? '',
      guesserId,
      holdings: Object.fromEntries(this.holdings),
    };
    this.word = null;
    this.holdings = new Map();
    this.deadline = null;
    this.phase = 'reveal';
  }

  /** Hand a departing holder's letters to whoever (present) holds the fewest. */
  private rehome(id: string): void {
    const orphaned = this.holdings.get(id);
    if (!orphaned) return;
    this.holdings.delete(id);
    const candidates = [...this.holdings.keys()].filter((pid) => this.player(pid)?.connected);
    const pool = candidates.length > 0 ? candidates : [...this.holdings.keys()];
    for (const letter of orphaned) {
      if (pool.length === 0) break;
      pool.sort((a, b) => this.holdings.get(a)!.length - this.holdings.get(b)!.length);
      this.holdings.get(pool[0])!.push(letter);
    }
  }

  private smallerTeam(): Team {
    const counts = { ember: 0, tide: 0 } as Record<Team, number>;
    for (const p of this.players) counts[p.team] += 1;
    if (counts.ember === counts.tide) return TEAMS[Math.floor(this.deps.rand() * 2)];
    return counts.ember < counts.tide ? 'ember' : 'tide';
  }

  private requirePlayer(id: string): Player {
    const p = this.player(id);
    if (!p) throw new GameError('not_in_room', 'You are not in this room.');
    return p;
  }

  private requireHost(id: string): void {
    this.requirePlayer(id);
    if (id !== this.hostId) throw new GameError('not_allowed', 'Only the clue-giver can do that.');
  }

  private requirePhase(allowed: Phase[]): void {
    if (!allowed.includes(this.phase)) {
      throw new GameError('wrong_phase', 'That is not possible right now.');
    }
  }
}

// ---------------------------------------------------------------------------
// Registry of rooms
// ---------------------------------------------------------------------------

export interface RegistryOptions {
  maxRooms: number;
  /** Drop a room once nobody has been connected for this long. */
  abandonAfterMs: number;
  /** Drop an individual player who has been away this long. */
  awayAfterMs: number;
}

export class Registry {
  readonly rooms = new Map<string, Room>();
  private readonly deps: Deps;
  private readonly opts: RegistryOptions;

  constructor(deps: Deps, opts: RegistryOptions) {
    this.deps = deps;
    this.opts = opts;
  }

  create(name: string): { room: Room; player: Player } {
    if (this.rooms.size >= this.opts.maxRooms) {
      throw new GameError('server_full', 'Too many games running right now. Try again later.');
    }
    const code = this.freshCode();
    const room = new Room(code, this.deps);
    this.rooms.set(code, room);
    return { room, player: room.addPlayer(name) };
  }

  join(code: string, name: string): { room: Room; player: Player } {
    const room = this.rooms.get(code);
    if (!room) throw new GameError('not_found', `No room called ${code}.`);
    return { room, player: room.addPlayer(name) };
  }

  resume(code: string, token: string): { room: Room; player: Player } {
    const room = this.rooms.get(code);
    const player = room?.byToken(token);
    if (!room || !player) throw new GameError('not_found', 'That game has ended.');
    return { room, player };
  }

  /** Remove long-gone players and abandoned rooms. Returns rooms that changed. */
  sweep(): Room[] {
    const now = this.deps.now();
    const changed: Room[] = [];
    for (const [code, room] of this.rooms) {
      const since = room.abandonedSince();
      if (room.isEmpty() || (since !== null && now - since >= this.opts.abandonAfterMs)) {
        this.rooms.delete(code);
        continue;
      }
      const stale = room.players.filter(
        (p) => !p.connected && p.awaySince !== null && now - p.awaySince >= this.opts.awayAfterMs,
      );
      for (const p of stale) room.removePlayer(p.id);
      if (stale.length > 0) changed.push(room);
    }
    return changed;
  }

  private freshCode(): string {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_ALPHABET[Math.floor(this.deps.rand() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new GameError('server_full', 'Could not allocate a room code.');
  }
}
