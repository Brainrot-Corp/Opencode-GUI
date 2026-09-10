// Monaco helpers for FileEditor — local self-hosted bundle (offline-safe,
// no CDN). Theme + metrics mirror file-editor.css / tokens.css so the swap
// only changes the renderer, not the look.
import type * as Monaco from "monaco-editor";

import editorWorker from "monaco-editor/editor/editor.worker?worker";

export const MONACO_THEME = "opencode-gui";
export const MONO_STACK =
  '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace';

// singleton async loader — read-only viewers dynamic-import monaco so the
// chunk stays out of the initial bundle; every mount shares one import
let monacoPromise: Promise<typeof Monaco> | null = null;
export function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    setupMonacoWorkers();
    monacoPromise = import("monaco-editor");
  }
  return monacoPromise;
}

// boot-time grammar warmup: first use of a language evaluates its
// (bundled) definition and compiles the Monarch grammar — the slow part
// behind "colors pop in a second later". Runs idle at startup for the usual
// suspects so the first diff/file paints colored. Fire-and-forget.
// wait until a language's grammar is actually usable, so first paint is
// colored instead of popping in later. Standalone tokenize() falls back to
// null tokens while the lazy grammar loads, so poll it: non-empty token
// types mean the real grammar is live. Always resolves (timeout) —
// plaintext/unknown ids resolve immediately since they never gain tokens.
// Polling uses the task queue (setTimeout), never the idle queue, so it
// still progresses on a busy streaming thread where Monaco's own
// requestIdleCallback-scheduled background pass starves.
export function whenGrammarReady(
  m: typeof Monaco,
  langId: string,
  timeoutMs = 1500,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (!langId || langId === "plaintext") return resolve();
      const known = (m.languages?.getLanguages?.() || []).some((l: any) => l.id === langId);
      if (!known) return resolve();
    } catch {
      return resolve();
    }
    const t0 = Date.now();
    const probe = "const x = 1; // g";
    const tick = () => {
      let ready = false;
      try {
        const toks = m.editor.tokenize(probe, langId) as { type?: string }[][];
        ready = (toks || []).some((line) => (line || []).some((t) => !!t?.type));
      } catch {}
      if (ready || Date.now() - t0 > timeoutMs) resolve();
      else setTimeout(tick, 25);
    };
    tick();
  });
}

// boot-time grammar warmup: first tokenize of a language evaluates its
// (bundled) definition and compiles the Monarch grammar — the slow part
// behind "colors pop in a second later". Runs idle at startup for the usual
// suspects so the first diff/file paints colored. Fire-and-forget.
const WARM_LANGS = [
  "typescript", "javascript", "json", "python", "rust", "go",
  "shell", "markdown", "css", "html", "yaml", "powershell",
];
export function warmupMonaco(): void {
  void loadMonaco()
    .then(async (m) => {
      for (const id of WARM_LANGS) {
        try {
          await whenGrammarReady(m, id, 2500);
        } catch {}
      }
    })
    .catch(() => {});
}

let workersSetup = false;
export function setupMonacoWorkers() {
  if (workersSetup) return;
  workersSetup = true;
  // single editor worker for every language — the file editor is a plain
  // surface (no IntelliSense/validation; suggestions are off in baseOptions),
  // so the heavy ts/json/css/html service workers would only cost dist size
  (self as any).MonacoEnvironment = {
    getWorker() {
      return new editorWorker();
    },
  };
}

// extension → monaco language id (mirrors EXT_LANG in syntax.ts, mapped to
// monaco ids: shell instead of bash, html instead of xml, ini for toml-ish)
const EXT_MONACO: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyw: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", swift: "swift", cs: "csharp", dart: "dart",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", hh: "cpp",
  php: "php", lua: "lua", pl: "perl", r: "r",
  sh: "shell", bash: "shell", zsh: "shell",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  css: "css", scss: "scss", sass: "scss", less: "less",
  sql: "sql", md: "markdown", markdown: "markdown",
  dockerfile: "dockerfile",
};

