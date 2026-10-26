#!/usr/bin/env node
/*
 * 网络制式文案 / 连接状态标题 契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 背景（2026-09-17 真机 + 手册双查证）：
 *   AT^SYSINFOEX 的 <sysmode> 合法值只有 0/1/3/5/6/11（11 = NR-5GC），
 *   AT^MONSC / AT^HCSQ 只返回裸 "NR" —— 模组**没有任何 5G-Advanced 字段**。
 *   所以「5GA-NR」只能是启发式：NR + 聚合载波数 ≥ 2（用户拍板的规则）。
 *
 * 这里把 systemModeLabel 抽出来真跑一遍，而不是用正则匹配源码 ——
 * 判定逻辑的自相矛盾只有跑起来才看得见（先例：diagnostics 的「一般」配「全部正常」）。
 *
 * 运行：node tests/sysmode-label.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources',
	'view', 'at-webserver', 'network_status.js');
const src = fs.readFileSync(JS, 'utf8');

/*
 * NSA 判据要吃 rpc.js 的载波解析：^HFREQINFO 的 **per-carrier <sysmode>**
 * 才是「NR 侧是否真的在用」的证据（见本文件末尾的 NSA 段）。
 */
const RPC = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources',
	'at-webserver', 'rpc.js');
const rpcSrc = fs.readFileSync(RPC, 'utf8');

const log = [];
function say(s) { log.push(s); }

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; say('  ✓ ' + label); return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
	say('  ✗ ' + label + (extra ? '  → ' + extra : ''));
}

function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name + '（是否改过名？请同步本测试）');
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}

const labelFactory = new Function(
	extractFn(src, 'hasPsService') + '\n' +
	extractFn(src, 'systemModeLabel') + '\nreturn systemModeLabel;');
const label = labelFactory();
const hasPs = new Function(
	extractFn(src, 'regRank') + '\n' +
	extractFn(src, 'hasPsService') + '\nreturn hasPsService;')();
const hasAny = new Function(
	extractFn(src, 'regRank') + '\n' +
	extractFn(src, 'normStat') + '\n' +
	extractFn(src, 'hasPsService') + '\n' +
	extractFn(src, 'hasAnyPsService') + '\nreturn hasAnyPsService;')();
const norm = new Function(
	extractFn(src, 'normStat') + '\nreturn normStat;')();

/*
 * 制式判定的四件套。★ `HFREQ_SYS_MODE` 直接从 rpc.js 源码抽那一行，**不在这里再造
 * 一套同名表** —— 早前 rpc.js 与 parse.js 各存一套、改一处另一处纹丝不动的教训
 * （见 rpc.js:1243 的删除说明）就是这么来的。
 */
const hfreqVar = rpcSrc.match(/var HFREQ_SYS_MODE = \{[^}]*\};/);
if (!hfreqVar) throw new Error('找不到 HFREQ_SYS_MODE（是否改过名？请同步本测试）');
const parseHFREQINFO = new Function(
	extractFn(rpcSrc, 'extractATDataMultiline') + '\n' + hfreqVar[0] + '\n' +
	extractFn(rpcSrc, 'parseHFREQINFO') + '\nreturn parseHFREQINFO;')();

const R = new Function(
	extractFn(src, 'hasPsService') + '\n' +
	extractFn(src, 'nrCarrierCount') + '\n' +
	extractFn(src, 'systemModeLabel') + '\n' +
	extractFn(src, 'aggregationBadge') + '\n' +
	extractFn(src, 'ratDisplay') + '\n' +
	'return { systemModeLabel: systemModeLabel, ratDisplay: ratDisplay,'
	+ ' nrCarrierCount: nrCarrierCount, aggregationBadge: aggregationBadge };')();

say('=== 制式文案（后缀必须跟随真实 sysMode） ===');

/* 用户拍板的规则：NR + 载波 ≥ 2 → 5GA-NR */
ok('NR + 2 载波 → 5GA-NR', label('NR', 2) === '5GA-NR', label('NR', 2));
ok('NR + 3 载波 → 5GA-NR', label('NR', 3) === '5GA-NR', label('NR', 3));
ok('NR + 1 载波 → 5G-NR', label('NR', 1) === '5G-NR', label('NR', 1));
ok('NR + 0 载波 → 5G-NR（无聚合不该报 5GA）', label('NR', 0) === '5G-NR', label('NR', 0));
ok('NR-5GC 也算 NR（^SYSINFOEX 的字符串形态）',
	label('NR-5GC', 2) === '5GA-NR', label('NR-5GC', 2));
