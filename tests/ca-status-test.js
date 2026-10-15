'use strict';

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');
const viewDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');

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

function loadLib(dir, name) {
	const code = fs.readFileSync(path.join(dir, name), 'utf8');
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
	const parse = loadLib(libDir, 'parse.js');
	const Parse = parse.Parse || parse;
	const ws = loadLib(libDir, 'rpc.js');
	const AtWs = (ws && ws.AtWs) || ws;

	// Extract helper functions from network_status.js
	const netCode = fs.readFileSync(path.join(viewDir, 'network_status.js'), 'utf8');
	
	// Create sandbox for syncCarriers test
	const fnCode = `
		${netCode.slice(netCode.indexOf('function getBandFromNrArfcn'), netCode.indexOf('function updateNetworkInfo'))}
		return {
			getBandFromNrArfcn: getBandFromNrArfcn,
			getBandFromLteArfcn: getBandFromLteArfcn,
			syncCarriers: syncCarriers
		};
	`;
	const helpersFn = new Function('Parse', 'AtWs', fnCode);

	// Case 1: Pure single carrier (1 PCC from HFREQINFO, no secondary cells)
	{
		const state = {
			rawHfreq: [{ n: 0, sysMode: 'NR', band: '41', dlFcn: '513000', dlFreqKHz: 2565000, dlBwKHz: 100000 }],
			secondaryNR: [],
			secondaryLTE: [],
			cell: { channel: '513000', pci: 128, rsrp: -64, rsrq: -10, sinr: 25, sysMode: 'NR' },
			hfreqSuccess: true,
			secondarySuccess: true,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};
		const env = new Function('state', 'Parse', 'AtWs', fnCode + '; return { syncCarriers: syncCarriers };')(state, Parse, AtWs);
		env.syncCarriers();
		check('单载波状态判定', state.caStatus.state === 'single', 'state=' + state.caStatus.state);
		check('单载波数量为 1', state.carriers.length === 1, 'len=' + state.carriers.length);
		check('主载波标记 PCC', state.carriers[0].isPcc === true && state.carriers[0].carrierRole === 'PCC', 'role=' + state.carriers[0].carrierRole);
		check('主载波信号指标精确对齐', state.carriers[0].rsrp === -64 && state.carriers[0].pci === 128, 'rsrp=' + state.carriers[0].rsrp);
	}

	// Case 2: 载波聚合激活 (HFREQINFO 2 载波 + MONSSC 辅载波对齐)
	{
		const state = {
			rawHfreq: [
				{ n: 0, sysMode: 'NR', band: '41', dlFcn: '513000', dlFreqKHz: 2565000, dlBwKHz: 100000 },
				{ n: 1, sysMode: 'NR', band: '41', dlFcn: '2360', dlFreqKHz: 2524950, dlBwKHz: 100000 }
			],
			secondaryNR: [
				{ arfcn: 2360, pci: 134, rsrp: -70, rsrq: -10, sinr: 15, measType: 'SSB' }
			],
			secondaryLTE: [],
			cell: { channel: '513000', pci: 128, rsrp: -64, rsrq: -10, sinr: 25, sysMode: 'NR' },
			hfreqSuccess: true,
			secondarySuccess: true,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};
		const env = new Function('state', 'Parse', 'AtWs', fnCode + '; return { syncCarriers: syncCarriers };')(state, Parse, AtWs);
		env.syncCarriers();
		check('CA 状态激活判定 (2CC)', state.caStatus.state === 'ca' && state.carriers.length === 2, 'state=' + state.caStatus.state + ' len=' + state.carriers.length);
		check('辅载波 SCC1 识别', state.carriers[1].isPcc === false && state.carriers[1].sccIndex === 1, 'sccIndex=' + state.carriers[1].sccIndex);
		check('辅载波信号与模组 AT 一致 (未冒充主载波)', state.carriers[1].rsrp === -70 && state.carriers[1].sinr === 15 && state.carriers[1].pci === 134,
			'rsrp=' + state.carriers[1].rsrp + ' sinr=' + state.carriers[1].sinr + ' pci=' + state.carriers[1].pci);
	}

	// Case 3: HFREQINFO 仅报单载波，但 MONSSC 报出独立 NR 辅载波（确保辅载波不丢）
	{
		const state = {
			rawHfreq: [
				{ n: 0, sysMode: 'NR', band: '41', dlFcn: '513000', dlFreqKHz: 2565000, dlBwKHz: 100000 }
			],
			secondaryNR: [
				{ arfcn: 501234, pci: 86, rsrp: -72, rsrq: -11, sinr: 18, measType: 'SSB' }
			],
			secondaryLTE: [],
			cell: { channel: '513000', pci: 128, rsrp: -64, rsrq: -10, sinr: 25, sysMode: 'NR' },
			hfreqSuccess: true,
			secondarySuccess: true,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};
		const env = new Function('state', 'Parse', 'AtWs', fnCode + '; return { syncCarriers: syncCarriers };')(state, Parse, AtWs);
		env.syncCarriers();
		check('未在 HFREQINFO 中但 MONSSC 已上报的 SCC 自动纳入聚合', state.caStatus.state === 'ca' && state.carriers.length === 2,
			'state=' + state.caStatus.state + ' count=' + state.carriers.length);
		check('未在 HFREQINFO 中的 SCC 频段与信号反推正确', state.carriers[1].band === '41' && state.carriers[1].pci === 86 && state.carriers[1].rsrp === -72,
			'band=' + state.carriers[1].band + ' pci=' + state.carriers[1].pci + ' rsrp=' + state.carriers[1].rsrp);
	}

	// Case 4: LTE CA (CASCELLINFO 辅小区聚合)
	{
		const state = {
			rawHfreq: [
				{ n: 0, sysMode: 'LTE', band: '3', dlFcn: '1650', dlFreqKHz: 1800000, dlBwKHz: 20000 }
			],
			secondaryNR: [],
			secondaryLTE: [
				{ index: 0, pci: 120, rssi: -75, rsrp: -95, rsrq: -12, band: 1, dlArfcn: 100, dlFreq: 2120, dlBandwidth: 20 }
			],
			cell: { channel: '1650', pci: 50, rsrp: -85, rsrq: -8, sinr: 12, sysMode: 'LTE' },
			hfreqSuccess: true,
			secondarySuccess: true,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};
		const env = new Function('state', 'Parse', 'AtWs', fnCode + '; return { syncCarriers: syncCarriers };')(state, Parse, AtWs);
		env.syncCarriers();
		check('LTE CA 辅载波聚合激活', state.caStatus.state === 'ca' && state.carriers.length === 2, 'state=' + state.caStatus.state);
		check('LTE SCC1 真实指标与带宽换算', state.carriers[1].band === '1' && state.carriers[1].dlBwKHz === 20000 && state.carriers[1].rsrp === -95 && state.carriers[1].rssi === -75,
			'band=' + state.carriers[1].band + ' bw=' + state.carriers[1].dlBwKHz + ' rsrp=' + state.carriers[1].rsrp);
	}

	// Case 5: 查询失败或数据过期保护（避免直接当作单载波）
	{
		const state = {
			rawHfreq: [],
			secondaryNR: [],
			secondaryLTE: [],
			cell: {},
			hfreqSuccess: false,
			secondarySuccess: false,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};
		const env = new Function('state', 'Parse', 'AtWs', fnCode + '; return { syncCarriers: syncCarriers };')(state, Parse, AtWs);
		env.syncCarriers();
		check('初次查询未就绪展示 pending (绝不假装单载波)', state.caStatus.state === 'pending', 'state=' + state.caStatus.state);

		state.caStatus.lastSuccessTime = Date.now() - 20000; // 20 秒前
		env.syncCarriers();
		check('数据过期 15 秒判定 expired (绝不假装单载波)', state.caStatus.state === 'expired', 'state=' + state.caStatus.state);
	}

	// Case 6: 主载波频点查询失败时，只有 1 个载波也不得判定为单载波
	{
		const state = {
			rawHfreq: [],
			secondaryNR: [],
			secondaryLTE: [],
			cell: { channel: '501234', pci: 128, rsrp: -64, rsrq: -10, sinr: 25, sysMode: 'NR' },
			hfreqSuccess: false,
			secondarySuccess: true,
			caStatus: { state: 'pending', lastSuccessTime: Date.now() - 2000 }
		};
		const env = new Function('state', 'Parse', 'AtWs', fnCode + '; return { syncCarriers: syncCarriers };')(state, Parse, AtWs);
		env.syncCarriers();
		check('主频点查询失败时判定 error (绝不假装单载波)', state.caStatus.state === 'error', 'state=' + state.caStatus.state);

		state.caStatus.lastSuccessTime = Date.now() - 20000;
		env.syncCarriers();
		check('主频点查询失败且数据过期判定 expired', state.caStatus.state === 'expired', 'state=' + state.caStatus.state);
	}

	// Case 7: 两次查询都成功但模组未上报任何载波 → 明确未驻网 (none)
	{
		const state = {
			rawHfreq: [],
			secondaryNR: [],
			secondaryLTE: [],
			cell: {},
			hfreqSuccess: true,
			secondarySuccess: true,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};
		const env = new Function('state', 'Parse', 'AtWs', fnCode + '; return { syncCarriers: syncCarriers };')(state, Parse, AtWs);
		env.syncCarriers();
		check('查询成功但无载波判定 none (未驻网，而非单载波)', state.caStatus.state === 'none', 'state=' + state.caStatus.state);
	}

	// Case 8: 尚未查询 (初值 null) 时不得被当成查询成功
	{
		const state = {
			rawHfreq: [],
			secondaryNR: [],
			secondaryLTE: [],
			cell: {},
			hfreqSuccess: null,
			secondarySuccess: null,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};
		const env = new Function('state', 'Parse', 'AtWs', fnCode + '; return { syncCarriers: syncCarriers };')(state, Parse, AtWs);
		env.syncCarriers();
		check('未查询状态 (null) 判定 pending 而非 none/single', state.caStatus.state === 'pending', 'state=' + state.caStatus.state);
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
