import { useCallback, useEffect, useRef, useState } from "react";
import { connectRelay, type RelayConn, type RelayNotify } from "./relayClient";

// persisted prefs — phone-local, never the shared desktop blob
type Prefs = { url: string; token: string };
const PREF_KEY = "oc.mobile.relay";
const NOTIF_KEY = "oc.mobile.notifs";

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    if (p && typeof p === "object") {
      return {
        url: typeof p.url === "string" ? p.url : "",
        token: typeof p.token === "string" ? p.token : "",
      };
    }
  } catch {}
  return { url: "", token: "" };
}

function loadNotifs(): RelayNotify[] {
  try {
    const n = JSON.parse(localStorage.getItem(NOTIF_KEY) ?? "[]");
    return Array.isArray(n) ? n.filter((m) => m && typeof m === "object").slice(0, 100) : [];
  } catch {}
  return [];
}

const KIND_ICON: Record<string, string> = {
  idle: "fa-circle-check",
  permission: "fa-hand",
  question: "fa-circle-question",
  error: "fa-triangle-exclamation",
  test: "fa-flask",
};

// readable kind labels for the list rows ("idle" alone tells nothing)
const KIND_LABEL: Record<string, string> = {
  idle: "turn complete",
  permission: "permission needed",
  question: "question",
  error: "error",
  test: "test",
};

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [notifs, setNotifs] = useState<RelayNotify[]>(loadNotifs);
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "off">("off");
  const [scanning, setScanning] = useState(false);
  const [scanFail, setScanFail] = useState(false);
  const connRef = useRef<RelayConn | null>(null);

  useEffect(() => {
    if (!prefs.url || !prefs.token) {
      setStatus("off");
      return;
    }
    const c = connectRelay(WebSocket, prefs.url, prefs.token, {
      onStatus: (s) => setStatus(s),
      onNotify: (m) => {
        addNotif(m);
        void banner(m);
      },
    });
    connRef.current = c;
    return () => {
      c.stop();
      connRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.url, prefs.token]);
  const save = (p: Prefs) => {
    setPrefs(p);
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {}
  };

  const scanningRef = useRef(false);
  scanningRef.current = scanning;
  const statusRef = useRef(status);
  statusRef.current = status;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const discover = useCallback(async () => {
    if (scanningRef.current) return;
    setScanning(true);
    setScanFail(false);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const found = await invoke<{ url: string; token: string } | null>("relay_discover");
      if (found?.url && found?.token) {
        setScanFail(false);
        save({ url: found.url, token: found.token });
      } else {
        setScanFail(true);
      }
    } catch {
      setScanFail(true);
    } finally {
      setScanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // autofind on open when not connected — no saved relay creds means the
  // socket effect above stays "off", so probe the LAN once instead of
  // leaving the user on a dead "not connected" screen
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const p = loadPrefs();
    if (!p.url || !p.token) void discover();
  }, [discover]);

  // app reopened from background — Android froze the webview and killed the
  // socket without a close event, and the suspended backoff timer only resumes
  // stale. Foregrounding → dial now; missed messages arrive via relay replay.
  const onVis = () => {
    if (document.visibilityState !== "visible") return;
    if (scanningRef.current) return;
    const p = prefsRef.current;
    if (!p.url || !p.token) {
      if (statusRef.current !== "connected") void discover();
      return;
    }
    if (statusRef.current !== "connected") connRef.current?.reconnect();
  };
  useEffect(() => {
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discover]);

  // connected status syncs with autofind — while the LAN probe runs the
  // header dot + status lines read as connecting, never stale "off"
  const effStatus = scanning ? "connecting" : status;

  const addNotif = (m: RelayNotify) => {
    setNotifs((prev) => {
      const next = [m, ...prev.filter((n) => n.id !== m.id)].slice(0, 100);
      try { localStorage.setItem(NOTIF_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Escape closes the drawer — same as desktop SettingsDrawer
  useEffect(() => {
    if (!settingsOpen) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      setSettingsOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [settingsOpen]);

  return (
    <div className="mapp">
      <div className="mnoise" aria-hidden="true" />
      <header className="mhead">
        <span className="mtitle"><i aria-hidden="true" />opencode-gui</span>
        <span className={`mdot mdot-${effStatus}`} data-status={effStatus} />
        <button className="mtab" onClick={() => setSettingsOpen(true)}>
          <i className="fa-solid fa-gear" />
          Setup
        </button>
      </header>
      <NotifScreen notifs={notifs} status={effStatus} scanning={scanning} onClear={() => {
        setNotifs([]);
        try { localStorage.removeItem(NOTIF_KEY); } catch {}
      }} />
      {/* settings pop on top from the right — same exact shell as desktop
          SettingsDrawer (drawer-scrim + settings-drawer + settings-head/body) */}
      <div className={`drawer-scrim${settingsOpen ? " open" : ""}`} onClick={() => setSettingsOpen(false)} />
      <aside
        className={`settings-drawer${settingsOpen ? " open" : ""}`}
        role="dialog"
        aria-label="Settings"
      >
        <div className="settings-head">
          <h2>Settings</h2>
          <div className="color-controls">
            <button className="reset-btn" onClick={() => setSettingsOpen(false)}>
              <i className="fa-solid fa-xmark" />
            </button>
          </div>
        </div>
        <div className="settings-body">
          <SettingsSection
            prefs={prefs}
            onSave={(p) => save(p)}
            status={effStatus}
            scanning={scanning}
            onDiscover={discover}
            scanFail={scanFail && !scanning && !prefs.url}
          />
        </div>
      </aside>
    </div>
  );
}

// system banner while the app is open (background push arrives via the web
// push path on Android; iOS banners only fire while the webview is alive —
// ponytail: native push plugin if iOS backgrounding proves necessary)
async function banner(m: RelayNotify) {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    const perm = await import("@tauri-apps/plugin-notification").catch(() => null);
    if (!perm) return;
    if (!(await perm.isPermissionGranted())) {
      if ((await perm.requestPermission()) !== "granted") return;
    }
    await perm.sendNotification({ title: m.title || "opencode", body: m.body || "" });
  } catch {}
}

// connection form — same exact components/style as the desktop settings
// drawer (settings-section / setting-row / setting-info / oc-input /
// reset-btn from settings.css + plugin-ui.css, no mobile forks)
function SettingsSection({ prefs, onSave, status, scanning, onDiscover, scanFail }: {
  prefs: Prefs;
  onSave: (p: Prefs) => void;
  status: string;
  scanning: boolean;
  onDiscover: () => void;
  scanFail: boolean;
}) {
  const [url, setUrl] = useState(prefs.url);
  const [token, setToken] = useState(prefs.token);
  useEffect(() => {
    setUrl(prefs.url);
    setToken(prefs.token);
  }, [prefs.url, prefs.token]);
  const statusText = scanning
    ? "searching for desktop…"
    : status === "connected"
      ? "connected — waiting for desktop events"
      : status === "reconnecting"
        ? "reconnecting…"
        : status === "connecting"
          ? "connecting…"
          : "not connected";
  return (
    <>
      <section className="settings-section" aria-label="Relay connection">
        <div className="settings-section-title">
          <i className="fa-solid fa-tower-broadcast" /> Relay connection
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <i className="fa-solid fa-signal setting-icon" />
            <div>
              <div className="setting-name">Status</div>
              <div className="setting-desc">{statusText}</div>
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <i className="fa-solid fa-magnifying-glass setting-icon" />
            <div>
              <div className="setting-name">Find desktop</div>
              <div className="setting-desc">Search this network for a running relay</div>
            </div>
          </div>
          <button type="button" className="reset-btn" onClick={onDiscover} disabled={scanning}>
            <i className={`fa-solid ${scanning ? "fa-spinner fa-spin" : "fa-magnifying-glass"}`} />
            {scanning ? "Searching…" : "Search"}
          </button>
        </div>
        {scanFail && (
          <div className="setting-row">
            <div className="setting-info">
              <div>
                <div className="setting-desc">No desktop found — make sure the GUI is running on the same Wi-Fi with the relay started (Settings → Phone notifications → Run relay on this PC), then search again or connect manually below.</div>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="settings-section" aria-label="Connect manually">
        <div className="settings-section-title">
          <i className="fa-solid fa-link" /> Connect manually
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <i className="fa-solid fa-globe setting-icon" />
            <div>
              <div className="setting-name">Relay URL</div>
              <div className="setting-desc">The ws:// (port 8918) URL the relay prints</div>
            </div>
          </div>
        </div>
        <div className="setting-row" style={{ paddingTop: 0 }}>
          <input
            id="m-relay"
            className="oc-input mono-hint"
            placeholder="ws://192.168.1.10:8918/ws"
            value={url}
            onChange={(e) => setUrl(e.target.value.trim())}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <i className="fa-solid fa-key setting-icon" />
            <div>
              <div className="setting-name">Phone token</div>
              <div className="setting-desc">Printed by oc-relay on first boot</div>
            </div>
          </div>
        </div>
        <div className="setting-row" style={{ paddingTop: 0 }}>
          <input
            id="m-token"
            className="oc-input mono-hint"
            placeholder="ocp-xxxxxxxx"
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <i className="fa-solid fa-plug setting-icon" />
            <div>
              <div className="setting-name">Connect</div>
              <div className="setting-desc">Save and dial the relay</div>
            </div>
          </div>
          <button type="button" className="reset-btn" onClick={() => onSave({ url, token })}>
            <i className="fa-solid fa-check" />
            Connect
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-info">
            <div>
              <div className="setting-desc">Run oc-relay on the PC (Settings → Phone notifications → Run relay on this PC) and paste the phone token it prints. Use the ws:// URL, not wss:// — the phone app can&apos;t accept the relay&apos;s self-signed TLS cert.</div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
function NotifScreen({ notifs, status, scanning, onClear }: { notifs: RelayNotify[]; status: string; scanning: boolean; onClear: () => void }) {
  return (
    <div className="mlist-wrap">
      {notifs.length > 0 && (
        <button className="mclear" onClick={onClear}>Clear all</button>
      )}
      {notifs.length === 0 ? (
        <div className="mempty">
          {scanning
            ? "searching for desktop…"
            : status === "connected"
              ? "waiting for desktop events…"
              : status === "reconnecting" || status === "connecting"
                ? "reconnecting…"
                : "not connected — open Setup"}
        </div>
      ) : (
        notifs.map((m, i) => (
          <div className="mrow" key={`${m.id ?? "x"}-${i}`}>
            <div className="mrow-k">
              <i className={`fa-solid ${KIND_ICON[m.kind ?? ""] ?? "fa-bell"}`} />
              {KIND_LABEL[m.kind ?? ""] ?? m.kind ?? "notify"}
            </div>
            <div className="mrow-t">{m.title ?? ""}</div>
            {m.body && <div className="mrow-b">{m.body}</div>}
            <div className="mrow-m">
              #{m.id ?? "?"}
              {m.session || m.sessionID ? ` · ${m.session || (m.sessionID ?? "").slice(0, 8)}` : ""}
              {m.ts ? ` · ${new Date((m.ts as number) * 1000).toLocaleTimeString()}` : ""}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
