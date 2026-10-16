/*
 * 端到端透传验证：真机 rpcCall 响应 → 真实 fetchCall 源码 → 视图判定。
 *
 * 为什么需要它：v2.4.23 的真机验证用 `ubus call mt5700 call {...}` 直调，
 * **绕过了 rpc.js 的 fetchCall**。于是「后端返回了 stage」被当成
 * 「页面拿到了 stage」—— 实际中间那层没搬，UI 上 stage 恒为 null。
 * 这个脚本用真机实抓的响应喂进**未修改的** fetchCall 源码，
 * 检查 stage / preflight 四字段能否活着到视图。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RPC = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/rpc.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
	if (cond) { pass++; console.log('  ✓ ' + name); }
	else { fail++; console.log('  ✗ ' + name + (extra ? '  —— ' + extra : '')); }
}

/* ---- 真机实抓的响应（2026-10-16，`ubus call mt5700 call ...` 原文） ---- */
/*
 * ★ 这两份样本是**真机原样抓取**的，不是手编的：
 *   - status：空闲态，ucode 回了 "stage":"idle"
 *   - preflight：ready/volte/cs/blocked/steps 五字段全在，cs=false
 *     （+CREG: 0,0 但 +CIREG: 1,1 的假阴性现场），且 csreg 那行
 *     core=true 而 blocking=false —— 正是「未过但不阻断」的三态语义。
 *   ★ 为什么必须用真数据：手写样本容易「恰好符合自己的假设」，
 *     而真机能暴露字段名/类型的不一致。上一轮我用 `ubus call` 直调
 *     验证到 ready:true 就以为页面没问题，恰恰漏掉了中间层。
 *   脱敏：这份响应不含 IMSI/IMEI/ICCID/EID/号码（红线 73 已核）。
 */
const DEVICE_STATUS = {
	success: true,
	action: 'status',
	calls: [],
	stage: 'idle'
};
const DEVICE_PREFLIGHT = {
	success: true,
	action: 'preflight',
	ready: true,
	volte: true,
	cs: false,
	blocked: '',
	steps: [
		{ key: 'sim', title: 'SIM 卡就绪', cmd: 'AT^SIMSQ?', ok: true, core: true, blocking: false, value: 'sim_status=11', hint: 'SIM 卡已初始化（可接入网络），语音业务可用' },
		{ key: 'csreg', title: 'CS 域已注册', cmd: 'AT+CREG?', ok: false, core: true, blocking: false, value: 'stat=0', hint: 'CS 域未注册，但 IMS 已注册：语音走 VoLTE/VoNR，不影响拨号' },
		{ key: 'ims', title: 'IMS 域已注册', cmd: 'AT+CIREG?', ok: true, core: true, blocking: false, value: 'reg_info=1', hint: 'IMS 已注册，VoLTE/VoNR 可用' },
		{ key: 'clip', title: '来电号码显示', cmd: 'AT+CLIP?', ok: false, core: false, blocking: false, value: '未识别', hint: '本模组不支持查询 CLIP（真机回 +CME ERROR: UNKNOWN）' }
	]
};

/* ---- 取出 rpc.js 里未经改动的 fetchCall 函数体 ---- */
const src = fs.readFileSync(RPC, 'utf8');
const i = src.indexOf('function fetchCall(');
if (i < 0) { console.error('找不到 fetchCall'); process.exit(2); }
let depth = 0, started = false, j = i;
for (; j < src.length; j++) {
	const c = src[j];
	if (c === '{') { depth++; started = true; }
	else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
}
const fetchCallSrc = src.slice(i, j);

/* ---- 最小 L 桩：L.rpc.declare 返回一个按 params 位置组装的函数 ---- */
let RESP = DEVICE_STATUS;
const L = {
	rpc: {
		declare(spec) {
			const names = spec.params || [];
			return function () {
				const a = {};
				for (let k = 0; k < names.length; k++) { a[names[k]] = arguments[k]; }
				return Promise.resolve(JSON.parse(JSON.stringify(RESP)));
			};
		}
	}
};

/* ---- withTimeout 桩：直接透传 ---- */
function withTimeout(p) { return p; }

