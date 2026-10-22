#!/usr/bin/env node
/*
 * 4G（LTE）信号契约测试 —— 重点是 SINR
 * ---------------------------------------------------------------------------
 * 起因（真实报障）：漫游回落到 4G LTE 后，界面上 SINR 一直是「—」。
 *
 * 根因是两处叠加，各查了一半：
 *   ① ^MONSC 的 LTE 布局**根本不带 SINR**（手册 13.9：…<RSRP>,<RSRQ>,<RSSI>，
 *      末位是 RSSI）。所以 4G 的 SINR 只能由 ^HCSQ 补。
 *   ② 补查条件写成了「^HFREQINFO 一条载波都没返回」，而 4G 下 ^HFREQINFO
 *      **正常返回 LTE 载波** —— 条件恒不成立，^HCSQ 永远不发，SINR 恒为「—」。
 *
 * 另外 ^HCSQ 的 LTE 字段序也与 NR 不同（手册 13.5 字段表）：
 *      "LTE",<lte_rssi>,<lte_rsrp>,<lte_sinr>,<lte_rsrq>
 *      "NR",<5g_rsrp>,<5g_sinr>,<5g_rsrq>
 * 即 LTE 比 NR 前面多一个 RSSI，且 **SINR 在 value3、RSRQ 在 value4**
 * （NR 恰好相反）。此前一律按 NR 的 <rsrp>,<sinr>,<rsrq> 套，SINR 与 RSRQ
 * 整个对调：SINR 吃到 RSRQ 的工程值，界面上就是「4G 下 SINR 是负数或没有」。
 *
 * 本文件用**真机原文**验解析结果（不是数字符串），并钉住 network_status.js 的
 * 补查时机。修改任一处都必须让这里判红 —— 否则又是"改了但没生效"。
 *
 * 用例数据来源：手册 13.5 字段表 + lx-mt5700 真机实测
 * （`^HCSQ: "LTE",45,34,106,19` ↔ RSSI -76 / RSRP -106 / SINR 1.2 / RSRQ -10）。
 *
 * 用法：node tests/lte-signal-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
const RPC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');

const nsSrc = fs.readFileSync(NS, 'utf8');
const rSrc = fs.readFileSync(RPC, 'utf8');

let pass = 0;
const fails = [];
/*
 * 统一走 record()：near/isNull 这类包装函数如果直接调 ok(name, …)，
 * 第一个实参是变量而不是字符串字面量，会被 assert-signature-contract
 * 判成「方向不明」。判定入口只有 ok() 一个，且它只接受字面量名称。
 */
function record(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}
function ok(name, cond, hint) { record(name, cond, hint); }
/* 浮点不能直接用 ===：sinr/rsrq 都是 0.2 / 0.5 步进算出来的 */
function near(name, actual, expect) {
	record(name, actual != null && Math.abs(actual - expect) < 0.05,
		'期望 ' + expect + '，实际 ' + actual);
}
function isNull(name, actual) {
	record(name, actual === null, '期望 null（不编造、也不是 NaN），实际 ' + actual);
}

/* 从源码抠出函数（与 carrier-arfcn-contract 同一套办法） */
function grab(name, src) {
	const i = src.indexOf('function ' + name + '(');
	if (i < 0) throw new Error('源码里找不到函数 ' + name);
	let depth = 0, started = false;
	for (let j = i; j < src.length; j++) {
		const c = src[j];
		if (c === '{') { depth++; started = true; }
		else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
	}
	throw new Error('函数体括号不配对：' + name);
}

const parseHCSQ = eval('(function(){' +
	['extractATData', 'round1', 'convertRsrp', 'convertRsrq', 'convertSinr', 'convertRssi', 'parseHCSQ']
		.map(function (n) { return grab(n, rSrc); }).join('\n') +
	'\nreturn parseHCSQ;})()');

/* ================= ① ^HCSQ 的 LTE 字段序（手册 13.5） ================= */

const LTE_FULL = '^HCSQ: "LTE",45,34,106,19\r\nOK';
const lte = parseHCSQ(LTE_FULL);

