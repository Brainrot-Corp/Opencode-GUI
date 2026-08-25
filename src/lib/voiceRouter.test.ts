// runnable self-check: node src/lib/voiceRouter.test.ts
import { routeVoice } from "./voiceRouter.ts";

const ctx = { themes: ["cyan", "latte", "matcha", "strawberry"], commands: ["help", "init", "compact", "fix-all"] };
let n = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

eq(routeVoice("New session.", ctx), { type: "newSession" }, "new session");
eq(routeVoice("start a new chat", ctx), { type: "newSession" }, "new chat");
eq(routeVoice("STOP", ctx), { type: "abort" }, "stop");
eq(routeVoice("cancel that", ctx), { type: "abort" }, "cancel that");
eq(routeVoice("dark mode", ctx), { type: "mode", arg: "dark" }, "dark mode");
eq(routeVoice("light.", ctx), { type: "mode", arg: "light" }, "light");
eq(routeVoice("theme latte", ctx), { type: "theme", arg: "latte" }, "theme by id");
eq(routeVoice("switch to the strawberry theme", ctx), { type: "theme", arg: "strawberry" }, "theme long form");
eq(routeVoice("theme nope", ctx), null, "unknown theme falls through to dictation");
eq(routeVoice("open settings", ctx), { type: "settings", open: true }, "open settings");
eq(routeVoice("hide the sidebar", ctx), { type: "sidebar", open: false }, "hide sidebar");
eq(routeVoice("cycle agent", ctx), { type: "cycleAgent" }, "cycle agent");
eq(routeVoice("send it", ctx), { type: "send" }, "send it");
eq(routeVoice("Envoyé.", ctx), { type: "send" }, "envoyé");
eq(routeVoice("envoie", ctx), { type: "send" }, "envoie");
eq(routeVoice("envoyez", ctx), { type: "send" }, "envoyez");
eq(
  routeVoice("je vais l'envoyer demain", ctx),
  { type: "embedded", act: { type: "dictateSend", arg: "demain" } },
  "fr send inside a sentence → embedded (confirmation gates it)",
);
eq(routeVoice("clear composer", ctx), { type: "clear" }, "clear");
eq(routeVoice("clear prompt", ctx), { type: "clear" }, "clear prompt");
eq(routeVoice("erase the prompt", ctx), { type: "clear" }, "erase the prompt");
eq(routeVoice("can you hear me?", ctx), { type: "hearCheck" }, "hear check");
eq(routeVoice("do you hear me", ctx), { type: "hearCheck" }, "hear check do");
eq(routeVoice("be quiet", ctx), { type: "quiet" }, "quiet");
eq(routeVoice("run compact", ctx), { type: "runCmd", arg: "compact", rest: "" }, "run cmd");
eq(routeVoice("run fix all now please", ctx), { type: "runCmd", arg: "fix-all", rest: "now" }, "multi-word cmd + args (politeness stripped)");
eq(routeVoice("run does-not-exist", ctx), null, "unknown run falls through");
eq(routeVoice("launch google chrome", ctx), { type: "launchApp", arg: "google chrome" }, "launch app");
eq(routeVoice("open the spotify", ctx), { type: "launchApp", arg: "spotify" }, "article stripped");
eq(routeVoice("close google chrome", ctx), { type: "closeApp", arg: "google chrome" }, "close app");
eq(routeVoice("quit the spotify", ctx), { type: "closeApp", arg: "spotify" }, "quit app");
eq(routeVoice("minimize the calculator", ctx), { type: "minimizeApp", arg: "calculator" }, "minimize app");
eq(routeVoice("kill chrome", ctx), { type: "killApp", arg: "chrome" }, "kill app");
eq(routeVoice("close settings", ctx), { type: "settings", open: false }, "close settings beats app close");
eq(routeVoice("start visual studio code", ctx), { type: "launchApp", arg: "visual studio code" }, "multi-word phrase kept whole");
eq(routeVoice("open settings", ctx), { type: "settings", open: true }, "open settings beats app launch");
eq(routeVoice("run compact", ctx), { type: "runCmd", arg: "compact", rest: "" }, "run cmd beats app launch");
eq(routeVoice("hello world this is dictation", ctx), null, "freeform dictation");

// capture prefixes — command-first voice: unprefixed speech routes nowhere
eq(routeVoice("prompt hello world", ctx), { type: "dictate", arg: "hello world" }, "prompt prefix fills composer");
eq(routeVoice("Prompt the quick brown fox.", ctx), { type: "dictate", arg: "the quick brown fox" }, "prompt prefix strips punctuation");
eq(routeVoice("send hello world", ctx), { type: "dictateSend", arg: "hello world" }, "send prefix fills + sends");
eq(routeVoice("send it", ctx), { type: "send" }, "bare send still wins over prefix");
eq(routeVoice("send the prompt", ctx), { type: "send" }, "bare send-the-prompt form kept");

