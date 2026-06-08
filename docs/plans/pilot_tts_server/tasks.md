# PilotTTS `tts_server.py` Refactor Task Breakdown (tasks.md)

This task list follows the Speckit-style phase structure used in `docs/plans/pilot_tts_installation/tasks.md`. Priorities: **P0 > P1 > P2**.

---

## Phase 1: Spec Alignment & Documentation

### [x] [Task 1.1] Publish planning package
*   **Description**: Create `docs/plans/pilot_tts_server/` with `constitution.md`, `spec.md`, `plan.md`, `tasks.md` and Chinese counterparts (`*_zh.md`).
*   **Prerequisites**: Audit conclusions, `ARCHITECTURE.md`, `pilot_tts_installation/` reference style.
*   **Acceptance Criteria**:
    *   All 8 planning files exist and cross-reference ports `4323` (API) / `8090` (optional WebUI) and Bridge routes.
    *   `demo.py` lazy-import constitution exception is documented.

### [x] [Task 1.2] Fix stale `api.py` reference in installation plan
*   **Description**: Update `docs/plans/pilot_tts_installation/plan.md` §4.1 startup batch example: replace `upstream/api.py` with `server/tts_server.py`, matching actual `pilot_tts/run.bat`.
*   **Prerequisites**: Task 1.1.
*   **Acceptance Criteria**:
    *   Installation plan `run.bat` snippet shows `server\tts_server.py` for `api` mode.
    *   Port `4323` and env `PILOT_TTS_PORT` documented in snippet.

### [x] [Task 1.3] Document `run.bat api` entry in sidecar plan
*   **Description**: Ensure `plan.md` (this package) explicitly maps `run.bat api` → `server/tts_server.py` and default mode → `upstream/webui.py` on port `8090` (test/debug only).
*   **Prerequisites**: Task 1.1.
*   **Acceptance Criteria**:
    *   Operators can find manual API launch instructions without reading source.

### [x] [Task 1.4] Document `demo.py` upstream contract
*   **Description**: In `plan.md` §3.5 and `constitution.md` §2.4, document `load_engine` / `synthesize` signatures, `sys.path` injection, and lazy-import rationale (upstream not pip package).
*   **Prerequisites**: Task 1.1.
*   **Acceptance Criteria**:
    *   Reviewers have written justification for non-top-level `from demo import ...`.

---

## Phase 2: P0 Functional Fixes in `tts_server.py`

### [x] [Task 2.1] Extend `weights_ready()` for w2v-bert-2.0
*   **Description**: Update `weights_ready()` in `pilot_tts/server/tts_server.py` to require `pretrained_models/w2v-bert-2.0/config.json` exists and is non-empty, matching `install_backend.verify_model_weights()`.
*   **Prerequisites**: Task 1.1.
*   **Acceptance Criteria**:
    *   Checkpoint-only install reports `weightsReady: false` on `/health`.
    *   Full install reports `weightsReady: true`.
    *   `POST /load` returns 503 with English message when w2v-bert missing (after Task 3.1).

### [x] [Task 2.2] Verify health/load/synthesize paths use updated `weights_ready()`
*   **Description**: Confirm `health()`, `load_endpoint()`, `synthesize()`, and `main()` auto-load gate all call the updated function without duplicate logic.
*   **Prerequisites**: Task 2.1.
*   **Acceptance Criteria**:
    *   No code path sets `weightsReady: true` without w2v-bert check.

---

## Phase 3: P1 Quality & Compliance

### [x] [Task 3.1] English user-facing API messages
*   **Description**: Replace all Chinese strings in `HTTPException.detail`, JSON `message`, `_load_error`, and `/health` `message` with English per `spec.md` FR-002.
*   **Prerequisites**: Task 2.1.
*   **Acceptance Criteria**:
    *   Grep `tts_server.py` for CJK in string literals assigned to API fields → none.
    *   Chinese comments preserved.

### [x] [Task 3.2] Remove dead `import time`
*   **Description**: Delete unused `import time` from `tts_server.py`.
*   **Prerequisites**: None (can parallel with 3.1).
*   **Acceptance Criteria**:
    *   No `time` import; no linter unused-import warning.

