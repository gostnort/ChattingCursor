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

**Phase 1 note**: `docs/plans/pilot_tts_installation/plan.md` §4.1 now matches `pilot_tts/run.bat` (`server\tts_server.py` on `4323`; no legacy `upstream/api.py`).

### 1.1 Manual Launch Reference (Operators)

Use `pilot_tts/run.bat` for **standalone** test and debug. ChattingCursor production read-aloud is always **Bridge → `server/tts_server.py` :4323**; the default `run.bat` branch is not the production TTS path.

| Goal | Command (from repo root) | URL |
|------|--------------------------|-----|
| Manual API sidecar test | `cd pilot_tts` → `run.bat api` | `http://127.0.0.1:4323/health` |
| Optional Gradio WebUI (test/debug) | `cd pilot_tts` → `run.bat` | `http://127.0.0.1:8090` |
| Stop services on 4323 / 8090 | `cd pilot_tts` → `shutdown.bat` | — |

**Prerequisites**: Run `pilot_tts/install.bat` once so `.venv` and `upstream/` exist.

**`run.bat api` → `server/tts_server.py` (port 4323)**:
1. Sets `PILOT_TTS_PORT=4323` (override with env before launch if needed).
2. Sets `PILOT_TTS_AUTO_LOAD=0` — GPU is **not** loaded at startup; call `POST http://127.0.0.1:4323/load` to warm up (same policy as Bridge spawn).
3. Runs `.venv\Scripts\python.exe server\tts_server.py` — project-owned sidecar, **not** `upstream/api.py`.

**Default `run.bat` → `upstream/webui.py` (port 8090, test/debug only)**:
1. `cd upstream` and launch `webui.py --port 8090` with Gradio env vars (`GRADIO_SERVER_PORT=8090`, etc.).
2. Used for voice tuning in a browser; Bridge `/tts/synthesize` proxies to the **4323** sidecar instead.

---

## 2. Current State Audit Summary

| Issue | Severity | Location | Notes |
|-------|----------|----------|-------|
| `weights_ready()` ignores w2v-bert | P0 | `tts_server.py:46-52` | `install_backend.verify_model_weights` requires `w2v-bert-2.0/config.json` |
| ~~Stale `api.py` in install plan~~ | — | `pilot_tts_installation/plan.md` §4.1 | **Fixed Phase 1** — shows `server/tts_server.py` |
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

Upstream `demo.py` is a **git-cloned script**, not an installable Python package. Sidecar code must prepare the import environment at call time and import inside functions only (constitution §2.4).

**Lazy-import rationale** (for reviewers):
- Top-level `from demo import ...` fails when `upstream/` is missing and prevents FastAPI from serving `/health` during partial installs.
- `demo` pulls heavy inference dependencies; defer import until `/load` or `/synthesize` needs the GPU engine.
- `sys.path` insertion and optional `os.chdir` must run **before** import; function-scoped imports keep that ordering explicit.

**`sys.path` injection** — `ensure_upstream_on_path()` in `tts_server.py`:
- Resolve root via `PILOT_TTS_UPSTREAM_DIR` or default `<pilot_tts>/upstream`.
- If absent from `sys.path`, `sys.path.insert(0, str(upstream_dir()))` so `import demo` resolves to `upstream/demo.py`.

**Working directory** — `load_gpu_engine()` only:
- `os.chdir(str(upstream_dir()))` before `load_engine`; upstream YAML/assets may assume repo-root cwd.
- P2 task tests whether absolute `config_path` / `checkpoint` remove this requirement.

**Function signatures** (from `tts_server.py` call sites; re-verify against cloned `upstream/demo.py` when upstream is present):

