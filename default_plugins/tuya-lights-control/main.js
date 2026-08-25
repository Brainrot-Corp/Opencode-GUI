// Tuya voice light control — opencode-gui plugin (plain browser ESM).
//
// Install: copy this folder to ~/.config/.opencode-gui/plugins/ and restart
// the app (or just save a file here — plugins hot-reload). Credentials come
// from a free project at iot.tuya.com after linking your Smart Life account;
// enter them in Settings › Lights.
//
// Transport: HMAC-SHA256 request signing per developer.tuya.com "Sign
// Requests", executed JS-side via WebCrypto; HTTPS goes through the host's
// generic http_json command. Sign scheme:
//   token req : HMAC(secret, client_id + t + stringToSign)
//   other reqs: HMAC(secret, client_id + access_token + t + stringToSign)
//   stringToSign = method \n sha256(body) \n (signed headers empty) \n path?query
//
// Settings live in oc.settings.plugins["tuya-lights-control"]; until first
// save, the pre-plugin oc.settings.tuya blob is read as a fallback so
// existing credentials carry over untouched.

const ID = "tuya-lights-control";

// ---------------------------------------------------------------------------
// voice layer — pure functions, node-testable without activation
// ---------------------------------------------------------------------------

// spoken numbers whisper sometimes writes out — digits stay the common case
const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, half: 50, quarter: 25,
};

function pct(w) {
  if (/^\d+$/.test(w)) {
    const n = parseInt(w, 10);
    return n >= 1 && n <= 100 ? n : null;
  }
  return WORD_NUM[w.toLowerCase()] ?? null;
}

// device word shared by every light intent
const DEV = "(?:lights?|lamps?|bulbs?)";
export const COLORS =
  "red|orange|yellow|green|cyan|blue|purple|violet|magenta|pink" +
  "|crimson|salmon|coral|gold|lime|olive|brown|teal|turquoise|aqua|azure|indigo|navy|lavender|maroon";
export const TONES = "warm|cool|neutral|daylight";

