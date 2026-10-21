#!/usr/bin/env node
/*
 * UI / 样式 / mock 契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 用途：把「JS 用的类名 ↔ CSS 定义」「mock 应答 ↔ 真机实测」这两类曾经出过问题的约定固定下来。
 * 全部依据都是 2026-09-13 的真机实测与真实浏览器 DOM 采集，不是想当然。
 *
 * 运行：node tests/ui-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSSP = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css');
const MT5700 = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.js');
const STATUS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
const MOCK = path.join(ROOT, 'tests', 'mock-modem', 'mock-modem.js');

const css = fs.readFileSync(CSSP, 'utf8');
const mt5700 = fs.readFileSync(MT5700, 'utf8');
const statusJs = fs.readFileSync(STATUS, 'utf8');
const mock = fs.readFileSync(MOCK, 'utf8');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '\n      ' + extra : ''));
}
function hasClass(name) {
	return new RegExp('\\.' + name.replace(/[-]/g, '\\-') + '(?![a-z0-9-])').test(css);
}

/* ---------- 1. 动态拼接的类名必须在 CSS 里有对应定义 ----------
 * mt5700.js：'mt5700-btn mt5700-btn-' + variant / 'mt5700-badge mt5700-badge-' + variant
 *            'mt5700-toast mt5700-toast-' + type
 * 缺一条就会出现「徽章/按钮没有配色」——2026-09-13 实测 .mt5700-badge-primary 就是缺的。
 */
const BTN_VARIANTS = ['secondary', 'primary', 'success', 'danger', 'ghost'];
const BADGE_VARIANTS = ['neutral', 'primary', 'success', 'warning', 'danger', 'info'];
const TOAST_VARIANTS = ['success', 'error', 'info', 'warning'];

for (const v of BTN_VARIANTS) ok('CSS 定义了 .mt5700-btn-' + v, hasClass('mt5700-btn-' + v));
for (const v of BADGE_VARIANTS) ok('CSS 定义了 .mt5700-badge-' + v, hasClass('mt5700-badge-' + v));
for (const v of TOAST_VARIANTS) ok('CSS 定义了 .mt5700-toast-' + v, hasClass('mt5700-toast-' + v));

/* 基础类也要在 */
for (const c of ['mt5700-btn', 'mt5700-badge', 'mt5700-toast', 'mt5700-badge-dot']) {
	ok('CSS 定义了 .' + c, hasClass(c));
}

/* ---------- 2. JS 实际挂上的类名必须在 CSS 里存在 ----------
 * 短信删除按钮：JS 挂的是 .mt5700-sms-del，CSS 曾写作 .at-sms-del → 样式从未生效。
 */
