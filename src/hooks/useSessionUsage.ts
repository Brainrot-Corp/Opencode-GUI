// Children/cost/usage tracking for the active session, extracted verbatim
// from useOpencode. Owns: the activeChildren list, the event-driven children
// refresh (no busy poll — task-completion events + busy→idle settle edge),
// and the derived sessionUsage / childTaskCosts totals. The message store +
// lineage map come in through deps; `msgs` is passed only as a recompute
// trigger (the store mutates alongside it, same as before the split).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpencodeClient, Session } from "@opencode-ai/sdk/client";
import { getDirectory } from "../api";
import type { createSessionStore } from "../lib/sessionStore";
import type { Msg } from "../types";

type SessionStore = ReturnType<typeof createSessionStore>;

export type SessionUsageDeps = {
  activeId: string;
  busyIds: Set<string>;
  msgs: Msg[]; // recompute trigger for sessionUsage (store mutates alongside)
  store: SessionStore;
  sessionDirRef: { current: Map<string, string> };
  childParentRef: { current: Map<string, string> };
  syncTopBadge: (topId: string) => void;
  clientFor: (dir?: string) => Promise<{ client: OpencodeClient }>;
};

export function useSessionUsage(deps: SessionUsageDeps) {
  const { activeId, busyIds, msgs, store, sessionDirRef, childParentRef, syncTopBadge, clientFor } = deps;

  const [activeChildren, setActiveChildren] = useState<Session[]>([]);
  // poll runs every 3s while busy — replace state only on real changes so
  // childTaskCosts (→ MsgRow taskCosts prop) keeps a stable identity
  const childrenSigRef = useRef("");
  const refreshActiveChildren = useCallback(async (sid: string) => {
    if (!sid) { childrenSigRef.current = ""; setActiveChildren([]); return; }
    try {
      const dir = sessionDirRef.current.get(sid) ?? getDirectory();
      const { client } = await clientFor(dir);
      const r = await client.session.children({ path: { id: sid } });
      const list: Session[] = r.data ?? [];
      for (const c of list) childParentRef.current.set(c.id, c.parentID ?? sid);
      // ponytail: one-level fetch; recurse if nesting matters (rare)
      // fetch grandchildren best-effort so nested sub-agents are not missed
      if (list.length) {
        try {
          const deeper = await Promise.all(list.map(async (c) => {
            try {
              const rr = await client.session.children({ path: { id: c.id } });
              const arr = rr.data ?? [];
              for (const g of arr) childParentRef.current.set(g.id, c.id);
              return arr;
            } catch { return [] as Session[]; }
          }));
          const extra = deeper.flat();
          // dedup by id
          const seen = new Set(list.map((s) => s.id));
          for (const ch of extra) if (!seen.has(ch.id)) { seen.add(ch.id); list.push(ch); }
        } catch {}
      }
      const sig = JSON.stringify(list);
      if (sig !== childrenSigRef.current) {
        childrenSigRef.current = sig;
        setActiveChildren(list);
      }
      // lineage just learned — badge the parent for any pending descendant
      // asks that arrived before we knew it (popups stay session-local)
      syncTopBadge(sid);
    } catch {
      // keep previous on error (transient)
    }
  }, []);
  const refreshChildrenRef = useRef(refreshActiveChildren);
  useEffect(() => { refreshChildrenRef.current = refreshActiveChildren; }, [refreshActiveChildren]);
  useEffect(() => {
    if (!activeId) { setActiveChildren([]); return; }
    void refreshActiveChildren(activeId);
  }, [activeId, refreshActiveChildren]);
  // the 3s busy-children poll is gone — event triggers cover the real changes:
  // message.part.updated(task completed) fires refreshChildrenRef 400ms later
  // (opencodeEvents.ts), session.created/updated with parent===active refresh
  // immediately, and the busy→idle settle edge below pulls the final cost.
  // During a long-running subagent the live cost now lands at those moments
  // instead of climbing every 3s.
  // when the turn settles (busy → idle) the last task's final cost lands right
  // after the last delta — pull once more so total is not stale
  const prevBusyRef = useRef(false);
  useEffect(() => {
    const was = prevBusyRef.current;
    const isBusy = !!activeId && busyIds.has(activeId);
    prevBusyRef.current = isBusy;
    if (was && !isBusy && activeId) void refreshActiveChildren(activeId);
  }, [busyIds, activeId, refreshActiveChildren]);

  // session-wide token/cost totals — summed from the authoritative store
  // (not the revert-filtered view) so rewinding doesn't rewrite history;
  // msgs in deps is the recompute trigger (the store mutates alongside it)
  // + all descendant sub-agent sessions (via /session/{id}/children) so the
  // footer shows the real spend, not just the primary agent.
  const sessionUsage = useMemo(() => {
    // store keeps per-session totals incrementally — no full-history scan
    // per streaming frame (20k messages would make the footer O(N)/frame)
    const s = activeId ? store.usageOf(activeId) : null;
    let cost = s?.cost ?? 0;
    let tokens = s?.tokens ?? 0;
    // ponytail: SDK Session type is stale for children — server adds cost/tokens
    for (const ch of activeChildren) {
      const c = ch as any;
      cost += c.cost ?? 0;
      const t = c.tokens ?? {};
      tokens += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
    }
    return { cost, tokens };
  }, [msgs, activeId, activeChildren]);
  // stable object identity while totals are unchanged — streaming deltas
  // don't move tokens, so consumers (composer chip) don't re-render per frame
  const usageStable = useMemo(
    () => ({ cost: sessionUsage.cost, tokens: sessionUsage.tokens }),
    [sessionUsage.cost, sessionUsage.tokens],
  );
  const childTaskCosts = useMemo(() => {
    const m: Record<string, { cost: number; tokens: number; title?: string }> = {};
    // ponytail: SDK Session type is stale for children — server adds cost/tokens
    for (const ch of activeChildren) {
      const c = ch as any;
      const t = c.tokens ?? {};
      const tok = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
      m[c.id] = { cost: c.cost ?? 0, tokens: tok, title: c.title };
    }
    return m;
  }, [activeChildren]);

  return {
    activeChildren,
    refreshActiveChildren,
    refreshChildrenRef,
    sessionUsage: usageStable,
    childTaskCosts,
  };
}

export type SessionUsageApi = ReturnType<typeof useSessionUsage>;