| Function | Expected signature | Sidecar caller | Arguments passed |
|----------|-------------------|----------------|------------------|
| `load_engine` | `load_engine(*, config_path: str, checkpoint: str) -> Any` | `load_gpu_engine()` | `config_path`: `configs/infer_pilot_tts.yaml` or `infer_pilot_tts_instruct.yaml`; `checkpoint`: absolute path to `pilot_tts.pt` or `pilot_tts_instruct.pt` under `weights_dir()` |
| `synthesize` | `synthesize(engine, *, text: str, prompt_wav: str, output_path: str, emotion: str \| None = None, language: str \| None = None) -> None` | `synthesize()` route | Base: text + prompt_wav only. Instruct: add `emotion` / `language` when non-empty after merge. Paralinguistic tags stay in `text`. |

**Import sites** (only these two; no other `from demo import` in the sidecar):
1. `load_gpu_engine()` — after `ensure_upstream_on_path()` and `os.chdir`, `from demo import load_engine`.
2. `synthesize()` handler — after `ensure_upstream_on_path()`, `from demo import synthesize` (no chdir on synthesize path today).

Phase 3 adds a Chinese single-line comment before each block citing constitution §2.4 (upstream not pip-installable).

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

### 3.9 Extension — Extended `SynthesizeRequest` (Phase 6)

Current sidecar model (`tts_server.py`):

```python
class SynthesizeRequest(BaseModel):
    text: str
    promptWav: str | None = None
    emotion: str | None = None
    language: str | None = None
```

Example request (production API `:4323`):

```json
{
  "text": "今天天气真好啊<|LAUGH|>我们去公园吧！",
  "promptWav": "D:/voices/my_ref.wav",
  "emotion": "happy",
  "language": "zh-henan"
}
```

Minimal backward-compatible request:

```json
{ "text": "Hello world" }
```

**Prompt wav resolution** (sidecar):

1. `body.promptWav` if set, file exists, and suffix is `.wav` or `.mp3` (case-insensitive)
2. `PILOT_TTS_PROMPT_WAV` env (same extension rule when validating user paths)
3. Auto candidates under `upstream/` (`asset/prompt.wav`, `assert/prompt.wav`, `assets/prompt.wav`)

**Upstream demo behavior**: PilotTTS inference accepts MP3 reference audio for voice cloning via `prompt_wav` (torchaudio/librosa decode), not WAV-only. Sidecar validation must allow both extensions on the transmission chain; auto-resolve defaults remain upstream `.wav` assets.

**Validation** (Phase 6 sidecar + Bridge save):

```python
ALLOWED_PROMPT_SUFFIXES = {".wav", ".mp3"}

def is_valid_prompt_path(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in ALLOWED_PROMPT_SUFFIXES
```

Reject other extensions with English 400/503 JSON before synthesis.

**Synthesis kwargs builder** (pseudocode):

```python
kwargs = {"text": text[:500], "prompt_wav": str(prompt), "output_path": out_path}
if emotion:
    kwargs["emotion"] = emotion
if language:
    kwargs["language"] = language
synthesize(_engine, **kwargs)
```

### 3.10 Extension — Instruct vs Base Engine Selection

| Condition | Checkpoint | Config YAML |
|-----------|------------|-------------|
| No `emotion`, no `language` (after defaults merge) | `pilot_tts.pt` (prefer) | `infer_pilot_tts.yaml` |
| Any non-empty `emotion` or `language` | `pilot_tts_instruct.pt` (required) | `infer_pilot_tts_instruct.yaml` |
| Base missing, instruct present | `pilot_tts_instruct.pt` | instruct yaml |

`load_gpu_engine(force_instruct: bool)` tracks loaded mode in module-global `_engine_mode: "base" | "instruct"`. On `/synthesize`, if required mode ≠ loaded mode, reload engine before inference (accept one-time latency hit).

If instruct requested but `pilot_tts_instruct.pt` absent → 503 `instruct_weights_missing`.

Paralinguistic tags (`<|LAUGH|>`, etc.) do not force instruct by themselves in v1 — they pass through `text`; recommend instruct checkpoint when tags present (Bridge may set default emotion or document in UI).

### 3.11 Extension — Bridge `/tts/synthesize` (Phase 7)

`apps/bridge/src/routes/tts.ts` today:

```typescript
body: JSON.stringify({ text })
```

Target:

