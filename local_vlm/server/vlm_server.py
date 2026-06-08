"""local_vlm 视觉 embedding sidecar：OpenAI 兼容 /v1/embeddings（仅 RAM，n_gpu_layers=0）。"""

import asyncio
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4325
_load_lock = threading.Lock()
_embedder: Any | None = None
_load_state = "idle"
_load_error: str | None = None
_inference_lock = asyncio.Lock()


class EmbeddingInput(BaseModel):
    input: str | list[str]
    model: str | None = None
    encoding_format: str | None = "float"


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: str | list[Any]
    encoding_format: str | None = "float"
    dimensions: int | None = None


app = FastAPI(title="ChattingCursor Local VLM Sidecar", version="1.0.0")


def read_env(name: str, fallback: str = "") -> str:
    value = os.environ.get(name, "").strip()
    return value or fallback


def weights_dir() -> Path:
    override = read_env("LOCAL_VLM_WEIGHTS_DIR")
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parent.parent / "weights"


def resolve_gguf_and_mmproj() -> tuple[Path, Path]:
    root = weights_dir()
    gguf_files = sorted(root.glob("*.gguf"))
    mmproj_files = sorted(root.glob("mmproj*.gguf"))
    if not gguf_files:
        raise FileNotFoundError(f"未在 {root} 找到 .gguf 权重")
    if not mmproj_files:
        raise FileNotFoundError(f"未在 {root} 找到 mmproj*.gguf")
    main = [item for item in gguf_files if "mmproj" not in item.name.lower()]
    chosen = main[0] if main else gguf_files[0]
    return chosen, mmproj_files[0]


def load_embedder_sync() -> None:
    global _embedder, _load_state, _load_error
    with _load_lock:
        if _embedder is not None:
            _load_state = "ready"
            return
        _load_state = "loading"
        _load_error = None
    try:
        from llama_cpp import Llama
        gguf, mmproj = resolve_gguf_and_mmproj()
        n_gpu_layers = int(read_env("LOCAL_VLM_N_GPU_LAYERS", "0") or "0")
        _embedder = Llama(
            model_path=str(gguf),
            mmproj=str(mmproj),
            n_gpu_layers=n_gpu_layers,
            embedding=True,
            verbose=False,
        )
        with _load_lock:
            _load_state = "ready"
    except Exception as exc:
        with _load_lock:
            _load_state = "error"
            _load_error = str(exc)
            _embedder = None


async def ensure_embedder_loaded() -> None:
    if _load_state == "ready" and _embedder is not None:
        return
    if _load_state == "error" and _load_error:
        raise HTTPException(status_code=503, detail=_load_error)
    defer = read_env("LOCAL_VLM_DEFER_MODEL_LOAD", "1").lower() not in ("0", "false", "no")
    if defer and _load_state == "idle":
        return
    await asyncio.to_thread(load_embedder_sync)
    if _load_error:
        raise HTTPException(status_code=503, detail=_load_error)


def flatten_input_items(raw: str | list[Any]) -> list[str]:
    if isinstance(raw, str):
        return [raw]
    texts: list[str] = []
    for item in raw:
        if isinstance(item, str):
            texts.append(item)
            continue
        if isinstance(item, dict):
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                texts.append(item["text"])
            elif item.get("type") == "image_url":
                url = item.get("image_url", {})
                if isinstance(url, dict) and isinstance(url.get("url"), str):
                    texts.append(url["url"])
    return texts


@app.get("/health")
@app.get("/v1/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok" if _load_state == "ready" else _load_state,
        "detail": _load_error or "",
    }


@app.post("/v1/load")
@app.post("/load")
async def trigger_load() -> dict[str, str]:
    asyncio.create_task(asyncio.to_thread(load_embedder_sync))
    await asyncio.sleep(0.05)
    return await health()


@app.post("/v1/embeddings")
async def create_embeddings(body: EmbeddingRequest) -> dict[str, Any]:
    if _inference_lock.locked():
        raise HTTPException(status_code=503, detail="视觉推理繁忙，请稍后重试")
    async with _inference_lock:
        await ensure_embedder_loaded()
        if _embedder is None:
            raise HTTPException(status_code=503, detail="视觉模型未加载")
        texts = flatten_input_items(body.input)
        if not texts:
            raise HTTPException(status_code=400, detail="input 不能为空")
        timeout_sec = int(read_env("LOCAL_VLM_EMBED_TIMEOUT_SEC", "120") or "120")
        started = time.time()

        def run_embed() -> list[list[float]]:
            vectors: list[list[float]] = []
            for text in texts:
                if text.startswith("data:image"):
                    vector = _embedder.embed(image=text)
                else:
                    vector = _embedder.embed(text)
                if hasattr(vector, "tolist"):
                    vector = vector.tolist()
                vectors.append(list(vector))
            return vectors

        try:
            vectors = await asyncio.wait_for(asyncio.to_thread(run_embed), timeout=timeout_sec)
        except asyncio.TimeoutError as exc:
            raise HTTPException(status_code=504, detail="视觉 embedding 超时") from exc
        data = []
        for index, vector in enumerate(vectors):
            data.append({
                "object": "embedding",
                "index": index,
                "embedding": vector,
            })
        return {
            "object": "list",
            "data": data,
            "model": body.model or "local-vlm",
            "usage": {
                "prompt_tokens": 0,
                "total_tokens": 0,
                "elapsed_sec": round(time.time() - started, 3),
            },
        }


def main() -> None:
    host = read_env("LOCAL_VLM_HOST", DEFAULT_HOST)
    port = int(read_env("LOCAL_VLM_PORT", str(DEFAULT_PORT)) or DEFAULT_PORT)
    defer = read_env("LOCAL_VLM_DEFER_MODEL_LOAD", "1").lower() not in ("0", "false", "no")
    if not defer:
        load_embedder_sync()
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
