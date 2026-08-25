// English wordlist backing the typo-corrector's "real word" veto — bundled
// data (~3 MB), parsed into a Set once. Until init runs, isRealWord answers
// "no" so corrections keep working (legacy behavior) during warmup.
import words from "an-array-of-english-words" with { type: "json" };

let set: Set<string> | null = null;
let ready: Promise<void> | null = null;

export function ensureDict(): Promise<void> {
  if (!ready) {
    ready = Promise.resolve().then(() => {
      set = new Set(words as string[]);
    });
  }
  return ready;
}

// conservative once loaded: real words are never phonetic-repaired, only
// spelling-repaired toward known domain vocabulary
export function isRealWord(w: string): boolean {
  return set ? set.has(w) : false;
}
