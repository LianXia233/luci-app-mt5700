#!/bin/bash
# at-webserver Debian 包（.deb）打包脚本。
#
# 用法：
#   debian/build-deb.sh                          # 编译（cargo）+ 打包
#   debian/build-deb.sh --bin <二进制>            # 跳过编译，直接打包已有二进制
#   debian/build-deb.sh --out-dir dist           # 指定产物输出目录（默认 dist）
#   debian/build-deb.sh --revision 2             # deb 修订号（默认 1）
#
# 产物：<out-dir>/at-webserver_<版本>-<修订>_<架构>.deb
#
# 设计要点：
#   1. 依赖动态推导：读 objdump -p 的 NEEDED 条目并映射到 Debian 包名，
#      不硬编码依赖清单 —— 二进制链接了什么就声明什么，避免虚报/漏报。
#   2. 版本单一来源：取自 src/rust/Cargo.toml 的 version（后端与包名同源），
#      Debian 修订号用 '~' 之前的部分 + '-' 后缀，避免与 main 分支的 PKG_VERSION 混淆。
#   3. 文件权限在打包阶段显式设定（0644/0755），不依赖 umask 与构建环境。
#   4. 幂等：每次从干净的 DEBIAN/ 树开始，重复执行结果一致。
#
# 跨平台：仅依赖 GNU coreutils + dpkg-deb + binutils（objdump/readelf），
#        不依赖特定发行版或发行版专属工具；Debian / Ubuntu / GitHub Actions 通用。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_SRC=""
OUT_DIR="$REPO_ROOT/dist"
REVISION="1"

while [ $# -gt 0 ]; do
    case "$1" in
        --bin)      BIN_SRC="${2:-}"; shift 2 ;;
        --out-dir)  OUT_DIR="${2:-}"; shift 2 ;;
        --revision) REVISION="${2:-}"; shift 2 ;;
        -h|--help)  sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

log()  { echo "==> $*"; }
warn() { echo "警告: $*" >&2; }
die()  { echo "错误: $*" >&2; exit 1; }

# 输出目录绝对化：后续步骤会 cd 进临时构建树，相对路径会失效
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# ---------- 1. 环境检查 ----------
log "检查打包工具链"
command -v dpkg-deb >/dev/null 2>&1 || die "缺少 dpkg-deb（apt install dpkg-dev 或 dpkg）"
command -v objdump >/dev/null 2>&1 || command -v readelf >/dev/null 2>&1 \
    || die "缺少 objdump/readelf（apt install binutils）"

# ---------- 2. 版本（单一来源：Cargo.toml）----------
# 版本取自 src/rust/Cargo.toml：后端即包本体，Debian 包版本与后端版本保持一致，
# 避免出现「包版本与二进制版本不一致」这类难以排查的问题。
CARGO_TOML="$REPO_ROOT/src/rust/Cargo.toml"
[ -f "$CARGO_TOML" ] || die "找不到 $CARGO_TOML"
PKG_VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$CARGO_TOML" | head -1)"
[ -n "$PKG_VERSION" ] || die "无法从 Cargo.toml 解析 version"

# Debian 版本格式：<upstream>-[<revision>]；revision 段不允许出现 '-'，
# 故 upstream 中的 '-' 先替换为 '~'（等价语义：'~' 排序低于空串）
PKG_DEB_VERSION="${PKG_VERSION//-/~}-$REVISION"

log "包版本: $PKG_DEB_VERSION（upstream $PKG_VERSION, revision $REVISION）"

# ---------- 3. 准备二进制 ----------
BIN=""
if [ -n "$BIN_SRC" ]; then
    [ -f "$BIN_SRC" ] || die "指定的二进制不存在: $BIN_SRC"
    BIN="$BIN_SRC"
    log "使用指定二进制: $BIN"
else
    command -v cargo >/dev/null 2>&1 || die "缺少 cargo（apt install cargo 或 rustup）"
    log "编译后端（cargo build --release）"
    (cd "$REPO_ROOT/src/rust" && cargo build --release)
    BIN="$REPO_ROOT/src/rust/target/release/at-webserver"
fi
[ -f "$BIN" ] || die "编译产物不存在: $BIN"

