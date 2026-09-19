// runnable self-check: node --experimental-strip-types src/lib/busyTracker.test.ts
import { createBusyTracker } from "./busyTracker.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// fake window timers (busyTracker uses window.setTimeout for the settle grace)
type Timer = { id: number; at: number; fn: () => void };
let timers: Timer[] = [];
let now = 0;
let nextId = 1;
(globalThis as any).window = {
  setTimeout: (fn: () => void, ms: number) => {
    const t = { id: nextId++, at: now + ms, fn };
    timers.push(t);
    return t.id;
  },
  clearTimeout: (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  },
};
function tick(ms: number) {
  const end = now + ms;
  while (true) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers.find((x) => x.at <= end);
    if (!t) break;
    timers = timers.filter((x) => x.id !== t.id);
    now = t.at;
    t.fn();
  }
  now = end;
}

let busy = new Set<string>();
const queueCounts = new Map<string, number | null>();
const settled: string[] = [];
const tracker = createBusyTracker({
  setBusy: (fn) => { busy = fn(busy); },
  setQueueCount: (sid, c) => { queueCounts.set(sid, c); },
  onSettle: (sid) => { settled.push(sid); },
});

const S = "s1";
tracker.markBusy(S, true);
eq("markBusy adds", busy.has(S), true);
tracker.markBusy(S, false);
eq("markBusy removes", busy.has(S), false);

// inflight = real working signal
tracker.markBusy(S, true);
tracker.addInflight(S, "m1");
eq("hasInflight", tracker.hasInflight(S), true);
eq("dropInflight last → true", tracker.dropInflight(S, "m1"), true);
eq("hasInflight cleared", tracker.hasInflight(S), false);

// settle: fires once after grace when nothing inflight
tracker.settle(S);
eq("no early settle", settled.length, 0);
tick(1499);
eq("still within grace", settled.length, 0);
tick(1);
eq("settles after 1500ms", settled, [S]);

// new message cancels the pending settle (dedup of completion+idle also deduped)
tracker.addInflight(S, "m2");
tracker.settle(S);
tracker.settle(S); // dedup — second call ignored
tick(1500);
eq("inflight blocks settle", settled.length, 1);
tracker.dropInflight(S, "m2");
tick(1000);
tracker.settle(S); // re-arm
tick(1499);
eq("grace restarted", settled.length, 1);
tick(1);
eq("settles", settled, [S, S]);
// cancelled settle never fires
tracker.settle(S);
tracker.cancelSettle(S);
tick(3000);
eq("cancelled settle no fire", settled.length, 2);

// queue: push/shift/reset
tracker.pushQueued(S, { id: "p1", text: "one", at: 1 });
tracker.pushQueued(S, { id: "p2", text: "two", at: 2 });
eq("queue count", queueCounts.get(S), 2);
eq("shiftQueued first", tracker.shiftQueued(S)?.id, "p1");
eq("queue count after shift", queueCounts.get(S), 1);
eq("shiftQueued second", tracker.shiftQueued(S)?.id, "p2");
eq("count cleared", queueCounts.get(S), null);
eq("shift on empty", tracker.shiftQueued(S), undefined);

tracker.pushQueued(S, { id: "p3", text: "x", at: 3 });
tracker.reset(S);
eq("reset clears queue", queueCounts.get(S), null);
eq("reset clears busy", busy.has(S), false);
eq("reset cancels settle", settled.length, 2);
tick(3000);
eq("reset cancelled settle", settled.length, 2);

console.log(`busyTracker: ${n} checks passed`);
