// runnable self-check: node --experimental-strip-types src/lib/editorKeys.test.ts
import {
  lineCommentForPath,
  opCopyLine,
  opCutLine,
  opDeleteLine,
  opDuplicate,
  opMoveLine,
  opSelectLine,
  opInsertLine,
  opToggleComment,
} from "./editorKeys.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// "alpha\nbeta\ngamma": alpha=[0,5) beta=[6,10) gamma=[11,16)
const T = "alpha\nbeta\ngamma";

// --- lineCommentForPath ---
eq("ts → //", lineCommentForPath("src/lib/foo.ts"), { kind: "line", prefix: "//" });
eq("py → #", lineCommentForPath("a/b/c.py"), { kind: "line", prefix: "#" });
eq("yml → #", lineCommentForPath("Docker.yml"), { kind: "line", prefix: "#" });
eq("lua → --", lineCommentForPath("init.lua"), { kind: "line", prefix: "--" });
eq("html → <!-- -->", lineCommentForPath("page.html"), { kind: "block", start: "<!--", end: "-->" });
eq("css → /* */", lineCommentForPath("style.css"), { kind: "block", start: "/*", end: "*/" });
eq("no path → //", lineCommentForPath(undefined), { kind: "line", prefix: "//" });
eq("uppercase ext", lineCommentForPath("A.PY"), { kind: "line", prefix: "#" });

// --- opCopyLine / opCutLine ---
eq("copy middle line", opCopyLine(T, 7), "beta\n");
eq("copy last line (no nl)", opCopyLine(T, 12), "gamma");
eq("cut middle line", opCutLine(T, 7), { text: "alpha\ngamma", caret: 6 });
eq("cut last line", opCutLine(T, 12), { text: "alpha\nbeta\n", caret: 11 });

// --- opDeleteLine ---
eq("delete middle", opDeleteLine(T, 7, 7), { text: "alpha\ngamma", caret: 6 });
eq("delete whole text", opDeleteLine("abc", 0, 3), { text: "", caret: 0 });
eq("delete selection spans lines", opDeleteLine(T, 1, 8).text, "gamma");

// --- opDuplicate ---
eq("dup line down (trailing nl)", opDuplicate(T, 7, 7, "down").text, "alpha\nbeta\nbeta\ngamma");
eq("dup first line down", opDuplicate(T, 2, 2, "down").text, "alpha\nalpha\nbeta\ngamma");
eq("dup first line up", opDuplicate(T, 2, 2, "up").text, "alpha\nalpha\nbeta\ngamma");
eq("dup last line down (no nl)", opDuplicate(T, 12, 12, "down").text, "alpha\nbeta\ngamma\ngamma");

// --- opMoveLine ---
eq("move down", opMoveLine(T, 7, 7, "down"), { text: "alpha\ngamma\nbeta", caret: 13 });
eq("move up", opMoveLine(T, 7, 7, "up"), { text: "beta\nalpha\ngamma", caret: 1 });
eq("move first line up → null", opMoveLine(T, 0, 0, "up"), null);
eq("move last line down → null", opMoveLine(T, 12, 12, "down"), null);
eq("move multi-line block", opMoveLine(T, 1, 8, "down"), { text: "gamma\nalpha\nbeta", caret: 7 });
// CRLF: line ops normalize to \n (save normalizes; FileEditor loads \n)
const CRLF = "a\r\nb\r\nc";
eq("CRLF move down", opMoveLine(CRLF, 0, 0, "down")?.text, "b\na\nc");

// --- opSelectLine ---
eq("select middle line", opSelectLine(T, 7), { start: 6, end: 10 });
eq("select last line", opSelectLine(T, 12), { start: 11, end: 16 });

// --- opInsertLine ---
eq("insert above", opInsertLine(T, 7, "above"), { text: "alpha\n\nbeta\ngamma", caret: 6 });
eq("insert below", opInsertLine(T, 7, "below"), { text: "alpha\nbeta\n\ngamma", caret: 11 });

// --- opToggleComment (line style) ---
const js = { kind: "line", prefix: "//" } as const;
eq("comment one line", opToggleComment("const x = 1;", 5, 5, js).text, "// const x = 1;");
// "  foo();\n  bar();" — sel 2..12 spans both lines
eq("comment preserves indent", opToggleComment("  foo();\n  bar();", 2, 12, js).text, "  // foo();\n  // bar();");
eq("uncomment removes prefix+space", opToggleComment("// hello", 0, 8, js).text, "hello");
eq("uncomment without space", opToggleComment("//hello", 0, 7, js).text, "hello");
eq("mixed selection → comment all", opToggleComment("// a\nb", 0, 6, js).text, "// // a\n// b");
eq("empty lines skipped", opToggleComment("a\n\nb", 0, 4, js).text, "// a\n\n// b");
eq("CRLF normalized to LF", opToggleComment("x\r\ny", 0, 3, js).text, "// x\n// y");
// block style (CSS)
const css = { kind: "block", start: "/*", end: "*/" } as const;
eq("block comment", opToggleComment("body { }", 0, 8, css).text, "/* body { } */");
eq("block uncomment", opToggleComment("/* body { } */", 0, 14, css).text, "body { }");

console.log(`editorKeys: ${n} checks passed`);
