# ChattingCursor 快速开始

## 用户只需要做 3 步

**终端 1**（启动 Bridge，端口 4321）：

```powershell
cd e:\my_github\ChattingCursor
pnpm dev:bridge
```

**终端 2**（启动前端，端口 43210）：

```powershell
cd e:\my_github\ChattingCursor
pnpm dev:web
```

**浏览器打开**：

```
http://127.0.0.1:43210/ChattingCursor/
```

确认 Bridge 已在 `4321` 端口运行后即可开始聊天。Bridge URL 在 **本地 → 配置** 中设置（默认 `http://127.0.0.1:4321`）。

如果你要在**手机**上使用 GitHub Pages：

1. 首次运行 `install.bat`，日常运行 `run.bat`（自动启动 Bridge + 隧道，并更新 token 文件中的公网地址）；需要重启时先运行 `shutdown.bat`，再运行 `run.bat`
2. 需要手机读 token 时，可把 `%USERPROFILE%\.chattingcursor` 放进云盘，或在 **本地 → 配置** 改为云盘路径（会写入 `config.json` 持久化）
3. 手机 **本地 → 配置** 填入 token 文件里的 `publicBridgeUrl` 与 `token`

详见 `docs/CLOUDFLARE_TUNNEL_SETUP.md`；背景见 `docs/REMOTE_SETUP.md`。

标题旁有 **聊天 | 本地** 切换：聊天页仅对话 UI；本地模式含 **配置** 与 **CLI输出** 两个子页。

**响应式布局**：Web 端不针对单一分辨率（如 375px）写死断点，而是用 `orientation` / `aspect-ratio` 媒体查询、`dvh`/`clamp()` 等流体单位、聊天面板的 **container queries**，以及安全区 `env(safe-area-inset-*)` 适配各尺寸手机与横竖屏。

在聊天框用自然语言搜索本地历史（近 7 天），例如「帮我找之前关于端口的对话」；Bridge 会自动搜索 `~/.chattingcursor/history/*.txt` 并回复，无需单独按钮。也支持 `/search 关键词`。

**联网搜索（免费，本机 Chrome）：** `run.bat` 会设置 `CURSOR_CLI_MODE=native`（本机 `cursor-agent`，不走 WSL）。需要 Google 搜索时，先用 `--remote-debugging-port=9222` 启动 Chrome，可选在 `%USERPROFILE%\.cursor\mcp.json` 配置 chrome-devtools-mcp 指向 `http://127.0.0.1:9222`（见 `.cursor/mcp.json.example`）。聊天框输入 `/websearch 关键词`、`/google 关键词` 或「网上搜一下…」，Bridge 会在 Chrome 打开 Google 并摘录结果，**不经过 Kimi 付费 API**；勿依赖 Kimi/auto 模型的内置联网。本地历史仍用 `/search` 或「帮我找之前的对话」。

---

## 页面导航（URL）

| 模式 | URL（开发） | 说明 |
|------|-------------|------|
| 聊天 | `http://127.0.0.1:43210/ChattingCursor/` | 默认首页 |
| 本地 · 配置 | `http://127.0.0.1:43210/ChattingCursor/local/config` | Bridge/历史/调度 |
| 本地 · CLI输出 | `http://127.0.0.1:43210/ChattingCursor/local/cli` | Web 查看 CLI 原始输出 |

也可用 hash：`#local/config`、`#local/cli`（首次打开会规范化为 pathname）。

旧链接 `/ChattingCursor/config`、`/ChattingCursor/terminal` 会自动跳转到上述本地子页。

---

## CLI 实时反馈（不在聊天页）

聊天页不嵌入 CLI 输出。可在**本地真实终端**或 **本地 → CLI输出** 查看。

### 方式 A：本地命令（推荐）

在**第三个终端**运行：

```powershell
cd e:\my_github\ChattingCursor
pnpm cli:watch <runId>
```

- 发送聊天消息后，runId 会写入浏览器 `localStorage`（键名 `latestRunId`），也可从 Bridge 日志获取。
- 不填 runId 时会打印用法说明。
- 环境变量：`BRIDGE_URL`（默认 `http://127.0.0.1:4321`）、`RUN_ID`。

