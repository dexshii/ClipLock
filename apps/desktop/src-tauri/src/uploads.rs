//! Background upload queue. Uploads only start when the user asks for one; an upload
//! that was interrupted (app closed, network lost) resumes from the parts the server
//! already has.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;

use crate::cloud::{CloudClip, NewClip};
use crate::db::{self, CloudUpdate, UploadSession};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const PART_ATTEMPTS: u32 = 6;
const PARALLEL_PARTS: usize = 3;
const PROCESSING_POLL: Duration = Duration::from_secs(3);
const PROCESSING_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub struct Uploads {
    tx: mpsc::UnboundedSender<String>,
    pending: Mutex<HashSet<String>>,
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    clip_id: &'a str,
    status: &'a str,
    progress: f64,
    bytes_per_second: f64,
}

impl Uploads {
    pub fn start(app: AppHandle) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tauri::async_runtime::spawn(async move {
            while let Some(clip_id) = rx.recv().await {
                let st = app.state::<AppState>();
                let cancel = st
                    .uploads
                    .cancel
                    .lock()
                    .entry(clip_id.clone())
                    .or_default()
                    .clone();
                let result = upload(&app, &clip_id, &cancel).await;
                st.uploads.pending.lock().remove(&clip_id);
                st.uploads.cancel.lock().remove(&clip_id);
                if let Err(e) = result {
                    if cancel.load(Ordering::SeqCst) {
                        tracing::info!("upload of {clip_id} cancelled");
                    } else {
                        tracing::warn!("upload of {clip_id} failed: {e}");
                        let message = match e {
                            AppError::Unauthorized => "Sign in to upload.".to_string(),
                            other => other.to_string(),
                        };
                        set_cloud(
                            &app,
                            &clip_id,
                            CloudUpdate {
                                status: Some("FAILED".into()),
                                error: Some(Some(message)),
                                progress: Some(None),
                                ..Default::default()
                            },
                        );
                    }
                }
            }
        });
        Self {
            tx,
            pending: Mutex::new(HashSet::new()),
            cancel: Mutex::new(HashMap::new()),
        }
    }

    /// Queues a clip. Returns false if it is already queued or uploading.
    pub fn enqueue(&self, clip_id: &str) -> bool {
        if !self.pending.lock().insert(clip_id.to_string()) {
            return false;
        }
        self.tx.send(clip_id.to_string()).is_ok()
    }

    pub fn request_cancel(&self, clip_id: &str) -> bool {
        let flag = self.cancel.lock().get(clip_id).cloned();
        match flag {
            Some(f) => {
                f.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }
}

fn set_cloud(app: &AppHandle, clip_id: &str, update: CloudUpdate) {
    let st = app.state::<AppState>();
    let result = db::update_cloud(&st.db.lock(), clip_id, &update);
    match result {
        Ok(clip) => {
            let _ = app.emit("clip-updated", &clip);
        }
        Err(e) => tracing::warn!("could not record upload state for {clip_id}: {e}"),
    }
}

fn apply_cloud_clip(app: &AppHandle, clip_id: &str, cloud: &CloudClip) {
    let status = match cloud.status.as_str() {
        "READY" => "READY",
        "FAILED" => "FAILED",
        "PROCESSING" => "PROCESSING",
        _ => "UPLOADING",
    };
    set_cloud(
        app,
        clip_id,
        CloudUpdate {
            status: Some(status.into()),
            progress: Some(if status == "READY" { Some(1.0) } else { None }),
            error: Some(cloud.error.clone()),
            cloud_id: Some(Some(cloud.id.clone())),
            share_url: Some(Some(cloud.share_url.clone())),
            media_url: Some(cloud.media_url.clone()),
            visibility: Some(Some(cloud.visibility.clone())),
            sha256: None,
        },
    );
}

async fn sha256_file(path: &Path) -> AppResult<String> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<String> {
        use std::io::Read;
        let mut file = std::fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| AppError::Invalid(e.to_string()))?
}

async fn read_part(path: &Path, offset: u64, len: usize) -> AppResult<Vec<u8>> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf).await?;
    Ok(buf)
}

