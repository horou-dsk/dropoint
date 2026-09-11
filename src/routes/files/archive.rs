use std::{
    collections::HashMap,
    fs,
    io::{self, Seek},
    path::Path,
    sync::Arc,
    time::Duration,
};

use axum::{
    Json,
    body::Body,
    extract::{Path as RoutePath, State},
    http::{HeaderValue, header},
    response::Response,
};
use futures_util::{StreamExt, stream};
use serde::Serialize;
use tempfile::NamedTempFile;
use tokio::{sync::Mutex, time::Instant};
use tokio_util::io::ReaderStream;
use zip::{ZipWriter, write::SimpleFileOptions};

use super::{
    FileError,
    batch::{PathsRequest, display_path, is_link, validate_path, validate_paths},
};
use crate::state::AppState;

const ARCHIVE_LIFETIME: Duration = Duration::from_secs(10 * 60);

struct Archive {
    file: NamedTempFile,
    filename: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct ArchiveStore {
    entries: Mutex<HashMap<String, Arc<Archive>>>,
}

impl ArchiveStore {
    async fn insert(self: &Arc<Self>, file: NamedTempFile, filename: String) -> ArchiveResponse {
        let id = uuid::Uuid::new_v4().to_string();
        let expires_at = Instant::now() + ARCHIVE_LIFETIME;
        let response = ArchiveResponse {
            url: format!("/api/files/archive/{id}"),
            filename: filename.clone(),
        };
        self.entries.lock().await.insert(
            id.clone(),
            Arc::new(Archive {
                file,
                filename,
                expires_at,
            }),
        );
        // The timer must not keep the application or its temporary files alive on shutdown.
        let store = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep_until(expires_at).await;
            if let Some(store) = store.upgrade() {
                store.entries.lock().await.remove(&id);
            }
        });
        response
    }

    async fn get(&self, id: &str) -> Result<Arc<Archive>, FileError> {
        let mut entries = self.entries.lock().await;
        if entries
            .get(id)
            .is_some_and(|entry| entry.expires_at <= Instant::now())
        {
            entries.remove(id);
        }
        entries.get(id).map(Arc::clone).ok_or(FileError::NotFound)
    }
}

#[derive(Serialize)]
pub struct ArchiveResponse {
    url: String,
    filename: String,
}

pub async fn create_archive(
    State(state): State<AppState>,
    Json(request): Json<PathsRequest>,
) -> Result<Json<ArchiveResponse>, FileError> {
    let root = state.root;
    let (file, filename) = tokio::task::spawn_blocking(move || build_archive(&root, request.paths))
        .await
        .map_err(|error| FileError::OperationFailed(error.to_string()))??;
    Ok(Json(state.archives.insert(file, filename).await))
}

pub async fn download_archive(
    State(state): State<AppState>,
    RoutePath(id): RoutePath<String>,
) -> Result<Response, FileError> {
    let archive = state.archives.get(&id).await?;
    let size = archive.file.as_file().metadata()?.len();
    let file = tokio::fs::File::from_std(archive.file.reopen()?);
    let encoded: String = archive
        .filename
        .as_bytes()
        .iter()
        .map(|byte| format!("%{byte:02X}"))
        .collect();
    let disposition = HeaderValue::from_str(&format!(
        "attachment; filename=\"dropoint.zip\"; filename*=UTF-8''{encoded}"
    ))
    .map_err(|error| FileError::OperationFailed(error.to_string()))?;
    // Keep the tempfile owner alive until the reader closes, even after the URL expires.
    let body = stream::unfold(
        (ReaderStream::new(file), archive),
        |(mut reader, archive)| async move {
            reader.next().await.map(|chunk| (chunk, (reader, archive)))
        },
    );
    Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_LENGTH, size)
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(body))
        .map_err(|error| FileError::OperationFailed(error.to_string()))
}

