// Piano Visualizer — glowing Synthesia-style piano (plugin).
// Titlebar button + floating Overlay share localStorage "oc.piano-viz":
//   {open, geom:{x,y,w,h}, tempo, volume, demoId, fileName, showLabels,
//    octave, samples, midi}
// Song bytes are NOT persisted (only the demo id / file label); on boot the
// last demo is rebuilt from embedded note data. Demos live in-code because
// the host only scans plugin.json + main.js + styles.css (no binary assets).
// Sound: sampled Salamander grand via CDN fetch + decodeAudioData, with an
// oscillator fallback when offline. Play via mouse, computer keys, .mid file
// (hand-rolled SMF 0/1 parser, zero deps), or a Web MIDI device (v1 scope:
// notes + sustain pedal, no capture/export).
// Canvas2D only (no WebGL — safe on WebKitGTK); the "dark shader" is layered
// radial gradients + drifting blobs + grain + vignette.
// ponytail: single-file ceiling ~900 lines; if track mute/solo or recording
// lands, split audio/engine/parser into plugin-local modules (host has no
// relative imports, so bundle at install time or keep sections).

const KEY = "oc.piano-viz";
const EVT = "oc:piano-viz:changed";
const SF_BASE = "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3/";
const LOOKAHEAD = 4; // song-seconds visible above the keybed
const MIN_W = 560, MIN_H = 420;
const BLACK_H = 0.62; // black-key asset height as a fraction of keyH (draw + hit-test share this)
// glide-FX clocks (song-seconds, so pause freezes beams + trails coherently)
const TRAIL_DUR = 1.6; // how long a struck note keeps gliding upward
const TRAIL_RISE = 1.15; // trail rise speed × fall speed
const FLASH_DUR = 0.35; // strike bloom lifetime
const MAX_PARTS = 700; // ember particle cap

// two hands, like the reference visual: warm gold below middle C, cool blue above
export function handColor(midi) {
  if (clampN(Math.round(midi), 0, 127) < 60) return { core: "#fff3d6", mid: "#ffc46b", glow: "#ff8f2e" };
  return { core: "#e2f3ff", mid: "#7cc4ff", glow: "#3f7dff" };
}

// computer-keyboard map: code -> semitone offset from C of base octave
const KEYMAP = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17,
  Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24,
};

export function clampN(n, a, b) {
  const v = Number(n);
  if (!Number.isFinite(v)) return a;
  return Math.min(Math.max(v, a), b);
}

const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export function midiToName(m) {
  const n = clampN(Math.round(m), 0, 127);
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

export function isBlackKey(m) {
  const p = ((Math.round(m) % 12) + 12) % 12;
  return p === 1 || p === 3 || p === 6 || p === 8 || p === 10;
}

export function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// ---- SMF parser (pure, node-testable) -------------------------------------

export function readVLQ(bytes, pos) {
  let v = 0;
  let p = pos;
  for (let i = 0; i < 4; i++) {
    if (p >= bytes.length) throw new Error("truncated VLQ");
    const b = bytes[p++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return { value: v, next: p };
  }
  throw new Error("VLQ too long");
}

function u32(bytes, p) {
  return ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
}

function tickToSec(tempos, division, tick) {
  // tempos: sorted [{tick, us}] — default 120bpm
  let sec = 0;
  let lastTick = 0;
  let us = 500000;
  for (const t of tempos) {
    if (t.tick > tick) break;
    sec += ((t.tick - lastTick) / division) * (us / 1e6);
    lastTick = t.tick;
    us = t.us;
  }
  sec += ((tick - lastTick) / division) * (us / 1e6);
  return sec;
}

// buffer: ArrayBuffer | Uint8Array → {division, duration, tracks, notes[]}
// notes: [{midi, t0, t1, vel, track}] in seconds, sorted by t0
export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 14) throw new Error("not a MIDI file (too short)");
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag !== "MThd") throw new Error("not a MIDI file (bad header)");
  if (u32(bytes, 4) !== 6) throw new Error("bad MIDI header length");
  const division = (bytes[12] << 8) | bytes[13];
  if (division & 0x8000) throw new Error("SMPTE timecode not supported");
  if (division === 0) throw new Error("bad MIDI division");
  const nTracks = (bytes[10] << 8) | bytes[11];
  const CH_LEN = { 8: 2, 9: 2, 10: 2, 11: 2, 12: 1, 13: 1, 14: 2 };
  const tempos = [];
  const names = [];
  const open = new Map(); // "track:ch:midi" -> [{tick, vel}]
  const rawNotes = []; // tick-based pairs; converted to seconds after all tracks are read
  let p = 14;
  let parsedTracks = 0;
  for (let tr = 0; tr < nTracks; tr++) {
    if (p + 8 > bytes.length) break;
    const ttag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const len = u32(bytes, p + 4);
    if (ttag !== "MTrk") { p += 8 + len; continue; }
    parsedTracks++;
    const end = Math.min(bytes.length, p + 8 + len);
    let q = p + 8;
    let tick = 0;
    let status = 0;
    while (q < end) {
      const d = readVLQ(bytes, q);
      tick += d.value;
      q = d.next;
      if (q >= end) break;
      let b = bytes[q];
      if (b & 0x80) { status = b; q++; b = bytes[q]; }
      if (status === 0xff) {
        const type = bytes[q]; q++;
        const ld = readVLQ(bytes, q); q = ld.next;
        if (type === 0x51 && ld.value === 3 && q + 3 <= end) {
          const us = (bytes[q] << 16) | (bytes[q + 1] << 8) | bytes[q + 2];
          if (us > 0) tempos.push({ tick, us });
        } else if (type === 0x03) {
          try { names[tr] = new TextDecoder().decode(bytes.slice(q, q + ld.value)); } catch { /* keep index */ }
        }
        q += ld.value;
      } else if (status === 0xf0 || status === 0xf7) {
        const ld = readVLQ(bytes, q); q = ld.next + ld.value;
      } else {
        const hi = (status >> 4) & 0xf;
        const need = CH_LEN[hi];
        if (need == null) break; // corrupt — stop this track
        const d1 = b;
        const d2 = need === 2 ? bytes[q + 1] : 0;
        q += need;
        if (hi === 9 || hi === 8) {
          const k = tr + ":" + (status & 0xf) + ":" + d1;
          const on = hi === 9 && d2 > 0;
          if (on) {
            if (!open.has(k)) open.set(k, []);
            open.get(k).push({ tick, vel: d2 / 127 });
          } else {
            const stack = open.get(k);
            if (stack && stack.length) {
              const st = stack.pop();
              if (tick > st.tick && d1 >= 21 && d1 <= 108) {
                rawNotes.push({ midi: d1, tick0: st.tick, tick1: tick, vel: clampN(st.vel, 0.1, 1), track: tr });
              }
            }
          }
        }
      }
    }
    p = end;
  }
  if (!parsedTracks) throw new Error("no MIDI tracks found");
  // tempo map is only complete after every track is read — convert ticks now
  const tmap = [...tempos].sort((a, c) => a.tick - c.tick);
  if (!tmap.length || tmap[0].tick !== 0) tmap.unshift({ tick: 0, us: 500000 });
  const notes = [];
  for (const r of rawNotes) {
    const t0 = tickToSec(tmap, division, r.tick0);
    const t1 = tickToSec(tmap, division, r.tick1);
    if (t1 > t0) notes.push({ midi: r.midi, t0, t1: Math.max(t1, t0 + 0.03), vel: r.vel, track: r.track });
  }
  notes.sort((a, b) => a.t0 - b.t0 || a.midi - b.midi);
  let duration = 0;
  for (const n of notes) if (n.t1 > duration) duration = n.t1;
  return { division, duration, tracks: names, notes };
}

// ---- embedded demos (public-domain melodies, [midi, beats] pairs) ---------

function seq(list, beat, track) {
  let t = 0;
  const notes = [];
  for (const [m, lb] of list) {
    if (m > 0) notes.push({ midi: m, t0: t, t1: t + lb * beat, vel: 0.82, track });
    t += lb * beat;
  }
  return { notes, duration: t };
}

