#!/usr/bin/env node
/*
 * 连接工具卡 契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-09-18：「连接质量」整卡换成「连接工具」。
 *   初版六项，同日按用户要求调整为四项：
 *     ADC 管脚电压（进页面自动读）/ 诊断快照导出 / 流量统计清零 / 连通性自检。
 *   · 「网络拒绝原因」→ 迁到「网络设置 → 网络拒绝」卡（本测试第 9 节守卫）
 *   · 「服务状态监听」→ 整块下线（^SRVST 解析器一并删除，本测试第 6 节守卫）
 *   · 2026-09-19「ADC 管脚电压」→ 整块下线（手册不给管脚含义、无法解读，
 *     还占排查卡一整块；解析器一并删除，本测试第 1 节改成反向钉子）
 *
 * 本测试覆盖：
 *   ① ADC 已下线（反向钉子） / parseRejInfo
 *   ② 自检    checkSteps() 六步判据（用手册格式的应答真跑）
 *   ③ 快照    buildSnapshotText() 真跑，重点钉「默认不写设备标识」
 *   ④ ★ 不占通道底线（2.2.1 事故防回退的源码级契约）最重要
 *   ⑤ 沿用    PDCP / CGSMS 解析、地址去重、三表合并（这些不随换卡而失效）
 *   ⑥ 网络设置页「网络拒绝」卡契约（迁移后的归宿）
 *
 * 运行：node tests/connection-tools-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PARSE_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const NS_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
/* 「网络拒绝原因」迁移后的归宿页 */
const SET_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_settings.js');
/* 读数胶囊的样式（竖向堆叠那次事故就出在这里，故一并守卫） */
const CSS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css');

const parseSrc = fs.readFileSync(PARSE_JS, 'utf8');
const nsSrc = fs.readFileSync(NS_JS, 'utf8');
const setSrc = fs.readFileSync(SET_JS, 'utf8');
const cssSrc = fs.readFileSync(CSS, 'utf8');

const pm = parseSrc.match(/var Parse = \((function[\s\S]*?\n\})\)\(\);/);
if (!pm) { console.error('无法从 parse.js 提取模块'); process.exit(1); }
/* eslint-disable no-eval */
const Parse = eval('(' + pm[1] + ')')();

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}

/* 按括号配对从 network_status.js 里抠出整个函数 */
function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name + '（改名请同步本测试）');
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}

/* ---------- 1. ADC 管脚电压已整块下线（2026-09-19） ---------- */
/* 用户决定删掉「ADC 管脚电压」：手册 11.5 只给原始电平、不说明每个管脚接的是什么
   （真机 3 个管脚都是 1798/1799 mV，无法解读、也不指导任何动作），却要占排查卡
   一整块、并在进页面时多发 5 条 AT。以下四条是防回退的反向钉子。 */
ok('★ parse.js 不再提供 parseAdcValue（不留死代码）', typeof Parse.parseAdcValue === 'undefined');
ok('★ 页面不再下发 AT^ADCREADEX', !/ADCREADEX/.test(nsSrc));
ok('★ 页面不再有 ADC_PIN_IDS / buildAdcBlock / readAdcPins',
	!/ADC_PIN_IDS/.test(nsSrc) && !/buildAdcBlock/.test(nsSrc) && !/readAdcPins/.test(nsSrc));
ok('★ 排查不再挂在 ADC 链之后（已无任何自动入口，见第 4 节「不进页面自动跑」）',
	!/readAdcPins\(\)\.then/.test(nsSrc));

/* ---------- 2. ^REJINFO（手册 13.14，解析器留在 parse.js，UI 在 network_settings.js） ---------- */

const REJ = Parse.parseRejInfo('^REJINFO: "46000",0,7,6,0,7,"1422","05","0C027F50"');
ok('REJINFO 解析成功', REJ !== null, String(REJ));
eq('PLMN', REJ.plmn, '46000');
eq('原因值 7', REJ.cause, 7);
eq('原因值 7 有中文文案', typeof REJ.causeText === 'string' && REJ.causeText.length > 0, true);
eq('域 / 制式 / 类型都有文案', [typeof REJ.domainText, typeof REJ.ratText, typeof REJ.rejectTypeText],
	['string', 'string', 'string']);
eq('小区 ID 带上', REJ.cellId, '0C027F50');
eq('字段不足 6 个 → null', Parse.parseRejInfo('^REJINFO: "46000",0,7'), null);
eq('不匹配 → null', Parse.parseRejInfo('OK'), null);
ok('未知原因值有兜底文案', /未知原因/.test(Parse.rejectCauseText(99999)), Parse.rejectCauseText(99999));

