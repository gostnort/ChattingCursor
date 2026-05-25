# ChattingCursor 快速开始

## 用户只需要做 3 步

**终端 1**（启动 Bridge，端口 3000）：

```powershell
cd e:\my_github\ChattingCursor
pnpm dev:bridge
```

**终端 2**（启动前端，端口 5173）：

```powershell
cd e:\my_github\ChattingCursor
pnpm dev:web
```

**浏览器打开**：

```
http://127.0.0.1:5173/ChattingCursor/
```

确认页面顶部 Bridge URL 为 `http://127.0.0.1:3000`，状态栏显示 **Bridge: 在线 · CLI: 可用**，即可开始聊天。

聊天区下方会显示 **CLI 终端（原始输出）**，实时展示 `cursor-agent` 子进程的真实 stdout/stderr（非解析后的 SSE 事件）。Bridge 还提供终端专用 SSE：`GET http://127.0.0.1:3000/chat/terminal/:runId`。

在聊天框用自然语言搜索本地历史（近 7 天），例如「帮我找之前关于端口的对话」；Bridge 会自动搜索 `~/.chattingcursor/history/*.txt` 并回复，无需单独按钮。也支持 `/search 关键词`。

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
| Bridge | **3000** | 本地 API，封装 Cursor CLI（**不是 8787**，Hyper-V 占用了 8710–8809） |
| Web | **5173** | Vite 开发服务器 |
| 9222 | — | Chrome MCP 调试端口，**用户不需要手动配置** |

---

## 常见问题

**Bridge 显示离线？**
- 确认终端 1 中 `pnpm dev:bridge` 正在运行
- 确认 Bridge URL 输入框为 `http://127.0.0.1:3000`（若之前用过 8787，请手动改回 3000）

**CLI 不可用？**
- 在 WSL 中运行 `cursor-agent status`，确认已登录
- 若未登录：`cursor-agent login`

**首次使用需安装依赖：**

```powershell
cd e:\my_github\ChattingCursor
pnpm install
```
