'use strict';
'require fs';
'require uci';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, Ui, Mt5700 */

/**
 * 运行日志页
 *
 * 两个顶层视图：
 *   1) 运行日志：后端内存环形缓冲 + 插件日志文件 + syslog 三路合并，按 21 个类别细分
 *   2) 通知记录：通知文件（短信/来电/信号/存储），逻辑不变
 *
 * 类别分两组（与后端 logcat.rs 的 Group 一一对应）：
 *   - 软件运行（Runtime）：进程/配置/RPC/串口/任务/存储/其他 —— 仍写 syslog；
 *   - 业务痕迹（Business）：AT/URC/拨号/接口/信号/SIM/短信/通话/通知/扫频/锁频/
 *     升级/流量/时间 —— **不再刷 syslog**，改由插件自己的有界文件承载，
 *     所以这一组的持久历史只能从那个文件里读回来（见 entriesFromPluginFile）。
 *
 * 展示要点：等宽字体、级别配色与左色条、毫秒级时间列、关键词高亮、斑马纹、
 * 日期分组、类别徽章、长消息折叠、底部统计、可导出为文本。
 */

/* 类别表（前端副本）：key / code / group 与后端 src/rust/src/logcat.rs 对账，
 * tests/log-category-test.js 会逐条比 —— 任何一边漏改都会挂测试。
 * 后端 logs RPC 正常时会随结果下发 categories 清单，前端以它为准（顺序 + 分组），
 * 这张内置表只在清单缺席时兜底（旧后端 / RPC 失败），并且是**标签与图标的唯一来源**：
 * 后端刻意不下发中文文案（见 logcat.rs::table 的注释），文案只在前端存一份，才能走 po/ 翻译。
 * 顺序照抄后端 ALL —— 兜底时也要跟后端一个顺序，否则两版界面的类别条会跳来跳去。 */
var CAT_TABLE = [
	{ key: 'runtime', code: 'RT', group: 'runtime', label: '进程运行时', icon: '🚀' },
	{ key: 'config', code: 'CFG', group: 'runtime', label: '配置与 UCI', icon: '🧩' },
	{ key: 'rpc', code: 'RPC', group: 'runtime', label: 'RPC 服务', icon: '🔗' },
	{ key: 'serial', code: 'TTY', group: 'runtime', label: '串口与设备', icon: '🔌' },
	{ key: 'task', code: 'TSK', group: 'runtime', label: '异步任务', icon: '🧵' },
	{ key: 'storage', code: 'STO', group: 'runtime', label: '存储与文件', icon: '🗄️' },
	{ key: 'misc', code: 'MISC', group: 'runtime', label: '其他', icon: '📦' },
	{ key: 'at', code: 'AT', group: 'business', label: 'AT 通道', icon: '📟' },
	{ key: 'urc', code: 'URC', group: 'business', label: '主动上报', icon: '📥' },
	{ key: 'dial', code: 'DIAL', group: 'business', label: '拨号与承载', icon: '📡' },
	{ key: 'net', code: 'NET', group: 'business', label: '接口与防火墙', icon: '🌐' },
	{ key: 'signal', code: 'SIG', group: 'business', label: '信号与射频', icon: '📶' },
	{ key: 'sim', code: 'SIM', group: 'business', label: 'SIM 卡', icon: '💳' },
	{ key: 'sms', code: 'SMS', group: 'business', label: '短信', icon: '💬' },
	{ key: 'call', code: 'CALL', group: 'business', label: '通话', icon: '📞' },
	{ key: 'notify', code: 'NTF', group: 'business', label: '通知推送', icon: '🔔' },
	{ key: 'scan', code: 'SCAN', group: 'business', label: '全网扫频', icon: '🔍' },
	{ key: 'schedule', code: 'SCH', group: 'business', label: '定时锁频', icon: '⏰' },
	{ key: 'firmware', code: 'FOTA', group: 'business', label: '模组升级', icon: '⬆️' },
	{ key: 'usage', code: 'USAGE', group: 'business', label: '流量统计', icon: '📊' },
	{ key: 'time', code: 'TIME', group: 'business', label: '时间与时区', icon: '🕒' }
];

/* 「全部」是纯前端概念：后端没有这个类别，它只是「不按类别过滤」的开关。
 * 单独放一张卡而不塞进 CAT_TABLE —— 塞进去就会被当成真类别参与计数、配色与对账。 */
var CAT_ALL = { key: 'all', code: 'ALL', group: 'all', label: '全部', icon: '📑' };

/* 类别条的两栏标题：key 对应后端 Group::key()，顺序即自上而下的展示顺序 */
var CAT_GROUP_DEFS = [
	{ key: 'runtime', label: '软件运行', title: '软件自身运行情况：这些行仍写入 syslog' },
	{ key: 'business', label: '业务痕迹', title: '模组业务痕迹：只进内存环形缓冲与插件日志文件，不再刷 syslog' }
];

/* key → 定义、大写 code → key 两张反查表。
 * code 那张是给插件日志文件用的：文件行里只有 [SMS] 这种大写短标签（见 logger.rs），
 * 得反查回 key 才能和内存条目对上号。 */
var CATEGORY_DEFS = {};
var CATEGORY_CODE = {};
for (var _ci = 0; _ci < CAT_TABLE.length; _ci++) {
	var _cd = CAT_TABLE[_ci];
	CATEGORY_DEFS[_cd.key] = _cd;
	CATEGORY_CODE[_cd.code] = _cd.key;
}
CATEGORY_DEFS[CAT_ALL.key] = CAT_ALL;

/* 来源中文名：下拉、导出头、行尾徽章三处共用一份，免得三处措辞各写各的 */
var SRC_LABEL = { all: '全部来源', backend: '后端内存', syslog: 'syslog', file: '插件文件' };

/* 类别规则：有序正则表，先命中先归位。**只是兜底**——
 * 新后端的每条日志都带服务端定类的 cat（logcat.rs），拿得到就直接用；
 * 会走到这里的只有两种行：旧后端（没有 cat 字段）与 syslog 行（永远不带 cat）。
 * 兜底只求「大致归位」，不承诺与后端逐条一致。
 *
 * 顺序即优先级——sms 必须在 at 之前：AT 通道日志形如「发送 → 模组: AT+CMGS=...」，
 * 通道层措辞（发送/接收/模组）与 AT+ 前缀都会命中 at 规则，若 sms 排在后面
 * 所有短信收发痕迹都会被归进「AT 通道」；同时正则必须列全 CMGS/CMGL/CMGR/
 * CMGW/CMSS 这些短信命令名——「SM」子串匹配不到 CMGS（C-M-G-S）。
 * dial 在 net 之前，因为拨号过程里也含接口关键词。
 *
 * 类别从 6 个细分到 21 个之后，同一条理由又延长出几段：
 *   - 窄口径的业务域（sms/call/sim/notify/scan/schedule/firmware/usage/time）必须排在
 *     signal/dial/net/at 这几个宽口径规则之前：宽口径里全是「注册 / 接口 / AT+ / 超时」
 *     这类过程词，几乎每条业务日志都沾得上，让它们先命中就把细分全吃回去了
 *     —— 和上面「短信都进 AT 通道」是同一个坑，只是桶更多、更容易踩。
 *   - dial 在 signal 之前，且 dial 规则里**不再**保留「信号」这个词：
 *     拨号失败的日志几乎都会附一句信号如何，但它讲的是拨号；
 *     若 signal 在前，这类行会全部跑去「信号与射频」，拨号链路反而看不出断点。
 *   - sms 在 urc 之前：+CMT / +CMTI 这类短信主动上报形式上确实是 URC，但用户筛「短信」
 *     时想找的正是这几条；urc 规则里的「+大写命令:」会把它们全兜走，所以让 sms 先命中。
 *   - urc 在 dial/at 之前：主动上报走的也是 AT 通道，行里还常带 +CREG 这类注册 URC，
 *     不先拦下来就会被 dial 按「注册」抢走。
 *   - serial/rpc/task/storage/config/runtime 这组「软件自身」的规则排在最后：
 *     它们的关键词（串口 / 任务 / 配置 / 服务…）在业务日志里常作为背景出现，
 *     放到前面就会把业务痕迹错分成运行时。
 *   - 全都不命中 → misc（Runtime 组），与后端一致：没被认出来的日志保持改造前的行为，
 *     仍进 syslog，不会因为漏标而悄悄从系统日志里消失（见 logcat.rs 里 Misc 的注释）。 */
