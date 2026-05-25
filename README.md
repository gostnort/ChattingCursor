# ChattingCursor

Local-first 的多 Agent 聊天与测试平台：前端部署在 GitHub Pages，后端 Bridge 在用户本机运行，通过 **Cursor CLI** 与 Agent 通信。

## 快速开始

详见 **[docs/QUICKSTART.md](docs/QUICKSTART.md)**。

**用户只需要做 3 步：**

1. 终端 1：`cd e:\my_github\ChattingCursor && pnpm dev:bridge`
2. 终端 2：`pnpm dev:web`
3. 浏览器打开：`http://127.0.0.1:5173/ChattingCursor/`

确认 Bridge URL 为 `http://127.0.0.1:3000`，状态栏显示 CLI 可用后即可聊天。

## 架构概览

- **apps/web**：Vite + React 静态前端，部署到 GitHub Pages（base: `/ChattingCursor/`）
- **apps/bridge**：本地 Node.js 服务（默认 `http://127.0.0.1:3000`），封装 Cursor CLI 子进程
- **packages/cli-client**：CLI 包装层（v1）；`@cursor/sdk` 计划在 v2 引入
- **packages/shared**：共享类型与 Zod schema
- **packages/orchestrator / evaluator**：占位包，后续阶段实现

## 前置条件

- Node.js >= 20
- pnpm >= 9
- WSL + Ubuntu（Windows 用户）
- 已安装 [Cursor CLI](https://cursor.com/docs/cli)（`cursor-agent` 可用）
- 已登录 Cursor CLI（`cursor-agent login`）

## 本地开发

```powershell
# 首次：安装依赖
pnpm install

# 终端 1：启动 Bridge（端口 3000）
pnpm dev:bridge

# 终端 2：启动前端（端口 5173）
pnpm dev:web
```

浏览器打开 `http://127.0.0.1:5173/ChattingCursor/`，确认 Bridge URL 为 `http://127.0.0.1:3000` 后即可聊天。

- **CLI 原始终端**：页面下方「CLI 终端（原始输出）」展示 `cursor-agent` 子进程 stdout/stderr；API：`GET /chat/terminal/:runId`（SSE）
- **对话内历史搜索**：在聊天框输入如「帮我找之前关于端口的对话」，Bridge 搜索 `~/.chattingcursor/history/`（保留 7 天）并直接回复

Windows 一键启动（会打开两个新终端窗口）：

```powershell
.\scripts\dev.ps1
```

### 环境变量（Bridge）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BRIDGE_HOST` | `127.0.0.1` | 监听地址 |
| `BRIDGE_PORT` | `3000` | 监听端口（避免 Hyper-V 保留的 8710–8809 段） |
| `BRIDGE_CORS_ORIGINS` | 见 `.env.example` | 允许的前端来源 |

## GitHub Pages 部署

前端通过 `.github/workflows/deploy-pages.yml` 自动构建并发布到 `gh-pages` 分支。

**注意**：Pages 仅托管静态 UI；用户仍需在本机运行 Bridge 才能实际聊天。

## crewAI 分支策略

- **main 分支**：`.gitignore` 排除 `crewAI/`，不提交参考代码
- **dev 等开发分支**：可移除 `.gitignore` 中的 `crewAI/` 规则，保留本地 clone 作多 Agent 架构参考

详见 [docs/branch-strategy.md](docs/branch-strategy.md)。

## 项目结构

```
ChattingCursor/
├── apps/
│   ├── web/              # 前端
│   └── bridge/           # 本地 Bridge API
├── packages/
│   ├── shared/
│   ├── cli-client/       # Cursor CLI 包装（v1）
│   ├── orchestrator/     # Phase 3
│   └── evaluator/        # Phase 4
├── configs/crews/        # Crew YAML 示例
└── .github/workflows/
```

## 路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 0 | Monorepo 脚手架 | 完成 |
| Phase 1 | CLI 聊天 MVP（send + SSE + UI） | 进行中 |
| Phase 2 | GH Pages 部署验证 | 部分完成（workflow 已加） |
| Phase 3 | 多 Agent 编排 | 未开始 |
| Phase 4 | 测试与评估 | 未开始 |
| v2 | `@cursor/sdk` 替代/并存 CLI | 未开始 |

## 许可证

MIT
