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
  | { type: "dictate"; arg: string }
  | { type: "dictateSend"; arg: string }
  // matched by a plugin — dispatched through the plugin registry
  | { type: "plugin"; plugin: string; act: unknown }
  // command found buried mid-sentence — needs spoken confirmation before exec
  | { type: "embedded"; act: VoiceAct; fuzzy?: boolean };

// what a plugin contributes to the router (structural slice of PluginExt)
export type RouterExt = {
  id: string;
  parse?: (t: string) => unknown | null;
  triggers?: string[];
  vocab?: string[];
  requiresConfirmation?: boolean | ((act: unknown) => boolean);
};

export type VoiceCtx = {
  themes: string[];
  commands: string[];
  exts?: RouterExt[];
};

// everything a spoken word may be typo-corrected against — the router's own
// vocabulary plus whatever is live at call time (theme names, slash commands,
// plugin vocab)
function vocabOf(ctx: VoiceCtx): string[] {
  return [
    ...TRIGGERS.split("|"),
    "dark", "light", "mode", "theme", "session", "chat",
    "sidebar", "settings", "agent", "debrief", "percent",
    // "all" repairs whisper's "hall"/"tall" mishear of "stage all"; "git"
    // needs no protection anymore — real dictionary words are never
    // phonetic-repaired (see voiceLexicon)
    "all",
    ...ctx.themes,
    ...ctx.commands.flatMap((c) => c.split("-")),
    ...(ctx.exts ?? []).flatMap((e) => e.vocab ?? []),
  ];
}

function normalize(t: string): string {
  return t
    .toLowerCase()
    // spoken quotes are never meaningful — whisper wraps phrases ("git stage
    // all") in them and every pattern is $-anchored. Apostrophes stay: FR
    // elision rules need them ("m'entends")
    .replace(/["“”«»„]/g, "")
    .replace(/[.,!?;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// verbs that can head a command — scanned for mid-sentence ("yeah anyway
// turn the lights off"). Curated: every hit becomes a spoken confirmation,
// but chatty verbs still waste a question, so nothing vague is listed.
// Built-in verbs only — plugins add their own (device-control verbs like
// "turn"/"dim" arrive via ext.triggers).
const TRIGGERS =
  "switch|shut|launch|start|open|show|hide|close|quit|minimize|kill|run|execute|slash|theme|cycle|next|new|stop|abort|cancel|clear|erase|send|submit|prompt|commit|push|pull|stage";

// trigger vocabulary live at call time: base + plugin-contributed verbs
function triggersOf(ctx: VoiceCtx): string {
  return [TRIGGERS, ...(ctx.exts ?? []).flatMap((e) => e.triggers ?? [])].join("|");
}

// one full pass of the matcher chain — routeVoice runs this on the whole
// transcript first, then on trigger-word tails when scanning. With
// catchAlls=false the two greedy app-verb patterns are skipped (used by the
// mid-sentence scan's specific-first tier)
function matchChain(t: string, ctx: VoiceCtx, catchAlls = true): VoiceAct | null {
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

  // plugin intents — same slot device integrations used: after specific UI/git
  // matches, before the app-launcher catch-all so plugin device names win
  for (const e of ctx.exts ?? []) {
    const a = e.parse?.(t);
    if (a) return { type: "plugin", plugin: e.id, act: a };
  }

  // "close google chrome" / "minimize the calculator" / "quit spotify" /
  // "kill chrome" — placed before the launcher catch-all; "close settings"
  // already matched above as a settings action. Catch-all: any tail after
  // the verb matches, so chatter misheard into one of these verbs must
  // never outrank a specific intent found later (scan's tier order)
  const appAct = /^(close|quit|minimize|kill)(?: (?:the|my))? (.+)$/.exec(t);
  if (catchAlls && appAct) {
    const verb = appAct[1];
    if (verb === "minimize") return { type: "minimizeApp", arg: appAct[2] };
    if (verb === "kill") return { type: "killApp", arg: appAct[2] };
    return { type: "closeApp", arg: appAct[2] };
  }

  // "launch google chrome" / "open the spotify" — app finder; placed last so
  // the specific intents above ("open settings", "start a new session") win
  const appM = /^(?:launch|open|start)(?: (?:the|my))? (.+)$/.exec(t);
  if (catchAlls && appM) return { type: "launchApp", arg: appM[1] };

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
  const TRIG = triggersOf(ctx);
  const re = new RegExp(`\\b(?:${TRIG})\\b`, "g");
  let m: RegExpExecArray | null;
  const scan = (src: string, catchAlls: boolean): VoiceAct | null => {
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      const act = matchChain(src.slice(m.index), ctx, catchAlls);
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
      const act = matchChain(frag.slice(0, cm.index).trim(), ctx, catchAlls);
      if (act) return { type: "embedded", act, fuzzy: true };
    }
    return null;
  };

  // the untouched text is scanned FIRST — corrections are only a fallback,
  // so they can never leak into dictated payloads ("prompt write tests"
  // keeps "write"; only utterances the raw text can't match get repaired)
  //
  // specific intents win over catch-all app verbs regardless of position:
  // chatter misheard into "quit"/"close" ("a bit of a guide stage hall")
  // must not hijack the fragment before the real command later in the
  // sentence — tier 1 ignores the app-verb catch-alls, tier 2 allows them
  const hit =
    scan(t, false) ??
    (fixed !== t ? matchChain(fixed, ctx, false) ?? scan(fixed, false) : null);
  if (hit) return hit;
  return scan(t, true) ??
    (fixed !== t ? matchChain(fixed, ctx) ?? scan(fixed, true) : null);
}
