// runnable self-check: node default_plugins/piano-visualizer/test.mjs
// Exercises the pure SMF parser + note helpers (no DOM / no WebAudio).
import { parseMidi, readVLQ, midiToName, isBlackKey, handColor, keyAt, dragStep, demoSongs } from "./main.js";

let n = 0;
function eq(actual, expected, label) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}
function ok(cond, label) {
  n++;
  if (!cond) throw new Error(`FAIL ${label}`);
}
function throws(fn, label) {
  n++;
  try { fn(); } catch { return; }
  throw new Error(`FAIL ${label}: did not throw`);
}

// ---- VLQ ----
eq(readVLQ(new Uint8Array([0x00]), 0), { value: 0, next: 1 }, "vlq zero");
eq(readVLQ(new Uint8Array([0x81, 0x00]), 0), { value: 128, next: 2 }, "vlq 128");
eq(readVLQ(new Uint8Array([0xff, 0x7f]), 0), { value: 16383, next: 2 }, "vlq max2");

// ---- names ----
eq(midiToName(60), "C4", "middle C");
eq(midiToName(69), "A4", "A440");
eq(midiToName(21), "A0", "lowest piano key");
eq(midiToName(108), "C8", "highest piano key");
eq(midiToName(61), "Db4", "flat naming for soundfont URLs");
eq(isBlackKey(60), false, "C is white");
eq(isBlackKey(61), true, "Db is black");
eq(isBlackKey(62), false, "D is white");

// ---- hand palette (gold left / blue right of middle C) ----
eq(handColor(48).glow, "#ff8f2e", "bass splits warm");
eq(handColor(59).glow, "#ff8f2e", "B3 still left hand");
eq(handColor(60).glow, "#3f7dff", "middle C starts right hand");
eq(handColor(72).mid, "#7cc4ff", "treble splits cool");
for (const m of [21, 40, 60, 80, 108]) {
  const c = handColor(m);
  ok(/^#[0-9a-f]{6}$/.test(c.core) && /^#[0-9a-f]{6}$/.test(c.mid) && /^#[0-9a-f]{6}$/.test(c.glow), `hand colors valid hex (${m})`);
}

// ---- keybed hit-testing (black asset only covers the top slice) ----
const testGeom = {
  whites: [{ midi: 60, x: 0, w: 20 }, { midi: 62, x: 20, w: 20 }],
  blacks: [{ midi: 61, x: 14, w: 12 }],
};
const KT = 100, BB = KT + 62; // keyTop 100, black asset ends at 162
eq(keyAt(testGeom, 18, 110, KT, BB), 61, "black key hit inside asset");
eq(keyAt(testGeom, 14, BB, KT, BB), 61, "black asset edges inclusive");
eq(keyAt(testGeom, 18, 170, KT, BB), 60, "below black asset falls through to white");
eq(keyAt(testGeom, 5, 170, KT, BB), 60, "white key lower area");
eq(keyAt(testGeom, 5, 110, KT, BB), 60, "white key upper area beside black");
eq(keyAt(testGeom, 18, 90, KT, BB), null, "above keybed is null");
eq(keyAt(testGeom, 200, 170, KT, BB), null, "past last key is null");

// ---- glissando drag-voice step ----
eq(dragStep(60, 60), { off: null, on: null }, "hovering same key is silent");
eq(dragStep(null, 62), { off: null, on: 62 }, "press strikes");
eq(dragStep(62, null), { off: 62, on: null }, "leaving keys releases");
eq(dragStep(60, 64), { off: 60, on: 64 }, "slide retunes");
eq(dragStep(null, null), { off: null, on: null }, "idle is silent");

// ---- synthetic SMF (format 0, division 96, one tempo, two notes) ----
function buildMidi() {
  const track = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo 500000
    0x00, 0x90, 0x3c, 0x40, // C4 on, vel 64
    0x60, 0x80, 0x3c, 0x00, // C4 off after 96 ticks
    0x00, 0x90, 0x43, 0x50, // G4 on
    0x30, 0x43, 0x00, // running-status G4 off (vel 0) after 48 ticks
    0x00, 0xff, 0x2f, 0x00, // end of track
  ];
  const head = [0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x60];
  const trk = [0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track];
  return new Uint8Array([...head, ...trk]);
}

const parsed = parseMidi(buildMidi());
eq(parsed.notes.length, 2, "two notes parsed");
eq(parsed.notes[0].midi, 60, "first note is C4");
eq(parsed.notes[0].t0, 0, "first note starts at 0");
eq(parsed.notes[0].t1, 0.5, "quarter at 120bpm = 0.5s");
eq(parsed.notes[0].vel, 64 / 127, "velocity scaled");
eq(parsed.notes[1].midi, 67, "running-status note is G4");
eq(parsed.notes[1].t0, 0.5, "second note starts at beat 2");
eq(parsed.notes[1].t1, 0.75, "eighth = 0.25s");
eq(parsed.duration, 0.75, "duration = last note end");

// ArrayBuffer input works too
eq(parseMidi(buildMidi().buffer).notes.length, 2, "ArrayBuffer input");

// ---- rejects ----
throws(() => parseMidi(new Uint8Array([1, 2, 3])), "too short");
throws(() => parseMidi(new Uint8Array(20)), "bad header");
throws(() => {
  const b = buildMidi();
  b[12] = 0x80; // SMPTE division flag
  parseMidi(b);
}, "SMPTE rejected");
eq(parseMidi(buildMidi()).tracks.length >= 0, true, "tracks field present");

// ---- demos ----
const demos = demoSongs();
eq(demos.length, 3, "three bundled demos");
for (const d of demos) {
  ok(d.notes.length > 5, `${d.id} has notes`);
  ok(d.duration > 2, `${d.id} has duration`);
  let prev = -1;
  for (const note of d.notes) {
    ok(note.midi >= 21 && note.midi <= 108, `${d.id} midi range (${note.midi})`);
    ok(note.t1 > note.t0, `${d.id} positive length`);
    ok(note.t0 >= prev, `${d.id} sorted by t0`);
    prev = note.t0;
  }
  const lastEnd = Math.max(...d.notes.map((x) => x.t1));
  ok(d.duration >= lastEnd - 1e-9, `${d.id} duration covers notes (trailing rests allowed)`);
  ok(d.duration - lastEnd < 2, `${d.id} no excessive trailing silence`);
}

console.log(`piano-visualizer: ${n} checks passed`);
