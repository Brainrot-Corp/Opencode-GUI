// runnable self-check: node --experimental-strip-types src/lib/changedFiles.test.ts
import { extractChanged } from "./changedFiles.ts";

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

console.log(`changedFiles: ${n} checks passed`);
