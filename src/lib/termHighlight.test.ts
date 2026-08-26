// runnable self-check: node src/lib/termHighlight.test.ts
import { TermHighlighter } from "./termHighlight.ts";

const enc = new TextEncoder();
let n = 0;
function ok(cond: unknown, label: string) {
  n++;
  if (!cond) throw new Error(`FAIL ${label}`);
}
function eq(actual: unknown, expected: unknown, label: string) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

// multi-line JS block gets colored (block-level detection needs context)
{
  const out: string[] = [];
  const h = new TermHighlighter((s) => out.push(s));
  h.write(enc.encode("function add(a, b) {\n"));
  h.write(enc.encode("  return a + b;\n"));
  h.write(enc.encode("}\n"));
  h.flush();
  const s = out.join("");
  ok(/\x1b\[36mfunction\x1b\[39m/.test(s), `keyword colored, got ${JSON.stringify(s)}`);
  ok(s.endsWith("}\n"), "structure preserved");
  h.dispose();
}

// escape-bearing data passes through raw; plain text around it buffers as usual
{
  const out: string[] = [];
  const h = new TermHighlighter((s) => out.push(s));
  h.write(enc.encode("PS> "));
  h.write(enc.encode("\x1b[93mgit status"));
  h.flush();
  eq(out.join(""), "PS> \x1b[93mgit status", "raw in → raw out, order kept");
  h.dispose();
}

// THE ConPTY CASE: escapes and plain output interleaved in ONE chunk —
// prompt passes raw, following code lines still get colored
{
  const out: string[] = [];
  const h = new TermHighlighter((s) => out.push(s));
  h.write(enc.encode("\x1b[?25lPS> \x1b[0mfunction add(a, b) {\n  return a + b;\n}\n"));
  h.flush();
  const s = out.join("");
  ok(s.startsWith("\x1b[?25lPS> \x1b[0m"), "escape segment raw first");
  ok(/\x1b\[36mfunction\x1b\[39m/.test(s), "plain lines after escapes still colored");
  h.dispose();
}

// escape sequence split across chunks reassembles instead of corrupting
{
  const out: string[] = [];
  const h = new TermHighlighter((s) => out.push(s));
  h.write(enc.encode("ok\x1b"));
  h.flush();
  eq(out.join(""), "ok", "text before incomplete sequence ships");
  h.write(enc.encode("[93mhi\n"));
  h.flush();
  eq(out.join(""), "ok\x1b[93mhi\n", "held tail completes the sequence");
  h.dispose();
}

// prose stays uncolored even as a block
{
  const out: string[] = [];
  const h = new TermHighlighter((s) => out.push(s));
  h.write(enc.encode("this is just a sentence about things\n"));
  h.write(enc.encode("and another line of plain prose here\n"));
  h.flush();
  ok(!out.join("").includes("\x1b["), "no SGR for prose");
  h.dispose();
}

// blank lines flush the block and are preserved verbatim
{
  const out: string[] = [];
  const h = new TermHighlighter((s) => out.push(s));
  h.write(enc.encode('const a = 1;\n\nnext paragraph\n'));
  h.flush();
  ok(out.join("").includes("\n\n"), "blank line kept");
  h.dispose();
}

// partial line held until flushed (prompt safety)
{
  const out: string[] = [];
  const h = new TermHighlighter((s) => out.push(s));
  h.write(enc.encode("partial without newline"));
  eq(out.join(""), "", "nothing emitted before newline/flush");
  h.flush();
  eq(out.join(""), "partial without newline", "flush ships the tail raw");
  h.dispose();
}

console.log(`termHighlight: ${n} checks passed`);
