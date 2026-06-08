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

### 扩展 P1：音色 / Prompt 参考音频
*   **用户故事**：作为配置本地 TTS 的 ChattingCursor 用户，我希望在设置中指定默认参考说话人音频（音色），并可在单次合成请求中覆盖，使朗读音色符合预期而无需每次打开 `8090` WebUI。
*   **验收标准**：
    *   无 per-request 覆盖时，`PILOT_TTS_PROMPT_WAV` env 仍为 sidecar 默认。
    *   `POST /synthesize` 接受可选 `promptWav`（Bridge 主机绝对路径）；sidecar 合成前验证文件存在且扩展名为 `.wav` 或 `.mp3`（不区分大小写）。
    *   PilotTTS 上游推理支持 MP3 参考音频进行音色克隆（非仅 WAV）。
    *   Bridge 在设置中持久化用户默认 `promptWavPath`，客户端未传 `promptWav` 时合并进代理请求。
    *   仅 `{ text }` 的客户端仍可通过 env/默认解析正常工作。

### 扩展 P2：语气（emotion）与语调（副语言标签）
*   **用户故事**：作为用户，我希望配置默认语气并在文本中可选嵌入副语言标签（语调，如 `<|LAUGH|>`），使 instruct 合成更有表现力而无需手动调 WebUI。
*   **验收标准**：
    *   `POST /synthesize` 接受可选 `emotion`（上游标签，如 `happy`、`neutral`、`unknown`）。
    *   副语言标签保留在 `text` 内（无单独 API 字段）；sidecar 原样转发 `text` 至 `demo.synthesize`。
    *   当存在 `emotion`（或配置的默认 emotion 非空）时，sidecar 加载/使用 `pilot_tts_instruct.pt` + `infer_pilot_tts_instruct.yaml`。
    *   Bridge 转发客户端或持久化默认的 `emotion`；instruct 权重缺失时返回英文 400/503。

### 扩展 P3：语言 / 方言
*   **用户故事**：作为需要方言合成的用户，我希望在 TTS 设置或单次请求中选择方言代码（如 `zh-henan`），使 ChattingCursor 朗读使用 PilotTTS 方言合成。
*   **验收标准**：
    *   `POST /synthesize` 接受可选 `language`（上游方言标签，如 `zh-henan`、`zh-shanghai`；省略为默认普通话）。
    *   存在 `language` 时需 instruct 检查点（与 emotion 相同规则）。
    *   Bridge 持久化默认 `language` 并转发 per-request 覆盖。
    *   Web 配置页（UI 延后）文档化与上游 README 一致的支持方言列表。

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

### FR-007：扩展 `SynthesizeRequest`（Sidecar）
*   扩展 Pydantic 模型，增加可选字段（全部省略 = 向后兼容）：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `text` | `str` | 必填 | 最多 500 字符；可含副语言标签 |
| `promptWav` | `str \| null` | `null` | 绝对路径覆盖（`.wav` 或 `.mp3`）；见下方回退链 |
| `emotion` | `str \| null` | `null` | 上游 emotion 标签 |
| `language` | `str \| null` | `null` | 上游方言代码 |

*   prompt wav 解析顺序：`body.promptWav` → `PILOT_TTS_PROMPT_WAV` env → `upstream/` 下自动解析。per-request 与 env 路径须为 `.wav` 或 `.mp3` 扩展名；上游 `demo.synthesize` 对两种格式均可加载参考音频。
*   仅将非 null 的可选 kwargs 传给 `demo.synthesize`。

### FR-008：Instruct 与 Base 检查点选择
*   **Base**（`pilot_tts.pt`）：仅音色克隆；请求与默认均未提供 `emotion`/`language` 时使用。
*   **Instruct**（`pilot_tts_instruct.pt`）：当合并后的 `emotion` 或 `language` 非空时必需。
*   请求 instruct 控制但缺少 `pilot_tts_instruct.pt` → 503 JSON `{ error: "instruct_weights_missing", ... }`。
*   已加载检查点类型与所需类型不匹配时重新 `load_gpu_engine()`（见 plan §3.10）。

### FR-009：Bridge `/tts/synthesize` 透传
*   扩展 JSON body（在现有 `{ text }` 基础上）：

```json
{
  "text": "今天真好啊！",
  "promptWav": "C:/Users/me/voices/ref.wav",
  "emotion": "happy",
  "language": null
}
```

*   代理 sidecar 前合并持久化 TTS 默认（FR-011）。
*   合并后的 body 原样 POST 至 `http://127.0.0.1:4323/synthesize`（字段名 camelCase 端到端）。

