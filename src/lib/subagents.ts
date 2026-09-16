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

// resolve an agent/subtask part — or a still-running task tool part, which
// has no output id yet — to a child session: output id first, then
// description/title match, then chronological position among the part kinds,
// else null (= caller shows the child picker instead of guessing)
// ponytail: chronological fallback, exact server linkage if it ever ships
export function resolveSubagentTarget(
  part: any,
  msgs: { parts: any[] }[],
  children: SubagentChild[],
): { id: string } | null {
  if (!part || !children.length) return null;
  const isTask = part?.type === "tool" && String(part.tool ?? "").toLowerCase() === "task";
  if (isTask) {
    const outId = extractTaskId(String(part.state?.output ?? ""));
    if (outId) return { id: outId };
  }
  const st = part.state ?? {};
  const needles = [
    part.description,
    part.name ?? part.agent,
    st.input?.description,
    st.input?.prompt,
    st.input?.subagentType ?? st.input?.agent,
  ]
    .map(norm)
    .filter(Boolean);
  if (needles.length) {
    const hit = children.find((c) => {
      const t = norm(c.title);
      if (!t) return false;
      return needles.some((nd) => t.includes(nd) || nd.includes(t));
    });
    if (hit) return { id: hit.id };
  }
  // chronological: nth agent|subtask|task part -> nth child by creation order
  const order: unknown[] = [];
  for (const m of msgs)
    for (const p of m.parts ?? [])
      if (p?.type === "agent" || p?.type === "subtask" || (p?.type === "tool" && String(p.tool ?? "").toLowerCase() === "task"))
        order.push(p);
  const idx = order.indexOf(part);
  const byTime = (c: SubagentChild) => c.timeCreated ?? 0;
  const sorted = [...children].sort((a, b) => byTime(a) - byTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (idx >= 0 && idx < sorted.length) return { id: sorted[idx].id };
  return null;
}
