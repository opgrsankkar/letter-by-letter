import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CODE_ALPHABET, LIMITS, cleanCode, cleanName, cleanWord, type PlayerView, type View } from '../shared/protocol.ts';
import { CATEGORIES, drawWords } from '../shared/words.ts';
import { storeName, storedName, useGame, type Game } from './connection.ts';
import {
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
        <li>Letter holders hint at their letters out loud, without saying them. The clue-giver hints at the whole word.</li>
        <li>Shout out guesses. The clue-giver taps whoever got it first, and that player's team scores.</li>
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
      <header class="topbar">
        <button class="room-pill" onClick={() => setSheet(true)} aria-label={`Room ${view.code}: invite and settings`}>
          <span class="room-pill-code">{view.code}</span>
          <span class="room-pill-menu" aria-hidden="true">
            ⋯
          </span>
        </button>
        {view.phase !== 'lobby' && <span class="round-label">Round {view.round}</span>}
        <Scoreboard scores={view.scores} compact />
      </header>
      {body}
      <RoomSheet open={sheet} onClose={() => setSheet(false)} game={game} view={view} />
    </main>
  );
}

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
              {totals && <span class="team-score">{view.scores[team]}</span>}
            </h3>
            <ul>
              {members.map((p) => (
                <li key={p.id}>
                  <PlayerChip
                    player={p}
                    you={p.id === view.you}
                    host={view.phase !== 'lobby' && view.phase !== 'reveal' && p.id === view.hostId}
                    trailing={showScores && p.score > 0 ? <span class="chip-score">{p.score}</span> : undefined}
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

function Lobby({ game, view }: { game: Game; view: View }) {
  const here = view.players.filter((p) => p.connected).length;
  const short = Math.max(0, LIMITS.minPlayers - here);
  return (
    <div class="stack-lg">
      <section class="card">
        <h2 class="display small">Gather round</h2>
        <p class="muted">Everyone scans this or opens the link on their own phone.</p>
        <Invite code={view.code} />
      </section>

      <section class="card stack">
        <TeamColumns view={view} showScores={view.round > 0} totals={view.round > 0} />
        <div class="row">
          <button class="btn ghost small" onClick={() => game.send({ type: 'switch-team' })}>
            Switch my team
          </button>
          <button class="btn ghost small" onClick={() => game.send({ type: 'shuffle-teams' })}>
            Shuffle teams
          </button>
        </div>
      </section>

      <section class="card stack">
        <TimerPicker game={game} view={view} />
      </section>

      <div class="dock">
        <button class="btn primary big" disabled={short > 0} onClick={() => game.send({ type: 'start' })}>
          {short > 0 ? `Waiting for ${short} more player${short === 1 ? '' : 's'}` : view.round > 0 ? 'Play on' : 'Start the game'}
        </button>
      </div>
    </div>
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
            {s === 0 ? 'Off' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}
          </button>
        ))}
      </div>
    </div>
  );
}

function RoomSheet({ open, onClose, game, view }: { open: boolean; onClose: () => void; game: Game; view: View }) {
  const between = view.phase === 'lobby' || view.phase === 'reveal';
  return (
    <Sheet open={open} onClose={onClose} title={`Room ${view.code}`}>
      <div class="stack">
        <Invite code={view.code} />
        <TeamColumns view={view} showScores totals />
        {between ? (
          <>
            <div class="row">
              <button class="btn ghost small" onClick={() => game.send({ type: 'switch-team' })}>
                Switch my team
              </button>
              <button class="btn ghost small" onClick={() => game.send({ type: 'shuffle-teams' })}>
                Shuffle teams
              </button>
            </div>
            <TimerPicker game={game} view={view} />
          </>
        ) : (
          <p class="muted small">Teams and the timer can be changed between rounds.</p>
        )}
        <button
          class="btn danger"
          onClick={() => {
            if (confirm('Leave this room? Your score stays with the room.')) {
              game.send({ type: 'leave' });
              onClose();
            }
          }}
        >
          Leave room
        </button>
      </div>
    </Sheet>
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
      <section class="intro">
        <span class="kicker">You give the clues</span>
        <h1 class="display">Pick a secret word</h1>
        <p class="muted">Only you will see it. Its letters get dealt to the other {holders} players.</p>
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
          {options.map((w) => (
            <button
              key={w}
              class={`option${picked === w && !custom ? ' is-on' : ''}`}
              onClick={() => {
                setPicked(w);
                setCustom('');
              }}
            >
              {w.toUpperCase()}
            </button>
          ))}
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
      </section>

      <div class="dock">
        {word && (
          <div class="preview">
            <TileWord word={word} stagger={25} fit={{ max: 44, inset: 32 }} />
          </div>
        )}
        <button class="btn primary big" disabled={!word} onClick={() => word && game.send({ type: 'deal', word })}>
          {word ? `Deal ${word.length} letters` : 'Choose a word'}
        </button>
        <button class="btn link" onClick={() => game.send({ type: 'pass' })}>
          Pass: let someone else give clues
        </button>
      </div>
    </div>
  );
}

