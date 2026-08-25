// runnable self-check: node src/lib/recommended.test.ts
import { parseReco } from "./recommended.ts";

let n = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

const GOOD = JSON.stringify({
  version: 2,
  whisperModel: "ggml-small.bin",
  ttsVoice: "de_DE-thorsten-high",
  note: "hello",
  whisperBinUrl: "https://example.com/bin.zip",
  junkField: true,
});
eq(parseReco(GOOD)?.whisperModel, "ggml-small.bin", "valid model kept");
eq(parseReco(GOOD)?.ttsVoice, "de_DE-thorsten-high", "valid voice kept");
eq(parseReco(GOOD)?.note, "hello", "note kept");
eq(parseReco(GOOD)?.whisperBinUrl, "https://example.com/bin.zip", "url override kept");
eq("junkField" in parseReco(GOOD)!, false, "unknown fields dropped");
eq(parseReco('{"whisperModel":"nope"}'), null, "missing voice → null");
eq(
  parseReco(JSON.stringify({ whisperModel: "base.bin", ttsVoice: "en_US-amy-medium" })),
  null,
  "bad ggml id → null",
);
eq(
  parseReco(JSON.stringify({ whisperModel: "ggml-base.bin", ttsVoice: "amy" })),
  null,
  "bad piper id → null",
);
eq(parseReco("not json"), null, "garbage body → null");
eq(
  parseReco(
    JSON.stringify({
      whisperModel: "ggml-base.bin",
      ttsVoice: "en_US-amy-medium",
      whisperBinUrl: "http://insecure.com/x.zip",
    }),
  )?.whisperBinUrl,
  undefined,
  "non-https override dropped",
);

console.log(`recommended: ${n} checks passed`);
