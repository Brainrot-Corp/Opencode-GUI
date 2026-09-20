// LAN auto-discovery for the mobile companion (docs/mobile-companion.md).
// The oc-relay answers UDP broadcast probes (see relay/src/main.rs
// spawn_discovery) with JSON {app, url, token}; this command broadcasts and
// returns the first valid reply so the phone app can auto-connect with one
// tap instead of pasting a relay URL + token. Mobile-gated: desktop uses the
// relay info commands instead, but the command compiles everywhere for free.
use serde::Serialize;

const DISCOVER_MAGIC: &[u8] = b"oc-relay-discover-v1";
const PORT: u16 = 8918;

#[derive(Serialize)]
pub struct Found {
    pub url: String,
    pub token: String,
}

#[tauri::command]
pub async fn relay_discover() -> Result<Option<Found>, String> {
    // std UDP in spawn_blocking; tokio's async UdpSocket adds nothing to a
    // one-shot broadcast + 1.5s receive window
    tokio::task::spawn_blocking(|| {
        let sock = std::net::UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
        sock.set_broadcast(true).map_err(|e| e.to_string())?;
        sock.set_read_timeout(Some(std::time::Duration::from_millis(1500)))
            .map_err(|e| e.to_string())?;
        sock.send_to(DISCOVER_MAGIC, ("255.255.255.255", PORT))
            .map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        let mut buf = [0u8; 512];
        while let Some(wait) = deadline.checked_duration_since(std::time::Instant::now()) {
            sock.set_read_timeout(Some(wait)).map_err(|e| e.to_string())?;
            match sock.recv_from(&mut buf) {
                Ok((n, _src)) => {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) {
                        if v["app"] == "oc-relay" {
                            if let (Some(url), Some(token)) =
                                (v["url"].as_str(), v["token"].as_str())
                            {
                                return Ok(Some(Found {
                                    url: url.to_string(),
                                    token: token.to_string(),
                                }));
                            }
                        }
                    }
                    // stray packet — keep waiting until the deadline
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => break,
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(None)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reply_shape() {
        // mirrors relay/src/main.rs spawn_discovery's reply JSON — keep in sync
        let v: serde_json::Value =
            serde_json::from_str(r#"{"app":"oc-relay","url":"ws://192.168.1.10:8918/ws","token":"ocp-ab12"}"#).unwrap();
        assert_eq!(v["app"], "oc-relay");
        assert_eq!(v["url"].as_str().unwrap(), "ws://192.168.1.10:8918/ws");
        assert_eq!(v["token"].as_str().unwrap(), "ocp-ab12");
    }
}
