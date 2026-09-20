// runnable self-check: node --experimental-strip-types src/lib/sessionStore.test.ts
import { createSessionStore } from "./sessionStore.ts";

let n = 0;
function check(name: string, got: unknown, want: unknown) {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function msg(id: string, role: string, tokens?: any, cost?: number): any {
  const info: any = {
    id,
    sessionID: "s1",
    role,
    time: { created: 1, completed: 1 },
    modelID: "",
    providerID: "",
    mode: "",
    path: { cwd: "", root: "" },
  };
  if (role === "assistant") {
    info.cost = cost ?? 0;
    info.tokens = tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  }
  return { info, parts: [] };
}

const store = createSessionStore(() => {});
const S = "s1";

// fetch installs the list + computes usage
store.setFetched(S, [
  msg("a", "assistant", { input: 100, output: 20, reasoning: 5 }, 0.01),
  msg("u", "user"),
  msg("b", "assistant", { input: 50, output: 0, reasoning: 0 }, 0.002),
]);
check("fetch usage", store.usageOf(S), { cost: 0.012, tokens: 175 });

// completion update replaces the header — delta must apply, not double-add
store.applyMessage(msg("b", "assistant", { input: 50, output: 40, reasoning: 10 }, 0.004).info);
check("replace usage delta", store.usageOf(S), { cost: 0.014, tokens: 225 });

// new message insert
store.applyMessage(msg("c", "assistant", { input: 10, output: 0, reasoning: 0 }).info);
check("insert usage", store.usageOf(S), { cost: 0.014, tokens: 235 });

// a later fetch is authoritative — recomputed from scratch, no drift
store.setFetched(S, [msg("a", "assistant", { input: 1, output: 0, reasoning: 0 }, 0.1)]);
check("fetch recompute", store.usageOf(S), { cost: 0.1, tokens: 1 });

// unknown session → stable zero object
check("empty usage", store.usageOf("nope"), { cost: 0, tokens: 0 });

// remove clears
store.remove(S);
check("remove clears", store.usageOf(S), { cost: 0, tokens: 0 });

// tail-scan lookup: a 5k-message store resolves deltas against the last msg
const big = createSessionStore(() => {});
const list: any[] = [];
for (let i = 0; i < 5000; i++) list.push(msg(`m${i}`, "user"));
list.push(msg("last", "assistant"));
big.setFetched(S, list);
let changes = 0;
big.applyDelta({ sessionID: S, messageID: "last", partID: "p", delta: "hi" });
check("delta targets tail", (big.cached(S) as any[])[5000].parts[0]?.text, undefined); // part unknown → stashed
const on = createSessionStore(() => { changes++; });
on.setFetched(S, [msg("m1", "user"), msg("m2", "assistant", undefined, 0)]);
on.applyPart({ id: "p1", sessionID: S, messageID: "m2", type: "text", text: "hello" } as any);
check("applyPart hits tail msg", (on.cached(S) as any[])[1].parts[0].text, "hello");
check("onChange fired", changes > 0, true);

// deltas that outrun the part announcement must survive an empty part —
// otherwise short replies land blank and stay invisible until refetch
const early = createSessionStore(() => {});
early.applyMessage(msg("m1", "assistant").info);
early.applyDelta({ sessionID: S, messageID: "m1", partID: "p1", delta: "hello " });
early.applyDelta({ sessionID: S, messageID: "m1", partID: "p1", delta: "world" });
early.applyPart({ id: "p1", sessionID: S, messageID: "m1", type: "text", text: "" } as any);
check("early deltas kept on empty part", (early.cached(S) as any[])[0].parts[0].text, "hello world");

// authoritative re-announce already carries the early text — no duplication
const auth = createSessionStore(() => {});
auth.applyMessage(msg("m1", "assistant").info);
auth.applyDelta({ sessionID: S, messageID: "m1", partID: "p1", delta: "hello " });
auth.applyPart({ id: "p1", sessionID: S, messageID: "m1", type: "text", text: "hello " } as any);
check("authoritative part not duplicated", (auth.cached(S) as any[])[0].parts[0].text, "hello ");

// orphan parts (part before message) keep early deltas too
const orph = createSessionStore(() => {});
orph.applyDelta({ sessionID: S, messageID: "m1", partID: "p1", delta: "hi" });
orph.applyPart({ id: "p1", sessionID: S, messageID: "m1", type: "text", text: "" } as any);
orph.applyMessage(msg("m1", "assistant").info);
check("orphan part keeps stash", (orph.cached(S) as any[])[0].parts[0].text, "hi");

// a stale (shorter, non-extending) snapshot must not wipe streamed text —
// server snapshots travel separately and can land out of order; only a
// refetch heals a wipe, so never regress client-side
const regr = createSessionStore(() => {});
regr.applyMessage(msg("m1", "assistant").info);
regr.applyPart({ id: "p1", sessionID: S, messageID: "m1", type: "text", text: "" } as any);
regr.applyDelta({ sessionID: S, messageID: "m1", partID: "p1", delta: "hello world" });
regr.applyPart({ id: "p1", sessionID: S, messageID: "m1", type: "text", text: "" } as any);
check("late empty snapshot keeps text", (regr.cached(S) as any[])[0].parts[0].text, "hello world");
regr.applyPart({ id: "p1", sessionID: S, messageID: "m1", type: "text", text: "hello" } as any);
check("stale prefix snapshot keeps text", (regr.cached(S) as any[])[0].parts[0].text, "hello world");
// growth and genuine rewrites still apply
regr.applyPart({ id: "p1", sessionID: S, messageID: "m1", type: "text", text: "hello world!" } as any);
check("growing snapshot applies", (regr.cached(S) as any[])[0].parts[0].text, "hello world!");
regr.applyPart({ id: "p1", sessionID: S, messageID: "m1", type: "text", text: "rewritten" } as any);
check("rewrite snapshot applies", (regr.cached(S) as any[])[0].parts[0].text, "rewritten");

// tool snapshots can land out of order — a stale running must not wipe a
// completed output (fast tools like read race hardest; the block would sit
// spinning with no content until refetch)
function toolPart(id: string, status: string, extra?: any): any {
  return {
    id, sessionID: S, messageID: "m1", type: "tool", tool: "read",
    state: { status, input: { filePath: "readme.md" }, output: status === "completed" ? "# readme\ncontent" : undefined, time: { start: 1, end: 2 }, ...(extra ?? {}) },
  };
}
const tls = createSessionStore(() => {});
tls.applyMessage(msg("m1", "assistant").info);
tls.applyPart(toolPart("t1", "pending"));
tls.applyPart(toolPart("t1", "running"));
tls.applyPart(toolPart("t1", "completed"));
check("completion applies", (tls.cached(S) as any[])[0].parts[0].state.status, "completed");
check("completion keeps output", (tls.cached(S) as any[])[0].parts[0].state.output, "# readme\ncontent");
tls.applyPart(toolPart("t1", "running"));
check("stale running keeps status", (tls.cached(S) as any[])[0].parts[0].state.status, "completed");
check("stale running keeps output", (tls.cached(S) as any[])[0].parts[0].state.output, "# readme\ncontent");
tls.applyPart(toolPart("t1", "pending"));
check("stale pending keeps status", (tls.cached(S) as any[])[0].parts[0].state.status, "completed");
// forward flow still works
const tfw = createSessionStore(() => {});
tfw.applyMessage(msg("m1", "assistant").info);
tfw.applyPart(toolPart("t1", "pending"));
tfw.applyPart(toolPart("t1", "running"));
check("pending->running applies", (tfw.cached(S) as any[])[0].parts[0].state.status, "running");
tfw.applyPart(toolPart("t1", "error", { error: "boom" }));
check("running->error applies", (tfw.cached(S) as any[])[0].parts[0].state.status, "error");
tfw.applyPart(toolPart("t1", "running"));
check("stale running keeps error", (tfw.cached(S) as any[])[0].parts[0].state.status, "error");

console.log(`sessionStore: ${n} checks passed`);
