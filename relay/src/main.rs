// oc-relay — standalone notification relay for the opencode GUI mobile
// companion (docs/mobile-companion.md). One binary, in-memory only.
//
//   desktop GUI ──outbound WS──► oc-relay ◄──outbound WS── phone app
//
// Auth: bearer token per device role (desktop token + phone token), both
// derived at first boot from a random secret printed to stdout. Tokens are
// stored as sha256 so a leaked relay binary/db reveals nothing.
//
// Messages:
//   desktop → relay  {type:"notify", id, kind, title, body, sessionID, ts}
//   phone → relay    {type:"hello", role:"phone", token, lastId?}
//   relay → phone    {type:"notify", ...}   (also replayed on hello.lastId)
//
// A phone reconnect with lastId:<n> replays every notify with id > n.
// Anything older than RELAY_TTL is dropped at replay time.

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        State,
    },
    routing::{get, post},
    Router,
};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use futures_util::{SinkExt, StreamExt};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use web_push_native::{jwt_simple::algorithms::ES256KeyPair, p256::PublicKey, Auth, WebPushBuilder};

const RELAY_TTL: u64 = 24 * 60 * 60; // seconds a notify stays replayable

const SUBS_FILE: &str = "relay-push-subs.json";

fn b64url(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    B64URL.decode(s.trim_end_matches('='))
}

fn b64url_str(bytes: &[u8]) -> String {
    B64URL.encode(bytes)
}

struct Relay {
    desktop_token_hash: String,
    phone_token_hash: String,
    desktop: Mutex<Option<WsSender>>,
    phones: Mutex<Vec<WsSender>>,
    log: Mutex<Vec<Value>>,
    next_id: AtomicU64,
    // web push (background delivery): VAPID signing key + browser subscriptions
    vapid: ES256KeyPair,
    subs: Mutex<Vec<Value>>,
    http: reqwest::Client,
}

type WsSender = tokio::sync::mpsc::UnboundedSender<WsMessage>;

fn sha256_hex(s: &str) -> String {
    let h = Sha256::digest(s.as_bytes());
    h.iter().map(|b| format!("{b:02x}")).collect()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

impl Relay {
    fn push_log(&self, mut v: Value) {
        let mut log = self.log.lock().unwrap();
        self.next_id.fetch_add(1, Ordering::SeqCst);
        let id = self.next_id.load(Ordering::SeqCst);
        v["id"] = json!(id);
        v["ts"] = json!(now());
        log.push(v);
        let cutoff = now() - RELAY_TTL;
        log.retain(|m| m["ts"].as_u64().unwrap_or(0) > cutoff);
        if log.len() > 1000 {
            let drop = log.len() - 1000;
            log.drain(..drop);
        }
    }

    // OS-level background delivery via Web Push (works on Android Chrome and
    // iOS 16.4+ A2HS-installed pages, which suspend open sockets otherwise).
    // Fire-and-forget: dead subscriptions (410/404) are pruned; failures are
    // non-fatal since live phones also get the WS fan-out.
    fn push_web(self: &std::sync::Arc<Self>, msg: Value) {
        let subs = self.subs.lock().unwrap().clone();
        if subs.is_empty() {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let mut gone = Vec::new();
            for (i, sub) in subs.iter().enumerate() {
                            let (endpoint, ua_public, ua_auth) = (
                    sub["endpoint"].as_str().unwrap_or("").parse(),
                    b64url(sub["keys"]["p256dh"].as_str().unwrap_or(""))
                        .and_then(|b| PublicKey::from_sec1_bytes(&b).map_err(|_| base64::DecodeError::InvalidLength(0))),
                    b64url(sub["keys"]["auth"].as_str().unwrap_or("")).map(|b| Auth::clone_from_slice(&b)),
                );
                let (Ok(endpoint), Ok(ua_public), Ok(ua_auth)) = (endpoint, ua_public, ua_auth) else {
                    gone.push(i);
                    continue;
                };
                match WebPushBuilder::new(endpoint, ua_public, ua_auth)
                    .with_vapid(&this.vapid, "mailto:oc-relay@localhost")
                    .build(msg.to_string())
                {
                    Ok(req) => {
                        let (parts, body) = req.into_parts();
                        let mut rb = this
                            .http
                            .request(parts.method, parts.uri.to_string())
                            .body(body);
                        for (k, v) in parts.headers.iter() {
                            rb = rb.header(k.as_str(), v.to_str().unwrap_or_default());
                        }
                        match rb.send().await {
                            Ok(resp) if resp.status() == 404 || resp.status() == 410 => gone.push(i),
                            Ok(_) => {}
                            Err(_) => {}
                        }
                    }
                    Err(_) => gone.push(i),
                }
            }
            if !gone.is_empty() {
                let mut all = this.subs.lock().unwrap();
                let mut next = Vec::new();
                for (i, s) in all.iter().enumerate() {
                    if !gone.contains(&i) {
                        next.push(s.clone());
                    }
                }
                *all = next;
                let _ = std::fs::write(SUBS_FILE, serde_json::to_string(&*all).unwrap_or_default());
                println!("[~] pruned {} dead push subscription(s)", gone.len());
            }
        });
    }

    fn replay_after(&self, last_id: u64) -> Vec<Value> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m["id"].as_u64().unwrap_or(0) > last_id)
            .cloned()
            .collect()
    }
}

