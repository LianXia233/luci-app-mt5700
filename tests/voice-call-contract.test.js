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
 * 本测试守七件事：
 *   ① ★ 注入面：号码与 DTMF 码只过白名单，AT 命令串**只在 ucode 拼**；
 *      前端视图里不许出现 ATD / AT+VTS 等命令字面量（那是「把任意字符串
 *      送进 AT 通道」的口子，分号能分隔多条命令）
 *   ② 五动作齐全：dial / answer / hangup / dtmf / status 各有去处，
 *      且命令拼装正确（ATD 必须带分号才是语音呼叫；ATA/ATH 无参数）
 *   ③ 「读不到」与「没有通话」分开：CLCC 无 +CLCC 行 → 空数组（空闲），
 *      RPC 失败 → success:false + error + calls:null（红线 23）
 *   ④ 接线齐全：ACL 两处、菜单、rpc 声明、AtWs.call 导出、视图订阅与退订
 *   ⑤ 状态机令牌（2026-10-16 从厂商「带电话功能beta」固件移植）：
 *      CLCC <state> → active/held/dialing/alerting/ringing/waiting 令牌，
 *      总态按优先级 active > held > waiting > ringing > alerting > dialing
 *   ⑥ 前置检查 preflight：四条**只读查询**（SIMSQ/CREG/CIREG/CLIP），
 *      核心项（SIM + CS 注册）决定 ready；★ 绝不照搬厂商的 Quectel 私有
 *      命令（AT+QCALLCFG / AT+QCFG，MT5700M 手册里没有 —— 红线 27）
 *   ⑦ 通话记录双向字段：direction 字符串与 dir 整数同义、unanswered→failed、
 *      读侧补齐 direction（不落盘迁移）
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