```typescript
const settings = await readSchedulerUserSettings();
const merged = {
  text,
  promptWav: body.promptWav ?? settings.pilotTtsPromptWavPath || undefined,
  emotion: body.emotion ?? settings.pilotTtsDefaultEmotion || undefined,
  language: body.language ?? settings.pilotTtsDefaultLanguage || undefined,
};
// strip empty strings → omit keys
body: JSON.stringify(merged)
```

Add validation: if merged `emotion`/`language` set and only base weights exist, return 503 before sidecar call.

### 3.12 Extension — Settings Schema (Phase 7–8)

Extend `SchedulerUserSettings` in `scheduler-settings.ts`:

```typescript
pilotTtsPromptWavPath: string;      // default ""
pilotTtsDefaultEmotion: string;     // default ""
pilotTtsDefaultLanguage: string;    // default ""
```

Mirror in `apps/web/src/api/bridge.ts` `SchedulerSettingsPayload`.

Optional spawn injection (`pilot-tts-spawn.ts`):

```typescript
PILOT_TTS_PROMPT_WAV: settings.pilotTtsPromptWavPath || readEnv("PILOT_TTS_PROMPT_WAV") || "",
```

Per-request override still wins at synthesize time without respawn.

### 3.13 Extension — Config Page → Read-Aloud Data Flow (Phase 8, Spec)

```
TtsSubPage (voice settings UI)
    │ saveSchedulerSettings({ pilotTtsPromptWavPath, pilotTtsDefaultEmotion, pilotTtsDefaultLanguage })
    ▼
scheduler-settings.json (ChattingCursor home)
    │
    ├─► pilot-tts-spawn.ts (optional PILOT_TTS_PROMPT_WAV on start)
    │
    └─► useSpeech.ts toggleSpeak()
            │ fetchSchedulerSettings() or cached defaults
            │ POST /tts/synthesize { text, promptWav?, emotion?, language? }
            ▼
        Bridge tts.ts (merge defaults)
            ▼
        tts_server.py :4323
            │ resolve prompt + engine mode
            ▼
        demo.synthesize(engine, ...)
```

`8090` WebUI (`upstream/webui.py`) remains manual test/debug; not on production read-aloud path.

### 3.14 Extension — `useSpeech.ts` Integration

*   Load TTS defaults once per hook init or per `toggleSpeak` (cache in ref to avoid extra round-trips).
*   Include merged fields in `tryPilotTtsSynthesize` body.
*   Do not inject paralinguistic tags automatically in v1 (user/editor responsibility); emotion/language from settings only.
*   Browser `speechSynthesis` fallback unchanged when Pilot unavailable.

---

## 4. File Touch Map

| Phase | Files |
|-------|-------|
| 1 | `docs/plans/pilot_tts_installation/plan.md`, this plan package |
| 2 | `pilot_tts/server/tts_server.py` (`weights_ready`) |
| 3 | `pilot_tts/server/tts_server.py` (errors, cleanup, imports, comments, auto-load/run.bat) |
| 4 | `apps/bridge/src/services/pilot-tts-paths.ts`, `apps/bridge/src/routes/tts.ts`, tests |
| 5 | Manual verification checklist |
| 6 | `pilot_tts/server/tts_server.py` (extended request, engine mode, demo kwargs) |
| 7 | `apps/bridge/src/routes/tts.ts`, `scheduler-settings.ts`, `pilot-tts-spawn.ts`, tests |
| 8 | `apps/web/src/components/TtsSubPage.tsx`, `useSpeech.ts`, `api/bridge.ts` |
| 9 | E2E verification (Bridge + sidecar + settings round-trip) |

**Out of scope**: `install_backend.py` logic changes (already correct), upstream `demo.py` modifications, Web UI React changes beyond Phase 8 TTS settings fields.

---

## 5. Verification Plan

