#!/usr/bin/env bash
# 安装 Cloudflare Tunnel 客户端 cloudflared（Linux / macOS）
set -euo pipefail

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

if command -v cloudflared >/dev/null 2>&1 && [[ "${FORCE}" -eq 0 ]]; then
  echo "cloudflared 已安装:"
  cloudflared --version
  echo ""
  echo "重装: ./scripts/install-cloudflared.sh --force"
  exit 0
fi

install_with_apt() {
  if ! command -v apt-get >/dev/null 2>&1; then
    return 1
  fi
  echo "通过 apt 安装 cloudflared..."
  # 默认 apt 源通常不含 cloudflared，先添加 Cloudflare 官方源
  if command -v curl >/dev/null 2>&1; then
    if sudo mkdir -p --mode=0755 /usr/share/keyrings && \
       curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null; then
      echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | \
        sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    fi
  fi
  if sudo apt-get update -qq && sudo apt-get install -y cloudflared; then
    return 0
  fi
  echo "apt 安装 cloudflared 失败，将尝试其他方式..."
  return 1
}


install_with_dnf() {
  if ! command -v dnf >/dev/null 2>&1; then
    return 1
  fi
  echo "通过 dnf 安装 cloudflared..."
  if sudo dnf install -y cloudflared; then
    return 0
  fi
  echo "dnf 安装 cloudflared 失败，将尝试其他方式..."
  return 1
}


install_with_brew() {
  if ! command -v brew >/dev/null 2>&1; then
    return 1
  fi
  echo "通过 Homebrew 安装 cloudflared..."
  if brew install cloudflared; then
    return 0
  fi
  echo "Homebrew 安装 cloudflared 失败，将尝试其他方式..."
  return 1
}


install_with_package_manager() {
  if install_with_apt; then
    return 0
  fi
  if install_with_dnf; then
    return 0
  fi
  if install_with_brew; then
    return 0
  fi
  return 1
}

install_download_binary() {
  local arch os asset url dest_dir dest
  dest_dir="${HOME}/.local/bin"
  mkdir -p "${dest_dir}"
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "不支持的 CPU 架构: $(uname -m)"
      return 1
      ;;
  esac
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *)
      echo "不支持的操作系统: $(uname -s)"
      return 1
      ;;
  esac
  asset="cloudflared-${os}-${arch}"
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}"
  dest="${dest_dir}/cloudflared"
  echo "下载 ${url} ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${url}" -o "${dest}"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${dest}" "${url}"
  else
    echo "需要 curl 或 wget 以下载 cloudflared"
    return 1
  fi
  chmod +x "${dest}"
  if [[ ":${PATH}:" != *":${dest_dir}:"* ]]; then
    export PATH="${dest_dir}:${PATH}"
    echo ""
    echo "已将 ${dest_dir} 加入当前 shell 的 PATH。"
    echo "请把下面一行加入 ~/.bashrc 或 ~/.profile 后重新打开终端:"
    echo "  export PATH=\"${dest_dir}:\$PATH\""
    NEEDS_SHELL_RESTART=1
  fi
}

NEEDS_SHELL_RESTART=0
if ! install_with_package_manager; then
  if ! install_download_binary; then
    echo ""
    echo "自动安装失败。请手动安装:"
    echo "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
  fi
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo ""
  echo "安装完成，但当前 shell 找不到 cloudflared。请重新打开终端后执行: cloudflared --version"
  exit 10
fi

echo ""
echo "安装成功:"
cloudflared --version
echo ""
echo "下一步: ./run.sh"
if [[ "${NEEDS_SHELL_RESTART:-0}" -eq 1 ]]; then
  exit 10
fi
exit 0
