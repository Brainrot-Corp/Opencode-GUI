// voice lexicon — rewrites natural / multilingual phrasing into the canonical
// English vocabulary the router matches against ("allume la lumière" →
// "turn on the light", "luz roja" → "light red"). Adding a synonym forever is
// one array line here; InfoDialog documents the surface phrasings.
//
// Accents are stripped BEFORE matching (JS \b treats "é" as a non-word char,
// which silently kills accented patterns) — so every rule below is written
// unaccented.

const deaccent = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// ordered rewrites: multi-word and specific phrases first, single words after
const RULES: [RegExp, string][] = [
  // idiom: "lights out" means off
  [/\blights? out\b/g, "lights off"],

  // verb+particle pairs (EN synonyms not already accepted by patterns)
  [/\b(?:switch|shut|power)\s+(?:off|down)\b/g, "turn off"],
  [/\bswitch on\b/g, "turn on"],
  [/\bfire up\b/g, "turn on"],
  [/\bpower up\b/g, "turn on"],

  // French / Spanish action verbs
  [/\ballum(?:e|er|ez|es)\b/g, "turn on"],
  [/\benciend(?:e|er|o)\b|\bprends?\b/g, "turn on"],
  [/\b(?:eteins|eteindre|apaga|apagar)\b/g, "turn off"],
  [/\barrete(r)?\b|\bdetene(r)?\b/g, "stop"],
  [/\bannul(?:e|er)\b|\bcancela(r)?\b/g, "cancel"],
  [/\bouvre\b|\bouvrir\b|\babre(r)?\b/g, "open"],
  [/\bferme\b|\bfermer\b|\bcierra(r)?\b/g, "close"],
  [/\bquitte\b|\bquitter\b/g, "quit"],
  [/\bretrécis\b|\bretrécir\b|\bminimiza(r)?\b/g, "minimize"],
  [/\bmata\b/g, "kill"],
  [/\bexécute\b|\bexécuter\b|\bejecuta(r)?\b/g, "run"],
  [/\befface\b|\beffacer\b/g, "clear"],
  [/\bmet(?:s|tre)?\b|\bpon\b|\bponer\b/g, "set"],
  [/\bborra(r)?\b/g, "erase"],

  // dictation prefixes
  [/\bécris\b|\becris\b|\bdicte\b/g, "prompt"],
  [/\benvoie\b|\benvoyer\b/g, "send"],

  // settings / session helpers
  [/\bparamètres\b|\bréglages\b|\breglages\b/g, "settings"],
  [/\bnouvelle\b|\bnueva\b/g, "new"],

  // devices (singular/plural kept distinct)
  [/\blumieres\b|\bluces\b/g, "lights"],
  [/\blumiere\b|\bluz\b/g, "light"],
  [/\blampes\b/g, "lamps"],
  [/\blampe\b/g, "lamp"],
  [/\bbombillas?\b/g, "bulbs"],

  // colors → canonical English
  [/\brouges?\b|\brojas?\b|\brojos?\b/g, "red"],
  [/\bjaunes?\b|\bamarill[oa]s?\b/g, "yellow"],
  [/\bvertes?\b|\bverdes?\b/g, "green"],
  [/\bbleues?\b|\bbleus?\b|\bazules?\b/g, "blue"],
  [/\bviolettes?\b|\bmorad[oa]s?\b/g, "violet"],
  [/\bpourpres?\b/g, "purple"],
  [/\broses?\b|\brosas?\b/g, "pink"],
  [/\bmarrones?\b/g, "brown"],
  [/\bturquesas?\b/g, "turquoise"],
  [/\baguamarinas?\b/g, "aqua"],
  [/\blilas?\b/g, "lavender"],
  [/\bcitron vert\b|\blima\b/g, "lime"],
  [/\bbleu marine\b|\bazul marino\b/g, "navy"],
  [/\bdorees?\b|\bdores\b/g, "gold"],

  // white-balance tones
  [/\bchaudes?\b|\bchauds?\b/g, "warm"],
  [/\bfraiches?\b|\bfroids?\b|\bfrias?\b|\bfrios?\b|\bfrescas?\b/g, "cool"],
  [/\bneutres?\b|\bneutros?\b/g, "neutral"],
  [/\blumiere du jour\b|\bluz del dia\b/g, "daylight"],

  // spoken numbers for brightness (word map is EN-only)
  [/\bvingt\b|\bveinte\b/g, "twenty"],
  [/\btrente\b|\btreinta\b/g, "thirty"],
  [/\bquarante\b|\bcuarenta\b/g, "forty"],
  [/\bcinquante\b|\bcincuenta\b/g, "fifty"],
  [/\bsoixante\b|\bsesenta\b/g, "sixty"],
  [/\bseptante\b|\bsetenta\b/g, "seventy"],
  [/\bochenta\b/g, "eighty"],
  [/\bnoventa\b/g, "ninety"],
  [/\bcent\b|\bcien\b/g, "hundred"],
  [/\bdemi\b|\bmitad\b/g, "half"],

  // French/Spanish possessive noun phrase: "lampe du bureau" → "bureau lampe"
  // so the device word lands where the pattern expects it. Applied before
  // articles/devices so later rules see the swapped order.
  [/\b([a-z]+) (?:du|des|de la|de los|de las|del) ([a-z]+)\b/g, "$2 $1"],
  [/\b(?:la|les|el|los|las)\b/g, "the"],
  [/\ble\b(?= )/g, "the"],
  [/\b(?:ma|mon|mes|mi|mis)\b/g, "my"],

  // mic check as a whole phrase
  [/\btu m'entends\b|\bm'entends-tu\b|\bme escuchas\b/g, "can you hear me"],
];

// polite wrappers stripped before matching
const LEAD =
  /^(?:est-ce que |peux-tu |pourrais-tu |pouvons-nous |can you |could you |would you |podrias |puedes )+/;
const TAIL =
  /\s+(?:please|thanks|thank you|merci|gracias|s'il te plait|s'il vous plait|stp)+$/;

export function expandVoice(t: string): string {
  let prev = deaccent(t).replace(LEAD, "");
  while (TAIL.test(prev)) prev = prev.replace(TAIL, "");
  for (const [re, to] of RULES) prev = prev.replace(re, to);
  return prev.replace(/\s+/g, " ").trim();
}

// gentle typo tolerance for whisper noise ("lihgts"): content words only —
// never action verbs, so a misheard verb can't fire anything. One edit =
// substitution OR adjacent transposition (naive Hamming calls a swap 2).
const LEX = [
  "light", "lights", "lamp", "lamps", "bulb", "bulbs",
  "warm", "cool", "neutral", "daylight",
  "red", "orange", "yellow", "green", "cyan", "blue",
  "violet", "purple", "magenta", "pink",
  "crimson", "salmon", "coral", "gold", "lime", "olive",
  "brown", "teal", "turquoise", "aqua", "azure", "indigo",
  "navy", "lavender", "maroon",
];

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

export function fixTypos(t: string): string {
  return t
    .split(" ")
    .map((w) => {
      if (w.length < 4 || LEX.includes(w)) return w;
      const hit = LEX.find((k) => oneEdit(w, k));
      return hit ?? w;
    })
    .join(" ");
}
