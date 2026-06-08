"""local_llm GGUF 推理 sidecar：OpenAI 兼容 /v1/chat/completions。"""

import asyncio
import concurrent.futures
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field


DEFAULT_MODEL_ID = "local-llm"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4322
SHARD_PATTERN = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$", re.IGNORECASE)
DEFAULT_LOAD_TIMEOUT_SEC = 600
VRAM_HEADROOM_GB = 1.5


class ChatMessage(BaseModel):
    role: str
    content: str | list[Any]


class ChatCompletionRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int | None = Field(default=None, ge=1)
    temperature: float | None = Field(default=None, ge=0.0)


class ReadabilityRequest(BaseModel):
    url: str = ""
    html: str = ""


app = FastAPI(title="ChattingCursor Local LLM Sidecar", version="2.1.0")
_load_lock = threading.Lock()
_inference_lock = asyncio.Lock()
_llm: Any | None = None
_load_state = "idle"
_load_error: str | None = None
_load_started_at: float | None = None
_load_executor: concurrent.futures.ThreadPoolExecutor | None = None
_resolved_n_gpu_layers: int | None = None
_primary_gguf: Path | None = None
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


def parse_load_timeout_sec() -> float:
    raw_ms = read_env("LOCAL_LLM_LOAD_TIMEOUT_MS", "GEMMA4_LOAD_TIMEOUT_MS")
    if not raw_ms:
        raw_ms = read_env("LOCAL_LLM_STARTUP_TIMEOUT_MS", "GEMMA4_STARTUP_TIMEOUT_MS")
    if raw_ms:
        try:
            return max(float(raw_ms) / 1000.0, 30.0)
        except ValueError:
            pass
    return float(DEFAULT_LOAD_TIMEOUT_SEC)


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


def gguf_size_gb(path: Path) -> float:
    return path.stat().st_size / (1024 ** 3)


def venv_site_packages() -> Path:
    if os.name == "nt":
        return Path(sys.prefix) / "Lib" / "site-packages"
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    return Path(sys.prefix) / "lib" / version / "site-packages"


def prepend_llama_runtime_path() -> None:
    if read_env("LOCAL_LLM_SKIP_RUNTIME_PATH", "GEMMA4_SKIP_RUNTIME_PATH").lower() in ("1", "true", "yes"):
        return
    site = venv_site_packages()
    candidates = [
        site / "nvidia" / "cublas" / "bin",
        site / "nvidia" / "cuda_runtime" / "bin",
        site / "bin",
    ]
    prepend: list[str] = []
    for candidate in candidates:
        if candidate.is_dir():
            prepend.append(str(candidate))
    if not prepend:
        return
    separator = ";" if os.name == "nt" else ":"
    existing = os.environ.get("PATH", "")
    os.environ["PATH"] = separator.join(prepend + ([existing] if existing else []))


def probe_llama_gpu_offload() -> bool:
    try:
        prepend_llama_runtime_path()
        import llama_cpp.llama_cpp as lc
        return bool(lc.llama_supports_gpu_offload())
    except Exception:
        return False


def probe_vram_gb() -> float | None:
    if shutil.which("nvidia-smi") is None:
        return None
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        line = result.stdout.strip().splitlines()[0].strip()
        return float(line) / 1024.0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def resolve_n_gpu_layers(gguf_gb: float) -> int:
    global _resolved_n_gpu_layers
    if _resolved_n_gpu_layers is not None:
        return _resolved_n_gpu_layers
    configured = read_env("LOCAL_LLM_N_GPU_LAYERS", "GEMMA4_N_GPU_LAYERS")
    gpu_offload = probe_llama_gpu_offload()
    if configured:
        requested = int(configured)
        if requested != 0 and not gpu_offload:
            _resolved_n_gpu_layers = 0
            return _resolved_n_gpu_layers
        if requested >= 0:
            _resolved_n_gpu_layers = requested
            return _resolved_n_gpu_layers
    elif not gpu_offload:
        _resolved_n_gpu_layers = 0
        return _resolved_n_gpu_layers
    vram_gb = probe_vram_gb()
    if vram_gb is None:
        _resolved_n_gpu_layers = -1 if gpu_offload else 0
        return _resolved_n_gpu_layers
    usable_gb = max(vram_gb - VRAM_HEADROOM_GB, 0.5)
    if gguf_gb <= usable_gb * 0.9:
        _resolved_n_gpu_layers = -1
        return _resolved_n_gpu_layers
    if vram_gb <= 14:
        _resolved_n_gpu_layers = 35
        return _resolved_n_gpu_layers
    ratio = min(usable_gb / max(gguf_gb, 0.1), 1.0)
    _resolved_n_gpu_layers = max(int(ratio * 60), 1)
    return _resolved_n_gpu_layers


