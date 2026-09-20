# 13 — useOpencode.ts typing (@ts-nocheck removal) + poll reductions

## Scope

- `src/hooks/useOpencode.ts` — remove line-1 `// @ts-nocheck`, type-check the file.
- `src/lib/opencodeEvents.ts` — drop casts the SDK types already cover.
- 3s children poll + 2s workspace tick reductions (AUDIT-CHANGES deferred item
  "2 s workspace tick + 3 s children poll reductions").
- Files NOT touched (parallel-agent owned): src/api.ts, useProviders.ts,
  slashCommands.ts, components/*.

## Changes

### TASK 1 — typing

**Error count: 3 → 0** (`npx tsc --noEmit` after deleting the directive; the
whole-project baseline was clean before and stayed clean).

The audit feared "pervasive `(client as any).session` casts" would explode into
150+ errors. Reality: `src/api.ts:wrap()` returns `any`, so the erasure happened
at the source and every cast was silently redundant — removing the directive
surfaced only 3 errors:

1. `CmdEntry` imported but unused (line 58's `export type { CmdEntry }` re-export
   already covers the composer/dialog imports).
2. Unused `client` destructured from `opencode()` in the boot effect.
3. Implicit-any `e` in a `.catch((e) => …)` on an `any`-typed call (no
   contextual signature → TS7006).

Fix — retype the client once instead of per-call-site (no api.ts edit needed;
the Proxy preserves the SDK shape at runtime, same pattern as useProviders.ts's
`OcClient`):

```ts
type OcClient = OpencodeClient;
const clientFor = async (dir?: string): Promise<{ base: string; client: OcClient }> =>
  dir ? await opencodeFor(dir) : await opencode();
```

That let **~16 cast sites be deleted outright**, including the stale-SDK ones
the task called out:

- `(s as any).parentID` → `s.parentID` — current SDK `Session` type HAS
  `parentID?: string` (cast was stale, not the type).
- `(client.session as any).{list,get,messages,children,create,delete,update,
  abort,revert,unrevert,fork,promptAsync}` → direct typed calls; `RequestResult.data`
  unwraps (`r.data ?? []`) replace the defensive `(r)?.data ?? (r)?.value ?? r`
  chains.
- `(client as any).postSessionIdPermissionsPermissionId` → typed on
  `OpencodeClient` itself.
- `refreshActiveChildren`'s `Array.isArray(raw) ? raw : …` shape-guessing gone —
  `session.children()` returns `Session[]` per its declared type.
- `(info as any).providerID/.modelID` in opencodeEvents.ts → typed
  (`AssistantMessage` carries both; the `role === "assistant"` guard narrows).

**Casts that remain (24 in useOpencode.ts, 1 in opencodeEvents.ts) and why:**

| Site | Why kept |
|---|---|
| `refreshCommands` / `refreshAgents` (`as any[]`, `a: any`) | SDK command/agent entry types lack `source`/`hints`/`mode` that the server actually returns (`types.ts` documents Cmd as stale). Tagged `// ponytail: SDK … stale`. |
| `sessionUsage` / `childTaskCosts` (`ch as any`) | SDK `Session` type has no `cost`/`tokens`; the server adds them on children responses. Tagged `ponytail:`. |
| `promptNow` body | `SessionPromptAsyncData["body"]` typed, but widened with `& { variant?: string }` — SDK prompt body predates `variant` (server supports it). Tagged `ponytail:`. |
| `(prov as any).loadProvidersAll/.sessionModels/.sessionVariants` ×4 | useProviders members not exposed in its return type; useProviders.ts is not in this task's file list. |
| boot `/question` + `/permission` fetches (`pr: any`, `arr: any[]`, `list: any`) | raw server JSON; these endpoints are entirely absent from SDK types (the reason `serverFetch` exists). |
| `_dir` augmentation (`(s as any)._dir`, `{…s, _dir} as any`) | local `Session & {_dir: string}` field; a shared alias would be next. |
| store-parts traversal in `revertTo`/`forkFrom`/`undoTarget` (`m: any`, `p: any`, `_isCommand`) | defensive walks of store snapshots with local `_is*` fields; typing is low-value churn inside try/catch. |
| `askTitle(p: any, …)` (opencodeEvents) | `OpenCodeEvent.properties` is `any` by design in `types.ts` — the SSE stream is parsed liberally across server versions (v1/v2 events). |

No `@ts-nocheck` was re-added; the file compiles clean.

### TASK 2 — poll reductions

**2.1 — 3s children poll: DROPPED.** The `window.setInterval(…, 3000)` effect
(then lines 1598–1611) is gone. Replacement triggers, all pre-existing:

- `opencodeEvents.ts:97-100` — `message.part.updated` with `tool === "task"` +
  `state.status === "completed"` → `refreshChildrenRef` after 400 ms (the final
  child cost lands at exactly this moment).
- `opencodeEvents.ts:263-265 / 284-290` — `session.created`/`session.updated`
  with `parentID === activeRef.current` → immediate refresh (child row appears,
  child title changes).
- Busy→idle settle edge (`prevBusyRef` effect, useOpencode.ts ~1615) — one
  refresh when the turn settles so the last task's cost is never stale.

Verified by tracing the flow: a subagent's workspace-wide SSE stream delivers
`session.created` (row appears) → streaming parts (parent store untouched, cost
cached) → `task` part `completed` (chip + total refresh at 400 ms) → parent
`session.idle` → tracker settle → busyIds edge → one final refresh. The only
behavior change: during a LONG-running subagent the live cost updates at those
moments instead of climbing every 3 s (accepted by the audit).

**2.2 — 2s workspace tick: FULL event-driven conversion (not the fallback).**
The interval is gone; the `wsTick` body became a `reconcile()` function that
runs on demand:

- **Triggers:** SSE `onerror` (1.2 s debounce, per-dir timestamp recorded in
  `lastErrAt`), `oc:workspaces-changed` (immediate — covers workspace
  add/remove, which the old tick re-checked every 2 s; the event is
  same-window by design, each OS window owns its own SSE loop), and stream
  dial failure (`scheduleReconcile(200)`; `baseFor`'s 15 s negative cache paces
  SSH re-dial retries — slower than the old 2 s hammering, and
  `remoteDownToasted` still throttles the toast to once per outage).
- **Base-change detection moved to the error path:** when any dir errored since
  the last probe, reconcile re-invokes `resetOpencodeCache()` + `opencode()` so
  `server_url` is re-queried; a changed base closes all streams and resubscribes.
  (Note: the old tick's per-cycle `await opencode()` returned the module-cached
  boot promise every time, so its base-change check was mostly a no-op — the
  new path is strictly more likely to find a respawned sidecar.)
- **SSH dead-tunnel detection kept** but narrowed: `remoteStatus()` is probed
  only for remote dirs whose stream is not `readyState === 1` (open) at
  reconcile time — not every remote every 2 s.
- Healthy streams are never touched; EventSource auto-reconnect handles
  transient drops. `runReconcile` single-flights with a re-run flag;
  `onopen` clears the dir's error timestamp so a healthy stream never triggers
  further probes.

## Regression watchpoints

- **SSE reconnect after server restart** — smoke: prompt once, kill/restart the
  sidecar (or let it crash), type again: within a few seconds the stream should
  recover (ES retry if same port; if the port changed, one `onerror` →
  reconcile → base probe → resubscribe). Watch for the "live" dot coming back.
- **SSE reconnect after SSH tunnel death** — smoke: open an SSH workspace,
  kill the tunnel, then reconnect; the first `onerror` → reconcile →
  `remoteStatus !alive` → evict → re-dial. Expect one "SSH workspace
  unreachable" toast (once per outage, not per retry) and events resuming.
- **Children/task badges after a subagent completes** — smoke: run a prompt
  that spawns a subagent; the child row must appear immediately
  (`session.created`), its cost chip/total update within ~0.5 s of the task
  completing (`part.updated` trigger), and settle exactly when the turn ends.
  A subagent running >30 s with no further task parts now shows a static cost
  until completion — expected.
- **Busy-settle sounds + queue flush** — smoke: send two prompts to the same
  session; the first must stream, the second queue; on settle the "reply"
  sound plays once and the queued prompt fires (`tracker.onSettle` path
  untouched).
- **Multi-window workspaces event** — smoke: add/remove a workspace in one
  window; that window's sidebar + SSE converge via `oc:workspaces-changed` →
  reconcile; a second window must NOT adopt the workspace (still same-window
  only).

## Verification

- `npx tsc --noEmit` — exit 0 (clean; run after TASK 1 and again after TASK 2).
- `npm run test` — 30/30 files pass (baseline 30/30).
- No live-model test (per AGENTS.md; timing changes reasoned through event
  flow instead — see 2.1 trace above).

## Deferred

- The 24 remaining casts (inventory above) — next step would be a
  `SessionWithCost`/`DirSession` shared alias in a types file and typing
  useProviders' return (other agents own that file).
- Event-side typing: `OpenCodeEvent.properties: any` stays liberal by design;
  tightening would mean adopting the SDK's discriminated `EventX` union plus a
  fallback for v1/v2 event names.
- During a half-open TCP tunnel (socket alive, remote server hung), no
  `onerror` fires until the OS kills the connection — old 2 s `remoteStatus`
  polling detected that in ≤2 s, new path waits for the eventual error. Rare
  and self-healing once TCP notices; EventSource keeps its auto-retry either way.
