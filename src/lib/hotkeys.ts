// rebindable hotkeys — defaults are the historical bindings, system-wide
// combos stay fixed (handled by Rust global-shortcut plugin)

export type HotkeyId =
  | "toggleSidebar"
  | "openSettings"
  | "micToggle"
  | "openWorkspace"
  | "newWindow"
  | "pinOnTop"
  | "newSession"
  | "toggleTerm"
  | "cycleNext"
  | "cyclePrev"
  | "closeSession"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "cycleAgent";

export type HotkeysMap = Record<HotkeyId, string | null>;

export const DEFAULT_HOTKEYS: HotkeysMap = {
  toggleSidebar: "Ctrl+B",
  openSettings: "Ctrl+,",
  micToggle: "Ctrl+M",
  openWorkspace: "Ctrl+O",
  newWindow: "Ctrl+Shift+N",
  pinOnTop: "Ctrl+P",
  newSession: "Ctrl+N",
  toggleTerm: "Ctrl+`",
  cycleNext: "Ctrl+Tab",
  cyclePrev: "Ctrl+Shift+Tab",
  closeSession: "Ctrl+W",
  zoomIn: "Ctrl+=",
  zoomOut: "Ctrl+-",
  zoomReset: "Ctrl+0",
  cycleAgent: "Tab",
};

export const HOTKEY_META: Record<HotkeyId, { group: string; desc: string }> = {
  toggleSidebar: { group: "In the app", desc: "toggle sidebar" },
  openSettings: { group: "In the app", desc: "open settings" },
  micToggle: { group: "In the app", desc: "mic on/off" },
  openWorkspace: { group: "In the app", desc: "open workspace" },
  newWindow: { group: "In the app", desc: "open new window" },
  pinOnTop: { group: "In the app", desc: "pin window on top" },
  toggleTerm: { group: "In the app", desc: "toggle terminal" },
  newSession: { group: "In the app", desc: "new session" },
  cycleNext: { group: "In the app", desc: "next session" },
  cyclePrev: { group: "In the app", desc: "previous session" },
  closeSession: { group: "In the app", desc: "close session" },
  zoomIn: { group: "In the app", desc: "zoom in" },
  zoomOut: { group: "In the app", desc: "zoom out" },
  zoomReset: { group: "In the app", desc: "reset zoom" },
  cycleAgent: { group: "In the app", desc: "cycle agent" },
};

// order used in the Help dialog (mirrors the former KEYS list)
export const HOTKEY_ORDER: HotkeyId[] = [
  "toggleSidebar",
  "openSettings",
  "micToggle",
  "openWorkspace",
  "newWindow",
  "pinOnTop",
  "toggleTerm",
  "newSession",
  "cycleNext",
  "cyclePrev",
  "closeSession",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "cycleAgent",
];

// normalize for display/storage: Ctrl+Shift+N style, mods sorted Ctrl/Shift/Alt/Meta
function cap(s: string) {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

export function normalizeBinding(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (t === "—" || t.toLowerCase() === "unbound") return null;
  const parts = t.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods: string[] = [];
  let key: string | null = null;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "ctrl" || l === "control") mods.push("Ctrl");
    else if (l === "shift") mods.push("Shift");
    else if (l === "alt" || l === "option") mods.push("Alt");
    else if (l === "meta" || l === "cmd" || l === "command" || l === "win") mods.push("Meta");
    else {
      // last non-mod is the key
      key = p;
    }
  }
  if (!key) return null;
  // normalize key token
  let k = key;
  if (k.length === 1) {
    // letters upper, symbols keep
    if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
  } else if (k.toLowerCase() === "space") k = "Space";
  else if (k.toLowerCase() === "backquote" || k === "`" || k === "´" || k === "`") k = "`";
  else if (k.toLowerCase() === "tab") k = "Tab";
  else if (k.toLowerCase() === "escape" || k.toLowerCase() === "esc") k = "Escape";
  else if (k.toLowerCase() === "enter") k = "Enter";
  else {
    // keep as is but capitalize first for display consistency when word
    if (/^[a-z]+$/i.test(k) && k.length > 1) k = cap(k);
  }
  // dedup & sort mods: Ctrl Shift Alt Meta
  const order = ["Ctrl", "Shift", "Alt", "Meta"];
  const uniq = [...new Set(mods)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return uniq.length ? `${uniq.join("+")}+${k}` : k;
}

