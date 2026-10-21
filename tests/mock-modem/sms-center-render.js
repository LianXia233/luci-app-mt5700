'use strict';
/**
 * 短信中心渲染回归：本地模拟「一条短信 / 多个会话」的显示效果。
 *
 * 做法：不启动浏览器，也不依赖 LuCI 运行时 ——
 *   1. 用极简 DOM 桩提供 document / E() / localStorage，让 sms_center.js 的
 *      render() 能像在真机上一样跑完（含 refresh → parseCMGL → 聚合 → 渲染）；
 *   2. 输入是 tests/mock-modem/sms-fixtures.js 生成的真实 PDU（DELIVER + SUBMIT），
 *      与 mock 模组返回的是同一份样本，避免「测试用的样本和实机不一样」；
 *   3. 断言落在最终的 DOM 结构上：分区数量、分区标题与条数、气泡顺序、时间文案。
 *
 * 用法：node sms-center-render.js
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HERE = __dirname;
const RES = path.resolve(HERE, '../../htdocs/luci-static/resources');
const fixtures = require(path.join(HERE, 'sms-fixtures.js'));

let pass = 0;
let fail = 0;

function dirsOf(bubbles) {
	return bubbles.map((b) => (b.className.indexOf('mt5700-sms-bubble-sent') >= 0 ? 'S' : 'R')).join('');
}

function check(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		pass++;
		console.log(`  ok   ${name} = ${a}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}\n       实际 ${a}\n       期望 ${e}`);
	}
}

/* ==================== 1. 装载 parse.js（剥 LuCI 语法糖） ==================== */

function loadParse(ls) {
	const src = fs.readFileSync(path.join(RES, 'at-webserver/parse.js'), 'utf8');
	let code = src.replace("'require baseclass';", '');
	const tail = code.indexOf('var ParseClass = L.Class.extend(Parse);');
	if (tail < 0) throw new Error('parse.js 尾部包装未找到，剥离逻辑需要更新');
	code = code.slice(0, tail) + '\nmodule.exports = Parse;\n';

	const sandbox = { module: { exports: {} }, console: console, localStorage: ls || makeLocalStorage() };
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'parse.js' });
	return sandbox.module.exports;
}

/* 装载真实的 smsEncode.js（剥 LuCI 语法糖）。
 * 发送流程必须用真编码器：stub 掉的 buildSubmitParts 会让「发不出短信」
 * 这类 bug 从测试的缝隙里溜过去（issue #19 正是如此）。 */
function loadSmsEncode() {
	const src = fs.readFileSync(path.join(RES, 'at-webserver/smsEncode.js'), 'utf8');
	let code = src.replace("'require baseclass';", '').replace(/^'use strict';\s*$/m, '');
	const tail = code.indexOf('var SmsEncodeClass = L.Class.extend(SmsEncode);');
	if (tail < 0) throw new Error('smsEncode.js 尾部包装未找到，剥离逻辑需要更新');
	code = code.slice(0, tail) + '\nmodule.exports = SmsEncode;\n';
	const sandbox = { module: { exports: {} }, console: console };
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'smsEncode.js' });
	return sandbox.module.exports;
}

const SmsEncode = loadSmsEncode();

	function makeLocalStorage(initial) {
	/* 允许预置内容：验证「模组有该条、缓存也有」时时间戳是否被正确吸收 */
	const store = Object.assign({}, initial);
	return {
		getItem: (k) => (k in store ? store[k] : null),
		setItem: (k, v) => { store[k] = String(v); },
		removeItem: (k) => { delete store[k]; }
	};
}

/* ==================== 2. 极简 DOM 桩 ==================== */

function Node(tag) {
	this.tagName = tag;
	this.childNodes = [];
	this.attributes = {};
	this.className = '';
	this.style = {};
	this.value = '';
	this.disabled = false;
	this.checked = false;
	this.scrollTop = 0;
	this.scrollHeight = 0;
	this.parentNode = null;
	this._text = '';
	this._listeners = {};
}

