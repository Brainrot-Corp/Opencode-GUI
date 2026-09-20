// notifyRelay pure helpers — dedupe/TTL, busy-diff, text builders, backoff
import {
  assistantReplyText,
  backoffMs,
  busyLeaving,
  createDedupe,
  errorNotifyText,
  permNotifyText,
  questionNotifyText,
  readNotifySettings,
  validRelayUrl,
} from "./notifyRelay.ts";

const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
};

// validRelayUrl
eq("ws accepted", validRelayUrl("ws://host:8918/ws"), true);
eq("wss accepted", validRelayUrl("wss://relay.example.com/ws"), true);
eq("http rejected", validRelayUrl("http://host:8918/ws"), false);
eq("empty rejected", validRelayUrl(""), false);
eq("garbage rejected", validRelayUrl(42), false);

// dedupe: first seen=false (new), second=true (dup), ttl expiry clears
{
  const d = createDedupe(10);
  eq("first seen is new", d.seen("k"), false);
  eq("second seen is dup", d.seen("k"), true);
  eq("different key is new", d.seen("k2"), false);
  const slow = createDedupe(1);
  slow.seen("x");
  await new Promise((r) => setTimeout(r, 5));
  eq("ttl expiry re-allows", slow.seen("x"), false);
}

// busyLeaving: sessions that left prev
{
  const prev = new Set(["a", "b", "c"]);
  const next = new Set(["b", "c", "d"]);
  eq("leaving diff", busyLeaving(prev, next), ["a"]);
  eq("empty diff", busyLeaving(new Set(), new Set(["a"])), []);
}

// text builders
eq("perm text", permNotifyText({ id: "p1", sessionID: "s1", type: "bash", title: "git push" }), {
  kind: "permission",
  title: "Permission needed: bash",
  body: "git push",
  sessionID: "s1",
});
eq("perm empty title fallback", permNotifyText({ id: "p1", sessionID: "s1", type: "edit", title: "" }).body, "permission");
eq("question text", questionNotifyText({ id: "q1", sessionID: "s1", questions: [{ question: "Proceed?", header: "Confirm" }] }), {
  kind: "question",
  title: "Question: Confirm",
  body: "Proceed?",
  sessionID: "s1",
});
eq("question with options", questionNotifyText({ id: "q1", sessionID: "s1", questions: [{ question: "Proceed?", header: "Confirm", options: ["Yes", "No"] }] }).body, "Proceed? — Options: Yes · No");
eq("question empty header", questionNotifyText({ id: "q1", sessionID: "s1", questions: [{ question: "Hi?" }] }).title, "Question: agent");
eq("error text clamps", errorNotifyText("s1", "x".repeat(500)).body.length, 300);

// assistantReplyText: last assistant message's text, flattened + clamped
eq("reply none", assistantReplyText([]), "");
eq("reply skips user", assistantReplyText([
  { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
]), "");
eq("reply takes last assistant", assistantReplyText([
  { info: { role: "assistant" }, parts: [{ type: "text", text: "first" }] },
  { info: { role: "user" }, parts: [{ type: "text", text: "go on" }] },
  { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Done.\nNext line" }] },
]), "Done. Next line");
eq("reply clamps", assistantReplyText([
  { info: { role: "assistant" }, parts: [{ type: "text", text: "y".repeat(300) }] },
]).length, 240);

// backoff: 1,2,4,8,16,30-cap, caps at 30s
eq("backoff 0", backoffMs(0), 1000);
eq("backoff 3", backoffMs(3), 8000);
eq("backoff 5", backoffMs(5), 32000 > 30000 ? 30000 : backoffMs(5));
eq("backoff caps", backoffMs(50), 30000);
eq("backoff negative safe", backoffMs(-2), 1000);

// readNotifySettings: node has no localStorage — must return null, not throw
eq("no localStorage -> null", readNotifySettings(), null);

// with a fake blob: full settings object parsed, bad url rejected
{
  const blob = {
    notify: {
      relayUrl: "ws://192.168.1.10:8918/ws",
      token: "ocd-x",
      onIdle: true,
      onPermission: false,
      onQuestion: true,
      onError: undefined,
    },
  };
  (globalThis as any).localStorage = { getItem: () => JSON.stringify(blob) };
  const got = readNotifySettings();
  eq("blob parsed", got && got.relayUrl, "ws://192.168.1.10:8918/ws");
  eq("blob flag explicit", got && got.onPermission, false);
  eq("blob flag default", got && got.onError, true);
  eq("blob flag default 2", got && got.onIdle, true);
  eq("runLocal default false", got && got.runLocal, false);
  blob.notify.relayUrl = "https://bad";
  eq("bad url -> null", readNotifySettings(), null);
  delete (globalThis as any).localStorage;
  eq("cleared again", readNotifySettings(), null);

  // runLocal without a manual URL is valid (GUI-managed relay)
  const local = { notify: { runLocal: true, relayUrl: "", token: "" } };
  (globalThis as any).localStorage = { getItem: () => JSON.stringify(local) };
  const l = readNotifySettings();
  eq("runLocal accepted w/o url", l && l.runLocal, true);
  l && (l as any).runLocal && (delete (globalThis as any).localStorage);
  eq("runLocal relayUrl empty", l && l.relayUrl, "");
}

console.log("notifyRelay.test done");
