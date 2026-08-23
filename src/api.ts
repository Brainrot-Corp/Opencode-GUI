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

export function opencode() {
  cached ??= invoke<string>("server_url").then((base) => ({
    base,
    client: wrap(createOpencodeClient({ baseUrl: base })),
  }));
  return cached;
}
