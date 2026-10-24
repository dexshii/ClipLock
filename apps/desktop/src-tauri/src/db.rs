//! Local clip metadata in SQLite. The video files are the source of truth for media;
//! this database holds titles, favorites, game tags and cloud upload state.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE clips (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        file_path       TEXT NOT NULL UNIQUE,
        thumbnail_path  TEXT,
        game_id         TEXT,
        game_name       TEXT,
        kind            TEXT NOT NULL CHECK (kind IN ('replay', 'recording', 'edit', 'import')),
        source_clip_id  TEXT,
        created_at      TEXT NOT NULL,
        duration_ms     INTEGER NOT NULL DEFAULT 0,
        width           INTEGER NOT NULL DEFAULT 0,
        height          INTEGER NOT NULL DEFAULT 0,
        fps             REAL NOT NULL DEFAULT 0,
        size_bytes      INTEGER NOT NULL DEFAULT 0,
        favorite        INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'LOCAL'
                        CHECK (status IN ('LOCAL', 'QUEUED', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED')),
        upload_progress REAL,
        upload_error    TEXT,
        cloud_id        TEXT,
        share_url       TEXT,
        media_url       TEXT,
        visibility      TEXT,
        sha256          TEXT
    );
    CREATE INDEX clips_created_at ON clips (created_at DESC);
    CREATE INDEX clips_game ON clips (game_name);
    CREATE TABLE upload_sessions (
        clip_id     TEXT PRIMARY KEY REFERENCES clips (id) ON DELETE CASCADE,
        cloud_id    TEXT NOT NULL,
        server_url  TEXT NOT NULL,
        part_size   INTEGER NOT NULL,
        part_count  INTEGER NOT NULL,
        parts_json  TEXT NOT NULL DEFAULT '[]',
        updated_at  TEXT NOT NULL
    );
    "#,
];

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    Replay,
    Recording,
    Edit,
    Import,
}

