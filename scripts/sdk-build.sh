#!/bin/sh
# 在 openwrt/sdk 容器内构建 luci-app-mt5700 + at-webserver-rust（Rust 后端）
# 用法: sdk-build.sh <ARCH> <RUST_TRIPLE> <VER>
#   ARCH        OpenWrt 架构名（x86_64 / aarch64_cortex-a53 / mips_24kc ...）
#   RUST_TRIPLE Rust musl 目标三元组（x86_64-unknown-linux-musl ...）
#   VER         OpenWrt 版本（main / 23.05.5 ...，决定 SDK 下载路径）
# 说明: SDK 由脚本下载到 /builder 并解压；Rust 交叉编译使用 zig 作为链接器；
#       cargo/rust/zig 只装进容器 /opt 与 /builder，不写入仓库。
set -e

ARCH="$1"
RUST_TRIPLE="$2"
VER="$3"
[ -n "$ARCH" ] && [ -n "$RUST_TRIPLE" ] && [ -n "$VER" ] || { echo "usage: sdk-build.sh <ARCH> <RUST_TRIPLE> <VER>"; exit 1; }

echo "==> 仓库挂载: /work / out:/out（构建开始, arch=$ARCH ver=$VER）"

# ---------- 0) 基础工具（SDK 容器已内置 curl/tar/gosu；xz/zst 压缩包解压需要对应工具） ----------
SUDO=''
if [ "$(id -u)" -ne 0 ]; then SUDO='sudo'; fi
if command -v apt-get >/dev/null 2>&1; then
  if [ -n "$SUDO" ] && ! command -v sudo >/dev/null 2>&1; then
    echo "WARN: 容器非 root 且无 sudo，跳过 apt 补装（SDK 解压将尝试 tar 内置支持）"
  else
    $SUDO apt-get update -qq -o Acquire::Check-Valid-Until=false || true
    $SUDO apt-get install -y -qq xz-utils zstd >/dev/null 2>&1 || true
  fi
fi
command -v curl >/dev/null 2>&1 || { echo "ERROR: 容器缺少 curl"; exit 1; }
command -v zstd >/dev/null 2>&1 || echo "WARN: 容器缺少 zstd（snapshot SDK 为 .tar.zst 时需要）"

# ---------- 1) 下载并解压 OpenWrt SDK（/builder，不落盘到仓库） ----------
case "$VER" in
  main|snapshots) BASE_URL="https://downloads.openwrt.org/snapshots" ;;
  *) BASE_URL="https://downloads.openwrt.org/releases/$VER" ;;
esac
TARGET_DIR="${TARGET:-x86/64}"
echo "==> 定位 SDK: $BASE_URL/targets/$TARGET_DIR/"
LISTING=$(curl -sL "$BASE_URL/targets/$TARGET_DIR/")
SDK_FILE=$(echo "$LISTING" | grep -oE 'openwrt-sdk-[^"< ]+\.tar\.(xz|zst)' | grep -v '\.asc' | head -1)
[ -n "$SDK_FILE" ] || { echo "ERROR: 未找到 SDK 下载文件（$BASE_URL/targets/$TARGET_DIR/）"; exit 1; }
echo "==> 下载 SDK: $SDK_FILE"
curl -sSL "$BASE_URL/targets/$TARGET_DIR/$SDK_FILE" -o /builder/sdk.tar
tar -xf /builder/sdk.tar -C /builder
rm -f /builder/sdk.tar
SDK_DIR=$(find /builder -maxdepth 1 -type d -name 'openwrt-sdk-*' | head -1)
[ -n "$SDK_DIR" ] && [ -f "$SDK_DIR/feeds.conf.default" ] || { echo "ERROR: SDK 解压异常"; ls -la /builder; exit 1; }
cd "$SDK_DIR"
echo "==> SDK 根目录: $SDK_DIR"

