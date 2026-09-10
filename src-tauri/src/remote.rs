// SSH remote workspaces — use every GUI feature against a remote box.
//
// A remote workspace is addressed as `ssh://[user@]host[:port]/remote/path`.
// That single string flows through the existing workspace plumbing
// (localStorage lists, ?directory=, sessionDirRef) unchanged:
//
// - chat/sessions/SSE/file-list/file-read: served by an `opencode serve`
//   auto-started on the remote, reached through a Rust-managed
//   `ssh -L 127.0.0.1:<local>:127.0.0.1:<remote>` tunnel (one ssh child per
//   workspace, killed with the app via the existing Job Object).
// - file writes / git / terminals: the local `std::fs` / `git` / ConPTY
//   call sites detect the `ssh://` prefix and re-run over `ssh` instead
//   (see lib.rs file commands, git.rs run_blocking, pty.rs pty_spawn).
//
// No new crates: everything shells out to the system `ssh` binary, so
// `~/.ssh/config`, keys and agents keep working with zero GUI config.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::sync::LazyLock;

use tauri::{AppHandle, State};

/// Process-global handle + passwords so deep call sites (git.rs run_blocking,
/// which has no Tauri State in scope) can reach the remote without
/// re-plumbing 35 command signatures. Tunnels themselves stay in the
/// Tauri-managed RemoteState below; passwords are mirrored to both.
static APP: OnceLock<AppHandle> = OnceLock::new();
static PASSWORDS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

fn global_passwords_for(t: &RemoteTarget) -> Option<String> {
    let pwds = PASSWORDS.lock().unwrap_or_else(|e| e.into_inner());
    let uri = uri_of(t);
    pwds.get(&uri).cloned().or_else(|| {
        let want = authority_of(t);
        pwds.iter().find(|(k, _)| parse_remote(k).is_some_and(|o| authority_of(&o) == want)).map(|(_, v)| v.clone())
    })
}

fn remember_password(uri: &str, pw: String) {
    PASSWORDS.lock().unwrap_or_else(|e| e.into_inner()).insert(uri.to_string(), pw);
}

fn forget_password(uri: &str) {
    PASSWORDS.lock().unwrap_or_else(|e| e.into_inner()).remove(uri);
}

fn global_key_for(t: &RemoteTarget) -> Option<String> {
    let app = APP.get()?;
    let map = read_key_map(app);
    let uri = uri_of(t);
    map.get(&uri).cloned().or_else(|| {
        let want = authority_of(t);
        map.iter().find(|(k, _)| parse_remote(k).is_some_and(|o| authority_of(&o) == want)).map(|(_, v)| v.clone())
    })
}

/// Circuit breaker: a host that just failed at the TRANSPORT level stays
/// failed-fast for a while. Without it a dead box wedges the whole app —
/// the boot retry loop, 2s SSE ticks and 4s git polls would otherwise stack
/// 10–40s blocking ssh calls until Tauri's command pool starves and even
/// trivial invokes stop running (the total-freeze-on-launch failure).
static HOST_DOWN: LazyLock<Mutex<HashMap<String, std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const BREAKER_WINDOW: std::time::Duration = std::time::Duration::from_secs(20);

/// ssh reserves exit code 255 for its own failures (vs the remote command's
/// exit code). With LC_ALL=C the markers below are stable across locales.
#[derive(Debug, PartialEq, Eq)]
enum SshFailure {
    /// network/host unreachable — trip the breaker, fail fast for a while
    Transport,
    /// bad credentials — never trip (the user may fix the key/password and
    /// retry immediately; a tripped breaker would swallow that retry)
    Auth,
    /// the remote command itself failed (host is fine) — never trip
    Command,
}

fn classify_ssh_failure(code: Option<i32>, stderr: &str) -> SshFailure {
    if code != Some(255) {
        return SshFailure::Command;
    }
    let lower = stderr.to_lowercase();
    // auth first: a throttled/drop-happy server can print both, and a wrong
    // password must stay instantly retryable
    if lower.contains("permission denied") {
        return SshFailure::Auth;
    }
    const TRANSPORT: &[&str] = &[
        "connection refused",
        "connection timed out",
        "connection reset",
        "operation timed out",
        "no route to host",
        "network is unreachable",
        "could not resolve hostname",
        "name or service not known",
        "closed by remote host",
        "broken pipe",
    ];
    if TRANSPORT.iter().any(|m| lower.contains(m)) {
        SshFailure::Transport
    } else {
        // unknown 255 (e.g. host-key changed): fail safe == no trip, just an
        // error. Worst case is today's behavior, never a worse one.
        SshFailure::Command
    }
}

fn breaker_key(t: &RemoteTarget) -> String {
    // host-level: every workspace on the box shares one breaker
    if t.port != 22 {
        format!("{}:{}", t.host, t.port)
    } else {
        t.host.clone()
    }
}

