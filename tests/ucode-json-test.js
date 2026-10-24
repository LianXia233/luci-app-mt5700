#!/usr/bin/env node
/**
 * ucode-json-test.js：rpcd ucode 插件里迷你 JSON 解析器的转义还原单测。
 *
 * 为什么需要它：`root/usr/share/rpcd/ucode/mt5700.uc` 因为本固件的 ucode
 * 没有 `require('json')`，自带了一个手写解析器 `jsonParse()`，**所有** RPC
 * 应答都要经过它 -- 它一旦有偏差，页面拿到的数据就与后端实际应答不一致，
 * 而这类偏差不会报错，只会「看起来怪」。
 *
 * 本用例钉住的是一处真实缺陷：旧实现的 `\uXXXX` 分支落到了 `else { out += e; }`，
 * 把 `\u001b`（AT 终端应答里的 ESC）拆成 `u001b` 五个字面字符。控制字符在
 * serde_json 序列化时必定写成 `\u00XX`，所以只要应答里带 ESC / Ctrl+Z，
 * 前端看到的就不是一个字节，而是 `u001a` 这种可见串 —— 任何「拿应答再做判断」
 * 的逻辑（如把 0x1A 当提交结束符）必然失配。
 *
 * 做法：从 .uc 源文件里原样抽出 `jsonParse()` 函数体，套进一个最小的
 * ucode 子集运行时（length / substr / match / int / chr / hex）在 Node 里跑，
 * 因此测的是**仓库里那份真实实现**，不是另抄一遍的复刻。
 *
 * 用法：node tests/ucode-json-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const UC = path.join(__dirname, '..', 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const src = fs.readFileSync(UC, 'utf8');

/* 抽出 jsonParse 函数体。
 * 结尾不能用「花括号配对」找：字符串字面量里的 { } 会把深度算错
 * （parseStr 的 `if (ch() == '}')` 就是一例）。这里用后置锚点：
 * jsonParse 之后紧跟的是共享工具注释块（`/*\n * 共享工具`）。 */
const start = src.indexOf('function jsonParse(s) {');
const end = src.indexOf('\n/*\n * 共享工具', start);
if (start < 0 || end < 0) {
	console.error('无法从 mt5700.uc 抽取 jsonParse（锚点变了？）');
	process.exit(1);
}
const body = src.slice(start, end);

/* ---- 最小 ucode 子集运行时 ---- */
function length(x) { return x == null ? 0 : String(x).length; }
function substr(s, a, b) {
	return b === undefined ? String(s).substr(a) : String(s).substr(a, b);
}
function match(s, re) { return String(s).match(re); }
function int(v) {
	if (v == null || v === '') return null;
	const n = parseInt(v, 10);
	return isNaN(n) ? null : n;
}
function chr(v) { return String.fromCharCode(v); }
function hex(v) { const n = parseInt(v, 16); return isNaN(n) ? 0 : n; }
/* 真实 ucode 的 uchr() 把码点编成 UTF-8 多字节串（实机验证：uchr(0x4e2d) 是
 * 3 字节）。这里的 JS 模拟用 UTF-16 码元，字符数与字节数在非 ASCII 上不一致——
 * 但本用例钉住的是「\uXXXX 解码到正确码点」这个行为，两者在该断言下等价。 */
function uchr(v) { return String.fromCodePoint(v); }

/* 回调前向声明在 ucode 里写作 `parseVal = function () {...}`，
 * Node 里要补上声明才能构成闭包（ucode 的隐式提升在 JS 里不成立）。 */
const mi = body.indexOf('parseVal = function () {');
const normalized = body.replace('let parseVal;', '');
const jsBody = normalized.slice(0, mi)
	+ normalized.slice(mi).replace('parseVal = function () {', 'const parseVal = function () {');

const jsonParse = new Function('length', 'substr', 'match', 'int', 'chr', 'hex', 'uchr',
	jsBody + '\nreturn jsonParse;')(length, substr, match, int, chr, hex, uchr);