fn token_ok(provided: &str, expected_hash: &str) -> bool {
    // constant-time-ish: compare hashes, not raw tokens
    !provided.is_empty() && sha256_hex(provided) == expected_hash
}

async fn handle_socket(socket: WebSocket, relay: std::sync::Arc<Relay>) {
    let (mut tx_ch, mut rx_ch) = socket.split::<WsMessage>();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<WsMessage>();

    // first message must be hello {role, token}
    let Some(Ok(WsMessage::Text(first))) = rx_ch.next().await else { return };
    let hello: Value = match serde_json::from_slice(first.as_bytes()) {
        Ok(v) => v,
        Err(_) => return,
    };
    let r = hello["role"].as_str().unwrap_or("");
    let token = hello["token"].as_str().unwrap_or("");
    let role: &str = if r == "desktop" && token_ok(token, &relay.desktop_token_hash) {
        *relay.desktop.lock().unwrap() = Some(out_tx.clone());
        println!("[+] desktop connected");
        "desktop"
    } else if r == "phone" && token_ok(token, &relay.phone_token_hash) {
        println!("[+] phone connected (replay from id {})", hello["lastId"].as_u64().unwrap_or(0));
        relay.phones.lock().unwrap().push(out_tx.clone());
        let last = hello["lastId"].as_u64().unwrap_or(0);
        for m in relay.replay_after(last) {
            let _ = out_tx.send(WsMessage::Text(m.to_string().into()));
        }
        "phone"
    } else {
        let _ = out_tx.send(WsMessage::Text(json!({"type":"error","error":"bad token"}).to_string().into()));
        return;
    };

    // writer task
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if tx_ch.send(msg).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg) = rx_ch.next().await {
        let Ok(WsMessage::Text(txt)) = msg else { continue };
        let Ok(v) = serde_json::from_slice::<Value>(txt.as_bytes()) else { continue };
        match v["type"].as_str() {
            Some("notify") if role == "desktop" => {
                relay.push_log(v.clone());
                let mut phones = relay.phones.lock().unwrap();
                phones.retain(|p| p.send(WsMessage::Text(v.to_string().into())).is_ok());
                drop(phones);
                relay.push_web(v);
            }
            _ => {}
        }
    }

    // cleanup on disconnect
    if role == "desktop" {
        *relay.desktop.lock().unwrap() = None;
        println!("[-] desktop disconnected");
    } else if role == "phone" {
        relay
            .phones
            .lock()
            .unwrap()
            .retain(|p| !p.same_channel(&out_tx));
        println!("[-] phone disconnected");
    }
    writer.abort();
}

// POST /test?token=<desktop token> — injects a synthetic notify so the phone
// page can be verified without the desktop GUI (curl from the PC).
async fn test_handler(
    State(relay): State<std::sync::Arc<Relay>>,
    headers: axum::http::HeaderMap,
) -> impl axum::response::IntoResponse {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if !token_ok(token, &relay.desktop_token_hash) {
        return (axum::http::StatusCode::UNAUTHORIZED, "bad desktop token".to_string());
    }
    let msg = json!({"type":"notify","kind":"test","title":"Relay test","body":"hello from the PC","sessionID":"test"});
    relay.push_log(msg.clone());
    let mut phones = relay.phones.lock().unwrap();
    let n = phones.len();
    phones.retain(|p| p.send(WsMessage::Text(msg.to_string().into())).is_ok());
    drop(phones);
    relay.push_web(msg);
    println!("[~] test notify fanned out to {n} phone(s)");
    (axum::http::StatusCode::OK, format!("fanned out to {n} phone(s)"))
}

