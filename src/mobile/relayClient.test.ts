// phone relay client — hello/replay, notify fan-in, lastId tracking,
// stop() safety. Framework-free (scripts/run-tests.mjs).
import { connectRelay } from "./relayClient.ts";

const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
};

class FakeWs {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  send(raw: string) { this.sent.push(raw); }
  close() { this.closed = true; this.readyState = 3; }
}
type WsView = FakeWs & {
  onopen: () => void;
  onmessage: (e: { data: string }) => void;
  onclose: () => void;
};

// ——— connect → hello with lastId → notify delivery + lastId tracking ———
{
  const made: FakeWs[] = [];
  const WsCtor = class extends FakeWs {
    constructor() {
      super();
      made.push(this);
    }
  } as unknown as new (url: string) => FakeWs;
  const store = { last: 41, get: () => 41, set: (id: number) => { store.last = id; } };
  const got: any[] = [];
  const conn = connectRelay(WsCtor, "ws://r/ws", "ocp-tok", {
    onNotify: (m) => got.push(m),
  }, store);
  eq("one socket made", made.length, 1);
  const w = made[0] as unknown as WsView;
  w.onopen();
  eq("hello payload", JSON.parse(w.sent[0]), { type: "hello", role: "phone", token: "ocp-tok", lastId: 41 });
  w.onmessage({ data: JSON.stringify({ type: "notify", id: 42, kind: "idle", title: "t" }) });
  eq("notify delivered", got.length, 1);
  eq("lastId advanced", store.last, 42);
  w.onmessage({ data: JSON.stringify({ type: "error", error: "x" }) });
  w.onmessage({ data: "not json" });
  eq("junk ignored", got.length, 1);
  w.onmessage({ data: JSON.stringify({ type: "notify", id: 40, kind: "old" }) });
  eq("old id not stored", store.last, 42);
  eq("old delivered anyway (relay decides)", got.length, 2);
  conn.stop();
  eq("stop closes socket", w.closed, true);
}

// ——— stop() is idempotent + safe without a socket ———
{
  const WsCtor = class extends FakeWs {} as unknown as new (url: string) => FakeWs;
  const conn = connectRelay(WsCtor, "ws://r/ws", "t", { onNotify: () => {} }, { get: () => 0, set: () => {} });
  conn.stop();
  conn.stop();
  eq("stop idempotent", true, true);
}

console.log("relayClient.test done");
