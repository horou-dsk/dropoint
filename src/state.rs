use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use tokio::sync::{Mutex, broadcast};

pub const MAX_CHAT_MESSAGES: usize = 200;

#[derive(Clone)]
pub struct AppState {
    pub root: Arc<PathBuf>,
    pub chat: Arc<ChatState>,
}

impl AppState {
    pub fn new(root: PathBuf) -> Self {
        let root = std::fs::canonicalize(&root).unwrap_or(root);
        Self {
            root: Arc::new(root),
            chat: Arc::new(ChatState::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: u64,
    pub text: String,
    pub timestamp: u64,
}

pub struct ChatState {
    messages: Mutex<VecDeque<ChatMessage>>,
    sender: broadcast::Sender<ChatMessage>,
    next_id: AtomicU64,
}

impl ChatState {
    fn new() -> Self {
        let (sender, _) = broadcast::channel(MAX_CHAT_MESSAGES * 2);
        Self {
            messages: Mutex::new(VecDeque::with_capacity(MAX_CHAT_MESSAGES)),
            sender,
            next_id: AtomicU64::new(1),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ChatMessage> {
        self.sender.subscribe()
    }

    pub async fn history(&self) -> Vec<ChatMessage> {
        self.messages.lock().await.iter().cloned().collect()
    }

    pub async fn add_message(&self, text: String) -> ChatMessage {
        let message = ChatMessage {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            text,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        let mut messages = self.messages.lock().await;
        messages.push_back(message.clone());
        if messages.len() > MAX_CHAT_MESSAGES {
            messages.pop_front();
        }
        let _ = self.sender.send(message.clone());
        message
    }
}

#[cfg(test)]
mod tests {
    use super::{ChatState, MAX_CHAT_MESSAGES};

    #[tokio::test]
    async fn keeps_only_recent_chat_messages() {
        let state = ChatState::new();
        for index in 0..=MAX_CHAT_MESSAGES {
            state.add_message(index.to_string()).await;
        }
        let history = state.history().await;
        assert_eq!(history.len(), MAX_CHAT_MESSAGES);
        assert_eq!(history[0].text, "1");
        assert_eq!(
            history[MAX_CHAT_MESSAGES - 1].text,
            MAX_CHAT_MESSAGES.to_string()
        );
    }

    #[tokio::test]
    async fn broadcasts_new_chat_messages() {
        let state = ChatState::new();
        let mut receiver = state.subscribe();
        let message = state.add_message("hello".to_owned()).await;
        assert_eq!(
            receiver.recv().await.expect("message should be broadcast"),
            message
        );
    }
}
