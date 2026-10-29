'use strict';
/**
 * 推送频率限制（防刷屏）单测
 *
 * 背景：模组在 LTE↔NR 覆盖边缘来回切换时，信号巡检每一轮都判定为「有变化」，
 * 默认 300 秒轮询下能一分钟连着推好几条，把 QQ 刷屏。v1.30.7 加了两级限制：
 *   1) notify_signal_min_interval（默认 60 分钟）—— 信号类通知的最小间隔，
 *      在 signalwatch / urc 两个「生产者」处生效，定时推送（timerpush）明确豁免；
 *   2) qq_max_per_minute（默认 10 条/分钟）—— QQ 通道按间隔排队发送，延后不丢弃。
 *
 * 本测试是零依赖的「接线检查」：JS 侧把 rateText / qqRateText 抠出来跑真实逻辑，
 * Rust 与 UCI 侧检查关键接线是否存在、默认值是否一致、豁免项是否真的没被闸门管住。
 * 真正的行为验证在 Rust 单测里（config.rs / notify.rs / qqpush.rs）。
 *
 * 运行：node tests/push-rate-test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = function (p) { return fs.readFileSync(path.join(root, p), 'utf8'); };

const serviceJs = read(path.join('htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'service.js'));
const uciDefaults = read(path.join('root', 'etc', 'config', 'at-webserver'));
const configRs = read(path.join('src', 'rust', 'src', 'config.rs'));
const notifyRs = read(path.join('src', 'rust', 'src', 'notify.rs'));
const signalwatchRs = read(path.join('src', 'rust', 'src', 'signalwatch.rs'));
const urcRs = read(path.join('src', 'rust', 'src', 'urc.rs'));
const timerpushRs = read(path.join('src', 'rust', 'src', 'timerpush.rs'));
const qqpushRs = read(path.join('src', 'rust', 'src', 'qqpush.rs'));

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

/* ---------- 1. UCI 出厂默认值 ---------- */
check('UCI 默认写入 notify_signal_min_interval 60（一小时一条）',
	/^\s*option\s+notify_signal_min_interval\s+'60'\s*$/m.test(uciDefaults),
	'默认值');
check('UCI 默认写入 qq_max_per_minute 10',
	/^\s*option\s+qq_max_per_minute\s+'10'\s*$/m.test(uciDefaults),
	'默认值');
check('两个新项都带说明注释（不是裸 option）',
	/#.*最小间隔[\s\S]{0,600}?option\s+notify_signal_min_interval/.test(uciDefaults)
	&& /#.*节流[\s\S]{0,400}?option\s+qq_max_per_minute/.test(uciDefaults),
	'注释');

/* ---------- 2. Rust 默认值与 UCI 默认值一致 ---------- */
check('config.rs 默认间隔常量 = 60 分钟',
	/pub const DEFAULT_NOTIFY_SIGNAL_MIN_INTERVAL_MIN:\s*u64\s*=\s*60/.test(configRs),
	'DEFAULT_NOTIFY_SIGNAL_MIN_INTERVAL_MIN');
check('config.rs 间隔上限 = 10080 分钟（7 天）',
	/pub const MAX_NOTIFY_SIGNAL_MIN_INTERVAL_MIN:\s*u64\s*=\s*10080/.test(configRs),
	'MAX');
check('config.rs 默认 QQ 节流 = 10 条/分钟',
	/pub const DEFAULT_QQ_MAX_PER_MIN:\s*u64\s*=\s*10/.test(configRs),
	'DEFAULT_QQ_MAX_PER_MIN');
check('config.rs 解析 notify_signal_min_interval',
	values_uses_key('notify_signal_min_interval'),
	'解析');
check('config.rs 解析 qq_max_per_minute',
	values_uses_key('qq_max_per_minute'),
	'解析');
function values_uses_key(key) {
	// 允许 values.int("k") 与跨行链式 .int("k") 两种写法
	return new RegExp('\\.\\w+\\("' + key + '"').test(configRs);
}

