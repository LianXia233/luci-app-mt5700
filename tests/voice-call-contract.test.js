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
 *   ⑥ （v2.4.27 已删除）原「可用性自检 preflight」：四步只读查询 + 结论灯。
 *      用户判定为无用功能（能不能拨早已知道，卡片只是噪音）→ 前端卡片、
 *      ucode callPreflight、rpc 四字段透传一并移除；末尾一段反向断言守着
 *      「别再长回来」。★ 厂商 Quectel 私有命令的禁令（红线 27）保留。
 *   ⑦ 通话记录双向字段：direction 字符串与 dir 整数同义、unanswered→failed、
 *      读侧补齐 direction（不落盘迁移）
 *   ⑧ ★★ 端到端透传（2026-10-16 真实故障）：ucode 真机确实回 "stage":"idle"，
 *      视图也确实读 res.stage，但中间的 rpc.js#fetchCall 没搬这个字段 ⇒
 *      res.stage 恒 undefined ⇒ 厂商粒度状态机在 UI 上完全不生效。
 *      「后端返回正确」不等于「页面拿到」—— 每层都要验，且断言必须把
 *      相邻两层的字段名钉在一起。上一轮真机验证用 `ubus call` 直调，
 *      **绕过**了这一层，所以没能暴露。
 *   ⑨ 按钮禁用纪律（厂商 usable 语义）：禁用判据只有 applyGates 一处，
 *      且把「通道故障」算进去；读失败不清 stage/calls（别把故障渲染成空闲）
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
ok('菜单有「语音通话」页', !!menu['admin/modem/5g/comm/voice']);
ok('菜单指向 voice_call 视图',
	menu['admin/modem/5g/comm/voice'] &&
	menu['admin/modem/5g/comm/voice'].action.path === 'at-webserver/voice_call');

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
/*
 * ★ 2026-10-24：兜底轮询改为**自适应** —— 通话中 2s、空闲 5s。
 *   依据：状态变化的主通道是 URC（^CCALLSTATE/^CEND → urcKick），这条只是
 *   「URC 丢了 / 老后端没转发」的兜底。空闲时没有计时在跑，5s 延迟无感，
 *   而 2s 等于每页 30 条/分钟白占独占串口（串口只有一条，rpcd 还是单线程）。
 *   通话中保持 2s：接通/挂断回显不能迟滞。
 */
ok('CLCC 兜底轮询存在，且空闲 5s / 通话中 2s（自适应）',
	/inCall\(\) \? 2000 : 5000/.test(viewSrc),
	'仍是固定 2s：URC 才是主通道，空闲时不必这么密');
ok('订阅来电推送并在 dispose 时退订',
	viewSrc.includes('AtWs.client.subscribe(onPush)') &&
	viewSrc.includes('AtWs.client.unsubscribe(onPush)'));
ok('busy 时不叠加轮询（AT 通道独占串行）',
	/if \(!st\.busy\) refreshStatus\(\)/.test(viewSrc),
	'busy 期间仍发 CLCC');

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
/*
 * 断点描述换了口径（2026-10-22 实测定版）：旧的「板上也没有 codec」来自
 * 10-16 的推断，现在有更硬的证据 —— USB 双配置里根本没有 Audio Class 接口。
 * 断言盯的是「页面必须说清断点在哪」，不是某一句原文，所以跟着事实改锚点。
 */
ok('页面明示「通话内容听不到」及断点（不让用户把没声音当成故障）',
	viewSrc.includes('通话内容听不到') && viewSrc.includes('USB Audio Class'));
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

/* ---------- ⑪b rpc.js：端到端透传（真实踩过的坑，不是假想） ---------- */

/*
 * ★★★ 这组断言来自一次真实故障：v2.4.23 把厂商粒度状态机（stage）与前置
 *   自检（ready/volte/blocked/steps）都实现了，ucode 真机也确实回了
 *   "stage":"idle"，但 rpc.js 的 fetchCall **没把这两个字段搬过来**。
 *   于是后端在回、前端在读，中间那层没搬 ⇒ res.stage 恒为 undefined、
 *   st.stage 恒为 null ⇒ 徽标一直退回 CALL_STATE 的 0-5 粗判，
 *   自检卡片永远只显示「检查失败」。
 *   ★ 为什么之前没发现：真机验证是 `ubus call mt5700 call {...}` 直调，
 *     **绕过了 rpc.js 这一层**。所以「后端返回正确」不等于「页面正确」——
 *     每一层都得单独验，且必须有断言把相邻两层的字段名钉在一起。
 *   ★ 教训：断言只覆盖单层时，跨层的字段改名/漏搬一律无声通过。
 */