ok('小写 nr 也能识别', label('nr', 2) === '5GA-NR', label('nr', 2));

/* 后缀跟随数据：绝不能把 LTE 标成 NR */
ok('LTE → 4G-LTE（载波再多也不变 5G）', label('LTE', 3) === '4G-LTE', label('LTE', 3));
ok('WCDMA → 3G-WCDMA', label('WCDMA', 2) === '3G-WCDMA', label('WCDMA', 2));
ok('GSM → 2G-GSM', label('GSM', 2) === '2G-GSM', label('GSM', 2));

/* 兜底：不认识的制式原样返回裸值，不编造代际 */
ok('未知制式原样返回（不编代际）', label('FOOBAR', 2) === 'FOOBAR', label('FOOBAR', 2));
ok('空值 → —', label('', 0) === '—', JSON.stringify(label('', 0)));
ok('null → —', label(null, 2) === '—', JSON.stringify(label(null, 2)));

/*
 * ★ 2026-09-20 真机 bug：卡上没有 Profile 时 AT+CEREG 报「未注册，正在搜索」，
 *   但 ^SYSINFOEX 的 <sysmode> 仍残留着上一次的 NR —— 页面于是显示「5G-NR」，
 *   看着像驻留在 5G 上，其实一格信号都没有。制式必须跟着「是否真驻留」走。
 */
say('');
say('=== 未注册时不得显示残留制式 ===');

ok('★ 未注册 → —（不显示模组残留的 NR）',
	label('NR', 2, false) === '—', label('NR', 2, false));
ok('★ 未注册时 LTE 也要抹掉', label('LTE', 1, false) === '—', label('LTE', 1, false));
ok('已注册 → 照常出制式', label('NR', 2, true) === '5GA-NR', label('NR', 2, true));
/* 第三参缺省（老调用方）不能误伤成「未注册」 */
ok('第三参省略时按「有服务」处理（不误抹）',
	label('LTE', 1) === '4G-LTE', label('LTE', 1));

say('');
say('=== hasPsService：CGREG 状态码判定 ===');

ok('stat=1（已注册）→ true', hasPs(1, {}) === true);
ok('stat=5（已注册漫游）→ true', hasPs(5, {}) === true);
ok('stat=0（未注册）→ false', hasPs(0, { mcc: '460' }) === false);
ok('stat=2（正在搜索）→ false', hasPs(2, { mcc: '460' }) === false);
ok('stat=3（注册被拒）→ false', hasPs(3, { mcc: '460' }) === false);
/* null = 这一轮没取到，退化看 MCC：未注册时 MONSC 的 MCC 是 000 */
ok('stat=null + MCC=000 → false（退化判据仍认得出没服务）',
	hasPs(null, { mcc: '000' }) === false);
ok('stat=null + MCC=460 → true（一次查询失败不能抹掉制式）',
	hasPs(null, { mcc: '460' }) === true);

say('');
say('=== hasAnyPsService：CEREG 为准、CGREG 兜底 ===');

ok('★ CEREG=2（未注册）→ false（本 bug 的正解）',
	hasAny(2, null, { mcc: '000' }) === false);
ok('CEREG=1（已注册）→ true', hasAny(1, null, {}) === true);
ok('CEREG=5（漫游已注册）→ true', hasAny(5, null, {}) === true);
ok('★ CEREG=0 但 CGREG=1 → true（纯 LTE/NR 下 CGREG 会恒报 0，不能误判没服务）',
	hasAny(null, 1, { mcc: '460' }) === true);
ok('CEREG 未知 + CGREG=2 → false', hasAny(null, 2, { mcc: '460' }) === false);
ok('两条都未知 + MCC=460 → true', hasAny(null, null, { mcc: '460' }) === true);
ok('两条都未知 + MCC=000 → false', hasAny(null, null, { mcc: '000' }) === false);
ok('★ CEREG 优先于 CGREG：CEREG=1 与 CGREG=0 冲突时听 CEREG',
	hasAny(1, 0, {}) === true);

say('');
say('=== normStat：AT 响应里的字符串 stat ===');

