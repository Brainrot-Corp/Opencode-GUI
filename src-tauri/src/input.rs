// Windows-only input repair + cross-instance IPC + global-shortcut routing.
// Everything here exists because WebView2's input pipeline and tao's focus
// tracking desync across hide/show cycles, and because multiple instances
// need one system-wide hotkey target. The module is only declared on
// Windows (lib.rs `#[cfg(windows)] mod input`); the non-Windows
// `resize_cursor` stub lives in lib.rs.

use std::sync::atomic::Ordering;

use tauri::Manager;

use crate::windowctl::{hide_main, show_main, window_focused};

// last focused HWND tracking for system-wide hotkeys across multiple instances
fn last_focused_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("last-focused-hwnd"))
}

pub(crate) fn write_last_focused(app: &tauri::AppHandle, hwnd: isize) {
    if let Some(p) = last_focused_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, hwnd.to_string());
    }
}

pub(crate) fn read_last_focused(app: &tauri::AppHandle) -> Option<isize> {
    last_focused_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse().ok())
}

pub(crate) fn is_opencode_window(hwnd: isize) -> bool {
    // Cheap check: title must be "OpenCode" (our main window title)
    // Use GetWindowTextW via windows crate
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW, IsWindowVisible};
    if hwnd == 0 {
        return false;
    }
    // hidden tray windows are not visible, but foreground check already ensures visible
    // For foreground check, we also want to verify it's an OpenCode window, not just any
    unsafe {
        if IsWindowVisible(windows::Win32::Foundation::HWND(hwnd as *mut _)).as_bool() == false {
            // Still consider hidden? For foreground check, hidden can't be foreground, so false is fine
            // But for is_opencode check, we still want to compare title even if hidden? Not needed
        }
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(windows::Win32::Foundation::HWND(hwnd as *mut _), &mut buf);
        if len == 0 {
            return false;
        }
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        title == "OpenCode"
    }
}

pub(crate) fn send_ipc_to_hwnd(hwnd: isize, dw_data: usize) -> bool {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_COPYDATA};
    if hwnd == 0 {
        return false;
    }
    unsafe {
        let cds = COPYDATASTRUCT {
            dwData: dw_data,
            cbData: 0,
            lpData: std::ptr::null_mut(),
        };
        let res = SendMessageW(
            HWND(hwnd as *mut _),
            WM_COPYDATA,
            WPARAM(0),
            LPARAM(&cds as *const _ as isize),
        );
        res.0 != 0
    }
}

pub(crate) const IPC_TOGGLE: usize = 0x4F4347; // "OCG"
pub(crate) const IPC_MIC: usize = 0x4F434D; // "OCM"
pub(crate) const IPC_SHOW: usize = 0x4F4353; // "OCS" for explicit show (not toggle)

pub(crate) mod ipc_hook {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::sync::atomic::AtomicIsize;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW, GWLP_WNDPROC, WM_COPYDATA,
    };
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;

    static IPC_APP: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
    static ORIGINAL_PROC: AtomicIsize = AtomicIsize::new(0);

    pub fn set_app(app: tauri::AppHandle) {
        let m = IPC_APP.get_or_init(|| Mutex::new(None));
        *m.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_COPYDATA {
            let cds = &*(lparam.0 as *const COPYDATASTRUCT);
            let app_opt = IPC_APP.get().and_then(|m| m.lock().unwrap_or_else(|e| e.into_inner()).clone());
            if let Some(app) = app_opt {
                match cds.dwData as usize {
                    super::IPC_TOGGLE => {
                        let app2 = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            // toggle logic matching global shortcut: hide if visible+focused else show
                            if let Some(w) = app2.get_webview_window("main") {
                                let visible = w.is_visible().unwrap_or(false);
                                let focused = window_focused(&w);
                                if visible && focused {
                                    hide_main(&app2);
                                } else {
                                    show_main(&app2);
                                }
                            }
                        });
                        return LRESULT(1);
                    }
                    super::IPC_MIC => {
                        use tauri::Emitter;
                        let _ = app.emit("mic://toggle", ());
                        return LRESULT(1);
                    }
                    super::IPC_SHOW => {
                        let app2 = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            show_main(&app2);
                        });
                        return LRESULT(1);
                    }
                    _ => {}
                }
            }
        }
        let orig = ORIGINAL_PROC.load(Ordering::Relaxed);
        if orig != 0 {
            CallWindowProcW(
                std::mem::transmute::<isize, windows::Win32::UI::WindowsAndMessaging::WNDPROC>(orig),
                hwnd,
                msg,
                wparam,
                lparam,
            )
        } else {
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }

    pub fn install(app: &tauri::AppHandle) {
        set_app(app.clone());
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(hwnd) = w.hwnd() {
                unsafe {
                    let hwnd_raw = HWND(hwnd.0);
                    let orig = GetWindowLongPtrW(hwnd_raw, GWLP_WNDPROC);
                    ORIGINAL_PROC.store(orig, Ordering::Relaxed);
                    SetWindowLongPtrW(hwnd_raw, GWLP_WNDPROC, wndproc as *const () as usize as isize);
                }
            }
        }
    }
}