// intent parser — runs on the fully-normalized transcript (punctuation
// stripped, lexicon applied). Name group = up to 3 short words between the
// verb and the device word ("desk lamp") — capped so long chatter can't be
// swallowed as a name.
export function parseVoice(t) {
  const swA = new RegExp(
    `^(?:turn |switch |shut )?(?:the |my )?((?:[a-z]{1,12} ){0,3})?${DEV} (on|off)$`,
  ).exec(t);
  if (swA) return { type: "light", sw: swA[2], name: (swA[1] ?? "").trim() };
  const swB =
    /^(?:turn|switch|shut) (on|off)(?: the| my)?(?: ((?:[a-z]{1,12} ){0,3}[a-z]{1,12}))? (?:lights?|lamps?|bulbs?)$/.exec(t);
  if (swB) return { type: "light", sw: swB[1], name: (swB[2] ?? "").trim() };

  const num = "([\\w]+)";
  const PCT_TAIL = "(?: percent|%)?$";
  const brA = new RegExp(
    `^(?:dim|brighten)(?: the| my)? ?([a-z ]*?)?(?:${DEV}) to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (brA) {
    const p = pct(brA[2]);
    if (p !== null) return { type: "lightBright", pct: p, name: (brA[1] ?? "").trim() };
  }
  const brB = new RegExp(
    `^set (?:the |my )?([a-z ]*?)?(?:${DEV}) to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (brB) {
    const p = pct(brB[2]);
    if (p !== null) return { type: "lightBright", pct: p, name: (brB[1] ?? "").trim() };
  }

  const toneM = new RegExp(
    `^(?:make|set)(?: the| my)? ?([a-z ]*?)?(${DEV})(?: to)? (${TONES})(?: white)?$`,
  ).exec(t);
  if (toneM) return { type: "lightTemp", tone: toneM[3], name: (toneM[1] ?? "").trim() };
  const colM = new RegExp(
    `^(?:turn|make|set|change|color)(?: the| my)? ?([a-z ]*?)?(${DEV})(?: to)? (${COLORS})$`,
  ).exec(t);
  if (colM) return { type: "lightColor", color: colM[3], name: (colM[1] ?? "").trim() };

  // natural bare forms — "lights red", "light warm" (post-lexicon also FR/ES)
  const bareTone = new RegExp(`^(?:the )?(?:${DEV}) (${TONES})(?: white)?$`).exec(t);
  if (bareTone) return { type: "lightTemp", tone: bareTone[1], name: "" };
  const bareCol = new RegExp(`^(?:the )?(?:${DEV}) (${COLORS})$`).exec(t);
  if (bareCol) return { type: "lightColor", color: bareCol[1], name: "" };

  return null;
}

// spoken read-back for embedded-command confirmation ("Okay — turn the
// bedroom lamp off?")
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

// mid-sentence trigger verbs — the light-only slice of what used to be the
// router's static list (turn/switch/shut a device, dim/brighten/set/make/
// change/color it)
export const TRIGGERS = ["turn", "dim", "brighten", "set", "make", "change", "color"];

// typo-correction vocabulary — device words, switch words, tones and colors
export const VOCAB = [
  ...TRIGGERS,
  "light", "lights", "lamp", "lamps", "bulb", "bulbs",
  "on", "off", "white",
  ...TONES.split("|"),
  ...COLORS.split("|"),
];

// phrasing rewrites into canonical English — the light-domain slice of the
// old built-in lexicon (idioms, EN verb pairs, FR/ES verbs/devices/colors/
// tones/numbers, possessive swap before articles so "lampe du bureau" lands
// where the pattern expects its device word)
export const LEXICON = [
  // idiom: "lights out" means off
  [/\blights? out\b/g, "lights off"],

  // verb+particle pairs (EN synonyms not already accepted by patterns)
  [/\b(?:switch|shut|power)\s+(?:off|down)\b/g, "turn off"],
  [/\bswitch on\b/g, "turn on"],
  [/\bfire up\b/g, "turn on"],
  [/\bpower up\b/g, "turn on"],

  // French / Spanish light verbs
  [/\ballum(?:e|er|ez|es)\b/g, "turn on"],
  [/\benciend(?:e|er|o)\b|\bprends?\b/g, "turn on"],
  [/\b(?:eteins|eteindre|apaga|apagar)\b/g, "turn off"],
  [/\bmet(?:s|tre)?\b|\bpon\b|\bponer\b/g, "set"],

  // devices (singular/plural kept distinct)
  [/\blumieres\b|\bluces\b/g, "lights"],
  [/\blumiere\b|\bluz\b/g, "light"],
  [/\blampes\b/g, "lamps"],
  [/\blampe\b/g, "lamp"],
  [/\bbombillas?\b/g, "bulbs"],

  // colors → canonical English
  [/\brouges?\b|\brojas?\b|\brojos?\b/g, "red"],
  [/\bjaunes?\b|\bamarill[oa]s?\b/g, "yellow"],
  [/\bvertes?\b|\bverdes?\b/g, "green"],
  [/\bbleues?\b|\bbleus?\b|\bazules?\b/g, "blue"],
  [/\bviolettes?\b|\bmorad[oa]s?\b/g, "violet"],
  [/\bpourpres?\b/g, "purple"],
  [/\broses?\b|\brosas?\b/g, "pink"],
  [/\bmarrones?\b/g, "brown"],
  [/\bturquesas?\b/g, "turquoise"],
  [/\baguamarinas?\b/g, "aqua"],
  [/\blilas?\b/g, "lavender"],
  [/\bcitron vert\b|\blima\b/g, "lime"],
  [/\bbleu marine\b|\bazul marino\b/g, "navy"],
  [/\bdorees?\b|\bdores\b/g, "gold"],

  // white-balance tones
  [/\bchaudes?\b|\bchauds?\b/g, "warm"],
  [/\bfraiches?\b|\bfroids?\b|\bfrias?\b|\bfrios?\b|\bfrescas?\b/g, "cool"],
  [/\bneutres?\b|\bneutros?\b/g, "neutral"],
  [/\blumiere du jour\b|\bluz del dia\b/g, "daylight"],

  // spoken numbers for brightness (host word map is EN-only)
  [/\bvingt\b|\bveinte\b/g, "twenty"],
  [/\btrente\b|\btreinta\b/g, "thirty"],
  [/\bquarante\b|\bcuarenta\b/g, "forty"],
  [/\bcinquante\b|\bcincuenta\b/g, "fifty"],
  [/\bsoixante\b|\bsesenta\b/g, "sixty"],
  [/\bseptante\b|\bsetenta\b/g, "seventy"],
  [/\bochenta\b/g, "eighty"],
  [/\bnoventa\b/g, "ninety"],
  [/\bcent\b|\bcien\b/g, "hundred"],
  [/\bdemi\b|\bmitad\b/g, "half"],

  // possessive noun phrase swap, then articles — order matters
  [/\b([a-z]+) (?:du|des|de la|de los|de las|del) ([a-z]+)\b/g, "$2 $1"],
  [/\b(?:la|les|el|los|las)\b/g, "the"],
  [/\ble\b(?= )/g, "the"],
  [/\b(?:ma|mon|mes|mi|mis)\b/g, "my"],
];

// ---------------------------------------------------------------------------
// value mapping — DP-code detection and cloud payloads
// ---------------------------------------------------------------------------

// spoken color words → hue (degrees)
const HUE = {
  red: 0, salmon: 6, coral: 16, brown: 20, orange: 30, gold: 45, yellow: 60,
  olive: 80, lime: 90, green: 120, turquoise: 174, teal: 175, cyan: 180,
  aqua: 180, azure: 210, blue: 240, navy: 240, indigo: 255, lavender: 270,
  purple: 280, violet: 280, magenta: 320, pink: 330, crimson: 348, maroon: 350,
};

// warmth presets on the v2 temp scale (0 = coldest … 1000 = warmest)
const TEMP_TONE = { cool: 60, daylight: 300, neutral: 480, warm: 880 };

function hasCode(d, base) {
  const st = d.status ?? [];
  if (st.some((s) => s.code === `${base}_v2`)) return `${base}_v2`;
  if (st.some((s) => s.code === base)) return base;
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

// colour_data(_v2) packing: newer firmware reports/accepts a JSON string
// ({"h":..,"s":..,"v":..}), older expects packed hex hhhhssssvvvv — mirror
// whatever shape the device currently reports
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

// unwrap Tuya's {success, result, msg} envelope
function unwrap(j) {
  if (!j || j.success !== true) throw new Error(`tuya ${j?.code ?? 0}: ${j?.msg ?? "unknown error"}`);
  return j.result;
}

// module-level ~24h access-token cache — consecutive commands skip the
// token round trip
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

// signed general request; path must already carry its query string
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

// short-lived cache — the cloud round trip is ~1s, and consecutive voice
// commands ("lights on" → "dim them") shouldn't refetch every time
let cache = null;

export function clearTuyaCache() {
  cache = null;
}

async function lights(api, c) {
  if (cache && Date.now() - cache.at < 60000) return cache.devs;
  const devs = await tuyaApi(api.invoke, c, "GET", `/v1.0/users/${c.uid}/devices`, null);
  const out = [];
  for (const d of Array.isArray(devs) ? devs : []) {
    // light-ish categories: dj bulb/ceiling, dd strip, fwd? keep broad set;
    // unknown categories still pass through if the name mentions light/lamp
    const cat = d.category ?? "";
    const name = (d.name ?? "").toLowerCase();
    const lightish =
      ["dj", "dd", "fwd", "tgq", "hxd"].includes(cat) ||
      name.includes("light") || name.includes("lamp") ||
      name.includes("licht") || name.includes("lampe");
    if (cat && !lightish) continue;
    out.push({ id: d.id ?? "", name: d.name ?? "", category: cat, online: !!d.online, status: d.status ?? null });
  }
  cache = { at: Date.now(), devs: out };
  return out;
}

// resolve a spoken fragment ("desk", "bedroom") against device names;
// empty fragment = everything online
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
  const devs = await lights(api, c);
  return devs.map((d) => d.name);
}

// runs one voice intent against the linked lights; resolves to a spoken
// summary, throws a human-readable error otherwise
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
        else {
          mode("white");
          cmds.push([code, brightVal(act.pct, code.endsWith("_v2"))]);
        }
        break;
      }
      case "lightTemp": {
        const code = hasCode(d, "temp_value");
        if (!code) ok = false;
        else {
          mode("white");
          cmds.push([code, tempVal(act.tone, code.endsWith("_v2"))]);
        }
        break;
      }
      case "lightColor": {
        const code = hasCode(d, "colour_data");
        if (!code || !(act.color in HUE)) ok = false;
        else {
          mode("colour");
          const cur = st.find((s) => s.code === code)?.value;
          cmds.push([code, colorData(act.color, code.endsWith("_v2"), cur)]);
        }
        break;
      }
    }
    if (!ok) {
      skipped.push(d.name);
      continue;
    }
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
    case "light":
      msg = act.sw === "on" ? `${cap(nm(sent))} on.` : `${cap(nm(sent))} off.`;
      break;
    case "lightBright":
      msg = `${cap(nm(sent))} set to ${act.pct}% brightness.`;
      break;
    case "lightTemp":
      msg = `${cap(nm(sent))}: ${act.tone} white.`;
      break;
    case "lightColor":
      msg = `${cap(nm(sent))} is now ${act.color}.`;
      break;
  }
  if (skipped.length) msg += ` (${skipped.join(", ")} skipped.)`;
  return msg;
}

