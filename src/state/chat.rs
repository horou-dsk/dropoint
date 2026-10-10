use std::{
    collections::{HashMap, HashSet, VecDeque},
    io,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tempfile::{NamedTempFile, TempDir};
use tokio::{
    sync::{Mutex, Notify, OnceCell, broadcast},
    time::Instant,
};

pub const MAX_CHAT_MESSAGES: usize = 200;
const MAX_ATTACHMENTS: usize = 10;
const MAX_TEXT_LENGTH: usize = 10_000;
const UPLOAD_LIFETIME: Duration = Duration::from_secs(10 * 60);
const SUBMISSION_LIFETIME: Duration = Duration::from_secs(30 * 60);
const MAX_SUBMISSIONS: usize = 1_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub preview_url: Option<String>,
    pub download_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: u64,
    pub text: String,
    pub timestamp: u64,
    pub attachments: Vec<ChatAttachment>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MessageRequest {
    pub client_message_id: String,
    pub submission_token: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareMessageRequest {
    pub client_message_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedMessage {
    pub submission_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KeepAliveRequest {
    pub client_message_id: String,
    pub submission_token: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Debug)]
pub(crate) enum ChatError {
    Invalid(String),
    IdConflict,
    SubmissionExpired,
    SubmissionCapacity,
    Unavailable(Vec<String>),
    NotFound,
    PreviewUnsupported,
    Upload(StatusCode, String),
    Io(io::Error),
}

impl From<io::Error> for ChatError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<axum::extract::multipart::MultipartError> for ChatError {
    fn from(error: axum::extract::multipart::MultipartError) -> Self {
        Self::Upload(error.status(), error.to_string())
    }
}

impl IntoResponse for ChatError {
    fn into_response(self) -> Response {
        let (status, code, message, ids) = match self {
            Self::Invalid(message) => (StatusCode::BAD_REQUEST, "invalid_message", message, vec![]),
            Self::IdConflict => (
                StatusCode::CONFLICT,
                "message_id_conflict",
                "此消息标识已经用于其他内容".into(),
                vec![],
            ),
            Self::SubmissionExpired => (
                StatusCode::GONE,
                "submission_expired",
                "发送确认记录已失效，请核对聊天记录；修改草稿后可作为新消息发送".into(),
                vec![],
            ),
            Self::SubmissionCapacity => (
                StatusCode::TOO_MANY_REQUESTS,
                "submission_capacity",
                "待发送消息过多，请稍后重试".into(),
                vec![],
            ),
            Self::Unavailable(ids) => (
                StatusCode::GONE,
                "attachment_unavailable",
                "附件已过期或不存在，请重新发送".into(),
                ids,
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "attachment_not_found",
                "附件已过期或不存在".into(),
                vec![],
            ),
            Self::PreviewUnsupported => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "preview_unsupported",
                "此附件仅支持下载".into(),
                vec![],
            ),
            Self::Upload(status, message) => (status, "invalid_upload", message, vec![]),
            Self::Io(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "attachment_io",
                format!("附件存储失败：{error}"),
                vec![],
            ),
        };
        (
            status,
            Json(serde_json::json!({ "code": code, "message": message, "attachmentIds": ids })),
        )
            .into_response()
    }
}

pub(crate) struct TemporaryAttachment {
    pub file: NamedTempFile,
    // A reader can outlive AppState. Keep the parent directory until its file is closed.
    _directory: Arc<TempDir>,
}

pub(crate) struct StoredAttachment {
    pub temporary: TemporaryAttachment,
    pub metadata: ChatAttachment,
}

struct AttachmentRecord {
    file: Arc<StoredAttachment>,
    expires_at: Instant,
    references: usize,
    draft_references: usize,
    published: bool,
}

impl AttachmentRecord {
    fn is_retained(&self, now: Instant) -> bool {
        self.references > 0
            || self.draft_references > 0
            || (!self.published && self.expires_at > now)
    }
}

struct SubmissionRecord {
    token: String,
    expires_at: Instant,
    attachment_ids: Vec<String>,
    message: Option<ChatMessage>,
}

#[derive(Default)]
struct ChatData {
    messages: VecDeque<ChatMessage>,
    attachments: HashMap<String, AttachmentRecord>,
    // Pending reservations and confirmed responses share a bounded cache.
    submissions: HashMap<String, SubmissionRecord>,
    next_id: u64,
}

pub struct ChatState {
    root: Arc<PathBuf>,
    directory: OnceCell<Arc<TempDir>>,
    data: Mutex<ChatData>,
    sender: broadcast::Sender<ChatMessage>,
    cleanup_started: AtomicBool,
    cleanup_changed: Arc<Notify>,
}

impl ChatState {
    pub(super) fn new(root: Arc<PathBuf>) -> Self {
        let (sender, _) = broadcast::channel(MAX_CHAT_MESSAGES * 2);
        Self {
            root,
            directory: OnceCell::new(),
            data: Mutex::new(ChatData::default()),
            sender,
            cleanup_started: AtomicBool::new(false),
            cleanup_changed: Arc::new(Notify::new()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ChatMessage> {
        self.sender.subscribe()
    }

    pub async fn history(&self) -> Vec<ChatMessage> {
        self.data.lock().await.messages.iter().cloned().collect()
    }

    pub(crate) async fn prepare(
        self: &Arc<Self>,
        client_message_id: String,
    ) -> Result<PreparedMessage, ChatError> {
        validate_client_id(&client_message_id)?;
        let mut data = self.data.lock().await;
        expire_records(&mut data);
        if let Some(entry) = data.submissions.get(&client_message_id) {
            return Ok(PreparedMessage {
                submission_token: entry.token.clone(),
            });
        }
        if data.submissions.len() >= MAX_SUBMISSIONS {
            // An evicted token is rejected on retry, never silently treated as a new message.
            let oldest = data
                .submissions
                .iter()
                .filter(|(_, entry)| entry.message.is_some())
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(id, _)| id.clone());
            let Some(oldest) = oldest else {
                return Err(ChatError::SubmissionCapacity);
            };
            data.submissions.remove(&oldest);
        }
        let token = uuid::Uuid::new_v4().to_string();
        data.submissions.insert(
            client_message_id,
            SubmissionRecord {
                token: token.clone(),
                expires_at: Instant::now() + UPLOAD_LIFETIME,
                attachment_ids: vec![],
                message: None,
            },
        );
        drop(data);
        self.start_cleanup();
        self.cleanup_changed.notify_one();
        Ok(PreparedMessage {
            submission_token: token,
        })
    }

    pub(crate) async fn keep_alive(&self, request: KeepAliveRequest) -> Result<(), ChatError> {
        validate_client_id(&request.client_message_id)?;
        validate_attachment_ids(&request.attachment_ids)?;
        let mut data = self.data.lock().await;
        expire_records(&mut data);
        let entry = submission(&data, &request.client_message_id, &request.submission_token)?;
        if entry.message.is_some() {
            // Retrying a confirmed message does not extend its response or file lifetime.
            return Ok(());
        }
        let missing = missing_attachments(&data, &request.attachment_ids);
        if !missing.is_empty() {
            return Err(ChatError::Unavailable(missing));
        }
        let deadline = Instant::now() + UPLOAD_LIFETIME;
        let previous = std::mem::take(
            &mut data
                .submissions
                .get_mut(&request.client_message_id)
                .expect("reservation validated under the same lock")
                .attachment_ids,
        );
        // Renew both the reservation and its already uploaded files while the next file streams.
        for id in &request.attachment_ids {
            let file = data.attachments.get_mut(id).expect("attachment validated");
            if !previous.contains(id) {
                file.draft_references += 1;
            }
            file.expires_at = deadline;
        }
        release_draft_files(
            &mut data,
            previous
                .into_iter()
                .filter(|id| !request.attachment_ids.contains(id))
                .collect(),
        );
        let entry = data
            .submissions
            .get_mut(&request.client_message_id)
            .expect("reservation validated");
        entry.attachment_ids = request.attachment_ids;
        entry.expires_at = deadline;
        drop(data);
        self.cleanup_changed.notify_one();
        Ok(())
    }

    pub(crate) async fn begin_upload(&self) -> Result<TemporaryAttachment, ChatError> {
        let directory = self
            .directory
            .get_or_try_init(|| async {
                let root = Arc::clone(&self.root);
                tokio::task::spawn_blocking(move || {
                    let temporary = std::fs::canonicalize(std::env::temp_dir())?;
                    if temporary.starts_with(root.as_ref()) {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "系统临时目录位于共享目录内，无法创建聊天附件",
                        ));
                    }
                    tempfile::Builder::new()
                        .prefix("dropoint-chat-")
                        .tempdir_in(temporary)
                        .map(Arc::new)
                })
                .await
                .map_err(io::Error::other)?
            })
            .await?;
        let directory = Arc::clone(directory);
        tokio::task::spawn_blocking(move || {
            let file = NamedTempFile::new_in(directory.path())?;
            Ok(TemporaryAttachment {
                file,
                _directory: directory,
            })
        })
        .await
        .map_err(io::Error::other)?
    }

    pub(crate) async fn finish_upload(
        self: &Arc<Self>,
        temporary: TemporaryAttachment,
        name: String,
        size: u64,
        mime: String,
    ) -> ChatAttachment {
        let id = uuid::Uuid::new_v4().to_string();
        let metadata = ChatAttachment {
            preview_url: (mime != "application/octet-stream")
                .then(|| format!("/api/chat/attachments/{id}/preview")),
            download_url: format!("/api/chat/attachments/{id}/download"),
            id: id.clone(),
            name,
            size,
            mime,
        };
        let expires_at = Instant::now() + UPLOAD_LIFETIME;
        self.data.lock().await.attachments.insert(
            id.clone(),
            AttachmentRecord {
                file: Arc::new(StoredAttachment {
                    temporary,
                    metadata: metadata.clone(),
                }),
                expires_at,
                references: 0,
                draft_references: 0,
                published: false,
            },
        );
        self.start_cleanup();
        self.cleanup_changed.notify_one();
        metadata
    }

    pub(crate) async fn attachment(&self, id: &str) -> Result<Arc<StoredAttachment>, ChatError> {
        let mut data = self.data.lock().await;
        expire_records(&mut data);
        data.attachments
            .get(id)
            .map(|entry| Arc::clone(&entry.file))
            .ok_or(ChatError::NotFound)
    }

    pub(crate) async fn submit(
        &self,
        mut request: MessageRequest,
    ) -> Result<ChatMessage, ChatError> {
        request.text = request.text.trim().to_owned();
        validate_client_id(&request.client_message_id)?;
        if request.text.chars().count() > MAX_TEXT_LENGTH
            || request.attachment_ids.len() > MAX_ATTACHMENTS
            || (request.text.is_empty() && request.attachment_ids.is_empty())
        {
            return Err(ChatError::Invalid(
                "消息不能为空，文字最多 10,000 个字符，附件最多 10 个".into(),
            ));
        }
        validate_attachment_ids(&request.attachment_ids)?;
        let mut data = self.data.lock().await;
        expire_records(&mut data);
        // A token is required even for first submission, so expired retries cannot publish again.
        let entry = submission(&data, &request.client_message_id, &request.submission_token)?;
        if let Some(message) = &entry.message {
            return if message.text == request.text
                && message
                    .attachments
                    .iter()
                    .map(|attachment| &attachment.id)
                    .eq(request.attachment_ids.iter())
            {
                Ok(message.clone())
            } else {
                Err(ChatError::IdConflict)
            };
        }
        let missing = missing_attachments(&data, &request.attachment_ids);
        if !missing.is_empty() {
            return Err(ChatError::Unavailable(missing));
        }
        let attachments = request
            .attachment_ids
            .iter()
            .map(|id| {
                let entry = data
                    .attachments
                    .get_mut(id)
                    .expect("all attachments validated under the same lock");
                entry.references += 1;
                entry.published = true;
                entry.file.metadata.clone()
            })
            .collect();
        let message = self.publish(&mut data, request.text, attachments);
        let entry = data
            .submissions
            .get_mut(&request.client_message_id)
            .expect("reservation validated");
        entry.expires_at = Instant::now() + SUBMISSION_LIFETIME;
        entry.message = Some(message.clone());
        let draft_files = std::mem::take(&mut entry.attachment_ids);
        release_draft_files(&mut data, draft_files);
        drop(data);
        self.cleanup_changed.notify_one();
        Ok(message)
    }

    pub async fn add_message(&self, text: String) -> ChatMessage {
        let mut data = self.data.lock().await;
        self.publish(&mut data, text, vec![])
    }

    fn publish(
        &self,
        data: &mut ChatData,
        text: String,
        attachments: Vec<ChatAttachment>,
    ) -> ChatMessage {
        data.next_id += 1;
        let message = ChatMessage {
            id: data.next_id,
            text,
            attachments,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        data.messages.push_back(message.clone());
        if data.messages.len() > MAX_CHAT_MESSAGES {
            let old = data.messages.pop_front().expect("history exceeded limit");
            for attachment in old.attachments {
                if let Some(entry) = data.attachments.get_mut(&attachment.id) {
                    entry.references -= 1;
                    if !entry.is_retained(Instant::now()) {
                        data.attachments.remove(&attachment.id);
                    }
                }
            }
        }
        let _ = self.sender.send(message.clone());
        message
    }

    fn start_cleanup(self: &Arc<Self>) {
        if self.cleanup_started.swap(true, Ordering::Relaxed) {
            return;
        }
        // One task handles changing deadlines; renewals and cache eviction do not accumulate timers.
        let state = Arc::downgrade(self);
        let changed = Arc::clone(&self.cleanup_changed);
        tokio::spawn(async move {
            loop {
                let deadline = {
                    let Some(state) = state.upgrade() else { break };
                    let mut data = state.data.lock().await;
                    expire_records(&mut data);
                    data.submissions
                        .values()
                        .map(|entry| entry.expires_at)
                        .chain(
                            data.attachments
                                .values()
                                .filter(|entry| {
                                    entry.references == 0 && entry.draft_references == 0
                                })
                                .map(|entry| entry.expires_at),
                        )
                        .min()
                };
                if let Some(deadline) = deadline {
                    tokio::select! {
                        _ = tokio::time::sleep_until(deadline) => {},
                        _ = changed.notified() => {},
                    }
                } else {
                    changed.notified().await;
                }
            }
        });
    }
}

impl Drop for ChatState {
    fn drop(&mut self) {
        self.cleanup_changed.notify_one();
    }
}

fn validate_client_id(id: &str) -> Result<(), ChatError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ChatError::Invalid("无效的客户端消息标识".into()));
    }
    Ok(())
}

