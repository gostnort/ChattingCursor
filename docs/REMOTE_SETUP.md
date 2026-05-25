# 远程访问设置

本文档说明如何让手机浏览器访问 GitHub Pages 后，再连接你电脑上的 Bridge。

## 总体链路

手机浏览器并不会直接连接 `cursor-agent`。实际链路是：

`手机浏览器 -> GitHub Pages 前端 -> 公网 Bridge URL -> 你电脑上的 Bridge -> cursor-agent`

因此你需要准备三样东西：

1. 电脑上的 Bridge 正在运行
2. 一个能把公网请求转发到这台电脑的 `Bridge URL`
3. 当天口令文件已经同步到手机可查看的位置

## 推荐方式

推荐使用 tunnel，例如：

- Cloudflare Tunnel
- Tailscale Funnel
- 你自己的反向代理 / FRP / ngrok

项目代码本身不强绑某一种 tunnel，只要求你最终得到一个可在手机浏览器访问的 Bridge 地址。

## 电脑侧配置

### 1. 启动 Bridge

```powershell
cd e:\my_github\ChattingCursor
pnpm dev:bridge
```

或者直接用远程模式脚本：

```powershell
.\scripts\start-remote.ps1 -BridgePublicUrl "https://bridge.example.com" -TokenSyncDir "D:\YourSyncFolder\ChattingCursor"
```

### 2. 配置公开地址

你可以在环境变量中设置：

```powershell
$env:BRIDGE_PUBLIC_URL="https://bridge.example.com"
```

这会影响：

- `/auth/status` 返回的公开地址
- 每日 token 文件里的 `publicBridgeUrl`

### 3. 配置 token 同步目录

```powershell
$env:CHATTINGCURSOR_TOKEN_SYNC_DIR="D:\YourSyncFolder\ChattingCursor"
```

Bridge 启动后会生成：

```text
chattingcursor-token.txt
```

文件内容包括：

- 当天日期
- 当天 token
- 生成时间
- 当前公开 Bridge 地址

## 手机侧使用

1. 打开云盘同步后的 `chattingcursor-token.txt`
2. 记下当天 `token`
3. 打开 GitHub Pages 页面
4. 进入 **本地 → 配置**
5. 填入：
   - `Bridge URL`：你的公网 Bridge 地址
   - `今日口令`：当天 token
6. 点击“保存并应用”
7. 回到聊天页开始使用

## 重要限制

- 电脑关机后，手机将无法使用
- Bridge 未启动时，手机页面会报连接失败
- token 每天轮换一次，旧 token 第二天失效
- 云盘同步可能有延迟，刚轮换时手机端不一定立刻能看到新 token

## 本机专属能力

以下功能仍然默认只在电脑本机可用：

- 本地历史全文浏览
- crewAI 本地状态页
- CLI 原始输出查看

远程手机模式下，聊天与最近会话恢复是主目标，不默认开放这些敏感本地能力。
