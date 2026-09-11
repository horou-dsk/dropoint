use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use dropoint::app::create_app;
use tempfile::tempdir;
use tower::ServiceExt;

fn multipart_request(uri: &str, file_name: &str, content: &str) -> Request<Body> {
    let boundary = "dropoint-test-boundary";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"relative_path\"\r\n\r\n{file_name}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: text/plain\r\n\r\n{content}\r\n--{boundary}--\r\n"
    );
    Request::builder()
        .method("POST")
        .uri(uri)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .expect("multipart request should be valid")
}

async fn request(app: axum::Router, uri: &str) -> axum::response::Response {
    app.oneshot(
        Request::get(uri)
            .body(Body::empty())
            .expect("request should be valid"),
    )
    .await
    .expect("router should return a response")
}

#[tokio::test]
async fn lists_and_downloads_files_inside_share_directory() {
    let directory = tempdir().expect("temporary directory should be created");
    tokio::fs::write(directory.path().join("hello.txt"), "hello")
        .await
        .expect("file should be written");
    let app = create_app(directory.path().to_path_buf());

    let listing = request(app.clone(), "/api/files").await;
    assert_eq!(listing.status(), StatusCode::OK);
    let listing_body = to_bytes(listing.into_body(), usize::MAX)
        .await
        .expect("body should be readable");
    assert!(
        listing_body
            .windows(b"hello.txt".len())
            .any(|window| window == b"hello.txt")
    );

    let download = request(app, "/api/files/download?path=hello.txt").await;
    assert_eq!(download.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(download.into_body(), usize::MAX)
            .await
            .expect("body should be readable")
            .as_ref(),
        b"hello"
    );
}

#[tokio::test]
async fn rejects_paths_outside_share_directory() {
    let directory = tempdir().expect("temporary directory should be created");
    let outside = directory
        .path()
        .parent()
        .expect("temporary directory should have a parent")
        .join("outside.txt");
    tokio::fs::write(&outside, "secret")
        .await
        .expect("outside file should be written");
    let app = create_app(directory.path().to_path_buf());

    let response = request(app, "/api/files/download?path=../outside.txt").await;
    assert!(matches!(
        response.status(),
        StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND
    ));
    let _ = tokio::fs::remove_file(outside).await;
}

#[tokio::test]
async fn handles_upload_conflicts_with_rename_and_overwrite() {
    let directory = tempdir().expect("temporary directory should be created");
    tokio::fs::write(directory.path().join("same.txt"), "old")
        .await
        .expect("file should be written");
    let app = create_app(directory.path().to_path_buf());

    let conflict = app
        .clone()
        .oneshot(multipart_request("/api/files", "same.txt", "new"))
        .await
        .expect("router should return a response");
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    let renamed = app
        .clone()
        .oneshot(multipart_request(
            "/api/files?conflict=rename",
            "same.txt",
            "new",
        ))
        .await
        .expect("router should return a response");
    assert_eq!(renamed.status(), StatusCode::OK);
    assert_eq!(
        tokio::fs::read_to_string(directory.path().join("same (1).txt"))
            .await
            .expect("renamed file should exist"),
        "new"
    );

    let overwritten = app
        .oneshot(multipart_request(
            "/api/files?conflict=overwrite",
            "same.txt",
            "newer",
        ))
        .await
        .expect("router should return a response");
    assert_eq!(overwritten.status(), StatusCode::OK);
    assert_eq!(
        tokio::fs::read_to_string(directory.path().join("same.txt"))
            .await
            .expect("overwritten file should exist"),
        "newer"
    );
}
