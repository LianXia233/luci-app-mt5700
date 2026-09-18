#!/bin/sh
# 在 openwrt/sdk 容器内构建 luci-app-mt5700 + at-webserver-rust（Rust 后端）
#
# 用法: sdk-build.sh <EXPECTED_ARCH> <RUST_TRIPLE> <VER> [TARGET_DIR]
#   EXPECTED_ARCH  矩阵登记的 ARCH_PACKAGES（如 aarch64_cortex-a53 / aarch64_generic）
#                  仅用于核对与日志；真实架构从 SDK 的 .config 读取，并据此命名输出目录
#   RUST_TRIPLE    Rust musl 目标三元组（x86_64-unknown-linux-musl ...）
#   VER            OpenWrt 版本（25.12.5 / 24.10.8 ...），仅决定 SDK 回退下载路径
#   TARGET_DIR     OpenWrt target/subtarget（x86/64、mediatek/filogic、armsr/armv8 ...），仅用于回退下载
#
# 架构由谁决定：ARCH_PACKAGES = <ARCH>[_<CPU_TYPE>]，未定义 CPU_TYPE 时为 <ARCH>_generic。
# 同一颗 Cortex-A53，在 CPU_TYPE=cortex-a53 的 target 上是 aarch64_cortex-a53，
# 在未定义 CPU_TYPE 的 target（如 armsr/armv8）上是 aarch64_generic。
# apk 对 <base>_<variant> 做严格匹配，两者不可互换，因此本脚本以 SDK 实际报告的
# ARCH_PACKAGES 为准命名 out/<arch>/，从根上消除「文件名说 A、包内是 B」的错配。
#
# 说明: Rust 交叉编译使用 zig 作为链接器；cargo/rust/zig 只装进容器 /opt，不写入仓库。
set -e

EXPECTED_ARCH="$1"
RUST_TRIPLE="$2"
VER="$3"
[ -n "$EXPECTED_ARCH" ] && [ -n "$RUST_TRIPLE" ] && [ -n "$VER" ] || { echo "usage: sdk-build.sh <EXPECTED_ARCH> <RUST_TRIPLE> <VER> [TARGET_DIR]"; exit 1; }

echo "==> 仓库挂载: /work / out:/out（构建开始, 期望架构=$EXPECTED_ARCH ver=$VER）"

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

# ---------- 1) 定位 OpenWrt SDK（优先镜像自带的 /builder，不落盘到仓库） ----------
# 关键：绝不使用 `find ... | head -1` 在多个 SDK 目录间挑一个——readdir 顺序不确定，
# 可能选中镜像自带但与矩阵 target 不符的那一份，导致产物与目标平台错配且无任何提示。
TARGET_DIR="${4:-${TARGET:-x86/64}}"
SDK_DIR=""

if [ -f /builder/feeds.conf.default ] && [ -f /builder/Makefile ]; then
  # 官方 openwrt/sdk 镜像把 SDK 直接解压在 /builder
  SDK_DIR=/builder
  echo "==> 使用镜像自带 SDK: $SDK_DIR"
else
  CANDIDATES=$(find /builder -maxdepth 1 -type d -name 'openwrt-sdk-*' 2>/dev/null || true)
  N=$(printf '%s\n' "$CANDIDATES" | grep -c . || true)
  if [ "$N" -eq 1 ] && [ -f "$CANDIDATES/feeds.conf.default" ]; then
    SDK_DIR="$CANDIDATES"
    echo "==> 使用镜像自带 SDK: $SDK_DIR"
  else
    [ "$N" -gt 1 ] && echo "WARN: /builder 下有 $N 个 SDK 目录，全部清理后重新下载以消除歧义"
    rm -rf /builder/openwrt-sdk-*
    case "$VER" in
      main|snapshots) BASE_URL="https://downloads.openwrt.org/snapshots" ;;
      *) BASE_URL="https://downloads.openwrt.org/releases/$VER" ;;
    esac
    echo "==> 定位 SDK: $BASE_URL/targets/$TARGET_DIR/"
    LISTING=$(curl -sL "$BASE_URL/targets/$TARGET_DIR/")
    SDK_FILE=$(echo "$LISTING" | grep -oE 'openwrt-sdk-[^"< ]+\.tar\.(xz|zst)' | grep -v '\.asc' | head -1)
    [ -n "$SDK_FILE" ] || { echo "ERROR: 未找到 SDK 下载文件（$BASE_URL/targets/$TARGET_DIR/）"; exit 1; }
    echo "==> 下载 SDK: $SDK_FILE"
    curl -sSL "$BASE_URL/targets/$TARGET_DIR/$SDK_FILE" -o /builder/sdk.tar
    tar -xf /builder/sdk.tar -C /builder
    rm -f /builder/sdk.tar
    SDK_DIR=$(find /builder -maxdepth 1 -type d -name 'openwrt-sdk-*' | head -1)
  fi
