# PilotTTS `tts_server.py` Refactor Functional Specification (spec.md)

## 1. User Scenarios & User Stories

Priorities follow audit classification: **P0 > P1 > P2**.

### P0: Accurate Weight Readiness (Install Parity)
*   **User Story**: As a user who ran `install.bat` and downloaded weights, I want the TTS API `/health` endpoint to report `weightsReady: false` until **both** the PilotTTS checkpoint and the `w2v-bert-2.0` encoder directory are present — matching what the installer verifies — so Bridge does not offer synthesis when the engine cannot actually load.
*   **Acceptance Criteria**:
    *   `weights_ready()` returns `true` only when at least one of `pilot_tts.pt` / `pilot_tts_instruct.pt` exists **and** `pretrained_models/w2v-bert-2.0/config.json` exists and is non-empty (aligned with `install_backend.verify_model_weights`).
    *   `GET /health` exposes `weightsReady` consistent with the above.
    *   `POST /load` and `POST /synthesize` return English 503 responses when w2v-bert is missing.

### P0: Documented API Launch Path
*   **User Story**: As a developer or operator running `run.bat api`, I want documentation to clearly state that the API service is `pilot_tts/server/tts_server.py` on port `4323`, not the legacy upstream `api.py`.
*   **Acceptance Criteria**:
    *   `docs/plans/pilot_tts_installation/plan.md` §4.1 example no longer references `upstream/api.py`.
    *   `docs/plans/pilot_tts_server/plan.md` documents the `run.bat api` → `server/tts_server.py` flow.
    *   `pilot_tts/run.bat` behavior (already correct) is cited as the canonical manual launch path.

### P1: Coding Standards Compliance (English API Surface)
*   **User Story**: As a Bridge/Web consumer parsing error messages, I want all HTTP `detail` and JSON `message` fields from `tts_server.py` to be English so they are consistent with project coding standards and easier to log/display internationally.
*   **Acceptance Criteria**:
    *   No Chinese strings in `HTTPException(detail=...)`, JSON `message`, or `loadError` values intended for API consumers.
    *   Chinese comments remain in code for internal documentation.

### P1: Synthesis Temp File Cleanup
*   **User Story**: As a long-running TTS service user, I want temporary `.wav` files created during synthesis to be deleted after the audio is delivered, so `%TEMP%` does not grow unbounded.
*   **Acceptance Criteria**:
    *   After `FileResponse` completes (or on error after file creation), the temp wav path is removed.
    *   Implementation uses FastAPI `BackgroundTasks` or equivalent reliable cleanup.
    *   Repeated `/synthesize` calls do not accumulate orphaned `.wav` files in the system temp directory.

### P1: `PILOT_TTS_AUTO_LOAD` Alignment
*   **User Story**: As a Bridge operator relying on explicit GPU warmup (`POST /load`), I want startup auto-load behavior to be consistent: Bridge spawns with `PILOT_TTS_AUTO_LOAD=0`, and manual `run.bat api` behavior is documented (recommend `0` for parity or explicit opt-in).
*   **Acceptance Criteria**:
    *   Default when unset in `tts_server.main()` aligns with Bridge spawn (`0` / disabled) OR `run.bat api` explicitly sets `PILOT_TTS_AUTO_LOAD=0`.
    *   Documented in `plan.md` which path triggers eager `load_gpu_engine()` on startup.

### P1: Dead Code Removal
*   **User Story**: As a maintainer, I want unused imports removed to keep static analysis clean.
*   **Acceptance Criteria**:
    *   `import time` removed from `tts_server.py` (currently unused).

### P1: `demo.py` Contract Documentation
*   **User Story**: As a future contributor, I want the lazy `demo.py` import pattern documented so reviewers do not flag it as a standards violation.
*   **Acceptance Criteria**:
    *   `constitution.md` §2.4 documents the exception.
    *   `plan.md` describes `load_engine` and `synthesize` call contract (parameters, cwd assumptions).
    *   Inline Chinese comment before lazy import blocks explains rationale.

### P2: Reduce `os.chdir` Reliance
*   **User Story**: As a maintainer running multiple Python sidecars, I want `tts_server.py` to avoid mutating process cwd where possible, reducing subtle bugs when upstream code evolves.
*   **Acceptance Criteria**:
    *   Evaluate whether `load_engine` / `synthesize` work with absolute paths only.
    *   If `os.chdir` remains, document why and scope it minimally (context manager or restore previous cwd).

### P2: Health Field `inferencePresent` Accuracy
*   **User Story**: As a Bridge diagnostics consumer, I want `/health` presence flags to reflect files actually used by the sidecar integration.
*   **Acceptance Criteria**:
    *   Evaluate replacing `(upstream_dir / "inference.py").is_file()` with `demo.py` presence or rename field to `demoPresent` with Bridge compatibility assessment.
    *   Decision documented; breaking changes avoided unless Bridge updated in same phase.

