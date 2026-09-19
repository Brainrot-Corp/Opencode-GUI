// runnable self-check: node --experimental-strip-types src/lib/find.test.ts
import { findMatches, highlightFindInHtml } from "./find.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// --- findMatches ---
const text = "abc abc\nABC abd";
eq("case-sensitive", findMatches(text, "abc", true), [0, 4]);
eq("case-insensitive", findMatches(text, "abc", false), [0, 4, 8]);
eq("empty query → []", findMatches(text, "", true), []);
eq("no hit → []", findMatches(text, "zzz", true), []);
eq("overlapping-free stepping", findMatches("aaa", "aa", true), [0]);

// --- highlightFindInHtml ---
const html = "<p>abc <b>abc</b> end</p>";
const out = highlightFindInHtml(html, "abc", false, 0);
eq("both hits wrapped", (out.match(/find-hit/g) ?? []).length, 2);
eq("active class on first", out.includes('class="find-hit active"'), true);
eq("tags intact", out.startsWith("<p>") && out.endsWith("</p>"), true);

// cur=1 → active moves to second hit
const out2 = highlightFindInHtml(html, "abc", false, 1);
eq("active on 2nd", (out2.match(/find-hit active/g) ?? []).length, 1);
eq("first not active now", !out2.slice(0, out2.indexOf("<b>")).includes("find-hit active"), true);

// tags never matched inside
const tagCase = highlightFindInHtml('<p class="text">text</p>', "text", false, 0);
eq("attribute not highlighted", tagCase.includes('class="text"'), true);
eq("text node matched", tagCase.includes("<span"), true);

// empty query → unchanged
eq("empty query unchanged", highlightFindInHtml(html, "", true, 0), html);
eq("empty html", highlightFindInHtml("", "q", true, 0), "");

console.log(`find: ${n} checks passed`);
