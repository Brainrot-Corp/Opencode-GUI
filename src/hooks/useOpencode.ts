// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, Session } from "@opencode-ai/sdk/client";
import {
  opencode,
  opencodeFor,
  getDirectory,
  serverFetch,
  serverFetchFor,
  hiddenSessions,
  HIDDEN_TITLE,
  withDeadline,
  resetOpencodeCache,
} from "../api";
import { playSound } from "../lib/sounds";
import { createSessionStore } from "../lib/sessionStore";
import { splitModel } from "../lib/models";
import { touchWorkspace } from "../lib/workspace";
import { isWindows } from "../lib/platform";
import { createBusyTracker } from "../lib/busyTracker";
import {
  buildCmdList,
  handleSlash,
  type CmdEntry,
  type DialogState,
} from "../lib/slashCommands";
import { getPluginSlash } from "../lib/plugins";
import { useProviders } from "./useProviders";
import { clearDraft, setDraft } from "../lib/drafts";
import { pushToast } from "./useToast";
import type { Msg, OpenCodeEvent, PermAsk, ProviderGroup, Attachment, QuestionAsk, Cmd } from "../types";

// per-session agent memory + shared global agent (mirrors useProviders model logic)
const SESSION_AGENTS_KEY = "oc.sessionAgents";
const LAST_AGENT_KEY = "oc.lastAgent";
const DISABLED_AGENTS_KEY = "oc.disabledAgents";
function isAgentReachable(name: string, list: { name: string }[]): boolean {
  return !!name && list.some((a) => a.name === name);
}

