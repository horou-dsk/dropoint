use std::{
    convert::Infallible,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    body::{Body, Bytes, to_bytes},
    http::{Request, StatusCode},
};
use dropoint::app::create_app;
use futures_util::{StreamExt, stream};
use tower::ServiceExt;

fn prefix(path: &str) -> String {
    format!(
        "--upload\r\nContent-Disposition: form-data; name=\"relative_path\"\r\n\r\n{path}\r\n--upload\r\nContent-Disposition: form-data; name=\"file\"; filename=\"file.txt\"\r\nContent-Type: text/plain\r\n\r\n"
    )
}

fn request(mode: &str, body: Body) -> Request<Body> {
    Request::post(format!("/api/files?conflict={mode}"))
        .header("Content-Type", "multipart/form-data; boundary=upload")
        .body(body)
        .unwrap()
}

fn complete_body(path: &str, content: &str) -> Body {
    Body::from(format!("{}{content}\r\n--upload--\r\n", prefix(path)))
}

#[tokio::test]
async fn consumes_conflicting_upload_before_returning_409_without_changing_the_file() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("same.txt"), "original").unwrap();
    let consumed = Arc::new(AtomicBool::new(false));
    let consumed_by_stream = Arc::clone(&consumed);
    let body = Body::from_stream(
        stream::once(async { Ok::<_, Infallible>(Bytes::from(prefix("same.txt"))) }).chain(
            stream::once(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                consumed_by_stream.store(true, Ordering::SeqCst);
                Ok::<_, Infallible>(Bytes::from(format!(
                    "{}\r\n--upload--\r\n",
                    "x".repeat(1024 * 1024)
                )))
            }),
        ),
    );
    let response = create_app(directory.path().to_path_buf())
        .oneshot(request("fail", body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(
        consumed.load(Ordering::SeqCst),
        "read the body before replying so the browser receives HTTP 409 instead of a connection reset"
    );
    let error = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&error).unwrap()["message"],
        "same.txt"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("same.txt")).unwrap(),
        "original"
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

async fn wait_for_staging(root: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::read_dir(root).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".dropoint-upload-")
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("upload should reach staging");
}

#[tokio::test]
async fn concurrent_uploads_preserve_the_winner_and_rename_on_commit() {
    for mode in ["fail", "rename"] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let app = create_app(root.to_path_buf());
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let start = prefix("same.txt");
        let body = Body::from_stream(
            stream::once(async { Ok::<_, Infallible>(Bytes::from(start)) }).chain(stream::once(
                async move {
                    wait.await.unwrap();
                    Ok::<_, Infallible>(Bytes::from_static(b"first upload\r\n--upload--\r\n"))
                },
            )),
        );
        let first = tokio::spawn(app.clone().oneshot(request(mode, body)));
        wait_for_staging(root).await;
        let second = app
            .oneshot(request("fail", complete_body("same.txt", "second upload")))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        release.send(()).unwrap();
        let first = first.await.unwrap().unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("same.txt")).unwrap(),
            "second upload"
        );
        if mode == "fail" {
            assert_eq!(first.status(), StatusCode::CONFLICT);
        } else {
            assert_eq!(first.status(), StatusCode::OK);
            assert_eq!(
                std::fs::read_to_string(root.join("same (1).txt")).unwrap(),
                "first upload"
            );
        }
        assert!(!std::fs::read_dir(root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".dropoint-upload-")
        }));
    }
}

struct DirectoryLink(PathBuf);

impl DirectoryLink {
    fn new(link: PathBuf, target: &Path) -> Self {
        #[cfg(windows)]
        assert!(std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:DROPOINT_TEST_LINK -Target $env:DROPOINT_TEST_TARGET | Out-Null"])
            .env("DROPOINT_TEST_LINK", &link).env("DROPOINT_TEST_TARGET", target)
            .status().unwrap().success());
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &link).unwrap();
        Self(link)
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
async fn rejects_external_links_before_creating_any_directories() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("share");
    let outside = directory.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let _link = DirectoryLink::new(root.join("link"), &outside);
    let app = create_app(root);
    for mode in ["fail", "rename", "overwrite"] {
        let response = app
            .clone()
            .oneshot(request(
                mode,
                complete_body("link/new/nested/file.txt", "secret"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn uploads_nested_files_through_links_inside_the_share() {
    let directory = tempfile::tempdir().unwrap();
    let inside = directory.path().join("inside");
    std::fs::create_dir(&inside).unwrap();
    let _link = DirectoryLink::new(directory.path().join("link"), &inside);
    let response = create_app(directory.path().to_path_buf())
        .oneshot(request(
            "fail",
            complete_body("link/new/nested/file.txt", "hello"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(inside.join("new/nested/file.txt")).unwrap(),
        "hello"
    );
}

#[tokio::test]
async fn incomplete_overwrites_keep_original_data_and_remove_staging() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("same.txt"), "original").unwrap();
    let response = create_app(directory.path().to_path_buf())
        .oneshot(request(
            "overwrite",
            Body::from(format!("{}incomplete", prefix("same.txt"))),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        std::fs::read_to_string(directory.path().join("same.txt")).unwrap(),
        "original"
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn rejects_extra_file_parts_without_committing_the_first_file() {
    let directory = tempfile::tempdir().unwrap();
    let body = format!(
        "{}first\r\n--upload\r\nContent-Disposition: form-data; name=\"file\"; filename=\"second.txt\"\r\n\r\nsecond\r\n--upload--\r\n",
        prefix("first.txt")
    );
    let response = create_app(directory.path().to_path_buf())
        .oneshot(request("fail", Body::from(body)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let _ = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
