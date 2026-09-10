// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;

// SSH_ASKPASS self-helper: when OpenSSH needs a password it runs
// `$SSH_ASKPASS` (our own exe) with this env var pointing at a 0600 temp
// file holding the password. Print it and exit before any GUI/singleton
// init — no window, no second-instance handshake, ~ms lifetime.
// (Release is windows_subsystem="windows", but inherited pipes from ssh
// still work — the flag only skips auto-allocating a console.)
fn maybe_askpass() -> bool {
    let Ok(file) = std::env::var("OC_SSH_ASKPASS_FILE") else {
        return false;
    };
    if let Ok(bytes) = std::fs::read(&file) {
        let _ = std::io::stdout().write_all(&bytes);
    }
    true
}

fn main() {
    if maybe_askpass() {
        return;
    }
    oc_gui_lib::run()
}
