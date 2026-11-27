'use strict';
/**
 * terminal.js 渲染行为测试：用极简 DOM mock 真正执行视图的 render / 过滤 / 发送，
 * 补齐静态源码断言覆盖不到的运行时路径。
 *
 * 覆盖：命令按钮数量、分组折叠、搜索过滤（含常用卡不参与）、发送中禁用按钮、
 *       危险命令二次确认文案、空状态。
 * 运行：node tests/terminal-render-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok });
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  <- ' + detail));
}

function node(tag, attrs, children) {
	const n = {
		tagName: tag, attrs: attrs || {}, children: children || [], style: {},
		textContent: '', innerHTML: '', open: false, disabled: false, _listeners: {},
		_classes: new Set(String((attrs && attrs.class) || '').split(/\s+/).filter(Boolean)),
		appendChild(c) { this.children.push(c); return c; },
		removeChild(c) { this.children = this.children.filter((x) => x !== c); },
		setAttribute(k, v) { this.attrs[k] = v; },
		getAttribute(k) { return this.attrs[k]; },
		addEventListener(k, fn) { (this._listeners[k] = this._listeners[k] || []).push(fn); },
		fire(k, ev) { (this._listeners[k] || []).forEach((f) => f(ev || { key: 'Enter' })); },
		querySelectorAll(sel) {
			const m = sel.match(/^\.([\w-]+):not\(\.([\w-]+)\)$/);
			const all = [];
			const walk = (x) => { (x.children || []).forEach((c) => { if (!c || !c._classes) return; all.push(c); walk(c); }); };
			walk(this);
			if (!m) return all;
			return all.filter((c) => c._classes.has(m[1]) && !c._classes.has(m[2]));
		},
		classList: null
	};
	n.classList = {
		add(c) { n._classes.add(c); },
		remove(c) { n._classes.delete(c); },
		contains(c) { return n._classes.has(c); },
		toggle(c, force) {
			const on = force === undefined ? !n._classes.has(c) : !!force;
			if (on) n._classes.add(c); else n._classes.delete(c);
			return on;
		}
	};
	return n;
}

const all = [];
const E = (tag, attrs, ...kids) => {
	const flat = [];
	kids.forEach((k) => {
		if (k == null) return;
		if (Array.isArray(k)) flat.push(...k); else flat.push(k);
	});
	const n = node(tag, attrs, flat);
	all.push(n);
	return n;
};

const confirmCalls = [];
const Mt5700 = {
	page: () => ({ _body: E('div', { class: 'page' }) }),
	card: () => {
		const c = E('div', { class: 'card' });
		c._body = E('div', { class: 'card-body' });
		c.appendChild(c._body);
		return c;
	},
	input: (type, ph) => E('input', { type, placeholder: ph }),
	button: (l, fn) => E('button', {}, l),
	primaryButton: (l, fn) => E('button', {}, l),
	ghostButton: (l, fn) => E('button', {}, l),
	dangerButton: (l, fn) => E('button', {}, l),
	empty: (t) => E('div', {}, t),
	warning() {}, error() {}, success() {},
	confirm(message, onOk, okText) {
		confirmCalls.push({ message, onOk, okText });
	}
};

let resolveSend;
let sendCalls = [];
const ctx = {
	L: { view: { extend: (o) => o } },
	E,
	Mt5700,
	Mt5700d: {
		client: {
			sendCommand: (cmd) => { sendCalls.push(cmd); return new Promise((r) => { resolveSend = r; }); }
		},
		serverClock: () => '12:00:00'
	},
	Ui: { startup() {}, promptModal() {} },
	window: { AtIcons: { build: (name, opts) => E('svg', { class: opts.className }) } },
	console
};
ctx.globalThis = ctx;

const src = fs.readFileSync(path.join(root, 'htdocs/luci-static/resources/view/mt5700d/terminal.js'), 'utf8');
vm.createContext(ctx);
const wrapper = vm.runInContext('(function(){' + src + '\n})()', ctx);
const page = wrapper.render();

const cmds = all.filter((n) => n.attrs['data-mt-cmd']);
const quick = cmds.filter((n) => n._classes.has('mt5700-cmd-quick'));
const chips = cmds.filter((n) => n._classes.has('mt5700-cmd-chip'));
const details = all.filter((n) => n.tagName === 'details');
const search = all.find((n) => n.attrs.placeholder && n.attrs.placeholder.indexOf('搜索命令名') >= 0);
const visible = () => cmds.filter((n) => !n._classes.has('mt5700-cmd-hidden'));

/* 1) 渲染结构 */
check('render 返回页面对象', !!page && !!page._body);
check('命令按钮共 55 条（9 常用 + 46 分组）', cmds.length === 55, '实际 ' + cmds.length);
check('常用命令 9 条', quick.length === 9, '实际 ' + quick.length);
check('分组命令 46 条', chips.length === 46, '实际 ' + chips.length);
check('折叠分组 8 个', details.length === 8, '实际 ' + details.length);
check('危险命令 4 条', cmds.filter((n) => n._classes.has('mt5700-cmd-chip-danger')).length === 4);
check('超时命令未被收录为按钮',
	!cmds.some((n) => /AT\+COPS=\?|AT\+COPN/.test(n.attrs['data-mt-cmd'])));

/* 2) 搜索过滤：只作用于分组命令 */
check('存在搜索输入框', !!search);
if (search) {
	search.value = 'RESET';
	search.fire('input');
	const shown = chips.filter((n) => !n._classes.has('mt5700-cmd-hidden'));
	check('搜索 RESET 分组内只留下 AT^RESET', shown.length === 1 && shown[0].attrs['data-mt-cmd'] === 'AT^RESET',
		shown.map((n) => n.attrs['data-mt-cmd']).join(','));
	check('搜索时自动展开命中分组', details.filter((d) => d.open).length === 1);
	check('常用命令不参与搜索（9 条仍全部可见）',
		quick.filter((n) => !n._classes.has('mt5700-cmd-hidden')).length === 9);

	search.value = '';
	search.fire('input');
	check('清空后 55 条全部恢复', visible().length === 55, '实际 ' + visible().length);
	check('清空后分组内 46 条全部恢复',
		chips.filter((n) => !n._classes.has('mt5700-cmd-hidden')).length === 46);
	check('清空后保留用户已展开的分组', details.filter((d) => d.open).length === 1);
}

/* 3) 点击确认与发送状态 */
const resetBtn = cmds.find((n) => n.attrs['data-mt-cmd'] === 'AT^RESET');
check('找到模组重启按钮', !!resetBtn);
if (resetBtn) {
	resetBtn.fire('click');
	check('写操作使用强化确认文案',
		confirmCalls.length === 1
		&& /谨慎操作/.test(confirmCalls[0].message)
		&& confirmCalls[0].okText === '确认下发写操作');
	if (confirmCalls.length === 1) confirmCalls[0].onOk();
	check('确认后才下发命令', sendCalls.length === 1 && sendCalls[0] === 'AT^RESET');
	check('发送中所有命令按钮禁用', cmds.every((n) => n.disabled === true));
	if (resolveSend) resolveSend({ success: true, data: 'OK', at_ms: 1 });
}

setTimeout(() => {
	check('应答到达后命令按钮恢复可用', cmds.every((n) => n.disabled === false));
	const failed = results.filter((r) => !r.ok);
	console.log('\n' + (failed.length ? 'FAILED ' + failed.length : 'ALL ' + results.length + ' PASSED'));
	process.exit(failed.length ? 1 : 0);
}, 0);
