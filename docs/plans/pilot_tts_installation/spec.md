# PilotTTS Installation and Configuration Functional Specification (spec.md)

## 1. User Scenarios & User Stories

To clearly define the goals of this reconstruction, we have designed the following user stories based on priority (P1 > P2 > P3 > P4):

### P1: Automated Configuration of Python 3.10 Virtual Environment & Dependencies
*   **User Story**: As a Windows user who does not understand technical details and only has Python 3.12 or no Python installed on my system, I want to run the installation script with one click, and have the program completely and automatically download and configure a Python 3.10 virtual environment, and install all required third-party dependencies (especially scientific computing packages like `pyworld` that require compilation), without requiring me to manually download Python 3.10 or install the massive and tedious Visual Studio compilation environment.
*   **Acceptance Criteria**:
    *   Running the script on a clean Windows virtual machine with no Python interpreter installed successfully creates a Python 3.10.x virtual environment.
    *   On systems with Python 3.12/3.13 installed, the script bypasses the system's default Python, strictly isolating and configuring Python 3.10.
    *   The installation process does not pop up any Python installation wizard interfaces that require manual user clicks.
    *   Scientific computing packages like `pyworld` are installed at lightning speed via pre-compiled Wheels, with a reliable backup or default download source (such as Christoph Gohlke's archive, trusted domestic mirrors, or specified reliable URLs matching `Windows-amd64-py310`) to guarantee high availability and bypass local MSVC C++ compilation on user machines.

### P2: High-Availability Clone & Download in Restricted Network Environments
*   **User Story**: As a user located in a region with restricted network access (e.g., mainland China) where GitHub and Hugging Face frequently freeze or time out, I want to ensure that cloning the upstream GitHub repository and downloading 3-5 GB of model weights during the installation of PilotTTS will not fail due to connection timeouts, and can automatically and smoothly complete via high-speed domestic mirror sources.
*   **Acceptance Criteria**:
    *   Before cloning or downloading, the program must automatically ensure that the `upstream` directory (which is excluded by `.gitignore`) is created.
    *   Cloning/fetching operations for the PilotTTS repository must have a strict 15-second timeout constraint. If a network timeout occurs within 15 seconds, the script must catch `subprocess.TimeoutExpired` and immediately trigger fallback cloning/pulling from the domestic mirror proxy (such as `https://mirror.ghproxy.com/`).
    *   If the `upstream` directory already exists, the program must not violently delete it. Instead, it should perform an incremental update (using `git fetch` / `git pull` / `git remote set-url`) and reset the local state via `git reset --hard` to align with the remote repository. Complete safe folder removal is only triggered if the directory is completely corrupted or when the user explicitly specifies the `--reset` flag.
    *   Before downloading Hugging Face weights, the system automatically and mandatorily injects `HF_ENDPOINT=https://hf-mirror.com` to route data streams through the domestic mirror source, ensuring high-speed model downloads without freezing.
    *   If the download is unexpectedly interrupted due to network fluctuations, restarting the installation script supports resuming from break points or file integrity checks, without needing to download from scratch.

### P3: Hardware-Adaptive PyTorch Dynamic Installation
*   **User Story**: As a user with an NVIDIA discrete graphics card (or only Intel/AMD integrated graphics, or only CPU), I want the installation script to intelligently detect my computer's hardware environment, automatically configure CUDA-accelerated PyTorch if an NVIDIA GPU is present, and automatically install the CPU version of PyTorch if only a CPU is present, without requiring any prior experience in deep learning environment configuration.
*   **Acceptance Criteria**:
    *   Automatically obtain device graphics card information and drivers via PowerShell or Python code before installation.
    *   If an NVIDIA GPU is detected and the driver is normal, install PyTorch with `cu121` (or the latest stable CUDA version) support.
    *   If no NVIDIA GPU is present, automatically fall back and install the CPU version of PyTorch (via `--extra-index-url https://download.pytorch.org/whl/cpu`), preventing startup failures or runtime errors caused by hardcoding CUDA on CPU machines.

### P4: Reconstructed Startup and Shutdown Control (New)
*   **User Story**: As a user running PilotTTS, I want to easily start and stop the service without manually typing commands or looking up process IDs. I want the startup script (`run.bat`) to automatically use the isolated virtual environment configured during installation and start the services on consistent ports (production API: `4323`, optional test/debug WebUI: `8090`), and the shutdown script (`shutdown.bat`) to cleanly terminate any running services on these ports without affecting other system processes.
*   **Acceptance Criteria**:
    *   `run.bat` automatically activates the `uv`-managed virtual environment (`.venv`) and launches the WebUI/API service.
    *   The production API port is `4323` (`server/tts_server.py`); the optional WebUI test/debug port remains `8090` (upstream Gradio `webui.py`).
    *   `shutdown.bat` uses Windows command-line tools to find and kill any processes occupying ports `4323` and `8090` cleanly, without requiring administrative privileges if possible.

---

## 2. Functional Requirements (FR)

### FR-001: Environment Preflight
*   The system must detect whether `uv` is available at startup. If `uv` is missing, it must provide an intuitive, highlighted error message and installation guide (e.g., `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`).
*   The system must pre-check the `git` command line. If missing, it must report an error and guide the user to install Git.

### FR-002: Python 3.10 Isolated Virtual Environment Construction
*   The script must utilize the `--python 3.10` parameter of `uv venv` to silently download the Python 3.10.x binary distribution.
*   The virtual environment must be created in the specified `pilot_tts/.venv` directory to achieve complete environment isolation.

### FR-003: Resilient Git Clone & Incremental Upstream Management
*   **Upstream Directory Auto-Creation**: Since the `upstream` directory is excluded from Git (via `.gitignore`), the installation script must automatically check and create the `pilot_tts/upstream` directory before initiating any cloning or downloading.
*   **Incremental Updating & Redirection**: If the `pilot_tts/upstream` folder already exists, instead of deleting it violently, check if it's a valid Git repository. If yes, update it incrementally using `git remote set-url` to redirect to the official or mirror repository, and execute `git fetch` and `git reset --hard` to align with upstream. A full safe deletion is only executed if the directory is completely corrupted or the `--reset` flag is specified.
*   **15-Second Hard Timeout**: For any cloning/fetching operations, a strict 15-second timeout must be enforced in `subprocess` to prevent blocking indefinitely under poor network conditions. The `timeout=15` parameter must be explicitly passed to the `subprocess` calls (e.g., `subprocess.run` or `subprocess.check_call`). This is critical because on Windows, the native git client can hang during the network handshake phase, and Python's subprocess layer will not raise a `subprocess.TimeoutExpired` exception unless the `timeout` parameter is explicitly passed. Upon catching a `subprocess.TimeoutExpired` exception, the script must handle it gracefully and trigger fallback to the mirror proxy address `https://mirror.ghproxy.com/https://github.com/AMAPVOICE/PilotTTS.git`.

### FR-004: Hardware-Aware PyTorch Installation
*   **Detection Mechanism**: Query system hardware. On Windows, this can be quickly verified via WMI/CIM commands or by invoking `nvidia-smi`.
*   **Installation Strategy**:
    *   GPU Present: Invoke `uv pip install torch==2.5.1 torchaudio==2.5.1 --extra-index-url https://download.pytorch.org/whl/cu121` (or another matching CUDA index).
    *   CPU Only: Invoke `uv pip install torch==2.5.1 torchaudio==2.5.1 --extra-index-url https://download.pytorch.org/whl/cpu`.
*   Only proceed to install other regular dependencies in `requirements-inference.txt` after PyTorch is successfully installed.

### FR-005: Hugging Face Mirror Download
*   Automatically inject the `HF_ENDPOINT` environment variable into the virtual environment and the installation process.
*   Use `snapshot_download` provided by `huggingface-hub`. If the download fails due to network disconnection, provide at least 3 automatic retry opportunities.

### FR-006: Reconstructed Run and Shutdown Scripts (New)
*   **`run.bat` Reconstruction**:
    *   Must verify the existence of `.venv` and `upstream` first.
    *   Must use the Python interpreter inside `.venv` (`.venv\Scripts\python.exe`).
    *   Must launch the optional WebUI on port `8090` (e.g., `GRADIO_SERVER_PORT=8090` + `python webui.py`) and/or the production API on port `4323` (`server/tts_server.py`).
*   **`shutdown.bat` Reconstruction**:
    *   Must use native Windows command-line commands (such as `netstat` and `taskkill`) to find and terminate the processes listening on port `4323` (API) and port `8090` (WebUI test/debug).
    *   Must handle cases where no process is running on these ports gracefully without throwing ugly command errors.

### FR-007: Flexible Interaction & Reset Support
*   Support the command-line argument `--reset` to clean up existing `.venv` and `upstream` directories with one click, allowing users to perform a clean reset when the environment is completely corrupted.
*   **Robust Reset & Cleanup**: When cleaning up existing `.venv` and `upstream` directories (either due to corruption or when `--reset` is specified), the script must use `shutil.rmtree` with a registered `pathlib`-based `remove_readonly` callback. This is because Git object pack files in Windows frequently have read-only attributes, and a direct `shutil.rmtree` will fail with a `PermissionError`. The callback must use `pathlib.Path(path).chmod(stat.S_IWRITE)` instead of `os.chmod` to comply with the project-wide `pathlib` specification.
*   **Process Lock Prevention**: Before executing this cleanup, the script must run the `shutdown.bat` script to ensure all Python processes occupying or locking the directory are completely terminated, preventing permission deadlocks.
*   Support the non-interactive environment variable `PILOT_TTS_INSTALL_NONINTERACTIVE=1` to prevent requiring manual user confirmation during automated background integration or Bridge startup.

---

## 3. Boundary Conditions & Non-Functional Requirements (NFR)

### 3.1 Boundary Conditions
*   **Residual Environment Pollution & Read-Only Locks**: The user previously generated residual dependencies or corrupted partial downloads through ordinary pip, or Git objects inside `.git/` have read-only attributes.
    *   *Countermeasure*: The installer must clean up `pilot_tts/.venv` and `pilot_tts/upstream` using a robust safe deletion function. It must register a `pathlib`-based `remove_readonly` callback with `shutil.rmtree` to modify file attributes using `Path(path).chmod(stat.S_IWRITE)`. Additionally, before performing any cleanup, the script must execute `shutdown.bat` to kill any Python processes that might occupy or lock the target directory, preventing permission deadlocks.
*   **Restricted PowerShell Script Execution Policy**:
    *   *Countermeasure*: In the `install.bat` wrapper, start with `powershell -ExecutionPolicy Bypass -File install.ps1` to bypass default execution policy restrictions.
*   **Multi-GPU/Hybrid Graphics**: Both integrated graphics and NVIDIA discrete GPUs exist in the system.
    *   *Countermeasure*: As long as the detection result contains the "NVIDIA" keyword or `nvidia-smi` can be invoked or the driver is normal, it is determined that GPU is supported.

### 3.2 Non-Functional Requirements (NFR)
*   **Execution Efficiency**: After introducing `uv`, under smooth network conditions, regular dependency resolution and installation must be completed within 60 seconds (an 80%+ reduction compared to original pip).
*   **High Robustness**: Robust `try-catch` blocks must wrap all key external calls (`git`, `uv`, model downloads).
*   **Simple Bridging to Bridge**: After successful installation, output addresses for ChattingCursor integration: `http://127.0.0.1:4323` for the production read-aloud API; `http://127.0.0.1:8090` for the optional test/debug WebUI only.

---

## 4. Measurable Success Criteria

| Metric ID | Dimension | Target Standard |
| :--- | :--- | :--- |
| **SC-001** | **Python Zero-Config Success Rate** | Under environments without system Python 3.10, the one-click installation completion rate reaches over **99%**. |
| **SC-002** | **Dependency Installation Efficiency** | The total time to build the virtual environment and install 36 regular libraries (excluding PyTorch) using `uv` is controlled within **60 seconds**. |
| **SC-003** | **Domestic Clone & Weight Download Availability** | Overcome GitHub/HF connection timeouts; model downloads can successfully handshake and saturate bandwidth, with 100% automatic reconnection in case of mid-way disconnection. |
| **SC-004** | **Hardware Adaptability** | Machines with NVIDIA cards 100% install the CUDA version of Torch, and machines without cards 100% gracefully fall back to the CPU version of Torch, both loading models and starting normally. |
| **SC-005** | **Unified Control Ports** | `run.bat` and `shutdown.bat` operate successfully on port `4323` (production API via `tts_server.py`) and port `8090` (optional test/debug WebUI). |