export function monacoLang(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  if (/^dockerfile/i.test(base)) return "dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  return EXT_MONACO[base.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

// lowlight hl id (what DiffLines receives via extLang) → monaco id.
// Nearly 1:1 — only bash has no monaco counterpart (shell covers it).
export function hlToMonacoLang(hl?: string): string {
  if (!hl) return "plaintext";
  if (hl === "bash") return "shell";
  return hl;
}

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function hex6(css: string, fallback: string): string {
  const m = css.match(/#([0-9a-f]{6}|[0-9a-f]{3})/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return h.toUpperCase();
  }
  const f = fallback.replace("#", "");
  return f.toUpperCase();
}

// (re)define the gui theme from the live CSS vars so code follows the
// active theme × mode like syntax.css did for the old overlay
export function defineGuiTheme(monaco: typeof Monaco) {
  const comment = hex6(cssVar("--syn-comment", "#55707c"), "#55707c");
  const keyword = hex6(cssVar("--syn-keyword", "#7fd4d4"), "#7fd4d4");
  const str = hex6(cssVar("--syn-string", "#9fce8f"), "#9fce8f");
  const num = hex6(cssVar("--syn-number", "#d4b57f"), "#d4b57f");
  const fn = hex6(cssVar("--syn-func", "#a8e6e4"), "#a8e6e4");
  const type = hex6(cssVar("--syn-type", "#8fc7e0"), "#8fc7e0");
  const vr = hex6(cssVar("--syn-var", "#d7e0e6"), "#d7e0e6");
  const meta = hex6(cssVar("--syn-meta", "#74a0ab"), "#74a0ab");
  const fg = hex6(cssVar("--text-dim", "#8fa1ac"), "#8fa1ac");
  const accent = hex6(cssVar("--accent", "#7fd4d4"), "#7fd4d4");
  const faint = hex6(cssVar("--text-faint", "#5b6c76"), "#5b6c76");

  monaco.editor.defineTheme(MONACO_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: comment, fontStyle: "italic" },
      { token: "keyword", foreground: keyword },
      { token: "string", foreground: str },
      { token: "number", foreground: num },
      { token: "type", foreground: type },
      { token: "class", foreground: type },
      { token: "function", foreground: fn },
      { token: "method", foreground: fn },
      { token: "variable", foreground: vr },
      { token: "identifier", foreground: vr },
      { token: "tag", foreground: type },
      { token: "attribute", foreground: vr },
      { token: "meta", foreground: meta },
      { token: "annotation", foreground: meta },
    ],
    colors: {
      "editor.background": "#00000000",
      "editor.foreground": `#${fg}`,
      "editorCursor.foreground": `#${accent}`,
      "editor.selectionBackground": "#7fd4d440",
      "editor.inactiveSelectionBackground": "#7fd4d428",
      "editor.lineHighlightBackground": "#00000000",
      "focusBorder": "#00000000",
      "editorLineNumber.foreground": `#${faint}`,
      "editorLineNumber.activeForeground": `#${fg}`,
      // blocky accent scrollbars to match tokens.css ::-webkit-scrollbar
      // (18% idle / 34% hover / ~50% active — same mixes as the app chrome)
      "scrollbarSlider.background": `#${accent}2E`,
      "scrollbarSlider.hoverBackground": `#${accent}57`,
      "scrollbarSlider.activeBackground": `#${accent}80`,
      "scrollbar.shadow": "#00000000",
    },
  });
}

