use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Parser)]
#[command(
    version,
    about = "Share a local directory and text over your local network"
)]
pub struct Args {
    /// Directory to share (defaults to the current working directory)
    #[arg(default_value = ".")]
    pub directory: PathBuf,

    /// API listening port; 0 lets the operating system assign an unused port
    #[arg(short, long, default_value_t = 0)]
    pub port: u16,
}
