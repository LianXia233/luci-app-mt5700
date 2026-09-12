'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Parse, Ui */

/**
 * 网络状态（原 WebUI 网络 → 网络状态）
 * 等价迁移 network/Info.tsx：网络注册状态、运营商、信号、载波聚合、速率曲线、
 * PDCP 实时数据、流量统计、温度、DHCP、QCI/APN、IPv6 能力。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Ui.page('网络状态', '实时网络信息与信号质量');
		var body = page._body;
		Ui.renderConnectionBar(body);

		var conn = Ui.panel('连接状态');
		var kv = E('table', { 'class': 'at-kv' });
		conn._body.appendChild(kv);
		body.appendChild(conn);

		var signalPanel = Ui.panel('信号质量', '主小区 RSRP/RSRQ/SINR');
		var sigGrid = E('div', { 'class': 'at-metrics' });
		signalPanel._body.appendChild(sigGrid);
		body.appendChild(signalPanel);

		var carrierPanel = Ui.panel('载波聚合', '当前所有激活载波');
		var carrierTable = E('table', { 'class': 'cbi-section-table at-table' });
		carrierPanel._body.appendChild(carrierTable);
		body.appendChild(carrierPanel);

		var secondaryPanel = Ui.panel('辅载波信号', '^MONSSC(NSA 辅站) 与 ^CASCELLINFO(LTE CA) 按下行频点对上 ^HFREQINFO 载波');
		var secondaryBox = E('div', {});
		secondaryPanel._body.appendChild(secondaryBox);
		body.appendChild(secondaryPanel);

		var diagPanel = Ui.panel('连接诊断', 'ENDC 双连接、5G 核心网注册、发射功率与 PDP 地址');
		var diagBox = E('div', {});
		diagPanel._body.appendChild(diagBox);
		body.appendChild(diagPanel);

		var speedPanel = Ui.panel('实时速率', 'PDCP 层上下行速率，约 0.75 秒刷新一次');
		var speedRow = E('div', { 'class': 'at-speed-row' });
		speedPanel._body.appendChild(speedRow);
		var historyPanel = Ui.panel('速率曲线', '最近 60 个采样点');
		var chart = E('div', { 'class': 'at-chart', style: 'height:160px' });
		historyPanel._body.appendChild(chart);
		body.appendChild(speedPanel);
		body.appendChild(historyPanel);

		var flowPanel = Ui.panel('流量统计', '上行/下行累计流量与时长');
		var flowGrid = E('div', { 'class': 'at-metrics' });
		flowPanel._body.appendChild(flowGrid);
		body.appendChild(flowPanel);

		var tempPanel = Ui.panel('模组温度', '各芯片温度，单位 ℃');
		var tempGrid = E('div', { 'class': 'at-metrics' });
		tempPanel._body.appendChild(tempGrid);
		body.appendChild(tempPanel);

		var dhcpPanel = Ui.panel('IP 与 DNS', 'DHCP 分配与 IPv6 能力');
		var dhcpTable = E('table', { 'class': 'at-kv' });
		dhcpPanel._body.appendChild(dhcpTable);
		body.appendChild(dhcpPanel);

		var mcsPanel = Ui.panel('调制方式', '上下行 MCS 与层数');
		var mcsGrid = E('div', { 'class': 'at-metrics' });
		mcsPanel._body.appendChild(mcsGrid);
		body.appendChild(mcsPanel);

		/* ---------- 状态 ---------- */
		var networkStatus = E('span', {}, '等待状态中');
		var operator = E('span', {}, '未知运营商');
		var apn = E('span', {}, '未知');
		var qci = E('span', {}, '未知');
		var downSpeed = { value: '0.00', unit: 'Mbps' };
		var upSpeed = { value: '0.00', unit: 'Mbps' };

		var state = {
			cell: {
				mcc: '', mnc: '', lac: '', cid: '', channel: '', pci: 0,
				rsrp: null, rsrq: null, sinr: null, sysMode: '未知', signalPercent: ''
			},
			carriers: [],
			secondaryNR: [], secondaryLTE: [],
			diag: { endc: null, reg: null, tx: null, nrTx: [], addrs: [] },
			temps: { sub3GPA: 0, sub6GPA: 0, mimoPa: 0, tcxo: 0, ap1: 0, ap2: 0, modem1: 0 },
			flow: { lastDsTime: 0, lastTxFlow: 0, lastRxFlow: 0, totalDsTime: 0, totalTxFlow: 0, totalRxFlow: 0 },
			dhcpv4: null, dhcpv6: null, ipv6Cap: null,
			uplinkMCS: null, downlinkMCS: null,
			activeCid: null,
			downSpeed: 0, upSpeed: 0,
			/* 'bytes' = PDCP 实时速率（字节/秒）；'kbps' = AT^DSAMBR 签约速率。 */
			speedUnit: 'bytes'
		};
		var history = [];
		var HISTORY_POINTS = 60;

		function renderKv() {
			kv.innerHTML = '';
			var cells = state.cell;
			var rows = [
				{ label: '网络状态', value: networkStatus },
				{ label: '运营商', value: operator },
				{ label: '网络模式', value: cells.sysMode || '未知' },
				{ label: 'PLMN', value: (cells.mcc || '—') + ' / ' + (cells.mnc || '—') },
				{ label: 'LAC / 小区', value: (cells.lac || '—') + ' / ' + (cells.cid || '—') },
				{ label: 'PCI / 频点', value: (cells.pci || '—') + ' / ' + (cells.channel || '—') },
				{ label: '信号强度', value: cells.signalPercent || '—' },
				{ label: 'APN', value: apn },
				{ label: 'QCI', value: qci },
				{ label: '下行速率', value: E('span', { 'class': 'at-speed-num' }, downSpeed.value + ' ' + downSpeed.unit) },
				{ label: '上行速率', value: E('span', { 'class': 'at-speed-num' }, upSpeed.value + ' ' + upSpeed.unit) }
			];
			for (var i = 0; i < rows.length; i++) {
				var tr = E('tr');
				tr.appendChild(E('td', { 'class': 'at-kv-label' }, rows[i].label));
				var td = E('td', { 'class': 'at-kv-value' });
				if (typeof rows[i].value === 'string' || typeof rows[i].value === 'number') td.textContent = String(rows[i].value);
				else td.appendChild(rows[i].value);
				tr.appendChild(td);
				kv.appendChild(tr);
			}
		}

		function renderSignal() {
			sigGrid.innerHTML = '';
			var c = state.cell;
			var items = [
				{ label: 'RSRP', value: c.rsrp != null ? c.rsrp + ' dBm' : '—', color: c.rsrp != null ? AtWs.signalColor(c.rsrp) : '#8f8f8f' },
				{ label: 'RSRQ', value: c.rsrq != null ? c.rsrq + ' dB' : '—' },
				{ label: 'SINR', value: c.sinr != null ? c.sinr + ' dB' : '—' },
				{ label: '信号百分比', value: c.signalPercent || '—' }
			];
			for (var i = 0; i < items.length; i++) {
				var m = E('div', { 'class': 'at-metric' });
				m.appendChild(E('div', { 'class': 'at-metric-label' }, items[i].label));
				var v = E('div', { 'class': 'at-metric-value', style: 'color:' + (items[i].color || '#333') }, items[i].value);
				m.appendChild(v);
				sigGrid.appendChild(m);
			}
		}

		function renderCarriers() {
			carrierTable.innerHTML = '';
			var head = E('thead');
			var hr = E('tr');
			['制式', '频段', '频点', '带宽', 'PCI', 'RSRP', 'RSRQ', 'SINR'].forEach(function (h) {
				hr.appendChild(E('th', {}, h));
			});
			head.appendChild(hr);
			carrierTable.appendChild(head);
			var tb = E('tbody');
			var rows = state.carriers;
			if (!rows.length) {
				var tr0 = E('tr');
				tr0.appendChild(E('td', { 'colspan': '8', 'class': 'at-empty' }, '暂无载波信息'));
				tb.appendChild(tr0);
			} else {
				for (var i = 0; i < rows.length; i++) {
					var r = rows[i];
					var tr = E('tr');
					var kind = r.kind || (r.ratName || '');
					tr.appendChild(E('td', {}, kind));
					tr.appendChild(E('td', {}, r.band != null ? AtWs.bandName(kind, r.band) : '—'));
					tr.appendChild(E('td', {}, r.channel || '—'));
					tr.appendChild(E('td', {}, r.bandwidth || '—'));
					tr.appendChild(E('td', {}, r.pci != null ? String(r.pci) : '—'));
					tr.appendChild(E('td', {}, r.rsrp != null ? r.rsrp + ' dBm' : '—'));
					tr.appendChild(E('td', {}, r.rsrq != null ? r.rsrq + ' dB' : '—'));
					tr.appendChild(E('td', {}, r.sinr != null ? r.sinr + ' dB' : '—'));
					tb.appendChild(tr);
				}
			}
			carrierTable.appendChild(tb);
			renderSecondary();
		}

		/* ---------- 辅载波信号（carrier.ts 等价迁移） ---------- */

		function dash(v, unit) { return v == null ? '—' : v + unit; }

		function renderSecondary() {
			secondaryBox.innerHTML = '';
			var nr = state.secondaryNR || [];
			var lte = state.secondaryLTE || [];
			if (!nr.length && !lte.length) {
				secondaryBox.appendChild(E('div', { 'class': 'at-note' },
					'未查询到辅载波（非 NSA / 未配置 CA 时 ^MONSSC 与 ^CASCELLINFO 正常失败，属预期情况）'));
				return;
			}
			// 按下行频点把信号质量对到 ^HFREQINFO 载波上
			var merged = [];
			state.carriers.forEach(function (c, i) {
				var sig = Parse.carrierSignalFor({ sysMode: c.sysMode === 'NR' ? 'NR' : 'LTE', dlFcn: String(c.channel) }, nr, lte);
				merged.push({
					title: i === 0 ? '主载波' : '辅载波 ' + i,
					kind: c.sysMode, band: c.band, channel: c.channel, bandwidth: c.bandwidth,
					sig: sig
				});
			});
			var orphan = Parse.unmatchedSecondaries(
				state.carriers.map(function (c) { return { sysMode: c.sysMode === 'NR' ? 'NR' : 'LTE', dlFcn: String(c.channel) }; }),
				nr, lte
			);
			var table = E('table', { 'class': 'cbi-section-table at-table' });
			var head = E('thead'), hr = E('tr');
			['载波', '制式', '频段', '下行频点', '带宽', 'PCI', 'RSRP', 'RSRQ', 'SINR/RSSI', '测量'].forEach(function (h) {
				hr.appendChild(E('th', {}, h));
			});
			head.appendChild(hr);
			table.appendChild(head);
			var tb = E('tbody');
			if (!merged.length) {
				var tr0 = E('tr');
				tr0.appendChild(E('td', { 'colspan': '10', 'class': 'at-empty' }, '暂无主载波信息'));
				tb.appendChild(tr0);
			}
			merged.forEach(function (m) {
				var tr = E('tr');
				tr.appendChild(E('td', {}, m.title));
				tr.appendChild(E('td', {}, m.kind || '—'));
				tr.appendChild(E('td', {}, m.band != null ? AtWs.bandName(m.kind, m.band) : '—'));
				tr.appendChild(E('td', {}, m.channel || '—'));
				tr.appendChild(E('td', {}, m.bandwidth || '—'));
				if (m.sig) {
					tr.appendChild(E('td', {}, String(m.sig.pci)));
					var r = E('td', { style: 'color:' + (m.sig.rsrp != null ? AtWs.signalColor(m.sig.rsrp) : '#8f8f8f') },
						dash(m.sig.rsrp, ' dBm'));
					tr.appendChild(r);
					tr.appendChild(E('td', {}, dash(m.sig.rsrq, ' dB')));
					tr.appendChild(E('td', {},
						m.sig.sinr != null ? dash(m.sig.sinr, ' dB') : dash(m.sig.rssi != null ? m.sig.rssi : null, ' dBm')));
					tr.appendChild(E('td', {}, m.sig.measType || '—'));
				} else {
					tr.appendChild(E('td', {}, '—'));
					tr.appendChild(E('td', {}, '—'));
					tr.appendChild(E('td', {}, '—'));
					tr.appendChild(E('td', {}, '—'));
					tr.appendChild(E('td', {}, '—'));
				}
				tb.appendChild(tr);
			});
			table.appendChild(tb);
			secondaryBox.appendChild(table);
			// 没能对上任何载波的辅小区单独列出，不丢数据
			if (orphan.nr.length || orphan.lte.length) {
				var note = E('div', { 'class': 'at-note' },
					'以下小区来自 ^MONSSC / ^CASCELLINFO 上报，但频点没和 ^HFREQINFO 载波对上（两条命令上报时机可能不同步），单独列出以免数据丢失：');
				secondaryBox.appendChild(note);
				var ul = E('ul', { 'class': 'at-agree-list' });
				orphan.nr.forEach(function (c) {
					ul.appendChild(E('li', {},
						'NR 频点 ' + c.arfcn + ' · PCI ' + c.pci + '：' +
						dash(c.rsrp, ' dBm') + ' / ' + dash(c.rsrq, ' dB') + ' / ' + dash(c.sinr, ' dB')));
				});
				orphan.lte.forEach(function (c) {
					ul.appendChild(E('li', {},
						'LTE B' + c.band + ' · PCI ' + c.pci + '：' +
						dash(c.rsrp, ' dBm') + ' / ' + dash(c.rsrq, ' dB') + ' / ' + dash(c.rssi, ' dBm')));
				});
				secondaryBox.appendChild(ul);
			}
		}

		/* ---------- 连接诊断（Diagnostics.tsx 等价迁移） ---------- */

		function renderDiag() {
			diagBox.innerHTML = '';
			var d = state.diag;
			var kvD = E('table', { 'class': 'at-kv' });
			var endcTag = '不适用';
			if (d.endc) {
				if (d.endc.established) endcTag = '已建立';
				else if (!d.endc.available) endcTag = '小区不支持';
				else if (!d.endc.plmnAvailable) endcTag = '运营商未开通';
				else if (d.endc.restricted) endcTag = '网络侧受限';
				else endcTag = '支持但未建立';
			}
			var regVal = d.reg ? (d.reg.statText + (d.reg.act ? ' · ' + d.reg.act : '')) : '未注册 5GC';
			var txVal = d.tx ? (dash(d.tx.pusch, ' dBm') + ' / ' + dash(d.tx.pucch, ' dBm')) : '—';
			var txVal2 = d.tx ? (dash(d.tx.srs, ' dBm') + ' / ' + dash(d.tx.prach, ' dBm')) : '—';
			var rows = [
				{ label: 'ENDC 双连接', value: endcTag },
				{ label: '5G 核心网注册', value: regVal },
				{ label: 'TAC / 小区', value: d.reg && d.reg.tac ? (d.reg.tac + ' / ' + (d.reg.ci || '—')) : '—' },
				{ label: '网络切片', value: d.reg && d.reg.nssai ? d.reg.nssai : '—' },
				{ label: 'LTE PUSCH / PUCCH', value: txVal },
				{ label: 'LTE SRS / PRACH', value: txVal2 }
			];
			if (d.tx && d.tx.total != null) rows.push({ label: '2G/3G 总功率', value: dash(d.tx.total, ' dBm') });
			(d.nrTx || []).forEach(function (c, i) {
				rows.push({
					label: 'NR CC' + (i + 1) + ' PUSCH',
					value: dash(c.pusch, ' dBm') + (c.freq ? ' · ' + (c.freq / 1000).toFixed(1) + ' MHz' : '')
				});
			});
			for (var i = 0; i < rows.length; i++) {
				var tr = E('tr');
				tr.appendChild(E('td', { 'class': 'at-kv-label' }, rows[i].label));
				var td = E('td', { 'class': 'at-kv-value' });
				td.textContent = String(rows[i].value);
				tr.appendChild(td);
				kvD.appendChild(tr);
			}
			diagBox.appendChild(kvD);
			if (d.addrs && d.addrs.length) {
				var addrNote = E('div', { 'class': 'at-note' }, 'PDP 地址：');
				diagBox.appendChild(addrNote);
				var ul = E('ul', { 'class': 'at-agree-list' });
				d.addrs.forEach(function (a) {
					ul.appendChild(E('li', {}, 'CID ' + a.cid + ' · ' + a.family + '：' + a.address));
				});
				diagBox.appendChild(ul);
			} else {
				diagBox.appendChild(E('div', { 'class': 'at-note' }, '没有已激活的 PDP 上下文地址。'));
			}
		}

		/*
		 * 速率来源有两种，单位语义不同，必须显式区分，不能共用同一个换算：
		 *   - PDCP 实时速率（第 707/708 行）：字节/秒，需 ×8 换成比特；
		 *   - 签约速率（AT^DSAMBR，第 512/513 行）：kbps，本身就是比特单位，不得再 ×8。
		 * state.speedUnit 记录当前值属于哪种，splitSpeedUI 据此选择换算路径。
		 */
		function renderSpeed() {
			speedRow.innerHTML = '';
			var d = splitSpeedUI(state.downSpeed, state.speedUnit);
			var u = splitSpeedUI(state.upSpeed, state.speedUnit);
			downSpeed = d; upSpeed = u;
			var box = E('div', { 'class': 'at-speed-box' });
			var dEl = E('div', { 'class': 'at-speed-dir' });
			dEl.appendChild(E('div', { 'class': 'at-speed-label' }, '↓ 下行'));
			dEl.appendChild(E('div', { 'class': 'at-speed-value' }, d.value + ' ' + d.unit));
			var uEl = E('div', { 'class': 'at-speed-dir' });
			uEl.appendChild(E('div', { 'class': 'at-speed-label' }, '↑ 上行'));
			uEl.appendChild(E('div', { 'class': 'at-speed-value' }, u.value + ' ' + u.unit));
			box.appendChild(dEl);
			box.appendChild(uEl);
			speedRow.appendChild(box);
			renderKv();
			renderChart();
		}

		/*
		 * 把速率值格式化为 {value, unit}。
		 * unitMode：
		 *   'kbps'  —— 输入单位是 kbps（比特），直接乘 1000 得 bps；
		 *   'bytes' —— 输入单位是字节/秒，乘 8 得 bps（PDCP 实时速率的默认口径）。
		 */
		function splitSpeedUI(value, unitMode) {
			var bits = (unitMode === 'kbps') ? (value * 1000) : (value * 8);
			if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps' };
			if (bits >= 1e6) return { value: (bits / 1e6).toFixed(2), unit: 'Mbps' };
			if (bits >= 1e3) return { value: (bits / 1e3).toFixed(2), unit: 'Kbps' };
			return { value: String(Math.round(bits)), unit: 'bps' };
		}

		function renderChart() {
			chart.innerHTML = '';
			if (!history.length) {
				chart.appendChild(E('div', { 'class': 'at-empty' }, '等待数据…'));
				return;
			}
			var w = chart.clientWidth || 600, h = 150;
			var max = 1;
			history.forEach(function (p) { max = Math.max(max, p.down, p.up); });
			var svg = 'http://www.w3.org/2000/svg';
			var s = document.createElementNS(svg, 'svg');
			s.setAttribute('width', w);
			s.setAttribute('height', h);
			var line = function (points, color) {
				var poly = document.createElementNS(svg, 'polyline');
				poly.setAttribute('fill', 'none');
				poly.setAttribute('stroke', color);
				poly.setAttribute('stroke-width', '1.5');
				var pts = [];
				for (var i = 0; i < points.length; i++) {
					var x = (i / (HISTORY_POINTS - 1 || 1)) * (w - 4) + 2;
					var y = h - 10 - (points[i] / max) * (h - 30);
					pts.push(x.toFixed(1) + ',' + y.toFixed(1));
				}
				poly.setAttribute('points', pts.join(' '));
				s.appendChild(poly);
			};
			line(history.map(function (p) { return p.down; }), '#1a5eab');
			line(history.map(function (p) { return p.up; }), '#2e7d32');
			chart.appendChild(s);
		}

		function renderFlow() {
			flowGrid.innerHTML = '';
			var f = state.flow;
			var items = [
				{ label: '当前会话时长', value: AtWs.formatDuration(f.lastDsTime, false) },
				{ label: '当前下行流量', value: AtWs.formatFlow(f.lastRxFlow) },
				{ label: '当前上行流量', value: AtWs.formatFlow(f.lastTxFlow) },
				{ label: '累计时长', value: AtWs.formatDuration(f.totalDsTime, true) },
				{ label: '累计下行', value: AtWs.formatFlow(f.totalRxFlow) },
				{ label: '累计上行', value: AtWs.formatFlow(f.totalTxFlow) }
			];
			for (var i = 0; i < items.length; i++) {
				var m = E('div', { 'class': 'at-metric' });
				m.appendChild(E('div', { 'class': 'at-metric-label' }, items[i].label));
				m.appendChild(E('div', { 'class': 'at-metric-value' }, items[i].value));
				flowGrid.appendChild(m);
			}
		}

		function renderTemp() {
			tempGrid.innerHTML = '';
			var t = state.temps;
			var items = [
				{ label: 'Sub3G PA', value: t.sub3GPA }, { label: 'Sub6G PA', value: t.sub6GPA },
				{ label: 'MIMO PA', value: t.mimoPa }, { label: 'TCXO', value: t.tcxo },
				{ label: 'AP1', value: t.ap1 }, { label: 'AP2', value: t.ap2 }, { label: 'Modem1', value: t.modem1 }
			];
			for (var i = 0; i < items.length; i++) {
				var m = E('div', { 'class': 'at-metric' });
				m.appendChild(E('div', { 'class': 'at-metric-label' }, items[i].label));
				m.appendChild(E('div', { 'class': 'at-metric-value' }, items[i].value ? items[i].value + ' ℃' : '—'));
				tempGrid.appendChild(m);
			}
		}

		function renderDHCP() {
			dhcpTable.innerHTML = '';
			var rows = [];
			var v4 = state.dhcpv4, v6 = state.dhcpv6;
			if (v4) {
				rows.push({ label: 'IPv4 地址', value: v4.ipv4Address });
				rows.push({ label: '子网掩码', value: v4.subnetMask });
				rows.push({ label: '网关', value: v4.gateway });
				rows.push({ label: 'DHCP 服务器', value: v4.dhcpServer });
				rows.push({ label: '主 DNS', value: v4.primaryDNS });
				rows.push({ label: '备 DNS', value: v4.secondaryDNS });
			}
			if (v6) {
				rows.push({ label: 'IPv6 地址', value: v6.ipv6Address });
				rows.push({ label: 'IPv6 前缀', value: v6.netmask });
				rows.push({ label: 'IPv6 网关', value: v6.gateway });
				rows.push({ label: 'IPv6 DNS', value: v6.primaryDNS + ' / ' + v6.secondaryDNS });
			}
			if (state.ipv6Cap) rows.push({ label: 'IPv6 能力', value: state.ipv6Cap.description });
			if (!rows.length) rows.push({ label: '信息', value: '暂无数据' });
			for (var i = 0; i < rows.length; i++) {
				var tr = E('tr');
				tr.appendChild(E('td', { 'class': 'at-kv-label' }, rows[i].label));
				tr.appendChild(E('td', { 'class': 'at-kv-value' }, rows[i].value));
				dhcpTable.appendChild(tr);
			}
		}

		function renderMCS() {
			mcsGrid.innerHTML = '';
			var dl = state.downlinkMCS, ul = state.uplinkMCS;
			var items = [
				{ label: '下行 MCS', value: dl ? (dl.mcs != null ? 'MCS ' + dl.mcs + (dl.rank ? ' · ' + dl.rank + ' 层' : '') : '—') : '—' },
				{ label: '上行 MCS', value: ul ? (ul.mcs != null ? 'MCS ' + ul.mcs + (ul.rank ? ' · ' + ul.rank + ' 层' : '') : '—') : '—' }
			];
			for (var i = 0; i < items.length; i++) {
				var m = E('div', { 'class': 'at-metric' });
				m.appendChild(E('div', { 'class': 'at-metric-label' }, items[i].label));
				m.appendChild(E('div', { 'class': 'at-metric-value' }, items[i].value));
				mcsGrid.appendChild(m);
			}
		}

		/* ---------- 数据获取（等价原 Info.tsx 全部命令） ---------- */

		function resolveActiveCid(force) {
			if (!force && state.activeCid !== null) return Promise.resolve(state.activeCid);
			return AtWs.client.sendCommand('AT+CGACT?').then(function (res) {
				if (!res.success || !res.data) return state.activeCid;
				var active = [];
				AtWs.extractATDataMultiline(res.data, '+CGACT').forEach(function (row) {
					var p = row.split(',');
					if (p[1] && p[1].trim() === '1' && Number(p[0]) > 0) active.push(Number(p[0]));
				});
				state.activeCid = active.length ? Math.min.apply(null, active) : null;
				return state.activeCid;
			});
		}

		function getPSReg() {
			return AtWs.client.sendCommand('AT+CGREG?').then(function (res) {
				if (res.success && res.data) {
					var stat = null;
					AtWs.extractATDataMultiline(res.data, '+CGREG').forEach(function (row) {
						var p = row.split(',');
						if (p.length >= 2) stat = p[1].trim();
					});
					networkStatus.textContent = AtWs.psRegText(stat);
				}
			});
		}

		function getOperator() {
			return AtWs.client.sendCommand('AT^EONS=2').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^EONS');
					var code = str ? (str.split(',')[1] || '').trim().replace(/"/g, '') : '';
					operator.textContent = AtWs.operatorFromCode(code);
				}
			});
		}

		function getAMBR() {
			return resolveActiveCid().then(function (cid) {
				var candidates = [];
				if (cid && cid > 0) candidates.push(cid);
				candidates.push(1);
				var unique = Array.from(new Set(candidates));
				var chain = Promise.resolve();
				unique.forEach(function (candidate) {
					chain = chain.then(function () {
						return AtWs.client.sendCommand('AT^DSAMBR=' + candidate).then(function (res) {
							if (!res.success || !res.data) return;
							var str = AtWs.extractATData(res.data, '^DSAMBR');
							if (!str) return;
							var parts = str.split(',');
							/*
							 * 手册 16.17 节：^DSAMBR: <cid>,<DlApnAmbr>,<UlApnAmbr>
							 *   DlApnAmbr / UlApnAmbr 均为 kbps（不是 bps、更不是字节）。
							 * 故此处保留 kbps 原值，并把单位口径标记为 'kbps'，
							 * 由 splitSpeedUI 按 kbps→bps（×1000）换算，
							 * 绝不能再走字节口径的 ×8（那会把 102.4 Mbps 显示成 819 bps）。
							 */
							if (parts.length >= 3) {
								state.downSpeed = parseInt(parts[1], 10) || 0;
								state.upSpeed = parseInt(parts[2], 10) || 0;
								state.speedUnit = 'kbps';
							}
							/*
							 * 第 4 个字段（索引 3）在手册标准格式中并不存在，
							 * 属部分固件版本的扩展字段且语义为 APN 字符串。
							 * 仅当它确实是「带引号的字符串」时才采信；若是纯数字
							 * （其他固件可能在此处返回计数值）则忽略，避免把数字当 APN。
							 */
							if (parts.length >= 4) {
								var apnRaw = parts[3].trim();
								if (/^".*"$/.test(apnRaw) || /^'.*'$/.test(apnRaw)) {
									apn.textContent = apnRaw.replace(/^["']|["']$/g, '') || '未知';
								}
							}
							throw 'done';
						}).catch(function (e) {
							if (e === 'done') return Promise.reject('break');
							return Promise.resolve();
						});
					});
				});
				return chain.catch(function (e) {
					if (e === 'break') { /* 已找到 */ }
					state.activeCid = null;
				}).then(renderSpeed);
			});
		}

		function getQCI() {
			return resolveActiveCid().then(function (cid) {
				return AtWs.client.sendCommand('AT+CGEQOSRDP').then(function (res) {
					if ((!res.success || !res.data) && cid) return AtWs.client.sendCommand('AT+CGEQOSRDP=' + cid);
					return res;
				}).then(function (res) {
					if (!res.success || !res.data) return;
					var rows = AtWs.extractATDataMultiline(res.data, '+CGEQOSRDP');
					var row = null;
					if (cid !== null) {
						for (var i = 0; i < rows.length; i++) {
							if (Number(rows[i].split(',')[0]) === cid) { row = rows[i]; break; }
						}
					}
					if (!row && rows.length) row = rows[0];
					if (row) qci.textContent = AtWs.qciLabel(row.split(',')[1] ? row.split(',')[1].trim() : '');
				});
			});
		}

		function getDHCP() {
			return AtWs.client.sendCommand('AT^DHCPV6?').then(function (v6) {
				if (v6.success && v6.data) {
					var str = AtWs.extractATData(v6.data, '^DHCPV6');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.dhcpv6 = {
								ipv6Address: d[0].trim(), netmask: d[1].trim(), gateway: d[2].trim(),
								dhcpServer: d[3].trim(), primaryDNS: d[4].trim(), secondaryDNS: d[5].trim()
							};
						}
					}
				}
				return AtWs.client.sendCommand('AT^DHCP?');
			}).then(function (v4) {
				if (v4.success && v4.data) {
					var str = AtWs.extractATData(v4.data, '^DHCP');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.dhcpv4 = {
								ipv4Address: AtWs.hexToIP(d[0].trim()), subnetMask: AtWs.hexToIP(d[1].trim()),
								gateway: AtWs.hexToIP(d[2].trim()), dhcpServer: AtWs.hexToIP(d[3].trim()),
								primaryDNS: AtWs.hexToIP(d[4].trim()), secondaryDNS: AtWs.hexToIP(d[5].trim())
							};
						}
					}
				}
				return AtWs.client.sendCommand('AT^IPV6CAP?');
			}).then(function (cap) {
				if (cap.success && cap.data) {
					var str = AtWs.extractATData(cap.data, '^IPV6CAP');
					if (str) {
						var value = parseInt(str.trim(), 10);
						if (!isNaN(value)) state.ipv6Cap = { capValue: value, description: Parse.ipv6CapDescription(value) };
					}
				}
			}).then(renderDHCP);
		}

		function getFlow() {
			return AtWs.client.sendCommand('AT^DSFLOWQRY').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^DSFLOWQRY');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.flow = {
								lastDsTime: AtWs.parseHexValue(d[0]), lastTxFlow: AtWs.parseHexValue(d[1]),
								lastRxFlow: AtWs.parseHexValue(d[2]), totalDsTime: AtWs.parseHexValue(d[3]),
								totalTxFlow: AtWs.parseHexValue(d[4]), totalRxFlow: AtWs.parseHexValue(d[5])
							};
							renderFlow();
						}
					}
				}
			});
		}

		function getTemp() {
			return AtWs.client.sendCommand('AT^CHIPTEMP?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseCHIPTEMP(res.data);
					if (parsed) { state.temps = parsed; renderTemp(); }
				}
			});
		}

		function getMCS() {
			return AtWs.client.sendCommand('AT^MCS=1').then(function (dl) {
				if (dl.success && dl.data) state.downlinkMCS = Parse.parseMCS(dl.data);
				return AtWs.client.sendCommand('AT^MCS=0');
			}).then(function (ul) {
				if (ul.success && ul.data) state.uplinkMCS = Parse.parseMCS(ul.data);
				renderMCS();
			});
		}

		function updateNetworkInfo() {
			var carriers = [];
			return AtWs.client.sendCommand('AT^MONSC').then(function (monsc) {
				var serving = monsc.success && monsc.data ? AtWs.parseMONSC(monsc.data) : null;
				return AtWs.client.sendCommand('AT^HFREQINFO?').then(function (hfreq) {
					carriers = hfreq.success && hfreq.data ? AtWs.parseHFREQINFO(hfreq.data) : [];
					if (!carriers.length) return AtWs.client.sendCommand('AT^HCSQ?').then(function (hcsq) {
						var hcsqData = hcsq.success && hcsq.data ? AtWs.parseHCSQ(hcsq.data) : null;
						if (hcsqData) {
							state.cell.rsrp = hcsqData.rsrp;
							state.cell.rsrq = hcsqData.rsrq;
							state.cell.sinr = hcsqData.sinr;
						}
						return null;
					});
					return null;
				}).then(function () {
					if (serving) {
						state.cell.mcc = serving.mcc; state.cell.mnc = serving.mnc;
						state.cell.lac = serving.lac; state.cell.cid = serving.cid;
						state.cell.channel = serving.channel; state.cell.pci = serving.pci;
						state.cell.rsrp = serving.rsrp != null ? serving.rsrp : state.cell.rsrp;
						state.cell.rsrq = serving.rsrq != null ? serving.rsrq : state.cell.rsrq;
						state.cell.sinr = serving.sinr != null ? serving.sinr : state.cell.sinr;
						state.cell.sysMode = serving.sysMode || state.cell.sysMode;
						state.cell.signalPercent = serving.signalPercent || '';
					}
					state.carriers = carriers.map(function (c) {
						return {
							kind: c.kind, band: c.band ? Number(c.band) : null, channel: c.channel,
							bandwidth: c.bandwidth, pci: c.pci, rsrp: c.rsrp, rsrq: c.rsrq, sinr: c.sinr,
							sysMode: c.sysMode || c.kind || ''
						};
					});
					renderSignal();
					renderCarriers();
					renderKv();
				});
			});
		}

		/* ---------- 辅载波与诊断 ---------- */

		function loadSecondary() {
			return AtWs.client.sendCommand('AT^MONSSC').then(function (monssc) {
				state.secondaryNR = monssc.success && monssc.data ? Parse.parseMonsscAll(String(monssc.data)) : [];
				return AtWs.client.sendCommand('AT^CASCELLINFO?');
			}).then(function (cascell) {
				state.secondaryLTE = cascell.success && cascell.data ? Parse.parseCascellAll(String(cascell.data)) : [];
				renderSecondary();
			});
		}

		function loadDiagnostics() {
			// 这几条都可能因为"当前不是那个组网"而失败，属于正常情况，静默处理
			return AtWs.client.sendCommand('AT^LENDC?').then(function (lendc) {
				state.diag.endc = lendc.success && lendc.data ? Parse.parseLendc(lendc.data) : null;
				return AtWs.client.sendCommand('AT+C5GREG?');
			}).then(function (c5g) {
				state.diag.reg = c5g.success && c5g.data ? Parse.parseC5greg(c5g.data) : null;
				return AtWs.client.sendCommand('AT^TXPOWER?');
			}).then(function (txp) {
				state.diag.tx = txp.success && txp.data ? Parse.parseTxPower(txp.data) : null;
				return AtWs.client.sendCommand('AT^NTXPOWER?');
			}).then(function (ntxp) {
				state.diag.nrTx = ntxp.success && ntxp.data ? Parse.parseNrTxPower(ntxp.data) : [];
				return AtWs.client.sendCommand('AT+CGPADDR');
			}).then(function (pdp) {
				state.diag.addrs = pdp.success && pdp.data ? Parse.parseCgpaddr(pdp.data) : [];
				renderDiag();
			});
		}

		/* ---------- PDCP 实时订阅 ---------- */

		var pdcpHandler = function (resp) {
			if (!resp || resp.type !== 'pdcp_data' || !resp.data) return;
			var d = resp.data;
			/* PDCP 上报单位为字节/秒，除以 1024 归一为 KiB/s，按 'bytes' 口径 ×8 显示。 */
			state.downSpeed = (d.rx_rate || 0) / 1024;
			state.upSpeed = (d.tx_rate || 0) / 1024;
			state.speedUnit = 'bytes';
			history.push({ down: state.downSpeed, up: state.upSpeed });
			if (history.length > HISTORY_POINTS) history = history.slice(history.length - HISTORY_POINTS);
			renderSpeed();
		};
		AtWs.client.subscribe(pdcpHandler);
		self._unsubs = self._unsubs || [];
		self._unsubs.push(function () { AtWs.client.unsubscribe(pdcpHandler); });

		/* ---------- 刷新 ---------- */

		var refreshing = false;
		function refreshAll() {
			if (refreshing) return Promise.resolve();
			refreshing = true;
			var chain = Promise.resolve();
			[getPSReg, getOperator, getAMBR, getQCI, getDHCP, getFlow, getTemp, getMCS, updateNetworkInfo, loadSecondary, loadDiagnostics]
				.forEach(function (fn) { chain = chain.then(fn); });
			return chain.catch(function (err) {
				console.warn('刷新失败', err);
			}).finally(function () { refreshing = false; });
		}

		/* ---------- 自动刷新 ---------- */

		var ar = Ui.autoRefresh(function (enabled, interval) {
			if (timer) { clearInterval(timer); timer = null; }
			if (enabled) timer = Ui.interval(interval * 1000, refreshAll);
		});
		var timer = Ui.interval(5000, refreshAll);

		var extra = E('div', { 'class': 'at-panel-actions' });
		extra.appendChild(ar.el);
		var refreshBtn = Ui.primaryButton('刷新', function () { refreshAll(); });
		extra.appendChild(refreshBtn);
		body.appendChild(extra);

		/* ---------- 初始化 ---------- */

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [
					{ key: 'key', label: '连接密钥', type: 'password', hint: '该密钥保存在 UCI at-webserver.websocket.auth_key' }
				], function (values) {
					if (!values.key) return;
					AtWs.client.connect(values.key).catch(function (e) { Ui.error((e && e.message) || '认证失败'); });
				});
				return;
			}
			if (err) console.warn('连接失败', err);
		}).then(function () {
			refreshAll();
		});

		this._dispose = function () {
			if (timer) clearInterval(timer);
			if (self._unsubs) self._unsubs.forEach(function (f) { f(); });
			self._unsubs = [];
		};

		return page;
	}
});
