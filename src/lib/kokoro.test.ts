// runnable self-check: node src/lib/kokoro.test.ts
import { parsePiperCatalog, parseWhisperCatalog, whisperLabel, wmGroup } from "./kokoro.ts";

let n = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

// extracts onnx ids sorted-unique; ignores configs and non-list bodies
eq(
  parsePiperCatalog(
    JSON.stringify([
      { type: "file", path: "en/en_US/amy/medium/en_US-amy-medium.onnx" },
      { type: "file", path: "en/en_US/amy/medium/en_US-amy-medium.onnx.json" },
      { type: "directory", path: "en/en_US" },
      { type: "file", path: "de/de_DE/thorsten/high/de_DE-thorsten-high.onnx" },
      { type: "file", path: "ar/ar_JO/kareem/x_low/ar_JO-kareem-x_low.onnx" },
    ]),
  ),
  ["ar_JO-kareem-x_low", "de_DE-thorsten-high", "en_US-amy-medium"],
  "onnx ids extracted, sorted",
);
eq(parsePiperCatalog("not json"), [], "garbage body → empty");
eq(parsePiperCatalog('{"error":"nope"}'), [], "non-array body → empty");
eq(parsePiperCatalog("[]"), [], "empty page → empty");

// whisper: keeps real ggml engine models, drops CoreML/CI fixtures, sorts by size
const tree = JSON.stringify([
  { type: "file", path: "ggml-large-v3-turbo-q5_0.bin", size: 574225408 },
  { type: "file", path: "ggml-tiny.en.bin", size: 77716719 },
  { type: "file", path: "ggml-base-encoder.ml.bin", size: 123 },
  { type: "file", path: "for-tests-ggml-tiny.bin", size: 456 },
  { type: "file", path: "mel_filters.npz", size: 789 },
  { type: "directory", path: "models" },
  { type: "file", path: "ggml-base.bin" }, // missing size tolerated
]);
eq(
  parseWhisperCatalog(tree),
  [
    { id: "ggml-base.bin", size: 0 },
    { id: "ggml-tiny.en.bin", size: 77716719 },
    { id: "ggml-large-v3-turbo-q5_0.bin", size: 574225408 },
  ],
  "whisper ids filtered + smallest-first",
);
eq(parseWhisperCatalog("not json"), [], "garbage body → empty");
eq(parseWhisperCatalog('{"error":"nope"}'), [], "non-array body → empty");

// labels derive from filename + real bytes
eq(
  whisperLabel("ggml-large-v3-turbo-q5_0.bin", 574225408),
  "large-v3-turbo-q5_0 · 548 MB · fast",
  "turbo label keeps quant variant",
);
eq(
  whisperLabel("ggml-tiny.en.bin", 77716719),
  "tiny.en · 74 MB · English-only",
  "english-only label",
);
eq(whisperLabel("ggml-base.bin", 0), "base", "unknown size omits MB");

// grouping key for the browser
eq(wmGroup("ggml-large-v3-turbo-q5_0.bin"), "large", "group large");
eq(wmGroup("ggml-tiny.en.bin"), "tiny", "group tiny");

console.log(`catalogs: ${n} checks passed`);
