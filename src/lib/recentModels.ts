const KEY = "oc.recentModels";
const MAX = 5;

export function getRecentModels(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v: unknown) => typeof v === "string" && v.trim()).slice(0, MAX);
  } catch {
    return [];
  }
}

export function pushRecentModel(value: string): string[] {
  if (!value || !value.trim()) return getRecentModels();
  try {
    const cur = getRecentModels();
    const next = [value, ...cur.filter((v) => v !== value)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return getRecentModels();
  }
}
