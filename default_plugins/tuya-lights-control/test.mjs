// runnable self-check: node default_plugins/tuya-lights-control/test.mjs
// Exercises the plugin's voice layer through the real router (with the
// lexicon registered) plus the DP-code value mappers.
import { routeVoice, routerInput } from "../../src/lib/voiceRouter.ts";
import { setPluginLexicon } from "../../src/lib/voiceLexicon.ts";
import { ensureDict } from "../../src/lib/dictWords.ts";
import {
  parseVoice, describeLight, brightVal, tempVal, colorData,
  TRIGGERS, VOCAB, LEXICON,
} from "./main.js";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

setPluginLexicon(LEXICON);
// warm the dictionary so the phonetic-repair veto is active for these checks
await ensureDict();

const ext = { id: "tuya-lights-control", parse: parseVoice, triggers: TRIGGERS, vocab: VOCAB };
const ctx = {
  themes: ["cyan", "latte", "matcha", "strawberry"],
  commands: ["help", "init", "compact", "fix-all"],
  exts: [ext],
};
const P = (act) => ({ type: "plugin", plugin: "tuya-lights-control", act });

let n = 0;
function eq(actual, expected, label) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

// embedded scan — commands buried in conversation come back wrapped for
// spoken confirmation; direct hits stay unwrapped
eq(
  routeVoice("yeah anyway turn the lights off", ctx),
  { type: "embedded", act: P({ type: "light", sw: "off", name: "" }) },
  "embedded light command",
);
eq(
  routeVoice("stop the music and turn the lights off", ctx),
  { type: "embedded", act: P({ type: "light", sw: "off", name: "" }) },
  "earliest trigger whose tail fails is skipped",
);
eq(
  routeVoice("turn the lights off when you leave", ctx),
  { type: "embedded", act: P({ type: "light", sw: "off", name: "" }), fuzzy: true },
  "conditional tail → fuzzy confirmed, not silent",
);
eq(routeVoice("we turned the lights off yesterday", ctx), null, "past tense is not a trigger");
eq(routeVoice("turn the bedroom lamp off.", ctx), P({ type: "light", sw: "off", name: "bedroom" }), "direct hit stays unwrapped");
eq(
  routeVoice("and it should not break anything. Like, if right now I want to turn the lights off and then speak after", ctx),
  { type: "embedded", act: P({ type: "light", sw: "off", name: "" }), fuzzy: true },
  "trailing clause → fuzzy confirmed match",
);
eq(
  routeVoice("turn the lights on and off again", ctx),
  { type: "embedded", act: P({ type: "light", sw: "on", name: "" }), fuzzy: true },
  "ambiguous head still just asks — never silent-fires",
);

// Non-English phrasing (allume la lumière, luz roja, éteins la lampe du
// bureau…) is covered live: unmatched transcripts get a second whisper pass
// with --translate and re-route on the English output — not reproducible in
// node without the whisper engine.

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

// intents — on/off
eq(routeVoice("lights on", ctx), P({ type: "light", sw: "on", name: "" }), "bare lights on");
eq(routeVoice("lights off", ctx), P({ type: "light", sw: "off", name: "" }), "bare lights off");
eq(routeVoice("turn the desk lamp off", ctx), P({ type: "light", sw: "off", name: "desk" }), "device then switch");
eq(routeVoice("turn on the bedroom lights", ctx), P({ type: "light", sw: "on", name: "bedroom" }), "switch before device");
eq(routeVoice("switch bedroom lights off", ctx), P({ type: "light", sw: "off", name: "bedroom" }), "switch mid phrase");
eq(routeVoice("lamp on.", ctx), P({ type: "light", sw: "on", name: "" }), "punctuation stripped");

// intents — brightness
eq(routeVoice("dim the desk lamp to 50 percent", ctx), P({ type: "lightBright", pct: 50, name: "desk" }), "dim named device");
eq(routeVoice("dim the lights to fifty percent", ctx), P({ type: "lightBright", pct: 50, name: "" }), "word number");
eq(routeVoice("brighten the light to 100", ctx), P({ type: "lightBright", pct: 100, name: "" }), "no unit word");
eq(routeVoice("set the desk lamp to 75%", ctx), P({ type: "lightBright", pct: 75, name: "desk" }), "percent sign");
eq(routeVoice("dim the lights to zero percent", ctx), null, "0% rejected — falls through");

