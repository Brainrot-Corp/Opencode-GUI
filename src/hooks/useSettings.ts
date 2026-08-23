import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { setSoundPrefs, type SoundPrefs } from "../lib/sounds";

export type ThemeName = "cyan" | "latte" | "matcha" | "strawberry";
export type Mode = "dark" | "light";
export type ColorSet = { base: string; baseA: number; surface: string; surfaceA: number };
export type AppColors = Record<ThemeName, Record<Mode, ColorSet>>;

export const THEMES: { id: ThemeName; name: string; icon: string }[] = [
  { id: "cyan", name: "Cyan", icon: "fa-droplet" },
  { id: "latte", name: "Latte", icon: "fa-mug-hot" },
  { id: "matcha", name: "Matcha", icon: "fa-leaf" },
  { id: "strawberry", name: "Strawberry", icon: "fa-apple-whole" },
];

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
    dark: { base: "#0c110b", baseA: 0.62, surface: "#182116", surfaceA: 0.42 },
    light: { base: "#eef4e7", baseA: 0.55, surface: "#fbfef7", surfaceA: 0.5 },
  },
  strawberry: {
    dark: { base: "#140b0e", baseA: 0.62, surface: "#26141a", surfaceA: 0.42 },
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
    volume: 0.6,
  },
  colors: structuredClone(DEFAULT_COLOR_SETS),
  workspace: "",
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
  const themes: ThemeName[] = ["cyan", "latte", "matcha", "strawberry"];
  const th: ThemeName = themes.includes(p?.colors?.[legacyTheme] as ThemeName)
    ? (p.colors[legacyTheme] as ThemeName)
    : "cyan";
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
    if (HEX.test(p.colors.base)) out.cyan.dark.base = p.colors.base;
    out.cyan.dark.baseA = num(p.colors.baseA, out.cyan.dark.baseA, 0, 1);
    if (HEX.test(p.colors.surface)) out.cyan.dark.surface = p.colors.surface;
    out.cyan.dark.surfaceA = num(p.colors.surfaceA, out.cyan.dark.surfaceA, 0, 1);
  }
  return out;
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const p = JSON.parse(raw);
      const legacy = p.theme === "light";
      const themes: ThemeName[] = ["cyan", "latte", "matcha", "strawberry"];
      const theme: ThemeName = themes.includes(p.theme) ? p.theme : "cyan";
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
          volume: num(p.sounds?.volume, DEFAULTS.sounds.volume, 0, 1),
        },
        colors: loadColors(p, legacy ? "light" : theme),
        workspace: typeof p.workspace === "string" ? p.workspace : "",
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  });

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    setSoundPrefs(settings.sounds);
  }, [settings.sounds]);

  // theme + mode + appearance → DOM (CSS variables drive every surface)
  useEffect(() => {
    const cs = settings.colors[settings.theme][settings.mode];
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.mode = settings.mode;
    const s = document.documentElement.style;
    s.setProperty("--base-rgb", hexToRgb(cs.base));
    s.setProperty("--base-a", String(cs.baseA));
    s.setProperty("--surf-rgb", hexToRgb(cs.surface));
    s.setProperty("--surf-a", String(cs.surfaceA));
  }, [settings.theme, settings.mode, settings.colors]);

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

  const updateSounds = useCallback((patch: Partial<SoundPrefs>) => {
    setSettings((s) => ({ ...s, sounds: { ...s.sounds, ...patch } }));
  }, []);

  const updateColors = useCallback(
    (patch: Partial<ColorSet>) =>
      setSettings((s) => ({
        ...s,
        colors: {
          ...s.colors,
          [s.theme]: { ...s.colors[s.theme], [s.mode]: { ...s.colors[s.theme][s.mode], ...patch } },
        },
      })),
    [],
  );

  const resetColors = useCallback(
    () =>
      setSettings((s) => ({
        ...s,
        colors: {
          ...structuredClone(DEFAULT_COLOR_SETS),
          [s.theme]: structuredClone(DEFAULT_COLOR_SETS)[s.theme],
        },
      })),
    [],
  );

  return { settings, update, updateSounds, updateColors, resetColors };
}