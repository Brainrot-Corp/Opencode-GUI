// VAD abstraction for streaming STT — WebRTC (libfvad) baseline with
// Silero ONNX ready to swap in when model is present.
// ponytail: WebRTC VAD is the minimal working detector; Silero ONNX (silero_vad.onnx
// via ort/onnxruntime-web) is the upgrade path if accuracy needs tuning — add
// model download + ort session and route isSpeech through it, same interface.

import VADBuilder, { VADMode, VADEvent } from "@ozymandiasthegreat/vad";
import type { VAD } from "@ozymandiasthegreat/vad";

const RATE = 16000;
const FRAME = 480; // 30ms @16k — WebRTC frame

let vadClass: typeof VAD | null = null;
const vadByMode = new Map<number, VAD>();

export async function ensureVad() {
  if (vadClass) return;
  vadClass = await VADBuilder();
  for (let m = 0; m <= 3; m++) {
    if (!vadByMode.has(m)) vadByMode.set(m, new vadClass!(m as VADMode, RATE));
  }
}

export function vadVoicedCount(chunk: Float32Array, mode: number, carry: Float32Array): { voiced: number; carry: Float32Array } {
  const v = vadByMode.get(mode);
  if (!v || !vadClass) return { voiced: 0, carry };
  const all = new Float32Array(carry.length + chunk.length);
  all.set(carry);
  all.set(chunk, carry.length);
  const n = Math.floor(all.length / FRAME);
  const nextCarry = all.slice(n * FRAME);
  if (!n) return { voiced: 0, carry: nextCarry };
  let voiced = 0;
  for (let i = 0; i < n; i++) {
    const pcm = vadClass.floatTo16BitPCM(all.subarray(i * FRAME, (i + 1) * FRAME));
    if (v.processFrame(pcm) === VADEvent.VOICE) voiced++;
  }
  return { voiced, carry: nextCarry };
}

// Silero probe — if a silero_vad.onnx exists under whisper dir, frontend
// could fetch it and run via onnxruntime-web. This stub keeps the wiring
// so the swap is one function change, not a pipeline rewrite.
// To enable: download silero_vad.onnx to ~/.config/.opencode-gui/whisper/silero_vad.onnx
// and implement isSpeechSilero via ort session; fallback remains WebRTC.
export function hasSileroModel(): boolean {
  // checked lazily via Tauri invoke if needed; default false
  return false;
}
