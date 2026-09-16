// subagent helpers — child session ids are never stored on chat parts, so
// every opener resolves them the same way instead of each growing a regex.
const SES_RE = /ses_[a-zA-Z0-9_-]+/;

// first child session id mentioned in free text (task tool output, <task> XML)
export function extractTaskId(text: string): string | null {
  if (!text) return null;
  const m = text.match(SES_RE);
  return m ? m[0] : null;
}

export type SubagentChild = { id: string; title?: string; timeCreated?: number };

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

// resolve an agent/subtask part (no id of its own) to a child session:
// description/title match first, then chronological position among the
// part kinds, else null (= caller shows the child picker instead of guessing)
// ponytail: chronological fallback, exact server linkage if it ever ships
export function resolveSubagentTarget(
  part: any,
  msgs: { parts: any[] }[],
  children: SubagentChild[],
): { id: string } | null {
  if (!part || !children.length) return null;
  const desc = norm(part.description);
  const prompt = norm(part.prompt);
  const name = norm(part.name ?? part.agent);
  if (desc || prompt || name) {
    const hit = children.find((c) => {
      const t = norm(c.title);
      if (!t) return false;
      return (!!desc && (t.includes(desc) || desc.includes(t))) || (!!name && t.includes(name));
    });
    if (hit) return { id: hit.id };
  }
  void prompt;
  // chronological: nth agent|subtask part -> nth child by creation order
  const order: unknown[] = [];
  for (const m of msgs)
    for (const p of m.parts ?? []) if (p?.type === "agent" || p?.type === "subtask") order.push(p);
  const idx = order.indexOf(part);
  const byTime = (c: SubagentChild) => c.timeCreated ?? 0;
  const sorted = [...children].sort((a, b) => byTime(a) - byTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (idx >= 0 && idx < sorted.length) return { id: sorted[idx].id };
  return null;
}
