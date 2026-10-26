#!/bin/sh
# 本地按 CI 的顺序复刻 contract-check，并**诚实报告哪一步没能真跑**
# ---------------------------------------------------------------------------
# 为什么需要它（2026-09-30 的真实事故，CI 原文）：
#
#   FAIL      6 at-thermal-status-spelling-contract.test.js
#         ✗ 1. 扫到了生产代码文件（否则本测试等于没跑） —— 只扫到 38 个
#   1 个测试文件失败
#   ##[error]Process completed with exit code 1.
#
# 新增的测试把"没哑火"自检写成了 `files.length > 50`：本地工作树扫到 >50 → 绿，
# CI 的 actions/checkout 只扫到 38 → 假红，整步 `node tests/run-all.js` exit 1，
# **后面四条扫描器步骤全被跳过**。
#
# 根因不只是那个阈值，而是**本地与 CI 跑的步骤集不同**：本地习惯只用
# tools/run-tests-inproc.js（沙箱禁止 spawn 抓管道），而 CI 跑的是 tests/run-all.js，
# 后者还会追加一条 `tests/syntax-check.js`（语法冒烟）—— 这一步本地从来没跑过。
#
# 本脚本把 CI 的步骤集固化成一条命令。两条硬要求：
#   1) 某一步"没真跑"（缺工具链 / 环境限制）时必须报 NORUN 并以退出码 2 结束，
#      不允许给一个可能有歧义的绿 —— 与 tests/run-all.js 的 0/1/2 约定一致：
#        0 = 全部步骤真跑且通过
#        1 = 有步骤真跑且失败
#        2 = 有步骤未能真跑，本次结果不可信
#   2) 每一步用 `# CI-STEP: <CI 里的原命令>` 标记，供
#      tests/ci-parity-contract.test.js 双向核对（CI 加了步骤而这里没跟，或反之，都判红）。
#
# 用法：
#   sh tools/ci-local.sh              # contract-check 的全部步骤
#   sh tools/ci-local.sh --with-cargo # 额外跑 rust-check（需要本机有 cargo）
#
# 与 CI 的对应关系（原命令见 .github/workflows/build-openwrt.yml 的 contract-check job）：
#   契约测试 / 守卫变异 / ucode 顺序 / 行尾 / AT 读写分类 / 孤儿自证 —— 共 6 条。
#   每一步在下面用 `# CI-STEP:` 标记一次（**单一真源**：标记只出现在对应执行块的上一行，
#   本文件头部不复写，避免 CI 改动时要同步两处）；tests/ci-parity-contract.test.js
#   拿这些标记与 workflow 双向核对。

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

FAIL=0
NORUN=0
WITH_CARGO=0
[ "${1:-}" = "--with-cargo" ] && WITH_CARGO=1

step() {
	printf '\n=== %s ===\n' "$1"
}
norun() {
	echo "NORUN $1"
	NORUN=$((NORUN + 1))
}

# python 解释器：CI 用 python3，本机可能是 python / python3 / py
PY=""
for cand in python3 python py; do
	if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done

# node：优先 NODE_BIN（本仓 tools/audit-at-reads.py 也用这个变量），否则 PATH
NODE=""
if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN:-}" ]; then
	NODE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
	NODE="$(command -v node)"
fi
# 把 node 暴露给需要它的工具：CI 里 actions/setup-node 就是这么做的（node 在 PATH），
# tools/audit-at-reads.py 与 tools/verify-guards.py 都要用 node 载入 rpc.js 问真实答案；
# tools/audit-at-reads.py 另有 NODE_BIN 变量约定，一并导出 —— 否则本地会假失败。
if [ -n "$NODE" ]; then
	case ":$PATH:" in
		*":$(dirname "$NODE"):"*) ;;
		*) PATH="$(dirname "$NODE"):$PATH" ;;
	esac
	export PATH
	export NODE_BIN="$NODE"
fi

# ── 1. 契约测试 ────────────────────────────────────────────────────────────
# CI-STEP: node tests/run-all.js
step "契约测试（CI: node tests/run-all.js）"
if [ -z "$NODE" ]; then
	norun "找不到 node（可用 NODE_BIN 指定可执行文件）"
elif "$NODE" -e 'require("child_process").spawnSync(process.execPath,["-e","0"])' >/dev/null 2>&1; then
	"$NODE" tests/run-all.js || FAIL=$((FAIL + 1))
