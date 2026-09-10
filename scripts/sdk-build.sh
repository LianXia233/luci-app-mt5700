#!/bin/sh
# 在 openwrt/sdk 容器内构建 luci-app-mt5700 + at-webserver-rust（Rust 后端）
# 用法: sdk-build.sh <ARCH> <RUST_TRIPLE>
#   ARCH        OpenWrt 架构名（x86_64 / aarch64_cortex-a53 / mips_24kc ...）
#   RUST_TRIPLE Rust musl 目标三元组（x86_64-unknown-linux-musl ...）
# 说明: Rust 交叉编译使用 zig 作为链接器（.cargo/config.toml 已配置），
#       cargo 与 zig 只装进容器 /opt，不写入仓库。
set -e

ARCH="$1"
RUST_TRIPLE="$2"
[ -n "$ARCH" ] && [ -n "$RUST_TRIPLE" ] || { echo "usage: sdk-build.sh <ARCH> <RUST_TRIPLE>"; exit 1; }

echo "==> 仓库挂载: /work（构建开始）"

# ---------- 0) 仓库源码布局 ----------
cd /work

# ---------- 1) 基础工具 ----------
apt-get update -qq
apt-get install -y -qq curl xz-utils ca-certificates >/dev/null

# ---------- 2) Rust 工具链（仅容器内 /opt，不落盘到仓库） ----------
export RUSTUP_HOME=/opt/rust
export CARGO_HOME=/opt/cargo
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null
export PATH="$CARGO_HOME/bin:$PATH"
rustup target add "$RUST_TRIPLE"

# ---------- 3) zig（交叉链接器，支持 musl 静态链接全部目标） ----------
ZIG_VER=0.13.0
curl -fsSL "https://ziglang.org/download/${ZIG_VER}/zig-linux-x86_64-${ZIG_VER}.tar.xz" \
  | tar -xJ -C /opt
ln -sf "/opt/zig-linux-x86_64-${ZIG_VER}/zig" /usr/local/bin/zig
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
exec zig cc -target ${ZIG_TARGET} "\$@"
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
cp -r Makefile htdocs po root package/luci-app-mt5700/
cp -r src/rust/. package/at-webserver-rust/    # 含 Makefile + Cargo.toml（链接器由 cargo 全局 config 提供）

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