function withBass(melody, bassNotes, beat) {
  // bassNotes: [midi per 4-beat bar]
  const notes = [...melody.notes];
  let bar = 0;
  for (let t = 0; t < melody.duration; t += 4 * beat) {
    const m = bassNotes[bar % bassNotes.length];
    if (m > 0) notes.push({ midi: m, t0: t, t1: Math.min(t + 3.4 * beat, melody.duration), vel: 0.6, track: 1 });
    bar++;
  }
  notes.sort((a, b) => a.t0 - b.t0 || a.midi - b.midi);
  return { notes, duration: melody.duration };
}

export function demoSongs() {
  const E4 = 64, F4 = 65, G4 = 67, A4 = 69, B4 = 71, C5 = 72, D5 = 74, E5 = 76;
  const D4 = 62, GS4 = 68, DS5 = 75; // D4 / G#4 / D#5
  const ode = seq([
    [E4, 1], [E4, 1], [F4, 1], [G4, 1], [G4, 1], [F4, 1], [E4, 1], [D4, 1],
    [60, 1], [60, 1], [D4, 1], [E4, 1], [E4, 1.5], [D4, 0.5], [D4, 2],
    [E4, 1], [E4, 1], [F4, 1], [G4, 1], [G4, 1], [F4, 1], [E4, 1], [D4, 1],
    [60, 1], [60, 1], [D4, 1], [E4, 1], [D4, 1.5], [60, 0.5], [60, 2],
    [D4, 1], [D4, 1], [E4, 1], [60, 1], [D4, 1], [E4, 0.5], [F4, 0.5], [E4, 1],
    [60, 1], [D4, 1], [E4, 0.5], [F4, 0.5], [E4, 1], [D4, 1], [60, 1], [D4, 1], [60, 2],
  ], 0.42, 0);
  const odeFull = withBass(ode, [48, 55, 48, 55, 48, 55, 48, 43, 48, 55], 0.42);
  const elise = seq([
    [E5, 0.5], [DS5, 0.5], [E5, 0.5], [DS5, 0.5], [E5, 0.5], [B4, 0.5], [D5, 0.5], [C5, 0.5],
    [A4, 1], [0, 0.5], [60, 0.5], [E4, 0.5], [A4, 0.5], [B4, 1], [0, 0.5],
    [E4, 0.5], [GS4, 0.5], [B4, 0.5], [C5, 1], [0, 0.5],
    [E4, 0.5], [E5, 0.5], [DS5, 0.5], [E5, 0.5], [DS5, 0.5], [E5, 0.5], [B4, 0.5], [D5, 0.5], [C5, 0.5],
    [A4, 1], [0, 0.5], [60, 0.5], [E4, 0.5], [A4, 0.5], [B4, 1], [0, 0.5],
    [E4, 0.5], [C5, 0.5], [B4, 0.5], [A4, 1],
  ], 0.4, 0);
  const minuet = seq([
    [D5, 1], [74 + 5, 1], [74 + 7, 1], [74 + 9, 1], [74 + 10, 1],
    [74 + 12, 1.5], [74 + 5, 0.5], [74 + 5, 1],
    [74 + 14, 1], [74 + 10, 1], [74 + 12, 1], [74 + 14, 1], [74 + 16, 1],
    [74 + 17, 1.5], [74 + 5, 0.5], [74 + 5, 1],
    [74 + 12, 1], [74 + 9, 1], [74 + 10, 1], [74 + 12, 1], [74 + 11, 1],
    [74 + 10, 2], [0, 1],
    [74 + 7, 1], [74 + 2, 1], [74 + 4, 1], [74 + 5, 1], [74 + 7, 1],
    [74 + 9, 2], [0, 1],
  ], 0.4, 0);
  return [
    { id: "ode", name: "Ode to Joy — Beethoven", ...odeFull },
    { id: "fur-elise", name: "Für Elise — Beethoven", ...elise },
    { id: "minuet", name: "Minuet in G — Bach", ...minuet },
  ];
}

// ---- persistence (guarded so node import stays side-effect free) -----------

function defaultGeom() {
  const w = 920, h = 620;
  let vw = 1280, vh = 800;
  try { vw = window.innerWidth; vh = window.innerHeight; } catch { /* node */ }
  return {
    x: Math.max(12, Math.floor((vw - w) / 2)),
    y: Math.max(12, Math.floor((vh - h) / 2 - 20)),
    w: Math.min(w, vw - 24), h: Math.min(h, vh - 24),
  };
}

function loadPersist() {
  const fb = {
    open: false, geom: defaultGeom(), tempo: 1, volume: 0.8,
    demoId: "ode", fileName: "", showLabels: true, octave: 4, samples: true, midi: false,
  };
  try {
    if (typeof localStorage === "undefined") return fb;
    const raw = localStorage.getItem(KEY);
    if (!raw) return fb;
    const p = JSON.parse(raw);
    let geom = p.geom && typeof p.geom === "object" ? p.geom : defaultGeom();
    let vw = 1280, vh = 800;
    try { vw = window.innerWidth; vh = window.innerHeight; } catch {}
    geom = {
      x: clampN(geom.x, 0, Math.max(0, vw - MIN_W)),
      y: clampN(geom.y, 0, Math.max(0, vh - MIN_H)),
      w: clampN(geom.w, MIN_W, Math.max(MIN_W, vw - 12)),
      h: clampN(geom.h, MIN_H, Math.max(MIN_H, vh - 12)),
    };
    return {
      open: !!p.open, geom,
      tempo: clampN(p.tempo, 0.25, 2), volume: clampN(p.volume ?? 0.8, 0, 1),
      demoId: typeof p.demoId === "string" ? p.demoId : "ode",
      fileName: typeof p.fileName === "string" ? p.fileName.slice(0, 80) : "",
      showLabels: p.showLabels !== false, octave: clampN(p.octave ?? 4, 0, 7),
      samples: p.samples !== false, midi: !!p.midi,
    };
  } catch { return fb; }
}

function savePersist(patch, notify = true) {
  try {
    if (typeof localStorage === "undefined") return;
    const cur = loadPersist();
    localStorage.setItem(KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {}
  if (notify) {
    try {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVT));
    } catch {}
  }
}

// ---- audio engine (WebAudio; created lazily inside a user gesture) ---------

