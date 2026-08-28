// runnable self-check: node default_plugins/tuya-curtains-control/test.mjs
import { routeVoice, routerInput } from "../../src/lib/voiceRouter.ts";
import { setPluginLexicon } from "../../src/lib/voiceLexicon.ts";
import { ensureDict } from "../../src/lib/dictWords.ts";
import {
  parseVoice, describeCurtain, parseSlashArgs,
  TRIGGERS, VOCAB, LEXICON,
} from "./main.js";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

setPluginLexicon(LEXICON);
await ensureDict();

const ext = { id: "tuya-curtains-control", parse: parseVoice, triggers: TRIGGERS, vocab: VOCAB };
const ctx = {
  themes: ["cyan", "latte", "matcha", "strawberry"],
  commands: ["help", "init", "compact", "fix-all"],
  exts: [ext],
};
const P = (act) => ({ type: "plugin", plugin: "tuya-curtains-control", act });

let n = 0;
function eq(actual, expected, label) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

// embedded scan
eq(
  routeVoice("yeah anyway open the curtains", ctx),
  { type: "embedded", act: P({ type: "curtain", sw: "open", name: "" }) },
  "embedded open",
);
eq(routeVoice("open the curtains", ctx), P({ type: "curtain", sw: "open", name: "" }), "bare open");
eq(routeVoice("close the curtains", ctx), P({ type: "curtain", sw: "close", name: "" }), "bare close");
eq(routeVoice("stop the curtains", ctx), P({ type: "curtain", sw: "stop", name: "" }), "bare stop");
eq(routeVoice("open the bedroom curtains", ctx), P({ type: "curtain", sw: "open", name: "bedroom" }), "open named");
eq(routeVoice("curtains open", ctx), P({ type: "curtain", sw: "open", name: "" }), "device then verb");
eq(routeVoice("bedroom curtains close", ctx), P({ type: "curtain", sw: "close", name: "bedroom" }), "name then close");
eq(routeVoice("close the bedroom blinds", ctx), P({ type: "curtain", sw: "close", name: "bedroom" }), "blinds synonym");
eq(routeVoice("open the blinds", ctx), P({ type: "curtain", sw: "open", name: "" }), "blinds bare");
eq(routeVoice("pause the curtains", ctx), P({ type: "curtain", sw: "stop", name: "" }), "pause maps to stop");

// percent
eq(routeVoice("set curtains to 50 percent", ctx), P({ type: "curtainPos", pct: 50, name: "" }), "set 50%");
eq(routeVoice("set the bedroom curtains to fifty percent", ctx), P({ type: "curtainPos", pct: 50, name: "bedroom" }), "word number half");
eq(routeVoice("set curtains to 0 percent", ctx), P({ type: "curtainPos", pct: 0, name: "" }), "0% allowed (closed)");
eq(routeVoice("set blinds to 100", ctx), P({ type: "curtainPos", pct: 100, name: "" }), "100 no unit");
eq(routeVoice("curtains fifty percent", ctx), P({ type: "curtainPos", pct: 50, name: "" }), "bare percent");
eq(routeVoice("bedroom curtains 75 percent", ctx), P({ type: "curtainPos", pct: 75, name: "bedroom" }), "named bare percent");
eq(routeVoice("curtains half", ctx), P({ type: "curtainPos", pct: 50, name: "" }), "half -> 50");
eq(routeVoice("blinds up", ctx), P({ type: "curtain", sw: "open", name: "" }), "lexicon blinds up");
eq(routeVoice("blinds down", ctx), P({ type: "curtain", sw: "close", name: "" }), "lexicon blinds down");

// typo tolerance
eq(routeVoice("set the curtians to 50 percent", ctx), P({ type: "curtainPos", pct: 50, name: "" }), "typo curtians -> curtains via set");

// describe
eq(describeCurtain({ type: "curtain", sw: "open", name: "" }), "Open the curtains", "describe open");
eq(describeCurtain({ type: "curtain", sw: "stop", name: "bedroom" }), "Stop bedroom", "describe stop named");
eq(describeCurtain({ type: "curtainPos", pct: 40, name: "bedroom" }), "Set bedroom to 40%", "describe pos");
eq(describeCurtain({ type: "mystery" }), "", "unknown describes empty");

// slash parsing
eq(parseSlashArgs("open"), { type: "curtain", sw: "open", name: "" }, "slash open bare");
eq(parseSlashArgs("close bedroom"), { type: "curtain", sw: "close", name: "bedroom" }, "slash close named");
eq(parseSlashArgs("50"), { type: "curtainPos", pct: 50, name: "" }, "slash 50 bare");
eq(parseSlashArgs("50 bedroom"), { type: "curtainPos", pct: 50, name: "bedroom" }, "slash 50 named");
eq(parseSlashArgs("open bedroom curtains"), { type: "curtain", sw: "open", name: "bedroom" }, "slash voice fallback");
eq(parseSlashArgs(""), null, "slash empty -> null");

// mock localStorage so Settings renders expanded
if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = { getItem: (k) => k === "oc.settings.curtains.collapsed" ? "0" : null, setItem: () => {}, removeItem: () => {} };
} else {
  const _get = globalThis.localStorage.getItem?.bind(globalThis.localStorage);
  globalThis.localStorage.getItem = (k) => k === "oc.settings.curtains.collapsed" ? "0" : (_get ? _get(k) : null);
}
if (typeof globalThis.window === "undefined") globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
// settings panel renders
const api = {
  id: "tuya-curtains-control",
  invoke: async () => { throw new Error("no network in tests"); },
  h,
  useState: (await import("react")).useState,
  useEffect: (await import("react")).useEffect,
  useRef: (await import("react")).useRef,
  settings: () => ({}),
  playSound: () => {},
};
const { default: activate } = await import("./main.js");
const plugin = activate(api);
const html = renderToString(
  h(plugin.Settings, { open: true, settings: {}, updatePlugin: () => {} }),
);
for (const probe of ["sound-box-head", "tuya-in", "Find curtains", "not configured", "Europe"]) {
  n++;
  if (!html.includes(probe)) throw new Error(`FAIL settings render: missing "${probe}"`);
}
n++;
if (!plugin.info?.voice?.length || plugin.info.voice[0][0] !== "curtains open / curtains close / curtains stop")
  throw new Error("FAIL info: missing voice rows");
n++;
if (!plugin.slash || plugin.slash.length < 1) throw new Error("FAIL slash: missing slash commands");
n++;
if (plugin.slash[0].name !== "curtains") throw new Error("FAIL slash: first should be curtains");

console.log(`tuya-curtains-control: ${n} checks passed`);
