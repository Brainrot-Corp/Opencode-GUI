use std::sync::Mutex;
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};

const DEFAULT_CLIENT_ID: &str = "1542215270972784804";

pub struct DiscordState {
    pub client: Mutex<Option<DiscordIpcClient>>,
    pub client_id: Mutex<String>,
    pub connected: Mutex<bool>,
}

impl DiscordState {
    pub fn shutdown(&self) {
        if let Ok(mut g) = self.client.lock() {
            if let Some(mut c) = g.take() {
                let _ = c.close();
            }
        }
        if let Ok(mut g) = self.connected.lock() {
            *g = false;
        }
    }
}

impl Default for DiscordState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
            client_id: Mutex::new(String::new()),
            connected: Mutex::new(false),
        }
    }
}

fn truncate128(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() > 128 {
        c[..128].iter().collect()
    } else {
        s.to_string()
    }
}

fn ensure_client(state: &DiscordState, requested_id: Option<&str>) -> Result<(), String> {
    let want_id = requested_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_CLIENT_ID)
        .trim()
        .to_string();

    // check if id changed — do it without holding all locks at once
    let need_reset = {
        let id_guard = state.client_id.lock().map_err(|_| "lock poisoned")?;
        *id_guard != want_id
    };
    if need_reset {
        if let Ok(mut cli_guard) = state.client.lock() {
            if let Some(mut c) = cli_guard.take() {
                let _ = c.close();
            }
        }
        if let Ok(mut c) = state.connected.lock() {
            *c = false;
        }
        if let Ok(mut id_guard) = state.client_id.lock() {
            *id_guard = want_id.clone();
        }
    }

    // ensure client exists
    {
        let mut cli_guard = state.client.lock().map_err(|_| "lock poisoned")?;
        if cli_guard.is_none() {
            *cli_guard = Some(DiscordIpcClient::new(&want_id).map_err(|e| e.to_string())?);
            if let Ok(mut c) = state.connected.lock() {
                *c = false;
            }
        }
    }

    // try connect if not yet connected — don't hold locks across blocking call
    let already = state.connected.lock().map(|g| *g).unwrap_or(false);
    if !already {
        let mut guard = state.client.lock().map_err(|_| "lock poisoned")?;
        if let Some(inner) = guard.as_mut() {
            match inner.connect() {
                Ok(_) => {
                    drop(guard);
                    if let Ok(mut cc) = state.connected.lock() {
                        *cc = true;
                    }
                }
                Err(e) => return Err(format!("discord not available: {e}")),
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn discord_set(
    state: tauri::State<DiscordState>,
    details: String,
    stt: String,
    large_image: Option<String>,
    small_image: Option<String>,
    large_text: Option<String>,
    start_ts: Option<i64>,
    client_id: Option<String>,
) -> Result<(), String> {
    // need to handle reconnection on failure — one retry
    let mut last_err = String::new();
    for attempt in 0..2 {
        let ensure = ensure_client(&state, client_id.as_deref());
        if let Err(e) = ensure {
            last_err = e;
            if attempt == 0 {
                // drop and retry once after short delay
                std::thread::sleep(std::time::Duration::from_millis(200));
                continue;
            }
            return Err(last_err);
        }
        let mut cli_guard = state.client.lock().map_err(|_| "lock poisoned")?;
        let cli = cli_guard.as_mut().ok_or("no discord client")?;

        let details_owned = truncate128(details.trim());
        let stt_owned = truncate128(stt.trim());
        let li_owned: Option<String> = large_image
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|s| truncate128(&s));
        let lt_owned: Option<String> = large_text
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|s| truncate128(&s));
        let si_owned: Option<String> = small_image
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|s| truncate128(&s));

        let mut act = activity::Activity::new()
            .details(&details_owned)
            .state(&stt_owned);

        // assets — optional: only if li present (avoids missing asset rejection)
        if let Some(li) = li_owned.as_deref() {
            let mut assets = activity::Assets::new().large_image(li);
            if let Some(lt) = lt_owned.as_deref() {
                assets = assets.large_text(lt);
            }
            if let Some(si) = si_owned.as_deref() {
                assets = assets.small_image(si);
            }
            act = act.assets(assets);
        }

        if let Some(ts) = start_ts {
            act = act.timestamps(activity::Timestamps::new().start(ts));
        }

        match cli.set_activity(act) {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                // broken pipe — drop client and retry
                let mut conn_guard = state.connected.lock().map_err(|_| "lock poisoned")?;
                *conn_guard = false;
                drop(cli_guard);
                drop(conn_guard);
                // take and close
                if let Ok(mut g) = state.client.lock() {
                    if let Some(mut c) = g.take() {
                        let _ = c.close();
                    }
                }
                if attempt == 0 {
                    continue;
                }
                return Err(last_err);
            }
        }
    }
    Err(last_err)
}

#[tauri::command]
pub fn discord_clear(state: tauri::State<DiscordState>) -> Result<(), String> {
    let mut cli_guard = state.client.lock().map_err(|_| "lock poisoned")?;
    if let Some(c) = cli_guard.as_mut() {
        let _ = c.clear_activity().map_err(|e| e.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn discord_status(state: tauri::State<DiscordState>) -> String {
    let connected = state.connected.lock().map(|g| *g).unwrap_or(false);
    let has_client = state.client.lock().map(|g| g.is_some()).unwrap_or(false);
    if connected && has_client {
        "connected".to_string()
    } else if has_client {
        "disconnected".to_string()
    } else {
        "idle".to_string()
    }
}

#[tauri::command]
pub fn discord_close(state: tauri::State<DiscordState>) -> Result<(), String> {
    let mut cli_guard = state.client.lock().map_err(|_| "lock poisoned")?;
    if let Some(mut c) = cli_guard.take() {
        let _ = c.close();
    }
    if let Ok(mut g) = state.connected.lock() {
        *g = false;
    }
    Ok(())
}
