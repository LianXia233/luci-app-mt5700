#!/usr/bin/env node
'use strict';

/**
 * 网络状态页 性能与归位契约测试（纯静态，不连设备、不发 AT、不改文件）
 * ---------------------------------------------------------------------------
 * 本轮（2026-09-18）会审的两类改动：
 *   A. 「流量统计清零」从「连接工具」迁到「速率与流量」卡头（P01）
 *      —— 顺带修掉一个真 bug：卡头「实时监测」的文字被 E() 静默丢掉（P15）
 *   B. 前端性能 / 响应速度（P03 / P04 / P05' / P06 / P07 / P10）
 *
 * 全部走「源码级静态断言」：这些是**结构契约**，不是行为，
 * 一旦有人把改动退回去，CI 立刻红，不用等上真机才发现界面变慢或按钮不见了。
 *
 * 用法：node tests/network-perf-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
const UI = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.js');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

const nsSrc = fs.readFileSync(NS, 'utf8');
const uiSrc = fs.readFileSync(UI, 'utf8');

/* 源码级断言只看代码：注释里会出现反例字面量（例如为了解释 P15 而原样抄了
   那句 4 参 E() 调用），直接对原文跑正则会被自己的注释命中。 */
function stripComments(s) {
	return s.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
const nsCode = stripComments(nsSrc);
const uiCode = stripComments(uiSrc);

/* ---------- 1. P01 清零入口归位到「速率与流量」卡头 ---------- */

ok('★ 清零按钮挂在速率卡头部容器 rateExtra 上',
	/rateExtra\.appendChild\(rateBar\)/.test(nsCode)
	&& /dangerButton\('清零流量', clearFlowStats\)/.test(nsCode),
	'rateBar 应同时含「实时监测」label 与清零按钮');

ok('★ 卡头容器用 .mt5700-toolbar（零新增样式，且窄屏会换行）',
	/var rateBar = E\('div', \{ 'class': 'mt5700-toolbar' \}\)/.test(nsCode));
/* .mt5700-autorefresh 是 Ui.autoRefresh 的私有类（ui.js），自带 margin 6/10px 与
   硬编码 #555（无深色变体）、且没有 flex-wrap —— 借来当卡头容器会顶高卡头、
   暗色下发灰、窄屏溢出。防回退钉子打在这里。 */
ok('★ 卡头容器不再借用 .mt5700-autorefresh（私有类，带硬编码色与外边距）',
	!/var rateBar = E\('div', \{ 'class': 'mt5700-autorefresh' \}\)/.test(nsCode));

ok('★ 连接工具里不再 append 清零块',
	!/toolsBody\.appendChild\(buildFlowClearBlock\(\)\)/.test(nsCode));
ok('★ buildFlowClearBlock 已整体删除（不留孤儿）',
	!/buildFlowClearBlock/.test(nsCode));
ok('清零仍走二次确认（不可逆操作）',
	/function clearFlowStats[\s\S]{0,300}Mt5700\.confirm/.test(nsCode));
ok('清零仍下发 AT^DSFLOWCLR（手册 16.11）',
	/sendCommand\('AT\^DSFLOWCLR'\)/.test(nsCode));
ok('按钮给出 title 说明（迁走后不再有块内说明文字可看）',
	/flowClearBtn\.title\s*=/.test(nsCode));

/* ---------- 2. P15 E() 静默丢参：全仓不得再有 4 参调用 ---------- */

/**
 * 扫描源码里所有 `E(...)` 调用，返回顶层参数个数 ≥ 4 的位置。
 * 容忍换行与嵌套括号；只匹配顶层逗号。
 */
/**
 * 扫描源码里所有 `E(...)` 调用，返回顶层参数个数 ≥ 4 的位置。
 * 容忍换行与嵌套括号；只按顶层逗号切分。
 *
 * ★ 自检：本函数曾有致命 bug —— 用了不存在的 `m.end`（`RegExp.exec` 的返回
 *   只有 `index`，没有 `end`），于是 `start` 算出 NaN，扫描器**恒返回空数组**，
 *   断言变成永真。是审查阶段抓出来的（假守卫比没守卫更危险：它会让人以为
 *   已经防住了）。因此这里附带一条针对扫描器自身的断言，见下方第 2 节。
 */
function findMultiArgECalls(src) {
	const out = [];
	const lines = src.split('\n');
	for (let ln = 0; ln < lines.length; ln++) {
		const line = lines[ln];
		for (let i = 0; i >= 0; ) {
			const m = /\bE\(/.exec(line.slice(i));
			if (!m) break;
			const start = i + m.index + m[0].length;
			let depth = 1, k = start, instr = null;
			while (k < line.length && depth > 0) {
				const c = line[k];
				if (instr) { if (c === instr) instr = null; }
				else if (c === '"' || c === "'" || c === '`') instr = c;
				else if (c === '(') depth++;
				else if (c === ')') depth--;
				k++;
			}
			if (depth !== 0) { i = start; continue; }   /* 跨行调用：本行不成对，跳过 */
			const inner = line.slice(start, k - 1);
			let d = 0, q = 0, cur = '', parts = [], s2 = null;
			while (q < inner.length) {
				const c = inner[q];
				if (s2) { if (c === s2) s2 = null; cur += c; }
				else if (c === '"' || c === "'" || c === '`') { s2 = c; cur += c; }
				else if (c === '(' || c === '[' || c === '{') { d++; cur += c; }
				else if (c === ')' || c === ']' || c === '}') { d--; cur += c; }
				else if (c === ',' && d === 0) { parts.push(cur.trim()); cur = ''; }
				else cur += c;
				q++;
			}
			if (cur.trim()) parts.push(cur.trim());
			if (parts.length >= 4) out.push({ line: ln + 1, argc: parts.length, text: line.trim().slice(0, 110) });
			i = k;
		}
	}
	return out;
}

/* 扫描范围必须是**全仓前端**，不能只扫改动到的那两个文件 ——
   esim.js 里就踩中过一次（「处理待发回执」按钮被吃掉），只扫两个文件根本抓不到。 */
function collectJs(dir, acc) {
	fs.readdirSync(dir).forEach(function (name) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) collectJs(p, acc);
		else if (name.endsWith('.js')) acc.push(p);
	});
	return acc;
}
const JS_FILES = collectJs(path.join(ROOT, 'htdocs', 'luci-static', 'resources'), []);
ok('能列出前端 js 文件', JS_FILES.length > 5, String(JS_FILES.length));