function createEngine() {
  const E = {
    ctx: null, master: null, volume: 0.8,
    buffers: new Map(), inflight: new Map(), failed: false,
    voices: new Map(), sustain: false, held: new Set(),
  };
  E.ensure = function () {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!E.ctx) {
      E.ctx = new AC();
      E.master = E.ctx.createGain();
      E.master.gain.value = E.volume;
      E.master.connect(E.ctx.destination);
    }
    if (E.ctx.state === "suspended") void E.ctx.resume();
    return E.ctx;
  };
  E.setVolume = function (v) {
    E.volume = clampN(v, 0, 1);
    if (E.master) E.master.gain.value = E.volume;
  };
  E.loadSample = function (midi) {
    if (E.buffers.has(midi) || E.inflight.has(midi) || E.failed) return E.inflight.get(midi) || null;
    if (midi < 21 || midi > 108) return null;
    try {
      E.ensure();
      const pr = fetch(SF_BASE + midiToName(midi) + ".mp3")
        .then((r) => { if (!r.ok) throw new Error("sf " + r.status); return r.arrayBuffer(); })
        .then((ab) => E.ctx.decodeAudioData(ab))
        .then((buf) => { E.buffers.set(midi, buf); E.inflight.delete(midi); return buf; })
        .catch(() => { E.inflight.delete(midi); return null; });
      E.inflight.set(midi, pr);
      return pr;
    } catch { return null; }
  };
  E.preload = function (midis, useSamples) {
    if (!useSamples) return;
    try { E.ensure(); } catch { return; }
    const uniq = [...new Set(midis)].filter((m) => m >= 21 && m <= 108).slice(0, 64);
    for (const m of uniq) E.loadSample(m);
  };
  function reg(midi, nodes, stopFn) {
    if (!E.voices.has(midi)) E.voices.set(midi, new Set());
    const rec = { nodes, stop: stopFn };
    E.voices.get(midi).add(rec);
    return rec;
  }
  function envGain(peak, dur) {
    const g = E.ctx.createGain();
    const t = E.ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t + 0.008);
    if (dur != null) {
      const hold = Math.max(0.05, Math.min(dur, 4));
      g.gain.setTargetAtTime(Math.max(0.001, peak * 0.55), t + 0.02, Math.max(0.25, hold / 2));
      g.gain.setTargetAtTime(0.0001, t + hold, 0.09);
    } else {
      g.gain.setTargetAtTime(Math.max(0.001, peak * 0.7), t + 0.02, 1.4);
    }
    return g;
  }
  E.noteOn = function (midi, vel = 0.8, dur = null, useSamples = true) {
    try { E.ensure(); } catch { return; }
    const m = clampN(Math.round(midi), 21, 108);
    const v = clampN(vel, 0.05, 1) * E.volume;
    const buf = useSamples && !E.failed ? E.buffers.get(m) : null;
    if (buf) {
      const src = E.ctx.createBufferSource();
      src.buffer = buf;
      const g = envGain(Math.max(0.001, v), dur);
      src.connect(g).connect(E.master);
      const t = E.ctx.currentTime;
      const stopAt = dur != null ? t + Math.min(dur, 4) + 0.5 : t + 8;
      try { src.start(t); src.stop(stopAt); } catch {}
      const rec = reg(m, [src, g], () => {
        try {
          g.gain.cancelScheduledValues(E.ctx.currentTime);
          g.gain.setTargetAtTime(0.0001, E.ctx.currentTime, 0.06);
          src.stop(E.ctx.currentTime + 0.4);
        } catch {}
      });
      src.onended = () => { try { E.voices.get(m)?.delete(rec); } catch {} };
      return;
    }
    if (useSamples) E.loadSample(m); // learn for next hit; this one is synth
    const f = midiToFreq(m);
    const g = envGain(Math.max(0.001, v * 0.7), dur);
    const o1 = E.ctx.createOscillator(); o1.type = "triangle"; o1.frequency.value = f;
    const o2 = E.ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 2;
    const g2 = E.ctx.createGain(); g2.gain.value = 0.25;
    o1.connect(g); o2.connect(g2).connect(g); g.connect(E.master);
    const t = E.ctx.currentTime;
    const stopAt = dur != null ? t + Math.min(dur, 4) + 0.5 : t + 8;
    try { o1.start(t); o2.start(t); o1.stop(stopAt); o2.stop(stopAt); } catch {}
    const rec = reg(m, [o1, o2, g, g2], () => {
      try {
        g.gain.cancelScheduledValues(E.ctx.currentTime);
        g.gain.setTargetAtTime(0.0001, E.ctx.currentTime, 0.06);
        o1.stop(E.ctx.currentTime + 0.4); o2.stop(E.ctx.currentTime + 0.4);
      } catch {}
    });
    o1.onended = () => { try { E.voices.get(m)?.delete(rec); } catch {} };
  };
  E.noteOff = function (midi) {
    const m = clampN(Math.round(midi), 21, 108);
    if (E.sustain) { E.held.add(m); return; }
    const set = E.voices.get(m);
    if (!set) return;
    for (const rec of [...set]) { try { rec.stop(); } catch {} set.delete(rec); }
  };
  E.pedal = function (down) {
    E.sustain = !!down;
    if (!down) {
      for (const m of [...E.held]) { E.held.delete(m); E.noteOff(m); }
    }
  };
  E.stopAll = function () {
    for (const [, set] of E.voices) for (const rec of [...set]) { try { rec.stop(); } catch {} }
    E.voices.clear();
    E.held.clear();
  };
  return E;
}

// ---- keyboard geometry (shared by canvas + hit-testing) --------------------

function keyLayout(w) {
  // returns {whites: [{midi,x,w}], blacks: [...], whiteW}
  const whites = [];
  const blacks = [];
  let wi = 0;
  for (let m = 21; m <= 108; m++) if (!isBlackKey(m)) { whites.push(m); wi++; }
  const whiteW = w / whites.length;
  const xs = new Map();
  whites.forEach((m, i) => xs.set(m, i * whiteW));
  for (let m = 21; m <= 108; m++) {
    if (!isBlackKey(m)) continue;
    const leftWhite = m - 1;
    const x = (xs.get(leftWhite) ?? 0) + whiteW - whiteW * 0.32;
    blacks.push({ midi: m, x, w: whiteW * 0.64 });
  }
  return { whites: whites.map((m) => ({ midi: m, x: xs.get(m), w: whiteW })), blacks, whiteW };
}

// device-px hit-test against the drawn keybed: black keys only exist in the
// top BLACK_H slice, so a press below their asset falls through to the white
// key underneath (x/y/keyTop in the same space, blackH = keyTop + keyH*BLACK_H)
export function keyAt(geom, x, y, keyTop, blackBottom) {
  if (y >= keyTop && y <= blackBottom) {
    for (const b of geom.blacks) if (x >= b.x && x <= b.x + b.w) return b.midi;
  }
  if (y >= keyTop) {
    for (const w of geom.whites) if (x >= w.x && x <= w.x + w.w) return w.midi;
  }
  return null;
}

// pure drag-voice step for M1 glissando: prev = sounding midi (or null),
// hit = key under the cursor (or null when off the keybed).
// returns {off, on} midis to release/strike (null = no-op)
export function dragStep(prev, hit) {
  if (hit === prev) return { off: null, on: null };
  return { off: prev, on: hit };
}

// lane rect for a midi note inside a keyLayout (null when out of range)
function noteGeom(geom, midi) {
  const m = clampN(Math.round(midi), 21, 108);
  if (isBlackKey(m)) {
    const b = geom.blacks.find((k) => k.midi === m);
    return b ? { x: b.x, w: b.w } : null;
  }
  const k = geom.whites.find((k) => k.midi === m);
  return k ? { x: k.x + k.w * 0.08, w: k.w * 0.84 } : null;
}

// ---- activate --------------------------------------------------------------

