#!/usr/bin/env node
'use strict';

/**
 * 已发短信记录「唯一真源」契约测试
 * ---------------------------------------------------------------------------
 * BUG：换个浏览器就看不到已经发送过的短信记录。
 *
 * 根子不是显示层，是**存错了地方**：已发短信当时只写在浏览器的 localStorage 里。
 * localStorage 是浏览器私有的 —— 换浏览器、清缓存、换一台电脑打开页面，一条都不剩。
 * 而「这台设备发出过什么」是所有浏览器都该看到同一份的事实，只能落在**设备**上。
 *
 * 现在唯一真源是设备上的 /etc/mt5700/sms-sent.json，经 ubus `mt5700.smslog`
 * （list / add / del / clear）读写。前端那一层 localStorage 已整块删除 ——
 * 留着就是「同一条短信画两个气泡」的温床（2.3.57 刚修过一次同构的毛病）。
 *
 * ★ 为什么不是写进模组短信存储（AT+CMGW=<len>,3）：可行性真机验证过（CMGW 受理、
 *   CMGL 能回读 `+CMGL: 41,3,,25`），但 SM 只有 50 个槽位、本机实测已占 44，
 *   且 smsclean 的解码器只认 SMS-DELIVER —— SUBMIT 解不出时间就进不了淘汰名单，
 *   存满之后谁也删不掉，表现为短信再也收不进来。本测试同时钉住「这条路的残留
 *   代码不许回来」。
 *
 * 用法：node tests/sms-sent-log-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver');
const A = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver');

function read(p) { return fs.readFileSync(p, 'utf8'); }
const SMS = read(path.join(V, 'sms_center.js'));
const SMSSET = read(path.join(V, 'sms_settings.js'));
const RPC = read(path.join(A, 'rpc.js'));
const PARSE = read(path.join(A, 'parse.js'));
const ENC = read(path.join(A, 'smsEncode.js'));
const UCODE = read(path.join(ROOT, 'root/usr/share/rpcd/ucode/mt5700.uc'));
const ACL = JSON.parse(read(path.join(ROOT, 'root/usr/share/rpcd/acl.d/luci-app-mt5700.json')));

let pass = 0, fail = 0;
/* ★ 失败前缀必须是 '  ✗ '：tools/verify-guards.py 靠它数「判红几处」，
   写成别的会让守卫看上去「判红 0 处」（2026-09-24 那条 off-by-one 的同类坑）。 */
function ok(name) { pass++; console.log('  ok   ' + name); }
function no(name, why) { fail++; console.log('  ✗ ' + name + '  → ' + why); }
function has(name, cond, why) { cond ? ok(name) : no(name, why); }

/* ------------------------------------------------------------------ */
console.log('== A. 已发记录不再落在浏览器 ==');

has('sms_center.js 不再读 localStorage 里的已发缓存',
	!/getCachedSentMessages|SMS_CACHE_KEY/.test(SMS),
	'localStorage 是浏览器私有的，换浏览器就没了 —— 这次要治的就是它');
has('sms_center.js 不再写 localStorage 里的已发缓存',
	!/saveSentMessageToCache|clearSentMessageCache/.test(SMS),
	'已发记录只允许有一个真源');
has('parse.js 不再导出 localStorage 短信缓存 API',
	!/api\.getCachedSentMessages|api\.saveSentMessageToCache|api\.clearSentMessageCache/.test(PARSE),
	'API 留在那里迟早被人重新用起来 —— 删掉才是真删');
has('sms_settings.js 不再读 localStorage 里的已发缓存',
	!/getCachedSentMessages|SMS_CACHE_KEY|MAX_SMS_CACHE/.test(SMSSET),
	'设置页的导出/导入/清空必须作用在设备端记录上');
/*
 * 只看**调用点**（名字后面紧跟左括号）：parse.js 的说明性注释里会提到这些旧名字，
 * 那是「为什么删」的记录，不是死代码复活。
 */
