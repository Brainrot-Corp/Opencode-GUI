import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@opencode-ai/sdk/client";
import type {
  FilePartInput,
  OpencodeClient,
  SessionPromptAsyncData,
  TextPartInput,
} from "@opencode-ai/sdk/client";
import {
  opencode,
  opencodeFor,
  baseFor,
  evictRemoteBase,
  getDirectory,
  serverFetch,
  withDeadline,
  resetOpencodeCache,
} from "../api";
import { isRemoteDir, remoteStatus, serverDir } from "../lib/remotes";
import { playSound } from "../lib/sounds";
import { createSessionStore } from "../lib/sessionStore";
import { splitModel } from "../lib/models";
import { DEBUG_PREFIX, fakeSession, makeFakeMessages, parseDebugCount } from "../lib/debugSession";
import { touchWorkspace } from "../lib/workspace";
import { normWorkspace } from "../lib/platform";
import { windowKey } from "../lib/windowScope";
import { createBusyTracker } from "../lib/busyTracker";
import {
  buildCmdList,
  handleSlash,
  type DialogState,
} from "../lib/slashCommands";
import { getPluginSlash } from "../lib/plugins";
import {
  PINNED_KEY,
  TITLE_OVERRIDES_KEY,
  getTitleOverrides,
  invalidatePinned,
  invalidateTitleOverrides,
  togglePinned,
  isPinned as isPinnedMeta,
  writeTitleOverride,
  applyOverrides,
} from "../lib/sessionMeta";
import { handleOpenCodeEvent, type OpenCodeEventCtx } from "../lib/opencodeEvents";
import { ensureServerGroups, useProviders } from "./useProviders";
import { useSecurity, type SecurityMode } from "./useSecurity";
import { useAsks } from "./useAsks";
import { useAgents } from "./useAgents";
import { useWorkspaceSessions, addDebugSession, dropDebugSession } from "./useWorkspaceSessions";
import { useSessionUsage } from "./useSessionUsage";
import { clearDraft, getDraft, setDraft } from "../lib/drafts";
import { clearAttachmentDraft, restoreAttachmentDraft } from "./useAttachments";
import { pushToast } from "./useToast";
import type { Msg, OpenCodeEvent, PermAsk, ProviderGroup, Attachment, QuestionAsk, Cmd } from "../types";

// resolve the right server client for a workspace dir ("" = server cwd).
// api.ts's Proxy wrap() erases the SDK shape in its return type but preserves
// it at runtime — retype once here (same pattern as useProviders' OcClient)
// instead of casting at every call site.
type OcClient = OpencodeClient;
const clientFor = async (dir?: string): Promise<{ base: string; client: OcClient }> =>
  dir ? await opencodeFor(dir) : await opencode();

// per-session agent memory + per-window global agent live in useAgents.ts
// (mirrors useProviders model logic)

// re-exported: composer + command dialog import the type from here
export type { CmdEntry } from "../lib/slashCommands";

// remotes already toasted as down this session — a dead host's dial retry
// loop would toast constantly; notify once per outage, not once per retry
const remoteDownToasted = new Set<string>();

