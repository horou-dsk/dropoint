# Dropoint

[English](README.md) | **中文**

Dropoint 是一个局域网文件、文字与媒体传递工具。启动时绑定一个本地目录，即可在浏览器中浏览、预览、上传和下载文件，并通过共享对话在多台设备之间传递消息和附件。

## 功能

- **文件工作台**：支持图标和列表视图，默认使用图标视图，自动保存视图偏好。支持名称、修改时间和大小排序，文件夹始终排在文件前面。
- **目录浏览与预览**：双击进入文件夹或打开预览弹窗；支持文本、图片和浏览器可播放的视频，其他类型可直接下载。目录导航接入浏览器历史，支持鼠标后退、前进键。
- **多选与右键菜单**：支持 Ctrl/Cmd 多选、Shift 连选，通过右键菜单或工具栏执行下载和删除。
- **批量下载**：单个文件直接下载；文件夹或多个项目合并为 ZIP，保留目录层级、中文文件名和空目录。
- **拖拽上传**：支持拖入多个文件或文件夹，上传到当前浏览目录。同名冲突时可选择自动重命名、覆盖或取消。
- **共享对话**：支持文字、图片、视频、音频及普通文件。可粘贴截图和文件或选择多个附件，预览并编辑草稿后发送；通过 WebSocket 实时同步，提供连接状态、自动重连、文字复制、媒体预览和下载。服务端保留最近 200 条消息，重启后清空。
- **上传进度**：显示当前文件及按大小加权的批量总进度、已传输大小；传输完成后等待服务端确认保存，保留成功、失败和取消结果。同名文件仍可重命名或覆盖，重试时重置当前文件进度。
- **外观与布局**：默认跟随系统亮色或深色模式，手动切换后保存选择。文件与聊天面板独立滚动，窄屏可切换工作面板。

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 后端 | Rust 2024、Axum、Tokio、Serde、zip 8 |
| 前端 | Vite 8、React、TypeScript、Tailwind CSS v4 |
| 测试 | Rust 内置测试框架、Vitest、Testing Library、jsdom |
| 包管理 | Cargo、pnpm workspace |

## 快速开始

### 运行发布版二进制

从本仓库的 GitHub Releases 下载对应平台的文件。每个二进制已经包含网页，运行时不需要 Rust、Node.js、pnpm 或独立的 `web/dist` 目录。指定共享目录后，通过 `localhost` 或运行主机的局域网 IP 访问实际监听端口：

```powershell
# Windows（将版本号替换为下载的版本）
.\dropoint-v0.1.0-windows-x86_64.exe "D:\Shared Files" --port 8080
```

```sh
# Linux glibc 示例；macOS 或 musl Linux 使用对应文件名
chmod +x dropoint-v0.1.0-linux-x86_64-gnu
./dropoint-v0.1.0-linux-x86_64-gnu /path/to/share --port 8080
```

