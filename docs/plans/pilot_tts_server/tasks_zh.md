# PilotTTS `tts_server.py` 重构任务分解（tasks_zh.md）

本任务列表遵循 `docs/plans/pilot_tts_installation/tasks.md` 的 Speckit 风格阶段结构。优先级：**P0 > P1 > P2**。

---

## Phase 1：规格对齐与文档

### [x] [Task 1.1] 发布计划包
*   **描述**：创建 `docs/plans/pilot_tts_server/`，含 `constitution.md`、`spec.md`、`plan.md`、`tasks.md` 及中文对照（`*_zh.md`）。
*   **前置条件**：审计结论、`ARCHITECTURE.md`、`pilot_tts_installation/` 参考风格。
*   **验收标准**：
    *   8 个计划文件存在并交叉引用端口 `4323`（API）/ `8090`（可选 WebUI）与 Bridge 路由。
    *   `demo.py` 惰性导入章程例外已文档化。

### [x] [Task 1.2] 修正安装计划中过时的 `api.py` 引用
*   **描述**：更新 `docs/plans/pilot_tts_installation/plan.md` §4.1 启动批处理示例：将 `upstream/api.py` 替换为 `server/tts_server.py`，与 `pilot_tts/run.bat` 一致。
*   **前置条件**：Task 1.1。
*   **验收标准**：
    *   安装计划 `run.bat` 片段在 `api` 模式显示 `server\tts_server.py`。
    *   片段中文档化端口 `4323` 与 env `PILOT_TTS_PORT`。

### [x] [Task 1.3] 在 sidecar 计划中记录 `run.bat api` 入口
*   **描述**：确保本包 `plan.md` 明确映射 `run.bat api` → `server/tts_server.py`，默认模式 → `upstream/webui.py` 端口 `8090`（仅测试/调试）。
*   **前置条件**：Task 1.1。
*   **验收标准**：
    *   运维无需读源码即可找到手动 API 启动说明。

### [x] [Task 1.4] 文档化 `demo.py` 上游契约
*   **描述**：在 `plan.md` §3.5 与 `constitution.md` §2.4 中记录 `load_engine` / `synthesize` 签名、`sys.path` 注入及惰性导入理由（上游非 pip 包）。
*   **前置条件**：Task 1.1。
*   **验收标准**：
    *   审查者有书面依据理解非顶层 `from demo import ...`。

---

## Phase 2：`tts_server.py` 中 P0 功能修复

### [x] [Task 2.1] 扩展 `weights_ready()` 以包含 w2v-bert-2.0
*   **描述**：更新 `pilot_tts/server/tts_server.py` 中 `weights_ready()`，要求 `pretrained_models/w2v-bert-2.0/config.json` 存在且非空，与 `install_backend.verify_model_weights()` 一致。
*   **前置条件**：Task 1.1。
*   **验收标准**：
    *   仅有检查点时 `/health` 报告 `weightsReady: false`。
    *   完整安装后报告 `weightsReady: true`。
    *   w2v-bert 缺失时 `POST /load` 返回 503 英文消息（Task 3.1 后）。

### [x] [Task 2.2] 验证 health/load/synthesize 路径使用更新后的 `weights_ready()`
*   **描述**：确认 `health()`、`load_endpoint()`、`synthesize()` 与 `main()` 自动加载门控均调用更新函数且无重复逻辑。
*   **前置条件**：Task 2.1。
*   **验收标准**：
    *   无任何代码路径在未检查 w2v-bert 时设置 `weightsReady: true`。

---

## Phase 3：P1 质量与合规

### [x] [Task 3.1] 面向用户的英文 API 消息
*   **描述**：按 `spec.md` FR-002 将 `HTTPException.detail`、JSON `message`、`_load_error` 与 `/health` `message` 中的中文替换为英文。
*   **前置条件**：Task 2.1。
*   **验收标准**：
    *   grep `tts_server.py` 中赋给 API 字段的字符串字面量无 CJK。
    *   中文注释保留。

