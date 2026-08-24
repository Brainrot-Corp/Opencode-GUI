import { useCallback, useEffect, useRef, useState } from "react";
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
import { routeVoice } from "../lib/voiceRouter";
import { pickWorkspace } from "../lib/workspace";
import { playSound } from "../lib/sounds";
import { getDirectory, opencode } from "../api";
import { splitModel } from "../lib/models";
import type { Msg } from "../types";

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
  // tell the voice hook piper is audible so hands-free VAD gates its echo
  a.addEventListener("play", () => {
    const ms = Number.isFinite(a.duration) ? a.duration * 1000 : 3000;
    window.dispatchEvent(new CustomEvent<number>("oc:tts-live", { detail: ms }));
  });
  void a.play().catch(() => a.dispatchEvent(new Event("error")));
  return a;
}

// all text-part content of a message, joined — streaming deltas included
function full_text(m: Msg): string {
  return m.parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join(" ");
}

// batched enumeration keeps the old cue strings only as fallback documentation
// (per-tool immediate speech replaced by 10s roll-up — see buildEnumPhrase)

// batched enumeration labels — used to build "read 3 times, wrote 1 time…" phrases
const ENUM_LABELS: Record<string, string> = {
  read: "read",
  write: "wrote",
  edit: "edited",
  multiedit: "edited",
  patch: "patched",
  bash: "ran commands",
  grep: "searched",
  glob: "found files",
  list: "listed files",
  webfetch: "fetched pages",
  websearch: "searched the web",
  task: "delegated",
  todowrite: "planned",
  question: "asked",
};
function buildEnumPhrase(counts: Map<string, number>): string {
  if (!counts.size) return "";
  const parts: string[] = [];
  for (const [tool, n] of counts) {
    const label = ENUM_LABELS[tool] ?? tool;
    parts.push(`${label} ${n} time${n === 1 ? "" : "s"}`);
  }
  if (parts.length === 1) return `${parts[0]}.`;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}.`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
function lowVariantFor(modelSel: string, providers: { id: string; models: { id: string; variants?: string[] }[] }[]): string | undefined {
  const i = modelSel.indexOf("/");
  const pid = i < 0 ? modelSel : modelSel.slice(0, i);
  const mid = i < 0 ? "" : modelSel.slice(i + 1);
  const prov = providers.find((g) => g.id === pid);
  const m = prov?.models.find((x) => x.id === mid);
  const vars = m?.variants ?? [];
  if (vars.includes("low")) return "low";
  if (vars.includes("minimal")) return "minimal";
  if (vars.includes("fast")) return "fast";
  return undefined;
}

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
  const [debriefing, setDebriefing] = useState(false);
  const [talking, setTalking] = useState(false); // TTS queue draining / audio audible
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
        case "clear":
          window.dispatchEvent(new Event("oc:voice-clear"));
          break;
        case "quiet":
          replyAudio.current?.pause();
          break;
        case "shut":
          window.dispatchEvent(new Event("oc:tts-stop"));
          break;
        case "debrief":
          window.dispatchEvent(new Event("oc:debrief"));
          break;
        case "hearCheck":
          announce("Yes, I can hear you.");
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

  // speak-replies: narrate each finished assistant message (code stripped).
  // seenLive gates it: only messages that streamed while this view watched
  // them may speak after the fact — switching/restoring a session stays
  // silent no matter how recent its history is
  const lastSpoken = useRef("");
  // assistant messages watched streaming in the current view — the only ones
  // the fallback may read; restored/session history never qualifies
  const seenLive = useRef<Set<string>>(new Set());
  const replyAudio = useRef<HTMLAudioElement | null>(null);

  // queued speech — answers are only queued when an assistant message finishes
  const streamTTS = useRef({ id: "", consumed: 0 });
  const ttsQ = useRef<string[]>([]); // sentences awaiting piper playback
  const ttsPumping = useRef(false);
  const ttsHushed = useRef(false); // user hit stop-speech: mute this reply's rest
  const pendingEnum = useRef<string | null>(null); // "*" = enumeration waiting for pump to free
  const pendingAnswers = useRef<string[]>([]); // answer sentences waiting behind pendingEnum
  const settingsNow = useRef(settings);
  settingsNow.current = settings;

  // markdown scrub for mid-stream narration — complete code blocks become a
  // placeholder, an open fence holds its text back until it closes
  const cleanSpeech = (s: string) =>
    s
      .replace(/```[\s\S]*?```/g, " code block omitted. ")
      .replace(/```[\s\S]*$/, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/\s{2,}/g, " ")
      .trim();

  // queued speech — single FIFO, never cuts (debrief's speakNow is the only cutter)
  // if an answer is queued while an enumeration is pending, flush both together
  const flushPendingEnum = useCallback(() => {
    if (!pendingEnum.current) return;
    const busy =
      ttsPumping.current ||
      ttsQ.current.length > 0 ||
      (replyAudio.current && !replyAudio.current.paused);
    if (busy) return;
    pendingEnum.current = null;
    const toSay = cleanSpeech(buildEnumPhrase(toolCounts.current));
    if (toSay) ttsQ.current.push(toSay);
    if (pendingAnswers.current.length) {
      ttsQ.current.push(...pendingAnswers.current);
      pendingAnswers.current = [];
    }
    // spoken — next enumeration reports only what happened after this
    toolCounts.current.clear();
    pumpTTS();
  }, []);
  const queueSpeech = useCallback(
    (phrase: string) => {
      const cleaned = cleanSpeech(phrase);
      if (!cleaned || ttsHushed.current) return;
      if (pendingEnum.current) {
        pendingAnswers.current.push(cleaned);
        // answer arrived while enumeration pending — flush both as soon as pump is free
        flushPendingEnum();
      } else {
        ttsQ.current.push(cleaned);
        pumpTTS();
      }
    },
    [flushPendingEnum],
  );

  // summarize a long answer (>30 words) via the secondary model (same as debrief)
  const summarizeWithCommitModel = useCallback(
    async (raw: string) => {
      if (ttsHushed.current || debriefing) return;
      let secondaryModel = "";
      try {
        secondaryModel = JSON.parse(localStorage.getItem("oc.settings") ?? "{}").secondaryModel ?? "";
      } catch {}
      const st = settingsNow.current;
      if (!st.ttsVoice) return;
      if (!secondaryModel) {
        // no model → fall back to queuing raw (short enough to speak directly)
        queueSpeech(raw);
        return;
      }
      // announce waiting for answer — queued, never cuts
      queueSpeech("Summarizing...");
      const rawVoice = st.ttsVoice.replace(/\.onnx$/, "");
      const locale = rawVoice.split("-")[0] || "en_US";
      const langHint =
        locale.startsWith("fr") ? "French" :
        locale.startsWith("de") ? "German" :
        locale.startsWith("es") ? "Spanish" :
        locale.startsWith("zh") ? "Chinese" :
        locale.startsWith("pt") ? "Portuguese" :
        locale.startsWith("pl") ? "Polish" :
        locale.startsWith("en_GB") ? "British English" : "English";
      const prompt =
        `You are an ultra-concise spoken-summary assistant. Summarize the ASSISTANT ANSWER below in a single short paragraph, spoken aloud. ` +
        `Keep total under 30 words, 1-2 short sentences, only the essential outcome. Be extremely terse, no filler, no intro, no repetition. ` +
        `Respond in ${langHint} (locale ${locale}, TTS voice ${rawVoice}). No markdown, no bullets, no code, no preface.` +
        `\n\nASSISTANT ANSWER:\n${raw.slice(0, 12000)}`;
      try {
        const { client } = await opencode();
        const s = await client.session.create({ body: {} });
        const sid = (s.data as any).id as string;
        let summary = "";
        try {
          const [providerID, modelID] = splitModel(secondaryModel);
          const variant = lowVariantFor(secondaryModel, oc.providers as any);
          const r = await client.session.prompt({
            path: { id: sid },
            body: { parts: [{ type: "text", text: prompt }], model: { providerID, modelID }, ...(variant ? { variant } : {}) },
          });
          const parts: any[] = ((r.data as any)?.parts ?? []) as any[];
          summary = parts.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("").trim();
          if (!summary) {
            const alt = (r.data as any)?.message ?? (r.data as any);
            if (Array.isArray(alt?.parts)) summary = alt.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("").trim();
          }
        } finally {
          await client.session.delete({ path: { id: sid } }).catch(() => {});
        }
        if (summary) queueSpeech(summary);
        else queueSpeech(raw);
      } catch {
        queueSpeech(raw);
      }
    },
    [queueSpeech, debriefing, oc.providers],
  );

  // serialized synth→play pump; 'pause' resolves alongside 'ended' so the
  // stop-speech button breaks the wait instead of deadlocking the queue
  const pumpTTS = () => {
    if (ttsPumping.current) return;
    ttsPumping.current = true;
    setTalking(true);
    (async () => {
      try {
        while (ttsQ.current.length && !ttsHushed.current) {
          const phrase = ttsQ.current.shift()!;
          const st = settingsNow.current;
          const bytes = await invoke<number[]>("tts_speak", {
            text: phrase,
            voice: st.ttsVoice,
            speed: st.ttsSpeed,
          }).catch(() => null);
          if (!bytes || ttsHushed.current || bytes.length < 1000) continue;
          const a = playWav(bytes, st.ttsVol);
          replyAudio.current = a;
          // 'error'/failed play() must release the wait too, or the pump
          // deadlocks and the queue never drains
          await new Promise<void>((res) => {
            a.addEventListener("ended", () => res(), { once: true });
            a.addEventListener("pause", () => res(), { once: true });
            a.addEventListener("error", () => res(), { once: true });
          });
        }
      } finally {
        ttsPumping.current = false;
        setTalking(false);
      }
    })();
  };

  // no streaming speech — only when an answer finishes (even mid-turn) we decide
  // to queue it raw or via the commit-model summary, never cutting.
  useEffect(() => {
    const last = [...oc.msgs].reverse().find((m) => (m.info as any).role === "assistant");
    if (!last) return;
    const id = last.info.id;
    const info = last.info as any;
    const done = !!info.time?.completed;
    if (!done) {
      seenLive.current.add(id);
      return;
    }
    if (!settings.speakReplies || !settings.ttsVoice) return;
    if (lastSpoken.current === id) return;
    if (debriefing) return; // debrief owns the voice — suppress base message
    if (!seenLive.current.has(id)) return;
    lastSpoken.current = id;
    streamTTS.current = { id: "", consumed: 0 };
    const raw = full_text(last);
    if (!raw.trim()) return;
    if (wordCount(raw) > 30) {
      void summarizeWithCommitModel(raw);
    } else {
      queueSpeech(raw);
    }
  }, [oc.msgs, oc.busy, settings.speakReplies, settings.ttsVoice, debriefing, queueSpeech, summarizeWithCommitModel]);

  // top-bar stop-speech button pauses piper playback from anywhere; the
  // volume slider retunes a running reply via oc:tts-vol
  useEffect(() => {
    const stop = () => {
      ttsHushed.current = true;
      ttsQ.current = []; // nothing queued survives the stop
      replyAudio.current?.pause();
    };
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

  // --- working pulse ----------------------------------------------------------
  // speech is OFF → total silence, no exceptions. While it's ON and a turn
  // runs long with nothing audible, a soft blip every 20s (first at 15s)
  // says "still working" — never a constant noise bed. Any piper playback
  // pushes the next blip out; oc:tts-stop silences them for the turn.
  useEffect(() => {
    if (!oc.busy || !settings.speakReplies) return;
    const beat = () => {
      if (!replyAudio.current || replyAudio.current.paused) playSound("working");
      wait = window.setTimeout(beat, 20000);
    };
    let wait = window.setTimeout(beat, 15000);
    const hush = () => {
      // narration took over — restart the count so we never talk over it
      clearTimeout(wait);
      wait = window.setTimeout(beat, 20000);
    };
    const shut = () => clearTimeout(wait);
    window.addEventListener("oc:tts-live", hush);
    window.addEventListener("oc:tts-stop", shut);
    return () => {
      clearTimeout(wait);
      window.removeEventListener("oc:tts-live", hush);
      window.removeEventListener("oc:tts-stop", shut);
    };
  }, [oc.busy, settings.speakReplies]);
  // fallback for silent completions — same word-count gate, queued never cuts
  useEffect(() => {
    if (!settings.speakReplies || !settings.ttsVoice || ttsHushed.current || debriefing) return;
    const last = [...oc.msgs]
      .reverse()
      .find((m) => (m.info as any).role === "assistant" && (m.info as any).time?.completed);
    if (!last || last.info.id === lastSpoken.current) return;
    if (!seenLive.current.has(last.info.id)) return;
    lastSpoken.current = last.info.id;
    const raw = full_text(last);
    if (!raw.trim()) return;
    if (wordCount(raw) > 30) void summarizeWithCommitModel(raw);
    else queueSpeech(raw);
  }, [settings.speakReplies, settings.ttsVoice, oc.msgs, debriefing, queueSpeech, summarizeWithCommitModel]);

  // status cues: turn start is spoken via same queued FIFO — never cuts
  const announce = useCallback(
    (phrase: string) => {
      if (!settings.speakReplies || !settings.ttsVoice || ttsHushed.current) return;
      queueSpeech(phrase);
    },
    [settings.speakReplies, settings.ttsVoice, queueSpeech],
  );

  // batched tool enumeration — array of tool uses, spoken every 10s
  const toolSeen = useRef<Set<string>>(new Set());
  const toolCounts = useRef<Map<string, number>>(new Map());

  const prevBusy = useRef(false);
  const lastPromptId = useRef("");
  useEffect(() => {
    const rising = oc.busy && !prevBusy.current;
    const falling = !oc.busy && prevBusy.current;
    prevBusy.current = oc.busy;
    // a new live prompt — latest user message changed. Covers back-to-back
    // turns too (drained queue), where busy never visibly rises again.
    const lastUser = [...oc.msgs].reverse().find((m) => (m.info as any).role === "user");
    const newPrompt = !!lastUser && lastUser.info.id !== lastPromptId.current;
    if (lastUser) lastPromptId.current = lastUser.info.id;
    // reset batch on a fresh prompt, but never cut queued voice (only debrief cuts)
    if (newPrompt || rising) {
      if (rising) ttsHushed.current = false; // stop-speech mutes the current reply only
      // seed with tools already in history WITHOUT counting them — clearing
      // toolSeen here makes the collector re-count last turn's parts
      for (const m of oc.msgs)
        for (const p of m.parts ?? []) {
          if ((p as any).type !== "tool") continue;
          toolSeen.current.add(
            String((p as any).id ?? `${m.info.id}:${(p as any).tool}`),
          );
        }
      toolCounts.current.clear();
      pendingEnum.current = null;
      pendingAnswers.current = [];
    }
    if (rising) announce("Thinking.");
    if (falling) {
      // turn done — clear batch so next turn starts fresh
      toolSeen.current.clear();
      toolCounts.current.clear();
      pendingEnum.current = null;
      // flush any answers that were waiting behind a last enumeration
      if (pendingAnswers.current.length) {
        ttsQ.current.push(...pendingAnswers.current);
        pendingAnswers.current = [];
        pumpTTS();
      }
    }
  }, [oc.busy, oc.msgs, announce]);

  // collector: count distinct tool parts once when they appear (pending/running/completed)
  useEffect(() => {
    if (!oc.busy) return;
    let changed = false;
    for (const m of oc.msgs)
      for (const p of m.parts ?? []) {
        if ((p as any).type !== "tool") continue;
        const st = (p as any).state?.status;
        if (st !== "running" && st !== "pending" && st !== "completed") continue;
        const key = String((p as any).id ?? `${m.info.id}:${(p as any).tool}`);
        if (toolSeen.current.has(key)) continue;
        toolSeen.current.add(key);
        const tool = String((p as any).tool ?? "unknown").toLowerCase();
        toolCounts.current.set(tool, (toolCounts.current.get(tool) ?? 0) + 1);
        changed = true;
      }
    // no speech here — ticker handles it every 10s
    void changed;
  }, [oc.msgs, oc.busy]);

  // ticker: every 10s while busy, speak what happened since the LAST
  // enumeration (counts reset once spoken) — pumpTTS serializes, so a tick
  // that fires mid-speech naturally waits. pendingEnum coalesces rapid ticks.
  // if an answer was queued while pending, flushPendingEnum will have cleared it early.
  useEffect(() => {
    if (!oc.busy || !settings.speakReplies || !settings.ttsVoice) return;
    let timer: number | undefined;
    let disposed = false;
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (disposed || !oc.busy || ttsHushed.current) {
          schedule();
          return;
        }
        const phrase = buildEnumPhrase(toolCounts.current);
        if (!phrase) {
          schedule();
          return;
        }
        const cleaned = cleanSpeech(phrase);
        if (!cleaned) {
          schedule();
          return;
        }
        const busy =
          ttsPumping.current ||
          ttsQ.current.length > 0 ||
          (replyAudio.current && !replyAudio.current.paused);
        if (busy) {
          // coalesce: marker only — the phrase is built fresh at flush time so
          // tools counted while waiting are included, never dropped
          pendingEnum.current = "*";
          const wait = () => {
            if (disposed || ttsHushed.current || !oc.busy) {
              pendingEnum.current = null;
              schedule();
              return;
            }
            const stillBusy =
              ttsPumping.current ||
              ttsQ.current.length > 0 ||
              (replyAudio.current && !replyAudio.current.paused);
            if (stillBusy) {
              window.setTimeout(wait, 150);
              return;
            }
            if (pendingEnum.current) {
              pendingEnum.current = null;
              // both enumerations and answers share the same FIFO — this enqueues
              // behind any narrative that was queued while we waited
              ttsQ.current.push(cleanSpeech(buildEnumPhrase(toolCounts.current)));
              if (pendingAnswers.current.length) {
                ttsQ.current.push(...pendingAnswers.current);
                pendingAnswers.current = [];
              }
              // spoken — next enumeration reports only what happened after this
              toolCounts.current.clear();
              pumpTTS();
            }
            schedule();
          };
          wait();
        } else {
          ttsQ.current.push(cleaned);
          if (pendingAnswers.current.length) {
            ttsQ.current.push(...pendingAnswers.current);
            pendingAnswers.current = [];
          }
          // spoken — next enumeration reports only what happened after this
          toolCounts.current.clear();
          pumpTTS();
          schedule();
        }
      }, 10000);
    };
    schedule();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      pendingEnum.current = null;
    }
  }, [oc.busy, settings.speakReplies, settings.ttsVoice]);

  // permission popup opened — say what needs approval (once per ask)
  const lastPermId = useRef("");
  useEffect(() => {
    if (!oc.permission || oc.permission.id === lastPermId.current) return;
    lastPermId.current = oc.permission.id;
    announce(`Permission needed: ${oc.permission.title}.`);
  }, [oc.permission, announce]);

  // --- debrief (voice "debrief" + /debrief) — speech only, 2 paragraphs max ----------
  // uses the secondary model (settings.secondaryModel) and speaks the
  // summary in the TTS voice locale, via the single piper queue (pumpTTS)
  const msgsRef = useRef(oc.msgs);
  msgsRef.current = oc.msgs;
  const debriefBusy = useRef(false);
  const speakNow = useCallback(
    (phrase: string) => {
      const cleaned = cleanSpeech(phrase);
      if (!cleaned) return;
      ttsHushed.current = false;
      // interrupt whatever is talking — debrief is user-initiated
      ttsQ.current = [];
      replyAudio.current?.pause();
      ttsQ.current.push(cleaned);
      pumpTTS();
    },
    // cleanSpeech/pumpTTS are stable closures over refs
    [],
  );
  void speakNow; // kept for manual debrief cut elsewhere; queued paths use ttsQ directly
  // working pulse for debrief — same heartbeat as thinking, but every 5s
  useEffect(() => {
    if (!debriefing) return;
    // request sent cue
    playSound("working");
    const id = window.setInterval(() => playSound("working"), 5000);
    return () => clearInterval(id);
  }, [debriefing]);
  useEffect(() => {
    const onDebrief = () => {
      void (async () => {
        if (debriefBusy.current) return;
        debriefBusy.current = true;
        setDebriefing(true);
        // debrief cuts everything — clear first, then queue "Debriefing..." as first item
        ttsHushed.current = false;
        ttsQ.current = [];
        pendingEnum.current = null;
        pendingAnswers.current = [];
        replyAudio.current?.pause();
        {
          const c = cleanSpeech("Debriefing...");
          if (c) { ttsQ.current.push(c); pumpTTS(); }
        }
        try {
          let secondaryModel = "";
          try {
            secondaryModel = JSON.parse(localStorage.getItem("oc.settings") ?? "{}").secondaryModel ?? "";
          } catch {}
          if (!secondaryModel) {
            { const c = cleanSpeech("Pick a Secondary model in Settings, then try debrief again."); if (c) { ttsQ.current.push(c); pumpTTS(); } }
            window.dispatchEvent(new Event("oc:settings"));
            return;
          }
          const st = settingsNow.current;
          if (!st.ttsVoice) {
            { const c = cleanSpeech("Install a neural voice in Settings, then try debrief again."); if (c) { ttsQ.current.push(c); pumpTTS(); } }
            return;
          }
          const dir = getDirectory();
          const [diff, log] = await Promise.all([
            invoke<string>("git_diff", { dir, path: "", staged: false }).catch(() => ""),
            invoke<string>("git_log", { dir }).catch(() => ""),
          ]);
          const recent = msgsRef.current
            .filter((m) => (m.info as any).role === "user")
            .slice(-6)
            .map((m) => full_text(m))
            .join("\n---\n")
            .slice(0, 4000);
          const diffTrim = diff.trim().slice(0, 9000);
          const logTrim = log.trim().slice(0, 2000);
          if (!diffTrim && !logTrim && !recent.trim()) {
            { const c = cleanSpeech("No recent changes or prompts to summarize."); if (c) { ttsQ.current.push(c); pumpTTS(); } }
            return;
          }
          // locale from piper voice id: en_US-amy-medium -> en_US
          const rawVoice = st.ttsVoice.replace(/\.onnx$/, "");
          const locale = rawVoice.split("-")[0] || "en_US";
          const langHint =
            locale.startsWith("fr") ? "French" :
            locale.startsWith("de") ? "German" :
            locale.startsWith("es") ? "Spanish" :
            locale.startsWith("zh") ? "Chinese" :
            locale.startsWith("pt") ? "Portuguese" :
            locale.startsWith("pl") ? "Polish" :
            locale.startsWith("en_GB") ? "British English" : "English";
          const prompt =
            `You are a debrief assistant. Summarize WHAT changed and WHY in exactly 2 concise paragraphs max, spoken aloud. ` +
            `Respond in ${langHint} (locale ${locale}, TTS voice ${rawVoice}). No markdown, no bullets, no code, no preface.` +
            `\n\nGIT DIFF (working tree, may be empty):\n${diffTrim || "(empty)"}` +
            `\n\nGIT LOG (last commits):\n${logTrim || "(empty)"}` +
            `\n\nRECENT USER PROMPTS (why, most recent last):\n${recent || "(none)"}`;
          // hidden temp session on the secondary model — same pattern as GitPanel genMsg
          const { client } = await opencode();
          const s = await client.session.create({ body: {} });
          const sid = (s.data as any).id as string;
          let summary = "";
          try {
            const [providerID, modelID] = splitModel(secondaryModel);
            const variant = lowVariantFor(secondaryModel, oc.providers as any);
            const r = await client.session.prompt({
              path: { id: sid },
              body: {
                parts: [{ type: "text", text: prompt }],
                model: { providerID, modelID },
                ...(variant ? { variant } : {}),
              },
            });
            const parts: any[] = ((r.data as any)?.parts ?? []) as any[];
            summary = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
            if (!summary) {
              // fallback: some SDK shapes nest under data.message
              const alt = (r.data as any)?.message ?? (r.data as any);
              if (Array.isArray(alt?.parts)) summary = alt.parts.filter((p: any)=>p.type==="text").map((p:any)=>p.text).join("").trim();
            }
          } finally {
            await client.session.delete({ path: { id: sid } }).catch(() => {});
          }
          if (!summary) {
            { const c = cleanSpeech("Debrief had nothing to say."); if (c) { ttsQ.current.push(c); pumpTTS(); } }
            return;
          }
          { const c = cleanSpeech(summary); if (c) { ttsQ.current.push(c); pumpTTS(); } }
        } catch (e) {
          { const c = cleanSpeech(`Debrief failed: ${String(e).slice(0, 200)}`); if (c) { ttsQ.current.push(c); pumpTTS(); } }
        } finally {
          debriefBusy.current = false;
          setDebriefing(false);
        }
      })();
    };
    window.addEventListener("oc:debrief", onDebrief);
    return () => window.removeEventListener("oc:debrief", onDebrief);
  }, [speakNow, oc.providers]);

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
