// One WebSocket per tab, with automatic reconnection and seat resumption.
// The seat token lives in localStorage so a refresh, a locked phone or a
// flaky network never costs a player their letters or their score.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ClientMessage, ServerMessage, View } from '../shared/protocol.ts';

export type Status = 'connecting' | 'online' | 'offline' | 'replaced';

interface Seat {
  code: string;
  token: string;
}

export interface Toast {
  id: number;
  text: string;
}

const SEAT_KEY = 'lbl.seat';

function readSeat(): Seat | null {
  try {
    const raw = localStorage.getItem(SEAT_KEY);
    const seat = raw ? (JSON.parse(raw) as Seat) : null;
    return seat && typeof seat.code === 'string' && typeof seat.token === 'string' ? seat : null;
  } catch {
    return null;
  }
}

function writeSeat(seat: Seat | null): void {
  try {
    if (seat) localStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    else localStorage.removeItem(SEAT_KEY);
  } catch {
    /* private mode: the seat just won't survive a refresh */
  }
}

export function storedName(): string {
  try {
    return localStorage.getItem('lbl.name') ?? '';
  } catch {
    return '';
  }
}

export function storeName(name: string): void {
  try {
    localStorage.setItem('lbl.name', name);
  } catch {
    /* ignore */
  }
}

export interface Game {
  status: Status;
  view: View | null;
  /** Server clock minus local clock, in ms. */
  skew: number;
  /** True while we hold a seat token and are trying to get back into it. */
  resuming: boolean;
  toasts: Toast[];
  send: (msg: ClientMessage) => void;
  reclaim: () => void;
}

/** The room code in a `/r/CODE` invite link, if the page was opened from one. */
function linkedCode(): string | null {
  return location.pathname.match(/^\/r\/([^/]+)$/)?.[1]?.toUpperCase() ?? null;
}

/**
 * The saved seat, unless the page was opened from a link to a different room:
 * someone scanning a new room's QR code wants that room, not their old one.
 */
function seatToResume(): Seat | null {
  const seat = readSeat();
  const link = linkedCode();
  return seat && (!link || link === seat.code) ? seat : null;
}

const PROBE_EVERY_MS = 25_000;
const PROBE_TIMEOUT_MS = 4_000;

export function useGame(): Game {
  const [status, setStatus] = useState<Status>('connecting');
  const [view, setView] = useState<View | null>(null);
  const [skew, setSkew] = useState(0);
  const [resuming, setResuming] = useState(() => seatToResume() !== null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const queue = useRef<ClientMessage[]>([]);
  const resumePending = useRef(false);
  const lastView = useRef<View | null>(null);
  const [generation, setGeneration] = useState(0);

  const toast = (text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  };

  useEffect(() => {
    let disposed = false;
    let replaced = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleReconnect = () => {
      clearTimeout(retryTimer);
      const delay = Math.min(5000, 400 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    // A phone waking from sleep can hold a socket that looks open but is dead.
    // Ask the server for a pong; if none comes back quickly, start over.
    const probe = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || probeTimer) return;
      ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
      probeTimer = setTimeout(() => {
        probeTimer = undefined;
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        ws.close();
        setStatus('offline');
        attempt = 0;
        connect();
      }, PROBE_TIMEOUT_MS);
    };

    function connect() {
      if (disposed || replaced) return;
      clearTimeout(retryTimer);
      clearTimeout(probeTimer);
      probeTimer = undefined;
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${location.host}/ws`);
      wsRef.current = ws;
      setStatus('connecting');

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        attempt = 0;
        setStatus('online');
        const seat = seatToResume();
        if (seat) {
          resumePending.current = true;
          ws.send(JSON.stringify({ type: 'resume', ...seat } satisfies ClientMessage));
        }
        for (const msg of queue.current.splice(0)) ws.send(JSON.stringify(msg));
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        clearTimeout(probeTimer);
        probeTimer = undefined;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'joined':
            resumePending.current = false;
            writeSeat({ code: msg.code, token: msg.token });
            setResuming(false);
            if (location.pathname !== `/r/${msg.code}`) history.replaceState(null, '', `/r/${msg.code}`);
            break;
          case 'view':
            announceArrivals(lastView.current, msg.view, toast);
            lastView.current = msg.view;
            setView(msg.view);
            setSkew(msg.now - Date.now());
            break;
          case 'left':
            lastView.current = null;
            writeSeat(null);
            setView(null);
            setResuming(false);
            history.replaceState(null, '', '/');
            break;
          case 'pong':
            break;
          case 'error':
            if (resumePending.current) {
              // Our saved seat is gone (server restarted or the room expired).
              resumePending.current = false;
              writeSeat(null);
              setResuming(false);
              setView(null);
              if (location.pathname !== '/') history.replaceState(null, '', '/');
            }
            toast(msg.message);
            break;
        }
      };

      ws.onclose = (event) => {
        if (disposed || wsRef.current !== ws) return;
        resumePending.current = false;
        if (event.code === 4001) {
          replaced = true;
          setStatus('replaced');
          return;
        }
        setStatus('offline');
        scheduleReconnect();
      };
    }

    connect();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || replaced) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState > WebSocket.OPEN) {
        // Phones freeze background tabs; reconnect straight away on return.
        attempt = 0;
        connect();
      } else {
        probe();
      }
    };
    const heartbeat = setInterval(() => {
      if (document.visibilityState === 'visible') probe();
    }, PROBE_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearTimeout(probeTimer);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
    };
  }, [generation]);

  return useMemo(
    () => ({
      status,
      view,
      skew,
      resuming,
      toasts,
      send: (msg: ClientMessage) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        } else if (msg.type === 'create' || msg.type === 'join') {
          // Entering a room is safe to send late. In-game taps are not: they
          // could land in a later round, so they are dropped while offline.
          queue.current = [msg];
        } else {
          toast('Not connected right now. Try again in a moment.');
        }
      },
      reclaim: () => setGeneration((g) => g + 1),
    }),
    [status, view, skew, resuming, toasts],
  );
}

const TEAM_LABEL = { ember: 'Ember', tide: 'Tide' } as const;

/**
 * At a real table you notice people sitting down or leaving; on a phone you
 * might not. Announce arrivals and departures, and tell a newcomer their team.
 */
function announceArrivals(before: View | null, after: View, toast: (text: string) => void): void {
  if (!before || before.code !== after.code) {
    const me = after.players.find((p) => p.id === after.you);
    if (me && after.phase !== 'lobby') toast(`You joined a game in progress. You're on Team ${TEAM_LABEL[me.team]}.`);
    return;
  }
  const had = new Set(before.players.map((p) => p.id));
  const has = new Set(after.players.map((p) => p.id));
  for (const p of after.players) {
    if (!had.has(p.id) && p.id !== after.you) toast(`${p.name} joined Team ${TEAM_LABEL[p.team]}.`);
  }
  for (const p of before.players) {
    if (!has.has(p.id)) toast(`${p.name} left. Their points stay with Team ${TEAM_LABEL[p.team]}.`);
  }
}
