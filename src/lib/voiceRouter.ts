// spoken-phrase router: maps a whisper transcript to a UI action, or returns
// null when the text is freeform dictation (lands in the composer instead).
import { expandVoice, fixTypos } from "./voiceLexicon.ts";

export type VoiceAct =
  | { type: "newSession" }
  | { type: "abort" }
  | { type: "theme"; arg: string }
  | { type: "mode"; arg: "dark" | "light" }
  | { type: "settings"; open: boolean }
  | { type: "sidebar"; open?: boolean }
  | { type: "cycleAgent" }
  | { type: "runCmd"; arg: string; rest: string }
  | { type: "launchApp"; arg: string }
  | { type: "closeApp"; arg: string }
  | { type: "minimizeApp"; arg: string }
  | { type: "killApp"; arg: string }
  | { type: "send" }
  | { type: "clear" }
  | { type: "quiet" }
  | { type: "shut" }
  | { type: "debrief" }
  | { type: "hearCheck" }
  | { type: "git"; act: "open" | "commit" | "push" | "pull" | "stageAll" }
  | { type: "light"; sw: "on" | "off"; name: string }
  | { type: "lightBright"; pct: number; name: string }
  | { type: "lightTemp"; tone: string; name: string }
  | { type: "lightColor"; color: string; name: string }
  | { type: "dictate"; arg: string }
  | { type: "dictateSend"; arg: string }
  // command found buried mid-sentence — needs spoken confirmation before exec
  | { type: "embedded"; act: VoiceAct; fuzzy?: boolean };

export type VoiceCtx = {
  themes: string[];
  commands: string[];
};

// spoken numbers whisper sometimes writes out — digits stay the common case
const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
  ninety: 90, hundred: 100, half: 50, quarter: 25,
};

function pct(w: string): number | null {
  if (/^\d+$/.test(w)) {
    const n = parseInt(w, 10);
    return n >= 1 && n <= 100 ? n : null;
  }
  return WORD_NUM[w.toLowerCase()] ?? null;
}

// device word shared by every light intent
const DEV = "(?:lights?|lamps?|bulbs?)";
const COLORS =
  "red|orange|yellow|green|cyan|blue|purple|violet|magenta|pink" +
  "|crimson|salmon|coral|gold|lime|olive|brown|teal|turquoise|aqua|azure|indigo|navy|lavender|maroon";
const TONES = "warm|cool|neutral|daylight";

// everything a spoken word may be typo-corrected against — the router's own
// vocabulary plus whatever is live at call time (theme names, slash commands)
function vocabOf(ctx: VoiceCtx): string[] {
  return [
    ...TRIGGERS.split("|"),
    "light", "lights", "lamp", "lamps", "bulb", "bulbs",
    "on", "off", "white", "warm", "cool", "neutral", "daylight",
    "dark", "light", "mode", "theme", "session", "chat",
    "sidebar", "settings", "agent", "debrief", "percent",
    ...COLORS.split("|"),
    ...ctx.themes,
    ...ctx.commands.flatMap((c) => c.split("-")),
  ];
}

