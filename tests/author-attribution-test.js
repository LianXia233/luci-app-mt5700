'use strict';
/**
 * 作者署名回归检查（服务配置页 admin/modem/5g/config）
 *
 * 保护对象：页脚署名「© 2026 LianXia233 · 开发与维护」、许可证标识
 * 「GPL-3.0-only」及其指向主仓库的链接。见 AGENTS.md「作者署名保护规则」。
 *
 * 覆盖：
 *   1) 视图 service.js 存在署名 DOM，且追加在底部操作栏之后；
 *   2) 文案 / SPDX 以本文件常量为单一事实源，链接带 target/rel 安全属性；
 *   3) 旧前缀标签与历史文案不得回退（按完整字符串字面量比对，避免子串误判）；
 *   4) 署名样式类存在于 mt5700.css（低对比、居中、键盘焦点、窄屏换行）；
 *   5) 署名未被扩散到其他视图页面（仅限本页）；
 *   6) 维护规则已写入 AGENTS.md，且 checks.yml 同步声明现行文案与 SPDX；
 *   7) 相关文件保持 LF 行尾（CRLF 会导致 BusyBox/procd 侧异常）。
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
const WORKFLOW = path.join(root, '.github', 'workflows', 'checks.yml');

/* 文案单一事实源：授权调整时先改这里，再按 AGENTS.md 联动清单同步另外三处。 */
const AUTHOR_NAME = 'LianXia233';
const AUTHOR_ROLE = '开发与维护';
const COPYRIGHT_YEAR = '2026';
const AUTHOR_TEXT = '© ' + COPYRIGHT_YEAR + ' ' + AUTHOR_NAME + ' · ' + AUTHOR_ROLE;
const AUTHOR_LICENSE = 'GPL-3.0-only';
const AUTHOR_URL = 'https://github.com/LianXia233/luci-app-mt5700';
const LEGACY_LABEL = '作者：';
/* 真正进入过 main 的历史文案；比对时拼成 "}, '<text>')" 字面量，
 * 避免「© 2026 …」包含「LianXia233 · 开发与维护」子串时误判。
 * 未推送的中间态 Copyright (C) 写法由下方单独断言覆盖。 */
const HISTORICAL_TEXTS = [
	'作者：LianXia233',
	'LianXia233 · 开发与维护'
];

const results = [];
function check(name, ok) {
	results.push({ name: name, ok: !!ok });
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
}

function read(p) {
	return fs.readFileSync(p, 'utf8');
}

/* ---------- 1) 视图：署名 DOM、位置与文案 ---------- */
const view = read(SERVICE_VIEW);

const authorIdx = view.indexOf("'class': 'mt5700-author'");
const actionsIdx = view.indexOf('body.appendChild(bottomActions);');
const returnIdx = view.lastIndexOf('return page;');
const blockEnd = authorIdx > 0 ? view.indexOf(']));', authorIdx) : -1;
const authorBlock = blockEnd > authorIdx ? view.slice(authorIdx, blockEnd + 4) : '';

check('service.js: 存在 .mt5700-author 容器', authorIdx > 0);
check('service.js: 署名容器在底部操作栏之后', authorIdx > actionsIdx && actionsIdx > 0);
check('service.js: 署名容器在 render 返回之前', authorIdx < returnIdx);
check('service.js: 能完整截取署名 DOM 片段', authorBlock.length > 0);
check('service.js: 署名文案为「' + AUTHOR_TEXT + '」',
	authorBlock.indexOf("}, '" + AUTHOR_TEXT + "')") > 0);
check('service.js: © 版权写法与年份', authorBlock.indexOf('© ' + COPYRIGHT_YEAR) > 0);
check('service.js: 文案含作者标识', authorBlock.indexOf(AUTHOR_NAME) > 0);
check('service.js: 文案含开发与维护角色说明', authorBlock.indexOf(AUTHOR_ROLE) > 0);
check('service.js: 不再使用旧前缀标签',
	authorBlock.indexOf("'" + LEGACY_LABEL + "'") < 0);
check('service.js: 历史文案不得回退',
	HISTORICAL_TEXTS.every(function (t) {
		return authorBlock.indexOf("}, '" + t + "')") < 0;
	}));
check('service.js: 不再残留 Copyright (C) 写法',
	authorBlock.indexOf('Copyright (C)') < 0);
check('service.js: 许可证标识为 ' + AUTHOR_LICENSE,
	authorBlock.indexOf("}, '" + AUTHOR_LICENSE + "')") > 0);
check('service.js: 许可证节点复用 mt5700-author-license',
	authorBlock.indexOf("'class': 'mt5700-author-license'") > 0);
