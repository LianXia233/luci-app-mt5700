/*
 * 静态断言：前端命令总预算（P04）、APDU 分档（2026-09-20）与悬空定时器（P11）
 * ----------------------------------------------------------------------------
 * P04：单条命令原本最坏 3 次重试 × 14s ≈ 42.6s，而后端最坏 13s ——
 *      其中约 29s 是后端早就放弃之后的纯空等，还会独占全局串行队列。
 * APDU：AT+CSIM / AT+CGLA 这类透传命令的耗时由**卡片**决定（eSIM 写卡时卡侧
 *       做密钥运算与非易失写入，单条跳到秒级是常态），后端对它们的应答预算是
 *       APDU_TIMEOUT（默认 12s）。前端沿用普通命令的 14s/20s 会在后端还在等卡
 *       的时候先放弃 —— 真机表现就是「下载到一半：模组无响应（已等待 2000ms）」。
 * P11：withTimeout 竞速胜出后必须清掉另一路的定时器（等价改写，不声称性能提升）。
 *
 * 每条都有反向验证：旧文本喂给同一检查函数必须判红。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const UCODE = path.join(__dirname, '..', 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) { pass++; }
	else { fails.push(detail ? name + ' :: ' + detail : name); }
}

const src = fs.readFileSync(SRC, 'utf8');

/* ---------------- P04：总预算 ---------------- */
ok('P04 sendCommand 声明了默认 20000ms 的总预算（APDU 类另有更宽的预算）',
	/var budget = opt\.budgetMs != null \? opt\.budgetMs : \(apdu \? APDU_BUDGET_MS : 20000\);/.test(src),
	'没有总预算，单条命令仍会占满 42 秒');
ok('P04 重试前判断预算是否已用尽（且第一次必发）',
	/if \(attempt > 1 && \(Date\.now\(\) - t0\) >= budget\)/.test(src),
	'缺少预算判断；注意第一次必须照发，否则 budget 很小时命令永远发不出去');
ok('P04 单次超时取 min(等待上限, 剩余预算)',
	/var waitMs = Math\.max\(1000,[\s\S]{0,80}Math\.min\(waitCap, budget - \(Date\.now\(\) - t0\)\)\)/.test(src),
	'单次超时没有按剩余预算收敛');
/* 反向：改动前的旧片段必须被判红 */
const oldSend = "		var attemptOnce = function () {\n"
	+ "			attempt++;\n"
	+ "			if (!self.connected) return { success: false, error: '未连接到调制解调器' };\n"
	+ "			return withTimeout(rpcAt(command), self.commandTimeout,\n";
ok('P04 反向：旧的「无预算」写法被同一检查判为不通过',
	!/var budget = opt\.budgetMs/.test(oldSend) && !/attempt > 1 && \(Date\.now\(\) - t0\)/.test(oldSend),
	'旧片段竟被判为通过，检查函数无效');

/* ---------------- APDU 分档（2026-09-20） ---------------- */
function hasApduTier(s) {
	return /var APDU_WAIT_MS = 30000;/.test(s)
		&& /var APDU_BUDGET_MS = 45000;/.test(s)
		&& /var apdu = isApduCommand\(command\);/.test(s)
		&& /var waitCap = apdu \? APDU_WAIT_MS : self\.commandTimeout;/.test(s);
}
ok('APDU 分档：声明了独立的等待上限与总预算，并在 sendCommand 里分档取用',
	hasApduTier(src),
	'APDU 透传命令仍和普通命令共用同一套预算，写卡时前端会比后端先放弃');
/*
 * 反向断言：必须全局替换（split/join）。
 * String.replace 只换第一处 —— 只改一处的话另一处仍是新写法，断言会恒绿。
 */
const regressed = src.split('APDU_BUDGET_MS').join('20000');
ok('APDU 反向：把 APDU 预算退回 20000 后，同一检查必须判红',
	!hasApduTier(regressed),
	'回退后仍判为通过，说明分档检查形同虚设');

