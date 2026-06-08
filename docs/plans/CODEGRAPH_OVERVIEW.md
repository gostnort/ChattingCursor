# CodeGraph 使用指南与项目分析快照

> 快照日期：**2026-06-08** · 分支：**`tts_upgrade`** · 索引规模：**328 文件 / 2270 函数**

## 在 Cursor 里如何看到 CodeGraph 分析

CodeGraph **没有独立可视化面板**；分析结果通过 **MCP 工具**在 Agent 对话中调用后返回（文本 / JSON / Markdown）。

### 1. 启用 MCP 服务

在项目或用户目录配置 `.cursor/mcp.json`，加入 `codegraph`（或 `project-0-ChattingCursor-codegraph`）服务器条目。工具描述符位于 Cursor 项目缓存：

`mcps/project-0-ChattingCursor-codegraph/tools/`

配置完成后重启 Cursor 或重载 MCP。

### 2. 确认服务状态

打开 **Cursor Settings → MCP**，查看 codegraph 服务器是否为 **Connected / 绿色**。若失败：

- 查看 **Output** 面板中与 MCP 相关的通道（错误日志通常在此）
- 检查 `.cursor/mcp.json` 路径、命令与工作区根目录是否指向 `E:\my_github\ChattingCursor`

### 3. 在对话中使用

在 Agent 聊天中直接请求，例如：

- 「用 `codegraph_find_entry_points` 列出 HTTP 入口」
- 「用 `codegraph_generate_architecture_doc` 刷新架构文档」
- 「用 `codegraph_pr_context` 对比 main 分支」

Agent 会读取 `mcps/.../tools/*.json` 中的 schema 后调用对应工具。**用户本人不手动点选工具**；通过自然语言委托 Agent 即可。

### 4. 持久化文档（推荐）

MCP 返回的是即时分析；若要团队共享或离线阅读，应将结果写入 `docs/`（如本文档与 [ARCHITECTURE.md](./ARCHITECTURE.md)）。生成后可用 `codegraph_index_markdown` 索引 Markdown，供后续 `codegraph_verify_design` 做漂移检测。

---

## 常用 CodeGraph 工具

| 工具 | 用途 |
|------|------|
| `codegraph_reindex_workspace` | 全量重建代码图（大改后首先执行） |
| `codegraph_generate_architecture_doc` | 生成架构 Markdown（模块、热路径、循环依赖） |
| `codegraph_find_entry_points` | 发现 main、HTTP handler、CLI 入口 |
| `codegraph_get_module_summary` | 单目录统计与复杂度 Top N |
| `codegraph_pr_context` | 当前分支相对 base 的爆炸半径与测试缺口 |
| `codegraph_find_hot_paths` | 调用链热路径 |
| `codegraph_find_circular_deps` | 循环依赖检测 |

**路径格式注意：** `codegraph_get_module_summary` 的 `path` 需与索引一致，使用 Windows 反斜杠绝对路径，例如 `e:\my_github\ChattingCursor\apps\bridge\src`。使用 `E:/...` 可能导致空结果。

---

## 项目分析快照（2026-06-08）

### 全局统计

| 指标 | 数值 |
|------|------|
| 文件数 | 328 |
| 函数数 | 2270 |
| 类数 | 249 |
| 语言 | TypeScript 149、Python 112、YAML 49、Bash 16、CSS 1、TOML 1 |
| 模块数（目录聚合） | 30 |
| 循环依赖 | 0 |

### 模块摘要

#### `apps/bridge/src`

| 指标 | 数值 |
|------|------|
| 文件 | 102 |
| 函数 | 733 |
| 类 | 38 |
| 代码行（估算） | 16605 |

复杂度 Top 8：

1. `openGoogleSearchInChrome` — `services/chrome-google-search.ts` (43)
2. `buildPartialWebSearchResult` — `services/chrome-google-search.ts` (25)
3. `getLocalLlmHealthStatus` — `services/local-llm-lifecycle.ts` (21)
4. `runExternalDataPipeline` — `services/external-data-pipeline.ts` (19)
5. `parseSidecarHealthBody` — `services/local-llm-lifecycle.ts` (19)
6. `parseGoogleSerpEvaluateValue` — `services/google-serp-parse.ts` (18)
7. `completeLocalLlmChatLocal` — `services/local-llm-client.ts` (18)
8. `spawnPilotTtsWebui` — `services/pilot-tts-webui-spawn.ts` (16)

子目录：`routes/`（12 文件，43 函数）、`services/`（85 文件，659 函数）、`middleware/`（1 文件）。

#### `apps/web/src`

| 指标 | 数值 |
|------|------|
| 文件 | 34（33 TS + 1 CSS） |
| 函数 | 368 |
| 类 | 23 |
| 代码行（估算） | 10609 |

复杂度 Top 8：