async fn upload(app: &AppHandle, clip_id: &str, cancel: &AtomicBool) -> AppResult<()> {
    let st = app.state::<AppState>();
    let clip = db::get_clip(&st.db.lock(), clip_id)?;
    if !clip.file_path.exists() {
        return Err(AppError::NotFound("the video file no longer exists".into()));
    }
    let server = st.cloud.server()?;
    let (visibility, allow_download) = {
        let s = st.settings.read();
        (
            clip.visibility
                .clone()
                .unwrap_or_else(|| s.uploads.default_visibility.clone()),
            s.uploads.allow_download,
        )
    };
    let size = std::fs::metadata(&clip.file_path)?.len() as i64;
    set_cloud(
        app,
        clip_id,
        CloudUpdate {
            status: Some("UPLOADING".into()),
            progress: Some(Some(0.0)),
            error: Some(None),
            ..Default::default()
        },
    );
    let _ = app.emit(
        "upload-progress",
        Progress {
            clip_id,
            status: "UPLOADING",
            progress: 0.0,
            bytes_per_second: 0.0,
        },
    );

    let sha = sha256_file(&clip.file_path).await?;
    set_cloud(
        app,
        clip_id,
        CloudUpdate {
            sha256: Some(sha.clone()),
            ..Default::default()
        },
    );
    if cancel.load(Ordering::SeqCst) {
        return finish_cancel(app, clip_id, None).await;
    }

    // Resume an earlier session for the same file on the same server, if the server still has it.
    let mut session = db::get_upload_session(&st.db.lock(), clip_id)?
        .filter(|s| s.server_url == server && clip.sha256.as_deref() == Some(sha.as_str()));
    let mut done: HashMap<i64, String> = HashMap::new();
    if let Some(s) = &session {
        match st.cloud.uploaded_parts(&s.cloud_id).await {
            Ok(parts) => done.extend(parts.into_iter().map(|p| (p.part_number, p.etag))),
            Err(e) => {
                tracing::info!("cannot resume previous upload ({e}); starting over");
                session = None;
            }
        }
    }

    let session = match session {
        Some(s) => s,
        None => {
            db::delete_upload_session(&st.db.lock(), clip_id)?;
            let created = st
                .cloud
                .create_clip(&NewClip {
                    title: &clip.title,
                    game_name: clip.game_name.as_deref(),
                    duration_ms: clip.duration_ms.max(1),
                    width: clip.width.max(1),
                    height: clip.height.max(1),
                    size_bytes: size,
                    sha256: &sha,
                    visibility: &visibility,
                    allow_download,
                    recorded_at: Some(
                        clip.created_at
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    ),
                })
                .await?;
            let Some(info) = created.upload else {
                // Identical file already uploaded (or processing) on this account.
                apply_cloud_clip(app, clip_id, &created.clip);
                return wait_until_ready(app, clip_id, &created.clip.id).await;
            };
            let s = UploadSession {
                clip_id: clip_id.to_string(),
                cloud_id: created.clip.id.clone(),
                server_url: server.clone(),
                part_size: info.part_size,
                part_count: info.part_count,
                parts: Vec::new(),
            };
            db::save_upload_session(&st.db.lock(), &s)?;
            set_cloud(
                app,
                clip_id,
                CloudUpdate {
                    cloud_id: Some(Some(created.clip.id.clone())),
                    share_url: Some(Some(created.clip.share_url.clone())),
                    visibility: Some(Some(created.clip.visibility.clone())),
                    ..Default::default()
                },
            );
            if created.duplicate {
                done.extend(
                    st.cloud
                        .uploaded_parts(&s.cloud_id)
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .map(|p| (p.part_number, p.etag)),
                );
            }
            s
        }
    };

    let part_len = |n: i64| -> usize {
        ((size - (n - 1) * session.part_size).min(session.part_size)).max(0) as usize
    };
    let remaining: Vec<i64> = (1..=session.part_count)
        .filter(|n| !done.contains_key(n))
        .collect();
    let mut uploaded_bytes: u64 = done.keys().map(|n| part_len(*n) as u64).sum();
    let started = Instant::now();
    let start_bytes = uploaded_bytes;
    let report = |uploaded: u64| {
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        let _ = app.emit(
            "upload-progress",
            Progress {
                clip_id,
                status: "UPLOADING",
                progress: uploaded as f64 / size as f64,
                bytes_per_second: (uploaded - start_bytes) as f64 / elapsed,
            },
        );
    };
    report(uploaded_bytes);

    for batch in remaining.chunks(PARALLEL_PARTS) {
        if cancel.load(Ordering::SeqCst) {
            return finish_cancel(app, clip_id, Some(&session.cloud_id)).await;
        }
        let urls = st.cloud.part_urls(&session.cloud_id, batch).await?;
        let mut tasks = tokio::task::JoinSet::new();
        for part in urls {
            let http = st.cloud.http().clone();
            let path = clip.file_path.clone();
            let offset = ((part.part_number - 1) * session.part_size) as u64;
            let len = part_len(part.part_number);
            tasks.spawn(async move {
                let bytes = read_part(&path, offset, len).await?;
                let etag = put_part(&http, &part.url, bytes).await?;
                Ok::<_, AppError>((part.part_number, etag, len))
            });
        }
        while let Some(joined) = tasks.join_next().await {
            let (n, etag, len) = joined.map_err(|e| AppError::Invalid(e.to_string()))??;
            done.insert(n, etag);
            uploaded_bytes += len as u64;
            report(uploaded_bytes);
        }
        let mut parts: Vec<(i64, String)> = done.iter().map(|(n, e)| (*n, e.clone())).collect();
        parts.sort();
        db::save_upload_session(
            &st.db.lock(),
            &UploadSession {
                parts,
                ..session.clone()
            },
        )?;
        set_cloud(
            app,
            clip_id,
            CloudUpdate {
                progress: Some(Some(uploaded_bytes as f64 / size as f64)),
                ..Default::default()
            },
        );
    }

    let mut parts: Vec<(i64, String)> = done.into_iter().collect();
    parts.sort();
    let cloud = st.cloud.complete_upload(&session.cloud_id, &parts).await?;
    db::delete_upload_session(&st.db.lock(), clip_id)?;
    apply_cloud_clip(app, clip_id, &cloud);
    let _ = app.emit(
        "upload-progress",
        Progress {
            clip_id,
            status: "PROCESSING",
            progress: 1.0,
            bytes_per_second: 0.0,
        },
    );
    wait_until_ready(app, clip_id, &session.cloud_id).await
}

