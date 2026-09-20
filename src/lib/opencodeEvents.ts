// SSE event dispatch — moved verbatim out of useOpencode's boot effect.
// Pure dispatcher: no state of its own except the two file-watcher throttle
// timestamps; everything else arrives through ctx (built once per boot).
import type { Message, Session } from "@opencode-ai/sdk/client";
import { getDirectory, hiddenSessions, HIDDEN_TITLE } from "../api";
import { playSound } from "./sounds";
import { pushToast } from "../hooks/useToast";
import type { createBusyTracker } from "./busyTracker";
import type { createSessionStore } from "./sessionStore";
import type { OpenCodeEvent, PermAsk, QuestionAsk } from "../types";

type BusyTracker = ReturnType<typeof createBusyTracker>;
type SessionStore = ReturnType<typeof createSessionStore>;

export type OpenCodeEventCtx = {
  store: SessionStore;
  tracker: BusyTracker;
  busyRef: { current: Set<string> };
  activeRef: { current: string };
  childParentRef: { current: Map<string, string> };
  sessionDirRef: { current: Map<string, string> };
  permissionsRef: { current: Map<string, PermAsk> };
  questionsRef: { current: Map<string, QuestionAsk> };
  getSecurityModeFor: (sid: string) => "full" | "user" | "block";
  autoRespondPermission: (ask: PermAsk, response: "always" | "reject") => Promise<void>;
  resolveParent: (sid: string, dirHint?: string) => Promise<void>;
  restoreFailedInput: (sid: string) => void;
  handlePermAsk: (ask: PermAsk, dirHint?: string, sound?: boolean) => void;
  syncAttention: (sid: string) => void;
  emitPermission: (sid: string) => void;
  emitQuestion: (sid: string) => void;
  syncTopBadge: (topId: string) => void;
  topOfSession: (sid: string) => string;
  setPermission: (p: PermAsk | null | ((cur: PermAsk | null) => PermAsk | null)) => void;
  setQuestion: (q: QuestionAsk | null | ((cur: QuestionAsk | null) => QuestionAsk | null)) => void;
  setSessions: (fn: (prev: Session[]) => Session[]) => void;
  markCompacting: (sid: string, on: boolean) => void;
  applyOverrides: (list: Session[]) => Session[];
  teardownSession: (sid: string) => void;
  refreshSessions: () => Promise<Session[]>;
  refreshCommands: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshChildrenRef: { current: (sid: string) => Promise<void> };
  learnServerDefault: (providerID: string, modelID: string) => void;
};

// command/agent registry refetch throttle for file-watcher bursts
let cmdFetchAt = 0;
let agentFetchAt = 0;

// permission title fallback chain shared by the SSE ask handlers —
// first non-empty of command / metadata title / event title
function askTitle(p: any, extra: string, fallback: string): string {
  return p.metadata?.command || p.metadata?.title || p.title || extra || fallback;
}