const SMS_CENTER = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'sms_center.js');
const smsJs = fs.readFileSync(SMS_CENTER, 'utf8');
ok('sms_center.js 挂 .mt5700-sms-del', smsJs.indexOf('mt5700-sms-del') >= 0);
ok('CSS 定义了 .mt5700-sms-del', hasClass('mt5700-sms-del'));
ok('CSS 不再残留无主的 .at-sms-del 选择器', !/^\.at-sms-del\s*\{/m.test(css));

/* ---------- 3. 前端不得再发真机恒失败的命令 ----------
 * AT^TXPOWER?：手册 §13.23 仅 GUL 有效，本机 NR SA 实测 0/3 恒 ERROR。
 * 曾经「注释说已删除、调用还在」，这里钉死。
 */
const FE = path.join(ROOT, 'htdocs', 'luci-static', 'resources');
const feFiles = [];
(function walk(dir) {
	for (const f of fs.readdirSync(dir)) {
		const p = path.join(dir, f);
		if (fs.statSync(p).isDirectory()) walk(p);
		else if (f.endsWith('.js')) feFiles.push(p);
	}
})(FE);
const txpower = feFiles.filter((p) => /sendCommand\('AT\^TXPOWER\?'\)|'(AT\^TXPOWER\?)'/.test(fs.readFileSync(p, 'utf8')));
ok('前端不再发送 AT^TXPOWER?', txpower.length === 0,
	'仍在发送: ' + txpower.map((p) => path.relative(ROOT, p)).join(', '));

/* ---------- 4. mock 必须与真机一致 ----------
 * 真机不支持的形式：必须回 ERROR（否则测试会在假世界里通过）
 */
const MOCK_MUST_FAIL = ['AT+CSQ?', 'AT^MONSC?', 'AT^CPMS?', 'AT^CASCELLINFO?', 'AT^TXPOWER?',
	'AT^CONNECT?', 'AT+CLCK?', 'AT+CPWD?', 'AT^SYSINFO?', 'AT^NRRCCAPQRY?', 'AT^NDISSTATQRY'];
for (const c of MOCK_MUST_FAIL) {
	const re = new RegExp("if \\(c === '" + c.replace(/[\^+?]/g, (m) => '\\' + m) + "'\\) return 'ERROR'");
	ok('mock 对 ' + c + ' 返回 ERROR（与真机一致）', re.test(mock));
}
/* 真机能用的形式：必须有分支应答 */
const MOCK_MUST_WORK = ['AT^MONSC', 'AT+CSQ', 'AT^NRRCCAPQRY=3', 'AT^NRRCCAPQRY=2', 'AT^NRRCCAPQRY=5', 'AT^NWTIME?'];
for (const c of MOCK_MUST_WORK) {
	ok('mock 能应答 ' + c, mock.indexOf("'" + c + "'") >= 0);
}
/* SYSCFGEX 必须是真格式（第一段带引号），否则「漫游设置」卡解析不到 */
ok('mock 的 ^SYSCFGEX 应答是真格式（首段带引号）',
	/\^SYSCFGEX:\s*"\d{4,}"/.test(mock),
	'mock 里的 ^SYSCFGEX 应答没有带引号的 acqorder 字段');

/* ---------- 5. ^NWTIME（网络时间）已整条移除，不得复活 ----------
 * 手册 §13.8.5 与真机实测：网络未下发 EMM/GMM/MM information 时模组固定输出占位符 90/01/06，
 * 本机正是如此，界面只能显示假日期（曾显示成 2090-01-06）。相关字段、查询与解析函数一并删除。
 */
ok('network_status.js 不再查询 AT^NWTIME?', statusJs.indexOf("sendCommand('AT^NWTIME?')") < 0);
ok('network_status.js 不再有 parseNetTime', statusJs.indexOf('parseNetTime') < 0);
/*
 * 必须先剥注释再判。
 *
 * 上一版写的是 `statusJs.indexOf('网络时间') < 0 || /已整条移除/.test(statusJs)`，
 * 而 network_status.js:149 的注释里恰好同时含这两个词（正是这段说明），
 * 于是后半永远为真 —— 断言一次都不会失败，等于把这条守约删掉了。
 * 注释里提到「网络时间已移除」不构成复活，真正要防的是代码里再出现这个字段。
 */
const statusNoComment = statusJs
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/^\s*\/\/.*$/gm, '');
ok('network_status.js 不再有网络时间字段', statusNoComment.indexOf('网络时间') < 0,
	'剥离注释后仍出现「网络时间」');
const TERMINAL = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'terminal.js');
ok('终端快捷命令里也没有网络时间',
	fs.readFileSync(TERMINAL, 'utf8').indexOf('AT^NWTIME?') < 0);

/* 温度：12 路传感器合并为「SIM 与设备」卡里的单行「5G模块温度」（取最高）。
 * 用**源码字面量精确匹配**，不写正则容错 —— 本项目出过「断言写成 A || B，
 * 而注释里恰好同时含 A、B，守卫等价于删除」的事故（本文件 :105-117）。 */
ok('温度合并为单行「5G模块温度」', statusJs.indexOf("'5G模块温度'") >= 0);
ok('不再逐路渲染「温度 · 」前缀的温度行', statusJs.indexOf("'温度 · '") < 0);
ok('不再有独立的温度磁贴容器 tempGrid', statusJs.indexOf('tempGrid') < 0);
/* parse.js 的 12 路解析与 network_status.js 的 state.temps 必须键数一致：
   否则「补了解析字段却忘了同步 state」会让取最高悄悄少算几路（会审 R02/R11）。 */
