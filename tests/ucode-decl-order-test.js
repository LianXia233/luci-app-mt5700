'use strict';

/* ucode 声明顺序守卫（零依赖，本地与 CI 共用）
 *
 * 背景：ucode 与 JavaScript 不同，**不做函数声明提升**。函数体内引用一个
 * 文本上更晚声明的顶层函数时，加载期不报错（`ucode -c` 也查不出来），
 * 直到真正调用才抛 `access to undeclared variable <name>`，rpcd 侧表现为
 * 整条 ubus 方法返回 “Unknown error”。
 *
 * 真实案例：fix/traffic-stats-interface-selection 给 netdevUsable() 增加了
 * readCounter() 调用，而 readCounter 写在几百行之后 —— Node vm 测试有提升
 * 语义所以全绿，实机一调用 netrate 就整体失败。
 *
 * 因此本脚本对仓库内所有 .uc 文件做静态顺序检查：任何顶层函数都不得调用
 * 文本上更晚声明的顶层函数。新增 .uc 会自动纳入检查。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function listUcFiles() {
	const acc = [];
	(function walk(dir) {
		fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
			if (entry.name === '.git' || entry.name === 'node_modules') {
				return;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith('.uc')) {
				acc.push(full);
			}
		});
	})(root);
	return acc;
}

/* 用等长空白替换注释与字符串字面量，避免把注释里的调用当成真实调用。
 * 保持长度不变，偏移量才能继续用来比较声明先后。 */
function stripNoise(text) {
	const out = text.split('');
	let i = 0;
	const n = text.length;
	let prevSignificant = '';

	while (i < n) {
		const ch = text[i];

		if (ch === '/' && text[i + 1] === '/') {
			let j = text.indexOf('\n', i);
			j = j < 0 ? n : j;
			for (let k = i; k < j; k++) { out[k] = ' '; }
			i = j;
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			let j = text.indexOf('*/', i + 2);
			j = j < 0 ? n : j + 2;
			for (let k = i; k < j; k++) { out[k] = ' '; }
			i = j;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let j = i + 1;
			while (j < n) {
				if (text[j] === '\\') { j += 2; continue; }
				if (text[j] === quote) { break; }
				j += 1;
			}
			for (let k = i; k < Math.min(j + 1, n); k++) { out[k] = ' '; }
			i = j + 1;
			prevSignificant = quote;
			continue;
		}
		/* 正则字面量：/ 出现在运算位置之后才是正则，避免把除号误判为正则开头 */
		if (ch === '/' && '(,=:[!&|?{;\n '.indexOf(prevSignificant) >= 0) {
			let j = i + 1;
			let inClass = false;
			while (j < n) {
				if (text[j] === '\\') { j += 2; continue; }
				if (text[j] === '[') { inClass = true; }
				else if (text[j] === ']') { inClass = false; }
				else if (text[j] === '/' && !inClass) { break; }
				j += 1;
			}
			for (let k = i; k < Math.min(j + 1, n); k++) { out[k] = ' '; }
			i = j + 1;
			continue;
		}
		if (!/\s/.test(ch)) {
			prevSignificant = ch;
		}
		i += 1;
	}
	return out.join('');
}

/* 顶层 `function NAME(` 声明，按出现顺序 */
function topLevelDeclarations(clean) {
	const decls = [];
	const re = /^function ([A-Za-z_]\w*)\s*\(/gm;
	let m;
	while ((m = re.exec(clean)) !== null) {
		decls.push({ name: m[1], offset: m.index });
	}
	return decls;
}

function bodyEnd(clean, openIndex) {
	let depth = 0;
	let j = openIndex;
	while (j < clean.length) {
		if (clean[j] === '{') { depth += 1; }
		else if (clean[j] === '}') {
			depth -= 1;
			if (depth === 0) { return j; }
		}
		j += 1;
	}
	return clean.length;
}

const files = listUcFiles();
assert(files.length > 0, '未找到任何 .uc 文件，检查 tests/ 目录位置');

let checked = 0;
let violations = 0;

files.forEach(function (file) {
	const rel = path.relative(root, file).split(path.sep).join('/');
	const clean = stripNoise(fs.readFileSync(file, 'utf8'));
	const decls = topLevelDeclarations(clean);
	const offsetOf = {};
	decls.forEach(function (d) { offsetOf[d.name] = d.offset; });
	const names = decls.map(function (d) { return d.name; });

	decls.forEach(function (decl) {
		const open = clean.indexOf('{', decl.offset);
		assert(open >= 0, rel + ': ' + decl.name + ' 找不到函数体');
		const body = clean.slice(open, bodyEnd(clean, open));
		names.forEach(function (other) {
			if (other === decl.name) { return; }
			const called = new RegExp('\\b' + other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(').test(body);
			if (called && offsetOf[other] > decl.offset) {
				violations += 1;
				console.log('  FAIL ' + rel + ': ' + decl.name + '() 调用了更晚声明的 ' + other + '()');
			}
		});
	});
	checked += 1;
	console.log('  ok   ' + rel + '（顶层函数 ' + decls.length + ' 个）');
});

assert.strictEqual(violations, 0, '存在 ' + violations + ' 处 ucode 前置引用，实机会在调用时抛 ReferenceError');

console.log('ucode 声明顺序: ' + checked + ' 个文件，0 处前置引用');
