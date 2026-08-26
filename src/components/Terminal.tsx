// bottom-dock terminal: xterm.js front-end over the Rust-owned ConPTY
// (src-tauri/src/pty.rs). This component stays mounted for the whole app
// lifetime — open/close only collapses the dock's height, so the shell,
// scrollback and running jobs survive hide/show. First open lazily creates
// the terminal and spawns the PTY.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { playSound } from "../lib/sounds";
import { TermHighlighter } from "../lib/termHighlight";
import "../styles/terminal.css";

const H_KEY = "oc.term.h";
const H_MIN = 120;
const H_DEFAULT = 240;

// monotonic PTY generation counter — module-scoped so it survives panel
// remounts (reload). See the note at genRef below.
let ptyGen = 0;

const clampH = (h: number) =>
  Math.min(Math.max(H_MIN, Math.floor(h)), Math.floor(window.innerHeight * 0.7));

// hex (#rrggbb) → rgba() with alpha — accents arrive as raw hex from tokens
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return "";
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

// ANSI palette follows the active theme's syntax tokens so ls/git/vim colors
// stay in-family; magenta has no token — one fixed tint that fits both modes
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
    // same 22% accent wash as ::selection in tokens.css (the CSS layer above
    // enforces it for the DOM renderer; these feed any other path)
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

