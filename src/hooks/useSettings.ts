import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { setSoundPrefs, type SoundPrefs } from "../lib/sounds";
import { getDirectory, setDirectory } from "../api";
import {
  applyTheme,
  defaultThemesJson,
  parseThemesConfig,
  stripComments,
  THEME_CONFIG_VERSION,
  type NormalizedTheme,
  type ThemeMeta,
} from "../lib/themes";
import { DEFAULT_HOTKEYS, normalizeBinding, type HotkeysMap, type PluginHotkeysMap } from "../lib/hotkeys";
import { pushToast } from "./useToast";

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
    dark: { base: "#19140c", baseA: 0.6, surface: "#382d1d", surfaceA: 0.33 },
    light: { base: "#f6efe4", baseA: 0.55, surface: "#fffbf3", surfaceA: 0.5 },
  },
  matcha: {
    dark: { base: "#0f150c", baseA: 0.6, surface: "#24301f", surfaceA: 0.33 },
    light: { base: "#eef4e7", baseA: 0.55, surface: "#f8fcf4", surfaceA: 0.5 },
  },
  strawberry: {
    dark: { base: "#170f12", baseA: 0.6, surface: "#342027", surfaceA: 0.33 },
    light: { base: "#fbeef2", baseA: 0.55, surface: "#fff8fa", surfaceA: 0.5 },
  },
  sakura: {
    dark: { base: "#1a1014", baseA: 0.6, surface: "#301c26", surfaceA: 0.33 },
    light: { base: "#fff8fb", baseA: 0.55, surface: "#fff8fb", surfaceA: 0.5 },
  },
  nebula: {
    dark: { base: "#120e1c", baseA: 0.6, surface: "#28203e", surfaceA: 0.33 },
    light: { base: "#faf9ff", baseA: 0.55, surface: "#faf9ff", surfaceA: 0.5 },
  },
  vaporwave: {
    dark: { base: "#0e0918", baseA: 0.62, surface: "#2c1a46", surfaceA: 0.35 },
    light: { base: "#fcf8ff", baseA: 0.55, surface: "#fcf8ff", surfaceA: 0.5 },
  },
  ember: {
    dark: { base: "#160f0a", baseA: 0.6, surface: "#382416", surfaceA: 0.33 },
    light: { base: "#fffaf4", baseA: 0.55, surface: "#fffaf4", surfaceA: 0.5 },
  },
  abyss: {
    dark: { base: "#060d12", baseA: 0.62, surface: "#142c3e", surfaceA: 0.33 },
    light: { base: "#f6fbfd", baseA: 0.55, surface: "#f6fbfd", surfaceA: 0.5 },
  },
  citrus: {
    dark: { base: "#14120b", baseA: 0.6, surface: "#38341c", surfaceA: 0.33 },
    light: { base: "#fefdf3", baseA: 0.55, surface: "#fefdf3", surfaceA: 0.5 },
  },
  graphite: {
    dark: { base: "#0e0f11", baseA: 0.62, surface: "#282a30", surfaceA: 0.33 },
    light: { base: "#f2f4f6", baseA: 0.6, surface: "#fcfcfd", surfaceA: 0.5 },
  },
  crimson: {
    dark: { base: "#1c0e10", baseA: 0.62, surface: "#3a1c20", surfaceA: 0.33 },
    light: { base: "#fdf2f3", baseA: 0.6, surface: "#fff8f9", surfaceA: 0.5 },
  },
  tidal: {
    dark: { base: "#0a1616", baseA: 0.62, surface: "#1c3434", surfaceA: 0.33 },
    light: { base: "#f0f8f7", baseA: 0.6, surface: "#f6fcfb", surfaceA: 0.5 },
  },
  aurora: {
    dark: { base: "#0c1411", baseA: 0.62, surface: "#1c2c28", surfaceA: 0.33 },
    light: { base: "#f0f8f5", baseA: 0.6, surface: "#f6fcf9", surfaceA: 0.5 },
  },
};

