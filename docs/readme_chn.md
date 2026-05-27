# ChattingCursor 快速开始

本地优先的多 Agent 聊天平台，通过本机 **Cursor CLI** 驱动对话。网页可部署在 GitHub Pages，**Bridge** API 留在你的电脑上；手机访问时使用 Cloudflare 快速隧道。

## 功能概览

- **apps/web** — Vite + React 前端（GitHub Pages 或本地开发）
- **apps/bridge** — Node.js API（封装 `cursor-agent`、鉴权、历史、可选 crew 接口）
- **packages/shared** — 共享类型与 Zod
- **packages/cli-client** — Cursor CLI 封装
- **packages/orchestrator** — 可选 crewAI 编排与环境检查
- **packages/evaluator** — 评估占位

## 快速开始

**最省事（Windows）：** 在仓库根目录双击或运行 `run.bat`，自动启动 Bridge、可选本地 Web、`cloudflared` 快速隧道，并维护同步用的 token 文件。`run.bat` 默认设置 **`CURSOR_CLI_MODE=native`**（本机 `cursor-agent`，不走 WSL）。

**手动开发（两个终端）：**

```powershell
cd e:\my_github\ChattingCursor
pnpm install
pnpm dev:bridge    # http://127.0.0.1:4321
pnpm dev:web       # http://127.0.0.1:43210/ChattingCursor/
```

浏览器打开 Web 地址，进入 **本地 → 配置**，确认 Bridge 端口 **4321** 后即可聊天。

**仅 GitHub Pages（只有 UI）：** https://gostnort.github.io/ChattingCursor/ — 远程使用仍需可访问的 Bridge 地址与当日 token。

英文版同结构说明见根目录 [README.md](../README.md)。

## 端口

| 服务 | 默认 | 说明 |
|------|------|------|
| Bridge | `4321` | `BRIDGE_PORT`、`BRIDGE_HOST` |
| Web 开发 | `43210` | Vite，base `/ChattingCursor/` |
| Chrome 调试（免费联网搜索） | `9222` | Bridge 用 CDP 打开 Google；`/websearch`、网上搜…，不经 Kimi API |

## Token 文件（手机配置）

Bridge 会写入小文本文件（默认 `%USERPROFILE%\.chattingcursor\chattingcursor-token.txt`，或在 **本地 → 配置** 中指定云盘路径）。请放在手机能读到的目录（如云同步文件夹）。

**必须本地配置口令文件的保存位置。要么通过云共享，要么通过自动电子邮件共享（项目并未涵盖）。否则，临时隧道随时塌陷重启，将不能获得更新的隧道和token**

**同步到手机的内容尽量少，可安全共享：**

```text
datetime: 2026-05-27T14:30:00.000Z
token: <32 位当日口令>
publicBridgeUrl: https://xxxx.trycloudflare.com
```

- **不含 salt** — 派生用盐值仅在 PC 的 `~/.chattingcursor/token-meta-*.json`，不在同步文件中。
- **`datetime`** — 上次写入 token 的 ISO 时间（如隧道重连、重新生成）。
- **口令长度** — 32 字符；换盐或重新生成会使旧口令失效。

手机：打开 GitHub Pages → **本地 → 配置** → 粘贴文件中的 `publicBridgeUrl` 与 `token`。

旧文件若仍有 `generatedAt:`、`date:` 或 `salt:`，Bridge 读取时会迁移（salt 迁到本机 meta，文件重写为上述三行）。

## Cloudflare 隧道

`run.bat` / `scripts/run-all.ps1` 使用**临时** `*.trycloudflare.com` 地址，更新 token 文件中的 `publicBridgeUrl`，健康检查失败时自动重启隧道。

- **定期检查：** 每 **5 分钟** `GET {publicBridgeUrl}/health`。
- **注意：** 快速隧道重启后 URL 会变；请从同步文件重新复制到手机。

临时隧道与固定域名的操作差异见 [CLOUDFLARE_TUNNEL_SETUP.md](./CLOUDFLARE_TUNNEL_SETUP.md)。

## 可选：质量监视

```powershell
.\scripts\run-all.ps1 -WithQualityWatch
# 或
pnpm quality:watch
```

后台跑 typecheck/lint 与 crew dry-run，日常聊天不必开。

