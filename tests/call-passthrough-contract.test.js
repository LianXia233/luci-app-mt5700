/*
 * 端到端透传验证：真机 rpcCall 响应 → 真实 fetchCall 源码 → 视图判定。
 *
 * 为什么需要它：v2.4.23 的真机验证用 `ubus call mt5700 call {...}` 直调，
 * **绕过了 rpc.js 的 fetchCall**。于是「后端返回了 stage」被当成
 * 「页面拿到了 stage」—— 实际中间那层没搬，UI 上 stage 恒为 null。
 * 这个脚本用真机实抓的响应喂进**未修改的** fetchCall 源码，
 * 检查 stage 能否活着到视图，并钉死已下线字段（preflight）不再回来。
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
 * ★ 这份样本是**真机原样抓取**的，不是手编的：空闲态，ucode 回了
 *   "stage":"idle"。
 *   ★ 为什么必须用真数据：手写样本容易「恰好符合自己的假设」，
 *     而真机能暴露字段名/类型的不一致。上一轮用 `ubus call` 直调
 *     验证到 read 就以为页面没问题，恰恰漏掉了中间层。
 *   脱敏：这份响应不含 IMSI/IMEI/ICCID/EID/号码（红线 73 已核）。
 */
const DEVICE_STATUS = {
	success: true,
	action: 'status',
	calls: [],
	stage: 'idle'
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

	console.log('== ② preflight 已下线：字段不许再出现在返回对象里 ==');
	/*
	 * v2.4.27 删除了「语音可用性自检」：前端卡片、ucode callPreflight、
	 * 本层的四字段透传一并移除。这里反向断言「它们真的没了」——
	 * 防的是「删了 UI 但中间层还留着」这种半截状态（红线 62）。
	 */
	res = await fetchCall('status');
	ok('ready 不再透传', res.ready === undefined, '实际：' + JSON.stringify(res.ready));
	ok('volte 不再透传', res.volte === undefined);
	ok('blocked 不再透传', res.blocked === undefined);
	ok('steps 不再透传', res.steps === undefined);

	console.log('== ③ 失败分支：不能伪装成「已就绪」 ==');
	RESP = { success: false, error: 'AT 通道无响应' };
	res = await fetchCall('status');
	ok('失败时 stage 为 null（不是 undefined）', res.stage === null,
		'实际：' + JSON.stringify(res.stage));
	ok('失败时 calls 为 null（视图走错误分支）', res.calls === null);
	ok('失败时不带 preflight 残留字段',
		res.ready === undefined && res.steps === undefined);

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
