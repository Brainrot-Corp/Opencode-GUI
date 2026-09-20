# 12 — `wait_for_server` → `wait_for_port` convergence (deferred in 08-rust-reorg, now done)

## Scope

Files touched: `src-tauri/src/server.rs` (`wait_for_port` gains a `http_ok: bool` strictness parameter; new pure `reply_ok` predicate + `#[cfg(test)]` test), `src-tauri/src/voice/stt.rs` (local 18-line `wait_for_server` deleted; call site now `crate::server::wait_for_port(..., false)`), `src-tauri/src/remote.rs` (existing tunnel call site — one-line arg addition to `true`, mandated by the signature change, behavior unchanged).

## Changes

1. **`server.rs:reply_ok(resp, http_ok)`** — the EH-07 reply check extracted as a pure predicate: `http_ok=true` requires `200` + `{` in the reply (today's exact semantics); `false` accepts any non-empty reply (stt's "any bytes > 0" semantics, expressed on the lossy string — upstream already guarantees `n > 0`).
2. **`server.rs:wait_for_port(port, timeout, http_ok)`** — one poll loop for both strictness levels. Request line follows the level: strict still probes `GET /health` (opencode serve), loose probes `GET /` (identical to the deleted stt helper's request). Loop internals kept from server.rs (400 ms socket timeouts, 100 ms poll sleep, 8192-byte buffer); the 80 ms post-hit sleep before returning `true` is preserved for both paths.
3. **Call sites**: `spawn_server` (8 s boot wait, 3 s grace) and `remote.rs:wait_for_tunnel` pass `true` — byte-for-byte previous behavior. `stt.rs:ensure_whisper_server` passes `false` with the same 10 s timeout it always used.
4. **Test**: `server::tests::reply_strictness_matches_caller_semantics` — strict accepts 200+JSON, rejects 404 and brace-less 200s and empty replies; loose accepts a 404 page and rejects empty. The socket loop itself is inherently socket-bound (needs a live listener), so only the predicate is unit-tested — not forced.

## Regression watchpoints (one-line smoke test each)

- **opencode serve boot retry path**: start the GUI with the sidecar available → `spawn_server` still requires a real `/health` 200+JSON before declaring listening (a port stolen by an unrelated service must still be rejected and retried on the next free port).
- **SSH tunnel readiness check**: open an `ssh://` workspace → `wait_for_tunnel` still completes in ~500 ms slices once the forwarded port answers HTTP (a plain TCP-accepting-but-non-HTTP process on the tunnel port must not count as ready).
- **whisper-server GPU STT with a 404-serving build**: install a cublas whisper-server build that answers `GET /` with a plain 404 → PCM voice input must still use the persistent server (engine `gpu`/`cpu` server path), not degrade to CLI; server first spawn should be considered ready when the 404 page arrives.

## Verification

- `cargo check` — clean (dev profile).
- `cargo check --release` — clean (release-only cfg branches compile).
- `cargo test --lib` — 19/19 (18 baseline + 1 new).

## Deferred

- **Socket-loop unit test** — skipped deliberately: `wait_for_port` is inherently socket-bound (would need a live loopback listener thread); the testable seam (`reply_ok`) is extracted and covered instead.
- **Poll cadence unification** — the merged loop keeps server.rs's cadence (400 ms socket timeouts / 100 ms poll sleep); stt's old 300 ms / 80 ms cadence is not carried over. Readiness deadline (10 s) unchanged and the cadence delta is immaterial for a readiness poll; not worth a knob.