1. **Weight partial state**: Delete only `w2v-bert-2.0/` → `/health` shows `weightsReady: false`.
2. **Full install**: After `install.bat` → `weightsReady: true`, `POST /load` succeeds.
3. **English errors**: Trigger each error path; assert no CJK in JSON/message.
4. **Temp cleanup**: Run 10× `/synthesize`; count `pilot*.wav` in temp dir → 0 after responses complete.
5. **Bridge spawn**: Start TTS from Web → sidecar on 4323, auto-load off until `/load`.
6. **Ports**: `/tts/status` reports production API `4323` and optional WebUI `8090`.
7. **run.bat api**: Launches `server/tts_server.py`, responds on 4323.
8. **Extension**: `POST /synthesize` with `{ text, emotion: "happy" }` via Bridge when instruct weights installed.
9. **Extension**: `{ text, promptWav: "<valid .wav or .mp3 path>" }` uses override reference audio.
10. **Extension**: Settings saved in TtsSubPage appear in proxied synthesize without manual WebUI.

---

## 6. Risk Register

| Risk | Mitigation |
|------|------------|
| Upstream `demo.py` requires cwd | P2 investigation; restore cwd if needed |
| Bridge tests assume WebUI port 8090 | No change expected; `8090` is the correct default |
| `inferencePresent` consumers unknown | Grep repo before rename |
| BackgroundTasks cleanup on client disconnect | Accept best-effort; optional periodic temp sweep later |
| Engine reload on base↔instruct switch | Document latency; reload only when mode changes |
| Invalid user prompt wav path | Validate `.wav`/`.mp3` extension on save (Bridge) and synthesize (sidecar); English errors |
| Emotion/dialect without instruct weights | 503 instruct_weights_missing; install plan already downloads both checkpoints |

---

## 7. Executability Review

### 7.1 Dependencies Available

| Dependency | Status | Notes |
|------------|--------|-------|
| Upstream `demo.synthesize` params | **Verified** (AMAPVOICE/PilotTTS README) | `emotion`, `language`, `prompt_wav` on instruct model |
| `pilot_tts_instruct.pt` | **Expected after install** | Installer downloads both base + instruct |
| Paralinguistic tags | **Text-inline** | No API extension needed beyond `text` |
| Port model 4323 / 8090 | **Aligned** | Production API vs test WebUI unchanged |
| Speckit MCP | **Template-only** | See §7.4 |

### 7.2 Backward Compatibility

*   Optional JSON fields — omitting `promptWav`, `emotion`, `language` preserves current `{ text }`-only behavior.
*   Dual route aliases `/synthesize` and `/v1/synthesize` unchanged.
*   Bridge clients that only send `text` continue to work; defaults applied only when configured in settings.
*   Base model path preserved for voice-clone-only deployments lacking instruct weights (emotion/language requests fail explicitly).

### 7.3 Risks / Blockers

| Item | Severity | Mitigation |
|------|----------|------------|
| Engine reload latency when switching base↔instruct mid-session | Medium | Track `_engine_mode`; reload only on mismatch |
| `demo.synthesize` signature drift in upstream | Low | Phase 6 verify against cloned `upstream/demo.py` |
| Windows path validation for `promptWav` | Low | Use `pathlib.Path.is_file()` + `.wav`/`.mp3` suffix check; document absolute path requirement |
| Phase 3 refactor incomplete (Chinese errors, temp cleanup) | Medium | Complete Phases 3–5 before or in parallel with Phase 6; extension adds English errors for new fields only |
| No upstream clone in dev workspace | Low | README + GitHub API confirm contract; runtime verify post-install |

### 7.4 Speckit MCP Validation Result

Invoked `project-0-ChattingCursor-spec-kit` tools on branch `tts_upgrade`:

| Tool | Result |
|------|--------|
| `speckit_specify` | Returned template pointer only (`commands/speckit.specify`) — no generated spec artifact |
| `speckit_plan` | Returned template pointer only (`commands/speckit.plan`) |
| `speckit_tasks` | Returned template pointer only (`commands/speckit.tasks`) |

**Conclusion**: MCP validates tool availability but does not emit structured plan output in this workspace (consistent with prior session). Final spec/plan/tasks authored manually from codebase audit + upstream README. Executability confirmed via upstream public API documentation and existing install path for both checkpoints.
