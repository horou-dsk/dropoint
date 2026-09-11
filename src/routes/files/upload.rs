use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json,
    extract::{Multipart, Query, State},
};
use serde::{Deserialize, Serialize};
use tempfile::TempPath;
use tokio::io::AsyncWriteExt;

use super::{FileError, ensure_inside, relative_string, safe_relative_path};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct UploadQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    conflict: ConflictMode,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ConflictMode {
    #[default]
    Fail,
    Rename,
    Overwrite,
}

#[derive(Serialize)]
pub struct UploadResult {
    path: String,
    size: u64,
}

struct StagedUpload {
    temporary: TempPath,
    target: PathBuf,
    size: u64,
}

pub async fn upload_file(
    State(state): State<AppState>,
    Query(query): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<UploadResult>, FileError> {
    let mut relative_path = None;
    let mut staged = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| FileError::InvalidUpload)?
    {
        match field.name() {
            Some("relative_path") if staged.is_none() => {
                relative_path = Some(field.text().await.map_err(|_| FileError::InvalidUpload)?);
            }
            Some("file") if staged.is_none() => {
                let relative_path = relative_path
                    .take()
                    .or_else(|| field.file_name().map(str::to_owned))
                    .ok_or(FileError::InvalidUpload)?;
                let root = Arc::clone(&state.root);
                let destination = query.path.clone(); // Owned by the blocking filesystem task.
                let conflict = query.conflict;
                let (file, mut upload) = tokio::task::spawn_blocking(move || {
                    prepare_upload(&root, &destination, &relative_path, conflict)
                })
                .await
                .map_err(|error| FileError::Io(std::io::Error::other(error)))??;
                let mut file = tokio::fs::File::from_std(file);
                let written = async {
                    while let Some(chunk) =
                        field.chunk().await.map_err(|_| FileError::InvalidUpload)?
                    {
                        file.write_all(&chunk).await?;
                        upload.size += chunk.len() as u64;
                    }
                    file.flush().await?;
                    Ok::<(), FileError>(())
                }
                .await;
                // Close before TempPath can remove the file on an error (also on Windows).
                drop(file);
                written?;
                staged = Some(upload);
            }
            _ => return Err(FileError::InvalidUpload),
        }
    }
    // Only commit once the complete multipart envelope has been validated.
    let upload = staged.ok_or(FileError::InvalidUpload)?;
    tokio::task::spawn_blocking(move || commit_upload(&state.root, upload, query.conflict))
        .await
        .map_err(|error| FileError::Io(std::io::Error::other(error)))?
        .map(Json)
}

fn prepare_upload(
    root: &Path,
    destination: &str,
    relative_path: &str,
    conflict: ConflictMode,
) -> Result<(fs::File, StagedUpload), FileError> {
    let destination = fs::canonicalize(root.join(safe_relative_path(destination)?))?;
    ensure_inside(root, &destination)?;
    if !destination.is_dir() {
        return Err(FileError::BadPath);
    }
    let relative = safe_relative_path(relative_path)?;
    let filename = relative.file_name().ok_or(FileError::BadPath)?;
    let mut parent = destination;
    for component in relative.parent().ok_or(FileError::BadPath)?.components() {
        let next = parent.join(component);
        match fs::symlink_metadata(&next) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Check the existing ancestor before creating anything beneath it.
                let checked = fs::canonicalize(&parent)?;
                ensure_inside(root, &checked)?;
                match fs::create_dir(&next) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) => return Err(error.into()),
        }
        parent = fs::canonicalize(next)?;
        ensure_inside(root, &parent)?;
        if !parent.is_dir() {
            return Err(FileError::BadPath);
        }
    }
    let target = parent.join(filename);
    if target_exists(root, &target)? {
        match conflict {
            ConflictMode::Fail => return Err(FileError::Conflict(relative_string(root, &target))),
            ConflictMode::Overwrite if !target.is_file() => return Err(FileError::BadPath),
            _ => {}
        }
    }
    // Same-directory staging allows an atomic commit on the destination filesystem.
    let (file, temporary) = tempfile::Builder::new()
        .prefix(".dropoint-upload-")
        .tempfile_in(parent)?
        .into_parts();
    Ok((
        file,
        StagedUpload {
            temporary,
            target,
            size: 0,
        },
    ))
}

fn target_exists(root: &Path, target: &Path) -> Result<bool, FileError> {
    match fs::symlink_metadata(target) {
        Ok(_) => {
            ensure_inside(root, &fs::canonicalize(target)?)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn commit_upload(
    root: &Path,
    upload: StagedUpload,
    conflict: ConflictMode,
) -> Result<UploadResult, FileError> {
    let StagedUpload {
        mut temporary,
        target,
        size,
    } = upload;
    let parent = target.parent().ok_or(FileError::BadPath)?;
    ensure_inside(root, &fs::canonicalize(parent)?)?;
    if matches!(conflict, ConflictMode::Overwrite) {
        if target_exists(root, &target)? && !target.is_file() {
            return Err(FileError::BadPath);
        }
        temporary
            .persist(&target)
            .map_err(|error| FileError::from(error.error))?;
        return Ok(UploadResult {
            path: relative_string(root, &target),
            size,
        });
    }

    let mut candidate = target.to_path_buf();
    let mut index = 0_u64;
    loop {
        match temporary.persist_noclobber(&candidate) {
            Ok(()) => {
                return Ok(UploadResult {
                    path: relative_string(root, &candidate),
                    size,
                });
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if matches!(conflict, ConflictMode::Fail) {
                    return Err(FileError::Conflict(relative_string(root, &candidate)));
                }
                temporary = error.path;
                index += 1;
                let stem = target
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .ok_or(FileError::BadPath)?;
                let extension = target
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| format!(".{value}"))
                    .unwrap_or_default();
                candidate = target.with_file_name(format!("{stem} ({index}){extension}"));
            }
            Err(error) => return Err(error.error.into()),
        }
    }
}
