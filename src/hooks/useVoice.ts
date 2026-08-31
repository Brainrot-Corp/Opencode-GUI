import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pushToast } from "./useToast";
import { ensureVad, vadVoicedCount } from "../lib/streamingVad";
import { DedupEmitter } from "../lib/transcriptDedup";

export type VoicePhase = "idle" | "recording" | "transcribing";
export type VdbgKind = "act" | "say" | "warn" | "hint";

const RATE = 16000;
const SILENCE_MS = 900;
const MIN_SPEECH_MS = 350;
const PRE_ROLL_MS = 250;
const PRE_CHUNKS = 4; // 4*64ms ~256ms
const FRAME = 480;
const WORKLET_FRAME = 1024; // 64ms @16k — within 20-100ms spec
const PARTIAL_INTERVAL = 600; // 300-1000ms spec
const ROLL_WINDOW_MS = 12000;
const MIN_PARTIAL_MS = 700;
const VOICE_TAIL_MS = 1600;

export const MODE_FOR = (sens: number) => Math.max(0, Math.min(3, Math.round((1 - sens) * 3)));
export const THRESH_FOR = (sens: number) => 0.03 - sens * 0.028;

// inline AudioWorklet processor code — keeps capture off main thread
const WORKLET_CODE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(opts){ super(); this.sz = opts.processorOptions?.frameSize ?? 1024; this.buf=new Float32Array(this.sz); this.off=0; }
  process(inputs){
    const ch = inputs[0]?.[0];
    if(!ch) return true;
    for(let i=0;i<ch.length;i++){
      this.buf[this.off++]=ch[i];
      if(this.off>=this.sz){ this.port.postMessage(this.buf.slice(0)); this.buf=new Float32Array(this.sz); this.off=0; }
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
`;

function merge(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}
function rms(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / chunk.length);
}
function chunkMs(len: number): number { return (len / RATE) * 1000; }

export function useVoice(
  onResult: (text: string) => void,
  model: string,
  sens = 0.7,
  gpu = false,
  debug?: (kind: VdbgKind, msg: string) => void,
  multilingual = false,
  onPartial?: (partial: string) => boolean,
  onLivePartial?: (partial: string, isFinal: boolean) => void,
) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState("");

  const vadRef = useRef({ pauseMs: SILENCE_MS, thresh: THRESH_FOR(sens), mode: MODE_FOR(sens) });
  vadRef.current = { pauseMs: SILENCE_MS, thresh: THRESH_FOR(sens), mode: MODE_FOR(sens) };

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const srcRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const carryRef = useRef<Float32Array>(new Float32Array(0));
  const gpuRef = useRef(gpu); gpuRef.current = gpu;
  const dbgRef = useRef(debug); dbgRef.current = debug;
  const mlRef = useRef(multilingual); mlRef.current = multilingual;
  const partialRef = useRef(onPartial); partialRef.current = onPartial;
  const liveRef = useRef(onLivePartial); liveRef.current = onLivePartial;

  const rollRef = useRef<Float32Array[]>([]);
  const rollMsRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const busyRef = useRef(false);
  const tickRef = useRef<number | null>(null);
  const engineRef = useRef("");
  const uttRef = useRef<Float32Array[]>([]);
  const preRef = useRef<Float32Array[]>([]);
  const speechMsRef = useRef(0);
  const silenceMsRef = useRef(0);
  const ttsSpeakingRef = useRef(false);
  const ttsUntilRef = useRef(0);
  const bargeMsRef = useRef(0);
  const lastPcmRef = useRef<Float32Array | null>(null);
  const cancelRef = useRef(false);
  const dedupRef = useRef(new DedupEmitter());
  const watchdogRef = useRef<number | null>(null);
  const lastProcessRef = useRef(0);
  const onResultRef = useRef(onResult); onResultRef.current = onResult;

  const vdbg = useCallback((k: VdbgKind, m: string) => dbgRef.current?.(k, m), []);

  const ttsActive = useCallback(() => {
    const s = window.speechSynthesis;
    if (!s) return false;
    if (s.speaking) { ttsSpeakingRef.current = true; return true; }
    if (ttsSpeakingRef.current) { ttsSpeakingRef.current = false; ttsUntilRef.current = Date.now() + 500; return true; }
    return Date.now() < ttsUntilRef.current;
  }, []);

  useEffect(() => {
    const live = (e: Event) => { const ms = (e as CustomEvent<number>).detail || 3000; ttsUntilRef.current = Date.now() + ms + 500; };
    window.addEventListener("oc:tts-live", live);
    return () => window.removeEventListener("oc:tts-live", live);
  }, []);

  const forget = useCallback(() => {
    rollRef.current = []; rollMsRef.current = 0;
    uttRef.current = []; preRef.current = [];
    speechMsRef.current = 0; silenceMsRef.current = 0;
    dedupRef.current.reset();
    setPartial("");
    // also emit empty live to clear UI
    liveRef.current?.("", true);
    window.dispatchEvent(new CustomEvent("oc:voice-partial", { detail: { text: "", isFinal: true } }));
  }, []);

  const teardown = useCallback(() => {
    cancelRef.current = true;
    lastPcmRef.current = null;
    if (tickRef.current != null) { clearInterval(tickRef.current); tickRef.current = null; }
    if (watchdogRef.current != null) { clearInterval(watchdogRef.current); watchdogRef.current = null; }
    try { workletRef.current?.port.close?.(); } catch {}
    try { workletRef.current?.disconnect(); } catch {}
    workletRef.current = null;
    try { srcRef.current?.disconnect(); } catch {}
    srcRef.current = null;
    try { nodeRef.current?.disconnect(); } catch {}
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) { void ctx.close().catch(() => {}); }
    forget();
    carryRef.current = new Float32Array(0);
    bargeMsRef.current = 0;
  }, [forget]);

  useEffect(() => () => teardown(), [teardown]);

  // PCM → whisper via persistent backend (voice_transcribe_pcm). Keeps audio as
  // Float32 internally, no WAV encode, reuse server/model cache, off UI thread
  // via Rust spawn_blocking. Falls back to CLI if server not available.
  const transcribePcm = useCallback(async (pcm: Float32Array, isPartial: boolean): Promise<string | null> => {
    if (pcm.length < RATE * 0.2) {
      if (!isPartial) pushToast("utterance too short — ignored", { variant: "info", ttl: 2000 });
      return null;
    }
    // keep last PCM for multilingual retry
    lastPcmRef.current = pcm.slice(0);
    try {
      // try PCM path first (persistent, no WAV)
      const out = await invoke<{ text: string; engine: string; note: string }>("voice_transcribe_pcm", {
        pcm: Array.from(pcm),
        model,
        translate: mlRef.current,
        gpu: gpuRef.current,
      });
      if (cancelRef.current) return null;
      if (out.note) vdbg("warn", `engine fallback — ${out.note}`);
      else if (out.engine !== engineRef.current) { engineRef.current = out.engine; vdbg("hint", `engine: ${out.engine}`); }
      return out.text.trim() || null;
    } catch (e) {
      // fallback to legacy WAV path if PCM command missing (older backend) — still works
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wav = (() => {
          const buf = new ArrayBuffer(44 + pcm.length * 2);
          const v = new DataView(buf);
          const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
          ws(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
          v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
          v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
          ws(36, "data"); v.setUint32(40, pcm.length * 2, true);
          let o = 44; for (let i = 0; i < pcm.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, pcm[i]!)); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
          return new Uint8Array(buf);
        })();
        const out2 = await invoke<{ text: string; engine: string; note: string }>("voice_transcribe", {
          audio: Array.from(wav), model, translate: mlRef.current, gpu: gpuRef.current,
        });
        if (cancelRef.current) return null;
        return out2.text.trim() || null;
      } catch (e2) {
        if (!cancelRef.current) setError(String(e2 ?? e));
        return null;
      }
    }
  }, [model, vdbg]);

  const handleFinal = useCallback(async (pcm: Float32Array) => {
    setPhase("transcribing");
    const text = await transcribePcm(pcm, false);
    if (cancelRef.current) { setPhase(ctxRef.current ? "recording" : "idle"); return; }
    if (text) {
      vdbg("say", text);
      window.dispatchEvent(new CustomEvent("oc:voice-partial", { detail: { text, isFinal: true } }));
      liveRef.current?.(text, true);
      onResultRef.current(text);
    }
    setPartial("");
    setPhase(ctxRef.current ? "recording" : "idle");
  }, [transcribePcm, vdbg]);

  const retranscribe = useCallback(async (): Promise<string | null> => {
    const pcm = lastPcmRef.current;
    if (!pcm) return null;
    try {
      const out = await invoke<{ text: string; engine: string; note: string }>("voice_transcribe_pcm", {
        pcm: Array.from(pcm), model, translate: !mlRef.current, gpu: gpuRef.current,
      });
      return out.text.trim() || null;
    } catch { return null; }
  }, [model]);

  const stop = useCallback(async () => {
    teardown();
    setStreaming(false);
    setPhase("idle");
    setError("");
  }, [teardown]);

  const closeUtterance = useCallback(() => {
    const seg = uttRef.current;
    const spoke = speechMsRef.current >= MIN_SPEECH_MS;
    const voicedMs = Math.round(speechMsRef.current);
    // keep rolling tail for overlapping context — don't drop everything,
    // just the utterance buffer; rolling keeps last PRE_ROLL_MS for next
    const tailMs = PRE_ROLL_MS;
    const toKeep: Float32Array[] = [];
    let keptMs = 0;
    for (let i = seg.length - 1; i >= 0 && keptMs < tailMs; i--) {
      const ch = seg[i]!;
      toKeep.unshift(ch);
      keptMs += chunkMs(ch.length);
    }
    // reset dedup for next utterance but keep tail in rolling
    forget();
    // restore tail as pre-roll for next utterance's overlapping context
    if (toKeep.length) {
      preRef.current = toKeep.slice(-PRE_CHUNKS);
      // also keep tail in rolling for context continuity
      for (const c of toKeep) { rollRef.current.push(c); rollMsRef.current += chunkMs(c.length); }
    }
    if (seg.length && spoke) {
      vdbg("hint", `closed · ${(voicedMs / 1000).toFixed(1)}s voiced`);
      const pcm = merge(seg);
      void handleFinal(pcm);
      window.dispatchEvent(new CustomEvent("oc:voice-final", { detail: { text: "" } }));
    } else if (seg.length) {
      vdbg("hint", "dropped — too short");
    }
  }, [forget, handleFinal, vdbg]);

  const partialTick = useCallback(() => {
    if (busyRef.current || !ctxRef.current || cancelRef.current) return;
    if (Date.now() - lastVoiceAtRef.current > VOICE_TAIL_MS) return;
    if (rollMsRef.current < MIN_PARTIAL_MS) return;
    while (rollMsRef.current > ROLL_WINDOW_MS && rollRef.current.length > 1) {
      const head = rollRef.current[0]!;
      rollMsRef.current -= chunkMs(head.length);
      rollRef.current = rollRef.current.slice(1);
    }
    const pcm = merge(rollRef.current);
    busyRef.current = true;
    void transcribePcm(pcm, true).then((text) => {
      if (cancelRef.current) return;
      if (!text) return;
      // dedup overlapping results
      const { delta, cumulative, isNew } = dedupRef.current.push(text);
      const display = cumulative;
      if (!isNew && !delta) return;
      // emit partial live transcript
      setPartial(display);
      window.dispatchEvent(new CustomEvent("oc:voice-partial", { detail: { text: display, isFinal: false } }));
      liveRef.current?.(display, false);
      vdbg("say", display);
      if (partialRef.current?.(display)) {
        // command fired — forget to avoid double-fire, but keep partial UI cleared
        forget();
      }
    }).catch(() => {}).finally(() => { busyRef.current = false; });
  }, [transcribePcm, vdbg, forget]);

  const toggle = useCallback(() => {
    if (phase !== "idle" || streaming) { void stop(); return; }
    setError("");
    window.speechSynthesis?.cancel();
    (async () => {
      try {
        const st = await invoke<{ bin: boolean; models: string[] }>("voice_status").catch(() => null);
        if (!st?.bin) { setError("voice engine not installed — set it up in Settings › Voice"); return; }
        if (!st.models.includes(model)) { setError(`model ${model} isn't downloaded — pick or fetch one in Settings › Voice`); return; }
        try { await ensureVad(); } catch { setError("voice VAD failed to load — try restarting"); return; }
        cancelRef.current = false;
        dedupRef.current.reset();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const ctx = new AudioContext({ sampleRate: RATE });
        // worklet path — true streaming, off main thread, small frames
        let worklet: AudioWorkletNode | null = null;
        let scriptNode: ScriptProcessorNode | null = null;
        const src = ctx.createMediaStreamSource(stream);
        let usingWorklet = false;
        try {
          const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
          const url = URL.createObjectURL(blob);
          await ctx.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          worklet = new AudioWorkletNode(ctx, "capture-processor", { processorOptions: { frameSize: WORKLET_FRAME } });
          usingWorklet = true;
        } catch {
          usingWorklet = false;
        }

        lastProcessRef.current = Date.now();

        const handleChunk = (ch: Float32Array) => {
          lastProcessRef.current = Date.now();
          if (cancelRef.current) return;
          const level = rms(ch);
          const ms = chunkMs(ch.length);
          if (ttsActive()) {
            const bargeThresh = Math.max(vadRef.current.thresh * 2, 0.05);
            if (level >= bargeThresh) {
              bargeMsRef.current += ms;
              if (bargeMsRef.current >= 250) {
                bargeMsRef.current = 0;
                vdbg("warn", "barge-in — reply cancelled");
                ttsUntilRef.current = Date.now();
                ttsSpeakingRef.current = false;
                window.speechSynthesis?.cancel();
                window.dispatchEvent(new Event("oc:tts-stop"));
                if (!uttRef.current.length && preRef.current.length) {
                  uttRef.current = preRef.current;
                  preRef.current = [];
                }
              }
            } else {
              bargeMsRef.current = Math.max(0, bargeMsRef.current - ms / 2);
            }
            preRef.current.push(ch);
            if (preRef.current.length > PRE_CHUNKS) preRef.current.shift();
            return;
          }
          bargeMsRef.current = 0;
          rollRef.current.push(ch);
          rollMsRef.current += ms;
          const { voiced, carry } = vadVoicedCount(ch, vadRef.current.mode, carryRef.current);
          carryRef.current = carry;
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
            silenceMsRef.current += ms;
            if (silenceMsRef.current >= vadRef.current.pauseMs) closeUtterance();
          }
        };

        if (usingWorklet && worklet) {
          worklet.port.onmessage = (e: MessageEvent<Float32Array>) => handleChunk(e.data);
          src.connect(worklet);
          // worklet does not need destination connection
          workletRef.current = worklet;
        } else {
          const node = ctx.createScriptProcessor(WORKLET_FRAME, 1, 1);
          node.onaudioprocess = (e) => handleChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
          src.connect(node);
          node.connect(ctx.destination);
          nodeRef.current = node;
          scriptNode = node;
        }
        streamRef.current = stream;
        ctxRef.current = ctx;
        srcRef.current = src;

        // watchdog for ScriptProcessor fallback — AudioWorklet doesn't stall like ScriptProcessor
        if (!usingWorklet && scriptNode) {
          const nodeForWatch = scriptNode;
          if (watchdogRef.current != null) clearInterval(watchdogRef.current);
          watchdogRef.current = window.setInterval(() => {
            if (Date.now() - lastProcessRef.current <= 1200) return;
            const c2 = ctxRef.current, s2 = streamRef.current, src2 = srcRef.current;
            if (!c2 || !s2 || !src2 || c2.state === "closed") return;
            try { nodeForWatch.disconnect(); } catch {}
            try {
              const repl = c2.createScriptProcessor(WORKLET_FRAME, 1, 1);
              repl.onaudioprocess = (e) => handleChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
              src2.connect(repl); repl.connect(c2.destination);
              nodeRef.current = repl;
              lastProcessRef.current = Date.now();
            } catch {}
          }, 1000);
        }

        if (tickRef.current != null) clearInterval(tickRef.current);
        tickRef.current = window.setInterval(partialTick, PARTIAL_INTERVAL);
        setStreaming(true);
        setPhase("recording");
        vdbg("hint", usingWorklet ? `worklet ${WORKLET_FRAME} samples · ${PARTIAL_INTERVAL}ms tick` : `fallback ${WORKLET_FRAME} · tick ${PARTIAL_INTERVAL}ms`);
      } catch (e) {
        setError(String(e));
        teardown();
      }
    })();
  }, [phase, streaming, stop, model, closeUtterance, ttsActive, partialTick, teardown, vdbg]);

  return { phase, streaming, error, toggle, retranscribe, partial, stop };
}