export type CustomShell = { id: string; name: string; path: string; args: string };
export type TerminalSettings = { defaultProfileId: string | null; customShells: CustomShell[] };

export type AppSettings = {
  theme: ThemeName;
  mode: Mode;
  alwaysOnTop: boolean;
  // true = don't snap back to default size when reopening from the tray
  keepWindowSize: boolean;
  // true = the titlebar X button exits the app instead of hiding to tray
  closeOnX: boolean;
  uiScale: number;
  sounds: SoundPrefs;
  colors: AppColors;
  workspace: string;
  workspaces: string[];
  // global collapse-by-default for thinking + tool-call blocks (/collapse)
  collapsed: boolean;
  voice: {
    model: string;
    sens: number;
    // debug transcript mode — show raw → router input → matched act
    debug: boolean;
    // no English match → re-run the utterance through whisper's
    // --translate task and retry routing
    multilingual: boolean;
    // prefer the GPU (NVIDIA cublas) whisper engine when installed
    gpu: boolean;
  };
  speakReplies: boolean;
  // piper voice file ("<id>.onnx") for spoken replies — "" = none yet
  ttsVoice: string;
  ttsVol: number;
  // speech rate multiplier (0.5 = half speed … 2 = double)
  ttsSpeed: number;
  // secondary model for commit messages, debriefs & long-answer summaries ("provider/model", "" = off)
  secondaryModel: string;
  // include optional body in AI commit messages (subject + bullet body)
  commitBody: boolean;
  // show the update-available prompt on launch (Settings → Updates still works when off)
  updateNotifications: boolean;
  terminal: TerminalSettings;
  // opaque per-plugin config blobs — each plugin validates its own shape
  plugins: Record<string, Record<string, unknown>>;
  hotkeys: HotkeysMap;
  pluginHotkeys: PluginHotkeysMap;
};

