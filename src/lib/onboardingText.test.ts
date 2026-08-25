// runnable self-check: node src/lib/onboardingText.test.ts
import { resolveObCopy } from "./onboardingText.ts";

let n = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  n++;
  if (actual !== expected) throw new Error(`FAIL ${label}: got ${actual}, want ${expected}`);
}

eq(resolveObCopy("de-DE").title, "Willkommen", "german picked");
eq(resolveObCopy("zh-TW").finish, "完成", "zh* maps to chinese");
eq(resolveObCopy("fr").back, "Retour", "french picked");
eq(resolveObCopy("xx-YY").title, "Welcome", "unknown → english");
eq(resolveObCopy(undefined).hello, en_hello(), "undefined → english");

function en_hello() {
  // re-resolve via a tag no language owns
  return resolveObCopy("zz").hello;
}

console.log(`onboardingText: ${n} checks passed`);