### [x] [Task 3.3] Temp wav cleanup after synthesize
*   **Description**: Add FastAPI `BackgroundTasks` (or equivalent) to delete temp `.wav` after `FileResponse`; delete on error if file was created.
*   **Prerequisites**: Task 3.1.
*   **Acceptance Criteria**:
    *   10 sequential synthesize calls leave 0 orphan temp wav files.
    *   Successful responses still return valid audio.

### [x] [Task 3.4] Align `PILOT_TTS_AUTO_LOAD` with Bridge
*   **Description**: Implement policy from `plan.md` §3.4 (recommended: `run.bat api` sets `PILOT_TTS_AUTO_LOAD=0`; document `main()` default behavior).
*   **Prerequisites**: Task 1.3.
*   **Acceptance Criteria**:
    *   Bridge spawn + `run.bat api` both disable eager GPU load unless env overrides.
    *   `POST /load` remains the explicit warmup path for Bridge.

### [x] [Task 3.5] Inline comments for lazy `demo` imports
*   **Description**: Add Chinese single-line comments before `from demo import load_engine` and `from demo import synthesize` blocks citing constitution exception.
*   **Prerequisites**: Task 1.4.
*   **Acceptance Criteria**:
    *   Each lazy import block has purpose comment per coding-standards (>10 line blocks).

---

## Phase 4: Bridge & Related Integration

### [x] [Task 4.1] Bridge `isPilotTtsWeightsReady()` w2v-bert parity
*   **Description**: Extend `apps/bridge/src/services/pilot-tts-paths.ts` `isPilotTtsWeightsReady()` to check `w2v-bert-2.0/config.json` like sidecar `weights_ready()`.
*   **Prerequisites**: Task 2.1.
*   **Acceptance Criteria**:
    *   Bridge install snapshot `weightsReady` matches sidecar `/health` for partial/full installs.
    *   Update `pilot-tts-paths.test.ts` if needed.
*   **Done**: `isPilotTtsWeightsReady()` checks checkpoint + non-empty `w2v-bert-2.0/config.json`; test added for partial install.

### [x] [Task 4.2] WebUI port default `8090` in Bridge (verified)
*   **Description**: Confirm `resolvePilotTtsWebuiPort()` default stays `8090` in `pilot-tts-paths.ts`; `tts.ts` `ports.note` references `8090` for optional test/debug WebUI. Port `4324` was a stale misunderstanding — removed from docs and scripts.
*   **Prerequisites**: Task 1.1.
*   **Acceptance Criteria**:
    *   `/tts/status` reports `pilotWebUi: 8090` when env unset.
    *   Status note mentions `8090` for WebUI and `4323` for production API.

### [x] [Task 4.3] Evaluate `inferencePresent` health field
*   **Description**: Per `plan.md` §3.7, decide whether to add `demoPresent`, rename, or deprecate `inferencePresent` in `tts_server.py` `/health` payload.
*   **Prerequisites**: Task 2.2.
*   **Acceptance Criteria**:
    *   Decision recorded in plan changelog or task comment.
    *   Bridge `probePilotTtsHealth` unaffected or updated consistently.
*   **Done**: Option A — added `demoPresent` (`demo.py`); `inferencePresent` kept as deprecated alias mirroring `demoPresent`. Bridge probe unchanged (does not read either field).

### [x] [Task 4.4] Reduce `os.chdir` reliance (P2)
*   **Description**: Test `load_gpu_engine()` without `os.chdir`; if required, scope with cwd restore; document residual need.
*   **Prerequisites**: Task 3.5.
*   **Acceptance Criteria**:
    *   GPU load + synthesize succeed on Windows after change.
    *   `plan.md` records outcome.
*   **Done**: Removed bare `os.chdir`; conditional chdir only when `cwd != upstream` with `try/finally` restore. Bridge spawn (`cwd=upstream`) skips chdir; `run.bat api` still chdirs during load only.

---

## Phase 5: Verification & Checkpoint

### [x] [Task 5.1] Sidecar manual verification (`run.bat api`)
*   **Description**: Run `pilot_tts/run.bat api`; verify `GET http://127.0.0.1:4323/health`, `POST /load`, `POST /v1/synthesize` with sample text.
*   **Prerequisites**: Phases 2–3 complete.
*   **Acceptance Criteria**:
    *   All SC-001–SC-004 metrics in `spec.md` pass for sidecar-only testing.
