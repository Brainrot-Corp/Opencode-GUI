import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useVoice, type VdbgKind } from "./useVoice";
import { routeVoice, routerInput, type VoiceAct } from "../lib/voiceRouter";
import { ensureDict } from "../lib/dictWords";
import { playSound } from "../lib/sounds";
import { pushToast, dismissToast } from "../hooks/useToast";
import { matchesEvent } from "../lib/hotkeys";
import type { AppSettings } from "./useSettings";
import type { RouterExt } from "../lib/voiceRouter";

// slice of the main hook the voice router drives
type VoiceOc = {
  newSession: (dir?: string) => unknown;
  abort: () => unknown;
  cycleAgent: () => void;
  submit: (text: string) => unknown;
  cmdList: { name: string }[];
};

export const VD_TAG: Record<VdbgKind, string> = { act: "cmd", say: "heard", warn: "!!", hint: "·" };

// voice command routing — translates whisper transcripts into acts, runs
// them, and mediates yes/no confirmation for embedded commands. Owns the
// mic (useVoice) and its hotkeys; callers only render the debug/note UI.
export function useVoiceRouter(opts: {
  oc: VoiceOc;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  plugins: { id: string; ext: { describe?: (a: unknown) => string; exec?: (a: unknown) => Promise<string | void> | string | void; requiresConfirmation?: boolean | ((a: unknown) => boolean) } | null }[];
  exts: RouterExt[];
  themes: { id: string }[];
  announce: (s: string) => void;
  pauseSpeech: () => void;
  openSettingsDrawer: () => void;
  closeSettings: () => void;
  setSbClosed: (v: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const { oc, settings, update, plugins, exts, themes, announce, pauseSpeech, openSettingsDrawer, closeSettings, setSbClosed } = opts;

  // spoken rendering of a voice act — used to read embedded commands back
  // before they run
  const extById = useMemo(
    () => Object.fromEntries(plugins.filter((p) => p.ext).map((p) => [p.id, p.ext!])),
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
    [extById],
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

  // debug transcript mode (Settings › Voice): structured audit trail —
  // colored kind tag + short message, newest at the bottom
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

  return { voice, voiceLive, vdbg, vnote };
}
