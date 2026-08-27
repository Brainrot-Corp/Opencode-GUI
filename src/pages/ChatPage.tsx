import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Titlebar from "../components/Titlebar";
import Sidebar from "../components/Sidebar";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import PermissionBar from "../components/PermissionBar";
import QuestionPopup from "../components/QuestionPopup";
import BrowserBar, { BROWSER_BAR_H } from "../components/BrowserBar";
import SettingsDrawer from "../components/SettingsDrawer";
import Onboarding from "../components/Onboarding";
import UpdatePrompt from "../components/UpdatePrompt";
import { useUpdater } from "../hooks/useUpdater";
import DiffPanel from "../components/DiffPanel";
import FileEditorHost from "../components/FileEditorHost";
import TerminalPanel from "../components/Terminal";
import TooltipLayer from "../components/TooltipLayer";
import { HelpDialog, ShareDialog, VariantsDialog } from "../components/CommandDialog";
import { useOpencode } from "../hooks/useOpencode";
import { useSettings } from "../hooks/useSettings";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { useVoice } from "../hooks/useVoice";
import { routeVoice, routerInput, type VoiceAct } from "../lib/voiceRouter";
import { ensureDict } from "../lib/dictWords";
import { pickWorkspace } from "../lib/workspace";
import { playSound } from "../lib/sounds";
import { useSpeech } from "../hooks/useSpeech";
import { usePlugins } from "../hooks/usePlugins";
import { loadPluginsCatalog } from "../lib/pluginsCatalog";

const SB_W_KEY = "oc.sb.w";
const SB_C_KEY = "oc.sb.c";

