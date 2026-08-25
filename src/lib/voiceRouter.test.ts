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
eq(routeVoice("je vais l'envoyer demain", ctx), null, "envoyer inside a sentence stays dictation");
eq(routeVoice("clear composer", ctx), { type: "clear" }, "clear");
eq(routeVoice("clear prompt", ctx), { type: "clear" }, "clear prompt");
eq(routeVoice("erase the prompt", ctx), { type: "clear" }, "erase the prompt");
eq(routeVoice("can you hear me?", ctx), { type: "hearCheck" }, "hear check");
eq(routeVoice("do you hear me", ctx), { type: "hearCheck" }, "hear check do");
eq(routeVoice("be quiet", ctx), { type: "quiet" }, "quiet");
eq(routeVoice("run compact", ctx), { type: "runCmd", arg: "compact", rest: "" }, "run cmd");
eq(routeVoice("run fix all now please", ctx), { type: "runCmd", arg: "fix-all", rest: "now please" }, "multi-word cmd + args");
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
eq(routeVoice("make it warm in here", ctx), null, "sentence stays dictation");
eq(routeVoice("open settings", ctx), { type: "settings", open: true }, "settings still beats light intents");

console.log(`voiceRouter: ${n} checks passed`);
