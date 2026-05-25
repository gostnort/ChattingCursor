#!/usr/bin/env python3
import argparse
from datetime import datetime, timezone
import json
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

try:
    from crewai import Agent, Crew, Process, Task
    from crewai.tools import BaseTool
except ImportError:
    Agent = None
    Crew = None
    Process = None
    Task = None
    BaseTool = None

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

try:
    from pydantic import BaseModel, Field
except ImportError:
    BaseModel = None
    Field = None

try:
    import yaml
except ImportError:
    yaml = None


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = REPO_ROOT / "configs" / "crews" / "example.yaml"
DEFAULT_INPUTS = REPO_ROOT / "configs" / "crews" / "example-inputs.json"
DEFAULT_CHROME_ENDPOINT = "http://127.0.0.1:9222"
VALIDATION_COMMANDS = [
    ["pnpm", "lint"],
    ["pnpm", "typecheck"],
    ["pnpm", "build"],
]

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def load_yaml(path: Path) -> dict[str, Any]:
    if yaml is None:
        raise RuntimeError("缺少 PyYAML，请先运行 pnpm crew:setup。")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("crew 配置必须是 YAML 对象。")
    return data


def load_inputs(args: argparse.Namespace) -> dict[str, str]:
    if args.inputs_file:
        raw = Path(args.inputs_file).read_text(encoding="utf-8")
    elif args.inputs:
        raw = args.inputs
    elif DEFAULT_INPUTS.is_file():
        raw = DEFAULT_INPUTS.read_text(encoding="utf-8")
    else:
        raw = "{}"
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("inputs 必须是 JSON 对象。")
    return {str(key): str(value) for key, value in parsed.items()}


def render_template(text: str, inputs: dict[str, str]) -> str:
    rendered = text
    for key, value in inputs.items():
        rendered = rendered.replace(f"{{{{{key}}}}}", value)
    return rendered


def resolve_chrome_endpoint() -> str:
    return DEFAULT_CHROME_ENDPOINT


def fetch_json(url: str) -> Any:
    with urlopen(url, timeout=3) as response:
        return json.loads(response.read().decode("utf-8"))


def inspect_chrome_endpoint() -> dict[str, Any]:
    endpoint = resolve_chrome_endpoint()
    try:
        pages = fetch_json(f"{endpoint}/json/list")
    except URLError as exc:
        return {
            "available": False,
            "endpoint": endpoint,
            "message": f"无法连接 Chrome 9222：{exc.reason}",
        }
    except Exception as exc:
        return {
            "available": False,
            "endpoint": endpoint,
            "message": f"读取 Chrome 9222 失败：{exc}",
        }
    if not isinstance(pages, list):
        return {
            "available": False,
            "endpoint": endpoint,
            "message": "Chrome 9222 返回格式无效。",
        }
    return {
        "available": True,
        "endpoint": endpoint,
        "pages": len(pages),
        "message": "Chrome 9222 可用。",
    }


def build_plan(spec: dict[str, Any], inputs: dict[str, str]) -> dict[str, Any]:
    agents = {str(item.get("id", "")): item for item in spec.get("agents", []) if isinstance(item, dict)}
    tasks: list[dict[str, Any]] = []
    for task in spec.get("tasks", []):
        if not isinstance(task, dict):
            continue
        agent = agents.get(str(task.get("agentId", "")), {})
        tasks.append({
            "id": task.get("id"),
            "agentId": task.get("agentId"),
            "agentRole": agent.get("role"),
            "description": render_template(str(task.get("description", "")), inputs),
            "expectedOutput": task.get("expectedOutput"),
            "contextTaskIds": task.get("contextTaskIds", []),
        })
    return {
        "name": spec.get("name"),
        "process": spec.get("process", "sequential"),
        "agents": spec.get("agents", []),
        "tasks": tasks,
        "inputs": inputs,
        "repoRoot": str(REPO_ROOT),
        "chrome": inspect_chrome_endpoint(),
        "validationCommands": [" ".join(command) for command in VALIDATION_COMMANDS],
    }


def summarize_completed_process(result: subprocess.CompletedProcess[str]) -> str:
    output = (result.stdout or "").strip()
    error = (result.stderr or "").strip()
    lines = [
        f"exit_code={result.returncode}",
    ]
    if output:
        lines.append(f"stdout:\n{output[:2000]}")
    if error:
        lines.append(f"stderr:\n{error[:2000]}")
    return "\n".join(lines).strip()


