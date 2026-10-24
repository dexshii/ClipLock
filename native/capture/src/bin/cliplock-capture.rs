//! Command-line front end to the recording engine, for diagnostics and benchmarking on
//! real hardware without the desktop UI.
//!
//! ```text
//! cliplock-capture probe
//! cliplock-capture devices
//! cliplock-capture replay  [options] --seconds 30 --wait 45 --out clip.mp4
//! cliplock-capture record  [options] --duration 20 --out recording.mp4
//! cliplock-capture bench   [options] --duration 60
//!
//! options: --source monitor:0|window:<hwnd>|test   --height 1080|native   --fps 60
//!          --bitrate 20000   --codec h264|hevc|av1   --encoder auto|nvenc|amf|qsv|mf|software|openh264
//!          --mic   --no-system-audio   --separate-tracks   --synthetic-audio   --work <dir>
//! ```

use std::path::PathBuf;
use std::time::{Duration, Instant};

use cliplock_capture::{CaptureConfig, CaptureEngine, Codec, EncoderKind, Ffmpeg, VideoSource};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn opt<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn parse<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> Result<T, String> {
    match opt(args, name) {
        Some(v) => v
            .parse()
            .map_err(|_| format!("invalid value for {name}: {v}")),
        None => Ok(default),
    }
}

fn config_from(args: &[String]) -> Result<CaptureConfig, String> {
    let mut c = CaptureConfig::default();
    c.video.source = match opt(args, "--source").unwrap_or("monitor:0") {
        "test" => VideoSource::TestPattern,
        s if s.starts_with("monitor:") => VideoSource::Monitor {
            index: s[8..].parse().map_err(|_| "bad monitor index")?,
        },
        s if s.starts_with("window:") => VideoSource::Window {
            hwnd: s[7..].parse().map_err(|_| "bad hwnd")?,
        },
        s => return Err(format!("unknown source {s}")),
    };
    c.video.output_height = match opt(args, "--height") {
        Some("native") => None,
        Some(h) => Some(h.parse().map_err(|_| "bad height")?),
        None => c.video.output_height,
    };
    c.video.fps = parse(args, "--fps", c.video.fps)?;
    c.video.bitrate_kbps = parse(args, "--bitrate", c.video.bitrate_kbps)?;
    c.video.codec = match opt(args, "--codec").unwrap_or("h264") {
        "h264" => Codec::H264,
        "hevc" => Codec::Hevc,
        "av1" => Codec::Av1,
        s => return Err(format!("unknown codec {s}")),
    };
    c.video.encoder = match opt(args, "--encoder").unwrap_or("auto") {
        "auto" => EncoderKind::Auto,
        "nvenc" => EncoderKind::Nvenc,
        "amf" => EncoderKind::Amf,
        "qsv" => EncoderKind::Qsv,
        "mf" => EncoderKind::MediaFoundation,
        "software" => EncoderKind::Software,
        "openh264" => EncoderKind::OpenH264,
        s => return Err(format!("unknown encoder {s}")),
    };
    c.audio.microphone.enabled = flag(args, "--mic");
    c.audio.system.enabled = !flag(args, "--no-system-audio");
    c.audio.separate_tracks = flag(args, "--separate-tracks");
    c.audio.synthetic = flag(args, "--synthetic-audio");
    c.validate().map_err(|e| e.to_string())?;
    Ok(c)
}

fn engine(args: &[String]) -> Result<CaptureEngine, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    let ff = Ffmpeg::locate(&exe_dir.into_iter().collect::<Vec<_>>()).map_err(|e| e.to_string())?;
    let caps = ff.probe_capabilities().map_err(|e| e.to_string())?;
    let work = opt(args, "--work")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cliplock-capture-cli"));
    let engine =
        CaptureEngine::new(ff, caps, work, config_from(args)?).map_err(|e| e.to_string())?;
    engine.set_event_handler(std::sync::Arc::new(|e| {
        eprintln!("event: {}", serde_json::to_string(&e).unwrap_or_default());
    }));
    Ok(engine)
}

fn print_json<T: serde::Serialize>(value: &T) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
}

fn run(args: &[String]) -> Result<(), String> {
    let out = || {
        opt(args, "--out")
            .map(PathBuf::from)
            .ok_or("--out is required")
    };
    match args.first().map(String::as_str) {
        Some("probe") => {
            let ff = Ffmpeg::locate(&[]).map_err(|e| e.to_string())?;
            print_json(&ff.probe_capabilities().map_err(|e| e.to_string())?);
        }
        Some("devices") => print_json(&cliplock_capture::audio::list_devices()),
        Some("replay") => {
            let engine = engine(args)?;
            let seconds: u32 = parse(args, "--seconds", 30)?;
            engine.start_replay(seconds).map_err(|e| e.to_string())?;
            std::thread::sleep(Duration::from_secs(parse(
                args,
                "--wait",
                seconds as u64 + 5,
            )?));
            let started = Instant::now();
            let clip = engine
                .save_replay(&out()?, None)
                .map_err(|e| e.to_string())?;
            eprintln!("saved in {:?}", started.elapsed());
            print_json(&clip);
        }
        Some("record") => {
            let engine = engine(args)?;
            engine.start_recording(&out()?).map_err(|e| e.to_string())?;
            std::thread::sleep(Duration::from_secs(parse(args, "--duration", 10)?));
            print_json(&engine.stop_recording().map_err(|e| e.to_string())?);
        }
        Some("bench") => {
            let engine = engine(args)?;
            let duration: u64 = parse(args, "--duration", 60)?;
            engine.start_replay(30).map_err(|e| e.to_string())?;
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(duration) {
                std::thread::sleep(Duration::from_secs(5));
                let s = engine.status();
                eprintln!(
                    "t={:>4.0}s encoder={} gpu_path={} stats={}",
                    start.elapsed().as_secs_f64(),
                    s.encoder.as_ref().map_or("-", |e| e.ffmpeg_name.as_str()),
                    s.gpu_path,
                    serde_json::to_string(&s.stats).unwrap_or_default()
                );
            }
            print_json(&engine.status());
        }
        _ => {
            eprintln!("usage: cliplock-capture <probe|devices|replay|record|bench> [options] (see source for options)");
            return Err("missing or unknown command".into());
        }
    }
    Ok(())
}
