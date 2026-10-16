#!/usr/bin/env node
/*
 * 语音通话契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-10-16：CS 域语音呼叫控制（拨号 / 接听 / 挂断 / DTMF / 状态）。
 *
 * 这条链跨六个文件，任何一处脱节都会让功能整体失效或出现注入面：
 *   ucode(call 方法+号码白名单+CLCC 解析) → ACL(read/write 两处) →
 *   菜单(voice-call) → rpc.js(声明+包装+导出) → voice_call.js(视图)
 *
 * 本测试守四件事：
 *   ① ★ 注入面：号码与 DTMF 码只过白名单，AT 命令串**只在 ucode 拼**；
 *      前端视图里不许出现 ATD / AT+VTS 等命令字面量（那是「把任意字符串
 *      送进 AT 通道」的口子，分号能分隔多条命令）
 *   ② 五动作齐全：dial / answer / hangup / dtmf / status 各有去处，
 *      且命令拼装正确（ATD 必须带分号才是语音呼叫；ATA/ATH 无参数）
 *   ③ 「读不到」与「没有通话」分开：CLCC 无 +CLCC 行 → 空数组（空闲），
 *      RPC 失败 → success:false + error（红线 23）
 *   ④ 接线齐全：ACL 两处、菜单、rpc 声明、AtWs.call 导出、视图订阅与退订
 *
 * 运行：node tests/voice-call-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UCODE = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const ACL = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json');
const MENU = path.join(ROOT, 'root', 'usr', 'share', 'luci', 'menu.d', 'luci-app-mt5700.json');
const RPC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const VIEW = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'voice_call.js');

const ucSrc = fs.readFileSync(UCODE, 'utf8');
const aclSrc = fs.readFileSync(ACL, 'utf8');
const menuSrc = fs.readFileSync(MENU, 'utf8');
const rpcSrc = fs.readFileSync(RPC, 'utf8');
const viewSrc = fs.readFileSync(VIEW, 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return true; }
	fails.push('  ✗ ' + name + (hint ? '\n      ' + hint : ''));
	return false;
}

/* 按括号配对抠出整个函数（改名请同步本测试） */
function grab(name, src) {
	const i = src.indexOf('function ' + name + '(');
	if (i < 0) throw new Error('源码里找不到函数 ' + name + '（改名请同步本测试）');
	let depth = 0, started = false;
	for (let j = i; j < src.length; j++) {
		const c = src[j];
		if (c === '{') { depth++; started = true; }
		else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
	}
	throw new Error('函数体括号不配对：' + name);
}

console.log('== 语音通话契约 ==');

/* ---------- ① ucode：call 方法与命令拼装 ---------- */