fi

[ -n "$SDK_DIR" ] && [ -f "$SDK_DIR/feeds.conf.default" ] || { echo "ERROR: SDK 解压异常"; ls -la /builder; exit 1; }
cd "$SDK_DIR"
echo "==> SDK 根目录: $SDK_DIR"

# ---------- 2) Rust 工具链（仅容器内 /opt，不落盘到仓库） ----------
# mipsel-unknown-linux-musl 自 Rust 1.75 起无预编译 std：用 nightly + `-Z build-std` 现编
export RUSTUP_HOME=/opt/rust
export CARGO_HOME=/opt/cargo
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null
fi
export PATH="$CARGO_HOME/bin:$PATH"
if [ "$RUST_TRIPLE" = "mipsel-unknown-linux-musl" ]; then
  echo "==> mips: nightly + build-std（musl std 无预编译）"
  rustup toolchain install nightly --profile minimal --component rust-src >/dev/null 2>&1
  rustup default nightly
  # -Z build-std 是 cargo 的 unstable 选项（经 Makefile 的 $(CARGO_BUILD_STD_FLAGS) 传入）
  export CARGO_BUILD_STD_FLAGS="-Z build-std=std,panic_abort"
else
  rustup default stable
  rustup target add "$RUST_TRIPLE"
fi

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
  mips-unknown-linux-musl)           ZIG_TARGET=mips-linux-musl ;;
  mipsel-unknown-linux-musl)         ZIG_TARGET=mipsel-linux-musl ;;
  armv7-unknown-linux-musleabihf)    ZIG_TARGET=arm-linux-musleabihf ;;
  *) ZIG_TARGET="$(echo "$RUST_TRIPLE" | sed 's/-unknown-/-/')" ;;
esac

# 生成 zig 链接器 wrapper + cargo 全局配置（仅容器内，不写入仓库）
# 过滤 zig 不认识的 OpenWrt/LLD 旗标（aarch64_cortex-a53 会注入 --fix-cortex-a53-843419）
cat > /opt/zig-linker <<EOF
#!/bin/sh
# zig 0.13 不支持 --fix-cortex-a53-843419 等 LLD 专有旗标，链接时丢弃
for a in "\$@"; do
  case "\$a" in
    *--fix-cortex-a53*) ;;
    *) set -- "\$@" "\$a" ;;
  esac
  shift
done
exec /opt/bin/zig cc -target ${ZIG_TARGET} "\$@"
EOF
chmod +x /opt/zig-linker
sh -n /opt/zig-linker && echo "==> zig-linker 语法 OK, target=${ZIG_TARGET}"
mkdir -p "${CARGO_HOME}"
cat > "${CARGO_HOME}/config.toml" <<EOF
[target.${RUST_TRIPLE}]
linker = "/opt/zig-linker"
# 关键修复：让 zig 全权负责 crt（crt1/crti/crtn 等），rustc 不再传递
# self-contained crt，否则两者叠加导致 ld.lld duplicate symbol:
# _start/_init/_fini/_start_c（此前云编译在链接阶段必然失败）。
# 已用 zig 0.13 + rust stable 本地实测 x86_64 musl 构建通过。
rustflags = ["-C", "link-self-contained=no"]
EOF
echo "==> zig linker: ${RUST_TRIPLE} -> ${ZIG_TARGET}"