打开 [http://localhost:8080](http://localhost:8080)，其他设备访问 `http://<运行主机的局域网 IP>:8080`。共享目录必须已存在；省略 `--port` 时自动分配空闲端口，省略目录参数时共享当前工作目录。可将程序重命名为 `dropoint`（Windows 为 `dropoint.exe`）。

| 产物后缀 | 平台 |
| --- | --- |
| `windows-x86_64.exe` | Windows x64；静态链接 CRT，无需单独安装 VC++ 运行库 |
| `macos-x86_64` | macOS Intel |
| `macos-aarch64` | macOS Apple Silicon |
| `linux-x86_64-gnu` | Linux x64 glibc；在 Ubuntu 22.04 上构建，glibc 基线为 2.35 |
| `linux-x86_64-musl` | Linux x64，静态链接 musl，适合 Alpine 或 glibc 较旧的系统 |

第一版不配置代码签名或 macOS notarization。macOS/Linux 下载后需要使用 `chmod +x` 添加执行权限。

### 环境准备

- 最新稳定版 [Rust 与 Cargo](https://rustup.rs/)。
- 推荐使用 [Node.js 24 LTS](https://nodejs.org/)。
- pnpm **11.9.0**，与根目录 `package.json` 的 `packageManager` 一致。可使用 `npm install -g pnpm@11.9.0` 安装。

### 启动前后端

在仓库根目录执行：

```sh
pnpm install
pnpm --dir web build
pnpm dev
```

打开 [http://localhost:5173](http://localhost:5173)。`pnpm dev` 会先在仓库根目录创建 `.tmp/`（如果不存在），将其作为开发共享目录，再启动 Axum 和 Vite。已有目录中的内容会保留，该目录已被 Git 忽略。后端监听 `5175`，与默认开发代理保持一致。

| 服务 | `pnpm dev` 的监听地址 | 用途 |
| --- | --- | --- |
| Vite | `0.0.0.0:5173` | 网页及 `/api` HTTP/WebSocket 代理 |
| Axum | `0.0.0.0:5175` | 文件 API 与共享对话 |

同一局域网的其他设备访问 `http://<运行主机的局域网 IP>:5173`。使用 Vite 启动日志中的 Network 地址；若端口被占用，以实际输出地址为准。连接失败时，检查设备是否位于同一网络，以及防火墙是否允许前端端口访问。

### 指定共享目录

在仓库根目录打开两个终端，分别启动后端和前端。目标目录必须已存在：

```sh
# 终端 1：启动后端，指定共享目录
cargo run -- /path/to/share --port 5175
```

Windows 示例：

```powershell
cargo run -- "D:\Shared Files" --port 5175
```

```sh
# 终端 2：启动前端
pnpm --dir web dev
```

这两个命令替代 `pnpm dev`。省略目录参数时使用当前工作目录；指定相对路径时，也以当前工作目录为基准。

### 指定监听端口

单独启动后端时，使用 `--port`（简写 `-p`）指定端口；未指定时由操作系统分配空闲端口：

```sh
# 共享当前目录，自动分配端口
cargo run

# 共享当前目录，监听 8080
cargo run -- --port 8080

# 同时指定目录和端口，参数顺序不限
cargo run -- /path/to/share -p 8080

# 查看命令行帮助
cargo run -- --help
```

端口 `0` 也表示自动分配。启动日志 `API server listening on http://0.0.0.0:<port>` 会输出实际端口，访问时使用 `localhost` 或运行主机的局域网 IP。显式指定的端口不可用时，程序会报错退出，不会静默切换端口。此参数控制 Axum，Vite 仍默认使用 `5173`。

单独启动 Vite 时，如果后端端口不是 `5175`，需通过 `DROPOINT_API_PORT` 设置代理端口。以后端监听 `8080` 为例：

```sh
# macOS / Linux，在前端终端执行
DROPOINT_API_PORT=8080 pnpm --dir web dev
```

```powershell
# Windows PowerShell，在前端终端执行
$env:DROPOINT_API_PORT = '8080'
pnpm --dir web dev
```

后端自动分配端口时，将示例中的数值替换为实际日志输出的端口。更改代理端口后需重新启动 Vite；文件请求和聊天 WebSocket 均通过该代理连接。

## 使用方式

| 操作 | 行为 |
| --- | --- |
| 单击项目 | 选中一个文件或文件夹 |
| Ctrl/Cmd + 单击 | 添加或移除选中项 |
| Shift + 单击 | 按当前显示顺序连续选择 |
| Ctrl/Cmd + Shift + 单击 | 追加连续选区 |
| Ctrl/Cmd + A | 文件内容区域获得焦点时全选当前目录 |
| 双击项目 | 进入文件夹或打开文件预览 |
| 右键项目 | 打开/预览、下载、删除；多选时显示批量操作 |
| 右键空白处 | 刷新、全选、取消选择 |
| 聊天中粘贴文件 / 点击 ＋ | 添加待发送附件，每条消息最多 10 个 |
| 聊天中 Enter / Shift + Enter | 发送草稿 / 换行 |

多选仅限当前目录。切换视图和排序保留选区，进入其他目录会清空选区；刷新会移除已不存在的选中项。右键已选项目时保留整个选区。

文件列表通过刷新按钮重新读取；聊天文本实时广播。主题和视图偏好保存在当前浏览器中，不会跨设备同步。当前网页界面使用中文。

聊天附件先进入待发送区，可添加文字、移除文件，也可只发送附件。点击发送后逐个上传，显示当前文件和整体进度，收到服务端确认后才清空草稿。发送期间每分钟续期发送凭证并保留已上传附件，避免后续文件传输较慢时前面的文件过期。失败时保留文字和附件，重试复用已上传成功的文件；已过期的未提交附件会自动重新上传。粘贴依赖浏览器提供文件数据；剪贴板只有文件路径文字时，请使用附件选择按钮。图片缩略图可点击查看大图，视频和音频使用浏览器原生播放控件；所有附件均可下载，媒体加载或解码失败时也有下载入口。文件按原始内容发送，不压缩、不转码。

## 使用限制

- 当前没有登录、访问控制或 TLS 配置。能够访问服务的设备可以读取、上传、覆盖及删除共享目录中的内容，请在可信局域网中使用，并选择合适的共享目录。
- 删除需要弹窗确认，属于**永久删除**，不会进入回收站。文件夹及其内容一并删除；部分失败会显示结果，已完成的删除不会回滚。
- 每次上传请求的请求体上限为 **1 GiB**，包含 multipart 开销；前端逐个上传文件。文件夹拖拽依赖浏览器支持，视频预览依赖浏览器支持相应编码。
- ZIP 在共享目录外的系统临时目录中生成，需要足够的临时磁盘空间。下载地址有效期为 **10 分钟**；已开始的下载可继续完成。若系统临时目录位于共享目录内，打包请求会被拒绝。
- ZIP 打包遇到符号链接或 Windows junction 会报错。删除链接时仅移除链接本身，不删除链接目标；批量操作不允许通过链接进入子目录。
- 聊天记录仅保存在进程内存中，每条消息最多 **10,000 个字符**和 **10 个附件**。附件存放在共享目录外的独立系统临时目录，需要足够的临时磁盘空间。未提交的附件在上传完成或发送期间最后一次续期的 **10 分钟**后过期；已发送附件由最近 **200 条消息**或正在发送的草稿保留，最后一个引用移除后删除。已开始的下载可继续完成；服务重启后聊天历史、附件 ID 和发送凭证全部失效。若系统临时目录位于共享目录内，聊天附件上传会被拒绝。
- 按 Ctrl+C（Unix 也支持 SIGTERM）后停止接受新连接，最多等待 **10 秒**让在途请求完成。再次收到退出信号或等待超时，会取消剩余请求并退出，同时清理临时附件和归档。强行关闭终端或杀死进程可能使清理无法完成。
- 发送凭证连续 **10 分钟**未续期就失效。幂等确认缓存最多保存 **1,000 条待发送或已确认记录**；确认响应在提交 **30 分钟**后过期，也可能因容量限制提前淘汰。确认失效后无法安全重试，请先查看聊天记录，必要时修改保留的草稿，作为新消息发送。
- HTML、SVG 等主动内容仅作为普通聊天附件下载。可预览的图片、音视频使用安全 MIME 白名单及 `nosniff`；能否播放仍取决于浏览器支持的编码。

## 开发与构建

首次运行 Cargo（包括测试和开发构建）前，先安装依赖并生成前端产物：

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

构建单二进制文件，必须先构建前端：

```sh
pnpm --dir web build
cargo build --release --locked
```

程序位于 `target/release/dropoint`（Windows 为 `dropoint.exe`）。`rust-embed` 在 debug 和 release 构建中都将 `web/dist/` 编译进程序；Axum 在同一端口提供网页、`/api/*` 和聊天 WebSocket。前端修改后需先重新构建前端，再编译 Rust；`build.rs` 会跟踪资源的新增、删除和修改。开发时仍可使用 Vite 在 `5173` 端口提供热更新。

运行 `node web/scripts/smoke-release.mjs target/release/dropoint`（Windows 追加 `.exe`）可验证发布程序。脚本仅将二进制复制到临时目录，绑定另一个共享目录启动，检查内嵌页面、JS/CSS、SPA fallback、API 404、健康接口、文件上传下载、文字和媒体广播、重复消息提交去重，以及附件预览、下载、HEAD 和 Range，最后停止程序并清理临时文件。

Windows 下若运行中的程序锁定测试构建产物，可使用 `cargo test --target-dir target/verification`。

### GitHub Actions 发布

[Release binaries](.github/workflows/release.yml) 仅在推送 `v*` 标签或手动触发时执行。流水线构建五个目标并逐个验证程序，全部成功后才将原始二进制上传到 GitHub Release，不发布额外压缩包或校验文件。

先提交并推送工作流和源码改动。在打标签前设置 `Cargo.toml` 版本并同步 `Cargo.lock`；标签决定下载文件名，`--version` 使用 Cargo 包版本。之后创建并推送发布标签：

```sh
git tag v0.1.0
git push origin v0.1.0
```

手动构建时，在 **Actions → Release binaries → Run workflow** 输入已有标签，例如 `v0.1.0`。标签必须以 `v` 加字母或数字开头，且只包含字母、数字、点、下划线或连字符。流水线先解析标签，所有平台都构建该标签指向的同一提交；被标记的提交必须包含工作流、发布验证脚本和资源嵌入改动。构建任务仅使用仓库读取权限，只有 Release 任务通过内置 `GITHUB_TOKEN` 获得 `contents: write` 权限。

## 项目结构

```text
dropoint/
├── src/
│   ├── main.rs          # 目录参数与服务启动
│   ├── cli.rs           # 共享目录与端口参数
│   ├── app.rs           # Axum 路由组合
│   ├── state.rs         # 共享目录、聊天和归档状态
│   ├── routes.rs
│   └── routes/         # 文件、健康检查与聊天接口
├── tests/              # Rust 集成测试
├── web/
│   ├── src/
│   │   ├── components/ # 文件、预览、菜单与聊天组件
│   │   └── lib/        # API、选择状态、主题与上传逻辑
│   └── vite.config.ts  # 开发服务器与 API 代理
├── Cargo.toml
├── package.json
└── pnpm-workspace.yaml
```

贡献约定见 [AGENTS.md](AGENTS.md)。Rust 模块使用同名 `.rs` 文件与目录组合，前端代码和依赖集中在 `web/`。

## API 概览

文件路径均相对于启动时绑定的共享根目录；查询参数中的路径需进行 URL 编码。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 返回 `{ "status": "ok" }` |
| GET | `/api/info` | 共享目录名称 |
| GET | `/api/files?path=...` | 列出目录；省略 `path` 表示根目录 |
| GET | `/api/files/conflict?path=...&relative_path=...` | 上传前检查目标文件是否已存在，避免冲突文件重复传输 |
| POST | `/api/files?path=...&conflict=fail` | multipart 上传；`conflict` 支持 `fail`、`rename`、`overwrite` |
| GET | `/api/files/download?path=...` | 下载单文件，支持字节范围请求 |
| GET | `/api/files/preview?path=...` | 预览文件，支持字节范围请求 |
| POST | `/api/files/archive` | JSON `{ "paths": [...] }`，返回下载地址 `url` 和文件名 `filename` |
| GET | `/api/files/archive/{id}` | 下载生成的 ZIP |
| POST | `/api/files/delete` | JSON `{ "paths": [...] }`，返回 `deleted` 和 `failed` |
| POST | `/api/chat/attachments` | 单个 multipart `file` 字段，返回附件元数据 |
| GET / HEAD | `/api/chat/attachments/{id}/preview` | 安全媒体预览，支持字节范围；其他类型返回 415 |
| GET / HEAD | `/api/chat/attachments/{id}/download` | 使用原文件名下载，支持字节范围 |
| POST | `/api/chat/messages/prepare` | JSON `{ "clientMessageId": "..." }`，返回 `submissionToken` |
| POST | `/api/chat/messages/keepalive` | 续期待发送凭证并保留已上传附件，返回 204 |
| POST | `/api/chat/messages` | 提交文字和附件消息，返回确认并通过 WebSocket 广播 |
| WebSocket | `/api/chat` | 共享对话，连接时发送历史消息 |

上传时先提交 `relative_path` 文本字段，再提交单个 `file` 文件字段；省略 `relative_path` 时使用上传文件名。同名冲突默认返回 `409 Conflict`。

现有聊天客户端仍可通过 WebSocket 发送 `{ "type": "send", "text": "hello" }`；服务端发送 `{ "type": "history", "messages": [...] }` 或 `{ "type": "message", "message": ... }`。每条消息包含 `id`、`text`、以 Unix 毫秒表示的 `timestamp` 及 `attachments` 数组（纯文字消息为空）。

聊天附件每次上传单个 multipart `file`，请求体 **1 GiB** 上限包含 multipart 开销。返回元数据为 `id`、`name`、`size`、`mime`、`previewUrl`（不可预览时为 null）和 `downloadUrl`。ID 与存储路径由服务端生成，文件名仅用于展示和下载；未知或已过期的下载 ID 返回 404。

发送前使用稳定的客户端标识（1–128 位 ASCII 字母、数字、连字符或下划线）调用 `POST /api/chat/messages/prepare`，保留返回的 `submissionToken`，同一草稿重试时复用。记录保留期间，重复准备返回同一凭证。上传期间每分钟及每个文件上传完成后调用 `POST /api/chat/messages/keepalive`：

```json
{ "clientMessageId": "unique-client-id", "submissionToken": "server-issued-token", "attachmentIds": ["uploaded-attachment-id"] }
```

第一个文件传输时可传空附件列表；后续续期包含全部已完成的附件。只有待发送凭证保留附件，已确认消息续期不会延长缓存或文件生命周期。停止续期 10 分钟后释放待发送引用。若缓存中的 1,000 条记录全部处于待发送状态，准备新消息返回 429（`submission_capacity`）；否则可淘汰最早的确认记录以接纳新消息。

通过 `POST /api/chat/messages` 提交完整草稿：

```json
{ "clientMessageId": "unique-client-id", "submissionToken": "server-issued-token", "text": "说明文字", "attachmentIds": ["uploaded-attachment-id"] }
```

接口返回完整消息。在有界的确认窗口内，相同标识、凭证及规范化内容返回原响应，不重复广播；内容不同则返回 409。确认记录不延长已淘汰附件的文件生命周期。未知、过期或已淘汰的凭证返回 410（`submission_expired`），不会重新发布；提交结果不确定时，不应申请新凭证直接重试，应先查看历史再主动开始新消息。附件失效时返回 410，包含 `code: "attachment_unavailable"` 及 `attachmentIds`，需重新上传这些文件后重试。空消息、重复附件 ID 或超过文字及附件数量限制返回 400。客户端应按消息 `id` 对 HTTP 响应及 WebSocket 事件去重。
