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
  active,
  open,
  onTitle,
  onDead,
  onErr,
}: {
  id: number;
  gen: number;
  cwd?: string;
  active: boolean;
  open: boolean;
  onTitle: (id: number, title: string) => void;
  onDead: (id: number, dead: boolean) => void;
  onErr: (id: number, err: string) => void;
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
  const spawnedGenRef = useRef<number | null>(null);

  const [deadLocal, setDeadLocal] = useState(false);
  const [errLocal, setErrLocal] = useState("");

  // keep refs in sync with props
  useEffect(() => { genRef.current = gen; }, [gen]);
  useEffect(() => { idRef.current = id; }, [id]);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { openRef.current = open; }, [open]);

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
    // defer initial spawn until dock is actually visible — creating a ConPTY at 80x24
    // then immediately resizing to the real xterm size makes PowerShell reprint the prompt
    // (hence the duplicate PS …> on hide→show). We create with the correct size.
    if (!openRef.current && !aliveRef.current) return;
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
    // fall back to measuring the body if fit not ready (e.g., first mount while hidden)
    if ((!cols || !rows) && bodyRef.current) {
      const el = bodyRef.current;
      if (el.clientWidth >= 80 && el.clientHeight >= 60 && fitRef.current) {
        try {
          const d2 = fitRef.current.proposeDimensions();
          if (d2 && d2.cols >= 2 && d2.rows >= 2) { cols = d2.cols; rows = d2.rows; }
        } catch {}
      }
    }
    try {
      await invoke("pty_spawn", { id: curId, cwd: curCwd, gen: curGen, cols, rows });
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
      if (ev.type !== "keydown" || !ev.ctrlKey || !ev.shiftKey || ev.altKey) return true;
      const k = ev.key.toLowerCase();
      if (k === "c") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
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
          // Scan for patterns
          const re = /\x1b\]0;([^\x07\x1b]*)\x07|\x1b\]2;([^\x07\x1b]*)\x07/g;
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
        onDead(idRef.current, true);
      }),
    ];
    return () => {
      for (const u of unsubs) u.then((f) => f()).catch(() => {});
    };
  }, [onDead, onTitle]);

  const fitNow = useCallback(() => {
    const el = bodyRef.current;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!el || !fit || !term || !activeRef.current) return;
    if (el.clientHeight < 60 || el.clientWidth < 80) return;
    if (el.clientWidth === 0 || el.clientHeight === 0) return;
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

  // boot + spawn — only when id/gen changes or dock opens (deferred initial spawn)
  useEffect(() => {
    boot();
    void spawn();
  }, [boot, spawn, gen, id, open]);

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

  // resize observer
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (roRafRef.current) return;
      roRafRef.current = requestAnimationFrame(() => { roRafRef.current = 0; fitNow(); });
    });
    ro.observe(el);
    const onWin = () => {
      if (roRafRef.current) return;
      roRafRef.current = requestAnimationFrame(() => { roRafRef.current = 0; fitNow(); });
    };
    window.addEventListener("resize", onWin);
    let mql: MediaQueryList | null = null;
    try { mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`); mql.addEventListener("change", onWin); } catch {}
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWin);
      try { mql?.removeEventListener("change", onWin); } catch {}
      cancelAnimationFrame(roRafRef.current);
    };
  }, [fitNow]);

  // focus when becoming active
  useEffect(() => {
    if (active && termRef.current) setTimeout(() => termRef.current?.focus(), 50);
  }, [active]);

  // expose dead/err for dock's header? parent tracks via callbacks, but also keep local for potential future header per view
  void deadLocal; void errLocal;

  return (
    <div className="term-body" ref={bodyRef} style={{ display: active ? "flex" : "none", flex: 1, minHeight: 0 }}>
      <div className="term-mount" ref={mountRef} />
    </div>
  );
}