Object.defineProperty(Node.prototype, 'textContent', {
	get: function () {
		if (this.childNodes.length) {
			return this.childNodes.map((c) => c.textContent).join('');
		}
		return this._text;
	},
	set: function (v) {
		this.childNodes = [];
		this._text = String(v);
	}
});

Object.defineProperty(Node.prototype, 'innerHTML', {
	get: function () { return this._text; },
	set: function (v) { this.childNodes = []; this._text = String(v); }
});

Node.prototype.appendChild = function (c) { c.parentNode = this; this.childNodes.push(c); return c; };
Node.prototype.removeChild = function (c) {
	const i = this.childNodes.indexOf(c);
	if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; }
	return c;
};
Node.prototype.setAttribute = function (k, v) { this.attributes[k] = v; };
Node.prototype.getAttribute = function (k) { return this.attributes[k]; };
Node.prototype.addEventListener = function (t, fn) {
	(this._listeners[t] = this._listeners[t] || []).push(fn);
};
Node.prototype.dispatch = function (t, ev) {
	(this._listeners[t] || []).forEach((fn) => fn(ev || {}));
};
Node.prototype.querySelector = function () { return null; };

/* LuCI 的 E(tag, attrs, children) */
function E(tag, attrs, children) {
	const el = new Node(tag);
	if (attrs) {
		Object.keys(attrs).forEach((k) => {
			if (k === 'class') el.className = attrs[k];
			else el.setAttribute(k, attrs[k]);
		});
	}
	if (children != null) {
		if (Array.isArray(children)) children.forEach((c) => { if (c) el.appendChild(c); });
		else if (typeof children === 'object') el.appendChild(children);
		else el.textContent = String(children);
	}
	return el;
}

function findAll(root, cls) {
	const out = [];
	(function walk(n) {
		if (!n || !n.childNodes) return;
		if (String(n.className || '').split(/\s+/).indexOf(cls) >= 0) out.push(n);
		n.childNodes.forEach(walk);
	})(root);
	return out;
}

function textsOf(nodes) {
	return nodes.map((n) => n.textContent);
}

/* ==================== 3. 装载 sms_center.js 并渲染 ==================== */

const pduList = fixtures.buildConversations();
const cmgl = fixtures.cmglText(pduList);

