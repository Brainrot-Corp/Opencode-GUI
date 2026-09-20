import { useEffect, useRef, useState } from "react";
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

export default function App() {
  const [screen, setScreen] = useState<"connect" | "notifs">("notifs");
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

  const discover = async () => {
    setScanning(true);
    setScanFail(false);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const found = await invoke<{ url: string; token: string } | null>("relay_discover");
      if (found) save({ url: found.url, token: found.token });
      else setScanFail(true);
    } catch {
      setScanFail(true);
    } finally {
      setScanning(false);
    }
  };

  const addNotif = (m: RelayNotify) => {
    setNotifs((prev) => {
      const next = [m, ...prev.filter((n) => n.id !== m.id)].slice(0, 100);
      try { localStorage.setItem(NOTIF_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  return (
    <div className="mapp">
      <header className="mhead">
        <span className="mtitle">opencode-gui</span>
        <span className={`mdot mdot-${status}`} data-status={status} />
        <button className="mtab" onClick={() => setScreen(screen === "notifs" ? "connect" : "notifs")}>
          <i className={`fa-solid ${screen === "notifs" ? "fa-gear" : "fa-bell"}`} />
          {screen === "notifs" ? "Setup" : "Alerts"}
        </button>
      </header>
      {screen === "connect" ? (
        <ConnectScreen
          prefs={prefs}
          onSave={save}
          status={status}
          onDiscover={discover}
          scanning={scanning}
          scanFail={scanFail && !prefs.url}
        />
      ) : (
        <NotifScreen notifs={notifs} status={status} onClear={() => {
          setNotifs([]);
          try { localStorage.removeItem(NOTIF_KEY); } catch {}
        }} />
      )}
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

function ConnectScreen({ prefs, onSave, status, onDiscover, scanning, scanFail }: {
  prefs: Prefs;
  onSave: (p: Prefs) => void;
  status: string;
  onDiscover: () => void;
  scanning: boolean;
  scanFail: boolean;
}) {
  const [url, setUrl] = useState(prefs.url);
  const [token, setToken] = useState(prefs.token);
  return (
    <div className="mform">
      <button className="mbtn" onClick={onDiscover} disabled={scanning}>
        {scanning ? <><i className="fa-solid fa-spinner fa-spin" /> Searching…</> : <><i className="fa-solid fa-magnifying-glass" /> Find desktop on this network</>}
      </button>
      {scanFail && (
        <p className="mhint">
          No desktop found — make sure the GUI is running on the same Wi-Fi with
          the relay started (Settings → Phone notifications → Run relay on this PC),
          then search again or connect manually below.
        </p>
      )}
      <div className="mdivider"><span>or connect manually</span></div>
      <label className="mlabel" htmlFor="m-relay">Relay URL</label>
      <input
        id="m-relay"
        className="minput"
        placeholder="ws://192.168.1.10:8918/ws"
        value={url}
        onChange={(e) => setUrl(e.target.value.trim())}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <label className="mlabel" htmlFor="m-token">Phone token</label>
      <input
        id="m-token"
        className="minput mono"
        placeholder="ocp-xxxxxxxx"
        value={token}
        onChange={(e) => setToken(e.target.value.trim())}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <button className="mbtn" onClick={() => onSave({ url, token })}>
        Connect
      </button>
      <div className="mstatus" data-status={status}>
        {status === "connected"
          ? "connected — waiting for desktop events"
          : status === "reconnecting"
            ? "reconnecting…"
            : status === "connecting"
              ? "connecting…"
              : "not connected"}
      </div>
      <p className="mhint">
        Run <code>oc-relay</code> on the PC (Settings → Phone notifications → Run relay on this PC)
        and paste the phone token it prints. Use the <code>ws://</code> (port 8918) URL, not the
        <code> wss://</code> one — the phone app can't accept the relay's self-signed TLS cert.
      </p>
    </div>
  );
}
function NotifScreen({ notifs, status, onClear }: { notifs: RelayNotify[]; status: string; onClear: () => void }) {
  return (
    <div className="mlist-wrap">
      {notifs.length > 0 && (
        <button className="mclear" onClick={onClear}>Clear all</button>
      )}
      {notifs.length === 0 ? (
        <div className="mempty">
          {status === "connected" ? "waiting for desktop events…" : status === "reconnecting" ? "reconnecting…" : "not connected — open Setup"}
        </div>
      ) : (
        notifs.map((m, i) => (
          <div className="mrow" key={`${m.id ?? "x"}-${i}`}>
            <div className="mrow-k">
              <i className={`fa-solid ${KIND_ICON[m.kind ?? ""] ?? "fa-bell"}`} />
              {m.kind ?? "notify"}
            </div>
            <div className="mrow-t">{m.title ?? ""}</div>
            {m.body && <div className="mrow-b">{m.body}</div>}
            <div className="mrow-m">#{m.id ?? "?"}{m.sessionID ? ` · ${m.sessionID}` : ""}{m.ts ? ` · ${new Date((m.ts as number) * 1000).toLocaleTimeString()}` : ""}</div>
          </div>
        ))
      )}
    </div>
  );
}