ok('★ fetchCall 透传 stage（后端在回、前端在读，这一层不能漏）',
	rpcSrc.includes('stage: (resp.stage == null) ? null : resp.stage'),
	'漏了它 → st.stage 恒 null → 厂商粒度状态机在 UI 上完全不生效');
ok('★ fetchCall 两条失败分支都显式给 stage: null',
	(function () {
		var n = (rpcSrc.match(/stage: null/g) || []).length;
		/* 一条成功分支取 resp.stage，两条失败分支各一处 null ⇒ 共 3 */
		return n >= 2;
	})(),
	'失败时省略字段 → 前端读到 undefined，与「还没查到过」混同（红线 23）');
ok('★ 视图读 res.stage 的前提是 rpc 层真的给了（两端钉在一起）',
	viewSrc.includes('st.stage = res.stage || null;') &&
	rpcSrc.includes('stage: (resp.stage == null) ? null : resp.stage'));

/* ---------- ⑪c 视图：按钮禁用纪律（厂商 usable 语义） ---------- */

/*
 * 厂商 modemwebui call.js 的 usable = s.fresh && !s.busy && !s.status?.error，
 * 再按状态逐个按钮算 disabled。本页的对应实现是 applyGates()。
 * ★ 关键性质：**禁用判据只有一处**。曾在 setBusy 里写一套、renderStatus
 *   里写另一套，结果加「通道故障」条件时漏了一处 —— 两处判据必然漂移。
 */
ok('视图有统一的 applyGates（禁用判据只写一处，不散落在 setBusy/renderStatus）',
	viewSrc.includes('function applyGates()'));
ok('setBusy 只改 busy 标志并转交 applyGates',
	viewSrc.includes('applyGates();') &&
	/function setBusy\(on\) \{[\s\S]{0,300}applyGates\(\);[\s\S]{0,80}\}/.test(viewSrc) &&
	!/function setBusy\(on\) \{[^}]*dialBtn\.disabled/.test(viewSrc),
	'setBusy 里直接写 dialBtn.disabled = on 就是第二套判据，会漂移');
ok('applyGates 把「通道故障」算进禁用（厂商 !s.status?.error 那一半）',
	viewSrc.includes('var blocked = st.busy || st.channelError;'));
ok('接听只在来电（incoming）可点 —— 判据用 phase 不用 stage 令牌',
	viewSrc.includes("answerBtn.disabled = blocked || (st.phase !== 'incoming')"),
	'phase 由前端从 CLCC 原始 state 现算，老后端没有 stage 也能正确灰化');
ok('通话按钮常驻可见，不用 display 隐藏（用户原话：没看到接停电话）',
	!/answerBtn\.style\.display|hangupBtn\.style\.display|muteBtn\.style\.display/
		.test(viewSrc),
	'藏起来的按钮等于没有 —— 可见性交给 disabled 灰化（厂商形态）');
ok('铃声开关也纳入 applyGates（通道忙时不该切铃声）',
	viewSrc.includes('ringBtn.disabled = blocked;'));
ok('建页后立即 applyGates 一次（connectThen 握手前按钮不能是可用态）',
	(function () {
		var i = viewSrc.indexOf('/* ---------- 初始化 ---------- */');
		if (i < 0) { return false; }
		return /applyGates\(\);/.test(viewSrc.slice(i, i + 500));
	})());
ok('拨打只在 idle 可点（通话中不该还能再拨一个）',
	viewSrc.includes("dialBtn.disabled = blocked || (st.phase !== 'idle')"));
ok('静音只在 active 可点',
	viewSrc.includes("muteBtn.disabled = blocked || (st.phase !== 'active')"));
ok('status 读失败置 channelError 且成功时复位（否则永久灰化）',
	viewSrc.includes('st.channelError = true;') &&
	viewSrc.includes('st.channelError = false;'));
ok('读失败不清 stage/calls（别把故障渲染成空闲，红线 23）',
	(function () {
		var i = viewSrc.indexOf('st.channelError = true;');
		if (i < 0) { return false; }
		/*
		 * 窗口只取到失败分支的 `return` 为止 —— 越过它就会落进成功分支，
		 * 而成功分支里的 st.stage = res.stage 是**应该**有的（这正是真机
		 * 观察到的那行）。窗口开太大 ⇒ 断言恒红，久了就没人看它。
		 */
		var seg = viewSrc.slice(i, viewSrc.indexOf('return;', i));
		return !seg.includes('st.stage = ') && !seg.includes('st.calls = ')
			&& !seg.includes('applyCalls(');
	})(),
	'失败分支里一旦重置 stage/calls，通道故障看起来就像空闲');
