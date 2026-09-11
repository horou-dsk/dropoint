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
