"""PilotTTS Bridge sidecar：GPU 预热、合成与健康检查。"""

import os
import sys
import tempfile
import time
import traceback
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
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
    root = weights_dir()
    candidates = [
        root / "pilot_tts.pt",
        root / "pilot_tts_instruct.pt",
    ]
    return any(item.is_file() for item in candidates)


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
        _load_error = "权重未安装"
        return
    prompt = resolve_prompt_wav()
    if prompt is None:
        _load_error = "未找到 prompt.wav，请设置 PILOT_TTS_PROMPT_WAV"
        return
    try:
        ensure_upstream_on_path()
        os.chdir(str(upstream_dir()))
        from demo import load_engine
        checkpoint = weights_dir() / "pilot_tts.pt"
        config_path = upstream_dir() / "configs" / "infer_pilot_tts.yaml"
        if not checkpoint.is_file():
            checkpoint = weights_dir() / "pilot_tts_instruct.pt"
            config_path = upstream_dir() / "configs" / "infer_pilot_tts_instruct.yaml"
        _engine = load_engine(
            config_path=str(config_path),
            checkpoint=str(checkpoint),
        )
        _gpu_loaded = True
    except Exception as exc:
        _gpu_loaded = False
        _engine = None
        _load_error = f"{exc}\n{traceback.format_exc()[-800:]}"


@app.get("/health")
@app.get("/v1/health")
async def health() -> dict[str, object]:
    ready = weights_ready() and _gpu_loaded
    api_port = int(read_env("PILOT_TTS_PORT", str(DEFAULT_PORT)) or DEFAULT_PORT)
    webui_port = int(read_env("PILOT_TTS_WEBUI_PORT", "8090") or "8090")
    return {
        "status": "ready" if ready else "degraded",
        "weightsReady": weights_ready(),
        "gpuLoaded": _gpu_loaded,
        "estimatedVramGb": reserved_vram_gb() if _gpu_loaded else 0,
        "upstreamPresent": (upstream_dir() / "webui.py").is_file(),
        "inferencePresent": (upstream_dir() / "inference.py").is_file(),
        "apiPort": api_port,
        "webuiPort": webui_port,
        "loadError": _load_error,
        "message": (
            "PilotTTS 已在 GPU 预热"
            if ready
            else (_load_error or "请运行 pilot_tts/install.bat 并完成 /load")
        ),
    }


@app.post("/v1/load")
@app.post("/load")
async def load_endpoint() -> dict[str, object]:
    if not weights_ready():
        raise HTTPException(status_code=503, detail="权重未安装")
    load_gpu_engine()
    if not _gpu_loaded:
        raise HTTPException(status_code=503, detail=_load_error or "GPU 加载失败")
    return {
        "ok": True,
        "gpuLoaded": True,
        "estimatedVramGb": reserved_vram_gb(),
    }


@app.post("/v1/synthesize")
@app.post("/synthesize")
async def synthesize(body: SynthesizeRequest):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if not weights_ready():
        return JSONResponse(
            status_code=503,
            content={
                "error": "weights_missing",
                "message": "PilotTTS 权重未安装",
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
                "message": _load_error or "PilotTTS 未在 GPU 预热，请先 POST /load",
                "fallback": True,
            },
        )
    prompt = resolve_prompt_wav()
    if prompt is None:
        return JSONResponse(
            status_code=503,
            content={
                "error": "prompt_missing",
                "message": "未找到 prompt.wav",
                "fallback": True,
            },
        )
    try:
        ensure_upstream_on_path()
        from demo import synthesize
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out_path = tmp.name
        synthesize(
            _engine,
            text=text[:500],
            prompt_wav=str(prompt),
            output_path=out_path,
        )
        return FileResponse(out_path, media_type="audio/wav", filename="pilot.wav")
    except Exception as exc:
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
    auto_load = read_env("PILOT_TTS_AUTO_LOAD", "1") not in ("0", "false", "no")
    if auto_load and weights_ready():
        load_gpu_engine()
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
