// Windows shell discovery — probes, WSL distros, Windows Terminal profiles.
// No new deps: where.exe + wsl --list + winreg + serde_json (already present). Windows-only.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug)]
pub struct TerminalProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "args")]
    pub args: Vec<String>,
    pub source: String, // probe | wsl | wt | custom (custom handled frontend-side)
    pub kind: String,   // powershell | pwsh | cmd | gitbash | wsl | wt
}

fn where_lookup(exe: &str) -> Option<String> {
    let out = std::process::Command::new("where")
        .arg(exe)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    let first = txt.lines().map(|l| l.trim()).find(|l| !l.is_empty())?;
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

fn file_exists(path: &str) -> bool {
    Path::new(path).exists()
}

fn slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn expand_env(s: &str) -> String {
    // expand %VAR% on Windows
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let mut var = String::new();
            while let Some(&nc) = chars.peek() {
                chars.next();
                if nc == '%' {
                    break;
                }
                var.push(nc);
            }
            if !var.is_empty() {
                if let Ok(val) = std::env::var(&var) {
                    out.push_str(&val);
                    continue;
                } else if let Ok(val) = std::env::var(var.to_uppercase()) {
                    out.push_str(&val);
                    continue;
                }
                // unknown var — keep original
                out.push('%');
                out.push_str(&var);
                out.push('%');
            } else {
                out.push('%');
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_commandline(cmdline: &str) -> (String, Vec<String>) {
    let expanded = expand_env(cmdline.trim());
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    for ch in expanded.chars() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
            }
            '"' if !in_single => {
                in_double = !in_double;
            }
            ' ' | '\t' if !in_single && !in_double => {
                if !cur.is_empty() {
                    parts.push(cur.clone());
                    cur.clear();
                }
            }
            _ => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    if parts.is_empty() {
        return (String::new(), Vec::new());
    }
    let path = parts.remove(0);
    (path, parts)
}

fn probe_shells(out: &mut Vec<TerminalProfile>) {
    // PowerShell (Windows PowerShell 5.x)
    if let Some(p) = where_lookup("powershell.exe") {
        out.push(TerminalProfile {
            id: "probe-powershell".into(),
            name: "PowerShell".into(),
            path: p,
            args: vec![],
            source: "probe".into(),
            kind: "powershell".into(),
        });
    } else if file_exists("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") {
        out.push(TerminalProfile {
            id: "probe-powershell".into(),
            name: "PowerShell".into(),
            path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe".into(),
            args: vec![],
            source: "probe".into(),
            kind: "powershell".into(),
        });
    } else {
        // fallback bare name — let ConPTY resolve via PATH
        out.push(TerminalProfile {
            id: "probe-powershell".into(),
            name: "PowerShell".into(),
            path: "powershell.exe".into(),
            args: vec![],
            source: "probe".into(),
            kind: "powershell".into(),
        });
    }

    // PowerShell 7 (pwsh)
    if let Some(p) = where_lookup("pwsh.exe") {
        out.push(TerminalProfile {
            id: "probe-pwsh".into(),
            name: "PowerShell 7 (pwsh)".into(),
            path: p,
            args: vec![],
            source: "probe".into(),
            kind: "pwsh".into(),
        });
    } else {
        // check common install locations before omitting
        for cand in [
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe",
        ] {
            if file_exists(cand) {
                out.push(TerminalProfile {
                    id: "probe-pwsh".into(),
                    name: "PowerShell 7 (pwsh)".into(),
                    path: cand.into(),
                    args: vec![],
                    source: "probe".into(),
                    kind: "pwsh".into(),
                });
                break;
            }
        }
    }

    // Command Prompt
    let cmd_path = std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
    if let Some(p) = where_lookup("cmd.exe") {
        out.push(TerminalProfile {
            id: "probe-cmd".into(),
            name: "Command Prompt".into(),
            path: p,
            args: vec![],
            source: "probe".into(),
            kind: "cmd".into(),
        });
    } else if file_exists(&cmd_path) {
        out.push(TerminalProfile {
            id: "probe-cmd".into(),
            name: "Command Prompt".into(),
            path: cmd_path,
            args: vec![],
            source: "probe".into(),
            kind: "cmd".into(),
        });
    } else {
        out.push(TerminalProfile {
            id: "probe-cmd".into(),
            name: "Command Prompt".into(),
            path: "cmd.exe".into(),
            args: vec![],
            source: "probe".into(),
            kind: "cmd".into(),
        });
    }

    // Git Bash / bash.exe
    let mut bash_found = false;
    if let Some(p) = where_lookup("bash.exe") {
        let name = if p.to_lowercase().contains("git") { "Git Bash" } else { "Bash" };
        out.push(TerminalProfile {
            id: "probe-gitbash".into(),
            name: name.into(),
            path: p,
            args: vec![],
            source: "probe".into(),
            kind: "gitbash".into(),
        });
        bash_found = true;
    }
    if !bash_found {
        for cand in [
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
            "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        ] {
            if file_exists(cand) {
                out.push(TerminalProfile {
                    id: "probe-gitbash".into(),
                    name: "Git Bash".into(),
                    path: cand.into(),
                    args: vec![],
                    source: "probe".into(),
                    kind: "gitbash".into(),
                });
                bash_found = true;
                break;
            }
        }
        // scoop shim
        if !bash_found {
            if let Ok(home) = std::env::var("USERPROFILE") {
                let scoop = PathBuf::from(home).join("scoop").join("shims").join("bash.exe");
                if scoop.exists() {
                    out.push(TerminalProfile {
                        id: "probe-gitbash".into(),
                        name: "Git Bash".into(),
                        path: scoop.to_string_lossy().into_owned(),
                        args: vec![],
                        source: "probe".into(),
                        kind: "gitbash".into(),
                    });
                }
            }
        }
    }
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    // BOM UTF-16LE
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    // Heuristic: heavy null bytes => UTF-16LE without BOM (wsl often does this)
    let nulls = bytes.iter().filter(|&&b| b == 0).count();
    if nulls > bytes.len() / 4 {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .filter_map(|c| {
                if c.len() == 2 {
                    let v = u16::from_le_bytes([c[0], c[1]]);
                    if v != 0 { Some(v) } else { None }
                } else {
                    None
                }
            })
            .collect();
        if !u16s.is_empty() {
            let s = String::from_utf16_lossy(&u16s);
            if s.chars().any(|c| c.is_ascii_alphabetic()) {
                return s;
            }
        }
        // fallback: strip nulls and treat as utf8
        let stripped: Vec<u8> = bytes.iter().copied().filter(|&b| b != 0).collect();
        return String::from_utf8_lossy(&stripped).to_string();
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn wsl_available() -> bool {
    if where_lookup("wsl.exe").is_some() { return true; }
    if file_exists("C:\\Windows\\System32\\wsl.exe") { return true; }
    if file_exists("C:\\Windows\\Sysnative\\wsl.exe") { return true; }
    false
}

fn wsl_distros(out: &mut Vec<TerminalProfile>) {
    let mut names: Vec<String> = Vec::new();
    let mut saw_no_distro = false;

    // helper to run wsl with args, handling CREATE_NO_WINDOW, UTF-16 and Sysnative fallback (32-bit WoW64)
    let run_wsl = |args: &[&str]| -> Option<String> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut candidates: Vec<String> = Vec::new();
            if let Some(p) = where_lookup("wsl.exe") { candidates.push(p); }
            candidates.push("wsl.exe".to_string());
            candidates.push("C:\\Windows\\System32\\wsl.exe".to_string());
            candidates.push("C:\\Windows\\Sysnative\\wsl.exe".to_string());
            for cand in candidates {
                let out = match std::process::Command::new(&cand)
                    .args(args)
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                {
                    Ok(o) => o,
                    Err(_) => continue,
                };
                let mut combined = decode_wsl_output(&out.stdout);
                if combined.trim().is_empty() {
                    combined = decode_wsl_output(&out.stderr);
                } else {
                    let err = decode_wsl_output(&out.stderr);
                    if !err.trim().is_empty() {
                        combined.push('\n');
                        combined.push_str(&err);
                    }
                }
                if out.status.success() || !combined.trim().is_empty() {
                    return Some(combined);
                }
                // non-empty status with empty output — try next candidate
            }
            None
        }
        #[cfg(not(windows))]
        {
            let out = std::process::Command::new("wsl.exe").args(args).output().ok()?;
            let mut combined = decode_wsl_output(&out.stdout);
            if combined.trim().is_empty() {
                combined = decode_wsl_output(&out.stderr);
            }
            Some(combined)
        }
    };

    // 1) quiet lists — cleanest, one name per line, no header
    for args in [
        &["--list", "--quiet"] as &[&str],
        &["-l", "-q"] as &[&str],
        &["--list", "-q"] as &[&str],
    ] {
        if !names.is_empty() { break; }
        if let Some(combined) = run_wsl(args) {
            let low_comb = combined.to_lowercase();
            if low_comb.contains("no installed") || low_comb.contains("is not installed") || low_comb.contains("no distribution") {
                saw_no_distro = true;
            }
            for line in combined.lines() {
                let t = line.trim();
                if t.is_empty() { continue; }
                // quiet still may echo the Windows header on some builds — skip it
                if t.to_lowercase().contains("windows subsystem") { continue; }
                if t.contains("---") { continue; }
                let without_star = if t.starts_with('*') { t[1..].trim() } else { t };
                if without_star.is_empty() { continue; }
                // quiet: whole line is the name (may include spaces? take as-is, trimmed)
                let name = without_star.trim().to_string();
                if name.is_empty() || name.eq_ignore_ascii_case("name") { continue; }
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            // quiet should have given us all; if we got something, keep it
            if !names.is_empty() {
                // successfully parsed quiet, break out of quiet attempts
                break;
            }
        }
    }

    // 2) verbose table — skip first non-empty line (localized header), then first column is name
    if names.is_empty() {
        for args in [&["--list", "--verbose"] as &[&str], &["-l", "-v"] as &[&str]] {
            if let Some(combined) = run_wsl(args) {
                let low_comb = combined.to_lowercase();
                if low_comb.contains("no installed") || low_comb.contains("is not installed") || low_comb.contains("no distribution") {
                    saw_no_distro = true;
                }
                let mut lines = combined.lines().filter(|l| !l.trim().is_empty()).peekable();
                // skip header: first non-empty line is table header regardless of language
                if lines.peek().is_some() {
                    lines.next();
                }
                for line in lines {
                    let trimmed = line.trim();
                    if trimmed.is_empty() { continue; }
                    if trimmed.to_lowercase().contains("windows subsystem") { continue; }
                    if trimmed.contains("---") { continue; }
                    let without_star = if trimmed.starts_with('*') { trimmed[1..].trim() } else { trimmed };
                    if without_star.is_empty() { continue; }
                    let name = without_star.split_whitespace().next().unwrap_or("").trim();
                    if name.is_empty() || name == "-" { continue; }
                    if name.eq_ignore_ascii_case("running") || name.eq_ignore_ascii_case("stopped") || name.eq_ignore_ascii_case("installing") { continue; }
                    if !names.contains(&name.to_string()) {
                        names.push(name.to_string());
                    }
                }
                if !names.is_empty() { break; }
            }
        }
    }

    // 3) plain --list (with header)
    if names.is_empty() {
        if let Some(combined) = run_wsl(&["--list"]) {
            let low_comb = combined.to_lowercase();
            if low_comb.contains("no installed") || low_comb.contains("is not installed") || low_comb.contains("no distribution") {
                saw_no_distro = true;
            }
            for line in combined.lines() {
                let t = line.trim();
                if t.is_empty() { continue; }
                if t.to_lowercase().contains("windows subsystem") { continue; }
                if t.contains("---") { continue; }
                // plain list may have first line header "NAME" or localized; skip if it looks like header (contains multiple columns? but plain has just names)
                // We'll treat any line that after stripping "*" is empty or equals header-like, skip
                let without_star = if t.starts_with('*') { t[1..].trim() } else { t };
                // if line has two+ tokens and second token is a known state, it's likely verbose header that slipped through — skip
                let tokens: Vec<&str> = without_star.split_whitespace().collect();
                if tokens.is_empty() { continue; }
                // header heuristic: if first token is localized "NAME" translation, second token would be "STATE" translation — but we already skipped verbose; for plain, header is not present; but just in case, skip lines that look like header by checking if they contain "STATE" etc. Without locale we instead skip the very first line if we haven't yet collected names and it looks like it could be header? Keep simple: skip if line is single token "NAME" etc.
                // Instead, just take first token as distro name
                let name = tokens[0].trim();
                if name.is_empty() || name.eq_ignore_ascii_case("name") { continue; }
                if !names.contains(&name.to_string()) {
                    names.push(name.to_string());
                }
            }
            // plain --list's first line might be header in some locales — if we got exactly the header, remove it
            if names.len() == 1 && names[0].to_lowercase() == "name" {
                names.clear();
            }
        }
    }

    // 4) registry fallback under HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss
    #[cfg(windows)]
    if names.is_empty() {
        for hive in [winreg::enums::HKEY_CURRENT_USER, winreg::enums::HKEY_LOCAL_MACHINE] {
            if !names.is_empty() { break; }
            let base = match winreg::RegKey::predef(hive).open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Lxss") {
                Ok(k) => k,
                Err(_) => continue,
            };
            for key in base.enum_keys().flatten() {
                if let Ok(sub) = base.open_subkey(&key) {
                    if let Ok(distro) = sub.get_value::<String, _>("DistributionName") {
                        let d = distro.trim().to_string();
                        if !d.is_empty() && !names.contains(&d) {
                            names.push(d);
                        }
                    }
                }
            }
        }
    }

    // 5) last resort: if wsl.exe exists but no distro name found, add generic default entry (unless we know there are no distros)
    if names.is_empty() && wsl_available() && !saw_no_distro {
        // generic entry will launch default distro (wsl.exe without -d)
        out.push(TerminalProfile {
            id: "wsl-default".into(),
            name: "WSL".into(),
            path: "wsl.exe".into(),
            args: vec![],
            source: "wsl".into(),
            kind: "wsl".into(),
        });
        // also log for diagnostics
        eprintln!("[terminals] wsl.exe found but no distro names parsed — added generic WSL (saw_no_distro={saw_no_distro})");
        return;
    }

    if names.is_empty() {
        eprintln!("[terminals] wsl detection: no distros found (wsl_available={})", wsl_available());
    } else {
        eprintln!("[terminals] wsl distros: {:?}", names);
    }

    for n in names {
        out.push(TerminalProfile {
            id: format!("wsl-{}", slug(&n)),
            name: format!("WSL: {}", n),
            path: "wsl.exe".into(),
            args: vec!["-d".into(), n],
            source: "wsl".into(),
            kind: "wsl".into(),
        });
    }
}

fn strip_json_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    let mut in_str = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            continue;
        }
        if c == '/' {
            if let Some(&next) = chars.peek() {
                if next == '/' {
                    // line comment — skip to end of line
                    chars.next();
                    while let Some(nc) = chars.next() {
                        if nc == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                    continue;
                } else if next == '*' {
                    chars.next();
                    let mut prev_star = false;
                    while let Some(nc) = chars.next() {
                        if prev_star && nc == '/' {
                            break;
                        }
                        prev_star = nc == '*';
                    }
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

fn wt_profiles(out: &mut Vec<TerminalProfile>) {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    if local.is_empty() {
        return;
    }
    let candidates = [
        PathBuf::from(&local)
            .join("Packages")
            .join("Microsoft.WindowsTerminal_8wekyb3d8bbwe")
            .join("LocalState")
            .join("settings.json"),
        PathBuf::from(&local)
            .join("Microsoft")
            .join("Windows Terminal")
            .join("settings.json"),
    ];
    for p in candidates {
        if !p.exists() {
            continue;
        }
        let text = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let cleaned = strip_json_comments(&text);
        let v: serde_json::Value = match serde_json::from_str(&cleaned) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // profiles.list is the common shape; handle profiles as object with list
        let list = if let Some(arr) = v.get("profiles").and_then(|pr| pr.get("list")).and_then(|l| l.as_array()) {
            arr.clone()
        } else if let Some(arr) = v.get("profiles").and_then(|pr| pr.as_array()) {
            arr.clone()
        } else {
            Vec::new()
        };
        for entry in list {
            let hidden = entry.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false);
            if hidden {
                continue;
            }
            let name = entry.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
            if name.is_empty() {
                continue;
            }
            let source = entry.get("source").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let guid = entry.get("guid").and_then(|g| g.as_str()).unwrap_or("").to_string();
            let cmdline = entry.get("commandline").and_then(|c| c.as_str()).map(|s| s.trim().to_string());
            // determine path/args
            let (path, args) = if let Some(cl) = cmdline {
                if cl.is_empty() {
                    continue;
                }
                parse_commandline(&cl)
            } else if source == "Windows.Terminal.Wsl" {
                // no commandline → WSL distro by name
                ("wsl.exe".to_string(), vec!["-d".to_string(), name.clone()])
            } else {
                continue;
            };
            if path.is_empty() {
                continue;
            }
            // skip wt.exe itself (host, not shell)
            let low = path.to_lowercase();
            if low.ends_with("wt.exe") || low == "wt" {
                continue;
            }
            let id = if !guid.is_empty() {
                format!("wt-{}", guid.trim_matches(|c| c == '{' || c == '}').to_lowercase())
            } else {
                format!("wt-{}", slug(&name))
            };
            // label with WT prefix to show both (probes vs WT)
            let display_name = format!("WT: {}", name);
            // dedupe within WT list by id
            if out.iter().any(|e| e.id == id) {
                continue;
            }
            let kind = if source == "Windows.Terminal.Wsl" {
                "wsl"
            } else if low.contains("pwsh") {
                "pwsh"
            } else if low.contains("powershell") {
                "powershell"
            } else if low.contains("cmd") {
                "cmd"
            } else if low.contains("bash") {
                "gitbash"
            } else {
                "wt"
            };
            out.push(TerminalProfile {
                id,
                name: display_name,
                path,
                args,
                source: "wt".into(),
                kind: kind.into(),
            });
        }
        // only parse first found file? But there are two possible locations — prefer Store first,
        // but if both exist (unlikely) we already pushed; avoid double counting same profiles
        // by continuing — but second file likely duplicate, id check above dedupes.
    }
}

static TERMINAL_CACHE: OnceLock<Mutex<(Vec<TerminalProfile>, Instant)>> = OnceLock::new();

#[tauri::command]
pub async fn list_terminals() -> Vec<TerminalProfile> {
    // 10s cache so rapid open/close of the picker or Settings doesn't re-run wsl 6×
    if let Some(cache) = TERMINAL_CACHE.get() {
        if let Ok(guard) = cache.lock() {
            if guard.1.elapsed() < Duration::from_secs(10) && !guard.0.is_empty() {
                return guard.0.clone();
            }
        }
    }
    // heavy probes (where/wsl/registry) run off the UI thread
    let out = tauri::async_runtime::spawn_blocking(|| {
        let mut o = Vec::new();
        probe_shells(&mut o);
        // skip wsl completely when wsl.exe isn't present — saves ~500ms on machines without WSL
        if wsl_available() {
            wsl_distros(&mut o);
        }
        wt_profiles(&mut o);
        o
    })
    .await
    .unwrap_or_default();

    if let Some(cache) = TERMINAL_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            *guard = (out.clone(), Instant::now());
        }
    } else {
        let _ = TERMINAL_CACHE.set(Mutex::new((out.clone(), Instant::now())));
    }
    out
}
