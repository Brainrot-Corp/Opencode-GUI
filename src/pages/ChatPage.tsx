import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Titlebar from "../components/Titlebar";
import Sidebar from "../components/Sidebar";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import PermissionBar from "../components/PermissionBar";
import QuestionPopup from "../components/QuestionPopup";
import BrowserBar, { BROWSER_BAR_H } from "../components/BrowserBar";
import UpdatePrompt from "../components/UpdatePrompt";
import { useUpdater } from "../hooks/useUpdater";
import TooltipLayer from "../components/TooltipLayer";
import DiffPanel from "../components/DiffPanel";
import PluginsDialog from "../components/PluginsDialog";

// heavy panels → code-split: only fetched when opened (DiffPanel is NOT lazy:
// GitPanel + ToolBlock statically import it, so a dynamic import wouldn't split)
const SettingsDrawer = lazy(() => import("../components/SettingsDrawer"));
const Onboarding = lazy(() => import("../components/Onboarding"));
const FileEditorHost = lazy(() => import("../components/FileEditorHost"));
const TerminalPanel = lazy(() => import("../components/Terminal"));
import { HelpDialog, ShareDialog, VariantsDialog } from "../components/CommandDialog";
import AgentBoard from "../components/AgentBoard";
import { useOpencode } from "../hooks/useOpencode";
import { useSettings } from "../hooks/useSettings";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { usePluginHotkeys } from "../hooks/usePluginHotkeys";
import { useVoice, type VdbgKind } from "../hooks/useVoice";
import { routeVoice, routerInput, type VoiceAct } from "../lib/voiceRouter";
import { ensureDict } from "../lib/dictWords";
import { pickWorkspace, getLastWorkspace, getAllWorkspaces } from "../lib/workspace";
import { playSound } from "../lib/sounds";
import { useSpeech } from "../hooks/useSpeech";
import { pushToast, dismissToast } from "../hooks/useToast";
import { matchesEvent } from "../lib/hotkeys";
import { usePlugins } from "../hooks/usePlugins";
import { loadPluginsCatalog, fetchPluginFiles, pluginRawUrl, type PluginCatalogEntry } from "../lib/pluginsCatalog";
import { isNewer, getAutoUpdateEnabled, setAutoUpdateEnabled } from "../lib/plugins";
import { ContextMenuProvider } from "../hooks/useContextMenu";
import SelectionMenu from "../components/SelectionMenu";
import { getFindTarget, setFindTarget, targetFromElement } from "../lib/findContext";

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
    resetThemes,
    themes,
    activeModes,
    effectiveMode,
    colorsFor,
  } = useSettings();
  // runtime plugins — voice intents, sidebar/titlebar widgets, overlays
  const { plugins, exts, sidebarWidgets, titlebarItems, overlays, toggleEnabled, removeDisabled } = usePlugins();
  // spoken replies / narration / debrief — the whole piper voice pipeline
  const { talking, debriefing, announce, pauseSpeech } = useSpeech(
    { msgs: oc.msgs, busy: oc.busy, permission: oc.permission, providers: oc.providers },
    settings,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pluginCatalog, setPluginCatalog] = useState<PluginCatalogEntry[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [autoUpdateEnabled, setAutoUpdateEnabledState] = useState(() => getAutoUpdateEnabled());
  const [diffOpen, setDiffOpen] = useState(false);
  // discord plugin reads this for {status} — file > diff > permission/question > compacting > busy > typing > working > idle
  const [editingFile, setEditingFile] = useState("");
  const [composerHasText, setComposerHasText] = useState(false);
  const [diffFiles, setDiffFiles] = useState<string[]>([]);
  useEffect(() => {
    const onFileEdit = (ev: Event) => setEditingFile((ev as CustomEvent<{ path?: string }>).detail?.path || "");
    window.addEventListener("oc:file-editor", onFileEdit);
    return () => window.removeEventListener("oc:file-editor", onFileEdit);
  }, []);
  useEffect(() => {
    const onDraft = (ev: Event) => setComposerHasText(!!(ev as CustomEvent<boolean>).detail);
    window.addEventListener("oc:composer-draft", onDraft);
    return () => window.removeEventListener("oc:composer-draft", onDraft);
  }, []);
  useEffect(() => {
    const onDiff = (ev: Event) => {
      const d = (ev as CustomEvent<string[]>).detail;
      setDiffFiles(Array.isArray(d) ? d : []);
    };
    window.addEventListener("oc:diff-files", onDiff);
    return () => window.removeEventListener("oc:diff-files", onDiff);
  }, []);
  useEffect(() => {
    if (!diffOpen) setDiffFiles([]);
  }, [diffOpen]);
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
      diffFiles,
      hasPermission: !!oc.permission,
      hasQuestion: !!oc.question,
      compacting: !!oc.compacting,
      isTyping: composerHasText,
    };
  }, [settings.workspace, oc.modelSel, oc.defaultModel, oc.busy, oc.activeId, oc.sessions, editingFile, diffOpen, diffFiles, oc.permission, oc.question, oc.compacting, composerHasText]);
  // terminal dock visibility — restored if it was open on close, height persists via oc.term.h; PTY warms in background via idle so open is instant
  const [termOpen, setTermOpen] = useState(
    () => localStorage.getItem("oc.term.open") === "1",
  );
  // first-launch setup wizard — any close records the flag so it shows once
  const [onboardOpen, setOnboardOpen] = useState(
    () => localStorage.getItem("oc.onboarded") !== "1",
  );
  // auto-update prompt — single shared updater for the whole app
  const upd = useUpdater();
  const [updDismissed, setUpdDismissed] = useState(
    () => localStorage.getItem("oc.update.dismissed") || "",
  );

  const [sbW, setSbW] = useState(() => {
    const w = Number(localStorage.getItem(SB_W_KEY)) || 280;
    return Math.min(Math.max(280, w), 440);
  });
  const [sbClosed, setSbClosed] = useState(() => localStorage.getItem(SB_C_KEY) === "1");
  const [agentsOpen, setAgentsOpen] = useState(() => localStorage.getItem("oc.agentBoard.open") === "1");
  // chat history find — routed when composer not focused and file not last active
  const [chatFindOpen, setChatFindOpen] = useState(false);
  const [chatFindQuery, setChatFindQuery] = useState("");
  const [chatFindCase, setChatFindCase] = useState(false);
  const [chatFindCur, setChatFindCur] = useState(0);
  const [resizing, setResizing] = useState(false);
  const [browserTop, setBrowserTop] = useState<number | null>(null);
  const toggleDiff = useCallback(() => setDiffOpen((v) => !v), []);
  const openSettingsDrawer = useCallback(() => setSettingsOpen(true), []);
  const toggleSettings = useCallback(() => setSettingsOpen((v) => !v), []);

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
  // a second Ctrl+W within 1s (banner shows while armed). After a successful
  // close, opens the next session like Ctrl+Tab; if none left, shows empty
  // placeholder without error.
  const [closeHint, setCloseHint] = useState(false);
  const closeArm = useRef(0);
  const closeTimer = useRef(0);
  const closeActiveSession = useCallback(() => {
    const id = oc.activeId;
    if (!id) return;
    const list = oc.sessions;
    const idx = list.findIndex((s) => s.id === id);
    const nextId = list.length > 1 ? list[(idx + 1 + list.length) % list.length]?.id ?? "" : "";
    // distinct target: when idx<0 (should not happen for active) fall back to first
    const resolvedNext = idx < 0 ? list[0]?.id ?? "" : nextId;
    const doClose = (target: string) => {
      // avoid opening the session we just deleted
      const toOpen = resolvedNext && resolvedNext !== target ? resolvedNext : "";
      void oc.removeSession(target).then(() => {
        if (!toOpen) return;
        // list may have been refreshed via SSE; verify still exists or just open
        // modulo next — safe even if list changed, openSession handles missing id gracefully
        void oc.openSession(toOpen).catch(() => {});
      });
    };
    if (!oc.msgs.some((m) => m.info.role === "user")) {
      doClose(id);
      return;
    }
    if (Date.now() - closeArm.current < 1000) {
      clearTimeout(closeTimer.current);
      closeArm.current = 0;
      setCloseHint(false);
      playSound("close");
      doClose(id);
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
  }, [oc.activeId, oc.msgs, oc.sessions, oc.removeSession, oc.openSession]);

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

  const toggleAgents = useCallback(() => setAgentsOpen(v => !v), []);
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
    onToggleSettings: toggleSettings,
    onOpenWorkspace: () => void pickWorkspace(),
    onNewInstance: () => void invoke("spawn_new_instance"),
    onNewSession: () => {
      const last = getLastWorkspace();
      if (last) {
        const all = getAllWorkspaces();
        const exists = all.some((d) => d.toLowerCase() === last.toLowerCase());
        if (exists) { void (oc as any).newSession(last); return; }
      }
      void (oc as any).newSession();
    },
    onToggleAgents: toggleAgents,
  });
  usePluginHotkeys({ settings, plugins });

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
  const pendingToastRef = useRef<number | undefined>(undefined);
  const pendingTimerRef = useRef<number>(0);
  // guards the async translate fallback: newer speech invalidates an
  // in-flight re-route
  const seqRef = useRef(0);
  // dictation capture mode — bare "prompt" (no args) opens it: speech appends
  // to the composer until "send", "clear" or any other command ends it
  const captureRef = useRef(false);
  // warm the typo-corrector's dictionary veto once per launch
  useEffect(() => {
    void ensureDict();
  }, []);
  // cleanup pending confirmation toast/timer on unmount
  useEffect(() => () => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    if (pendingToastRef.current !== undefined) dismissToast(pendingToastRef.current);
  }, []);
  const refreshCatalog = useCallback(async (force = false) => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const entries = await loadPluginsCatalog(force);
      setPluginCatalog(entries);
      return entries;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCatalogError(msg);
      throw e;
    } finally {
      setCatalogLoading(false);
    }
  }, []);
  // prefetch plugin catalog on launch — single source for titlebar dot + dialog (was duplicated in PluginsDialog)
  useEffect(() => {
    void refreshCatalog(false).catch(() => {});
  }, [refreshCatalog]);
  const hasPluginUpdate = useMemo(() => {
    if (!pluginCatalog || !pluginCatalog.length || !plugins.length) return false;
    const byId = new Map(pluginCatalog.map((c) => [c.id, c] as const));
    return plugins.some((p) => {
      const cat = byId.get(p.id) ?? byId.get(p.dir) ?? pluginCatalog.find((c) => c.id === p.id || c.id === p.dir);
      return isNewer(p.version, cat?.version);
    });
  }, [pluginCatalog, plugins]);

  const toggleAutoUpdate = useCallback((v: boolean) => {
    setAutoUpdateEnabled(v);
    setAutoUpdateEnabledState(v);
  }, []);

  // keep auto-update flag in sync across tabs / dialog-owned writes
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "oc.plugins.autoUpdate") setAutoUpdateEnabledState(e.newValue === "1");
    };
    const onCustom = (e: Event) => setAutoUpdateEnabledState(!!(e as CustomEvent).detail);
    window.addEventListener("storage", onStorage);
    window.addEventListener("oc:plugins-autoupdate", onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("oc:plugins-autoupdate", onCustom as EventListener);
    };
  }, []);

  // auto-update: when enabled, install newer catalog versions immediately
  const autoUpdatingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoUpdateEnabled || !pluginCatalog?.length || !plugins.length || catalogLoading) return;
    const byId = new Map(pluginCatalog.map((c) => [c.id, c] as const));
    const toUpdate = plugins.filter((p) => {
      if (p.disabled) return false;
      const cat = byId.get(p.id) ?? byId.get(p.dir) ?? pluginCatalog.find((c) => c.id === p.id || c.id === p.dir);
      return isNewer(p.version, cat?.version);
    });
    if (!toUpdate.length) return;
    const pending = toUpdate.filter((p) => !autoUpdatingRef.current.has(p.id));
    if (!pending.length) return;
    void (async () => {
      for (const p of pending) {
        autoUpdatingRef.current.add(p.id);
        try {
          const entry = pluginCatalog.find((c) => c.id === p.id || c.id === p.dir);
          if (!entry) continue;
          const base = pluginRawUrl(entry.id, "").replace(/\/$/, "");
          const { manifest, main, css } = await fetchPluginFiles(base);
          await invoke("plugin_install_files", { dir: entry.id, manifest, main, css });
        } catch (e) {
          console.warn("[plugins auto-update] failed", p.id, e);
        } finally {
          autoUpdatingRef.current.delete(p.id);
        }
      }
    })();
  }, [autoUpdateEnabled, pluginCatalog, plugins, catalogLoading]);
  // debug transcript mode (Settings › Voice): structured audit trail —
  // colored kind tag + short message, newest at the bottom
  const VD_TAG: Record<VdbgKind, string> = { act: "cmd", say: "heard", warn: "!!", hint: "·" };
  const [vdbg, setVdbg] = useState<{ kind: VdbgKind; msg: string }[]>([]);
  const dbgPush = useCallback(
    (kind: VdbgKind, msg: string) => setVdbg((d) => [...d.slice(-7), { kind, msg }]),
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
  const routeCtx = useCallback(
    () => ({
      themes: themes.map((t) => t.id),
      commands: oc.cmdList.map((c) => c.name),
      exts,
    }),
    [themes, oc.cmdList, exts],
  );

  // executes a routed act — shared by the native, partial and capture paths
  const dispatch = useCallback(
    (act: VoiceAct) => {
      playSound("click");
      if (act.type === "embedded") {
        // plugin-driven confirmation: a plugin can opt out via
        // `requiresConfirmation = false` or `requiresConfirmation = (act)=>boolean`
        const inner = act.act as unknown as { type?: string; plugin?: string; act?: unknown };
        if (inner?.type === "plugin" && typeof inner.plugin === "string") {
          const ext = extById[inner.plugin];
          const flag = ext?.requiresConfirmation as unknown as boolean | ((a: unknown) => boolean) | undefined;
          const needs = typeof flag === "function" ? flag(inner.act) : flag !== false;
          if (!needs) {
            execAct(act.act);
            return;
          }
        }
        // active session: a command ran recently → trust the streak, skip
        // the read-back (25s window). Fuzzy matches (command + trailing
        // clause) always read back — they're only probable.
        if (!act.fuzzy && Date.now() - lastExecRef.current < 25000) {
          execAct(act.act);
          return;
        }
        pendingRef.current = { act: act.act, until: Date.now() + 15000 };
        const d = describeAct(act.act);
        const question = `Okay — ${d.charAt(0).toLowerCase()}${d.slice(1)}?`;
        announce(question);
        if (pendingToastRef.current !== undefined) dismissToast(pendingToastRef.current);
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
        pendingToastRef.current = pushToast(`${question} Say yes or no.`, { variant: "info", ttl: 15000 });
        pendingTimerRef.current = window.setTimeout(() => {
          pendingRef.current = null;
          if (pendingToastRef.current !== undefined) {
            dismissToast(pendingToastRef.current);
            pendingToastRef.current = undefined;
          }
          pendingTimerRef.current = 0;
        }, 15000);
        return;
      }
      execAct(act);
    },
    [execAct, describeAct, announce, extById],
  );

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      const p = pendingRef.current;
      if (p && Date.now() < p.until) {
        if (settings.voice.debug) dbgPush("hint", `yes/no — "${text}"`);
        const t0 = text.toLowerCase().replace(/[.,!?;:]+$/, "").trim();
        // yes/no in EN/FR/ES — "si" matches Spanish sí (whisper drops accents)
        if (/^(yes|yeah|yep|yup|sure|do it|confirm|go ahead|oui|ouais|ouep|vas-?y|si|sí|claro|dale|vale)\b/.test(t0)) {
          pendingRef.current = null;
          if (pendingToastRef.current !== undefined) { dismissToast(pendingToastRef.current); pendingToastRef.current = undefined; }
          if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = 0; }
          playSound("click");
          const d = describeAct(p.act);
          const acks = ["Done.", "You got it.", "On it.", "Sure thing."];
          const ack = acks[Math.floor(Math.random() * acks.length)];
          announce(ack);
          confirmNote(`✓ ${d || ack}`);
          execAct(p.act);
        } else if (/^(no|nope|nah|cancel|forget it|non|annule|annuler|anula|cancela)\b/.test(t0)) {
          pendingRef.current = null;
          if (pendingToastRef.current !== undefined) { dismissToast(pendingToastRef.current); pendingToastRef.current = undefined; }
          if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = 0; }
          const nos = ["No problem.", "Okay, skipping that.", "Cancelled."];
          announce(nos[Math.floor(Math.random() * nos.length)]);
          confirmNote("✗ Cancelled");
        } else {
          pendingRef.current = null; // unrelated chatter kills the question
          if (pendingToastRef.current !== undefined) { dismissToast(pendingToastRef.current); pendingToastRef.current = undefined; }
          if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = 0; }
        }
        return;
      }
      if (p) {
        pendingRef.current = null;
        if (pendingToastRef.current !== undefined) { dismissToast(pendingToastRef.current); pendingToastRef.current = undefined; }
        if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = 0; }
      } else {
        pendingRef.current = null;
      }

      // dictation capture mode: everything said appends to the composer until
      // "send"/"clear"/any other command ends it
      if (captureRef.current) {
        const act = routeVoice(text, routeCtx());
        if (!act) {
          if (settings.voice.debug) dbgPush("say", `+ ${text}`);
          dispatch({ type: "dictate", arg: text });
          return;
        }
        if (act.type === "dictate") {
          if (settings.voice.debug) dbgPush("say", `+ ${act.arg}`);
          return; // more args — keep capturing
        }
        captureRef.current = false;
        if (settings.voice.debug) dbgPush("act", `capture → ${describeAct(act)}`);
        dispatch(act);
        return;
      }

      const act = routeVoice(text, routeCtx());
      if (settings.voice.debug) {
        if (act) dbgPush("act", describeAct(act));
        else dbgPush("hint", `no match — ${text}`);
      }
      if (act) {
        dispatch(act);
        return;
      }
      // bare "prompt" — open dictation capture: following speech appends to
      // the composer until "send", "clear" or any other command
      if (routerInput(text) === "prompt") {
        captureRef.current = true;
        confirmNote("Listening — speak your prompt, then say send");
        if (settings.voice.debug) dbgPush("act", "capture on — listening");
        return;
      }
      // no match — multilingual mode already translated the main pass;
      // retry once with the native-language transcription before giving up.
      // Sequence token discards the result if newer speech arrived meanwhile
      if (settings.voice.multilingual) {
        const seq = ++seqRef.current;
        void retranscribeRef.current?.().then((native) => {
          if (!native || seq !== seqRef.current) return;
          const act2 = routeVoice(native, routeCtx());
          if (settings.voice.debug) {
            if (act2) dbgPush("act", `native → ${describeAct(act2)}`);
            else dbgPush("hint", `native pass — no match: ${native}`);
          }
          if (act2) dispatch(act2);
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeCtx, dispatch, settings.voice.debug, settings.voice.multilingual, dbgPush],
  );

  // rolling partial pass — fires one-shot commands the moment they're fully
  // spoken (no pause needed). Arg-carrying and embedded acts wait for the
  // authoritative utterance pass; returning true makes the hook forget the
  // buffer so fired words can't double-fire on the close pass. Disabled
  // during dictation capture (the words are the payload there)
  const handleVoicePartial = useCallback(
    (partial: string): boolean => {
      if (captureRef.current) return false;
      const act = routeVoice(partial, routeCtx());
      if (!act || act.type === "embedded") return false;
      if (settings.voice.debug) dbgPush("act", `early — ${describeAct(act)}`);
      dispatch(act);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeCtx, dispatch, settings.voice.debug, dbgPush],
  );

  const [voiceLive, setVoiceLive] = useState("");
  useEffect(() => {
    const onPart = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; isFinal: boolean }>).detail;
      setVoiceLive(d?.isFinal ? "" : d?.text ?? "");
    };
    const onFinal = () => setVoiceLive("");
    window.addEventListener("oc:voice-partial", onPart as EventListener);
    window.addEventListener("oc:voice-final", onFinal);
    return () => {
      window.removeEventListener("oc:voice-partial", onPart as EventListener);
      window.removeEventListener("oc:voice-final", onFinal);
    };
  }, []);
  const handleLivePartial = useCallback((p: string, isFinal: boolean) => {
    setVoiceLive(isFinal ? "" : p);
  }, []);
  const voice = useVoice(
    handleVoiceTranscript,
    settings.voice.model,
    settings.voice.sens,
    settings.voice.gpu,
    settings.voice.debug ? dbgPush : undefined,
    settings.voice.multilingual,
    handleVoicePartial,
    handleLivePartial,
  );
  // mic off ends dictation capture — nothing left to listen to
  useEffect(() => {
    if (!voice.streaming) captureRef.current = false;
  }, [voice.streaming]);
  // handler runs before useVoice returns — reach retranscribe through a ref
  const retranscribeRef = useRef<(() => Promise<string | null>) | null>(null);
  retranscribeRef.current = voice.retranscribe;

  // Mic toggle — rebindable (default Ctrl+M)
  useEffect(() => {
    const b = settings.hotkeys.micToggle;
    if (!b) return;
    const key = (e: KeyboardEvent) => {
      if (!matchesEvent(e, b)) return;
      e.preventDefault();
      voice.toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [voice.toggle, settings.hotkeys.micToggle]);

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

  // permission/question overlay dynamic anchoring — bottom tracks composer top with 6px gap (spacing unit)
  useLayoutEffect(() => {
    const GAP = 6;
    const update = () => {
      const composer = document.querySelector(".composer") as HTMLElement | null;
      if (!composer) return;
      const rect = composer.getBoundingClientRect();
      const bottom = Math.round(window.innerHeight - rect.top + GAP);
      document.documentElement.style.setProperty("--perm-bottom", `${bottom}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    const observe = () => {
      const c = document.querySelector(".composer") as HTMLElement | null;
      const td = document.querySelector(".term-dock") as HTMLElement | null;
      const main = document.querySelector(".main") as HTMLElement | null;
      if (c) ro.observe(c);
      if (td) ro.observe(td);
      if (main) ro.observe(main);
    };
    observe();
    window.addEventListener("resize", update);
    const mo = new MutationObserver(() => {
      ro.disconnect();
      observe();
      update();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [oc.activeId, oc.permission, oc.question, termOpen, sbW, sbClosed, oc.booting]);

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
        setSbW(Math.min(Math.max(280, startW + (ev.clientX - startX)), 440));
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

  // track last find context for Ctrl+F routing
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = targetFromElement(e.target as Element);
      if (t) setFindTarget(t);
    };
    const onFocus = (e: FocusEvent) => {
      const t = targetFromElement(e.target as Element);
      if (t) setFindTarget(t);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("focusin", onFocus, true);
    };
  }, []);
  const hoveringFileRef = useRef(false);
  const hoveringChatRef = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = e.target as Element | null;
      const overFileTree = !!el?.closest?.(".filetree");
      const overSidebarWithFiles = !!el?.closest?.(".sidebar") && !!document.querySelector(".filetree");
      hoveringFileRef.current = overFileTree || overSidebarWithFiles;
      hoveringChatRef.current = !!el?.closest?.(".messages, .msgs-wrap");
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseleave", () => {
      hoveringFileRef.current = false;
      hoveringChatRef.current = false;
    }, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
    };
  }, []);

  function openSettings() {
    playSound("expand");
    setSettingsOpen(true);
  }

  function closeSettings() {
    playSound("collapse");
    setSettingsOpen(false);
  }

  const showUpdatePrompt =
    !onboardOpen &&
    settings.updateNotifications &&
    !!upd.latest &&
    upd.latest.version !== updDismissed;

  const promptInfo = upd.latest;

  function handleUpdateDismiss(disable: boolean) {
    if (disable) {
      update({ updateNotifications: false });
    } else if (upd.latest) {
      localStorage.setItem("oc.update.dismissed", upd.latest.version);
      setUpdDismissed(upd.latest.version);
    } else {
      setUpdDismissed("1");
    }
  }

  // chat find helpers — position at chat history when composer not focused
  const [chatFindHits, setChatFindHits] = useState(0);
  const chatFindHitsRef = useRef(0);
  chatFindHitsRef.current = chatFindHits;
  const chatFindOpenRef = useRef(chatFindOpen);
  chatFindOpenRef.current = chatFindOpen;
  const openChatFind = useCallback(() => {
    const sel = window.getSelection()?.toString() ?? "";
    if (sel && sel.length <= 120 && !sel.includes("\n")) setChatFindQuery(sel);
    setChatFindOpen(true);
    setChatFindCur(0);
    window.dispatchEvent(new CustomEvent("oc:find-opened", { detail: "chat" }));
  }, []);
  const closeChatFind = useCallback(() => {
    setChatFindOpen(false);
    window.dispatchEvent(new Event("oc:chat-find-clear"));
  }, []);
  useEffect(() => {
    const onOther = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail !== "chat" && chatFindOpenRef.current) {
        setChatFindOpen(false);
        window.dispatchEvent(new Event("oc:chat-find-clear"));
      }
    };
    window.addEventListener("oc:find-opened", onOther as EventListener);
    return () => window.removeEventListener("oc:find-opened", onOther as EventListener);
  }, []);
  const gotoChatFind = useCallback((idx: number) => {
    const n = chatFindHitsRef.current;
    if (!n) return;
    const j = ((idx % n) + n) % n;
    setChatFindCur(j);
  }, []);

  // central Ctrl+F routing — capture phase to block browser find
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") {
        const ae = document.activeElement as HTMLElement | null;
        const inComposer = !!ae?.closest(".composer");
        const hasFileEditor = !!document.querySelector(".fe-stack");
        const lastTarget = getFindTarget();
        const isHoveringFileExplorer =
          hoveringFileRef.current ||
          !!document.querySelector(".filetree:hover") ||
          (!!document.querySelector(".sidebar:hover") && !!document.querySelector(".filetree"));
        const isHoveringChat =
          hoveringChatRef.current ||
          !!document.querySelector(".messages:hover") ||
          !!document.querySelector(".msgs-wrap:hover");
        if (inComposer) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("oc:composer-find"));
          return;
        }
        if (isHoveringFileExplorer) {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("oc:file-tree-find"));
          return;
        }
        if (isHoveringChat) {
          if (!oc.activeId && !oc.booting) return;
          e.preventDefault();
          e.stopPropagation();
          if (chatFindOpen) {
            const input = document.querySelector(".chat-find-input") as HTMLInputElement | null;
            input?.focus();
            input?.select();
            return;
          }
          openChatFind();
          return;
        }
        if (lastTarget === "file") {
          e.preventDefault();
          e.stopPropagation();
          if (hasFileEditor) window.dispatchEvent(new CustomEvent("oc:file-find"));
          else window.dispatchEvent(new CustomEvent("oc:file-tree-find"));
          return;
        }
        // otherwise chat history (covers not-focused composer case)
        if (!oc.activeId && !oc.booting) return;
        e.preventDefault();
        e.stopPropagation();
        if (chatFindOpen) {
          const input = document.querySelector(".chat-find-input") as HTMLInputElement | null;
          input?.focus();
          input?.select();
          return;
        }
        openChatFind();
        return;
      }
      if (k === "g" || e.key === "F3") {
        if (!chatFindOpen) return;
        // when chat find is open, handle next/prev
        const inChat = !!document.activeElement?.closest(".chat-find") || !!document.querySelector(".chat-find");
        if (inChat || chatFindOpen) {
          e.preventDefault();
          gotoChatFind(chatFindCur + (e.shiftKey ? -1 : 1));
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true } as any);
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [chatFindOpen, chatFindCur, openChatFind, gotoChatFind, oc.activeId, oc.booting]);

  // Esc closes chat find before other overlays
  useEffect(() => {
    if (!chatFindOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeChatFind();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true } as any);
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [chatFindOpen, closeChatFind]);
  // click outside chat find input closes it
  useEffect(() => {
    if (!chatFindOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".chat-find")) return;
      setChatFindOpen(false);
      window.dispatchEvent(new Event("oc:chat-find-clear"));
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [chatFindOpen]);



  return (
    <ContextMenuProvider>
      <SelectionMenu />
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
          onOpenPlugins={() => setPluginsOpen(true)}
          hasPluginUpdate={hasPluginUpdate}
          talking={talking}
          debriefing={debriefing}
          onToggleAgents={toggleAgents}
          agentsOpen={agentsOpen}
          agentsHotkey={settings.hotkeys.toggleAgents}
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
          <Suspense fallback={null}>
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
          </Suspense>
        )}
        {showUpdatePrompt && promptInfo && (
          <UpdatePrompt
            info={promptInfo}
            curVer={upd.ver}
            busy={upd.busy}
            downloading={upd.downloading}
            err={upd.err}
            onUpdate={() => void upd.install()}
            onDismiss={handleUpdateDismiss}
          />
        )}
        <Suspense fallback={null}>
          <SettingsDrawer
            upd={upd}
            open={settingsOpen}
            providers={oc.providers}
            commands={oc.cmdList}
            onClose={closeSettings}
            settings={settings}
            update={update}
            updateSounds={updateSounds}
            updateColors={updateColors}
            resetColors={resetColors}
            resetThemes={resetThemes}
            themes={themes}
            colorsFor={colorsFor}
            modes={activeModes}
            effectiveMode={effectiveMode}
            pluginDocs={pluginDocs}
            plugins={plugins}
          />
        </Suspense>
        <PluginsDialog
          open={pluginsOpen}
          onClose={() => setPluginsOpen(false)}
          plugins={plugins}
          onToggle={(id, enabled) => toggleEnabled(id, enabled)}
          onRemoved={(id) => removeDisabled(id)}
          settings={settings}
          updatePlugin={updatePlugin}
          catalog={pluginCatalog}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
          onRefreshCatalog={refreshCatalog}
          autoUpdateEnabled={autoUpdateEnabled}
          onToggleAutoUpdate={toggleAutoUpdate}
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
            attentionIds={oc.attentionIds}
            attentionKinds={oc.attentionKinds}
            queueCounts={oc.queueCounts}
            width={sbW}
            collapsed={sbClosed}
            loading={oc.booting}
            resizing={resizing}
            onToggle={() => setSbClosed((v) => !v)}
            onStartResize={startResize}
            onNew={(dir) => void (oc as any).newSession(dir)}
            onOpen={(id) => oc.openSession(id)}
            onDelete={(id) => oc.removeSession(id)}
            onClearAll={() => void oc.clearSessions()}
            onClearForDir={(dir) => void (oc as any).clearSessionsFor?.(dir)}
            onRename={(id, t) => void oc.renameSession(id, t)}
            onDuplicate={(id) => void oc.duplicateSession(id)}
            onTogglePin={(id) => oc.togglePin(id)}
            isPinned={(id) => oc.isPinned(id)}
            getDirForSession={(id) => (oc as any).getDirForSession?.(id) ?? ""}
            refreshSessions={() => void (oc as any).refreshSessions?.()}
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
                {(() => {
                  const activeDir = oc.activeId ? ((oc as any).getDirForSession?.(oc.activeId) ?? settings.workspace) : settings.workspace;
                  if (!activeDir) return null;
                  return (
                    <div className="stage-head" data-tip={activeDir} data-tip-cursor="">
                      <i className="fa-solid fa-folder-open" />
                      <span className="mono">{activeDir}</span>
                    </div>
                  );
                })()}
                <MessageList
                  msgs={oc.msgs}
                  busy={oc.busy}
                  compacting={oc.compacting}
                  loading={oc.booting}
                  collapsed={settings.collapsed}
                  onRevert={oc.revertTo}
                  onFork={oc.forkFrom}
                  sessionId={oc.activeId}
                  taskCosts={(oc as any).childTaskCosts}
                  findOpen={chatFindOpen}
                  findQuery={chatFindQuery}
                  findCase={chatFindCase}
                  findCur={chatFindCur}
                  findHits={chatFindHits}
                  onFindHits={setChatFindHits}
                  onFindQueryChange={(v) => {
                    setChatFindQuery(v);
                    setChatFindCur(0);
                  }}
                  onFindCaseToggle={() => {
                    setChatFindCase((c) => !c);
                    setChatFindCur(0);
                  }}
                  onFindClose={closeChatFind}
                  onFindNext={() => gotoChatFind(chatFindCur + 1)}
                  onFindPrev={() => gotoChatFind(chatFindCur - 1)}
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
                {oc.permission && ((oc as any).securityMode ?? "user") === "user" && (
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
                      <div key={i} className={`vd-line vd-${l.kind}`}>
                        <span className="vd-tag">{VD_TAG[l.kind]}</span>
                        <span className="vd-msg">{l.msg}</span>
                      </div>
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
                  cycleAgentHotkey={settings.hotkeys.cycleAgent}
                  hotkeys={settings.hotkeys}
                  onCommandsOpen={oc.refreshCommands}
                  agents={oc.agents}
                  agentSel={oc.agentSel}
                  onCycleAgent={oc.cycleAgent}
                  disabledAgents={(oc as any).disabledAgents}
                  onSelectAgent={(oc as any).setAgentSel}
                  onToggleDisabled={(oc as any).toggleDisabledAgent}
                  onRefreshAgents={(oc as any).refreshAgents}
                  onCycleVariant={oc.cycleVariant}
                  hasVariants={oc.modelVariants.length > 0}
                  variantSel={oc.variantSel}
                  modelVariants={oc.modelVariants}
                  onSelectVariant={(oc as any).setVariantSel}
                  securityMode={(oc as any).securityMode ?? "user"}
                  onCycleSecurity={(oc as any).cycleSecurityMode}
                  onSelectSecurity={(oc as any).setSecurityMode}
                  usage={oc.sessionUsage}
                  caps={oc.modelCaps}
                  voicePhase={voice.phase}
                  voiceStreaming={voice.streaming}
                  voiceError={voice.error}
                  voicePartial={voice.partial || voiceLive}
                  onVoiceToggle={voice.toggle}
                  sessionId={oc.activeId}
                />
              </>
            )}
            <Suspense fallback={null}>
              <TerminalPanel
                open={termOpen}
                workspace={settings.workspace}
                terminal={settings.terminal}
                onSetDefault={(id)=> update({ terminal: { ...settings.terminal, defaultProfileId: id } })}
                onClose={() => setTermOpen(false)}
                onToggle={() => setTermOpen((v) => !v)}
              />
            </Suspense>
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
        {diffOpen && oc.activeId && <DiffPanel sessionId={oc.activeId} onClose={() => setDiffOpen(false)} />}
        <AgentBoard
          open={agentsOpen}
          onClose={() => setAgentsOpen(false)}
          sessions={oc.sessions}
          busyIds={oc.busyIds}
          compactingIds={oc.compactingIds}
          attentionIds={oc.attentionIds}
          agents={oc.agents}
          getDirForSession={(id: string) => (oc as any).getDirForSession?.(id) ?? ""}
          onOpenSession={(id) => void oc.openSession(id)}
          activeId={oc.activeId}
          msgs={oc.msgs as any}
          activeChildren={oc.activeChildren as any}
          childTaskCosts={oc.childTaskCosts as any}
        />
        <Suspense fallback={null}>
          <FileEditorHost hotkeys={settings.hotkeys} />
        </Suspense>
        {overlays.map((w) => {
          const C = w.Overlay!;
          return C ? <C key={w.id} settings={settings} updatePlugin={(patch) => updatePlugin(w.id, patch)} /> : null;
        })}
      </div>
    </ContextMenuProvider>
  );
}
