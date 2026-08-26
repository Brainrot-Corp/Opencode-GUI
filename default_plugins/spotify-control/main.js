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

export default function activate(api) {
  const { h, useState, useEffect } = api;

  // --- token helpers -------------------------------------------------------
  async function refreshTokens(conf, updatePlugin) {
    if (!conf.refreshToken || !conf.clientId) throw new Error("no refresh token");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conf.refreshToken,
      client_id: conf.clientId,
    }).toString();
    const r = await api.invoke("http_json", {
      method: "POST",
      url: TOKEN,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`refresh ${r.status}: ${r.body.slice(0,200)}`);
    let j; try { j = JSON.parse(r.body); } catch { throw new Error("bad token json"); }
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
    // include device_id if available will be set by caller via query param
    const qs = qp.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    const headers = { Authorization: `Bearer ${tok}` };
    let body = null;
    if (bodyObj) { headers["Content-Type"] = "application/json"; body = JSON.stringify(bodyObj); }
    const r = await api.invoke("http_json", { method: method.toUpperCase(), url, headers, body });
    // Spotify returns 204 No Content for many control ops, 202 for next/prev
    if (r.status === 401) {
      // try once refresh
      const nt = await refreshTokens(conf, updatePlugin);
      const rh = { Authorization: `Bearer ${nt}` };
      if (bodyObj) rh["Content-Type"] = "application/json";
      const r2 = await api.invoke("http_json", { method: method.toUpperCase(), url, headers: rh, body });
      if (r2.status >= 200 && r2.status < 300) return r2;
      throw new Error(`${method} ${path} → ${r2.status}`);
    }
    if (r.status >= 200 && r.status < 300) return r;
    // 404 no active device, 403 free account
    throw new Error(`${r.status} ${r.body.slice(0,180)}`);
  }

  // --- Settings (drawer) ---------------------------------------------------
  function Settings({ open, settings, updatePlugin }) {
    const conf = confOf(settings);
    const [code, setCode] = useState("");
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("idle");

    useEffect(() => {
      if (!open) return;
      let dead = false;
      const tick = async () => {
        try {
          const c = confOf(api.settings());
          if (!c.accessToken) { if (!dead) setStatus("idle"); return; }
          if (c.expiresAt && Date.now() > c.expiresAt) { if (!dead) setStatus("expired"); return; }
          // lightweight player check
          const r = await api.invoke("http_json", {
            method: "GET",
            url: API,
            headers: { Authorization: `Bearer ${c.accessToken}` },
            body: null,
          });
          if (dead) return;
          if (r.status === 200) setStatus("connected");
          else if (r.status === 204) setStatus("no-device");
          else if (r.status === 401) setStatus("expired");
          else setStatus(`code ${r.status}`);
        } catch (e) { if (!dead) setStatus(e instanceof Error ? e.message.slice(0,80) : String(e).slice(0,80)); }
      };
      tick();
      const iv = setInterval(tick, 4000);
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
        // persist immediately before opening external
        const params = new URLSearchParams({
          response_type: "code",
          client_id: conf.clientId.trim(),
          scope: SCOPES,
          redirect_uri: REDIRECT,
          code_challenge_method: "S256",
          code_challenge: challenge,
        });
        const url = `${AUTH}?${params.toString()}`;
        await api.invoke("open_external", { url }).catch(async () => {
          // fallback: http_json not for open, try browser_open if present
          try { await api.invoke("browser_open", { url, top: 0 }); } catch {}
        });
        setErr("Browser opened — log in, then copy the redirected URL's ?code= value and paste below.");
      } catch (e) { setErr(String(e).slice(0,300)); }
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
      if (!c) { setErr("Paste the ?code= value from the redirect URL"); return; }
      if (!conf.verifier) { setErr("No verifier — click Authorize again"); return; }
      setBusy(true); setErr("");
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code: c,
          redirect_uri: REDIRECT,
          client_id: conf.clientId.trim(),
          code_verifier: conf.verifier,
        }).toString();
        const r = await api.invoke("http_json", {
          method: "POST",
          url: TOKEN,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (r.status < 200 || r.status >= 300) throw new Error(`token ${r.status}: ${r.body.slice(0,300)}`);
        const j = JSON.parse(r.body);
        if (!j.access_token) throw new Error("no access_token in response");
        const exp = Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600 * 1000) - 5000;
        set({ accessToken: j.access_token, refreshToken: j.refresh_token || conf.refreshToken, expiresAt: exp, verifier: "" });
        setCode("");
        setErr("");
        setStatus("connected");
      } catch (e) { setErr(String(e).slice(0,400)); }
      setBusy(false);
    }

    const dot = status === "connected" ? "on" : status === "expired" || status.includes("401") ? "warn" : "";
    const hint = status === "connected" ? "Connected" : status === "no-device" ? "No active device" : status === "expired" ? "Token expired — refresh or re-auth" : status === "idle" ? "Not connected" : status;

    return h("div", { className: "sound-box spotify-box" },
      h("div", { className: "sound-box-head" },
        h("i", { className: "fa-brands fa-spotify setting-icon", style: { color: "var(--accent)" } }),
        h("span", null, "Spotify"),
        h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
          h("span", { className: `sp-dot ${dot}`, style: { width: "8px", height: "8px", display: "inline-block", borderRadius: "50%", background: dot === "on" ? "var(--accent)" : dot === "warn" ? "var(--danger)" : "var(--text-faint)", boxShadow: dot === "on" ? "0 0 6px var(--accent-glow)" : "none" } }),
          h("span", { className: "mono-hint" }, hint)
        )
      ),
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
        conf.accessToken ? h("button", { type: "button", className: "reset-btn", onClick: () => { set({ accessToken: "", refreshToken: "", expiresAt: 0, verifier: "" }); setStatus("idle"); setErr(""); } },
          h("i", { className: "fa-solid fa-right-from-bracket" }), "Logout") : null
      ),
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
        )
      ),
      err ? h("div", { className: "voice-err", style: { margin: "0 10px 8px" } }, err) : null,
      h("div", { className: "mono-hint sp-hint" }, "After Authorize, Spotify redirects to ", h("code", null, REDIRECT), " which will fail to load — copy the address bar URL and paste it above. Tokens stored in localStorage (oc.settings.plugins.spotify-control).")
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
    const [pos, setPos] = useState(0);
    const [duration, setDuration] = useState(0);
    const [mPos, setMPos] = useState(0);
    const [startAt, setStartAt] = useState(Date.now());
    const [volume, setVolume] = useState(50);
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [hover, setHover] = useState(false);

    const confRef = { current: conf };
    confRef.current = conf;

    function openSpotify(path) {
      const c = confRef.current;
      const url = c.useSpotifyUris ? `spotify:${path.replace(/^\//, "").replaceAll("/", ":")}` : `https://open.spotify.com${path}`;
      api.invoke("open_external", { url }).catch(() => {});
    }

    // poll player
    useEffect(() => {
      let dead = false;
      let iv = null;
      async function poll() {
        const c = confOf(api.settings());
        if (!c.accessToken) {
          if (!dead) { setTrack(null); setDevice(null); setIsPlaying(false); setErr(""); }
          return;
        }
        try {
          // ensure fresh token if expiring
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
          if (r.status === 204) { // no content — no active device
            setDevice(null); setIsPlaying(false); setErr("");
            return;
          }
          if (r.status === 401) {
            try {
              await refreshTokens(cur, (p) => updatePlugin({ ...cur, ...p }));
              setErr("");
            } catch (e) { setErr("Token expired — re-authorize in Settings"); }
            return;
          }
          if (r.status < 200 || r.status >= 300) {
            // 403 free accounts, 404 etc.
            setErr(r.status === 403 ? "Controls need Premium" : `Spotify ${r.status}`);
            return;
          }
          const j = JSON.parse(r.body);
          // map player state (Vencord shape vs Spotify API)
          const item = j.item || null;
          const dev = j.device || null;
          setDevice(dev);
          setIsPlaying(!!j.is_playing);
          setShuffle(!!j.shuffle_state);
          setRepeat(j.repeat_state || "off");
          setVolume(typeof j.device?.volume_percent === "number" ? j.device.volume_percent : volume);
          setMPos(j.progress_ms ?? 0);
          setStartAt(Date.now());
          setErr("");
          if (!item) { setTrack(null); setDuration(0); setPos(0); return; }
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
          setTrack(t);
          setDuration(t.duration);
          setPos(j.progress_ms ?? 0);
        } catch (e) {
          if (!dead) setErr(e instanceof Error ? e.message.slice(0,120) : String(e).slice(0,120));
        }
      }
      poll();
      iv = setInterval(poll, 3500);
      const onVis = () => { if (document.visibilityState === "visible") void poll(); };
      document.addEventListener("visibilitychange", onVis);
      return () => { dead = true; if (iv) clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
    }, [conf.accessToken, conf.refreshToken]);

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

    async function req(method, path, query) {
      if (busy) return;
      setBusy(true);
      const c = confOf(api.settings());
      try {
        await spotifyReq(c, (p) => updatePlugin({ ...c, ...p }), method, path, query, null);
        setErr("");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("403") || msg.includes("Premium")) setErr("Controls need Premium");
        else if (msg.includes("404")) setErr("No active device — open Spotify");
        else setErr(msg.slice(0,140));
      }
      setBusy(false);
    }

    const doPrev = () => {
      const c = confRef.current;
      if (c.previousButtonRestartsTrack && pos > 3000) {
        void req("put", "/seek", { position_ms: 0, ...(device?.id ? { device_id: device.id } : {}) });
      } else {
        void req("post", "/previous", device?.id ? { device_id: device.id } : {});
      }
    };
    const doNext = () => void req("post", "/next", device?.id ? { device_id: device.id } : {});
    const doPlayPause = () => void req("put", isPlaying ? "/pause" : "/play", device?.id ? { device_id: device.id } : {});
    const doShuffle = () => {
      const ns = !shuffle;
      setShuffle(ns);
      void req("put", "/shuffle", { state: String(ns), ...(device?.id ? { device_id: device.id } : {}) });
    };
    const doRepeat = () => {
      const nxt = repeat === "off" ? "context" : repeat === "context" ? "track" : "off";
      setRepeat(nxt);
      void req("put", "/repeat", { state: nxt, ...(device?.id ? { device_id: device.id } : {}) });
    };
    const doSeek = (ms) => {
      setPos(ms); setMPos(ms); setStartAt(Date.now());
      void req("put", "/seek", { position_ms: Math.round(ms), ...(device?.id ? { device_id: device.id } : {}) });
    };
    const doVolume = (v) => {
      setVolume(v);
      void req("put", "/volume", { volume_percent: Math.round(v), ...(device?.id ? { device_id: device.id } : {}) });
    };

    const hasToken = !!conf.accessToken;
    const dotCls = !hasToken ? "" : isPlaying ? "on" : device ? "on" : "warn";
    const statusTxt = !hasToken ? "Not connected" : !device ? "No device" : isPlaying ? "Playing" : "Paused";

    if (!hasToken) {
      return h("div", { className: "sp-panel", onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) },
        h("div", { className: "sp-head" },
          h("i", { className: "fa-brands fa-spotify" }), h("span", null, "Spotify"),
          h("span", { className: `sp-dot ${dotCls}` }), h("span", { className: "mono-hint", style: { marginLeft: "auto", fontSize: "10px" } }, statusTxt)
        ),
        h("div", { className: "sp-empty" }, "Not connected — set Client ID and Authorize in Settings (puzzle → Spotify)."),
        h("div", { className: "mono-hint sp-hint" }, "Need Premium for controls. Redirect URI: ", h("code", null, REDIRECT))
      );
    }

    const pct = duration ? Math.max(0, Math.min(100, (pos / duration) * 100)) : 0;

    return h("div", { className: "sp-panel", onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) },
      h("div", { className: "sp-head" },
        h("i", { className: "fa-brands fa-spotify" }), h("span", null, "Spotify"),
        h("span", { className: `sp-dot ${dotCls}`, title: statusTxt }),
        h("span", { className: "mono-hint", style: { marginLeft: "auto", fontSize: "10px", color: isPlaying ? "var(--accent)" : "var(--text-faint)" } }, statusTxt)
      ),
      !track ? h("div", { className: "sp-empty" }, device ? "Nothing playing — start playback in Spotify" : "No active device — open Spotify on a device") :
      h("div", { id: "sp-info" },
        track.album.image ? h("img", {
          id: "sp-album", className: expanded ? "expanded" : "",
          src: track.album.image.url, alt: "cover",
          onClick: () => setExpanded((v) => !v),
          onContextMenu: (e) => {
            e.preventDefault();
            openSpotify(`/album/${track.album.id}`);
          },
          title: "Click to expand, right-click to open album",
        }) : h("div", { id: "sp-album", style: { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)" } }, h("i", { className: "fa-solid fa-music" })),
        h("div", { id: "sp-titles" },
          h("div", {
            id: "sp-title", className: "sp-ellip", title: track.name,
            ...(track.id ? { role: "link", onClick: () => openSpotify(`/track/${track.id}`) } : {}),
          }, track.name),
          track.artists.length ? h("div", { className: "sp-secondary sp-ellip", title: track.artists.map((a) => a.name).join(", ") },
            h("span", { className: "sp-prefix" }, "by "), ...track.artists.map((a, i) =>
              h("span", {
                key: a.id || a.name, className: "sp-artist",
                ...(a.id ? { role: "link", onClick: () => openSpotify(`/artist/${a.id}`) } : {}),
                title: a.name,
              }, a.name + (i < track.artists.length - 1 ? ", " : ""))
            )
          ) : null,
          track.album.name ? h("div", { className: "sp-secondary sp-ellip" },
            h("span", { className: "sp-prefix" }, "on "),
            h("span", {
              id: "sp-album-name", className: "sp-ellip",
              ...(track.album.id ? { role: "link", onClick: () => openSpotify(`/album/${track.album.id}`) } : {}),
              title: track.album.name,
            }, track.album.name)
          ) : null
        )
      ),
      track ? h("div", { id: "sp-progress" },
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
      track ? h("div", { className: "sp-row" },
        h("button", { className: `sp-btn ${shuffle ? "on" : ""}`, onClick: doShuffle, disabled: busy, "data-tip": shuffle ? "Shuffle on" : "Shuffle off", "aria-label": "Shuffle" },
          h("i", { className: "fa-solid fa-shuffle" })),
        h("button", { className: "sp-btn", onClick: doPrev, disabled: busy, "data-tip": "Previous (restarts if >3s)", "aria-label": "Previous" },
          h("i", { className: "fa-solid fa-backward-step" })),
        h("button", { className: "sp-btn", onClick: doPlayPause, disabled: busy, "data-tip": isPlaying ? "Pause" : "Play", "aria-label": isPlaying ? "Pause" : "Play", style: { background: isPlaying ? "var(--accent-dim)" : "none", color: isPlaying ? "var(--accent)" : "var(--text-dim)" } },
          h("i", { className: `fa-solid ${isPlaying ? "fa-pause" : "fa-play"}` })),
        h("button", { className: "sp-btn", onClick: doNext, disabled: busy, "data-tip": "Next", "aria-label": "Next" },
          h("i", { className: "fa-solid fa-forward-step" })),
        h("button", {
          className: `sp-btn ${repeat !== "off" ? "on" : ""}`, onClick: doRepeat, disabled: busy, "data-tip": repeat === "off" ? "Repeat off" : repeat === "context" ? "Repeat all" : "Repeat one", "aria-label": "Repeat", style: { position: "relative" }
        },
          h("i", { className: "fa-solid fa-repeat" }),
          repeat === "track" ? h("span", { className: "sp-one" }, "1") : null
        )
      ) : null,
      track ? h("div", { className: "sp-vol" },
        h("i", { className: "fa-solid fa-volume-high", title: `Volume ${Math.round(volume)}%` }),
        h("input", {
          type: "range", min: 0, max: 100, step: 1, value: Math.round(volume),
          onChange: (e) => doVolume(Number(e.target.value)),
          onInput: (e) => setVolume(Number(e.target.value)),
          title: `${Math.round(volume)}%`,
        }),
        h("span", { className: "mono-hint", style: { minWidth: "28px", textAlign: "right", fontSize: "10px" } }, `${Math.round(volume)}%`)
      ) : null,
      err ? h("div", { className: "sp-err" }, err) : null
    );
  }

  return {
    Sidebar,
    Settings,
    info: {
      voice: [],
      keys: [["Spotify", "Controls before Git — Vencord style"]],
    },
  };
}
