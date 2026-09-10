#!/usr/bin/env node
/**
 * e2e-test.js：对真实 Rust 后端做端到端链路验证（LuCI RPC 协议）。
 *
 * 链路：TCP newline-JSON 客户端（等价 rpcd ucode 插件 mt5700.uc 的转发行为）
 *       → Rust 后端(127.0.0.1:8765) → mock 模组(TCP 20249)
 *
 * 验证项：
 *  1. 认证：错误密钥被拒；正确密钥通过
 *  2. 命令应答：ATI / AT+CGSN / AT^HCSQ?（按 id 匹配）
 *  3. AT+CONNECT? 伪命令
 *  4. AT+SCHED? 伪命令（UCI 状态回读）
 *  5. 未知命令错误处理
 *  6. events 增量拉取（seq 对齐 + 事件结构）
 *  7. incoming_call / new_sms / REJINFO(raw_data) 事件（TESTPUSH 触发后轮询）
 *  8. 新移植命令：^MONSSC / ^CASCELLINFO / ^SIMSQ
 *  9. cellscan 伪命令
 *
 * 用法：node e2e-test.js [port] [authKey]
 */
'use strict';

const net = require('net');

const PORT = parseInt(process.argv[2], 10) || 8765;
const AUTH_KEY = process.argv[3] || 'test-key-123';