/* ---------- 4. L1 模组与空口：AT 逐步判据 ---------- */

/* ★ 2026-09-19：原「连通性自检」6 步扩成 9 步，并入三层排查的 L1。
   补的三步都对应真机上真实发生过、而旧 6 步一条都覆盖不到的断网原因：
     CFUN     —— CFUN=0 会直接把 eth2 挂死（红线级）
     CGDCONT  —— APN 空/错是最常见的断网原因，旧 6 步里根本没有 APN
     SYSCFGEX —— 服务域 CS_ONLY 只能打电话不能上网 */

const AtWsStub = {
	extractATDataMultiline: function (data, prefix) {
		return String(data).split(/\r?\n/)
			.map(function (l) { return l.trim(); })
			.filter(function (l) { return l.indexOf(prefix + ':') === 0; })
			.map(function (l) { return l.slice(prefix.length + 1).trim(); });
	},
	extractATData: function (data, prefix) {
		const re = new RegExp('\\' + prefix.split('').join('\\').replace(/\\\\/g, '\\')
			.replace(/^\^/, '\\^').replace(/^\+/, '\\+') + '\\s*:\\s*([^\\r\\n]*)');
		return null;
	},
	hexToIP: function (h) {
		const s = String(h == null ? '' : h).trim();
		if (!/^[0-9a-fA-F]{8}$/.test(s)) return s;
		const out = [];
		for (let i = 0; i < 8; i += 2) out.push(parseInt(s.substr(i, 2), 16));
		return out.join('.');
	}
};
/* extractATData 单独实现（上面那个正则拼法太绕） */
AtWsStub.extractATData = function (data, prefix) {
	const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m = String(data).match(new RegExp(esc + ':\\s*([^\\r\\n]*)'));
	return m ? m[1].trim() : '';
};

const steps = new Function('Parse', 'AtWs',
	extractFn(nsSrc, 'checkSteps') + '\nreturn checkSteps;')(Parse, AtWsStub)();

eq('L1 共 9 步（原 6 步 + 射频开关 / APN / 服务域）', steps.length, 9);
eq('九步命令依次是 CFUN→CPIN→CGDCONT→SYSCFGEX→C5GREG→CGACT→NDISSTATQRY→CGPADDR→DHCP',
	steps.map(function (s) { return s.cmd; }),
	['AT+CFUN?', 'AT+CPIN?', 'AT+CGDCONT?', 'AT^SYSCFGEX?', 'AT+C5GREG?', 'AT+CGACT?', 'AT^NDISSTATQRY?', 'AT+CGPADDR', 'AT^DHCP?']);

/* 新增三步的判据（真跑，用手册格式的应答） */
eq('CFUN=1 → ok', judge('射频开关', '+CFUN: 1\r\nOK').level, 'ok');
eq('CFUN=0 → bad', judge('射频开关', '+CFUN: 0\r\nOK').level, 'bad');
ok('CFUN=0 时必须点明 eth2 会被挂死（红线级坑）',
	/eth2/.test(judge('射频开关', '+CFUN: 0\r\nOK').text));
ok('CFUN=0 时给出 AT+CFUN=1 与 ifdown/ifup 两条建议，但只是文本（不自动执行）',
	/AT\+CFUN=1/.test(judge('射频开关', '+CFUN: 0\r\nOK').fix)
	&& /ifdown/.test(judge('射频开关', '+CFUN: 0\r\nOK').fix));
eq('CFUN 取不到 → warn（不假判故障）', judge('射频开关', 'ERROR').level, 'warn');

eq('CGDCONT 有 APN → ok', judge('APN 配置', '+CGDCONT: 1,"IP","cmnet","0.0.0.0",0,0\r\nOK').level, 'ok');
ok('CGDCONT ok 时列出 APN', /cmnet/.test(judge('APN 配置', '+CGDCONT: 1,"IP","cmnet"\r\nOK').text));
eq('CGDCONT APN 为空 → bad（这是断网最常见的原因）',
	judge('APN 配置', '+CGDCONT: 1,"IP","","0.0.0.0",0,0\r\nOK').level, 'bad');
eq('CGDCONT 无应答 → bad', judge('APN 配置', 'ERROR').level, 'bad');
eq('CGDCONT 多条同名 APN 去重后仍 ok',
	judge('APN 配置', '+CGDCONT: 1,"IP","cmnet"\r\n+CGDCONT: 5,"IP","cmnet"\r\nOK').level, 'ok');