### FR-010：Spawn 环境默认
*   `pilot-tts-spawn.ts` 继续 `PILOT_TTS_AUTO_LOAD=0`；可选在启动时从持久化设置注入 `PILOT_TTS_PROMPT_WAV`（Phase 7）。
*   per-request `promptWav` 在合成时覆盖 env，无需重启 sidecar。

### FR-011：配置持久化 Schema
*   推荐扩展 `SchedulerUserSettings`（`scheduler-settings.json`），避免第二份设置文件：

| 字段 | 类型 | 默认 | 用途 |
|------|------|------|------|
| `pilotTtsPromptWavPath` | `string` | `""` | 默认音色（绝对路径） |
| `pilotTtsDefaultEmotion` | `string` | `""` | 默认语气；空 = 省略 |
| `pilotTtsDefaultLanguage` | `string` | `""` | 默认方言；空 = 省略 |

*   经现有 `GET/POST /local/scheduler-settings` 暴露；`TtsSubPage` 已读取调度设置。
*   `useSpeech.ts` 读取默认并写入 `/tts/synthesize` body。

### FR-012：配置页数据流（已规格化，UI 延后）
*   `TtsSubPage`（后续任务）：prompt wav 路径输入/选择；emotion/方言下拉；经 `saveSchedulerSettings` 保存。
*   `8090` WebUI 仍为可选高级调试；生产朗读走 `4323` + 持久化设置。

### FR-013：上游参数对齐
*   Sidecar 调用须匹配上游 `demo.synthesize`（克隆后复核）：

```python
synthesize(engine, text, prompt_wav, output_path, emotion=None, language=None)
```

*   Emotion 标签：`happy`, `sad`, `angry`, `surprise`, `fear`, `disgust`, `serious`, `concern`, `blue`, `disdain`, `neutral`, `psychology`, `unknown`。
*   副语言标签（在 `text` 内）：`<|LAUGH|>`, `<|BREATH|>`, `<|COUGH|>`, `<|CRY|>` 等。
*   方言代码：`zh-dongbei`, `zh-shandong`, `zh-henan`, `zh-shanxi`, `zh-minnan`, `zh-gansu`, `zh-ningxia`, `zh-shanghai`, `zh-chongqing`, `zh-hubei`, `zh-hunan`, `zh-jiangxi`, `zh-guizhou`, `zh-yunnan`。

---

## 3. 边界条件与非功能需求

### 3.1 边界条件
*   **上游缺失**：未克隆 `upstream/` 时 `upstreamPresent` 为 false；加载失败并返回清晰英文消息。
*   **仅 instruct 检查点**：存在 `pilot_tts_instruct.pt` + w2v-bert 时 `weights_ready()` 为 true（`load_gpu_engine` 已处理 instruct yaml）。
*   **Bridge spawn cwd**：`pilot-tts-spawn.ts` 设置 `cwd: upstreamDir`；`tts_server.py` 通过 `PILOT_TTS_*` env 解析路径——须与 cwd 无关地保持健壮。
*   **demo 不可 pip 安装**：不得将 `demo` 加入 `requirements-inference.txt`；保持 sys.path 模式。
*   **扩展向后兼容**：仅 `{ "text": "..." }` 的行为与扩展前一致。
*   **路径安全**：sidecar 仅接受存在且为普通文件、后缀为 `.wav` 或 `.mp3` 的 `promptWav`；v1 不支持 URL 拉取。
*   **Instruct 专用控制**：有 emotion/方言但无 instruct 权重 → 显式 503，不得静默回退 base 模型。

### 3.2 非功能需求
*   **不破坏路由**：保留 `/v1/*` 双别名。
*   **最小 diff**：P0/P1 重构主要限于 `tts_server.py`；扩展 Bridge/Web 在 Phase 6–8。
*   **不修改安装脚本逻辑**（已正确）；优先在 sidecar 内联 parity。
*   **新校验错误为英文 API 消息**。

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
| **SC-007** | 音色覆盖 | per-request `promptWav`（`.wav` 或 `.mp3`）与默认 env 参考音频听感不同 |
| **SC-008** | 语气路径 | 经 Bridge 传 `emotion: "happy"` 与 neutral/省略听感可区分（instruct 权重就绪） |
| **SC-009** | 方言路径 | `language: "zh-henan"` 呈现方言特征（instruct 权重就绪） |
| **SC-010** | 向后兼容 | 仅 `{ "text" }` 无相对扩展前的回归 |
| **SC-011** | 设置往返 | 保存的音色/语气/方言经 `/tts/synthesize` 代理生效，无需 WebUI |
