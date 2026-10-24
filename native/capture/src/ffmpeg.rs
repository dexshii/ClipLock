//! Locating the FFmpeg executables and discovering what this machine can encode.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::{Codec, EncoderKind};
use crate::error::{CaptureError, Result};
use crate::platform;

#[derive(Debug, Clone)]
pub struct Ffmpeg {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

impl Ffmpeg {
    /// Looks for `ffmpeg`/`ffprobe` in the given directories first (e.g. the directory
    /// next to the ClipLock executable, where the installer places them), then `PATH`.
    pub fn locate(preferred_dirs: &[PathBuf]) -> Result<Self> {
        let mut searched = Vec::new();
        let mut candidates: Vec<PathBuf> = preferred_dirs.to_vec();
        if let Some(path) = std::env::var_os("CLIPLOCK_FFMPEG_DIR") {
            candidates.insert(0, PathBuf::from(path));
        }
        if let Some(path) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&path));
        }
        for dir in candidates {
            let ffmpeg = find_in_dir(&dir, "ffmpeg");
            let ffprobe = find_in_dir(&dir, "ffprobe");
            searched.push(dir);
            if let (Some(ffmpeg), Some(ffprobe)) = (ffmpeg, ffprobe) {
                return Ok(Self { ffmpeg, ffprobe });
            }
        }
        Err(CaptureError::FfmpegNotFound(searched))
    }

    pub fn command(&self) -> Command {
        let mut cmd = Command::new(&self.ffmpeg);
        platform::configure_command(&mut cmd);
        cmd.arg("-hide_banner");
        cmd
    }

    pub fn probe_command(&self) -> Command {
        let mut cmd = Command::new(&self.ffprobe);
        platform::configure_command(&mut cmd);
        cmd.arg("-hide_banner");
        cmd
    }

    pub fn version(&self) -> Result<String> {
        let out = run_with_timeout(self.command().arg("-version"), Duration::from_secs(10))?;
        Ok(out.stdout.lines().next().unwrap_or_default().trim().to_string())
    }

    /// Queries the FFmpeg build and test-encodes a few frames with every candidate
    /// encoder. Listing an encoder only means FFmpeg was compiled with it; the test
    /// encode tells us whether the GPU and driver actually support it.
    pub fn probe_capabilities(&self) -> Result<Capabilities> {
        let version = self.version()?;
        let encoders_out = run_with_timeout(self.command().arg("-encoders"), Duration::from_secs(10))?;
        let compiled: BTreeSet<String> = parse_name_list(&encoders_out.stdout);
        let filters_out = run_with_timeout(self.command().arg("-filters"), Duration::from_secs(10))?;
        let filters: BTreeSet<String> = parse_name_list(&filters_out.stdout);

        let mut encoders = Vec::new();
        for codec in [Codec::H264, Codec::Hevc, Codec::Av1] {
            for kind in ENCODER_PREFERENCE {
                let Some(name) = encoder_name(kind, codec) else { continue };
                if !compiled.contains(name) {
                    continue;
                }
                let (works, hardware) = self.test_encode(kind, name);
                if works {
                    encoders.push(EncoderInfo { kind, codec, ffmpeg_name: name.to_string(), hardware });
                }
            }
        }

        Ok(Capabilities {
            ffmpeg_version: version,
            encoders,
            has_ddagrab: filters.contains("ddagrab"),
            has_gfxcapture: filters.contains("gfxcapture"),
            has_scale_d3d11: filters.contains("scale_d3d11"),
            has_aac: compiled.contains("aac"),
        })
    }

    fn test_encode(&self, kind: EncoderKind, name: &str) -> (bool, bool) {
        let pix_fmt = if kind == EncoderKind::OpenH264 { "yuv420p" } else { "nv12" };
        let attempt = |extra: &[&str]| -> bool {
            let mut cmd = self.command();
            cmd.args(["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i"])
                .arg("color=c=black:s=640x360:r=30:d=0.5")
                .args(["-frames:v", "5", "-vf"])
                .arg(format!("format={pix_fmt}"))
                .args(["-c:v", name])
                .args(extra)
                .args(["-f", "null", "-"]);
            matches!(run_with_timeout(&mut cmd, Duration::from_secs(15)), Ok(o) if o.success)
        };
        match kind {
            EncoderKind::MediaFoundation => {
                if attempt(&["-hw_encoding", "1"]) {
                    (true, true)
                } else {
                    (attempt(&[]), false)
                }
            }
            EncoderKind::Nvenc | EncoderKind::Amf | EncoderKind::Qsv => (attempt(&[]), true),
            _ => (attempt(&[]), false),
        }
    }
}

fn find_in_dir(dir: &Path, stem: &str) -> Option<PathBuf> {
    // Tauri sidecars are named with the target triple, e.g. ffmpeg-x86_64-pc-windows-msvc.exe.
    let names = [
        format!("{stem}{EXE_SUFFIX}"),
        format!("{stem}-{}{EXE_SUFFIX}", target_triple()),
    ];
    names.iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

fn target_triple() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else {
        "unknown"
    }
}

/// Parses the tabular output of `ffmpeg -encoders` / `ffmpeg -filters`: a header, a
/// `---` or ` = ` separator, then `<flags> <name> <description>` rows.
fn parse_name_list(text: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut in_body = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if !in_body {
            if trimmed.starts_with("---") || trimmed.starts_with("------") {
                in_body = true;
            }
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let (Some(_flags), Some(name)) = (parts.next(), parts.next()) else { continue };
        names.insert(name.to_string());
    }
    names
}

