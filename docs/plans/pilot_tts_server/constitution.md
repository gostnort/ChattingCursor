# PilotTTS `tts_server.py` Sidecar Constitution (constitution.md)

## 1. Core Principles

The ChattingCursor PilotTTS sidecar (`pilot_tts/server/tts_server.py`) is the **project-owned HTTP entry** for GPU warmup, synthesis, and health reporting. Bridge (`apps/bridge`) spawns and proxies this process; upstream PilotTTS code lives in `pilot_tts/upstream/` (git clone, not a pip package). All modifications to `tts_server.py` and related integration must comply with the following principles:

*   **Install Parity**: Runtime readiness checks in `tts_server.py` must mirror the integrity rules enforced by `install_backend.py` (`verify_model_weights`). A partial install (e.g., `pilot_tts.pt` present but `w2v-bert-2.0` missing) must never report `weightsReady: true`.
*   **Bridge Contract Stability**: HTTP routes, ports (`4323` production API, `8090` optional test/debug WebUI), JSON field names (`weightsReady`, `gpuLoaded`, `fallback`, etc.), and spawn environment variables must remain compatible with `apps/bridge/src/routes/tts.ts`, `pilot-tts-lifecycle.ts`, and `pilot-tts-spawn.ts`.
*   **English User-Facing Messages**: All API error `detail` strings, JSON `message` fields returned to Bridge/Web, and HTTP exception text **must be English**, per workspace `coding-standards.mdc`. Chinese is reserved for code comments only.
*   **No Silent Resource Leaks**: Temporary synthesis artifacts (`.wav` files) must be deleted after the response is sent. Disk growth from repeated `/synthesize` calls is unacceptable.
*   **Explicit Lifecycle Control**: GPU preload behavior must be predictable. Bridge spawns with `PILOT_TTS_AUTO_LOAD=0` and triggers warmup via `POST /load`; manual `run.bat api` behavior must be documented and aligned.
*   **Upstream Integration Honesty**: `demo.py` is imported lazily inside functions after `sys.path` injection — this is a **documented constitution exception** to the top-level-import rule because upstream is not installable as a package and depends on cwd-relative assets.
*   **Config-to-API Chain Integrity**: User TTS preferences (prompt wav / 音色, emotion / 语气, language / 方言) flow **Web settings → Bridge merge → sidecar → demo.synthesize** without requiring the `8090` WebUI on the production read-aloud path. Persisted defaults must not break text-only clients.
*   **Backward Compatibility for Synthesis**: Omitting optional synthesize fields (`promptWav`, `emotion`, `language`) MUST preserve pre-extension behavior: env/default prompt wav, base checkpoint when no instruct controls, same ports and routes.

---

## 2. Tech Stack Constraints

### 2.1 Runtime Stack
*   **Framework**: FastAPI + Uvicorn (existing).
*   **Python**: 3.10.x virtual environment at `pilot_tts/.venv` (created by installation plan).
*   **Upstream**: `pilot_tts/upstream/` — cloned by Phase 4 of installation; contains `demo.py`, `webui.py`, configs, and `pretrained_models/`.