ok('st 有 channelError 初值 false（未查询过 ≠ 故障）',
	/channelError: false,/.test(viewSrc));

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

/* ---------- ⑬ preflight 已下线：反向断言 + 厂商命令禁令仍有效 ---------- */

/*
 * v2.4.27：用户判定「可用性自检」是无用功能（能不能拨早已知道，卡片只是噪音）
 * —— 前端卡片、ucode callPreflight/callNumsAfter、rpc 四字段透传全部移除。
 * 这里反向钉死「别再长回来」，避免出现「删了 UI、后端还留着」的半截状态（红线 62）。
 */
ok('ucode 不再有 callPreflight', !ucSrc.includes('function callPreflight('));
ok('ucode 不再有 callNumsAfter（只被 preflight 使用）', !ucSrc.includes('function callNumsAfter('));
ok("call 方法不再派发 preflight", !ucSrc.includes("if (action == 'preflight') {"));
ok('未知 action 文案不再列 preflight',
	/未知 action（/.test(ucSrc) && !/未知 action（[^）]*preflight/.test(ucSrc));
ok('视图不再有自检卡片与入口按钮',
	!viewSrc.includes('可用性自检') && !viewSrc.includes('检查能否拨号'));
ok('视图不再调 preflight 动作', !viewSrc.includes("AtWs.call('preflight')"));
ok('视图不再有 pfBusy / pf 状态', !/st\.pfBusy|st\.pf\b/.test(viewSrc));
ok('rpc 层不再透传 preflight 四字段',
	!rpcSrc.includes('resp.ready') && !rpcSrc.includes('resp.volte') &&
	!rpcSrc.includes('resp.blocked') && !rpcSrc.includes('resp.steps'));

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

/* ★ 兜底轮询只允许 status 一条：串口独占、rpcd 单线程（红线 63/70）。
   历史上自检曾一次发 4 条 AT，若混进轮询就会每拍把 LuCI 卡住一次。 */
ok('兜底轮询里只有 status 查询（不许夹带别的动作）',
	(function () {
		const i = viewSrc.indexOf('function clccTick()');
		const ivBlock = (i < 0) ? '' : viewSrc.slice(i, i + 500);
		return ivBlock.includes('refreshStatus()') && ivBlock.indexOf("AtWs.call('info'") < 0;
	})());

/* ---------- ⑩ URC 事件驱动（2026-10-22 真机实测后新增） ----------
 *
 * 背景：实测拨 10086，从 ATD 到挂断的每一条状态变化都由鼎桥私有 URC 主动
 * 报出来（^CCALLSTATE / ^ORIG / ^CONF / ^CONN / ^CEND），一条开启命令都没发。
 * 而 +CLCC 到 t+12s 才反映「已接通」，URC 在 t+7s 就报了 —— 轮询慢 5 秒。
 * 于是把 URC 接成触发器：变化一到就立刻读一次 CLCC，状态值仍由 CLCC 现算。
 */

ok('视图消费通话类 URC（rpc.js 产出的 {type:"CALL"}）',
	viewSrc.includes("ev.data.type === 'CALL'") && viewSrc.includes('function handleCallUrc'));

/*
 * ★ 这条是整个改造的核心纪律，也是最容易被后来者「顺手优化」掉的地方：
 *   ^CCALLSTATE 的 <state>（0 originate / 1 proceeding / 2 alerting /
 *   3 connected / 4 released / 5 incoming / 6 waiting / 7 hold / 8 retrieve）
 *   与 +CLCC 的 <stat>（0 active / 1 held / 2 dialing / 3 alerting /
 *   4 incoming / 5 waiting）**是两套编号**。同一个「接通」一个是 3、一个是 0。
 *   一旦有人把 URC 的 state 直接写进 applyCalls，全部状态会静默错位
 *   —— 而且页面看起来「还在动」，最难查。所以反向断言：
 *   handleCallUrc 体内不许出现 st.phase 赋值，只许调 urcKick()。
 */
