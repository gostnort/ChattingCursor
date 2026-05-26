# ChattingCursor

支持“本机开发”与“手机远程访问”两种模式的多 Agent 聊天与测试平台：前端部署在 GitHub Pages，后端 Bridge 在用户电脑上运行，通过 **Cursor CLI** 与 Agent 通信。

## 快速开始

详见 **[docs/QUICKSTART.md](docs/QUICKSTART.md)**。

**用户只需要做 3 步：**

1. 终端 1：`cd e:\my_github\ChattingCursor && pnpm dev:bridge`
2. 终端 2：`pnpm dev:web`
3. 浏览器打开：`http://127.0.0.1:43210/ChattingCursor/`

确认 Bridge 端口为 `4321`（可在 **本地 → 配置** 修改）后即可聊天。

在线版（GitHub Pages）：https://gostnort.github.io/ChattingCursor/ — 仅托管前端 UI。若要在手机上使用，需要把电脑上的 Bridge 暴露到一个公网域名，再在网页中填写对应 `Bridge URL` 和当天口令。

## 架构概览

- **apps/web**：Vite + React 静态前端，部署到 GitHub Pages（base: `/ChattingCursor/`）
- **apps/bridge**：本地 Node.js 服务（默认 `http://127.0.0.1:4321`），封装 Cursor CLI 子进程；可配合 tunnel 暴露为远程 Bridge
- **packages/cli-client**：CLI 包装层（v1）；`@cursor/sdk` 计划在 v2 引入
- **packages/shared**：共享类型与 Zod schema
- **packages/orchestrator**：crewAI 编排与环境探测
- **packages/evaluator**：评估占位包

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

# 终端 1：启动 Bridge（端口 4321）
pnpm dev:bridge

# 终端 2：启动前端（端口 43210）
pnpm dev:web
```

浏览器打开 `http://127.0.0.1:43210/ChattingCursor/`，在 **本地 → 配置** 可修改 Bridge 端口（默认 4321）与查看历史文件，确认 CLI 可用后即可聊天。

- **CLI 原始终端**：聊天页不展示 CLI 输出；请在 **本地 → CLI输出** 或单独终端运行 `pnpm cli:watch <runId>` 查看。底层 API：`GET /chat/terminal/:runId`（SSE）
- **对话内历史搜索**：在聊天框输入如「帮我找之前关于端口的对话」，Bridge 搜索 `~/.chattingcursor/history/`（保留 7 天）并直接回复
- **历史恢复**：刷新页面后会从浏览器 `localStorage` 恢复消息、会话 ID 与已选模型
- **远程访问口令**：Bridge 每天生成一个随机 token，写入本地同步目录文件；手机从云盘查看当天 token 后输入网页完成连接

Windows 一键启动（会打开两个新终端窗口）：

```powershell
.\scripts\dev.ps1
```

远程模式启动 Bridge（会带上公开地址与 token 同步目录）：

```powershell
.\scripts\start-remote.ps1 -BridgePublicUrl "https://bridge.example.com" -TokenSyncDir "D:\YourSyncFolder\ChattingCursor"
```

### 环境变量（Bridge）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BRIDGE_HOST` | `127.0.0.1` | 监听地址 |
| `BRIDGE_PORT` | `4321` | 监听端口（避开 Hyper-V 保留段） |
| `BRIDGE_PUBLIC_URL` | `http://127.0.0.1:4321` | 对手机公开的 Bridge 地址 |
| `BRIDGE_CORS_ORIGINS` | 见 `.env.example` | 允许的前端来源 |
| `CHATTINGCURSOR_TOKEN_SYNC_DIR` | 空 | 每日 token 文件写入目录 |

## GitHub Pages 部署

前端通过 `.github/workflows/deploy-pages.yml` 在 **main** 分支 push 时自动构建并发布。

- **在线地址**：https://gostnort.github.io/ChattingCursor/
- **Vite base**：`/ChattingCursor/`（见 `apps/web/vite.config.ts`）

**注意**：Pages 仅托管静态 UI；真正处理聊天的是你电脑上的 Bridge。若要在手机上使用，需要额外配置一个 tunnel 或公网反代，把 Bridge 暴露为远程 URL。详见 `docs/REMOTE_SETUP.md`。

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

## Chrome 联网搜索（非 Kimi 模型）

仅 Kimi 可通过 API 联网搜索。其他模型在对话里提到「搜索网页」「网上查」「核实」等时，Bridge 会检测意图并在本机 Chrome（远程调试 **9222**）打开 Google 搜索页。

**启动 Chrome（Windows 示例）：**

```text
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

可选环境变量：`CHROME_DEBUG_ENDPOINT`（默认 `http://127.0.0.1:9222`）。

**触发示例：** `/websearch React 19`、`/google 天气`、「帮我在网上搜一下…」、「核实一下这个说法」。

本地聊天历史仍用 `/search …` 或带「历史/聊天记录」的表述，不会走 Google。

## 路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 0 | Monorepo 脚手架 | 完成 |
| Phase 1 | CLI 聊天 MVP（send + SSE + UI） | 进行中 |
| Phase 2 | GH Pages 部署验证 | 部分完成（workflow 已加） |
| Phase 3 | crewAI 最小编排（状态探测 + dry-run + Chrome 9222 校验） | 已开始 |
| Phase 4 | 测试与评估 | 未开始 |
| v2 | `@cursor/sdk` 替代/并存 CLI | 未开始 |

## 许可证

MIT