### 2.2 Path and Environment Resolution
*   Prefer `pathlib.Path` for all path operations in `tts_server.py`.
*   Environment variables (with defaults documented):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PILOT_TTS_HOST` | `127.0.0.1` | Bind address |
| `PILOT_TTS_PORT` | `4323` | API port |
| `PILOT_TTS_WEBUI_PORT` | `8090` | Reported optional test/debug WebUI port in `/health` |
| `PILOT_TTS_UPSTREAM_DIR` | `<pilot_tts>/upstream` | Upstream clone root |
| `PILOT_TTS_WEIGHTS_DIR` | `<upstream>/pretrained_models` | Model weights |
| `PILOT_TTS_PROMPT_WAV` | (auto-resolve) | Default reference speaker audio (`.wav` or `.mp3`); overridable per request via `promptWav` |
| `PILOT_TTS_RESERVED_VRAM_GB` | `3` | Reported VRAM reservation |
| `PILOT_TTS_AUTO_LOAD` | `0` when spawned by Bridge; document `run.bat` behavior | GPU preload on startup |

### 2.3 Coding Standards (Python)
*   **Comments**: Chinese only.
*   **User-facing strings**: English only.
*   **Function spacing**: Exactly 2 empty lines between functions; no empty lines inside functions.
*   **Imports**: At file top, except the **documented lazy import** of `demo.load_engine` and `demo.synthesize` (constitution exception §1).
*   **Minimize `os.chdir`**: Prefer path-passing and `sys.path` manipulation; `os.chdir` is a known technical debt item (P2).

### 2.4 Documented Lazy Import Exception

Upstream `demo.py` lives in the git-cloned tree `pilot_tts/upstream/` (`.gitignore`, no pip package). ChattingCursor **cannot** use a top-level `from demo import ...` without first injecting that directory onto `sys.path`. This is a **documented exception** to the project top-level-import rule.

**Why lazy import (not file-top import)**:
- `/health` must respond even when `upstream/` is absent; eager `demo` import would fail at module load or pull GPU deps too early.
- Path setup (`sys.path`, optional `os.chdir`) must precede import; function-scoped imports preserve that order.
- Only `load_gpu_engine()` and the `synthesize()` route handler may import `demo`; all other project Python files follow normal top-level imports.

**Step 1 — `sys.path` injection** (`ensure_upstream_on_path()`):
- Resolve `upstream_dir()` from `PILOT_TTS_UPSTREAM_DIR` or `<pilot_tts>/upstream`.
- Insert the absolute upstream root at `sys.path[0]` when missing so `import demo` resolves to `upstream/demo.py`.

**Step 2 — optional cwd** (`load_gpu_engine()` only):
- `os.chdir(upstream_dir())` before `load_engine`; upstream configs may use cwd-relative paths (P2: reduce reliance).

**Step 3 — function signatures and import sites**:

| Function | Expected signature | Import site |
|----------|-------------------|-------------|
| `load_engine` | `load_engine(*, config_path: str, checkpoint: str) -> Any` | `load_gpu_engine()` after steps 1–2 |
| `synthesize` | `synthesize(engine, *, text, prompt_wav, output_path, emotion=None, language=None) -> None` | `synthesize()` handler after step 1 |

Instruct-only kwargs (`emotion`, `language`) are passed only when non-empty. Paralinguistic tags (语调) remain in `text`. See `spec.md` FR-007–FR-013 for the full extension contract.

Detailed call-site arguments are in `plan.md` §3.5. Inline Chinese comments before each lazy import block (Phase 3) must cite this section.

---

## 3. Service Boundaries

```
Web (TtsSubPage) ──► scheduler-settings.json (promptWav, emotion, language defaults)
       │
       useSpeech ──► Bridge :4321 POST /tts/synthesize (merge defaults)
                         │
                         ├── spawn ──► tts_server.py :4323
                         │              ├── GET  /health, /v1/health
                         │              ├── POST /load, /v1/load
                         │              └── POST /synthesize, /v1/synthesize
                         │                    body: { text, promptWav?, emotion?, language? }
                         │
                         └── spawn ──► upstream/webui.py :8090 (optional test/debug)
```

*   **`tts_server.py` owns**: weight checks, GPU engine lifecycle, synthesis, health JSON.
*   **Bridge owns**: process spawn/kill, install jobs, scheduler lane, WebUI lifecycle, port env injection.
*   **`run.bat` owns**: manual dev/ops launch (`api` → `server/tts_server.py`, default → `upstream/webui.py`).

---

## 4. Non-Negotiable Compatibility

| Item | Requirement |
|------|-------------|
| API port | `4323` (override via `PILOT_TTS_PORT`) |
| WebUI port | `8090` (override via `PILOT_TTS_WEBUI_PORT`; test/debug only — not production TTS path) |
| Dual route aliases | `/health` + `/v1/health`, `/load` + `/v1/load`, `/synthesize` + `/v1/synthesize` |
| Synthesize fallback JSON | `{ error, message, fallback: true }` on 503/500 |
| Synthesize optional fields | `promptWav`, `emotion`, `language` optional; `text` required |
| `run.bat api` entry | `server/tts_server.py` (not `upstream/api.py`) |

---

## 5. Success Definition

Modifications are complete when:

1. `weights_ready()` matches `install_backend.verify_model_weights` criteria.
2. All user-visible API messages are English.
3. Temp wav files are cleaned up after each synthesis response.
4. `PILOT_TTS_AUTO_LOAD` behavior is consistent between Bridge spawn and documented `run.bat` usage.
5. Bridge `isPilotTtsWeightsReady` gap is resolved or tracked in Phase 4 tasks.
6. `docs/plans/pilot_tts_installation/plan.md` stale `api.py` references are corrected.
7. Extension (when implemented): optional synthesize fields end-to-end from settings to `demo.synthesize` with instruct/base selection documented in `plan.md` §3.10.
