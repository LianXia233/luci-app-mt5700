'use strict';
/**
 * 配置抽屉「脏标记 + 放弃回滚」接线门禁（Codex P2 回归，零依赖静态检查）。
 *
 * 背景（PR #58 Codex Review 两条 P2）：
 *   1) 抽屉挂在 body 下、不在 .mt5700-page 内，页面级 input/change 脏标记监听
 *      覆盖不到抽屉控件：编辑后直接刷新/关页会静默丢改动。抽屉必须自行把
 *      input/change 接到 AtWs.uci.markDirty()（beforeunload 守护）。
 *   2) controller.save() 经 L.uci.set 暂存键后 uciSave 失败，用户选「放弃修改」
 *      若只关抽屉不回滚，被放弃的值仍留在暂存区，之后其它模块的一次成功保存
 *      会把它们连带 commit。必须在写入前备份原值、放弃时回滚并清理脏标记。
 *
 * 行为级验证在 tests/manual/drawer-smoke.js（jsdom，手动运行）。
 * 运行：node tests/config-drawer-test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = function (p) { return fs.readFileSync(path.join(root, p), 'utf8'); };

const libDir = path.join('htdocs', 'luci-static', 'resources', 'at-webserver');
const drawerJs = read(path.join(libDir, 'config-drawer.js'));
const rpcJs = read(path.join(libDir, 'rpc.js'));

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

/* ---------- 1. 抽屉内脏标记接线 ---------- */
check('抽屉面板 input 事件接到 markDirty',
	/panel\.addEventListener\('input',\s*function\s*\(\)\s*\{\s*AtWs\.uci\.markDirty\(\)/.test(drawerJs),
	'input');
check('抽屉面板 change 事件接到 markDirty',
	/panel\.addEventListener\('change',\s*function\s*\(\)\s*\{\s*AtWs\.uci\.markDirty\(\)/.test(drawerJs),
	'change');
check('rpc.js 暴露 isDirty 查询（抽屉记录打开前脏基线）',
	/isDirty:\s*function\s*\(\)\s*\{\s*return this\._dirty;\s*\}/.test(rpcJs)
	&& /var prevDirty = AtWs\.uci\.isDirty\(\)/.test(drawerJs),
	'prevDirty 基线');

/* ---------- 2. 暂存键备份与放弃回滚 ---------- */
check('setter 首次触碰键时先 L.uci.get 备份原值再 L.uci.set',
	/hasOwnProperty\.call\(stagedBackup, key\)[\s\S]{0,200}stagedBackup\[key\] = L\.uci\.get\('at-webserver', 'config', key\)[\s\S]{0,120}L\.uci\.set\('at-webserver', 'config', key, value\)/.test(drawerJs),
	'备份在写入前');
check('revertStaged：原值存在则 set 回滚、原本不存在则 unset',
	/function revertStaged\(\)[\s\S]{0,400}L\.uci\.unset\('at-webserver', 'config', key\)[\s\S]{0,120}L\.uci\.set\('at-webserver', 'config', key, v\)/.test(drawerJs),
	'unset/set 双路');
check('forceClose 先回滚暂存再清理（放弃修改不遗留脏值）',
	/function forceClose\(\)\s*\{[\s\S]{0,400}revertStaged\(\);[\s\S]{0,200}if \(!prevDirty\) AtWs\.uci\.clearDirty\(\)/.test(drawerJs),
	'回滚 + 条件清脏');
check('保存成功后备份作废（不再回滚已 commit 的值）',
	/AtWs\.uci\.clearDirty\(\);\s*saved = true;[\s\S]{0,120}stagedBackup = \{\}/.test(drawerJs),
	'成功清备份');

const fails = results.filter(function (r) { return !r.ok; });
console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
if (fails.length) {
	fails.forEach(function (f) { console.log('FAILED: ' + f.name + ' — ' + f.detail); });
	process.exit(1);
}
process.exit(0);