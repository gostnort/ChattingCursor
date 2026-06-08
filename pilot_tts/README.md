# PilotTTS（ChattingCursor 本地朗读）

Bridge 通过 `pilot_tts/server/tts_server.py` 提供朗读 API（生产路径）；可选 Gradio WebUI（`8090`）仅用于测试/调试与配置。端口见仓库根目录 [README — Ports](../README.md#ports)（`4323` / `8090`，可用 `PILOT_TTS_PORT`、`PILOT_TTS_WEBUI_PORT` 覆盖）。

## 启动方式（测试 vs 生产）

| 场景 | 谁启动 | 进程 | 端口 |
|------|--------|------|------|
| 独立测试/调试（默认） | `pilot_tts\run.bat` | `upstream/webui.py --port 8090` | `8090` |
| 手动验证朗读 API | `pilot_tts\run.bat api` | `server/tts_server.py` | `4323` |
| ChattingCursor 生产朗读 | Bridge `pilot-tts-spawn.ts` | `server/tts_server.py` | `4323` |
| 语音页打开配置界面 | Bridge `POST /tts/webui/start` | `upstream/webui.py` | `8090` |

`run.bat` 默认分支**不会**被 ChattingCursor 自动调用；应用在「本地 → 语音」勾选「启用朗读 API」后，由 Bridge 拉起 `4323` sidecar 处理 `POST /tts/synthesize`。

停止本机测试进程：`pilot_tts\shutdown.bat`（释放 `4323` 与 `8090`）。

## 安装会做什么

1. 克隆上游 [AMAPVOICE/PilotTTS](https://github.com/AMAPVOICE/PilotTTS) 到 `pilot_tts/upstream`
2. 在 `pilot_tts/.venv` 创建虚拟环境并安装 **推理专用** 依赖（`requirements-inference.txt`）
3. 从 Hugging Face 下载默认权重到 `pilot_tts/upstream/pretrained_models`

入口：

- Web：「本地 → 语音」→ 安装 PilotTTS
- 命令行：仓库根目录执行 `pilot_tts\install.bat`，或 `py -3.10 pilot_tts\install.py`

## 依赖说明

ChattingCursor 的推理安装使用 `pilot_tts/requirements-inference.txt`，**不包含**上游完整 `requirements.txt` 里的 `WeTextProcessing`，因此 **不会安装 pynini**。PilotTTS 推理路径本身不依赖 pynini；CosyVoice 前端在缺少 `ttsfrd` 时使用 `wetext`（见 `requirements-inference.txt` 注释）。

若曾误用上游 **完整** `requirements.txt`（或手动 `pip install WeTextProcessing`），pip 会拉取 `WeTextProcessing` → `pynini`，在 Windows 上常因无预编译 wheel、需 GCC/OpenFst 而编译失败（日志中可能出现 `Failed building wheel for pynini`、`cl.exe` / `D8021`、`-Wno-register` 等）。那是 **装错依赖清单** 导致的现象，不是 PilotTTS 产品需要 pynini。

## Python 版本

安装脚本在 Windows 上优先用 `py -3.10` / `py -3.11` 创建 `.venv`（与上游文档推荐的 3.10 一致）。若仅有 **Python 3.12** 作为默认解释器，部分科学栈包更容易在安装阶段报错；建议安装 [Python 3.10](https://www.python.org/downloads/release/python-31011/) 并勾选 py launcher，再用 `py -0p` 确认可用。

## Windows 安装失败后重试

1. 关闭 Bridge 与进行中的安装任务
2. 删除 `pilot_tts\.venv`（若 `upstream` 不完整也可删掉后重装）
3. 在「本地 → 语音」重新安装，或运行 `pilot_tts\install.bat`

仍失败时：将 `pilot_tts\.install-logs\` 下最新日志末尾发给维护者；勿在 3.12 虚拟环境里强行安装上游完整 `requirements.txt` 或 `WeTextProcessing`。
