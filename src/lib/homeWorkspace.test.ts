// runnable self-check: node --experimental-strip-types src/lib/homeWorkspace.test.ts
import { isHome, isHomeOnly, shouldAutoCreateHome } from "./homeWorkspace.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

const HOME = "/home/u";

eq("home-only single empty", isHomeOnly([""]), true);
eq("home-only whitespace", isHomeOnly(["   "]), true);
eq("not home-only when real dir", isHomeOnly(["/proj"]), false);
eq("not home-only when mixed", isHomeOnly(["", "/proj"]), false);
eq("not home-only when zero dirs", isHomeOnly([]), false);

eq("home: empty counts without resolved path", isHome([""], ""), true);
eq("home: explicit match", isHome([HOME], HOME), true);
eq("home: explicit match with padding", isHome([`  ${HOME} `], HOME), true);
eq("home: mismatch", isHome(["/proj"], HOME), false);
eq("home: explicit but unresolved home", isHome([HOME], ""), false);
eq("home: multi dirs never home", isHome([HOME, "/proj"], HOME), false);
eq("home: zero dirs never home", isHome([], HOME), false);

const base = { booting: false, dirs: [""], home: HOME, sessionCount: 0, creating: false, consumed: false };
eq("auto-create when home empty settled", shouldAutoCreateHome(base), true);
eq("auto-create for explicit home too", shouldAutoCreateHome({ ...base, dirs: [HOME] }), true);
eq("no auto-create while booting", shouldAutoCreateHome({ ...base, booting: true }), false);
eq("no auto-create when sessions exist", shouldAutoCreateHome({ ...base, sessionCount: 1 }), false);
eq("no auto-create when non-home", shouldAutoCreateHome({ ...base, dirs: ["/proj"] }), false);
eq("no auto-create while creating", shouldAutoCreateHome({ ...base, creating: true }), false);
eq("no auto-create when consumed", shouldAutoCreateHome({ ...base, consumed: true }), false);

console.log(`homeWorkspace: ${n} checks passed`);