// POST /push-sub (Bearer phone token) — a browser push subscription from the
// phone shim. Persisted so pushes survive relay restarts; pruned on 410/404.
async fn push_sub_handler(
    State(relay): State<std::sync::Arc<Relay>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> impl axum::response::IntoResponse {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if !token_ok(token, &relay.phone_token_hash) {
        return (axum::http::StatusCode::UNAUTHORIZED, "bad phone token".to_string());
    }
    let sub: Value = match serde_json::from_str::<Value>(&body) {
        Ok(v) if v["endpoint"].is_string() && v["keys"]["p256dh"].is_string() && v["keys"]["auth"].is_string() => v,
        _ => return (axum::http::StatusCode::BAD_REQUEST, "not a push subscription".to_string()),
    };
    let mut subs = relay.subs.lock().unwrap();
    subs.retain(|s| s["endpoint"] != sub["endpoint"]);
    if subs.len() >= 16 {
        let drop = subs.len() - 16;
        subs.drain(..drop);
    }
    subs.push(sub);
    let _ = std::fs::write(SUBS_FILE, serde_json::to_string(&*subs).unwrap_or_default());
    let n = subs.len();
    println!("[+] push subscription stored ({n} total)");
    (axum::http::StatusCode::OK, format!("stored ({n} subscription(s))"))
}

async fn ws_handler(ws: WebSocketUpgrade, State(relay): State<std::sync::Arc<Relay>>) -> impl axum::response::IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, relay))
}

// phone shim — a test page for the phase-1 milestone check before the real
// mobile app exists (docs/mobile-companion.md): open http://<relay-host>:PORT/phone
// in any phone browser, paste the phone token, receive the fan-out.
async fn phone_page(State(relay): State<std::sync::Arc<Relay>>) -> impl axum::response::IntoResponse {
    // applicationServerKey = uncompressed VAPID public key, base64url —
    // derive via the raw scalar (jwt_simple's public-key wrapper hides sec1 export)
    use web_push_native::p256::elliptic_curve::sec1::ToEncodedPoint;
    let secret = web_push_native::p256::SecretKey::from_slice(&relay.vapid.to_bytes()).unwrap();
    let pub_bytes = secret.public_key().to_encoded_point(false).as_bytes().to_vec();
    axum::response::Html(PHONE_SHIM.replace("__VAPID_PUB__", &b64url_str(&pub_bytes)))
}

// service worker — Android Chrome refuses page-level `new Notification()`
// (it demands ServiceWorkerRegistration.showNotification); iOS exposes the
// Notification API only after Add to Home Screen. This tiny worker provides
// the registration and handles clicks.
async fn sw_js() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/javascript")],
        r#"self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) if (c.url.includes("/phone")) return c.focus();
    return self.clients.openWindow("/phone");
  }));
});

// background delivery — browsers suspend open sockets, so messages that
// arrive while the app is closed/backgrounded ride Web Push instead
self.addEventListener("push", (e) => {
  let title = "opencode", body = "";
  try {
    const m = e.data ? e.data.json() : null;
    if (m) { title = m.title ?? title; body = m.body ?? ""; }
  } catch {}
  e.waitUntil(self.registration.showNotification(title, { body, tag: "oc-relay" }));
});
"#,
    )
}

// minimal PWA manifest — required by Android Chrome for install + notifications
async fn manifest() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/manifest+json")],
        r##"{"name":"opencode relay","short_name":"oc-relay","start_url":"/phone","display":"standalone","background_color":"#0d1216","theme_color":"#0d1216","icons":[{"src":"/icon.svg","sizes":"any","type":"image/svg+xml"}]}"##,
    )
}

async fn icon_svg() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "image/svg+xml")],
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0d1216"/><circle cx="32" cy="30" r="14" fill="none" stroke="#7fd4d4" stroke-width="4"/><path d="M26 48h12" stroke="#7fd4d4" stroke-width="4" stroke-linecap="round"/></svg>"##,
    )
}