fn build_archive(root: &Path, values: Vec<String>) -> Result<(NamedTempFile, String), FileError> {
    let paths = validate_paths(root, values)?;
    let mut base = paths[0].parent().unwrap_or(Path::new(""));
    for path in &paths[1..] {
        while !path.starts_with(base) {
            base = base.parent().unwrap_or(Path::new(""));
        }
    }
    let filename = if paths.len() == 1 {
        format!(
            "{}.zip",
            paths[0].file_name().unwrap_or_default().to_string_lossy()
        )
    } else {
        "dropoint-selection.zip".to_owned()
    };
    let temporary_directory = fs::canonicalize(std::env::temp_dir())?;
    if temporary_directory.starts_with(root) {
        return Err(FileError::InvalidOperation(
            "系统临时目录位于共享目录内，无法在共享目录外生成归档".to_owned(),
        ));
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".dropoint-archive-")
        .tempfile_in(temporary_directory)?;
    {
        let mut archive = ZipWriter::new(temporary.as_file_mut());
        for path in &paths {
            append_entry(&mut archive, root, path, base)?;
        }
        archive.finish().map_err(zip_error)?;
    }
    temporary.as_file_mut().rewind()?;
    Ok((temporary, filename))
}

fn append_entry<W: io::Write + Seek>(
    archive: &mut ZipWriter<W>,
    root: &Path,
    relative: &Path,
    base: &Path,
) -> Result<(), FileError> {
    validate_path(root, relative)?;
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).map_err(|error| entry_error(relative, error))?;
    if is_link(&metadata) {
        return Err(FileError::InvalidOperation(format!(
            "无法打包链接：{}",
            display_path(relative)
        )));
    }
    let archive_path = relative
        .strip_prefix(base)
        .map_err(|_| FileError::BadPath)?;
    let mut components = Vec::new();
    for component in archive_path.components() {
        let name = component.as_os_str().to_str().ok_or(FileError::BadPath)?;
        // A backslash is a legal Unix filename character, but ZIP readers may treat it as a separator.
        if name.contains('\\') {
            return Err(FileError::BadPath);
        }
        components.push(name);
    }
    let name = components.join("/");
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(metadata.len() > u32::MAX as u64);
    if metadata.is_dir() {
        archive
            .add_directory(format!("{name}/"), options)
            .map_err(zip_error)?;
        for entry in fs::read_dir(&path).map_err(|error| entry_error(relative, error))? {
            let entry = entry.map_err(|error| entry_error(relative, error))?;
            append_entry(archive, root, &relative.join(entry.file_name()), base)?;
        }
    } else if metadata.is_file() {
        archive.start_file(name, options).map_err(zip_error)?;
        let mut file = fs::File::open(&path).map_err(|error| entry_error(relative, error))?;
        io::copy(&mut file, archive).map_err(|error| entry_error(relative, error))?;
    } else {
        return Err(FileError::InvalidOperation(format!(
            "不支持打包此文件类型：{}",
            display_path(relative)
        )));
    }
    Ok(())
}

fn entry_error(path: &Path, error: io::Error) -> FileError {
    FileError::OperationFailed(format!("无法打包 {}：{error}", display_path(path)))
}

fn zip_error(error: zip::result::ZipError) -> FileError {
    FileError::OperationFailed(format!("生成 ZIP 失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn expiry_removes_unused_archives_but_keeps_active_readers_alive() {
        let store = Arc::new(ArchiveStore::default());
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        let response = store.insert(file, "test.zip".to_owned()).await;
        let id = response.url.rsplit('/').next().unwrap();
        let active = store.get(id).await.unwrap();
        tokio::time::advance(ARCHIVE_LIFETIME).await;
        assert!(matches!(store.get(id).await, Err(FileError::NotFound)));
        assert!(path.exists());
        drop(active);
        assert!(!path.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_cleans_unused_files_without_a_followup_request() {
        let store = Arc::new(ArchiveStore::default());
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        store.insert(file, "test.zip".to_owned()).await;
        tokio::task::yield_now().await;
        tokio::time::advance(ARCHIVE_LIFETIME).await;
        tokio::task::yield_now().await;
        assert!(!path.exists());
        assert!(store.entries.lock().await.is_empty());
    }
}
