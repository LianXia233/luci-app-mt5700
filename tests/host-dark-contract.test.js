#!/usr/bin/env node
'use strict';

/**
 * 宿主深色模式污染契约
 * ===========================================================================
 * 2026-10-26 真机实测（CDP 模拟 prefers-color-scheme: dark + Argon 暗色主题）：
 * 本插件是**固定浅色纸面**，但 Argon 的 dark.css 会从外部把颜色钉死：
 *
 *     select,input{color:#ccc;background-color:transparent !important;
 *                  border:1px solid #252526}
 *     select{background-color:#1e1e1e !important}
 *     .btn,button,select,input{border:1px solid #3c3c3c !important}
 *
 * 后果（实测值）：
 *   ① `.mt5700-page` 的 color 变成 rgb(204,204,204) —— 白底浅灰字 ≈1.6:1，
 *      所有没单独指定颜色的文本（表格单元格 / hint / li）全部看不清；
 *   ② 下拉框底色被钉成 rgb(30,30,30)、文字仍是我们的深色 → ≈1.2:1，看不见；
 *   ③ ghost 按钮凭空多出一圈 #3c3c3c 灰边。
 * 三条都不报错，只在「系统深色 + 插件浅色」这个组合下出现，所以必须有守卫。
 *
 * 修法（mt5700.css 紧跟在 .mt5700-page 之后的那一段）：
 *   · `.mt5700-page { color: var(--mt5700-text) }` —— 把继承链斩断；
 *   · 用同等强度的 `!important` 把表单控件的底色/边框钉回来，全部限定在
 *     `.mt5700-page` 之内，不影响宿主其它页面；
 *   · 按钮边框按变体逐个复位（宿主那条 `.btn,button` 会盖掉所有按钮）。
 *
 * 用法：node tests/host-dark-contract.test.js
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
function ruleBody(src, selector) {
	const i = src.indexOf(selector + ' {');
	if (i < 0) return null;
	let depth = 0;
	const start = src.indexOf('{', i);
	for (let j = start; j < src.length; j++) {
		if (src[j] === '{') depth++;
		else if (src[j] === '}') {
			depth--;
			if (!depth) return src.slice(start + 1, j);
		}
	}
	return null;
}

/* 规则体里有没有 `prop: value`（允许 !important、允许值后面跟注释）
   ★ 值尾部不能用 \b 收口：`var(--mt5700-text)` 以 `)` 结尾，`)` 与后面的 `;`
     之间不存在单词边界 —— 加 \b 会让这条断言永远判否（本测试第一版就栽在这里）。 */
function decl(body, prop, value) {
	if (!body) return false;
	const re = new RegExp('(^|[;{\\s])' + prop + '\\s*:\\s*' +
		value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s;!}]|$)', 'm');
	return re.test(body);
}

console.log('== A. 页面容器必须自带 color（斩断宿主继承） ==');

const pageBody = ruleBody(css, '.mt5700-page');
has('找到 .mt5700-page 规则', pageBody !== null, '选择器不存在，后面所有断言都没有意义');
has('.mt5700-page 显式声明 color: var(--mt5700-text)',
	decl(pageBody, 'color', 'var(--mt5700-text)'),
	'缺这一行时，宿主 dark.css 的 body{color:#ccc} 会一路继承进来，白底浅灰字');

console.log('\n== B. 表单控件要与宿主 !important 抗衡 ==');

/* 宿主那条规则带 !important，非 !important 的声明一律无效 —— 这里必须也是 !important */
const ctrlRe = /\.mt5700-page\s+select[\s\S]{0,200}?background-color\s*:\s*var\(--mt5700-surface-sunken\)\s*!important/;
has('select/input/textarea 的底色用 !important 钉回浅色',
	ctrlRe.test(css),
	'宿主是 select{background-color:#1e1e1e !important}，不同样加 !important 就赢不了');
has('表单控件边框也一并钉回',
	/\.mt5700-page\s+select[\s\S]{0,260}?border-color\s*:\s*var\(--mt5700-border\)\s*!important/.test(css),
	'宿主 select,input{border:1px solid #252526 !important} 会把边框染黑');
has('复选框/单选框不被上面的底色规则波及',
	/input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/.test(css),
	'给 checkbox 铺底色会把勾选框涂成一块色板');

console.log('\n== C. 按钮边框按变体复位 ==');

[['.mt5700-btn', 'transparent'],
	['.mt5700-btn-primary', 'var(--mt5700-accent)'],
	['.mt5700-btn-secondary', 'var(--mt5700-border)'],
	['.mt5700-btn-danger', 'var(--mt5700-danger)']].forEach(function (p) {
	const sel = '.mt5700-page ' + p[0];
	/* 选择器后面可能是 `,`（同一条规则里还挂了别的类）也可能是 `{`，
	   所以允许中间有少量非花括号字符，不能硬要求紧接 `{`。 */
	const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
		'[^{}]{0,120}\\{[^}]*border-color\\s*:\\s*' +
		p[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*!important', 'm');
	has(sel + ' 边框复位为 ' + p[1], re.test(css),
		'宿主 .btn,button{border:1px solid #3c3c3c !important} 会给每个按钮套一圈灰边');
});

console.log('\n== D. 不跟随系统明暗（浅色纸面是设计本身） ==');

has('mt5700.css 里没有 prefers-color-scheme 分支',
	css.indexOf('prefers-color-scheme') < 0,
	'一旦加上分支，插件就会在深色系统下变成另一套皮肤，与 design-v8 的浅色纸面冲突');

console.log('\n== E. 反向验证：把修复删掉必须判红 ==');

function stripLine(src, re) {
	return src.split('\n').filter(function (l) { return !re.test(l); }).join('\n');
}

const noColor = stripLine(css, /^\s*color:\s*var\(--mt5700-text\);\s*$/);
has('反向：删掉 .mt5700-page 的 color 后判否',
	decl(ruleBody(noColor, '.mt5700-page'), 'color', 'var(--mt5700-text)') === false,
	'删了还判真，说明这条断言没有实际约束力');

const noImp = css.replace(/background-color\s*:\s*var\(--mt5700-surface-sunken\)\s*!important/, '');
has('反向：去掉 !important 后判否',
	ctrlRe.test(noImp) === false,
	'去掉感叹号还判真，说明正则没锁住 !important');

const dark = css + '\n@media (prefers-color-scheme: dark) { .mt5700-page { color: #ccc; } }\n';
has('反向：塞一段 prefers-color-scheme 后判否',
	dark.indexOf('prefers-color-scheme') >= 0,
	'检测器抓不到新加的分支');

console.log('\n' + (fail ? 'FAILED' : 'PASS') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
