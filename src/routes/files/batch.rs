use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;

use super::{FileError, ensure_inside, safe_relative_path};

#[derive(Deserialize)]
pub struct PathsRequest {
    pub paths: Vec<String>,
}

pub fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points must not be traversed either.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

// Validate ancestors without resolving the final link into its target.
pub fn validate_path(root: &Path, relative: &Path) -> Result<(), FileError> {
    let mut current = root.to_path_buf();
    let count = relative.components().count();
    for (index, component) in relative.components().enumerate() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        };
        if is_link(&metadata) {
            if index + 1 < count {
                return Err(FileError::InvalidOperation(format!(
                    "不能通过链接访问文件：{}",
                    display_path(relative)
                )));
            }
        } else {
            let canonical = fs::canonicalize(&current)?;
            ensure_inside(root, &canonical)?;
            if canonical == root || (index + 1 < count && !metadata.is_dir()) {
                return Err(FileError::BadPath);
            }
        }
    }
    Ok(())
}

pub fn validate_paths(root: &Path, values: Vec<String>) -> Result<Vec<PathBuf>, FileError> {
    if values.is_empty() {
        return Err(FileError::InvalidOperation("请至少选择一个项目".to_owned()));
    }
    let mut paths = Vec::with_capacity(values.len());
    // Validate every input before deduplication or any destructive operation.
    for value in values {
        let path = safe_relative_path(&value)?;
        if path.as_os_str().is_empty() {
            return Err(FileError::BadPath);
        }
        validate_path(root, &path)?;
        paths.push(path);
    }
    paths.sort_by_key(|path| path.components().count());
    let mut unique: Vec<PathBuf> = Vec::new();
    for path in paths {
        if !unique.iter().any(|parent| path.starts_with(parent)) {
            unique.push(path);
        }
    }
    Ok(unique)
}