ok('LTE 样本能解析出对象', !!lte, 'parseHCSQ 返回 ' + lte);
ok('LTE 的 networkMode 是 LTE', lte && lte.networkMode === 'LTE',
	'实际 ' + (lte && lte.networkMode));
near('LTE：value1 是 RSSI（45 → -76 dBm）', lte && lte.rssi, -76);
near('LTE：value2 是 RSRP（34 → -106 dBm）', lte && lte.rsrp, -106);
near('LTE：★ value3 是 SINR（106 → 1.2 dB）', lte && lte.sinr, 1.2);
near('LTE：value4 是 RSRQ（19 → -10 dB）', lte && lte.rsrq, -10);

/*
 * 这是当初真正错的地方：把 RSRQ 的工程值当 SINR 换算。
 * 错位时 sinr = convertSinr(19) = -16.2，rsrq 又会吃到 106 被截成 -3。
 */
ok('★ LTE 的 SINR 不是拿 RSRQ 的工程值算的（错位时为 -16.2）',
	lte && Math.abs(lte.sinr - (-16.2)) >= 0.05, '实际 SINR ' + (lte && lte.sinr));
ok('★ LTE 的 RSRQ 不是拿 SINR 的工程值算的（错位时被截成 -3）',
	lte && Math.abs(lte.rsrq - (-3)) >= 0.05, '实际 RSRQ ' + (lte && lte.rsrq));

/* NR 回归：字段序本来就与手册一致，改 LTE 不能碰坏它 */
const nr = parseHCSQ('^HCSQ: "NR",77,236,31\r\nOK');
ok('NR 的 networkMode 是 NR', nr && nr.networkMode === 'NR', '实际 ' + (nr && nr.networkMode));
near('NR：value1 是 RSRP（77 → -63 dBm）', nr && nr.rsrp, -63);
near('NR：value2 是 SINR（236 → 27.2 dB）', nr && nr.sinr, 27.2);
near('NR：value3 是 RSRQ（31 → -4 dB）', nr && nr.rsrq, -4);
isNull('NR 不带 RSSI 字段', nr && nr.rssi);

/* ================= ② 缺字段一律 null，不编造、不传 NaN ================= */

const lteShort = parseHCSQ('^HCSQ: "LTE",45,34,106\r\nOK');
near('LTE 缺 value4 时 SINR 照常出（106 → 1.2）', lteShort && lteShort.sinr, 1.2);
isNull('LTE 缺 value4 时 RSRQ 是 null（不拿 SINR 顶替）', lteShort && lteShort.rsrq);

/*
 * 「参数随网络情况变化而改变，暂时未获取到的参数留空」（手册 13.9 同款说明）。
 * 留空 = 空串 = parseInt 得 NaN；NaN 会一路传到界面变成 `width:NaN%`。
 */
const lteGap = parseHCSQ('^HCSQ: "LTE",45,34,,19\r\nOK');
isNull('LTE 的 SINR 字段留空时是 null 而不是 NaN', lteGap && lteGap.sinr);
near('同一帧里 RSRQ 仍要解析出来（19 → -10）', lteGap && lteGap.rsrq, -10);

const none = parseHCSQ('^HCSQ: "NOSERVICE"\r\nOK');
isNull('NOSERVICE 时 RSRP 为 null', none && none.rsrp);
isNull('NOSERVICE 时 SINR 为 null', none && none.sinr);

/* ================= ③ 补查时机（network_status.js） ================= */

/*
 * 旧写法：只有 `!carriers.length` 才查 ^HCSQ。4G 下 ^HFREQINFO 正常返回 LTE
 * 载波 → 这个条件**恒不成立**。这条断言负责让它不能回来。
 */
ok('★ 不再用「一条载波都没有」当 ^HCSQ 的补查条件（4G 下恒不成立）',
	!/if\s*\(\s*!\s*carriers\.length\s*\)/.test(nsSrc),
	'network_status.js 里仍有 !carriers.length');

