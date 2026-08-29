// per-terminal xterm instance — one per PTY session.
// Owned by Terminal dock; mounted hidden when inactive to preserve scrollback.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TermHighlighter } from "../lib/termHighlight";

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return "";
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

function termTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  const accent = v("--accent", "#7fd4d4");
  const text = v("--text", "#d7e0e6");
  return {
    background: "rgba(0,0,0,0)",
    foreground: text,
    cursor: accent,
    cursorAccent: v("--bg-0", "#090d11"),
    selectionBackground: hexA(accent, 0.22),
    selectionInactiveBackground: hexA(accent, 0.22),
    black: v("--bg-1", "#0d1218"),
    red: v("--danger", "#e08f8f"),
    green: v("--syn-string", "#9fce8f"),
    yellow: v("--syn-number", "#d4b57f"),
    blue: v("--syn-type", "#8fc7e0"),
    magenta: "#b48ead",
    cyan: accent,
    white: text,
    brightBlack: v("--text-faint", "#5b6c76"),
    brightRed: v("--danger", "#e08f8f"),
    brightGreen: v("--syn-string", "#9fce8f"),
    brightYellow: v("--syn-number", "#d4b57f"),
    brightBlue: v("--syn-type", "#8fc7e0"),
    brightMagenta: "#c9aed6",
    brightCyan: v("--accent-bright", "#a8e6e4"),
    brightWhite: "#eef4f7",
  };
}

