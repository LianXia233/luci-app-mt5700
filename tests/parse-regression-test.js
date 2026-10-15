'use strict';
/**
 * 解析层回归单测（node 环境模拟浏览器加载 rpc.js / parse.js）
 *
 * 覆盖两类回归：
 *   1) ^MONSC 物理小区 PCI 的进制判定（NR 十六进制 / LTE 十六进制 / 旧编码格式十进制），
 *      以及十六进制越界时回退十进制的保护；
 *   2) 载波/辅小区按频点匹配时空频点（dlFcn = ''）不再被 Number('') 当成 0，
 *      避免吞掉 arfcn=0 的辅小区或把主载波信号错配给空频点载波。
 *
 * 运行：node tests/parse-regression-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');

const sandbox = {
	window: {}, AtWs: undefined, Parse: undefined,
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
	return fn(sandbox.AtWs, sandbox.Parse, function () { return { appendChild: function () {} }; }, sandbox.L);
}

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

try {
	const rpcLib = loadLib('rpc.js');
	const AtWs = (rpcLib && rpcLib.AtWs) || rpcLib;
	const parseLib = loadLib('parse.js');
	const Parse = (parseLib && parseLib.Parse) || parseLib;

	/* ---------- 1. NR：PCI 为十六进制（手册 13.27.3，0~0x3EF） ---------- */
	{
		// 实机抓取：^MONSC: NR,460,00,504990,1,C2840C002,80,149002,-64,-10,25
		const d = AtWs.parseMONSC('^MONSC: NR,460,00,504990,1,C2840C002,80,149002,-64,-10,25\r\nOK');
		check('NR PCI 十六进制换算 (0x80 -> 128)', d && d.pci === 128, d ? 'pci=' + d.pci : 'null');
		check('NR 频点 ARFCN 与 TAC 不再错位', d && d.channel === '504990' && d.lac === '149002' && d.cid === 'C2840C002',
			d ? 'arfcn=' + d.channel + ' tac=' + d.lac + ' cid=' + d.cid : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: NR,460,00,504990,1,C2840C002,3EF,149002,-64,-10,25\r\nOK');
		check('NR PCI 取到上限 0x3EF -> 1007', d && d.pci === 1007, d ? 'pci=' + d.pci : 'null');
	}
	{
		// 十进制上报的 999：按 16 进制会变成 2457（越界），必须回退
		const d = AtWs.parseMONSC('^MONSC: NR,460,00,504990,1,C2840C002,999,149002,-64,-10,25\r\nOK');
		check('NR PCI 十六进制越界回退十进制', d && d.pci === 999, d ? 'pci=' + d.pci : 'null');
	}

	/* ---------- 2. LTE：PCI 同样为十六进制，但不得越出 0~503 ---------- */
	{
		// 手册实测样例：^MONSC: LTE,460,00,38400,D975244,8,24C8,-85,-10,-54
		const d = AtWs.parseMONSC('^MONSC: LTE,460,00,38400,D975244,8,24C8,-85,-10,-54\r\nOK');
		check('LTE PCI 十六进制保持 (0x8 -> 8)', d && d.pci === 8, d ? 'pci=' + d.pci : 'null');
		check('LTE 无 SINR 字段，由 HCSQ 兜底', d && d.sinr === null && d.rssi === -54, d ? 'sinr=' + d.sinr + ' rssi=' + d.rssi : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: LTE,460,00,38400,D975244,1F7,24C8,-85,-10,-54\r\nOK');
		check('LTE PCI 上限 0x1F7 -> 503', d && d.pci === 503, d ? 'pci=' + d.pci : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: LTE,460,00,38400,D975244,500,24C8,-85,-10,-54\r\nOK');
		check('LTE PCI 十六进制越界 (0x500=1280) 回退十进制 500', d && d.pci === 500, d ? 'pci=' + d.pci : 'null');
	}

	/* ---------- 3. 旧编码格式 B（无前导制式）：PCI 为十进制 ---------- */
	{
		// <mcc>,<mnc>,<lac>,<cid>,<pci>,<ch>,<rsrp_raw>,<rsrq_raw>,<sinr_raw>,<sysmode>
		const d = AtWs.parseMONSC('^MONSC: 460,00,38400,D975244,120,1650,20,25,30,"LTE"\r\nOK');
		check('旧编码格式 PCI 按十进制解析 (120 而非 288)', d && d.pci === 120, d ? 'pci=' + d.pci : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: 460,00,504990,C2840C002,80,504990,77,226,30,"NR"\r\nOK');
		check('旧编码格式标注 NR 时按十六进制 (0x80 -> 128)', d && d.pci === 128, d ? 'pci=' + d.pci : 'null');
	}

	/* ---------- 4. 载波与辅小区按频点匹配的空值健壮性 ---------- */
	{
		const nr = [{ arfcn: 0, pci: 11, rsrp: -80, rsrq: -11, sinr: 10, measType: 'SSB' }];
		const orphan = Parse.unmatchedSecondaries([{ dlFcn: '' }], nr, []);
		check('空频点载波不再吞掉 arfcn=0 的辅小区', orphan.nr.length === 1, 'len=' + orphan.nr.length);
	}
	{
		const sig = Parse.carrierSignalFor({ sysMode: 'NR', dlFcn: '' }, [{ arfcn: 0, pci: 11 }], []);
		check('空频点载波不参与信号匹配 (返回 null)', sig === null, sig ? 'pci=' + sig.pci : 'null');
	}
	{
		const nr = [{ arfcn: 513000, pci: 134, rsrp: -70, rsrq: -10, sinr: 15, measType: 'SSB' }];
		const orphan = Parse.unmatchedSecondaries([{ dlFcn: '513000' }], nr, []);
		check('同频点辅小区仍按已匹配处理 (不重复入列)', orphan.nr.length === 0, 'len=' + orphan.nr.length);
	}
	{
		const sig = Parse.carrierSignalFor({ sysMode: 'NR', dlFcn: '513000' }, [{ arfcn: 513000, pci: 134, rsrp: -70 }], []);
		check('正常频点匹配不受影响', sig && sig.pci === 134 && sig.rsrp === -70, sig ? 'pci=' + sig.pci : 'null');
	}
	{
		const orphan = Parse.unmatchedSecondaries(null, null, null);
		check('空输入不抛异常', orphan && orphan.nr.length === 0 && orphan.lte.length === 0, 'ok');
	}

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
