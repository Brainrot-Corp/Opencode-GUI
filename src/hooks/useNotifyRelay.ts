// Desktop bridge for the phone relay (docs/mobile-companion.md phase 1):
// outbound websocket to the oc-relay postbox + one-notification-per-ask/idle
// emission. Signals arrive two ways:
//   - window events oc:notify-perm / oc:notify-question / oc:notify-error
//     (dispatched by opencodeEvents.ts + useOpencode's boot catch-up)
//   - the busyIds diff below (turn finished = session left the busy set —
//     both completion paths collapse into that transition)
// Config lives in oc.settings.notify; polled from localStorage like
// GitPanel's settingsSnap so drawer edits apply live without prop drilling.
// runLocal mode (GUI-managed relay): spawn/stop via relay_start/relay_stop and
// take the loopback URL + desktop token straight from relay_status — nothing
// to paste. Pure logic (dedupe, text builders, backoff) lives in
// lib/notifyRelay.ts and is unit-tested there.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "@opencode-ai/sdk/client";
import {
  backoffMs,
  busyLeaving,
  createDedupe,
  errorNotifyText,
  permNotifyText,
  questionNotifyText,
  readNotifySettings,
  validRelayUrl,
  type NotifyMsg,
  type NotifySettings,
} from "../lib/notifyRelay";

// relay_status response (src-tauri/src/relay.rs)
export type RelayInfo = {
  running: boolean;
  ours: boolean;
  local_url: string;
  wss_url: string | null;
  phone_page: string | null;
  desktop_token: string | null;
  phone_token: string | null;
};

export function useNotifyRelay({ busyIds, sessions }: { busyIds: Set<string>; sessions: Session[] }) {
  const [cfg, setCfg] = useState<NotifySettings | null>(readNotifySettings);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // drawer edits write oc.settings directly — poll like GitPanel's settingsSnap
  useEffect(() => {
    let last = "";
    const t = window.setInterval(() => {
      const next = readNotifySettings();
      const sig = JSON.stringify(next);
      if (sig !== last) {
        last = sig;
        setCfg(next);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  // runLocal mode: the GUI owns the relay process — spawn it when phone
  // notifications are on, stop it when the toggle goes off or the app exits
  // (invoke races the exit — the Windows Job Object is the hard guarantee).
  const [local, setLocal] = useState<RelayInfo | null>(null);
  const localRef = useRef<RelayInfo | null>(null);
  localRef.current = local;
  useEffect(() => {
    if (!cfg?.runLocal) {
      setLocal(null);
      return;
    }
    let dead = false;
    invoke<RelayInfo>("relay_start")
      .then((info) => {
        if (!dead) setLocal(info);
      })
      .catch(() => {});
    return () => {
      dead = true;
      void invoke("relay_stop").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.runLocal]);

  // effective connection: runLocal → relay_status values; else manual fields
  const url = cfg?.runLocal ? localRef.current?.local_url ?? "" : cfg?.relayUrl ?? "";
  const token = cfg?.runLocal ? localRef.current?.desktop_token ?? "" : cfg?.token ?? "";
  const urlRef = useRef(url);
  const tokenRef = useRef(token);
  urlRef.current = url;
  tokenRef.current = token;

  // ——— socket ———
  const wsRef = useRef<WebSocket | null>(null);
  const outbox = useRef<string[]>([]);
  const attempt = useRef(0);
  const timer = useRef(0);
  const sendRaw = (raw: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(raw);
    else outbox.current.push(raw);
  };

  useEffect(() => {
    if (!validRelayUrl(url)) return;
    let dead = false;
    const retry = () => {
      if (dead) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(connect, backoffMs(attempt.current++));
    };
    const connect = () => {
      if (dead) return;
      const u = urlRef.current;
      const tok = tokenRef.current;
      let ws: WebSocket;
      try {
        ws = new WebSocket(u);
      } catch {
        retry();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        attempt.current = 0;
        sendRaw(JSON.stringify({ type: "hello", role: "desktop", token: tok }));
        const pending = outbox.current;
        outbox.current = [];
        for (const raw of pending) ws.send(raw);
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        retry();
      };
      ws.onerror = () => {
        try { ws.close(); } catch {}
      };
    };
    connect();
    return () => {
      dead = true;
      window.clearTimeout(timer.current);
      const ws = wsRef.current;
      wsRef.current = null;
      try { ws?.close(); } catch {}
    };
  }, [url, token]);

  // ——— emitters ———
  const emit = (msg: NotifyMsg, dedupeKey: string, dedupe: { seen(k: string): boolean }) => {
    if (!validRelayUrl(urlRef.current)) return;
    if (dedupe.seen(dedupeKey)) return;
    sendRaw(
      JSON.stringify({
        type: "notify",
        kind: msg.kind,
        title: msg.title,
        body: msg.body,
        sessionID: msg.sessionID,
      }),
    );
  };
  const permDedupe = useRef(createDedupe());
  const qDedupe = useRef(createDedupe());
  const errDedupe = useRef(createDedupe());
  const idleDedupe = useRef(createDedupe(15_000));

  // window events from the SSE dispatcher + boot catch-up
  useEffect(() => {
    const onPerm = (e: Event) => {
      if (!cfgRef.current?.onPermission) return;
      const ask = (e as CustomEvent).detail as { id: string; sessionID: string; type: string; title: string };
      if (!ask?.id || !ask.sessionID) return;
      emit(permNotifyText(ask), `perm:${ask.id}`, permDedupe.current);
    };
    const onQuestion = (e: Event) => {
      if (!cfgRef.current?.onQuestion) return;
      const ask = (e as CustomEvent).detail as { id: string; sessionID: string; questions: { question?: string; header?: string }[] };
      if (!ask?.id || !ask.sessionID) return;
      emit(questionNotifyText(ask), `q:${ask.id}`, qDedupe.current);
    };
    const onError = (e: Event) => {
      if (!cfgRef.current?.onError) return;
      const d = (e as CustomEvent).detail as { sessionID: string; message: string };
      if (!d?.sessionID || !d.message) return;
      emit(errorNotifyText(d.sessionID, d.message), `err:${d.sessionID}:${d.message.slice(0, 80)}`, errDedupe.current);
    };
    window.addEventListener("oc:notify-perm", onPerm as EventListener);
    window.addEventListener("oc:notify-question", onQuestion as EventListener);
    window.addEventListener("oc:notify-error", onError as EventListener);
    return () => {
      window.removeEventListener("oc:notify-perm", onPerm as EventListener);
      window.removeEventListener("oc:notify-question", onQuestion as EventListener);
      window.removeEventListener("oc:notify-error", onError as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // turn finished — busyIds shrink (message settle or session.idle)
  const prevBusy = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevBusy.current;
    prevBusy.current = new Set(busyIds);
    if (!cfgRef.current?.onIdle) return;
    for (const sid of busyLeaving(prev, busyIds)) {
      emit(
        { kind: "idle", title: `${describe(sid)} — turn complete`, body: "", sessionID: sid },
        `idle:${sid}`,
        idleDedupe.current,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyIds]);

  // title lookup for a session id (sidebar title or the raw id)
  function describe(sid: string): string {
    return sessions.find((s) => s.id === sid)?.title || sid.slice(0, 8);
  }

  return {};
}
