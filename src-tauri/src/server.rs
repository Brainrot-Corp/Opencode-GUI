// opencode sidecar lifecycle: spawn `opencode serve` on a free loopback
// port, keep the child in a Windows Job Object (KILL_ON_JOB_CLOSE) so a
// crash never orphans it, and hand the base URL to the frontend.
use std::path::PathBuf;
use std::process::{Child, Stdio};
#[cfg(debug_assertions)]
use std::process::Command;
use std::sync::Mutex;

use tauri::State;

pub struct ServerState {
    pub port: u16,
    pub child: Mutex<Option<Child>>,
    pub error: Option<String>,
}

// Windows Job Object: child dies with parent even on crash (KILL_ON_JOB_CLOSE).
// Without it a hard renderer crash orphans opencode.exe on its port.
#[cfg(windows)]
pub(crate) mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}
    static JOB: OnceLock<JobHandle> = OnceLock::new();

    fn get() -> Option<HANDLE> {
        if let Some(h) = JOB.get() {
            return Some(h.0);
        }
        unsafe {
            let h = CreateJobObjectW(None, None).ok()?;
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            // BREAKAWAY_OK allows nested jobs (enterprise/debugger already in a job) to
            // still create a child job; without it AssignProcessToJobObject fails with
            // ERROR_ACCESS_DENIED and nested grandchildren outlive the GUI.
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            let _ = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            );
            let _ = JOB.set(JobHandle(h));
            Some(h)
        }
    }

    pub fn assign(child: &Child) {
        let Some(job) = get() else { return };
        unsafe {
            let proc = GetCurrentProcess();
            // ensure current process is also in the job so nested children are covered
            if let Err(e) = AssignProcessToJobObject(job, proc) {
                // ERROR_ACCESS_DENIED means we're already in a job (enterprise policy / debugger)
                // — log instead of silently ignoring; child is still assigned but grandchildren may survive
                eprintln!("[job] AssignProcessToJobObject(current) failed: {} (already in job? nested children may outlive GUI)", e);
            }
            let h = HANDLE(child.as_raw_handle() as *mut _);
            if let Err(e) = AssignProcessToJobObject(job, h) {
                eprintln!("[job] AssignProcessToJobObject(child) failed: {}", e);
            }
        }
    }
}
#[cfg(not(windows))]
pub(crate) mod job {
    use std::process::Child;
    pub(crate) fn assign(_: &Child) {}
}

pub(crate) fn resolve_opencode_exe(exe_dir: &std::path::Path) -> PathBuf {
    // bundled sidecar next to the GUI exe or dev triple-suffixed name — use centralized candidates
    for name in crate::platform::sidecar_candidates() {
        let p = exe_dir.join(name);
        if p.is_file() {
            eprintln!("[opencode] resolved sidecar: {}", p.display());
            return p;
        }
    }
    // dev: exe is target/debug/opencode-gui(.exe), sidecar lives in src-tauri/binaries
    if let Ok(cur) = std::env::current_exe() {
        let mut anc = cur.parent().map(|p| p.to_owned());
        loop {
            let Some(dir) = anc.clone() else { break };
            for name in crate::platform::sidecar_candidates() {
                let cand = dir.join("src-tauri").join("binaries").join(name);
                if cand.is_file() {
                    eprintln!("[opencode] resolved sidecar: {}", cand.display());
                    return cand;
                }
                let cand2 = dir.join("binaries").join(name);
                if cand2.is_file() {
                    eprintln!("[opencode] resolved sidecar: {}", cand2.display());
                    return cand2;
                }
            }
            let parent = dir.parent().map(|p| p.to_owned());
            if parent.is_none() || parent == anc {
                break;
            }
            anc = parent;
        }
    }
    // last resort: PATH lookup (bare `opencode` + Windows variants)
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in crate::platform::sidecar_candidates() {
                let p = dir.join(name);
                if p.is_file() {
                    eprintln!("[opencode] resolved sidecar via PATH: {}", p.display());
                    return p;
                }
            }
            if cfg!(windows) {
                let p2 = dir.join("opencode.cmd");
                if p2.is_file() {
                    eprintln!("[opencode] resolved sidecar via PATH: {}", p2.display());
                    return p2;
                }
            }
        }
        // also try bare `opencode` explicitly (already in candidates but ensure)
        for dir in std::env::split_paths(&path) {
            let p = dir.join("opencode");
            if p.is_file() {
                eprintln!("[opencode] resolved sidecar via PATH: {}", p.display());
                return p;
            }
        }
    }
    let fallback = exe_dir.join(crate::platform::sidecar_candidates().first().copied().unwrap_or("opencode"));
    eprintln!("[opencode] resolved sidecar fallback: {}", fallback.display());
    fallback
}

