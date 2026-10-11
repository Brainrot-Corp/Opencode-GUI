// runnable self-check: node --experimental-strip-types src/lib/changedFiles.test.ts
import { extractChanged, sessionDiffFiles } from "./changedFiles.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
const tool = (toolName: string, input: any, status = "completed"): any => ({
  type: "tool",
  tool: toolName,
  state: { status, input },
});

eq("empty", extractChanged([]), []);
eq(
  "write+edit same file deduped",
  extractChanged([tool("write", { filePath: "a.ts" }), tool("edit", { filePath: "a.ts" })]),
  [{ kind: "file", path: "a.ts" }],
);
eq(
  "order kept + path alias",
  extractChanged([tool("write", { filePath: "b.ts" }), tool("edit", { path: "c.ts" })]),
  [
    { kind: "file", path: "b.ts" },
    { kind: "file", path: "c.ts" },
  ],
);
eq(
  "bash raw kept, empty skipped",
  extractChanged([tool("bash", { command: "npm run build" }), tool("bash", { command: "  " })]),
  [{ kind: "bash", command: "npm run build" }],
);
eq(
  "pending/running skipped, error kept",
  extractChanged([
    tool("write", { filePath: "x.ts" }, "pending"),
    tool("write", { filePath: "y.ts" }, "running"),
    tool("write", { filePath: "z.ts" }, "error"),
  ]),
  [{ kind: "file", path: "z.ts" }],
);
eq(
  "non-file tools + git patch part ignored",
  extractChanged([
    { type: "patch", files: ["git.ts"] } as any,
    tool("read", { filePath: "r.ts" }),
    tool("bash", { command: "ls" }),
  ]),
  [{ kind: "bash", command: "ls" }],
);

const umsg = (id: string, diffs?: any[]): any => ({
  info: { id, role: "user", summary: diffs ? { diffs } : undefined },
  parts: [],
});
const amsg = (id: string): any => ({ info: { id, role: "assistant" }, parts: [] });

eq("no summaries → []", sessionDiffFiles([umsg("u1"), amsg("a1")]), []);
eq(
  "merges + dedups, assistant ignored",
  sessionDiffFiles([
    umsg("u1", [{ file: "a.ts" }, { file: "b.ts" }]),
    amsg("a1"),
    umsg("u2", [{ file: "b.ts" }, { file: "c.ts" }, { file: "" }, {}]),
  ]),
  ["a.ts", "b.ts", "c.ts"],
);
eq("empty + missing → []", sessionDiffFiles([]), []);
eq("non-array input → []", sessionDiffFiles(undefined as any), []);
eq(
  "tool parts detected without summaries",
  sessionDiffFiles([
    { info: { id: "a1", role: "assistant" }, parts: [tool("write", { filePath: "t.ts" })] },
  ]),
  ["t.ts"],
);
eq(
  "summaries + tools merge and dedup",
  sessionDiffFiles([
    umsg("u1", [{ file: "a.ts" }]),
    { info: { id: "a1", role: "assistant" }, parts: [tool("edit", { filePath: "a.ts" }), tool("write", { filePath: "b.ts" })] },
  ]),
  ["a.ts", "b.ts"],
);

console.log(`changedFiles: ${n} checks passed`);
