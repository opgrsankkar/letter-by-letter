import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  CODE_ALPHABET,
  LIMITS,
  POINTS,
  cleanCode,
  cleanName,
  cleanWord,
  type PlayerView,
  type RoundSummary,
  type GuessKind,
  type View,
} from '../shared/protocol.ts';
import { CATEGORIES, drawWords } from '../shared/words.ts';
import { storeName, storedName, useGame, type Game } from './connection.ts';
import {
  ConfirmButton,
  Countdown,
  PlayerChip,
  QrCode,
  Scoreboard,
  Sheet,
  TEAM_NAME,
  Tile,
  TileWord,
  TeamDot,
  useWakeLock,
  useWaited,
  SLOW_MS,
} from './ui.tsx';

export function App() {
  const game = useGame();
  const { view, status, toasts } = game;
  useWakeLock(view !== null && view.phase !== 'lobby');

  let screen;
  if (status === 'replaced') screen = <Replaced onReclaim={game.reclaim} />;
  else if (!view && game.resuming) screen = <Splash text="Finding your seat…" />;
  else if (!view) screen = <Home game={game} />;
  else screen = <Table game={game} view={view} />;

  return (
    <>
      {screen}
      {status === 'offline' && <div class="banner">Reconnecting…</div>}
      <div class="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class="toast">
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}

function Splash({ text }: { text: string }) {
  return (
    <main class="screen center">
      <TileWord word="LBL" size="lg" />
      <p class="muted">{text}</p>
    </main>
  );
}

function Replaced({ onReclaim }: { onReclaim: () => void }) {
  return (
    <main class="screen center">
      <h1 class="display">Open elsewhere</h1>
      <p class="muted">Your seat was picked up in another tab or device.</p>
      <button class="btn primary" onClick={onReclaim}>
        Play here instead
      </button>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Home: create or join
// ---------------------------------------------------------------------------

function Home({ game }: { game: Game }) {
  const linked = useMemo(() => cleanCode(location.pathname.match(/^\/r\/([^/]+)/)?.[1] ?? ''), []);
  const [name, setName] = useState(storedName);
  const [code, setCode] = useState(linked ?? '');
  const [joining, setJoining] = useState(linked !== null);
  const validName = cleanName(name);
  const validCode = cleanCode(code);

  const go = (kind: 'create' | 'join') => {
    if (!validName) return;
    storeName(validName);
    if (kind === 'create') game.send({ type: 'create', name: validName });
    else if (validCode) game.send({ type: 'join', code: validCode, name: validName });
  };

  return (
    <main class="screen home">
      <header class="hero">
        <div class="hero-tiles" aria-label="Letter by Letter">
          <TileWord word="LETTER" size="lg" stagger={70} />
          <span class="hero-by">
            <TileWord word="BY" size="md" stagger={70} tone="ink" />
          </span>
          <TileWord word="LETTER" size="lg" stagger={70} />
        </div>
        <p class="lede">A word party game for the people in the room. One person knows the word; everyone else holds a few of its letters.</p>
      </header>

      <form
        class="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          go(joining ? 'join' : 'create');
        }}
      >
        <label class="field">
          <span class="field-label">Your name</span>
          <input
            name="name"
            value={name}
            maxLength={LIMITS.nameMax}
            autoComplete="nickname"
            placeholder="e.g. Asha"
            onInput={(e) => setName(e.currentTarget.value)}
          />
          {!validName && <span class="field-hint">Add your name to start or join a room.</span>}
        </label>

        {joining ? (
          <>
            <label class="field">
              <span class="field-label">Room code</span>
              <input
                name="code"
                class="code-input"
                value={code}
                maxLength={4}
                autoCapitalize="characters"
                autoComplete="off"
                spellcheck={false}
                placeholder="ABCD"
                onInput={(e) =>
                  setCode(
                    e.currentTarget.value
                      .toUpperCase()
                      .split('')
                      .filter((c) => CODE_ALPHABET.includes(c))
                      .join(''),
                  )
                }
              />
            </label>
            <button class="btn primary" type="submit" disabled={!validName || !validCode}>
              Join room
            </button>
            <button class="btn link" type="button" onClick={() => setJoining(false)}>
              Start a new room instead
            </button>
          </>
        ) : (
          <>
            <button class="btn primary" type="submit" disabled={!validName}>
              Start a new room
            </button>
            <button class="btn ghost" type="button" onClick={() => setJoining(true)}>
              I have a room code
            </button>
          </>
        )}
      </form>

      <HowToPlay />
    </main>
  );
}

function HowToPlay() {
  return (
    <details class="howto">
      <summary>How to play</summary>
      <ol>
        <li>Everyone joins on their phone and splits into two teams, Ember and Tide.</li>
        <li>Each round one player gives the clues. They pick a secret word.</li>
        <li>The word's letters are shuffled and dealt to everyone else, a few each.</li>
        <li>
          <strong>Letter round:</strong> holders take turns, in the order on screen, hinting at their letters out loud
          without saying them. For an E you might say “my letter is the most common one in English”. The clue-giver stays
          quiet. Anyone can shout a guess at any time: a correct guess is worth {POINTS.letters} points if you had already
          hinted your own letters, otherwise {POINTS.clue}.
        </li>
        <li>
          <strong>Word round:</strong> when everyone has hinted, the clue-giver may clue the whole word. A guess is now worth{' '}
          {POINTS.clue} point.
        </li>
        <li>
          The clue-giver taps whoever said it first. They score {POINTS.hostClue} if their word needed the word clue, or{' '}
          {POINTS.hostLetters} if it was guessed from letter hints, so pick something tricky but gettable.
        </li>
      </ol>
    </details>
  );
}

// ---------------------------------------------------------------------------
// In a room
// ---------------------------------------------------------------------------

function Table({ game, view }: { game: Game; view: View }) {
  const [sheet, setSheet] = useState(false);
  const me = view.players.find((p) => p.id === view.you)!;
  const host = view.players.find((p) => p.id === view.hostId) ?? null;

  let body;
  switch (view.phase) {
    case 'lobby':
      body = <Lobby game={game} view={view} />;
      break;
    case 'choosing':
      body = view.hostId === view.you ? <Choose game={game} view={view} /> : <Waiting game={game} view={view} host={host} />;
      break;
    case 'playing':
      body = view.hostId === view.you ? <HostPlay game={game} view={view} /> : <HolderPlay game={game} view={view} host={host} />;
      break;
    case 'reveal':
      body = <Reveal game={game} view={view} />;
      break;
  }

  return (
    <main class={`screen table phase-${view.phase} team-${me.team}`}>
      <div class="table-body" inert={sheet || undefined}>
        <header class="topbar">
          <button
            class="room-pill"
            onClick={() => {
              document.dispatchEvent(new Event(HIDE_SECRETS));
              setSheet(true);
            }}
            aria-label={`Room ${view.code}: invite, teams and settings`}>
            <span class="room-pill-code">{view.code}</span>
            <span class="room-pill-menu" aria-hidden="true">
              ⋯
            </span>
          </button>
          {view.phase !== 'lobby' && <span class="round-label">Round {view.round}</span>}
          <Scoreboard scores={view.scores} compact />
        </header>
        {body}
      </div>
      <RoomSheet open={sheet} onClose={() => setSheet(false)} game={game} view={view} />
    </main>
  );
}

const KIND_LABEL: Record<GuessKind, string> = {
  letters: 'From letter hints, after their own hint',
  'before-hint': 'From letter hints, before their own hint',
  clue: 'After the word clue',
};

const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

/** Fired when something might expose the screen (e.g. opening the room menu). */
const HIDE_SECRETS = 'lbl:hide-secrets';

const nameOf = (view: View, id: string | null | undefined) => view.players.find((p) => p.id === id) ?? null;
const pts = (n: number) => `${n} pt${n === 1 ? '' : 's'}`;

function inviteUrl(code: string): string {
  return `${location.origin}/r/${code}`;
}

function Invite({ code }: { code: string }) {
  const url = inviteUrl(code);
  const [copied, setCopied] = useState(false);
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Letter by Letter', text: `Join room ${code}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* dismissed */
    }
  };
  return (
    <div class="invite">
      <QrCode text={url} />
      <div class="invite-side">
        <span class="field-label">Room code</span>
        <TileWord word={code} stagger={40} fit={{ max: 40, inset: 206 }} />
        <button class="btn ghost small" onClick={share}>
          {copied ? 'Link copied' : 'Share link'}
        </button>
      </div>
    </div>
  );
}

