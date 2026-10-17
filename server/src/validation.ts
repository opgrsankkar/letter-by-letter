// Runtime input validation + lightweight quota helpers for the Socket.IO
// boundary.
//
// Everything a client sends is untrusted, including the acknowledgement
// callbacks. These helpers are deliberately pure (no I/O, no socket access) so
// they are trivial to reason about and to cover with unit/integration tests.

export const NAME_MAX_LENGTH = 40;
export const ROOM_CODE_LENGTH = 4;
export const WORD_MIN_LENGTH = 3;
export const WORD_MAX_LENGTH = 64;

// Room codes are exactly four uppercase base-36 characters (0-9, A-Z).
const ROOM_CODE_PATTERN = new RegExp(`^[0-9A-Z]{${ROOM_CODE_LENGTH}}$`);

// Words may contain letters and spaces only.
const WORD_PATTERN = /^[A-Za-z ]+$/;

/**
 * Trim and validate a player name.
 *
 * @returns the trimmed name, or `null` when the input is not a string, is
 *          empty/whitespace-only, or exceeds {@link NAME_MAX_LENGTH}.
 */
export function sanitizeName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > NAME_MAX_LENGTH) return null;
    return trimmed;
}

/**
 * Normalise and validate a room code. Accepts any casing and surrounding
 * whitespace, but the result must be exactly four base-36 characters.
 *
 * @returns the canonical uppercase code, or `null` when invalid.
 */
export function normalizeRoomCode(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const code = value.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(code)) return null;
    return code;
}

/**
 * Validate a submitted secret word: letters and spaces only, length
 * {@link WORD_MIN_LENGTH}..{@link WORD_MAX_LENGTH} after trimming.
 *
 * @returns the trimmed word, or `null` when invalid.
 */
export function validateWord(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (cleaned.length < WORD_MIN_LENGTH || cleaned.length > WORD_MAX_LENGTH) return null;
    if (!WORD_PATTERN.test(cleaned)) return null;
    return cleaned;
}

export interface SlidingWindowLimiter {
    /** Record one attempt. Returns `false` when the caller is over budget. */
    allow(): boolean;
}

/**
 * A simple per-key sliding-window counter. Keeps at most `max` timestamps, so
 * memory is bounded regardless of how many events a socket sends.
 *
 * `now` is injectable so tests can advance time deterministically.
 */
export function createSlidingWindowLimiter(
    max: number,
    windowMs: number,
    now: () => number = Date.now,
): SlidingWindowLimiter {
    const hits: number[] = [];
    const budget = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1;
    const window = Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 1;

    return {
        allow(): boolean {
            const t = now();
            const cutoff = t - window;
            while (hits.length > 0 && hits[0] <= cutoff) hits.shift();
            if (hits.length >= budget) return false;
            hits.push(t);
            return true;
        },
    };
}

/**
 * Parse a positive integer from an environment variable, falling back to
 * `fallback` for missing / blank / non-positive / non-numeric values.
 */
export function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return parsed;
}

/**
 * Parse a TCP port (0-65535) from an environment variable. Unlike
 * {@link positiveIntFromEnv} this allows `0`, which asks the OS for an
 * ephemeral port (used by the isolated integration tests).
 */
export function portFromEnv(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return fallback;
    return parsed;
}
