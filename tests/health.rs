use axum::{body::to_bytes, http::StatusCode};
use dropoint::app::create_app;
use tower::ServiceExt;

#[tokio::test]
async fn health_endpoint_returns_ok() {
    let response = create_app()
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/health")
                .body(axum::body::Body::empty())
                .expect("request should be valid"),
        )
        .await
        .expect("router should return a response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body should be readable");
    assert_eq!(body.as_ref(), br#"{"status":"ok"}"#);
}
