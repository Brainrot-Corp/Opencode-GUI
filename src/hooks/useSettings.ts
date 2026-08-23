import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { setSoundPrefs, type SoundPrefs } from "../lib/sounds";

export type ThemeName = "dark" | "light";
export type ColorSet = { base: string; baseA: number; surface: string; surfaceA: number };
export type AppColors = Record<ThemeName, ColorSet>;

export const DEFAULT_COLOR_SETS: Record<ThemeName, ColorSet> = {
  dark: { base: "#090c10", baseA: 0.6, surface: "#172830", surfaceA: 0.33 },
  light: { base: "#eef2f5", baseA: 0.55, surface: "#ffffff", surfaceA: 0.5 },
};

export type AppSettings = {
  theme: ThemeName;
  alwaysOnTop: boolean;
  uiScale: number;
  sounds: SoundPrefs;
  colors: AppColors;
};

const KEY = "oc.settings";
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULTS: AppSettings = {
  theme: "dark",
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
};

function num(v: unknown, def: number, min: number, max: number) {
  return typeof v === "number" && v >= min && v <= max ? v : def;
}

// migrates the legacy flat colors shape ({base,...}) into the per-theme layout
function loadColors(p: any): AppColors {
  const out = {} as AppColors;
  for (const th of ["dark", "light"] as ThemeName[]) {
    const src = p?.colors?.[th] ?? (th === "dark" ? p?.colors : undefined);
    out[th] = {
      base: HEX.test(src?.base) ? src.base : DEFAULT_COLOR_SETS[th].base,
      baseA: num(src?.baseA, DEFAULT_COLOR_SETS[th].baseA, 0, 1),
      surface: HEX.test(src?.surface) ? src.surface : DEFAULT_COLOR_SETS[th].surface,
      surfaceA: num(src?.surfaceA, DEFAULT_COLOR_SETS[th].surfaceA, 0, 1),
    };
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
      return {
        theme: p.theme === "light" ? "light" : "dark",
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
        colors: loadColors(p),
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

  // theme + appearance → DOM (CSS custom properties drive every surface)
  useEffect(() => {
    const cs = settings.colors[settings.theme];
    document.documentElement.dataset.theme = settings.theme;
    const s = document.documentElement.style;
    s.setProperty("--base-rgb", hexToRgb(cs.base));
    s.setProperty("--base-a", String(cs.baseA));
    s.setProperty("--surf-rgb", hexToRgb(cs.surface));
    s.setProperty("--surf-a", String(cs.surfaceA));
  }, [settings.theme, settings.colors]);

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
        colors: { ...s.colors, [s.theme]: { ...s.colors[s.theme], ...patch } },
      })),
    [],
  );

  const resetColors = useCallback(
    () => setSettings((s) => ({ ...s, colors: structuredClone(DEFAULT_COLOR_SETS) })),
    [],
  );

  return { settings, update, updateSounds, updateColors, resetColors };
}