export default function TerminalPanel({
  open,
  workspace,
  onClose,
  onReload,
}: {
  open: boolean;
  workspace?: string;
  onClose: () => void;
  onReload: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const bootedRef = useRef(false);
  const aliveRef = useRef(false);
  // intentional kills (respawn/workspace switch/restart) emit pty://exit too —
  // suppressed so they don't flip the header into "exited" state
  const suppressExitRef = useRef(false);
  const wsRef = useRef(workspace);
  const hlRef = useRef<TermHighlighter | null>(null);
  const openRef = useRef(open);
  const roRafRef = useRef(0);
  // session generation — every spawn bumps it; frames tagged with older
  // generations are dropped so dead shells can't bleed into this view.
  // MODULE-LEVEL on purpose: reload remounts this component, and a per-instance
  // counter would restart at 1 — making the old panel's teardown kill (gen 1)
  // collide with the fresh panel's first spawn (also gen 1) and kill it.
  const genRef = useRef(ptyGen);
  // last frame timestamp + watchdog id — used to detect a shell that spawned
  // but never delivers output (Windows ConPTY quirk after a respawn) so we can
  // self-heal with one kill+respawn instead of leaving a dead cursor
  const frameAtRef = useRef(0);
  const watchdogRef = useRef(0);
  const retriesRef = useRef(0);
  // set after killAndRespawn is defined — breaks the spawn↔respawn cycle
  const respawnRef = useRef<() => void>(() => {});

  const [h, setH] = useState(() => clampH(Number(localStorage.getItem(H_KEY)) || 240));
  const [dead, setDead] = useState(false);
  const [err, setErr] = useState("");
  const [dragging, setDragging] = useState(false);

  const spawn = useCallback(async () => {
    setErr("");
    setDead(false);
    // fresh shell → fresh screen; without this a respawn appends its banner
    // onto whatever the previous session left in the buffer
    termRef.current?.reset();
    const gen = ++ptyGen;
    genRef.current = gen;
    try {
      await invoke("pty_spawn", { cwd: wsRef.current ?? "", gen });
      aliveRef.current = true;
      // self-heal watchdog: if the shell never delivers a frame within 5s,
      // kill it and respawn once — a wedged ConPTY otherwise leaves a dead
      // cursor forever
      frameAtRef.current = 0;
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = window.setTimeout(() => {
        if (frameAtRef.current !== 0 || !aliveRef.current) return;
        if (retriesRef.current >= 2) {
          setErr("shell produced no output");
          return;
        }
        retriesRef.current += 1;
        console.error(`[term] no output for gen=${gen} — respawning`);
        respawnRef.current();
      }, 5000);
    } catch (e) {
      aliveRef.current = false;
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
    }
  }, []);

  // kill the current session without respawning — used on panel close (the
  // app deliberately keeps no background shells) and as half of respawn flows
  const killSession = useCallback(async () => {
    suppressExitRef.current = true;
    window.clearTimeout(watchdogRef.current);
    const gen = genRef.current; // the live session's gen — pty_kill is gen-tagged
    ++ptyGen; // any frames the dying shell still emits get dropped
    genRef.current = ptyGen;
    await invoke("pty_kill", { gen }).catch(() => {});
    termRef.current?.reset();
    aliveRef.current = false;
    setTimeout(() => {
      suppressExitRef.current = false;
    }, 600);
  }, []);

  // intentional kills emit pty://exit too (kill→respawn races the EOF);
  // suppression stays armed briefly past the respawn so the dead session's
  // exit can't flip the header into "exited" state
  const killAndRespawn = useCallback(async () => {
    await killSession();
    await spawn();
  }, [killSession, spawn]);
  respawnRef.current = killAndRespawn;

  // one-time boot on first open. NO cleanup on close — the whole point is
  // that hide/show leaves the shell running; teardown lives in the
  // mount-only effect below
  const boot = useCallback(() => {
    if (bootedRef.current || !mountRef.current) return;
    bootedRef.current = true;

    const term = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: true,
      theme: termTheme(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(mountRef.current);

    // Ctrl+Shift+C/V clipboard — plain Ctrl+C keeps its SIGINT meaning
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
      void invoke("pty_write", { data: d }).catch(() => {});
    });

    // output filter: plain-text code lines get colored, ANSI/control data
    // passes raw. Frames arrive via the mount-once transport below and land
    // here through hlRef, so reloads swap the filter without rewiring
    hlRef.current = new TermHighlighter((s) => term.write(s));
    // the shell itself is spawned by the open/close effect — boot only
    // builds the renderer
  }, []);

  // transport wiring — mount-once, survives reloads/workspace switches.
  // Generation-tagged frames from superseded shells are dropped here, which
  // is what keeps a slow-dying PowerShell's banner out of the current view
  useEffect(() => {
    const unsubs = [
      listen<{ g: number; d: string }>("pty://frame", (e) => {
        if (e.payload.g !== genRef.current || !hlRef.current) return;
        const bin = atob(e.payload.d);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        frameAtRef.current = performance.now();
        hlRef.current.write(bytes);
      }),
      listen<{ g: number }>("pty://exit", (e) => {
        if (e.payload.g !== genRef.current || suppressExitRef.current) return;
        aliveRef.current = false;
        setDead(true);
      }),
    ];
    return () => {
      for (const u of unsubs) u.then((f) => f()).catch(() => {});
    };
  }, []);

  // single resize entry point: RO-debounced via rAF, gated on visibility,
  // rejecting degenerate measurements BEFORE they reach xterm/ConPTY — once
  // applied, bad dims corrupt the renderer grid until a full reload
  const fitNow = useCallback(() => {
    const el = bodyRef.current;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!el || !fit || !term || !openRef.current) return;
    if (el.clientHeight < 60 || el.clientWidth < 80) return;
    let next: { cols: number; rows: number } | undefined;
    try {
      next = fit.proposeDimensions();
    } catch {
      return;
    }
    if (
      !next ||
      !Number.isFinite(next.cols) ||
      !Number.isFinite(next.rows) ||
      next.cols < 2 ||
      next.rows < 2 ||
      next.cols > 1000 ||
      next.rows > 1000
    )
      return;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (aliveRef.current)
      invoke("pty_resize", { cols: next.cols, rows: next.rows }).catch(() => {});
  }, []);

  // full rebuild is delegated to the parent via a key bump: React unmounts
  // this panel (teardown effect kills the PTY, listeners unsubscribe) and
  // mounts a fresh one that boots xterm and spawns a new shell exactly like
  // first open — no in-place dispose/reboot races to reason about
  const reloadTerm = useCallback(() => {
    playSound("click");
    onReload();
  }, [onReload]);

  // theme applications write the palette as inline CSS vars / data attrs on
  // <html> — watch instead of guessing when. This covers every path: the
  // late async themes.json load at app start (the terminal boots before it
  // lands), dropdown switches, /scheme mode toggles and hot-reloaded file
  // edits (which also emit themes://changed — same applyTheme, same attrs)
  useEffect(() => {
    let raf = 0;
    const obs = new MutationObserver(() => {
      if (!termRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (termRef.current) termRef.current.options.theme = termTheme();
      });
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "data-theme", "data-mode"],
    });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      // policy: no background shells — hiding the panel kills the session;
      // reopening spawns a fresh one at the same cwd
      if (bootedRef.current && aliveRef.current) void killSession();
      return;
    }
    boot();
    // spawn when the renderer is new or the shell died (closed, exited, error)
    if (!aliveRef.current) void spawn();
    // one final fit after the open transition settles
    setTimeout(() => fitNow(), 300);
  }, [open, boot, killSession, spawn]);

  // full teardown only when the app/page itself goes away
  useEffect(
    () => () => {
      window.clearTimeout(watchdogRef.current);
      hlRef.current?.dispose();
      termRef.current?.dispose();
      // gen-tagged: on a reload remount this fires against the old session's
      // gen, so it can't kill the fresh session the new panel just spawned
      void invoke("pty_kill", { gen: genRef.current }).catch(() => {});
    },
    [],
  );

  // container resizes (panel drag, window resize, open/close collapse) drive
  // both the renderer grid and the PTY size — coalesced to one fit per frame
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (roRafRef.current) return;
      roRafRef.current = requestAnimationFrame(() => {
        roRafRef.current = 0;
        fitNow();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(roRafRef.current);
    };
  }, [fitNow]);

  // workspace switch: cwd is baked into the ConPTY at spawn → fresh shell.
  // Scrollback dies with it (reset), which matches the mental model of
  // opening a terminal in another folder
  useEffect(() => {
    const prev = wsRef.current;
    wsRef.current = workspace;
    if (!bootedRef.current || prev === workspace) return;
    void killAndRespawn();
  }, [workspace, killAndRespawn]);

  // opening focuses so keystrokes land immediately; closing returns nothing
  useEffect(() => {
    if (open && termRef.current) setTimeout(() => termRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    localStorage.setItem(H_KEY, String(h));
  }, [h]);

  // vertical twin of the sidebar drag: pull up to grow, native cursors
  // locked on body, sound ticks throttled like ChatPage's resize
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = h;
      let lastTick = 0;
      setDragging(true);
      document.body.classList.add("resizing");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      const move = (ev: MouseEvent) => {
        setH(clampH(startH + (startY - ev.clientY)));
        const now = performance.now();
        if (now - lastTick > 70) {
          lastTick = now;
          playSound("resize");
        }
      };
      const up = () => {
        setDragging(false);
        document.body.classList.remove("resizing");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("blur", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      window.addEventListener("blur", up);
    },
    [h],
  );

  // double-click on the handle or header snaps back to the default height
  const resetSize = useCallback(() => {
    setH(H_DEFAULT);
    playSound("click");
  }, []);

  return (
    <div
      className={`term-dock${open ? "" : " closed"}${dragging ? " dragging" : ""}`}
      style={{ height: open ? h : 0 }}
    >
      <div
        className="term-resize"
        data-tip="Drag to resize · double-click to reset"
        onMouseDown={startResize}
        onDoubleClick={resetSize}
      />
      <div
        className="term-head"
        onDoubleClick={(e) => {
          // buttons own their clicks — don't reset when mashing close/restart
          if (!(e.target as HTMLElement).closest("button")) resetSize();
        }}
      >
        <i className="fa-solid fa-terminal" />
        <span>terminal</span>
        {err && <span className="term-err">{err}</span>}
        {dead && !err && <span className="term-dead">exited</span>}
        <span className="term-spacer" />
        <button className="icon-btn term-btn" data-tip="Reload terminal" onClick={reloadTerm}>
          <i className="fa-solid fa-sync" />
        </button>
        <button className="icon-btn close term-btn" data-tip="Hide panel" onClick={onClose}>
          <i className="fa-solid fa-chevron-down" />
        </button>
      </div>
      <div className="term-body" ref={bodyRef}>
        <div className="term-mount" ref={mountRef} />
      </div>
    </div>
  );
}
