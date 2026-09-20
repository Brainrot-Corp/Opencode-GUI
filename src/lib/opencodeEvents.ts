// SSE event dispatch — moved verbatim out of useOpencode's boot effect.
// Pure dispatcher: no state of its own except the two file-watcher throttle
// timestamps; everything else arrives through ctx (built once per boot).
import type { Message, Session } from "@opencode-ai/sdk/client";
import { getDirectory, hiddenSessions, HIDDEN_TITLE } from "../api";
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
  getSecurityModeFor: (sid: string) => "full" | "user" | "block";
  autoRespondPermission: (ask: PermAsk, response: "always" | "reject") => Promise<void>;
  resolveParent: (sid: string, dirHint?: string) => Promise<void>;
  restoreFailedInput: (sid: string) => void;
  handlePermAsk: (ask: PermAsk, dirHint?: string, sound?: boolean) => void;
  handleQuestionAsk: (ask: QuestionAsk, dirHint?: string) => void;
  clearPermissionAsk: (pid: string | undefined, sid?: string) => void;
  clearQuestionAsk: (qid: string | undefined, sid?: string) => void;
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
      if (info.role === "assistant" && info.providerID && info.modelID) {
        ctx.learnServerDefault(info.providerID, info.modelID);
      }
      ctx.store.applyMessage(info);
      break;
    }
    case "message.part.updated": {
      const part = p.part;
      if (!part) return;
      ctx.store.applyPart(part);
      // sub-agent task finished — pull its cost so per-task chip + total update without waiting for poll
      if (part.tool === "task" && part.state?.status === "completed") {
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
      ctx.clearPermissionAsk(pid, p.sessionID);
      break;
    }
    case "question.asked":
    case "question.v2.asked": {
      // question tool ask: {id, sessionID, questions:[{question,header,options,multiple?,custom?}]}
      ctx.handleQuestionAsk(
        {
          id: p.id ?? p.requestID,
          sessionID: p.sessionID,
          questions: Array.isArray(p.questions) ? p.questions : [],
        },
        dirHint,
      );
      break;
    }
    case "question.replied":
    case "question.v2.replied":
    case "question.rejected":
    case "question.v2.rejected": {
      ctx.clearQuestionAsk(p.requestID ?? p.id, p.sessionID);
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
      const err = p.error;
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
      const parent = s.parentID;
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
      const parent2 = s.parentID;
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