// minimal user32 surface for the input repair below (user32 is already
// linked by the tao/webview stack — no extra crate needed)
mod wininput {
    use std::sync::atomic::{AtomicI32, Ordering};

    #[repr(C)]
    pub struct Point {
        pub x: i32,
        pub y: i32,
    }
    extern "system" {
        pub fn GetCursorPos(pt: *mut Point) -> i32;
        pub fn ScreenToClient(hwnd: isize, pt: *mut Point) -> i32;
        pub fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
        pub fn EnumChildWindows(
            hwnd: isize,
            cb: unsafe extern "system" fn(isize, isize) -> i32,
            lparam: isize,
        ) -> i32;
        pub fn SendInput(count: u32, inputs: *mut Input, size: i32) -> u32;
        pub fn SetFocus(hwnd: isize) -> isize;
        pub fn SetForegroundWindow(hwnd: isize) -> i32;
        pub fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
        pub fn IsWindowVisible(hwnd: isize) -> i32;
    }

    // cursor position shared with the EnumChildWindows callbacks — a plain
    // extern fn can't capture anything, so it reads these instead
    pub static CUR_X: AtomicI32 = AtomicI32::new(0);
    pub static CUR_Y: AtomicI32 = AtomicI32::new(0);

    const WM_MOUSEMOVE: u32 = 0x0200;
    const WM_CANCELMODE: u32 = 0x001F;

    // forward the current cursor position to one child HWND so Chromium's
    // hover tracking re-registers (TrackMouseEvent) and :hover recomputes
    pub unsafe extern "system" fn pump_mousemove(child: isize, _lp: isize) -> i32 {
        let mut pt = Point {
            x: CUR_X.load(Ordering::Relaxed),
            y: CUR_Y.load(Ordering::Relaxed),
        };
        ScreenToClient(child, &mut pt);
        let lp = (((pt.y as u16 as usize) << 16) | (pt.x as u16 as usize)) as isize;
        PostMessageW(child, WM_MOUSEMOVE, 0, lp);
        1
    }

    // tell one child HWND to drop any stuck mouse capture / modal input loop.
    // Unlike ReleaseCapture — which only reaches OUR thread — a posted
    // WM_CANCELMODE crosses into the webview process where the stale state
    // actually lives
    pub unsafe extern "system" fn pump_cancelmode(child: isize, _lp: isize) -> i32 {
        PostMessageW(child, WM_CANCELMODE, 0, 0);
        1
    }

    // INPUT/MOUSEINPUT mirror (x64 layout: type + pad + 32-byte MOUSEINPUT)
    #[repr(C)]
    pub struct MouseInput {
        pub dx: i32,
        pub dy: i32,
        pub mouse_data: u32,
        pub dw_flags: u32,
        pub time: u32,
        pub extra_info: usize,
    }
    #[repr(C)]
    pub struct Input {
        pub kind: u32,
        pub pad: u32,
        pub union: MouseInput,
    }

    const INPUT_MOUSE: u32 = 0;
    const MOUSEEVENTF_MOVE: u32 = 0x0001;

    // two REAL relative moves (+1px then -1px) injected through the OS input
    // pipeline. This is what actually clears Chromium's stuck mouse state —
    // genuine WM_MOUSEMOVEs re-run its hit testing and TrackMouseEvent, the
    // same effect as the repairing click users had to perform manually
    pub fn wiggle_cursor() -> bool {
        let mut inputs: [Input; 2] = [
            Input { kind: INPUT_MOUSE, pad: 0, union: MouseInput { dx: 1, dy: 0, mouse_data: 0, dw_flags: MOUSEEVENTF_MOVE, time: 0, extra_info: 0 } },
            Input { kind: INPUT_MOUSE, pad: 0, union: MouseInput { dx: -1, dy: 0, mouse_data: 0, dw_flags: MOUSEEVENTF_MOVE, time: 0, extra_info: 0 } },
        ];
        unsafe {
            SendInput(2, inputs.as_mut_ptr(), std::mem::size_of::<Input>() as i32) == 2
        }
    }

