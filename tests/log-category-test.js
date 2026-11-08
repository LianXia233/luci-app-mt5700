'use strict';
/**
 * 日志类别跨层对账（后端 logcat.rs ↔ 前端 logs.js ↔ mt5700.css）
 *
 * 为什么要这个测试：同一张类别表被复制在三处 —— Rust 枚举（key / code / group）、
 * 前端 logs.js 的 CAT_TABLE（label / icon）、mt5700.css 的徽章配色。
 * 后端加了类别而前端漏补，表现是「新类别的日志在页面上没有筛选按钮、徽章没有颜色」，
 * 不报错、不崩溃，属于静默降级 —— 正是最难被发现的那一类。
 *
 * 因此这里**从源码解析**三张表逐键对账，测试内部不再抄一份期望表：
 * 抄一份等于把「两边一起漂移」也判成通过，测试就白写了。
 * 前端那张表也不是用正则从文本里抠，而是把 logs.js 的模块头真的加载进 Node
 * 跑一遍（沿用 parse-regression-test.js 的做法）—— 顺带把分类与文件解析也验了，
 * 而且前端改了写法（换行、加字段）不会让测试假失败。
 *
 * 覆盖：
 *   1) logcat.rs：key() / code() / group() 的 match 臂 + ALL，得到后端权威表；
 *   2) logs.js：每个后端键都有中文标签与图标；前端没有孤儿键；code / group / 顺序一致；
 *      `all` 只存在于前端芯片列表，不是后端类别；
 *   3) 正则兜底表 CATEGORY_RULES 能产出全部新键（misc 除外，它是兜底返回值）；
 *   4) 插件日志文件解析：绝对毫秒优先、旧格式退回本地时间逐字段还原、code 反查类别、坏行跳过；
 *   5) mt5700.css：21 条浅色徽章配色 + 21 条 .at-dark 变体 + 分组类别条与文件来源徽章样式；
 *   6) MT5700_CSS_VERSION 已从 2.46.8 递增；
 *   7) 改动过的文件保持 LF、无行尾空白。
 *
 * 运行：node tests/log-category-test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = function (rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); };

const LOGCAT_RS = 'src/rust/src/logcat.rs';
const LOGGER_RS = 'src/rust/src/logger.rs';
const LOGS_JS = 'htdocs/luci-static/resources/view/at-webserver/logs.js';
const MT_CSS = 'htdocs/luci-static/resources/at-webserver/mt5700.css';
const MT_JS = 'htdocs/luci-static/resources/at-webserver/mt5700.js';

const logcatRs = read(LOGCAT_RS);
const loggerRs = read(LOGGER_RS);
const logsJs = read(LOGS_JS);
const mtCss = read(MT_CSS);
const mtJs = read(MT_JS);

const results = [];
function check(name, ok, detail) {
	results.push({ name: name, ok: !!ok, detail: detail || '' });
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  ← ' + detail));
}
function failOut() {
	const failed = results.filter(function (r) { return !r.ok; });
	console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' + results.length
		: 'ALL ' + results.length + ' PASSED'));
	process.exit(failed.length ? 1 : 0);
}

/* ---------- 1) 后端权威表：从 Rust 源码解析 ---------- */

/* 取一个 Rust 函数的完整函数体（大括号配平）。
 * 不能整文件正则：impl Group 与 impl Category 各有一个 key()，
 * 全文匹配会把两处的 match 臂混成一锅，分组名就成了类别名。 */
function rustFnBody(src, signature, from) {
	const start = src.indexOf(signature, from || 0);
	if (start < 0) return null;
	const open = src.indexOf('{', start);
	if (open < 0) return null;
	let depth = 0;
	for (let j = open; j < src.length; j++) {
		if (src[j] === '{') depth++;
		else if (src[j] === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, j);
		}
	}
	return null;
}

const implCat = logcatRs.indexOf('impl Category {');
const implGroup = logcatRs.indexOf('impl Group {');
check('logcat.rs 里找得到 impl Category / impl Group', implCat > 0 && implGroup > 0,
	'impl Category@' + implCat + ' impl Group@' + implGroup);

