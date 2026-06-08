# PilotTTS `tts_server.py` Sidecar 章程（constitution_zh.md）

## 1. 核心原则

ChattingCursor PilotTTS sidecar（`pilot_tts/server/tts_server.py`）是 GPU 预热、语音合成与健康检查的**项目自有 HTTP 入口**。Bridge（`apps/bridge`）负责拉起并代理该进程；上游 PilotTTS 代码位于 `pilot_tts/upstream/`（Git 克隆，非 pip 包）。对 `tts_server.py` 及相关集成的所有修改必须遵守以下原则：

*   **与安装器一致**：`tts_server.py` 中的运行时就绪检查必须与 `install_backend.py`（`verify_model_weights`）的完整性规则一致。部分安装（例如仅有 `pilot_tts.pt` 但缺少 `w2v-bert-2.0`）不得报告 `weightsReady: true`。
*   **Bridge 契约稳定**：HTTP 路由、端口（生产 API `4323`、可选测试/调试 WebUI `8090`）、JSON 字段名（`weightsReady`、`gpuLoaded`、`fallback` 等）以及 spawn 环境变量必须与 `apps/bridge/src/routes/tts.ts`、`pilot-tts-lifecycle.ts`、`pilot-tts-spawn.ts` 保持兼容。
*   **面向用户的英文消息**：所有返回给 Bridge/Web 的 API 错误 `detail`、JSON `message` 及 HTTP 异常文本**必须为英文**，符合工作区 `coding-standards.mdc`。中文仅用于代码注释。
*   **禁止静默资源泄漏**：合成产生的临时 `.wav` 文件必须在响应发送后删除。 repeated `/synthesize` 不得导致磁盘持续增长。
*   **显式生命周期控制**：GPU 预加载行为必须可预测。Bridge 以 `PILOT_TTS_AUTO_LOAD=0` 拉起并通过 `POST /load` 预热；手动 `run.bat api` 的行为须文档化并对齐。
*   **上游集成诚实说明**：`demo.py` 在 `sys.path` 注入后于函数内惰性导入——这是对顶层 import 规则的**文档化章程例外**，因为上游不可作为 pip 包安装且依赖 cwd 相对路径资源。
*   **配置到 API 链路完整性**：用户 TTS 偏好（prompt wav / 音色、emotion / 语气、language / 方言）经 **Web 设置 → Bridge 合并 → sidecar → demo.synthesize** 传递，生产朗读路径不依赖 `8090` WebUI。持久化默认不得破坏仅 `text` 的客户端。
*   **合成向后兼容**：省略可选字段（`promptWav`、`emotion`、`language`）**必须**保持扩展前行为：env/默认 prompt wav、无 instruct 控制时用 base 检查点、相同端口与路由。

---

## 2. 技术栈约束

### 2.1 运行时栈
*   **框架**：FastAPI + Uvicorn（沿用现有）。
*   **Python**：`pilot_tts/.venv` 中的 3.10.x 虚拟环境（由安装计划创建）。
*   **上游**：`pilot_tts/upstream/` —— 安装 Phase 4 克隆；含 `demo.py`、`webui.py`、配置与 `pretrained_models/`。

### 2.2 路径与环境变量解析
*   `tts_server.py` 中路径操作优先使用 `pathlib.Path`。
*   环境变量（默认值须文档化）：

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `PILOT_TTS_HOST` | `127.0.0.1` | 绑定地址 |
| `PILOT_TTS_PORT` | `4323` | API 端口 |
| `PILOT_TTS_WEBUI_PORT` | `8090` | `/health` 中报告的可选测试/调试 WebUI 端口 |
| `PILOT_TTS_UPSTREAM_DIR` | `<pilot_tts>/upstream` | 上游克隆根目录 |
| `PILOT_TTS_WEIGHTS_DIR` | `<upstream>/pretrained_models` | 模型权重 |
| `PILOT_TTS_PROMPT_WAV` | （自动解析） | 默认参考说话人音频（`.wav` 或 `.mp3`）；可通过请求 `promptWav` 覆盖 |
| `PILOT_TTS_RESERVED_VRAM_GB` | `3` | 报告的显存预留 |
| `PILOT_TTS_AUTO_LOAD` | Bridge 拉起时为 `0`；须文档化 `run.bat` 行为 | 启动时是否预加载 GPU |

### 2.3 编码规范（Python）
*   **注释**：仅中文。
*   **面向用户字符串**：仅英文。
*   **函数间距**：函数之间恰好 2 个空行；函数体内不得有空行。
*   **导入**：置于文件顶部，**除已文档化的** `demo.load_engine` 与 `demo.synthesize` 惰性导入（章程 §1 例外）。
*   **尽量减少 `os.chdir`**：优先传递绝对路径并操作 `sys.path`；`os.chdir` 为已知技术债（P2）。

