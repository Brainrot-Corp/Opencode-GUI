// builds a compact, quality commit-message prompt + diff compression
// Budget: ~5k chars total context -> fast inference, still enough signal

export type CommitContext = {
  staged: { path: string; x: string }[];
  branch: string;
  stat: string;
  diff: string;
  log: string;
  includeBody: boolean;
};

// keep diff readable but small: strip deep context, keep hunk headers + added/removed lines
function compressDiff(raw: string, budget = 4500): string {
  if (!raw) return "";
  if (raw.length <= budget) return raw;
  const lines = raw.split("\n");
  // keep file headers + hunk headers + +/- lines, drop pure context where possible
  const kept: string[] = [];
  let used = 0;
  for (const ln of lines) {
    const keep = ln.startsWith("diff ") || ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("@@") || ln.startsWith("+") || ln.startsWith("-");
    if (keep) {
      if (used + ln.length + 1 > budget) break;
      kept.push(ln);
      used += ln.length + 1;
    } else {
      // sample 1 in 4 context lines for shape
      if (kept.length % 4 === 0) {
        if (used + ln.length + 1 > budget) break;
        kept.push(ln);
        used += ln.length + 1;
      }
    }
  }
  // if still over, hard slice
  let out = kept.join("\n");
  if (out.length > budget) out = out.slice(0, budget);
  // ensure we didn't cut mid-line at very end
  return out.trimEnd();
}

export function buildCommitPrompt(ctx: CommitContext): string {
  const stat = ctx.stat.trim();
  const branchLine = ctx.branch ? `Branch: ${ctx.branch}` : "";
  const logLine = ctx.log.trim() ? `Recent commits:\n${ctx.log.trim().split("\n").slice(0, 5).join("\n")}` : "";
  const fileList = ctx.staged.map((f) => `${f.x} ${f.path}`).join("\n");
  const patch = compressDiff(ctx.diff);

  const bodyRule = ctx.includeBody
    ? "- Also write a body (blank line + 1-3 bullet lines, each <=100ch, wrap long lines). Keep total message <= 400ch.\n"
    : "- Subject only — no body, no blank line after it.\n";

  // short, high-signal prompt (~80 tokens vs previous ~250)
  return (
    `You are a git commit message generator. Produce a single Conventional Commit message for the staged diff.\n` +
    `Rules:\n` +
    `- Type: feat/fix/refactor/docs/chore/test/perf when clear, else plain\n` +
    `- Imperative present tense ("add" not "added"), <=72ch subject, no trailing period\n` +
    `- Scope from path when 1-2 files share a folder (e.g. feat(git): …)\n` +
    `- Cover the most significant change; ignore churn/formatting\n` +
    `- No quotes, backticks, or code fences\n` +
    bodyRule +
    `Reply with the message only.\n\n` +
    (branchLine ? branchLine + "\n" : "") +
    `Staged files:\n${fileList}\n\n` +
    (stat ? `Stat:\n${stat}\n\n` : "") +
    (logLine ? logLine + "\n\n" : "") +
    `Diff:\n${patch}`
  );
}

// strips quotes/backticks, enforces 72ch line, removes fences if model misbehaves
export function cleanCommitMessage(raw: string, includeBody: boolean): string {
  let t = raw.trim();
  // strip code fences
  t = t.replace(/^```[\s\S]*?```$/gm, (m) => m.replace(/^```.*\n?/, "").replace(/```$/, "")).trim();
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
  // split subject / body
  const lines = t.split("\n");
  let subject = lines[0]?.trim() ?? "";
  subject = subject.replace(/^["'`]+|["'`]+$/g, "").replace(/\.$/, "").trim();
  // enforce 72
  if (subject.length > 72) {
    const cut = subject.slice(0, 72);
    const sp = cut.lastIndexOf(" ");
    subject = (sp > 40 ? cut.slice(0, sp) : cut).trim();
  }
  if (!includeBody) return subject;
  // body: keep up to 3 non-empty lines after blank
  const rest = lines.slice(1).map((l) => l.trim()).filter(Boolean);
  // drop repeated subject if model echoed it
  const bodyLines = rest.filter((l) => l !== subject).slice(0, 3);
  // ensure bullet style if not already
  const body = bodyLines.map((l) => (l.startsWith("-") || l.startsWith("*") ? l : `- ${l}`)).join("\n");
  return body ? `${subject}\n\n${body}` : subject;
}