### P2: Bridge WebUI Port `8090` (Verified — Not Production Path)
*   **User Story**: As a user opening the optional PilotTTS WebUI from Bridge status, I want the reported and default WebUI port to be `8090` (test/debug Gradio UI), while production read-aloud uses `4323` via `tts_server.py`.
*   **Acceptance Criteria**:
    *   `apps/bridge/src/services/pilot-tts-paths.ts` `resolvePilotTtsWebuiPort()` default remains `8090` (or documents env override).
    *   `apps/bridge/src/routes/tts.ts` status `ports.note` references `8090` for WebUI and `4323` for production API.

### Extension P1: Voice Sample / Prompt Audio (音色)
*   **User Story**: As a ChattingCursor user configuring local TTS, I want to set a default reference speaker audio (音色) in settings and optionally override it per synthesis request, so read-aloud matches my chosen voice without opening the `8090` WebUI for every message.
*   **Acceptance Criteria**:
    *   `PILOT_TTS_PROMPT_WAV` env remains the sidecar default when no per-request override is sent.
    *   `POST /synthesize` accepts optional `promptWav` (absolute path on the Bridge host); sidecar validates the file exists and the extension is `.wav` or `.mp3` (case-insensitive) before synthesis.
    *   PilotTTS upstream inference accepts MP3 reference audio for voice cloning (not WAV-only).
    *   Bridge persists user default `promptWavPath` in settings and merges it into proxied requests when the client omits `promptWav`.
    *   Text-only clients (no `promptWav`) continue to work with env/default resolution.

### Extension P2: Emotion / Tone (语气) and Paralinguistic Tags (语调)
*   **User Story**: As a user, I want to configure a default emotion (语气) and optionally embed paralinguistic tags (语调, e.g. `<|LAUGH|>`) in text, so PilotTTS instruct synthesis sounds expressive without manual WebUI tuning.
*   **Acceptance Criteria**:
    *   `POST /synthesize` accepts optional `emotion` (upstream tag, e.g. `happy`, `neutral`, `unknown`).
    *   Paralinguistic tags remain inline in `text` (no separate API field); sidecar forwards `text` unchanged to `demo.synthesize`.
    *   When `emotion` is present (or configured default is non-empty), sidecar loads/uses `pilot_tts_instruct.pt` + `infer_pilot_tts_instruct.yaml`.
    *   Bridge forwards `emotion` from client or persisted default; English 400 when `emotion` is sent but instruct weights missing.

### Extension P3: Language / Dialect (语言/方言)
*   **User Story**: As a user speaking regional Chinese, I want to select a dialect code (e.g. `zh-henan`) in TTS settings or per request, so ChattingCursor read-aloud uses PilotTTS dialect synthesis.
*   **Acceptance Criteria**:
    *   `POST /synthesize` accepts optional `language` (upstream dialect tag, e.g. `zh-henan`, `zh-shanghai`; omit for default Mandarin).
    *   When `language` is present, instruct checkpoint is required (same rule as emotion).
    *   Bridge persists default `language` and forwards per-request override.
    *   Web config page (deferred UI) documents supported dialect list aligned with upstream README.

---

## 2. Functional Requirements (FR)

### FR-001: Extended `weights_ready()`
*   Must check `weights_dir / "w2v-bert-2.0" / "config.json"` exists and `stat().st_size > 0`.
*   Must retain existing checkpoint checks (`pilot_tts.pt` OR `pilot_tts_instruct.pt`).
*   Logic should mirror `install_backend.verify_model_weights()` without importing install scripts at runtime.

### FR-002: English Error Catalog
Replace Chinese API strings with English equivalents (examples):

| Location | Current (zh) | Target (en) |
|----------|--------------|-------------|
| `_load_error` weights | 权重未安装 | Model weights are not installed |
| `_load_error` prompt | 未找到 prompt.wav... | prompt.wav not found; set PILOT_TTS_PROMPT_WAV |
| `/load` 503 | 权重未安装 | Model weights are not installed |
| `/load` 503 fallback | GPU 加载失败 | GPU engine failed to load |
| `/synthesize` 400 | text 不能为空 | text must not be empty |
| `/health` message | PilotTTS 已在 GPU 预热 | PilotTTS GPU engine is warm |
| `/health` degraded | 请运行 install.bat... | Run pilot_tts/install.bat and POST /load |
| synthesize 503 JSON | PilotTTS 权重未安装 | PilotTTS model weights are not installed |

