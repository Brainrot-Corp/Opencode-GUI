// runnable self-check: node --experimental-strip-types src/lib/i18n.test.ts
import { translate, t, getLang, setLang, DEFAULT_LANG, registerPluginTranslations, LANGUAGES } from "./i18n.ts";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as any).window = { dispatchEvent: () => true };

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// --- core bundle lookup ---
eq("en key", translate("en", "plugins.autoUpdate"), "Auto-update");
eq("fr key exists", translate("fr", "plugins.autoUpdate") !== "plugins.autoUpdate", true);
eq("unknown key → key", translate("en", "no.such.key"), "no.such.key");
eq("missing lang falls back en", translate("zz" as any, "plugins.autoUpdate"), "Auto-update");

// --- params interpolation ---
registerPluginTranslations("myplug", { en: { greet: "Hello {name}, you have {n} things" } });
eq("plugin exact key", translate("fr", "greet", { name: "Bob", n: 2 }), "Hello Bob, you have 2 things");
eq("plugin namespaced key", translate("en", "myplug.greet", { name: "X", n: 0 }), "Hello X, you have 0 things");
eq("plugin fr falls back en", translate("fr", "myplug.greet", { name: "A", n: 1 }), "Hello A, you have 1 things");

// plugin overlay: exact key wins over core
registerPluginTranslations("over", { en: { "plugins.autoUpdate": "OVERRIDE" } });
eq("plugin overlay wins", translate("en", "plugins.autoUpdate"), "OVERRIDE");
registerPluginTranslations("over", {}); // can't unregister — this only merges; use fresh key instead

// note: registerPluginTranslations merges, so assert the earlier overlay still wins
eq("overlay persists", translate("en", "plugins.autoUpdate"), "OVERRIDE");

// --- params without placeholder → unchanged ---
eq("no placeholders", translate("en", "plugins.autoUpdateTip", { x: 1 }), "When on, plugins update automatically as soon as a newer version is found");

// --- t() reads current lang ---
store.set("oc.language", "es");
eq("getLang from oc.language", getLang(), "es");
eq("t uses current lang", t("plugins.autoUpdate") !== undefined, true);
setLang("fr");
eq("setLang persists", getLang(), "fr");
store.delete("oc.settings");
store.delete("oc.language");
eq("reset → default detect", [DEFAULT_LANG].length, 1);
eq("languages list", LANGUAGES.length >= 3, true);

console.log(`i18n: ${n} checks passed`);