// embedded scan — commands buried in conversation come back wrapped for
// spoken confirmation; direct hits stay unwrapped
eq(
  routeVoice("and then send hello world", ctx),
  { type: "embedded", act: { type: "dictateSend", arg: "hello world" } },
  "embedded send prefix",
);
eq(
  routeVoice("oh and prompt write tests please", ctx),
  { type: "embedded", act: { type: "dictate", arg: "write tests" } },
  "embedded prompt prefix (politeness stripped)",
);
eq(routeVoice("est-ce que tu m'entends", ctx), { type: "hearCheck" }, "fr mic check");
eq(routeVoice("prompt write a haiku about rain", ctx), { type: "dictate", arg: "write a haiku about rain" }, "prefix unaffected by lexicon");
eq(routeVoice("", ctx), null, "empty");
eq(routeVoice("please refactor src/main.rs carefully", ctx), null, "prompt-looking text stays freeform");

eq(
  routeVoice("makes no sense. Send, can you add more colors to the voice commands?", ctx),
  {
    type: "embedded",
    act: { type: "dictateSend", arg: "can you add more colors to the voice commands" },
  },
  "comma after send still captures fill-and-send",
);
eq(routeVoice("send, hello there", ctx), { type: "dictateSend", arg: "hello there" }, "direct comma form");
eq(routeVoice("theme strawberry", ctx), { type: "theme", arg: "strawberry" }, "theme by name");
eq(routeVoice("team strawberry", ctx), { type: "theme", arg: "strawberry" }, "accent 'team' folds to theme");
eq(routeVoice("switch to the team latte", ctx), { type: "theme", arg: "latte" }, "accent fold mid-phrase");
eq(routeVoice("our team is great", ctx), null, "'team' outside a theme phrase stays dictation");
eq(routeVoice("teme strawberry", ctx), { type: "theme", arg: "strawberry" }, "one-edit typo on any vocab word");
eq(routeVoice("pusg it", ctx), { type: "git", act: "push" }, "typo-corrected trigger fires");
eq(routeVoice("run compac", ctx), { type: "runCmd", arg: "compact", rest: "" }, "typo in command name");

// git stage all — whisper mishears ("hall") and spoken quotes must not kill it
eq(routeVoice("git stage hall", ctx), { type: "git", act: "stageAll" }, "misheard 'all' repaired");
eq(
  routeVoice('and in the end, i can say "git stage hall"', ctx),
  { type: "embedded", act: { type: "git", act: "stageAll" } },
  "quoted mid-sentence stage-all; 'git' never mangles into 'quit'",
);
eq(routeVoice('"new session"', ctx), { type: "newSession" }, "spoken quotes stripped");
eq(
  routeVoice("there is a bit of a guide stage hall.", ctx),
  { type: "embedded", act: { type: "git", act: "stageAll" } },
  "'guide' mishears to 'quit' but the later specific intent wins over the catch-all",
);
eq(
  routeVoice("yeah anyway close spotify", ctx),
  { type: "embedded", act: { type: "closeApp", arg: "spotify" } },
  "catch-all app verbs still work when nothing specific matches",
);
eq(routeVoice("comit it", ctx), { type: "git", act: "commit" }, "phonetic: comit → commit");
eq(routeVoice("prompt comit this later", ctx), { type: "dictate", arg: "comit this later" }, "phonetics never touch dictated payloads");
eq(routeVoice("Tim, Saiyan.", ctx), { type: "theme", arg: "cyan" }, "accented 'theme cyan' via phonetics");
eq(routeVoice("tim sayen", ctx), { type: "theme", arg: "cyan" }, "same, no punctuation");
eq(
  routeVoice("stop and think about it", ctx),
  { type: "embedded", act: { type: "abort" }, fuzzy: true },
  "bare trigger before conjunction still confirms, never silent-fires",
);

// plugin plumbing — extension acts wrap with their id; device verbs are inert
// without a plugin providing them (light coverage lives next to the plugin)
const pext = {
  id: "fake",
  parse: (t: string) => {
    const m = /^(?:turn |switch |shut )?(?:the )?lights? (on|off)$/.exec(t);
    return m ? { sw: m[1] } : null;
  },
  triggers: ["turn"],
  vocab: ["lights"],
};
const ctxP = { ...ctx, exts: [pext] };
eq(routeVoice("turn the lights off", ctxP), { type: "plugin", plugin: "fake", act: { sw: "off" } }, "plugin act wrapped");
eq(routeVoice("lihgts on", ctxP), { type: "plugin", plugin: "fake", act: { sw: "on" } }, "ext vocab feeds typo correction");
eq(
  routeVoice("yeah anyway turn the lights off", ctxP),
  { type: "embedded", act: { type: "plugin", plugin: "fake", act: { sw: "off" } } },
  "embedded plugin command",
);
eq(routeVoice("turn the lights off", ctx), null, "device verbs inert without a plugin");
eq(routeVoice("lights on", ctx), null, "no plugin installed → dictation");
eq(
  routeVoice("and then switch to latte", ctx),
  { type: "embedded", act: { type: "theme", arg: "latte" } },
  "built-in verbs kept out of the plugin slice still scan",
);

console.log(`voiceRouter: ${n} checks passed`);
