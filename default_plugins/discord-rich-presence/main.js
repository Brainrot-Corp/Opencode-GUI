// Discord Rich Presence — opencode-gui plugin (plain browser ESM).
//
// Affiche dans Discord : workspace (nom dossier seul), modèle et statut
// (Idle / Editing) tant que l'app est ouverte (même en tray). Hot-reload.
// Activation via le gestionnaire de plugins (icône puzzle) — single toggle.
//
// Config : oc.settings.plugins["discord-rich-presence"] {
//   clientId: string (défaut 1542215270972784804)
//   detailsTpl: string (défaut "Opencode GUI")
//   stateTpl: string (défaut "Working on: {workspace} • {status}")
//   largeImage: string (défaut "" = pas d'image, sinon "opencode-logo" si uploadée)
//   largeTextTpl: string (défaut "{workspace}")
// }
//
// Live snapshot lu depuis window.__presence (mis à jour par ChatPage) :
//   {workspace, workspaceName, model, busy, sessionId, sessionTitle, editingFile, diffOpen, hasPermission, hasQuestion, compacting, isTyping}
//   {status} priority: file > diff > permission/question > compacting > busy > typing > idle
//   Timer: app launch → close (sessionStorage, survives reloads/HMR within same launch)

const ID = "discord-rich-presence";
const DEFAULT_ID = "1542215270972784804";

const DEF = {
  clientId: DEFAULT_ID,
  detailsTpl: "Opencode GUI",
  stateTpl: "Working on: {workspace} \u2022 {status}",
  largeImage: "",
  largeTextTpl: "{workspace}",
};

function confOf(settings) {
  const cur = settings && settings.plugins && settings.plugins[ID];
  if (cur && typeof cur === "object") return { ...DEF, ...cur };
  return { ...DEF };
}

function basename(p) {
  if (!p) return "";
  const parts = String(p).split(/[/\\]/).filter(Boolean);
  return parts.pop() || String(p);
}

function renderTpl(tpl, vars) {
  let s = String(tpl || "");
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v ?? ""));
  s = s.replace(/\s*[·|]\s*[·|]\s*/g, " · ").replace(/\s{2,}/g, " ").trim();
  s = s.replace(/^[·|]\s*/, "").replace(/\s*[·|]$/, "");
  return s;
}

function statusLabel(s) {
  if (s === "connected") return "Connecté";
  if (s === "disconnected") return "Déconnecté — lance Discord Desktop";
  if (s === "idle") return "En attente";
  return s || "";
}

function readPresence() {
  const w = typeof window !== "undefined" ? window : {};
  const p = w.__presence || {};
  return {
    workspace: p.workspace || "",
    workspaceName: p.workspaceName || basename(p.workspace || ""),
    model: p.model || "",
    busy: !!p.busy,
    sessionId: p.sessionId || "",
    sessionTitle: p.sessionTitle || "",
    editingFile: p.editingFile || "",
    diffOpen: !!p.diffOpen,
    hasPermission: !!p.hasPermission,
    hasQuestion: !!p.hasQuestion,
    compacting: !!p.compacting,
    isTyping: !!p.isTyping,
  };
}

