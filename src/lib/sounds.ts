// synthesized UI sounds (Web Audio) — no bundled assets.
// prefs are mirrored here by useSettings so any component can trigger a sound
// without prop-drilling.

export type SoundKind =
  | "show"
  | "hide"
  | "send"
  | "reply"
  | "type"
  | "erase"
  | "newline"
  | "resize"
  | "collapse"
  | "expand"
  | "maximize"
  | "close"
  | "click";

export type SoundPrefs = {
  show: boolean;
  hide: boolean;
  send: boolean;
  reply: boolean;
  type: boolean;
  resize: boolean;
  panels: boolean;
  maximize: boolean;
  close: boolean;
  click: boolean;
  volume: number; // 0..1 master
};

let prefs: SoundPrefs = {
  show: true,
  hide: true,
  send: true,
  reply: true,
  type: true,
  resize: true,
  panels: true,
  maximize: true,
  close: true,
  click: true,
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

// which preference gate controls each playable kind
const KIND_TOGGLE: Record<SoundKind, Exclude<keyof SoundPrefs, "volume">> = {
  show: "show",
  hide: "hide",
  send: "send",
  reply: "reply",
  type: "type",
  erase: "type",
  newline: "type",
  resize: "resize",
  collapse: "panels",
  expand: "panels",
  maximize: "maximize",
  close: "close",
  click: "click",
};

export function playSound(kind: SoundKind) {
  if (!prefs[KIND_TOGGLE[kind]]) return;
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
    case "type":
      tone(2000 + Math.random() * 500, 1500, 0.03, v * 0.45);
      break;
    case "erase":
      tone(900, 450, 0.055, v * 0.55);
      break;
    case "newline":
      tone(1046, 1046, 0.06, v * 0.65);
      tone(1568, 1568, 0.09, v * 0.4, 0.05);
      break;
    case "resize":
      tone(1700 + Math.random() * 300, 1450, 0.022, v * 0.3);
      break;
    case "collapse":
      tone(880, 500, 0.09, v * 0.7);
      break;
    case "expand":
      tone(520, 900, 0.09, v * 0.7);
      break;
    case "maximize":
      tone(600, 980, 0.08, v * 0.8);
      break;
    case "close":
      tone(700, 480, 0.07, v * 0.8);
      tone(480, 300, 0.1, v * 0.55, 0.07);
      break;
    case "click":
      tone(1250, 1000, 0.03, v * 0.4);
      break;
  }
}