def run_validation_commands() -> str:
    lines: list[str] = []
    for command in VALIDATION_COMMANDS:
        completed = subprocess.run(
            command,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        lines.append(f"$ {' '.join(command)}")
        lines.append(summarize_completed_process(completed))
        lines.append("")
    return "\n".join(lines).strip()


def capture_page_summary(target_url: str) -> str:
    chrome = inspect_chrome_endpoint()
    if not chrome.get("available"):
        return json.dumps(chrome, ensure_ascii=False)
    if sync_playwright is None:
        return json.dumps({
            "available": False,
            "endpoint": chrome["endpoint"],
            "message": "缺少 playwright，无法读取页面内容。",
        }, ensure_ascii=False)
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(chrome["endpoint"])
        contexts = browser.contexts
        context = contexts[0] if contexts else browser.new_context()
        page = None
        for candidate in context.pages:
            if target_url and target_url in candidate.url:
                page = candidate
                break
        if page is None:
            page = context.new_page()
            page.goto(target_url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1000)
        body_text = page.locator("body").inner_text(timeout=5000)[:2000]
        payload = {
            "available": True,
            "endpoint": chrome["endpoint"],
            "url": page.url,
            "title": page.title(),
            "text": body_text,
            "pageCount": sum(len(item.pages) for item in browser.contexts),
        }
        browser.close()
        return json.dumps(payload, ensure_ascii=False)


def build_execute_tools():
    if BaseTool is None or BaseModel is None or Field is None:
        raise RuntimeError("缺少 crewAI / pydantic 运行依赖，请先运行 pnpm crew:setup。")

    class RepoValidationInput(BaseModel):
        reason: str = Field(default="验证当前仓库是否可构建。", description="说明本次验证目的。")


    class RepoValidationTool(BaseTool):
        name: str = "repo_validation"
        description: str = "运行 pnpm lint、pnpm typecheck、pnpm build，并返回结果摘要。"
        args_schema: type[BaseModel] = RepoValidationInput


        def _run(self, reason: str = "验证当前仓库是否可构建。") -> str:
            del reason
            return run_validation_commands()


    class ChromeInspectInput(BaseModel):
        url: str = Field(..., description="需要检查的页面 URL。")


    class ChromeInspectTool(BaseTool):
        name: str = "chrome_9222_snapshot"
        description: str = "连接本机 Chrome 9222，读取页面标题、URL 和正文摘录。"
        args_schema: type[BaseModel] = ChromeInspectInput


        def _run(self, url: str) -> str:
            return capture_page_summary(url)


    return RepoValidationTool(), ChromeInspectTool()


def build_agent_tools(agent_id: str):
    repo_tool, chrome_tool = build_execute_tools()
    if agent_id == "validator":
        return [repo_tool]
    if agent_id == "browser_checker":
        return [chrome_tool]
    return []


def run_execute(spec: dict[str, Any], inputs: dict[str, str]) -> dict[str, Any]:
    if Agent is None or Crew is None or Task is None or Process is None:
        raise RuntimeError("crewAI 未安装，请先运行 pnpm crew:setup。")
    process_name = str(spec.get("process", "sequential"))
    process = Process.sequential if process_name == "sequential" else Process.hierarchical
    agent_map: dict[str, Any] = {}
    for item in spec.get("agents", []):
        if not isinstance(item, dict):
            continue
        agent_id = str(item["id"])
        model = item.get("model")
        agent_kwargs = {
            "role": str(item["role"]),
            "goal": str(item["goal"]),
            "backstory": str(item.get("backstory", "")),
            "verbose": True,
            "allow_delegation": False,
            "max_iter": 6,
            "tools": build_agent_tools(agent_id),
        }
        if model:
            agent_kwargs["llm"] = str(model)
        agent_map[agent_id] = Agent(**agent_kwargs)
    crew_tasks: list[Any] = []
    task_by_id: dict[str, Any] = {}
    for item in spec.get("tasks", []):
        if not isinstance(item, dict):
            continue
        context = [task_by_id[task_id] for task_id in item.get("contextTaskIds", []) if task_id in task_by_id]
        task = Task(
            description=render_template(str(item.get("description", "")), inputs),
            expected_output=str(item.get("expectedOutput", "")),
            agent=agent_map[str(item["agentId"])],
            context=context or None,
        )
        task_by_id[str(item["id"])] = task
        crew_tasks.append(task)
    crew = Crew(
        agents=list(agent_map.values()),
        tasks=crew_tasks,
        process=process,
        verbose=True,
    )
    result = crew.kickoff()
    return {
        "result": str(result),
        "chrome": inspect_chrome_endpoint(),
    }


def build_status_payload() -> dict[str, Any]:
    try:
        crewai_version = version("crewai")
        crewai_payload = {
            "installed": True,
            "version": crewai_version,
        }
    except PackageNotFoundError:
        crewai_payload = {
            "installed": False,
            "message": "未安装 crewai，请先运行 pnpm crew:setup。",
        }
    example_path = DEFAULT_CONFIG
    try:
        spec = load_yaml(example_path)
        example_payload = {
            "valid": True,
            "path": str(example_path),
            "name": str(spec.get("name", "example")),
        }
    except Exception as exc:
        example_payload = {
            "valid": False,
            "path": str(example_path),
            "message": str(exc),
        }
    return {
        "python": {
            "available": True,
            "command": sys.executable,
        },
        "crewai": crewai_payload,
        "chrome": inspect_chrome_endpoint(),
        "exampleConfig": example_payload,
        "scriptPath": str(Path(__file__).resolve()),
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="运行 configs/crews 下的 crewAI 配置。")
    parser.add_argument("--status", action="store_true", help="输出 crewAI / Chrome / 配置状态。")
    parser.add_argument("--config", help="crew YAML 路径。")
    parser.add_argument("--inputs", default="", help="JSON 输入，用于 {{var}} 模板。")
    parser.add_argument("--inputs-file", help="JSON 输入文件路径。")
    parser.add_argument("--dry-run", action="store_true", help="仅校验并输出执行计划。")
    parser.add_argument("--execute", action="store_true", help="调用 crewAI 真实执行。")
    args = parser.parse_args()
    try:
        if args.status:
            print(json.dumps(build_status_payload(), ensure_ascii=False))
            return 0
        config_path = Path(args.config).resolve() if args.config else DEFAULT_CONFIG
        if not config_path.is_file():
            raise FileNotFoundError(f"配置文件不存在：{config_path}")
        inputs = load_inputs(args)
        spec = load_yaml(config_path)
        if args.execute and not args.dry_run:
            payload = {
                "mode": "execute",
                "crew": spec.get("name"),
                **run_execute(spec, inputs),
            }
        else:
            payload = {
                "mode": "dry_run",
                "crew": spec.get("name"),
                "plan": build_plan(spec, inputs),
            }
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
