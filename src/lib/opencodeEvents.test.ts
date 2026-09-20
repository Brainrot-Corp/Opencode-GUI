// runnable self-check: node --experimental-strip-types src/lib/opencodeEvents.test.ts
// Dispatch matrix for the SSE event dispatcher — fake ctx records every
// handler call so regressions in permission/question/session/error routing
// surface without a live server.
import { handleOpenCodeEvent, type OpenCodeEventCtx } from "./opencodeEvents.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// --- fake ctx ----------------------------------------------------------
function makeCtx(opts?: { inflight?: boolean }) {
  const calls = {
    settle: [] as string[], markBusy: [] as [string, boolean][], addInflight: [] as string[],
    cancelSettle: [] as string[], dropInflight: [] as string[], applyMessage: [] as any[],
    applyPart: [] as any[], applyDelta: [] as any[], addError: [] as [string, string][],
    restoreFailedInput: [] as string[], toasts: [] as string[],
    handlePermAsk: [] as any[], handleQuestionAsk: [] as any[],
    clearPermissionAsk: [] as any[], clearQuestionAsk: [] as any[],
    markCompacting: [] as [string, boolean][], setSessions: [] as any[],
    applyOverrides: [] as any[], teardownSession: [] as string[], refreshSessions: 0,
    refreshCommands: 0, refreshAgents: 0, refreshChildren: [] as string[],
    learnServerDefault: [] as [string, string][], fileEvents: [] as any[],
    setPermission: [] as any[], setQuestion: [] as any[],
  };
  const ctx: OpenCodeEventCtx = {
    store: {
      applyMessage: (m: any) => calls.applyMessage.push(m),
      applyPart: (p: any) => calls.applyPart.push(p),
      applyDelta: (d: any) => calls.applyDelta.push(d),
      addError: (sid: string, msg: string) => calls.addError.push([sid, msg]),
    } as any,
    tracker: {
      dropInflight: (sid: string) => { calls.dropInflight.push(sid); return true; },
      settle: (sid: string) => { calls.settle.push(sid); },
      cancelSettle: (sid: string) => { calls.cancelSettle.push(sid); },
      addInflight: (sid: string, _id: string) => { calls.addInflight.push(sid); },
      markBusy: (sid: string, on: boolean) => { calls.markBusy.push([sid, on]); },
      hasInflight: () => opts?.inflight ?? false,
    } as any,
    busyRef: { current: new Set<string>() },
    activeRef: { current: "act" },
    childParentRef: { current: new Map() },
    sessionDirRef: { current: new Map() },
    getSecurityModeFor: () => "full",
    resolveParent: () => Promise.resolve(),
    restoreFailedInput: (sid: string) => { calls.restoreFailedInput.push(sid); },
    handlePermAsk: (a: any, d?: string, s?: boolean) => calls.handlePermAsk.push([a, d, s]),
    handleQuestionAsk: (q: any, d?: string) => calls.handleQuestionAsk.push([q, d]),
    clearPermissionAsk: (pid: any, sid?: string) => calls.clearPermissionAsk.push([pid, sid]),
    clearQuestionAsk: (qid: any, sid?: string) => calls.clearQuestionAsk.push([qid, sid]),
    syncAttention: () => {},
    emitPermission: () => {},
    emitQuestion: () => {},
    syncTopBadge: () => {},
    topOfSession: () => "",
    setPermission: (v: any) => calls.setPermission.push(v),
    setQuestion: (v: any) => calls.setQuestion.push(v),
    setSessions: (fn: any) => { calls.setSessions.push(fn); return fn; },
    markCompacting: (sid: string, on: boolean) => calls.markCompacting.push([sid, on]),
    applyOverrides: (list: any) => { calls.applyOverrides.push(list); return list; },
    teardownSession: (sid: string) => { calls.teardownSession.push(sid); },
    refreshSessions: () => { calls.refreshSessions++; return Promise.resolve([]) as any; },
    refreshCommands: () => { calls.refreshCommands++; return Promise.resolve(); },
    refreshAgents: () => { calls.refreshAgents++; return Promise.resolve(); },
    refreshChildrenRef: { current: (sid: string) => { calls.refreshChildren.push(sid); return Promise.resolve(); } },
    learnServerDefault: (p: string, m: string) => calls.learnServerDefault.push([p, m]),
    getDirectory: () => "base-dir",
    hiddenSessions: new Set(["hidden-ses"]),
    hiddenTitle: "__temp__",
    pushToast: (msg: string) => { calls.toasts.push(msg); },
  };
  return { ctx, calls };
}
// --- compaction indicator ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "session.compaction.started", properties: { sessionID: "s1" } } as any, ctx);
  handleOpenCodeEvent({ type: "session.compaction.delta", properties: { sessionID: "s1" } } as any, ctx);
  handleOpenCodeEvent({ type: "session.compaction.ended", properties: { sessionID: "s1" } } as any, ctx);
  handleOpenCodeEvent({ type: "session.compacted", properties: { sessionID: "s1" } } as any, ctx);
  eq("compaction marks", JSON.stringify(calls.markCompacting), JSON.stringify([["s1", true], ["s1", true], ["s1", false], ["s1", false]]));
  eq("no session id ignored", calls.markCompacting.length, 4);
}

