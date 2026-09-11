use std::{fs, path::Path};

use axum::{Json, extract::State};
use serde::Serialize;

use super::{
    FileError,
    batch::{PathsRequest, display_path, is_link, validate_path, validate_paths},
};
use crate::state::AppState;

#[derive(Serialize)]
pub struct DeleteFailure {
    path: String,
    message: String,
}

#[derive(Serialize)]
pub struct DeleteResult {
    deleted: Vec<String>,
    failed: Vec<DeleteFailure>,
}

pub async fn delete_files(
    State(state): State<AppState>,
    Json(request): Json<PathsRequest>,
) -> Result<Json<DeleteResult>, FileError> {
    tokio::task::spawn_blocking(move || {
        let paths = validate_paths(&state.root, request.paths)?;
        let mut result = DeleteResult {
            deleted: Vec::new(),
            failed: Vec::new(),
        };
        for relative in paths {
            let path = display_path(&relative);
            // Recheck immediately before removal, in case another client changed the directory.
            let outcome = validate_path(&state.root, &relative)
                .and_then(|()| remove_entry(&state.root.join(&relative)).map_err(FileError::from));
            match outcome {
                Ok(()) => result.deleted.push(path),
                Err(error) => result.failed.push(DeleteFailure {
                    path,
                    message: match error {
                        FileError::NotFound => "项目已不存在".to_owned(),
                        FileError::Io(error) => format!("删除失败，目录可能已部分删除：{error}"),
                        _ => "路径已变化或不允许访问".to_owned(),
                    },
                }),
            }
        }
        Ok(Json(result))
    })
    .await
    .map_err(|error| FileError::OperationFailed(error.to_string()))?
}

fn remove_entry(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if is_link(&metadata) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x10 != 0 {
                return fs::remove_dir(path);
            }
        }
        fs::remove_file(path)
    } else if metadata.is_dir() {
        // The platform implementation removes nested links without following them.
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}