/* ---------- 3. 闸门接在生产者上，且只接在信号类路径 ---------- */
check('notify.rs 提供 min_interval_hold 纯函数闸门',
	/pub fn min_interval_hold\(/.test(notifyRs), '闸门函数');
check('notify.rs 暴露 signal_min_interval() 读取器',
	/pub fn signal_min_interval\(&self\)/.test(notifyRs), 'accessor');
check('signalwatch.rs 应用闸门（巡检路径）',
	/\bmin_interval_hold\(/.test(signalwatchRs), 'tick');
check('urc.rs 应用闸门（URC 上报路径，保留实现）',
	/\bmin_interval_hold\(/.test(urcRs), 'handle_signal');
check('timerpush.rs 不受闸门限制（用户自定的固定节奏）',
	!/\bmin_interval_hold\(|signal_min_interval\(/.test(timerpushRs), '豁免');
function notifyProdCode(src) {
	const i = src.indexOf('#[cfg(test)]');
	return i < 0 ? src : src.slice(0, i);
}

check('闸门不作用于短信/来电分发（notify.rs 生产代码里只定义、不调用）',
	(notifyProdCode(notifyRs).match(/\bmin_interval_hold\(/g) || []).length === 1,
	'仅定义处一次');
check('signalwatch.rs 被压住的那轮不刷新基线（到点后累计变化能立即补推）',
	(() => {
		const i = signalwatchRs.indexOf('Decision::Held(rest) =>');
		return i >= 0 && signalwatchRs.slice(i).indexOf('note_push(') < 0;
	})(), '基线保留');

/* ---------- 4. QQ 通道是「延后」而不是「丢弃」 ---------- */
check('qqpush.rs 有 throttle_gap / reserve_slot / pace 排队实现',
	/pub fn throttle_gap\(&self\)/.test(qqpushRs)
	&& /fn reserve_slot\(&self, now: Instant\)/.test(qqpushRs)
	&& /async fn pace\(&self\)/.test(qqpushRs), '实现');
check('qqpush.rs send() 先排队再发送',
	/self\.pace\(\)\.await/.test(qqpushRs), 'pace');
check('qqpush.rs 排队等待有上限兜底（不会被历史积压拖死）',
	/const PACE_MAX_WAIT/.test(qqpushRs), 'PACE_MAX_WAIT');
check('qqpush.rs 间隔按毫秒换算（与页面显示的「约每 N 秒」一致，不因整秒截断而超速）',
	/Duration::from_millis\(60_000\s*\/\s*self\.max_per_minute/.test(qqpushRs), 'from_millis');
check('main.rs 绑定流程重建 QQ 配置时带上 max_per_minute',
	(() => {
		const main = read(path.join('src', 'rust', 'src', 'main.rs'));
		return /max_per_minute:\s*q\.max_per_minute/.test(main);
	})(), '不丢配置');

/* ---------- 5. LuCI 页面：真实抠出 rateText / qqRateText 跑逻辑 ---------- */
function extractFn(code, name, nextMarker) {
	const start = code.indexOf('function ' + name + '(');
	if (start < 0) return null;
	const end = code.indexOf(nextMarker, start);
	if (end < 0) return null;
	return code.slice(start, end);
}

const rateSrc = extractFn(serviceJs, 'rateText', '\t\tfunction rateSync');
const qqRateSrc = extractFn(serviceJs, 'qqRateText', '\t\tqqRateInput.addEventListener');
const tailStart = serviceJs.indexOf('var QQ_RATE_TAIL');
const tailSrc = tailStart < 0 ? '' : serviceJs.slice(tailStart, serviceJs.indexOf('function qqRateText'));

check('service.js 能定位 rateText（页面文案逻辑可测）', rateSrc !== null, 'rateText');
check('service.js 能定位 qqRateText 与其平台频控常量', qqRateSrc !== null && tailSrc !== '', 'qqRateText');

let rateText = null, qqRateText = null;
if (rateSrc && qqRateSrc && tailSrc) {
	rateText = new Function(tailSrc + '\n' + rateSrc + '\n;return rateText;')();
	qqRateText = new Function(tailSrc + '\n' + qqRateSrc + '\n;return qqRateText;')();
}

try {
	if (rateText) {
	check('最小间隔 60 → 文案为「1 小时」', /1 小时/.test(rateText('60')) && !/天/.test(rateText('60')),
		rateText('60'));
	check('最小间隔 0 → 文案明确「不限频」并提示会刷屏',
		/不限频/.test(rateText('0')), '0');
	check('最小间隔 90 → 文案拆成「1 小时 30 分钟」',
		/1 小时 30 分钟/.test(rateText('90')), '90');
	check('最小间隔 1440 → 文案用「天」为单位',
		/1 天/.test(rateText('1440')), '1440');
	check('最小间隔 10081 → 文案提示超出上限将被夹取',
		/超出上限/.test(rateText('10081')), '10081');
	check('最小间隔为空/非法 → 文案说明按默认 1 小时回落',
		/默认 1 小时/.test(rateText('')) && /默认 1 小时/.test(rateText('abc')), 'empty/garbage');
}
if (qqRateText) {
	check('QQ 节流 10 → 6 秒一条',
		/10 条\/分钟/.test(qqRateText(10)) && /6 秒/.test(qqRateText(10)), qqRateText(10));
	check('QQ 节流 0 → 文案明确「不节流」',
		/不节流/.test(qqRateText(0)), '0');
	check('QQ 节流 60 → 1 秒一条且不出现小数',
		/每 1 秒/.test(qqRateText(60)), qqRateText(60));
	check('QQ 节流 7 → 间隔带单位（8.6 秒），不是裸数字',
		/每 8\.6 秒/.test(qqRateText(7)), qqRateText(7));
	check('QQ 节流 90 → 夹到 60，间隔文案仍是整 1 秒（不存在毫秒分支）',
		/约每 1 秒一条/.test(qqRateText(90)) && !/毫秒/.test(qqRateText(90)), qqRateText(90));
	check('QQ 节流提示带上平台频控量级（让用户知道为什么）',
		/群 30~60 条\/分钟、单聊 20 条\/分钟/.test(qqRateText(10)), '平台频控');
	check('QQ 节流 75 → 被夹到 60 显示',
		/最多 60 条\/分钟/.test(qqRateText(75)), '75');
}

/* ---------- 6. 页面读写接线 ---------- */
check('service.js 载入时读取两个新键',
	/get\('notify_signal_min_interval',\s*'60'\)/.test(serviceJs)
	&& /get\('qq_max_per_minute',\s*'10'\)/.test(serviceJs), 'get');
check('service.js 保存时写入两个新键',
	/set\('notify_signal_min_interval',/.test(serviceJs)
	&& /set\('qq_max_per_minute',/.test(serviceJs), 'set');
check('service.js 保存时夹取到各自上限（10080 / 60）',
	/Math\.min\(10080, rateMin\)/.test(serviceJs) && /Math\.min\(60, qqRate\)/.test(serviceJs), '夹取');
check('service.js 对 0 值不做 || 兜底（0 是合法的「不限频」）',
	!/rateMinInput\.value, 10\)\s*\|\|/.test(serviceJs)
	&& !/qqRateInput\.value, 10\)\s*\|\|/.test(serviceJs), '0 值');
check('service.js 频率控件随「信号变化通知」开关联动置灰',
	/var rateOn = notifyMaster\.input\.checked && notifySignal\.input\.checked/.test(serviceJs)
	&& /rateMinInput\.disabled = !rateOn/.test(serviceJs), '联动');
check('service.js 默认值与后端常量一致（页面不会显示一个后端不认的默认）',
	/Mt5700\.input\('number', '60', ''\)/.test(serviceJs)
	&& /Mt5700\.input\('number', '10', ''\)/.test(serviceJs), '60 / 10');
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
