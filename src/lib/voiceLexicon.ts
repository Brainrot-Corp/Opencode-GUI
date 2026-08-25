// voice lexicon — rewrites natural / multilingual phrasing into the canonical
// English vocabulary the router matches against ("envoie le rapport" →
// "send …"). Adding a synonym forever is one array line here; plugins add
// their own domain vocabulary via ext.lexicon (applied after these rules).
// InfoDialog documents the surface phrasings.
//
// Accents are stripped BEFORE matching (JS \b treats "é" as a non-word char,
// which silently kills accented patterns) — so every rule below is written
// unaccented.

const deaccent = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// ordered rewrites: multi-word and specific phrases first, single words after
const RULES: [RegExp, string][] = [
  // French / Spanish action verbs
  [/\barrete(r)?\b|\bdetene(r)?\b/g, "stop"],
  [/\bannul(?:e|er)\b|\bcancela(r)?\b/g, "cancel"],
  [/\bouvre\b|\bouvrir\b|\babre(r)?\b/g, "open"],
  [/\bferme\b|\bfermer\b|\bcierra(r)?\b/g, "close"],
  [/\bquitte\b|\bquitter\b/g, "quit"],
  [/\bretrécis\b|\bretrécir\b|\bminimiza(r)?\b/g, "minimize"],
  [/\bmata\b/g, "kill"],
  [/\bexécute\b|\bexécuter\b|\bejecuta(r)?\b/g, "run"],
  [/\befface\b|\beffacer\b/g, "clear"],
  [/\bborra(r)?\b/g, "erase"],

  // dictation prefixes
  [/\bécris\b|\becris\b|\bdicte\b/g, "prompt"],
  [/\benvoie\b|\benvoyer\b/g, "send"],

  // settings / session helpers
  [/\bparamètres\b|\bréglages\b|\breglages\b/g, "settings"],
  [/\bnouvelle\b|\bnueva\b/g, "new"],

  // mic check as a whole phrase
  [/\btu m'entends\b|\bm'entends-tu\b|\bme escuchas\b/g, "can you hear me"],
];

// plugin-contributed rewrites (ext.lexicon), applied after RULES — replaceable
// wholesale so hot-reloading a plugin swaps its vocabulary cleanly
let EXTRA: [RegExp, string][] = [];

export function setPluginLexicon(rules: [RegExp, string][]) {
  EXTRA = rules;
}

// polite wrappers stripped before matching
const LEAD =
  /^(?:est-ce que |peux-tu |pourrais-tu |pouvons-nous |can you |could you |would you |podrias |puedes )+/;
const TAIL =
  /\s+(?:please|thanks|thank you|merci|gracias|s'il te plait|s'il vous plait|stp)+$/;

import { doubleMetaphone } from "double-metaphone";

export function expandVoice(t: string): string {
  let prev = deaccent(t).replace(LEAD, "");
  while (TAIL.test(prev)) prev = prev.replace(TAIL, "");
  for (const [re, to] of RULES) prev = prev.replace(re, to);
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
      // accents compress words ("tim" for "theme") without adding letters
      if (!w || V.includes(w)) return tok;
      if (w.length >= 4) {
        const hit = V.find((k) => oneEdit(w, k));
        if (hit) return pre + hit + post;
      }
      if (w.length >= 3) {
        const phit = phonHit(w, V);
        if (phit) return pre + phit + post;
      }
      return tok;
    })
    .join(" ");
}