var CATEGORY_RULES = [
	{ key: 'sms',
		re: /短信|SMS|PDU|长短信|收件|发件|短信中心|CPMS|CMGS|CMGL|CMGR|CMGW|CMSS|CMGD|CMT|归档|存储已满|SM/ },
	{ key: 'call',
		re: /来电|通话|呼叫|接听|挂断|语音|CLIP|COLP/ },
	{ key: 'sim',
		re: /SIM|PIN|PUK|ICCID|IMSI|CPIN|卡槽|鉴权失败/ },
	{ key: 'notify',
		re: /通知|推送|企业微信|QQ|webhook|模板|节流/ },
	{ key: 'scan',
		re: /扫频|全网扫|频段扫描|CELLSCAN/ },
	{ key: 'schedule',
		re: /定时锁频|锁频|锁定频段|频点|定时任务|计划任务/ },
	{ key: 'firmware',
		re: /FOTA|固件升级|模组升级|升级包|刷写/ },
	{ key: 'usage',
		re: /流量|用量|月度|计费|DSFLOW/ },
	{ key: 'time',
		re: /NTP|对时|时区|时钟|时间同步|本地时间|CCLK/ },
	{ key: 'urc',
		re: /URC|主动上报|\+[A-Z]{3,}\s*[:：]/ },
	{ key: 'dial',
		re: /自动拨号|拨号|重拨|退避|SETAUTODIAL|APN|PDP|CGACT|CGDCONT|NDIS|驻网|注册|CREG|CGREG|C5GREG|COPS|SETMODE/ },
	{ key: 'signal',
		re: /信号|CSQ|HCSQ|RSRP|RSRQ|SINR|RSSI|载波聚合|多载波|芯片温度|温度|MONSC|MONNC/ },
	{ key: 'net',
		re: /接口|网口|ifup|ifdown|DHCP|地址|device|hotplug|MT5700M|eth\d|IPv4|IPv6|网关|路由|metric|防火墙|network|DNS/ },
	{ key: 'at',
		re: /AT\+|AT\^|前端请求|发送\s*(?:→|->)\s*模组|接收\s*(?:←|<-)\s*模组|AT\s?通道|事务|超时|重试|CMEE|CNMI|CMGF|回显/ },
	{ key: 'serial',
		re: /串口|ttyUSB|ttyACM|cdc-wdm|termios|设备节点|端口探测|拔插/ },
	{ key: 'rpc',
		re: /RPC|rpc|监听|鉴权|方法分发|回环|127\.0\.0\.1/ },
	{ key: 'task',
		re: /任务|异步|tokio|取消|并发|调度/ },
	{ key: 'storage',
		re: /文件|读写|配额|落盘|磁盘|存储|截断/ },
	{ key: 'config',
		re: /UCI|uci|配置|参数校验|热更新|权限|证书|选项/ },
	{ key: 'runtime',
		re: /启动|退出|版本|服务|procd|守护|重启|内存|CPU|日志级别|Web|luci|panic|SIGTERM|SIGINT|进程/ }
];

/* 级别中文化：徽章显示中文，原始标识放 title 便于对照 */
var LEVEL_LABEL = { DBG: '调试', INF: '信息', WRN: '警告', ERR: '错误' };

/* 术语中文化：只处理「键名与状态词」，**不含 AT 命令名**。
 * AT 命令一律保留英文原文 —— 换成中文就没法对着 AT 手册排障了。
 * 顺序有讲究：长模式在前，避免被子串先命中。
 * 搜索过滤仍按**原文**匹配（见 applyFilters），显示才做装饰。 */
var TEXT_MAP = [
	[/Some\(([^)]*)\)/g, '$1'],
	[/\bNone\b/g, '未设置'],
	[/enable=/g, '开关='],
	[/mode=/g, '方式='],
	[/seq=/g, '序号='],
	[/\bpid\b/g, '进程号'],
	[/\bURC\b/g, '主动上报'],
	[/\bhotplug\b/gi, '热插拔'],
	[/\bifup\b/g, '拉起接口'],
	[/\bifdown\b/g, '关闭接口'],
	[/\bmodem\b/gi, '模组'],
	[/\bdriver\b/gi, '驱动'],
	[/\btimeout\b/gi, '超时'],
	[/\bretry\b/gi, '重试'],
	[/\bmetric\b/g, '路由优先级'],
	[/\bDHCP\b/g, '动态地址分配'],
	[/\bPDP\b/g, '数据承载'],
	[/\bdevice\b/g, '设备'],
	[/\bprocd\b/g, '进程管理']
];

/* AT 命令用途表：命令原文照常显示，只在整条消息末尾附一句"它干什么用"。
 * 命中一条即停（避免一条日志里出现多个命令时尾巴过长）。 */
var AT_PURPOSE = [
	[/AT\^?SETAUTODIAL\b/i, '设置自动拨号：开关与拨号方式'],
	[/AT\^?NDISSTATQRY\b/i, '查询 USB 网卡数据面状态'],
	[/AT\+CGACT\b/i, '查询/切换数据承载(PDP)激活状态'],
	[/AT\+CGDCONT\b/i, '查询/设置数据承载定义(APN)'],
	[/AT\+CFUN\b/i, '飞行模式(射频开关)'],
	[/AT\+CNMI\b/i, '新短信上报配置'],
	[/AT\+CMGF\b/i, '短信格式(PDU / 文本)'],
	[/AT\+CMEE\b/i, '错误码详细程度'],
	[/AT\+CLIP\b/i, '来电号码显示'],
	[/AT\+CMGS\b/i, '发送短信'],
	[/AT\+CMGL\b/i, '列出短信'],
	[/AT\+CMGR\b/i, '读取短信'],
	[/AT\+CSCA\b/i, '短信中心号码'],
	[/AT\+CSQ\b/i, '查询信号质量'],
	[/AT\^HCSQ\b/i, '查询信号质量(扩展)'],
	[/AT\+COPS\b/i, '运营商选择'],
	[/AT\+CREG\b/i, '查询网络注册状态'],
	[/AT\+CGREG\b/i, '查询分组域注册状态'],
	[/AT\+C5GREG\b/i, '查询 5G 注册状态'],
	[/AT\+CGSN\b/i, '查询 IMEI'],
	[/AT\+CGMR\b/i, '查询固件版本'],
	[/AT\+CGPADDR\b/i, '查询已分配的 IP 地址'],
	[/ATI\b/, '查询模组型号信息'],
	[/AT\^CELLSCAN\b/i, '小区扫频'],
	[/AT\^SETMODE\b/i, 'USB 端口模式'],
	[/AT\^TDCFG\b/i, '网口模式 / 后路由 / DMZ'],
	[/AT\^MONSC\b/i, '服务小区信息'],
	[/AT\^MONNC\b/i, '邻区信息'],
	[/AT\^MCS\b/i, '多载波开关'],
	[/AT\^SIMSQ\b/i, 'SIM 卡信号质量'],
	[/AT\^CHIPTEMP\b/i, '模组温度'],
	[/AT\^FOTA\b/i, '模组固件升级'],
	[/AT\^TDSIMHP\b/i, 'SIM 热插拔开关'],
	[/AT\+CPIN\b/i, '查询 SIM 卡状态']
];

/* 方向识别：把「谁发给谁」单独提出来做徽章，避免只靠文案里的一两个字去猜。
 * 顺序即优先级：先请求、再发送、最后接收。 */
