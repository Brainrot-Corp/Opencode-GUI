import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, Part, Session } from "@opencode-ai/sdk/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { opencode, getDirectory } from "../api";
import { playSound } from "../lib/sounds";
import type { Cmd, Msg, OpenCodeEvent, PermAsk, ProviderGroup } from "../types";

// slash-command entries surfaced in the composer: app built-ins first,
// then the server registry (custom + plugin + skill commands)
export type CmdEntry = {
  name: string;
  description: string;
  source: string;
  takesArgs: boolean;
  builtin?: boolean;
};

type DialogState = { kind: "help" } | { kind: "share"; url: string } | null;

export function useOpencode() {
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // sessions with an in-flight prompt — tracked per session so background
  // streams keep their state (and the sidebar can show an indicator)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [providers, setProviders] = useState<ProviderGroup[]>([]);
  const [modelSel, setModelSel] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [permission, setPermission] = useState<PermAsk | null>(null);
  const [commands, setCommands] = useState<Cmd[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [live, setLive] = useState(false);
  const [booting, setBooting] = useState(true);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const busyRef = useRef(busyIds);
  busyRef.current = busyIds;
  // tracks whether the in-flight prompt carries an explicit model selection;
  // if not, the reply reveals the server's true default
  const sentExplicitModel = useRef(false);
  // authoritative mutable message stores, one per session — SSE mutations
  // apply here synchronously (regardless of which session is open), then
  // mirror into React state only for the active session
  const stores = useRef<Map<string, Msg[]>>(new Map());
  // guards against a stale fetch overwriting a newer one (fast session hops)
  const fetchSeq = useRef<Map<string, number>>(new Map());
  // command-registry refetch throttle for file-watcher bursts
  const cmdFetchAt = useRef(0);
  // parts that arrived before their parent message entry — flushed on creation
  const orphanParts = useRef<Map<string, { sid: string; parts: Part[] }>>(new Map());
  // streamed text deltas for parts that don't officially exist yet
  const pendingDeltas = useRef<Map<string, { sid: string; text: string }>>(new Map());

  const storeFor = (sid: string) => {
    let s = stores.current.get(sid);
    if (!s) {
      s = [];
      stores.current.set(sid, s);
    }
    return s;
  };

  const setSessionBusy = (sid: string, on: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(sid);
      else next.delete(sid);
      return next;
    });
  };

  function upsertPart(part: Part) {
    const store = storeFor(part.sessionID);
    const m = store.find((x) => x.info.id === part.messageID);
    if (!m) return false;
    const pi = m.parts.findIndex((x) => x.id === part.id);
    if (pi < 0) m.parts.push(part);
    else m.parts[pi] = part;
    // authoritative full-text update — drop any stashed deltas for this part
    pendingDeltas.current.delete(`${part.messageID}:${part.id}`);
    if (part.sessionID === activeRef.current) setMsgs([...store]);
    return true;
  }

  // append stashed deltas to their parts once those parts exist
  function flushDeltas() {
    for (const [key, entry] of [...pendingDeltas.current]) {
      const cut = key.lastIndexOf(":");
      const mid = key.slice(0, cut);
      const pid = key.slice(cut + 1);
      const store = stores.current.get(entry.sid);
      const m = store?.find((x) => x.info.id === mid);
      const pt = m?.parts.find((x) => x.id === pid) as { type?: string; text?: string } | undefined;
      if (m && pt && pt.type === "text") {
        pt.text = (pt.text ?? "") + entry.text;
        pendingDeltas.current.delete(key);
        if (entry.sid === activeRef.current) setMsgs([...store!]);
      } else if (!store || !m) {
        // store gone (session deleted) — stale deltas; keep waiting otherwise
        if (!store) pendingDeltas.current.delete(key);
      }
    }
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

  // server registry: custom + plugin-registered + skill commands.
  // hot reload: refetched on "/" menu open, window focus, and .opencode
  // file-watcher events — but NEW command files only appear after a sidecar
  // restart (upstream scans command dirs once at startup; verified 2026-08-23)
  const refreshCommands = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.command.list();
    setCommands(((r.data ?? []) as any[]).map((c) => ({ ...(c as Cmd) })));
  }, []);

  const openSession = useCallback(async (id: string) => {
    localStorage.setItem(LAST_KEY, id);
    setActiveId(id);
    setPermission(null);
    // show whatever we already have for this session (no blank flash),
    // then refetch — a per-session sequence guard drops stale responses
    const cached = stores.current.get(id);
    setMsgs(cached ? [...cached] : []);
    const seq = (fetchSeq.current.get(id) ?? 0) + 1;
    fetchSeq.current.set(id, seq);
    const { client } = await opencode();
    const r = await client.session.messages({ path: { id } });
    if (fetchSeq.current.get(id) !== seq) return;
    // mid-stream the SSE-mutated store is NEWER than any fetch snapshot
    // (opencode persists part text only at milestones) — don't reset it
    if (busyRef.current.has(id)) return;
    const list = (r.data ?? []) as Msg[];
    stores.current.set(id, list);
    // the fetch is authoritative for THIS session — drop its stashes
    for (const [k, v] of orphanParts.current) if (v.sid === id) orphanParts.current.delete(k);
    for (const [k, v] of pendingDeltas.current) if (v.sid === id) pendingDeltas.current.delete(k);
    // user may have switched away while we were fetching — update the
    // session's store but never clobber another session's view
    if (activeRef.current === id) setMsgs(list);
  }, []);

  useEffect(() => {
    let es: EventSource | undefined;
    let disposed = false;

    const onEvent = (e: OpenCodeEvent) => {
      const p = e.properties;
      switch (e.type) {
        case "message.updated": {
          const info = p.info as Message;
          const sid = info.sessionID;
          if (info.role === "assistant" && info.time?.completed) {
            setSessionBusy(sid, false);
            if (sid === activeRef.current) playSound("reply");
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
            const store = storeFor(sid);
            const i = store.findIndex((m) => m.info.id === info.id);
            if (i < 0) {
              // flush any parts that arrived before their parent message
              const queued = orphanParts.current.get(info.id);
              orphanParts.current.delete(info.id);
              store.push({ info, parts: queued?.parts ?? [] });
            } else {
              store[i] = { ...store[i], info };
            }
            if (sid === activeRef.current) setMsgs([...store]);
          }
          flushDeltas();
          break;
        }
        case "message.part.updated": {
          const part = p.part as Part;
          if (!part) return;
          if (!upsertPart(part)) {
            // parent message entry not created yet — queue so nothing is lost
            const q = orphanParts.current.get(part.messageID);
            if (q) q.parts.push(part);
            else orphanParts.current.set(part.messageID, { sid: part.sessionID, parts: [part] });
          } else {
            orphanParts.current.delete(part.messageID);
          }
          break;
        }
        case "message.part.delta": {
          // incremental stream chunk: {sessionID, messageID, partID, field, delta}
          if (p.field !== "text") return;
          const sid = p.sessionID as string;
          const key = `${p.messageID}:${p.partID}`;
          const store = storeFor(sid);
          const m = store.find((x) => x.info.id === p.messageID);
          const pt = m?.parts.find((x) => x.id === p.partID) as
            | { type?: string; text?: string }
            | undefined;
          if (m && pt && pt.type === "text") {
            pt.text = (pt.text ?? "") + p.delta;
            pendingDeltas.current.delete(key);
            if (sid === activeRef.current) setMsgs([...store]);
          } else {
            // part not announced yet — stash until it exists
            const cur = pendingDeltas.current.get(key);
            if (cur) cur.text += p.delta;
            else pendingDeltas.current.set(key, { sid, text: p.delta });
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
          setSessionBusy(p.sessionID, false);
          break;
        case "session.deleted": {
          const delId = p.sessionID ?? p.id;
          if (delId) {
            stores.current.delete(delId);
            fetchSeq.current.delete(delId);
            setSessionBusy(delId, false);
          }
          refreshSessions().catch(() => {});
          break;
        }
        case "file.watcher.updated":
          // something changed under the workspace — if it could be a command
          // file, refresh the registry (debounced; new files still need an
          // app restart per server behavior, edits/deletes of loaded ones show up)
          {
            const path = `${p.file ?? p.path ?? ""}`;
            if (path.includes(".opencode") && Date.now() - cmdFetchAt.current > 1000) {
              cmdFetchAt.current = Date.now();
              refreshCommands().catch(() => {});
            }
          }
          break;
      }
    };

    (async () => {
      try {
        const { base, client } = await opencode();

        const dir = getDirectory();
        es = new EventSource(
          dir ? `${base}/event?directory=${encodeURIComponent(dir)}` : `${base}/event`,
        );
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
        // command registry is optional chrome — never block boot on it
        refreshCommands().catch(() => {});

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
  }, [refreshSessions, openSession, refreshCommands]);

  // keep the command registry warm across workspace switches done elsewhere
  useEffect(() => {
    const onFocus = () => refreshCommands().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshCommands]);

  const newSession = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.session.create({ body: {} });
    const s = r.data as Session;
    localStorage.setItem(LAST_KEY, s.id);
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    stores.current.set(s.id, []);
    orphanParts.current.clear();
    pendingDeltas.current.clear();
    setMsgs([]);
    setPermission(null);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text || !activeId || busyRef.current.has(activeId)) return;
      setSessionBusy(activeId, true);
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
        setSessionBusy(activeId, false);
        setError(String(e));
      }
    },
    [activeId, modelSel],
  );

  const abort = useCallback(async () => {
    if (!activeId) return;
    setSessionBusy(activeId, false);
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

  // /undo target: the user message to rewind TO — one before the last
  // exchange normally, one before the rewind point when already viewing an
  // earlier version. "" when there is nothing left to undo.
  const undoTarget = useMemo(() => {
    if (!activeId) return "";
    const users = msgs.filter((m) => m.info.role === "user").map((m) => m.info.id);
    const pos = revertId ? users.indexOf(revertId) : users.length;
    const t = revertId ? pos - 1 : pos - 2;
    return t >= 0 ? users[t] : "";
  }, [msgs, revertId, activeId]);

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const slash = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
      const id = activeRef.current;
      if (slash && id) {
        const [, name, args] = slash;
        // built-ins first (TUI parity), then the server registry
        switch (name) {
          case "help":
            setDialog({ kind: "help" });
            return;
          case "exit":
            playSound("close");
            getCurrentWindow().close();
            return;
          case "new":
            await newSession();
            return;
          case "undo":
            if (undoTarget && !busyRef.current.has(id)) revertTo(undoTarget);
            return;
          case "redo":
            if (revertId) unrevert();
            return;
          case "compact": {
            if (busyRef.current.has(id)) return;
            const sel = modelSel || defaultModel;
            if (!sel) return;
            const [providerID, modelID] = sel.split("/");
            setSessionBusy(id, true);
            const { client } = await opencode();
            try {
              await client.session.summarize({ path: { id }, body: { providerID, modelID } });
            } catch (e) {
              setSessionBusy(id, false);
              setError(String(e));
            }
            return;
          }
          case "share": {
            const { client } = await opencode();
            try {
              await client.session.share({ path: { id } });
              const r = await client.session.get({ path: { id } });
              const url = (r.data as any)?.share?.url ?? "";
              if (url) setDialog({ kind: "share", url });
              else setError("Sharing is disabled in this build's config");
            } catch (e) {
              setError(String(e));
            }
            return;
          }
          case "unshare": {
            const { client } = await opencode();
            await client.session.unshare({ path: { id } }).catch((e) => setError(String(e)));
            return;
          }
          case "fork": {
            if (busyRef.current.has(id)) return;
            const { client } = await opencode();
            try {
              const r = await client.session.fork({ path: { id } });
              const s = r.data as Session;
              await refreshSessions();
              await openSession(s.id);
            } catch (e) {
              setError(String(e));
            }
            return;
          }
        }
        const reg = commands.find((c) => c.name === name);
        if (reg) {
          if (busyRef.current.has(id)) return;
          setSessionBusy(id, true);
          sentExplicitModel.current = false;
          const { client } = await opencode();
          try {
            await client.session.command({
              path: { id },
              body: { command: name, arguments: args ?? "" },
            });
          } catch (e) {
            setSessionBusy(id, false);
            setError(String(e));
          }
          return;
        }
      }
      send(text);
    },
    [
      commands,
      send,
      newSession,
      revertTo,
      unrevert,
      undoTarget,
      revertId,
      modelSel,
      defaultModel,
      refreshSessions,
      openSession,
    ],
  );

  // unified list for the composer autocomplete — built-ins first
  const cmdList = useMemo<CmdEntry[]>(() => {
    const builtins: CmdEntry[] = [
      { name: "new", description: "Start a new session", source: "built-in", takesArgs: false, builtin: true },
      { name: "undo", description: "Undo the last message", source: "built-in", takesArgs: false, builtin: true },
      { name: "redo", description: "Redo the last undone message", source: "built-in", takesArgs: false, builtin: true },
      { name: "compact", description: "Summarize the session to reduce context size", source: "built-in", takesArgs: false, builtin: true },
      { name: "fork", description: "Create a new session from this one", source: "built-in", takesArgs: false, builtin: true },
      { name: "share", description: "Share this session and copy the URL", source: "built-in", takesArgs: false, builtin: true },
      { name: "unshare", description: "Stop sharing this session", source: "built-in", takesArgs: false, builtin: true },
      { name: "help", description: "Show all available commands", source: "built-in", takesArgs: false, builtin: true },
      { name: "exit", description: "Close OpenCode", source: "built-in", takesArgs: false, builtin: true },
    ];
    const reg: CmdEntry[] = [...commands]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        name: c.name,
        description: c.description ?? "",
        source: c.source ?? "command",
        takesArgs: (c.hints ?? []).some((h) => h.includes("ARGUMENTS")) || /\$ARGUMENTS/.test(c.template ?? ""),
      }));
    return [...builtins, ...reg];
  }, [commands]);

  const removeSession = useCallback(
    async (id: string) => {
      const { client } = await opencode();
      await client.session.delete({ path: { id } }).catch(() => {});
      setSessions((prev) => prev.filter((s) => s.id !== id));
      stores.current.delete(id);
      fetchSeq.current.delete(id);
      setSessionBusy(id, false);
      if (activeRef.current === id) {
        setActiveId("");
        orphanParts.current.clear();
        pendingDeltas.current.clear();
        setMsgs([]);
      }
    },
    [],
  );

  // the active session's busy state, derived from the per-session set
  const busy = busyIds.has(activeId);

  return {
    error,
    live,
    booting,
    sessions,
    busyIds,
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
    submit,
    cmdList,
    refreshCommands,
    dialog,
    closeDialog: () => setDialog(null),
    abort,
    respondToPermission,
    removeSession,
  };
}
