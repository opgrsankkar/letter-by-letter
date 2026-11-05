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
  POINTS,
  type RoundSummary,
  type GuessKind,
  type Stage,
  type Team,
  type View,
} from '../shared/protocol.ts';

const OWNER_GRACE_MS = 60_000;

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
  ended = false;
  stage: Stage | null = null;
  /** Players who left with points; their points still count for their team. */
  private departed: Player[] = [];
  private hinted = new Set<string>();
  private hintOrder: string[] = [];

  private early = false;
  /** Secret state for the round in progress. */
  private word: string | null = null;
  private holdings = new Map<string, string[]>();
  /**
   * Host rotation: teams take turns giving clues, and within a team everyone
   * gives clues once before anyone goes twice.
   */
  private hostBags: Record<Team, string[]> = { ember: [], tide: [] };
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

  /** The earliest-joined player who is here (or anyone, if nobody is). */
  /**
   * The earliest-joined player who is here. A phone that drops out for a
   * moment (screen lock, flaky wifi) keeps ownership for OWNER_GRACE_MS, so
   * the room does not change hands mid-action.
   */
  ownerId(): string | null {
    const now = this.deps.now();
    const present = (p: Player) => p.connected || (p.awaySince !== null && now - p.awaySince < OWNER_GRACE_MS);
    return (this.players.find(present) ?? this.players[0])?.id ?? null;
  }

  isEmpty(): boolean {
    return this.players.length === 0;
  }

  /** Since when the whole room has been empty, or null if anyone is connected. */
  abandonedSince(): number | null {
    if (this.players.some((p) => p.connected)) return null;
    return Math.max(...this.players.map((p) => p.awaySince ?? 0));
  }

  /** Team totals, including points earned by players who have since left. */
  scores(): Record<Team, number> {
    const out = { ember: 0, tide: 0 } as Record<Team, number>;
    for (const p of [...this.players, ...this.departed]) out[p.team] += p.score;
    return out;
  }

  /** A current player, or the record of one who left (for score corrections). */
  private scoreHolder(id: string): Player | undefined {
    return this.player(id) ?? this.departed.find((p) => p.id === id);
  }

  // -- membership --------------------------------------------------------------

  /**
   * Seat a new player. Joining under the name of a player who is currently
   * away takes over that seat (score, team, letters): the usual reason is the
   * same person arriving from a different browser. The old token stops working.
   */
  addPlayer(name: string): Player {
    const same = this.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (same && !same.connected) {
      same.token = this.deps.secret();
      return same;
    }
    if (same) throw new GameError('bad_name', 'Someone in this room already has that name.');
    if (this.players.length >= LIMITS.maxPlayers) {
      throw new GameError('room_full', `This room already has ${LIMITS.maxPlayers} players.`);
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
    const wasHinted = this.hinted.has(id);
    const [gone] = this.players.splice(idx, 1);
    // Their points stay with their team.
    if (gone.score !== 0) this.departed.push(gone);
    for (const team of TEAMS) this.hostBags[team] = this.hostBags[team].filter((pid) => pid !== id);
    this.hinted.delete(id);
    this.hintOrder = this.hintOrder.filter((pid) => pid !== id);

    if (this.phase === 'playing') {
      if (id === this.hostId) {
        // The clue-giver walked away: show everyone the word and move on.
        this.finishRound(null);
      } else {
        this.rehome(id, wasHinted);
      }
    } else if (this.phase === 'choosing' && id === this.hostId) {
      this.beginChoosing(false);
    }
    if (this.players.length === 0) this.phase = 'lobby';
  }

  // -- player actions ------------------------------------------------------------

  switchTeam(id: string): void {
    this.requirePhase(['lobby']);
    const p = this.requirePlayer(id);
    p.team = p.team === 'ember' ? 'tide' : 'ember';
  }

  shuffleTeams(id: string): void {
    this.requireOwner(id);
    this.requirePhase(['lobby']);
    const order = shuffle([...this.players], this.deps.rand);
    const firstTeam = TEAMS[Math.floor(this.deps.rand() * 2)];
    order.forEach((p, i) => {
      p.team = i % 2 === 0 ? firstTeam : firstTeam === 'ember' ? 'tide' : 'ember';
    });
  }

  setTimer(id: string, seconds: number): void {
    this.requireOwner(id);
    this.requirePhase(['lobby']);
    if (!LIMITS.timerChoices.includes(seconds)) {
      throw new GameError('bad_request', 'Unsupported timer length.');
    }
    this.timerSeconds = seconds;
  }

  start(id: string): void {
    this.requireOwner(id);
    this.requirePhase(['lobby']);
    if (this.ended) {
      // A fresh game: clean slate for scores and history.
      if (this.connectedPlayers().length < LIMITS.minPlayers) {
        throw new GameError('too_few_players', `Need at least ${LIMITS.minPlayers} players here to play.`);
      }
      for (const p of this.players) p.score = 0;
      this.departed = [];
      this.round = 0;
      this.last = null;
      this.ended = false;
      this.hostBags = { ember: [], tide: [] };
    }
    this.beginChoosing(true);
  }

  /** Owner finishes the game: back to the lobby with final scores on show. */
  end(id: string): void {
    this.requireOwner(id);
    this.requirePhase(['choosing', 'playing', 'reveal']);
    // A round in progress is abandoned without points.
    this.stage = null;
    this.hinted = new Set();
    this.hintOrder = [];
    this.word = null;
    this.holdings = new Map();
    this.deadline = null;
    this.hostId = null;
    this.phase = 'lobby';
    this.ended = true;
  }

  /** Host submits the secret word; letters are dealt to everyone else who is here. */
  deal(id: string, rawWord: unknown): void {
    this.requirePhase(['choosing']);
    this.requireHost(id);
    const word = cleanWord(rawWord);
    if (!word) {
      throw new GameError('bad_word', `Words are ${LIMITS.wordMin}-${LIMITS.wordMax} letters, A to Z only.`);
    }
    // Hinting goes "clockwise" from the clue-giver's left, using join order as
    // the seating order. As the clue-giver role moves round the table, so does
    // everyone's turn: over a full cycle each player sits in every position once.
    const seat = this.players.findIndex((p) => p.id === id);
    const ring = [...this.players.slice(seat + 1), ...this.players.slice(0, seat)];
    const holders = ring.filter((p) => p.connected).map((p) => p.id);
    if (holders.length < LIMITS.minPlayers - 1) {
      throw new GameError('too_few_players', 'Need at least two other players here to deal letters.');
    }
    const letters = shuffle(word.split(''), this.deps.rand);
    // A short word at a big table leaves some players without letters: they
    // just listen and guess, and are not part of the hinting order.
    const dealtTo = holders.slice(0, Math.min(holders.length, letters.length));
    this.holdings = new Map(dealtTo.map((pid) => [pid, [] as string[]]));
    letters.forEach((letter, i) => {
      this.holdings.get(dealtTo[i % dealtTo.length])!.push(letter);
    });
    this.word = word;
    this.phase = 'playing';
    this.stage = 'letters';
    this.hinted = new Set();
    this.hintOrder = [...dealtTo];
    this.early = false;
    this.deadline = this.timerSeconds > 0 ? this.deps.now() + this.timerSeconds * 1000 : null;
  }

  /** Holders still to hint, in order, skipping anyone who is away. */
  pendingHinters(): string[] {
    return this.hintOrder.filter((pid) => this.player(pid)?.connected && !this.hinted.has(pid));
  }

  /**
   * A letter holder says they have finished hinting. Holders go in the dealt
   * order, so nobody can sit back and hear everyone else's letters first.
   */
  markHinted(id: string, done: boolean): void {
    this.requirePhase(['playing']);
    this.requirePlayer(id);
    if (!this.holdings.has(id)) throw new GameError('not_allowed', 'Only letter holders hint at letters.');
    if (this.stage !== 'letters') return;
    if (done) {
      const next = this.pendingHinters()[0];
      if (next !== id && !this.hinted.has(id)) {
        throw new GameError('not_allowed', `Wait for ${this.player(next ?? '')?.name ?? 'your turn'} to hint first.`);
      }
      this.hinted.add(id);
    } else {
      // Undo only while nobody after you has gone.
      const mine = this.hintOrder.indexOf(id);
      if (this.hintOrder.slice(mine + 1).some((pid) => this.hinted.has(pid))) {
        throw new GameError('not_allowed', 'The next player has already hinted.');
      }
      this.hinted.delete(id);
    }
  }

  /**
   * The clue-giver moves the turn on for a holder who has said their hints out
   * loud but forgot to tap, the way a host at a real table would say "OK,
   * Chen's done". Only ever the player whose turn it is.
   */
  advanceHint(id: string): string {
    this.requirePhase(['playing']);
    this.requireHost(id);
    if (this.stage !== 'letters') throw new GameError('wrong_phase', 'Letter hints are already over.');
    const current = this.pendingHinters()[0];
    if (!current) throw new GameError('wrong_phase', 'Everyone has already hinted.');
    this.hinted.add(current);
    return current;
  }

  /**
   * The clue-giver starts the word clue. Doing so before every holder has
   * hinted is allowed (someone may be stalling) but caps their own reward.
   */
  unlock(id: string): void {
    this.requirePhase(['playing']);
    this.requireHost(id);
    if (this.stage === 'letters' && this.pendingHinters().length > 0) this.early = true;
    this.stage = 'clue';
  }

  /**
   * The clue-giver credits whoever guessed (or nobody), ending the round.
   *
   * The phones cannot hear when a guess was spoken, so `kind` lets the
   * clue-giver say how it came about: a player who shouted the word and only
   * then tapped "hinted" guessed 'before-hint'. Until the next word is dealt the
   * same player may correct the guesser and the kind; points are re-scored.
   * Nobody can be given a full +2 they could not have earned in that round.
   */
  award(id: string, guesserId: string | null, kind?: GuessKind): void {
    this.requirePhase(['playing', 'reveal', 'choosing']);
    // Corrections stay open until the next word is dealt.
    if (this.phase !== 'playing') {
      const last = this.last;
      if (!last || last.hostId !== id || !last.word) {
        throw new GameError('not_allowed', 'Only the last clue-giver can change who guessed.');
      }
      this.validateGuesser(id, guesserId);
      for (const [pid, pts] of Object.entries(last.points)) {
        const p = this.scoreHolder(pid);
        if (p) p.score -= pts;
      }
      last.guesserId = guesserId;
      const fallback: GuessKind = last.stage === 'clue' ? 'clue' : 'letters';
      last.kind = guesserId ? this.settleKind(guesserId, kind ?? last.kind ?? fallback, last.eligible) : null;
      last.points = this.scoreKind(id, guesserId, last.kind, last.early);
      return;
    }
    this.requireHost(id);
    this.validateGuesser(id, guesserId);
    const eligible = this.eligibleNow();
    let final: GuessKind | null = null;
    if (guesserId) {
      // Default from the stage; a word-clue guess cannot predate the word clue.
      const asked = kind ?? (this.stage === 'clue' ? 'clue' : 'letters');
      final = this.settleKind(guesserId, asked === 'clue' && this.stage !== 'clue' ? 'letters' : asked, eligible);
    }
    this.finishRound(guesserId, this.scoreKind(id, guesserId, final, this.early), final, eligible);
  }

  /** Who could earn a full letter-stage +2 right now. */
  private eligibleNow(): string[] {
    return this.players.filter((p) => !this.holdings.has(p.id) || this.hinted.has(p.id)).map((p) => p.id);
  }

  /** Never more than the guesser could have earned: no +2 without having hinted. */
  private settleKind(guesserId: string, kind: GuessKind, eligible: string[]): GuessKind {
    return kind === 'letters' && !eligible.includes(guesserId) ? 'before-hint' : kind;
  }

  private scoreKind(hostId: string, guesserId: string | null, kind: GuessKind | null, early: boolean): Record<string, number> {
    if (!guesserId || !kind) return {};
    const value = kind === 'letters' ? POINTS.letters : POINTS.clue;
    return this.scoreRound(hostId, guesserId, value, this.hostValue(kind === 'clue', early));
  }

  private hostValue(neededClue: boolean, early: boolean): number {
    return neededClue && !early ? POINTS.hostClue : POINTS.hostLetters;
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

  /**
   * Move on from the reveal. That is the outgoing clue-giver's call (or the
   * owner's), so nobody skips the reveal for the rest of the table; if the
   * clue-giver has gone, anyone may.
   */
  next(id: string): void {
    this.requirePlayer(id);
    this.requirePhase(['reveal']);
    // Only the outgoing clue-giver moves on, so nobody (owner included) can
    // cut off a scoring fix. If they have gone, anyone may.
    const lastHost = this.last ? this.player(this.last.hostId) : undefined;
    if (id !== lastHost?.id && lastHost?.connected) {
      throw new GameError('not_allowed', `${lastHost.name} starts the next round.`);
    }
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
      ownerId: this.ownerId(),
      ended: this.ended,
      stage: playing ? this.stage : null,
      hinted: playing ? [...this.hinted] : [],
      hintOrder: playing ? [...this.hintOrder] : [],
      early: playing ? this.early : false,
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
    this.stage = null;
    this.hinted = new Set();
    this.hintOrder = [];
    this.early = false;
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
    const previous = this.hostId ?? this.last?.hostId ?? null;
    const previousTeam = previous ? this.player(previous)?.team : undefined;
    const here = this.connectedPlayers();
    const members = (team: Team) => here.filter((p) => p.team === team).map((p) => p.id);
    // Alternate teams; if the other team has nobody here, stay on this one.
    let team: Team = previousTeam
      ? previousTeam === 'ember' ? 'tide' : 'ember'
      : TEAMS[Math.floor(this.deps.rand() * 2)];
    if (members(team).length === 0) team = team === 'ember' ? 'tide' : 'ember';

    const eligible = new Set(members(team));
    let bag = this.hostBags[team].filter((pid) => eligible.has(pid));
    if (bag.length === 0) {
      bag = shuffle([...eligible], this.deps.rand);
      // Never let a refill hand the role straight back to the outgoing host.
      if (bag.length > 1 && bag[bag.length - 1] === previous) {
        [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
    }
    const host = bag.pop()!;
    this.hostBags[team] = bag;
    return host;
  }

  private validateGuesser(hostId: string, guesserId: string | null): void {
    if (guesserId === null) return;
    const guesser = this.player(guesserId);
    if (!guesser || guesser.id === hostId) {
      throw new GameError('bad_request', 'Pick one of the other players.');
    }
  }

  /** Apply (and return) the points for a solved word. */
  private scoreRound(hostId: string, guesserId: string | null, value: number, hostValue: number): Record<string, number> {
    const points: Record<string, number> = {};
    if (guesserId === null) return points;
    points[guesserId] = value;
    points[hostId] = (points[hostId] ?? 0) + hostValue;
    for (const [pid, pts] of Object.entries(points)) {
      const p = this.scoreHolder(pid);
      if (p) p.score += pts;
    }
    return points;
  }

  private finishRound(
    guesserId: string | null,
    points: Record<string, number> = {},
    kind: GuessKind | null = null,
    eligible: string[] = this.eligibleNow(),
  ): void {
    this.last = {
      round: this.round,
      word: this.word ?? '',
      hostId: this.hostId ?? '',
      guesserId,
      stage: this.stage,
      early: this.early,
      eligible,
      kind,
      points,
      holdings: Object.fromEntries(this.holdings),
    };
    this.word = null;
    this.holdings = new Map();
    this.deadline = null;
    this.stage = null;
    this.hinted = new Set();
    this.hintOrder = [];
    this.early = false;
    this.phase = 'reveal';
  }

  /**
   * Hand a departing holder's letters on, preferring players who are here and
   * have not hinted yet, then whoever holds the fewest. If the letters were
   * never hinted, a recipient who already had to hint again.
   */
  private rehome(id: string, wasHinted: boolean): void {
    const orphaned = this.holdings.get(id);
    if (!orphaned) return;
    this.holdings.delete(id);
    const candidates = [...this.holdings.keys()].filter((pid) => this.player(pid)?.connected);
    const pool = candidates.length > 0 ? candidates : [...this.holdings.keys()];
    const rank = (pid: string) => (this.hinted.has(pid) ? 1000 : 0) + this.holdings.get(pid)!.length;
    for (const letter of orphaned) {
      if (pool.length === 0) break;
      pool.sort((a, b) => rank(a) - rank(b));
      this.holdings.get(pool[0])!.push(letter);
      if (!wasHinted && this.stage === 'letters') this.hinted.delete(pool[0]);
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

  private requireOwner(id: string): void {
    this.requirePlayer(id);
    if (id !== this.ownerId()) throw new GameError('not_allowed', 'Only the room owner can do that.');
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
