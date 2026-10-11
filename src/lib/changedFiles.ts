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
