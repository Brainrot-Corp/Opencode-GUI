// runnable self-check: node --experimental-strip-types src/lib/plugins.test.ts
import { parseManifest, compareVersion, isNewer } from "./plugins.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// --- parseManifest (commented JSONC tolerated) ---
eq("full manifest", parseManifest("dir", '{"id":"tuya","name":"Tuya","version":"1.2.0","description":"x"}'), {
  id: "tuya", name: "Tuya", version: "1.2.0", description: "x",
});
eq("comments stripped", parseManifest("tuya", '{\n  // note\n  "name": "Tuya"\n}'), { id: "tuya", name: "Tuya", version: undefined, description: undefined });
eq("missing ids default to dir", parseManifest("mydir", "{}"), { id: "mydir", name: "mydir", version: undefined, description: undefined });
eq("empty id falls back to dir", parseManifest("mydir", '{"id":"","name":"x"}'), { id: "mydir", name: "x", version: undefined, description: undefined });
eq("array manifest → null", parseManifest("d", "[]"), null);
eq("garbage → null", parseManifest("d", "not json"), null);
eq("empty raw → null", parseManifest("d", ""), null);

// --- compareVersion ---
eq("equal", compareVersion("1.2.3", "1.2.3"), 0);
eq("minor bump", compareVersion("1.2.3", "1.3.0"), -1);
eq("major bump", compareVersion("2.0.0", "1.9.9"), 1);
eq("numeric not lexical", compareVersion("1.10.0", "1.2.0"), 1);
eq("shorter pad 0", compareVersion("1.2", "1.2.0"), 0);
eq("non-numeric part → 0", compareVersion("1.2.0", "1.2.0-beta"), 0);

// --- isNewer ---
eq("no catalog → false", isNewer("1.0.0", undefined), false);
eq("nothing installed → true", isNewer(undefined, "1.0.0"), true);
eq("installed < catalog", isNewer("1.0.0", "1.1.0"), true);
eq("installed > catalog", isNewer("2.0.0", "1.9.0"), false);
eq("same → false", isNewer("1.0.0", "1.0.0"), false);

console.log(`plugins: ${n} checks passed`);
