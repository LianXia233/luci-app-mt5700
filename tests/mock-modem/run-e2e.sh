#!/bin/sh
# run-e2e.sh — 本地/CI 端到端链路验证（无硬件环境）
#
# 链路：RPC 客户端(等价 rpcd ucode 插件) → Rust 后端(127.0.0.1:8765) → mock 模组(TCP 20249)
#
# 前置：node 与 cargo 在 PATH 中；mock-modem 目录已 npm ci/install（ws 包）。
#       Rust 后端缺失时会自动按 rust-toolchain.toml 编译 release（--locked）。
#
# 用法：sh run-e2e.sh

set -e
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "ERROR: 未找到 node"; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "ERROR: 未找到 cargo"; exit 1; }

LOG_DIR="${TMPDIR:-/tmp}"
MOCK_LOG="$LOG_DIR/mt5700-mock-modem.log"
RUST_LOG="$LOG_DIR/mt5700-mt5700d.log"

RUST_BIN="../../src/rust/target/release/mt5700d"
if [ ! -x "$RUST_BIN" ]; then
	echo "==> 未找到 release 后端，先编译（src/rust）"
	(cd ../../src/rust && cargo build --release --locked)
fi
[ -x "$RUST_BIN" ] || { echo "ERROR: 编译后仍找不到 $RUST_BIN"; exit 1; }

# 假 uci 注入 PATH，让后端读到 127.0.0.1:20249 的测试配置
MOCK_DIR="$(pwd)"
chmod +x mock-modem.js e2e-test.js mock-uci
# 后端执行的是 "uci"，提供同名可执行入口
ln -sf mock-uci "$MOCK_DIR/uci"
export PATH="$MOCK_DIR:$PATH"

# fuser 不是所有环境都有；没有时退化为 pkill（失败也不阻断）。
kill_port() {
	if command -v fuser >/dev/null 2>&1; then
		fuser -k "$1/tcp" 2>/dev/null || true
	elif command -v pkill >/dev/null 2>&1; then
		pkill -f "127.0.0.1:$1" 2>/dev/null || true
	fi
}

wait_port() {
	port="$1"
	i=0
	while [ "$i" -lt 60 ]; do
		if node -e '
			const net = require("net");
			const s = net.connect(Number(process.argv[1]), "127.0.0.1");
			s.on("connect", () => { s.end(); process.exit(0); });
			s.on("error", () => process.exit(1));
			setTimeout(() => process.exit(1), 300);
		' "$port" >/dev/null 2>&1; then
			return 0
		fi
		i=$((i + 1))
		sleep 0.2
	done
	return 1
}

RUST_PID=""
MOCK_PID=""
cleanup() {
	[ -n "$RUST_PID" ] && kill "$RUST_PID" 2>/dev/null || true
	[ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> 1/4 清理残留并启动 mock 模组 (TCP 20249)"
kill_port 20249
kill_port 8765
sleep 0.3
node mock-modem.js 20249 > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
wait_port 20249 || { echo "ERROR: mock 模组未在 20249 监听"; tail -20 "$MOCK_LOG" 2>/dev/null; exit 1; }

echo "==> 2/4 启动 Rust 后端 (RPC 127.0.0.1:8765)"
"$RUST_BIN" > "$RUST_LOG" 2>&1 &
RUST_PID=$!
wait_port 8765 || { echo "ERROR: Rust 后端未在 8765 监听"; tail -20 "$RUST_LOG" 2>/dev/null; exit 1; }

echo "==> 3/4 运行 RPC 端到端测试"
E2E_RC=0
node e2e-test.js 8765 test-key-123 || E2E_RC=$?

echo "==> 4/4 清理"
cleanup
trap - EXIT INT TERM
sleep 0.3
echo "--- mock 模组日志 ---"
tail -8 "$MOCK_LOG" 2>/dev/null || true
echo "--- Rust 后端日志 ---"
tail -8 "$RUST_LOG" 2>/dev/null || true

exit "$E2E_RC"
