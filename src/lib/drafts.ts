const KEY = "oc.drafts";

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function getDraft(sid: string): string {
  if (!sid) return "";
  return read()[sid] ?? "";
}

export function setDraft(sid: string, val: string): void {
  if (!sid) return;
  const m = read();
  if (val) m[sid] = val;
  else delete m[sid];
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {}
}

export function clearDraft(sid: string): void {
  setDraft(sid, "");
}
