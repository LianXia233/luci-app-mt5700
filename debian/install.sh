#!/bin/bash
# luci-app-mt5700 Debian 分支：编译并安装到当前主机。
#
# 用法：
#   sudo ./debian/install.sh            # cargo build + 安装（二进制 / WebUI / systemd）
#   sudo ./debian/install.sh --bin BINARY_PATH   # 跳过编译，直接安装已有二进制
#
# 安装内容：
#   /usr/bin/at-webserver               后端二进制
#   /usr/share/mt5700/webui/            WebUI 静态资源
#   /etc/mt5700/config.json             配置（已存在则保留不覆盖）
#   /etc/mt5700/on-uplink.sh            拨号就绪钩子
#   /etc/systemd/system/at-webserver.service
#
# 卸载：
#   systemctl disable --now at-webserver
#   rm -f /usr/bin/at-webserver /etc/systemd/system/at-webserver.service
#   rm -rf /usr/share/mt5700 /etc/mt5700

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_SRC=""
SKIP_DEPS=0

while [ $# -gt 0 ]; do
    case "$1" in
        --bin) BIN_SRC="${2:-}"; shift 2 ;;
        --no-deps) SKIP_DEPS=1; shift ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "错误：请用 sudo/root 运行安装脚本" >&2
    exit 1
fi

# ---------- 1. 依赖 ----------
if [ "$SKIP_DEPS" -eq 0 ]; then
    if ! command -v cargo >/dev/null 2>&1; then
        echo "未检测到 cargo，尝试通过 apt 安装 rustc/cargo ..."
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq
            apt-get install -y -qq build-essential curl pkg-config rustc cargo
        else
            echo "错误：请先安装 Rust 工具链（https://rustup.rs）" >&2
            exit 1
        fi
    fi
fi

# ---------- 2. 编译 ----------
BIN=""
if [ -n "$BIN_SRC" ] && [ -x "$BIN_SRC" ]; then
    BIN="$BIN_SRC"
    echo "使用指定二进制: $BIN"
else
    echo "==> cargo build --release (src/rust)"
    (cd "$REPO_ROOT/src/rust" && cargo build --release)
    BIN="$REPO_ROOT/src/rust/target/release/at-webserver"
fi

# ---------- 3. 安装 ----------
echo "==> 安装二进制与 WebUI"
install -m 0755 "$BIN" /usr/bin/at-webserver
mkdir -p /usr/share/mt5700
cp -r "$REPO_ROOT/webui" /usr/share/mt5700/webui
find /usr/share/mt5700/webui -type d -exec chmod 0755 {} +
find /usr/share/mt5700/webui -type f -exec chmod 0644 {} +

echo "==> 安装配置（已存在的 config.json 保留不覆盖）"
mkdir -p /etc/mt5700
if [ ! -f /etc/mt5700/config.json ]; then
    install -m 0644 "$REPO_ROOT/debian/config.json" /etc/mt5700/config.json
fi
install -m 0755 "$REPO_ROOT/debian/on-uplink.sh" /etc/mt5700/on-uplink.sh

echo "==> 安装 systemd 服务"
install -m 0644 "$REPO_ROOT/debian/at-webserver.service" /etc/systemd/system/at-webserver.service
systemctl daemon-reload
systemctl enable at-webserver.service

# ---------- 4. 拉起 ----------
if systemctl is-active --quiet at-webserver.service; then
    echo "==> 服务已在运行，重启以加载新版本"
    systemctl restart at-webserver.service
else
    systemctl start at-webserver.service
fi

sleep 1
if systemctl is-active --quiet at-webserver.service; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo
    echo "安装完成。浏览器访问: http://${IP:-<设备IP>}:9000"
else
    echo "警告：服务未正常运行，请执行 journalctl -u at-webserver -n 50 查看日志" >&2
    exit 1
fi