    // focus the WebView2 child HWND directly — SetFocus on the top-level HWND
    // alone doesn't route WM_KEYDOWN into the Chromium process after a
    // hide/show or Alt+Tab cycle. Walk descendants and SetFocus the first
    // Chrome_WidgetWin* (the real webview content host).
    pub unsafe extern "system" fn focus_webview_child(child: isize, _lp: isize) -> i32 {
        // recurse first so deepest Chrome_WidgetWin wins (it is the actual content)
        EnumChildWindows(child, focus_webview_child, 0);
        let mut buf = [0u16; 256];
        let len = GetClassNameW(child, buf.as_mut_ptr(), 256);
        if len > 0 {
            // cheap check: Chrome_WidgetWin* starts with 'C' (67) — avoid alloc if not
            if buf[0] == 67 {
                let name = String::from_utf16_lossy(&buf[..len as usize]);
                if name.starts_with("Chrome_WidgetWin") {
                    // only visible webview should steal focus
                    if IsWindowVisible(child) != 0 {
                        SetFocus(child);
                    }
                }
            }
        }
        1
    }

    pub fn focus_webview(hwnd_main: isize) {
        unsafe {
            SetForegroundWindow(hwnd_main);
            SetFocus(hwnd_main);
            EnumChildWindows(hwnd_main, focus_webview_child, 0);
        }
    }
}

// Hiding + reshowing the window leaves WebView2's input pipeline stuck:
// the webview process keeps a stale mouse capture and never sees a mouse
// ENTER again, so real moves/wheel/hover are swallowed until a real click.
// Repair after every show, in escalating force:
//   1. WM_CANCELMODE to every descendant HWND — drops the stuck capture
//      inside the webview process (cross-process, unlike ReleaseCapture)
//   2. posted WM_MOUSEMOVEs — nudge hover tracking as a cheap first pass
//   3. a REAL SendInput cursor wiggle (+1px/-1px) — genuine OS-level moves
//      that re-run Chromium's hit testing, equivalent to the repairing click
//   4. delayed SetForegroundWindow/SetFocus retries — WebView2 keyboard input
//      stays dead until the HWND truly owns foreground; the first set_focus
//      can land before show() settles (Alt+Space) or not at all (Alt+Tab).
pub(crate) fn unpoison_input(app: &tauri::AppHandle) {
    let hwnd = match app.get_webview_window("main").map(|w| w.hwnd()) {
        Some(Ok(h)) => h.0 as isize,
        _ => return,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri::Emitter;
        // let the show settle before poking at input state
        std::thread::sleep(std::time::Duration::from_millis(60));
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || unsafe {
            // ensure OS focus — first retry (covers show() settling) + direct
            // WebView child focus. w.set_focus() alone leaves WM_KEYDOWN stuck
            // on the outer HWND until a click.
            if let Some(w) = app2.get_webview_window("main") {
                if !window_focused(&w) {
                    let _ = w.set_focus();
                }
            }
            use wininput::*;
            // focus deepest Chrome_WidgetWin so keyboard goes to Chromium
            focus_webview(hwnd);
            EnumChildWindows(hwnd, pump_cancelmode, 0);
            let mut pt = Point { x: 0, y: 0 };
            if GetCursorPos(&mut pt) != 0 {
                CUR_X.store(pt.x, Ordering::Relaxed);
                CUR_Y.store(pt.y, Ordering::Relaxed);
                EnumChildWindows(hwnd, pump_mousemove, 0);
            }
        });
        // tell frontend to re-assert DOM focus (composer textarea → body fallback)
        let _ = app.emit("focus://restore", ());
        // real events through the OS input pipeline — the part that
        // actually clears the webview's stuck state; needs no main thread
        std::thread::sleep(std::time::Duration::from_millis(30));
        if wininput::wiggle_cursor() {
            let _ = app.run_on_main_thread(move || unsafe {
                use wininput::*;
                EnumChildWindows(hwnd, pump_mousemove, 0);
            });
        }
        // second focus retry — by now the window is definitely visible; if we
        // still don't own foreground (Alt+Space race) force it once more so
        // WebView2 delivers WM_KEYDOWN to its child without needing a click
        std::thread::sleep(std::time::Duration::from_millis(70));
        let app3 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app3.get_webview_window("main") {
                if !window_focused(&w) {
                    let _ = w.set_focus();
                } else {
                    // even when focused, a second set_focus nudges WebView2's
                    // internal focus from the outer HWND to the webview child
                    // in cases where mouse capture was stuck
                    let _ = w.set_focus();
                }
            }
            // ensure child still owns keyboard focus after the wiggle
            wininput::focus_webview(hwnd);
        });
        let _ = app.emit("focus://restore", ());
        // final JS-level focus via eval fallback (in case frontend hasn't mounted
        // its listener yet — e.g. first show during setup)
        std::thread::sleep(std::time::Duration::from_millis(30));
        let app4 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app4.get_webview_window("main") {
                let _ = w.eval(
                    "setTimeout(()=>{ try{ window.focus(); var a=document.activeElement; var trapped=a&&a!==document.body&&(a.closest&&a.closest('.term-dock.closed')||!document.contains(a)); if(!a||a===document.body||trapped){ var isTerm=!!window.__oc_lastWasTerm; var term=document.querySelector('.term-dock:not(.closed) .xterm-helper-textarea'); var comp=document.querySelector('.composer textarea'); var f=(isTerm&&term)?term:(comp||term||document.querySelector('.fe-ta')||document.body); if(f){ if(!f.hasAttribute('tabindex')&&f===document.body) f.setAttribute('tabindex','-1'); f.focus({preventScroll:true}); } } else { try{a.focus({preventScroll:true});}catch(e){} } window.focus(); }catch(e){} }, 0)",
                );
            }
        });
    });
}

