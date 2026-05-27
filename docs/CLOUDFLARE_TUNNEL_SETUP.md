# Cloudflare tunnel setup

ChattingCursor exposes local **Bridge** (`127.0.0.1:4321`) to the internet so a phone browser (GitHub Pages UI) can reach it.

## Quick comparison

| | **Temporary (default)** | **Named / stable tunnel** |
|---|-------------------------|---------------------------|
| Used by | `run.bat` out of the box | Optional; you configure once |
| URL | New `*.trycloudflare.com` on each tunnel restart | Fixed hostname (e.g. `bridge.example.com`) |
| Cloudflare account | Not required | Required |
| Domain on Cloudflare | Not required | Required (DNS route) |
| Phone config | Re-copy `publicBridgeUrl` + token after URL changes | Set Bridge URL once; token still rotates daily |
| PC | Bridge + cloudflared must run | Same |

---

## Option A: Temporary tunnel (default)

**What `run.bat` does**

1. Starts Bridge, then `cloudflared tunnel --url http://127.0.0.1:4321`.
2. Parses a random `https://xxxx.trycloudflare.com` URL from cloudflared logs.
3. Writes `publicBridgeUrl` and today's token into your synced token file (via Bridge).
4. Every 5 minutes, checks `GET {publicBridgeUrl}/health`; on failure, restarts the tunnel and refreshes the file.

**What you do**

1. Once: `install.bat` (includes cloudflared).
2. Each session: `run.bat`.
3. Put the token directory on cloud sync (OneDrive, iCloud, etc.).
4. On the phone: GitHub Pages app → **Local → Config** → paste `publicBridgeUrl` and `token` from the file when they change.

Custom sync directory:

```powershell
.\scripts\run-all.ps1 -TokenSyncDir "D:\OneDrive\ChattingCursor"
```

Default file: `%USERPROFILE%\.chattingcursor\chattingcursor-token.txt`.

Manual quick tunnel (without `run.bat`): `scripts/start-tunnel-quick.ps1`.

---

## Option B: Named / stable tunnel (optional)

**When you need it**

- You want the same HTTPS hostname after every restart.
- You are fine maintaining a Cloudflare account, domain, and one-time `cloudflared` setup.

**Prerequisites (high level)**

1. Install cloudflared: `.\scripts\install-cloudflared.ps1`
2. `cloudflared tunnel login`
3. `cloudflared tunnel create <name>` and `cloudflared tunnel route dns <name> bridge.yourdomain.com`
4. `config.yml` under `%USERPROFILE%\.cloudflared\` pointing the hostname to `http://127.0.0.1:4321` (see `scripts/cloudflared-example.yml`)

**Project wiring**

| Item | Purpose |
|------|---------|
| `%USERPROFILE%\.chattingcursor\cloudflare-tunnel.json` | `tunnelName`, `publicHostname`, optional metadata |
| Local web **Config** → *Cloudflare tunnel (optional — named tunnel)* | Edit fields; saves browser + Bridge |
| `CHATTINGCURSOR_TUNNEL_NAME` / `CHATTINGCURSOR_TUNNEL_HOSTNAME` | Override file (env) |
| `run-all.ps1` | If `tunnelName` + `publicHostname` are set → `cloudflared tunnel run <name>` and stable `publicBridgeUrl` |

Example `cloudflare-tunnel.json`:

```json
{
  "tunnelName": "chattingcursor-bridge",
  "publicHostname": "bridge.example.com",
  "accountId": "",
  "credentialsFilePath": "C:\\Users\\you\\.cloudflared\\<tunnel-id>.json",
  "tunnelToken": ""
}
```

`credentialsFilePath` and `tunnelToken` are stored for your reference; `run.bat` expects the tunnel to be defined in `config.yml` like a normal `cloudflared tunnel run` setup.

After saving config, **restart `run.bat`**. Phone Bridge URL can stay on `https://bridge.example.com`; copy a new **token** from the sync file when it rotates.

Helper script (Bridge + named tunnel in separate steps): `scripts/start-tunnel-named.ps1`.

---

## Which should I choose?

| Situation | Choice |
|-----------|--------|
| Trying the project, no domain | **Option A** (default) |
| Phone setup annoyance from changing URLs | **Option B** |
| No Cloudflare account / domain | **Option A** |

---

## Related scripts

| File | Role |
|------|------|
| `run.bat` | Launcher (quick tunnel by default) |
| `scripts/run-all.ps1` | Bridge + tunnel + token file |
| `scripts/start-tunnel-quick.ps1` | Manual quick tunnel |
| `scripts/start-tunnel-named.ps1` | Manual named tunnel |
