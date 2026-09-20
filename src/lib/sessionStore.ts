import type { Message, Part } from "@opencode-ai/sdk/client";
import type { Msg } from "../types";

// authoritative mutable message stores, one per session — SSE mutations
// apply here synchronously (regardless of which session is open), then the
// owner mirrors into React state only for the active session (via onChange)
export function createSessionStore(onChange: (sid: string) => void) {
  // shared zero-usage constant — stable identity so memos never churn on it
  const EMPTY_USAGE = { cost: 0, tokens: 0 };
  const stores = new Map<string, Msg[]>();
  // parts that arrived before their parent message entry — flushed on creation
  const orphanParts = new Map<string, { sid: string; parts: Part[] }>(new Map());
  // streamed text deltas for parts that don't officially exist yet
  const pendingDeltas = new Map<string, { sid: string; text: string }>(new Map());
  // guards against a stale fetch overwriting a newer one (fast session hops)
  const fetchSeq = new Map<string, number>();
  // per-session token/cost totals, maintained incrementally so the footer
  // never rescans 20k messages per streaming frame
  const usage = new Map<string, { cost: number; tokens: number }>();

  const storeFor = (sid: string) => {
    let s = stores.get(sid);
    if (!s) {
      s = [];
      stores.set(sid, s);
    }
    return s;
  };

  const snapshot = (sid: string) => [...storeFor(sid)];

  // streaming mutations almost always target the tail message — scan from
  // the end so a 20k-message history costs O(1) per delta, not O(N)
  function findMsgIdx(store: Msg[], id: string): number {
    for (let i = store.length - 1; i >= 0; i--) if (store[i].info.id === id) return i;
    return -1;
  }

  const tokTotal = (info: any): number => {
    const t = info?.tokens ?? {};
    return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
  };
  const usageAdd = (sid: string, info: any, sign: 1 | -1) => {
    const cost = info?.cost ?? 0;
    const tok = tokTotal(info);
    if (!cost && !tok) return;
    const cur = usage.get(sid);
    const next = cur
      ? { cost: cur.cost + sign * cost, tokens: cur.tokens + sign * tok }
      : sign > 0
        ? { cost, tokens: tok }
        : { cost: 0, tokens: 0 };
    usage.set(sid, next);
  };

  // stashed early deltas for a part that arrived before its part/message —
  // fold them into the part unless it already carries them (authoritative
  // re-announce). Dropping them blindly loses short replies wholesale.
  function withStash(part: Part): Part {
    const key = `${(part as any).messageID}:${(part as any).id}`;
    const stash = pendingDeltas.get(key);
    if (!stash?.text) {
      if (stash) pendingDeltas.delete(key);
      return part;
    }
    const t = (part as any).type;
    if (t !== "text" && t !== "reasoning") {
      pendingDeltas.delete(key);
      return part;
    }
    const cur = (part as any).text ?? "";
    pendingDeltas.delete(key);
    if (!cur || (!cur.startsWith(stash.text) && !cur.endsWith(stash.text)))
      return { ...part, text: cur + stash.text } as Part;
    return part;
  }

  function upsertPart(part: Part): boolean {
    const store = storeFor(part.sessionID);
    const mi = findMsgIdx(store, part.messageID);
    if (mi < 0) return false;
    const m = store[mi];
    const pi = m.parts.findIndex((x) => x.id === part.id);
    // deltas can outrun the part announcement (short replies whose tokens
    // stream before the part exists) — fold them in unless the part already
    // carries them, else the part lands empty and the row hides until refetch
    let merged = withStash(part);
    // server text only grows (deltas append; text-end is cumulative), but its
    // snapshots travel on separate fibers and can land out of order — never
    // let a stale (shorter, non-extending) snapshot wipe streamed text, or a
    // short reply goes blank until refetch. Genuine rewrites (shorter and not
    // a prefix) still apply.
    if (pi >= 0) {
      const prev = m.parts[pi] as { type?: string; text?: string };
      const t = (merged as any).type;
      if ((t === "text" || t === "reasoning") && prev.type === t) {
        const a = prev.text ?? "";
        const b = (merged as any).text ?? "";
        if (a && (b === "" || (b.length < a.length && a.startsWith(b))))
          merged = { ...merged, text: a } as Part;
      }
    }
    // fresh message identity — memoized rows compare msg references, so an
    // update must swap its own object or the row never re-renders
    store[mi] = {
      ...m,
      info: { ...m.info },
      parts:
        pi < 0 ? [...m.parts, merged] : m.parts.map((x) => (x.id === part.id ? merged : x)),
    };
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
      const mi = store ? findMsgIdx(store, mid) : -1;
      const m = mi >= 0 ? store![mi] : undefined;
      const pi = m?.parts.findIndex((x) => x.id === pid) ?? -1;
      const pt = pi >= 0 ? (m!.parts[pi] as { type?: string; text?: string }) : undefined;
      if (m && pt && (pt.type === "text" || pt.type === "reasoning")) {
        // fresh identities — see upsertPart
        store![mi] = {
          ...m,
          info: { ...m.info },
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
  // parts that arrived before it (with their stashed early deltas folded in
  // — see withStash; dropping them duplicates nothing but loses short replies)
  function applyMessage(info: Message) {
    const sid = info.sessionID;
    const store = storeFor(sid);
    const i = findMsgIdx(store, info.id);
    if (i < 0) {
      const queued = orphanParts.get(info.id);
      orphanParts.delete(info.id);
      store.push({ info, parts: (queued?.parts ?? []).map(withStash) });
      usageAdd(sid, info, 1);
    } else {
      usageAdd(sid, store[i].info, -1);
      usageAdd(sid, info, 1);
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
    const store = stores.get(sid);
    if (store) {
      const mi = findMsgIdx(store, p.messageID);
      const m = mi >= 0 ? store[mi] : undefined;
      const pt = m?.parts.find(
        (x) => x.id === p.partID,
      ) as { type?: string; text?: string } | undefined;
      if (m && pt && (pt.type === "text" || pt.type === "reasoning")) {
        // fresh identities for just this message — see upsertPart
        store[mi] = {
          ...m,
          info: { ...m.info },
          parts: m.parts.map((x) =>
            x.id === p.partID ? { ...x, text: ((x as any).text ?? "") + p.delta } : x,
          ),
        };
        pendingDeltas.delete(key);
        onChange(sid);
        return;
      }
    }
    // part not announced yet — stash until it exists (no eager store creation)
    const cur = pendingDeltas.get(key);
    if (cur) cur.text += p.delta;
    else pendingDeltas.set(key, { sid, text: p.delta });
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
    const existing = stores.get(sid);
    // retain local command entries (they never exist server-side)
    const cmds = existing ? existing.filter((m) => (m as any)._isCommand) : [];
    const ids = new Set(list.map((m) => m.info.id));
    const keep = cmds.filter((c) => !ids.has(c.info.id));
    const next = keep.length ? [...list, ...keep].sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0)) : list;
    stores.set(sid, next);
    let cost = 0;
    let tokens = 0;
    for (const m of next) {
      const info = m.info as any;
      if (info.role !== "assistant") continue;
      cost += info.cost ?? 0;
      tokens += tokTotal(info);
    }
    usage.set(sid, { cost, tokens });
    dropStashes(sid);
  }

  function dropStashes(sid: string) {
    for (const [k, v] of orphanParts) if (v.sid === sid) orphanParts.delete(k);
    for (const [k, v] of pendingDeltas) if (v.sid === sid) pendingDeltas.delete(k);
  }

  function remove(sid: string) {
    dropStashes(sid);
    stores.delete(sid);
    fetchSeq.delete(sid);
    usage.delete(sid);
  }

  // fresh session / active-session delete: nothing stashed can matter anymore
  function clearStashes() {
    orphanParts.clear();
    pendingDeltas.clear();
  }

  // local slash-command trace — shown in history but never sent as a prompt
  let cmdSeq = 0;
  function addCommand(sid: string, text: string) {
    const now = Date.now();
    const id = `cmd-${++cmdSeq}-${now}`;
    const msg: any = {
      info: {
        id,
        sessionID: sid,
        role: "user",
        time: { created: now, completed: now },
        parentID: "",
        modelID: "",
        providerID: "",
        mode: "",
        path: { cwd: "", root: "" },
      },
      parts: [{ id: `${id}-p`, type: "text", text, sessionID: sid, messageID: id } as Part],
      _isCommand: true,
    };
    storeFor(sid).push(msg as Msg);
    onChange(sid);
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
    addCommand,
    cached: (sid: string) => stores.get(sid),
    usageOf: (sid: string) => usage.get(sid) ?? EMPTY_USAGE,
    // events that arrived but could never be placed (parts without a parent
    // message, deltas without a part) — at settle these mean a gap the live
    // stream won't fill, so the caller refetches instead of staying blank
    unplaced: (sid: string) => {
      let n = 0;
      for (const v of orphanParts.values()) if (v.sid === sid) n += v.parts.length;
      for (const v of pendingDeltas.values()) if (v.sid === sid) n++;
      return n;
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