/* Group::key() —— 分组的小写标识（runtime / business） */
const groupKeyBody = rustFnBody(logcatRs, 'pub fn key(self)', implGroup) || '';
const groupKeyOf = {};
let gk;
const RE_GROUP_KEY = /Group::(\w+)\s*=>\s*"([^"]+)"/g;
while ((gk = RE_GROUP_KEY.exec(groupKeyBody)) !== null) groupKeyOf[gk[1]] = gk[2];
check('Group::key() 解析出 runtime / business 两个分组标识',
	groupKeyOf.Runtime === 'runtime' && groupKeyOf.Business === 'business', JSON.stringify(groupKeyOf));

/* Category::key() / code() —— 变体名 → 字符串 */
const keyBody = rustFnBody(logcatRs, 'pub fn key(self)', implCat) || '';
const codeBody = rustFnBody(logcatRs, 'pub fn code(self)', implCat) || '';
const groupBody = rustFnBody(logcatRs, 'pub fn group(self)', implCat) || '';
check('Category 的 key()/code()/group() 三个函数体都取到了',
	!!keyBody && !!codeBody && !!groupBody);

const keyOf = {};
const codeOf = {};
let m;
const RE_STR_ARM = /Category::(\w+)\s*=>\s*"([^"]+)"/g;
while ((m = RE_STR_ARM.exec(keyBody)) !== null) keyOf[m[1]] = m[2];
while ((m = RE_STR_ARM.exec(codeBody)) !== null) codeOf[m[1]] = m[2];

/* group() 的臂是多变体合一（Category::A | Category::B => Group::Runtime） */
const groupOf = {};
const RE_GROUP_ARM = /((?:Category::\w+\s*\|?\s*)+)=>\s*Group::(\w+)/g;
while ((m = RE_GROUP_ARM.exec(groupBody)) !== null) {
	const variants = m[1].match(/Category::\w+/g) || [];
	variants.forEach(function (v) { groupOf[v.slice('Category::'.length)] = groupKeyOf[m[2]] || m[2]; });
}