const badAll = [];
JS_FILES.forEach(function (p) {
	findMultiArgECalls(stripComments(fs.readFileSync(p, 'utf8'))).forEach(function (hit) {
		badAll.push(path.relative(ROOT, p) + ':' + hit.line + ' (argc=' + hit.argc + ') ' + hit.text);
	});
});
ok('★ 全仓前端没有 4 参及以上的 E() 调用（第 4 参会被引擎静默丢弃）',
	badAll.length === 0, badAll.slice(0, 3).join(' | '));

/* ★★ 扫描器自检：假守卫比没守卫更危险 —— 它让人以为已经防住了。
   喂一段已知的坏例，扫描器必须报出来。 */
ok('★ 扫描器自检：能识别出 4 参的坏例（否则整条守卫是永真的）',
	findMultiArgECalls("x.appendChild(E('div', {}, a, b));").length === 1);
ok('★ 扫描器自检：3 参的正常调用不算违规',
	findMultiArgECalls("x.appendChild(E('div', {}, a));").length === 0);
ok('★ 扫描器自检：字符串里的逗号不会被误切成多个参数',
	findMultiArgECalls("E('p', {}, 'a, b, c');").length === 0);

ok('「实时监测」文字改成两步建（先建 label，再 appendChild 文本节点）',
	/var rateLabel = E\('label', \{\}, rateChk\);/.test(nsCode)
	&& /rateLabel\.appendChild\(document\.createTextNode\(' 实时监测'\)\)/.test(nsCode));

