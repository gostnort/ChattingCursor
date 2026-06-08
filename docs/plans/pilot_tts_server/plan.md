# PilotTTS `tts_server.py` Refactor Technical Plan (plan.md)

## 1. Architecture Context

ChattingCursor separates **installation** (`docs/plans/pilot_tts_installation/`) from **sidecar hardening** (this plan). After Phase 4 installation creates `pilot_tts/upstream/`, the Bridge spawns the project-owned sidecar:

```
apps/bridge (4321)
    │  pilot-tts-spawn.ts
    │    env: PILOT_TTS_PORT, PILOT_TTS_UPSTREAM_DIR, PILOT_TTS_WEIGHTS_DIR,
    │         PILOT_TTS_AUTO_LOAD=0, cwd=upstreamDir
    │    exec: .venv/python server/tts_server.py
    ▼
pilot_tts/server/tts_server.py (4323)
    │  sys.path ← upstream/
    │  lazy import demo.load_engine, demo.synthesize
    ▼
pilot_tts/upstream/ (git clone, .gitignore)
    demo.py, webui.py, configs/, pretrained_models/
```

Manual launch (`pilot_tts/run.bat`):

| Argument | Command | Port |
|----------|---------|------|
| `api` | `.venv\Scripts\python.exe server\tts_server.py` | 4323 (`PILOT_TTS_PORT`) |
| (default) | `upstream\webui.py --port 8090` (+ env vars for Bridge parity) | 8090 (test/debug only) |

**Correction**: `docs/plans/pilot_tts_installation/plan.md` §4.1 still shows `upstream/api.py`; actual `run.bat` already uses `server/tts_server.py`. This plan's Phase 1 updates that stale reference.

---

## 2. Current State Audit Summary

| Issue | Severity | Location | Notes |
|-------|----------|----------|-------|
| `weights_ready()` ignores w2v-bert | P0 | `tts_server.py:46-52` | `install_backend.verify_model_weights` requires `w2v-bert-2.0/config.json` |
| Stale `api.py` in install plan | P0 | `pilot_tts_installation/plan.md:314` | Doc drift |
| `import time` unused | P1 | `tts_server.py:6` | Dead import |
| Chinese API messages | P1 | Throughout `tts_server.py` | Violates coding-standards |
| Temp wav leak | P1 | `synthesize()` `delete=False` | No cleanup after `FileResponse` |
| `PILOT_TTS_AUTO_LOAD` mismatch | P1 | `main()` default `"1"` vs spawn `"0"` | Bridge expects explicit `/load` |
| Lazy `demo` import undocumented | P1 | `load_gpu_engine`, `synthesize` | Constitution exception needed |
| `os.chdir` in `load_gpu_engine` | P2 | `tts_server.py:101` | Process-global side effect |
| WebUI port default `8090` | — | `pilot-tts-paths.ts:90` | Correct; production TTS uses `4323` only |
| `inferencePresent` field | P2 | `health()` line 131 | Checks `inference.py`; integration uses `demo.py` |
| Bridge `isPilotTtsWeightsReady` gap | P2 | `pilot-tts-paths.ts:110-114` | Same w2v-bert omission |

---

## 3. Technical Design

### 3.1 P0 — Align `weights_ready()` with Installer

Extract parity rules from `install_backend.verify_model_weights`:

```python
def weights_ready() -> bool:
    root = weights_dir()
    checkpoint_ok = (
        (root / "pilot_tts.pt").is_file()
        or (root / "pilot_tts_instruct.pt").is_file()
    )
    w2v_config = root / "w2v-bert-2.0" / "config.json"
    w2v_ok = w2v_config.is_file() and w2v_config.stat().st_size > 0
    return checkpoint_ok and w2v_ok
```

Optional refactor: shared helper module `pilot_tts/server/weight_checks.py` imported by both installer and sidecar — **deferred** to keep scope minimal; inline parity is acceptable for P0.

### 3.2 P1 — English Error Surface

Systematically replace `_load_error`, `HTTPException.detail`, JSON `message`, and `/health` `message` with English strings (see `spec.md` FR-002 table). Internal log comments remain Chinese.

### 3.3 P1 — Temp WAV Cleanup via BackgroundTasks

```python
from fastapi import BackgroundTasks

@app.post("/v1/synthesize")
async def synthesize(body: SynthesizeRequest, background_tasks: BackgroundTasks):
    # ... synthesis ...
    background_tasks.add_task(_cleanup_temp_wav, out_path)
    return FileResponse(out_path, media_type="audio/wav", filename="pilot.wav")

def _cleanup_temp_wav(path: str) -> None:
    # 合成响应发送后删除临时 wav 文件
    Path(path).unlink(missing_ok=True)
```

