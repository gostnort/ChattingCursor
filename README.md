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

## Ports

| Service | Default | Notes |
|---------|---------|--------|
| Bridge | `4321` | `BRIDGE_PORT`, `BRIDGE_HOST` |
| Web dev | `43210` | Vite; base path `/ChattingCursor/` |
| Chrome debug (optional web search) | `9222` | For non-Kimi “search the web” intents |

## Token file (phone setup)

Bridge writes a small text file (default: `%USERPROFILE%\.chattingcursor\chattingcursor-token.txt`, or a path you set in **Local → Config**). Put that file in a folder your phone can read (e.g. cloud sync).

**The synced file is minimal and safe to share with your phone:**

```text
datetime: 2026-05-27T14:30:00.000Z
token: <32-character daily token>
generatedAt: 2026-05-27T14:30:00.000Z
publicBridgeUrl: https://xxxx.trycloudflare.com
```

- **No salt** — derivation salt lives only on the PC under `~/.chattingcursor/token-meta-*.json`, not in the synced file.
- **No seed** — nothing besides the fields above.
- **`datetime`** — ISO timestamp of the last token write (e.g. tunnel reconnect / regenerate).
- **Token length** — 32 characters (regenerating or changing salt invalidates older tokens).

On the phone: open the GitHub Pages app → **Local → Config** → paste `publicBridgeUrl` and `token` from the file.

Legacy files that still contain a `date:` or `salt:` line are migrated on read: salt is moved server-side and the file is rewritten without it. Tokens created before the 32-character change may need a fresh copy from the file after upgrade.

## Cloudflare quick tunnel

`run.bat` / `scripts/run-all.ps1` start **cloudflared** with a random `*.trycloudflare.com` URL, update `publicBridgeUrl` in the token file, and call Bridge to stay in sync.

- **Periodic check:** every **5 minutes**, the script probes `GET {publicBridgeUrl}/health` (not chat traffic).
- **Fast recovery:** if cloudflared exits or a health probe fails, the script restarts the tunnel and regenerates the token file via Bridge.
- **Caveat:** trycloudflare URLs are ephemeral and can drop; there is no guarantee of stable networking. Re-copy `publicBridgeUrl` and `token` from the file after reconnect.

Named tunnels and custom domains are optional (see other docs in `docs/` if present); quick tunnel is the default one-click path.

## Optional: quality watch

```powershell
.\scripts\run-all.ps1 -WithQualityWatch
# or
pnpm quality:watch
```

Runs typecheck/lint and a crew dry-run in the background. Not required for normal chat.

## Optional: crewAI

Python crew tooling is optional. Examples live under `configs/crews/`. On branches that include crewAI reference code, use `pnpm crew:status` / `pnpm crew:run` after `pnpm crew:setup`. **main** may omit the `crewAI/` tree via `.gitignore`.

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

## Project layout

```
ChattingCursor/
├── apps/web/           # Frontend
├── apps/bridge/        # Bridge API
├── packages/shared/
├── packages/cli-client/
├── packages/orchestrator/
├── packages/evaluator/
├── configs/crews/      # Crew YAML examples
├── scripts/            # run-all.ps1, install, tunnel helpers
└── run.bat             # One-click Windows startup
```

## License

MIT
