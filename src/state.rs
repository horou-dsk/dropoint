use std::{path::PathBuf, sync::Arc};

mod chat;
pub use chat::{ChatAttachment, ChatMessage, ChatState, MAX_CHAT_MESSAGES};
pub(crate) use chat::{
    ChatError, KeepAliveRequest, MessageRequest, PrepareMessageRequest, PreparedMessage,
};

#[derive(Clone)]
pub struct AppState {
    pub root: Arc<PathBuf>,
    pub chat: Arc<ChatState>,
    pub(crate) archives: Arc<crate::routes::files::archive::ArchiveStore>,
}

impl AppState {
    pub fn new(root: PathBuf) -> Self {
        let root = std::fs::canonicalize(&root).unwrap_or(root);
        let root = Arc::new(root);
        Self {
            chat: Arc::new(ChatState::new(Arc::clone(&root))),
            root,
            archives: Arc::default(),
        }
    }
}