#[tokio::main]
async fn main() {
    // reqwest (rustls-tls) + axum-server (tls-rustls) enable different rustls
    // crypto providers — without an explicit pick rustls panics on the
    // ambiguous "exactly one provider" rule
    let _ = rustls::crypto::ring::default_provider().install_default();
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(8918);

    // tokens persist in ./relay-tokens.txt so restarts keep the same values
    // (a restart used to invalidate the phone page + desktop config). Still
    // printed on every boot for convenience.
    let (desktop_token, phone_token) = load_or_make_tokens();
    println!("oc-relay listening on ws://0.0.0.0:{port}");
    println!("desktop token: {desktop_token}");
    println!("phone token:   {phone_token}");

    // VAPID key for web push (background delivery) — persists in the token
    // file so browser subscriptions stay valid across restarts
    let vapid = load_or_make_vapid();
    println!("vapid public:  {}", b64url_str(&vapid.public_key().to_bytes()));
    let subs: Vec<Value> = std::fs::read_to_string(SUBS_FILE)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    println!("push subscriptions loaded: {}", subs.len());

    let relay = std::sync::Arc::new(Relay {
        desktop_token_hash: sha256_hex(&desktop_token),
        phone_token_hash: sha256_hex(&phone_token),
        desktop: Mutex::new(None),
        phones: Mutex::new(Vec::new()),
        log: Mutex::new(Vec::new()),
        next_id: AtomicU64::new(0),
        vapid,
        subs: Mutex::new(subs),
        http: reqwest::Client::new(),
    });

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/phone", get(phone_page))
        .route("/sw.js", get(sw_js))
        .route("/manifest.webmanifest", get(manifest))
        .route("/icon.svg", get(icon_svg))
        .route("/test", post(test_handler))
        .route("/push-sub", post(push_sub_handler))
        .with_state(relay.clone());

    // self-signed TLS on port+1 — phone browsers (MDM/Screen Time) often block
    // plain http pages on LAN IPs; https + "accept the cert warning" usually
    // gets through. Also gives wss:// for the desktop when both are remote.
    if let (Some(ip), Ok(tls)) = (lan_ip(), tls_config()) {
        let https_port = port + 1;
        let app2 = app.clone();
        tokio::spawn(async move {
            let addr = std::net::SocketAddr::from(([0, 0, 0, 0], https_port));
            if let Err(e) = axum_server::bind_rustls(addr, tls).serve(app2.into_make_service()).await {
                eprintln!("https listener failed: {e}");
            }
        });
        println!("phone test page:  https://{ip}:{https_port}/phone   (self-signed — accept the browser warning)");
        println!("wss relay url:    wss://{ip}:{https_port}/ws");
    } else {
        println!("(no LAN IP / TLS — phone test page unavailable, use ws:// only)");
    }

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// tokens persist in relay-tokens.txt next to the relay's working directory —
// two lines: desktop first, phone second. Missing/corrupt file → regenerate.
fn load_or_make_tokens() -> (String, String) {
    if let Ok(txt) = std::fs::read_to_string("relay-tokens.txt") {
        let mut lines = txt.lines().filter(|l| l.starts_with("ocd-") || l.starts_with("ocp-"));
        if let (Some(d), Some(p)) = (lines.next(), lines.next()) {
            return (d.to_string(), p.to_string());
        }
    }
    let mut secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    let desktop_token = format!("ocd-{}", hex(&secret));
    // short phone token (32-bit) — it rides in the shareable phone-page link
    // (?t=) and is typeable by hand; entropy is fine for a LAN relay
    let mut secret2 = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut secret2);
    let phone_token = format!("ocp-{}", hex(&secret2));
    let _ = std::fs::write("relay-tokens.txt", format!("{desktop_token}\n{phone_token}\n"));
    (desktop_token, phone_token)
}

// outbound-interface IP (the LAN IP phones will use) without extra deps
fn lan_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