### [x] [Task 3.2] 移除死代码 `import time`
*   **描述**：从 `tts_server.py` 删除未使用的 `import time`。
*   **前置条件**：无（可与 3.1 并行）。
*   **验收标准**：
    *   无 `time` 导入；无未使用 import 告警。

### [x] [Task 3.3] 合成后清理临时 wav
*   **描述**：添加 FastAPI `BackgroundTasks`（或等效）在 `FileResponse` 后删除临时 `.wav`；若已创建文件则在错误路径删除。
*   **前置条件**：Task 3.1。
*   **验收标准**：
    *   10 次连续合成后临时目录中 0 个孤立 wav。
    *   成功响应仍返回有效音频。

### [x] [Task 3.4] 与 Bridge 对齐 `PILOT_TTS_AUTO_LOAD`
*   **描述**：实现 `plan.md` §3.4 策略（推荐：`run.bat api` 设置 `PILOT_TTS_AUTO_LOAD=0`；文档化 `main()` 默认行为）。
*   **前置条件**：Task 1.3。
*   **验收标准**：
    *   Bridge spawn 与 `run.bat api` 除非 env 覆盖否则均禁用急切 GPU 加载。
    *   `POST /load` 仍为 Bridge 显式预热路径。

### [x] [Task 3.5] 惰性 `demo` 导入的内联注释
*   **描述**：在 `from demo import load_engine` 与 `from demo import synthesize` 块前添加中文单行注释，引用章程例外。
*   **前置条件**：Task 1.4。
*   **验收标准**：
    *   每个惰性 import 块按 coding-standards 有用途注释（>10 行块）。

---

## Phase 4：Bridge 及相关集成

### [ ] [Task 4.1] Bridge `isPilotTtsWeightsReady()` w2v-bert 一致性
*   **描述**：扩展 `apps/bridge/src/services/pilot-tts-paths.ts` 中 `isPilotTtsWeightsReady()`，检查 `w2v-bert-2.0/config.json`，与 sidecar `weights_ready()` 一致。
*   **前置条件**：Task 2.1。
*   **验收标准**：
    *   Bridge 安装快照 `weightsReady` 与 sidecar `/health` 在部分/完整安装时一致。
    *   必要时更新 `pilot-tts-paths.test.ts`。

### [x] [Task 4.2] Bridge 中 WebUI 默认端口 `8090`（已验证）
*   **描述**：确认 `pilot-tts-paths.ts` 中 `resolvePilotTtsWebuiPort()` 默认保持 `8090`；`tts.ts` `ports.note` 引用 `8090` 表示可选测试/调试 WebUI。端口 `4324` 为过时误解——已从文档与脚本中移除。
*   **前置条件**：Task 1.1。
*   **验收标准**：
    *   未设置 env 时 `/tts/status` 报告 `pilotWebUi: 8090`。
    *   状态 note 提及 `8090` 表示 WebUI、`4323` 表示生产 API。

### [ ] [Task 4.3] 评估 `inferencePresent` 健康字段
*   **描述**：按 `plan.md` §3.7 决定是否在 `tts_server.py` `/health` 中新增 `demoPresent`、重命名或弃用 `inferencePresent`。
*   **前置条件**：Task 2.2。
*   **验收标准**：
    *   决策记录在计划变更或任务注释中。
    *   Bridge `probePilotTtsHealth` 不受影响或同步更新。

### [ ] [Task 4.4] 减少 `os.chdir` 依赖（P2）
*   **描述**：测试 `load_gpu_engine()` 不使用 `os.chdir`；若必需则限定作用域并恢复 cwd；文档化残留需求。
*   **前置条件**：Task 3.5。
*   **验收标准**：
    *   变更后 Windows 上 GPU 加载 + 合成成功。
    *   `plan.md` 记录结果。

---

## Phase 5：验证与检查点

### [ ] [Task 5.1] Sidecar 手动验证（`run.bat api`）
*   **描述**：运行 `pilot_tts/run.bat api`；验证 `GET http://127.0.0.1:4323/health`、`POST /load`、`POST /v1/synthesize` 示例文本。
*   **前置条件**：Phase 2–3 完成。
*   **验收标准**：
    *   `spec.md` 中 SC-001–SC-004 在仅 sidecar 测试下通过。