// re-exported: composer + command dialog import the type from here
export type { CmdEntry } from "../lib/slashCommands";

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
  const [permission, setPermission] = useState<PermAsk | null>(null);
  // sidebar attention: which sessions need a click (permission or question)
  const [attentionIds, setAttentionIds] = useState<Set<string>>(new Set());
  const [attentionKinds, setAttentionKinds] = useState<Record<string, "permission" | "question" | "both">>({});
  // security mode: per-session override + global last (mirrors model/agent)
  type SecurityMode = "full" | "user" | "block";
  const SECURITY_KEY = "oc.securityMode";
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
  useEffect(() => { try { localStorage.setItem(SECURITY_KEY, securityMode); } catch {} }, [securityMode]);
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
  const cycleSecurityMode = useCallback(() => {
    const cur = securityModeRef.current;
    const next: SecurityMode = cur === "user" ? "block" : cur === "block" ? "full" : "user";
    const target = activeRef.current;
    _setSecurityMode(next);
    if (target) rememberSecuritySession(target, next);
    playSound("click");
  }, [rememberSecuritySession]);
  useEffect(() => {
    if (!activeId) return;
    const remembered = sessionSecurity[activeId];
    if (remembered === "full" || remembered === "block" || remembered === "user") {
      restoringSecRef.current = true;
      _setSecurityMode((cur) => (cur === remembered ? cur : remembered));
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
  const cmdFetchAt = useRef(0);
  const agentFetchAt = useRef(0);
  const baseRef = useRef("");

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
        playSound("reply");
        flushRef.current(sid);
      },
    });
  }
  const tracker = trackerRef.current;

  // ---- per-session agent memory (mirrors useProviders model logic) ----
  // shared last hand-picked agent — visible to every window/instance via localStorage
  // only real selections persist — never wipe stored one with ""
  useEffect(() => {
    if (agentSel) {
      try {
        localStorage.setItem(LAST_AGENT_KEY, agentSel);
      } catch {}
    }
  }, [agentSel]);

  // live sync: another window picked an agent -> reflect here unless active session has its own remembered agent
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

  // session switch (or agents arriving late): re-apply the active session's remembered agent
  // when it exists and is still reachable; otherwise fall back to shared global last agent
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

  // auto permission responder — fires POST without showing the bar
  const autoRespondPermission = useCallback(async (ask: PermAsk, response: "always" | "reject") => {
    const dirFor = sessionDirRef.current.get(ask.sessionID) ?? getDirectory();
    try {
      const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
      await (client as any).postSessionIdPermissionsPermissionId({
        path: { id: ask.sessionID, permissionID: ask.id },
        body: { response },
      });
    } catch (e) {
      pushToast(String(e));
    }
  }, []);
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
  }

  // --- multi-workspace helpers ---
  const sessionDirRef = useRef<Map<string, string>>(new Map());
  const getWorkspaces = useCallback((): string[] => {
    try {
      const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
      const arr = Array.isArray(raw.workspaces) ? raw.workspaces : [];
      return arr.filter((x: unknown) => typeof x === "string" && (x as string).trim()).slice(0, 5);
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
      const key = isWindows() ? t.toLowerCase() : t;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [getWorkspaces]);
  const getDirForSession = useCallback((id: string): string => {
    return sessionDirRef.current.get(id) ?? getDirectory();
  }, []);

  const refreshSessionsFor = useCallback(async (dir: string) => {
    const { client } = dir ? await opencodeFor(dir) : await opencode();
    const r = await (client.session as any).list();
    const list = ((r.data ?? []) as Session[])
      .filter((s) => !hiddenSessions.has(s.id) && s.title !== HIDDEN_TITLE && !(s as any).parentID)
      .map((s) => ({ ...s, _dir: dir } as Session & { _dir: string }));
    for (const s of list) sessionDirRef.current.set(s.id, dir);
    return applyOverrides(list);
  }, []);

  const refreshSessions = useCallback(async () => {
    const dirs = getAllDirs();
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
    const norm = (s: string) => isWindows() ? s.toLowerCase() : s;
    const dirSet = new Set(dirs.map((d) => (d ? norm(d) : "__EMPTY__")));
    const hasDir = (dir: string) => dirSet.has(dir ? norm(dir) : "__EMPTY__");
    for (const [id, dir] of sessionDirRef.current) if (!nextMap.has(id) && hasDir(dir ?? "")) nextMap.set(id, dir);
    sessionDirRef.current = nextMap;
    const out = applyOverrides(all);
    const finalMap = new Map<string, string>();
    for (const s of out) {
      const d = (s as any)._dir ?? nextMap.get(s.id) ?? getDirectory();
      finalMap.set(s.id, d);
    }
    for (const [id, dir] of nextMap) if (!finalMap.has(id) && hasDir(dir ?? "")) finalMap.set(id, dir);
    sessionDirRef.current = finalMap;
    setSessions(out);
    return out;
  }, [refreshSessionsFor, getAllDirs]);

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
    const dirForOpen = sessionDirRef.current.get(id);
    if (dirForOpen) touchWorkspace(dirForOpen);
    activeRef.current = id;
    setActiveId(id);
    setPermission(permissionsRef.current.get(id) ?? null);
    setQuestion(questionsRef.current.get(id) ?? null);
    const cached = store.cached(id);
    setMsgs(cached ? [...cached] : []);
    const seq = store.beginFetch(id);
    const dirFor = dirForOpen ?? getDirectory();
    const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
    const r = await (client.session as any).messages({ path: { id } });
    if (store.isStale(id, seq)) return;
    // mid-stream the SSE-mutated store is NEWER than any fetch snapshot
    // (opencode persists part text only at milestones) — don't reset it
    if (busyRef.current.has(id)) {
      // became busy after fetch started — preserve streaming store
      // seed only if store was empty (prevents forever-empty view)
      if (!store.cached(id)?.length) {
        const list = (r.data ?? []) as Msg[];
        store.setFetched(id, list);
        if (activeRef.current === id) setMsgs(list);
      }
      return;
    }
    const list = (r.data ?? []) as Msg[];
    store.setFetched(id, list);
    // user may have switched away while we were fetching — update the
    // session's store but never clobber another session's view
    if (activeRef.current === id) setMsgs(list);
  }, []);

  useEffect(() => {
    const esMap = new Map<string, EventSource>();
    let disposed = false;

    const onEvent = (e: OpenCodeEvent, dirHint?: string) => {
      const p = e.properties;
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
          // sub-agent task finished — pull its cost so per-task chip + total update without waiting for poll
          const ap = part as any;
          if (ap.tool === "task" && ap.state?.status === "completed") {
            setTimeout(() => void refreshChildrenRef.current(activeRef.current), 400);
          }
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
          const mode = getSecurityModeFor(p.sessionID);
          if (mode === "full") {
            void autoRespondPermission(ask, "always");
            break;
          }
          if (mode === "block") {
            void autoRespondPermission(ask, "reject");
            break;
          }
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
          const mode2 = getSecurityModeFor(p.sessionID);
          if (mode2 === "full") {
            void autoRespondPermission(ask, "always");
            break;
          }
          if (mode2 === "block") {
            void autoRespondPermission(ask, "reject");
            break;
          }
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
          const parent = (s as any).parentID;
          if (parent) {
            if (parent === activeRef.current) void refreshChildrenRef.current(activeRef.current);
            break;
          }
          if (hiddenSessions.has(s.id) || s.title === HIDDEN_TITLE) break;
          const dir = dirHint ?? getDirectory();
          sessionDirRef.current.set(s.id, dir);
          const overrides = getTitleOverrides();
          const patched = overrides[s.id] ? { ...s, title: overrides[s.id], _dir: dir } as any : { ...s, _dir: dir } as any;
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
          const parent2 = (s as any).parentID;
          if (parent2) {
            if (parent2 === activeRef.current) void refreshChildrenRef.current(activeRef.current);
            break;
          }
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
            sessionDirRef.current.delete(delId);
            store.remove(delId);
            tracker.reset(delId);
            markCompacting(delId, false);
            clearDraft(delId);
            questionsRef.current.delete(delId);
            permissionsRef.current.delete(delId);
            clearAttention(delId);
            setSessionSecurity((prev) => {
              if (!(delId in prev)) return prev;
              const next = { ...prev };
              delete next[delId];
              return next;
            });
            setSessionAgents((prev) => {
              if (!(delId in prev)) return prev;
              const next = { ...prev };
              delete next[delId];
              return next;
            });
            prov.rememberSession(delId, "");
            prov.forgetVariantSession(delId);
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
          // or agent file, refresh the registry (debounced; new files may need
          // an app restart per server behavior, edits/deletes show up)
          {
            const path = `${p.file ?? p.path ?? ""}`;
            // relay for the file viewer's external-change detection
            window.dispatchEvent(new CustomEvent("oc:file-changed", { detail: path }));
            if (path.includes(".opencode") && Date.now() - cmdFetchAt.current > 1000) {
              cmdFetchAt.current = Date.now();
              refreshCommands().catch(() => {});
            }
            const isAgentPath = path.includes("agent") || path.endsWith(".md");
            if (isAgentPath && Date.now() - agentFetchAt.current > 1000) {
              agentFetchAt.current = Date.now();
              refreshAgents().catch(() => {});
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
        const { base, client } = await opencode();
        baseRef.current = base;
        let currentBase = base;
        // one live SSE per workspace (5 max) — each filtered by ?directory=
        let liveCount = 0;
        const updateLive = () => setLive(liveCount > 0);
        const setupSSE = (baseVal: string) => {
          const dirs = getAllDirs();
          for (const d of dirs) {
            if (esMap.has(d)) continue;
            const url = d ? `${baseVal}/event?directory=${encodeURIComponent(d)}` : `${baseVal}/event`;
            const es = new EventSource(url);
            es.onopen = () => { liveCount++; updateLive(); };
            es.onerror = () => { /* EventSource auto-reconnects; live reflects open count */ };
            es.onmessage = (ev) => {
              try { onEvent(JSON.parse(ev.data), d); } catch {}
            };
            esMap.set(d, es);
          }
        };
        setupSSE(currentBase);
        // watch for workspace list changes — add/remove streams live; re-subscribes when base changes
        const wsInterval = window.setInterval(async () => {
          if (disposed) return;
          let liveBase = baseRef.current || currentBase;
          try {
            const r = await opencode().catch(() => null as any);
            if (r?.base) { liveBase = r.base; if (liveBase !== baseRef.current) baseRef.current = liveBase; }
          } catch {}
          if (liveBase !== currentBase) {
            for (const es of esMap.values()) es.close();
            esMap.clear();
            currentBase = liveBase;
            baseRef.current = liveBase;
            liveCount = 0;
            updateLive();
          }
          const cur = getAllDirs();
          // add new
          for (const d of cur) if (!esMap.has(d)) {
            const url = d ? `${liveBase}/event?directory=${encodeURIComponent(d)}` : `${liveBase}/event`;
            const es = new EventSource(url);
            es.onopen = () => { liveCount++; updateLive(); };
            es.onerror = () => {};
            es.onmessage = (ev) => { try { onEvent(JSON.parse(ev.data), d); } catch {} };
            esMap.set(d, es);
          }
          // remove gone (closed workspace)
          for (const [d, es] of [...esMap]) if (!(cur as string[]).includes(d)) { es.close(); esMap.delete(d); }
        }, 2000);
        // store interval for cleanup via closure
        (esMap as any)._interval = wsInterval;

        const lastId = localStorage.getItem(LAST_KEY);
        const target = list.find((s) => s.id === lastId) ?? list[0];
        if (target && !disposed)
          await withDeadline(openSession(target.id), 15_000, "session reopen").catch(() => {});

        if (!disposed) await prov.loadProviders(client).catch(() => {});
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
            for (const sid of touched) syncAttention(sid);
            showQuestion(activeRef.current);
          })
          .catch(() => {});
        // same for permissions — best-effort (endpoint may not exist in older server)
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
                title: p.metadata?.command ?? p.metadata?.title ?? p.title ?? p.type ?? "permission",
              };
              void autoRespondPermission(ask, resp);
              continue;
            }
            const ask: PermAsk = {
              id: p.id,
              sessionID: p.sessionID,
              type: p.permission ?? p.type ?? "permission",
              title: p.metadata?.command ?? p.metadata?.title ?? p.title ?? p.type ?? "permission",
            };
            permissionsRef.current.set(ask.sessionID, ask); touched.add(ask.sessionID);
          }
          for (const sid of touched) syncAttention(sid);
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
      const iv = (esMap as any)._interval as number | undefined;
      if (iv) window.clearInterval(iv);
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
    const { client } = effDir ? await opencodeFor(effDir) : await opencode();
    const r = await (client.session as any).create({ body: {} });
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
      if (!m) try { m = localStorage.getItem("oc.lastModel") || ""; } catch {}
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
      const { client } = dir ? await opencodeFor(dir) : await opencode();
      const r = await (client.session as any).children({ path: { id: sid } });
      const raw = (r as any)?.data ?? (r as any)?.value ?? r;
      const list: Session[] = Array.isArray(raw) ? raw : Array.isArray((r as any)?.data) ? (r as any).data : [];
      // ponytail: one-level fetch; recurse if nesting matters (rare)
      // fetch grandchildren best-effort so nested sub-agents are not missed
      if (list.length) {
        try {
          const deeper = await Promise.all(list.map(async (c: any) => {
            try {
              const rr = await (client.session as any).children({ path: { id: c.id } });
              const dd = (rr as any)?.data ?? (rr as any)?.value ?? [];
              return Array.isArray(dd) ? dd : [];
            } catch { return []; }
          }));
          const extra = deeper.flat() as Session[];
          // dedup by id
          const seen = new Set(list.map((s: any) => s.id));
          for (const ch of extra) if (!seen.has((ch as any).id)) { seen.add((ch as any).id); list.push(ch); }
        } catch {}
      }
      const sig = JSON.stringify(list);
      if (sig !== childrenSigRef.current) {
        childrenSigRef.current = sig;
        setActiveChildren(list);
      }
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
  // while the session is busy sub-agents may still be streaming — poll the
  // children cost every 3s so the total climbs live instead of snapping at the end
  useEffect(() => {
    if (!activeId || !busyIds.has(activeId)) return;
    const iv = window.setInterval(() => void refreshActiveChildren(activeId), 3000);
    return () => clearInterval(iv);
  }, [activeId, busyIds, refreshActiveChildren]);
  // when the turn settles (busy → idle) the last task's final cost lands right
  // after the last delta — pull once more so total is not stale for 3s
  const prevBusyRef = useRef(false);
  useEffect(() => {
    const was = prevBusyRef.current;
    const isBusy = !!activeId && busyIds.has(activeId);
    prevBusyRef.current = isBusy;
    if (was && !isBusy && activeId) void refreshActiveChildren(activeId);
  }, [busyIds, activeId, refreshActiveChildren]);
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
    for (const ch of activeChildren) {
      const c = ch as any;
      cost += c.cost ?? 0;
      const t = c.tokens ?? {};
      tokens += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
    }
    return { cost, tokens };
  }, [msgs, activeId, activeChildren]);
  const childTaskCosts = useMemo(() => {
    const m: Record<string, { cost: number; tokens: number; title?: string }> = {};
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
      tracker.markBusy(sid, true);
      try {
        const dirFor = sessionDirRef.current.get(sid) ?? getDirectory();
        const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
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
        await (client.session as any).promptAsync({ path: { id: sid }, body });
      } catch (e) {
        tracker.reset(sid);
        // surface it in the history (synthetic error bubble) + toast
        store.addError(sid, String(e));
        pushToast(String(e));
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
      if (!files?.length && trimmed.startsWith("/")) {
        store.addCommand(activeId, trimmed);
        return;
      }
      if (busyRef.current.has(activeId)) {
        tracker.pushQueued(activeId, { text: trimmed, files });
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
    const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
    await (client.session as any).abort({ path: { id: activeId } }).catch(() => {});
  }, [activeId, markCompacting, clearAttention]);

  const respondToPermission = useCallback(
    async (response: "once" | "always" | "reject") => {
      if (!permission) return;
      const perm = permission;
      permissionsRef.current.delete(perm.sessionID);
      setPermission(null);
      syncAttention(perm.sessionID);
      const dirFor = sessionDirRef.current.get(perm.sessionID) ?? getDirectory();
      const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
      await (client as any)
        .postSessionIdPermissionsPermissionId({
          path: { id: perm.sessionID, permissionID: perm.id },
          body: { response },
        })
        .catch((e) => pushToast(String(e)));
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
    },
    [question, syncAttention],
  );

  const rejectQuestion = useCallback(async () => {
    if (!question) return;
    const ask = question;
    setQuestion(null);
    questionsRef.current.delete(ask.sessionID);
    syncAttention(ask.sessionID);
    const dirFor = sessionDirRef.current.get(ask.sessionID) ?? getDirectory();
    await serverFetchFor(dirFor, `/question/${ask.id}/reject`, { method: "POST" }).catch(() => {});
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
      let pasteText = "";
      try {
        const all = store.cached(id) ?? msgsRef.current;
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
            const target = all[idx];
            if (target?.info?.role === "user") pasteText = extract(target);
          }
        }
      } catch {}
      const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
      const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
      await (client.session as any).revert({ path: { id }, body: { messageID } }).catch(() => {});
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
    const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
    await (client.session as any).unrevert({ path: { id } }).catch(() => {});
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
  const undoTarget = useMemo(() => {
    if (!activeId) return "";
    const users = msgs.filter((m) => m.info.role === "user" && !(m as any)._isCommand).map((m) => m.info.id);
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
      const sidBefore = activeRef.current;
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
        newSession,
        revertTo,
        unrevert,
        cycleAgent,
        refreshSessions,
        openSession,
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
    ],
  );

  // recompute every render — pluginSlash is external mutable state, so memo
  // deps would be fragile (event race). List is small, no perf concern.
  const cmdList = buildCmdList(commands, {
    agents,
    agentSel,
    modelVariants: prov.modelVariants,
    variantSel: prov.variantSel,
    pluginSlash: getPluginSlash(),
  });

  const removeSession = useCallback(
    async (id: string) => {
      const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
      if (dirFor) touchWorkspace(dirFor);
      const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
      await (client.session as any).delete({ path: { id } }).catch(() => {});
      sessionDirRef.current.delete(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      store.remove(id);
      questionsRef.current.delete(id);
      permissionsRef.current.delete(id);
      clearAttention(id);
      markCompacting(id, false);
      tracker.reset(id);
      clearDraft(id);
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
      if (activeRef.current === id) {
        setActiveId("");
        store.clearStashes();
        setMsgs([]);
        setQuestion(null);
        setPermission(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markCompacting, clearAttention],
  );

  const renameSession = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim().slice(0, 120);
    if (!trimmed) return;
    try {
      const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
      const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
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
    const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
    const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
    const r: any = await (client.session as any).fork({ path: { id } });
    const s = r.data as Session;
    sessionDirRef.current.set(s.id, dirFor);
    // copy per-session chip values from source session so duplicate inherits
    try {
      const srcModel = (prov as any).sessionModels?.[id];
      if (srcModel) prov.rememberSession(s.id, srcModel);
      else {
        let m: string = prov.modelSel || "";
        if (!m) try { m = localStorage.getItem("oc.lastModel") || ""; } catch {}
        if (!m) m = prov.defaultModel || "";
        if (m) prov.rememberSession(s.id, m);
      }
      const srcAgent = sessionAgents[id];
      if (srcAgent) rememberAgentSession(s.id, srcAgent);
      else if (agentSel) rememberAgentSession(s.id, agentSel);
      const srcSec = sessionSecurity[id] as SecurityMode | undefined;
      if (srcSec) rememberSecuritySession(s.id, srcSec);
      else if (securityModeRef.current) rememberSecuritySession(s.id, securityModeRef.current);
      const srcVariant = (prov as any).sessionVariants?.[id];
      if (srcVariant) prov.rememberVariantSession(s.id, srcVariant);
      else if (prov.variantSel) prov.rememberVariantSession(s.id, prov.variantSel);
    } catch {}
    await guardedRefresh();
    await openSession(s.id);
    return s.id;
  }, [guardedRefresh, openSession, sessionAgents, sessionSecurity, agentSel, prov.modelSel, prov.defaultModel, prov.variantSel]);

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
    const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
    const r: any = await (client.session as any).fork({ path: { id }, body: { messageID } });
    const s = r.data as Session;
    sessionDirRef.current.set(s.id, dirFor);
    // fork inherits per-session chip values from source session
    try {
      const srcModel = (prov as any).sessionModels?.[id];
      if (srcModel) prov.rememberSession(s.id, srcModel);
      else {
        let m: string = prov.modelSel || "";
        if (!m) try { m = localStorage.getItem("oc.lastModel") || ""; } catch {}
        if (!m) m = prov.defaultModel || "";
        if (m) prov.rememberSession(s.id, m);
      }
      const srcAgent = sessionAgents[id];
      if (srcAgent) rememberAgentSession(s.id, srcAgent);
      else if (agentSel) rememberAgentSession(s.id, agentSel);
      const srcSec = sessionSecurity[id] as SecurityMode | undefined;
      if (srcSec) rememberSecuritySession(s.id, srcSec);
      else if (securityModeRef.current) rememberSecuritySession(s.id, securityModeRef.current);
      const srcVariant = (prov as any).sessionVariants?.[id];
      if (srcVariant) prov.rememberVariantSession(s.id, srcVariant);
      else if (prov.variantSel) prov.rememberVariantSession(s.id, prov.variantSel);
    } catch {}
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
  }, [guardedRefresh, openSession, sessionAgents, sessionSecurity, agentSel, prov.modelSel, prov.defaultModel, prov.variantSel]);

  const togglePin = useCallback((id: string) => {
    try {
      const set = getPinned();
      if (set.has(id)) set.delete(id); else set.add(id);
      localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
      setSessions((prev) => applyOverrides([...prev]));
    } catch {}
  }, []);

  const isPinned = useCallback((id: string) => getPinned().has(id), []);

  const clearSessionsFor = useCallback(async (dir: string) => {
    if (dir) touchWorkspace(dir);
    const norm = (dir ?? "").toLowerCase();
    const ids = sessionsRef.current
      .filter((s) => (sessionDirRef.current.get(s.id) ?? "").toLowerCase() === norm)
      .map((s) => s.id);
    if (!ids.length) return;
    await Promise.all(
      ids.map(async (id) => {
        const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
        const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
        return (client.session as any).delete({ path: { id } }).catch(() => {});
      }),
    );
    for (const id of ids) {
      sessionDirRef.current.delete(id);
      store.remove(id);
      questionsRef.current.delete(id);
      permissionsRef.current.delete(id);
      clearAttention(id);
      markCompacting(id, false);
      tracker.reset(id);
      clearDraft(id);
    }
    setSessionSecurity((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) if (id in next) { delete next[id]; changed = true; }
      return changed ? next : prev;
    });
    setSessionAgents((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) if (id in next) { delete next[id]; changed = true; }
      return changed ? next : prev;
    });
    for (const id of ids) {
      prov.rememberSession(id, "");
      prov.forgetVariantSession(id);
    }
    setSessions((prev) => prev.filter((s) => !ids.includes(s.id)));
    if (activeRef.current && ids.includes(activeRef.current)) {
      setActiveId("");
      store.clearStashes();
      setMsgs([]);
      setQuestion(null);
      setPermission(null);
      setCompactingIds(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, tracker, markCompacting, clearAttention]);

  // clear every session across all workspaces
  const clearSessions = useCallback(async () => {
    const ids = [...sessionsRef.current.map((s) => s.id)];
    await Promise.all(
      ids.map(async (id) => {
        const dirFor = sessionDirRef.current.get(id) ?? getDirectory();
        const { client } = dirFor ? await opencodeFor(dirFor) : await opencode();
        return (client.session as any).delete({ path: { id } }).catch(() => {});
      }),
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
    setSessionSecurity((prev) => (Object.keys(prev).length ? {} : prev));
    setSessionAgents((prev) => (Object.keys(prev).length ? {} : prev));
    for (const id of ids) {
      prov.rememberSession(id, "");
      prov.forgetVariantSession(id);
    }
    setActiveId("");
    store.clearStashes();
    setMsgs([]);
    setQuestion(null);
    setPermission(null);
    setCompactingIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, tracker, markCompacting, clearAttention]);

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
    sessionUsage,
    activeChildren,
    childTaskCosts,
    refreshActiveChildren,
    abort,
    respondToPermission,
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
    refreshSessionsFor,
    clearSessionsFor,
  };
}

