// runnable self-check: node --experimental-strip-types src/lib/splitHover.test.ts
import { resolveForcedSide } from "./splitHover.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

eq("left → reinstall", resolveForcedSide(-120), "reinstall");
eq("right → delete", resolveForcedSide(120), "delete");
eq("tiny left → reinstall", resolveForcedSide(-1), "reinstall");
eq("tiny right → delete", resolveForcedSide(1), "delete");
eq("no move → null", resolveForcedSide(0), null);

console.log(`splitHover: ${n} checks passed`);