*   **Done**: Live smoke on `tts_upgrade` (2026-06-08): `GET /health` → 200 (`weightsReady: true`, `demoPresent: true`, `gpuLoaded: false` with `PILOT_TTS_AUTO_LOAD=0`); `POST /load` → 200 (~39s); `POST /v1/synthesize` → 200 `audio/wav` (495440 bytes). SC-001/002/004 pass; SC-003 spot-check (1 synthesize, 0 orphan `.wav` in `%TEMP%`); full 100-call SC-003 matrix deferred to GPU bench.

### [x] [Task 5.2] Bridge integration verification
*   **Description**: Start Bridge; enable TTS lane; confirm spawn on 4323, `/tts/status` ports, synthesize via `/tts/synthesize` proxy.
*   **Prerequisites**: Phase 4 complete.
*   **Acceptance Criteria**:
    *   SC-005 and SC-006 pass.
    *   No regression in `tts-start-route.test.ts`.
*   **Done**: `pilot-tts-paths.test.ts` + `tts-start-route.test.ts` 7/7 pass (incl. w2v-bert partial install, `/tts/status` ports). SC-005 verified via `tts.ts` (`4323`/`8090` note) and tests; SC-006 via grep (no `api.py` in installation plan). Live Bridge spawn + `/tts/synthesize` proxy not run this session.

### [x] [Task 5.3] Coding standards audit
*   **Description**: Verify `tts_server.py` conforms to `coding-standards.mdc`: 2 blank lines between functions, no blank lines inside functions, Chinese comments, English API strings, pathlib usage.
*   **Prerequisites**: Phases 2–3 complete.
*   **Acceptance Criteria**:
    *   Checklist in `pilot_tts_installation/tasks.md` Task 6.1 equivalent passes for modified files.
*   **Done**: `py_compile` OK; 2 blank lines between functions; no empty lines inside functions; Chinese comments only (no CJK in API strings); `pathlib.Path` for paths (residual `os.chdir`/`os.getcwd`/`os.environ` documented in Task 4.4). `pilot-tts-paths.ts` conforms to Bridge TS conventions.

### [x] [Task 5.4] Checkpoint sign-off
*   **Description**: Mark completed tasks `[x]` in this file; note any deferred P2 items.
*   **Prerequisites**: Tasks 5.1–5.3.
*   **Acceptance Criteria**:
    *   All P0/P1 tasks checked or explicitly deferred with reason.
*   **Done**: Phases 1–5 P0/P1 complete. Deferred: SC-003 100-call temp hygiene bench; live Bridge `/tts/synthesize` E2E (covered in Phase 9). P2 Task 4.4 (`os.chdir` scoping) completed in Phase 4.

---

## Phase 6: Sidecar API Extension (Voice / Emotion / Dialect)

### [x] [Task 6.1] Extend `SynthesizeRequest` Pydantic model
*   **Description**: Add optional `promptWav`, `emotion`, `language` to `pilot_tts/server/tts_server.py` per `spec.md` FR-007. Keep `text` required.
*   **Prerequisites**: Phase 2 complete (weights_ready parity).
*   **Acceptance Criteria**:
    *   `{ "text": "hi" }` still accepted.
    *   Invalid empty `text` returns English 400.
*   **Verification**: `curl -X POST :4323/synthesize -H "Content-Type: application/json" -d '{"text":"test"}'` returns audio.
*   **Done**: `SynthesizeRequest` extended; empty `text` → 400 English `HTTPException`; `py_compile` OK.

### [x] [Task 6.2] Prompt wav per-request override
*   **Description**: Resolve `promptWav` with chain: body → `PILOT_TTS_PROMPT_WAV` → auto upstream paths. Validate file exists and suffix is `.wav` or `.mp3`; English 503/400 on missing or invalid extension.
*   **Prerequisites**: Task 6.1.
*   **Acceptance Criteria**:
    *   Valid `promptWav` path (`.wav` or `.mp3`) produces different timbre vs default.
    *   Missing file or unsupported extension returns `{ error, message, fallback: true }` in English.