else
	# 受限环境（如沙箱）不能 spawn 抓管道：run-all.js 会把每个文件都算成"没跑"。
	# 仓里为这种情况写了同进程 runner —— 它覆盖同一批文件，但**不含 syntax-check**，
	# 所以下面单独补一条，并把差异明确打印出来，不静默降级。
	echo "NOTE 本环境无法 spawn 子进程 → 改用 tools/run-tests-inproc.js（同收集规则，不含 syntax-check）"
	"$NODE" tools/run-tests-inproc.js || FAIL=$((FAIL + 1))
fi

# CI 的 run-all.js 会在末尾追加 tests/syntax-check.js（它不是 *-test.js，抓白屏级语法错误）。
# 这一步正是 2026-09-30 事故里本地从未跑过的那条，单独固化下来。
step "语法冒烟（CI 由 run-all.js 追加：tests/syntax-check.js）"
if [ -z "$NODE" ]; then
	norun "找不到 node，语法冒烟未跑"
else
	"$NODE" tests/syntax-check.js || FAIL=$((FAIL + 1))
fi

# ── 2~6. 常驻扫描器 ────────────────────────────────────────────────────────
run_py() { # run_py <说明> <脚本> [脚本参数...]   ← 说明必须放第一位，不能混进脚本参数
	_desc="$1"
	shift
	if [ -z "$PY" ]; then
		norun "找不到 python，$_desc 未跑"
		return
	fi
	"$PY" "$@" || FAIL=$((FAIL + 1))
}

step "变异锚点自检（CI: python3 tools/verify-guards.py --anchors）"
# CI-STEP: python3 tools/verify-guards.py --anchors
# 只查锚点、不跑测试，1 秒出结果：删改 UI 后「断言改了、锚点没改」是这类检查
# 最常失效的方式，跑完整验证要十几分钟，没人会每次都跑。
if ! "$PY" tools/verify-guards.py --anchors; then
    FAILED=$((FAILED + 1))
fi

step "守卫有效性验证（CI: python3 tools/verify-guards.py）"
# CI-STEP: python3 tools/verify-guards.py
# ★ 该工具靠 node 跑 JS 测试来判定"变异有没有被断言检出"：没有 node 时它必然 exit 1，
#   那是**未能真跑**而不是"守卫失效" —— 两者必须区分，否则本地会误报仓库坏了。
if [ -z "$NODE" ]; then
	norun "守卫变异验证：缺 node（verify-guards.py 要跑 JS 测试），本步未真跑"
else
	run_py "守卫变异验证" tools/verify-guards.py
fi

step "ucode 函数顺序（CI: python3 tools/check-ucode-order.py）"
# CI-STEP: python3 tools/check-ucode-order.py
run_py "ucode 顺序检查" tools/check-ucode-order.py

step "行尾必须 LF（CI: python3 tools/check-line-endings.py）"
# CI-STEP: python3 tools/check-line-endings.py
run_py "行尾检查" tools/check-line-endings.py

step "AT 读写分类对照手册（CI: python3 tools/audit-at-reads.py）"
# CI-STEP: python3 tools/audit-at-reads.py
# ★ 同理：该脚本要载入 htdocs/.../rpc.js 问 isRetryableRead() 的真实答案，需要 node。
if [ -z "$NODE" ]; then
	norun "AT 读写分类对照：缺 node（要载入 rpc.js 问真实答案），本步未真跑"
else
	run_py "AT 读写分类对照" tools/audit-at-reads.py
fi

step "孤儿与残留扫描器自证（CI: python3 tools/find-orphans.py --self-test-only）"
# CI-STEP: python3 tools/find-orphans.py --self-test-only
run_py "孤儿扫描器自证" tools/find-orphans.py --self-test-only

# ── 可选：rust-check ───────────────────────────────────────────────────────
if [ "$WITH_CARGO" = "1" ]; then
	step "rust-check（CI: cd src/rust && cargo check --all-targets）"
	if command -v cargo >/dev/null 2>&1; then
		( cd src/rust && cargo check --all-targets ) || FAIL=$((FAIL + 1))
	else
		norun "找不到 cargo，rust-check 未跑（--with-cargo 需要本机 Rust 工具链）"
	fi
fi

echo
if [ "$FAIL" -gt 0 ]; then
	echo "结论：$FAIL 个步骤真跑且失败"
	exit 1
fi
if [ "$NORUN" -gt 0 ]; then
	echo "结论：$NORUN 个步骤未能真跑 —— 本次结果不可信（不是"通过"）"
	exit 2
fi
echo "结论：全部步骤真跑且通过"
exit 0