### [ ] [Task 5.2] Bridge 集成验证
*   **描述**：启动 Bridge；启用 TTS 车道；确认 4323 spawn、`/tts/status` 端口、经 `/tts/synthesize` 代理合成。
*   **前置条件**：Phase 4 完成。
*   **验收标准**：
    *   SC-005、SC-006 通过。
    *   `tts-start-route.test.ts` 无回归。

### [ ] [Task 5.3] 编码规范审计
*   **描述**：验证 `tts_server.py` 符合 `coding-standards.mdc`：函数间 2 空行、函数内无空行、中文注释、英文 API 字符串、pathlib 用法。
*   **前置条件**：Phase 2–3 完成。
*   **验收标准**：
    *   等同 `pilot_tts_installation/tasks.md` Task 6.1 的检查表对修改文件通过。

### [ ] [Task 5.4] 检查点签收
*   **描述**：在本文件将已完成任务标为 `[x]`；记录延期 P2 项。
*   **前置条件**：Task 5.1–5.3。
*   **验收标准**：
    *   所有 P0/P1 任务已勾选或明确延期并说明原因。

---

## Phase 6：Sidecar API 扩展（音色 / 语气 / 方言）

### [ ] [Task 6.1] 扩展 `SynthesizeRequest` Pydantic 模型
*   **描述**：在 `pilot_tts/server/tts_server.py` 增加可选 `promptWav`、`emotion`、`language`（`spec_zh.md` FR-007）。`text` 仍必填。
*   **前置条件**：Phase 2 完成。
*   **验收标准**：
    *   `{ "text": "hi" }` 仍可接受。
    *   空 `text` 返回英文 400。
*   **验证**：`curl -X POST :4323/synthesize -d '{"text":"test"}'` 返回音频。

### [ ] [Task 6.2] Per-request prompt wav 覆盖
*   **描述**：解析链：body → `PILOT_TTS_PROMPT_WAV` → upstream 自动路径；验证文件存在且后缀为 `.wav` 或 `.mp3`。
*   **前置条件**：Task 6.1。
*   **验收标准**：
    *   有效 `promptWav` 路径（`.wav` 或 `.mp3`）与默认可听感区分。
    *   缺失文件或不支持扩展名返回英文 `{ error, message, fallback: true }`。
*   **验证**：两次不同 wav/mp3 路径合成对比。

### [ ] [Task 6.3] Instruct 与 base 引擎选择
*   **描述**：实现 `_engine_mode` 与 `load_gpu_engine(require_instruct)`（`plan_zh.md` §3.10）。
*   **前置条件**：Task 6.1。
*   **验收标准**：
    *   仅 `{ text }` 使用 base（若存在）。
    *   `{ text, emotion: "happy" }` 使用 instruct。
    *   无 instruct 权重时 emotion 请求 → 503。
*   **验证**：带/不带 emotion 合成。

### [ ] [Task 6.4] 向 `demo.synthesize` 传递 `emotion` / `language`
*   **描述**：构建 kwargs；对照克隆的 `upstream/demo.py` 复核签名。
*   **前置条件**：Task 6.2、6.3。
*   **验收标准**：
    *   `language: "zh-henan"` 在 instruct 就绪时到达上游。
    *   `text` 内副语言标签原样转发。
*   **验证**：`plan_zh.md` §3.9 示例 JSON。

### [ ] [Task 6.5] Sidecar 扩展手动测试
*   **描述**：记录手动测试矩阵。
*   **前置条件**：Task 6.1–6.4。
*   **验收标准**：SC-007–SC-010 在 `run.bat api` 下通过。

---

## Phase 7：Bridge 透传与 Spawn 默认

### [ ] [Task 7.1] 扩展 `SchedulerUserSettings` schema
*   **描述**：在 `scheduler-settings.ts` 增加 `pilotTtsPromptWavPath`、`pilotTtsDefaultEmotion`、`pilotTtsDefaultLanguage`。
*   **前置条件**：Task 6.1。
*   **验收标准**：
    *   `GET/POST /local/scheduler-settings` 往返新字段。
    *   更新 `scheduler-settings.test.ts`。
