// local heuristic commit message — instant, no API, ~50ms
// Used as immediate fill while the AI model streams a better one,
// and as fallback when no secondary model is configured or the AI times out.

type HeuristicInput = {
  staged: { path: string; x: string; y: string }[];
  stat?: string; // `git diff --cached --stat` raw
  diff?: string; // first ~4k of patch
  branch?: string;
};

function scopeFromPath(p: string): string {
  // pick meaningful scope: parent dir or file basename sans ext
  const parts = p.split("/");
  if (parts.length === 1) return parts[0].replace(/\.[^.]+$/, "");
  // prefer leaf folder for src/components/Foo.tsx -> Foo
  // for src/lib/foo.ts -> lib, but file name is more specific
  const file = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  const dir = parts[parts.length - 2];
  // common dirs that are weak scopes
  const weak = new Set(["src", "lib", "components", "pages", "hooks", "styles", "utils", "helpers"]);
  if (weak.has(dir) && file) return file;
  if (dir) return dir;
  return file;
}

function typeFromContext(inp: HeuristicInput): string {
  const branch = (inp.branch ?? "").toLowerCase();
  if (/^fix\//.test(branch) || /hotfix/.test(branch)) return "fix";
  if (/^feat\//.test(branch) || /^feature\//.test(branch)) return "feat";
  const paths = inp.staged.map((f) => f.path.toLowerCase());
  const diffLow = (inp.diff ?? "").toLowerCase();

  // file-path signals
  const isDocs = paths.every((p) => p.startsWith("docs/") || p.endsWith(".md") || p.startsWith("readme"));
  if (isDocs) return "docs";
  const isTest = paths.some((p) => p.includes(".test.") || p.includes("__tests__") || p.startsWith("test/") || p.startsWith("tests/"));
  if (isTest) return "test";
  if (paths.some((p) => p.startsWith("scripts/") || p === "package.json" || p === "package-lock.json" || p.startsWith(".github/"))) return "chore";
  if (paths.some((p) => p.includes("style") || p.endsWith(".css"))) {
    // style-only changes
    if (paths.every((p) => p.endsWith(".css") || p.endsWith(".scss"))) return "style";
  }

  // status signals
  const hasAdd = inp.staged.some((f) => f.x === "A" || f.x === "?");
  const hasDel = inp.staged.some((f) => f.x === "D");
  const hasMod = inp.staged.some((f) => f.x === "M" || f.x === "R" || f.x === "C");
  const hasRename = inp.staged.some((f) => f.x === "R");

  if (hasRename) return "refactor";
  // diff content hints — conservative
  if (diffLow.includes("fix") || diffLow.includes("bug") || diffLow.includes("error") || diffLow.includes("issue #")) {
    if (hasMod && !hasAdd) return "fix";
  }
  if (diffLow.includes("perf") && hasMod) return "perf";
  if (hasAdd && !hasDel) return "feat";
  if (hasDel && !hasAdd) return "refactor";
  if (hasMod) return "refactor";
  return "chore";
}

function summaryFromDiff(inp: HeuristicInput): string {
  // try to extract a human phrase from the diff/stat
  const stat = inp.stat ?? "";
  const diff = inp.diff ?? "";
  // 1) if single file, use its name
  if (inp.staged.length === 1) {
    const p = inp.staged[0].path;
    const base = p.split("/").pop() ?? p;
    const action = inp.staged[0].x === "A" ? "add" : inp.staged[0].x === "D" ? "remove" : inp.staged[0].x === "R" ? "rename" : "update";
    return `${action} ${base}`;
  }
  // 2) common prefix folder
  const dirs = inp.staged.map((f) => f.path.split("/")[0]);
  const uniq = [...new Set(dirs)];
  if (uniq.length === 1 && uniq[0]) {
    const action = inp.staged.some((f) => f.x === "A") ? "add" : "update";
    return `${action} ${uniq[0]} components`;
  }
  // 3) parse stat for "X files changed, Y insertions"
  const m = stat.match(/(\d+)\s+files? changed/);
  if (m) {
    const n = Number(m[1]);
    if (n > 1) {
      // look for dominant dir
      const top = uniq.sort((a, b) => dirs.filter((d) => d === b).length - dirs.filter((d) => d === a).length)[0];
      if (top) return `update ${top} (${n} files)`;
    }
  }
  // 4) hunk header hints — "@@ ... @@" line may contain function name
  const func = diff.match(/@@[^@]*@@\s*(.+)/);
  if (func && func[1].trim().length > 3 && func[1].trim().length < 40) {
    const name = func[1].trim().replace(/[^a-zA-Z0-9_.-]/g, " ").replace(/\s+/g, " ").trim();
    if (name) return `update ${name}`;
  }
  // fallback
  const n = inp.staged.length;
  return n <= 3 ? inp.staged.map((f) => f.path.split("/").pop() ?? f.path).join(", ") : `${n} files`;
}

function sanitizeSubject(s: string): string {
  let t = s.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/\.$/, "");
  if (t.length > 72) {
    // cut at word boundary
    const cut = t.slice(0, 72);
    const lastSpace = cut.lastIndexOf(" ");
    t = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return t;
}

export function heuristicCommit(inp: HeuristicInput): string {
  const type = typeFromContext(inp);
  const scopeRaw = scopeFromPath(inp.staged[0]?.path ?? "");
  const needsScope = inp.staged.length <= 3 && scopeRaw.length >= 2 && scopeRaw.length <= 18 && /^[a-z0-9-]+$/i.test(scopeRaw);
  const sum = summaryFromDiff(inp);
  // sum may already start with verb — normalize to imperative
  let verb = sum;
  // force lower-case start for conventional
  verb = verb.charAt(0).toLowerCase() + verb.slice(1);
  // ensure imperative: "added" -> "add", "updated" -> "update"
  verb = verb.replace(/^added\b/, "add").replace(/^updated\b/, "update").replace(/^removed\b/, "remove").replace(/^renamed\b/, "rename");
  const subject = needsScope ? `${type}(${scopeRaw.toLowerCase()}): ${verb}` : `${type}: ${verb}`;
  return sanitizeSubject(subject);
}

// expose for testing
export const _test = { scopeFromPath, typeFromContext, summaryFromDiff, sanitizeSubject };
