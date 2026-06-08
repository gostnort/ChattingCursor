"""PilotTTS Bridge sidecar：GPU 预热、合成与健康检查。"""

import os
import sys
import tempfile
import traceback
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4323
ALLOWED_PROMPT_SUFFIXES = {".wav", ".mp3"}
app = FastAPI(title="ChattingCursor PilotTTS Sidecar", version="1.2.0")
_engine = None
_gpu_loaded = False
_load_error: str | None = None
_engine_mode: str | None = None


class SynthesizeRequest(BaseModel):
    text: str
    promptWav: str | None = None
    emotion: str | None = None
    language: str | None = None


def read_env(name: str, fallback: str = "") -> str:
    return os.environ.get(name, "").strip() or fallback


def upstream_dir() -> Path:
    override = read_env("PILOT_TTS_UPSTREAM_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "upstream"


def weights_dir() -> Path:
    override = read_env("PILOT_TTS_WEIGHTS_DIR")
    if override:
        return Path(override)
    return upstream_dir() / "pretrained_models"


def weights_ready() -> bool:
    # 与 install_backend.verify_model_weights 对齐：检查点与 w2v-bert 编码器均需就绪
    root = weights_dir()
    checkpoint_ok = (
        (root / "pilot_tts.pt").is_file()
        or (root / "pilot_tts_instruct.pt").is_file()
    )
    w2v_config = root / "w2v-bert-2.0" / "config.json"
    w2v_ok = w2v_config.is_file() and w2v_config.stat().st_size > 0
    return checkpoint_ok and w2v_ok


def is_valid_prompt_path(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in ALLOWED_PROMPT_SUFFIXES


def resolve_prompt_wav() -> Path | None:
    override = read_env("PILOT_TTS_PROMPT_WAV")
    if override:
        path = Path(override)
        if is_valid_prompt_path(path):
            return path
    upstream = upstream_dir()
    for candidate in (
        upstream / "asset" / "prompt.wav",
        upstream / "assert" / "prompt.wav",
        upstream / "assets" / "prompt.wav",
    ):
        if candidate.is_file():
            return candidate
    return None


def resolve_synthesis_prompt_wav(request_path: str | None) -> tuple[Path | None, JSONResponse | None]:
    # 按 body → env → upstream 顺序解析参考音频，并校验扩展名与文件存在性
    if request_path and request_path.strip():
        path = Path(request_path.strip())
        suffix = path.suffix.lower()
        if suffix not in ALLOWED_PROMPT_SUFFIXES:
            return None, JSONResponse(
                status_code=400,
                content={
                    "error": "invalid_prompt_wav",
                    "message": (
                        f"promptWav must use a .wav or .mp3 extension; got {suffix!r}"
                    ),
                    "fallback": True,
                },
            )
        if not path.is_file():
            return None, JSONResponse(
                status_code=503,
                content={
                    "error": "prompt_missing",
                    "message": f"promptWav file not found: {path}",
                    "fallback": True,
                },
            )
        return path, None
    prompt = resolve_prompt_wav()
    if prompt is None:
        return None, JSONResponse(
            status_code=503,
            content={
                "error": "prompt_missing",
                "message": "prompt.wav not found; set PILOT_TTS_PROMPT_WAV",
                "fallback": True,
            },
        )
    return prompt, None


def requires_instruct_controls(emotion: str | None, language: str | None) -> bool:
    return bool(emotion and emotion.strip()) or bool(language and language.strip())


def select_engine_artifacts(require_instruct_controls: bool) -> tuple[str, Path, Path] | None:
    # 按 plan §3.10 选择 base 或 instruct 检查点与配置
    root = weights_dir()
    upstream = upstream_dir()
    base_ckpt = root / "pilot_tts.pt"
    instruct_ckpt = root / "pilot_tts_instruct.pt"
    if require_instruct_controls:
        if not instruct_ckpt.is_file():
            return None
        return (
            "instruct",
            instruct_ckpt,
            upstream / "configs" / "infer_pilot_tts_instruct.yaml",
        )
    if base_ckpt.is_file():
        return ("base", base_ckpt, upstream / "configs" / "infer_pilot_tts.yaml")
    if instruct_ckpt.is_file():
        return (
            "instruct",
            instruct_ckpt,
            upstream / "configs" / "infer_pilot_tts_instruct.yaml",
        )
    return None


def _cleanup_temp_wav(path: str) -> None:
    # 合成响应发送后删除临时 wav 文件
    Path(path).unlink(missing_ok=True)


def reserved_vram_gb() -> float:
    raw = read_env("PILOT_TTS_RESERVED_VRAM_GB", "3")
    try:
        value = float(raw)
    except ValueError:
        value = 3.0
    return value if value > 0 else 3.0


def ensure_upstream_on_path() -> None:
    root = str(upstream_dir())
    if root not in sys.path:
        sys.path.insert(0, root)


def load_gpu_engine(require_instruct_controls: bool = False) -> None:
    global _engine, _gpu_loaded, _load_error, _engine_mode
    artifacts = select_engine_artifacts(require_instruct_controls)
    if artifacts is None:
        _gpu_loaded = False
        _engine = None
        _engine_mode = None
        if require_instruct_controls:
            _load_error = "Instruct checkpoint pilot_tts_instruct.pt is not installed"
        else:
            _load_error = "Model weights are not installed"
        return
    mode, checkpoint, config_path = artifacts
    if _gpu_loaded and _engine is not None and _engine_mode == mode:
        return
    _gpu_loaded = False
    _engine = None
    _engine_mode = None
    _load_error = None
    if not weights_ready():
        _load_error = "Model weights are not installed"
        return
    prompt = resolve_prompt_wav()
    if prompt is None:
        _load_error = "prompt.wav not found; set PILOT_TTS_PROMPT_WAV"
        return
    upstream = upstream_dir()
    needs_chdir = Path.cwd().resolve() != upstream.resolve()
    previous_cwd = os.getcwd()
    try:
        ensure_upstream_on_path()
        if needs_chdir:
            os.chdir(str(upstream))
        # 惰性导入 demo.load_engine：上游非 pip 包，须先注入 sys.path（章程 §2.4 例外）
        from demo import load_engine
        _engine = load_engine(
            config_path=str(config_path),
            checkpoint=str(checkpoint),
        )
        _gpu_loaded = True
        _engine_mode = mode
    except Exception as exc:
        _gpu_loaded = False
        _engine = None
        _engine_mode = None
        _load_error = f"{exc}\n{traceback.format_exc()[-800:]}"
    finally:
        if needs_chdir:
            os.chdir(previous_cwd)


def ensure_gpu_engine(need_instruct: bool) -> JSONResponse | None:
    # 在合成前确保已加载与请求匹配的检查点模式，必要时重载引擎
    if need_instruct and select_engine_artifacts(True) is None:
        return JSONResponse(
            status_code=503,
            content={
                "error": "instruct_weights_missing",
                "message": (
                    "Instruct checkpoint pilot_tts_instruct.pt is required "
                    "for emotion or language controls"
                ),
                "fallback": True,
            },
        )
    load_gpu_engine(require_instruct_controls=need_instruct)
    if not _gpu_loaded or _engine is None:
        return JSONResponse(
            status_code=503,
            content={
                "error": "gpu_not_loaded",
                "message": _load_error or "PilotTTS GPU engine is not warm; POST /load first",
                "fallback": True,
            },
        )
    return None


@app.get("/health")
@app.get("/v1/health")
async def health() -> dict[str, object]:
    ready = weights_ready() and _gpu_loaded
    api_port = int(read_env("PILOT_TTS_PORT", str(DEFAULT_PORT)) or DEFAULT_PORT)
    webui_port = int(read_env("PILOT_TTS_WEBUI_PORT", "8090") or "8090")
    upstream = upstream_dir()
    demo_present = (upstream / "demo.py").is_file()
    return {
        "status": "ready" if ready else "degraded",
        "weightsReady": weights_ready(),
        "gpuLoaded": _gpu_loaded,
        "engineMode": _engine_mode,
        "estimatedVramGb": reserved_vram_gb() if _gpu_loaded else 0,
        "upstreamPresent": (upstream / "webui.py").is_file(),
        "demoPresent": demo_present,
        "inferencePresent": demo_present,
        "apiPort": api_port,
        "webuiPort": webui_port,
        "loadError": _load_error,
        "message": (
            "PilotTTS GPU engine is warm"
            if ready
            else (_load_error or "Run pilot_tts/install.bat and POST /load")
        ),
    }


@app.post("/v1/load")
@app.post("/load")
async def load_endpoint() -> dict[str, object]:
    if not weights_ready():
        raise HTTPException(status_code=503, detail="Model weights are not installed")
    load_gpu_engine(require_instruct_controls=False)
    if not _gpu_loaded:
        raise HTTPException(status_code=503, detail=_load_error or "GPU engine failed to load")
    return {
        "ok": True,
        "gpuLoaded": True,
        "engineMode": _engine_mode,
        "estimatedVramGb": reserved_vram_gb(),
    }


@app.post("/v1/synthesize")
@app.post("/synthesize")
async def synthesize(body: SynthesizeRequest, background_tasks: BackgroundTasks):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")
    if not weights_ready():
        return JSONResponse(
            status_code=503,
            content={
                "error": "weights_missing",
                "message": "PilotTTS model weights are not installed",
                "fallback": True,
            },
        )
    emotion = body.emotion.strip() if body.emotion and body.emotion.strip() else None
    language = body.language.strip() if body.language and body.language.strip() else None
    need_instruct = requires_instruct_controls(emotion, language)
    prompt, prompt_error = resolve_synthesis_prompt_wav(body.promptWav)
    if prompt_error is not None:
        return prompt_error
    engine_error = ensure_gpu_engine(need_instruct)
    if engine_error is not None:
        return engine_error
    out_path: str | None = None
    try:
        ensure_upstream_on_path()
        # 惰性导入 demo.synthesize：避免模块加载时拉取 GPU 依赖（章程 §2.4 例外）
        from demo import synthesize
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out_path = tmp.name
        synth_kwargs: dict[str, object] = {
            "text": text[:500],
            "prompt_wav": str(prompt),
            "output_path": out_path,
        }
        if emotion:
            synth_kwargs["emotion"] = emotion
        if language:
            synth_kwargs["language"] = language
        synthesize(_engine, **synth_kwargs)
        background_tasks.add_task(_cleanup_temp_wav, out_path)
        return FileResponse(out_path, media_type="audio/wav", filename="pilot.wav")
    except Exception as exc:
        if out_path is not None:
            _cleanup_temp_wav(out_path)
        return JSONResponse(
            status_code=500,
            content={
                "error": "synthesize_failed",
                "message": str(exc),
                "fallback": True,
            },
        )


def main() -> None:
    host = read_env("PILOT_TTS_HOST", DEFAULT_HOST)
    port = int(read_env("PILOT_TTS_PORT", str(DEFAULT_PORT)) or DEFAULT_PORT)
    # Bridge spawn 与 run.bat api 设置 PILOT_TTS_AUTO_LOAD=0；直接 python 调用时默认仍为 1
    auto_load = read_env("PILOT_TTS_AUTO_LOAD", "1") not in ("0", "false", "no")
    if auto_load and weights_ready():
        load_gpu_engine(require_instruct_controls=False)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
