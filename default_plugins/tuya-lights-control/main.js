// Tuya light + curtain control — opencode-gui plugin (plain browser ESM).
//
// Install: copy this folder to ~/.config/.opencode-gui/plugins/ and restart
// the app (or just save a file here — plugins hot-reload). Credentials come
// from a free project at iot.tuya.com after linking your Smart Life account;
// enter them in Settings › Lights/Curtains (one project covers both).
//
// Transport: HMAC-SHA256 request signing per developer.tuya.com "Sign
// Requests", executed JS-side via WebCrypto; HTTPS goes through the host's
// generic http_json command. Sign scheme:
//   token req : HMAC(secret, client_id + t + stringToSign)
//   other reqs: HMAC(secret, client_id + access_token + t + stringToSign)
//   stringToSign = method \n sha256(body) \n (signed headers empty) \n path?query
//
// Settings live in oc.settings.plugins["tuya-lights-control"]; until first
// save, the pre-plugin oc.settings.tuya blob is read as a fallback. The old
// "tuya-curtains-control" plugin is merged here — its separate folder can be
// removed; this one handles lights and curtains with the same credentials.

const ID = "tuya-lights-control";

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

function pctLight(w) {
  if (/^\d+$/.test(w)) {
    const n = parseInt(w, 10);
    return n >= 1 && n <= 100 ? n : null;
  }
  return WORD_NUM[w.toLowerCase()] ?? null;
}
function pctCurtain(w) {
  if (/^\d+$/.test(w)) {
    const n = parseInt(w, 10);
    return n >= 0 && n <= 100 ? n : null;
  }
  return WORD_NUM[w.toLowerCase()] ?? null;
}

const DEV_LIGHT = "(?:lights?|lamps?|bulbs?)";
const DEV_CURTAIN = "(?:curtains?|blinds?|shades?|drapes?|shutters?)";

export const COLORS =
  "red|orange|yellow|green|cyan|blue|purple|violet|magenta|pink" +
  "|crimson|salmon|coral|gold|lime|olive|brown|teal|turquoise|aqua|azure|indigo|navy|lavender|maroon";
export const TONES = "warm|cool|neutral|daylight";

// light intent — extracted verbatim from v1.1 so existing voice tests keep passing
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

