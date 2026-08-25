// runnable self-check: node src/lib/piper.test.ts
import { parsePiperCatalog } from "./piper.ts";

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

console.log(`piper: ${n} checks passed`);
