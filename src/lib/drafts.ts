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

// ponytail: re-reads immediately before write to minimize cross-tab lost-update race;
// if contention grows, use BroadcastChannel lock (global lock, per-tab merge)
function safeWrite(mutator: (m: Record<string, string>) => void) {
  try {
    const m = read();
    mutator(m);
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {}
}

export function setDraft(sid: string, val: string): void {
  if (!sid) return;
  safeWrite((m) => {
    if (val) m[sid] = val;
    else delete m[sid];
  });
}

export function clearDraft(sid: string): void {
  setDraft(sid, "");
}
