// runnable self-check: node --experimental-strip-types src/lib/subagents.test.ts
import { extractTaskId, resolveSubagentTarget } from "./subagents.ts";

let n = 0;
function check(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

check("plain ses id", extractTaskId("done, see ses_abc123 for details"), "ses_abc123");
check("task xml", extractTaskId('<task id="ses_X-9_" state="completed">'), "ses_X-9_");
check("none", extractTaskId("no ids here"), null);
check("empty", extractTaskId(""), null);

const kids = [
  { id: "ses_second", title: "write tests", timeCreated: 200 },
  { id: "ses_first", title: "explore repo", timeCreated: 100 },
];
const pExplore = { type: "subtask", description: "explore repo", prompt: "look around", agent: "explore" };
const pTests = { type: "subtask", description: "write tests", prompt: "cover it", agent: "build" };
const msgs = [{ parts: [pExplore] }, { parts: [pTests] }];
// description match wins regardless of order
check("desc match", resolveSubagentTarget(pTests, msgs, kids)?.id, "ses_second");
// chronological fallback when nothing matches textually
const pOther = { type: "agent", name: "zzz", description: "qqq", prompt: "www" };
check("chrono first", resolveSubagentTarget(pOther, [{ parts: [pOther] }], kids)?.id, "ses_first");
// no children -> null (caller shows toast, never guesses)
check("no kids", resolveSubagentTarget(pExplore, msgs, []), null);

console.log(`subagents: ${n} checks passed`);