// Alt+Tab / taskbar / tray reactivation leaves keyboard input dead until a
// click. Root cause (tauri#15624): with the `unstable` feature the main
// webview is built as a child webview, so wry never attaches its parent
// subclass (WM_SETFOCUS -> MoveFocus) — and on reactivation focus can land
// directly on the WebView2 child HWND, so the top-level never sees
// WM_SETFOCUS and no repair runs. Fixed upstream in tauri#15625 / wry#1755,
// not yet released (tauri 2.11.5 is current) — this is that fix, app-side:
// subclass the top-level for WM_ACTIVATE and re-seed the controller with
// MoveFocus(PROGRAMMATIC). The MoveFocus must be DEFERRED via a posted
// message: issued synchronously inside WM_ACTIVATE it gets overwritten when
// Windows subsequently restores focus to the webview child. WA_INACTIVE is
// skipped so only activation edges re-seed; the posted message cannot
// re-enter WM_ACTIVATE, so no focus loop.
pub(crate) mod webfocus {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
    };

    const WM_ACTIVATE: u32 = 0x0006;
    const WA_INACTIVE: u16 = 0;
    // WM_APP range — nothing else in this app uses it for the main window
    const MSG_REFOCUS: u32 = 0x8000 + 0x5043; // WM_APP + 'PC'
    const SUBCLASS_ID: usize = 0x0C47; // 'OC'

    type LRESULT = isize;
    type SubclassProc = unsafe extern "system" fn(
        hwnd: isize,
        msg: u32,
        wparam: usize,
        lparam: isize,
        id: usize,
        data: usize,
    ) -> LRESULT;

    extern "system" {
        fn SetWindowSubclass(hwnd: isize, proc: SubclassProc, id: usize, data: usize) -> i32;
        fn DefSubclassProc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> LRESULT;
        fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    }

    unsafe extern "system" fn proc(
        hwnd: isize,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        if msg == WM_ACTIVATE {
            // let normal activation routing run first...
            let r = DefSubclassProc(hwnd, msg, wparam, lparam);
            if (wparam as u16) != WA_INACTIVE {
                // immediate child focus attempt — the deferred MoveFocus alone is
                // one message loop late, so the very first keydown after Alt+Tab
                // would hit the outer HWND, be swallowed and cause a Windows beep.
                // Best-effort synchronous SetFocus on the Chrome_WidgetWin child
                // plus the deferred MoveFocus covers both immediate and settled.
                let _ = std::panic::catch_unwind(|| {
                    super::wininput::focus_webview(hwnd);
                });
                PostMessageW(hwnd, MSG_REFOCUS, 0, 0);
            }
            return r;
        }
        if msg == MSG_REFOCUS {
            let controller = data as *mut ICoreWebView2Controller;
            if !controller.is_null() {
                let _ = (*controller).MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            }
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    // attach on the main thread once the main window exists; the controller
    // is handed to the subclass and lives as long as the window
    pub fn install(window: &tauri::WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        let h = hwnd.0 as isize;
        let _ = window.with_webview(move |wv| {
            let data = Box::into_raw(Box::new(wv.controller())) as usize;
            unsafe {
                SetWindowSubclass(h, proc, SUBCLASS_ID, data);
            }
        });
    }
}

// Sidebar drag/hover cursor must match the user's live Windows pointer scheme
// (custom schemes included). WebView2 ignores the scheme for CSS cursors and
// paints stock bitmaps, so pull the real IDC_SIZEWE handle, pack it into a
// .cur file and ship it to the DOM as a data URL. None → frontend keeps its
// bundled fallback.
#[tauri::command]
pub fn resize_cursor() -> Option<serde_json::Value> {
    #[repr(C)]
    struct IconInfo {
        f_icon: i32,
        x_hotspot: u32,
        y_hotspot: u32,
        hbm_mask: isize,
        hbm_color: isize,
    }
    #[repr(C)]
    struct Bitmap {
        bm_type: i32,
        bm_width: i32,
        bm_height: i32,
        bm_width_bytes: i32,
        bm_planes: u16,
        bm_bits_pixel: u16,
        bm_bits: isize,
    }
    #[repr(C)]
    struct BmiHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
    }
    #[repr(C)]
    struct Bmi {
        header: BmiHeader,
        colors: [u32; 3],
    }

    extern "system" {
        fn LoadCursorW(hinstance: isize, name: *const u16) -> isize;
        fn GetIconInfo(icon: isize, info: *mut IconInfo) -> i32;
        fn GetObjectW(obj: isize, cb: i32, out: *mut Bitmap) -> i32;
        fn GetDIBits(dc: isize, bmp: isize, start: u32, lines: u32, bits: *mut u8, bmi: *mut Bmi, usage: u32) -> i32;
        fn GetDC(hwnd: isize) -> isize;
        fn ReleaseDC(hwnd: isize, dc: isize) -> i32;
        fn DeleteObject(obj: isize) -> i32;
    }

    unsafe {
        // IDC_SIZEWE — resolves through the active pointer scheme
        let hc = LoadCursorW(0, 32644usize as *const u16);
        if hc == 0 {
            return None;
        }
        let mut ii: IconInfo = std::mem::zeroed();
        if GetIconInfo(hc, &mut ii) == 0 {
            return None;
        }
        let _ = DeleteObject(ii.hbm_color);
        let _ = DeleteObject(ii.hbm_mask);

        // mask bitmap height = color + AND halves, so /2 is the real height
        let mut mbm: Bitmap = std::mem::zeroed();
        if GetObjectW(ii.hbm_mask, std::mem::size_of::<Bitmap>() as i32, &mut mbm) == 0 {
            return None;
        }
        let (w, h) = (mbm.bm_width, mbm.bm_height / 2);
        if w <= 0 || h <= 0 || w > 256 || h > 256 {
            return None;
        }

        let dc = GetDC(0);
        if dc == 0 {
            return None;
        }
        let mut px = vec![0u8; (w * h * 4) as usize];
        let mut bmi: Bmi = std::mem::zeroed();
        bmi.header = BmiHeader {
            size: std::mem::size_of::<BmiHeader>() as u32,
            width: w,
            height: -h, // top-down
            planes: 1,
            bit_count: 32,
            compression: 0, // BI_RGB
            size_image: px.len() as u32,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let ok_px =
            GetDIBits(dc, ii.hbm_color, 0, h as u32, px.as_mut_ptr(), &mut bmi, 0) == h;

        let mstride = (((w + 31) / 32) * 4) as usize;
        let mut mask = vec![0u8; mstride * h as usize];
        let mut mbmi: Bmi = std::mem::zeroed();
        mbmi.header = BmiHeader {
            size: std::mem::size_of::<BmiHeader>() as u32,
            width: w,
            height: h,
            planes: 1,
            bit_count: 1,
            compression: 0,
            size_image: mask.len() as u32,
            x_ppm: 0,
            y_ppm: 0,
            clr_used: 0,
            clr_important: 0,
        };
        let ok_mask =
            GetDIBits(dc, ii.hbm_mask, 0, h as u32, mask.as_mut_ptr(), &mut mbmi, 0) == h;
        ReleaseDC(0, dc);
        if !ok_px {
            return None;
        }

        // schemes without per-pixel alpha encode transparency in the AND
        // mask — bake it into alpha so one code path serves both
        if !px.chunks_exact(4).any(|p| p[3] != 0) && ok_mask {
            for y in 0..h as usize {
                for x in 0..w as usize {
                    // AND mask rows arrive bottom-up
                    let opaque = (mask[(h as usize - 1 - y) * mstride + x / 8]
                        >> (7 - x % 8))
                        & 1
                        == 0;
                    if opaque {
                        px[(y * w as usize + x) * 4 + 3] = 255;
                    }
                }
            }
        }

        // pack as .cur: ICONDIR + entry + BITMAPINFOHEADER + bottom-up BGRA
        // + all-zero AND mask (alpha now decides everything)
        let mut out = Vec::with_capacity(22 + 40 + px.len() + mask.len());
        out.extend([0u8, 0, 2, 0, 1, 0]); // type 2 = cursor, count 1
        out.extend([w as u8, h as u8, 0, 0]);
        out.extend((ii.x_hotspot as u16).to_le_bytes());
        out.extend((ii.y_hotspot as u16).to_le_bytes());
        out.extend(((40 + px.len() + mask.len()) as u32).to_le_bytes());
        out.extend(22u32.to_le_bytes()); // pixel data offset
        out.extend(40u32.to_le_bytes());
        out.extend(w.to_le_bytes());
        out.extend(((h * 2) as i32).to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(32u16.to_le_bytes());
        out.extend([0u8; 24]); // BI_RGB + sizeimage + ppms + clr fields
        let w4 = (w * 4) as usize;
        for row in (0..h as usize).rev() {
            out.extend_from_slice(&px[row * w4..(row + 1) * w4]);
        }
        out.resize(out.capacity(), 0); // trailing zero AND mask

        use base64::Engine as _;
        Some(serde_json::json!({
            "url": format!("data:image/x-icon;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out)),
            "x": ii.x_hotspot,
            "y": ii.y_hotspot,
        }))
    }
}

// global-hotkey router (Alt+Space toggle / Ctrl+Shift+M mic) — registered
// per-combo in lib.rs setup. The IPC/last-focused plumbing above makes the
// hotkey hit the right instance system-wide.
pub(crate) fn handle_global_shortcut(
    app: &tauri::AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    // Windows auto-repeats held hotkeys (WM_HOTKEY ~33ms apart after
    // ~500ms hold) — act only on FRESH presses: ones where this key
    // was physically released since its previous press
    use std::sync::Mutex;
    static HELD: Mutex<Option<u32>> = Mutex::new(None);
    let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
    match event.state() {
        tauri_plugin_global_shortcut::ShortcutState::Released => {
            if *held == Some(event.id) {
                *held = None;
            }
            return;
        }
        tauri_plugin_global_shortcut::ShortcutState::Pressed => {
            let prev = held.replace(event.id);
            if prev == Some(event.id) {
                return; // auto-repeat of a key still held down
            }
        }
    }
    drop(held);
    // shortcut.to_string() renders "shift+control+KeyM" style —
    // never equal to the registered spelling, so compare parsed
    let Ok(mic): Result<tauri_plugin_global_shortcut::Shortcut, _> = "ctrl+shift+m".parse() else { return; };
    if *shortcut == mic {
        // mic toggle — forward to last focused instance if different
        {
            let my_hwnd = app
                .get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as isize)
                .unwrap_or(0);
            let fg = unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize
            };
            let target = if fg != 0 && is_opencode_window(fg) {
                Some(fg)
            } else {
                read_last_focused(app)
            };
            if let Some(t) = target {
                if t != my_hwnd && t != 0 && send_ipc_to_hwnd(t, IPC_MIC) {
                    return;
                }
            }
            use tauri::Emitter;
            let _ = app.emit("mic://toggle", ());
        }
    } else {
        // Alt+Space toggle — apply to last focused instance system-wide
        {
            let my_hwnd = app
                .get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as isize)
                .unwrap_or(0);
            let fg = unsafe {
                windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize
            };
            let target = if fg != 0 && is_opencode_window(fg) {
                Some(fg)
            } else {
                read_last_focused(app)
            };
            if let Some(t) = target {
                if t != my_hwnd && t != 0 {
                    if send_ipc_to_hwnd(t, IPC_TOGGLE) {
                        return;
                    }
                    // SendMessage failed (target closed), fallback to self
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let visible = w.is_visible().unwrap_or(false);
                let focused = window_focused(&w);
                if visible && focused {
                    hide_main(app);
                } else {
                    show_main(app);
                }
            }
        }
    }
}
