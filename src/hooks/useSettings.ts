import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { setSoundPrefs, type SoundPrefs } from "../lib/sounds";

export type AppColors = {
  base: string; // main background tint, #rrggbb
  baseA: number; // its transparency, 0..1
  surface: string; // chat/input panel tint, #rrggbb
  surfaceA: number;
};

export const DEFAULT_COLORS: AppColors = {
  base: "#090c10",
  baseA: 0.72,
  surface: "#172830",
  surfaceA: 0.33,
};

export type AppSettings = {
  alwaysOnTop: boolean;
  uiScale: number;
  sounds: SoundPrefs;
  colors: AppColors;
};

const KEY = "oc.settings";
const DEFAULTS: AppSettings = {
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
  colors: { ...DEFAULT_COLORS },
};

const HEX = /^#[0-9a-f]{6}$/i;

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const p = JSON.parse(raw);
    return {
      alwaysOnTop: !!p.alwaysOnTop,
      uiScale:
        typeof p.uiScale === "number" && p.uiScale >= 0.7 && p.uiScale <= 1.5
          ? p.uiScale
          : DEFAULTS.uiScale,
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
        volume:
          typeof p.sounds?.volume === "number" && p.sounds.volume >= 0 && p.sounds.volume <= 1
            ? p.sounds.volume
            : DEFAULTS.sounds.volume,
      },
      colors: {
        base: HEX.test(p.colors?.base) ? p.colors.base : DEFAULT_COLORS.base,
        baseA:
          typeof p.colors?.baseA === "number" && p.colors.baseA >= 0 && p.colors.baseA <= 1
            ? p.colors.baseA
            : DEFAULT_COLORS.baseA,
        surface: HEX.test(p.colors?.surface) ? p.colors.surface : DEFAULT_COLORS.surface,
        surfaceA:
          typeof p.colors?.surfaceA === "number" && p.colors.surfaceA >= 0 && p.colors.surfaceA <= 1
            ? p.colors.surfaceA
            : DEFAULT_COLORS.surfaceA,
      },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, [settings]);

  // mirror sound prefs into the synth lib
  useEffect(() => {
    setSoundPrefs(settings.sounds);
  }, [settings.sounds]);

  // push appearance into CSS variables (consumed by tokens/layout/chat css)
  useEffect(() => {
    const s = document.documentElement.style;
    s.setProperty("--base-rgb", hexToRgb(settings.colors.base));
    s.setProperty("--base-a", String(settings.colors.baseA));
    s.setProperty("--surf-rgb", hexToRgb(settings.colors.surface));
    s.setProperty("--surf-a", String(settings.colors.surfaceA));
  }, [settings.colors]);

  // apply on boot + change (also replaces the old fixed setZoom(1))
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

  const updateColors = useCallback((patch: Partial<AppColors>) => {
    setSettings((s) => ({ ...s, colors: { ...s.colors, ...patch } }));
  }, []);

  const resetColors = useCallback(
    () => setSettings((s) => ({ ...s, colors: { ...DEFAULT_COLORS } })),
    [],
  );

  return { settings, update, updateSounds, updateColors, resetColors };
}
