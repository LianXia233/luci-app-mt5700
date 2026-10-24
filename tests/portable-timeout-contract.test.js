#!/usr/bin/env node
'use strict';

/**
 * 「限时器可移植」契约守卫（2026-10-24）
 * ============================================================================
 * 事件：真机 Mwrt @Manper r33382（busybox 1.36.1）**既没有 timeout applet，
 * 也没有 coreutils-timeout 包**。而本插件有 8 处 shell 调用写成
 * `timeout <秒> <命令>`（ucode 6 处 + diag-probe.sh 2 处）。缺这个程序时命令
 * 根本不会执行，popen 读到空 —— **所有** AT 命令瞬间失败并报
 * 「Rust 后端无应答（已限时 45 秒）」（实测 20/20，每次 0ms 返回）。
 *
 * 界面上的表现：SIM「未知」、状态页全空、断网诊断 / 出口 IP / DoH / VoWiFi
 * epdg / OTA 全哑。而 Rust 后端与串口其实完全正常（绕过限时器直连 nc 可拿到
 * `+CPIN: READY`）—— 这是个极易误判成「模组坏了」的故障。
 *
 * 本守卫钉三件事：
 *   ① ucode 侧**所有**限时调用都经由 timeoutBin()，不许再出现裸 `'timeout ` 前缀；
 *      且 timeoutBin() 必须定义在 rpcCall 之前（ucode 没有函数提升，红线 14b）。
 *   ② 随包替代脚本 /usr/share/mt5700/to 存在、以 #!/bin/sh 开头，并真能：
 *      正常结束透传退出码、超时真的杀掉、超时后不留标记文件。
 *   ③ diag-probe.sh 内部同样走 to()，Makefile 负责装可执行位。
 *
 * ★ 为什么带行为测试：静态正则只能证明「代码长这样」，证明不了「到时真能杀掉」。
 *   红线 16：写了守卫不等于有了守卫，先让它对一次真实行为负责。
 *
 * 用法：node tests/portable-timeout-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UCODE = path.join(ROOT, 'root/usr/share/rpcd/ucode/mt5700.uc');
const SHIM = path.join(ROOT, 'root/usr/share/mt5700/to');
const DIAG = path.join(ROOT, 'root/usr/share/mt5700/diag-probe.sh');
const MAKEFILE = path.join(ROOT, 'Makefile');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) {
		pass++;
		console.log('  ok   ' + name);
	} else {
		fails.push(detail ? name + ' :: ' + detail : name);
		console.log('  ✗ ' + name + (detail ? '\n       ' + detail : ''));
	}
}

function read(p) {
	return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** 剥掉块注释与整行 // 注释：注释里解释历史写法不该被当成活代码。 */
function stripComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !/^\s*\/\//.test(l))
		.join('\n');
}