var CALL_SENT_CACHE = /\.(saveSentMessageToCache|getCachedSentMessages|clearSentMessageCache)\s*\(/;
has('全仓库没有 localStorage 已发缓存的调用点',
	![SMS, SMSSET, RPC, PARSE].some(function (src) { return CALL_SENT_CACHE.test(src); }),
	'死代码留着就是下一个「两个来源」的入口');

/* ------------------------------------------------------------------ */
console.log('== B. 真源在设备上（链路齐全） ==');

has('rpc.js 声明了 mt5700.smslog',
	/object:\s*'mt5700',\s*\n\s*method:\s*'smslog'/.test(RPC),
	'前端必须有到 ubus 的通路');
has('rpc.js 的参数顺序与 ucode 的 args 一致（action/entry/id）',
	/params:\s*\['action',\s*'entry',\s*'id'\]/.test(RPC),
	'顺序错位会把 JSON 串塞进整型参数，rpcd 直接 code=2');
has('rpc.js 暴露 AtWs.smsLog',
	/\bsmsLog:\s*fetchSmsLog/.test(RPC), '页面统一走 AtWs.smsLog');
has('ucode 里注册了 smslog 方法',
	/\bsmslog:\s*\{[\s\S]{0,200}?args:\s*\{\s*action:\s*''/.test(UCODE),
	'没有这个方法，前端的调用只会得到「后端未升级」');
has('ACL 的 read 允许 mt5700.smslog',
	(ACL['luci-app-mt5700'].read.ubus.mt5700 || []).indexOf('smslog') >= 0,
	'ACL 没放行 → LuCI 会话调用被拒，页面只落一个「读不到」');
has('ACL 的 write 允许 mt5700.smslog',
	(ACL['luci-app-mt5700'].write.ubus.mt5700 || []).indexOf('smslog') >= 0,
	'add/del/clear 是写操作，write 里不放行就写不进去');

/* ------------------------------------------------------------------ */
console.log('== C. 落盘必须原子、失败必须如实回 ==');

has('ucode 用「临时文件 + rename」落盘',
	/fs\.writefile\(tmp,[\s\S]{0,120}?\);\s*\n\s*fs\.rename\(tmp, SMS_LOG_FILE\)/.test(UCODE),
	'直接写目标文件，写到一半断电就留下半个 JSON，整份记录全读不出来');
has('ucode 写盘失败时回 success:false',
	/if \(!smsLogWrite\([\s\S]{0,200}?return \{ success: false, error: '写入已发记录失败/.test(UCODE),
	'没落盘却报成功，下次刷新用户以为「又丢了」—— 正是这个 BUG 本身');
has('smsLogWrite 自己也要如实回报失败（catch 里清理 tmp 后 return false，B09）',
	/function smsLogWrite\(list\) \{[\s\S]{0,300}?\} catch \(e\) \{[\s\S]{0,160}?return false;/.test(UCODE),
	'helper 吞掉异常后返回 true，上面那三处 success:false 就永远走不到');
has('ucode 的已发记录落在 /etc（跨重启）',
	/SMS_LOG_DIR\s*=\s*'\/etc\/mt5700'/.test(UCODE),
	'放 /tmp 的话路由器一重启就没了');
has('ucode 只收四个白名单字段',
	/function smsLogEntry\(m\)[\s\S]{0,600}?return \{ content: m\.content, number: m\.number, time: m\.time, type: m\.type \}/.test(UCODE),
	'这条通路能把内容写进设备文件，多收一个字段就多一条塞任意内容的路子');
has('ucode 判类型只用 type()（本固件 typeof 返回的是值本身）',
	(function () {
		var seg = UCODE.slice(UCODE.indexOf('function smsLogEntry'), UCODE.indexOf('function smsLogNextId'));
		return seg.indexOf('typeof') < 0 && /type\((m|m\.content)\) != 'object'/.test(seg);
	})(),
	'裸写 typeof 在 ucode 里是语法错误，整份插件加载失败');
has('ucode 的 helper 定义在方法表之前（ucode 不做函数提升）',
	UCODE.indexOf('function smsLogRead') > 0 &&
	UCODE.indexOf('function smsLogRead') < UCODE.indexOf('\nreturn {'),
	'定义在 return 之后 → 调用时函数还不存在');

/* ------------------------------------------------------------------ */
console.log('== D. 页面三条动作都走设备 ==');

has('refresh() 把设备记录并入列表',
	/loadSentLog\(\)\.then\(function \(sent\) \{\s*\n\s*buildContacts\(parsed\.concat\(sent\)\)/.test(SMS),
	'不并进去，换浏览器依旧看不到已发记录');
has('发送成功后写设备记录',
	/AtWs\.smsLog\('add', JSON\.stringify\(\{\s*\n?\s*content: content, number: target, time: sentAt, type: 'sent'/.test(SMS),
	'不写设备就还是老毛病');
has('写记录失败要分开说「已发出但未记账」',
	/Mt5700\.warning\('已发出，但发送记录未写入设备/.test(SMS),
	'拿一句「发送成功」把两件事盖过去 = 把失败粉饰成成功');
/*
 * ★ 2026-09-28 更新判据。原来钉的是 `AtWs.smsLog('del', '', msg.logId)`
 *   这个**写法本身**，而它正是「已发送短信删不掉」的两个成因之一：
 *   主路径交出来的记录字段是 `id`（不是 `logId`），`msg.logId` 恒为 undefined。
 *   现在单条与批量共用一个 runDeletes()，编号统一经 logIdOf() 取。
 *   意图不变（必须走设备、编号必须是数字），判据改成钉意图。
 */
has('删除已发记录走设备（编号经 logIdOf 取，且传数字）',
	/AtWs\.smsLog\('del', '', t\.logId\)/.test(SMS) &&
	/return \{ indices: partIndicesOf\(m\), logId: logIdOf\(m\) \};/.test(SMS),
	'id 声明的是整型，传字符串会被 rpcd 以 code=2 拒掉；编号取不到则根本走不到这条路');
has('既没槽位又没编号时如实说删不掉',
	/Mt5700\.warning\('这条记录还没同步到设备上，无法删除/.test(SMS),
	'不提示的话用户点了删除、什么都没发生');
has('批量删除也走设备记录（与单条共用 runDeletes）',
	/runDeletes\(picked\)/.test(SMS) && /runDeletes\(\[msg\]\)/.test(SMS),
	'批量删除漏掉已发记录 = 勾了删不掉；两处各写一套迟早漂移');
has('设置页三个按钮都走 AtWs.smsLog',
	/AtWs\.smsLog\('list'\)/.test(SMSSET) && /AtWs\.smsLog\('add'/.test(SMSSET) && /AtWs\.smsLog\('clear'\)/.test(SMSSET),
	'导出/导入/清空必须作用在设备端，否则改了半天改的是空气');

/* ------------------------------------------------------------------ */
console.log('== E. 老数据一次性搬迁 ==');

has('存在搬迁逻辑', /function migrateLegacySent/.test(SMS), '升级后用户的旧记录不该凭空消失');
has('只在设备端为空时搬',
	/if \(serverList\.length\) return Promise\.resolve\(serverList\);/.test(SMS),
	'不判空会每次进页面都重复搬一遍，记录翻倍');
has('搬成功才清本地',
	/try \{ localStorage\.removeItem\(LEGACY_SMS_KEY\); \} catch \(e\) \{\}/.test(SMS) &&
	SMS.indexOf('localStorage.removeItem(LEGACY_SMS_KEY)') > SMS.indexOf('if (!r.success)'),
	'先清本地再写设备，写失败就两头都没了');

/* ------------------------------------------------------------------ */
console.log('== F. 否决方案的残留不许回来 ==');

has('smsEncode.js 没有 CMGW 归档残留',
	!/vpScts|sctsNow|buildArchiveCommand/.test(ENC),
	'「写进模组存储」是评估后否决的方案，代码留着会有人当它可用');
has('smsEncode.js 仍用相对有效期',
	/firstOctet \|= 0x10;/.test(ENC) && !/firstOctet \|= 0x18/.test(ENC),
	'绝对有效期写发送时刻 = 短信一出就过期，会被短消息中心丢弃');

/* ------------------------------------------------------------------ */
console.log('== G. toSentRecords / logIdOf 行为 ==');

/*
 * 两个函数要**一起抽**：toSentRecords 现在经 logIdOf 取编号（编号只留一处真相），
 * 只抽前者会在求值时撞上 ReferenceError，退化成「抽不出来」而看不见真实行为。
 */
var sentFns = null;
try {
	var mLid = SMS.match(/function logIdOf\(m\) \{[\s\S]*?\n\t\t\}/);
	var mTsr = SMS.match(/function toSentRecords\(list\) \{[\s\S]*?\n\t\t\}/);
	/* eslint-disable no-new-func */
	sentFns = new Function(mLid[0] + '\n' + mTsr[0] +
		'; return { logIdOf: logIdOf, toSentRecords: toSentRecords };')();
} catch (e) {
	sentFns = null;
}
has('能抽出 logIdOf 与 toSentRecords', !!sentFns && typeof sentFns.toSentRecords === 'function',
	'抽不出来就没法测这段行为');

if (sentFns) {
	var logIdOf = sentFns.logIdOf;
	var toSentRecords = sentFns.toSentRecords;

	var r1 = toSentRecords([{ id: 7, content: 'a', number: '10086', time: 't', type: 'sent' }]);
	has('后端 id 改名为 logId（不与模组槽位 index 混淆）',
		r1.length === 1 && r1[0].logId === 7 && r1[0].content === 'a',
		'混用 id 与 index 会让「删除」删错东西');
	has('缺少 id 时 logId 为 null（不是 undefined 也不是 0）',
		toSentRecords([{ content: 'b', number: '1', time: 't', type: 'sent' }])[0].logId === null,
		'0 会被当成合法编号');
	has('入参为空返回空数组', Array.isArray(toSentRecords(null)) && toSentRecords(null).length === 0,
		'后端返回 null 时页面会炸');
	has('跳过空项', toSentRecords([null, { id: 1, content: 'c', number: '2', time: 't', type: 'sent' }]).length === 1,
		'文件里混进 null 会把整页渲染打断');

	/*
	 * ★ 2026-09-28 新增：必须**幂等**。
	 *   loadSentLog 会对 migrateLegacySent 的结果再统一过一遍；而冷路径
	 *   （localStorage 老数据迁移成功）交出来的已经是 logId 形态。
	 *   若这里只认 id，过第二遍就把编号抹成 null —— 那些记录立刻又变成删不掉。
	 */
	var once = toSentRecords([{ id: 9, content: 'c', number: '3', time: 't', type: 'sent' }]);
	has('★ toSentRecords 幂等（已转过 logId 的记录再过一遍不会丢编号）',
		toSentRecords(once)[0].logId === 9,
		'过第二遍会抹掉编号 → 已发短信又变成删不掉');

	/*
	 * ★ 2026-09-28 新增：编号来源只此一处，且两个字段名都要认。
	 *   后端原始记录用 `id`，界面内部用 `logId`；只认一个，主路径
	 *   （设备端已有记录，不再走迁移）的记录就取不到编号。
	 */
	has('★ logIdOf 同时认 logId 与后端 id，且 0 是合法编号',
		logIdOf({ logId: 3 }) === 3 && logIdOf({ id: 4 }) === 4 &&
		logIdOf({ id: 0 }) === 0 && logIdOf({ logId: 0 }) === 0 && logIdOf({}) === null,
		'只认一个字段名 —— 主路径交出来的正是后端原始记录（字段是 id）');
}

console.log('');
console.log('sms-sent-log-contract: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
