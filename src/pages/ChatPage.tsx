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
import DiffPanel from "../components/DiffPanel";
import TooltipLayer from "../components/TooltipLayer";
import { HelpDialog, ShareDialog, VariantsDialog } from "../components/CommandDialog";
import { useOpencode } from "../hooks/useOpencode";
import { useSettings } from "../hooks/useSettings";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { useVoice } from "../hooks/useVoice";
import { routeVoice, routerInput, type VoiceAct } from "../lib/voiceRouter";
import { pickWorkspace } from "../lib/workspace";
import { playSound } from "../lib/sounds";
import { useSpeech } from "../hooks/useSpeech";
import { usePlugins } from "../hooks/usePlugins";

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
  // runtime plugins — voice intents, settings sections, error banner
  const { plugins, exts, sections: pluginSections, error: pluginError } = usePlugins();
  // spoken replies / narration / debrief — the whole piper voice pipeline
  const { talking, debriefing, announce, pauseSpeech } = useSpeech(
    { msgs: oc.msgs, busy: oc.busy, permission: oc.permission, providers: oc.providers },
    settings,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const [sbW, setSbW] = useState(() => {
    const w = Number(localStorage.getItem(SB_W_KEY)) || 248;
    return Math.min(Math.max(170, w), 440);
  });
  const [sbClosed, setSbClosed] = useState(() => localStorage.getItem(SB_C_KEY) === "1");
  const [resizing, setResizing] = useState(false);
  const [browserTop, setBrowserTop] = useState<number | null>(null);
  const toggleDiff = useCallback(() => setDiffOpen((v) => !v), []);
  const openSettingsDrawer = useCallback(() => setSettingsOpen(true), []);

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

  useGlobalShortcuts({
    settings,
    update,
    openBrowser,
    toggleDiff,
    openSettings: openSettingsDrawer,
    themeIds: themes.map((t) => t.id),
    activeModes,
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

      const act = routeVoice(text, {
        themes: themes.map((t) => t.id),
        commands: oc.cmdList.map((c) => c.name),
        exts,
      });
      if (settings.voice.debug)
        dbgPush(
          `"${text}" → "${routerInput(text)}" → ${
            act ? JSON.stringify(act) : "no match · dictation"
          }`,
        );
      if (!act) return;
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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, oc.cmdList, exts, execAct, describeAct, settings.voice.debug, dbgPush],
  );

  const voice = useVoice(
    handleVoiceTranscript,
    settings.voice.model,
    settings.voice.handsFree,
    settings.voice.sens,
  );

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

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sbW;
      let lastTick = 0;
      setResizing(true);
      // keep the native Windows col-resize cursor locked during the whole drag
      document.body.style.cursor = "col-resize";
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
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
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
          onOpenSettings={openSettings}
          themes={themes}
          theme={settings.theme}
          onThemeChange={(t) => update({ theme: t })}
          mode={effectiveMode}
          onModeChange={(m) => update({ mode: m })}
          talking={talking}
          debriefing={debriefing}
        />
        <SettingsDrawer
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
          pluginSections={pluginSections}
          pluginDocs={pluginDocs}
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
                  <div className="stage-head" data-tip={settings.workspace}>
                    <i className="fa-solid fa-folder-open" />
                    <span className="mono">{settings.workspace}</span>
                  </div>
                )}
                <MessageList
                  msgs={oc.msgs}
                  busy={oc.busy}
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
                  loadingModels={oc.booting}
                  providers={oc.providers}
                  modelSel={oc.modelSel}
                  defaultModel={oc.defaultModel}
                  onModelSelect={oc.setModelSel}
                  onSend={oc.submit}
                  onAbort={oc.abort}
                  onToggleDiff={() => setDiffOpen((v) => !v)}
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
                />
              </>
            )}
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
      </div>
    </>
  );
}
