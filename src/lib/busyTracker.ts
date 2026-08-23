import type { Attachment } from "../types";

// busy/settle/outbound-queue bookkeeping for all sessions.
// React-free: the owner wires state setters and side effects via callbacks.
const SETTLE_GRACE_MS = 1500;

export type QueuedPrompt = { text: string; files?: Attachment[] };

export function createBusyTracker(opts: {
  // mirrors busy state into React (Sidebar indicators, Send/Stop)
  setBusy: (fn: (prev: Set<string>) => Set<string>) => void;
  // queue badge per session; count = null removes the entry
  setQueueCount: (sid: string, count: number | null) => void;
  // true end-of-turn (grace elapsed, nothing inflight): drop indicators,
  // play sound, drain the queue — all owned by the caller
  onSettle: (sid: string) => void;
}) {
  // assistant messages started but not finished, per session — the REAL
  // working signal: message.completed / session.idle fire mid-turn in
  // heavier tasks and used to kill the indicators prematurely
  const inflight = new Map<string, Set<string>>();
  // turns span several assistant messages; when one drains, wait out a
  // short grace before dropping the indicators — the next message usually
  // starts within that window and cancels the settle, so Send/Stop and the
  // sidebar dot stop flapping at every step boundary
  const settleTimers = new Map<string, number>();
  const queues = new Map<string, QueuedPrompt[]>();

  const markBusy = (sid: string, on: boolean) =>
    opts.setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(sid);
      else next.delete(sid);
      return next;
    });

  function addInflight(sid: string, id: string) {
    let set = inflight.get(sid);
    if (!set) {
      set = new Set();
      inflight.set(sid, set);
    }
    set.add(id);
  }

  // returns true when that was the session's last live message
  function dropInflight(sid: string, id: string): boolean {
    const set = inflight.get(sid);
    set?.delete(id);
    if (!set || set.size === 0) {
      inflight.delete(sid);
      return true;
    }
    return false;
  }

  const hasInflight = (sid: string) => !!inflight.get(sid)?.size;

  // deduped — completions and idles may both call for the same settle
  const settle = (sid: string) => {
    if (settleTimers.has(sid)) return;
    settleTimers.set(
      sid,
      window.setTimeout(() => {
        settleTimers.delete(sid);
        if (!inflight.get(sid)?.size) opts.onSettle(sid);
      }, SETTLE_GRACE_MS),
    );
  };

  const cancelSettle = (sid: string) => {
    const t = settleTimers.get(sid);
    if (t !== undefined) {
      clearTimeout(t);
      settleTimers.delete(sid);
    }
  };

  function pushQueued(sid: string, item: QueuedPrompt) {
    const q = queues.get(sid) ?? [];
    q.push(item);
    queues.set(sid, q);
    opts.setQueueCount(sid, q.length);
  }

  const clearQueued = (sid: string) => {
    if (!queues.delete(sid)) return;
    opts.setQueueCount(sid, null);
  };

  // drain one queued prompt per settled turn — callers guard with hasInflight
  // (busy state lags a render behind and would refuse right after settling)
  function shiftQueued(sid: string): QueuedPrompt | undefined {
    const q = queues.get(sid);
    if (!q?.length) return undefined;
    const next = q.shift()!;
    if (!q.length) queues.delete(sid);
    opts.setQueueCount(sid, q.length || null);
    return next;
  }

  // session delete / abort cleanup
  const reset = (sid: string) => {
    clearQueued(sid);
    cancelSettle(sid);
    inflight.delete(sid);
    markBusy(sid, false);
  };

  return {
    markBusy,
    addInflight,
    dropInflight,
    hasInflight,
    settle,
    cancelSettle,
    pushQueued,
    clearQueued,
    shiftQueued,
    reset,
  };
}

export type BusyTracker = ReturnType<typeof createBusyTracker>;
