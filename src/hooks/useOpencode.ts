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
  serverFetchFor,
  hiddenSessions,
  HIDDEN_TITLE,
  withDeadline,
  resetOpencodeCache,
} from "../api";
import { isRemoteDir, remoteStatus, serverDir } from "../lib/remotes";
import { playSound } from "../lib/sounds";
import { createSessionStore } from "../lib/sessionStore";
import { splitModel } from "../lib/models";
import { DEBUG_PREFIX, fakeSession, makeFakeMessages, parseDebugCount } from "../lib/debugSession";
import { touchWorkspace, getExtraWorkspaces } from "../lib/workspace";
import { normWorkspace } from "../lib/platform";
import { windowKey } from "../lib/windowScope";
import { getWorkspacePref, recordSelection } from "../lib/workspacePrefs";
import { createBusyTracker } from "../lib/busyTracker";
import {
  buildCmdList,
  handleSlash,
  type DialogState,
} from "../lib/slashCommands";
import { getPluginSlash } from "../lib/plugins";
import { handleOpenCodeEvent, type OpenCodeEventCtx } from "../lib/opencodeEvents";
import { ensureServerGroups, useProviders } from "./useProviders";
import { clearDraft, getDraft, setDraft } from "../lib/drafts";
import { clearAttachmentDraft, restoreAttachmentDraft } from "./useAttachments";
import { invalidateFileCache } from "./useFileCache";
import { pushToast } from "./useToast";
import type { Msg, OpenCodeEvent, PermAsk, ProviderGroup, Attachment, QuestionAsk, Cmd } from "../types";

// fake filler sessions created by /debug-long-session — client-side only,
// re-added to the sidebar on refreshes while their workspace stays open
const debugSessions = new Map<string, { session: Session; dir: string }>();

// resolve the right server client for a workspace dir ("" = server cwd).
// api.ts's Proxy wrap() erases the SDK shape in its return type but preserves
// it at runtime — retype once here (same pattern as useProviders' OcClient)
// instead of casting at every call site.
type OcClient = OpencodeClient;
const clientFor = async (dir?: string): Promise<{ base: string; client: OcClient }> =>
  dir ? await opencodeFor(dir) : await opencode();

// per-session agent memory + per-window global agent (mirrors useProviders model logic)
const SESSION_AGENTS_KEY = "oc.sessionAgents";
const LAST_AGENT_BASE = "oc.lastAgent";
const DISABLED_AGENTS_KEY = "oc.disabledAgents";
function isAgentReachable(name: string, list: { name: string }[]): boolean {
  return !!name && list.some((a) => a.name === name);
}

// re-exported: composer + command dialog import the type from here
export type { CmdEntry } from "../lib/slashCommands";