# ---------- 4) 把仓库包放入 buildroot package/ ----------
# 单包结构：src/Makefile 让 luci.mk 在编译 LuCI 包时顺带编译 Rust 后端，
# 并把 at-webserver-rust 二进制装进同一个包，不再有独立的 at-webserver-rust 包。
rm -rf package/luci-app-mt5700
mkdir -p package/luci-app-mt5700
cp -r /work/Makefile /work/htdocs /work/po /work/root /work/src package/luci-app-mt5700/
# 确保 init.d / uci-defaults / hotplug / libexec 可执行（cp -r 在部分环境可能丢 +x）
chmod 0755 package/luci-app-mt5700/root/etc/init.d/at-webserver
chmod 0755 package/luci-app-mt5700/root/etc/uci-defaults/at-webserver
chmod 0755 package/luci-app-mt5700/root/etc/hotplug.d/iface/99-at-webserver
chmod 0755 package/luci-app-mt5700/root/etc/hotplug.d/usb/99-at-webserver
chmod 0755 package/luci-app-mt5700/root/usr/libexec/at-webserver/on-uplink.sh

# ---------- 5) feeds（确保 luci feed 的 luci.mk 可用；只更新 luci，避免多 feed 元数据重复导致递归依赖） ----------
if [ ! -f feeds/luci/luci.mk ]; then
  echo "==> 初始化 feeds（仅 luci）"
  ./scripts/feeds update luci >/dev/null 2>&1 || echo "WARN: feeds update luci 失败"
  ./scripts/feeds install luci >/dev/null 2>&1 || true
fi
[ -f feeds/luci/luci.mk ] || { echo "ERROR: luci feed 不可用"; exit 1; }

# ---------- 6) 配置并编译 ----------
rm -rf tmp

# 关键：显式选中包。SDK 的 defconfig 不会自动选中后复制到 package/ 的包，
# 未选中时 `make package/<pkg>/compile` 只打印 "Nothing to be done" 并返回 0，
# 于是包被静默跳过（v1.0.0 Release 就因此只发出 LuCI 前端包，缺失后端）。
touch .config
for p in luci-app-mt5700; do
	grep -v "^CONFIG_PACKAGE_${p}=" .config > .config.new || true
	mv .config.new .config
	echo "CONFIG_PACKAGE_${p}=m" >> .config
	# 中文语言包随主包一起发布
	echo "CONFIG_PACKAGE_luci-i18n-mt5700-zh-cn=m" >> .config
done

make defconfig >/dev/null

# ---------- 6.1) 读取 SDK 真实架构（决定输出目录，杜绝架构错配） ----------
ARCH_PKGS=$(sed -n 's/^CONFIG_TARGET_ARCH_PACKAGES="\(.*\)"$/\1/p' .config | head -1)
[ -n "$ARCH_PKGS" ] || ARCH_PKGS="$EXPECTED_ARCH"
TGT_BOARD=$(sed -n 's/^CONFIG_TARGET_BOARD="\(.*\)"$/\1/p' .config | head -1)
TGT_SUB=$(sed -n 's/^CONFIG_TARGET_SUBTARGET="\(.*\)"$/\1/p' .config | head -1)

echo "==> SDK 实际架构: ARCH_PACKAGES=$ARCH_PKGS (board=${TGT_BOARD:-?}/${TGT_SUB:-?})"
echo "==> 矩阵期望架构: $EXPECTED_ARCH"
if [ "$ARCH_PKGS" != "$EXPECTED_ARCH" ]; then
  echo "WARN: SDK 实际架构与矩阵期望不一致——输出目录将使用实际架构 $ARCH_PKGS，"
  echo "WARN: workflow 的架构闸门会据此判定失败，请在矩阵里把 image/arch 配对修正。"
fi

