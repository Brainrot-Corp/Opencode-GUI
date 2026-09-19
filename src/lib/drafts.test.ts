// runnable self-check: node --experimental-strip-types src/lib/drafts.test.ts
import { getDraft, setDraft, clearDraft } from "./drafts.ts";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

eq("empty sid → ''", getDraft(""), "");
eq("missing → ''", getDraft("s1"), "");
setDraft("s1", "hello");
eq("stored", getDraft("s1"), "hello");
setDraft("s2", "other");
eq("independent keys", getDraft("s2"), "other");
eq("s1 kept", getDraft("s1"), "hello");
setDraft("s1", ""); // empty value deletes
eq("empty value deletes", getDraft("s1"), "");
eq("s2 untouched", getDraft("s2"), "other");
setDraft("", "ignored");
eq("empty sid ignored", getDraft(""), "");
clearDraft("s2");
eq("clearDraft", getDraft("s2"), "");

// corrupt storage is tolerated (treated as empty)
store.set("oc.drafts", "{nope");
eq("corrupt → ''", getDraft("s1"), "");

console.log(`drafts: ${n} checks passed`);
