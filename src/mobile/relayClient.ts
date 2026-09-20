// Phone-side relay client — the mobile app's end of the protocol the browser
// shim speaks: hello {role:"phone", token, lastId} → replay → live notifies,
// with reconnect + outbox. Pure-ish: a WebSocket is injected so the logic is
// testable under node (scripts/run-tests.mjs has no WebSocket).

import { backoffMs } from "../lib/notifyRelay.ts";

export type RelayNotify = {
  id?: number;
  kind?: string;
  title?: string;
  body?: string;
  sessionID?: string;
  ts?: number;
};

export type RelayClientHandlers = {
  onStatus?: (s: "connecting" | "connected" | "reconnecting") => void;
  onNotify: (m: RelayNotify) => void;
};

// one-shot JSON send helper — returns false when the socket isn't open
export type RelaySend = (obj: unknown) => boolean;

// the browser WebSocket's event handlers aren't structurally compatible with
// narrow signatures (MessageEvent vs {data}) — keep the slot types loose and
// narrow at the use sites
type MinimalWs = {
  readyState: number;
  send: (data: string) => unknown;
  close: () => unknown;
  onopen: unknown;
  onclose: unknown;
  onerror: unknown;
  onmessage: unknown;
};
type WsCtor = new (url: string) => MinimalWs;

export type RelayConn = {
  stop: () => void;
};

export function connectRelay(
  WebSocketImpl: WsCtor,
  url: string,
  token: string,
  h: RelayClientHandlers,
  storage: { get: () => number; set: (id: number) => void } = {
    get: () => Number(localStorage.getItem("oc.mobile.lastId") || 0),
    set: (id) => {
      try { localStorage.setItem("oc.mobile.lastId", String(id)); } catch {}
    },
  },
): RelayConn {
  let dead = false;
  let ws: MinimalWs | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const outbox: string[] = [];

  const send = (obj: unknown) => {
    const raw = JSON.stringify(obj);
    if (ws && ws.readyState === 1) ws.send(raw);
    else outbox.push(raw);
  };

  const retry = () => {
    if (dead) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(connect, backoffMs(attempt++));
  };

  const connect = () => {
    if (dead) return;
    h.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    let w: MinimalWs;
    try {
      w = new WebSocketImpl(url);
    } catch {
      retry();
      return;
    }
    ws = w;
    // event slots are loosely typed (see MinimalWs) — bind through a loose view
    const s = w as unknown as {
      onopen: () => void;
      onmessage: (e: { data: string }) => void;
      onclose: () => void;
      onerror: () => void;
    };
    s.onopen = () => {
      attempt = 0;
      send({ type: "hello", role: "phone", token, lastId: storage.get() });
      const pending = outbox.splice(0);
      for (const raw of pending) w.send(raw);
    };
    s.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m?.type === "notify") {
          if (typeof m.id === "number" && m.id > storage.get()) storage.set(m.id);
          h.onNotify(m);
        }
      } catch {}
    };
    s.onclose = () => {
      if (ws === w) ws = null;
      if (!dead) {
        h.onStatus?.("reconnecting");
        retry();
      }
    };
    s.onerror = () => {
      try { w.close(); } catch {}
    };
  };

  connect();
  return {
    stop: () => {
      dead = true;
      if (timer) clearTimeout(timer);
      const w = ws;
      ws = null;
      try { w?.close(); } catch {}
    },
  };
}
