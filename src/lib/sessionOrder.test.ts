// runnable self-check: node --experimental-strip-types src/lib/sessionOrder.test.ts
import { getSessionOrder, setSessionOrder, orderUnpinned, pruneSessionOrder } from "./sessionOrder.ts";

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

const DIR = "C:\\proj";

// set/get with dedupe + garbage filtering
setSessionOrder(DIR, ["b", "a", "b", "", 5 as unknown as string]);
eq("cleaned + stored", getSessionOrder(DIR), ["b", "a"]);

// per-workspace keys are independent
setSessionOrder("C:\\other", ["x"]);
eq("other ws", getSessionOrder("C:\\other"), ["x"]);
eq("first untouched", getSessionOrder(DIR), ["b", "a"]);

// empty list deletes the key
setSessionOrder(DIR, []);
eq("empty → []", getSessionOrder(DIR), []);

// orderUnpinned: no stored order → created desc
setSessionOrder(DIR, []);
const S = (id: string, created?: number) => ({ id, time: { created } });
eq("no order → created desc", orderUnpinned(DIR, [S("a", 1), S("c", 3), S("b", 2)]), [S("c", 3), S("b", 2), S("a", 1)]);

// stored order: fresh ids (created desc) on top, known in stored order
setSessionOrder(DIR, ["a", "c"]);
eq("fresh first then stored", orderUnpinned(DIR, [S("b", 9), S("a", 1), S("c", 3)]), [S("b", 9), S("a", 1), S("c", 3)]);

// stored ids missing from list are ignored
eq("stale stored ignored", orderUnpinned(DIR, [S("c", 3)]), [S("c", 3)]);

// prune drops deleted ids only
setSessionOrder(DIR, ["a", "gone", "c"]);
pruneSessionOrder(DIR, new Set(["a", "c", "x"]));
eq("pruned", getSessionOrder(DIR), ["a", "c"]);

// pruning when nothing to drop leaves storage untouched
pruneSessionOrder(DIR, new Set(["a", "c", "x"]));
eq("no-op prune", getSessionOrder(DIR), ["a", "c"]);

console.log(`sessionOrder: ${n} checks passed`);
