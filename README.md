# Dropoint

**English** | [中文](README.zh-CN.md)

Dropoint is a local network tool for sharing files and text. Bind a local directory at startup, then browse, preview, upload, and download files in your browser. Use the shared chat panel to pass text between devices.

## Features

- **File workspace**: Icon and list views with saved preferences; icon view is the default. Sort by name, modification time, or size, with folders always displayed first.
- **Navigation and previews**: Double-click to enter a folder or open a preview dialog. Preview text, images, and browser-compatible video; download other file types. Directory navigation uses browser history, including mouse back and forward buttons.
- **Selection and context menus**: Use Ctrl/Cmd to toggle selection and Shift to select a range. Download or delete selected items from the context menu or toolbar.
- **Batch downloads**: Download a single file directly, or combine folders and multiple items into one ZIP that preserves hierarchy, Unicode filenames, and empty directories.
- **Drag-and-drop uploads**: Drop multiple files or folders into the current directory. Resolve filename conflicts by automatically renaming, overwriting, or cancelling.
- **Shared chat**: Synchronize text over WebSocket, with connection status, automatic reconnection, and per-message copying. The server retains the latest 200 messages in memory and clears them on restart.
- **Upload progress**: Show current-file and byte-weighted batch progress with transferred sizes. After transmission, wait for the server to confirm saving; retain success, failure and cancellation results. Conflicting files can still be renamed or overwritten, with progress reset for each retry.
- **Appearance and layout**: Follow the system light/dark theme by default and remember manual overrides. File and chat panels scroll independently; switch between panels on narrow screens.

## Tech stack

| Area | Technologies |
| --- | --- |
| Backend | Rust 2024, Axum, Tokio, Serde, zip 8 |
| Frontend | Vite 8, React, TypeScript, Tailwind CSS v4 |
| Testing | Rust built-in test framework, Vitest, Testing Library, jsdom |
| Package management | Cargo, pnpm workspace |

## Quick start

### Run a release binary

Download the binary for your platform from this repository's GitHub Releases. Each binary includes the web interface; Rust, Node.js, pnpm and a separate `web/dist` directory are not needed to run it. Choose the directory to share and open the printed port using `localhost` or the host's LAN IP:

```powershell
# Windows (replace the version with the downloaded release)
.\dropoint-v0.1.0-windows-x86_64.exe "D:\Shared Files" --port 8080
```

```sh
# Linux glibc example; use the matching filename on macOS or musl Linux
chmod +x dropoint-v0.1.0-linux-x86_64-gnu
./dropoint-v0.1.0-linux-x86_64-gnu /path/to/share --port 8080
```