var DIR_RULES = [
	[/^前端请求[:：]\s*/, '请求', 'req'],
	[/^发送\s*(?:→|->)\s*模组[:：]\s*/, '发送', 'tx'],
	[/^接收\s*(?:←|<-)\s*模组[:：]\s*/, '接收', 'rx']
];

function detectDirection(text) {
	var s = String(text);
	for (var i = 0; i < DIR_RULES.length; i++) {
		var m = s.match(DIR_RULES[i][0]);
		if (m) {
			return { label: DIR_RULES[i][1], kind: DIR_RULES[i][2], rest: s.slice(m[0].length) };
		}
	}
	return null;
}

/* 显示前装饰：先做术语中文化，再为消息里的 AT 命令补一句用途 */
function displayText(text) {
	var s = String(text);
	for (var i = 0; i < TEXT_MAP.length; i++) s = s.replace(TEXT_MAP[i][0], TEXT_MAP[i][1]);
	for (var j = 0; j < AT_PURPOSE.length; j++) {
		if (AT_PURPOSE[j][0].test(s)) {
			s += ' （' + AT_PURPOSE[j][1] + '）';
			break;
		}
	}
	return s;
}

/* 类别判定（正则兜底）：按 CATEGORY_RULES 有序匹配，都不命中归 misc。
 * misc 是 Runtime 组的兜底类别，与后端 Category::Misc 同一个语义 —— 见上方规则表的注释。 */
function categorize(msg) {
	for (var i = 0; i < CATEGORY_RULES.length; i++) {
		if (CATEGORY_RULES[i].re.test(msg)) return CATEGORY_RULES[i].key;
	}
	return 'misc';
}

function pad(n, w) {
	var s = String(n);
	while (s.length < w) s = '0' + s;
	return s;
}

function fmtClock(ms) {
	var d = new Date(ms);
	return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3);
}

function fmtFull(ms) {
	var d = new Date(ms);
	return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' + fmtClock(ms);
}

/* 取日期字符串用于分组 */
function dateKey(ms) {
	var d = new Date(ms);
	return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
}

/* 字节数按 KiB 显示：插件日志文件的上限（max_bytes）是字节，直接甩给用户没意义。
 * 不足 1 KiB 时退回 B —— 否则小上限会显示成「0 KiB」，看着像没配。 */
function fmtKiB(bytes) {
	var n = Number(bytes) || 0;
	if (n <= 0) return '0 KiB';
	if (n < 1024) return n + ' B';
	var k = n / 1024;
	return (k >= 100 ? String(Math.round(k)) : String(Math.round(k * 10) / 10)) + ' KiB';
}

/* 只认自己登记过的键。用 hasOwnProperty 而不是直接取值：
 * cat / code 都来自 RPC 与文件内容，万一传来 "constructor" 这种
 * Object.prototype 上的名字，直接取值会拿到一个真值（函数），
 * 于是被当成「已知类别」渲染出一个点不动、也没配色的芯片。 */
function knownCat(map, key) {
	return !!map && typeof key === 'string' && key !== '' &&
		Object.prototype.hasOwnProperty.call(map, key);
}

/* 后端日志：msg 里已经带了业务信息；级别来自宏。
 * 类别优先用后端定好的 cat（服务端在写日志那一刻就知道自己在哪个模块，比前端猜准得多）；
 * cat 缺失或不是已知键（旧后端 / 拼错 / 前端表没跟上）才退回正则兜底，页面照样能分类。
 * knownCats 传的是**当前生效**的类别索引（后端下发清单时会包含前端还没登记的键），
 * 缺省用内置表，保证这个函数单独调用也不会崩。 */
function entriesFromBackend(list, knownCats) {
	var known = knownCats || CATEGORY_DEFS;
	var out = [];
	for (var i = 0; i < list.length; i++) {
		var e = list[i];
		var msg = String(e.msg || '');
		var cat = knownCat(known, e.cat) ? e.cat : categorize(msg);
		out.push({ ts: Number(e.ts) || 0, level: String(e.level || 'INF'), msg: msg, src: 'backend', seq: Number(e.seq) || 0, cat: cat });
	}
	return out;
}

/* syslog 行：两种形态
 *   at-webserver-rust[pid]: 2026-09-18 08:14:35.326 [INF] [RT] 消息      （后端 stdout）
 *   at-webserver: 消息                                             （init.d 的 logger）
 * 级别后面那个 [RT] 是类别短码 —— logger.rs 的 emit() 按「级别 + 类别」两个方括号打印，
 * 与插件日志文件同一套形制。前端不去解析它：后端这类行已由内存环形缓冲提供同一条记录
 * （还带正经的 cat，比短码可靠），所以照旧整段跳过，只取 init.d 那类，避免重复。 */
function entriesFromSyslog(rawList) {
	var out = [];
	for (var i = 0; i < rawList.length; i++) {
		var r = rawList[i] || {};
		var msg = String(r.msg || '');
		if (msg.indexOf('at-webserver') < 0) continue;
		if (msg.indexOf('at-webserver-rust') >= 0) continue;

		var m = msg.match(/^at-webserver(?:\[\d+\])?:\s*([\s\S]*)$/);
		if (!m) continue;
		var text = m[1].trim();
		if (!text) continue;

		var lv = 'INF';
		if (/警告|失败|错误|warn|error/i.test(text)) lv = /错误|失败|error/i.test(text) ? 'ERR' : 'WRN';
		out.push({ ts: Number(r.time) || Date.now(), level: lv, msg: text, src: 'syslog', seq: 0, cat: categorize(text) });
	}
	return out;
}

/* 插件自己的日志文件（logger.rs 写的第三路输出）行格式，一个字符都不能差：
 *   2026-11-08 04:40:01.123 [INF] [SMS] 收到新短信，存储区: ME，索引: 3
 * 业务痕迹不再刷 syslog，重启后内存环形缓冲也是空的，这个文件就是它们唯一的持久历史。
 *
 * 时间戳是**本地时间文本**，不是 epoch。必须自己按字段拆开再
 * new Date(y, m-1, d, H, M, S, ms)：`Date.parse` / `new Date(字符串)` 对这种
 * 「不带时区标记的本地时间」各浏览器口径不一致 —— 有的按 UTC 解、有的直接给 NaN。
 * 按 UTC 解会让整批文件条目平移一个时区，于是排序错位、与内存条目的去重全部落空，
 * 页面表现为「同一句话出现两遍、时间还差好几小时」，极难查。所以这里显式不用它。
 *
 * 消息里的换行后端已经拍平成空格（见 logger.rs::plugin_file_push），
 * 因此「一行一条」是可信的；不匹配的行（追加到一半、被上限截断的头行、格式变更）
 * 一律跳过而不是猜 —— 猜出来的时间戳会把整份排序带歪。 */
var PLUGIN_LINE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[(DBG|INF|WRN|ERR)\] \[([A-Z0-9]+)\] ([\s\S]*)$/;

function entriesFromPluginFile(text, knownCodes) {
	var codes = knownCodes || CATEGORY_CODE;
	var out = [];
	var lines = String(text || '').split('\n');
	for (var i = 0; i < lines.length; i++) {
		var m = lines[i].match(PLUGIN_LINE_RE);
		if (!m) continue;
		var msg = m[10].replace(/\s+$/, '');
		if (!msg) continue;
		var ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
			Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime();
		if (isNaN(ts)) continue;
		/* 文件里只有大写短标签（[SMS]），反查回类别键；查不到才退回正则兜底 */
		var cat = knownCat(codes, m[9]) ? codes[m[9]] : categorize(msg);
		out.push({ ts: ts, level: m[8], msg: msg, src: 'file', seq: 0, cat: cat });
	}
	return out;
}

/* 去重键：时间戳 + 正文。后端一次 emit 会同时写内存环形缓冲与插件文件
 * （见 logger.rs），两边的 ts 与 msg 逐字符一致，只有 seq 是内存那份独有的。
 * 不用 seq 当键正是这个原因：文件行根本没有 seq。 */
function dedupKey(e) {
	return e.ts + '|' + e.msg;
}