# ---------- 4. 架构判定（从 ELF 推断，不信任宿主 dpkg）----------
# 为什么必须从二进制推断：交叉编译场景下 `dpkg --print-architecture` 给出的是
# 宿主架构（在 x86_64 机器上打出 Architecture: amd64 却内含 aarch64 二进制），
# 该包在 arm64 设备上会被 dpkg 直接拒绝安装（"package architecture (amd64)
# does not match system (arm64)"）。因此以二进制自身的 ELF 机器类型为准。
#
# 注意：CI 已改为 GitHub 原生 arm runner（ubuntu-24.04-arm）编译，宿主架构与目标
#       架构天然一致，此处判定同样成立；保留自ELF 判定是为了让本脚本在本地交叉
#       编译、以及未来可能的其他交叉场景下依然产出正确架构标注的包。
detect_deb_arch() {
    local bin="$1" machine=""
    if command -v readelf >/dev/null 2>&1; then
        # readelf 输出形如 "AArch64" / "Advanced Micro Devices X86-64"（大小写不统一）
        machine="$(readelf -h "$bin" 2>/dev/null | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')"
    fi
    if [ -z "$machine" ] && command -v file >/dev/null 2>&1; then
        machine="$(file -b "$bin" 2>/dev/null)"
    fi
    # 先统一为小写再匹配：readelf/file 的架构串大小写不一致（aarch64 / AArch64）
    local m
    m="$(printf '%s' "$machine" | tr '[:upper:]' '[:lower:]')"
    case "$m" in
        *aarch64*|*arm64*)             echo "arm64" ;;
        *x86-64*|*x86_64*)             echo "amd64" ;;
        *armv7*|*armhf*)               echo "armhf" ;;
        *i386*|*i686*|*intel*80386*)   echo "i386" ;;
        *riscv64*)                     echo "riscv64" ;;
        *)
            # 兜底：宿主架构（仅当无法识别二进制时）
            dpkg --print-architecture 2>/dev/null || echo "amd64"
            ;;
    esac
}

DEB_ARCH="$(detect_deb_arch "$BIN")"
log "包架构: $DEB_ARCH（自 ELF 判定，宿主 dpkg 架构为 $(dpkg --print-architecture 2>/dev/null || echo 未知)）"

# ---------- 5. 依赖推导（读 ELF NEEDED，不硬编码）----------
log "解析二进制动态依赖"
NEEDED=""
if command -v objdump >/dev/null 2>&1; then
    NEEDED="$(objdump -p "$BIN" 2>/dev/null | awk '/NEEDED/ {print $2}' | sort -u)"
elif command -v readelf >/dev/null 2>&1; then
    NEEDED="$(readelf -d "$BIN" 2>/dev/null | sed -n 's/.*NEEDED.*\[\(.*\)\]/\1/p' | sort -u)"
fi

# ELF 库名 → Debian 包名映射（覆盖 glibc / gcc runtime 的常见 NEEDED）
map_dep() {
    case "$1" in
        libc.so.6|libm.so.6|libdl.so.2|libpthread.so.0|librt.so.1) echo "libc6" ;;
        libgcc_s.so.1)                                              echo "libgcc-s1" ;;
        libstdc++.so.6)                                             echo "libstdc++6" ;;
        *) echo "" ;;
    esac
}

DEBIAN_DEPS=""
for lib in $NEEDED; do
    pkg="$(map_dep "$lib")"
    if [ -z "$pkg" ]; then
        warn "未识别的动态库依赖: $lib（未写入 Depends，请确认是否需要补充映射）"
        continue
    fi
    # 多个 NEEDED（libc.so.6 / libm.so.6 / libpthread.so.0 ...）会映射到同一 Debian
    # 包，Depends 中重复声明属 lint 告警，这里按首次出现顺序去重。
    case ", $DEBIAN_DEPS," in
        *", $pkg,"*) continue ;;
    esac
    DEBIAN_DEPS="$DEBIAN_DEPS, $pkg"
done
DEBIAN_DEPS="${DEBIAN_DEPS#, }"
[ -n "$DEBIAN_DEPS" ] || DEBIAN_DEPS="libc6"
log "Depends: $DEBIAN_DEPS（原始 NEEDED: $(echo "$NEEDED" | tr '\n' ' ')）"

# ---------- 6. 组装 DEBIAN/ 与文件树 ----------
BUILD_DIR="$(mktemp -d)"
cleanup() { rm -rf "$BUILD_DIR"; }
trap cleanup EXIT

PKG_ROOT="$BUILD_DIR/at-webserver"
DEBIAN_DIR="$PKG_ROOT/DEBIAN"
mkdir -p "$DEBIAN_DIR"

log "组装文件树"
# 数据文件（与 install.sh 的安装路径保持一致）
install -d "$PKG_ROOT/usr/bin"
install -m 0755 "$BIN" "$PKG_ROOT/usr/bin/at-webserver"

