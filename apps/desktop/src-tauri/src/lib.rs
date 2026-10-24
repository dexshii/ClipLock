//! ClipLock desktop application.

mod cloud;
mod commands;
mod commands_cloud;
mod db;
mod error;
mod games;
mod hotkeys;
mod logging;
mod paths;
mod recorder;
mod settings;
mod sound;
mod state;
mod tray;
mod updates;
mod uploads;
mod util;

use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

use crate::games::{GameDb, GameService};
use crate::paths::AppPaths;
use crate::settings::AppSettings;
use crate::state::AppState;

struct LogGuard(#[allow(dead_code)] Option<tracing_appender::non_blocking::WorkerGuard>);

/// Stops capture cleanly (finalizing any recording) and exits.
pub fn quit(app: &AppHandle) {
    if let Some(st) = app.try_state::<AppState>() {
        st.recorder.shutdown();
    }
    app.exit(0);
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let paths = AppPaths::resolve(&handle)?;
    app.manage(LogGuard(logging::init(&paths.log_dir)));
    tracing::info!("ClipLock {} starting", app.package_info().version);

    let settings = AppSettings::load(&paths.config_dir);
    let clips_dir = settings.clips_dir(&paths.default_clips_dir);
    std::fs::create_dir_all(&clips_dir)?;
    app.asset_protocol_scope()
        .allow_directory(&clips_dir, true)?;
    app.asset_protocol_scope()
        .allow_directory(&paths.thumbnails_dir, true)?;

    let conn = db::open(&paths.data_dir.join("cliplock.db"))?;
    let game_db = GameDb::load(
        &paths.resource("games.json"),
        &settings.general.custom_games,
    );
    app.manage(hotkeys::HotkeyMap::default());
    let cloud = cloud::Cloud::new();
    cloud.set_server(&settings.uploads.server_url);
    app.manage(AppState {
        paths,
        settings: RwLock::new(settings.clone()),
        db: Mutex::new(conn),
        recorder: Default::default(),
        games: GameService {
            db: RwLock::new(game_db),
            ..Default::default()
        },
        cloud,
        uploads: uploads::Uploads::start(handle.clone()),
    });

    tray::create(&handle)?;
    let failed = hotkeys::apply(&handle, &settings.hotkeys);
    if !failed.is_empty() {
        tracing::warn!("hotkeys unavailable: {failed:?}");
    }
    let autostart = handle.autolaunch();
    if autostart.is_enabled().unwrap_or(false) != settings.general.launch_on_startup {
        let _ = if settings.general.launch_on_startup {
            autostart.enable()
        } else {
            autostart.disable()
        };
    }

    let launched_minimized = std::env::args().any(|a| a == "--minimized");
    if !(settings.general.start_minimized || launched_minimized) {
        tray::show_main_window(&handle);
    }

    recorder::initialize(handle.clone(), false);
    if !settings.uploads.server_url.is_empty() {
        let app = handle.clone();
        tauri::async_runtime::spawn(async move {
            match app.state::<AppState>().cloud.restore().await {
                Ok(Some(user)) => {
                    tracing::info!(
                        "signed in to {} as {}",
                        app.state::<AppState>().settings.read().uploads.server_url,
                        user.display_name
                    );
                    uploads::resume_interrupted(&app);
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("could not restore cloud session: {e}"),
            }
        });
    }
    start_game_detection(handle);
    Ok(())
}

fn start_game_detection(app: AppHandle) {
    std::thread::Builder::new()
        .name("cliplock-game-detect".into())
        .spawn(move || {
            let mut system = sysinfo::System::new();
            let mut running = Vec::new();
            let mut last_scan: Option<Instant> = None;
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let st = app.state::<AppState>();
                if !st.settings.read().general.game_detection {
                    if st.games.detected.write().take().is_some() {
                        recorder::emit_state(&app);
                    }
                    continue;
                }
                if last_scan.is_none_or(|t| t.elapsed() > Duration::from_secs(10)) {
                    running = games::running_processes(&mut system);
                    last_scan = Some(Instant::now());
                }
                let fg = games::foreground_process();
                let detected = games::detect(&st.games.db.read(), fg.as_ref(), &running);
                let previous = st.games.detected.read().clone();
                if detected != previous {
                    let window_changed = detected.as_ref().and_then(|d| d.hwnd)
                        != previous.as_ref().and_then(|d| d.hwnd)
                        && detected.as_ref().is_some_and(|d| d.hwnd.is_some());
                    if let Some(d) = &detected {
                        if previous.as_ref().map(|p| &p.name) != Some(&d.name) {
                            tracing::info!("detected game: {} ({})", d.name, d.executable);
                        }
                    }
                    *st.games.detected.write() = detected;
                    recorder::emit_state(&app);
                    if window_changed {
                        recorder::on_game_window_changed(&app);
                    }
                }
            }
        })
        .expect("spawn game detection thread");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app)
        }))
        .plugin(hotkeys::plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(setup)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let st = app.state::<AppState>();
                let close_to_tray = st.settings.read().general.close_to_tray;
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                    static TOLD: std::sync::Once = std::sync::Once::new();
                    TOLD.call_once(|| {
                        let _ = app
                            .notification()
                            .builder()
                            .title("ClipLock is still running")
                            .body(
                                "Capture continues in the system tray. Use the tray menu to quit.",
                            )
                            .show();
                    });
                } else {
                    quit(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::open_log_dir,
            commands::quit_app,
            commands::get_settings,
            commands::update_settings,
            commands::get_recorder_state,
            commands::start_replay,
            commands::stop_replay,
            commands::save_replay,
            commands::start_recording,
            commands::stop_recording,
            commands::toggle_pause,
            commands::set_mic_muted,
            commands::reprobe_hardware,
            commands::list_audio_devices,
            commands::list_games,
            commands::set_manual_game,
            commands::list_clips,
            commands::list_clip_games,
            commands::get_clip,
            commands::update_clip,
            commands::delete_clip,
            commands::reveal_clip,
            commands::export_clip,
            commands::storage_info,
            commands::regenerate_thumbnail,
            commands::export_edit,
            commands_cloud::cloud_status,
            commands_cloud::cloud_server_info,
            commands_cloud::cloud_register,
            commands_cloud::cloud_login,
            commands_cloud::cloud_restore,
            commands_cloud::cloud_logout,
            commands_cloud::cloud_update_profile,
            commands_cloud::cloud_usage,
            commands_cloud::cloud_delete_account,
            commands_cloud::cloud_list_clips,
            commands_cloud::upload_clip,
            commands_cloud::cancel_upload,
            commands_cloud::set_cloud_visibility,
            commands_cloud::delete_cloud_copy,
            updates::check_for_update,
            updates::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ClipLock");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(st) = app.try_state::<AppState>() {
                st.recorder.shutdown();
            }
        }
    });
}
