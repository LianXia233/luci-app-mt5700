'use strict';
/**
 * ^HCSQ 解析单测（node 环境模拟浏览器加载 rpc.js）：
 * 锁定手册 13.5 的字段表 —— LTE 为 <rssi>,<rsrp>,<sinr>,<rsrq>，NR 为 <rsrp>,<sinr>,<rsrq>。
 * 运行：node hcsq-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');

const sandbox = {
	AtWs: undefined, Parse: undefined,
	L: {
		Class: { extend: function (o) { return o; } },
		view: { extend: function (o) { return o; } },
		rpc: { declare: function () { return function () { return Promise.resolve({}); }; } },
		uci: { load: function () { return Promise.resolve(); }, get: function () { return ''; } }
	}
};
sandbox.window = sandbox;

function loadLib(name) {
	const code = fs.readFileSync(path.join(libDir, name), 'utf8');
	const cleaned = code
		.split('\n')
		.filter(function (l) { return l.indexOf("'require ") !== 0; })
		.join('\n');
	const fn = new Function('AtWs', 'Parse', 'E', 'L', cleaned + '\n;return { AtWs: AtWs, Parse: Parse };');
	return fn(sandbox.AtWs, sandbox.Parse, function () { return { appendChild: function () { } }; }, sandbox.L);
}

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}
/* 浮点换算（0.2 / 0.5 dB 步进）会有二进制误差，统一按 1e-6 容差比较 */
function near(a, b) {
	if (a == null || b == null) return false;
	return Math.abs(a - b) < 1e-6;
}