ok('URC 只当触发器，不直接改 phase（两套编号不许混用）',
	(function () {
		const i = viewSrc.indexOf('function handleCallUrc');
		const j = viewSrc.indexOf('function urcKick');
		if (i < 0 || j < 0 || j <= i) { return false; }
		const body = viewSrc.slice(i, j);
		return body.includes('urcKick()') && body.indexOf('st.phase') < 0;
	})());

ok('URC 触发刷新带 250ms 合并窗口（同批 URC 不连发 CLCC）',
	/function urcKick\(\)[\s\S]*?now - lastStatusAt < 250[\s\S]*?setTimeout/.test(viewSrc) &&
	viewSrc.includes('lastStatusAt = Date.now()'));

ok('通话时长优先用 ^CEND 给的秒数，前端差值只作降级',
	/duration: \(t\.endedDuration != null\) \? t\.endedDuration\s*: \(t\.answeredAt/.test(viewSrc));

ok('新一通开始清掉上一通的 ^CEND 残留时长（否则会记到下一通头上）',
	/if \(!track\) \{[\s\S]{0,200}pendingDuration = null/.test(viewSrc));

ok('语音域（IMS/CS）取自 ^CCALLSTATE 第三字段，空闲时清掉',
	viewSrc.includes('st.domain = d.domain') &&
	viewSrc.includes("stateText += ' · IMS'") &&
	/st\.phase === 'idle'\) \{ st\.domain = null; \}/.test(viewSrc));

/*
 * 事件轮询间隔必须压小再还原。
 * 不压：URC 再即时也要等下一次 pollEvents（默认 1500ms）才被看见，
 *       相对原来 2s 的 CLCC 轮询只快 0.4 秒 —— 等于白做。
 * 不还原：pollInterval 是 AtWs.client 共享单例的属性，之后每个页面都按
 *       500ms 频率拉 events，白挤 rpcd 单线程（红线 63）。
 */
ok('本页把事件轮询压到 500ms，离开时还原共享单例的间隔',
	/c\.pollInterval = 500;/.test(viewSrc) &&
	/savedPollInterval = c\.pollInterval;/.test(viewSrc) &&
	/c\.pollInterval = savedPollInterval;/.test(viewSrc) &&
	/if \(savedPollInterval == null\) \{ savedPollInterval = c\.pollInterval; \}/.test(viewSrc));

ok('离开页面清掉 URC 合并定时器（否则走后还会打一条 CLCC）',
	/_onDispose\(function[\s\S]{0,400}if \(kickTimer\) \{ clearTimeout\(kickTimer\); kickTimer = 0; \}/.test(viewSrc));

ok('rpc.js 解析 ^CCALLSTATE 与 ^CEND，数值字段归一到 number 或 null',
	rpcSrc.includes('function parseCcallState') &&
	rpcSrc.includes('function parseCend') &&
	rpcSrc.includes('isNaN(n) ? null : n') &&
	rpcSrc.includes('numOrNull(f[1])'));

ok('parseRawData 认领通话 URC（不认就等于后端白转发）',
	rpcSrc.includes("line.indexOf('^CCALLSTATE:') === 0") &&
	rpcSrc.includes("line.indexOf('^CEND:') === 0") &&
	rpcSrc.includes("line.indexOf('^ORIG:') === 0"));

/*
 * ★ 跨层断言（红线 85 的教训：「后端返回正确」≠「页面拿到」）。
 *   atclient.rs 的 is_exclusive_urc 只管「要不要 emit」，broadcast 位取的是
 *   is_passthrough_urc —— 只加前者不加后者，URC 会被并进 AT+CLCC 的应答体，
 *   前端一条都收不到，而所有本地测试依然全绿。两处必须同时含这五个前缀。
 */
ok('后端 is_passthrough_urc 登记了五条通话 URC（命令等待期才带 broadcast）',
	(function () {
		const p = path.join(ROOT, 'src', 'rust', 'src', 'atclient.rs');
		if (!fs.existsSync(p)) { return false; }
		const src = fs.readFileSync(p, 'utf8');
		const i = src.indexOf('pub fn is_passthrough_urc');
		const j = src.indexOf('\n}', i);
		if (i < 0 || j < 0) { return false; }
		const body = src.slice(i, j);
		const need = ['"^CCALLSTATE:"', '"^ORIG:"', '"^CONF:"', '"^CONN:"', '"^CEND:"'];
		return need.every(function (k) { return body.includes('line.starts_with(' + k + ')'); });
	})());

/* ---------- 汇总 ---------- */

console.log('');
if (fails.length) {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.log(f); });
	process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