/* ---- 用例 ---- */
let pass = 0, fail = 0;
function check(name, cond, detail) {
	if (cond) { pass++; console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
	else { fail++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

/* 模拟 Rust 后端的真实应答：serde_json 会把控制字符写成 \u00XX */
const payload = JSON.stringify({
	id: 1,
	result: { success: true, data: 'AT\r\n\u001bOK\r\n\u001a', error: null },
});
const got = jsonParse(payload);
const data = got.result.data;

check('整体结构解析正确', got.id === 1 && got.result.success === true);
check('普通转义 \\r \\n 还原', data.indexOf('\r\n') >= 0, JSON.stringify(data.slice(0, 4)));
check('\\u001b（ESC）还原为单个控制字符', data.indexOf('\u001b') >= 0,
	data.indexOf('\u001b') >= 0 ? '已还原' : '未还原：' + JSON.stringify(data));
check('\\u001a（Ctrl+Z）还原为单个控制字符', data.indexOf('\u001a') >= 0,
	data.indexOf('\u001a') >= 0 ? '已还原' : '未还原：' + JSON.stringify(data));
check('不残留字面 u001b / u001a', data.indexOf('u001b') < 0 && data.indexOf('u001a') < 0,
	JSON.stringify(data));
check('长度按字符计（控制字符各占 1）', data.length === 'AT\r\n\u001bOK\r\n\u001a'.length,
	String(data.length));

/* 非法 \u 序列不能被吃掉：保持原样，交给上层去发现 */
const bad = jsonParse(JSON.stringify({ x: '\\uZZZZ' }));
check('非法 \\u 序列原样保留', bad.x.indexOf('uZZZZ') >= 0 || bad.x.indexOf('\\u') >= 0,
	JSON.stringify(bad.x));

/* \uXXXX 解码到正确码点：控制字符一个字节，非 ASCII 到正确码点（uchr 路径）。
 * 锚住「不能用 chr()」这个回归：chr 是字节级的，>255 截断成 0xFF（实机验证）。
 * 注意 JSON 文本必须真的含反斜杠+u 序列：不能用 JSON.stringify（它会把反斜杠
 * 二次转义成 \\u，解码后只是字面 \u001b 六个字符，测不到 \u 分支）。 */
const uni = jsonParse('{"esc":"\\u001b","cn":"\\u4e2d"}');
check('\\u001b 解码为 ESC', uni.esc === '\u001b', JSON.stringify(uni.esc));
check('\\u4e2d 解码为中', uni.cn === '\u4e2d', JSON.stringify(uni.cn));
check('\\u 不残留字面 u001b / u4e2d',
	uni.esc.indexOf('u001b') < 0 && uni.cn.indexOf('u4e2d') < 0);

/* \b / \f：serde_json 对 0x08 / 0x0C 写短转义，旧实现落到 else 分支变成字母 b/f */
const bf = jsonParse(JSON.stringify({ b: '\b', f: '\f' }));
check('\\b 还原为退格', bf.b === '\b', JSON.stringify(bf.b));
check('\\f 还原为换页', bf.f === '\f', JSON.stringify(bf.f));

/* 中文与常规字段不受影响（确保没改坏原路径） */
const cn = jsonParse(JSON.stringify({ msg: '短信中心', n: null, t: true, a: [1, 2] }));
check('中文 / null / true / 数组解析正常',
	cn.msg === '短信中心' && cn.n === null && cn.t === true && cn.a.length === 2,
	JSON.stringify(cn));

/* ---- backendErrorShape：后端进程级错误 → 前端错误对象 ----
 *
 * 这层搬运是「分层预算」的判据来源：前端靠 cause 区分
 * 超时 / 端口未监听 / 熔断（rpc.js 的 noteCommandFailure），
 * 丢掉字段的后果是「一次后端超时被计进模组失败熔断」这种误判。 */
const beStart = src.indexOf('function backendErrorShape(err, msg) {');
const beEnd = src.indexOf('\nreturn {\n\tmt5700: {', beStart);
if (beStart < 0 || beEnd < 0) {
	console.error('无法从 mt5700.uc 抽取 backendErrorShape（锚点变了？）');
	process.exit(1);
}
function type(v) {
	if (v === null || v === undefined) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v;
}
function keys(o) { return Object.keys(o || {}); }
const backendErrorShape = new Function('length', 'keys', 'type',
	src.slice(beStart, beEnd) + '\nreturn backendErrorShape;')(length, keys, type);

const beShape = backendErrorShape(
	{ code: -32010, message: 'RPC 错误', cause: 'timeout', retryable: true, nested: { a: 1 }, list: [1] },
	'RPC 错误');
check('backendErrorShape：message 落进 error 字段', beShape.error === 'RPC 错误', JSON.stringify(beShape));
check('backendErrorShape：cause 一并带回（分层预算判据）', beShape.cause === 'timeout', beShape.cause);
check('backendErrorShape：其余标量一并带回', beShape.retryable === true && beShape.code === -32010);
check('backendErrorShape：嵌套对象/数组不外泄',
	beShape.nested === undefined && beShape.list === undefined);
check('backendErrorShape：始终标记 success=false', beShape.success === false);
const beBare = backendErrorShape({ message: 'x' }, 'x');
check('backendErrorShape：无 cause 时回落 backend-error', beBare.cause === 'backend-error');

console.log('\n===== 结果: ' + pass + '/' + (pass + fail) + ' 通过 =====');
process.exit(fail === 0 ? 0 : 1);
