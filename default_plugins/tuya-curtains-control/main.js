// Tuya voice curtain control — opencode-gui plugin (plain browser ESM).
//
// Install: copy this folder to ~/.config/.opencode-gui/plugins/ and restart
// the app (or just save a file here — plugins hot-reload). Credentials come
// from a free project at iot.tuya.com after linking your Smart Life account;
// enter them in Settings › Curtains (shares the same Tuya project as Lights).
//
// Transport: HMAC-SHA256 request signing per developer.tuya.com "Sign
// Requests", executed JS-side via WebCrypto; HTTPS goes through the host's
// generic http_json command. Same schemes as tuya-lights-control:
//   token req : HMAC(secret, client_id + t + stringToSign)
//   other reqs: HMAC(secret, client_id + access_token + t + stringToSign)
//   stringToSign = method \n sha256(body) \n (signed headers empty) \n path?query
//
// Settings live in oc.settings.plugins["tuya-curtains-control"]; if empty,
// credentials fall back to oc.settings.plugins["tuya-lights-control"] and the
// legacy oc.settings.tuya blob so one Tuya project covers lights + curtains.

const ID = "tuya-curtains-control";

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

function pct(w) {
  if (/^\d+$/.test(w)) {
    const n = parseInt(w, 10);
    return n >= 0 && n <= 100 ? n : null;
  }
  return WORD_NUM[w.toLowerCase()] ?? null;
}

const DEV = "(?:curtains?|blinds?|shades?|drapes?|shutters?)";

