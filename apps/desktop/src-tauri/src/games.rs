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
        let mut games = match std::fs::read(path).map(|b| serde_json::from_slice::<GameDbFile>(&b))
        {
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
            let exe = c
                .executable
                .trim()
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .to_string();
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
        self.games.iter().find(|g| {
            g.window_title_prefixes
                .iter()
                .any(|p| title.starts_with(p.as_str()))
        })
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
pub fn detect(
    db: &GameDb,
    foreground: Option<&ProcessInfo>,
    running: &[ProcessInfo],
) -> Option<DetectedGame> {
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
    running.iter().find_map(|p| {
        db.match_process(&p.exe_name, None)
            .map(|g| to_detected(p, g, None))
    })
}

/// A visible top-level application window.
#[derive(Debug, Clone, PartialEq)]
pub struct AppWindow {
    pub pid: u32,
    pub hwnd: u64,
    pub title: String,
}

/// Visible, titled, unowned top-level windows of other processes (what a user would
/// call "open apps"), in Z order. Tool windows and cloaked (hidden UWP) windows are skipped.
#[cfg(windows)]
pub fn open_windows() -> Vec<AppWindow> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = unsafe { &mut *(lparam.0 as *mut Vec<AppWindow>) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok() {
                return BOOL(1);
            }
            if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }
            let mut cloaked = 0u32;
            let cloaked_ok = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
            .is_ok();
            if cloaked_ok && cloaked != 0 {
                return BOOL(1);
            }
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return BOOL(1);
            }
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, &mut buf);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 && pid != std::process::id() && n > 0 {
                out.push(AppWindow {
                    pid,
                    hwnd: hwnd.0 as u64,
                    title: String::from_utf16_lossy(&buf[..n as usize]),
                });
            }
        }
        BOOL(1)
    }

    let mut windows: Vec<AppWindow> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            LPARAM(&mut windows as *mut Vec<AppWindow> as isize),
        );
    }
    windows
}

#[cfg(not(windows))]
pub fn open_windows() -> Vec<AppWindow> {
    Vec::new()
}

/// An application the user can pick as the capture target: a running known game or
/// another program with an open window.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    pub name: String,
    pub executable: String,
    pub pid: u32,
    pub hwnd: Option<u64>,
    pub game_id: Option<String>,
}

/// Windows of shell and system processes, never useful as a capture target.
const NOT_APPS: &[&str] = &[
    "explorer.exe",
    "applicationframehost.exe",
    "textinputhost.exe",
    "systemsettings.exe",
    "searchhost.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "lockapp.exe",
    "cliplock-desktop.exe",
    "cliplock.exe",
];

pub fn window_for_pid(windows: &[AppWindow], pid: u32) -> Option<u64> {
    windows.iter().find(|w| w.pid == pid).map(|w| w.hwnd)
}

