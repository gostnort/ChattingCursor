# ChattingCursor

本地优先的聊天界面，通过本机 **Cursor CLI** 驱动对话。网页可部署在 [GitHub Pages](https://gostnort.github.io/ChattingCursor/)，**Bridge** API 留在你的电脑上；手机访问时使用 Cloudflare 快速隧道。

## 运行（Windows）

- **`run.bat`** — 启动 Bridge、可选本地 Web 开发服、Cloudflare 快速隧道，并更新同步用的 token 文件。默认 **`CURSOR_CLI_MODE=native`**（本机 `cursor-agent`，不走 WSL）。
- **`shutdown.bat`** — 停止由 `run.bat` 拉起的 Bridge、Web 与隧道相关进程。

首次使用：先运行 **`install.bat`**，再运行 **`run.bat`**。详细步骤见 [QUICKSTART.md](./QUICKSTART.md)。

浏览器打开 **http://127.0.0.1:43210/ChattingCursor/** → **本地 → 配置** → 确认 Bridge 端口 **4321**。

## 端口

| 服务 | 默认 | 说明 |
|------|------|------|
| Bridge | `4321` | `BRIDGE_PORT`、`BRIDGE_HOST` |
| Web 开发 | `43210` | Vite，base `/ChattingCursor/` |
| Chrome 调试（可选） | `9222` | 免费 `/websearch` 需本机 Chrome CDP；见 [QUICKSTART.md](./QUICKSTART.md) |

## Token 文件（手机）

Bridge 写入小文本文件（默认 `%USERPROFILE%\.chattingcursor\chattingcursor-token.txt`，或在 **本地 → 配置** 中指定云盘路径）。请放在手机能读到的目录（如云同步）。文件含 `datetime`、32 位当日 `token`、`publicBridgeUrl`，不含 salt。快速隧道重启后，请把更新后的文件同步到手机。

## 远程访问

`run.bat` 使用临时 `*.trycloudflare.com` 地址，并更新 token 文件中的 `publicBridgeUrl`。隧道方案与运维说明：[CLOUDFLARE_TUNNEL_SETUP.md](./CLOUDFLARE_TUNNEL_SETUP.md)。

## WSL（Windows 备选）

默认使用本机 Windows CLI（`run.bat` 已设置）。若要在 WSL 内运行 `cursor-agent`，安装与 `CURSOR_CLI_MODE=wsl`、Windows 主机 Chrome（9222）说明见 [WSL_SETUP_chn.md](./WSL_SETUP_chn.md)。

## 前置条件

- Node.js >= 20，pnpm >= 9
- 已安装并登录 [Cursor CLI](https://cursor.com/docs/cli)
- 快速隧道需 **cloudflared**（`install.bat` 可协助安装）

英文简介：[README.md](../README.md)。

## 许可

MIT
