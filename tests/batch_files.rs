use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::Response,
};
use dropoint::app::create_app;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn post(app: &Router, action: &str, paths: &[&str]) -> Response {
    app.clone()
        .oneshot(
            Request::post(format!("/api/files/{action}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "paths": paths }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn body_json(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

#[tokio::test]
async fn archives_preserve_hierarchy_empty_directories_and_unicode_without_duplicates() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("Documents/资料/empty")).unwrap();
    std::fs::write(root.join("Documents/资料/说明.txt"), "你好 Dropoint").unwrap();
    std::fs::write(root.join("Documents/notes.txt"), "notes").unwrap();
    let app = create_app(root.to_path_buf());
    let response = post(
        &app,
        "archive",
        &[
            "Documents/资料/说明.txt",
            "Documents/资料",
            "Documents/资料",
            "Documents/notes.txt",
        ],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = body_json(response).await;
    assert_eq!(response["filename"], "dropoint-selection.zip");
    let download = app
        .clone()
        .oneshot(
            Request::get(response["url"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(download.status(), StatusCode::OK);
    assert_eq!(download.headers()[header::CONTENT_TYPE], "application/zip");
    let bytes = to_bytes(download.into_body(), usize::MAX).await.unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut names: Vec<String> = archive.file_names().map(str::to_owned).collect();
    names.sort();
    assert_eq!(
        names,
        ["notes.txt", "资料/", "资料/empty/", "资料/说明.txt"]
    );
    let mut content = String::new();
    archive
        .by_name("资料/说明.txt")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "你好 Dropoint");
    assert_eq!(
        std::fs::read_dir(root).unwrap().count(),
        1,
        "archive must not appear in the shared root"
    );
    let response = body_json(post(&app, "archive", &["Documents/资料"]).await).await;
    assert_eq!(response["filename"], "资料.zip");
    let download = app
        .oneshot(
            Request::get(response["url"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        download.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("filename*=UTF-8''")
    );
    // A response keeps its temporary archive alive after the last Router is dropped.
    assert!(
        zip::ZipArchive::new(Cursor::new(
            to_bytes(download.into_body(), usize::MAX).await.unwrap()
        ))
        .is_ok()
    );
}

#[tokio::test]
async fn invalid_selections_are_rejected_before_any_deletion() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::write(root.join("keep.txt"), "keep").unwrap();
    let app = create_app(root.to_path_buf());
    let absolute = root.to_string_lossy();
    for paths in [
        vec![],
        vec!["keep.txt", ""],
        vec!["keep.txt", "."],
        vec!["keep.txt", "../outside"],
        vec!["keep.txt", &absolute],
    ] {
        for action in ["archive", "delete"] {
            let response = post(&app, action, &paths).await;
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{action}: {paths:?}"
            );
            assert!(root.join("keep.txt").exists());
        }
    }
}

#[tokio::test]
async fn deletes_files_and_folders_and_reports_missing_items_individually() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("folder/nested")).unwrap();
    std::fs::write(root.join("folder/nested/file.txt"), "content").unwrap();
    std::fs::write(root.join("file.txt"), "content").unwrap();
    let app = create_app(root.to_path_buf());
    let response = post(
        &app,
        "delete",
        &[
            "folder/nested",
            "folder",
            "folder",
            "file.txt",
            "missing.txt",
        ],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = body_json(response).await;
    assert_eq!(response["deleted"], json!(["folder", "file.txt"]));
    assert_eq!(response["failed"][0]["path"], "missing.txt");
    assert_eq!(response["failed"].as_array().unwrap().len(), 1);
    assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
}

struct DirectoryLink(PathBuf);

impl DirectoryLink {
    fn new(path: PathBuf, target: &Path) -> Self {
        #[cfg(windows)]
        assert!(std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:DROPOINT_TEST_LINK -Target $env:DROPOINT_TEST_TARGET | Out-Null"])
            .env("DROPOINT_TEST_LINK", &path).env("DROPOINT_TEST_TARGET", target)
            .status().unwrap().success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &path).unwrap();
        Self(path)
    }
}

impl Drop for DirectoryLink {
    fn drop(&mut self) {
        #[cfg(windows)]
        let _ = std::fs::remove_dir(&self.0);
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tokio::test]
async fn rejects_link_traversal_and_archiving_but_deletes_only_the_link_itself() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("share");
    let outside = directory.path().join("outside");
    std::fs::create_dir_all(root.join("folder")).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("keep.txt"), "keep").unwrap();
    std::fs::write(root.join("keep.txt"), "keep").unwrap();
    let _link = DirectoryLink::new(root.join("folder/link"), &outside);
    let app = create_app(root.to_path_buf());
    for action in ["archive", "delete"] {
        let response = post(&app, action, &["keep.txt", "folder/link/keep.txt"]).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(root.join("keep.txt").exists());
    }
    for path in ["folder", "folder/link"] {
        let response = post(&app, "archive", &[path]).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            body_json(response).await["message"]
                .as_str()
                .unwrap()
                .contains("folder/link")
        );
    }
    let response = body_json(post(&app, "delete", &["folder/link"]).await).await;
    assert_eq!(response["deleted"], json!(["folder/link"]));
    assert_eq!(
        std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
        "keep"
    );
    let _link = DirectoryLink::new(root.join("folder/another-link"), &outside);
    let response = body_json(post(&app, "delete", &["folder"]).await).await;
    assert_eq!(response["deleted"], json!(["folder"]));
    assert!(outside.join("keep.txt").exists());
}

#[tokio::test]
async fn links_inside_the_share_are_not_followed_either() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir(root.join("target")).unwrap();
    std::fs::write(root.join("target/keep.txt"), "keep").unwrap();
    let _link = DirectoryLink::new(root.join("link"), &root.join("target"));
    let app = create_app(root.to_path_buf());
    assert_eq!(
        post(&app, "archive", &["link"]).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(&app, "delete", &["link/keep.txt"]).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(&app, "delete", &["link"]).await.status(),
        StatusCode::OK
    );
    assert!(root.join("target/keep.txt").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_archive_names_that_zip_readers_could_interpret_as_traversal() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("..\\escape.txt"), "keep").unwrap();
    let app = create_app(directory.path().to_path_buf());
    assert_eq!(
        post(&app, "archive", &["..\\escape.txt"]).await.status(),
        StatusCode::BAD_REQUEST
    );
}
