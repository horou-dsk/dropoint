# Repository Guidelines

## 项目结构与模块组织

本仓库是名为 `dropoint` 的全栈项目，后端使用 Rust，前端使用 Web 技术。

- `src/main.rs`：Rust 后端启动入口；`src/cli.rs`：共享目录、`--port` / `-p` 参数解析。
- `src/app.rs`、`src/state.rs`：Axum 路由组合和共享应用状态。
- `src/routes/`：健康检查、文件浏览/上传/下载/预览和 WebSocket 聊天路由。
- `Cargo.toml`：后端包元数据、Rust 版本和依赖配置。
- `Cargo.lock`：锁定依赖版本；这是应用项目，应提交到 Git。
- `web/`：Web 前端独立目录，包含 `package.json`、前端源码、静态资源和前端测试。
- `web/src/App.tsx`：文件工作台和聊天界面；`web/src/lib/api.ts`：前后端 API 类型与调用。
- `target/`：构建生成物，已由 Git 忽略。

代码扩展后，将可复用后端模块放在 `src/` 下，并让 `main.rs` 主要负责启动和流程编排。模块默认使用“文件夹同名 `.rs` 文件”布局，例如 `src/parser.rs` 对应 `src/parser/`；除非有明确兼容性或组织需求，不要使用文件夹内的 `mod.rs`。前端代码只放在 `web/`，不要把前端依赖或构建产物混入 Rust 目录。单元测试可使用 `#[cfg(test)]` 放在实现文件旁；后端集成测试放入 `tests/`，前端测试放在 `web/` 的既有测试目录中。

## 前后端边界

后端负责业务规则、数据访问、认证和 API；前端负责页面、交互和展示状态。通过明确版本化的 HTTP API 或 WebSocket 协议通信，接口请求和响应模型应有稳定定义。涉及接口变化时，同时更新后端处理、前端调用和必要的文档或测试。

## 构建、测试与开发命令

以下命令均在仓库根目录执行：

Rust 的 debug/release 构建均嵌入 `web/dist/`；首次运行 Cargo 前先执行 `pnpm install --frozen-lockfile` 和 `pnpm --dir web build`，前端修改后需重新构建前端再编译 Rust。发布流水线 `.github/workflows/release.yml` 自动按此顺序构建。

- `cargo run`：构建并在本地运行应用。
- `cargo check`：快速检查编译，不生成可运行的二进制文件。
- `cargo build`：生成调试构建；发布构建使用 `cargo build --release`。
- `cargo test`：编译并运行单元测试和集成测试。
- `cargo fmt --all -- --check`：检查代码格式；使用 `cargo fmt --all` 自动格式化。
- `cargo clippy --all-targets --all-features -- -D warnings`：检查常见 Rust 问题，并将警告视为错误。
- `pnpm install`：安装根目录和 `web/` 的前端依赖。
- `pnpm dev`：同时启动 Axum 后端和 Vite 前端，显式使用后端端口 `3000` 与开发代理匹配。
- `pnpm --dir web dev`：只启动前端开发服务器。
- `pnpm --dir web test`：运行前端测试；`pnpm --dir web build`：生成生产构建。
- `cargo run -- /path/to/share`：指定要共享的目录；省略参数时使用当前目录。
- `cargo run -- /path/to/share --port 8080`：指定后端端口；省略 `--port` 或设置为 `0` 时由操作系统分配空闲端口，启动日志输出实际端口。单独启动 Vite 时可通过 `DROPOINT_API_PORT` 环境变量指定后端代理端口，默认 `3000`。

## 编码风格与命名约定

使用稳定版 Rust、`rustfmt` 默认规则和四空格缩进。遵循 Rust 命名规范：函数、变量和模块使用 `snake_case`；类型和 trait 使用 `UpperCamelCase`；常量使用 `SCREAMING_SNAKE_CASE`。函数应保持简短并使用明确的类型；对于可恢复错误，优先通过 `Result` 传递，避免使用 panic。避免无意义的 `clone`：优先借用、传递引用、移动所有权或调整数据结构；只有在确实需要独立所有权或满足生命周期要求时才克隆，并在代码评审中说明原因。

前端使用 TypeScript、Vite 和 Tailwind CSS v4；组件使用 `PascalCase`，函数和变量使用 `camelCase`。优先使用 Tailwind utility class，只有全局基础样式或确有复用价值时才写 CSS。

文件 API 必须始终把用户传入的路径限制在启动时绑定的根目录内；新增文件操作时要覆盖路径穿越、符号链接越界和同名文件场景。聊天消息通过 WebSocket 广播，消息状态只保存在进程内，不要假设服务重启后仍然存在。

文件多选限定当前目录；列表和图标视图共享选择状态。右键操作使用打开菜单时的目标快照，删除必须经确认弹窗。`POST /api/files/archive` 接收 `paths` 数组，返回 ZIP 下载地址和文件名；临时归档位于共享目录外，地址有效期为 10 分钟。归档不跟随符号链接或 junction；`POST /api/files/delete` 永久删除所选项目并返回 `deleted`、`failed`，移除链接时不能删除链接目标。批量操作先校验全部路径，再执行；目录删除失败可能已删除部分内容，不承诺回滚。

## 测试指南

使用 Rust 内置测试框架。测试名称应描述被验证的行为，例如 `rejects_empty_input`。本地运行 `cargo test`，并为缺陷修复和新的外部可见行为补充回归测试。

## 提交与合并请求指南

当前仓库还没有提交历史，因此尚未形成项目专属规范。建议使用简洁的祈使句，并遵循 `type(scope): summary` 格式，例如 `feat(parser): validate input`。合并请求应说明行为变化、列出已执行的验证命令、关联相关 issue；如果用户可见行为发生变化，还应附上截图或示例输出。
