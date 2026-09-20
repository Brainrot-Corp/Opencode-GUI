# oc-relay

Standalone notification relay for the opencode GUI mobile companion — see
`docs/mobile-companion.md` for the full design. Phase 1 scope: postbox for
agent-activity notifications.

```
desktop GUI ──outbound WS──► oc-relay ◄──outbound WS── phone app
```

Both sides connect **outbound** — no port-forwarding, no NAT config. Works on
LAN, Tailscale, or a VPS. State is in-memory only (replay log caps at 1000
messages / 24h); no DB.

## Run

```
cargo run --release -- [port]     # default port 8918
```

Tokens persist in `relay-tokens.txt` next to the working directory (printed on
every boot for convenience). For packaged apps you don't run it manually:
`run.sh build` / `run.sh portable` build and stage the binary (Tauri
`externalBin` → installed next to the GUI exe), and the GUI's
Settings → Phone notifications → "Run relay on this PC" manages the process.

## Protocol (JSON over WS at `/ws`)

First message from either side must be:

- `{type:"hello", role:"desktop", token}` — one desktop at a time (latest wins)
- `{type:"hello", role:"phone", token, lastId?}` — `lastId` replays every
  notify with a higher id

Then desktop sends: `{type:"notify", id?, kind, title, body?, sessionID?, ts?}`
— relay assigns `id`/`ts` and fans out to every connected phone.

## Desktop setup

Settings → Notifications → Relay URL `ws://<host>:8918/ws` + desktop token.
Phone side ships with the phase-2 mobile app; for manual testing, any WS
client sending a phone hello receives the fan-out.

## Test on a phone (phase-1 milestone check)

1. `cargo run --release` on the PC → copy the printed **phone token**.
   First run: allow oc-relay through the Windows firewall prompt (private
   networks). Find the PC's LAN IP with `ipconfig` (IPv4 address).
2. Phone on the same Wi-Fi → open `http://<PC-LAN-IP>:8918/phone`
   → paste the phone token → **Connect** → **Enable phone notifications**.
3. Desktop GUI → Settings → Phone notifications → relay URL
   `ws://<PC-LAN-IP>:8918/ws` + **desktop token**.
4. Trigger something: send a prompt that finishes (turn-complete
   notification), or one that asks a permission / question / errors.
   Kill + restart the shim page to see replay: it reconnects with the last
   received id and the relay replays everything newer.

The phone app itself (Tauri v2 Android/iOS reusing the GUI's React code)
arrives with phase 2 — until then this page is the phone.

