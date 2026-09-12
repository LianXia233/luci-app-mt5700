'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 网络状态 - 新 UI 仪表盘
 * 玻璃拟态 + 卡片式 + 动态图表
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络状态', '实时网络信息与信号质量');
		var body = page._body;

		// 连接状态条
		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		// 主状态卡片
		var statusCard = Mt5700.card('连接状态', '当前网络注册与运营商信息');
		var statusGrid = E('div', { 'class': 'mt5700-grid mt5700-grid-4' });
		statusCard._body.appendChild(statusGrid);
		body.appendChild(statusCard);

		// 信号质量卡片
		var signalCard = Mt5700.card('信号质量', '主小区 RSRP/RSRQ/SINR');
		var sigGrid = E('div', { 'class': 'mt5700-grid mt5700-grid-4' });
		signalCard._body.appendChild(sigGrid);
		body.appendChild(signalCard);

		// 载波聚合卡片
		var carrierCard = Mt5700.card('载波聚合', '当前所有激活载波');
		var carrierTable = E('div');
		carrierCard._body.appendChild(carrierTable);
		body.appendChild(carrierCard);

		// 实时速率卡片
		var speedCard = Mt5700.card('实时速率', '接口实时上下行速率，每秒采样一次');
		var speedRow = E('div', { 'class': 'mt5700-speed-row' });
		speedCard._body.appendChild(speedRow);
		var historyPanel = Mt5700.card('速率曲线', '最近 60 个采样点');
		var chart = E('div', { 'class': 'mt5700-chart' });
		historyPanel._body.appendChild(chart);
		body.appendChild(speedCard);
		body.appendChild(historyPanel);

		// 流量统计卡片
		var flowCard = Mt5700.card('流量统计', '上行/下行累计流量与时长');
		var flowGrid = E('div', { 'class': 'mt5700-grid mt5700-grid-3' });
		flowCard._body.appendChild(flowGrid);
		body.appendChild(flowCard);

		// 温度卡片
		var tempCard = Mt5700.card('模组温度', '各芯片温度，单位 ℃');
		var tempGrid = E('div', { 'class': 'mt5700-grid mt5700-grid-4' });
		tempCard._body.appendChild(tempGrid);
		body.appendChild(tempCard);

		// 网络信息卡片
		var infoCard = Mt5700.card('网络信息', 'PLMN、小区、APN、QCI 等');
		var infoTable = E('div');
		infoCard._body.appendChild(infoTable);
		body.appendChild(infoCard);

		// 诊断信息卡片
		var diagCard = Mt5700.card('连接诊断', 'ENDC 双连接、5G 核心网注册、发射功率');
		var diagContent = E('div');
		diagCard._body.appendChild(diagContent);
		body.appendChild(diagCard);

		// 状态数据
		var state = {
			cell: { mcc: '', mnc: '', lac: '', cid: '', channel: '', pci: 0, rsrp: null, rsrq: null, sinr: null, sysMode: '未知', signalPercent: '' },
			carriers: [],
			diag: { endc: null, reg: null, tx: null, nrTx: [], addrs: [] },
			temps: { sub3GPA: 0, sub6GPA: 0, mimoPa: 0, tcxo: 0, ap1: 0, ap2: 0, modem1: 0 },
			flow: { lastDsTime: 0, lastTxFlow: 0, lastRxFlow: 0, totalDsTime: 0, totalTxFlow: 0, totalRxFlow: 0 },
			rtDown: 0, rtUp: 0,
			ambrDown: 0, ambrUp: 0,
			dhcpv4: null, dhcpv6: null, ipv6Cap: null,
			uplinkMCS: null, downlinkMCS: null,
			networkStatus: '等待状态中',
			operator: '未知运营商',
			apn: '未知',
			qci: '未知'
		};
		var history = [];
		var HISTORY_POINTS = 60;

		// 渲染状态卡片
		function renderStatus() {
			statusGrid.innerHTML = '';
			var items = [
				{ label: '网络状态', value: state.networkStatus, color: 'info' },
				{ label: '运营商', value: state.operator },
				{ label: '网络模式', value: state.cell.sysMode || '未知' },
				{ label: 'APN', value: state.apn }
			];
			items.forEach(function (item) {
				statusGrid.appendChild(Mt5700.metric(item.label, item.value, item.color));
			});
		}

		// 渲染信号卡片
		function renderSignal() {
			sigGrid.innerHTML = '';
			var c = state.cell;
			var items = [
				{ label: 'RSRP', value: c.rsrp != null ? c.rsrp + ' dBm' : '—', color: c.rsrp != null ? (c.rsrp >= -90 ? 'success' : c.rsrp >= -105 ? 'warning' : 'danger') : null },
				{ label: 'RSRQ', value: c.rsrq != null ? c.rsrq + ' dB' : '—' },
				{ label: 'SINR', value: c.sinr != null ? c.sinr + ' dB' : '—' },
				{ label: '信号强度', value: c.signalPercent || '—' }
			];
			items.forEach(function (item) {
				sigGrid.appendChild(Mt5700.metric(item.label, item.value, item.color));
			});
		}

		// 渲染载波表格
		function renderCarriers() {
			carrierTable.innerHTML = '';
			if (!state.carriers.length) {
				carrierTable.appendChild(Mt5700.empty('暂无载波信息'));
				return;
			}
			var headers = ['制式', '频段', '频点', '带宽', 'PCI', 'RSRP', 'RSRQ', 'SINR'];
			var rows = state.carriers.map(function (c) {
				return [
					c.kind || c.sysMode || '—',
					c.band != null ? AtWs.bandName(c.kind || c.sysMode, c.band) : '—',
					c.channel || '—',
					c.bandwidth || '—',
					c.pci != null ? String(c.pci) : '—',
					c.rsrp != null ? c.rsrp + ' dBm' : '—',
					c.rsrq != null ? c.rsrq + ' dB' : '—',
					c.sinr != null ? c.sinr + ' dB' : '—'
				];
			});
			carrierTable.appendChild(Mt5700.table(headers, rows, { striped: true }));
		}

		// 渲染速率
		function renderSpeed() {
			speedRow.innerHTML = '';
			var d = formatSpeedUI(state.rtDown, 'bytes');
			var u = formatSpeedUI(state.rtUp, 'bytes');
			speedRow.appendChild(Mt5700.speedBox('↓ 下行', d.value + ' ' + d.unit));
			speedRow.appendChild(Mt5700.speedBox('↑ 上行', u.value + ' ' + u.unit));
			renderChart();
		}

		// 渲染图表
		function renderChart() {
			chart.innerHTML = '';
			if (!history.length) {
				chart.appendChild(Mt5700.empty('等待数据…'));
				return;
			}
			chart.appendChild(Mt5700.lineChart(history, { width: chart.clientWidth || 600, height: 140 }));
		}

		// 渲染流量
		function renderFlow() {
			flowGrid.innerHTML = '';
			var f = state.flow;
			var items = [
				{ label: '当前时长', value: AtWs.formatDuration(f.lastDsTime, false) },
				{ label: '当前下行', value: AtWs.formatFlow(f.lastRxFlow) },
				{ label: '当前上行', value: AtWs.formatFlow(f.lastTxFlow) },
				{ label: '累计时长', value: AtWs.formatDuration(f.totalDsTime, true) },
				{ label: '累计下行', value: AtWs.formatFlow(f.totalRxFlow) },
				{ label: '累计上行', value: AtWs.formatFlow(f.totalTxFlow) }
			];
			items.forEach(function (item) {
				flowGrid.appendChild(Mt5700.metric(item.label, item.value));
			});
		}

		// 渲染温度
		function renderTemp() {
			tempGrid.innerHTML = '';
			var t = state.temps;
			var items = [
				{ label: 'Sub3G PA', value: t.sub3GPA ? t.sub3GPA + ' ℃' : '—' },
				{ label: 'Sub6G PA', value: t.sub6GPA ? t.sub6GPA + ' ℃' : '—' },
				{ label: 'MIMO PA', value: t.mimoPa ? t.mimoPa + ' ℃' : '—' },
				{ label: 'TCXO', value: t.tcxo ? t.tcxo + ' ℃' : '—' }
			];
			items.forEach(function (item) {
				tempGrid.appendChild(Mt5700.metric(item.label, item.value));
			});
		}

		// 渲染网络信息
		function renderInfo() {
			infoTable.innerHTML = '';
			var c = state.cell;
			var rows = [
				['PLMN', (c.mcc || '—') + ' / ' + (c.mnc || '—')],
				['LAC / 小区', (c.lac || '—') + ' / ' + (c.cid || '—')],
				['PCI / 频点', (c.pci || '—') + ' / ' + (c.channel || '—')],
				['QCI', state.qci]
			];
			if (state.dhcpv4) {
				rows.push(['IPv4 地址', state.dhcpv4.ipv4Address]);
				rows.push(['网关', state.dhcpv4.gateway]);
			}
			if (state.dhcpv6) {
				rows.push(['IPv6 地址', state.dhcpv6.ipv6Address]);
			}
			infoTable.appendChild(Mt5700.table(['属性', '值'], rows, { striped: true }));
		}

		// 渲染诊断信息
		function renderDiag() {
			diagContent.innerHTML = '';
			var d = state.diag;
			var endcTag = '不适用';
			if (d.endc) {
				if (d.endc.established) endcTag = '已建立';
				else if (!d.endc.available) endcTag = '小区不支持';
				else if (!d.endc.plmnAvailable) endcTag = '运营商未开通';
				else if (d.endc.restricted) endcTag = '网络侧受限';
				else endcTag = '支持但未建立';
			}
			var regVal = d.reg ? (d.reg.statText + (d.reg.act ? ' · ' + d.reg.act : '')) : '未注册 5GC';
			var rows = [
				['ENDC 双连接', endcTag],
				['5G 核心网注册', regVal],
				['TAC / 小区', d.reg && d.reg.tac ? (d.reg.tac + ' / ' + (d.reg.ci || '—')) : '—']
			];
			diagContent.appendChild(Mt5700.table(['属性', '值'], rows, { striped: true }));
		}

		// 格式化速率
		function formatSpeedUI(value, unitMode) {
			var bits = (unitMode === 'kbps') ? (value * 1000) : (value * 8);
			if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps' };
			if (bits >= 1e6) return { value: (bits / 1e6).toFixed(2), unit: 'Mbps' };
			if (bits >= 1e3) return { value: (bits / 1e3).toFixed(2), unit: 'Kbps' };
			return { value: String(Math.round(bits)), unit: 'bps' };
		}

		// 数据获取
		function refreshAll() {
			return AtWs.client.sendCommand('AT+CGREG?').then(function (res) {
				if (res.success && res.data) {
					var stat = null;
					AtWs.extractATDataMultiline(res.data, '+CGREG').forEach(function (row) {
						var p = row.split(',');
						if (p.length >= 2) stat = p[1].trim();
					});
					state.networkStatus = AtWs.psRegText(stat);
				}
				return AtWs.client.sendCommand('AT^EONS=2');
			}).then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^EONS');
					var code = str ? (str.split(',')[1] || '').trim().replace(/"/g, '') : '';
					state.operator = AtWs.operatorFromCode(code);
				}
				return updateNetworkInfo();
			}).then(function () {
				return AtWs.client.sendCommand('AT^DSFLOWQRY');
			}).then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^DSFLOWQRY');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.flow = {
								lastDsTime: AtWs.parseHexValue(d[0]),
								lastTxFlow: AtWs.parseHexValue(d[1]),
								lastRxFlow: AtWs.parseHexValue(d[2]),
								totalDsTime: AtWs.parseHexValue(d[3]),
								totalTxFlow: AtWs.parseHexValue(d[4]),
								totalRxFlow: AtWs.parseHexValue(d[5])
							};
						}
					}
				}
				return AtWs.client.sendCommand('AT^CHIPTEMP?');
			}).then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseCHIPTEMP(res.data);
					if (parsed) state.temps = parsed;
				}
				renderAll();
			});
		}

		function updateNetworkInfo() {
			return AtWs.client.sendCommand('AT^MONSC').then(function (monsc) {
				var serving = monsc.success && monsc.data ? AtWs.parseMONSC(monsc.data) : null;
				if (serving) {
					state.cell.mcc = serving.mcc;
					state.cell.mnc = serving.mnc;
					state.cell.lac = serving.lac;
					state.cell.cid = serving.cid;
					state.cell.channel = serving.channel;
					state.cell.pci = serving.pci;
					state.cell.rsrp = serving.rsrp != null ? serving.rsrp : state.cell.rsrp;
					state.cell.rsrq = serving.rsrq != null ? serving.rsrq : state.cell.rsrq;
					state.cell.sinr = serving.sinr != null ? serving.sinr : state.cell.sinr;
					state.cell.sysMode = serving.sysMode || state.cell.sysMode;
					state.cell.signalPercent = serving.signalPercent || '';
				}
				return AtWs.client.sendCommand('AT^HFREQINFO?');
			}).then(function (hfreq) {
				state.carriers = hfreq.success && hfreq.data ? AtWs.parseHFREQINFO(hfreq.data) : [];
			});
		}

		function renderAll() {
			renderStatus();
			renderSignal();
			renderCarriers();
			renderSpeed();
			renderFlow();
			renderTemp();
			renderInfo();
			renderDiag();
		}

		// 实时速率采样
		var rateSample = null;
		function sampleRate() {
			return AtWs.netRate('').then(function (r) {
				if (!r.success) {
					rateSample = null;
					state.rtDown = 0;
					state.rtUp = 0;
					renderSpeed();
					return;
				}
				var now = Date.now();
				if (rateSample && rateSample.device === r.device) {
					var dt = (now - rateSample.t) / 1000;
					if (dt >= 0.2) {
						var drx = r.rx_bytes - rateSample.rx;
						var dtx = r.tx_bytes - rateSample.tx;
						state.rtDown = drx >= 0 ? drx / dt : 0;
						state.rtUp = dtx >= 0 ? dtx / dt : 0;
						history.push({ down: state.rtDown, up: state.rtUp });
						if (history.length > HISTORY_POINTS) history = history.slice(history.length - HISTORY_POINTS);
						rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
						renderSpeed();
					}
				} else {
					rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
				}
			});
		}

		var rateTimer = Mt5700.interval(1000, sampleRate);
		sampleRate();

		// 自动刷新
		var timer = Mt5700.interval(5000, refreshAll);
		var ar = Mt5700.autoRefresh(function (enabled, interval) {
			if (timer) clearInterval(timer);
			if (enabled) timer = Mt5700.interval(interval * 1000, refreshAll);
		});

		var actions = Mt5700.panelActions(ar.el, Mt5700.primaryButton('刷新', function () { refreshAll(); }));
		body.appendChild(actions);

		// 初始化
		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Mt5700.confirm('需要连接密钥', function () {
					AtWs.client.connect().catch(function (e) { Mt5700.error((e && e.message) || '认证失败'); });
				});
			}
		}).then(function () {
			refreshAll();
		});

		this._dispose = function () {
			Mt5700.clearAll();
		};

		return page;
	}
});
