#!/bin/bash
# 在云服务器上模拟 CI 步骤 5/6/7 的真实逻辑，验证工作流脚本可跑通。
# 目的：在推送 GitHub 之前发现脚本级错误（架构判定、打包调用、闸门）。
set -euo pipefail

cd /root/mt5700-build/mt5700-build
TARGET="$1"          # x86_64-unknown-linux-gnu | aarch64-unknown-linux-gnu
DEB_ARCH_EXPECT="$2" # amd64 | arm64

echo "########## 模拟：构建执行 ##########"
cd src/rust
if [ "$TARGET" = "aarch64-unknown-linux-gnu" ]; then
  export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="aarch64-linux-gnu-gcc"
  export CC_aarch64_unknown_linux_gnu="aarch64-linux-gnu-gcc"
  export AR_aarch64_unknown_linux_gnu="aarch64-linux-gnu-ar"
  echo "==> 交叉编译目标：$TARGET"
else
  echo "==> 原生编译目标：$TARGET"
fi
cargo build --release --target "$TARGET" 2>&1 | tail -3
cd ../..

echo
echo "########## 模拟：产物校验（架构一致性与二进制闸门）##########"
BIN="src/rust/target/$TARGET/release/at-webserver"
[ -f "$BIN" ] || { echo "错误：未找到编译产物 $BIN" >&2; exit 1; }
echo "==> 产物信息"
ls -lh "$BIN"
file "$BIN" | sed 's/, BuildID.*//'
echo "==> 动态依赖"
objdump -p "$BIN" | awk '/NEEDED/ {print "    " $2}'

echo
echo "########## 模拟：打包执行 ##########"
bash debian/build-deb.sh --bin "$BIN" --out-dir dist --revision 1

echo
echo "########## 模拟：deb 元数据闸门 ##########"
DEB=$(ls -1 dist/at-webserver_*.deb | head -1)
[ -f "$DEB" ] || { echo "错误：未生成 deb 产物" >&2; exit 1; }
dpkg-deb --info "$DEB" | sed -n '1,12p'

echo "==> 架构一致性闸门"
ARCH=$(dpkg-deb --field "$DEB" Architecture)
if [ "$ARCH" != "$DEB_ARCH_EXPECT" ]; then
  echo "错误：control 架构为 $ARCH，期望 $DEB_ARCH_EXPECT" >&2
  exit 1
fi
echo "✓ 架构一致：$ARCH"

echo "==> 内容完整性（关键路径必须存在）"
LIST=$(dpkg-deb --fsys-tarfile "$DEB" | tar -t)
for p in ./usr/bin/at-webserver \
         ./etc/mt5700/config.json \
         ./etc/mt5700/on-uplink.sh \
         ./lib/systemd/system/at-webserver.service \
         ./usr/share/doc/at-webserver/README.Debian; do
  echo "$LIST" | grep -qx "$p" || { echo "错误：包内缺少 $p" >&2; exit 1; }
  echo "✓ $p"
done
echo "✓ WebUI 资源文件数：$(echo "$LIST" | grep -c 'usr/share/mt5700/webui')"
echo
echo "########## 全部闸门通过：$DEB ##########"
ls -lh "$DEB"