'use strict';
/**
 * 信号趋势图绘制单测（重绘版）
 *
 * 覆盖三个纯函数（均从 network_status.js 抽取）：
 *   signalTierIndex()    RSRP → 质量分区下标（与图标分档口径一致）
 *   chartScale()         值域 → 像素映射（含越界钳制）
 *   smoothPathPoints()   折线点集 → Catmull-Rom 平滑路径
 *
 * 运行：node tests/signal-chart-test.js
 */

const fs = require('fs');
const path = require('path');

const viewDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');
const code = fs.readFileSync(path.join(viewDir, 'network_status.js'), 'utf8');

const start = code.indexOf('var SIGNAL_TIERS = [');
const end = code.indexOf('function renderSignalTrendChart()');
if (start < 0 || end < 0) {
	console.log('FAIL  未能在 network_status.js 中定位曲线图绘制函数');
	process.exit(1);
}

const factory = new Function(code.slice(start, end) +
	'\n;return { signalTierIndex: signalTierIndex, chartScale: chartScale, smoothPathPoints: smoothPathPoints, TIERS: SIGNAL_TIERS, TICKS: CHART_TICKS };');
const env = factory();

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

function near(a, b, eps) {
	return Math.abs(a - b) <= (eps || 1e-6);
}

try {
	/* ---------- 1. 质量分区（与图标分档一致） ---------- */
	check('分区数固定为 4 档', env.TIERS.length === 4, 'len=' + env.TIERS.length);
	check('RSRP -130 → 较差', env.signalTierIndex(-130) === 0, env.signalTierIndex(-130));
	check('RSRP -110 → 一般', env.signalTierIndex(-110) === 1, env.signalTierIndex(-110));
	check('RSRP -108 → 一般', env.signalTierIndex(-108) === 1, env.signalTierIndex(-108));
	check('RSRP -95 → 良好', env.signalTierIndex(-95) === 2, env.signalTierIndex(-95));
	check('RSRP -81 → 良好', env.signalTierIndex(-81) === 2, env.signalTierIndex(-81));
	check('RSRP -80 → 极佳', env.signalTierIndex(-80) === 3, env.signalTierIndex(-80));
	check('RSRP -64 → 极佳', env.signalTierIndex(-64) === 3, env.signalTierIndex(-64));
	check('RSRP -50（越界）→ 极佳', env.signalTierIndex(-50) === 3, env.signalTierIndex(-50));
	check('无读数 → -1（不落到任何分区）',
		env.signalTierIndex(null) === -1 && env.signalTierIndex('') === -1 && env.signalTierIndex(undefined) === -1 && env.signalTierIndex(NaN) === -1,
		'null/empty/undefined/NaN');

	/* ---------- 2. 值域 → 像素映射 ---------- */
	{
		const top = 26, bottom = 306;
		check('上界映射到顶部', near(env.chartScale(-53, -125, -53, top, bottom), top), env.chartScale(-53, -125, -53, top, bottom));
		check('下界映射到底部', near(env.chartScale(-125, -125, -53, top, bottom), bottom), env.chartScale(-125, -125, -53, top, bottom));
		check('中点映射到正中', near(env.chartScale(-89, -125, -53, top, bottom), (top + bottom) / 2, 1e-6),
			env.chartScale(-89, -125, -53, top, bottom));
		check('低于下界被钳制到底部', near(env.chartScale(-140, -125, -53, top, bottom), bottom), 'clamp-low');
		check('高于上界被钳制到顶部', near(env.chartScale(-20, -125, -53, top, bottom), top), 'clamp-high');
		check('非法值回落到下界位置', near(env.chartScale(NaN, -125, -53, top, bottom), bottom), 'nan');
		check('SINR 轴映射独立成立（35 → 顶部）', near(env.chartScale(35, -5, 35, top, bottom), top), 'sinr');
	}

	/* ---------- 3. 平滑路径生成 ---------- */
	{
		check('空点集返回空串', env.smoothPathPoints([], 0, 100) === '', 'empty');
		check('单点仅生成 M 指令', env.smoothPathPoints([[10, 20]], 0, 100) === 'M 10.0 20.0', env.smoothPathPoints([[10, 20]], 0, 100));

		const pts = [[0, 50], [50, 20], [100, 80], [150, 40]];
		const d = env.smoothPathPoints(pts, 0, 100);
		check('路径以 M 起始且含 3 段三次贝塞尔',
			d.indexOf('M 0.0 50.0') === 0 && (d.match(/ C /g) || []).length === 3,
			'segments=' + (d.match(/ C /g) || []).length);
		check('路径终点与最后一个采样点一致', d.trim().endsWith('150.0 40.0'), d.slice(-14));

		const clamped = env.smoothPathPoints([[0, -50], [50, 200]], 0, 100);
		const nums = clamped.match(/-?\d+(\.\d+)?/g).map(Number);
		const ys = nums.filter(function (_, i) { return i % 2 === 1; });
		check('超出绘图区的 y 被钳制到 [0,100]',
			ys.every(function (y) { return y >= 0 && y <= 100; }), ys.join(','));

		const two = env.smoothPathPoints([[0, 10], [100, 90]], 0, 100);
		check('两点也能生成合法曲线', two.indexOf('M 0.0 10.0') === 0 && two.indexOf(' C ') > 0, two);

	/* ---------- 4. 双轴刻度表与实际位置一致 ---------- */
	{
		const ticks = env.TICKS;
		check('刻度共 5 级', ticks.length === 5, 'len=' + ticks.length);
		check('y 自顶向下单调递增',
			ticks.every(function (t, i) { return i === 0 || t.y > ticks[i - 1].y; }),
			ticks.map(function (t) { return t.y; }).join(','));
		check('RSRP 刻度随 y 递减（数值越大越靠上）',
			ticks.every(function (t, i) { return i === 0 || t.rsrp < ticks[i - 1].rsrp; }),
			ticks.map(function (t) { return t.rsrp; }).join(','));
		check('SINR 刻度随 y 递减',
			ticks.every(function (t, i) { return i === 0 || t.sinr < ticks[i - 1].sinr; }),
			ticks.map(function (t) { return t.sinr; }).join(','));

		const top = 26, bottom = 306;
		const h = bottom - top;
		const mismatch = ticks.filter(function (t) {
			const yPx = env.chartScale(t.rsrp, -125, -53, top, bottom);
			return Math.abs(yPx - (top + h * t.y)) > 1;
		});
		check('每个 RSRP 刻度值与其 y 位置严格对应', mismatch.length === 0,
			mismatch.map(function (t) { return t.rsrp + '@' + t.y; }).join(',') || 'ok');

		const mismatchSinr = ticks.filter(function (t) {
			const yPx = env.chartScale(t.sinr, -5, 35, top, bottom);
			return Math.abs(yPx - (top + h * t.y)) > 1;
		});
		check('每个 SINR 刻度值与其 y 位置严格对应', mismatchSinr.length === 0,
			mismatchSinr.map(function (t) { return t.sinr + '@' + t.y; }).join(',') || 'ok');
	}
	}
} catch (e) {
	check('单测执行', false, String((e && e.stack) || e));
}

const fails = results.filter(function (r) { return !r.ok; });
console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
if (fails.length) {
	fails.forEach(function (f) { console.log('FAILED: ' + f.name + ' — ' + f.detail); });
	process.exit(1);
}
process.exit(0);