*   **Verification**: Two synthesize calls with different valid wav/mp3 paths; listen or compare spectrograms.
*   **Done**: `resolve_synthesis_prompt_wav()` + `is_valid_prompt_path()`; invalid suffix → 400 `invalid_prompt_wav`; missing file → 503 `prompt_missing`.

### [x] [Task 6.3] Instruct vs base engine selection
*   **Description**: Implement `_engine_mode` tracking and `load_gpu_engine(require_instruct: bool)` per `plan.md` §3.10. Reload when mode mismatch on `/synthesize`.
*   **Prerequisites**: Task 6.1.
*   **Acceptance Criteria**:
    *   `{ text }` only uses base when `pilot_tts.pt` present.
    *   `{ text, emotion: "happy" }` uses instruct checkpoint.
    *   Instruct request without `pilot_tts_instruct.pt` → 503 `instruct_weights_missing`.
*   **Verification**: `/health` after load; synthesize with/without emotion.
*   **Done**: `_engine_mode`, `select_engine_artifacts()`, `ensure_gpu_engine()`; `/health` and `/load` expose `engineMode`; reload on mode mismatch.

### [x] [Task 6.4] Pass `emotion` and `language` to `demo.synthesize`
*   **Description**: Build kwargs dict; lazy-import `synthesize`; verify signature against cloned `upstream/demo.py`.
*   **Prerequisites**: Tasks 6.2, 6.3.
*   **Acceptance Criteria**:
    *   `language: "zh-henan"` reaches upstream when instruct weights present.
    *   Paralinguistic tags in `text` forwarded unchanged.
*   **Verification**: Sample requests from `plan.md` §3.9 example JSON.
*   **Done**: Verified `upstream/demo.py` signature (`emotion`, `language` kwargs); `synth_kwargs` passes non-empty fields only; `text` forwarded unchanged (tags preserved).

### [x] [Task 6.5] Sidecar unit/manual tests for extension
*   **Description**: Document manual test matrix in task comment or `plan.md` verification §5 items 8–10.
*   **Prerequisites**: Tasks 6.1–6.4.
*   **Acceptance Criteria**:
    *   SC-007–SC-010 pass on `run.bat api` manual run.
*   **Done**: Live smoke (2026-06-08): `{ "text": "hello world" }` → 200 wav 146000B (`engineMode: base`); `{ "emotion": "happy" }` → 200 99920B (`engineMode: instruct`); empty `text` → 400; bad `.txt` promptWav → 400. Remaining operator checks: SC-007 timbre A/B, SC-009 `zh-henan`.

---

## Phase 7: Bridge Passthrough & Spawn Defaults

### [x] [Task 7.1] Extend `SchedulerUserSettings` schema
*   **Description**: Add `pilotTtsPromptWavPath`, `pilotTtsDefaultEmotion`, `pilotTtsDefaultLanguage` to `apps/bridge/src/services/scheduler-settings.ts` with defaults `""`.
*   **Prerequisites**: Task 6.1 (sidecar accepts fields).
*   **Acceptance Criteria**:
    *   `GET/POST /local/scheduler-settings` round-trips new fields.
    *   Update `scheduler-settings.test.ts`.
*   **Verification**: Save settings via API; read back JSON file in ChattingCursor home.
*   **Done**: Schema + `local.ts` POST body extended; `scheduler-settings.test.ts` covers TTS extension fields round-trip.

### [x] [Task 7.2] Bridge `/tts/synthesize` merge and passthrough
*   **Description**: Extend `apps/bridge/src/routes/tts.ts` to merge request body with persisted defaults; proxy full JSON to sidecar `:4323`.
*   **Prerequisites**: Task 7.1.
*   **Acceptance Criteria**:
    *   Client `{ text }` + saved defaults → sidecar receives merged body.
    *   Per-request fields override saved defaults.
    *   English errors for instruct-missing when emotion/language set.
*   **Verification**: Integration test or manual Bridge curl to `/tts/synthesize`.
*   **Done**: `mergeSynthesizePayload` in `pilot-tts-synthesize.ts`; `tts.ts` merges + proxies; `instruct_weights_missing` 503 before sidecar when emotion/language set without instruct checkpoint.

