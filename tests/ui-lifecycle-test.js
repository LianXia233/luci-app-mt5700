'use strict';
/**
 * ui.js 生命周期单测（本次前端整理新增）
 *
 * ATClient 是全页面单例，而 Ui.startup() 每次进入页面都会注册一个捕获本页
 * body 与 onReady 的连接状态回调。这里用 DOM 桩跑真实 ui.js，钉住两件事：
 *   · 切入页面注册 1 个回调；
 *   · 离场（hashchange）后注销，回调数组不随切页次数增长（修复前只增不减）。
 *
 * 运行：node tests/ui-lifecycle-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
	if (cond) { pass++; console.log('PASS  ' + name); }
	else { fail++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

/* ---------- 最小 DOM 桩 ---------- */
function makeEl(tag) {
	const el = {
		tag: tag, nodeType: 1, attrs: {}, children: [], style: {},
		parentNode: null, firstChild: null,
		setAttribute: function (k, v) { this.attrs[k] = String(v); },
		appendChild: function (c) { c.parentNode = this; this.children.push(c); this.firstChild = this.children[0]; return c; },
		insertBefore: function (c, ref) {
			c.parentNode = this;
			const i = this.children.indexOf(ref);
			if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
			this.firstChild = this.children[0];
			return c;
		},
		removeChild: function (c) {
			const i = this.children.indexOf(c);
			if (i >= 0) this.children.splice(i, 1);
			c.parentNode = null;
			this.firstChild = this.children[0] || null;
			return c;
		},
		addEventListener: function () { },
		removeEventListener: function () { },
		getBoundingClientRect: function () { return { top: 0, bottom: 0, height: 0, width: 0 }; },
		classList: {
			add: function () { }, remove: function () { }, toggle: function () { },
			contains: function () { return false; }
		}
	};
	return el;
}

function makeEnv() {
	const handlers = {};
	const body = makeEl('div');
	const windowStub = {
		innerWidth: 1280, innerHeight: 900,
		getComputedStyle: function () { return { position: 'static' }; },
		addEventListener: function (t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
		removeEventListener: function () { },
		setTimeout: setTimeout,
		location: { pathname: '/cgi-bin/luci/admin/modem/5g/status' }
	};
	const documentStub = {
		documentElement: makeEl('html'),
		body: makeEl('body'),
		readyState: 'complete',
		querySelectorAll: function () { return []; },
		createElement: function (t) { return makeEl(t); },
		addEventListener: function () { }
	};
	function E(tag, attrs, children) {
		const el = makeEl(tag);
		if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
		if (children != null) {
			(Array.isArray(children) ? children : [children]).forEach(function (c) {
				if (typeof c === 'string') el.textContent = (el.textContent || '') + c;
				else if (c) el.appendChild(c);
			});
		}
		return el;
	}
	function fire(type) {
		(handlers[type] || []).slice().forEach(function (fn) { fn({ type: type }); });
	}
	return { body: body, windowStub: windowStub, documentStub: documentStub, E: E, fire: fire };
}

/* ---------- 连接状态回调在离场后注销 ---------- */
(async function () {
	const env = makeEnv();
	const src = fs.readFileSync(path.join(libDir, 'ui.js'), 'utf8');
	const factory = new Function('L', 'document', 'window', 'E', 'AtWs', 'AtTheme', src);
	const L_STUB = { Class: { extend: function (o) { return function UiClass() { Object.assign(this, o); }; } } };

	const AtWs = {
		client: {
			state: 'degraded',
			error: 'unit-test',
			backendKnownDown: false,
			circuitOpenUntil: 0,
			stateCallbacks: [],
			onConnectionStateChange: function (cb) { this.stateCallbacks.push(cb); cb(this.state, this.error); },
			offConnectionStateChange: function (cb) {
				const i = this.stateCallbacks.indexOf(cb);
				if (i >= 0) this.stateCallbacks.splice(i, 1);
			},
			connect: function () { return Promise.resolve(); }
		}
	};

	const Ui = new (factory(L_STUB, env.documentStub, env.windowStub, env.E, AtWs, null))();
	check('rpc.js 新增 offConnectionStateChange 后 ui.js 有对应注销点',
		typeof AtWs.client.offConnectionStateChange === 'function');

	const tick = () => new Promise((r) => setTimeout(r, 5));

	Ui.startup(env.body, function () { });
	check('降级态 startup 注册 2 个回调（startup 自身 + 提示条）',
		AtWs.client.stateCallbacks.length === 2, '实际 ' + AtWs.client.stateCallbacks.length);
	check('降级态下提示条已插入页面', env.body.children.length === 1,
		'实际 ' + env.body.children.length);

	env.fire('hashchange');
	await tick();
	check('离场后回调归零', AtWs.client.stateCallbacks.length === 0,
		'实际 ' + AtWs.client.stateCallbacks.length);
	check('离场后提示条一并摘除', env.body.children.length === 0,
		'实际 ' + env.body.children.length);

	for (let i = 0; i < 5; i++) {
		Ui.startup(env.body, function () { });
		env.fire('hashchange');
		await tick();
	}
	check('反复切页 5 次后仍为 0（修复前会累积到 12）',
		AtWs.client.stateCallbacks.length === 0, '实际 ' + AtWs.client.stateCallbacks.length);

	console.log('\n' + pass + ' passed, ' + fail + ' failed');
	process.exit(fail ? 1 : 0);
})();
