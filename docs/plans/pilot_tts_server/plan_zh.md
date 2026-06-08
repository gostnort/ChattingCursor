# PilotTTS `tts_server.py` 重构技术计划（plan_zh.md）

## 1. 架构背景

ChattingCursor 将**安装**（`docs/plans/pilot_tts_installation/`）与 **sidecar 加固**（本计划）分离。安装 Phase 4 创建 `pilot_tts/upstream/` 后，Bridge 拉起项目自有 sidecar：

```
apps/bridge (4321)
    │  pilot-tts-spawn.ts
    │    env: PILOT_TTS_PORT, PILOT_TTS_UPSTREAM_DIR, PILOT_TTS_WEIGHTS_DIR,
    │         PILOT_TTS_AUTO_LOAD=0, cwd=upstreamDir
    │    exec: .venv/python server/tts_server.py
    ▼
pilot_tts/server/tts_server.py (4323)
    │  sys.path ← upstream/
    │  惰性 import demo.load_engine, demo.synthesize
    ▼
pilot_tts/upstream/（git 克隆，.gitignore）
    demo.py, webui.py, configs/, pretrained_models/
```

手动启动（`pilot_tts/run.bat`）：

| 参数 | 命令 | 端口 |
|------|------|------|
| `api` | `.venv\Scripts\python.exe server\tts_server.py` | 4323（`PILOT_TTS_PORT`） |
| （默认） | `upstream\webui.py --port 8090`（另设 env 与 Bridge 对齐） | 8090（仅测试/调试） |

**Phase 1 说明**：`docs/plans/pilot_tts_installation/plan.md` §4.1 已与 `pilot_tts/run.bat` 一致（`server\tts_server.py` 监听 `4323`；无遗留 `upstream/api.py`）。

### 1.1 手动启动参考（运维）

使用 `pilot_tts/run.bat` 进行**独立**测试与调试。ChattingCursor 生产朗读始终为 **Bridge → `server/tts_server.py` :4323**；`run.bat` 默认分支不是生产 TTS 路径。

| 目标 | 命令（自仓库根目录） | URL |
|------|---------------------|-----|
| 手动 API sidecar 测试 | `cd pilot_tts` → `run.bat api` | `http://127.0.0.1:4323/health` |
| 可选 Gradio WebUI（测试/调试） | `cd pilot_tts` → `run.bat` | `http://127.0.0.1:8090` |
| 停止 4323 / 8090 上的服务 | `cd pilot_tts` → `shutdown.bat` | — |

**前置条件**：先运行一次 `pilot_tts/install.bat`，确保 `.venv` 与 `upstream/` 存在。

**`run.bat api` → `server/tts_server.py`（端口 4323）**：
1. 设置 `PILOT_TTS_PORT=4323`（如需覆盖可在启动前设置 env）。
2. 设置 `PILOT_TTS_AUTO_LOAD=0` —— 启动时不加载 GPU；调用 `POST http://127.0.0.1:4323/load` 预热（与 Bridge spawn 策略一致）。
3. 执行 `.venv\Scripts\python.exe server\tts_server.py` —— 项目自有 sidecar，**非** `upstream/api.py`。

**默认 `run.bat` → `upstream/webui.py`（端口 8090，仅测试/调试）**：
1. `cd upstream` 并以 Gradio env（`GRADIO_SERVER_PORT=8090` 等）启动 `webui.py --port 8090`。
2. 用于浏览器内音色调试；Bridge `/tts/synthesize` 代理的是 **4323** sidecar，而非本 WebUI。

---

## 2. 现状审计摘要