def infer_load_mode(n_gpu_layers: int, gguf_gb: float) -> str:
    vram_gb = probe_vram_gb()
    if n_gpu_layers == 0:
        return "cpu"
    if n_gpu_layers == -1 and vram_gb is not None and gguf_gb <= max(vram_gb - VRAM_HEADROOM_GB, 0) * 0.9:
        return "gpu"
    if n_gpu_layers == -1 and (vram_gb is None or gguf_gb > max(vram_gb - VRAM_HEADROOM_GB, 0)):
        return "mixed"
    if n_gpu_layers > 0:
        return "mixed"
    return "gpu"


def preflight_gguf_load(primary: Path) -> None:
    gguf_gb = gguf_size_gb(primary)
    vram_gb = probe_vram_gb()
    if vram_gb is not None and gguf_gb > vram_gb * 2.5:
        hint = (
            f"GGUF 文件约 {gguf_gb:.1f} GB，远超 GPU 显存 {vram_gb:.1f} GB。"
            f"请改用 Q4_K_M 量化（约 15 GB）或更小模型（如 gemma-4-E4B），"
            f"或设置 LOCAL_LLM_N_GPU_LAYERS=35 启用混合模式（GPU 层 + CPU 内存）。"
        )
        strict = read_env("LOCAL_LLM_STRICT_PREFLIGHT", "GEMMA4_STRICT_PREFLIGHT").lower() in ("1", "true", "yes")
        if strict:
            raise RuntimeError(hint)
    try:
        import psutil
    except ImportError:
        return
    available_gb = psutil.virtual_memory().available / (1024 ** 3)
    need_gb = gguf_gb * 1.15
    if need_gb > available_gb:
        raise RuntimeError(
            f"系统可用内存约 {available_gb:.1f} GB，加载 {primary.name}（约 {gguf_gb:.1f} GB）可能内存不足。"
            f"请关闭其他程序或改用更小量化。"
        )


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
    n_gpu_layers = resolve_n_gpu_layers(gguf_size_gb(model_path))
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


def format_load_exception(exc: Exception) -> str:
    text = str(exc).strip()
    if not text:
        return "llama.cpp 加载模型失败，请查看 sidecar 日志。"
    lower = text.lower()
    if (
        "0xc000001d" in lower
        or "illegal instruction" in lower
        or "-1073741795" in text
        or "status_illegal_instruction" in lower
    ):
        return (
            "llama.cpp 指令集或 CUDA/CPU 版本不匹配（STATUS_ILLEGAL_INSTRUCTION）。"
            "请运行 local_llm/server/install.bat 重装 cu124 wheel；"
            "若无独显，设置 LOCAL_LLM_N_GPU_LAYERS=0。"
            f"原始错误：{text}"
        )
    if "cuda" in lower or "cublas" in lower or "libcuda" in lower or "dll" in lower:
        return (
            f"CUDA/GPU 库加载失败：{text}。"
            f"请确认已安装 NVIDIA 驱动；若无独显，设置 LOCAL_LLM_N_GPU_LAYERS=0 改用纯 CPU。"
        )
    if "out of memory" in lower or "oom" in lower or "memory" in lower and "alloc" in lower:
        return (
            f"加载时内存不足（OOM）：{text}。"
            f"请改用 Q4_K_M 量化、设置 LOCAL_LLM_N_GPU_LAYERS=35，或关闭其他占内存程序。"
        )
    if "no such file" in lower or "failed to open" in lower and "gguf" in lower:
        return f"模型文件缺失或无法读取：{text}。请确认 GGUF 已完整下载。"
    return text


