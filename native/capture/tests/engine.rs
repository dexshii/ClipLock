//! End-to-end tests of the recording engine against a real FFmpeg binary, using a
//! generated test pattern and synthetic audio so they run on any OS without a GPU,
//! display or sound card. Skipped (with a message) if FFmpeg is not installed.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use cliplock_capture::{
    AudioConfig, AudioInputConfig, CaptureConfig, CaptureEngine, Codec, EncoderKind, Ffmpeg,
    VideoConfig, VideoSource,
};

fn ffmpeg() -> Option<Ffmpeg> {
    match Ffmpeg::locate(&[]) {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!("skipping: {e}");
            None
        }
    }
}

fn config() -> CaptureConfig {
    CaptureConfig {
        video: VideoConfig {
            source: VideoSource::TestPattern,
            output_height: Some(360),
            fps: 30,
            bitrate_kbps: 1500,
            codec: Codec::H264,
            encoder: EncoderKind::Auto,
            capture_cursor: false,
        },
        audio: AudioConfig {
            system: AudioInputConfig {
                enabled: true,
                device_id: None,
                volume: 1.0,
            },
            microphone: AudioInputConfig {
                enabled: true,
                device_id: None,
                volume: 0.8,
            },
            separate_tracks: true,
            bitrate_kbps: 128,
            synthetic: true,
        },
        keyframe_interval_secs: 1,
        segment_secs: 1,
    }
}

/// (video duration, audio durations) of every stream, via ffprobe.
fn stream_durations(ff: &Ffmpeg, path: &Path) -> (f64, Vec<f64>) {
    let out = Command::new(&ff.ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let mut video = 0.0;
    let mut audio = Vec::new();
    for line in text.lines() {
        let mut parts = line.split(',');
        let (Some(kind), Some(d)) = (parts.next(), parts.next()) else {
            continue;
        };
        let d: f64 = d.parse().unwrap_or(0.0);
        if kind == "video" {
            video = d;
        } else if kind == "audio" {
            audio.push(d);
        }
    }
    (video, audio)
}

fn assert_faststart(path: &Path) {
    let bytes = std::fs::read(path).unwrap();
    let find = |needle: &[u8]| bytes.windows(4).position(|w| w == needle).unwrap();
    assert!(
        find(b"moov") < find(b"mdat"),
        "moov atom must precede mdat for progressive playback"
    );
}

fn session_segment_count(work: &Path) -> usize {
    let sessions = work.join("sessions");
    std::fs::read_dir(sessions)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| {
            std::fs::read_dir(e.path())
                .unwrap()
                .filter(|f| {
                    f.as_ref()
                        .unwrap()
                        .path()
                        .extension()
                        .is_some_and(|x| x == "ts")
                })
                .count()
        })
        .sum()
}