/// Uploads one part with retries. A presigned URL that has expired cannot be retried,
/// so the caller re-requests URLs per batch.
async fn put_part(http: &reqwest::Client, url: &str, bytes: Vec<u8>) -> AppResult<String> {
    let mut delay = Duration::from_secs(1);
    let mut last = None;
    for attempt in 1..=PART_ATTEMPTS {
        match http
            .put(url)
            .timeout(Duration::from_secs(300))
            .body(bytes.clone())
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => {
                let etag = res
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                return etag
                    .ok_or_else(|| AppError::Invalid("storage did not return an ETag".into()));
            }
            Ok(res) => {
                last = Some(AppError::Invalid(format!(
                    "storage rejected part upload ({})",
                    res.status()
                )))
            }
            Err(e) => last = Some(AppError::Http(e)),
        }
        if attempt < PART_ATTEMPTS {
            tracing::debug!("part upload attempt {attempt} failed; retrying in {delay:?}");
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    }
    Err(last.unwrap_or(AppError::Invalid("upload failed".into())))
}

async fn finish_cancel(app: &AppHandle, clip_id: &str, cloud_id: Option<&str>) -> AppResult<()> {
    let st = app.state::<AppState>();
    if let Some(id) = cloud_id {
        if let Err(e) = st.cloud.cancel_upload(id).await {
            tracing::warn!("server-side cancel failed: {e}");
        }
    }
    db::delete_upload_session(&st.db.lock(), clip_id)?;
    set_cloud(
        app,
        clip_id,
        CloudUpdate {
            status: Some("LOCAL".into()),
            progress: Some(None),
            error: Some(None),
            cloud_id: Some(None),
            share_url: Some(None),
            media_url: Some(None),
            ..Default::default()
        },
    );
    Err(AppError::Invalid("cancelled".into()))
}

/// Polls until the server finished processing (or failed).
pub async fn wait_until_ready(app: &AppHandle, clip_id: &str, cloud_id: &str) -> AppResult<()> {
    let st = app.state::<AppState>();
    let deadline = Instant::now() + PROCESSING_TIMEOUT;
    let mut network_errors = 0;
    loop {
        let cloud = match st.cloud.get_clip(cloud_id).await {
            Ok(c) => c,
            // The upload itself succeeded; ride out short network problems while polling.
            Err(AppError::Http(e)) if network_errors < 20 => {
                network_errors += 1;
                tracing::debug!("status poll failed ({e}); retrying");
                tokio::time::sleep(PROCESSING_POLL * 2).await;
                continue;
            }
            Err(e) => return Err(e),
        };
        apply_cloud_clip(app, clip_id, &cloud);
        match cloud.status.as_str() {
            "READY" => {
                if st.settings.read().general.notifications {
                    let _ = app
                        .notification()
                        .builder()
                        .title("Clip uploaded")
                        .body(format!("{} is ready to share.", cloud.title))
                        .show();
                }
                let _ = app.emit(
                    "upload-progress",
                    Progress {
                        clip_id,
                        status: "READY",
                        progress: 1.0,
                        bytes_per_second: 0.0,
                    },
                );
                return Ok(());
            }
            "FAILED" => {
                return Err(AppError::Invalid(
                    cloud
                        .error
                        .unwrap_or_else(|| "processing failed on the server".into()),
                ))
            }
            _ if Instant::now() > deadline => {
                return Err(AppError::Invalid(
                    "the server is taking unusually long to process this clip".into(),
                ))
            }
            _ => tokio::time::sleep(PROCESSING_POLL).await,
        }
    }
}

/// Resumes uploads that were interrupted and keeps polling clips still processing.
pub fn resume_interrupted(app: &AppHandle) {
    let st = app.state::<AppState>();
    let (interrupted, processing) = {
        let conn = st.db.lock();
        let interrupted = db::interrupted_uploads(&conn).unwrap_or_default();
        let processing: Vec<(String, String)> = db::list_clips(&conn, &Default::default())
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c.status == "PROCESSING")
            .filter_map(|c| c.cloud_id.map(|cid| (c.id, cid)))
            .collect();
        (interrupted, processing)
    };
    for id in interrupted {
        st.uploads.enqueue(&id);
    }
    for (clip_id, cloud_id) in processing {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = wait_until_ready(&app, &clip_id, &cloud_id).await {
                tracing::warn!("processing check for {clip_id} failed: {e}");
            }
        });
    }
}