def _load_model_inner(primary: Path) -> None:
    global _llm, _load_state, _load_error, _load_started_at, _primary_gguf
    preflight_gguf_load(primary)
    _primary_gguf = primary
    _llm = instantiate_llama(primary)
    _load_state = "ready"
    _load_error = None
    _load_started_at = None


def load_model_sync() -> None:
    global _llm, _load_state, _load_error, _load_started_at, _load_executor
    with _load_lock:
        if _llm is not None:
            _load_state = "ready"
            _load_error = None
            return
        if _load_state == "loading":
            return
        _load_state = "loading"
        _load_error = None
        _load_started_at = time.time()
        directory = weights_dir()
        directory.mkdir(parents=True, exist_ok=True)
        gguf_files = list_gguf_files(directory)
        primary = pick_primary_gguf(gguf_files)
        if primary is None:
            _load_state = "error"
            _load_error = f"未在 {directory} 找到 *.gguf 权重"
            _load_started_at = None
            return
    timeout_sec = parse_load_timeout_sec()
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    _load_executor = executor
    future = executor.submit(_load_model_inner, primary)
    try:
        future.result(timeout=timeout_sec)
    except concurrent.futures.TimeoutError:
        with _load_lock:
            _llm = None
            _load_state = "error"
            _load_error = (
                f"模型加载超时（{int(timeout_sec)} 秒）。"
                f"若 GGUF 过大或显存不足，请改用 Q4_K_M 量化或设置 LOCAL_LLM_N_GPU_LAYERS=35。"
            )
            _load_started_at = None
    except Exception as exc:
        with _load_lock:
            _llm = None
            _load_state = "error"
            _load_error = format_load_exception(exc)
            _load_started_at = None
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
        _load_executor = None


def build_health_payload() -> dict[str, str]:
    gguf_gb = ""
    mode = "unknown"
    n_layers = ""
    elapsed = ""
    if _primary_gguf is not None and _primary_gguf.is_file():
        size = gguf_size_gb(_primary_gguf)
        gguf_gb = f"{size:.2f}"
        layers = resolve_n_gpu_layers(size)
        n_layers = str(layers)
        mode = infer_load_mode(layers, size)
    elif _load_state in ("idle", "loading", "error"):
        directory = weights_dir()
        primary = pick_primary_gguf(list_gguf_files(directory))
        if primary is not None:
            size = gguf_size_gb(primary)
            gguf_gb = f"{size:.2f}"
            layers = resolve_n_gpu_layers(size)
            n_layers = str(layers)
            mode = infer_load_mode(layers, size)
    if _load_state == "error" and _load_error:
        payload = {"status": "error", "detail": _load_error}
    elif _llm is not None:
        payload = {"status": "ready"}
    elif _load_state == "loading":
        payload = {"status": "loading"}
    else:
        payload = {"status": "idle"}
    if gguf_gb:
        payload["gguf_gb"] = gguf_gb
    if n_layers:
        payload["n_gpu_layers"] = n_layers
    if mode != "unknown":
        payload["mode"] = mode
    if _load_started_at is not None:
        elapsed = str(int(time.time() - _load_started_at))
        payload["load_elapsed_sec"] = elapsed
    if payload.get("mode") == "mixed":
        payload["detail"] = payload.get("detail") or "混合模式：部分层在 GPU，其余在 CPU 内存"
    return payload


async def ensure_model_loaded() -> None:
    global _load_state
    if _llm is not None:
        return
    if _load_state == "loading":
        deadline = time.time() + parse_load_timeout_sec()
        while _load_state == "loading" and time.time() < deadline:
            await asyncio.sleep(0.2)
        if _load_state == "error" and _load_error:
            raise HTTPException(status_code=503, detail=_load_error)
        if _llm is None and _load_state == "loading":
            raise HTTPException(status_code=503, detail="模型仍在加载中，请稍后重试")
        return
    await asyncio.to_thread(load_model_sync)
    if _load_error:
        raise HTTPException(status_code=503, detail=_load_error)


