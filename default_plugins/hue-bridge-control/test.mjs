// runnable self-check: node default_plugins/hue-bridge-control/test.mjs
// Exercises voice through real router + mappers.
import { routeVoice, routerInput } from "../../src/lib/voiceRouter.ts";
import { setPluginLexicon } from "../../src/lib/voiceLexicon.ts";
import { ensureDict } from "../../src/lib/dictWords.ts";
import {
  parseVoice, describeLight, describeRoom, describe, brightVal, ctVal, hueVal,
  parseHueSlashArgs,
  TRIGGERS, VOCAB, LEXICON,
} from "./main.js";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

setPluginLexicon(LEXICON);
await ensureDict();

const ext = { id: "hue-bridge-control", parse: parseVoice, triggers: TRIGGERS, vocab: VOCAB };
const ctx = {
  themes: ["cyan", "latte", "matcha", "strawberry"],
  commands: ["help", "init", "compact", "fix-all"],
  exts: [ext],
};
const P = (act) => ({ type: "plugin", plugin: "hue-bridge-control", act });

let n = 0;
function eq(actual, expected, label) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

// embedded scan
eq(
  routeVoice("yeah anyway turn the lights off", ctx),
  { type: "embedded", act: P({ type: "light", sw: "off", name: "" }) },
  "embedded light command",
);
eq(
  routeVoice("turn the lights off when you leave", ctx),
  { type: "embedded", act: P({ type: "light", sw: "off", name: "" }), fuzzy: true },
  "conditional tail → fuzzy confirmed, not silent",
);
eq(routeVoice("turn the bedroom lamp off.", ctx), P({ type: "light", sw: "off", name: "bedroom" }), "direct hit stays unwrapped");

// naturalness — fillers and whisper typos
eq(
  routeVoice("could you dim the lights to fifty percent please", ctx),
  P({ type: "lightBright", pct: 50, name: "" }),
  "politeness stripped both ends",
);
eq(
  routeVoice("turn on the lihgts", ctx),
  P({ type: "light", sw: "on", name: "" }),
  "typo tolerance fixes content words",
);

// intents — lights on/off
eq(routeVoice("lights on", ctx), P({ type: "light", sw: "on", name: "" }), "bare lights on");
eq(routeVoice("lights off", ctx), P({ type: "light", sw: "off", name: "" }), "bare lights off");
eq(routeVoice("turn the desk lamp off", ctx), P({ type: "light", sw: "off", name: "desk" }), "device then switch");
eq(routeVoice("turn on the bedroom lights", ctx), P({ type: "light", sw: "on", name: "bedroom" }), "switch before device");
eq(routeVoice("lamp on.", ctx), P({ type: "light", sw: "on", name: "" }), "punctuation stripped");

// brightness
eq(routeVoice("dim the desk lamp to 50 percent", ctx), P({ type: "lightBright", pct: 50, name: "desk" }), "dim named device");
eq(routeVoice("dim the lights to fifty percent", ctx), P({ type: "lightBright", pct: 50, name: "" }), "word number");
eq(routeVoice("brighten the light to 100", ctx), P({ type: "lightBright", pct: 100, name: "" }), "no unit word");
eq(routeVoice("set the desk lamp to 75%", ctx), P({ type: "lightBright", pct: 75, name: "desk" }), "percent sign");
eq(routeVoice("dim the lights to zero percent", ctx), null, "0% rejected for lights — falls through");

// tone & color (per-light)
eq(routeVoice("make the desk lamp warm", ctx), P({ type: "lightTemp", tone: "warm", name: "desk" }), "warm tone");
eq(routeVoice("make the light cool white", ctx), P({ type: "lightTemp", tone: "cool", name: "" }), "cool white");
eq(routeVoice("turn the light red", ctx), P({ type: "lightColor", color: "red", name: "" }), "color");
eq(routeVoice("change the bedroom lights to blue", ctx), P({ type: "lightColor", color: "blue", name: "bedroom" }), "change to color");
eq(routeVoice("turn the lights teal", ctx), P({ type: "lightColor", color: "teal", name: "" }), "extended palette");
eq(routeVoice("lights lavender", ctx), P({ type: "lightColor", color: "lavender", name: "" }), "bare extended color");
eq(routeVoice("lights purpul", ctx), P({ type: "lightColor", color: "purple", name: "" }), "phonetic: purpul → purple");

// ---- room intents ----
eq(routeVoice("living room off", ctx), P({ type: "room", sw: "off", name: "living" }), "room bare off (living)");
eq(routeVoice("turn the living room off", ctx), P({ type: "room", sw: "off", name: "living" }), "room turn off named");
eq(routeVoice("bedroom room on", ctx), P({ type: "room", sw: "on", name: "bedroom" }), "explicit room device");
eq(routeVoice("dim the bedroom room to 50 percent", ctx), P({ type: "roomBright", pct: 50, name: "bedroom" }), "room dim");
eq(routeVoice("set the living room to fifty percent", ctx), P({ type: "roomBright", pct: 50, name: "living" }), "room set word number");
eq(routeVoice("set bedroom room to 0 percent", ctx), P({ type: "roomBright", pct: 0, name: "bedroom" }), "room 0% allowed");
eq(routeVoice("make the living room warm", ctx), P({ type: "roomTemp", tone: "warm", name: "living" }), "room warm tone");
eq(routeVoice("turn the bedroom room blue", ctx), P({ type: "roomColor", color: "blue", name: "bedroom" }), "room color");
eq(routeVoice("kitchen room blue", ctx), P({ type: "roomColor", color: "blue", name: "kitchen" }), "room bare color");