function TeamColumns({ view, showScores, totals }: { view: View; showScores?: boolean; totals?: boolean }) {
  return (
    <div class="teams">
      {(['ember', 'tide'] as const).map((team) => {
        const members = view.players.filter((p) => p.team === team);
        return (
          <section key={team} class={`team-col team-${team}`}>
            <h3>
              <TeamDot team={team} /> {TEAM_NAME[team]}
              {totals && (
                <span class="team-score" aria-label={`${pts(view.scores[team])}`}>
                  {view.scores[team]}
                </span>
              )}
            </h3>
            <ul>
              {members.map((p) => (
                <li key={p.id}>
                  <PlayerChip
                    player={p}
                    you={p.id === view.you}
                    owner={view.phase === 'lobby' && p.id === view.ownerId}
                    host={(view.phase === 'choosing' || view.phase === 'playing') && p.id === view.hostId}
                    trailing={showScores && p.score > 0 ? <span class="chip-score">{pts(p.score)}</span> : undefined}
                  />
                </li>
              ))}
              {members.length === 0 && <li class="muted small">Nobody yet</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ScoringStrip() {
  return (
    <ul class="scoring" aria-label="Scoring">
      <li>
        <strong>+{POINTS.letters}</strong> guessed from letter hints, once you’ve hinted yours
      </li>
      <li>
        <strong>+{POINTS.clue}</strong> guessed after the word clue
      </li>
      <li>
        <strong>+{POINTS.hostClue}</strong> clue-giver, if the word needed their clue (+{POINTS.hostLetters} if guessed from letter hints)
      </li>
    </ul>
  );
}

function FinalScores({ view }: { view: View }) {
  const { ember, tide } = view.scores;
  const winner = ember === tide ? null : ember > tide ? 'ember' : 'tide';
  const ranked = [...view.players].sort((a, b) => b.score - a.score);
  return (
    <section class="card stack final">
      <span class="kicker">Final scores</span>
      <h1 class={`display${winner ? ` name team-${winner}` : ''}`}>
        {winner ? `${TEAM_NAME[winner]} wins!` : "It's a tie!"}
      </h1>
      <Scoreboard scores={view.scores} />
      <LastRecap view={view} />
      <ol class="standings">
        {ranked.map((p) => (
          <li key={p.id}>
            <PlayerChip player={p} you={p.id === view.you} />
            <span class="chip-score">{pts(p.score)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Lobby({ game, view }: { game: Game; view: View }) {
  const here = view.players.filter((p) => p.connected).length;
  const short = Math.max(0, LIMITS.minPlayers - here);
  const isOwner = view.you === view.ownerId;
  const owner = nameOf(view, view.ownerId);
  const label = view.ended ? 'Start a new game' : view.round > 0 ? 'Play on' : 'Start the game';

  return (
    <div class="stack-lg">
      {view.ended && <FinalScores view={view} />}

      <section class="card">
        <h2 class="display small">{view.ended ? 'Play again?' : 'Gather round'}</h2>
        <p class="muted">
          {view.ended ? 'Same room, same code. Newcomers can still join.' : 'Everyone scans this or opens the link on their own phone.'}
        </p>
        <Invite code={view.code} />
      </section>

      <section class="card stack">
        <TeamColumns view={view} showScores={view.round > 0 && !view.ended} totals={view.round > 0 && !view.ended} />
        <div class="row">
          <button class="btn ghost small" onClick={() => game.send({ type: 'switch-team' })}>
            Switch my team
          </button>
          {isOwner && (
            <button class="btn ghost small" onClick={() => game.send({ type: 'shuffle-teams' })}>
              Shuffle teams
            </button>
          )}
        </div>
      </section>

      <section class="card stack">
        {isOwner ? <TimerPicker game={game} view={view} /> : <TimerSummary view={view} />}
        <ScoringStrip />
      </section>

      <div class="dock">
        {isOwner ? (
          <button class="btn primary big" disabled={short > 0} onClick={() => game.send({ type: 'start' })}>
            {short > 0 ? `Waiting for ${short} more player${short === 1 ? '' : 's'}` : label}
          </button>
        ) : (
          <p class="status-line" role="status">
            {short > 0
              ? `Waiting for ${short} more player${short === 1 ? '' : 's'}…`
              : `Waiting for ${owner?.name ?? 'the room owner'} to start…`}
          </p>
        )}
      </div>
    </div>
  );
}

function timerLabel(s: number): string {
  return s === 0 ? 'Off' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function TimerSummary({ view }: { view: View }) {
  return (
    <p class="muted small">
      Round timer: <strong>{view.timerSeconds ? timerLabel(view.timerSeconds) : 'off'}</strong>
    </p>
  );
}

function TimerPicker({ game, view }: { game: Game; view: View }) {
  return (
    <div class="stack-sm">
      <span class="field-label">Round timer</span>
      <div class="segmented" role="radiogroup" aria-label="Round timer">
        {LIMITS.timerChoices.map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={view.timerSeconds === s}
            class={view.timerSeconds === s ? 'is-on' : ''}
            onClick={() => game.send({ type: 'set-timer', seconds: s })}
          >
            {timerLabel(s)}
          </button>
        ))}
      </div>
    </div>
  );
}

function RoomSheet({ open, onClose, game, view }: { open: boolean; onClose: () => void; game: Game; view: View }) {
  const isOwner = view.you === view.ownerId;
  const inGame = view.phase !== 'lobby';
  return (
    <Sheet open={open} onClose={onClose} title={`Room ${view.code}`}>
      <div class="stack">
        <Invite code={view.code} />
        <TeamColumns view={view} showScores totals />
        {view.phase === 'lobby' ? (
          <>
            <div class="row">
              <button class="btn ghost small" onClick={() => game.send({ type: 'switch-team' })}>
                Switch my team
              </button>
              {isOwner && (
                <button class="btn ghost small" onClick={() => game.send({ type: 'shuffle-teams' })}>
                  Shuffle teams
                </button>
              )}
            </div>
            {isOwner ? <TimerPicker game={game} view={view} /> : <TimerSummary view={view} />}
          </>
        ) : (
          <p class="muted small">
            Teams and the timer are set in the lobby.{' '}
            {isOwner ? 'End the game to change them.' : `${nameOf(view, view.ownerId)?.name ?? 'The owner'} runs this room.`}
          </p>
        )}
        {isOwner && inGame && (
          <ConfirmButton
            class="btn ghost"
            label="End game & show final scores"
            confirm="Tap again to end the game for everyone"
            onConfirm={() => {
              game.send({ type: 'end' });
              onClose();
            }}
          />
        )}
        <ConfirmButton
          class="btn danger"
          label="Leave room"
          confirm="Tap again to leave (your points stay with your team)"
          onConfirm={() => {
            game.send({ type: 'leave' });
            onClose();
          }}
        />
      </div>
    </Sheet>
  );
}

/**
 * One-line memory of the previous round, for anyone who looked away. Until the
 * next word is dealt, the last clue-giver can still fix who got the credit.
 */
function LastRecap({ view, game }: { view: View; game?: Game }) {
  const [fixing, setFixing] = useState(false);
  const last = view.last;
  if (!last || !last.word) return null;
  const canFix = game && view.phase === 'choosing' && last.hostId === view.you;
  if (fixing && canFix) {
    return <FixPanel view={view} game={game} last={last} onDone={() => setFixing(false)} />;
  }
  const scored = Object.entries(last.points)
    .map(([pid, n]) => ({ p: nameOf(view, pid), n }))
    .filter((x) => x.p && x.n > 0);
  return (
    <p class="recap">
      <span class="kicker">Last round</span>
      <span>
        <strong class="recap-word">{last.word}</strong>
        {scored.length === 0
          ? ' · nobody got it'
          : scored.map(({ p, n }) => (
              <span key={p!.id}>
                {' · '}
                <span class={`name team-${p!.team}`}>{p!.name}</span> +{n}
              </span>
            ))}
      </span>
      {canFix && (
        <button class="btn link small recap-fix" onClick={() => setFixing(true)}>
          Fix scoring
        </button>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

function Choose({ game, view }: { game: Game; view: View }) {
  const [category, setCategory] = useState<string | null>(null);
  const [options, setOptions] = useState(() => drawWords(null, 3));
  const [custom, setCustom] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const holders = view.players.filter((p) => p.connected && p.id !== view.you).length;

  const redraw = (cat: string | null) => {
    setCategory(cat);
    setOptions(drawWords(cat, 3));
    setPicked(null);
  };

  const word = cleanWord(custom.trim() ? custom : (picked ?? ''));
  const customInvalid = custom.trim() !== '' && word === null;

  return (
    <div class="stack-lg">
      <LastRecap view={view} game={game} />
      <section class="intro">
        <span class="kicker">Your turn to give clues</span>
        <h1 class="display">Pick a secret word</h1>
        <p class="muted">
          Only you see it. Its letters go to the other {holders} players.
        </p>
        <p class="picker-scoring">
          You score <strong>+{POINTS.hostClue}</strong> if it needs your word clue, <strong>+{POINTS.hostLetters}</strong> if
          letter hints are enough. Want a challenge? Try <em>Tricky</em>.
        </p>
      </section>

      <section class="card stack">
        <div class="chips-scroll" role="tablist" aria-label="Category">
          <button role="tab" aria-selected={category === null} class={`pill${category === null ? ' is-on' : ''}`} onClick={() => redraw(null)}>
            Anything
          </button>
          {CATEGORIES.map((c) => (
            <button key={c.id} role="tab" aria-selected={category === c.id} class={`pill${category === c.id ? ' is-on' : ''}`} onClick={() => redraw(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        <div class="options">
          {options.map((w) => {
            const on = picked === w && !custom;
            return (
              <button
                key={w}
                class={`option${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => {
                  setPicked(w);
                  setCustom('');
                }}
              >
                {w.toUpperCase()}
              </button>
            );
          })}
          <button class="option reroll" onClick={() => redraw(category)} aria-label="Draw three new words">
            ↻ New words
          </button>
        </div>
        <label class="field">
          <span class="field-label">Or type your own</span>
          <input
            value={custom}
            maxLength={LIMITS.wordMax + 4}
            autoComplete="off"
            autoCapitalize="characters"
            spellcheck={false}
            placeholder="Secret word"
            onInput={(e) => setCustom(e.currentTarget.value)}
          />
          {customInvalid && (
            <span class="field-hint is-bad">
              {LIMITS.wordMin}–{LIMITS.wordMax} letters, A to Z only.
            </span>
          )}
        </label>
        {word && (
          <div class="preview">
            <TileWord word={word} stagger={25} fit={{ max: 44, inset: 70 }} />
          </div>
        )}
      </section>

      <div class="dock">
        <button class="btn primary big" disabled={!word} onClick={() => word && game.send({ type: 'deal', word })}>
          {word ? `Deal ${word.length} letters` : 'Tap a word above, or type one'}
        </button>
        <button class="btn link" onClick={() => game.send({ type: 'pass' })}>
          Pass: let someone else give clues
        </button>
      </div>
    </div>
  );
}

function Waiting({ game, view, host }: { game: Game; view: View; host: PlayerView | null }) {
  const waited = useWaited(view.waitingSince, game.skew);
  return (
    <div class="stack-lg">
      <LastRecap view={view} game={game} />
      <section class="intro center">
        <div class="shuffle-tiles" aria-hidden="true">
          <Tile letter="?" size="lg" />
          <Tile letter="?" size="lg" />
          <Tile letter="?" size="lg" />
        </div>
        <h1 class="display">
          {host ? (
            <>
              <span class={`name team-${host.team}`}>{host.name}</span> is choosing a word
            </>
          ) : (
            'Choosing a word'
          )}
        </h1>
        <p class="muted">
          Your letters will appear here in a moment.
          {view.round === 1 && ' Clue-givers alternate between teams, and everyone gets a turn.'}
        </p>
      </section>
      {waited > SLOW_MS && host?.connected && (
        <p class="muted small center">
          Taking a while? Any word will do, {host.name}. You can also tap “Pass” to let someone else give clues.
        </p>
      )}
      <HostAwayNotice game={game} host={host} />
      <section class="card">
        <TeamColumns view={view} showScores />
      </section>
    </div>
  );
}

function HostAwayNotice({ game, host }: { game: Game; host: PlayerView | null }) {
  if (host?.connected !== false) return null;
  return (
    <div class="notice">
      <span>{host.name}'s phone dropped off. Wait for them, or move on.</span>
      <button class="btn small" onClick={() => game.send({ type: 'pass' })}>
        Skip their turn
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

/** Hinting order with who is done, who is up now, and who is next. */
function hintQueue(view: View) {
  const order = view.hintOrder
    .map((id) => nameOf(view, id))
    .filter((p): p is PlayerView => p !== null);
  const pending = order.filter((p) => p.connected && !view.hinted.includes(p.id));
  return { order, pending, current: pending[0] ?? null };
}

function HintOrder({ view }: { view: View }) {
  const { order, current } = hintQueue(view);
  return (
    <ol class="hint-order" aria-label="Hinting order">
      {order.map((p) => {
        const done = view.hinted.includes(p.id);
        const now = current?.id === p.id;
        return (
          <li key={p.id} class={`${done ? 'is-done' : ''}${now ? ' is-now' : ''}${p.connected ? '' : ' is-away'}`}>
            <TeamDot team={p.team} />
            <span>{p.id === view.you ? 'You' : p.name}</span>
            {done && <span aria-label="done"> ✓</span>}
            {now && <span class="sr-only"> (hinting now)</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** What a guess by this player is worth right now. */
function guessValue(view: View, p: PlayerView): number {
  if (view.stage !== 'letters') return POINTS.clue;
  return p.tileCount === 0 || view.hinted.includes(p.id) ? POINTS.letters : POINTS.clue;
}

function StageBanner({ view, host, skew }: { view: View; host: PlayerView | null; skew: number }) {
  const { current } = hintQueue(view);
  const slow = useWaited(view.waitingSince, skew) > SLOW_MS;
  const clueGiver = host ? (
    <>
      Clues: <span class={`name team-${host.team}`}>{host.name}</span>
    </>
  ) : null;
  if (view.stage === 'letters') {
    const mine = current?.id === view.you;
    return (
      <div class={`stage stage-letters${mine ? ' is-mine' : ''}`} role="status">
        <span class="stage-step">Stage 1</span>
        <div>
          <strong>{mine ? 'Your turn to hint' : current ? `${current.name} is hinting` : 'Everyone has hinted'}</strong>
          <span>
            {current ? `Letter hints, in order. Guesses score +${POINTS.letters} once you've hinted.` : `${host?.name ?? 'The clue-giver'} can start the word clue.`}
          </span>
          <span class="stage-meta">{clueGiver}</span>
          {slow && current && !mine && host && (
            <span class="stage-nudge">
              Taking a while? If {current.name} has said their hints, {host.name} can tap “{current.name}’s done”.
            </span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div class="stage stage-clue" role="status">
      <span class="stage-step">Stage 2</span>
      <div>
        <strong>Word clue</strong>
        <span>
          {host ? `${host.name} is cluing the whole word.` : 'The whole word can be clued now.'} Guesses score +{POINTS.clue}.
        </span>
      </div>
    </div>
  );
}

function HolderPlay({ game, view, host }: { game: Game; view: View; host: PlayerView | null }) {
  const letters = view.letters ?? [];
  const [shown, setShown] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dealtKey = letters.join('');
  const { current, order } = hintQueue(view);
  const iHinted = view.hinted.includes(view.you);
  const myTurn = current?.id === view.you;
  const myIndex = order.findIndex((p) => p.id === view.you);
  const laterHinted = order.slice(myIndex + 1).some((p) => view.hinted.includes(p.id));
  const waited = useWaited(view.waitingSince, game.skew);
  const slowTurn = myTurn && view.stage === 'letters' && waited > SLOW_MS;
  useEffect(() => {
    if (slowTurn && navigator.userActivation?.hasBeenActive) navigator.vibrate?.([80, 80, 80]);
  }, [slowTurn]);

  // A new hand buzzes the phone so nobody misses it; so does your turn to hint.
  useEffect(() => {
    if (letters.length > 0 && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(60);
    setShown(false);
  }, [dealtKey]);
  useEffect(() => {
    if (myTurn && navigator.userActivation?.hasBeenActive) navigator.vibrate?.([40, 60, 40]);
  }, [myTurn]);
  useEffect(() => {
    const hide = () => setShown(false);
    document.addEventListener(HIDE_SECRETS, hide);
    return () => document.removeEventListener(HIDE_SECRETS, hide);
  }, []);

  const toggle = () => {
    clearTimeout(hideTimer.current);
    setShown((s) => {
      if (!s) hideTimer.current = setTimeout(() => setShown(false), 8000);
      return !s;
    });
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const handLabel = shown
    ? `Your letters: ${letters.join(', ')}. Tap to hide.`
    : `Your ${letters.length} letter${letters.length === 1 ? '' : 's'}, face down. Tap to peek.`;

  return (
    <div class="stack-lg">
      <Countdown deadline={view.deadline} skew={game.skew} total={view.timerSeconds} />
      <StageBanner view={view} host={host} skew={game.skew} />
      {letters.length > 0 ? (
        <section class="hand-wrap">
          <button class={`hand${shown ? ' is-shown' : ''}`} onClick={toggle} aria-pressed={shown} aria-label={handLabel}>
            <span class="tile-row" aria-hidden="true">
              {letters.map((l, i) => (
                <Tile key={i} letter={l} size="xl" hidden={!shown} delay={i * 80} />
              ))}
            </span>
            <span class="hand-hint" aria-hidden="true">
              {shown ? 'Tap to hide · hides itself after 8 seconds' : 'Your letters · tap to peek'}
            </span>
          </button>
          {view.stage === 'letters' &&
            (iHinted ? (
              <button class="btn done" aria-pressed={true} disabled={laterHinted} onClick={() => game.send({ type: 'hinted', done: false })}>
                ✓ Hinted{laterHinted ? '' : ' (tap to undo)'}
              </button>
            ) : myTurn ? (
              <>
                {slowTurn && <p class="your-turn is-urgent">Everyone is waiting on you.</p>}
                <p class="your-turn">
                  Hint at {letters.length === 1 ? 'your letter' : `each of your ${letters.length} letters`} out loud, without saying{' '}
                  {letters.length === 1 ? 'it' : 'them'}. Then tap:
                </p>
                <button class="btn primary big" onClick={() => game.send({ type: 'hinted', done: true })}>
                  I’ve hinted my letters
                </button>
              </>
            ) : (
              <p class="muted center">
                {(() => {
                  const before = order[myIndex - 1];
                  const pos = `You’re ${ordinal(myIndex + 1)} of ${order.length}`;
                  const now = current ? ` ${current.name} is hinting now.` : '';
                  return `${pos}, right after ${before ? before.name : 'the others'}.${now} Listen, and shout out the word if you get it.`;
                })()}
              </p>
            ))}
          {view.stage === 'clue' && <p class="muted center">Listen for the word clue, and keep guessing out loud.</p>}
        </section>
      ) : (
        <section class="intro center">
          <h1 class="display small">No letters for you this round</h1>
          <p class="muted">
            {view.hintOrder.length > 0 && view.hintOrder.length < view.players.length - 1
              ? 'Short word, big table: not everyone gets a letter.'
              : 'You joined after the deal.'}{' '}
            Listen to the hints and shout out the word. A guess now is worth +{guessValue(view, view.players.find((p) => p.id === view.you)!)}.
          </p>
        </section>
      )}
      <HostAwayNotice game={game} host={host} />
      {view.stage === 'letters' && order.length > 0 && (
        <section class="card stack-sm">
          <span class="field-label">Hinting order</span>
          <HintOrder view={view} />
        </section>
      )}
    </div>
  );
}

function GuessButtons({ view, onPick, highlight }: { view: View; onPick: (id: string | null) => void; highlight?: string | null }) {
  const live = view.phase === 'playing';
  return (
    <div class="guess-grid">
      {view.players
        .filter((p) => p.id !== view.you)
        .map((p) => {
          const value = guessValue(view, p);
          return (
            <button
              key={p.id}
              class={`guess team-${p.team}${highlight === p.id ? ' is-on' : ''}`}
              onClick={() => onPick(p.id)}
              aria-pressed={highlight !== undefined ? highlight === p.id : undefined}
              aria-label={live ? `${p.name} guessed it, plus ${value}` : `${p.name} guessed it`}
            >
              <TeamDot team={p.team} />
              <span class="guess-name">{p.name}</span>
              {live && <span class="guess-pts">+{value}</span>}
            </button>
          );
        })}
    </div>
  );
}

function useSessionFlag(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  return [
    value,
    (v: boolean) => {
      setValue(v);
      try {
        sessionStorage.setItem(key, v ? '1' : '0');
      } catch {
        /* ignore */
      }
    },
  ];
}

function HostPlay({ game, view }: { game: Game; view: View }) {
  const word = view.word ?? '';
  const holdings = view.holdings ?? {};
  const [confirmNobody, setConfirmNobody] = useState(false);
  // Remembered across a refresh, so a reload never flashes the word.
  const [hideWord, setHideWord] = useSessionFlag('lbl.hideWord');
  const { pending, current } = hintQueue(view);
  const allHinted = view.stage === 'letters' && !current;
  const hostWaited = useWaited(view.waitingSince, game.skew);
  // Nudge the clue-giver the moment the table is ready for their word clue.
  useEffect(() => {
    if (allHinted && navigator.userActivation?.hasBeenActive) navigator.vibrate?.([40, 60, 40]);
  }, [allHinted]);

  useEffect(() => {
    const hide = () => setHideWord(true);
    document.addEventListener(HIDE_SECRETS, hide);
    return () => document.removeEventListener(HIDE_SECRETS, hide);
  }, []);

  return (
    <div class="stack-lg">
      <Countdown deadline={view.deadline} skew={game.skew} total={view.timerSeconds} />
      <section class="intro center">
        <span class="kicker">Your secret word</span>
        <button
          class="word-toggle"
          onClick={() => setHideWord(!hideWord)}
          aria-pressed={hideWord}
          aria-label={hideWord ? 'Secret word hidden. Tap to show.' : `Secret word ${word}. Tap to hide.`}
        >
          <span class="tile-row is-fit" aria-hidden="true">
            {word.split('').map((ch, i) => (
              <Tile
                key={i}
                letter={ch}
                hidden={hideWord}
                tone="ink"
                delay={i * 40}
                fitSize={`min(56px, calc((min(100vw, 560px) - ${32 + (word.length - 1) * 6}px) / ${word.length}))`}
              />
            ))}
          </span>
          <span class="hand-hint" aria-hidden="true">
            {hideWord ? 'Tap to show' : 'Tap to hide from nosy neighbours'}
          </span>
        </button>
      </section>

      <div class={`host-status${view.stage === 'clue' ? ' is-live' : !current ? ' is-ready' : ''}`} role="status">
        <span class="stage-step">{view.stage === 'letters' ? 'Stage 1' : 'Stage 2'}</span>
        <span class="host-status-text">
          {view.stage === 'letters'
            ? current
              ? `Stay quiet. ${current.name} is hinting.`
              : 'Everyone has hinted.'
            : 'Your turn: clue the whole word out loud.'}
        </span>
        {view.stage === 'letters' &&
          (current ? (
            <button
              class={`btn small ${hostWaited > SLOW_MS ? 'primary' : 'ghost'}`}
              onClick={() => game.send({ type: 'advance-hint' })}
            >
              {current.name}’s done →
            </button>
          ) : (
            <button class="btn primary small" onClick={() => game.send({ type: 'unlock' })}>
              Start word clue
            </button>
          ))}
        {view.stage === 'letters' && !current && (
          <span class="host-status-note">Tap it before you say your clue, so guesses score right.</span>
        )}
      </div>

      <section class="card stack guess-card">
        <div>
          <h2 class="display small">Heard the word?</h2>
          <p class="muted small">
            Tap whoever said it first. +{POINTS.letters} means they had already hinted; if they guessed before hinting, you
            can fix it on the next screen.
          </p>
        </div>
        <GuessButtons view={view} onPick={(id) => game.send({ type: 'award', playerId: id })} />
        {confirmNobody ? (
          <div class="row">
            <button class="btn small danger" onClick={() => game.send({ type: 'award', playerId: null })}>
              Yes, reveal the word
            </button>
            <button class="btn small ghost" onClick={() => setConfirmNobody(false)}>
              Keep playing
            </button>
          </div>
        ) : (
          <button class="btn link small" onClick={() => setConfirmNobody(true)}>
            Nobody can get it? Reveal the word
          </button>
        )}
      </section>

      {view.stage === 'letters' ? (
        <section class="card stack stage-card">
          <div>
            <span class="kicker">Step 1 of 2 · letter hints</span>
            <h2 class="display small">{current ? 'Stay quiet for now' : 'Everyone has hinted'}</h2>
            <p class="muted">
              {current
                ? `${current.name} is hinting. Holders go in this order:`
                : `Give them a moment to guess. If it needs your clue, you score +${POINTS.hostClue}.`}
            </p>
          </div>
          {current && <HintOrder view={view} />}
          {pending.length > 0 && (
            <ConfirmButton
              class="btn ghost small"
              label="Someone stuck? Start my clue early"
              confirm={`Tap again: you’ll only score +${POINTS.hostLetters}`}
              onConfirm={() => game.send({ type: 'unlock' })}
            />
          )}
        </section>
      ) : (
        <section class="card stack stage-card is-live">
          <div>
            <span class="kicker">Step 2 of 2 · your turn</span>
            <h2 class="display small">Clue the whole word</h2>
            <p class="muted">
              Guesses are now worth +{POINTS.clue}. You score +{view.early ? POINTS.hostLetters : POINTS.hostClue} when someone gets it.
            </p>
          </div>
        </section>
      )}

      <section class="card">
        <span class="field-label">Who holds what</span>
        <ul class="holders">
          {Object.entries(holdings).map(([pid, letters]) => {
            const p = nameOf(view, pid);
            return (
              <li key={pid}>
                {p ? (
                  <PlayerChip
                    player={p}
                    trailing={view.stage === 'letters' && view.hinted.includes(pid) ? <span class="chip-tag chip-done">hinted</span> : undefined}
                  />
                ) : (
                  <span class="chip">Someone</span>
                )}
                <span class="tile-row" aria-hidden={hideWord || undefined}>
                  {letters.map((l, i) => (
                    <Tile key={i} letter={l} size="sm" hidden={hideWord} />
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

function PointsLine({ view, last }: { view: View; last: RoundSummary }) {
  const entries = Object.entries(last.points).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  const why = (pid: string, n: number) => {
    if (pid === last.hostId) return n === POINTS.hostClue ? ' clue-giver: the word needed their clue' : ' clue-giver: for choosing the word';
    return ' ' + KIND_LABEL[last.kind ?? 'clue'].toLowerCase();
  };
  return (
    <ul class="points-line">
      {entries.map(([pid, n]) => {
        const p = nameOf(view, pid);
        if (!p) return null;
        return (
          <li key={pid} class={`team-${p.team}`}>
            <TeamDot team={p.team} /> {p.name} <strong>+{n}</strong>
            <span class="muted small">{why(pid, n)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The last clue-giver's correction panel: who guessed, and when. */
function FixPanel({ view, game, last, onDone }: { view: View; game: Game; last: RoundSummary; onDone: () => void }) {
  const [kind, setKind] = useState<GuessKind>(last.kind ?? (last.stage === 'clue' ? 'clue' : 'letters'));
  return (
    <section class="card stack">
      <h2 class="display small">Who really guessed {last.word}?</h2>
      <div class="kind-options" role="radiogroup" aria-label="How was it guessed?">
        {(['letters', 'before-hint', 'clue'] as const).map((k) => (
          <button key={k} role="radio" aria-checked={kind === k} class={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>
            <span>{KIND_LABEL[k]}</span>
            <strong>+{k === 'letters' ? POINTS.letters : POINTS.clue}</strong>
          </button>
        ))}
      </div>
      <p class="muted small">Then tap who said it first. +{POINTS.letters} only counts for someone who had hinted their own letters.</p>
      <GuessButtons
        view={view}
        highlight={last.guesserId}
        onPick={(id) => {
          game.send({ type: 'award', playerId: id, kind });
          onDone();
        }}
      />
      <div class="row">
        <button
          class="btn small ghost"
          onClick={() => {
            game.send({ type: 'award', playerId: null });
            onDone();
          }}
        >
          Nobody got it
        </button>
        <button class="btn small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function Reveal({ game, view }: { game: Game; view: View }) {
  const [fixing, setFixing] = useState(false);
  const last = view.last;
  if (!last) return null;
  const guesser = nameOf(view, last.guesserId);
  const host = nameOf(view, last.hostId);
  const isLastHost = view.you === last.hostId;
  const canAdvance = isLastHost || !host?.connected;
  const isOwner = view.you === view.ownerId;

  return (
    <div class="stack-lg">
      <section class="intro center reveal-hero">
        <span class="kicker">The word was</span>
        {last.word ? <TileWord word={last.word} stagger={90} fit={{ max: 56, inset: 32 }} /> : <span class="muted">(never chosen)</span>}
        {guesser ? (
          <p class={`verdict team-${guesser.team}`}>
            <strong>{guesser.name}</strong> got it{' '}
            {last.kind === 'letters' ? 'from the letters alone!' : last.kind === 'before-hint' ? 'from the letters, before hinting' : 'after the word clue'}
          </p>
        ) : (
          <p class="verdict">Nobody got it this time</p>
        )}
        <PointsLine view={view} last={last} />
        {host && !isLastHost && last.word && (
          <p class="muted small">Not who said it first? Tell {host.name}: they can fix it until the next word is dealt.</p>
        )}
      </section>

      {isLastHost && last.word && (fixing ? (
        <FixPanel view={view} game={game} last={last} onDone={() => setFixing(false)} />
      ) : (
        <button class="btn ghost fix-btn" onClick={() => setFixing(true)}>
          Table disagrees? Fix who got it
        </button>
      ))}

      <div class="dock">
        {canAdvance ? (
          <>
            <button class="btn primary big" onClick={() => game.send({ type: 'next' })}>
              Next round
            </button>
            {isLastHost && <p class="muted small center">You can still fix the credit until the next word is dealt.</p>}
          </>
        ) : (
          <p class="status-line" role="status">
            Waiting for {host?.name ?? 'the clue-giver'} to start the next round…
          </p>
        )}
        {isOwner && (
          <ConfirmButton
            class="btn ghost small"
            label="That’s the last round? End game & show final scores"
            confirm="Tap again to end the game for everyone"
            onConfirm={() => game.send({ type: 'end' })}
          />
        )}
      </div>

      {Object.keys(last.holdings).length > 0 && (
        <section class="card">
          <span class="field-label">Who held what</span>
          <ul class="holders">
            {Object.entries(last.holdings).map(([pid, letters]) => {
              const p = nameOf(view, pid);
              return (
                <li key={pid}>
                  {p ? <PlayerChip player={p} /> : <span class="chip is-away">Left</span>}
                  <span class="tile-row">
                    {letters.map((l, i) => (
                      <Tile key={i} letter={l} size="sm" />
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section class="card stack">
        <Scoreboard scores={view.scores} />
        <TeamColumns view={view} showScores />
      </section>

    </div>
  );
}
