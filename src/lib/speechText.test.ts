// runnable self-check: node --experimental-strip-types src/lib/speechText.test.ts
import { splitForSpeech, cleanSpeech, wordCount, lowVariantFor, full_text } from "./speechText.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// --- cleanSpeech (markdown scrub, whitespace collapsed) ---
eq("closed fence → placeholder", cleanSpeech("before\n```py\ncode\n```\nafter"), "before code block omitted. after");
eq("open fence held back", cleanSpeech("talk\n```py\ncode without end"), "talk");
eq("inline code unwrapped", cleanSpeech("run `npm test` now"), "run npm test now");
eq("bold markers stripped", cleanSpeech("**hi** there"), "hi there");
eq("blank → empty", cleanSpeech("   \n  "), "");

// --- splitForSpeech ---
eq("empty → []", splitForSpeech(""), []);
eq("short sentence one chunk", splitForSpeech("This is fine."), ["This is fine."]);
// long input: every chunk within a sane max, nothing lost, order kept
const long = ("This is sentence number " + "x".repeat(30) + ". ").repeat(30);
const chunks = splitForSpeech(long);
n++;
if (!chunks.length) throw new Error("FAIL chunks empty");
for (const c of chunks) {
  n++;
  if (c.length > 240) throw new Error(`FAIL chunk too long: ${c.length} — ${c.slice(0, 80)}`);
}
eq("no words lost", chunks.join(" ").replace(/\s+/g, " ").trim(), long.replace(/\s+/g, " ").trim());

// --- wordCount ---
eq("wordCount simple", wordCount("a b  c"), 3);
eq("wordCount empty", wordCount("   "), 0);

// --- lowVariantFor ---
const providers = [
  { id: "opencode", models: [{ id: "gpt", variants: ["high", "low"] }, { id: "mini", variants: ["minimal"] }, { id: "nano", variants: [] }] },
  { id: "other", models: [{ id: "fast", variants: ["fast"] }] },
];
eq("low preferred", lowVariantFor("opencode/gpt", providers), "low");
eq("minimal fallback", lowVariantFor("opencode/mini", providers), "minimal");
eq("fast fallback", lowVariantFor("other/fast", providers), "fast");
eq("no variants → undefined", lowVariantFor("opencode/nano", providers), undefined);
eq("unknown model", lowVariantFor("opencode/nope", providers), undefined);
eq("unknown provider", lowVariantFor("nope/gpt", providers), undefined);
eq("slashless id", lowVariantFor("gpt", providers), undefined);

// --- full_text ---
const msg = { parts: [{ type: "text", text: "a" }, { type: "reasoning", text: "x" }, { type: "text", text: "b" }] } as any;
eq("text parts joined", full_text(msg), "a b");
eq("empty parts", full_text({ parts: [] } as any), "");

console.log(`speechText: ${n} checks passed`);
