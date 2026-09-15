// MCP server state — one status+config snapshot per workspace loaded in
// THIS window. Query set is getAllWorkspaces() only, so workspace-scoped
// servers from other OS windows (separate processes) are never fetched.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { opencodeFor, withDeadline } from "../api";
import { getAllWorkspaces } from "../lib/workspace";

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
  // read-only mirror so async flows (toggle settle polling) see the status
  // that is actually on screen, not the render closure they started in
  const dirsRef = useRef<McpDirState[]>([]);
  dirsRef.current = dirs;

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
    await Promise.all(
      all.map(async (dir) => {
        patchDir(dir, await fetchCore(dir));
        const tools = await fetchTools(dir);
        if (!alive.current) return;
        setDirs((prev) => prev.map((d) => (d.dir === dir ? { ...d, tools } : d)));
      }),
    );
  }, [patchDir]);

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

  // persistent per-workspace toggle: flip enabled in that dir's config, then
  // connect/disconnect for immediate effect. config.update makes the server
  // reload MCP async, so a single immediate re-read usually returns the
  // PRE-toggle status (the "sometimes works, never refreshes" bug) — poll
  // until the on-screen status actually changes, then paint. Throws so the
  // dialog can show real failures (e.g. rejected config update).
  const setEnabled = useCallback(
    async (dir: string, name: string, enabled: boolean) => {
      const key = rowKey(dir, name);
      setBusy((p) => new Set(p).add(key));
      try {
        const prevStatus = dirsRef.current.find((d) => d.dir === dir)?.servers[name]?.status;
        const client = await getClient(dir);
        const cur = await withDeadline((client.config as any).get(), 10_000, "mcp config");
        const cfg = ((cur as any)?.data ?? {}) as any;
        const entry = cfg?.mcp?.[name];
        if (entry && typeof entry === "object") {
          await withDeadline(
            (client.config as any).update({
              body: { ...cfg, mcp: { ...(cfg.mcp ?? {}), [name]: { ...entry, enabled } } },
            }),
            10_000,
            "mcp config update",
          );
        }
        try {
          if (enabled) await (client.mcp as any).connect({ path: { name } });
          else await (client.mcp as any).disconnect({ path: { name } });
        } catch {}
        // settle: any status change counts (enable may land on failed when
        // the server itself is broken — that is still the truth to show)
        let settled: McpDirState | null = null;
        for (let i = 0; i < 12; i++) {
          settled = await fetchCore(dir);
          if (settled.error || settled.servers[name]?.status !== prevStatus) break;
          if (i < 11) await sleep(1000);
        }
        const full: McpDirState = settled ?? (await fetchCore(dir));
        full.tools = await fetchTools(dir);
        patchDir(dir, full);
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

  return { dirs, loading, busy, refresh, refreshOne, setEnabled, beginAuth, submitCode, signOut, rowKey };
}