function normalize(t: string): string {
  return t
    .toLowerCase()
    .replace(/[.,!?;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// verbs that can head a command — scanned for mid-sentence ("yeah anyway
// turn the lights off"). Curated: every hit becomes a spoken confirmation,
// but chatty verbs still waste a question, so nothing vague is listed.
const TRIGGERS =
  "turn|switch|shut|dim|brighten|set|make|change|color|launch|start|open|show|hide|close|quit|minimize|kill|run|execute|slash|theme|cycle|next|new|stop|abort|cancel|clear|erase|send|submit|prompt|commit|push|pull|stage";

// one full pass of the matcher chain — routeVoice runs this on the whole
// transcript first, then on trigger-word tails when scanning
function matchChain(t: string, ctx: VoiceCtx): VoiceAct | null {
  if (/^(new|start)( a)?( new)? (session|chat)$/.test(t)) return { type: "newSession" };
  if (/^(stop|abort|cancel)( that| it| generation| running)?$/.test(t)) return { type: "abort" };
  if (/^(dark|light)( mode)?$/.test(t)) return { type: "mode", arg: t.startsWith("dark") ? "dark" : "light" };
  if (/^(open|show)( the)? settings$|^settings$/.test(t)) return { type: "settings", open: true };
  if (/^(close|hide)( the)? settings$/.test(t)) return { type: "settings", open: false };
  if (/^toggle( the)? sidebar$/.test(t)) return { type: "sidebar" };
  if (/^show( the)? sidebar$/.test(t)) return { type: "sidebar", open: true };
  if (/^hide( the)? sidebar$/.test(t)) return { type: "sidebar", open: false };
  if (/^(cycle|next) agent$/.test(t)) return { type: "cycleAgent" };
  if (/^(send|submit)( it| that| this| the prompt| message)?$/.test(t)) return { type: "send" };
  // capture prefixes — everything after the word is dictation for the
  // composer ("prompt …") or fill-and-send ("send …"); bare forms above win.
  // Punctuation right after the verb is tolerated ("send, can you …")
  const dm = /^prompt[,.!?;:]* (.+)$/.exec(t);
  if (dm) return { type: "dictate", arg: dm[1] };
  const dsm = /^send[,.!?;:]* (.+)$/.exec(t);
  if (dsm) return { type: "dictateSend", arg: dsm[1] };
  if (/^(envoi|envoie|envoyer|envoyez|envoyé|envoye)$/.test(t)) return { type: "send" };
  if (/^(be quiet|stop speaking|stop talking)$/.test(t)) return { type: "quiet" };
  if (/^(shut|shut up|tais-toi|chut)$/.test(t)) return { type: "shut" };
  if (/^(debrief|de brief|fais[ -]?moi un debrief|give me a debrief|what did we change|what did we do|summary of changes)$/.test(t))
    return { type: "debrief" };
  if (/^(erase|clear)( the | )?(input|composer|text|prompt)$/.test(t)) return { type: "clear" };
  if (/^(?:(?:can|do)(?: you)? )?hear me$/.test(t)) return { type: "hearCheck" };

  // git actions — before the app-launcher catch-all so bare "push"/"open git"
  // never become app lookups. Commit/push/pull are destructive enough that
  // mid-sentence hits already go through spoken confirmation.
  if (/^(?:git status|show(?: the)? git|open(?: the)? git)$/.test(t)) return { type: "git", act: "open" };
  if (/^(?:git )?commit(?: it| now)?$/.test(t)) return { type: "git", act: "commit" };
  if (/^(?:git )?push(?: it)?$/.test(t)) return { type: "git", act: "push" };
  if (/^(?:git )?pull(?: it| changes)?$/.test(t)) return { type: "git", act: "pull" };
  if (/^(?:git )?stage (?:all|everything)$/.test(t)) return { type: "git", act: "stageAll" };

  // light intents — before the app-launcher catch-all so device names win.
  // name group = up to 3 short words between the verb and the device word
  // ("desk lamp") — capped so long chatter can't be swallowed as a name
  const swA = new RegExp(`^(?:turn |switch |shut )?(?:the |my )?((?:[a-z]{1,12} ){0,3})?${DEV} (on|off)$`).exec(t);
  if (swA) return { type: "light", sw: swA[2] as "on" | "off", name: (swA[1] ?? "").trim() };
  const swB = /^(?:turn|switch|shut) (on|off)(?: the| my)?(?: ((?:[a-z]{1,12} ){0,3}[a-z]{1,12}))? (?:lights?|lamps?|bulbs?)$/.exec(t);
  if (swB) return { type: "light", sw: swB[1] as "on" | "off", name: (swB[2] ?? "").trim() };

  const num = "([\\w]+)";
  const PCT_TAIL = "(?: percent|%)?$";
  const brA = new RegExp(`^(?:dim|brighten)(?: the| my)? ?([a-z ]*?)?(?:${DEV}) to ${num}${PCT_TAIL}`).exec(t);
  if (brA) {
    const p = pct(brA[2]);
    if (p !== null) return { type: "lightBright", pct: p, name: (brA[1] ?? "").trim() };
  }
  const brB = new RegExp(`^set (?:the |my )?([a-z ]*?)?(?:${DEV}) to ${num}${PCT_TAIL}`).exec(t);
  if (brB) {
    const p = pct(brB[2]);
    if (p !== null) return { type: "lightBright", pct: p, name: (brB[1] ?? "").trim() };
  }

  const toneM = new RegExp(`^(?:make|set)(?: the| my)? ?([a-z ]*?)?(${DEV})(?: to)? (${TONES})(?: white)?$`).exec(t);
  if (toneM) return { type: "lightTemp", tone: toneM[3], name: (toneM[1] ?? "").trim() };
  const colM = new RegExp(`^(?:turn|make|set|change|color)(?: the| my)? ?([a-z ]*?)?(${DEV})(?: to)? (${COLORS})$`).exec(t);
  if (colM) return { type: "lightColor", color: colM[3], name: (colM[1] ?? "").trim() };

  // natural bare forms — "lights red", "light warm", "luz roja" (post-lexicon)
  const bareTone = new RegExp(`^(?:the )?(?:${DEV}) (${TONES})(?: white)?$`).exec(t);
  if (bareTone) return { type: "lightTemp", tone: bareTone[1], name: "" };
  const bareCol = new RegExp(`^(?:the )?(?:${DEV}) (${COLORS})$`).exec(t);
  if (bareCol) return { type: "lightColor", color: bareCol[1], name: "" };

  // "close google chrome" / "minimize the calculator" / "quit spotify" /
  // "kill chrome" — placed before the launcher catch-all; "close settings"
  // already matched above as a settings action
  const appAct = /^(close|quit|minimize|kill)(?: (?:the|my))? (.+)$/.exec(t);
  if (appAct) {
    const verb = appAct[1];
    if (verb === "minimize") return { type: "minimizeApp", arg: appAct[2] };
    if (verb === "kill") return { type: "killApp", arg: appAct[2] };
    return { type: "closeApp", arg: appAct[2] };
  }

  // "launch google chrome" / "open the spotify" — app finder; placed last so
  // the specific intents above ("open settings", "start a new session") win
  const appM = /^(?:launch|open|start)(?: (?:the|my))? (.+)$/.exec(t);
  if (appM) return { type: "launchApp", arg: appM[1] };

  // "theme latte" / "switch to the strawberry theme". Accents turn
  // "theme" into "team"/"tim" (folded locally, and the typo/phonetic pass
  // may hand us "theme," with glued punctuation) — dictation never sees it
  const tt = t.replace(/\bteams?\b/g, "theme");
  const themeM =
    /^(?:theme|switch to(?: the)? theme)[,.!?;:]* (\w+)$/.exec(tt) ??
    /^switch to (?:the )?(\w+)(?: theme)?$/.exec(tt);
  if (themeM && ctx.themes.includes(themeM[1])) return { type: "theme", arg: themeM[1] };
  if (/^(dark|light) theme$/.test(tt)) return { type: "mode", arg: t.split(" ")[0] as "dark" | "light" };

  // "run <command>" — resolve against the live command registry; multi-word
  // names are tried longest-first so "run fix all" finds "fix-all"
  const runM = /^(?:run|execute|slash) (.+)$/.exec(t);
  if (runM) {
    const words = runM[1].split(" ");
    for (let i = words.length; i >= 1; i--) {
      for (const joiner of ["-", ""]) {
        const cand = words.slice(0, i).join(joiner);
        if (ctx.commands.includes(cand))
          return { type: "runCmd", arg: cand, rest: words.slice(i).join(" ") };
      }
    }
  }
  return null;
}

// the exact text the matcher chain sees — post punctuation-strip, number
// fold and lexicon expansion. Exposed for the debug-transcript mode so the
// UI can show why a phrase did or didn't become a command.
export function routerInput(text: string): string {
  let t = normalize(text);
  // "one hundred percent" → "hundred percent" so the word map hits
  t = t.replace(/\b(?:one|a)\s+hundred\b/g, "hundred");
  // lexicon pass — natural / FR / ES phrasing → canonical English words
  return expandVoice(t);
}

export function routeVoice(text: string, ctx: VoiceCtx): VoiceAct | null {
  const t = routerInput(text);
  if (!t) return null;

  const direct = matchChain(t, ctx);
  if (direct) return direct;

  // gentle typo retry: any word within one edit of known vocabulary gets
  // corrected ("lihgts", "teme", "pusg")
  const fixed = fixTypos(t, vocabOf(ctx));

  // mid-sentence scan on the corrected text: a command buried in conversation
  // ("yeah anyway turn the lights off") is matched on the tail after each
  // trigger word and comes back wrapped for spoken confirmation. Suffix must
  // match to the END of the fragment — trailing clauses never fire.
  const re = new RegExp(`\\b(?:${TRIGGERS})\\b`, "g");
  let m: RegExpExecArray | null;
  const scan = (src: string): VoiceAct | null => {
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      const act = matchChain(src.slice(m.index), ctx);
      // a command heading the whole utterance is a plain direct hit;
      // anything buried after other words needs spoken confirmation
      if (act) return m.index === 0 ? act : { type: "embedded", act };
    }

    // fuzzy pass: a trailing clause after the command ("turn the lights off
    // and then speak after") is tolerated — the head up to the first clause
    // boundary must match exactly. Still wrapped for confirmation, and the
    // fuzzy flag stops the recent-command streak from skipping the read-back,
    // so a probable false positive can only ever fire after a spoken yes.
    const CUT = /,|\b(?:and|then|but|because|if|when|or|so|that|i)\b/;
    while ((m = re.exec(src))) {
      const frag = src.slice(m.index);
      const cm = CUT.exec(frag);
      if (!cm || cm.index === 0) continue;
      const act = matchChain(frag.slice(0, cm.index).trim(), ctx);
      if (act) return { type: "embedded", act, fuzzy: true };
    }
    return null;
  };

  // the untouched text is scanned FIRST — corrections are only a fallback,
  // so they can never leak into dictated payloads ("prompt write tests"
  // keeps "write"; only utterances the raw text can't match get repaired)
  const hit = scan(t);
  if (hit) return hit;
  if (fixed !== t) {
    const retry = matchChain(fixed, ctx);
    if (retry) return retry;
    return scan(fixed);
  }
  return null;
}
