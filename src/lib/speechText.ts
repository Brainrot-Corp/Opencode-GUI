import type { Msg } from "../types";

// plays synthesized wav bytes; returns the element so callers can pause it
export function playWav(bytes: number[], volume: number): HTMLAudioElement {
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

// --- low-latency PCM path: bypass WAV header + Blob decode -----------------
// Rust sends raw i16 LE PCM (24kHz mono) as bytes; we build an AudioBuffer
// directly — no WAV header, no Blob URL, no extra IPC copy.
let sharedCtx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  try {
    if (sharedCtx?.state === "closed") sharedCtx = null;
    if (!sharedCtx) {
      sharedCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 } as any);
    }
    if (sharedCtx.state === "suspended" || (sharedCtx.state as string) === "interrupted") void sharedCtx.resume().catch(() => {});
    if (sharedCtx.state === "closed") return null;
    return sharedCtx;
  } catch { return null; }
}
export function playPcm(bytes: number[], volume: number): { stop: () => void; ended: Promise<void> } {
  const ctx = getCtx();
  // fallback to WAV if AudioContext unavailable or closed
  if (!ctx || ctx.state === "closed") {
    const a = playWav(bytes, volume);
    return {
      stop: () => a.pause(),
      ended: new Promise<void>((res, rej) => {
        a.addEventListener("ended", () => res(), { once: true });
        a.addEventListener("pause", () => res(), { once: true });
        a.addEventListener("error", () => rej(new Error("PCM playback failed")), { once: true });
      }),
    };
  }
  const u8 = new Uint8Array(bytes);
  // bytes are i16 LE mono at 24000 Hz
  const samples = u8.length >> 1;
  if (samples === 0) {
    const a = playWav(bytes, volume);
    return {
      stop: () => a.pause(),
      ended: new Promise<void>((res, rej) => {
        a.addEventListener("ended", () => res(), { once: true });
        a.addEventListener("pause", () => res(), { once: true });
        a.addEventListener("error", () => rej(new Error("PCM playback failed")), { once: true });
      }),
    };
  }
  let buf: AudioBuffer;
  try {
    buf = ctx.createBuffer(1, samples, 24000);
  } catch {
    const a = playWav(bytes, volume);
    return {
      stop: () => a.pause(),
      ended: new Promise<void>((res, rej) => {
        a.addEventListener("ended", () => res(), { once: true });
        a.addEventListener("pause", () => res(), { once: true });
        a.addEventListener("error", () => rej(new Error("PCM playback failed")), { once: true });
      }),
    };
  }
  const ch = buf.getChannelData(0);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  try { src.connect(gain).connect(ctx.destination); } catch {
    const a = playWav(bytes, volume);
    return {
      stop: () => a.pause(),
      ended: new Promise<void>((res, rej) => {
        a.addEventListener("ended", () => res(), { once: true });
        a.addEventListener("pause", () => res(), { once: true });
        a.addEventListener("error", () => rej(new Error("PCM playback failed")), { once: true });
      }),
    };
  }
  window.dispatchEvent(new CustomEvent<number>("oc:tts-live", { detail: (samples / 24000) * 1000 }));
  let resolveEnded!: () => void;
  let timeout: number | undefined;
  const durationMs = (samples / 24000) * 1000;
  const ended = new Promise<void>((res) => {
    resolveEnded = () => {
      if (timeout !== undefined) { clearTimeout(timeout); timeout = undefined; }
      res();
    };
    src.onended = () => resolveEnded();
    // ponytail: timeout guards against suspended/interrupted context where onended never fires — speech cut mid-sentence would hang pump forever
    const slack = 4000;
    const maxMs = Math.max(durationMs + slack, 6000);
    timeout = window.setTimeout(() => {
      try { src.stop(); } catch {}
      resolveEnded();
    }, maxMs);
  });
  try { src.start(); } catch {
    if (timeout !== undefined) clearTimeout(timeout);
    // fallback to WAV if start throws (e.g. closed context)
    const a = playWav(bytes, volume);
    return {
      stop: () => a.pause(),
      ended: new Promise<void>((res, rej) => {
        a.addEventListener("ended", () => res(), { once: true });
        a.addEventListener("pause", () => res(), { once: true });
        a.addEventListener("error", () => rej(new Error("PCM playback failed")), { once: true });
      }),
    };
  }
  return {
    stop: () => { if (timeout !== undefined) { clearTimeout(timeout); timeout = undefined; } try { src.stop(); } catch {} resolveEnded(); },
    // allow caller to await ended or detect pause
    ended,
  };
}

