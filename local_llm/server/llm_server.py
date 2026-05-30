"""local_llm GGUF 推理 sidecar：OpenAI 兼容 /v1/chat/completions。"""

import asyncio
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


DEFAULT_MODEL_ID = "local-llm"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4322
SHARD_PATTERN = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$", re.IGNORECASE)


class ChatMessage(BaseModel):
    role: str
    content: str | list[Any]


class ChatCompletionRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int | None = Field(default=None, ge=1)
    temperature: float | None = Field(default=None, ge=0.0)


app = FastAPI(title="ChattingCursor Local LLM Sidecar", version="2.0.0")
_load_lock = threading.Lock()
_llm: Any | None = None
_load_state = "idle"
_load_error: str | None = None
_model_id = os.environ.get("LOCAL_LLM_MODEL_ID", os.environ.get("GEMMA4_MODEL_ID", DEFAULT_MODEL_ID)).strip() or DEFAULT_MODEL_ID


def read_env(name: str, legacy: str = "") -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    return os.environ.get(legacy, "").strip() if legacy else ""


def weights_dir() -> Path:
    override = read_env("LOCAL_LLM_WEIGHTS_DIR", "GEMMA4_WEIGHTS_DIR")
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parent.parent / "unsloth" / "gemma-4-E4B-it-GGUF"


def defer_model_load() -> bool:
    flag = read_env("LOCAL_LLM_DEFER_MODEL_LOAD", "GEMMA4_DEFER_MODEL_LOAD") or "1"
    return flag.lower() not in ("0", "false", "no")


def parse_int_env(name: str, legacy: str, default: int) -> int:
    raw = read_env(name, legacy)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def list_gguf_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    files = sorted(directory.glob("*.gguf"))
    if files:
        return files
    nested: list[Path] = []
    for sub in sorted(directory.iterdir()):
        if sub.is_dir():
            nested.extend(sorted(sub.glob("*.gguf")))
    return nested


def pick_primary_gguf(files: list[Path]) -> Path | None:
    if not files:
        return None
    shard_first = [item for item in files if SHARD_PATTERN.search(item.name)]
    if shard_first:
        return sorted(shard_first, key=lambda item: item.name)[0]
    if len(files) == 1:
        return files[0]
    return sorted(files, key=lambda item: item.name)[0]


def normalize_message_content(content: str | list[Any]) -> str:
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict):
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif item.get("type") == "image_url":
                parts.append("[image omitted: GGUF sidecar is text-only]")
        elif isinstance(item, str):
            parts.append(item)
    return "\n".join(part for part in parts if part.strip())


def build_llama_kwargs(model_path: Path) -> dict[str, Any]:
    n_ctx = parse_int_env("LOCAL_LLM_N_CTX", "GEMMA4_N_CTX", 8192)
    n_gpu_layers = parse_int_env("LOCAL_LLM_N_GPU_LAYERS", "GEMMA4_N_GPU_LAYERS", -1)
    n_threads = parse_int_env("LOCAL_LLM_N_THREADS", "GEMMA4_N_THREADS", 0)
    kwargs: dict[str, Any] = {
        "model_path": str(model_path),
        "n_ctx": n_ctx,
        "n_gpu_layers": n_gpu_layers,
        "verbose": False,
    }
    if n_threads > 0:
        kwargs["n_threads"] = n_threads
    return kwargs


def instantiate_llama(model_path: Path) -> Any:
    from llama_cpp import Llama
    return Llama(**build_llama_kwargs(model_path))


def load_model_sync() -> None:
    global _llm, _load_state, _load_error
    with _load_lock:
        if _llm is not None:
            _load_state = "ready"
            _load_error = None
            return
        _load_state = "loading"
        _load_error = None
        try:
            directory = weights_dir()
            directory.mkdir(parents=True, exist_ok=True)
            gguf_files = list_gguf_files(directory)
            primary = pick_primary_gguf(gguf_files)
            if primary is None:
                raise FileNotFoundError(f"未在 {directory} 找到 *.gguf 权重")
            _llm = instantiate_llama(primary)
            _load_state = "ready"
        except Exception as exc:
            _llm = None
            _load_state = "error"
            _load_error = str(exc)


async def ensure_model_loaded() -> None:
    global _load_state
    if _llm is not None:
        return
    if _load_state == "loading":
        while _load_state == "loading":
            await asyncio.sleep(0.2)
        if _load_error:
            raise HTTPException(status_code=503, detail=_load_error)
        return
    await asyncio.to_thread(load_model_sync)
    if _load_error:
        raise HTTPException(status_code=503, detail=_load_error)


@app.get("/v1/health")
@app.get("/health")
async def health() -> dict[str, str]:
    if _load_state == "error" and _load_error:
        return {"status": "error", "detail": _load_error}
    if _llm is not None:
        return {"status": "ready"}
    if _load_state == "loading":
        return {"status": "loading"}
    return {"status": "idle"}


@app.get("/v1/models")
async def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": _model_id,
                "object": "model",
                "owned_by": "local",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(body: ChatCompletionRequest) -> dict[str, Any]:
    await ensure_model_loaded()
    if _llm is None:
        raise HTTPException(status_code=503, detail="模型未加载")
    messages = [
        {"role": msg.role, "content": normalize_message_content(msg.content)}
        for msg in body.messages
    ]
    max_tokens = body.max_tokens or parse_int_env("LOCAL_LLM_MAX_NEW_TOKENS", "GEMMA4_MAX_NEW_TOKENS", 1024)
    completion_kwargs: dict[str, Any] = {
        "messages": messages,
        "max_tokens": max_tokens,
    }
    if body.temperature is not None:
        completion_kwargs["temperature"] = body.temperature
    started = time.time()
    result = await asyncio.to_thread(_llm.create_chat_completion, **completion_kwargs)
    choice = result.get("choices", [{}])[0]
    message = choice.get("message", {})
    content = message.get("content", "")
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in content
        )
    usage = result.get("usage") or {}
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(started),
        "model": body.model or _model_id,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": choice.get("finish_reason", "stop"),
            }
        ],
        "usage": {
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
        },
    }


def main() -> None:
    host = read_env("LOCAL_LLM_HOST", "GEMMA4_HOST") or DEFAULT_HOST
    port = parse_int_env("LOCAL_LLM_PORT", "GEMMA4_PORT", DEFAULT_PORT)
    if not defer_model_load():
        load_model_sync()
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
