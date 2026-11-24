'use strict';
/* FOTA 状态机冒烟测试：启动 mock 模组 TCP 服务，走完 指南 4.1.1 全流程
 * OEMDL → 11 → 12(不带引号版本) → 30(FOTADLQ 推进) → 40 → FWUP → 50，
 * 以及 31 挂起续传、非 IDLE 下发 OEMDL 撞 54、FWUP 在 30 被拒。
 * 注：端口用「先 bind 0 探测再复用」取空闲值 —— Windows 的 Hyper-V/WSL
 * 会保留大段动态端口（bind 报 EADDRINUSE 但 netstat 看不到占用者），
 * 写死高端口号在这类机器上必然失败。 */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

function freePort() {
	return new Promise(function (resolve, reject) {
		const probe = net.createServer();
		probe.listen(0, '0.0.0.0', function () {
			const port = probe.address().port;
			probe.close(function () { resolve(port); });
		});
		probe.on('error', reject);
	});
}

let PORT = 0;
let mock = null;
let mockLog = '';
function startMock() {
	mock = spawn(process.execPath, [path.join(__dirname, 'mock-modem.js'), String(PORT)], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	mock.stdout.on('data', function (d) { mockLog += d; });
	mock.stderr.on('data', function (d) { mockLog += d; });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

let sock, buf = '';
function connect() {
	return new Promise(function (resolve, reject) {
		sock = net.connect(PORT, '127.0.0.1', resolve);
		sock.on('error', reject);
		sock.on('data', function (d) { buf += d.toString('binary'); });
	});
}
function send(cmd) {
	buf = '';
	sock.write(cmd + '\r');
	return sleep(120).then(function () { return buf.replace(/\r/g, ''); });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
	if (cond) { pass++; console.log('PASS  ' + name + '  (' + (detail || '') + ')'); }
	else { fail++; console.log('FAIL  ' + name + '  (' + (detail || '') + ')'); }
}

async function main() {
	PORT = await freePort();
	startMock();
	await sleep(500);
	await connect();

	/* 初始 IDLE */
	check('初始状态 IDLE(10)', /FOTASTATE: 10/.test(await send('AT^FOTASTATE?')));
	/* 非 IDLE 前 OEMDL 正常接受 */
	check('FOTAMODE 设置', (await send('AT^FOTAMODE=0,1,0,1')).indexOf('OK') >= 0);
	check('OEMDL 在 IDLE 下发被接受', (await send('AT^FOTAOEMDL="http://192.168.57.231/fota/mt5700/"')).indexOf('OK') >= 0);
	/* 轮询推进 11 → 12(指南不带引号格式) */
	let saw11 = false, saw12 = '';
	for (let i = 0; i < 6; i++) {
		const r = await send('AT^FOTASTATE?');
		if (/FOTASTATE: 11/.test(r)) saw11 = true;
		const m = r.match(/FOTASTATE: 12,(V[0-9A-Z]+)/);
		if (m) { saw12 = m[1]; break; }
	}
	check('轮询经过 11（版本查询中）', saw11);
	check('推进到 12 且版本号不带引号（V100R001C00B002）', saw12 === 'V100R001C00B002', saw12);
	/* 非 IDLE 时再发 OEMDL 撞冲突态 54（指南/手册 15.5.3） */
	const midFlow = await send('AT^FOTAOEMDL="http://192.168.57.231/fota/mt5700/"');
	check('非 IDLE 再发 OEMDL 被拒（错误码 54）', /54/.test(midFlow), midFlow.trim());
	/* 推进到 30，FOTADLQ 前进 */
	let downloading = false;
	for (let i = 0; i < 6; i++) {
		const r = await send('AT^FOTASTATE?');
		if (/FOTASTATE: 30/.test(r)) { downloading = true; break; }
	}
	check('推进到 30（下载中）', downloading);
	const q1 = await send('AT^FOTADLQ');
	const q2 = await send('AT^FOTADLQ');
	check('FOTADLQ 返回进度且递增', /FOTADLQ: 1,"FIRMWARM1",\d+,\d+/.test(q1) && q1 !== q2, q2.trim());
	/* 挂起 31 → 续传回 30 */
	check('故障注入 SUSPEND → 31', (await send('AT^FOTAFAULT=SUSPEND')).indexOf('OK') >= 0 &&
		/31/.test(await send('AT^FOTASTATE?')));
	check('FOTADL=1 续传回 30', (await send('AT^FOTADL=1')).indexOf('OK') >= 0 &&
		/30/.test(await send('AT^FOTASTATE?')));
	/* FWUP 在 30 被拒（指南规范：仅 40 后） */
	check('FWUP 在 30 被拒', (await send('AT^FWUP')).indexOf('ERROR') >= 0);
	/* 下载到满 → 40 → FWUP → 50 */
	let done = false;
	for (let i = 0; i < 25; i++) {
		await send('AT^FOTADLQ');
		if (/40/.test(await send('AT^FOTASTATE?'))) { done = true; break; }
	}
	check('下载完成推进到 40', done);
	check('FWUP 在 40 被接受', (await send('AT^FWUP')).indexOf('OK') >= 0);
	check('FWUP 后进入 50', /50/.test(await send('AT^FOTASTATE?')));
	/* 取消：先回到 30（造一个进行中会话）——直接从 50 不允许 FOTADL=0 */
	const c50 = await send('AT^FOTADL=0');
	check('50 状态下 FOTADL=0 被拒', /ERROR|CME/.test(c50), c50.trim());

	console.log('\n===== FOTA 冒烟: ' + pass + '/' + (pass + fail) + ' 通过 =====');
	if (mock) mock.kill();
	process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
	console.error('SMOKE ERROR', e, '\n--- mock log ---\n' + mockLog.slice(-2000));
	if (mock) mock.kill();
	process.exit(1);
});