/* ---------- 3. P03 1Hz 速率采样纳入可见性管控 ---------- */

const visFn = (nsCode.match(/var onVisibility = function \(\) \{[\s\S]*?\n\t\t\};/) || [''])[0];
ok('能定位 onVisibility', visFn.length > 0);
ok('★ 页面隐藏时一并停掉 1Hz 的 rateTimer（它是唯一不受 resetTimers 管辖的定时器）',
	/document\.hidden[\s\S]{0,300}clearInterval\(rateTimer\)/.test(visFn));
ok('★ 回到前台重开速率采样前先丢弃旧基准 rateSample',
	/rateSample = null;[\s\S]{0,200}setInterval\(sampleRate, 1000\)/.test(visFn));
ok('★ 后台标签页打开时不启动 1Hz 采样（否则用户还没看到页面就在刷 RPC）',
	/if \(rateOn && !document\.hidden\) \{/.test(nsCode));
ok('★ 回到前台时按 rateOn 补起采样（onVisibility 的 visible 分支）',
	/if \(rateOn && !rateTimer\) \{[\s\S]{0,300}setInterval\(sampleRate, 1000\)/.test(nsCode));
ok('_dispose 里清 rateTimer（防反复进出叠加定时器）',
	/_dispose[\s\S]{0,600}clearInterval\(rateTimer\)/.test(nsCode));

/* ---------- 4. P04 初始化不再重复渲染连接明细 ---------- */

/* 注意：nsCode 已去掉注释，不能拿注释当锚点定位，改用代码本身的首尾。 */
const initEnd = nsCode.indexOf('self._dispose');
const initStart = nsCode.lastIndexOf('renderConn();', initEnd);
const initBlock = (initStart >= 0 && initEnd > initStart) ? nsCode.slice(initStart, initEnd) : '';
ok('能定位初始化段', initBlock.length > 0);
const detailCalls = (initBlock.match(/renderConnDetail\(\)/g) || []).length;
ok('★ 初始化段只渲染一次连接明细（原先连着调了两次）',
	detailCalls === 1, '实测 ' + detailCalls + ' 次');
ok('DNS 配置到位后仍会重绘一次（自定义 DNS 要显示出来）',
	/loadDnsConfig\(\)\.then\(renderConnDetail\)/.test(nsCode));

/* ---------- 5. P05' 确定性失败的命令不重试 ---------- */

ok('★ AT^DHCPV6? 显式 attempts:1（实测它是 23 条只读命令里唯一恒定失败的一条）',
	/sendCommand\('AT\^DHCPV6\?', \{ attempts: 1 \}\)/.test(nsCode));
ok('其余常规读数没有被顺手降重试（错误恢复能力不能被削弱）',
	(nsCode.split('attempts: 1').length - 1) === 1,
	'attempts:1 出现 ' + (nsCode.split('attempts: 1').length - 1) + ' 次');

/* ---------- 6. P06 图表宽度缓存（layout thrashing） ---------- */

ok('★ renderChart 不再每次读 chart.clientWidth',
	!/width:\s*chart\.clientWidth/.test(nsCode));
ok('★ 宽度只在缓存未命中时读一次，且量到 0 时不缓存（没上屏时会是 0）',
	/if \(!chartWidth\) \{\s*var measured = chart\.clientWidth;\s*if \(measured\) chartWidth = measured;\s*\}/.test(nsCode));
ok('★ 失效源优先用 ResizeObserver（滚动条/断点/侧栏折叠不一定派发 window resize）',
	/chartRO = new ResizeObserver\(onResize\);/.test(nsCode)
	&& /chartRO\.observe\(chart\)/.test(nsCode)
	&& /typeof ResizeObserver === 'function'/.test(nsCode));
ok('★ 不支持 ResizeObserver 的浏览器退回 window.resize（功能不打折）',
	/else \{\s*window\.addEventListener\('resize', onResize\);\s*\}/.test(nsCode));
ok('★ 监听在 _dispose 里成对移除（防泄漏）',
	/_dispose[\s\S]{0,900}chartRO\.disconnect\(\)/.test(nsCode)
	&& /_dispose[\s\S]{0,900}removeEventListener\('resize', onResize\)/.test(nsCode));
ok('★ 不可见时不重建图表 / 不采样（切后台瞬间在飞的那次也要挡）',
	/function renderChart\(\) \{\s*[\s\S]{0,200}if \(document\.hidden\) return;/.test(nsCode)
	&& /function sampleRate\(\) \{\s*[\s\S]{0,200}if \(document\.hidden\) return/.test(nsCode));

/* ---------- 7. P07 曲线 tooltip 的 rect 缓存 ---------- */

ok('★ mousemove 不再无条件读 rect（改成用缓存）',
	!/mousemove[\s\S]{0,300}var rect = wrap\.getBoundingClientRect\(\)/.test(uiCode)
	&& /var rect = hoverRect;/.test(uiCode));
ok('★ rect 在 mouseenter 量一次、mouseleave 丢弃',
	/mouseenter'[\s\S]{0,200}hoverRect = wrap\.getBoundingClientRect\(\)/.test(uiCode)
	&& /mouseleave'[\s\S]{0,200}hoverRect = null/.test(uiCode));
ok('★ 缓存为空时有兜底（元素在光标下被重建时不会拿不到 rect）',
	/if \(!hoverRect\) hoverRect = wrap\.getBoundingClientRect\(\);/.test(uiCode));

/* ---------- 8. P10 清零后取数失败也要重绘 ---------- */

ok('★ 清零后重取流量失败时，把 state.flow 置空再重绘（不能留旧数字）',
	/getFlow\(\)\.then\(renderFlow, function \(\) \{\s*state\.flow = \{\};/.test(nsCode));
ok('★ 清零成功后峰值一并归零（否则会出现「累计 0 但峰值 300 Mbps」的矛盾画面）',
	/Mt5700\.success\('已清零'\);[\s\S]{0,600}state\.peakDown = 0;\s*state\.peakUp = 0;/.test(nsCode));
ok('★ 流量格式化对空值显示「—」（formatFlow(undefined) 会算出 NaN TB）',
	/function durText\(v, showDays\) \{ return v == null \? '—'/.test(nsCode)
	&& /function flowText\(v\) \{ return v == null \? '—'/.test(nsCode));

/* ---------- 9. 防倒退：这些既有契约不许被本轮改动破坏 ---------- */

ok('「速率与流量」卡片仍在', /Mt5700\.card\('速率与流量'/.test(nsCode));
/* 2026-09-19：本卡已升级为「断网排查」（三层 32 项），标题随之改变。
   ★ 2026-09-19 v2.3.15：排查**不再进页面自动跑**，改成只有用户点「一键排查」才跑
   （自动跑会占住独占的 AT 通道十几秒，和页面轮询、手动 AT 抢通道），故断言取反。 */
ok('「断网排查」卡片仍在（原「连接工具」升级而来）',
	/Mt5700\.card\('断网排查', '三层体检 · 一键定位'\)/.test(nsCode));
ok('★ 排查不进页面自动跑（只在用户点「一键排查」时才走）',
	!/runDiagnosis\(\)\.catch/.test(nsCode) && !/readAdcPins/.test(nsCode));
ok('明细折叠状态不进 state.tools.diag（无 t.expanded，无向导式「展开步骤」）',
	!/t\.expanded/.test(nsCode) && !/展开步骤/.test(nsCode));

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('网络状态页 性能与归位契约测试全部通过');
