//! The recording engine: owns the encoder pipeline and implements Instant Replay,
//! manual recording (with pause/resume) and crash recovery on top of the segment buffer.
//!
//! A single encoder session serves both features at once — starting a manual recording
//! while the replay buffer runs only pins segments, so video is never encoded twice.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::args::is_d3d11_source;
use crate::audio::AudioControls;
use crate::config::CaptureConfig;
use crate::error::{CaptureError, Result};
use crate::ffmpeg::{Capabilities, EncoderInfo, Ffmpeg};
use crate::media::{self, MediaInfo};
use crate::pipeline::{Pipeline, PipelineStats};
use crate::segments::{self, Segment, SegmentLog, SEGMENT_EXT};

const MAINTENANCE_INTERVAL: Duration = Duration::from_millis(250);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESTARTS: u32 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineEvent {
    #[serde(rename_all = "camelCase")]
    PipelineStarted { encoder: EncoderInfo, gpu_path: bool, fallback: bool },
    #[serde(rename_all = "camelCase")]
    PipelineStopped,
    #[serde(rename_all = "camelCase")]
    PipelineFailed { error: String, will_retry: bool },
    /// The encoder died during a manual recording; what was captured so far was saved.
    #[serde(rename_all = "camelCase")]
    RecordingInterrupted { clip: Option<SavedClip>, error: String },
    #[serde(rename_all = "camelCase")]
    AudioWarning { message: String },
}