export default function ChatPage() {
  const oc = useOpencode();
  const {
    settings,
    update,
    updatePlugin,
    updateSounds,
    updateColors,
    resetColors,
    themes,
    themeError,
    activeModes,
    effectiveMode,
    colorsFor,
  } = useSettings();
  // runtime plugins — voice intents, sidebar/titlebar widgets, overlays, error banner
  const { plugins, exts, sidebarWidgets, titlebarItems, overlays, error: pluginError, toggleEnabled, removeDisabled } = usePlugins();
  // spoken replies / narration / debrief — the whole piper voice pipeline
  const { talking, debriefing, announce, pauseSpeech } = useSpeech(
    { msgs: oc.msgs, busy: oc.busy, permission: oc.permission, providers: oc.providers },
    settings,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  // file > diff > busy > idle — discord plugin reads editingFile/diffOpen for {status}
  const [editingFile, setEditingFile] = useState("");
  useEffect(() => {
    const onFileEdit = (ev: Event) => setEditingFile((ev as CustomEvent<{ path?: string }>).detail?.path || "");
    window.addEventListener("oc:file-editor", onFileEdit);
    return () => window.removeEventListener("oc:file-editor", onFileEdit);
  }, []);
  // presence live snapshot for plugins (discord etc.) — always mirrored to window
  useEffect(() => {
    const ws = settings.workspace;
    const model = oc.modelSel || oc.defaultModel || "";
    (window as any).__presence = {
      workspace: ws,
      workspaceName: ws ? ws.split(/[/\\]/).filter(Boolean).pop() || ws : "",
      model,
      busy: oc.busy,
      sessionId: oc.activeId || "",
      sessionTitle: oc.sessions.find((s) => s.id === oc.activeId)?.title || "",
      editingFile,
      diffOpen,
    };
  }, [settings.workspace, oc.modelSel, oc.defaultModel, oc.busy, oc.activeId, oc.sessions, editingFile, diffOpen]);
  // terminal dock visibility (height lives inside TerminalPanel)
  const [termOpen, setTermOpen] = useState(
    () => localStorage.getItem("oc.term.open") === "1",
  );
  // reload = full remount (bumped by the panel's reload button); a fresh mount
  // boots xterm + spawns a shell exactly like first open — no in-place rebuild
  const [termKey, setTermKey] = useState(0);
  // first-launch setup wizard — any close records the flag so it shows once
  const [onboardOpen, setOnboardOpen] = useState(
    () => localStorage.getItem("oc.onboarded") !== "1",
  );
  // auto-update prompt — single shared updater for the whole app
  const upd = useUpdater();
  const [updDismissed, setUpdDismissed] = useState(
    () => localStorage.getItem("oc.update.dismissed") || "",
  );
  const [debugUpdateForced, setDebugUpdateForced] = useState(false);

  const [sbW, setSbW] = useState(() => {
    const w = Number(localStorage.getItem(SB_W_KEY)) || 248;
    return Math.min(Math.max(170, w), 440);
  });
  const [sbClosed, setSbClosed] = useState(() => localStorage.getItem(SB_C_KEY) === "1");
  const [resizing, setResizing] = useState(false);
  const [browserTop, setBrowserTop] = useState<number | null>(null);
  const toggleDiff = useCallback(() => setDiffOpen((v) => !v), []);
  const openSettingsDrawer = useCallback(() => setSettingsOpen(true), []);

  // Ctrl(+Shift+)Tab — walk the sidebar list (recency order), looping at both ends
  const cycleSessions = useCallback(
    (dir: 1 | -1) => {
      const list = oc.sessions;
      if (!list.length) return;
      const i = list.findIndex((s) => s.id === oc.activeId);
      void oc.openSession(list[i < 0 ? 0 : (i + dir + list.length) % list.length].id);
    },
    [oc.sessions, oc.activeId, oc.openSession],
  );

  // Ctrl+W close active session — empty sessions go instantly, non-empty need
  // a second Ctrl+W within 1s (banner shows while armed)
  const [closeHint, setCloseHint] = useState(false);
  const closeArm = useRef(0);
  const closeTimer = useRef(0);
  const closeActiveSession = useCallback(() => {
    const id = oc.activeId;
    if (!id) return;
    if (!oc.msgs.some((m) => m.info.role === "user")) {
      void oc.removeSession(id);
      return;
    }
    if (Date.now() - closeArm.current < 1000) {
      clearTimeout(closeTimer.current);
      closeArm.current = 0;
      setCloseHint(false);
      playSound("close");
      void oc.removeSession(id);
    } else {
      closeArm.current = Date.now();
      setCloseHint(true);
      playSound("click");
      clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => {
        closeArm.current = 0;
        setCloseHint(false);
      }, 1000);
    }
  }, [oc.activeId, oc.msgs, oc.removeSession]);

  // browser bar band = titlebar bottom + bar height; the child webview starts
  // right below the bar
  function barTop() {
    const tb = document.querySelector(".titlebar") as HTMLElement | null;
    return (tb?.offsetHeight ?? 42) + BROWSER_BAR_H;
  }

  // open (or navigate) the embedded browser; the chrome strip renders in the
  // band between titlebar and webview
  const openBrowser = useCallback((url: string) => {
    const top = barTop();
    invoke("browser_open", { url, top })
      .then(() => setBrowserTop(top))
      .catch(() => {});
  }, []);

  const toggleSidebar = useCallback(() => {
    // directional sound — mirrors the sidebar buttons (collapse/expand)
    setSbClosed((v) => {
      playSound(v ? "expand" : "collapse");
      return !v;
    });
  }, []);

  const { stopArmed, clearStopArmed } = useGlobalShortcuts({
    settings,
    update,
    openBrowser,
    toggleDiff,
    openSettings: openSettingsDrawer,
    abort: oc.abort,
    busy: oc.busy,
    themeIds: themes.map((t) => t.id),
    activeModes,
    onCycleSessions: cycleSessions,
    onCloseSession: closeActiveSession,
    onToggleTerm: () => setTermOpen((v) => !v),
    onToggleSidebar: toggleSidebar,
    onOpenWorkspace: () => void pickWorkspace(),
  });

  // spoken rendering of a voice act — used to read embedded commands back
  // before they run
  const extById = useMemo(
    () => Object.fromEntries(plugins.filter((p) => p.ext).map((p) => [p.id, p.ext!])),
    [plugins],
  );
  // plugin documentation rows for the Info dialog
  const pluginDocs = useMemo(
    () => plugins.flatMap((p) => (p.ext?.info ? [{ name: p.name, info: p.ext.info }] : [])),
    [plugins],
  );
  const describeAct = useCallback((a: VoiceAct): string => {
    switch (a.type) {
      case "launchApp":
        return `Open ${a.arg}`;
      case "closeApp":
        return `Close ${a.arg}`;
      case "minimizeApp":
        return `Minimize ${a.arg}`;
      case "killApp":
        return `Force-close ${a.arg}`;
      case "newSession":
        return "Start a new session";
      case "abort":
        return "Stop generating";
      case "theme":
        return `Switch to the ${a.arg} theme`;
      case "mode":
        return `Switch to ${a.arg} mode`;
      case "settings":
        return a.open ? "Open settings" : "Close settings";
      case "sidebar":
        return `${a.open === true ? "Show" : a.open === false ? "Hide" : "Toggle"} the sidebar`;
      case "cycleAgent":
        return "Switch agents";
      case "runCmd":
        return `Run /${a.arg}`;
      case "send":
        return "Send the draft";
      case "clear":
        return "Clear the composer";
      case "quiet":
      case "shut":
        return "Stop speaking";
      case "debrief":
        return "Run a debrief";
      case "hearCheck":
        return "Check the mic";
      case "git":
        return a.act === "open"
          ? "Show the git panel"
          : a.act === "commit"
            ? "Commit the staged changes"
            : a.act === "push"
              ? "Push to the remote"
              : a.act === "pull"
                ? "Pull from the remote"
                : "Stage all changes";
      case "dictate":
        return `Add "${a.arg}" to the composer`;
      case "dictateSend":
        return `Send "${a.arg}"`;
      case "plugin":
        return extById[a.plugin]?.describe?.(a.act) ?? "";
      default:
        return "";
    }
  }, [extById]);

  // executes a fully-routed voice act (direct hits and confirmed embeddeds)
  const lastExecRef = useRef(0);
  const execAct = useCallback(
    (act: VoiceAct) => {
      lastExecRef.current = Date.now();
      switch (act.type) {
        case "newSession":
          void oc.newSession();
          break;
        case "abort":
          void oc.abort();
          break;
        case "theme":
          update({ theme: act.arg });
          break;
        case "mode":
          update({ mode: act.arg });
          break;
        case "settings":
          act.open ? openSettingsDrawer() : closeSettings();
          break;
        case "sidebar":
          setSbClosed((v) => (act.open === undefined ? !v : !act.open));
          break;
        case "cycleAgent":
          oc.cycleAgent();
          break;
        case "runCmd":
          void oc.submit(act.rest ? `/${act.arg} ${act.rest}` : `/${act.arg}`);
          break;
        case "launchApp":
          invoke<string>("open_app", { name: act.arg })
            .then((app) => announce(`Opening ${app}.`))
            .catch(() => announce(`Couldn't find ${act.arg}.`));
          break;
        case "closeApp":
        case "minimizeApp":
        case "killApp": {
          const verb =
            act.type === "closeApp"
              ? "Closing"
              : act.type === "minimizeApp"
                ? "Minimizing"
                : "Killing";
          invoke<string>("window_app", {
            name: act.arg,
            action: act.type === "killApp" ? "kill" : act.type === "closeApp" ? "close" : "minimize",
          })
            .then((app) => announce(`${verb} ${app}.`))
            .catch(() => announce(`Couldn't find ${act.arg}.`));
          break;
        }
        case "send":
          window.dispatchEvent(new Event("oc:voice-send"));
          break;
        case "dictate":
          window.dispatchEvent(new CustomEvent("oc:voice-text", { detail: act.arg }));
          break;
        case "dictateSend":
          window.dispatchEvent(new CustomEvent("oc:voice-send-text", { detail: act.arg }));
          break;
        case "clear":
          window.dispatchEvent(new Event("oc:voice-clear"));
          break;
        case "quiet":
          pauseSpeech();
          break;
        case "shut":
          window.dispatchEvent(new Event("oc:tts-stop"));
          break;
        case "debrief":
          window.dispatchEvent(new Event("oc:debrief"));
          break;
        case "hearCheck":
          announce("Loud and clear.");
          break;
        case "git":
          window.dispatchEvent(new CustomEvent("oc:git", { detail: act.act }));
          break;
        case "plugin": {
          const ext = extById[act.plugin];
          if (!ext?.exec) break;
          Promise.resolve(ext.exec(act.act))
            .then((msg) => {
              if (msg) announce(msg);
            })
            .catch((e) => announce(e instanceof Error ? e.message : String(e)));
          break;
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, oc.cmdList, extById],
  );

  // embedded-command confirmation: a command found buried in conversation is
  // read back and waits for a spoken yes/no. Any other speech (or 15s)
  // cancels — chatter can't leave stale traps.
  const pendingRef = useRef<{ act: VoiceAct; until: number } | null>(null);
  // guards the async translate fallback: newer speech invalidates an
  // in-flight re-route
  const seqRef = useRef(0);
  // warm the typo-corrector's dictionary veto once per launch
  useEffect(() => {
    void ensureDict();
  }, []);
  // prefetch plugin catalog on launch — warms 12h cache so Browse opens instantly (force refresh still bypasses)
  useEffect(() => {
    void loadPluginsCatalog().catch(() => {});
  }, []);
  // debug transcript mode (Settings › Voice): last few utterance audits
  const [vdbg, setVdbg] = useState<string[]>([]);
  const dbgPush = useCallback(
    (s: string) => setVdbg((d) => [...d.slice(-4), s]),
    [],
  );
  // visible confirmation for voice yes/no outcomes — works even when TTS is
  // off (announce() is speech-gated); reuses the voice-debug box styling
  const [vnote, setVnote] = useState("");
  const vnoteTimer = useRef(0);
  const confirmNote = useCallback((s: string) => {
    setVnote(s);
    clearTimeout(vnoteTimer.current);
    vnoteTimer.current = window.setTimeout(() => setVnote(""), 2600);
  }, []);
  const handleVoiceTranscript = useCallback(
    (text: string) => {
      const p = pendingRef.current;
      if (p && Date.now() < p.until) {
        if (settings.voice.debug) dbgPush(`"${text}" → consumed by yes/no prompt`);
        const t0 = text.toLowerCase().replace(/[.,!?;:]+$/, "").trim();
        // yes/no in EN/FR/ES — "si" matches Spanish sí (whisper drops accents)
        if (/^(yes|yeah|yep|yup|sure|do it|confirm|go ahead|oui|ouais|ouep|vas-?y|si|sí|claro|dale|vale)\b/.test(t0)) {
          pendingRef.current = null;
          playSound("click");
          const d = describeAct(p.act);
          const acks = ["Done.", "You got it.", "On it.", "Sure thing."];
          const ack = acks[Math.floor(Math.random() * acks.length)];
          announce(ack);
          confirmNote(`✓ ${d || ack}`);
          execAct(p.act);
        } else if (/^(no|nope|nah|cancel|forget it|non|annule|annuler|anula|cancela)\b/.test(t0)) {
          pendingRef.current = null;
          const nos = ["No problem.", "Okay, skipping that.", "Cancelled."];
          announce(nos[Math.floor(Math.random() * nos.length)]);
          confirmNote("✗ Cancelled");
        } else {
          pendingRef.current = null; // unrelated chatter kills the question
        }
        return;
      }
      pendingRef.current = null;

      const routeCtx = () => ({
        themes: themes.map((t) => t.id),
        commands: oc.cmdList.map((c) => c.name),
        exts,
      });
      // executes a routed act — shared by the native and translated paths
      const dispatch = (act: VoiceAct) => {
        playSound("click");
        if (act.type === "embedded") {
          // active session: a command ran recently → trust the streak, skip
          // the read-back (25s window). Fuzzy matches (command + trailing
          // clause) always read back — they're only probable.
          if (!act.fuzzy && Date.now() - lastExecRef.current < 25000) {
            execAct(act.act);
            return;
          }
          pendingRef.current = { act: act.act, until: Date.now() + 15000 };
          // natural read-back: "Okay — turn the lights off?"
          const d = describeAct(act.act);
          announce(`Okay — ${d.charAt(0).toLowerCase()}${d.slice(1)}?`);
          return;
        }
        execAct(act);
      };

      const act = routeVoice(text, routeCtx());
      if (settings.voice.debug)
        dbgPush(
          `"${text}" → "${routerInput(text)}" → ${
            act ? JSON.stringify(act) : "no match · dictation"
          }`,
        );
      if (act) {
        dispatch(act);
        return;
      }
      // no match — the utterance may be in another language: one retry
      // through whisper's translate task before giving up to dictation.
      // Sequence token discards the result if newer speech arrived meanwhile
      if (settings.voice.multilingual) {
        const seq = ++seqRef.current;
        void retranslateRef.current?.().then((en) => {
          if (!en || seq !== seqRef.current) return;
          const act2 = routeVoice(en, routeCtx());
          if (settings.voice.debug)
            dbgPush(
              `[en] "${en}" → ${act2 ? JSON.stringify(act2) : "no match · dictation"}`,
            );
          if (act2) dispatch(act2);
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, oc.cmdList, exts, execAct, describeAct, settings.voice.debug, settings.voice.multilingual, dbgPush],
  );

  const voice = useVoice(
    handleVoiceTranscript,
    settings.voice.model,
    settings.voice.handsFree,
    settings.voice.sens,
  );
  // handler runs before useVoice returns — reach retranslate through a ref
  const retranslateRef = useRef<(() => Promise<string | null>) | null>(null);
  retranslateRef.current = voice.retranslate;

  // Ctrl+M toggles the mic — same path as clicking the composer button
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        voice.toggle();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [voice.toggle]);

  // global Ctrl+Shift+M (Rust-registered) reaches here even when unfocused;
  // different combo from Ctrl+M so both can't fire for one press.
  // registered ONCE, calling through a ref: re-registering on every toggle
  // identity change leaks listeners whenever cleanup runs before the async
  // listen() resolves (StrictMode remount) — the stale copy then always sees
  // phase "idle" and restarts the mic instead of stopping it
  const toggleRef = useRef(voice.toggle);
  toggleRef.current = voice.toggle;
  useEffect(() => {
    const p = listen("mic://toggle", () => toggleRef.current());
    return () => {
      p.then((f) => f()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SB_W_KEY, String(sbW));
  }, [sbW]);
  useEffect(() => {
    localStorage.setItem(SB_C_KEY, sbClosed ? "1" : "0");
  }, [sbClosed]);
  useEffect(() => {
    localStorage.setItem("oc.term.open", termOpen ? "1" : "0");
  }, [termOpen]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sbW;
      let lastTick = 0;
      setResizing(true);
      // body.resizing lets CSS force the custom col-resize cursor over every
      // descendant cursor rule (panels/buttons/editors all declare their own)
      document.body.classList.add("resizing");
      document.body.style.userSelect = "none";
      const move = (ev: MouseEvent) => {
        setSbW(Math.min(Math.max(170, startW + (ev.clientX - startX)), 440));
        const now = performance.now();
        if (now - lastTick > 70) {
          lastTick = now;
          playSound("resize");
        }
      };
      const up = () => {
        setResizing(false);
        document.body.classList.remove("resizing");
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("blur", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      // hiding/minimizing mid-drag eats the mouseup — end the drag on blur
      window.addEventListener("blur", up);
    },
    [sbW],
  );

  function openSettings() {
    playSound("expand");
    setSettingsOpen(true);
  }

  function closeSettings() {
    playSound("collapse");
    setSettingsOpen(false);
  }

  const debugUpdateInfo = debugUpdateForced
    ? {
        version: "9.9.9",
        notes: "Debug preview — this is how the update prompt looks. No download will start.",
        url: "",
        sha256: "",
      }
    : null;

  const showUpdatePrompt =
    !onboardOpen &&
    (!!debugUpdateInfo ||
      (settings.updateNotifications && !!upd.latest && upd.latest.version !== updDismissed));

  const promptInfo = debugUpdateInfo ?? upd.latest;

  function handleUpdateDismiss(disable: boolean) {
    if (debugUpdateForced) {
      setDebugUpdateForced(false);
      if (disable) update({ updateNotifications: false });
      return;
    }
    if (disable) {
      update({ updateNotifications: false });
    } else if (upd.latest) {
      localStorage.setItem("oc.update.dismissed", upd.latest.version);
      setUpdDismissed(upd.latest.version);
    } else {
      setUpdDismissed("1");
    }
  }

  function handleDebugUpdate() {
    if (upd.latest) {
      localStorage.removeItem("oc.update.dismissed");
      setUpdDismissed("");
      setDebugUpdateForced(false);
    } else {
      setDebugUpdateForced(true);
    }
  }



  return (
    <>
      <div className="noise" aria-hidden="true" />
      <TooltipLayer />
      {browserTop !== null && (
        <BrowserBar top={browserTop} onClose={() => setBrowserTop(null)} />
      )}
      <div className="app">
        <Titlebar
          pinned={settings.alwaysOnTop}
          onTogglePin={() => update({ alwaysOnTop: !settings.alwaysOnTop })}
          closeOnX={settings.closeOnX}
          onOpenSettings={openSettings}
          themes={themes}
          theme={settings.theme}
          onThemeChange={(t) => update({ theme: t })}
          mode={effectiveMode}
          onModeChange={(m) => update({ mode: m })}
          talking={talking}
          debriefing={debriefing}
          titlebarExtras={
            titlebarItems.length ? (
              <>
                {titlebarItems.map((w) => {
                  const C = w.Titlebar!;
                  return C ? <C key={w.id} settings={settings} updatePlugin={(patch) => updatePlugin(w.id, patch)} /> : null;
                })}
              </>
            ) : undefined
          }
        />
        {onboardOpen && (
          <Onboarding
            onClose={() => {
              localStorage.setItem("oc.onboarded", "1");
              setOnboardOpen(false);
            }}
            settings={settings}
            update={update}
            themes={themes}
            activeModes={activeModes}
            providers={oc.providers}
          />
        )}
        {(showUpdatePrompt || debugUpdateForced) && promptInfo && (
          <UpdatePrompt
            info={promptInfo}
            curVer={upd.ver}
            busy={upd.busy}
            downloading={upd.downloading}
            err={upd.err}
            onUpdate={() => {
              if (debugUpdateForced && !upd.latest) {
                setDebugUpdateForced(false);
                return;
              }
              void upd.install();
            }}
            onDismiss={handleUpdateDismiss}
          />
        )}
        <SettingsDrawer
          upd={upd}
          onDebugUpdate={handleDebugUpdate}
          open={settingsOpen}
          providers={oc.providers}
          commands={oc.cmdList}
          onClose={closeSettings}
          settings={settings}
          update={update}
          updatePlugin={updatePlugin}
          updateSounds={updateSounds}
          updateColors={updateColors}
          resetColors={resetColors}
          themes={themes}
          colorsFor={colorsFor}
          modes={activeModes}
          effectiveMode={effectiveMode}
          pluginDocs={pluginDocs}
          plugins={plugins}
          onTogglePlugin={toggleEnabled}
          onRemoveDisabled={removeDisabled}
        />
        <div
          className={`layout${resizing ? " no-anim" : ""}`}
          style={
            {
              gridTemplateColumns: sbClosed ? "46px 1fr" : `${sbW}px 1fr`,
              // floating popups (permission/question) center inside the main column
              "--sb-w": sbClosed ? "46px" : `${sbW}px`,
            } as React.CSSProperties
          }
        >
          <Sidebar
            sessions={oc.sessions}
            activeId={oc.activeId}
            busyIds={oc.busyIds}
            compactingIds={oc.compactingIds}
            queueCounts={oc.queueCounts}
            width={sbW}
            collapsed={sbClosed}
            loading={oc.booting}
            resizing={resizing}
            onToggle={() => setSbClosed((v) => !v)}
            onStartResize={startResize}
            onNew={oc.newSession}
            onOpen={(id) => oc.openSession(id)}
            onDelete={(id) => oc.removeSession(id)}
            onClearAll={() => void oc.clearSessions()}
            sidebarExtras={
              sidebarWidgets.length ? (
                <>
                  {sidebarWidgets.map((w) => {
                    const C = w.Sidebar!;
                    return C ? <C key={w.id} settings={settings} updatePlugin={(patch) => updatePlugin(w.id, patch)} /> : null;
                  })}
                </>
              ) : undefined
            }
          />
          <div className="main">
            {oc.error && <div className="banner">{oc.error}</div>}
            {themeError && <div className="banner">{themeError}</div>}
            {pluginError && <div className="banner">{pluginError}</div>}
            {!oc.activeId && !oc.booting && (
              <div className="messages">
                <p className="empty">
                  Select or create a session
                  <br />
                  to start.
                </p>
              </div>
            )}
            {(oc.activeId || oc.booting) && (
              <>
                {settings.workspace && (
                  <div className="stage-head" data-tip={settings.workspace} data-tip-cursor="">
                    <i className="fa-solid fa-folder-open" />
                    <span className="mono">{settings.workspace}</span>
                  </div>
                )}
                <MessageList
                  msgs={oc.msgs}
                  busy={oc.busy}
                  compacting={oc.compacting}
                  loading={oc.booting}
                  collapsed={settings.collapsed}
                  onRevert={oc.revertTo}
                  sessionId={oc.activeId}
                />
                {oc.revertId && (
                  <div className="revert-banner">
                    <i className="fa-solid fa-clock-rotate-left" />
                    Viewing an earlier version of this conversation.
                    <button onClick={oc.unrevert}>
                      <i className="fa-solid fa-rotate-left" />
                      Undo rewind
                    </button>
                  </div>
                )}
                {closeHint && (
                  <div className="revert-banner close-confirm">
                    <i className="fa-solid fa-trash-can" />
                    Press Ctrl+W again to close this session
                  </div>
                )}
                {oc.permission && (
                  <PermissionBar permission={oc.permission} onRespond={oc.respondToPermission} />
                )}
                {oc.question && (
                  <QuestionPopup
                    ask={oc.question}
                    onAnswer={oc.answerQuestion}
                    onReject={oc.rejectQuestion}
                  />
                )}
                {vnote && (
                  <div className={`voice-note${vnote.startsWith("✗") ? " reject" : ""}`}>
                    {vnote}
                  </div>
                )}
                {settings.voice.debug && vdbg.length > 0 && (
                  <div className="voice-debug" role="log">
                    {vdbg.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}
                <Composer
                  busy={oc.busy}
                  escHint={stopArmed}
                  clearEscHint={clearStopArmed}
                  loadingModels={oc.booting}
                  providers={oc.providers}
                  modelSel={oc.modelSel}
                  defaultModel={oc.defaultModel}
                  onModelSelect={oc.setModelSel}
                  onSend={oc.submit}
                  onAbort={oc.abort}
                  onToggleDiff={() => setDiffOpen((v) => !v)}
                  onToggleTerm={() => setTermOpen((v) => !v)}
                  onPickWorkspace={() => pickWorkspace()}
                  workspace={settings.workspace}
                  commands={oc.cmdList}
                  onCommandsOpen={oc.refreshCommands}
                  agents={oc.agents}
                  agentSel={oc.agentSel}
                  onCycleAgent={oc.cycleAgent}
                  onCycleVariant={oc.cycleVariant}
                  hasVariants={oc.modelVariants.length > 0}
                  variantSel={oc.variantSel}
                  usage={oc.sessionUsage}
                  caps={oc.modelCaps}
                  voicePhase={voice.phase}
                  voiceStreaming={voice.streaming}
                  voiceError={voice.error}
                  onVoiceToggle={voice.toggle}
                  sessionId={oc.activeId}
                />
              </>
            )}
            <TerminalPanel
              key={termKey}
              open={termOpen}
              workspace={settings.workspace}
              onClose={() => setTermOpen(false)}
              onReload={() => setTermKey((k) => k + 1)}
            />
          </div>
        </div>
        {oc.dialog?.kind === "help" && (
          <HelpDialog commands={oc.cmdList} onClose={oc.closeDialog} />
        )}
        {oc.dialog?.kind === "share" && (
          <ShareDialog url={oc.dialog.url} onClose={oc.closeDialog} />
        )}
        {oc.dialog?.kind === "variants" && (
          <VariantsDialog
            variants={oc.modelVariants}
            selected={oc.variantSel}
            onSelect={oc.setVariantSel}
            onClose={oc.closeDialog}
          />
        )}
        {diffOpen && oc.activeId && (
          <DiffPanel sessionId={oc.activeId} onClose={() => setDiffOpen(false)} />
        )}
        <FileEditorHost />
        {overlays.map((w) => {
          const C = w.Overlay!;
          return C ? <C key={w.id} settings={settings} updatePlugin={(patch) => updatePlugin(w.id, patch)} /> : null;
        })}
      </div>
    </>
  );
}
