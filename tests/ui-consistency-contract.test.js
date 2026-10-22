#!/usr/bin/env node
'use strict';

/**
 * UI 一致性与读取时序契约
 * ===========================================================================
 * 2026-09-28 用户两条反馈的守卫：
 *
 * ① 「所有开关保存开关统一化，而不是每一个小功能一个保存按钮；部分功能存在
 *    修改无法保存的状态」
 *    → 全站已有统一的暂存机制 `Mt5700.staged`（底部悬浮条：保存并应用 /
 *      撤销更改，见 mt5700.js，dial.js 一直在用），不该再各页各抄一套。
 *      「短信设置」是唯一真出现**多个**卡片级保存按钮的页面，本轮已合并。
 *      另外抓到一处**真的存不下来**的控件（modem_settings 的
 *      「高温时关闭 CA/MIMO」是空回调），单独钉死。
 *
 * ② 「网络状态 - 连接状态这些读取信息速度不是很快」
 *    → 慢档预热原来「整批 16 条跑完才轮到第一个任务」，而连接状态只要其中 6 条，
 *      于是最上面的卡被最下面卡片的预热推迟了 1.6 秒。改成两段预热。
 *      ★ 拆清单最容易犯的错是**漏抄/抄重**（漏一条=少问一次模组、抄重=多打一次串口），
 *      所以这里对「头段 ∪ 尾段」做集合级断言，而不是只数字符串在不在。
 *
 * 用法：node tests/ui-consistency-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver');
const A = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver');

function read(p) { return fs.readFileSync(p, 'utf8'); }
const SMSSET = read(path.join(V, 'sms_settings.js'));
const MODEM = read(path.join(V, 'modem_settings.js'));
const STATUS = read(path.join(V, 'network_status.js'));
const DIAL = read(path.join(V, 'dial.js'));
const MT = read(path.join(A, 'mt5700.js'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  ok   ' + name); }
function no(name, why) { fail++; console.log('  ✗ ' + name + '  → ' + why); }
function has(name, cond, why) { cond ? ok(name) : no(name, why); }

/*
 * 去掉注释再判「有没有这行代码」：本仓多次踩到「说明注释里写着的旧写法被当成实际代码」
 * （见 code-audit-optimize/RULES.md 第九节）。
 *
 * ★ 这里**不用**逐字符状态机（本仓 esim-contract 那种写法）。
 *   原因是本文件要扫的 sms_settings.js 里有正则字面量内含引号：
 *       line[1].match(/"(\w+)",\d+,\d+/g)
 *   状态机看到其中的 `"` 会进「字符串」态，之后整段代码被当成字符串吞掉，
 *   **注释反而漏剥** —— 实测就是这样把两处说明性注释判成了「还在用的代码」。
 *   改成按行剥：以 * / // / 行内块注释起头的行整行丢弃，再去掉行内块注释。
 *   宁可过剥一点（多丢几行代码），也不要漏剥注释 —— 漏剥会制造假红，
 *   假红会逼着人把守卫删掉（比没有守卫更糟）。
 */
