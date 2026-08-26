// runnable self-check: node --experimental-strip-types src/lib/syntax.test.ts
import { looksLikeCode, insertFenced, detectLang } from "./syntax.ts";

let n = 0;
function eq(a: unknown, e: unknown, label: string) {
  n++;
  if (JSON.stringify(a) !== JSON.stringify(e))
    throw new Error(`FAIL ${label}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`);
}

// looksLikeCode — positives
eq(looksLikeCode("const x = 1;\nconsole.log(x);"), true, "js snippet");
eq(looksLikeCode("def main():\n    print('hi')"), true, "python indent");
eq(looksLikeCode("git status"), true, "bare command");
eq(looksLikeCode("$ npm install"), true, "prompted command");
eq(looksLikeCode("#!/bin/bash\necho hi"), true, "shebang script");
eq(looksLikeCode('{\n  "a": 1\n}'), true, "json braces");
eq(looksLikeCode("<div>\n  <span>x</span>\n</div>"), true, "html tags");

// looksLikeCode — negatives
eq(looksLikeCode("can you explain how async await works in depth"), false, "prose question");
eq(looksLikeCode("https://example.com/some/path"), false, "url");
eq(looksLikeCode("README"), false, "single token");
eq(looksLikeCode("```ts\nconst a=1;\n```"), false, "already fenced");
eq(looksLikeCode("Fix this bug."), false, "sentence with period");
eq(looksLikeCode(""), false, "empty");

// insertFenced
eq(insertFenced("", 0, 0, "ls -la", "bash").text, "```bash\nls -la\n```\n", "empty input");
let r = insertFenced("hello world", 5, 5, "print(1)", "python");
eq(r.text, "hello\n\n```python\nprint(1)\n```\n\n world", "mid-text padding");
eq(r.caret, r.text.indexOf(" world") - 1, "caret on blank line after fence");
r = insertFenced("top\n\n", 6, 6, "x=1", "");
eq(r.text, "top\n\n```\nx=1\n```\n", "no triple blank line");

// detectLang
eq(detectLang("$ npm run build"), "bash", "shell line → bash");
eq(typeof detectLang("const x: number = 1;"), "string", "auto detect runs");

console.log(`syntax paste helpers: ${n} checks passed`);
