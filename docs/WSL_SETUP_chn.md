# WSL 安装与配置（可选）

Windows 上 ChattingCursor **默认**使用本机 CLI：`run.bat` 设置 `CURSOR_CLI_MODE=native`，在 Windows 上运行 `cursor-agent`。仅当你要在 WSL 内运行 CLI 时再按本文操作。

## 安装 WSL 与 Ubuntu

1. **以管理员身份**打开 PowerShell，执行：

   ```powershell
   wsl --install
   ```

   或指定发行版：`wsl --install -d Ubuntu`。

2. 若提示重启，重启后完成 Ubuntu 首次用户配置。

3. 检查：

   ```powershell
   wsl -l -v
   ```

4. 在 WSL 内安装 [Cursor CLI](https://cursor.com/docs/cli) 并登录：

   ```bash
   cursor-agent login
   cursor-agent status
   ```

## 让 ChattingCursor 使用 WSL

启动 Bridge 前（或在覆盖默认值后再运行 `run.bat`）：

**PowerShell（当前会话）：**

```powershell
$env:CURSOR_CLI_MODE = "wsl"
```

**持久化：** 在 Windows 用户环境变量中设置 `CURSOR_CLI_MODE=wsl`，然后重新打开终端。

`run.bat` 仅在变量**未设置**时写入 `native`。若环境变量已是 `wsl`，不会被覆盖。

手动开发时，在运行 `pnpm dev:bridge` 的终端中设置相同变量。

## WSL 下使用 Windows 上的 Chrome（9222）

免费 `/websearch` 通过 Chrome CDP 端口 **9222**。Chrome 应在 **Windows** 上启动远程调试，例如：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

在 WSL 里访问 `127.0.0.1:9222` 指向的是 WSL 本机，**不是** Windows 上的 Chrome。项目在检测到 WSL 时会将 `http://127.0.0.1:9222` 改写为 `/etc/resolv.conf` 中的 Windows 主机 IP。也可手动指定：

```bash
grep nameserver /etc/resolv.conf | awk '{print $2}'
export CHROME_DEBUG_ENDPOINT=http://172.x.x.x:9222
```

**Cursor IDE 在 WSL 中使用 chrome-devtools MCP：** `--browserUrl` 使用上述 Windows 主机 IP（见 [.cursor/mcp.json.example](../.cursor/mcp.json.example)），不要用 `127.0.0.1`。

| 变量 | 用途 |
|------|------|
| `CURSOR_CLI_MODE` | `wsl` — 在 WSL 内运行 CLI |
| `CHROME_DEBUG_ENDPOINT` | CDP 地址；WSL 下 localhost 可能自动改写到 Windows 主机 |

English: [WSL_SETUP.md](./WSL_SETUP.md).
