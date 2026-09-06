import { formatBinding } from "./hotkeys";

// Append a live binding to a tooltip label: "Workspace" + Ctrl+O → "Workspace (Ctrl+O)".
// Unbound (null/undefined) → bare label so tooltips never show "(—)".
// Components must pass the binding from live settings (settings.hotkeys.x),
// never a hardcoded string, so the tip re-renders on rebind.
export function withHotkey(label: string, binding: string | null | undefined): string {
  if (!binding) return label;
  return `${label} (${formatBinding(binding)})`;
}

// Static display formatting for fixed (non-rebindable) keys: Ctrl+F, Esc, Enter…
// Mac-glyph only (⌘/⌥), no reactivity needed.
export function fmtKey(binding: string): string {
  return formatBinding(binding);
}