// construction options matching the old metrics: JetBrains Mono 11px/17px,
// 10px padding, tab 2, no gutter/minimap — plain surface like the textarea
export function baseOptions(monaco: typeof Monaco): Monaco.editor.IStandaloneEditorConstructionOptions {
  void monaco;
  return {
    theme: MONACO_THEME,
    fontFamily: MONO_STACK,
    fontSize: 11,
    lineHeight: 17,
    fontLigatures: false,
    tabSize: 2,
    insertSpaces: true,
    wordWrap: "off",
    minimap: { enabled: false },
    lineNumbers: "off",
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 10,
    lineNumbersMinChars: 0,
    padding: { top: 10, bottom: 10 },
    renderLineHighlight: "none",
    occurrencesHighlight: "off",
    selectionHighlight: false,
    matchBrackets: "always",
    links: false,
    contextmenu: false,
    copyWithSyntaxHighlighting: false,
    scrollBeyondLastLine: false,
    roundedSelection: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    stickyScroll: { enabled: false },
    guides: { bracketPairs: false, indentation: false },
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: "off",
    parameterHints: { enabled: false },
    fixedOverflowWidgets: true,
    smoothScrolling: true,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
  };
}

// paint cheap lines synchronously — Monaco colors the model on
// requestIdleCallback, which starves on a busy (streaming) main thread and
// delays visible colors ~1s. There is no public force API; this uses the
// same internal hook Monaco's own completions/comments use (ascending lines
// advance the frontier; >2048-char lines stay background). Guarded to no-op
// when absent (e.g. future monaco versions), so behavior only ever degrades
// to today's background timing.
export function forceCheapTokens(model: any, maxLines = 1000): void {
  try {
    const tz = model?.tokenization;
    if (!tz || typeof tz.tokenizeIfCheap !== "function") return;
    const count = Math.min(Number(model.getLineCount?.() ?? 0), maxLines);
    for (let ln = 1; ln <= count; ln++) tz.tokenizeIfCheap(ln);
  } catch {}
}

// monospace advance at a given px size (canvas-measured, cached per size) —
// drives code-block width expansion
const charWCache = new Map<number, number>();
export function measureCharWidth(fontPx: number): number {
  const hit = charWCache.get(fontPx);
  if (hit) return hit;
  let w = Math.ceil(fontPx * 0.6);
  try {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${fontPx}px ${MONO_STACK}`;
    w = Math.ceil(ctx.measureText("MMMMMMMMMM").width / 10);
  } catch {}
  charWCache.set(fontPx, w);
  return w;
}

// "Ctrl+Shift+K" → monaco keybinding. Returns null when unparseable.
export function bindingToKeybinding(monaco: typeof Monaco, binding: string | null | undefined): number | null {
  if (!binding) return null;
  const parts = binding.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const keyToken = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  let kb = 0;
  if (mods.has("ctrl") || mods.has("control")) kb |= monaco.KeyMod.CtrlCmd;
  if (mods.has("shift")) kb |= monaco.KeyMod.Shift;
  if (mods.has("alt") || mods.has("option")) kb |= monaco.KeyMod.Alt;
  if (mods.has("meta") || mods.has("cmd") || mods.has("command") || mods.has("win")) kb |= monaco.KeyMod.WinCtrl;

  const K = monaco.KeyCode;
  const up = keyToken.toUpperCase();
  let code: number | null = null;
  if (/^[A-Z]$/.test(up)) code = (K as any)[`Key${up}`] ?? null;
  else if (/^[0-9]$/.test(up)) code = (K as any)[`Digit${up}`] ?? null;
  else {
    const map: Record<string, number> = {
      ENTER: K.Enter, TAB: K.Tab, SPACE: K.Space, ESCAPE: K.Escape, ESC: K.Escape,
      ARROWUP: K.UpArrow, ARROWDOWN: K.DownArrow, ARROWLEFT: K.LeftArrow, ARROWRIGHT: K.RightArrow,
      UP: K.UpArrow, DOWN: K.DownArrow, LEFT: K.LeftArrow, RIGHT: K.RightArrow,
      "/": K.Slash, ",": K.Comma, ".": K.Period, ";": K.Semicolon, "'": K.Quote,
      "[": K.BracketLeft, "]": K.BracketRight, "-": K.Minus, "=": K.Equal,
      "`": K.Backquote, "\\": K.Backslash,
    };
    if (/^F\d{1,2}$/.test(up)) code = (K as any)[up] ?? null;
    else code = map[up] ?? map[keyToken] ?? null;
  }
  if (code == null) return null;
  return kb | code;
}
