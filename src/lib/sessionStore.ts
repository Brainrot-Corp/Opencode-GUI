import type { Message, Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";

// authoritative mutable message stores, one per session — SSE mutations
// apply here synchronously (regardless of which session is open), then the
// owner mirrors into React state only for the active session (via onChange)
export function createSessionStore(onChange: (sid: string) => void) {
  const stores = new Map<string, Msg[]>();
  // parts that arrived before their parent message entry — flushed on creation
  const orphanParts = new Map<string, { sid: string; parts: Part[] }>(new Map());
  // streamed text deltas for parts that don't officially exist yet
  const pendingDeltas = new Map<string, { sid: string; text: string }>(new Map());
  // guards against a stale fetch overwriting a newer one (fast session hops)
  const fetchSeq = new Map<string, number>();

  const storeFor = (sid: string) => {
    let s = stores.get(sid);
    if (!s) {
      s = [];
      stores.set(sid, s);
    }
    return s;
  };

  const snapshot = (sid: string) => [...storeFor(sid)];

  function upsertPart(part: Part): boolean {
    const store = storeFor(part.sessionID);
    const mi = store.findIndex((x) => x.info.id === part.messageID);
    if (mi < 0) return false;
    const m = store[mi];
    const pi = m.parts.findIndex((x) => x.id === part.id);
    // fresh message identity — memoized rows compare msg references, so an
    // update must swap its own object or the row never re-renders
    store[mi] = {
      ...m,
      parts:
        pi < 0 ? [...m.parts, part] : m.parts.map((x) => (x.id === part.id ? part : x)),
    };
    // authoritative full-text update — drop any stashed deltas for this part
    pendingDeltas.delete(`${part.messageID}:${part.id}`);
    onChange(part.sessionID);
    return true;
  }

  // append stashed deltas to their parts once those parts exist
  function flushDeltas() {
    for (const [key, entry] of [...pendingDeltas]) {
      const cut = key.lastIndexOf(":");
      const mid = key.slice(0, cut);
      const pid = key.slice(cut + 1);
      const store = stores.get(entry.sid);
      const mi = store?.findIndex((x) => x.info.id === mid) ?? -1;
      const m = mi >= 0 ? store![mi] : undefined;
      const pi = m?.parts.findIndex((x) => x.id === pid) ?? -1;
      const pt = pi >= 0 ? (m!.parts[pi] as { type?: string; text?: string }) : undefined;
      if (m && pt && (pt.type === "text" || pt.type === "reasoning")) {
        // fresh identities — see upsertPart
        store![mi] = {
          ...m,
          parts: m.parts.map((x) =>
            x.id === pid
              ? ({ ...x, text: (((x as any).text ?? "") + entry.text) as string } as Part)
              : x,
          ),
        };
        pendingDeltas.delete(key);
        if (entry.sid) onChange(entry.sid);
      } else if (!store || !m) {
        // store gone (session deleted) — stale deltas; keep waiting otherwise
        if (!store) pendingDeltas.delete(key);
      }
    }
  }

  // message.updated body: insert/replace the message header, flushing any
  // parts that arrived before it. Their stashed pre-deltas are stale — the
  // queued parts are authoritative (same rule as upsertPart); keeping them
  // makes flushDeltas re-append early text = duplicated streaming.
  function applyMessage(info: Message) {
    const sid = info.sessionID;
    const store = storeFor(sid);
    const i = store.findIndex((m) => m.info.id === info.id);
    if (i < 0) {
      const queued = orphanParts.get(info.id);
      orphanParts.delete(info.id);
      for (const pt of queued?.parts ?? [])
        pendingDeltas.delete(`${info.id}:${(pt as any).id}`);
      store.push({ info, parts: queued?.parts ?? [] });
    } else {
      store[i] = { ...store[i], info };
    }
    onChange(sid);
    flushDeltas();
  }

  // message.part.updated body — queues orphans when the parent is unknown
  function applyPart(part: Part) {
    if (!upsertPart(part)) {
      const q = orphanParts.get(part.messageID);
      if (q) q.parts.push(part);
      else orphanParts.set(part.messageID, { sid: part.sessionID, parts: [part] });
    } else {
      orphanParts.delete(part.messageID);
    }
  }

  // message.part.delta body — incremental stream chunk
  function applyDelta(p: { sessionID: string; messageID: string; partID: string; delta: string }) {
    const sid = p.sessionID;
    const key = `${p.messageID}:${p.partID}`;
    const store = storeFor(sid);
    const mi = store.findIndex((x) => x.info.id === p.messageID);
    const m = mi >= 0 ? store[mi] : undefined;
    const pt = m?.parts.find(
      (x) => x.id === p.partID,
    ) as { type?: string; text?: string } | undefined;
    if (m && pt && (pt.type === "text" || pt.type === "reasoning")) {
      // fresh identities for just this message — see upsertPart
      store[mi] = {
        ...m,
        parts: m.parts.map((x) =>
          x.id === p.partID ? { ...x, text: ((x as any).text ?? "") + p.delta } : x,
        ),
      };
      pendingDeltas.delete(key);
      onChange(sid);
    } else {
      // part not announced yet — stash until it exists
      const cur = pendingDeltas.get(key);
      if (cur) cur.text += p.delta;
      else pendingDeltas.set(key, { sid, text: p.delta });
    }
  }

  // fetch bookkeeping: bump the sequence, report staleness, install results
  function beginFetch(sid: string) {
    const seq = (fetchSeq.get(sid) ?? 0) + 1;
    fetchSeq.set(sid, seq);
    return seq;
  }

  const isStale = (sid: string, seq: number) => fetchSeq.get(sid) !== seq;

  // a completed fetch is authoritative for THIS session — drop its stashes,
  // install the list, and let the caller decide whether to show it
  function setFetched(sid: string, list: Msg[]) {
    stores.set(sid, list);
    dropStashes(sid);
  }

  function dropStashes(sid: string) {
    for (const [k, v] of orphanParts) if (v.sid === sid) orphanParts.delete(k);
    for (const [k, v] of pendingDeltas) if (v.sid === sid) pendingDeltas.delete(k);
  }

  function remove(sid: string) {
    stores.delete(sid);
    fetchSeq.delete(sid);
  }

  // fresh session / active-session delete: nothing stashed can matter anymore
  function clearStashes() {
    orphanParts.clear();
    pendingDeltas.clear();
  }

  // synthetic entry for a prompt that failed before the server created any
  // message — renders as an error bubble; the next authoritative fetch
  // replaces it (the failed send was never persisted server-side either)
  let errSeq = 0;
  function addError(sid: string, message: string) {
    storeFor(sid).push({
      info: {
        id: `err-${++errSeq}`,
        sessionID: sid,
        role: "assistant",
        time: { created: Date.now() },
        parentID: "",
        modelID: "",
        providerID: "",
        mode: "",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        error: { name: "UnknownError", data: { message } } as any,
      } as Message,
      parts: [],
    });
    onChange(sid);
  }

  return {
    snapshot,
    applyMessage,
    applyPart,
    applyDelta,
    beginFetch,
    isStale,
    setFetched,
    dropStashes,
    remove,
    clearStashes,
    addError,
    cached: (sid: string) => stores.get(sid),
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
