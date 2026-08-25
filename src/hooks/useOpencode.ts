import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, Session } from "@opencode-ai/sdk/client";
import { opencode, getDirectory, serverFetch, hiddenSessions, HIDDEN_TITLE } from "../api";
import { playSound } from "../lib/sounds";
import { createSessionStore } from "../lib/sessionStore";
import { splitModel } from "../lib/models";
import { createBusyTracker } from "../lib/busyTracker";
import {
  buildCmdList,
  handleSlash,
  type CmdEntry,
  type DialogState,
} from "../lib/slashCommands";
import { useProviders } from "./useProviders";
import type { Msg, OpenCodeEvent, PermAsk, ProviderGroup, Attachment, QuestionAsk, Cmd } from "../types";

// re-exported: composer + command dialog import the type from here
export type { CmdEntry } from "../lib/slashCommands";

export function useOpencode() {
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // sessions with an in-flight prompt — tracked per session so background
  // streams keep their state (and the sidebar can show an indicator)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // pending question-tool asks, kept per session — returning to a session
  // resurfaces its ask (unlike permissions, these outlive session switches)
  const questionsRef = useRef<Map<string, QuestionAsk>>(new Map());
  const [question, setQuestion] = useState<QuestionAsk | null>(null);
  const [permission, setPermission] = useState<PermAsk | null>(null);
  const [commands, setCommands] = useState<Cmd[]>([]);
  const [agents, setAgents] = useState<{ name: string; mode: string }[]>([]);
  const [agentSel, setAgentSel] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({});
  const [live, setLive] = useState(false);
  const [booting, setBooting] = useState(true);

  const prov = useProviders(setError);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const busyRef = useRef(busyIds);
  busyRef.current = busyIds;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // command-registry refetch throttle for file-watcher bursts
  const cmdFetchAt = useRef(0);

  // authoritative per-session message stores (SSE mutations land here
  // synchronously; only the active session mirrors into React state)
  const storeRef = useRef<ReturnType<typeof createSessionStore> | undefined>(undefined);
  if (!storeRef.current) {
    storeRef.current = createSessionStore((sid) => {
      if (sid === activeRef.current) setMsgs(storeRef.current!.snapshot(sid));
    });
  }
  const store = storeRef.current;

  // outbound prompts waiting on a busy session are flushed by this ref —
  // wired below so the tracker can call back into hook closures
  const flushRef = useRef<(sid: string) => void>(() => {});

  const trackerRef = useRef<ReturnType<typeof createBusyTracker> | undefined>(undefined);
  if (!trackerRef.current) {
    trackerRef.current = createBusyTracker({
      setBusy: setBusyIds,
      setQueueCount: (sid, n) =>
        setQueueCounts((prev) => {
          if (n === null) {
            if (!(sid in prev)) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          }
          return prev[sid] === n ? prev : { ...prev, [sid]: n };
        }),
      onSettle: (sid) => {
        tracker.markBusy(sid, false);
        if (sid === activeRef.current) playSound("reply");
        flushRef.current(sid);
      },
    });
  }
  const tracker = trackerRef.current;

  // mirror the active session's pending ask (if any) into state
  const showQuestion = (sid: string) => {
    if (sid !== activeRef.current) return;
    setQuestion(questionsRef.current.get(sid) ?? null);
  };

  const LAST_KEY = "oc.lastSes";

  const refreshSessions = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.session.list();
    // most recently updated first; helper sessions (summary/debrief/commit
    // gen) are dropped — live-tracked ids plus title-marked crash orphans
    const list = ((r.data ?? []) as Session[])
      .filter((s) => !hiddenSessions.has(s.id) && s.title !== HIDDEN_TITLE)
      .slice()
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
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

  // selectable agents (GET /agent) — hidden internals filtered out
  const refreshAgents = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.app.agents();
    setAgents(
      ((r.data ?? []) as any[])
        .filter(
          (a: any) =>
            a.mode !== "subagent" &&
            !["compaction", "title", "summary"].includes(a.name),
        )
        .map((a: any) => ({ name: a.name as string, mode: a.mode as string })),
    );
  }, []);

  const openSession = useCallback(async (id: string) => {
    localStorage.setItem(LAST_KEY, id);
    setActiveId(id);
    setPermission(null);
    setQuestion(questionsRef.current.get(id) ?? null);
    // show whatever we already have for this session (no blank flash),
    // then refetch — a per-session sequence guard drops stale responses
    const cached = store.cached(id);
    setMsgs(cached ? [...cached] : []);
    const seq = store.beginFetch(id);
    const { client } = await opencode();
    const r = await client.session.messages({ path: { id } });
    if (store.isStale(id, seq)) return;
    // mid-stream the SSE-mutated store is NEWER than any fetch snapshot
    // (opencode persists part text only at milestones) — don't reset it
    if (busyRef.current.has(id)) return;
    const list = (r.data ?? []) as Msg[];
    store.setFetched(id, list);
    // user may have switched away while we were fetching — update the
    // session's store but never clobber another session's view
    if (activeRef.current === id) setMsgs(list);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;

    const onEvent = (e: OpenCodeEvent) => {
      const p = e.properties;
      switch (e.type) {
        case "message.updated": {
          const info = p.info as Message;
          const sid = info.sessionID;
          if (info.role === "assistant" && info.time?.completed) {
            // last live message done — but the turn may continue with a
            // new message any moment; settle only after the grace window
            if (tracker.dropInflight(sid, info.id)) tracker.settle(sid);
          } else if (info.role === "assistant") {
            tracker.cancelSettle(sid);
            tracker.addInflight(sid, info.id);
            // a live message means definitely working — restore the
            // indicators even if an early idle/completion cleared them
            if (!busyRef.current.has(sid)) tracker.markBusy(sid, true);
          }
          // learn the server's real default from a reply we did NOT steer
          if (
            !prov.sentExplicitModel.current &&
            info.role === "assistant" &&
            (info as any).providerID &&
            (info as any).modelID
          ) {
            prov.learnDefault(`${(info as any).providerID}/${(info as any).modelID}`);
          }
          store.applyMessage(info);
          break;
        }
        case "message.part.updated": {
          const part = p.part;
          if (!part) return;
          store.applyPart(part);
          break;
        }
        case "message.part.delta": {
          // incremental stream chunk: {sessionID, messageID, partID, field, delta}
          if (p.field !== "text") return;
          store.applyDelta(p);
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
        case "question.asked": {
          // question tool ask: {id, sessionID, questions:[{question,header,options,multiple?,custom?}]}
          const ask: QuestionAsk = {
            id: p.id,
            sessionID: p.sessionID,
            questions: Array.isArray(p.questions) ? p.questions : [],
          };
          questionsRef.current.set(p.sessionID, ask);
          if (p.sessionID === activeRef.current) {
            setQuestion(ask);
            playSound("reply");
          }
          break;
        }
        case "question.replied":
        case "question.rejected":
          for (const [sid, q] of [...questionsRef.current])
            if (q.id === p.requestID) questionsRef.current.delete(sid);
          setQuestion((cur) => (cur && cur.id === p.requestID ? null : cur));
          break;
        case "session.idle":
          // settles the turn only when no assistant message is still live —
          // mid-turn idles in heavier tasks are ignored
          if (!tracker.hasInflight(p.sessionID)) tracker.settle(p.sessionID);
          break;
        case "session.updated": {
          // server-side metadata changes — auto-generated titles after the
          // first reply, pin/archive flags — must reach the sidebar live
          const s = p.info as Session | undefined;
          if (!s?.id) break;
          setSessions((prev) => {
            const i = prev.findIndex((x) => x.id === s.id);
            if (i < 0) return prev;
            // keep refreshSessions' ordering rule: newest activity first
            return [...prev.map((x, j) => (j === i ? s : x))].sort(
              (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
            );
          });
          break;
        }
        case "session.deleted": {
          const delId = p.sessionID ?? p.id;
          if (delId) {
            store.remove(delId);
            tracker.reset(delId);
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
      // the UI renders immediately on skeletons. Phase 1: poll silently
      // until the sidecar actually answers a real request — ONLY connection
      // failures retry here, nothing else can strand boot in skeletons.
      let list: Session[] = [];
      while (!disposed) {
        try {
          list = await refreshSessions();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (disposed) return;

      // phase 2: connected for good — finish boot best-effort. A flaky
      // step (session reopen, provider list) degrades that piece of UI but
      // must never wedge the whole app back into skeletons.
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

        // reopen the last-used session if it still exists, else the newest
        const lastId = localStorage.getItem(LAST_KEY);
        const target = list.find((s) => s.id === lastId) ?? list[0];
        if (target && !disposed) await openSession(target.id).catch(() => {});

        if (!disposed) await prov.loadProviders(client).catch(() => {});
      } catch (e) {
        if (!disposed) setError(`Connection error: ${e}`);
      } finally {
        // command registry is optional chrome — never block boot on it
        refreshCommands().catch(() => {});
        refreshAgents().catch(() => {});

        // asks that fired while disconnected (app start / reload) — surface
        // any belonging to the reopened session instead of stranding the turn
        serverFetch("/question")
          .then((r) => r.json())
          .then((list: QuestionAsk[]) => {
            if (disposed) return;
            for (const q of list ?? []) questionsRef.current.set(q.sessionID, q);
            showQuestion(activeRef.current);
          })
          .catch(() => {});

        if (!disposed) setBooting(false);
      }
    })();

    return () => {
      disposed = true;
      es?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    store.clearStashes();
    setMsgs([]);
    setPermission(null);
    setQuestion(null);
  }, []);

  // session-wide token/cost totals — summed from the authoritative store
  // (not the revert-filtered view) so rewinding doesn't rewrite history;
  // msgs in deps is the recompute trigger (the store mutates alongside it)
  const sessionUsage = useMemo(() => {
    const s = activeId ? store.cached(activeId) : null;
    let cost = 0;
    let tokens = 0;
    for (const m of s ?? []) {
      const info = m.info as any;
      if (info.role !== "assistant") continue;
      cost += info.cost ?? 0;
      const t = info.tokens ?? {};
      tokens += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
    }
    return { cost, tokens };
  }, [msgs, activeId]);

  // fire a prompt on a specific session — callers ensure it isn't busy
  const promptNow = useCallback(
    async (sid: string, text: string, files?: Attachment[]) => {
      if (!sid || (!text && !files?.length)) return;
      tracker.markBusy(sid, true);
      try {
        const { client } = await opencode();
        const parts: any[] = [{ type: "text", text }];
        for (const f of files ?? [])
          parts.push({ type: "file", mime: f.mime, filename: f.filename, url: f.url });
        const body: any = { parts };
        prov.sentExplicitModel.current = !!prov.modelSel;
        if (prov.modelSel) {
          const [providerID, modelID] = splitModel(prov.modelSel);
          body.model = { providerID, modelID };
        }
        if (agentSel) body.agent = agentSel;
        if (prov.variantSel) body.variant = prov.variantSel;
        await client.session.promptAsync({ path: { id: sid }, body });
      } catch (e) {
        tracker.markBusy(sid, false);
        // surface it in the history (synthetic error bubble) + the banner
        store.addError(sid, String(e));
        setError(String(e));
      }
    },
    [prov.modelSel, prov.variantSel, agentSel],
  );

  // public entry: while the session is streaming, queue instead of dropping
  const send = useCallback(
    async (text: string, files?: Attachment[]) => {
      if (!activeId) return;
      const trimmed = text.trim();
      if (!trimmed && !files?.length) return;
      if (busyRef.current.has(activeId)) {
        tracker.pushQueued(activeId, { text: trimmed, files });
        playSound("send");
        return;
      }
      return promptNow(activeId, trimmed, files);
    },
    [activeId, promptNow],
  );

  // drain one queued prompt per settled turn — guarded by the inflight set
  // (busyRef lags a render behind and would refuse right after settling)
  useEffect(() => {
    flushRef.current = (sid: string) => {
      if (tracker.hasInflight(sid)) return;
      const next = tracker.shiftQueued(sid);
      if (!next) return;
      void promptNow(sid, next.text, next.files);
    };
  }, [promptNow]);

  const abort = useCallback(async () => {
    if (!activeId) return;
    tracker.reset(activeId);
    // an aborted turn drops its pending ask — the server discards the
    // request with the run, so don't leave a popup pointing at a corpse
    questionsRef.current.delete(activeId);
    setQuestion((cur) => (cur?.sessionID === activeId ? null : cur));
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

  const answerQuestion = useCallback(
    async (answers: string[][]) => {
      if (!question) return;
      const ask = question;
      setQuestion(null);
      questionsRef.current.delete(ask.sessionID);
      playSound("send");
      try {
        const r = await serverFetch(`/question/${ask.id}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        });
        if (!r.ok) setError(`Failed to send answer (${r.status})`);
      } catch (e) {
        setError(String(e));
      }
    },
    [question],
  );

  const rejectQuestion = useCallback(async () => {
    if (!question) return;
    const ask = question;
    setQuestion(null);
    questionsRef.current.delete(ask.sessionID);
    await serverFetch(`/question/${ask.id}/reject`, { method: "POST" }).catch(() => {});
  }, [question]);

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

  const cycleAgent = useCallback(() => {
    if (!agents.length) return;
    const cur = agentSel || agents[0].name;
    const i = agents.findIndex((a) => a.name === cur);
    setAgentSel(agents[(i + 1) % agents.length].name);
    playSound("click");
  }, [agents, agentSel]);

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
    async (text: string, files?: Attachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && !files?.length) return;
      // attachments ride on a plain prompt — never parse as slash commands
      if (files?.length) {
        await send(trimmed, files);
        return;
      }
      const handled = await handleSlash(trimmed, {
        activeId: activeRef.current,
        sessions,
        agents,
        agentSel,
        variantSel: prov.variantSel,
        modelSel: prov.modelSel,
        defaultModel: prov.defaultModel,
        modelVariants: prov.modelVariants,
        commands,
        undoTarget,
        revertId,
        isBusy: (id) => busyRef.current.has(id),
        setBusy: (id, on) => tracker.markBusy(id, on),
        setError,
        openDialog: setDialog,
        onRegistryCommand: () => {
          prov.sentExplicitModel.current = false;
        },
        newSession,
        revertTo,
        unrevert,
        cycleAgent,
        refreshSessions,
        openSession,
      });
      if (!handled) await send(text);
    },
    [
      commands,
      send,
      newSession,
      revertTo,
      unrevert,
      undoTarget,
      revertId,
      sessions,
      agents,
      agentSel,
      cycleAgent,
      prov.modelSel,
      prov.defaultModel,
      prov.modelVariants,
      prov.variantSel,
    ],
  );

  const cmdList = useMemo<CmdEntry[]>(
    () =>
      buildCmdList(commands, {
        agents,
        agentSel,
        modelVariants: prov.modelVariants,
        variantSel: prov.variantSel,
      }),
    [commands, agents, agentSel, prov.modelVariants, prov.variantSel],
  );

  const removeSession = useCallback(
    async (id: string) => {
      const { client } = await opencode();
      await client.session.delete({ path: { id } }).catch(() => {});
      setSessions((prev) => prev.filter((s) => s.id !== id));
      store.remove(id);
      questionsRef.current.delete(id);
      tracker.reset(id);
      if (activeRef.current === id) {
        setActiveId("");
        store.clearStashes();
        setMsgs([]);
        setQuestion(null);
      }
    },
    [],
  );

  // clear every session in the current workspace — server delete + local reset
  const clearSessions = useCallback(async () => {
    const { client } = await opencode();
    const ids = sessionsRef.current.map((s) => s.id);
    await Promise.all(
      ids.map((id) => client.session.delete({ path: { id } }).catch(() => {})),
    );
    for (const id of ids) {
      store.remove(id);
      questionsRef.current.delete(id);
      tracker.reset(id);
    }
    setActiveId("");
    store.clearStashes();
    setMsgs([]);
    setQuestion(null);
  }, [store, tracker]);

  // the active session's busy state, derived from the per-session set
  const busy = busyIds.has(activeId);

  return {
    error,
    live,
    booting,
    sessions,
    busyIds,
    defaultModel: prov.defaultModel,
    activeId,
    msgs: visibleMsgs,
    revertId,
    revertTo,
    unrevert,
    busy,
    providers: prov.providers as ProviderGroup[],
    modelSel: prov.modelSel,
    setModelSel: prov.setModelSel,
    permission,
    question,
    answerQuestion,
    rejectQuestion,
    newSession,
    openSession,
    clearSessions,
    send,
    submit,
    cmdList,
    refreshCommands,
    dialog,
    closeDialog: () => setDialog(null),
    agents,
    agentSel,
    cycleAgent,
    cycleVariant: prov.cycleVariant,
    variantSel: prov.variantSel,
    setVariantSel: prov.setVariantSel,
    modelVariants: prov.modelVariants,
    modelCaps: prov.modelCaps,
    queueCounts,
    sessionUsage,
    abort,
    respondToPermission,
    removeSession,
  };
}

