'use strict';
'require fs';
'require uci';
'require at-webserver/mt5700';
/* global L, Mt5700 */

/**
 * 运行日志页
 *
 * 两个顶层视图：
 *   1) 运行日志：后端内存 + syslog 合并，按类别细分（拨号/AT/短信/接口/系统/其他）
 *   2) 通知记录：通知文件（短信/来电/信号/存储），逻辑不变
 *
 * 展示要点：等宽字体、级别配色与左色条、毫秒级时间列、关键词高亮、斑马纹、
 * 日期分组、类别徽章、长消息折叠、底部统计、可导出为文本。
 */

/* 类别规则：有序正则表，先命中先归位。
 * 顺序即优先级——sms 必须在 at 之前：AT 通道日志形如「发送 → 模组: AT+CMGS=...」，
 * 通道层措辞（发送/接收/模组）与 AT+ 前缀都会命中 at 规则，若 sms 排在后面
 * 所有短信收发痕迹都会被归进「AT 通道」；同时正则必须列全 CMGS/CMGL/CMGR/
 * CMGW/CMSS 这些短信命令名——「SM」子串匹配不到 CMGS（C-M-G-S）。
 * dial 在 net 之前，因为拨号过程里也含接口关键词。 */
var CATEGORY_RULES = [
	{ key: 'sms', label: '短信',
		re: /短信|SMS|PDU|长短信|收件|发件|短信中心|CPMS|CMGS|CMGL|CMGR|CMGW|CMSS|CMGD|归档|存储已满|SM/ },
	{ key: 'dial', label: '拨号与网络',
		re: /自动拨号|拨号|SETAUTODIAL|APN|PDP|CGACT|CGDCONT|NDIS|驻网|注册|CREG|CGREG|C5GREG|COPS|SETMODE|信号/ },
	{ key: 'net', label: '接口与网络',
		re: /接口|网口|ifup|ifdown|DHCP|地址|device|hotplug|MT5700M|eth\d|IPv4|IPv6|网关|路由|metric|防火墙|network/ },
	{ key: 'at', label: 'AT 通道',
		re: /AT\+|AT\^|前端请求|发送\s*(?:→|->)\s*模组|接收\s*(?:←|<-)\s*模组|URC|主动上报|串口|ttyUSB|ttyACM|AT通道|事务|超时|重试|CMEE|CNMI|CMGF|CLIP|回显/ },
	{ key: 'sys', label: '系统与服务',
		re: /服务|procd|守护|固件|FOTA|升级|重启|内存|CPU|温度|UCI|uci|配置|权限|证书|NTP|对时|时钟|时区|日志级别|Web|luci/ }
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

/* 类别判定：按 CATEGORY_RULES 有序匹配，都不命中归 other */
function categorize(msg) {
	for (var i = 0; i < CATEGORY_RULES.length; i++) {
		if (CATEGORY_RULES[i].re.test(msg)) return CATEGORY_RULES[i].key;
	}
	return 'other';
}

/* 类别中文名查找 */
var CATEGORY_LABEL = { all: '全部', dial: '拨号与网络', at: 'AT 通道', sms: '短信', net: '接口与网络', sys: '系统与服务', other: '其他' };

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

/* 后端日志：msg 里已经带了业务信息；级别来自宏 */
function entriesFromBackend(list) {
	var out = [];
	for (var i = 0; i < list.length; i++) {
		var e = list[i];
		out.push({ ts: Number(e.ts) || 0, level: String(e.level || 'INF'), msg: String(e.msg || ''), src: 'backend', seq: Number(e.seq) || 0 });
	}
	return out;
}

/* syslog 行：两种形态
 *   at-webserver-rust[pid]: 2026-09-18 08:14:35.326 [INF] 消息      （后端 stdout）
 *   at-webserver: 消息                                             （init.d 的 logger）
 * 后端那类已由内存日志提供，这里只取 init.d 那类，避免重复。 */
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
		out.push({ ts: Number(r.time) || Date.now(), level: lv, msg: text, src: 'syslog', seq: 0 });
	}
	return out;
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
			category: 'all',     /* all | dial | at | sms | net | sys | other */
			level: 'all',        /* all | DBG | INF | WRN | ERR | errwrn */
			source: 'all',       /* all | backend | syslog */
			limit: 400,          /* 200 | 400 | 800 | 0(全部) */
			query: '',
			auto: true,
			entries: [],         /* 后端+syslog 合并后的全量条目（已分类） */
			notify: '',
			syslogOk: true,
			loading: false
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

		/* ---------------- 类别条（仅运行日志 tab 下显示） ---------------- */
		var catBar = E('div', { 'class': 'mt5700-logcatbar' });
		var CAT_DEFS = [
			{ key: 'all', icon: '📑' },
			{ key: 'dial', icon: '📡' },
			{ key: 'at', icon: '🔌' },
			{ key: 'sms', icon: '💬' },
			{ key: 'net', icon: '🌐' },
			{ key: 'sys', icon: '⚙️' },
			{ key: 'other', icon: '📦' }
		];
		var catBtns = {};
		CAT_DEFS.forEach(function (c) {
			var btn = E('div', {
				'class': 'mt5700-logcatbtn',
				'data-cat': c.key,
				role: 'button',
				tabindex: '0'
			}, [
				E('span', { 'class': 'mt5700-logcatbtn-icon' }, c.icon),
				E('span', { 'class': 'mt5700-logcatbtn-label' }, CATEGORY_LABEL[c.key]),
				E('span', { 'class': 'mt5700-logcatbtn-count' }, '0')
			]);
			btn.addEventListener('click', function () { state.category = c.key; renderAll(); });
			catBar.appendChild(btn);
			catBtns[c.key] = btn;
		});
		body.appendChild(catBar);

		/* ---------------- 工具栏 ---------------- */
		var levelSel = Mt5700.select([
			{ label: '全部级别', value: 'all' },
			{ label: '仅调试', value: 'DBG' },
			{ label: '仅信息', value: 'INF' },
			{ label: '仅警告', value: 'WRN' },
			{ label: '仅错误', value: 'ERR' }
		], 'all');

		/* 下拉的外观用内联样式确保稳定生效，并契合 Soft Anime 紫色调调色板 */
		(function styleSelect(el) {
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
			el.addEventListener('focus', function () {
				el.style.setProperty('border-color', '#8b5cf6', 'important');
				el.style.setProperty('box-shadow', '0 0 0 3px rgba(139,92,246,0.20)', 'important');
			});
			el.addEventListener('blur', function () {
				el.style.setProperty('border-color', 'rgba(139,92,246,0.28)', 'important');
				el.style.setProperty('box-shadow', 'none', 'important');
			});
		})(levelSel);
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

		/* 来源下拉 */
		var srcSel = Mt5700.select([
			{ label: '全部来源', value: 'all' },
			{ label: '后端内存', value: 'backend' },
			{ label: 'syslog', value: 'syslog' }
		], 'all');
		(function styleSelect2(el) {
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
		})(srcSel);
		srcSel.addEventListener('change', function () { state.source = srcSel.value; renderList(); });

		/* 条数上限下拉 */
		var limitSel = Mt5700.select([
			{ label: '最新 200 条', value: '200' },
			{ label: '最新 400 条', value: '400' },
			{ label: '最新 800 条', value: '800' },
			{ label: '全部', value: '0' }
		], '400');
		(function styleSelect3(el) {
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
		})(limitSel);
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
		function applyFilters(list) {
			var q = state.query.toLowerCase();
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var e = list[i];
				/* 类别过滤 */
				if (state.category !== 'all' && e.cat !== state.category) continue;
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

		/* 计算未过滤时的各类别总数 */
		function computeCategoryTotals(allEntries) {
			var totals = { all: allEntries.length, dial: 0, at: 0, sms: 0, net: 0, sys: 0, other: 0 };
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
			var filteredForCounts = applyFiltersNoCategory(all);
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
				var catLabel = state.category === 'all' ? '' : '（' + CATEGORY_LABEL[state.category] + '）';
				listEl.appendChild(emptyBox('没有匹配的日志' + catLabel, '试试清空关键词、切换类别，或把级别切回「全部级别」。'));
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

		/* 不过滤类别的过滤（用于类别计数联动） */
		function applyFiltersNoCategory(list) {
			var q = state.query.toLowerCase();
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var e = list[i];
				if (state.source !== 'all' && e.src !== state.source) continue;
				if (state.level === 'errwrn') {
					if (e.level !== 'ERR' && e.level !== 'WRN') continue;
				} else if (state.level !== 'all') {
					if (e.level !== state.level) continue;
				}
				if (q && e.msg.toLowerCase().indexOf(q) < 0) continue;
				out.push(e);
			}
			return out;
		}

		/* 更新类别条按钮的计数与激活状态 */
		function updateCatBar(filteredCounts, totalCounts) {
			var hasFilter = state.level !== 'all' || state.source !== 'all' || state.query !== '';
			CAT_DEFS.forEach(function (c) {
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
				'data-cat': e.cat || 'other',
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
			var catKey = e.cat || 'other';
			row.appendChild(E('span', {
				'class': 'mt5700-logcat mt5700-logcat-' + catKey,
				title: CATEGORY_LABEL[catKey] || catKey
			}, CATEGORY_LABEL[catKey] || catKey));

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
			if (e.src === 'syslog') row.appendChild(E('span', { 'class': 'mt5700-logsrc', title: '来自 syslog（init.d / 内核）' }, '系统'));
			return row;
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
			if (!state.syslogOk) text += ' · syslog 不可读';

			var footerStats = E('span', { 'class': 'mt5700-logfooter-text' }, text);
			var scrollActions = E('span', { 'class': 'mt5700-logfooter-actions' }, [
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
			footer.appendChild(footerStats);
			footer.appendChild(scrollActions);
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
			var scrollActions = E('span', { 'class': 'mt5700-logfooter-actions' }, [
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
			footer.appendChild(footerStats);
			footer.appendChild(scrollActions);
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
				hint.textContent = '后端内存日志与 syslog 合并：自动拨号对齐、AT 通道交互、短信收发、接口拉起、系统事件。按类别筛选，关键词按原文匹配。';
			}

			renderList();
		}

		/* ---------------- 取数 ---------------- */
		function refresh(manual) {
			if (state.loading) return Promise.resolve();
			state.loading = true;

			var tasks = [];
			/* 后端内存日志：一次取全量（上限 1200），前端按类别分类 */
			/* 三路取数**串行**执行：ucode 转发用的是临时文件，并发会互相覆盖。
			 * 新版 ucode 已用唯一文件名解决，这里串行是为了兼容存量设备，双保险。 */
			tasks.push(rpcLogs(0, 1200, newRid()).then(function (r) {
				var entries = entriesFromBackend((r && r.entries) || []);
				for (var i = 0; i < entries.length; i++) {
					entries[i].cat = categorize(entries[i].msg);
				}
				state._backendEntries = entries;
			}).catch(function (err) {
				state._backendEntries = [{ ts: Date.now(), level: 'ERR', msg: '读取后端日志失败：' + ((err && err.message) || '未知错误'), cat: 'other', src: 'backend' }];
			}));

			/* init.d 日志：走 syslog；无权限或不可用时降级，不影响其它视图 */
			tasks.push(rpcSyslog(1500, false, true).then(function (r) {
				var extra = entriesFromSyslog((r && r.log) || []);
				for (var i = 0; i < extra.length; i++) {
					extra[i].cat = categorize(extra[i].msg);
				}
				state._syslogEntries = extra;
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
				/* 合并后端+syslog，按时间排序 */
				var merged = (state._backendEntries || []).concat(state._syslogEntries || []);
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
				lines.push('# 类别: ' + (CATEGORY_LABEL[state.category] || state.category));
				lines.push('# 来源: ' + (state.source === 'all' ? '全部来源' : (state.source === 'backend' ? '后端内存' : 'syslog')));
			}
			lines.push('');
			for (var i = 0; i < list.length; i++) {
				lines.push(fmtFull(list[i].ts) + ' [' + list[i].level + '] ' + list[i].msg);
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
		self._dispose = function () { if (timer) clearInterval(timer); };

		return page;
	}
});