export function formatEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  const code = (e as any).code as string | undefined;
  // ignore pure modifier presses
  if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return null;
  // ignore if no meaningful key (e.g. Unidentified)
  if (!k) return null;

  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");

  let keyToken: string;
  if (code === "Backquote") {
    keyToken = "`";
  } else if (k === " ") {
    keyToken = "Space";
  } else if (k === "Tab") {
    keyToken = "Tab";
  } else if (k === "Escape") {
    keyToken = "Escape";
  } else if (k === "Enter") {
    keyToken = "Enter";
  } else if (code && /^Digit\d$/.test(code) && k.length === 1) {
    keyToken = k; // "0" .. "9"
  } else if (code && /^Key[A-Z]$/.test(code) && k.length === 1) {
    keyToken = k.toUpperCase();
  } else if (k.length === 1) {
    // letters already covered, but symbols like "=", "-", "/", "`"
    // normalize "+" (Shift+"=") to "=" display
    if (k === "+") keyToken = "=";
    else keyToken = k.length === 1 && /^[a-z]$/i.test(k) ? k.toUpperCase() : k;
  } else {
    // F-keys, arrows, etc.
    keyToken = k.length <= 2 ? k.toUpperCase() : cap(k);
    // ArrowUp → ArrowUp, keep
    if (/^Arrow/i.test(k)) keyToken = k;
    if (/^F\d+$/i.test(k)) keyToken = k.toUpperCase();
  }

  const raw = mods.length ? `${mods.join("+")}+${keyToken}` : keyToken;
  return normalizeBinding(raw);
}

// exact match except zoomIn/out alias handling
export function matchesEvent(e: KeyboardEvent, binding: string | null): boolean {
  if (!binding || e.repeat) return false;
  const norm = normalizeBinding(binding);
  if (!norm) return false;

  // zoom aliases: both "=" and "+" should trigger zoomIn
  if (norm === "Ctrl+=" || norm === "Ctrl++") {
    if (!(e.ctrlKey || (e as any).metaKey) || e.altKey) return false;
    return e.key === "=" || e.key === "+" || (e as any).code === "Equal" || (e as any).code === "NumpadAdd";
  }
  if (norm === "Ctrl+-" || norm === "Ctrl+_") {
    if (!(e.ctrlKey || (e as any).metaKey) || e.altKey) return false;
    return e.key === "-" || e.key === "_" || (e as any).code === "Minus" || (e as any).code === "NumpadSubtract";
  }
  if (norm === "Ctrl+0") {
    if (!(e.ctrlKey || (e as any).metaKey) || e.altKey) return false;
    return e.key === "0" || (e as any).code === "Digit0" || (e as any).code === "Numpad0";
  }

  const parts = norm.split("+");
  const keyToken = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const wantCtrl = mods.has("Ctrl");
  const wantShift = mods.has("Shift");
  const wantAlt = mods.has("Alt");
  const wantMeta = mods.has("Meta");

  const hasCtrl = !!(e.ctrlKey || (e as any).metaKey);
  // Ctrl in storage stands for Ctrl OR Meta, so either maps
  if (wantCtrl !== hasCtrl) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;
  // Meta separate token — rarely used, require exact
  if (wantMeta !== (e as any).metaKey) {
    if (wantMeta && !(e as any).metaKey) return false;
    if (!wantMeta && (e as any).metaKey && !wantCtrl) return false;
  }

  const code = (e as any).code as string;
  const ek = e.key;

  if (keyToken === "`") return code === "Backquote" || ek === "`" || ek === "´";
  if (keyToken === "Tab") return ek === "Tab";
  if (keyToken === "Space") return ek === " " || code === "Space";
  if (keyToken === "Escape") return ek === "Escape";
  if (keyToken === "Enter") return ek === "Enter";
  if (keyToken.length === 1 && /^[A-Z0-9]$/.test(keyToken)) {
    // letter/digit: allow key or code
    if (ek.length === 1 && ek.toUpperCase() === keyToken) return true;
    if (code === "Key" + keyToken) return true;
    if (code === "Digit" + keyToken) return true;
    if (code === "Numpad" + keyToken) return true;
    return false;
  }
  if (keyToken.length === 1) {
    // symbol single char
    if (keyToken === ",") return ek === "," || code === "Comma";
    return ek === keyToken || (keyToken === "=" && (ek === "+" || ek === "="));
  }
  // fallback case-insensitive
  return ek.toLowerCase() === keyToken.toLowerCase() || code === keyToken;
}

export function formatBinding(b: string | null): string {
  if (!b) return "—";
  return b;
}
