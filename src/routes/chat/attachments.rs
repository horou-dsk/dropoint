use std::io::SeekFrom;

use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::Response,
};
use futures_util::{StreamExt, stream};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use crate::{
    routes::files::range::{self, Selection},
    state::{AppState, ChatAttachment, ChatError},
};

pub(crate) async fn upload(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<ChatAttachment>, ChatError> {
    let mut field = multipart
        .next_field()
        .await?
        .ok_or_else(|| invalid_upload("请提供一个 file 文件字段"))?;
    if field.name() != Some("file") || field.file_name().is_none() {
        return Err(invalid_upload("请提供一个 file 文件字段"));
    }
    let name = display_name(field.file_name().unwrap_or("attachment"));
    let mime = safe_mime(&name);
    let temporary = state.chat.begin_upload().await?;
    let mut writer = tokio::fs::File::from_std(temporary.file.reopen()?);
    let mut size = 0;
    while let Some(chunk) = field.chunk().await? {
        writer.write_all(&chunk).await?;
        size += chunk.len() as u64;
    }
    drop(field);
    // Publish only after the entire multipart envelope is validated.
    if multipart.next_field().await?.is_some() {
        return Err(invalid_upload("每次请求只能上传一个文件"));
    }
    writer.flush().await?;
    drop(writer);
    Ok(Json(
        state.chat.finish_upload(temporary, name, size, mime).await,
    ))
}

pub(crate) async fn preview(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    method: Method,
) -> Result<Response, ChatError> {
    serve(&state, &id, &headers, method, false).await
}

pub(crate) async fn download(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    method: Method,
) -> Result<Response, ChatError> {
    serve(&state, &id, &headers, method, true).await
}

async fn serve(
    state: &AppState,
    id: &str,
    headers: &HeaderMap,
    method: Method,
    download: bool,
) -> Result<Response, ChatError> {
    let attachment = state.chat.attachment(id).await?;
    let metadata = &attachment.metadata;
    if !download && metadata.preview_url.is_none() {
        return Err(ChatError::PreviewUnsupported);
    }
    let size = metadata.size;
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, &metadata.mime)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCEPT_RANGES, "bytes")
        // Even media uploads are untrusted; do not permit document execution.
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        );
    if download {
        let encoded: String = metadata
            .name
            .as_bytes()
            .iter()
            .map(|byte| format!("%{byte:02X}"))
            .collect();
        response = response.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"attachment\"; filename*=UTF-8''{encoded}"),
        );
    } else {
        response = response.header(header::CONTENT_DISPOSITION, "inline");
    }
    let (start, length) = match range::select(headers, size) {
        Selection::Full => (0, size),
        Selection::Partial { start, end } => {
            response = response
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
            (start, end - start + 1)
        }
        Selection::Unsatisfiable => {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::CONTENT_LENGTH, 0)
                .body(Body::empty())
                .map_err(|error| std::io::Error::other(error).into());
        }
    };
    response = response.header(header::CONTENT_LENGTH, length);
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let mut file = tokio::fs::File::from_std(attachment.temporary.file.reopen()?);
        file.seek(SeekFrom::Start(start)).await?;
        // Capture the owner with the stream so eviction never interrupts an active download.
        let stream = stream::unfold(
            (ReaderStream::new(file.take(length)), attachment),
            |(mut reader, owner)| async move {
                reader.next().await.map(|chunk| (chunk, (reader, owner)))
            },
        );
        Body::from_stream(stream)
    };
    response
        .body(body)
        .map_err(|error| std::io::Error::other(error).into())
}

fn invalid_upload(message: &str) -> ChatError {
    ChatError::Upload(StatusCode::BAD_REQUEST, message.into())
}

fn display_name(name: &str) -> String {
    let name: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("attachment")
        .chars()
        .filter(|character| !character.is_control())
        .take(255)
        .collect();
    if name.is_empty() || name == "." || name == ".." {
        "attachment".into()
    } else {
        name
    }
}

