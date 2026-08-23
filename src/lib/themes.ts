// theme engine: built-in palettes as data (transcribed from tokens.css),
// config parsing/validation, and runtime application via CSS custom
// properties on <html>. The user's ~/.config/.opencode-gui/themes.json is
// seeded with these defaults on first launch and is the source of truth after.

export type ThemeModeDef = {
  colorScheme?: "dark" | "light";
  // CSS custom property name (with leading --) → value; missing keys inherit
  // from the cyan-dark fallbacks below
  vars?: Record<string, string>;
};

export type ThemeDef = {
  name?: string;
  icon?: string;
  modes?: Partial<Record<"dark" | "light", ThemeModeDef>>;
};

export type ThemeMeta = { id: string; name: string; icon: string };
export type NormalizedTheme = {
  meta: ThemeMeta;
  modes: Record<"dark" | "light", { colorScheme: "dark" | "light"; vars: Record<string, string> }>;
  // which variations the config actually defines — single-variation themes
  // lock the UI to that one mode (toggle hidden)
  available: Record<"dark" | "light", boolean>;
};

// every key a palette may set — also the inheritance fallback set.
// ponytail: one flat fallback (cyan-dark) for ALL themes/modes; a per-theme
// fallback chain only matters if partial custom palettes become common.
const FALLBACK: Record<string, string> = {
  "--text": "#d7e0e6",
  "--text-dim": "#8fa1ac",
  "--text-faint": "#5b6c76",
  "--line": "rgba(255, 255, 255, 0.07)",
  "--line-strong": "rgba(255, 255, 255, 0.12)",
  "--surface": "rgba(21, 29, 36, 0.55)",
  "--surface-2": "rgba(28, 38, 47, 0.65)",
  "--accent": "#7fd4d4",
  "--accent-bright": "#a8e6e4",
  "--accent-dim": "color-mix(in srgb, var(--accent) 13%, transparent)",
  "--accent-glow": "color-mix(in srgb, var(--accent) 35%, transparent)",
  "--danger": "#e08f8f",
  "--chrome-rgb": "20, 28, 35",
  "--inset-bg": "rgba(9, 13, 17, 0.55)",
  "--drawer-bg":
    "linear-gradient(180deg, rgba(20, 28, 35, 0.92), rgba(12, 17, 22, 0.94))",
  "--base-rgb": "9, 12, 16",
  "--base-a": "0.6",
  "--surf-rgb": "23, 40, 48",
  "--surf-a": "0.33",
  "--syn-comment": "#55707c",
  "--syn-keyword": "#7fd4d4",
  "--syn-string": "#9fce8f",
  "--syn-number": "#d4b57f",
  "--syn-func": "#a8e6e4",
  "--syn-type": "#8fc7e0",
  "--syn-var": "#d7e0e6",
  "--syn-meta": "#74a0ab",
};