/// Encoder families in the order `Auto` tries them.
pub const ENCODER_PREFERENCE: [EncoderKind; 6] = [
    EncoderKind::Nvenc,
    EncoderKind::Amf,
    EncoderKind::Qsv,
    EncoderKind::MediaFoundation,
    EncoderKind::Software,
    EncoderKind::OpenH264,
];

pub fn encoder_name(kind: EncoderKind, codec: Codec) -> Option<&'static str> {
    use Codec::*;
    use EncoderKind::*;
    Some(match (kind, codec) {
        (Nvenc, H264) => "h264_nvenc",
        (Nvenc, Hevc) => "hevc_nvenc",
        (Nvenc, Av1) => "av1_nvenc",
        (Amf, H264) => "h264_amf",
        (Amf, Hevc) => "hevc_amf",
        (Amf, Av1) => "av1_amf",
        (Qsv, H264) => "h264_qsv",
        (Qsv, Hevc) => "hevc_qsv",
        (Qsv, Av1) => "av1_qsv",
        (MediaFoundation, H264) => "h264_mf",
        (MediaFoundation, Hevc) => "hevc_mf",
        (Software, H264) => "libx264",
        (Software, Hevc) => "libx265",
        (Software, Av1) => "libsvtav1",
        (OpenH264, H264) => "libopenh264",
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    pub kind: EncoderKind,
    pub codec: Codec,
    pub ffmpeg_name: String,
    pub hardware: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub ffmpeg_version: String,
    /// Encoders that passed a test encode, best first within each codec.
    pub encoders: Vec<EncoderInfo>,
    pub has_ddagrab: bool,
    pub has_gfxcapture: bool,
    pub has_scale_d3d11: bool,
    pub has_aac: bool,
}

impl Capabilities {
    /// Resolves the configured encoder to a concrete, working one.
    pub fn resolve_encoder(&self, kind: EncoderKind, codec: Codec) -> Result<EncoderInfo> {
        let mut matching = self.encoders.iter().filter(|e| e.codec == codec);
        if kind == EncoderKind::Auto {
            return matching.next().cloned().ok_or(CaptureError::NoEncoder);
        }
        matching
            .find(|e| e.kind == kind)
            .cloned()
            .ok_or_else(|| CaptureError::EncoderUnavailable(format!("{kind:?}/{codec:?}")))
    }

    /// Encoders to fall back to (in order) when `failed` cannot start.
    pub fn fallbacks_after(&self, failed: &EncoderInfo) -> Vec<EncoderInfo> {
        let codec_encoders: Vec<_> = self.encoders.iter().filter(|e| e.codec == failed.codec).collect();
        let pos = codec_encoders.iter().position(|e| *e == failed).map_or(0, |p| p + 1);
        let mut out: Vec<EncoderInfo> = codec_encoders[pos..].iter().map(|e| (*e).clone()).collect();
        // H.264 software encoding is the universal last resort for other codecs.
        if failed.codec != Codec::H264 {
            out.extend(self.encoders.iter().filter(|e| e.codec == Codec::H264 && !e.hardware).cloned());
        }
        out
    }

    pub fn supported_codecs(&self) -> Vec<Codec> {
        let mut codecs = Vec::new();
        for e in &self.encoders {
            if !codecs.contains(&e.codec) {
                codecs.push(e.codec);
            }
        }
        codecs
    }
}

pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a command to completion, killing it after `timeout`.
pub fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<CommandOutput> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let out_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    match status {
        Some(status) => Ok(CommandOutput { success: status.success(), stdout, stderr }),
        None => Err(CaptureError::Timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENCODERS_SAMPLE: &str = "Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
";

    #[test]
    fn parses_encoder_list() {
        let names = parse_name_list(ENCODERS_SAMPLE);
        assert!(names.contains("libx264"));
        assert!(names.contains("h264_nvenc"));
        assert!(names.contains("aac"));
        assert!(!names.contains("V....."));
        assert_eq!(names.len(), 3);
    }

    fn info(kind: EncoderKind, codec: Codec, hw: bool) -> EncoderInfo {
        EncoderInfo { kind, codec, ffmpeg_name: encoder_name(kind, codec).unwrap().into(), hardware: hw }
    }

    #[test]
    fn auto_resolves_to_best_and_falls_back() {
        let caps = Capabilities {
            ffmpeg_version: "test".into(),
            encoders: vec![
                info(EncoderKind::Nvenc, Codec::H264, true),
                info(EncoderKind::Software, Codec::H264, false),
                info(EncoderKind::Nvenc, Codec::Hevc, true),
            ],
            has_ddagrab: true,
            has_gfxcapture: false,
            has_scale_d3d11: false,
            has_aac: true,
        };
        let best = caps.resolve_encoder(EncoderKind::Auto, Codec::H264).unwrap();
        assert_eq!(best.kind, EncoderKind::Nvenc);
        let fb = caps.fallbacks_after(&best);
        assert_eq!(fb.len(), 1);
        assert_eq!(fb[0].kind, EncoderKind::Software);
        assert!(caps.resolve_encoder(EncoderKind::Amf, Codec::H264).is_err());
        let hevc = caps.resolve_encoder(EncoderKind::Auto, Codec::Hevc).unwrap();
        let fb = caps.fallbacks_after(&hevc);
        assert_eq!(fb.last().unwrap().ffmpeg_name, "libx264");
        assert!(caps.resolve_encoder(EncoderKind::Auto, Codec::Av1).is_err());
    }
}
