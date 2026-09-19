// runnable self-check: node --experimental-strip-types src/lib/themes.test.ts
import { stripComments, parseThemesConfig, defaultThemesJson, THEME_CONFIG_VERSION } from "./themes.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// --- stripComments ---
eq("keeps strings intact", stripComments('{"a": "// not a comment"}'), '{"a": "// not a comment"}');
eq("line comment removed", stripComments('{\n  // hi\n  "a": 1\n}'), '{\n  \n  "a": 1\n}');
eq("block comment removed", stripComments('{ /* hi */ "a": 1 }'), '{  "a": 1 }');
eq("escaped quote inside string", stripComments('{"a": "x \\" // y"}'), '{"a": "x \\" // y"}');
eq("urls with slashes survive", stripComments('{"u": "https://x//y"}'), '{"u": "https://x//y"}');

// --- parseThemesConfig ---
const mk = (over: string) => `{
  "version": 2,
  "themes": { ${over} }
}`;

const t1 = parseThemesConfig(mk(`"mid": { "modes": { "dark": { "vars": { "--accent": "#00ff00" } } } }`));
eq("theme parsed", t1 !== null && "mid" in t1, true);
eq("custom var kept", (t1 as any)?.mid?.modes?.dark?.vars?.["--accent"], "#00ff00");
eq("missing vars inherit fallback", Object.keys((t1 as any)?.mid?.modes?.dark?.vars ?? {}).length > 1, true);
eq("light falls back to dark", (t1 as any)?.mid?.modes?.light?.vars?.["--accent"], "#00ff00");
eq("light availability flag", (t1 as any)?.mid?.available?.light, false);

// invalid configs → null
eq("garbage → null", parseThemesConfig("nope"), null);
eq("no themes → null", parseThemesConfig('{"version":2}'), null);
eq("themes not object → null", parseThemesConfig('{"themes":[]}'), null);
eq("theme without modes skipped", parseThemesConfig(mk('"empty": { "name": "x" }')), null);
eq("all invalid → null", parseThemesConfig(mk('"a": 1, "b": 2')), null);

// --- defaultThemesJson round-trips through the parser ---
const dj = defaultThemesJson();
const builtins = parseThemesConfig(dj);
eq("defaults parse", builtins !== null, true);
eq("defaults carry builtins", Object.keys(builtins as any).length > 0, true);
eq("config version", THEME_CONFIG_VERSION, 2);

console.log(`themes: ${n} checks passed`);
