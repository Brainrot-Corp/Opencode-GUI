// runnable self-check: node --experimental-strip-types src/lib/tip.test.ts
import { withHotkey, fmtKey } from "./tip.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// node navigator has no Mac platform → non-mac formatting
eq("bound label", withHotkey("Workspace", "Ctrl+O"), "Workspace (Ctrl+O)");
eq("null → bare label", withHotkey("Workspace", null), "Workspace");
eq("undefined → bare label", withHotkey("Workspace", undefined), "Workspace");
eq("empty → bare label", withHotkey("Workspace", ""), "Workspace");
eq("fmtKey passthrough", fmtKey("Ctrl+Shift+P"), "Ctrl+Shift+P");

console.log(`tip: ${n} checks passed`);