function parseCurtain(t) {
  const num = "([\\w]+)";
  const PCT_TAIL = "(?: percent|%)?$";
  const openCloseA = new RegExp(
    `^(?:open|close|stop|pause)(?: the| my)? ?([a-z ]*?)? ?${DEV_CURTAIN}$`,
  ).exec(t);
  if (openCloseA) {
    const verb = t.match(/^(open|close|stop|pause)/)?.[1];
    if (verb) {
      const sw = verb === "pause" ? "stop" : verb;
      return { type: "curtain", sw, name: (openCloseA[1] ?? "").trim() };
    }
  }
  const openCloseB = new RegExp(
    `^(?:the |my )?((?:[a-z]{1,12} ){0,3})?${DEV_CURTAIN} (open|close|stop|pause)$`,
  ).exec(t);
  if (openCloseB) {
    let sw = openCloseB[2];
    if (sw === "pause") sw = "stop";
    return { type: "curtain", sw, name: (openCloseB[1] ?? "").trim() };
  }
  const pctA = new RegExp(
    `^(?:set|move)(?: the| my)? ?([a-z ]*?)?${DEV_CURTAIN} to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (pctA) {
    const p = pctCurtain(pctA[2]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (pctA[1] ?? "").trim() };
  }
  const pctB = new RegExp(
    `^(?:dim|open|close)? ?(?:the |my )?([a-z ]*?)?${DEV_CURTAIN} to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (pctB && !/^(open|close|stop|pause)\b/.test(t)) {
    const p = pctCurtain(pctB[2]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (pctB[1] ?? "").trim() };
  }
  const pctC = new RegExp(
    `^(?:the |my )?((?:[a-z]{1,12} ){0,3})?${DEV_CURTAIN} ${num}${PCT_TAIL}`,
  ).exec(t);
  if (pctC) {
    const p = pctCurtain(pctC[2]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (pctC[1] ?? "").trim() };
  }
  return null;
}

export function parseVoice(t) {
  return parseLight(t) ?? parseCurtain(t);
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
export function describeCurtain(a) {
  switch (a.type) {
    case "curtain":
      if (a.sw === "stop") return `Stop ${a.name || "the curtains"}`;
      return `${a.sw === "open" ? "Open" : "Close"} ${a.name || "the curtains"}`;
    case "curtainPos":
      return `Set ${a.name || "the curtains"} to ${a.pct}%`;
    default:
      return "";
  }
}
export function describe(a) {
  return describeLight(a) || describeCurtain(a);
}

export const TRIGGERS = ["turn", "dim", "brighten", "set", "make", "change", "color", "open", "close", "stop", "pause", "move", "eteins", "eteindre", "allume", "allumer", "ouvre", "ouvrir", "ferme", "fermer"];

export const VOCAB = [
  ...TRIGGERS,
  "light", "lights", "lamp", "lamps", "bulb", "bulbs",
  "curtain", "curtains", "blind", "blinds", "shade", "shades", "drape", "drapes", "shutter", "shutters",
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
  [/\bblinds? up\b/g, "curtains open"],
  [/\bblinds? down\b/g, "curtains close"],
  [/\bshades? up\b/g, "curtains open"],
  [/\bshades? down\b/g, "curtains close"],
  // French — lights / curtains (end-anchored; applied after deaccent so use
  // unaccented forms; plugin host merges all lexicons after core FR)
  [/\b(?:eteins?|eteint|eteindre|coupe?)\s+(?:les?|des|ma|mon|la)?\s*(?:lumieres?|lampes?|lampe)s?$/g, "turn off the lights"],
  [/\ballume(?:r|z)?\s+(?:les?|des|ma|mon|la)?\s*(?:lumieres?|lampes?|lampe)s?$/g, "turn on the lights"],
  [/\bouvre(?:r|z)?\s+(?:les?|des|ma|mon|la)?\s*(?:rideaux?|stores?|volets?|tentures?)s?$/g, "open the curtains"],
  [/\b(?:ferme|fermer)\s+(?:les?|des|ma|mon|la)?\s*(?:rideaux?|stores?|volets?|tentures?)s?$/g, "close the curtains"],
];

// ---------------------------------------------------------------------------
// value mapping — DP-code detection and cloud payloads
// ---------------------------------------------------------------------------

const HUE = {
  red: 0, salmon: 6, coral: 16, brown: 20, orange: 30, gold: 45, yellow: 60,
  olive: 80, lime: 90, green: 120, turquoise: 174, teal: 175, cyan: 180,
  aqua: 180, azure: 210, blue: 240, navy: 240, indigo: 255, lavender: 270,
  purple: 280, violet: 280, magenta: 320, pink: 330, crimson: 348, maroon: 350,
};
const TEMP_TONE = { cool: 60, daylight: 300, neutral: 480, warm: 880 };

function hasCode(d, base) {
  const st = d.status ?? [];
  if (st.some((s) => s.code === `${base}_v2`)) return `${base}_v2`;
  if (st.some((s) => s.code === base)) return base;
  if (st.some((s) => s.code === `${base}_1`)) return `${base}_1`;
  if (st.some((s) => s.code === `${base}_2`)) return `${base}_2`;
  if (st.some((s) => s.code === `${base}_3`)) return `${base}_3`;
  return null;
}

export function brightVal(pctNum, v2) {
  const min = v2 ? 10 : 25;
  const max = v2 ? 1000 : 255;
  return Math.max(min, Math.min(max, Math.round((Math.max(1, Math.min(100, pctNum)) / 100) * max)));
}
export function tempVal(tone, v2) {
  const t = TEMP_TONE[tone] ?? 480;
  return v2 ? t : Math.round(t * 0.255);
}
function pack4(n) {
  return Math.max(0, Math.min(0xffff, Math.round(n))).toString(16).padStart(4, "0");
}
export function colorData(word, v2, cur) {
  const max = v2 ? 1000 : 255;
  const hsv = { h: HUE[word] ?? 0, s: max, v: max };
  if (typeof cur === "string" && cur.trim().startsWith("{")) return JSON.stringify(hsv);
  if (cur && typeof cur === "object") return hsv;
  return `${pack4(hsv.h)}${pack4(max)}${pack4(max)}`;
}

// ---------------------------------------------------------------------------
// transport + executor (needs an activated api)
// ---------------------------------------------------------------------------

function baseUrl(region) {
  switch (region) {
    case "eu": return "https://openapi.tuyaeu.com";
    case "cn": return "https://openapi.tuyacn.com";
    case "in": return "https://openapi.tuyain.com";
    default: return "https://openapi.tuyaus.com";
  }
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacUpper(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function unwrap(j) {
  if (!j || j.success !== true) throw new Error(`tuya ${j?.code ?? 0}: ${j?.msg ?? "unknown error"}`);
  return j.result;
}
let tokState = null;
async function getToken(invoke, creds) {
  if (tokState && Date.now() < tokState.exp) return tokState.tok;
  const PATH = "/v1.0/token?grant_type=1";
  const t = String(Date.now());
  const strToSign = `GET\n${await sha256hex("")}\n\n${PATH}`;
  const sign = await hmacUpper(creds.secret, creds.clientId + t + strToSign);
  const r = await invoke("http_json", {
    method: "GET",
    url: baseUrl(creds.region) + PATH,
    headers: { client_id: creds.clientId, t, sign_method: "HMAC-SHA256", sign },
    body: null,
  });
  const res = unwrap(JSON.parse(r.body));
  const tok = res.access_token;
  if (!tok) throw new Error("tuya token missing");
  const ttl = typeof res.expire_time === "number" ? res.expire_time : 7200;
  tokState = { tok, exp: Date.now() + Math.max(0, ttl - 300) * 1000 };
  return tok;
}
async function tuyaApi(invoke, creds, method, pathQs, body) {
  const tok = await getToken(invoke, creds);
  const bodyStr = body == null ? "" : JSON.stringify(body);
  const t = String(Date.now());
  const strToSign = `${method}\n${await sha256hex(bodyStr)}\n\n${pathQs}`;
  const sign = await hmacUpper(creds.secret, creds.clientId + tok + t + strToSign);
  const headers = {
    client_id: creds.clientId,
    access_token: tok,
    t,
    sign_method: "HMAC-SHA256",
    sign,
  };
  if (bodyStr) headers["Content-Type"] = "application/json";
  const r = await invoke("http_json", {
    method,
    url: baseUrl(creds.region) + pathQs,
    headers,
    body: bodyStr || null,
  });
  return unwrap(JSON.parse(r.body));
}

export function confReady(c) {
  return !!(c.clientId && c.secret && c.uid);
}

let cache = null;
export function clearTuyaCache() { cache = null; }

async function allDevs(api, c) {
  if (cache && Date.now() - cache.at < 60000) return cache.devs;
  const devs = await tuyaApi(api.invoke, c, "GET", `/v1.0/users/${c.uid}/devices`, null);
  const raw = Array.isArray(devs) ? devs : [];
  cache = { at: Date.now(), devs: raw };
  return raw;
}
async function lights(api, c) {
  const devs = await allDevs(api, c);
  const out = [];
  for (const d of devs) {
    const cat = d.category ?? "";
    const name = (d.name ?? "").toLowerCase();
    const lightish =
      ["dj", "dd", "fwd", "tgq", "hxd"].includes(cat) ||
      name.includes("light") || name.includes("lamp") ||
      name.includes("licht") || name.includes("lampe");
    if (cat && !lightish) continue;
    out.push({ id: d.id ?? "", name: d.name ?? "", category: cat, online: !!d.online, status: d.status ?? null });
  }
  return out;
}
async function curtains(api, c) {
  const devs = await allDevs(api, c);
  const out = [];
  for (const d of devs) {
    const cat = d.category ?? "";
    const name = (d.name ?? "").toLowerCase();
    const curtainish =
      ["cl", "clkg", "jdcljqr", "clcc", "clh", "clhkg"].includes(cat) ||
      name.includes("curtain") || name.includes("blind") ||
      name.includes("shade") || name.includes("drape") ||
      name.includes("roller") || name.includes("shutter") ||
      name.includes("vorhang") || name.includes("rideau");
    if (cat && !curtainish) continue;
    out.push({ id: d.id ?? "", name: d.name ?? "", category: cat, online: !!d.online, status: d.status ?? null });
  }
  return out;
}

function find(devs, frag) {
  const online = devs.filter((d) => d.online);
  const pool = online.length ? online : devs;
  const f = frag.trim().toLowerCase();
  if (!f) return pool;
  const sub = pool.filter((d) => d.name.toLowerCase().includes(f));
  if (sub.length) return sub;
  const toks = f.split(/\s+/).filter(Boolean);
  return pool.filter((d) => {
    const n = d.name.toLowerCase();
    return toks.some((t) => n.includes(t));
  });
}

export async function testCreds(api, c) {
  cache = null;
  const l = await lights(api, c);
  const cu = await curtains(api, c);
  return { lights: l.map((d) => d.name), curtains: cu.map((d) => d.name) };
}

export async function runLightAct(api, c, act) {
  if (!confReady(c)) throw new Error("not configured — see Settings › Lights");
  const devs = await lights(api, c);
  if (!devs.length) throw new Error("no linked lights found");
  const targets = find(devs, act.name);
  if (!targets.length) throw new Error(`no light matches "${act.name}"`);
  const sent = [];
  const skipped = [];
  for (const d of targets) {
    const cmds = [];
    const st = d.status ?? [];
    const mode = (m) => st.some((s) => s.code === "work_mode") && cmds.push(["work_mode", m]);
    let ok = true;
    switch (act.type) {
      case "light":
        cmds.push(["switch_led", act.sw === "on"]);
        break;
      case "lightBright": {
        const code = hasCode(d, "bright_value");
        if (!code) ok = false;
        else { mode("white"); cmds.push([code, brightVal(act.pct, code.endsWith("_v2"))]); }
        break;
      }
      case "lightTemp": {
        const code = hasCode(d, "temp_value");
        if (!code) ok = false;
        else { mode("white"); cmds.push([code, tempVal(act.tone, code.endsWith("_v2"))]); }
        break;
      }
      case "lightColor": {
        const code = hasCode(d, "colour_data");
        if (!code || !(act.color in HUE)) ok = false;
        else { mode("colour"); const cur = st.find((s) => s.code === code)?.value; cmds.push([code, colorData(act.color, code.endsWith("_v2"), cur)]); }
        break;
      }
    }
    if (!ok) { skipped.push(d.name); continue; }
    await tuyaApi(api.invoke, c, "POST", `/v1.0/iot-03/devices/${d.id}/commands`, {
      commands: cmds.map(([code, value]) => ({ code, value })),
    });
    sent.push(d.name);
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
  }
  if (skipped.length) msg += ` (${skipped.join(", ")} skipped.)`;
  return msg;
}

export async function runCurtainAct(api, c, act) {
  if (!confReady(c)) throw new Error("not configured — see Settings › Curtains");
  const devs = await curtains(api, c);
  if (!devs.length) throw new Error("no linked curtains found");
  const targets = find(devs, act.name);
  if (!targets.length) throw new Error(`no curtain matches "${act.name}"`);
  const sent = [];
  const skipped = [];
  for (const d of targets) {
    const cmds = [];
    let ok = true;
    switch (act.type) {
      case "curtain": {
        const code = hasCode(d, "control") || hasCode(d, "mach_operate");
        if (!code) ok = false;
        else {
          let val = act.sw;
          if (code === "mach_operate") val = act.sw === "open" ? "FZ" : act.sw === "close" ? "ZZ" : "STOP";
          cmds.push([code, val]);
        }
        break;
      }
      case "curtainPos": {
        const code = hasCode(d, "percent_control");
        if (!code) ok = false;
        else cmds.push([code, Math.max(0, Math.min(100, act.pct))]);
        break;
      }
      default: ok = false;
    }
    if (!ok) { skipped.push(d.name); continue; }
    await tuyaApi(api.invoke, c, "POST", `/v1.0/iot-03/devices/${d.id}/commands`, {
      commands: cmds.map(([code, value]) => ({ code, value })),
    });
    sent.push(d.name);
  }
  if (!sent.length) throw new Error(`${targets[0].name} doesn't support that`);
  const nm = (list) => (list.length === 1 ? list[0] : `${list.length} curtains`);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let msg;
  switch (act.type) {
    case "curtain":
      if (act.sw === "stop") msg = `${cap(nm(sent))} stopped.`;
      else if (act.sw === "open") msg = `${cap(nm(sent))} opened.`;
      else msg = `${cap(nm(sent))} closed.`;
      break;
    case "curtainPos": msg = `${cap(nm(sent))} set to ${act.pct}%.`; break;
  }
  if (skipped.length) msg += ` (${skipped.join(", ")} skipped.)`;
  return msg;
}

export async function runAct(api, c, act) {
  if (act.type.startsWith("light")) return runLightAct(api, c, act);
  if (act.type.startsWith("curtain")) return runCurtainAct(api, c, act);
  throw new Error("unknown act");
}

// slash helpers — parse "/lights ..." and "/curtains ..." args
export function parseLightSlashArgs(args) {
  const t = (args ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  const direct = parseLight(t);
  if (direct) return direct;
  // shorthand: "on [name]", "off [name]"
  const mOnOff = /^(on|off)(?: (.+))?$/.exec(t);
  if (mOnOff) return { type: "light", sw: mOnOff[1], name: (mOnOff[2] ?? "").trim() };
  const mPct = /^(\d{1,3})(?: percent|%)?(?: (.+))?$/.exec(t);
  if (mPct) {
    const p = pctLight(mPct[1]);
    if (p !== null) return { type: "lightBright", pct: p, name: (mPct[2] ?? "").trim() };
  }
  const mColor = new RegExp(`^(${COLORS})(?: (.+))?$`).exec(t);
  if (mColor) return { type: "lightColor", color: mColor[1], name: (mColor[2] ?? "").trim() };
  const mTone = new RegExp(`^(${TONES})(?: white)?(?: (.+))?$`).exec(t);
  if (mTone) return { type: "lightTemp", tone: mTone[1], name: (mTone[2] ?? "").trim() };
  return null;
}
export function parseCurtainSlashArgs(args) {
  const t = (args ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  const direct = parseCurtain(t);
  if (direct) return direct;
  const mOpen = /^(open|close|stop|pause)(?: (.+))?$/.exec(t);
  if (mOpen) {
    let sw = mOpen[1];
    if (sw === "pause") sw = "stop";
    return { type: "curtain", sw, name: (mOpen[2] ?? "").trim() };
  }
  const mPct = /^(\d{1,3})(?: percent|%)?(?: (.+))?$/.exec(t);
  if (mPct) {
    const p = pctCurtain(mPct[1]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (mPct[2] ?? "").trim() };
  }
  const mSet = /^set (?:(.+?) )?(\d{1,3})(?: percent|%)?$/.exec(t);
  if (mSet) {
    const p = pctCurtain(mSet[2]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (mSet[1] ?? "").trim() };
  }
  return null;
}

// ---------------------------------------------------------------------------
// config resolution
// ---------------------------------------------------------------------------

function confOf(settings) {
  const raw =
    (settings && settings.plugins && settings.plugins[ID]) ||
    (settings && settings.tuya) ||
    {};
  // also accept curtains plugin's old credentials if lights are empty
  const curtRaw = settings && settings.plugins && settings.plugins["tuya-curtains-control"];
  const eff = (raw && raw.clientId) ? raw : (curtRaw && curtRaw.clientId ? curtRaw : raw);
  return {
    clientId: typeof eff.clientId === "string" ? eff.clientId : "",
    secret: typeof eff.secret === "string" ? eff.secret : "",
    uid: typeof eff.uid === "string" ? eff.uid : "",
    region: ["us", "eu", "cn", "in"].includes(eff.region) ? eff.region : "eu",
  };
}

const REGIONS = [
  ["us", "Americas"],
  ["eu", "Europe"],
  ["cn", "China"],
  ["in", "India"],
];

export default function activate(api) {
  const { h, useState, useEffect } = api;

  function Settings({ open, settings, updatePlugin }) {
    const tuya = confOf(settings);
    const set = (patch) => updatePlugin({ ...tuya, ...patch });
    const [found, setFound] = useState(null);
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const [collapsed, setCollapsed] = useState(() => {
      try { return localStorage.getItem("oc.settings.lights.collapsed") !== "0"; } catch { return true; }
    });

    useEffect(() => {
      if (open) clearTuyaCache();
    }, [open, tuya.clientId, tuya.secret, tuya.uid, tuya.region]);

    async function find() {
      setErr("");
      setFound(null);
      setBusy(true);
      try {
        const r = await testCreds(api, tuya);
        setFound(r);
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    }

    const st = confReady(tuya) ? (err ? "error — see below" : found ? `${found.lights.length} light(s), ${found.curtains.length} curtain(s)` : "ready") : "not configured";
    const toggle = () => setCollapsed((v) => {
      const nv = !v;
      try { localStorage.setItem("oc.settings.lights.collapsed", nv ? "1" : "0"); } catch {}
      try { api.playSound(nv ? "collapse" : "expand"); } catch {}
      return nv;
    });
    return h("div", { className: "sound-box" },
      h("div", { className: "sound-box-head", onClick: toggle, style: { cursor: "pointer" }, "data-tip": collapsed ? "Expand" : "Collapse" },
        h("i", { className: "fa-solid fa-lightbulb setting-icon" }),
        h("span", null, "Lights & Curtains"),
        h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
          h("span", { className: "mono-hint" }, st),
          h("i", { className: `fa-solid ${collapsed ? "fa-chevron-down" : "fa-chevron-up"}`, style: { fontSize: "10px", color: "var(--text-faint)", marginLeft: "6px" } })
        )
      ),
      collapsed ? null : h("div", null,
      h("div", { className: "setting-row", style: { borderTop: "none", paddingBottom: 0 } },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-key setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "Tuya Cloud project"),
            h("div", { className: "setting-desc" },
              "Create a free project at iot.tuya.com, link your Smart Life account under Devices, then paste its Access ID / Secret and your account UID here. One project covers lights and curtains.")),
        ),
      ),
      h("div", { className: "tuya-fields" },
        h("input", {
          className: "tuya-in",
          placeholder: "Access ID (client id)",
          value: tuya.clientId,
          onChange: (e) => set({ clientId: e.target.value.trim() }),
          spellCheck: false,
        }),
        h("input", {
          className: "tuya-in",
          type: "password",
          placeholder: "Access Secret",
          value: tuya.secret,
          onChange: (e) => set({ secret: e.target.value.trim() }),
          spellCheck: false,
        }),
        h("input", {
          className: "tuya-in",
          placeholder: "App account UID (Linked Accounts page)",
          value: tuya.uid,
          onChange: (e) => set({ uid: e.target.value.trim() }),
          spellCheck: false,
        }),
        h("div", { className: "seg-row", role: "radiogroup", "aria-label": "Region" },
          REGIONS.map(([id2, label]) =>
            h("button", {
              key: id2,
              type: "button",
              role: "radio",
              "aria-checked": tuya.region === id2,
              className: `seg${tuya.region === id2 ? " on" : ""}`,
              onClick: () => set({ region: id2 }),
            }, label)),
        ),
        h("div", { className: "color-controls" },
          h("button", { type: "button", className: "reset-btn", disabled: !confReady(tuya) || busy, onClick: () => void find() },
            h("i", { className: "fa-solid fa-magnifying-glass" }),
            busy ? "Checking…" : "Find devices"),
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
                  `Lights: ${found.lights.join(", ") || "—"} · Curtains: ${found.curtains.join(", ") || "—"}`),
                h("div", { className: "setting-desc mono-hint" },
                  `"${found.lights[0] ?? found.curtains[0] ?? "desk lamp"} on" · dim to fifty percent · make it warm · turn it blue · open curtains · set curtains to 50%`)),
            ),
          )
        : null,
      )
    );
  }

  async function handleLightsSlash(args) {
    const act = parseLightSlashArgs(args);
    if (!act) throw new Error('Usage: /lights on|off|[0-100%|color|warm/cool] [name]  e.g. "/lights on bedroom" or "/lights 50" or "/lights blue"');
    return runLightAct(api, confOf(api.settings()), act);
  }
  async function handleCurtainsSlash(args) {
    const act = parseCurtainSlashArgs(args);
    if (!act) throw new Error('Usage: /curtains open|close|stop|<0-100%> [name]  e.g. "/curtains open bedroom" or "/curtains 50 bedroom"');
    return runCurtainAct(api, confOf(api.settings()), act);
  }

  return {
    parse: parseVoice,
    describe,
    exec: (act) => runAct(api, confOf(api.settings()), act),
    triggers: TRIGGERS,
    vocab: VOCAB,
    lexicon: LEXICON,
    requiresConfirmation: (act) => !String(act?.type).startsWith("light"),
    Settings,
    slash: [
      { name: "lights", description: "Control Tuya lights — on/off, 0-100%, color, warm/cool  (e.g. /lights on bedroom, /lights 50, /lights blue)", takesArgs: true, handle: handleLightsSlash },
      { name: "lights-on", description: "Turn lights on [name]", takesArgs: true, handle: async (args) => runLightAct(api, confOf(api.settings()), { type: "light", sw: "on", name: (args ?? "").trim() }) },
      { name: "lights-off", description: "Turn lights off [name]", takesArgs: true, handle: async (args) => runLightAct(api, confOf(api.settings()), { type: "light", sw: "off", name: (args ?? "").trim() }) },
      { name: "curtains", description: "Control Tuya curtains — open/close/stop or 0-100%  (e.g. /curtains open bedroom, /curtains 50)", takesArgs: true, handle: handleCurtainsSlash },
      { name: "curtains-open", description: "Open curtains [name]", takesArgs: true, handle: async (args) => runCurtainAct(api, confOf(api.settings()), { type: "curtain", sw: "open", name: (args ?? "").trim() }) },
      { name: "curtains-close", description: "Close curtains [name]", takesArgs: true, handle: async (args) => runCurtainAct(api, confOf(api.settings()), { type: "curtain", sw: "close", name: (args ?? "").trim() }) },
      { name: "curtains-stop", description: "Stop curtains [name]", takesArgs: true, handle: async (args) => runCurtainAct(api, confOf(api.settings()), { type: "curtain", sw: "stop", name: (args ?? "").trim() }) },
    ],
    info: {
      voice: [
        ["lights on / lights off", ""],
        ["turn the desk lamp off", ""],
        ["dim the lights to fifty percent", ""],
        ["set it to 75 percent", ""],
        ["make it warm white / cool white", ""],
        ["turn it red / blue / green…", ""],
        ["curtains open / curtains close / curtains stop", ""],
        ["open the bedroom curtains", ""],
        ["close the blinds", ""],
        ["set curtains to fifty percent", ""],
        ["blinds up / blinds down", ""],
      ],
      keys: [
        ["/lights on [name]", "Turn matching lights on"],
        ["/lights off [name]", "Turn matching lights off"],
        ["/lights 50 [name]", "Set lights brightness 50%"],
        ["/lights blue [name]", "Set lights color"],
        ["/lights warm [name]", "Set lights warm white"],
        ["/curtains open [name]", "Open matching curtains"],
        ["/curtains close [name]", "Close matching curtains"],
        ["/curtains stop [name]", "Stop curtains"],
        ["/curtains 50 [name]", "Set curtains to 50%"],
      ],
    },
  };
}
