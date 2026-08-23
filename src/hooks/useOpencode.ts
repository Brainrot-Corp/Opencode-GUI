import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, Part, Session } from "@opencode-ai/sdk/client";
import { opencode } from "../api";
import { playSound } from "../lib/sounds";
import type { Msg, OpenCodeEvent, PermAsk, ProviderGroup } from "../types";

export function useOpencode() {
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderGroup[]>([]);
  const [modelSel, setModelSel] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [permission, setPermission] = useState<PermAsk | null>(null);
  const [live, setLive] = useState(false);
  const [booting, setBooting] = useState(true);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  // tracks whether the in-flight prompt carries an explicit model selection;
  // if not, the reply reveals the server's true default
  const sentExplicitModel = useRef(false);
  // authoritative mutable message store — SSE mutations apply here
  // synchronously, then mirror into React state (avoids batching races)
  const msgsStore = useRef<Msg[]>([]);
  // parts that arrived before their parent message entry — flushed on creation
  const orphanParts = useRef<Map<string, Part[]>>(new Map());
  // streamed text deltas for parts that don't officially exist yet
  const pendingDeltas = useRef<Map<string, string>>(new Map());

  function upsertPart(part: Part) {
    const store = msgsStore.current;
    const m = store.find((x) => x.info.id === part.messageID);
    if (!m) return false;
    const pi = m.parts.findIndex((x) => x.id === part.id);
    if (pi < 0) m.parts.push(part);
    else m.parts[pi] = part;
    // authoritative full-text update — drop any stashed deltas for this part
    pendingDeltas.current.delete(`${part.messageID}:${part.id}`);
    setMsgs([...store]);
    return true;
  }

  // append stashed deltas to their parts once those parts exist
  function flushDeltas() {
    let changed = false;
    for (const key of [...pendingDeltas.current.keys()]) {
      const cut = key.lastIndexOf(":");
      const mid = key.slice(0, cut);
      const pid = key.slice(cut + 1);
      const m = msgsStore.current.find((x) => x.info.id === mid);
      const pt = m?.parts.find((x) => x.id === pid) as { type?: string; text?: string } | undefined;
      if (m && pt && pt.type === "text") {
        pt.text = (pt.text ?? "") + pendingDeltas.current.get(key);
        pendingDeltas.current.delete(key);
        changed = true;
      } else if (!m) {
        // message is gone — stale deltas
        pendingDeltas.current.delete(key);
      }
    }
    if (changed) setMsgs([...msgsStore.current]);
  }

  // remember the last hand-picked model across launches
  // (only persist real selections — never wipe the stored one with "")
  useEffect(() => {
    if (modelSel) localStorage.setItem("oc.lastModel", modelSel);
  }, [modelSel]);

  const LAST_KEY = "oc.lastSes";

  const refreshSessions = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.session.list();
    // most recently updated first
    const list = ((r.data ?? []) as Session[]).slice().sort(
      (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
    );
    setSessions(list);
    return list;
  }, []);

  const openSession = useCallback(async (id: string) => {
    localStorage.setItem(LAST_KEY, id);
    setActiveId(id);
    msgsStore.current = [];
    setMsgs([]);
    setBusy(false);
    setPermission(null);
    const { client } = await opencode();
    const r = await client.session.messages({ path: { id } });
    const list = (r.data ?? []) as Msg[];
    // replace (don't merge) — events that landed mid-fetch are already included
    msgsStore.current = list;
    orphanParts.current.clear();
    pendingDeltas.current.clear();
    setMsgs(list);
  }, []);

  useEffect(() => {
    let es: EventSource | undefined;
    let disposed = false;

    const onEvent = (e: OpenCodeEvent) => {
      const p = e.properties;
      switch (e.type) {
        case "message.updated": {
          const info = p.info as Message;
          if (info.sessionID !== activeRef.current) return;
          if (info.role === "assistant" && info.time?.completed) {
            setBusy(false);
            playSound("reply");
          }
          // learn the server's real default from a reply we did NOT steer
          if (
            !sentExplicitModel.current &&
            info.role === "assistant" &&
            (info as any).providerID &&
            (info as any).modelID
          ) {
            const resolved = `${(info as any).providerID}/${(info as any).modelID}`;
            setDefaultModel((prev) => (prev === resolved ? prev : resolved));
          }
          {
            const store = msgsStore.current;
            const i = store.findIndex((m) => m.info.id === info.id);
            if (i < 0) {
              // flush any parts that arrived before their parent message
              const queued = orphanParts.current.get(info.id) ?? [];
              orphanParts.current.delete(info.id);
              store.push({ info, parts: queued });
            } else {
              store[i] = { ...store[i], info };
            }
            setMsgs([...store]);
          }
          flushDeltas();
          break;
        }
        case "message.part.updated": {
          const part = p.part as Part;
          if (!part || part.sessionID !== activeRef.current) return;
          if (!upsertPart(part)) {
            // parent message entry not created yet — queue so nothing is lost
            const q = orphanParts.current.get(part.messageID) ?? [];
            q.push(part);
            orphanParts.current.set(part.messageID, q);
          } else {
            orphanParts.current.delete(part.messageID);
          }
          break;
        }
        case "message.part.delta": {
          // incremental stream chunk: {sessionID, messageID, partID, field, delta}
          if (p.sessionID !== activeRef.current || p.field !== "text") return;
          const key = `${p.messageID}:${p.partID}`;
          const store = msgsStore.current;
          const m = store.find((x) => x.info.id === p.messageID);
          const pt = m?.parts.find((x) => x.id === p.partID) as
            | { type?: string; text?: string }
            | undefined;
          if (m && pt && pt.type === "text") {
            pt.text = (pt.text ?? "") + p.delta;
            pendingDeltas.current.delete(key);
            setMsgs([...store]);
          } else {
            // part not announced yet — stash until it exists
            pendingDeltas.current.set(key, (pendingDeltas.current.get(key) ?? "") + p.delta);
          }
          break;
        }
        case "permission.asked":
          // v1.18 emits permission.asked {id, sessionID, permission, metadata, patterns}
          if (p.sessionID === activeRef.current)
            setPermission({
              id: p.id,
              sessionID: p.sessionID,
              type: p.permission,
              title:
                p.metadata?.command ||
                p.metadata?.title ||
                (p.patterns ?? []).join(", ") ||
                p.permission,
            });
          break;
        case "permission.updated":
          if (p.sessionID === activeRef.current)
            setPermission({
              id: p.id,
              sessionID: p.sessionID,
              type: p.type,
              title: p.title ?? p.type,
            });
          break;
        case "session.idle":
          if (p.sessionID === activeRef.current) setBusy(false);
          break;
        case "session.deleted":
          refreshSessions().catch(() => {});
          break;
      }
    };

    (async () => {
      try {
        const { base, client } = await opencode();

        es = new EventSource(`${base}/event`);
        es.onopen = () => setLive(true);
        es.onerror = () => setLive(false);
        es.onmessage = (ev) => {
          try {
            onEvent(JSON.parse(ev.data));
          } catch {
            // malformed event — ignore
          }
        };
        // onerror: EventSource reconnects automatically

        let list: Session[] = [];
        try {
          list = await refreshSessions();
        } catch (e) {
          if (!disposed) setError(`Failed to load sessions: ${e}`);
        }
        // reopen the last-used session if it still exists, else the newest
        const lastId = localStorage.getItem(LAST_KEY);
        const target = list.find((s) => s.id === lastId) ?? list[0];
        if (target && !disposed) {
          await openSession(target.id).catch((e) => {
            if (!disposed) setError(`Failed to open session: ${e}`);
          });
        }

        try {
          const pr = await client.config.providers();
          const groups: ProviderGroup[] = ((pr.data?.providers ?? []) as any[]).map((prov) => ({
            id: prov.id,
            label: prov.name || prov.id,
            models: Object.entries(prov.models ?? {}).map(([mid, m]: [string, any]) => ({
              id: mid,
              label: m.name || mid,
            })),
          }));
          groups.sort((a, b) => a.label.localeCompare(b.label));
          setProviders(groups);

          // NOTE: the server's effective fallback model is not exposed by any
          // endpoint (the /config/providers default map lies). It is *learned*
          // from the first reply of an unsteered prompt — see message.updated.
          // Until then the UI asks the user to pick a model explicitly.

          // restore the last hand-picked model if it still exists
          const saved = localStorage.getItem("oc.lastModel");
          if (saved) {
            const [pid, mid] = saved.split("/");
            if (groups.some((g) => g.id === pid && g.models.some((m) => m.id === mid))) {
              setModelSel(saved);
            } else {
              localStorage.removeItem("oc.lastModel");
            }
          }
        } catch (e) {
          // provider listing is optional, but show why it failed
          if (!disposed) setError(`Failed to load models: ${e}`);
        }
        if (!disposed) setBooting(false);
      } catch (e) {
        if (!disposed) {
          setError(String(e));
          setBooting(false);
        }
      }
    })();

    return () => {
      disposed = true;
      es?.close();
    };
  }, [refreshSessions, openSession]);

  const newSession = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.session.create({ body: {} });
    const s = r.data as Session;
    localStorage.setItem(LAST_KEY, s.id);
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    msgsStore.current = [];
    orphanParts.current.clear();
    pendingDeltas.current.clear();
    setMsgs([]);
    setBusy(false);
    setPermission(null);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text || !activeId || busy) return;
      setBusy(true);
      try {
        const { client } = await opencode();
        const body: any = { parts: [{ type: "text", text }] };
        sentExplicitModel.current = !!modelSel;
        if (modelSel) {
          const [providerID, modelID] = modelSel.split("/");
          body.model = { providerID, modelID };
        }
        await client.session.promptAsync({ path: { id: activeId }, body });
      } catch (e) {
        setBusy(false);
        setError(String(e));
      }
    },
    [activeId, busy, modelSel],
  );

  const abort = useCallback(async () => {
    if (!activeId) return;
    setBusy(false);
    const { client } = await opencode();
    await client.session.abort({ path: { id: activeId } }).catch(() => {});
  }, [activeId]);

  const respondToPermission = useCallback(
    async (response: "once" | "always" | "reject") => {
      if (!permission) return;
      const perm = permission;
      setPermission(null);
      const { client } = await opencode();
      await client
        .postSessionIdPermissionsPermissionId({
          path: { id: perm.sessionID, permissionID: perm.id },
          body: { response },
        })
        .catch((e) => setError(String(e)));
    },
    [permission],
  );

  // session.revert cuts the conversation after the given message;
  // the active session's revert marker tells us where (and that) we rewound
  const revertId = sessions.find((s) => s.id === activeId)?.revert?.messageID ?? "";
  // hide everything past the rewind point (server still returns full history)
  const visibleMsgs = useMemo(() => {
    if (!revertId) return msgs;
    const i = msgs.findIndex((m) => m.info.id === revertId);
    return i >= 0 ? msgs.slice(0, i + 1) : msgs;
  }, [msgs, revertId]);

  const revertTo = useCallback(
    async (messageID: string) => {
      const id = activeRef.current;
      if (!id) return;
      const { client } = await opencode();
      await client.session.revert({ path: { id }, body: { messageID } }).catch(() => {});
      await refreshSessions().catch(() => {});
      await openSession(id).catch(() => {});
    },
    [refreshSessions, openSession],
  );

  const unrevert = useCallback(async () => {
    const id = activeRef.current;
    if (!id) return;
    const { client } = await opencode();
    await client.session.unrevert({ path: { id } }).catch(() => {});
    await refreshSessions().catch(() => {});
    await openSession(id).catch(() => {});
  }, [refreshSessions, openSession]);

  const removeSession = useCallback(
    async (id: string) => {
      const { client } = await opencode();
      await client.session.delete({ path: { id } }).catch(() => {});
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeRef.current === id) {
        setActiveId("");
        msgsStore.current = [];
        orphanParts.current.clear();
        pendingDeltas.current.clear();
        setMsgs([]);
      }
    },
    [],
  );

  return {
    error,
    live,
    booting,
    sessions,
    defaultModel,
    activeId,
    msgs: visibleMsgs,
    revertId,
    revertTo,
    unrevert,
    busy,
    providers,
    modelSel,
    setModelSel,
    permission,
    newSession,
    openSession,
    send,
    abort,
    respondToPermission,
    removeSession,
  };
}
