// Generates all application icons procedurally — brand design:
// dark rounded-glass square, thin cyan border, glowing cyan dot.
// usage: node scripts/gen-icon.mjs   (writes into src-tauri/icons/)
import { deflateSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("src-tauri/icons");

/* ---------- tiny PNG encoder (RGBA, filter 0) ---------- */
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function pngEncode(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- renderer ---------- */
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function renderMaster(S = 1024) {
  const px = Buffer.alloc(S * S * 4);
  const rr = S * 0.21; // corner radius
  const bw = S * 0.008; // border half-width
  const cx = S / 2;
  const cy = S / 2;
  const rCore = S * 0.135;
  const rHalo = S * 0.37;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const px_ = x + 0.5 - cx;
      const py_ = y + 0.5 - cy;
      const qx = Math.abs(px_) - (cx - rr);
      const qy = Math.abs(py_) - (cy - rr);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const dist = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - rr;

      if (dist > 0.5) continue; // fully outside

      // background vertical gradient (dark glass)
      const t = clamp01(y / S);
      let R = Math.round(16 + (9 - 16) * t);
      let G = Math.round(22 + (13 - 22) * t);
      let B = Math.round(29 + (18 - 29) * t);
      let A = 255 * clamp01(0.5 - dist);

      // thin cyan border on the rounded edge
      if (Math.abs(dist) <= bw) {
        const m = clamp01(0.5 - Math.abs(dist) / bw) * 0.55;
        R = Math.round(R * (1 - m) + 127 * m);
        G = Math.round(G * (1 - m) + 212 * m);
        B = Math.round(B * (1 - m) + 212 * m);
      }

      // glowing dot
      const d = Math.hypot(px_, py_);
      if (d < rHalo) {
        let f;
        let cr;
        let cg;
        let cb;
        if (d <= rCore) {
          f = 1;
          const inner = clamp01(1 - d / rCore);
          cr = 168 + (127 - 168) * (1 - inner);
          cg = 230;
          cb = 228;
        } else {
          f = Math.pow(clamp01(1 - (d - rCore) / (rHalo - rCore)), 2) * 0.75;
          cr = 127;
          cg = 212;
          cb = 212;
        }
        R = Math.round(R * (1 - f) + cr * f);
        G = Math.round(G * (1 - f) + cg * f);
        B = Math.round(B * (1 - f) + cb * f);
        A = Math.max(A, 255 * f);
      }

      px[i] = R;
      px[i + 1] = G;
      px[i + 2] = B;
      px[i + 3] = A;
    }
  }
  return { size: S, px };
}

function resize(master, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = master.size / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(Math.ceil((y + 1) * scale), master.size);
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(Math.ceil((x + 1) * scale), master.size);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * master.size + sx) * 4;
          r += master.px[i];
          g += master.px[i + 1];
          b += master.px[i + 2];
          a += master.px[i + 3];
          n++;
        }
      }
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return { size, px: out };
}

/* ---------- outputs ---------- */
const master = renderMaster(1024);
fs.mkdirSync(OUT, { recursive: true });

function writeFile(name, size) {
  const img = size === 1024 ? master : resize(master, size);
  fs.writeFileSync(path.join(OUT, name), pngEncode(img.size, img.size, img.px));
}

writeFile("icon.png", 512);
writeFile("128x128.png", 128);
writeFile("128x128@2x.png", 256);
writeFile("32x32.png", 32);
for (const s of [30, 44, 70, 71, 89, 107, 142, 150, 284]) {
  const name = s === 30 ? "StoreLogo.png" : s === 150 ? "Square150x150Logo.png" : `Square${s}x${s}Logo.png`;
  writeFile(name, s);
}

// Windows .ico with embedded PNG entries (Vista+)
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const imgs = icoSizes.map((s) => ({ s, png: pngEncode(s, s, resize(master, s).px) }));
const dirSize = 6 + imgs.length * 16;
const dir = Buffer.alloc(dirSize);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(imgs.length, 4);
let offset = dirSize;
imgs.forEach(({ s, png }, i) => {
  const e = 6 + i * 16;
  dir.writeUInt8(s === 256 ? 0 : s, e);
  dir.writeUInt8(s === 256 ? 0 : s, e + 1);
  dir.writeUInt8(0, e + 2); // colors
  dir.writeUInt8(0, e + 3); // reserved
  dir.writeUInt16LE(1, e + 4); // planes
  dir.writeUInt16LE(32, e + 6); // bpp
  dir.writeUInt32LE(png.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
fs.writeFileSync(path.join(OUT, "icon.ico"), Buffer.concat([dir, ...imgs.map((i) => i.png)]));

console.log(
  "icons written:",
  fs.readdirSync(OUT).filter((f) => !f.endsWith(".icns")).join(", "),
);
