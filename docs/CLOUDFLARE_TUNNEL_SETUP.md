# Cloudflare Tunnel 零基础搭建指南

适合 **T-Mobile / 家庭宽带 CGNAT** 用户：不需要路由器端口转发，不需要公网 IP。

## 日常使用（推荐）

只需两步：

1. **首次**：在项目根目录双击或运行 `install.bat`（安装依赖与 cloudflared）
2. **每天**：运行 `run.bat`（自动启动 Bridge + 快速隧道，并把公网 URL 写入 token 文件）

然后：

- 默认 token 文件在 `%USERPROFILE%\.chattingcursor\chattingcursor-token.txt`（与历史记录同级）。若需手机访问，可把该目录或你在配置里指定的云盘路径同步到手机
- 从该文件复制 **`publicBridgeUrl`** 和 **`token`** 到手机网页 **本地 → 配置**

无需手动复制 trycloudflare 地址到脚本。隧道 URL 每次重启会变，重新 `run.bat` 后 token 文件会自动更新。

自定义 token 目录示例：

```powershell
.\scripts\run-all.ps1 -TokenSyncDir "D:\OneDrive\ChattingCursor"
```

---

## 先搞懂三件事

| 东西 | 跑在哪里 | 作用 |
|------|----------|------|
| **GitHub Pages 前端** | GitHub 云端 | 手机打开的网页 UI |
| **Bridge** | 你的 Windows 电脑 | 真正执行 Cursor CLI、处理聊天 |
| **cloudflared 隧道** | 你的 Windows 电脑 | 把公网 HTTPS 请求转给本机 `127.0.0.1:4321` |

完整链路：

```text
手机浏览器
  -> https://gostnort.github.io/ChattingCursor/   （网页）
  -> https://你的-bridge-域名/auth/...             （隧道到电脑 Bridge）
  -> cursor-agent                                   （本机 CLI）
```

**你需要准备：**

- 电脑常开、Bridge 在跑、cloudflared 在跑
- 手机能看到的 **当天口令**（Bridge 每天自动生成，建议放云盘同步文件夹）
- 一个 **Bridge 公网 HTTPS 地址**（下面两种方案二选一）

---

## 方案 A：快速试通（`run.bat` 已自动化）

**不需要** Cloudflare 账号，**不需要** 域名。  
**缺点**：每次重启隧道，URL 都会变（形如 `https://xxxx.trycloudflare.com`）。`run.bat` 会自动写入 token 文件。

### 手动步骤（仅当不用 run.bat 时）

见 `scripts/start-tunnel-quick.ps1` 与 `scripts/install-cloudflared.ps1`。一般不必使用。

### 手机配置

1. 打开 https://gostnort.github.io/ChattingCursor/
2. **本地** → **配置**
3. **Bridge URL**、**今日口令**：从云盘里的 `chattingcursor-token.txt` 复制（`publicBridgeUrl` 与 `token` 行）
4. 保存并应用

### 验证

- 手机浏览器打开 token 文件里的 `publicBridgeUrl`，路径加 `/auth/status`，应返回 JSON
- GitHub Pages 配置页 Bridge 状态为可达

---

## 方案 B：长期稳定（固定域名）

**需要：**

- 免费 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
- 一个 **已接入 Cloudflare DNS 的域名**（可以是便宜买的域名，或已有域名改 NS 到 Cloudflare）

会得到固定地址，例如：`https://bridge.你的域名.com`

### 步骤概览

#### 1. 安装 cloudflared

同方案 A 的 `.\scripts\install-cloudflared.ps1`。

#### 2. 登录 Cloudflare（一次性）

```powershell
cloudflared tunnel login
```

浏览器会打开，选一个你要用的域名并授权。  
成功后会在 `%USERPROFILE%\.cloudflared\` 生成 `cert.pem`。

#### 3. 创建隧道

```powershell
cloudflared tunnel create chattingcursor-bridge
```

记下输出的 **Tunnel ID**（UUID）。  
同目录会生成 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json` 凭证文件。

#### 4. 绑定子域名（DNS）

把 `bridge` 换成你想要的子域名前缀：

```powershell
cloudflared tunnel route dns chattingcursor-bridge bridge.你的域名.com
```

#### 5. 写配置文件

复制项目示例并修改：

```powershell
Copy-Item scripts\cloudflared-example.yml $env:USERPROFILE\.cloudflared\config.yml
notepad $env:USERPROFILE\.cloudflared\config.yml
```

改成类似（路径和 ID 换成你的）：

```yaml
tunnel: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
credentials-file: C:\Users\你的用户名\.cloudflared\xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json

ingress:
  - hostname: bridge.你的域名.com
    service: http://127.0.0.1:4321
  - service: http_status:404
```

#### 6. 日常启动

```powershell
cd e:\my_github\ChattingCursor
.\scripts\start-tunnel-named.ps1 -Hostname "bridge.你的域名.com"
```

或手动：

```powershell
.\scripts\start-remote.ps1 -BridgePublicUrl "https://bridge.你的域名.com"
cloudflared tunnel run chattingcursor-bridge
```

#### 7. 手机配置

与方案 A 相同，只是 Bridge URL 换成你的固定域名。

---

## 没有域名怎么办？

| 方式 | 是否需要域名 | 稳定性 | 说明 |
|------|--------------|--------|------|
| **快速隧道 trycloudflare** | 否 | 低 | 方案 A，先跑起来最省事 |
| **Cloudflare 命名隧道** | 是 | 高 | 方案 B，日常推荐 |
| **Tailscale Funnel** | 否（Tailscale 账号） | 中 | 装 [Tailscale](https://tailscale.com/)，开启 Funnel 暴露本机 4321；手机填 Tailscale 给的 HTTPS 地址。项目不绑具体工具，只要能 HTTPS 到 Bridge 即可 |
| **买便宜域名** | 是 | 高 | 很多 `.xyz` / `.top` 年费很低，接入 Cloudflare 免费 DNS 即可 |

---

## 常见问题

**Q：为什么要口令？**  
A：Bridge 在你电脑上，暴露到公网后需要每日轮换 token，防止陌生人随便连。

**Q：电脑关机还能用吗？**  
A：不能。Bridge 和隧道都在本机，关机即停。

**Q：GitHub Pages 要改什么吗？**  
A：不用。Pages 只托管网页；Bridge URL 和口令在手机 **本地 → 配置** 里填。

**Q：T-Mobile 热点/家宽 CGNAT 能用吗？**  
A：能。隧道是 **电脑主动连出去**，不依赖端口转发。

**Q：快速隧道 URL 变了怎么办？**  
A：重新运行 `run.bat`，从 token 文件复制新的 `publicBridgeUrl` 到手机配置页。

---

## 相关入口

| 文件 | 用途 |
|------|------|
| `install.bat` | 一键安装依赖与 cloudflared |
| `run.bat` | 一键启动 Bridge + 快速隧道，自动更新 token 文件 |
| `scripts/run-all.ps1` | `run.bat` 调用的 PowerShell 实现 |
| `scripts/install-all.ps1` | `install.bat` 调用的 PowerShell 实现 |
| `scripts/start-tunnel-named.ps1` | 固定域名（方案 B） |
| `scripts/start-tunnel-quick.ps1` | 手动快速隧道（备用） |

更多背景见 [REMOTE_SETUP.md](./REMOTE_SETUP.md)。
