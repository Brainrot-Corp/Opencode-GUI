// custom session order per workspace — Sidebar display layer only.
// Pins stay out: pinned rows are never draggable and always render first
// (sorted by created desc via useOpencode). Only unpinned ids are stored here.
// ponytail: localStorage map, no server API; new ids render on top until dragged.
import { normWorkspace } from "./platform";

const KEY = "oc.sessionOrder";

type OrderMap = Record<string, string[]>;

function load(): OrderMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    if (o && typeof o === "object" && !Array.isArray(o)) return o as OrderMap;
  } catch {}
  return {};
}

function save(map: OrderMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {}
}

export function getSessionOrder(dir: string): string[] {
  const map = load();
  const arr = map[normWorkspace(dir)];
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
}

export function setSessionOrder(dir: string, ids: string[]) {
  const map = load();
  const key = normWorkspace(dir);
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  if (!clean.length) delete map[key];
  else map[key] = clean.slice(0, 500);
  save(map);
}

/** Sort unpinned sessions: new ids (absent du stored) en tête (created desc),
 *  puis stored filtré aux ids existants. Sans stored → créé desc (ordre serveur). */
export function orderUnpinned<T extends { id: string; time?: { created?: number } }>(
  dir: string,
  list: T[],
): T[] {
  const stored = getSessionOrder(dir);
  if (!stored.length) return [...list].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
  const pos = new Map(stored.map((id, i) => [id, i] as const));
  const fresh = list
    .filter((s) => !pos.has(s.id))
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
  const known = list
    .filter((s) => pos.has(s.id))
    .sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  return [...fresh, ...known];
}

/** Prune les ids supprimés du stored (appelé au refresh si besoin). */
export function pruneSessionOrder(dir: string, existingIds: Set<string>) {
  const stored = getSessionOrder(dir);
  if (!stored.length) return;
  const next = stored.filter((id) => existingIds.has(id));
  if (next.length !== stored.length) setSessionOrder(dir, next);
}
