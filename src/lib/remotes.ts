import { invoke } from "@tauri-apps/api/core";

// SSH remote workspaces are addressed as `ssh://[user@]host[:port]/path`.
// The string flows through existing workspace plumbing untouched; only the
// transport boundary (api.ts bases, ?directory=, Tauri file/git/pty invokes)
// branches on it.

export function isRemoteDir(dir: string): boolean {
  return (dir ?? "").trim().startsWith("ssh://");
}

/** The `?directory=` value the server understands (its own local path). */
export function serverDir(dir: string): string {
  const t = (dir ?? "").trim();
  if (!isRemoteDir(t)) return t;
  const rest = t.slice("ssh://".length);
  const i = rest.indexOf("/");
  return i < 0 ? "/" : rest.slice(i);
}

/** `user@host` (or `host`) for display. */
export function authorityOf(dir: string): string {
  const t = (dir ?? "").trim();
  const rest = t.startsWith("ssh://") ? t.slice("ssh://".length) : t;
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.slice(0, slash);
}

/** Short label for sidebar/stage-head: `user@host:/remote/path`. */
export function remoteLabel(dir: string): string {
  const t = (dir ?? "").trim();
  if (!isRemoteDir(t)) return t;
  const rest = t.slice("ssh://".length);
  const i = rest.indexOf("/");
  if (i < 0) return rest;
  return `${rest.slice(0, i)}:${rest.slice(i)}`;
}

/**
 * Map a server-absolute path to the path Tauri file commands understand.
 * Remote servers report their own paths (`/home/u/proj/f.ts`); file ops
 * need the `ssh://` pseudo-path so Rust routes over ssh.
 */
export function toOpPath(absolute: string, dir: string): string {
  const abs = (absolute ?? "").trim();
  if (!abs || !isRemoteDir(dir) || abs.startsWith("ssh://")) return abs;
  const rest = (dir ?? "").trim().slice("ssh://".length);
  const i = rest.indexOf("/");
  const auth = i < 0 ? rest : rest.slice(0, i);
  if (!auth) return abs;
  const p = abs.startsWith("/") ? abs : `/${abs}`;
  return `ssh://${auth}${p}`;
}

export type RemoteStatus = { alive: boolean; port?: number | null };

/** Ensure tunnel + remote serve; resolves the local forwarded port. */
export function ensureRemote(uri: string, password?: string): Promise<number> {
  return invoke<number>("remote_ensure", { uri, password: password ?? null });
}

/** Local base URL for a remote workspace (auto-connects on demand). */
export function remoteBaseUrl(uri: string): Promise<string> {
  return invoke<string>("remote_base_url", { uri });
}

export function remoteStatus(uri: string): Promise<RemoteStatus> {
  return invoke<RemoteStatus>("remote_status", { uri });
}

export function remoteRemove(uri: string): Promise<void> {
  return invoke<void>("remote_remove", { uri });
}

/** `opencode --version` + dir check; rejects with a human message. */
export function testRemote(uri: string, password?: string): Promise<string> {
  return invoke<string>("remote_test", { uri, password: password ?? null });
}

export function setRemoteKey(uri: string, keyFile: string): Promise<void> {
  return invoke<void>("remote_set_key", { uri, keyFile });
}

export function getRemoteKey(uri: string): Promise<string> {
  return invoke<string>("remote_get_key", { uri });
}