ok('ucode 可读', ucSrc.length > 0);
ok('call 方法已注册', /\n\t\tcall: \{/.test(ucSrc));
ok('call 的 args 声明含 action/number/digit/record',
	/args: \{ action: '', number: '', digit: '', record: '' \}/.test(ucSrc));

/* 命令拼装：逐条核对（这些字符串写错，功能当场失效） */
ok("dial 拼 ATD<number>;（分号＝语音呼叫）", ucSrc.includes("'ATD' + num + ';'"));
ok("answer 拼 ATA", ucSrc.includes("callDo('answer', 'ATA')"));
ok("hangup 拼 ATH", ucSrc.includes("callDo('hangup', 'ATH')"));
ok("dtmf 拼 AT+VTS=<digit>", ucSrc.includes("'AT+VTS=' + d"));
ok("status 用 AT+CLCC", ucSrc.includes("'AT+CLCC'"));
ok('呼叫控制 action 分支齐全（dial/answer/hangup/dtmf/status）',
	["action == 'dial'", "action == 'answer'", "action == 'hangup'",
	 "action == 'dtmf'", "action == 'status'"].every(function (s) {
		return ucSrc.includes(s);
	}));
ok('管理台 action 分支齐全（mute/info/loglist/logadd/logclear）',
	["action == 'mute'", "action == 'info'", "action == 'loglist'",
	 "action == 'logadd'", "action == 'logclear'"].every(function (s) {
		return ucSrc.includes(s);
	}));

/* ---------- ② 号码白名单（注入面） ---------- */

const numFn = grab('callNumberOk', ucSrc);
ok('callNumberOk 存在', numFn.length > 0);
ok('白名单字符集为 0-9 * #', numFn.includes("'0123456789*#'"));
ok('+ 只允许第 0 位', /i == 0 && c == '\+'/.test(numFn));
ok('长度上限 24（挡异常输入）', numFn.includes('n > 24'));
ok('type() 判型（不是 typeof，红线 14d）', numFn.includes("type(s) != 'string'"));
ok('分号不在白名单里（AT 命令分隔符）', !numFn.includes("';'"));

const dtmfFn = grab('callDtmfOk', ucSrc);
ok('callDtmfOk 只收单字符', dtmfFn.includes('length(s) != 1'));
ok('DTMF 白名单 0-9 A-D * #', dtmfFn.includes("'0123456789ABCD*#'"));

/* ---------- ③ CLCC 解析 ---------- */

const parseFn = grab('callParseClcc', ucSrc);
ok('callParseClcc 存在', parseFn.length > 0);
ok('CLCC 字段数与手册 5.11 一致（id/dir/state/mode/mpty/number/type）',
	parseFn.includes('id: int(f[0])') && parseFn.includes('dir: int(f[1])') &&
	parseFn.includes('state: int(f[2])') && parseFn.includes('number: f[5]'));
ok('引号字段整体取出（号码形如 "1008611"）', ucSrc.includes('function clccFields'));
ok('无 +CLCC 行 → 空数组（这是「确实没有」，不是「读不到」）',
	parseFn.includes('let calls = [];') && parseFn.includes('if (data == null)'));
ok('status 的 RPC 失败不伪装成空数组',
	/function callStatus[\s\S]*?if \(!r\.success\) \{[\s\S]*?return \{ success: false/.test(ucSrc));

/* ---------- ④ ACL：read 与 write 两处都要有 call ---------- */

const acl = JSON.parse(aclSrc);
ok('ACL read 段含 mt5700.call',
	acl['luci-app-mt5700'].read.ubus.mt5700.indexOf('call') >= 0);
ok('ACL write 段含 mt5700.call',
	acl['luci-app-mt5700'].write.ubus.mt5700.indexOf('call') >= 0,
	'少一处，浏览器就会被 rpcd 以 code=6（ permission denied）拒掉');

/* ---------- ⑤ 菜单 ---------- */

const menu = JSON.parse(menuSrc);
ok('菜单有「语音通话」页', !!menu['admin/modem/5g/voice-call']);
ok('菜单指向 voice_call 视图',
	menu['admin/modem/5g/voice-call'] &&
	menu['admin/modem/5g/voice-call'].action.path === 'at-webserver/voice_call');

/* ---------- ⑥ rpc.js 接线 ---------- */

ok('rpc.js 声明 mt5700.call',
	/var rpcCall = L\.rpc\.declare\(\{\s*object: 'mt5700',\s*method: 'call',/.test(rpcSrc));
ok('rpcCall 参数表 action/number/digit/record',
	/method: 'call',\s*params: \['action', 'number', 'digit', 'record'\]/.test(rpcSrc));
ok('fetchCall 包装存在', rpcSrc.includes('function fetchCall('));
ok('fetchCall 区分「没有方法」与「调用失败」',
	rpcSrc.includes("'rpcd 没有 mt5700.call 方法（后端未升级）'"));
ok('AtWs.call 已导出', /\tcall: fetchCall,/.test(rpcSrc));

/* ---------- ⑦ 视图：只用 AtWs.call，不碰 AT 命令字面量 ---------- */

ok('视图可读', viewSrc.length > 0);
ok('视图经 AtWs.call 调后端', viewSrc.includes("AtWs.call('dial'") &&
	viewSrc.includes("AtWs.call('answer'") &&
	viewSrc.includes("AtWs.call('hangup'") &&
	viewSrc.includes("AtWs.call('dtmf'") &&
	viewSrc.includes("AtWs.call('status'"));
/* ★ 注入面守卫：视图里出现 AT 命令字面量 ＝ 有人绕过后端白名单直接发 AT */
ok('视图不含 ATD 命令字面量', !/["']ATD/.test(viewSrc));
ok('视图不含 AT+VTS 命令字面量', !/["']AT\+VTS/.test(viewSrc));
ok('视图不含 AT+CLCC 命令字面量', !/["']AT\+CLCC/.test(viewSrc));
ok('视图不含裸 sendCommand 通道', !/sendCommand\(/.test(viewSrc));
/* 前端白名单与后端同口径 */
ok('视图有号码白名单正则', viewSrc.includes('/^\\+?\\[0-9\\*#\\]+$/') || viewSrc.includes("NUMBER_RE"));
ok('CLCC 轮询存在（2s）', /interval\(2000/.test(viewSrc));
ok('订阅来电推送并在 dispose 时退订',
	viewSrc.includes('AtWs.client.subscribe(onPush)') &&
	viewSrc.includes('AtWs.client.unsubscribe(onPush)'));
ok('busy 时不叠加轮询（AT 通道独占串行）',
	/if \(st\.busy\) \{ return; \}/.test(viewSrc));

/* ---------- ⑧ 静音 / 线路信息（ucode） ---------- */

ok("mute 拼 AT+CMUT=0/1，digit 只收 '0'/'1'",
	ucSrc.includes("'AT+CMUT=' + v") && ucSrc.includes("if (v != '0' && v != '1')"));

const infoFn = grab('callLineInfo', ucSrc);
ok('callLineInfo 取 CMUT? 与 CLVL?',
	infoFn.includes("'AT+CMUT?'") && infoFn.includes("'AT+CLVL?'"));
/* ★★★ 真机踩过的坑（2026-10-16）：rpcCall() 只认 **Rust(127.0.0.1:8765)** 的
   方法名，而 at_batch 是本文件在 rpcd 层注册的 ubus 方法 —— 在 ucode 内部
   写 rpcCall('at_batch') 会被 Rust 直接回「未知方法: at_batch」，
   CMUT/CLVL 一个都取不到。这条断言就是拦它。 */
ok("callLineInfo 不用 rpcCall('at_batch')（Rust 不认这个 rpcd 层方法）",
	!infoFn.includes("rpcCall('at_batch'"));
ok('CLVL 失败只降级不整体报错（volume 留 null）',
	infoFn.includes('out.volume = callNumAfter'));
ok('callNumAfter 区分「没这一项」与「值是 0」（返回 null）',
	grab('callNumAfter', ucSrc).includes("(digits == '') ? null : int(digits)"));

/* ---------- ⑨ 通话记录：字段白名单 + 上限 + 原子落盘 ---------- */

ok('记录落在 /etc/mt5700/call-log.json（与短信记录同目录）',
	ucSrc.includes("const CALL_LOG_FILE = CALL_LOG_DIR + '/call-log.json'"));
ok('记录条数上限 100', ucSrc.includes('const CALL_LOG_MAX = 100'));

const logEntryFn = grab('callLogEntry', ucSrc);
ok('记录 number 必须过 callNumberOk（挡「往设备文件写任意字符串」）',
	logEntryFn.includes('callNumberOk(m.number)'));
ok('记录 result 是白名单枚举（不是自由文本）',
	logEntryFn.includes("result != 'answered'") && logEntryFn.includes("result != 'missed'") &&
	logEntryFn.includes("result != 'rejected'") && logEntryFn.includes("result != 'canceled'"));
ok('记录 duration 钳到 [0, DUR_MAX]', logEntryFn.includes('dur > CALL_LOG_DUR_MAX'));
ok('记录落盘走「写 tmp 再 rename」（原子，断不留半个 JSON）',
	grab('callLogWrite', ucSrc).includes('fs.rename(tmp, CALL_LOG_FILE)'));
ok('logadd 走 JSON 字符串（与 smslog 的 entry 同一约定）',
	ucSrc.includes("let raw = getStr(a, 'record')") && ucSrc.includes('jsonParse(raw)'));
ok('logadd 解析失败明确报错，不当成空记录',
	ucSrc.includes("error: 'record 不是合法 JSON'"));

/* ---------- ⑩ 视图扩展：铃声 / 拒接 / 记录 / 能力提示 ---------- */

ok('视图调用 mute/info/loglist/logadd/logclear',
	["AtWs.call('mute'", "AtWs.call('info'", "AtWs.call('loglist'",
	 "AtWs.call('logadd'", "AtWs.call('logclear'"].every(function (s) {
		return viewSrc.includes(s);
	}));
ok('记录以 JSON.stringify 传出（record 是字符串参数）',
	viewSrc.includes('JSON.stringify(rec)'));
ok('来电时挂断按钮改文案为「拒接」', viewSrc.includes("'拒接'"));
ok('来电铃声用 Web Audio 生成（本页唯一能让手机出声的部分）',
	viewSrc.includes('webkitAudioContext') && viewSrc.includes('createOscillator'));
ok('铃声在离开页面时停掉', /_onDispose\(function[\s\S]*?ringStop\(\)/.test(viewSrc));
ok('页面明示「本机无音频硬件」', viewSrc.includes('本机无音频硬件'));
ok('静音未读到时显示「—」而不是当作 0（红线 23）',
	/if \(st\.mute == null\)/.test(viewSrc));
ok('通话结束落记录（回到 idle 触发 saveRecord）',
	viewSrc.includes('saveRecord(t)'));

/* ---------- ⑪ rpc.js：record 参数与结果透传 ---------- */

ok('rpcCall 参数表含 record',
	/params: \['action', 'number', 'digit', 'record'\]/.test(rpcSrc));
ok('fetchCall 透传 records / mute / volume',
	rpcSrc.includes('records: Array.isArray(resp.records)') &&
	rpcSrc.includes('mute: (resp.mute == null)'));

/* ---------- 汇总 ---------- */

console.log('');
if (fails.length) {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.log(f); });
	process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
