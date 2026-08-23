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
