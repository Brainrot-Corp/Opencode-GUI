// Permission + question ask plumbing, extracted verbatim from useOpencode.
// Owns: per-session ask maps, pending popups (permission/question), sidebar
// attention set, child→parent badge lineage, ask listeners (peek/subscribe
// for the subagent viewer), the security auto-responder, and the respond /
// answer / reject paths. Parent composes it and passes shared state via deps.
import { useCallback, useMemo, useRef, useState } from "react";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { getDirectory, serverFetchFor } from "../api";
import { playSound } from "../lib/sounds";
import { pushToast } from "./useToast";
import type { SecurityMode } from "./useSecurity";
import type { PermAsk, QuestionAsk } from "../types";

export type AsksDeps = {
  activeRef: { current: string };
  sessionDirRef: { current: Map<string, string> };
  clientFor: (dir?: string) => Promise<{ client: OpencodeClient }>;
  getSecurityModeFor: (sid: string) => SecurityMode;
};

export function useAsks({ activeRef, sessionDirRef, clientFor, getSecurityModeFor }: AsksDeps) {
  // pending asks, kept per session — returning to a session resurfaces
  // its popup (both permissions and questions outlive session switches)
  const questionsRef = useRef<Map<string, QuestionAsk>>(new Map());
  const [question, setQuestion] = useState<QuestionAsk | null>(null);
  const permissionsRef = useRef<Map<string, PermAsk>>(new Map());
  const [permission, setPermission] = useState<PermAsk | null>(null);
  // sidebar attention: which sessions need a click (permission or question).
  // One map, sid -> kind; attentionIds is the derived key set (same public shape)
  const [attentionKinds, setAttentionKinds] = useState<Record<string, "permission" | "question" | "both">>({});
  const attentionIds = useMemo(() => new Set(Object.keys(attentionKinds)), [attentionKinds]);

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
  }, [clientFor, syncTopBadge, topOfSession]);

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

  // shared question-ask path (SSE question.asked) — mirrors handlePermAsk:
  // store + badge + emit + sound, surface on the visible parent's popup
  const handleQuestionAsk = useCallback(
    (ask: QuestionAsk, dirHint?: string) => {
      if (!ask.sessionID || !ask.id) return;
      questionsRef.current.set(ask.sessionID, ask);
      syncAttention(ask.sessionID);
      emitQuestion(ask.sessionID);
      playSound("attention");
      // subagent asks stay in the subagent's history — never popped into
      // the parent chat. The visible parent only gets the sidebar badge
      // (the child row itself is filtered from the sidebar).
      const top = topOfSession(ask.sessionID);
      if (top !== ask.sessionID) {
        syncTopBadge(top);
        if (!childParentRef.current.has(ask.sessionID)) void resolveParent(ask.sessionID, dirHint);
      } else if (ask.sessionID === activeRef.current) setQuestion(ask);
    },
    [syncAttention, emitQuestion, topOfSession, syncTopBadge, resolveParent],
  );

  // permission.replied — drop every ask matching the request (or the
  // session's), re-sync attention/badges, clear a matching popup
  const clearPermissionAsk = useCallback((pid: string | undefined, sid?: string) => {
    const affected = new Set<string>();
    if (pid) {
      for (const [s, perm] of [...permissionsRef.current])
        if (perm.id === pid) { permissionsRef.current.delete(s); affected.add(s); }
    } else if (sid) {
      if (permissionsRef.current.has(sid)) affected.add(sid);
      permissionsRef.current.delete(sid);
    }
    for (const s of affected) {
      syncAttention(s);
      emitPermission(s);
      const rtop = topOfSession(s);
      if (rtop !== s) syncTopBadge(rtop);
    }
    if (!affected.size && sid) {
      syncAttention(sid);
      emitPermission(sid);
      const rtop2 = topOfSession(sid);
      if (rtop2 !== sid) syncTopBadge(rtop2);
    }
    setPermission((cur) =>
      cur && (cur.id === pid || (sid && cur.sessionID === sid)) ? null : cur,
    );
  }, [syncAttention, emitPermission, topOfSession, syncTopBadge]);

  // question.replied / question.rejected — same ritual as permissions
  const clearQuestionAsk = useCallback((qid: string | undefined, sid?: string) => {
    const affected = new Set<string>();
    if (qid) {
      for (const [s, q] of [...questionsRef.current])
        if (q.id === qid) { questionsRef.current.delete(s); affected.add(s); }
      setQuestion((cur) => (cur && cur.id === qid ? null : cur));
    } else if (sid) {
      if (questionsRef.current.has(sid)) affected.add(sid);
      questionsRef.current.delete(sid);
      setQuestion((cur) => (cur && cur.sessionID === sid ? null : cur));
    }
    for (const s of affected) {
      syncAttention(s);
      emitQuestion(s);
      const top = topOfSession(s);
      if (top !== s) syncTopBadge(top);
    }
    if (!affected.size && sid) {
      syncAttention(sid);
      emitQuestion(sid);
      const top = topOfSession(sid);
      if (top !== sid) syncTopBadge(top);
    }
  }, [syncAttention, emitQuestion, topOfSession, syncTopBadge]);

  // teardown path: drop the session's ask state only (popups cleared by
  // the caller when the active view resets)
  const clearAskState = useCallback((sid: string) => {
    questionsRef.current.delete(sid);
    permissionsRef.current.delete(sid);
    clearAttention(sid);
  }, [clearAttention]);

  // abort path: same + drop matching popups
  const clearSessionAsks = useCallback((sid: string) => {
    if (!sid) return;
    questionsRef.current.delete(sid);
    setQuestion((cur) => (cur?.sessionID === sid ? null : cur));
    permissionsRef.current.delete(sid);
    setPermission((cur) => (cur?.sessionID === sid ? null : cur));
    clearAttention(sid);
  }, [clearAttention]);

  const clearPopups = useCallback(() => {
    setQuestion(null);
    setPermission(null);
  }, []);

  // wipe one session's parent/child lineage entries (teardown ritual)
  const forgetLineage = useCallback((id: string) => {
    for (const [child, parent] of [...childParentRef.current]) {
      if (child === id || parent === id) childParentRef.current.delete(child);
    }
  }, []);

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
    [clientFor, emitPermission, syncAttention, syncTopBadge, topOfSession],
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

  return {
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
    setAttentionFor,
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
    clearPopups,
    forgetLineage,
    autoRespondPermission,
    respondToPermissionFor,
    respondToPermission,
    answerQuestionFor,
    answerQuestion,
    rejectQuestionFor,
    rejectQuestion,
  };
}

export type AsksApi = ReturnType<typeof useAsks>;
