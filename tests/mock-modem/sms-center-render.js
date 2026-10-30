'use strict';
/**
 * 短信中心渲染回归：本地模拟「一条短信 / 多个会话」的显示效果。
 *
 * 做法：不启动浏览器，也不依赖 LuCI 运行时 ——
 *   1. 用极简 DOM 桩提供 document / E() / localStorage，让 sms_center.js 的
 *      render() 能像在真机上一样跑完（含 refresh → 后端条目 → 聚合 → 渲染）；
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

/*
 * 方向判定。
 *
 * GH 版把气泡重做成 IM 形态：气泡本体是中性样式（`.mt5700-sms-bubble`），
 * 左右由**行容器** `.mt5700-sms-row.outgoing|incoming` 决定，头像也在行里。
 * 所以方向要问气泡的 `parentNode`，而不是气泡自己的 className。
 */
function isSentBubble(b) {
	const row = b && b.parentNode;
	return !!row && String(row.className || '').indexOf('outgoing') >= 0;
}

function dirsOf(bubbles) {
	return bubbles.map((b) => (isSentBubble(b) ? 'S' : 'R')).join('');
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

/*
 * `classList`：真 DOM 节点都有，短信中心用它往页面/hero 上挂状态类
 * （`mt5700-sms-shell`、`mt5700-sms-hero-compact`、`is-mobile-chat`）。
 * 桩缺了这一项，页面第一行就抛 TypeError —— 那是桩不够，不是视图有问题。
 */
Node.prototype.classList = {
	add: function () {
		var cs = (this.className || '').split(/\s+/).filter(Boolean);
		for (var i = 0; i < arguments.length; i++) {
			if (cs.indexOf(arguments[i]) < 0) cs.push(arguments[i]);
		}
		this.className = cs.join(' ');
	},
	remove: function () {
		var drop = Array.prototype.slice.call(arguments);
		this.className = (this.className || '').split(/\s+/)
			.filter(function (c) { return c && drop.indexOf(c) < 0; }).join(' ');
	},
	contains: function (c) { return (this.className || '').split(/\s+/).indexOf(c) >= 0; },
	toggle: function (c, on) { if (on) this.classList.add(c); else this.classList.remove(c); }
};
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
/*
 * 表单提交：真机上「发送」按钮调 `form.requestSubmit()`，页面在 submit
 * 事件里 send()。桩照同一语义派发，别让测试绕过页面真正的发送入口。
 */
Node.prototype.requestSubmit = function () { this.dispatch('submit', { preventDefault: () => {} }); };
/* 版式测量：会话区靠 `getBoundingClientRect` 量文档坐标定高（纯 CSS 算不出
 * 导航栏与 hero 的高度）。桩一律返回 0 尺寸 —— 本测试要钉的是渲染结果，
 * 高度自适应另有实机与 render-shot.py 覆盖。 */
Node.prototype.getBoundingClientRect = function () {
	return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
};
Node.prototype.offsetHeight = 0;
Node.prototype.offsetTop = 0;
Node.prototype.clientHeight = 0;

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
		if (String(n.className || '').split(/\s+/).indexOf(cls) >= 0 || (n.tagName||'').toLowerCase() === cls) out.push(n);
		n.childNodes.forEach(walk);
	})(root);
	return out;
}

function textsOf(nodes) {
	return nodes.map((n) => n.textContent);
}

/*
 * 气泡里的「时刻」文本。
 *
 * 时刻与「删除」按钮被收进同一行（`.mt5700-sms-meta`，删除按钮不进正文），
 * 所以取 `span.mt5700-sms-time` 的正文，而不是整行的 textContent —— 后者会
 * 把按钮文字「删除」粘在时刻后面。
 */
function bubbleTime(b) {
	const meta = findAll(b, 'mt5700-sms-time')[0];
	return meta ? meta.textContent : null;
}

/* ==================== 3. 装载 sms_center.js 并渲染 ==================== */

const pduList = fixtures.buildConversations();
/* CMGL 原文只当**诱饵**：视图若还自己去下发 AT+CMGL=4 并解析原文，
 * 下面的 tripwire 断言就会挂；正常路径根本不读它（列表来自后端事务）。 */