fn open_since(at: std::time::Instant, window: std::time::Duration) -> bool {
    at.elapsed() < window
}

/// True when this host failed transport recently — callers must fail fast
/// without spawning ssh.
pub fn circuit_open(t: &RemoteTarget) -> bool {
    let map = HOST_DOWN.lock().unwrap_or_else(|e| e.into_inner());
    map.get(&breaker_key(t))
        .is_some_and(|at| open_since(*at, BREAKER_WINDOW))
}

/// Same check from a workspace uri / pseudo-path (for call sites like pty
/// that never build a target for grading).
pub fn circuit_open_uri(uri: &str) -> bool {
    parse_remote(uri.trim()).is_some_and(|t| circuit_open(&t))
}

fn note_transport(t: &RemoteTarget, ok: bool) {
    let mut map = HOST_DOWN.lock().unwrap_or_else(|e| e.into_inner());
    if ok {
        map.remove(&breaker_key(t));
    } else {
        map.insert(breaker_key(t), std::time::Instant::now());
    }
}

/// Run `git -C <remote-path> …` using global creds (for git.rs, which has no
/// State in scope). Entry may be a workspace uri or a pseudo root path.
pub fn exec_git_global(cwd_uri: &str, args: &[&str]) -> Result<String, String> {
    let t = target_from_uri(cwd_uri)?;
    let key = global_key_for(&t);
    let pw = global_passwords_for(&t);
    let mut remote = format!("env GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -C {} ", sh_quote(&t.path));
    for a in args {
        remote.push_str(&sh_quote(a));
        remote.push(' ');
    }
    exec_remote(&t, key.as_deref(), pw.as_deref(), remote.trim_end(), None)
}

/// Global-creds `test <op> <remote-path>` for pseudo-path predicates.
pub fn test_global(uri: &str, op: &str, remote_path: &str) -> bool {
    let Ok(t) = target_from_uri(uri) else { return false };
    let key = global_key_for(&t);
    let pw = global_passwords_for(&t);
    exec_remote(&t, key.as_deref(), pw.as_deref(), &format!("test {op} {}", sh_quote(remote_path)), None).is_ok()
}

/// Global-creds one-shot script (file ops from git.rs, watch polling).
pub fn script_global(uri: &str, script: &str) -> Result<String, String> {
    let t = target_from_uri(uri)?;
    let key = global_key_for(&t);
    let pw = global_passwords_for(&t);
    exec_remote(&t, key.as_deref(), pw.as_deref(), script, None)
}

pub struct RemoteConn {
    pub port: u16,
    pub child: Child,
}

#[derive(Default)]
pub struct RemoteState {
    pub conns: Mutex<HashMap<String, RemoteConn>>,
    /// passwords are memory-only (never persisted); key = workspace uri
    pub passwords: Mutex<HashMap<String, String>>,
}

#[derive(Clone, Debug)]
pub struct RemoteTarget {
    pub user: Option<String>,
    pub host: String,
    pub port: u16,
    pub path: String,
}

/// Workspace key (`ssh://[user@]host[:port]/path`) or pseudo file path.
/// Plain local paths return false — every remote branch keys off this.
pub fn is_remote(s: &str) -> bool {
    s.starts_with("ssh://")
}

pub fn is_remote_path(p: &Path) -> bool {
    p.as_os_str().to_string_lossy().starts_with("ssh://")
}

/// Parse `ssh://[user@]host[:port]/path`. Port defaults to 22.
pub fn parse_remote(s: &str) -> Option<RemoteTarget> {
    let rest = s.strip_prefix("ssh://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    if authority.is_empty() {
        return None;
    }
    let (user, hostport) = match authority.rfind('@') {
        Some(i) => (Some(authority[..i].to_string()), &authority[i + 1..]),
        None => (None, authority),
    };
    // hostport may be [v6]:port, host:port, or bare host
    let (host, port) = if let Some(stripped) = hostport.strip_prefix('[') {
        let end = stripped.find(']')?;
        let h = &stripped[..end];
        let p = stripped[end + 1..].strip_prefix(':').unwrap_or("22");
        (h.to_string(), p.parse().unwrap_or(22))
    } else if let Some(i) = hostport.rfind(':') {
        let (h, p) = (&hostport[..i], &hostport[i + 1..]);
        // single colon + numeric tail = port; otherwise bare hostname (e.g. ::1 unlikely here)
        if !h.is_empty() && !h.contains(':') && p.chars().all(|c| c.is_ascii_digit()) {
            (h.to_string(), p.parse().unwrap_or(22))
        } else {
            (hostport.to_string(), 22)
        }
    } else {
        (hostport.to_string(), 22)
    };
    if host.is_empty() || !path.starts_with('/') {
        return None;
    }
    if let Some(u) = &user {
        if u.is_empty() {
            return None;
        }
    }
    Some(RemoteTarget { user, host, port, path })
}

