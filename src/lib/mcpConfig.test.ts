// runnable self-check: node --experimental-strip-types src/lib/mcpConfig.test.ts
import { setMcpEnabled } from "./mcpConfig.ts";
import { stripComments } from "./themes.ts";

// flipped output may carry comments — parse via the same jsonc stripper the app uses
const j = (s: string): any => JSON.parse(stripComments(s));

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}:\n got  ${JSON.stringify(got)}\n want ${JSON.stringify(want)}`);
}

// the real caller always spreads `enabled` into the entry (useMcp.ts:243)
const mkEntry = (enabled: boolean) => ({ type: "local", command: ["mcp-server-fs"], enabled });

// fresh (empty) file → full skeleton, 2-space indent, entry injected
const fresh = setMcpEnabled("", "fs", true, mkEntry(true));
eq("fresh has mcp", fresh.includes('"mcp": {'), true);
eq("fresh has server", fresh.includes('"fs": {'), true);
eq("fresh enabled true", fresh.includes('"enabled": true'), true);
eq("fresh is valid json", j(fresh).mcp.fs.enabled, true);

// flip existing enabled true -> false, comments preserved, rest untouched
const cfg = [
  "{",
  '  "$schema": "https://opencode.ai/config.json",',
  "  // my comment",
  '  "mcp": {',
  "    /* block */",
  '    "fs": {',
  '      "type": "local",',
  '      "command": ["mcp-server-fs"],',
  '      "enabled": true',
  "    },",
  '    "other": { "command": ["x"], "enabled": true }',
  "  }",
  "}",
].join("\n");
const flipped = setMcpEnabled(cfg, "fs", false, mkEntry(false));
eq("flip to false", j(flipped).mcp.fs.enabled, false);
eq("other server untouched", j(flipped).mcp.other.enabled, true);
eq("comment preserved", flipped.includes("// my comment"), true);
eq("block comment preserved", flipped.includes("/* block */"), true);
eq("nothing else moved", flipped.includes('"other": { "command": ["x"], "enabled": true }'), true);

// flip back false -> true (exact splice, no reformat)
const back = setMcpEnabled(flipped, "fs", true, mkEntry(false));
eq("flip to true", j(back).mcp.fs.enabled, true);

// "enabled" missing -> inserted before closing brace
const noEnabled = '{\n  "mcp": {\n    "fs": {\n      "command": ["mcp-server-fs"]\n    }\n  }\n}';
const inserted = setMcpEnabled(noEnabled, "fs", true, mkEntry(true));
eq("insert enabled", j(inserted).mcp.fs.enabled, true);
eq("command preserved", j(inserted).mcp.fs.command[0], "mcp-server-fs");

// server missing -> inserted into mcp
const noServer = '{\n  "mcp": {\n    "other": {\n      "enabled": false\n    }\n  }\n}';
const withServer = setMcpEnabled(noServer, "fs", false, mkEntry(false));
eq("insert server", j(withServer).mcp.fs.enabled, false);
eq("other kept", j(withServer).mcp.other.enabled, false);

// mcp missing -> inserted at root
const noMcp = '{\n  "theme": "dark"\n}';
const withMcp = setMcpEnabled(noMcp, "fs", false, mkEntry(false));
eq("insert mcp", j(withMcp).mcp.fs.enabled, false);
eq("theme kept", j(withMcp).theme, "dark");

// CRLF input normalized
const crlf = '{\r\n  "mcp": {\r\n    "fs": {\r\n      "enabled": true\r\n    }\r\n  }\r\n}';
eq("crlf flip", j(setMcpEnabled(crlf, "fs", false, mkEntry(false))).mcp.fs.enabled, false);

// tab indent detected and kept
const tabs = '{\n\t"mcp": {\n\t\t"fs": {\n\t\t\t"enabled": true\n\t\t}\n\t}\n}';
const tabsOut = setMcpEnabled(tabs, "fs", false, mkEntry(false));
eq("tabs flip", j(tabsOut).mcp.fs.enabled, false);
eq("tabs kept", tabsOut.includes('\t"enabled": false'), true);

// trailing comment after root close tolerated
const trailing = '{\n  "mcp": { "fs": { "enabled": true } }\n}\n// done';
eq("trailing comment ok", j(setMcpEnabled(trailing, "fs", false, mkEntry(false))).mcp.fs.enabled, false);

// errors
function throws(name: string, fn: () => unknown) {
  n++;
  try {
    fn();
    throw new Error(`FAIL ${name}: expected throw`);
  } catch (e) {
    if (String((e as Error).message).startsWith("FAIL")) throw e;
  }
}
throws("null entry throws", () => setMcpEnabled("{}", "x", true, null));
throws("array entry throws", () => setMcpEnabled("{}", "x", true, []));
throws("no root throws", () => setMcpEnabled("[]", "x", true, mkEntry(true)));
throws("mcp not object throws", () => setMcpEnabled('{ "mcp": [] }', "x", true, mkEntry(true)));
throws("server not object throws", () => setMcpEnabled('{ "mcp": { "fs": "x" } }', "fs", true, mkEntry(true)));
throws("unbalanced braces throws", () => setMcpEnabled("{ nope", "x", true, mkEntry(true)));

console.log(`mcpConfig: ${n} checks passed`);
