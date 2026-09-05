// central platform helpers — single source for isMac / workspace normalization
// ponytail: tiny helpers, no deps, used by 4 files to avoid case-sensitivity drift

export function isMac(): boolean {
  try {
    return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || (navigator as any).userAgent || "");
  } catch { return false; }
}
export function isWindows(): boolean {
  try {
    return typeof navigator !== "undefined" && /Win/i.test(navigator.platform || "");
  } catch { return false; }
}

/** Normalize a workspace dir for dedup/keying.
 * Windows is case-insensitive → lower; mac/linux case-sensitive → exact (trimmed).
 * Empty string (server cwd) stays "".
 */
export function normWorkspace(dir: string): string {
  const t = (dir ?? "").trim();
  if (!t) return "";
  return isWindows() ? t.toLowerCase() : t;
}

/** Deduplicate workspace list preserving order, using normWorkspace. */
export function dedupeWorkspaces(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of list) {
    const t = (d ?? "").trim();
    if (t === "") {
      if (seen.has("__empty__")) continue;
      seen.add("__empty__");
      out.push("");
      continue;
    }
    const key = normWorkspace(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Same but dedupe with empty allowed — used by getAllWorkspaces */
export function dedupeWithEmpty(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let seenEmpty = false;
  for (const d of list) {
    const t = (d ?? "").trim();
    if (t === "") {
      if (seenEmpty) continue;
      seenEmpty = true;
      seen.add("__EMPTY__");
      out.push("");
      continue;
    }
    const key = isWindows() ? t.toLowerCase() : t;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function displayHotkey(binding: string | null): string {
  if (!binding) return "—";
  if (isMac()) return binding.replace(/Ctrl/g, "⌘").replace(/Alt/g, "⌥").replace(/Meta/g, "⌘");
  return binding;
}

// WKWebView with tauri's `unstable` feature (needed for embedded-browser
// child webviews, tauri#10194) leaks macOS function-key private-use chars
// (U+F700-F703 arrows, U+F728 forward-delete, …) and stray C0 controls into
// text fields when the native caret-move selector falls through — i.e. at
// the end of the text. They have no glyph in Inter/JetBrains Mono and render
// as tofu squares. Never legitimate user input — matched wherever users type.
const WK_GARBAGE_INPUT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uF700-\uF74F]/;

/** True when an beforeinput/input chunk carries only WebView keyboard garbage. */
export function isGarbageInput(data: string | null | undefined): boolean {
  return !!data && WK_GARBAGE_INPUT_RE.test(data);
}

/** Strip WebView keyboard garbage from a typed string (falls back for
 * surfaces that can't intercept beforeinput). Keeps \t (\u0009), \n, \r. */
export function cleanTypedText(s: string): string {
  return s.replace(new RegExp(WK_GARBAGE_INPUT_RE.source, "g"), "");
}
