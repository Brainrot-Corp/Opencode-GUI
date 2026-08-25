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
  routeVoice("yeah anyway turn the lights off", ctx),
  { type: "embedded", act: { type: "light", sw: "off", name: "" } },
  "embedded light command",
);
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
eq(
  routeVoice("stop the music and turn the lights off", ctx),
  { type: "embedded", act: { type: "light", sw: "off", name: "" } },
  "earliest trigger whose tail fails is skipped",
);
eq(
  routeVoice("turn the lights off when you leave", ctx),
  { type: "embedded", act: { type: "light", sw: "off", name: "" }, fuzzy: true },
  "conditional tail → fuzzy confirmed, not silent",
);
eq(routeVoice("we turned the lights off yesterday", ctx), null, "past tense is not a trigger");
eq(routeVoice("turn the bedroom lamp off.", ctx), { type: "light", sw: "off", name: "bedroom" }, "direct hit stays unwrapped");

// lexicon — French / Spanish rewrites land on the same canonical patterns
eq(routeVoice("allume la lumière", ctx), { type: "light", sw: "on", name: "" }, "fr turn on the light");
eq(routeVoice("éteins la lampe du bureau", ctx), { type: "light", sw: "off", name: "bureau" }, "fr possessive swap keeps device last");
eq(routeVoice("enciende las luces", ctx), { type: "light", sw: "on", name: "" }, "es turn on the lights");
eq(routeVoice("met la lumière rouge", ctx), { type: "lightColor", color: "red", name: "" }, "fr set the light red");
eq(routeVoice("luz roja", ctx), { type: "lightColor", color: "red", name: "" }, "es bare device+color");
eq(routeVoice("lumiere rouge", ctx), { type: "lightColor", color: "red", name: "" }, "fr bare device+color");

// naturalness — fillers and whisper typos
eq(
  routeVoice("could you dim the lights to fifty percent please", ctx),
  { type: "lightBright", pct: 50, name: "" },
  "politeness stripped both ends",
);
eq(
  routeVoice("turn on the lihgts", ctx),
  { type: "light", sw: "on", name: "" },
  "typo tolerance fixes content words",
);
eq(routeVoice("est-ce que tu m'entends", ctx), { type: "hearCheck" }, "fr mic check");
eq(routeVoice("prompt write a haiku about rain", ctx), { type: "dictate", arg: "write a haiku about rain" }, "prefix unaffected by lexicon");
eq(routeVoice("", ctx), null, "empty");
eq(routeVoice("please refactor src/main.rs carefully", ctx), null, "prompt-looking text stays freeform");

// light intents
eq(routeVoice("lights on", ctx), { type: "light", sw: "on", name: "" }, "bare lights on");
eq(routeVoice("lights off", ctx), { type: "light", sw: "off", name: "" }, "bare lights off");
eq(routeVoice("turn the desk lamp off", ctx), { type: "light", sw: "off", name: "desk" }, "device then switch");
eq(routeVoice("turn on the bedroom lights", ctx), { type: "light", sw: "on", name: "bedroom" }, "switch before device");
eq(routeVoice("switch bedroom lights off", ctx), { type: "light", sw: "off", name: "bedroom" }, "switch mid phrase");
eq(routeVoice("lamp on.", ctx), { type: "light", sw: "on", name: "" }, "punctuation stripped");

eq(routeVoice("dim the desk lamp to 50 percent", ctx), { type: "lightBright", pct: 50, name: "desk" }, "dim named device");
eq(routeVoice("dim the lights to fifty percent", ctx), { type: "lightBright", pct: 50, name: "" }, "word number");
eq(routeVoice("brighten the light to 100", ctx), { type: "lightBright", pct: 100, name: "" }, "no unit word");
eq(routeVoice("set the desk lamp to 75%", ctx), { type: "lightBright", pct: 75, name: "desk" }, "percent sign");
eq(routeVoice("dim the lights to zero percent", ctx), null, "0% rejected — falls through");

eq(routeVoice("make the desk lamp warm", ctx), { type: "lightTemp", tone: "warm", name: "desk" }, "warm tone");
eq(routeVoice("make the light cool white", ctx), { type: "lightTemp", tone: "cool", name: "" }, "cool white");
eq(routeVoice("turn the light red", ctx), { type: "lightColor", color: "red", name: "" }, "color");
eq(routeVoice("change the bedroom lights to blue", ctx), { type: "lightColor", color: "blue", name: "bedroom" }, "change to color");
eq(routeVoice("turn the lights teal", ctx), { type: "lightColor", color: "teal", name: "" }, "extended palette");
eq(routeVoice("lights lavender", ctx), { type: "lightColor", color: "lavender", name: "" }, "bare extended color");
eq(routeVoice("luz turquesa", ctx), { type: "lightColor", color: "turquoise", name: "" }, "es extended color");
eq(
  routeVoice("makes no sense. Send, can you add more colors to the voice commands?", ctx),
  {
    type: "embedded",
    act: { type: "dictateSend", arg: "can you add more colors to the voice commands" },
  },
  "comma after send still captures fill-and-send",
);
eq(routeVoice("send, hello there", ctx), { type: "dictateSend", arg: "hello there" }, "direct comma form");
eq(
  routeVoice("and it should not break anything. Like, if right now I want to turn the lights off and then speak after", ctx),
  { type: "embedded", act: { type: "light", sw: "off", name: "" }, fuzzy: true },
  "trailing clause → fuzzy confirmed match",
);
eq(
  routeVoice("stop and think about it", ctx),
  { type: "embedded", act: { type: "abort" }, fuzzy: true },
  "bare trigger before conjunction still confirms, never silent-fires",
);
eq(
  routeVoice("turn the lights on and off again", ctx),
  { type: "embedded", act: { type: "light", sw: "on", name: "" }, fuzzy: true },
  "ambiguous head still just asks — never silent-fires",
);
eq(routeVoice("make it warm in here", ctx), null, "sentence stays dictation");
eq(routeVoice("open settings", ctx), { type: "settings", open: true }, "settings still beats light intents");

console.log(`voiceRouter: ${n} checks passed`);
