#!/usr/bin/env node
/*
 * 运行日志页 契约测试（纯 Node，绝不向真机下发任何 AT）
 * ---------------------------------------------------------------------------
 * 2026-09-18：「通知日志」改「运行日志」，三个视图
 *   模组拨号（后端内存日志）/ 接口与网络（syslog）/ 通知记录（原通知文件）。
 *
 * 本测试覆盖两块：
 *   ① **真行为**（不是正则匹配源码）：把 logs.js 里 `return L.view.extend` 之前的
 *      纯函数抽出来 eval，喂 mock 数据跑 entriesFromBackend / entriesFromSyslog。
 *      它们不碰 DOM、不碰 RPC，可以真跑。
 *   ② 源码级契约（防回退，钉住踩过的坑）：
 *      · 后端能力缺失 → 明确报错，绝不显示空列表（本项目最痛的「失败误报成功」）
 *      · 三路取数**真串行**，不能 Promise.all（曾出现 syslog 结果被后端那路清空抹掉）
 *      · 日志内容禁用 innerHTML（含短信正文/运营商名等不可信输入）
 *      · 搜索用 indexOf 不用 new RegExp（正则注入 / ReDoS）
 *      · 自动刷新默认关、定时器进 _dispose、页面隐藏时跳过
 *
 * 运行：node tests/logs-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGS_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'logs.js');
const MENU_JSON = path.join(ROOT, 'root', 'usr', 'share', 'luci', 'menu.d', 'luci-app-mt5700.json');
const ACL_JSON = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json');

const src = fs.readFileSync(LOGS_JS, 'utf8');
const menuJson = fs.readFileSync(MENU_JSON, 'utf8');
const aclRaw = fs.readFileSync(ACL_JSON, 'utf8');

let pass = 0;
const fails = [];
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}

/* ---------- 0. 抽出纯函数真跑（到 return L.view.extend 为止） ---------- */

/* ★ 用「行首锚定」的正则而不是 indexOf('return L.view.extend')：
   后者会命中**注释里**提到的同一串字（曾因此把 foldRepeats 切到注释外，
   prelude 变成一段未闭合的块注释，eval 直接 SyntaxError）。 */
