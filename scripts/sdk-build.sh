#!/bin/sh
# 在 openwrt/sdk 容器内构建 luci-app-mt5700 + at-webserver-rust（Rust 后端）
# 用法: sdk-build.sh <ARCH> <RUST_TRIPLE> <VER> [TARGET_DIR]
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
TARGET_DIR="${4:-${TARGET:-x86/64}}"
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
mkdir -p package/luci-app-mt5700
cp -r /work/Makefile /work/htdocs /work/po /work/root /work/src package/luci-app-mt5700/

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

echo "==> 编译单包（LuCI 前端 + Rust 后端，target=$RUST_TRIPLE）"
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

# ---------- 7) 收集产物到 /out（白名单：只收本项目包，排除 SDK 顺带编译的系统库）----------
# 系统库（libc/libgcc1/libstdcpp6/libatomic1/libquadmath1/libpthread/librt 等）由 opkg/apk
# 在安装时按依赖自动解决，不应出现在 Release 资产里。
mkdir -p "/out/${ARCH}"
find bin -type f \( -name '*.apk' -o -name '*.ipk' \) \
	\( -name 'luci-app-mt5700*' -o -name 'luci-i18n-mt5700*' \) \
	-exec cp {} "/out/${ARCH}/" \;
echo "==> 产物（仅本项目包）："
ls -la "/out/${ARCH}/"
echo "==> bin 下全部包（排查用）："
find bin -type f \( -name '*.apk' -o -name '*.ipk' \) 2>/dev/null | sort | head -50

# 产物完整性闸门：缺任一必需包就让构建失败，避免再次发布不可安装的 Release
for p in luci-app-mt5700; do
	if [ -z "$(find "/out/${ARCH}" -type f -name "${p}*" -print -quit)" ]; then
		echo "ERROR: /out/${ARCH} 缺少 ${p} 包产物（arch=${ARCH}）"
		exit 1
	fi
done

# 单包必须内含后端二进制。OpenWrt 24.10+ 的 .apk 不是标准 tar.gz
# （file 显示 data，tar 列不出内容），改用「安装目录 + apk 段解析」双保险。
PKG_FILE=$(find "/out/${ARCH}" -type f -name 'luci-app-mt5700*' -not -name 'luci-i18n*' -print -quit)
[ -n "$PKG_FILE" ] || { echo "ERROR: 未找到 luci-app-mt5700 主包"; exit 1; }
echo "==> 校验主包: $(basename "$PKG_FILE") ($(wc -c < "$PKG_FILE") bytes)"

# 1) 打包前安装树（最可靠）
STAGE_BIN=$(find build_dir -type f -path '*/luci-app-mt5700/ipkg-*/luci-app-mt5700/usr/bin/at-webserver-rust' -print -quit 2>/dev/null)
if [ -n "$STAGE_BIN" ] && [ -x "$STAGE_BIN" ]; then
	echo "==> 安装树已含后端: $STAGE_BIN ($(wc -c < "$STAGE_BIN") bytes)"
else
	echo "WARN: 安装树未找到 at-webserver-rust，尝试解析包文件"
fi

# 2) 解析 OpenWrt apk（APKv2: 连续 (u32be length + payload) 段，payload 可能是 gzip tar）
list_apk_members() {
	python3 - "$1" <<'PY' 2>/dev/null
import struct, sys, gzip, io, tarfile
path = sys.argv[1]
data = open(path, "rb").read()
pos = 0
names = []
def add_from(buf):
    if not buf:
        return
    for mode in ("r:gz", "r:", "r:bz2"):
        try:
            tar = tarfile.open(fileobj=io.BytesIO(buf), mode=mode)
            for m in tar.getmembers():
                names.append(m.name)
            return
        except Exception:
            pass
    if buf[:2] == b"\x1f\x8b":
        try:
            add_from(gzip.decompress(buf))
        except Exception:
            pass
# APKv2 segments
while pos + 4 <= len(data):
    ln = struct.unpack(">I", data[pos:pos+4])[0]
    if ln == 0 or ln > len(data) - pos - 4:
        break
    add_from(data[pos+4:pos+4+ln])
    pos += 4 + ln
if not names:
    # 退化：扫描 gzip magic
    i = 0
    while True:
        i = data.find(b"\x1f\x8b", i)
        if i < 0:
            break
        add_from(data[i:])
        i += 1
for n in sorted(set(names)):
    print(n)
PY
}

PKG_LIST=""
case "$PKG_FILE" in
	*.apk)
		PKG_LIST=$(list_apk_members "$PKG_FILE")
		;;
	*.ipk)
		PKG_LIST=$( {
			tar -xzOf "$PKG_FILE" ./data.tar.gz 2>/dev/null | tar -tzf - 2>/dev/null
			tar -xzOf "$PKG_FILE" data.tar.gz 2>/dev/null | tar -tzf - 2>/dev/null
			tar -tzf "$PKG_FILE" 2>/dev/null
		} | sort -u )
		;;
esac
echo "==> 包内文件（前 30，共 $(echo "$PKG_LIST" | grep -c . || echo 0)）："
echo "$PKG_LIST" | head -30

if echo "$PKG_LIST" | grep -qE '(^|/)usr/bin/at-webserver-rust$'; then
	echo "==> 已确认包内含 usr/bin/at-webserver-rust"
elif [ -n "$STAGE_BIN" ] && [ -x "$STAGE_BIN" ]; then
	# 安装树有二进制且包体合理（后端 release 约 1–2MB），视为通过
	SZ=$(wc -c < "$PKG_FILE")
	if [ "$SZ" -gt 500000 ]; then
		echo "==> 包体 ${SZ}B 且安装树含后端，判定为单包（apk 段解析未列出文件）"
	else
		echo "ERROR: 包体过小 (${SZ}B) 且未能列出 at-webserver-rust"
		exit 1
	fi
else
	echo "ERROR: 无法确认 $(basename "$PKG_FILE") 内含 usr/bin/at-webserver-rust"
	file "$PKG_FILE" 2>/dev/null || true
	exit 1
fi
echo "==> SDK 构建完成"
