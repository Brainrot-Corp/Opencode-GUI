import { useEffect, useRef, useState } from "react";
import type { Msg, PermAsk, QuestionAsk } from "../types";
import { opencode, opencodeFor } from "../api";
import { pushToast } from "../hooks/useToast";
import { resolveSubagentTarget } from "../lib/subagents";
import Dialog from "./Dialog";
import MessageList from "./MessageList";
import PermissionBar from "./PermissionBar";
import QuestionPopup from "./QuestionPopup";
import "../styles/subagent.css";

export type SubagentChildInfo = {
  id: string;
  title?: string;
  timeCreated?: number;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
};

// read-only subagent transcript — the parent session stays active underneath;
// answering a subagent question still happens in the main QuestionPopup.
// Live: paints from the shared session store (SSE already mutates it for
// every session) so a still-running subagent streams deltas into the modal.
export default function SubagentViewer({
  sessionId,
  dir,
  title,
  children,
  taskCosts,
  collapsed,
  busy,
  peekSession,
  subscribeSession,
  primeSession,
  peekQuestion,
  subscribeQuestion,
  answerQuestionFor,
  rejectQuestionFor,
  peekPermission,
  subscribePermission,
  respondToPermissionFor,
  onPick,
  onClose,
}: {
  sessionId: string | null;
  dir?: string;
  title?: string;
  children: SubagentChildInfo[];
  taskCosts?: Record<string, { cost: number; tokens: number }>;
  collapsed?: boolean;
  busy?: boolean;
  peekSession: (sid: string) => Msg[] | undefined;
  subscribeSession: (sid: string, cb: () => void) => () => void;
  primeSession: (sid: string, dir: string) => Promise<Msg[]>;
  peekQuestion: (sid: string) => QuestionAsk | null;
  subscribeQuestion: (sid: string, cb: () => void) => () => void;
  answerQuestionFor: (ask: QuestionAsk, answers: string[][]) => Promise<void>;
  rejectQuestionFor: (ask: QuestionAsk) => Promise<void>;
  peekPermission: (sid: string) => PermAsk | null;
  subscribePermission: (sid: string, cb: () => void) => () => void;
  respondToPermissionFor: (perm: PermAsk, response: "once" | "always" | "reject") => Promise<void>;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [ask, setAsk] = useState<QuestionAsk | null>(null);
  const [perm, setPerm] = useState<PermAsk | null>(null);
  const [kids, setKids] = useState<SubagentChildInfo[]>([]);
  const [error, setError] = useState("");
  const genRef = useRef(0);
  // deltas arrive in bursts — coalesce mirrors into one paint per frame,
  // same rule as the main session mirror
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  useEffect(() => {
    if (!sessionId) return;
    const gen = ++genRef.current;
    setMsgs(peekSession(sessionId) ?? null);
    setAsk(peekQuestion(sessionId));
    setPerm(peekPermission(sessionId));
    setKids([]);
    setError("");
    let unsub: (() => void) | undefined;
    let unsubQ: (() => void) | undefined;
    let unsubP: (() => void) | undefined;
    const queueMirror = () => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => {
        if (genRef.current !== gen) return;
        const next = peekSession(sessionId);
        if (next) setMsgs(next);
      });
    };
    (async () => {
      try {
        const list = await primeSession(sessionId, dir ?? "");
        if (genRef.current !== gen) return;
        setMsgs([...list]);
        // re-peek: an ask may have landed while priming, before subscribing
        setAsk(peekQuestion(sessionId));
        setPerm(peekPermission(sessionId));
        unsub = subscribeSession(sessionId, queueMirror);
        unsubQ = subscribeQuestion(sessionId, () => {
          if (genRef.current !== gen) return;
          setAsk(peekQuestion(sessionId));
        });
        unsubP = subscribePermission(sessionId, () => {
          if (genRef.current !== gen) return;
          setPerm(peekPermission(sessionId));
        });
        try {
          const { client } = dir ? await opencodeFor(dir) : await opencode();
          const cr = await (client.session as any).children?.({ path: { id: sessionId } });
          const raw = (cr as any)?.data ?? (cr as any)?.value ?? [];
          if (genRef.current !== gen) return;
          if (Array.isArray(raw)) setKids(raw.map((c: any) => ({ id: c.id as string, title: c.title as string, timeCreated: c.time?.created as number | undefined })));
        } catch {}
      } catch (e) {
        if (genRef.current !== gen) return;
        setError(String(e));
      }
    })();
    return () => {
      genRef.current++;
      unsub?.();
      unsubQ?.();
      unsubP?.();
    };
  }, [sessionId, dir, peekSession, subscribeSession, primeSession, peekQuestion, subscribeQuestion, peekPermission, subscribePermission]);

  // nested subagents inside the transcript navigate the viewer itself —
  // explicit ids switch directly, id-less subtask parts resolve against
  // this transcript + its own children
  const handleNested = (nid: string | null, npart?: any) => {
    if (nid) { onPick(nid); return; }
    const t = npart && msgs ? resolveSubagentTarget(npart, msgs, kids) : null;
    if (t) { onPick(t.id); return; }
    if (kids.length === 1) { onPick(kids[0].id); return; }
    pushToast("Subagent transcript not available yet");
  };

  const child = children.find((c) => c.id === sessionId);
  const head = title ?? child?.title ?? (sessionId ? `ses ${sessionId.slice(0, 8)}…` : "Subagents");

  return (
    <Dialog title={head} onClose={onClose} stage>
      {!sessionId ? (
        <div className="subagent-pick">
          {children.length === 0 && <p className="empty">No subagent sessions found for this chat yet.</p>}
          {children.map((c) => (
            <button key={c.id} type="button" className="subagent-pick-row" onClick={() => onPick(c.id)}>
              <i className="fa-solid fa-diagram-project" />
              <span className="subagent-pick-title">{c.title || c.id}</span>
              <span className="subagent-pick-id mono">{c.id.slice(0, 8)}…</span>
              <i className="fa-solid fa-arrow-up-right-from-square" />
            </button>
          ))}
        </div>
      ) : (
        <>
          {error && <p className="empty">{error}</p>}
          {!error && perm && perm.sessionID === sessionId && (
            <div className="subagent-q">
              <PermissionBar
                permission={perm}
                onRespond={(response) => void respondToPermissionFor(perm, response)}
              />
            </div>
          )}
          {!error && ask && ask.sessionID === sessionId && (
            <div className="subagent-q">
              <QuestionPopup
                ask={ask}
                onAnswer={(answers) => void answerQuestionFor(ask, answers)}
                onReject={() => void rejectQuestionFor(ask)}
              />
            </div>
          )}
          {!error && msgs === null && <p className="empty">Loading…</p>}
          {!error && msgs !== null && (
            <div className="subagent-view">
              <MessageList
                msgs={msgs}
                busy={!!busy}
                collapsed={collapsed}
                sessionId={sessionId}
                taskCosts={taskCosts}
                dir={dir}
                readOnly
                onOpenSubagent={handleNested}
              />
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
