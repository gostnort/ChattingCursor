# ChattingCursor

Local-first chat UI that talks to **Cursor CLI** on your PC. The web app can run on [GitHub Pages](https://gostnort.github.io/ChattingCursor/); the **Bridge** API stays on your machine. Use a Cloudflare quick tunnel when you want to chat from your phone.

## Run (Windows)

- **`run.bat`** — starts Bridge, optional local web dev server, Cloudflare quick tunnel, and updates the synced token file. Defaults to **`CURSOR_CLI_MODE=native`** (Windows `cursor-agent`, not WSL).
- **`shutdown.bat`** — stops Bridge, web dev, and tunnel processes started by `run.bat`.

First-time setup: run **`install.bat`**, then **`run.bat`**. Step-by-step (English UI paths in Chinese doc): [docs/QUICKSTART.md](docs/QUICKSTART.md) · [docs/readme_chn.md](docs/readme_chn.md).

Open **http://127.0.0.1:43210/ChattingCursor/** → **Local → Config** → confirm Bridge port **4321**.

## Ports

| Service | Default | Notes |
|---------|---------|--------|
| Bridge | `4321` | `BRIDGE_PORT`, `BRIDGE_HOST` — main API |
| Offline LLM | `4322` | Local GGUF chat sidecar |
| PilotTTS API | `4323` | `PILOT_TTS_PORT` — chat read-aloud / synthesis |
| PilotTTS WebUI | `8090` | `PILOT_TTS_WEBUI_PORT` — optional Gradio test/debug config UI |
| Offline VLM | `4325` | Local vision sidecar |
| Web dev | `43210` | Vite; base path `/ChattingCursor/` |
| Chrome debug (optional) | `9222` | Free `/websearch`: Bridge → Windows Chrome CDP (`127.0.0.1:9222`), not WSL MCP; see [docs/QUICKSTART.md](docs/QUICKSTART.md) |

## Token file (phone)

Bridge writes a small text file (default `%USERPROFILE%\.chattingcursor\chattingcursor-token.txt`, or a path you set under **Local → Config**). Put it in a folder your phone can read (cloud sync). The file contains `datetime`, a 32-character daily `token`, and `publicBridgeUrl` — no salt. When the quick tunnel restarts, copy the updated file to your phone.

## Remote access

`run.bat` uses a temporary `*.trycloudflare.com` URL and refreshes `publicBridgeUrl` in the token file. For tunnel options and ops detail: [docs/CLOUDFLARE_TUNNEL_SETUP.md](docs/CLOUDFLARE_TUNNEL_SETUP.md).

## WSL (alternative on Windows)

Default is **native** Windows CLI (`run.bat` sets this). To run `cursor-agent` inside WSL instead, see [docs/WSL_SETUP.md](docs/WSL_SETUP.md) (install, `CURSOR_CLI_MODE=wsl`, Chrome on the Windows host for port 9222).

## Prerequisites

- Node.js >= 20, pnpm >= 9
- [Cursor CLI](https://cursor.com/docs/cli) installed and logged in
- **cloudflared** for the quick tunnel (`install.bat` can help)

## License

MIT