// --- message.updated: assistant completion path ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "message.updated", properties: { info: { role: "assistant", sessionID: "s1", id: "m1", time: { completed: 1 } } } } as any, ctx);
  eq("completed drops inflight", calls.dropInflight.join(","), "s1");
  eq("completed settles", calls.settle.join(","), "s1");
  eq("no live marks", calls.markBusy.length, 0);
}
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "message.updated", properties: { info: { role: "user", sessionID: "s1", id: "m0" } } } as any, ctx);
  eq("user msg skips tracker", calls.settle.length + calls.markBusy.length, 0);
  eq("user msg applied", calls.applyMessage.length, 1);
}
// --- message.updated: live assistant path + model learning ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "message.updated", properties: { info: { role: "assistant", sessionID: "s1", id: "m2", providerID: "p", modelID: "m" } } } as any, ctx);
  eq("live cancels settle", calls.cancelSettle.join(","), "s1");
  eq("live adds inflight", calls.addInflight.join(","), "s1");
  eq("live marks busy", JSON.stringify(calls.markBusy), JSON.stringify([["s1", true]]));
  eq("model learned", JSON.stringify(calls.learnServerDefault), JSON.stringify([["p", "m"]]));
}
{
  const { ctx, calls } = makeCtx();
  (ctx.busyRef.current as Set<string>).add("s1");
  handleOpenCodeEvent({ type: "message.updated", properties: { info: { role: "assistant", sessionID: "s1", id: "m2" } } } as any, ctx);
  eq("already busy: no re-mark", calls.markBusy.length, 0);
  eq("already busy: inflight kept", calls.addInflight.join(","), "s1");
}

// --- message.part.updated / delta ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "message.part.updated", properties: {} } as any, ctx);
  eq("missing part ignored", calls.applyPart.length, 0);
  handleOpenCodeEvent({ type: "message.part.updated", properties: { part: { tool: "task", state: { status: "completed" } } } } as any, ctx);
  eq("task completed applies part", calls.applyPart.length, 1);
  handleOpenCodeEvent({ type: "message.part.delta", properties: { field: "text" } } as any, ctx);
  handleOpenCodeEvent({ type: "message.part.delta", properties: { field: "time" } } as any, ctx);
  eq("delta only for text field", calls.applyDelta.length, 1);
}
// task completion schedules the children refresh (400ms) — stub setTimeout
{
  const { ctx, calls } = makeCtx();
  const realST = globalThis.setTimeout;
  const scheduled: [Function, number][] = [];
  (globalThis as any).setTimeout = ((fn: any, ms: any) => { scheduled.push([fn, ms]); return 0 as any; }) as any;
  try {
    handleOpenCodeEvent({ type: "message.part.updated", properties: { part: { tool: "task", state: { status: "completed" } } } } as any, ctx);
    handleOpenCodeEvent({ type: "message.part.updated", properties: { part: { tool: "bash", state: { status: "completed" } } } } as any, ctx);
  } finally {
    globalThis.setTimeout = realST;
  }
  eq("task refresh scheduled once", scheduled.length, 1);
  eq("refresh delay is 400ms", scheduled[0]?.[1], 400);
  scheduled[0]?.[0](); // run the scheduled callback
  eq("refresh targets active session", calls.refreshChildren.join(","), "act");
}

