import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { routeVoice } from "../lib/voiceRouter";
import { pickWorkspace } from "../lib/workspace";
import { playSound } from "../lib/sounds";

const SB_W_KEY = "oc.sb.w";
const SB_C_KEY = "oc.sb.c";

// plays synthesized wav bytes; returns the element so callers can pause it
function playWav(bytes: number[], volume: number): HTMLAudioElement {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
  );
  const a = new Audio(url);
  a.volume = volume;
  a.onended = () => URL.revokeObjectURL(url);
  void a.play().catch(() => {});
  return a;
}

// concise spoken cues for tool activity — unknown tools fall back to "Using x"
const TOOL_CUES: Record<string, string> = {
  bash: "Running a command.",
  read: "Reading files.",
  grep: "Searching code.",
  glob: "Finding files.",
  list: "Listing files.",
  webfetch: "Fetching a page.",
  websearch: "Searching the web.",
  edit: "Editing files.",
  write: "Writing a file.",
  multiedit: "Editing files.",
  patch: "Applying changes.",
  task: "Delegating to an agent.",
  todowrite: "Updating the plan.",
  question: "Asking you something.",
};
const cueFor = (tool: string) =>
  TOOL_CUES[tool.toLowerCase()] ?? `Using ${tool}.`;

export default function ChatPage() {
  const oc = useOpencode();
  const {
    settings,
    update,
    updateSounds,
    updateColors,
    resetColors,
    themes,
    themeError,
    activeModes,
    effectiveMode,
    colorsFor,
  } = useSettings();
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

  // voice transcripts: recognized phrases drive the UI, everything else is
  // dictation — dropped into the composer for review (or sent on autoSend)
  const handleVoiceTranscript = useCallback(
    (text: string) => {
      const act = routeVoice(text, {
        themes: themes.map((t) => t.id),
        commands: oc.cmdList.map((c) => c.name),
      });
      if (!act) {
        if (settings.voice.autoSend) void oc.submit(text);
        else window.dispatchEvent(new CustomEvent("oc:voice-text", { detail: text }));
        return;
      }
      playSound("click");
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
        case "send":
          window.dispatchEvent(new Event("oc:voice-send"));
          break;
        case "clear":
          window.dispatchEvent(new Event("oc:voice-clear"));
          break;
        case "quiet":
          replyAudio.current?.pause();
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, oc.cmdList, settings.voice.autoSend],
  );

  const voice = useVoice(
    handleVoiceTranscript,
    settings.voice.model,
    settings.voice.handsFree,
    settings.voice.pauseMs,
    settings.voice.sens,
  );

  // speak-replies: narrate each finished assistant message (code stripped).
  // launchAt gates it: only replies whose completion stamp is newer than app
  // launch are spoken, so restored session history stays silent no matter
  // when it arrives (msgs load async after mount)
  const lastSpoken = useRef("");
  const launchAt = useRef(Date.now());
  const replyAudio = useRef<HTMLAudioElement | null>(null);

  // top-bar stop-speech button pauses piper playback from anywhere; the
  // volume slider retunes a running reply via oc:tts-vol
  useEffect(() => {
    const stop = () => replyAudio.current?.pause();
    const vol = (e: Event) => {
      if (replyAudio.current) replyAudio.current.volume = (e as CustomEvent<number>).detail;
    };
    window.addEventListener("oc:tts-stop", stop);
    window.addEventListener("oc:tts-vol", vol);
    return () => {
      window.removeEventListener("oc:tts-stop", stop);
      window.removeEventListener("oc:tts-vol", vol);
    };
  }, []);
  useEffect(() => {
    if (!settings.speakReplies) return;
    const last = [...oc.msgs]
      .reverse()
      .find((m) => (m.info as any).role === "assistant" && (m.info as any).time?.completed);
    if (!last || last.info.id === lastSpoken.current) return;
    if (((last.info as any).time?.completed ?? 0) <= launchAt.current) return;
    lastSpoken.current = last.info.id;
    const text = last.parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join(" ")
      .replace(/```[\s\S]*?```/g, " code block omitted. ")
      .replace(/`([^`]*)`/g, "$1")
      // strip markdown so the voice reads words, not formatting characters
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images -> label only
      .replace(/https?:\/\/\S+/g, " a link ") // bare urls are unreadable aloud
      .replace(/^#{1,6}\s+/gm, "") // headings
      .replace(/^\s*[-*+]\s+/gm, "") // bullets
      .replace(/^\s*>\s?/gm, "") // quotes
      .replace(/(\*\*\*|___)(.*?)\1/g, "$2")
      .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
      .replace(/(\*|_)(.*?)\1/g, "$2") // italic
      .replace(/~~(.*?)~~/g, "$1") // strikethrough
      .replace(/[|*_~#>`]/g, " ") // leftover markers (tables etc.)
      .replace(/\s{2,}/g, " ")
      .trim();
    // spoken replies are piper-only; ttsVoice holds "<id>.onnx" and stays
    // empty until the user installs piper + downloads a voice in Settings
    if (!text.trim() || !settings.ttsVoice) return;
    replyAudio.current?.pause();
    invoke<number[]>("tts_speak", { text, voice: settings.ttsVoice, speed: settings.ttsSpeed })
      .then((bytes) => {
        replyAudio.current = playWav(bytes, settings.ttsVol);
      })
      .catch(() => {});
  }, [settings.speakReplies, settings.ttsVoice, oc.msgs]);

  // status cues: brief spoken notices while the model works — turn start
  // ("Thinking.") plus EVERY tool call (commands, edits, searches…), each
  // announced once via its unique part id. A new cue interrupts the
  // previous one so the voice never falls behind the work.
  const lastToolKey = useRef("");
  const announce = useCallback(
    (phrase: string) => {
      if (!settings.speakReplies || !settings.ttsVoice) return;
      replyAudio.current?.pause();
      invoke<number[]>("tts_speak", { text: phrase, voice: settings.ttsVoice, speed: settings.ttsSpeed })
        .then((bytes) => {
          replyAudio.current = playWav(bytes, settings.ttsVol);
        })
        .catch(() => {});
    },
    [settings.speakReplies, settings.ttsVoice, settings.ttsVol, settings.ttsSpeed],
  );

  useEffect(() => {
    if (oc.busy) announce("Thinking.");
  }, [oc.busy, announce]);

  useEffect(() => {
    if (!oc.busy) return;
    let latest: { key: string; tool: string } | null = null;
    for (const m of oc.msgs)
      for (const p of m.parts ?? []) {
        if ((p as any).type !== "tool") continue;
        const st = (p as any).state?.status;
        if (st !== "running" && st !== "pending") continue;
        const key = String((p as any).id ?? `${m.info.id}:${(p as any).tool}`);
        latest = { key, tool: String((p as any).tool ?? "") };
      }
    if (latest && latest.key !== lastToolKey.current) {
      lastToolKey.current = latest.key;
      announce(cueFor(latest.tool));
    }
  }, [oc.msgs, oc.busy, announce]);

  // permission popup opened — say what needs approval (once per ask)
  const lastPermId = useRef("");
  useEffect(() => {
    if (!oc.permission || oc.permission.id === lastPermId.current) return;
    lastPermId.current = oc.permission.id;
    announce(`Permission needed: ${oc.permission.title}.`);
  }, [oc.permission, announce]);

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
          speechLive={settings.speakReplies}
        />
        <SettingsDrawer
          open={settingsOpen}
          onClose={closeSettings}
          settings={settings}
          update={update}
          updateSounds={updateSounds}
          updateColors={updateColors}
          resetColors={resetColors}
          themes={themes}
          colorsFor={colorsFor}
          modes={activeModes}
          effectiveMode={effectiveMode}
        />
        <div
          className={`layout${resizing ? " no-anim" : ""}`}
          style={{ gridTemplateColumns: sbClosed ? "46px 1fr" : `${sbW}px 1fr` }}
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
          />
          <div className="main">
            {oc.error && <div className="banner">{oc.error}</div>}
            {themeError && <div className="banner">{themeError}</div>}
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
