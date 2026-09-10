'use strict';
/**
 * 前端解析层单测（node 环境模拟浏览器加载 ws.js / parse.js）：
 * 覆盖"全部移植"新增的解析函数：辅载波聚合（MONSSC/CASCELLINFO）、REJINFO、SIMSQ。
 * 运行：node parse-extra-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');

// 用 Function 模拟 LuCI 全局环境加载两个库文件
const sandbox = { window: {}, AtWs: undefined, Parse: undefined, L: { view: { extend: function (o) { return o; } } } };
sandbox.window = sandbox;

function loadLib(name) {
	const code = fs.readFileSync(path.join(libDir, name), 'utf8');
	// 去掉 'use strict' 与 require 指令（node 单测不需要 LuCI 加载器）
	const cleaned = code
		.split('\n')
		.filter(function (l) { return l.indexOf("'require ") !== 0; })
		.join('\n');
	const fn = new Function('AtWs', 'Parse', 'E', 'L', cleaned + '\n;return { AtWs: AtWs, Parse: Parse };');
	return fn(sandbox.AtWs, sandbox.Parse, function () { return { appendChild: function () {} }; }, sandbox.L);
}

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

try {
	// 先加载 parse.js（ws.js 的 parseRawData 运行时引用全局 Parse）
	const parse = loadLib('parse.js');
	sandbox.Parse = parse.Parse;
	const ws = loadLib('ws.js');
	sandbox.AtWs = ws.AtWs;
	const Parse = parse.Parse;
	const AtWs = ws.AtWs;

	/* ---- 辅载波聚合 ---- */
	const monsscLines = '^MONSSC: "NR",2360,86,-70,-10,15,0\r\n^MONSSC: NONE';
	const nr = Parse.parseMonsscAll(monsscLines);
	check('parseMonsscAll 解析 1 条 NR 辅站', nr.length === 1, 'count=' + nr.length);
	check('MONSSC arfcn/pci', nr[0].arfcn === 2360 && nr[0].pci === 134, 'arfcn=' + nr[0].arfcn + ' pci=' + nr[0].pci);
	check('MONSSC 信号与测量方式', nr[0].rsrp === -70 && nr[0].rsrq === -10 && nr[0].sinr === 15 && nr[0].measType === 'SSB',
		'nr[0].rsrp=' + nr[0].rsrp + ' measType=' + nr[0].measType);

	// 无效值 -1256 应还原为 null（8 倍放大值判定）
	const monsscInvalid = '^MONSSC: "NR",2360,86,-1256,-348,-188,1';
	const nrInv = Parse.parseMonssc(monsscInvalid);
	check('MONSSC 无效值处理', nrInv.rsrp === null && nrInv.rsrq === null && nrInv.sinr === null,
		'rsrp=' + nrInv.rsrp + ' rsrq=' + nrInv.rsrq + ' sinr=' + nrInv.sinr);
	// 8 倍放大值（-560 = -70*8）应还原
	const monsscScaled = '^MONSSC: "NR",2360,86,-560,1,1,0';
	const nrScaled = Parse.parseMonssc(monsscScaled);
	check('MONSSC 8 倍值还原', nrScaled.rsrp === -70, 'rsrp=' + nrScaled.rsrp);

	const cascell = '^CASCELLINFO: 0,120,-75,-95,-12,3,1650,1750,16500,17500,3,3\r\n^CASCELLINFO: 1,121,-80,-100,-14,3,1651,1751,16510,17510,5,5';
	const lte = Parse.parseCascellAll(cascell);
	check('parseCascellAll 解析 2 条 LTE CA 辅小区', lte.length === 2, 'count=' + lte.length);
	check('CASCELL 字段换算', lte[0].dlArfcn === 1750 && lte[0].dlFreq === 1750.0 && lte[0].dlBandwidth === 10 && lte[0].pci === 120,
		'dlArfcn=' + lte[0].dlArfcn + ' dlFreq=' + lte[0].dlFreq + ' bw=' + lte[0].dlBandwidth);
	check('CASCELL 带宽表 5→20MHz', lte[1].dlBandwidth === 20, 'dlBandwidth=' + lte[1].dlBandwidth);

	// 载波合并：HFREQINFO 报 2360（NR）与 1750（LTE），应能对上
	const carriers = [
		{ sysMode: 'NR', dlFcn: '2360' },
		{ sysMode: 'LTE', dlFcn: '1750' }
	];
	const sigNr = Parse.carrierSignalFor(carriers[0], nr, lte);
	const sigLte = Parse.carrierSignalFor(carriers[1], nr, lte);
	check('carrierSignalFor NR 对齐', sigNr && sigNr.pci === 134 && sigNr.rsrp === -70, sigNr ? 'pci=' + sigNr.pci : 'null');
	check('carrierSignalFor LTE 对齐', sigLte && sigLte.pci === 120 && sigLte.rssi === -75, sigLte ? 'pci=' + sigLte.pci + ' rssi=' + sigLte.rssi : 'null');
	const orphan = Parse.unmatchedSecondaries(carriers, nr, lte);
	check('unmatchedSecondaries 不丢数据', orphan.nr.length === 0 && orphan.lte.length === 1,
		'nr=' + orphan.nr.length + ' lte=' + orphan.lte.length);

	/* ---- REJINFO ---- */
	const rejLine = '^REJINFO:46000,1,40,2,3,40,"0026F8","FF","0A444202"';
	const rej = Parse.parseRejInfo(rejLine);
	check('parseRejInfo 解析', !!rej && rej.plmn === '46000' && rej.domainText === 'PS 域', rej ? rej.plmn + ' ' + rej.domainText : 'null');
	check('REJINFO 原因与类型', rej.causeText === '没有激活的 EPS 承载' && rej.rejectTypeText === '网络 detach 被拒' && rej.ratText === 'E-UTRAN(4G)',
		rej.causeText + ' / ' + rej.rejectTypeText + ' / ' + rej.ratText);
	check('REJINFO 小区信息', rej.lac === '0026F8' && rej.cellId === '0A444202', rej.lac + ' / ' + rej.cellId);
	// 全角冒号也要能收（手册正文写法）
	const rejFull = Parse.parseRejInfo('^REJINFO：46000,1,40,2,3,40,"0026F8","FF","0A444202"');
	check('REJINFO 全角冒号兼容', !!rejFull && rejFull.plmn === '46000', rejFull ? 'ok' : 'null');
	// USIM 鉴权扩展原因
	check('REJINFO USIM 原因', Parse.rejectCauseText(65537) === 'USIM 鉴权失败（#65537）', Parse.rejectCauseText(65537));

	/* ---- SIMSQ ---- */
	const sq = Parse.parseSimsq('^SIMSQ: 0,12');
	check('parseSimsq 就绪', !!sq && sq.label === '卡就绪，短信与电话本可用' && sq.present === true, sq ? sq.label : 'null');
	const sqDead = Parse.parseSimsq('^SIMSQ: 0,98');
	// 原版语义：present 只排除 0/99，98（失效）依然 present=true
	check('parseSimsq 失效', sqDead.dead === true && sqDead.present === true, sqDead ? sqDead.label : 'null');

	/* ---- ws.js raw_data 拆分 REJINFO ---- */
	const parsed = AtWs.parseRawData('^REJINFO:46000,1,40,2,3,40,"0026F8","FF","0A444202"\r\n');
	const rejType = parsed.filter(function (p) { return p.type === 'REJINFO'; });
	check('parseRawData 拆分 REJINFO 类型', rejType.length === 1 && rejType[0].parsed && rejType[0].parsed.plmn === '46000',
		rejType.length + ' 条');
} catch (e) {
	check('单测执行', false, String(e && e.stack || e));
}

const fails = results.filter(function (r) { return !r.ok; });
console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
if (fails.length) {
	fails.forEach(function (f) { console.log('FAILED: ' + f.name + ' — ' + f.detail); });
	process.exit(1);
}
process.exit(0);
