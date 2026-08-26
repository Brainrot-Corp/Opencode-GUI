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
import "../styles/terminal.css";

const H_KEY = "oc.term.h";
const H_MIN = 120;

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
    selectionBackground: hexA(accent, 0.24),
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
}: {
  open: boolean;
  workspace?: string;
  onClose: () => void;
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
  const unsubsRef = useRef<Promise<() => void>[]>([]);
  const wsRef = useRef(workspace);

  const [h, setH] = useState(() => clampH(Number(localStorage.getItem(H_KEY)) || 240));
  const [dead, setDead] = useState(false);
  const [err, setErr] = useState("");
  const [dragging, setDragging] = useState(false);

  const spawn = useCallback(async () => {
    setErr("");
    setDead(false);
    try {
      await invoke("pty_spawn", { cwd: wsRef.current ?? "" });
      aliveRef.current = true;
    } catch (e) {
      aliveRef.current = false;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const restart = useCallback(() => {
    playSound("click");
    termRef.current?.reset();
    void spawn();
  }, [spawn]);

  // intentional kills emit pty://exit too (kill→respawn races the EOF);
  // suppression stays armed briefly past the respawn so the dead session's
  // exit can't flip the header into "exited" state
  const killAndRespawn = useCallback(async () => {
    suppressExitRef.current = true;
    await invoke("pty_kill").catch(() => {});
    termRef.current?.reset();
    await spawn();
    setTimeout(() => {
      suppressExitRef.current = false;
    }, 600);
  }, [spawn]);

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

    unsubsRef.current = [
      listen<string>("pty://out", (e) => {
        const bin = atob(e.payload);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        term.write(bytes);
      }),
      listen("pty://exit", () => {
        if (suppressExitRef.current) return;
        aliveRef.current = false;
        setDead(true);
      }),
    ];

    void spawn();
  }, [spawn]);

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
    if (open) boot();
  }, [open, boot]);

  // full teardown only when the app/page itself goes away
  useEffect(
    () => () => {
      for (const u of unsubsRef.current) u.then((f) => f()).catch(() => {});
      unsubsRef.current = [];
      termRef.current?.dispose();
      void invoke("pty_kill").catch(() => {});
    },
    [],
  );

  // container resizes (panel drag, window resize, open/close collapse) drive
  // both the renderer grid and the PTY size
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const fit = fitRef.current;
      const term = termRef.current;
      if (!fit || !term || el.clientHeight < 40) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (aliveRef.current)
        invoke("pty_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  return (
    <div
      className={`term-dock${open ? "" : " closed"}${dragging ? " dragging" : ""}`}
      style={{ height: open ? h : 0 }}
    >
      <div className="term-resize" data-tip="Drag to resize" onMouseDown={startResize} />
      <div className="term-head">
        <i className="fa-solid fa-terminal" />
        <span>terminal</span>
        {err && <span className="term-err">{err}</span>}
        <span className="term-spacer" />
        {(dead || err) && (
          <button className="icon-btn term-btn" data-tip="Restart shell" onClick={restart}>
            <i className="fa-solid fa-rotate-right" />
          </button>
        )}
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
