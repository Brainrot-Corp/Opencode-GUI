import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getDirectory,
  opencode,
  tempSession,
  dropSession,
  withDeadline,
} from "../api";
import { playSound } from "../lib/sounds";
import { pushToast } from "./useToast";
import { splitModel } from "../lib/models";
import {
  buildEnumPhrase,
  cleanSpeech,
  full_text,
  lowVariantFor,
  playWav,
  wordCount,
} from "../lib/speechText";
import type { AppSettings } from "./useSettings";
import type { Msg, PermAsk, ProviderGroup } from "../types";

// slice of the main hook the speech system reads
type SpeechOc = {
  msgs: Msg[];
  busy: boolean;
  permission: PermAsk | null;
  providers: ProviderGroup[];
};

// spoken replies + working narration + debrief — everything that comes out
// of the piper voice. Owns the single TTS FIFO queue; callers only ever
// queue (or pause). Speech is OFF → total silence, no exceptions.
export function useSpeech(oc: SpeechOc, settings: AppSettings) {
  const [talking, setTalking] = useState(false); // TTS queue draining / audio audible
  const [debriefing, setDebriefing] = useState(false);

  // speak-replies: narrate each finished assistant message (code stripped).
  // seenLive gates it: only messages that streamed while this view watched
  // them may speak after the fact — switching/restoring a session stays
  // silent no matter how recent its history is
  const lastSpoken = useRef("");
  // assistant messages watched streaming in the current view — the only ones
  // the fallback may read; restored/session history never qualifies
  const seenLive = useRef<Set<string>>(new Set());
  const replyAudio = useRef<HTMLAudioElement | null>(null);

  // queued speech — sentences awaiting piper playback
  const ttsQ = useRef<string[]>([]);
  const ttsPumping = useRef(false);
  const ttsHushed = useRef(false); // user hit stop-speech: mute this reply's rest
  const pendingEnum = useRef<string | null>(null); // "*" = enumeration waiting for pump to free
  const pendingAnswers = useRef<string[]>([]); // answer sentences waiting behind pendingEnum
  const settingsNow = useRef(settings);
  settingsNow.current = settings;
  const providersRef = useRef(oc.providers);
  providersRef.current = oc.providers;
  // RL-03: cap queue to 8, drop oldest when unbounded — prevents memory blow-up on long turns
  const capQueue = () => {
    while (ttsQ.current.length > 8) ttsQ.current.shift();
  };

  // queued speech — single FIFO, never cuts (debrief's cut is the only cutter)
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
    capQueue();
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
        capQueue();
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
      queueSpeech("One sec — summarizing.");
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
        // hidden temp session on the secondary model
        const { client } = await opencode();
        const sid = await tempSession();
        let summary = "";
        try {
          const [providerID, modelID] = splitModel(secondaryModel);
          // EH-15: read providers via ref at call time, not stale closure — avoids picking non-existent variant 400
          const variant = lowVariantFor(secondaryModel, providersRef.current as any);
          const r = await withDeadline(
            client.session.prompt({
              path: { id: sid },
              body: { parts: [{ type: "text", text: prompt }], model: { providerID, modelID }, ...(variant ? { variant } : {}) },
            }),
            120_000,
            "Summary",
          );
          const parts: any[] = ((r.data as any)?.parts ?? []) as any[];
          summary = parts.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("").trim();
          if (!summary) {
            const alt = (r.data as any)?.message ?? (r.data as any);
            if (Array.isArray(alt?.parts)) summary = alt.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("").trim();
          }
        } finally {
          await dropSession(sid);
        }
        if (summary) queueSpeech(summary);
        else queueSpeech(raw);
      } catch (e) {
        pushToast(String(e));
        queueSpeech(raw);
      }
    },
    [queueSpeech, debriefing],
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
          let bytes: number[] | null = null;
          try {
            bytes = await invoke<number[]>("tts_speak", {
              text: phrase,
              voice: st.ttsVoice,
              speed: st.ttsSpeed,
            });
          } catch (e) {
            pushToast(String(e));
            continue;
          }
          if (!bytes || ttsHushed.current || bytes.length < 1000) continue;
          const a = playWav(bytes, st.ttsVol);
          replyAudio.current = a;
          // BA-06: on error reject instead of silently skipping phrase — surface via toast
          try {
            await new Promise<void>((res, rej) => {
              a.addEventListener("ended", () => res(), { once: true });
              a.addEventListener("pause", () => res(), { once: true });
              a.addEventListener("error", () => rej(new Error("TTS playback failed")), { once: true });
            });
          } catch (e) {
            pushToast(String(e));
          }
        }
      } finally {
        ttsPumping.current = false;
        setTalking(false);
      }
    })();
  };

  // no streaming speech — only when an answer finishes (even mid-turn) we decide
  // to queue it raw or via the commit-model summary, never cutting.
  // tail lookups scan backward in place: msgs identity changes per streaming
  // delta, and [...msgs].reverse() copies the whole history each time
  useEffect(() => {
    let last: Msg | undefined;
    for (let i = oc.msgs.length - 1; i >= 0; i--) {
      if ((oc.msgs[i].info as any).role === "assistant") { last = oc.msgs[i]; break; }
    }
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
    let last: Msg | undefined;
    for (let i = oc.msgs.length - 1; i >= 0; i--) {
      const m = oc.msgs[i];
      if ((m.info as any).role === "assistant" && (m.info as any).time?.completed) { last = m; break; }
    }
    if (!last || last.info.id === lastSpoken.current) return;
    if (!seenLive.current.has(last.info.id)) return;
    lastSpoken.current = last.info.id;
    const raw = full_text(last);
    if (!raw.trim()) return;
    if (wordCount(raw) > 30) void summarizeWithCommitModel(raw);
    else queueSpeech(raw);
  }, [settings.speakReplies, settings.ttsVoice, oc.msgs, debriefing, queueSpeech, summarizeWithCommitModel]);

  // status cues: turn start is spoken via same queued FIFO — never cuts.
  // An explicit announcement REVIVES speech after stop-speech: the stop
  // button only mutes the in-flight drain (queue + current reply), never
  // future requests
  const announce = useCallback(
    (phrase: string) => {
      if (!settings.speakReplies || !settings.ttsVoice) return;
      ttsHushed.current = false;
      queueSpeech(phrase);
    },
    [settings.speakReplies, settings.ttsVoice, queueSpeech],
  );

  // batched tool enumeration — array of tool uses, spoken every 10s
  const toolSeen = useRef<Set<string>>(new Set());
  const toolCounts = useRef<Map<string, number>>(new Map());
  // tail signature of the last collector scan — skips O(parts) rescans on deltas
  const collectorSig = useRef(" init");

  const prevBusy = useRef(false);
  const lastPromptId = useRef("");
  useEffect(() => {
    const rising = oc.busy && !prevBusy.current;
    const falling = !oc.busy && prevBusy.current;
    prevBusy.current = oc.busy;
    // a new live prompt — latest user message changed. Covers back-to-back
    // turns too (drained queue), where busy never visibly rises again.
    let lastUser: Msg | undefined;
    for (let i = oc.msgs.length - 1; i >= 0; i--) {
      if ((oc.msgs[i].info as any).role === "user") { lastUser = oc.msgs[i]; break; }
    }
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
        capQueue();
        pumpTTS();
      }
    }
  }, [oc.busy, oc.msgs, announce]);

  // collector: count distinct tool parts once when they appear (pending/running/completed).
  // ponytail: tail-signature gate — while streaming, tool parts only ever append
  // to the tail message, so an unchanged (count, tailId, tailPartsLen) signature
  // means nothing new to count; a fetch re-shuffle recounts at the next append
  useEffect(() => {
    if (!oc.busy) return;
    const n = oc.msgs.length;
    const tail = oc.msgs[n - 1];
    const sig = `${n}:${(tail as any)?.info?.id ?? ""}:${tail?.parts.length ?? 0}`;
    if (sig === collectorSig.current) return;
    collectorSig.current = sig;
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
      }
    // no speech here — ticker handles it every 10s
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
              capQueue();
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
          capQueue();
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
          if (c) { ttsQ.current.push(c); capQueue(); pumpTTS(); }
        }
        try {
          let secondaryModel = "";
          try {
            secondaryModel = JSON.parse(localStorage.getItem("oc.settings") ?? "{}").secondaryModel ?? "";
          } catch {}
          if (!secondaryModel) {
            { const c = cleanSpeech("Pick a Secondary model in Settings, then try debrief again."); if (c) { ttsQ.current.push(c); capQueue(); pumpTTS(); } }
            window.dispatchEvent(new Event("oc:settings"));
            return;
          }
          const st = settingsNow.current;
          if (!st.ttsVoice) {
            { const c = cleanSpeech("Install a neural voice in Settings, then try debrief again."); if (c) { ttsQ.current.push(c); capQueue(); pumpTTS(); } }
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
            { const c = cleanSpeech("No recent changes or prompts to summarize."); if (c) { ttsQ.current.push(c); capQueue(); pumpTTS(); } }
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
          const sid = await tempSession();
          let summary = "";
          try {
            const [providerID, modelID] = splitModel(secondaryModel);
            const variant = lowVariantFor(secondaryModel, providersRef.current as any);
            const r = await withDeadline(
              client.session.prompt({
                path: { id: sid },
                body: {
                  parts: [{ type: "text", text: prompt }],
                  model: { providerID, modelID },
                  ...(variant ? { variant } : {}),
                },
              }),
              180_000,
              "Debrief",
            );
            const parts: any[] = ((r.data as any)?.parts ?? []) as any[];
            summary = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("").trim();
            if (!summary) {
              // fallback: some SDK shapes nest under data.message
              const alt = (r.data as any)?.message ?? (r.data as any);
              if (Array.isArray(alt?.parts)) summary = alt.parts.filter((p: any)=>p.type==="text").map((p:any)=>p.text).join("").trim();
            }
          } finally {
            await dropSession(sid);
          }
          if (!summary) {
            { const c = cleanSpeech("Debrief had nothing to say."); if (c) { ttsQ.current.push(c); capQueue(); pumpTTS(); } }
            return;
          }
          { const c = cleanSpeech(summary); if (c) { ttsQ.current.push(c); capQueue(); pumpTTS(); } }
        } catch (e) {
          { const c = cleanSpeech(`Debrief failed: ${String(e).slice(0, 200)}`); if (c) { ttsQ.current.push(c); capQueue(); pumpTTS(); } }
        } finally {
          debriefBusy.current = false;
          setDebriefing(false);
        }
      })();
    };
    window.addEventListener("oc:debrief", onDebrief);
    return () => window.removeEventListener("oc:debrief", onDebrief);
  }, []);

  // voice "quiet" command — pause current playback without clearing the queue
  const pauseSpeech = useCallback(() => {
    replyAudio.current?.pause();
  }, []);

  return { talking, debriefing, announce, pauseSpeech };
}
