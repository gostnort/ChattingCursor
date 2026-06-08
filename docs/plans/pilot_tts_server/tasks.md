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

### [ ] [Task 2.1] Extend `weights_ready()` for w2v-bert-2.0
*   **Description**: Update `weights_ready()` in `pilot_tts/server/tts_server.py` to require `pretrained_models/w2v-bert-2.0/config.json` exists and is non-empty, matching `install_backend.verify_model_weights()`.
*   **Prerequisites**: Task 1.1.
*   **Acceptance Criteria**:
    *   Checkpoint-only install reports `weightsReady: false` on `/health`.
    *   Full install reports `weightsReady: true`.
    *   `POST /load` returns 503 with English message when w2v-bert missing (after Task 3.1).

### [ ] [Task 2.2] Verify health/load/synthesize paths use updated `weights_ready()`
*   **Description**: Confirm `health()`, `load_endpoint()`, `synthesize()`, and `main()` auto-load gate all call the updated function without duplicate logic.
*   **Prerequisites**: Task 2.1.
*   **Acceptance Criteria**:
    *   No code path sets `weightsReady: true` without w2v-bert check.

---

## Phase 3: P1 Quality & Compliance

### [ ] [Task 3.1] English user-facing API messages
*   **Description**: Replace all Chinese strings in `HTTPException.detail`, JSON `message`, `_load_error`, and `/health` `message` with English per `spec.md` FR-002.
*   **Prerequisites**: Task 2.1.
*   **Acceptance Criteria**:
    *   Grep `tts_server.py` for CJK in string literals assigned to API fields → none.
    *   Chinese comments preserved.

### [ ] [Task 3.2] Remove dead `import time`
*   **Description**: Delete unused `import time` from `tts_server.py`.
*   **Prerequisites**: None (can parallel with 3.1).
*   **Acceptance Criteria**:
    *   No `time` import; no linter unused-import warning.

### [ ] [Task 3.3] Temp wav cleanup after synthesize
*   **Description**: Add FastAPI `BackgroundTasks` (or equivalent) to delete temp `.wav` after `FileResponse`; delete on error if file was created.
*   **Prerequisites**: Task 3.1.
*   **Acceptance Criteria**:
    *   10 sequential synthesize calls leave 0 orphan temp wav files.
    *   Successful responses still return valid audio.

### [ ] [Task 3.4] Align `PILOT_TTS_AUTO_LOAD` with Bridge
*   **Description**: Implement policy from `plan.md` §3.4 (recommended: `run.bat api` sets `PILOT_TTS_AUTO_LOAD=0`; document `main()` default behavior).
*   **Prerequisites**: Task 1.3.
*   **Acceptance Criteria**:
    *   Bridge spawn + `run.bat api` both disable eager GPU load unless env overrides.
    *   `POST /load` remains the explicit warmup path for Bridge.

### [ ] [Task 3.5] Inline comments for lazy `demo` imports
*   **Description**: Add Chinese single-line comments before `from demo import load_engine` and `from demo import synthesize` blocks citing constitution exception.
*   **Prerequisites**: Task 1.4.
*   **Acceptance Criteria**:
    *   Each lazy import block has purpose comment per coding-standards (>10 line blocks).

---

## Phase 4: Bridge & Related Integration

### [ ] [Task 4.1] Bridge `isPilotTtsWeightsReady()` w2v-bert parity
*   **Description**: Extend `apps/bridge/src/services/pilot-tts-paths.ts` `isPilotTtsWeightsReady()` to check `w2v-bert-2.0/config.json` like sidecar `weights_ready()`.
*   **Prerequisites**: Task 2.1.
*   **Acceptance Criteria**:
    *   Bridge install snapshot `weightsReady` matches sidecar `/health` for partial/full installs.
    *   Update `pilot-tts-paths.test.ts` if needed.

### [x] [Task 4.2] WebUI port default `8090` in Bridge (verified)
*   **Description**: Confirm `resolvePilotTtsWebuiPort()` default stays `8090` in `pilot-tts-paths.ts`; `tts.ts` `ports.note` references `8090` for optional test/debug WebUI. Port `4324` was a stale misunderstanding — removed from docs and scripts.
*   **Prerequisites**: Task 1.1.
*   **Acceptance Criteria**:
    *   `/tts/status` reports `pilotWebUi: 8090` when env unset.
    *   Status note mentions `8090` for WebUI and `4323` for production API.

### [ ] [Task 4.3] Evaluate `inferencePresent` health field
*   **Description**: Per `plan.md` §3.7, decide whether to add `demoPresent`, rename, or deprecate `inferencePresent` in `tts_server.py` `/health` payload.
*   **Prerequisites**: Task 2.2.
*   **Acceptance Criteria**:
    *   Decision recorded in plan changelog or task comment.
    *   Bridge `probePilotTtsHealth` unaffected or updated consistently.

### [ ] [Task 4.4] Reduce `os.chdir` reliance (P2)
*   **Description**: Test `load_gpu_engine()` without `os.chdir`; if required, scope with cwd restore; document residual need.
*   **Prerequisites**: Task 3.5.
*   **Acceptance Criteria**:
    *   GPU load + synthesize succeed on Windows after change.
    *   `plan.md` records outcome.

---

## Phase 5: Verification & Checkpoint

### [ ] [Task 5.1] Sidecar manual verification (`run.bat api`)
*   **Description**: Run `pilot_tts/run.bat api`; verify `GET http://127.0.0.1:4323/health`, `POST /load`, `POST /v1/synthesize` with sample text.
*   **Prerequisites**: Phases 2–3 complete.
*   **Acceptance Criteria**:
    *   All SC-001–SC-004 metrics in `spec.md` pass for sidecar-only testing.

### [ ] [Task 5.2] Bridge integration verification
*   **Description**: Start Bridge; enable TTS lane; confirm spawn on 4323, `/tts/status` ports, synthesize via `/tts/synthesize` proxy.
*   **Prerequisites**: Phase 4 complete.
*   **Acceptance Criteria**:
    *   SC-005 and SC-006 pass.
    *   No regression in `tts-start-route.test.ts`.

### [ ] [Task 5.3] Coding standards audit
*   **Description**: Verify `tts_server.py` conforms to `coding-standards.mdc`: 2 blank lines between functions, no blank lines inside functions, Chinese comments, English API strings, pathlib usage.
*   **Prerequisites**: Phases 2–3 complete.
*   **Acceptance Criteria**:
    *   Checklist in `pilot_tts_installation/tasks.md` Task 6.1 equivalent passes for modified files.

### [ ] [Task 5.4] Checkpoint sign-off
*   **Description**: Mark completed tasks `[x]` in this file; note any deferred P2 items.
*   **Prerequisites**: Tasks 5.1–5.3.
*   **Acceptance Criteria**:
    *   All P0/P1 tasks checked or explicitly deferred with reason.