const BUILTIN_LIST: [string, ThemeDef][] = [
  [
    "cyan",
    {
      name: "Cyan",
      icon: "fa-droplet",
      modes: {
        dark: {
          colorScheme: "dark",
          // explicit copy of FALLBACK so the seeded config shows both
          // variations for every theme (rule: all themes define both)
          vars: {
            "--text": "#d7e0e6",
            "--text-dim": "#8fa1ac",
            "--text-faint": "#5b6c76",
            "--line": "rgba(255, 255, 255, 0.07)",
            "--line-strong": "rgba(255, 255, 255, 0.12)",
            "--surface": "rgba(21, 29, 36, 0.55)",
            "--surface-2": "rgba(28, 38, 47, 0.65)",
            "--accent": "#7fd4d4",
            "--accent-bright": "#a8e6e4",
            "--accent-dim": "color-mix(in srgb, var(--accent) 13%, transparent)",
            "--accent-glow": "color-mix(in srgb, var(--accent) 35%, transparent)",
            "--danger": "#e08f8f",
            "--chrome-rgb": "20, 28, 35",
            "--inset-bg": "rgba(9, 13, 17, 0.55)",
            "--drawer-bg":
              "linear-gradient(180deg, rgba(20, 28, 35, 0.92), rgba(12, 17, 22, 0.94))",
            "--base-rgb": "9, 12, 16",
            "--base-a": "0.6",
            "--surf-rgb": "23, 40, 48",
            "--surf-a": "0.33",
            "--syn-comment": "#55707c",
            "--syn-keyword": "#7fd4d4",
            "--syn-string": "#9fce8f",
            "--syn-number": "#d4b57f",
            "--syn-func": "#a8e6e4",
            "--syn-type": "#8fc7e0",
            "--syn-var": "#d7e0e6",
            "--syn-meta": "#74a0ab",
          },
        },
        light: {
          colorScheme: "light",
          vars: {
            "--text": "#20292f",
            "--text-dim": "#56666f",
            "--text-faint": "#8595a0",
            "--line": "rgba(15, 30, 40, 0.12)",
            "--line-strong": "rgba(15, 30, 40, 0.2)",
            "--surface": "rgba(255, 255, 255, 0.6)",
            "--surface-2": "rgba(255, 255, 255, 0.8)",
            "--accent": "#177e7e",
            "--accent-bright": "#10696b",
            "--accent-dim": "rgba(23, 126, 126, 0.12)",
            "--accent-glow": "rgba(23, 126, 126, 0.32)",
            "--danger": "#b85050",
            "--chrome-rgb": "255, 255, 255",
            "--inset-bg": "rgba(13, 25, 33, 0.07)",
            "--drawer-bg":
              "linear-gradient(180deg, rgba(250, 252, 254, 0.95), rgba(240, 245, 248, 0.97))",
            "--syn-comment": "#64767e",
            "--syn-keyword": "#107072",
            "--syn-string": "#35702c",
            "--syn-number": "#82591a",
            "--syn-func": "#10696b",
            "--syn-type": "#205d7a",
            "--syn-var": "#20292f",
            "--syn-meta": "#48666f",
          },
        },
      },
    },
  ],
  [
    "latte",
    {
      name: "Latte",
      icon: "fa-mug-hot",
      modes: {
        dark: {
          colorScheme: "dark",
          vars: {
            "--text": "#d9cbb4",
            "--text-dim": "#a89a83",
            "--text-faint": "#7d7161",
            "--line": "rgba(217, 203, 180, 0.1)",
            "--line-strong": "rgba(217, 203, 180, 0.18)",
            "--surface": "rgba(60, 50, 34, 0.5)",
            "--surface-2": "rgba(52, 43, 29, 0.72)",
            "--accent": "#c99a5f",
            "--accent-bright": "#e0b87e",
            "--accent-dim": "rgba(201, 154, 95, 0.14)",
            "--accent-glow": "rgba(201, 154, 95, 0.32)",
            "--danger": "#d97b62",
            "--chrome-rgb": "42, 35, 24",
            "--inset-bg": "rgba(8, 6, 3, 0.45)",
            "--drawer-bg":
              "linear-gradient(180deg, rgba(38, 31, 20, 0.94), rgba(28, 22, 14, 0.96))",
            "--syn-comment": "#857763",
            "--syn-keyword": "#c99a5f",
            "--syn-string": "#a9bd70",
            "--syn-number": "#d48068",
            "--syn-func": "#e0b87e",
            "--syn-type": "#93aed0",
            "--syn-var": "#d9cbb4",
            "--syn-meta": "#9a8054",
          },
        },
        light: {
          colorScheme: "light",
          vars: {
            "--text": "#54493c",
            "--text-dim": "#7d7161",
            "--text-faint": "#a39786",
            "--line": "rgba(92, 74, 52, 0.15)",
            "--line-strong": "rgba(92, 74, 52, 0.23)",
            "--surface": "rgba(255, 251, 243, 0.62)",
            "--surface-2": "rgba(255, 251, 243, 0.85)",
            "--accent": "#a37b45",
            "--accent-bright": "#8a6636",
            "--accent-dim": "rgba(163, 123, 69, 0.13)",
            "--accent-glow": "rgba(163, 123, 69, 0.32)",
            "--danger": "#bd5f4e",
            "--chrome-rgb": "250, 245, 237",
            "--inset-bg": "rgba(110, 88, 58, 0.08)",
            "--drawer-bg":
              "linear-gradient(180deg, rgba(252, 248, 240, 0.95), rgba(246, 240, 229, 0.97))",
            "--syn-comment": "#86755c",
            "--syn-keyword": "#8a6636",
            "--syn-string": "#55662a",
            "--syn-number": "#99452f",
            "--syn-func": "#8a6636",
            "--syn-type": "#4a607f",
            "--syn-var": "#54493c",
            "--syn-meta": "#6e5a38",
          },
        },
      },
    },
  ],
  [
    "matcha",
    {
      name: "Matcha",
      icon: "fa-leaf",
      modes: {
        dark: {
          colorScheme: "dark",
          vars: {
            "--text": "#c2d1b6",
            "--text-dim": "#8fa184",
            "--text-faint": "#65755a",
            "--line": "rgba(194, 209, 182, 0.1)",
            "--line-strong": "rgba(194, 209, 182, 0.18)",
            "--surface": "rgba(36, 48, 32, 0.5)",
            "--surface-2": "rgba(30, 41, 26, 0.72)",
            "--accent": "#7fb069",
            "--accent-bright": "#a3cc90",
            "--accent-dim": "rgba(127, 176, 105, 0.14)",
            "--accent-glow": "rgba(127, 176, 105, 0.32)",
            "--danger": "#d97b62",
            "--chrome-rgb": "26, 34, 22",
            "--inset-bg": "rgba(3, 6, 2, 0.45)",
            "--drawer-bg":
              "linear-gradient(180deg, rgba(26, 34, 22, 0.94), rgba(18, 24, 15, 0.96))",
            "--syn-comment": "#65755a",
            "--syn-keyword": "#7fb069",
            "--syn-string": "#d4b57f",
            "--syn-number": "#d4a06a",
            "--syn-func": "#a3cc90",
            "--syn-type": "#7fc4bd",
            "--syn-var": "#c2d1b6",
            "--syn-meta": "#6f9460",
          },
        },
        light: {
          colorScheme: "light",
          vars: {
            "--text": "#38442e",
            "--text-dim": "#65755a",
            "--text-faint": "#8d9c85",
            "--line": "rgba(56, 78, 44, 0.15)",
            "--line-strong": "rgba(56, 78, 44, 0.23)",
            "--surface": "rgba(248, 252, 244, 0.62)",
            "--surface-2": "rgba(248, 252, 244, 0.85)",
            "--accent": "#55873f",
            "--accent-bright": "#446e31",
            "--accent-dim": "rgba(85, 135, 63, 0.13)",
            "--accent-glow": "rgba(85, 135, 63, 0.3)",
            "--danger": "#bb5a50",
            "--chrome-rgb": "242, 248, 237",
            "--inset-bg": "rgba(48, 68, 38, 0.08)",
            "--drawer-bg":
              "linear-gradient(180deg, rgba(246, 250, 242, 0.95), rgba(238, 244, 232, 0.97))",
            "--syn-comment": "#6d7c63",
            "--syn-keyword": "#446e31",
            "--syn-string": "#82621c",
            "--syn-number": "#8f5326",
            "--syn-func": "#446e31",
            "--syn-type": "#23716b",
            "--syn-var": "#38442e",
            "--syn-meta": "#4c6b40",
          },
        },
      },
    },
  ],
  [
    "strawberry",
    {
      name: "Strawberry",
      icon: "fa-apple-whole",
      modes: {
        dark: {
          colorScheme: "dark",
          vars: {
            "--text": "#e3ccd4",
            "--text-dim": "#b39aa3",
            "--text-faint": "#856871",
            "--line": "rgba(227, 204, 212, 0.1)",
            "--line-strong": "rgba(227, 204, 212, 0.18)",
            "--surface": "rgba(52, 32, 39, 0.5)",
            "--surface-2": "rgba(44, 27, 33, 0.72)",
            "--accent": "#e07a92",
            "--accent-bright": "#efa3b4",
            "--accent-dim": "rgba(224, 122, 146, 0.14)",
            "--accent-glow": "rgba(224, 122, 146, 0.32)",
            "--danger": "#e08585",
            "--chrome-rgb": "36, 24, 28",
            "--inset-bg": "rgba(6, 2, 3, 0.45)",
            "--drawer-bg":
              "linear-gradient(180deg, rgba(38, 24, 29, 0.94), rgba(28, 17, 21, 0.96))",
            "--syn-comment": "#8a6a75",
            "--syn-keyword": "#e07a92",
            "--syn-string": "#a8bf82",
            "--syn-number": "#d4a76a",
            "--syn-func": "#efa3b4",
            "--syn-type": "#8fb8d8",
            "--syn-var": "#e3ccd4",
            "--syn-meta": "#a56d80",
          },
        },
        light: {
          colorScheme: "light",
          vars: {
            "--text": "#4f3a40",
            "--text-dim": "#7f626a",
            "--text-faint": "#a98e96",
            "--line": "rgba(105, 50, 64, 0.14)",
            "--line-strong": "rgba(105, 50, 64, 0.22)",
            "--surface": "rgba(255, 248, 250, 0.62)",
            "--surface-2": "rgba(255, 248, 250, 0.85)",
            "--accent": "#c14e67",
            "--accent-bright": "#a83b53",
            "--accent-dim": "rgba(193, 78, 103, 0.12)",
            "--accent-glow": "rgba(193, 78, 103, 0.3)",
            "--danger": "#bf4949",
            "--chrome-rgb": "252, 243, 246",
            "--inset-bg": "rgba(105, 45, 60, 0.07)",
            "--drawer-bg":
              "linear-gradient(180deg, rgba(253, 246, 248, 0.95), rgba(248, 237, 241, 0.97))",
            "--syn-comment": "#8f6672",
            "--syn-keyword": "#a83b53",
            "--syn-string": "#4f6a2a",
            "--syn-number": "#8a5c1d",
            "--syn-func": "#a83b53",
            "--syn-type": "#33608a",
            "--syn-var": "#4f3a40",
            "--syn-meta": "#7c4557",
          },
        },
      },
    },
  ],
];

