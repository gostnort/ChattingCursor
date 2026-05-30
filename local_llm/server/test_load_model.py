"""快速验证 local_llm GGUF 依赖与可选加载。"""

import argparse
import os
import sys
from pathlib import Path


def read_env(name: str, legacy: str = "") -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    return os.environ.get(legacy, "").strip() if legacy else ""


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def local_llm_root() -> Path:
    override = read_env("CHATTINGCURSOR_LOCAL_LLM_DIR", "CHATTINGCURSOR_GEMMA4_DIR")
    if override:
        return Path(override).expanduser()
    return repo_root() / "local_llm"


def weights_dir() -> Path:
    override = read_env("LOCAL_LLM_WEIGHTS_DIR", "GEMMA4_WEIGHTS_DIR")
    if override:
        return Path(override).expanduser()
    root = local_llm_root()
    for path in sorted(root.rglob("*.gguf")):
        return path.parent
    return root


def find_gguf(directory: Path) -> Path | None:
    if not directory.is_dir():
        return None
    matches = sorted(directory.glob("*.gguf"))
    if matches:
        return matches[0]
    for sub in sorted(directory.iterdir()):
        if sub.is_dir():
            nested = sorted(sub.glob("*.gguf"))
            if nested:
                return nested[0]
    return None


def run_quick() -> int:
    try:
        import llama_cpp  # noqa: F401
    except ImportError as exc:
        print(f"FAIL: 无法 import llama_cpp: {exc}")
        print("请先: pip install -r local_llm/server/requirements-inference.txt")
        return 1
    wdir = weights_dir()
    gguf = find_gguf(wdir)
    print("OK: llama_cpp 可导入")
    print(f"权重目录: {wdir}")
    if gguf is None:
        print("WARN: 未找到 *.gguf（请在 Web「本地模型」页安装）")
        return 0
    size_gb = gguf.stat().st_size / (1024 ** 3)
    print(f"OK: 找到 GGUF {gguf.name} ({size_gb:.2f} GB)")
    return 0


def run_load(max_tokens: int) -> int:
    quick_code = run_quick()
    if quick_code != 0:
        return quick_code
    wdir = weights_dir()
    gguf = find_gguf(wdir)
    if gguf is None:
        print("SKIP: 无 GGUF 文件，跳过 --load")
        return 2
    from llama_cpp import Llama
    print("加载模型中…")
    llm = Llama(model_path=str(gguf), n_ctx=2048, verbose=False)
    result = llm.create_chat_completion(
        messages=[{"role": "user", "content": "Reply with exactly: ok"}],
        max_tokens=max_tokens,
    )
    text = result["choices"][0]["message"]["content"]
    print(f"completion: {text!r}")
    print("OK: 短 completion 成功")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="local_llm GGUF 加载测试")
    parser.add_argument("--quick", action="store_true", help="仅检查 import 与 GGUF 文件")
    parser.add_argument("--load", action="store_true", help="加载模型并跑一条短 completion")
    parser.add_argument("--max-tokens", type=int, default=16, help="--load 时的 max_tokens")
    args = parser.parse_args()
    if args.load:
        return run_load(args.max_tokens)
    return run_quick()


if __name__ == "__main__":
    sys.exit(main())