fn safe_mime(name: &str) -> String {
    // Never use the client-supplied Content-Type to enable active document formats.
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    match mime.essence_str() {
        "audio/m4a" => "audio/mp4".into(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/avif"
        | "video/mp4" | "video/webm" | "video/ogg" | "video/quicktime" | "audio/mpeg"
        | "audio/mp4" | "audio/webm" | "audio/ogg" | "audio/wav" | "audio/x-wav" | "audio/flac"
        | "audio/aac" => mime.to_string(),
        _ => "application/octet-stream".into(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use axum::{
        Router,
        body::{Bytes, to_bytes},
        extract::DefaultBodyLimit,
        http::Request,
        routing::{get, post},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    fn router(state: AppState, limit: usize) -> Router {
        Router::new()
            .route("/upload", post(upload))
            .route("/{id}/preview", get(preview))
            .route("/{id}/download", get(download))
            .route("/message", post(super::super::submit_message))
            .layer(DefaultBodyLimit::max(limit))
            .with_state(state)
    }

    fn multipart(body: Body) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/upload")
            .header(header::CONTENT_TYPE, "multipart/form-data; boundary=test")
            .body(body)
            .unwrap()
    }

    fn file_field(name: &str, content: &[u8]) -> Vec<u8> {
        let mut bytes = format!("--test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
        bytes.extend_from_slice(content);
        bytes.extend_from_slice(b"\r\n--test--\r\n");
        bytes
    }

    async fn json(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }

    #[tokio::test]
    async fn streams_upload_and_serves_unicode_download_head_and_ranges() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path().into());
        let app = router(state, 1024 * 1024);
        let consumed = Arc::new(AtomicBool::new(false));
        let marker = Arc::clone(&consumed);
        // Independently chunk the full multipart envelope, including boundaries.
        let bytes = file_field("照片.png", b"0123456789");
        let first = Bytes::copy_from_slice(&bytes[..bytes.len() / 2]);
        let last = Bytes::copy_from_slice(&bytes[bytes.len() / 2..]);
        let body = stream::once(async { Ok::<_, std::io::Error>(first) }).chain(stream::once(
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                marker.store(true, Ordering::SeqCst);
                Ok(last)
            },
        ));
        let response = app
            .clone()
            .oneshot(multipart(Body::from_stream(body)))
            .await
            .unwrap();
        let status = response.status();
        assert!(consumed.load(Ordering::SeqCst));
        let metadata = json(response).await;
        assert_eq!(status, StatusCode::OK, "{metadata}");
        assert_eq!(metadata["name"], "照片.png");
        assert_eq!(metadata["size"], 10);
        assert_eq!(metadata["mime"], "image/png");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        let url = format!("/{}/download", metadata["id"].as_str().unwrap());
        let response = app
            .clone()
            .oneshot(Request::builder().uri(&url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(
            response.headers()[header::CONTENT_DISPOSITION]
                .to_str()
                .unwrap()
                .contains("filename*=UTF-8''%E7%85%A7%E7%89%87%2E%70%6E%67")
        );
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(
            to_bytes(response.into_body(), 100).await.unwrap(),
            "0123456789"
        );
        let head = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("HEAD")
                    .uri(&url)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
        assert!(to_bytes(head.into_body(), 100).await.unwrap().is_empty());
        let partial = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::RANGE, "bytes=2-5")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(to_bytes(partial.into_body(), 100).await.unwrap(), "2345");
        let invalid = app
            .oneshot(
                Request::builder()
                    .uri(&url)
                    .header(header::RANGE, "bytes=10-")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[tokio::test]
    async fn publishes_attachment_only_messages_and_keeps_active_download_after_eviction() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path().into());
        let app = router(state.clone(), 1024 * 1024);
        let metadata = json(
            app.clone()
                .oneshot(multipart(Body::from(file_field(
                    "video.mp4",
                    b"video bytes",
                ))))
                .await
                .unwrap(),
        )
        .await;
        let id = metadata["id"].as_str().unwrap();
        let prepared = state.chat.prepare("media-only".into()).await.unwrap();
        let mut receiver = state.chat.subscribe();
        let request = Request::builder()
            .method("POST")
            .uri("/message")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({"clientMessageId":"media-only","submissionToken":prepared.submission_token,"attachmentIds":[id]})
                    .to_string(),
            ))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let message = json(response).await;
        assert_eq!(message["text"], "");
        assert_eq!(message["attachments"][0], metadata);
        let broadcast = receiver.recv().await.unwrap();
        assert_eq!(broadcast.id, message["id"].as_u64().unwrap());
        assert_eq!(state.chat.history().await, vec![broadcast]);
        let url = format!("/{id}/preview");
        let downloading = app
            .clone()
            .oneshot(Request::builder().uri(&url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        for _ in 0..crate::state::MAX_CHAT_MESSAGES {
            state.chat.add_message("later".into()).await;
        }
        let expired = app
            .oneshot(Request::builder().uri(&url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(expired.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            to_bytes(downloading.into_body(), 100).await.unwrap(),
            "video bytes"
        );
    }

    #[tokio::test]
    async fn active_content_is_download_only_and_names_never_control_storage_paths() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path().into());
        let app = router(state.clone(), 1024 * 1024);
        for name in ["../page.html", "image.svg", "script.js"] {
            let response = app
                .clone()
                .oneshot(multipart(Body::from(file_field(
                    name,
                    b"<script>alert(1)</script>",
                ))))
                .await
                .unwrap();
            let metadata = json(response).await;
            assert_eq!(metadata["mime"], "application/octet-stream");
            assert!(metadata["previewUrl"].is_null());
            let id = metadata["id"].as_str().unwrap();
            let stored = state.chat.attachment(id).await.unwrap();
            assert_ne!(
                stored
                    .temporary
                    .file
                    .path()
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap(),
                metadata["name"].as_str().unwrap()
            );
            assert!(!stored.temporary.file.path().starts_with(root.path()));
            let preview = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/{id}/preview"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(preview.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
            let download = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/{id}/download"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                download.headers()[header::CONTENT_TYPE],
                "application/octet-stream"
            );
        }
        for (name, mime) in [
            ("recording.mp3", "audio/mpeg"),
            ("recording.m4a", "audio/mp4"),
            ("recording.wav", "audio/wav"),
        ] {
            let metadata = json(
                app.clone()
                    .oneshot(multipart(Body::from(file_field(name, b"media"))))
                    .await
                    .unwrap(),
            )
            .await;
            assert_eq!(metadata["mime"], mime);
            assert!(metadata["previewUrl"].is_string());
        }
    }

    #[tokio::test]
    async fn returns_structured_errors_without_publishing_invalid_messages() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path().into());
        let app = router(state.clone(), 64 * 1024);
        for (body, status, code) in [
            (
                serde_json::json!({"clientMessageId":"empty", "submissionToken":"unused", "text":"  "}),
                StatusCode::BAD_REQUEST,
                "invalid_message",
            ),
            (
                serde_json::json!({"clientMessageId":"invalid", "attachmentIds":["missing"]}),
                StatusCode::GONE,
                "attachment_unavailable",
            ),
        ] {
            let prepared = state
                .chat
                .prepare(body["clientMessageId"].as_str().unwrap().into())
                .await
                .unwrap();
            let mut body = body;
            body["submissionToken"] = Value::String(prepared.submission_token);
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/message")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            let error = json(response).await;
            assert_eq!(error["code"], code);
            if status == StatusCode::GONE {
                assert_eq!(error["attachmentIds"], serde_json::json!(["missing"]));
            }
        }
        assert!(state.chat.history().await.is_empty());
    }

    #[tokio::test]
    async fn rejects_incomplete_extra_and_oversized_uploads_and_cleans_partial_files() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path().into());
        let probe = state.chat.begin_upload().await.unwrap();
        let directory = probe.file.path().parent().unwrap().to_owned();
        drop(probe);
        let app = router(state.clone(), 512);
        let truncated = b"--test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.png\"\r\n\r\npartial";
        let response = app
            .clone()
            .oneshot(multipart(Body::from(truncated.to_vec())))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        let mut extra = file_field("first.png", b"first");
        extra.truncate(extra.len() - b"--test--\r\n".len());
        extra.extend_from_slice(&file_field("second.png", b"second"));
        let response = app
            .clone()
            .oneshot(multipart(Body::from(extra)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        // The file alone is under the limit; its multipart envelope exceeds it.
        let bytes = file_field("large.png", &[0; 500]);
        let interrupted = vec![
            Ok(Bytes::copy_from_slice(&bytes[..160])),
            Err(std::io::Error::other("connection interrupted")),
        ];
        let response = app
            .clone()
            .oneshot(multipart(Body::from_stream(stream::iter(interrupted))))
            .await
            .unwrap();
        assert!(response.status().is_server_error());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        // Unknown length exercises a body limit reached after writing has begun.
        let chunks = vec![
            Ok::<_, std::io::Error>(Bytes::copy_from_slice(&bytes[..160])),
            Ok(Bytes::copy_from_slice(&bytes[160..])),
        ];
        let response = app
            .oneshot(multipart(Body::from_stream(stream::iter(chunks))))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        assert!(state.chat.history().await.is_empty());
    }
}