echo "==> package 目录："
ls -d package/* 2>/dev/null || true
echo "==> 选中状态："
grep -E '^CONFIG_PACKAGE_(luci-app-mt5700|luci-i18n-mt5700-zh-cn)=' .config || true
echo "==> packageinfo 中的本项目包："
grep -cE '^(Source-)?Package: luci-app-mt5700$' tmp/.packageinfo 2>/dev/null || true
# 未选中必须立刻失败，绝不能静默产出空包集合
grep -qE '^CONFIG_PACKAGE_luci-app-mt5700=[my]$' .config \
	|| { echo "ERROR: luci-app-mt5700 未被 .config 选中"; exit 1; }

# RUST_TRIPLE 传给 src/Makefile（子 make 拿不到顶层 ARCH 映射时用得上）
export RUST_TRIPLE

echo "==> 编译单包（LuCI 前端 + Rust 后端，target=$RUST_TRIPLE arch=$ARCH_PKGS）"
make package/luci-app-mt5700/compile V=s

# 校验后端二进制确实被打包进主包（.pkgdir 是最终进包目录）。
# 注意：LuCI 编译完成后会清理 build_dir 下的 src/ 源码目录（含 cargo target），
# 所以不能找 src/target/.../release/at-webserver，改找 .pkgdir 里的安装文件
# at-webserver-rust（这正是 install 步骤 cp 的产物，也对应包内路径 usr/bin/at-webserver-rust）。
BIN_PATH=""
BIN_PATH=$(find build_dir -type f -name 'at-webserver-rust' -print -quit 2>/dev/null)
[ -n "$BIN_PATH" ] || {
	echo "ERROR: 未找到打包产物 at-webserver-rust"
	echo "--- 全盘搜索 at-webserver* ---"
	find build_dir -name 'at-webserver*' 2>/dev/null | head -10
	echo "--- .pkgdir usr/bin ---"
	ls -la build_dir/target-*_musl/luci-app-mt5700/.pkgdir/*/usr/bin/ 2>/dev/null | head -10
	exit 1
}
echo "==> 后端产物: $BIN_PATH"

# 二进制架构自检：确保 Rust 产物确实是对目标架构（防宿主架构兜底混入）
if command -v file >/dev/null 2>&1; then
	echo "==> 后端二进制信息: $(file -b "$BIN_PATH")"
fi
case "$RUST_TRIPLE" in
	aarch64-*) EXPECT_ELF="aarch64" ;;
	x86_64-*)  EXPECT_ELF="x86-64" ;;
	mipsel-*)  EXPECT_ELF="MIPS" ;;
	mips-*)    EXPECT_ELF="MIPS" ;;
	armv7-*)   EXPECT_ELF="ARM" ;;
	*)         EXPECT_ELF="" ;;
esac
if [ -n "$EXPECT_ELF" ] && command -v file >/dev/null 2>&1; then
	if file -b "$BIN_PATH" | grep -qi "$EXPECT_ELF"; then
		echo "==> ELF 架构核对通过（期望含 $EXPECT_ELF）"
	else
		echo "ERROR: 后端二进制架构与目标 $RUST_TRIPLE 不符，疑似宿主架构兜底产物"
		file -b "$BIN_PATH"
		exit 1
	fi
fi

# ---------- 7) 收集产物到 /out/<真实架构>/（白名单：只收本项目包）----------
# 系统库（libc/libgcc1/libstdcpp6/libatomic1/libquadmath1/libpthread/librt 等）由 opkg/apk
# 在安装时按依赖自动解决，不应出现在 Release 资产里。
mkdir -p "/out/${ARCH_PKGS}"
find bin -type f \( -name '*.apk' -o -name '*.ipk' \) \
	\( -name 'luci-app-mt5700*' -o -name 'luci-i18n-mt5700*' \) \
	-exec cp {} "/out/${ARCH_PKGS}/" \;
echo "==> 产物（仅本项目包）："
ls -la "/out/${ARCH_PKGS}/"
echo "==> bin 下全部包（排查用）："
find bin -type f \( -name '*.apk' -o -name '*.ipk' \) 2>/dev/null | sort | head -50

