// runnable self-check: node --experimental-strip-types src/lib/debugSession.test.ts
import { DEBUG_PREFIX, parseDebugCount, makeFakeMessages, fakeSession } from "./debugSession.ts";

let n = 0;
function eq(name: string, got: unknown, want: unknown) {
  n++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}: got ${g}, want ${w}`);
}

// --- parseDebugCount ---
eq("empty → 3000", parseDebugCount(""), 3000);
eq("blank → 3000", parseDebugCount("   "), 3000);
eq("garbage → 3000", parseDebugCount("abc"), 3000);
eq("parsed", parseDebugCount("42"), 42);
eq("min clamp 10", parseDebugCount("1"), 10);
eq("max clamp 20000", parseDebugCount("999999"), 20000);
eq("padded number", parseDebugCount(" 77 "), 77);
eq("negative → default", parseDebugCount("-5"), 3000);

// --- makeFakeMessages ---
const msgs = makeFakeMessages(DEBUG_PREFIX + "1", 10);
eq("count", msgs.length, 10);
eq("sid stamped", (msgs[0] as any).info.sessionID, DEBUG_PREFIX + "1");
eq("alternating roles", (msgs[0] as any).info.role !== (msgs[1] as any).info.role, true);
eq("text parts present", (msgs[0].parts ?? []).some((p: any) => p.type === "text"), true);
n++;
if (!msgs.some((m: any) => (m.parts ?? []).some((p: any) => typeof p.text === "string" && p.text.includes("```")))) {
  throw new Error("FAIL no fenced code in fake messages");
}

// --- fakeSession ---
const s = fakeSession(DEBUG_PREFIX + "9", 5);
eq("id prefix", String(s.id).startsWith(DEBUG_PREFIX), true);
eq("title carries count", String((s as any).title).includes("5"), true);

console.log(`debugSession: ${n} checks passed`);