/** 剥掉 shell 的整行 # 注释。 */
function stripHashComments(text) {
	return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/* ---------------------------------------------------------------------------
 * 1. ucode：所有限时走 timeoutBin()，且定义位置正确
 * ------------------------------------------------------------------------- */
console.log('== 1. ucode 限时入口唯一 ==');

const uc = read(UCODE);
ok('mt5700.uc 可读（否则下面全是空转）', uc.length > 0, '读不到 ' + UCODE);
const ucCode = stripComments(uc);

ok('存在 timeoutBin() 探测函数', /function timeoutBin\(\) \{/.test(ucCode));
ok('timeoutBin 默认回退到随包脚本 /usr/share/mt5700/to',
	ucCode.indexOf("'/usr/share/mt5700/to'") >= 0,
	'没有回退路径，缺 timeout 的固件上会继续全哑');
ok('timeoutBin 通过 command -v 探测系统 timeout',
	/command -v timeout/.test(ucCode));

const defAt = ucCode.indexOf('function timeoutBin()');
const callAt = ucCode.indexOf('function rpcCall(');
ok('timeoutBin 定义在 rpcCall 之前（ucode 无函数提升）',
	defAt >= 0 && callAt >= 0 && defAt < callAt,
	'timeoutBin 在 rpcCall 之后定义 —— ucode 不做函数提升，运行期会报未定义');

/* 裸前缀必须彻底消失：一句 `'timeout ` 就会让某条链路在定制固件上静默全哑 */
const barePrefix = ucCode.match(/'timeout /g) || [];
ok('ucode 里不再有裸 `\'timeout ` 前缀', barePrefix.length === 0,
	'仍有 ' + barePrefix.length + ' 处硬编码 timeout 前缀');

/* 6 个已知调用点必须都在（少一处就是一条链路没接上） */
const uses = (ucCode.match(/timeoutBin\(\)/g) || []).length;
ok('6 处限时调用都改为 timeoutBin()（含定义自身的 0 次）', uses >= 6,
	'实际只出现 ' + uses + ' 次 —— 有调用点没接上');

/* 反向：把一处改回旧写法，上面的「裸前缀」检查必须判红 */
const regressed = ucCode.split("timeoutBin() + ' 45 nc ").join("'timeout 45 nc ");
ok('反向：退回裸 \'timeout 前缀后必须判红',
	(regressed.match(/'timeout /g) || []).length > 0,
	'回退后仍判为通过，守卫无效');

/* ---------------------------------------------------------------------------
 * 2. 随包替代脚本：存在性 + 行为
 * ------------------------------------------------------------------------- */
console.log('== 2. /usr/share/mt5700/to 的行为 ==');

const shim = read(SHIM);
ok('替代脚本存在', shim.length > 0, '读不到 ' + SHIM);
ok('以 #!/bin/sh 开头', /^#!\/bin\/sh\r?\n/.test(shim));
const shimCode = stripHashComments(shim);
ok('后台执行被限时命令', /^"\$@"[^\n]*&[^\n]*$/m.test(shimCode));
ok('用 wait 收退出码', /wait "\$pid"/.test(shimCode));
ok('到期 kill -9', /kill -9/.test(shimCode));
ok('退出码透传命令自身状态', /exit "\$st"/.test(shimCode));
ok('用标记文件防 pid 复用误杀', /mark=/.test(shimCode) && /\[ -e "\$mark" \]/.test(shimCode),
	'直接 kill 等待者会让孤儿 sleep 睡满后再 kill，可能命中被复用的 pid');
/*
 * ★★ 2026-10-24 真机踩过：ash 在关闭作业控制时会把**异步列表**的 stdin
 *   强制接 /dev/null。少了这把「先把 stdin 存到 fd 3」，`to 45 nc ... < 请求.json`
 *   里的 nc 读不到请求体，什么都不回，上层报「Rust 后端无应答」——
 *   整个 AT 链路照旧全哑，而脚本看起来「明明跑得好好的」。
 */
ok('先把调用方 stdin 存到 fd 3（后台任务默认丢 stdin 的修复）',
	/exec 3<&0/.test(shimCode) && /"\$@" <&3 &/.test(shimCode),
	'后台任务会拿到 /dev/null 当 stdin，nc 读不到请求体');

/* 真跑：本机 sh 可用性先自检，避免「跑不了也算过」（红线 16：空守卫） */
const shProbe = spawnSync('sh', ['-c', 'exit 0']);
ok('本机有可用的 sh（否则下面的行为测试是空转）', !shProbe.error,
	shProbe.error ? String(shProbe.error.message) : '');

if (!shProbe.error && shim.length > 0) {
	/*
	 * ★ 计时判据只用「与命令自身时长对比」，不写绝对毫秒（红线 78）。
	 *   Windows/MSYS 上每 fork 一次要几秒（实测连 `echo hi` 都要 4.8s），
	 *   任何「1 秒限时必须在 6 秒内返回」这类绝对阈值都会在本地误报；
	 *   而在 Linux/真机上同样这几条断言依然能抓住「根本没杀」的情况：
	 *   杀不掉就得等满 we 给的 20 秒，必然超过 15 秒。
	 */
	const WAIT_LIMIT = 15000;

	/* ① 正常结束：输出要透传，退出码 0，且不能白等满限时 */
	const t0 = Date.now();
	const fast = spawnSync('sh', [SHIM, '20', 'echo', 'hi'], { encoding: 'utf8' });
	const fastMs = Date.now() - t0;
	ok('正常结束：stdout 透传', (fast.stdout || '').indexOf('hi') >= 0, fast.stdout);
	ok('正常结束：退出码 0', fast.status === 0, 'status=' + fast.status);
	ok('正常结束：不会等满 20s 限时', fastMs < WAIT_LIMIT, '实际 ' + fastMs + 'ms');

	/* ①b stdin 必须透传 —— 本插件最重要的一条用法就是 `to 45 nc ... < 请求.json` */
	const piped = spawnSync('sh', [SHIM, '10', 'cat'], { input: 'REQ-BODY\n', encoding: 'utf8' });
	ok('stdin 透传给被调命令（后台丢掉 stdin 的回归守卫）',
		(piped.stdout || '').indexOf('REQ-BODY') >= 0, 'stdout=' + JSON.stringify(piped.stdout));

	/* ② 超时：1 秒限时跑 20 秒命令，必须被杀掉（杀不掉会等满 20s） */
	const t1 = Date.now();
	const slow = spawnSync('sh', [SHIM, '1', 'sleep', '20'], { timeout: 30000 });
	const slowMs = Date.now() - t1;
	ok('超时：非零退出', slow.status !== 0, 'status=' + slow.status);
	ok('超时：没有等满 20s（说明 kill 真的生效）', slowMs < WAIT_LIMIT, '实际 ' + slowMs + 'ms');

	/* ③ 超时路径也要清掉标记文件（否则 /tmp 会慢慢攒垃圾） */
	const leftovers = spawnSync('sh', ['-c',
		'ls -1 /tmp/.mt5700-to.* 2>/dev/null | wc -l'], { encoding: 'utf8' });
	const n = parseInt((leftovers.stdout || '0').trim(), 10);
	ok('没有遗留标记文件', n === 0, '遗留 ' + n + ' 个 /tmp/.mt5700-to.*');
}

/* ---------------------------------------------------------------------------
 * 3. diag-probe.sh 与打包
 * ------------------------------------------------------------------------- */
console.log('== 3. 诊断脚本与打包 ==');

const diag = read(DIAG);
ok('diag-probe.sh 可读', diag.length > 0, '读不到 ' + DIAG);
const diagCode = stripHashComments(diag);
ok('diag-probe.sh 定义了 to() 兜底', /^to\(\) \{/m.test(diagCode) || /\nto\(\) \{/.test(diagCode));
ok('diag-probe.sh 不再裸调 timeout', !/\n\s*timeout "\$NS_TIMEOUT"/.test(diagCode),
	'仍然直接调 timeout，缺 applet 时 dns_resolve_ok 会恒为 0');
ok('diag-probe.sh 的 DNS 探测改走 to()',
	(diagCode.match(/to "\$NS_TIMEOUT"/g) || []).length === 2,
	'两处（nslookup / drill）都该走 to()');

const mk = read(MAKEFILE);
ok('Makefile 为替代脚本装可执行位',
	/chmod 0755 \$\(PKG_BUILD_DIR\)\/root\/usr\/share\/mt5700\/to/.test(mk),
	'缺 chmod 行，opkg 装完脚本不可执行（红线 47 同类静默点）');

console.log('');
if (fails.length === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fails.length + ' 项失败 / 共 ' + (pass + fails.length) + ' 项');
fails.forEach((f) => console.log('  ✗ ' + f));
process.exit(1);