eq('SYSCFGEX 服务域 2 → ok',
	judge('服务域与制式', '^SYSCFGEX: "00",3FFFFFFF,1,2,7FFFFFFFFFFFFFFF\r\nOK').level, 'ok');
eq('SYSCFGEX 服务域 0（CS_ONLY）→ bad（只能打电话）',
	judge('服务域与制式', '^SYSCFGEX: "00",3FFFFFFF,1,0,7FFFFFFFFFFFFFFF\r\nOK').level, 'bad');
ok('服务域 CS_ONLY 时说明上不了网',
	/上不了网/.test(judge('服务域与制式', '^SYSCFGEX: "00",3FFFFFFF,1,0,7FFFFFFFFFFFFFFF\r\nOK').text));
eq('SYSCFGEX 服务域 1（PS_ONLY）→ warn（能上网但打不了电话）',
	judge('服务域与制式', '^SYSCFGEX: "00",3FFFFFFF,1,1,7FFFFFFFFFFFFFFF\r\nOK').level, 'warn');
eq('SYSCFGEX 无应答 → warn（不影响上网本身）',
	judge('服务域与制式', 'ERROR').level, 'warn');

function judge(name, data) {
	const st = steps.filter(function (s) { return s.name === name; })[0];
	return st.judge(data);
}

eq('CPIN READY → ok', judge('SIM 就绪', '+CPIN: READY\r\nOK').level, 'ok');
eq('CPIN SIM PIN → bad', judge('SIM 就绪', '+CPIN: SIM PIN\r\nOK').level, 'bad');
eq('CPIN 取不到 → bad 且文案说明卡没插好',
	judge('SIM 就绪', 'ERROR').level, 'bad');

eq('C5GREG stat=1 → ok', judge('网络注册', '+C5GREG: 1,1,"46000","14225C"\r\nOK').level, 'ok');
eq('C5GREG stat=5（漫游）→ ok', judge('网络注册', '+C5GREG: 1,5,"46000"\r\nOK').level, 'ok');
eq('C5GREG stat=3（被拒）→ bad', judge('网络注册', '+C5GREG: 1,3\r\nOK').level, 'bad');
ok('C5GREG 被拒时指路「网络设置 → 网络拒绝」',
	/网络设置 → 网络拒绝/.test(judge('网络注册', '+C5GREG: 1,3\r\nOK').text));
eq('C5GREG stat=0（未注册）→ warn，不是 bad',
	judge('网络注册', '+C5GREG: 1,0\r\nOK').level, 'warn');

eq('CGACT 有激活 → ok', judge('PDP 上下文激活', '+CGACT: 1,1\r\n+CGACT: 5,1\r\nOK').level, 'ok');
ok('CGACT ok 时列出 CID', /CID 1/.test(judge('PDP 上下文激活', '+CGACT: 1,1\r\nOK').text));
eq('CGACT 全 0 → bad', judge('PDP 上下文激活', '+CGACT: 1,0\r\n+CGACT: 5,0\r\nOK').level, 'bad');

eq('NDIS stat=1 → ok', judge('拨号连接', '^NDISSTATQRY: 1,1\r\nOK').level, 'ok');
eq('NDIS stat=0 → bad', judge('拨号连接', '^NDISSTATQRY: 1,0\r\nOK').level, 'bad');
eq('NDIS 无应答 → bad（不是 warn）', judge('拨号连接', 'ERROR').level, 'bad');

eq('CGPADDR 有地址 → ok',
	judge('拿到 IP 地址', '+CGPADDR: 1,"10.0.0.5"\r\nOK').level, 'ok');
eq('CGPADDR 空地址 → bad',
	judge('拿到 IP 地址', '+CGPADDR: 1,""\r\nOK').level, 'bad');

eq('DHCP 网关正常 → ok',
	judge('网关与 DNS', '^DHCP: 0A0A0A01,FFFFFF00,0A0A0A01,0A0A0A01,08080808,01010101\r\nOK').level, 'ok');
ok('DHCP ok 时给出网关 10.10.10.1',
	/10\.10\.10\.1/.test(judge('网关与 DNS',
		'^DHCP: 0A0A0A01,FFFFFF00,0A0A0A01,0A0A0A01,08080808,01010101\r\nOK').text));
eq('DHCP 取不到 → warn（不影响上网，不能判故障）',
	judge('网关与 DNS', 'ERROR').level, 'warn');