export function parseVoice(t) {
  // normalise zero special — curtains can be 0% (fully closed)
  const num = "([\\w]+)";
  const PCT_TAIL = "(?: percent|%)?$";

  // open / close / stop / pause — two phrasings
  // "open the bedroom curtains", "curtains open", "close blinds", "stop the curtains"
  const openCloseA = new RegExp(
    `^(?:open|close|stop|pause)(?: the| my)? ?([a-z ]*?)? ?${DEV}$`,
  ).exec(t);
  if (openCloseA) {
    const verb = t.match(/^(open|close|stop|pause)/)?.[1];
    if (verb) {
      const sw = verb === "pause" ? "stop" : verb;
      // avoid matching percent phrases like "set curtains to 50" as control
      return { type: "curtain", sw, name: (openCloseA[1] ?? "").trim() };
    }
  }
  const openCloseB = new RegExp(
    `^(?:the |my )?((?:[a-z]{1,12} ){0,3})?${DEV} (open|close|stop|pause)$`,
  ).exec(t);
  if (openCloseB) {
    let sw = openCloseB[2];
    if (sw === "pause") sw = "stop";
    return { type: "curtain", sw, name: (openCloseB[1] ?? "").trim() };
  }
  // "open/close the curtains" — bare with no name is already covered by A with empty capture,
  // but also handle "open curtains" where verb+device with no filler

  // percent — "set curtains to 50 percent", "set bedroom blinds to half", "curtains 50"
  const pctA = new RegExp(
    `^(?:set|move)(?: the| my)? ?([a-z ]*?)?${DEV} to ${num}${PCT_TAIL}`,
  ).exec(t);
  if (pctA) {
    const p = pct(pctA[2]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (pctA[1] ?? "").trim() };
  }
  const pctB = new RegExp(
    `^(?:dim|open|close)? ?(?:the |my )?([a-z ]*?)?${DEV} to ${num}${PCT_TAIL}`,
  ).exec(t);
  // avoid double-matching control phrases already handled; only accept if numeric
  if (pctB && !/^(open|close|stop|pause)\b/.test(t)) {
    const p = pct(pctB[2]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (pctB[1] ?? "").trim() };
  }
  // bare percent without "to" — "curtains 50 percent", "blinds half"
  const pctC = new RegExp(
    `^(?:the |my )?((?:[a-z]{1,12} ){0,3})?${DEV} ${num}${PCT_TAIL}`,
  ).exec(t);
  if (pctC) {
    const p = pct(pctC[2]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (pctC[1] ?? "").trim() };
  }

  return null;
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

export const TRIGGERS = ["open", "close", "stop", "pause", "set", "move"];

export const VOCAB = [
  ...TRIGGERS,
  "curtain", "curtains", "blind", "blinds", "shade", "shades", "drape", "drapes", "shutter", "shutters",
  "percent", "half", "quarter",
];

export const LEXICON = [
  [/\bblinds? up\b/g, "curtains open"],
  [/\bblinds? down\b/g, "curtains close"],
  [/\bshades? up\b/g, "curtains open"],
  [/\bshades? down\b/g, "curtains close"],
];

// ---------------------------------------------------------------------------
// value mapping / DP detection
// ---------------------------------------------------------------------------

function hasCode(d, base) {
  const st = d.status ?? [];
  if (st.some((s) => s.code === `${base}_v2`)) return `${base}_v2`;
  if (st.some((s) => s.code === base)) return base;
  // multi-gang variants: control_1, percent_control_1
  if (st.some((s) => s.code === `${base}_1`)) return `${base}_1`;
  if (st.some((s) => s.code === `${base}_2`)) return `${base}_2`;
  if (st.some((s) => s.code === `${base}_3`)) return `${base}_3`;
  return null;
}

// ---------------------------------------------------------------------------
// transport (mirrors tuya-lights-control)
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

export function clearTuyaCache() {
  cache = null;
}

async function curtains(api, c) {
  if (cache && Date.now() - cache.at < 60000) return cache.devs;
  const devs = await tuyaApi(api.invoke, c, "GET", `/v1.0/users/${c.uid}/devices`, null);
  const out = [];
  for (const d of Array.isArray(devs) ? devs : []) {
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
  cache = { at: Date.now(), devs: out };
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
  const devs = await curtains(api, c);
  return devs.map((d) => d.name);
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
          // legacy mach_operate uses ZZ/FZ/STOP, map accordingly
          let val = act.sw;
          if (code === "mach_operate") {
            val = act.sw === "open" ? "FZ" : act.sw === "close" ? "ZZ" : "STOP";
          }
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
      default:
        ok = false;
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

  const nm = (list) => (list.length === 1 ? list[0] : `${list.length} curtains`);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let msg;
  switch (act.type) {
    case "curtain":
      if (act.sw === "stop") msg = `${cap(nm(sent))} stopped.`;
      else if (act.sw === "open") msg = `${cap(nm(sent))} opened.`;
      else msg = `${cap(nm(sent))} closed.`;
      break;
    case "curtainPos":
      msg = `${cap(nm(sent))} set to ${act.pct}%.`;
      break;
  }
  if (skipped.length) msg += ` (${skipped.join(", ")} skipped.)`;
  return msg;
}

// slash helper — parses "/curtains ..." args into the same act shape
export function parseSlashArgs(args) {
  const t = (args ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return null;
  // reuse voice parser on the args tail (e.g. "open bedroom", "bedroom 50%")
  const direct = parseVoice(t);
  if (direct) return direct;
  // also allow explicit forms: "open [name]", "close [name]", "stop [name]", "set [name] 50"
  const mOpen = /^(open|close|stop|pause)(?: (.+))?$/.exec(t);
  if (mOpen) {
    let sw = mOpen[1];
    if (sw === "pause") sw = "stop";
    return { type: "curtain", sw, name: (mOpen[2] ?? "").trim() };
  }
  const mPct = /^(\d{1,3})(?: percent|%)?(?: (.+))?$/.exec(t);
  if (mPct) {
    const p = pct(mPct[1]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (mPct[2] ?? "").trim() };
  }
  const mSet = /^set (?:(.+?) )?(\d{1,3})(?: percent|%)?$/.exec(t);
  if (mSet) {
    const p = pct(mSet[2]);
    if (p !== null) return { type: "curtainPos", pct: p, name: (mSet[1] ?? "").trim() };
  }
  return null;
}

// ---------------------------------------------------------------------------
// config resolution — own credentials first, then lights, then legacy blob
// ---------------------------------------------------------------------------

function confOf(settings) {
  const own = settings && settings.plugins && settings.plugins[ID];
  const lights = settings && settings.plugins && settings.plugins["tuya-lights-control"];
  const legacy = settings && settings.tuya;
  const raw = (own && own.clientId ? own : null) || (lights && lights.clientId ? lights : null) || legacy || {};
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

  function Settings({ open, settings, updatePlugin }) {
    const conf = confOf(settings);
    const ownRaw = settings && settings.plugins && settings.plugins[ID];
    const isOwn = !!(ownRaw && ownRaw.clientId);
    const set = (patch) => updatePlugin({ ...(ownRaw || {}), ...conf, ...patch });
    const [found, setFound] = useState(null);
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const [collapsed, setCollapsed] = useState(() => {
      try { return localStorage.getItem("oc.settings.curtains.collapsed") !== "0"; } catch { return true; }
    });

    useEffect(() => {
      if (open) clearTuyaCache();
    }, [open, conf.clientId, conf.secret, conf.uid, conf.region]);

    async function find() {
      setErr("");
      setFound(null);
      setBusy(true);
      try {
        setFound(await testCreds(api, conf));
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    }

    const st = confReady(conf) ? (err ? "error — see below" : found ? `${found.length} curtain(s)` : isOwn ? "ready" : "shared with Lights") : "not configured";
    const toggle = () => setCollapsed((v) => {
      const nv = !v;
      try { localStorage.setItem("oc.settings.curtains.collapsed", nv ? "1" : "0"); } catch {}
      try { api.playSound(nv ? "collapse" : "expand"); } catch {}
      return nv;
    });
    return h("div", { className: "sound-box" },
      h("div", { className: "sound-box-head", onClick: toggle, style: { cursor: "pointer" }, "data-tip": collapsed ? "Expand" : "Collapse" },
        h("i", { className: "fa-solid fa-tent-arrow-turn-left setting-icon", style: { transform: "scaleX(-1)" } }),
        h("span", null, "Curtains"),
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
              "Same credentials as Lights (iot.tuya.com → Access ID / Secret + UID). Override here if curtains live on a different project.")),
        ),
      ),
      h("div", { className: "tuya-fields" },
        h("input", {
          className: "tuya-in",
          placeholder: "Access ID (client id)",
          value: conf.clientId,
          onChange: (e) => set({ clientId: e.target.value.trim() }),
          spellCheck: false,
        }),
        h("input", {
          className: "tuya-in",
          type: "password",
          placeholder: "Access Secret",
          value: conf.secret,
          onChange: (e) => set({ secret: e.target.value.trim() }),
          spellCheck: false,
        }),
        h("input", {
          className: "tuya-in",
          placeholder: "App account UID (Linked Accounts page)",
          value: conf.uid,
          onChange: (e) => set({ uid: e.target.value.trim() }),
          spellCheck: false,
        }),
        h("div", { className: "seg-row", role: "radiogroup", "aria-label": "Region" },
          REGIONS.map(([id2, label]) =>
            h("button", {
              key: id2,
              type: "button",
              role: "radio",
              "aria-checked": conf.region === id2,
              className: `seg${conf.region === id2 ? " on" : ""}`,
              onClick: () => set({ region: id2 }),
            }, label)),
        ),
        h("div", { className: "color-controls" },
          h("button", { type: "button", className: "reset-btn", disabled: !confReady(conf) || busy, onClick: () => void find() },
            h("i", { className: "fa-solid fa-magnifying-glass" }),
            busy ? "Checking…" : "Find curtains"),
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
                  `"${found[0] ?? "bedroom curtains"} open" · close the blinds · stop curtains · set curtains to fifty percent`)),
            ),
          )
        : null,
      )
    );
  }

  // slash handlers — called by host handleSlash when plugin slash is wired
  async function handleSlash(args) {
    const act = parseSlashArgs(args);
    if (!act) throw new Error('Usage: /curtains open|close|stop|<0-100%> [name]  e.g. "/curtains open bedroom" or "/curtains 50 bedroom"');
    return runCurtainAct(api, confOf(api.settings()), act);
  }

  return {
    parse: parseVoice,
    describe: describeCurtain,
    exec: (act) => runCurtainAct(api, confOf(api.settings()), act),
    triggers: TRIGGERS,
    vocab: VOCAB,
    lexicon: LEXICON,
    Settings,
    // host picks these up for slash autocomplete + dispatch
    slash: [
      { name: "curtains", description: "Control Tuya curtains — open/close/stop or 0-100%  (e.g. /curtains open bedroom, /curtains 50)", takesArgs: true, handle: handleSlash },
      { name: "curtains-open", description: "Open curtains [name]", takesArgs: true, handle: async (args) => runCurtainAct(api, confOf(api.settings()), { type: "curtain", sw: "open", name: (args ?? "").trim() }) },
      { name: "curtains-close", description: "Close curtains [name]", takesArgs: true, handle: async (args) => runCurtainAct(api, confOf(api.settings()), { type: "curtain", sw: "close", name: (args ?? "").trim() }) },
      { name: "curtains-stop", description: "Stop curtains [name]", takesArgs: true, handle: async (args) => runCurtainAct(api, confOf(api.settings()), { type: "curtain", sw: "stop", name: (args ?? "").trim() }) },
    ],
    info: {
      voice: [
        ["curtains open / curtains close / curtains stop", ""],
        ["open the bedroom curtains", ""],
        ["close the blinds", ""],
        ["set curtains to fifty percent", ""],
        ["curtains fifty percent", ""],
        ["blinds up / blinds down", ""],
      ],
      keys: [
        ["/curtains open [name]", "Open matching curtains"],
        ["/curtains close [name]", "Close matching curtains"],
        ["/curtains stop [name]", "Stop curtains"],
        ["/curtains 50 [name]", "Set curtains to 50%"],
      ],
    },
  };
}