export default function activate(api) {
  const { h, useState, useEffect } = api;

  function Settings({ open, settings, updatePlugin }) {
    const conf = confOf(settings);
    const [status, setStatus] = useState("idle");
    const [err, setErr] = useState("");
    const [collapsed, setCollapsed] = useState(() => {
      try { return localStorage.getItem("oc.settings.discord.collapsed") === "1"; } catch { return true; }
    });

    useEffect(() => {
      if (!open) return;
      let dead = false;
      let iv = null;
      const poll = () => {
        api.invoke("discord_status").then((s) => {
          if (!dead) { setStatus(String(s || "idle")); setErr(""); }
        }).catch((e) => {
          if (!dead) setErr(e instanceof Error ? e.message : String(e));
        });
      };
      poll();
      iv = setInterval(poll, 3000);
      return () => { dead = true; if (iv) clearInterval(iv); };
    }, [open]);

    const set = (patch) => updatePlugin({ ...conf, ...patch });
    const st = statusLabel(status);
    const dotColor = status === "connected" ? "var(--accent)" : status === "disconnected" ? "var(--danger)" : "var(--text-faint)";
    const toggle = () => setCollapsed((v) => {
      const nv = !v;
      try { localStorage.setItem("oc.settings.discord.collapsed", nv ? "1" : "0"); } catch {}
      try { api.playSound(nv ? "collapse" : "expand"); } catch {}
      return nv;
    });

    return h("div", { className: "sound-box" },
      h("div", { className: "sound-box-head", onClick: toggle, style: { cursor: "pointer" }, "data-tip": collapsed ? "Expand" : "Collapse" },
        h("i", { className: "fa-brands fa-discord setting-icon" }),
        h("span", null, "Discord Presence"),
        h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
          h("span", { style: { width: "8px", height: "8px", background: dotColor, display: "inline-block", boxShadow: status === "connected" ? "0 0 6px var(--accent-glow)" : "none" } }),
          h("span", { className: "mono-hint" }, st),
          h("i", { className: `fa-solid ${collapsed ? "fa-chevron-down" : "fa-chevron-up"}`, style: { fontSize: "10px", color: "var(--text-faint)", marginLeft: "6px" } })
        )
      ),
      collapsed ? null : h("div", null,

      h("div", { className: "mono-hint discord-hint", style: { padding: "6px 10px", borderBottom: "1px solid var(--line)" } },
        "Activé via le gestionnaire de plugins (puzzle). Désactive le plugin là-bas pour couper la présence."
      ),

      // client id
      h("div", { className: "setting-row drop" },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-id-badge setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "Client ID"),
            h("div", { className: "setting-desc mono-hint" }, "Discord Application ID")
          )
        ),
        h("div", { className: "color-controls", style: { flexBasis: "100%", marginLeft: "30px" } },
          h("input", {
            className: "discord-in",
            value: conf.clientId,
            placeholder: DEFAULT_ID,
            spellCheck: false,
            onChange: (e) => set({ clientId: e.target.value.trim() }),
          })
        )
      ),

      // details template
      h("div", { className: "setting-row drop" },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-heading setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "Details"),
            h("div", { className: "setting-desc" }, "Ligne 1 — ex: Opencode GUI")
          )
        ),
        h("div", { className: "color-controls", style: { flexBasis: "100%", marginLeft: "30px" } },
          h("input", {
            className: "discord-in",
            value: conf.detailsTpl,
            placeholder: "Opencode GUI",
            spellCheck: false,
            onChange: (e) => set({ detailsTpl: e.target.value }),
          })
        )
      ),

      // state template
      h("div", { className: "setting-row drop" },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-align-left setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "State"),
            h("div", { className: "setting-desc mono-hint" }, "Variables: {workspace} {model} {status}")
          )
        ),
        h("div", { className: "color-controls", style: { flexBasis: "100%", marginLeft: "30px" } },
          h("input", {
            className: "discord-in",
            value: conf.stateTpl,
            placeholder: "Working on: {workspace} \u2022 {status}",
            spellCheck: false,
            onChange: (e) => set({ stateTpl: e.target.value }),
          })
        )
      ),

      // large image + large text
      h("div", { className: "setting-row drop" },
        h("div", { className: "setting-info" },
          h("i", { className: "fa-solid fa-image setting-icon" }),
          h("div", null,
            h("div", { className: "setting-name" }, "Large image"),
            h("div", { className: "setting-desc mono-hint" }, "Clé Art Asset du Dev Portal — vide = pas d'image (évite l'erreur)")
          )
        ),
        h("div", { className: "color-controls", style: { flexBasis: "100%", marginLeft: "30px", display: "flex", gap: "6px" } },
          h("input", {
            className: "discord-in",
            style: { flex: 1 },
            value: conf.largeImage,
            placeholder: "(vide)",
            spellCheck: false,
            onChange: (e) => set({ largeImage: e.target.value.trim() }),
          }),
          h("input", {
            className: "discord-in",
            style: { flex: 1 },
            value: conf.largeTextTpl,
            placeholder: "{workspace}",
            spellCheck: false,
            "data-tip": "Hover text de l'image",
            onChange: (e) => set({ largeTextTpl: e.target.value }),
          })
        )
      ),

      err ? h("div", { className: "voice-err" }, err) : null,
      h("div", { className: "mono-hint discord-hint" },
        "Discord Desktop doit être lancé + Paramètres Discord → Activité → Afficher l'activité activé. Si tu veux une image, uploade-la dans le Dev Portal (Rich Presence → Art Assets) avec la même clé que Large image."
      )
      )
    );
  }

  // background presence loop — always active when plugin loaded (host enabled)
  // app-launch timer: one timestamp for the whole app lifetime, survives
  // workspace reloads / HMR via sessionStorage + window.__discordAppStart
  function getAppStartTs() {
    try {
      const w = typeof window !== "undefined" ? window : {};
      if (w.__discordAppStart) return w.__discordAppStart;
      const k = "oc.discord.appStart";
      let v = null;
      try { v = sessionStorage.getItem(k); } catch {}
      if (v) {
        const n = parseInt(v, 10);
        if (n > 0 && n * 1000 < Date.now() + 10000) {
          w.__discordAppStart = n;
          return n;
        }
      }
      const now = Math.floor(Date.now() / 1000);
      try { sessionStorage.setItem(k, String(now)); } catch {}
      w.__discordAppStart = now;
      return now;
    } catch { return Math.floor(Date.now() / 1000); }
  }
  let timer = null;
  let lastKey = "";
  const startTs = getAppStartTs();
  let lastErrAt = 0;

  function tick() {
    try {
      const conf = confOf(api.settings());
      const live = readPresence();
      const wsName = live.workspaceName;
      const workspaceDisp = wsName || "No workspace";
      const modelDisp = live.model || "—";
      // file > diff > permission/question > compacting > busy > typing > idle
      let statusDisp = "Idle";
      if (live.editingFile) statusDisp = `Editing: ${basename(live.editingFile)}`;
      else if (live.diffOpen) statusDisp = "Reviewing diff";
      else if (live.hasPermission && live.hasQuestion) statusDisp = "Awaiting input";
      else if (live.hasPermission) statusDisp = "Awaiting approval";
      else if (live.hasQuestion) statusDisp = "Awaiting answer";
      else if (live.compacting) statusDisp = "Compacting…";
      else if (live.busy) statusDisp = "Generating…";
      else if (live.isTyping) statusDisp = "Typing…";

      const details = renderTpl(conf.detailsTpl, { workspace: workspaceDisp, model: modelDisp, status: statusDisp });
      const state = renderTpl(conf.stateTpl, { workspace: workspaceDisp, model: modelDisp, status: statusDisp });
      const largeText = renderTpl(conf.largeTextTpl, { workspace: workspaceDisp, model: modelDisp, status: statusDisp });

      const li = (conf.largeImage || "").trim();
      const key = JSON.stringify([details, state, largeText, li, conf.clientId, startTs]);
      if (key === lastKey) return;
      lastKey = key;

      api.invoke("discord_set", {
        details: details || "Opencode GUI",
        stt: state || workspaceDisp || "Idle",
        large_image: li || null,
        small_image: null,
        large_text: largeText || workspaceDisp || "Opencode GUI",
        start_ts: startTs,
        client_id: (conf.clientId || DEFAULT_ID).trim() || DEFAULT_ID,
      }).catch((e) => {
        const now = Date.now();
        if (now - lastErrAt > 10000) {
          lastErrAt = now;
          try { console.warn("[discord]", e); } catch {}
        }
      });
    } catch {}
  }

  const start = () => {
    if (timer) return;
    setTimeout(tick, 1200);
    timer = setInterval(tick, 1500);
    const onVis = () => setTimeout(tick, 400);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
  };
  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
    api.invoke("discord_clear").catch(() => {});
    api.invoke("discord_close").catch(() => {});
    lastKey = "";
  };

  start();

  try {
    const w = typeof window !== "undefined" ? window : {};
    if (w.__discordStop) { try { w.__discordStop(); } catch {} }
    w.__discordStop = stop;
  } catch {}

  return {
    Settings,
    info: {
      voice: [],
      keys: [["Discord Presence", "Toujours active si plugin activé (puzzle)"]],
    },
    _stop: stop,
  };
}
