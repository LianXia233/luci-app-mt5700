'use strict';
/*
 * 抽屉交互冒烟测试（手动运行，不纳入 CI）。
 *
 * 验证 config-drawer.js 的核心交互契约：防误触（遮罩/外部点击不关闭）、ESC
 * 未保存二次确认、保存成功/失败/校验拦截、焦点管理、资源清理、滚动锁定。
 *
 * 之所以放在 tests/manual/ 且不以 -test.js 结尾：它需要 jsdom 这个外部依赖，
 * 而 tests/*-test.js 是零依赖门禁、会被 CI 自动发现。此脚本不破坏该约定。
 *
 * 运行方式：
 *   cd /tmp && mkdir drawer-smoke && cd drawer-smoke
 *   npm install jsdom@24
 *   node /path/to/luci-app-mt5700/tests/manual/drawer-smoke.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const REPO = path.resolve(__dirname, '..', '..');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;

// 最小 E() 实现
function E(tag, attrs, text) {
	const el = document.createElement(tag);
	if (attrs) Object.keys(attrs).forEach(k => {
		if (k === 'class') el.className = attrs[k];
		else if (k === 'style') el.setAttribute('style', attrs[k]);
		else el.setAttribute(k, attrs[k]);
	});
	if (text != null) el.textContent = text;
	return el;
}

let markDirtyCalled = 0, clearDirtyCalled = 0, uciSaveResolve = true;
const AtWs = {
	uci: {
		markDirty() { markDirtyCalled++; },
		clearDirty() { clearDirtyCalled++; },
		uciSave() { return uciSaveResolve ? Promise.resolve({ applied: true }) : Promise.reject(new Error('写入失败 XYZ')); }
	}
};
const L = {
	Class: {
		extend(obj) { function C() { Object.assign(this, obj); } C.prototype = obj; return C; }
	},
	uci: { set() {} }
};
const Mt5700 = {
	button(label, onClick, variant) {
		const b = E('button', { class: 'mt5700-btn mt5700-btn-' + (variant || 'secondary') }, label);
		if (onClick) b.addEventListener('click', onClick);
		return b;
	},
	primaryButton(label, onClick) { return this.button(label, onClick, 'primary'); }
};
global.L = L; global.E = E; global.AtWs = AtWs; global.Mt5700 = Mt5700;
window.L = L; window.E = E;

// 用 vm 在全局上下文执行模块源码
const vm = require('vm');
const ctx = vm.createContext(global);
const src = fs.readFileSync(path.join(REPO, 'htdocs/luci-static/resources/at-webserver/config-drawer.js'), 'utf8');
// LuCI 把模块体包在函数里执行以支持顶层 return；这里照做
vm.runInContext('(function(){' + src + '\n})()', ctx, { filename: 'config-drawer.js' });
const Drawer = window.MtConfigDrawer;
if (!Drawer || typeof Drawer.open !== 'function') throw new Error('Drawer 未正确导出 open');

let pass = 0, fail = 0;
function check(name, cond) {
	console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
	cond ? pass++ : fail++;
}
function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
function esc() { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }

function makeController(state) {
	return {
		load() { state.loaded = true; },
		validate() { return state.badInput ? '输入非法' : null; },
		save(set) { if (state.throwOnSave) throw new Error('save boom'); state.saved = true; },
		isDirty() { return !!state.dirty; },
		onClose() { state.cleaned = true; }
	};
}

(async function () {
	// 1. 打开：渲染、聚焦、load 调用
	let st = { dirty: false };
	let d = Drawer.open({ title: '测试抽屉', subtitle: '说明', render(body) {
		body.appendChild(E('input', { type: 'text' }));
		return makeController(st);
	} });
	check('打开后 mask 挂到 body', !!document.querySelector('.mt5700-drawer-mask'));
	check('打开后调用 load', st.loaded === true);
	check('打开后 body 滚动锁定', document.body.style.overflow === 'hidden');
	check('焦点落在面板内首个可聚焦控件', document.querySelector('.mt5700-drawer').contains(document.activeElement));

	// 2. 点击遮罩不关闭
	click(document.querySelector('.mt5700-drawer-mask'));
	check('点击遮罩不关闭', !!document.querySelector('.mt5700-drawer-mask'));

	// 3. 点击内容区空白处不关闭
	click(document.querySelector('.mt5700-drawer-body'));
	check('点击内容区不关闭', !!document.querySelector('.mt5700-drawer-mask'));

	// 4. 无脏数据 ESC 直接关闭 + 资源清理
	esc();
	check('无未保存时 ESC 关闭', !document.querySelector('.mt5700-drawer-mask'));
	check('关闭时调用模块 onClose 清理', st.cleaned === true);
	check('关闭后恢复 body 滚动', document.body.style.overflow !== 'hidden');

	// 5. 有脏数据 ESC 弹二次确认，不直接关闭
	st = { dirty: true };
	d = Drawer.open({ title: '脏数据', render(body) { body.appendChild(E('input', { type: 'text' })); return makeController(st); } });
	esc();
	check('有未保存时 ESC 弹出确认', document.querySelector('.mt5700-drawer-confirm').style.display !== 'none');
	check('有未保存时 ESC 不直接关闭', !!document.querySelector('.mt5700-drawer-mask'));
	// 点击「继续编辑」保持打开
	const cont = Array.from(document.querySelectorAll('.mt5700-drawer-confirm button')).find(b => b.textContent === '继续编辑');
	click(cont);
	check('继续编辑后保持打开', !!document.querySelector('.mt5700-drawer-mask'));
	// 再 ESC → 放弃修改 → 关闭
	esc();
	const giveUp = Array.from(document.querySelectorAll('.mt5700-drawer-confirm button')).find(b => b.textContent === '放弃修改');
	click(giveUp);
	check('放弃修改后关闭', !document.querySelector('.mt5700-drawer-mask'));
	check('放弃修改也清理资源', st.cleaned === true);

	// 6. 保存流程：成功
	st = { dirty: true };
	markDirtyCalled = 0; clearDirtyCalled = 0; uciSaveResolve = true;
	d = Drawer.open({ title: '保存测试', render(body) { body.appendChild(E('input', { type: 'text' })); return makeController(st); } });
	const saveBtn = Array.from(document.querySelectorAll('.mt5700-drawer-foot button')).find(b => b.textContent === '保存');
	click(saveBtn);
	await new Promise(r => setTimeout(r, 20));
	check('保存调用模块 save', st.saved === true);
	check('保存调用 clearDirty', clearDirtyCalled === 1);
	check('保存成功后关闭', !document.querySelector('.mt5700-drawer-mask'));

	// 7. 保存失败：保留数据、不关闭、显示错误
	st = { dirty: true };
	uciSaveResolve = false;
	d = Drawer.open({ title: '失败测试', render(body) { body.appendChild(E('input', { type: 'text', value: '用户数据' })); return makeController(st); } });
	const saveBtn2 = Array.from(document.querySelectorAll('.mt5700-drawer-foot button')).find(b => b.textContent === '保存');
	click(saveBtn2);
	await new Promise(r => setTimeout(r, 20));
	check('保存失败不关闭', !!document.querySelector('.mt5700-drawer-mask'));
	check('保存失败显示具体错误', document.querySelector('.mt5700-drawer-err').textContent.indexOf('写入失败 XYZ') >= 0);
	check('保存失败保留用户输入', document.querySelector('.mt5700-drawer-body input').value === '用户数据');

	// 8. validate 拦截（先关闭第 7 步遗留的抽屉：dirty 会弹确认 → 放弃）
	if (document.querySelector('.mt5700-drawer-mask')) {
		document.querySelector('.mt5700-drawer-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		const gu = Array.from(document.querySelectorAll('.mt5700-drawer-confirm button')).find(b => b.textContent === '放弃修改');
		if (gu) click(gu);
	}
	await new Promise(r => setTimeout(r, 10));
	st = { dirty: false, badInput: true };
	uciSaveResolve = true;
	d = Drawer.open({ title: '校验测试', render(body) { body.appendChild(E('input', { type: 'text' })); return makeController(st); } });
	const saveBtn3 = Array.from(document.querySelectorAll('.mt5700-drawer-foot button')).find(b => b.textContent === '保存');
	click(saveBtn3);
	check('validate 失败阻止保存', document.querySelector('.mt5700-drawer-err').textContent.indexOf('输入非法') >= 0);
	check('validate 失败不关闭', !!document.querySelector('.mt5700-drawer-mask'));

	console.log('\n===== 抽屉交互冒烟: ' + pass + '/' + (pass + fail) + ' 通过 =====');
	process.exit(fail ? 1 : 0);
})().catch(e => { console.error('EXCEPTION', e); process.exit(1); });
