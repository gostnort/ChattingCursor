# Cloudflare tunnel setup

ChattingCursor exposes your local **Bridge** (`127.0.0.1:4321`) to the internet so a phone browser (GitHub Pages UI) can reach it. Two approaches differ in **stability**, **setup**, and **what you must sync to your phone**.

## What runs where

| Piece | Runs on | Role |
|-------|---------|------|
| Web UI (GitHub Pages) | GitHub | Chat UI in the browser |
| Bridge | Your PC | Cursor CLI, auth, history |
| cloudflared | Your PC | HTTPS → local Bridge |

```text
Phone → https://gostnort.github.io/ChattingCursor/  (UI)
     → https://<bridge-host>/auth/...               (tunnel → Bridge)
     → cursor-agent                                 (local CLI)
```

---

## Temporary tunnel (default — `run.bat` / `run-all.ps1`)

This is what the project uses out of the box: **Cloudflare quick tunnel** (`trycloudflare.com`). No Cloudflare account or domain required.

### How it works

1. `scripts/run-all.ps1` starts Bridge, then `cloudflared tunnel --url http://127.0.0.1:4321`.
2. cloudflared prints a random URL like `https://xxxx.trycloudflare.com`.
3. The script writes **`publicBridgeUrl`** (and token fields) into your synced token file and calls Bridge to regenerate when needed.
4. Every **5 minutes**, the script probes `GET {publicBridgeUrl}/health`. If cloudflared exits or health fails, it **restarts the tunnel** and refreshes the token file.

### Operational behavior

| Topic | Temporary tunnel |
|-------|------------------|
| URL | **New on every tunnel restart** (new `*.trycloudflare.com` hostname) |
| Token file | **Must stay in sync** — `publicBridgeUrl` and `token` change when the script reconnects |
| Phone setup | Re-copy from the synced file into **Local → Config** after reconnect |
| PC must be on | Bridge + cloudflared run on your machine |
| Cloudflare account | Not required |

### Daily use

1. Once: `install.bat` (deps + cloudflared).
2. Each session: `run.bat` (or `.\scripts\run-all.ps1`).
3. Put the token file directory on **cloud sync** (or another path your phone can read). See README / QUICKSTART for the required sync note.
4. On the phone: open the Pages app → **Local → Config** → paste `publicBridgeUrl` and `token` from the file.

Custom sync directory:

```powershell
.\scripts\run-all.ps1 -TokenSyncDir "D:\OneDrive\ChattingCursor"
```

Default file: `%USERPROFILE%\.chattingcursor\chattingcursor-token.txt` (or the path set in **Local → Config**).

### Verify

- Open `{publicBridgeUrl}/auth/status` in a browser — expect JSON.
- Pages config page shows Bridge reachable.

Manual quick tunnel (only if not using `run.bat`): `scripts/start-tunnel-quick.ps1`.

---

## Fixed / named tunnel (optional)

Use when you want a **stable hostname** (e.g. `https://bridge.example.com`) that does not change when you restart cloudflared.

### How it differs from the temporary tunnel

| Topic | Temporary (`trycloudflare`) | Named tunnel |
|-------|----------------------------|--------------|
| Hostname | Random each restart | Fixed (your DNS name) |
| Cloudflare account | No | Yes |
| Domain | No | Yes (DNS on Cloudflare) |
| Setup | Automatic via `run.bat` | One-time: login, create tunnel, DNS route, `config.yml` |
| Token file `publicBridgeUrl` | Changes often | Usually stable; still update if you change hostname |
| Phone config | Re-copy URL after tunnel drops | Set once (unless you change DNS) |
| Scripts | `run-all.ps1` (integrated) | `scripts/start-tunnel-named.ps1` + `cloudflared tunnel run` |

### Setup outline

1. Install cloudflared: `.\scripts\install-cloudflared.ps1`
2. `cloudflared tunnel login` (browser; cert under `%USERPROFILE%\.cloudflared\`)
3. `cloudflared tunnel create chattingcursor-bridge` — note tunnel ID and credentials JSON
4. `cloudflared tunnel route dns chattingcursor-bridge bridge.yourdomain.com`
5. Copy `scripts/cloudflared-example.yml` → `%USERPROFILE%\.cloudflared\config.yml` and set tunnel ID, credentials path, hostname, `service: http://127.0.0.1:4321`
6. Start:

```powershell
.\scripts\start-tunnel-named.ps1 -Hostname "bridge.yourdomain.com"
# or
.\scripts\start-remote.ps1 -BridgePublicUrl "https://bridge.yourdomain.com"
cloudflared tunnel run chattingcursor-bridge
```

7. Set **`publicBridgeUrl`** in the token file / phone config to your fixed HTTPS URL (still sync **token** daily).

---

## No domain?

| Option | Domain? | Stability |
|--------|---------|-----------|
| Quick tunnel (`run.bat`) | No | Low — URL changes on restart |
| Named Cloudflare tunnel | Yes | High |
| Other HTTPS to Bridge | Varies | Must reach `127.0.0.1:4321` via your tool (e.g. Tailscale Funnel) |

---

## FAQ

**Why a daily token?**  
Bridge on your PC is exposed remotely; the token rotates to limit abuse.

**PC off?**  
Bridge and tunnel stop; remote chat does not work.

**GitHub Pages changes?**  
No. Only the static UI is on Pages; Bridge URL and token are set on the phone under **Local → Config**.

**CGNAT / no port forward?**  
Tunnels are outbound from your PC — no router port mapping needed.

**Quick tunnel URL changed?**  
Run `run.bat` again and copy the new `publicBridgeUrl` and `token` from the synced file.

---

## Related scripts

| File | Purpose |
|------|---------|
| `install.bat` | Install deps + cloudflared |
| `run.bat` | Bridge + quick tunnel + token file updates |
| `scripts/run-all.ps1` | PowerShell implementation for `run.bat` |
| `scripts/start-tunnel-named.ps1` | Named tunnel helper |
| `scripts/start-tunnel-quick.ps1` | Manual quick tunnel (fallback) |
