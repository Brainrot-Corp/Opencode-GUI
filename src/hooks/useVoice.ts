import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pushToast } from "./useToast";
import VADBuilder, { VADMode, VADEvent } from "@ozymandiasthegreat/vad";
import type { VAD } from "@ozymandiasthegreat/vad";

export type VoicePhase = "idle" | "recording" | "transcribing";

// debug-transcript line kinds — act = command fired, say = whisper output,
// warn = engine/fallback trouble, hint = faint housekeeping
export type VdbgKind = "act" | "say" | "warn" | "hint";

const RATE = 16000; // whisper's required sample rate — AudioContext resamples

// hands-free VAD defaults
const SILENCE_MS = 900; // pause length that ends an utterance
const MIN_SPEECH_MS = 350; // shorter voiced blips are ignored
const PRE_CHUNKS = 5; // pre-roll ring so word onsets don't clip
const FRAME = 480; // 30ms @ 16k — one WebRTC VAD frame (libfvad)
// sensitivity slider (0..1) → libfvad aggressiveness mode (3..0):
// higher sensitivity = lenient detector (fewer misses, more noise)
export const MODE_FOR = (sens: number) =>
  Math.max(0, Math.min(3, Math.round((1 - sens) * 3)));
// energy floor kept only for the TTS barge-in detector — speech on/off is
// decided by the VAD, not by level
export const THRESH_FOR = (sens: number) => 0.03 - sens * 0.028;

// libfvad (WebRTC VAD) wasm — one constructor per aggressiveness mode, built
// once and reused. onaudioprocess is sync, so every mode the slider can pick
// must exist before the first chunk arrives
let vadClass: typeof VAD | null = null;
const vadByMode = new Map<number, VAD>();
async function buildVads() {
  vadClass = await VADBuilder();
  for (let m = 0; m <= 3; m++) {
    if (!vadByMode.has(m)) vadByMode.set(m, new vadClass!(m as VADMode, RATE));
  }
}

// Float32 samples → 16-bit mono PCM WAV (44-byte header + data)
function f32ToWav(samples: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ws = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function merge(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return all;
}

function rms(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / chunk.length);
}

