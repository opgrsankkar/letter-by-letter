// Small presentational building blocks shared by the screens.

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import type { PlayerView, Team } from '../shared/protocol.ts';

export const TEAM_NAME: Record<Team, string> = { ember: 'Ember', tide: 'Tide' };

export function Tile(props: {
  letter: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  delay?: number;
  hidden?: boolean;
  tone?: Team | 'ink';
  /** Explicit CSS size, overriding the size class. */
  fitSize?: string;
}) {
  const { letter, size = 'md', delay = 0, hidden = false, tone, fitSize } = props;
  return (
    <span
      class={`tile tile-${size}${hidden ? ' is-hidden' : ''}${tone ? ` tone-${tone}` : ''}`}
      style={fitSize ? { '--delay': `${delay}ms`, '--size': fitSize } : { '--delay': `${delay}ms` }}
      role="img"
      aria-label={hidden ? 'face-down tile' : letter}
    >
      <span class="tile-face" aria-hidden="true">
        {hidden ? '' : letter}
      </span>
      <span class="tile-back" aria-hidden="true" />
    </span>
  );
}

/**
 * A word laid out as tiles. With `fit`, tiles shrink so the whole word stays on
 * one line inside a container `inset` px narrower than the (capped) viewport.
 */
export function TileWord(props: {
  word: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  stagger?: number;
  tone?: Team | 'ink';
  fit?: { max: number; inset: number };
}) {
  const { word, size = 'md', stagger = 60, tone, fit } = props;
  const n = word.length;
  const fitSize = fit
    ? `min(${fit.max}px, calc((min(100vw, 560px) - ${fit.inset + (n - 1) * 6}px) / ${n}))`
    : undefined;
  return (
    <span class={`tile-row${fit ? ' is-fit' : ''}`} aria-label={word}>
      {word.split('').map((ch, i) => (
        <Tile key={`${i}${ch}`} letter={ch} size={size} delay={i * stagger} tone={tone} fitSize={fitSize} />
      ))}
    </span>
  );
}

/** Team marker: colour plus the team's initial, so colour is never the only signal. */
export function TeamDot({ team }: { team: Team }) {
  return (
    <span class={`team-dot team-${team}`} aria-hidden="true">
      {TEAM_NAME[team][0]}
    </span>
  );
}

export function PlayerChip(props: {
  player: PlayerView;
  you?: boolean;
  host?: boolean;
  owner?: boolean;
  trailing?: ComponentChildren;
}) {
  const { player, you, host, owner, trailing } = props;
  return (
    <span class={`chip team-${player.team}${player.connected ? '' : ' is-away'}`}>
      <TeamDot team={player.team} />
      <span class="chip-name">
        {player.name}
        <span class="sr-only">, team {TEAM_NAME[player.team]}</span>
      </span>
      {you && <span class="chip-tag">you</span>}
      {owner && (
        <span class="chip-tag chip-owner" title="Runs the room">
          ★<span class="sr-only"> runs the room</span>
        </span>
      )}
      {host && <span class="chip-tag chip-host">clues</span>}
      {!player.connected && <span class="chip-tag">away</span>}
      {trailing}
    </span>
  );
}

export function Scoreboard({ scores, compact }: { scores: Record<Team, number>; compact?: boolean }) {
  return (
    <div
      class={`scoreboard${compact ? ' is-compact' : ''}`}
      role="img"
      aria-label={`Score: Ember ${scores.ember}, Tide ${scores.tide}`}
    >
      <span class="score team-ember">
        {compact ? <TeamDot team="ember" /> : <span class="score-label">Ember</span>}
        <span class="score-value">{scores.ember}</span>
      </span>
      <span class="score-sep">:</span>
      <span class="score team-tide">
        <span class="score-value">{scores.tide}</span>
        {compact ? <TeamDot team="tide" /> : <span class="score-label">Tide</span>}
      </span>
    </div>
  );
}

export function QrCode({ text }: { text: string }) {
  const svg = renderSVG(text, { border: 1, pixelSize: 6, blackColor: '#1d1a16', whiteColor: '#fffaf0' });
  return <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Seconds left until `deadline` (server clock), ticking twice a second. */
export function useCountdown(deadline: number | null, skew: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - (now + skew)) / 1000));
}

export function Countdown({ deadline, skew, total }: { deadline: number | null; skew: number; total: number }) {
  const left = useCountdown(deadline, skew);
  if (left === null) return null;
  const pct = total > 0 ? (left / total) * 100 : 0;
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  return (
    <div class={`countdown${left === 0 ? ' is-done' : left <= 10 ? ' is-low' : ''}`} role="timer">
      <div class="countdown-bar" style={{ width: `${pct}%` }} />
      <span class="countdown-text">{left === 0 ? "Time's up" : `${mm}:${ss}`}</span>
    </div>
  );
}

export function Sheet(props: { open: boolean; onClose: () => void; title: string; children: ComponentChildren }) {
  const { open, onClose, title, children } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <section class="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header class="sheet-head">
          <h2>{title}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

/** Keep the screen awake while a game is on (phones dim mid-round otherwise). */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen');
        if (cancelled) await lock?.release();
      } catch {
        /* denied or unsupported: fine */
      }
    };
    void acquire();
    const onVisible = () => void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}

/**
 * A button that asks for a second tap instead of a browser confirm() box,
 * which some in-app browsers block or auto-dismiss.
 */
export function ConfirmButton(props: { class?: string; label: string; confirm: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 8000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      class={`${props.class ?? 'btn'}${armed ? ' is-armed' : ''}`}
      onClick={() => {
        if (armed) {
          setArmed(false);
          props.onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? props.confirm : props.label}
    </button>
  );
}

/** How long (ms) the table has been waiting on the current step, ticking every few seconds. */
export function useWaited(since: number, skew: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, now + skew - since);
}

/** After this long on one step, phones gently point at what is holding the table up. */
export const SLOW_MS = 45_000;
