# ChattingCursor

A local-first multi-agent chat platform that talks to **Cursor CLI** on your PC. The web UI can run on GitHub Pages while the **Bridge** API stays on your machine. Use a Cloudflare quick tunnel when you want to chat from your phone.

## What it does

- **apps/web** — Vite + React UI (GitHub Pages or local dev server)
- **apps/bridge** — Node.js API that wraps `cursor-agent`, auth, history, and optional crew hooks
- **packages/shared** — Shared types and Zod schemas
- **packages/cli-client** — Cursor CLI wrapper (v1)
- **packages/orchestrator** — Optional crewAI orchestration and environment checks
- **packages/evaluator** — Evaluation placeholder

## Quick start

**Easiest (Windows):** double-click or run `run.bat` from the repo root. That starts Bridge, an optional local web dev server, cloudflared quick tunnel, and keeps the synced token file updated.

**Manual dev (two terminals):**

```powershell
pnpm install
pnpm dev:bridge    # Bridge on http://127.0.0.1:4321
pnpm dev:web       # UI on http://127.0.0.1:43210/ChattingCursor/
```

Open the web URL, go to **Local → Config**, confirm Bridge port **4321**, then chat.

**GitHub Pages (UI only):** https://gostnort.github.io/ChattingCursor/ — you still need a reachable Bridge URL and today’s token for remote use.

