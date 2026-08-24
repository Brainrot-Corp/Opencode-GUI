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
eq(routeVoice("be quiet", ctx), { type: "quiet" }, "quiet");
eq(routeVoice("run compact", ctx), { type: "runCmd", arg: "compact", rest: "" }, "run cmd");
eq(routeVoice("run fix all now please", ctx), { type: "runCmd", arg: "fix-all", rest: "now please" }, "multi-word cmd + args");
eq(routeVoice("run does-not-exist", ctx), null, "unknown run falls through");
eq(routeVoice("hello world this is dictation", ctx), null, "freeform dictation");
eq(routeVoice("", ctx), null, "empty");
eq(routeVoice("please refactor src/main.rs carefully", ctx), null, "prompt-looking text stays freeform");

console.log(`voiceRouter: ${n} checks passed`);