### 方式 B：Web CLI 输出（本地模式）

```
http://127.0.0.1:43210/ChattingCursor/local/cli
```

- 标题旁切换到 **本地**，再点 **CLI输出**。
- 自动读取最近一次 runId，或手动输入；也可从 **配置** 子页点击「打开 CLI 输出」。

Bridge 终端 SSE（供 cli:watch / CLI输出页使用）：`GET http://127.0.0.1:4321/chat/terminal/:runId`

---

## 本地模式（配置 + CLI输出）

本地功能不是 Python UI，也不是 Cursor 内置面板，而是 Web 前端的 **本地** 顶层视图，数据来自本机 Bridge API。

### 如何打开

1. 先按上文启动 **Bridge**（`pnpm dev:bridge`）和 **Web**（`pnpm dev:web`）。
2. 打开 `http://127.0.0.1:43210/ChattingCursor/`，点击标题旁 **本地**，再选 **配置** 或 **CLI输出**。

或直接访问：

```
http://127.0.0.1:43210/ChattingCursor/local/config
http://127.0.0.1:43210/ChattingCursor/local/cli
```

### 页面上有什么

| 项目 | 说明 |
|------|------|
| Bridge URL | 与聊天页共用（存于浏览器 `localStorage`） |
| 今日口令 | 当天随机 token，手动输入后用于远程聊天鉴权 |
| 默认模型 | 来自 `cursor-agent models` 或内置回退列表 |
| CLI 命令 | 例如 `wsl cursor-agent`（Windows 经 WSL） |
| 历史目录 | 默认 `~/.chattingcursor/history/` |
| 保留天数 | 7 天，过期文件自动删除 |
| CLI 实时反馈 | 说明 + 切换到 CLI输出 子页 / `pnpm cli:watch` |
| 对话历史列表 | **只读**浏览近 7 天内全部 `*.txt` 会话文件 |

### 对应 Bridge API（仅本机）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/local/config` | Bridge/CLI/历史目录/默认模型 |
| GET | `/auth/status` | 当天 token 文件位置、日期、公开 Bridge 地址 |
| POST | `/auth/verify` | 校验当天 token |
| GET | `/local/history` | 列出全部历史文件 |
| GET | `/local/history/:file` | 读取单个历史文件全文 |

**安全限制**：`/local/*` 仅接受来自 `127.0.0.1` / `localhost` 的请求；前端也要求 Bridge URL 为本机地址。

---

## 已完成的一次性配置（不用再管）

| 项目 | 状态 |
|------|------|
| WSL + Ubuntu | ✓ |
| cursor-agent 安装 | ✓ |
| cursor-agent login | ✓ |

---

## 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| Bridge | **4321** | 本地 API，封装 Cursor CLI |
| Web | **43210** | Vite 开发服务器 |
| Chrome 9222 | **9222** | 联网搜索用；需手动启动 Chrome 远程调试（见上文） |

---

## 常见问题

**Bridge 显示离线？**
- 确认终端 1 中 `pnpm dev:bridge` 正在运行
- 确认 Bridge URL 输入框为正确地址；电脑本机通常是 `http://127.0.0.1:4321`，手机远程则应填写你的公网 Bridge 域名

**手机连不上？**
- 确认公网 Bridge 域名已经能转发到这台电脑
- 确认当天口令已同步到手机可查看的位置
- 确认网页里输入的是当天 token，而不是旧日期的 token

**CLI 不可用？**
- `run.bat` 默认 `CURSOR_CLI_MODE=native`：在 **Windows** 终端运行 `cursor-agent status` 并 `cursor-agent login`
- 若改用 WSL：启动前设置 `$env:CURSOR_CLI_MODE = "wsl"`，再在 WSL 中 `cursor-agent login`

**想看 cursor-agent 原始输出？**
- 聊天页**没有** CLI 面板；请用 `pnpm cli:watch <runId>` 或 **本地 → CLI输出**（`/ChattingCursor/local/cli`）

**首次使用需安装依赖：**

```powershell
cd e:\my_github\ChattingCursor
pnpm install
```