Chinese quickstart with the same sections: [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Ports

| Service | Default | Notes |
|---------|---------|--------|
| Bridge | `4321` | `BRIDGE_PORT`, `BRIDGE_HOST` |
| Web dev | `43210` | Vite; base path `/ChattingCursor/` |
| Chrome debug (optional web search) | `9222` | For non-Kimi “search the web” intents |

### Chrome remote debugging (Windows + WSL)

Start Chrome on **Windows** with remote debugging, for example:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

On Windows, Bridge and `curl.exe http://127.0.0.1:9222/json/version` should succeed.

**WSL ≠ Windows localhost:** crew Python, `pnpm crew:status`, or Cursor’s **chrome-devtools** MCP running inside WSL cannot reach Chrome at `127.0.0.1:9222` on the Windows host. The repo rewrites `http://127.0.0.1:9222` to the Windows host IP from `/etc/resolv.conf` when it detects WSL. You can also set an explicit URL:

```bash
# WSL — replace 172.x.x.x with: grep nameserver /etc/resolv.conf | awk '{print $2}'
export CHROME_DEBUG_ENDPOINT=http://172.x.x.x:9222
```

For **chrome-devtools MCP** in WSL, point `--browserUrl` at the same Windows host IP (not `127.0.0.1`). See [.cursor/mcp.json.example](.cursor/mcp.json.example).

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHROME_DEBUG_ENDPOINT` | `http://127.0.0.1:9222` (WSL: auto-rewrite to Windows host) | Chrome CDP HTTP endpoint |

## Token file (phone setup)

Bridge writes a small text file (default: `%USERPROFILE%\.chattingcursor\chattingcursor-token.txt`, or a path you set in **Local → Config**). Put that file in a folder your phone can read (e.g. cloud sync).

**You must configure where the token file is saved locally.** Use cloud sync (OneDrive, iCloud Drive, etc.) or another channel your phone can read. The project does not provide automatic email delivery. If you skip sync, when the temporary tunnel restarts you will not receive the updated tunnel URL and token on your phone.

**The synced file is minimal and safe to share with your phone:**

```text
datetime: 2026-05-27T14:30:00.000Z
token: <32-character daily token>
publicBridgeUrl: https://xxxx.trycloudflare.com
```

- **No salt** — derivation salt lives only on the PC under `~/.chattingcursor/token-meta-*.json`, not in the synced file.
- **`datetime`** — ISO timestamp of the last token write (e.g. tunnel reconnect / regenerate).
- **Token length** — 32 characters (regenerating or changing salt invalidates older tokens).

On the phone: open the GitHub Pages app → **Local → Config** → paste `publicBridgeUrl` and `token` from the file.

Legacy files may still contain `generatedAt:`, `date:`, or `salt:`; Bridge migrates on read (salt moves server-side, file is rewritten to the three fields above).

## Cloudflare tunnel

`run.bat` / `scripts/run-all.ps1` start a **temporary** `*.trycloudflare.com` URL, update `publicBridgeUrl` in the token file, and restart on health failure.

- **Periodic check:** every **5 minutes**, `GET {publicBridgeUrl}/health`.
- **Caveat:** quick tunnel URLs change when the tunnel restarts; re-copy the synced file to your phone.

Full operational comparison (temporary vs fixed named tunnel): [docs/CLOUDFLARE_TUNNEL_SETUP.md](docs/CLOUDFLARE_TUNNEL_SETUP.md).

## Optional: quality watch

```powershell
.\scripts\run-all.ps1 -WithQualityWatch
# or
pnpm quality:watch
```

Runs typecheck/lint and a crew dry-run in the background. Not required for normal chat.

## Optional: crewAI

Python crew tooling is optional. On branches such as `with-crewai`, use `pnpm crew:status` / `pnpm crew:run` after `pnpm crew:setup`. **main** may omit the `crewAI/` reference tree via `.gitignore`.

See [docs/QUICKSTART.md](docs/QUICKSTART.md) for crew commands and local-mode API tables.

## Prerequisites

- Node.js >= 20, pnpm >= 9
- Windows: WSL + Ubuntu recommended for CLI parity
- [Cursor CLI](https://cursor.com/docs/cli) installed and logged in (`cursor-agent login`)
- **cloudflared** for remote quick tunnel (install script can help)

## Environment variables (Bridge)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BRIDGE_HOST` | `127.0.0.1` | Listen address |
| `BRIDGE_PORT` | `4321` | Listen port |
| `BRIDGE_PUBLIC_URL` | `http://127.0.0.1:4321` | Advertised public URL |
| `BRIDGE_CORS_ORIGINS` | see `.env.example` | Allowed web origins |
| `CHATTINGCURSOR_TOKEN_SYNC_DIR` | `~/.chattingcursor` | Token file directory |
| `CHROME_DEBUG_ENDPOINT` | `http://127.0.0.1:9222` | Chrome CDP URL; WSL auto-rewrites localhost to Windows host |

## Project layout

```
ChattingCursor/
├── apps/web/           # Frontend (Vite; dev server, Pages build)
├── apps/bridge/        # Bridge API (TypeScript source in src/)
├── packages/shared/
├── packages/cli-client/
├── packages/orchestrator/
├── packages/evaluator/
├── configs/crews/      # Crew YAML examples (optional; see below)
├── scripts/            # run-all.ps1, install, tunnel helpers
└── run.bat             # One-click Windows startup
```

### `configs/` (crew-only)

Everything under **`configs/`** is for **optional crewAI** workflows (`configs/crews/*.yaml`, example inputs). The core chat app (web + bridge + CLI) does **not** need these files at runtime.

- **GitHub Pages / main upload:** the static UI build does not bundle `configs/`; you do not need them on Pages.
- **Keep in repo:** useful on `with-crewai` for `pnpm crew:run`, Bridge `/crews/*`, and `packages/orchestrator` loading YAML paths.

Do not delete without checking your branch — crew examples and dry-run scripts depend on this folder.

### Build output (`dist/`) — not committed

Root `.gitignore` ignores **`dist/`** everywhere. For Bridge, `pnpm build` in `apps/bridge` runs `tsc` and writes **`apps/bridge/dist/`** (e.g. `dist/index.js`). That folder is **generated locally**, same as other packages’ `dist/` after build.

- **Dev:** `pnpm dev:bridge` uses `tsx` on `src/` (no commit needed).
- **Production-style start:** `pnpm build` then `node apps/bridge/dist/index.js` (or package `start` script).

Do not commit `dist/` unless the project changes convention; CI and clones run `pnpm build` as needed.

## License

MIT