// --- permission lifecycle ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "permission.asked", properties: { id: "p1", sessionID: "s1", permission: "edit", patterns: ["a", "b"], metadata: { title: "Meta" } } } as any, ctx, "ws1");
  eq("asked routes to handlePermAsk", calls.handlePermAsk.length, 1);
  eq("asked title prefers metadata", JSON.stringify(calls.handlePermAsk[0][0]), JSON.stringify({ id: "p1", sessionID: "s1", type: "edit", title: "Meta" }));
  eq("asked passes dirHint", calls.handlePermAsk[0][1], "ws1");
  eq("asked sound flag", calls.handlePermAsk[0][2], true);
}
{
  const { ctx, calls } = makeCtx();
  // title chain: no metadata → patterns joined; nothing → type fallback
  handleOpenCodeEvent({ type: "permission.asked", properties: { id: "p1", sessionID: "s1", permission: "bash", patterns: ["git *"] } } as any, ctx);
  eq("asked falls back to patterns", calls.handlePermAsk[0][0].title, "git *");
  handleOpenCodeEvent({ type: "permission.asked", properties: { id: "p2", sessionID: "s1", type: "fs" } } as any, ctx);
  eq("asked falls back to type", calls.handlePermAsk[1][0].title, "fs");
}
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "permission.updated", properties: { permissionID: "pp", sessionID: "s1", type: "edit", title: "T" } } as any, ctx);
  eq("updated id fallback", calls.handlePermAsk[0][0].id, "pp");
  eq("updated no sound flag", calls.handlePermAsk[0][2], undefined);
  handleOpenCodeEvent({ type: "permission.replied", properties: { requestID: "pp", sessionID: "s1" } } as any, ctx);
  handleOpenCodeEvent({ type: "permission.v2.replied", properties: { id: "x", sessionID: "s1" } } as any, ctx);
  eq("replied clears", calls.clearPermissionAsk.length, 2);
  eq("replied id fallback", calls.clearPermissionAsk[0][0], "pp");
}
// --- question lifecycle ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "question.asked", properties: { requestID: "q1", sessionID: "s1", questions: [{ question: "?" }] } } as any, ctx);
  eq("question routed", calls.handleQuestionAsk.length, 1);
  eq("question id fallback", calls.handleQuestionAsk[0][0].id, "q1");
  eq("questions normalized", JSON.stringify(calls.handleQuestionAsk[0][0].questions), JSON.stringify([{ question: "?" }]));
  handleOpenCodeEvent({ type: "question.v2.rejected", properties: { id: "q1", sessionID: "s1" } } as any, ctx);
  eq("rejected clears", calls.clearQuestionAsk.length, 1);
  handleOpenCodeEvent({ type: "question.asked", properties: { id: "q2", sessionID: "s1", questions: "nope" } } as any, ctx);
  eq("non-array questions -> empty", JSON.stringify(calls.handleQuestionAsk[1][0].questions), "[]");
}

// --- session.idle ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "session.idle", properties: { sessionID: "s1" } } as any, ctx);
  eq("idle settles when quiet", calls.settle.join(","), "s1");
  const { ctx: c2, calls: k2 } = makeCtx({ inflight: true });
  handleOpenCodeEvent({ type: "session.idle", properties: { sessionID: "s2" } } as any, c2);
  eq("mid-turn idle ignored", k2.settle.length, 0);
}

// --- session.error ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "session.error", properties: { sessionID: "s1", error: { name: "MessageAbortedError" } } } as any, ctx);
  eq("abort error skipped", calls.addError.length + calls.toasts.length, 0);
  handleOpenCodeEvent({ type: "session.error", properties: { sessionID: "s1", error: { data: { message: "boom" } } } } as any, ctx);
  eq("error surfaces", calls.addError.join("|"), "s1,boom");
  eq("error settles", calls.settle.join(","), "s1");
  eq("failed input restored", calls.restoreFailedInput.join(","), "s1");
  eq("error toasted", calls.toasts.join(","), "boom");
  handleOpenCodeEvent({ type: "session.error", properties: { sessionID: "s1", error: { message: "raw" } } } as any, ctx);
  eq("error message fallback", calls.addError[1]?.[1], "raw");
}

