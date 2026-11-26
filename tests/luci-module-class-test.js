'use strict';
/**
 * LuCI 模块工厂契约回归测试（零依赖）
 *
 * 背景（真实故障）：LuCI 26.x（luci.js 26.322 起）的 `L.require` 会把模块源码包进
 *   function(window, document, L, ...deps) { ...源码... }
 * 执行，再用 `Class.isSubclass(result)` 校验返回值：
 *   isSubclass(v) { return typeof v == 'function' && v.prototype instanceof Class }
 * 也就是说模块**必须返回 Class 子类构造器**。新模块若沿用旧写法 `return { ... }`，
 * 整页 require 直接抛
 *   TypeError: "mt5700d/xxx" factory yields invalid constructor
 * 且 Promise.all 会让同页其它模块一起加载失败——现象是页面白屏/报错，与业务无关，
 * 但静态检查（node --check）完全看不出来。
 *
 * 本测试把契约固化成可执行断言：`htdocs/luci-static/resources/mt5700d/*.js`
 * 每个文件都必须
 *   1) 调用 L.Class.extend(...)；
 *   2) 把实例挂到 window（页面通过全局名直接使用，require 的形参名不是模块名）；
 *   3) 以 `return <X>Class;` 结尾（工厂的返回值就是加载器校验的那个构造器）。
 *
 * 运行方式：node tests/luci-module-class-test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'htdocs', 'luci-static', 'resources', 'mt5700d');

let failed = false;
function assert(desc, ok, extra) {
	if (ok) {
		console.log('  ok   ' + desc);
	} else {
		failed = true;
		console.error('  FAIL ' + desc + (extra ? '\n        ' + extra : ''));
	}
}

/** 去掉行注释/块注释，避免注释里的示例代码造成假阳性。
 *  不做字符串/正则字面量剥离：parse.js、rpc.js 里有大量正则，朴素的引号状态机会
 *  把 `/.../` 当成字符串起点而吃掉后半个文件（实测会漏掉 L.Class.extend），
 *  而注释剥离已经足够——字符串里出现 `var X = L.Class.extend(` 的概率可忽略。 */
function stripComments(src) {
	let out = '';
	let i = 0, block = false, line = false;
	while (i < src.length) {
		const c = src[i], n = src[i + 1];
		if (block) {
			if (c === '*' && n === '/') { block = false; i += 2; continue; }
			i++; continue;
		}
		if (line) {
			if (c === '\n') { line = false; out += c; }
			i++; continue;
		}
		if (c === '/' && n === '*') { block = true; i += 2; continue; }
		if (c === '/' && n === '/') { line = true; i += 2; continue; }
		out += c;
		i++;
	}
	return out;
}

console.log('==> LuCI 模块工厂契约（必须返回 Class 子类）');

const files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); }).sort();
assert('模块目录存在且非空（' + files.length + ' 个模块）', files.length > 0);

files.forEach(function (file) {
	const src = fs.readFileSync(path.join(dir, file), 'utf8');
	const code = stripComments(src);

	const extendsMatch = /var\s+(\w+Class)\s*=\s*L\.Class\.extend\(/.exec(code);
	assert(file + ' 使用 L.Class.extend(...) 生成类', !!extendsMatch,
		'缺少 `var XClass = L.Class.extend(...)`：旧式 `return {...}` 会触发 ' +
		'"factory yields invalid constructor"');
	if (!extendsMatch) return;

	const cls = extendsMatch[1];

	assert(file + ' 把实例挂到 window（页面通过全局名调用）',
		new RegExp('window\\.\\w+\\s*=\\s*new\\s+' + cls + '\\s*\\(').test(code),
		'缺少 `window.X = new ' + cls + '()`');

	/* 工厂返回值就是加载器交给 Class.isSubclass 校验的东西：结尾必须是它 */
	const tail = code.trimEnd();
	assert(file + ' 以 return ' + cls + '; 结尾', tail.endsWith('return ' + cls + ';'),
		'结尾实际为: ' + JSON.stringify(tail.slice(-60)));
});

console.log('');
if (failed) {
	console.error('FAILED');
	process.exit(1);
}
console.log('ALL PASSED');
