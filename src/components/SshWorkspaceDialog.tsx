import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Dialog from "./Dialog";
import { addWorkspace, applyWorkspace } from "../lib/workspace";
import { ensureRemote, getRemoteKey, setRemoteKey, testRemote } from "../lib/remotes";
import "../styles/dialog.css";

// Add/open an SSH remote workspace (`ssh://[user@]host[:port]/path`).
// Auth: system ssh config/keys/agent by default; optional in-app key file
// (stored path only) or password (memory-only, delivered via our own
// SSH_ASKPASS helper — no third-party binaries).
// The last successfully connected form (never the password) is remembered
// in localStorage and prefilled on open.
const SSH_LAST_KEY = "oc.ssh.last";
type AuthMode = "auto" | "key" | "password";
type SshLast = {
  host: string;
  user: string;
  port: string;
  path: string;
  auth: AuthMode;
  keyFile: string;
};

function loadLast(): SshLast | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SSH_LAST_KEY) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return null;
    const str = (v: unknown, max: number) =>
      typeof v === "string" && v.length <= max ? v : "";
    const auth = raw.auth === "key" || raw.auth === "password" ? raw.auth : "auto";
    const host = str(raw.host, 256);
    if (!host) return null;
    return {
      host,
      user: str(raw.user, 128),
      port: str(raw.port, 8),
      path: str(raw.path, 1024),
      auth,
      keyFile: auth === "key" ? str(raw.keyFile, 1024) : "",
    };
  } catch {
    return null;
  }
}

