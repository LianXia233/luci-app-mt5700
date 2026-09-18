'use strict';
'require fs';
'require uci';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700 */

/**
 * 运行日志页
 *
 * 三个视图（互不重复，来源不同）：
 *   1) 模组拨号：后端内存日志里的拨号过程 —— 自动拨号对齐、PDP/NDIS 状态、AT 初始化、
 *      串口探测、URC 分发。**这些是 syslog 看不到的**：稳态下后端日志级别是 Warn，
 *      info 级过程日志不会写 syslog，但它们对排障最关键。
 *   2) 接口与网络：init.d 的 logger 输出（取自 syslog，含 hotplug、接口拉起、取址结果）
 *      + 后端日志里与接口/网络相关的行。
 *   3) 通知记录：原有的通知文件（短信/来电/信号/存储）。
 *
 * 展示要点：等宽字体、级别配色与左色条、毫秒级时间列、关键词高亮、斑马纹、
 * 底部统计、可导出为文本。
 */

/* 分类规则：先拨号，再接口，其余归入接口与网络（系统类）。
 * 规则写成常量，改动只需动这一处。 */
var DIAL_RE = /自动拨号|拨号|SETAUTODIAL|APN|PDP|CGACT|CGDCONT|NDIS|驻网|注册|CREG|CGREG|C5GREG|COPS|SETMODE|串口|ttyUSB|ttyACM|AT通道|CMEE|CNMI|CMGF|CLIP|模组/i;
var IFACE_RE = /接口|网口|ifup|ifdown|DHCP|地址|device|hotplug|MT5700M|eth\d|IPv4|IPv6|网关|路由|metric|防火墙|服务|procd|防火墙|network/i;

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

/* 显示前装饰：先做术语中文化，再为消息里的 AT 命令补一句用途 */
function displayText(text) {
	var s = String(text);
	for (var i = 0; i < TEXT_MAP.length; i++) s = s.replace(TEXT_MAP[i][0], TEXT_MAP[i][1]);
	for (var j = 0; j < AT_PURPOSE.length; j++) {
		if (AT_PURPOSE[j][0].test(s)) {
			s += '　（' + AT_PURPOSE[j][1] + '）';
			break;
		}
	}
	return s;
}

