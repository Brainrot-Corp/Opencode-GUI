import { createLowlight, common } from "lowlight";
import { toHtml } from "hast-util-to-html";

const ll = createLowlight(common);

// file extension → registered highlight.js language id
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", swift: "swift", cs: "csharp", dart: "dart",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", hh: "cpp",
  php: "php", lua: "lua", pl: "perl", r: "r",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell", psd1: "powershell",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  sql: "sql", md: "markdown",
};

export function extLang(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  const lang = EXT_LANG[name.slice(dot + 1).toLowerCase()];
  return lang && ll.registered(lang) ? lang : undefined;
}

export function escPlain(code: string): string {
  return code.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// ponytail: whole-string highlighting, no incremental parser — inputs above
// these caps skip highlighting rather than jank the UI; streaming/worker
// splitting only if real files ever hit this in practice
const MAX_AUTO = 20_000;
const MAX_KNOWN = 150_000;

// highlight to an HTML string of .hljs-* spans. Known language when given,
// auto-detect otherwise; oversized or failing input returns escaped text.
export function hlHtml(code: string, lang?: string): string {
  if (!code) return "";
  if (lang ? code.length > MAX_KNOWN : code.length > MAX_AUTO) return escPlain(code);
  try {
    return lang ? toHtml(ll.highlight(lang, code)) : toHtml(ll.highlightAuto(code));
  } catch {
    return escPlain(code);
  }
}

// ---- composer paste auto-fencing ----

// single-line pastes are only fenced for obvious shell commands
const SHELL_CMD =
  /^(?:\s|\$\s?|PS>\s?)*(?:git|gh|npm|npx|pnpm|yarn|bun|node|deno|python3?|py|pip3?|cargo|go|rustc|docker|podman|kubectl|helm|make|cmake|curl|wget|ssh|scp|sudo|brew|apt(?:-get)?|choco|winget|scoop|ls|dir|cd|cp|mv|rm|rmdir|mkdir|touch|cat|echo|grep|rg|find|findstr|sed|awk|chmod|chown|tar|zip|unzip|code|tsc|eslint|prettier|vitest|pytest|dotnet|java|javac)\b/;

// ponytail: heuristic has a known ceiling — odd pastes (prose with semicolon
// line endings etc.) get fenced; tighten signals here if that ever annoys
export function looksLikeCode(text: string): boolean {
  const t = text.trim();
  // empty / single token / already-fenced → leave alone
  if (!t || t.includes("```") || !/\s/.test(t)) return false;
  const lines = t.split("\n");
  if (lines.length === 1) {
    // sentence-shaped text ("git is confusing.") stays plain
    return !/[?!.]\s*$/.test(t) && SHELL_CMD.test(t);
  }
  return (
    /^#!/.test(t) ||
    /\{[\s\S]*\}/.test(t) ||
    /=>|<\//.test(t) ||
    /;\s*$/m.test(t) ||
    lines.some((l) => /^(?: {2,}|\t)\S/.test(l))
  );
}

// fence tag for a pasted block — shell lines by shape, everything else via
// lowlight auto-detect on the head of the payload
export function detectLang(code: string): string {
  const t = code.trim();
  if (!t.includes("\n")) return /^PS>/i.test(t) ? "powershell" : "bash";
  try {
    const res = ll.highlightAuto(t.slice(0, 4000));
    return (res.data as { language?: string } | undefined)?.language ?? "";
  } catch {
    return "";
  }
}

// splice a fenced block into the draft at the selection, padded with blank
// lines so it reads as its own paragraph; caret lands after the closing fence
export function insertFenced(
  input: string,
  start: number,
  end: number,
  pasted: string,
  lang: string,
): { text: string; caret: number } {
  const before = input.slice(0, start);
  const after = input.slice(end);
  const padBefore =
    before === "" ? "" : /\n\n$/.test(before) ? "" : /\n$/.test(before) ? "\n" : "\n\n";
  const padAfter = after === "" || /^\n/.test(after) ? "" : "\n";
  const inserted = `${padBefore}\`\`\`${lang}\n${pasted.trimEnd()}\n\`\`\`\n`;
  return {
    text: before + inserted + padAfter + after,
    caret: before.length + inserted.length,
  };
}
