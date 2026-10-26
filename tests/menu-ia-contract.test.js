#!/usr/bin/env node
'use strict';

/**
 * 菜单信息架构契约（2026-10-26）
 * ============================================================================
 * 起因：12 个页面平铺在同一个菜单层级下，要找「短信设置」得在 12 行里数。
 * 重组成「1 个总览 + 4 组」后，**菜单 JSON 成了唯一的路由表** —— 一个手滑的
 * 路径拼错（`sms_setting` / 少一层目录）不会报错，只会让那一页从菜单里消失，
 * 而 LuCI 不会给出任何提示。
 *
 * 本守卫钉住：
 *   ① JSON 可解析（写坏一个逗号 → 整个后台菜单消失）；
 *   ② 每个 view 的 path 都对应真实存在的视图文件（拼错即红）；
 *   ③ 12 个页面一个不少（删页面必须同时改这里，避免"悄悄少一页"）；
 *   ④ 分组节点必须有子项（空分组在界面上是个点不开的壳）；
 *   ⑤ 同一父节点下 order 不重复（重复时顺序不确定，测试里看不出来）。
 *
 * 用法：node tests/menu-ia-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MENU = path.join(ROOT, 'root/usr/share/luci/menu.d/luci-app-mt5700.json');
const VIEWS = path.join(ROOT, 'htdocs/luci-static/resources/view');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? '\n       ' + detail : '')); }
}

let menu = null;
try {
	menu = JSON.parse(fs.readFileSync(MENU, 'utf8'));
	ok('菜单 JSON 可解析', true);
} catch (e) {
	ok('菜单 JSON 可解析', false, e.message);
}

if (menu) {
	const keys = Object.keys(menu);
	console.log('== 1. 每个 view 都指向真实存在的文件 ==');
	let badPath = [];
	let views = 0;
	keys.forEach((k) => {
		const a = menu[k].action || {};
		if (a.type !== 'view') return;
		views++;
		const file = path.join(VIEWS, a.path + '.js');
		if (!fs.existsSync(file)) badPath.push(k + ' → ' + a.path);
	});
	ok('view 的 path 全部命中真实视图文件', badPath.length === 0, badPath.join('；'));
	ok('view 数量 = 12（少一个就说明有页被漏掉）', views === 12, '实际 ' + views);

	/* 12 个页面清单：删页面必须同时改这里 —— 这是有意的摩擦 */
	const EXPECT = [
		'network_status', 'network_settings', 'dial', 'modem_settings', 'upgrade',
		'esim', 'voice_call', 'sms_center', 'sms_settings', 'terminal', 'logs', 'service'
	];
	EXPECT.forEach((p) => {
		const hit = keys.some((k) => (menu[k].action || {}).path === 'at-webserver/' + p);
		ok('页面仍在菜单里：' + p, hit);
	});

	console.log('== 2. 分组不是空壳 ==');
	const groups = keys.filter((k) => (menu[k].action || {}).type === 'firstchild' && k !== 'admin/modem' && k !== 'admin/modem/5g');
	ok('存在 4 个分组（网络/模组/通信/工具）', groups.length === 4, '实际 ' + groups.length + '：' + groups.join(','));
	groups.forEach((g) => {
		const kids = keys.filter((k) => k.startsWith(g + '/') && k.split('/').length === g.split('/').length + 1);
		ok('分组有直接子项：' + menu[g].title, kids.length >= 1, '子项 ' + kids.length + ' 个');
	});

	/* 顶层两项保持原样：换了会让整个「移动网络」入口跑到别处 */
	ok('admin/modem 仍是 firstchild+recurse（点顶级直接进第一页）',
		menu['admin/modem'] && menu['admin/modem'].action.type === 'firstchild' && menu['admin/modem'].action.recurse === true);
	ok('admin/modem/5g 的 acl 依赖仍在（否则非授权用户也能看到菜单）',
		JSON.stringify(menu['admin/modem'].depends || {}).indexOf('luci-app-mt5700') >= 0);

	console.log('== 3. 同级 order 不重复 ==');
	const byParent = {};
	keys.forEach((k) => {
		const parent = k.split('/').slice(0, -1).join('/');
		(byParent[parent] = byParent[parent] || []).push({ k, o: menu[k].order });
	});
	let dup = [];
	Object.keys(byParent).forEach((p) => {
		const seen = {};
		byParent[p].forEach((it) => {
			if (it.o == null) return;
			if (seen[it.o]) dup.push(p + ' 的 ' + seen[it.o] + ' 与 ' + it.k + ' 同为 ' + it.o);
			seen[it.o] = it.k;
		});
	});
	ok('同父节点下 order 唯一（重复会让排序不确定）', dup.length === 0, dup.join('；'));
}

console.log('');
if (fails.length === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fails.length + ' 项失败 / 共 ' + (pass + fails.length) + ' 项');
fails.forEach((f) => console.log('  ✗ ' + f));
process.exit(1);