function classify(msg) {
	if (DIAL_RE.test(msg)) return 'dial';
	if (IFACE_RE.test(msg)) return 'iface';
	return 'iface';
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
		var page = Mt5700.page('运行日志', '模组拨号 · 接口拉起 · 通知记录');
		var body = page._body;
		var notifyPath = (data && data.path) || '/tmp/at-notifications.log';

		var state = {
			tab: 'dial',
			level: 'all',        /* all | INF | WRN | ERR */
			query: '',
			auto: true,
			dial: [],
			iface: [],
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

		/* ---------------- 顶部：视图切换 + 工具栏 ---------------- */
		var tabs = E('div', { 'class': 'mt5700-logtabs' });
		var TAB_DEFS = [
			{ id: 'dial', label: '模组拨号' },
			{ id: 'iface', label: '接口与网络' },
			{ id: 'notify', label: '通知记录' }
		];
		TAB_DEFS.forEach(function (t) {
			/* 用 div 而非 button：主题对原生 button 有较强的全局样式（白底、方框、阴影），
			 * 会被继承进来破坏分段控件的观感 —— 实测就是这个问题。div 完全可控。 */
			var b = E('div', { 'class': 'mt5700-logtab', 'data-tab': t.id, role: 'tab', tabindex: '0' }, t.label);
			b.addEventListener('click', function () { state.tab = t.id; renderAll(); });
			tabs.appendChild(b);
		});
		body.appendChild(tabs);

		var levelSel = Mt5700.select([
			{ label: '全部级别', value: 'all' },
			{ label: '仅信息 INF', value: 'INF' },
			{ label: '仅警告 WRN', value: 'WRN' },
			{ label: '仅错误 ERR', value: 'ERR' }
		], 'all');
		levelSel.addEventListener('change', function () { state.level = levelSel.value; renderList(); });

		var searchInput = Mt5700.input('text', '按关键词过滤，如 拨号 / eth2 / 警告', '');
		searchInput.addEventListener('input', function () { state.query = searchInput.value.trim(); renderList(); });

		var autoChk = E('input', { type: 'checkbox' });
		autoChk.checked = true;
		autoChk.addEventListener('change', function () {
			state.auto = autoChk.checked;
			if (state.auto) schedule();
		});

		/* 自写按钮：不依赖主题的 button / ghostButton，避免被全局样式改变观感 */
		function logButton(label, onClick, variant) {
			var cls = 'mt5700-logbtn' + (variant ? ' mt5700-logbtn-' + variant : '');
			var b = E('div', { 'class': cls, role: 'button', tabindex: '0', title: label }, label);
			b.addEventListener('click', onClick);
			b.addEventListener('keydown', function (ev) {
				if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onClick(ev); }
			});
			return b;
		}

		var toolbar = E('div', { 'class': 'mt5700-logtoolbar' });
		toolbar.appendChild(E('div', { 'class': 'mt5700-logselect' }, [levelSel]));
		toolbar.appendChild(E('div', { 'class': 'mt5700-logsearch' }, [searchInput]));
		var autoWrap = E('label', { 'class': 'mt5700-logauto' }, [autoChk, E('span', {}, '自动刷新')]);
		toolbar.appendChild(autoWrap);
		toolbar.appendChild(logButton('刷新', function () { refresh(true); }));
		toolbar.appendChild(logButton('导出', function () { exportLog(); }));
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
		var clearBtn = logButton('清空通知日志', function () { clearNotify(); }, 'danger');
		clearRow.appendChild(clearBtn);
		panel.appendChild(clearRow);

		/* ---------------- 渲染 ---------------- */
		function currentEntries() {
			if (state.tab === 'dial') return state.dial;
			if (state.tab === 'iface') return state.iface;
			return [];
		}

		function applyFilters(list) {
			var q = state.query.toLowerCase();
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var e = list[i];
				if (state.level !== 'all') {
					if (state.level === 'ERR') { if (e.level !== 'ERR') continue; }
					else if (e.level !== state.level) continue;
				}
				if (q && e.msg.toLowerCase().indexOf(q) < 0) continue;
				out.push(e);
			}
			return out;
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

		function renderList() {
			listEl.innerHTML = '';
			footer.textContent = '';

			if (state.tab === 'notify') { renderNotify(); return; }

			var all = currentEntries();
			var list = applyFilters(all);

			if (!all.length) {
				listEl.appendChild(emptyBox(
					state.tab === 'dial' ? '暂无拨号日志' : '暂无接口日志',
					state.tab === 'dial'
						? '服务连上模组后会记录自动拨号对齐、数据承载与 USB 网卡状态、串口探测与选口过程。'
						: '接口拉起与重试、热插拔钩子、动态地址与 IPv6 取址结果都会出现在这里。'));
			} else if (!list.length) {
				listEl.appendChild(emptyBox('没有匹配的日志', '试试清空关键词，或把级别切回「全部级别」。'));
			} else {
				var frag = document.createDocumentFragment();
				/* 只渲染最后 400 行，避免一次插入过多节点导致滚动卡顿 */
				var shown = list.length > 400 ? list.slice(list.length - 400) : list;
				for (var i = 0; i < shown.length; i++) frag.appendChild(renderRow(shown[i]));
				listEl.appendChild(frag);
			}

			var text = '共 ' + all.length + ' 条';
			if (list.length !== all.length) text += '（过滤后 ' + list.length + ' 条）';
			if (list.length > 400) text += '，仅显示最新 400 条';
			if (state.tab === 'iface' && !state.syslogOk) text += ' · syslog 不可读（仅显示后端日志）';
			footer.textContent = text;
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
			var row = E('div', { 'class': 'mt5700-logrow mt5700-logrow-' + cls });
			row.appendChild(E('span', { 'class': 'mt5700-logtime', title: fmtFull(e.ts) }, fmtClock(e.ts)));
			row.appendChild(E('span', { 'class': 'mt5700-loglv', title: lv }, LEVEL_LABEL[lv] || lv));
			var msg = E('span', { 'class': 'mt5700-logmsg' });
			msg.appendChild(highlight(displayText(e.msg)));
			row.appendChild(msg);
			if (e.src === 'syslog') row.appendChild(E('span', { 'class': 'mt5700-logsrc', title: '来自 syslog（init.d / 内核）' }, '系统'));
			return row;
		}

		function renderNotify() {
			var content = state.notify || '';
			var lines = content.replace(/\s+$/, '').split('\n').filter(function (l) { return l.trim() !== ''; });
			if (!lines.length) {
				listEl.appendChild(emptyBox('暂无通知记录', '短信、来电、信号变化与存储告警会写入此文件。'));
				footer.textContent = '文件：' + notifyPath;
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
			footer.textContent = '共 ' + lines.length + ' 条 · 文件：' + notifyPath;
		}

		function renderAll() {
			var btns = tabs.querySelectorAll('.mt5700-logtab');
			for (var i = 0; i < btns.length; i++) {
				var on = btns[i].getAttribute('data-tab') === state.tab;
				btns[i].className = 'mt5700-logtab' + (on ? ' active' : '');
			}
			levelSel.value = state.level;
			levelSel.disabled = (state.tab === 'notify');
			searchInput.disabled = (state.tab === 'notify');
			clearRow.style.display = (state.tab === 'notify') ? '' : 'none';
			hint.textContent = state.tab === 'dial'
				? '后端内存日志（不受日志级别限制）：自动拨号对齐、数据承载与 USB 网卡状态、串口探测、主动上报分发。进程重启后从零开始；AT 命令保留原文并附用途说明，搜索按原文匹配。'
				: (state.tab === 'iface'
					? 'init.d 的 logger 输出（取自 syslog）与后端日志中与接口/网络相关的部分：接口拉起、hotplug、DHCP / IPv6 取址结果。'
					: '通知文件内容（短信、来电、信号变化、存储告警）。');
			renderList();
		}

		/* ---------------- 取数 ---------------- */
		function refresh(manual) {
			if (state.loading) return Promise.resolve();
			state.loading = true;

			var tasks = [];
			/* 后端内存日志：一次取全量（上限 1200），前端按视图分类 */
			/* 三路取数**串行**执行：ucode 转发用的是临时文件，并发会互相覆盖。
			 * 新版 ucode 已用唯一文件名解决，这里串行是为了兼容存量设备，双保险。 */
			tasks.push(rpcLogs(0, 1200, newRid()).then(function (r) {
				var entries = entriesFromBackend((r && r.entries) || []);
				state.dial = [];
				state.iface = [];
				for (var i = 0; i < entries.length; i++) {
					if (classify(entries[i].msg) === 'dial') state.dial.push(entries[i]);
					else state.iface.push(entries[i]);
				}
			}).catch(function (err) {
				state.dial = [{ ts: Date.now(), level: 'ERR', msg: '读取后端日志失败：' + ((err && err.message) || '未知错误') }];
				state.iface = [];
			}));

			/* init.d 日志：走 syslog；无权限或不可用时降级，不影响其它视图 */
			tasks.push(rpcSyslog(1500, false, true).then(function (r) {
				var extra = entriesFromSyslog((r && r.log) || []);
				state.iface = state.iface.concat(extra);
				state.iface.sort(function (a, b) { return a.ts - b.ts; });
				state.syslogOk = true;
			}).catch(function () {
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
				state.loading = false;
				renderAll();
				if (manual) Mt5700.success('日志已刷新');
			}, function () {
				state.loading = false;
			});
		}

		function exportLog() {
			var list = (state.tab === 'notify')
				? [{ ts: Date.now(), level: 'INF', msg: state.notify || '' }]
				: applyFilters(currentEntries());
			var lines = [];
			lines.push('# luci-app-mt5700 运行日志导出');
			lines.push('# 视图: ' + state.tab + '  导出时间: ' + fmtFull(Date.now()));
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
