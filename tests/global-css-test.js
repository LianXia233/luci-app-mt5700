'use strict';
/**
 * 全局样式可达性回归检查（弹窗可读性 + 后端未就绪提示条）
 *
 * 保护对象：这两项是**插件级组件**，不能只对「加载了 at.css」的页面生效。
 * 历史问题：提示条样式一度写在 at.css（由 ui.js 注入，11/12 页），
 * service.js 是唯一只 require mt5700 的视图，提示条在它那里退回
 * LuCI 原生 .alert-message（static、撑满、把内容整体下推）。
 *
 * 现状约定：两段样式统一放在 at-webserver/global.css，由 mt5700.js 注入；
 * 因为 12 个视图全部 require at-webserver/mt5700，所以注入一次即全覆盖。
 *
 * 覆盖：
 *   1) 每个视图都依赖 at-webserver/mt5700（→ 必然拿到 global.css）；
 *   2) mt5700.js 注入 global.css，且注入顺序在 mt5700.css 之后；
 *   3) global.css 含提示条与四套弹窗结构的选择器，且只调颜色不动版式；
 *   4) at.css / mt5700.css 不再重复定义这些选择器（防止又散回两处）；
 *   5) ui.js 的声音条不再依赖 at.css 注入；
 *   6) 相关文件保持 LF 行尾。
 *
 * 运行：node tests/global-css-test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const libDir = path.join(root, 'htdocs', 'luci-static', 'resources', 'at-webserver');
const viewDir = path.join(root, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');

const read = function (p) { return fs.readFileSync(p, 'utf8'); };

const mtJs = read(path.join(libDir, 'mt5700.js'));
const uiJs = read(path.join(libDir, 'ui.js'));
const globalCss = read(path.join(libDir, 'global.css'));
const mtCss = read(path.join(libDir, 'mt5700.css'));
const atCss = read(path.join(libDir, 'at.css'));

const results = [];
function check(name, ok, detail) {
	results.push({ name: name, ok: !!ok, detail: detail || '' });
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  ← ' + detail));
}

/* ---------- 1) 视图依赖 ---------- */
const views = fs.readdirSync(viewDir).filter(function (f) { return f.endsWith('.js'); });
check('视图数量为 12（菜单路由一致）', views.length === 12, '实际 ' + views.length);

const needUi = [];
const missMt = [];
views.forEach(function (f) {
	const src = read(path.join(viewDir, f));
	if (!/'require at-webserver\/mt5700'/.test(src)) missMt.push(f);
	if (!/'require at-webserver\/ui'/.test(src)) needUi.push(f);
});
check('全部视图 require at-webserver/mt5700（global.css 可达）',
	missMt.length === 0, '缺: ' + missMt.join(', '));
check('视图普遍复用公共组件库（require ui）',
	needUi.length <= 1, '未引入 ui 的视图: ' + (needUi.join(', ') || '无'));

/* ---------- 2) 注入点与顺序 ---------- */
const iMt = mtJs.indexOf('mt5700.css?v=');
const iGl = mtJs.indexOf('global.css?v=');
check('mt5700.js 注入 global.css', iGl > 0);
check('global.css 在 mt5700.css 之后注入（作为最终修订层）',
	iMt > 0 && iGl > iMt, 'mt5700.css@' + iMt + ' global.css@' + iGl);
check('global.css 有独立版本号', /var GLOBAL_CSS_VERSION = '\d+\.\d+\.\d+';/.test(mtJs));
check('at.css 版本号已递增到 1.15.0 及以上',
	(function () {
		const m = uiJs.match(/var AT_CSS_VERSION = '(\d+)\.(\d+)\.(\d+)';/);
		if (!m) return false;
		const v = [+m[1], +m[2], +m[3]];
		return v[0] > 1 || (v[0] === 1 && (v[1] > 15 || (v[1] === 15 && v[2] >= 0)));
	})());

/* ---------- 3) global.css 内容 ---------- */
check('含提示条根类 .mt5700-float-notice', globalCss.indexOf('.mt5700-float-notice {') > 0);
check('提示条为 fixed 悬浮（不吃文档流）',
	/\.mt5700-float-notice \{[\s\S]*?position: fixed !important;/.test(globalCss));
check('提示条宽度受视口约束', /width: min\(720px, calc\(100vw - 24px\)\) !important;/.test(globalCss));
check('提示条含关闭按钮样式', globalCss.indexOf('.mt5700-float-notice-x') > 0);
check('提示条含暗色主题变体', globalCss.indexOf('html.at-dark .mt5700-float-notice') > 0);
check('提示条含 reduced-motion 兜底', /prefers-reduced-motion[\s\S]{0,80}mt5700-float-notice/.test(globalCss));

['.mt5700-modal', '.at-modal', '.cbi-modal', '.modal-body'].forEach(function (sel) {
	check('弹窗覆盖 ' + sel, globalCss.indexOf(sel) > 0);
});
check('弹窗段只改颜色（无 width/height/padding/margin 声明）',
	!/\.(mt5700|at|cbi)?-?modal[^{]*\{[^}]*(?<!-)(width|height|padding|margin|border-radius|box-shadow):/i.test(
		globalCss.split('全局弹窗文字可见性')[1] || ''),
	'弹窗段出现盒模型属性');

/* ---------- 4) 不再重复定义 ---------- */
check('at.css 不再定义 .mt5700-float-notice 规则',
	!/\.mt5700-float-notice[\s-]*\{/.test(atCss));
check('mt5700.css 不再定义弹窗墨色变量',
	mtCss.indexOf('--mt5700-modal-ink') < 0);
check('at.css 留了迁移指引注释', atCss.indexOf('global.css') > 0);

/* ---------- 5) ui.js 侧 ---------- */
check('ui.js 提示条仍使用全局类名', uiJs.indexOf('mt5700-float-notice') > 0);
check('ui.js 不再单独注入提示条样式（只注入 at.css）',
	(uiJs.match(/injectCss\(/g) || []).length === 1);
check('service.js 接入统一启动入口（提示条全页一致）',
	/'require at-webserver\/ui'/.test(read(path.join(viewDir, 'service.js')))
	&& /Ui\.startup\(/.test(read(path.join(viewDir, 'service.js'))));

/* ---------- 6) 行尾 ---------- */
[['global.css', globalCss], ['mt5700.css', mtCss], ['at.css', atCss],
 ['mt5700.js', mtJs], ['ui.js', uiJs]].forEach(function (pair) {
	check(pair[0] + ': LF 行尾', pair[1].indexOf('\r\n') < 0);
});

/* ---------- 汇总 ---------- */
const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (failed.length ? 'FAILED ' + failed.length : 'ALL ' + results.length + ' PASSED'));
process.exit(failed.length ? 1 : 0);
