use std::sync::{Mutex, atomic::{AtomicU64, Ordering}};
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalSize, State, Url, Webview,
    WebviewUrl, WebviewBuilder, WebviewWindow, Wry,
};

pub struct Browser {
    webview: Webview<Wry>,
    top: f64,
    hist: Vec<String>,
    idx: usize,
    gen: u64,
}

#[derive(Default)]
pub struct BrowserState(pub Mutex<Option<Browser>>);

pub struct FloatingBrowser {
    webview: Webview<Wry>,
    rect: (f64, f64, f64, f64), // x,y,w,h logical
    gen: u64,
}

#[derive(Default)]
pub struct FloatingState(pub Mutex<Option<FloatingBrowser>>);

static GEN: AtomicU64 = AtomicU64::new(0);
static FLOAT_GEN: AtomicU64 = AtomicU64::new(0);

// TikTok-only allowlist — host must be tiktok.com or subdomain, plus cdn for assets
fn tiktok_allowed(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    host == "tiktok.com" || host.ends_with(".tiktok.com")
        || host == "tiktokcdn.com" || host.ends_with(".tiktokcdn.com")
        || host == "musical.ly" || host.ends_with(".musical.ly")
}
fn is_tiktok_url(s: &str) -> bool {
    s.parse::<Url>().map(|u| tiktok_allowed(&u)).unwrap_or(false)
}

// LOCK DISCIPLINE: every command here is async (sync commands run on the
// MAIN thread, and add_child/navigate/close block waiting on it — holding
// either while the other waits deadlocked the whole app). The mutex only
// ever guards plain data: clone the Webview handle / read fields under a
// short lock, drop it, THEN call into the webview.
//
// One history rule for every observed URL: same as current entry → no-op,
// matches another entry (incl. native mouse4/5 back-forward inside the
// child) → jump there, else truncate forward and push. Keeps our stack in
// sync with WebView2's own history without navigation callbacks.
fn classify(b: &mut Browser, url: &str) -> (bool, bool) {
    if b.hist.get(b.idx).map(String::as_str) == Some(url) {
        return (b.idx > 0, b.idx + 1 < b.hist.len());
    }
    match b.hist.iter().position(|u| u == url) {
        Some(k) => {
            b.idx = k;
            (b.idx > 0, b.idx + 1 < b.hist.len())
        }
        None => {
            b.hist.truncate(b.idx + 1);
            b.hist.push(url.to_string());
            b.idx = b.hist.len() - 1;
            (b.idx > 0, false)
        }
    }
}

fn spawn_poll(app: AppHandle, gen: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(400));
        let wv = {
            let state = app.state::<BrowserState>();
            let Ok(mut guard) = state.0.lock() else { return };
            let Some(b) = guard.as_mut() else { return };
            if b.gen != gen {
                return;
            }
            b.webview.clone()
        };
        let Ok(url) = wv.url() else { continue };
        let s = url.to_string();
        let payload = {
            let state = app.state::<BrowserState>();
            let Ok(mut guard) = state.0.lock() else { continue };
            let Some(b) = guard.as_mut() else { continue };
            if b.gen != gen {
                return;
            }
            let (can_back, can_fwd) = classify(b, &s);
            serde_json::json!({ "url": s, "canBack": can_back, "canFwd": can_fwd })
        };
        let _ = app.emit("browser://nav", payload);
    });
}

fn parse_http(url: &str) -> Result<Url, String> {
    let parsed: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("only http(s) urls are supported".into()),
    }
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    window: WebviewWindow<Wry>,
    state: State<'_, BrowserState>,
    url: String,
    top: f64,
) -> Result<(), String> {
    let parsed = parse_http(&url)?;

    // already browsing — follow the link in place
    let existing = state.0.lock().unwrap().as_ref().map(|b| b.webview.clone());
    if let Some(wv) = existing {
        let s = parsed.to_string();
        wv.navigate(parsed).map_err(|e| e.to_string())?;
        if let Some(b) = state.0.lock().unwrap().as_mut() {
            b.hist.truncate(b.idx + 1);
            b.hist.push(s);
            b.idx = b.hist.len() - 1;
        }
        return Ok(());
    }

    // create — must NOT hold the lock across add_child
    let win = window.as_ref().window();
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let size = win
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    if size.height <= top + 40.0 {
        return Err("window too small".into());
    }

    let gen = GEN.fetch_add(1, Ordering::Relaxed);
    let webview = win
        .add_child(
            WebviewBuilder::new("browser", WebviewUrl::External(parsed.clone())).incognito(true),
            LogicalPosition::new(0.0, top),
            LogicalSize::new(size.width, size.height - top),
        )
        .map_err(|e| e.to_string())?;

    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        // lost a race with another opener — keep theirs, drop ours
        drop(guard);
        let _ = webview.close();
        return Ok(());
    }
    *guard = Some(Browser {
        webview,
        top,
        hist: vec![parsed.to_string()],
        idx: 0,
        gen,
    });
    drop(guard);
    spawn_poll(app.clone(), gen);
    Ok(())
}

