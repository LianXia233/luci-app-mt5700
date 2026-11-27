'use strict';
/**
 * 时间口径回归测试：业务时间必须走插件自己的时间源（后端 nettime）。
 *
 * 口径（见 docs/release-notes/v1.24.1 / v1.30.9）：
 *   - 后端墙上时间一律 nettime::now()/now_ms()（NTP 优先、设备时钟回退）；
 *   - 前端不得用浏览器时钟（new Date() / Date.now() / toLocaleTimeString）
 *     做业务时间展示，只能格式化后端给的 epoch；
 *   - Date.now() 仅允许技术用途：超时 / TTL / 去重键 / 文件名 / 熔断。
 *
 * 本次修复的 4 处真违规：
 *   network_status.js 趋势图横轴、terminal.js 命令回显、
 *   network_settings.js + parse.js 的 REJINFO 上报时刻。
 *
 * 运行：node tests/server-time-test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const resDir = path.join(root, 'htdocs', 'luci-static', 'resources');
const libDir = path.join(resDir, 'mt5700d');
const viewDir = path.join(resDir, 'view', 'mt5700d');
const read = function (p) { return fs.readFileSync(p, 'utf8'); };

const rpcJs = read(path.join(libDir, 'rpc.js'));
const parseJs = read(path.join(libDir, 'parse.js'));
const netJs = read(path.join(viewDir, 'network_settings.js'));
const termJs = read(path.join(viewDir, 'terminal.js'));
const statusJs = read(path.join(viewDir, 'network_status.js'));
const rpcServerRs = read(path.join(root, 'src', 'rust', 'src', 'rpcserver.rs'));
const urcRs = read(path.join(root, 'src', 'rust', 'src', 'urc.rs'));

const results = [];
function check(name, ok, detail) {
	results.push({ name: name, ok: !!ok, detail: detail || '' });
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  ← ' + detail));
}

/* ---------- 1) 后端提供权威时刻出口 ---------- */
check('后端 at 应答带 at_ms（nettime::now_ms）',
	/"at_ms"\s*:\s*crate::nettime::now_ms\(\)/.test(rpcServerRs));
check('后端 raw_data 上报带 at_ms',
	/"type"\s*:\s*"raw_data"[\s\S]{0,200}"at_ms"\s*:\s*crate::nettime::now_ms\(\)/.test(urcRs));

/* ---------- 2) 前端传输层透传 ---------- */
check('sendCommand 成功应答透传 at_ms', /at_ms:\s*resp\.at_ms/.test(rpcJs));
check('raw_data 事件把 at_ms 传给解析层', /dispatchRawData\(ev\.data,\s*ev\.at_ms\)/.test(rpcJs));
check('parseRawData 接收并下传 atMs',
	/function parseRawData\(text,\s*atMs\)/.test(rpcJs)
	&& /parseRejInfo\(line,\s*atMs\)/.test(rpcJs));

/* ---------- 2b) 失败应答与批量路径同样透传 ----------
 * 只修成功路径是不够的：AT 失败应答后端照样带 at_ms，前端在失败分支丢掉
 * 它，终端历史里「命令失败」那几条就只能是「时间未知」；批量接口是 status
 * 页的取数主干，吞掉逐条 at_ms 会让趋势图横轴永远退化成序号占位。
 */
const cmdFn = rpcJs.slice(rpcJs.indexOf('ATClient.prototype.sendCommand = function'),
	rpcJs.indexOf('ATClient.prototype.sendBatch = function'));
check('sendCommand 失败应答也带 at_ms', (cmdFn.match(/at_ms:\s*resp\.at_ms/g) || []).length >= 2);
check('sendBatch 逐条透传 at_ms', /at_ms:\s*it\.at_ms/.test(rpcJs));
const pfFn = statusJs.slice(statusJs.indexOf('function prefetchRound()'),
	statusJs.indexOf('function atCommand(cmd)'));
check('status 预取缓存保留 at_ms（成功与失败分支都要）',
	(pfFn.match(/at_ms:\s*it\.at_ms/g) || []).length >= 2);

/* ---------- 3) 4 处业务时间违规已消除 ---------- */
check('terminal.js 不再用浏览器时钟打命令时间戳',
	termJs.indexOf("new Date().toLocaleTimeString") < 0
	&& /serverClock\(res\s*&&\s*res\.at_ms\)/.test(termJs));
check('network_settings.js 用 serverClock 展示上报时刻',
	netJs.indexOf('new Date(r.at).toLocaleTimeString') < 0
	&& /serverClock\(r\.at\)/.test(netJs));
const rejFn = parseJs.slice(parseJs.indexOf('api.parseRejInfo = function'),
	parseJs.indexOf('/* ================= SIM 信号质量'));
check('parse.js 的 REJINFO 不再用 Date.now() 打戳',
	rejFn.indexOf('Date.now()') < 0
	&& /at:\s*\(atMs != null && isFinite\(atMs\)\)/.test(rejFn));
check('network_status.js 趋势图采样不再取浏览器当前时刻',
	!/var now = new Date\(\);[\s\S]{0,120}getHours\(\)/.test(statusJs)
	&& /state\.cell\.at_ms\s*=/.test(statusJs)
	&& /Mt5700d\.serverClock\(sampleMs\)/.test(statusJs));

/* ---------- 4) serverClock 纯函数行为 ---------- */
const fnMatch = rpcJs.match(/function serverClock\(atMs, withDate\)\s*\{[\s\S]*?\n\}/);
check('serverClock 函数存在', !!fnMatch);
if (fnMatch) {
	const serverClock = new Function(fnMatch[0] + '; return serverClock;')();
	check('serverClock(null) 返回 null（不冒充本地时刻）', serverClock(null) === null);
	check('serverClock(NaN) 返回 null', serverClock(NaN) === null);
	const ts = Date.UTC(2026, 0, 2, 3, 4, 5);
	const hm = serverClock(ts);
	/* 只校验形态与"取自入参时刻"，时区无关：用同一 Date 算法构造期望 */
	const d = new Date(ts);
	const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
	const expect = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
	check('serverClock 按入参 epoch 格式化 HH:MM:SS', hm === expect, hm + ' vs ' + expect);
	const full = serverClock(ts, true);
	check('serverClock(withDate) 含日期', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(full), full);
}

/* ---------- 5) 行尾 ---------- */
[['rpc.js', rpcJs], ['parse.js', parseJs], ['network_settings.js', netJs],
 ['terminal.js', termJs], ['network_status.js', statusJs],
 ['rpcserver.rs', rpcServerRs], ['urc.rs', urcRs]].forEach(function (pair) {
	check(pair[0] + ': LF 行尾', pair[1].indexOf('\r\n') < 0);
});

const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (failed.length ? 'FAILED ' + failed.length : 'ALL ' + results.length + ' PASSED'));
process.exit(failed.length ? 1 : 0);
