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

1. 电脑继续运行 `pnpm dev:bridge`
2. 给 Bridge 配一个公网地址（例如 tunnel 域名）
3. 在手机打开 GitHub Pages 后，到 **本地 → 配置** 填入：
   - `Bridge URL`
   - 当天口令（从同步文件查看）

完整远程配置见 `docs/REMOTE_SETUP.md`。

标题旁有 **聊天 | 本地** 切换：聊天页仅对话 UI；本地模式含 **配置** 与 **CLI输出** 两个子页。

**响应式布局**：Web 端不针对单一分辨率（如 375px）写死断点，而是用 `orientation` / `aspect-ratio` 媒体查询、`dvh`/`clamp()` 等流体单位、聊天面板的 **container queries**，以及安全区 `env(safe-area-inset-*)` 适配各尺寸手机与横竖屏。

在聊天框用自然语言搜索本地历史（近 7 天），例如「帮我找之前关于端口的对话」；Bridge 会自动搜索 `~/.chattingcursor/history/*.txt` 并回复，无需单独按钮。也支持 `/search 关键词`。

---

## 页面导航（URL）

| 模式 | URL（开发） | 说明 |
|------|-------------|------|
| 聊天 | `http://127.0.0.1:43210/ChattingCursor/` | 默认首页 |
| 本地 · 配置 | `http://127.0.0.1:43210/ChattingCursor/local/config` | Bridge/历史/crewAI |
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
| crewAI 编排 | Python / crewAI / Chrome 9222 状态、示例 YAML 是否可 dry-run |
| 对话历史列表 | **只读**浏览近 7 天内全部 `*.txt` 会话文件 |

### 对应 Bridge API（仅本机）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/local/config` | Bridge/CLI/历史目录/默认模型 |
| GET | `/auth/status` | 当天 token 文件位置、日期、公开 Bridge 地址 |
| POST | `/auth/verify` | 校验当天 token |
| GET | `/local/history` | 列出全部历史文件 |
| GET | `/local/history/:file` | 读取单个历史文件全文 |
| GET | `/crews/status` | crewAI / Python / Chrome 9222 / 示例配置状态 |
| POST | `/crews/run` | 运行 crew（默认 dry-run） |

**安全限制**：`/local/*` 仅接受来自 `127.0.0.1` / `localhost` 的请求；前端也要求 Bridge URL 为本机地址。

---

## crewAI 最小配置（with-crewai 分支）

当前为 **最小可运行集成**，非完整多 Agent 产品化：

1. **依赖**（一次性）：

```powershell
cd e:\my_github\ChattingCursor
pnpm crew:setup
```

或手动：`python -m venv .venv` 后 `pip install -r requirements.txt`

2. **Dry-run 示例**（不调用 LLM，校验 `configs/crews/example.yaml`）：

```powershell
pnpm crew:run
```

3. **Bridge API**：

```powershell
curl -X POST http://127.0.0.1:4321/crews/run -H "Content-Type: application/json" -d "{\"crew\":\"example\",\"inputs\":{\"repo_root\":\"E:\\\\my_github\\\\ChattingCursor\",\"local_url\":\"http://127.0.0.1:43210/ChattingCursor/\",\"pages_url\":\"https://gostnort.github.io/ChattingCursor/\",\"acceptance_criteria\":\"页面能恢复历史对话\"},\"dryRun\":true}"
```

4. **真实执行**（需 LLM API Key，如 `OPENAI_API_KEY`）：`dryRun: false` 或 `python scripts/run-crew.py --config configs/crews/example.yaml --execute`

5. **编排层**：`packages/orchestrator` 加载 YAML 并调用 `scripts/run-crew.py`；完整 Chat 流程接入 crew 仍在后续阶段。

本地 **配置** 子页会显示 crewAI 状态（Python 是否可用、crewai 是否安装、Chrome 9222 是否连通、example.yaml 是否有效）。

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
| 9222 | — | Chrome MCP 调试端口，**用户不需要手动配置** |

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
- 在 WSL 中运行 `cursor-agent status`，确认已登录
- 若未登录：`cursor-agent login`

**想看 cursor-agent 原始输出？**
- 聊天页**没有** CLI 面板；请用 `pnpm cli:watch <runId>` 或 **本地 → CLI输出**（`/ChattingCursor/local/cli`）

**crewAI 显示未安装？**
- 运行 `pnpm crew:setup` 或 `pip install -r requirements.txt`

**首次使用需安装依赖：**

```powershell
cd e:\my_github\ChattingCursor
pnpm install
```