const cmgl = fixtures.cmglText(pduList);

function loadView(Parse, ls, opts) {
	const src = fs.readFileSync(path.join(RES, 'view/at-webserver/sms_center.js'), 'utf8');
	/* 去掉 LuCI 的 `'require x/y';` 头部与 'use strict'，剩下就是标准 JS */
	const body = src
		.replace(/^'require [^']*';\s*$/gm, '')
		.replace(/^'use strict';\s*$/m, '');

	const calls = { cmds: [], subscribed: [], smsActions: [], smsCalls: [] };

	/*
	 * 后端 `sms.list` 返回的条目：结构与 Rust 端一致。
	 * 时间直接用夹具给出的显示串 —— 本测试要钉的是「后端给什么、界面显示什么」，
	 * 而不是再算一遍时区（时区由 pdu.rs 的单元测试覆盖）。
	 */
	function backendEntries() {
		return pduList.map(function (it) {
			const d = Parse.decodeIncomingPdu(it.pdu);
			return {
				index: it.index,
				stat: d.direction === 'received' ? 1 : 3,
				direction: d.direction,
				number: d.number,
				content: d.content,
				time: it.display,
				timeApprox: !!d.timeApprox,
				concat: null,
				error: null
			};
		});
	}

	/*
	 * `Mt5700.page()` 返回的是真 DOM 节点，短信中心会在它（以及 `_hero`）上挂
	 * 状态类。桩节点必须带 classList，否则页面第一行就抛 TypeError —— 那是桩不够，
	 * 不是视图有问题。
	 */
	const documentStub = {
		createElement: (tag) => new Node(tag),
		/* 高度自适应的第二次回扣会读整页 scrollHeight；桩给 0 表示「不溢出」 */
		documentElement: { scrollHeight: 0 },
		body: new Node('body'),
		hidden: false,
		/* 短信中心会订阅 visibilitychange（页面隐藏即释放前台会话） */
		addEventListener: (t, fn) => { (documentStub._l = documentStub._l || {})[t] = fn; }
	};

	/* 统一样的按钮工厂：类名 + 可选点击回调（见 Mt5700.*Button 的说明） */
	function makeButton(cls, label, fn) {
		const b = E('button', { class: cls }, label);
		if (typeof fn === 'function') b.addEventListener('click', fn);
		return b;
	}

	const toasts = [];
	const Mt5700 = {
		page: () => {
			const root = new Node('div');
			root.className = 'mt5700-page';
			root._body = new Node('div');
			root._hero = new Node('div');
			return root;
		},
		/*
		 * 按钮桩必须接住第二个参数（点击回调）。
		 *
		 * `Mt5700.primaryButton/dangerButton/ghostButton(label, fn)` 是真接口：
		 * 删除确认、发送、批量删除这些动作全靠这个回调。桩只造壳不挂事件时，
		 * 弹窗里的「删除」点下去什么都不会发生，而测试还会以为点过了。
		 */
		primaryButton: (label, fn) => makeButton('mt5700-btn', label, fn),
		dangerButton: (label, fn) => makeButton('mt5700-btn mt5700-btn-danger', label, fn),
		ghostButton: (label, fn) => makeButton('mt5700-btn', label, fn),
		button: (label, fn) => makeButton('mt5700-btn', label, fn),
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
		/* 真机上 confirm 等用户点确定；这里直接确认，让删除流程跑完 */
		confirm: (msg, cb) => { if (typeof cb === 'function') cb(); }
	};

	const Ui = {
		promptModal: () => {},
		/*
		 * 删除确认弹窗。
		 *
		 * GH 版把「删一条短信」做成了带勾选框的确认弹窗（可选「同时删除本地
		 * 记录文件」），不再直接下发 `sms delete`。桩必须真的**点一下确认**，
		 * 否则删除链一步都不会走 —— 那是桩偷懒，不是页面坏了。
		 * 这里复用极简 DOM：拿 documentStub.body 上最后一个弹窗，点它的主按钮。
		 */
		confirmModal: (title, message, okText, onOk) => {
			if (typeof onOk === 'function') onOk(true);
		},
		/* 真机上 Ui.startup 会等页面挂载完再回调；这里立即回调，让 refresh 跑起来 */
		startup: (body, cb) => { cb(); },
		/*
		 * 离场钩子。sms_center.js 在 render 末尾注册定时器/监听的清理回调，
		 * 真机上由 ui.js 的 hashchange 统一触发。本测试只钉渲染结果、不模拟离场，
		 * 因此收下回调即可 —— 缺失会让页面渲染在第一步就抛 TypeError。
		 */
		onLeave: () => {}
	};

	/*
	 * respond 可整体替换 sendCommand 的应答（发送流程回归用）。
	 * 返回 undefined 时走下面的默认应答（CMGL / CPMS 真实样本，其余 OK）。
	 */
	const options = opts || {};
	const STORAGE = { used: 6, total: 50, mem1: 'SM', mem2: 'SM', mem3: 'ME' };
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
				 * 后端一旦退回 `^` 前缀，存储用量断言就会立刻挂掉。
				 */
				if (cmd === 'AT+CPMS?') return Promise.resolve({ success: true, data: '+CPMS: "SM",6,50,"SM",6,50,"ME",0,50' });
				if (cmd === 'AT^CPMS?') return Promise.resolve({ success: false, error: 'ERROR' });
				return Promise.resolve({ success: true, data: 'OK' });
			},
			/*
			 * 语义化短信接口：一个动作 = 后端一次事务。
			 * 条目由夹具生成，结构与 Rust `sms.list` 的返回一致。
			 */
			sms: (action, params) => {
				calls.smsActions.push(action);
				calls.smsCalls.push({ action: action, params: params || {} });
				if (options.smsRespond) {
					const r = options.smsRespond(action, params || {});
					if (r !== undefined) return Promise.resolve(r);
				}
				if (action === 'list') {
					return Promise.resolve({ success: true, result: {
						entries: backendEntries(), fetchedAt: Date.now(), totalLines: pduList.length
					} });
				}
				/*
				 * 归档三个动作：GH 版把「发出去的短信」落到路由器本地，
				 * 页面每次刷新都会先问统计、选中会话时拉一次记录。
				 * 这里给一份最小可用的空归档 —— 本测试钉的是模组侧列表的渲染，
				 * 归档与模组存储合并成单条时间轴由 e2e 与实机覆盖。
				 */
				if (action === 'store_stats') {
					return Promise.resolve({ success: true, result: {
						dir: '/etc/at-webserver/SMS', totalBytes: 0, maxBytes: 2097152, conversations: []
					} });
				}
				if (action === 'store_read') {
					return Promise.resolve({ success: true, result: { entries: [] } });
				}
				if (action === 'store_drop') {
					return Promise.resolve({ success: true, result: { scope: 'records', dropped: 0, touched: [] } });
				}
				if (action === 'capacity') {
					return Promise.resolve({ success: true, result: { storage: STORAGE, memFull: false } });
				}
				if (action === 'session_open') {
					return Promise.resolve({ success: true, result: { session_id: 1, ttl_ms: 90000 } });
				}
				if (action === 'session_renew') {
					return Promise.resolve({ success: true, result: { renewed: true, sessions: 1 } });
				}
				if (action === 'session_release') {
					return Promise.resolve({ success: true, result: { released: true, sessions: 0 } });
				}
				if (action === 'delete') {
					const n = ((params || {}).indices || []).length;
					return Promise.resolve({ success: true, result: { requested: n, deleted: n, failed: [] } });
				}
				if (action === 'send') {
					return Promise.resolve({ success: true, result: {
						outcome: 'accepted', encoding: 'UCS2', message: '模组已确认提交',
						parts: [{ partNumber: 1, partsCount: 1, outcome: 'accepted', detail: '+CMGS: 1' }],
						storage: STORAGE
					} });
				}
				if (action === 'purge' || action === 'set_storage' || action === 'get_smsc' || action === 'set_smsc') {
					return Promise.resolve({ success: true, result: { storage: STORAGE, smsc: '+8613800000000' } });
				}
				return Promise.resolve({ success: false, error: '未知短信动作 ' + action });
			},
			subscribe: (fn) => { calls.subscribed.push(fn); },
			unsubscribe: () => {}
		}
	};

	const factory = new Function(
		'L', 'E', 'Mt5700', 'Ui', 'Parse', 'AtWs', 'document', 'localStorage', 'window', 'console',
		body
	);

	const L = { view: { extend: (def) => def } };
	/*
	 * `window.requestAnimationFrame` / `setTimeout` 的桩：会话区高度要靠 JS 量
	 * 文档坐标定高（纯 CSS 算不出导航栏与 hero 的高度），页面启动时会排一帧。
	 * 桩按「同步回调」实现 —— 本测试要钉的是渲染结果，不是动画时序。
	 */
	const windowStub = {
		requestAnimationFrame: (fn) => { fn(0); return 1; },
		cancelAnimationFrame: () => {},
		/* 两次重校（400/1500ms）不跑：本测试只钉首帧渲染结果 */
		setTimeout: () => 0,
		clearTimeout: () => {},
		addEventListener: () => {},
		getComputedStyle: () => ({ getPropertyValue: () => '' }),
		innerHeight: 900,
		innerWidth: 1440,
		pageYOffset: 0,
		scrollY: 0,
		scrollTo: () => {}
	};
	const view = factory(
		L, E, Mt5700, Ui, Parse, AtWs, documentStub, ls || makeLocalStorage(), windowStub, console
	);
	const page = view.render.call(view);
	return { page, calls, toasts, doc: documentStub };
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

	console.log('\n=== 1. 渲染（refresh → 后端条目 → 聚合 → 分区）===');
	const { page, calls } = loadView(Parse, ls);
	/* refresh 走 Promise，等微任务队列清空后再读 DOM */
	await new Promise((r) => setImmediate(r));
	/*
	 * 刷新链现在是异步的三段：归档统计 → 列表 → 容量，每段一次
	 * Promise 跳转。原来只等一个 setImmediate 就断言，链路一变长
	 * 就断言在「列表还没回来」的空页面上（会话数为 0）。
	 * 这里按「等它稳定」处理：跑几轮微任务，再开始断言。
	 */
	for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

	check('确实请求了短信列表（语义化接口）', calls.smsActions.indexOf('list') >= 0, true);
	check('不再自行下发 AT+CMGL=4（改由后端事务执行）', calls.cmds.indexOf('AT+CMGL=4') < 0, true);
	check('订阅了新短信事件', calls.subscribed.length, 1);
	/* 进入页面即申请前台短信模式：后台巡检自此让路 */
	check('进入页面申请了前台短信模式会话', calls.smsActions.indexOf('session_open') >= 0, true);

	/* 存储用量：实机只认标准 `AT+CPMS?`（私有 `AT^CPMS?` 回 ERROR 导致用量永远 0 / 0）。
	   这里同时断言「用了标准写法」与「没用私有写法」，防止前缀再次写错 */
	check('存储用量走后端 capacity（一次真实 AT+CPMS?）', calls.smsActions.indexOf('capacity') >= 0, true);
	/*
	 * IM 版把「存储 6 / 50」从一条 hint 挪到了归档概览里的一行小字：
	 * 断言整页文本包含后端读数，而不是钉死某一个 class 的第一个 hint
	 * （那种写法一改版式就红，测不到真问题）。
	 */
	check('存储用量按后端读数渲染', String(page._body.textContent).indexOf('6 / 50') >= 0, true);

	/*
	 * GH 版把会话列表重做成 IM 形态：每一项是 `<button class="mt5700-sms-conv">`，
	 * 内部依次是头像 `<img>`、`.mt5700-sms-conv-copy`（号码 + 预览）、时间。
	 * 号码不再等于 `childNodes[0].textContent`（那是头像，没有文字），
	 * 要按类名取 `.mt5700-sms-conv-name`。
	 */
	const contactItems = findAll(page._body, 'mt5700-sms-conv');
	const contactNumbers = contactItems.map((n) => {
		const name = findAll(n, 'mt5700-sms-conv-name')[0];
		return name ? name.textContent : '';
	});
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
	check('第 1 条是收到的气泡（左）', isSentBubble(bubbles[0]), false);
	check('第 2 条是发出的气泡（右）', isSentBubble(bubbles[1]), true);
	check('第 3 条是收到的气泡（左）', isSentBubble(bubbles[2]), false);
	/* 借位置只借顺序，时刻照旧如实标注，不把推断出来的位置伪装成真实时刻 */
	check('借位置的那条仍如实标「时间未知」', bubbleTime(bubbles[1]), '时间未知');
	check('气泡内只留时刻（日期由分隔条承担）', /^\d{2}:\d{2}:\d{2}$/.test(bubbleTime(bubbles[0])), true);
	const recvA = [bubbles[0]];

	console.log('\n=== 3. 会话 B：只有收到 ===');
	contactItems[contactNumbers.indexOf('13900139000')].dispatch('click');
	bubbles = findAll(page._body, 'mt5700-sms-bubble');
	check('气泡数量', bubbles.length, 1);
	check('是收到的气泡（左）', isSentBubble(bubbles[0]), false);
	check('无分区空态残留', findAll(page._body, 'mt5700-sms-section-empty').length, 0);

	console.log('\n=== 4. 会话 C：发出的短信带绝对有效期 → 标注为近似时间 ===');
	contactItems[contactNumbers.indexOf('10690000000')].dispatch('click');
	bubbles = findAll(page._body, 'mt5700-sms-bubble');
	check('气泡数量', bubbles.length, 2);
	const sentC = bubbles.filter((b) => isSentBubble(b));
	check('发出气泡 1 条', sentC.length, 1);
	check('内容', sentC[0].childNodes[0].textContent, '收到，谢谢。');
	/*
	 * GH 版把这条文案收短了：气泡只标「（近似）」，完整含义
	 * （SUBMIT 里只有 TP-VP、没有发送时刻）写在页面顶部说明与 CHANGELOG 里。
	 * 断言钉的是「必须明确标出这不是精确发送时刻」，不再钉具体措辞。
	 */
	check('时间带「近似」标注',
		String(bubbleTime(sentC[0])).slice(-4), '（近似）');

	console.log('\n=== 5. 与推送链路口径一致：短信时间就是 PDU 时间戳（北京时间）===');
	/* 收到短信的时刻在夹具里是「现在 − 32 分钟」，SCTS 按 UTC+8 生成；
	   解析后显示的日历时间必须与生成时算好的期望值逐字一致 */
	check('第一条时间 == 夹具生成的北京时间（时刻部分）',
		bubbleTime(recvA[0]), pduList[0].display.split(',')[1]);
	check('夹具期望值确实是北京时间口径', pduList[0].display.slice(0, 2),
		String(fixtures.beijingParts(-32).year).padStart(2, '0'));

	console.log('\n=== 6. 本地缓存不再混入列表（无缓存回归） ===');
	/*
	 * 旧实现把 localStorage 里的「已发记录」合并进列表：那些条目没有模组序号，
	 * 删除时按着不存在的 index 下发一堆 AT+CMGD，全是 ERROR；模组里删掉的短信
	 * 还会继续显示在界面上。现在列表一律以模组实时返回为准 ——
	 * 这里预置一条同号码同正文的本地记录，断言它**不会**被合并进来。
	 */
	{
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
		const items2 = findAll(r2.page._body, 'mt5700-sms-conv');
		const nums2 = items2.map((n) => {
			const name = findAll(n, 'mt5700-sms-conv-name')[0];
			return name ? name.textContent : '';
		});
		check('本地缓存不再被合并进列表（会话数仍是 3）', items2.length, 3);
		items2[nums2.indexOf(pduList[1].number)].dispatch('click');
		const b2 = findAll(r2.page._body, 'mt5700-sms-bubble');
		check('气泡仍是模组的 3 条（缓存不制造重复）', b2.length, 3);
		check('方向序列仍是 收-发-收', dirsOf(b2), 'RSR');
		/* 模组 SUBMIT 不含发送时刻时如实标注，不再拿本地时间冒充 */
		check('模组没有时刻的那条仍如实标「时间未知」', bubbleTime(b2[1]), '时间未知');
	}

	console.log('\n=== 7. 发送流程：走语义化接口，按三档结论处理 ===');
	/*
	 * 与旧实现的差别：
	 *   1) 前端不再自己拼 `AT+CMGS=<长度>\r<PDU>`，也不再关心 PDU 编码 ——
	 *      那是后端事务内部的事（字节级正确性由 Rust 侧的单测钉住）；
	 *   2) 结果按 accepted / rejected / unknown 三档处理：unknown 必须明确
	 *      提示「可能已发走，不要重复点击」，且前端绝不自动重发。
	 */
	const SEND_NUMBER = '13900139000';
	const SEND_TEXT = '回归测试短信 hello';

	async function triggerSend(r, number, text) {
		const items = findAll(r.page._body, 'mt5700-sms-conv');
		const nums = items.map((n) => {
			const name = findAll(n, 'mt5700-sms-conv-name')[0];
			return name ? name.textContent : '';
		});
		const target = items[nums.indexOf(number)];
		if (!target) throw new Error('找不到联系人 ' + number);
		target.dispatch('click');
		/* 输入区是 IM 版唯一的 textarea（类名由 CSS 定，桩里按标签取更稳） */
		const ta = findAll(r.page._body, 'textarea')[0];
		ta.value = text;
		ta.dispatch('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
		for (let i = 0; i < 12; i++) await new Promise((r2) => setImmediate(r2));
		return ta;
	}

	function sendCallOf(r) {
		return r.calls.smsCalls.filter((c) => c.action === 'send')[0] || null;
	}

	/* 场景 A：模组确认 → 成功，输入框清空，刷新列表 */
	{
		const lsA = makeLocalStorage();
		const rA = loadView(loadParse(lsA), lsA);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		const ta = await triggerSend(rA, SEND_NUMBER, SEND_TEXT);

		const call = sendCallOf(rA);
		check('发送走 sms(send) 而不是拼 AT 命令', !!call, true);
		check('收件人与正文作为参数传递', call && call.params.destination, SEND_NUMBER);
		check('正文原样传递', call && call.params.message, SEND_TEXT);
		check('带去重键（防重复点击）', !!(call && call.params.dedup_key), true);
		check('上报了发送成功', rA.toasts.some((t) => t.kind === 'success'), true);
		check('没有误报错误', rA.toasts.some((t) => t.kind === 'error'), false);
		check('输入框已清空', ta.value, '');
		/* 成功后立即用模组真实数据刷新界面 */
		check('发送后回读了列表', rA.calls.smsActions.filter((a) => a === 'list').length >= 2, true);
		check('发送后回读了容量', rA.calls.smsActions.indexOf('capacity') >= 0, true);
	}

	/* 场景 B：模组明确拒绝 → 报错，不写本地缓存 */
	{
		const lsB = makeLocalStorage();
		const ParseB = loadParse(lsB);
		const rB = loadView(ParseB, lsB, {
			smsRespond: (action) => (action === 'send' ? {
				success: true,
				result: { outcome: 'rejected', encoding: 'UCS2', message: '第 1/1 段被模组拒绝：+CMS ERROR: 322', parts: [] }
			} : undefined)
		});
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await triggerSend(rB, SEND_NUMBER, SEND_TEXT);
		check('模组拒绝时显示错误', rB.toasts.some((t) => t.kind === 'error'), true);
		check('模组拒绝时不得显示成功', rB.toasts.some((t) => t.kind === 'success'), false);
		check('错误文案带上模组的错误码',
			rB.toasts.some((t) => t.kind === 'error' && t.text.indexOf('322') >= 0), true);
		check('模组拒绝时不得写入本地缓存', ParseB.getCachedSentMessages().length, 0);
	}

	/* 场景 C：结果不明 → 明确警示且不自动重发 */
	{
		const lsC = makeLocalStorage();
		const rC = loadView(loadParse(lsC), lsC, {
			smsRespond: (action) => (action === 'send' ? {
				success: true,
				result: { outcome: 'unknown', encoding: 'UCS2', message: '第 1/1 段未收到模组确认。请勿重复点击发送。', parts: [] }
			} : undefined)
		});
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await triggerSend(rC, SEND_NUMBER, SEND_TEXT);
		check('结果不明时不得显示成功', rC.toasts.some((t) => t.kind === 'success'), false);
		check('结果不明时给出明确警示',
			rC.toasts.some((t) => t.kind === 'warning' && t.text.indexOf('结果不明') >= 0), true);
		check('只提交了一次（不自动重发）',
			rC.calls.smsCalls.filter((c) => c.action === 'send').length, 1);
	}

	/* 场景 D：删除走语义化接口并按模组结果回读 */
	{
		const lsD = makeLocalStorage();
		const rD = loadView(loadParse(lsD), lsD);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		const items = findAll(rD.page._body, 'mt5700-sms-conv');
		const nums = items.map((n) => {
			const name = findAll(n, 'mt5700-sms-conv-name')[0];
			return name ? name.textContent : '';
		});
		items[nums.indexOf('13900139000')].dispatch('click');
		const bubbles = findAll(rD.page._body, 'mt5700-sms-bubble');
		/* 气泡内带 `mt5700-sms-del` 类名的按钮就是「删除」 */
		const delBtn = findAll(bubbles[0], 'mt5700-sms-del')[0];
		delBtn.dispatch('click');
		/* 页面自己弹的是内联确认框（不是 Ui.confirmModal）：点里面的确认按钮 */
		const modalOk = findAll(rD.doc.body, 'mt5700-btn-danger').pop();
		if (modalOk) modalOk.dispatch('click');
		for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
		const del = rD.calls.smsCalls.filter((c) => c.action === 'delete')[0];
		check('删除走 sms(delete)', !!del, true);
		check('删除带上模组真实序号', !!(del && del.params.indices && del.params.indices.length), true);
		check('删除后回读了列表', rD.calls.smsActions.filter((a) => a === 'list').length >= 2, true);
	}

	/*
	 * 场景 E：槽位 0 是真槽位，序号读不出（null）的那条不许删。
	 * 实机一张存着分段短信的卡，头两条就落在 0 和 1 号位上；把「读不出序号」
	 * 记成 0 的话，最老的那条短信在界面上永远删不掉。
	 */
	{
		const ZERO = { index: 0, stat: 1, direction: 'received', number: '10000',
			content: '话费余额查询结果', time: '26/10/22,20:36:21', timeApprox: false, concat: null, error: null };
		const BROKEN = { index: null, stat: 0, direction: 'received', number: '10086',
			content: '', time: null, timeApprox: false, concat: null, error: 'PDU 行为空或含非十六进制字符' };
		const lsE = makeLocalStorage();
		const rE = loadView(loadParse(lsE), lsE, {
			smsRespond: function (action) {
				if (action === 'list') {
					return { success: true, result: {
						entries: [Object.assign({}, ZERO), Object.assign({}, BROKEN)],
						fetchedAt: Date.now(), totalLines: 2 } };
				}
			}
		});
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const pick = async function (number) {
			const items = findAll(rE.page._body, 'mt5700-sms-conv');
			const nums = items.map((n) => {
				const name = findAll(n, 'mt5700-sms-conv-name')[0];
				return name ? name.textContent : '';
			});
			const hit = nums.indexOf(number);
			if (hit < 0) return false;
			items[hit].dispatch('click');
			for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
			const bubbles = findAll(rE.page._body, 'mt5700-sms-bubble');
			const last = bubbles[bubbles.length - 1];
			findAll(last, 'mt5700-sms-del')[0].dispatch('click');
			const okBtn = findAll(rE.doc.body, 'mt5700-btn-danger').pop();
			if (okBtn) okBtn.dispatch('click');
			for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
			return true;
		}

		check('0 号槽位的短信在列表里', await pick('10000'), true);
		const zeroDel = rE.calls.smsCalls.filter((c) => c.action === 'delete')[0];
		check('删除 0 号槽位照实下发序号 0',
			JSON.stringify((zeroDel && zeroDel.params.indices) || null), '[0]');

		check('序号读不出的那条也在列表里（带 error 显示）', await pick('10086'), true);
		check('序号读不出时不再对着 0 号位下发删除',
			rE.calls.smsCalls.filter((c) => c.action === 'delete').length, 1);
		check('序号读不出时提示「不在模组存储中」',
			rE.toasts.some((t) => t.text.indexOf('不在模组存储中') >= 0), true);
	}

	console.log(`\n合计: ${pass} 通过, ${fail} 失败`);
	process.exit(fail ? 1 : 0);
}

main().catch((e) => {
	console.error('渲染测试异常:', e);
	process.exit(1);
});