function Waiting({ game, view, host }: { game: Game; view: View; host: PlayerView | null }) {
  return (
    <div class="stack-lg">
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
        <p class="muted">Your letters will appear here in a moment.</p>
      </section>
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
      <span>
        {host.name}'s phone dropped off. Wait for them, or move on.
      </span>
      <button class="btn small" onClick={() => game.send({ type: 'pass' })}>
        Skip their turn
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

function HolderPlay({ game, view, host }: { game: Game; view: View; host: PlayerView | null }) {
  const letters = view.letters ?? [];
  const [shown, setShown] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dealtKey = letters.join('');

  // A new hand buzzes the phone so nobody misses it.
  useEffect(() => {
    if (letters.length > 0 && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(60);
    setShown(false);
  }, [dealtKey]);

  const toggle = () => {
    clearTimeout(hideTimer.current);
    setShown((s) => {
      if (!s) hideTimer.current = setTimeout(() => setShown(false), 8000);
      return !s;
    });
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const others = view.players.filter((p) => p.tileCount > 0 && p.id !== view.you);

  return (
    <div class="stack-lg">
      <Countdown deadline={view.deadline} skew={game.skew} total={view.timerSeconds} />
      {letters.length > 0 ? (
        <section class="hand-wrap">
          <span class="kicker">Your letter{letters.length === 1 ? '' : 's'}</span>
          <button class={`hand${shown ? ' is-shown' : ''}`} onClick={toggle} aria-pressed={shown}>
            <span class="tile-row">
              {letters.map((l, i) => (
                <Tile key={i} letter={l} size="xl" hidden={!shown} delay={i * 80} />
              ))}
            </span>
            <span class="hand-hint">{shown ? 'Tap to hide' : 'Tap to peek (keep them secret)'}</span>
          </button>
          <p class="muted center">
            Hint at {letters.length === 1 ? 'your letter' : 'each letter'} out loud without saying {letters.length === 1 ? 'it' : 'them'}.
            {host && (
              <>
                {' '}
                <span class={`name team-${host.team}`}>{host.name}</span> knows the word.
              </>
            )}
          </p>
        </section>
      ) : (
        <section class="intro center">
          <h1 class="display small">You sat this one out</h1>
          <p class="muted">You joined mid-round, so you have no letters. Guess anyway!</p>
        </section>
      )}
      <HostAwayNotice game={game} host={host} />
      {others.length > 0 && (
        <section class="card">
          <span class="field-label">Around the table</span>
          <ul class="holders">
            {others.map((p) => (
              <li key={p.id}>
                <PlayerChip player={p} />
                <span class="mini-tiles" aria-label={`${p.tileCount} letters`}>
                  {Array.from({ length: p.tileCount }, (_, i) => (
                    <span key={i} class="mini-tile" />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function HostPlay({ game, view }: { game: Game; view: View }) {
  const word = view.word ?? '';
  const holdings = view.holdings ?? {};
  const guessers = view.players.filter((p) => p.id !== view.you);
  const nameOf = (id: string) => view.players.find((p) => p.id === id);
  const [confirmNobody, setConfirmNobody] = useState(false);

  return (
    <div class="stack-lg">
      <Countdown deadline={view.deadline} skew={game.skew} total={view.timerSeconds} />
      <section class="intro center">
        <span class="kicker">Your secret word</span>
        <TileWord word={word} stagger={40} tone="ink" fit={{ max: 56, inset: 32 }} />
        <p class="muted">Clue the whole word. Everyone else is hinting at their letters.</p>
      </section>

      <section class="card">
        <span class="field-label">Who holds what</span>
        <ul class="holders">
          {Object.entries(holdings).map(([pid, letters]) => {
            const p = nameOf(pid);
            return (
              <li key={pid}>
                {p ? <PlayerChip player={p} /> : <span class="chip">Someone</span>}
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

      <section class="card stack">
        <h2 class="display small">Who guessed it?</h2>
        <div class="guess-grid">
          {guessers.map((p) => (
            <button key={p.id} class={`guess team-${p.team}`} onClick={() => game.send({ type: 'award', playerId: p.id })}>
              <TeamDot team={p.team} />
              {p.name}
            </button>
          ))}
        </div>
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
          <button class="btn link" onClick={() => setConfirmNobody(true)}>
            Nobody got it
          </button>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

function Reveal({ game, view }: { game: Game; view: View }) {
  const last = view.last;
  if (!last) return null;
  const guesser = view.players.find((p) => p.id === last.guesserId);
  const host = view.players.find((p) => p.id === last.hostId);
  const nameOf = (id: string) => view.players.find((p) => p.id === id);

  return (
    <div class="stack-lg">
      <section class="intro center reveal-hero">
        <span class="kicker">The word was</span>
        {last.word ? <TileWord word={last.word} stagger={90} fit={{ max: 56, inset: 32 }} /> : <span class="muted">(never chosen)</span>}
        {guesser ? (
          <p class={`verdict team-${guesser.team}`}>
            <strong>{guesser.name}</strong> got it · +1 {TEAM_NAME[guesser.team]}
          </p>
        ) : (
          <p class="verdict">Nobody got it this time</p>
        )}
        {host && <p class="muted small">Clues by {host.name}</p>}
      </section>

      {Object.keys(last.holdings).length > 0 && (
        <section class="card">
          <span class="field-label">Who held what</span>
          <ul class="holders">
            {Object.entries(last.holdings).map(([pid, letters]) => {
              const p = nameOf(pid);
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

      <div class="dock">
        <button class="btn primary big" onClick={() => game.send({ type: 'next' })}>
          Next round
        </button>
      </div>
    </div>
  );
}