# 架构元数据：workflow 用它核对「矩阵期望架构 == SDK 实际架构」，
# 也随 artifact 保留，便于事后追溯某个包究竟是哪个架构编出来的。
APK_VER=$(apk --version 2>/dev/null | head -1 || true)
cat > "/out/${ARCH_PKGS}/ARCH.txt" <<EOF
ARCH_PACKAGES=${ARCH_PKGS}
EXPECTED_ARCH=${EXPECTED_ARCH}
MATCH=$([ "$ARCH_PKGS" = "$EXPECTED_ARCH" ] && echo yes || echo no)
TARGET_BOARD=${TGT_BOARD:-unknown}
TARGET_SUBTARGET=${TGT_SUB:-unknown}
OPENWRT_VER=${VER}
RUST_TRIPLE=${RUST_TRIPLE}
APK_TOOLS=${APK_VER:-none}
EOF
cat "/out/${ARCH_PKGS}/ARCH.txt"

# 产物完整性闸门：缺任一必需包就让构建失败，避免再次发布不可安装的 Release
for p in luci-app-mt5700; do
	if [ -z "$(find "/out/${ARCH_PKGS}" -type f -name "${p}*" -print -quit)" ]; then
		echo "ERROR: /out/${ARCH_PKGS} 缺少 ${p} 包产物（arch=${ARCH_PKGS}）"
		exit 1
	fi
done

# 单包必须内含后端二进制。
# OpenWrt 24.10+ .apk 不是标准 tar.gz（file 显示 data），不能用 tar 列目录。
# 校验策略：ipk 用 tar 列文件；apk 用「安装树 + 包体体积」判定。
PKG_FILE=$(find "/out/${ARCH_PKGS}" -type f -name 'luci-app-mt5700*' -not -name 'luci-i18n*' -print -quit)
[ -n "$PKG_FILE" ] || { echo "ERROR: 未找到 luci-app-mt5700 主包"; exit 1; }
PKG_SZ=$(wc -c < "$PKG_FILE")
echo "==> 校验主包: $(basename "$PKG_FILE") (${PKG_SZ} bytes)"

STAGE_BIN=$(find build_dir -type f -path '*/luci-app-mt5700/ipkg-*/luci-app-mt5700/usr/bin/at-webserver-rust' -print -quit 2>/dev/null)
if [ -n "$STAGE_BIN" ]; then
	echo "==> 安装树已含后端: $STAGE_BIN ($(wc -c < "$STAGE_BIN") bytes)"
fi

case "$PKG_FILE" in
	*.ipk)
		if tar -xzOf "$PKG_FILE" ./data.tar.gz 2>/dev/null | tar -tzf - 2>/dev/null | grep -qE '(^|/)usr/bin/at-webserver-rust$'; then
			echo "==> 已确认 ipk 内含 usr/bin/at-webserver-rust"
		elif [ -n "$STAGE_BIN" ] && [ "$PKG_SZ" -gt 500000 ]; then
			echo "==> ipk 列表未列出但安装树含后端且包体 ${PKG_SZ}B，判定通过"
		else
			echo "ERROR: ipk 缺少 at-webserver-rust"
			exit 1
		fi
		;;
	*.apk)
		# 纯前端约 100-200KB；含 Rust musl 后端约 1MB+
		if [ -n "$STAGE_BIN" ] && [ "$PKG_SZ" -gt 500000 ]; then
			echo "==> apk 安装树含后端且包体 ${PKG_SZ}B，判定为前后端一体单包"
		elif [ "$PKG_SZ" -gt 500000 ]; then
			echo "==> apk 包体 ${PKG_SZ}B（未找到安装树路径，按体积判定通过）"
		else
			echo "ERROR: apk 过小 (${PKG_SZ}B) 或安装树缺后端，疑似只有前端"
			exit 1
		fi
		;;
esac
echo "==> SDK 构建完成（arch=${ARCH_PKGS}）"
