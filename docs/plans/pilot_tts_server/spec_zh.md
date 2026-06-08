# PilotTTS `tts_server.py` 重构功能规格（spec_zh.md）

## 1. 用户场景与用户故事

优先级按审计分类：**P0 > P1 > P2**。

### P0：准确的权重就绪状态（与安装器一致）
*   **用户故事**：作为已运行 `install.bat` 并下载权重的用户，我希望 TTS API 的 `/health` 在 **PilotTTS 检查点** 与 **`w2v-bert-2.0` 编码器目录** 均存在之前报告 `weightsReady: false`——与安装器验证一致——以免 Bridge 在引擎无法加载时仍提供合成。
*   **验收标准**：
    *   仅当 `pilot_tts.pt` / `pilot_tts_instruct.pt` 至少存在一个 **且** `pretrained_models/w2v-bert-2.0/config.json` 存在且非空时，`weights_ready()` 返回 `true`（与 `install_backend.verify_model_weights` 对齐）。
    *   `GET /health` 的 `weightsReady` 与上述一致。
    *   w2v-bert 缺失时，`POST /load` 与 `POST /synthesize` 返回英文 503。

### P0：文档化的 API 启动路径
*   **用户故事**：作为运行 `run.bat api` 的开发者或运维，我希望文档明确 API 服务为端口 `4323` 上的 `pilot_tts/server/tts_server.py`，而非遗留的 `upstream/api.py`。
*   **验收标准**：
    *   `docs/plans/pilot_tts_installation/plan.md` §4.1 示例不再引用 `upstream/api.py`。
    *   `docs/plans/pilot_tts_server/plan.md` 记录 `run.bat api` → `server/tts_server.py` 流程。
    *   引用已正确的 `pilot_tts/run.bat` 作为规范手动启动路径。

### P1：编码规范合规（英文 API 表面）
*   **用户故事**：作为解析错误消息的 Bridge/Web 消费者，我希望 `tts_server.py` 所有 HTTP `detail` 与 JSON `message` 为英文，以符合项目编码标准并便于国际化日志/展示。
*   **验收标准**：
    *   `HTTPException(detail=...)`、JSON `message`、面向 API 的 `loadError` 中无中文字符串。
    *   代码内中文注释保留。

### P1：合成临时文件清理
*   **用户故事**：作为长期运行 TTS 服务的用户，我希望合成时创建的临时 `.wav` 在音频交付后删除，避免 `%TEMP%` 无限增长。
*   **验收标准**：
    *   `FileResponse` 完成后（或创建文件后的错误路径）删除临时 wav。
    *   使用 FastAPI `BackgroundTasks` 或等效可靠清理机制。
    *   重复 `/synthesize` 不在系统临时目录堆积孤立 `.wav`。

### P1：`PILOT_TTS_AUTO_LOAD` 对齐
*   **用户故事**：作为依赖显式 GPU 预热（`POST /load`）的 Bridge 运维者，我希望启动自动加载行为一致：Bridge 以 `PILOT_TTS_AUTO_LOAD=0` 拉起，手动 `run.bat api` 行为有文档（建议 `0` 以保持 parity 或显式 opt-in）。
*   **验收标准**：
    *   `tts_server.main()` 未设置时的默认与 Bridge spawn（`0`/禁用）对齐，**或** `run.bat api` 显式设置 `PILOT_TTS_AUTO_LOAD=0`。
    *   `plan.md` 记录哪条路径会在启动时调用 `load_gpu_engine()`。

### P1：删除死代码
*   **用户故事**：作为维护者，我希望移除未使用的 import，保持静态分析清洁。
*   **验收标准**：
    *   从 `tts_server.py` 移除 `import time`（当前未使用）。

### P1：`demo.py` 契约文档
*   **用户故事**：作为未来贡献者，我希望惰性 `demo.py` 导入模式有文档，以免审查误报为标准违规。
*   **验收标准**：
    *   `constitution.md` §2.4 记录例外。
    *   `plan.md` 描述 `load_engine` 与 `synthesize` 调用契约（参数、cwd 假设）。
    *   惰性 import 代码块前有中文注释说明理由。

### P2：减少 `os.chdir` 依赖
*   **用户故事**：作为运行多个 Python sidecar 的维护者，我希望 `tts_server.py` 尽量避免修改进程 cwd，降低上游演进时的隐蔽 bug。
*   **验收标准**：
    *   评估 `load_engine` / `synthesize` 是否仅依赖绝对路径即可工作。
    *   若仍需 `os.chdir`，说明原因并最小化作用域（上下文管理器或恢复先前 cwd）。

### P2：健康字段 `inferencePresent` 准确性
*   **用户故事**：作为 Bridge 诊断消费者，我希望 `/health` 存在性标志反映 sidecar 集成实际使用的文件。
*   **验收标准**：
    *   评估将 `(upstream_dir / "inference.py").is_file()` 替换为 `demo.py` 存在性，或重命名为 `demoPresent` 并评估 Bridge 兼容性。
    *   决策有文档；除非同期更新 Bridge，否则避免破坏性变更。