### 2.4 文档化的惰性导入例外

上游 `demo.py` 位于 Git 克隆树 `pilot_tts/upstream/`（`.gitignore`，非 pip 包）。ChattingCursor **不能**在未先将该目录注入 `sys.path` 的情况下使用顶层 `from demo import ...`。这是对项目顶层 import 规则的**文档化例外**。

**为何惰性导入（非文件顶部 import）**：
- 即使缺少 `upstream/`，`/health` 也须能响应；过早 import `demo` 会在模块加载时失败或过早拉取 GPU 依赖。
- 路径准备（`sys.path`、可选 `os.chdir`）必须在 import 之前；函数内导入保持该顺序。
- 仅 `load_gpu_engine()` 与 `synthesize()` 路由处理器可 import `demo`；项目其他 Python 文件仍遵循常规顶层 import。

**步骤 1 — `sys.path` 注入**（`ensure_upstream_on_path()`）：
- 从 `PILOT_TTS_UPSTREAM_DIR` 或 `<pilot_tts>/upstream` 解析 `upstream_dir()`。
- 若缺失则将上游根绝对路径插入 `sys.path[0]`，使 `import demo` 解析到 `upstream/demo.py`。

**步骤 2 — 可选 cwd**（仅 `load_gpu_engine()`）：
- 在 `load_engine` 前 `os.chdir(upstream_dir())`；上游配置可能使用 cwd 相对路径（P2：减少依赖）。

**步骤 3 — 函数签名与导入位置**：

| 函数 | 预期签名 | 导入位置 |
|------|----------|----------|
| `load_engine` | `load_engine(*, config_path: str, checkpoint: str) -> Any` | 步骤 1–2 之后的 `load_gpu_engine()` |
| `synthesize` | `synthesize(engine, *, text, prompt_wav, output_path, emotion=None, language=None) -> None` | 步骤 1 之后的 `synthesize()` 处理器 |

仅当非空时传递 instruct 专用 kwargs（`emotion`、`language`）。副语言标签（语调）保留在 `text` 内。完整扩展契约见 `spec_zh.md` FR-007–FR-013。

详细调用参数见 `plan.md` §3.5。Phase 3 在每个惰性 import 块前须添加引用本节的中文注释。

---

## 3. 服务边界

```
Web (TtsSubPage) ──► scheduler-settings.json（promptWav、emotion、language 默认）
       │
       useSpeech ──► Bridge :4321 POST /tts/synthesize（合并默认）
                         │
                         ├── spawn ──► tts_server.py :4323
                         │              ├── GET  /health, /v1/health
                         │              ├── POST /load, /v1/load
                         │              └── POST /synthesize, /v1/synthesize
                         │                    body: { text, promptWav?, emotion?, language? }
                         │
                         └── spawn ──► upstream/webui.py :8090（可选测试/调试）
```

*   **`tts_server.py` 负责**：权重检查、GPU 引擎生命周期、合成、健康 JSON。
*   **Bridge 负责**：进程拉起/终止、安装任务、调度车道、WebUI 生命周期、端口环境注入。
*   **`run.bat` 负责**：手动开发/运维启动（`api` → `server/tts_server.py`，默认 → `upstream/webui.py`）。

---

## 4. 不可妥协的兼容性

| 项 | 要求 |
|----|------|
| API 端口 | `4323`（`PILOT_TTS_PORT` 可覆盖） |
| WebUI 端口 | `8090`（`PILOT_TTS_WEBUI_PORT` 可覆盖；仅测试/调试——非生产朗读路径） |
| 双路由别名 | `/health` + `/v1/health`，`/load` + `/v1/load`，`/synthesize` + `/v1/synthesize` |
| 合成降级 JSON | 503/500 时 `{ error, message, fallback: true }` |
| 合成可选字段 | `promptWav`、`emotion`、`language` 可选；`text` 必填 |
| `run.bat api` 入口 | `server/tts_server.py`（非 `upstream/api.py`） |

---

## 5. 完成定义

修改完成当且仅当：

1. `weights_ready()` 与 `install_backend.verify_model_weights` 标准一致。
2. 所有用户可见 API 消息为英文。
3. 每次合成响应后清理临时 wav。
4. `PILOT_TTS_AUTO_LOAD` 在 Bridge spawn 与文档化的 `run.bat` 用法间行为一致。
5. Bridge `isPilotTtsWeightsReady` 缺口已解决或在 Phase 4 任务中跟踪。
6. `docs/plans/pilot_tts_installation/plan.md` 中过时的 `api.py` 引用已更正。
7. 扩展（实现后）：可选合成字段从设置到 `demo.synthesize` 端到端，`plan_zh.md` §3.10 文档化 instruct/base 选择。
