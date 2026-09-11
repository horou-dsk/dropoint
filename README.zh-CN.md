# Dropoint

[English](README.md) | **中文**

Dropoint 是一个局域网文件共享与文本传递工具。启动时绑定一个本地目录，即可在浏览器中浏览、预览、上传和下载文件，并通过共享对话在多台设备之间传递文字。

## 功能

- **文件工作台**：支持图标和列表视图，默认使用图标视图，自动保存视图偏好。支持名称、修改时间和大小排序，文件夹始终排在文件前面。
- **目录浏览与预览**：双击进入文件夹或打开预览弹窗；支持文本、图片和浏览器可播放的视频，其他类型可直接下载。目录导航接入浏览器历史，支持鼠标后退、前进键。
- **多选与右键菜单**：支持 Ctrl/Cmd 多选、Shift 连选，通过右键菜单或工具栏执行下载和删除。
- **批量下载**：单个文件直接下载；文件夹或多个项目合并为 ZIP，保留目录层级、中文文件名和空目录。
- **拖拽上传**：支持拖入多个文件或文件夹，上传到当前浏览目录。同名冲突时可选择自动重命名、覆盖或取消。
- **共享对话**：通过 WebSocket 同步文本，提供连接状态、自动重连和单条消息复制；服务端保留最近 200 条消息，重启后清空。
- **外观与布局**：默认跟随系统亮色或深色模式，手动切换后保存选择。文件与聊天面板独立滚动，窄屏可切换工作面板。

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 后端 | Rust 2024、Axum、Tokio、Serde、zip 8 |
| 前端 | Vite 8、React、TypeScript、Tailwind CSS v4 |
| 测试 | Rust 内置测试框架、Vitest、Testing Library、jsdom |
| 包管理 | Cargo、pnpm workspace |

## 快速开始

### 环境准备

- 最新稳定版 [Rust 与 Cargo](https://rustup.rs/)。
- 推荐使用 [Node.js 24 LTS](https://nodejs.org/)。
- pnpm **11.9.0**，与根目录 `package.json` 的 `packageManager` 一致。可使用 `npm install -g pnpm@11.9.0` 安装。

### 启动前后端

在仓库根目录执行：

```sh
pnpm install
pnpm dev
```

打开 [http://localhost:5173](http://localhost:5173)。此命令同时启动 Axum 和 Vite，默认共享运行 `cargo run` 时的当前工作目录；从仓库根目录启动时，共享的就是仓库目录。

| 服务 | 默认监听地址 | 用途 |
| --- | --- | --- |
| Vite | `0.0.0.0:5173` | 网页及 `/api` HTTP/WebSocket 代理 |
| Axum | `0.0.0.0:3000` | 文件 API 与共享对话 |

同一局域网的其他设备访问 `http://<运行主机的局域网 IP>:5173`。使用 Vite 启动日志中的 Network 地址；若端口被占用，以实际输出地址为准。连接失败时，检查设备是否位于同一网络，以及防火墙是否允许前端端口访问。

### 指定共享目录

在仓库根目录打开两个终端，分别启动后端和前端。目标目录必须已存在：

```sh
# 终端 1：启动后端，指定共享目录
cargo run -- /path/to/share
```

Windows 示例：

```powershell
cargo run -- "D:\Shared Files"
```

```sh
# 终端 2：启动前端
pnpm --dir web dev
```

这两个命令替代 `pnpm dev`。省略目录参数时使用当前工作目录；指定相对路径时，也以当前工作目录为基准。

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
| 聊天中 Enter / Shift + Enter | 发送文本 / 换行 |

多选仅限当前目录。切换视图和排序保留选区，进入其他目录会清空选区；刷新会移除已不存在的选中项。右键已选项目时保留整个选区。

文件列表通过刷新按钮重新读取；聊天文本实时广播。主题和视图偏好保存在当前浏览器中，不会跨设备同步。当前网页界面使用中文。

## 使用限制

- 当前没有登录、访问控制或 TLS 配置。能够访问服务的设备可以读取、上传、覆盖及删除共享目录中的内容，请在可信局域网中使用，并选择合适的共享目录。
- 删除需要弹窗确认，属于**永久删除**，不会进入回收站。文件夹及其内容一并删除；部分失败会显示结果，已完成的删除不会回滚。
- 每次上传请求的请求体上限为 **1 GiB**，包含 multipart 开销；前端逐个上传文件。文件夹拖拽依赖浏览器支持，视频预览依赖浏览器支持相应编码。
- ZIP 在共享目录外的系统临时目录中生成，需要足够的临时磁盘空间。下载地址有效期为 **10 分钟**；已开始的下载可继续完成。若系统临时目录位于共享目录内，打包请求会被拒绝。
- ZIP 打包遇到符号链接或 Windows junction 会报错。删除链接时仅移除链接本身，不删除链接目标；批量操作不允许通过链接进入子目录。
- 聊天记录仅保存在进程内存中，单条文本最多 **10,000 个字符**；服务重启后历史记录清空。

## 开发与构建

```sh
cargo fmt --all -- --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
pnpm --dir web test
```

生成构建产物：

```sh
cargo build --release
pnpm --dir web build
```

后端二进制位于 `target/release/`，前端产物位于 `web/dist/`。当前 Rust 服务只提供 API，不内嵌或托管前端静态文件；生产运行需要另外配置静态文件服务及 `/api` HTTP/WebSocket 代理。

Windows 下若运行中的程序锁定测试构建产物，可使用 `cargo test --target-dir target/verification`。

## 项目结构

```text
dropoint/
├── src/
│   ├── main.rs          # 目录参数与服务启动
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
| POST | `/api/files?path=...&conflict=fail` | multipart 上传；`conflict` 支持 `fail`、`rename`、`overwrite` |
| GET | `/api/files/download?path=...` | 下载单文件，支持字节范围请求 |
| GET | `/api/files/preview?path=...` | 预览文件，支持字节范围请求 |
| POST | `/api/files/archive` | JSON `{ "paths": [...] }`，返回下载地址 `url` 和文件名 `filename` |
| GET | `/api/files/archive/{id}` | 下载生成的 ZIP |
| POST | `/api/files/delete` | JSON `{ "paths": [...] }`，返回 `deleted` 和 `failed` |
| WebSocket | `/api/chat` | 共享对话，连接时发送历史消息 |

上传时先提交 `relative_path` 文本字段，再提交单个 `file` 文件字段；省略 `relative_path` 时使用上传文件名。同名冲突默认返回 `409 Conflict`。

聊天客户端发送 `{ "type": "send", "text": "hello" }`；服务端发送 `{ "type": "history", "messages": [...] }` 或 `{ "type": "message", "message": ... }`。每条消息包含 `id`、`text` 和以 Unix 毫秒表示的 `timestamp`。
