// Hue Bridge — opencode-gui plugin (plain browser ESM).
//
// One bridge, lights + rooms, per-light color, auto-discovery, voice + /hue slash.
// Local Hue REST API (CLIP v1) over http://<bridge>/api — pairing needs the
// link button. Transport goes through the host's http_json command (private
// http allowed in lib.rs). Discovery hits https://discovery.meethue.com/.
//
// Install: copy this folder to ~/.config/.opencode-gui/plugins/ and restart
// the app (plugins hot-reload). Enter Bridge IP (Discover) + press link
// button → Pair → Test in Settings › Hue.

const ID = "hue-bridge-control";

// ---------------------------------------------------------------------------
// voice layer — pure functions, node-testable without activation
// ---------------------------------------------------------------------------

const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, half: 50, quarter: 25,
};

function pctVal(w) {
  if (/^\d+$/.test(w)) {
    const n = parseInt(w, 10);
    return n >= 0 && n <= 100 ? n : null;
  }
  return WORD_NUM[w.toLowerCase()] ?? null;
}
function pctLight(w) {
  const p = pctVal(w);
  return p === null || p === 0 ? null : p;
}
function pctRoom(w) {
  return pctVal(w);
}

const DEV_LIGHT = "(?:lights?|lamps?|bulbs?)";
const DEV_ROOM = "(?:rooms?|zones?|groups?)";

export const COLORS =
  "red|orange|yellow|green|cyan|blue|purple|violet|magenta|pink" +
  "|crimson|salmon|coral|gold|lime|olive|brown|teal|turquoise|aqua|azure|indigo|navy|lavender|maroon";
export const TONES = "warm|cool|neutral|daylight";

