// Security mode (full / user / block), extracted verbatim from useOpencode.
// Owns: the per-window global mode (oc.securityMode), per-session pins
// (oc.sessionSecurityMode), workspace-memory restore on boot/session
// switch/workspace switch, auto-pinning of any user-initiated change, and
// cross-window storage sync. The ask auto-responder loop stays in useOpencode
// (it needs both this hook's mode and useAsks' responder).
import { useCallback, useEffect, useRef, useState } from "react";
import { getDirectory } from "../api";
import { playSound } from "../lib/sounds";
import { windowKey } from "../lib/windowScope";
import { getWorkspacePref, recordSelection } from "../lib/workspacePrefs";

export type SecurityMode = "full" | "user" | "block";

const SESSION_SECURITY_KEY = "oc.sessionSecurityMode";

export type SecurityDeps = {
  activeRef: { current: string };
  activeId: string;
};

export function useSecurity({ activeRef, activeId }: SecurityDeps) {
  // security mode: per-session override + global last (mirrors model/agent)
  const SECURITY_KEY = windowKey("oc.securityMode");
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
  const forgetSecuritySession = useCallback((id: string) => {
    setSessionSecurity((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  const restoringSecRef = useRef(false);
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

  // workspace switch → apply the newly-opened workspace's last-used security
  // mode (when known). Same-window custom event only — each window adapts
  // independently. (The agent half of this listener lives in useAgents.)
  useEffect(() => {
    const onWs = () => {
      const s = getWorkspacePref(getDirectory()).security;
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
  }, [SECURITY_KEY]);

  return {
    securityMode,
    securityModeRef,
    sessionSecurity,
    setSecurityMode,
    cycleSecurityMode,
    getSecurityModeFor,
    rememberSecuritySession,
    forgetSecuritySession,
  };
}

export type SecurityApi = ReturnType<typeof useSecurity>;
