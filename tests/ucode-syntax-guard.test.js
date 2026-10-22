#!/usr/bin/env node
/*
 * ucode 语法安全守卫（2026-10-22 真机事故）
 * ---------------------------------------------------------------------------
 * 本固件（ZJJCKA 25.12.5）的 ucode **不支持 throw 语句**：`try { throw "x"; }`
 * 直接 Syntax error —— 而 ucode 是整个文件编译的，一处 throw = 整个
 * mt5700.uc 编译失败 = rpcd 不注册 mt5700 对象 = **所有页面 -32000 Object
 * not found**（当天真机实测：Syntax error 落在第 96 行 throw 关键字上；
 * ubus 对象消失、SSH `ubus call` 与 session 链路全部 Not found）。
 *
 * 本固件 ucode 只有 try/catch，从无 throw。jsonParse 的解析失败语义用
 * 「闭包内 fail 标志 + 返回 null」表达（见 jsonParse 头部注释）。
 *
 * 本守卫只做静态断言：ucode 源码里不得出现 throw 语句。
 * 运行：node tests/ucode-syntax-guard.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UC = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return true; }
	fails.push('  ✗ ' + name + (hint ? '\n      ' + hint : ''));
	return false;
}

if (!fs.existsSync(UC)) {
	console.log('缺少必需文件：' + UC);
	process.exit(1);
}

/* 去注释后检查：注释里提到 throw 的教训说明是合法且必要的（红线上墙）。
 * stripComments 与 ui-copy-contract 同一套路：只在 / 后判 // 与 block。 */
const src = fs.readFileSync(UC, 'utf8');
let out = '';
let i = 0;
let inBlock = false;
let inLine = false;
let inStr = null;
while (i < src.length) {
	const c = src[i];
	const next = src[i + 1];
	if (inLine) {
		if (c === '\n') { inLine = false; out += c; }
		i++;
		continue;
	}
	if (inBlock) {
		if (c === '*' && next === '/') { inBlock = false; i += 2; out += ' '; continue; }
		i++;
		continue;
	}
	if (inStr) {
		if (c === '\\') { out += src.substr(i, 2); i += 2; continue; }
		if (c === inStr) { inStr = null; }
		out += c;
		i++;
		continue;
	}
	if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; i++; continue; }
	if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
	if (c === '/' && next === '*') { inBlock = true; i += 2; out += ' '; continue; }
	out += c;
	i++;
}

/* ① 无 throw 语句（去注释后） */
ok('mt5700.uc 无 throw 语句（本固件 ucode 不支持，一处即全文件编译失败）',
	!/(\{|;|^|\n)\s*throw\s/.test(out) && !/\bthrow\s+['"`\w]/.test(out),
	'本固件 ucode 的 throw 是 Syntax error；解析失败语义用「fail 标志 + 返回 null」表达');

/* ② fail 标志语义还在（jsonParse 的解析失败必须真的可达） */
ok('jsonParse 保留 fail 标志（解析失败返回 null 的语义不能丢）',
	/let fail = 0;/.test(src) && /if \(fail \|\| i != n\) \{/.test(src),
	'fail 标志是 B08（截断应答按失败处理）的实现载体');

/* ③ 调用方判空：jsonParse 的失败以 null 表达，rpcCall 入口必须显式判 */
ok('rpcCall 对 jsonParse 的 null 结果显式报错（截断的应答不再按成功透传）',
	/if \(resp == null\) \{[\s\S]{0,120}?解析后端应答失败/.test(src),
	'丢失这条判断 = 截断应答半截 data 继续走');

console.log('');
if (fails.length) {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.log(f); });
	process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
