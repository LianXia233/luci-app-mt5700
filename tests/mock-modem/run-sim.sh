#!/bin/sh
# run-sim.sh — 本地模拟验证（无硬件、无外网）：短信推送 / 来电推送 / 短信中心多会话显示
#
# 与 run-e2e.sh 的分工：
#   run-e2e.sh          验「LuCI RPC ↔ AT 命令」链路（命令应答、伪命令、事件）
#   run-sim.sh（本脚本）验「推送与前端展示」——即用户能看到的那部分行为
#
# 前置：cd ../../src/rust && cargo build --release
# 用法：sh run-sim.sh

set -e
cd "$(dirname "$0")"

NODE="${NODE:-node}"

echo "=========================================="
echo " 1/2 短信中心渲染：一条短信 / 多个会话    "
echo "=========================================="
"$NODE" sms-center-render.js || exit 1

echo
echo "=========================================="
echo " 2/2 推送链路：短信 / 来电 / 时区口径      "
echo "=========================================="
"$NODE" simulate-push.js || exit 1

# 可选：渲染截图（需要 python + playwright，缺任一则跳过）
echo
echo "=========================================="
echo " 附加（可选）短信中心显示效果截图          "
echo "=========================================="
if command -v python >/dev/null 2>&1; then
	python render-shot.py || echo "  已跳过（需要 pip install playwright && playwright install chromium）"
else
	echo "  已跳过（未找到 python）"
fi