### FR-003: Temp WAV Lifecycle
*   Create temp file with `tempfile.NamedTemporaryFile(..., delete=False)` (required for `FileResponse` path access).
*   Register `BackgroundTasks` callback to `Path(out_path).unlink(missing_ok=True)` after response.
*   On synthesis exception after file creation, delete temp file in `except` block.

### FR-004: `PILOT_TTS_AUTO_LOAD` Policy
*   Bridge (`pilot-tts-spawn.ts`) sets `PILOT_TTS_AUTO_LOAD` to `"0"` when unset.
*   `tts_server.main()` currently defaults auto-load **on** (`"1"`). Align via one of:
    *   (A) Change default in `main()` to off (`"0"`), matching Bridge; or
    *   (B) Set `PILOT_TTS_AUTO_LOAD=0` in `run.bat api` branch.
*   Document chosen policy in `plan.md`.

### FR-005: Documentation Cross-References
*   Update `docs/plans/pilot_tts_installation/plan.md` §4.1 batch example: `api.py` → `server/tts_server.py`.
*   Cross-link `docs/plans/pilot_tts_server/` from `docs/plans/ARCHITECTURE.md` PilotTTS section (optional note in tasks).

### FR-006: Bridge Weight Check Parity (Related)
*   `apps/bridge/src/services/pilot-tts-paths.ts` `isPilotTtsWeightsReady()` should apply the same w2v-bert rule as FR-001 to avoid Bridge/sidecar disagreement.

### FR-007: Extended `SynthesizeRequest` (Sidecar)
*   Extend Pydantic model with optional fields (all omitted = backward compatible):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `text` | `str` | required | Max 500 chars; may contain paralinguistic tags |
| `promptWav` | `str \| null` | `null` | Absolute path override (`.wav` or `.mp3`); fallback chain below |
| `emotion` | `str \| null` | `null` | Upstream emotion tag; omit for model default |
| `language` | `str \| null` | `null` | Upstream dialect code; omit for default Mandarin |

*   Prompt wav resolution order: `body.promptWav` → `PILOT_TTS_PROMPT_WAV` env → auto-resolve under `upstream/` (`asset/prompt.wav`, etc.). Per-request and env paths must use `.wav` or `.mp3` extensions; upstream `demo.synthesize` loads both formats for reference audio.
*   Pass only non-null optional kwargs to `demo.synthesize` (do not pass `emotion=None` if upstream treats it differently).

### FR-008: Instruct vs Base Checkpoint Selection
*   **Base** (`pilot_tts.pt` + `infer_pilot_tts.yaml`): voice cloning only; used when neither request nor configured default supplies `emotion` or `language`.
*   **Instruct** (`pilot_tts_instruct.pt` + `infer_pilot_tts_instruct.yaml`): required when `emotion` or `language` is non-empty after merging request + defaults.
*   If instruct controls requested but `pilot_tts_instruct.pt` missing → 503 JSON `{ error: "instruct_weights_missing", message: "...", fallback: true }`.
*   Engine reload policy: if loaded checkpoint type mismatches required type, call `load_gpu_engine()` with appropriate yaml/checkpoint (document in plan §3.10).

### FR-009: Bridge `/tts/synthesize` Passthrough
*   Accept JSON body extending current `{ text }`:

```json
{
  "text": "今天真好啊！",
  "promptWav": "C:/Users/me/voices/ref.wav",
  "emotion": "happy",
  "language": null
}
```

*   Merge persisted TTS defaults before proxying to sidecar (see FR-011).
*   Forward the merged body to `POST http://127.0.0.1:4323/synthesize` unchanged (field names camelCase end-to-end).
*   Preserve existing audio buffer proxy and `{ error, message, fallback }` error handling.

### FR-010: Spawn Environment Defaults
*   `pilot-tts-spawn.ts` continues to set `PILOT_TTS_AUTO_LOAD=0`; optionally inject `PILOT_TTS_PROMPT_WAV` from persisted settings when sidecar starts (Phase 7).
*   Per-request `promptWav` overrides env without restart when sidecar resolves at synthesize time.

### FR-011: Config Persistence Schema
*   Extend `scheduler-settings.json` (via `scheduler-settings.ts`) **or** add sibling `tts-settings.json` under ChattingCursor home — **recommended**: extend `SchedulerUserSettings` to avoid a second settings file:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `pilotTtsPromptWavPath` | `string` | `""` | Default 音色 (absolute path) |
| `pilotTtsDefaultEmotion` | `string` | `""` | Default 语气; empty = omit |
| `pilotTtsDefaultLanguage` | `string` | `""` | Default 方言; empty = omit |