| 问题 | 严重度 | 位置 | 说明 |
|------|--------|------|------|
| `weights_ready()` 忽略 w2v-bert | P0 | `tts_server.py:46-52` | `install_backend.verify_model_weights` 要求 `w2v-bert-2.0/config.json` |
| ~~安装计划中过时 `api.py`~~ | — | `pilot_tts_installation/plan.md` §4.1 | **Phase 1 已修复** — 现为 `server/tts_server.py` |
| 未使用的 `import time` | P1 | `tts_server.py:6` | 死导入 |
| 中文 API 消息 | P1 | `tts_server.py` 全文 | 违反 coding-standards |
| 临时 wav 泄漏 | P1 | `synthesize()` `delete=False` | `FileResponse` 后无清理 |
| `PILOT_TTS_AUTO_LOAD` 不一致 | P1 | `main()` 默认 `"1"` vs spawn `"0"` | Bridge 期望显式 `/load` |
| 惰性 `demo` 导入未文档化 | P1 | `load_gpu_engine`, `synthesize` | 需章程例外 |
| `load_gpu_engine` 中 `os.chdir` | P2 | `tts_server.py:101` | 进程级副作用 |
| WebUI 默认端口 `8090` | — | `pilot-tts-paths.ts:90` | 正确；生产朗读仅走 `4323` |
| `inferencePresent` 字段 | P2 | `health()` 第 131 行 | 检查 `inference.py`；集成使用 `demo.py` |
| Bridge `isPilotTtsWeightsReady` 缺口 | P2 | `pilot-tts-paths.ts:110-114` | 同样缺少 w2v-bert |

---

## 3. 技术设计

### 3.1 P0 — 对齐 `weights_ready()` 与安装器

从 `install_backend.verify_model_weights` 提取 parity 规则：

```python
def weights_ready() -> bool:
    root = weights_dir()
    checkpoint_ok = (
        (root / "pilot_tts.pt").is_file()
        or (root / "pilot_tts_instruct.pt").is_file()
    )
    w2v_config = root / "w2v-bert-2.0" / "config.json"
    w2v_ok = w2v_config.is_file() and w2v_config.stat().st_size > 0
    return checkpoint_ok and w2v_ok
```

可选重构：共享模块 `pilot_tts/server/weight_checks.py` 供安装器与 sidecar 导入——**暂缓**以保持范围最小；P0 接受内联 parity。

### 3.2 P1 — 英文错误表面

系统性替换 `_load_error`、`HTTPException.detail`、JSON `message` 与 `/health` `message` 为英文字符串（见 `spec.md` FR-002 表）。内部日志注释保持中文。

### 3.3 P1 — 通过 BackgroundTasks 清理临时 WAV

```python
from fastapi import BackgroundTasks

@app.post("/v1/synthesize")
async def synthesize(body: SynthesizeRequest, background_tasks: BackgroundTasks):
    # ... 合成 ...
    background_tasks.add_task(_cleanup_temp_wav, out_path)
    return FileResponse(out_path, media_type="audio/wav", filename="pilot.wav")

def _cleanup_temp_wav(path: str) -> None:
    # 合成响应发送后删除临时 wav 文件
    Path(path).unlink(missing_ok=True)
```

若已创建 `out_path`，在 `except` 中也调用 `_cleanup_temp_wav`。

### 3.4 P1 — `PILOT_TTS_AUTO_LOAD` 策略（推荐）

**推荐**：方案 B — 在 `run.bat api` 中设置：

```batch
set "PILOT_TTS_AUTO_LOAD=0"
```

保留 `main()` 默认值以兼容直接 `python server/tts_server.py`，但文档说明 Bridge 与 `run.bat api` 均禁用自动加载。方案 A（将 `main()` 默认改为关闭）亦可接受。

理由：Bridge 资源调度器在用户启用 TTS 车道后在 spawn 后调用 `POST /load`；sidecar 急切加载会与调度器显存统计竞态。

### 3.5 P1 — `demo.py` 集成契约

上游 `demo.py` 为 **Git 克隆脚本**，非可安装 Python 包。Sidecar 须在调用时准备导入环境，且仅在函数内导入（章程 §2.4）。

**惰性导入理由**（供审查者）：
- 顶层 `from demo import ...` 在缺少 `upstream/` 时会失败，导致部分安装期间 FastAPI 无法提供 `/health`。
- `demo` 会拉起重推理依赖；推迟到 `/load` 或 `/synthesize` 需要 GPU 引擎时再导入。
- `sys.path` 插入与可选 `os.chdir` 必须在 import 之前执行；函数内导入使顺序显式可控。

**`sys.path` 注入** — `tts_server.py` 中 `ensure_upstream_on_path()`：
- 通过 `PILOT_TTS_UPSTREAM_DIR` 或默认 `<pilot_tts>/upstream` 解析根目录。
- 若不在 `sys.path` 中，则 `sys.path.insert(0, str(upstream_dir()))`，使 `import demo` 解析到 `upstream/demo.py`。

