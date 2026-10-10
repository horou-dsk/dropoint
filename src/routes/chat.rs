use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::state::{AppState, ChatMessage};

pub(crate) mod attachments;

pub(crate) async fn prepare_message(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<crate::state::PrepareMessageRequest>,
) -> Result<axum::Json<crate::state::PreparedMessage>, crate::state::ChatError> {
    state
        .chat
        .prepare(request.client_message_id)
        .await
        .map(axum::Json)
}

pub(crate) async fn keep_message_alive(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<crate::state::KeepAliveRequest>,
) -> Result<axum::http::StatusCode, crate::state::ChatError> {
    state.chat.keep_alive(request).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub(crate) async fn submit_message(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<crate::state::MessageRequest>,
) -> Result<axum::Json<ChatMessage>, crate::state::ChatError> {
    state.chat.submit(request).await.map(axum::Json)
}

const MAX_CHAT_MESSAGE_LENGTH: usize = 10_000;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientEvent {
    Send { text: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServerEvent {
    History { messages: Vec<ChatMessage> },
    Message { message: ChatMessage },
}

pub async fn chat_socket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let mut updates = state.chat.subscribe();
    let history = state.chat.history().await;
    let (mut sender, mut incoming) = socket.split();
    if send_event(&mut sender, ServerEvent::History { messages: history })
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            update = updates.recv() => match update {
                Ok(message) => {
                    if send_event(&mut sender, ServerEvent::Message { message }).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            received = incoming.next() => match received {
                Some(Ok(Message::Text(text))) => handle_client_event(&state, text.as_str()).await,
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Err(_)) => {}
                Some(Ok(Message::Binary(_))) => {}
            },
        }
    }
}

async fn handle_client_event(state: &AppState, text: &str) {
    let Ok(ClientEvent::Send { text }) = serde_json::from_str(text) else {
        return;
    };
    let text = text.trim();
    if text.is_empty() || text.chars().count() > MAX_CHAT_MESSAGE_LENGTH {
        return;
    }
    state.chat.add_message(text.to_owned()).await;
}

async fn send_event(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: ServerEvent,
) -> Result<(), axum::Error> {
    sender
        .send(Message::Text(
            serde_json::to_string(&event)
                .expect("chat event is serializable")
                .into(),
        ))
        .await
}

#[cfg(test)]
mod tests {
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    async fn post(app: &Router, path: &str, payload: Value) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test(start_paused = true)]
    async fn prepares_and_renews_through_http_and_rejects_expired_confirmation_retries() {
        let root = tempfile::tempdir().unwrap();
        let app = crate::app::create_app(root.path().into());
        assert_eq!(
            post(
                &app,
                "/api/chat/messages/prepare",
                json!({"clientMessageId":""})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let (status, prepared) = post(
            &app,
            "/api/chat/messages/prepare",
            json!({"clientMessageId":"http"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            post(
                &app,
                "/api/chat/messages/prepare",
                json!({"clientMessageId":"http"})
            )
            .await
            .1,
            prepared
        );
        let token = prepared["submissionToken"].as_str().unwrap();
        let credentials = json!({"clientMessageId":"http", "submissionToken":token});
        assert_eq!(
            post(&app, "/api/chat/messages/keepalive", credentials.clone())
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        let mut missing = credentials.clone();
        missing["attachmentIds"] = json!(["missing"]);
        let (status, error) = post(&app, "/api/chat/messages/keepalive", missing).await;
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(error["code"], "attachment_unavailable");
        let mut wrong = credentials.clone();
        wrong["submissionToken"] = json!("wrong");
        assert_eq!(
            post(&app, "/api/chat/messages/keepalive", wrong).await.1["code"],
            "submission_expired"
        );
        let mut payload = credentials;
        payload["text"] = json!("hello");
        let (status, message) = post(&app, "/api/chat/messages", payload.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            post(&app, "/api/chat/messages", payload.clone()).await.1,
            message
        );
        let mut different = payload.clone();
        different["text"] = json!("changed");
        assert_eq!(
            post(&app, "/api/chat/messages", different).await.0,
            StatusCode::CONFLICT
        );
        tokio::time::advance(std::time::Duration::from_secs(30 * 60)).await;
        let (status, error) = post(&app, "/api/chat/messages", payload).await;
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(error["code"], "submission_expired");
    }
}