fn validate_attachment_ids(ids: &[String]) -> Result<(), ChatError> {
    let mut unique = HashSet::new();
    if ids.len() > MAX_ATTACHMENTS || !ids.iter().all(|id| unique.insert(id)) {
        return Err(ChatError::Invalid("附件最多 10 个，ID 不能重复".into()));
    }
    Ok(())
}

fn submission<'a>(
    data: &'a ChatData,
    id: &str,
    token: &str,
) -> Result<&'a SubmissionRecord, ChatError> {
    data.submissions
        .get(id)
        .filter(|entry| entry.token == token)
        .ok_or(ChatError::SubmissionExpired)
}

fn missing_attachments(data: &ChatData, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| !data.attachments.contains_key(*id))
        .cloned()
        .collect()
}

fn release_draft_files(data: &mut ChatData, ids: Vec<String>) {
    for id in ids {
        if let Some(entry) = data.attachments.get_mut(&id) {
            entry.draft_references -= 1;
            if !entry.is_retained(Instant::now()) {
                data.attachments.remove(&id);
            }
        }
    }
}

fn expire_records(data: &mut ChatData) {
    let now = Instant::now();
    let expired: Vec<_> = data
        .submissions
        .iter()
        .filter(|(_, entry)| entry.expires_at <= now)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        if let Some(entry) = data.submissions.remove(&id) {
            release_draft_files(data, entry.attachment_ids);
        }
    }
    data.attachments.retain(|_, entry| entry.is_retained(now));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (TempDir, Arc<ChatState>) {
        let root = tempfile::tempdir().unwrap();
        let state = Arc::new(ChatState::new(Arc::new(root.path().to_owned())));
        (root, state)
    }

    async fn request(state: &Arc<ChatState>, id: &str, attachments: &[&str]) -> MessageRequest {
        let prepared = state.prepare(id.into()).await.unwrap();
        MessageRequest {
            client_message_id: id.into(),
            submission_token: prepared.submission_token,
            text: "caption".into(),
            attachment_ids: attachments.iter().map(|id| (*id).into()).collect(),
        }
    }

    async fn upload(state: &Arc<ChatState>) -> (ChatAttachment, PathBuf) {
        let temporary = state.begin_upload().await.unwrap();
        let path = temporary.file.path().to_owned();
        std::fs::write(&path, b"content").unwrap();
        let attachment = state
            .finish_upload(temporary, "photo.png".into(), 7, "image/png".into())
            .await;
        (attachment, path)
    }

    #[tokio::test]
    async fn keeps_only_recent_messages_and_broadcasts_text_with_empty_attachments() {
        let (_root, state) = state();
        let mut receiver = state.subscribe();
        let message = state.add_message("hello".into()).await;
        assert!(message.attachments.is_empty());
        assert_eq!(receiver.recv().await.unwrap(), message);
        for index in 0..MAX_CHAT_MESSAGES {
            state.add_message(index.to_string()).await;
        }
        let history = state.history().await;
        assert_eq!(history.len(), MAX_CHAT_MESSAGES);
        assert_eq!(history[0].text, "0");
    }

    #[tokio::test]
    async fn confirms_and_broadcasts_once_for_concurrent_identical_submissions() {
        let (_root, state) = state();
        let (attachment, _) = upload(&state).await;
        let mut receiver = state.subscribe();
        let (first, retry) = tokio::join!(
            state.submit(request(&state, "client-1", &[&attachment.id]).await),
            state.submit(request(&state, "client-1", &[&attachment.id]).await)
        );
        let first = first.unwrap();
        assert_eq!(retry.unwrap(), first);
        assert_eq!(first.attachments, vec![attachment.clone()]);
        assert_eq!(receiver.recv().await.unwrap(), first);
        assert!(receiver.try_recv().is_err());
        assert!(matches!(
            state.submit(request(&state, "client-1", &[]).await).await,
            Err(ChatError::IdConflict)
        ));
        assert_eq!(state.history().await, vec![first]);
    }

    #[tokio::test(start_paused = true)]
    async fn validates_all_ids_before_pinning_and_expires_unpublished_uploads() {
        let (_root, state) = state();
        let (attachment, path) = upload(&state).await;
        assert!(matches!(
            state
                .submit(request(&state, "invalid", &[&attachment.id, "unknown"]).await)
                .await,
            Err(ChatError::Unavailable(_))
        ));
        assert!(state.history().await.is_empty());
        let prepared = state.prepare("invalid-renew".into()).await.unwrap();
        assert!(matches!(
            state
                .keep_alive(KeepAliveRequest {
                    client_message_id: "invalid-renew".into(),
                    submission_token: prepared.submission_token,
                    attachment_ids: vec![attachment.id.clone(), "unknown".into()],
                })
                .await,
            Err(ChatError::Unavailable(_))
        ));
        assert_eq!(
            state.data.lock().await.attachments[&attachment.id].draft_references,
            0
        );
        tokio::time::advance(UPLOAD_LIFETIME).await;
        tokio::task::yield_now().await;
        assert!(
            !path.exists(),
            "expiration cleans files without a follow-up request"
        );
        assert!(matches!(
            state.attachment(&attachment.id).await,
            Err(ChatError::NotFound)
        ));
        assert!(!path.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn retains_published_files_until_last_reference_is_evicted() {
        let (_root, state) = state();
        let (attachment, path) = upload(&state).await;
        let first = state
            .submit(request(&state, "first", &[&attachment.id]).await)
            .await
            .unwrap();
        state
            .submit(request(&state, "second", &[&attachment.id]).await)
            .await
            .unwrap();
        tokio::time::advance(UPLOAD_LIFETIME * 2).await;
        assert!(state.attachment(&attachment.id).await.is_ok());
        for _ in 0..MAX_CHAT_MESSAGES - 1 {
            state.add_message("text".into()).await;
        }
        let reader = state.attachment(&attachment.id).await.unwrap();
        state.add_message("last".into()).await;
        assert!(matches!(
            state.attachment(&attachment.id).await,
            Err(ChatError::NotFound)
        ));
        assert!(path.exists(), "active reader owns the file");
        drop(reader);
        assert!(!path.exists());
        assert_eq!(
            state
                .submit(request(&state, "first", &[&attachment.id]).await)
                .await
                .unwrap(),
            first
        );
        assert_eq!(state.history().await.len(), MAX_CHAT_MESSAGES);
    }

    #[tokio::test]
    async fn restart_invalidates_ids_and_drops_session_directory() {
        let (root, state) = state();
        let (attachment, path) = upload(&state).await;
        let directory = path.parent().unwrap().to_owned();
        assert!(!path.starts_with(root.path()));
        let fresh = ChatState::new(Arc::new(root.path().to_owned()));
        assert!(fresh.history().await.is_empty());
        assert!(matches!(
            fresh.attachment(&attachment.id).await,
            Err(ChatError::NotFound)
        ));
        drop(state);
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn rejects_empty_oversized_and_duplicate_attachment_messages() {
        let (_root, state) = state();
        let mut empty = request(&state, "empty", &[]).await;
        empty.text = "  \n".into();
        assert!(matches!(
            state.submit(empty).await,
            Err(ChatError::Invalid(_))
        ));
        let mut long = request(&state, "long", &[]).await;
        long.text = "中".repeat(MAX_TEXT_LENGTH + 1);
        assert!(matches!(
            state.submit(long).await,
            Err(ChatError::Invalid(_))
        ));
        assert!(matches!(
            state
                .submit(request(&state, "duplicates", &["same", "same"]).await)
                .await,
            Err(ChatError::Invalid(_))
        ));
        assert!(matches!(
            state
                .submit(request(&state, "too-many", &["id"; 11]).await)
                .await,
            Err(ChatError::Invalid(_))
        ));
    }

    async fn renew(state: &Arc<ChatState>, id: &str, token: &str, attachments: &[&str]) {
        state
            .keep_alive(KeepAliveRequest {
                client_message_id: id.into(),
                submission_token: token.into(),
                attachment_ids: attachments.iter().map(|id| (*id).into()).collect(),
            })
            .await
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn renewals_allow_sequential_uploads_longer_than_the_pending_lifetime() {
        let (_root, state) = state();
        let prepared = state.prepare("slow-batch".into()).await.unwrap();
        // The first upload itself can take longer than ten minutes.
        for _ in 0..11 {
            tokio::time::advance(Duration::from_secs(60)).await;
            renew(&state, "slow-batch", &prepared.submission_token, &[]).await;
        }
        let (first, first_path) = upload(&state).await;
        renew(
            &state,
            "slow-batch",
            &prepared.submission_token,
            &[&first.id],
        )
        .await;
        for _ in 0..11 {
            tokio::time::advance(Duration::from_secs(60)).await;
            renew(
                &state,
                "slow-batch",
                &prepared.submission_token,
                &[&first.id],
            )
            .await;
        }
        let (second, second_path) = upload(&state).await;
        renew(
            &state,
            "slow-batch",
            &prepared.submission_token,
            &[&first.id, &second.id],
        )
        .await;
        let message = state
            .submit(MessageRequest {
                client_message_id: "slow-batch".into(),
                submission_token: prepared.submission_token,
                text: "".into(),
                attachment_ids: vec![first.id, second.id],
            })
            .await
            .unwrap();
        assert_eq!(message.attachments.len(), 2);
        assert!(first_path.exists() && second_path.exists());
        assert!(
            state
                .data
                .lock()
                .await
                .attachments
                .values()
                .all(|entry| entry.draft_references == 0)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn abandoned_reservations_release_files_at_the_last_renewal_deadline() {
        let (_root, state) = state();
        let (attachment, path) = upload(&state).await;
        let prepared = state.prepare("abandoned".into()).await.unwrap();
        renew(
            &state,
            "abandoned",
            &prepared.submission_token,
            &[&attachment.id],
        )
        .await;
        tokio::time::advance(Duration::from_secs(60)).await;
        renew(
            &state,
            "abandoned",
            &prepared.submission_token,
            &[&attachment.id],
        )
        .await;
        tokio::time::advance(UPLOAD_LIFETIME - Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(path.exists());
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(
            !path.exists(),
            "renewed files expire without another request"
        );
        assert!(state.data.lock().await.submissions.is_empty());
    }

    #[tokio::test]
    async fn active_drafts_keep_reused_files_after_message_history_eviction() {
        let (_root, state) = state();
        let (attachment, path) = upload(&state).await;
        state
            .submit(request(&state, "original", &[&attachment.id]).await)
            .await
            .unwrap();
        let prepared = state.prepare("reuse".into()).await.unwrap();
        renew(
            &state,
            "reuse",
            &prepared.submission_token,
            &[&attachment.id],
        )
        .await;
        for _ in 0..MAX_CHAT_MESSAGES {
            state.add_message("later".into()).await;
        }
        assert!(state.attachment(&attachment.id).await.is_ok());
        renew(&state, "reuse", &prepared.submission_token, &[]).await;
        assert!(
            !path.exists(),
            "dropping the last draft reference removes an evicted file"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn confirmation_cache_expires_without_republishing_old_tokens() {
        let (_root, state) = state();
        let original = request(&state, "confirmed", &[]).await;
        let token = original.submission_token.clone();
        let message = state.submit(original).await.unwrap();
        tokio::time::advance(SUBMISSION_LIFETIME).await;
        tokio::task::yield_now().await;
        assert!(state.data.lock().await.submissions.is_empty());
        // Preparing a new reservation under the same client ID cannot make an old token valid.
        let fresh = state.prepare("confirmed".into()).await.unwrap();
        assert_ne!(fresh.submission_token, token);
        assert!(matches!(
            state
                .submit(MessageRequest {
                    client_message_id: "confirmed".into(),
                    submission_token: token,
                    text: message.text.clone(),
                    attachment_ids: vec![],
                })
                .await,
            Err(ChatError::SubmissionExpired)
        ));
        assert_eq!(state.history().await, vec![message]);
    }

    #[tokio::test]
    async fn confirmation_cache_is_bounded_and_evicted_retries_are_rejected() {
        let (_root, state) = state();
        let original = request(&state, "oldest", &[]).await;
        let token = original.submission_token.clone();
        state.submit(original).await.unwrap();
        for index in 0..MAX_SUBMISSIONS {
            let id = format!("message-{index}");
            state.submit(request(&state, &id, &[]).await).await.unwrap();
        }
        assert_eq!(state.data.lock().await.submissions.len(), MAX_SUBMISSIONS);
        let before = state.history().await;
        assert!(matches!(
            state
                .submit(MessageRequest {
                    client_message_id: "oldest".into(),
                    submission_token: token,
                    text: "caption".into(),
                    attachment_ids: vec![],
                })
                .await,
            Err(ChatError::SubmissionExpired)
        ));
        assert_eq!(state.history().await, before);
        let newest = format!("message-{}", MAX_SUBMISSIONS - 1);
        assert_eq!(
            state
                .submit(request(&state, &newest, &[]).await)
                .await
                .unwrap(),
            *before.last().unwrap()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn pending_cache_capacity_preserves_active_reservations_and_recovers_after_expiry() {
        let (_root, state) = state();
        for index in 0..MAX_SUBMISSIONS {
            state.prepare(format!("pending-{index}")).await.unwrap();
        }
        assert!(matches!(
            state.prepare("extra".into()).await,
            Err(ChatError::SubmissionCapacity)
        ));
        assert_eq!(state.data.lock().await.submissions.len(), MAX_SUBMISSIONS);
        tokio::time::advance(UPLOAD_LIFETIME).await;
        tokio::task::yield_now().await;
        assert!(state.data.lock().await.submissions.is_empty());
        assert!(state.prepare("extra".into()).await.is_ok());
    }
}