function saveLast(v: SshLast) {
  try {
    localStorage.setItem(SSH_LAST_KEY, JSON.stringify(v));
  } catch {}
}
export default function SshWorkspaceDialog({
  open: isOpen,
  mode,
  onClose,
}: {
  open: boolean;
  mode: "primary" | "extra";
  onClose: (added?: string) => void;
}) {
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [path, setPath] = useState("");
  const [auth, setAuth] = useState<AuthMode>("auto");
  const [keyFile, setKeyFile] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (isOpen) {
      setMsg("");
      setBusy(null);
      setPassword("");
      const last = loadLast();
      if (last) {
        setHost(last.host);
        setUser(last.user);
        setPort(last.port);
        setPath(last.path);
        setAuth(last.auth);
        setKeyFile(last.keyFile);
      }
    }
  }, [isOpen]);
  if (!isOpen) return null;

  const currentForm = (): SshLast => ({ host, user, port, path, auth, keyFile });

  const buildUri = (): string | null => {
    const h = host.trim();
    const p = path.trim() || "/";
    if (!h) return null;
    if (h.includes("/") || h.includes(" ") || h.includes("@")) return null;
    const u = user.trim();
    if (u && (u.includes("@") || u.includes("/") || u.includes(" "))) return null;
    let pp = "";
    if (port.trim()) {
      const n = Number(port.trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
      pp = `:${n}`;
    }
    const rp = p.startsWith("/") ? p : `/${p}`;
    return `ssh://${u ? `${u}@` : ""}${h}${pp}${rp}`;
  };

  const pickKey = async () => {
    try {
      const f = await open({ multiple: false, directory: false });
      if (typeof f === "string") setKeyFile(f);
    } catch {}
  };

  const test = async (): Promise<string | null> => {
    const uri = buildUri();
    if (!uri) {
      setMsg("Enter a host and remote path (user/port optional).");
      return null;
    }
    setBusy("test");
    setMsg("");
    try {
      const out = await testRemote(uri, auth === "password" ? password : undefined);
      setMsg(out.includes("no-opencode") ? "Connected — path OK, but `opencode` is not on the remote PATH." : "Connected.");
      saveLast(currentForm());
      return uri;
    } catch (e) {
      setMsg(String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const uri = buildUri();
    if (!uri) {
      setMsg("Enter a host and remote path (user/port optional).");
      return;
    }
    if (auth === "key" && !keyFile.trim()) {
      setMsg("Pick a key file, or switch auth to system ssh.");
      return;
    }
    if (auth === "password" && !password) {
      setMsg("Enter the SSH password (kept in memory only).");
      return;
    }
    setBusy("save");
    setMsg("");
    try {
      // validate first (also warms the password into memory for the save)
      await testRemote(uri, auth === "password" ? password : undefined);
      saveLast(currentForm());
      if (auth === "key") await setRemoteKey(uri, keyFile.trim());
      else await setRemoteKey(uri, "");
      if (auth === "password") await ensureRemote(uri, password);
      if (mode === "primary") await applyWorkspace(uri);
      else {
        const ok = await addWorkspace(uri);
        if (!ok) {
          setMsg("Workspace already listed (or list is full).");
          setBusy(null);
          return;
        }
      }
      onClose(uri);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const uri = buildUri();
  return (
    <Dialog title={mode === "primary" ? "Open SSH workspace" : "Add SSH workspace"} onClose={() => onClose()}>
      <div className="browse-search" style={{ padding: "2px 0" }}>
        <div className="model-search-wrap">
          <i className="fa-solid fa-server" />
          <input className="model-search" type="text" placeholder="host (e.g. dev.example.com)" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} autoFocus />
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <div className="browse-search" style={{ padding: "2px 0", flex: 2 }}>
          <div className="model-search-wrap">
            <i className="fa-solid fa-user" />
            <input className="model-search" type="text" placeholder="user (optional)" value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} />
          </div>
        </div>
        <div className="browse-search" style={{ padding: "2px 0", flex: 1 }}>
          <div className="model-search-wrap">
            <i className="fa-solid fa-plug" />
            <input className="model-search" type="text" inputMode="numeric" placeholder="22" value={port} onChange={(e) => setPort(e.target.value)} spellCheck={false} />
          </div>
        </div>
      </div>
      <div className="browse-search" style={{ padding: "2px 0" }}>
        <div className="model-search-wrap">
          <i className="fa-solid fa-folder" />
          <input className="model-search" type="text" placeholder="/home/you/project" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
        </div>
      </div>
      {uri && <div className="setting-desc mono-hint" style={{ padding: "2px 0" }}>{uri}</div>}
      <div className="dlg-tabs" style={{ marginTop: 6 }}>
        {(["auto", "key", "password"] as const).map((a) => (
          <button key={a} type="button" className={`dlg-tab${auth === a ? " on" : ""}`} onClick={() => setAuth(a)}>
            {a === "auto" ? "System ssh" : a === "key" ? "Key file" : "Password"}
          </button>
        ))}
      </div>
      {auth === "auto" && (
        <div className="setting-desc" style={{ padding: "2px 0" }}>Uses ~/.ssh/config, keys and ssh-agent. No secrets stored.</div>
      )}
      {auth === "key" && (
        <div className="browse-search" style={{ padding: "2px 0" }}>
          <div className="model-search-wrap">
            <i className="fa-solid fa-key" />
            <input
              className="model-search"
              type="text"
              placeholder="~/.ssh/id_ed25519"
              value={keyFile}
              onChange={(e) => setKeyFile(e.target.value)}
              spellCheck={false}
              onFocus={() => {
                if (!keyFile) void getRemoteKey(uri ?? "").then((k) => {
                  if (k) setKeyFile(k);
                }).catch(() => {});
              }}
            />
            <button type="button" className="reset-btn" onClick={() => void pickKey()}>
              <i className="fa-solid fa-folder-open" /> Browse
            </button>
          </div>
        </div>
      )}
      {auth === "password" && (
        <div className="browse-search" style={{ padding: "2px 0" }}>
          <div className="model-search-wrap">
            <i className="fa-solid fa-lock" />
            <input className="model-search" type="password" placeholder="SSH password (memory only)" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
          </div>
        </div>
      )}
      {msg && <div className="setting-desc" style={{ padding: "4px 0", whiteSpace: "pre-wrap" }}>{msg}</div>}
      <div className="dlg-actions" style={{ marginTop: 8 }}>
        <button type="button" className="reset-btn" disabled={busy !== null} onClick={() => void test()}>
          <i className={`fa-solid ${busy === "test" ? "fa-spinner fa-spin" : "fa-plug"}`} /> Test
        </button>
        <button type="button" className="reset-btn" disabled={busy !== null} onClick={() => void save()}>
          <i className={`fa-solid ${busy === "save" ? "fa-spinner fa-spin" : "fa-check"}`} /> {mode === "primary" ? "Open" : "Add"}
        </button>
      </div>
    </Dialog>
  );
}