function loadView(Parse, ls, opts) {
	const src = fs.readFileSync(path.join(RES, 'view/at-webserver/sms_center.js'), 'utf8');
	/* 去掉 LuCI 的 `'require x/y';` 头部与 'use strict'，剩下就是标准 JS */
	const body = src
		.replace(/^'require [^']*';\s*$/gm, '')
		.replace(/^'use strict';\s*$/m, '');

	const calls = { cmds: [], subscribed: [] };

	const documentStub = {
		createElement: (tag) => new Node(tag),
		body: new Node('body')
	};

	const toasts = [];
	const Mt5700 = {
		page: () => ({ _body: new Node('div'), className: 'mt5700-page' }),
		primaryButton: (label) => E('button', { class: 'mt5700-btn' }, label),
		dangerButton: (label) => E('button', { class: 'mt5700-btn mt5700-btn-danger' }, label),
		ghostButton: (label) => E('button', { class: 'mt5700-btn' }, label),
		button: (label) => E('button', { class: 'mt5700-btn' }, label),
		empty: (text) => E('div', { class: 'mt5700-empty' }, text),
		panelActions: function () {
			const wrap = E('div', { class: 'mt5700-panel-actions' });
			for (let i = 0; i < arguments.length; i++) wrap.appendChild(arguments[i]);
			return wrap;
		},
		warning: (t) => { toasts.push({ kind: 'warning', text: String(t) }); },
		error: (t) => { toasts.push({ kind: 'error', text: String(t) }); },
		info: (t) => { toasts.push({ kind: 'info', text: String(t) }); },
		success: (t) => { toasts.push({ kind: 'success', text: String(t) }); },
		confirm: () => {}
	};

	const Ui = {
		promptModal: () => {},
		/* 真机上 Ui.startup 会等页面挂载完再回调；这里立即回调，让 refresh 跑起来 */
		startup: (body, cb) => { cb(); }
	};

	/*
	 * respond 可整体替换 sendCommand 的应答（发送流程回归用）。
	 * 返回 undefined 时走下面的默认应答（CMGL / CPMS 真实样本，其余 OK）。
	 */
	const options = opts || {};
	const AtWs = {
		client: {
			sendCommand: (cmd) => {
				calls.cmds.push(cmd);
				if (options.respond) {
					const r = options.respond(cmd);
					if (r !== undefined) return Promise.resolve(r);
				}
				if (cmd === 'AT+CMGL=4') return Promise.resolve({ success: true, data: cmgl });
				/*
				 * 实机（MT5700M-CN）只认**标准** `AT+CPMS?`；发私有前缀的
				 * `AT^CPMS?` 直接回 ERROR。这里刻意让私有写法失败 ——
				 * 前端一旦退回 `^` 前缀，存储用量断言就会立刻挂掉。
				 */
				if (cmd === 'AT+CPMS?') return Promise.resolve({ success: true, data: '+CPMS: "SM",6,50,"SM",6,50,"MT",0,50' });
				if (cmd === 'AT^CPMS?') return Promise.resolve({ success: false, error: 'ERROR' });
				return Promise.resolve({ success: true, data: 'OK' });
			},
			subscribe: (fn) => { calls.subscribed.push(fn); },
			unsubscribe: () => {}
		}
	};

	const factory = new Function(
		'L', 'E', 'Mt5700', 'Ui', 'Parse', 'AtWs', 'SmsEncode', 'document', 'localStorage', 'window', 'console',
		body
	);

	const L = { view: { extend: (def) => def } };
	const view = factory(
		L, E, Mt5700, Ui, Parse, AtWs, SmsEncode, documentStub, ls || makeLocalStorage(), {}, console
	);
	const page = view.render.call(view);
	return { page, calls, toasts };
}

/* ==================== 4. 断言 ==================== */