## 可选：crewAI

Python crew 为可选功能。在 `with-crewai` 等分支上，先 `pnpm crew:setup`，再 `pnpm crew:status` / `pnpm crew:run`。**main** 可能通过 `.gitignore` 不提交 `crewAI/` 参考目录。

**最小示例：**

```powershell
pnpm crew:setup
pnpm crew:run
```

真实执行需 LLM API Key；Bridge：`POST /crews/run`（默认 dry-run）。本地 **配置** 子页可查看 Python / crewai / Chrome 9222 / 示例 YAML 状态。

## 前置条件

- Node.js >= 20，pnpm >= 9
- Windows：`run.bat` 默认 **native** 本机 CLI；可选 WSL（`CURSOR_CLI_MODE=wsl`）
- 已安装并登录 [Cursor CLI](https://cursor.com/docs/cli)（`cursor-agent login`）
- 远程快速隧道需 **cloudflared**（安装脚本可协助）

## 环境变量（Bridge）

| 变量 | 默认 | 用途 |
|------|------|------|
| `BRIDGE_HOST` | `127.0.0.1` | 监听地址 |
| `BRIDGE_PORT` | `4321` | 监听端口 |
| `BRIDGE_PUBLIC_URL` | `http://127.0.0.1:4321` | 对外公布的 Bridge URL |
| `BRIDGE_CORS_ORIGINS` | 见 `.env.example` | 允许的前端来源 |
| `CHATTINGCURSOR_TOKEN_SYNC_DIR` | `~/.chattingcursor` | token 文件目录 |

## 项目结构

```
ChattingCursor/
├── apps/web/           # 前端
├── apps/bridge/        # Bridge API（源码在 src/）
├── packages/shared/
├── packages/cli-client/
├── packages/orchestrator/
├── packages/evaluator/
├── configs/crews/      # Crew YAML 示例（可选）
├── scripts/
└── run.bat
```

### `configs/`（仅 crew）

**`configs/`** 下内容仅供**可选 crewAI**（`configs/crews/*.yaml` 与示例 inputs）。核心聊天（web + bridge + CLI）运行时**不需要**这些文件。

- **GitHub Pages / main 发布：** 静态 UI 不会打包 `configs/`，Pages 上不必带。
- **保留在仓库：** 在 `with-crewai` 分支便于 `pnpm crew:run`、Bridge `/crews/*` 与 `packages/orchestrator` 加载 YAML。

删除前请确认分支是否仍依赖 crew 示例。

### 构建产物 `dist/`（不提交）

仓库根 `.gitignore` 忽略所有 **`dist/`**。Bridge 执行 `pnpm build` 时由 `tsc` 生成 **`apps/bridge/dist/`**（如 `dist/index.js`），与 monorepo 内其它包的 `dist` 一样，**仅本地生成**。

- **开发：** `pnpm dev:bridge` 用 `tsx` 直接跑 `src/`，无需提交 dist。
- **类生产启动：** 先 `pnpm build`，再 `node apps/bridge/dist/index.js`（或包内 `start`）。

除非项目约定变更，否则不要提交 `dist/`；克隆后按需 `pnpm build`。

## 本地模式与页面（补充）

标题旁 **聊天 | 本地**：本地模式含 **配置** 与 **CLI输出**。URL 示例：

| 模式 | 开发 URL |
|------|----------|
| 聊天 | `http://127.0.0.1:43210/ChattingCursor/` |
| 本地 · 配置 | `.../local/config` |
| 本地 · CLI输出 | `.../local/cli` |

`/local/*` 仅接受本机请求。CLI 实时输出：`pnpm cli:watch <runId>` 或 **本地 → CLI输出**。

## 常见问题

**Bridge 离线？** 确认 `pnpm dev:bridge` 在跑，且配置里 Bridge URL 正确（本机 `http://127.0.0.1:4321`，手机填公网地址）。

**手机连不上？** 确认隧道/Bridge 可达、**当日** token 已从同步文件复制、公网 URL 与文件一致。

**CLI 不可用？** WSL 中 `cursor-agent status`；未登录则 `cursor-agent login`。

**crewAI 未安装？** 运行 `pnpm crew:setup`。

**首次依赖：**

```powershell
cd e:\my_github\ChattingCursor
pnpm install
```
