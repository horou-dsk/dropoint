use std::{io, path::Path};

fn main() -> io::Result<()> {
    // Track added/removed hashed assets as well as changes to existing files.
    println!("cargo::rerun-if-changed=web/dist");
    if !Path::new("web/dist/index.html").is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "missing web/dist/index.html; run `pnpm install --frozen-lockfile` and `pnpm --dir web build` before Cargo",
        ));
    }
    Ok(())
}
