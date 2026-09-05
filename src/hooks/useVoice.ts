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
const TRANSCRIBE_TIMEOUT_MS = 32_000;
const PARTIAL_TIMEOUT_MS = 14_000;
const WATCHDOG_MS = 1500;

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

function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  let t: number | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<T>((_, rej) => {
    t = window.setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); rej(new DOMException(`${label} aborted`, "AbortError")); return; }
      onAbort = () => { clearTimeout(t); rej(new DOMException(`${label} aborted seq stale`, "AbortError")); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  // if p is already settled when signal aborts, race still rejects via abort
  const raced = signal ? Promise.race([p, timeout]) : Promise.race([p, timeout]);
  return raced.finally(() => {
    if (t !== undefined) clearTimeout(t);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }) as Promise<T>;
}

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
  const phaseRef = useRef<VoicePhase>("idle");
  const streamingRef = useRef(false);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { streamingRef.current = streaming; }, [streaming]);

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
  const busyRef = useRef<number | null>(null);
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
  // generation for self-recovery — any in-flight Whisper/partial after bump is stale and dropped
  const seqRef = useRef(0);
  // serialize start → teardown → restart (prevents overlapping getUserMedia/worklet races)
  const startingRef = useRef(false);
  // serialize final transcriptions — overlapping voice_transcribe_pcm hangs one permanently
  // ponytail: store owning seq so stale finally only clears its own owner, not live generation
  const finalBusyRef = useRef<number | null>(null);
  // abort in-flight whisper when seq bumps — avoids 14s/32s hang on dead server
  const inflightRef = useRef<Map<string, AbortController>>(new Map());

  const vdbg = useCallback((k: VdbgKind, m: string) => dbgRef.current?.(k, m), []);
  const sttLog = useCallback((k: VdbgKind, m: string) => {
    const line = `[STT:${k}] ${m}`;
    // always visible in devtools so we can pinpoint where STT dies after prolonged use
    // eslint-disable-next-line no-console
    console.debug(line);
    vdbg(k, m);
  }, [vdbg]);

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

  const teardown = useCallback((reason = "teardown") => {
    const seq = ++seqRef.current;
    sttLog("warn", `teardown seq=${seq} reason=${reason} phase=${phaseRef.current} streaming=${streamingRef.current} busy=${busyRef.current} finalBusy=${finalBusyRef.current}`);
    cancelRef.current = true;
    busyRef.current = null;
    finalBusyRef.current = null;
    lastPcmRef.current = null;
    // abort stale partial whispers — keep final for last utterance (cur-1) to allow delivery after mic stop
    for (const [k, ac] of [...inflightRef.current.entries()]) {
      if (k.endsWith(":partial")) { try { ac.abort(); } catch {} inflightRef.current.delete(k); }
      else {
        const s = parseInt(k.split(":")[0]!, 10);
        if (!Number.isNaN(s) && s < seq - 1) { try { ac.abort(); } catch {} inflightRef.current.delete(k); }
      }
    }
    if (tickRef.current != null) { clearInterval(tickRef.current); tickRef.current = null; sttLog("hint", "tick cleared"); }
    if (watchdogRef.current != null) { clearInterval(watchdogRef.current); watchdogRef.current = null; sttLog("hint", "watchdog cleared"); }
    try { workletRef.current?.port.close?.(); } catch (e) { sttLog("warn", `worklet port close failed: ${String(e)}`); }
    try { workletRef.current?.disconnect(); } catch {}
    workletRef.current = null;
    try { srcRef.current?.disconnect(); } catch {}
    srcRef.current = null;
    try { nodeRef.current?.disconnect(); } catch {}
    nodeRef.current = null;
    try {
      const tracks = streamRef.current?.getTracks() ?? [];
      tracks.forEach(t => { try { t.stop(); } catch {} });
      if (tracks.length) sttLog("hint", `mic tracks stopped: ${tracks.length}`);
    } catch (e) { sttLog("warn", `track stop failed: ${String(e)}`); }
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) {
      const state = ctx.state;
      void ctx.close().then(() => sttLog("hint", `AudioContext closed (was ${state})`)).catch((e) => sttLog("warn", `AudioContext close failed: ${String(e)}`));
    }
    forget();
    carryRef.current = new Float32Array(0);
    bargeMsRef.current = 0;
    lastProcessRef.current = 0;
  }, [forget, sttLog]);

  useEffect(() => () => teardown("unmount"), [teardown]);

  // PCM → whisper via persistent backend (voice_transcribe_pcm). Keeps audio as
  // Float32 internally, no WAV encode, reuse server/model cache, off UI thread
  // via Rust spawn_blocking. Falls back to CLI if server not available.
  const transcribePcm = useCallback(async (pcm: Float32Array, isPartial: boolean, seq: number): Promise<string | null> => {
    const isStaleFor = (s: number, partial: boolean) => partial ? (cancelRef.current || s !== seqRef.current) : (s < seqRef.current - 1);
    if (isStaleFor(seq, isPartial)) {
      // stale — silently dropped, no whisper log (ponytail: drop stale without noise, finals allow cur-1 for last utterance)
      return null;
    }
    if (pcm.length < RATE * 0.2) {
      if (!isPartial) pushToast("utterance too short — ignored", { variant: "info", ttl: 2000 });
      sttLog("hint", `transcribe skipped too short ${pcm.length} samples isPartial=${isPartial}`);
      return null;
    }
    // keep last PCM for multilingual retry
    lastPcmRef.current = pcm.slice(0);
    const label = isPartial ? "partial Whisper" : "final Whisper";
    const timeoutMs = isPartial ? PARTIAL_TIMEOUT_MS : TRANSCRIBE_TIMEOUT_MS;
    sttLog("hint", `${label} start seq=${seq} pcm=${pcm.length} (${(pcm.length / RATE).toFixed(2)}s) model=${model} gpu=${gpuRef.current} translate=${mlRef.current}`);
    const t0 = Date.now();
    const ac = new AbortController();
    const inflightKey = `${seq}:${isPartial ? "partial" : "final"}`;
    inflightRef.current.set(inflightKey, ac);
    try {
      const p = invoke<{ text: string; engine: string; note: string }>("voice_transcribe_pcm", {
        pcm: Array.from(pcm),
        model,
        translate: mlRef.current,
        gpu: gpuRef.current,
      });
      const out = await withTimeout(p, timeoutMs, label, ac.signal);
      if (ac.signal.aborted || isStaleFor(seq, isPartial)) {
        return null;
      }
      const dt = Date.now() - t0;
      if (out.note) sttLog("warn", `${label} done ${dt}ms engine=${out.engine} fallback: ${out.note} textLen=${out.text.length}`);
      else {
        if (out.engine !== engineRef.current) { engineRef.current = out.engine; sttLog("hint", `engine: ${out.engine} ${dt}ms`); }
        else sttLog("hint", `${label} done ${dt}ms engine=${out.engine} textLen=${out.text.length}`);
      }
      return out.text.trim() || null;
    } catch (e) {
      const dt = Date.now() - t0;
      const aborted = (e as DOMException)?.name === "AbortError" || ac.signal.aborted;
      if (aborted || isStaleFor(seq, isPartial)) {
        return null;
      }
      sttLog("warn", `${label} pcm path failed ${dt}ms: ${String(e)} — trying WAV fallback`);
      // fallback to legacy WAV path if PCM command missing (older backend) — still works
      try {
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
        const p2 = invoke<{ text: string; engine: string; note: string }>("voice_transcribe", {
          audio: Array.from(wav), model, translate: mlRef.current, gpu: gpuRef.current,
        });
        const out2 = await withTimeout(p2, timeoutMs, `${label} WAV fallback`, ac.signal);
        if (ac.signal.aborted || isStaleFor(seq, isPartial)) {
          return null;
        }
        sttLog("hint", `${label} WAV fallback done ${Date.now() - t0}ms textLen=${out2.text.length}`);
        return out2.text.trim() || null;
      } catch (e2) {
        const aborted2 = (e2 as DOMException)?.name === "AbortError" || ac.signal.aborted;
        if (aborted2 || isStaleFor(seq, isPartial)) {
          return null;
        }
        const msg = String(e2 ?? e);
        sttLog("warn", `${label} failed ${Date.now() - t0}ms: ${msg}`);
        if (!isPartial) setError(msg.slice(0, 400));
        return null;
      }
    } finally {
      inflightRef.current.delete(inflightKey);
    }
  }, [model, sttLog]);

  const handleFinal = useCallback(async (pcm: Float32Array, seq: number) => {
    if (finalBusyRef.current !== null) {
      sttLog("warn", `handleFinal dropped — already transcribing seq=${seq} owner=${finalBusyRef.current}`);
      return;
    }
    finalBusyRef.current = seq;
    const pcmSec = (pcm.length / RATE).toFixed(2);
    sttLog("hint", `handleFinal start seq=${seq} pcm=${pcm.length} (${pcmSec}s)`);
    setPhase("transcribing");
    try {
      const text = await transcribePcm(pcm, false, seq);
      if (seq < seqRef.current - 1) {
        return;
      }
      if (text) {
        sttLog("say", `final: "${text.slice(0, 200)}"`);
        window.dispatchEvent(new CustomEvent("oc:voice-partial", { detail: { text, isFinal: true } }));
        liveRef.current?.(text, true);
        onResultRef.current(text);
      } else {
        sttLog("hint", `handleFinal empty result seq=${seq}`);
      }
    } catch (e) {
      sttLog("warn", `handleFinal crashed seq=${seq}: ${String(e)}`);
      if (seq >= seqRef.current - 1) setError(String(e).slice(0, 400));
    } finally {
      const isStale = seq < seqRef.current - 1;
      if (isStale) {
        // stale must not clobber live generation's phase/partial/busy — silently drop (allow cur-1 final after mic stop)
        if (finalBusyRef.current === seq) finalBusyRef.current = null;
        return;
      }
      if (finalBusyRef.current === seq) finalBusyRef.current = null;
      setPartial("");
      // self-recovering: always return to recording if mic still live, else idle
      const stillLive = !!ctxRef.current && !cancelRef.current;
      sttLog("hint", `handleFinal cleanup seq=${seq} stillLive=${stillLive} finalBusy cleared`);
      setPhase(stillLive ? "recording" : "idle");
    }
  }, [transcribePcm, sttLog]);

  const retranscribe = useCallback(async (): Promise<string | null> => {
    const pcm = lastPcmRef.current;
    const seq = seqRef.current;
    if (!pcm) { sttLog("hint", "retranscribe no pcm"); return null; }
    sttLog("hint", `retranscribe start seq=${seq} pcm=${pcm.length}`);
    try {
      const p = invoke<{ text: string; engine: string; note: string }>("voice_transcribe_pcm", {
        pcm: Array.from(pcm), model, translate: !mlRef.current, gpu: gpuRef.current,
      });
      const out = await withTimeout(p, TRANSCRIBE_TIMEOUT_MS, "retranscribe");
      if (cancelRef.current || seq !== seqRef.current) return null;
      return out.text.trim() || null;
    } catch (e) {
      sttLog("warn", `retranscribe failed: ${String(e)}`);
      return null;
    }
  }, [model, sttLog]);

  const stop = useCallback(async () => {
    sttLog("hint", `stop called phase=${phaseRef.current} streaming=${streamingRef.current}`);
    teardown("stop");
    setStreaming(false);
    setPhase("idle");
    setError("");
  }, [teardown, sttLog]);

  const closeUtterance = useCallback(() => {
    if (cancelRef.current) { sttLog("hint", "closeUtterance dropped — cancelled"); return; }
    const seq = seqRef.current;
    const seg = uttRef.current.slice();
    const spoke = speechMsRef.current >= MIN_SPEECH_MS;
    const voicedMs = Math.round(speechMsRef.current);
    if (!seg.length) { sttLog("hint", `closeUtterance empty seg seq=${seq}`); return; }
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
      for (const c of toKeep) { rollRef.current.push(c); rollMsRef.current += chunkMs(c.length); }
    }
    if (seg.length && spoke) {
      sttLog("hint", `closeUtterance seq=${seq} voiced=${(voicedMs / 1000).toFixed(1)}s chunks=${seg.length} → handleFinal`);
      const pcm = merge(seg);
      void handleFinal(pcm, seq);
      window.dispatchEvent(new CustomEvent("oc:voice-final", { detail: { text: "" } }));
    } else if (seg.length) {
      sttLog("hint", `closeUtterance dropped too short seq=${seq} voiced=${voicedMs}ms`);
    }
  }, [forget, handleFinal, sttLog]);

  const partialTick = useCallback(() => {
    if (cancelRef.current) return;
    if (busyRef.current !== null) { sttLog("hint", "partialTick skipped busy"); return; }
    if (finalBusyRef.current !== null) return;
    if (!ctxRef.current) { sttLog("warn", "partialTick no ctx — mic dead, will watchdog"); return; }
    if (ctxRef.current.state === "suspended") {
      sttLog("warn", `partialTick ctx suspended — trying resume`);
      void ctxRef.current.resume().then(() => sttLog("hint", "ctx resumed")).catch((e) => sttLog("warn", `ctx resume failed: ${String(e)}`));
    }
    if (Date.now() - lastVoiceAtRef.current > VOICE_TAIL_MS) return;
    if (rollMsRef.current < MIN_PARTIAL_MS) return;
    while (rollMsRef.current > ROLL_WINDOW_MS && rollRef.current.length > 1) {
      const head = rollRef.current[0]!;
      rollMsRef.current -= chunkMs(head.length);
      rollRef.current = rollRef.current.slice(1);
    }
    const seq = seqRef.current;
    const pcm = merge(rollRef.current);
    busyRef.current = seq;
    sttLog("hint", `partialTick seq=${seq} roll=${(rollMsRef.current / 1000).toFixed(1)}s`);
    void transcribePcm(pcm, true, seq).then((text) => {
      if (cancelRef.current || seq !== seqRef.current) return;
      if (!text) return;
      const { delta, cumulative, isNew } = dedupRef.current.push(text);
      if (!isNew && !delta) return;
      setPartial(cumulative);
      window.dispatchEvent(new CustomEvent("oc:voice-partial", { detail: { text: cumulative, isFinal: false } }));
      liveRef.current?.(cumulative, false);
      sttLog("say", `partial: "${cumulative.slice(0, 200)}" delta="${delta.slice(0, 80)}"`);
      if (partialRef.current?.(cumulative)) {
        // command fired — forget to avoid double-fire, but keep partial UI cleared
        sttLog("act", `partial fired command — forget`);
        forget();
      }
    }).catch((e) => {
      sttLog("warn", `partialTick transcribe threw: ${String(e)}`);
    }).finally(() => {
      // self-recovering: only clear busy if this seq still owns it — stale must not clear live's busy — silent
      const isStale = cancelRef.current || seq !== seqRef.current;
      if (isStale) {
        if (busyRef.current === seq) busyRef.current = null;
        return;
      }
      if (busyRef.current === seq) busyRef.current = null;
    });
  }, [transcribePcm, sttLog, forget]);

  const toggle = useCallback(() => {
    if (startingRef.current) { sttLog("warn", "toggle ignored — start already in progress"); return; }
    if (phaseRef.current !== "idle" || streamingRef.current) { void stop(); return; }
    setError("");
    window.speechSynthesis?.cancel();
    startingRef.current = true;
    const startSeq = seqRef.current + 1;
    sttLog("hint", `toggle start → seq=${startSeq} model=${model} gpu=${gpu} sens=${sens} multilingual=${multilingual}`);
    (async () => {
      try {
        sttLog("hint", "toggle: checking voice_status");
        const st = await withTimeout(invoke<{ bin: boolean; models: string[] }>("voice_status").catch(() => null) as Promise<any>, 5000, "voice_status");
        if (!st?.bin) { sttLog("warn", "voice_status: engine not installed"); setError("voice engine not installed — set it up in Settings › Voice"); return; }
        if (!st.models.includes(model)) { sttLog("warn", `voice_status: model ${model} missing`); setError(`model ${model} isn't downloaded — pick or fetch one in Settings › Voice`); return; }
        sttLog("hint", "toggle: ensureVad");
        try { await withTimeout(ensureVad(), 8000, "ensureVad"); sttLog("hint", "VAD ready"); } catch (e) { sttLog("warn", `VAD failed: ${String(e)}`); setError("voice VAD failed to load — try restarting"); return; }
        cancelRef.current = false;
        // abort any hanging whisper from previous seq before bumping — avoids overlap hang
        for (const [, ac] of inflightRef.current) { try { ac.abort(); } catch {} }
        inflightRef.current.clear();
        seqRef.current += 1;
        const seq = seqRef.current;
        // new generation owns fresh busy state — clear stale owners so they don't block
        busyRef.current = null;
        finalBusyRef.current = null;
        dedupRef.current.reset();
        sttLog("hint", `toggle: getUserMedia seq=${seq}`);
        const stream = await withTimeout(navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }), 8000, "getUserMedia");
        if (cancelRef.current || seq !== seqRef.current) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        // mic track failure → self-recovering reset so next toggle works
        stream.getTracks().forEach(t => {
          t.onended = () => {
            if (seq !== seqRef.current) return;
            sttLog("warn", `mic track ended seq=${seq}`);
            setError("microphone disconnected");
            teardown("mic track ended");
            setStreaming(false);
            setPhase("idle");
          };
        });
        sttLog("hint", `toggle: AudioContext seq=${seq}`);
        const ctx = new AudioContext({ sampleRate: RATE });
        if (ctx.state === "suspended") {
          try { await ctx.resume(); sttLog("hint", "AudioContext resumed"); } catch (e) { sttLog("warn", `AudioContext resume failed: ${String(e)}`); }
        }
        if (cancelRef.current || seq !== seqRef.current) {
          stream.getTracks().forEach(t => t.stop());
          void ctx.close().catch(() => {});
          return;
        }
        // worklet path — true streaming, off main thread, small frames
        let worklet: AudioWorkletNode | null = null;
        let scriptNode: ScriptProcessorNode | null = null;
        void scriptNode;
        const src = ctx.createMediaStreamSource(stream);
        let usingWorklet = false;
        try {
          const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
          const url = URL.createObjectURL(blob);
          await withTimeout(ctx.audioWorklet.addModule(url), 5000, "audioWorklet.addModule");
          URL.revokeObjectURL(url);
          if (cancelRef.current || seq !== seqRef.current) throw new Error("cancelled while loading worklet");
          worklet = new AudioWorkletNode(ctx, "capture-processor", { processorOptions: { frameSize: WORKLET_FRAME } });
          usingWorklet = true;
          sttLog("hint", `AudioWorklet ready seq=${seq}`);
        } catch (e) {
          usingWorklet = false;
          sttLog("warn", `AudioWorklet failed seq=${seq}: ${String(e)} — fallback to ScriptProcessor`);
        }

        lastProcessRef.current = Date.now();

        const handleChunk = (ch: Float32Array) => {
          try {
            lastProcessRef.current = Date.now();
            if (cancelRef.current || seq !== seqRef.current) return;
            if (ctx.state === "suspended") {
              // try resume but don't block capture
              void ctx.resume().catch(() => {});
            }
            const level = rms(ch);
            const ms = chunkMs(ch.length);
            if (ttsActive()) {
              const bargeThresh = Math.max(vadRef.current.thresh * 2, 0.05);
              if (level >= bargeThresh) {
                bargeMsRef.current += ms;
                if (bargeMsRef.current >= 250) {
                  bargeMsRef.current = 0;
                  sttLog("warn", "barge-in — reply cancelled");
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
            while (rollMsRef.current > ROLL_WINDOW_MS + 2000 && rollRef.current.length > 1) {
              const head = rollRef.current[0]!;
              rollMsRef.current -= chunkMs(head.length);
              rollRef.current = rollRef.current.slice(1);
              sttLog("warn", "roll overflow — trimmed");
            }
            let voiced = 0;
            let carry: Float32Array = carryRef.current;
            try {
              const res = vadVoicedCount(ch, vadRef.current.mode, carryRef.current);
              voiced = res.voiced;
              carry = res.carry;
            } catch (e) {
              sttLog("warn", `VAD threw: ${String(e)} — treating as non-speech`);
              voiced = 0;
              carry = new Float32Array(0);
            }
            carryRef.current = carry;
            const speech = voiced > 0;
            if (speech) lastVoiceAtRef.current = Date.now();
            if (!uttRef.current.length && !speech) {
              preRef.current.push(ch);
              if (preRef.current.length > PRE_CHUNKS) preRef.current.shift();
              return;
            }
            if (!uttRef.current.length) {
              sttLog("hint", `utterance start seq=${seq}`);
              uttRef.current = preRef.current.slice();
              preRef.current = [];
            }
            uttRef.current.push(ch);
            if (speech) {
              speechMsRef.current += (voiced * FRAME * 1000) / RATE;
              silenceMsRef.current = 0;
            } else {
              silenceMsRef.current += ms;
              if (silenceMsRef.current >= vadRef.current.pauseMs) {
                sttLog("hint", `silence ${Math.round(silenceMsRef.current)}ms ≥ ${vadRef.current.pauseMs} → closeUtterance`);
                closeUtterance();
              }
            }
          } catch (e) {
            sttLog("warn", `handleChunk crashed: ${String(e)} stack=${(e as Error)?.stack?.slice(0, 500) ?? ""}`);
            // self-recovering: don't leave mic dead — reset utterance state so next chunk can start fresh
            try { silenceMsRef.current = 0; } catch {}
          }
        };

        if (cancelRef.current || seq !== seqRef.current) {
          stream.getTracks().forEach(t => t.stop());
          void ctx.close().catch(() => {});
          return;
        }

        if (usingWorklet && worklet) {
          worklet.port.onmessage = (e: MessageEvent<Float32Array>) => handleChunk(e.data);
          worklet.port.onmessageerror = (e) => sttLog("warn", `worklet messageerror seq=${seq}: ${String((e as any)?.data ?? e)}`);
          src.connect(worklet);
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

        // watchdog — works for both AudioWorklet (can stall on tab hidden) and ScriptProcessor
        if (watchdogRef.current != null) clearInterval(watchdogRef.current);
        watchdogRef.current = window.setInterval(() => {
          if (cancelRef.current || seq !== seqRef.current) return;
          const age = Date.now() - lastProcessRef.current;
          if (age <= WATCHDOG_MS) return;
          const c2 = ctxRef.current, s2 = streamRef.current, src2 = srcRef.current;
          if (!c2 || !s2 || !src2 || c2.state === "closed") {
            sttLog("warn", `watchdog: no ctx/stream/src state=${c2?.state} age=${age}ms seq=${seq}`);
            return;
          }
          sttLog("warn", `watchdog: no audio for ${age}ms seq=${seq} ctx=${c2.state} — trying recovery`);
          // try resume context first (cheapest self-recovery)
          if (c2.state === "suspended") {
            void c2.resume().then(() => {
              sttLog("hint", `watchdog: ctx resumed seq=${seq}`);
              lastProcessRef.current = Date.now();
            }).catch((e) => sttLog("warn", `watchdog resume failed: ${String(e)}`));
            return;
          }
          // check tracks live
          const liveTracks = s2.getTracks().filter(t => t.readyState === "live");
          if (!liveTracks.length) {
            sttLog("warn", `watchdog: mic tracks dead seq=${seq} — teardown to allow restart`);
            teardown("watchdog mic dead");
            setStreaming(false);
            setPhase("idle");
            setError("microphone stream lost — tap mic to restart");
            return;
          }
          // ScriptProcessor fallback — recreate node
          if (!usingWorklet && nodeRef.current) {
            const old = nodeRef.current;
            try { old.disconnect(); } catch {}
            try {
              const repl = c2.createScriptProcessor(WORKLET_FRAME, 1, 1);
              repl.onaudioprocess = (e) => handleChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
              src2.connect(repl); repl.connect(c2.destination);
              nodeRef.current = repl;
              lastProcessRef.current = Date.now();
              sttLog("hint", `watchdog: ScriptProcessor recreated seq=${seq}`);
            } catch (e) { sttLog("warn", `watchdog recreate failed: ${String(e)}`); }
            return;
          }
          // Worklet stalled — teardown and surface error so user can restart; auto-restart would surprise
          if (usingWorklet) {
            sttLog("warn", `watchdog: worklet stalled seq=${seq} — tearing down to allow restart`);
            teardown("watchdog worklet stalled");
            setStreaming(false);
            setPhase("idle");
            setError("mic stalled — tap mic to restart");
          }
        }, 1000);

        if (tickRef.current != null) clearInterval(tickRef.current);
        tickRef.current = window.setInterval(() => {
          try { partialTick(); } catch (e) { sttLog("warn", `partialTick outer throw: ${String(e)}`); busyRef.current = null; }
        }, PARTIAL_INTERVAL);
        setStreaming(true);
        setPhase("recording");
        sttLog("hint", `STT lifecycle: start → audio capture (${usingWorklet ? "worklet" : "ScriptProcessor"}) → VAD→Whisper ready seq=${seq} frame=${WORKLET_FRAME} tick=${PARTIAL_INTERVAL}ms`);
      } catch (e) {
        const msg = String(e);
        sttLog("warn", `toggle failed: ${msg}`);
        setError(msg.slice(0, 400));
        teardown(`toggle failed: ${msg}`);
        setStreaming(false);
        setPhase("idle");
      } finally {
        startingRef.current = false;
      }
    })();
  }, [stop, model, closeUtterance, ttsActive, partialTick, teardown, sttLog, gpu, sens, multilingual]);

  // keep last toggle reachable even when component remounts
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && ctxRef.current?.state === "suspended" && streamingRef.current) {
        sttLog("hint", "visibility visible — resuming AudioContext");
        void ctxRef.current.resume().catch((e) => sttLog("warn", `vis resume failed: ${String(e)}`));
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [sttLog]);

  return { phase, streaming, error, toggle, retranscribe, partial, stop };
}
