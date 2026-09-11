use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use dropoint::app::create_app;
use tower::ServiceExt;

#[tokio::test]
async fn streams_requested_video_bytes_for_preview_and_download() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("clip.mp4"), b"0123456789").unwrap();
    let app = create_app(directory.path().to_path_buf());
    for endpoint in ["preview", "download"] {
        for (range, content_range, expected) in [
            ("bytes=4-7", "bytes 4-7/10", "4567"),
            ("bytes=4-", "bytes 4-9/10", "456789"),
            ("bytes=-3", "bytes 7-9/10", "789"),
            ("bytes=8-100", "bytes 8-9/10", "89"),
            ("bytes=0-0", "bytes 0-0/10", "0"),
            ("bytes=-100", "bytes 0-9/10", "0123456789"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::get(format!("/api/files/{endpoint}?path=clip.mp4"))
                        .header("Range", range)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(response.headers()["content-range"], content_range);
            assert_eq!(response.headers()["accept-ranges"], "bytes");
            assert_eq!(
                response.headers()["content-length"],
                expected.len().to_string()
            );
            assert_eq!(response.headers()["content-type"], "video/mp4");
            assert_eq!(
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .as_ref(),
                expected.as_bytes()
            );
        }
    }
}

#[tokio::test]
async fn returns_416_for_unsatisfiable_ranges_including_empty_files() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("clip.mp4"), b"0123456789").unwrap();
    std::fs::write(directory.path().join("empty.txt"), b"").unwrap();
    let app = create_app(directory.path().to_path_buf());
    for (path, range, content_range) in [
        ("clip.mp4", "bytes=10-", "bytes */10"),
        ("clip.mp4", "bytes=5-2", "bytes */10"),
        ("clip.mp4", "bytes=-0", "bytes */10"),
        ("empty.txt", "bytes=0-", "bytes */0"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/api/files/preview?path={path}"))
                    .header("Range", range)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()["content-range"], content_range);
        assert!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty()
        );
    }
}

#[tokio::test]
async fn ignores_unsupported_ranges_and_keeps_head_body_empty() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("clip.mp4"), b"0123456789").unwrap();
    let app = create_app(directory.path().to_path_buf());
    for range in ["bytes=0-1,4-5", "invalid", "bytes=abc-"] {
        let response = app
            .clone()
            .oneshot(
                Request::get("/api/files/preview?path=clip.mp4")
                    .header("Range", range)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .as_ref(),
            b"0123456789"
        );
    }
    let response = app
        .oneshot(
            Request::head("/api/files/preview?path=clip.mp4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-length"], "10");
    assert!(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );
}