const results = [];
function check(name, cond, detail) {
	results.push({ name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
	/* ---- TCP newline-JSON 客户端 ---- */
	const sock = net.connect(PORT, '127.0.0.1');
	let buf = '';
	const pendings = new Map();
	let nextId = 1;
	let closed = false;

	sock.on('data', function (d) {
		buf += d.toString();
		let idx;
		while ((idx = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			let obj = null;
			try { obj = JSON.parse(line); } catch (e) { continue; }
			if (obj && obj.id !== undefined) {
				const key = String(obj.id);
				const p = pendings.get(key);
				if (p) {
					pendings.delete(key);
					clearTimeout(p.timer);
					p.resolve(obj);
				}
			}
		}
	});
	sock.on('close', function () { closed = true; });
	sock.on('error', function () { /* 由超时兜底 */ });

	function rpc(method, params, timeoutMs) {
		return new Promise(function (resolve) {
			const id = nextId++;
			const timer = setTimeout(function () {
				pendings.delete(String(id));
				resolve({ id: id, error: { code: -1, message: 'RPC 超时' } });
			}, timeoutMs || 10000);
			pendings.set(String(id), { resolve: resolve, timer: timer });
			sock.write(JSON.stringify({ id: id, method: method, params: params || {} }) + '\n');
		});
	}
	function at(cmd, key) {
		return rpc('at', { cmd: cmd, auth_key: (key !== undefined ? key : AUTH_KEY) });
	}
	function atResult(r) {
		if (r.error) return { success: false, error: r.error.message || 'RPC 错误' };
		return r.result || {};
	}

	/* 连接 */
	await new Promise(function (resolve, reject) {
		sock.on('connect', resolve);
		const t = setTimeout(function () { reject(new Error('connect timeout')); }, 5000);
		sock.on('error', function () {});
		setTimeout(function () { clearTimeout(t); }, 0);
	});
	check('RPC 连接建立 (127.0.0.1:' + PORT + ')', true);

	/* 1. 错误密钥被拒 */
	{
		const r = await at('ATI', 'wrong-key');
		const ok = !!(r.error && r.error.code === -32001);
		check('错误密钥被拒 (code=-32001)', ok, r.error ? String(r.error.code) : JSON.stringify(r.result));
	}

	/* 2. 正确密钥命令应答 */
	{
		const r1 = await at('ATI');
		check('ATI 应答', r1.result && r1.result.success && String(r1.result.data).indexOf('MT5700M') >= 0, String(r1.result && r1.result.data).slice(0, 40));
		const r2 = await at('AT+CGSN');
		check('AT+CGSN 应答', r2.result && r2.result.success && String(r2.result.data).indexOf('862234051234567') >= 0, String(r2.result && r2.result.data).slice(0, 24));
		const r3 = await at('AT^HCSQ?');
		check('AT^HCSQ? 应答', r3.result && r3.result.success && String(r3.result.data).indexOf('^HCSQ') >= 0, String(r3.result && r3.result.data).slice(0, 32));
	}

	/* 3. AT+CONNECT? 伪命令 */
	{
		const r = await at('AT+CONNECT?');
		const d = String(r.result && r.result.data);
		check('AT+CONNECT? 伪命令', /\+CONNECT:\s*0/.test(d), d.replace(/\r/g, '\\r').slice(0, 30));
	}

	/* 4. AT+SCHED? 伪命令（UCI 回读） */
	{
		const r = await at('AT+SCHED?');
		const d = String(r.result && r.result.data);
		check('AT+SCHED? 伪命令（UCI 回读）', d.indexOf('check_interval') >= 0 && d.indexOf('enabled') >= 0, d.slice(0, 70));
	}

	/* 5. 未知命令错误处理 */
	{
		const r = await at('AT+ZZZ');
		const d = String(r.result && r.result.data);
		const errDetail = String(r.result && r.result.error || '');
		check('未知命令返回错误信息', r.result && r.result.success === false && !!errDetail, errDetail || d.slice(0, 40));
	}

	/* 6. events 增量拉取（seq 对齐） */
	const sinceRef = { val: 0 };
	{
		const r = await rpc('events', { since: 0, auth_key: AUTH_KEY });
		const ok = !!(r.result && typeof r.result.seq === 'number' && Array.isArray(r.result.events));
		sinceRef.val = (r.result && r.result.seq) || 0;
		check('events 拉取结构 {seq,events}', ok, 'seq=' + sinceRef.val);
	}

	/* 7a. incoming_call 事件 */
	{
		const r = await at('AT+TESTPUSH=1');
		check('触发命令 AT+TESTPUSH=1 应答', String(r.result && r.result.data).indexOf('OK') >= 0, String(r.result && r.result.data).slice(0, 30));
		const ev = await waitEvent(sinceRef, function (e) { return e.type === 'incoming_call' && e.data; }, 10000);
		let detail = '超时未收到 incoming_call 事件';
		let ok = false;
		if (ev) {
			detail = ev.data.number + ' state=' + ev.data.state;
			ok = ev.data.number === '+8613800138000' && ev.data.state === 'ringing';
		}
		check('incoming_call 事件', ok, detail);
	}

	/* 7b. new_sms 事件 */
	{
		const r = await at('AT+TESTPUSH=2');
		check('触发命令 AT+TESTPUSH=2 应答', String(r.result && r.result.data).indexOf('OK') >= 0, String(r.result && r.result.data).slice(0, 30));
		const ev = await waitEvent(sinceRef, function (e) { return e.type === 'new_sms' && e.data; }, 10000);
		let detail = '超时未收到 new_sms 事件';
		let ok = false;
		if (ev) {
			detail = (ev.data.sender || ev.data.number || '?') + ' ' + String(ev.data.content || '').slice(0, 20);
			ok = !!(ev.data.sender || ev.data.number);
		}
		check('new_sms 事件', ok, detail);
	}

	/* 8. 新移植命令应答：^MONSSC / ^CASCELLINFO / ^SIMSQ */
	{
		const monssc = await at('AT^MONSSC');
		const md = String(monssc.result && monssc.result.data);
		check('AT^MONSSC 辅站应答', md.indexOf('^MONSSC') >= 0 && md.indexOf('NR') >= 0 && md.indexOf('2360') >= 0, md.replace(/\r/g, '\\r').slice(0, 40));
		const cascell = await at('AT^CASCELLINFO?');
		const cd = String(cascell.result && cascell.result.data);
		check('AT^CASCELLINFO? CA 应答', cd.indexOf('^CASCELLINFO') >= 0 && cd.indexOf('1750') >= 0, cd.replace(/\r/g, '\\r').slice(0, 60));
		const simsq = await at('AT^SIMSQ?');
		const sd = String(simsq.result && simsq.result.data);
		check('AT^SIMSQ? 应答', sd.indexOf('^SIMSQ') >= 0, sd.replace(/\r/g, '\\r').slice(0, 30));
	}

	/* 7c. REJINFO 主动上报（raw_data 事件） */
	{
		const r = await at('AT+TESTPUSH=3');
		check('触发命令 AT+TESTPUSH=3 应答', String(r.result && r.result.data).indexOf('OK') >= 0, String(r.result && r.result.data).slice(0, 30));
		const ev = await waitEvent(sinceRef, function (e) {
			return e.type === 'raw_data' && typeof e.data === 'string' && e.data.indexOf('^REJINFO') >= 0;
		}, 10000);
		let detail = '超时未收到 REJINFO 上报';
		let ok = false;
		if (ev) {
			detail = ev.data.replace(/\r/g, '\\r').slice(0, 70);
			ok = ev.data.indexOf('^REJINFO:46000') >= 0;
		}
		check('REJINFO 网络拒绝原因 raw_data 事件', ok, detail);
	}

	/* 9. cellscan 伪命令 */
	{
		const r = await at('AT^CELLSCAN=STATE');
		const d = String(r.result && r.result.data);
		check('AT^CELLSCAN=STATE 伪命令', d.indexOf('^CELLSCAN') >= 0 && d.indexOf('OK') >= 0, d.replace(/\r/g, '\\r').slice(0, 40));
	}

	sock.end();
	check('测试套件完成', true);

	const fails = results.filter(r => !r.ok);
	console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
	if (fails.length) {
		fails.forEach(f => console.log('FAILED: ' + f.name + ' — ' + f.detail));
		process.exit(1);
	}
	process.exit(0);

	/* 轮询 events，直到命中或超时 */
	function waitEvent(sinceRef, predicate, timeoutMs) {
		const start = Date.now();
		return new Promise(function (resolve) {
			(function poll() {
				if (Date.now() - start >= timeoutMs) { resolve(null); return; }
				rpc('events', { since: sinceRef.val, auth_key: AUTH_KEY }, 5000).then(function (r) {
					if (r.result) {
						sinceRef.val = typeof r.result.seq === 'number' ? r.result.seq : sinceRef.val;
						const events = Array.isArray(r.result.events) ? r.result.events : [];
						for (let i = 0; i < events.length; i++) {
							if (predicate(events[i])) { resolve(events[i]); return; }
						}
					}
					sleep(300).then(poll);
				}).catch(function () { sleep(300).then(poll); });
			})();
		});
	}
}

main().catch(function (e) {
	check('e2e 异常', false, String(e && e.message));
	const fails = results.filter(r => !r.ok);
	console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
	process.exit(1);
});
