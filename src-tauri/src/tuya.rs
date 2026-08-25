// Tuya Cloud API — signed HTTPS calls for voice light control.
// Sign scheme per developer.tuya.com "Sign Requests" (HMAC-SHA256):
//   token req : HMAC(secret, client_id + t + stringToSign)
//   other reqs: HMAC(secret, client_id + access_token + t + stringToSign)
//   stringToSign = method \n sha256(body) \n (signed headers empty) \n path?query
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

type HmacSha256 = Hmac<Sha256>;

// (access_token, expires_at unix ms)
pub struct TuyaState(pub Mutex<Option<(String, u64)>>);

#[derive(Serialize, Deserialize, Clone)]
pub struct TuyaCreds {
    pub client_id: String,
    pub secret: String,
    pub region: String, // us | eu | cn | in
    pub uid: String,    // Smart Life account uid from the platform's linked-accounts page
}

impl TuyaCreds {
    fn base(&self) -> &'static str {
        match self.region.as_str() {
            "eu" => "https://openapi.tuyaeu.com",
            "cn" => "https://openapi.tuyacn.com",
            "in" => "https://openapi.tuyain.com",
            _ => "https://openapi.tuyaus.com",
        }
    }
}

fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

fn sign(secret: &str, msg: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(msg.as_bytes());
    hex::encode(mac.finalize().into_bytes()).to_uppercase()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("reqwest client")
}

// unwrap Tuya's {success, result, msg} envelope
async fn unwrap_tuya(resp: reqwest::Response) -> Result<Value, String> {
    let j: Value = resp.json().await.map_err(|e| format!("bad tuya response: {e}"))?;
    if j["success"].as_bool() != Some(true) {
        return Err(format!(
            "tuya {}: {}",
            j["code"].as_i64().unwrap_or(0),
            j["msg"].as_str().unwrap_or("unknown error")
        ));
    }
    Ok(j["result"].clone())
}

async fn get_token(
    state: &State<'_, TuyaState>,
    creds: &TuyaCreds,
) -> Result<String, String> {
    if let Some((tok, exp)) = state.0.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        if now_ms() < exp {
            return Ok(tok);
        }
    }
    const PATH: &str = "/v1.0/token?grant_type=1";
    let t = now_ms().to_string();
    let str_to_sign = format!("GET\n{}\n\n{}", sha256_hex(""), PATH);
    let s = sign(&creds.secret, &format!("{}{}{}", creds.client_id, t, str_to_sign));
    let resp = client()
        .get(format!("{}{}", creds.base(), PATH))
        .header("client_id", &creds.client_id)
        .header("t", &t)
        .header("sign_method", "HMAC-SHA256")
        .header("sign", &s)
        .send()
        .await
        .map_err(|e| format!("tuya unreachable: {e}"))?;
    let r = unwrap_tuya(resp).await?;
    let tok = r["access_token"]
        .as_str()
        .ok_or("tuya token missing")?
        .to_string();
    let ttl = r["expire_time"].as_u64().unwrap_or(7200);
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((tok.clone(), now_ms() + (ttl.saturating_sub(300)) * 1000));
    Ok(tok)
}

// signed general request; path must already carry its query string
async fn api(
    state: &State<'_, TuyaState>,
    creds: &TuyaCreds,
    method: reqwest::Method,
    path_qs: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let tok = get_token(state, creds).await?;
    let body_str = body.map(|b| b.to_string()).unwrap_or_default();
    let t = now_ms().to_string();
    let str_to_sign = format!(
        "{}\n{}\n\n{}",
        method.as_str(),
        sha256_hex(&body_str),
        path_qs
    );
    let s = sign(
        &creds.secret,
        &format!("{}{}{}{}", creds.client_id, tok, t, str_to_sign),
    );
    let mut req = client()
        .request(method, format!("{}{}", creds.base(), path_qs))
        .header("client_id", &creds.client_id)
        .header("access_token", &tok)
        .header("t", &t)
        .header("sign_method", "HMAC-SHA256")
        .header("sign", &s);
    if body.is_some() {
        req = req.header("Content-Type", "application/json").body(body_str);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("tuya unreachable: {e}"))?;
    unwrap_tuya(resp).await
}

#[derive(Serialize)]
pub struct TuyaLight {
    pub id: String,
    pub name: String,
    pub category: String,
    pub online: bool,
    // [{code, value}] — doubles as capability detection (v2 vs v1 dp codes)
    pub status: Value,
}

#[tauri::command]
pub async fn tuya_lights(
    state: State<'_, TuyaState>,
    creds: TuyaCreds,
) -> Result<Vec<TuyaLight>, String> {
    let r = api(
        &state,
        &creds,
        reqwest::Method::GET,
        &format!("/v1.0/users/{}/devices", creds.uid),
        None,
    )
    .await?;
    let mut lights = Vec::new();
    for d in r.as_array().cloned().unwrap_or_default() {
        // light-ish categories: dj bulb/ceiling, dd strip, fwd? keep broad set;
        // unknown categories still pass through if the name mentions light/lamp
        let cat = d["category"].as_str().unwrap_or("").to_string();
        let name = d["name"].as_str().unwrap_or("").to_lowercase();
        let lightish = matches!(cat.as_str(), "dj" | "dd" | "fwd" | "tgq" | "hxd")
            || name.contains("light")
            || name.contains("lamp")
            || name.contains("licht")
            || name.contains("lampe");
        if !cat.is_empty() && !lightish {
            continue;
        }
        lights.push(TuyaLight {
            id: d["id"].as_str().unwrap_or("").to_string(),
            name: d["name"].as_str().unwrap_or("").to_string(),
            category: cat,
            online: d["online"].as_bool().unwrap_or(false),
            status: d["status"].clone(),
        });
    }
    Ok(lights)
}

#[tauri::command]
pub async fn tuya_send(
    state: State<'_, TuyaState>,
    creds: TuyaCreds,
    device_id: String,
    commands: Vec<(String, Value)>,
) -> Result<(), String> {
    let cmds: Vec<Value> = commands
        .iter()
        .map(|(c, v)| serde_json::json!({"code": c, "value": v}))
        .collect();
    api(
        &state,
        &creds,
        reqwest::Method::POST,
        &format!("/v1.0/iot-03/devices/{device_id}/commands"),
        Some(&serde_json::json!({ "commands": cmds })),
    )
    .await?;
    Ok(())
}
