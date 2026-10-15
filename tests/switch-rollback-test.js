'use strict';
/**
 * 开关回滚单测（Codex P2）
 *
 * 场景：模组拒绝 AT^THERMAUTOFUN（或请求失败）时，CA/MIMO 等开关必须把
 * checkbox 恢复到操作前的状态，否则界面会长期显示与模组实际策略相反的值。
 *
 * 做法：从 modem_settings.js 中抽出 makeSwitch 源码，在 node 里用 mock DOM 驱动，
 * 分别覆盖「成功 / 模组拒绝 / 请求 reject / handler 抛异常 / 老式 handler」五条路径。
 *
 * 运行：node tests/switch-rollback-test.js
 */

const fs = require('fs');
const path = require('path');

const viewDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');
const code = fs.readFileSync(path.join(viewDir, 'modem_settings.js'), 'utf8');

const start = code.indexOf('function makeSwitch');
const end = code.indexOf('function atText');
if (start < 0 || end < 0) {
	console.log('FAIL  未能在 modem_settings.js 中定位 makeSwitch');
	process.exit(1);
}

/* 极简 DOM 替身：够 makeSwitch 用即可 */
function mockE(tag, attrs) {
	return {
		tag: tag,
		attrs: attrs || {},
		children: [],
		listeners: {},
		checked: false,
		appendChild: function (child) { this.children.push(child); return child; },
		addEventListener: function (type, fn) {
			this.listeners[type] = this.listeners[type] || [];
			this.listeners[type].push(fn);
		},
		querySelector: function (sel) {
			if (sel === 'input') return this.children.filter(function (c) { return c.tag === 'input'; })[0] || null;
			return null;
		},
		fire: function (type) {
			(this.listeners[type] || []).forEach(function (fn) { fn(); });
		}
	};
}

const factory = new Function('E', code.slice(start, end) + '\n;return makeSwitch;');
const makeSwitch = factory(mockE);

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

/* 等待 makeSwitch 内部的 Promise 链排空 */
function flush() {
	return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function build(onChange) {
	const wrap = makeSwitch(onChange);
	const input = wrap.querySelector('input');
	return { wrap: wrap, input: input };
}

async function main() {
	// 1. 模组接受指令：勾选保持新状态
	{
		const s = build(function () { return Promise.resolve(true); });
		s.input.checked = true;
		s.input.fire('change');
		await flush();
		check('写入成功时保持新勾选状态', s.input.checked === true, 'checked=' + s.input.checked);
	}

	// 2. 模组拒绝指令（success=false）：必须回滚（Codex P2 主场景）
	{
		const s = build(function () { return Promise.resolve(false); });
		s.input.checked = true;
		s.input.fire('change');
		await flush();
		check('模组拒绝时回滚勾选状态', s.input.checked === false, 'checked=' + s.input.checked);
	}

	// 3. 请求 reject（超时 / 后端异常）：同样回滚
	{
		const s = build(function () { return Promise.reject(new Error('timeout')); });
		s.input.checked = true;
		s.input.fire('change');
		await flush();
		check('请求异常 (reject) 时回滚勾选状态', s.input.checked === false, 'checked=' + s.input.checked);
	}

	// 4. handler 同步抛异常：回滚
	{
		const s = build(function () { throw new Error('boom'); });
		s.input.checked = true;
		s.input.fire('change');
		await flush();
		check('handler 抛异常时回滚勾选状态', s.input.checked === false, 'checked=' + s.input.checked);
	}

	// 5. 关闭方向的回滚（true -> false 失败后应回到 true）
	{
		const s = build(function () { return Promise.resolve(false); });
		s.input.checked = false;
		s.input.fire('change');
		await flush();
		check('取消勾选失败时回滚为已勾选', s.input.checked === true, 'checked=' + s.input.checked);
	}

	// 6. 老式 handler（返回 undefined）：保持向后兼容，不自动回滚
	{
		const s = build(function () { return undefined; });
		s.input.checked = true;
		s.input.fire('change');
		await flush();
		check('无返回值 handler 不触发自动回滚 (向后兼容)', s.input.checked === true, 'checked=' + s.input.checked);
	}
}

main().catch(function (e) {
	check('单测执行', false, String((e && e.stack) || e));
}).then(function () {
	const fails = results.filter(function (r) { return !r.ok; });
	console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
	if (fails.length) {
		fails.forEach(function (f) { console.log('FAILED: ' + f.name + ' — ' + f.detail); });
		process.exit(1);
	}
	process.exit(0);
});
