//! Game identification. Matches the foreground window's process (and, as a fallback,
//! any running process) against an extensible executable-name database. Detection only
//! reads process names — no injection, hooks or drivers.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::settings::CustomGame;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEntry {
    pub id: String,
    pub name: String,
    pub executables: Vec<String>,
    #[serde(default)]
    pub window_title_prefixes: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct GameDbFile {
    games: Vec<GameEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGame {
    pub id: Option<String>,
    pub name: String,
    pub executable: String,
    pub pid: u32,
    /// The game's top-level window when it is in the foreground.
    pub hwnd: Option<u64>,
}

#[derive(Debug, Default)]
pub struct GameDb {
    games: Vec<GameEntry>,
    by_exe: HashMap<String, usize>,
}

impl GameDb {
    pub fn load(path: &Path, custom: &[CustomGame]) -> Self {
        let mut games = match std::fs::read(path).map(|b| serde_json::from_slice::<GameDbFile>(&b)) {
            Ok(Ok(f)) => f.games,
            Ok(Err(e)) => {
                tracing::warn!("game database is invalid: {e}");
                Vec::new()
            }
            Err(e) => {
                tracing::warn!("game database missing at {}: {e}", path.display());
                Vec::new()
            }
        };
        for c in custom {
            let name = c.name.trim();
            // Accept a bare name or a full path in either separator style.
            let exe = c.executable.trim().rsplit(['/', '\\']).next().unwrap_or("").to_string();
            if !name.is_empty() && !exe.is_empty() {
                games.push(GameEntry {
                    id: format!("custom:{}", exe.to_ascii_lowercase()),
                    name: name.to_string(),
                    executables: vec![exe],
                    window_title_prefixes: Vec::new(),
                });
            }
        }
        Self::from_entries(games)
    }

    pub fn from_entries(games: Vec<GameEntry>) -> Self {
        let mut by_exe = HashMap::new();
        // Later entries (custom games) override built-in ones.
        for (i, g) in games.iter().enumerate() {
            for exe in &g.executables {
                by_exe.insert(exe.to_ascii_lowercase(), i);
            }
        }
        Self { games, by_exe }
    }

    pub fn entries(&self) -> &[GameEntry] {
        &self.games
    }

    pub fn match_process(&self, exe_name: &str, window_title: Option<&str>) -> Option<&GameEntry> {
        if let Some(i) = self.by_exe.get(&exe_name.to_ascii_lowercase()) {
            return self.games.get(*i);
        }
        let title = window_title?;
        self.games
            .iter()
            .find(|g| g.window_title_prefixes.iter().any(|p| title.starts_with(p.as_str())))
    }
}

/// Process information gathered for detection.
#[derive(Debug, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub exe_name: String,
    pub window_title: Option<String>,
    pub hwnd: Option<u64>,
}

/// Prefers the foreground process; otherwise picks any running known game.
pub fn detect(db: &GameDb, foreground: Option<&ProcessInfo>, running: &[ProcessInfo]) -> Option<DetectedGame> {
    let to_detected = |p: &ProcessInfo, g: &GameEntry, hwnd: Option<u64>| DetectedGame {
        id: Some(g.id.clone()),
        name: g.name.clone(),
        executable: p.exe_name.clone(),
        pid: p.pid,
        hwnd,
    };
    if let Some(fg) = foreground {
        if let Some(g) = db.match_process(&fg.exe_name, fg.window_title.as_deref()) {
            return Some(to_detected(fg, g, fg.hwnd));
        }
    }
    running
        .iter()
        .find_map(|p| db.match_process(&p.exe_name, None).map(|g| to_detected(p, g, None)))
}

pub fn running_processes(system: &mut sysinfo::System) -> Vec<ProcessInfo> {
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .processes()
        .iter()
        .map(|(pid, p)| ProcessInfo {
            pid: pid.as_u32(),
            exe_name: p.name().to_string_lossy().into_owned(),
            window_title: None,
            hwnd: None,
        })
        .collect()
}

#[cfg(windows)]
pub fn foreground_process() -> Option<ProcessInfo> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(process);
        ok.ok()?;
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        let exe_name = Path::new(&full).file_name()?.to_string_lossy().into_owned();
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title);
        let window_title = (n > 0).then(|| String::from_utf16_lossy(&title[..n as usize]));
        Some(ProcessInfo { pid, exe_name, window_title, hwnd: Some(hwnd.0 as u64) })
    }
}

#[cfg(not(windows))]
pub fn foreground_process() -> Option<ProcessInfo> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> GameDb {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/games.json");
        GameDb::load(&path, &[CustomGame { name: "My Indie Game".into(), executable: r"C:\Games\Indie\indie.exe".into() }])
    }

    fn proc(pid: u32, exe: &str, title: Option<&str>, hwnd: Option<u64>) -> ProcessInfo {
        ProcessInfo { pid, exe_name: exe.into(), window_title: title.map(Into::into), hwnd }
    }

    #[test]
    fn bundled_database_loads() {
        let db = db();
        assert!(db.entries().len() > 40);
        assert_eq!(db.match_process("cs2.exe", None).unwrap().name, "Counter-Strike 2");
        assert_eq!(db.match_process("VALORANT-WIN64-SHIPPING.EXE", None).unwrap().id, "valorant");
        assert_eq!(db.match_process("indie.exe", None).unwrap().name, "My Indie Game");
        assert_eq!(db.match_process("javaw.exe", Some("Minecraft 1.21.4")).unwrap().id, "minecraft");
        assert!(db.match_process("chrome.exe", Some("YouTube")).is_none());
    }

    #[test]
    fn prefers_foreground_game() {
        let db = db();
        let running = vec![proc(1, "explorer.exe", None, None), proc(2, "dota2.exe", None, None), proc(3, "cs2.exe", None, None)];
        let fg = proc(3, "cs2.exe", Some("Counter-Strike 2"), Some(99));
        let d = detect(&db, Some(&fg), &running).unwrap();
        assert_eq!((d.name.as_str(), d.hwnd), ("Counter-Strike 2", Some(99)));
        let browser = proc(4, "firefox.exe", Some("Mozilla Firefox"), Some(5));
        let d = detect(&db, Some(&browser), &running).unwrap();
        assert_eq!((d.name.as_str(), d.hwnd), ("Dota 2", None));
        assert!(detect(&db, Some(&browser), &[]).is_none());
    }
}

/// Detection state shared with the UI and the recorder.
#[derive(Default)]
pub struct GameService {
    pub db: parking_lot::RwLock<GameDb>,
    pub detected: parking_lot::RwLock<Option<DetectedGame>>,
    /// Game chosen manually in the UI; overrides detection. Not persisted.
    pub manual: parking_lot::RwLock<Option<String>>,
}

impl GameService {
    /// (game id, display name) to tag new clips with.
    pub fn current(&self) -> (Option<String>, Option<String>) {
        if let Some(name) = self.manual.read().clone() {
            let id = self.db.read().entries().iter().find(|g| g.name == name).map(|g| g.id.clone());
            return (id, Some(name));
        }
        match self.detected.read().as_ref() {
            Some(d) => (d.id.clone(), Some(d.name.clone())),
            None => (None, None),
        }
    }

    pub fn foreground_hwnd(&self) -> Option<u64> {
        self.detected.read().as_ref().and_then(|d| d.hwnd)
    }
}
