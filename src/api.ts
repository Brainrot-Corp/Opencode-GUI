import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { invoke } from "@tauri-apps/api/core";
import { isRemoteDir, remoteBaseUrl, serverDir } from "./lib/remotes";

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

// merge ?directory= into the query of any SDK call options object.
// SSH workspaces send the remote-local path (the server's own view).
function withDir(args: any, dir = directory) {
  const sd = serverDir(dir);
  if (!sd) return args;
  return { ...(args ?? {}), query: { ...(args?.query ?? {}), directory: sd } };
}

// wrap the SDK client so every namespaced method (session.*, file.*, …)
// carries the workspace directory automatically
function wrap(obj: any, dir?: string): any {
  return new Proxy(obj, {
    get(t, prop) {
      const v = t[prop];
      if (typeof v === "function")
        return (...a: any[]) => v.call(t, withDir(a[0], dir ?? directory), ...a.slice(1));
      if (v && typeof v === "object") return wrap(v, dir);
      return v;
    },
  });
}

export async function opencodeFor(dir: string) {
  const base = await baseFor(dir);
  const client = wrap(createOpencodeClient({ baseUrl: base }), dir);
  return { base, client };
}

export async function serverFetchFor(dir: string, path: string, init?: RequestInit) {
  const base = await baseFor(dir);
  const sd = serverDir(dir);
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${sd ? `${sep}directory=${encodeURIComponent(sd)}` : ""}`;
  return fetch(url, init);
}

// per-workspace server base. Local workspaces share the sidecar URL;
// each SSH workspace has its own tunnel port (auto-connected on demand).
// Remote entries are evicted when the tunnel dies so the next call re-dials.
const remoteBases = new Map<string, string>();
const remoteDialing = new Map<string, Promise<string>>();
// negative cache: a failed dial fails fast for a while instead of parking
// yet another invoke on a dead host (boot loop + 2s SSE ticks would
// otherwise stack slow calls faster than Rust can shed them)
const remoteFailedAt = new Map<string, number>();
const REMOTE_FAIL_WINDOW = 15_000;

export async function baseFor(dir: string): Promise<string> {
  const d = (dir ?? "").trim();
  if (!isRemoteDir(d)) return (await opencode()).base;
  const hit = remoteBases.get(d);
  if (hit) return hit;
  const failed = remoteFailedAt.get(d);
  if (failed && Date.now() - failed < REMOTE_FAIL_WINDOW) {
    throw new Error(`SSH workspace unreachable (retrying shortly): ${d}`);
  }
  const dial = remoteDialing.get(d);
  if (dial) return dial;
  const p = remoteBaseUrl(d)
    .then((base) => {
      remoteFailedAt.delete(d);
      remoteBases.set(d, base);
      remoteDialing.delete(d);
      return base;
    })
    .catch((e) => {
      remoteFailedAt.set(d, Date.now());
      remoteDialing.delete(d);
      throw e;
    });
  remoteDialing.set(d, p);
  return p;
}

export function evictRemoteBase(dir: string) {
  remoteBases.delete((dir ?? "").trim());
}

// a rejected invoke must not stay cached, or silent-retry boot would spin
// on the same failure forever. Retry once quickly: the Rust side now waits
// for the port to be listening, but a cold start can still take a few hundred
// ms after setup; a transient invoke error shouldn't hard-fail the boot.
export function opencode() {
  if (cached) return cached;
  const attempt = () =>
    invoke<string>("server_url").then((base) => ({
      base,
      client: wrap(createOpencodeClient({ baseUrl: base })),
    }));
  // single cached promise that atomically includes the retry — concurrent
  // callers share the same 400 ms timer, no thundering herd
  cached = (async () => {
    try {
      return await attempt();
    } catch (e) {
      await new Promise<void>((r) => setTimeout(r, 400));
      return attempt();
    }
  })().catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

export function resetOpencodeCache() {
  cached = null;
}

// raw fetch for endpoints missing from the stale SDK types (/question*) —
// carries ?directory= like every wrapped SDK call
export async function serverFetch(path: string, init?: RequestInit) {
  const base = await baseFor(directory);
  const sd = serverDir(directory);
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${sd ? `${sep}directory=${encodeURIComponent(sd)}` : ""}`;
  return fetch(url, init);
}

// --- hidden helper sessions (summary / debrief / commit-message gen) -------
// tracked live so refreshSessions can drop them from the sidebar, plus a
// title marker so orphans left by a crash vanish on the next boot too
export const HIDDEN_TITLE = "__temp__";
export const hiddenSessions = new Set<string>();

export async function tempSession(dir?: string): Promise<string> {
  const { client } = dir !== undefined ? await opencodeFor(dir) : await opencode();
  const s = await client.session.create({ body: { title: HIDDEN_TITLE } } as any);
  const id = (s.data as any).id as string;
  hiddenSessions.add(id);
  return id;
}

export async function dropSession(id: string, dir?: string) {
  hiddenSessions.delete(id);
  try {
    const { client } = dir !== undefined ? await opencodeFor(dir) : await opencode();
    await (client.session as any).delete({ path: { id } }).catch(() => {});
  } catch {}
}

// sync prompts have no deadline server-side — a stalled provider hangs the
// caller forever (e.g. the git-panel spinner). Reject instead.
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T>;
export function withDeadline<T>(p: Promise<T>, ms: number, label: string, signal: AbortSignal | AbortController): Promise<T>;
export function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal | AbortController,
): Promise<T> {
  const sig: AbortSignal | undefined =
    signal instanceof AbortController ? signal.signal : (signal as AbortSignal | undefined);
  const ctrl: AbortController | undefined =
    signal instanceof AbortController ? signal : undefined;
  let timer: number | undefined;
  let onAbort: (() => void) | null = null;
  const timeout = new Promise<never>((_, rej) => {
    timer = window.setTimeout(() => {
      try {
        ctrl?.abort(new DOMException(`${label} timed out`, "TimeoutError"));
      } catch {}
      rej(new Error(`${label} timed out`));
    }, ms);
    if (sig) {
      onAbort = () => {
        clearTimeout(timer);
        rej(sig.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (sig.aborted) onAbort();
      else sig.addEventListener("abort", onAbort, { once: true });
    }
  });
  return (Promise.race([p, timeout]) as Promise<T>).finally(() => {
    clearTimeout(timer);
    if (sig && onAbort) sig.removeEventListener("abort", onAbort);
  });
}