export const BUILTIN_THEMES: Record<string, ThemeDef> = Object.fromEntries(BUILTIN_LIST);

// config schema version — bumped when defaults change shape; older files are
// re-seeded (the feature is new enough that no real user edits exist yet)
export const THEME_CONFIG_VERSION = 2;

// serialized form of the built-ins — used to seed the config file on first run
export function defaultThemesJson(): string {
  return JSON.stringify({ version: THEME_CONFIG_VERSION, themes: BUILTIN_THEMES }, null, 2);
}

export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function normalizeMode(
  raw: ThemeModeDef | undefined,
  scheme: "dark" | "light",
): NormalizedTheme["modes"]["dark"] {
  return {
    colorScheme: raw?.colorScheme ?? scheme,
    vars: { ...FALLBACK, ...(raw?.vars ?? {}) },
  };
}

// parse + validate a config file. returns null when nothing usable remains
// (caller keeps its previous set and shows an error)
export function parseThemesConfig(text: string): Record<string, NormalizedTheme> | null {
  let parsed: any;
  try {
    parsed = JSON.parse(stripComments(text));
  } catch {
    return null;
  }
  const raw = parsed?.themes;
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, NormalizedTheme> = {};
  for (const [id, def] of Object.entries(raw as Record<string, ThemeDef>)) {
    if (!def || typeof def !== "object") continue;
    // light may fall back to dark (custom single-palette themes), but dark
    // must NEVER fall back to light — it falls to the built-in defaults
    const darkSrc = def.modes?.dark;
    const lightSrc = def.modes?.light ?? def.modes?.dark;
    if (!darkSrc && !lightSrc) continue;
    out[id] = {
      meta: { id, name: def.name ?? id, icon: def.icon ?? "fa-palette" },
      modes: {
        dark: normalizeMode(darkSrc, "dark"),
        light: normalizeMode(lightSrc, "light"),
      },
      available: {
        dark: !!def.modes?.dark,
        light: !!def.modes?.light,
      },
    };
  }
  return Object.keys(out).length ? out : null;
}

// apply a theme×mode to <html>: dataset flags + every palette variable
export function applyTheme(id: string, def: NormalizedTheme, mode: "dark" | "light") {
  const el = document.documentElement;
  el.dataset.theme = id;
  el.dataset.mode = mode;
  const m = def.modes[mode];
  el.style.colorScheme = m.colorScheme;
  for (const [k, v] of Object.entries(m.vars)) el.style.setProperty(k, v);
}
