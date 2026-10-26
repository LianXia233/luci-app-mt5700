#!/usr/bin/env node
'use strict';

/**
 * 宿主主题标题样式隔离契约
 * ===========================================================================
 * 2026-10-26 真机实测发现的坑（不是我们代码的问题，但会毁掉整个版式）：
 *
 *   Argon 的 cascade.css 把**裸标题标签**当卡片画：
 *       h2 { padding: 1rem 1.25rem; font-size: 1.25rem; border-radius: .25rem;
 *            background: var(--white); box-shadow: 0 4px 8px rgba(0,0,0,.03); }
 *       h3 { padding: .8755rem 1.25rem; display: block; **width: 100%**;
 *            background: var(--white); border-radius: .25rem; line-height: 1; }
 *
 * 我们的页面标题是 h2（Mt5700.page）、卡片标题是 h3（Mt5700.card），于是：
 *   ① 页面标题外面凭空多出一个白色圆角方块（实测 104×56、圆角 4px、带阴影）；
 *   ② h3 的 `width: 100%` 让卡片标题占满整行，副标题被挤到第二行 ——
 *      实测标题宽 1196px = 整行宽，一张卡的头部白占 88px 高。
 * 这两条都不会报任何错，只会「看着不对」，所以必须有守卫。
 *
 * 修法（都写在 mt5700.css 的 .mt5700-page-title / .mt5700-card-title 里）：
 *   · 清掉宿主给的盒子：background / box-shadow / border-radius / padding
 *   · 卡片标题补 `width: fit-content` —— h3 是块级盒，光改 display 不收宽度
 *
 * 用法：node tests/host-heading-reset-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSSP = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css');
const css = fs.readFileSync(CSSP, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  ok   ' + name); }
function no(name, why) { fail++; console.log('  ✗ ' + name + '  → ' + why); }
function has(name, cond, why) { cond ? ok(name) : no(name, why); }

/* 取某个选择器的规则体（按「选择器 {」定位，配平花括号）。
   ★ 不能用 /\.x \{[^}]*\}/：块内注释里也出现花括号，非贪婪匹配会在注释处截断。 */
function ruleBody(selector) {
	const i = css.indexOf(selector + ' {');
	if (i < 0) return null;
	let depth = 0, start = css.indexOf('{', i);
	for (let j = start; j < css.length; j++) {
		if (css[j] === '{') depth++;
		else if (css[j] === '}') {
			depth--;
			if (depth === 0) return css.slice(start + 1, j);
		}
	}
	return null;
}

function decl(body, prop, value) {
	if (!body) return false;
	const re = new RegExp('(^|[;{\\s])' + prop + '\\s*:\\s*' + value + '\\s*(;|$)', 'm');
	return re.test(body);
}

console.log('== A. 页面标题（h2）必须清掉 Argon 的「假卡片」 ==');

const page = ruleBody('.mt5700-page-title');
has('.mt5700-page-title 规则存在', !!page, '选择器被改名或删除');
has('清掉背景（Argon h2 给了白色底）', decl(page, 'background', 'none'),
	'host 会画出一条白色方块，页头横条被毁');
has('清掉阴影（Argon h2 给了 0 4px 8px）', decl(page, 'box-shadow', 'none'),
	'白色方块还会带一圈投影');
has('清掉内边距（Argon h2 给了 1rem 1.25rem）', decl(page, 'padding', '0'),
	'标题会被撑成一个 104×56 的盒子');
has('清掉圆角（Argon h2 给了 .25rem）', decl(page, 'border-radius', '0'),
	'盒子残留圆角会露出痕迹');
has('字重仍带 !important（Argon 用 !important 压成 normal）',
	/font-weight:\s*700\s*!important/.test(page || ''), '标题会变细，与正文同级');

console.log('== B. 卡片标题（h3）必须收回宽度 ==');

const card = ruleBody('.mt5700-card-title');
has('.mt5700-card-title 规则存在', !!card, '选择器被改名或删除');
has('★ 宽度收回 fit-content', decl(card, 'width', 'fit-content'),
	'Argon 的 h3{width:100%} 会让标题占满整行，副标题被挤到第二行');
has('保留 max-width: 100% 兜底', decl(card, 'max-width', '100%'),
	'长标题在窄卡片里会溢出');
has('清掉背景（Argon h3 给了白色底）', decl(card, 'background', 'none'),
	'卡片头部会出现第二层白块');
has('清掉内边距（Argon h3 给了 .8755rem 1.25rem）', decl(card, 'padding', '0'),
	'标题两侧会被撑开，与正文对不齐');
has('清掉圆角', decl(card, 'border-radius', '0'), '残留圆角');
has('字重仍带 !important', /font-weight:\s*600\s*!important/.test(card || ''),
	'标题会被 Argon 压成 normal');

console.log('== C. 反向验证：把修复删掉必须判红 ==');

/* 反向断言：从 CSS 里去掉某条声明后，decl() 必须为 false。
   ★ 用 split/join 做全局替换，避免只替换到第一处。 */
function without(selector, prop, value) {
	const body = ruleBody(selector);
	if (!body) return null;
	const re = new RegExp('(^|[;{\\s])' + prop + '\\s*:\\s*' + value + '\\s*(;|$)', 'm');
	return body.split('\n').filter(function (l) { return !re.test(l); }).join('\n');
}
has('反向：页面标题去掉 background:none 后 decl 判否',
	decl(without('.mt5700-page-title', 'background', 'none'), 'background', 'none') === false,
	'去掉后仍判真，说明这条断言没有实际约束力');
has('反向：卡片标题去掉 width:fit-content 后 decl 判否',
	decl(without('.mt5700-card-title', 'width', 'fit-content'), 'width', 'fit-content') === false,
	'去掉后仍判真，说明这条断言没有实际约束力');

console.log('\n' + (fail ? 'FAILED' : 'PASS') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