// clause-aware chunker: prefers sentence terminals (.!?) but will split
// long sentences at clause marks (, ; : —) once minLen is met. Preserves
// prosody: never emits < MIN chars unless forced, never > MAX without split.
const TTS_MIN = 40;
const TTS_MAX = 220;
export function splitForSpeech(text: string): string[] {
  const cleaned = cleanSpeech(text);
  if (!cleaned) return [];
  if (cleaned.length <= TTS_MAX) {
    // short enough: keep as one natural chunk
    if (/[.!?]$/.test(cleaned) || cleaned.length >= TTS_MIN) return [cleaned];
    return [cleaned];
  }
  const out: string[] = [];
  let buf = "";
  // split keeping delimiters
  const parts = cleaned.match(/[^.!?,;:—]+[.!?,;:—]*\s*/g) || [cleaned];
  for (const part of parts) {
    const next = (buf + part).trim();
    const endsSentence = /[.!?][\s]*$/.test(part);
    const endsClause = /[,;:—][\s]*$/.test(part);
    if (buf && next.length > TTS_MAX) {
      if (buf.trim().length >= TTS_MIN) { out.push(buf.trim()); buf = part; }
      else { out.push(next.slice(0, TTS_MAX).trim()); buf = next.slice(TTS_MAX); }
      continue;
    }
    buf = next;
    if (endsSentence && buf.length >= TTS_MIN) { out.push(buf.trim()); buf = ""; }
    else if (endsClause && buf.length >= 80) { out.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) {
    if (buf.trim().length < TTS_MIN && out.length) out[out.length - 1] += " " + buf.trim();
    else out.push(buf.trim());
  }
  return out.filter(Boolean);
}

// all text-part content of a message, joined — streaming deltas included
export function full_text(m: Msg): string {
  return m.parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join(" ");
}

// batched tool roll-up — built to sound like a person giving a status blip:
// fuzzy quantities, rotating verbs/openers, at most two named items, and an
// anti-repeat guard so consecutive ticks never parrot the same sentence
const TOOL_SAY: Record<string, { v: string[]; n?: [string, string] }> = {
  read: { v: ["read", "skimmed", "looked through"], n: ["file", "files"] },
  write: { v: ["wrote", "created"], n: ["file", "files"] },
  edit: { v: ["edited", "updated", "tweaked"], n: ["file", "files"] },
  multiedit: { v: ["edited", "reworked"], n: ["file", "files"] },
  patch: { v: ["patched"], n: ["file", "files"] },
  bash: { v: ["ran", "kicked off"], n: ["command", "commands"] },
  grep: { v: ["searched the codebase", "dug through the code"] },
  glob: { v: ["scouted out candidate files", "rounded up matching files"] },
  list: { v: ["mapped out some folders", "listed directories"] },
  webfetch: { v: ["fetched", "pulled up"], n: ["web page", "web pages"] },
  websearch: { v: ["searched the web", "looked something up online"] },
  task: { v: ["delegated part of the work to a subagent"] },
  todowrite: { v: ["updated its plan", "jotted down next steps"] },
  question: { v: ["asked you something"] },
};
let lastSay = "";
const sayPick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const qtyWord = (n: number) =>
  n <= 1 ? "a" : n === 2 ? "a couple of" : n <= 4 ? "a few" : n <= 8 ? "several" : "a bunch of";

function describeTool(tool: string, n: number): string {
  const t = TOOL_SAY[tool];
  if (!t) return `ran a ${tool} step`;
  const verb = sayPick(t.v);
  if (!t.n) return verb; // verb already carries the object ("searched the codebase")
  return `${verb} ${qtyWord(n)} ${n === 1 ? t.n[0] : t.n[1]}`;
}

function buildOne(counts: Map<string, number>): string {
  const items = [...counts.entries()].map(([tool, n]) => describeTool(tool, n));
  let body: string;
  if (items.length === 1) {
    body = sayPick(["", "just ", "so far — "]) + items[0];
  } else if (items.length === 2) {
    body = sayPick([`${items[0]}, then ${items[1]}`, `${items[0]} and also ${items[1]}`, `${items[0]} — plus ${items[1]}`]);
  } else {
    // don't enumerate blindly — name two, wave at the rest
    body = `${items[0]} and ${items[1]}, among other things`;
  }
  const s = body.trim();
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

export function buildEnumPhrase(counts: Map<string, number>): string {
  if (!counts.size) return "";
  let phrase = buildOne(counts);
  for (let i = 0; phrase === lastSay && i < 4; i++) phrase = buildOne(counts);
  lastSay = phrase;
  return phrase;
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function lowVariantFor(modelSel: string, providers: { id: string; models: { id: string; variants?: string[] }[] }[]): string | undefined {
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

// markdown scrub for mid-stream narration — complete code blocks become a
// placeholder, an open fence holds its text back until it closes
export const cleanSpeech = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/```[\s\S]*$/, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/\s{2,}/g, " ")
    .trim();
