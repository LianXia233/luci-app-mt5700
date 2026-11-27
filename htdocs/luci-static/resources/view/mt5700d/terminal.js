// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require mt5700d/rpc';
'require mt5700d/ui';
'require mt5700d/mt5700';
'require mt5700d/icons';
/* global L, Mt5700d, Ui, Mt5700, window */

/**
 * AT 调试终端页面：
 * - 命令输入 + 回车发送、发送 / 清空
 * - 终端式输出（成功 / 失败着色，自动滚动到底部）
 * - 常用命令：维护者指定的 9 条只读查询，直接展示为带图标的大按钮
 * - 低频命令：按手册章节归为 8 组，收纳到折叠面板，支持关键字过滤
 * - 写操作（重启 / 清零 / 切换模式）单独成组并标红，点击后强化二次确认
 * - 不设「已保存命令」卡片：命令库本身已覆盖全部指令，少一张半空卡片，
 *   页面层级更干净（历史 localStorage 数据不再读取，避免陈旧命令复活）
 *
 * 命令语法逐条对照《MT5700M-CN 5G 系列模组 AT 命令手册》V200R001C20 / 文档版本 01。
 * 收录规则两条，缺一不可：
 * 1. 只收录「不需要额外参数就能执行」的形式（锁频、FOTA 下载等不做按钮）；
 * 2. 应答必须能在后端 2 秒预算内完整返回。`AT+COPS=?`（运营商搜索）和
 *    `AT+COPN`（全量运营商名表）实测超过 2 秒：前者直接超时失败，后者更隐蔽——
 *    atclient 在「超时前已收到部分行」时按成功返回，界面显示的是半截列表且
 *    没有结束符。两条都不做成按钮，需要时请在输入框手敲并自行判读。
 */

/* 高频：沿用维护者确认的 9 条常用只读命令，名称与命令一一对应，
 * 不擅自增减；其余查询按需收进下方分组，保持这里一眼可扫。 */
var QUICK_COMMANDS = [
	{ label: '查询信号强度', cmd: 'AT^HCSQ?', icon: 'op-signal', hint: 'RSRP / RSRQ / SINR' },
	{ label: '查询版本', cmd: 'ATI', icon: 'op-device', hint: '厂商 / 型号 / 软件版本' },
	{ label: '查询 SIM 状态', cmd: 'AT+CPIN?', icon: 'op-sim', hint: 'PIN 就绪状态' },
	{ label: '查询 ICCID', cmd: 'AT^ICCID?', icon: 'op-sim', hint: 'SIM 卡号' },
	{ label: '查询 IMSI', cmd: 'AT+CIMI', icon: 'op-sim', hint: '国际移动用户识别码' },
	{ label: '查询网络注册', cmd: 'AT+CREG?', icon: 'op-network', hint: 'CS 域注册状态' },
	{ label: '查询基站信息', cmd: 'AT+CGREG?', icon: 'op-cell', hint: 'PS 域注册与小区信息' },
	{ label: '查询网络时间', cmd: 'AT^NWTIME?', icon: 'op-schedule', hint: '网络系统时间与时区' },
	{ label: '查询 IMEI', cmd: 'AT+CGSN', icon: 'op-shield', hint: '只读；结果仅显示在下方终端，不上传、不写入本地存储' }
];

