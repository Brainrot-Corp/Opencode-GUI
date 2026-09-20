import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import SubagentViewer from "../components/SubagentViewer";
import { resolveSubagentTarget } from "../lib/subagents";
import PluginsDialog from "../components/PluginsDialog";
import DialogHost from "../components/DialogHost";

// heavy panels → code-split: only fetched when opened (DiffPanel is NOT lazy:
// GitPanel + ToolBlock statically import it, so a dynamic import wouldn't split)
const SettingsDrawer = lazy(() => import("../components/SettingsDrawer"));
const Onboarding = lazy(() => import("../components/Onboarding"));
const FileEditorHost = lazy(() => import("../components/FileEditorHost"));
const TerminalPanel = lazy(() => import("../components/Terminal"));
import AgentBoard from "../components/AgentBoard";
import { useOpencode } from "../hooks/useOpencode";
import { useSettings } from "../hooks/useSettings";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { usePluginHotkeys } from "../hooks/usePluginHotkeys";
import { useVoiceRouter, VD_TAG } from "../hooks/useVoiceRouter";
import { pickWorkspace, getLastWorkspace, getAllWorkspaces, removeWorkspace, applyWorkspace } from "../lib/workspace";
import { normWorkspace } from "../lib/platform";
import { playSound } from "../lib/sounds";
import { useSpeech } from "../hooks/useSpeech";
import { pushToast } from "../hooks/useToast";
import { usePlugins } from "../hooks/usePlugins";
import { releaseTrapFocus } from "../lib/focus";
import { usePluginUpdates } from "../hooks/usePluginUpdates";
import { useTwoStepConfirm } from "../hooks/useTwoStepConfirm";
import { useDragResize } from "../hooks/useDragResize";
import { useChatFind } from "../hooks/useChatFind";
import { useNotifyRelay } from "../hooks/useNotifyRelay";
import { ContextMenuProvider } from "../hooks/useContextMenu";
import SelectionMenu from "../components/SelectionMenu";
import { useTranslation } from "../lib/i18n";
import { windowKey } from "../lib/windowScope";
import { mirrorPresence } from "../lib/presence";

const SB_W_KEY = "oc.sb.w";
const SB_C_KEY = "oc.sb.c";