// precedence & near-misses
eq(routeVoice("open settings", ctx), { type: "settings", open: true }, "settings still beats hue intents");
eq(routeVoice("make it warm in here", ctx), null, "sentence stays dictation");

// spoken read-back
eq(describeLight({ type: "light", sw: "off", name: "" }), "Turn the lights off", "describe switch");
eq(describeLight({ type: "lightBright", pct: 40, name: "desk" }), "Set desk to 40% brightness", "describe bright");
eq(describeLight({ type: "lightTemp", tone: "warm", name: "" }), "Set the lights to warm white", "describe tone");
eq(describeLight({ type: "lightColor", color: "red", name: "" }), "Make the lights red", "describe color");
eq(describeLight({ type: "mystery" }), "", "unknown act describes empty");
eq(describeRoom({ type: "room", sw: "off", name: "living" }), "Turn living off", "describe room off");
eq(describeRoom({ type: "roomBright", pct: 40, name: "bedroom" }), "Set bedroom to 40% brightness", "describe room bright");
eq(describeRoom({ type: "roomColor", color: "blue", name: "bedroom" }), "Make bedroom blue", "describe room color");
eq(describe({ type: "room", sw: "on", name: "" }), "Turn the room on", "describe unified room");
eq(describe({ type: "light", sw: "on", name: "" }), "Turn the lights on", "describe unified light");

// brightness: % → Hue bri 1..254
eq(brightVal(50), 127, "bri mid");
eq(brightVal(100), 254, "bri max");
eq(brightVal(1), 3, "bri low");
eq(brightVal(0), 1, "bri clamp low");
eq(brightVal(150), 254, "bri clamp high");

// ct: warmth presets
eq(ctVal("warm"), 454, "warm ct");
eq(ctVal("cool"), 153, "cool ct");
eq(ctVal("neutral"), 333, "neutral ct");
eq(ctVal("daylight"), 250, "daylight ct");
eq(ctVal("nonsense"), 333, "unknown tone → neutral");

// hue: hex-ish packing — just hue degrees mapped to 0..65535
eq(hueVal("red"), 0, "red hue");
eq(hueVal("blue"), 43690, "blue hue");
eq(hueVal("green"), 21845, "green hue");

// slash parsing — hue
eq(parseHueSlashArgs("on"), { type: "light", sw: "on", name: "" }, "slash hue on bare");
eq(parseHueSlashArgs("off bedroom"), { type: "light", sw: "off", name: "bedroom" }, "slash hue off named");
eq(parseHueSlashArgs("50"), { type: "lightBright", pct: 50, name: "" }, "slash hue 50 bare");
eq(parseHueSlashArgs("blue bedroom"), { type: "lightColor", color: "blue", name: "bedroom" }, "slash hue blue named");
eq(parseHueSlashArgs("warm"), { type: "lightTemp", tone: "warm", name: "" }, "slash hue warm");
eq(parseHueSlashArgs("warm living room"), { type: "lightTemp", tone: "warm", name: "living room" }, "slash hue warm with room name");
eq(parseHueSlashArgs(""), null, "slash hue empty -> null");
// direct voice phrase via slash
eq(parseHueSlashArgs("turn the bedroom lights off"), { type: "light", sw: "off", name: "bedroom" }, "slash hue full phrase");

// mock localStorage so Settings renders expanded
if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = { getItem: (k) => k === "oc.settings.hue.collapsed" ? "0" : null, setItem: () => {}, removeItem: () => {} };
} else {
  const _get = globalThis.localStorage.getItem?.bind(globalThis.localStorage);
  globalThis.localStorage.getItem = (k) => k === "oc.settings.hue.collapsed" ? "0" : (_get ? _get(k) : null);
}
if (typeof globalThis.window === "undefined") globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
// settings panel renders through the host's h() contract
const api = {
  id: "hue-bridge-control",
  invoke: async () => {
    throw new Error("no network in tests");
  },
  h,
  useState: (await import("react")).useState,
  useEffect: (await import("react")).useEffect,
  useRef: (await import("react")).useRef,
  settings: () => ({}),
};
const { default: activate } = await import("./main.js");
const plugin = activate(api);
const html = renderToString(
  h(plugin.Settings, { open: true, settings: {}, updatePlugin: () => {} }),
);
for (const probe of ["sound-box-head", "hue-in", "Discover", "Pair", "Find lights", "not configured", "Bridge IP"]) {
  n++;
  if (!html.includes(probe)) throw new Error(`FAIL settings render: missing "${probe}"`);
}

// Info-dialog documentation rows ship with the extension
n++;
if (!plugin.info?.voice?.length || plugin.info.voice[0][0] !== "lights on / lights off")
  throw new Error("FAIL info: missing voice documentation rows");
n++;
if (!plugin.slash || plugin.slash.length < 4) throw new Error("FAIL slash: missing slash commands");
n++;
if (!plugin.slash.find(s => s.name === "hue")) throw new Error("FAIL slash: missing hue");
n++;
if (!plugin.slash.find(s => s.name === "hue-discover")) throw new Error("FAIL slash: missing hue-discover");
n++;
if (!plugin.slash.find(s => s.name === "hue-pair")) throw new Error("FAIL slash: missing hue-pair");
n++;
if (!plugin.slash.find(s => s.name === "hue-on")) throw new Error("FAIL slash: missing hue-on");

console.log(`hue-bridge-control: ${n} checks passed`);