async function main() {
	/*
	 * parse.js（vm 沙箱）与 sms_center.js 必须共用同一个 localStorage ——
	 * 已发短信缓存就存在里面，两边各拿一个空 store 的话缓存永远读不到，
	 * 「模组那条没有时刻、由缓存补上」这条路径就测不到。
	 */
	const ls = makeLocalStorage();
	const Parse = loadParse(ls);

	console.log('=== 0. 夹具自检：PDU 能被解析出方向与时间 ===');
	const parsedDirect = pduList.map((it) => Parse.decodeIncomingPdu(it.pdu));
	check('六条 PDU 全部解析成功', parsedDirect.every((d) => d !== null), true);
	check('方向序列', parsedDirect.map((d) => d.direction),
		['received', 'sent', 'received', 'received', 'received', 'sent']);
	check('相对 VP 的 SUBMIT 时间未知', parsedDirect[1].date, null);
	check('绝对 VP 的 SUBMIT 标记为近似时间', parsedDirect[5].timeApprox, true);

	console.log('\n=== 1. 渲染（refresh → parseCMGL → 聚合 → 分区）===');
	const { page, calls } = loadView(Parse, ls);
	/* refresh 走 Promise，等微任务队列清空后再读 DOM */
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));

	check('确实请求了短信列表', calls.cmds.indexOf('AT+CMGL=4') >= 0, true);
	check('订阅了新短信事件', calls.subscribed.length, 1);

	/* 存储用量：实机只认标准 `AT+CPMS?`（私有 `AT^CPMS?` 回 ERROR 导致用量永远 0 / 0）。
	   这里同时断言「用了标准写法」与「没用私有写法」，防止前缀再次写错 */
	const hints = findAll(page._body, 'mt5700-hint');
	check('请求了标准 CPMS 命令', calls.cmds.indexOf('AT+CPMS?') >= 0, true);
	check('未使用私有 ^CPMS 前缀', calls.cmds.indexOf('AT^CPMS?') < 0, true);
	check('存储用量按 +CPMS 应答解析', hints.length ? hints[0].textContent : null, '存储：6 / 50');

	const contactItems = findAll(page._body, 'mt5700-sms-item');
	const contactNumbers = contactItems.map((n) => n.childNodes[0].textContent);
	console.log(`  联系人列表（按最近联系时间倒序）: ${contactNumbers.join(' | ')}`);
	check('会话数量', contactItems.length, 3);
	check('会话顺序（最近的在前）', contactNumbers, ['10690000000', '13900139000', '13800138000']);

	console.log('\n=== 2. 会话 A：聊天式单时间轴（收发混排，左右气泡区分方向）===');
	const idxA = contactNumbers.indexOf('13800138000');
	contactItems[idxA].dispatch('click');

	check('不再使用分区结构', findAll(page._body, 'mt5700-sms-section').length, 0);
	const days = findAll(page._body, 'mt5700-sms-date');
	check('存在日期分隔条', days.length >= 1, true);
	/*
	 * 借位置的那条（无发送时刻的发出短信）日期并入当天，不再单独起一档
	 * 「时间未知的消息」—— 否则一次来回会被劈成两半，就不像对话了。
	 */
	check('没有插入「时间未知的消息」分隔条',
		days.map((d) => d.textContent).indexOf('时间未知的消息'), -1);
	check('日期条格式', /^20\d{2}-\d{2}-\d{2}$/.test(days[0].textContent), true);

	let bubbles = findAll(page._body, 'mt5700-sms-bubble');
	check('气泡总数（收发混排，不再拆两块）', bubbles.length, 3);
	/*
	 * 真实时间线是「对面问 → 我答 → 对面再答」。发出短信的 SUBMIT PDU 按规范
	 * 不含发送时刻，早先的实现会把它沉到会话末尾，渲染成「左、左、右」——
	 * 一次来回被打散。现在借模组存储序号就近插入，才是真正的你一句我一句。
	 */
	check('收发按对话顺序交替（你一句我一句）', textsOf(bubbles.map((b) => b.childNodes[0])), [
		'明天上午的评审改到十点，方便吗？',
		'方便，我九点半到会议室。',
		'好，会议室在 3 号楼 502。'
	]);
	check('方向序列 = 收-发-收', dirsOf(bubbles), 'RSR');
	check('第 1 条是收到的气泡（左）', bubbles[0].className.indexOf('mt5700-sms-bubble-recv') >= 0, true);
	check('第 2 条是发出的气泡（右）', bubbles[1].className.indexOf('mt5700-sms-bubble-sent') >= 0, true);
	check('第 3 条是收到的气泡（左）', bubbles[2].className.indexOf('mt5700-sms-bubble-recv') >= 0, true);
	/* 借位置只借顺序，时刻照旧如实标注，不把推断出来的位置伪装成真实时刻 */
	check('借位置的那条仍如实标「时间未知」', bubbles[1].childNodes[1].textContent, '时间未知');
	check('气泡内只留时刻（日期由分隔条承担）', /^\d{2}:\d{2}:\d{2}$/.test(bubbles[0].childNodes[1].textContent), true);
	const recvA = [bubbles[0]];

	console.log('\n=== 3. 会话 B：只有收到 ===');
	contactItems[contactNumbers.indexOf('13900139000')].dispatch('click');
	bubbles = findAll(page._body, 'mt5700-sms-bubble');
	check('气泡数量', bubbles.length, 1);
	check('是收到的气泡（左）', bubbles[0].className.indexOf('mt5700-sms-bubble-recv') >= 0, true);
	check('无分区空态残留', findAll(page._body, 'mt5700-sms-section-empty').length, 0);

	console.log('\n=== 4. 会话 C：发出的短信带绝对有效期 → 标注为近似时间 ===');
	contactItems[contactNumbers.indexOf('10690000000')].dispatch('click');
	bubbles = findAll(page._body, 'mt5700-sms-bubble');
	check('气泡数量', bubbles.length, 2);
	const sentC = bubbles.filter((b) => b.className.indexOf('mt5700-sms-bubble-sent') >= 0);
	check('发出气泡 1 条', sentC.length, 1);
	check('内容', sentC[0].childNodes[0].textContent, '收到，谢谢。');
	check('时间带「非发送时刻」标注',
		sentC[0].childNodes[1].textContent.slice(-6), '非发送时刻）');
	check('近似时间文案完整',
		sentC[0].childNodes[1].textContent.indexOf('（有效期，非发送时刻）') > 0, true);

	console.log('\n=== 5. 与推送链路口径一致：短信时间就是 PDU 时间戳（北京时间）===');
	/* 收到短信的时刻在夹具里是「现在 − 32 分钟」，SCTS 按 UTC+8 生成；
	   解析后显示的日历时间必须与生成时算好的期望值逐字一致 */
	check('第一条时间 == 夹具生成的北京时间（时刻部分）',
		recvA[0].childNodes[1].textContent, pduList[0].display.split(',')[1]);
	check('夹具期望值确实是北京时间口径', pduList[0].display.slice(0, 2),
		String(fixtures.beijingParts(-32).year).padStart(2, '0'));

	console.log('\n=== 6. 缓存里有本机发送时刻 → 补给模组那条（不丢时间信息）===');
	/*
	 * 模组存回来的 SMS-SUBMIT 不含发送时刻，而缓存那条是本机发送当时打的时间戳
	 * —— 缓存才是唯一带准确时间的一份。早先的实现去重时保留模组那份、丢掉缓存
	 * 那份，等于把时间信息一并扔了。这里预置一条缓存记录验证它被「吸收」：
	 * 气泡仍是 3 条（不重复），且发出那条拿到了本机时刻。
	 */
	/*
	 * 夹具里这条发出的短信实际发生在「现在 − 30 分钟」（见 sms-fixtures.js 的
	 * defs 里 index 2 的 offset），而它的 SUBMIT PDU 不带发送时刻 ——
	 * 这个真实时刻正是本机缓存要补上去的那份信息。
	 */
	const bp = fixtures.beijingParts(-30);
	const pad2 = (n) => String(n).padStart(2, '0');
	const cachedTime = `${pad2(bp.year)}/${pad2(bp.month)}/${pad2(bp.day)},`
		+ `${pad2(bp.hour)}:${pad2(bp.minute)}:${pad2(bp.second)}`;
	const ls2 = makeLocalStorage();
	ls2.setItem(Parse.SMS_CACHE_KEY, JSON.stringify([{
		index: -Date.now(),
		content: pduList[1].content,
		number: pduList[1].number,
		time: cachedTime,
		type: 'sent'
	}]));
	const Parse2 = loadParse(ls2);
	const r2 = loadView(Parse2, ls2);
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	const items2 = findAll(r2.page._body, 'mt5700-sms-item');
	const nums2 = items2.map((n) => n.childNodes[0].textContent);
	items2[nums2.indexOf(pduList[1].number)].dispatch('click');
	const b2 = findAll(r2.page._body, 'mt5700-sms-bubble');
	check('缓存被吸收，气泡仍是 3 条（不重复显示）', b2.length, 3);
	check('方向序列仍是 收-发-收', dirsOf(b2), 'RSR');
	check('发出那条拿到了本机发送时刻（不再是「时间未知」）',
		b2[1].childNodes[1].textContent, cachedTime.split(',')[1]);

	console.log('\n=== 7. 发送流程：两段式 CMGS + Ctrl+Z 提交（issue #19 回归） ===');
	/*
	 * bug 背景：旧实现把 `AT+CMGS=<长度>\r<PDU>` 拼成一条命令，后端收到
	 * `> ` 提示符就认为应答结束，前端显示「发送成功」——但 Ctrl+Z(0x1A)
	 * 从未下发，模组等在输入态，短信根本没发出去。
	 *
	 * 这里钉住正确协议：报长度与交 PDU 必须是**两条独立命令**，且第二条
	 * 以 0x1A 结尾；任何一条命令里都不允许再出现 `\r` 拼 PDU 的旧写法。
	 */
	const SEND_NUMBER = '13900139000';
	const SEND_TEXT = '回归测试短信 hello';

	/* 选中联系人 → 填输入框 → 派发回车，等 Promise 链完全落地 */
	async function triggerSend(r, number, text) {
		const items = findAll(r.page._body, 'mt5700-sms-item');
		const nums = items.map((n) => n.childNodes[0].textContent);
		const target = items[nums.indexOf(number)];
		if (!target) throw new Error('找不到联系人 ' + number);
		target.dispatch('click');
		const ta = findAll(r.page._body, 'mt5700-input')[0];
		ta.value = text;
		ta.dispatch('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
		for (let i = 0; i < 12; i++) await new Promise((r2) => setImmediate(r2));
		return ta;
	}

	/* 场景 A：正常两段式。CMGS 报长度回 `> ` 提示符，PDU+0x1A 回 +CMGS/OK */
	{
		const lsA = makeLocalStorage();
		const ParseA = loadParse(lsA);
		const respond = (cmd) => {
			if (cmd === 'AT+CMGF?') return { success: true, data: '+CMGF: 0\r\nOK' };
			if (cmd === 'AT+CSCA?') return { success: true, data: '+CSCA: "+8613800755500",145\r\nOK' };
			if (/^AT\+CMGS=\d+$/.test(cmd)) return { success: true, data: '>' };
			if (cmd.charCodeAt(cmd.length - 1) === 26) return { success: true, data: '+CMGS: 1\r\nOK' };
			return undefined;
		};
		const rA = loadView(ParseA, lsA, { respond: respond });
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		const ta = await triggerSend(rA, SEND_NUMBER, SEND_TEXT);

		const cmds = rA.calls.cmds;
		check('先查模式再报长度：存在 AT+CMGS=<十进制长度>',
			cmds.some((c) => /^AT\+CMGS=\d+$/.test(c)), true);
		const submit = cmds.filter((c) => c.charCodeAt(c.length - 1) === 26);
		check('PDU 提交是独立命令且以 Ctrl+Z(0x1A) 结尾', submit.length, 1);
		check('提交内容去掉 0x1A 后是纯十六进制 PDU',
			submit.length === 1 && /^[0-9A-F]+$/.test(submit[0].slice(0, -1)), true);
		check('没有任何命令把 PDU 用 \r 拼进 CMGS（旧 bug 拼法）',
			cmds.some((c) => c.indexOf('\r') >= 0), false);
		check('上报了发送成功', rA.toasts.some((t) => t.kind === 'success'), true);
		check('没有误报错误', rA.toasts.some((t) => t.kind === 'error'), false);
		check('输入框已清空', ta.value, '');
		const sentBubbles = findAll(rA.page._body, 'mt5700-sms-bubble')
			.filter((b) => b.className.indexOf('mt5700-sms-bubble-sent') >= 0);
		check('会话里出现该条已发消息（右侧气泡）',
			sentBubbles.some((b) => b.childNodes[0].textContent === SEND_TEXT), true);
		check('已发消息写入 localStorage 缓存',
			ParseA.getCachedSentMessages().some((m) => m.content === SEND_TEXT && m.number === SEND_NUMBER), true);
	}

	/* 场景 B：假成功防护。提交只回 `> `（旧 bug 的应答形态）必须判失败 */
	{
		const lsB = makeLocalStorage();
		const ParseB = loadParse(lsB);
		const respond = (cmd) => {
			if (cmd === 'AT+CMGF?') return { success: true, data: '+CMGF: 0\r\nOK' };
			if (cmd === 'AT+CSCA?') return { success: true, data: '+CSCA: "+8613800755500",145\r\nOK' };
			if (/^AT\+CMGS=\d+$/.test(cmd)) return { success: true, data: '>' };
			if (cmd.charCodeAt(cmd.length - 1) === 26) return { success: true, data: '>' };
			return undefined;
		};
		const rB = loadView(ParseB, lsB, { respond: respond });
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await triggerSend(rB, SEND_NUMBER, SEND_TEXT);

		check('只有提示符应答时不得显示发送成功',
			rB.toasts.some((t) => t.kind === 'success'), false);
		check('只有提示符应答时报错（未确认提交）',
			rB.toasts.some((t) => t.kind === 'error' && t.text.indexOf('未确认') >= 0), true);
		check('假成功不得写入缓存', ParseB.getCachedSentMessages().length, 0);
	}

	/* 场景 C：文本模式必须强制切 PDU（AT+CMGF=0），杜绝模式歧义 */
	{
		const lsC = makeLocalStorage();
		const ParseC = loadParse(lsC);
		const respond = (cmd) => {
			if (cmd === 'AT+CMGF?') return { success: true, data: '+CMGF: 1\r\nOK' };
			if (cmd === 'AT+CSCA?') return { success: true, data: '+CSCA: "+8613800755500",145\r\nOK' };
			if (/^AT\+CMGS=\d+$/.test(cmd)) return { success: true, data: '>' };
			if (cmd.charCodeAt(cmd.length - 1) === 26) return { success: true, data: '+CMGS: 1\r\nOK' };
			return undefined;
		};
		const rC = loadView(ParseC, lsC, { respond: respond });
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await triggerSend(rC, SEND_NUMBER, SEND_TEXT);
		check('文本模式下先切 PDU 再发送', rC.calls.cmds.indexOf('AT+CMGF=0') >= 0, true);
		check('切换后发送成功', rC.toasts.some((t) => t.kind === 'success'), true);
	}

	/* 场景 D：模组拒绝提交（如 +CMS ERROR: 322 内存满）必须报错且不写缓存 */
	{
		const lsD = makeLocalStorage();
		const ParseD = loadParse(lsD);
		const respond = (cmd) => {
			if (cmd === 'AT+CMGF?') return { success: true, data: '+CMGF: 0\r\nOK' };
			if (cmd === 'AT+CSCA?') return { success: true, data: '+CSCA: "+8613800755500",145\r\nOK' };
			if (/^AT\+CMGS=\d+$/.test(cmd)) return { success: true, data: '>' };
			if (cmd.charCodeAt(cmd.length - 1) === 26) return { success: false, error: '+CMS ERROR: 322' };
			return undefined;
		};
		const rD = loadView(ParseD, lsD, { respond: respond });
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await triggerSend(rD, SEND_NUMBER, SEND_TEXT);
		check('模组拒绝时显示发送失败', rD.toasts.some((t) => t.kind === 'error'), true);
		check('模组拒绝时不得显示成功', rD.toasts.some((t) => t.kind === 'success'), false);
		check('模组拒绝时不得写入缓存', ParseD.getCachedSentMessages().length, 0);
	}

	console.log(`\n合计: ${pass} 通过, ${fail} 失败`);
	process.exit(fail ? 1 : 0);
}

main().catch((e) => {
	console.error('渲染测试异常:', e);
	process.exit(1);
});
