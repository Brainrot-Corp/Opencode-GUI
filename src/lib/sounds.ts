// synthesized UI sounds (Web Audio) — no bundled assets.
// prefs are mirrored here by useSettings so any component can trigger a sound
// without prop-drilling.

export type SoundKind = "show" | "hide" | "send" | "reply";

export type SoundPrefs = {
  show: boolean;
  hide: boolean;
  send: boolean;
  reply: boolean;
  volume: number; // 0..1 master
};

let prefs: SoundPrefs = {
  show: true,
  hide: true,
  send: true,
  reply: true,
  volume: 0.6,
};

export function setSoundPrefs(p: Partial<SoundPrefs>) {
  prefs = { ...prefs, ...p };
}

let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(from: number, to: number, dur: number, vol: number, delay = 0) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export function playSound(kind: SoundKind) {
  if (!prefs[kind]) return;
  const v = Math.min(1, prefs.volume) * 0.22; // master ceiling stays subtle
  if (v <= 0) return;
  switch (kind) {
    case "show":
      tone(520, 780, 0.09, v);
      tone(780, 1040, 0.1, v * 0.8, 0.07);
      break;
    case "hide":
      tone(700, 420, 0.11, v);
      break;
    case "send":
      tone(1500, 900, 0.05, v * 0.55);
      break;
    case "reply":
      tone(880, 880, 0.13, v * 0.9);
      tone(1318, 1318, 0.18, v * 0.45, 0.06);
      break;
  }
}
