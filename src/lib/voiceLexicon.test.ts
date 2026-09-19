// runnable self-check: node --experimental-strip-types src/lib/voiceLexicon.test.ts
import { expandVoice, fixTypos, setPluginLexicon } from "./voiceLexicon.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  if (got !== want) throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// --- expandVoice: french → canonical english, accents stripped ---
eq("stop", expandVoice("arrête"), "stop");
eq("stop with object", expandVoice("arrête la génération"), "stop");
eq("english passthrough", expandVoice("stop that"), "stop that");
eq("send", expandVoice("envoie ça"), "send");
eq("send with payload", expandVoice("envoie bonjour"), "send bonjour");
eq("dictate", expandVoice("dicte moi un haiku"), "prompt un haiku");
eq("new session", expandVoice("nouvelle session"), "new session");
eq("open settings", expandVoice("ouvre les paramètres"), "open the settings");
eq("polite wrapper stripped", expandVoice("can you stop please"), "stop");
eq("plain text untouched", expandVoice("write me a poem"), "write me a poem");
eq("whitespace collapsed", expandVoice("  a   b  "), "a b");

// --- plugin lexicon replaces wholesale ---
setPluginLexicon([[/\ballume(?:r)?(?:\s+la)?\s+lumiere$/, "lights on"]]);
eq("plugin rule applies", expandVoice("allume la lumière"), "lights on");
setPluginLexicon([]);
eq("plugin rule cleared (deaccented passthrough)", expandVoice("allume la lumière"), "allume la lumiere");

// --- fixTypos ---
eq("exact vocab untouched", fixTypos("dark"), "dark");
eq("one substitution", fixTypos("darkk"), "dark");
eq("transposition", fixTypos("lihgt"), "light");
eq("4+ chars only for spelling", fixTypos("dg"), "dg");
eq("extra vocab", fixTypos("teme", ["theme"]), "theme");
eq("real word untouched by phonetics", fixTypos("git"), "git");
eq("punctuation preserved", fixTypos("dark,"), "dark,");
eq("non-word chars untouched", fixTypos("42"), "42");
eq("metaphone repair", fixTypos("purpul", ["purple"]), "purple");
eq("multi word", fixTypos("dakr theme"), "dark theme");

console.log(`voiceLexicon: ${n} checks passed`);
