import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type VoicePhase = "idle" | "recording" | "transcribing";

const RATE = 16000; // whisper's required sample rate — AudioContext resamples

// hands-free VAD defaults
const SILENCE_MS = 1500; // pause length that ends an utterance
const MIN_SPEECH_MS = 350; // shorter voiced blips are ignored
const PRE_CHUNKS = 5; // ~320ms pre-roll ring so word onsets don't clip
// sensitivity slider (0..1) maps to an rms threshold: lenient → strict
export const THRESH_FOR = (sens: number) => 0.03 - sens * 0.028;

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
  handsFree = false,
  pauseMs = SILENCE_MS,
  sens = 0.7,
) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  // streaming = always-on mic: pauses are cut into utterances automatically
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  // live VAD tuning — read per audio chunk so slider changes apply instantly
  // without restarting the stream
  const vadRef = useRef({ pauseMs, thresh: THRESH_FOR(sens) });
  vadRef.current = { pauseMs, thresh: THRESH_FOR(sens) };
  // recording machinery lives in refs so start/stop closures stay stable
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const modeRef = useRef<"manual" | "stream">("manual");
  // stream-mode VAD state
  const uttRef = useRef<Float32Array[]>([]);
  const preRef = useRef<Float32Array[]>([]);
  const speechMsRef = useRef(0);
  const silenceMsRef = useRef(0);
  // TTS echo gate: hands-free must not transcribe our own spoken replies
  const ttsSpeakingRef = useRef(false);
  const ttsUntilRef = useRef(0);

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

  const teardown = useCallback(() => {
    // back to manual so an in-flight stream utterance's finally can't flip
    // phase back to "recording" after the user switched the mic off
    modeRef.current = "manual";
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    uttRef.current = [];
    preRef.current = [];
    speechMsRef.current = 0;
    silenceMsRef.current = 0;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const transcribe = useCallback(
    async (all: Float32Array) => {
      if (all.length < RATE / 2) return; // sub-half-second click — ignore
      setPhase("transcribing");
      try {
        const wav = f32ToWav(all);
        const text = await invoke<string>("voice_transcribe", {
          audio: Array.from(wav),
          model,
        });
        if (text.trim()) onResult(text.trim());
      } catch (e) {
        setError(String(e));
      } finally {
        setPhase(modeRef.current === "stream" ? "recording" : "idle");
      }
    },
    [onResult, model],
  );

  const stop = useCallback(async () => {
    teardown();
    setStreaming(false);
    setPhase("idle");
    const merged = chunksRef.current;
    chunksRef.current = [];
    await transcribe(merge(merged));
  }, [teardown, transcribe]);

  // stream mode: close the open utterance when silence settles
  const closeUtterance = useCallback(() => {
    const seg = uttRef.current;
    uttRef.current = [];
    const spoke = speechMsRef.current >= MIN_SPEECH_MS;
    speechMsRef.current = 0;
    silenceMsRef.current = 0;
    if (seg.length && spoke) void transcribe(merge(seg));
  }, [transcribe]);

  const toggle = useCallback(() => {
    // busy finishing a manual clip — nothing to toggle
    if (phase === "transcribing" && !streaming) return;
    // any live mic (recording, or stream mode mid-transcribe) toggles off;
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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new AudioContext({ sampleRate: RATE });
        const src = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        modeRef.current = handsFree ? "stream" : "manual";
        node.onaudioprocess = (e) => {
          const ch = new Float32Array(e.inputBuffer.getChannelData(0));
          if (modeRef.current === "manual") {
            chunksRef.current.push(ch);
            return;
          }
          // our own spoken replies are in the air — drop everything absorbed
          // so the app can't transcribe itself (feedback loop)
          if (ttsActive()) {
            uttRef.current = [];
            preRef.current = [];
            speechMsRef.current = 0;
            silenceMsRef.current = 0;
            return;
          }
          // VAD: quiet before speech fills the pre-roll ring; speech opens an
          // utterance; pauseMs of trailing quiet closes and transcribes it
          const level = rms(ch);
          const chunkMs = (ch.length / RATE) * 1000;
          if (!uttRef.current.length && level < vadRef.current.thresh) {
            preRef.current.push(ch);
            if (preRef.current.length > PRE_CHUNKS) preRef.current.shift();
            return;
          }
          if (!uttRef.current.length) {
            uttRef.current = preRef.current;
            preRef.current = [];
          }
          uttRef.current.push(ch);
          if (level >= vadRef.current.thresh) {
            speechMsRef.current += chunkMs;
            silenceMsRef.current = 0;
          } else {
            silenceMsRef.current += chunkMs;
            if (silenceMsRef.current >= vadRef.current.pauseMs) closeUtterance();
          }
        };
        src.connect(node);
        node.connect(ctx.destination); // ScriptProcessor only runs when wired to output
        streamRef.current = stream;
        ctxRef.current = ctx;
        nodeRef.current = node;
        setStreaming(handsFree);
        setPhase("recording");
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [phase, streaming, stop, handsFree, model, closeUtterance, ttsActive]);

  return { phase, streaming, error, toggle };
}