export function handleOpenCodeEvent(ev: OpenCodeEvent, ctx: OpenCodeEventCtx, dirHint?: string) {
  const p = ev.properties;
  if (typeof ev.type === "string" && ev.type.includes("compaction")) {
    const sid = p.sessionID ?? p.id;
    if (sid) {
      if (ev.type.endsWith(".started") || ev.type.endsWith(".delta")) ctx.markCompacting(sid, true);
      else if (ev.type.endsWith(".ended") || ev.type === "session.compacted") ctx.markCompacting(sid, false);
    }
  }
  switch (ev.type) {
    case "message.updated": {
      const info = p.info as Message;
      const sid = info.sessionID;
      if (info.role === "assistant" && info.time?.completed) {
        // last live message done — but the turn may continue with a
        // new message any moment; settle only after the grace window
        if (ctx.tracker.dropInflight(sid, info.id)) ctx.tracker.settle(sid);
      } else if (info.role === "assistant") {
        ctx.tracker.cancelSettle(sid);
        ctx.tracker.addInflight(sid, info.id);
        // a live message means definitely working — restore the
        // indicators even if an early idle/completion cleared them
        if (!ctx.busyRef.current.has(sid)) ctx.tracker.markBusy(sid, true);
      }
      // learn the server's real default from a reply we did NOT steer
      if (
        info.role === "assistant" &&
        (info as any).providerID &&
        (info as any).modelID
      ) {
        ctx.learnServerDefault((info as any).providerID, (info as any).modelID);
      }
      ctx.store.applyMessage(info);
      break;
    }
    case "message.part.updated": {
      const part = p.part;
      if (!part) return;
      ctx.store.applyPart(part);
      // sub-agent task finished — pull its cost so per-task chip + total update without waiting for poll
      const ap = part as any;
      if (ap.tool === "task" && ap.state?.status === "completed") {
        setTimeout(() => void ctx.refreshChildrenRef.current(ctx.activeRef.current), 400);
      }
      break;
    }
    case "message.part.delta": {
      // incremental stream chunk: {sessionID, messageID, partID, field, delta}
      if (p.field !== "text") return;
      ctx.store.applyDelta(p);
      break;
    }
    case "permission.asked":
    case "permission.v2.asked": {
      // {id, sessionID, permission|action|type, metadata, patterns}
      const type = p.permission ?? p.action ?? p.type ?? "permission";
      ctx.handlePermAsk(
        {
          id: p.id,
          sessionID: p.sessionID,
          type,
          title: askTitle(p, (p.patterns ?? []).join(", "), type),
        },
        dirHint,
        true,
      );
      break;
    }
    case "permission.updated": {
      ctx.handlePermAsk(
        {
          id: p.id ?? p.permissionID ?? p.requestID,
          sessionID: p.sessionID,
          type: p.type ?? p.permission ?? "permission",
          title: p.title ?? p.type ?? p.permission ?? "permission",
        },
        dirHint,
      );
      break;
    }
    case "permission.replied":
    case "permission.v2.replied": {
      const pid = p.permissionID ?? p.requestID ?? p.id;
      const sid = p.sessionID;
      const affected = new Set<string>();
      if (pid) {
        for (const [s, perm] of [...ctx.permissionsRef.current])
          if (perm.id === pid) { ctx.permissionsRef.current.delete(s); affected.add(s); }
      } else if (sid) {
        if (ctx.permissionsRef.current.has(sid)) affected.add(sid);
        ctx.permissionsRef.current.delete(sid);
      }
      for (const s of affected) {
        ctx.syncAttention(s);
        ctx.emitPermission(s);
        const rtop = ctx.topOfSession(s);
        if (rtop !== s) ctx.syncTopBadge(rtop);
      }
      if (!affected.size && sid) {
        ctx.syncAttention(sid);
        ctx.emitPermission(sid);
        const rtop2 = ctx.topOfSession(sid);
        if (rtop2 !== sid) ctx.syncTopBadge(rtop2);
      }
      ctx.setPermission((cur) =>
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
      ctx.questionsRef.current.set(p.sessionID, ask);
      ctx.syncAttention(p.sessionID);
      ctx.emitQuestion(p.sessionID);
      playSound("attention");
      // subagent asks stay in the subagent's history — never popped into
      // the parent chat. The visible parent only gets the sidebar badge
      // (the child row itself is filtered from the sidebar).
      const top = ctx.topOfSession(p.sessionID);
      if (top !== p.sessionID) {
        ctx.syncTopBadge(top);
        if (!ctx.childParentRef.current.has(p.sessionID)) void ctx.resolveParent(p.sessionID, dirHint);
      } else if (p.sessionID === ctx.activeRef.current) ctx.setQuestion(ask);
      break;
    }
    case "question.replied":
    case "question.v2.replied":
    case "question.rejected":
    case "question.v2.rejected": {
      const qid = p.requestID ?? p.id;
      const affected = new Set<string>();
      if (qid) {
        for (const [sid, q] of [...ctx.questionsRef.current])
          if (q.id === qid) { ctx.questionsRef.current.delete(sid); affected.add(sid); }
        ctx.setQuestion((cur) => (cur && cur.id === qid ? null : cur));
      } else if (p.sessionID) {
        if (ctx.questionsRef.current.has(p.sessionID)) affected.add(p.sessionID);
        ctx.questionsRef.current.delete(p.sessionID);
        ctx.setQuestion((cur) => (cur && cur.sessionID === p.sessionID ? null : cur));
      }
      for (const s of affected) {
        ctx.syncAttention(s);
        ctx.emitQuestion(s);
        const top = ctx.topOfSession(s);
        if (top !== s) ctx.syncTopBadge(top);
      }
      if (!affected.size && p.sessionID) {
        ctx.syncAttention(p.sessionID);
        ctx.emitQuestion(p.sessionID);
        const top = ctx.topOfSession(p.sessionID);
        if (top !== p.sessionID) ctx.syncTopBadge(top);
      }
      break;
    }
    case "session.idle":
      // settles the turn only when no assistant message is still live —
      // mid-turn idles in heavier tasks are ignored
      if (!ctx.tracker.hasInflight(p.sessionID)) ctx.tracker.settle(p.sessionID);
      break;
    case "session.error": {
      // runtime turn failure (provider auth, API errors…) — the prompt
      // call already succeeded, so this event is the ONLY signal. Mirror
      // the prompt-failure path: visible bubble + toast, then settle.
      // (Upstream still skips this event for some paths — e.g. a missing
      // model idles silently — which the per-server model guard above
      // prevents instead.)
      const sid = p.sessionID as string | undefined;
      const err = (p as any).error as any;
      if (err?.name === "MessageAbortedError") break; // ours — abort path owns it
      const msg = String(err?.data?.message ?? err?.message ?? "The server ended the turn with an error.");
      if (sid) {
        ctx.store.addError(sid, msg);
        ctx.tracker.settle(sid);
        // put the failed prompt back in the composer (text + pictures).
        // Guarded: new typing since the send wins over the failed text.
        ctx.restoreFailedInput(sid);
      }
      pushToast(msg);
      break;
    }
    // compaction live indicator — server decides when to compact (auto
    // or manual /compact); we just surface its progress per-session
    case "session.compacted":
      if (p.sessionID) ctx.markCompacting(p.sessionID, false);
      break;
    case "session.next.compaction.started":
      if (p.sessionID) ctx.markCompacting(p.sessionID, true);
      break;
    case "session.next.compaction.delta":
      if (p.sessionID) ctx.markCompacting(p.sessionID, true);
      break;
    case "session.next.compaction.ended":
      if (p.sessionID) ctx.markCompacting(p.sessionID, false);
      break;
    case "session.created": {
      const s = p.info as Session | undefined;
      if (!s?.id) break;
      const parent = (s as any).parentID;
      if (parent) {
        ctx.childParentRef.current.set(s.id, parent);
        if (parent === ctx.activeRef.current) void ctx.refreshChildrenRef.current(ctx.activeRef.current);
        break;
      }
      if (hiddenSessions.has(s.id) || s.title === HIDDEN_TITLE) break;
      const dir = dirHint ?? getDirectory();
      ctx.sessionDirRef.current.set(s.id, dir);
      const patched = { ...s, _dir: dir } as Session & { _dir: string };
      ctx.setSessions((prev) => {
        if (prev.some((x) => x.id === patched.id)) return prev;
        return ctx.applyOverrides([...prev, patched]);
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
        if (parent2 === ctx.activeRef.current) void ctx.refreshChildrenRef.current(ctx.activeRef.current);
        break;
      }
      if (hiddenSessions.has(s.id) || s.title === HIDDEN_TITLE) break;
      ctx.setSessions((prev) => {
        if (!prev.some((x) => x.id === s.id)) return prev;
        return ctx.applyOverrides(prev.map((x) => (x.id === s.id ? s : x)));
      });
      break;
    }
    case "session.deleted": {
      const delId = p.sessionID ?? p.id;
      if (delId) {
        ctx.teardownSession(delId);
        if (delId === ctx.activeRef.current) {
          ctx.setQuestion(null);
          ctx.setPermission(null);
        }
      }
      ctx.refreshSessions().catch(() => {});
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
        if (path.includes(".opencode") && Date.now() - cmdFetchAt > 1000) {
          cmdFetchAt = Date.now();
          ctx.refreshCommands().catch(() => {});
        }
        const isAgentPath = path.includes("agent") || path.endsWith(".md");
        if (isAgentPath && Date.now() - agentFetchAt > 1000) {
          agentFetchAt = Date.now();
          ctx.refreshAgents().catch(() => {});
        }
      }
      break;
  }
}