/// Split a pseudo file path (`ssh://[user@]host[:port]/a/b`) into its
/// target (authority + full remote path).
pub fn split_remote(s: &str) -> Option<RemoteTarget> {
    let rest = s.strip_prefix("ssh://")?;
    let slash = rest.find('/')?;
    let authority = &rest[..slash];
    let path = rest[slash..].to_string();
    let t = parse_remote(&format!("ssh://{authority}/"))?;
    Some(RemoteTarget { path, ..t })
}

fn authority_of(t: &RemoteTarget) -> String {
    let mut a = String::new();
    if let Some(u) = &t.user {
        a.push_str(u);
        a.push('@');
    }
    a.push_str(&t.host);
    if t.port != 22 {
        a.push_str(&format!(":{}", t.port));
    }
    a
}

/// Canonical workspace uri for a target (used as conn-map key).
pub fn uri_of(t: &RemoteTarget) -> String {
    format!("ssh://{}/{}", authority_of(t), t.path.trim_start_matches('/'))
}

/// Authority (`[user@]host[:port]`) of a workspace uri or pseudo-path.
pub fn authority_str(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("ssh://")?;
    Some(rest[..rest.find('/')?].to_string())
}

/// Posix join for pseudo-paths (std PathBuf would use `\` on Windows,
// which corrupts remote paths when the GUI runs on Windows).
pub fn pseudo_join(pseudo: &str, rel: &str) -> String {
    format!("{}/{}", pseudo.trim_end_matches('/'), rel.trim_start_matches('/'))
}

/// Swap the remote path of a pseudo-path for an absolute one, keeping authority.
pub fn pseudo_with_abs(pseudo: &str, abs: &str) -> Option<String> {
    Some(format!("ssh://{}{}", authority_str(pseudo)?, abs))
}
/// POSIX single-quote a remote path/arg for remote shells.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn keys_file(app: &AppHandle) -> Option<PathBuf> {
    Some(crate::platform::config_dir(app).join("ssh-keys.json"))
}