// pending asks + security state live in useAsks / useSecurity (composed below)
export function useOpencode() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // sessions with an in-flight prompt — tracked per session so background
  // streams keep their state (and the sidebar can show an indicator)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // sessions being compacted — server-driven (auto or /compact), surfaced
  // as a per-session indicator like busyIds but with its own dot/line
  const [compactingIds, setCompactingIds] = useState<Set<string>>(new Set());

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  // stable read for callbacks that must not change identity per delta
  // (msgs in deps would defeat MsgRow memo → whole history re-renders while streaming)
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const busyRef = useRef(busyIds);
  busyRef.current = busyIds;
  const compactingRef = useRef(compactingIds);
  compactingRef.current = compactingIds;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // command-registry refetch throttle for file-watcher bursts
  const baseRef = useRef("");
  const sessionDirRef = useRef<Map<string, string>>(new Map());

  const prov = useProviders(activeId);

  const sec = useSecurity({ activeRef, activeId });
  const {
    securityMode,
    securityModeRef,
    sessionSecurity,
    setSecurityMode,
    cycleSecurityMode,
    getSecurityModeFor,
    rememberSecuritySession,
    forgetSecuritySession,
  } = sec;

  const asks = useAsks({ activeRef, sessionDirRef, clientFor, getSecurityModeFor });
  const {
    questionsRef,
    permissionsRef,
    childParentRef,
    question,
    permission,
    setQuestion,
    setPermission,
    attentionIds,
    attentionKinds,
    topOfSession,
    syncTopBadge,
    resolveParent,
    syncAttention,
    clearAttention,
    emitQuestion,
    emitPermission,
    subscribeQuestion,
    subscribePermission,
    peekQuestion,
    peekPermission,
    showQuestion,
    showPermission,
    handlePermAsk,
    handleQuestionAsk,
    clearPermissionAsk,
    clearQuestionAsk,
    clearAskState,
    clearSessionAsks,
    forgetLineage,
    autoRespondPermission,
    respondToPermissionFor,
    respondToPermission,
    answerQuestionFor,
    answerQuestion,
    rejectQuestionFor,
    rejectQuestion,
  } = asks;

  const [commands, setCommands] = useState<Cmd[]>([]);
  // plugin slash commands are aggregated in src/lib/plugins.ts slashStore;
  // cmdList is built from that store directly each render so autocomplete
  // never goes stale even if the oc:plugin-slash event fires before mount.
  const [agents, setAgents] = useState<{ name: string; mode: string }[]>([]);

  // per-session agent memory + picker wiring (registry list stays local)
  const agentMem = useAgents({ agents, activeRef, activeId });
  const {
    agentSel,
    sessionAgents,
    rememberAgentSession,
    forgetAgentSession,
    disabledAgents,
    toggleDisabledAgent,
    cycleAgent,
    selectAgent,
  } = agentMem;

  // sessions already warned about model fallback (model → warned model id)
  const modelFallbackWarned = useRef(new Map<string, string>());

  const [dialog, setDialog] = useState<DialogState>(null);
  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({});
  const [queuedBySession, setQueuedBySession] = useState<Record<string, import("../lib/busyTracker").QueuedPrompt[]>>({});
  const [live, setLive] = useState(false);
  const [booting, setBooting] = useState(true);

  // authoritative per-session message stores (SSE mutations land here
  // synchronously; only the active session mirrors into React state).
  // deltas arrive in bursts — coalesce mirrors into one setState per frame
  // or huge sessions re-render once per chunk instead of once per batch.
  const mirrorRaf = useRef(0);
  const mirrorPending = useRef<string | null>(null);
  useEffect(() => () => cancelAnimationFrame(mirrorRaf.current), []);
  const storeRef = useRef<ReturnType<typeof createSessionStore> | undefined>(undefined);
  // transient subscribers for non-active sessions (subagent viewer) — the
  // store already mutates for every sid, only the React mirror is
  // active-gated, so fan those updates out here instead of polling
  const storeListeners = useRef(new Map<string, Set<() => void>>());
  if (!storeRef.current) {
    storeRef.current = createSessionStore((sid) => {
      const subs = storeListeners.current.get(sid);
      if (subs) for (const cb of [...subs]) {
        try { cb(); } catch {}
      }
      if (sid !== activeRef.current) return;
      if (mirrorPending.current === sid) return;
      mirrorPending.current = sid;
      cancelAnimationFrame(mirrorRaf.current);
      mirrorRaf.current = requestAnimationFrame(() => {
        mirrorPending.current = null;
        const s = storeRef.current;
        const cur = activeRef.current;
        if (s && cur === sid) setMsgs(s.snapshot(sid));
      });
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
      onQueueChange: (sid, items) =>
        setQueuedBySession((prev) => {
          if (items === null) {
            if (!(sid in prev)) return prev;
            const next = { ...prev };
            delete next[sid];
            return next;
          }
          return { ...prev, [sid]: items };
        }),
      onSettle: (sid) => {
        tracker.markBusy(sid, false);
        playSound("reply");
        flushRef.current(sid);
      },
    });
  }
  const tracker = trackerRef.current;

  // last outbound prompt per session — restored into the composer when the
  // send fails (promptAsync throw) or the turn errors (session.error event).
  // Kept until restored/overwritten so a late session.error still finds it.
  const lastSentRef = useRef(new Map<string, { text: string; files?: Attachment[] }>());
  const restoreFailedInput = useCallback((sid: string) => {
    const last = lastSentRef.current.get(sid);
    if (!last) return;
    lastSentRef.current.delete(sid);
    // never clobber new typing: only fill a draft the user hasn't touched
    // since the send (live box is guarded the same way in the composer).
    if (last.text) {
      try { if (!getDraft(sid)) setDraft(sid, last.text); } catch {}
    }
    if (last.files?.length) restoreAttachmentDraft(sid, last.files);
    // background session: draft/cache only, live input untouched. Active
    // session: guarded restore path (composer skips when box non-empty).
    if (sid === activeRef.current && last.text) {
      window.dispatchEvent(new CustomEvent("oc:restore-input", { detail: last.text }));
    }
  }, []);


  // auto-responder sweep: security mode short-circuits drain pending asks
  // (re-runs whenever the mode/pins change — wired to useAsks + useSecurity)
  useEffect(() => {
    for (const ask of [...permissionsRef.current.values()]) {
      const mode = getSecurityModeFor(ask.sessionID);
      if (mode === "user") continue;
      const response: "always" | "reject" = mode === "full" ? "always" : "reject";
      permissionsRef.current.delete(ask.sessionID);
      syncAttention(ask.sessionID);
      void autoRespondPermission(ask, response);
    }
    if (permission && getSecurityModeFor(permission.sessionID) !== "user") {
      setPermission(null);
    }
  }, [securityMode, sessionSecurity, autoRespondPermission, syncAttention, getSecurityModeFor, permission]);

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

  const LAST_KEY = windowKey("oc.lastSes");
  // pinned sessions + title overrides are pure localStorage accessors in
  // lib/sessionMeta.ts (cached there; invalidated on every write) — the hook
  // only wires the cross-window storage invalidation.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PINNED_KEY) invalidatePinned();
      else if (e.key === TITLE_OVERRIDES_KEY) invalidateTitleOverrides();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // multi-workspace session listing (dir map, cross-server refresh, ws listener)
  const wss = useWorkspaceSessions({
    sessionDirRef,
    activeRef,
    LAST_KEY,
    clientFor,
    store,
    trackerRef,
    setActiveId,
    setSessions,
    setMsgs,
    markCompacting,
    askRefs: { permissionsRef, questionsRef, clearAttention, setQuestion, setPermission },
  });
  const { getAllDirs, getDirForSession, refreshSessions, guardedRefresh } = wss;

  // active-session children + cost/usage totals (event-driven refresh)
  const usage = useSessionUsage({
    activeId,
    busyIds,
    msgs,
    store,
    sessionDirRef,
    childParentRef,
    syncTopBadge,
    clientFor,
  });
  const { activeChildren, refreshActiveChildren, refreshChildrenRef, sessionUsage: usageStable, childTaskCosts } = usage;


  // one per-session teardown ritual — the single source for delete paths
  // (server event, sidebar remove, workspace/clear-all wipes). Also prunes
  // the maps older copies missed: childParentRef, debugSessions,
  // modelFallbackWarned, lastSentRef.
  const teardownSession = useCallback((id: string) => {
    if (!id) return;
    sessionDirRef.current.delete(id);
    dropDebugSession(id);
    modelFallbackWarned.current.delete(id);
    lastSentRef.current.delete(id);
    forgetLineage(id);
    store.remove(id);
    tracker.reset(id);
    markCompacting(id, false);
    clearDraft(id);
    clearAttachmentDraft(id);
    clearAskState(id);
    forgetSecuritySession(id);
    forgetAgentSession(id);
    prov.rememberSession(id, "");
    prov.forgetVariantSession(id);
  }, [store, tracker, markCompacting, forgetLineage, clearAskState, forgetSecuritySession, forgetAgentSession, prov.rememberSession, prov.forgetVariantSession]);


  // server registry: custom + plugin-registered + skill commands.
  // hot reload: refetched on "/" menu open, window focus, and .opencode
  // file-watcher events — but NEW command files only appear after a sidecar
  // restart (upstream scans command dirs once at startup; verified 2026-08-23)
  const refreshCommands = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.command.list();
    // ponytail: SDK command entry type is stale — no source/hints (types.ts Cmd)
    setCommands(((r.data ?? []) as any[]).map((c) => ({ ...(c as Cmd) })));
  }, []);

  // selectable agents (GET /agent) — hidden internals filtered out
  const refreshAgents = useCallback(async () => {
    const { client } = await opencode();
    const r = await client.app.agents();
    // ponytail: SDK agent entry type is stale — name/mode untyped
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

  // learn the server's real default from a reply we did NOT steer
  // (encapsulates prov.sentExplicitModel + prov.learnDefault for the SSE layer)
  const learnServerDefault = useCallback((providerID: string, modelID: string) => {
    if (prov.sentExplicitModel.current) return;
    prov.learnDefault(`${providerID}/${modelID}`);
  }, [prov.sentExplicitModel, prov.learnDefault]);

  // re-read provider/model lists after /connect saves credentials —
  // loadProvidersAll overwrites the per-server cache, so a new key shows
  // up in /models without a restart
  const refreshProviders = useCallback(async () => {
    try {
      const dirs = getAllDirs().filter((d) => d);
      await (prov as any).loadProvidersAll(clientFor, dirs).catch(() => {});
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAllDirs]);

  // fetch a session's history into the store — shared by openSession and
  // the subagent viewer. Mid-stream the SSE-mutated store is NEWER than any
  // fetch snapshot (opencode persists part text only at milestones), so a
  // busy session keeps its live store and seeds from fetch only if empty.
  const loadMessagesIntoStore = useCallback(async (sid: string, dirFor: string): Promise<Msg[]> => {
    const seq = store.beginFetch(sid);
    const { client } = await clientFor(dirFor);
    const r = await client.session.messages({ path: { id: sid } });
    if (store.isStale(sid, seq)) return store.cached(sid) ?? [];
    if (busyRef.current.has(sid)) {
      if (!store.cached(sid)?.length) {
        const list = r.data ?? [];
        store.setFetched(sid, list);
        return list;
      }
      return store.snapshot(sid);
    }
    const list = r.data ?? [];
    store.setFetched(sid, list);
    return list;
  }, []);

  // transient live view of a non-active session (subagent viewer): snapshot
  // for paint, subscription for per-delta streaming, prime for baseline
  const subscribeSession = useCallback((sid: string, cb: () => void): (() => void) => {
    let set = storeListeners.current.get(sid);
    if (!set) {
      set = new Set();
      storeListeners.current.set(sid, set);
    }
    set.add(cb);
    return () => {
      const s = storeListeners.current.get(sid);
      if (!s) return;
      s.delete(cb);
      if (!s.size) storeListeners.current.delete(sid);
    };
  }, []);
  const peekSession = useCallback((sid: string): Msg[] | undefined => {
    const cached = store.cached(sid);
    return cached ? [...cached] : undefined;
  }, []);
  const primeSession = useCallback(async (sid: string, dir: string): Promise<Msg[]> => {
    try {
      return await loadMessagesIntoStore(sid, dir);
    } catch {
      // offline: whatever SSE already delivered (possibly nothing yet)
      return store.cached(sid) ?? [];
    }
  }, [loadMessagesIntoStore]);

  const openSession = useCallback(async (id: string) => {
    localStorage.setItem(LAST_KEY, id);
    const dirForOpen = sessionDirRef.current.get(id);
    if (dirForOpen) touchWorkspace(dirForOpen);
    activeRef.current = id;
    setActiveId(id);
    setPermission(permissionsRef.current.get(id) ?? null);
    setQuestion(questionsRef.current.get(id) ?? null);
    // drop any coalesced SSE mirror — it belongs to the previous view and
    // must not clobber the fresh cached paint below
    cancelAnimationFrame(mirrorRaf.current);
    mirrorPending.current = null;
    // debug filler sessions exist only client-side — synthesize once, then
    // serve from the store; never touch the server for them
    if (id.startsWith(DEBUG_PREFIX)) {
      let list = store.cached(id);
      if (!list?.length) {
        const n = Number(id.slice(DEBUG_PREFIX.length).split("-")[0]) || 3000;
        list = makeFakeMessages(id, n);
        store.setFetched(id, list);
      }
      setMsgs([...list]);
      return;
    }
    const cached = store.cached(id);
    setMsgs(cached ? [...cached] : []);
    let list: Msg[];
    try {
      list = await loadMessagesIntoStore(id, dirForOpen ?? getDirectory());
    } catch {
      // offline / failed fetch: keep the cached paint, a later SSE delta or
      // revisit will fill the store (never leave a rejected openSession)
      return;
    }
    // user may have switched away while we were fetching — update the
    // session's store but never clobber another session's view
    if (activeRef.current === id) setMsgs(list);
  }, [loadMessagesIntoStore]);

  // /debug-long-session [count] — build a fake session full of filler and
  // open it, purely for exercising the history-loading systems
  const createDebugSession = useCallback(async (args: string) => {
    const n = parseDebugCount(args);
    const id = `${DEBUG_PREFIX}${n}-${Date.now()}`;
    const dir = getDirectory();
    const sess = { ...fakeSession(id, n), _dir: dir } as Session;
    addDebugSession(id, sess, dir);
    sessionDirRef.current.set(id, dir);
    setSessions((prev) => [...prev, sess]);
    await openSession(id);
  }, [openSession]);

  useEffect(() => {
    const esMap = new Map<string, EventSource>();
    let disposed = false;
    // assigned inside the boot IIFE; removed by the cleanup below
    let onWsChange: (() => void) | null = null;

    // SSE dispatch lives in src/lib/opencodeEvents.ts — ctx wires the
    // per-boot callbacks/refs/state-setters it mutates (all stable).
    const ctx: OpenCodeEventCtx = {
      store,
      tracker,
      busyRef,
      activeRef,
      childParentRef,
      sessionDirRef,
      getSecurityModeFor,
      autoRespondPermission,
      resolveParent,
      restoreFailedInput,
      handlePermAsk,
      handleQuestionAsk,
      clearPermissionAsk,
      clearQuestionAsk,
      syncAttention,
      emitPermission,
      emitQuestion,
      syncTopBadge,
      topOfSession,
      setPermission,
      setQuestion,
      setSessions,
      markCompacting,
      applyOverrides,
      teardownSession,
      refreshSessions,
      refreshCommands,
      refreshAgents,
      refreshChildrenRef,
      learnServerDefault,
    };
    const onEvent = (e: OpenCodeEvent, dirHint?: string) => handleOpenCodeEvent(e, ctx, dirHint);

    (async () => {
      // the UI renders immediately on skeletons. Phase 1: poll silently
      // until the sidecar actually answers a real request. Each attempt is
      // deadline-wrapped — a stalled request (sidecar accepts TCP but hangs)
      // must reject so the loop can retry instead of freezing mid-await.
      let list: Session[] = [];
      const bootStarted = Date.now();
      while (!disposed) {
        try {
          list = await withDeadline(refreshSessions(), 12_000, "session list");
          break;
        } catch (e) {
          // Rust now retries ports + waits for health (up to ~30s worst-case
          // on a contested port); give it a bit more than the old 20s.
          if (Date.now() - bootStarted > 30_000 && !disposed) {
            pushToast(`Server not responding: ${e}`);
            break;
          }
          // if the cached base was a dead port, clear it so the next
          // refreshSessions re-invokes server_url
          try { resetOpencodeCache(); } catch {}
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (disposed) return;

      try {
        const { base } = await opencode();
        baseRef.current = base;
        let currentBase = base;
        // one live SSE per workspace (5 max) — each filtered by ?directory=.
        // SSH workspaces resolve their own tunnel base (?directory= is the
        // remote-local path); dead tunnels evict + re-dial via reconcile().
        let liveCount = 0;
        const updateLive = () => setLive(liveCount > 0);
        const resolving = new Set<string>();
        const lastErrAt = new Map<string, number>();
        let pendingTimer = 0;
        let reconciling = false;
        let reconcileAgain = false;
        let lastProbeAt = 0;
        const addStream = async (d: string, baseVal: string) => {
          if (esMap.has(d) || resolving.has(d)) return;
          resolving.add(d);
          try {
            const b = isRemoteDir(d) ? await baseFor(d) : baseVal;
            if (disposed || esMap.has(d)) return;
            const sd = serverDir(d);
            const url = sd ? `${b}/event?directory=${encodeURIComponent(sd)}` : `${b}/event`;
            const es = new EventSource(url);
            es.onopen = () => { liveCount++; updateLive(); lastErrAt.delete(d); };
            es.onerror = () => {
              // EventSource auto-reconnects — reconcile only recovers what a
              // retry cannot (base change, dead SSH tunnel)
              lastErrAt.set(d, Date.now());
              scheduleReconcile(1200);
            };
            es.onmessage = (ev) => {
              try { onEvent(JSON.parse(ev.data), d); } catch {}
            };
            esMap.set(d, es);
            remoteDownToasted.delete(d);
          } catch (e) {
            if (!disposed && !remoteDownToasted.has(d)) {
              remoteDownToasted.add(d);
              pushToast(`SSH workspace unreachable: ${e}`);
            }
            // dial failed — retry on the next reconcile; baseFor's 15s
            // negative cache paces this far slower than the old 2s tick
            scheduleReconcile(200);
          } finally {
            resolving.delete(d);
          }
        };
        const setupSSE = (baseVal: string) => {
          for (const d of getAllDirs()) void addStream(d, baseVal);
        };
        // SSE + workspace reconciliation — replaces the 2s tick. Runs when:
        // an SSE errored (1.2s debounce), a workspace was added/removed
        // (oc:workspaces-changed), or a stream dial failed. Healthy open
        // streams are never touched; EventSource retries transient drops.
        const reconcile = async () => {
          if (disposed) return;
          // base-change check — only after an SSE error (per-cycle opencode()
          // awaits were the old 2s tick's main cost). resetOpencodeCache
          // re-invokes server_url so a respawned sidecar on a new port is found.
          let errored = false;
          for (const t of lastErrAt.values()) if (t > lastProbeAt) { errored = true; break; }
          if (errored) {
            lastProbeAt = Date.now();
            try { resetOpencodeCache(); } catch {}
            const r = await opencode().catch(() => null);
            if (r?.base && r.base !== baseRef.current) {
              for (const es of esMap.values()) es.close();
              esMap.clear();
              currentBase = r.base;
              baseRef.current = r.base;
              liveCount = 0;
              updateLive();
              lastErrAt.clear();
            }
          }
          const cur = getAllDirs();
          // drop dead SSH tunnels so the add pass below re-dials them —
          // only streams in a bad state (not open) are probed
          for (const d of cur) {
            if (!isRemoteDir(d) || !esMap.has(d) || resolving.has(d)) continue;
            if (esMap.get(d)?.readyState === 1) continue;
            try {
              const st = await remoteStatus(d).catch(() => null);
              if (st && !st.alive) {
                esMap.get(d)?.close();
                esMap.delete(d);
                evictRemoteBase(d);
                lastErrAt.delete(d);
              }
            } catch {}
          }
          // add new
          for (const d of cur) if (!esMap.has(d)) void addStream(d, baseRef.current || currentBase);
          // remove gone (closed workspace)
          for (const [d, es] of [...esMap]) if (!(cur as string[]).includes(d)) { es.close(); esMap.delete(d); }
        };
        const runReconcile = async () => {
          if (reconciling) { reconcileAgain = true; return; }
          reconciling = true;
          try { await reconcile(); }
          finally {
            reconciling = false;
            if (reconcileAgain && !disposed) { reconcileAgain = false; void runReconcile(); }
          }
        };
        const scheduleReconcile = (delay: number) => {
          if (disposed) return;
          if (pendingTimer) window.clearTimeout(pendingTimer);
          pendingTimer = window.setTimeout(() => {
            pendingTimer = 0;
            void runReconcile();
          }, delay);
        };
        const onWsChangeLocal = () => scheduleReconcile(0);
        window.addEventListener("oc:workspaces-changed", onWsChangeLocal);
        onWsChange = onWsChangeLocal;
        setupSSE(currentBase);

        const lastId = localStorage.getItem(LAST_KEY);
        const target = list.find((s) => s.id === lastId) ?? list[0];
        if (target && !disposed)
          await withDeadline(openSession(target.id), 15_000, "session reopen").catch(() => {});

        // models from every server (local + SSH remotes carry their own auth)
        if (!disposed) {
        const dirs = getAllDirs().filter((d) => d);
        await (prov as any).loadProvidersAll(clientFor, dirs).catch(() => {});
        }
      } catch (e) {
        if (!disposed) pushToast(`Connection error: ${e}`);
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
            for (const sid of touched) {
              syncAttention(sid);
              emitQuestion(sid);
              const top = topOfSession(sid);
              if (top !== sid) {
                syncTopBadge(top);
                if (!childParentRef.current.has(sid)) void resolveParent(sid);
              }
            }
            showQuestion(activeRef.current);
          })
          .catch(() => {});
        // same for permissions — best-effort (endpoint may not exist in older server)
        const bootPermTitle = (pr: any): string =>
          pr.metadata?.command ?? pr.metadata?.title ?? pr.title ?? pr.type ?? "permission";
        const handleBootPerms = (arr: any[]) => {
          const touched = new Set<string>();
          for (const p of arr) {
            if (!p.sessionID || !p.id) continue;
            const mode = getSecurityModeFor(p.sessionID);
            if (mode === "full" || mode === "block") {
              const resp: "always" | "reject" = mode === "full" ? "always" : "reject";
              const ask: PermAsk = {
                id: p.id,
                sessionID: p.sessionID,
                type: p.permission ?? p.type ?? p.action ?? "permission",
                title: bootPermTitle(p),
              };
              void autoRespondPermission(ask, resp);
              continue;
            }
            const ask: PermAsk = {
              id: p.id,
              sessionID: p.sessionID,
              type: p.permission ?? p.type ?? "permission",
              title: bootPermTitle(p),
            };
            permissionsRef.current.set(ask.sessionID, ask); touched.add(ask.sessionID);
          }
          for (const sid of touched) {
            syncAttention(sid);
            emitPermission(sid);
            const top = topOfSession(sid);
            if (top !== sid) {
              syncTopBadge(top);
              if (!childParentRef.current.has(sid)) void resolveParent(sid);
            }
          }
          showPermission(activeRef.current);
        };
        serverFetch("/permission")
          .then((r) => (r.ok ? r.json() : null))
          .then((list: any) => {
            if (disposed || !list) return;
            const arr = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
            handleBootPerms(arr);
          })
          .catch(() => {});
        // v2 permission request list fallback
        serverFetch("/api/permission/request")
          .then((r) => (r.ok ? r.json() : null))
          .then((res: any) => {
            if (disposed || !res) return;
            const arr = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
            handleBootPerms(arr);
          })
          .catch(() => {});

        if (!disposed) setBooting(false);
      }
    })();

    return () => {
      disposed = true;
      if (onWsChange) window.removeEventListener("oc:workspaces-changed", onWsChange);
      for (const es of esMap.values()) es.close();
      esMap.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSessions, openSession, refreshCommands, getAllDirs]);

  // keep the command registry + provider list warm across workspace switches
  // done elsewhere. Provider refetch self-heals a transient boot failure that
  // would otherwise leave an empty model picker until relaunch.
  useEffect(() => {
    const onFocus = () => {
      refreshCommands().catch(() => {});
      refreshAgents().catch(() => {});
      opencode()
        .then(({ client }) => prov.loadProviders(client))
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshCommands, refreshAgents, prov.loadProviders]);

  // periodic nudge while any session needs attention — pop every 10s until acted on
  // ponytail: nudge interval tuning lives here
  useEffect(() => {
    if (attentionIds.size === 0) return;
    const id = window.setInterval(() => playSound("attention"), 10_000);
    return () => clearInterval(id);
  }, [attentionIds.size]);

  const newSession = useCallback(async (dir?: string) => {
    const effDir = (dir ?? getDirectory()).trim();
    touchWorkspace(effDir);
    const { client } = await clientFor(effDir);
    const r = await client.session.create({ body: {} });
    const s = r.data as Session;
    sessionDirRef.current.set(s.id, effDir);
    localStorage.setItem(LAST_KEY, s.id);
    activeRef.current = s.id;
    setSessions((prev) => {
      if (prev.some((x) => x.id === s.id)) return prev;
      const overrides = getTitleOverrides();
      const patched = overrides[s.id] ? { ...s, title: overrides[s.id], _dir: effDir } as any : { ...s, _dir: effDir } as any;
      return applyOverrides([...prev, patched]);
    });
    setActiveId(s.id);
    // pin current chip values to the new session so it starts with last used
    // per-session values and doesn't flip when global changes later
    try {
      // remember current model as if picked — fallback to stored global /
      // server default so a new session is always pinned even before
      // providers finish loading (prevents following later global picks)
      let m = prov.modelSel;
      if (!m) try { m = localStorage.getItem(windowKey("oc.lastModel")) || ""; } catch {}
      if (!m) m = prov.defaultModel || "";
      if (m) prov.rememberSession(s.id, m);
      if (agentSel) rememberAgentSession(s.id, agentSel);
      if (securityModeRef.current) rememberSecuritySession(s.id, securityModeRef.current);
      if (prov.variantSel) prov.rememberVariantSession(s.id, prov.variantSel);
    } catch {}
    store.clearStashes();
    setMsgs([]);
    setPermission(null);
    setQuestion(null);
    return s.id;
  }, [prov.modelSel, prov.defaultModel, prov.variantSel, agentSel]);


  // fire a prompt on a specific session — callers ensure it isn't busy
  const promptNow = useCallback(
    async (sid: string, text: string, files?: Attachment[]) => {
      if (!sid || (!text && !files?.length)) return;
      if (!files?.length && text.trim().startsWith("/")) {
        store.addCommand(sid, text.trim());
        return;
      }
      // stash for restore if promptAsync throws or session.error arrives later
      lastSentRef.current.set(sid, { text, files });
      tracker.markBusy(sid, true);
      try {
        const dirFor = sessionDirRef.current.get(sid) ?? getDirectory();
        // make sure this server's models are known before the guard below
        // runs — boot skips servers whose tunnel isn't up yet, and without
        // this the guard would fail open on them forever
        await ensureServerGroups(clientFor, dirFor);
        const { client } = await clientFor(dirFor);
        const parts: (TextPartInput | FilePartInput)[] = [{ type: "text", text }];
        for (const f of files ?? [])
          parts.push({ type: "file", mime: f.mime, filename: f.filename, url: f.url });
        // ponytail: SDK prompt body type is stale — no `variant` field (server supports it)
        const body: NonNullable<SessionPromptAsyncData["body"]> & { variant?: string } = { parts };
        // the picker list is merged across servers — a model picked for one
        // may not exist on this session's. The server then dies SILENTLY
        // (no session.error, just idle), so fall back to its default instead
        // of sending a doomed model. Unknown servers fail open as before.
        let effModel = prov.modelSel;
        let effVariant = prov.variantSel;
        if (effModel && !prov.isModelOn(effModel, dirFor)) {
          effModel = "";
          effVariant = "";
          if (modelFallbackWarned.current.get(sid) !== prov.modelSel) {
            modelFallbackWarned.current.set(sid, prov.modelSel);
            pushToast(`Model ${prov.modelSel} isn't on this server — using its default instead.`);
          }
        }
        prov.sentExplicitModel.current = !!effModel;
        if (effModel) {
          const [providerID, modelID] = splitModel(effModel);
          body.model = { providerID, modelID };
        }
        if (agentSel) body.agent = agentSel;
        if (effVariant) body.variant = effVariant;
        await client.session.promptAsync({ path: { id: sid }, body });
      } catch (e) {
        tracker.reset(sid);
        // surface it in the history (synthetic error bubble) + toast
        store.addError(sid, String(e));
        pushToast(String(e));
        restoreFailedInput(sid);
      }
    },
    [prov.modelSel, prov.variantSel, prov.isModelOn, agentSel, restoreFailedInput],
  );

  // public entry: while the session is streaming, queue instead of dropping
  const send = useCallback(
    async (text: string, files?: Attachment[]) => {
      if (!activeId) return;
      const trimmed = text.trim();
      if (!trimmed && !files?.length) return;
      if (!files?.length && trimmed.startsWith("/")) {
        store.addCommand(activeId, trimmed);
        return;
      }
      if (busyRef.current.has(activeId)) {
        tracker.pushQueued(activeId, {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: trimmed,
          files,
          at: Date.now(),
        });
        playSound("send");
        return;
      }
      return promptNow(activeId, trimmed, files);
    },
    [activeId, promptNow],
  );

  // drain one queued prompt per settled turn — ONLY from tracker.onSettle after grace
  // hasInflight guard is safety for timer race; busyIds lags render so not used
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
    clearSessionAsks(activeId);
    const dirFor = sessionDirRef.current.get(activeId) ?? getDirectory();
    const { client } = await clientFor(dirFor);
    await client.session.abort({ path: { id: activeId } }).catch(() => {});
  }, [activeId, markCompacting, clearSessionAsks]);

  // session.revert cuts the conversation after the given message;
  // the active session's revert marker tells us where (and that) we rewound
  const revertId = sessions.find((s) => s.id === activeId)?.revert?.messageID ?? "";
  // hide everything past the rewind point (server still returns full history)
  const visibleMsgs = useMemo(() => {
    const base = !revertId ? msgs : (() => {
      const i = msgs.findIndex((m) => m.info.id === revertId);
      return i >= 0 ? msgs.slice(0, i + 1) : msgs;
    })();
    const q = queuedBySession[activeId] ?? [];
    if (!q.length) return base;
    const queued = q.map(
      (item) =>
        ({
          info: {
            id: item.id,
            sessionID: activeId,
            role: "user",
            time: { created: item.at, completed: item.at },
          },
          parts: [
            ...(item.text
              ? [{ id: `${item.id}-p`, type: "text", text: item.text, sessionID: activeId, messageID: item.id }]
              : []),
            ...(item.files ?? []).map((f, fi) => ({
              id: `${item.id}-f-${fi}`,
              type: "file",
              mime: f.mime,
              filename: f.filename,
              url: f.url,
              sessionID: activeId,
              messageID: item.id,
            })),
          ],
          _isQueued: true,
        }) as unknown as Msg,
    );
    return [...base, ...queued];
  }, [msgs, revertId, queuedBySession, activeId]);

  const revertTo = useCallback(
    async (messageID: string) => {
      const id = activeRef.current;
      if (!id) return;
      let pasteText = "";
      try {
        const all = store.cached(id) ?? msgsRef.current;
        const idx = all.findIndex((m: any) => m.info?.id === messageID);
        if (idx >= 0) {
          // put only the rewound-to message back in the composer, not every
          // user message the revert cut away
          const target = all[idx];
          if (target?.info?.role === "user") {
            const parts: any[] = target.parts ?? [];
            pasteText = parts
              .filter((p: any) => p.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text.trim())
              .filter(Boolean)
              .join("\n");
          }
        }
      } catch {}
      const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
      const { client } = await clientFor(dirFor);
      await client.session.revert({ path: { id }, body: { messageID } }).catch(() => {});
      await guardedRefresh().catch(() => {});
      await openSession(id).catch(() => {});
      if (pasteText) {
        try { setDraft(id, pasteText); } catch {}
        window.dispatchEvent(new CustomEvent("oc:rewind-input", { detail: pasteText }));
      }
    },
    [guardedRefresh, openSession],
  );

  const unrevert = useCallback(async () => {
    const id = activeRef.current;
    if (!id) return;
    const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
    const { client } = await clientFor(dirFor);
    await client.session.unrevert({ path: { id } }).catch(() => {});
    await guardedRefresh().catch(() => {});
    await openSession(id).catch(() => {});
  }, [guardedRefresh, openSession]);

  // picker entry: applies the choice globally AND remembers it for the
  // session it was made in (so switching back re-applies it)
  const selectModel = useCallback(
    (v: string, sid?: string) => {
      const target = sid ?? activeRef.current;
      // global last (oc.lastModel) via setModelSel effect + per-session pin
      if (target) prov.rememberSession(target, v);
      prov.setModelSel(v);
    },
    [prov.rememberSession, prov.setModelSel],
  );

  // /undo target: the user message to rewind TO — one before the last
  // exchange normally, one before the rewind point when already viewing an
  // earlier version. "" when there is nothing left to undo.
  // tail-walk: only the last couple of user messages are ever relevant, so
  // a 20k-message session costs O(tail) per frame, not a full-history filter
  const undoTarget = useMemo(() => {
    if (!activeId) return "";
    const isUser = (m: Msg) => m.info.role === "user" && !(m as any)._isCommand;
    if (!revertId) {
      let first = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!isUser(m)) continue;
        if (!first) {
          first = m.info.id;
          continue;
        }
        return m.info.id;
      }
      return "";
    }
    let seenRevert = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.info.id === revertId) {
        if (isUser(m)) seenRevert = true;
        continue;
      }
      if (!seenRevert) continue;
      if (isUser(m)) return m.info.id;
    }
    return "";
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
      const sidBefore = activeRef.current;
      // fake debug sessions live only in this window — sending would 404,
      // so hint instead (slash commands still work; they're local too)
      if (sidBefore.startsWith(DEBUG_PREFIX) && (files?.length || !trimmed.startsWith("/"))) {
        pushToast("This is a fake debug session — nothing is sent anywhere. Open a real session to prompt.");
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
        pluginSlash: getPluginSlash(),
        undoTarget,
        revertId,
        isBusy: (id) => busyRef.current.has(id),
        setBusy: (id, on) => tracker.markBusy(id, on),
        setError: pushToast,
        openDialog: setDialog,
        onRegistryCommand: () => {
          prov.sentExplicitModel.current = false;
        },
        // SlashCtx wants Promise<void>; the hook's newSession returns the id —
        // nobody consumes it here, so adapt instead of narrowing the public API
        newSession: async () => {
          await newSession();
        },
        revertTo,
        unrevert,
        cycleAgent,
        refreshSessions,
        openSession,
        getDirForSession,
        debugLongSession: createDebugSession,
      });
      if (!handled) {
        // any slash input stays local — display as command trace, never hit the model
        if (trimmed.startsWith("/")) {
          if (sidBefore) store.addCommand(sidBefore, trimmed);
          return;
        }
        await send(text);
      } else if (sidBefore) store.addCommand(sidBefore, trimmed);
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
      createDebugSession,
    ],
  );

  // memoized so the composer (its consumer) can stay memoized across
  // streaming frames — all deps are stable during a turn. pluginSlash's
  // identity is REPLACED (not mutated) by setSlashFrom, so it's a reliable dep.
  const pluginSlash = getPluginSlash();
  const cmdList = useMemo(
    () =>
      buildCmdList(commands, {
        agents,
        agentSel,
        modelVariants: prov.modelVariants,
        variantSel: prov.variantSel,
        pluginSlash,
      }),
    [commands, agents, agentSel, prov.modelVariants, prov.variantSel, pluginSlash],
  );

  const removeSession = useCallback(
    async (id: string) => {
      const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
      if (dirFor) touchWorkspace(dirFor);
      const { client } = await clientFor(dirFor);
      await client.session.delete({ path: { id } }).catch(() => {});
      teardownSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeRef.current === id) {
        setActiveId("");
        store.clearStashes();
        setMsgs([]);
        setQuestion(null);
        setPermission(null);
      }
    },
    [teardownSession],
  );

  const renameSession = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim().slice(0, 120);
    if (!trimmed) return;
    try {
      const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
      const { client } = await clientFor(dirFor);
      // try server update — on failure the fallback below wins
      await client.session.update({ path: { id }, body: { title: trimmed } });
      // server will emit session.updated — optimistically update too
      setSessions((prev) => applyOverrides(prev.map((s) => s.id === id ? { ...s, title: trimmed } : s)));
      return;
    } catch {
      // oc override — same validated reader the rest of the hook uses
      writeTitleOverride(id, trimmed);
      setSessions((prev) => applyOverrides(prev.map((s) => s.id === id ? { ...s, title: trimmed } : s)));
    }
  }, []);

  // copy per-session chip values (model/agent/security/variant) from the
  // source session onto the new one, falling back to the current globals —
  // shared by duplicate + fork
  const inheritChips = useCallback(
    (srcId: string, newId: string) => {
      try {
        const srcModel = (prov as any).sessionModels?.[srcId];
        if (srcModel) prov.rememberSession(newId, srcModel);
        else {
          let m: string = prov.modelSel || "";
          if (!m) try { m = localStorage.getItem(windowKey("oc.lastModel")) || ""; } catch {}
          if (!m) m = prov.defaultModel || "";
          if (m) prov.rememberSession(newId, m);
        }
        const srcAgent = sessionAgents[srcId];
        if (srcAgent) rememberAgentSession(newId, srcAgent);
        else if (agentSel) rememberAgentSession(newId, agentSel);
        const srcSec = sessionSecurity[srcId] as SecurityMode | undefined;
        if (srcSec) rememberSecuritySession(newId, srcSec);
        else if (securityModeRef.current) rememberSecuritySession(newId, securityModeRef.current);
        const srcVariant = (prov as any).sessionVariants?.[srcId];
        if (srcVariant) prov.rememberVariantSession(newId, srcVariant);
        else if (prov.variantSel) prov.rememberVariantSession(newId, prov.variantSel);
      } catch {}
    },
    [sessionAgents, sessionSecurity, agentSel, prov.modelSel, prov.defaultModel, prov.variantSel, prov.rememberSession, prov.rememberVariantSession, rememberAgentSession, rememberSecuritySession],
  );

  const duplicateSession = useCallback(async (id: string) => {
    const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
    const { client } = await clientFor(dirFor);
    const r = await client.session.fork({ path: { id } });
    const s = r.data as Session;
    sessionDirRef.current.set(s.id, dirFor);
    // duplicate inherits per-session chip values from source session
    inheritChips(id, s.id);
    await guardedRefresh();
    await openSession(s.id);
    return s.id;
  }, [guardedRefresh, openSession, inheritChips]);

  const forkFrom = useCallback(async (messageID: string) => {
    const id = activeRef.current;
    if (!id) return;
    let pasteText = "";
    try {
      const all = store.cached(id) ?? msgsRef.current;
      const target = all.find((m: any) => m.info?.id === messageID);
      if (target) {
        const parts: any[] = (target as any).parts ?? [];
        pasteText = parts
          .filter((p: any) => p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text.trim())
          .filter(Boolean)
          .join("\n");
      }
    } catch {}
    const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
    const { client } = await clientFor(dirFor);
    const r = await client.session.fork({ path: { id }, body: { messageID } });
    const s = r.data as Session;
    sessionDirRef.current.set(s.id, dirFor);
    // fork inherits per-session chip values from source session
    inheritChips(id, s.id);
    if (pasteText) {
      try { setDraft(s.id, pasteText); } catch {}
    }
    await guardedRefresh();
    await openSession(s.id);
    if (pasteText) {
      try { setDraft(s.id, pasteText); } catch {}
      window.dispatchEvent(new CustomEvent("oc:rewind-input", { detail: pasteText }));
    }
    return s.id;
  }, [guardedRefresh, openSession, inheritChips]);

  const togglePin = useCallback((id: string) => {
    togglePinned(id);
    setSessions((prev) => applyOverrides([...prev]));
  }, []);

  const isPinned = useCallback((id: string) => isPinnedMeta(id), []);

  const clearSessionsFor = useCallback(async (dir: string) => {
    if (dir) touchWorkspace(dir);
    const norm = normWorkspace(dir ?? "");
    const ids = sessionsRef.current
      .filter((s) => normWorkspace(sessionDirRef.current.get(s.id) ?? "") === norm)
      .map((s) => s.id);
    if (!ids.length) return;
    await Promise.all(
      ids.map(async (id) => {
        const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
        const { client } = await clientFor(dirFor);
        return client.session.delete({ path: { id } }).catch(() => {});
      }),
    );
    for (const id of ids) teardownSession(id);
    setSessions((prev) => prev.filter((s) => !ids.includes(s.id)));
    if (activeRef.current && ids.includes(activeRef.current)) {
      setActiveId("");
      store.clearStashes();
      setMsgs([]);
      setQuestion(null);
      setPermission(null);
      setCompactingIds(new Set());
    }
  }, [teardownSession]);

  // clear every session across all workspaces
  const clearSessions = useCallback(async () => {
    const ids = [...sessionsRef.current.map((s) => s.id)];
    await Promise.all(
      ids.map(async (id) => {
        const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
        const { client } = await clientFor(dirFor);
        return client.session.delete({ path: { id } }).catch(() => {});
      }),
    );
    for (const id of ids) teardownSession(id);
    setActiveId("");
    store.clearStashes();
    setMsgs([]);
    setQuestion(null);
    setPermission(null);
    setCompactingIds(new Set());
  }, [teardownSession]);

  // the active session's busy/compacting state, derived from per-session sets
  const busy = busyIds.has(activeId);
  const compacting = compactingIds.has(activeId);

  return {
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
    answerQuestionFor,
    rejectQuestionFor,
    peekQuestion,
    subscribeQuestion,
    newSession,
    openSession,
    subscribeSession,
    peekSession,
    primeSession,
    clearSessions,
    send,
    submit,
    cmdList,
    refreshCommands,
    refreshProviders,
    dialog,
    closeDialog: () => setDialog(null),
    agents,
    agentSel,
    setAgentSel: selectAgent,
    cycleAgent,
    disabledAgents,
    toggleDisabledAgent,
    refreshAgents,
    cycleVariant: prov.cycleVariant,
    variantSel: prov.variantSel,
    setVariantSel: prov.setVariantSel,
    modelVariants: prov.modelVariants,
    modelCaps: prov.modelCaps,
    queueCounts,
    sessionUsage: usageStable,
    activeChildren,
    childTaskCosts,
    refreshActiveChildren,
    abort,
    respondToPermission,
    respondToPermissionFor,
    peekPermission,
    subscribePermission,
    securityMode,
    setSecurityMode,
    cycleSecurityMode,
    removeSession,
    renameSession,
    duplicateSession,
    forkFrom,
    togglePin,
    isPinned,
    getDirForSession,
    refreshSessions,
    clearSessionsFor,
  };
}