### P2：Bridge WebUI 端口 `8090`（已验证——非生产路径）
*   **用户故事**：作为从 Bridge 状态打开可选 PilotTTS WebUI 的用户，我希望报告与默认 WebUI 端口为 `8090`（测试/调试 Gradio 界面），而生产朗读经 `tts_server.py` 走 `4323`。
*   **验收标准**：
    *   `apps/bridge/src/services/pilot-tts-paths.ts` 中 `resolvePilotTtsWebuiPort()` 默认保持 `8090`（或文档化 env 覆盖）。
    *   `apps/bridge/src/routes/tts.ts` 状态 `ports.note` 引用 `8090` 表示 WebUI、`4323` 表示生产 API。

---

## 2. 功能需求（FR）

### FR-001：扩展 `weights_ready()`
*   必须检查 `weights_dir / "w2v-bert-2.0" / "config.json"` 存在且 `stat().st_size > 0`。
*   保留现有检查点检查（`pilot_tts.pt` 或 `pilot_tts_instruct.pt`）。
*   逻辑应镜像 `install_backend.verify_model_weights()`，运行时不得导入安装脚本。

### FR-002：英文错误目录
将中文 API 字符串替换为英文（示例）：

| 位置 | 当前（中文） | 目标（英文） |
|------|-------------|-------------|
| `_load_error` 权重 | 权重未安装 | Model weights are not installed |
| `_load_error` prompt | 未找到 prompt.wav... | prompt.wav not found; set PILOT_TTS_PROMPT_WAV |
| `/load` 503 | 权重未安装 | Model weights are not installed |
| `/load` 503 回退 | GPU 加载失败 | GPU engine failed to load |
| `/synthesize` 400 | text 不能为空 | text must not be empty |
| `/health` message | PilotTTS 已在 GPU 预热 | PilotTTS GPU engine is warm |
| `/health` degraded | 请运行 install.bat... | Run pilot_tts/install.bat and POST /load |
| synthesize 503 JSON | PilotTTS 权重未安装 | PilotTTS model weights are not installed |

### FR-003：临时 WAV 生命周期
*   使用 `tempfile.NamedTemporaryFile(..., delete=False)` 创建（`FileResponse` 需要路径访问）。
*   注册 `BackgroundTasks` 回调：`Path(out_path).unlink(missing_ok=True)`。
*   创建文件后若合成异常，在 `except` 中删除。

### FR-004：`PILOT_TTS_AUTO_LOAD` 策略
*   Bridge（`pilot-tts-spawn.ts`）未设置时注入 `"0"`。
*   `tts_server.main()` 当前默认自动加载**开启**（`"1"`）。通过以下之一对齐：
    *   （A）将 `main()` 默认改为关闭（`"0"`），与 Bridge 一致；或
    *   （B）在 `run.bat api` 分支设置 `PILOT_TTS_AUTO_LOAD=0`。
*   在 `plan.md` 记录选定策略。

### FR-005：文档交叉引用
*   更新 `docs/plans/pilot_tts_installation/plan.md` §4.1：`api.py` → `server/tts_server.py`。
*   可选：在 `docs/plans/ARCHITECTURE.md` PilotTTS 章节交叉链接本计划包。

### FR-006：Bridge 权重检查一致性（相关）
*   `apps/bridge/src/services/pilot-tts-paths.ts` 的 `isPilotTtsWeightsReady()` 应应用与 FR-001 相同的 w2v-bert 规则，避免 Bridge 与 sidecar 不一致。

---

## 3. 边界条件与非功能需求

### 3.1 边界条件
*   **上游缺失**：未克隆 `upstream/` 时 `upstreamPresent` 为 false；加载失败并返回清晰英文消息。
*   **仅 instruct 检查点**：存在 `pilot_tts_instruct.pt` + w2v-bert 时 `weights_ready()` 为 true（`load_gpu_engine` 已处理 instruct yaml）。
*   **Bridge spawn cwd**：`pilot-tts-spawn.ts` 设置 `cwd: upstreamDir`；`tts_server.py` 通过 `PILOT_TTS_*` env 解析路径——须与 cwd 无关地保持健壮。
*   **demo 不可 pip 安装**：不得将 `demo` 加入 `requirements-inference.txt`；保持 sys.path 模式。

### 3.2 非功能需求
*   **不破坏路由**：保留 `/v1/*` 双别名。
*   **最小 diff**：P0/P1 主要限于 `tts_server.py`；Bridge 变更隔离在 Phase 4。
*   **不修改安装脚本逻辑**（已正确）；优先在 sidecar 内联 parity，而非共享 helper 模块。

---

## 4. 可度量成功标准

| 指标 ID | 维度 | 目标 |
| :--- | :--- | :--- |
| **SC-001** | 权重一致性 | 缺少 w2v-bert 时 sidecar `weightsReady` 为 false，即使 `.pt` 存在 |
| **SC-002** | 英文表面 | 100% API 面向错误/消息字符串为英文 |
| **SC-003** | 临时文件卫生 | 100 次连续 synthesize 后 0 个孤立临时 wav |
| **SC-004** | 自动加载策略 | Bridge + run.bat 行为有文档且一致 |
| **SC-005** | 端口对齐 | 生产 API `4323`；Bridge paths 与状态 note 中可选 WebUI 默认 `8090` |
| **SC-006** | 文档准确性 | 安装计划启动章节无 `api.py` 引用 |