/* ---------- 5. 诊断快照已下线（2026-09-18 用户要求删除） ---------- */

ok('★ 快照功能已整块下线（不许再搬回来）',
	!/buildSnapshotBlock|buildSnapshotText|copySnapshot|downloadSnapshot|诊断快照|state\.tools\.snap/.test(nsSrc));
ok('★ 卡片已改名为「断网排查」（原「连接工具」）',
	/Mt5700\.card\('断网排查', '三层体检 · 一键定位'\)/.test(nsSrc)
	&& !/Mt5700\.card\('连接工具'/.test(nsSrc));

/* ---------- 6. ★★ 不占通道底线（2.2.1 事故防回退） ---------- */

ok('旧卡「连接质量」已下线', !/Mt5700\.card\('连接质量'/.test(nsSrc));
/* 2026-09-19 用户口径变更：删掉页面底部的满宽「断网排查明细」独立卡，
   明细全部收进右列「断网排查」卡内部（P03）。旧断言钉的是「必须有独立明细卡」，
   现在反向钉「不许再有独立明细卡 + 明细容器必须挂在 diagCard._body 上」。 */
ok('★ 已删除底部满宽明细卡（不再有独立「断网排查明细」卡）',
	!/diagDetailCard/.test(nsSrc)
	&& !/Mt5700\.card\('断网排查明细'/.test(nsSrc)
	&& /diagCard\._body\.appendChild\(diagDetailBody\)/.test(nsSrc));

ok('★ 不再下发 PDCP 周期上报开关（2.2.1 元凶）',
	!/sendCommand\('AT\^PDCPDATAINFO=/.test(nsSrc));
ok('★ 服务状态监听已整块下线（不再下发 AT^SRVST 命令）',
	!/sendCommand\('AT\^SRVST/.test(nsSrc)
	&& !/buildSrvBlock|startSrvListen|stopSrvListen|sendSrvOff/.test(nsSrc)
	&& !/tools\.srv/.test(nsSrc));
ok('★ ^SRVST 解析器已一并删除（不留死代码）',
	!/api\.parseSrvst/.test(parseSrc) && !/api\.srvStatusText/.test(parseSrc));
ok('★ 网络状态页不再有「网络拒绝原因」（已迁去网络设置）',
	!/buildRejBlock|toggleRejListen|tools\.rej/.test(nsSrc));
ok('★ 本卡没有任何周期上报开关（无 SRV_LISTEN_MS / 无订阅回调）',
	!/SRV_LISTEN_MS/.test(nsSrc) && !/toolHandler/.test(nsSrc)
	&& !/AtWs\.client\.subscribe/.test(nsSrc));
ok('★ 自检那步指路到「网络设置 → 网络拒绝」',
	/网络设置 → 网络拒绝/.test(nsSrc));

/* ★ 2026-09-19 v2.3.15 用户口径：排查**不主动跑**，只有点按钮才跑。
   理由：这条链是 9 条 AT + 一次系统侧采集（最坏 15 秒），要占住独占的 AT 通道
   十几秒；进页面就跑会和页面轮询、用户手动发的 AT（短信/终端/拨号）抢通道。
   钉法：源码里不许出现任何"自动发起排查"的调用（runDiagnosis() 只应出现在按钮回调里，
   而按钮回调是传引用 `runDiagnosis` 不带括号），且按钮文案恒为「一键排查」。 */
ok('★ 排查不进页面自动跑（源码无 runDiagnosis() 形式的自动调用）',
	!/runDiagnosis\(\)\.catch/.test(nsSrc) && !/runDiagnosis\(\)\.then/.test(nsSrc));
ok('★ 按钮恒定叫「一键排查」（不再分「开始排查」/「重新排查」）',
	/Mt5700\.ghostButton\(t\.busy \? '排查中…' : '一键排查', runDiagnosis\)/.test(nsSrc)
	&& !/'开始排查'/.test(nsSrc) && !/'重新排查'/.test(nsSrc));
ok('★ 排查结论用 badge 进标题行（不用块级 .mt5700-diag-summary，它会把行撑高）',
	/box\.firstChild\.insertBefore\(Mt5700\.badge\(summaryText,/.test(nsSrc)
	&& !/mt5700-diag-summary is-' \+ lv/.test(nsSrc));
/* 2026-09-19 用户口径变更：明细恒为展开态（第二轮）——「收起明细 / 展开明细」那对入口
   整体删除，进页面直接看得见当前层的明细；只保留 L1/L2/L3 分段切换。
   新口径守卫：
   · 表字面量保留（项目/结论/说明三列原样）
   · 不把折叠状态塞进 state.tools.diag（无 t.expanded，会被 runDiagnosis 重置）
   · 三层分段切换仍在（Mt5700.segmented + DIAG_LAYERS）
   · ★ 源码里不得再出现折叠开关（diagDetailOpen）与两个入口按钮
   · 严禁再新建「断网排查明细」独立卡片（P03 已删除，明细容器挂在 diagCard._body） */
ok('★ 明细表字面量保留（项目/结论/说明三列原样）',
	/Mt5700\.table\(\['项目', '结论', '说明'\]/.test(nsSrc));
ok('★ 不把折叠状态塞进 state.tools.diag（无 t.expanded，避免被 runDiagnosis 整块重置）',
	!/t\.expanded/.test(nsSrc));
ok('★ 明细恒展开：三层分段切换仍在（复用现成 Mt5700.segmented + DIAG_LAYERS）',
	/Mt5700\.segmented\(DIAG_LAYERS/.test(nsSrc)
	&& /var diagLayer = 'L1';/.test(nsSrc));
/* ★ 2026-09-19 口径变更（核心口径）：钉死「默认展开、没有收起功能」。
   光钉「不存在收起按钮」不够（把初值改回 false 也能全绿），所以标识符与按钮一并钉死。 */
ok('★ 默认展开且没有收起功能（核心口径）：无折叠开关 diagDetailOpen，也无两个入口按钮',
	!/diagDetailOpen/.test(nsSrc)
	&& !/Mt5700\.ghostButton\('展开明细'/.test(nsSrc)
	&& !/Mt5700\.ghostButton\('收起明细'/.test(nsSrc)
	&& !/mt5700-diag-entry/.test(nsSrc));
ok('★ 不新增任何独立明细卡片（明细容器挂在 diagCard._body 内）',
	!/Mt5700\.card\('断网排查明细'/.test(nsSrc)
	&& /diagCard\._body\.appendChild\(diagDetailBody\)/.test(nsSrc));

/* ★ 2026-09-19 第二轮（v2.3.13）+ 第三轮修正（v2.3.14）：
   排查卡「占地固化」+「右列底边与左列对齐」。
   两列拉平（stretch）后，矮的那侧多出来的高度必须有人吃掉，否则就是当初被
   抱怨的「卡底一片空白」。吸收链一共三节，缺任何一节都静默失效：
       stack → 卡（.mt5700-card-fill 必须能增长）
       → 卡体 → 明细区（flex-basis 必须是**固定值**）
       → 表格区（内部滚动，且宽屏下不得用 max-height 封顶）
   ★ v2.3.13 漏的正是第一节：只让卡体内部 flex，卡**自己**在 stack 里不增长
     （flex 子项默认 0 1 auto），富余空间留在卡下面，底边照样差一截；
     同时明细区写的是 flex:1 1 auto（basis 取内容高度，收起 34px / 展开 450px），
     行高依旧跟着数据抖。下面每条断言各钉一节。 */
ok('★ 排查卡带 .mt5700-card-fill（吃掉右列剩余高度，底边才能拉平）',
	/diagCard\.classList\.add\('mt5700-card-fill'\)/.test(nsSrc));
ok('★ 双列卡区 align-items: stretch（两列等高；start 会让底边对不齐）',
	/\.mt5700-cards \{ align-items: stretch; \}/.test(cssSrc));
ok('★ ① 卡自己在 .mt5700-stack 里必须能增长（漏这条＝富余空间留在卡下方，底边差一截）',
	/\.mt5700-stack > \.mt5700-card-fill \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;/.test(cssSrc));
ok('★ ② 明细区 flex-basis 必须是固定值（写 auto 就取内容高度，收起/展开行高会变）',
	/\.mt5700-card-fill > \.mt5700-card-body > \.mt5700-diag-detail \{[\s\S]*?flex: 1 1 340px;/.test(cssSrc));
ok('★ ③ 表格区 flex 吸收 + 宽屏解除 max-height 封顶（否则 grow 出的高度被卡住，退回空白）',
	/\.mt5700-diag-detail > \.mt5700-diag-scroll \{ flex: 1 1 auto; \}/.test(cssSrc)
	&& /\.mt5700-diag-detail \.mt5700-diag-scroll \{ max-height: none; \}/.test(cssSrc));
ok('★ ④ 表格区仍能滚动（内容多时不把卡片撑高）',
	/\.mt5700-diag-detail \.mt5700-diag-scroll \{[\s\S]*?overflow-y: auto;/.test(cssSrc));
/* ★ 明细已恒展开，不再有「收起态入口」这节吸收链；富余高度统一交给滚动表格
   （.mt5700-diag-scroll）吸收，因此 CSS 里也不该再留 .mt5700-diag-entry。 */
ok('★ 收起态入口已彻底移除（CSS 里也不留 .mt5700-diag-entry）',
	!/mt5700-diag-entry/.test(cssSrc));
ok('★ 四档结论都有对应文案（含新增的 idle 待检查）',
	/var DIAG_VERDICT = \{ ok: '通过', warn: '存疑', bad: '未通过', idle: '待检查' \}/.test(nsSrc));
ok('★ 待检查有 CSS 配色（不写会掉成继承色，暗色下和「通过」分不出来）',
	/\.mt5700-diag-verdict\.is-idle \{/.test(cssSrc));
ok('★ 三层计数徽章容器有 flex-wrap + min-width:0（不许压扁，重演 ADC 竖排事故）',
	/\.mt5700-diag-chips \{[\s\S]*?flex-wrap: wrap;[\s\S]*?min-width: 0;/.test(cssSrc));
ok('★ 流量清零仍保留按钮与二次确认（不可逆，不能做成自动）',
	/function clearFlowStats[\s\S]{0,300}Mt5700\.confirm/.test(nsSrc));

ok('流量清零下发 AT^DSFLOWCLR', /sendCommand\('AT\^DSFLOWCLR'\)/.test(nsSrc));
/* ★ 两个 handler 都要有：只给 onFulfilled 时，取新流量失败就不重绘，
   界面停在清零前的旧数字 —— 看起来像「没清成功」，而实际已经清了。
   这是「失败路径被误读」的一种，所以钉死第二个 handler。 */
ok('清零后重取流量并重绘（失败分支置空 state.flow 后重绘，不留旧数字）',
	/getFlow\(\)\.then\(renderFlow, function \(\) \{\s*state\.flow = \{\};/.test(nsSrc));
const rateBarBlock = (function () {
	const a = nsSrc.indexOf("var rateChk = E('input'");
	const b = nsSrc.indexOf('rateExtra.appendChild(rateBar)');
	return (a >= 0 && b > a) ? nsSrc.slice(a, b) : '';
})();
ok('★ 清零入口挂在「速率与流量」卡头（与流量数字同一张卡）',
	rateBarBlock.length > 0 && /dangerButton\('清零流量', clearFlowStats\)/.test(rateBarBlock));
ok('★ 连接工具里不再有独立的清零块（已迁走）',
	!/toolsBody\.appendChild\(buildFlowClearBlock\(\)\)/.test(nsSrc)
	&& !/buildFlowClearBlock/.test(nsSrc));
ok('★ 卡头「实时监测」的文字没有被 E() 静默丢掉（E 只挂第 3 参）',
	/var rateLabel = E\('label', \{\}, rateChk\);[\s\S]{0,160}createTextNode\(' 实时监测'\)/.test(nsSrc));
/* 2026-09-19：卡内分段/滚动保留（见上方守卫）。此处只钉死旧代码里误用的
   「展开步骤/收起步骤」向导式字眼不得重现（旧版曾是「逐步展开/收起」的向导式交互，已被否决）。 */
ok('自检明细不再用「展开步骤/收起步骤」向导式字眼（旧口径已作废）',
	!/展开步骤/.test(nsSrc) && !/收起步骤/.test(nsSrc));
ok('★ 排查只给建议命令，没有自动修复按钮（续约/重启服务本身就会断网）',
	/'建议：' \+ i\.fix/.test(nsSrc)
	&& !/Mt5700\.confirm\([\s\S]{0,120}ifdown/.test(nsSrc));
/* 2026-09-18 真机反馈：一排读数被挤成竖向堆叠。根因是容器 .mt5700-grow
   （flex:1 1 240px）在窄栏里被压到内容宽度以下，再撞上 .mt5700-mono 的
   word-break:break-all，就地断行。当时钉了两条 flex/nowrap 断言。
   2026-10-21：取证发现 `.mt5700-readout` / `.mt5700-readouts` 在全仓
   （htdocs + root，含 ucode 与 shell）**已无任何元素挂载** —— 只有 mt5700.css
   和本文件自己提到它们。ADC 下线后组件其实一起下线了，CSS 与断言都成了空壳。
   按「功能只留适配本设备的」改为反向断言：谁再把这两个类加回来，得先同时
   补组件与样式，否则这里会红。 */
ok('★ 读数胶囊类已随组件下线（CSS 不许留空壳规则）',
	!/\.mt5700-readout\s*[,{]/.test(cssSrc) && !/\.mt5700-readouts\s*[,{]/.test(cssSrc));

/* ---------- 7. 沿用：PDCP / CGSMS 解析（解析器仍在 parse.js） ---------- */

const PDCP_REAL = '^PDCPDATAINFO: 2,6,500,0,0,0,0,0,0,0,0,0,17333,0,574750503,558267589\r\n'
	+ '^PDCPDATAINFO: 11,5,65535,0,0,0,0,0,0,0,0,0,0,0,45072,45072\r\nOK';
const pdcp = Parse.parsePdcpDataInfo(PDCP_REAL);
eq('PDCP 解析出 2 个 DRB', pdcp.length, 2);
eq('DRB1 上行丢包 17333', pdcp[0].ulDiscardCnt, 17333);
eq('DRB2 丢弃定时器 65535 → null（未配置）', pdcp[1].discardTimerLen, null);
eq('手册没写的第 15/16 字段不进结果',
	Object.keys(pdcp[0]).indexOf('ulPdcpRate') < 0
	&& Object.keys(pdcp[0]).indexOf('avgDelay') < 0, true);

eq('CGSMS 真机默认 3', Parse.parseCgsms('+CGSMS: 3').service, 3);
eq('CGSMS 3 → 优先 CS', [Parse.parseCgsms('+CGSMS: 3').preferCs, Parse.parseCgsms('+CGSMS: 3').preferPs], [true, false]);
eq('CGSMS 无匹配 → null', Parse.parseCgsms('ERROR'), null);

/* 地址汇聚与去重（真机三来源；16 段十进制 = IPv6 的 16 个字节，已脱敏为样例地址） */
const CGPADDR_REAL = '+CGPADDR: 1,"10.0.0.5"\r\n'
	+ '+CGPADDR: 5,"198.51.100.7.198.51.100.10.198.51.100.11.198.51.100.12"\r\nOK';
function makeAddrList(st) {
	return new Function('state',
		extractFn(nsSrc, 'addrKey') + '\n' + extractFn(nsSrc, 'buildAddrList')
		+ '\nreturn buildAddrList;')(st);
}
const addrState = {
	diag: { addrs: Parse.parseCgpaddr(CGPADDR_REAL) },
	dhcpv4: { ipv4Address: '10.0.0.5' },
	dhcpv6: null
};
const addrList = makeAddrList(addrState)();
eq('去重后只剩 2 条（IPv4 与 IPv6）', addrList.length, 2);
eq('IPv4 排在 IPv6 前', [addrList[0].family, addrList[1].family], ['IPv4', 'IPv6']);
eq('IPv6 还原成冒号形式', addrList[1].address, 'c633:6407:c633:640a:c633:640b:c633:640c');
eq('同地址不同 CID → 1 行',
	makeAddrList({
		diag: { addrs: [{ cid: 1, address: '10.0.0.2', family: 'IPv4' }, { cid: 7, address: '10.0.0.2', family: 'IPv4' }] },
		dhcpv4: null, dhcpv6: null
	})().length, 1);
eq('全空 → 0 行', makeAddrList({ diag: { addrs: [] }, dhcpv4: null, dhcpv6: null })().length, 0);

/* ---------- 8. 沿用：两表合并（连接诊断 + 地址与 DNS） ---------- */

ok('两张表已合并成一个渲染入口 renderConnDetail', /function renderConnDetail\(\)/.test(nsSrc));
ok('旧的 renderDiag / renderAddr / renderDHCP 已下线',
	!/function renderDiag\(/.test(nsSrc)
	&& !/function renderAddr\(/.test(nsSrc)
	&& !/function renderDHCP\(/.test(nsSrc));
/* 2026-09-18 用户反馈：「地址 不就是 IP 与 DNS 中的 ip 么为啥要分开」。
   PDP 地址与 ^DHCP 下发的本来就是同一个地址，拆两组只是多一条分组标题。 */
ok('★「地址」与「IP 与 DNS」已合并为一组「地址与 DNS」',
	/pushGroup\('地址与 DNS', buildAddrRows\(\)\.concat\(buildDhcpRows\(\)\)\)/.test(nsSrc)
	&& !/pushGroup\('IP 与 DNS'/.test(nsSrc));
ok('只剩两个分组标题行', /pushGroup\('连接诊断'/.test(nsSrc));
ok('地址表不再有 CID 列', !/Mt5700\.table\(\['CID'/.test(nsSrc));
ok('地址表不再有来源列', !/'来源'/.test(nsSrc));

/* R05 原是钉 readAdcPins（ADC 链）必须返回 Promise；ADC 整块下线后，
   这条语义平移到 runDiagnosis：它是进页面自动跑的那条链，busy 时必须返回
   Promise，否则调用方 .catch 会拿到 TypeError —— 表现为「排查静默不跑」。 */
ok('★ R05 runDiagnosis busy 时必须返回 Promise（入口是 .catch(...)，返回 undefined 会静默崩）',
	/if \(t\.busy\) return Promise\.resolve\(\);/.test(nsSrc));
/* R04：disposed 标记。ADC 链删掉后，取而代之钉排查链的两处中断点
   （AT 逐步前、sysDiag 前）与收尾的 if (!disposed) renderTools()。 */
ok('★ R04 自动链可被页面卸载中断（disposed 标记，反复进出不会多路排队）',
	/var disposed = false;/.test(nsSrc)
	&& /if \(disposed\) return;/.test(nsSrc)
	&& /if \(!disposed\) renderTools\(\);/.test(nsSrc)
	&& /_dispose[\s\S]{0,300}disposed = true;/.test(nsSrc));

/* IPv6 能力值文案（手册 16.7.3） */
eq('★ IPV6CAP 0 不在码表里 → 给裸值不编造（旧代码编了个「未获取能力值」）',
	Parse.ipv6CapDescription(0), '未知能力值 0');
eq('IPV6CAP 1 → 仅 IPv4（旧代码错译成「支持 IPv6」，已按手册纠正）',
	Parse.ipv6CapDescription(1), '仅 IPv4');
eq('IPV6CAP 2 → 仅 IPv6', Parse.ipv6CapDescription(2), '仅 IPv6');
eq('IPV6CAP 7 → 支持 · 双栈（同一 APN）（真机就是这个值）',
	Parse.ipv6CapDescription(7), '支持 · 双栈（同一 APN）');
eq('IPV6CAP 11 → 支持 · 双栈（分用 APN）',
	Parse.ipv6CapDescription(11), '支持 · 双栈（分用 APN）');
ok('★ 未定义的值不许编造成支持/不支持', /未知能力值 999/.test(Parse.ipv6CapDescription(999)));

/* ---------- 9. 网络设置页「网络拒绝」卡（^REJINFO 迁移后的归宿） ---------- */

ok('网络设置页有「网络拒绝」卡', /Mt5700\.card\('网络拒绝'/.test(setSrc));
ok('★ 只订阅 URC，不下发任何 ^REJINFO 命令（手册无读/设置命令）',
	!/sendCommand\('AT\^?REJINFO/.test(setSrc)
	&& /AtWs\.client\.subscribe\(rejectHandler\)/.test(setSrc)
	&& /resp\.data\.type === 'REJINFO'/.test(setSrc));
ok('★ 离线时也要 unsubscribe（否则反复进出叠加订阅）',
	/_dispose[\s\S]{0,300}AtWs\.client\.unsubscribe\(rejectHandler\)/.test(setSrc));
ok('没上报时给出「尚无网络拒绝上报」并说明「没被拒绝就不会推」',
	/Mt5700\.empty\('尚无网络拒绝上报'\)/.test(setSrc)
	&& /没被拒绝就不会推/.test(setSrc));
ok('有上报时铺成表格（时间/PLMN/域/制式/拒绝类型/原因）',
	/Mt5700\.table\(\['项目', '值'\], rows, \{ striped: true \}\)/.test(setSrc)
	&& /\['拒绝类型', r\.rejectTypeText\]/.test(setSrc)
	&& /\['原因', E\('b'/.test(setSrc));
ok('给出常见原因值的解读（#7/#8/#11/#12/#15）',
	/#7\/#8 多为核心网未开通 5G/.test(setSrc));
ok('指回本页的排查手段（邻区扫描 / 锁频设置）',
	/邻区扫描/.test(setSrc) && /锁频设置/.test(setSrc));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（连接工具：解析 / 自检判据 / 快照已下线 / 不占通道底线 / 网络拒绝归位 / 沿用契约）');