fn read_key_map(app: &AppHandle) -> HashMap<String, String> {
    keys_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Password delivery without third-party binaries (sshpass is GPL-2.0-only
/// and POSIX-only — it can't ship in this AGPL project or on Windows).
/// Instead OpenSSH's own `SSH_ASKPASS` mechanism points back at our exe
/// (see main.rs `maybe_askpass`), which prints the password and exits.
/// The password lives in a 0600 temp file that self-deletes on drop —
/// askpass only fires at connect time, so deleting right after spawn is safe.
struct AskpassFile(PathBuf);

impl Drop for AskpassFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

static ASKPASS_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn write_askpass_file(password: &str) -> Result<AskpassFile, String> {
    let n = ASKPASS_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("oc-askpass-{}-{}-{n}.tmp", std::process::id(), nanos));
    std::fs::write(&path, password.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(AskpassFile(path))
}

/// Point one ssh Command at an existing askpass password file.
fn apply_askpass_env(cmd: &mut Command, guard: &AskpassFile) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    cmd.env("SSH_ASKPASS", &exe);
    cmd.env("SSH_ASKPASS_REQUIRE", "force");
    cmd.env("OC_SSH_ASKPASS_FILE", &guard.0);
    Ok(())
}

/// Point an ssh Command at the self-askpass helper. Returns the guard that
/// deletes the password file (keep it alive until the child is spawned and
/// connected — Dropping earlier revokes the password).
fn apply_askpass(cmd: &mut Command, password: &str) -> Result<AskpassFile, String> {
    let guard = write_askpass_file(password)?;
    apply_askpass_env(cmd, &guard)?;
    Ok(guard)
}

/// Base ssh argv (no subcommand yet). `batch` adds BatchMode=yes (fail fast,
/// never prompt) — off for pty use and for askpass password delivery, where
/// prompting (answered by the helper) is the whole point.
fn ssh_argv(t: &RemoteTarget, key_file: Option<&str>, batch: bool) -> Vec<String> {
    let mut a = vec!["ssh".to_string()];
    if t.port != 22 {
        a.push("-p".to_string());
        a.push(t.port.to_string());
    }
    if let Some(k) = key_file {
        if !k.trim().is_empty() {
            a.push("-i".to_string());
            a.push(k.to_string());
        }
    }
    a.push("-o".to_string());
    a.push("ConnectTimeout=10".to_string());
    a.push("-o".to_string());
    a.push("ServerAliveInterval=30".to_string());
    a.push("-o".to_string());
    a.push("ServerAliveCountMax=3".to_string());
    if batch {
        a.push("-o".to_string());
        a.push("BatchMode=yes".to_string());
    }
    a.push("-o".to_string());
    a.push("StrictHostKeyChecking=accept-new".to_string());
    a
}

fn ssh_destination(t: &RemoteTarget) -> String {
    match &t.user {
        Some(u) => format!("{u}@{}", t.host),
        None => t.host.clone(),
    }
}

/// Run a command on the remote via short-lived `ssh` (git, test, mkdir…).
/// `stdin_bytes` pipes raw bytes to the remote stdin (binary-safe writes).
/// Dead hosts fail FAST via the circuit breaker instead of burning a full
/// ConnectTimeout on every caller (boot loop, SSE ticks, git polls).
pub fn exec_remote(
    t: &RemoteTarget,
    key_file: Option<&str>,
    password: Option<&str>,
    remote_cmd: &str,
    stdin_bytes: Option<&[u8]>,
) -> Result<String, String> {
    if circuit_open(t) {
        return Err(format!(
            "ssh to {} failed recently — retrying shortly (host unreachable)",
            t.host
        ));
    }
    let want_pw = password.is_some_and(|p| !p.is_empty());
    // askpass answers the prompt; BatchMode would suppress prompting
    let argv = ssh_argv(t, key_file, !want_pw);
    let dest = ssh_destination(t);
    let mut cmd = Command::new(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    // keep the guard alive until the child has exited — dropping it deletes
    // the password file, and a late re-prompt must fail closed, not hang
    let _askpass = if want_pw {
        Some(apply_askpass(&mut cmd, password.unwrap_or_default())?)
    } else {
        None
    };
    // destination + single remote-command string (ssh joins command argv and
    // runs it via the remote shell — no `--` separator: older OpenSSH
    // versions reject it and the command never starts with a flag anyway)
    cmd.arg(dest).arg(remote_cmd);
    cmd.env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if stdin_bytes.is_some() {
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("ssh: {e}"))?;
    if let Some(bytes) = stdin_bytes {
        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(bytes);
        }
    }
    let out = child.wait_with_output().map_err(|e| format!("ssh: {e}"))?;
    if out.status.success() {
        note_transport(t, true);
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // only transport failures trip the breaker — auth problems stay
        // instantly retryable, command errors mean the host is fine
        if classify_ssh_failure(out.status.code(), &stderr) == SshFailure::Transport {
            note_transport(t, false);
        }
        Err(stderr)
    }
}

/// Convenience for lib.rs file commands: parse uri, resolve creds, run script.
pub fn exec_script(
    app: &AppHandle,
    state: &State<'_, RemoteState>,
    uri: &str,
    script: &str,
    stdin_bytes: Option<&[u8]>,
) -> Result<String, String> {
    let t = target_from_uri(uri)?;
    let (key, pw) = creds_for(app, state, &t);
    exec_remote(&t, key.as_deref(), pw.as_deref(), script, stdin_bytes)
}

/// Parent dir of a remote posix path (`/a/b` → `/a`, `/a` → `/`).
pub fn remote_parent(rp: &str) -> &str {
    match rp.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &rp[..i],
    }
}

/// Look up stored key file + in-memory password. Exact workspace-uri match
/// first, then any stored key for the same authority (repo roots derived via
/// `rev-parse` differ from the workspace uri but share login).
fn creds_for(app: &AppHandle, state: &State<'_, RemoteState>, t: &RemoteTarget) -> (Option<String>, Option<String>) {
    let uri = uri_of(t);
    let map = read_key_map(app);
    let key = map.get(&uri).cloned().or_else(|| {
        let want = authority_of(t);
        map.iter().find(|(k, _)| k.starts_with("ssh://") && parse_remote(k).is_some_and(|o| authority_of(&o) == want)).map(|(_, v)| v.clone())
    });
    let pwds = state.passwords.lock().unwrap_or_else(|e| e.into_inner());
    let pw = pwds.get(&uri).cloned().or_else(|| {
        let want = authority_of(t);
        pwds.iter().find(|(k, _)| parse_remote(k).is_some_and(|o| authority_of(&o) == want)).map(|(_, v)| v.clone())
    });
    (key, pw)
}

fn target_from_uri(uri: &str) -> Result<RemoteTarget, String> {
    parse_remote(uri.trim()).ok_or_else(|| format!("bad ssh workspace: {uri} (want ssh://[user@]host[:port]/path)"))
}

