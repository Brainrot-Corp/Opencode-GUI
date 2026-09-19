// runnable self-check: node --experimental-strip-types src/lib/commitPrompt.test.ts
import { buildCommitPrompt, cleanCommitMessage } from "./commitPrompt.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function has(name: string, hay: string, needle: string) {
  n++;
  if (!hay.includes(needle)) throw new Error(`FAIL ${name}: missing ${JSON.stringify(needle)}\n in: ${hay.slice(0, 300)}`);
}
function lacks(name: string, hay: string, needle: string) {
  n++;
  if (hay.includes(needle)) throw new Error(`FAIL ${name}: unexpected ${JSON.stringify(needle)}\n in: ${hay.slice(0, 300)}`);
}

// --- buildCommitPrompt ---
const ctx = {
  staged: [{ path: "src/a.ts", x: "M" }, { path: "src/b.ts", x: "A" }],
  branch: "feat/widgets",
  stat: " 2 files changed, 10 insertions(+)",
  diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,3 @@\n+const a = 1;\n context line\n-old line\n+new line",
  log: "abc123 fix: previous\n def456 feat: older one\n 789aaa chore: older still\n aaa bbb\n ccc ddd\n eee fff",
  includeBody: true,
};
const p = buildCommitPrompt(ctx);
has("generator role", p, "commit message generator");
has("branch line", p, "Branch: feat/widgets");
has("staged file list", p, "M src/a.ts\nA src/b.ts");
has("stat kept", p, "2 files changed");
has("log capped at 5", p, "ccc ddd");
lacks("log capped — 6th dropped", p, "eee ddd".replace("ddd", "fff"));
has("diff kept", p, "+const a = 1;");
has("body rule present", p, "Also write a body");
lacks("subject-only rule absent", p, "Subject only");

const noBody = buildCommitPrompt({ ...ctx, includeBody: false });
has("subject-only rule", noBody, "Subject only");

const noBranch = buildCommitPrompt({ ...ctx, branch: "", log: "" });
lacks("no branch line", noBranch, "Branch:");
lacks("no log section", noBranch, "Recent commits:");

// diff compression: long diff keeps only headers/hunks/± lines, within budget
let big = "";
for (let i = 0; i < 400; i++) big += `context ${i} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+added ${i}\n`;
const compressed = buildCommitPrompt({ ...ctx, diff: big });
n++;
if (compressed.length > 20000) throw new Error(`FAIL compressed prompt too big: ${compressed.length}`);
n++;
if (compressed.length >= big.length) throw new Error(`FAIL diff not compressed: ${compressed.length} >= ${big.length}`);
has("added lines survive compression", compressed, "+added 0");

// --- cleanCommitMessage ---
eq("plain subject", cleanCommitMessage("add thing", false), "add thing");
eq("trailing dot stripped", cleanCommitMessage("add thing.", false), "add thing");
eq("surrounding quotes stripped", cleanCommitMessage(`"add thing"`, false), "add thing");
eq("fences stripped", cleanCommitMessage("```\nadd thing\n```", false), "add thing");
eq("fence lang stripped", cleanCommitMessage("```text\nadd thing\n```", false), "add thing");
eq("72 cut at word", cleanCommitMessage("x".repeat(30) + " " + "y".repeat(60), false), "x".repeat(30) + " " + "y".repeat(41));
eq("subject only ignores body", cleanCommitMessage("subject\n\n- a\n- b", false), "subject");
eq("body bullets added", cleanCommitMessage("subject\n\na\nb\nc", true), "subject\n\n- a\n- b\n- c");
eq("body capped at 3", cleanCommitMessage("subject\n\na\nb\nc\nd", true), "subject\n\n- a\n- b\n- c");
eq("pre-bulleted body kept", cleanCommitMessage("subject\n\n- a", true), "subject\n\n- a");
eq("echoed subject dropped from body", cleanCommitMessage("subject\n\nsubject\n- a", true), "subject\n\n- a");

console.log(`commitPrompt: ${n} checks passed`);
