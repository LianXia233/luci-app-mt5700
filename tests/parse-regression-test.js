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

	/* ---------- 1. NR：PCI 为十六进制（手册 13.9.3，0~0x3EF） ---------- */
	{
		// 实机抓取：^MONSC: NR,460,00,501234,1,C1A2B3C,80,12345,-64,-10,25
		const d = AtWs.parseMONSC('^MONSC: NR,460,00,501234,1,C1A2B3C,80,12345,-64,-10,25\r\nOK');
		check('NR PCI 十六进制换算 (0x80 -> 128)', d && d.pci === 128, d ? 'pci=' + d.pci : 'null');
		check('NR 频点 ARFCN 与 TAC 不再错位', d && d.channel === '501234' && d.lac === '12345' && d.cid === 'C1A2B3C',
			d ? 'arfcn=' + d.channel + ' tac=' + d.lac + ' cid=' + d.cid : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: NR,460,00,501234,1,C1A2B3C,3EF,12345,-64,-10,25\r\nOK');
		check('NR PCI 取到上限 0x3EF -> 1007', d && d.pci === 1007, d ? 'pci=' + d.pci : 'null');
	}
	{
		// 十进制上报的 999：按 16 进制会变成 2457（越界），必须回退
		const d = AtWs.parseMONSC('^MONSC: NR,460,00,501234,1,C1A2B3C,999,12345,-64,-10,25\r\nOK');
		check('NR PCI 十六进制越界回退十进制', d && d.pci === 999, d ? 'pci=' + d.pci : 'null');
	}

	/* ---------- 2. LTE：p[3]=ARFCN(十进制)、p[6]=TAC(hex)，PCI 十六进制不越 0~503 ---------- */
	{
		// 手册 13.9.5 例句：^MONSC: LTE,460,01,1650,A54933,1F3,183D,-98,-5,-72
		const d = AtWs.parseMONSC('^MONSC: LTE,460,01,1650,A54933,1F3,183D,-98,-5,-72\r\nOK');
		check('LTE 频点取 p[3]（1650 = B3 EARFCN），TAC 取 p[6]',
			d && d.channel === '1650' && d.lac === '183D',
			d ? 'channel=' + d.channel + ' lac=' + d.lac : 'null');
		check('LTE cid/pci/rsrp/rsrq/rssi 按手册 13.9.3 顺序',
			d && d.cid === 'A54933' && d.pci === 0x1F3 && d.rsrp === -98 && d.rsrq === -5 && d.rssi === -72,
			d ? 'cid=' + d.cid + ' pci=' + d.pci + ' rsrp=' + d.rsrp + ' rsrq=' + d.rsrq + ' rssi=' + d.rssi : 'null');
	}
	{
		// 实机样例：ARFCN 38400（B41）/ TAC 24C8，PCI=8
		const d = AtWs.parseMONSC('^MONSC: LTE,460,00,38400,D975244,8,24C8,-85,-10,-54\r\nOK');
		check('LTE PCI 十六进制保持 (0x8 -> 8)', d && d.pci === 8, d ? 'pci=' + d.pci : 'null');
		check('LTE ARFCN 与 TAC 不再互换', d && d.channel === '38400' && d.lac === '24C8',
			d ? 'channel=' + d.channel + ' lac=' + d.lac : 'null');
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

	/* ---------- 2b. NR <SCS> 与无效值哨兵、NONE 无服务 ---------- */
	{
		// 手册 13.9.5 例句：^MONSC: NR,460,01,1650,1,AB12345678,1F3,1234AB,-80,-10,32
		const d = AtWs.parseMONSC('^MONSC: NR,460,01,1650,1,AB12345678,1F3,1234AB,-80,-10,32\r\nOK');
		check('NR SCS 编码 1 -> 30kHz（手册 13.9.3）', d && d.scs === 1 && d.scsKHz === 30,
			d ? 'scs=' + d.scs + ' khz=' + d.scsKHz : 'null');
		check('NR 手册例句字段对齐', d && d.channel === '1650' && d.cid === 'AB12345678' && d.pci === 0x1F3 && d.lac === '1234AB',
			d ? 'ch=' + d.channel + ' cid=' + d.cid + ' pci=' + d.pci + ' tac=' + d.lac : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: NR,460,00,635558,2,C1A2B3C,80,12345,-1256,-348,-188\r\nOK');
		check('NR 无效值哨兵(-1256/-348/-188)归一为 null，不当成真实读数',
			d && d.rsrp === null && d.rsrq === null && d.sinr === null,
			d ? 'rsrp=' + d.rsrp + ' rsrq=' + d.rsrq + ' sinr=' + d.sinr : 'null');
		check('NR SCS 编码 2 -> 60kHz', d && d.scsKHz === 60, d ? 'khz=' + d.scsKHz : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: LTE,460,00,,D975244,8,24C8,-85,,\r\nOK');
		check('LTE 留空参数（手册：未获取到则留空）解析为空串/null 而非 0',
			d && d.channel === '' && d.rsrq === null && d.rssi === null,
			d ? 'channel=' + JSON.stringify(d && d.channel) + ' rsrq=' + d.rsrq + ' rssi=' + d.rssi : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: NONE\r\nOK');
		check('NONE（无服务，无小区参数）按读不到处理', d === null, JSON.stringify(d));
	}
	{
		// 手册 13.9.3 WCDMA：<MCC>,<MNC>,<ARFCN>,<PSC>,<Cell_ID>,<LAC>,<RSCP>,<RXLEV>,<EC/N0>
		const d = AtWs.parseMONSC('^MONSC: WCDMA,460,01,3925,120,1A2B3C,1234,-75,-70,-14,6,1\r\nOK');
		check('WCDMA 按手册布局：PSC 十进制在 p[4]，RSCP 在 p[7]',
			d && d.sysMode === 'WCDMA' && d.channel === '3925' && d.pci === 120 && d.lac === '1234' && d.rsrp === -75 && d.rssi === -70,
			d ? 'ch=' + d.channel + ' psc=' + d.pci + ' lac=' + d.lac + ' rscp=' + d.rsrp + ' rxlev=' + d.rssi : 'null');
	}

	/* ---------- 3. 旧编码格式 B（无前导制式）：PCI 为十进制 ---------- */
	{
		// <mcc>,<mnc>,<lac>,<cid>,<pci>,<ch>,<rsrp_raw>,<rsrq_raw>,<sinr_raw>,<sysmode>
		const d = AtWs.parseMONSC('^MONSC: 460,00,38400,D975244,120,1650,20,25,30,"LTE"\r\nOK');
		check('旧编码格式 PCI 按十进制解析 (120 而非 288)', d && d.pci === 120, d ? 'pci=' + d.pci : 'null');
	}
	{
		const d = AtWs.parseMONSC('^MONSC: 460,00,501234,C1A2B3C,80,501234,77,226,30,"NR"\r\nOK');
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

	/* ---------- 5. 发射功率：NR(AT^NTXPOWER?) 与 GUL(AT^TXPOWER?) ---------- */
	{
		// 实机抓取（NR 单载波）：^NTXPOWER: 22,-18,25,-18,2565000
		const nr = Parse.parseNrTxPower('^NTXPOWER: 22,-18,25,-18,2565000\r\nOK');
		check('NTXPOWER 单载波解析', nr.length === 1 && nr[0].pusch === 22 && nr[0].pucch === -18 &&
			nr[0].srs === 25 && nr[0].prach === -18 && nr[0].freq === 2565000,
			nr.length ? JSON.stringify(nr[0]) : 'empty');
	}
	{
		// 手册样例（NR 2CC）：^NTXPOWER: 23,3,23,22,8675,23,2,22,23,8677
		const nr = Parse.parseNrTxPower('^NTXPOWER: 23,3,23,22,8675,23,2,22,23,8677\r\nOK');
		check('NTXPOWER 多载波解析 (2CC)', nr.length === 2 && nr[1].pusch === 23 && nr[1].freq === 8677,
			'len=' + nr.length);
	}
	{
		const nr = Parse.parseNrTxPower('^NTXPOWER: 999,999,999,999,0\r\nOK');
		check('NTXPOWER 无效值 999 归 null、频点 0 归 null', nr.length === 1 && nr[0].pusch === null &&
			nr[0].pucch === null && nr[0].freq === null, JSON.stringify(nr[0]));
	}
	{
		const nr = Parse.parseNrTxPower('ERROR');
		check('NTXPOWER 无数据返回空数组（不抛异常）', Array.isArray(nr) && nr.length === 0, 'len=' + nr.length);
	}
	{
		// 手册样例（GUL/LTE）：^TXPOWER: 999,23,23,22,23
		const tx = Parse.parseTxPower('^TXPOWER: 999,23,23,22,23\r\nOK');
		check('TXPOWER (LTE) 解析且总功率 999 归 null', tx && tx.total === null && tx.pusch === 23 && tx.pucch === 23,
			tx ? JSON.stringify(tx) : 'null');
	}
	{
		const tx = Parse.parseTxPower('ERROR');
		check('TXPOWER 返回 ERROR 时为 null（NR 场景）', tx === null, String(tx));
	}
	{
		// 实机 AT+C5GQOSRDP=1 → +C5GQOSRDP: 1,6,,,,,102400,102400
		const nr = Parse.parseC5gQosRdp('+C5GQOSRDP: 1,6,,,,,102400,102400\r\nOK');
		check('C5GQOSRDP (5G) 取签约速率 Session-AMBR', nr && nr.cid === 1 && nr.qci === 6 &&
			nr.ambrUl === 102400 && nr.ambrDl === 102400, nr ? JSON.stringify(nr) : 'null');
		check('C5GQOSRDP (5G) 非 GBR 时 GFBR/MFBR 为空', nr && nr.gfbrUl === null && nr.mfbrDl === null,
			nr ? JSON.stringify(nr) : 'null');
	}
	{
		// 实机 4G 下同一命令 → +C5GQOSRDP: 1,0,,,,,, （5QI=0、速率全空）
		const lte = Parse.parseC5gQosRdp('+C5GQOSRDP: 1,0,,,,,,\r\nOK');
		check('C5GQOSRDP (4G) 速率字段为空，不能编造数值', lte && lte.ambrUl === null && lte.ambrDl === null,
			lte ? JSON.stringify(lte) : 'null');
	}
	{
		check('C5GQOSRDP 无匹配行返回 null', Parse.parseC5gQosRdp('ERROR') === null, 'not null');
	}
	{
		// 手册 16.17 AT^DSAMBR：5G 与 4G 实机均返回 5 个字段（cid,下行,上行,APN,状态）
		const nr = Parse.parseDsambr('^DSAMBR: 1,2000,3000,"cmiot5g",11\r\nOK');
		check('DSAMBR (5G) 解析签约速率', nr && nr.cid === 1 && nr.dlAmbr === 2000 && nr.ulAmbr === 3000,
			nr ? JSON.stringify(nr) : 'null');
		const lte = Parse.parseDsambr('^DSAMBR: 1,4000,5000,"CMIOT5G.MNC008.MCC460.GPRS",12\r\nOK');
		check('DSAMBR (4G) 解析签约速率', lte && lte.dlAmbr === 4000 && lte.ulAmbr === 5000 && lte.apn !== '',
			lte ? JSON.stringify(lte) : 'null');
		check('DSAMBR 速率为空时不编造', Parse.parseDsambr('^DSAMBR: 1,,\r\nOK').dlAmbr === null, 'not null');
		check('DSAMBR 无匹配行返回 null', Parse.parseDsambr('ERROR') === null, 'not null');
	}

	/* ---------- 9. 定时锁频：ARFCN / PCI 取 0 时不能被当成空值（PR #29 Codex P2） ---------- */
	{
		// LTE band 1 的最低 EARFCN 就是 0，PCI 0 也是真实小区；
		// 旧实现写的是 `i.arfcn || ''`，0 被 falsy 判成空 → 提示「必须为整数」保存不了。
		const lte = Parse.toLockLists('lte', 1, [{ band: 1, arfcn: 0 }]);
		check('锁频点 ARFCN=0 原样保留', lte.arfcns === '0', JSON.stringify(lte));
		const nr = Parse.toLockLists('nr', 2, [{ band: 78, arfcn: 0, scs: 0, pci: 0 }]);
		check('锁小区 ARFCN/SCS/PCI 取 0 均原样保留',
			nr.arfcns === '0' && nr.scs_types === '0' && nr.pcis === '0', JSON.stringify(nr));
		let threw = false;
		try { Parse.toLockLists('lte', 1, [{ band: 1, arfcn: '' }]); } catch (e) { threw = true; }
		check('ARFCN 真的留空时仍然报错', threw);
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
