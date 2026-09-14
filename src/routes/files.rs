use std::{
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use axum::{
    Json,
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use mime_guess::MimeGuess;
use serde::{Deserialize, Serialize};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt},
};
use tokio_util::io::ReaderStream;

use crate::state::AppState;

pub(crate) mod archive;
mod batch;
mod delete;
mod range;
mod upload;

pub use archive::{create_archive, download_archive};
pub use delete::delete_files;
pub use upload::{check_upload, upload_file};

#[derive(Debug, Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct DirectoryInfo {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified: Option<u64>,
    pub mime: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug)]
pub enum FileError {
    BadPath,
    NotFound,
    Conflict(String),
    InvalidUpload,
    InvalidOperation(String),
    OperationFailed(String),
    Io(std::io::Error),
}

impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            Self::NotFound
        } else {
            Self::Io(error)
        }
    }
}

impl IntoResponse for FileError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            Self::BadPath => (
                StatusCode::BAD_REQUEST,
                "invalid_path",
                "路径无效".to_owned(),
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "文件或目录不存在".to_owned(),
            ),
            Self::Conflict(path) => (StatusCode::CONFLICT, "file_exists", path),
            Self::InvalidUpload => (
                StatusCode::BAD_REQUEST,
                "invalid_upload",
                "上传内容无效".to_owned(),
            ),
            Self::InvalidOperation(message) => {
                (StatusCode::BAD_REQUEST, "invalid_operation", message)
            }
            Self::OperationFailed(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "operation_failed",
                message,
            ),
            Self::Io(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "io_error",
                error.to_string(),
            ),
        };
        (
            status,
            Json(serde_json::json!({ "error": error, "message": message })),
        )
            .into_response()
    }
}

pub async fn info(State(state): State<AppState>) -> Json<DirectoryInfo> {
    let name = state
        .root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("共享目录")
        .to_owned();
    Json(DirectoryInfo { name })
}

pub async fn list_files(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<DirectoryListing>, FileError> {
    let directory = resolve_existing(&state.root, &query.path).await?;
    let metadata = fs::metadata(&directory).await?;
    if !metadata.is_dir() {
        return Err(FileError::BadPath);
    }

    let mut entries = Vec::new();
    let mut directory_entries = fs::read_dir(&directory).await?;
    while let Some(entry) = directory_entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        let relative_path = relative_string(&state.root, &entry.path());
        let kind = if metadata.is_dir() {
            EntryKind::Directory
        } else {
            EntryKind::File
        };
        let mime = metadata.is_file().then(|| mime_for_path(&entry.path()));
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs());
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: relative_path,
            kind,
            size: metadata.len(),
            modified,
            mime,
        });
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(Json(DirectoryListing {
        path: normalize_display_path(&query.path),
        entries,
    }))
}

pub async fn download_file(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
    headers: HeaderMap,
) -> Result<Response, FileError> {
    stream_file(&state.root, &query.path, true, &headers).await
}

pub async fn preview_file(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
    headers: HeaderMap,
) -> Result<Response, FileError> {
    stream_file(&state.root, &query.path, false, &headers).await
}

async fn stream_file(
    root: &Path,
    relative_path: &str,
    download: bool,
    headers: &HeaderMap,
) -> Result<Response, FileError> {
    let file_path = resolve_existing(root, relative_path).await?;
    let mut file = fs::File::open(&file_path).await?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(FileError::BadPath);
    }
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .replace('"', "");
    let disposition = format!(
        r#"{}; filename="{}""#,
        if download { "attachment" } else { "inline" },
        file_name
    );
    let size = metadata.len();
    let selection = range::select(headers, size);
    let mut response = Response::builder().header(header::ACCEPT_RANGES, "bytes");
    let (start, length) = match selection {
        range::Selection::Full => (0, size),
        range::Selection::Partial { start, end } => {
            response = response
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
            (start, end - start + 1)
        }
        range::Selection::Unsatisfiable => {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::CONTENT_LENGTH, 0)
                .body(Body::empty())
                .map_err(|error| FileError::Io(std::io::Error::other(error)));
        }
    };
    file.seek(std::io::SeekFrom::Start(start)).await?;
    response
        .header(
            header::CONTENT_TYPE,
            mime_for_path(Path::new(relative_path)),
        )
        .header(header::CONTENT_LENGTH, length)
        .header(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&disposition)
                .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
        )
        .body(Body::from_stream(ReaderStream::new(file.take(length))))
        .map_err(|error| FileError::Io(std::io::Error::other(error)))
}

async fn resolve_existing(root: &Path, relative_path: &str) -> Result<PathBuf, FileError> {
    let relative_path = safe_relative_path(relative_path)?;
    let path = fs::canonicalize(root.join(relative_path)).await?;
    ensure_inside(root, &path)?;
    Ok(path)
}

fn safe_relative_path(value: &str) -> Result<PathBuf, FileError> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(FileError::BadPath);
    }
    Ok(path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            _ => None,
        })
        .collect())
}

fn ensure_inside(root: &Path, path: &Path) -> Result<(), FileError> {
    path.strip_prefix(root)
        .map(|_| ())
        .map_err(|_| FileError::BadPath)
}

fn relative_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalize_display_path(path: &str) -> String {
    path.replace('\\', "/").trim_matches('/').to_owned()
}

fn mime_for_path(path: &Path) -> String {
    MimeGuess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::safe_relative_path;

    #[test]
    fn rejects_parent_paths() {
        assert!(safe_relative_path("../secret.txt").is_err());
        assert!(safe_relative_path("folder/../../secret.txt").is_err());
    }
}
