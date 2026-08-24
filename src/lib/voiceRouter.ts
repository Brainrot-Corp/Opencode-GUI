// spoken-phrase router: maps a whisper transcript to a UI action, or returns
// null when the text is freeform dictation (lands in the composer instead).
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
  | { type: "hearCheck" };

export type VoiceCtx = {
  themes: string[];
  commands: string[];
};

function normalize(t: string): string {
  return t
    .toLowerCase()
    .replace(/[.,!?;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function routeVoice(text: string, ctx: VoiceCtx): VoiceAct | null {
  const t = normalize(text);
  if (!t) return null;

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
  if (/^(envoi|envoie|envoyer|envoyez|envoyé)$/.test(t)) return { type: "send" };
  if (/^(be quiet|stop speaking|stop talking)$/.test(t)) return { type: "quiet" };
  if (/^(shut|shut up|tais-toi|chut)$/.test(t)) return { type: "shut" };
  if (/^(debrief|de brief|fais[ -]?moi un debrief|give me a debrief|what did we change|what did we do|summary of changes)$/.test(t))
    return { type: "debrief" };
  if (/^(erase|clear)( the | )?(input|composer|text|prompt)$/.test(t)) return { type: "clear" };
  if (/^(can|do)( you)? hear me$/.test(t)) return { type: "hearCheck" };

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

  // "theme latte" / "switch to the strawberry theme"
  const themeM = /^(?:theme|switch to(?: the)? theme) (\w+)$/.exec(t) ?? /^switch to (?:the )?(\w+)(?: theme)?$/.exec(t);
  if (themeM && ctx.themes.includes(themeM[1])) return { type: "theme", arg: themeM[1] };
  if (/^(dark|light) theme$/.test(t)) return { type: "mode", arg: t.split(" ")[0] as "dark" | "light" };

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