**工作目录** — 仅 `load_gpu_engine()`：
- 在 `load_engine` 前 `os.chdir(str(upstream_dir()))`；上游 YAML/资源可能假设以仓库根为 cwd。
- P2 任务测试绝对路径 `config_path` / `checkpoint` 是否可移除此步骤。

**函数签名**（来自 `tts_server.py` 调用点；上游存在时应对照克隆的 `upstream/demo.py` 复核）：

| 函数 | 预期签名 | Sidecar 调用方 | 传入参数 |
|------|----------|----------------|----------|
| `load_engine` | `load_engine(*, config_path: str, checkpoint: str) -> Any` | `load_gpu_engine()` | `config_path`：`configs/infer_pilot_tts.yaml` 或 `infer_pilot_tts_instruct.yaml`；`checkpoint`：`weights_dir()` 下 `pilot_tts.pt` 或 `pilot_tts_instruct.pt` 的绝对路径 |
| `synthesize` | `synthesize(engine, *, text, prompt_wav, output_path, emotion=None, language=None) -> None` | `synthesize()` 路由 | Base：仅 text + prompt_wav。Instruct：合并非空 `emotion`/`language`。副语言标签保留在 `text` 内。 |

**导入位置**（仅以下两处；sidecar 中无其他 `from demo import`）：
1. `load_gpu_engine()` —— `ensure_upstream_on_path()` 与 `os.chdir` 之后，`from demo import load_engine`。
2. `synthesize()` 处理器 —— `ensure_upstream_on_path()` 之后，`from demo import synthesize`（当前 synthesize 路径不 chdir）。

Phase 3 在每个块前添加中文单行注释，引用章程 §2.4（上游不可 pip 安装）。

### 3.6 P2 — `os.chdir` 缓解

调查步骤：
1. 尝试仅使用绝对 `config_path` / `checkpoint`、不 chdir 调用 `load_engine`。
2. 若上游要求 cwd，用 `Path.cwd()` 在 try/finally 中恢复。
3. 在 `plan.md` 变更日志中记录残留需求。

### 3.7 P2 — `inferencePresent` 字段

选项：
*   **A（推荐）**：新增 `demoPresent: (upstream / "demo.py").is_file()`；保留 `inferencePresent` 作为一版 deprecated 别名。
*   **B**：仅当 Bridge/Web 不消费该字段时（grep 显示 `probePilotTtsHealth` 未读取）将 `inferencePresent` 替换为 `demoPresent`。

### 3.8 Phase 4 — Bridge 集成

| 文件 | 变更 |
|------|------|
| `pilot-tts-paths.ts` | 保持 `resolvePilotTtsWebuiPort()` 默认 `8090`；扩展 `isPilotTtsWeightsReady()` w2v-bert 检查 |
| `tts.ts` | 保持 `ports.note`：`8090` 表示可选测试/调试 WebUI |
| `pilot-tts-spawn.ts` | 预期无变更（`PILOT_TTS_AUTO_LOAD=0` 已正确） |
| `pilot-tts-lifecycle.ts` | 验证健康探测容忍英文消息 |

### 3.9 扩展 — 扩展 `SynthesizeRequest`（Phase 6）

当前 sidecar 目标模型：

```python
class SynthesizeRequest(BaseModel):
    text: str
    promptWav: str | None = None
    emotion: str | None = None
    language: str | None = None
```

示例请求（生产 API `:4323`）：

```json
{
  "text": "今天天气真好啊<|LAUGH|>我们去公园吧！",
  "promptWav": "D:/voices/my_ref.wav",
  "emotion": "happy",
  "language": "zh-henan"
}
```

最小向后兼容请求：

```json
{ "text": "Hello world" }
```

**Prompt wav 解析**（sidecar）：

1. `body.promptWav` 已设置、文件存在且后缀为 `.wav` 或 `.mp3`（不区分大小写）
2. `PILOT_TTS_PROMPT_WAV` env（用户路径同样校验扩展名）
3. `upstream/` 下自动候选（`asset/prompt.wav` 等）

**上游 demo 行为**：PilotTTS 推理经 `prompt_wav` 接受 MP3 参考音频进行音色克隆（torchaudio/librosa 解码），非仅 WAV。传输链 sidecar 校验须同时允许两种扩展名；自动解析默认仍为 upstream 内 `.wav` 资源。