/// Running known games first, then other programs with a visible window. Only what is
/// actually running is listed.
pub fn running_apps(
    db: &GameDb,
    processes: &[ProcessInfo],
    windows: &[AppWindow],
) -> Vec<RunningApp> {
    let mut games: Vec<RunningApp> = Vec::new();
    for p in processes {
        let title = windows
            .iter()
            .find(|w| w.pid == p.pid)
            .map(|w| w.title.as_str());
        if let Some(g) = db.match_process(&p.exe_name, title) {
            if !games
                .iter()
                .any(|a| a.game_id.as_deref() == Some(g.id.as_str()))
            {
                games.push(RunningApp {
                    name: g.name.clone(),
                    executable: p.exe_name.clone(),
                    pid: p.pid,
                    hwnd: window_for_pid(windows, p.pid),
                    game_id: Some(g.id.clone()),
                });
            }
        }
    }
    let exe_of = |pid: u32| {
        processes
            .iter()
            .find(|p| p.pid == pid)
            .map(|p| p.exe_name.clone())
    };
    let mut others: Vec<RunningApp> = Vec::new();
    for w in windows {
        if games.iter().chain(others.iter()).any(|a| a.pid == w.pid) {
            continue;
        }
        let Some(exe) = exe_of(w.pid) else { continue };
        if NOT_APPS.contains(&exe.to_ascii_lowercase().as_str()) {
            continue;
        }
        let name: String = w.title.chars().take(60).collect();
        others.push(RunningApp {
            name,
            executable: exe,
            pid: w.pid,
            hwnd: Some(w.hwnd),
            game_id: None,
        });
    }
    games.sort_by_key(|a| a.name.to_lowercase());
    others.sort_by_key(|a| a.name.to_lowercase());
    games.extend(others);
    games
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
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

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
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(process);
        ok.ok()?;
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        let exe_name = Path::new(&full).file_name()?.to_string_lossy().into_owned();
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title);
        let window_title = (n > 0).then(|| String::from_utf16_lossy(&title[..n as usize]));
        Some(ProcessInfo {
            pid,
            exe_name,
            window_title,
            hwnd: Some(hwnd.0 as u64),
        })
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
        GameDb::load(
            &path,
            &[CustomGame {
                name: "My Indie Game".into(),
                executable: r"C:\Games\Indie\indie.exe".into(),
            }],
        )
    }

    fn proc(pid: u32, exe: &str, title: Option<&str>, hwnd: Option<u64>) -> ProcessInfo {
        ProcessInfo {
            pid,
            exe_name: exe.into(),
            window_title: title.map(Into::into),
            hwnd,
        }
    }

    #[test]
    fn bundled_database_loads() {
        let db = db();
        assert!(db.entries().len() > 40);
        assert_eq!(
            db.match_process("cs2.exe", None).unwrap().name,
            "Counter-Strike 2"
        );
        assert_eq!(
            db.match_process("VALORANT-WIN64-SHIPPING.EXE", None)
                .unwrap()
                .id,
            "valorant"
        );
        assert_eq!(
            db.match_process("indie.exe", None).unwrap().name,
            "My Indie Game"
        );
        assert_eq!(
            db.match_process("javaw.exe", Some("Minecraft 1.21.4"))
                .unwrap()
                .id,
            "minecraft"
        );
        assert!(db.match_process("chrome.exe", Some("YouTube")).is_none());
    }

    #[test]
    fn bundled_database_has_no_duplicates() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/games.json");
        let db = GameDb::load(&path, &[]);
        let mut ids = std::collections::HashSet::new();
        let mut exes = std::collections::HashSet::new();
        for g in db.entries() {
            assert!(ids.insert(g.id.clone()), "duplicate id {}", g.id);
            assert!(!g.executables.is_empty(), "{} has no executables", g.id);
            for e in &g.executables {
                assert!(
                    exes.insert(e.to_ascii_lowercase()),
                    "duplicate executable {e}"
                );
            }
        }
    }

    #[test]
    fn lists_only_running_apps_games_first() {
        let db = db();
        let procs = vec![
            proc(10, "cs2.exe", None, None),
            proc(11, "Discord.exe", None, None),
            proc(12, "explorer.exe", None, None),
            proc(13, "svchost.exe", None, None),
            proc(14, "cs2.exe", None, None),
        ];
        let windows = vec![
            AppWindow {
                pid: 11,
                hwnd: 2,
                title: "Discord".into(),
            },
            AppWindow {
                pid: 10,
                hwnd: 1,
                title: "Counter-Strike 2".into(),
            },
            AppWindow {
                pid: 12,
                hwnd: 3,
                title: "Program Manager".into(),
            },
            AppWindow {
                pid: 11,
                hwnd: 4,
                title: "Discord popup".into(),
            },
        ];
        let apps = running_apps(&db, &procs, &windows);
        let names: Vec<_> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Counter-Strike 2", "Discord"],
            "no database games that are not running, no system windows, no duplicates"
        );
        assert_eq!(apps[0].hwnd, Some(1));
        assert_eq!(apps[0].game_id.as_deref(), Some("cs2"));
        assert_eq!(apps[1].game_id, None);
    }

    #[test]
    fn manual_target_overrides_detection() {
        let svc = GameService::default();
        *svc.detected.write() = Some(DetectedGame {
            id: None,
            name: "Dota 2".into(),
            executable: "dota2.exe".into(),
            pid: 1,
            hwnd: Some(5),
        });
        assert_eq!(svc.foreground_hwnd(), Some(5));
        *svc.manual.write() = Some(ManualTarget {
            name: "Discord".into(),
            hwnd: Some(9),
        });
        assert_eq!(svc.foreground_hwnd(), Some(9));
        assert_eq!(svc.current().1.as_deref(), Some("Discord"));
    }

    #[test]
    fn prefers_foreground_game() {
        let db = db();
        let running = vec![
            proc(1, "explorer.exe", None, None),
            proc(2, "dota2.exe", None, None),
            proc(3, "cs2.exe", None, None),
        ];
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
    pub manual: parking_lot::RwLock<Option<ManualTarget>>,
}

/// A capture target picked by the user from the running apps.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualTarget {
    pub name: String,
    pub hwnd: Option<u64>,
}

impl GameService {
    /// (game id, display name) to tag new clips with.
    pub fn current(&self) -> (Option<String>, Option<String>) {
        if let Some(name) = self.manual.read().as_ref().map(|m| m.name.clone()) {
            let id = self
                .db
                .read()
                .entries()
                .iter()
                .find(|g| g.name == name)
                .map(|g| g.id.clone());
            return (id, Some(name));
        }
        match self.detected.read().as_ref() {
            Some(d) => (d.id.clone(), Some(d.name.clone())),
            None => (None, None),
        }
    }

    /// Window to capture in game-window mode: the user's pick, else the detected game's.
    pub fn foreground_hwnd(&self) -> Option<u64> {
        if let Some(m) = self.manual.read().as_ref() {
            return m.hwnd;
        }
        self.detected.read().as_ref().and_then(|d| d.hwnd)
    }
}