const fill = nsSrc.indexOf('function fillSignalFromHCSQ(');
ok('存在独立的补查函数 fillSignalFromHCSQ', fill >= 0);
const fillBody = fill >= 0 ? nsSrc.slice(fill, nsSrc.indexOf('\n\t\t}', fill)) : '';
ok('补查是「三项里有缺才发」，不是每轮都发',
	/rsrp\s*!=\s*null[\s\S]*rsrq\s*!=\s*null[\s\S]*sinr\s*!=\s*null[\s\S]*Promise\.resolve/.test(fillBody),
	'没看到「三项齐全就跳过」的短路');
ok('补查发的是 AT^HCSQ?', /sendCommand\('AT\^HCSQ\?'\)/.test(fillBody));

/*
 * 只填空缺、不覆盖：^MONSC 是服务小区实测值，^HCSQ 是模组侧的量，
 * NR 下两者本就有 1~2 dB 差（实测 -65/28 对 -63/27.2），让 ^MONSC 优先。
 */
['rsrp', 'rsrq', 'sinr'].forEach(function (k) {
	ok('补查只填空缺、不覆盖已取到的 ' + k,
		new RegExp('state\\.cell\\.' + k + '\\s*==\\s*null\\)\\s*state\\.cell\\.' + k + '\\s*=\\s*h\\.' + k)
			.test(fillBody));
});

/* 补查必须在渲染之前：否则补到的值这一轮不显示，要等下一轮 */
const callIdx = nsSrc.indexOf('return fillSignalFromHCSQ();');
ok('★ fillSignalFromHCSQ() 之后紧接着就是渲染（补到的值这一轮就要显示）',
	callIdx >= 0 && /renderSignal\(\);/.test(nsSrc.slice(callIdx, callIdx + 200)),
	'补查后面 200 字符内没有 renderSignal()，补到的值要等下一轮才显示');

/*
 * 制式刚切的那一轮，^HCSQ 可能还报旧制式。漫游时 5G↔4G 来回重选很频繁，
 * 拿 NR 的 SINR 填进 LTE 那一栏比留空更误导。
 */
ok('制式不一致时不采信 ^HCSQ 的值',
	/h\.networkMode\s*!==\s*state\.cell\.sysMode/.test(fillBody));

/* ================= ④ ^MONSC 的 LTE 分支不能"补"出 SINR ================= */

/*
 * 手册 13.9：LTE 的 <cell_paras> 末位是 RSSI，没有 SINR 字段
 * （举例 `^MONSC: LTE,460,01,1650,A54933,1F3,183D,-98,-5,-72`）。
 * 若有人把末位 RSSI 当 SINR 填进 sinr，4G 的 SINR 会显示成 -72 —— 看着像有值，
 * 其实是 RSSI。这条断言把「LTE 无 SINR」这件事钉死。
 */
/*
 * ★ 断言必须**限定在 LTE 分支块内**。
 * 早先写成全文正则 `/sysMode:\s*'LTE'[\s\S]*?…sinr:\s*null/`，变异验证时把
 * LTE 分支的 sinr 改成 num(p[9]) **照样全绿**：`[\s\S]*?` 会跨过整个 LTE 分支，
 * 命中后面 WCDMA 分支里同形的 `…num(p[8]), sinr: null`（那支也是按 LTE 位序
 * 宽松解析的）。两段相似代码，改一段另一段顶上 —— 断言等于没写。
 */
const monLteIdx = rSrc.indexOf("sysMode: 'LTE'");
const monLteBlock = monLteIdx >= 0 ? rSrc.slice(monLteIdx, rSrc.indexOf('};', monLteIdx)) : '';
ok('源码里能定位到 ^MONSC 的 LTE 分支（否则下面两条是空判）', monLteIdx >= 0 && monLteBlock.indexOf('num(p[7])') >= 0);
ok('★ ^MONSC 的 LTE 分支不带 SINR（手册 13.9 布局里没有该字段）',
	/rsrp:\s*num\(p\[7\]\),\s*rsrq:\s*num\(p\[8\]\),\s*sinr:\s*null/.test(monLteBlock),
	'parseMONSC 的 LTE 分支给 sinr 赋了值 —— 末位字段是 RSSI 不是 SINR');
