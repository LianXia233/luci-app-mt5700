'use strict';
/**
 * HFREQINFO 同行多组载波解析 + 辅站信号缺失原因区分验收测试
 * （零依赖，node tests/hfreq-multicarrier-test.js）
 *
 * 覆盖 Issue #38：parseHFREQINFO 同行多组 NR 载波仅解析第一组
 * 覆盖 Issue #39：atStatusFromText 区分 AT 终止状态、computeSccSignalReason 区分 SCC 信号缺失原因
 * 覆盖 PR #41 Codex review 两条 P2：匹配到小区但测量全空也要给原因；非超时的传输失败不得记成 timeout
 */
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

	// ---- Issue #38: parseHFREQINFO 同行多组载波解析 ----
	var hfreq = AtWs.parseHFREQINFO;
	check('parseHFREQINFO 函数存在', typeof hfreq === 'function');

	// 1. 单组行（9 字段）→ 1 个载波
	var r1 = hfreq('^HFREQINFO: 0,7,41,513000,2565000,100000,513000,2565000,100000\nOK');
	check('单组行解析为 1 个载波', r1.length === 1, '实际 ' + r1.length);
	check('单组行 band 正确', r1[0] && r1[0].band === '41', r1[0] && r1[0].band);
	check('单组行 dlFcn 正确', r1[0] && r1[0].dlFcn === '513000', r1[0] && r1[0].dlFcn);
	check('单组行 dlFreqKHz 正确', r1[0] && r1[0].dlFreqKHz === 2565000, r1[0] && r1[0].dlFreqKHz);
	check('单组行 dlBwKHz 正确', r1[0] && r1[0].dlBwKHz === 100000, r1[0] && r1[0].dlBwKHz);
	check('单组行 n 保留原始值', r1[0] && r1[0].n === 0, r1[0] && r1[0].n);

	// 2. 两组行（16 字段，SA n78+n78）→ 2 个载波（Issue #38 核心修复）
	var r2 = hfreq('^HFREQINFO: 0,7,78,636664,3549960,100000,636664,3549960,100000,78,630000,3450000,100000,0,0,1400\nOK');
	check('同行两组载波解析为 2 个载波', r2.length === 2, '实际 ' + r2.length);
	check('第一组 band=78', r2[0] && r2[0].band === '78', r2[0] && r2[0].band);
	check('第一组 dlFcn=636664', r2[0] && r2[0].dlFcn === '636664', r2[0] && r2[0].dlFcn);
	check('第一组 dlFreqKHz=3549960', r2[0] && r2[0].dlFreqKHz === 3549960, r2[0] && r2[0].dlFreqKHz);
	check('第一组 dlBwKHz=100000', r2[0] && r2[0].dlBwKHz === 100000, r2[0] && r2[0].dlBwKHz);
	check('第二组 band=78', r2[1] && r2[1].band === '78', r2[1] && r2[1].band);
	check('第二组 dlFcn=630000', r2[1] && r2[1].dlFcn === '630000', r2[1] && r2[1].dlFcn);
	check('第二组 dlFreqKHz=3450000', r2[1] && r2[1].dlFreqKHz === 3450000, r2[1] && r2[1].dlFreqKHz);
	check('第二组 dlBwKHz=100000', r2[1] && r2[1].dlBwKHz === 100000, r2[1] && r2[1].dlBwKHz);
	check('两组共享 n 相同', r2[0] && r2[1] && r2[0].n === r2[1].n, r2[0] && r2[1] && r2[0].n + ' vs ' + r2[1].n);

	// 3. 多行单组 → 多个载波
	var r3 = hfreq('^HFREQINFO: 0,7,41,513000,2565000,100000,513000,2565000,100000\n^HFREQINFO: 1,7,78,636664,3549960,100000,636664,3549960,100000\nOK');
	check('多行单组解析为 2 个载波', r3.length === 2, '实际 ' + r3.length);
	check('多行单组第一行 band=41', r3[0] && r3[0].band === '41', r3[0] && r3[0].band);
	check('多行单组第二行 band=78', r3[1] && r3[1].band === '78', r3[1] && r3[1].band);

	// 4. 多行多组 → 全部载波
	var r4 = hfreq('^HFREQINFO: 0,7,78,636664,3549960,100000,636664,3549960,100000,78,630000,3450000,100000,0,0,1400\n^HFREQINFO: 1,7,41,513000,2565000,100000,513000,2565000,100000\nOK');
	check('多行多组解析为 3 个载波', r4.length === 3, '实际 ' + r4.length);
	check('多行多组第一行第1组 band=78', r4[0] && r4[0].band === '78', r4[0] && r4[0].band);
	check('多行多组第一行第2组 band=78', r4[1] && r4[1].band === '78', r4[1] && r4[1].band);
	check('多行多组第二行 band=41', r4[2] && r4[2].band === '41', r4[2] && r4[2].band);

	// 5. 不完整行（< 9 字段）→ 跳过
	var r5 = hfreq('^HFREQINFO: 0,7,41\nOK');
	check('不完整行（3 字段）跳过', r5.length === 0, '实际 ' + r5.length);

	// 6. 行长度不满足 (len-2) % 7 === 0 → 跳过
	var r6 = hfreq('^HFREQINFO: 0,7,41,513000,2565000,100000,513000,2565000\nOK');
	check('不完整行（8 字段，len-2=6 不整除 7）跳过', r6.length === 0, '实际 ' + r6.length);

	// 7. 三组行（23 字段）→ 3 个载波
	var r7 = hfreq('^HFREQINFO: 0,7,78,636664,3549960,100000,636664,3549960,100000,78,630000,3450000,100000,0,0,1400,78,620000,3350000,100000,0,0,1400\nOK');
	check('同行三组载波解析为 3 个载波', r7.length === 3, '实际 ' + r7.length);
	check('第三组 dlFcn=620000', r7[2] && r7[2].dlFcn === '620000', r7[2] && r7[2].dlFcn);

	// ---- Issue #39: atStatusFromText AT 终止状态检测 ----
	var atStatus = Parse.atStatusFromText;
	check('atStatusFromText 函数存在', typeof atStatus === 'function');

	check('atStatusFromText("ERROR") → error', atStatus('ERROR') === 'error', atStatus('ERROR'));
	check('atStatusFromText("^MONSSC: NONE\\nOK") → ok', atStatus('^MONSSC: NONE\nOK') === 'ok', atStatus('^MONSSC: NONE\nOK'));
	check('atStatusFromText("^MONSSC: NONE") → none', atStatus('^MONSSC: NONE') === 'none', atStatus('^MONSSC: NONE'));
	check('atStatusFromText("") → empty', atStatus('') === 'empty', atStatus(''));
	check('atStatusFromText(null) → empty', atStatus(null) === 'empty', atStatus(null));
	check('atStatusFromText("^HFREQINFO: 0,7,41,...") → other', atStatus('^HFREQINFO: 0,7,41,513000') === 'other', atStatus('^HFREQINFO: 0,7,41,513000'));

	// ---- Issue #39: computeSccSignalReason SCC 信号缺失原因 ----
	var netCode = fs.readFileSync(path.join(viewDir, 'network_status.js'), 'utf8');
	var startIdx = netCode.indexOf('function computeSccSignalReason');
	var endIdx = netCode.indexOf('function syncCarriers');
	if (startIdx < 0 || endIdx < 0) {
		check('computeSccSignalReason 可从源码提取', false, '源码定位失败');
	} else {
		var fnCode = netCode.slice(startIdx, endIdx) + '\nreturn computeSccSignalReason;';
		var computeReason = new Function(fnCode)();
		check('computeSccSignalReason 函数存在', typeof computeReason === 'function');

		// NR SCC：MONSSC AT ERROR → at-error
		check('MONSSC error → at-error', computeReason({ monssc: 'error', cascell: null }, { sysMode: 'NR' }) === 'at-error',
			computeReason({ monssc: 'error', cascell: null }, { sysMode: 'NR' }));

		// NR SCC：MONSSC OK 但无匹配 → no-measurement
		check('MONSSC ok 无匹配 → no-measurement', computeReason({ monssc: 'ok', cascell: null }, { sysMode: 'NR' }) === 'no-measurement',
			computeReason({ monssc: 'ok', cascell: null }, { sysMode: 'NR' }));

		// NR SCC：MONSSC NONE → no-measurement
		check('MONSSC none → no-measurement', computeReason({ monssc: 'none', cascell: null }, { sysMode: 'NR' }) === 'no-measurement',
			computeReason({ monssc: 'none', cascell: null }, { sysMode: 'NR' }));

		// NR SCC：MONSSC timeout → timeout
		check('MONSSC timeout → timeout', computeReason({ monssc: 'timeout', cascell: null }, { sysMode: 'NR' }) === 'timeout',
			computeReason({ monssc: 'timeout', cascell: null }, { sysMode: 'NR' }));

		// LTE SCC：CASCELLINFO AT ERROR → at-error
		check('CAScell error → at-error', computeReason({ monssc: null, cascell: 'error' }, { sysMode: 'LTE' }) === 'at-error',
			computeReason({ monssc: null, cascell: 'error' }, { sysMode: 'LTE' }));

		// LTE SCC：CASCELLINFO OK 但无匹配 → no-measurement
		check('CAScell ok 无匹配 → no-measurement', computeReason({ monssc: null, cascell: 'ok' }, { sysMode: 'LTE' }) === 'no-measurement',
			computeReason({ monssc: null, cascell: 'ok' }, { sysMode: 'LTE' }));

		// NR SCC：MONSSC OK 但有匹配信号 → null（不该走到这里）
		// 此场景由 sig 存在时跳过，这里验证 computeSccSignalReason 不产生错误
		check('NR SCC 正常状态 → no-measurement（兜底）', computeReason({ monssc: 'ok', cascell: null }, { sysMode: 'NR' }) === 'no-measurement',
			computeReason({ monssc: 'ok', cascell: null }, { sysMode: 'NR' }));
	}

	// ---- Issue #39: syncCarriers 为 SCC 添加 signalReason 字段 ----
	// 提取 syncCarriers 及其依赖
	var syncStart = netCode.indexOf('function getBandFromNrArfcn');
	var syncEnd = netCode.indexOf('function updateNetworkInfo');
	if (syncStart < 0 || syncEnd < 0) {
		check('syncCarriers 可从源码提取', false, '源码定位失败');
	} else {
		var syncCode = netCode.slice(syncStart, syncEnd);
		var syncFn = new Function('Parse', 'AtWs', syncCode + '\nreturn syncCarriers;');
		var syncCarriers = syncFn(Parse, AtWs);
		check('syncCarriers 函数存在', typeof syncCarriers === 'function');

		// 模拟 SCC 信号缺失场景：MONSSC NONE + CASCELLINFO ERROR
		// 构造 state 并调用 syncCarriers
		var mockState = {
			rawHfreq: [
				{ n: 0, sysMode: 'NR', band: '78', dlFcn: '636664', dlFreqKHz: 3549960, dlBwKHz: 100000, sysModeCode: '7' },
				{ n: 0, sysMode: 'NR', band: '78', dlFcn: '630000', dlFreqKHz: 3450000, dlBwKHz: 100000, sysModeCode: '7' }
			],
			secondaryNR: [],
			secondaryLTE: [],
			secondaryATStatus: { monssc: 'ok', cascell: 'error' },
			cell: { channel: '636664', pci: 128, rsrp: -64, rsrq: -10, sinr: 24, sysMode: 'NR', band: '78' },
			hfreqSuccess: true,
			secondarySuccess: true,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};

		// 用 Function 执行 syncCarriers，注入 state
		var syncExec = new Function('state', 'Parse', 'AtWs',
			'var cell = state.cell; var rawHfreq = state.rawHfreq; var secNR = state.secondaryNR; var secLTE = state.secondaryLTE;' +
			'var now = Date.now(); var stale = false;' +
			syncCode + '\n' +
			'syncCarriers(); return state.carriers;');
		var carriers = syncExec(mockState, Parse, AtWs);

		check('syncCarriers 产出 2 个载波', carriers.length === 2, '实际 ' + carriers.length);
		check('PCC 有信号读数', carriers[0] && carriers[0].rsrp === -64, carriers[0] && carriers[0].rsrp);
		check('SCC1 信号为 null（不复制 PCC）', carriers[1] && carriers[1].rsrp == null, carriers[1] && carriers[1].rsrp);
		check('SCC1 signalReason = no-measurement（MONSSC ok 无匹配）',
			carriers[1] && carriers[1].signalReason === 'no-measurement', carriers[1] && carriers[1].signalReason);

		// 模拟 MONSSC AT ERROR 场景
		var mockState2 = {
			rawHfreq: [
				{ n: 0, sysMode: 'NR', band: '78', dlFcn: '636664', dlFreqKHz: 3549960, dlBwKHz: 100000, sysModeCode: '7' },
				{ n: 0, sysMode: 'NR', band: '78', dlFcn: '630000', dlFreqKHz: 3450000, dlBwKHz: 100000, sysModeCode: '7' }
			],
			secondaryNR: [],
			secondaryLTE: [],
			secondaryATStatus: { monssc: 'error', cascell: 'error' },
			cell: { channel: '636664', pci: 128, rsrp: -64, rsrq: -10, sinr: 24, sysMode: 'NR', band: '78' },
			hfreqSuccess: true,
			secondarySuccess: true,
			caStatus: { state: 'pending', lastSuccessTime: 0 }
		};
		var carriers2 = syncExec(mockState2, Parse, AtWs);
		check('SCC1 signalReason = at-error（MONSSC error）',
			carriers2[1] && carriers2[1].signalReason === 'at-error', carriers2[1] && carriers2[1].signalReason);
	}

	// ---- PR #41 Codex review 跟进一：匹配到小区但测量全空也要给原因 ----
	// Parse.carrierSignalFor 只要 ARFCN 命中就返回对象，测量字段是原样拷贝的，
	// 模组上报了辅小区却没带测量时全是 null。原实现用 `if (!sig)` 判缺测，
	// 这条路径下 signalReason 留空，页面只剩一排「—」而无任何解释。
	var mockState3 = JSON.parse(JSON.stringify(mockState));
	mockState3.secondaryNR = [{ arfcn: '630000', pci: null, rsrp: null, rsrq: null, sinr: null, measType: null }];
	mockState3.secondaryATStatus = { monssc: 'ok', cascell: 'ok' };
	var carriers3 = syncExec(mockState3, Parse, AtWs);
	check('SCC1 匹配到小区但无读数 → rsrp 仍为 null（不伪造）', carriers3[1] && carriers3[1].rsrp == null, carriers3[1] && carriers3[1].rsrp);
	check('SCC1 匹配到小区但测量全空 → no-measurement（不再静默）',
		carriers3[1] && carriers3[1].signalReason === 'no-measurement', carriers3[1] && carriers3[1].signalReason);

	// 只有 PCI、没有任何信号读数，同样属于缺测
	var mockState4 = JSON.parse(JSON.stringify(mockState));
	mockState4.secondaryNR = [{ arfcn: '630000', pci: 300, rsrp: null, rsrq: null, sinr: null, measType: 'SSB' }];
	mockState4.secondaryATStatus = { monssc: 'ok', cascell: 'ok' };
	var carriers4 = syncExec(mockState4, Parse, AtWs);
	check('SCC1 仅 PCI 无信号读数 → no-measurement',
		carriers4[1] && carriers4[1].signalReason === 'no-measurement', carriers4[1] && carriers4[1].signalReason);

	// 有任一可用读数时不该给缺测说明
	var mockState5 = JSON.parse(JSON.stringify(mockState));
	mockState5.secondaryNR = [{ arfcn: '630000', pci: 300, rsrp: -71, rsrq: -9, sinr: 18, measType: 'SSB' }];
	mockState5.secondaryATStatus = { monssc: 'ok', cascell: 'ok' };
	var carriers5 = syncExec(mockState5, Parse, AtWs);
	check('SCC1 有 RSRP → signalReason 为 null', carriers5[1] && carriers5[1].signalReason === null, carriers5[1] && carriers5[1].signalReason);

	// RSSI 也算可用读数（LTE 侧 SINR 恒空，页面用 RSSI 兜底显示）
	var mockState5b = JSON.parse(JSON.stringify(mockState));
	mockState5b.secondaryLTE = [{ dlArfcn: '630000', pci: 300, rsrp: null, rsrq: null, rssi: -65 }];
	mockState5b.rawHfreq = [
		{ n: 0, sysMode: 'NR', band: '78', dlFcn: '636664', dlFreqKHz: 3549960, dlBwKHz: 100000, sysModeCode: '7' },
		{ n: 0, sysMode: 'LTE', band: '3', dlFcn: '630000', dlFreqKHz: 3450000, dlBwKHz: 100000, sysModeCode: '6' }
	];
	mockState5b.secondaryATStatus = { monssc: 'ok', cascell: 'ok' };
	var carriers5b = syncExec(mockState5b, Parse, AtWs);
	check('SCC1(LTE) 有 RSSI → 不标注缺测', carriers5b[1] && !carriers5b[1].signalReason, carriers5b[1] && carriers5b[1].signalReason);

	// 孤儿 SCC（HFREQINFO 未覆盖，仅 MONSSC/CASCELLINFO 上报）同样要补缺测原因
	var mockState6 = JSON.parse(JSON.stringify(mockState));
	mockState6.rawHfreq = [mockState6.rawHfreq[0]];
	mockState6.secondaryNR = [{ arfcn: '630000', pci: null, rsrp: null, rsrq: null, sinr: null, measType: null }];
	mockState6.secondaryATStatus = { monssc: 'ok', cascell: 'ok' };
	var carriers6 = syncExec(mockState6, Parse, AtWs);
	check('孤儿 NR 辅站无读数 → no-measurement',
		carriers6[1] && carriers6[1].signalReason === 'no-measurement', carriers6[1] && carriers6[1].signalReason);

	// ---- computeSccSignalReason 补齐的三种状态 ----
	check('MONSSC 尚未查询（null）→ not-queried',
		computeReason({ monssc: null, cascell: null }, { sysMode: 'NR' }) === 'not-queried',
		computeReason({ monssc: null, cascell: null }, { sysMode: 'NR' }));
	check('MONSSC unavailable（未连接/熔断）→ unavailable',
		computeReason({ monssc: 'unavailable', cascell: 'unavailable' }, { sysMode: 'NR' }) === 'unavailable',
		computeReason({ monssc: 'unavailable', cascell: 'unavailable' }, { sysMode: 'NR' }));
	check('非 NR/LTE 制式 → not-applicable',
		computeReason({ monssc: 'ok', cascell: 'ok' }, { sysMode: 'WCDMA' }) === 'not-applicable',
		computeReason({ monssc: 'ok', cascell: 'ok' }, { sysMode: 'WCDMA' }));
	check('sysMode 为空时按 NR 口径（与载波卡片一致）',
		computeReason({ monssc: 'ok', cascell: 'error' }, {}) === 'no-measurement',
		computeReason({ monssc: 'ok', cascell: 'error' }, {}));

	// ---- PR #41 Codex review 跟进二：保留非超时的传输失败原因 ----
	var arsStart = netCode.indexOf('function atStatusFromResult');
	var arsEnd = netCode.indexOf('function loadSecondary');
	if (arsStart < 0 || arsEnd < 0) {
		check('atStatusFromResult 可从源码提取', false, '源码定位失败');
	} else {
		var arsCode = netCode.slice(arsStart, arsEnd) + '\nreturn atStatusFromResult;';
		var atStatusFromResult = new Function('Parse', arsCode)(Parse);
		check('atStatusFromResult 函数存在', typeof atStatusFromResult === 'function');
		check('success:true + "^MONSSC: NONE\\nOK" → ok',
			atStatusFromResult({ success: true, data: '^MONSSC: NONE\nOK' }) === 'ok',
			atStatusFromResult({ success: true, data: '^MONSSC: NONE\nOK' }));
		check('success:true + ERROR → error',
			atStatusFromResult({ success: true, data: 'ERROR' }) === 'error',
			atStatusFromResult({ success: true, data: 'ERROR' }));
		check('cause:timeout → timeout',
			atStatusFromResult({ success: false, cause: 'timeout' }) === 'timeout',
			atStatusFromResult({ success: false, cause: 'timeout' }));
		check('cause:not-connected → unavailable（不再误报超时）',
			atStatusFromResult({ success: false, cause: 'not-connected' }) === 'unavailable',
			atStatusFromResult({ success: false, cause: 'not-connected' }));
		check('cause:circuit-open → unavailable（熔断秒回不是超时）',
			atStatusFromResult({ success: false, cause: 'circuit-open' }) === 'unavailable',
			atStatusFromResult({ success: false, cause: 'circuit-open' }));
		check('后端回其它错误 → error',
			atStatusFromResult({ success: false, cause: 'offline', error: 'Rust 后端未就绪' }) === 'error',
			atStatusFromResult({ success: false, cause: 'offline', error: 'Rust 后端未就绪' }));
		check('无 cause 的失败不当成超时',
			atStatusFromResult({ success: false }) === 'error', atStatusFromResult({ success: false }));
		check('空结果按 error 处理（不误报超时）', atStatusFromResult(null) === 'error', atStatusFromResult(null));
	}

} catch (e) {
	console.error('测试执行异常:', e);
	check('测试执行无异常', false, e.message);
}

var passed = results.filter(function (r) { return r.ok; }).length;
var failed = results.filter(function (r) { return !r.ok; }).length;
console.log('\n===== 结果: ' + passed + '/' + results.length + ' 通过 =====');
if (failed > 0) {
	console.log('失败项:');
	results.filter(function (r) { return !r.ok; }).forEach(function (r) {
		console.log('  - ' + r.name + ' (' + r.detail + ')');
	});
	process.exit(1);
}