**校验**（Phase 6 sidecar + Bridge 保存）：

```python
ALLOWED_PROMPT_SUFFIXES = {".wav", ".mp3"}

def is_valid_prompt_path(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in ALLOWED_PROMPT_SUFFIXES
```

其他扩展名在合成前以英文 400/503 JSON 拒绝。

### 3.10 扩展 — Instruct 与 Base 引擎选择

| 条件 | 检查点 | 配置 YAML |
|------|--------|-----------|
| 无 `emotion`、无 `language`（合并默认后） | `pilot_tts.pt`（优先） | `infer_pilot_tts.yaml` |
| 任一非空 `emotion` 或 `language` | `pilot_tts_instruct.pt`（必需） | `infer_pilot_tts_instruct.yaml` |

模块全局 `_engine_mode: "base" | "instruct"`；模式不匹配时在 `/synthesize` 前重载引擎。

### 3.11 扩展 — Bridge `/tts/synthesize`（Phase 7）

合并持久化默认后再代理 sidecar；空字符串键省略。instruct 控制但仅 base 权重时 Bridge 返回 503。

### 3.12 扩展 — 设置 Schema（Phase 7–8）

扩展 `SchedulerUserSettings`：`pilotTtsPromptWavPath`、`pilotTtsDefaultEmotion`、`pilotTtsDefaultLanguage`。可选 spawn 时注入 `PILOT_TTS_PROMPT_WAV`。

### 3.13 扩展 — 配置页 → 朗读数据流（Phase 8，规格）

```
TtsSubPage → saveSchedulerSettings → scheduler-settings.json
    → useSpeech → Bridge /tts/synthesize → tts_server.py :4323 → demo.synthesize
```

`8090` WebUI 仍为手动测试/调试，非生产朗读路径。

### 3.14 扩展 — `useSpeech.ts` 集成

*   缓存 TTS 默认；在 `tryPilotTtsSynthesize` body 中包含合并字段。
*   v1 不自动注入副语言标签；Pilot 不可用时浏览器 fallback 不变。

---

## 4. 文件触达图

| 阶段 | 文件 |
|------|------|
| 1 | `docs/plans/pilot_tts_installation/plan.md`、本计划包 |
| 2 | `pilot_tts/server/tts_server.py`（`weights_ready`） |
| 3 | `pilot_tts/server/tts_server.py`（错误、清理、导入、注释、auto-load/run.bat） |
| 4 | `apps/bridge/src/services/pilot-tts-paths.ts`、`apps/bridge/src/routes/tts.ts`、测试 |
| 5 | 手动验证清单 |
| 6 | `pilot_tts/server/tts_server.py`（扩展请求、引擎模式、demo kwargs） |
| 7 | `apps/bridge/src/routes/tts.ts`、`scheduler-settings.ts`、`pilot-tts-spawn.ts`、测试 |
| 8 | `apps/web/src/components/TtsSubPage.tsx`、`useSpeech.ts`、`api/bridge.ts` |
| 9 | E2E 验证（Bridge + sidecar + 设置往返） |

**范围外**：`install_backend.py` 逻辑变更（已正确）、上游 `demo.py` 修改、Phase 8 以外 Web React 变更。

---

## 5. 验证计划

1. **权重部分状态**：仅删除 `w2v-bert-2.0/` → `/health` 显示 `weightsReady: false`。
2. **完整安装**：`install.bat` 后 → `weightsReady: true`，`POST /load` 成功。
3. **英文错误**：触发各错误路径；断言 JSON/message 无 CJK。
4. **临时清理**：运行 10× `/synthesize`；统计 temp 中 `pilot*.wav` → 响应完成后为 0。
5. **Bridge spawn**：从 Web 启动 TTS → sidecar 在 4323，自动加载关闭直至 `/load`。
6. **端口**：`/tts/status` 报告生产 API `4323` 与可选 WebUI `8090`。
7. **run.bat api**：拉起 `server/tts_server.py`，4323 响应。
8. **扩展**：instruct 权重就绪时经 Bridge 传 `{ text, emotion: "happy" }`。
9. **扩展**：`{ text, promptWav: "<有效 .wav 或 .mp3 路径>" }` 使用覆盖参考音频。
10. **扩展**：TtsSubPage 保存的设置出现在代理合成中，无需 WebUI。

