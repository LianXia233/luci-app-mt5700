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
 * 10. 短信业务动作（5b 裸 AT 拼法 + 5c send/power/purge 全链路，含故障注入与射频回滚）
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

	/* 5b. 短信提交形态（手册 9.14.1／9.14.5 + 实机对照；issue #19 回归）
	 *
	 * 这台模组认的是**一次性形态**，分隔符是字面的 `\r`（反斜杠 + 字母 r 两个字符）：
	 *   `AT+CMGS=<长度>` + 字面 `\r` + <PDU> → 立即 `+CMGS: <mr>` + `OK`，
	 *   全程没有 `> ` 输入提示符，也不需要 Ctrl+Z。手册 9.14.5 的举例就是这个写法，
	 *   并注明「使用 SSCOM 工具时对应的 "\r" 应改为 "\\r"」—— 串口上发的确实是
	 *   反斜杠加字母 r。业务路径（sms::send）与厂商 WebUI 都走这一种。
	 * 其余几种形态一并钉住，它们覆盖了「显示成功但发不出去」的每个来源：
	 *   两段式（只报长度 → 提示符 → PDU+Ctrl+Z）仍是合法退路，但**提示符本身不是回执**；
	 *   零长度、长度与 PDU 字节数不符 → 模组直接 ERROR；
	 *   长度 + 真 CR + PDU + CR 一次写完 → 实机只回显命令然后静默（见文件末尾第 12 项）。
	 */
	{
		/* 手册 9.14.5 的原始举例：整条 PDU 18 字节，SMSC 字段 1 字节（00 = 用模组
		 * 自己存的中心号）+ TPDU 17 字节，所以 <length> 是 17（9.14.3：长度不含
		 * SMSC 字段）。长度一律由 PDU 算出来，不再手写 —— 旧夹具写的 21 字节
		 * 其实只有 19.5 字节，两段式路径不校验长度，所以一直没暴露。 */
		const pdu = '0015660B3108108300F00008FF044F60597D';
		const tpduLen = pdu.length / 2 - 1 - parseInt(pdu.slice(0, 2), 16);
		const oneShotCmd = 'AT+CMGS=' + tpduLen + '\\r' + pdu;

		const r1 = atResult(await at(oneShotCmd));
		check('一次性形态（长度 + 字面 \\r + PDU）拿到 +CMGS 回执',
			r1.success && String(r1.data).indexOf('+CMGS') >= 0 && String(r1.data).indexOf('OK') >= 0,
			(r1.data ? String(r1.data).replace(/\r/g, '\\r').slice(0, 40) : r1.error) || '无应答');

		/* 两段式第一步：只给 `> ` 提示符，不能被当成提交成功 */
		const r2 = atResult(await at('AT+CMGS=' + tpduLen));
		check('两段式第一步只有提示符、没有提交回执',
			!(r2.success && String(r2.data).indexOf('+CMGS') >= 0),
			(r2.data ? String(r2.data).replace(/\r/g, '\\r').slice(0, 20) : r2.error) || '无应答');

		/* 两段式第二步：PDU + Ctrl+Z(0x1A)。0x1A 经 JSON \u001a 转义穿过 RPC 链路，
		 * serde_json 解析还原后原样写入串口 —— 这条链路本身也是被测对象。
		 *
		 * **必须和一次性形态用不同的 PDU**：上面那条一次性提交成功后 mock 里存了
		 * TPDU，同一条再提交会被判成重复短信（模组对重复 TPDU 回 ERROR），
		 * 于是这里看到的是「重复」而不是「两段式是否走通」。
		 * 改成只动 TP-MR（TPDU 内偏移 1，即 PDU 字符串的第 4~5 个字符）的第二条
		 * PDU 即可：「两条不同的短信」是正常的用户场景，比人为重置 mock 状态更贴近实机。 */
		const pdu2 = pdu.slice(0, 2) + pdu.slice(2, 4) + (pdu.slice(4, 6) === '00' ? '01' : '00') + pdu.slice(6);
		/* 诊断开关：E2E_DEBUG=1 时把实际下发的命令形态打到屏幕上。
		 * 这类「字面 \\r / 真 CR / 控制字符被转义链改写」的问题只能靠
		 * 「到底发出去了什么」定位，默认不打（避免刷屏）。 */
		if (process.env.E2E_DEBUG) {
			console.log('[e2e] oneShot =', JSON.stringify(oneShotCmd));
			console.log('[e2e] payload =', JSON.stringify(pdu2 + '\x1A'));
		}
		const r3 = atResult(await at(pdu2 + '\x1A'));
		check('两段式第二步（PDU+Ctrl+Z）拿到 +CMGS 回执',
			r3.success && String(r3.data).indexOf('+CMGS') >= 0 && String(r3.data).indexOf('OK') >= 0,
			(r3.data ? String(r3.data).replace(/\r/g, '\\r').slice(0, 40) : r3.error) || '无应答');

		const r4 = atResult(await at('AT+CMGS=0'));
		check('AT+CMGS=0（零长度 TPDU）被拒', r4.success === false,
			r4.error || String(r4.data).slice(0, 30));

		const r5 = atResult(await at('AT+CMGS=' + (tpduLen + 1) + '\\r' + pdu));
		check('一次性形态长度与 PDU 字节数不符被拒', r5.success === false,
			r5.error || String(r5.data).slice(0, 30));
	}

	/* 5c. 短信业务动作全链路（`sms` RPC → 后端事务 → mock 模组）
	 *
	 * 5b 验的是**裸 AT 拼法**，这里验的是**业务入口**：`send` 走两段式提交、
	 * `power` 的先读 CEUS / 失败回滚 / 关闭只关 IMS。这几条路径过去只能靠手工
	 * 故障注入复现，现在钉进仓库自带的 e2e（mock 提供 AT+TESTCEUS / TESTCEUSFAIL /
	 * TESTCFUN1FAIL / TESTCPMSFAIL / TESTIMSFALSE 钩子，默认全关）。
	 */
	{
		function smsRpc(action, extra, ms) {
			return rpc('sms', Object.assign({ action: action, auth_key: AUTH_KEY }, extra || {}), ms || 30000);
		}
		function res(r) { return r.error ? null : (r.result || null); }
		async function num(cmd, label) {
			const r = atResult(await at(cmd));
			const m = new RegExp('\\+' + label + ': *([0-9]+)').exec(String(r.data || ''));
			return m ? parseInt(m[1], 10) : -1;
		}
		const cfun = function () { return num('AT+CFUN?', 'CFUN'); };
		const ceus = function () { return num('AT+CEUS?', 'CEUS'); };
		const hook = function (s) { return at('AT+TEST' + s); };
		const clean = async function () {
			await hook('CEUSFAIL=0'); await hook('CFUN1FAIL=0');
			await hook('CPMSFAIL=0'); await hook('IMSFALSE=0');
			await hook('CEUS=1');
		};

		/* 应用层发送：必须拿到模组的 +CMGS 回执（业务路径以前用的是拿不到回执的旧拼法） */
		await clean();
		const s = res(await smsRpc('send', { destination: '+8613800138000', message: 'e2e 两段式发送' }));
		check('sms send 应用层拿到 +CMGS 回执',
			!!s && s.outcome === 'accepted' && String((s.parts && s.parts[0] || {}).detail).indexOf('+CMGS') >= 0,
			s ? s.outcome + ' / ' + String((s.parts && s.parts[0] || {}).detail).replace(/\r/g, '\\r').slice(0, 30) : '无结果');

		/* CEUS 已是 1（出厂默认）：不该再关射频，点一次开启就断一次网是不可接受的 */
		const p1 = res(await smsRpc('power', { enable: true }));
		check('power(enable) 在 CEUS=1 时跳过射频重启',
			!!p1 && p1.enabled === true && String((p1.stepsDone || []).join(' ')).indexOf('跳过射频重启') >= 0,
			p1 ? JSON.stringify(p1.stepsDone) + ' detail=' + String(p1.failedDetail || '') : '无结果');
		check('快路径执行后模组射频仍为 1', (await cfun()) === 1, 'CFUN=' + (await cfun()));

		/* enable 传成字符串：必须报错，不能静默当成「关闭」执行反向动作 */
		const bad = await smsRpc('power', { enable: 'true' });
		check('power(enable 传字符串) 被拒而非执行关闭',
			!!bad.error && String(bad.error.message || '').indexOf('布尔') >= 0,
			bad.error ? String(bad.error.message) : JSON.stringify(bad.result));

		/* 需要重启射频的设备（CEUS=0），且 AT+CFUN=1 被拒：
		 * 这一条同时钉住两件事 —— 报失败，并且把射频回滚到 1。 */
		await hook('CEUS=0'); await hook('CFUN1FAIL=1');
		const p2 = res(await smsRpc('power', { enable: true }));
		check('power(enable) 在 CFUN=1 被拒时报告失败在恢复射频',
			!!p2 && p2.enabled === false && p2.failedAt === '恢复射频',
			p2 ? String(p2.failedAt) + ' / ' + String(p2.failedDetail || '').slice(0, 60) : '无结果');
		check('失败后已回滚射频（failedDetail 说明回滚结果）',
			!!p2 && String(p2.failedDetail || '').indexOf('回滚') >= 0,
			String((p2 || {}).failedDetail || ''));
		check('回滚后模组侧射频确认为 1', (await cfun()) === 1, 'CFUN=' + (await cfun()));
		await clean();

		/* 射频已确认恢复时，失败不该再多补一次 AT+CFUN=1 */
		await hook('CEUS=0'); await hook('IMSFALSE=1');
		const p3 = res(await smsRpc('power', { enable: true }));
		check('power(enable) 在 IMSSWITCH 被拒时带出模组原始错误码',
			!!p3 && p3.enabled === false && p3.failedAt === '开启 LTE IMS' && String(p3.failedDetail || '').indexOf('308') >= 0,
			p3 ? String(p3.failedAt) + ' / ' + String(p3.failedDetail || '').slice(0, 60) : '无结果');
		check('射频恢复并注册的确认结果如实写进步骤',
			!!p3 && String((p3.stepsDone || []).join(' ')).indexOf('注册网络') >= 0,
			JSON.stringify((p3 || {}).stepsDone));
		check('射频已 1 时不再重复补发（模组侧仍为 1）', (await cfun()) === 1, 'CFUN=' + (await cfun()));
		await clean();

		/* CEUS 写不进去：射频根本没动过，不该出现任何 CFUN 下发 */
		await hook('CEUS=0'); await hook('CEUSFAIL=1');
		const p4 = res(await smsRpc('power', { enable: true }));
		check('CEUS 写入被拒时立即停住且不关射频',
			!!p4 && p4.failedAt === '设置数据中心模式' && (await cfun()) === 1,
			p4 ? String(p4.failedAt) + ' / ' + String(p4.failedDetail || '') : '无结果');
		await clean();

		/* 关闭：只关 IMS，不动射频、不改 CEUS、不清空短信 */
		const p5 = res(await smsRpc('power', { enable: false }));
		check('power(disable) 只关 IMS',
			!!p5 && p5.enabled === false && !p5.failedAt && (await cfun()) === 1 && (await ceus()) === 1,
			p5 ? JSON.stringify(p5.stepsDone) + ' CFUN=' + (await cfun()) + ' CEUS=' + (await ceus()) : '无结果');

		/* 清空全部短信：部分存储区失败时，成功数与失败原因必须同时可见 */
		await hook('CPMSFAIL=1');
		const pg = res(await smsRpc('purge'));
		await hook('CPMSFAIL=0');
		check('purge 部分失败时 deleted 与 errors 同时可见',
			!!pg && pg.deleted >= 1 && (pg.errors || []).length >= 1 && String((pg.errors || [])[0]).indexOf('4') >= 0,
			pg ? 'deleted=' + pg.deleted + '/' + pg.requested + ' errors=' + JSON.stringify(pg.errors) : '无结果');
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
			/* 号码是归一化后的：+CLIP 给国际格式 +8613800138000，
			 * 后端按 normalize_phone_number 剥掉 +86（与前端 Parse.normalizePhoneNumber
			 * 同规则，保证推送与短信中心界面口径一致），故事件里是 13800138000。 */
			ok = ev.data.number === '13800138000' && ev.data.state === 'ringing';
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

	/* 10. 自动拨号对齐回归（开关 + 拨号方式必须同时对齐）
	 *
	 * mock 的初始状态是 autodial=1, autodialMode=2（转网口模式）。
	 * 只比较开关的实现会判定「已对齐」直接跳过下发，模组停在转网口模式，
	 * USB 网口永远收不到 DHCP —— 这正是「模组在线但接口拿不到 IP」的一条成因。
	 * 正确行为：后端连上模组后把方式纠正为 1（USB 网络接口）。
	 * 该对齐在服务启动时执行，这里轮询等待其完成。
	 */
	{
		let data = '';
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			const r = atResult(await at('AT^SETAUTODIAL?'));
			if (r.success && r.data) {
				data = String(r.data).replace(/\r/g, '');
				if (/\^SETAUTODIAL:\s*1\s*,\s*1/.test(data)) break;
			}
			await sleep(500);
		}
		check('后端把自动拨号对齐为 1,1（开关 + USB 网络接口方式）',
			/\^SETAUTODIAL:\s*1\s*,\s*1/.test(data),
			(data.split('\n').filter(Boolean)[0]) || '无应答');
	}

	/* 11. 关闭自动拨号后回读为 0（确认开关可被外部改写、回读链路正常） */
	{
		const r1 = atResult(await at('AT^SETAUTODIAL=0'));
		await sleep(300);
		const r2 = atResult(await at('AT^SETAUTODIAL?'));
		const d = String(r2.data || '').replace(/\r/g, '');
		check('关闭自动拨号后回读为 0', r1.success && /\^SETAUTODIAL:\s*0/.test(d),
			d.split('\n').filter(Boolean)[0] || '无应答');
	}

	/* 12. 真 CR 拼 PDU 的一次性写法：实机表现为静默（必须排在最后一条）
	 *
	 * 手册 9.14.1 把语法写成 `AT+CMGS=<length><CR>PDU is given`，照字面用**真实
	 * CR** 把长度和 PDU 一次写完，这台模组只回显命令、随后不再有任何应答：它已经
	 * 停在 PDU 输入态等 Ctrl+Z，而这条路上永远不会有 Ctrl+Z。mock 按同一套语义
	 * 处理（见 mock-modem.js 的 awaitingPdu），所以这里必须**等不到**回执。
	 *
	 * 为什么放最后：后端把这条判为一次性提交，按 40s 预算等回执，客户端 3s 放弃后
	 * 通道仍被占着。排在其它用例前面会把后面整串检查一起拖成排队超时。
	 */
	{
		const pdu = '0015660B3108108300F00008FF044F60597D';
		const r = atResult(await rpc('at',
			{ cmd: 'AT+CMGS=' + (pdu.length / 2 - 1 - parseInt(pdu.slice(0, 2), 16)) + '\r' + pdu, auth_key: AUTH_KEY }, 3000));
		check('长度 + 真 CR + PDU 一次写完拿不到提交回执（实机静默）',
			!(r.success && String(r.data || '').indexOf('+CMGS') >= 0),
			r.error || (r.data ? String(r.data).replace(/\r/g, '\\r').slice(0, 30) : '无应答'));
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
