// files actually touched by this response's tool calls — replaces the
// server git-diff `patch` part (needs a git repo, goes stale) with what the
// write/edit tools + bash commands really did.
export type ChangedEntry = { kind: "file"; path: string } | { kind: "bash"; command: string };

const FILE_TOOLS = new Set(["write", "edit", "multiedit", "patch"]);

export function extractChanged(parts: any[]): ChangedEntry[] {
  const out: ChangedEntry[] = [];
  const seen = new Set<string>();
  for (const p of parts ?? []) {
    if (!p || (p as any).type !== "tool") continue;
    const t = p as any;
    const st = t.state ?? {};
    const status = String(st.status ?? "");
    if (status === "pending" || status === "running") continue;
    const tool = String(t.tool ?? "").toLowerCase();
    if (FILE_TOOLS.has(tool)) {
      const raw = st.input?.filePath ?? st.input?.path;
      if (typeof raw !== "string") continue;
      const path = raw.trim();
      if (!path || seen.has(`f:${path}`)) continue;
      seen.add(`f:${path}`);
      out.push({ kind: "file", path });
    } else if (tool === "bash") {
      const raw = st.input?.command ?? st.input?.cmd;
      if (typeof raw !== "string") continue;
      const command = raw.trim();
      if (!command || seen.has(`b:${command}`)) continue;
      seen.add(`b:${command}`);
      out.push({ kind: "bash", command });
    }
  }
  return out;
}

// every file the session touched — per-user-message summary.diffs merged
// (same source as DiffPanel) PLUS tool-call file paths from every message's
// parts (always present, even when the server provides no snapshots).
// Deduped, first-seen order. Feeds the rewind+files button, which discards
// exactly this set.
export function sessionDiffFiles(msgs: any[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (f: string) => {
    if (!f || seen.has(f)) return;
    seen.add(f);
    out.push(f);
  };
  for (const m of msgs ?? []) {
    if ((m as any)?.info?.role === "user") {
      const list = ((m as any)?.info?.summary?.diffs ?? []) as { file?: unknown }[];
      for (const d of list) if (typeof d?.file === "string") push(d.file);
    }
    for (const e of extractChanged((m as any)?.parts ?? [])) {
      if (e.kind === "file") push(e.path);
    }
  }
  return out;
}
