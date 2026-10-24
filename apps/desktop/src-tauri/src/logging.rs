//! Logs go to a daily rolling file in the app log directory; panics are additionally
//! written to a crash report so they can be attached to bug reports.

use std::io::Write;
use std::path::{Path, PathBuf};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

pub fn init(log_dir: &Path) -> Option<WorkerGuard> {
    let filter = EnvFilter::try_from_env("CLIPLOCK_LOG").unwrap_or_else(|_| EnvFilter::new("info,ffmpeg=warn"));
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("cliplock")
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir);
    let (file_layer, guard) = match appender {
        Ok(appender) => {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            (Some(fmt::layer().with_ansi(false).with_writer(writer)), Some(guard))
        }
        Err(e) => {
            eprintln!("file logging unavailable: {e}");
            (None, None)
        }
    };
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(fmt::layer().with_writer(std::io::stderr))
        .try_init();
    install_panic_hook(log_dir.to_path_buf());
    guard
}

fn install_panic_hook(log_dir: PathBuf) {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let path = log_dir.join(format!("crash-{stamp}.log"));
        if let Ok(mut f) = std::fs::File::create(&path) {
            let _ = writeln!(f, "ClipLock {} crashed", env!("CARGO_PKG_VERSION"));
            let _ = writeln!(f, "os: {} {}", std::env::consts::OS, std::env::consts::ARCH);
            let _ = writeln!(f, "{info}");
            let _ = writeln!(f, "{}", std::backtrace::Backtrace::force_capture());
        }
        tracing::error!("panic: {info} (crash report: {})", path.display());
        default(info);
    }));
}