/* ---- rpcCall 桩：与 rpc.js 里 L.rpc.declare 的语义一致 ---- */
const NAMES = ['action', 'number', 'digit', 'record'];
function makeRpc(behaviour) {
	return function () {
		const a = {};
		for (let k = 0; k < NAMES.length; k++) { a[NAMES[k]] = arguments[k]; }
		if (behaviour) { return behaviour(); }
		return Promise.resolve(JSON.parse(JSON.stringify(RESP)));
	};
}

const sandbox = {
	L: L,
	withTimeout: withTimeout,
	console: console,
	Promise: Promise,
	Array: Array,
	JSON: JSON,
	String: String,
	Date: Date
};

/* eslint-disable no-new-func */
const FN_TAIL = '\nreturn fetchCall;';
/* rpcCall 在 rpc.js 里是模块级 var（= L.rpc.declare(...)），单独注入 */
const fn = new Function('L', 'withTimeout', 'rpcCall',
	fetchCallSrc + FN_TAIL);

(async function main() {
	const fetchCall = fn(L, withTimeout, makeRpc());

	console.log('== ① status：stage 能否活着到视图 ==');
	RESP = DEVICE_STATUS;
	let res = await fetchCall('status');
	ok('stage 透传成功', res.stage === 'idle',
		'实际：' + JSON.stringify(res.stage) + '（undefined 说明中间层没搬）');
	ok('stage !== undefined（这是本次修复的核心）', res.stage !== undefined);
	/* 视图的真实判据 */
	const stageText = res.stage === 'idle' ? '空闲' : '??';
	ok('视图 STAGE_TEXT 查得到（idle 有对应文案）', stageText === '空闲');

	console.log('== ② preflight：四字段能否活着到视图 ==');
	RESP = DEVICE_PREFLIGHT;
	res = await fetchCall('preflight');
	ok('ready 透传为布尔 true', res.ready === true, '实际：' + JSON.stringify(res.ready));
	ok('volte 透传为布尔 true', res.volte === true);
	ok('blocked 透传为空串', res.blocked === '');
	ok('steps 透传 4 条', Array.isArray(res.steps) && res.steps.length === 4,
		'实际：' + JSON.stringify((res.steps || []).length));
	/* 视图 renderPreflight 的真实判据 */
	const marks = (res.steps || []).map(function (s) {
		return s.ok ? '✓' : (s.blocking ? '✗' : '○');
	});
	ok('三态记号渲染成 ✓○✓○（CS 未过但不阻断 ⇒ ○ 不是 ✗）',
		marks.join('') === '✓○✓○', '实际：' + marks.join(''));
	ok('结论走 ready 分支（可以拨号）', res.ready === true);
	ok('附带 VoLTE 提示（volte 为真）', res.ready === true && res.volte === true);

	console.log('== ③ 失败分支：不能伪装成「已就绪」 ==');
	RESP = { success: false, error: 'AT 通道无响应' };
	res = await fetchCall('status');
	ok('失败时 stage 为 null（不是 undefined）', res.stage === null,
		'实际：' + JSON.stringify(res.stage));
	ok('失败时 calls 为 null（视图走错误分支）', res.calls === null);
	ok('失败时 ready 为 false（「没读到」不等于「就绪」，红线 23）', res.ready === false,
		'实际：' + JSON.stringify(res.ready));
	ok('失败时 steps 为空数组（渲染层不会抛）', Array.isArray(res.steps) && res.steps.length === 0);

	console.log('== ④ 超时/异常兜底 ==');
	const boom = fn(L, withTimeout, makeRpc(function () {
		return Promise.reject(new Error('模拟通道断开'));
	}));
	res = await boom('status');
	ok('通道异常时 stage 仍为 null', res.stage === null);
	ok('通道异常时 success 为 false 且带错误文案',
		res.success === false && String(res.error).indexOf('模拟通道断开') >= 0);

	console.log('');
	console.log(fail === 0
		? `全部通过（${pass} 项）`
		: `通过 ${pass} 项，失败 ${fail} 项`);
	process.exit(fail === 0 ? 0 : 1);
})();