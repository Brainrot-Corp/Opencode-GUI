// skill state — per workspace loaded in THIS window. Query set is
// getAllWorkspaces() only, so skills from other OS windows (separate
// processes) are never fetched. Skills arrive as command.list() entries
// with source "skill"; template carries the full SKILL.md body.
import { useCallback, useEffect, useRef, useState } from "react";
import { withDeadline } from "../api";
import { getClientFor } from "../lib/apiErr";
import { getAllWorkspaces } from "../lib/workspace";

export type SkillEntry = {
  name: string;
  description: string;
  template: string;
};

export type SkillDirState = {
  dir: string;
  skills: SkillEntry[];
  error: string;
  // core not yet resolved — section renders a skeleton row
  pending: boolean;
};

export function useSkills() {
  const [dirs, setDirs] = useState<SkillDirState[]>([]);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [refreshLive, setRefreshLive] = useState(false);

  const patchDir = useCallback((dir: string, next: SkillDirState) => {
    if (!alive.current) return;
    setDirs((prev) => {
      const i = prev.findIndex((d) => d.dir === dir);
      if (i < 0) return [...prev, next];
      if (prev[i] === next) return prev;
      const out = [...prev];
      out[i] = next;
      return out;
    });
  }, []);

  // each workspace paints as soon as its own list resolves — one slow/dead
  // workspace (e.g. unreachable SSH) never holds the others hostage
  const refresh = useCallback(async () => {
    const all = getAllWorkspaces();
    setLoading(true);
    setDirs(all.map((dir) => ({ dir, skills: [], error: "", pending: true })));
    setLoading(false);
    setRefreshLive(true);
    try {
      await Promise.all(
        all.map(async (dir) => {
          let next: SkillDirState;
          try {
            const client = await getClientFor(dir, "skill workspace");
            const r = (await withDeadline(client.command.list(), 10_000, "skill list")) as any;
            const list = ((r.data ?? []) as any[])
              .filter((c) => c.source === "skill")
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => ({ name: c.name, description: c.description ?? "", template: c.template ?? "" }));
            next = { dir, skills: list, error: "", pending: false };
          } catch (e) {
            next = { dir, skills: [], error: e instanceof Error ? e.message : String(e), pending: false };
          }
          patchDir(dir, next);
        }),
      );
    } finally {
      if (alive.current) setRefreshLive(false);
    }
  }, [patchDir]);

  useEffect(() => {
    void refresh();
    const onWs = () => {
      void refresh();
    };
    // same-window event only — never storage events (would adopt other windows)
    window.addEventListener("oc:workspaces-changed", onWs);
    return () => window.removeEventListener("oc:workspaces-changed", onWs);
  }, [refresh]);

  return { dirs, loading, refreshLive, refresh };
}
