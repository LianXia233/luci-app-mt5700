'use strict';
/**
 * 作者署名回归检查（服务配置页 admin/modem/5g/config）
 *
 * 保护对象：页面底部「作者：LianXia233」署名及其指向主仓库的链接。
 * 见仓库根目录 AGENTS.md「作者署名保护规则」。
 *
 * 覆盖：
 *   1) 视图 service.js 存在署名 DOM，且追加在底部操作栏之后；
 *   2) 链接地址指向主仓库，带 target="_blank" 与 rel="noopener noreferrer"；
 *   3) 署名样式类存在于 mt5700.css（低对比、移动端断点、键盘焦点）；
 *   4) 署名未被扩散到其他视图页面（仅限本页）；
 *   5) 维护规则已写入 AGENTS.md；
 *   6) 相关文件保持 LF 行尾（CRLF 会导致 BusyBox/procd 侧异常）。
 *
 * 运行：node tests/author-attribution-test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const viewDir = path.join(root, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');
const libDir = path.join(root, 'htdocs', 'luci-static', 'resources', 'at-webserver');

const SERVICE_VIEW = path.join(viewDir, 'service.js');
const CSS = path.join(libDir, 'mt5700.css');
const AGENTS = path.join(root, 'AGENTS.md');

const AUTHOR_URL = 'https://github.com/LianXia233/luci-app-mt5700';

const results = [];
function check(name, ok) {
	results.push({ name: name, ok: !!ok });
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
}

function read(p) {
	return fs.readFileSync(p, 'utf8');
}

/* ---------- 1) 视图：署名 DOM 与位置 ---------- */
const view = read(SERVICE_VIEW);

const authorIdx = view.indexOf("'class': 'mt5700-author'");
const actionsIdx = view.indexOf('body.appendChild(bottomActions);');
const returnIdx = view.lastIndexOf('return page;');

check('service.js: 存在 .mt5700-author 容器', authorIdx > 0);
check('service.js: 署名容器在底部操作栏之后', authorIdx > actionsIdx && actionsIdx > 0);
check('service.js: 署名容器在 render 返回之前', authorIdx < returnIdx);
check('service.js: 包含「作者：」文案', view.indexOf("'作者：'") > 0);
check('service.js: 包含署名文本 LianXia233', view.indexOf("}, 'LianXia233')") > 0);
check('service.js: 链接指向主仓库', view.indexOf("'href': '" + AUTHOR_URL + "'") > 0);
check('service.js: 外链使用 _blank', view.indexOf("'target': '_blank'") > 0);
check('service.js: 外链带 noopener noreferrer', view.indexOf("'rel': 'noopener noreferrer'") > 0);
check('service.js: 署名附近有保留声明注释',
	view.indexOf('Project author attribution: preserve unless explicitly authorized') > 0 &&
	Math.abs(view.indexOf('Project author attribution') - authorIdx) < 1200);

/* 语法可编译（不执行）：确认新增节点未破坏视图模块 */
let compiled = true;
try {
	new Function(view);
} catch (e) {
	compiled = false;
}
check('service.js: 语法可编译', compiled);

/* ---------- 2) 样式 ---------- */
const css = read(CSS);
const cssStart = css.lastIndexOf('作者署名（服务配置页页脚');
const cssTail = cssStart >= 0 ? css.slice(cssStart) : '';

check('mt5700.css: 存在署名小节注释', cssStart > 0);
check('mt5700.css: 存在 .mt5700-author 规则', cssTail.indexOf('.mt5700-author {') > 0);
check('mt5700.css: 存在 .mt5700-author-link 规则', cssTail.indexOf('.mt5700-author-link {') > 0);
check('mt5700.css: 链接有键盘焦点样式', cssTail.indexOf(':focus-visible') > 0);
check('mt5700.css: 署名居中显示', /justify-content:\s*center/.test(cssTail));
check('mt5700.css: 有移动端断点', /@media\s*\(max-width:\s*768px\)/.test(cssTail));
check('mt5700.css: 字号不大于正文（12px 及以下或 xs 变量）',
	/--mt5700-font-size-xs/.test(cssTail) || /font-size:\s*1[0-2]px/.test(cssTail));

/* ---------- 3) 范围：署名不得扩散到其他视图 ---------- */
const otherViews = fs.readdirSync(viewDir)
	.filter(function (f) { return f.endsWith('.js') && f !== 'service.js'; })
	.filter(function (f) { return read(path.join(viewDir, f)).indexOf('mt5700-author') >= 0; });

check('仅本页包含署名（未扩散到其他视图）', otherViews.length === 0);
if (otherViews.length)
	console.log('       越界文件：' + otherViews.join(', '));

/* ---------- 4) 维护规则 ---------- */
const agents = read(AGENTS);

check('AGENTS.md: 存在作者署名保护规则章节', agents.indexOf('作者署名保护规则') > 0);
check('AGENTS.md: 明确指定 admin/modem/5g/config', agents.indexOf('admin/modem/5g/config') > 0);
check('AGENTS.md: 明确要求保留署名与链接',
	agents.indexOf('都必须保留该署名及其链接') > 0);
check('AGENTS.md: 明确维护者授权前提',
	agents.indexOf('除非项目维护者明确授权') > 0);
check('AGENTS.md: 记录署名实现位置', agents.indexOf('service.js') > 0 && agents.indexOf(AUTHOR_URL) > 0);

/* ---------- 5) 行尾 ---------- */
check('service.js: LF 行尾', view.indexOf('\r\n') < 0);
check('mt5700.css: LF 行尾', css.indexOf('\r\n') < 0);
check('AGENTS.md: LF 行尾', agents.indexOf('\r\n') < 0);

/* ---------- 汇总 ---------- */
const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (failed.length ? 'FAILED ' + failed.length : 'ALL ' + results.length + ' PASSED'));
process.exit(failed.length ? 1 : 0);
