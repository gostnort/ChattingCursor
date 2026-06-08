# PilotTTS Installation and Configuration Specification Constitution (constitution.md)

## 1. Core Principles

To thoroughly resolve various environment, network, and compilation issues encountered by users during the installation and configuration of the local PilotTTS reading service, the following core principles are established. All subsequent designs and implementations must unconditionally comply with these principles:

*   **Reliability First**: The installation process must possess extremely high determinism, eliminating "mysterious" failures. Any step that could potentially fail (such as network requests, dependency compilation, hardware detection) must have robust exception handling and clear error prompts.
*   **Zero Manual Python Configuration**: It is strictly forbidden to require users to manually download, install, or configure a specific version of the Python interpreter from the official website. All Python environment downloads, installations, and virtual environment creations must be automated and silently completed by the installer.
*   **Network High Availability**: Fully consider the access restrictions on GitHub and Hugging Face in certain network environments (e.g., in mainland China). All network download operations (code cloning, dependency pulling, model weight downloading) must default to high-speed mirror sources and provide automatic fallback and backoff retry mechanisms.
*   **Dynamic Hardware Adaptation**: The installer must be able to automatically and accurately identify the user's hardware environment (whether an NVIDIA GPU and its drivers are present), dynamically select the most matching PyTorch/CUDA version, and strictly avoid blind hardcoding, ensuring both CPU and GPU users get an out-of-the-box experience.
*   **Transparent Feedback**: Key nodes during the installation process must have clear and easy-to-understand log outputs. For time-consuming tasks (such as cloning, dependency downloading, model downloading), real-time progress bars or dynamic prompts must be provided; the interface must never be left in an unresponsive frozen state.

---

## 2. Tech Stack Constraints and Specifications

To guarantee engineering quality and maintainability, the technical implementation must adhere to the following tech stack constraints:

### 2.1 Package and Environment Management Tool: `uv`
*   **Strict Constraint**: Must be completely based on the new-generation high-performance Python package management tool `uv` (version >= 0.9.17).
*   **Prohibited Items**: It is strictly forbidden to directly invoke the system's built-in `pip`, `virtualenv`, or native `python -m venv` for dependency installation.
*   **Advantage Utilization**: Fully leverage the extremely fast resolution and download speeds of `uv`, as well as its built-in Python version management capability that requires no system installation (`uv venv --python 3.10`).

### 2.2 Runtime Environment and Version
*   **Python Version**: Mandatorily unified to **Python 3.10.x** (recommended 3.10.11).
    *   *Reason*: Under Windows environments, scientific computing libraries (such as `pyworld`, etc.) have complete and mature pre-compiled binary Wheel packages under Python 3.10, enabling direct installation without compilation. Python 3.12+ lacks these Wheels, forcing compilation from source using Visual Studio (MSVC), which is highly error-prone.
*   **Target Platform**: Prioritize Windows platform (PowerShell environment) while maintaining cross-platform compatibility.

### 2.3 Python Code Coding Standards
*   **Import Statements**: All `import` statements must be strictly placed at the very top of the Python script. Lazy imports inside functions or in the middle of the code are not allowed.
*   **Function Empty Line Specification**:
    *   Between functions, there must be **strictly 2 empty lines**.
    *   Inside any function, **any empty lines are strictly prohibited**. Code should be organized using tight line logic or concise comments.
*   **Standard Library Selection**: Must completely use the `pathlib` library for all path processing, joining, and checking. **It is strictly forbidden to introduce and use `os.path` or other `os` related APIs for path operations**.
*   **Comment Language**: All comments and explanatory documentation in Python/PowerShell code snippets must be **unified in Chinese** (to comply with specific user rules).
*   **Code Block Comments**: Any code block exceeding 10 lines must have a single-line Chinese comment right before the block explaining its purpose.
*   **No Hardcoded Paths**: All relative paths must be dynamically resolved relative to the root directory where the script resides (obtained via `Path(__file__).resolve()`).