// ---------------------------------------------------------------------------
// activation — wires everything to the host api
// ---------------------------------------------------------------------------

// config resolution: plugins namespace first; fall back to the pre-plugin
// settings blob so existing credentials keep working without migration
function confOf(settings) {
  const raw =
    (settings && settings.plugins && settings.plugins[ID]) ||
    (settings && settings.tuya) ||
    {};
  return {
    clientId: typeof raw.clientId === "string" ? raw.clientId : "",
    secret: typeof raw.secret === "string" ? raw.secret : "",
    uid: typeof raw.uid === "string" ? raw.uid : "",
    region: ["us", "eu", "cn", "in"].includes(raw.region) ? raw.region : "eu",
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

  // Settings › Lights — same markup/classes as the original built-in panel
  function Settings({ open, settings, updatePlugin }) {
    const tuya = confOf(settings);
    const set = (patch) => updatePlugin({ ...tuya, ...patch });
    const [found, setFound] = useState(null);
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);

    // stale device cache when the credentials change
    useEffect(() => {
      if (open) clearTuyaCache();
    }, [open, tuya.clientId, tuya.secret, tuya.uid, tuya.region]);

    async function find() {
      setErr("");
      setFound(null);
      setBusy(true);
      try {
        setFound(await testCreds(api, tuya));
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    }

    return h("div", { className: "sound-box" },
      h("div", { className: "sound-box-head" },
        h("i", { className: "fa-solid fa-lightbulb setting-icon" }),
        h("span", null, "Lights"),
        h("span", { className: "mono-hint" },
          confReady(tuya) ? (err ? "error — see below" : found ? `${found.length} light(s)` : "ready") : "not configured"),
      ),
      h("div", { className: "setting-row", style: { borderTop: "none", paddingBottom: 0 } },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-key setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "Tuya Cloud project"),
            h("div", { className: "setting-desc" },
              "Create a free project at iot.tuya.com, link your Smart Life account under Devices, then paste its Access ID / Secret and your account UID here")),
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
            busy ? "Checking…" : "Find bulbs"),
        ),
      ),
      err ? h("div", { className: "voice-err" }, err) : null,
      found && !err
        ? h("div", { className: "setting-row" },
            h("div", { className: "setting-info" },
              h("i", { className: "fa-solid fa-circle-check setting-icon" }),
              h("div", null,
                h("div", { className: "setting-name" }, "Linked — say things like"),
                h("div", { className: "setting-desc mono-hint" },
                  `"${found[0] ?? "desk lamp"} on" · dim the lights to fifty percent · make it warm · turn it blue`)),
            ),
          )
        : null,
    );
  }

  return {
    parse: parseVoice,
    describe: describeLight,
    exec: (act) => runLightAct(api, confOf(api.settings()), act),
    triggers: TRIGGERS,
    vocab: VOCAB,
    lexicon: LEXICON,
    Settings,
    // surfaced in the Info dialog's Voice tab, grouped under the plugin name
    info: {
      voice: [
        ["lights on / lights off", ""],
        ["turn the desk lamp off", ""],
        ["dim the lights to fifty percent", ""],
        ["set it to 75 percent", ""],
        ["make it warm white / cool white", ""],
        ["turn it red / blue / green…", ""],
      ],
    },
  };
}
