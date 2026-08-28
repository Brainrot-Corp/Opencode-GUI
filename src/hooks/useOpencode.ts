import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, Session } from "@opencode-ai/sdk/client";
import {
  opencode,
  getDirectory,
  serverFetch,
  hiddenSessions,
  HIDDEN_TITLE,
  withDeadline,
} from "../api";
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
import { clearDraft, setDraft } from "../lib/drafts";
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
  // sessions being compacted — server-driven (auto or /compact), surfaced
  // as a per-session indicator like busyIds but with its own dot/line
  const [compactingIds, setCompactingIds] = useState<Set<string>>(new Set());
  // pending asks, kept per session — returning to a session resurfaces
  // its popup (both permissions and questions outlive session switches)
  const questionsRef = useRef<Map<string, QuestionAsk>>(new Map());
  const [question, setQuestion] = useState<QuestionAsk | null>(null);
  const permissionsRef = useRef<Map<string, PermAsk>>(new Map());
  const [permission, setPermission] = useState<PermAsk | null>(null);
  // sidebar attention: which sessions need a click (permission or question)
  const [attentionIds, setAttentionIds] = useState<Set<string>>(new Set());
  const [attentionKinds, setAttentionKinds] = useState<Record<string, "permission" | "question" | "both">>({});
  const [commands, setCommands] = useState<Cmd[]>([]);
  const [agents, setAgents] = useState<{ name: string; mode: string }[]>([]);
  const [agentSel, setAgentSel] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({});
  const [live, setLive] = useState(false);
  const [booting, setBooting] = useState(true);

  const prov = useProviders(setError, activeId);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const busyRef = useRef(busyIds);
  busyRef.current = busyIds;
  const compactingRef = useRef(compactingIds);
  compactingRef.current = compactingIds;
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

  // mirror the active session's pending asks (if any) into state
  const showQuestion = (sid: string) => {
    if (sid !== activeRef.current) return;
    setQuestion(questionsRef.current.get(sid) ?? null);
  };
  const showPermission = (sid: string) => {
    if (sid !== activeRef.current) return;
    setPermission(permissionsRef.current.get(sid) ?? null);
  };

  // sidebar attention sync — drives per-session icon + collapsed badge
  const syncAttention = useCallback((sid: string) => {
    if (!sid) return;
    const hasPerm = permissionsRef.current.has(sid);
    const hasQ = questionsRef.current.has(sid);
    const kind = hasPerm && hasQ ? ("both" as const) : hasPerm ? ("permission" as const) : hasQ ? ("question" as const) : null;
    setAttentionIds((prev) => {
      const has = prev.has(sid);
      if (!!kind === has) return prev;
      const next = new Set(prev);
      if (kind) next.add(sid);
      else next.delete(sid);
      return next;
    });
    setAttentionKinds((prev) => {
      if (!kind) {
        if (!(sid in prev)) return prev;
        const { [sid]: _omit, ...rest } = prev as Record<string, unknown>;
        return rest as Record<string, "permission" | "question" | "both">;
      }
      if (prev[sid] === kind) return prev;
      return { ...prev, [sid]: kind };
    });
  }, []);
  const clearAttention = useCallback((sid: string) => {
    if (!sid) return;
    setAttentionIds((prev) => {
      if (!prev.has(sid)) return prev;
      const next = new Set(prev);
      next.delete(sid);
      return next;
    });
    setAttentionKinds((prev) => {
      if (!(sid in prev)) return prev;
      const { [sid]: _omit, ...rest } = prev as Record<string, unknown>;
      return rest as Record<string, "permission" | "question" | "both">;
    });
  }, []);

  const markCompacting = useCallback((sid: string, on: boolean) => {
    if (!sid) return;
    setCompactingIds((prev) => {
      const has = prev.has(sid);
      if (has === on) return prev;
      const next = new Set(prev);
      if (on) next.add(sid);
      else next.delete(sid);
      return next;
    });
  }, []);

  const LAST_KEY = "oc.lastSes";
  const PINNED_KEY = "oc.pinnedSessions";
  const TITLE_OVERRIDES_KEY = "oc.sessionTitles";

  function getPinned(): Set<string> {
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === "string") : []);
    } catch { return new Set(); }
  }
  function getTitleOverrides(): Record<string, string> {
    try {
      const raw = localStorage.getItem(TITLE_OVERRIDES_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" && !Array.isArray(obj) ? obj as Record<string,string> : {};
    } catch { return {}; }
  }
  function applyOverrides(list: Session[]): Session[] {
    const overrides = getTitleOverrides();
    const pinned = getPinned();
    const mapped = list.map((s) => overrides[s.id] ? { ...s, title: overrides[s.id] } : s);
    // defensive dedup — protects against the optimistic + SSE race where
    // session.created arrives before/after newSession's insertion
    const seen = new Set<string>();
    const deduped: Session[] = [];
    for (const s of mapped) if (!seen.has(s.id)) { seen.add(s.id); deduped.push(s); }
    // pinned first, then by created desc
    const p = pinned;
    return deduped.sort((a, b) => {
      const pa = p.has(a.id) ? 1 : 0;
      const pb = p.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.time?.created ?? 0) - (a.time?.created ?? 0);
    });
  }

  const refreshSessions = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.session.list();
    // most recently created first; helper sessions (summary/debrief/commit
    // gen) are dropped — live-tracked ids plus title-marked crash orphans
    const list = ((r.data ?? []) as Session[])
      .filter((s) => !hiddenSessions.has(s.id) && s.title !== HIDDEN_TITLE && !(s as any).parentID);
    const out = applyOverrides(list);
    setSessions(out);
    return out;
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
    activeRef.current = id;
    setActiveId(id);
    setPermission(permissionsRef.current.get(id) ?? null);
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
      // generic compaction fallback — covers any future naming variant
      if (typeof e.type === "string" && e.type.includes("compaction")) {
        const sid = p.sessionID ?? p.id;
        if (sid) {
          if (e.type.endsWith(".started") || e.type.endsWith(".delta")) markCompacting(sid, true);
          else if (e.type.endsWith(".ended") || e.type === "session.compacted") markCompacting(sid, false);
        }
      }
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
        case "permission.v2.asked": {
          // {id, sessionID, permission|action|type, metadata, patterns}
          const ask: PermAsk = {
            id: p.id,
            sessionID: p.sessionID,
            type: p.permission ?? p.action ?? p.type ?? "permission",
            title:
              p.metadata?.command ||
              p.metadata?.title ||
              p.title ||
              (p.patterns ?? []).join(", ") ||
              (p.permission ?? p.action ?? p.type ?? "permission"),
          };
          permissionsRef.current.set(p.sessionID, ask);
          syncAttention(p.sessionID);
          playSound("attention");
          if (p.sessionID === activeRef.current) setPermission(ask);
          break;
        }
        case "permission.updated": {
          const ask: PermAsk = {
            id: p.id ?? p.permissionID ?? p.requestID,
            sessionID: p.sessionID,
            type: p.type ?? p.permission ?? "permission",
            title: p.title ?? p.type ?? p.permission ?? "permission",
          };
          if (!ask.sessionID || !ask.id) break;
          permissionsRef.current.set(ask.sessionID, ask);
          syncAttention(ask.sessionID);
          if (ask.sessionID === activeRef.current) setPermission(ask);
          break;
        }
        case "permission.replied":
        case "permission.v2.replied": {
          const pid = p.permissionID ?? p.requestID ?? p.id;
          const sid = p.sessionID;
          const affected = new Set<string>();
          if (pid) {
            for (const [s, perm] of [...permissionsRef.current])
              if (perm.id === pid) { permissionsRef.current.delete(s); affected.add(s); }
          } else if (sid) {
            if (permissionsRef.current.has(sid)) affected.add(sid);
            permissionsRef.current.delete(sid);
          }
          for (const s of affected) syncAttention(s);
          if (!affected.size && sid) syncAttention(sid);
          setPermission((cur) =>
            cur && (cur.id === pid || (sid && cur.sessionID === sid)) ? null : cur,
          );
          break;
        }
        case "question.asked":
        case "question.v2.asked": {
          // question tool ask: {id, sessionID, questions:[{question,header,options,multiple?,custom?}]}
          const ask: QuestionAsk = {
            id: p.id ?? p.requestID,
            sessionID: p.sessionID,
            questions: Array.isArray(p.questions) ? p.questions : [],
          };
          if (!ask.sessionID || !ask.id) break;
          questionsRef.current.set(p.sessionID, ask);
          syncAttention(p.sessionID);
          playSound("attention");
          if (p.sessionID === activeRef.current) setQuestion(ask);
          break;
        }
        case "question.replied":
        case "question.v2.replied":
        case "question.rejected":
        case "question.v2.rejected": {
          const qid = p.requestID ?? p.id;
          const affected = new Set<string>();
          if (qid) {
            for (const [sid, q] of [...questionsRef.current])
              if (q.id === qid) { questionsRef.current.delete(sid); affected.add(sid); }
            setQuestion((cur) => (cur && cur.id === qid ? null : cur));
          } else if (p.sessionID) {
            if (questionsRef.current.has(p.sessionID)) affected.add(p.sessionID);
            questionsRef.current.delete(p.sessionID);
            setQuestion((cur) => (cur && cur.sessionID === p.sessionID ? null : cur));
          }
          for (const s of affected) syncAttention(s);
          if (!affected.size && p.sessionID) syncAttention(p.sessionID);
          break;
        }
        case "session.idle":
          // settles the turn only when no assistant message is still live —
          // mid-turn idles in heavier tasks are ignored
          if (!tracker.hasInflight(p.sessionID)) tracker.settle(p.sessionID);
          break;
        // compaction live indicator — server decides when to compact (auto
        // or manual /compact); we just surface its progress per-session
        case "session.compacted":
          if (p.sessionID) markCompacting(p.sessionID, false);
          break;
        case "session.next.compaction.started":
          if (p.sessionID) markCompacting(p.sessionID, true);
          break;
        case "session.next.compaction.delta":
          if (p.sessionID) markCompacting(p.sessionID, true);
          break;
        case "session.next.compaction.ended":
          if (p.sessionID) markCompacting(p.sessionID, false);
          break;
        case "session.created": {
          const s = p.info as Session | undefined;
          if (!s?.id) break;
          if ((s as any).parentID) break;
          if (hiddenSessions.has(s.id) || s.title === HIDDEN_TITLE) break;
          const overrides = getTitleOverrides();
          const patched = overrides[s.id] ? { ...s, title: overrides[s.id] } : s;
          setSessions((prev) => {
            if (prev.some((x) => x.id === patched.id)) return prev;
            return applyOverrides([...prev, patched]);
          });
          break;
        }
        case "session.updated": {
          // server-side metadata changes — auto-generated titles after the
          // first reply, pin/archive flags — must reach the sidebar live
          const s = p.info as Session | undefined;
          if (!s?.id) break;
          if ((s as any).parentID) break;
          if (hiddenSessions.has(s.id) || s.title === HIDDEN_TITLE) break;
          const overrides = getTitleOverrides();
          const pinned = getPinned();
          const patched = overrides[s.id] ? { ...s, title: overrides[s.id] } : s;
          setSessions((prev) => {
            const i = prev.findIndex((x) => x.id === patched.id);
            if (i < 0) return prev;
            const next = prev.map((x, j) => (j === i ? patched : (overrides[x.id] ? { ...x, title: overrides[x.id] } : x)));
            return next.sort((a, b) => {
              const pa = pinned.has(a.id) ? 1 : 0;
              const pb = pinned.has(b.id) ? 1 : 0;
              if (pa !== pb) return pb - pa;
              return (b.time?.created ?? 0) - (a.time?.created ?? 0);
            });
          });
          break;
        }
        case "session.deleted": {
          const delId = p.sessionID ?? p.id;
          if (delId) {
            store.remove(delId);
            tracker.reset(delId);
            markCompacting(delId, false);
            clearDraft(delId);
            questionsRef.current.delete(delId);
            permissionsRef.current.delete(delId);
            clearAttention(delId);
            if (delId === activeRef.current) {
              setQuestion(null);
              setPermission(null);
            }
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
            // relay for the file viewer's external-change detection
            window.dispatchEvent(new CustomEvent("oc:file-changed", { detail: path }));
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
      // until the sidecar actually answers a real request. Each attempt is
      // deadline-wrapped — a stalled request (sidecar accepts TCP but hangs)
      // must reject so the loop can retry instead of freezing mid-await.
      let list: Session[] = [];
      const bootStarted = Date.now();
      while (!disposed) {
        try {
          list = await withDeadline(refreshSessions(), 10_000, "session list");
          break;
        } catch (e) {
          // cold start gets ~20s; past that, surface why and boot anyway
          // (phase 2 + finally still run, degrading to a banner not skeletons)
          if (Date.now() - bootStarted > 20_000 && !disposed) {
            setError(`Server not responding: ${e}`);
            break;
          }
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
        // deadline-wrapped: a hung messages fetch must not stall the boot
        // effect before its finally (loadProviders + setBooting(false))
        if (target && !disposed)
          await withDeadline(openSession(target.id), 15_000, "session reopen").catch(() => {});

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
            const touched = new Set<string>();
            for (const q of list ?? []) if (q.sessionID) { questionsRef.current.set(q.sessionID, q); touched.add(q.sessionID); }
            for (const sid of touched) syncAttention(sid);
            showQuestion(activeRef.current);
          })
          .catch(() => {});
        // same for permissions — best-effort (endpoint may not exist in older server)
        serverFetch("/permission")
          .then((r) => (r.ok ? r.json() : null))
          .then((list: any) => {
            if (disposed || !list) return;
            const arr = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
            const touched = new Set<string>();
            for (const p of arr) {
              const ask: PermAsk = {
                id: p.id,
                sessionID: p.sessionID,
                type: p.permission ?? p.type ?? "permission",
                title: p.metadata?.command ?? p.metadata?.title ?? p.title ?? p.type ?? "permission",
              };
              if (ask.sessionID && ask.id) { permissionsRef.current.set(ask.sessionID, ask); touched.add(ask.sessionID); }
            }
            for (const sid of touched) syncAttention(sid);
            showPermission(activeRef.current);
          })
          .catch(() => {});
        // v2 permission request list fallback
        serverFetch("/api/permission/request")
          .then((r) => (r.ok ? r.json() : null))
          .then((res: any) => {
            if (disposed || !res) return;
            const arr = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
            const touched = new Set<string>();
            for (const p of arr) {
              const ask: PermAsk = {
                id: p.id,
                sessionID: p.sessionID,
                type: p.permission ?? p.action ?? p.type ?? "permission",
                title: p.metadata?.command ?? p.metadata?.title ?? (p.patterns ?? []).join(", ") ?? "permission",
              };
              if (ask.sessionID && ask.id) { permissionsRef.current.set(ask.sessionID, ask); touched.add(ask.sessionID); }
            }
            for (const sid of touched) syncAttention(sid);
            showPermission(activeRef.current);
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

  // keep the command registry + provider list warm across workspace switches
  // done elsewhere. Provider refetch self-heals a transient boot failure that
  // would otherwise leave an empty model picker until relaunch.
  useEffect(() => {
    const onFocus = () => {
      refreshCommands().catch(() => {});
      opencode()
        .then(({ client }) => prov.loadProviders(client))
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshCommands, prov.loadProviders]);

  // periodic nudge while any session needs attention — pop every 10s until acted on
  // ponytail: nudge interval tuning lives here
  useEffect(() => {
    if (attentionIds.size === 0) return;
    const id = window.setInterval(() => playSound("attention"), 10_000);
    return () => clearInterval(id);
  }, [attentionIds.size]);

  const newSession = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.session.create({ body: {} });
    const s = r.data as Session;
    localStorage.setItem(LAST_KEY, s.id);
    activeRef.current = s.id;
    setSessions((prev) => {
      if (prev.some((x) => x.id === s.id)) return prev;
      const overrides = getTitleOverrides();
      const patched = overrides[s.id] ? { ...s, title: overrides[s.id] } : s;
      return applyOverrides([...prev, patched]);
    });
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
    markCompacting(activeId, false);
    // an aborted turn drops its pending asks — the server discards the
    // requests with the run, so don't leave popups pointing at corpses
    questionsRef.current.delete(activeId);
    setQuestion((cur) => (cur?.sessionID === activeId ? null : cur));
    permissionsRef.current.delete(activeId);
    setPermission((cur) => (cur?.sessionID === activeId ? null : cur));
    clearAttention(activeId);
    const { client } = await opencode();
    await client.session.abort({ path: { id: activeId } }).catch(() => {});
  }, [activeId, markCompacting, clearAttention]);

  const respondToPermission = useCallback(
    async (response: "once" | "always" | "reject") => {
      if (!permission) return;
      const perm = permission;
      permissionsRef.current.delete(perm.sessionID);
      setPermission(null);
      syncAttention(perm.sessionID);
      const { client } = await opencode();
      await client
        .postSessionIdPermissionsPermissionId({
          path: { id: perm.sessionID, permissionID: perm.id },
          body: { response },
        })
        .catch((e) => setError(String(e)));
    },
    [permission, syncAttention],
  );

  const answerQuestion = useCallback(
    async (answers: string[][]) => {
      if (!question) return;
      const ask = question;
      setQuestion(null);
      questionsRef.current.delete(ask.sessionID);
      syncAttention(ask.sessionID);
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
    [question, syncAttention],
  );

  const rejectQuestion = useCallback(async () => {
    if (!question) return;
    const ask = question;
    setQuestion(null);
    questionsRef.current.delete(ask.sessionID);
    syncAttention(ask.sessionID);
    await serverFetch(`/question/${ask.id}/reject`, { method: "POST" }).catch(() => {});
  }, [question, syncAttention]);

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
      // capture text of the rewound segment to paste into composer input
      let pasteText = "";
      try {
        const all = store.cached(id) ?? msgs;
        const idx = all.findIndex((m: any) => m.info?.id === messageID);
        if (idx >= 0) {
          const after = all.slice(idx + 1);
          const userAfter = after.filter((m: any) => m.info?.role === "user");
          const extract = (m: any): string => {
            const parts: any[] = m.parts ?? [];
            return parts
              .filter((p: any) => p.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text.trim())
              .filter(Boolean)
              .join("\n");
          };
          if (userAfter.length) {
            pasteText = userAfter.map(extract).filter(Boolean).join("\n\n");
          } else {
            // no later user messages — use the target message itself for editing
            const target = all[idx];
            if (target?.info?.role === "user") pasteText = extract(target);
          }
        }
      } catch {}
      const { client } = await opencode();
      await client.session.revert({ path: { id }, body: { messageID } }).catch(() => {});
      await refreshSessions().catch(() => {});
      await openSession(id).catch(() => {});
      if (pasteText) {
        // persist to drafts so it survives reloads, and notify composer via event
        try { setDraft(id, pasteText); } catch {}
        window.dispatchEvent(new CustomEvent("oc:rewind-input", { detail: pasteText }));
      }
    },
    [refreshSessions, openSession, msgs],
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

  // picker entry: applies the choice globally AND remembers it for the
  // session it was made in (so switching back re-applies it)
  const selectModel = useCallback(
    (v: string) => {
      prov.rememberSession(activeRef.current, v);
      prov.setModelSel(v);
    },
    [prov.rememberSession, prov.setModelSel],
  );

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
      permissionsRef.current.delete(id);
      clearAttention(id);
      markCompacting(id, false);
      tracker.reset(id);
      clearDraft(id);
      if (activeRef.current === id) {
        setActiveId("");
        store.clearStashes();
        setMsgs([]);
        setQuestion(null);
        setPermission(null);
      }
    },
    [markCompacting, clearAttention],
  );

  const renameSession = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim().slice(0, 120);
    if (!trimmed) return;
    try {
      const { client } = await opencode();
      // try server update — if available
      const api: any = (client as any).session;
      if (api && typeof api.update === "function") {
        await api.update({ path: { id }, body: { title: trimmed } }).catch(async () => {
          // fallback to overrides
          throw new Error("update failed");
        });
        // server will emit session.updated — optimistically update too
        setSessions((prev) => applyOverrides(prev.map((s) => s.id === id ? { ...s, title: trimmed } : s)));
        return;
      }
      throw new Error("no update");
    } catch {
      // oc override
      try {
        const raw = localStorage.getItem(TITLE_OVERRIDES_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        const map = obj && typeof obj === "object" ? obj : {};
        map[id] = trimmed;
        localStorage.setItem(TITLE_OVERRIDES_KEY, JSON.stringify(map));
      } catch {}
      setSessions((prev) => applyOverrides(prev.map((s) => s.id === id ? { ...s, title: trimmed } : s)));
    }
  }, []);

  const duplicateSession = useCallback(async (id: string) => {
    const { client } = await opencode();
    const r: any = await (client.session as any).fork({ path: { id } });
    const s = r.data as Session;
    await refreshSessions();
    await openSession(s.id);
    return s.id;
  }, [refreshSessions, openSession]);

  const togglePin = useCallback((id: string) => {
    try {
      const set = getPinned();
      if (set.has(id)) set.delete(id); else set.add(id);
      localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
      setSessions((prev) => applyOverrides([...prev]));
    } catch {}
  }, []);

  const isPinned = useCallback((id: string) => getPinned().has(id), []);

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
      permissionsRef.current.delete(id);
      clearAttention(id);
      markCompacting(id, false);
      tracker.reset(id);
      clearDraft(id);
    }
    setActiveId("");
    store.clearStashes();
    setMsgs([]);
    setQuestion(null);
    setPermission(null);
    setCompactingIds(new Set());
  }, [store, tracker, markCompacting, clearAttention]);

  // the active session's busy/compacting state, derived from per-session sets
  const busy = busyIds.has(activeId);
  const compacting = compactingIds.has(activeId);

  return {
    error,
    live,
    booting,
    sessions,
    busyIds,
    compactingIds,
    attentionIds,
    attentionKinds,
    compacting,
    defaultModel: prov.defaultModel,
    activeId,
    msgs: visibleMsgs,
    revertId,
    revertTo,
    unrevert,
    busy,
    providers: prov.providers as ProviderGroup[],
    modelSel: prov.modelSel,
    setModelSel: selectModel,
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
    renameSession,
    duplicateSession,
    togglePin,
    isPinned,
  };
}