install -d "$PKG_ROOT/usr/share/mt5700"
cp -r "$REPO_ROOT/webui" "$PKG_ROOT/usr/share/mt5700/webui"
find "$PKG_ROOT/usr/share/mt5700/webui" -type d -exec chmod 0755 {} +
find "$PKG_ROOT/usr/share/mt5700/webui" -type f -exec chmod 0644 {} +

install -d "$PKG_ROOT/etc/mt5700"
# config.json 作为 conffile（用户配置，升级时保留）
install -m 0644 "$REPO_ROOT/debian/config.json" "$PKG_ROOT/etc/mt5700/config.json"
install -m 0755 "$REPO_ROOT/debian/on-uplink.sh" "$PKG_ROOT/etc/mt5700/on-uplink.sh"

# systemd unit：放 /lib/systemd/system（Debian 惯例，usrmerge 后 /lib 指向 /usr/lib）
install -d "$PKG_ROOT/lib/systemd/system"
install -m 0644 "$REPO_ROOT/debian/at-webserver.service" \
    "$PKG_ROOT/lib/systemd/system/at-webserver.service"

# 文档与版权
install -d "$PKG_ROOT/usr/share/doc/at-webserver"
if [ -f "$REPO_ROOT/README.md" ]; then
    install -m 0644 "$REPO_ROOT/README.md" "$PKG_ROOT/usr/share/doc/at-webserver/README.md"
fi
if [ -f "$REPO_ROOT/LICENSE" ]; then
    install -m 0644 "$REPO_ROOT/LICENSE" "$PKG_ROOT/usr/share/doc/at-webserver/copyright"
fi
# 安装后的自检提示，避免用户装完不知道访问地址
cat > "$PKG_ROOT/usr/share/doc/at-webserver/README.Debian" <<'EOF'
at-webserver（Debian 独立版）

安装：
    apt install ./at-webserver_<版本>-<修订>_<架构>.deb

访问：
    WebUI 与 HTTP API 默认监听 0.0.0.0:9000，浏览器打开 http://<本机IP>:9000

常用命令：
    systemctl status at-webserver      查看运行状态
    systemctl restart at-webserver     重启服务
    journalctl -u at-webserver -n 50   查看最近日志

配置：
    /etc/mt5700/config.json            主配置（升级时保留）
    /etc/mt5700/on-uplink.sh           拨号就绪钩子

串口权限：
    服务以 dialout 附加组运行（见 service 单元 SupplementaryGroups）。
    若 USB 串口权限受限，可将用户加入 dialout 组后重新登录：
        usermod -aG dialout <用户名>
EOF

# ---------- 7. DEBIAN 元数据 ----------
log "写入 DEBIAN 元数据"

# Installed-Size 含数据文件与文档（DEBIAN 自身不计）
TOTAL_KB="$(du -sk --exclude=DEBIAN "$PKG_ROOT" | awk '{print $1}')"

cat > "$DEBIAN_DIR/control" <<EOF
Package: at-webserver
Version: $PKG_DEB_VERSION
Section: net
Priority: optional
Architecture: $DEB_ARCH
Installed-Size: $TOTAL_KB
Depends: $DEBIAN_DEPS
Maintainer: LianXia233 <LianXia233@users.noreply.github.com>
Homepage: https://github.com/LianXia233/luci-app-mt5700
Description: MT5700M 5G module management service (WebUI + HTTP API)
 MT5700M 5G 模组管理服务：WebUI 界面 + HTTP API 后端，负责 AT 命令队列、
 URC 主动上报分发、网络状态与信号解析、拨号管理、全网扫频、定时锁频、
 短信收发、FOTA 升级与 AT 调试终端。
 .
 本包为 luci-app-mt5700 的 Debian 独立版，不依赖 OpenWrt / LuCI / ubus / rpcd /
 UCI，systemd 管理，随包安装 WebUI 静态资源至 /usr/share/mt5700/webui。
EOF

# conffiles：升级时保留用户配置
echo "/etc/mt5700/config.json" > "$DEBIAN_DIR/conffiles"

# postinst：注册并启动服务（遵循 deb-systemd-helper 惯例，避免容器内报错）
cat > "$DEBIAN_DIR/postinst" <<'EOF'
#!/bin/sh
# at-webserver 安装后处理：重载 systemd、注册并启动服务。
set -e

