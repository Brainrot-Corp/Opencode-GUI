// Per-session agent memory + per-window global agent selection, extracted
// verbatim from useOpencode (mirrors useProviders' model logic). Owns:
// agentSel (per-window last pick), sessionAgents pins (oc.sessionAgents),
// disabledAgents override (oc.disabledAgents), workspace-memory restore
// (boot / session switch / workspace switch), auto-pinning of any
// user-initiated change, and pruning when the registry changes.
// The `agents` list itself (server registry) + refreshAgents stay in
// useOpencode — passed in here for reachability checks.
import { useCallback, useEffect, useRef, useState } from "react";
import { getDirectory } from "../api";
import { playSound } from "../lib/sounds";
import { windowKey } from "../lib/windowScope";
import { getWorkspacePref, recordSelection } from "../lib/workspacePrefs";
import { pinEntry } from "../lib/sessionMeta";

const SESSION_AGENTS_KEY = "oc.sessionAgents";
const LAST_AGENT_BASE = "oc.lastAgent";
const DISABLED_AGENTS_KEY = "oc.disabledAgents";
export function isAgentReachable(name: string, list: { name: string }[]): boolean {
  return !!name && list.some((a) => a.name === name);
}

export type AgentsDeps = {
  agents: { name: string; mode: string }[];
  activeRef: { current: string };
  activeId: string;
};

export function useAgents({ agents, activeRef, activeId }: AgentsDeps) {
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
    setSessionAgents((prev) => pinEntry(prev, sid, value));
  }, []);
  const forgetAgentSession = useCallback((id: string) => {
    setSessionAgents((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  const sessionAgentsRef = useRef(sessionAgents);
  useEffect(() => { sessionAgentsRef.current = sessionAgents; }, [sessionAgents]);
  const restoringAgentRef = useRef(false);

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

  // workspace switch → apply the newly-opened workspace's last-used agent
  // (when known and reachable). Model + effort are handled by useProviders'
  // own listener; security lives in useSecurity's. Same-window custom event
  // only — each window adapts independently; unreachable agents are skipped,
  // never applied blind.
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
    };
    window.addEventListener("oc:workspaces-changed", onWs);
    return () => window.removeEventListener("oc:workspaces-changed", onWs);
  }, [agents, LAST_AGENT_KEY]);

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

  return {
    agentSel,
    setAgentSel,
    sessionAgents,
    sessionAgentsRef,
    rememberAgentSession,
    forgetAgentSession,
    disabledAgents,
    toggleDisabledAgent,
    cycleAgent,
    selectAgent,
  };
}

export type AgentsApi = ReturnType<typeof useAgents>;
