#!/usr/bin/env node
'use strict';

/**
 * 短信竞态 + 前端安全 + 数值钳制 契约测试
 * ---------------------------------------------------------------------------
 * 这一轮修的都是「不报语法错、跑起来才出事」的问题，所以全部钉成静态守卫 + 纯函数行为测试。
 *
 * ① **长短信不能同时出现「残缺版 + 完整版」**（真机 BUG）
 *    长短信分段陆续到达，若在到齐前读取列表就会拼出残缺消息；随后服务端拼完整推送过来，
 *    若不剔除残缺项，同一条短信会在界面上出现两条（实测：刷新前多一条「2/4 段（部分缺失）」）。
 *
 * ② **AT 命令注入**（安全）
 *    前端是 AT 通道的唯一入口，用户输入拼进命令前必须过 Parse.sanitizeAtParam；
 *    否则 APN 填 `x\r\nAT+CFUN=0\r\n` 就能在设拨号参数的同时关掉射频。
 *
 * ③ **数值钳制**
 *    input 的 min/max 只是属性、不参与 JS 校验：端口填 99999 会被写进 UCI 并重载服务，
 *    CID 填 99 会让 AT+CGDCONT 必然 ERROR（手册 7.1：21~31 保留给网络，0 是默认 PDP）。
 *
 * ④ **页面卸载清理**
 *    LuCI 没有卸载钩子，各视图的 self._dispose 曾全仓库零调用点，切页后定时器持续累积。
 *
 * 用法：node tests/sms-concurrency-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver');
const A = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver');

function read(p) { return fs.readFileSync(p, 'utf8'); }
const PARSE = read(path.join(A, 'parse.js'));
const SMS = read(path.join(V, 'sms_center.js'));
const DIAL = read(path.join(V, 'dial.js'));
const UPG = read(path.join(V, 'upgrade.js'));
const MODEM = read(path.join(V, 'modem_settings.js'));
const SMSSET = read(path.join(V, 'sms_settings.js'));
const SVC = read(path.join(V, 'service.js'));
/* v2.4.31：定时锁频从独立页面归并进「网络设置」，实现搬到 at-webserver/schedule_panel.js。
   下面两条「下限」断言判的是那段编排代码本身，跟着实现走，而不是跟着菜单走。 */
