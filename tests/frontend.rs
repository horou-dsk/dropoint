use axum::{
    body::{Body, Bytes, to_bytes},
    http::{Method, Request, StatusCode},
    response::Response,
};
use dropoint::app::create_app;
use tower::ServiceExt;

async fn request(method: Method, uri: &str) -> Response {
    let directory = tempfile::tempdir().expect("temporary directory should exist");
    // Serving the frontend must never read a same-named file in the shared root.
    std::fs::write(directory.path().join("index.html"), "shared file").unwrap();
    create_app(directory.path().to_path_buf())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .expect("request should be valid"),
        )
        .await
        .expect("router should return a response")
}

async fn body(response: Response) -> Bytes {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body should be readable")
}

#[tokio::test]
async fn root_serves_embedded_frontend() {
    let response = request(Method::GET, "/").await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/html");
    assert_eq!(response.headers()["cache-control"], "no-cache");
    assert!(body(response).await.starts_with(b"<!doctype html>"));
}

#[tokio::test]
async fn frontend_routes_use_spa_fallback_but_unknown_api_routes_do_not() {
    let index = body(request(Method::GET, "/").await).await;
    for path in [
        "/workspace/example",
        "/workspace/example.v1",
        "/?path=folder",
    ] {
        let response = request(Method::GET, path).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(body(response).await, index, "{path}");
    }

    for method in [Method::GET, Method::HEAD, Method::POST] {
        for path in ["/api", "/api/unknown", "/api/unknown/nested"] {
            let response = request(method.clone(), path).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
            assert!(body(response).await.is_empty());
        }
    }
}

#[tokio::test]
async fn serves_bundled_js_and_css_with_correct_content_types() {
    let index = body(request(Method::GET, "/").await).await;
    let html = std::str::from_utf8(&index).unwrap();
    for (extension, content_type) in [("js", "javascript"), ("css", "text/css")] {
        let path = html
            .split('"')
            .find(|value| value.starts_with("/assets/") && value.ends_with(extension))
            .expect("index should reference a compiled asset");
        let response = request(Method::GET, path).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()["content-type"]
                .to_str()
                .unwrap()
                .contains(content_type)
        );
        let asset = body(response).await;
        assert!(!asset.is_empty());
        assert!(!asset.starts_with(b"<!doctype html>"));
    }
}

#[tokio::test]
async fn missing_assets_and_traversal_do_not_fall_back_to_html() {
    for path in [
        "/assets",
        "/assets/missing.js",
        "/assets/missing.css",
        "/../Cargo.toml",
    ] {
        let response = request(Method::GET, path).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(body(response).await.is_empty());
    }
}

#[tokio::test]
async fn head_preserves_headers_without_a_body_and_post_is_rejected() {
    let get = request(Method::GET, "/").await;
    let head = request(Method::HEAD, "/").await;
    assert_eq!(head.status(), StatusCode::OK);
    for name in ["content-type", "content-length", "cache-control"] {
        assert_eq!(head.headers()[name], get.headers()[name]);
    }
    assert!(body(head).await.is_empty());

    let post = request(Method::POST, "/").await;
    assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(post.headers()["allow"], "GET, HEAD");
}
