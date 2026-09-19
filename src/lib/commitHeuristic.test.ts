// runnable self-check: node --experimental-strip-types src/lib/commitHeuristic.test.ts
import { heuristicCommit, _test } from "./commitHeuristic.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const { scopeFromPath, typeFromContext, summaryFromDiff, sanitizeSubject } = _test;
const inp = (staged: { path: string; x: string }[], diff = "", stat = "") => ({ staged, diff, stat });

// --- scope ---
eq("root file: basename sans ext", scopeFromPath("README"), "README");
eq("weak dir → file", scopeFromPath("src/components/Button.tsx"), "Button");
eq("non-weak dir wins", scopeFromPath("git/status.ts"), "git");

// --- type from branch ---
eq("fix/ branch", typeFromContext({ staged: [], branch: "fix/crash" } as any), "fix");
eq("hotfix branch", typeFromContext({ staged: [], branch: "hotfix-x" } as any), "fix");
eq("feat/ branch", typeFromContext({ staged: [], branch: "feat/thing" } as any), "feat");

// --- type from paths/status/diff ---
eq("docs only", typeFromContext(inp([{ path: "docs/a.md", x: "M" }, { path: "README", x: "M" }]) as any), "docs");
eq("test file", typeFromContext(inp([{ path: "src/x.test.ts", x: "M" }]) as any), "test");
eq("tests dir", typeFromContext(inp([{ path: "tests/x.ts", x: "A" }]) as any), "test");
eq("scripts → chore", typeFromContext(inp([{ path: "scripts/build.ps1", x: "M" }]) as any), "chore");
eq("github → chore", typeFromContext(inp([{ path: ".github/workflows/ci.yml", x: "M" }]) as any), "chore");
eq("css only → style", typeFromContext(inp([{ path: "a.css", x: "M" }, { path: "b.scss", x: "M" }]) as any), "style");
eq("css+ts mix not style", typeFromContext(inp([{ path: "a.css", x: "M" }, { path: "a.ts", x: "M" }]) as any), "refactor");
eq("rename → refactor", typeFromContext(inp([{ path: "a.ts", x: "R" }]) as any), "refactor");
eq("fix keyword + mod", typeFromContext(inp([{ path: "a.ts", x: "M" }], "fix the crash") as any), "fix");
eq("perf keyword + mod", typeFromContext(inp([{ path: "a.ts", x: "M" }], "improve perf here") as any), "perf");
eq("add → feat", typeFromContext(inp([{ path: "new.ts", x: "A" }]) as any), "feat");
eq("del → refactor", typeFromContext(inp([{ path: "old.ts", x: "D" }]) as any), "refactor");
eq("mod → refactor", typeFromContext(inp([{ path: "a.ts", x: "M" }]) as any), "refactor");
// known quirk: empty staged array makes paths.every() true → docs
eq("empty staged → docs (quirk)", typeFromContext(inp([]) as any), "docs");

// --- summary ---
eq("single file add", summaryFromDiff(inp([{ path: "src/gp/git.ts", x: "A" }]) as any), "add git.ts");
eq("single file update", summaryFromDiff(inp([{ path: "src/gp/git.ts", x: "M" }]) as any), "update git.ts");
eq("single file rename", summaryFromDiff(inp([{ path: "src/gp/git.ts", x: "R" }]) as any), "rename git.ts");
eq("common folder", summaryFromDiff(inp([{ path: "gp/a.ts", x: "M" }, { path: "gp/b.ts", x: "A" }]) as any), "add gp components");
eq("stat fallback", summaryFromDiff(inp([{ path: "a.ts", x: "M" }, { path: "b/x.ts", x: "M" }, { path: "c.ts", x: "M" }], "", "3 files changed, 10 insertions(+)") as any), "update a.ts (3 files)");
eq("hunk function hint", summaryFromDiff(inp([{ path: "a.ts", x: "M" }, { path: "b.ts", x: "M" }, { path: "c.ts", x: "M" }, { path: "d.ts", x: "M" }], "ctx\n@@ -10,7 +10,7 @@ function doThing\n+new line") as any), "update function doThing");
eq("few files fallback", summaryFromDiff(inp([{ path: "a.ts", x: "M" }, { path: "b.ts", x: "M" }, { path: "c.ts", x: "M" }]) as any), "a.ts, b.ts, c.ts");
eq("many files fallback", summaryFromDiff(inp([{ path: "a.ts", x: "M" }, { path: "b.ts", x: "M" }, { path: "c.ts", x: "M" }, { path: "d.ts", x: "M" }]) as any), "4 files");

// --- sanitize ---
eq("strip quotes", sanitizeSubject(`add "thing"`), "add thing");
eq("strip trailing dot", sanitizeSubject("add thing."), "add thing");
eq("72 cut keeps word", sanitizeSubject("x".repeat(30) + " " + "y".repeat(60)), "x".repeat(30) + " " + "y".repeat(41));
eq("collapse spaces", sanitizeSubject("a  b"), "a b");

// --- end-to-end ---
eq("feat scoped", heuristicCommit(inp([{ path: "src/components/Button.tsx", x: "A" }]) as any), "feat(button): add Button.tsx");
eq("long scope → no scope", heuristicCommit(inp([{ path: "reallylongfoldername/file.ts", x: "M" }]) as any), "refactor: update file.ts");
eq("fix branch", heuristicCommit({ ...inp([{ path: "a.ts", x: "M" }], "fix"), branch: "fix/crash" } as any), "fix: update a.ts");
eq("imperative already", heuristicCommit(inp([{ path: "x/gp/a.py", x: "A" }]) as any), "feat(gp): add a.py");
eq("4 files → no scope", heuristicCommit(inp([{ path: "a.ts", x: "A" }, { path: "b.ts", x: "A" }, { path: "c.ts", x: "A" }, { path: "d.ts", x: "A" }]) as any), "feat: 4 files");

console.log(`commitHeuristic: ${n} checks passed`);