export default function ChatPage() {
  const { t } = useTranslation();
  const oc = useOpencode();
  const {
    settings,
    update,
    updatePlugin,
    updateSounds,
    updateNotify,
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
  const [diffOpen, setDiffOpen] = useState(false);
  // phone relay (docs/mobile-companion.md phase 1) — desktop-side bridge
  useNotifyRelay({ busyIds: oc.busyIds, sessions: oc.sessions });
  // read-only subagent transcript (parent session stays active underneath)
  const [subViewer, setSubViewer] = useState<{ id: string } | { picker: true } | null>(null);
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
  // active session for the stale-event guard below (effect subscribes once)
  const activeIdRef = useRef(oc.activeId);
  activeIdRef.current = oc.activeId;
  useEffect(() => {
    const onDiff = (ev: Event) => {
      const d = (ev as CustomEvent<any>).detail;
      // legacy shape (bare array) or tagged { sessionId, files } — drop
      // events from a session that is no longer active (slow fetch for the
      // previous session resolving after a switch)
      const files = Array.isArray(d) ? d : Array.isArray(d?.files) ? d.files : [];
      const sid = Array.isArray(d) ? undefined : d?.sessionId;
      if (sid !== undefined && sid !== activeIdRef.current) return;
      setDiffFiles(files);
    };
    window.addEventListener("oc:diff-files", onDiff);
    return () => window.removeEventListener("oc:diff-files", onDiff);
  }, []);
  useEffect(() => {
    if (!diffOpen) setDiffFiles([]);
  }, [diffOpen]);
  // presence live snapshot for plugins (discord etc.) — always mirrored to window
  useEffect(() => {
    mirrorPresence({
      workspace: settings.workspace,
      model: oc.modelSel || oc.defaultModel || "",
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
    });
  }, [settings.workspace, oc.modelSel, oc.defaultModel, oc.busy, oc.activeId, oc.sessions, editingFile, diffOpen, diffFiles, oc.permission, oc.question, oc.compacting, composerHasText]);
  // terminal dock visibility — per window (PTYs are per-process, so sharing
  // this flag would open a dock over another window's dead terminals)
  const [termOpen, setTermOpen] = useState(
    () => localStorage.getItem(windowKey("oc.term.open")) === "1",
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

  // sidebar width + collapse, persisted per window
  const resizeTick = useCallback(() => playSound("resize"), []);
  const sb = useDragResize({
    min: 280,
    max: 440,
    initial: () => Number(localStorage.getItem(SB_W_KEY)) || 280,
    onTick: resizeTick,
  });
  const { width: sbW, resizing, startResize } = sb;
  const [sbClosed, setSbClosed] = useState(() => localStorage.getItem(SB_C_KEY) === "1");
  const [agentsOpen, setAgentsOpen] = useState(() => localStorage.getItem("oc.agentBoard.open") === "1");
  // chat history find — routed when composer not focused and file not last active
  const find = useChatFind({ activeId: oc.activeId, booting: oc.booting });
  const {
    chatFindOpen,
    chatFindQuery,
    chatFindCase,
    chatFindCur,
    chatFindHits,
    setChatFindHits,
    onFindQueryChange,
    onFindCaseToggle,
    closeChatFind,
    gotoChatFind,
  } = find;
  const [browserTop, setBrowserTop] = useState<number | null>(null);
  const toggleDiff = useCallback(() => setDiffOpen((v) => !v), []);
  const openSettingsDrawer = useCallback(() => setSettingsOpen(true), []);
  const toggleSettings = useCallback(() => setSettingsOpen((v) => !v), []);
  const openSettings = useCallback(() => {
    playSound("expand");
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    playSound("collapse");
    setSettingsOpen(false);
  }, []);

  // stable handlers for the memoized chrome (Titlebar/Sidebar/Composer) — the
  // inline arrows they used to receive recreated every render, which would
  // defeat memo() during streaming deltas. These pin identity across frames.
  const togglePin = useCallback(() => update({ alwaysOnTop: !settings.alwaysOnTop }), [update, settings.alwaysOnTop]);
  const openPlugins = useCallback(() => setPluginsOpen(true), []);
  const toggleTermCb = useCallback(() => setTermOpen((v) => !v), []);
  const pickWorkspaceCb = useCallback(() => { pickWorkspace(); }, []);
  const sbOnToggle = useCallback(() => setSbClosed((v) => !v), []);
  const sbOnNew = useCallback((dir?: string) => { void oc.newSession(dir); }, [oc.newSession]);
  const sbOnOpen = useCallback((id: string) => { void oc.openSession(id); }, [oc.openSession]);
  // open a subagent transcript from chat history: explicit child id when the
  // block carries one, else resolve the id-less agent/subtask part against
  // the active children (single child = direct, several = picker)
  const openSubagent = useCallback((id: string | null, part?: any) => {
    if (id) { setSubViewer({ id }); return; }
    const kids = ((oc.activeChildren as any[]) ?? []) as { id: string; title?: string; time?: { created?: number } }[];
    const target = part
      ? resolveSubagentTarget(part, oc.msgs as any, kids.map((k) => ({ id: k.id, title: k.title, timeCreated: k.time?.created })))
      : null;
    if (target) { setSubViewer({ id: target.id }); return; }
    if (kids.length === 1) { setSubViewer({ id: kids[0].id }); return; }
    if (kids.length > 1) { setSubViewer({ picker: true }); return; }
    pushToast("Subagent transcript not available yet");
  }, [oc.msgs, oc.activeChildren]);
  const sbOnDelete = useCallback((id: string) => { void oc.removeSession(id); }, [oc.removeSession]);
  const sbOnClearAll = useCallback(() => { void oc.clearSessions(); }, [oc.clearSessions]);
  const sbOnClearForDir = useCallback((dir: string) => { void oc.clearSessionsFor(dir); }, [oc.clearSessionsFor]);
  const sbOnRename = useCallback((id: string, title: string) => { void oc.renameSession(id, title); }, [oc.renameSession]);
  const sbOnDuplicate = useCallback((id: string) => { void oc.duplicateSession(id); }, [oc.duplicateSession]);
  const sbOnTogglePin = useCallback((id: string) => { oc.togglePin(id); }, [oc.togglePin]);
  const sbIsPinned = useCallback((id: string) => oc.isPinned(id), [oc.isPinned]);
  const sbGetDir = useCallback((id: string) => oc.getDirForSession(id) ?? "", [oc.getDirForSession]);
  const sbRefresh = useCallback(() => { void oc.refreshSessions(); }, [oc.refreshSessions]);

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
  const performCloseSession = useCallback(() => {
    const id = oc.activeId;
    if (!id) return;
    const list = oc.sessions;
    const idx = list.findIndex((s) => s.id === id);
    const nextId = list.length > 1 ? list[(idx + 1 + list.length) % list.length]?.id ?? "" : "";
    // distinct target: when idx<0 (should not happen for active) fall back to first
    const resolvedNext = idx < 0 ? list[0]?.id ?? "" : nextId;
    // avoid opening the session we just deleted
    const toOpen = resolvedNext && resolvedNext !== id ? resolvedNext : "";
    void oc.removeSession(id).then(() => {
      if (!toOpen) return;
      // list may have been refreshed via SSE; verify still exists or just open
      // modulo next — safe even if list changed, openSession handles missing id gracefully
      void oc.openSession(toOpen).catch(() => {});
    });
  }, [oc.activeId, oc.sessions, oc.removeSession, oc.openSession]);
  const { armed: closeHint, press: pressCloseSession } = useTwoStepConfirm();
  const closeActiveSession = useCallback(() => {
    const id = oc.activeId;
    if (!id) return;
    if (!oc.msgs.some((m) => m.info.role === "user")) {
      performCloseSession();
      return;
    }
    if (pressCloseSession()) {
      playSound("close");
      performCloseSession();
    } else {
      playSound("click");
    }
  }, [oc.activeId, oc.msgs, performCloseSession, pressCloseSession]);

  // Ctrl+Shift+W close workspace — mirrors the close-session double-press:
  // first press arms (banner shows), second within 1s closes. Only extra
  // workspaces are removable (primary has no remove button in the sidebar).
  // Closes the active session's workspace when it's an extra, else the last
  // extra, staying in the primary (stale active clears via refresh).
  // Primary-only and not already home: closing goes straight home.
  // removable-extra target: active session's workspace when it's an extra,
  // else the last extra. "" when nothing removable (primary-only).
  const resolveWorkspaceCloseTarget = useCallback(() => {
    const all = getAllWorkspaces();
    if (all.length <= 1) return "";
    const primary = all[0] ?? "";
    const activeDir = oc.activeId ? (oc.getDirForSession?.(oc.activeId) ?? "") : "";
    const target =
      activeDir && normWorkspace(activeDir) !== normWorkspace(primary)
        ? activeDir
        : (all[all.length - 1] ?? "");
    if (!target || normWorkspace(target) === normWorkspace(primary)) return "";
    return target;
  }, [oc.activeId, oc.getDirForSession]);
  // immediate path — explicit invocations (/close-workspace) skip the arm.
  // Detaches the extra and stays in the primary workspace; a stale active
  // session in the closed dir clears via refreshSessions (no home jump, so
  // the primary is never discarded).
  const closeWorkspaceNow = useCallback(() => {
    const target = resolveWorkspaceCloseTarget();
    if (target) {
      playSound("close");
      removeWorkspace(target);
      void oc.refreshSessions?.();
      return;
    }
    // primary-only and not already home — closing means going home
    const primary = getAllWorkspaces()[0] ?? "";
    if (primary && normWorkspace(primary) !== "") {
      playSound("close");
      void applyWorkspace("");
    }
  }, [resolveWorkspaceCloseTarget, oc.activeId, oc.getDirForSession, oc.refreshSessions]);
  const { armed: wsCloseHint, press: pressCloseWorkspace } = useTwoStepConfirm();
  const closeActiveWorkspace = useCallback(() => {
    const target = resolveWorkspaceCloseTarget();
    const primary = getAllWorkspaces()[0] ?? "";
    if (!target && !(primary && normWorkspace(primary) !== "")) return;
    if (pressCloseWorkspace()) {
      closeWorkspaceNow();
    } else {
      playSound("click");
    }
  }, [resolveWorkspaceCloseTarget, closeWorkspaceNow, pressCloseWorkspace]);

  // /close-workspace handoff — explicit invocation, no double-press
  useEffect(() => {
    const close = () => closeWorkspaceNow();
    window.addEventListener("oc:close-workspace", close);
    return () => window.removeEventListener("oc:close-workspace", close);
  }, [closeWorkspaceNow]);

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
    onCloseWorkspace: closeActiveWorkspace,
    onToggleTerm: () => setTermOpen((v) => !v),
    onToggleSidebar: toggleSidebar,
    onToggleSettings: toggleSettings,
    onOpenWorkspace: () => void pickWorkspace(),
    onNewInstance: () => void invoke("spawn_new_instance"),
    onNewSession: () => {
      const last = getLastWorkspace();
      if (last) {
        const all = getAllWorkspaces();
        const exists = all.some((d) => normWorkspace(d) === normWorkspace(last));
        if (exists) { void (oc as any).newSession(last); return; }
      }
      void (oc as any).newSession();
    },
    onToggleAgents: toggleAgents,
  });
  usePluginHotkeys({ settings, plugins });

  // voice command routing — transcript/partial handlers, embedded-command
  // yes/no confirmation, capture mode, mic hotkeys + useVoice engine
  const { voice, voiceLive, vdbg, vnote } = useVoiceRouter({
    oc,
    settings,
    update,
    plugins,
    exts,
    themes,
    announce,
    pauseSpeech,
    openSettingsDrawer,
    closeSettings,
    setSbClosed,
  });

  // plugin catalog — prefetch on launch, feeds titlebar dot + dialog + auto-update
  const {
    pluginCatalog,
    catalogLoading,
    catalogError,
    refreshCatalog,
    hasPluginUpdate,
    autoUpdateEnabled,
    toggleAutoUpdate,
  } = usePluginUpdates(plugins);

  // plugin documentation rows for the Info dialog
  const pluginDocs = useMemo(
    () => plugins.flatMap((p) => (p.ext?.info ? [{ name: p.name, info: p.ext.info }] : [])),
    [plugins],
  );

  useEffect(() => {
    localStorage.setItem(SB_W_KEY, String(sbW));
  }, [sbW]);
  useEffect(() => {
    localStorage.setItem(SB_C_KEY, sbClosed ? "1" : "0");
  }, [sbClosed]);
  useEffect(() => {
    localStorage.setItem(windowKey("oc.term.open"), termOpen ? "1" : "0");
  }, [termOpen]);
  // closing the last session unmounts the composer — if it owned focus the
  // keyboard is stranded on a detached node and window shortcuts stop firing.
  // releaseTrapFocus no-ops when focus already landed somewhere live.
  useEffect(() => {
    if (!oc.activeId && !oc.booting) releaseTrapFocus();
  }, [oc.activeId, oc.booting]);

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
    // rAF-coalesced: markdown stream updates mutate the DOM every frame and
    // each burst would otherwise disconnect/re-observe + relayout here
    let moRaf = 0;
    const mo = new MutationObserver(() => {
      if (moRaf) return;
      moRaf = requestAnimationFrame(() => {
        moRaf = 0;
        ro.disconnect();
        observe();
        update();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (moRaf) cancelAnimationFrame(moRaf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [oc.activeId, oc.permission, oc.question, termOpen, sbW, sbClosed, oc.booting]);

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
          onTogglePin={togglePin}
          closeOnX={settings.closeOnX}
          onOpenSettings={openSettings}
          onOpenPlugins={openPlugins}
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
            updateNotify={updateNotify}
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
            collapsed={sbClosed}
            loading={oc.booting}
            resizing={resizing}
            onToggle={sbOnToggle}
            onStartResize={startResize}
            onNew={sbOnNew}
            onOpen={sbOnOpen}
            onDelete={sbOnDelete}
            onClearAll={sbOnClearAll}
            onClearForDir={sbOnClearForDir}
            onRename={sbOnRename}
            onDuplicate={sbOnDuplicate}
            onTogglePin={sbOnTogglePin}
            isPinned={sbIsPinned}
            getDirForSession={sbGetDir}
            refreshSessions={sbRefresh}
            toggleSidebarHotkey={settings.hotkeys.toggleSidebar}
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
                  {t("chat.emptyNoSession").split("\n")[0]}
                  <br />
                  {t("chat.emptyNoSession").split("\n")[1] || ""}
                </p>
              </div>
            )}
            {(oc.activeId || oc.booting) && (
              <>
                <MessageList
                  msgs={oc.msgs}
                  busy={oc.busy}
                  compacting={oc.compacting}
                  loading={oc.booting}
                  collapsed={settings.collapsed}
                  onRevert={oc.revertTo}
                  onFork={oc.forkFrom}
                  sessionId={oc.activeId}
                  dir={oc.activeId ? ((oc as any).getDirForSession?.(oc.activeId) ?? settings.workspace) : settings.workspace}
                  taskCosts={(oc as any).childTaskCosts}
                  onOpenSubagent={openSubagent}
                  findOpen={chatFindOpen}
                  findQuery={chatFindQuery}
                  findCase={chatFindCase}
                  findCur={chatFindCur}
                  findHits={chatFindHits}
                  onFindHits={setChatFindHits}
                  onFindQueryChange={onFindQueryChange}
                  onFindCaseToggle={onFindCaseToggle}
                  onFindClose={closeChatFind}
                  onFindNext={() => gotoChatFind(chatFindCur + 1)}
                  onFindPrev={() => gotoChatFind(chatFindCur - 1)}
                />
                {oc.revertId && (
                  <div className="revert-banner">
                    <i className="fa-solid fa-clock-rotate-left" />
                    {t("chat.rewind.banner")}
                    <button onClick={oc.unrevert}>
                      <i className="fa-solid fa-rotate-left" />
                      {t("chat.rewind.undo")}
                    </button>
                  </div>
                )}
                {closeHint && (
                  <div className="revert-banner close-confirm">
                    <i className="fa-solid fa-trash-can" />
                    {t("chat.closeConfirm")}
                  </div>
                )}
                {wsCloseHint && (
                  <div className="revert-banner close-confirm">
                    <i className="fa-solid fa-folder-open" />
                    {t("chat.closeWorkspaceConfirm")}
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
                  onToggleDiff={toggleDiff}
                  onToggleTerm={toggleTermCb}
                  onPickWorkspace={pickWorkspaceCb}
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
        <DialogHost oc={oc} />
        {diffOpen && oc.activeId && <DiffPanel sessionId={oc.activeId} dir={(oc as any).getDirForSession?.(oc.activeId) ?? settings.workspace} onClose={() => setDiffOpen(false)} />}
        {subViewer && (
          <SubagentViewer
            sessionId={"id" in subViewer ? subViewer.id : null}
            dir={oc.activeId ? ((oc as any).getDirForSession?.(oc.activeId) ?? settings.workspace) : settings.workspace}
            children={(oc.activeChildren as any[]) ?? []}
            taskCosts={(oc as any).childTaskCosts}
            collapsed={settings.collapsed}
            busy={"id" in subViewer ? oc.busyIds.has(subViewer.id) : false}
            peekSession={oc.peekSession}
            subscribeSession={oc.subscribeSession}
            primeSession={oc.primeSession}
            peekQuestion={oc.peekQuestion}
            subscribeQuestion={oc.subscribeQuestion}
            answerQuestionFor={oc.answerQuestionFor}
            rejectQuestionFor={oc.rejectQuestionFor}
            peekPermission={oc.peekPermission}
            subscribePermission={oc.subscribePermission}
            respondToPermissionFor={oc.respondToPermissionFor}
            onPick={(id) => setSubViewer({ id })}
            onClose={() => setSubViewer(null)}
          />
        )}
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
          onOpenSubagent={openSubagent}
          activeId={oc.activeId}
          msgs={oc.msgs as any}
          activeChildren={oc.activeChildren as any}
          childTaskCosts={oc.childTaskCosts as any}
          toggleAgentsHotkey={settings.hotkeys.toggleAgents}
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