// --- session.created ---
{
  const { ctx, calls } = makeCtx();
  (ctx.activeRef.current as any) = "act";
  // child session under the active session → parent map + children refresh
  handleOpenCodeEvent({ type: "session.created", properties: { info: { id: "kid", parentID: "act" } } } as any, ctx);
  eq("child mapped to parent", (ctx as any).childParentRef.current.get("kid"), "act");
  eq("children refreshed", calls.refreshChildren.join(","), "act");
  eq("hidden session filtered", calls.setSessions.length, 0);
  // visible session, dirHint wins
  handleOpenCodeEvent({ type: "session.created", properties: { info: { id: "vis", title: "V" } } } as any, ctx, "hinted");
  eq("visible session stored", calls.setSessions.length, 1);
  eq("dir from hint", (ctx as any).sessionDirRef.current.get("vis"), "hinted");
  // applyOverrides ran inside setSessions callback
  const cb = calls.setSessions[0];
  const out = cb([{ id: "x" } as any]);
  eq("applyOverrides invoked", calls.applyOverrides.length, 1);
  eq("new session appended", out.length, 2);
  eq("dup id deduped", cb([{ id: "vis" } as any]).length, 1);
  // hidden via api set
  handleOpenCodeEvent({ type: "session.created", properties: { info: { id: "hidden-ses" } } } as any, ctx);
  eq("api-hidden session filtered", calls.setSessions.length, 1);
}
// --- session.updated ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "session.updated", properties: { info: { id: "s1", title: "New" } } } as any, ctx);
  eq("updated only replaces existing", JSON.stringify(calls.setSessions[0]([{ id: "s1", title: "Old" } as any])), JSON.stringify([{ id: "s1", title: "New" }]));
  eq("unknown id no-op", JSON.stringify(calls.setSessions[0]([{ id: "other" } as any])), JSON.stringify([{ id: "other" }]));
  const { ctx: c2, calls: k2 } = makeCtx();
  handleOpenCodeEvent({ type: "session.updated", properties: { info: { id: "kid2", parentID: "act" } } } as any, c2);
  eq("child update refreshes", k2.refreshChildren.join(","), "act");
}

// --- session.deleted ---
{
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "session.deleted", properties: { sessionID: "act" } } as any, ctx);
  eq("deleted tears down", calls.teardownSession.join(","), "act");
  eq("active clears question", calls.setQuestion.length, 1);
  eq("active clears permission", calls.setPermission.length, 1);
  eq("sessions refreshed", calls.refreshSessions, 1);
  const { ctx: c2, calls: k2 } = makeCtx();
  handleOpenCodeEvent({ type: "session.deleted", properties: { sessionID: "other" } } as any, c2);
  eq("non-active: no clears", k2.setQuestion.length + k2.setPermission.length, 0);
}

// --- file.watcher.updated ---
{
  // node has no window/CustomEvent — polyfill enough for the relay path
  const relayed: any[] = [];
  (globalThis as any).window = { dispatchEvent: (e: any) => relayed.push(e) };
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, opts: { detail?: any }) {
      this.type = type;
      this.detail = opts?.detail;
    }
  };
  const { ctx, calls } = makeCtx();
  handleOpenCodeEvent({ type: "file.watcher.updated", properties: { file: "/w/.opencode/command/x.md" } } as any, ctx);
  eq("file change relayed", relayed[0]?.type, "oc:file-changed");
  eq("relay carries path", relayed[0]?.detail, "/w/.opencode/command/x.md");
  eq("command registry refreshed", calls.refreshCommands, 1);
  eq("agent registry refreshed", calls.refreshAgents, 1);
  // throttled: second burst within 1s must not refetch
  handleOpenCodeEvent({ type: "file.watcher.updated", properties: { file: "/w/.opencode/command/y.md" } } as any, ctx);
  eq("command refetch throttled", calls.refreshCommands, 1);
  eq("agent refetch throttled", calls.refreshAgents, 1);
  handleOpenCodeEvent({ type: "file.watcher.updated", properties: { file: "/w/src/app.ts" } } as any, ctx);
  eq("non-agent md not refetched", calls.refreshAgents, 1);
}

console.log(`opencodeEvents: ${n} checks passed`);
