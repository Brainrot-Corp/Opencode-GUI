// Pinned sessions + local title overrides — pure localStorage access shared by
// useOpencode (list refresh, rename fallback, sidebar pin) and tests.
// Module-level caches avoid re-JSON.parse on every SSE session burst; they are
// invalidated on every write and on cross-window storage events (the hook
// wires the listener — this file stays DOM-free).
import type { Session } from "@opencode-ai/sdk/client";

export const PINNED_KEY = "oc.pinnedSessions";
export const TITLE_OVERRIDES_KEY = "oc.sessionTitles";

let pinnedCache: Set<string> | null = null;
let titlesCache: Record<string, string> | null = null;

export function invalidatePinned(): void {
  pinnedCache = null;
}
export function invalidateTitleOverrides(): void {
  titlesCache = null;
}

export function getPinned(): Set<string> {
  if (pinnedCache) return pinnedCache;
  let out = new Set<string>();
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) out = new Set(arr.filter((x: unknown) => typeof x === "string"));
    }
  } catch {}
  pinnedCache = out;
  return out;
}

export function getTitleOverrides(): Record<string, string> {
  if (titlesCache) return titlesCache;
  let out: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(TITLE_OVERRIDES_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out = obj as Record<string, string>;
    }
  } catch {}
  titlesCache = out;
  return out;
}

export function writeTitleOverride(id: string, title: string): void {
  try {
    const map = { ...getTitleOverrides() };
    map[id] = title;
    localStorage.setItem(TITLE_OVERRIDES_KEY, JSON.stringify(map));
    titlesCache = map;
  } catch {}
}

export function togglePinned(id: string): void {
  try {
    const set = getPinned();
    if (set.has(id)) set.delete(id);
    else set.add(id);
    localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
    pinnedCache = set;
  } catch {}
}

export function isPinned(id: string): boolean {
  return getPinned().has(id);
}

// title overrides + id dedupe + pinned-first sort (created desc within groups)
export function applyOverrides(list: Session[]): Session[] {
  const overrides = getTitleOverrides();
  const pinned = getPinned();
  const mapped = list.map((s) => (overrides[s.id] ? { ...s, title: overrides[s.id] } : s));
  const seen = new Set<string>();
  const deduped: Session[] = [];
  for (const s of mapped) if (!seen.has(s.id)) { seen.add(s.id); deduped.push(s); }
  return deduped.sort((a, b) => {
    const pa = pinned.has(a.id) ? 1 : 0;
    const pb = pinned.has(b.id) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.time?.created ?? 0) - (a.time?.created ?? 0);
  });
}

// shared per-session pin primitive (oc.sessionModels / oc.sessionVariants /
// oc.sessionAgents all share this exact reducer shape). value "" clears the
// pin (that session follows the global again); same-value writes are no-ops.
export function pinEntry<T extends Record<string, string>>(prev: T, sid: string, value: string): T {
  if (!value) {
    if (!(sid in prev)) return prev;
    const next = { ...prev };
    delete next[sid];
    return next;
  }
  if (prev[sid] === value) return prev;
  return { ...prev, [sid]: value };
}