impl ClipKind {
    fn as_str(self) -> &'static str {
        match self {
            ClipKind::Replay => "replay",
            ClipKind::Recording => "recording",
            ClipKind::Edit => "edit",
            ClipKind::Import => "import",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "recording" => ClipKind::Recording,
            "edit" => ClipKind::Edit,
            "import" => ClipKind::Import,
            _ => ClipKind::Replay,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub title: String,
    pub file_path: PathBuf,
    pub thumbnail_path: Option<PathBuf>,
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub kind: ClipKind,
    pub source_clip_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub size_bytes: i64,
    pub favorite: bool,
    pub status: String,
    pub upload_progress: Option<f64>,
    pub upload_error: Option<String>,
    pub cloud_id: Option<String>,
    pub share_url: Option<String>,
    pub media_url: Option<String>,
    pub visibility: Option<String>,
    pub sha256: Option<String>,
    /// Computed when listing: whether the video file is still on disk.
    #[serde(default)]
    pub file_exists: bool,
}

impl Clip {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let file_path: String = r.get("file_path")?;
        let created_at: String = r.get("created_at")?;
        Ok(Self {
            id: r.get("id")?,
            title: r.get("title")?,
            file_exists: Path::new(&file_path).exists(),
            file_path: file_path.into(),
            thumbnail_path: r
                .get::<_, Option<String>>("thumbnail_path")?
                .map(Into::into),
            game_id: r.get("game_id")?,
            game_name: r.get("game_name")?,
            kind: ClipKind::parse(&r.get::<_, String>("kind")?),
            source_clip_id: r.get("source_clip_id")?,
            created_at: DateTime::parse_from_rfc3339(&created_at)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_default(),
            duration_ms: r.get("duration_ms")?,
            width: r.get("width")?,
            height: r.get("height")?,
            fps: r.get("fps")?,
            size_bytes: r.get("size_bytes")?,
            favorite: r.get::<_, i64>("favorite")? != 0,
            status: r.get("status")?,
            upload_progress: r.get("upload_progress")?,
            upload_error: r.get("upload_error")?,
            cloud_id: r.get("cloud_id")?,
            share_url: r.get("share_url")?,
            media_url: r.get("media_url")?,
            visibility: r.get("visibility")?,
            sha256: r.get("sha256")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct NewClip {
    pub title: String,
    pub file_path: PathBuf,
    pub thumbnail_path: Option<PathBuf>,
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub kind: ClipKind,
    pub source_clip_id: Option<String>,
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub size_bytes: i64,
}

pub fn insert_clip(conn: &Connection, c: &NewClip) -> AppResult<Clip> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO clips (id, title, file_path, thumbnail_path, game_id, game_name, kind, source_clip_id,
                            created_at, duration_ms, width, height, fps, size_bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id,
            c.title,
            c.file_path.to_string_lossy(),
            c.thumbnail_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            c.game_id,
            c.game_name,
            c.kind.as_str(),
            c.source_clip_id,
            Utc::now().to_rfc3339(),
            c.duration_ms,
            c.width,
            c.height,
            c.fps,
            c.size_bytes,
        ],
    )?;
    get_clip(conn, &id)
}

pub fn get_clip(conn: &Connection, id: &str) -> AppResult<Clip> {
    conn.query_row("SELECT * FROM clips WHERE id = ?1", [id], Clip::from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("clip {id}")))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipSort {
    #[default]
    Newest,
    Oldest,
    Longest,
    Largest,
    Title,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClipQuery {
    pub search: Option<String>,
    pub game: Option<String>,
    pub favorites_only: bool,
    pub sort: ClipSort,
}

pub fn list_clips(conn: &Connection, q: &ClipQuery) -> AppResult<Vec<Clip>> {
    let order = match q.sort {
        ClipSort::Newest => "created_at DESC",
        ClipSort::Oldest => "created_at ASC",
        ClipSort::Longest => "duration_ms DESC",
        ClipSort::Largest => "size_bytes DESC",
        ClipSort::Title => "title COLLATE NOCASE ASC",
    };
    let search = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            // Escape LIKE wildcards so user input is matched literally.
            format!(
                "%{}%",
                s.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        });
    let sql = format!(
        "SELECT * FROM clips
         WHERE (?1 IS NULL OR title LIKE ?1 ESCAPE '\\' OR game_name LIKE ?1 ESCAPE '\\')
           AND (?2 IS NULL OR game_name = ?2)
           AND (?3 = 0 OR favorite = 1)
         ORDER BY {order}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params![search, q.game, q.favorites_only as i64],
        Clip::from_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn game_names(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT game_name FROM clips WHERE game_name IS NOT NULL GROUP BY game_name ORDER BY COUNT(*) DESC, game_name",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClipPatch {
    pub title: Option<String>,
    pub favorite: Option<bool>,
    /// `Some("")` clears the game.
    pub game_name: Option<String>,
}

pub fn update_clip(conn: &Connection, id: &str, patch: &ClipPatch) -> AppResult<Clip> {
    if let Some(title) = &patch.title {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 100 {
            return Err(AppError::Invalid("title must be 1–100 characters".into()));
        }
        conn.execute(
            "UPDATE clips SET title = ?2 WHERE id = ?1",
            params![id, title],
        )?;
    }
    if let Some(fav) = patch.favorite {
        conn.execute(
            "UPDATE clips SET favorite = ?2 WHERE id = ?1",
            params![id, fav as i64],
        )?;
    }
    if let Some(game) = &patch.game_name {
        let game = game.trim();
        conn.execute(
            "UPDATE clips SET game_name = ?2, game_id = NULL WHERE id = ?1",
            params![id, (!game.is_empty()).then_some(game)],
        )?;
    }
    get_clip(conn, id)
}

pub fn update_media(
    conn: &Connection,
    id: &str,
    thumbnail: Option<&Path>,
    size_bytes: i64,
) -> AppResult<()> {
    conn.execute(
        "UPDATE clips SET thumbnail_path = COALESCE(?2, thumbnail_path), size_bytes = ?3 WHERE id = ?1",
        params![id, thumbnail.map(|p| p.to_string_lossy().into_owned()), size_bytes],
    )?;
    Ok(())
}

pub fn delete_clip(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM clips WHERE id = ?1", [id])?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub clip_count: i64,
    pub total_bytes: i64,
    pub total_duration_ms: i64,
    pub uploaded_count: i64,
}

pub fn stats(conn: &Connection) -> AppResult<LibraryStats> {
    Ok(conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0), COALESCE(SUM(duration_ms), 0),
                COALESCE(SUM(status = 'READY'), 0) FROM clips",
        [],
        |r| {
            Ok(LibraryStats {
                clip_count: r.get(0)?,
                total_bytes: r.get(1)?,
                total_duration_ms: r.get(2)?,
                uploaded_count: r.get(3)?,
            })
        },
    )?)
}

// ------------------------------------------------------------------- upload state

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudUpdate {
    pub status: Option<String>,
    pub progress: Option<Option<f64>>,
    pub error: Option<Option<String>>,
    pub cloud_id: Option<Option<String>>,
    pub share_url: Option<Option<String>>,
    pub media_url: Option<Option<String>>,
    pub visibility: Option<Option<String>>,
    pub sha256: Option<String>,
}

pub fn update_cloud(conn: &Connection, id: &str, u: &CloudUpdate) -> AppResult<Clip> {
    let tx = conn.unchecked_transaction()?;
    if let Some(s) = &u.status {
        tx.execute("UPDATE clips SET status = ?2 WHERE id = ?1", params![id, s])?;
    }
    if let Some(p) = &u.progress {
        tx.execute(
            "UPDATE clips SET upload_progress = ?2 WHERE id = ?1",
            params![id, p],
        )?;
    }
    if let Some(e) = &u.error {
        tx.execute(
            "UPDATE clips SET upload_error = ?2 WHERE id = ?1",
            params![id, e],
        )?;
    }
    if let Some(c) = &u.cloud_id {
        tx.execute(
            "UPDATE clips SET cloud_id = ?2 WHERE id = ?1",
            params![id, c],
        )?;
    }
    if let Some(s) = &u.share_url {
        tx.execute(
            "UPDATE clips SET share_url = ?2 WHERE id = ?1",
            params![id, s],
        )?;
    }
    if let Some(m) = &u.media_url {
        tx.execute(
            "UPDATE clips SET media_url = ?2 WHERE id = ?1",
            params![id, m],
        )?;
    }
    if let Some(v) = &u.visibility {
        tx.execute(
            "UPDATE clips SET visibility = ?2 WHERE id = ?1",
            params![id, v],
        )?;
    }
    if let Some(h) = &u.sha256 {
        tx.execute("UPDATE clips SET sha256 = ?2 WHERE id = ?1", params![id, h])?;
    }
    tx.commit()?;
    get_clip(conn, id)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSession {
    pub clip_id: String,
    pub cloud_id: String,
    pub server_url: String,
    pub part_size: i64,
    pub part_count: i64,
    /// Completed parts: (part number, ETag).
    pub parts: Vec<(i64, String)>,
}

pub fn save_upload_session(conn: &Connection, s: &UploadSession) -> AppResult<()> {
    conn.execute(
        "INSERT INTO upload_sessions (clip_id, cloud_id, server_url, part_size, part_count, parts_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (clip_id) DO UPDATE SET cloud_id = ?2, server_url = ?3, part_size = ?4, part_count = ?5,
                                             parts_json = ?6, updated_at = ?7",
        params![s.clip_id, s.cloud_id, s.server_url, s.part_size, s.part_count, serde_json::to_string(&s.parts)?, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub fn get_upload_session(conn: &Connection, clip_id: &str) -> AppResult<Option<UploadSession>> {
    conn.query_row(
        "SELECT clip_id, cloud_id, server_url, part_size, part_count, parts_json FROM upload_sessions WHERE clip_id = ?1",
        [clip_id],
        |r| {
            let parts: String = r.get(5)?;
            Ok(UploadSession {
                clip_id: r.get(0)?,
                cloud_id: r.get(1)?,
                server_url: r.get(2)?,
                part_size: r.get(3)?,
                part_count: r.get(4)?,
                parts: serde_json::from_str(&parts).unwrap_or_default(),
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn delete_upload_session(conn: &Connection, clip_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM upload_sessions WHERE clip_id = ?1", [clip_id])?;
    Ok(())
}

/// Clips whose upload was interrupted (app closed while queued/uploading).
pub fn interrupted_uploads(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM clips WHERE status IN ('QUEUED', 'UPLOADING') ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_clip(title: &str, game: Option<&str>, path: &str, duration: i64) -> NewClip {
        NewClip {
            title: title.into(),
            file_path: path.into(),
            thumbnail_path: None,
            game_id: None,
            game_name: game.map(Into::into),
            kind: ClipKind::Replay,
            source_clip_id: None,
            duration_ms: duration,
            width: 1920,
            height: 1080,
            fps: 60.0,
            size_bytes: duration * 1000,
        }
    }

    #[test]
    fn crud_filters_and_sorting() {
        let conn = open_in_memory().unwrap();
        let a = insert_clip(
            &conn,
            &new_clip("Ace on Ascent", Some("VALORANT"), "/c/a.mp4", 30_000),
        )
        .unwrap();
        insert_clip(
            &conn,
            &new_clip(
                "100% clutch_win",
                Some("Counter-Strike 2"),
                "/c/b.mp4",
                60_000,
            ),
        )
        .unwrap();
        insert_clip(&conn, &new_clip("Desktop", None, "/c/c.mp4", 10_000)).unwrap();
        assert!(
            insert_clip(&conn, &new_clip("dup", None, "/c/a.mp4", 1)).is_err(),
            "file paths are unique"
        );

        let all = list_clips(&conn, &ClipQuery::default()).unwrap();
        assert_eq!(all.len(), 3);
        let longest = list_clips(
            &conn,
            &ClipQuery {
                sort: ClipSort::Longest,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(longest[0].title, "100% clutch_win");

        let q = |s: &str| {
            list_clips(
                &conn,
                &ClipQuery {
                    search: Some(s.into()),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        assert_eq!(q("ascent").len(), 1);
        assert_eq!(q("valorant").len(), 1, "search matches game names");
        assert_eq!(q("100%").len(), 1, "% is matched literally");
        assert_eq!(q("%").len(), 1);
        assert_eq!(q("_").len(), 1);

        update_clip(
            &conn,
            &a.id,
            &ClipPatch {
                favorite: Some(true),
                title: Some("  Renamed ".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let favs = list_clips(
            &conn,
            &ClipQuery {
                favorites_only: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].title, "Renamed");
        assert!(update_clip(
            &conn,
            &a.id,
            &ClipPatch {
                title: Some("   ".into()),
                ..Default::default()
            }
        )
        .is_err());

        assert_eq!(game_names(&conn).unwrap().len(), 2);
        let by_game = list_clips(
            &conn,
            &ClipQuery {
                game: Some("VALORANT".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_game.len(), 1);

        let stats = stats(&conn).unwrap();
        assert_eq!(stats.clip_count, 3);
        assert_eq!(stats.total_duration_ms, 100_000);

        delete_clip(&conn, &a.id).unwrap();
        assert!(get_clip(&conn, &a.id).is_err());
    }

    #[test]
    fn upload_sessions_and_cloud_state() {
        let conn = open_in_memory().unwrap();
        let c = insert_clip(&conn, &new_clip("x", None, "/c/x.mp4", 1000)).unwrap();
        assert_eq!(c.status, "LOCAL");
        let s = UploadSession {
            clip_id: c.id.clone(),
            cloud_id: "abcDEF1234".into(),
            server_url: "https://example.com".into(),
            part_size: 16,
            part_count: 3,
            parts: vec![(1, "\"etag1\"".into())],
        };
        save_upload_session(&conn, &s).unwrap();
        assert_eq!(get_upload_session(&conn, &c.id).unwrap(), Some(s));
        let updated = update_cloud(
            &conn,
            &c.id,
            &CloudUpdate {
                status: Some("UPLOADING".into()),
                progress: Some(Some(0.5)),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.status, "UPLOADING");
        assert_eq!(interrupted_uploads(&conn).unwrap(), vec![c.id.clone()]);
        assert!(
            conn.execute("UPDATE clips SET status = 'BOGUS'", [])
                .is_err(),
            "status is constrained"
        );
        delete_clip(&conn, &c.id).unwrap();
        assert_eq!(
            get_upload_session(&conn, &c.id).unwrap(),
            None,
            "cascade delete"
        );
    }

    #[test]
    fn migrations_are_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        drop(open(&path).unwrap());
        let conn = open(&path).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
    }
}