#[test]
fn replay_recording_pause_and_recovery() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("cliplock_capture=info")
        .with_test_writer()
        .try_init();
    let Some(ff) = ffmpeg() else { return };
    let caps = ff.probe_capabilities().expect("probe");
    assert!(!caps.encoders.is_empty(), "no working encoder: {caps:?}");
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    let clips = tmp.path().join("clips");

    let engine = CaptureEngine::new(ff.clone(), caps.clone(), &work, config()).unwrap();
    assert!(engine.recover_interrupted().is_empty());

    // ---- Instant Replay: rolling buffer is bounded and saving yields the last N seconds.
    engine.start_replay(3).unwrap();
    std::thread::sleep(Duration::from_secs(8));
    let status = engine.status();
    let replay = status.replay.clone().unwrap();
    assert!(
        replay.buffered_seconds >= 2.5,
        "buffered {}",
        replay.buffered_seconds
    );
    let segs = session_segment_count(&work);
    assert!(
        segs <= 7,
        "ring buffer must prune old segments, found {segs}"
    );
    assert!(status.stats.unwrap().frames > 100);

    let replay_path = clips.join("replay it's.mp4");
    let saved = engine.save_replay(&replay_path, Some(3)).unwrap();
    assert!(
        saved.info.duration_secs >= 2.9 && saved.info.duration_secs <= 4.6,
        "replay duration {}",
        saved.info.duration_secs
    );
    assert_eq!((saved.info.width, saved.info.height), (640, 360));
    assert_eq!(saved.info.audio_tracks, 3, "mixed + system + microphone");
    assert_faststart(&replay_path);
    let (v, a) = stream_durations(&ff, &replay_path);
    for d in &a {
        assert!(
            (v - d).abs() < 0.35,
            "audio/video drift: video {v} audio {d}"
        );
    }

    // ---- Manual recording while the replay buffer runs, with a pause.
    let rec_path = clips.join("recording.mp4");
    engine.start_recording(&rec_path).unwrap();
    std::thread::sleep(Duration::from_millis(2500));
    engine.pause_recording().unwrap();
    assert!(engine.status().recording.unwrap().paused);
    std::thread::sleep(Duration::from_millis(3500));
    engine.resume_recording().unwrap();
    std::thread::sleep(Duration::from_millis(2500));
    let rec = engine.stop_recording().unwrap();
    // 8.5s wall time minus 3.5s paused; each of the 3 cuts is within half a segment.
    assert!(
        rec.info.duration_secs >= 3.5 && rec.info.duration_secs <= 6.6,
        "recording duration {}",
        rec.info.duration_secs
    );
    assert_faststart(&rec_path);
    assert!(
        engine.status().running,
        "replay keeps running after the recording stops"
    );
    engine.stop_replay();
    assert!(!engine.status().running);

    // ---- Recording without the replay buffer owns (and cleans up) its session.
    let solo_path = clips.join("solo.mp4");
    engine.start_recording(&solo_path).unwrap();
    std::thread::sleep(Duration::from_secs(3));

    // Snapshot the on-disk state mid-recording to simulate a crash.
    let crash_work = tmp.path().join("crash-work");
    copy_dir(&work, &crash_work);
    let solo = engine.stop_recording().unwrap();
    assert!(
        solo.info.duration_secs >= 2.0 && solo.info.duration_secs <= 4.5,
        "solo duration {}",
        solo.info.duration_secs
    );
    assert!(!engine.status().running);
    assert_eq!(
        std::fs::read_dir(work.join("sessions")).unwrap().count(),
        0,
        "session buffer deleted"
    );
    assert_eq!(
        std::fs::read_dir(work.join("recordings")).unwrap().count(),
        0,
        "manifest deleted"
    );
    drop(engine);

    // ---- Crash recovery: a fresh engine finalizes the interrupted recording.
    let recovered_path = clips.join("recovered.mp4");
    for entry in std::fs::read_dir(crash_work.join("recordings")).unwrap() {
        let path = entry.unwrap().path();
        let mut m: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let session = PathBuf::from(m["sessionDir"].as_str().unwrap());
        m["sessionDir"] = crash_work
            .join("sessions")
            .join(session.file_name().unwrap())
            .to_string_lossy()
            .into();
        m["outputPath"] = recovered_path.to_string_lossy().into();
        std::fs::write(&path, serde_json::to_vec(&m).unwrap()).unwrap();
    }
    let engine2 = CaptureEngine::new(ff.clone(), caps, &crash_work, config()).unwrap();
    let recovered = engine2.recover_interrupted();
    assert_eq!(recovered.len(), 1);
    let clip = recovered
        .into_iter()
        .next()
        .unwrap()
        .expect("recovered clip");
    assert!(
        clip.info.duration_secs >= 1.0,
        "recovered duration {}",
        clip.info.duration_secs
    );
    assert_eq!(
        std::fs::read_dir(crash_work.join("sessions"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn edit_export_trims_and_changes_speed() {
    let Some(ff) = ffmpeg() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src.mp4");
    let status = Command::new(&ff.ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30:d=6",
        ])
        .args([
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:d=6",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(status.success());

    let out = tmp.path().join("edit.mp4");
    let mut last = 0.0;
    let spec = cliplock_capture::EditSpec {
        input: src.clone(),
        output: out.clone(),
        trim_start_secs: 1.0,
        trim_end_secs: 5.0,
        speed: 2.0,
        mute: false,
        volume: 0.5,
        lossless: false,
    };
    let info = cliplock_capture::media::export_edit(&ff, &spec, None, |p| last = p).unwrap();
    assert!(
        (info.duration_secs - 2.0).abs() < 0.25,
        "edited duration {}",
        info.duration_secs
    );
    assert_eq!(last, 1.0);
    assert_faststart(&out);

    let lossless_out = tmp.path().join("lossless.mp4");
    let spec = cliplock_capture::EditSpec {
        output: lossless_out,
        speed: 1.0,
        volume: 1.0,
        lossless: true,
        ..spec
    };
    let info = cliplock_capture::media::export_edit(&ff, &spec, None, |_| {}).unwrap();
    assert!(
        info.duration_secs >= 3.5 && info.duration_secs <= 5.2,
        "lossless duration {}",
        info.duration_secs
    );

    let thumb = tmp.path().join("thumb.jpg");
    cliplock_capture::media::thumbnail(&ff, &src, &thumb, 1.0, 320).unwrap();
    assert!(std::fs::metadata(&thumb).unwrap().len() > 1000);
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), dest).unwrap();
        }
    }
}
