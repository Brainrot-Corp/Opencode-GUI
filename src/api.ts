import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { invoke } from "@tauri-apps/api/core";

let cached: Promise<{ base: string; client: ReturnType<typeof createOpencodeClient> }> | null =
  null;

// workspace directory sent as ?directory= on every request ("" = server cwd).
// Lets the UI switch projects without respawning the sidecar.
let directory = "";
try {
  const p = JSON.parse(localStorage.getItem("oc.settings") ?? "{}");
  if (typeof p.workspace === "string") directory = p.workspace;
} catch {
  // no stored settings — default
}

export function setDirectory(dir: string) {
  directory = dir;
}

export function getDirectory() {
  return directory;
}

// merge ?directory= into the query of any SDK call options object
function withDir(args: any) {
  if (!directory) return args;
  return { ...(args ?? {}), query: { ...(args?.query ?? {}), directory } };
}

// wrap the SDK client so every namespaced method (session.*, file.*, …)
// carries the workspace directory automatically
function wrap(obj: any): any {
  return new Proxy(obj, {
    get(t, prop) {
      const v = t[prop];
      if (typeof v === "function")
        return (...a: any[]) => v.call(t, withDir(a[0]), ...a.slice(1));
      if (v && typeof v === "object") return wrap(v);
      return v;
    },
  });
}

// a rejected invoke must not stay cached, or silent-retry boot would spin
// on the same failure forever
export function opencode() {
  cached ??= invoke<string>("server_url")
    .then((base) => ({
      base,
      client: wrap(createOpencodeClient({ baseUrl: base })),
    }))
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}

// raw fetch for endpoints missing from the stale SDK types (/question*) —
// carries ?directory= like every wrapped SDK call
export async function serverFetch(path: string, init?: RequestInit) {
  const { base } = await opencode();
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${directory ? `${sep}directory=${encodeURIComponent(directory)}` : ""}`;
  return fetch(url, init);
}

// --- hidden helper sessions (summary / debrief / commit-message gen) -------
// tracked live so refreshSessions can drop them from the sidebar, plus a
// title marker so orphans left by a crash vanish on the next boot too
export const HIDDEN_TITLE = "__temp__";
export const hiddenSessions = new Set<string>();

export async function tempSession(): Promise<string> {
  const { client } = await opencode();
  const s = await client.session.create({ body: { title: HIDDEN_TITLE } });
  const id = (s.data as any).id as string;
  hiddenSessions.add(id);
  return id;
}

export async function dropSession(id: string) {
  hiddenSessions.delete(id);
  const { client } = await opencode();
  await client.session.delete({ path: { id } }).catch(() => {});
}

// sync prompts have no deadline server-side — a stalled provider hangs the
// caller forever (e.g. the git-panel spinner). Reject instead.
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = window.setTimeout(() => rej(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}
