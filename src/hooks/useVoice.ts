import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type VoicePhase = "idle" | "recording" | "transcribing";

const RATE = 16000; // whisper's required sample rate — AudioContext resamples

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

export function useVoice(onResult: (text: string) => void, model: string) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState("");
  // recording machinery lives in refs so start/stop closures stay stable
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);

  const teardown = useCallback(() => {
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const stop = useCallback(async () => {
    teardown();
    const merged = chunksRef.current;
    chunksRef.current = [];
    if (!merged.length) return;
    setPhase("transcribing");
    try {
      const total = merged.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(total);
      let o = 0;
      for (const c of merged) {
        all.set(c, o);
        o += c.length;
      }
      if (all.length < RATE / 2) return; // sub-half-second click — ignore
      const wav = f32ToWav(all);
      const text = await invoke<string>("voice_transcribe", {
        audio: Array.from(wav),
        model,
      });
      if (text.trim()) onResult(text.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setPhase("idle");
    }
  }, [teardown, onResult, model]);

  const toggle = useCallback(() => {
    if (phase === "recording") {
      void stop();
      return;
    }
    if (phase === "transcribing") return;
    setError("");
    // don't transcribe our own voice output
    window.speechSynthesis?.cancel();
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new AudioContext({ sampleRate: RATE });
        const src = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => {
          chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
        src.connect(node);
        node.connect(ctx.destination); // ScriptProcessor only runs when wired to output
        streamRef.current = stream;
        ctxRef.current = ctx;
        nodeRef.current = node;
        setPhase("recording");
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [phase, stop]);

  return { phase, error, toggle };
}
