// runnable self-check: node --experimental-strip-types src/lib/sessionMeta.test.ts
import {
  PINNED_KEY,
  TITLE_OVERRIDES_KEY,
  getPinned,
  getTitleOverrides,
  writeTitleOverride,
  togglePinned,
  isPinned,
  applyOverrides,
  pinEntry,
  invalidatePinned,
  invalidateTitleOverrides,
} from "./sessionMeta.ts";

// minimal localStorage shim (node has none)
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}
function ok(name: string, cond: boolean) {
  n++;
  if (!cond) throw new Error(`FAIL ${name}`);
}

const S = (id: string, created?: number, title?: string) =>
  ({ id, title: title ?? id, time: { created } }) as any;

// getPinned: empty store → empty set; valid array → filtered Set
store.delete(PINNED_KEY);
invalidatePinned();
eq("no key → empty set", [...getPinned()], []);
store.set(PINNED_KEY, JSON.stringify(["a", 5, null, "b", "a"]));
invalidatePinned();
eq("strings only", [...getPinned()], ["a", "b"]);

// cache: second read served from cache (shim mutated behind it must not show)
store.set(PINNED_KEY, JSON.stringify(["zzz"]));
eq("cached read", [...getPinned()], ["a", "b"]);

// togglePinned writes through + updates cache; isPinned reflects
store.set(PINNED_KEY, JSON.stringify([]));
invalidatePinned();
togglePinned("s1");
eq("toggled on", [...getPinned()], ["s1"]);
ok("isPinned true", isPinned("s1"));
togglePinned("s1");
eq("toggled off", [...getPinned()], []);
ok("isPinned false", !isPinned("s1"));

// getTitleOverrides: malformed JSON → {}; object kept
store.set(TITLE_OVERRIDES_KEY, "{not json");
invalidateTitleOverrides();
eq("bad json → {}", getTitleOverrides(), {});
store.set(TITLE_OVERRIDES_KEY, JSON.stringify({ s1: "Renamed" }));
invalidateTitleOverrides();
eq("object kept", getTitleOverrides(), { s1: "Renamed" });

// writeTitleOverride merges + persists + cache coheres with applyOverrides
store.set(TITLE_OVERRIDES_KEY, JSON.stringify({ s1: "Old" }));
invalidateTitleOverrides();
writeTitleOverride("s2", "Second");
eq("merged", getTitleOverrides(), { s1: "Old", s2: "Second" });

// applyOverrides: title override, dedupe, pinned-first, created desc
store.set(PINNED_KEY, JSON.stringify(["c"]));
store.set(TITLE_OVERRIDES_KEY, JSON.stringify({ a: "Overridden", dup: "kept-first" }));
invalidatePinned();
invalidateTitleOverrides();
const list = [S("a", 1), S("c", 2), S("a", 1), S("b", 9), S("dup", 5), S("dup", 4)];
eq(
  "pinned first, then created desc, overrides applied",
  applyOverrides(list).map((s) => s.title),
  ["c", "b", "kept-first", "Overridden"],
);
eq(
  "ids deduped",
  applyOverrides(list).map((s) => s.id),
  ["c", "b", "dup", "a"],
);

// missing time.created sorts last within its group
const noTime = [S("x"), S("y", 1)] as any;
eq("no time last", applyOverrides(noTime).map((s) => s.id), ["y", "x"]);

// pinEntry: shared reducer shape ("" clears, no-op same value, else upsert)
eq("pinEntry upsert", pinEntry({ a: "1" }, "b", "2"), { a: "1", b: "2" });
eq("pinEntry same value no-op", pinEntry({ a: "1" }, "a", "1"), { a: "1" });
eq("pinEntry empty clears", pinEntry({ a: "1", b: "2" }, "a", ""), { b: "2" });
eq("pinEntry clear missing no-op", pinEntry({ b: "2" }, "a", ""), { b: "2" });

console.log(`sessionMeta: ${n} checks passed`);