/// argv (including binary) + destination + remote command for an interactive
/// remote shell inside the local pty. No BatchMode, so key passphrases and
/// passwords prompt naturally in the terminal.
pub fn pty_ssh_parts(uri: &str, shell: Option<&str>) -> Option<(Vec<String>, String, String)> {
    let t = target_from_uri(uri.trim()).ok()?;
    let key = global_key_for(&t);
    let mut argv = ssh_argv(&t, key.as_deref(), false);
    argv.push("-tt".to_string());
    let dest = ssh_destination(&t);
    let cmd = match shell {
        Some(s) if !s.trim().is_empty() => format!("cd {} && exec {}", sh_quote(&t.path), s.trim()),
        _ => format!("cd {} && exec ${{SHELL:-/bin/bash}} -l", sh_quote(&t.path)),
    };
    Some((argv, dest, cmd))
}

/// Fast (non-blocking) half of the tunnel: reuse a live conn if present.
fn live_port(state: &State<'_, RemoteState>, uri: &str) -> Option<u16> {
    let mut conns = state.conns.lock().unwrap_or_else(|e| e.into_inner());
    let alive = match conns.get_mut(uri.trim()) {
        Some(c) => matches!(c.child.try_wait(), Ok(None)),
        None => return None,
    };
    if alive {
        conns.get(uri.trim()).map(|c| c.port)
    } else {
        conns.remove(uri.trim());
        None
    }
}

fn store_conn(state: &State<'_, RemoteState>, uri: String, port: u16, child: Child) {
    state
        .conns
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(uri, RemoteConn { port, child });
}

/// Wait for the forwarded port, but bail the moment ssh itself dies instead
/// of burning the whole timeout (connection refused / bad auth used to cost
/// a full 10s wait per attempt before anyone noticed the corpse).
fn wait_for_tunnel(local: u16, child: &mut Child, timeout: std::time::Duration) -> bool {
    let slices = (timeout.as_millis() / 500).max(1);
    for _ in 0..slices {
        if crate::wait_for_port(local, std::time::Duration::from_millis(500)) {
            return true;
        }
        match child.try_wait() {
            Ok(Some(_)) => return false,
            _ => {}
        }
    }
    false
}

/// Blocking tunnel dial: pick ports, spawn `ssh -L … opencode serve`, wait
/// for health. Pure owned inputs so commands can run it on the blocking
/// pool; all fast map/cred work stays outside. Returns the local port +
/// the ssh child on success.
fn dial_blocking(
    t: RemoteTarget,
    key: Option<String>,
    pw: Option<String>,
) -> Result<(u16, Child), String> {
    // password file is created once and lives for all attempts — the tunnel
    // only prompts at connect time
    let askpass_guard: Option<AskpassFile> = match pw.as_deref() {
        Some(p) if !p.is_empty() => Some(write_askpass_file(p)?),
        _ => None,
    };
    // two attempts max: a refused/dead host won't heal 250ms later, and
    // deterministic failures (bad auth, missing remote binary) return at once
    const RETRIES: u32 = 2;
    let mut last_err = String::from("failed to start remote opencode");
    for _ in 0..RETRIES {
        let local = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| e.to_string())?
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();
        // remote port mirrors the local pick (high ports are usually free on
        // both ends); a clash retries with a fresh local port
        let remote_port = local;
        let fwd = format!("127.0.0.1:{local}:127.0.0.1:{remote_port}");
        let argv = ssh_argv(&t, key.as_deref(), askpass_guard.is_none());
        let dest = ssh_destination(&t);
        let serve = format!("opencode serve --port {remote_port} --hostname 127.0.0.1");
        let mut cmd = Command::new(&argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        if let Some(g) = &askpass_guard {
            apply_askpass_env(&mut cmd, g)?;
        }
        cmd.arg("-o")
            .arg("ExitOnForwardFailure=yes")
            .arg("-L")
            .arg(&fwd)
            .arg(dest)
            .arg(&serve);
        // stderr is piped (not nulled) so an early death can be classified
        // below; no console window is created either way
        cmd.stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(all(windows, not(debug_assertions)))]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(debug_assertions)]
        {
            // debug builds still surface the child on the console via stderr
            let _ = cmd.stdout(Stdio::inherit());
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                // local spawn failure (no ssh binary) — instant, never trips
                return Err(format!("ssh: {e}"));
            }
        };
        crate::job::assign(&child);
        let listening = wait_for_tunnel(local, &mut child, std::time::Duration::from_secs(10));
        if listening {
            note_transport(&t, true);
            return Ok((local, child));
        }
        // Not listening: either ssh died on its own (classify the corpse)
        // or it's still hanging (slow host — kill it, no verdict yet, and
        // above all don't report it as a missing remote binary).
        let early_exit = matches!(child.try_wait(), Ok(Some(_)));
        if !early_exit {
            let _ = child.kill();
        }
        let status = child.wait().ok();
        // drain stderr for classification (EOF is immediate — the child is
        // dead here; no console window is created either way)
        let mut stderr_text = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            use std::io::Read;
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            stderr_text = buf;
        }
        if !early_exit {
            last_err = format!(
                "tunnel to {} not listening on 127.0.0.1:{local} (host slow or firewalled?)",
                t.host
            );
            std::thread::sleep(std::time::Duration::from_millis(300));
            continue;
        }
        match classify_ssh_failure(status.and_then(|s| s.code()), &stderr_text) {
            SshFailure::Auth => {
                return Err(format!(
                    "ssh to {} rejected the credentials (check key/agent/password)",
                    ssh_destination(&t)
                ));
            }
            SshFailure::Transport => {
                note_transport(&t, false);
                last_err = format!("ssh to {} unreachable: {}", t.host, first_line(&stderr_text));
                std::thread::sleep(std::time::Duration::from_millis(300));
                continue;
            }
            SshFailure::Command => {
                // deterministic remote failure (e.g. no `opencode` binary) —
                // retrying an identical command is pointless
                return Err(format!(
                    "remote `opencode serve` exited on {fwd} (is opencode installed on {}? check `ssh {} opencode --version`)",
                    t.host,
                    ssh_destination(&t)
                ));
            }
        }
    }
    note_transport(&t, false);
    Err(last_err)
}