/* 行为断言：判定函数本身对不对（正则之外的一层保险） */
const fnMatch = src.match(/function isApduCommand\(command\) \{[\s\S]*?\n\}/);
ok('APDU 判定函数存在', !!fnMatch, '找不到 isApduCommand');
if (fnMatch) {
	const isApduCommand = eval('(' + fnMatch[0] + ')');
	ok('AT+CSIM 透传判定为 APDU', isApduCommand('AT+CSIM=20,"80E2910006BF3E035C015A"') === true);
	ok('AT+CGLA 透传判定为 APDU', isApduCommand('AT+CGLA=1,10,"81E2910006"') === true);
	ok('小写 / 等号形式同样判定为 APDU', isApduCommand('at+csim=?') === true);
	ok('逻辑通道管理判定为 APDU', isApduCommand('AT+CCHO="A0000005591010FFFFFFFF8900000100"') === true);
	ok('普通查询命令不判定为 APDU（AT+CSQ）', isApduCommand('AT+CSQ') === false);
	ok('普通查询命令不判定为 APDU（AT+CEREG?）', isApduCommand('AT+CEREG?') === false);
	ok('空值不判定为 APDU（不抛异常）', isApduCommand('') === false && isApduCommand(null) === false);

	/* 反向：把判定改成恒 false（模拟「分档写了但没生效」）后必须判红 */
	const NEEDLE = 'return /^AT\\+(CSIM|CGLA|CCHO|CCHC|CCHP)\\b/i.test(c);';
	if (fnMatch[0].indexOf(NEEDLE) < 0) {
		fails.push('APDU 反向：源码里找不到判定正则，反向断言无法构造（请先同步本测试）');
	} else {
		const broken = eval('(' + fnMatch[0].split(NEEDLE).join('return false;') + ')');
		ok('APDU 反向：判定恒 false 时 AT+CSIM 不再走宽预算',
			broken('AT+CSIM=10,"80"') === false,
			'判定函数被改坏后仍返回 true，行为断言无效');
	}
}

/*
 * ucode 侧的 nc 限时必须 >= APDU 最坏耗时（排队 8s + 应答 12s + 余量）。
 * ★ 2026-10-24：限时器不再写死 `timeout`（定制固件可能根本没这个 applet，
 *   见 tests/portable-timeout-contract.test.js），统一经由 timeoutBin() 解析；
 *   这里改成断言「45s 仍在原位，且入口是统一的」。
 */
const uc = fs.readFileSync(UCODE, 'utf8');
const NC_RE = /fs\.popen\(timeoutBin\(\) \+ ' (\d+) nc 127\.0\.0\.1 '/;
const ncMatch = uc.match(NC_RE);
ok('ucode 的 nc 限时已放宽到 45s（>= APDU 最坏 23s）', !!ncMatch && ncMatch[1] === '45',
	'ucode 仍按旧预算限时，会把一次正常的慢应答掐成「Rust 后端无应答」');
const ncRegressed = uc.split(' 45 nc ').join(' 20 nc ');
const ncMatch2 = ncRegressed.match(NC_RE);
ok('ucode 反向：退回 20s 限时后必须判红', !ncMatch2 || ncMatch2[1] !== '45',
	'回退后仍判为通过，限时检查无效');

/* ---------------- P11：竞速后清定时器 ---------------- */
const wt = src.slice(src.indexOf('function withTimeout('), src.indexOf('function withTimeout(') + 900);
ok('P11 withTimeout 内持有定时器句柄并清理',
	/var h = null;/.test(wt) && /clearTimeout\(h\)/.test(wt),
	'withTimeout 仍留下悬空的 setTimeout');
ok('P11 成功与失败两条路径都清理（then 的第二参）',
	/\.then\(function \(v\) \{ clear\(\); return v; \}/.test(wt)
	&& /function \(e\) \{ clear\(\); throw e; \}/.test(wt),
	'只清了一条路径，另一条仍会留下定时器');
/* 反向：改动前的旧实现必须被判红 */
const oldWt = "function withTimeout(p, ms, msg) {\n"
	+ "	return Promise.race([\n"
	+ "		p,\n"
	+ "		new Promise(function (resolve, reject) {\n"
	+ "			setTimeout(function () { reject(new Error(msg || '请求超时')); }, ms);\n"
	+ "		})\n"
	+ "	]);\n"
	+ "}\n";
ok('P11 反向：旧的 Promise.race 直挂写法被判为不通过',
	!/clearTimeout/.test(oldWt),
	'旧实现竟被判为通过，检查函数无效');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
process.exit(0);
