'use strict';
/**
 * 前端解析层单测（node 环境模拟浏览器加载 rpc.js / parse.js）：
 * 覆盖"全部移植"新增的解析函数：辅载波聚合（MONSSC/CASCELLINFO）、REJINFO、SIMSQ，
 * 以及按《AT 命令手册》校准的 CHIPTEMP(17.1) / MCS(13.22) / TRANSMODE(13.31) /
 * FOTA 状态机与下载进度(15.4~15.7) / TDCFG 多行键值应答(16.23)。
 * 运行：node parse-extra-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');

// 用 Function 模拟 LuCI 全局环境加载两个库文件
const sandbox = {
	window: {}, AtWs: undefined, Parse: undefined,
	L: {
		/* rpc.js 末尾会执行 L.Class.extend(...)，缺了它加载直接抛错 */
		Class: { extend: function (o) { return o; } },
		view: { extend: function (o) { return o; } },
		rpc: { declare: function () { return function () { return Promise.resolve({}); }; } },
		uci: { load: function () { return Promise.resolve(); }, get: function () { return ''; } }
	}
};
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
	// 先加载 parse.js（rpc.js 的 parseRawData 运行时引用全局 Parse）
	const parse = loadLib('parse.js');
	/* parse.js 同样以 return 结尾，附加 return 不可达：加载结果即模块对象本身 */
	sandbox.Parse = parse.Parse || parse;
	const ws = loadLib('rpc.js');
	/* rpc.js 以 `return AtWsClass;` 结尾，附加的 return 不可达；extend 被 mock 成原样返回，
	 * 因此加载结果本身就是 AtWs 对象。 */
	sandbox.AtWs = (ws && ws.AtWs) || ws;
	const Parse = sandbox.Parse;
	const AtWs = sandbox.AtWs;

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

	/* ---- CHIPTEMP（手册 17.1.1/17.1.3：固定 12 字段、0.1℃、65535 为失败）---- */
	const temp = Parse.parseCHIPTEMP('^CHIPTEMP: 368,364,362,365,360,360,380,400,380,400,360,370\r\nOK');
	check('CHIPTEMP 手册例句 12 项全部对齐',
		temp && temp.sub3GPA === 36.8 && temp.sub6GPA === 36.4 && temp.mimoPa === 36.2 && temp.tcxo === 36.5 &&
		temp.peri1 === 36.0 && temp.peri2 === 36.0 && temp.ap1 === 38.0 && temp.ap2 === 40.0 &&
		temp.modem1 === 38.0 && temp.modem2 === 40.0 && temp.bbp1 === 36.0 && temp.bbp2 === 37.0,
		temp ? JSON.stringify(temp) : 'null');
	const tempFail = Parse.parseCHIPTEMP('^CHIPTEMP: 65535,364,65535,365,360,360,380,400,380,400,360,370\r\nOK');
	check('CHIPTEMP 65535（查询失败）归 null 而非 0.0℃',
		tempFail && tempFail.sub3GPA === null && tempFail.mimoPa === null && tempFail.sub6GPA === 36.4,
		tempFail ? JSON.stringify(tempFail) : 'null');
	check('parseTemperature 越界与空值归 null',
		Parse.parseTemperature('') === null && Parse.parseTemperature('1600') === null && Parse.parseTemperature(100) === 10,
		'ok');

	/* ---- MCS（手册 13.22.1/13.22.3/13.22.5：direction,rat,table,code0,code1[,…]）---- */
	const mcsUl = Parse.parseMCS('^MCS: 0,0,0,6,255\r\nOK');
	check('MCS LTE 上行：f1 是制式而非 rank',
		mcsUl && mcsUl.direction === 0 && mcsUl.entries.length === 1 && mcsUl.entries[0].rat === 'LTE' &&
		mcsUl.entries[0].carriers[0].mcs === 6,
		mcsUl ? JSON.stringify(mcsUl.entries[0]) : 'null');
	check('MCS code1=255 为非法值 -> 单码字',
		mcsUl && mcsUl.entries[0].carriers[0].mcs2 === null && Parse.mcsCodewords(mcsUl.entries[0]) === 1,
		mcsUl ? 'cw=' + Parse.mcsCodewords(mcsUl.entries[0]) : 'null');
	// 手册 EN-DC 例句：两行，LTE 在前、NR 在后且带 2 个载波组
	const mcsEndc = Parse.parseMCS('^MCS: 0,0,0,6,255\r\n^MCS: 0,1,1,6,5,2,6,4\r\nOK');
	const nrEntry = Parse.mcsEntry(mcsEndc, 'NR');
	check('MCS EN-DC 返回两行并按制式取组',
		mcsEndc && mcsEndc.entries.length === 2 && nrEntry && nrEntry.rat === 'NR' && nrEntry.carriers.length === 2,
		mcsEndc ? 'nr carriers=' + (nrEntry ? nrEntry.carriers.length : 0) : 'null');
	check('MCS 辅载波按 3 字段一组切分（table,code0,code1）',
		nrEntry && nrEntry.carriers[1].table === 2 && nrEntry.carriers[1].mcs === 6 && nrEntry.carriers[1].mcs2 === 4,
		nrEntry ? JSON.stringify(nrEntry.carriers[1]) : 'null');
	check('MCS 双码字识别（code1=5 合法 -> 2 码字）', Parse.mcsCodewords(nrEntry) === 2, 'cw=' + Parse.mcsCodewords(nrEntry));
	check('MCS -> 调制方式映射', Parse.mcsModulation(6) === 'QPSK' && Parse.mcsModulation(20) === '64QAM' && Parse.mcsModulation(27) === '256QAM' && Parse.mcsModulation(255) === null,
		'6/20/27/255');

	/* ---- TRANSMODE（手册 13.31：mode ∈ 1..6,8,9,10，无 TM7）---- */
	check('TRANSMODE 9 -> TM9', Parse.parseTransMode('^TRANSMODE: 9\r\nOK') === 'TM9', Parse.parseTransMode('^TRANSMODE: 9\r\nOK'));
	check('TRANSMODE 7（未定义）/ ERROR 应答 -> null',
		Parse.parseTransMode('^TRANSMODE: 7\r\nOK') === null && Parse.parseTransMode('ERROR') === null, 'null');

	/* ---- FOTA 状态机与下载进度（手册 15.4~15.7 + FOTA 升级指南）---- */
	check('FOTASTATE 13 带错误码', (() => {
		const s = Parse.parseFotaState('^FOTASTATE: 13,20');
		return s && s.state === 13 && s.errorCode === 20 && Parse.fotaErrorText(s.errorCode) === 'DNS 解析失败';
	})(), Parse.fotaStateMeta(13).text);
	check('FOTASTATE 12 解析版本号与包大小', (() => {
		const s = Parse.parseFotaState('^FOTASTATE: 12,"MC5700-CN-V1.2.3",1024,"desc"');
		return s && s.version === 'MC5700-CN-V1.2.3' && s.packetSize === 1024;
	})(), 'ok');
	// 《FOTA 升级指南》4.1.1 实机示例：12 的版本号**不带引号**，描述段一路到行尾
	check('FOTASTATE 12 指南形态（版本号不带引号）', (() => {
		const s = Parse.parseFotaState('^FOTASTATE: 12,V100R001C00B002,6129664,1.product_name="MT5700M-CN";2.update_mode="0";3.source_version="V100R001C00B002";en-us');
		return s && s.state === 12 && s.version === 'V100R001C00B002' && s.packetSize === 6129664;
	})(), 'ok');
	check('FOTASTATE 13 指南双错误码形态（13,13 / 13,51）', (() => {
		const a = Parse.parseFotaState('^FOTASTATE: 13,13');
		const b = Parse.parseFotaState('^FOTASTATE: 13,51');
		return a && a.state === 13 && a.errorCode === 13 && b && b.errorCode === 51;
	})(), 'ok');
	// 指南 4.1.1/§5：发起 FOTA 前用 +CEREG? 确认注册（1 本网 / 5 漫游）
	check('CEREG 注册状态解析（指南 4.1.1 示例）', (() => {
		const ok = Parse.parseCeregStat('+CEREG: 2,1,"102F","002D811F",7');
		const roaming = Parse.parseCeregStat('+CEREG: 0,5');
		const searching = Parse.parseCeregStat('+CEREG: 0,2');
		const bad = Parse.parseCeregStat('OK');
		return ok === 1 && roaming === 5 && searching === 2 && bad === null;
	})(), 'ok');
	check('FOTA 状态 70 = 升级失败、50 = 准备升级',
		Parse.fotaStateMeta(70).text === '升级失败' && Parse.fotaStateMeta(50).text === '准备升级', 'ok');
	check('FOTA 仅在 30/31/40 可取消（AT^FOTADL=0）',
		Parse.isFotaCancellable(30) && Parse.isFotaCancellable(31) && Parse.isFotaCancellable(40) &&
		!Parse.isFotaCancellable(10) && !Parse.isFotaCancellable(50), 'ok');
	// 手册 15.6.1：dl_size 在前、file_size 在后；顺序读反会恒为 100%
	const dlq = Parse.parseFotaDlq('^FOTADLQ: 1,"FIRMWARE1",524288,1048576\r\nOK');
	check('FOTADLQ 已下载/总字节顺序与百分比',
		dlq && dlq.files.length === 1 && dlq.files[0].type === 'FIRMWARE1' &&
		dlq.downloaded === 524288 && dlq.total === 1048576 && dlq.percent === 50,
		dlq ? 'dl=' + dlq.downloaded + ' total=' + dlq.total + ' pct=' + dlq.percent : 'null');
	const dlqMulti = Parse.parseFotaDlq('^FOTADLQ: 1,"FIRMWARE1",100,200\r\n^FOTADLQ: 2,"FIRMWARE2",100,300\r\nOK');
	check('FOTADLQ 多行累计', dlqMulti && dlqMulti.files.length === 2 && dlqMulti.downloaded === 200 && dlqMulti.total === 500,
		dlqMulti ? dlqMulti.downloaded + '/' + dlqMulti.total : 'null');
	// 手册 15.7.3：URL 必须以 / 结尾、≤255 字节，指南 3.2 标注 HTTPS 暂未支持
	check('FOTA URL 自动补尾斜杠', Parse.normalizeFotaUrl('http://fota.example.com/pkg') === 'http://fota.example.com/pkg/', Parse.normalizeFotaUrl('http://fota.example.com/pkg'));
	check('FOTA URL 拒绝 https / 引号 / 空格 / 超长',
		Parse.normalizeFotaUrl('https://fota.example.com/pkg/') === null &&
		Parse.normalizeFotaUrl('http://a/"x\r\n') === null &&
		Parse.normalizeFotaUrl('http://a b/c/') === null &&
		Parse.normalizeFotaUrl('http://a/' + new Array(300).join('x') + '/') === null &&
		Parse.normalizeFotaUrl('') === null, 'ok');

	/* ---- AT^TDCFG 多行键值应答（手册 16.23.1 与 16.23.5 两处冒号口径不一致）---- */
	const tdFull = Parse.parseTdcfg('^TDCFG:\r\n' +
		'Mode : 2\r\n' +
		'Dmz : 192.168.224.102\r\n' +
		'PostRoute：1\r\n' +
		'LHCM: 192.168.10.1,255.255.255.0,192.168.10.100,192.168.10.200\r\n' +
		'Share-pdp：1\r\nOK');
	check('TDCFG 语法页形态（全角冒号 + 键名后空格）',
		tdFull.mode === 2 && tdFull.postRoute === 1 && tdFull.dmz.enabled === true &&
		tdFull.dmz.host === '192.168.224.102', JSON.stringify(tdFull));
	const tdEx = Parse.parseTdcfg('^TDCFG:\nMode: 1\nDmz: not cfg\nPostRoute: 0\n' +
		'LHCM: 192.168.1.1,255.255.255.0,192.168.1.100,192.168.1.200\nShare-pdp: 0\nOK');
	check('TDCFG 举例段形态（半角冒号）+ DMZ 未配置',
		tdEx.mode === 1 && tdEx.postRoute === 0 && tdEx.dmz.enabled === false && tdEx.dmz.host === '',
		JSON.stringify(tdEx));
	/* 16.23.3：<pr_value> 2=关闭后路由（0 是「未配置」缺省态），原样读回交给界面归两档 */
	const tdOff = Parse.parseTdcfg('Dmz : "192.168.8.8"\nPostRoute: 2\n');
	check('TDCFG 关闭态 2 与带引号 DMZ',
		tdOff.postRoute === 2 && tdOff.dmz.enabled === true && tdOff.dmz.host === '192.168.8.8',
		JSON.stringify(tdOff));
	const tdNone = Parse.parseTdcfg('ERROR');
	check('TDCFG 读不到键值时字段全 undefined（不得当成 0）',
		tdNone.mode === undefined && tdNone.postRoute === undefined && tdNone.dmz.enabled === false,
		JSON.stringify(tdNone));

	/* ---- rpc.js raw_data 拆分 REJINFO ---- */
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