fn first_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("connection failed")
        .chars()
        .take(160)
        .collect()
}

pub fn kill_all(state: &RemoteState) {
    let mut conns = state.conns.lock().unwrap_or_else(|e| e.into_inner());
    for (_, mut c) in conns.drain() {
        let _ = c.child.kill();
        let _ = c.child.wait();
    }
}

// --- Tauri commands ---------------------------------------------------------

#[tauri::command]
pub async fn remote_test(app: AppHandle, state: State<'_, RemoteState>, uri: String, password: Option<String>) -> Result<String, String> {
    let uri = uri.trim().to_string();
    if let Some(pw) = password.clone() {
        if !pw.is_empty() {
            state.passwords.lock().unwrap_or_else(|e| e.into_inner()).insert(uri.clone(), pw.clone());
            remember_password(&uri, pw);
        }
    }
    let t = target_from_uri(&uri)?;
    let (key, pw) = creds_for(&app, &state, &t);
    // off the command thread: a dead host burns a full ConnectTimeout here
    let out = tauri::async_runtime::spawn_blocking(move || {
        let script = format!("test -d {} && echo dir-ok; opencode --version || echo no-opencode", sh_quote(&t.path));
        exec_remote(&t, key.as_deref(), pw.as_deref(), &script, None)
    })
    .await
    .map_err(|e| format!("ssh task failed: {e}"))??;
    if !out.contains("dir-ok") {
        return Err(format!("remote path not found: {}", uri));
    }
    Ok(out.trim().to_string())
}

#[tauri::command]
pub async fn remote_ensure(app: AppHandle, state: State<'_, RemoteState>, uri: String, password: Option<String>) -> Result<u16, String> {
    ensure_tunnel_async(app, state, uri, password).await
}

/// Shared slow path for remote_ensure / remote_base_url: fast map + cred
/// work inline, blocking dial on the blocking pool.
async fn ensure_tunnel_async(
    app: AppHandle,
    state: State<'_, RemoteState>,
    uri: String,
    password: Option<String>,
) -> Result<u16, String> {
    let uri = uri.trim().to_string();
    let t = target_from_uri(&uri)?;
    if let Some(pw) = password {
        state.passwords.lock().unwrap_or_else(|e| e.into_inner()).insert(uri.clone(), pw.clone());
        remember_password(&uri, pw);
    }
    if let Some(port) = live_port(&state, &uri) {
        return Ok(port);
    }
    if circuit_open(&t) {
        return Err(format!(
            "ssh to {} failed recently — retrying shortly (host unreachable)",
            t.host
        ));
    }
    let (key, pw) = creds_for(&app, &state, &t);
    let (port, child) = tauri::async_runtime::spawn_blocking(move || dial_blocking(t, key, pw))
        .await
        .map_err(|e| format!("tunnel task failed: {e}"))??;
    store_conn(&state, uri, port, child);
    Ok(port)
}

#[tauri::command]
pub async fn remote_base_url(app: AppHandle, state: State<'_, RemoteState>, uri: String) -> Result<String, String> {
    if let Some(port) = live_port(&state, uri.trim()) {
        return Ok(format!("http://127.0.0.1:{port}"));
    }
    ensure_tunnel_async(app, state, uri, None).await.map(|p| format!("http://127.0.0.1:{p}"))
}

#[derive(serde::Serialize)]
pub struct RemoteStatus {
    pub alive: bool,
    pub port: Option<u16>,
}