# ---------- 2) Rust 工具链（仅容器内 /opt，不落盘到仓库） ----------
# mipsel-unknown-linux-musl 在 Rust 1.87+ 已移除预编译，固定用 1.86.0
export RUSTUP_HOME=/opt/rust
export CARGO_HOME=/opt/cargo
if [ "$RUST_TRIPLE" = "mipsel-unknown-linux-musl" ]; then
  RUST_TOOLCHAIN=1.86.0
else
  RUST_TOOLCHAIN=stable
fi
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$RUST_TOOLCHAIN" >/dev/null
fi
export PATH="$CARGO_HOME/bin:$PATH"
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal >/dev/null 2>&1 || true
rustup default "$RUST_TOOLCHAIN"
rustup target add "$RUST_TRIPLE"

# ---------- 3) zig（交叉链接器，支持 musl 静态链接全部目标） ----------
ZIG_VER=0.13.0
if [ ! -x "/opt/bin/zig" ]; then
  mkdir -p /opt/bin
  curl -fsSL "https://ziglang.org/download/${ZIG_VER}/zig-linux-x86_64-${ZIG_VER}.tar.xz" \
    | tar -xJ -C /opt
  ln -sf "/opt/zig-linux-x86_64-${ZIG_VER}/zig" /opt/bin/zig
fi
export PATH="/opt/bin:$PATH"
zig version

# Rust triple → zig target 映射（zig 使用 arm-* 而非 armv7-*）
case "$RUST_TRIPLE" in
  x86_64-unknown-linux-musl)         ZIG_TARGET=x86_64-linux-musl ;;
  aarch64-unknown-linux-musl)        ZIG_TARGET=aarch64-linux-musl ;;
  mipsel-unknown-linux-musl)         ZIG_TARGET=mipsel-linux-musl ;;
  armv7-unknown-linux-musleabihf)    ZIG_TARGET=arm-linux-musleabihf ;;
  *) ZIG_TARGET="$(echo "$RUST_TRIPLE" | sed 's/-unknown-/-/')" ;;
esac

# 生成 zig 链接器 wrapper + cargo 全局配置（仅容器内，不写入仓库）
cat > /opt/zig-linker <<EOF
#!/bin/sh
exec /opt/bin/zig cc -target ${ZIG_TARGET} "\$@"
EOF
chmod +x /opt/zig-linker
mkdir -p "${CARGO_HOME}"
cat > "${CARGO_HOME}/config.toml" <<EOF
[target.${RUST_TRIPLE}]
linker = "/opt/zig-linker"
EOF
echo "==> zig linker: ${RUST_TRIPLE} -> ${ZIG_TARGET}"

# ---------- 4) 把仓库包放入 buildroot package/ ----------
mkdir -p package/luci-app-mt5700 package/at-webserver-rust
cp -r /work/Makefile /work/htdocs /work/po /work/root package/luci-app-mt5700/
cp -r /work/src/rust/. package/at-webserver-rust/    # 含 Makefile + Cargo.toml（链接器由 cargo 全局 config 提供）

# ---------- 5) feeds（确保 luci feed 的 luci.mk 可用） ----------
if [ ! -f feeds/luci/luci.mk ]; then
  echo "==> 初始化 feeds"
  ./scripts/feeds update -a >/dev/null 2>&1 || true
  ./scripts/feeds install -a >/dev/null 2>&1 || true
fi
[ -f feeds/luci/luci.mk ] || { echo "ERROR: luci feed 不可用"; exit 1; }

# ---------- 6) 配置并编译 ----------
make defconfig >/dev/null
echo "==> 编译 Rust 后端（at-webserver-rust, target=$RUST_TRIPLE）"
make package/at-webserver-rust/compile V=s
echo "==> 编译 LuCI 插件（luci-app-mt5700）"
make package/luci-app-mt5700/compile V=s

# ---------- 7) 收集产物到 /out ----------
mkdir -p "/out/${ARCH}"
find bin -type f \( -name '*.apk' -o -name '*.ipk' \) -exec cp {} "/out/${ARCH}/" \;
echo "==> 产物："
ls -la "/out/${ARCH}/"
echo "==> SDK 构建完成"
