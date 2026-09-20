# Mobile Companion App — Implementation Doc

Status: phase 1 shipped · Phases: 1 (notifications — shipped) → 2 (mobile app) → 3 (intervention) → 4 (full interaction)

## Goal

A Tauri v2 mobile app (iOS/Android) that (1) receives push notifications about
agent activity on the desktop, (2) lets the user approve/deny permissions and
answer agent questions from the phone, (3) eventually acts as a full remote
for the desktop client.

## Architecture

```
desktop GUI ──outbound W/S──► relay ◄──outbound W/S── phone app
(loopback opencode serve)     (self-hostable, stateless-ish)
```

- **Both sides connect outbound** to the relay → no NAT/port-forwarding, works
  identically on LAN, Tailscale, or a public VPS.
- The relay never talks to `opencode serve` directly (it is `127.0.0.1`-bound
  and unauthenticated by design). The **desktop is the bridge**: phase-2/3
  requests from the phone are forwarded over the desktop's existing connection
  to its local server.
- Relay is a single small binary (axum, ~500 lines), in-memory only: device
  registry + last-message-per-device for offline redelivery. No DB.

## Security

- Relay auth: bearer token per device (desktop token + phone token), generated
  at pairing. Pairing = paste relay URL + token into desktop settings, then
  approve the phone's join request in the desktop UI (shows device name).
- `opencode serve` has **no auth** — it must never be reachable except through
  the desktop bridge. TLS terminates at the relay (reverse proxy when
  self-hosting publicly; plain HTTP acceptable on trusted LAN).
- Phase-2 approvals are security-relevant: the phone UI mirrors the desktop's
  permission bar semantics exactly (`once` / `always` / `reject`), and respects
  the existing `oc.securityMode` (auto-respond means nothing reaches the phone).

## Phase 1 — Notifications (desktop → phone)

Trigger events, all already dispatched in `src/lib/opencodeEvents.ts` /
`src/hooks/useAsks.ts` — no new server plumbing:

| Event | Meaning | Notification |
|---|---|---|
| `message.updated` (assistant `time.completed`) / `session.idle` | agent finished turn | "Session X completed" |
| `permission.asked` (+v2) | needs approval | "X wants to run …" |
| `question.asked` (+v2) | needs an answer | "X asks: <header>" |
| `session.error` | run failed | "Session X errored" |

New: `src/hooks/useNotifyRelay.ts` — subscribes to the same window-level
signals the asks hooks already emit, maintains the outbound websocket to the
relay, dedupes (one notification per ask id / turn), honors a new
`oc.settings.notifications` block (`{ enabled, relayUrl, token, onIdle,
onPermission, onQuestion, onError, quietHours? }`), added to `AppSettings` +
`DEFAULTS` + loader validation per the `useSettings.ts` pattern.

Relay protocol (JSON over WS):
- Desktop → relay: `{type:"hello", device:"desktop", token}`; then
  `{type:"notify", id, kind, title, body, sessionID, ts}`.
- Phone → relay: `{type:"hello", device:"phone", token, lastId}` → relay
  replays undelivered messages.
- Relay → phone: `{type:"notify", …}`.

**iOS background-push note:** Web Push (VAPID + service worker, via APNs on
iOS 16.4+ / FCM on Android) solved background delivery during phase 1 — the
self-hosted relay posts encrypted pushes to browser subscriptions, and the
desktop (or shim page) never needs ntfy.sh. Phase-2 status: the shim page
(what the mobile app replaces) already proves delivery incl. backgrounded.

## Phase 2 — Mobile app (Tauri v2, notifications only)

The actual iOS/Android app replaces the browser shim: a Tauri v2 mobile
target reusing the repo's React stack, wired to the relay as a "phone"
device. Notifications-only scope — no server commands leave the phone.

- Connect to the relay (outbound WS + web push subscription, same protocol
  the shim already speaks: hello/notify/lastId replay).
- Notification list (kind, title, body, session) persisted across launches.
- Background delivery: Web Push in the webview service worker on Android;
  on iOS the Tauri shell (WKWebView) still gates background delivery — the
  native phase-2 upgrade path is a native push plugin fed by the same relay
  VAPID keys, only if the web push route proves insufficient.
- Reuse from `src/`: `lib/notifyRelay.ts` (pure protocol helpers), settings
  UI bits. New `src/mobile/` entry: two screens (Connect · Notifications).
- Packaging: `npx tauri android init/dev` (Android Studio + NDK),
  `npx tauri ios init/dev` (macOS + Xcode). Needs Apple dev account only
  for App Store/TestFlight — sideload/development builds ship unsigned.

## Phase 3 — Manual intervention (phone → desktop)

Request/response tunneled over the desktop's existing websocket (relay is a
postbox, desktop executes):

- Phone → relay: `{type:"req", id, method:"POST", path, body}` → relay →
  desktop → desktop calls its local server exactly like the webview does →
  `{type:"res", id, status, body}` back.
- Endpoints (identical to `useAsks.ts`):
  - Approve/deny permission: `POST /session/{sessionID}/permissions/{permissionID}`
    body `{ response: "once" | "always" | "reject" }`
  - Answer question: `POST /question/{id}/reply` body `{ answers: string[][] }`
  - Reject question: `POST /question/{id}/reject`
- Ask payloads the phone needs (`question.asked` shape: `{id, sessionID,
  questions:[{question, header, options, multiple?, custom?}]}`) already ride
  along in phase-1 notifications (`body` field carries the structured ask).

Mobile UI: minimal screens — notification list + ask detail (approve/deny
buttons, question options incl. `multiple` and `custom` free-text).
State catch-up on connect: same boot-sync the desktop does
(`GET /question`, `/permission`, `/api/permission/request` via the tunnel).

## Phase 4 — Full interaction (phone as remote)

- Generalize the phase-3 tunnel to arbitrary server calls, including SSE:
  `GET /event?directory=…` streams through the same desktop websocket
  (desktop re-emits events it already parses — it has one EventSource per
  workspace, ≤5, in `useOpencode.ts`).
- Tauri v2 mobile target reuses `src/` where it's pure logic/UI:
  `api.ts` (`serverFetchFor`, `?directory=`), `sessionStore.ts`, `busyTracker.ts`,
  MessageList/PermissionBar/Markdown rendering. New `src/mobile/` entry with
  stack navigation (Sessions · Chat · Asks · Settings) instead of the desktop
  layout. `baseFor(dir)` gains a "relay tunnel" transport — the phone's
  `opencodeFor(dir)` works unchanged on top of it.
- Out of scope for v3: file editor (Monaco is too heavy for mobile), voice,
  terminals, multi-window.

## Repo impact

| Step | Files |
|---|---|
| Relay | `relay/` crate (done in phase 1: WS fan-out, web push, PWA shim) |
| Phase 1 | `src/hooks/useNotifyRelay.ts` + `useNotifyRelay.test.ts`, `useSettings.ts` keys, settings UI section (done) |
| Phase 2 | `src/mobile/` entry + Connect/Notifications screens, Tauri mobile targets |
| Phase 3 | relay req/res pass-through (desktop handler ~100 lines in `useNotifyRelay.ts`), `src/mobile/` ask screens |
| Phase 4 | `src/mobile/` navigation + pages, `api.ts` relay transport |

Milestone checks: phase 1 — kill desktop network, send 3 events, verify
redelivery on reconnect; phase 2 — app builds on device, notifications match
the shim's (incl. background push); phase 3 — approve a permission from the
phone mid-run, verify agent continues; phase 4 — send a prompt from the
phone, receive the streamed reply. `run.sh check` + `npm run test` at each step.
