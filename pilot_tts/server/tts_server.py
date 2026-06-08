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
app = FastAPI(title="ChattingCursor PilotTTS Sidecar", version="1.1.0")
_engine = None
_gpu_loaded = False
_load_error: str | None = None


class SynthesizeRequest(BaseModel):
    text: str


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


def resolve_prompt_wav() -> Path | None:
    override = read_env("PILOT_TTS_PROMPT_WAV")
    if override:
        path = Path(override)
        if path.is_file():
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


def load_gpu_engine() -> None:
    global _engine, _gpu_loaded, _load_error
    if _gpu_loaded and _engine is not None:
        return
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
        checkpoint = weights_dir() / "pilot_tts.pt"
        config_path = upstream / "configs" / "infer_pilot_tts.yaml"
        if not checkpoint.is_file():
            checkpoint = weights_dir() / "pilot_tts_instruct.pt"
            config_path = upstream / "configs" / "infer_pilot_tts_instruct.yaml"
        _engine = load_engine(
            config_path=str(config_path),
            checkpoint=str(checkpoint),
        )
        _gpu_loaded = True
    except Exception as exc:
        _gpu_loaded = False
        _engine = None
        _load_error = f"{exc}\n{traceback.format_exc()[-800:]}"
    finally:
        if needs_chdir:
            os.chdir(previous_cwd)


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
    load_gpu_engine()
    if not _gpu_loaded:
        raise HTTPException(status_code=503, detail=_load_error or "GPU engine failed to load")
    return {
        "ok": True,
        "gpuLoaded": True,
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
    if not _gpu_loaded:
        load_gpu_engine()
    if not _gpu_loaded or _engine is None:
        return JSONResponse(
            status_code=503,
            content={
                "error": "gpu_not_loaded",
                "message": _load_error or "PilotTTS GPU engine is not warm; POST /load first",
                "fallback": True,
            },
        )
    prompt = resolve_prompt_wav()
    if prompt is None:
        return JSONResponse(
            status_code=503,
            content={
                "error": "prompt_missing",
                "message": "prompt.wav not found; set PILOT_TTS_PROMPT_WAV",
                "fallback": True,
            },
        )
    out_path: str | None = None
    try:
        ensure_upstream_on_path()
        # 惰性导入 demo.synthesize：避免模块加载时拉取 GPU 依赖（章程 §2.4 例外）
        from demo import synthesize
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out_path = tmp.name
        synthesize(
            _engine,
            text=text[:500],
            prompt_wav=str(prompt),
            output_path=out_path,
        )
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
        load_gpu_engine()
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
