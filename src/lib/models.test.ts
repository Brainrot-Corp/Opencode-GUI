// runnable self-check: node --experimental-strip-types src/hooks/useProviders.test.ts
import { splitModel } from "../lib/models.ts";

let n = 0;
function eq(a: unknown, e: unknown, label: string) {
  n++;
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`FAIL ${label}: got ${a}, want ${e}`);
}

eq(splitModel("openrouter/deepseek/deepseek-chat-v3"), ["openrouter", "deepseek/deepseek-chat-v3"], "vendor/model id keeps slashes");
eq(splitModel("deepseek/deepseek-v4-pro"), ["deepseek", "deepseek-v4-pro"], "plain id");
eq(splitModel("opencode/big-pickle"), ["opencode", "big-pickle"], "no slash in model");
eq(splitModel("weird"), ["weird", ""], "bare provider");

console.log(`splitModel: ${n} checks passed`);