@app.get("/v1/health")
@app.get("/health")
async def health() -> dict[str, str]:
    return build_health_payload()


@app.post("/v1/load")
@app.post("/load")
async def trigger_load() -> dict[str, str]:
    if _llm is not None:
        return build_health_payload()
    if _load_state == "error" and _load_error:
        return build_health_payload()
    if _load_state == "loading":
        return build_health_payload()
    asyncio.create_task(asyncio.to_thread(load_model_sync))
    await asyncio.sleep(0.05)
    return build_health_payload()


def html_summary_to_plain_text(summary_html: str) -> str:
    if not summary_html.strip():
        return ""
    try:
        from lxml import html as lxml_html
        root = lxml_html.fromstring(summary_html)
        return " ".join(root.itertext()).replace("\xa0", " ").strip()
    except Exception:
        return summary_html.strip()


@app.post("/readability")
@app.post("/v1/readability")
async def extract_readability(body: ReadabilityRequest) -> dict[str, str]:
    if not body.html.strip():
        raise HTTPException(status_code=400, detail="html 不能为空")
    try:
        from readability import Document
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="readability-lxml 未安装，请运行 local_llm/server/install.bat 或 install.sh") from exc
    doc = Document(body.html)
    title = (doc.title() or "").strip()
    text = html_summary_to_plain_text(doc.summary() or "")
    return {
        "title": title,
        "text": text,
        "url": body.url.strip(),
    }


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


async def _run_chat_completion(completion_kwargs: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_llm.create_chat_completion, **completion_kwargs)


async def _wait_chat_task(task: asyncio.Task[dict[str, Any]], request: Request) -> dict[str, Any]:
    while not task.done():
        if await request.is_disconnected():
            task.cancel()
            interrupt = getattr(_llm, "interrupt", None)
            if callable(interrupt):
                interrupt()
            raise HTTPException(status_code=499, detail="客户端已断开，生成已取消")
        await asyncio.sleep(0.05)
    return await task


@app.post("/v1/chat/completions")
async def chat_completions(body: ChatCompletionRequest, request: Request) -> dict[str, Any]:
    if _inference_lock.locked():
        raise HTTPException(status_code=503, detail="推理繁忙，请稍后重试")
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
    inference_timeout = parse_int_env("LOCAL_LLM_INFERENCE_TIMEOUT_SEC", "GEMMA4_INFERENCE_TIMEOUT_SEC", 600)
    async with _inference_lock:
        task = asyncio.create_task(_run_chat_completion(completion_kwargs))
        try:
            result = await asyncio.wait_for(_wait_chat_task(task, request), timeout=inference_timeout)
        except asyncio.TimeoutError as exc:
            task.cancel()
            interrupt = getattr(_llm, "interrupt", None)
            if callable(interrupt):
                interrupt()
            raise HTTPException(status_code=504, detail="推理超时，请切换模型或稍后重试") from exc
        except asyncio.CancelledError:
            interrupt = getattr(_llm, "interrupt", None)
            if callable(interrupt):
                interrupt()
            raise HTTPException(status_code=499, detail="生成已取消") from None
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


def verify_inference_deps() -> None:
    """启动前检查 llama_cpp 是否可导入"""
    prepend_llama_runtime_path()
    try:
        import llama_cpp  # noqa: F401
    except ImportError as exc:
        sys.stderr.write(
            "ERROR: llama_cpp is not installed. "
            "Run local_llm/server/install.bat (Windows) or install.sh (Linux).\n"
        )
        raise SystemExit(1) from exc
    except Exception as exc:
        sys.stderr.write(
            f"ERROR: llama_cpp failed to load: {exc}\n"
            "Reinstall with local_llm/server/install.bat (Windows) or install.sh (Linux).\n"
        )
        raise SystemExit(1) from exc


def main() -> None:
    verify_inference_deps()
    host = read_env("LOCAL_LLM_HOST", "GEMMA4_HOST") or DEFAULT_HOST
    port = parse_int_env("LOCAL_LLM_PORT", "GEMMA4_PORT", DEFAULT_PORT)
    if not defer_model_load():
        load_model_sync()
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
