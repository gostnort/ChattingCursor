# WSL setup (optional)

ChattingCursor on Windows defaults to **native** CLI: `run.bat` sets `CURSOR_CLI_MODE=native` and runs `cursor-agent` on Windows. Use this guide only if you want the CLI inside WSL instead.

## Install WSL and Ubuntu

1. Open **PowerShell as Administrator** and run:

   ```powershell
   wsl --install
   ```

   Or install a specific distro: `wsl --install -d Ubuntu`.

2. Reboot if prompted, complete Ubuntu first-time user setup.

3. Verify:

   ```powershell
   wsl -l -v
   ```

4. Install [Cursor CLI](https://cursor.com/docs/cli) inside WSL and log in:

   ```bash
   cursor-agent login
   cursor-agent status
   ```

## Use WSL for ChattingCursor

Before starting Bridge (or before `run.bat` if you override the default):

**PowerShell (session):**

```powershell
$env:CURSOR_CLI_MODE = "wsl"
```

**Persistent (Windows user environment):** set `CURSOR_CLI_MODE` to `wsl`, then restart terminals.

`run.bat` only sets `native` when the variable is **unset**. If you set `wsl` in the environment first, `run.bat` will not override it.

For manual dev, set the same variable in the terminal that runs `pnpm dev:bridge`.

## Chrome remote debugging from WSL

Bridge free web search uses Chrome CDP on port **9222**. Chrome should run on **Windows** with remote debugging, for example:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

From WSL, `127.0.0.1:9222` is the WSL loopback, **not** Windows Chrome. ChattingCursor rewrites `http://127.0.0.1:9222` to the Windows host IP from `/etc/resolv.conf` when it detects WSL. You can set an explicit endpoint:

```bash
# Replace 172.x.x.x with your Windows host IP:
grep nameserver /etc/resolv.conf | awk '{print $2}'
export CHROME_DEBUG_ENDPOINT=http://172.x.x.x:9222
```

**Cursor IDE chrome-devtools MCP in WSL:** point `--browserUrl` at the same Windows host IP (see [.cursor/mcp.json.example](../.cursor/mcp.json.example)), not `127.0.0.1`.

| Variable | Purpose |
|----------|---------|
| `CURSOR_CLI_MODE` | `wsl` — run CLI inside WSL |
| `CHROME_DEBUG_ENDPOINT` | CDP base URL; WSL may auto-rewrite localhost to Windows host |

Chinese install steps: [WSL_SETUP_chn.md](./WSL_SETUP_chn.md).
