// quick check of TermHighlighter newline preservation
import { TermHighlighter } from "./termHighlight.ts";

let out = "";
const hl = new TermHighlighter((s) => (out += s));

const green = "\x1b[32m";
const reset = "\x1b[0m";

// realistic PowerShell ls: CRLF, colored Mode column, interleaved chunks
const lines = [
  `Mode                 LastWriteTime         Length Name\r\n`,
  `----                 -------------         ------ ----\r\n`,
  `${green}d-----${reset}         8/23/2026   5:46 PM                .vscode\r\n`,
  `${green}d-----${reset}         8/25/2026   8:28 AM                default_plugins\r\n`,
  `${green}-a----${reset}         8/26/2026   9:10 AM         140648 package-lock.json\r\n`,
];
const full = lines.join("");
const bytes = (s: string) => new TextEncoder().encode(s);

// split into awkward chunks to exercise escTail/partial paths
const chunk = (s: string, size: number) => {
  for (let i = 0; i < s.length; i += size) {
    hl.write(bytes(s.slice(i, i + size)));
  }
};

chunk(full, 7);
hl.flush();

console.log("=== OUTPUT ===");
console.log(JSON.stringify(out));
console.log("=== RENDERED (escape-stripped) ===");
console.log(out.replace(/\x1b\[[0-9;]*m/g, ""));

const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
const expected = lines.map((l) => l.replace(/\r\n$/, "\n").replace(/\x1b\[[0-9;]*m/g, "")).join("");
if (stripped === expected) {
  console.log("PASS: newlines preserved, byte-identical after color strip");
} else {
  console.log("FAIL");
  console.log("expected:", JSON.stringify(expected));
  console.log("got:     ", JSON.stringify(stripped));
}