// light intent — same regexes as tuya v2 so voice tests stay familiar
function parseLight(t) {
  const swA = new RegExp(
    `^(?:turn |switch |shut )?(?:the |my )?((?:[a-z]{1,12} ){0,3})?${DEV_LIGHT} (on|off)$`,
  ).exec(t);
  if (swA) return { type: "light", sw: swA[2], name: (swA[1] ?? "").trim() };
  const swB =
    /^(?:turn|switch|shut) (on|off)(?: the| my)?(?: ((?:[a-z]{1,12} ){0,3}[a-z]{1,12}))? (?:lights?|lamps?|bulbs?)$/.exec(t);
  if (swB) return { type: "light", sw: swB[1], name: (swB[2] ?? "").trim() };

  const num = "([\\w]+)";
  const PCT_TAIL = "(?: percent|%)?$";
  const brA = new RegExp(
    `^(?:dim|brighten)(?: the| my)? ?([a-z ]*?)?(?:${DEV_LIGHT}) to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (brA) {
    const p = pctLight(brA[2]);
    if (p !== null) return { type: "lightBright", pct: p, name: (brA[1] ?? "").trim() };
  }
  const brB = new RegExp(
    `^set (?:the |my )?([a-z ]*?)?(?:${DEV_LIGHT}) to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (brB) {
    const p = pctLight(brB[2]);
    if (p !== null) return { type: "lightBright", pct: p, name: (brB[1] ?? "").trim() };
  }

  const toneM = new RegExp(
    `^(?:make|set)(?: the| my)? ?([a-z ]*?)?(${DEV_LIGHT})(?: to)? (${TONES})(?: white)?$`,
  ).exec(t);
  if (toneM) return { type: "lightTemp", tone: toneM[3], name: (toneM[1] ?? "").trim() };
  const colM = new RegExp(
    `^(?:turn|make|set|change|color)(?: the| my)? ?([a-z ]*?)?(${DEV_LIGHT})(?: to)? (${COLORS})$`,
  ).exec(t);
  if (colM) return { type: "lightColor", color: colM[3], name: (colM[1] ?? "").trim() };

  const bareTone = new RegExp(`^(?:the )?(?:${DEV_LIGHT}) (${TONES})(?: white)?$`).exec(t);
  if (bareTone) return { type: "lightTemp", tone: bareTone[1], name: "" };
  const bareCol = new RegExp(`^(?:the )?(?:${DEV_LIGHT}) (${COLORS})$`).exec(t);
  if (bareCol) return { type: "lightColor", color: bareCol[1], name: "" };

  return null;
}

function parseRoom(t) {
  // rooms mirror lights but with DEV_ROOM so "living room off" / "kitchen zone on" work
  const swA = new RegExp(
    `^(?:turn |switch |shut )?(?:the |my )?((?:[a-z]{1,12} ){0,3})?${DEV_ROOM} (on|off)$`,
  ).exec(t);
  if (swA) return { type: "room", sw: swA[2], name: (swA[1] ?? "").trim() };
  const swB = new RegExp(
    `^(?:turn|switch|shut) (on|off)(?: the| my)?(?: ((?:[a-z]{1,12} ){0,3}[a-z]{1,12}))? ${DEV_ROOM}$`,
  ).exec(t);
  if (swB) return { type: "room", sw: swB[1], name: (swB[2] ?? "").trim() };

  const num = "([\\w]+)";
  const PCT_TAIL = "(?: percent|%)?$";
  const brA = new RegExp(
    `^(?:dim|brighten)(?: the| my)? ?([a-z ]*?)?(?:${DEV_ROOM}) to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (brA) {
    const p = pctRoom(brA[2]);
    if (p !== null) return { type: "roomBright", pct: p, name: (brA[1] ?? "").trim() };
  }
  const brB = new RegExp(
    `^set (?:the |my )?([a-z ]*?)?(?:${DEV_ROOM}) to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (brB) {
    const p = pctRoom(brB[2]);
    if (p !== null) return { type: "roomBright", pct: p, name: (brB[1] ?? "").trim() };
  }
  const toneM = new RegExp(
    `^(?:make|set)(?: the| my)? ?([a-z ]*?)?(${DEV_ROOM})(?: to)? (${TONES})(?: white)?$`,
  ).exec(t);
  if (toneM) return { type: "roomTemp", tone: toneM[3], name: (toneM[1] ?? "").trim() };
  const colM = new RegExp(
    `^(?:turn|make|set|change|color)(?: the| my)? ?([a-z ]*?)?(${DEV_ROOM})(?: to)? (${COLORS})$`,
  ).exec(t);
  if (colM) return { type: "roomColor", color: colM[3], name: (colM[1] ?? "").trim() };

  const bareTone = new RegExp(`^(?:the )?([a-z ]*?)?(?:${DEV_ROOM}) (${TONES})(?: white)?$`).exec(t);
  if (bareTone) return { type: "roomTemp", tone: bareTone[2], name: (bareTone[1] ?? "").trim() };
  const bareCol = new RegExp(`^(?:the )?([a-z ]*?)?(?:${DEV_ROOM}) (${COLORS})$`).exec(t);
  if (bareCol) return { type: "roomColor", color: bareCol[2], name: (bareCol[1] ?? "").trim() };

  // fallback: bare room name without explicit device word
  // e.g. "turn the living room off", "dim bedroom to 50%", "make kitchen blue"
  // This is intentionally after device-specific checks to avoid stealing light intents.
  const swC = /^(?:turn |switch |shut )?(?:the |my )?(.+?) (on|off)$/.exec(t);
  if (swC && swC[1].trim().split(/\s+/).length <= 4) {
    // Only treat as room if the fragment looks like a room-ish name, not a light device.
    // We check that the tail before on/off does NOT end with a light word — those were already matched.
    const raw = swC[1].trim();
    if (!new RegExp(`^(.+ )${DEV_LIGHT}$`).test(swC[1].trim() + " lights")) {
      // Heuristic: if raw contains "room" or is 1-2 words, assume room candidate; exec will validate against actual room list.
      // Still return so executor can do fallback matching (room vs light).
      if (/\broom\b|\bzone\b|\bgroup\b/.test(raw) || raw.split(/\s+/).length <= 3) {
        return { type: "room", sw: swC[2], name: raw.replace(new RegExp(`\\s*${DEV_ROOM}\\s*$`), "").trim() };
      }
    }
  }
  return null;
}

export function parseVoice(t) {
  return parseLight(t) ?? parseRoom(t);
}

// spoken read-back for embedded-command confirmation
export function describeLight(a) {
  switch (a.type) {
    case "light":
      return `Turn ${a.name || "the lights"} ${a.sw}`;
    case "lightBright":
      return `Set ${a.name || "the lights"} to ${a.pct}% brightness`;
    case "lightTemp":
      return `Set ${a.name || "the lights"} to ${a.tone} white`;
    case "lightColor":
      return `Make ${a.name || "the lights"} ${a.color}`;
    default:
      return "";
  }
}
export function describeRoom(a) {
  switch (a.type) {
    case "room":
      return `Turn ${a.name || "the room"} ${a.sw}`;
    case "roomBright":
      return `Set ${a.name || "the room"} to ${a.pct}% brightness`;
    case "roomTemp":
      return `Set ${a.name || "the room"} to ${a.tone} white`;
    case "roomColor":
      return `Make ${a.name || "the room"} ${a.color}`;
    default:
      return "";
  }
}
export function describe(a) {
  return describeLight(a) || describeRoom(a);
}

export const TRIGGERS = ["turn", "dim", "brighten", "set", "make", "change", "color", "eteins", "eteindre", "allume", "allumer", "ouvre", "ouvrir", "ferme", "fermer"];

export const VOCAB = [
  ...TRIGGERS,
  "light", "lights", "lamp", "lamps", "bulb", "bulbs",
  "room", "rooms", "zone", "zones", "group", "groups",
  "on", "off", "white", "percent", "half", "quarter",
  ...TONES.split("|"),
  ...COLORS.split("|"),
  // French device vocab — helps one-edit / metaphone repair on French transcripts
  "lumiere", "lumieres", "lampe", "lampes", "rideau", "rideaux", "store", "stores", "volet", "volets",
];

export const LEXICON = [
  [/\blights? out\b/g, "lights off"],
  [/\b(?:switch|shut|power)\s+(?:off|down)\b/g, "turn off"],
  [/\bswitch on\b/g, "turn on"],
  [/\bfire up\b/g, "turn on"],
  [/\bpower up\b/g, "turn on"],
  // French — lights / rooms (end-anchored; applied after deaccent so use
  // unaccented forms; plugin host merges all lexicons after core FR)
  [/\b(?:eteins?|eteint|eteindre|coupe?)\s+(?:les?|des|ma|mon|la)?\s*(?:lumieres?|lampes?|lampe)s?$/g, "turn off the lights"],
  [/\ballume(?:r|z)?\s+(?:les?|des|ma|mon|la)?\s*(?:lumieres?|lampes?|lampe)s?$/g, "turn on the lights"],
  [/\bouvre(?:r|z)?\s+(?:les?|des|ma|mon|la)?\s*(?:rideaux?|stores?|volets?|tentures?)s?$/g, "open the curtains"],
  [/\b(?:ferme|fermer)\s+(?:les?|des|ma|mon|la)?\s*(?:rideaux?|stores?|volets?|tentures?)s?$/g, "close the curtains"],
];

// ---------------------------------------------------------------------------
// value mapping — Hue REST (CLIP v1) payloads
// ---------------------------------------------------------------------------

const HUE_DEG = {
  red: 0, salmon: 6, coral: 16, brown: 20, orange: 30, gold: 45, yellow: 60,
  olive: 80, lime: 90, green: 120, turquoise: 174, teal: 175, cyan: 180,
  aqua: 180, azure: 210, blue: 240, navy: 240, indigo: 255, lavender: 270,
  purple: 280, violet: 280, magenta: 320, pink: 330, crimson: 348, maroon: 350,
};
const TEMP_CT = { cool: 153, daylight: 250, neutral: 333, warm: 454 };

export function brightVal(pctNum) {
  return Math.max(1, Math.min(254, Math.round((Math.max(0, Math.min(100, pctNum)) / 100) * 254)));
}
export function ctVal(tone) {
  return TEMP_CT[tone] ?? 333;
}
export function hueVal(word) {
  const deg = HUE_DEG[word] ?? 0;
  return Math.max(0, Math.min(65535, Math.round((deg / 360) * 65535)));
}
export function satVal() { return 254; }

// ---------------------------------------------------------------------------
// transport + executor (needs an activated api)
// ---------------------------------------------------------------------------

function baseUrl(ip) {
  return `http://${ip.replace(/\/+$/, "")}`;
}

async function httpGet(api, url) {
  const r = await api.invoke("http_json", { method: "GET", url, headers: {}, body: null });
  if (r.status < 200 || r.status >= 300) throw new Error(`http ${r.status}: ${String(r.body).slice(0, 200)}`);
  try { return JSON.parse(r.body); } catch { return r.body; }
}
async function httpPost(api, url, body) {
  const r = await api.invoke("http_json", { method: "POST", url, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status < 200 || r.status >= 300) throw new Error(`http ${r.status}: ${String(r.body).slice(0, 200)}`);
  try { return JSON.parse(r.body); } catch { return r.body; }
}
async function httpPut(api, url, body) {
  const r = await api.invoke("http_json", { method: "PUT", url, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status < 200 || r.status >= 300) throw new Error(`http ${r.status}: ${String(r.body).slice(0, 200)}`);
  try { return JSON.parse(r.body); } catch { return r.body; }
}

export async function discoverBridges(api) {
  const r = await api.invoke("http_json", { method: "GET", url: "https://discovery.meethue.com/", headers: {}, body: null });
  if (r.status < 200 || r.status >= 300) throw new Error(`discovery ${r.status}: ${String(r.body).slice(0, 200)}`);
  let arr;
  try { arr = JSON.parse(r.body); } catch { throw new Error("bad discovery json"); }
  if (!Array.isArray(arr)) throw new Error("bad discovery response");
  return arr.map((e) => ({ ip: e.internalipaddress, id: e.id, name: e.name || "" })).filter((e) => e.ip);
}

export async function pairBridge(api, ip) {
  const url = `${baseUrl(ip)}/api`;
  const body = { devicetype: `opencode_gui#${(typeof navigator !== "undefined" && navigator.userAgent ? "opencode_guy" : "opencode_gui").slice(0, 20)}` };
  const r = await api.invoke("http_json", { method: "POST", url, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status < 200 || r.status >= 300) throw new Error(`pair ${r.status}: ${String(r.body).slice(0, 200)}`);
  let arr;
  try { arr = JSON.parse(r.body); } catch { throw new Error("bad pair response: " + String(r.body).slice(0, 200)); }
  if (!Array.isArray(arr) || !arr[0]) throw new Error("bad pair response");
  const entry = arr[0];
  if (entry.error) {
    if (entry.error.type === 101) throw new Error("press the link button on the Hue Bridge, then try Pair again");
    throw new Error(`pair error ${entry.error.type}: ${entry.error.description || ""}`);
  }
  if (entry.success && entry.success.username) return entry.success.username;
  throw new Error("pair failed: " + String(r.body).slice(0, 200));
}

export function confReady(c) {
  return !!(c.bridgeIp && c.username);
}

let cache = null;
export function clearHueCache() { cache = null; }

async function getAll(api, c) {
  if (cache && Date.now() - cache.at < 15000 && cache.ip === c.bridgeIp && cache.user === c.username) return cache;
  const ip = c.bridgeIp;
  const user = c.username;
  const lightsRaw = await httpGet(api, `${baseUrl(ip)}/api/${user}/lights`);
  const groupsRaw = await httpGet(api, `${baseUrl(ip)}/api/${user}/groups`);
  // Hue returns {} on auth error with no lights — detect unauthorized
  if (lightsRaw && typeof lightsRaw === "object" && !Array.isArray(lightsRaw) && lightsRaw[0] && lightsRaw[0].error) {
    const e = lightsRaw[0].error;
    if (e.type === 1) throw new Error("unauthorized — press Pair again (username invalid)");
    throw new Error(`hue error ${e.type}: ${e.description || ""}`);
  }
  const lights = [];
  if (lightsRaw && typeof lightsRaw === "object") {
    for (const [id, v] of Object.entries(lightsRaw)) {
      if (!v || typeof v !== "object") continue;
      lights.push({ id, name: v.name ?? "", type: v.type ?? "", modelid: v.modelid ?? "", state: v.state ?? {}, kind: "light" });
    }
  }
  const rooms = [];
  if (groupsRaw && typeof groupsRaw === "object" && !Array.isArray(groupsRaw)) {
    for (const [id, v] of Object.entries(groupsRaw)) {
      if (!v || typeof v !== "object") continue;
      // groups includes Room, Zone, LightGroup, Entertainment — keep Room for lite; also surface Zones
      const t = v.type ?? "";
      if (t !== "Room" && t !== "Zone") continue;
      rooms.push({ id, name: v.name ?? "", type: t, kind: "room", lights: Array.isArray(v.lights) ? v.lights : [], state: v.state ?? {}, action: v.action ?? {} });
    }
  }
  const next = { at: Date.now(), ip, user, lights, rooms };
  cache = next;
  return next;
}

async function lights(api, c) {
  const all = await getAll(api, c);
  return all.lights;
}
async function rooms(api, c) {
  const all = await getAll(api, c);
  return all.rooms;
}

function find(devs, frag) {
  const f = frag.trim().toLowerCase();
  if (!f) return devs;
  const sub = devs.filter((d) => d.name.toLowerCase().includes(f));
  if (sub.length) return sub;
  const toks = f.split(/\s+/).filter(Boolean);
  return devs.filter((d) => {
    const n = d.name.toLowerCase();
    return toks.some((t) => n.includes(t));
  });
}

export async function testCreds(api, c) {
  clearHueCache();
  const all = await getAll(api, c);
  return { lights: all.lights.map((d) => d.name), rooms: all.rooms.map((d) => d.name) };
}

function stateFor(act) {
  switch (act.type) {
    case "light":
    case "room":
      return { on: act.sw === "on" };
    case "lightBright":
    case "roomBright":
      return { on: true, bri: brightVal(act.pct) };
    case "lightTemp":
    case "roomTemp":
      return { on: true, ct: ctVal(act.tone) };
    case "lightColor":
    case "roomColor": {
      const h = hueVal(act.color);
      return { on: true, hue: h, sat: satVal() };
    }
    default:
      return null;
  }
}

export async function runLightAct(api, c, act) {
  if (!confReady(c)) throw new Error("not configured — see Settings › Hue");
  const devs = await lights(api, c);
  if (!devs.length) throw new Error("no Hue lights found");
  let targets = find(devs, act.name);
  if (!targets.length) throw new Error(`no light matches "${act.name}"`);
  const state = stateFor(act);
  if (!state) throw new Error("unsupported act");
  const sent = [];
  const skipped = [];
  for (const d of targets) {
    try {
      const resp = await httpPut(api, `${baseUrl(c.bridgeIp)}/api/${c.username}/lights/${d.id}/state`, state);
      if (Array.isArray(resp) && resp.some((x) => x && x.error)) {
        const er = resp.find((x) => x && x.error).error;
        throw new Error(er.description || `hue error ${er.type}`);
      }
      sent.push(d.name);
    } catch (e) {
      // unsupported capability -> counted as skipped, not fatal until all skipped
      skipped.push(d.name);
      // if it's auth or bridge error, rethrow immediately
      const m = String(e);
      if (/unauthorized|press Pair|not configured/.test(m)) throw e;
      if (sent.length === 0 && skipped.length === targets.length) {
        // defer throw till after loop so we can report first light's reason
        continue;
      }
    }
  }
  if (!sent.length) throw new Error(`${targets[0].name} doesn't support that`);
  const nm = (list) => (list.length === 1 ? list[0] : `${list.length} lights`);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let msg;
  switch (act.type) {
    case "light": msg = act.sw === "on" ? `${cap(nm(sent))} on.` : `${cap(nm(sent))} off.`; break;
    case "lightBright": msg = `${cap(nm(sent))} set to ${act.pct}% brightness.`; break;
    case "lightTemp": msg = `${cap(nm(sent))}: ${act.tone} white.`; break;
    case "lightColor": msg = `${cap(nm(sent))} is now ${act.color}.`; break;
    default: msg = `${cap(nm(sent))} done.`;
  }
  if (skipped.length) msg += ` (${skipped.join(", ")} skipped.)`;
  return msg;
}

export async function runRoomAct(api, c, act) {
  if (!confReady(c)) throw new Error("not configured — see Settings › Hue");
  const devs = await rooms(api, c);
  if (!devs.length) throw new Error("no Hue rooms found");
  let targets = find(devs, act.name);
  if (!targets.length) throw new Error(`no room matches "${act.name}"`);
  const state = stateFor(act);
  if (!state) throw new Error("unsupported act");
  const sent = [];
  const skipped = [];
  for (const d of targets) {
    try {
      const resp = await httpPut(api, `${baseUrl(c.bridgeIp)}/api/${c.username}/groups/${d.id}/action`, state);
      if (Array.isArray(resp) && resp.some((x) => x && x.error)) {
        const er = resp.find((x) => x && x.error).error;
        throw new Error(er.description || `hue error ${er.type}`);
      }
      sent.push(d.name);
    } catch (e) {
      skipped.push(d.name);
      const m = String(e);
      if (/unauthorized|press Pair|not configured/.test(m)) throw e;
      if (sent.length === 0 && skipped.length === targets.length) continue;
    }
  }
  if (!sent.length) throw new Error(`${targets[0].name} doesn't support that`);
  const nm = (list) => (list.length === 1 ? list[0] : `${list.length} rooms`);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let msg;
  switch (act.type) {
    case "room": msg = act.sw === "on" ? `${cap(nm(sent))} on.` : `${cap(nm(sent))} off.`; break;
    case "roomBright": msg = `${cap(nm(sent))} set to ${act.pct}% brightness.`; break;
    case "roomTemp": msg = `${cap(nm(sent))}: ${act.tone} white.`; break;
    case "roomColor": msg = `${cap(nm(sent))} is now ${act.color}.`; break;
    default: msg = `${cap(nm(sent))} done.`;
  }
  if (skipped.length) msg += ` (${skipped.join(", ")} skipped.)`;
  return msg;
}

export async function runAct(api, c, act) {
  if (!act || !act.type) throw new Error("unknown act");
  if (act.type.startsWith("light")) return runLightAct(api, c, act);
  if (act.type.startsWith("room")) return runRoomAct(api, c, act);
  // generic "room" act without prefix fallback via dispatch above; try lights then rooms
  // but if light exec failed to match, retry as room
  throw new Error("unknown act");
}

// auto-dispatch for /hue: tries lights first, then rooms if no light matched (so "kitchen" hits the Kitchen room)
export async function runHueAct(api, c, act) {
  if (act.type.startsWith("light")) {
    try { return await runLightAct(api, c, act); } catch (e) {
      const msg = String(e);
      if (act.name && /no light matches/.test(msg)) {
        // retry as room with same payload kind
        const roomAct = { ...act, type: act.type.replace("light", "room") };
        try { return await runRoomAct(api, c, roomAct); } catch {}
      }
      throw e;
    }
  }
  if (act.type.startsWith("room")) {
    try { return await runRoomAct(api, c, act); } catch (e) {
      const msg = String(e);
      if (act.name && /no room matches/.test(msg)) {
        const lightAct = { ...act, type: act.type.replace("room", "light") };
        try { return await runLightAct(api, c, lightAct); } catch {}
      }
      throw e;
    }
  }
  return runAct(api, c, act);
}

// slash helpers — parse "/hue ..." args
export function parseHueSlashArgs(args) {
  const t = (args ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  // direct voice parse first (handles "turn the bedroom lights off" etc.)
  const direct = parseVoice(t);
  if (direct) return direct;
  // shorthand: "on [name]", "off [name]"
  const mOnOff = /^(on|off)(?: (.+))?$/.exec(t);
  if (mOnOff) {
    // default to light; executor will fallback to room if no light matches
    return { type: "light", sw: mOnOff[1], name: (mOnOff[2] ?? "").trim() };
  }
  const mPct = /^(\d{1,3})(?: percent|%)?(?: (.+))?$/.exec(t);
  if (mPct) {
    const p = pctLight(mPct[1]);
    if (p !== null) return { type: "lightBright", pct: p, name: (mPct[2] ?? "").trim() };
    // allow 0 for rooms
    const pr = pctRoom(mPct[1]);
    if (pr !== null) return { type: "roomBright", pct: pr, name: (mPct[2] ?? "").trim() };
  }
  const mColor = new RegExp(`^(${COLORS})(?: (.+))?$`).exec(t);
  if (mColor) return { type: "lightColor", color: mColor[1], name: (mColor[2] ?? "").trim() };
  const mTone = new RegExp(`^(${TONES})(?: white)?(?: (.+))?$`).exec(t);
  if (mTone) return { type: "lightTemp", tone: mTone[1], name: (mTone[2] ?? "").trim() };
  return null;
}

// parse for /hue-discover /hue-pair etc. not needed

// ---------------------------------------------------------------------------
// config resolution
// ---------------------------------------------------------------------------

function confOf(settings) {
  const raw =
    (settings && settings.plugins && settings.plugins[ID]) ||
    (settings && settings.hue) ||
    {};
  return {
    bridgeIp: typeof raw.bridgeIp === "string" ? raw.bridgeIp.trim() : "",
    username: typeof raw.username === "string" ? raw.username.trim() : "",
  };
}
function persistConf(patch) {
  try {
    const raw = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
    const plugins = (raw.plugins && typeof raw.plugins === "object") ? raw.plugins : {};
    const cur = plugins[ID] && typeof plugins[ID] === "object" ? plugins[ID] : {};
    const next = { ...cur, ...patch };
    plugins[ID] = next;
    raw.plugins = plugins;
    localStorage.setItem("oc.settings", JSON.stringify(raw));
    try { window.dispatchEvent(new CustomEvent("oc:settings:changed")); } catch {}
  } catch {}
}

export default function activate(api) {
  const { h, useState, useEffect } = api;

  function Settings({ open, settings, updatePlugin }) {
    const hue = confOf(settings);
    const set = (patch) => updatePlugin({ ...hue, ...patch });
    const [found, setFound] = useState(null);
    const [discovered, setDiscovered] = useState(null);
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const [pairing, setPairing] = useState(false);
    const [collapsed, setCollapsed] = useState(() => {
      try { return localStorage.getItem("oc.settings.hue.collapsed") !== "0"; } catch { return true; }
    });

    useEffect(() => {
      if (open) clearHueCache();
    }, [open, hue.bridgeIp, hue.username]);

    async function doDiscover() {
      setErr("");
      setDiscovered(null);
      setBusy(true);
      try {
        const bridges = await discoverBridges(api);
        if (!bridges.length) throw new Error("no Hue bridges found on this network");
        setDiscovered(bridges);
        // auto-fill first if empty
        if (!hue.bridgeIp && bridges[0].ip) set({ bridgeIp: bridges[0].ip });
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    }

    async function doPair() {
      if (!hue.bridgeIp) { setErr("enter Bridge IP first (Discover)"); return; }
      setErr("");
      setPairing(true);
      try {
        const user = await pairBridge(api, hue.bridgeIp);
        set({ username: user });
        setErr("");
      } catch (e) {
        setErr(String(e));
      } finally {
        setPairing(false);
      }
    }

    async function find() {
      setErr("");
      setFound(null);
      setBusy(true);
      try {
        const r = await testCreds(api, hue);
        setFound(r);
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    }

    const st = confReady(hue) ? (err ? "error — see below" : found ? `${found.lights.length} light(s), ${found.rooms.length} room(s)` : "ready") : "not configured";
    const toggle = () => setCollapsed((v) => {
      const nv = !v;
      try { localStorage.setItem("oc.settings.hue.collapsed", nv ? "1" : "0"); } catch {}
      try { api.playSound(nv ? "collapse" : "expand"); } catch {}
      return nv;
    });
    return h("div", { className: "sound-box" },
      h("div", { className: "sound-box-head", onClick: toggle, style: { cursor: "pointer" }, "data-tip": collapsed ? "Expand" : "Collapse" },
        h("i", { className: "fa-solid fa-lightbulb setting-icon" }),
        h("span", null, "Hue Bridge"),
        h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
          h("span", { className: "mono-hint" }, st),
          h("i", { className: `fa-solid ${collapsed ? "fa-chevron-down" : "fa-chevron-up"}`, style: { fontSize: "10px", color: "var(--text-faint)", marginLeft: "6px" } })
        )
      ),
      collapsed ? null : h("div", null,
      h("div", { className: "setting-row", style: { borderTop: "none", paddingBottom: 0 } },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-network-wired setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "Hue Bridge"),
            h("div", { className: "setting-desc" },
              "Auto-discover finds your Bridge on the LAN; then press its link button and click Pair. Stored username unlocks lights & rooms.")),
        ),
      ),
      h("div", { className: "hue-fields" },
        h("div", { style: { display: "flex", gap: "6px" } },
          h("input", {
            className: "hue-in",
            style: { flex: "1" },
            placeholder: "Bridge IP (e.g. 192.168.1.42)",
            value: hue.bridgeIp,
            onChange: (e) => set({ bridgeIp: e.target.value.trim() }),
            spellCheck: false,
          }),
          h("button", { type: "button", className: "reset-btn", disabled: busy, onClick: () => void doDiscover() },
            h("i", { className: "fa-solid fa-magnifying-glass" }),
            busy ? "…" : "Discover"),
        ),
        discovered && discovered.length ? h("div", { className: "setting-desc mono-hint", style: { padding: "2px 0" } },
          discovered.map((b) => h("button", { key: b.ip, type: "button", className: "reset-btn", style: { marginRight: "6px", marginBottom: "4px" }, onClick: () => set({ bridgeIp: b.ip }) }, `${b.ip}${b.name ? ` — ${b.name}` : ""}`))
        ) : null,
        h("div", { style: { display: "flex", gap: "6px" } },
          h("input", {
            className: "hue-in",
            style: { flex: "1" },
            placeholder: "Username (auto-filled after Pair)",
            value: hue.username,
            onChange: (e) => set({ username: e.target.value.trim() }),
            spellCheck: false,
          }),
          h("button", { type: "button", className: "reset-btn", disabled: !hue.bridgeIp || pairing, onClick: () => void doPair() },
            h("i", { className: "fa-solid fa-link" }),
            pairing ? "Pairing…" : "Pair"),
        ),
        h("div", { className: "setting-desc mono-hint", style: { padding: "2px 0 0" } },
          "Pair: press the link button on the Bridge, then click Pair within 30 seconds."),
        h("div", { className: "color-controls" },
          h("button", { type: "button", className: "reset-btn", disabled: !confReady(hue) || busy || pairing, onClick: () => void find() },
            h("i", { className: "fa-solid fa-magnifying-glass" }),
            busy ? "Checking…" : "Find lights & rooms"),
        ),
      ),
      err ? h("div", { className: "voice-err" }, err) : null,
      found && !err
        ? h("div", { className: "setting-row" },
            h("div", { className: "setting-info" },
              h("i", { className: "fa-solid fa-circle-check setting-icon" }),
              h("div", null,
                h("div", { className: "setting-name" }, "Linked"),
                h("div", { className: "setting-desc mono-hint" },
                  `Lights: ${found.lights.join(", ") || "—"} · Rooms: ${found.rooms.join(", ") || "—"}`),
                h("div", { className: "setting-desc mono-hint" },
                  `"desk lamp off" · dim to fifty percent · make it warm · turn it blue · living room off · set bedroom to 50%`)),
            ),
          )
        : null,
      )
    );
  }

  async function handleHueSlash(args) {
    const act = parseHueSlashArgs(args);
    if (!act) throw new Error('Usage: /hue on|off|[0-100%|color|warm/cool] [name]  e.g. "/hue on bedroom" or "/hue 50 living room" or "/hue blue desk lamp"');
    return runHueAct(api, confOf(api.settings()), act);
  }

  return {
    parse: parseVoice,
    describe,
    exec: (act) => runHueAct(api, confOf(api.settings()), act),
    triggers: TRIGGERS,
    vocab: VOCAB,
    lexicon: LEXICON,
    Settings,
    slash: [
      { name: "hue", description: "Control Hue lights & rooms — on/off, 0-100%, color, warm/cool  (e.g. /hue on bedroom, /hue 50 living room, /hue blue desk)", takesArgs: true, handle: handleHueSlash },
      { name: "hue-on", description: "Turn Hue lights/room on [name]", takesArgs: true, handle: async (args) => runHueAct(api, confOf(api.settings()), { type: "light", sw: "on", name: (args ?? "").trim() }) },
      { name: "hue-off", description: "Turn Hue lights/room off [name]", takesArgs: true, handle: async (args) => runHueAct(api, confOf(api.settings()), { type: "light", sw: "off", name: (args ?? "").trim() }) },
      { name: "hue-discover", description: "Discover Hue bridges on the LAN", takesArgs: false, handle: async () => {
        const bridges = await discoverBridges(api);
        if (!bridges.length) return "no Hue bridges found";
        const ips = bridges.map((b) => b.ip).join(", ");
        const cur = confOf(api.settings());
        if (!cur.bridgeIp && bridges[0].ip) {
          persistConf({ bridgeIp: bridges[0].ip });
          return `found: ${ips} — auto-saved ${bridges[0].ip} to Settings › Hue`;
        }
        return `found: ${ips} — set in Settings › Hue or /hue-pair after pressing link button`;
      }},
      { name: "hue-pair", description: "Pair with Hue Bridge (press link button first)", takesArgs: true, handle: async (args) => {
        const c = confOf(api.settings());
        const ip = (args ?? "").trim() || c.bridgeIp;
        if (!ip) throw new Error("no Bridge IP — set in Settings › Hue or pass /hue-pair 192.168.1.42");
        const user = await pairBridge(api, ip);
        persistConf({ bridgeIp: ip, username: user });
        clearHueCache();
        return `paired! saved username for ${ip}`;
      }},
    ],
    info: {
      voice: [
        ["lights on / lights off", ""],
        ["turn the desk lamp off", ""],
        ["dim the lights to fifty percent", ""],
        ["set it to 75 percent", ""],
        ["make it warm white / cool white", ""],
        ["turn it red / blue / green… (per-light)", ""],
        ["living room off / bedroom on", ""],
        ["set the bedroom to fifty percent", ""],
        ["make the living room blue", ""],
      ],
      keys: [
        ["/hue on [name]", "Turn matching lights/room on"],
        ["/hue off [name]", "Turn matching lights/room off"],
        ["/hue 50 [name]", "Set brightness 50%"],
        ["/hue blue [name]", "Set color (per-light)"],
        ["/hue warm [name]", "Set warm white"],
        ["/hue-discover", "Discover bridges"],
        ["/hue-pair [ip]", "Pair (press link button first)"],
      ],
    },
  };
}