/// Poll 127.0.0.1:port until it answers a real HTTP 200 /health with a JSON
/// body (TCP connect alone loses the port-steal race to unrelated services).
pub(crate) fn wait_for_port(port: u16, timeout: std::time::Duration) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Instant;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{port}")) {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(400)));
            let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(400)));
            let req = format!(
                "GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = [0u8; 8192];
                if let Ok(n) = stream.read(&mut buf) {
                    if n > 0 {
                        let resp = String::from_utf8_lossy(&buf[..n]);
                        // EH-07: validate HTTP 200 + JSON payload, not just TCP connect (port-steal race)
                        if resp.contains("200") && resp.contains('{') {
                            std::thread::sleep(std::time::Duration::from_millis(80));
                            return true;
                        }
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

pub(crate) fn spawn_server(workspace: Option<PathBuf>) -> std::io::Result<(Child, u16)> {
    const RETRIES: u32 = 5;
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "exe has no parent"))?
        .to_owned();
    let exe_path = resolve_opencode_exe(&exe_dir);
    let home = crate::platform::home_dir();

    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..RETRIES {
        let port = crate::platform::free_port()?;
        #[cfg(debug_assertions)]
        let mut cmd = Command::new(&exe_path);
        #[cfg(not(debug_assertions))]
        let mut cmd = crate::platform::win_command(&exe_path);
        cmd.args(["serve", "--port", &port.to_string(), "--hostname", "127.0.0.1"]);
        if let Some(ref ws) = workspace {
            if ws.is_dir() {
                cmd.current_dir(ws);
            } else if home.is_dir() {
                cmd.current_dir(&home);
            }
        } else if home.is_dir() {
            cmd.current_dir(&home);
        }
        #[cfg(debug_assertions)]
        let _ = cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        #[cfg(not(debug_assertions))]
        let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < RETRIES { std::thread::sleep(std::time::Duration::from_millis(200)); continue; }
                else { break; }
            }
        };
        job::assign(&child);

        // wait until the server is actually listening; catches port races
        // where the child fails to bind (port taken) and exits early
        let listening = wait_for_port(port, std::time::Duration::from_secs(8));
        // if child died immediately, it's a bind failure — retry on next port
        match child.try_wait() {
            Ok(Some(status)) => {
                last_err = Some(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("opencode exited early on port {port}: {status}"),
                ));
                if attempt + 1 < RETRIES {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    continue;
                } else { break; }
            }
            Ok(None) if !listening => {
                // still not listening but child alive — could be slow start; give it a bit more
                if wait_for_port(port, std::time::Duration::from_secs(3)) {
                    return Ok((child, port));
                }
                let _ = child.kill();
                let _ = child.wait();
                last_err = Some(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("opencode not listening on port {port}"),
                ));
                if attempt + 1 < RETRIES { std::thread::sleep(std::time::Duration::from_millis(300)); continue; }
                else { break; }
            }
            Ok(None) => return Ok((child, port)),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < RETRIES { std::thread::sleep(std::time::Duration::from_millis(200)); continue; }
                else { break; }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "failed to start opencode after retries")))
}

#[tauri::command]
pub fn server_url(state: State<'_, ServerState>) -> Result<String, String> {
    match state.error {
        Some(ref e) => Err(e.clone()),
        None => Ok(format!("http://127.0.0.1:{}", state.port)),
    }
}