/* 低频：按手册章节归类，默认折叠；danger 项会改变模组状态或数据 */
var COMMAND_GROUPS = [
	{
		title: '设备与身份', icon: 'op-device', items: [
			{ label: '制造商', cmd: 'AT+CGMI', icon: 'op-device' },
			{ label: '型号', cmd: 'AT+CGMM', icon: 'op-device' },
			{ label: '软件版本', cmd: 'AT+CGMR', icon: 'op-info' },
			{ label: '私有版本', cmd: 'AT^VERSION?', icon: 'op-info' },
			{ label: '能力域', cmd: 'AT+GCAP', icon: 'op-info' },
			{ label: 'SIM 卡类型', cmd: 'AT^CARDMODE', icon: 'op-sim' },
			{ label: '本机号码', cmd: 'AT+CNUM', icon: 'op-info' }
		]
	},
	{
		title: 'SIM 与电话本', icon: 'op-sim', items: [
			{ label: 'SIM 状态上报', cmd: 'AT^SIMSQ?', icon: 'op-sim' },
			{ label: '电话本存储器', cmd: 'AT+CPBS?', icon: 'op-sim' }
		]
	},
	{
		title: '网络与注册', icon: 'op-network', items: [
			{ label: '5G 注册', cmd: 'AT+C5GREG?', icon: 'op-5g', hint: '5GC 注册状态' },
			{ label: 'EPS 注册', cmd: 'AT+CEREG?', icon: 'op-network' },
			{ label: 'IMS 注册', cmd: 'AT+CIREG?', icon: 'op-network' },
			{ label: '当前运营商', cmd: 'AT+COPS?', icon: 'op-network' }
		]
	},
	{
		title: '信号与小区', icon: 'op-signal', items: [
			{ label: '驻留小区', cmd: 'AT^MONSC', icon: 'op-cell', hint: 'PCI / 频点 / 小区 ID' },
			{ label: '工作频段', cmd: 'AT^HFREQINFO?', icon: 'op-band', hint: 'LTE / NR 工作频率' },
			{ label: '系统信息', cmd: 'AT^SYSINFOEX', icon: 'op-info', hint: '服务状态 / 域 / 漫游' },
			{ label: 'SSB 信息', cmd: 'AT^NRSSBID?', icon: 'op-signal' },
			{ label: 'NSA 辅小区', cmd: 'AT^MONSSC', icon: 'op-cell' },
			{ label: 'CA 辅小区', cmd: 'AT^CASCELLINFO?', icon: 'op-cell' },
			{ label: 'RRC 状态', cmd: 'AT^RRCSTAT?', icon: 'op-signal' },
			{ label: '发射功率', cmd: 'AT^TXPOWER?', icon: 'op-signal' },
			{ label: 'NR 发射功率', cmd: 'AT^NTXPOWER?', icon: 'op-signal' },
			{ label: 'LTE 传输模式', cmd: 'AT^TRANSMODE?', icon: 'op-band' },
			{ label: '双连接状态', cmd: 'AT^LENDC?', icon: 'op-link' },
			{ label: '邻区信息', cmd: 'AT^MONNC', icon: 'op-scan' }
		]
	},
	{
		title: '拨号与地址', icon: 'op-dial', items: [
			{ label: '拨号状态', cmd: 'AT^NDISSTATQRY?', icon: 'op-dial', hint: 'NDIS 连接状态' },
			{ label: '流量统计', cmd: 'AT^DSFLOWQRY', icon: 'op-network', hint: '上下行字节数' },
			{ label: 'PDP 上下文', cmd: 'AT+CGDCONT?', icon: 'op-dial' },
			{ label: 'IPv4 地址', cmd: 'AT^DHCP?', icon: 'op-network' },
			{ label: 'IPv6 地址', cmd: 'AT^DHCPV6?', icon: 'op-network' },
			{ label: 'IPv6 能力', cmd: 'AT^IPV6CAP?', icon: 'op-network' },
			{ label: '拨号连接状态', cmd: 'AT^DCONNSTAT?', icon: 'op-dial' }
		]
	},
	{
		title: '时钟与短信', icon: 'op-schedule', items: [
			{ label: '模组时钟', cmd: 'AT+CCLK?', icon: 'op-schedule' },
			{ label: '时区上报', cmd: 'AT+CTZR?', icon: 'op-schedule' },
			{ label: '短信存储器', cmd: 'AT+CPMS?', icon: 'op-sms' },
			{ label: '短信格式', cmd: 'AT+CMGF?', icon: 'op-sms' },
			{ label: '短信中心号码', cmd: 'AT+CSCA?', icon: 'op-sms' },
			{ label: '新短信通知', cmd: 'AT+CNMI?', icon: 'op-sms' }
		]
	},
	{
		title: '诊断与日志', icon: 'op-logs', items: [
			{ label: '芯片温度', cmd: 'AT^CHIPTEMP?', icon: 'op-device', hint: '各传感器温度' },
			{ label: 'FOTA 状态', cmd: 'AT^FOTASTATE?', icon: 'op-upgrade' },
			{ label: '日志导出开关', cmd: 'AT^LOGCATSWITCH?', icon: 'op-logs' },
			{ label: '功能模式', cmd: 'AT+CFUN?', icon: 'op-info' }
		]
	},
	{
		title: '维护操作（会改变模组状态）', icon: 'op-warning', danger: true, items: [
			{ label: '重启协议栈', cmd: 'AT+CFUN=1,0', icon: 'op-refresh', danger: true, hint: '模组会重新驻网' },
			{ label: '进入飞行模式', cmd: 'AT+CFUN=4', icon: 'op-power', danger: true, hint: '数据链路会中断' },
			{ label: '模组重启', cmd: 'AT^RESET', icon: 'op-refresh', danger: true, hint: '整模组重启' },
			{ label: '流量清零', cmd: 'AT^DSFLOWCLR', icon: 'op-delete', danger: true, hint: '不可逆，统计归零' }
		]
	}
];