export default function TermInstanceView({
  id,
  gen,
  cwd,
  shell,
  args,
  shellName,
  active,
  open,
  onTitle,
  onDead,
  onErr,
  onExit,
}: {
  id: number;
  gen: number;
  cwd?: string;
  shell?: string;
  args?: string[];
  shellName?: string;
  active: boolean;
  open: boolean;
  onTitle: (id: number, title: string) => void;
  onDead: (id: number, dead: boolean) => void;
  onErr: (id: number, err: string) => void;
  onExit?: (id: number) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const bootedRef = useRef(false);
  const aliveRef = useRef(false);
  const suppressExitRef = useRef(false);
  const hlRef = useRef<TermHighlighter | null>(null);
  const activeRef = useRef(active);
  const openRef = useRef(open);
  const roRafRef = useRef(0);
  const frameAtRef = useRef(0);
  const watchdogRef = useRef(0);
  const retriesRef = useRef(0);
  const fitNowRef = useRef<() => void>(() => {});
  const lastResizeRef = useRef<{ c: number; r: number }>({ c: 0, r: 0 });
  const pendingResizeRef = useRef<{ c: number; r: number } | null>(null);
  const resizeTimeoutRef = useRef<number>(0);
  const genRef = useRef(gen);
  const idRef = useRef(id);
  const cwdRef = useRef(cwd);
  const shellRef = useRef(shell);
  const argsRef = useRef(args);
  const spawnedGenRef = useRef<number | null>(null);

  const [deadLocal, setDeadLocal] = useState(false);
  const [errLocal, setErrLocal] = useState("");

  // keep refs in sync with props
  useEffect(() => { genRef.current = gen; }, [gen]);
  useEffect(() => { idRef.current = id; }, [id]);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  useEffect(() => { shellRef.current = shell; }, [shell]);
  useEffect(() => { argsRef.current = args; }, [args]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { openRef.current = open; }, [open]);
  // void to avoid unused warning for shellName prop (used only for display in parent)
  void shellName;

  const flushResize = useCallback(() => {
    const p = pendingResizeRef.current;
    if (!p || !aliveRef.current) return;
    if (p.c === lastResizeRef.current.c && p.r === lastResizeRef.current.r) {
      pendingResizeRef.current = null;
      return;
    }
    lastResizeRef.current = p;
    pendingResizeRef.current = null;
    void invoke("pty_resize", { id: idRef.current, cols: p.c, rows: p.r }).catch(() => {});
  }, []);

  const scheduleResize = useCallback((c: number, r: number) => {
    if (c < 2 || r < 2 || c > 1000 || r > 1000) return;
    pendingResizeRef.current = { c, r };
    window.clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = window.setTimeout(flushResize, 90) as unknown as number;
  }, [flushResize]);

  const spawn = useCallback(async () => {
    const curId = idRef.current;
    const curGen = genRef.current;
    if (spawnedGenRef.current === curGen && aliveRef.current) return;
    // background warm — allow spawn even when dock is hidden so opening is instant;
    // hidden spawn uses 80x24 fallback and is resized on next open (no GUI on launch to not disturb user)
    spawnedGenRef.current = curGen;
    setErrLocal("");
    onErr(curId, "");
    setDeadLocal(false);
    onDead(curId, false);
    termRef.current?.reset();
    const curCwd = cwdRef.current ?? "";
    // propose current xterm size so ConPTY is created at the right dimensions
    // and doesn't need an immediate resize (which would make PowerShell reprint the prompt)
    let cols = 0, rows = 0;
    try {
      const d = fitRef.current?.proposeDimensions();
      if (d && Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols >= 2 && d.rows >= 2 && d.cols <= 1000 && d.rows <= 1000) {
        cols = d.cols; rows = d.rows;
      }
    } catch {}
    // fall back to measuring the mount/body if fit not ready (e.g., first mount while hidden)
    const fallbackEl = mountRef.current ?? bodyRef.current;
    if ((!cols || !rows) && fallbackEl) {
      const el = fallbackEl;
      if (el.clientWidth >= 80 && el.clientHeight >= 60 && fitRef.current) {
        try {
          const d2 = fitRef.current.proposeDimensions();
          if (d2 && d2.cols >= 2 && d2.rows >= 2) { cols = d2.cols; rows = d2.rows; }
        } catch {}
      }
    }
    // background spawn (dock hidden) has no dimensions — use 80x24 so shell starts warm; resized on open
    if (!cols || !rows) { cols = 80; rows = 24; }
    try {
      const curShell = shellRef.current;
      const curArgs = argsRef.current ?? [];
      await invoke("pty_spawn", { id: curId, cwd: curCwd, gen: curGen, cols, rows, shell: curShell ?? null, args: curArgs.length ? curArgs : null, shell_args: null });
      aliveRef.current = true;
      if (cols && rows) lastResizeRef.current = { c: cols, r: rows };
      setTimeout(() => fitNowRef.current(), 60);
      frameAtRef.current = 0;
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = window.setTimeout(() => {
        if (frameAtRef.current !== 0 || !aliveRef.current) return;
        if (retriesRef.current >= 2) {
          const msg = "shell produced no output";
          setErrLocal(msg);
          onErr(curId, msg);
          return;
        }
        retriesRef.current += 1;
        console.error(`[term] no output id=${curId} gen=${curGen} — respawning via parent`);
        // parent will handle respawn via gen bump; just mark dead so UI shows
        setDeadLocal(true);
        onDead(curId, true);
      }, 5000);
    } catch (e) {
      aliveRef.current = false;
      const msg = e instanceof Error ? e.message : String(e);
      setErrLocal(msg);
      onErr(curId, msg);
    }
  }, [onDead, onErr]);

  const boot = useCallback(() => {
    if (bootedRef.current || !mountRef.current) return;
    bootedRef.current = true;
    const term = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: true,
      convertEol: true,
      theme: termTheme(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(mountRef.current);

    term.attachCustomKeyEventHandler((ev) => {
      // Ctrl+J is handled globally to hide terminal and focus chat — block it from reaching the shell
      if (ev.type === "keydown" && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === "j") return false;
      if (ev.type !== "keydown" || !ev.ctrlKey || !ev.shiftKey || ev.altKey) return true;
      const k = ev.key.toLowerCase();
      if (k === "c") {
        const sel = term.getSelection();
        if (!sel) return true;
        navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (k === "v") {
        navigator.clipboard.readText().then((t) => term.paste(t)).catch(() => {});
        return false;
      }
      return true;
    });

    term.onData((d) => {
      void invoke("pty_write", { id: idRef.current, data: d }).catch(() => {});
    });

    // title detection via xterm's parser (OSC 0/2)
    try {
      // @ts-ignore — onTitleChange exists in xterm 5.x
      if (typeof (term as any).onTitleChange === "function") {
        (term as any).onTitleChange((t: string) => {
          if (t && t.trim()) onTitle(idRef.current, t.trim());
        });
      }
    } catch {}

    hlRef.current = new TermHighlighter((s) => term.write(s));
  }, [onTitle]);

  // transport — filter by id+gen
  useEffect(() => {
    const unsubs = [
      listen<{ id: number; g: number; d: string }>("pty://frame", (e) => {
        if (e.payload.id !== idRef.current || e.payload.g !== genRef.current || !hlRef.current) return;
        const bin = atob(e.payload.d);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        frameAtRef.current = performance.now();
        // also scan raw bytes for OSC title as fallback (xterm may miss if highlighter consumes)
        // Do lightweight string scan on decoded text for fallback title
        try {
          const txt = new TextDecoder().decode(bytes);
          // OSC 0 / 2 title: \x1b]0;title\x07 or \x1b]2;title\x07 (BEL or ST \x1b\\)
          // BEL \x07 and ST \x1b\\ both terminate OSC
          const re = /\x1b\]0;([^\x07\x1b]*?)(?:\x07|\x1b\\)|\x1b\]2;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(txt)) !== null) {
            const title = (m[1] ?? m[2] ?? "").trim();
            if (title) {
              // avoid noisy full paths as titles? Keep as is — dock truncates
              onTitle(idRef.current, title);
              break; // only first per frame
            }
          }
        } catch {}
        hlRef.current.write(bytes);
      }),
      listen<{ id: number; g: number }>("pty://exit", (e) => {
        if (e.payload.id !== idRef.current || e.payload.g !== genRef.current || suppressExitRef.current) return;
        aliveRef.current = false;
        setDeadLocal(true);
        // exit via `exit` command should auto-close the instance; watchdog/err stays via onDead
        if (onExit) onExit(idRef.current);
        else onDead(idRef.current, true);
      }),
    ];
    return () => {
      for (const u of unsubs) u.then((f) => f()).catch(() => {});
    };
  }, [onDead, onTitle, onExit]);

  const fitNow = useCallback(() => {
    const el = mountRef.current ?? bodyRef.current;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!el || !fit || !term || !activeRef.current) return;
    if (el.clientHeight < 60 || el.clientWidth < 80) {
      if (openRef.current) requestAnimationFrame(() => fitNow());
      return;
    }
    if (el.clientWidth === 0 || el.clientHeight === 0) {
      if (openRef.current) requestAnimationFrame(() => fitNow());
      return;
    }
    let proposed: { cols: number; rows: number } | undefined;
    try { proposed = fit.proposeDimensions(); } catch { return; }
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows) || proposed.cols < 2 || proposed.rows < 2 || proposed.cols > 1000 || proposed.rows > 1000) return;
    try { fit.fit(); } catch { return; }
    try {
      const rows = term.rows ?? proposed.rows;
      term.refresh(0, Math.max(0, rows - 1));
    } catch {}
    // debounce the ConPTY resize — during the dock's height animation proposeDimensions
    // changes every frame (5→10→20→24 rows) and each distinct size would otherwise be sent
    // as a separate pty_resize, causing PowerShell/PSReadLine to reflow and reprint the prompt
    scheduleResize(proposed.cols, proposed.rows);
    requestAnimationFrame(() => {
      if (!activeRef.current || !bodyRef.current || !fitRef.current || !termRef.current) return;
      let second: { cols: number; rows: number } | undefined;
      try { second = fitRef.current.proposeDimensions(); } catch { return; }
      if (!second || (second.cols === proposed!.cols && second.rows === proposed!.rows)) return;
      if (second.cols < 2 || second.rows < 2 || second.cols > 1000 || second.rows > 1000) return;
      try {
        fitRef.current.fit();
        termRef.current?.refresh(0, Math.max(0, (termRef.current.rows ?? second.rows) - 1));
      } catch {}
      scheduleResize(second.cols, second.rows);
    });
  }, [scheduleResize]);
  fitNowRef.current = fitNow;

  // theme observer
  useEffect(() => {
    let raf = 0;
    const obs = new MutationObserver(() => {
      if (!termRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (termRef.current) termRef.current.options.theme = termTheme();
      });
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-mode"] });
    return () => { obs.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // boot + spawn — only when id/gen changes or dock opens (deferred initial spawn).
  // Stagger background terminals on app start so 3-4 ConPTYs don't jank the first paint.
  // Active terminal spawns via idle quickly; inactive ones are lazy until they become active (or via longer idle stagger).
  useEffect(() => {
    boot();
    const isReload = spawnedGenRef.current !== null && spawnedGenRef.current !== genRef.current;
    if (isReload) {
      // reload / shell switch — spawn promptly (still off critical paint)
      const t = window.setTimeout(() => void spawn(), 30);
      return () => window.clearTimeout(t);
    }
    if (!activeRef.current && !aliveRef.current) {
      // inactive background terminal — don't spawn yet; will spawn on active (see effect below) or via longer idle fallback
      const stagger = ((idRef.current % 4) * 240) + 600;
      const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: any) => number) | undefined;
      let idleId: number | undefined;
      let timeoutId: number | undefined;
      if (ric) {
        idleId = ric(() => { if (!aliveRef.current) void spawn(); }, { timeout: 1800 + stagger });
        // hard fallback in case idle never fires (e.g., page busy)
        timeoutId = window.setTimeout(() => { if (!aliveRef.current) void spawn(); }, 1600 + stagger) as unknown as number;
      } else {
        timeoutId = window.setTimeout(() => void spawn(), stagger) as unknown as number;
      }
      return () => {
        if (idleId !== undefined) (window as any).cancelIdleCallback?.(idleId);
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      };
    }
    // active terminal — spawn via idle so first paint isn't blocked
    const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: any) => number) | undefined;
    if (ric) {
      const idleId = ric(() => void spawn(), { timeout: 900 });
      return () => (window as any).cancelIdleCallback?.(idleId);
    } else {
      const t = window.setTimeout(() => void spawn(), 90) as unknown as number;
      return () => window.clearTimeout(t);
    }
  }, [boot, spawn, gen, id, open, active]);

  // inactive → active transition — ensure the terminal is running (covers lazy background case)
  useEffect(() => {
    if (active && !aliveRef.current && bootedRef.current) {
      void spawn();
    }
  }, [active, spawn]);

  // fit when becoming active — handles dock open animation and resizes
  useEffect(() => {
    if (!active) return;
    const dock = document.querySelector(".term-dock") as HTMLElement | null;
    let done = false;
    const doFit = () => { if (done) return; done = true; fitNow(); requestAnimationFrame(()=>fitNow()); };
    const onEnd = (e: TransitionEvent) => { if (e.propertyName === "height") doFit(); };
    dock?.addEventListener("transitionend", onEnd);
    const t1 = window.setTimeout(doFit, 280);
    const t2 = window.setTimeout(doFit, 550);
    // also fit immediately for the case where dock is already open
    doFit();
    return () => { dock?.removeEventListener("transitionend", onEnd); window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [active, fitNow]);

  // handle gen bump via reset — term.reset already in spawn, but also clear dead/err
  useEffect(() => {
    // when gen prop changes, reset suppress flag
    suppressExitRef.current = false;
  }, [gen]);

  // teardown only on unmount
  useEffect(() => () => {
    window.clearTimeout(watchdogRef.current);
    window.clearTimeout(resizeTimeoutRef.current);
    hlRef.current?.dispose();
    termRef.current?.dispose();
    void invoke("pty_kill", { id: idRef.current, gen: genRef.current }).catch(() => {});
  }, []);

  // resize observer — ResizeObserver on the mount covers window resizes too,
  // so no separate window resize listener needed (was double-firing with RO)
  useEffect(() => {
    const el = mountRef.current ?? bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (roRafRef.current) return;
      roRafRef.current = requestAnimationFrame(() => { roRafRef.current = 0; fitNow(); });
    });
    ro.observe(el);
    // also observe body when mount exists, to catch dock height animation that resizes body
    if (mountRef.current && bodyRef.current && mountRef.current !== bodyRef.current) {
      ro.observe(bodyRef.current);
    }
    const onDpr = () => {
      if (roRafRef.current) return;
      roRafRef.current = requestAnimationFrame(() => { roRafRef.current = 0; fitNow(); });
    };
    let mql: MediaQueryList | null = null;
    try { mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`); mql.addEventListener("change", onDpr); } catch {}
    return () => {
      ro.disconnect();
      try { mql?.removeEventListener("change", onDpr); } catch {}
      cancelAnimationFrame(roRafRef.current);
    };
  }, [fitNow]);

  // focus when becoming active — only when dock is visible to not steal focus on background warm
  useEffect(() => {
    if (active && open && termRef.current) setTimeout(() => termRef.current?.focus(), 50);
  }, [active, open]);

  // re-focus active terminal after OS window reactivation (Alt+Tab, Alt+Space, tray)
  // WebView2 loses DOM focus routing after hide/show; without this the first key after
  // refocus hits body → Windows beep → second key works. Mirrors the global
  // rescueFocus but guarantees the xterm helper textarea regains keyboard.
  useEffect(() => {
    if (!active) return;
    const refocus = () => {
      if (!activeRef.current || !openRef.current || !termRef.current) return;
      // only steal back focus if the last blur was from the terminal; otherwise
      // the user was in composer/editor and Alt+Tab should return there (global
      // rescue handles that). Marker is set by useGlobalShortcuts saveFocus.
      const wasTerm = !!(window as any).__oc_lastWasTerm;
      // also allow if current activeElement is already inside terminal (click case)
      const ae = document.activeElement as HTMLElement | null;
      const aeWasTerm = !!ae?.closest?.(".xterm, .term-dock, .term-body, .term-mount");
      if (!wasTerm && !aeWasTerm) return;
      // term.focus() is xterm's helper-textarea focus path; do it after OS settle
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          if (!activeRef.current || !openRef.current || !termRef.current) return;
          // re-check marker after settle — user may have clicked elsewhere in the meantime
          const stillTerm = !!(window as any).__oc_lastWasTerm;
          const curAe = document.activeElement as HTMLElement | null;
          const curAeTerm = !!curAe?.closest?.(".xterm, .term-dock");
          if (!stillTerm && !curAeTerm) return;
          try { termRef.current!.focus(); } catch {}
          // WebView2 poison fix can leave focus on outer HWND; ensure helper textarea is DOM-focused
          const helper = document.querySelector(
            ".term-dock:not(.closed) .xterm-helper-textarea",
          ) as HTMLElement | null;
          if (helper && document.activeElement !== helper) {
            try { helper.focus({ preventScroll: true } as any); } catch {}
          }
        }, 20);
      });
    };
    window.addEventListener("focus", refocus);
    let unRestore: (() => void) | undefined;
    let unVis: (() => void) | undefined;
    void listen("focus://restore", refocus).then((f) => { unRestore = f; }).catch(() => {});
    void listen<boolean>("visibility://changed", (e) => { if (e.payload) refocus(); }).then((f) => { unVis = f; }).catch(() => {});
    return () => {
      window.removeEventListener("focus", refocus);
      unRestore?.();
      unVis?.();
    };
  }, [active]);

  // allow Terminal dock to focus active terminal via Ctrl+J from composer
  useEffect(() => {
    const onFocusReq = () => { if (active && termRef.current) termRef.current.focus(); };
    window.addEventListener("oc:term-focus", onFocusReq as any);
    return () => window.removeEventListener("oc:term-focus", onFocusReq as any);
  }, [active]);

  // expose dead/err for dock's header? parent tracks via callbacks, but also keep local for potential future header per view
  void deadLocal; void errLocal;

  return (
    <div className="term-body" ref={bodyRef} style={{ display: active ? "flex" : "none", flex: 1, minHeight: 0 }} onMouseDown={() => { if (active && termRef.current) termRef.current.focus(); }}>
      <div className="term-mount" ref={mountRef} />
    </div>
  );
}
