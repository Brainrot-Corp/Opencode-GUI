// English wordlist backing the typo-corrector's "real word" veto — ~3 MB of
// data, so it's code-split into its own chunk and parsed once, lazily. Until
// init runs, isRealWord answers "no" so corrections keep working (legacy
// behavior) during warmup.
let set: Set<string> | null = null;
let ready: Promise<void> | null = null;

export function ensureDict(): Promise<void> {
  if (!ready) {
    ready = import("an-array-of-english-words", { with: { type: "json" } }).then((m) => {
      set = new Set(m.default as string[]);
    });
  }
  return ready;
}

// conservative once loaded: real words are never phonetic-repaired, only
// spelling-repaired toward known domain vocabulary
export function isRealWord(w: string): boolean {
  return set ? set.has(w) : false;
}