/* ALL：顺序即前端类别条的展示顺序 */
const allM = logcatRs.match(/pub const ALL:\s*\[Category;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/);
check('logcat.rs 里有 pub const ALL 清单', !!allM);
if (!allM) failOut();
const allVariants = (allM[2].match(/Category::\w+/g) || []).map(function (v) { return v.slice('Category::'.length); });
const declared = Number(allM[1]);

const backend = allVariants.map(function (v) {
	return { variant: v, key: keyOf[v], code: codeOf[v], group: groupOf[v] };
});

check('ALL 声明的长度与列出的类别数一致', declared === allVariants.length,
	'声明 ' + declared + ' / 实列 ' + allVariants.length);
check('后端类别数为 21', backend.length === 21, '实际 ' + backend.length);
check('每个后端类别都解析出 key / code / group',
	backend.every(function (c) { return !!c.key && !!c.code && !!c.group; }),
	backend.filter(function (c) { return !c.key || !c.code || !c.group; })
		.map(function (c) { return c.variant; }).join(', '));

const beKeys = backend.map(function (c) { return c.key; });
const beCodes = backend.map(function (c) { return c.code; });
check('后端 key 唯一', new Set(beKeys).size === beKeys.length);
check('后端 code 唯一', new Set(beCodes).size === beCodes.length);
check('后端只有 runtime / business 两个分组',
	backend.every(function (c) { return c.group === 'runtime' || c.group === 'business'; }),
	[...new Set(backend.map(function (c) { return c.group; }))].join(', '));
check('两个分组都非空（runtime 7 / business 14）',
	backend.filter(function (c) { return c.group === 'runtime'; }).length === 7
	&& backend.filter(function (c) { return c.group === 'business'; }).length === 14,
	'runtime=' + backend.filter(function (c) { return c.group === 'runtime'; }).length
	+ ' business=' + backend.filter(function (c) { return c.group === 'business'; }).length);

/* ---------- 2) 前端表：把 logs.js 的模块头加载进 Node ---------- */

/* 只取 `return L.view.extend({` 之前的模块头：那段是纯数据与纯函数，
 * 不碰 DOM，因此不需要 E / document 桩；视图体内的那些断言改用文本检查（见第 5 段）。 */
function loadLogsHead() {
	const cleaned = logsJs.split('\n')
		.filter(function (l) { return l.indexOf("'require ") !== 0; })
		.join('\n');
	const cut = cleaned.indexOf('\nreturn L.view.extend(');
	if (cut < 0) throw new Error('找不到 return L.view.extend( —— 视图结构变了？');
	const head = cleaned.slice(0, cut);
	const factory = new Function(head + '\n;return {'
		+ 'CAT_TABLE: CAT_TABLE, CAT_ALL: CAT_ALL, CAT_GROUP_DEFS: CAT_GROUP_DEFS,'
		+ 'CATEGORY_DEFS: CATEGORY_DEFS, CATEGORY_CODE: CATEGORY_CODE,'
		+ 'CATEGORY_RULES: CATEGORY_RULES, PLUGIN_LINE_RE: PLUGIN_LINE_RE,'
		+ 'SRC_LABEL: SRC_LABEL, categorize: categorize, dedupKey: dedupKey,'
		+ 'fmtKiB: fmtKiB, entriesFromBackend: entriesFromBackend,'
		+ 'entriesFromPluginFile: entriesFromPluginFile };');
	return factory();
}

let fe = null;
let loadErr = null;
try { fe = loadLogsHead(); } catch (e) { loadErr = e; }
check('logs.js 模块头能在 Node 里加载（取出前端类别表与解析函数）', !!fe,
	loadErr ? loadErr.message : '');
if (!fe) failOut();

const feTable = fe.CAT_TABLE;
const feKeys = feTable.map(function (c) { return c.key; });
const feCodes = feTable.map(function (c) { return c.code; });

check('前端类别表条目数为 21', feTable.length === 21, '实际 ' + feTable.length);
check('前端 key 唯一', new Set(feKeys).size === feKeys.length);
check('前端 code 唯一', new Set(feCodes).size === feCodes.length);

/* 逐键对账：后端有 → 前端必须有标签与图标；前端有 → 后端必须有（不留孤儿） */
const feByKey = {};
feTable.forEach(function (c) { feByKey[c.key] = c; });

const missingLabel = [];
const missingIcon = [];
backend.forEach(function (c) {
	const f = feByKey[c.key];
	if (!f) { missingLabel.push(c.key + '(整条缺失)'); return; }
	if (!f.label || !String(f.label).trim()) missingLabel.push(c.key);
	if (!f.icon || !String(f.icon).trim()) missingIcon.push(c.key);
});
check('每个后端类别在前端都有中文标签', missingLabel.length === 0, missingLabel.join(', '));
check('每个后端类别在前端都有图标（emoji 约定）', missingIcon.length === 0, missingIcon.join(', '));

const orphans = feKeys.filter(function (k) { return beKeys.indexOf(k) < 0; });
check('前端没有后端不认识的孤儿类别键', orphans.length === 0, orphans.join(', '));

const codeMismatch = backend.filter(function (c) {
	return feByKey[c.key] && feByKey[c.key].code !== c.code;
}).map(function (c) { return c.key + ': 前端 ' + feByKey[c.key].code + ' / 后端 ' + c.code; });
check('每个类别的 code 前后端一致（文件行里的 [SMS] 靠它反查）',
	codeMismatch.length === 0, codeMismatch.join('; '));

const groupMismatch = backend.filter(function (c) {
	return feByKey[c.key] && feByKey[c.key].group !== c.group;
}).map(function (c) { return c.key + ': 前端 ' + feByKey[c.key].group + ' / 后端 ' + c.group; });
check('每个类别的分组前后端一致', groupMismatch.length === 0, groupMismatch.join('; '));

const orderMismatch = feKeys.filter(function (k, i) { return k !== beKeys[i]; });
check('前端类别顺序与后端 ALL 一致（清单缺席时兜底顺序不跑偏）',
	orderMismatch.length === 0, orderMismatch.join(', '));

/* code → key 反查表（插件日志文件解析靠它） */
const codeMapBad = backend.filter(function (c) { return fe.CATEGORY_CODE[c.code] !== c.key; });
check('CATEGORY_CODE 反查表覆盖全部 code', codeMapBad.length === 0,
	codeMapBad.map(function (c) { return c.code; }).join(', '));

/* `all` 是纯前端概念 */
check('CAT_ALL 的键是 all', fe.CAT_ALL && fe.CAT_ALL.key === 'all', fe.CAT_ALL && fe.CAT_ALL.key);
check('all 不是后端类别', beKeys.indexOf('all') < 0);
check('all 不混进前端类别表（否则会被当成真类别参与计数与配色）', feKeys.indexOf('all') < 0);
check('all 有标签与图标', !!(fe.CAT_ALL && fe.CAT_ALL.label && fe.CAT_ALL.icon));
check('类别条渲染时会把 all 芯片建出来', /makeCatBtn\(CAT_ALL\)/.test(logsJs));

/* 分组标题 */
const feGroups = fe.CAT_GROUP_DEFS.map(function (g) { return g.key; });
check('前端分两栏，且栏键与后端 Group::key() 一致',
	feGroups.length === 2 && feGroups[0] === 'runtime' && feGroups[1] === 'business', feGroups.join(','));
check('两栏标题为 软件运行 / 业务痕迹',
	fe.CAT_GROUP_DEFS[0].label === '软件运行' && fe.CAT_GROUP_DEFS[1].label === '业务痕迹',
	fe.CAT_GROUP_DEFS.map(function (g) { return g.label; }).join(' / '));

/* ---------- 3) 正则兜底表 ---------- */
const ruleKeys = fe.CATEGORY_RULES.map(function (r) { return r.key; });
const ruleOrphans = ruleKeys.filter(function (k) { return feKeys.indexOf(k) < 0; });
check('CATEGORY_RULES 的键都是真类别（拼错会产出一个没有芯片、没有配色的类别）',
	ruleOrphans.length === 0, ruleOrphans.join(', '));
const noRule = feKeys.filter(function (k) { return k !== 'misc' && ruleKeys.indexOf(k) < 0; });
check('除 misc 外每个类别都有一条兜底规则（旧后端与 syslog 行全靠它）',
	noRule.length === 0, noRule.join(', '));
check('misc 是兜底返回值（与后端 Category::Misc 同语义）', /return 'misc';/.test(logsJs));
check('misc 属 runtime 组（漏标的日志仍进 syslog）', feByKey.misc && feByKey.misc.group === 'runtime');
check('旧的 sys / other 类别键已彻底移除',
	!/'sys'/.test(logsJs) && !/'other'/.test(logsJs)
	&& !/\.mt5700-logcat-(sys|other)\s*\{/.test(mtCss));

/* 兜底分类抽样：口径与后端类别含义一致 */
const catCases = [
	['收到新短信，存储区: ME，索引: 3', 'sms'],
	['发送 → 模组: AT+CMGS=42', 'sms'],          /* sms 必须在 at 之前，否则短信全归 AT 通道 */
	['自动拨号失败：CGACT 返回 error', 'dial'],   /* dial 在 net 之前 */
	['接口 eth2 已拉起，DHCP 获取地址成功', 'net'],
	['接收 ← 模组: +CIEV: 1', 'urc'],
	['接收 ← 模组: +CMTI: "ME",7', 'sms'],       /* 短信类 URC 归短信：用户找的是那条短信 */
	['SIM 卡状态: READY', 'sim'],
	['信号巡检 RSRP -95 SINR 18', 'signal'],
	['流量统计已按月清零', 'usage'],
	['NTP 对时完成，时区 Asia/Shanghai', 'time'],
	['串口 /dev/ttyUSB2 打开失败', 'serial'],
	['UCI 配置已热更新', 'config'],
	['AT^FOTA: 升级包校验通过', 'firmware'],
	['定时锁频任务已提交', 'schedule'],
	['企业微信通知推送成功', 'notify'],
	['服务已启动，版本 1.32.6', 'runtime'],
	['zzz 42', 'misc']
];
const catBad = catCases.filter(function (c) { return fe.categorize(c[0]) !== c[1]; });
check('正则兜底抽样分类全部命中预期类别', catBad.length === 0,
	catBad.map(function (c) { return '「' + c[0] + '」→ ' + fe.categorize(c[0]) + '（期望 ' + c[1] + '）'; }).join('; '));

/* ---------- 4) 后端 cat 优先 + 插件文件解析 ---------- */
const be = fe.entriesFromBackend([
	{ seq: 7, ts: 1730000000000, level: 'INF', cat: 'sms', msg: '一条后端已定类的日志' },
	{ seq: 8, ts: 1730000001000, level: 'INF', cat: '不存在的类别', msg: '收到新短信' },
	{ seq: 9, ts: 1730000002000, level: 'INF', msg: '接口 eth2 已拉起' }
]);
check('后端给了合法 cat 就直接用（不再走正则猜）', be[0].cat === 'sms' && be[0].seq === 7);
check('后端给了未知 cat 时退回正则兜底', be[1].cat === 'sms', be[1].cat);
check('旧后端不给 cat 时退回正则兜底', be[2].cat === 'net', be[2].cat);

/* 文件行样例取自 logger.rs::plugin_file_push 的文档格式：行首本地时间文本 +
 * 括号里的绝对毫秒。第二行是**升级前写下的旧格式**（没有括号字段），
 * 用来钉住「旧行仍能解析、只是退回本地时间重建」这条兼容路径。 */
const sample = '2024-10-27 04:13:20.000 (1730000000000) [INF] [SMS] 收到新短信，存储区: ME，索引: 3';
const parsed = fe.entriesFromPluginFile(sample + '\n'
	+ '2026-11-08 04:40:02.007 [ERR] [DIAL] 自动拨号失败\n'
	+ '半行被截断的 [INF] [SMS] 没有时间戳\n'
	/* code 段按 logger.rs 是 [A-Z0-9]+，所以「没见过的码」也得是 ASCII；XYZ 未注册，只能靠正文猜 */
	+ '2024-10-27 04:13:21.000 (1730000001000) [INF] [XYZ] 收到新短信\n');
check('插件文件解析：合法行全部收进来，坏行跳过', parsed.length === 3, '实际 ' + parsed.length);
if (parsed.length === 3) {
	/* 新格式必须直接用行内 epoch —— 这样浏览器与路由时区不同也不会平移一个时区 */
	check('插件文件解析：优先用行内绝对毫秒（浏览器时区无关）', parsed[0].ts === 1730000000000,
		'得到 ' + parsed[0].ts);
	check('插件文件解析：级别、来源、正文都对', parsed[0].level === 'INF' && parsed[0].src === 'file'
		&& parsed[0].msg === '收到新短信，存储区: ME，索引: 3', JSON.stringify(parsed[0]));
	check('插件文件解析：大写 code 反查回类别键', parsed[0].cat === 'sms' && parsed[1].cat === 'dial',
		parsed[0].cat + '/' + parsed[1].cat);
	check('插件文件解析：文件行没有 seq', parsed[0].seq === 0);
	/* 旧格式（无 epoch）退回本地时间文本逐字段还原 —— 不能交给 Date.parse */
	const legacyWant = new Date(2026, 10, 8, 4, 40, 2, 7).getTime();
	check('插件文件解析：旧格式无 epoch 时退回本地时间逐字段还原', parsed[1].ts === legacyWant,
		'得到 ' + parsed[1].ts + ' / 期望 ' + legacyWant);
}
check('插件文件行正则接受带 epoch 与不带 epoch 两种形态',
	fe.PLUGIN_LINE_RE.test(sample) && fe.PLUGIN_LINE_RE.test('2026-11-08 04:40:02.007 [ERR] [DIAL] 自动拨号失败'));
check('后端在插件文件行里写入绝对毫秒（前端才可能摆脱浏览器时区）',
	/\(\{ts\}\)/.test(loggerRs),
	'logger.rs 的行格式里没找到 ({ts})');
check('插件文件解析：未知 code 退回正则兜底', parsed.length === 3 && parsed[2].cat === 'sms',
	parsed[2] ? parsed[2].cat : '未解析出第三行');
check('不使用 Date.parse / new Date(字符串) 解析本地时间文本',
	!/Date\.parse\(/.test(logsJs) && /new Date\(Number\(m\[1\]\), Number\(m\[2\]\) - 1,/.test(logsJs));

/* syslog 样例注释得跟上后端 stderr 的形制：logger.rs 的 emit() 打的是
   「时间 [级别] [类别码] 消息」。这段注释只给人看，写旧了不会有任何运行时报错，
   所以只能钉在这里 —— 它同时是「syslog 那路不必解析类别码」这个决定的依据。 */
const syslogDocLines = logsJs.split('\n').filter(function (l) {
	return l.indexOf('at-webserver-rust[pid]:') >= 0;
});
check('logs.js 记着后端 syslog 行的样例', syslogDocLines.length === 1,
	'命中 ' + syslogDocLines.length + ' 行');
const syslogDoc = syslogDocLines[0] || '';
const syslogShape = syslogDoc.match(/\[(DBG|INF|WRN|ERR)\]\s*\[([A-Z0-9]+)\]/);
check('syslog 样例同时写了级别方括号与类别方括号（注释没落后于 logger.rs）',
	!!syslogShape, syslogDoc.trim());
check('syslog 样例里的类别码是后端真有的码',
	!!syslogShape && beCodes.indexOf(syslogShape[2]) >= 0,
	syslogShape ? syslogShape[2] : '没匹配到');

/* ---------- 5) 视图侧接线（文本断言：这些代码在视图体里，Node 加载不到） ---------- */
check('来源下拉有第三路「插件文件」',
	/value: 'file'/.test(logsJs) && fe.SRC_LABEL.file === '插件文件', fe.SRC_LABEL.file);
check('文件来源的行尾徽章与 syslog 同一套形制',
	/mt5700-logsrc mt5700-logsrc-file/.test(logsJs));
check('插件文件路径取自 logs RPC 的 plugin_file，不在前端硬编码',
	/state\.pluginFile = \(r && r\.plugin_file\) \|\| null;/.test(logsJs)
	&& logsJs.indexOf('/tmp/at-webserver/plugin.log') < 0);
check('plugin_file 关掉或没路径时不读文件',
	/if \(!pf \|\| !pf\.enabled \|\| !pf\.path\) \{/.test(logsJs));
check('去重键是 ts + "|" + msg', fe.dedupKey({ ts: 1730000000000, msg: '一条日志' }) === '1730000000000|一条日志');
check('去重只丢「文件条目撞内存条目」，不丢文件独有的历史',
	/for \(var i = 0; i < back\.length; i\+\+\) seen\[dedupKey\(back\[i\]\)\] = true;/.test(logsJs)
	&& /if \(seen\[dedupKey\(fromFile\[j\]\)\]\) continue;/.test(logsJs));
check('footer 显示业务日志文件路径与上限', /业务日志文件：/.test(logsJs));
check('上限按 KiB 人性化显示', fe.fmtKiB(524288) === '512 KiB' && fe.fmtKiB(512) === '512 B',
	fe.fmtKiB(524288) + ' / ' + fe.fmtKiB(512));
check('hint 说明了新的分流（业务日志不再进 syslog）',
	/不再写入 syslog/.test(logsJs) && /插件日志文件/.test(logsJs));
check('导出行带类别短标签', /var catSeg = e\.cat \? ' \[' \+ catDef\(e\.cat\)\.code \+ '\]' : '';/.test(logsJs));
check('通知记录页签的实现未被触碰（renderNotify 仍是原样）',
	/function renderNotify\(\) \{\n\t\t\tvar content = state\.notify \|\| '';/.test(logsJs)
	&& /lines\.push\(fmtFull\(e\.ts\) \+ ' \[' \+ e\.level \+ '\]' \+ catSeg \+ ' ' \+ e\.msg\);/.test(logsJs));
check('logs.js 保持 ES5 写法（无箭头函数 / let / const / 模板串）',
	!logsJs.split('\n').filter(function (l) { return l.indexOf('*') === 0 || l.trim().indexOf('/*') === 0
		|| l.trim().indexOf('//') === 0; }).some(function (l) {
		return /=>|\blet\s|\bconst\s|`/.test(l.replace(/\/\*[\s\S]*?\*\//g, ''));
	}));

/* ---------- 6) 样式 ---------- */
const lightMissing = [];
const darkMissing = [];
beKeys.forEach(function (k) {
	if (!new RegExp('^\\.mt5700-logcat-' + k + ' \\{', 'm').test(mtCss)) lightMissing.push(k);
	if (!new RegExp('^\\.at-dark \\.mt5700-logcat-' + k + ' \\{', 'm').test(mtCss)) darkMissing.push(k);
});
check('mt5700.css 有全部 21 条浅色徽章配色', lightMissing.length === 0, lightMissing.join(', '));
check('mt5700.css 有全部 21 条 .at-dark 徽章配色', darkMissing.length === 0, darkMissing.join(', '));
check('徽章配色保持 color / border-color / background 三件套（rgba 带 alpha）',
	beKeys.every(function (k) {
		const line = (mtCss.match(new RegExp('^\\.mt5700-logcat-' + k + ' \\{[^\\n]*$', 'm')) || [''])[0];
		return /color: #/.test(line) && /border-color: rgba\(/.test(line) && /background: rgba\(/.test(line);
	}));
check('分组类别条样式齐备（栏 / 标题 / 芯片行）',
	['.mt5700-logcatgroup {', '.mt5700-logcatgroup-label {', '.mt5700-logcatrow {',
	 '.mt5700-logcatgroup-business .mt5700-logcatgroup-label'].every(function (s) {
		return mtCss.indexOf(s) > 0;
	}));
check('分组类别条有暗色变体', mtCss.indexOf('.at-dark .mt5700-logcatgroup-label') > 0);
check('文件来源徽章有样式与暗色变体',
	mtCss.indexOf('.mt5700-logsrc-file {') > 0 && mtCss.indexOf('.at-dark .mt5700-logsrc-file {') > 0);

/* 窄屏：21 个芯片换成横向滚动带，而不是堆成七八行 */
const mobAt = mtCss.indexOf('@media (max-width: 768px) {.mt5700-logcatbar {');
check('窄屏媒体查询里有类别条段落', mobAt > 0);
const mob = mobAt > 0 ? mtCss.slice(mobAt, mobAt + 2200) : '';
check('窄屏下芯片行不换行且可横向滚动',
	/flex-wrap: nowrap;/.test(mob) && /overflow-x: auto;/.test(mob));
check('窄屏下芯片不被压缩（否则文字溢出成糊字）',
	/\.mt5700-logcatrow > \.mt5700-logcatbtn \{\s*\n\s*flex: 0 0 auto;/.test(mob));
check('窄屏下分组标题排在芯片行上方', /flex-direction: column;/.test(mob));

/* ---------- 7) 缓存版本戳与行尾 ---------- */
const vm = mtJs.match(/var MT5700_CSS_VERSION = '(\d+)\.(\d+)\.(\d+)';/);
check('mt5700.js 里有 MT5700_CSS_VERSION', !!vm);
if (vm) {
	const cur = [Number(vm[1]), Number(vm[2]), Number(vm[3])];
	const old = [2, 46, 8];
	const newer = cur[0] > old[0] || (cur[0] === old[0] && (cur[1] > old[1]
		|| (cur[1] === old[1] && cur[2] > old[2])));
	check('MT5700_CSS_VERSION 已从 2.46.8 递增（改了 mt5700.css 必须递增）',
		newer, '当前 ' + vm[1] + '.' + vm[2] + '.' + vm[3]);
}

[[LOGS_JS, logsJs], [MT_CSS, mtCss], [MT_JS, mtJs],
 ['tests/log-category-test.js', read('tests/log-category-test.js')]].forEach(function (pair) {
	check(path.basename(pair[0]) + ': LF 行尾', pair[1].indexOf('\r\n') < 0);
});

/* 行尾空白只查本次新增的规则行：mt5700.css 的历史段落里本来就有若干行带尾随空格，
 * 一并查会把无关的旧账算到这次改动头上。 */
const wsBad = [];
mtCss.split('\n').forEach(function (l, i) {
	if (!/mt5700-logcat|mt5700-logsrc-file/.test(l)) return;
	if (/\s$/.test(l)) wsBad.push((i + 1) + ': ' + l.trim().slice(0, 40));
});
logsJs.split('\n').forEach(function (l, i) { if (/\s$/.test(l)) wsBad.push('logs.js:' + (i + 1)); });
check('新增样式行与 logs.js 无行尾空白', wsBad.length === 0, wsBad.join('; '));

/* ---------- 汇总 ---------- */
console.log('\n后端类别 %d 个（runtime %d / business %d），前端 %d 个，样式 %d 条',
	backend.length,
	backend.filter(function (c) { return c.group === 'runtime'; }).length,
	backend.filter(function (c) { return c.group === 'business'; }).length,
	feTable.length, beKeys.length * 2);
failOut();