const preludeMatch = src.match(/^return L\.view\.extend\(/m);
ok('能定位视图定义起点以切出纯函数段', !!preludeMatch);
const preludeEnd = preludeMatch ? preludeMatch.index : src.indexOf('return L.view.extend');
const prelude = src.slice(0, preludeEnd);

/* eslint-disable no-eval */
const Fns = eval('(function(){' + prelude + '\nreturn { entriesFromBackend: entriesFromBackend, entriesFromSyslog: entriesFromSyslog, foldRepeats: foldRepeats, fmtStamp: fmtStamp, parseNotify: parseNotify, levelOfText: levelOfText, DIAL_RE: DIAL_RE };})()');

/* ---------- 1. entriesFromBackend（后端内存日志 → 统一条目） ---------- */

eq('空数组 → 空列表', Fns.entriesFromBackend([]), []);
eq('完整字段原样带上', Fns.entriesFromBackend([{ ts: 1700000000000, level: 'ERR', msg: 'boom' }]),
	[{ ts: 1700000000000, level: 'ERR', msg: 'boom' }]);
eq('缺 level 兜底 INF', Fns.entriesFromBackend([{ ts: 1, msg: 'x' }])[0].level, 'INF');
eq('缺 msg 兜底空串', Fns.entriesFromBackend([{ ts: 1, level: 'WRN' }])[0].msg, '');
eq('缺 ts 兜底 0（不出现 NaN）', Fns.entriesFromBackend([{ level: 'INF', msg: 'x' }])[0].ts, 0);
eq('ts 是字符串数字也转得过来', Fns.entriesFromBackend([{ ts: '1700000000000', msg: 'x' }])[0].ts, 1700000000000);
eq('ts 是垃圾值不产生 NaN', Fns.entriesFromBackend([{ ts: 'abc', msg: 'x' }])[0].ts, 0);
eq('null 元素不炸（后端偶发空对象）', Fns.entriesFromBackend([null])[0].msg, '');
eq('多条保持原顺序（后端已按时间排好）',
	Fns.entriesFromBackend([{ ts: 2, msg: 'b' }, { ts: 1, msg: 'a' }]).map(function (e) { return e.msg; }),
	['b', 'a']);

/* ---------- 2. entriesFromSyslog（只挑本插件的行，级别靠文本推断） ---------- */

eq('syslog 空 → 空列表', Fns.entriesFromSyslog([]), []);
eq('无关行被过滤掉', Fns.entriesFromSyslog([
	{ time: 1000, msg: 'dnsmasq[1]: dhcp ack' },
	{ time: 1001, msg: 'kernel: eth2 up' }
]), []);
eq('取 at-webserver 的行并剥掉前缀', Fns.entriesFromSyslog([
	{ time: 1000, msg: 'at-webserver[123]:  接口 eth2 已拉起 ' }
]), [{ ts: 1000, level: 'INF', msg: '接口 eth2 已拉起' }]);
eq('无 PID 前缀也认', Fns.entriesFromSyslog([{ time: 5, msg: 'at-webserver: hello' }])[0].msg, 'hello');
eq('★ Rust 进程那类行要排掉（内存日志已提供，两边都收会重复）',
	Fns.entriesFromSyslog([{ time: 5, msg: 'at-webserver-rust[9]: dial ok' }]), []);
eq('含「失败」判 ERR', Fns.entriesFromSyslog([{ time: 5, msg: 'at-webserver: 拨号失败' }])[0].level, 'ERR');
eq('含 error（不分大小写）判 ERR', Fns.entriesFromSyslog([{ time: 5, msg: 'at-webserver: ERROR' }])[0].level, 'ERR');
eq('含「警告」判 WRN', Fns.entriesFromSyslog([{ time: 5, msg: 'at-webserver: 警告：信号弱' }])[0].level, 'WRN');
eq('普通行判 INF', Fns.entriesFromSyslog([{ time: 5, msg: 'at-webserver: 启动完成' }])[0].level, 'INF');
eq('冒号后没内容的不收（避免空行刷屏）',
	Fns.entriesFromSyslog([{ time: 5, msg: 'at-webserver:' }]), []);
eq('缺 time 时不产生 NaN 时间戳', Fns.entriesFromSyslog([{ msg: 'at-webserver: x' }])[0].ts > 0, true);

/* ★ 真机实测：本插件在 syslog 里有**两种** tag（at-webserver / mt5700-uci），
   只认 at-webserver 一种会把 UCI 那批行全丢掉 —— 页面上就表现为「没有任何数据」。
   这是 2.3.6 修的主 bug 之一，钉死防回退。
   正则里 `mt5700-` 是通配的（不是枚举），所以历史上 mt5700-watchdog 那类
   已随看门狗移除的 tag 依然收得到 —— 那是 ring buffer 里的旧记录，属无害的历史。 */
eq('★ 收 mt5700- 前缀的其它 tag（不止 at-webserver）', Fns.entriesFromSyslog([
	{ time: 1000, msg: 'mt5700-diag: 体检完成' }
]), [{ ts: 1000, level: 'INF', msg: '体检完成' }]);
eq('★ 收 mt5700-uci 的行', Fns.entriesFromSyslog([
	{ time: 1000, msg: 'mt5700-uci: at-webserver 已设为开机自启（S99at-webserver）' }
])[0].msg, 'at-webserver 已设为开机自启（S99at-webserver）');
eq('带 PID 的 mt5700 系 tag 也认',
	Fns.entriesFromSyslog([{ time: 1, msg: 'mt5700-uci[88]: ping' }])[0].msg, 'ping');
eq('★ Rust 进程那类的行仍被排除（内存日志已提供，两边都收会重复）',
	Fns.entriesFromSyslog([{ time: 5, msg: 'at-webserver-rust[9]: dial ok' }]), []);
eq('★ 别家插件的行仍被排除（不能因为放开 tag 就收一堆噪音）',
	Fns.entriesFromSyslog([
		{ time: 1, msg: 'dnsmasq[1]: dhcp ack' },
		{ time: 2, msg: 'odhcpd[3010]: No default route present' },
		{ time: 3, msg: 'dropbear[1187]: Password auth succeeded' }
	]), []);

/* ---------- 2b. 相邻重复折叠 ---------- */

eq('无重复原样返回', Fns.foldRepeats([
	{ ts: 1, level: 'INF', msg: 'a' }, { ts: 2, level: 'INF', msg: 'b' }
]), [{ ts: 1, level: 'INF', msg: 'a', repeat: 1 }, { ts: 2, level: 'INF', msg: 'b', repeat: 1 }]);
eq('★ 相邻相同合并并计数（看门狗那句会连着出现几十次）',
	Fns.foldRepeats([
		{ ts: 1, level: 'INF', msg: 'x' }, { ts: 2, level: 'INF', msg: 'x' }, { ts: 3, level: 'INF', msg: 'x' }
	]), [{ ts: 3, level: 'INF', msg: 'x', repeat: 3 }]);
eq('★ 不相邻的相同文案不合并（中间出过别的事）', Fns.foldRepeats([
	{ ts: 1, level: 'INF', msg: 'x' }, { ts: 2, level: 'ERR', msg: 'y' }, { ts: 3, level: 'INF', msg: 'x' }
]).length, 3);
eq('★ 级别不同即使文案相同也不合并', Fns.foldRepeats([
	{ ts: 1, level: 'INF', msg: 'x' }, { ts: 2, level: 'ERR', msg: 'x' }
]).length, 2);
eq('空列表不炸', Fns.foldRepeats([]), []);

/* ---------- 3. 拨号分类正则（哪些行算「模组拨号」） ---------- */

ok('命中「自动拨号」', Fns.DIAL_RE.test('自动拨号对齐完成'));
ok('命中 PDP', Fns.DIAL_RE.test('PDP 上下文激活成功'));
ok('命中 NDIS', Fns.DIAL_RE.test('NDIS 网卡就绪'));
ok('命中串口号', Fns.DIAL_RE.test('探测到 ttyUSB1'));
ok('不命中无关行', !Fns.DIAL_RE.test('接口 eth2 已拉起'));
ok('不命中纯 syslog 的 dnsmasq 行', !Fns.DIAL_RE.test('dnsmasq: dhcp ack'));

/* ---------- 0b. 去掉注释后的纯代码 ----------
 * 源码级断言必须只看代码：本文件顶部的设计说明里故意写了
 * 「innerHTML / new RegExp / Promise.all」这些**反例字面量**，
 * 直接对原文跑正则会被自己的注释命中（实测三条误判）。
 * 只剥 /* *\/ 块注释与行注释；`//` 前面是 `:` 或引号时跳过（URL / 字符串里的斜杠）。 */
function stripComments(s) {
	return s.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
const code = stripComments(src);

/* ---------- 3b. ★ 统一格式：时间前缀必须带年月日 ---------- */

const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
ok('时间格式是「年月日 时分秒」', STAMP_RE.test(Fns.fmtStamp(1789736443532)));
eq('个位数补零', Fns.fmtStamp(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04:05');
ok('★ 旧的只给时分秒的 fmtClock 已下线', !/fmtClock/.test(code));
ok('★ 日志行的时间列用 fmtStamp', /fmtStamp\(e\.ts\)/.test(code));
ok('★ 导出头与每个导出行都带完整时间',
	/fmtStamp\(Date\.now\(\)\)/.test(code) && /fmtStamp\(e\.ts\)/.test(code));

/* ---------- 3c. 通知文件结构化（一条一行，续行并入上一条） ---------- */

const NOTIFY_SAMPLE = [
	'2026-09-16 20:39:31 [watchdog] 看门狗启动：接口=MT5700M',
	'--------------------------------------------------',
	'[2026-09-18 15:32:35] 发送者: 10658965010',
	'内容: 【中国移动】戳 https://f.10086.cn/s/#70JefoL 参与',
	'--------------------------------------------------',
	'[2026-09-18 15:40:01] 发送者: 信号监控',
	'内容: 网络切换提醒',
	'制式: NR',
	''
].join('\n');
const recs = Fns.parseNotify(NOTIFY_SAMPLE);

eq('分隔线丢掉、三种写法切成 3 条', recs.length, 3);
eq('无方括号的写法也能吃出时间', Fns.fmtStamp(recs[0].ts), '2026-09-16 20:39:31');
ok('无方括号那条的 tag 原文保留', recs[0].text.indexOf('[watchdog]') === 0);
eq('方括号写法吃出时间', Fns.fmtStamp(recs[1].ts), '2026-09-18 15:32:35');
ok('★ 续行并入上一条，不丢原文',
	recs[1].text.indexOf('发送者: 10658965010') === 0 && recs[1].text.indexOf('内容:') > 0);
ok('短信里的链接与中文原样保留（不改写正文）',
	recs[1].text.indexOf('https://f.10086.cn/s/#70JefoL') > 0);
eq('两条续行都并入第三条', recs[2].text, '发送者: 信号监控 · 内容: 网络切换提醒 · 制式: NR');
eq('★ 每条都拿到了时间戳（每行都有前缀可显示）',
	recs.filter(function (r) { return r.ts > 0; }).length, 3);
eq('开头就是续行时不丢（ts 记 0，时间列显示 —）', Fns.parseNotify('内容: 孤儿行')[0].ts, 0);
eq('空文件 → 空列表', Fns.parseNotify(''), []);
eq('级别推断：错误', Fns.levelOfText('接口拉起失败'), 'ERR');
eq('级别推断：警告', Fns.levelOfText('warn: 信号弱'), 'WRN');
eq('级别推断：默认信息', Fns.levelOfText('接口已 up'), 'INF');
ok('★ 通知视图与前两个视图同一行式（时间 → 级别 → 正文）',
	/function renderNotify[\s\S]{0,1600}mt5700-logmeta/.test(code));

/* ---------- 4. 页面与菜单改名 ---------- */

ok('页头是「运行日志」', /Mt5700\.page\('运行日志'/.test(src));
ok('旧的「通知日志」页头已下线', !/Mt5700\.page\('通知日志'/.test(src));
ok('菜单 title 已改「运行日志」', /"title":\s*"运行日志"/.test(menuJson));
ok('菜单里不再有「通知日志」', menuJson.indexOf('通知日志') < 0);
ok('三个视图 Tab 齐全',
	/label:\s*'模组拨号'/.test(src) && /label:\s*'接口与网络'/.test(src) && /label:\s*'通知记录'/.test(src));

/* ---------- 5. ★ 失败路径不许误报成功 ---------- */

ok('★ 后端日志取不到时有专门分支（不是当成空列表）',
	/state\.backendLogs === false/.test(src) && /Mt5700\.errorState\(/.test(src));
ok('★ 报错文案点名依赖的方法（不说「暂无日志」糊弄过去）',
	/后端未提供 logs 方法/.test(src) || /取不到模组拨号日志/.test(src));
ok('★ 报错文案既说清依赖的方法，也说清「前端新、设备旧」这个当前真实处境',
	/ubus mt5700\.logs/.test(src) && /设备上跑的服务二进制还是旧的/.test(src));
ok('★ 报错给重试入口', /errorState\(([\s\S]{0,400})refresh\(true\)/.test(src));
ok('★ 探测失败后不轮询、不重试（没有自动重排定时器）',
	!/retry|重试[\s\S]{0,60}setTimeout/.test(src));
ok('syslog 不可读时 footer 明写，不静默', /syslog 不可读/.test(src));
ok('★ R01 后端挂了时 iface 页要单独说，不能只怪 syslog（iface 一半数据来自后端）',
	/后端日志不可用/.test(src));
ok('★ R01 三路全失败不许弹「已刷新」：按成功数分级（0 → error / 部分 → warning）',
	/okCount === 0[\s\S]{0,200}Mt5700\.error/.test(code)
	&& /只取到 ' \+ okCount/.test(code)
	&& /okCount === 3[\s\S]{0,120}Mt5700\.success/.test(code));
ok('★ R02 通知文件读失败要单独存原因，不许写成空内容（否则显示成「暂无通知记录」）',
	/state\.notifyErr =/.test(code) && /读不到通知文件/.test(src));
ok('★ R02 首屏不许显示「暂无日志」：未取过显示「加载中…」',
	/!state\.primed \? '加载中…'/.test(code));
ok('★ R09 后端已提供但缓冲为空，要与「能力缺失」区分开',
	/后端已提供日志接口，但当前缓冲为空/.test(src));
ok('★ 三路取数真串行（steps.reduce），不是并发 Promise.all',
	/steps\.reduce\(function \(p, step\) \{\s*return p\.then\(step\);/.test(code)
	&& !/Promise\.all\(/.test(code));

/* ---------- 5b. ★ 首屏取数不得被 single-flight 挡掉 ----------
 * refresh() 开头是 `if (state.loading) return`（防重入）。曾为「首屏先显示加载中」
 * 在调用 refresh 前预置了 state.loading = true —— 结果第一次取数被它自己挡掉，
 * 三个视图永远停在「加载中…」，真机表现就是「运行日志里没有数据」。
 * 「还没取过」必须由 state.primed 表达，不能复用 loading。
 * ★ 用 code（已剥注释）匹配：源码注释里就写着这串反例。 */

ok('★ 首屏不得预置 state.loading = true',
	!/state\.loading\s*=\s*true;\s*renderAll\(\);/.test(code)
	&& !/state\.loading\s*=\s*true;\s*\n\s*renderAll\(\);/.test(code));
ok('★ 首屏是「先渲染、后取数」，且中间没有 loading 赋值',
	/renderAll\(\);\s*refresh\(false\);/.test(code));
ok('★ refresh 仍保留 single-flight（防重入）',
	/function refresh\(manual\)[\s\S]{0,120}if \(state\.loading\) return/.test(code));
ok('★ 「还没取过」由 primed 表达', /primed:\s*false/.test(code)
	&& /state\.primed\s*=\s*true/.test(code));
ok('★ 未取数时列表显示「加载中…」而不是「暂无日志」',
	/!state\.primed \? '加载中…'/.test(code) || /'加载中…'/.test(code));

/* ---------- 6. 安全：注入面 ---------- */

const htmlWrites = (code.match(/innerHTML\s*=\s*([^;\n]+)/g) || []);
ok('★ 日志内容不用 innerHTML：所有 innerHTML 赋值都只是清空（= \'\'）',
	htmlWrites.length > 0 && htmlWrites.every(function (w) { return /= ?''|""\s*$/.test(w); }),
	htmlWrites.join(' | '));
ok('★ 日志内容不用 innerHTML（清点非清空型赋值，应为 0）',
	htmlWrites.filter(function (w) { return !/=\s*(''|\"")\s*$/.test(w); }).length === 0,
	htmlWrites.join(' | '));
ok('★ 高亮走 createTextNode + <mark>.textContent',
	/document\.createTextNode/.test(code)
	&& /createElement\('mark'\)/.test(code)
	&& /mk\.textContent\s*=/.test(code));
ok('★ 搜索用 indexOf，不用正则对象（防正则注入/ReDoS）',
	/indexOf\(q\)/.test(code) && !/new RegExp\(/.test(code));
ok('★ 高亮函数无搜索词时也必须返回 Node（早期返回字符串会让 appendChild 抛错）',
	/if \(!state\.query\) return document\.createTextNode\(s\)/.test(src));
ok('清空是不可逆操作 → 走 Mt5700.confirm 二次确认',
	/function clearNotify[\s\S]{0,200}Mt5700\.confirm/.test(src));

/* ---------- 7. 定时器 / 通道占用（红线 4） ---------- */

ok('★ 自动刷新默认关', /auto:\s*false/.test(src));
ok('★ 默认 Tab 不是「模组拨号」：设备上的服务二进制可能还是旧的，'
	+ '落在一个必红屏的视图上体验很差',
	/tab:\s*'iface'/.test(src));
ok('★ 三个 Tab 的顺序仍与参考实现一致（模组拨号在前）',
	src.indexOf("'模组拨号'") < src.indexOf("'接口与网络'")
	&& src.indexOf("'接口与网络'") < src.indexOf("'通知记录'"));
ok('★ 关键词搜索对三个视图一视同仁（别只在两个视图生效，切回来发现列表少一截）',
	!/searchInput\.disabled/.test(code) && /级别筛选只对前两个视图生效/.test(src));
ok('★ 导出与列表同一口径（notify 页导出过滤结果，不是文件全文）',
	/notifyRecords\(\)\.forEach/.test(code));
ok('★ 定时器登记进 _dispose（clearInterval）',
	/_dispose[\s\S]{0,200}clearInterval/.test(src));
ok('★ 页面隐藏时跳过刷新', /if \(document\.hidden\) return;/.test(src));
ok('★ 整页不下发任何 AT 命令（不占 AT 通道）',
	!/sendCommand/.test(src) && !/AtWs\.client/.test(src));

/* ---------- 8. ACL 与后端前提 ---------- */

let acl = null;
try { acl = JSON.parse(aclRaw); } catch (e) { /* 见下条断言 */ }
ok('ACL 是合法 JSON（JSON 不支持注释，别往里写 //）', acl !== null);
if (acl) {
	const rd = acl['luci-app-mt5700'].read.ubus;
	const wr = acl['luci-app-mt5700'].write.ubus;
	eq('★ read 段补了 log.read（syslog 视图需要）', rd.log, ['read']);
	ok('★ write 段没有 log（只读，不给写 syslog 的能力）',
		!wr || !wr.log, wr && wr.log ? 'write 段出现了 log' : '');
	ok('★ mt5700 段授权了 logs（后端内存日志，2.3.8 起提供）',
		rd.mt5700.indexOf('logs') >= 0, JSON.stringify(rd.mt5700));
	ok('★ mt5700 段仍含既有四个方法（没被误删）',
		['at', 'events', 'netrate', 'es9p'].every(function (m) {
			return rd.mt5700.indexOf(m) >= 0;
		}), JSON.stringify(rd.mt5700));
}

/* ---------- 9. ★ 后端 logs 链路四处改动（缺一处就会回到 Access denied） ----------
 * 「模组拨号」视图要取到数据，四处必须同时到位：
 *   ① Rust logger.rs 有内存环形缓冲与 snapshot()
 *   ② Rust rpcserver.rs 有 "logs" 分支
 *   ③ ucode mt5700.uc 有 logs 转发
 *   ④ ACL 的 mt5700 段授权 logs
 * 本机没有 cargo，Rust 改不了本地编译验证 —— 所以这里用源码级断言把四处钉死，
 * 至少保证「漏改某一处」在 CI 就能发现，而不是等刷完机才发现还是 Access denied。 */

const LOGGER_RS = path.join(ROOT, 'src', 'rust', 'src', 'logger.rs');
const RPC_RS = path.join(ROOT, 'src', 'rust', 'src', 'rpcserver.rs');
const UCODE_UC = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const loggerRs = fs.readFileSync(LOGGER_RS, 'utf8');
const rpcRs = fs.readFileSync(RPC_RS, 'utf8');
const ucodeUc = fs.readFileSync(UCODE_UC, 'utf8');

ok('① logger.rs 有环形缓冲容量常量', /const LOG_BUFFER_CAP/.test(loggerRs));
ok('① logger.rs 导出 snapshot()', /pub fn snapshot\(/.test(loggerRs));
ok('★ ① 入缓冲在级别判断**之前**（否则级别调高时缓冲为空，等于白留）',
	loggerRs.indexOf('buffer_push(') < loggerRs.indexOf('if lv < level()')
	&& loggerRs.indexOf('buffer_push(') < loggerRs.lastIndexOf('if lv < level()'));
ok('① LogRecord 可序列化（serde derive 已在 Cargo.toml 开启）',
	/#\[derive\([^\n]*serde::Serialize/.test(loggerRs));

ok('② rpcserver.rs 有 logs 分支', /"logs"\s*=>\s*\{/.test(rpcRs));
ok('② logs 分支走 crate::logger::snapshot',
	/crate::logger::snapshot\(since, limit\)/.test(rpcRs));
ok('② logs 分支限制 limit 上限（防止一次拉爆缓冲；上限锚 LOG_BUFFER_CAP 单源，A-B5）',
	/\.min\(crate::logger::LOG_BUFFER_CAP/.test(rpcRs));

ok('③ ucode 有 logs 方法', /\blogs:\s*\{/.test(ucodeUc));
ok('③ ucode logs 转发带 since 与 limit',
	/rpcCall\('logs', \{ since: since, limit: limit \}\)/.test(ucodeUc));
ok('③ ucode logs 对 limit 做了边界钳制（<=0 或 >1200 回落 300）',
	/if \(limit <= 0 \|\| limit > 1200\)/.test(ucodeUc));

ok('★ 前端默认级别是「信息及以上」而不是「全部级别」'
	+ '（后端会送来大量 DBG 的 AT 命令回显）',
	/level:\s*'INF'/.test(src) && /含调试（AT 命令回显）/.test(src));
ok('★ 级别筛选是阈值而非精确匹配（选「警告」时也含错误）',
	/LEVEL_ORDER\s*=\s*\{ DBG: 0, INF: 1, WRN: 2, ERR: 3 \}/.test(src)
	&& /o != null && o < minOrder/.test(src));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.error('  ✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.error('    - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（运行日志：取数真行为 / 失败不误报 / 注入防护 / 定时器红线 / ACL）');
