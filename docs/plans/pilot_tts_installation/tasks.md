# PilotTTS Installation and Configuration Task Breakdown (tasks.md)

This task list strictly follows the Speckit specification, breaking down the technical implementation plan into atomic, actionable tasks, while labeling priorities, prerequisites, and parallel opportunities.

---

## Phase 1: Setup

### [Task 1.1] Specification Creation and Directory Initialization
*   **Description**: Create `constitution.md`, `spec.md`, `plan.md`, and `tasks.md` under the `docs/plans/pilot_tts_installation` directory, defining process standards and boundary conditions.
*   **Owner**: AI Software Engineering Specialist
*   **Status**: Completed
*   **Prerequisites**: None

### [x] [Task 1.2] Environment Preflight and `uv` Bootstrapping Development
*   **Description**:
    *   In `install.ps1`, write logic to check if the `git` command is available, providing installation guidance if missing.
    *   Write logic to check if `uv` is available. If missing, automatically install `uv` silently via the official Astral PowerShell pipeline, and dynamically update the current process session's `$env:PATH` so that it can be used immediately without restarting the shell.
*   **Acceptance Criteria**:
    *   Running the script in a clean Windows environment with no `uv` installed automatically and silently installs `uv`.
*   **Status**: Completed
*   **Prerequisites**: None
*   **Parallel Opportunities**: Can run in parallel with Task 2.1.

---

## Phase 2: Foundational

### [x] [Task 2.1] Dynamic Hardware Adaptation Detection Mechanism
*   **Description**:
    *   In `install.ps1`, query the `Win32_VideoController` CIM instances to retrieve the graphics card list and check for the "NVIDIA" keyword.
    *   As a fallback, detect if `nvidia-smi` is in the `PATH` or if the driver exists.
    *   Based on the detection results, pass the corresponding PyTorch extra index URL (GPU -> `cu121`, CPU -> `cpu`) as a parameter to subsequent steps.
*   **Acceptance Criteria**:
    *   On GPU machines, prints: `NVIDIA GPU detected. Using CUDA 12.1 accelerated mirror source.`
    *   On integrated graphics/CPU-only machines, prints: `No NVIDIA GPU detected. Gracefully falling back to CPU version of PyTorch.`
*   **Prerequisites**: None

### [x] [Task 2.2] Isolated Python 3.10.x Virtual Environment Automated Deployment
*   **Description**:
    *   Use `uv venv --python 3.10 .venv` in the `pilot_tts/` directory to create an isolated environment.
    *   Verify and update `pip` inside `.venv`.
*   **Acceptance Criteria**:
    *   `pilot_tts/.venv` is successfully created.
    *   Running `.venv\Scripts\python.exe --version` outputs `Python 3.10.x`.
*   **Prerequisites**: Task 1.2

---

## Phase 3: User Story 1 (P1)

