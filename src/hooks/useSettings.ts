import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export type AppSettings = {
  alwaysOnTop: boolean;
  uiScale: number;
};

const KEY = "oc.settings";
const DEFAULTS: AppSettings = { alwaysOnTop: false, uiScale: 1 };

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw);
    return {
      alwaysOnTop: !!p.alwaysOnTop,
      uiScale:
        typeof p.uiScale === "number" && p.uiScale >= 0.7 && p.uiScale <= 1.5
          ? p.uiScale
          : DEFAULTS.uiScale,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, [settings]);

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

  return { settings, update };
}
