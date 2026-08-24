import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { setSoundPrefs, type SoundPrefs } from "../lib/sounds";
import {
  applyTheme,
  defaultThemesJson,
  parseThemesConfig,
  stripComments,
  THEME_CONFIG_VERSION,
  type NormalizedTheme,
  type ThemeMeta,
} from "../lib/themes";

export type ThemeName = string;
export type Mode = "dark" | "light";
export type ColorSet = { base: string; baseA: number; surface: string; surfaceA: number };
export type AppColors = Record<string, Record<Mode, ColorSet>>;

const DEFAULT_COLOR_SETS: AppColors = {
  cyan: {
    dark: { base: "#090c10", baseA: 0.6, surface: "#172830", surfaceA: 0.33 },
    light: { base: "#eef2f5", baseA: 0.55, surface: "#ffffff", surfaceA: 0.5 },
  },
  latte: {
    dark: { base: "#141009", baseA: 0.62, surface: "#262016", surfaceA: 0.42 },
    light: { base: "#f6efe4", baseA: 0.55, surface: "#fffdf8", surfaceA: 0.5 },
  },
  matcha: {
    dark: { base: "#0c110b", baseA: 0.62, surface: "#262116", surfaceA: 0.42 },
    light: { base: "#eef4e7", baseA: 0.55, surface: "#fbfef7", surfaceA: 0.5 },
  },
  strawberry: {
    dark: { base: "#140b0e", baseA: 0.62, surface: "#2c141a", surfaceA: 0.42 },
    light: { base: "#fbeef2", baseA: 0.55, surface: "#fff8fa", surfaceA: 0.5 },
  },
};

export type AppSettings = {
  theme: ThemeName;
  mode: Mode;
  alwaysOnTop: boolean;
  uiScale: number;
  sounds: SoundPrefs;
  colors: AppColors;
  workspace: string;
  // global collapse-by-default for thinking + tool-call blocks (/collapse)
  collapsed: boolean;
  voice: {
    model: string;
    autoSend: boolean;
    handsFree: boolean;
    pauseMs: number;
    sens: number;
  };
  speakReplies: boolean;
  // piper voice file ("<id>.onnx") for spoken replies — "" = none yet
  ttsVoice: string;
  ttsVol: number;
  // speech rate multiplier (0.5 = half speed … 2 = double)
  ttsSpeed: number;
  // provider/model used for AI commit messages ("provider/model", "" = off)
  gitModel: string;
};

const KEY = "oc.settings";
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULTS: AppSettings = {
  theme: "cyan",
  mode: "dark",
  alwaysOnTop: false,
  uiScale: 1,
  sounds: {
    show: true,
    hide: true,
    send: true,
    reply: true,
    type: true,
    resize: true,
    panels: true,
    maximize: true,
    close: true,
    click: true,
    working: true,
    volume: 0.6,
  },
  colors: structuredClone(DEFAULT_COLOR_SETS),
  workspace: "",
  collapsed: true,
  voice: { model: "ggml-base.en.bin", autoSend: false, handsFree: false, pauseMs: 1500, sens: 0.7 },
  speakReplies: false,
  ttsVoice: "",
  ttsVol: 1,
  ttsSpeed: 1,
  gitModel: "",
};

function num(v: unknown, def: number, min: number, max: number) {
  return typeof v === "number" && v >= min && v <= max ? v : def;
}

