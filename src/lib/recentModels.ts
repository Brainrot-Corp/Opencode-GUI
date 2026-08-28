const KEY = "oc.recentModels";
const SECONDARY_KEY = "oc.recentSecondaryModels";
const MAX = 5;

function getRecent(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v: unknown) => typeof v === "string" && (v as string).trim()).slice(0, MAX);
  } catch {
    return [];
  }
}

function pushRecent(key: string, value: string): string[] {
  if (!value || !value.trim()) return getRecent(key);
  try {
    const cur = getRecent(key);
    const next = [value, ...cur.filter((v) => v !== value)].slice(0, MAX);
    localStorage.setItem(key, JSON.stringify(next));
    return next;
  } catch {
    return getRecent(key);
  }
}

export function getRecentModels(): string[] {
  return getRecent(KEY);
}

export function pushRecentModel(value: string): string[] {
  return pushRecent(KEY, value);
}

export function getRecentSecondaryModels(): string[] {
  return getRecent(SECONDARY_KEY);
}

export function pushRecentSecondaryModel(value: string): string[] {
  return pushRecent(SECONDARY_KEY, value);
}
