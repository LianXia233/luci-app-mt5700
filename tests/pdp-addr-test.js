'use strict';
/**
 * PDP 地址解析单测（AT+CGPADDR 双栈支持）
 *
 * 回归背景：实机 +CGPADDR 一行携带两个地址（IPv4 + 点分字节 IPv6），
 * 旧实现每行只取第一个地址，IPv6 被静默丢弃（页面 APN 信息显示 —）。
 *
 * 运行：node tests/pdp-addr-test.js
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
	const cleaned = code.split('\n').filter(function (l) { return l.indexOf("'require ") !== 0; }).join('\n');
	const fn = new Function('AtWs', 'Parse', 'E', 'L', cleaned + '\n;return { AtWs: AtWs, Parse: Parse };');
	return fn(sandbox.AtWs, sandbox.Parse, function () { return { appendChild: function () {} }; }, sandbox.L);
}

const parseLib = loadLib('parse.js');
const Parse = (parseLib && parseLib.Parse) || parseLib;

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

try {
	/* ---------- 1. 实机双栈样例 ---------- */
	{
		const live = '+CGPADDR: 1,"198.51.100.10","32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1"\r\nOK';
		const list = Parse.parseCgpaddr(live);
		check('双栈行解析出 2 条记录', list.length === 2, 'len=' + list.length);
		check('IPv4 地址正确', list[0] && list[0].address === '198.51.100.10' && list[0].family === 'IPv4',
			list[0] ? list[0].address + '/' + list[0].family : 'null');
		check('IPv6 被识别且转换为压缩冒号格式',
			list[1] && list[1].family === 'IPv6' && list[1].address === '2001:db8::1',
			list[1] ? list[1].address + '/' + list[1].family : 'null');
		check('两条记录 cid 相同', list[0] && list[1] && list[0].cid === 1 && list[1].cid === 1,
			list.map(function (a) { return a.cid; }).join(','));
	}

	/* ---------- 2. 单地址行（旧模组兼容） ---------- */
	{
		const list = Parse.parseCgpaddr('+CGPADDR: 1,"10.0.0.5"\r\nOK');
		check('单 IPv4 行解析 1 条', list.length === 1 && list[0].address === '10.0.0.5' && list[0].family === 'IPv4',
			list.length + ' ' + (list[0] ? list[0].address : ''));
	}
	{
		const list = Parse.parseCgpaddr('+CGPADDR: 2,"2001:db8::1"\r\nOK');
		check('标准冒号 IPv6 直接识别', list.length === 1 && list[0].family === 'IPv6' && list[0].address === '2001:db8::1',
			list.length + ' ' + (list[0] ? list[0].address : ''));
	}

	/* ---------- 3. 多 CID ---------- */
	{
		const list = Parse.parseCgpaddr('+CGPADDR: 1,"10.0.0.1"\r\n+CGPADDR: 5,"10.0.0.2"\r\nOK');
		check('多 CID 各解析 1 条', list.length === 2 && list[0].cid === 1 && list[1].cid === 5,
			list.map(function (a) { return a.cid + ':' + a.address; }).join(' '));
	}

	/* ---------- 4. 异常输入 ---------- */
	{
		check('无地址行不产出记录', Parse.parseCgpaddr('+CGPADDR: 1\r\nOK').length === 0, 'ok');
		check('空输入不抛异常', Parse.parseCgpaddr('').length === 0, 'ok');
		check('ERROR 文本不产出记录', Parse.parseCgpaddr('ERROR').length === 0, 'ok');
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
