//! Global hotkeys (work while a game has focus).

use std::collections::HashMap;
use std::str::FromStr;

use parking_lot::RwLock;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::error::{AppError, AppResult};
use crate::recorder;
use crate::settings::{HotkeyAction, HotkeySettings};

#[derive(Default)]
pub struct HotkeyMap(RwLock<HashMap<u32, HotkeyAction>>);

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let Some(action) = app
                .try_state::<HotkeyMap>()
                .and_then(|m| m.0.read().get(&shortcut.id()).copied())
            else {
                return;
            };
            let app = app.clone();
            std::thread::spawn(move || {
                let result = match action {
                    HotkeyAction::SaveReplay => recorder::save_replay(&app, None).map(|_| ()),
                    HotkeyAction::ToggleRecording => recorder::toggle_recording(&app),
                    HotkeyAction::PauseRecording => recorder::toggle_pause(&app),
                    HotkeyAction::ToggleReplay => recorder::toggle_replay(&app),
                    HotkeyAction::ToggleMicMute => recorder::toggle_mic_mute(&app),
                };
                if let Err(e) = result {
                    tracing::warn!("hotkey {action:?} failed: {e}");
                    let _ = app.emit("app-error", e.to_string());
                }
            });
        })
        .build()
}

pub fn parse(accelerator: &str) -> AppResult<Shortcut> {
    Shortcut::from_str(accelerator)
        .map_err(|e| AppError::Invalid(format!("invalid hotkey “{accelerator}”: {e}")))
}

/// Registers all configured hotkeys, replacing previous registrations. Returns the
/// hotkeys that could not be registered (e.g. already taken by another program).
pub fn apply(app: &AppHandle, settings: &HotkeySettings) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let map = app.state::<HotkeyMap>();
    let mut map = map.0.write();
    map.clear();
    let mut failed = Vec::new();
    for (action, accel) in settings.entries() {
        match parse(accel).and_then(|s| {
            gs.register(s)
                .map(|_| s)
                .map_err(|e| AppError::Invalid(e.to_string()))
        }) {
            Ok(shortcut) => {
                map.insert(shortcut.id(), action);
            }
            Err(e) => {
                tracing::warn!("could not register hotkey {accel}: {e}");
                failed.push(accel.to_string());
            }
        }
    }
    failed
}
