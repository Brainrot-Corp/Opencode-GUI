// runnable self-check: node --experimental-strip-types src/lib/platform.test.ts
import { normWorkspace, dedupeWorkspaces, dedupeWithEmpty, displayHotkey, isGarbageInput, cleanTypedText } from "./platform.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// node on Windows exposes navigator.platform "Win32" — pin the mode explicitly
// per block so the test behaves identically on every platform
const realNav = globalThis.navigator;
function nav(platform: string, userAgent = platform) {
  Object.defineProperty(globalThis, "navigator", { value: { platform, userAgent }, configurable: true });
}
const MAC = { platform: "MacIntel", userAgent: "Mac" };
const WIN = { platform: "Win32", userAgent: "Win" };

nav(MAC.platform, MAC.userAgent);
eq("mac: trim only", normWorkspace("  /home/u/Proj "), "/home/u/Proj");
eq("mac: empty stays empty", normWorkspace("   "), "");
eq("mac: ssh exact", normWorkspace("ssh://User@Host/Proj"), "ssh://User@Host/Proj");
eq("mac: case-sensitive dedupe", dedupeWorkspaces(["C:\\A", " c:\\a ", "C:\\B"]), ["C:\\A", "c:\\a", "C:\\B"]);

nav(WIN.platform, WIN.userAgent);
eq("windows lowers", normWorkspace("C:\\Proj"), "c:\\proj");
eq("windows ssh untouched", normWorkspace("ssh://User/Proj"), "ssh://User/Proj");
eq("dedupe case-insensitive on windows", dedupeWorkspaces(["C:\\A", " c:\\a ", "C:\\B"]), ["C:\\A", "C:\\B"]);
eq("dedupe empty once", dedupeWorkspaces(["", " ", "C:\\A"]), ["", "C:\\A"]);
eq("dedupe preserves order", dedupeWorkspaces(["b", "a", "b"]), ["b", "a"]);
eq("dedupeWithEmpty same contract", dedupeWithEmpty(["x", "x", "", "  ", "y"]), ["x", "", "y"]);
eq("displayHotkey windows passthrough", displayHotkey("Ctrl+O"), "Ctrl+O");

nav(MAC.platform, MAC.userAgent);
eq("dedupe empty once (mac)", dedupeWithEmpty(["x", "x", "", "  ", "y"]), ["x", "", "y"]);
eq("displayHotkey mac glyphs", displayHotkey("Ctrl+Alt+P"), "⌘+⌥+P");

nav(realNav.platform as string, realNav.userAgent);
eq("displayHotkey null", displayHotkey(null), "—");

eq("garbage input WK arrow", isGarbageInput("\uF700"), true);
eq("real text not garbage", isGarbageInput("hello"), false);
eq("null not garbage", isGarbageInput(null), false);
eq("cleanTypedText keeps \\t\\n\\r", cleanTypedText("a\tb\nc\r"), "a\tb\nc\r");
eq("cleanTypedText strips tofu + C0", cleanTypedText("a\uF700b\u0007c"), "abc");

console.log(`platform: ${n} checks passed`);