return L.view.extend({
	load: function () {
		return L.uci.load('at-webserver').then(function () {
			var logFile = L.uci.get('at-webserver', 'config', 'log_file') || '';
			return { path: logFile || '/tmp/at-notifications.log' };
		}).catch(function () {
			return { path: '/tmp/at-notifications.log' };
		});
	},

	render: function (data) {
		var self = this;
		var page = Mt5700.page('运行日志', '模组拨号事件 · 接口拉起链路 · 异步通知记录实时审计', 'logs', '事件审计 · 运行日志');
		var body = page._body;
		var notifyPath = (data && data.path) || '/tmp/at-notifications.log';

		var state = {
			tab: 'runtime',      /* runtime | notify */
			category: 'all',     /* all | 类别键（见 CAT_TABLE，后端下发清单时以它为准） */
			level: 'all',        /* all | DBG | INF | WRN | ERR | errwrn */
			source: 'all',       /* all | backend | syslog | file */
			limit: 400,          /* 200 | 400 | 800 | 0(全部) */
			query: '',
			auto: true,
			entries: [],         /* 后端内存 + 插件文件 + syslog 合并去重后的全量条目（已分类） */
			notify: '',
			syslogOk: true,
			loading: false,
			catList: [],         /* 当前生效的类别清单（顺序即展示顺序） */
			catByKey: {},        /* key -> 类别定义 */
			catByCode: {},       /* 大写 code -> key：解析插件日志文件用 */
			catSig: '',          /* catList 的签名，变了才重建类别条 DOM */
			pluginFile: null     /* logs RPC 下发的 {enabled, path, max_bytes} */
		};

		/* ---------------- 数据通道 ---------------- */
		/* 每次调用带一个唯一 rid：ucode 侧用它做临时文件名，
		 * 否则并发多个 RPC 会写同一个文件互相覆盖（见 mt5700.uc 的注释）。 */
		var ridSeq = 0;
		function newRid() {
			ridSeq++;
			return String(Date.now()) + '-' + ridSeq + '-' + Math.floor(Math.random() * 1e6);
		}
		/* 注意：LuCI 的 expect 不是"声明要哪些字段"。
		 * 实测 `expect: {seq: 0, entries: []}` 只会把 seq 的**值**返回回来（页面拿到一个数字），
		 * 表现为「ubus 直连明明有日志、页面却显示 0 条」这种极难查的现象。
		 * 统一用 `expect: {}` 取完整结果，再自己取字段。 */
		var rpcLogs = L.rpc.declare({
			object: 'mt5700', method: 'logs',
			params: ['since', 'limit', '_rid'], expect: {}
		});
		var rpcSyslog = L.rpc.declare({
			object: 'log', method: 'read',
			params: ['lines', 'stream', 'oneshot'], expect: {}
		});
		var fileRead = L.rpc.declare({ object: 'file', method: 'read', params: ['path'], expect: {} });
		var fileWrite = L.rpc.declare({ object: 'file', method: 'write', params: ['path', 'data'], expect: {} });

		function readFile(p) {
			if (L.fs && typeof L.fs.read === 'function') return L.fs.read(p);
			return fileRead(p).then(function (r) { return (r && r.data != null) ? r.data : ''; });
		}
		function writeFile(p, content) {
			if (L.fs && typeof L.fs.write === 'function') return L.fs.write(p, content);
			return fileWrite(p, content);
		}

		/* ---------------- 顶部：视图切换 ---------------- */
		var tabs = E('div', { 'class': 'mt5700-logtabs' });
		var TAB_DEFS = [
			{ id: 'runtime', label: '运行日志', icon: '📋' },
			{ id: 'notify', label: '通知记录', icon: '🔔' }
		];
		TAB_DEFS.forEach(function (t) {
			var b = E('div', { 'class': 'mt5700-logtab', 'data-tab': t.id, role: 'tab', tabindex: '0' }, [
				E('span', { 'class': 'mt5700-logtab-icon' }, t.icon),
				E('span', { 'class': 'mt5700-logtab-text' }, t.label)
			]);
			b.addEventListener('click', function () { state.tab = t.id; renderAll(); });
			tabs.appendChild(b);
		});
		body.appendChild(tabs);

		/* ---------------- 类别条（仅运行日志 tab 下显示） ----------------
		 * 21 个类别分两栏：软件运行（Runtime 组，仍写 syslog）/ 业务痕迹（Business 组，
		 * 只进内存缓冲与插件文件）。分栏不是为了好看 —— 它把「这次是软件出事了」
		 * 和「模组在干活」两类完全不同的排障路径在视觉上切开，一屏扫过去就知道该看哪栏。
		 * 「全部」独占最上面一行：它是「不按类别过滤」，不属于任何一个分组。 */
		var catBar = E('div', { 'class': 'mt5700-logcatbar' });
		var catBtns = {};

		/* 类别定义查找：优先当前生效清单（可能含后端新增、前端还没登记标签的键），
		 * 再退回内置表；都没有就直接显示 key —— 宁可露出一个英文键，
		 * 也不能让新类别的日志在界面上凭空消失（logcat.rs::table 的注释也是这个约定）。 */
		function catDef(key) {
			if (knownCat(state.catByKey, key)) return state.catByKey[key];
			if (knownCat(CATEGORY_DEFS, key)) return CATEGORY_DEFS[key];
			return { key: key, code: String(key).toUpperCase(), group: 'runtime', label: key, icon: '🏷️' };
		}
		function catLabel(key) { return catDef(key).label; }

		function makeCatBtn(def) {
			var btn = E('div', {
				'class': 'mt5700-logcatbtn',
				'data-cat': def.key,
				'data-group': def.group,
				role: 'button',
				tabindex: '0',
				title: def.label
			}, [
				E('span', { 'class': 'mt5700-logcatbtn-icon' }, def.icon),
				E('span', { 'class': 'mt5700-logcatbtn-label' }, def.label),
				E('span', { 'class': 'mt5700-logcatbtn-count' }, '0')
			]);
			btn.addEventListener('click', function () { state.category = def.key; renderAll(); });
			return btn;
		}

		/* 整条重建。只在类别清单真的变了时调用（见 applyCatList）——
		 * 自动刷新每 5s 一轮，每轮都重建会把用户正按住的芯片和键盘焦点一起冲掉。 */
		function renderCatBar() {
			catBar.innerHTML = '';
			catBtns = {};

			var allRow = E('div', { 'class': 'mt5700-logcatrow mt5700-logcatrow-all' });
			var allBtn = makeCatBtn(CAT_ALL);
			allRow.appendChild(allBtn);
			catBar.appendChild(allRow);
			catBtns[CAT_ALL.key] = allBtn;

			for (var g = 0; g < CAT_GROUP_DEFS.length; g++) {
				var grp = CAT_GROUP_DEFS[g];
				var defs = [];
				for (var i = 0; i < state.catList.length; i++) {
					if (state.catList[i].group === grp.key) defs.push(state.catList[i]);
				}
				if (!defs.length) continue;   /* 该组一个类别都没有时不留空栏 */
				var row = E('div', { 'class': 'mt5700-logcatrow' });
				for (var j = 0; j < defs.length; j++) {
					var btn = makeCatBtn(defs[j]);
					row.appendChild(btn);
					catBtns[defs[j].key] = btn;
				}
				catBar.appendChild(E('div', { 'class': 'mt5700-logcatgroup mt5700-logcatgroup-' + grp.key }, [
					E('span', { 'class': 'mt5700-logcatgroup-label', title: grp.title }, grp.label),
					row
				]));
			}
		}

		/* 换上新的类别清单，并重建两张反查表 */
		function applyCatList(list) {
			var sig = '';
			for (var i = 0; i < list.length; i++) sig += list[i].key + '/' + list[i].group + ',';
			if (sig === state.catSig) return;
			state.catSig = sig;
			state.catList = list;
			state.catByKey = {};
			state.catByCode = {};
			for (var j = 0; j < list.length; j++) {
				state.catByKey[list[j].key] = list[j];
				state.catByCode[list[j].code] = list[j].key;
			}
			/* 选中的类别被后端摘掉时退回「全部」：否则列表会永远空着，
			 * 而芯片栏里一个高亮都没有，用户看不出是筛选条件失效了。 */
			if (state.category !== 'all' && !knownCat(state.catByKey, state.category)) state.category = 'all';
			renderCatBar();
		}

		/* 后端下发的 categories → 展示用清单：顺序与分组以后端为准（它才知道自己有哪些类别），
		 * 标签与图标取前端内置表（后端刻意不下发中文，见 logcat.rs::table）。 */
		function catListFromBackend(list) {
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var c = list[i] || {};
				var key = String(c.key || '');
				if (!key || key === CAT_ALL.key) continue;   /* all 是前端概念，后端不该发；发了也当没有 */
				var known = knownCat(CATEGORY_DEFS, key) ? CATEGORY_DEFS[key] : null;
				var group = (c.group === 'runtime' || c.group === 'business')
					? c.group : (known ? known.group : 'runtime');
				out.push({
					key: key,
					code: String(c.code || (known ? known.code : key.toUpperCase())),
					group: group,
					label: known ? known.label : key,
					icon: known ? known.icon : '🏷️'
				});
			}
			return out;
		}

		applyCatList(CAT_TABLE.slice());
		body.appendChild(catBar);

		/* ---------------- 工具栏 ---------------- */

		/* 下拉的外观用内联样式确保稳定生效，并契合 Soft Anime 紫色调调色板
		 * （本页三处下拉共用；withFocus 为 true 时附加 focus/blur 高亮） */
		function stylePurpleSelect(el, withFocus) {
			if (!el) return;
			var ARROW = "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' "
				+ "viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.75L6 8.25L9.5 4.75' fill='none' stroke='%238b5cf6' "
				+ "stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
			var BG_CLOSED = 'rgba(139,92,246,0.08)';
			var BG_HOVER = 'rgba(139,92,246,0.15)';
			var base = {
				'-webkit-appearance': 'none', '-moz-appearance': 'none', 'appearance': 'none',
				'background': BG_CLOSED + ' ' + ARROW + ' no-repeat right 10px center',
				'background-size': '12px 12px',
				'padding': '0 32px 0 14px',
				'border': '1px solid rgba(139,92,246,0.28)',
				'border-radius': '10px',
				'color': '#8b5cf6',
				'font-weight': '500',
				'font-size': '13px',
				'height': '36px',
				'line-height': '36px',
				'box-shadow': 'none',
				'text-shadow': 'none',
				'cursor': 'pointer'
			};
			Object.keys(base).forEach(function (k) { el.style.setProperty(k, base[k], 'important'); });
			el.addEventListener('mouseenter', function () { el.style.setProperty('background-color', BG_HOVER, 'important'); });
			el.addEventListener('mouseleave', function () { el.style.setProperty('background-color', BG_CLOSED, 'important'); });
			if (withFocus) {
				el.addEventListener('focus', function () {
					el.style.setProperty('border-color', '#8b5cf6', 'important');
					el.style.setProperty('box-shadow', '0 0 0 3px rgba(139,92,246,0.20)', 'important');
				});
				el.addEventListener('blur', function () {
					el.style.setProperty('border-color', 'rgba(139,92,246,0.28)', 'important');
					el.style.setProperty('box-shadow', 'none', 'important');
				});
			}
		}

		var levelSel = Mt5700.select([
			{ label: '全部级别', value: 'all' },
			{ label: '仅调试', value: 'DBG' },
			{ label: '仅信息', value: 'INF' },
			{ label: '仅警告', value: 'WRN' },
			{ label: '仅错误', value: 'ERR' }
		], 'all');
		stylePurpleSelect(levelSel, true);
		levelSel.addEventListener('change', function () {
			state.level = levelSel.value;
			if (errWrnChk.checked) {
				errWrnChk.checked = false; /* 级别接管过滤，同步清除快捷开关，避免 UI 谎报过滤状态 */
			}
			renderList();
		});

		/* 仅看错误+警告 快捷开关 */
		var errWrnChk = E('input', { type: 'checkbox' });
		errWrnChk.addEventListener('change', function () {
			if (errWrnChk.checked) {
				state.level = 'errwrn';
				levelSel.value = 'all'; /* 下拉回到「全部级别」，由 checkbox 接管 */
			} else {
				state.level = 'all';
			}
			renderList();
		});
		var errWrnWrap = E('label', { 'class': 'mt5700-logerrwrn' }, [errWrnChk, E('span', {}, '仅错误+警告')]);

		/* 来源下拉：三路真实来源。插件文件那一路是业务痕迹的持久副本，
		 * 重启后内存缓冲清空，只有它还留着历史（见 refresh 里的 readPluginFile）。 */
		var srcSel = Mt5700.select([
			{ label: SRC_LABEL.all, value: 'all' },
			{ label: SRC_LABEL.backend, value: 'backend' },
			{ label: SRC_LABEL.syslog, value: 'syslog' },
			{ label: SRC_LABEL.file, value: 'file' }
		], 'all');
		stylePurpleSelect(srcSel);
		srcSel.addEventListener('change', function () { state.source = srcSel.value; renderList(); });

		/* 条数上限下拉 */
		var limitSel = Mt5700.select([
			{ label: '最新 200 条', value: '200' },
			{ label: '最新 400 条', value: '400' },
			{ label: '最新 800 条', value: '800' },
			{ label: '全部', value: '0' }
		], '400');
		stylePurpleSelect(limitSel);
		limitSel.addEventListener('change', function () { state.limit = Number(limitSel.value); renderList(); });

		var searchInput = Mt5700.input('text', '按关键词过滤，如 拨号 / eth2 / 警告', '');
		searchInput.addEventListener('input', function () { state.query = searchInput.value.trim(); renderList(); });

		var autoChk = E('input', { type: 'checkbox' });
		autoChk.checked = true;
		autoChk.addEventListener('change', function () {
			state.auto = autoChk.checked;
			if (state.auto) schedule();
		});

		/* 自写按钮：不依赖主题的 button / ghostButton，避免被全局样式改变观感 */
		function logButton(label, onClick, variant, icon) {
			var cls = 'mt5700-logbtn' + (variant ? ' mt5700-logbtn-' + variant : '');
			var content = [];
			if (icon) content.push(E('span', { 'class': 'mt5700-logbtn-icon' }, icon));
			content.push(E('span', {}, label));
			var b = E('div', { 'class': cls, role: 'button', tabindex: '0', title: label }, content);
			b.addEventListener('click', onClick);
			b.addEventListener('keydown', function (ev) {
				if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick(ev); }
			});
			return b;
		}

		var toolbar = E('div', { 'class': 'mt5700-logtoolbar' });
		toolbar.appendChild(E('div', { 'class': 'mt5700-logsearch' }, [searchInput]));
		toolbar.appendChild(E('div', { 'class': 'mt5700-logselect' }, [levelSel]));
		toolbar.appendChild(errWrnWrap);
		toolbar.appendChild(E('div', { 'class': 'mt5700-logselect' }, [srcSel]));
		toolbar.appendChild(E('div', { 'class': 'mt5700-logselect' }, [limitSel]));
		var autoWrap = E('label', { 'class': 'mt5700-logauto' }, [autoChk, E('span', {}, '自动刷新')]);
		toolbar.appendChild(autoWrap);
		toolbar.appendChild(logButton('刷新', function () { refresh(true); }, 'primary', '↻'));
		toolbar.appendChild(logButton('导出', function () { exportLog(); }, 'accent', '⤓'));
		body.appendChild(toolbar);

		/* ---------------- 日志主体 ---------------- */
		/* 不再用 Mt5700.card：页头已有大标题，卡片再套一个「日志」标题属于重复，
		 * 且卡片自带的内边距与日志列表需要的紧凑排版不搭。 */
		var panel = E('div', { 'class': 'mt5700-logpanel' });
		body.appendChild(panel);

		var hint = E('div', { 'class': 'mt5700-logpanel-hint' }, '');
		panel.appendChild(hint);

		var listEl = E('div', { 'class': 'mt5700-loglist' });
		panel.appendChild(listEl);

		var footer = E('div', { 'class': 'mt5700-logfooter' }, '');
		panel.appendChild(footer);

		var clearRow = E('div', { 'class': 'mt5700-logactions' });
		var clearBtn = logButton('清空通知日志', function () { clearNotify(); }, 'danger', '🗑️');
		clearRow.appendChild(clearBtn);
		panel.appendChild(clearRow);

		/* ---------------- 过滤与统计 ---------------- */
		/* skipCategory 为 true 时不做类别过滤（供类别计数联动使用） */
		function applyFilters(list, skipCategory) {
			var q = state.query.toLowerCase();
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var e = list[i];
				/* 类别过滤 */
				if (!skipCategory && state.category !== 'all' && e.cat !== state.category) continue;
				/* 来源过滤 */
				if (state.source !== 'all' && e.src !== state.source) continue;
				/* 级别过滤 */
				if (state.level === 'errwrn') {
					if (e.level !== 'ERR' && e.level !== 'WRN') continue;
				} else if (state.level !== 'all') {
					if (e.level !== state.level) continue;
				}
				/* 关键词过滤（按原文匹配） */
				if (q && e.msg.toLowerCase().indexOf(q) < 0) continue;
				out.push(e);
			}
			return out;
		}

		/* 计算未过滤时的各类别总数。
		 * 桶按当前生效的类别清单开，而不是写死一份字面量：写死的话后端每加一个类别
		 * 都得记着回来同步，漏改的表现是新类别芯片恒显示 0，
		 * 看着像「这个类别没有日志」，而不是「计数没接上」。 */
		function computeCategoryTotals(allEntries) {
			var totals = { all: allEntries.length };
			for (var k = 0; k < state.catList.length; k++) totals[state.catList[k].key] = 0;
			for (var i = 0; i < allEntries.length; i++) {
				var c = allEntries[i].cat;
				if (totals[c] !== undefined) totals[c]++;
			}
			return totals;
		}

		/* 必须始终返回 Node：早期实现里"没有搜索词就 return text（字符串）"，
		 * 而调用方是 appendChild —— 一旦有日志行要渲染就抛
		 * "parameter 1 is not of type 'Node'"，整个列表渲染中断，
		 * 表现为「RPC 有数据、页面却连空状态都没有」。 */
		function highlight(text) {
			var s = String(text);
			if (!state.query) return document.createTextNode(s);
			var q = state.query.toLowerCase();
			var idx = s.toLowerCase().indexOf(q);
			if (idx < 0) return document.createTextNode(s);
			var frag = document.createDocumentFragment();
			var rest = s;
			while (true) {
				idx = rest.toLowerCase().indexOf(q);
				if (idx < 0) { frag.appendChild(document.createTextNode(rest)); break; }
				if (idx > 0) frag.appendChild(document.createTextNode(rest.slice(0, idx)));
				var mk = document.createElement('mark');
				mk.textContent = rest.slice(idx, idx + q.length);
				frag.appendChild(mk);
				rest = rest.slice(idx + q.length);
			}
			return frag;
		}

		/* ---------------- 渲染 ---------------- */
		function renderList() {
			listEl.innerHTML = '';
			footer.innerHTML = '';

			if (state.tab === 'notify') { renderNotify(); return; }

			var all = state.entries;
			/* 先按级别/关键词/来源过滤（不过滤类别，类别用于计数） */
			var filteredForCounts = applyFilters(all, true);
			var totals = computeCategoryTotals(filteredForCounts);

			/* 更新类别条计数 */
			updateCatBar(totals, computeCategoryTotals(all));

			/* 再按类别过滤 */
			var list = applyFilters(all);

			if (!all.length) {
				listEl.appendChild(emptyBox(
					'暂无运行日志',
					'服务连上模组后会自动记录拨号对齐、AT 通道交互、短信收发、接口拉起与系统事件。'));
			} else if (!list.length) {
				/* 局部变量不能叫 catLabel：那会盖掉同名的类别名查找函数，
				 * 于是这里第一次调用就抛 "catLabel is not a function"，整个列表渲染中断。 */
				var catName = state.category === 'all' ? '' : '（' + catLabel(state.category) + '）';
				listEl.appendChild(emptyBox('没有匹配的日志' + catName, '试试清空关键词、切换类别，或把级别切回「全部级别」。'));
			} else {
				var frag = document.createDocumentFragment();
				/* 条数上限 */
				var shown = (state.limit > 0 && list.length > state.limit) ? list.slice(list.length - state.limit) : list;
				var lastDate = '';
				for (var i = 0; i < shown.length; i++) {
					/* 日期分组分隔行 */
					var dk = dateKey(shown[i].ts);
					if (dk !== lastDate) {
						frag.appendChild(renderDateSeparator(dk));
						lastDate = dk;
					}
					frag.appendChild(renderRow(shown[i]));
				}
				listEl.appendChild(frag);
				/* 这里不能直接量：首次 render() 时页面还没被 LuCI 插进 #view，
				 * 脱离文档的节点高度全是 0，会把每条折叠都误判成「没溢出」。
				 * 推迟一个宏任务，等 DOM 落进文档再量。 */
				setTimeout(relaxFalseClamps, 0);
			}

			/* 折叠按钮只该在「正文真的被裁掉了」时出现。
			 * renderRow 按字符数（>160）先打上折叠类，但宽屏上一条两百字的正文
			 * 可能三行就排完了 —— 这时按钮点开看不到任何变化，属于假折叠。
			 * DOM 进了文档之后再量一次：没溢出就把折叠态和按钮一起摘掉。 */
			function relaxFalseClamps() {
				var clamped = listEl.querySelectorAll('.mt5700-logmsg-clamped');
				for (var j = 0; j < clamped.length; j++) {
					var msgEl = clamped[j];
					if (msgEl.scrollHeight <= msgEl.clientHeight + 1) {
						msgEl.classList.remove('mt5700-logmsg-clamped');
						var btnEl = msgEl.querySelector('.mt5700-logexpand');
						if (btnEl && btnEl.parentNode) btnEl.parentNode.removeChild(btnEl);
					}
				}
			}

			/* footer 统计 */
			renderFooter(all, list);
		}

		/* 更新类别条按钮的计数与激活状态。
		 * 遍历的是「全部 + 当前生效类别清单」，与 renderCatBar 建芯片时同一份数据，
		 * 两边不会各说各话（清单来自后端时更要如此）。 */
		function updateCatBar(filteredCounts, totalCounts) {
			var hasFilter = state.level !== 'all' || state.source !== 'all' || state.query !== '';
			var defs = [CAT_ALL].concat(state.catList);
			defs.forEach(function (c) {
				var btn = catBtns[c.key];
				if (!btn) return;
				var countEl = btn.querySelector('.mt5700-logcatbtn-count');
				if (countEl) {
					if (hasFilter) {
						countEl.textContent = filteredCounts[c.key] + ' / ' + totalCounts[c.key];
					} else {
						countEl.textContent = String(totalCounts[c.key]);
					}
				}
				/* 激活状态 */
				if (state.category === c.key) {
					btn.classList.add('active');
				} else {
					btn.classList.remove('active');
				}
			});
		}

		/* 日期分隔行 */
		function renderDateSeparator(dateStr) {
			return E('div', { 'class': 'mt5700-logday' }, [
				E('span', { 'class': 'mt5700-logday-text' }, dateStr)
			]);
		}

		function emptyBox(title, desc) {
			var box = E('div', { 'class': 'mt5700-logempty' });
			box.appendChild(E('div', { 'class': 'mt5700-logempty-title' }, title));
			box.appendChild(E('div', { 'class': 'mt5700-logempty-desc' }, desc));
			return box;
		}

		function renderRow(e) {
			var lv = e.level || 'INF';
			var cls = lv === 'ERR' ? 'err' : (lv === 'WRN' ? 'warn' : (lv === 'DBG' ? 'dbg' : 'info'));
			var row = E('div', {
				'class': 'mt5700-logrow mt5700-logrow-' + cls,
				'data-cat': e.cat || 'misc',
				'data-level': lv,
				'data-src': e.src || 'backend'
			});
			var d = new Date(e.ts);
			var timeEl = E('span', { 'class': 'mt5700-logtime', title: fmtFull(e.ts) }, [
				pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2),
				E('span', { 'class': 'mt5700-logms' }, '.' + pad(d.getMilliseconds(), 3))
			]);
			row.appendChild(timeEl);
			row.appendChild(E('span', { 'class': 'mt5700-loglv', title: lv }, LEVEL_LABEL[lv] || lv));

			/* 类别小徽章 */
			var catKey = e.cat || 'misc';
			row.appendChild(E('span', {
				'class': 'mt5700-logcat mt5700-logcat-' + catKey,
				title: catLabel(catKey)
			}, catLabel(catKey)));

			var dir = detectDirection(e.msg);
			if (dir) {
				var dirIcon = dir.kind === 'tx' ? '↑ ' : (dir.kind === 'rx' ? '↓ ' : '→ ');
				row.appendChild(E('span', { 'class': 'mt5700-logdir mt5700-logdir-' + dir.kind, title: dir.kind === 'tx' ? '本机发给模组' : (dir.kind === 'rx' ? '模组回给本机' : '页面发给后端') }, dirIcon + dir.label));
			}

			var msg = E('span', { 'class': 'mt5700-logmsg' });
			var textToRender = displayText(dir ? dir.rest : e.msg);
			var pIdx = textToRender.indexOf(' （');
			if (pIdx > 0 && textToRender.slice(-1) === '）') {
				var mainText = textToRender.slice(0, pIdx);
				var purposeText = textToRender.slice(pIdx);
				msg.appendChild(highlight(mainText));
				msg.appendChild(E('span', { 'class': 'mt5700-logpurpose' }, purposeText));
			} else {
				msg.appendChild(highlight(textToRender));
			}

			/* 超长消息折叠：正文超过约 160 字符时默认折叠 */
			var rawLen = (dir ? dir.rest : e.msg).length;
			if (rawLen > 160) {
				msg.classList.add('mt5700-logmsg-clamped');
				var expandBtn = E('span', { 'class': 'mt5700-logexpand', role: 'button', tabindex: '0' }, '展开');
				expandBtn.addEventListener('click', function () {
					var clamped = msg.classList.toggle('mt5700-logmsg-clamped');
					expandBtn.textContent = clamped ? '展开' : '收起';
				});
				expandBtn.addEventListener('keydown', function (ev) {
					if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); expandBtn.click(); }
				});
				msg.appendChild(expandBtn);
			}

			row.appendChild(msg);
			/* 行尾来源徽章：后端内存那一路不打徽章（它是默认来源，打了满屏都是噪声），
			 * 另外两路都打 —— 看日志时「这行是系统日志里的、还是插件文件里翻出来的」
			 * 直接决定它可不可信（syslog 行没有毫秒与类别，插件文件行可能来自上一次运行）。 */
			if (e.src === 'syslog') {
				row.appendChild(E('span', { 'class': 'mt5700-logsrc', title: '来自 syslog（init.d / 内核）' }, '系统'));
			} else if (e.src === 'file') {
				row.appendChild(E('span', {
					'class': 'mt5700-logsrc mt5700-logsrc-file',
					title: '来自插件日志文件（业务痕迹的持久副本，重启前的历史也在这里）'
				}, '文件'));
			}
			return row;
		}

		/* 底部「顶部/底部」滚动按钮（运行日志与通知记录两个页签共用） */
		function buildScrollActions() {
			return E('span', { 'class': 'mt5700-logfooter-actions' }, [
				E('button', {
					'class': 'mt5700-logscroll-btn',
					'type': 'button',
					'title': '滚动到顶部',
					'click': function () { listEl.scrollTo({ top: 0, behavior: 'smooth' }); }
				}, '↑ 顶部'),
				E('button', {
					'class': 'mt5700-logscroll-btn',
					'type': 'button',
					'title': '滚动到底部',
					'click': function () { listEl.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' }); }
				}, '↓ 底部')
			]);
		}

		function renderFooter(all, filtered) {
			/* 统计各级别数量 */
			var errCount = 0, wrnCount = 0, infCount = 0, dbgCount = 0;
			for (var i = 0; i < all.length; i++) {
				if (all[i].level === 'ERR') errCount++;
				else if (all[i].level === 'WRN') wrnCount++;
				else if (all[i].level === 'DBG') dbgCount++;
				else infCount++;
			}
			var text = '共 ' + all.length + ' 条 · 错误 ' + errCount + ' · 警告 ' + wrnCount + ' · 信息 ' + infCount + ' · 调试 ' + dbgCount;
			if (filtered.length !== all.length) text += ' · 过滤后 ' + filtered.length + ' 条';
			if (state.limit > 0 && filtered.length > state.limit) text += ' · 仅显示最新 ' + state.limit + ' 条';
			/* 业务日志的持久副本落在哪：syslog 里已经没有它们了，不写出路径与上限，
			 * 用户面对「重启后历史还剩多少」只能靠猜。仅在后端确实在写这个文件时显示。 */
			var pf = state.pluginFile;
			if (pf && pf.enabled && pf.path) {
				text += ' · 业务日志文件：' + pf.path + '（上限 ' + fmtKiB(pf.max_bytes) + '）';
			}
			if (!state.syslogOk) text += ' · syslog 不可读';

			var footerStats = E('span', { 'class': 'mt5700-logfooter-text' }, text);
			footer.appendChild(footerStats);
			footer.appendChild(buildScrollActions());
		}

		function renderNotify() {
			var content = state.notify || '';
			var lines = content.replace(/\s+$/, '').split('\n').filter(function (l) { return l.trim() !== ''; });
			if (!lines.length) {
				listEl.appendChild(emptyBox('暂无通知记录', '短信、来电、信号变化与存储告警会写入此文件。'));
				footer.appendChild(E('span', { 'class': 'mt5700-logfooter-text' }, '文件：' + notifyPath));
				return;
			}
			var frag = document.createDocumentFragment();
			var shown = lines.length > 400 ? lines.slice(lines.length - 400) : lines;
			for (var i = 0; i < shown.length; i++) {
				var line = shown[i];
				var lv = /错误|失败|error/i.test(line) ? 'ERR' : (/警告|warn/i.test(line) ? 'WRN' : 'INF');
				var cls = lv === 'ERR' ? 'err' : (lv === 'WRN' ? 'warn' : 'info');
				var row = E('div', { 'class': 'mt5700-logrow mt5700-logrow-' + cls });
				row.appendChild(E('span', { 'class': 'mt5700-loglv', title: lv }, LEVEL_LABEL[lv] || lv));
				var msg = E('span', { 'class': 'mt5700-logmsg' });
				msg.appendChild(highlight(displayText(line)));
				row.appendChild(msg);
				frag.appendChild(row);
			}
			listEl.appendChild(frag);

			var footerStats = E('span', { 'class': 'mt5700-logfooter-text' }, '共 ' + lines.length + ' 条 · 文件：' + notifyPath);
			footer.appendChild(footerStats);
			footer.appendChild(buildScrollActions());
		}

		function renderAll() {
			var btns = tabs.querySelectorAll('.mt5700-logtab');
			for (var i = 0; i < btns.length; i++) {
				var on = btns[i].getAttribute('data-tab') === state.tab;
				btns[i].className = 'mt5700-logtab' + (on ? ' active' : '');
			}

			/* 通知记录 tab 下：隐藏类别条、禁用过滤控件 */
			var isNotify = (state.tab === 'notify');
			catBar.style.display = isNotify ? 'none' : '';
			levelSel.disabled = isNotify;
			errWrnChk.disabled = isNotify;
			errWrnWrap.style.display = isNotify ? 'none' : '';
			srcSel.disabled = isNotify;
			limitSel.disabled = isNotify;
			searchInput.disabled = isNotify;
			clearRow.style.display = isNotify ? '' : 'none';

			/* hint 文案 */
			if (isNotify) {
				hint.textContent = '通知文件内容（短信、来电、信号变化、存储告警）。';
			} else {
				hint.textContent = '业务痕迹（AT 通道 / 短信 / 拨号 / 信号 / SIM …）来自后端内存环形缓冲 + 插件日志文件，不再写入 syslog；syslog 只剩 init.d 输出与后端自身的运行 / 错误行。按类别筛选，关键词按原文匹配。';
			}

			renderList();
		}

		/* ---------------- 取数 ---------------- */
		/* 插件日志文件：业务痕迹的持久副本（syslog 里已经没有它们了）。
		 * 用与通知文件同一套 readFile 机制（L.fs.read，无则退回 file RPC）。
		 * 关掉或没给路径时直接跳过：既不发起读取，也不在界面上留一个空来源。 */
		function readPluginFile() {
			var pf = state.pluginFile;
			if (!pf || !pf.enabled || !pf.path) {
				state._fileEntries = [];
				return Promise.resolve();
			}
			return readFile(pf.path).then(function (c) {
				state._fileEntries = entriesFromPluginFile(c || '', state.catByCode);
			}).catch(function () {
				state._fileEntries = [];   /* 读不到（无权限 / 文件还没生成）＝没有历史，不是错误 */
			});
		}

		function refresh(manual) {
			if (state.loading) return Promise.resolve();
			state.loading = true;

			var tasks = [];
			/* 后端内存日志：一次取全量（上限 1200），类别优先用后端定好的 cat */
			/* 各路取数**串行**执行：ucode 转发用的是临时文件，并发会互相覆盖。
			 * 新版 ucode 已用唯一文件名解决，这里串行是为了兼容存量设备，双保险。 */
			var logsTask = rpcLogs(0, 1200, newRid()).then(function (r) {
				/* 类别清单必须先落地：entriesFromBackend 要靠它判断 cat 是不是已知键，
				 * 顺序反了会把后端新类别的日志统统丢回正则兜底去猜。 */
				var cats = (r && r.categories) || [];
				if (cats.length) applyCatList(catListFromBackend(cats));
				state.pluginFile = (r && r.plugin_file) || null;
				state._backendEntries = entriesFromBackend((r && r.entries) || [], state.catByKey);
			}).catch(function (err) {
				state._backendEntries = [{ ts: Date.now(), level: 'ERR', msg: '读取后端日志失败：' + ((err && err.message) || '未知错误'), cat: 'misc', src: 'backend', seq: 0 }];
				state.pluginFile = null;   /* 后端不在就别说「业务日志文件在哪」，那是假信息 */
			});
			tasks.push(logsTask);

			/* 插件日志文件：路径只有拿到 logs 结果才知道，因此这一步挂在 logsTask 后面，
			 * 不与它抢跑 —— 抢跑就得把路径硬编码在前端，配置一改就读错文件。 */
			tasks.push(logsTask.then(function () { return readPluginFile(); }));

			/* init.d 日志：走 syslog；无权限或不可用时降级，不影响其它视图 */
			tasks.push(rpcSyslog(1500, false, true).then(function (r) {
				/* syslog 行永远不带 cat（那是后端内存条目才有的字段），只能走正则兜底 */
				state._syslogEntries = entriesFromSyslog((r && r.log) || []);
				state.syslogOk = true;
			}).catch(function () {
				state._syslogEntries = [];
				state.syslogOk = false;
			}));

			/* 通知文件 */
			tasks.push(readFile(notifyPath).then(function (c) {
				state.notify = c || '';
			}).catch(function () {
				state.notify = '';
			}));

			/* 串行执行（见上） */
			return tasks.reduce(function (p, t) { return p.then(function () { return t; }); }, Promise.resolve()).then(function () {
				/* 合并三路，按时间排序。
				 * 文件条目要先过一道去重：后端一次 emit 同时写内存与文件（logger.rs），
				 * 不去重就会看到每句话都出现两遍。键是 ts + '|' + msg（见 dedupKey），
				 * 撞键时**留内存那份** —— 它有真实 seq。
				 * 方向是单向的：只丢「文件条目撞上内存条目」，反过来绝不丢。
				 * 文件独有的行正是重启前的历史，读这个文件的全部意义就在于此，
				 * 把它们一并去重掉等于白读一趟。 */
				var back = state._backendEntries || [];
				var merged = back.concat(state._syslogEntries || []);
				var seen = {};
				for (var i = 0; i < back.length; i++) seen[dedupKey(back[i])] = true;
				var fromFile = state._fileEntries || [];
				for (var j = 0; j < fromFile.length; j++) {
					if (seen[dedupKey(fromFile[j])]) continue;
					merged.push(fromFile[j]);
				}
				merged.sort(function (a, b) { return a.ts - b.ts; });
				state.entries = merged;
				state.loading = false;
				renderAll();
				if (manual) Mt5700.success('日志已刷新');
			}, function () {
				state.loading = false;
			});
		}

		function exportLog() {
			var list;
			if (state.tab === 'notify') {
				list = [{ ts: Date.now(), level: 'INF', msg: state.notify || '' }];
			} else {
				list = applyFilters(state.entries);
				if (state.limit > 0 && list.length > state.limit) {
					list = list.slice(list.length - state.limit);
				}
			}
			var lines = [];
			lines.push('# luci-app-mt5700 运行日志导出');
			lines.push('# 视图: ' + state.tab + '  导出时间: ' + fmtFull(Date.now()));
			if (state.tab === 'runtime') {
				lines.push('# 类别: ' + catLabel(state.category));
				lines.push('# 来源: ' + (SRC_LABEL[state.source] || state.source));
			}
			lines.push('');
			for (var i = 0; i < list.length; i++) {
				var e = list[i];
				/* 类别用大写短标签（[SMS]）而不是中文：与插件日志文件的行格式对齐
				 * （见 logger.rs::plugin_file_push），导出的文本因此还能按列扫、按 code grep，
				 * 也不随界面语言变。通知记录那一路没有类别概念，不加这一段（保持原样）。 */
				var catSeg = e.cat ? ' [' + catDef(e.cat).code + ']' : '';
				lines.push(fmtFull(e.ts) + ' [' + e.level + ']' + catSeg + ' ' + e.msg);
			}
			var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
			var url = URL.createObjectURL(blob);
			var a = document.createElement('a');
			a.href = url;
			a.download = 'mt5700-log-' + state.tab + '-' + Date.now() + '.txt';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
		}

		function clearNotify() {
			Mt5700.confirm('确定清空通知日志？', function () {
				return writeFile(notifyPath, '').then(function () {
					Mt5700.success('通知日志已清空');
					state.notify = '';
					renderList();
				}).catch(function () {
					return fileWrite(notifyPath, '').then(function () {
						Mt5700.success('通知日志已清空');
						state.notify = '';
						renderList();
					}).catch(function (e2) {
						Mt5700.error('清空失败：' + ((e2 && e2.message) || '未知错误'));
					});
				});
			});
		}

		/* ---------------- 自动刷新 ---------------- */
		var timer = null;
		function schedule() {
			if (timer) { clearInterval(timer); timer = null; }
			if (state.auto) timer = setInterval(function () {
				if (document.hidden) return;   /* 页面不可见时不刷，省设备资源 */
				refresh(false);
			}, 5000);
		}

		refresh(false).then(schedule);
		/* 离开本页（hash 路由切换）时停掉自动刷新；LuCI view 无 dispose 钩子，_dispose 从不执行 */
		Ui.onLeave(function () { if (timer) clearInterval(timer); });

		return page;
	}
});
