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

export function useGame(): Game {
  const [status, setStatus] = useState<Status>('connecting');
  const [view, setView] = useState<View | null>(null);
  const [skew, setSkew] = useState(0);
  const [resuming, setResuming] = useState(() => readSeat() !== null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const queue = useRef<ClientMessage[]>([]);
  const resumePending = useRef(false);
  const retry = useRef({ attempt: 0, timer: 0 as unknown as ReturnType<typeof setTimeout> });
  const [generation, setGeneration] = useState(0);

  const toast = (text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${location.host}/ws`);
      wsRef.current = ws;
      setStatus('connecting');

      ws.onopen = () => {
        retry.current.attempt = 0;
        setStatus('online');
        const seat = readSeat();
        if (seat) {
          resumePending.current = true;
          ws.send(JSON.stringify({ type: 'resume', ...seat } satisfies ClientMessage));
        }
        for (const msg of queue.current.splice(0)) ws.send(JSON.stringify(msg));
      };

      ws.onmessage = (event) => {
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
            setView(msg.view);
            setSkew(msg.now - Date.now());
            break;
          case 'left':
            writeSeat(null);
            setView(null);
            setResuming(false);
            history.replaceState(null, '', '/');
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
        if (event.code === 4001) {
          setStatus('replaced');
          return;
        }
        setStatus('offline');
        const delay = Math.min(5000, 400 * 2 ** retry.current.attempt);
        retry.current.attempt += 1;
        retry.current.timer = setTimeout(connect, delay);
      };
    };

    connect();
    const onVisible = () => {
      // Phones freeze background tabs; reconnect immediately when we come back.
      const ws = wsRef.current;
      if (document.visibilityState === 'visible' && ws && ws.readyState > WebSocket.OPEN) {
        clearTimeout(retry.current.timer);
        retry.current.attempt = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      clearTimeout(retry.current.timer);
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
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        else queue.current.push(msg);
      },
      reclaim: () => setGeneration((g) => g + 1),
    }),
    [status, view, skew, resuming, toasts],
  );
}