1. `ConfigSubPage` — `components/ConfigSubPage.tsx` (52)
2. `TtsSubPage` — `components/TtsSubPage.tsx` (52)
3. `ChatPanel` — `components/ChatPanel.tsx` (35)
4. `LocalModelsSubPage` — `components/LocalModelsSubPage.tsx` (28)
5. `MessageBubble` — `components/MessageBubble.tsx` (20)
6. `LocalView` — `components/LocalView.tsx` (17)
7. `shortenModelLabel` — `components/ChatPanel.tsx` (15)
8. `formatBridgeFetchError` — `bridgeSettings.ts` (14)

`api/bridge.ts` 含 63 个函数，是前端调用 Bridge 的集中出口。

#### `pilot_tts`（含 upstream）

| 指标 | 数值 |
|------|------|
| 文件 | 154 |
| 函数 | 935 |
| 类 | 180 |
| 代码行（估算） | 20022 |

**项目集成入口**（优先阅读）：

- `pilot_tts/server/tts_server.py` — `GET /health`、`POST /v1/load`、`POST /v1/synthesize`
- `pilot_tts/install.py` — 安装脚本

上游复杂度热点（一般无需改动）：

1. `inference_bistream` — `upstream/.../cosyvoice/llm/llm.py` (31)
2. `padding` — `upstream/.../cosyvoice/dataset/processor.py` (26)
3. `init_optimizer_and_scheduler` — `upstream/.../cosyvoice/utils/train_utils.py` (25)

### 入口点摘要

CodeGraph 识别的关键入口（`codegraph_find_entry_points`，节选）：

| 类型 | 名称 | 位置 |
|------|------|------|
| main | `main` | `apps/bridge/src/index.ts` — Bridge 启动 |
| main | `main` | `local_llm/server/llm_server.py` |
| main | `main` | `local_vlm/server/vlm_server.py` |
| main | `main` | `pilot_tts/server/tts_server.py` |
| http_handler | `chat_completions` | `POST /v1/chat/completions` — LLM |
| http_handler | `create_embeddings` | `POST /v1/embeddings` — VLM |
| http_handler | `synthesize` | `POST /v1/synthesize` — TTS |
| http_handler | `health` | 各 sidecar `GET /health` 或 `/v1/health` |
| cli_command | `runCursorCli` | `packages/cli-client/src/cursor-cli.ts` |
| cli_command | `scheduleCursorCliRun` | `apps/bridge/src/routes/chat.ts` |

完整列表可在 Agent 对话中请求 `codegraph_find_entry_points`（`limit: 50`）。

### 调用热路径（Top 15）

| 函数 | 文件 | 直接调用方 | 传递调用方 |
|------|------|------------|------------|
| `readErrorDetail` | `apps/web/src/api/bridge.ts` | 53 | 16 |
| `getRepoRootDir` | `apps/bridge/src/paths.ts` | 13 | 79 |
| `buildAuthHeaders` | `apps/web/src/api/bridge.ts` | 27 | 14 |
| `getChattingCursorHomeDir` | `apps/bridge/src/paths.ts` | 15 | 44 |
| `getLocalLlmRootDir` | `apps/bridge/src/paths.ts` | 10 | 31 |
| `readEnv` | `services/local-llm-lifecycle.ts` | 10 | 24 |
| `resolveLocalLlmApiBaseUrl` | `services/local-llm-lifecycle.ts` | 8 | 20 |
| `findInstalledLocalLlmModel` | `services/local-llm-store.ts` | 9 | 18 |
| `probeLocalLlmLoadState` | `services/local-llm-lifecycle.ts` | 9 | 13 |
| `isLocalBridgeUrl` | `apps/web/src/bridgeSettings.ts` | 12 | 6 |

（其余条目含 `pilot_tts/upstream` 训练代码中的 `filter` / `sort` 等，与日常 Bridge 集成关系较弱。）

### 分支 PR 上下文

`codegraph_pr_context`（base: `main`，分支: `tts_upgrade`）：

- **116 文件**变更，+8082 / −1429 行
- 风险：**低**
- 爆炸半径：1 个直接调用方受影响
- 测试缺口：1 个函数无覆盖（`pnpm-lock.yaml` 相关）
- 建议审查：`gostnort`（448 行变更）

---

## 推荐维护工作流

在重大功能合并或每月例行维护时：

1. **重索引** — 对 Agent 说：「执行 `codegraph_reindex_workspace`」
2. **刷新架构** — 「用 `codegraph_generate_architecture_doc` 更新 `docs/ARCHITECTURE.md`」
3. **刷新本页** — 同步模块摘要、入口点、热路径与 PR 上下文到 `docs/CODEGRAPH_OVERVIEW.md`
4. **（可选）索引文档** — `codegraph_index_markdown` 指向上述两个文件，启用设计漂移检查

单次对话示例：

> 请先 `codegraph_reindex_workspace`，再生成架构文档，并更新 `docs/ARCHITECTURE.md` 与 `docs/CODEGRAPH_OVERVIEW.md`。

比手动维护更省事：Agent 读取 schema、调用工具、写文件一条龙；人工只需在 Cursor MCP 面板确认服务在线。

---

## 相关链接

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 面向开发的架构说明（服务、端口、数据流）
- [README.md](../README.md) — 运行与端口速查
- `.cursor/mcp.json` — CodeGraph MCP 配置（需自行启用）
