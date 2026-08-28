// runnable self-check: node --experimental-strip-types src/lib/hotkeys.test.ts
import { matchesEvent } from "./hotkeys.ts";

function ev(key: string, code: string, ctrl = true, shift = false): any {
  return { key, code, ctrlKey: ctrl, shiftKey: shift, altKey: false, metaKey: false, repeat: false };
}

let n = 0;
function check(name: string, got: boolean, want: boolean) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${got}, want ${want}`);
}

// AZERTY: the key that TYPES "z" has code KeyW; the key that TYPES "w" has code KeyZ.
// The binding is keyed by typed char, so code (physical position) must not cross-match.
check("azerty Ctrl+W must NOT trigger Ctrl+Z", matchesEvent(ev("w", "KeyZ"), "Ctrl+Z"), false);
check("azerty Ctrl+Z must NOT trigger Ctrl+W", matchesEvent(ev("z", "KeyW"), "Ctrl+W"), false);
check("azerty Ctrl+Z triggers Ctrl+Z", matchesEvent(ev("z", "KeyW"), "Ctrl+Z"), true);
check("qwerty Ctrl+W must NOT trigger Ctrl+Z", matchesEvent(ev("w", "KeyW"), "Ctrl+Z"), false);
check("qwerty Ctrl+Z triggers Ctrl+Z", matchesEvent(ev("z", "KeyZ"), "Ctrl+Z"), true);
check("plain Ctrl+B triggers Ctrl+B", matchesEvent(ev("b", "KeyB"), "Ctrl+B"), true);
check("Ctrl+Shift+W must NOT trigger Ctrl+W", matchesEvent(ev("W", "KeyW", true, true), "Ctrl+W"), false);
// AZERTY: comma lives at the physical KeyM position — must NOT trigger Ctrl+M
check("azerty Ctrl+, must NOT trigger Ctrl+M", matchesEvent(ev(",", "KeyM"), "Ctrl+M"), false);
check("azerty Ctrl+M (m at Semicolon) triggers Ctrl+M", matchesEvent(ev("m", "Semicolon"), "Ctrl+M"), true);
check("azerty Ctrl+, triggers Ctrl+,", matchesEvent(ev(",", "KeyM"), "Ctrl+,"), true);
// physical-code fallback preserved for non-Latin e.key (Cyrillic IME)
check("Cyrillic key at KeyZ still triggers Ctrl+Z", matchesEvent(ev("\u044f", "KeyZ"), "Ctrl+Z"), true);
// zoom aliases untouched
check("Ctrl+= triggers Ctrl+=", matchesEvent(ev("=", "Equal"), "Ctrl+="), true);

console.log(`hotkeys: ${n} checks passed`);
