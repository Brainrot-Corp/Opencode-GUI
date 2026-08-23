import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { setSoundPrefs, type SoundPrefs } from "../lib/sounds";

export type AppSettings = {
  alwaysOnTop: boolean;
  uiScale: number;
  sounds: SoundPrefs;
};

const KEY = "oc.settings";
const DEFAULTS: AppSettings = {
  alwaysOnTop: false,
  uiScale: 1,
  sounds: { show: true, hide: true, send: true, reply: true, volume: 0.6 },
};

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
        volume:
          typeof p.sounds?.volume === "number" && p.sounds.volume >= 0 && p.sounds.volume <= 1
            ? p.sounds.volume
            : DEFAULTS.sounds.volume,
      },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
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

  return { settings, update, updateSounds };
}
