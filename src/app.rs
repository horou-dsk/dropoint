use std::path::PathBuf;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};

use crate::{
    routes::{
        chat::chat_socket,
        files::{
            create_archive, delete_files, download_archive, download_file, list_files,
            preview_file, upload_file,
        },
        health::health,
    },
    state::AppState,
};

pub fn create_app(root: PathBuf) -> Router {
    let state = AppState::new(root);

    Router::new()
        .route("/api/health", get(health))
        .route("/api/info", get(crate::routes::files::info))
        .route("/api/files", get(list_files).post(upload_file))
        .route("/api/files/download", get(download_file))
        .route("/api/files/preview", get(preview_file))
        .route("/api/files/archive", post(create_archive))
        .route("/api/files/archive/{id}", get(download_archive))
        .route("/api/files/delete", post(delete_files))
        .route("/api/chat", get(chat_socket))
        .layer(DefaultBodyLimit::max(1024 * 1024 * 1024))
        .fallback(crate::routes::frontend::serve)
        .with_state(state)
}