try {
	const parse = loadLib('parse.js');
	sandbox.Parse = parse.Parse;
	/*
	 * rpc.js 以 `return AtWsClass;` 结尾，附加的 return 不可达；而 L.Class.extend
	 * 被 mock 成「原样返回入参」，所以加载结果本身就是 AtWs 对象。
	 */
	const ws = loadLib('rpc.js');
	const AtWs = (ws && ws.AtWs) || ws;

	/* ---- 4G（LTE）：^HCSQ: "LTE",45,34,106,19 ---- */
	const lte = AtWs.parseHCSQ('^HCSQ: "LTE",45,34,106,19\r\nOK');
	check('LTE 制式识别', lte && lte.networkMode === 'LTE', lte ? lte.networkMode : 'null');
	check('LTE RSSI = value1', near(lte.rssi, -76), 'rssi=' + lte.rssi);
	check('LTE RSRP = value2', near(lte.rsrp, -106), 'rsrp=' + lte.rsrp);
	check('LTE SINR = value3（修复点）', near(lte.sinr, 1.2), 'sinr=' + lte.sinr);
	check('LTE RSRQ = value4（修复点）', near(lte.rsrq, -10), 'rsrq=' + lte.rsrq);
	/* 回归护栏：SINR 绝不能再取到 RSRQ 的位置（19 → -16.2 dB） */
	check('LTE SINR 不再取到 RSRQ 字段', !near(lte.sinr, -16.2), 'sinr=' + lte.sinr);

	/* ---- LTE 只报 3 个数值（无 RSRQ）也要能出 SINR ---- */
	const lteShort = AtWs.parseHCSQ('^HCSQ: "LTE",45,34,106');
	check('LTE 短字段仍解析 SINR', lteShort && near(lteShort.sinr, 1.2) && lteShort.rsrq === null,
		'sinr=' + (lteShort && lteShort.sinr) + ' rsrq=' + (lteShort && lteShort.rsrq));

	/* ---- 5G（NR）：^HCSQ: "NR",76,241,31，行为保持不变 ---- */
	const nr = AtWs.parseHCSQ('^HCSQ: "NR",76,241,31\r\nOK');
	check('NR 制式识别', nr && nr.networkMode === 'NR', nr ? nr.networkMode : 'null');
	check('NR RSRP = value1', near(nr.rsrp, -64), 'rsrp=' + nr.rsrp);
	check('NR SINR = value2', near(nr.sinr, 28.2), 'sinr=' + nr.sinr);
	check('NR RSRQ = value3', near(nr.rsrq, -4), 'rsrq=' + nr.rsrq);
	check('NR 不产出 RSSI', nr.rssi === null, 'rssi=' + nr.rssi);

	/* ---- 255 = 未知或不可测，应返回 null 而不是换算成假值 ---- */
	const invalid = AtWs.parseHCSQ('^HCSQ: "LTE",45,255,255,19');
	check('LTE 255 视为无数据', invalid.rsrp === null && invalid.sinr === null && near(invalid.rsrq, -10),
		'rsrp=' + invalid.rsrp + ' sinr=' + invalid.sinr + ' rsrq=' + invalid.rsrq);
	const nrInvalid = AtWs.parseHCSQ('^HCSQ: "NR",255,241,31');
	check('NR 255 视为无数据', nrInvalid.rsrp === null && near(nrInvalid.sinr, 28.2), 'rsrp=' + nrInvalid.rsrp);

	/* ---- 3G（WCDMA）：^HCSQ: "WCDMA",30,30,58 ---- */
	const w = AtWs.parseHCSQ('^HCSQ: "WCDMA",30,30,58\r\nOK');
	check('WCDMA 三项', w && near(w.rssi, -91) && near(w.rscp, -91) && near(w.ecio, -3),
		w ? 'rssi=' + w.rssi + ' rscp=' + w.rscp + ' ecio=' + w.ecio : 'null');

	/* ---- 2G（GSM）：^HCSQ: "GSM",36,255（手册 13.5.5 举例） ---- */
	const g = AtWs.parseHCSQ('^HCSQ: "GSM",36,255\r\nOK');
	check('GSM RSSI', g && near(g.rssi, -85) && g.rsrp === null, g ? 'rssi=' + g.rssi : 'null');

	/* ---- 无服务 ---- */
	const none = AtWs.parseHCSQ('^HCSQ: "NOSERVICE"\r\nOK');
	check('NOSERVICE 不产出信号', none && none.networkMode === 'NOSERVICE' && none.rsrp === null && none.sinr === null,
		none ? none.networkMode : 'null');

	/* ---- 解析入口：带 OK 与 CR/LF 的完整应答 ---- */
	const viaRaw = AtWs.parseRawData('^HCSQ: "LTE",45,34,106,19\r\n');
	const hcsqRaw = viaRaw.filter(function (p) { return p.type === 'HCSQ'; });
	check('parseRawData 归入 HCSQ 类型', hcsqRaw.length === 1 && near(hcsqRaw[0].parsed.sinr, 1.2),
		hcsqRaw.length + ' 条');

	/* ---- 换算函数边界 ---- */
	check('convertSinr 边界', near(AtWs.convertSinr(0), -20) && near(AtWs.convertSinr(251), 30),
		AtWs.convertSinr(0) + ' / ' + AtWs.convertSinr(251));
	check('convertRsrq 边界', near(AtWs.convertRsrq(0), -19.5) && near(AtWs.convertRsrq(34), -3),
		AtWs.convertRsrq(0) + ' / ' + AtWs.convertRsrq(34));
	check('convertEcio 边界', near(AtWs.convertEcio(0), -32) && near(AtWs.convertEcio(65), 0),
		AtWs.convertEcio(0) + ' / ' + AtWs.convertEcio(65));
	check('convertSinr 无浮点尾差', String(AtWs.convertSinr(226)) === '25.2', String(AtWs.convertSinr(226)));

	/* ---- ^MONSC 的 LTE 布局（手册 13.9.3/13.9.5，实测样本）----
	 * LTE,<mcc>,<mnc>,<tac>,<cid>,<pci>,<arfcn>,<rsrp>,<rsrq>,<rssi>，无 SINR。
	 * 旧实现套 NR 布局会把 rsrp 取到 rsrq(-10)、rsrq 取到 rssi(-54)、cid 取到 PCI。
	 */
	const mLte = AtWs.parseMONSC('^MONSC: LTE,460,00,38400,D975244,8,24C8,-85,-10,-54');
	check('MONSC LTE 制式与 PCI(hex)', mLte && mLte.sysMode === 'LTE' && mLte.pci === 8,
		mLte ? 'sysMode=' + mLte.sysMode + ' pci=' + mLte.pci : 'null');
	check('MONSC LTE cid 不再取到 PCI', mLte.cid === 'D975244', 'cid=' + mLte.cid);
	check('MONSC LTE channel 不再取到 RSRP', mLte.channel === '24C8', 'channel=' + mLte.channel);
	check('MONSC LTE RSRP/RSRQ 按位取数', mLte.rsrp === -85 && mLte.rsrq === -10,
		'rsrp=' + mLte.rsrp + ' rsrq=' + mLte.rsrq);
	check('MONSC LTE 末位是 RSSI 且无 SINR', mLte.rssi === -54 && mLte.sinr === null,
		'rssi=' + mLte.rssi + ' sinr=' + mLte.sinr);
	/* NR 布局回归护栏：行为保持不变 */
	const mNr = AtWs.parseMONSC('^MONSC: NR,460,00,504990,1,C2840C002,80,149002,-65,-9,29');
	check('MONSC NR 布局不受影响', mNr.rsrp === -65 && mNr.rsrq === -9 && mNr.sinr === 29 && mNr.pci === 80,
		'rsrp=' + mNr.rsrp + ' sinr=' + mNr.sinr + ' pci=' + mNr.pci);
} catch (e) {
	check('单测执行', false, String((e && e.stack) || e));
}

const fails = results.filter(function (r) { return !r.ok; });
console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
if (fails.length) {
	fails.forEach(function (f) { console.log('FAILED: ' + f.name + ' — ' + f.detail); });
	process.exit(1);
}
process.exit(0);
