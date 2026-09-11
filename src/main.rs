mod cli;

use std::{error::Error, io, net::Ipv4Addr};

use clap::Parser;
use dropoint::app::create_app;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args = cli::Args::parse();
    let directory = std::fs::canonicalize(&args.directory)?;

    if !directory.is_dir() {
        return Err(format!(
            "share directory is not a directory: {}",
            directory.display()
        )
        .into());
    }

    // Bind port 0 directly instead of probing a free port and reopening it.
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, args.port))
        .await
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to bind API port {}: {error}", args.port),
            )
        })?;

    println!("Sharing {}", directory.display());
    println!("API server listening on http://{}", listener.local_addr()?);
    axum::serve(listener, create_app(directory)).await?;

    Ok(())
}
