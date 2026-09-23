// Multi-workspace session listing, extracted verbatim from useOpencode.
// Owns: the workspace dir enumeration (getAllDirs/getDirForSession), the
// cross-server session fetch (refreshSessionsFor → refreshSessions), the
// TF-04 serialized guardedRefresh, the live oc:workspaces-changed
// re-listing listener, and the debug filler-session registry. Shared refs
// (sessionDirRef) + view state (sessions/activeId/msgs) stay owned by
// useOpencode and arrive here through deps.
import { useCallback, useEffect, useRef } from "react";
import type { OpencodeClient, Session } from "@opencode-ai/sdk/client";
import { getDirectory, hiddenSessions, HIDDEN_TITLE } from "../api";
import { getExtraWorkspaces } from "../lib/workspace";
import { normWorkspace } from "../lib/platform";
import { applyOverrides } from "../lib/sessionMeta";
import { invalidateFileCache } from "./useFileCache";
import type { createSessionStore } from "../lib/sessionStore";
import type { createBusyTracker } from "../lib/busyTracker";
import type { Msg, PermAsk, QuestionAsk } from "../types";

type SessionStore = ReturnType<typeof createSessionStore>;
type BusyTracker = ReturnType<typeof createBusyTracker>;

// fake filler sessions created by /debug-long-session — client-side only,
// re-added to the sidebar on refreshes while their workspace stays open
const debugSessions = new Map<string, { session: Session; dir: string }>();
export function addDebugSession(id: string, sess: Session, dir: string): void {
  debugSessions.set(id, { session: sess, dir });
}
export function dropDebugSession(id: string): void {
  debugSessions.delete(id);
}

export type WorkspaceSessionsDeps = {
  sessionDirRef: { current: Map<string, string> };
  activeRef: { current: string };
  LAST_KEY: string;
  clientFor: (dir?: string) => Promise<{ client: OpencodeClient }>;
  store: SessionStore;
  trackerRef: { current: BusyTracker | undefined };
  setActiveId: (id: string) => void;
  setSessions: (fn: (prev: Session[]) => Session[]) => void;
  setMsgs: (m: Msg[]) => void;
  markCompacting: (sid: string, on: boolean) => void;
  askRefs: {
    permissionsRef: { current: Map<string, PermAsk> };
    questionsRef: { current: Map<string, QuestionAsk> };
    clearAttention: (sid: string) => void;
    setQuestion: (q: QuestionAsk | null | ((cur: QuestionAsk | null) => QuestionAsk | null)) => void;
    setPermission: (p: PermAsk | null | ((cur: PermAsk | null) => PermAsk | null)) => void;
  };
};

export function useWorkspaceSessions(deps: WorkspaceSessionsDeps) {
  const { sessionDirRef, activeRef, LAST_KEY, clientFor, store, trackerRef, setActiveId, setSessions, setMsgs, markCompacting, askRefs } = deps;
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
    // "" alone is the home workspace (server cwd → user dir): list its
    // sessions like any other dir so Close All lands on a usable view
    // instead of an empty UI.
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
    setSessions(() => out);
    // workspace closed under the active session (not a transient fetch
    // failure): drop the stale view so the old chat doesn't linger. The
    // server keeps the sessions — re-adding the workspace brings them back.
    if (prevActiveId && !out.some((s) => s.id === prevActiveId)) {
      const gone = prevActiveDir !== undefined ? !hasDir(prevActiveDir ?? "") : false;
      // prevActiveDir unknown (e.g. boot) → keep view, fetch may have failed
      if (gone) {
        try {
          askRefs.permissionsRef.current.delete(prevActiveId);
          askRefs.questionsRef.current.delete(prevActiveId);
          askRefs.clearAttention(prevActiveId);
          markCompacting(prevActiveId, false);
          trackerRef.current?.reset(prevActiveId);
        } catch {}
        setActiveId("");
        try { localStorage.removeItem(LAST_KEY); } catch {}
        store.clearStashes();
        setMsgs([]);
        askRefs.setQuestion(null);
        askRefs.setPermission(null);
      }
    }
    // stale attention for sessions whose workspace is gone (badge would linger)
    try {
      for (const [id, dir] of prevMap) {
        if (!hasDir(dir ?? "") && !finalMap.has(id)) {
          askRefs.permissionsRef.current.delete(id);
          askRefs.questionsRef.current.delete(id);
          askRefs.clearAttention(id);
        }
      }
      if (prevActiveId && !finalMap.has(prevActiveId)) {
        askRefs.setQuestion((cur) => (cur && cur.sessionID === prevActiveId ? null : cur));
        askRefs.setPermission((cur) => (cur && cur.sessionID === prevActiveId ? null : cur));
      }
    } catch {}
    return out;
  }, [refreshSessionsFor, getAllDirs, store, markCompacting]);

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
  // dirs; SSE streams converge via the reconcile loop, busy sessions on
  // untouched workspaces keep streaming
  useEffect(() => {
    const onWs = () => { void guardedRefresh(); };
    window.addEventListener("oc:workspaces-changed", onWs);
    return () => window.removeEventListener("oc:workspaces-changed", onWs);
  }, [guardedRefresh]);

  return {
    getWorkspaces,
    getAllDirs,
    getDirForSession,
    refreshSessionsFor,
    refreshSessions,
    guardedRefresh,
  };
}

export type WorkspaceSessionsApi = ReturnType<typeof useWorkspaceSessions>;

