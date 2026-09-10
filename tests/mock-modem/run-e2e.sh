#!/bin/sh
# run-e2e.sh — 本地端到端链路验证（无硬件环境）
#
# 链路：WS 客户端(等价 LuCI ws.js) → Rust 后端(8765) → mock 模组(TCP 20249)
#
# 前置：Rust 后端已 release 编译（src/rust/target/release/at-webserver）
#       mock-modem 目录已 npm install（ws 包）
#
# 用法：sh run-e2e.sh

set -e
cd "$(dirname "$0")"

export PATH=/opt/nodejs/22/bin:$PATH
export RUSTUP_HOME=/home/user/.rust
export CARGO_HOME=/home/user/.cargo
export PATH="$PATH:/home/user/.cargo/bin"

RUST_BIN="../../src/rust/target/release/at-webserver"
[ -x "$RUST_BIN" ] || { echo "未找到 $RUST_BIN，请先编译：cd src/rust && cargo build --release"; exit 1; }

# 假 uci 注入 PATH，让后端读到 127.0.0.1:20249 的测试配置
MOCK_DIR="$(pwd)"
chmod +x mock-modem.js e2e-test.js mock-uci
# 后端执行的是 "uci"，提供同名可执行入口
ln -sf mock-uci "$MOCK_DIR/uci"
export PATH="$MOCK_DIR:$PATH"

echo "==> 1/4 清理残留并启动 mock 模组 (TCP 20249)"
fuser -k 20249/tcp 2>/dev/null || true
fuser -k 8765/tcp 2>/dev/null || true
sleep 0.3
node mock-modem.js 20249 > /tmp/mock-modem.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID $RUST_PID 2>/dev/null || true' EXIT
sleep 0.5

echo "==> 2/4 启动 Rust 后端 (WS 8765)"
"$RUST_BIN" > /tmp/at-webserver-rust.log 2>&1 &
RUST_PID=$!
sleep 1.5

echo "==> 3/4 运行 WS 端到端测试"
node e2e-test.js ws://127.0.0.1:8765 test-key-123
E2E_RC=$?

echo "==> 4/4 清理"
kill $RUST_PID $MOCK_PID 2>/dev/null || true
sleep 0.3
echo "--- mock 模组日志 ---"
tail -8 /tmp/mock-modem.log
echo "--- Rust 后端日志 ---"
tail -8 /tmp/at-webserver-rust.log

exit $E2E_RC
