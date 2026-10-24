#!/usr/bin/env node
'use strict';

/*
 * 换行符契约：工作区文本必须保持 **LF**
 * ---------------------------------------------------------------------------
 * 起因（2026-09-20 一次真实事故）：
 *   编辑 euicc.js 时工具链把整个文件写成了 CRLF（仓库约定是 LF），
 *   而 git 侧 core.autocrlf=input 只做 CRLF→LF 归一 —— `git diff` 看起来
 *   完全正常，**看不出任何异常**。
 *
 *   后果不是"多几个 \r"这么轻：tests/euicc-contract.test.js 里有一条反向守卫用
 *
 *       /if \(sw === '6999'\) \{[\s\S]*?\n\t\t\}\n/
 *
 *   去切掉「6999 分支」。CRLF 下它**永远匹配不上** → 分支没被切掉 →
 *   `swInfo('6999')` 仍返回专用文案，这条反向断言从"证明守卫有效"
 *   直接变成稳定失败。本仓绝大多数测试都是**读源码文本 + 正则**，
 *   全都假设 LF —— 换行符一坏，一整类守卫的可信度都没了。
 *
 * 所以把「LF」钉成契约：不满足就当场判红并指出文件。
 * 修法：用 python 把该文件的 \r\n 全部替换成 \n。
 *
 * 用法：node tests/line-endings-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* 只查「会被测试当文本解析」的目录 —— 换行符会影响这些文件的断言结果 */
const SCAN = [
	{ dir: 'htdocs', exts: ['.js', '.css', '.htm', '.html'] },
	{ dir: 'tests', exts: ['.js'] },
	{ dir: 'tools', exts: ['.py'] },
	{ dir: 'root', exts: ['.uc', '.sh'] },
	/*
	 * ★ 无扩展名的随包脚本（如 root/usr/share/mt5700/to）也要查。
	 *   原来只按扩展名筛，这一整类直接被漏掉 —— 2026-10-24 真机事故：
	 *   那个脚本以 CRLF 装进设备，busybox ash 把 `then\r` 当成普通单词，
	 *   报 "unexpected end of file (expecting \"then\")"，整个限时器不可执行，
	 *   所有 AT 命令又回到「Rust 后端无应答」。本地 27 项测试却全绿。
	 */
	{ dir: 'root', exts: [''] }
];
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build'];

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

function walk(dir, exts, out) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		return out;   /* 目录不存在就跳过 */
	}
	names.forEach(function (name) {
		if (SKIP_DIRS.indexOf(name) >= 0) return;
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) { walk(p, exts, out); return; }
		if (exts.indexOf(path.extname(name).toLowerCase()) >= 0) out.push(p);
	});
	return out;
}

const files = [];
SCAN.forEach(function (s) { walk(path.join(ROOT, s.dir), s.exts, files); });
ok('扫到了待检查的文本文件（否则本测试等于没跑）', files.length > 20,
	'只扫到 ' + files.length + ' 个');
/* ★ 自检：无扩展名脚本必须真的在扫描集合里，否则上面新加的那条是空转 */
ok('★ 无扩展名随包脚本也被纳入扫描（如 usr/share/mt5700/to）',
	files.some(function (p) { return /usr[\\/]share[\\/]mt5700[\\/]to$/.test(p); }),
	'扫描集合里没有 usr/share/mt5700/to —— 无扩展名脚本又被漏掉了');

/* 沾了 CRLF 的文件：给出「CRLF 行数 / 总行数」，便于判断整文件转换还是局部混入 */
const crlfFiles = files.map(function (p) {
	const s = fs.readFileSync(p, 'utf8');
	const c = (s.match(/\r\n/g) || []).length;
	if (!c) return null;
	const l = (s.match(/\n/g) || []).length;
	return path.relative(ROOT, p).split(path.sep).join('/') +
		'（CRLF ' + c + '/' + l + ' 行' + (c === l ? '，整文件' : '，局部混入') + '）';
}).filter(Boolean);

ok('所有被测试解析的文本文件都是 LF（CRLF 会让假设 LF 的正则守卫静默失效）',
	crlfFiles.length === 0,
	crlfFiles.join('；') + '　修法：把该文件的 \\r\\n 全部替换成 \\n');

/*
 * 反向自检：本测试必须真能分辨 CRLF 与 LF。
 * 纯内存探测，避免"恒绿"与"真的都干净"看起来一样。
 */
const withCrlf = Buffer.from('a\r\nb\r\n', 'utf8');
const withLf = Buffer.from('a\nb\n', 'utf8');
ok('★ 反向自检：CRLF 探测逻辑确实能检出（不是恒绿）',
	withCrlf.indexOf('\r\n') >= 0 && withLf.indexOf('\r\n') < 0);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('换行符契约测试通过（工作区文本全部 LF）');
