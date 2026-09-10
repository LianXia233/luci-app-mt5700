#!/usr/bin/env node
/**
 * e2e-test.js：对真实 Rust 后端做端到端链路验证。
 *
 * 链路：WS 客户端（等价 LuCI ws.js 行为）→ Rust 后端(8765) → mock 模组(TCP 20249)
 *
 * 验证项：
 *  1. 认证：错误密钥被拒；正确密钥通过
 *  2. 命令 FIFO：连续发多条命令，应答按序匹配
 *  3. AT+CONNECT? 伪命令
 *  4. AT+SCHED? 伪命令（UCI 状态回读）
 *  5. URC 推送：raw_data（模组周期 ^HCSQ）
 *  6. 心跳 ping→pong
 *  7. 未知命令错误处理
 *  8. cellscan 伪命令
 *
 * 用法：
 *   node e2e-test.js ws://127.0.0.1:8765 [authKey]
 */
'use strict';

const WebSocket = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:8765';
const AUTH_KEY = process.argv[3] || 'test-key-123';

const results = [];
function check(name, cond, detail) {
	results.push({ name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
	const ws = new WebSocket(url);
	const pending = [];
	const received = [];
	let wsClosed = false;

	ws.on('message', function (data) {
		const text = data.toString();
		received.push(text);
		if (text === 'ping') { ws.send('pong'); return; }
		const p = pending.shift();
		if (p) {
			let obj = null;
			try { obj = JSON.parse(text); } catch (e) { obj = null; }
			if (obj && typeof obj.success === 'boolean') {
				if (obj.success === true && obj.data !== undefined) {
					p.resolve({ success: true, data: obj.data });
				} else {
					p.resolve({ success: false, error: (obj && (obj.error || obj.message)) || text });
				}
			}
			// 非命令应答（type 推送等）不匹配命令，保持 FIFO 等待
		}
	});
	ws.on('error', function () { /* close 1006 等异常由 close 处理 */ });
	ws.on('close', function () { wsClosed = true; });

	function sendCommand(cmd) {
		return new Promise(function (resolve) {
			pending.push({ resolve: resolve });
			ws.send(cmd);
		});
	}

	function waitMessage(target, predicate, timeoutMs) {
		return new Promise(function (resolve) {
			const onMsg = function (data) {
				const text = data.toString();
				if (predicate(text)) {
					target.removeListener('message', onMsg);
					clearTimeout(timer);
					resolve(text);
				}
			};
			const timer = setTimeout(function () {
				target.removeListener('message', onMsg);
				resolve(null);
			}, timeoutMs);
			target.on('message', onMsg);
		});
	}

	/* 连接 */
	await new Promise(function (resolve, reject) {
		ws.on('open', resolve);
		const t = setTimeout(function () { reject(new Error('connect timeout')); }, 5000);
		ws.on('error', function () {});
		setTimeout(function () { clearTimeout(t); }, 0);
	});
	check('WS 连接建立', true);

	/* 1. 错误密钥被拒 */
	{
		ws.send(JSON.stringify({ auth_key: 'wrong-key' }));
		const msg = await waitMessage(ws, function (t) {
			let o = null;
			try { o = JSON.parse(t); } catch (e) { o = null; }
			return o && o.success === false || (o && o.error);
		}, 3000);
		if (msg === null) {
			check('错误密钥被拒', false, '未收到拒绝应答');
		} else {
			let o = JSON.parse(msg);
			check('错误密钥被拒', o.success === false || !!o.error, String(o.message || o.error));
		}
		await sleep(800);
		check('错误密钥被拒后连接关闭', wsClosed, 'wsClosed=' + wsClosed);
	}

	/* 2. 正确密钥认证（新连接） */
	let authed = false;
	{
		// 旧连接已关闭，重新建立
		const ws2 = new WebSocket(url);
		const pending2 = [];
		ws2.on('message', function (data) {
			const text = data.toString();
			if (text === 'ping') { ws2.send('pong'); return; }
			const p = pending2.shift();
			if (p) p.resolve(text);
		});
		ws2.on('error', function () {});
		await new Promise(function (resolve) { ws2.on('open', resolve); });
		ws2.send(JSON.stringify({ auth_key: AUTH_KEY }));
		const msg = await waitMessage(ws2, function (t) {
			let o = null;
			try { o = JSON.parse(t); } catch (e) { o = null; }
			return o && (o.success === true || o.success === false || o.error);
		}, 3000);
		let ok = false;
		if (msg) {
			const o = JSON.parse(msg);
			ok = o.success === true && o.message === '认证成功';
			check('正确密钥认证通过', ok, msg.slice(0, 60));
			authed = ok;
		} else {
			check('正确密钥认证通过', false, '认证超时');
		}

		/* 3. 命令 FIFO 顺序匹配 */
		if (authed) {
			const r1 = await new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('ATI'); });
			const r2 = await new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT+CGSN'); });
			const r3 = await new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT^HCSQ?'); });
			check('ATI 应答', r1.indexOf('MT5700M') >= 0, r1.slice(0, 40));
			check('AT+CGSN 应答（FIFO 顺序）', r2.indexOf('862234051234567') >= 0, r2.slice(0, 24));
			check('AT^HCSQ? 应答', r3.indexOf('^HCSQ') >= 0, r3.slice(0, 32));
		}

		/* 4. AT+CONNECT? 伪命令 */
		if (authed) {
			const r = await new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT+CONNECT?'); });
			check('AT+CONNECT? 伪命令', /\+CONNECT:\s*0/.test(r), r.replace(/\r/g, '\\r').slice(0, 30));
		}

		/* 5. AT+SCHED? 伪命令（UCI 回读） */
		if (authed) {
			const r = await new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT+SCHED?'); });
			check('AT+SCHED? 伪命令（UCI 回读）', r.indexOf('check_interval') >= 0 && r.indexOf('enabled') >= 0, r.slice(0, 70));
		}

		/* 6. 未知命令错误处理 */
		if (authed) {
			const r = await new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT+ZZZ'); });
			check('未知命令返回错误信息', /ERROR/.test(r), r.slice(0, 40));
		}

		/* 7. 心跳 ping→pong */
		if (authed) {
			ws2.send('ping');
			const msg2 = await waitMessage(ws2, function (t) { return t === 'pong'; }, 3000);
			check('心跳 ping→pong', msg2 === 'pong', msg2 === null ? '未收到 pong' : '');
		}

		/* 8. 结构化 URC 推送：来电 incoming_call（命令触发，等 10s） */
		if (authed) {
			const p = new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT+TESTPUSH=1'); });
			const r = await p;
			check('触发命令 AT+TESTPUSH=1 应答', r.indexOf('OK') >= 0, r.slice(0, 30));
			const push = await waitMessage(ws2, function (t) {
				let o = null;
				try { o = JSON.parse(t); } catch (e) { o = null; }
				return o && o.type === 'incoming_call' && o.data;
			}, 10000);
			let detail = '超时未收到 incoming_call 推送';
			let ok = false;
			if (push) {
				const o = JSON.parse(push);
				detail = o.data.number + ' state=' + o.data.state;
				ok = o.data.number === '+8613800138000' && o.data.state === 'ringing';
			}
			check('incoming_call 结构化推送', ok, detail);
		}

		/* 8b. 结构化 URC 推送：新短信 new_sms */
		if (authed) {
			const p = new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT+TESTPUSH=2'); });
			const r = await p;
			check('触发命令 AT+TESTPUSH=2 应答', r.indexOf('OK') >= 0, r.slice(0, 30));
			const push = await waitMessage(ws2, function (t) {
				let o = null;
				try { o = JSON.parse(t); } catch (e) { o = null; }
				return o && o.type === 'new_sms' && o.data;
			}, 10000);
			let detail = '超时未收到 new_sms 推送';
			let ok = false;
			if (push) {
				const o = JSON.parse(push);
				detail = (o.data.sender || o.data.number || '?') + ' ' + String(o.data.content || '').slice(0, 20);
				ok = !!(o.data.sender || o.data.number);
			}
			check('new_sms 结构化推送', ok, detail);
		}

		/* 8c. 新移植命令应答：^MONSSC / ^CASCELLINFO / ^SIMSQ */
		if (authed) {
			const send = function (cmd) {
				return new Promise(function (res) { pending2.push({ resolve: res }); ws2.send(cmd); });
			};
			const monssc = await send('AT^MONSSC');
			check('AT^MONSSC 辅站应答', monssc.indexOf('^MONSSC') >= 0 && monssc.indexOf('NR') >= 0 && monssc.indexOf('2360') >= 0, monssc.replace(/\r/g, '\\r').slice(0, 40));
			const cascell = await send('AT^CASCELLINFO?');
			check('AT^CASCELLINFO? CA 应答', cascell.indexOf('^CASCELLINFO') >= 0 && cascell.indexOf('1750') >= 0, cascell.replace(/\r/g, '\\r').slice(0, 60));
			const simsq = await send('AT^SIMSQ?');
			check('AT^SIMSQ? 应答', simsq.indexOf('^SIMSQ') >= 0, simsq.replace(/\r/g, '\\r').slice(0, 30));
		}

		/* 8d. REJINFO 主动上报（后端 raw_data → 浏览器端解析为 REJINFO 类型） */
		if (authed) {
			const p = new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT+TESTPUSH=3'); });
			const r = await p;
			check('触发命令 AT+TESTPUSH=3 应答', r.indexOf('OK') >= 0, r.slice(0, 30));
			const push = await waitMessage(ws2, function (t) {
				let o = null;
				try { o = JSON.parse(t); } catch (e) { o = null; }
				// 后端空闲期 URC 原样推送为 raw_data；^REJINFO 由浏览器端 ws.js 二次解析
				return o && o.type === 'raw_data' && typeof o.data === 'string' && o.data.indexOf('^REJINFO') >= 0;
			}, 10000);
			let detail = '超时未收到 REJINFO 上报';
			let ok = false;
			if (push) {
				const o = JSON.parse(push);
				detail = o.data.replace(/\r/g, '\\r').slice(0, 70);
				ok = o.data.indexOf('^REJINFO:46000') >= 0;
			}
			check('REJINFO 网络拒绝原因原样推送', ok, detail);
			// 浏览器端解析（ws.js dispatchRawData → parseRejInfo）在单测中覆盖
		}

		/* 9. cellscan 伪命令 */
		if (authed) {
			const r = await new Promise(function (res) { pending2.push({ resolve: res }); ws2.send('AT^CELLSCAN=STATE'); });
			check('AT^CELLSCAN=STATE 伪命令', r.indexOf('^CELLSCAN') >= 0 && r.indexOf('OK') >= 0, r.replace(/\r/g, '\\r').slice(0, 40));
		}

		ws2.close();
	}

	check('测试套件完成', true);
	const fails = results.filter(r => !r.ok);
	console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
	if (fails.length) {
		fails.forEach(f => console.log('FAILED: ' + f.name + ' — ' + f.detail));
		process.exit(1);
	}
	process.exit(0);
}

main().catch(function (e) {
	check('e2e 异常', false, String(e && e.message));
	const fails = results.filter(r => !r.ok);
	console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
	process.exit(1);
});
