// Pure helpers for the phone-relay notification bridge (docs/mobile-companion.md
// phase 1). No DOM/WS here — src/hooks/useNotifyRelay.ts owns the socket; this
// module stays testable under scripts/run-tests.mjs (no window at import time).

export type NotifyKind = "idle" | "permission" | "question" | "error";
export type NotifyMsg = { kind: NotifyKind; title: string; body: string; sessionID: string; session?: string };

export type NotifySettings = {
  relayUrl: string;
  token: string;
  runLocal: boolean;
  onIdle: boolean;
  onPermission: boolean;
  onQuestion: boolean;
  onError: boolean;
};

export const SETTINGS_KEY = "oc.settings";

export function validRelayUrl(u: unknown): u is string {
  return typeof u === "string" && /^wss?:\/\//.test(u) && u.length < 500;
}

// mirror of the useSettings.ts loader validation — reads oc.settings.notify
// straight from the settings blob (GitPanel settingsSnap pattern: the drawer
// writes the blob, we poll the same key). null = relay off. runLocal mode
// (GUI-managed relay) needs no manual URL — relayUrl may be empty.
export function readNotifySettings(): NotifySettings | null {
  try {
    const n = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}")?.notify;
    if (!n || typeof n !== "object") return null;
    const runLocal = !!n.runLocal;
    const hasUrl = validRelayUrl(n.relayUrl);
    if (!runLocal && !hasUrl) return null;
    const flag = (v: unknown) => (v === undefined ? true : !!v);
    return {
      relayUrl: hasUrl ? n.relayUrl : "",
      token: typeof n.token === "string" ? n.token.slice(0, 200) : "",
      runLocal,
      onIdle: flag(n.onIdle),
      onPermission: flag(n.onPermission),
      onQuestion: flag(n.onQuestion),
      onError: flag(n.onError),
    };
  } catch {
    return null;
  }
}

// one-notification-per-key dedupe with a TTL sweep — keys like `perm:<ask id>`
// or `idle:<session id>`; the sweep runs opportunistically on every check.
export function createDedupe(ttlMs = 10 * 60_000): { seen(key: string): boolean } {
  const hits = new Map<string, number>();
  return {
    seen(key: string): boolean {
      const now = Date.now();
      for (const [k, t] of hits) if (now - t > ttlMs) hits.delete(k);
      const dup = hits.has(key);
      hits.set(key, now);
      return dup;
    },
  };
}

// sessions that just left the busy set = their turn finished (message settle
// or session.idle) — the two completion paths already collapse into one
// busy-set transition, so no per-event logic here.
export function busyLeaving(prev: Set<string>, next: Set<string>): string[] {
  const out: string[] = [];
  for (const sid of prev) if (!next.has(sid)) out.push(sid);
  return out;
}

const askTitle = (p: { title?: string }): string => p.title || "permission";

// the AI's final reply, flattened to one readable line — the body of the
// turn-complete notification so the phone shows what the agent actually said
export function assistantReplyText(
  msgs: { info?: { role?: string }; parts?: { type?: string; text?: string }[] }[],
  max = 240,
): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.info?.role !== "assistant") continue;
    const text = (m.parts ?? [])
      .filter((p) => p.type === "text" && p.text?.trim())
      .map((p) => (p.text as string).trim())
      .join(" ");
    if (!text) continue;
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > max ? one.slice(0, max - 1) + "…" : one;
  }
  return "";
}

export function permNotifyText(ask: { id: string; sessionID: string; type: string; title: string }): NotifyMsg {
  return {
    kind: "permission",
    title: `Permission needed: ${ask.type}`,
    body: askTitle(ask),
    sessionID: ask.sessionID,
  };
}

export function questionNotifyText(ask: { id: string; sessionID: string; questions: { question?: string; header?: string; options?: string[] }[] }): NotifyMsg {
  const first = ask.questions?.[0];
  // options ride along so the banner alone can answer — no app open needed
  const opts = (first?.options ?? []).filter(Boolean).slice(0, 4);
  const body = [first?.question || "", opts.length ? `Options: ${opts.join(" · ")}` : ""]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 300);
  return {
    kind: "question",
    title: `Question: ${first?.header || "agent"}`,
    body,
    sessionID: ask.sessionID,
  };
}

export function errorNotifyText(sid: string, message: string): NotifyMsg {
  return {
    kind: "error",
    title: "Agent error",
    body: message.slice(0, 300),
    sessionID: sid,
  };
}

// reconnect backoff: 1s doubling to a 30s cap
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 5)));
}