const KEY = "oc.settings";
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULTS: AppSettings = {
  theme: "cyan",
  mode: "dark",
  alwaysOnTop: false,
  keepWindowSize: false,
  closeOnX: false,
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
    attention: true,
    volume: 0.6,
  },
  colors: structuredClone(DEFAULT_COLOR_SETS),
  workspace: "",
  workspaces: [],
  collapsed: true,
  voice: { model: "ggml-base.bin", sens: 0.7, debug: false, multilingual: false, gpu: false },
  speakReplies: false,
  ttsVoice: "",
  ttsVol: 1,
  ttsSpeed: 1,
  secondaryModel: "",
  commitBody: false,
  updateNotifications: true,
  terminal: { defaultProfileId: null, customShells: [] },
  plugins: {},
  hotkeys: structuredClone(DEFAULT_HOTKEYS),
  pluginHotkeys: {},
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
        keepWindowSize: !!p.keepWindowSize,
        closeOnX: !!p.closeOnX,
        uiScale: (() => {
          const v = num(p.uiScale, DEFAULTS.uiScale, 0.7, 2);
          return v === 2 ? 1.75 : v > 1.75 ? 1.75 : v;
        })(),
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
          attention: p.sounds?.attention ?? true,
          volume: num(p.sounds?.volume, DEFAULTS.sounds.volume, 0, 1),
        },
        colors: loadColors(p, legacy ? "light" : theme),
        workspace: typeof p.workspace === "string" ? p.workspace : "",
        workspaces: (() => {
          const arr = Array.isArray(p.workspaces) ? p.workspaces : [];
          const out: string[] = [];
          const seen = new Set<string>();
          const primary = typeof p.workspace === "string" ? p.workspace.trim() : "";
          for (const v of arr) {
            if (typeof v !== "string") continue;
            const t = v.trim();
            if (!t || t === primary) continue;
            const low = t.toLowerCase();
            if (seen.has(low)) continue;
            seen.add(low);
            out.push(t);
            if (out.length >= 5) break;
          }
          return out;
        })(),
        voice: {
          model:
            typeof p.voice?.model === "string" && p.voice.model
              ? p.voice.model
              : "ggml-base.bin",
          sens: num(p.voice?.sens, DEFAULTS.voice.sens, 0, 1),
          debug: !!p.voice?.debug,
          multilingual: p.voice?.multilingual === undefined ? false : !!p.voice.multilingual,
          gpu: !!p.voice?.gpu,
        },
        ttsVoice:
          typeof p.ttsVoice === "string" && p.ttsVoice && !p.ttsVoice.includes("/") && !p.ttsVoice.includes("\\") && !p.ttsVoice.includes("..") && p.ttsVoice.length < 64
            ? p.ttsVoice
            : "",
        ttsVol: num(p.ttsVol, DEFAULTS.ttsVol, 0, 1),
        ttsSpeed: num(p.ttsSpeed, DEFAULTS.ttsSpeed, 0.5, 2),
        secondaryModel: typeof p.secondaryModel === "string" ? p.secondaryModel : "",
        commitBody: !!p.commitBody,
        updateNotifications: p.updateNotifications === false ? false : true,
        terminal: (() => {
          const t: any = p.terminal;
          if (!t || typeof t !== "object") return structuredClone(DEFAULTS.terminal);
          const def = typeof t.defaultProfileId === "string" && t.defaultProfileId.trim() ? t.defaultProfileId.trim() : null;
          const arr = Array.isArray(t.customShells) ? t.customShells : [];
          const customShells: CustomShell[] = [];
          for (const c of arr) {
            if (!c || typeof c !== "object") continue;
            const id = typeof (c as any).id === "string" ? (c as any).id.trim() : "";
            const name = typeof (c as any).name === "string" ? (c as any).name.trim() : "";
            const path = typeof (c as any).path === "string" ? (c as any).path.trim() : "";
            const args = typeof (c as any).args === "string" ? (c as any).args : "";
            if (!id || !name || !path) continue;
            if (name.length > 80 || path.length > 500 || args.length > 500) continue;
            customShells.push({ id: id.slice(0, 64), name: name.slice(0, 80), path: path.slice(0, 500), args: args.slice(0, 500) });
            if (customShells.length >= 20) break;
          }
          return { defaultProfileId: def, customShells };
        })(),
        plugins:
          p.plugins && typeof p.plugins === "object" && !Array.isArray(p.plugins)
            ? p.plugins
            : {},
        hotkeys: (() => {
          const out = structuredClone(DEFAULT_HOTKEYS) as HotkeysMap;
          const src = p.hotkeys as any;
          if (src && typeof src === "object" && !Array.isArray(src)) {
            for (const k of Object.keys(DEFAULT_HOTKEYS) as (keyof HotkeysMap)[]) {
              const v = src[k];
              if (v === null) out[k] = null;
              else if (typeof v === "string") {
                const n = normalizeBinding(v);
                out[k] = n;
              }
            }
          }
          return out;
        })(),
        pluginHotkeys: (() => {
          const out: PluginHotkeysMap = {};
          const src = (p as any).pluginHotkeys;
          if (src && typeof src === "object" && !Array.isArray(src)) {
            for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
              if (typeof k !== "string" || !k.includes(":")) continue;
              if (v === null) out[k] = null;
              else if (typeof v === "string") {
                const n = normalizeBinding(v);
                out[k] = n;
              }
            }
          }
          return out;
        })(),
        speakReplies: !!p.speakReplies && typeof p.secondaryModel === "string" && !!p.secondaryModel && typeof p.ttsVoice === "string" && !!p.ttsVoice,
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

  useEffect(() => {
    let disposed = false;
    const reload = () =>
      loadThemeConfig().then((parsed) => {
        if (disposed) return;
        if (parsed) {
          setThemes(parsed);
        } else {
          pushToast("themes.json is invalid — keeping the last good set");
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
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch (e) {
      try { pushToast(`Failed to save settings: ${e}`); } catch {}
    }
  }, [settings]);

  // keep Rust file + api directory in sync so local debug builds survive
  // devUrl origin resets (localStorage for http://localhost:1420 vs
  // tauri://localhost). applyWorkspace already writes, this covers any other
  // path that mutates workspace.
  useEffect(() => {
    invoke("workspace_set", { path: settings.workspace }).catch(() => {});
    if (getDirectory() !== settings.workspace) setDirectory(settings.workspace);
  }, [settings.workspace]);

  useEffect(() => {
    setSoundPrefs(settings.sounds);
  }, [settings.sounds]);

  // appearance overrides live entirely in-memory (never written to the
  // persisted json). The json (DEFAULT_COLOR_SETS / themes.json) stays
  // pristine and is the source of truth for Reset, while edits are pure
  // CSS overrides via --base-* / --surf-*.
  const [appearanceOverrides, setAppearanceOverrides] = useState<Partial<AppColors>>({});

  // theme + mode + appearance → DOM (CSS variables drive every surface).
  // full palette comes from applyTheme; the in-memory appearance overrides
  // layer on top of it afterwards — no mutation of the persisted colors json.
  useEffect(() => {
    if (activeDef) applyTheme(activeId, activeDef, effectiveMode);
    else document.documentElement.dataset.mode = effectiveMode;
    const defaultCs =
      DEFAULT_COLOR_SETS[activeId]?.[effectiveMode] ?? DEFAULT_COLOR_SETS.cyan[effectiveMode];
    const overrideCs = (appearanceOverrides as AppColors)[activeId]?.[effectiveMode];
    const cs = overrideCs ?? defaultCs;
    const s = document.documentElement.style;
    s.setProperty("--base-rgb", hexToRgb(cs.base));
    s.setProperty("--base-a", String(cs.baseA));
    s.setProperty("--surf-rgb", hexToRgb(cs.surface));
    s.setProperty("--surf-a", String(cs.surfaceA));
  }, [activeDef, activeId, effectiveMode, appearanceOverrides]);

  useEffect(() => {
    getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop).catch(() => {});
  }, [settings.alwaysOnTop]);

  // mirror into Rust: show_main snaps to default size on tray reopen unless
  // this says otherwise
  useEffect(() => {
    invoke("set_tray_reset", { enabled: !settings.keepWindowSize }).catch(() => {});
  }, [settings.keepWindowSize]);

  // zoom — and keep every scroll container at the same relative position:
  // the native zoom reflows the whole DOM asynchronously, so ratios are
  // snapshotted before and reapplied while the layout settles
  useEffect(() => {
    type Snap = { el: HTMLElement; yr: number; xr: number };
    const snap: Snap[] = [];
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      const yMax = el.scrollHeight - el.clientHeight;
      const xMax = el.scrollWidth - el.clientWidth;
      if (yMax > 1 || xMax > 1) {
        snap.push({
          el,
          yr: yMax > 1 ? el.scrollTop / yMax : 0,
          xr: xMax > 1 ? el.scrollLeft / xMax : 0,
        });
      }
    });
    getCurrentWebview().setZoom(settings.uiScale).catch(() => {});
    const restore = () => {
      for (const { el, yr, xr } of snap) {
        el.scrollTop = yr * (el.scrollHeight - el.clientHeight);
        el.scrollLeft = xr * (el.scrollWidth - el.clientWidth);
      }
    };
    const raf = requestAnimationFrame(restore);
    window.addEventListener("resize", restore);
    const stop = window.setTimeout(
      () => window.removeEventListener("resize", restore),
      600,
    );
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(stop);
      window.removeEventListener("resize", restore);
    };
  }, [settings.uiScale]);

  const update = useCallback(
    (patch: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );

  // patch one plugin's config blob (plugins read live values via api.settings())
  const updatePlugin = useCallback((id: string, patch: Record<string, unknown>) => {
    setSettings((s) => ({
      ...s,
      plugins: { ...s.plugins, [id]: { ...s.plugins[id], ...patch } },
    }));
  }, []);

  // secondary + voice required for speech — auto-off if either cleared
  useEffect(() => {
    if (settings.speakReplies && (!settings.secondaryModel || !settings.ttsVoice)) {
      update({ speakReplies: false });
    }
  }, [settings.secondaryModel, settings.ttsVoice, settings.speakReplies, update]);

  // deleted active theme: persist the fallback so it doesn't re-resolve
  useEffect(() => {
    if (Object.keys(themes).length && !(settings.theme in themes)) {
      update({ theme: Object.keys(themes)[0] });
    }
  }, [themes, settings.theme, update]);

  const updateSounds = useCallback((patch: Partial<SoundPrefs>) => {
    setSettings((s) => ({ ...s, sounds: { ...s.sounds, ...patch } }));
  }, []);

  // Appearance edits are pure in-memory CSS overrides keyed by the
  // *effective* theme/mode (the actual vars on <html>). They never touch
  // the persisted json, so the json stays as the reset source.
  const updateColors = useCallback(
    (patch: Partial<ColorSet>) =>
      setAppearanceOverrides((prev) => {
        const tid = activeId;
        const mode = effectiveMode;
        const defaultCs =
          DEFAULT_COLOR_SETS[tid]?.[mode] ?? DEFAULT_COLOR_SETS.cyan[mode];
        const cur = (prev as AppColors)[tid]?.[mode] ?? defaultCs;
        const nextCs = { ...cur, ...patch };
        const themePrev = (prev as AppColors)[tid] ?? {};
        return {
          ...(prev as AppColors),
          [tid]: { ...themePrev, [mode]: nextCs },
        } as Partial<AppColors>;
      }),
    [activeId, effectiveMode],
  );

  // dynamic reset — clears the override for the *current* effective
  // theme×mode so the CSS falls back to the json defaults for that exact
  // theme/mode (not a hardcoded cyan).
  const resetColors = useCallback(
    () =>
      setAppearanceOverrides((prev) => {
        const tid = activeId;
        const mode = effectiveMode;
        const next = { ...(prev as AppColors) } as AppColors;
        if (!next[tid]) return prev;
        const themeNext = { ...next[tid] };
        delete (themeNext as Record<string, unknown>)[mode];
        if (Object.keys(themeNext).length === 0) {
          delete (next as Record<string, unknown>)[tid];
        } else {
          (next as Record<string, unknown>)[tid] = themeNext;
        }
        return next as Partial<AppColors>;
      }),
    [activeId, effectiveMode],
  );

  const themeList: ThemeMeta[] = Object.values(themes).map((t) => t.meta);

  // merged view for the drawer: overrides win, otherwise json defaults.
  // kept stable via callback so AppearanceSettings sees live slider values.
  const mergedColorsFor = useCallback(
    (theme: string) => {
      const defaults = colorsFor(DEFAULT_COLOR_SETS as AppColors, theme);
      const overrides = (appearanceOverrides as AppColors)[theme];
      if (!overrides) return defaults;
      return {
        dark: overrides.dark ?? defaults.dark,
        light: overrides.light ?? defaults.light,
      } as Record<Mode, ColorSet>;
    },
    [appearanceOverrides],
  );

  // overwrite themes.json on disk with the built-in defaults — file watcher
  // will also emit themes://changed, but we apply immediately for instant feedback
  const resetThemes = useCallback(async () => {
    const text = defaultThemesJson();
    try {
      await invoke("theme_config_write", { content: text });
      const parsed = parseThemesConfig(text);
      if (parsed) {
        setThemes(parsed);
      }
    } catch (e) {
      pushToast(String(e));
    }
  }, []);

  return {
    settings,
    update,
    updatePlugin,
    updateSounds,
    updateColors,
    resetColors,
    resetThemes,
    themes: themeList,
    activeModes,
    effectiveMode,
    colorsFor: mergedColorsFor,
  };
}