const SCHED = read(path.join(A, 'schedule_panel.js'));
const MT = read(path.join(A, 'mt5700.js'));
const RUST = read(path.join(ROOT, 'src/rust/src/smsclean.rs'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  ok   ' + name); }
function no(name, why) { fail++; console.log('  ✗ ' + name + '  → ' + why); }
function has(name, cond, why) { cond ? ok(name) : no(name, why); }

/* ------------------------------------------------------------------ */
console.log('== A. 长短信竞态（真机 BUG） ==');

has('mergeConcatenated 会标出未收齐', /partialPending:\s*incomplete/.test(SMS),
	'未收齐的分段必须标记，否则无法与随后的完整消息区分');
has('推送完整消息时剔除同号码残缺项',
	/partialPending && normalizeNumber\(m\.number\) === msg\.number/.test(SMS),
	'不剔除就会出现「残缺版 + 完整版」两条');
has('有延迟补齐机制', /function schedulePartialRetry/.test(SMS), '分段未到齐时应自动重拉一次');
has('补齐有次数上限，不会无限重拉', /partialRetryLeft\s*<=?\s*0/.test(SMS) || /partialRetryLeft--/.test(SMS),
	'缺段若永久缺失，重试必须有上限');
has('补齐成功后复位重试配额', /else partialRetryLeft = 2;/.test(SMS) || /partialRetryLeft = 2;/.test(SMS),
	'否则下一条长短信就没有补齐机会了');
has('合并后保留未读标记', /anyUnread/.test(SMS) && /unread:\s*anyUnread/.test(SMS),
	'长短信各段的 unread 必须在合并后归并');
has('卸载时清理补齐定时器', /clearTimeout\(partialRetryTimer\)/.test(SMS), '切页后不应继续发 AT');

/* ------------------------------------------------------------------ */
console.log('== B. 发送与删除 ==');

has('发送有 in-flight 守卫', /if \(sending\) return;/.test(SMS) && /sending = true;/.test(SMS),
	'回车发送绕得开按钮 disabled，长短信多片下发期间会并行插入多组 AT+CMGS');
has('守卫在函数末尾复位', /sending = false; sendBtn\.disabled = false;/.test(SMS), '不复位会永久锁死发送');
has('单条删除检查 AT 成败', /AT\+CMGD=.*[\s\S]{0,200}res\.success === false/.test(SMS) || /delFail\+\+/.test(SMS),
	'不判 success 会「提示删除成功、模组上还在」');
/* ★ 2026-09-28：报数收口到 reportDeleteResult(s)，变量从 delFail 改为 s.fail。
   意图不变：必须报真实删掉的条数，不能拿勾选数当成功。 */
has('批量删除按真实结果报数',
	/function reportDeleteResult\(s\) \{/.test(SMS) &&
	/if \(s\.fail\) Mt5700\.error\('删除/.test(SMS) &&
	/Mt5700\.success\('成功删除 ' \+ s\.ok \+ ' 条短信'/.test(SMS),
	'不应按勾选条数报成功');
has('批量删除弹窗可被卸载清理', /openMask/.test(SMS) && /removeChild\(openMask\)/.test(SMS),
	'弹窗挂在 body 上，切页会残留并挡住后续页面');

/* ------------------------------------------------------------------ */
console.log('== C. AT 命令注入防护（安全） ==');

const m = PARSE.match(/var Parse = \((function[\s\S]*?\n\})\)\(\);/);
if (!m) { no('提取 Parse 模块', 'parse.js 结构变了'); }
else {
	/* eslint-disable no-eval */
	const Parse = eval('(' + m[1] + ')')();
	const sp = Parse.sanitizeAtParam;
	has('存在 sanitizeAtParam', typeof sp === 'function', 'parse.js 缺少参数转义函数');
	if (typeof sp === 'function') {
		has('剥掉引号', sp('a"b') === 'ab', '得到 ' + JSON.stringify(sp('a"b')));
		has('剥掉换行（防续接第二条命令）', sp('a\r\nAT+CFUN=0') === 'aAT+CFUN=0',
			'得到 ' + JSON.stringify(sp('a\r\nAT+CFUN=0')));
		has('剥掉分号与逗号', sp('a;b,c') === 'abc', '得到 ' + JSON.stringify(sp('a;b,c')));
		has('null/ undefined 兜底', sp(null) === '' && sp(undefined) === '', '应回落空串');
		has('保留加号（国际号码）', sp('+8613800755500') === '+8613800755500', '不应吃掉 +');
	}
	const ip = Parse.isValidIPv4;
	has('存在 isValidIPv4', typeof ip === 'function', 'parse.js 缺少 IP 校验');
	if (typeof ip === 'function') {
		has('接受正常 IP', ip('192.168.1.1') === true, '192.168.1.1 应合法');
		has('拒绝 999.999.999.999', ip('999.999.999.999') === false, '只约束形状的正则会放行它');
		has('拒绝 256 段', ip('256.1.1.1') === false, '逐段必须判 0-255');
		has('拒绝三段', ip('1.2.3') === false, '段数必须为 4');
	}
}

has('APN/用户名/密码过转义', /sanitizeAtParam\(apnForm\.apn\)/.test(DIAL) && /sanitizeAtParam\(apnForm\.password\)/.test(DIAL),
	'dial.js 的 AT^SETAUTODIAL 直接拼自由文本');
has('PDP 参数过转义', /sanitizeAtParam\(values\.apn/.test(DIAL) && /sanitizeAtParam\(values\.pdp_addr/.test(DIAL),
	'dial.js 的 AT+CGDCONT 直接拼自由文本');
has('PDP 地址加引号', /sanitizeAtParam\(values\.pdp_addr \|\| ''\) \+ '",0,0'/.test(DIAL),
	'<PDP_addr> 是字符串参数，不加引号填了地址就 ERROR');
has('CID 上限为 20', /cid > 20/.test(DIAL), '手册 7.1：21~31 保留给网络，超过必然 ERROR');
/*
 * 下面两条钉的是「CID 0 可编辑、不可删除」，分开写是因为它们由不同代码保证。
 * 注意别用 /默认承载/ 之类匹配整篇 —— 解释性注释里也写了这个词，断言会恒真
 * （ui-contract 的「网络时间」那条就是这么失效的）。要钉到具体函数/表达式上。
 */
/*
 * 「列表不再隐藏 CID 0」必须只看过滤那一句。整篇搜 /cid !== 0/ 会命中
 * renderPDP 里「对 CID 0 摘掉删除按钮」的判断 —— 那是想要的，不是要挡的。
 */
const PDP_FILTER = DIAL.split('pdpList = list.filter')[1].split(';')[0];
has('列表不再隐藏 CID 0', !/cid !== 0/.test(PDP_FILTER),
	'CID 0 可改 APN（物联网卡要用），整行藏掉等于堵死改默认承载的唯一入口');
const DEL_FN = DIAL.split('function handleDeletePdp')[1].split('\n\t\tfunction ')[0];
has('删除入口挡住 CID 0', /cid === 0/.test(DEL_FN) && /return/.test(DEL_FN),
	'AT+CGDCONT=0 必然 ERROR，按钮之外被别的入口调到也要挡住');
has('FOTA 地址过转义', /sanitizeAtParam\(formatted\)/.test(UPG), '只校验 http:// 前缀挡不住引号/换行');
/*
 * PIN 码必须过转义。这里钉的是**语义**——凡是拼进 AT+CPIN/AT+CLCK 的值都得
 * 先 sanitizeAtParam()，而不是钉某个变量名：早先断言写的是 values.pin（弹窗
 * 取值），PIN 区改成内联输入框、值来自局部变量后就误报了，但转义本身没丢。
 * 取「包含命令拼接的语句」逐条检查，比匹配单个变量名稳。
 */
const pinStmts = MODEM.split(/[;\n]/).filter(function (s) {
	return /AT\+CPIN="|AT\+CLCK="SC",/.test(s) && /'\s*\+/.test(s);
});
has('PIN 码过转义 —— 拼进 AT+CPIN/AT+CLCK 的每条语句都过 sanitizeAtParam',
	pinStmts.length > 0 && pinStmts.every(function (s) { return /sanitizeAtParam\(/.test(s); }),
	'存在未过转义就直接拼进 AT+CPIN/AT+CLCK 的语句：' +
	JSON.stringify(pinStmts.filter(function (s) { return !/sanitizeAtParam\(/.test(s); })));
has('PUK 解锁同样过转义',
	/AT\+CPIN="[^;]*sanitizeAtParam\(puk\)/.test(MODEM),
	'PUK 也是自由输入，直接拼可注入第二条 AT 命令');
has('PIN 输入有格式校验（4-8 位数字）',
	/\\d\{4,8\}/.test(MODEM), '不校验会把非法值直接发给模组，白白消耗 PIN 尝试次数');
has('短信中心号码过转义', /sanitizeAtParam\(num\)/.test(SMSSET) || /sanitizeAtParam\(centerInput\.value/.test(SMSSET),
	'中心号码直接拼进 AT+CSCA');
has('Text 模式号码滤非数字', /replace\(\/\[\^\\d\+\]\/g, ''\)/.test(read(path.join(A, 'smsEncode.js'))),
	'号码带引号会破坏 AT+CMGS 命令结构');

/* ------------------------------------------------------------------ */
console.log('== D. 数值钳制 ==');

has('service.js 有 clampInt', /function clampInt/.test(SVC), '端口钳制引用了它，缺定义会 ReferenceError');
has('网络端口被钳制', /clampInt\(netPortInput\.value, 1, 65535/.test(SVC), '填 99999 会让后端绑端口失败');
has('RPC 端口被钳制', /clampInt\(wsPortInput\.value, 1, 65535/.test(SVC), '同上');
has('检测间隔有下限', /Math\.max\(10, parseInt\(checkIntervalInput\.value/.test(SCHED),
	'min 属性只在表单提交时生效，键入 1 会让后端按 1 秒周期抢串口');
has('无服务超时有下限', /Math\.max\(30, parseInt\(timeoutInput\.value/.test(SCHED), '同上');

/* ------------------------------------------------------------------ */
console.log('== E. 页面卸载清理 ==');

has('Mt5700.page 提供 _onDispose', /node\._onDispose = function/.test(MT), '缺少注册入口');
has('卸载判据是「曾进入文档、现已脱离」', /wasInDoc/.test(MT),
	'只判「现在不在文档里」会把尚未插入文档的页面误清');
has('confirm 支持取消回调', /if \(onCancel\) onCancel\(\);/.test(MT),
	'否则「加确认」后取消会让开关状态与实际不符');
['network_status.js', 'upgrade.js', 'logs.js', 'network_settings.js', 'sms_center.js'].forEach((n) => {
	has(n + ' 注册了卸载钩子', /page\._onDispose\(self\._dispose\);/.test(read(path.join(V, n))),
		'切页后定时器/订阅会持续累积并抢独占串口');
});
/* v2.4.31：定时锁频不再是独立页面，但它的 15s 轮询仍在 —— 必须由宿主页面卸载时收掉。
   这条替换了原来「schedule.js 注册了卸载钩子」，判据换成实际入口，不靠文件名。 */
has('定时锁频面板的轮询由宿主页面卸载时清理',
	/SchedulePanel\.dispose\(\);/.test(read(path.join(V, 'network_settings.js'))),
	'归并后若漏调 dispose，切页后 15s 轮询会继续攒在单线程 rpcd 上');

/* ------------------------------------------------------------------ */
console.log('== F. 其他确凿缺陷 ==');

has('PIN 未就绪不再谎报 READY', !/if \(!ready\) pinStatusEl\.textContent = 'PIN 状态：READY'/.test(MODEM),
	'卡等输 PIN 时会被显示成 READY，用户无从下手');
has('PIN 正则能匹配 "SIM PIN"', /\\\+CPIN:\\s\*\(\[A-Za-z \]\+\)/.test(MODEM),
	'(\\w+) 匹配不到空格，只能解出 SIM');
/*
 * ★ 2026-09-28 判据收紧/放宽各一处：
 *   ① 距离上限原为 {0,300} —— 但那条 `.then` 与 `res.success === false` 之间
 *      允许写注释，而注释是**会变长**的（本轮就因为在中间补了一段说明而误报）。
 *      这与本文件 G 组开头批评过的「断言绑死具体写法、换个等价写法就误报」是同一类
 *      脆弱：距离本身不是契约，**语义**才是。故放宽到 1500，只用来圈定范围。
 *   ② 断言理由里一直写着「且 fwupSent 已封死重试」，但**从来没有断言过复位** ——
 *      补上。那才是这条链真正会卡死的地方：case 40 先置位、失败后不复位，
 *      下一轮 `if (fwupSent) break;` 让流程永远停在「固件下载完成」。
 */
has('AT^FWUP 检查成败', /AT\^FWUP'\)\.then\(function \(res\)[\s\S]{0,1500}res\.success === false/.test(UPG),
	'不判 success 会把下发被拒报成「升级已开始」，且 fwupSent 已封死重试');
has('AT^FWUP 失败后复位 fwupSent',
	/res\.success === false[\s\S]{0,300}fwupSent = false/.test(UPG),
	'不复位 → tick 的 case 40 命中 if (fwupSent) break，既不重发也进不了 50/70，界面卡在「下载完成」');
has('清空短信不再漏第一个存储', /\+CPMS:\\s\*\(\.\*\)/.test(SMSSET),
	'旧正则要求存储名前有逗号，而第一个存储紧跟 ": "');
has('清空短信检查成败', /missed\) Mt5700\.error\('清空/.test(SMSSET), '不检查就报「已清空」');
has('锁定邻区捕获构建异常', /catch \(err\)[\s\S]{0,160}构建锁频命令失败/.test(read(path.join(V, 'network_settings.js'))),
	'buildLockCommand 抛错逃出点击回调会表现为「点了没反应」');
/*
 * 上限仍要在，但**判据换成不依赖具体算术写法**：原来断言
 * `entries.splice(0, entries.length - 300)`，那是把「上限」和「溢出算法」绑在一起，
 * 换个等价写法就误报。真正的约束是两件事：
 *   ① 有个条数上限常量；② 超限后确实从数组头部裁掉（splice 的起点必须是 0）。
 * 增量渲染之后还要多一条：DOM 侧也要按溢出量摘节点，否则数组裁了、DOM 照涨。
 */
const TERM = read(path.join(V, 'terminal.js'));
has('终端输出有上限', /MAX_LINES\s*=\s*\d+/.test(TERM), '没有条数上限，entries 会无限增长');
has('终端超限从头部裁剪', /entries\.splice\(0,\s*overflow\)/.test(TERM),
	'超限必须从数组头部裁，否则丢的是最新一条');
has('终端溢出时同步摘掉 DOM 节点', /consoleEl\.removeChild\(consoleEl\.firstChild\)/.test(TERM),
	'数组裁了但 DOM 不摘，节点照样越攒越多');
has('飞行模式二次确认', /开启飞行模式会立即关闭射频/.test(MODEM), 'AT+CFUN=0 误点等于整机断网');

/* ------------------------------------------------------------------ */
console.log('== G. 短信自动清理（后端，保守策略） ==');

/*
 * 钉排序**语义**而不是某一种写法：
 *   - 主键不能是存储索引（e.0）—— 存储位置会被复用，索引小不代表时间早；
 *   - 必须含时间戳分量（a.1/b.1）—— 新旧只能按短信中心时间比；
 *   - 已读标志（a.2/b.2）必须参与排序且排在时间之前 —— 已读的先腾。
 * 写成正则匹配整条 sort_by_key 表达式的话，换个等价写法就会误报。
 */
const sortExpr = (RUST.match(/entries\.sort_by\([^;]*\);/) || [''])[0];
has('清理用的排序表达式可定位到', sortExpr.length > 0, '找不到 entries.sort_by(…)');
has('清理顺序以短信中心时间为准', /a\.1\.cmp\(&b\.1\)/.test(sortExpr), '必须按短信中心时间、不是存储索引');
has('清理不把存储索引当排序键', !/\.0\.cmp|\.0\)/.test(sortExpr), '存储位置会被复用，索引小不代表时间早');
has('已读短信优先于未读被清理', /b\.2\.cmp\(&a\.2\)\s*\.then/.test(sortExpr), '不该先删用户没看过的短信');
has('单次删除有上限', /MAX_DELETE_PER_ROUND/.test(RUST), '不能为收一条把收件箱清空');
has('取不到时间就不删', /宁可不删|取不到时间|is_empty\(\)/.test(RUST), '存储位置会被复用，索引小不代表时间早');
has('非 PDU 模式跳过而非强切', /非 PDU 模式/.test(RUST), 'AT+CMGF 是全局设置，临时切换会干扰其它操作');
has('每条删除都查应答', /r\.ok\(\) => deleted \+= 1/.test(RUST), '被拒不能计入删除条数');

/* ------------------------------------------------------------------ */
console.log('== H. 收件箱归并：同一条短信不能同时来自两个来源各留一份（真机 BUG） ==');

/*
 * 现象：10086 的流量短信在会话里出现两条一模一样的，刷新页面后只剩一条。
 *
 * 取证：
 *   - 模组里那条短信是 4 段长短信（AT+CMGL=4 实读：index 4/5/7/8，同一拼接引用号），
 *     合并后应当是**一条**；
 *   - 通知日志里这一时刻只有一条记录（notify.rs 不去重），说明服务端只推了一次 new_sms；
 *   所以第二条不是网络重传，是「列表一份 + 推送一份」在页面里各留了一份：
 *   两条路各自 concat 拼数组，谁也不知道对方已经把这条画出来了。
 *
 * 契约：两条记录「是不是同一条」只能有一个归属地（buildContacts 里归一次），
 * 判定规则本身要能被拿出来单测 —— 下面是纯行为断言，不依赖 DOM。
 */

const H_START = SMS.indexOf('var SAME_SMS_WINDOW_MS');
const H_END = SMS.indexOf('function buildContacts');
has('归并区块可定位（身份判定 + 归并策略）', H_START > 0 && H_END > H_START,
	'找不到「SAME_SMS_WINDOW_MS … buildContacts」这一段');

if (H_START > 0 && H_END > H_START) {
	const H_SRC = SMS.slice(H_START, H_END);
	const pm = PARSE.match(/var Parse = \((function[\s\S]*?\n\})\)\(\);/);
	let H = null;
	if (!pm) {
		no('提取 Parse 供归并使用', 'parse.js 结构变了');
	} else {
		/* eslint-disable no-eval */
		const parseApi = eval('(' + pm[1] + ')')();
		/*
		 * new Function 而不是 eval：这段源码里有函数声明，eval 在严格模式下会把它们
		 * 关进自己的作用域，外面取不到；包一层 Function 显式 return 出来才测得着。
		 */
		const factory = new Function('Parse', 'normalizeNumber', H_SRC +
			'\n; return { mergeSmsDuplicates: mergeSmsDuplicates, isSameSms: isSameSms, partIndicesOf: partIndicesOf, keepRicher: keepRicher };');
		try {
			H = factory(parseApi, function (n) { return parseApi.normalizePhoneNumber(n); });
		} catch (e) {
			no('归并能独立求值', String(e && e.message));
		}
	}

	if (H) {
		const TRAFFIC = '尊敬的客户，截止2026年09月27日21点33分，您的流量使用情况如下：\n当月流量总量917GB【中国移动】';
		// 来源 A：AT+CMGL 列表里那条（长短信合并后带 partIndices，删得掉）
		const fromList = {
			index: 5, partIndices: [4, 5, 7, 8], content: TRAFFIC,
			number: '10086', time: '26/09/27,21:33:13', type: 'received', unread: false
		};
		// 来源 B：new_sms 推送那条（长短信不带槽位，index 是负数占位）
		const fromPush = {
			index: -1699999999999, content: TRAFFIC,
			number: '10086', time: '2026-09-27 21:33:13', type: 'received', unread: true
		};

		const m1 = H.mergeSmsDuplicates([fromList, fromPush]);
		has('列表一份 + 推送一份 → 只剩一条', m1.length === 1, '得到 ' + m1.length + ' 条');
		/*
		 * 留谁有讲究：推送那条没有物理槽位，留它的话「删除」会落到已发缓存分支，
		 * 提示删除成功而模组上的短信还在（这条旧账已经记过一次）。
		 */
		has('保留的是能删的那条（带存储槽位）',
			m1.length === 1 && m1[0].partIndices && m1[0].partIndices.length === 4,
			JSON.stringify(m1.map((x) => x && x.partIndices)));
		has('归并不得丢掉未读（推送那份标了未读）', m1.length === 1 && m1[0].unread === true,
			'丢掉就会「新短信来了却不显示未读」');
		const m2 = H.mergeSmsDuplicates([fromPush, fromList]);
		has('推送先到、列表后到也是一条', m2.length === 1, '得到 ' + m2.length + ' 条');
		has('不论先后都留能删的那条', m2.length === 1 && !!m2[0].partIndices, '顺序不同结果就该不同，不对');

		/*
		 * 只差 3 秒也算两条 —— 这条单独钉「槽位优先」那条规则：
		 * 离开了它，时间窗也会把这两条判成同一条，于是这条规则自己被架空，
		 * 变异到它身上时不判红（两条防线互为冗余时，一条失效另一条还挡着）。
		 */
		const nearA = { index: 4, content: TRAFFIC, number: '10086', time: '26/09/27,21:33:13', type: 'received' };
		const nearB = { index: 6, content: TRAFFIC, number: '10086', time: '26/09/27,21:33:16', type: 'received' };
		has('槽位不同时，内容相同且只隔 3 秒也是两条', H.mergeSmsDuplicates([nearA, nearB]).length === 2,
			'两条都占着各自的槽位 → 是两条物理短信，并掉就等于删不干净');
		// 两条真的短信（槽位不同、内容碰巧一样）不能被并掉 —— 并掉就是漏短信
		const realA = { index: 4, content: TRAFFIC, number: '10086', time: '26/09/27,21:33:13', type: 'received' };
		const realB = { index: 9, content: TRAFFIC, number: '10086', time: '26/09/27,22:10:05', type: 'received' };
		has('两条落在不同槽位的短信保持两条', H.mergeSmsDuplicates([realA, realB]).length === 2,
			'槽位会被复用，只比内容会把两条真短信并成一条');
		// 都没有槽位时靠时间窗区分：过了 19 分钟肯定是另一条，不是同一个来源的两个拷贝
		const pushA = { index: -1, content: TRAFFIC, number: '10086', time: '26/09/27,21:33:13', type: 'received' };
		const pushB = { index: -2, content: TRAFFIC, number: '10086', time: '26/09/27,21:52:41', type: 'received' };
		has('无槽位时按时间窗区分，隔 19 分钟是两条', H.mergeSmsDuplicates([pushA, pushB]).length === 2,
			'时间窗开太大就会吞掉重复收到的真短信');
		// 内容不同 → 一定不是同一条
		const other = { index: -3, content: TRAFFIC + '（另外一条）', number: '10086', time: '26/09/27,21:33:13', type: 'received' };
		has('内容不同不会并成一条', H.mergeSmsDuplicates([pushA, other]).length === 2, '内容不同就该是两条');
		// 号码不同 → 一定不是同一条（哪怕内容和时间都一样）
		const someone = { index: -4, content: TRAFFIC, number: '10010', time: '26/09/27,21:33:13', type: 'received' };
		has('号码不同不会并成一条', H.mergeSmsDuplicates([pushA, someone]).length === 2, '不同号码不能混');
		// 已发短信不参与归并（它们只来自本地缓存，重复是另一回事）
		const sent1 = { index: -5, content: '已发', number: '10086', time: '26/09/27,21:00:00', type: 'sent' };
		const sent2 = { index: -6, content: '已发', number: '10086', time: '26/09/27,21:00:00', type: 'sent' };
		has('已发短信不参与归并', H.mergeSmsDuplicates([sent1, sent2]).length === 2, '收到的才会两个来源并存');
	}
}

/*
 * 静态：归并必须只有一个入口。判据分散到各个调用点就又会各漂移一份，
 * 这正是这次 BUG 的形状 —— 所以它不是一个「写好了就行」的补丁，而是个位置契约。
 */
has('buildContacts 第一步就归并',
	/function buildContacts\(list\) \{\s*\n\s*list = mergeSmsDuplicates\(mergeConcatenated\(list\)\);/.test(SMS),
	'必须在拼 grouping 之前归并，否则两个来源还会有各自的认定');
has('归并只有一个调用点（消除岔路后再各自漂移）',
	SMS.split('mergeSmsDuplicates(').length - 1 === 2,
	'出现 ' + (SMS.split('mergeSmsDuplicates(').length - 1) + ' 次，应为「定义 1 + 调用 1」');

/* 推送侧的两个诱因：时间口径不一致、观看中的会话被重复标未读 */
has('推送时间换算成与列表同一种写法',
	/Parse\.formatPDUTime\(Parse\.parseMessageTime\(d\.time\)\)/.test(SMS),
	'推送是 2026-09-27 21:33:13、列表是 26/09/27,21:33:13，不归一看着就像两条短信');
has('正在看的会话不再标未读',
	/var watching = /.test(SMS) && /if \(!watching\) markUnread\(msg\.number\);/.test(SMS),
	'当面落下来的短信标未读 = 刚看完又冒红点');
has('会话里逐条标出未读', /if \(m\.unread\) \{[\s\S]{0,120}Mt5700\.badge\('未读'/.test(SMS),
	'此前只有左侧有个总数，打开会话看不出哪几条是新的');

/* ------------------------------------------------------------------ */
console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
