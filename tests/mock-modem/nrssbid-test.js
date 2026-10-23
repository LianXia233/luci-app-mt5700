'use strict';
/**
 * AT^NRSSBID? 解析单测（手册 13.28，PDF 第 378~381 页）
 * 样例全部来自内网测试机实机真实回包 + 手册 13.28.5 示例。
 * 运行：node nrssbid-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');

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
	const parse = loadLib('parse.js');
	sandbox.Parse = parse.Parse || parse;
	const ws = loadLib('rpc.js');
	const AtWs = (ws && ws.AtWs) || ws;

	/* ---- 实机真实回包（内网测试机，SA 驻网） ---- */
	const real = '^NRSSBID: 504990,0000000c2840c002,128,-64,24,-1,' +
		'1,-62,0,-63,2,-80,3,-81,4,-79,5,-78,6,-81,255,32767,' +
		'1,643,504990,-66,24,7,-62,6,-75,5,-77,4,-78\r\nOK';
	const r = AtWs.parseNRSSBID(real);

	check('parseNRSSBID 返回非 null', r !== null);
	check('服务小区 ARFCN', r.arfcn === 504990, 'arfcn=' + r.arfcn);
	check('服务小区 CID 原样保留', r.cid === '0000000c2840c002', 'cid=' + r.cid);
	check('服务小区 PCI', r.pci === 128, 'pci=' + r.pci);
	check('服务小区 RSRP / SINR', r.rsrp === -64 && r.sinr === 24, 'rsrp=' + r.rsrp + ' sinr=' + r.sinr);
	check('TA 无效值 -1 原样保留', r.ta === -1, 'ta=' + r.ta);

	check('beams 固定 8 个槽位', Array.isArray(r.beams) && r.beams.length === 8, 'len=' + (r.beams || []).length);
	/* 上报顺序是 1,0,2,3,... 必须按 ID 归位，而不是按出现顺序 */
	check('SSB 0 = -63（按 ID 归位，非出现顺序）', r.beams[0] === -63, 'beams[0]=' + r.beams[0]);
	check('SSB 1 = -62', r.beams[1] === -62, 'beams[1]=' + r.beams[1]);
	check('SSB 2 = -80', r.beams[2] === -80, 'beams[2]=' + r.beams[2]);
	check('SSB 6 = -81', r.beams[6] === -81, 'beams[6]=' + r.beams[6]);
	check('SSB 7 未上报 → null（不伪造 0）', r.beams[7] === null, 'beams[7]=' + r.beams[7]);

	check('邻区数量 = 1', r.neighbors.length === 1, 'count=' + r.neighbors.length);
	check('邻区 PCI / ARFCN / RSRP / SINR',
		r.neighbors[0].pci === 643 && r.neighbors[0].arfcn === 504990 &&
		r.neighbors[0].rsrp === -66 && r.neighbors[0].sinr === 24,
		'pci=' + r.neighbors[0].pci + ' rsrp=' + r.neighbors[0].rsrp + ' sinr=' + r.neighbors[0].sinr);
	check('邻区按 ID 归位：SSB 7 未出现在服务小区但出现在邻区',
		r.neighbors[0].beams[7] === -62, 'nb.beams[7]=' + r.neighbors[0].beams[7]);

	/* ---- 手册 13.28.5 的 SA 示例 ---- */
	const manual = '^NRSSBID=430010,00000001000000d5,110,-83,-10,-1,' +
		'1,-50,2,-60,255,32767,255,32767,255,32767,255,32767,255,32767,255,32767,' +
		'2,142,430040,-50,-15,3,-43,2,-55,4,-56,255,32767,' +
		'143,430036,-51,-16,4,-43,2,-55,1,-56,255,32767';
	/* 手册示例用的是 '=' 而非 ':'，extractATData 只认 ':' —— 统一按实机格式(冒号)校验 */
	const manualColon = manual.replace('^NRSSBID=', '^NRSSBID: ');
	const m = AtWs.parseNRSSBID(manualColon);
	check('手册样例：PCI=110 / RSRP=-83 / SINR=-10',
		m && m.pci === 110 && m.rsrp === -83 && m.sinr === -10,
		m ? 'pci=' + m.pci + ' rsrp=' + m.rsrp : 'null');
	check('手册样例：仅 SSB 1/2 有效，SSB 0 与 3~7 为 null',
		m && m.beams[0] === null && m.beams[1] === -50 && m.beams[2] === -60 && m.beams[3] === null,
		m ? 'b0=' + m.beams[0] + ' b1=' + m.beams[1] + ' b2=' + m.beams[2] + ' b3=' + m.beams[3] : 'null');
	check('手册样例：2 个邻区', m && m.neighbors.length === 2, m ? 'count=' + m.neighbors.length : 'null');

	/* ---- 全部无效的回包：网侧未配置测量的典型情况 ---- */
	const allInvalid = '^NRSSBID: 504990,0000000c2840c002,128,-64,24,-1,' +
		'255,32767,255,32767,255,32767,255,32767,255,32767,255,32767,255,32767,255,32767,0';
	const a = AtWs.parseNRSSBID(allInvalid);
	check('全部无效时 8 个波束均为 null', a && a.beams.every(function (v) { return v === null; }),
		a ? a.beams.join(',') : 'null');
	check('N_NB_CELL=0 时邻区为空数组', a && a.neighbors.length === 0, a ? 'count=' + a.neighbors.length : 'null');

	/* ---- 异常输入不得抛错 ---- */
	check('空数据返回 null', AtWs.parseNRSSBID('') === null);
	check('ERROR 回包返回 null', AtWs.parseNRSSBID('\r\nERROR\r\n') === null);
	check('字段不足时返回 null', AtWs.parseNRSSBID('^NRSSBID: 1,2,3') === null);
	check('undefined 输入返回 null', AtWs.parseNRSSBID(undefined) === null);

} catch (e) {
	check('测试执行未抛异常', false, String(e && e.stack || e));
}

const pass = results.filter(function (x) { return x.ok; }).length;
const fail = results.length - pass;
console.log('\n===== 结果: ' + pass + '/' + results.length + ' 通过' + (fail ? '，失败 ' + fail : '') + ' =====');
process.exit(fail ? 1 : 0);