export default function activate(api) {
  const { h, useState, useEffect, useRef } = api;

  function toggleOpen() {
    const s = loadPersist();
    s.open = !s.open;
    savePersist(s);
    try { api.playSound(s.open ? "expand" : "collapse"); } catch {}
  }

  function TitlebarBtn() {
    const [snap, setSnap] = useState(() => loadPersist());
    const [binding, setBinding] = useState(() => {
      try {
        const s = api.settings();
        const ph = s.pluginHotkeys || {};
        const v = ph["piano-visualizer:toggle"];
        if (v === null) return null;
        if (typeof v === "string" && v) return v;
        return "Alt+P";
      } catch { return "Alt+P"; }
    });
    useEffect(() => {
      const sync = () => {
        setSnap(loadPersist());
        try {
          const s = api.settings();
          const ph = s.pluginHotkeys || {};
          const v = ph["piano-visualizer:toggle"];
          setBinding(v === null ? null : (typeof v === "string" && v ? v : "Alt+P"));
        } catch {}
      };
      window.addEventListener(EVT, sync);
      window.addEventListener("storage", sync);
      return () => {
        window.removeEventListener(EVT, sync);
        window.removeEventListener("storage", sync);
      };
    }, []);
    const tip = binding
      ? `${snap.open ? "Hide" : "Show"} piano (${binding})${snap.midi ? " — MIDI linked" : ""}`
      : "Toggle piano";
    return h("button", {
      className: `icon-btn${snap.open ? " on" : ""}`,
      "data-tip": tip,
      "aria-pressed": snap.open,
      onClick: toggleOpen,
    }, h("i", { className: "fa-solid fa-music" }));
  }

  function Overlay() {
    const [snap, setSnap] = useState(() => loadPersist());
    const [song, setSong] = useState(() => {
      const demos = demoSongs();
      const d = demos.find((x) => x.id === loadPersist().demoId) || demos[0];
      return { name: d.name, notes: d.notes, duration: d.duration, demoId: d.id };
    });
    const [playing, setPlaying] = useState(false);
    const [posUi, setPosUi] = useState(0);
    const [err, setErr] = useState("");
    const [midiState, setMidiState] = useState("off"); // off|on|denied|unsupported|error
    const [midiCount, setMidiCount] = useState(0);
    const [sfState, setSfState] = useState("idle"); // idle|loading|ready|synth
    const canvasRef = useRef(null);
    const panelRef = useRef(null);
    const fileRef = useRef(null);
    const engineRef = useRef(null);
    const songRef = useRef(song);
    songRef.current = song;
    const simRef = useRef({ playing: false, pos: 0, trigIdx: 0, active: [] });
    const liveRef = useRef(new Map()); // midi -> count (computer + device + pointer)
    const snapRef = useRef(snap);
    snapRef.current = snap;
    const midiRef = useRef({ access: null, hooked: new Set() });
    const grainRef = useRef(null);
    const glissRef = useRef(new Map()); // pointerId -> sounding midi (null = held off-keys)
    // glide-FX: struck notes keep rising as light trails + embers (never pop out)
    const trailsRef = useRef([]); // {midi, t1} in song-seconds
    const partsRef = useRef([]); // {x,y,vx,vy,life,max,size,col} in device px
    const flashRef = useRef([]); // {midi, at} strike blooms in song-seconds
    const starsRef = useRef(null); // night-sky points [{x,y,r,ph}] normalized

    if (!engineRef.current) engineRef.current = createEngine();
    const engine = engineRef.current;

    const flashErr = (msg) => {
      setErr(msg);
      window.clearTimeout(flashErr.t);
      flashErr.t = window.setTimeout(() => setErr(""), 5000);
    };

    const clearFx = () => {
      trailsRef.current = [];
      partsRef.current = [];
      flashRef.current = [];
    };

    // ember burst at the keybed for a struck note
    const burst = (midi, count = 6, power = 1) => {
      const cv = canvasRef.current;
      if (!cv || !cv.width) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const ng = noteGeom(keyLayout(cv.width), midi);
      if (!ng) return;
      const col = handColor(midi);
      const cx = ng.x + ng.w / 2;
      const keyTop = cv.height - clampN(cv.height * 0.17, 56 * dpr, 110 * dpr);
      const arr = partsRef.current;
      for (let i = 0; i < count; i++) {
        if (arr.length >= MAX_PARTS) arr.shift();
        const a = Math.random() * Math.PI * 2;
        const sp = (20 + Math.random() * 90) * dpr * power;
        arr.push({
          x: cx + (Math.random() - 0.5) * ng.w,
          y: keyTop - Math.random() * 6 * dpr,
          vx: Math.cos(a) * sp * 0.4,
          vy: -(40 + Math.random() * 160) * dpr * power,
          life: 0,
          max: 0.5 + Math.random() * 0.9,
          size: (1 + Math.random() * 2.2) * dpr,
          col: Math.random() < 0.3 ? col.core : col.mid,
        });
      }
    };

    // ---- song ops ---------------------------------------------------------
    const loadDemo = (id) => {
      const demos = demoSongs();
      const d = demos.find((x) => x.id === id) || demos[0];
      engine.stopAll();
      simRef.current = { playing: false, pos: 0, trigIdx: 0, active: [] };
      setPlaying(false);
      setPosUi(0);
      setSong({ name: d.name, notes: d.notes, duration: d.duration, demoId: d.id });
      clearFx();
      engine.preload(d.notes.map((n) => n.midi), snapRef.current.samples);
      setSfState((s) => (s === "idle" && snapRef.current.samples ? "loading" : s));
      const p = loadPersist();
      savePersist({ ...p, demoId: d.id, fileName: "" }, false);
      setSnap(loadPersist());
    };

    const loadFile = async (file) => {
      if (!file) return;
      try {
        const ab = await file.arrayBuffer();
        const parsed = parseMidi(ab);
        if (!parsed.notes.length) { flashErr("No playable notes in " + file.name); return; }
        engine.stopAll();
        simRef.current = { playing: false, pos: 0, trigIdx: 0, active: [] };
        setPlaying(false);
        setPosUi(0);
        setSong({ name: file.name, notes: parsed.notes, duration: parsed.duration, demoId: "" });
        clearFx();
        engine.preload(parsed.notes.map((n) => n.midi), snapRef.current.samples);
        setSfState((s) => (snapRef.current.samples ? "loading" : s));
        const p = loadPersist();
        savePersist({ ...p, demoId: "", fileName: file.name.slice(0, 80) }, false);
        setSnap(loadPersist());
        try { api.playSound("expand"); } catch {}
      } catch (e) {
        flashErr("Couldn't parse " + file.name + ": " + (e instanceof Error ? e.message : String(e)));
      }
    };

    const seek = (t) => {
      const s = songRef.current;
      const nt = clampN(t, 0, Math.max(0.01, s.duration));
      engine.stopAll();
      // re-arm trigger index at seek point
      let idx = 0;
      while (idx < s.notes.length && s.notes[idx].t0 <= nt) idx++;
      simRef.current.pos = nt;
      simRef.current.trigIdx = idx;
      simRef.current.active = s.notes.filter((n) => n.t0 <= nt && n.t1 > nt).map((n) => ({ midi: n.midi, t1: n.t1 }));
      clearFx();
      setPosUi(nt);
    };

    const startPlay = () => {
      const s = songRef.current;
      if (!s.notes.length) return;
      try { engine.ensure(); } catch { flashErr("Audio unavailable in this WebView"); return; }
      if (simRef.current.pos >= s.duration - 0.05) {
        simRef.current.pos = 0;
        simRef.current.trigIdx = 0;
        simRef.current.active = [];
      }
      // re-arm trigger index from current pos (covers seek-while-paused)
      let idx = 0;
      while (idx < s.notes.length && s.notes[idx].t0 <= simRef.current.pos) idx++;
      simRef.current.trigIdx = idx;
      simRef.current.active = s.notes
        .filter((n) => n.t0 <= simRef.current.pos && n.t1 > simRef.current.pos)
        .map((n) => ({ midi: n.midi, t1: n.t1 }));
      for (const a of simRef.current.active) engine.noteOn(a.midi, 0.7, (a.t1 - simRef.current.pos) / snapRef.current.tempo, snapRef.current.samples);
      simRef.current.playing = true;
      setPlaying(true);
    };

    const pausePlay = () => {
      simRef.current.playing = false;
      engine.stopAll();
      // keep active list for resume visuals, drop sounding voices only
      setPlaying(false);
    };

    const stopPlay = () => {
      simRef.current.playing = false;
      simRef.current.pos = 0;
      simRef.current.trigIdx = 0;
      simRef.current.active = [];
      engine.stopAll();
      clearFx();
      setPlaying(false);
      setPosUi(0);
    };

    // ---- live note helpers (computer / pointer / MIDI device) --------------
    const liveAdd = (m) => {
      const map = liveRef.current;
      map.set(m, (map.get(m) || 0) + 1);
    };
    const liveDel = (m) => {
      const map = liveRef.current;
      const c = (map.get(m) || 0) - 1;
      if (c <= 0) map.delete(m);
      else map.set(m, c);
    };
    const strikeLive = (m, vel = 0.85) => {
      try { engine.ensure(); } catch {}
      engine.noteOn(m, vel, null, snapRef.current.samples);
      liveAdd(m);
      flashRef.current.push({ midi: m, at: simRef.current.pos });
      if (flashRef.current.length > 120) flashRef.current.splice(0, flashRef.current.length - 120);
      burst(m, 6, 1);
    };
    const releaseLive = (m) => {
      engine.noteOff(m);
      liveDel(m);
      // the released key keeps gliding as a light trail like song notes
      if (!liveRef.current.has(m)) {
        trailsRef.current.push({ midi: m, t1: simRef.current.pos });
        if (trailsRef.current.length > 400) trailsRef.current.splice(0, trailsRef.current.length - 400);
      }
    };

    // ---- Web MIDI ----------------------------------------------------------
    const hookInputs = () => {
      const access = midiRef.current.access;
      if (!access) return;
      let n = 0;
      for (const input of access.inputs.values()) {
        n++;
        if (midiRef.current.hooked.has(input.id)) continue;
        midiRef.current.hooked.add(input.id);
        input.onmidimessage = (ev) => {
          const d = ev.data;
          if (!d || d.length < 3) return;
          const cmd = d[0] & 0xf0;
          if (cmd === 0x90 && d[2] > 0) strikeLive(clampN(d[1], 21, 108), clampN(d[2] / 127, 0.1, 1));
          else if (cmd === 0x80 || (cmd === 0x90 && d[2] === 0)) releaseLive(clampN(d[1], 21, 108));
          else if (cmd === 0xb0 && d[1] === 64) engine.pedal(d[2] >= 64);
        };
      }
      setMidiCount(n);
    };
    const connectMidi = async () => {
      if (typeof navigator === "undefined" || !navigator.requestMIDIAccess) {
        setMidiState("unsupported");
        flashErr("Web MIDI not available in this WebView");
        return;
      }
      try {
        const access = await navigator.requestMIDIAccess({ sysex: false });
        midiRef.current.access = access;
        access.onstatechange = () => hookInputs();
        hookInputs();
        const p = loadPersist();
        savePersist({ ...p, midi: true }, false);
        setSnap(loadPersist());
        setMidiState("on");
        try { api.playSound("click"); } catch {}
      } catch {
        setMidiState("denied");
        flashErr("MIDI access denied — check browser permission");
      }
    };
    const disconnectMidi = () => {
      const access = midiRef.current.access;
      if (access) {
        for (const input of access.inputs.values()) {
          try { input.onmidimessage = null; input.close?.(); } catch {}
        }
      }
      midiRef.current = { access: null, hooked: new Set() };
      setMidiCount(0);
      setMidiState("off");
      const p = loadPersist();
      savePersist({ ...p, midi: false }, false);
      setSnap(loadPersist());
    };

    // ---- sync open/persist --------------------------------------------------
    useEffect(() => {
      const sync = () => setSnap(loadPersist());
      window.addEventListener(EVT, sync);
      window.addEventListener("storage", sync);
      return () => {
        window.removeEventListener(EVT, sync);
        window.removeEventListener("storage", sync);
      };
    }, []);

    // auto-try MIDI once per mount when previously linked
    useEffect(() => {
      if (loadPersist().midi && midiState === "off") void connectMidi();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // preload samples for the boot demo (after first gesture ideally; try now, retry on play)
    useEffect(() => {
      if (snap.samples && sfState === "idle") {
        setSfState("loading");
        const midis = songRef.current.notes.map((n) => n.midi);
        // don't force AudioContext here (autoplay policy) — preload buffers only if ctx exists
        try {
          if (engine.ctx) engine.preload(midis, true);
        } catch {}
        const iv = window.setInterval(() => {
          const got = engine.buffers.size;
          if (got > 0) { setSfState("ready"); window.clearInterval(iv); }
        }, 1500);
        const to = window.setTimeout(() => {
          window.clearInterval(iv);
          setSfState((s) => (engine.buffers.size > 0 ? "ready" : "synth"));
          if (engine.buffers.size === 0) engine.failed = true;
        }, 12000);
        return () => { window.clearInterval(iv); window.clearTimeout(to); };
      }
      return undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- main loop: advance sim + draw --------------------------------------
    useEffect(() => {
      if (!snap.open) return undefined;
      let raf = 0;
      let last = performance.now();
      let uiTick = 0;
      const frame = (now) => {
        raf = requestAnimationFrame(frame);
        const sim = simRef.current;
        const s = songRef.current;
        const tempo = snapRef.current.tempo;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (sim.playing) {
          const prev = sim.pos;
          let np = prev + dt * tempo;
          // fire crossed notes
          while (sim.trigIdx < s.notes.length && s.notes[sim.trigIdx].t0 <= np) {
            const n = s.notes[sim.trigIdx];
            if (n.t0 > prev - 0.001) {
              engine.noteOn(n.midi, n.vel, (n.t1 - n.t0) / tempo, snapRef.current.samples);
              sim.active.push({ midi: n.midi, t1: n.t1 });
              flashRef.current.push({ midi: n.midi, at: np });
              burst(n.midi, 5, 0.9);
            }
            sim.trigIdx++;
          }
          // ended notes glide on as light trails instead of popping out
          const kept = [];
          for (const a of sim.active) {
            if (a.t1 > np) kept.push(a);
            else trailsRef.current.push({ midi: a.midi, t1: a.t1 });
          }
          sim.active = kept;
          if (trailsRef.current.length > 400) trailsRef.current.splice(0, trailsRef.current.length - 400);
          if (flashRef.current.length > 120) flashRef.current.splice(0, flashRef.current.length - 120);
          // ambient embers while notes ring
          if (sim.active.length) {
            const a = sim.active[(Math.random() * sim.active.length) | 0];
            burst(a.midi, 1, 0.5);
          }
          sim.pos = np;
          if (np >= s.duration) {
            sim.playing = false;
            engine.stopAll();
            setPlaying(false);
          }
          uiTick += dt;
          if (uiTick > 0.25) { uiTick = 0; setPosUi(sim.pos); }
        }
        draw(now / 1000, dt);
      };
      const cv = canvasRef.current;
      const fit = () => {
        if (!cv) return;
        const r = cv.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = Math.max(1, Math.round(r.width * dpr));
        const H = Math.max(1, Math.round(r.height * dpr));
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      };
      fit();
      window.addEventListener("resize", fit);
      raf = requestAnimationFrame(frame);

      function draw(t, dt) {
        const cvs = canvasRef.current;
        if (!cvs) return;
        const ctx = cvs.getContext("2d");
        if (!ctx) return;
        const W = cvs.width, H = cvs.height;
        const sim = simRef.current;
        const s = songRef.current;
        const pos = sim.pos;
        const keyH = clampN(H * 0.17, 56 * (window.devicePixelRatio || 1), 110 * (window.devicePixelRatio || 1));
        const keyTop = H - keyH;
        const geom = keyLayout(W);

        // -- night backdrop --
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        ctx.clearRect(0, 0, W, H);
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, "#01020a");
        bg.addColorStop(0.55, "#040818");
        bg.addColorStop(1, "#03040c");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
        const blobs = [
          { x: 0.22 + 0.1 * Math.sin(t * 0.21), y: 0.3 + 0.08 * Math.cos(t * 0.17), r: 0.55, c: "10,50,66" },
          { x: 0.8 + 0.08 * Math.cos(t * 0.13), y: 0.55 + 0.1 * Math.sin(t * 0.19), r: 0.5, c: "30,20,70" },
          { x: 0.55 + 0.12 * Math.sin(t * 0.09 + 2), y: 0.12 + 0.06 * Math.cos(t * 0.23), r: 0.4, c: "8,36,46" },
        ];
        for (const b of blobs) {
          const g = ctx.createRadialGradient(W * b.x, H * b.y, 0, W * b.x, H * b.y, Math.max(W, H) * b.r);
          g.addColorStop(0, `rgba(${b.c},0.4)`);
          g.addColorStop(1, `rgba(${b.c},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, W, H);
        }
        // stars with a slow twinkle
        if (!starsRef.current) {
          const arr = [];
          for (let i = 0; i < 130; i++) {
            arr.push({ x: Math.random(), y: Math.random() * 0.72, r: 0.6 + Math.random() * 1.3, ph: Math.random() * 6.28 });
          }
          starsRef.current = arr;
        }
        ctx.fillStyle = "#cfe4ff";
        for (const st of starsRef.current) {
          ctx.globalAlpha = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(t * 1.4 + st.ph));
          ctx.fillRect(st.x * W, st.y * H, st.r * dpr, st.r * dpr);
        }
        ctx.globalAlpha = 1;
        // warm horizon glow above the keys (distant city)
        const hz = ctx.createRadialGradient(W * 0.5, keyTop, 0, W * 0.5, keyTop, W * 0.45);
        hz.addColorStop(0, "rgba(255,170,90,0.10)");
        hz.addColorStop(0.5, "rgba(120,90,160,0.05)");
        hz.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = hz;
        ctx.fillRect(0, 0, W, keyTop);
        // grain
        if (!grainRef.current) {
          const g = document.createElement("canvas");
          g.width = 140; g.height = 90;
          const gg = g.getContext("2d");
          const img = gg.createImageData(140, 90);
          for (let i = 0; i < img.data.length; i += 4) {
            const v = (Math.random() * 255) | 0;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
            img.data[i + 3] = 14;
          }
          gg.putImageData(img, 0, 0);
          grainRef.current = g;
        }
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.drawImage(grainRef.current, (t * 13) % 140, 0, W, H, 0, 0, W, H);
        ctx.restore();
        // lane separators (per octave C)
        ctx.fillStyle = "rgba(255,255,255,0.045)";
        for (const w of geom.whites) {
          if (w.midi % 12 === 0) ctx.fillRect(w.x, 0, 1.5, keyTop);
        }
        // beat grid — faint lines each second
        ctx.fillStyle = "rgba(150,190,255,0.05)";
        const pxPerSec = (keyTop) / LOOKAHEAD;
        const firstSec = Math.ceil(pos);
        for (let sec = firstSec; sec < pos + LOOKAHEAD; sec++) {
          const y = keyTop - (sec - pos) * pxPerSec;
          ctx.fillRect(0, y, W, 1);
        }

        // -- falling capsules (clipped to the sky) --
        const live = liveRef.current;
        const songActive = new Set(sim.active.map((a) => a.midi));
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, keyTop);
        ctx.clip();
        for (let i = sim.trigIdx; i < s.notes.length; i++) {
          const n = s.notes[i];
          if (n.t0 > pos + LOOKAHEAD) break;
          if (n.t1 < pos - 0.5) continue;
          const col = handColor(n.midi);
          const ng = noteGeom(geom, n.midi);
          if (!ng) continue;
          const x = ng.x, w = ng.w;
          const y0 = keyTop - ((n.t0 - pos) / LOOKAHEAD) * keyTop;
          const y1 = keyTop - ((n.t1 - pos) / LOOKAHEAD) * keyTop;
          const h = Math.max(4 * dpr, y0 - y1);
          const y = y0 - h;
          const hot = songActive.has(n.midi) || live.has(n.midi);
          // comet tail streaming above the capsule
          const tail = Math.min(keyTop * 0.22, h * 0.9 + 26 * dpr);
          const tg = ctx.createLinearGradient(0, y - tail, 0, y + h);
          tg.addColorStop(0, "rgba(0,0,0,0)");
          tg.addColorStop(1, col.mid);
          ctx.fillStyle = tg;
          ctx.fillRect(x + w * 0.3, y - tail, w * 0.4, tail + h);
          // capsule body: glow edges, white-hot core
          const bgrad = ctx.createLinearGradient(x, 0, x + w, 0);
          bgrad.addColorStop(0, col.glow);
          bgrad.addColorStop(0.5, col.core);
          bgrad.addColorStop(1, col.glow);
          ctx.shadowBlur = hot ? 24 : 14;
          ctx.shadowColor = col.glow;
          ctx.fillStyle = bgrad;
          const r = Math.min(w / 2, 6 * dpr);
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
          else ctx.rect(x, y, w, h);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        ctx.restore();

        // -- additive light pass: struck notes glide on as beams + trails --
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        // gliding trails of ended notes (song + released live keys)
        const risePx = pxPerSec * TRAIL_RISE;
        trailsRef.current = trailsRef.current.filter((tr) => pos - tr.t1 < TRAIL_DUR);
        for (const tr of trailsRef.current) {
          const age = pos - tr.t1;
          if (age < 0) continue;
          const fade = 1 - age / TRAIL_DUR;
          const col = handColor(tr.midi);
          const ng = noteGeom(geom, tr.midi);
          if (!ng) continue;
          const headY = keyTop - age * risePx;
          if (headY < -keyTop * 0.4) continue;
          const len = keyTop * 0.32;
          const w = Math.max(2 * dpr, ng.w * (isBlackKey(tr.midi) ? 0.9 : 0.55));
          const x = ng.x + ng.w / 2 - w / 2;
          const bot = Math.min(keyTop, headY + len);
          if (bot <= headY) continue;
          const tg = ctx.createLinearGradient(0, headY, 0, bot);
          tg.addColorStop(0, col.core);
          tg.addColorStop(0.25, col.mid);
          tg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = 0.75 * fade;
          ctx.fillStyle = tg;
          ctx.fillRect(x, headY, w, bot - headY);
          // bright head bead riding the trail tip
          ctx.globalAlpha = fade;
          ctx.fillStyle = col.core;
          ctx.beginPath();
          ctx.arc(x + w / 2, headY, Math.max(1.5 * dpr, w * 0.5), 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        // beams through currently ringing notes
        const beam = (midi, topY, alpha) => {
          const col = handColor(midi);
          const ng = noteGeom(geom, midi);
          if (!ng) return;
          const w = Math.max(2 * dpr, ng.w * 0.42);
          const x = ng.x + ng.w / 2 - w / 2;
          const bg2 = ctx.createLinearGradient(0, keyTop, 0, topY);
          bg2.addColorStop(0, col.core);
          bg2.addColorStop(0.3, col.mid);
          bg2.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = alpha;
          ctx.fillStyle = bg2;
          ctx.fillRect(x, topY, w, keyTop - topY);
        };
        for (const a of sim.active) beam(a.midi, 0, 0.5);
        for (const m of live.keys()) beam(m, keyTop * 0.45, 0.55);
        ctx.globalAlpha = 1;
        // strike blooms expanding on the keybed
        flashRef.current = flashRef.current.filter((f) => pos - f.at < FLASH_DUR + 0.05);
        for (const f of flashRef.current) {
          const age = pos - f.at;
          if (age < 0) continue;
          const k = age / FLASH_DUR;
          const col = handColor(f.midi);
          const ng = noteGeom(geom, f.midi);
          if (!ng) continue;
          const cx = ng.x + ng.w / 2;
          const rr = (4 + k * 46) * dpr;
          const fg = ctx.createRadialGradient(cx, keyTop, 0, cx, keyTop, rr);
          fg.addColorStop(0, col.core);
          fg.addColorStop(0.4, col.mid);
          fg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = 0.85 * (1 - k);
          ctx.fillStyle = fg;
          ctx.beginPath();
          ctx.arc(cx, keyTop, rr, 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        // embers drifting up (real-time clock so air stays alive on pause)
        const parts = partsRef.current;
        const step = Math.min(0.05, Math.max(0.0005, dt || 0.016));
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.life += step;
          if (p.life >= p.max) { parts.splice(i, 1); continue; }
          p.x += p.vx * step;
          p.y += p.vy * step;
          p.vx *= 1 - 0.6 * step;
          p.vy -= 30 * dpr * step;
          const k = 1 - p.life / p.max;
          ctx.globalAlpha = 0.8 * k;
          ctx.fillStyle = p.col;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.5, p.size * k), 0, 6.29);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        // landing line: soft halo + white-hot core
        const lg = ctx.createLinearGradient(0, keyTop - 5 * dpr, 0, keyTop + 5 * dpr);
        lg.addColorStop(0, "rgba(140,200,255,0)");
        lg.addColorStop(0.5, "rgba(140,200,255,0.35)");
        lg.addColorStop(1, "rgba(140,200,255,0)");
        ctx.fillStyle = lg;
        ctx.fillRect(0, keyTop - 5 * dpr, W, 10 * dpr);
        ctx.shadowBlur = 18 * dpr;
        ctx.shadowColor = "rgba(160,220,255,0.9)";
        ctx.fillStyle = "rgba(235,248,255,0.95)";
        ctx.fillRect(0, keyTop - 1 * dpr, W, 1.6 * dpr);
        ctx.shadowBlur = 0;
        ctx.restore();

        // -- keybed --
        const keyY = keyTop;
        for (const k of geom.whites) {
          const hot = songActive.has(k.midi) || live.has(k.midi);
          const hc = hot ? handColor(k.midi) : null;
          const g = ctx.createLinearGradient(0, keyY, 0, H);
          if (hc) { g.addColorStop(0, "#ffffff"); g.addColorStop(0.4, hc.mid); g.addColorStop(1, hc.glow); }
          else { g.addColorStop(0, "#dfe5ea"); g.addColorStop(0.85, "#b9c2c9"); g.addColorStop(1, "#9aa4ac"); }
          ctx.fillStyle = g;
          ctx.fillRect(k.x + 0.5, keyY, k.w - 1, keyH);
          if (hc) { ctx.shadowBlur = 18; ctx.shadowColor = hc.glow; ctx.fillRect(k.x + 0.5, keyY, k.w - 1, keyH); ctx.shadowBlur = 0; }
          ctx.strokeStyle = "rgba(0,0,0,0.45)";
          ctx.strokeRect(k.x + 0.5, keyY, k.w - 1, keyH);
          if (snapRef.current.showLabels && k.midi % 12 === 0) {
            ctx.fillStyle = hot ? "#062a2c" : "rgba(0,0,0,0.55)";
            ctx.font = `${Math.max(9, keyH * 0.11)}px JetBrains Mono, monospace`;
            ctx.textAlign = "center";
            ctx.fillText(midiToName(k.midi), k.x + k.w / 2, H - keyH * 0.08);
          }
        }
        for (const b of geom.blacks) {
          const hot = songActive.has(b.midi) || live.has(b.midi);
          const hc = hot ? handColor(b.midi) : null;
          const bh = keyH * BLACK_H;
          const g = ctx.createLinearGradient(0, keyY, 0, keyY + bh);
          if (hc) { g.addColorStop(0, hc.core); g.addColorStop(1, hc.glow); }
          else { g.addColorStop(0, "#2a3138"); g.addColorStop(1, "#0b0e12"); }
          ctx.fillStyle = g;
          ctx.fillRect(b.x, keyY, b.w, bh);
          if (hc) { ctx.shadowBlur = 16; ctx.shadowColor = hc.glow; ctx.fillRect(b.x, keyY, b.w, bh); ctx.shadowBlur = 0; }
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.strokeRect(b.x, keyY, b.w, bh);
        }
        // vignette
        const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
        v.addColorStop(0, "rgba(0,0,0,0)");
        v.addColorStop(1, "rgba(0,0,0,0.5)");
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, W, H);
      }

      return () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", fit);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snap.open, song.demoId, song.name]);

    // ---- computer-keyboard + panel keys -------------------------------------
    useEffect(() => {
      if (!snap.open) return undefined;
      const down = (e) => {
        const t = e.target;
        const typing = t && t.closest && t.closest("input, textarea, select");
        if (e.key === "Escape") {
          if (typing) { try { t.blur(); } catch {} return; }
          const s = loadPersist(); s.open = false; savePersist(s); setSnap(s);
          try { api.playSound("collapse"); } catch {}
          return;
        }
        if (typing) return;
        if (e.code === "Space") {
          e.preventDefault();
          // a focused toolbar button would also fire native click — take over
          // the gesture so play/pause toggles exactly once
          if (t && t.closest && t.closest("button")) { try { t.blur(); } catch {} }
          if (simRef.current.playing) pausePlay(); else startPlay();
          return;
        }
        if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
          // range sliders (seek/tempo/volume) keep native arrow behavior
          if (t && t.closest && t.closest('input[type="range"]')) return;
          e.preventDefault();
          const o = clampN(snapRef.current.octave + (e.code === "ArrowRight" ? 1 : -1), 0, 7);
          const p = loadPersist(); savePersist({ ...p, octave: o }, false); setSnap(loadPersist());
          return;
        }
        if (e.repeat) return;
        const semi = KEYMAP[e.code];
        if (semi == null) return;
        e.preventDefault();
        const midi = clampN(12 * (snapRef.current.octave + 1) + semi, 21, 108);
        strikeLive(midi);
      };
      const up = (e) => {
        const semi = KEYMAP[e.code];
        if (semi == null) return;
        const midi = clampN(12 * (snapRef.current.octave + 1) + semi, 21, 108);
        releaseLive(midi);
      };
      const blur = () => {
        // release stuck computer-key notes, keep MIDI-device notes (they send their own offs)
        for (const m of [...liveRef.current.keys()]) { try { engine.noteOff(m); } catch {} }
        liveRef.current.clear();
        glissRef.current.clear();
      };
      window.addEventListener("keydown", down);
      window.addEventListener("keyup", up);
      window.addEventListener("blur", blur);
      return () => {
        window.removeEventListener("keydown", down);
        window.removeEventListener("keyup", up);
        window.removeEventListener("blur", blur);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snap.open]);

    // stop everything when the panel closes / unmounts
    useEffect(() => {
      if (!snap.open) {
        simRef.current.playing = false;
        try { engineRef.current?.stopAll(); } catch {}
        glissRef.current.clear();
        setPlaying(false);
      }
      return () => { try { engineRef.current?.stopAll(); } catch {} };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snap.open]);

    // global hotkey path: onHotkey("playpause") re-dispatches here
    useEffect(() => {
      const toggle = () => {
        if (simRef.current.playing) pausePlay();
        else startPlay();
      };
      window.addEventListener("oc:piano-viz:playpause", toggle);
      return () => window.removeEventListener("oc:piano-viz:playpause", toggle);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!snap.open) return null;

    const geom = snap.geom;
    const demos = demoSongs();
    const tempoPct = Math.round(snap.tempo * 100);

    const onDragStart = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, input, select, textarea")) return;
      e.preventDefault();
      const el = panelRef.current;
      if (!el) return;
      const sx = e.clientX, sy = e.clientY;
      const g0 = { ...geom };
      document.body.style.userSelect = "none";
      let raf = 0;
      let last = { x: g0.x, y: g0.y };
      const flush = () => {
        raf = 0;
        el.style.left = last.x + "px";
        el.style.top = last.y + "px";
      };
      const move = (ev) => {
        last.x = clampN(g0.x + (ev.clientX - sx), 0, Math.max(0, window.innerWidth - 120));
        last.y = clampN(g0.y + (ev.clientY - sy), 0, Math.max(0, window.innerHeight - 80));
        if (!raf) raf = requestAnimationFrame(flush);
      };
      const up = () => {
        if (raf) cancelAnimationFrame(raf);
        const p = loadPersist();
        savePersist({ ...p, geom: { ...p.geom, x: last.x, y: last.y } }, false);
        setSnap(loadPersist());
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    const onResizeStart = (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const el = panelRef.current;
      if (!el) return;
      const sx = e.clientX, sy = e.clientY;
      const g0 = { ...geom };
      document.body.style.userSelect = "none";
      let raf = 0;
      let last = { ...g0 };
      const flush = () => {
        raf = 0;
        el.style.width = last.w + "px";
        el.style.height = last.h + "px";
      };
      const move = (ev) => {
        last = {
          ...g0,
          w: clampN(g0.w + (ev.clientX - sx), MIN_W, window.innerWidth - g0.x - 6),
          h: clampN(g0.h + (ev.clientY - sy), MIN_H, window.innerHeight - g0.y - 6),
        };
        if (!raf) raf = requestAnimationFrame(flush);
      };
      const up = () => {
        if (raf) cancelAnimationFrame(raf);
        const p = loadPersist();
        savePersist({ ...p, geom: last }, false);
        setSnap(loadPersist());
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

    const closePanel = () => {
      const s = loadPersist(); s.open = false; savePersist(s); setSnap(s);
      try { api.playSound("collapse"); } catch {}
    };

    const canvasPointer = (e) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * cv.width;
      const y = ((e.clientY - r.top) / r.height) * cv.height;
      const keyH = clampN(cv.height * 0.17, 56 * (window.devicePixelRatio || 1), 110 * (window.devicePixelRatio || 1));
      const keyTop = cv.height - keyH;
      if (y < keyTop) return null;
      return keyAt(keyLayout(cv.width), x, y, keyTop, keyTop + keyH * BLACK_H);
    };

    const fmtT = (sec) => {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ":" + String(s).padStart(2, "0");
    };

    const sfLabel = !snap.samples ? "synth" : sfState === "ready"
      ? "grand ready"
      : sfState === "loading" ? "loading grand…" : sfState === "synth" ? "synth (offline)" : "grand";
    const midiLabel = midiState === "on"
      ? `MIDI on (${midiCount})`
      : midiState === "unsupported" ? "no Web MIDI" : midiState === "denied" ? "MIDI denied" : "link MIDI";

    return h("div", {
      ref: panelRef,
      className: "piano-panel oc-panel",
      style: { left: geom.x + "px", top: geom.y + "px", width: geom.w + "px", height: geom.h + "px" },
    },
      h("div", { className: "piano-head oc-panel-head", onMouseDown: onDragStart },
        h("span", { className: `piano-title-dot${midiState === "on" ? " midi" : playing ? " live" : ""}` }),
        h("span", { className: "oc-panel-title" }, "Piano"),
        h("span", {
          className: "oc-panel-title",
          style: { opacity: 0.55, fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%" },
        }, song.name),
        h("div", { style: { marginLeft: "auto", display: "flex", gap: 4 } },
          h("button", { className: "icon-btn", "data-tip": "Close piano (Esc)", onClick: closePanel, "aria-label": "Close" },
            h("i", { className: "fa-solid fa-xmark" })),
        ),
      ),
      h("div", { className: "piano-toolbar" },
        h("button", { className: "piano-btn", "data-tip": "Open a .mid / .midi file", onClick: () => fileRef.current?.click() },
          h("i", { className: "fa-solid fa-folder-open" }), " MIDI"),
        h("input", {
          ref: fileRef, type: "file", accept: ".mid,.midi,audio/midi",
          className: "piano-hidden-file",
          onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ""; void loadFile(f); },
        }),
        h("select", {
          className: "oc-input", value: song.demoId || "__file__",
          "data-tip": "Demo songs (bundled, public domain)",
          onChange: (e) => { if (e.target.value !== "__file__") loadDemo(e.target.value); },
        },
          ...demos.map((d) => h("option", { key: d.id, value: d.id }, d.name)),
          ...(song.demoId ? [] : [h("option", { key: "__f", value: "__file__" }, "— loaded file —")]),
        ),
        h("button", {
          className: "piano-btn primary", "data-tip": playing ? "Pause (Space)" : "Play (Space)",
          onClick: () => { if (playing) pausePlay(); else startPlay(); },
        }, h("i", { className: playing ? "fa-solid fa-pause" : "fa-solid fa-play" })),
        h("button", { className: "piano-btn danger", "data-tip": "Stop", onClick: stopPlay },
          h("i", { className: "fa-solid fa-stop" })),
        h("span", { className: "piano-time" }, fmtT(posUi) + " / " + fmtT(song.duration)),
        h("input", {
          type: "range", className: "piano-seek", min: 0, max: Math.max(0.01, song.duration), step: 0.05,
          value: Math.min(posUi, song.duration),
          "aria-label": "Seek",
          onChange: (e) => { pausePlay(); seek(Number(e.target.value)); },
        }),
        h("span", { className: "piano-tempo", "data-tip": "Playback speed" },
          tempoPct + "%",
          h("input", {
            type: "range", min: 25, max: 200, step: 5, value: tempoPct, "aria-label": "Tempo",
            onChange: (e) => {
              const v = clampN(Number(e.target.value) / 100, 0.25, 2);
              const p = loadPersist(); savePersist({ ...p, tempo: v }, false); setSnap(loadPersist());
            },
          }),
        ),
      ),
      h("div", {
        className: "piano-stage",
        onDragOver: (e) => e.preventDefault(),
        onDrop: (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; void loadFile(f); },
      },
        h("canvas", {
          ref: canvasRef, className: "piano-canvas",
          onPointerDown: (e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            const m = canvasPointer(e);
            if (m == null) return;
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
            glissRef.current.set(e.pointerId, m);
            strikeLive(m);
          },
          onPointerMove: (e) => {
            if (!glissRef.current.has(e.pointerId)) return;
            const prev = glissRef.current.get(e.pointerId) ?? null;
            const hit = canvasPointer(e);
            const step = dragStep(prev, hit);
            if (step.off != null) releaseLive(step.off);
            if (step.on != null) strikeLive(step.on);
            glissRef.current.set(e.pointerId, hit);
          },
          onPointerUp: (e) => {
            const m = glissRef.current.get(e.pointerId);
            if (m != null) releaseLive(m);
            glissRef.current.delete(e.pointerId);
          },
          onPointerCancel: (e) => {
            const m = glissRef.current.get(e.pointerId);
            if (m != null) releaseLive(m);
            glissRef.current.delete(e.pointerId);
          },
        }),
      ),
      err ? h("div", { className: "piano-err" }, err) : null,
      h("div", { className: "piano-foot" },
        h("span", null, "Hold M1 + drag to glissando · keys ", h("span", { className: "kbd" }, "Z–M"), " + ", h("span", { className: "kbd" }, "Q–I"),
          " · octave ", h("span", { className: "kbd" }, "←"), "/", h("span", { className: "kbd" }, "→"),
          " C" + snap.octave + " · drop a .mid anywhere"),
        h("div", { className: "piano-foot-right" },
          h("span", { "data-tip": midiCount ? "MIDI inputs linked" : "No MIDI device linked yet" }, midiLabel),
          h("button", {
            className: `piano-btn${midiState === "on" ? " on" : ""}`,
            "data-tip": midiState === "on" ? "Unlink MIDI devices" : "Link a plugged-in MIDI keyboard (notes + sustain)",
            onClick: () => { if (midiState === "on") disconnectMidi(); else void connectMidi(); },
          }, h("i", { className: "fa-solid fa-plug" })),
          h("label", { "data-tip": "Show note names on C keys" },
            h("input", {
              type: "checkbox", checked: snap.showLabels,
              onChange: (e) => {
                const p = loadPersist(); savePersist({ ...p, showLabels: e.target.checked }, false); setSnap(loadPersist());
              },
            }), " labels"),
          h("label", { "data-tip": "Sampled grand (CDN) vs built-in synth — synth always works offline" },
            h("input", {
              type: "checkbox", checked: snap.samples,
              onChange: (e) => {
                const p = loadPersist(); savePersist({ ...p, samples: e.target.checked }, false); setSnap(loadPersist());
                setSfState(e.target.checked ? "loading" : "idle");
                if (e.target.checked) {
                  engine.failed = false;
                  engine.preload(songRef.current.notes.map((n) => n.midi), true);
                }
              },
            }), " " + sfLabel),
          h("span", { "data-tip": "Output volume" }, "vol ",
            h("input", {
              type: "range", min: 0, max: 100, value: Math.round(snap.volume * 100),
              style: { width: 56, accentColor: "var(--accent)", verticalAlign: "middle" },
              "aria-label": "Volume",
              onChange: (e) => {
                const v = clampN(Number(e.target.value) / 100, 0, 1);
                engine.setVolume(v);
                engineRef.current.volume = v;
                const p = loadPersist(); savePersist({ ...p, volume: v }, false); setSnap(loadPersist());
              },
            })),
        ),
      ),
      h("div", { className: "oc-handle se", onMouseDown: onResizeStart }),
    );
  }

  return {
    Titlebar: TitlebarBtn,
    Overlay,
    hotkeys: [
      { id: "toggle", default: "Alt+P", label: "toggle piano", description: "Show/hide floating piano visualizer" },
      { id: "playpause", default: null, label: "piano play/pause", description: "Start or pause the loaded song" },
    ],
    onHotkey(id) {
      if (id === "toggle") toggleOpen();
      else if (id === "playpause") {
        const s = loadPersist();
        if (!s.open) { s.open = true; savePersist(s); return; }
        window.dispatchEvent(new CustomEvent("oc:piano-viz:playpause"));
      }
    },
    slash: [
      {
        name: "piano", description: "toggle the piano visualizer",
        handle: () => { toggleOpen(); return loadPersist().open ? "piano opened" : "piano closed"; },
      },
    ],
    info: {
      keys: [
        ["Alt+P / Piano (Titlebar)", "Toggle floating piano visualizer — rebindable in Hotkeys"],
        ["Space (piano open)", "Play / pause the loaded song"],
        ["Z S X D C V G B H N J M ,", "Play octave starting at C (white + black keys)"],
        ["Q 2 W 3 E R 5 T 6 Y 7 U I", "Play one octave higher"],
        ["← / →", "Shift base octave"],
        ["Hold M1 + drag across keys", "Glissando — notes strike, glide and trail as you slide"],
        ["MIDI file picker / drop .mid", "Load any MIDI file by picker or drag-drop onto the stage"],
        ["MIDI plug button", "Link a connected MIDI keyboard — notes + sustain pedal play live"],
        ["Esc", "Close piano (voices stop)"],
      ],
    },
  };
}