pub type EventHandler = Arc<dyn Fn(EngineEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedClip {
    pub path: PathBuf,
    pub info: MediaInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatus {
    pub seconds: u32,
    pub buffered_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub output_path: PathBuf,
    pub elapsed_secs: f64,
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub replay: Option<ReplayStatus>,
    pub recording: Option<RecordingStatus>,
    pub encoder: Option<EncoderInfo>,
    pub gpu_path: bool,
    pub stats: Option<PipelineStats>,
    pub last_error: Option<String>,
    pub audio_warning: Option<String>,
    pub mic_muted: bool,
}

/// Persisted while a manual recording runs so it can be finalized after a crash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingManifest {
    id: String,
    session_dir: PathBuf,
    output_path: PathBuf,
    start: f64,
    pauses: Vec<(f64, Option<f64>)>,
    stop: Option<f64>,
    started_unix_ms: u128,
    segment_secs: u32,
}

struct Recording {
    manifest: RecordingManifest,
    manifest_path: PathBuf,
    pin_from: u64,
}

impl Recording {
    fn persist(&self) -> Result<()> {
        write_json_atomic(&self.manifest_path, &self.manifest)
    }

    fn elapsed(&self, now: f64) -> f64 {
        let paused: f64 = self
            .manifest
            .pauses
            .iter()
            .map(|(s, e)| e.unwrap_or(now) - s)
            .sum();
        (now - self.manifest.start - paused).max(0.0)
    }

    fn is_paused(&self) -> bool {
        self.manifest.pauses.last().is_some_and(|(_, end)| end.is_none())
    }
}

struct Inner {
    ffmpeg: Ffmpeg,
    caps: Capabilities,
    work_dir: PathBuf,
    config: CaptureConfig,
    controls: Arc<AudioControls>,
    pipeline: Option<Pipeline>,
    /// Encoder/GPU-path combination that last started successfully.
    working: Option<(EncoderInfo, bool)>,
    replay_seconds: Option<u32>,
    recording: Option<Recording>,
    export_pins: Vec<u64>,
    last_error: Option<String>,
    restarts: u32,
    events: Option<EventHandler>,
    reported_audio_error: Option<String>,
}

pub struct CaptureEngine {
    inner: Arc<Mutex<Inner>>,
    shutdown: Arc<AtomicBool>,
    maintenance: Mutex<Option<JoinHandle<()>>>,
}

fn unix_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

impl CaptureEngine {
    /// Creates the engine. `work_dir` holds the replay buffer and recording manifests;
    /// it should be on a local disk with a few GB free.
    pub fn new(ffmpeg: Ffmpeg, caps: Capabilities, work_dir: impl Into<PathBuf>, config: CaptureConfig) -> Result<Self> {
        config.validate()?;
        let work_dir = work_dir.into();
        std::fs::create_dir_all(work_dir.join("sessions"))?;
        std::fs::create_dir_all(work_dir.join("recordings"))?;
        let controls = AudioControls::new(config.audio.system.volume, config.audio.microphone.volume);
        let inner = Arc::new(Mutex::new(Inner {
            ffmpeg,
            caps,
            work_dir,
            config,
            controls,
            pipeline: None,
            working: None,
            replay_seconds: None,
            recording: None,
            export_pins: Vec::new(),
            last_error: None,
            restarts: 0,
            events: None,
            reported_audio_error: None,
        }));
        let shutdown = Arc::new(AtomicBool::new(false));
        let maintenance = {
            let inner = Arc::downgrade(&inner);
            let shutdown = shutdown.clone();
            std::thread::Builder::new().name("cliplock-engine".into()).spawn(move || {
                while !shutdown.load(Ordering::Relaxed) {
                    std::thread::sleep(MAINTENANCE_INTERVAL);
                    let Some(inner) = inner.upgrade() else { break };
                    let events = maintain(&mut inner.lock());
                    let handler = inner.lock().events.clone();
                    if let Some(handler) = handler {
                        for e in events {
                            handler(e);
                        }
                    }
                }
            })?
        };
        Ok(Self { inner, shutdown, maintenance: Mutex::new(Some(maintenance)) })
    }

    pub fn set_event_handler(&self, handler: EventHandler) {
        self.inner.lock().events = Some(handler);
    }

    pub fn capabilities(&self) -> Capabilities {
        self.inner.lock().caps.clone()
    }

    pub fn ffmpeg(&self) -> Ffmpeg {
        self.inner.lock().ffmpeg.clone()
    }

    pub fn config(&self) -> CaptureConfig {
        self.inner.lock().config.clone()
    }

    /// Applies new settings. Volume changes take effect immediately; anything else
    /// restarts the encoder (clearing the replay buffer). Refused while recording.
    pub fn set_config(&self, config: CaptureConfig) -> Result<()> {
        config.validate()?;
        let events = {
            let mut inner = self.inner.lock();
            inner.controls.set_system_volume(config.audio.system.volume);
            inner.controls.set_mic_volume(config.audio.microphone.volume);
            let mut a = inner.config.clone();
            let mut b = config.clone();
            for c in [&mut a, &mut b] {
                c.audio.system.volume = 1.0;
                c.audio.microphone.volume = 1.0;
            }
            if a == b {
                inner.config = config;
                return Ok(());
            }
            if inner.recording.is_some() {
                return Err(CaptureError::AlreadyRecording);
            }
            inner.config = config;
            inner.working = None;
            if inner.pipeline.is_some() {
                stop_pipeline(&mut inner, true);
                ensure_pipeline(&mut inner)?
            } else {
                Vec::new()
            }
        };
        self.emit(events);
        Ok(())
    }

    pub fn set_mic_muted(&self, muted: bool) {
        self.inner.lock().controls.set_mic_muted(muted);
    }

    fn emit(&self, events: Vec<EngineEvent>) {
        let handler = self.inner.lock().events.clone();
        if let Some(handler) = handler {
            for e in events {
                handler(e);
            }
        }
    }

    /// Finalizes manual recordings interrupted by a crash or power loss and removes
    /// stale buffer data. Call once at startup, before starting capture.
    pub fn recover_interrupted(&self) -> Vec<Result<SavedClip>> {
        let inner = self.inner.lock();
        if inner.pipeline.is_some() {
            return Vec::new();
        }
        let mut results = Vec::new();
        let rec_dir = inner.work_dir.join("recordings");
        let entries: Vec<PathBuf> = std::fs::read_dir(&rec_dir)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).collect())
            .unwrap_or_default();
        for path in entries.into_iter().filter(|p| p.extension().is_some_and(|e| e == "json")) {
            let manifest: RecordingManifest = match std::fs::read(&path)
                .map_err(CaptureError::from)
                .and_then(|b| serde_json::from_slice(&b).map_err(CaptureError::from))
            {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("discarding unreadable recording manifest {}: {e}", path.display());
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
            };
            let segs = segments_on_disk(&manifest.session_dir, manifest.segment_secs);
            let result = export_recording(&inner.ffmpeg, &manifest, segs);
            match &result {
                Ok(clip) => tracing::info!("recovered interrupted recording to {}", clip.path.display()),
                Err(e) => tracing::error!("could not recover recording {}: {e}", manifest.id),
            }
            let _ = std::fs::remove_file(&path);
            results.push(result);
        }
        // Nothing else in the buffer is worth keeping.
        if let Ok(rd) = std::fs::read_dir(inner.work_dir.join("sessions")) {
            for entry in rd.filter_map(|e| e.ok()) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        results
    }

    pub fn start_replay(&self, seconds: u32) -> Result<()> {
        let events = {
            let mut inner = self.inner.lock();
            inner.replay_seconds = Some(seconds.max(1));
            inner.restarts = 0;
            match ensure_pipeline(&mut inner) {
                Ok(events) => events,
                Err(e) => {
                    inner.replay_seconds = None;
                    return Err(e);
                }
            }
        };
        self.emit(events);
        Ok(())
    }

    pub fn set_replay_seconds(&self, seconds: u32) {
        let mut inner = self.inner.lock();
        if inner.replay_seconds.is_some() {
            inner.replay_seconds = Some(seconds.max(1));
        }
    }

    pub fn stop_replay(&self) {
        let mut inner = self.inner.lock();
        inner.replay_seconds = None;
        if inner.recording.is_none() {
            stop_pipeline(&mut inner, true);
        }
        drop(inner);
        self.emit(vec![EngineEvent::PipelineStopped]);
    }

    pub fn is_replay_active(&self) -> bool {
        self.inner.lock().replay_seconds.is_some()
    }

    /// Saves the last `seconds` (default: the configured replay length) of the buffer.
    /// Waits for the segment containing "now" to be finished (at most one segment
    /// length), so the clip includes everything up to the moment of the request.
    pub fn save_replay(&self, out: &Path, seconds: Option<u32>) -> Result<SavedClip> {
        let (press, seconds, pin, segment_secs) = {
            let mut inner = self.inner.lock();
            let replay = inner.replay_seconds.ok_or(CaptureError::ReplayNotRunning)?;
            let segment_secs = inner.config.segment_secs;
            let pipeline = inner.pipeline.as_mut().ok_or(CaptureError::ReplayNotRunning)?;
            let press = pipeline.now().ok_or(CaptureError::NothingBuffered)?;
            let _ = pipeline.segments.poll();
            let pin = pipeline.segments.segments().front().map_or(0, |s| s.index);
            inner.export_pins.push(pin);
            (press, seconds.unwrap_or(replay) as f64, pin, segment_secs)
        };
        let result = self.save_replay_pinned(out, press, seconds, segment_secs);
        let mut inner = self.inner.lock();
        if let Some(pos) = inner.export_pins.iter().position(|p| *p == pin) {
            inner.export_pins.remove(pos);
        }
        result
    }

    fn save_replay_pinned(&self, out: &Path, press: f64, seconds: f64, segment_secs: u32) -> Result<SavedClip> {
        let deadline = Instant::now() + Duration::from_secs(segment_secs as u64 * 2 + 3);
        let (selected, ffmpeg) = loop {
            {
                let mut inner = self.inner.lock();
                let ffmpeg = inner.ffmpeg.clone();
                let pipeline = inner.pipeline.as_mut().ok_or(CaptureError::ReplayNotRunning)?;
                let _ = pipeline.segments.poll();
                let done = pipeline.segments.buffered_until().is_some_and(|t| t >= press - 0.05);
                if done || Instant::now() > deadline {
                    break (segments::select_replay(pipeline.segments.segments(), press, seconds), ffmpeg);
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let first = selected.first().ok_or(CaptureError::NothingBuffered)?;
        let max_duration = (press - first.start).max(0.5);
        media::concat_segments(&ffmpeg, &selected, out, Some(max_duration))?;
        let info = media::probe(&ffmpeg, out)?;
        Ok(SavedClip { path: out.to_path_buf(), info })
    }

    pub fn start_recording(&self, out: &Path) -> Result<()> {
        let events = {
            let mut inner = self.inner.lock();
            if inner.recording.is_some() {
                return Err(CaptureError::AlreadyRecording);
            }
            inner.restarts = 0;
            let events = ensure_pipeline(&mut inner)?;
            let segment_secs = inner.config.segment_secs;
            let rec_dir = inner.work_dir.join("recordings");
            let pipeline = inner.pipeline.as_mut().expect("pipeline running");
            let _ = pipeline.segments.poll();
            let start = pipeline.now().unwrap_or(0.0);
            // The segment being written now has the next index; pin from there.
            let pin_from = pipeline.segments.segments().back().map_or(0, |s| s.index + 1);
            let id = format!("rec-{}", unix_ms());
            let recording = Recording {
                manifest_path: rec_dir.join(format!("{id}.json")),
                manifest: RecordingManifest {
                    id,
                    session_dir: pipeline.session_dir.clone(),
                    output_path: out.to_path_buf(),
                    start,
                    pauses: Vec::new(),
                    stop: None,
                    started_unix_ms: unix_ms(),
                    segment_secs,
                },
                pin_from,
            };
            recording.persist()?;
            inner.recording = Some(recording);
            events
        };
        self.emit(events);
        Ok(())
    }

    pub fn pause_recording(&self) -> Result<()> {
        let mut inner = self.inner.lock();
        let now = inner.pipeline.as_ref().and_then(|p| p.now()).ok_or(CaptureError::NotRecording)?;
        let rec = inner.recording.as_mut().ok_or(CaptureError::NotRecording)?;
        if !rec.is_paused() {
            rec.manifest.pauses.push((now, None));
            rec.persist()?;
        }
        Ok(())
    }

    pub fn resume_recording(&self) -> Result<()> {
        let mut inner = self.inner.lock();
        let now = inner.pipeline.as_ref().and_then(|p| p.now()).ok_or(CaptureError::NotRecording)?;
        let rec = inner.recording.as_mut().ok_or(CaptureError::NotRecording)?;
        if let Some((_, end @ None)) = rec.manifest.pauses.last_mut() {
            *end = Some(now);
            rec.persist()?;
        }
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<SavedClip> {
        let (manifest, manifest_path, pin_from, owns_session, ffmpeg) = {
            let mut inner = self.inner.lock();
            let now = inner.pipeline.as_ref().and_then(|p| p.now());
            let mut rec = inner.recording.take().ok_or(CaptureError::NotRecording)?;
            rec.manifest.stop = now;
            let stop = now.unwrap_or(f64::INFINITY);
            if let Some((_, end @ None)) = rec.manifest.pauses.last_mut() {
                *end = Some(stop);
            }
            rec.persist()?;
            // Keep the recording's segments alive until the export below is done.
            inner.export_pins.push(rec.pin_from);
            (rec.manifest, rec.manifest_path, rec.pin_from, inner.replay_seconds.is_none(), inner.ffmpeg.clone())
        };
        let result = self.finish_recording(&manifest, owns_session, &ffmpeg);
        {
            let mut inner = self.inner.lock();
            if let Some(pos) = inner.export_pins.iter().position(|p| *p == pin_from) {
                inner.export_pins.remove(pos);
            }
        }
        if result.is_ok() {
            let _ = std::fs::remove_file(&manifest_path);
            if owns_session {
                let _ = std::fs::remove_dir_all(&manifest.session_dir);
            }
        }
        result
    }

    fn finish_recording(&self, manifest: &RecordingManifest, owns_session: bool, ffmpeg: &Ffmpeg) -> Result<SavedClip> {
        let stop = manifest.stop.unwrap_or(f64::INFINITY);
        let segs: Vec<Segment> = if owns_session {
            // Nobody else needs the encoder: stop it, which also closes the last segment.
            let pipeline = self.inner.lock().pipeline.take();
            if let Some(mut p) = pipeline {
                p.stop(STOP_TIMEOUT);
            }
            segments_on_disk(&manifest.session_dir, manifest.segment_secs)
        } else {
            // Wait for the segment containing the stop time to close.
            let deadline = Instant::now() + Duration::from_secs(manifest.segment_secs as u64 * 2 + 3);
            loop {
                {
                    let mut inner = self.inner.lock();
                    let Some(p) = inner.pipeline.as_mut() else { break };
                    let _ = p.segments.poll();
                    if p.segments.buffered_until().is_some_and(|t| t >= stop - 0.05) || Instant::now() > deadline {
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let inner = self.inner.lock();
            match inner.pipeline.as_ref() {
                Some(p) => p.segments.segments().iter().cloned().collect(),
                None => segments_on_disk(&manifest.session_dir, manifest.segment_secs),
            }
        };
        export_recording(ffmpeg, manifest, segs)
    }

    pub fn status(&self) -> EngineStatus {
        let inner = self.inner.lock();
        let now = inner.pipeline.as_ref().and_then(|p| p.now());
        EngineStatus {
            running: inner.pipeline.is_some(),
            replay: inner.replay_seconds.map(|seconds| ReplayStatus {
                seconds,
                buffered_seconds: inner
                    .pipeline
                    .as_ref()
                    .map_or(0.0, |p| p.segments.buffered_seconds().min(seconds as f64)),
            }),
            recording: inner.recording.as_ref().map(|r| RecordingStatus {
                output_path: r.manifest.output_path.clone(),
                elapsed_secs: now.map_or(0.0, |n| r.elapsed(n)),
                paused: r.is_paused(),
            }),
            encoder: inner.pipeline.as_ref().map(|p| p.encoder.clone()),
            gpu_path: inner.pipeline.as_ref().is_some_and(|p| p.gpu_path),
            stats: inner.pipeline.as_ref().map(|p| p.stats()),
            last_error: inner.last_error.clone(),
            audio_warning: inner.pipeline.as_ref().and_then(|p| p.audio_error()),
            mic_muted: inner.controls.mic_muted(),
        }
    }

    /// Stops everything, finalizing an active recording first. Idempotent.
    pub fn shutdown(&self) -> Option<Result<SavedClip>> {
        let recording_active = self.inner.lock().recording.is_some();
        let saved = recording_active.then(|| self.stop_recording());
        {
            let mut inner = self.inner.lock();
            inner.replay_seconds = None;
            stop_pipeline(&mut inner, true);
        }
        self.shutdown.store(true, Ordering::Relaxed);
        let handle = self.maintenance.lock().take();
        if let Some(t) = handle {
            let _ = t.join();
        }
        saved
    }
}

impl Drop for CaptureEngine {
    fn drop(&mut self) {
        if self.maintenance.lock().is_some() {
            let _ = self.shutdown();
        }
    }
}

fn export_recording(ffmpeg: &Ffmpeg, manifest: &RecordingManifest, segs: Vec<Segment>) -> Result<SavedClip> {
    let selected = segments::select_recording(segs, manifest.start, manifest.stop, &manifest.pauses);
    let max_duration = segments::trimmed_duration(&selected, manifest.stop);
    media::concat_segments(ffmpeg, &selected, &manifest.output_path, max_duration)?;
    let info = media::probe(ffmpeg, &manifest.output_path)?;
    Ok(SavedClip { path: manifest.output_path.clone(), info })
}

/// Lists a session's segments from its list file, plus a trailing segment that was
/// still being written (e.g. when the process crashed).
fn segments_on_disk(session_dir: &Path, segment_secs: u32) -> Vec<Segment> {
    let mut log = SegmentLog::new(session_dir);
    let _ = log.poll();
    let mut segs: Vec<Segment> = log.segments().iter().filter(|s| s.path.exists()).cloned().collect();
    let last_index = segs.last().map(|s| s.index);
    let mut extra: Vec<(u64, PathBuf)> = std::fs::read_dir(session_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_str()?.to_owned();
                    let index = segments::segment_index_from_name(&name)?;
                    (last_index.is_none_or(|l| index > l) && e.metadata().ok()?.len() > 0).then(|| (index, e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    extra.sort();
    let mut t = segs.last().map_or(0.0, |s| s.end);
    for (index, path) in extra {
        debug_assert!(path.extension().is_some_and(|e| e == SEGMENT_EXT));
        segs.push(Segment { index, path, start: t, end: t + segment_secs as f64 });
        t += segment_secs as f64;
    }
    segs
}

fn new_session_dir(inner: &Inner) -> PathBuf {
    inner.work_dir.join("sessions").join(format!("{}", unix_ms()))
}

fn stop_pipeline(inner: &mut Inner, delete_buffer: bool) {
    if let Some(mut p) = inner.pipeline.take() {
        p.stop(STOP_TIMEOUT);
        if delete_buffer {
            let _ = std::fs::remove_dir_all(&p.session_dir);
        }
    }
}

/// Starts the encoder if it is not running, falling back through slower but more
/// compatible configurations if the preferred one fails to start.
fn ensure_pipeline(inner: &mut Inner) -> Result<Vec<EngineEvent>> {
    if inner.pipeline.is_some() {
        return Ok(Vec::new());
    }
    let config = inner.config.clone();
    let mut attempts: Vec<(EncoderInfo, bool)> = Vec::new();
    if let Some(w) = inner.working.clone() {
        attempts.push(w);
    }
    let preferred = inner.caps.resolve_encoder(config.video.encoder, config.video.codec)?;
    let d3d11 = is_d3d11_source(&config.video.source);
    for enc in std::iter::once(preferred.clone()).chain(inner.caps.fallbacks_after(&preferred)) {
        if d3d11 && enc.hardware {
            attempts.push((enc.clone(), true));
        }
        attempts.push((enc, false));
    }
    attempts.dedup();

    let mut last_err = CaptureError::NoEncoder;
    for (i, (encoder, gpu_path)) in attempts.into_iter().enumerate() {
        let dir = new_session_dir(inner);
        match Pipeline::spawn(&inner.ffmpeg, &inner.caps, &config, &encoder, gpu_path, &dir, inner.controls.clone()) {
            Ok(mut p) => match p.wait_until_running(STARTUP_TIMEOUT) {
                Ok(()) => {
                    inner.pipeline = Some(p);
                    inner.working = Some((encoder.clone(), gpu_path));
                    inner.last_error = None;
                    return Ok(vec![EngineEvent::PipelineStarted { encoder, gpu_path, fallback: i > 0 }]);
                }
                Err(e) => {
                    tracing::warn!("encoder {} (gpu_path={gpu_path}) failed to start: {e}", encoder.ffmpeg_name);
                    p.stop(Duration::from_secs(1));
                    let _ = std::fs::remove_dir_all(&dir);
                    last_err = e;
                }
            },
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                // Audio device errors are not encoder-specific; do not try other encoders.
                if matches!(e, CaptureError::Audio(_)) {
                    inner.last_error = Some(e.to_string());
                    return Err(e);
                }
                last_err = e;
            }
        }
    }
    inner.last_error = Some(last_err.to_string());
    Err(last_err)
}

/// Periodic housekeeping: read new segments, prune the ring buffer, and handle an
/// encoder that died.
fn maintain(inner: &mut Inner) -> Vec<EngineEvent> {
    let mut events = Vec::new();
    let Some(pipeline) = inner.pipeline.as_mut() else { return events };
    let _ = pipeline.segments.poll();

    if let Some(err) = pipeline.audio_error() {
        if inner.reported_audio_error.as_ref() != Some(&err) {
            inner.reported_audio_error = Some(err.clone());
            events.push(EngineEvent::AudioWarning { message: err });
        }
    }

    let pin = inner
        .recording
        .as_ref()
        .map(|r| r.pin_from)
        .into_iter()
        .chain(inner.export_pins.iter().copied())
        .min();
    let keep_after = match (inner.replay_seconds, pipeline.segments.buffered_until()) {
        // Keep one extra segment so a full-length replay is always available.
        (Some(secs), Some(until)) => until - secs as f64 - inner.config.segment_secs as f64,
        (None, Some(until)) => until,
        (_, None) => f64::NEG_INFINITY,
    };
    for seg in pipeline.segments.prune(keep_after, pin) {
        if let Err(e) = std::fs::remove_file(&seg.path) {
            tracing::debug!("could not delete {}: {e}", seg.path.display());
        }
    }

    let Some(reason) = pipeline.exit_reason() else { return events };
    tracing::error!("{reason}");
    let mut dead = inner.pipeline.take().expect("pipeline present");
    dead.stop(Duration::from_millis(100));
    inner.last_error = Some(reason.clone());

    if let Some(mut rec) = inner.recording.take() {
        // Save what was captured; a recording cannot continue into a new session.
        let segs = segments_on_disk(&dead.session_dir, rec.manifest.segment_secs);
        rec.manifest.stop = segs.last().map(|s| s.end);
        let _ = rec.persist();
        let clip = export_recording(&inner.ffmpeg, &rec.manifest, segs).ok();
        if clip.is_some() {
            let _ = std::fs::remove_file(&rec.manifest_path);
        }
        events.push(EngineEvent::RecordingInterrupted { clip, error: reason.clone() });
    }
    let _ = std::fs::remove_dir_all(&dead.session_dir);

    let will_retry = inner.replay_seconds.is_some() && inner.restarts < MAX_RESTARTS;
    events.push(EngineEvent::PipelineFailed { error: reason, will_retry });
    if will_retry {
        inner.restarts += 1;
        match ensure_pipeline(inner) {
            Ok(mut started) => events.append(&mut started),
            Err(e) => {
                inner.replay_seconds = None;
                events.push(EngineEvent::PipelineFailed { error: e.to_string(), will_retry: false });
            }
        }
    } else {
        inner.replay_seconds = None;
    }
    events
}