*   **验证**：经 API 保存并读取 home 目录 JSON。

### [ ] [Task 7.2] Bridge `/tts/synthesize` 合并与透传
*   **描述**：扩展 `tts.ts`：合并请求与持久化默认；代理完整 JSON 至 `:4323`。
*   **前置条件**：Task 7.1。
*   **验收标准**：
    *   客户端 `{ text }` + 已保存默认 → sidecar 收到合并 body。
    *   请求字段覆盖已保存默认。
*   **验证**：Bridge curl 或集成测试。

### [ ] [Task 7.3] Spawn 时可选注入 `PILOT_TTS_PROMPT_WAV`
*   **描述**：在 `pilot-tts-spawn.ts` 从设置注入非空默认 wav 路径。
*   **前置条件**：Task 7.1。
*   **验收标准**：
    *   请求省略 `promptWav` 时使用 spawn 默认。
    *   per-request 覆盖无需重启。
*   **验证**：启用 TTS 车道后无 body `promptWav` 合成。

### [ ] [Task 7.4] Bridge synthesize 扩展测试
*   **描述**：新增/更新路由测试，断言合并 JSON 形状。
*   **前置条件**：Task 7.2。
*   **验收标准**：覆盖默认合并、覆盖、空字符串省略。

---

## Phase 8：Web 配置 UI 与 `useSpeech` 集成

### [ ] [Task 8.1] 扩展 Web `SchedulerSettingsPayload`
*   **描述**：更新 `apps/web/src/api/bridge.ts` 类型。
*   **前置条件**：Task 7.1。
*   **验收标准**：TypeScript 编译通过。

### [ ] [Task 8.2] TtsSubPage 音色/语气/方言 UI
*   **描述**：在 `TtsSubPage.tsx` 增加 prompt wav 路径、emotion 下拉、方言下拉；经 `saveSchedulerSettings` 保存。
*   **前置条件**：Task 8.1。
*   **验收标准**：
    *   「本地 → 语音」页可持久化三项设置。
    *   刷新后回显。
    *   帮助文案说明 `8090` WebUI 为可选高级调试。
*   **验证**：手动 UI；确认 `scheduler-settings.json`。

### [ ] [Task 8.3] `useSpeech.ts` 发送 TTS 默认
*   **描述**：读取调度 TTS 默认并写入 `/tts/synthesize` body。
*   **前置条件**：Task 7.2、8.1。
*   **验收标准**：
    *   聊天朗读自动使用已保存设置。
    *   Pilot 不可用时浏览器 fallback 不变。
*   **验证**：配置 happy + 自定义 wav 后触发朗读。

### [ ] [Task 8.4] Web 校验与文案
*   **描述**：绝对路径客户端校验，后缀须为 `.wav` 或 `.mp3`；emotion/方言枚举与 FR-013 一致。
*   **前置条件**：Task 8.2。
*   **验收标准**：无效路径保存前提示（Web 中文 UI；API 仍英文）。

---

## Phase 9：E2E 验证检查点

### [ ] [Task 9.1] 端到端 设置 → 合成
*   **描述**：TtsSubPage 保存 → useSpeech → Bridge → sidecar → 带 emotion/方言/音色的音频。
*   **前置条件**：Phase 6–8 完成。
*   **验收标准**：SC-007–SC-011 通过；SC-010 无回归。

### [ ] [Task 9.2] 端口与路径回归
*   **描述**：确认 API `4323`、WebUI `8090`；`/tts/status` note 不变。
*   **前置条件**：Task 9.1。
*   **验收标准**：SC-005 仍通过。

### [ ] [Task 9.3] 扩展检查点签收
*   **描述**：勾选 Phase 6–9；若发现阻塞更新 `plan_zh.md` 可执行性审查。
*   **前置条件**：Task 9.1–9.2。
*   **验收标准**：扩展任务均已 `[x]` 或 documented 延期。
