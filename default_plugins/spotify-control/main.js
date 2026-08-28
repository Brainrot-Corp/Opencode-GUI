// Spotify Controls — opencode-gui plugin (browser ESM).
// Vencord PlayerComponent style adapted to opencode glass/cyan.
// Panel lives in sidebar BEFORE GitPanel via host Sidebar slot.
// Direct Spotify Web API via http_json + PKCE (no Discord proxy).
// Auth: Settings → Client ID → Authorize → paste code → tokens stored in oc.settings.plugins["spotify-control"].
// Scopes: user-read-playback-state user-modify-playback-state user-read-currently-playing

const ID = "spotify-control";
const REDIRECT = "http://127.0.0.1:8888/callback";
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing";
const API = "https://api.spotify.com/v1/me/player";
const AUTH = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";

const DEF = {
  clientId: "",
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
  verifier: "",
  useSpotifyUris: false,
  previousButtonRestartsTrack: true,
  hoverControls: false,
  lyricsEnabled: false,
};

function confOf(settings) {
  const cur = settings && settings.plugins && settings.plugins[ID];
  if (cur && typeof cur === "object") return { ...DEF, ...cur };
  return { ...DEF };
}
function b64url(buf) {
  const b = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randVerifier() {
  const a = new Uint8Array(64);
  crypto.getRandomValues(a);
  return b64url(a).slice(0, 128);
}
async function challengeOf(v) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return b64url(d);
}
function fmt(ms) {
  if (ms == null || isNaN(ms)) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function basenameTrack(t) { return t && t.name ? t.name : ""; }

// lyrics panel persistence — mirrors notepad but own key, open+geom only
const LYRICS_KEY = "oc.spotify.lyrics";
const LYRICS_MIN_W = 360, LYRICS_MIN_H = 280, LYRICS_MAX_W = 560, LYRICS_MAX_H = 720;
function lyricsDefaultGeom() {
  const w = 420, h = 520;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const x = Math.max(12, Math.floor(vw - w - 20));
  const y = Math.max(12, Math.floor((vh - h) / 2));
  return { x, y, w, h };
}
function lyricsClamp(n,a,b){ return Math.min(Math.max(n,a),b); }
function loadLyricsState() {
  try {
    const raw = localStorage.getItem(LYRICS_KEY);
    if (!raw) return { open: false, geom: lyricsDefaultGeom() };
    const p = JSON.parse(raw);
    let g = p.geom && typeof p.geom === "object" ? p.geom : lyricsDefaultGeom();
    const vw = window.innerWidth, vh = window.innerHeight;
    g = {
      x: lyricsClamp(Number(g.x)||0, 0, Math.max(0, vw - LYRICS_MIN_W)),
      y: lyricsClamp(Number(g.y)||0, 0, Math.max(0, vh - LYRICS_MIN_H)),
      w: lyricsClamp(Number(g.w)||420, LYRICS_MIN_W, Math.min(LYRICS_MAX_W, vw - 12)),
      h: lyricsClamp(Number(g.h)||520, LYRICS_MIN_H, Math.min(LYRICS_MAX_H, vh - 12)),
    };
    return { open: !!p.open, geom: g };
  } catch { return { open: false, geom: lyricsDefaultGeom() }; }
}
function saveLyricsState(s, notify=true) {
  try { localStorage.setItem(LYRICS_KEY, JSON.stringify(s)); } catch {}
  if (notify) try { window.dispatchEvent(new CustomEvent("oc:spotify:lyrics:changed")); } catch {}
}
function lyricsEqual(a,b){ try{ return JSON.stringify(a)===JSON.stringify(b);}catch{return false;}}
// LRC parser — syncedLyrics from LRCLIB is "[mm:ss.xx] text"
function parseLRC(lrc) {
  if (!lrc || typeof lrc !== "string") return [];
  const out = [];
  for (const line of lrc.split("\n")) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[.*?\]/g, "").trim();
    if (!text) continue;
    for (const m of stamps) {
      const min = parseInt(m[1],10), sec = parseInt(m[2],10);
      const frac = m[3] ? m[3].padEnd(3,"0").slice(0,3) : "0";
      const ms = (min*60+sec)*1000 + parseInt(frac,10);
      out.push({ ms, text });
    }
  }
  out.sort((a,b)=>a.ms-b.ms);
  return out;
}

