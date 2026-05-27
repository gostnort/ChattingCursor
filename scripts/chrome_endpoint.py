import os
from pathlib import Path
from urllib.parse import urlparse, urlunparse

DEFAULT_CHROME_ENDPOINT = "http://127.0.0.1:9222"


def is_wsl() -> bool:
    if os.environ.get("WSL_DISTRO_NAME"):
        return True
    version_path = Path("/proc/version")
    if not version_path.is_file():
        return False
    try:
        return "microsoft" in version_path.read_text(encoding="utf-8").lower()
    except OSError:
        return False


def read_wsl_windows_host() -> str | None:
    resolv_path = Path("/etc/resolv.conf")
    if not resolv_path.is_file():
        return None
    try:
        for line in resolv_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("nameserver "):
                parts = stripped.split()
                if len(parts) >= 2 and parts[1]:
                    return parts[1]
    except OSError:
        return None
    return None


def rewrite_localhost_for_wsl(endpoint: str) -> str:
    if not is_wsl():
        return endpoint
    parsed = urlparse(endpoint)
    host = (parsed.hostname or "").lower()
    if host not in ("127.0.0.1", "localhost"):
        return endpoint
    win_host = read_wsl_windows_host()
    if not win_host:
        return endpoint
    port = parsed.port
    netloc = f"{win_host}:{port}" if port else win_host
    return urlunparse(parsed._replace(netloc=netloc)).rstrip("/")


def resolve_chrome_endpoint() -> str:
    from_env = os.environ.get("CHROME_DEBUG_ENDPOINT", "").strip()
    raw = from_env if from_env else DEFAULT_CHROME_ENDPOINT
    return rewrite_localhost_for_wsl(raw.rstrip("/"))
