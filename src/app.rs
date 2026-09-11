use axum::{Router, routing::get};

use crate::routes::health::health;

pub fn create_app() -> Router {
    Router::new().route("/api/health", get(health))
}