Open [http://localhost:8080](http://localhost:8080), or `http://<host-LAN-IP>:8080` from another device. The directory must already exist. Omitting `--port` allocates an available port; omitting the directory shares the working directory. Renaming the executable to `dropoint` (or `dropoint.exe`) is supported.

| Asset suffix | Platform |
| --- | --- |
| `windows-x86_64.exe` | Windows x64; statically links the CRT, without a separate VC++ runtime install |
| `macos-x86_64` | macOS Intel |
| `macos-aarch64` | macOS Apple Silicon |
| `linux-x86_64-gnu` | Linux x64 with glibc; built on Ubuntu 22.04 (glibc 2.35 baseline) |
| `linux-x86_64-musl` | Linux x64 with statically linked musl; suitable for Alpine and systems with older glibc |

The initial releases are unsigned; macOS binaries are not notarized. macOS/Linux downloads need executable permission (`chmod +x`).

### Prerequisites

- The latest stable [Rust and Cargo](https://rustup.rs/).
- [Node.js 24 LTS](https://nodejs.org/) is recommended.
- pnpm **11.9.0**, matching the root `package.json` `packageManager` field. Install it with `npm install -g pnpm@11.9.0` if needed.

### Start both services

Run these commands from the repository root:

```sh
pnpm install
pnpm --dir web build
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). This starts both Axum and Vite, explicitly setting the backend port to `3000` to match the development proxy. The shared directory defaults to the working directory of `cargo run`; when launched from the repository root, it shares the repository directory.

| Service | Listening address with `pnpm dev` | Purpose |
| --- | --- | --- |
| Vite | `0.0.0.0:5173` | Web interface and `/api` HTTP/WebSocket proxy |
| Axum | `0.0.0.0:3000` | File API and shared chat |

Other devices on the same local network can open `http://<host-LAN-IP>:5173`. Use the Network address printed by Vite; if the default port is occupied, use the actual address in its output. If a device cannot connect, check that it is on the same network and that the firewall allows access to the frontend port.

### Share a specific directory

Open two terminals at the repository root and start the backend and frontend separately. The target directory must already exist:

```sh
# Terminal 1: start the backend with a shared directory
cargo run -- /path/to/share --port 3000
```

Windows example:

```powershell
cargo run -- "D:\Shared Files" --port 3000
```

```sh
# Terminal 2: start the frontend
pnpm --dir web dev
```

Use these two commands in place of `pnpm dev`. Omitting the directory argument uses the current working directory. Relative directory arguments are also resolved against the working directory.

### Choose a listening port

Standalone backend runs use an available port assigned by the operating system unless `--port` (or `-p`) is provided:

```sh
# Share the working directory on an automatically assigned port
cargo run

# Share the working directory on port 8080
cargo run -- --port 8080

# Combine a directory with a port; either argument order is supported
cargo run -- /path/to/share -p 8080

# Show command-line help
cargo run -- --help
```

Port `0` also requests automatic allocation. Read the actual port from the startup message `API server listening on http://0.0.0.0:<port>` and connect using `localhost` or the host's LAN IP. An unavailable explicit port causes startup to fail rather than silently choosing another port. The port option controls Axum; Vite still defaults to `5173`.

When starting Vite separately, set `DROPOINT_API_PORT` to the backend's actual port if it differs from `3000`. For a backend on port `8080`:

```sh
# macOS / Linux, in the frontend terminal
DROPOINT_API_PORT=8080 pnpm --dir web dev
```

```powershell
# Windows PowerShell, in the frontend terminal
$env:DROPOINT_API_PORT = '8080'
pnpm --dir web dev
```

For an automatically assigned port, substitute the value printed by the backend. Restart Vite when changing its proxy port; both file requests and chat WebSocket connections use this proxy.

## Usage

| Action | Behavior |
| --- | --- |
| Click an item | Select one file or folder |
| Ctrl/Cmd + click | Add or remove an item from the selection |
| Shift + click | Select a range in the current display order |
| Ctrl/Cmd + Shift + click | Add a range to the selection |
| Ctrl/Cmd + A | Select all items in the current directory when the file area has focus |
| Double-click an item | Enter a folder or open a file preview |
| Right-click an item | Open/preview, download, or delete; multiple selections show batch actions |
| Right-click empty space | Refresh, select all, or clear selection |
| Enter / Shift + Enter in chat | Send text / insert a line break |

Selections are limited to the current directory. Changing the view or sort order preserves selection; navigating to another directory clears it. Refreshing removes selections for items that no longer exist. Right-clicking a selected item preserves the whole selection.

Use Refresh to reload the file listing; chat messages are broadcast in real time. Theme and view preferences are stored in the current browser and do not synchronize across devices. The web interface currently uses Chinese labels.

## Limitations

- There is no login, access control, or TLS configuration. Devices that can reach the service can read, upload, overwrite, and delete shared content. Use it on a trusted local network and choose the shared directory accordingly.
- Deletion requires confirmation and is **permanent**, bypassing the recycle bin. Deleting a folder removes its contents too. Partial failures are reported; completed deletions are not rolled back.
- Each upload request body is limited to **1 GiB**, including multipart overhead. The frontend uploads files individually. Folder drag-and-drop depends on browser support, and video previews depend on supported codecs.
- ZIP files are generated in the system temporary directory outside the shared root and require available temporary disk space. Download URLs expire after **10 minutes**, while downloads already in progress can finish. Archiving is rejected if the system temporary directory is inside the shared root.
- ZIP creation rejects symbolic links and Windows junctions. Deleting a link removes only the link, leaving its target intact; batch operations cannot traverse a link to access descendants.
- Chat history exists only in process memory. Each message is limited to **10,000 characters**, and restarting the server clears the history.

## Development and builds

Before running Cargo (including tests and development builds), install dependencies and build the frontend once:

```sh
pnpm install --frozen-lockfile
pnpm --dir web build
```

```sh
cargo fmt --all -- --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
pnpm --dir web test
```

Build the single executable, always building the frontend first:

```sh
pnpm --dir web build
cargo build --release --locked
```

The executable is `target/release/dropoint` (`dropoint.exe` on Windows). `rust-embed` compiles `web/dist/` into the executable in both debug and release builds. Axum serves the web interface, `/api/*` and the chat WebSocket on the same port. Rebuild the frontend and then Rust after frontend changes; `build.rs` tracks added, removed and modified assets. During development, Vite still provides hot reload on port `5173`.

Run the release smoke test with `node web/scripts/smoke-release.mjs target/release/dropoint` (append `.exe` on Windows). It copies only the executable into a temporary directory, starts it against a separate shared directory, checks the embedded page, JS/CSS, SPA fallback, API 404s, health, uploads/downloads and WebSocket chat, then stops it and removes its temporary files.

On Windows, if a running process locks the test build output, use `cargo test --target-dir target/verification`.

### GitHub Actions releases

[Release binaries](.github/workflows/release.yml) runs only for pushed `v*` tags or manual dispatch. It builds all five targets, verifies each executable, and uploads the raw binaries to a GitHub Release only after every target succeeds. No additional archive or checksum files are published.

Commit and push the workflow and source changes first. Set the intended version in `Cargo.toml` and refresh `Cargo.lock` before tagging; the tag controls asset names while `--version` uses the Cargo package version. Then create and push a release tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

For a manual run, choose **Actions → Release binaries → Run workflow** and enter an existing tag, such as `v0.1.0`. Tags must start with `v` followed by a letter or number and contain only letters, numbers, dots, underscores or hyphens. The workflow resolves that tag once and builds its exact commit for every platform. The tagged commit must include the workflow, smoke test and frontend embedding changes. Builds use read-only repository permissions; only the Release job grants `contents: write` through the built-in `GITHUB_TOKEN`.

## Project structure

```text
dropoint/
├── src/
│   ├── main.rs          # Directory argument and server startup
│   ├── cli.rs           # Shared directory and port arguments
│   ├── app.rs           # Axum route composition
│   ├── state.rs         # Shared directory, chat, and archive state
│   ├── routes.rs
│   └── routes/         # File, health, and chat endpoints
├── tests/              # Rust integration tests
├── web/
│   ├── src/
│   │   ├── components/ # File, preview, menu, and chat components
│   │   └── lib/        # API, selection, theme, and upload logic
│   └── vite.config.ts  # Development server and API proxy
├── Cargo.toml
├── package.json
└── pnpm-workspace.yaml
```

See [AGENTS.md](AGENTS.md) for contributor guidelines. Rust modules use a sibling `.rs` file and matching directory; frontend source and dependencies belong in `web/`.

## API overview

File paths are relative to the shared root bound at startup. URL-encode paths used in query parameters.

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/health` | Returns `{ "status": "ok" }` |
| GET | `/api/info` | Shared directory name |
| GET | `/api/files?path=...` | Directory listing; omit `path` for the root |
| GET | `/api/files/conflict?path=...&relative_path=...` | Check whether an upload target already exists before sending the file |
| POST | `/api/files?path=...&conflict=fail` | Multipart upload; `conflict` accepts `fail`, `rename`, or `overwrite` |
| GET | `/api/files/download?path=...` | Single-file download with byte-range support |
| GET | `/api/files/preview?path=...` | File preview with byte-range support |
| POST | `/api/files/archive` | JSON `{ "paths": [...] }`; returns download `url` and `filename` |
| GET | `/api/files/archive/{id}` | Download a generated ZIP |
| POST | `/api/files/delete` | JSON `{ "paths": [...] }`; returns `deleted` and `failed` |
| WebSocket | `/api/chat` | Shared chat; sends history on connection |

For uploads, send the `relative_path` text field before a single `file` field. If `relative_path` is omitted, the uploaded filename is used. Filename conflicts return `409 Conflict` by default.

Chat clients send `{ "type": "send", "text": "hello" }`. The server sends `{ "type": "history", "messages": [...] }` or `{ "type": "message", "message": ... }`. Each message contains `id`, `text`, and a Unix-millisecond `timestamp`.