ok('^MONSC 的 LTE 分支末位是 RSSI（p[9]）', /rssi:\s*num\(p\[9\]\)/.test(monLteBlock),
	'末位字段不是 RSSI —— 布局一旦错位，RSRP/RSRQ 会整体串位');

/* ================= ⑤ 浮点尾数：SINR 只能有一位小数 ================= */

/*
 * 真机报障：界面上 SINR 显示成 `9.200000000000003 dB`。
 * 数值本身没错（^HCSQ 原始值 146 → -20 + 146 × 0.2 = 9.2 dB），错在
 * **0.2 不是二进制有限小数**，而界面是 `sinr + ' dB'` 直接拼串 —— 尾数
 * 原样显示。修法是在换算出口统一收到一位小数（下游不用各自 toFixed）。
 *
 * 这里用**字符串形态**断言，而不是 Math.abs 容差：容差判不出尾数，
 * 9.200000000000003 与 9.2 的差远小于任何合理容差。
 */
const convertSinr = eval('(function(){' +
	['round1', 'convertSinr'].map(function (n) { return grab(n, rSrc); }).join('\n') +
	'\nreturn convertSinr;})()');

const sinr146 = convertSinr ? convertSinr(146) : null;
ok('★ SINR 原始值 146 → 9.2 dB（不是 9.200000000000003）', sinr146 === 9.2,
	'实际 ' + sinr146);
ok('★ SINR 拼成展示串后没有浮点尾数', String(sinr146) === '9.2',
	'实际展示为 "' + String(sinr146) + ' dB"');
ok('★ ^HCSQ 整帧解析出来的 SINR 也是干净的（106 → 1.2）', String(lte && lte.sinr) === '1.2',
	'实际 "' + String(lte && lte.sinr) + '"');

/*
 * 全量程扫一遍（0~255 是 ^HCSQ 的原始值域）：只要有一档留着尾数就判红。
 * 用字符串形态而不是数值 —— 尾数在数值上几乎看不出来。
 */
let dirty = null;
for (let raw = 0; raw <= 255; raw++) {
	const v = convertSinr(raw);
	if (!/^-?\d+(\.\d)?$/.test(String(v))) { dirty = raw + ' → ' + v; break; }
}
ok('★ 原始值 0~255 全量程换算后都是一位小数（无浮点尾数）', dirty === null,
	'第一处带尾数的是 ' + dirty);

/*
 * NaN 必须原样透传（2026-10-22 审计）：raw 来自 parseInt(p[8])，而
 * parseInt('nan') = NaN —— 这条路径真实可达。JS 的 Math.min/max 传播 NaN，
 * 所以前端侧本来就是对的；**Rust 后端**原先用 f64::min/max 链（不传播 NaN），
 * 把 NaN 变成 30.0 —— 同一读数两边两个值（后端 30.0「信号最好」/前端 NaN）。
 * 后端已改用 clamp 与前端同口径，这里锁住前端语义防止回退。
 */
ok('★ SINR 换算对 NaN 原样透传（不被伪装成 30.0 上限）',
	convertSinr && Number.isNaN(convertSinr(NaN)),
	'实际 ' + (convertSinr ? convertSinr(NaN) : 'helper 缺失'));

/* 边界值仍要落在手册规定的 -20~30 dB 上（收尾数不能把量程收窄） */
ok('SINR 下限仍是 -20 dB（原始值 0）', convertSinr(0) === -20, '实际 ' + convertSinr(0));
ok('SINR 上限仍是 30 dB（原始值 251 及以上）', convertSinr(251) === 30 && convertSinr(255) === 30,
	'实际 ' + convertSinr(251) + ' / ' + convertSinr(255));

/*
 * 定位断言：收尾数只能发生在 convertSinr 里（换算出口）。
 * 若有人在调用处各自 toFixed，或者把 round1 从 convertSinr 里摘走，
 * 上面那几条会先红；这条负责保证修法**留在单一真源**上。
 */
const sinrFn = grab('convertSinr', rSrc);
ok('★ 收尾数发生在 convertSinr 内部（单一真源，调用处不再各自处理）',
	/round1\(/.test(sinrFn), 'convertSinr 里没有调用 round1');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('4G（LTE）信号契约测试全部通过');
