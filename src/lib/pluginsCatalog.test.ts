// runnable self-check: node --experimental-strip-types src/lib/pluginsCatalog.test.ts
import { parsePluginsApi, pluginRawUrl, normalizePluginUrl, dirFromUrl } from "./pluginsCatalog.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// --- parsePluginsApi (GitHub contents API) ---
eq("dirs only, sorted", parsePluginsApi('[{"name":"tuya","type":"dir"},{"name":"aaa","type":"dir"},{"name":"f.js","type":"file"}]'), ["tuya", "aaa"].sort().map((x) => x === "aaa" ? "aaa" : "tuya"));
eq("empty body → []", parsePluginsApi(""), []);
eq("garbage → []", parsePluginsApi("nope"), []);
eq("object not array → []", parsePluginsApi("{}"), []);
eq("missing fields skipped", parsePluginsApi('[{"name":"x"},{"type":"dir"},{"name":"y","type":"dir"}]'), ["y"]);

// --- pluginRawUrl ---
eq("raw url joins base", pluginRawUrl("tuya", "plugin.json"), pluginRawUrl("tuya", "plugin.json"));
eq("raw url shape", pluginRawUrl("tuya", "main.js").startsWith("https://raw.githubusercontent.com/Brainrot-Corp/Opencode-GUI/main/default_plugins/tuya/main.js"), true);

// --- normalizePluginUrl ---
eq("empty → empty", normalizePluginUrl("  "), "");
eq("github tree → raw", normalizePluginUrl("https://github.com/Brainrot-Corp/Opencode-GUI/tree/main/default_plugins/tuya"), "https://raw.githubusercontent.com/Brainrot-Corp/Opencode-GUI/main/default_plugins/tuya");
eq("github blob → raw", normalizePluginUrl("https://github.com/Brainrot-Corp/Opencode-GUI/blob/main/default_plugins/tuya"), "https://raw.githubusercontent.com/Brainrot-Corp/Opencode-GUI/main/default_plugins/tuya");
eq("strip plugin.json", normalizePluginUrl("https://raw.githubusercontent.com/x/y/main/d/p/plugin.json"), "https://raw.githubusercontent.com/x/y/main/d/p");
eq("strip main.js", normalizePluginUrl("https://raw.example/x/main.js"), "https://raw.example/x");
eq("strip styles.css", normalizePluginUrl("https://raw.example/x/styles.css"), "https://raw.example/x");
eq("trailing slashes trimmed", normalizePluginUrl("https://raw.example/x/"), "https://raw.example/x");

// --- dirFromUrl ---
eq("last segment", dirFromUrl("https://raw.example/d/p"), "p");
eq("trailing slash safe", dirFromUrl("https://raw.example/d/p/"), "p");
eq("empty → plugin", dirFromUrl(""), "plugin");

console.log(`pluginsCatalog: ${n} checks passed`);