function cmdIcon(name, cls) {
	if (window.AtIcons && typeof window.AtIcons.build === 'function') {
		return window.AtIcons.build(name, { className: cls || 'mt5700-cmd-icon', w: 16, h: 16 });
	}
	return null;
}

return L.view.extend({
	render: function () {
		var page = Mt5700.page('AT 调试终端', '底层 AT 指令交互控制台、命令审计与快捷指令预设', 'terminal', 'AT 控制台 · 交互调试');
		var body = page._body;

		var entries = [];

		/* ---------- 终端主体 ---------- */
		var termCard = Mt5700.card('AT 调试终端', '输入指令后按回车或点击发送；清空仅清除本页日志，不影响模组');
		var termBody = E('div');
		termCard._body.appendChild(termBody);
		body.appendChild(termCard);

		var terminal = E('div', { 'class': 'mt5700-terminal' });
		termBody.appendChild(terminal);

		var header = E('div', { 'class': 'mt5700-terminal-header' });
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-red' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-yellow' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-green' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-title' }, 'AT Terminal - MT5700M'));
		terminal.appendChild(header);

		var consoleEl = E('div', { 'class': 'mt5700-terminal-body' });
		terminal.appendChild(consoleEl);

		var inputRow = E('div', { 'class': 'mt5700-terminal-input mt5700-inline' });
		var cmdInput = Mt5700.input('text', '输入 AT 指令，回车发送');
		cmdInput.style.flex = '1 1 240px';
		var sendBtn = Mt5700.primaryButton('发送', function () { send(); });
		var clearBtn = Mt5700.ghostButton('清空', function () {
			entries = [];
			renderConsole();
		});

		inputRow.appendChild(cmdInput);
		inputRow.appendChild(sendBtn);
		inputRow.appendChild(clearBtn);
		terminal.appendChild(inputRow);

		cmdInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') send();
		});

		/* ---------- 命令按钮构造 ---------- */
		/* searchable 只收分组内的按钮：常用卡单独占据页面上方，不参与「更多命令」的
		 * 过滤，否则搜「IMEI」会把常用卡一起藏掉，而结果计数却显示在下方卡里。 */
		var searchable = [];
		var allCmdBtns = [];

		function commandButton(item, quick) {
			var danger = !!item.danger;
			var cls = quick ? 'mt5700-cmd-quick' : 'mt5700-cmd-chip';
			if (danger) cls += ' mt5700-cmd-chip-danger';
			var tip = item.label + '：' + item.cmd + (item.hint ? '\n' + item.hint : '');
			var btn = E('button', {
				'type': 'button',
				'class': cls,
				'title': tip,
				'aria-label': tip,
				'data-mt-cmd': item.cmd
			});
			var icon = cmdIcon(item.icon, quick ? 'mt5700-cmd-quick-icon' : 'mt5700-cmd-icon');
			if (icon) btn.appendChild(icon);
			var text = E('span', { 'class': 'mt5700-cmd-text' });
			text.appendChild(E('span', { 'class': 'mt5700-cmd-label' }, item.label));
			text.appendChild(E('span', { 'class': 'mt5700-cmd-code' }, item.cmd));
			btn.appendChild(text);
			if (danger) {
				btn.appendChild(E('span', { 'class': 'mt5700-cmd-kind mt5700-cmd-kind-write' }, '写操作'));
			} else if (quick) {
				btn.appendChild(E('span', { 'class': 'mt5700-cmd-kind mt5700-cmd-kind-read' }, '只读'));
			}
			btn.addEventListener('click', function () {
				confirmAndSend(item.cmd, item.label, danger);
			});
			allCmdBtns.push(btn);
			if (!quick) {
				searchable.push({
					btn: btn,
					text: (item.label + ' ' + item.cmd + ' ' + (item.hint || '')).toLowerCase()
				});
			}
			return btn;
		}

		/* ---------- 常用命令：独占整行，9 条 3×3 对齐 ---------- */
		var quickCard = Mt5700.card('常用命令', '只读查询 · 点击后二次确认下发');
		var quickGrid = E('div', { 'class': 'mt5700-cmd-quick-grid' });
		quickCard._body.appendChild(quickGrid);
		QUICK_COMMANDS.forEach(function (item) {
			quickGrid.appendChild(commandButton(item, true));
		});
		body.appendChild(quickCard);

		/* ---------- 命令库：分组折叠 + 过滤 ---------- */
		var libCard = Mt5700.card('更多命令', '按手册章节归类 · ' + COMMAND_GROUPS.length +
			' 组 / ' + COMMAND_GROUPS.reduce(function (n, g) { return n + g.items.length; }, 0) +
			' 条，默认折叠');

		var filterRow = E('div', { 'class': 'mt5700-cmd-filter' });
		var filterInput = Mt5700.input('text', '搜索命令名、AT 指令或用途');
		filterInput.setAttribute('aria-label', '搜索 AT 命令');
		filterInput.classList.add('mt5700-cmd-search');
		var filterIcon = cmdIcon('op-search', 'mt5700-cmd-search-icon');
		if (filterIcon) filterRow.appendChild(filterIcon);
		filterRow.appendChild(filterInput);
		libCard._body.appendChild(filterRow);

		var resultLine = E('div', { 'class': 'mt5700-cmd-result' }, '');
		libCard._body.appendChild(resultLine);

		var groupsWrap = E('div', { 'class': 'mt5700-cmd-groups' });
		var groupEls = [];

		COMMAND_GROUPS.forEach(function (group) {
			var details = E('details', { 'class': 'mt5700-cmd-group' });
			var summary = E('summary', { 'class': 'mt5700-cmd-group-head' });
			var gIcon = cmdIcon(group.icon, 'mt5700-cmd-group-icon');
			if (gIcon) summary.appendChild(gIcon);
			summary.appendChild(E('span', { 'class': 'mt5700-cmd-group-title' }, group.title));
			summary.appendChild(E('span', { 'class': 'mt5700-cmd-group-count' }, String(group.items.length)));
			summary.appendChild(E('span', { 'class': 'mt5700-cmd-group-caret' }));
			details.appendChild(summary);

			var groupBody = E('div', { 'class': 'mt5700-cmd-group-body' });
			group.items.forEach(function (item) {
				groupBody.appendChild(commandButton(item, false));
			});
			details.appendChild(groupBody);
			groupsWrap.appendChild(details);
			groupEls.push({ root: details, body: groupBody });
		});

		libCard._body.appendChild(groupsWrap);

		var noResult = E('div', { 'class': 'mt5700-cmd-empty mt5700-cmd-hidden' }, '没有匹配的命令，试试命令名或 AT 指令关键字');
		libCard._body.appendChild(noResult);
		body.appendChild(libCard);

		function applyFilter() {
			var q = (filterInput.value || '').trim().toLowerCase();
			var total = 0;
			searchable.forEach(function (entry) {
				var hit = !q || entry.text.indexOf(q) >= 0;
				entry.btn.classList.toggle('mt5700-cmd-hidden', !hit);
				if (hit) total++;
			});
			groupEls.forEach(function (g) {
				var visible = g.body.querySelectorAll('.mt5700-cmd-chip:not(.mt5700-cmd-hidden)').length;
				g.root.classList.toggle('mt5700-cmd-hidden', visible === 0);
				if (q && visible) g.root.open = true;
				/* 清空关键字时保留用户已展开的分组，不强行折叠 */
			});
			resultLine.textContent = q ? ('匹配 ' + total + ' 条命令') : '';
			noResult.classList.toggle('mt5700-cmd-hidden', total > 0);
		}

		filterInput.addEventListener('input', applyFilter);

		/* ---------- 输出渲染 ---------- */
		function renderConsole() {
			consoleEl.innerHTML = '';
			if (!entries.length) {
				consoleEl.appendChild(E('div', { 'class': 'mt5700-terminal-line' },
					'暂无输出，输入 AT 指令开始调试'));
				return;
			}
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				var head = E('div', { 'class': 'mt5700-terminal-line mt5700-terminal-prompt' });
				head.appendChild(E('span', {}, '› ' + e.cmd + '  '));
				head.appendChild(E('span', { 'class': 'mt5700-log-cmd' }, e.at));
				consoleEl.appendChild(head);
				consoleEl.appendChild(E('div', {
					'class': 'mt5700-terminal-line ' + (e.ok ? 'mt5700-log-ok' : 'mt5700-log-err')
				}, e.body));
			}
			consoleEl.scrollTop = consoleEl.scrollHeight;
		}

		/* ---------- 发送 ---------- */
		var sending = false;

		/* 发送中禁用所有命令按钮：否则用户点第二下只会命中 `if (sending) return;`
		 * 被静默丢弃，看起来像按钮坏了。AGENTS.md 也要求提交中禁用按钮。 */
		function setCmdButtonsDisabled(disabled) {
			allCmdBtns.forEach(function (b) { b.disabled = disabled; });
		}

		function send(cmd) {
			var command = (cmd != null ? cmd : cmdInput.value).trim();
			if (!command) { Mt5700.warning('请输入 AT 指令'); return; }
			if (sending) return;
			sending = true;
			sendBtn.disabled = true;
			setCmdButtonsDisabled(true);

			Mt5700d.client.sendCommand(command).then(function (res) {
				/* 时刻取后端 nettime（应答自带 at_ms），不用浏览器时钟：
				 * 手机时区设错 / 系统时间偏了时，终端回显的时间必须与日志/通知一致。
				 * 老后端无 at_ms 时显示占位，不拿本地时钟冒充。 */
				var stamp = Mt5700d.serverClock(res && res.at_ms);
				entries.push({
					cmd: command,
					body: res.success ? String(res.data || '(无输出)') : String(res.error || '未知错误'),
					ok: !!res.success,
					at: stamp || '时间未知'
				});
				cmdInput.value = '';
				renderConsole();
			}).catch(function () {
				Mt5700.error('发送失败');
			}).then(function () {
				sending = false;
				sendBtn.disabled = false;
				setCmdButtonsDisabled(false);
			});
		}

		/* 命令按钮点击后二次确认再下发。
		 * 写操作用更重的文案，避免「重启模组 / 流量清零」被当成普通查询误触。 */
		function confirmAndSend(command, label, danger) {
			var prefix = danger ? '谨慎操作：这条指令会改变模组状态或数据。\n\n' : '';
			Mt5700.confirm(prefix + '确认向模组发送该指令？\n\n' + label + '（' + command + '）', function () {
				send(command);
			}, danger ? '确认下发写操作' : '确认发送');
		}

		/* ---------- 初始化 ---------- */
		renderConsole();
		applyFilter();

		Ui.startup(body);

		return page;
	}
});