// self-signed cert covering the LAN IP + localhost, in-memory, regenerated per boot
fn tls_config() -> Result<axum_server::tls_rustls::RustlsConfig, Box<dyn std::error::Error>> {
    let mut sans = vec!["localhost".to_string()];
    if let Some(ip) = lan_ip() {
        sans.push(ip.to_string()); // generate_simple_self_signed converts IPs to IP SANs
    }
    let ck = rcgen::generate_simple_self_signed(sans)?;
    let cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![ck.cert.der().clone()], rustls::pki_types::PrivatePkcs8KeyDer::from(ck.key_pair.serialize_der()).into())?;
    Ok(axum_server::tls_rustls::RustlsConfig::from_config(std::sync::Arc::new(cfg)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// VAPID private key (raw 32-byte scalar, base64url) — persisted as a third
// `vap-` line in relay-tokens.txt so browser subscriptions survive restarts
fn load_or_make_vapid() -> ES256KeyPair {
    let existing = std::fs::read_to_string("relay-tokens.txt")
        .ok()
        .and_then(|txt| {
            txt.lines()
                .find(|l| l.starts_with("vap-"))
                .and_then(|l| b64url(l.trim().trim_start_matches("vap-")).ok())
        });
    let kp = if let Some(raw) = existing {
        ES256KeyPair::from_bytes(&raw).unwrap_or_else(|_| ES256KeyPair::generate())
    } else {
        ES256KeyPair::generate()
    };
    if let Ok(txt) = std::fs::read_to_string("relay-tokens.txt") {
        let vap = format!("vap-{}", b64url_str(&kp.to_bytes()));
        let mut lines: Vec<String> = txt.lines().filter(|l| !l.starts_with("vap-")).map(String::from).collect();
        lines.push(vap);
        let _ = std::fs::write("relay-tokens.txt", lines.join("\n") + "\n");
    }
    kp
}

const PHONE_SHIM: &str = r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oc-relay phone</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/icon.svg">
<style>
  body { background:#0d1216; color:#d7e2e4; font:15px/1.45 system-ui, sans-serif; margin:0; padding:18px; }
  h1 { font-size:16px; color:#7fd4d4; margin:0 0 10px; }
  input { width:100%; box-sizing:border-box; padding:9px; border:1px solid #2a3a42; border-radius:6px;
          background:#121a20; color:#d7e2e4; font:13px ui-monospace, monospace; }
  button { width:100%; margin-top:8px; padding:10px; border:0; border-radius:6px; cursor:pointer;
           background:#7fd4d4; color:#0d1216; font-weight:600; font-size:14px; }
  .row { margin:8px 0; padding:10px 12px; background:#141d24; border:1px solid #223038; border-radius:8px; }
  .k { color:#7fd4d4; font-weight:700; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
  .t { font-weight:600; margin:2px 0; }
  .b { color:#9fb3ba; font-size:13px; white-space:pre-wrap; word-break:break-word; }
  .m { color:#5c6f77; font-size:11px; font-family:ui-monospace, monospace; margin-top:4px; }
  #st { font-size:12px; color:#8aa0a8; margin:6px 0; white-space:pre-wrap; }
</style>
</head>
<body>
<h1>oc-relay phone shim</h1>
<div id="st">not connected</div>
<input id="tok" placeholder="phone token (printed by oc-relay)">
<button onclick="go()">Connect</button>
<button onclick="ask()">Enable phone notifications</button>
<div id="log"></div>
<script>
const log = document.getElementById("log"), st = document.getElementById("st");
let dead = false, swreg = null;
const lastId = () => +(localStorage.getItem("oc-lastId") || 0);

// OS banner notifications — mobile browsers gate this API:
// Android needs ServiceWorkerRegistration.showNotification (new Notification throws),
// iOS only exposes Notification after Add to Home Screen (iOS 16.4+).
// The in-page list below always works regardless.
async function osNotify(title, body) {
  if (swreg) {
    try { await swreg.showNotification(title, { body }); return; } catch {}
  }
  try { new Notification(title, { body }); return; } catch {}
}

function notify(m) {
  const d = document.createElement("div");
  d.className = "row";
  d.innerHTML = `<div class="k">${m.kind ?? "?"}</div><div class="t"></div><div class="b"></div><div class="m">#${m.id} · ${m.sessionID ?? ""}</div>`;
  d.querySelector(".t").textContent = m.title ?? "";
  d.querySelector(".b").textContent = m.body ?? "";
  log.prepend(d);
  osNotify(m.title ?? "opencode", m.body ?? "");
}

function go() {
  dead = false;
  localStorage.setItem("oc-phone-token", document.getElementById("tok").value.trim());
  connect();
}

async function ask() {
  if (!("serviceWorker" in navigator) && !("Notification" in window)) {
    st.textContent = "this browser has no web notifications — notifications only appear in the list below";
    return;
  }
  if ("serviceWorker" in navigator) {
    try { swreg = await navigator.serviceWorker.register("/sw.js"); } catch (e) { st.textContent = "sw: " + e; }
  }
  if ("Notification" in window) {
    try {
      const p = await Notification.requestPermission();
      if (p === "granted") st.textContent = "system notifications on" + (swreg ? "" : " (no SW)");
      else st.textContent = "system notifications: " + p + " — the page list still works. On Android/iOS, use 'Add to Home Screen' and open from the icon, then press Enable again.";
    } catch (e) { st.textContent = "notifications: " + e; }
  }
  // background delivery: a push subscription routes messages through the OS
  // push service (FCM on Android / APNs on iOS) so they arrive while the
  // page is backgrounded or closed. iOS needs the page installed (A2HS).
  if (swreg && swreg.pushManager) {
    try {
      const key = "__VAPID_PUB__";
      let sub = await swreg.pushManager.getSubscription();
      if (!sub || sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))) !== key) {
        sub = await swreg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8(key),
        });
      }
      const r = await fetch("/push-sub", {
        method: "POST",
        headers: { Authorization: "Bearer " + document.getElementById("tok").value.trim() },
        body: JSON.stringify(sub.toJSON ? sub.toJSON() : sub),
      });
      st.textContent = r.ok
        ? "system + background notifications on — banners now arrive when the app is closed"
        : "push subscribe failed: " + r.status;
    } catch (e) {
      st.textContent = "background push: " + e + " — iOS needs 'Add to Home Screen' first (Share menu), then Enable again.";
    }
  }
}

function urlB64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function connect() {
  if (dead) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    st.textContent = "connected — waiting for desktop events";
    ws.send(JSON.stringify({ type: "hello", role: "phone", token: document.getElementById("tok").value.trim(), lastId: lastId() }));
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === "notify") { notify(m); localStorage.setItem("oc-lastId", String(m.id)); }
      else if (m.type === "error") st.textContent = m.error;
    } catch {}
  };
  ws.onclose = () => { st.textContent = "reconnecting…"; setTimeout(connect, 2000); };
}

window.addEventListener("beforeunload", () => { dead = true; });
// ?t= autofill — the desktop settings drawer builds the full link with token
const qtok = new URLSearchParams(location.search).get("t");
if (qtok) { document.getElementById("tok").value = qtok; go(); }
else {
  const saved = localStorage.getItem("oc-phone-token");
  if (saved) document.getElementById("tok").value = saved;
}
</script>
</body>
</html>"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn relay() -> Relay {
        Relay {
            desktop_token_hash: sha256_hex("desk-secret"),
            phone_token_hash: sha256_hex("phone-secret"),
            desktop: Mutex::new(None),
            phones: Mutex::new(Vec::new()),
            log: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(0),
            vapid: ES256KeyPair::generate(),
            subs: Mutex::new(Vec::new()),
            http: reqwest::Client::new(),
        }
    }

    #[test]
    fn token_check() {
        assert!(token_ok("desk-secret", &sha256_hex("desk-secret")));
        assert!(!token_ok("wrong", &sha256_hex("desk-secret")));
        assert!(!token_ok("", &sha256_hex("desk-secret")));
    }

    #[test]
    fn push_log_assigns_ids_and_drops_old() {
        let r = relay();
        r.push_log(json!({"kind":"idle"}));
        r.push_log(json!({"kind":"error"}));
        let log = r.log.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[1]["id"].as_u64().unwrap(), 2);
        assert!(log[1]["ts"].as_u64().unwrap() > 0);
    }

    #[test]
    fn replay_after_returns_newer_only() {
        let r = relay();
        r.push_log(json!({"kind":"idle"}));
        r.push_log(json!({"kind":"perm"}));
        let re = r.replay_after(1);
        assert_eq!(re.len(), 1);
        assert_eq!(re[0]["kind"].as_str().unwrap(), "perm");
        assert_eq!(r.replay_after(2).len(), 0);
    }

    #[test]
    fn log_caps_at_1000() {
        let r = relay();
        for i in 0..1200 {
            r.push_log(json!({"i": i}));
        }
        let log = r.log.lock().unwrap();
        assert_eq!(log.len(), 1000);
        assert_eq!(log[999]["i"].as_i64().unwrap(), 1199);
    }
}