// migrates legacy shapes:
//   flat colors ({base,...})            → cyan/dark
//   theme "midnight"/"dark"/"light"     → theme "cyan" + matching mode
//   latte/matcha/strawberry (no mode)   → same theme + light mode
function loadColors(p: any, legacyTheme: string): AppColors {
  const out = structuredClone(DEFAULT_COLOR_SETS);
  const th: string =
    typeof p?.colors?.[legacyTheme] === "object" ? legacyTheme : "cyan";
  // custom theme ids have no defaults — start from the shared cyan base
  if (!out[th]) out[th] = structuredClone(DEFAULT_COLOR_SETS.cyan);
  const src = p?.colors?.[th];
  if (src) {
    for (const m of ["dark", "light"] as Mode[]) {
      const s = src[m];
      if (!s) continue;
      if (HEX.test(s.base)) out[th][m].base = s.base;
      out[th][m].baseA = num(s.baseA, out[th][m].baseA, 0, 1);
      if (HEX.test(s.surface)) out[th][m].surface = s.surface;
      out[th][m].surfaceA = num(s.surfaceA, out[th][m].surfaceA, 0, 1);
    }
  } else if (p?.colors && HEX.test(p.colors.base)) {
    // very old flat shape
    out.cyan.dark.base = p.colors.base;
    out.cyan.dark.baseA = num(p.colors.baseA, out.cyan.dark.baseA, 0, 1);
    out.cyan.dark.surface = p.colors.surface ?? out.cyan.dark.surface;
    out.cyan.dark.surfaceA = num(p.colors.surfaceA, out.cyan.dark.surfaceA, 0, 1);
  }
  return out;
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

// per-theme color overrides may not exist for custom/config themes — fall
// back to cyan's (the palettes' translucent black base is shared anyway)
function colorsFor(colors: AppColors, theme: string): Record<Mode, ColorSet> {
  return colors[theme] ?? colors.cyan ?? DEFAULT_COLOR_SETS.cyan;
}

// load ~/.config/.opencode-gui/themes.json via the Rust side, seeding the
// default file on first run. returns null when the file is present but
// unusable (caller keeps its previous set)
async function loadThemeConfig(): Promise<Record<string, NormalizedTheme> | null> {
  let text = await invoke<string>("theme_config_read").catch(() => "");
  if (!text.trim()) {
    text = defaultThemesJson();
    await invoke("theme_config_write", { content: text }).catch(() => {});
    return parseThemesConfig(text);
  }
  // pre-versioned seed (v1 had no explicit cyan dark block) — re-seed
  try {
    const obj = JSON.parse(stripComments(text));
    if (obj?.version !== THEME_CONFIG_VERSION) {
      text = defaultThemesJson();
      await invoke("theme_config_write", { content: text }).catch(() => {});
      return parseThemesConfig(text);
    }
  } catch {
    return null; // invalid JSON → caller keeps last good set
  }
  return parseThemesConfig(text);
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const p = JSON.parse(raw);
      const legacy = p.theme === "light";
      const theme: ThemeName = typeof p.theme === "string" && !legacy ? p.theme : "cyan";
      const mode: Mode = legacy ? "light" : p.mode === "light" ? "light" : "dark";
      return {
        theme,
        mode,
        alwaysOnTop: !!p.alwaysOnTop,
        uiScale: num(p.uiScale, DEFAULTS.uiScale, 0.7, 1.5),
        sounds: {
          show: p.sounds?.show ?? true,
          hide: p.sounds?.hide ?? true,
          send: p.sounds?.send ?? true,
          reply: p.sounds?.reply ?? true,
          type: p.sounds?.type ?? true,
          resize: p.sounds?.resize ?? true,
          panels: p.sounds?.panels ?? true,
          maximize: p.sounds?.maximize ?? true,
          close: p.sounds?.close ?? true,
          click: p.sounds?.click ?? true,
          working: p.sounds?.working ?? true,
          volume: num(p.sounds?.volume, DEFAULTS.sounds.volume, 0, 1),
        },
        colors: loadColors(p, legacy ? "light" : theme),
        workspace: typeof p.workspace === "string" ? p.workspace : "",
        voice: {
          model:
            typeof p.voice?.model === "string" && p.voice.model
              ? p.voice.model
              : "ggml-base.en.bin",
          autoSend: !!p.voice?.autoSend,
          handsFree: !!p.voice?.handsFree,
          pauseMs: num(p.voice?.pauseMs, DEFAULTS.voice.pauseMs, 400, 4000),
          sens: num(p.voice?.sens, DEFAULTS.voice.sens, 0, 1),
        },
        speakReplies: !!p.speakReplies,
        // spoken replies are piper-only now — a stored Windows speechSynthesis
        // URI (or old "piper:"-prefixed id) fails the .onnx check and resets
        ttsVoice:
          typeof p.ttsVoice === "string" && p.ttsVoice.endsWith(".onnx") ? p.ttsVoice : "",
        ttsVol: num(p.ttsVol, DEFAULTS.ttsVol, 0, 1),
        ttsSpeed: num(p.ttsSpeed, DEFAULTS.ttsSpeed, 0.5, 2),
        gitModel: typeof p.gitModel === "string" ? p.gitModel : "",
        // legacy showThinking (true = thinking expanded) inverts into the new
        // collapsed flag so existing users keep their default; fresh installs
        // start fully collapsed
        collapsed:
          p.collapsed ??
          (p.showThinking === undefined ? true : !p.showThinking),
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  });

  // available themes — seeded from config at boot, hot-reloaded on file change
  const [themes, setThemes] = useState<Record<string, NormalizedTheme>>({});
  const [themeError, setThemeError] = useState("");

  useEffect(() => {
    let disposed = false;
    const reload = () =>
      loadThemeConfig().then((parsed) => {
        if (disposed) return;
        if (parsed) {
          setThemes(parsed);
          setThemeError("");
        } else {
          setThemeError("themes.json is invalid — keeping the last good set");
        }
      });
    reload();
    let un: (() => void) | undefined;
    listen("themes://changed", reload).then((f) => {
      un = f;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // active theme id must exist; deleted themes fall back to the first entry
  const activeId =
    settings.theme in themes
      ? settings.theme
      : Object.keys(themes)[0] ?? settings.theme;
  const activeDef = themes[activeId];
  // variations the active theme defines — single-variation themes lock the UI
  const activeModes: Mode[] = activeDef
    ? ([("dark" as const), ("light" as const)].filter((m) => activeDef.available[m]) as Mode[])
    : (["dark", "light"] as Mode[]);
  const effectiveMode: Mode = activeModes.includes(settings.mode)
    ? settings.mode
    : activeModes[0];

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    setSoundPrefs(settings.sounds);
  }, [settings.sounds]);

  // theme + mode + appearance → DOM (CSS variables drive every surface).
  // full palette comes from applyTheme; the user's per-theme color overrides
  // layer on top of it afterwards
  useEffect(() => {
    if (activeDef) applyTheme(activeId, activeDef, effectiveMode);
    else document.documentElement.dataset.mode = effectiveMode;
    const cs = colorsFor(settings.colors, activeId)[effectiveMode];
    const s = document.documentElement.style;
    s.setProperty("--base-rgb", hexToRgb(cs.base));
    s.setProperty("--base-a", String(cs.baseA));
    s.setProperty("--surf-rgb", hexToRgb(cs.surface));
    s.setProperty("--surf-a", String(cs.surfaceA));
  }, [activeDef, activeId, settings.mode, settings.colors, effectiveMode]);

  useEffect(() => {
    getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop).catch(() => {});
  }, [settings.alwaysOnTop]);

  useEffect(() => {
    getCurrentWebview().setZoom(settings.uiScale).catch(() => {});
  }, [settings.uiScale]);

  const update = useCallback(
    (patch: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );

  // deleted active theme: persist the fallback so it doesn't re-resolve
  useEffect(() => {
    if (Object.keys(themes).length && !(settings.theme in themes)) {
      update({ theme: Object.keys(themes)[0] });
    }
  }, [themes, settings.theme, update]);

  const updateSounds = useCallback((patch: Partial<SoundPrefs>) => {
    setSettings((s) => ({ ...s, sounds: { ...s.sounds, ...patch } }));
  }, []);

  const updateColors = useCallback(
    (patch: Partial<ColorSet>) =>
      setSettings((s) => {
        const cur = colorsFor(s.colors, s.theme);
        return {
          ...s,
          colors: {
            ...s.colors,
            [s.theme]: {
              ...cur,
              [s.mode]: { ...cur[s.mode], ...patch },
            },
          },
        };
      }),
    [],
  );

  const resetColors = useCallback(
    () =>
      setSettings((s) => ({
        ...s,
        colors: {
          ...s.colors,
          [s.theme]: structuredClone(DEFAULT_COLOR_SETS.cyan),
        },
      })),
    [],
  );

  const themeList: ThemeMeta[] = Object.values(themes).map((t) => t.meta);

  return {
    settings,
    update,
    updateSounds,
    updateColors,
    resetColors,
    themes: themeList,
    themeError,
    activeModes,
    effectiveMode,
    colorsFor: (theme: string) => colorsFor(settings.colors, theme),
  };
}
