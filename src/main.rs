use std::error::Error;

use dropoint::app::create_app;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:3000").await?;

    println!("API server listening on http://{}", listener.local_addr()?);
    axum::serve(listener, create_app()).await?;

    Ok(())
}
