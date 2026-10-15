'use strict';
/**
 * 数据通道 APN 选取单测
 *
 * 背景：实机 AT+CGDCONT? 会同时报出 IMS 专用承载（cid=5, APN "ims"）。
 * 旧逻辑「cid===1 或 apn 未取到就覆盖」在数据通道 APN 为空（核心网分配）时
 * 会被后面的 ims 顶掉，页面把 IMS 当成数据 APN 展示。
 *
 * 运行：node tests/apn-channel-test.js
 */

const fs = require('fs');
const path = require('path');

const viewDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');
const code = fs.readFileSync(path.join(viewDir, 'network_status.js'), 'utf8');

const start = code.indexOf('function isNonDataApn');
const end = code.indexOf('/* 设备与 SIM 卡信息读取');
if (start < 0 || end < 0) {
	console.log('FAIL  未能在 network_status.js 中定位 APN 选取函数');
	process.exit(1);
}

const factory = new Function('state', code.slice(start, end) + '\n;return { isNonDataApn: isNonDataApn, pickDataContext: pickDataContext };');
const env = factory({});

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

/* 实机抓取：含 cid=5 的 IMS 专用承载，数据通道 cid=1 的 APN 为空 */
const LIVE = [
	'+CGDCONT: 0,"IPV4V6","","",0,0,0,0,0,0,1,,,,,,0,,0,0,0,0',
	'+CGDCONT: 1,"IPV4V6","","",0,0,0,0,0,0,1,,,,,,0,,0,0,0,0',
	'+CGDCONT: 5,"IPV4V6","ims","",0,0,0,0,1,1,1,,,,,,0,,0,0,0,0',
	'+CGDCONT: 6,"IPV4V6","","",0,0,0,1,1,1,1,,,,,,0,,0,0,0,0',
	'+CGDCONT: 8,"IPV4V6","","",0,0,0,0,0,0,1,,,,,,0,,0,0,0,0',
	'OK'
].join('\r\n');

try {
	// 1. IMS 识别
	check('ims 被判定为非数据承载', env.isNonDataApn('ims') === true, 'ims');
	check('IMS 完整域名形态被判定为非数据承载',
		env.isNonDataApn('ims.mnc000.mcc460.3gppnetwork.org') === true, 'domain');
	check('普通数据 APN 不被误判', env.isNonDataApn('cmnet') === false && env.isNonDataApn('cmiot5g') === false, 'cmnet/cmiot5g');
	check('空 APN 不被判为非数据承载', env.isNonDataApn('') === false, 'empty');

	// 2. 实机响应：必须选到 CID 1 的数据通道，而不是 ims
	{
		const r = env.pickDataContext(LIVE);
		check('数据通道锁定 CID 1', r.data && r.data.cid === '1', r.data ? 'cid=' + r.data.cid : 'null');
		check('数据通道 APN 为空（核心网分配）而非 ims', r.data && r.data.apn === '', r.data ? 'apn="' + r.data.apn + '"' : 'null');
		check('IMS 承载被单独记录且不影响数据通道', r.imsApn === 'ims', 'imsApn=' + r.imsApn);
		check('协议类型取数据通道的 IPV4V6', r.data && r.data.ptype === 'IPV4V6', r.data ? r.data.ptype : 'null');
	}

	// 3. 数据通道带显式 APN 时正常取到
	{
		const txt = '+CGDCONT: 1,"IP","cmnet","",0,0\r\n+CGDCONT: 5,"IPV4V6","ims","",0,0\r\nOK';
		const r = env.pickDataContext(txt);
		check('显式 APN 正常取到', r.data && r.data.apn === 'cmnet' && r.data.cid === '1', r.data ? r.data.apn : 'null');
	}

	// 4. 没有 CID 1 时回落到第一条非 IMS 上下文
	{
		const txt = '+CGDCONT: 3,"IPV4V6","3gnet","",0,0\r\n+CGDCONT: 5,"IPV4V6","ims","",0,0\r\nOK';
		const r = env.pickDataContext(txt);
		check('无 CID 1 时回落第一条非 IMS 上下文', r.data && r.data.cid === '3' && r.data.apn === '3gnet', r.data ? r.data.cid + '/' + r.data.apn : 'null');
	}

	// 5. 全是专用承载时不产出数据通道（页面回落「默认 (核心网自动分配)」）
	{
		const txt = '+CGDCONT: 5,"IPV4V6","ims","",0,0\r\n+CGDCONT: 6,"IPV4V6","sos","",0,0\r\nOK';
		const r = env.pickDataContext(txt);
		check('仅含专用承载时不产出数据 APN', r.data === null, r.data ? JSON.stringify(r.data) : 'null');
	}

	// 6. 异常输入不抛错
	{
		const r = env.pickDataContext(null);
		check('空输入不抛异常', r && r.data === null && r.imsApn === '', 'ok');
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
