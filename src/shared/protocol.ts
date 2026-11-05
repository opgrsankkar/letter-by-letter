// Wire protocol shared by the server and the browser client.
//
// Every message is a small JSON object with a `type` discriminator. The server
// never broadcasts one shared state; it sends each player a personalised
// `View`, so secrets (the word, a holder's letters) only ever leave the server
// addressed to the people allowed to see them.

export const TEAMS = ['ember', 'tide'] as const;
export type Team = (typeof TEAMS)[number];

export type Phase = 'lobby' | 'choosing' | 'playing' | 'reveal';

/**
 * A round is played in two stages.
 *
 * 1. Letter hints: holders hint in a dealt order, one after another, as if
 *    going round the table. A correct guess is worth POINTS.letters if the
 *    guesser had already hinted their own letters (otherwise POINTS.clue).
 * 2. Word clue: once everyone has hinted, the clue-giver may clue the whole
 *    word. Guesses are worth POINTS.clue.
 *
 * The clue-giver scores POINTS.hostClue if their word needed the word clue
 * (a word the letters alone could not crack), or POINTS.hostLetters if the
 * letters were enough or they opened the word clue before everyone hinted.
 */
export type Stage = 'letters' | 'clue';
export const POINTS = { letters: 2, clue: 1, hostLetters: 1, hostClue: 2 } as const;

export const LIMITS = {
  nameMax: 16,
  wordMin: 3,
  wordMax: 20,
  minPlayers: 3,
  maxPlayers: 10,
  timerChoices: [0, 60, 90, 120, 180] as readonly number[],
} as const;

/** Room codes avoid look-alike characters (0/O, 1/I/L, 5/S, 2/Z, 8/B). */
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
export const CODE_LENGTH = 4;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------
export type ClientMessage =
  | { type: 'create'; name: string }
  | { type: 'join'; code: string; name: string }
  | { type: 'resume'; code: string; token: string }
  | { type: 'leave' }
  | { type: 'ping' }
  | { type: 'switch-team' }
  | { type: 'shuffle-teams' }
  | { type: 'set-timer'; seconds: number }
  | { type: 'start' }
  | { type: 'deal'; word: string }
  | { type: 'pass' }
  /** Holder: "I've hinted all my letters". */
  | { type: 'hinted'; done: boolean }
  /** Clue-giver: open the word-clue stage early. */
  | { type: 'unlock' }
  /**
   * Clue-giver: who guessed (while playing), or a correction during the reveal,
   * where `stage` may also correct when the word was guessed.
   */
  | { type: 'award'; playerId: string | null; stage?: Stage }
  | { type: 'next' }
  /** Owner: finish the game and show final scores. */
  | { type: 'end' };

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------
export interface PlayerView {
  id: string;
  name: string;
  team: Team;
  score: number;
  connected: boolean;
  /** Number of letters this player holds this round (public; the letters are not). */
  tileCount: number;
}

export interface RoundSummary {
  round: number;
  word: string;
  hostId: string;
  /** null when nobody guessed or the round was passed. */
  guesserId: string | null;
  /** Stage the round had reached when it ended (null if it never started). */
  stage: Stage | null;
  /** The clue-giver opened the word clue before every holder had hinted. */
  early: boolean;
  /** Points handed out this round, by player. */
  points: Record<string, number>;
  /** playerId -> letters they held. */
  holdings: Record<string, string[]>;
}

export interface View {
  code: string;
  you: string;
  phase: Phase;
  round: number;
  hostId: string | null;
  /** Runs the room: starts games, sets the timer, shuffles teams, ends the game. */
  ownerId: string | null;
  /** True after the owner ends the game, until a new one starts. */
  ended: boolean;
  /** Stage of the round in progress (playing phase only). */
  stage: Stage | null;
  /** Holders who have finished hinting their letters (playing phase only). */
  hinted: string[];
  /** The order holders hint in (playing phase only). */
  hintOrder: string[];
  /** The clue-giver opened the word clue before everyone had hinted. */
  early: boolean;
  players: PlayerView[];
  scores: Record<Team, number>;
  timerSeconds: number;
  /** Epoch ms when the guessing clock runs out (playing phase, timer on). */
  deadline: number | null;
  /** Your letters while playing (holders only). */
  letters: string[] | null;
  /** The secret word (host only while playing; everyone during reveal). */
  word: string | null;
  /** Who holds what (host only while playing; everyone during reveal). */
  holdings: Record<string, string[]> | null;
  last: RoundSummary | null;
}

export type ErrorCode =
  | 'bad_request'
  | 'bad_name'
  | 'bad_word'
  | 'not_found'
  | 'room_full'
  | 'server_full'
  | 'not_in_room'
  | 'already_in_room'
  | 'not_allowed'
  | 'wrong_phase'
  | 'too_few_players'
  | 'rate_limited';

export type ServerMessage =
  | { type: 'joined'; code: string; token: string; playerId: string }
  /** `now` is the server clock, so clients can correct for skew when showing the timer. */
  | { type: 'view'; view: View; now: number }
  | { type: 'left' }
  | { type: 'pong' }
  | { type: 'error'; code: ErrorCode; message: string };

// ---------------------------------------------------------------------------
// Validation helpers (used by both sides so the UI can pre-validate)
// ---------------------------------------------------------------------------
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim();
  if (name.length === 0 || [...name].length > LIMITS.nameMax) return null;
  return name;
}

/** Uppercase A–Z only; spaces, hyphens and apostrophes are dropped. */
export function cleanWord(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const stripped = raw.replace(/[\s'’-]/g, '').toUpperCase();
  if (!/^[A-Z]+$/.test(stripped)) return null;
  if (stripped.length < LIMITS.wordMin || stripped.length > LIMITS.wordMax) return null;
  return stripped;
}

export function cleanCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}