export function useVoice(
  onResult: (text: string) => void,
  model: string,
  sens = 0.7,
  gpu = false,
  debug?: (kind: VdbgKind, msg: string) => void,
  multilingual = false,
  onPartial?: (partial: string) => boolean,
) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  // streaming = always-on mic: pauses are cut into utterances automatically
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  // live VAD tuning — read per audio chunk so slider changes apply instantly
  // without restarting the stream
  const vadRef = useRef({
    pauseMs: SILENCE_MS,
    thresh: THRESH_FOR(sens),
    mode: MODE_FOR(sens),
  });
  vadRef.current = { pauseMs: SILENCE_MS, thresh: THRESH_FOR(sens), mode: MODE_FOR(sens) };
  // recording machinery lives in refs so start/stop closures stay stable
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  // sub-frame carry: chunks aren't multiples of the 30ms VAD frame, so the
  // rolling remainder waits here for the next chunk
  const carryRef = useRef<Float32Array>(new Float32Array(0));
  const gpuRef = useRef(gpu);
  gpuRef.current = gpu;
  // debug transcript (Settings › Voice): VAD-level transitions land in the
  // same log as the utterance audits — ref-backed so onAudio closures see
  // the latest flag without re-wiring the audio graph
  const dbgRef = useRef(debug);
  dbgRef.current = debug;
  // multilingual mode: the main pass runs whisper's translate task so the
  // (English-only) router always sees English text
  const mlRef = useRef(multilingual);
  mlRef.current = multilingual;
  // rolling buffer: every spoken chunk lands here regardless of utterance
  // state — the partial tick transcribes it mid-speech so one-shot commands
  // fire without waiting for a pause. Cleared ("forgotten") after a command
  // fires or when the authoritative utterance-close pass takes over
  const rollRef = useRef<Float32Array[]>([]);
  const rollMsRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  // partial tick yields to the authoritative utterance-close pass (busyRef)
  // and to itself; the close pass never yields to a partial
  const busyRef = useRef(false);
  const tickRef = useRef<number | null>(null);
  // early command firing — ChatPage routes the partial and returns whether
  // it fired (ref-backed so the tick closure sees the latest wiring)
  const partialRef = useRef(onPartial);
  partialRef.current = onPartial;
  // engine reported in the debug transcript only when it changes — per
  // utterance it would be noise
  const engineRef = useRef("");
  // stream-mode VAD state
  const uttRef = useRef<Float32Array[]>([]);
  const preRef = useRef<Float32Array[]>([]);
  const speechMsRef = useRef(0);
  const silenceMsRef = useRef(0);
  // TTS echo gate state: hands-free must not transcribe our own spoken
  // replies — AEC subtracts most of it, the raised barge threshold mops up
  const ttsSpeakingRef = useRef(false);
  const ttsUntilRef = useRef(0);
  // sustained-loud time while a reply is playing (barge-in detector)
  const bargeMsRef = useRef(0);
  // last utterance's encoded wav — kept so a routing miss can re-run it
  // through whisper's translate task without re-recording
  const lastWavRef = useRef<Uint8Array | null>(null);
  // BA-04 watchdog: ScriptProcessorNode stalls after ~2-4min or tab hidden
  const watchdogRef = useRef<number | null>(null);
  const lastProcessRef = useRef(0);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // true while speech synthesis is audible (+ grace tail for speaker reverb)
  const ttsActive = useCallback(() => {
    const s = window.speechSynthesis;
    if (!s) return false;
    if (s.speaking) {
      ttsSpeakingRef.current = true;
      return true;
    }
    if (ttsSpeakingRef.current) {
      ttsSpeakingRef.current = false;
      ttsUntilRef.current = Date.now() + 500;
      return true;
    }
    return Date.now() < ttsUntilRef.current;
  }, []);

  // piper playback (playWav) announces itself here — gate through its tail
  // so hands-free never transcribes our own spoken replies
  useEffect(() => {
    const live = (e: Event) => {
      const ms = (e as CustomEvent<number>).detail || 3000;
      ttsUntilRef.current = Date.now() + ms + 500;
    };
    window.addEventListener("oc:tts-live", live);
    return () => window.removeEventListener("oc:tts-live", live);
  }, []);

  // drop everything buffered — after a command fires, on utterance close and
  // on teardown, so nothing is ever transcribed or fired twice
  const forget = useCallback(() => {
    rollRef.current = [];
    rollMsRef.current = 0;
    uttRef.current = [];
    preRef.current = [];
    speechMsRef.current = 0;
    silenceMsRef.current = 0;
  }, []);

  const teardown = useCallback(() => {
    lastWavRef.current = null;
    if (tickRef.current != null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (watchdogRef.current != null) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    srcRef.current?.disconnect();
    srcRef.current = null;
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    forget();
    carryRef.current = new Float32Array(0);
    bargeMsRef.current = 0;
  }, [forget]);

  useEffect(() => () => teardown(), [teardown]);

  const vdbg = useCallback((kind: VdbgKind, msg: string) => dbgRef.current?.(kind, msg), []);

  // feed a chunk's complete 30ms frames through the WebRTC VAD (libfvad
  // wasm); returns how many frames were voiced. Sub-frame remainder rolls
  // into the next chunk via carryRef
  const vadVoiced = useCallback((ch: Float32Array): number => {
    const v = vadByMode.get(vadRef.current.mode);
    if (!v) return 0;
    const carry = carryRef.current;
    const all = new Float32Array(carry.length + ch.length);
    all.set(carry);
    all.set(ch, carry.length);
    const n = Math.floor(all.length / FRAME);
    carryRef.current = all.slice(n * FRAME);
    if (!n) return 0;
    let voiced = 0;
    for (let i = 0; i < n; i++) {
      // one exactly-sized Int16Array per frame — processFrame copies the
      // frame's whole .buffer, so a subarray view of the merged chunk would
      // overflow the wasm heap copy and kill onaudioprocess
      const pcm = vadClass!.floatTo16BitPCM(all.subarray(i * FRAME, (i + 1) * FRAME));
      if (v.processFrame(pcm) === VADEvent.VOICE) voiced++;
    }
    return voiced;
  }, []);

  const transcribe = useCallback(
    async (all: Float32Array) => {
      if (all.length < RATE * 0.2) {
        // BA-05: 0.5s floor discarded short commands like "clear"/"stop" — lower to 200ms
        pushToast("utterance too short — ignored", { variant: "info", ttl: 2000 });
        return;
      }
      setPhase("transcribing");
      const wav = f32ToWav(all);
      lastWavRef.current = wav;
      try {
        const out = await invoke<{ text: string; engine: string; note: string }>(
          "voice_transcribe",
          {
            audio: Array.from(wav),
            model,
            translate: mlRef.current,
            gpu: gpuRef.current,
          },
        );
        if (out.note) vdbg("warn", `engine fallback — ${out.note}`);
        else if (out.engine !== engineRef.current) {
          engineRef.current = out.engine;
          vdbg("hint", `engine: ${out.engine}`);
        }
        if (out.text.trim()) onResult(out.text.trim());
      } catch (e) {
        setError(String(e));
      } finally {
        // mic torn down mid-transcribe (user toggled off) → back to idle
        setPhase(ctxRef.current ? "recording" : "idle");
      }
    },
    [onResult, model, vdbg],
  );

  // multilingual mode's retry: the main pass already ran whisper's translate
  // task, so this re-runs the same audio natively (source language) — gives
  // the router a second shot when the translation mangled an English command
  const retranscribe = useCallback(async (): Promise<string | null> => {
    const wav = lastWavRef.current;
    if (!wav) return null;
    try {
      const out = await invoke<{ text: string; engine: string; note: string }>(
        "voice_transcribe",
        {
          audio: Array.from(wav),
          model,
          translate: !mlRef.current,
          gpu: gpuRef.current,
        },
      );
      return out.text.trim() || null;
    } catch {
      return null;
    }
  }, [model]);

  const stop = useCallback(async () => {
    teardown();
    setStreaming(false);
    setPhase("idle");
  }, [teardown]);

  // close the open utterance when silence settles — the authoritative pass:
  // full context, best accuracy, handles args and embedded commands
  const closeUtterance = useCallback(() => {
    const seg = uttRef.current;
    const spoke = speechMsRef.current >= MIN_SPEECH_MS;
    const voicedMs = Math.round(speechMsRef.current);
    forget();
    if (seg.length && spoke) {
      vdbg("hint", `closed · ${(voicedMs / 1000).toFixed(1)}s voiced`);
      void transcribe(merge(seg));
    } else if (seg.length) {
      vdbg("hint", "dropped — too short");
    }
  }, [transcribe, vdbg, forget]);

  // rolling partial pass, ~every 1.4s while speech is active: transcribes the
  // rolling buffer mid-speech; when the router fires a one-shot command the
  // whole buffer is forgotten so the words can't fire twice. Non-command
  // partials are deliberately discarded — the utterance-close pass is what
  // produces the final text (args, embedded, dictation all live there)
  const partialTick = useCallback(() => {
    if (busyRef.current || !ctxRef.current) return;
    if (Date.now() - lastVoiceAtRef.current > 1600) return; // nobody talking
    if (rollMsRef.current < 1700) return; // not enough new audio yet
    // keep the window bounded — whisper cost grows with length
    while (rollMsRef.current > 12000 && rollRef.current.length > 1) {
      const head = rollRef.current[0]!;
      rollMsRef.current -= (head.length / RATE) * 1000;
      rollRef.current = rollRef.current.slice(1);
    }
    const wav = f32ToWav(merge(rollRef.current));
    busyRef.current = true;
    invoke<{ text: string; engine: string; note: string }>("voice_transcribe", {
      audio: Array.from(wav),
      model,
      translate: mlRef.current,
      gpu: gpuRef.current,
    })
      .then((out) => {
        const text = out.text.trim();
        if (!text) return;
        vdbg("say", text);
        if (partialRef.current?.(text)) forget();
      })
      .catch(() => {})
      .finally(() => {
        busyRef.current = false;
      });
  }, [model, vdbg, forget]);

  const toggle = useCallback(() => {
    // any live mic (recording, or mid-transcribe) toggles off;
    // this also stops the click-during-transcribe double-stream race
    if (phase !== "idle" || streaming) {
      void stop();
      return;
    }
    setError("");
    // don't transcribe our own voice output
    window.speechSynthesis?.cancel();
    (async () => {
      try {
        // gate before getUserMedia so an uninstalled engine can't prompt for
        // the mic or record into a void — single check covers all callers
        const st = await invoke<{ bin: boolean; models: string[] }>("voice_status").catch(() => null);
        if (!st?.bin) {
          setError("voice engine not installed — set it up in Settings › Voice");
          return;
        }
        if (!st.models.includes(model)) {
          setError(`model ${model} isn't downloaded — pick or fetch one in Settings › Voice`);
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          // explicit AEC — Chromium subtracts the page's own audio output
          // (piper playback) from the mic, so talking during a reply is
          // captured instead of gated away
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const ctx = new AudioContext({ sampleRate: RATE });
        const src = ctx.createMediaStreamSource(stream);
        // the VAD wasm instances must exist before the first chunk lands —
        // onaudioprocess is sync
        try {
          await buildVads();
        } catch {
          setError("voice VAD failed to load — try restarting the app");
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close().catch(() => {});
          return;
        }
        lastProcessRef.current = Date.now();
        const onAudio = (e: AudioProcessingEvent) => {
          lastProcessRef.current = Date.now();
          const ch = new Float32Array(e.inputBuffer.getChannelData(0));
          const level = rms(ch);
          const chunkMs = (ch.length / RATE) * 1000;
          // a reply is playing: AEC removes most of our own voice, so quiet
          // residue is discarded — but sustained loud input is a real person
          // talking over the reply → barge in (stop playback, keep listening)
          // ponytail: threshold = 2× VAD + floor, retune the constants if it
          // ever self-interrupts on loud speakers or needs shouting over
          if (ttsActive()) {
            const bargeThresh = Math.max(vadRef.current.thresh * 2, 0.05);
            if (level >= bargeThresh) {
              bargeMsRef.current += chunkMs;
              if (bargeMsRef.current >= 250) {
                bargeMsRef.current = 0;
                vdbg("warn", "barge-in — reply cancelled");
                ttsUntilRef.current = Date.now(); // kill our grace window too
                ttsSpeakingRef.current = false;
                window.speechSynthesis?.cancel();
                window.dispatchEvent(new Event("oc:tts-stop"));
                // seed the utterance from the pre-roll ring so word onsets
                // recorded before the interrupt survive
                if (!uttRef.current.length && preRef.current.length) {
                  uttRef.current = preRef.current;
                  preRef.current = [];
                }
              }
            } else {
              bargeMsRef.current = Math.max(0, bargeMsRef.current - chunkMs / 2);
            }
            preRef.current.push(ch);
            if (preRef.current.length > PRE_CHUNKS) preRef.current.shift();
            return;
          }
          bargeMsRef.current = 0;
          // everything spoken lands in the rolling buffer for the partial tick
          rollRef.current.push(ch);
          rollMsRef.current += chunkMs;
          // VAD: rolling 30ms frames through the WebRTC detector — any voiced
          // frame is speech. Quiet before speech fills the pre-roll ring;
          // speech opens an utterance; pauseMs of trailing quiet closes it
          const voiced = vadVoiced(ch);
          const speech = voiced > 0;
          if (speech) lastVoiceAtRef.current = Date.now();
          if (!uttRef.current.length && !speech) {
            preRef.current.push(ch);
            if (preRef.current.length > PRE_CHUNKS) preRef.current.shift();
            return;
          }
          if (!uttRef.current.length) {
            uttRef.current = preRef.current;
            preRef.current = [];
          }
          uttRef.current.push(ch);
          if (speech) {
            speechMsRef.current += (voiced * FRAME * 1000) / RATE;
            silenceMsRef.current = 0;
          } else {
            silenceMsRef.current += chunkMs;
            if (silenceMsRef.current >= vadRef.current.pauseMs) closeUtterance();
          }
        };
        // 2048 = 128ms chunks: finer VAD/close granularity, still cheap
        const node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = onAudio;
        src.connect(node);
        node.connect(ctx.destination); // ScriptProcessor only runs when wired to output
        streamRef.current = stream;
        ctxRef.current = ctx;
        nodeRef.current = node;
        srcRef.current = src;
        // BA-04 watchdog: ScriptProcessorNode stalls after visibility change / 2-4min
        if (watchdogRef.current != null) clearInterval(watchdogRef.current);
        watchdogRef.current = window.setInterval(() => {
          if (Date.now() - lastProcessRef.current <= 1000) return;
          const c2 = ctxRef.current;
          const s2 = streamRef.current;
          const src2 = srcRef.current;
          const old = nodeRef.current;
          if (!c2 || !s2 || !src2 || !old) return;
          if (c2.state === "closed") return;
          try {
            old.disconnect();
          } catch {}
          try {
            const repl = c2.createScriptProcessor(2048, 1, 1);
            repl.onaudioprocess = onAudio;
            src2.connect(repl);
            repl.connect(c2.destination);
            nodeRef.current = repl;
            lastProcessRef.current = Date.now();
          } catch {}
        }, 1000);
        // rolling partial transcribe tick — one-shot commands fire mid-speech
        if (tickRef.current != null) clearInterval(tickRef.current);
        tickRef.current = window.setInterval(partialTick, 1400);
        setStreaming(true);
        setPhase("recording");
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [phase, streaming, stop, model, closeUtterance, ttsActive, partialTick]);

  return { phase, streaming, error, toggle, retranscribe };
}
