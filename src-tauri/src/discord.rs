use std::sync::Mutex;
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};

const DEFAULT_CLIENT_ID: &str = "1542215270972784804";

pub struct DiscordState {
    pub client: Mutex<Option<DiscordIpcClient>>,
    pub client_id: Mutex<String>,
    pub connected: Mutex<bool>,
    pub start_ts: Mutex<Option<i64>>,
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
            start_ts: Mutex::new(None),
        }
    }
}

fn get_or_init_start_ts(state: &DiscordState) -> i64 {
    if let Ok(g) = state.start_ts.lock() {
        if let Some(ts) = *g {
            return ts;
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if let Ok(mut g) = state.start_ts.lock() {
        if g.is_none() && now > 0 {
            *g = Some(now);
            return now;
        }
        if let Some(ts) = *g {
            return ts;
        }
    }
    now
}

fn truncate128(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() > 128 {
        c[..128].iter().collect()
    } else {
        s.to_string()
    }
}

// cheap part of the old ensure_client: reset on client-id change + create
// the client if missing — no IO, safe to run inline on the async command.
// The blocking connect lives in discord_set's spawn_blocking body.
fn ensure_client_created(state: &DiscordState, requested_id: Option<&str>) -> Result<(), String> {
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

    // ensure client exists (create is pure data — connect is the blocking part)
    let mut cli_guard = state.client.lock().map_err(|_| "lock poisoned")?;
    if cli_guard.is_none() {
        *cli_guard = Some(DiscordIpcClient::new(&want_id).map_err(|e| e.to_string())?);
        if let Ok(mut c) = state.connected.lock() {
            *c = false;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn discord_set(
    state: tauri::State<'_, DiscordState>,
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
        // cheap: reset on id change + create client if missing (no IO)
        if let Err(e) = ensure_client_created(&state, client_id.as_deref()) {
            last_err = e;
            if attempt == 0 {
                // drop and retry once after short delay (off-thread)
                let _ = tauri::async_runtime::spawn_blocking(|| {
                    std::thread::sleep(std::time::Duration::from_millis(200))
                })
                .await;
                continue;
            }
            return Err(last_err);
        }
        // authoritative timer: process-lifetime start_ts, survives webview reloads/HMR
        // JS-provided start_ts is ignored except to seed the first value if we have none
        if let Some(ts) = start_ts {
            if ts > 0 {
                if let Ok(mut g) = state.start_ts.lock() {
                    if g.is_none() {
                        *g = Some(ts);
                    }
                }
            }
        }
        let effective_ts = get_or_init_start_ts(&state);

        // take the client out so the blocking named-pipe connect / write can
        // run on the blocking pool — the window where the slot is empty is
        // the same one the old code had between its lock drops
        let taken = state.client.lock().map_err(|_| "lock poisoned")?.take();
        let Some(mut client) = taken else { return Err("no discord client".into()) };
        let connected = state.connected.lock().map(|g| *g).unwrap_or(false);

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

        // connect + set_activity are blocking named-pipe IO — blocking pool
        // returns the client so it can go back into the state mutex. The
        // Activity borrows the owned strings, so it is built inside the
        // blocking task.
        let res = tauri::async_runtime::spawn_blocking(
            move || -> Result<DiscordIpcClient, (DiscordIpcClient, String, bool)> {
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
                act = act.timestamps(activity::Timestamps::new().start(effective_ts));

                if !connected {
                    if let Err(e) = client.connect() {
                        // keep the client for the retry attempt (old behavior)
                        return Err((client, format!("discord not available: {e}"), false));
                    }
                }
                match client.set_activity(act) {
                    Ok(_) => Ok(client),
                    // broken pipe — flag for close+drop so the retry gets a fresh client
                    Err(e) => Err((client, e.to_string(), true)),
                }
            },
        )
        .await;
        match res {
            Ok(Ok(client)) => {
                *state.client.lock().map_err(|_| "lock poisoned")? = Some(client);
                if let Ok(mut cc) = state.connected.lock() {
                    *cc = true;
                }
                return Ok(());
            }
            Ok(Err((mut client, e, close_it))) => {
                last_err = e;
                if close_it {
                    let _ = client.close();
                    if let Ok(mut cc) = state.connected.lock() {
                        *cc = false;
                    }
                    // client dropped — next attempt creates a fresh one
                    if attempt == 0 {
                        continue;
                    }
                    return Err(last_err);
                }
                // connect failed — keep the client for the retry attempt
                *state.client.lock().map_err(|_| "lock poisoned")? = Some(client);
                if attempt == 0 {
                    // drop and retry once after short delay (off-thread)
                    let _ = tauri::async_runtime::spawn_blocking(|| {
                        std::thread::sleep(std::time::Duration::from_millis(200))
                    })
                    .await;
                    continue;
                }
                return Err(last_err);
            }
            Err(join) => {
                // blocking task panicked — the moved client is lost either way
                if let Ok(mut g) = state.connected.lock() {
                    *g = false;
                }
                let _ = join;
                return Err("discord task join failed".into());
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
pub fn discord_get_start_ts(state: tauri::State<DiscordState>) -> i64 {
    get_or_init_start_ts(&state)
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