ok('"2" → 2', norm('2') === 2);
ok('空串 → null（不拿 0 冒充「未注册」）', norm('') === null);
ok('null → null', norm(null) === null);
ok('非数字 → null', norm('abc') === null);

say('');
say('=== 连接状态标题带运营商 ===');

ok('connCard 取了标题节点', /connTitleEl\s*=\s*connCard\.querySelector\('\.mt5700-card-title'\)/.test(src));
ok('标题拼成「连接状态 ・ <运营商>」', /'连接状态 ・ '\s*\+\s*op/.test(src));
ok('未知运营商不拼进标题（免得标题变长还无意义）',
	/state\.operator\s*!==\s*'未知运营商'/.test(src));
ok('renderConn 里刷新标题（运营商是慢档才拿到的）',
	extractFn(src, 'renderConn').indexOf('connTitleEl') !== -1);
/* 2026-10-26 去重：连接状态卡里的「网络制式」格已删（结论卡卡头已在显示制式），
   这条不放松，只是改盯**现存的调用点** —— 结论卡里的那次 ratDisplay。
   四路输入仍要齐：制式 / 载波 / EN-DC / 是否真驻留（本处由 registered 传入，
   而 registered 必须来自 hasAnyPsService 的判定，不能是别的近似值）。 */
ok('★ 制式走统一判定入口 ratDisplay，并传齐四路输入（制式 / 载波 / EN-DC / 是否真驻留）',
	/ratDisplay\(cell\.sysMode,\s*state\.carriers,\s*state\.diag\s*&&\s*state\.diag\.endc,\s*registered\s*===\s*true\)/.test(src));