Also call `_cleanup_temp_wav` in `except` when `out_path` was created.

### 3.4 P1 — `PILOT_TTS_AUTO_LOAD` Policy (Recommended)

**Recommendation**: Option B — set in `run.bat api`:

```batch
set "PILOT_TTS_AUTO_LOAD=0"
```

Keep `main()` default as-is for backward-compatible manual `python server/tts_server.py` invocations, but document that Bridge and `run.bat api` both disable auto-load. Alternative Option A (change `main()` default to off) is acceptable if preferred for stricter parity.

Rationale: Bridge resource scheduler calls `POST /load` after spawn when user enables TTS lane; eager load in sidecar races scheduler VRAM accounting.

### 3.5 P1 — `demo.py` Integration Contract

Upstream functions (expected signature from audit; verify against cloned `upstream/demo.py` at implementation time):

| Function | Called from | Expected args |
|----------|-------------|---------------|
| `load_engine` | `load_gpu_engine()` | `config_path: str`, `checkpoint: str` |
| `synthesize` | `synthesize()` | `engine`, `text: str`, `prompt_wav: str`, `output_path: str` |

Preconditions before import:
1. `ensure_upstream_on_path()`
2. `os.chdir(upstream_dir())` — **P2 candidate for removal** after testing with absolute paths

Add Chinese block comment before each lazy import citing constitution exception (upstream not pip-installable).

### 3.6 P2 — `os.chdir` Mitigation

Investigation steps:
1. Attempt `load_engine` with only absolute `config_path` / `checkpoint` and no chdir.
2. If upstream requires cwd, wrap in try/finally restoring previous cwd via `Path.cwd()`.
3. Document residual requirement in `plan.md` changelog.

### 3.7 P2 — `inferencePresent` Field

Options:
*   **A (preferred)**: Add `demoPresent: (upstream / "demo.py").is_file()`; keep `inferencePresent` deprecated alias for one release.
*   **B**: Replace `inferencePresent` with `demoPresent` only if Bridge/Web do not consume the field (grep shows Bridge `probePilotTtsHealth` does not read it).

### 3.8 Phase 4 — Bridge Integration

| File | Change |
|------|--------|
| `pilot-tts-paths.ts` | Keep `resolvePilotTtsWebuiPort()` default `8090`; extend `isPilotTtsWeightsReady()` with w2v-bert check |
| `tts.ts` | Keep `ports.note` string: `8090` for optional test/debug WebUI |
| `pilot-tts-spawn.ts` | No change expected (`PILOT_TTS_AUTO_LOAD=0` already correct) |
| `pilot-tts-lifecycle.ts` | Verify health probe tolerates English messages |

---

## 4. File Touch Map

| Phase | Files |
|-------|-------|
| 1 | `docs/plans/pilot_tts_installation/plan.md`, this plan package |
| 2 | `pilot_tts/server/tts_server.py` (`weights_ready`) |
| 3 | `pilot_tts/server/tts_server.py` (errors, cleanup, imports, comments, auto-load/run.bat) |
| 4 | `apps/bridge/src/services/pilot-tts-paths.ts`, `apps/bridge/src/routes/tts.ts`, tests |
| 5 | Manual verification checklist |

**Out of scope**: `install_backend.py` logic changes (already correct), upstream `demo.py` modifications, Web UI React changes.

---

## 5. Verification Plan

1. **Weight partial state**: Delete only `w2v-bert-2.0/` → `/health` shows `weightsReady: false`.
2. **Full install**: After `install.bat` → `weightsReady: true`, `POST /load` succeeds.
3. **English errors**: Trigger each error path; assert no CJK in JSON/message.
4. **Temp cleanup**: Run 10× `/synthesize`; count `pilot*.wav` in temp dir → 0 after responses complete.
5. **Bridge spawn**: Start TTS from Web → sidecar on 4323, auto-load off until `/load`.
6. **Ports**: `/tts/status` reports production API `4323` and optional WebUI `8090`.
7. **run.bat api**: Launches `server/tts_server.py`, responds on 4323.

---

## 6. Risk Register

| Risk | Mitigation |
|------|------------|
| Upstream `demo.py` requires cwd | P2 investigation; restore cwd if needed |
| Bridge tests assume WebUI port 8090 | No change expected; `8090` is the correct default |
| `inferencePresent` consumers unknown | Grep repo before rename |
| BackgroundTasks cleanup on client disconnect | Accept best-effort; optional periodic temp sweep later |