### [x] [Task 3.1] High-Availability, Compilation-Free Scientific and Inference Dependency Installation
*   **Description**:
    *   In `install_backend.py`, based on the hardware parameters passed from Task 2.1, prioritize using `uv pip install` to deploy matching versions of `torch==2.5.1` and `torchaudio==2.5.1`.
    *   Implement high-availability `.whl` force installation for `pyworld`: first attempt standard installation; if that fails or triggers source compilation, immediately catch the exception and install via pre-compiled `.whl` files from a reliable backup download source (Christoph Gohlke's archive, or AliYun mirror matching `Windows-amd64-py310`), completely bypassing MSVC C++ compilation.
    *   Subsequently, install other third-party libraries using `uv pip install -r requirements-inference.txt`.
*   **Acceptance Criteria**:
    *   All 30+ scientific computing and neural network inference dependencies are successfully installed.
    *   `pyworld` is guaranteed to be installed using a pre-compiled wheel on any user machine, avoiding any C++ source compilation failures.
*   **Prerequisites**: Task 2.1, Task 2.2

---

## Phase 4: User Story 2 (P2)

### [Task 4.1] Resilient `upstream` Cloning & Incremental Redirecting with 15-Second Timeout
*   **Description**:
    *   In `install_backend.py`, check and ensure the `upstream` directory is automatically created.
    *   Implement resilient incremental synchronization and fallback cloning logic:
        1. If the `upstream` directory already exists and contains a valid Git repository, do not violently delete it. Instead, redirect the URL using `git remote set-url origin <URL>` to the official repository and attempt an incremental synchronization (using `git fetch` and `git reset --hard origin/main`). Wrap all subprocess operations with a strict, explicit `timeout=15` parameter.
        2. If standard incremental synchronization or standard cloning fails or times out within 15 seconds, catch the `subprocess.TimeoutExpired` or `subprocess.CalledProcessError` exception, fall back immediately to redirect/clone from the domestic mirror (`https://mirror.ghproxy.com/https://github.com/AMAPVOICE/PilotTTS.git`), and reset state to origin.
        3. A full folder cleanup is only performed if the directory is completely corrupted or if the user explicitly specifies the `--reset` flag (Task 5.2).
    *   **Explicit Timeout Constraint**: The `timeout=15` parameter must be explicitly passed to `subprocess.run()`, `subprocess.check_call()`, or `subprocess.Popen()`. This is critical because on Windows, the native git client might hang during the network handshake phase, and Python's subprocess layer will not raise a `subprocess.TimeoutExpired` exception unless the `timeout` parameter is explicitly passed.
*   **Acceptance Criteria**:
    *   A strict 15-second timeout is successfully enforced in the subprocess calls by explicitly passing `timeout=15`, and `subprocess.TimeoutExpired` is captured and handled to trigger the proxy fallback 100% of the time.
    *   Existing repositories are incrementally fetched and hard-reset without violent deletion.
    *   In restricted network environments, cloning/fetching completes quickly, and `pilot_tts/upstream/webui.py` is present.
*   **Prerequisites**: Task 2.2
*   **Parallel Opportunities**: Can run in parallel with Phase 3 (dependency installation) since cloning code does not depend on the Python environment.

### [Task 4.2] Hugging Face Mirror Injection and High-Availability Model Weight Download
*   **Description**:
    *   Automatically configure `os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"` in the installation process.
    *   Write a Python script to call `snapshot_download` to silently and concurrently pull `AmapVoice/PilotTTS` and `facebook/w2v-bert-2.0`.
    *   Implement a backoff retry mechanism (at least 3 retries) for the download task, followed by a final integrity check of the model files.
*   **Acceptance Criteria**:
    *   Model downloads consistently route through the domestic acceleration channel, saturating bandwidth without freezing.
    *   After downloading, verify that `pretrained_models/pilot_tts.pt` and `pretrained_models/w2v-bert-2.0` are complete and usable.
*   **Prerequisites**: Task 3.1, Task 4.1

---

## Phase 5: Startup/Shutdown Control & Integration (P3 & P4)

### [Task 5.1] Integrate Controller `install.ps1` with Entry `install.bat`
*   **Description**:
    *   Refactor `install.bat` to launch the core controller via `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*`.
    *   In `install.ps1`, handle user-passed arguments:
        *   `--reset`: Invoke Task 5.2 to safely and thoroughly clean up legacy states.
        *   `--skip-weights`: Skip Task 4.2 model downloading.
        *   `PILOT_TTS_INSTALL_NONINTERACTIVE`: Non-interactive mode, silently completing all installations.
*   **Acceptance Criteria**:
    *   Double-clicking `install.bat` smoothly executes the entire control chain without obstacles.
*   **Prerequisites**: Task 4.1, Task 4.2

### [Task 5.2] Robust Cleanup of Legacy Residuals (Safe Remove)
*   **Description**:
    *   Implement robust garbage cleanup logic triggered only when the directory is completely corrupted or the `--reset` flag is explicitly specified by the user.
    *   **Process Lock Prevention**: Before executing any folder deletion, run `shutdown.bat` (Task 5.4) to ensure all Python processes occupying or locking files in the directory are completely killed, preventing permission deadlocks.
    *   **Read-Only Attribute Removal**: Register a custom `remove_readonly` error handler with `shutil.rmtree(..., onerror=remove_readonly)` to remove read-only attributes from Git object pack files in Windows.
    *   **Pathlib Compliance**: The `remove_readonly` callback must completely use `pathlib.Path(path).chmod(stat.S_IWRITE)` instead of `os.chmod` to comply with the project-wide `pathlib` specification.
*   **Acceptance Criteria**:
    *   Standard updates do not violently delete folders. Full deletion is only triggered when explicitly requested (`--reset`) or when corrupted, successfully cleaning up `pilot_tts/.venv` and `pilot_tts/upstream`.
    *   `shutdown.bat` is executed before folder deletion to prevent process lock permission deadlocks.
    *   `shutil.rmtree` uses a registered `remove_readonly` callback that modifies read-only file attributes using `pathlib.Path(path).chmod(stat.S_IWRITE)`.
    *   No `os` or `os.chmod` calls are present in the cleanup logic, fully complying with the `pathlib` specification.
*   **Prerequisites**: Task 1.2

### [Task 5.3] Reconstruct and Deploy `run.bat`
*   **Description**:
    *   Create/overwrite `run.bat` to activate the `.venv` virtual environment and launch the service.
    *   Unify ports: support launching the WebUI service on port `4324` and the API service on port `4323` (instead of the old `8090`).
    *   Verify the existence of `.venv` and `upstream` before running, giving clear error messages if missing.
*   **Acceptance Criteria**:
    *   Running `run.bat` successfully launches the WebUI on port `4324` or the API service on port `4323` using the isolated `.venv` Python interpreter.
*   **Prerequisites**: Task 2.2, Task 4.1

### [Task 5.4] Reconstruct and Deploy `shutdown.bat`
*   **Description**:
    *   Create/overwrite `shutdown.bat` to terminate processes listening on ports `4323` (API) and `4324` (WebUI).
    *   Use native Windows command-line tools (`netstat` and `taskkill`) to gracefully find and kill the processes.
    *   Ensure that if no processes are listening on these ports, the script exits gracefully without throwing ugly error messages.
*   **Acceptance Criteria**:
    *   Running `shutdown.bat` cleanly kills any active services on ports `4323` and `4324` and reports success.
*   **Prerequisites**: None

---

## Phase 6: Polish

### [Task 6.1] Coding Standards Audit and Static Checks
*   **Description**:
    *   Manually inspect or automatically scan all newly written Python code to ensure:
        1. All `import` statements are strictly at the top of the file.
        2. Exactly 2 empty lines exist between functions.
        3. No empty lines exist inside any function (even inside complex try-catch/try-except blocks; separate steps using comments instead).
        4. Completely use `pathlib.Path`, with no `os.path` or `os` related legacy APIs.
        5. All comments and explanations in Python/PowerShell code blocks are written entirely in Chinese.
        6. Any code block exceeding 10 lines MUST have a single-line Chinese comment right before the block explaining its purpose.
*   **Acceptance Criteria**:
    *   Script files 100% conform to the constraints defined in `constitution.md` and `coding-standards.mdc`.
*   **Prerequisites**: Task 5.1, Task 5.3, Task 5.4

### [Task 6.2] Metrics Measurement and Performance Verification
*   **Description**:
    *   Run the complete `install.bat` on both a Windows CPU virtual machine and a Windows NVIDIA GPU physical machine.
    *   Record execution time, bandwidth utilization, and PyTorch adaptation for CPU/GPU.
    *   Verify that the final TTS API starts normally on `http://127.0.0.1:4323` and the WebUI on `http://127.0.0.1:4324`. Output the final Speckit deployment completion report.
*   **Acceptance Criteria**:
    *   All metrics 100% meet the success standards SC-001 ~ SC-005 defined in `spec.md`.
*   **Prerequisites**: Task 6.1
