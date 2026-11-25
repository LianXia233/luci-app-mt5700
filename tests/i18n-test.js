#!/usr/bin/env node
/*
 * i18n 门禁：
 *   1) po 模板与 zh_Hans 目录的 msgid 集合必须一致，且无重复；
 *   2) zh_Hans 的每条 msgstr 都不能为空（identity 翻译也要显式写出）；
 *   3) menu.d 的每个标题都必须出现在 po 中，避免菜单出现未翻译项；
 *   4) 共享 UI 组件（page/card/button/formGroup/input/select/empty/toast）
 *      必须经过 tr()，保证以后新增语言只补 po 即可覆盖这些文案。
 *
 * 这里不校验页面正文的硬编码中文：正文仍以中文为源串，属于后续增量迁移。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const potPath = path.join(root, 'po/templates/luci-app-mt5700.pot');
const poPath = path.join(root, 'po/zh_Hans/luci-app-mt5700.po');
const menuPath = path.join(root, 'root/usr/share/luci/menu.d/luci-app-mt5700.json');
const uiPath = path.join(root, 'htdocs/luci-static/resources/mt5700d/mt5700.js');

let failures = 0;
function check(name, ok, detail) {
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '\n        ' + detail));
	if (!ok) failures++;
}

/* ---------- 极简 PO 解析 ---------- */
function unquote(s) {
	s = s.trim();
	if (!s.startsWith('"')) return s;
	try {
		return JSON.parse(s);
	} catch (e) {
		return s.slice(1, -1);
	}
}

function parsePo(text, file) {
	const entries = [];
	let cur = null;
	let field = null;

	function push() {
		if (!cur) return;
		entries.push(cur);
		cur = null;
		field = null;
	}

	text.split(/\r?\n/).forEach(function (line, i) {
		if (/^\s*$/.test(line) || /^#/.test(line)) {
			push();
			return;
		}
		let m = line.match(/^msgid\s+(.*)$/);
		if (m) {
			if (cur && (cur.msgid || cur.msgstr)) push();
			cur = { msgid: unquote(m[1]), msgstr: '', file: file, line: i + 1 };
			field = 'msgid';
			return;
		}
		m = line.match(/^msgstr\s+(.*)$/);
		if (m) {
			if (!cur) cur = { msgid: '', msgstr: '', file: file, line: i + 1 };
			cur.msgstr += unquote(m[1]);
			field = 'msgstr';
			return;
		}
		if (/^"/.test(line.trim()) && cur) {
			if (field === 'msgid') cur.msgid += unquote(line);
			else if (field === 'msgstr') cur.msgstr += unquote(line);
		}
	});
	push();
	return entries.filter(function (e) { return e.msgid !== ''; });
}

const potEntries = parsePo(fs.readFileSync(potPath, 'utf8'), 'pot');
const poEntries = parsePo(fs.readFileSync(poPath, 'utf8'), 'po');

const potIds = potEntries.map(function (e) { return e.msgid; });
const poIds = poEntries.map(function (e) { return e.msgid; });

const dupPot = potIds.filter(function (id, i) { return potIds.indexOf(id) !== i; });
const dupPo = poIds.filter(function (id, i) { return poIds.indexOf(id) !== i; });
check('PO 模板无重复 msgid', dupPot.length === 0, dupPot.join(', '));
check('zh_Hans 无重复 msgid', dupPo.length === 0, dupPo.join(', '));

const onlyPot = potIds.filter(function (id) { return poIds.indexOf(id) < 0; });
const onlyPo = poIds.filter(function (id) { return potIds.indexOf(id) < 0; });
check('PO 模板与 zh_Hans 的 msgid 集合一致',
	onlyPot.length === 0 && onlyPo.length === 0,
	(onlyPot.length ? '仅模板有: ' + onlyPot.join(' | ') + '; ' : '') +
	(onlyPo.length ? '仅 zh_Hans 有: ' + onlyPo.join(' | ') : ''));

const emptyPo = poEntries.filter(function (e) { return e.msgstr === ''; });
check('zh_Hans 每条 msgstr 非空', emptyPo.length === 0,
	emptyPo.map(function (e) { return e.msgid; }).join(' | '));

/* ---------- 菜单标题必须可翻译 ---------- */
const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
const titles = [];
Object.keys(menu).forEach(function (key) {
	if (menu[key] && menu[key].title) titles.push(menu[key].title);
});
const missingTitles = titles.filter(function (t) { return poIds.indexOf(t) < 0; });
check('menu.d 标题均在 zh_Hans 中（' + titles.length + ' 条）',
	missingTitles.length === 0, missingTitles.join(' | '));

/* ---------- 共享组件必须走 tr() ---------- */
const ui = fs.readFileSync(uiPath, 'utf8');
check('mt5700.js 定义 trText() 且兼容无 LuCI 的 Node 环境',
	/function trText\(s\)/.test(ui) && /typeof _ === 'function'/.test(ui),
	'缺少 trText() 或全局 _ 的类型保护');
check('trText 未被局部变量遮蔽（避免 tr is not a function）',
	!/\bvar\s+trText\b/.test(ui), '存在 var trText，可能遮蔽翻译函数');

const components = [
	'api.page', 'api.card', 'api.button', 'api.formGroup',
	'api.input', 'api.select', 'api.empty', 'api.toast'
];
const notWrapped = components.filter(function (name) {
	const idx = ui.indexOf(name + ' = function');
	if (idx < 0) return true;
	const body = ui.slice(idx, idx + 1200);
	return body.indexOf('trText(') < 0;
});
check('共享组件文案经过 trText()（' + components.length + ' 个）',
	notWrapped.length === 0,
	'未接入: ' + notWrapped.join(', '));

console.log('');
if (failures) {
	console.log('FAILED ' + failures);
	process.exit(1);
}
console.log('ALL PASSED');