export default function activate(api) {
  const { h, useState, useEffect, useRef } = api;

  // --- token helpers -------------------------------------------------------
  // Use browser fetch for token endpoint to avoid Rust http_json Content-Type bug (empty 400) before rebuild.
  // Falls back to http_json if fetch is blocked by CSP.
  async function tokenFetch(body) {
    try {
      const res = await fetch(TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const text = await res.text();
      return { status: res.status, body: text };
    } catch (e) {
      // fallback to Rust (will work after lib.rs Content-Type fix + rebuild)
      const r = await api.invoke("http_json", {
        method: "POST",
        url: TOKEN,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      return r;
    }
  }
  async function refreshTokens(conf, updatePlugin) {
    if (!conf.refreshToken || !conf.clientId) throw new Error("no refresh token");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conf.refreshToken,
      client_id: conf.clientId,
    }).toString();
    const r = await tokenFetch(body);
    if (r.status < 200 || r.status >= 300) throw new Error(`refresh ${r.status}: ${String(r.body).slice(0,300)}`);
    let j; try { j = JSON.parse(r.body); } catch { throw new Error("bad token json: " + String(r.body).slice(0,200)); }
    if (!j.access_token) throw new Error("no access_token");
    const exp = Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600 * 1000) - 5000;
    const patch = { accessToken: j.access_token, expiresAt: exp };
    if (j.refresh_token) patch.refreshToken = j.refresh_token;
    updatePlugin(patch);
    return patch.accessToken;
  }
  async function ensureToken(conf, updatePlugin) {
    if (!conf.accessToken) throw new Error("not authorized");
    if (conf.expiresAt && Date.now() < conf.expiresAt - 60000) return conf.accessToken;
    if (!conf.refreshToken) throw new Error("token expired — re-authorize");
    return await refreshTokens(conf, updatePlugin);
  }

  async function spotifyReq(conf, updatePlugin, method, path, query, bodyObj) {
    const tok = await ensureToken(conf, updatePlugin);
    let url = API + path;
    const qp = new URLSearchParams(query || {});
    const qs = qp.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    const headers = { Authorization: `Bearer ${tok}` };
    let body = null;
    if (bodyObj) { headers["Content-Type"] = "application/json"; body = JSON.stringify(bodyObj); }
    else if (method.toUpperCase() === "PUT" || method.toUpperCase() === "POST") {
      // Spotify requires Content-Length: 0 for empty PUT/POST → 411 otherwise. Use fetch with empty body to avoid Rust rebuild.
      body = "";
    }
    // Prefer browser fetch (avoids Rust http_json 411 bug before rebuild) — fallback to http_json
    async function doFetch(hdrs, b) {
      try {
        const res = await fetch(url, { method: method.toUpperCase(), headers: hdrs, body: b ?? undefined });
        const text = await res.text();
        const ra = res.headers.get("Retry-After") || res.headers.get("retry-after") || "";
        return { status: res.status, body: text, retryAfter: ra };
      } catch (e) {
        const r = await api.invoke("http_json", { method: method.toUpperCase(), url, headers: hdrs, body: b });
        return { status: r.status, body: r.body, retryAfter: r.retryAfter || "" };
      }
    }
    let r = await doFetch(headers, body);
    if (r.status === 401) {
      const nt = await refreshTokens(conf, updatePlugin);
      const rh = { Authorization: `Bearer ${nt}` };
      if (bodyObj) rh["Content-Type"] = "application/json";
      r = await doFetch(rh, body);
      if (r.status >= 200 && r.status < 300) return r;
      // surface Spotify JSON error for 401 retry as well
      let d401 = String(r.body);
      try { const je = JSON.parse(r.body); d401 = je.error_description || je.error?.message || je.error || r.body; } catch {}
      throw new Error(`${method} ${path} → ${r.status} ${String(d401).slice(0,300)}`);
    }
    if (r.status === 429) {
      const after = parseInt(String(r.retryAfter || "").trim(), 10) || 5;
      const e = new Error(`429 Rate limited — retry after ${after}s`);
      e.retryAfter = after;
      e.status = 429;
      throw e;
    }
    if (r.status >= 200 && r.status < 300) return r;
    const snippet = String(r.body).slice(0, 600);
    // Try to surface Spotify's JSON error (403 Premium, 404 No device) instead of generic
    let detail = snippet;
    try { const je = JSON.parse(r.body); detail = je.error_description || je.error?.message || je.error || snippet; } catch {}
    if (r.status === 403) {
      try { console.warn("[spotify] 403", method, path, detail, "raw:", r.body); } catch {}
      const d = String(detail);
      if (/Restriction violated/i.test(d)) {
        throw new Error(`403 ${d.slice(0,200)} — shuffle/repeat not available for this track/device. Try playing a playlist/album on an active Premium device (not a podcast/local file/single).`);
      }
      throw new Error(`403 ${d.slice(0,300)} — if Premium, click Authorize again with the Premium account (scopes: ${SCOPES})`);
    }
    if (snippet.includes("<title>411")) throw new Error(`411 Length Required — retrying with fetch empty body failed. Try rebuilding Rust (lib.rs Content-Length fix) or restart app.`);
    throw new Error(`${r.status} ${String(detail).slice(0,400)}`);
  }

  // --- Settings (drawer) ---------------------------------------------------
  function Settings({ open, settings, updatePlugin }) {
    const conf = confOf(settings);
    const [code, setCode] = useState("");
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("idle");
    const [authUrl, setAuthUrl] = useState("");
    const [collapsed, setCollapsed] = useState(() => {
      try { return localStorage.getItem("oc.settings.spotify.collapsed") !== "0"; } catch { return true; }
    });

    useEffect(() => {
      if (!open) return;
      let dead = false;
      const tick = async () => {
        try {
          const c = confOf(api.settings());
          if (!c.accessToken) { if (!dead) setStatus("idle"); return; }
          if (c.expiresAt && Date.now() > c.expiresAt) { if (!dead) setStatus("expired"); return; }
          const r = await api.invoke("http_json", {
            method: "GET",
            url: API,
            headers: { Authorization: `Bearer ${c.accessToken}` },
            body: null,
          });
          if (dead) return;
          if (r.status === 429) {
            const after = parseInt(String(r.retryAfter || "").trim(), 10) || 5;
            setStatus(`rate limited — retry in ${after}s`);
            return;
          }
          if (r.status === 200) setStatus("connected");
          else if (r.status === 204) setStatus("no-device");
          else if (r.status === 401) setStatus("expired");
          else setStatus(`code ${r.status}`);
        } catch (e) { if (!dead) setStatus(e instanceof Error ? e.message.slice(0,80) : String(e).slice(0,80)); }
      };
      tick();
      const iv = setInterval(tick, 6000);
      return () => { dead = true; clearInterval(iv); };
    }, [open, conf.accessToken, conf.expiresAt]);

    const set = (patch) => updatePlugin({ ...conf, ...patch });

    async function startAuth() {
      if (!conf.clientId.trim()) { setErr("Set Client ID first (developer.spotify.com/dashboard)"); return; }
      setErr(""); setBusy(true);
      try {
        const verifier = randVerifier();
        const challenge = await challengeOf(verifier);
        set({ verifier });
        const params = new URLSearchParams({
          response_type: "code",
          client_id: conf.clientId.trim(),
          scope: SCOPES,
          redirect_uri: REDIRECT,
          code_challenge_method: "S256",
          code_challenge: challenge,
        });
        const url = `${AUTH}?${params.toString()}`;
        setAuthUrl(url);
        try { console.log("[spotify] authorize:", url); } catch {}
        try {
          await api.invoke("open_external", { url });
        } catch (e) {
          // fallback for old shell that splits on & — open in-app browser
          try { await api.invoke("browser_open", { url, top: 0 }); } catch {}
          setErr(`Open failed, copy URL manually: ${url}`);
          setBusy(false);
          return;
        }
        setErr("Browser opened — log in, then copy the redirected URL's ?code= value and paste below. If the browser URL was truncated (client_id not present), copy the full URL shown below and open it manually.");
      } catch (e) { setErr(String(e).slice(0,400)); }
      setBusy(false);
    }

    function extractCode(input) {
      const s = String(input).trim();
      if (!s) return "";
      // if user pasted full URL like http://127.0.0.1:8888/callback?code=ABC&state=...
      try {
        const u = new URL(s);
        const c = u.searchParams.get("code");
        if (c) return c;
      } catch {}
      // raw code or code= prefix
      const m = s.match(/code=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
      return s;
    }

    async function exchange() {
      const raw = code.trim();
      const c = extractCode(raw);
      if (!c) { setErr("Paste the ?code= value from the redirect URL (full http://127.0.0.1:8888/callback?code=… also works)"); return; }
      // read fresh verifier — captured conf may be stale after Authorize
      const cur = confOf(api.settings());
      if (!cur.verifier) { setErr("No verifier — click Authorize again (code is single-use and expires in 10 min)"); return; }
      if (!cur.clientId.trim()) { setErr("Client ID missing — paste it above"); return; }
      setBusy(true); setErr("");
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code: c,
          redirect_uri: REDIRECT,
          client_id: cur.clientId.trim(),
          code_verifier: cur.verifier,
        }).toString();
        const r = await tokenFetch(body);
        // Spotify returns JSON {error, error_description} on 400 — show full body + debug context
        if (r.status < 200 || r.status >= 300) {
          let detail = r.body || "(empty body)";
          try { const je = JSON.parse(r.body); detail = je.error_description || je.error || r.body; } catch {}
          const dbg = ` | code=${c.slice(0,12)}… len=${c.length} | verifier len=${String(cur.verifier).length} | redirect=${REDIRECT} | clientId=${cur.clientId.slice(0,6)}…`;
          const hint = r.status === 400 && /invalid_grant/i.test(detail) ? " — code expired/used or verifier/redirect mismatch. Click Authorize again for a fresh code and ensure dashboard Redirect URI is exactly " + REDIRECT : "";
          try { console.log("[spotify] token fail", r.status, detail, dbg, "raw:", r.body); } catch {}
          throw new Error(`token ${r.status}: ${String(detail).slice(0,600)}${dbg}${hint}`);
        }
        const j = JSON.parse(r.body);
        if (!j.access_token) throw new Error("no access_token in response: " + r.body.slice(0,300));
        const exp = Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600 * 1000) - 5000;
        set({ accessToken: j.access_token, refreshToken: j.refresh_token || cur.refreshToken, expiresAt: exp, verifier: "" });
        setCode(""); setAuthUrl("");
        setErr(""); setStatus("connected");
      } catch (e) {
        try { console.error("[spotify] exchange", e); } catch {}
        setErr(String(e).slice(0,1000));
      }
      setBusy(false);
    }

    const dot = status === "connected" ? "on" : status === "expired" || status.includes("401") ? "warn" : "";
    const hint = status === "connected" ? "Connecté" : status === "no-device" ? "Aucun appareil" : status === "expired" ? "Expiré" : status === "idle" ? "Non connecté" : status;
    const toggle = () => setCollapsed((v) => {
      const nv = !v;
      try { localStorage.setItem("oc.settings.spotify.collapsed", nv ? "1" : "0"); } catch {}
      try { api.playSound(nv ? "collapse" : "expand"); } catch {}
      return nv;
    });

    return h("div", { className: "sound-box spotify-box" },
      h("div", { className: "sound-box-head", onClick: toggle, style: { cursor: "pointer" }, "data-tip": collapsed ? "Expand" : "Collapse" },
        h("i", { className: "fa-brands fa-spotify setting-icon", style: { color: "var(--accent)" } }),
        h("span", null, "Spotify"),
        h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
          h("span", { className: `sp-dot ${dot}`, style: { width: "8px", height: "8px", display: "inline-block", borderRadius: "50%", background: dot === "on" ? "var(--accent)" : dot === "warn" ? "var(--danger)" : "var(--text-faint)", boxShadow: dot === "on" ? "0 0 6px var(--accent-glow)" : "none" } }),
          h("span", { className: "mono-hint" }, hint),
          h("i", { className: `fa-solid ${collapsed ? "fa-chevron-down" : "fa-chevron-up"}`, style: { fontSize: "10px", color: "var(--text-faint)", marginLeft: "6px" } })
        )
      ),
      collapsed ? null : h("div", null,
      h("div", { className: "mono-hint sp-hint", style: { padding: "6px 10px", borderBottom: "1px solid var(--line)" } },
        "Client ID from developer.spotify.com/dashboard → your app → Redirect URI must include ", h("code", null, REDIRECT), ". Premium needed for controls."
      ),
      h("div", { className: "setting-row drop" },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-id-badge setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "Client ID"),
            h("div", { className: "setting-desc mono-hint" }, "Spotify Application Client ID")
          )
        ),
        h("div", { className: "color-controls", style: { flexBasis: "100%", marginLeft: "30px" } },
          h("input", {
            className: "discord-in",
            value: conf.clientId,
            placeholder: "abc123…",
            spellCheck: false,
            onChange: (e) => set({ clientId: e.target.value.trim() }),
          })
        )
      ),
      h("div", { className: "color-controls", style: { padding: "6px 10px", display: "flex", gap: "6px", flexWrap: "wrap" } },
        h("button", { type: "button", className: "reset-btn", disabled: !conf.clientId || busy, onClick: () => void startAuth() },
          h("i", { className: "fa-solid fa-arrow-up-right-from-square" }), busy ? "…" : "Authorize"),
        h("input", {
          className: "discord-in",
          style: { flex: 1, minWidth: "160px" },
          value: code,
          placeholder: "Paste ?code=… or full redirect URL",
          spellCheck: false,
          onChange: (e) => setCode(e.target.value),
        }),
        h("button", { type: "button", className: "reset-btn", disabled: !code.trim() || busy, onClick: () => void exchange() },
          h("i", { className: "fa-solid fa-key" }), "Exchange"),
        conf.accessToken ? h("button", { type: "button", className: "reset-btn", onClick: () => { set({ accessToken: "", refreshToken: "", expiresAt: 0, verifier: "" }); setStatus("idle"); setErr(""); setAuthUrl(""); } },
          h("i", { className: "fa-solid fa-right-from-bracket" }), "Logout") : null
      ),
      authUrl ? h("div", { className: "mono-hint sp-hint", style: { margin: "0 10px", padding: "6px", border: "1px solid var(--line)", background: "rgba(255,255,255,.04)", wordBreak: "break-all", display: "flex", flexDirection: "column", gap: "6px" } },
        h("div", null, "If browser URL was truncated (client_id not present), copy this full URL and open manually:"),
        h("div", { style: { display: "flex", gap: "6px" } },
          h("input", { className: "discord-in", style: { flex: 1, fontSize: "10px" }, value: authUrl, readOnly: true, spellCheck: false, onClick: (e) => e.target.select() }),
          h("button", { type: "button", className: "reset-btn", onClick: () => { try { navigator.clipboard.writeText(authUrl); } catch {} } }, h("i", { className: "fa-solid fa-copy" }), "Copy")
        )
      ) : null,
      h("div", { className: "setting-row", style: { borderTop: "none", paddingTop: 0 } },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-sliders setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "Options"),
            h("div", { className: "setting-desc mono-hint" }, "Previous restarts track if >3s, URI vs URL")
          )
        )
      ),
      h("div", { className: "color-controls", style: { padding: "0 10px 8px", display: "flex", gap: "10px", flexWrap: "wrap" } },
        h("label", { className: "mono-hint", style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
          h("input", { type: "checkbox", checked: !!conf.previousButtonRestartsTrack, onChange: (e) => set({ previousButtonRestartsTrack: e.target.checked }) }),
          "Prev restarts if >3s"
        ),
        h("label", { className: "mono-hint", style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
          h("input", { type: "checkbox", checked: !!conf.useSpotifyUris, onChange: (e) => set({ useSpotifyUris: e.target.checked }) }),
          "Use spotify: URIs"
        ),
        h("label", { className: "mono-hint", style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
          h("input", { type: "checkbox", checked: !!conf.lyricsEnabled, onChange: (e) => {
            const on = e.target.checked;
            set({ lyricsEnabled: on });
            if (!on) {
              try {
                const s = loadLyricsState();
                if (s.open) { s.open = false; saveLyricsState(s, true); }
                window.dispatchEvent(new Event("oc:spotify:lyrics:changed"));
              } catch {}
            }
          } }),
          h("i", { className: "fa-solid fa-microphone-lines", style: { fontSize: "10px", color: "var(--accent)" } }),
          "Lyrics window (top bar icon)"
        )
      ),
      err ? h("div", { className: "voice-err", style: { margin: "0 10px 8px" } }, err) : null,
      h("div", { className: "mono-hint sp-hint" }, "After Authorize, Spotify redirects to ", h("code", null, REDIRECT), " which will fail to load — copy the address bar URL and paste it above. Tokens stored in localStorage (oc.settings.plugins.spotify-control).")
      )
    );
  }

  // --- Sidebar panel (Vencord Player style) --------------------------------
  function Sidebar({ settings, updatePlugin }) {
    const conf = confOf(settings);
    const [track, setTrack] = useState(null);
    const [device, setDevice] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [shuffle, setShuffle] = useState(false);
    const [repeat, setRepeat] = useState("off");
    const [disallows, setDisallows] = useState({});
    const [playingType, setPlayingType] = useState("track");
    const [pos, setPos] = useState(0);
    const [duration, setDuration] = useState(0);
    const [mPos, setMPos] = useState(0);
    const [startAt, setStartAt] = useState(Date.now());
    const [volume, setVolume] = useState(50);
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [hover, setHover] = useState(false);
    const [collapsed, setCollapsed] = useState(() => {
      try { return localStorage.getItem("oc.spotify.collapsed") === "1"; } catch { return false; }
    });
    const volTimer = useRef(0);
    const seekTimer = useRef(0);
    const [pending, setPending] = useState("");
    const pollRef = useRef(null);
    const [skipping, setSkipping] = useState(false);
    const lastTrackId = useRef("");
    const volumeRef = useRef(50);
    const playPausePending = useRef(0);
    const pendingPlayState = useRef(null);
    const rateLimitedUntil = useRef(0);

    const confRef = { current: conf };
    confRef.current = conf;

    function openSpotify(path) {
      const c = confRef.current;
      const url = c.useSpotifyUris ? `spotify:${path.replace(/^\//, "").replaceAll("/", ":")}` : `https://open.spotify.com${path}`;
      api.invoke("open_external", { url }).catch(() => {});
    }

    // poll player — kept in ref so controls can trigger immediate refresh
    // 429-aware: backs off on Retry-After, reduces base rate to avoid hitting limits
    useEffect(() => {
      let dead = false;
      let iv = null;
      async function poll() {
        if (Date.now() < rateLimitedUntil.current) return;
        const c = confOf(api.settings());
        if (!c.accessToken) {
          if (!dead) { setTrack(null); setDevice(null); setIsPlaying(false); setErr(""); }
          return;
        }
        try {
          if (c.expiresAt && Date.now() > c.expiresAt - 60000 && c.refreshToken) {
            try { await refreshTokens(c, (p) => updatePlugin({ ...c, ...p })); } catch {}
          }
          const cur = confOf(api.settings());
          const r = await api.invoke("http_json", {
            method: "GET",
            url: API,
            headers: { Authorization: `Bearer ${cur.accessToken}` },
            body: null,
          });
          if (dead) return;
          if (r.status === 429) {
            const after = parseInt(String(r.retryAfter || "").trim(), 10) || 5;
            rateLimitedUntil.current = Date.now() + after * 1000 + 500;
            setErr(`Rate limited — retrying in ${after}s`);
            try { console.warn("[spotify] poll 429 retryAfter", after); } catch {}
            return;
          }
          if (r.status === 204) {
            setDevice(null); setIsPlaying(false); setDisallows({}); setPlayingType("track"); setErr("");
            return;
          }
          if (r.status === 401) {
            try { await refreshTokens(cur, (p) => updatePlugin({ ...cur, ...p })); setErr(""); } catch (e) { setErr("Token expired — re-authorize in Settings"); }
            return;
          }
          if (r.status < 200 || r.status >= 300) {
            let detail = `Spotify ${r.status}`;
            try { const je = JSON.parse(r.body); detail = je.error?.message || je.error_description || je.error || detail; } catch {}
            setErr(r.status === 403 ? `${detail} — Premium required for controls. If you are Premium, click Authorize again with that account.` : detail.slice(0,120));
            try { if (r.status === 403) console.warn("[spotify] poll 403", detail, r.body); } catch {}
            return;
          }
          const j = JSON.parse(r.body);
          const item = j.item || null;
          const dev = j.device || null;
          setDevice(dev);
          // hold optimistic play/pause for 1.8s to avoid flicker (poll may return stale is_playing)
          if (Date.now() < playPausePending.current && pendingPlayState.current !== null) {
            if (!!j.is_playing === pendingPlayState.current) {
              setIsPlaying(!!j.is_playing);
              playPausePending.current = 0;
              pendingPlayState.current = null;
            }
            // else keep optimistic state — don't flip back yet
          } else {
            setIsPlaying(!!j.is_playing);
            if (pendingPlayState.current !== null && !!j.is_playing === pendingPlayState.current) {
              playPausePending.current = 0;
              pendingPlayState.current = null;
            }
          }
          setShuffle(!!j.shuffle_state);
          setRepeat(j.repeat_state || "off");
          setDisallows(j.actions?.disallows || {});
          setPlayingType(j.currently_playing_type || "track");
          if (!volTimer.current) setVolume(typeof j.device?.volume_percent === "number" ? j.device.volume_percent : volume);
          if (!seekTimer.current) { setMPos(j.progress_ms ?? 0); setStartAt(Date.now()); }
          setErr("");
          if (!item) { setTrack(null); setDuration(0); if (!seekTimer.current) setPos(0); setSkipping(false); return; }
          const t = {
            id: item.id || "",
            name: item.name || "",
            duration: item.duration_ms || 0,
            artists: (item.artists || []).map((a) => ({ id: a.id || "", name: a.name || "", uri: a.uri || "" })),
            album: {
              id: item.album?.id || "",
              name: item.album?.name || "",
              image: (item.album?.images && item.album.images[0]) ? item.album.images[0] : null,
            },
          };
          // clear skipping as soon as Spotify reports a new track id
          if (lastTrackId.current && t.id && t.id !== lastTrackId.current) setSkipping(false);
          setTrack(t);
          setDuration(t.duration);
          if (!seekTimer.current) setPos(j.progress_ms ?? 0);
        } catch (e) {
          if (!dead) setErr(e instanceof Error ? e.message.slice(0,120) : String(e).slice(0,120));
        }
      }
      pollRef.current = poll;
      poll();
      // Reduced from 500ms to 1500ms to stay well under Spotify rate limits (429).
      // Burst on controls is also trimmed from 6 to 3 polls.
      const baseIv = 1500;
      iv = setInterval(poll, baseIv);
      const onVis = () => { if (document.visibilityState === "visible") void poll(); };
      document.addEventListener("visibilitychange", onVis);
      return () => { dead = true; if (iv) clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
    }, [conf.accessToken, conf.refreshToken]);
    function triggerQuickPoll() {
      const p = pollRef.current;
      if (!p) return;
      if (Date.now() < rateLimitedUntil.current) return;
      [300, 900, 1600].forEach((d) => setTimeout(() => void p(), d));
    }

    // tick position while playing
    useEffect(() => {
      if (!isPlaying) return;
      const iv = setInterval(() => {
        const elapsed = Date.now() - startAt;
        const p = mPos + elapsed;
        setPos(Math.min(p, duration || p));
      }, 1000);
      return () => clearInterval(iv);
    }, [isPlaying, mPos, startAt, duration]);

    // keep pos in sync when mPos changes
    useEffect(() => { setPos(mPos); }, [mPos]);

    // lyrics overlay sync — broadcast track + playback state (pos ticks each second while playing)
    useEffect(() => {
      try { window.dispatchEvent(new CustomEvent("oc:spotify:state", { detail: { track, device, isPlaying, pos, duration, playingType } })); } catch {}
      try { window.__spotify_state = { track, device, isPlaying, pos, duration, playingType }; } catch {}
    }, [track, device, isPlaying, pos, duration, playingType]);

    // non-blocking req — instant feedback + quick poll burst (reduced to 3)
    async function req(method, path, query, opts) {
      const c = confOf(api.settings());
      const key = `${method}:${path}`;
      if (Date.now() < rateLimitedUntil.current) {
        const sec = Math.ceil((rateLimitedUntil.current - Date.now()) / 1000);
        setErr(`Rate limited — retrying in ${sec}s`);
        setTimeout(() => setPending((v) => v === key ? "" : v), 400);
        return;
      }
      setPending(key);
      try {
        await spotifyReq(c, (p) => updatePlugin({ ...c, ...p }), method, path, query, null);
        setErr("");
        triggerQuickPoll();
        if (opts && opts.silent) return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const after = e && typeof e.retryAfter === "number" ? e.retryAfter : (parseInt((msg.match(/retry after (\d+)/i) || [])[1] || "", 10) || 0);
        if (after) {
          rateLimitedUntil.current = Date.now() + after * 1000 + 500;
          setErr(`Rate limited — retrying in ${after}s`);
          try { console.warn("[spotify] 429", method, path, after); } catch {}
        } else if (msg.includes("403")) setErr(msg.slice(0,220));
        else if (msg.includes("404")) setErr("No active device — open Spotify on a device");
        else if (!msg.includes("411") && !msg.includes("429")) setErr(msg.slice(0,160));
        try { if (msg.includes("403")) console.warn("[spotify] req 403", msg); } catch {}
      } finally {
        setTimeout(() => setPending((v) => v === key ? "" : v), 600);
      }
    }

    const doPrev = () => {
      const c = confRef.current;
      if (track) lastTrackId.current = track.id;
      setSkipping(true); setTimeout(() => setSkipping(false), 2200);
      if (c.previousButtonRestartsTrack && pos > 3000) {
        setPos(0); setMPos(0); setStartAt(Date.now());
        void req("put", "/seek", { position_ms: 0, ...(device?.id ? { device_id: device.id } : {}) });
      } else {
        void req("post", "/previous", device?.id ? { device_id: device.id } : {});
      }
      triggerQuickPoll();
    };
    const doNext = () => {
      if (track) lastTrackId.current = track.id;
      setSkipping(true); setTimeout(() => setSkipping(false), 2200);
      void req("post", "/next", device?.id ? { device_id: device.id } : {});
      triggerQuickPoll();
    };
    const doPlayPause = () => {
      const next = !isPlaying;
      pendingPlayState.current = next;
      playPausePending.current = Date.now() + 1800;
      setIsPlaying(next);
      void req("put", next ? "/play" : "/pause", device?.id ? { device_id: device.id } : {});
      // clear pending after Spotify should have updated (poll burst will confirm)
      setTimeout(() => { if (Date.now() >= playPausePending.current) pendingPlayState.current = null; }, 2000);
    };
    const canShuffle = !disallows.toggling_shuffle && playingType !== "episode" && !!device;
    const canRepeat = !disallows.toggling_repeat_context && !disallows.toggling_repeat_track && playingType !== "episode" && !!device;
    const doShuffle = () => {
      if (!canShuffle) {
        setErr("Shuffle not available for this playback (podcast/local/single or device restriction)");
        setTimeout(() => setErr(""), 2500);
        return;
      }
      const ns = !shuffle;
      setShuffle(ns);
      void req("put", "/shuffle", { state: String(ns), ...(device?.id ? { device_id: device.id } : {}) });
    };
    const doRepeat = () => {
      if (!canRepeat) {
        setErr("Repeat not available for this playback (podcast/local/single or device restriction)");
        setTimeout(() => setErr(""), 2500);
        return;
      }
      const nxt = repeat === "off" ? "context" : repeat === "context" ? "track" : "off";
      setRepeat(nxt);
      void req("put", "/repeat", { state: nxt, ...(device?.id ? { device_id: device.id } : {}) });
    };
    const doSeek = (ms) => {
      setPos(ms); setMPos(ms); setStartAt(Date.now());
      clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => {
        seekTimer.current = 0;
        void req("put", "/seek", { position_ms: Math.round(ms), ...(device?.id ? { device_id: device.id } : {}) });
      }, 180);
    };
    // keep ref in sync for wheel smooth stepping
    useEffect(() => { volumeRef.current = volume; }, [volume]);
    const doVolume = (v) => {
      const nv = Math.max(0, Math.min(100, Math.round(v)));
      volumeRef.current = nv;
      setVolume(nv);
      clearTimeout(volTimer.current);
      volTimer.current = setTimeout(() => {
        volTimer.current = 0;
        void req("put", "/volume", { volume_percent: nv, ...(device?.id ? { device_id: device.id } : {}) });
      }, 500);
    };
    const doVolumeWheel = (e) => {
      e.preventDefault();
      // smooth 2% per tick, use pending ref so rapid wheel doesn't use stale closure volume
      const cur = volumeRef.current;
      const delta = e.deltaY > 0 ? -2 : 2;
      // accumulate small delta for high-res wheels (deltaY can be 100+)
      const steps = Math.max(1, Math.min(3, Math.round(Math.abs(e.deltaY) / 50)));
      const nv = Math.max(0, Math.min(100, cur + delta * steps));
      doVolume(nv);
    };

    const hasToken = !!conf.accessToken;
    const dotCls = !hasToken ? "" : isPlaying ? "on" : device ? "on" : "warn";
    const statusTxt = !hasToken ? "Not connected" : !device ? "No device" : isPlaying ? "Playing" : "Paused";

    const toggleCollapsed = () => setCollapsed((v) => { const nv = !v; try { localStorage.setItem("oc.spotify.collapsed", nv ? "1" : "0"); } catch {} try { api.playSound(nv ? "collapse" : "expand"); } catch {} return nv; });
    if (!hasToken) {
      return h("div", { className: "sp-panel", onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) },
        h("div", { className: "sp-head", onClick: toggleCollapsed, style: { cursor: "pointer" }, "data-tip": collapsed ? "Expand player" : "Collapse to title + track" },
          h("i", { className: "fa-brands fa-spotify" }), h("span", null, "Spotify"),
          h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
            h("span", { className: `sp-dot ${dotCls}`, "data-tip": statusTxt }),
            h("span", { className: "mono-hint", style: { fontSize: "10px" } }, statusTxt),
            h("button", { className: "icon-btn", style: { width: "22px", height: "22px", marginLeft: "4px" }, onClick: (e) => { e.stopPropagation(); toggleCollapsed(); }, "data-tip": collapsed ? "Expand" : "Collapse", "aria-label": collapsed ? "Expand" : "Collapse" },
              h("i", { className: `fa-solid ${collapsed ? "fa-chevron-down" : "fa-chevron-up"}`, style: { fontSize: "10px" } }))
          )
        ),
        collapsed ? null : h("div", { className: "sp-empty" }, "Not connected — set Client ID and Authorize in Settings (puzzle → Spotify)."),
        collapsed ? null : h("div", { className: "mono-hint sp-hint" }, "Need Premium for controls. Redirect URI: ", h("code", null, REDIRECT))
      );
    }

    const pct = duration ? Math.max(0, Math.min(100, (pos / duration) * 100)) : 0;

    return h("div", { className: "sp-panel", onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) },
      h("div", { className: "sp-head", onClick: toggleCollapsed, style: { cursor: "pointer" }, "data-tip": collapsed ? "Expand player" : "Collapse to title + track" },
        h("i", { className: "fa-brands fa-spotify" }), h("span", null, "Spotify"),
        h("div", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
          h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
            h("span", { className: `sp-dot ${dotCls}`, "data-tip": statusTxt }),
            h("span", { className: "mono-hint", style: { fontSize: "10px", color: isPlaying ? "var(--accent)" : "var(--text-faint)" } }, statusTxt)
          ),
          h("button", { className: "icon-btn", style: { width: "22px", height: "22px" }, onClick: (e) => { e.stopPropagation(); toggleCollapsed(); }, "data-tip": collapsed ? "Expand" : "Collapse", "aria-label": collapsed ? "Expand" : "Collapse" },
            h("i", { className: `fa-solid ${collapsed ? "fa-chevron-down" : "fa-chevron-up"}`, style: { fontSize: "10px" } }))
        )
      ),
      collapsed ? (
        !track ? h("div", { className: "sp-empty", style: { padding: "2px 0" } }, device ? "Nothing playing" : "No active device") :
        h("div", { id: "sp-info", style: { padding: "2px 0", minHeight: "auto", gap: "6px", alignItems: "center", ...(skipping ? { opacity: "0.45" } : null) } },
          track.album.image ? h("img", {
            id: "sp-album", style: { width: "32px", height: "32px", borderRadius: "3px", flexShrink: "0" },
            src: track.album.image.url, alt: "cover",
            onClick: () => openSpotify(`/album/${track.album.id}`),
            "data-tip": track.album.name,
          }) : h("div", { id: "sp-album", style: { width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)", background: "rgba(255,255,255,.06)", borderRadius: "3px", flexShrink: "0" } }, h("i", { className: "fa-solid fa-music" })),
          h("div", { id: "sp-titles", style: { gap: "1px", flex: "1", minWidth: "0" } },
            h("div", { id: "sp-title", className: "sp-ellip", "data-tip": track.name, style: { fontSize: "12px" }, ...(track.id ? { role: "link", onClick: () => openSpotify(`/track/${track.id}`) } : {}) }, track.name),
            track.artists.length ? h("div", { className: "sp-secondary sp-ellip", "data-tip": track.artists.map((a) => a.name).join(", "), style: { fontSize: "10px" } },
              h("span", null, `${track.artists.map((a) => a.name).join(", ")}`)
            ) : null,
            track.album.name ? h("div", { className: "sp-secondary sp-ellip", "data-tip": track.album.name, style: { fontSize: "10px" } },
              h("span", { style: { color: "var(--text-faint)" } }, `${track.album.name}`)
            ) : null
          ),
          h("div", { style: { display: "inline-flex", gap: "4px", alignItems: "center", flexShrink: "0", marginLeft: "6px" } },
            h("button", { className: "sp-btn", style: { width: "28px", height: "28px", fontSize: "11px" }, onClick: doPrev, disabled: !device, "data-tip": "Previous", "aria-label": "Previous" },
              h("i", { className: "fa-solid fa-backward-step" })),
            h("button", { className: `sp-btn ${isPlaying ? "on" : ""}`, style: { width: "28px", height: "28px", fontSize: "11px", borderRadius: "4px" }, onClick: doPlayPause, disabled: !device, "data-tip": isPlaying ? "Pause" : "Play", "aria-label": isPlaying ? "Pause" : "Play" },
              h("i", { className: `fa-solid ${isPlaying ? "fa-pause" : "fa-play"}` })),
            h("button", { className: "sp-btn", style: { width: "28px", height: "28px", fontSize: "11px" }, onClick: doNext, disabled: !device, "data-tip": "Next", "aria-label": "Next" },
              h("i", { className: "fa-solid fa-forward-step" })),
            h("button", {
              className: "sp-btn", style: { width: "28px", height: "28px", fontSize: "11px", borderRadius: "4px" },
              onClick: () => { const nv = volumeRef.current > 0 ? 0 : 50; doVolume(nv); },
              onWheel: doVolumeWheel,
              "data-tip": `Volume ${Math.round(volume)}% — scroll`, "aria-label": "Volume",
              disabled: !device
            }, h("i", { className: volume === 0 ? "fa-solid fa-volume-xmark" : volume < 50 ? "fa-solid fa-volume-low" : "fa-solid fa-volume-high" }))
          )
        )
      ) : (
        !track ? h("div", { className: "sp-empty" }, device ? "Nothing playing — start playback in Spotify" : "No active device — open Spotify on a device") :
        h("div", { id: "sp-info", style: skipping ? { opacity: "0.45" } : null },
          track.album.image ? h("img", {
            id: "sp-album", className: expanded ? "expanded" : "",
            src: track.album.image.url, alt: "cover",
            onClick: () => setExpanded((v) => !v),
            onContextMenu: (e) => {
              e.preventDefault();
              openSpotify(`/album/${track.album.id}`);
            },
            "data-tip": "Click to expand, right-click to open album",
          }) : h("div", { id: "sp-album", style: { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)" } }, h("i", { className: "fa-solid fa-music" })),
          h("div", { id: "sp-titles" },
            h("div", {
              id: "sp-title", className: "sp-ellip", "data-tip": track.name,
              ...(track.id ? { role: "link", onClick: () => openSpotify(`/track/${track.id}`) } : {}),
            }, track.name),
            track.artists.length ? h("div", { className: "sp-secondary sp-ellip", "data-tip": track.artists.map((a) => a.name).join(", ") },
              h("span", { className: "sp-prefix" }, "by "), ...track.artists.map((a, i) =>
                h("span", {
                  key: a.id || a.name, className: "sp-artist",
                  ...(a.id ? { role: "link", onClick: () => openSpotify(`/artist/${a.id}`) } : {}),
                  "data-tip": a.name,
                }, a.name + (i < track.artists.length - 1 ? ", " : ""))
              )
            ) : null,
            track.album.name ? h("div", { className: "sp-secondary sp-ellip" },
              h("span", { className: "sp-prefix" }, "on "),
              h("span", {
                id: "sp-album-name", className: "sp-ellip",
                ...(track.album.id ? { role: "link", onClick: () => openSpotify(`/album/${track.album.id}`) } : {}),
                "data-tip": track.album.name,
              }, track.album.name)
            ) : null
          )
        )
      ),
      collapsed ? null : track ? h("div", { id: "sp-progress" },
        h("span", { className: "sp-time" }, fmt(pos)),
        h("div", { className: "sp-bar", onClick: (e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const r = (e.clientX - rect.left) / rect.width;
          doSeek(Math.round(r * duration));
        } },
          h("div", { className: "sp-fill", style: { width: `${pct}%` } }),
          h("div", { className: "sp-grabber", style: { left: `${pct}%` } }),
          h("input", {
            className: "sp-range", type: "range", min: 0, max: duration || 100, value: Math.min(pos, duration || pos),
            onChange: (e) => doSeek(Number(e.target.value)),
          })
        ),
        h("span", { className: "sp-time" }, fmt(duration))
      ) : null,
      collapsed ? null : track ? h("div", { className: "sp-row" },
        h("button", { className: `sp-btn ${shuffle ? "on" : ""}`, onClick: doShuffle, disabled: !canShuffle, "data-tip": !canShuffle ? "Shuffle not available for this playback" : shuffle ? "Shuffle on" : "Shuffle off", "aria-label": "Shuffle" },
          h("i", { className: "fa-solid fa-shuffle" })),
        h("button", { className: "sp-btn", onClick: doPrev, disabled: !device, "data-tip": "Previous (restarts if >3s)", "aria-label": "Previous" },
          h("i", { className: "fa-solid fa-backward-step" })),
        h("button", { className: `sp-btn ${isPlaying ? "on" : ""}`, style: { borderRadius: "4px", boxShadow: isPlaying ? "0 0 4px var(--accent-glow), inset 0 0 10px -6px var(--accent-glow)" : "none" }, onClick: doPlayPause, disabled: !device, "data-tip": isPlaying ? "Pause" : "Play", "aria-label": isPlaying ? "Pause" : "Play" },
          h("i", { className: `fa-solid ${isPlaying ? "fa-pause" : "fa-play"}` })),
        h("button", { className: "sp-btn", onClick: doNext, disabled: !device, "data-tip": "Next", "aria-label": "Next" },
          h("i", { className: "fa-solid fa-forward-step" })),
        h("button", {
          className: `sp-btn ${repeat !== "off" ? "on" : ""}`, onClick: doRepeat, disabled: !canRepeat, "data-tip": !canRepeat ? "Repeat not available for this playback" : repeat === "off" ? "Repeat off" : repeat === "context" ? "Repeat all" : "Repeat one", "aria-label": "Repeat", style: { position: "relative" }
        },
          h("i", { className: "fa-solid fa-repeat" }),
          repeat === "track" ? h("span", { className: "sp-one" }, "1") : null
        )
      ) : null,
      collapsed ? null : track ? h("div", { className: "sp-vol", onWheel: doVolumeWheel },
        h("i", { className: "fa-solid fa-volume-high", "data-tip": `Volume ${Math.round(volume)}%` }),
        h("div", { className: "sp-bar", style: { flex: "1", height: "3px", position: "relative" }, onClick: (e) => { const rect = e.currentTarget.getBoundingClientRect(); const r = (e.clientX - rect.left) / rect.width; doVolume(Math.round(r * 100)); } },
          h("div", { className: "sp-fill", style: { width: `${Math.round(volume)}%`, background: "var(--accent)" } }),
          h("div", { className: "sp-grabber", style: { left: `${Math.round(volume)}%` } }),
          h("input", { className: "sp-range", type: "range", min: 0, max: 100, step: 1, value: Math.round(volume), onInput: (e) => doVolume(Number(e.target.value)), onChange: (e) => doVolume(Number(e.target.value)), "data-tip": `${Math.round(volume)}% — scroll to adjust` })
        ),
        h("span", { className: "mono-hint", style: { minWidth: "28px", textAlign: "right", fontSize: "10px" } }, `${Math.round(volume)}%`)
      ) : null,
      err ? h("div", { className: "sp-err" }, err) : null
    );
  }

  function TitlebarBtn({ settings }) {
    const conf = confOf(settings);
    if (!conf.lyricsEnabled) return null;
    const [open, setOpen] = useState(() => loadLyricsState().open);
    useEffect(() => {
      const sync = () => setOpen(loadLyricsState().open);
      window.addEventListener("oc:spotify:lyrics:changed", sync);
      window.addEventListener("storage", sync);
      return () => { window.removeEventListener("oc:spotify:lyrics:changed", sync); window.removeEventListener("storage", sync); };
    }, []);
    const toggle = () => {
      const s = loadLyricsState();
      s.open = !s.open;
      saveLyricsState(s, true);
      setOpen(s.open);
      try { api.playSound(s.open ? "expand" : "collapse"); } catch {}
    };
    return h("button", {
      className: `icon-btn${open ? " on" : ""}`,
      "data-tip": open ? "Hide lyrics" : "Show lyrics",
      "aria-pressed": open,
      onClick: toggle
    }, h("i", { className: "fa-solid fa-microphone-lines" }));
  }

  function LyricsOverlay({ settings, updatePlugin }) {
    const conf = confOf(settings);
    const [lState, setLState] = useState(() => loadLyricsState());
    const panelRef = useRef(null);
    const bodyRef = useRef(null);
    const dragRef = useRef(null);
    const resizeRef = useRef(null);
    const cacheRef = useRef(new Map());
    const [lyrics, setLyrics] = useState({ loading: false, error: "", plain: "", synced: "", lines: [], instrumental: false, syncedAvailable: false, notFound: false });
    const [curTrack, setCurTrack] = useState(() => { try { return (window.__spotify_state && window.__spotify_state.track) || null; } catch { return null; } });
    const [curDevice, setCurDevice] = useState(() => { try { return (window.__spotify_state && window.__spotify_state.device) || null; } catch { return null; } });
    const [curPos, setCurPos] = useState(() => { try { return (window.__spotify_state && typeof window.__spotify_state.pos === "number") ? window.__spotify_state.pos : 0; } catch { return 0; } });
    const [curIsPlaying, setCurIsPlaying] = useState(() => { try { return !!(window.__spotify_state && window.__spotify_state.isPlaying); } catch { return false; } });
    const [activeIdx, setActiveIdx] = useState(-1);

    // sync panel open/geom from storage (other instance / titlebar)
    useEffect(() => {
      const sync = () => {
        const nxt = loadLyricsState();
        setLState(prev => lyricsEqual(prev, nxt) ? prev : nxt);
      };
      window.addEventListener("oc:spotify:lyrics:changed", sync);
      window.addEventListener("storage", sync);
      return () => { window.removeEventListener("oc:spotify:lyrics:changed", sync); window.removeEventListener("storage", sync); };
    }, []);

    // viewport clamp on resize
    useEffect(() => {
      const onResize = () => {
        const vw = window.innerWidth, vh = window.innerHeight;
        setLState(s => {
          const g = s.geom;
          const nx = lyricsClamp(g.x, 0, Math.max(0, vw - LYRICS_MIN_W));
          const ny = lyricsClamp(g.y, 0, Math.max(0, vh - LYRICS_MIN_H));
          const nw = lyricsClamp(g.w, LYRICS_MIN_W, Math.min(LYRICS_MAX_W, vw - 12));
          const nh = lyricsClamp(g.h, LYRICS_MIN_H, Math.min(LYRICS_MAX_H, vh - 12));
          if (nx===g.x && ny===g.y && nw===g.w && nh===g.h) return s;
          const nxt = { ...s, geom: { x: nx, y: ny, w: nw, h: nh } };
          saveLyricsState(nxt, false);
          return nxt;
        });
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, []);

    // listen to player state broadcasts from Sidebar
    useEffect(() => {
      const onState = (e) => {
        const d = e && e.detail;
        if (!d) return;
        if (d.track !== undefined) setCurTrack(d.track);
        if (d.device !== undefined) setCurDevice(d.device);
        if (typeof d.pos === "number") setCurPos(d.pos);
        if (typeof d.isPlaying === "boolean") setCurIsPlaying(d.isPlaying);
      };
      window.addEventListener("oc:spotify:state", onState);
      return () => window.removeEventListener("oc:spotify:state", onState);
    }, []);

    // escape closes panel
    useEffect(() => {
      if (!lState.open) return;
      const onKey = (e) => {
        if (e.key === "Escape") {
          const s = loadLyricsState(); s.open=false; saveLyricsState(s,true); setLState(s);
          try { api.playSound("collapse"); } catch {}
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [lState.open]);

    // lyrics fetch helper with http_json fallback (mirrors tokenFetch)
    async function lyricsFetch(url) {
      try {
        const res = await fetch(url);
        const text = await res.text();
        return { status: res.status, body: text };
      } catch (e) {
        try {
          const r = await api.invoke("http_json", { method: "GET", url, headers: {}, body: null });
          return r;
        } catch (err) { return { status: 0, body: String(err) }; }
      }
    }

    // fetch when track id changes
    const lastFetchId = useRef("");
    useEffect(() => {
      const t = curTrack;
      if (!t || !t.id) { setLyrics({ loading:false, error:"", plain:"", synced:"", lines:[], instrumental:false, syncedAvailable:false, notFound:false }); lastFetchId.current=""; setActiveIdx(-1); return; }
      if (lastFetchId.current === t.id) return;
      lastFetchId.current = t.id;
      const cached = cacheRef.current.get(t.id);
      if (cached) { setLyrics(cached); setActiveIdx(-1); return; }
      let cancelled = false;
      (async () => {
        setLyrics({ loading:true, error:"", plain:"", synced:"", lines:[], instrumental:false, syncedAvailable:false, notFound:false });
        const artist = (t.artists||[]).map(a=>a.name).join(", ");
        const durSec = Math.round((t.duration||0)/1000);
        const q1 = new URLSearchParams({ artist_name: artist, track_name: t.name, album_name: (t.album && t.album.name) || "", duration: String(durSec) }).toString();
        const url1 = `https://lrclib.net/api/get?${q1}`;
        try {
          let r = await lyricsFetch(url1);
          if (!cancelled && r.status===200) {
            let j=null; try{ j=JSON.parse(r.body); }catch{}
            if (j && (j.plainLyrics || j.syncedLyrics)) {
              const synced = parseLRC(j.syncedLyrics||"");
              const plain = j.plainLyrics||"";
              const data = { loading:false, error:"", plain, synced: j.syncedLyrics||"", lines: synced.length ? synced : plain.split("\n").filter(s=>s.trim()).map(txt=>({ms:0,text:txt})), instrumental: !!j.instrumental, syncedAvailable: synced.length>0, notFound:false };
              cacheRef.current.set(t.id, data);
              if(!cancelled) setLyrics(data);
              return;
            }
          }
          const q2 = new URLSearchParams({ track_name: t.name, artist_name: artist }).toString();
          const url2 = `https://lrclib.net/api/search?${q2}`;
          r = await lyricsFetch(url2);
          if (!cancelled && r.status===200) {
            let arr=null; try{ arr=JSON.parse(r.body); }catch{ arr=null; }
            if (Array.isArray(arr) && arr.length) {
              let best = arr[0];
              const lower = (t.name||"").toLowerCase();
              const exact = arr.find(x=> (x.trackName||"").toLowerCase()===lower);
              if (exact) best = exact;
              else {
                // closest duration
                let bestDiff = Infinity;
                for(const c of arr){ const d = Math.abs(((c.duration||0) - durSec)); if(d<bestDiff){bestDiff=d; best=c;} }
              }
              const synced = parseLRC(best.syncedLyrics||"");
              const plain = best.plainLyrics||"";
              if (plain || synced.length) {
                const data = { loading:false, error:"", plain, synced: best.syncedLyrics||"", lines: synced.length ? synced : plain.split("\n").filter(s=>s.trim()).map(txt=>({ms:0,text:txt})), instrumental: !!best.instrumental, syncedAvailable: synced.length>0, notFound:false };
                cacheRef.current.set(t.id, data);
                if(!cancelled) setLyrics(data);
                return;
              }
            }
          }
          const data = { loading:false, error:"", plain:"", synced:"", lines:[], instrumental:false, syncedAvailable:false, notFound:true };
          cacheRef.current.set(t.id, data);
          if(!cancelled) setLyrics(data);
        } catch (e) {
          if(!cancelled) setLyrics({ loading:false, error: e instanceof Error ? e.message.slice(0,180) : String(e).slice(0,180), plain:"", synced:"", lines:[], instrumental:false, syncedAvailable:false, notFound:false });
        }
      })();
      return () => { cancelled = true; };
    }, [curTrack && curTrack.id]);

    // compute active synced line from pos
    useEffect(() => {
      const lines = lyrics.lines;
      if (!lyrics.syncedAvailable || !lines || !lines.length) { setActiveIdx(-1); return; }
      let idx = -1;
      for(let i=0;i<lines.length;i++){ if(curPos >= lines[i].ms) idx=i; else break; }
      setActiveIdx(idx);
    }, [curPos, lyrics.lines, lyrics.syncedAvailable]);

    // auto-scroll active line into view (centered)
    useEffect(() => {
      if (activeIdx < 0) return;
      const c = bodyRef.current;
      if (!c) return;
      const el = c.querySelector(`[data-idx="${activeIdx}"]`);
      if (el && typeof el.scrollIntoView === "function") {
        try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { try{ el.scrollIntoView(); }catch{} }
      }
    }, [activeIdx]);

    async function seekTo(ms) {
      const c = confOf(api.settings());
      if (!c.accessToken) return;
      try {
        await spotifyReq(c, (patch)=> updatePlugin({ ...c, ...patch }), "PUT", "/seek", { position_ms: Math.round(ms), ...(curDevice && curDevice.id ? { device_id: curDevice.id } : {}) }, null);
        setCurPos(ms);
      } catch (e) {}
    }

    const onDragStart = (e) => {
      if (e.button!==0) return;
      if (e.target.closest("button, input, a")) return;
      e.preventDefault();
      const el = panelRef.current; if(!el) return;
      const startX=e.clientX, startY=e.clientY;
      const g0={...lState.geom};
      dragRef.current={startX,startY,g0};
      document.body.style.userSelect="none";
      let raf=0, last={x:g0.x, y:g0.y};
      const flush=()=>{ raf=0; el.style.left=last.x+"px"; el.style.top=last.y+"px"; };
      const move=(ev)=>{
        const d=dragRef.current; if(!d) return;
        last.x = lyricsClamp(d.g0.x + (ev.clientX - d.startX), 0, Math.max(0, window.innerWidth - g0.w));
        last.y = lyricsClamp(d.g0.y + (ev.clientY - d.startY), 0, Math.max(0, window.innerHeight - 80));
        if(!raf) raf=requestAnimationFrame(flush);
      };
      const up=()=>{
        if(raf) cancelAnimationFrame(raf);
        el.style.left=last.x+"px"; el.style.top=last.y+"px";
        setLState(s=>{
          if(s.geom.x===last.x && s.geom.y===last.y) return s;
          const nxt={...s, geom:{...s.geom, x:last.x, y:last.y}};
          saveLyricsState(nxt, true);
          return nxt;
        });
        dragRef.current=null;
        document.body.style.userSelect="";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    const onResizeStart = (dir)=>(e)=>{
      if(e.button!==0) return;
      e.preventDefault(); e.stopPropagation();
      const el=panelRef.current; if(!el) return;
      const sx=e.clientX, sy=e.clientY;
      const g0={...lState.geom};
      resizeRef.current={dir,sx,sy,g0};
      document.body.style.userSelect="none";
      let raf=0, last={...g0};
      const flush=()=>{ raf=0; el.style.left=last.x+"px"; el.style.top=last.y+"px"; el.style.width=last.w+"px"; el.style.height=last.h+"px"; };
      const move=(ev)=>{
        const r=resizeRef.current; if(!r) return;
        let {x,y,w,h}=r.g0;
        const dx=ev.clientX - r.sx, dy=ev.clientY - r.sy;
        if(r.dir.includes("e")) w = lyricsClamp(g0.w + dx, LYRICS_MIN_W, Math.min(LYRICS_MAX_W, window.innerWidth - x - 6));
        if(r.dir.includes("s")) h = lyricsClamp(g0.h + dy, LYRICS_MIN_H, Math.min(LYRICS_MAX_H, window.innerHeight - y - 6));
        if(r.dir.includes("w")){ const nw=lyricsClamp(g0.w - dx, LYRICS_MIN_W, g0.x + g0.w); x = g0.x + g0.w - nw; w=nw; x=lyricsClamp(x,0,window.innerWidth - LYRICS_MIN_W); }
        if(r.dir.includes("n")){ const nh=lyricsClamp(g0.h - dy, LYRICS_MIN_H, g0.y + g0.h); y = g0.y + g0.h - nh; h=nh; y=lyricsClamp(y,0,window.innerHeight - LYRICS_MIN_H); }
        last={x,y,w,h};
        if(!raf) raf=requestAnimationFrame(flush);
      };
      const up=()=>{
        if(raf) cancelAnimationFrame(raf);
        el.style.left=last.x+"px"; el.style.top=last.y+"px"; el.style.width=last.w+"px"; el.style.height=last.h+"px";
        setLState(s=>{
          if(lyricsEqual(s.geom,last)) return s;
          const nxt={...s, geom:last};
          saveLyricsState(nxt, true);
          return nxt;
        });
        resizeRef.current=null;
        document.body.style.userSelect="";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    if (!conf.lyricsEnabled) return null;
    if (!lState.open) return null;

    const geom = lState.geom;
    const trackLabel = curTrack ? `${curTrack.name} — ${(curTrack.artists||[]).map(a=>a.name).join(", ")}` : "";
    const hasTrack = !!curTrack;

    const closePanel = () => {
      const s={...lState, open:false};
      saveLyricsState(s,true); setLState(s);
      try{ api.playSound("collapse"); }catch{}
    };

    let body;
    if (!hasTrack) {
      body = h("div", { className:"lyrics-empty" }, "No track — start playback in Spotify");
    } else if (lyrics.loading) {
      body = h("div", { className:"lyrics-empty" }, h("i", { className:"fa-solid fa-spinner fa-spin", style:{marginRight:"6px"} }), "Loading lyrics…");
    } else if (lyrics.instrumental) {
      body = h("div", { className:"lyrics-empty" }, h("i", { className:"fa-solid fa-music", style:{marginRight:"6px"} }), "Instrumental — no lyrics");
    } else if (lyrics.error) {
      body = h("div", { className:"sp-err", style:{margin:"8px"} }, lyrics.error);
    } else if (lyrics.notFound) {
      body = h("div", { className:"lyrics-empty", style:{ display:"flex", flexDirection:"column", gap:"8px", alignItems:"center"} },
        h("span", null, "No lyrics found on LRCLIB"),
        h("button", { className:"reset-btn", onClick:()=>{ const q = encodeURIComponent(`${(curTrack.artists||[]).map(a=>a.name).join(" ")} ${curTrack.name}`); api.invoke("open_external",{url:`https://genius.com/search?q=${q}`}).catch(()=>{}); } }, h("i",{className:"fa-solid fa-arrow-up-right-from-square"}), " Search Genius")
      );
    } else if (lyrics.syncedAvailable && lyrics.lines.length) {
      body = h("div", { ref: bodyRef, className:"lyrics-body synced" },
        ...lyrics.lines.map((ln,i)=>{
          const isActive = i===activeIdx;
          const isPast = i<activeIdx;
          const cls = `lyrics-line${isActive?" on":""}${isPast?" past":""}`;
          return h("div", { key:i, "data-idx":i, className:cls, onClick:()=> void seekTo(ln.ms), "data-tip": `Seek to ${fmt(ln.ms)}` }, ln.text);
        })
      );
    } else if (lyrics.plain) {
      const plainLines = lyrics.plain.split("\n");
      body = h("div", { ref: bodyRef, className:"lyrics-body plain" },
        h("pre", { className:"lyrics-plain" }, lyrics.plain),
        h("div", { className:"mono-hint", style:{padding:"6px 0 2px", color:"var(--text-faint)", fontSize:"10px"} }, "Plain lyrics — no timestamps (seek disabled)")
      );
    } else if (lyrics.lines.length) {
      body = h("div", { ref: bodyRef, className:"lyrics-body synced" },
        ...lyrics.lines.map((ln,i)=> h("div",{key:i, className:"lyrics-line plain-line"}, ln.text))
      );
    } else {
      body = h("div", { className:"lyrics-empty" }, "No lyrics");
    }

    return h("div", {
      ref: panelRef,
      className:"lyrics-panel",
      style:{ left: geom.x+"px", top: geom.y+"px", width: geom.w+"px", height: geom.h+"px" },
    },
      h("div", { className:"lyrics-head", onMouseDown:onDragStart },
        h("i", { className:"fa-solid fa-microphone-lines", style:{color:"var(--accent)"} }),
        h("span", { className:"lyrics-head-title" }, "Lyrics"),
        h("span", { className:"lyrics-head-track mono-hint", title: trackLabel }, hasTrack ? trackLabel : "—"),
        h("span", { style:{marginLeft:"auto", display:"inline-flex", gap:"6px", alignItems:"center"} },
          hasTrack && lyrics.syncedAvailable ? h("span", { className:"mono-hint", style:{fontSize:"10px", color: curIsPlaying ? "var(--accent)" : "var(--text-faint)"} }, curIsPlaying ? "● synced" : "○ paused") : null,
          h("button", { className:"icon-btn", "data-tip":"Close lyrics", onClick:closePanel, "aria-label":"Close" }, h("i",{className:"fa-solid fa-xmark"}))
        )
      ),
      h("div", { className:"lyrics-main" }, body),
      h("div", { className:"lyrics-foot mono-hint" },
        hasTrack ? `${curTrack.name} • ${fmt(curPos)} / ${fmt(curTrack.duration)}` : "",
        hasTrack && lyrics.syncedAvailable ? h("span", { style:{marginLeft:"8px", opacity:.6} }, "click line to seek") : null
      ),
      h("div", { className:"lyrics-handle n", onMouseDown:onResizeStart("n") }),
      h("div", { className:"lyrics-handle s", onMouseDown:onResizeStart("s") }),
      h("div", { className:"lyrics-handle e", onMouseDown:onResizeStart("e") }),
      h("div", { className:"lyrics-handle w", onMouseDown:onResizeStart("w") }),
      h("div", { className:"lyrics-handle nw", onMouseDown:onResizeStart("nw") }),
      h("div", { className:"lyrics-handle ne", onMouseDown:onResizeStart("ne") }),
      h("div", { className:"lyrics-handle sw", onMouseDown:onResizeStart("sw") }),
      h("div", { className:"lyrics-handle se", onMouseDown:onResizeStart("se") })
    );
  }

  return {
    Sidebar,
    Settings,
    Titlebar: TitlebarBtn,
    Overlay: LyricsOverlay,
    info: {
      voice: [],
      keys: [["Spotify", "Controls before Git — Vencord style"], ["Lyrics (microphone icon)","Timestamp-synced floating window — LRCLIB, click line to seek"]],
    },
  };
}
