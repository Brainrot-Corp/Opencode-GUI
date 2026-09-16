// MCP server state — one status+config snapshot per workspace loaded in
// THIS window. Query set is getAllWorkspaces() only, so workspace-scoped
// servers from other OS windows (separate processes) are never fetched.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { opencodeFor, withDeadline } from "../api";
import { getAllWorkspaces } from "../lib/workspace";
import { setMcpEnabled } from "../lib/mcpConfig";

export type McpServerState = {
  status: string;
  error?: string;
  config?: {
    type?: string;
    command?: string[];
    url?: string;
    environment?: Record<string, string>;
    headers?: Record<string, string>;
    oauth?: unknown;
    timeout?: number;
    enabled?: boolean;
  };
};

export type McpDirState = {
  dir: string;
  servers: Record<string, McpServerState>;
  // all tool IDs in this workspace (built-in + MCP) — MCP tools are matched
  // per server by the documented <server>_<tool> prefix (non [A-Za-z0-9_-]
  // in the server name normalizes to _). Informational: never fails the fetch.
  tools: string[];
  error: string;
  // core (status+config) not yet resolved — section renders a skeleton row
  pending: boolean;
};

// per-row busy key — dirs may contain "::" too, but a collision only risks a
// shared spinner, never wrong data (rows are keyed by dir+name everywhere)
const rowKey = (dir: string, name: string) => `${dir}::${name}`;

