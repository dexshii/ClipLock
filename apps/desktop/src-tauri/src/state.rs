use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;

use crate::cloud::Cloud;
use crate::games::GameService;
use crate::paths::AppPaths;
use crate::recorder::Recorder;
use crate::settings::AppSettings;
use crate::uploads::Uploads;

/// Everything shared between commands, hotkeys, the tray and background threads.
pub struct AppState {
    pub paths: AppPaths,
    pub settings: RwLock<AppSettings>,
    pub db: Mutex<Connection>,
    pub recorder: Recorder,
    pub games: GameService,
    pub cloud: Cloud,
    pub uploads: Uploads,
}