/* 按 '};' 抠出一个对象字面量（STAGE_TEXT 这类常量表） */
function grabObj(marker, src) {
	const i = src.indexOf(marker);
	if (i < 0) return '';
	const j = src.indexOf('};', i);
	return src.slice(i, j + 2);
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

/* ---------- ⑫ 状态机令牌（2026-10-16 从厂商 beta 固件移植） ---------- */

const stageFn = grab('callStageOf', ucSrc);
ok('callStageOf 存在', stageFn.length > 0);
ok('CLCC state 0..5 → active/held/dialing/alerting/ringing/waiting',
	["s == 0) { return 'active'", "s == 1) { return 'held'", "s == 2) { return 'dialing'",
	 "s == 3) { return 'alerting'", "s == 4) { return 'ringing'", "s == 5) { return 'waiting'"]
	.every(function (t) { return stageFn.includes(t); }),
	'令牌名一变，前端 STAGE_TEXT 就查不到 → 徽标退回「状态未知」');
ok('非对象入参回 unknown（不抛异常，轮询不能因一条脏数据整体崩）',
	stageFn.includes("type(c) != 'object'") && stageFn.includes("return 'unknown'"));
ok('用 type() 判型（不是 typeof，红线 14d）',
	stageFn.includes("type(c) != 'object'") && !stageFn.includes('typeof'));

const overallFn = grab('callOverallStage', ucSrc);
ok('callOverallStage 存在', overallFn.length > 0);
ok('空数组/非数组 → idle（这是「确实没有通话」，不是「读不到」）',
	overallFn.includes("type(calls) != 'array' || length(calls) == 0"));
ok('总态优先级序 active > held > waiting > ringing > alerting > dialing',
	overallFn.includes("['active', 'held', 'waiting', 'ringing', 'alerting', 'dialing']"),
	'序一变，多路呼叫时徽标会挑错（例如「来电振铃」盖住「已接通」）');

const statusFn2 = grab('callStatus', ucSrc);
ok('callStatus 给每路呼叫挂上 stage 令牌',
	statusFn2.includes('calls[i].stage = callStageOf(calls[i]);'));
ok('callStatus 回总态 stage', statusFn2.includes('stage: callOverallStage(calls)'));
/* ★ 这两条是死代码守卫：失败分支不显式回 calls:null 时，前端
   `res.calls === null` 永远为假 ⇒ 报错分支不可达 ⇒ 通道故障看起来像空闲
   （红线 23：把「读不出来」伪装成「没有通话」）。 */
ok('callStatus 无响应分支显式回 calls: null',
	statusFn2.includes("calls: null, error: 'AT 通道无响应' }"));
ok('callStatus 查询失败分支显式回 calls: null',
	statusFn2.includes("calls: null, error: (r.error || '查询失败') }"));

/* ---------- ⑬ preflight：厂商 voicePreparation 的安全移植 ---------- */

const pfFn = grab('callPreflight', ucSrc);
ok('callPreflight 存在', pfFn.length > 0);
ok('四条查询齐全（SIMSQ / CREG / CIREG / CLIP）',
	["'AT^SIMSQ?'", "'AT+CREG?'", "'AT+CIREG?'", "'AT+CLIP?'"].every(function (t) {
		return pfFn.includes(t);
	}));
/* 每步的命令串出现两次（rpcCall 调用处 + 步骤对象的 cmd 字段）→ 先去重 */
const pfCmdsRaw = pfFn.match(/cmd: 'AT[^']*'/g) || [];
const pfCmds = pfCmdsRaw.filter(function (c, i) { return pfCmdsRaw.indexOf(c) === i; });
ok('preflight 恰好 4 条唯一 AT 命令（不夹带隐藏调用）', pfCmds.length === 4,
	'去重后实际：' + JSON.stringify(pfCmds));
ok('preflight 就是那四条只读查询（多一条少一条都判红）',
	JSON.stringify(pfCmds.slice().sort()) ===
	JSON.stringify(["cmd: 'AT+CIREG?'", "cmd: 'AT+CLIP?'", "cmd: 'AT+CREG?'", "cmd: 'AT^SIMSQ?'"]));
ok('preflight 每条命令都以 ? 结尾（只读查询）',
	pfCmds.length > 0 && pfCmds.every(function (c) { return /\?'$/.test(c); }));
ok('preflight 命令不含 = 号（无写参数）',
	pfCmds.every(function (c) { return c.indexOf('=') < 0; }));
ok('preflight 命令不含 ; 号（命令分隔符＝注入面）',
	pfCmds.every(function (c) { return c.indexOf(';') < 0; }));
ok('★ preflight 函数体里没有 Quectel 私有命令（红线 27）',
	!/AT\+Q[A-Za-z]/.test(pfFn) && !pfFn.includes('QCALLCFG'));
/* ★★ 厂商的 voicePreparation 写的是 Quectel 的 AT+QCALLCFG="voice_disable",0
   与 AT+QCFG="ims" —— MT5700M-CN 手册里没有这两条，照搬就是给模组发未定义命令。
   本仓提到它们**只允许在注释里**（记录为什么没搬），一旦出现在代码行里就是回归。 */
(function () {
	const bad = ucSrc.split('\n').filter(function (ln) {
		const t = ln.trim();
		const inComment = t.indexOf('*') === 0 || t.indexOf('//') === 0 || t.indexOf('#') === 0;
		return !inComment && (ln.indexOf('QCALLCFG') >= 0 || ln.indexOf('QCFG') >= 0);
	});
	ok('★ Quectel 私有命令只出现在注释里（不得成为真实下发命令）',
		bad.length === 0, bad.join('\n'));
})();
ok('core 标在 SIM / CS / IMS 三步，CLIP 为提示项',
	(pfFn.match(/core: true/g) || []).length === 3 &&
	(pfFn.match(/core: false/g) || []).length === 1);
/* ★ 三态记号的判据是 blocking（"未过且确实挡住了"），不是 core（"是不是判据项"）：
   本机能出现「CS 未注册但 IMS 已注册」，此时 CS 未过却不阻断拨号。 */
ok('每步都带 blocking 字段（前端三态记号的判据）',
	(pfFn.match(/blocking: /g) || []).length === 4);
ok('blocked 是原因短语，不再直接回步骤标题',
	!pfFn.includes('blocked.title') && pfFn.includes("blocked = '"));
ok('SIM 就绪判据 = sim_status 11 或 12（手册 6.6.3：两者都是「已初始化」）',
	pfFn.includes('simOk = (simStatus == 11 || simStatus == 12)'),
	'12 说的是「短信和电话本可接入」，不是「才能打电话」——用 12 当语音门槛会把 11 误判成不可用');
ok('IMS 注册判据 = reg_info 1', pfFn.includes('regInfo == 1'));
ok('语音承载判据 = CS 或 IMS 任一可用（netOk）',
	pfFn.includes('netOk = (csOk || imsOk)'));
ok('ready = SIM 就绪 且 承载域可用（不是硬编码/写死结论）',
	pfFn.includes('ready = (simOk && netOk)'),
	'★ 手册 4.6 的 ^CCALLSTATE <voice_domain> 含「1：IMS 域语音电话」⇒ 语音呼叫不要求 CS 注册');
ok('★ 允许「CS 未注册但 IMS 已注册」不阻断（真机实测的假阴性）',
	pfFn.includes('CS 域未注册，但 IMS 已注册') &&
	pfFn.includes('IMS 未注册，但 CS 域已注册'),
	'只按 CS 注册判，本机（CREG=0,0 + CIREG=1,1）会被判成「不能打电话」');
ok('★ 判据的真机依据写在注释里（红线 42/49：回真机量一次 + 带对照组）',
	ucSrc.includes('^CCALLSTATE') && ucSrc.includes('+CREG: 0,0'));
ok('CLIP 读失败区分「命令被拒」与「读到了但没此项」（红线 23）',
	pfFn.includes("clipErr != ''") && pfFn.includes('本模组不支持查询 CLIP'));
ok('CS 域注册判据 = stat 1 或 5', pfFn.includes('csOk = (stat == 1 || stat == 5)'));
ok('来电号码显示判据 = m 1', pfFn.includes('clipOk = (clip == 1)'));
ok('返回体含 ready / volte / cs / blocked / steps',
	pfFn.includes('ready: ready') && pfFn.includes('volte: imsOk') &&
	pfFn.includes('cs: csOk') && pfFn.includes('blocked: blocked') &&
	pfFn.includes('steps: steps'));
ok('preflight 无响应时不伪装成「都通过」（回 success:false）',
	pfFn.includes("success: false, action: 'preflight'") &&
	pfFn.includes("error: 'AT 通道无响应'"));
ok('后三条各自独立：单条失败只让该项标红，不整体报错',
	pfFn.includes('(r2 != null && r2.success) ?') &&
	pfFn.includes('(r3 != null && r3.success) ?') &&
	pfFn.includes('(r4 != null && r4.success) ?'));
ok('解析走 callNumsAfter（不是硬编码下标，字段数变了也不崩）',
	pfFn.includes("callNumsAfter(r1.data, '^SIMSQ:')"));

const numsFn = grab('callNumsAfter', ucSrc);
ok('callNumsAfter 存在', numsFn.length > 0);
ok('callNumsAfter 只取第一行（遇换行停止，不被后续行污染）',
	numsFn.includes("c == '\\n'") && numsFn.includes("c == '\\r'"));
ok('callNumsAfter 空文本/空前缀回空数组（不抛异常）',
	numsFn.includes('if (text == null || prefix == null)'));

ok("call 方法派发 preflight", ucSrc.includes("if (action == 'preflight') {"));
ok('未知 action 文案把 preflight 列进支持项',
	/未知 action（[^）]*preflight[^）]*）/.test(ucSrc));

/* ---------- ⑭ 通话记录：direction 双向字段 ---------- */

ok('callLogEntry 接受 direction 字符串别名（厂商记录口径）',
	logEntryFn.includes("m.direction == 'incoming'") &&
	logEntryFn.includes("m.direction == 'outgoing'"));
ok('callLogEntry 接受 unanswered → 归一成 failed',
	logEntryFn.includes("result == 'unanswered'") && logEntryFn.includes("result = 'failed'"));
ok('callLogEntry 接受 answered==true 布尔（厂商记录形态）',
	logEntryFn.includes('m.answered == true'));
ok('callLogEntry 输出 direction 字符串（与 dir 整数同义，双写）',
	logEntryFn.includes("direction: (dir == 1) ? 'incoming' : 'outgoing'"));
ok("callLogEntry 的 result 白名单含 failed", logEntryFn.includes("result != 'failed'"));

const logReadFn = grab('callLogRead', ucSrc);
ok('callLogRead 读侧补齐 direction（老记录只有 dir）',
	logReadFn.includes('list[i].direction == null') && logReadFn.includes("'incoming'"));
ok('callLogRead 不回写文件（不落盘迁移 —— 迁移中途掉电＝记录全丢）',
	!logReadFn.includes('fs.writefile') && !logReadFn.includes('fs.rename') &&
	!logReadFn.includes('fs.open'));

/* ---------- ⑮ 视图：状态令牌 / preflight 接线 / direction ---------- */

const stageTbl = grabObj('var STAGE_TEXT = {', viewSrc);
ok('视图 STAGE_TEXT 令牌表存在', stageTbl.length > 0);
ok('STAGE_TEXT 覆盖后端会给出的全部令牌',
	['unknown', 'idle', 'requesting', 'dialing', 'alerting', 'ringing',
	 'waiting', 'active', 'held', 'ended'].every(function (t) {
		return stageTbl.includes(t + ':');
	}), '缺项 → 徽标/指标退回「状态未知」，用户看到的是一片未知');
ok('视图 renderStatus 用 st.stage 决定徽标（厂商粒度，不是只有 0-5 粗判）',
	viewSrc.includes("if (st.stage === 'dialing')") &&
	viewSrc.includes("if (st.stage === 'ringing')") &&
	viewSrc.includes("if (st.stage === 'held')"));
ok('视图记下总态 st.stage', viewSrc.includes('st.stage = res.stage || null;'));
/* ★ 判据必须是「不是数组」：写成 `=== null` 时，后端若不回 calls 字段，
   undefined === null 为假 ⇒ 报错分支是死代码（本次修掉的真实 bug）。 */
ok('视图判据用 Array.isArray，不是 === null（否则报错分支是死代码）',
	viewSrc.includes('if (!Array.isArray(res.calls)) {') &&
	!viewSrc.includes('if (res.calls === null)'));
ok('视图记录写出 direction 字段',
	viewSrc.includes("direction: (t.dir === 1) ? 'incoming' : 'outgoing',"));
ok('视图方向优先读 direction 字符串，退回 dir 整数（老记录兼容）',
	viewSrc.includes("r.direction === 'incoming'") && viewSrc.includes('(r.dir === 1)'));

ok('视图调 preflight 动作', viewSrc.includes("AtWs.call('preflight')"));
(function () {
	const i = viewSrc.indexOf('Mt5700.interval(2000');
	const ivBlock = (i < 0) ? '' : viewSrc.slice(i, i + 400);
	ok('2 秒轮询里只有 status 查询，不含 preflight',
		ivBlock.includes('refreshStatus()') && ivBlock.indexOf('preflight') < 0,
		'preflight 一次发 4 条 AT，放进轮询会占满串口');
})();
ok('前置检查期间轮询让路（pfBusy 守卫）',
	(viewSrc.match(/if \(st\.pfBusy\) \{ return; \}/g) || []).length >= 2,
	'runPreflight 入口复入保护 + 轮询让路，两处都要有');
ok('preflight 在途去重：pfBusy 置位/复位齐全',
	viewSrc.includes('st.pfBusy = true;') && viewSrc.includes('st.pfBusy = false;'));
ok('preflight 失败不伪装成「检查完都好」（红线 23）',
	viewSrc.includes("st.pf = res || { success: false, error: '无响应' }") &&
	viewSrc.includes("st.pf = { success: false, error:"));
ok('三态记号 ✓/✗/○ 区分「通不过」与「通了但体验差」',
	viewSrc.includes("s.ok ? '✓' : (s.blocking ? '✗' : '○')"),
	'判据必须是 blocking（挡住拨号），不是 core（是不是判据项）');
(function () {
	const i = viewSrc.indexOf('var pfCard = Mt5700.card(');
	ok('可用性自检卡片挂在页面上（且按钮触发 runPreflight）',
		i >= 0 && viewSrc.indexOf("Mt5700.ghostButton('检查能否拨号', function () { runPreflight(); })") >= 0);
})();

/* ---------- 汇总 ---------- */

console.log('');
if (fails.length) {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.log(f); });
	process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