check('service.js: 许可证节点为纯文本（非链接）',
	(authorBlock.match(/E\('a'/g) || []).length === 1 &&
	(authorBlock.match(/E\('span'/g) || []).length === 1);
check('service.js: 容器内无残留 label 节点',
	authorBlock.indexOf('mt5700-author-label') < 0);
check('service.js: 链接指向主仓库', view.indexOf("'href': '" + AUTHOR_URL + "'") > 0);
check('service.js: 外链使用 _blank', view.indexOf("'target': '_blank'") > 0);
check('service.js: 外链带 noopener noreferrer', view.indexOf("'rel': 'noopener noreferrer'") > 0);
check('service.js: 署名附近有保留声明注释',
	view.indexOf('Project author attribution: preserve unless explicitly authorized') > 0 &&
	Math.abs(view.indexOf('Project author attribution') - authorIdx) < 1400);

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
check('mt5700.css: 版权文案与许可证在窄屏可换行不溢出',
	/flex-wrap:\s*wrap/.test(cssTail) &&
	/overflow-wrap:\s*break-word/.test(cssTail) &&
	/word-break:\s*break-word/.test(cssTail));
check('mt5700.css: 两个子节点之间有间隔', /gap:\s*0\s+0\.2em/.test(cssTail));

/* ---------- 3) 范围：署名不得扩散到其他视图 ---------- */
const otherViews = fs.readdirSync(viewDir)
	.filter(function (f) { return f.endsWith('.js') && f !== 'service.js'; })
	.filter(function (f) { return read(path.join(viewDir, f)).indexOf('mt5700-author') >= 0; });

check('仅本页包含署名（未扩散到其他视图）', otherViews.length === 0);
if (otherViews.length)
	console.log('       越界文件：' + otherViews.join(', '));

/* ---------- 4) 维护规则与四处联动 ---------- */
const agents = read(AGENTS);
const workflow = read(WORKFLOW);

check('AGENTS.md: 存在作者署名保护规则章节', agents.indexOf('作者署名保护规则') > 0);
check('AGENTS.md: 明确指定 admin/modem/5g/config', agents.indexOf('admin/modem/5g/config') > 0);
check('AGENTS.md: 明确要求保留署名与链接',
	agents.indexOf('都必须保留该署名及其链接') > 0);
check('AGENTS.md: 明确维护者授权前提',
	agents.indexOf('除非项目维护者明确授权') > 0);
check('AGENTS.md: 记录署名实现位置', agents.indexOf('service.js') > 0 && agents.indexOf(AUTHOR_URL) > 0);
check('AGENTS.md: 声明当前署名文案', agents.indexOf(AUTHOR_TEXT) > 0);
check('AGENTS.md: 声明 SPDX 许可证标识', agents.indexOf(AUTHOR_LICENSE) > 0);
check('AGENTS.md: 记录署名文案变更联动清单', agents.indexOf('署名文案变更联动清单') > 0);
check('AGENTS.md: 记录历史文案不得回退',
	HISTORICAL_TEXTS.every(function (t) { return agents.indexOf(t) > 0; }));
check('AGENTS.md: 含更新日志豁免条款', agents.indexOf('更新日志豁免') > 0);
check('AGENTS.md: 说明许可证节点无专门 CSS 规则',
	agents.indexOf('没有专门 CSS 规则') > 0);
check('checks.yml: 声明当前署名文案', workflow.indexOf(AUTHOR_TEXT) > 0);
check('checks.yml: 声明 SPDX 许可证标识', workflow.indexOf(AUTHOR_LICENSE) > 0);
check('四处文案一致（DOM / 门禁常量 / AGENTS.md / checks.yml）',
	authorBlock.indexOf(AUTHOR_TEXT) > 0 &&
	agents.indexOf(AUTHOR_TEXT) > 0 &&
	workflow.indexOf(AUTHOR_TEXT) > 0);
check('四处 SPDX 一致（DOM / 门禁常量 / AGENTS.md / checks.yml）',
	authorBlock.indexOf(AUTHOR_LICENSE) > 0 &&
	agents.indexOf(AUTHOR_LICENSE) > 0 &&
	workflow.indexOf(AUTHOR_LICENSE) > 0);

/* ---------- 5) 行尾 ---------- */
check('service.js: LF 行尾', view.indexOf('\r\n') < 0);
check('mt5700.css: LF 行尾', css.indexOf('\r\n') < 0);
check('AGENTS.md: LF 行尾', agents.indexOf('\r\n') < 0);
check('checks.yml: LF 行尾', workflow.indexOf('\r\n') < 0);
check('author-attribution-test.js: LF 行尾', read(__filename).indexOf('\r\n') < 0);

/* ---------- 汇总 ---------- */
const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (failed.length ? 'FAILED ' + failed.length : 'ALL ' + results.length + ' PASSED'));
process.exit(failed.length ? 1 : 0);
