import { useCallback, useEffect, useSyncExternalStore } from "react";
import { opencode, opencodeFor } from "../api";
import { toOpPath } from "../lib/remotes";
import { isWindows } from "../lib/platform";

export type FileNode = {
  name: string;
  path: string;
  absolute: string;
  type: "file" | "directory";
  ignored: boolean;
};

let kids = new Map<string, FileNode[]>();
let err = "";
let loadingPath = "";
const pending = new Map<string, Promise<FileNode[]>>();
const needsRefresh = new Set<string>();
let version = 0;
const subs = new Set<() => void>();

function notify() {
  version++;
  for (const c of subs) c();
}
function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}
function getVersion() {
  return version;
}

function normalizePath(p: string): string {
  const f = p.replace(/\\/g, "/");
  // strip trailing slashes (keep root "/" and "C:/" intact)
  if (f.length > 1 && f.endsWith("/")) {
    if (/^[A-Za-z]:\/$/.test(f)) return f;
    return f.replace(/\/+$/, "");
  }
  return f;
}
export function normalizeFilePath(p: string): string { return normalizePath(p); }

function cacheKey(dir: string, path: string) {
  return `${normalizePath(dir)}\0${normalizePath(path)}`;
}

async function fetchKids(path: string, retries = 2, dir = ""): Promise<FileNode[]> {
  const key = cacheKey(dir, path);
  if (pending.has(key)) return pending.get(key)!;
  const p = (async () => {
    loadingPath = key;
    notify();
    try {
      const { client } = dir ? await opencodeFor(dir) : await opencode();
      const r = await (client.file as any).list({ query: { path } });
      const nodes = ((r.data ?? []) as FileNode[]).map((n) => ({
        ...n,
        // remote servers report their own paths — map to ssh:// pseudo-paths
        // so Tauri file ops route over ssh (local paths pass through)
        absolute: toOpPath(n.absolute, dir),
      })).slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      kids = new Map(kids).set(key, nodes);
      // drop cached subdirs that no longer exist (deleted-dir cleanup —
      // parent refresh lists the truth, stale child keys would linger)
      {
        const rel = normalizePath(path);
        const normD = normalizePath(dir);
        const alive = new Set(
          nodes.filter((n) => n.type === "directory").map((n) => normalizePath(n.path)),
        );
        const next = new Map(kids);
        for (const k2 of [...next.keys()]) {
          const [d2, p2] = k2.split("\0");
          if (d2 !== normD || p2 === rel) continue;
          if (rel ? !p2.startsWith(rel + "/") : !p2) continue;
          const top = (rel ? p2.slice(rel.length + 1) : p2).split("/")[0];
          if (!alive.has(rel ? `${rel}/${top}` : top)) next.delete(k2);
        }
        kids = next;
      }
      err = "";
      return nodes;
    } catch (e: any) {
      if (retries > 0 && path === "") {
        await new Promise((res) => setTimeout(res, 800));
        pending.delete(key);
        return fetchKids(path, retries - 1, dir);
      }
      if (path === "") {
        err = String(e);
      } else {
        // stale subdir (e.g. deleted) — drop silently, no global banner
        const next = new Map(kids);
        next.delete(key);
        kids = next;
      }
      throw e;
    } finally {
      loadingPath = "";
      pending.delete(key);
      notify();
      if (needsRefresh.has(key)) {
        needsRefresh.delete(key);
        window.setTimeout(() => void fetchKids(path, 2, dir).catch(() => {}), 50);
      }
    }
  })();
  pending.set(key, p);
  return p;
}

export function getFileKids() {
  return kids;
}
export function invalidateFileCache(path?: string, dir = "") {
  if (path === undefined) {
    kids = new Map();
  } else {
    const key = cacheKey(dir, path);
    const normDir = normalizePath(dir);
    const normPath = normalizePath(path);
    const next = new Map(kids);
    next.delete(key);
    for (const k of [...next.keys()]) {
      const [d, p] = k.split("\0");
      if (d !== normDir) continue;
      if (!normPath || p === normPath || p.startsWith(normPath + "/")) next.delete(k);
    }
    kids = next;
  }
  err = "";
  notify();
}

let watcherSetup = false;
const watcherTimers = new Map<string, number>();

function absEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const remote = a.startsWith("ssh://") || b.startsWith("ssh://");
  if (!remote && isWindows()) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Absolute dir path for a cached key, in cached-absolute domain (ssh://-mapped for remotes). "" when unknown. */
function absDirFor(wsDir: string, rel: string): string {
  const normRel = normalizePath(rel);
  if (!normRel) {
    // root: an explicit workspace dir IS the root; primary ("") is inferred
    // from a child's absolute minus its relative path
    if (normalizePath(wsDir)) return normalizePath(wsDir);
    const nodes = kids.get(cacheKey(wsDir, ""));
    if (nodes) {
      for (const n of nodes) {
        const abs = normalizePath(n.absolute);
        const rp = normalizePath(n.path);
        if (abs === rp || abs.endsWith("/" + rp)) {
          const root = abs.slice(0, abs.length - rp.length).replace(/\/+$/, "");
          if (root) return root;
        }
      }
    }
    return "";
  }
  const normDir = normalizePath(wsDir);
  for (const [k, nodes] of kids) {
    const [d] = k.split("\0");
    if (d !== normDir) continue;
    for (const n of nodes) {
      if (normalizePath(n.path) === normRel) return normalizePath(n.absolute);
    }
  }
  return "";
}

/** Re-fetch every cached dir of one workspace (right-click refresh). Immediate; single-flight safe. */
export function refreshWorkspaceFiles(wsDir = "") {
  const normDir = normalizePath(wsDir);
  const paths: { d: string; p: string }[] = [];
  for (const k of kids.keys()) {
    const [d, p] = k.split("\0");
    if (d !== normDir) continue;
    paths.push({ d, p });
    // manual refresh wins over debounced watcher fetches — drop their timers
    const t = watcherTimers.get(k);
    if (t) { window.clearTimeout(t); watcherTimers.delete(k); }
    if (pending.has(k)) needsRefresh.add(k);
  }
  // drop cache first so the tree shows skeletons while refetching
  if (paths.length) {
    const next = new Map(kids);
    for (const { d, p } of paths) next.delete(cacheKey(d, p));
    kids = next;
    err = "";
    notify();
  }
  const jobs = paths.map(({ d, p }) => fetchKids(p, 2, d).catch(() => {}));
  if (!jobs.length) jobs.push(fetchKids("", 2, wsDir).catch(() => {}));
  return Promise.all(jobs);
}
function scheduleFetch(key: string, dir: string, path: string) {
  if (pending.has(key)) {
    needsRefresh.add(key);
    return;
  }
  const prev = watcherTimers.get(key);
  if (prev) window.clearTimeout(prev);
  const id = window.setTimeout(() => {
    watcherTimers.delete(key);
    if (pending.has(key)) {
      needsRefresh.add(key);
      return;
    }
    void fetchKids(path, 2, dir).catch(() => {});
  }, 180);
  watcherTimers.set(key, id);
}
function setupWatcher() {
  if (watcherSetup) return;
  watcherSetup = true;
  window.addEventListener("oc:file-changed", ((e: Event) => {
    const raw = (e as CustomEvent<string>).detail || "";
    if (!raw) return;
    const norm = normalizePath(raw);
    if (norm.includes(":") || norm.startsWith("/")) {
      // absolute (parcel watcher always sends server-absolute) — map to the
      // parent dir's cached key per workspace and refresh only that
      let matched = false;
      for (const k of [...kids.keys()]) {
        const [d, p] = k.split("\0");
        const dirAbs = absDirFor(d, p);
        if (!dirAbs) continue;
        const evtAbs = normalizePath(toOpPath(norm, d));
        const slash = evtAbs.lastIndexOf("/");
        let parentAbs = slash >= 0 ? evtAbs.slice(0, slash) : "";
        if (parentAbs === "" && evtAbs.startsWith("/")) parentAbs = "/";
        if (/^[A-Za-z]:$/.test(parentAbs)) parentAbs += "/";
        if (absEqual(dirAbs, parentAbs)) {
          scheduleFetch(k, d, p);
          matched = true;
        }
      }
      if (!matched) {
        // unknown parent (uncached dir, empty root) — refresh roots so
        // root-level creates still appear; collapsed dirs load fresh on expand
        for (const k of kids.keys()) if (k.endsWith("\0")) scheduleFetch(k, k.split("\0")[0], "");
      }
      return;
    }
    const slash = norm.lastIndexOf("/");
    const parent = slash >= 0 ? norm.slice(0, slash) : "";
    // schedule for any dir that has this parent cached
    for (const k of kids.keys()) {
      const [dir, p] = k.split("\0");
      if (p === parent) scheduleFetch(k, dir, parent);
    }
    // also root fallback
    for (const k of kids.keys()) if (k.endsWith("\0")) scheduleFetch(k, k.split("\0")[0], "");
  }) as EventListener);
}

export function useFileCache(dir = "") {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  void v;
  useEffect(() => {
    setupWatcher();
    const key = cacheKey(dir, "");
    if (kids.has(key) || pending.has(key)) return;
    const run = () => void fetchKids("", 2, dir).catch(() => {});
    const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: any) => number) | undefined;
    if (ric) {
      const id = ric(run, { timeout: 1500 });
      return () => (window as any).cancelIdleCallback?.(id);
    } else {
      const t = window.setTimeout(run, 120);
      return () => window.clearTimeout(t);
    }
  }, [dir]);

  const load = useCallback((path: string, force = false) => {
    const key = cacheKey(dir, path);
    if (!force && kids.has(key)) return Promise.resolve(kids.get(key)!);
    return fetchKids(path, 2, dir).catch(() => undefined as any);
  }, [dir]);

  const refresh = useCallback((path: string) => {
    const key = cacheKey(dir, path);
    const next = new Map(kids);
    next.delete(key);
    kids = next;
    notify();
    return fetchKids(path, 2, dir).catch(() => undefined as any);
  }, [dir]);

  const invalidate = useCallback((path?: string) => invalidateFileCache(path, dir), [dir]);

  // view filtered to this dir
  const normDir = normalizePath(dir);
  const dirKids = new Map<string, FileNode[]>();
  for (const [k, v2] of kids) {
    const [d, p] = k.split("\0");
    if (d === normDir) dirKids.set(p, v2);
  }
  const isLoading = useCallback((p: string) => {
    const k = cacheKey(dir, p);
    return loadingPath === k || pending.has(k);
  }, [dir]);

  return {
    kids: dirKids,
    error: err,
    loadingDir: loadingPath,
    load,
    refresh,
    invalidate,
    isLoading,
  };
}
