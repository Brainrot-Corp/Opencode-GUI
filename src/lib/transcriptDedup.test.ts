// runnable self-check: node --experimental-strip-types src/lib/transcriptDedup.test.ts
import { wordOverlap, dedupOverlap, DedupEmitter } from "./transcriptDedup.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// --- wordOverlap ---
eq("exact suffix match", wordOverlap("hello world", "world foo"), 1);
eq("two-word overlap", wordOverlap("a b c", "b c d"), 2);
eq("no overlap", wordOverlap("a b", "c d"), 0);
eq("case-insensitive match", wordOverlap("Hello World", "world foo"), 1);
// punctuation is not stripped — "world!" ≠ "world"
eq("punctuation breaks match", wordOverlap("Hello World!", "world foo"), 0);
eq("empty prev", wordOverlap("", "a b"), 0);
eq("full match", wordOverlap("a b", "a b c"), 2);

// --- dedupOverlap ---
eq("empty prev → next", dedupOverlap("", "  hi there  "), "hi there");
eq("blank next → empty", dedupOverlap("something", "   "), "");
eq("char-level prefix", dedupOverlap("hello", "hello world"), "world");
eq("case-insensitive prefix", dedupOverlap("Hello", "hello world"), "world");
eq("prefix-only → empty", dedupOverlap("hello world", "hello world"), "");
eq("word-level overlap suffix", dedupOverlap("a b c", "c d e"), "d e");
eq("no overlap → whole next", dedupOverlap("alpha beta", "gamma delta"), "gamma delta");

// --- DedupEmitter (cumulative stream) ---
const em = new DedupEmitter();

let r = em.push("hello");
eq("first push delta", r.delta, "hello");
eq("first push cumulative", r.cumulative, "hello");
eq("first push isNew", r.isNew, true);

// re-transcription with overlap → suffix only
r = em.push("hello world");
eq("suffix delta", r.delta, "world");
eq("suffix cumulative", r.cumulative, "hello world");
eq("suffix isNew", r.isNew, true);

// identical raw → no new words
r = em.push("hello world");
eq("no delta", r.delta, "");
eq("isNew false", r.isNew, false);
eq("cumulative stable", r.cumulative, "hello world");

// whisper revised the whole buffer → replace, not append
r = em.push("totally different words");
eq("correction replaces delta", r.delta, "totally different words");
eq("correction replaces cumulative", r.cumulative, "totally different words");

// empty chunk is a no-op
r = em.push("  ");
eq("blank no-op", r.isNew, false);
eq("cumulative kept", r.cumulative, "totally different words");

// reset
em.reset();
r = em.push("fresh");
eq("after reset first", r.delta, "hello".replace("hello", "fresh"));
eq("cumulative reset", em.cumulative, "fresh");

console.log(`transcriptDedup: ${n} checks passed`);
