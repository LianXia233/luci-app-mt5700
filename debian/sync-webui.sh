#!/bin/bash
# 把 main 前端整体同步到 Debian 独立 WebUI（只覆盖资源与视图）。
#
# 独立外壳 webui/luci.js、webui/app.js、webui/shell.css、webui/index.html
# 是本分支自有文件，不在同步范围内；同步后请跑 tests/debian-webui-test.js。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_RES="$ROOT/htdocs/luci-static/resources"
DST_RES="$ROOT/webui/luci-static/resources"
[ -d "$SRC_RES/at-webserver" ] || { echo "错误：找不到 main 前端 $SRC_RES/at-webserver" >&2; exit 1; }
rm -rf "$DST_RES/at-webserver" "$DST_RES/view/at-webserver"
mkdir -p "$DST_RES/view"
cp -a "$SRC_RES/at-webserver" "$DST_RES/at-webserver"
cp -a "$SRC_RES/view/at-webserver" "$DST_RES/view/at-webserver"
echo "已同步 main 前端到 webui/（外壳文件保持不变）"