const PARSE_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const parseSrc = fs.readFileSync(PARSE_JS, 'utf8');
const tempKeysOf = (src) => {
	const m = src.match(/(?:return\s*\{|temps:\s*\{)([^}]*)\}/s);
	return m ? (m[1].match(/[A-Za-z][A-Za-z0-9]*\s*:/g) || []).length : -1;
};
const parseKeys = tempKeysOf(parseSrc.match(/parseCHIPTEMP[\s\S]*?return\s*\{[\s\S]*?\};/)[0]);
const stateKeys = tempKeysOf(statusJs.match(/temps:\s*\{[\s\S]*?\}/)[0]);
ok('温度字段数两侧一致（parseCHIPTEMP vs state.temps）',
	parseKeys > 0 && parseKeys === stateKeys,
	'parse=' + parseKeys + ' state=' + stateKeys);

/* ---------- 6. AT 通道必须经 rpcd → ucode → Rust，前端不得直连串口 ----------
 * 既定链路（rpc.js 头部注释 & L.rpc.declare）：
 *   LuCI JS → L.rpc.declare({object:'mt5700', method:'at'}) → rpcd → ucode 代理
 *   （/usr/share/rpcd/ucode/mt5700.uc）→ Rust 常驻服务（127.0.0.1:port，TCP newline-JSON）→ 串口。
 * 串口的唯一持有者是 Rust 服务；前端只允许经上面这条链路发 AT。
 */