// opencode registers MCP tools as <server>_<tool> with the same normalization
export function mcpToolPrefix(name: string): string {
  return `${name.replace(/[^A-Za-z0-9_-]/g, "_")}_`;
}
export function toolsForServer(all: string[], name: string): string[] {
  const p = mcpToolPrefix(name);
  return all.filter((t) => t === name || t.startsWith(p)).sort((a, b) => a.localeCompare(b));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// opencodeFor has no deadline of its own — a dead SSH workspace dial would
// hang one dir (and, via Promise.all, the whole dialog) indefinitely. The
// second load then looks "faster" only because of the 15s negative dial cache.
async function getClient(dir: string) {
  const { client } = await withDeadline(opencodeFor(dir), 15_000, "mcp workspace");
  return client;
}

async function fetchCore(dir: string): Promise<McpDirState> {
  try {
    const client = await getClient(dir);
    const [st, cfg] = await Promise.all([
      withDeadline((client.mcp as any).status(), 10_000, "mcp status"),
      withDeadline((client.config as any).get(), 10_000, "mcp config").catch(() => null),
    ]);
    const statusMap = ((st as any)?.data ?? {}) as Record<string, any>;
    const mcpCfg = ((cfg as any)?.data?.mcp ?? {}) as Record<string, McpServerState["config"]>;
    const servers: Record<string, McpServerState> = {};
    for (const name of new Set([...Object.keys(statusMap), ...Object.keys(mcpCfg)])) {
      const s = statusMap[name];
      servers[name] = {
        status: typeof s === "string" ? s : (s?.status ?? "unknown"),
        error: s && typeof s === "object" ? (s as any).error : undefined,
        config: mcpCfg[name],
      };
    }
    return { dir, servers, tools: [], error: "", pending: false };
  } catch (e) {
    return { dir, servers: {}, tools: [], error: e instanceof Error ? e.message : String(e), pending: false };
  }
}

async function fetchTools(dir: string): Promise<string[]> {
  try {
    const client = await getClient(dir);
    const ids = await withDeadline((client.tool as any).ids(), 10_000, "mcp tools").catch(() => null);
    const arr = (ids as any)?.data;
    return Array.isArray(arr) ? arr.filter((t: unknown) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

async function fetchDir(dir: string): Promise<McpDirState> {
  const core = await fetchCore(dir);
  if (core.error) return core;
  return { ...core, tools: await fetchTools(dir) };
}

function apiErr(r: unknown, fallback: string): string {
  const e = (r as any)?.error;
  if (!e) return "";
  if (typeof e === "string") return e;
  try {
    return (e as any)?.message ?? (e as any)?.data?.message ?? JSON.stringify(e);
  } catch {
    return fallback;
  }
}

// persist the flag in <workspace>/opencode.jsonc — the server only honors
// the file at boot (no hot-reload), so without this the toggle reverts on
// restart. write_file covers ssh:// paths too; file.read is relative to ?directory=.
async function persistMcpEnabled(client: any, dir: string, name: string, enabled: boolean, entry: unknown): Promise<void> {
  const base = dir.replace(/[/\\]+$/, "");
  let raw = "";
  let file = `${base}/opencode.jsonc`;
  for (const rel of ["opencode.jsonc", "opencode.json"]) {
    const r = await withDeadline(client.file.read({ query: { path: rel } }), 10_000, "mcp config file").catch(() => null);
    const content = (r as any)?.data?.content;
    if (typeof content === "string" && content.trim()) {
      raw = content;
      file = `${base}/${rel}`;
      break;
    }
  }
  await invoke("write_file", { path: file, content: setMcpEnabled(raw, name, enabled, entry) });
}

export function useMcp() {
  const [dirs, setDirs] = useState<McpDirState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // refresh generations in flight (manual + workspace-change ticks can
  // overlap) — rows lock while any is live so a toggle can't race a paint
  const [refreshLive, setRefreshLive] = useState(false);
  const refreshCount = useRef(0);
  const refreshBegin = useCallback(() => {
    refreshCount.current += 1;
    setRefreshLive(true);
  }, []);
  const refreshEnd = useCallback(() => {
    refreshCount.current = Math.max(0, refreshCount.current - 1);
    if (refreshCount.current === 0 && alive.current) setRefreshLive(false);
  }, []);
  const patchDir = useCallback((dir: string, next: McpDirState) => {
    if (!alive.current) return;
    setDirs((prev) => {
      const i = prev.findIndex((d) => d.dir === dir);
      if (i < 0) return [...prev, next];
      if (prev[i] === next) return prev;
      const out = [...prev];
      out[i] = next;
      return out;
    });
  }, []);

  // each workspace paints as soon as its own core resolves — one slow/dead
  // workspace (e.g. unreachable SSH) never holds the others hostage, and
  // tools fill in a beat later without blocking the server list
  const refresh = useCallback(async () => {
    const all = getAllWorkspaces();
    setLoading(true);
    setDirs(all.map((dir) => ({ dir, servers: {}, tools: [], error: "", pending: true })));
    setLoading(false);
    refreshBegin();
    try {
      await Promise.all(
        all.map(async (dir) => {
          patchDir(dir, await fetchCore(dir));
          const tools = await fetchTools(dir);
          if (!alive.current) return;
          setDirs((prev) => prev.map((d) => (d.dir === dir ? { ...d, tools } : d)));
        }),
      );
    } finally {
      refreshEnd();
    }
  }, [patchDir, refreshBegin, refreshEnd]);

  useEffect(() => {
    void refresh();
    const onWs = () => {
      void refresh();
    };
    // same-window event only — never storage events (would adopt other windows)
    window.addEventListener("oc:workspaces-changed", onWs);
    return () => window.removeEventListener("oc:workspaces-changed", onWs);
  }, [refresh]);

  // re-fetch one workspace and patch it into state — used by polling while
  // an OAuth flow completes in the browser. Returns the fresh snapshot.
  const refreshOne = useCallback(
    async (dir: string): Promise<McpDirState> => {
      const next = await fetchDir(dir);
      patchDir(dir, next);
      return next;
    },
    [patchDir],
  );

  // toggle in two proven steps (verified live against the sidecar):
  // 1. disconnect/connect — applied synchronously, status flips on the next
  //    read. (config.update is a no-op echo on this server version, and
  //    mcp.add throws when enabling a broken server, so neither is used.)
  // 2. write the flag to <workspace>/opencode.jsonc — the server honors the
  //    file at boot with no hot-reload, so this is what survives restarts.
  // Returns a non-fatal note (e.g. file out of reach) for the dialog to show.
  const setEnabled = useCallback(
    async (dir: string, name: string, enabled: boolean): Promise<{ note: string }> => {
      const key = rowKey(dir, name);
      setBusy((p) => new Set(p).add(key));
      try {
        const client = await getClient(dir);
        // entry is only needed as the insert template when the server block is
        // missing from the workspace file — the live toggle needs no config
        const cur = await withDeadline((client.config as any).get(), 10_000, "mcp config");
        const entry = ((cur as any)?.data?.mcp ?? {})[name];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(`No stored config for "${name}" — add it to opencode.jsonc first.`);
        }
        // the SDK never throws on API errors (ThrowOnError=false) — check .error
        const tr = await withDeadline(
          enabled ? (client.mcp as any).connect({ path: { name } }) : (client.mcp as any).disconnect({ path: { name } }),
          15_000,
          "mcp toggle",
        );
        const toggleErr = apiErr(tr, "toggle rejected");
        if (toggleErr) throw new Error(toggleErr);
        let note = "";
        if (!dir.trim()) {
          note = "No workspace folder — applies until the sidecar restarts.";
        } else {
          try {
            await persistMcpEnabled(client, dir, name, enabled, { ...(entry as Record<string, unknown>), enabled });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            note = `Applied now, but the config file could not be written (${msg}) — reverts on restart.`;
          }
        }
        // the flip is synchronous: re-read until it shows (or 3 tries), then paint
        let snap: McpDirState | null = null;
        for (let i = 0; i < 3; i++) {
          snap = await fetchCore(dir);
          if (snap.error) break;
          const st = snap.servers[name]?.status;
          if (!enabled ? st === "disabled" : st !== "disabled" && st !== "unknown") break;
          if (i < 2) await sleep(1000);
        }
        const full = snap ?? (await fetchCore(dir));
        full.tools = await fetchTools(dir);
        patchDir(dir, full);
        if (full.error) throw new Error(full.error);
        const st = full.servers[name]?.status ?? "unknown";
        if (!enabled ? st !== "disabled" : st === "disabled" || st === "unknown") {
          throw new Error(`Server did not ${enabled ? "enable" : "disable"} (still ${st}) — try refresh.`);
        }
        return { note };
      } finally {
        if (alive.current)
          setBusy((p) => {
            const n = new Set(p);
            n.delete(key);
            return n;
          });
      }
    },
    [patchDir],
  );

  // OAuth for remote servers: start returns the browser URL (opened via the
  // OS default handler — same file_open every other "open outside" uses).
  // The provider redirects back to the sidecar, so callers poll refreshOne
  // until the status leaves needs_auth; submitCode covers manual paste.
  const beginAuth = useCallback(async (dir: string, name: string): Promise<string> => {
    const client = await getClient(dir);
    const r = await withDeadline((client.mcp as any).auth.start({ path: { name } }), 15_000, "mcp auth");
    const url = (r as any)?.data?.authorizationUrl ?? "";
    if (!url) throw new Error("Server returned no authorization URL");
    try {
      await invoke("file_open", { path: url });
    } catch {}
    return url;
  }, []);

  const submitCode = useCallback(
    async (dir: string, name: string, code: string) => {
      const client = await getClient(dir);
      await withDeadline(
        (client.mcp as any).auth.callback({ path: { name }, body: { code: code.trim() } }),
        15_000,
        "mcp auth",
      );
      await refreshOne(dir);
    },
    [refreshOne],
  );

  const signOut = useCallback(
    async (dir: string, name: string) => {
      const client = await getClient(dir);
      await withDeadline((client.mcp as any).auth.remove({ path: { name } }), 15_000, "mcp logout");
      await refreshOne(dir);
    },
    [refreshOne],
  );

  return { dirs, loading, busy, refreshLive, refresh, refreshOne, setEnabled, beginAuth, submitCode, signOut, rowKey };
}