#[tauri::command]
pub async fn browser_back(state: State<'_, BrowserState>) -> Result<(), String> {
    step(&state, -1)
}

#[tauri::command]
pub async fn browser_forward(state: State<'_, BrowserState>) -> Result<(), String> {
    step(&state, 1)
}

fn step(state: &State<'_, BrowserState>, dir: i32) -> Result<(), String> {
    let (wv, target) = {
        let mut guard = state.0.lock().unwrap();
        let Some(b) = guard.as_mut() else { return Ok(()) };
        let idx = b.idx as i64 + dir as i64;
        if idx < 0 || idx as usize >= b.hist.len() {
            return Ok(());
        }
        b.idx = idx as usize;
        (b.webview.clone(), b.hist[b.idx].clone())
    };
    let parsed: Url = target.parse().map_err(|e| format!("{e}"))?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_navigate(state: State<'_, BrowserState>, url: String) -> Result<(), String> {
    let parsed = parse_http(&url)?;
    let (wv, existing) = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(b) => (b.webview.clone(), true),
            None => return Ok(()),
        }
    };
    let s = parsed.to_string();
    wv.navigate(parsed).map_err(|e| e.to_string())?;
    if existing {
        if let Some(b) = state.0.lock().unwrap().as_mut() {
            b.hist.truncate(b.idx + 1);
            b.hist.push(s);
            b.idx = b.hist.len() - 1;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_reload(state: State<'_, BrowserState>) -> Result<(), String> {
    let wv = {
        let guard = state.0.lock().unwrap();
        guard.as_ref().map(|b| (b.webview.clone(), b.hist[b.idx].clone()))
    };
    if let Some((wv, target)) = wv {
        let parsed: Url = target.parse().map_err(|e| format!("{e}"))?;
        wv.navigate(parsed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_close(state: State<'_, BrowserState>) -> Result<(), String> {
    let wv = state.0.lock().unwrap().take().map(|b| b.webview);
    if let Some(wv) = wv {
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    parse_http(&url)?;
    #[cfg(windows)]
    {
        // `cmd /c start` needs careful quoting for `&` in query strings, and
        // `explorer` opens File Explorer on some setups. `rundll32` delegates
        // to the shell's FileProtocolHandler which opens the default browser
        // and passes the full URL (including `&`) as a single argument.
        // Fall back to PowerShell `Start-Process` if rundll32 is unavailable.
        let r = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn();
        if r.is_err() {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", &format!("Start-Process \"{}\"", url.replace('"', "\"\""))])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- voice app launcher: "launch google chrome" ----------

#[cfg(windows)]
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// lowercase alphanumerics only — comparison key immune to spacing/punctuation
// differences between the Start Menu label and a whisper transcript
fn norm_app(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn collect_lnks(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>, depth: u32) {
    if depth > 6 {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_lnks(&p, out, depth + 1);
        } else if p.extension().and_then(|x| x.to_str()) == Some("lnk") {
            out.push(p);
        }
    }
}

// does every word of `cand` appear somewhere in the app name?
fn words_contained(cand: &[String], stem: &str) -> bool {
    cand.iter()
        .all(|w| stem.to_lowercase().contains(w.as_str()))
}

// launch an installed app by spoken phrase: scan Start Menu .lnk files and
// try progressively shorter prefixes of the phrase (longest-first), scoring
// exact > prefix > all-words-contained; fall back to PATH for bare exes.
// Returns the resolved display name so the UI can speak it.
//
// ponytail: rescans Start Menu on every call (hundreds of files, single-digit
// ms) and skips the App Paths registry check — add a cache / reg query if a
// missing app ever bites.
#[tauri::command]
pub async fn open_app(name: String) -> Result<String, String> {
    let phrase = name.trim().to_string();
    if phrase.is_empty()
        || phrase.len() > 64
        || !phrase
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_'))
    {
        return Err("bad app name".into());
    }

    // prefix candidates longest-first: "visual studio code" → … → "visual"
    let words: Vec<String> = phrase.split_whitespace().map(String::from).collect();

    let mut lnks = Vec::new();
    for root in [
        std::env::var("ProgramData").ok(),
        std::env::var("APPDATA").ok(),
    ]
    .into_iter()
    .flatten()
    {
        collect_lnks(
            std::path::Path::new(&root)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .as_path(),
            &mut lnks,
            0,
        );
    }

    let mut best: Option<(u8, String)> = None; // (score, display stem)
    for n in (1..=words.len()).rev() {
        let cand_words = &words[..n];
        let cand = norm_app(&cand_words.join(""));
        if cand.is_empty() {
            continue;
        }
        for p in &lnks {
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let ns = norm_app(&stem);
            let score = if ns == cand {
                3
            } else if ns.starts_with(&cand) {
                2
            } else if words_contained(cand_words, &stem) {
                1
            } else {
                continue;
            };
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, stem));
                if score == 3 {
                    break;
                }
            }
        }
        if best.as_ref().map(|(s, _)| *s == 3).unwrap_or(false) {
            break;
        }
    }

    if let Some((_, stem)) = best {
        let path = lnks
            .iter()
            .find(|p| {
                p.file_stem().and_then(|s| s.to_str()) == Some(stem.as_str())
            })
            .ok_or("match lost")?;
        launch_detached(&path.to_string_lossy())?;
        return Ok(stem);
    }

    // no Start Menu hit: try PATH for bare executables ("notepad", "code")
    for n in (1..=words.len()).rev() {
        let exe = format!("{}.exe", words[..n].join("-"));
        let output = Command::new("where")
            .arg(&exe)
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(o) = output {
            if o.status.success() {
                let full = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !full.is_empty() {
                    launch_detached(&full)?;
                    return Ok(exe.trim_end_matches(".exe").replace('-', " "));
                }
            }
        }
    }

    Err(format!("no app found for '{phrase}'"))
}

fn launch_detached(target: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/c", "start", "", target])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch: {e}"))
}

// same charset guard as open_app
fn sane_phrase(phrase: &str) -> bool {
    !phrase.is_empty()
        && phrase.len() <= 64
        && phrase
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_'))
}

// escape a spoken word for use as a PowerShell -match regex literal
fn regex_esc(w: &str) -> String {
    w.chars()
        .flat_map(|c| {
            if "\\.^$|?*+()[]{}".contains(c) {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}

// close ("quit"), minimize, or force-kill the app behind a spoken phrase:
// match PROCESS names (not window titles — those are locale/document
// dependent), trying the longest prefix of the spoken words first so
// "visual studio code" lands on the "Code" process via its last word.
// Only processes that actually own a window are touched. CloseMainWindow
// asks nicely (WM_CLOSE); minimize is ShowWindow(SW_MINIMIZE); kill
// resolves the process name then taskkill /F's everything under it.
// Returns the matched process name for the UI to speak.
//
// ponytail: shells PowerShell instead of a Win32 EnumWindows dependency —
// a few hundred ms per call is fine for voice; swap for the windows crate
// if it ever feels slow.
#[tauri::command]
pub async fn window_app(name: String, action: String) -> Result<String, String> {
    let phrase = name.trim().to_string();
    if !sane_phrase(&phrase) {
        return Err("bad app name".into());
    }
    let minimize = match action.as_str() {
        "close" => false,
        "minimize" => true,
        "kill" => false,
        _ => return Err("bad action".into()),
    };
    // longest-prefix-first candidates: every word AND-ed into one lookahead
    // regex ("-match" is case-insensitive); quotes stripped up front
    let words: Vec<String> = phrase.split_whitespace().map(String::from).collect();
    let pats: Vec<String> = (1..=words.len())
        .rev()
        .map(|n| {
            words[..n]
                .iter()
                .map(|w| format!("(?=.*{})", regex_esc(w)))
                .collect()
        })
        .collect();
    let ps_pats = pats
        .iter()
        .map(|p| format!("'{}'", p.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let add_type = if minimize {
        "if(-not('U.W' -as [type])){Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int c);' -Name W -Namespace U};"
    } else {
        ""
    };
    // close/minimize act per window; kill goes through taskkill so hidden
    // child processes die too
    let act = if action == "kill" {
        "$ps|Select-Object -Unique -ExpandProperty ProcessName|ForEach-Object{& taskkill /F /IM ($_+'.exe')|Out-Null}".to_string()
    } else if minimize {
        "foreach($p in $ps){[void][U.W]::ShowWindow($p.MainWindowHandle,6)}".to_string()
    } else {
        "foreach($p in $ps){[void]$p.CloseMainWindow()}".to_string()
    };
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue';{add_type}$ps=$null;foreach($pat in @({ps_pats})){{$ps=Get-Process|Where-Object{{$_.MainWindowHandle -ne 0 -and $_.ProcessName -match $pat}};if($ps){{break}}}};{act};if($ps){{Write-Output $ps[0].ProcessName}}"
    );
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("shell failed: {e}"))?;
    let proc_name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if proc_name.is_empty() {
        Err(format!("no app found for '{phrase}'"))
    } else {
        Ok(proc_name)
    }
}

// ----------- TikTok floating webview (persistent, tiktok-only) -----------
const TIKTOK_GLASS_CSS: &str = r#"
html, body, #app, #root { background: rgba(12,17,22,0.28) !important; background-color: rgba(12,17,22,0.28) !important; }
body > div, #app > div, main, [data-e2e="app"] { background: transparent !important; }
/* header / nav glass — matches app titlebar rgba(20,28,35,.14) + blur 14px */
header, [data-e2e="header"], div[class*="HeaderContainer"], div[class*="DivHeaderContainer"], nav {
  background: rgba(20,28,35,0.14) !important;
  background-color: rgba(20,28,35,0.14) !important;
  backdrop-filter: blur(14px) !important;
  -webkit-backdrop-filter: blur(14px) !important;
  border-bottom: 1px solid rgba(127,212,212,0.12) !important;
}
/* feed / main containers transparent so glass shows through */
main, div[class*="MainContainer"], div[class*="DivMainContainer"], div[class*="FeedContainer"], div[class*="DivFeedContainer"], div[class*="ContentContainer"] {
  background: transparent !important;
  background-color: transparent !important;
}
/* sidebars transparent */
aside, div[class*="Sidebar"], div[class*="DivSidebar"] { background: transparent !important; }
/* cards keep subtle surface so videos pop — not full opaque */
div[class*="DivVideoCard"], div[class*="VideoCard"], article { background: rgba(20,28,35,0.08) !important; border-radius: 8px !important; }
/* video itself stays opaque with glow */
video { background: #000 !important; border-radius: 8px !important; box-shadow: 0 8px 24px rgba(0,0,0,0.45) !important; }
/* scrollbars square + accent tint like app */
* { scrollbar-width: thin; scrollbar-color: rgba(127,212,212,0.45) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-thumb { background: rgba(127,212,212,0.35); border-radius: 0; }
*::-webkit-scrollbar-thumb:hover { background: rgba(127,212,212,0.55); box-shadow: 0 0 6px rgba(127,212,212,0.4); }
*::-webkit-scrollbar-track { background: transparent; }
"#;

const TIKTOK_GLASS_INIT_JS: &str = r#"(function(){
  const ID='oc-tiktok-glass';
  const CSS=`__CSS__`;
  function inject(){
    if(document.getElementById(ID)) return;
    const s=document.createElement('style');
    s.id=ID;
    s.textContent=CSS;
    (document.head||document.documentElement).appendChild(s);
  }
  function remove(){ const el=document.getElementById(ID); if(el) el.remove(); }
  window.__ocTiktokGlass = (on)=> on ? inject() : remove();
  // auto-inject (almost transparent glass by default)
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
  try{ new MutationObserver(()=>{ if(!document.getElementById(ID) && document.body) inject(); }).observe(document.documentElement,{childList:true,subtree:true}); }catch(e){}
})();"#;

fn spawn_floating_poll(app: AppHandle, gen: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let wv = {
            let state = app.state::<FloatingState>();
            let Ok(guard) = state.0.lock() else { return };
            let Some(b) = guard.as_ref() else { return };
            if b.gen != gen { return; }
            b.webview.clone()
        };
        let Ok(url) = wv.url() else { continue };
        let s = url.to_string();
        // if navigation escaped tiktok, snap back to tiktok.com
        if !is_tiktok_url(&s) {
            if let Ok(fallback) = "https://www.tiktok.com".parse::<Url>() {
                let _ = wv.navigate(fallback);
            }
            let _ = app.emit("tiktok://blocked", serde_json::json!({ "url": s }));
            continue;
        }
        let _ = app.emit("tiktok://nav", serde_json::json!({ "url": s }));
    });
}

#[tauri::command]
pub async fn tiktok_open(
    app: AppHandle,
    window: WebviewWindow<Wry>,
    state: State<'_, FloatingState>,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let parsed = parse_http(&url)?;
    if !tiktok_allowed(&parsed) {
        return Err("only tiktok.com urls are allowed".into());
    }
    // already open — just navigate + move
    let existing = state.0.lock().unwrap().as_ref().map(|b| b.webview.clone());
    if let Some(wv) = existing {
        wv.navigate(parsed).map_err(|e| e.to_string())?;
        let _ = wv.set_bounds(tauri::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(w, h).into(),
        });
        if let Some(b) = state.0.lock().unwrap().as_mut() {
            b.rect = (x, y, w, h);
        }
        return Ok(());
    }
    let win = window.as_ref().window();
    let gen = FLOAT_GEN.fetch_add(1, Ordering::Relaxed);
    // persistent session (not incognito) so TikTok login survives restarts
    // glass: make webview transparent so injected rgba shows app's mica/acrylic behind
    let init_js = TIKTOK_GLASS_INIT_JS.replace("__CSS__", &TIKTOK_GLASS_CSS.replace('`', "'").replace('\\', "\\\\"));
    let webview = win
        .add_child(
            WebviewBuilder::new("tiktok", WebviewUrl::External(parsed.clone()))
                .transparent(true)
                .initialization_script(init_js),
            LogicalPosition::new(x, y),
            LogicalSize::new(w, h),
        )
        .map_err(|e| e.to_string())?;
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        drop(guard);
        let _ = webview.close();
        return Ok(());
    }
    *guard = Some(FloatingBrowser { webview, rect: (x, y, w, h), gen });
    drop(guard);
    spawn_floating_poll(app.clone(), gen);
    Ok(())
}