#[tauri::command]
pub fn remote_status(state: State<'_, RemoteState>, uri: String) -> RemoteStatus {
    let mut conns = state.conns.lock().unwrap_or_else(|e| e.into_inner());
    let alive_port = conns.get_mut(uri.trim()).and_then(|c| match c.child.try_wait() {
        Ok(None) => Some(c.port),
        _ => None,
    });
    match alive_port {
        Some(port) => RemoteStatus { alive: true, port: Some(port) },
        None => {
            conns.remove(uri.trim());
            RemoteStatus { alive: false, port: None }
        }
    }
}

#[tauri::command]
pub fn remote_remove(state: State<'_, RemoteState>, uri: String) -> Result<(), String> {
    let mut conns = state.conns.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut c) = conns.remove(uri.trim()) {
        let _ = c.child.kill();
        let _ = c.child.wait();
    }
    state.passwords.lock().unwrap_or_else(|e| e.into_inner()).remove(uri.trim());
    forget_password(uri.trim());
    Ok(())
}

#[tauri::command]
pub fn remote_set_key(app: AppHandle, uri: String, key_file: String) -> Result<(), String> {
    let uri = uri.trim().to_string();
    target_from_uri(&uri)?;
    let Some(file) = keys_file(&app) else { return Err("no config dir".into()) };
    let mut map = read_key_map(&app);
    if key_file.trim().is_empty() {
        map.remove(&uri);
    } else {
        map.insert(uri, key_file.trim().to_string());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, serde_json::to_string(&map).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_get_key(app: AppHandle, uri: String) -> String {
    read_key_map(&app).get(uri.trim()).cloned().unwrap_or_default()
}

#[tauri::command]
pub fn remote_terminals(app: AppHandle, state: State<'_, RemoteState>, uri: String) -> Vec<crate::terminals::TerminalProfile> {
    use crate::terminals::TerminalProfile;
    let Ok(t) = target_from_uri(&uri) else { return vec![] };
    let (key, pw) = creds_for(&app, &state, &t);
    // remote login shell + common shells; missing binaries are filtered
    let probe = "echo \"LOGIN_SHELL=$SHELL\"; for s in /bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /bin/fish /usr/bin/fish /bin/sh; do [ -x \"$s\" ] && echo \"HAVE=$s\"; done";
    let Ok(out) = exec_remote(&t, key.as_deref(), pw.as_deref(), probe, None) else { return vec![] };
    let mut shells: Vec<String> = vec![];
    let mut login = String::new();
    for line in out.lines().map(str::trim) {
        if let Some(s) = line.strip_prefix("LOGIN_SHELL=") {
            if !s.is_empty() {
                login = s.to_string();
            }
        } else if let Some(s) = line.strip_prefix("HAVE=") {
            if !shells.contains(&s.to_string()) {
                shells.push(s.to_string());
            }
        }
    }
    if !login.is_empty() && !shells.contains(&login) {
        shells.insert(0, login.clone());
    }
    shells
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let name = format!("{} (ssh)", s.rsplit('/').next().unwrap_or(&s));
            TerminalProfile {
                id: format!("ssh-{i}"),
                name,
                path: s,
                args: vec![],
                source: "ssh".into(),
                kind: "ssh".into(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_uri() {
        let t = parse_remote("ssh://deploy@dev.example.com:2222/home/deploy/app").unwrap();
        assert_eq!(t.user.as_deref(), Some("deploy"));
        assert_eq!(t.host, "dev.example.com");
        assert_eq!(t.port, 2222);
        assert_eq!(t.path, "/home/deploy/app");
        assert_eq!(uri_of(&t), "ssh://deploy@dev.example.com:2222/home/deploy/app");
    }

    #[test]
    fn parses_bare_host_defaults() {
        let t = parse_remote("ssh://nas.local/srv/data").unwrap();
        assert_eq!(t.user, None);
        assert_eq!(t.host, "nas.local");
        assert_eq!(t.port, 22);
        assert_eq!(t.path, "/srv/data");
        // default port is omitted from the canonical uri
        assert_eq!(uri_of(&t), "ssh://nas.local/srv/data");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_remote("").is_none());
        assert!(parse_remote("C:\\proj").is_none());
        assert!(parse_remote("/home/u").is_none());
        assert!(parse_remote("ssh:///nop").is_none());
        assert!(parse_remote("ssh://@host/x").is_none()); // empty user
        // bare host defaults to the remote root
        assert_eq!(parse_remote("ssh://host").unwrap().path, "/");
    }

    #[test]
    fn pseudo_paths_round_trip() {
        let t = split_remote("ssh://u@h:22/a/b/c.ts").unwrap();
        assert_eq!(t.host, "h");
        assert_eq!(t.path, "/a/b/c.ts");
        assert_eq!(authority_str("ssh://u@h:22/a/b"), Some("u@h:22".into()));
        assert_eq!(pseudo_join("ssh://u@h/a", "b"), "ssh://u@h/a/b");
        assert_eq!(pseudo_with_abs("ssh://u@h/a/b", "/x/y"), Some("ssh://u@h/x/y".into()));
        assert!(!is_remote("/a/b"));
        assert!(!is_remote_path(Path::new("C:\\x")));
        assert!(is_remote_path(Path::new("ssh://u@h/a")));
    }

    #[test]
    fn shell_quoting_survives_apostrophes() {
        assert_eq!(sh_quote("/a/b"), "'/a/b'");
        assert_eq!(sh_quote("/a/o'b"), "'/a/o'\\''b'");
    }

    #[test]
    fn ssh_argv_flags_always_paired() {
        // regression: stripping BatchMode for askpass once left a dangling
        // `-o`, and ssh died with "no argument after keyword"
        let t = parse_remote("ssh://u@h:2222/a").unwrap();
        for (batch, key) in [(true, None), (false, None), (true, Some("k")), (false, Some("k"))] {
            let argv = ssh_argv(&t, key, batch);
            assert_eq!(argv[0], "ssh");
            for (i, a) in argv.iter().enumerate() {
                for (flag, takes_value) in [("-o", true), ("-p", true), ("-i", true)] {
                    if a == flag {
                        assert!(takes_value);
                        let v = argv.get(i + 1).unwrap_or_else(|| panic!("dangling {flag} in {argv:?}"));
                        assert!(!v.starts_with('-'), "{flag} followed by flag {v} in {argv:?}");
                    }
                }
            }
            assert_eq!(argv.iter().any(|a| a == "BatchMode=yes"), batch);
        }
    }

        #[test]
    fn askpass_file_self_deletes() {
        let path = {
            let g = write_askpass_file("s3cret").unwrap();
            assert!(g.0.is_file());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&g.0).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600);
            }
            g.0.clone()
        };
        assert!(!path.exists());
    }

    #[test]
    fn classify_transport_failures_trip() {
        use SshFailure::*;
        // ssh's own exit code + network markers → breaker trips
        assert_eq!(classify_ssh_failure(Some(255), "ssh: connect to host h port 22: Connection refused"), Transport);
        assert_eq!(classify_ssh_failure(Some(255), "ssh: connect to host h port 22: Connection timed out"), Transport);
        assert_eq!(classify_ssh_failure(Some(255), "ssh: Could not resolve hostname nope: Name or service not known"), Transport);
        assert_eq!(classify_ssh_failure(Some(255), "Connection closed by remote host"), Transport);
        assert_eq!(classify_ssh_failure(Some(255), "No route to host"), Transport);
        // auth failures stay instantly retryable even at 255…
        assert_eq!(classify_ssh_failure(Some(255), "user@h: Permission denied (publickey,password)."), Auth);
        // …and win over transport markers when a throttled server prints both
        assert_eq!(classify_ssh_failure(Some(255), "Permission denied, please try again.\r\nConnection closed by remote host"), Auth);
        // remote command failures mean the host is fine — never trip
        assert_eq!(classify_ssh_failure(Some(1), "fatal: not a git repository"), Command);
        assert_eq!(classify_ssh_failure(Some(127), "opencode: command not found"), Command);
        assert_eq!(classify_ssh_failure(Some(128), "Permission denied (publickey)"), Command);
        assert_eq!(classify_ssh_failure(None, "killed"), Command);
        // unknown 255 fails safe: an error, but no trip (today's behavior)
        assert_eq!(classify_ssh_failure(Some(255), "Host key verification failed."), Command);
        assert_eq!(classify_ssh_failure(Some(255), ""), Command);
    }

    #[test]
    fn breaker_opens_and_expires() {
        let t = parse_remote("ssh://u@h:2222/a").unwrap();
        assert_eq!(breaker_key(&t), "h:2222");
        assert_eq!(breaker_key(&parse_remote("ssh://h/a").unwrap()), "h");
        assert!(!open_since(std::time::Instant::now() - std::time::Duration::from_secs(30), std::time::Duration::from_secs(20)));
        assert!(open_since(std::time::Instant::now(), std::time::Duration::from_secs(20)));
        // trip → open; success → closed again (fast recovery, no waiting out the window)
        note_transport(&t, false);
        assert!(circuit_open(&t));
        assert!(circuit_open_uri("ssh://u@h:2222/other/path"));
        assert!(!circuit_open_uri("ssh://other-host/a"));
        note_transport(&t, true);
        assert!(!circuit_open(&t));
    }

    #[test]
    fn first_line_truncates_noise() {
        assert_eq!(first_line(""), "connection failed");
        assert_eq!(first_line("\n  ssh: boom  \nsecond"), "ssh: boom");
        assert_eq!(first_line(&"x".repeat(500)).len(), 160);
    }
}
