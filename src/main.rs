use std::{env, error::Error, path::PathBuf};

use dropoint::app::create_app;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let directory = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or(env::current_dir()?);
    let directory = std::fs::canonicalize(&directory)?;

    if !directory.is_dir() {
        return Err(format!(
            "share directory is not a directory: {}",
            directory.display()
        )
        .into());
    }

    let listener = TcpListener::bind("0.0.0.0:3000").await?;

    println!("Sharing {}", directory.display());
    println!("API server listening on http://{}", listener.local_addr()?);
    axum::serve(listener, create_app(directory)).await?;

    Ok(())
}