case "$1" in
    configure)
        # systemd 存在才操作；容器/chroot 内无 systemd 时静默跳过，不阻塞安装
        if [ -d /run/systemd/system ] || command -v systemctl >/dev/null 2>&1; then
            systemctl daemon-reload >/dev/null 2>&1 || true
            # deb-systemd-helper 兼容容器内 no-op 策略
            if command -v deb-systemd-helper >/dev/null 2>&1; then
                deb-systemd-helper unmask at-webserver.service >/dev/null 2>&1 || true
                deb-systemd-helper enable at-webserver.service >/dev/null 2>&1 || true
            else
                systemctl enable at-webserver.service >/dev/null 2>&1 || true
            fi
            # 启动失败（如未接模组）不阻断安装：服务已 enable，插上模组后可手动 start
            if [ -d /run/systemd/system ]; then
                systemctl restart at-webserver.service >/dev/null 2>&1 || \
                    echo "提示：服务未能自动启动，请检查 journalctl -u at-webserver" >&2
            fi
        fi
        ;;
    abort-upgrade|abort-remove|abort-deconfigure) ;;
    *) ;;
esac

exit 0
EOF

# prerm：卸载/升级前停服务
cat > "$DEBIAN_DIR/prerm" <<'EOF'
#!/bin/sh
# at-webserver 卸载前处理：停止并禁用服务。
set -e

case "$1" in
    remove|deconfigure|upgrade)
        if command -v systemctl >/dev/null 2>&1; then
            systemctl stop at-webserver.service >/dev/null 2>&1 || true
            if command -v deb-systemd-helper >/dev/null 2>&1; then
                deb-systemd-helper unmask at-webserver.service >/dev/null 2>&1 || true
                deb-systemd-helper disable at-webserver.service >/dev/null 2>&1 || true
            else
                systemctl disable at-webserver.service >/dev/null 2>&1 || true
            fi
        fi
        ;;
    *) ;;
esac

exit 0
EOF

# postrm：清理服务残留（purge 时删数据目录由 dpkg 处理，此处仅收尾 systemd 状态）
cat > "$DEBIAN_DIR/postrm" <<'EOF'
#!/bin/sh
# at-webserver 卸载后处理：清理 systemd 运行时残留。
set -e

case "$1" in
    purge|remove|upgrade)
        if command -v systemctl >/dev/null 2>&1; then
            systemctl daemon-reload >/dev/null 2>&1 || true
        fi
        # on-uplink.sh 由后端按配置键调用，配置已随 /etc/mt5700 移除，此处无需额外动作
        ;;
    *) ;;
esac

exit 0
EOF

chmod 0755 "$DEBIAN_DIR/postinst" "$DEBIAN_DIR/prerm" "$DEBIAN_DIR/postrm"
chmod 0644 "$DEBIAN_DIR/control" "$DEBIAN_DIR/conffiles"

# ---------- 8. 元数据自检（build 之前先挡住明显错误）----------
log "校验 DEBIAN 元数据"
for f in control conffiles postinst prerm postrm; do
    [ -f "$DEBIAN_DIR/$f" ] || die "缺少 DEBIAN/$f"
done
# control 必需字段
for field in Package Version Architecture Maintainer Description; do
    grep -q "^$field:" "$DEBIAN_DIR/control" || die "DEBIAN/control 缺少必需字段: $field"
done
# maintainer scripts 语法检查（POSIX sh）
for f in postinst prerm postrm; do
    sh -n "$DEBIAN_DIR/$f" || die "DEBIAN/$f 语法错误"
done
# conffile 必须真实存在于包内
while read -r cf; do
    [ -z "$cf" ] && continue
    rel="${cf#/}"
    [ -e "$PKG_ROOT/$rel" ] || die "conffiles 指向不存在的文件: $cf"
done < "$DEBIAN_DIR/conffiles"

# ---------- 9. 构建 ----------
PKG_FILE="$OUT_DIR/at-webserver_${PKG_DEB_VERSION}_${DEB_ARCH}.deb"
rm -f "$PKG_FILE"

log "构建 deb: $(basename "$PKG_FILE")"
(cd "$PKG_ROOT" && dpkg-deb --root-owner-group --build . "$PKG_FILE" >/dev/null) \
    || die "dpkg-deb 构建失败"
[ -f "$PKG_FILE" ] || die "产物未生成: $PKG_FILE"

# ---------- 10. 产物校验 ----------
log "校验产物"
dpkg-deb --info "$PKG_FILE" >/dev/null || die "产物 info 校验失败"
if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb --field "$PKG_FILE" Package Version Architecture Depends | sed 's/^/    /'
fi
PKG_SIZE="$(du -h "$PKG_FILE" | cut -f1)"
log "完成: $PKG_FILE ($PKG_SIZE)"
log "安装命令: apt install ./$(basename "$PKG_FILE")"