const RPC_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const rpcJs = fs.readFileSync(RPC_JS, 'utf8');
ok('rpc.js 通过 L.rpc.declare 使用 rpcd 对象 mt5700',
	/L\.rpc\.declare\(\{[\s\S]{0,120}?object:\s*'mt5700'/.test(rpcJs));
ok("rpc.js 声明了 mt5700.at 方法（AT 的唯一出口）",
	/object:\s*'mt5700'\s*,\s*\n?\s*method:\s*'at'/.test(rpcJs));

/* 前端任何文件都不得直接打开/读取串口设备 */
for (const p of feFiles) {
	const t = fs.readFileSync(p, 'utf8');
	const rel = path.relative(ROOT, p);
	ok('不出现 Web Serial（' + rel + '）', !/navigator\.serial/.test(t));
	ok('不调用 microcom（' + rel + '）', !/\bmicrocom\b/.test(t));
	ok('不建 WebSocket（' + rel + '）', !/new\s+WebSocket/.test(t));
	/* /dev/tty* 只允许出现在 UI 文案或取值比较里（让用户选 Rust 该开哪个口），
	   一旦出现在发送调用里就是越权。 */
	for (const mm of t.matchAll(/\/dev\/tty[A-Za-z0-9]+/g)) {
		const line = t.slice(0, mm.index).split('\n').pop();
		const inSend = /sendCommand\(|sendCmd\(|fetch\(|XMLHttpRequest|WebSocket|\.open\(/.test(line);
		ok('串口路径只作 UI 文案（' + rel + '）', !inSend, line.trim().slice(0, 90));
	}
	/* AT 字面量不得出现在任何自带传输的调用里 */
	for (const mm of t.matchAll(/['"]AT[\^+A-Z0-9_?][\w\^+=,"\-]*['"]/g)) {
		const line = t.slice(0, mm.index).split('\n').pop();
		const direct = /fetch\(|XMLHttpRequest|WebSocket|\.open\(/.test(line);
		ok('AT 不自行绕过发送封装（' + rel + '）', !direct, line.trim().slice(0, 90));
	}
}

/* ---------- 6b. ucode 代理的 nc 必须有超时、且不能用 -w ----------
 * 真机实测（2026-09-14）：
 *   · nc 连上后端但后端不回包时会一直阻塞在读上，rpcd 的 ucode 工作线程被永久占住，
 *     表现为「插件所有页面一起卡死」，且日志里查不到任何报错 → 必须用 timeout 包住。
 *   · 本固件的 busybox nc 是精简版（v1.38），**不认 -w**：传 `nc -w 3` 只会打印
 *     usage 并立刻退出（rc=1）。照搬「nc -w 5」的写法会让所有 RPC 全部失败。
 */
const UCODE = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const ucodeSrc = fs.readFileSync(UCODE, 'utf8');
ok('ucode 的 nc 调用被 timeout 包裹', /timeout\s+\d+\s+nc\s+127\.0\.0\.1/.test(ucodeSrc));
ok('★ ucode 的 nc 不带 -w（本固件 busybox nc 不支持，会导致所有 RPC 失败）',
	!/nc\s+-w|nc[^'\n]*\s-w\s+\d/.test(ucodeSrc));

/* ---------- 7. 定时器生命周期：卡片离开页面后必须自动停 ----------
 * 审计发现（2026-09-14）：renderConnectionBar 每画一次状态卡就起一个 15s 的
 * AT^SIMSQ? 轮询，句柄记在全局 _timers；而唯一的清理入口 Mt5700.clearAll()
 * 全仓库零调用、各页面 _dispose 也不清它 —— 进几次页面就有几个定时器在后台
 * 各发各的 AT。串口由 Rust 服务独占，这些没人看的轮询会和用户操作抢通道。
 * 修法：api.interval 接受 scopeEl，每次触发前确认节点还在文档里，不在就清掉自己。
 */
const intervalFn = (mt5700.match(/api\.interval\s*=\s*function[\s\S]{0,900}?\n\t\};/) || [''])[0];
ok('api.interval 接受第三个参数 scopeEl',
	/api\.interval\s*=\s*function\s*\([^)]*scopeEl/.test(mt5700));
ok('api.interval 用 ownerDocument.contains 判断节点是否还在页面',
	/ownerDocument/.test(intervalFn) && /contains\(scopeEl\)/.test(intervalFn));
ok('节点脱离文档后清掉定时器', /clearInterval\(id\)/.test(intervalFn));
ok('停止时把自己从 _timers 摘掉（避免数组无限增长）', /_timers\.splice\(/.test(intervalFn));
ok('状态卡的 SIM 轮询把 card 作为作用域传入',
	/api\.interval\(15000,\s*refreshSimStatus,\s*card\)/.test(mt5700));
ok('clearAll 遍历副本（清理过程中会 splice 自身）', /_timers\.slice\(\)\.forEach/.test(mt5700));

/*
 * ---------- 短信未读标记 ----------
 * 背景：本模组的 +CMGL / +CMGR 读取成功后都会把「未读」置为「已读」（鼎桥 AT
 * 手册 9.8 / 9.10），真机 17 条短信的 <stat> 全是 1。所以未读不能只靠模组状态位，
 * 必须由前端以「号码」为键自行记录。以下断言固定这套约定。
 */
ok('未读标记具备 标记/清除/查询 三个基本操作',
	/function markUnread\(/.test(smsJs) && /function clearUnread\(/.test(smsJs) && /function isUnread\(/.test(smsJs));
ok('会话未读数按真实数据计算（不再恒为 0）', /c\.unreadCount\s*=\s*unreadN\s*\|\|/.test(smsJs));
ok('未读名单以号码为键（短信删除后 index 会被复用，不能用 index）',
	/unreadNumbers\.indexOf\(normalizeNumber/.test(smsJs));
ok('未读名单持久化到 localStorage', /localStorage\.setItem\(UNREAD_KEY/.test(smsJs));
ok('短信删除后把号码从未读名单摘掉（避免名单无限增长）',
	/kept\.length !== unreadNumbers\.length/.test(smsJs));
ok('新短信推送时标记未读', /markUnread\(msg\.number\)/.test(smsJs));
ok('打开会话即清除未读', /function selectContact\(num\)[\s\S]{0,160}clearUnread\(num\)/.test(smsJs));
/* 关键：只清名单不清 msg.unread 的话，同一次会话内再次 buildContacts 会把未读标回来，
   表现为「点开了，徽章却又冒出来」 */
ok('清除未读时同步清掉短信自带的未读标记（防止徽章复现）',
	/msgs\[mi\]\.unread = false/.test(smsJs));
/* 真机实测到的坑：只清名单和 msg.unread，徽章仍不消失——因为 renderContacts
   读的是 buildContacts 算好并缓存在会话上的 c.unread，必须一并清零 */
ok('清除未读时同步重置会话缓存的未读数（否则徽章不消失）',
	/c\.unreadCount = 0;[\s\S]{0,400}?c\.unread = false;/.test(smsJs));
ok('未读会话渲染徽章', /Mt5700\.badge\(/.test(smsJs) && /'未读'/.test(smsJs));
ok('徽章 variant 在 CSS 里有定义（否则落到无配色的基类）',
	/\.mt5700-badge-info\s*\{/.test(css));

/* ---------- 状态类必须与配对样式同进同退 ----------
 * 2026-10-21 发现的真实故障：mt5700.js 的 renderConnectionBar 里
 *   simBox.classList.toggle('is-warn', sim.warn)
 * 挂了很久，而 mt5700.css 从来没有 `.mt5700-status-sim.is-warn` —— 状态类切了，
 * 界面毫无变化。页面不报错、全部测试也是绿的，用户只看到"告警了但没反应"。
 *
 * ★ 断言必须**先取出规则块再判**。早先写成
 *   /\.mt5700-status-text\s*\{[\s\S]*?min-width:\s*0;…/ —— 看起来对，实际
 *   [\s\S]*? 能一路跳到后面别的规则里去匹配，把 min-width 从别处"借"过来，
 *   于是把本条 CSS 删干净测试照样绿（变异验证已证实）。
 */
function cssBlock(sel) {
	const i = css.indexOf(sel + ' {');
	if (i < 0) return '';
	const j = css.indexOf('}', i);
	return j < 0 ? '' : css.slice(i, j + 1);
}
ok('★ SIM 芯片告警态有配对样式（JS toggle is-warn，CSS 必须有规则）',
	/simBox\.classList\.toggle\('is-warn'/.test(mt5700)
	=== /\.mt5700-status-sim\.is-warn\s*\{/.test(css));
const warnBlock = cssBlock('.mt5700-status-sim.is-warn');
ok('SIM 告警态同时改底色与描边（只改文字色几乎看不出来）',
	warnBlock.indexOf('background:') > 0 && warnBlock.indexOf('border-color:') > 0,
	'实际块：' + warnBlock);
/* 标题行是固定尺寸行：文案再长也只能收略号，不许把标题挤歪/换行 */
const stTextBlock = cssBlock('.mt5700-status-text');
ok('★ 状态标题文本收略号（min-width:0 + ellipsis + nowrap）',
	stTextBlock.indexOf('min-width: 0;') > 0
	&& stTextBlock.indexOf('text-overflow: ellipsis;') > 0
	&& stTextBlock.indexOf('white-space: nowrap;') > 0,
	'实际块：' + stTextBlock);

/* ---------- 全量类名对齐：JS 挂的每个自有类，CSS 都必须有定义 ----------
 * 这是把「改了类名、样式没跟上」这类故障一次性兜住的通用网。历史上真出过多次：
 *   · .mt5700-sms-del 的样式写成了 .at-sms-del → 删除按钮一直没有样式
 *   · simBox 挂了 is-warn 却没有配对规则 → 告警永远看不见
 *   · v2.4.29 之前 at-* 与 mt5700-* 两套命名空间并存，容易只改一边
 *
 * 口径（与 tools/css_scan.py 的开发期扫描一致，此处是 CI 期守卫）：
 *   只认「真会落到元素上」的位置 —— class/className 字面量、className 赋值、
 *   classList.add/remove/toggle/contains，以及 `+ ' mt5700-xxx'` 这种后缀拼接。
 *   注释里的类名不算：早先把注释里的通配写法当代码，导致 mt5700- 整个前缀
 *   被当成"在用"，判断全废。
 * 动态族（`'mt5700-btn mt5700-btn-' + variant`）以 `-` 结尾，单独收进前缀集合，
 * 成员由上面几组变体断言逐个钉住。
 */
const RES_DIR = path.join(ROOT, 'htdocs', 'luci-static', 'resources');
function walkJs(dir, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkJs(p, out);
		else if (e.name.endsWith('.js') && e.name !== 'jsqr.js') out.push(p);
	}
	return out;
}
const CLASS_POS_RES = [
	/['"]?class['"]?\s*:\s*'([^']*)'/g,
	/['"]?className['"]?\s*:\s*'([^']*)'/g,
	/className\s*=\s*'([^']*)'/g,
	/classList\.(?:add|remove|toggle|contains)\(\s*'([^']+)'/g,
	/\+\s*'\s((?:mt5700|at)-[A-Za-z0-9_-]+)'/g,
	/\+=\s*'\s((?:mt5700|at)-[A-Za-z0-9_-]+)'/g
];
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
const cssDefined = new Set();
for (const m of cssNoComment.matchAll(/\.([A-Za-z0-9_-]+)/g)) cssDefined.add(m[1]);

const jsClasses = new Map();     // 类名 → 首次出现的文件（便于定位）
const dynamicPrefixes = new Set();
for (const f of walkJs(RES_DIR, [])) {
	const src = fs.readFileSync(f, 'utf8');
	for (const re of CLASS_POS_RES) {
		for (const m of src.matchAll(re)) {
			for (const tok of m[1].split(/\s+/)) {
				if (!/^(mt5700|at)-/.test(tok)) continue;
				if (tok.endsWith('-')) { dynamicPrefixes.add(tok); continue; }
				if (!jsClasses.has(tok)) jsClasses.set(tok, path.relative(ROOT, f));
			}
		}
	}
}

ok('★ 扫描到了预期量级的自有类名（扫描器本身没失效）',
	jsClasses.size >= 150,
	'只扫到 ' + jsClasses.size + ' 个，扫描正则可能已经匹配不上写法了');

const undefinedClasses = [...jsClasses].filter(([c]) => !cssDefined.has(c));
ok('★ JS 挂的每个自有类 CSS 都有定义（缺一个＝样式静默失效）',
	undefinedClasses.length === 0,
	undefinedClasses.map(([c, f]) => c + ' ← ' + f).join('; '));

/* 旧 at-* 命名空间已在 v2.4.29 全量下线：JS 与 CSS 都不许再出现，
   否则「两套命名空间并存、只改一边」的老毛病会重新长回来。 */
const atLeftInJs = [...jsClasses.keys()].filter((c) => c.startsWith('at-'));
ok('JS 不再产出 at-* 类名（旧命名空间已下线）',
	atLeftInJs.length === 0, atLeftInJs.join(', '));
ok('CSS 不再定义 at-* 类（旧命名空间已下线）',
	!/\.at-[a-z]/.test(cssNoComment));

/* 按钮卡口不许再把调用方传的 cbi-button-* 落到 DOM 上：
   落到 DOM 就同时被主题 CSS 和本文件的按钮样式命中，外观取决于层叠顺序。 */
const uiSrc = fs.readFileSync(path.join(RES_DIR, 'at-webserver', 'ui.js'), 'utf8');
ok('★ ui.js 的按钮卡口不再输出 cbi-button-* 到元素上',
	!/['"]class['"]\s*:\s*'[^']*cbi-button/.test(uiSrc)
	&& /Mt5700\.button\(label, onClick, variant\)/.test(uiSrc));

/* ---------- 前端 JS 语法合法 ----------
 * 一个错位的括号就能让整个视图白屏，而所有"读文本做断言"的契约测试照样全绿
 * —— 它们只 grep 字面量，不解析语法。这里用 Function 构造函数真解析一遍。
 * （LuCI 模块的 `'require xxx'` 是普通字符串表达式语句，语法上合法，可直接解析。）
 */
const syntaxBad = [];
let syntaxOk = 0;
for (const f of walkJs(RES_DIR, [])) {
	try {
		new Function(fs.readFileSync(f, 'utf8'));   // eslint-disable-line no-new-func
		syntaxOk++;
	} catch (e) {
		syntaxBad.push(path.relative(ROOT, f) + ' → ' + e.message);
	}
}
ok('前端 JS 全部语法合法', syntaxBad.length === 0, syntaxBad.join('; '));
ok('语法检查确实扫到了文件（扫描器本身没失效）', syntaxOk >= 15,
	'只解析了 ' + syntaxOk + ' 个文件');

/* ---------- 汇总 ---------- */
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach((f, i) => console.log('  ✗ ' + (i + 1) + '. ' + f));
	process.exit(1);
}
console.log('UI / 样式 / mock 契约测试全部通过');
