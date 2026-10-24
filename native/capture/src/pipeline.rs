//! A running encoder process writing buffer segments for one capture session.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::args::{build_args, SessionPlan};
use crate::audio::{AudioControls, AudioRuntime};
use crate::config::CaptureConfig;
use crate::error::{CaptureError, Result};
use crate::ffmpeg::{Capabilities, EncoderInfo, Ffmpeg};
use crate::platform;
use crate::segments::SegmentLog;

const STDERR_TAIL_LINES: usize = 40;

#[derive(Debug, Default, Clone, Copy)]
struct Progress {
    out_time: f64,
    at: Option<Instant>,
    frames: u64,
    dropped: u64,
    speed: f64,
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStats {
    pub frames: u64,
    pub dropped_frames: u64,
    /// Encoding speed relative to real time; persistently below ~0.97 means the
    /// encoder cannot keep up with the selected settings.
    pub speed: f64,
}

pub struct Pipeline {
    child: Child,
    stdin: Option<ChildStdin>,
    pub session_dir: PathBuf,
    pub segments: SegmentLog,
    pub encoder: EncoderInfo,
    pub gpu_path: bool,
    progress: Arc<Mutex<Progress>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    audio: Option<AudioRuntime>,
    pub started: Instant,
}

impl Pipeline {
    pub fn spawn(
        ffmpeg: &Ffmpeg,
        caps: &Capabilities,
        config: &CaptureConfig,
        encoder: &EncoderInfo,
        gpu_path: bool,
        session_dir: &Path,
        controls: Arc<AudioControls>,
    ) -> Result<Self> {
        std::fs::create_dir_all(session_dir)?;
        let audio = AudioRuntime::start(&config.audio, controls)?;
        let tracks = audio.as_ref().map(|a| a.tracks.clone()).unwrap_or_default();
        let plan = SessionPlan {
            config,
            caps,
            encoder,
            gpu_path,
            session_dir,
            audio_tracks: &tracks,
        };
        let args = build_args(&plan);
        tracing::info!(encoder = %encoder.ffmpeg_name, gpu_path, "starting encoder: ffmpeg {}", args.join(" "));

        let mut cmd = ffmpeg.command();
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn()?;
        platform::bind_child_to_process(&child);

        let progress = Arc::new(Mutex::new(Progress::default()));
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        {
            let stdout = child.stdout.take().expect("piped");
            let progress = progress.clone();
            std::thread::Builder::new()
                .name("cliplock-ffmpeg-progress".into())
                .spawn(move || {
                    let mut current = Progress::default();
                    for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
                        let Some((key, value)) = line.split_once('=') else {
                            continue;
                        };
                        match key {
                            "out_time_us" | "out_time_ms" => {
                                // Despite its name, out_time_ms is also in microseconds.
                                if let Ok(us) = value.trim().parse::<i64>() {
                                    current.out_time = us.max(0) as f64 / 1e6;
                                }
                            }
                            "frame" => {
                                current.frames = value.trim().parse().unwrap_or(current.frames)
                            }
                            "drop_frames" => {
                                current.dropped = value.trim().parse().unwrap_or(current.dropped)
                            }
                            "speed" => {
                                current.speed = value
                                    .trim()
                                    .trim_end_matches('x')
                                    .parse()
                                    .unwrap_or(current.speed)
                            }
                            "progress" => {
                                current.at = Some(Instant::now());
                                *progress.lock() = current;
                            }
                            _ => {}
                        }
                    }
                })?;
        }
        {
            let stderr = child.stderr.take().expect("piped");
            let tail = stderr_tail.clone();
            std::thread::Builder::new()
                .name("cliplock-ffmpeg-log".into())
                .spawn(move || {
                    for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                        tracing::debug!(target: "ffmpeg", "{line}");
                        let mut t = tail.lock();
                        if t.len() == STDERR_TAIL_LINES {
                            t.pop_front();
                        }
                        t.push_back(line);
                    }
                })?;
        }

        let stdin = child.stdin.take();
        Ok(Self {
            child,
            stdin,
            session_dir: session_dir.to_path_buf(),
            segments: SegmentLog::new(session_dir),
            encoder: encoder.clone(),
            gpu_path,
            progress,
            stderr_tail,
            audio,
            started: Instant::now(),
        })
    }

    /// Current position of the session timeline, extrapolated from the last progress
    /// report. `None` until the encoder has produced output.
    pub fn now(&self) -> Option<f64> {
        let p = *self.progress.lock();
        p.at.map(|at| p.out_time + at.elapsed().as_secs_f64())
    }

    pub fn stats(&self) -> PipelineStats {
        let p = *self.progress.lock();
        PipelineStats {
            frames: p.frames,
            dropped_frames: p.dropped,
            speed: p.speed,
        }
    }

    pub fn audio_error(&self) -> Option<String> {
        self.audio.as_ref().and_then(|a| a.error())
    }

    /// Returns `Some(reason)` once the encoder process has exited.
    pub fn exit_reason(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(format!(
                "encoder exited with {status}: {}",
                self.stderr_tail()
            )),
            Ok(None) => None,
            Err(e) => Some(e.to_string()),
        }
    }

    pub fn stderr_tail(&self) -> String {
        let tail = self.stderr_tail.lock();
        tail.iter()
            .rev()
            .take(6)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ")
    }

    /// Waits until the encoder reports output, or fails if it dies first.
    pub fn wait_until_running(&mut self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(reason) = self.exit_reason() {
                return Err(CaptureError::PipelineDied(reason));
            }
            if self.progress.lock().at.is_some() {
                return Ok(());
            }
            if Instant::now() > deadline {
                return Err(CaptureError::PipelineDied(format!(
                    "encoder produced no output within {}s: {}",
                    timeout.as_secs(),
                    self.stderr_tail()
                )));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Asks FFmpeg to finish (closing the current segment cleanly), killing it if it
    /// does not exit in time.
    pub fn stop(&mut self, timeout: Duration) {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) if Instant::now() > deadline => {
                    tracing::warn!("encoder did not stop in time; killing it");
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            }
        }
        // Stop audio after the encoder so it never blocks on a full socket.
        if let Some(mut audio) = self.audio.take() {
            audio.stop();
        }
        let _ = self.segments.poll();
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            self.stop(Duration::from_secs(3));
        }
    }
}