*   Expose via existing `GET/POST /local/scheduler-settings` (Web `TtsSubPage` already reads scheduler settings for API toggle).
*   `useSpeech.ts` reads defaults via `fetchSchedulerSettings` (or dedicated helper) and includes them in `/tts/synthesize` body.

### FR-012: Config Page Data Flow (Specified, UI Deferred)
*   `TtsSubPage` (future tasks): file picker or path input for prompt wav; dropdown for emotion; dropdown for dialect; save via `saveSchedulerSettings`.
*   `8090` WebUI remains optional advanced tuning path; production read-aloud uses `4323` with persisted settings.
*   Validation: Bridge rejects non-absolute `promptWavPath` on save; sidecar rejects missing files on synthesize.

### FR-013: Upstream Parameter Alignment
*   Sidecar `demo.synthesize` call must match upstream signature (verify on cloned `upstream/demo.py`):

```python
synthesize(
    engine,
    text: str,
    prompt_wav: str,
    output_path: str,
    emotion: str | None = None,   # instruct only
    language: str | None = None,  # instruct only
)
```

*   Supported emotion tags (instruct): `happy`, `sad`, `angry`, `surprise`, `fear`, `disgust`, `serious`, `concern`, `blue`, `disdain`, `neutral`, `psychology`, `unknown`.
*   Paralinguistic tags in `text` (instruct): `<|LAUGH|>`, `<|BREATH|>`, `<|COUGH|>`, `<|CRY|>`, span variants per upstream README.
*   Dialect codes (instruct): `zh-dongbei`, `zh-shandong`, `zh-henan`, `zh-shanxi`, `zh-minnan`, `zh-gansu`, `zh-ningxia`, `zh-shanghai`, `zh-chongqing`, `zh-hubei`, `zh-hunan`, `zh-jiangxi`, `zh-guizhou`, `zh-yunnan`.

---

## 3. Boundary Conditions & Non-Functional Requirements

### 3.1 Boundary Conditions
*   **Upstream absent**: If `upstream/` not cloned, `upstreamPresent` is false; load fails with clear English message.
*   **Instruct checkpoint only**: `weights_ready()` true when `pilot_tts_instruct.pt` + w2v-bert present (instruct yaml path already handled in `load_gpu_engine`).
*   **Bridge spawn cwd**: `pilot-tts-spawn.ts` sets `cwd: upstreamDir`; `tts_server.py` resolves paths via `PILOT_TTS_*` env — must remain robust regardless of cwd.
*   **No pip install of demo**: Do not add `demo` to `requirements-inference.txt` as a package; keep sys.path pattern.
*   **Extension backward compat**: Requests with only `{ "text": "..." }` behave as today (base model if available, env prompt wav).
*   **Path security**: Sidecar only accepts `promptWav` paths that exist as regular files with `.wav` or `.mp3` suffix; no URL fetch in v1.
*   **Instruct-only controls**: Emotion/dialect without instruct weights → explicit 503, not silent base-model fallback.

### 3.2 Non-Functional Requirements
*   **No breaking route changes**: Keep dual `/v1/*` aliases.
*   **Minimal diff scope**: P0/P1 refactor changes confined primarily to `tts_server.py`; extension Bridge/Web in Phases 6–8.
*   **No install script changes** in this plan unless required for shared weight-check helper (prefer inline parity in sidecar).
*   **English API messages** for all new validation errors (invalid path, unknown emotion tag optional strict mode deferred).

---

## 4. Measurable Success Criteria

| Metric ID | Dimension | Target |
| :--- | :--- | :--- |
| **SC-001** | Weight parity | Sidecar `weightsReady` false when w2v-bert missing, even if `.pt` exists |
| **SC-002** | English surface | 100% API-facing error/message strings in English |
| **SC-003** | Temp file hygiene | 0 orphaned temp wav after 100 sequential synthesize calls |
| **SC-004** | Auto-load policy | Documented and consistent Bridge + run.bat behavior |
| **SC-005** | Port alignment | Production API `4323`; optional WebUI default `8090` in Bridge paths and status note |
| **SC-006** | Doc accuracy | No `api.py` references in installation plan startup section |
| **SC-007** | Voice override | Per-request `promptWav` (`.wav` or `.mp3`) changes output timbre vs default env reference audio |
| **SC-008** | Emotion path | `emotion: "happy"` via Bridge produces audibly different output vs neutral/omitted (instruct weights present) |
| **SC-009** | Dialect path | `language: "zh-henan"` synthesizes with dialect characteristics (instruct weights present) |
| **SC-010** | Backward compat | `{ "text" }` only — no regression vs pre-extension behavior |
| **SC-011** | Settings round-trip | Saved `pilotTtsPromptWavPath` / emotion / language appear in `/tts/synthesize` proxy without WebUI |
