// runnable self-check: node src/lib/recommended.test.ts
import { parseReco, recoModelOk } from "./recommended.ts";

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
  secondaryModel: "opencode/muse-spark-1.2",
  whisperBinUrl: "https://example.com/bin.zip",
  junkField: true,
});
eq(parseReco(GOOD)?.whisperModel, "ggml-small.bin", "valid model kept");
eq(parseReco(GOOD)?.ttsVoice, "de_DE-thorsten-high", "valid voice kept");
eq(parseReco(GOOD)?.note, "hello", "note kept");
eq(parseReco(GOOD)?.secondaryModel, "opencode/muse-spark-1.2", "secondary model kept");
eq(
  parseReco(
    JSON.stringify({
      whisperModel: "ggml-base.bin",
      ttsVoice: "en_US-amy-medium",
      secondaryModel: "no-slash",
    }),
  )?.secondaryModel,
  undefined,
  "bad secondary model dropped",
);
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

// suggested-model guard: must exist in the live provider list AND be free
const PROVS = [
  { id: "opencode", models: [{ id: "muse-spark-1.2-contributor-free" }, { id: "gpt-5" }] },
  { id: "openrouter", models: [{ id: "some/model" }] },
];
eq(recoModelOk("opencode/muse-spark-1.2-contributor-free", PROVS), true, "free + listed → ok");
eq(recoModelOk("opencode/muse-spark-1.2", PROVS), false, "no -free suffix → reject");
eq(recoModelOk("opencode/gpt-5", PROVS), false, "listed but paid → reject");
eq(recoModelOk("nope/muse-spark-1.2-contributor-free", PROVS), false, "unknown provider → reject");
eq(recoModelOk(undefined, PROVS), false, "missing model → reject");
eq(recoModelOk("opencode/muse-spark-1.2-contributor-free", []), false, "providers not loaded → reject");

console.log(`recommended+guard: ${6} checks passed`);
