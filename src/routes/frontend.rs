use std::borrow::Cow;

use axum::{
    body::Body,
    http::{Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "web/dist/"]
struct FrontendAssets;

pub async fn serve(method: Method, uri: Uri) -> Response {
    let requested_path = uri.path().trim_start_matches('/');

    if requested_path == "api"
        || requested_path.starts_with("api/")
        || requested_path.contains('\\')
        || requested_path.split('/').any(|segment| segment == "..")
    {
        return StatusCode::NOT_FOUND.into_response();
    }

    if method != Method::GET && method != Method::HEAD {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "GET, HEAD")],
        )
            .into_response();
    }

    if let Some(response) = asset_response(requested_path, &method) {
        return response;
    }

    // A missing Vite bundle must return 404 instead of an HTML document.
    if requested_path == "assets" || requested_path.starts_with("assets/") {
        return StatusCode::NOT_FOUND.into_response();
    }

    asset_response("index.html", &method).unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

fn asset_response(path: &str, method: &Method) -> Option<Response> {
    let asset = FrontendAssets::get(path)?;
    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    let content_length = asset.data.len().to_string();
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        match asset.data {
            Cow::Borrowed(bytes) => Body::from(bytes),
            Cow::Owned(bytes) => Body::from(bytes),
        }
    };
    Some(
        (
            [
                (header::CONTENT_TYPE, content_type.as_ref()),
                (header::CONTENT_LENGTH, content_length.as_str()),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            body,
        )
            .into_response(),
    )
}