---

## 6. 风险登记

| 风险 | 缓解 |
|------|------|
| 上游 `demo.py` 依赖 cwd | P2 调查；必要时恢复 cwd |
| Bridge 测试假设 WebUI 8090 | 预期无变更；`8090` 为正确默认 |
| `inferencePresent` 消费者未知 | 重命名前全库 grep |
| 客户端断开时 BackgroundTasks 清理 | 接受尽力而为；可选后续定期清扫 temp |
| base↔instruct 切换时引擎重载 | 文档化延迟；仅模式变化时重载 |
| 用户 prompt wav 路径无效 | 校验 `.wav`/`.mp3` 扩展名；Bridge 保存与 sidecar 合成时校验；英文错误 |
| 无 instruct 权重却请求 emotion/方言 | 503 instruct_weights_missing |

---

## 7. 可执行性审查

### 7.1 依赖可用性

| 依赖 | 状态 | 说明 |
|------|------|------|
| 上游 `demo.synthesize` 参数 | **已验证**（AMAPVOICE/PilotTTS README） | instruct 模型支持 `emotion`、`language`、`prompt_wav` |
| `pilot_tts_instruct.pt` | **安装后预期存在** | 安装器下载 base + instruct |
| 副语言标签 | **内联于 text** | 无需单独 API 字段 |
| 端口 4323 / 8090 | **已对齐** | 生产 API vs 测试 WebUI 不变 |
| Speckit MCP | **仅模板** | 见 §7.4 |

### 7.2 向后兼容

*   省略 `promptWav`、`emotion`、`language` 保持当前仅 `{ text }` 行为。
*   双路由别名不变；仅发 `text` 的 Bridge 客户端仍可用。
*   无 instruct 权重时 emotion/方言请求显式失败，不静默回退。

### 7.3 风险 / 阻塞项

| 项 | 严重度 | 缓解 |
|----|--------|------|
| 会话中 base↔instruct 切换延迟 | 中 | `_engine_mode` 跟踪；仅不匹配时重载 |
| 上游 `demo.synthesize` 签名漂移 | 低 | Phase 6 对照克隆 `upstream/demo.py` |
| Windows `promptWav` 路径 | 低 | `pathlib` 校验 + `.wav`/`.mp3` 后缀；要求绝对路径 |
| Phase 3 重构未完成 | 中 | 可与 Phase 6 并行；新字段英文错误 |

### 7.4 Speckit MCP 验证结果

在 `tts_upgrade` 分支调用 `project-0-ChattingCursor-spec-kit`：

| 工具 | 结果 |
|------|------|
| `speckit_specify` | 仅返回模板指针（`commands/speckit.specify`） |
| `speckit_plan` | 仅返回模板指针（`commands/speckit.plan`） |
| `speckit_tasks` | 仅返回模板指针（`commands/speckit.tasks`） |

**结论**：MCP 工具可用但不生成本地结构化产物（与先前会话一致）。最终文档由代码审计 + 上游 README 手工编写。可执行性经上游公开 API 与双检查点安装路径确认。

---

## 8. 变更日志

| 日期 | 阶段 | 变更 |
|------|------|------|
| 2026-06-08 | 4.1 | Bridge `isPilotTtsWeightsReady()` 现要求非空 `w2v-bert-2.0/config.json` 加检查点，与 sidecar `weights_ready()` 一致。 |
| 2026-06-08 | 4.3 | **决策（方案 A）**：`/health` 新增 `demoPresent`（`demo.py` 存在）。`inferencePresent` 保留为 deprecated 别名并镜像 `demoPresent`（不再检查 `inference.py`）。Bridge `probePilotTtsHealth` 未变。 |
| 2026-06-08 | 4.4 | **os.chdir 结果**：移除 `load_gpu_engine()` 中裸 `os.chdir`。仅当 `Path.cwd() != upstream_dir()` 时临时 chdir，并用 `try/finally` 恢复 cwd。Bridge spawn 已设 `cwd=upstream`，生产路径跳过 chdir；`run.bat api`（cwd=`pilot_tts/`）仅在 GPU 加载时临时 chdir。合成路径从不 chdir（绝对路径）。Windows GPU 加载未在 CI 重验（开发工作区无 upstream 克隆）。 |
