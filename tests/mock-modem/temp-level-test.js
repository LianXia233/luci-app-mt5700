/* 模组温度分级逻辑单测 —— 从 mt5700.js 抽取纯函数在 Node 中验证 */
'use strict';

const fs = require('fs');
const path = require('path');

const MTJS = 'C:/Users/LX233/WorkBuddy/2026-09-13-13-18-44/luci-app-mt5700/htdocs/luci-static/resources/at-webserver/mt5700.js';
const src = fs.readFileSync(MTJS, 'utf8');

/* 抽取 TEMP_WARN_C / TEMP_HIGH_C / tempLevel 的真实实现，避免测试与实现漂移 */
const warnM = src.match(/api\.TEMP_WARN_C\s*=\s*([\d.]+)/);
const highM = src.match(/api\.TEMP_HIGH_C\s*=\s*([\d.]+)/);
const fnM = src.match(/api\.tempLevel\s*=\s*function\s*\(value\)\s*\{([\s\S]*?)\n\t\};/);

if (!warnM || !highM || !fnM) {
	console.error('无法从源码抽取温度逻辑');
	process.exit(1);
}

const TEMP_WARN_C = parseFloat(warnM[1]);
const TEMP_HIGH_C = parseFloat(highM[1]);
const api = { TEMP_WARN_C, TEMP_HIGH_C };
// eslint-disable-next-line no-new-func
const tempLevel = new Function('api', 'isNaN', 'return function(value){' + fnM[1] + '};')(api, isNaN);

console.log('阈值: warn=' + TEMP_WARN_C + ' high=' + TEMP_HIGH_C);

const cases = [
	[45, 'normal', '常温'],
	[69.9, 'normal', '正常上限'],
	[70, 'warn', '偏高下限'],
	[77.5, 'warn', '偏高中段'],
	[84.9, 'warn', '偏高上限'],
	[85, 'high', '过高下限'],
	[95, 'high', '过热'],
	[120, 'high', '极端过热'],
	[0, null, '无效零值'],
	[null, null, '空值'],
	[undefined, null, 'undefined'],
	[NaN, null, 'NaN'],
	[-5, null, '负值'],
];

let pass = 0, fail = 0;
cases.forEach(function (c) {
	const got = tempLevel(c[0]);
	const ok = got === c[1];
	if (ok) pass++; else fail++;
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + String(c[0]).padEnd(10) + ' -> ' + String(got).padEnd(8) + ' (期望 ' + c[1] + ')  ' + c[2]);
});

/* 逐项独立分级：模拟 7 项芯片混合温度，确认不存在平均值掩盖 */
const sample = { sub3GPA: 62, sub6GPA: 74, mimoPa: 88, tcxo: 55, ap1: 67, ap2: 71, modem1: 80 };
const levels = Object.keys(sample).map(function (k) { return tempLevel(sample[k]); });
const expect = ['normal', 'warn', 'high', 'normal', 'normal', 'warn', 'warn'];
const mixOk = JSON.stringify(levels) === JSON.stringify(expect);
if (mixOk) pass++; else fail++;
console.log((mixOk ? 'PASS' : 'FAIL') + '  逐项独立分级 -> ' + JSON.stringify(levels));

const avg = Object.keys(sample).reduce(function (a, k) { return a + sample[k]; }, 0) / 7;
console.log('  (平均值 ' + avg.toFixed(1) + ' ℃ 会判为 ' + tempLevel(avg) + '，若取平均将掩盖 mimoPa=88℃ 的过热)');

console.log('\n结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
