#!/usr/bin/env python3
"""通过 Chrome 9222 在 Google 打开搜索（供 CLI / crew 复用，bridge 主路径为 TypeScript）。"""
import argparse
import json
import sys
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
from chrome_endpoint import resolve_chrome_endpoint

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def build_google_search_url(query: str) -> str:
    return f"https://www.google.com/search?q={quote(query)}"


def fetch_json(url: str, method: str = "GET") -> Any:
    request = Request(url, method=method)
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def inspect_chrome_endpoint() -> dict[str, Any]:
    endpoint = resolve_chrome_endpoint()
    try:
        pages = fetch_json(f"{endpoint}/json/list")
    except URLError as exc:
        return {
            "ok": False,
            "endpoint": endpoint,
            "message": f"无法连接 Chrome 9222：{exc.reason}",
        }
    if not isinstance(pages, list):
        return {
            "ok": False,
            "endpoint": endpoint,
            "message": "Chrome 9222 返回格式无效。",
        }
    return {
        "ok": True,
        "endpoint": endpoint,
        "pages": len(pages),
        "message": "Chrome 9222 可用。",
    }


def open_google_search(query: str, snapshot: bool) -> dict[str, Any]:
    endpoint = resolve_chrome_endpoint()
    search_url = build_google_search_url(query)
    chrome = inspect_chrome_endpoint()
    if not chrome.get("ok"):
        return {
            "ok": False,
            "endpoint": endpoint,
            "searchUrl": search_url,
            "message": chrome.get("message"),
        }
    try:
        # q= 已 percent-encode；整 URL 为 ASCII，直接拼到 /json/new? 后，勿再 quote 以免二次编码 %
        created = fetch_json(f"{endpoint}/json/new?{search_url}", method="PUT")
    except Exception as exc:
        return {
            "ok": False,
            "endpoint": endpoint,
            "searchUrl": search_url,
            "message": str(exc),
        }
    payload: dict[str, Any] = {
        "ok": True,
        "endpoint": endpoint,
        "searchUrl": search_url,
        "pageUrl": created.get("url") if isinstance(created, dict) else search_url,
        "targetId": created.get("id") if isinstance(created, dict) else None,
    }
    if snapshot:
        try:
            import importlib.util
            run_crew_path = REPO_ROOT / "scripts" / "run-crew.py"
            spec = importlib.util.spec_from_file_location("run_crew_module", run_crew_path)
            if spec and spec.loader:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                summary_raw = module.capture_page_summary(search_url)
                summary = json.loads(summary_raw)
                if summary.get("available"):
                    payload["title"] = summary.get("title")
                    payload["excerpt"] = summary.get("text")
                    payload["pageUrl"] = summary.get("url", payload["pageUrl"])
        except Exception as exc:
            payload["message"] = f"已打开标签，Playwright 摘录失败：{exc}"
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="在 Chrome 9222 中打开 Google 搜索。")
    parser.add_argument("--query", required=True, help="搜索关键词。")
    parser.add_argument("--snapshot", action="store_true", help="用 Playwright 读取页面摘录。")
    parser.add_argument("--inspect", action="store_true", help="仅检测 Chrome 9222。")
    args = parser.parse_args()
    try:
        if args.inspect:
            print(json.dumps(inspect_chrome_endpoint(), ensure_ascii=False))
            return 0
        print(json.dumps(open_google_search(args.query, args.snapshot), ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