ok('★ 第四路「是否真驻留」来自 hasAnyPsService（不是随手取个布尔）',
	/registered\s*=\s*hasAnyPsService\(/.test(src));
ok('★ 制式只由 ratDisplay 产出（页面上不出现第二处拼装）',
	!/['"]5GA-NR['"]/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));

/*
 * ===========================================================================
 * ★ 2026-09-29 真机 bug：NSA(EN-DC) 下界面把 5G 显示成「4G-LTE」
 * ---------------------------------------------------------------------------
 * 根因：AT^MONSC 在 NSA 下报的是 **LTE 锚点**小区，而制式判定只吃了它的
 *   <sysmode>，于是判成 LTE。此刻 NR 其实已经在用，同一轮三条独立证据：
 *     ^LENDC: 1,1,1,0,1   → <nr_pscell>=1，EN-DC 已建立
 *     ^HFREQINFO: 0,7,41,…→ 上报了 sysmode=7(NR) 的载波
 *     ^MONSSC: NR,504990,…→ NR 辅连接服务小区
 *   → 判据必须是「NR 侧是否真的在用」，不能只看锚点制式。
 *
 * 下面用**真机原始回显**驱动，而不是手搓中间态 —— 链路里任何一环（^HFREQINFO
 * 的分组 / 载波 sysMode / 判定入口）回归都会让这一段转红。
 * ===========================================================================
 */

/* 真机原文（2026-09-29，NSA/EN-DC）。★ <Cell_ID>/<TAC> 已替换为合成值：
   它们能粗略定位台站，而本仓已公开；制式判定与它们无关。 */
const NSA_MONSC = '^MONSC: LTE,460,00,1300,00A1B2C3E,128,00A1B2C,-70,-6,-44\r\nOK';
const NSA_HFREQ = '^HFREQINFO: 0,6,3,1300,18150,20000,19300,17200,20000\r\n'
	+ '^HFREQINFO: 0,7,41,513000,2565000,100000,513000,2565000,100000\r\nOK';
/* 纯 LTE 对照：只有一条 LTE 载波、没有 NR */
const LTE_ONLY_HFREQ = '^HFREQINFO: 0,6,3,1300,18150,20000,19300,17200,20000\r\nOK';

const nsCarriers = parseHFREQINFO(NSA_HFREQ);

say('');
say('=== ★ NSA(EN-DC)：^MONSC 报 LTE 锚点也不能显示成 4G ===');

ok('前置：真机 ^MONSC 在 NSA 下报的确实是 LTE（误判的来源）',
	/^\^MONSC: LTE,/.test(NSA_MONSC), NSA_MONSC.slice(0, 22));
ok('前置：^HFREQINFO 解出 2 条载波（LTE 锚点 + NR 辅载波）',
	nsCarriers.length === 2, 'got ' + nsCarriers.length);
ok('前置：其中恰好 1 条是 NR —— 所以「载波数」不能直接当 5GA 判据',
	R.nrCarrierCount(nsCarriers) === 1, 'got ' + R.nrCarrierCount(nsCarriers));
ok('前置：NR 载波的频段是 n41（band=41）',
	nsCarriers.some(function (c) { return c.sysMode === 'NR' && c.band === 41; }));

ok('★ LTE 锚点 + NR 在用 → 5G-NR（修复前这里出 4G-LTE）',
	R.ratDisplay('LTE', nsCarriers, null, true) === '5G-NR',
	R.ratDisplay('LTE', nsCarriers, null, true));
ok('★ ^HFREQINFO 没给 NR 载波时，仅凭 ^LENDC 的 EN-DC 已建立也要判 5G',
	R.ratDisplay('LTE', [], { established: true }, true) === '5G-NR',
	R.ratDisplay('LTE', [], { established: true }, true));
ok('★ 2 条 NR 载波 + LTE 锚点 → 5GA-NR（真 NR 载波聚合）',
	R.ratDisplay('LTE', nsCarriers.concat([{ sysMode: 'NR' }]), null, true) === '5GA-NR',
	R.ratDisplay('LTE', nsCarriers.concat([{ sysMode: 'NR' }]), null, true));

say('');
say('=== 反向：不许矫枉过正，纯 LTE 必须还是 4G ===');

ok('★ 纯 LTE（无 NR 载波、无 EN-DC）→ 4G-LTE',
	R.ratDisplay('LTE', parseHFREQINFO(LTE_ONLY_HFREQ), null, true) === '4G-LTE',
	R.ratDisplay('LTE', parseHFREQINFO(LTE_ONLY_HFREQ), null, true));
ok('★ LTE 载波聚合（2 条 LTE 载波）仍是 4G-LTE —— 载波数不是升代依据',
	R.ratDisplay('LTE', [{ sysMode: 'LTE' }, { sysMode: 'LTE' }],
		{ established: false }, true) === '4G-LTE');
ok('★ EN-DC 能力可用但没建立（<nr_pscell>=0）且无 NR 载波 → 4G-LTE',
	R.ratDisplay('LTE', [], { available: true, plmnAvailable: true, established: false },
		true) === '4G-LTE');
ok('未注册时仍优先显示 —（NSA 也不例外）',
	R.ratDisplay('LTE', nsCarriers, { established: true }, false) === '—');
ok('第四参缺省时行为与从前一致（老调用方不受影响）',
	label('LTE', 2) === '4G-LTE', label('LTE', 2));
ok('NR 制式下第四参缺省照常出 5G（不依赖新参数）',
	label('NR', 1) === '5G-NR', label('NR', 1));

say('');
say('=== ★ NSA 下聚合徽章不得把「双连接」说成「载波聚合」 ===');

ok('★ 1 LTE + 1 NR → EN-DC 双连接（不是「2 载波聚合中」）',
	R.aggregationBadge(2, 1, true) === 'EN-DC 双连接', R.aggregationBadge(2, 1, true));
ok('2 条 NR 载波（真 CA）→ 2 载波聚合中',
	R.aggregationBadge(2, 2, false) === '2 载波聚合中', R.aggregationBadge(2, 2, false));
ok('2 条 LTE 载波（LTE CA）→ 2 载波聚合中',
	R.aggregationBadge(2, 0, false) === '2 载波聚合中', R.aggregationBadge(2, 0, false));
ok('EN-DC + 额外的 NR 载波聚合 → 两者都要说',
	R.aggregationBadge(3, 2, true) === 'EN-DC 双连接 + 3 载波',
	R.aggregationBadge(3, 2, true));
ok('单载波', R.aggregationBadge(1, 1, false) === '单载波', R.aggregationBadge(1, 1, false));
ok('无载波 → 不可用', R.aggregationBadge(0, 0, false) === '不可用');
ok('★ renderCarriers 改用 aggregationBadge（不再用 count>1 直接判聚合）',
	/aggregationBadge\(count,\s*nrCcs,\s*dcActive\)/.test(src));

say('');
if (fails.length) {
	console.log(log.join('\n'));
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（network_status.js 制式文案 / 标题）');
