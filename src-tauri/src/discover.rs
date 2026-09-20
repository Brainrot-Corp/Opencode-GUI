// LAN auto-discovery for the mobile companion (docs/mobile-companion.md).
// The oc-relay answers UDP broadcast probes (see relay/src/main.rs
// spawn_discovery) with JSON {app, url, token}; this command broadcasts and
// returns the first valid reply so the phone app can auto-connect with one
// tap instead of pasting a relay URL + token. Sync command — Tauri runs
// those on its own thread pool, so no tokio (which the mobile build
// deliberately doesn't depend on).
//
// Wi-Fi APs and Android often swallow 255.255.255.255 broadcasts, so we also
// probe the subnet broadcast and unicast every host in each private /24 we
// have an address on — unicast is what actually gets through.
use serde::Serialize;

const DISCOVER_MAGIC: &[u8] = b"oc-relay-discover-v1";
const PORT: u16 = 8918;

#[derive(Serialize)]
pub struct Found {
    pub url: String,
    pub token: String,
}

#[tauri::command]
pub fn relay_discover() -> Result<Option<Found>, String> {
    let sock = std::net::UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
    sock.set_read_timeout(Some(std::time::Duration::from_millis(1500)))
        .map_err(|e| e.to_string())?;
    let probe = |addr: std::net::SocketAddr| {
        let _ = sock.send_to(DISCOVER_MAGIC, addr);
    };
    for ip in private_addrs() {
        probe((std::net::IpAddr::V4(broadcast_of(ip)), PORT).into());
        // ponytail: unicast flood of one /24 per private interface (254
        // datagrams) — if-addrs gives no netmask, so /24 is the assumed size
        let base = u32::from(ip) & 0xFFFF_FF00;
        for h in 1..255u32 {
            let host = std::net::Ipv4Addr::from(base | h);
            if host != ip {
                probe((std::net::IpAddr::V4(host), PORT).into());
            }
        }
    }
    let mut buf = [0u8; 512];
    while let Some(wait) = deadline.checked_duration_since(std::time::Instant::now()) {
        sock.set_read_timeout(Some(wait)).map_err(|e| e.to_string())?;
        match sock.recv_from(&mut buf) {
            Ok((n, _src)) => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) {
                    if v["app"] == "oc-relay" {
                        if let (Some(url), Some(token)) = (v["url"].as_str(), v["token"].as_str())
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
}

// private IPv4 addresses of this device (192.168/10.x/172.16-31), deduped
fn private_addrs() -> Vec<std::net::Ipv4Addr> {
    let mut out: Vec<std::net::Ipv4Addr> = Vec::new();
    for ip in if_addrs::get_if_addrs()
        .into_iter()
        .flatten()
        .map(|i| i.ip())
        .filter_map(|ip| match ip {
            std::net::IpAddr::V4(v4) => Some(v4),
            _ => None,
        })
    {
        let o = ip.octets();
        let private = o[0] == 10 || (o[0] == 192 && o[1] == 168) || (o[0] == 172 && (16..=31).contains(&o[1]));
        if !private || out.contains(&ip) {
            continue;
        }
        out.push(ip);
    }
    out
}

fn broadcast_of(ip: std::net::Ipv4Addr) -> std::net::Ipv4Addr {
    std::net::Ipv4Addr::from(u32::from(ip) | 0x0000_00FF)
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

    #[test]
    fn private_addrs_filters_non_rfc1918() {
        // relay's own LAN_IP fallback list is trusted here; the filter itself
        // must drop loopback/link-local and RFC1918 duplicates
        let addrs = private_addrs();
        assert!(addrs.iter().all(|ip| {
            let o = ip.octets();
            o[0] == 10 || (o[0] == 192 && o[1] == 168) || (o[0] == 172 && (16..=31).contains(&o[1]))
        }));
    }

    #[test]
    fn broadcast_hits_last_octet() {
        assert_eq!(
            broadcast_of(std::net::Ipv4Addr::new(192, 168, 1, 48)).to_string(),
            "192.168.1.255"
        );
    }
}
