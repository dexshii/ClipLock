//! System tray icon and menu. The tray stays available while the window is hidden so
//! capture can be controlled (and is always visibly indicated) from the taskbar.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::recorder;
use crate::state::AppState;

const TRAY_ID: &str = "main";

pub struct TrayMenu {
    replay: MenuItem<Wry>,
    save: MenuItem<Wry>,
    record: MenuItem<Wry>,
}

fn icon(recording: bool) -> Image<'static> {
    let bytes: &[u8] = if recording {
        include_bytes!("../icons/tray-recording.png")
    } else {
        include_bytes!("../icons/tray.png")
    };
    Image::from_bytes(bytes).expect("bundled tray icon is a valid PNG")
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn report(app: &AppHandle, result: crate::error::AppResult<impl Sized>) {
    if let Err(e) = result {
        tracing::warn!("tray action failed: {e}");
        let _ = tauri::Emitter::emit(app, "app-error", e.to_string());
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open ClipLock", true, None::<&str>)?;
    let replay = MenuItem::with_id(app, "replay", "Turn on Instant Replay", true, None::<&str>)?;
    let save = MenuItem::with_id(app, "save", "Save replay", false, None::<&str>)?;
    let record = MenuItem::with_id(app, "record", "Start recording", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ClipLock", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &replay,
            &save,
            &record,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(false))
        .tooltip("ClipLock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let app = app.clone();
            let id = event.id.as_ref().to_string();
            // Capture actions can block for a moment; keep the tray responsive.
            std::thread::spawn(move || match id.as_str() {
                "show" => show_main_window(&app),
                "replay" => report(&app, recorder::toggle_replay(&app)),
                "save" => report(&app, recorder::save_replay(&app, None)),
                "record" => report(&app, recorder::toggle_recording(&app)),
                "quit" => crate::quit(&app),
                _ => {}
            });
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayMenu {
        replay,
        save,
        record,
    });
    Ok(())
}

/// Updates icon, tooltip and menu labels to reflect the capture state.
pub fn refresh(app: &AppHandle) {
    let st = app.state::<AppState>();
    let status = st.recorder.engine().ok().map(|e| e.status());
    let replay_on = status.as_ref().is_some_and(|s| s.replay.is_some());
    let recording = status.as_ref().and_then(|s| s.recording.clone());
    let capturing = replay_on || recording.is_some();

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(icon(capturing)));
        let tooltip = match (&recording, replay_on) {
            (Some(r), _) if r.paused => "ClipLock — recording paused".to_string(),
            (Some(_), _) => "ClipLock — recording".to_string(),
            (None, true) => {
                let hotkey = st
                    .settings
                    .read()
                    .hotkeys
                    .save_replay
                    .clone()
                    .unwrap_or_default();
                format!("ClipLock — Instant Replay on ({hotkey} to save)")
            }
            (None, false) => "ClipLock — idle".to_string(),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu.replay.set_text(if replay_on {
            "Turn off Instant Replay"
        } else {
            "Turn on Instant Replay"
        });
        let _ = menu.save.set_enabled(replay_on);
        let _ = menu.record.set_text(if recording.is_some() {
            "Stop recording"
        } else {
            "Start recording"
        });
    }
}
