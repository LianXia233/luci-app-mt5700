/* 模组温度分级逻辑单测（6 档）—— 从 mt5700.js 抽取纯函数在 Node 中验证 */
'use strict';

const fs = require('fs');

const MTJS = 'C:/Users/LX233/WorkBuddy/2026-09-13-13-18-44/luci-app-mt5700/htdocs/luci-static/resources/at-webserver/mt5700.js';
const src = fs.readFileSync(MTJS, 'utf8');

/* 抽取 TEMP_LEVELS 表与 tempLevel 的真实实现，避免测试与实现漂移 */
const tblM = src.match(/api\.TEMP_LEVELS\s*=\s*\[([\s\S]*?)\];/);
const fnM = src.match(/api\.tempLevel\s*=\s*function\s*\(value\)\s*\{([\s\S]*?)\n\t\};/);

if (!tblM || !fnM) {
	console.error('无法从源码抽取温度逻辑');
	process.exit(1);
}

// 解析阈值表 [{level, min}, ...]
const TEMP_LEVELS = [];
const re = /\{\s*level:\s*'([a-z]+)'\s*,\s*min:\s*(-?[\w.]+)\s*\}/g;
let m;
while ((m = re.exec(tblM[1])) !== null) {
	TEMP_LEVELS.push({ level: m[1], min: m[2] === '-Infinity' ? -Infinity : parseFloat(m[2]) });
}

if (!TEMP_LEVELS.length) {
	console.error('未能解析 TEMP_LEVELS');
	process.exit(1);
}

const api = { TEMP_LEVELS };
// eslint-disable-next-line no-new-func
const tempLevel = new Function('api', 'isNaN', 'return function(value){' + fnM[1] + '};')(api, isNaN);

console.log('=== 解析到的阈值表（由高到低） ===');
TEMP_LEVELS.forEach(function (l) {
	console.log('  ' + l.level.padEnd(7) + ' >= ' + l.min);
});

const cases = [
	// 6 档覆盖
	[20, 'cold', '低温环境'],
	[34.9, 'cold', '偏低上限'],
	[35, 'cool', '温和下限（边界）'],
	[40, 'cool', '实机常态'],
	[44.5, 'cool', '实机常态'],
	[52.9, 'cool', '温和上限'],
	[53, 'normal', '正常下限（边界）'],
	[58, 'normal', '正常中段'],
	[60.9, 'normal', '正常上限'],
	[61, 'warm', '偏暖下限（边界）'],
	[65, 'warm', '偏暖中段'],
	[68.9, 'warm', '偏暖上限'],
	[69, 'hot', '偏高下限（边界）'],
	[73, 'hot', '偏高中段'],
	[76.9, 'hot', '偏高上限'],
	[77, 'high', '过高下限（边界）'],
	[85, 'high', '过热'],
	[120, 'high', '极端过热'],
	// 无效值
	[0, null, '无效零值'],
	[null, null, '空值'],
	[undefined, null, 'undefined'],
	[NaN, null, 'NaN'],
	[-5, null, '负值'],
];

let pass = 0, fail = 0;
const failed = [];
console.log('\n=== 逐档断言 ===');
cases.forEach(function (c) {
	const got = tempLevel(c[0]);
	const ok = got === c[1];
	if (ok) pass++; else { fail++; failed.push(c); }
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + String(c[0]).padEnd(9) + ' -> ' + String(got).padEnd(8) + ' (期望 ' + String(c[1]).padEnd(7) + ') ' + c[2]);
});

/* 单调性：温度升高，档位严重度不得下降 */
const ORDER = ['cold', 'cool', 'normal', 'warm', 'hot', 'high'];
let mono = true;
for (let t = 1; t <= 120; t++) {
	const a = tempLevel(t), b = tempLevel(t + 1);
	if (a == null || b == null) continue;
	if (ORDER.indexOf(b) < ORDER.indexOf(a)) { mono = false; console.log('  非单调于 ' + t + '->' + (t + 1) + ': ' + a + '->' + b); break; }
}
if (mono) pass++; else fail++;
console.log('\n[' + (mono ? 'PASS' : 'FAIL') + '] 1-120℃ 全程单调不降档');

/* 逐项独立分级：7 项芯片混合温度，确认无平均值掩盖 */
const sample = { sub3GPA: 42, sub6GPA: 55, mimoPa: 71, tcxo: 38, ap1: 48, ap2: 63, modem1: 58 };
const levels = Object.keys(sample).map(function (k) { return tempLevel(sample[k]); });
const expect = ['cool', 'normal', 'hot', 'cool', 'cool', 'warm', 'normal'];
const mixOk = JSON.stringify(levels) === JSON.stringify(expect);
if (mixOk) pass++; else fail++;
console.log('[' + (mixOk ? 'PASS' : 'FAIL') + '] 逐项独立分级 -> ' + JSON.stringify(levels));

const avg = Object.keys(sample).reduce(function (a, k) { return a + sample[k]; }, 0) / 7;
console.log('  (平均值 ' + avg.toFixed(1) + '℃ 仅判为 ' + tempLevel(avg) + '，若取平均将掩盖 mimoPa=71℃ 的偏高)');

/* 6 档全部可达：确认每一档都有对应温度区间 */
const reached = new Set();
for (let t = 1; t <= 130; t++) reached.add(tempLevel(t));
const allReachable = ORDER.every(function (lv) { return reached.has(lv); });
if (allReachable) pass++; else fail++;
console.log('[' + (allReachable ? 'PASS' : 'FAIL') + '] 6 档在 1-130℃ 内全部可达: ' + Array.from(reached).join(', '));

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