// remotes already toasted as down this session — a dead host's dial retry
// loop would toast constantly; notify once per outage, not once per retry
const remoteDownToasted = new Set<string>();

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
  // pending asks, kept per session — returning to a session resurfaces
  // its popup (both permissions and questions outlive session switches)
  const questionsRef = useRef<Map<string, QuestionAsk>>(new Map());
  const [question, setQuestion] = useState<QuestionAsk | null>(null);
  const permissionsRef = useRef<Map<string, PermAsk>>(new Map());
  // sessions already warned about model fallback (model → warned model id)
  const modelFallbackWarned = useRef(new Map<string, string>());
  const [permission, setPermission] = useState<PermAsk | null>(null);
  // sidebar attention: which sessions need a click (permission or question).
  // One map, sid -> kind; attentionIds is the derived key set (same public shape)
  const [attentionKinds, setAttentionKinds] = useState<Record<string, "permission" | "question" | "both">>({});
  const attentionIds = useMemo(() => new Set(Object.keys(attentionKinds)), [attentionKinds]);
  // security mode: per-session override + global last (mirrors model/agent)
  type SecurityMode = "full" | "user" | "block";
  const SECURITY_KEY = windowKey("oc.securityMode");
  const SESSION_SECURITY_KEY = "oc.sessionSecurityMode";
  const [securityMode, _setSecurityMode] = useState<SecurityMode>(() => {
    try {
      const v = localStorage.getItem(SECURITY_KEY);
      if (v === "restricted") return "block"; // migrate legacy name
      if (v === "full" || v === "block" || v === "user") return v;
    } catch {}
    return "user";
  });
  const securityModeRef = useRef<SecurityMode>(securityMode);
  useEffect(() => { securityModeRef.current = securityMode; }, [securityMode]);
  // (persisted below, after the restore effect — declaration order matters:
  // the restore must read workspace memory before any write-back)
  const [sessionSecurity, setSessionSecurity] = useState<Record<string, SecurityMode>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SESSION_SECURITY_KEY) ?? "{}");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, SecurityMode>) : {};
    } catch { return {}; }
  });
  const sessionSecurityRef = useRef(sessionSecurity);
  useEffect(() => { sessionSecurityRef.current = sessionSecurity; }, [sessionSecurity]);
  useEffect(() => { try { localStorage.setItem(SESSION_SECURITY_KEY, JSON.stringify(sessionSecurity)); } catch {} }, [sessionSecurity]);
  const getSecurityModeFor = useCallback((sid: string): SecurityMode => {
    const stored = sessionSecurityRef.current[sid];
    if (stored === "full" || stored === "block" || stored === "user") return stored;
    try {
      const g = localStorage.getItem(SECURITY_KEY);
      if (g === "restricted") return "block";
      if (g === "full" || g === "block" || g === "user") return g as SecurityMode;
    } catch {}
    return "user";
  }, []);
  const rememberSecuritySession = useCallback((sid: string, value: SecurityMode) => {
    if (!sid) return;
    setSessionSecurity((prev) => (prev[sid] === value ? prev : { ...prev, [sid]: value }));
  }, []);
  const setSecurityMode = useCallback((m: SecurityMode, sid?: string) => {
    const target = sid ?? activeRef.current;
    _setSecurityMode(m);
    if (target) rememberSecuritySession(target, m);
    playSound("click");
  }, [rememberSecuritySession]);
  const cycleSecurityMode = useCallback((dir: 1 | -1 = 1) => {
    const order: SecurityMode[] = ["user", "block", "full"];
    const next = order[(order.indexOf(securityModeRef.current) + dir + order.length) % order.length];
    const target = activeRef.current;
    _setSecurityMode(next);
    if (target) rememberSecuritySession(target, next);
    playSound("click");
  }, [rememberSecuritySession]);
  // first-window boot recovery with no active session yet: apply the
  // workspace's last-used security mode on mount (no async data needed).
  // Skipped when the pending session has its own pin — restore below wins.
  const wsSecBootDone = useRef(false);
  useEffect(() => {
    if (wsSecBootDone.current) return;
    wsSecBootDone.current = true;
    const sid = activeRef.current;
    const pin = sid ? sessionSecurityRef.current[sid] : undefined;
    if (pin === "full" || pin === "block" || pin === "user") return;
    const s = getWorkspacePref(getDirectory()).security;
    if (s !== "full" && s !== "block" && s !== "user") return;
    restoringSecRef.current = true;
    try {
      localStorage.setItem(SECURITY_KEY, s);
    } catch {}
    _setSecurityMode((cur) => (cur === s ? cur : (s as SecurityMode)));
    queueMicrotask(() => {
      restoringSecRef.current = false;
    });
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const remembered = sessionSecurity[activeId];
    if (remembered === "full" || remembered === "block" || remembered === "user") {
      restoringSecRef.current = true;
      _setSecurityMode((cur) => (cur === remembered ? cur : remembered));
      queueMicrotask(() => { restoringSecRef.current = false; });
      return;
    }
    // no per-session pin — the workspace's last-used mode wins over the
    // window global, so returning to a project restores its setup.
    const wsSecurity = getWorkspacePref(getDirectory()).security;
    if (wsSecurity === "full" || wsSecurity === "block" || wsSecurity === "user") {
      restoringSecRef.current = true;
      _setSecurityMode((cur) => (cur === wsSecurity ? cur : (wsSecurity as SecurityMode)));
      try { localStorage.setItem(SECURITY_KEY, wsSecurity); } catch {}
      queueMicrotask(() => { restoringSecRef.current = false; });
      return;
    }
    let global: string | null = null;
    try { global = localStorage.getItem(SECURITY_KEY); } catch {}
    if (global === "restricted") global = "block";
    if (global === "full" || global === "block" || global === "user") {
      restoringSecRef.current = true;
      _setSecurityMode((cur) => (cur === global ? cur as SecurityMode : (global as SecurityMode)));
      queueMicrotask(() => { restoringSecRef.current = false; });
    }
  }, [activeId, sessionSecurity]);

  // persist after the restore above (declaration order): the restore must
  // read workspace memory before this writes anything back.
  useEffect(() => {
    try { localStorage.setItem(SECURITY_KEY, securityMode); } catch {}
    recordSelection({ security: securityMode });
  }, [securityMode]);

  // generic watcher: any security value change auto-pins per-session (covers future shortcuts)
  useEffect(() => {
    const sid = activeRef.current;
    if (!sid || restoringSecRef.current) return;
    if (sessionSecurityRef.current[sid] === securityMode) return;
    const hasPin = sid in sessionSecurityRef.current;
    let global: string | null = null;
    try { global = localStorage.getItem(SECURITY_KEY); } catch {}
    if (global === "restricted") global = "block";
    if (!hasPin && securityMode === global) return;
    rememberSecuritySession(sid, securityMode);
  }, [securityMode]);
  const [commands, setCommands] = useState<Cmd[]>([]);
  // plugin slash commands are aggregated in src/lib/plugins.ts slashStore;
  // cmdList is built from that store directly each render so autocomplete
  // never goes stale even if the oc:plugin-slash event fires before mount.
  const [agents, setAgents] = useState<{ name: string; mode: string }[]>([]);
  const [agentSel, setAgentSel] = useState("");
  // frontend override: disabled agents are hidden from Tab cycle but still selectable via dropdown
  // ponytail: global Set, per-workspace map if workspaces diverge
  const [disabledAgents, setDisabledAgents] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(DISABLED_AGENTS_KEY) ?? "[]");
      return new Set(Array.isArray(raw) ? raw.filter((x: unknown) => typeof x === "string") : []);
    } catch { return new Set<string>(); }
  });
  // per-session agent memory: only entries that were EXPLICITLY picked for
  // that session get stored; everything else follows the global selection.
  // keyed by session id -> agent name. boot-load prunes vanished agents
  const [sessionAgents, setSessionAgents] = useState<Record<string, string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SESSION_AGENTS_KEY) ?? "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({});
  const [queuedBySession, setQueuedBySession] = useState<Record<string, import("../lib/busyTracker").QueuedPrompt[]>>({});
  const [live, setLive] = useState(false);
  const [booting, setBooting] = useState(true);

  const prov = useProviders(activeId);

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

  // ---- per-session agent memory (mirrors useProviders model logic) ----
  // per-window last hand-picked agent — windowKey() namespaces it per OS
  // window so two windows never steal each other's selection.
  // only real selections persist — never wipe the stored one with "".
  // Every pick is also recorded into per-workspace memory + shared
  // last-used (workspacePrefs).
  const LAST_AGENT_KEY = windowKey(LAST_AGENT_BASE);
  useEffect(() => {
    if (agentSel) {
      try {
        localStorage.setItem(LAST_AGENT_KEY, agentSel);
      } catch {}
      recordSelection({ agent: agentSel });
    }
  }, [agentSel]);

  // live sync: another window picked an agent -> reflect here unless active session has its own remembered agent
  // (per-window keys now — this only fires for same-window writes, e.g. the
  // settings drawer + picker writing the same key; harmless by design)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LAST_AGENT_KEY || !e.newValue) return;
      if (!agents.length) return;
      if (!isAgentReachable(e.newValue, agents)) return;
      const remembered = sessionAgents[activeId];
      if (remembered && isAgentReachable(remembered, agents)) return;
      setAgentSel((cur) => (cur === e.newValue! ? cur : e.newValue!));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [agents, activeId, sessionAgents]);

  // persist the session->agent map
  useEffect(() => {
    try {
      localStorage.setItem(SESSION_AGENTS_KEY, JSON.stringify(sessionAgents));
    } catch {}
  }, [sessionAgents]);

  // persist disabled agents + cross-window sync
  useEffect(() => {
    try { localStorage.setItem(DISABLED_AGENTS_KEY, JSON.stringify([...disabledAgents])); } catch {}
  }, [disabledAgents]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DISABLED_AGENTS_KEY) return;
      try {
        const arr = JSON.parse(e.newValue ?? "[]");
        setDisabledAgents(new Set(Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === "string") : []));
      } catch {}
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const rememberAgentSession = useCallback((sid: string, value: string) => {
    if (!sid) return;
    setSessionAgents((prev) => {
      if (!value) {
        if (!(sid in prev)) return prev;
        const next = { ...prev };
        delete next[sid];
        return next;
      }
      if (prev[sid] === value) return prev;
      return { ...prev, [sid]: value };
    });
  }, []);
  void rememberAgentSession;
  const sessionAgentsRef = useRef(sessionAgents);
  useEffect(() => { sessionAgentsRef.current = sessionAgents; }, [sessionAgents]);
  const restoringAgentRef = useRef(false);
  const restoringSecRef = useRef(false);

  // first-window boot recovery with no active session yet: apply the
  // workspace's last-used agent once the agent list arrives. Skipped when
  // the pending session has its own pin — the restore below outranks it.
  const wsAgentBootDone = useRef(false);
  useEffect(() => {
    if (wsAgentBootDone.current || !agents.length) return;
    wsAgentBootDone.current = true;
    const sid = activeRef.current;
    const pin = sid ? sessionAgentsRef.current[sid] : undefined;
    if (pin && isAgentReachable(pin, agents)) return;
    const a = getWorkspacePref(getDirectory()).agent;
    if (!a || !isAgentReachable(a, agents)) return;
    restoringAgentRef.current = true;
    try {
      localStorage.setItem(LAST_AGENT_KEY, a);
    } catch {}
    setAgentSel((cur) => (cur === a ? cur : a));
    queueMicrotask(() => {
      restoringAgentRef.current = false;
    });
  }, [agents, LAST_AGENT_KEY]);

  // session switch (or agents arriving late): re-apply the active session's remembered agent
  // when it exists and is still reachable; otherwise the workspace's last-used
  // agent; otherwise the per-window global last agent.
  useEffect(() => {
    if (!activeId) return;
    if (!agents.length) return;
    const remembered = sessionAgents[activeId];
    if (remembered) {
      if (isAgentReachable(remembered, agents)) {
        restoringAgentRef.current = true;
        setAgentSel((cur) => (cur === remembered ? cur : remembered));
        queueMicrotask(() => { restoringAgentRef.current = false; });
        return;
      }
      // stale — agent vanished: drop per-session pin
      setSessionAgents((prev) => {
        if (!(activeId in prev)) return prev;
        const next = { ...prev };
        delete next[activeId];
        return next;
      });
    }
    const wsAgent = getWorkspacePref(getDirectory()).agent;
    if (wsAgent && isAgentReachable(wsAgent, agents)) {
      restoringAgentRef.current = true;
      try {
        localStorage.setItem(LAST_AGENT_KEY, wsAgent);
      } catch {}
      setAgentSel((cur) => (cur === wsAgent ? cur : wsAgent));
      queueMicrotask(() => { restoringAgentRef.current = false; });
      return;
    }
    let global: string | null = null;
    try {
      global = localStorage.getItem(LAST_AGENT_KEY);
    } catch {}
    if (global && isAgentReachable(global, agents)) {
      restoringAgentRef.current = true;
      setAgentSel((cur) => (cur === global ? cur : global));
      queueMicrotask(() => { restoringAgentRef.current = false; });
    }
  }, [activeId, agents, sessionAgents]);

  // workspace switch → adapt agent + security to the newly-opened
  // workspace's last-used values (when known). Model + effort are handled by
  // useProviders' own listener. Same-window custom event only — each window
  // adapts independently; unreachable agents are skipped, never applied blind.
  useEffect(() => {
    const onWs = () => {
      const pref = getWorkspacePref(getDirectory());
      if (pref.agent && agents.length && isAgentReachable(pref.agent, agents)) {
        const a = pref.agent;
        restoringAgentRef.current = true;
        try {
          localStorage.setItem(LAST_AGENT_KEY, a);
        } catch {}
        setAgentSel((cur) => (cur === a ? cur : a));
        queueMicrotask(() => {
          restoringAgentRef.current = false;
        });
      }
      const s = pref.security;
      if (s === "full" || s === "block" || s === "user") {
        restoringSecRef.current = true;
        try {
          localStorage.setItem(SECURITY_KEY, s);
        } catch {}
        _setSecurityMode((cur) => (cur === s ? cur : (s as SecurityMode)));
        queueMicrotask(() => {
          restoringSecRef.current = false;
        });
      }
    };
    window.addEventListener("oc:workspaces-changed", onWs);
    return () => window.removeEventListener("oc:workspaces-changed", onWs);
  }, [agents, LAST_AGENT_KEY, SECURITY_KEY]);

  // generic watcher: any agent value change (dropdown, Tab, future shortcut) auto-pins per-session
  useEffect(() => {
    const sid = activeRef.current;
    if (!sid || restoringAgentRef.current) return;
    if (!agentSel || !isAgentReachable(agentSel, agents)) return;
    if (sessionAgentsRef.current[sid] === agentSel) return;
    const hasPin = sid in sessionAgentsRef.current;
    let global: string | null = null;
    try { global = localStorage.getItem(LAST_AGENT_KEY); } catch {}
    if (!hasPin && agentSel === global) return;
    rememberAgentSession(sid, agentSel);
  }, [agentSel, agents]);

  // prune vanished agents from the map + global + disabled override
  useEffect(() => {
    if (!agents.length) return;
    setSessionAgents((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [sid, name] of Object.entries(prev)) {
        if (!isAgentReachable(name, agents)) {
          delete next[sid];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setDisabledAgents((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const name of prev) if (!isAgentReachable(name, agents)) { next.delete(name); changed = true; }
      return changed ? next : prev;
    });
    try {
      const g = localStorage.getItem(LAST_AGENT_KEY);
      if (g && !isAgentReachable(g, agents)) localStorage.removeItem(LAST_AGENT_KEY);
    } catch {}
  }, [agents]);

  // child -> parent session links. Children never reach the sidebar, so
  // badges + popups for them roll up to the visible top-level session.
  const childParentRef = useRef(new Map<string, string>());
  const topOfSession = useCallback((sid: string): string => {
    let cur = sid;
    const seen = new Set([cur]);
    for (;;) {
      const p = childParentRef.current.get(cur);
      if (!p || seen.has(p)) return cur;
      seen.add(p);
      cur = p;
    }
  }, []);
  const isDescendantOf = useCallback((sid: string, anc: string): boolean => {
    if (sid === anc) return true;
    let cur = childParentRef.current.get(sid);
    const seen = new Set([sid]);
    while (cur && !seen.has(cur)) {
      if (cur === anc) return true;
      seen.add(cur);
      cur = childParentRef.current.get(cur);
    }
    return false;
  }, []);
  // transient question subscribers (subagent viewer shows its own session's
  // ask — child asks never surface in the parent popup, only the badge does)
  const questionListeners = useRef(new Map<string, Set<() => void>>());
  const emitQuestion = useCallback((sid: string) => {
    const subs = questionListeners.current.get(sid);
    if (!subs) return;
    for (const cb of [...subs]) {
      try { cb(); } catch {}
    }
  }, []);
  const subscribeQuestion = useCallback((sid: string, cb: () => void): (() => void) => {
    let set = questionListeners.current.get(sid);
    if (!set) {
      set = new Set();
      questionListeners.current.set(sid, set);
    }
    set.add(cb);
    return () => {
      const s = questionListeners.current.get(sid);
      if (!s) return;
      s.delete(cb);
      if (!s.size) questionListeners.current.delete(sid);
    };
  }, []);
  const peekQuestion = useCallback((sid: string): QuestionAsk | null => {
    return questionsRef.current.get(sid) ?? null;
  }, []);
  // same for permission asks — the subagent viewer approves its own
  // session's prompts; the parent only ever shows the badge
  const permissionListeners = useRef(new Map<string, Set<() => void>>());
  const emitPermission = useCallback((sid: string) => {
    const subs = permissionListeners.current.get(sid);
    if (!subs) return;
    for (const cb of [...subs]) {
      try { cb(); } catch {}
    }
  }, []);
  const subscribePermission = useCallback((sid: string, cb: () => void): (() => void) => {
    let set = permissionListeners.current.get(sid);
    if (!set) {
      set = new Set();
      permissionListeners.current.set(sid, set);
    }
    set.add(cb);
    return () => {
      const s = permissionListeners.current.get(sid);
      if (!s) return;
      s.delete(cb);
      if (!s.size) permissionListeners.current.delete(sid);
    };
  }, []);
  const peekPermission = useCallback((sid: string): PermAsk | null => {
    return permissionsRef.current.get(sid) ?? null;
  }, []);

  const setAttentionFor = useCallback((sid: string, kind: "permission" | "question" | "both" | null) => {
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

  // badge the visible parent for a descendant's pending ask — the child
  // row itself is filtered from the sidebar so its own badge is invisible.
  // Covers both question and permission asks (a child's approval surfaces
  // in the subagent viewer, like its questions).
  const syncTopBadge = useCallback((topId: string) => {
    if (!topId) return;
    let hasQ = questionsRef.current.has(topId);
    let hasPerm = permissionsRef.current.has(topId);
    if (!hasQ || !hasPerm)
      for (const csid of new Set([...questionsRef.current.keys(), ...permissionsRef.current.keys()])) {
        if (csid === topId || !isDescendantOf(csid, topId)) continue;
        if (!hasQ && questionsRef.current.has(csid)) hasQ = true;
        if (!hasPerm && permissionsRef.current.has(csid)) hasPerm = true;
        if (hasQ && hasPerm) break;
      }
    setAttentionFor(topId, hasPerm && hasQ ? "both" : hasPerm ? "permission" : hasQ ? "question" : null);
  }, [isDescendantOf, setAttentionFor]);

  // learn an asker's parent once (unknown child id) then badge the parent
  const resolveParent = useCallback(async (sid: string, dirHint?: string) => {
    if (!sid || childParentRef.current.has(sid)) return;
    try {
      const dir = dirHint ?? getDirectory();
      const { client } = await clientFor(dir);
      const r = await client.session.get({ path: { id: sid } });
      const parent = r.data?.parentID;
      if (typeof parent !== "string" || !parent) return;
      childParentRef.current.set(sid, parent);
      const top = topOfSession(sid);
      syncTopBadge(top);
    } catch {}
  }, [syncTopBadge, topOfSession]);

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
    setAttentionFor(sid, kind);
  }, [setAttentionFor]);
  const clearAttention = useCallback((sid: string) => {
    if (!sid) return;
    setAttentionKinds((prev) => {
      if (!(sid in prev)) return prev;
      const { [sid]: _omit, ...rest } = prev as Record<string, unknown>;
      return rest as Record<string, "permission" | "question" | "both">;
    });
  }, []);

  // auto permission responder — fires POST without showing the bar
  const autoRespondPermission = useCallback(async (ask: PermAsk, response: "always" | "reject") => {
    const dirFor = sessionDirRef.current.get(ask.sessionID) ?? getDirectory();
    try {
      const { client } = await clientFor(dirFor);
      await client.postSessionIdPermissionsPermissionId({
        path: { id: ask.sessionID, permissionID: ask.id },
        body: { response },
      });
    } catch (e) {
      pushToast(String(e));
    }
  }, []);

  // shared permission-ask path — security mode short-circuits (full/block),
  // else store + badge + emit + (optionally) sound, then surface on the
  // visible parent or the active session's popup bar
  const handlePermAsk = useCallback(
    (ask: PermAsk, dirHint?: string, sound = false) => {
      if (!ask.sessionID || !ask.id) return;
      const mode = getSecurityModeFor(ask.sessionID);
      if (mode === "full") {
        void autoRespondPermission(ask, "always");
        return;
      }
      if (mode === "block") {
        void autoRespondPermission(ask, "reject");
        return;
      }
      permissionsRef.current.set(ask.sessionID, ask);
      syncAttention(ask.sessionID);
      emitPermission(ask.sessionID);
      if (sound) playSound("attention");
      // subagent approvals stay in the subagent viewer — the visible
      // parent only gets the sidebar badge
      const top = topOfSession(ask.sessionID);
      if (top !== ask.sessionID) {
        syncTopBadge(top);
        if (!childParentRef.current.has(ask.sessionID)) void resolveParent(ask.sessionID, dirHint);
      } else if (ask.sessionID === activeRef.current) setPermission(ask);
    },
    [getSecurityModeFor, autoRespondPermission, syncAttention, emitPermission, topOfSession, syncTopBadge, resolveParent],
  );

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

  // cross-window sync — global + per-session
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SECURITY_KEY && e.newValue) {
        if (e.newValue === "restricted") { _setSecurityMode("block"); return; }
        if (e.newValue === "full" || e.newValue === "user" || e.newValue === "block") {
          const remembered = sessionSecurityRef.current[activeRef.current];
          if (remembered === "full" || remembered === "block" || remembered === "user") return;
          _setSecurityMode(e.newValue as SecurityMode);
        }
        return;
      }
      if (e.key === SESSION_SECURITY_KEY) {
        try {
          const raw = JSON.parse(e.newValue ?? "{}");
          const map = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, SecurityMode> : {};
          setSessionSecurity(map);
          const cur = map[activeRef.current];
          if (cur === "full" || cur === "block" || cur === "user") _setSecurityMode(cur);
          else if (e.newValue) {
            try {
              const g = localStorage.getItem(SECURITY_KEY);
              if (g === "restricted") _setSecurityMode("block");
              else if (g === "full" || g === "block" || g === "user") _setSecurityMode(g as SecurityMode);
            } catch {}
          }
        } catch {}
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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

  const LAST_KEY = windowKey("oc.lastSes");
  const PINNED_KEY = "oc.pinnedSessions";
  const TITLE_OVERRIDES_KEY = "oc.sessionTitles";
  // localStorage maps are cached in refs — session.created/updated bursts
  // would otherwise re-JSON.parse both on every SSE event. Invalidate on
  // every write (togglePin/rename) and on cross-window storage events.
  const pinnedCacheRef = useRef<Set<string> | null>(null);
  const titleOverridesCacheRef = useRef<Record<string, string> | null>(null);

  const getPinned = useCallback((): Set<string> => {
    if (pinnedCacheRef.current) return pinnedCacheRef.current;
    let out = new Set<string>();
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) out = new Set(arr.filter((x: unknown) => typeof x === "string"));
      }
    } catch {}
    pinnedCacheRef.current = out;
    return out;
  }, []);
  const getTitleOverrides = useCallback((): Record<string, string> => {
    if (titleOverridesCacheRef.current) return titleOverridesCacheRef.current;
    let out: Record<string, string> = {};
    try {
      const raw = localStorage.getItem(TITLE_OVERRIDES_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) out = obj as Record<string, string>;
      }
    } catch {}
    titleOverridesCacheRef.current = out;
    return out;
  }, []);
  const applyOverrides = useCallback((list: Session[]): Session[] => {
    const overrides = getTitleOverrides();
    const pinned = getPinned();
    const mapped = list.map((s) => overrides[s.id] ? { ...s, title: overrides[s.id] } : s);
    const seen = new Set<string>();
    const deduped: Session[] = [];
    for (const s of mapped) if (!seen.has(s.id)) { seen.add(s.id); deduped.push(s); }
    const p = pinned;
    return deduped.sort((a, b) => {
      const pa = p.has(a.id) ? 1 : 0;
      const pb = p.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.time?.created ?? 0) - (a.time?.created ?? 0);
    });
  }, [getPinned, getTitleOverrides]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PINNED_KEY) pinnedCacheRef.current = null;
      else if (e.key === TITLE_OVERRIDES_KEY) titleOverridesCacheRef.current = null;
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // --- multi-workspace helpers ---
  const sessionDirRef = useRef<Map<string, string>>(new Map());
  const prevDirsRef = useRef<string[]>([]);
  const getWorkspaces = useCallback((): string[] => {
    try {
      return getExtraWorkspaces();
    } catch { return []; }
  }, []);
  const getAllDirs = useCallback((): string[] => {
    const primary = getDirectory();
    const extras = getWorkspaces();
    const seen = new Set<string>();
    const out: string[] = [];
    let seenEmpty = false;
    for (const d of [primary, ...extras]) {
      const t = (d ?? "").trim();
      if (!t) {
        if (seenEmpty) continue;
        seenEmpty = true;
        seen.add("__EMPTY__");
        out.push("");
        continue;
      }
      const key = normWorkspace(t);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [getWorkspaces]);
  const getDirForSession = useCallback((id: string): string => {
    return sessionDirRef.current.get(id) ?? getDirectory();
  }, []);

  // one per-session teardown ritual — the single source for delete paths
  // (server event, sidebar remove, workspace/clear-all wipes). Also prunes
  // the maps older copies missed: childParentRef, debugSessions,
  // modelFallbackWarned, lastSentRef.
  const teardownSession = useCallback((id: string) => {
    if (!id) return;
    sessionDirRef.current.delete(id);
    debugSessions.delete(id);
    modelFallbackWarned.current.delete(id);
    lastSentRef.current.delete(id);
    for (const [child, parent] of [...childParentRef.current]) {
      if (child === id || parent === id) childParentRef.current.delete(child);
    }
    store.remove(id);
    tracker.reset(id);
    markCompacting(id, false);
    clearDraft(id);
    clearAttachmentDraft(id);
    questionsRef.current.delete(id);
    permissionsRef.current.delete(id);
    clearAttention(id);
    setSessionSecurity((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSessionAgents((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    prov.rememberSession(id, "");
    prov.forgetVariantSession(id);
  }, [store, tracker, markCompacting, clearAttention, prov.rememberSession, prov.forgetVariantSession]);

  const refreshSessionsFor = useCallback(async (dir: string) => {
    const { client } = await clientFor(dir);
    const r = await client.session.list();
    const list = (r.data ?? [])
      .filter((s) => !hiddenSessions.has(s.id) && s.title !== HIDDEN_TITLE && !s.parentID)
      .map((s) => ({ ...s, _dir: dir } as Session & { _dir: string }));
    for (const s of list) sessionDirRef.current.set(s.id, dir);
    return applyOverrides(list);
  }, []);

  const refreshSessions = useCallback(async () => {
    const dirs = getAllDirs();
    // drop file caches for workspaces that just closed so a re-added
    // folder (or SERVER CWD coinciding with it) never shows stale trees
    try {
      const prev = prevDirsRef.current;
      if (prev.length) {
        const norm = (s: string) => normWorkspace(s);
        const cur = new Set(dirs.map((d) => (d ? norm(d) : "__EMPTY__")));
        for (const d of prev) {
          const k = d ? norm(d) : "__EMPTY__";
          if (!cur.has(k) && d) {
            try { invalidateFileCache("", d); } catch {}
          }
        }
      }
    } catch {}
    prevDirsRef.current = [...dirs];
    // no real workspace open ("", server cwd alone) → empty UI, not the
    // server's cwd contents (which may coincide with the just-closed folder)
    if (dirs.length === 1 && !dirs[0]) {
      const prevActiveId = activeRef.current;
      sessionDirRef.current = new Map();
      setSessions([]);
      if (prevActiveId) {
        try {
          permissionsRef.current.delete(prevActiveId);
          questionsRef.current.delete(prevActiveId);
          clearAttention(prevActiveId);
          markCompacting(prevActiveId, false);
          trackerRef.current?.reset(prevActiveId);
        } catch {}
        setActiveId("");
        try { localStorage.removeItem(LAST_KEY); } catch {}
        store.clearStashes();
        setMsgs([]);
        setQuestion(null);
        setPermission(null);
      }
      return [];
    }
    const prevMap = new Map(sessionDirRef.current);
    const prevActiveId = activeRef.current;
    const prevActiveDir = prevActiveId ? prevMap.get(prevActiveId) : undefined;
    const all: Session[] = [];
    const results = await Promise.all(dirs.map((d) => refreshSessionsFor(d).catch(() => [] as Session[])));
    // rebuild dir map from results (clears stale)
    const nextMap = new Map<string, string>();
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      const list = results[i] ?? [];
      for (const s of list) nextMap.set(s.id, dir);
      all.push(...list);
    }
    // preserve pending creations whose dir still exists
    const norm = (s: string) => normWorkspace(s);
    const dirSet = new Set(dirs.map((d) => (d ? norm(d) : "__EMPTY__")));
    const hasDir = (dir: string) => dirSet.has(dir ? norm(dir) : "__EMPTY__");
    for (const [id, dir] of sessionDirRef.current) if (!nextMap.has(id) && hasDir(dir ?? "")) nextMap.set(id, dir);
    sessionDirRef.current = nextMap;
    // debug filler sessions never exist server-side — re-add while their
    // workspace is still open so refreshes keep the sidebar entry
    for (const [id, e] of debugSessions) {
      if (hasDir(e.dir) && !all.some((s) => s.id === id)) all.push(e.session);
    }
    const out = applyOverrides(all);
    const finalMap = new Map<string, string>();
    for (const s of out) {
      const d = (s as any)._dir ?? nextMap.get(s.id) ?? getDirectory();
      finalMap.set(s.id, d);
    }
    for (const [id, dir] of nextMap) if (!finalMap.has(id) && hasDir(dir ?? "")) finalMap.set(id, dir);
    sessionDirRef.current = finalMap;
    setSessions(out);
    // workspace closed under the active session (not a transient fetch
    // failure): drop the stale view so the old chat doesn't linger. The
    // server keeps the sessions — re-adding the workspace brings them back.
    if (prevActiveId && !out.some((s) => s.id === prevActiveId)) {
      const gone = prevActiveDir !== undefined ? !hasDir(prevActiveDir ?? "") : false;
      // prevActiveDir unknown (e.g. boot) → keep view, fetch may have failed
      if (gone) {
        try {
          permissionsRef.current.delete(prevActiveId);
          questionsRef.current.delete(prevActiveId);
          clearAttention(prevActiveId);
          markCompacting(prevActiveId, false);
          trackerRef.current?.reset(prevActiveId);
        } catch {}
        setActiveId("");
        try { localStorage.removeItem(LAST_KEY); } catch {}
        store.clearStashes();
        setMsgs([]);
        setQuestion(null);
        setPermission(null);
      }
    }
    // stale attention for sessions whose workspace is gone (badge would linger)
    try {
      for (const [id, dir] of prevMap) {
        if (!hasDir(dir ?? "") && !finalMap.has(id)) {
          permissionsRef.current.delete(id);
          questionsRef.current.delete(id);
          clearAttention(id);
        }
      }
      if (prevActiveId && !finalMap.has(prevActiveId)) {
        setQuestion((cur) => (cur && cur.sessionID === prevActiveId ? null : cur));
        setPermission((cur) => (cur && cur.sessionID === prevActiveId ? null : cur));
      }
    } catch {}
    return out;
  }, [refreshSessionsFor, getAllDirs, clearAttention, markCompacting]);

  // TF-04: serialize refreshSessions — double-click Rewind queues one more, drops intermediate
  const refreshingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const guardedRefresh = useCallback(async () => {
    if (refreshingRef.current) { pendingRefreshRef.current = true; return; }
    refreshingRef.current = true;
    try { return await refreshSessions(); }
    finally {
      refreshingRef.current = false;
      if (pendingRefreshRef.current) { pendingRefreshRef.current = false; void guardedRefresh(); }
    }
  }, [refreshSessions]);

  // live workspace switch (no reload): rebuild the session list for the new
  // dirs; SSE streams converge via the 2s tick, busy sessions on untouched
  // workspaces keep streaming
  useEffect(() => {
    const onWs = () => { void guardedRefresh(); };
    window.addEventListener("oc:workspaces-changed", onWs);
    return () => window.removeEventListener("oc:workspaces-changed", onWs);
  }, [guardedRefresh]);

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
    debugSessions.set(id, { session: sess, dir });
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
      permissionsRef,
      questionsRef,
      getSecurityModeFor,
      autoRespondPermission,
      resolveParent,
      restoreFailedInput,
      handlePermAsk,
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

  // session-wide token/cost totals — summed from the authoritative store
  // (not the revert-filtered view) so rewinding doesn't rewrite history;
  // msgs in deps is the recompute trigger (the store mutates alongside it)
  // + all descendant sub-agent sessions (via /session/{id}/children) so the
  // footer shows the real spend, not just the primary agent.
  const [activeChildren, setActiveChildren] = useState<Session[]>([]);
  // poll runs every 3s while busy — replace state only on real changes so
  // childTaskCosts (→ MsgRow taskCosts prop) keeps a stable identity
  const childrenSigRef = useRef("");
  const refreshActiveChildren = useCallback(async (sid: string) => {
    if (!sid) { childrenSigRef.current = ""; setActiveChildren([]); return; }
    try {
      const dir = sessionDirRef.current.get(sid) ?? getDirectory();
      const { client } = await clientFor(dir);
      const r = await client.session.children({ path: { id: sid } });
      const list: Session[] = r.data ?? [];
      for (const c of list) childParentRef.current.set(c.id, c.parentID ?? sid);
      // ponytail: one-level fetch; recurse if nesting matters (rare)
      // fetch grandchildren best-effort so nested sub-agents are not missed
      if (list.length) {
        try {
          const deeper = await Promise.all(list.map(async (c) => {
            try {
              const rr = await client.session.children({ path: { id: c.id } });
              const arr = rr.data ?? [];
              for (const g of arr) childParentRef.current.set(g.id, c.id);
              return arr;
            } catch { return [] as Session[]; }
          }));
          const extra = deeper.flat();
          // dedup by id
          const seen = new Set(list.map((s) => s.id));
          for (const ch of extra) if (!seen.has(ch.id)) { seen.add(ch.id); list.push(ch); }
        } catch {}
      }
      const sig = JSON.stringify(list);
      if (sig !== childrenSigRef.current) {
        childrenSigRef.current = sig;
        setActiveChildren(list);
      }
      // lineage just learned — badge the parent for any pending descendant
      // asks that arrived before we knew it (popups stay session-local)
      syncTopBadge(sid);
    } catch {
      // keep previous on error (transient)
    }
  }, []);
  const refreshChildrenRef = useRef(refreshActiveChildren);
  useEffect(() => { refreshChildrenRef.current = refreshActiveChildren; }, [refreshActiveChildren]);
  useEffect(() => {
    if (!activeId) { setActiveChildren([]); return; }
    void refreshActiveChildren(activeId);
  }, [activeId, refreshActiveChildren]);
  // the 3s busy-children poll is gone — event triggers cover the real changes:
  // message.part.updated(task completed) fires refreshChildrenRef 400ms later
  // (opencodeEvents.ts), session.created/updated with parent===active refresh
  // immediately, and the busy→idle settle edge below pulls the final cost.
  // During a long-running subagent the live cost now lands at those moments
  // instead of climbing every 3s.
  // when the turn settles (busy → idle) the last task's final cost lands right
  // after the last delta — pull once more so total is not stale
  const prevBusyRef = useRef(false);
  useEffect(() => {
    const was = prevBusyRef.current;
    const isBusy = !!activeId && busyIds.has(activeId);
    prevBusyRef.current = isBusy;
    if (was && !isBusy && activeId) void refreshActiveChildren(activeId);
  }, [busyIds, activeId, refreshActiveChildren]);
  const sessionUsage = useMemo(() => {
    // store keeps per-session totals incrementally — no full-history scan
    // per streaming frame (20k messages would make the footer O(N)/frame)
    const s = activeId ? store.usageOf(activeId) : null;
    let cost = s?.cost ?? 0;
    let tokens = s?.tokens ?? 0;
    // ponytail: SDK Session type is stale for children — server adds cost/tokens
    for (const ch of activeChildren) {
      const c = ch as any;
      cost += c.cost ?? 0;
      const t = c.tokens ?? {};
      tokens += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
    }
    return { cost, tokens };
  }, [msgs, activeId, activeChildren]);
  // stable object identity while totals are unchanged — streaming deltas
  // don't move tokens, so consumers (composer chip) don't re-render per frame
  const usageStable = useMemo(
    () => ({ cost: sessionUsage.cost, tokens: sessionUsage.tokens }),
    [sessionUsage.cost, sessionUsage.tokens],
  );
  const childTaskCosts = useMemo(() => {
    const m: Record<string, { cost: number; tokens: number; title?: string }> = {};
    // ponytail: SDK Session type is stale for children — server adds cost/tokens
    for (const ch of activeChildren) {
      const c = ch as any;
      const t = c.tokens ?? {};
      const tok = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
      m[c.id] = { cost: c.cost ?? 0, tokens: tok, title: c.title };
    }
    return m;
  }, [activeChildren]);

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
    questionsRef.current.delete(activeId);
    setQuestion((cur) => (cur?.sessionID === activeId ? null : cur));
    permissionsRef.current.delete(activeId);
    setPermission((cur) => (cur?.sessionID === activeId ? null : cur));
    clearAttention(activeId);
    const dirFor = sessionDirRef.current.get(activeId) ?? getDirectory();
    const { client } = await clientFor(dirFor);
    await client.session.abort({ path: { id: activeId } }).catch(() => {});
  }, [activeId, markCompacting, clearAttention]);

  // respond to a specific ask — the main bar uses the active session's, the
  // subagent viewer its own child's
  const respondToPermissionFor = useCallback(
    async (perm: PermAsk, response: "once" | "always" | "reject") => {
      permissionsRef.current.delete(perm.sessionID);
      setPermission((cur) => (cur && cur.id === perm.id ? null : cur));
      syncAttention(perm.sessionID);
      emitPermission(perm.sessionID);
      const top = topOfSession(perm.sessionID);
      if (top !== perm.sessionID) syncTopBadge(top);
      const dirFor = sessionDirRef.current.get(perm.sessionID) ?? getDirectory();
      const { client } = await clientFor(dirFor);
      await client
        .postSessionIdPermissionsPermissionId({
          path: { id: perm.sessionID, permissionID: perm.id },
          body: { response },
        })
        .catch((e) => pushToast(String(e)));
    },
    [emitPermission, syncAttention, syncTopBadge, topOfSession],
  );

  const respondToPermission = useCallback(
    async (response: "once" | "always" | "reject") => {
      if (!permission) return;
      await respondToPermissionFor(permission, response);
    },
    [permission, respondToPermissionFor],
  );

  // answer/reject a specific ask — the main popup uses the active session's,
  // the subagent viewer its own child's (stays in subagent history)
  const answerQuestionFor = useCallback(async (ask: QuestionAsk, answers: string[][]) => {
    setQuestion((cur) => (cur && cur.id === ask.id ? null : cur));
    questionsRef.current.delete(ask.sessionID);
    syncAttention(ask.sessionID);
    emitQuestion(ask.sessionID);
    const top = topOfSession(ask.sessionID);
    if (top !== ask.sessionID) syncTopBadge(top);
    playSound("send");
    try {
      const dirFor = sessionDirRef.current.get(ask.sessionID) ?? getDirectory();
      const r = await serverFetchFor(dirFor, `/question/${ask.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      if (!r.ok) pushToast(`Failed to send answer (${r.status})`);
    } catch (e) {
      pushToast(String(e));
    }
  }, [emitQuestion, syncAttention, syncTopBadge, topOfSession]);

  const answerQuestion = useCallback(
    async (answers: string[][]) => {
      if (!question) return;
      await answerQuestionFor(question, answers);
    },
    [question, answerQuestionFor],
  );

  const rejectQuestionFor = useCallback(async (ask: QuestionAsk) => {
    setQuestion((cur) => (cur && cur.id === ask.id ? null : cur));
    questionsRef.current.delete(ask.sessionID);
    syncAttention(ask.sessionID);
    emitQuestion(ask.sessionID);
    const top = topOfSession(ask.sessionID);
    if (top !== ask.sessionID) syncTopBadge(top);
    const dirFor = sessionDirRef.current.get(ask.sessionID) ?? getDirectory();
    await serverFetchFor(dirFor, `/question/${ask.id}/reject`, { method: "POST" }).catch(() => {});
  }, [emitQuestion, syncAttention, syncTopBadge, topOfSession]);

  const rejectQuestion = useCallback(async () => {
    if (!question) return;
    await rejectQuestionFor(question);
  }, [question, rejectQuestionFor]);

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

  const toggleDisabledAgent = useCallback((name: string) => {
    setDisabledAgents((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      playSound("click");
      return next;
    });
  }, []);

  const cycleAgent = useCallback(() => {
    if (!agents.length) return;
    const enabled = agents.filter((a) => !disabledAgents.has(a.name));
    if (!enabled.length) return;
    const cur = agentSel || agents[0].name;
    let idx = agents.findIndex((a) => a.name === cur);
    if (idx < 0) idx = 0;
    for (let step = 1; step <= agents.length; step++) {
      const cand = agents[(idx + step) % agents.length];
      if (!disabledAgents.has(cand.name)) {
        rememberAgentSession(activeRef.current, cand.name);
        setAgentSel(cand.name);
        playSound("click");
        return;
      }
    }
  }, [agents, agentSel, disabledAgents, rememberAgentSession]);

  // direct pick — dropdown change atomically writes global last + per-session pin
  const selectAgent = useCallback(
    (v: string, sid?: string) => {
      const target = sid ?? activeRef.current;
      if (target) rememberAgentSession(target, v);
      setAgentSel(v);
      playSound("click");
    },
    [rememberAgentSession],
  );

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
      try {
        const map = { ...getTitleOverrides() };
        map[id] = trimmed;
        localStorage.setItem(TITLE_OVERRIDES_KEY, JSON.stringify(map));
        titleOverridesCacheRef.current = map;
      } catch {}
      setSessions((prev) => applyOverrides(prev.map((s) => s.id === id ? { ...s, title: trimmed } : s)));
    }
  }, [getTitleOverrides]);

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
    try {
      const set = getPinned();
      if (set.has(id)) set.delete(id); else set.add(id);
      localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
      pinnedCacheRef.current = set;
      setSessions((prev) => applyOverrides([...prev]));
    } catch {}
  }, [getPinned, applyOverrides]);

  const isPinned = useCallback((id: string) => getPinned().has(id), []);

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