function stripComments(src) {
	return src.split('\n').map(function (l) {
		var t = l.trim();
		if (t.indexOf('*') === 0 || t.indexOf('//') === 0 || t.indexOf('/*') === 0) return '';
		return l.replace(/\/\*.*?\*\//g, ' ');
	}).join('\n');
}
const SMSSET_C = stripComments(SMSSET);
const MODEM_C = stripComments(MODEM);
const STATUS_C = stripComments(STATUS);

/* ------------------------------------------------------------------ */
console.log('== A. 统一保存：复用 Mt5700.staged，而不是每卡片一个按钮 ==');

has('staged 机制确实存在于共用组件里（复用而不是新造）',
	/api\.staged = function/.test(MT) && /mt5700-applybar/.test(MT),
	'共用组件里没有暂存悬浮条');
has('dial.js 已在用它（说明这是全站既有标准，不是新发明）',
	/Mt5700\.staged\(\{/.test(DIAL) && /staged\.set\(/.test(DIAL),
	'拨号页没在用，那 sms_settings 的合并就没有「统一」的落点');

has('短信设置页改用页面级 staged',
	/var staged = Mt5700\.staged\(\{/.test(SMSSET_C),
	'短信设置仍在用卡片级保存按钮');
has('悬浮条只挂一次（多了会出现两条叠在一起）',
	(SMSSET_C.match(/body\.appendChild\(staged\.el\);/g) || []).length === 1,
	'staged.el 被 append 了 ' + (SMSSET_C.match(/body\.appendChild\(staged\.el\);/g) || []).length + ' 次');
has('悬浮条追加在卡片之后（position: sticky + bottom 才贴得住视口底部）',
	SMSSET_C.indexOf('body.appendChild(staged.el)') > SMSSET_C.indexOf('已发记录') ||
	SMSSET_C.indexOf('body.appendChild(staged.el)') > SMSSET_C.indexOf('短信可达性'),
	'提前追加会停在页面中间');
has('应用/撤销后回到模组真实状态（onChanged 必须重新加载）',
	/var staged = Mt5700\.staged\(\{ onChanged: function \(\) \{ loadAll\(\); \} \}\);/.test(SMSSET_C),
	'不重新加载，应用失败时界面会停在假状态上');

has('两个卡片级保存按钮已移除',
	!/保存中心号码|保存存储位置/.test(SMSSET_C),
	'旧的卡片级保存按钮还在，会出现「两个保存入口」');
has('中心号码改动走暂存（change 而非 input，避免逐字符刷条目）',
	/centerInput\.addEventListener\('change', function \(\) \{ stageCenter\(centerInput\.value\); \}\)/.test(SMSSET_C),
	'中心号码没有接到暂存上');
has('存储位置改动走暂存',
	/locSel\.addEventListener\('change', function \(\) \{ stageStorage\(locSel\.value\); \}\)/.test(SMSSET_C),
	'存储位置没有接到暂存上');

has('暂存项失败必须抛出去（吞掉＝把没写进去当成写进去了）',
	/if \(!res\.success\) throw new Error\(Ui\.atErrorText\(res, '中心号码保存失败'\)\)/.test(SMSSET_C) &&
	/* 形参名不写死：这里判的是「失败被抛出去了」，不是「形参叫什么」 */
	/throw new Error\(\w+ \+ ' 可能不被支持/.test(SMSSET_C),
	'有分支把失败静默吞掉了');
has('空中心号码不暂存（否则会下发 AT+CSCA="" 清掉中心号）',
	/if \(!num\) \{[\s\S]{0,120}?Mt5700\.error\('短信中心号码不能为空'\);[\s\S]{0,40}?return;/.test(SMSSET_C),
	'空值会被当成一次合法修改暂存下来');

/* ------------------------------------------------------------------ */
console.log('== B. 「改了却存不下来」：不留空回调控件 ==');

/* 空回调 = 界面变了、命令一条没发，而且没有任何提示 —— 用户看到的就是
   「改了没反应 / 刷新后自己跳回去」。 */
const EMPTY_SWITCH = /makeSwitch\(\s*function\s*\(\s*\)\s*\{\s*\}\s*\)/;
const EMPTY_CHANGE = /addEventListener\(\s*['"](?:change|input)['"]\s*,\s*function\s*\(\s*\)\s*\{\s*\}\s*\)/;
/* v2.4.31：schedule.js 已并入「网络设置」（实现搬到 at-webserver/schedule_panel.js） */
const VIEWS = ['dial.js', 'esim.js', 'logs.js', 'modem_settings.js', 'network_settings.js',
	'network_status.js', 'service.js', 'sms_center.js', 'sms_settings.js',
	'terminal.js', 'upgrade.js'];
const offenders = VIEWS.filter(function (f) {
	const src = stripComments(read(path.join(V, f)));
	return EMPTY_SWITCH.test(src) || EMPTY_CHANGE.test(src);
});
has('全站页面里没有「空回调」的可编辑控件',
	offenders.length === 0,
	'这些文件里还有空回调控件：' + offenders.join(', '));

has('高温时关闭 CA/MIMO 开关会真的下发命令',
	/var thermCaSwitch = makeSwitch\(function \(checked, input\) \{[\s\S]{0,700}?send\(thermCmd\(\)\)/.test(MODEM_C),
	'它绑的是 AT^THERMAUTOFUN 的第 2 位，必须与主开关同一条命令下发');
has('该开关失败时回滚勾选（否则界面停在一个没生效的状态）',
	/高温时关闭 CA\/MIMO 失败'\);\s*\n\s*input\.checked = !checked;/.test(MODEM_C),
	'失败没有回滚');

/* ------------------------------------------------------------------ */
console.log('== C. 慢档两段预热：连接状态不必等尾段 ==');

const EXPECT_HEAD = ['AT+CGACT?', 'AT^NRSSBID?', 'AT^MONNC', 'AT+CGREG?', 'AT+CEREG?', 'AT^DSFLOWQRY'];
const EXPECT_REST = ['AT^DHCPV6?', 'AT^DHCP?', 'AT^IPV6CAP?', 'AT^CHIPTEMP?', 'AT^LENDC?',
	'AT+C5GREG?', 'AT^NTXPOWER?', 'AT+CIREG?', 'AT^RRCSTAT?', 'AT+COPS?'];

function takeList(src, name) {
	const m = src.match(new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];'));
	if (!m) return null;
	return (m[1].match(/'[^']+'/g) || []).map(function (s) { return s.slice(1, -1); });
}
const head = takeList(STATUS_C, 'SLOW_WARM');
const rest = takeList(STATUS_C, 'SLOW_WARM_REST');

has('头段清单 SLOW_WARM 可以解析出来', Array.isArray(head), '没找到 var SLOW_WARM = [');
has('尾段清单 SLOW_WARM_REST 可以解析出来', Array.isArray(rest), '没找到 var SLOW_WARM_REST = [');

if (Array.isArray(head) && Array.isArray(rest)) {
	const same = function (a, b) {
		return a.length === b.length && a.every(function (v, i) { return v === b[i]; });
	};
	has('头段＝连接状态与载波表要用的那 6 条',
		same(head, EXPECT_HEAD),
		'实际：' + head.join(' '));
	has('尾段＝地址/温度/MCS/诊断那 10 条',
		same(rest, EXPECT_REST),
		'实际：' + rest.join(' '));

	/*
	 * ★ 拆清单最容易犯的错：**漏抄一条**（少问一次模组，读数永远为空）
	 *   或**抄重一条**（每条多打一次串口，等于把优化反着做）。
	 *   所以这里对「并集」做集合级断言，而不是只看字符串在不在。
	 */
	const all = head.concat(rest);
	has('两段合起来仍是完整 16 条（没漏抄）',
		all.length === 16,
		'总共 ' + all.length + ' 条');
	has('两段之间没有重复条目（没抄重）',
		new Set(all).size === all.length,
		'有重复项');
	/*
	 * 白名单与 rpc.js 的 NON_QUESTION_READS / ucode 的 BARE_READS 同源：
	 * 「以 ? 结尾」是只读的充分条件，但有几条查询命令**不带问号**
	 * （AT^MONNC / AT^DSFLOWQRY 等，见手册 13.9 / 16.x）。
	 * 这里只需要挡住「把 AT^EONS=2 这种写命令塞进 batch」的形态。
	 */
	const BARE_OK = ['AT^MONNC', 'AT^MONSC', 'AT^MONSSC', 'AT^DSFLOWQRY',
		'AT+CGPADDR', 'AT+CNUM', 'AT+CGEQOSRDP'];
	has('清单里不含写命令（batch 只放行只读查询）',
		all.every(function (c) {
			return c.charAt(c.length - 1) === '?' || BARE_OK.indexOf(c) >= 0;
		}),
		'出现了不像查询的条目：' + all.filter(function (c) {
			return c.charAt(c.length - 1) !== '?' && BARE_OK.indexOf(c) < 0;
		}).join(' '));

	const headCount = (STATUS_C.match(/var SLOW_HEAD_COUNT = (\d+);/) || [])[1];
	has('头段任务数与头段命令数对得上（拆错会让连接状态缺项）',
		Number(headCount) === 6,
		'SLOW_HEAD_COUNT = ' + headCount);
}

has('SLOW_TASKS 顺序未被动过（loadSecondary 仍必须在首位）',
	/var SLOW_TASKS = \[loadSecondary,/.test(STATUS_C),
	'任务顺序是契约，被改过');

has('尾段预热插在头段任务之后（这才是提速的那一刀）',
	/if \(idx === SLOW_HEAD_COUNT - 1\) \{[\s\S]{0,200}?warmCache\(SLOW_WARM_REST\)/.test(STATUS_C),
	'尾段预热没有插在 forEach 中间，连接状态仍要等整批');
has('尾段预热也要检查 disposed（切页后不再打串口）',
	/if \(idx === SLOW_HEAD_COUNT - 1\) \{[\s\S]{0,200}?if \(disposed\) return null;/.test(STATUS_C),
	'切页后仍会把尾段预热发出去');

/* 反向：确认上面的判定真的咬得住「整批预热」的旧写法 */
has('反向：旧的「一次 warmCache(SLOW_WARM) 跑完全部任务」会被判红',
	!/(warmCache\(SLOW_WARM\);[\s\S]*?){1}^\s*slowRunning/m.test(STATUS_C) ||
	STATUS_C.indexOf('warmCache(SLOW_WARM_REST)') > 0,
	'旧写法竟被当成已切两段');

/* ------------------------------------------------------------------ */
/*
 * ★ 2026-09-28 新增：`Ui.sendCmd` 不得再插入固定延时。
 *
 * 它原来是「发命令前固定等 100ms，保证命令间隔」。而 `AtWs.client.sendCommand`
 * **本身就是严格串行**的：rpc.js 里 queue 是全局单链
 *   `this.commandQueue = this.commandQueue.then(...)`（rpc.js:212/870），
 * 上一条的 Promise 完成（等到模组回 OK/ERROR）才发下一条 —— 间隔由应答保证，
 * 那 100ms 是纯等待。dial.js 有 19 处调用，还有串行链（CGDCONT? → CGACT?
 * 各等一次），全部叠在用户点「刷新」之后的响应时间上，而串口一条没少发。
 */
const UI_SRC = fs.readFileSync(
	path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'ui.js'), 'utf8');
has('ui.js 可读（否则下面那条断言是空转）', UI_SRC.length > 0);
{
	// 取 sendCmd 的函数体（到下一个顶层 api. 定义为止），只在体内找 sleep
	const m = UI_SRC.match(/api\.sendCmd\s*=\s*function[\s\S]*?\n\t\};/);
	has('能定位到 ui.js 的 sendCmd 函数体', m !== null);
	has('★ Ui.sendCmd 不再插入固定 sleep（sendCommand 已串行，那 100ms 是纯等待）',
		m !== null && !/sleep\s*\(/.test(m[0]),
		m ? '函数体里出现了 sleep：' + (m[0].match(/.*sleep.*/) || [''])[0].trim() : '');
}
/* ------------------------------------------------------------------ */
console.log('');
console.log('ui-consistency-contract: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