#[tauri::command]
pub async fn tiktok_close(state: State<'_, FloatingState>) -> Result<(), String> {
    let wv = state.0.lock().unwrap().take().map(|b| b.webview);
    if let Some(wv) = wv {
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn tiktok_set_bounds(
    state: State<'_, FloatingState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let wv = {
        let mut guard = state.0.lock().unwrap();
        let Some(b) = guard.as_mut() else { return Ok(()) };
        b.rect = (x, y, w, h);
        b.webview.clone()
    };
    wv.set_bounds(tauri::Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(w, h).into(),
    }).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tiktok_set_glass(state: State<'_, FloatingState>, enabled: bool) -> Result<(), String> {
    let wv = {
        let guard = state.0.lock().unwrap();
        guard.as_ref().map(|b| b.webview.clone())
    };
    if let Some(wv) = wv {
        let js = if enabled {
            // re-inject (idempotent)
            format!(
                "window.__ocTiktokGlass ? window.__ocTiktokGlass(true) : (()=>{{ const s=document.createElement('style'); s.id='oc-tiktok-glass'; s.textContent=`{}`; (document.head||document.documentElement).appendChild(s); }})()",
                TIKTOK_GLASS_CSS.replace('`', "'").replace('\\', "\\\\").replace('\n', " ")
            )
        } else {
            "window.__ocTiktokGlass ? window.__ocTiktokGlass(false) : document.getElementById('oc-tiktok-glass')?.remove()".to_string()
        };
        wv.eval(js).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn tiktok_navigate(state: State<'_, FloatingState>, url: String) -> Result<(), String> {
    let parsed = parse_http(&url)?;
    if !tiktok_allowed(&parsed) {
        return Err("only tiktok.com urls are allowed".into());
    }
    let wv = {
        let guard = state.0.lock().unwrap();
        guard.as_ref().map(|b| b.webview.clone())
    };
    if let Some(wv) = wv {
        wv.navigate(parsed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// re-fit the child webview under the browser bar whenever the main window
// changes size (also fires on minimize/restore — bounds of 0 are harmless).
// Runs on the MAIN thread — clone-then-act keeps this deadlock-free against
// commands that hold nothing while calling into the webview.
pub fn on_main_resize(app: &AppHandle, size: PhysicalSize<u32>) {
    let handle = {
        let state = app.state::<BrowserState>();
        let Ok(guard) = state.0.lock() else { return };
        guard.as_ref().map(|b| (b.webview.clone(), b.top))
    };
    let Some((wv, top)) = handle else { return };
    let Some(win) = app.get_window("main") else { return };
    let Ok(scale) = win.scale_factor() else { return };
    let s = size.to_logical::<f64>(scale);
    let _ = wv.set_bounds(tauri::Rect {
        position: LogicalPosition::new(0.0, top).into(),
        size: LogicalSize::new(s.width, (s.height - top).max(0.0)).into(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // the window_app scripts rely on $vars and 'quoted' strings surviving
    // Command::new → powershell.exe arg passing; this runs the same shape of
    // script for real so quoting regressions fail loudly here, not in voice
    #[test]
    fn ps_quoting_survives_command_invocation() {
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='SilentlyContinue';$ps=Get-Process|Where-Object{$_.MainWindowHandle -ne 0};if($ps){Write-Output $ps[0].ProcessName}else{Write-Output 'none'}"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .unwrap();
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert!(!s.is_empty(), "stdout empty, stderr: {}", String::from_utf8_lossy(&out.stderr));
    }
}
