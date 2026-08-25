// voice lexicon — normalizes transcripts into the canonical English the
// router matches against. Multilingual phrasing needs no tables here: an
// unmatched utterance gets a second whisper pass with --translate before
// routing gives up (see ChatPage), so this module only handles English
// politeness wrappers and typo repair. Plugins add domain idioms via
// ext.lexicon (applied after nothing else — they're the only rewrite table).
//
// Accents are stripped BEFORE matching (JS \b treats "é" as a non-word char,
// which silently kills accented patterns).

const deaccent = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// plugin-contributed rewrites (ext.lexicon) — replaceable wholesale so
// hot-reloading a plugin swaps its vocabulary cleanly
let EXTRA: [RegExp, string][] = [];

export function setPluginLexicon(rules: [RegExp, string][]) {
  EXTRA = rules;
}

// polite wrappers stripped before matching
const LEAD = /^(?:can you |could you |would you )+/;
const TAIL = /\s+(?:please|thanks|thank you)+$/;

import { doubleMetaphone } from "double-metaphone";
import { isRealWord } from "./dictWords.ts";

export function expandVoice(t: string): string {
  let prev = deaccent(t).replace(LEAD, "");
  while (TAIL.test(prev)) prev = prev.replace(TAIL, "");
  for (const [re, to] of EXTRA) prev = prev.replace(re, to);
  return prev.replace(/\s+/g, " ").trim();
}

// gentle typo tolerance for whisper noise ("teme"): any word within one edit
// of known vocabulary — the static lexicon below plus whatever the caller
// passes (triggers, live theme/command names, plugin vocab). One edit =
// substitution OR adjacent transposition (naive Hamming calls a swap 2).
const LEX = ["dark", "light", "theme"];

function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === b.length) {
    // one substitution, or one adjacent transposition ("lihgts" → "lights")
    let diff = 0;
    let swap = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (swap === -1 && i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i]) {
          swap = i;
          i++; // both positions consumed by the transpose
          continue;
        }
        if (++diff > 1) return false;
      }
    }
    return true;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.length - s.length !== 1) return false;
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

// pronunciation fallback: ASR mishearings ("comit", "purpul", "liets") can be
// far from the target spelling yet share a double-metaphone key with it
function phonHit(w: string, V: string[]): string | undefined {
  const codes = new Set(doubleMetaphone(w));
  return V.find((k) => {
    const [a, b] = doubleMetaphone(k);
    return codes.has(a) || codes.has(b);
  });
}

export function fixTypos(t: string, extra: string[] = []): string {
  const V = extra.length ? [...LEX, ...extra] : LEX;
  return t
    .split(" ")
    .map((tok) => {
      // strip surrounding punctuation before matching — metaphone would
      // otherwise read "tim," as /timk/-ish garbage and collide with "theme"
      const m = /^([^a-z]*)([a-z]+)([^a-z]*)$/.exec(tok);
      if (!m) return tok;
      const [, pre, w, post] = m;
      // spelling fixes need 4+ chars; the pronunciation pass may go lower —
      // accents compress words ("tim" for "theme") without adding letters.
      // Phonetic repair is vetoed for real dictionary words — that path is
      // low-precision and would mangle legit speech ("guide"/"git" → "quit");
      // spelling repairs toward known vocabulary stay allowed for any word
      if (!w || V.includes(w)) return tok;
      if (w.length >= 4) {
        const hit = V.find((k) => oneEdit(w, k));
        if (hit) return pre + hit + post;
      }
      if (w.length >= 3 && !isRealWord(w)) {
        const phit = phonHit(w, V);
        if (phit) return pre + phit + post;
      }
      return tok;
    })
    .join(" ");
}