### [x] [Task 7.3] Optional `PILOT_TTS_PROMPT_WAV` on spawn
*   **Description**: In `pilot-tts-spawn.ts`, inject `PILOT_TTS_PROMPT_WAV` from settings when non-empty (read settings before spawn or pass from lifecycle).
*   **Prerequisites**: Task 7.1.
*   **Acceptance Criteria**:
    *   Sidecar `/health` + synthesize use spawned default when request omits `promptWav`.
    *   Per-request override still works without respawn.
*   **Verification**: Start TTS lane with saved wav path; synthesize without `promptWav` in body.
*   **Done**: `spawnPilotTtsServer()` reads settings; env `PILOT_TTS_PROMPT_WAV` = settings path || env override.

### [x] [Task 7.4] Bridge tests for synthesize extension
*   **Description**: Add/update route tests mocking sidecar; assert merged JSON shape.
*   **Prerequisites**: Task 7.2.
*   **Acceptance Criteria**:
    *   Tests cover default merge, override, and empty-string omission.
*   **Done**: `pilot-tts-synthesize.test.ts` (merge + mp3 validation); `tts-synthesize-route.test.ts` (merge, override, instruct-missing 503); `pilot-tts-paths.test.ts` instruct checkpoint helper.

---

## Phase 8: Web Config UI & `useSpeech` Integration

### [ ] [Task 8.1] Extend `SchedulerSettingsPayload` in Web API client
*   **Description**: Update `apps/web/src/api/bridge.ts` types for new TTS settings fields.
*   **Prerequisites**: Task 7.1.
*   **Acceptance Criteria**:
    *   TypeScript compiles; `fetchSchedulerSettings` / `saveSchedulerSettings` typed.

### [ ] [Task 8.2] TtsSubPage voice settings UI
*   **Description**: Add controls on `apps/web/src/components/TtsSubPage.tsx`: prompt wav path input, emotion dropdown (upstream tags), dialect dropdown. Save via `saveSchedulerSettings`.
*   **Prerequisites**: Task 8.1.
*   **Acceptance Criteria**:
    *   User can persist all three fields from Local → Voice page.
    *   Values reload on page refresh.
    *   Help text links `8090` WebUI as optional advanced tuning.
*   **Verification**: Manual UI test; confirm `scheduler-settings.json` updated.

### [ ] [Task 8.3] `useSpeech.ts` send TTS defaults
*   **Description**: Load scheduler TTS defaults; include in `POST /tts/synthesize` body from `tryPilotTtsSynthesize`.
*   **Prerequisites**: Tasks 7.2, 8.1.
*   **Acceptance Criteria**:
    *   Chat read-aloud uses saved emotion/language/prompt wav without extra user action.
    *   Browser fallback unchanged when Pilot unavailable.
*   **Verification**: Configure happy + custom wav; trigger speak on chat message.

### [ ] [Task 8.4] Web UI copy and validation
*   **Description**: Client-side validation for absolute paths with `.wav` or `.mp3` suffix; emotion/dialect enum aligned with `spec.md` FR-013.
*   **Prerequisites**: Task 8.2.
*   **Acceptance Criteria**:
    *   Invalid path shows user-facing error before save (Chinese UI copy allowed in Web; API remains English).

---

## Phase 9: E2E Verification Checkpoint

### [ ] [Task 9.1] End-to-end settings → synthesize path
*   **Description**: Full flow: TtsSubPage save → useSpeech → Bridge → sidecar → audio with emotion/dialect/prompt override.
*   **Prerequisites**: Phases 6–8 complete.
*   **Acceptance Criteria**:
    *   SC-007–SC-011 pass.
    *   Text-only regression test passes (SC-010).

### [ ] [Task 9.2] Port and path regression
*   **Description**: Confirm production API `4323`, WebUI `8090`; `/tts/status` notes unchanged.
*   **Prerequisites**: Task 9.1.
*   **Acceptance Criteria**:
    *   SC-005 still passes.

### [ ] [Task 9.3] Extension checkpoint sign-off
*   **Description**: Mark Phase 6–9 tasks complete; update `plan.md` executability review if blockers found.
*   **Prerequisites**: Tasks 9.1–9.2.
*   **Acceptance Criteria**:
    *   All extension tasks `[x]` or deferred with documented reason.
