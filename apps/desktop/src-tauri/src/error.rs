use serde::Serialize;

/// Error type returned by Tauri commands. Serialized as `{ "kind": ..., "message": ... }`
/// so the UI can show a meaningful message.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Capture(#[from] cliplock_capture::CaptureError),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
    #[error("{0}")]
    Http(#[from] reqwest::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotReady(String),
    #[error("sign in required")]
    Unauthorized,
    #[error("{message}")]
    Api { status: u16, code: String, message: String },
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::Capture(_) => "capture",
            AppError::Db(_) => "database",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
            AppError::Tauri(_) => "app",
            AppError::Http(_) => "network",
            AppError::NotFound(_) => "notFound",
            AppError::Invalid(_) => "invalid",
            AppError::NotReady(_) => "notReady",
            AppError::Unauthorized => "unauthorized",
            AppError::Api { .. } => "api",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