// intents — tone & color
eq(routeVoice("make the desk lamp warm", ctx), P({ type: "lightTemp", tone: "warm", name: "desk" }), "warm tone");
eq(routeVoice("make the light cool white", ctx), P({ type: "lightTemp", tone: "cool", name: "" }), "cool white");
eq(routeVoice("turn the light red", ctx), P({ type: "lightColor", color: "red", name: "" }), "color");
eq(routeVoice("change the bedroom lights to blue", ctx), P({ type: "lightColor", color: "blue", name: "bedroom" }), "change to color");
eq(routeVoice("turn the lights teal", ctx), P({ type: "lightColor", color: "teal", name: "" }), "extended palette");
eq(routeVoice("lights lavender", ctx), P({ type: "lightColor", color: "lavender", name: "" }), "bare extended color");
eq(routeVoice("lights purpul", ctx), P({ type: "lightColor", color: "purple", name: "" }), "phonetic: purpul → purple");

// precedence & near-misses
eq(routeVoice("open settings", ctx), { type: "settings", open: true }, "settings still beats light intents");
eq(routeVoice("make it warm in here", ctx), null, "sentence stays dictation");

// spoken read-back used by the yes/no confirmation flow
eq(describeLight({ type: "light", sw: "off", name: "" }), "Turn the lights off", "describe switch");
eq(describeLight({ type: "lightBright", pct: 40, name: "desk" }), "Set desk to 40% brightness", "describe bright");
eq(describeLight({ type: "lightTemp", tone: "warm", name: "" }), "Set the lights to warm white", "describe tone");
eq(describeLight({ type: "lightColor", color: "red", name: "" }), "Make the lights red", "describe color");
eq(describeLight({ type: "mystery" }), "", "unknown act describes empty");

// brightness: % → dp range (v2: 10..1000, v1: 25..255), clamped at both ends
eq(brightVal(50, true), 500, "v2 mid");
eq(brightVal(100, true), 1000, "v2 max");
eq(brightVal(1, true), 10, "v2 floor");
eq(brightVal(150, false), 255, "v1 clamp high");
eq(brightVal(0, false), 25, "v1 clamp low");

// temperature: warmth presets, v1 scaled down
eq(tempVal("warm", true), 880, "warm v2");
eq(tempVal("cool", true), 60, "cool v2");
eq(tempVal("warm", false), Math.round(880 * 0.255), "warm v1");
eq(tempVal("nonsense", true), 480, "unknown tone → neutral");

// colour_data packing: hex by default, JSON string when the device reports one
eq(colorData("red", true), "000003e803e8", "red v2 hex");
eq(colorData("blue", true), "00f003e803e8", "blue v2 hex");
eq(colorData("green", false), "007800ff00ff", "green v1 hex");
eq(
  colorData("blue", true, '{"h":16,"s":1000,"v":1000}'),
  '{"h":240,"s":1000,"v":1000}',
  "json-reporting device gets json back",
);

// mock localStorage so Settings renders expanded
if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = { getItem: (k) => k === "oc.settings.lights.collapsed" ? "0" : null, setItem: () => {}, removeItem: () => {} };
} else {
  const _get = globalThis.localStorage.getItem?.bind(globalThis.localStorage);
  globalThis.localStorage.getItem = (k) => k === "oc.settings.lights.collapsed" ? "0" : (_get ? _get(k) : null);
}
if (typeof globalThis.window === "undefined") globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
// settings panel renders through the host's h() contract
const api = {
  id: "tuya-lights-control",
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
for (const probe of ["sound-box-head", "tuya-in", "Find bulbs", "not configured", "Europe"]) {
  n++;
  if (!html.includes(probe)) throw new Error(`FAIL settings render: missing "${probe}"`);
}

// Info-dialog documentation rows ship with the extension
n++;
if (!plugin.info?.voice?.length || plugin.info.voice[0][0] !== "lights on / lights off")
  throw new Error("FAIL info: missing voice documentation rows");

console.log(`tuya-lights-control: ${n} checks passed`);
