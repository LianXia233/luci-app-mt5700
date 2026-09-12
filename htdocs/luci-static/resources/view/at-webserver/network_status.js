'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 网络状态 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/Info.tsx：网络注册状态、运营商、信号、载波聚合、
 * 辅载波信号、速率曲线、实时速率、流量统计、温度、DHCP、QCI/APN、IPv6 能力、
 * 调制方式（MCS）、连接诊断（ENDC / 5GC / 发射功率 / PDP 地址）。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络状态', '实时网络信息与信号质量');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 面板骨架 ---------- */

		var connCard = Mt5700.card('连接状态', '当前网络注册与运营商信息');
		var connBody = E('div');
		connCard._body.appendChild(connBody);
		body.appendChild(connCard);

		var signalCard = Mt5700.card('信号质量', '主小区 RSRP/RSRQ/SINR');
		var sigGrid = E('div', { 'class': 'mt5700-metrics' });
		signalCard._body.appendChild(sigGrid);
		body.appendChild(signalCard);

		var carrierCard = Mt5700.card('载波聚合', '当前所有激活载波');
		var carrierBox = E('div');
		carrierCard._body.appendChild(carrierBox);
		body.appendChild(carrierCard);

		var secondaryCard = Mt5700.card('辅载波信号', '^MONSSC（NSA 辅站）与 ^CASCELLINFO（LTE CA）按下行频点对上 ^HFREQINFO 载波');
		var secondaryBox = E('div');
		secondaryCard._body.appendChild(secondaryBox);
		body.appendChild(secondaryCard);

		var diagCard = Mt5700.card('连接诊断', 'ENDC 双连接、5G 核心网注册、发射功率与 PDP 地址');
		var diagBox = E('div');
		diagCard._body.appendChild(diagBox);
		body.appendChild(diagCard);

		var speedCard = Mt5700.card('实时速率', '接口实时上下行速率，每秒采样一次');
		var speedRow = E('div', { 'class': 'mt5700-speed-row' });
		speedCard._body.appendChild(speedRow);
		body.appendChild(speedCard);

		var historyCard = Mt5700.card('速率曲线', '最近 60 个采样点');
		var chart = E('div', { 'class': 'mt5700-chart' });
		historyCard._body.appendChild(chart);
		body.appendChild(historyCard);

		var flowCard = Mt5700.card('流量统计', '上行/下行累计流量与时长');
		var flowGrid = E('div', { 'class': 'mt5700-metrics' });
		flowCard._body.appendChild(flowGrid);
		body.appendChild(flowCard);

		var tempCard = Mt5700.card('模组温度', '各芯片温度，单位 ℃');
		var tempGrid = E('div', { 'class': 'mt5700-metrics' });
		tempCard._body.appendChild(tempGrid);
		body.appendChild(tempCard);

		var dhcpCard = Mt5700.card('IP 与 DNS', 'DHCP 分配与 IPv6 能力');
		var dhcpBox = E('div');
		dhcpCard._body.appendChild(dhcpBox);
		body.appendChild(dhcpCard);

		var mcsCard = Mt5700.card('调制方式', '上下行 MCS 与层数');
		var mcsGrid = E('div', { 'class': 'mt5700-metrics' });
		mcsCard._body.appendChild(mcsGrid);
		body.appendChild(mcsCard);

		/* ---------- 状态 ---------- */

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
			networkStatus: '等待状态中',
			operator: '未知运营商',
			apn: '未知',
			qci: '未知',
			/*
			 * 两个面板的数据源与单位都不同，必须各自独立存放，不可共用：
			 *   - ambrDown / ambrUp：签约速率，AT^DSAMBR，单位 kbps（本身即比特）
			 *   - rtDown  / rtUp  ：实时速率，OpenWrt 接口统计采样差分，单位字节/秒
			 * 共用同一组变量会导致两面板互相覆盖、数值与语义双双错乱。
			 */
			ambrDown: 0, ambrUp: 0,
			rtDown: 0, rtUp: 0
		};

		var history = [];
		var HISTORY_POINTS = 60;

		/* ---------- 渲染 ---------- */

		function dash(v, unit) { return v == null ? '—' : v + unit; }

		function renderConn() {
			connBody.innerHTML = '';
			var c = state.cell;
			var ambrD = splitSpeedUI(state.ambrDown, 'kbps');
			var ambrU = splitSpeedUI(state.ambrUp, 'kbps');
			var grid = E('div', { 'class': 'mt5700-metrics' });
			[
				{ label: '网络状态', value: state.networkStatus, color: 'info' },
				{ label: '运营商', value: state.operator },
				{ label: '网络模式', value: c.sysMode || '未知' },
				{ label: '信号强度', value: c.signalPercent || '—' },
				{ label: 'APN', value: state.apn },
				{ label: 'QCI', value: state.qci },
				/* 连接状态面板展示的是签约速率（AT^DSAMBR），不是瞬时速率 */
				{ label: '下行速率（签约）', value: ambrD.value + ' ' + ambrD.unit },
				{ label: '上行速率（签约）', value: ambrU.value + ' ' + ambrU.unit }
			].forEach(function (it) {
				grid.appendChild(Mt5700.metric(it.label, it.value, it.color));
			});
			connBody.appendChild(grid);

			connBody.appendChild(Mt5700.table(
				['PLMN', 'LAC / 小区', 'PCI / 频点'],
				[[(c.mcc || '—') + ' / ' + (c.mnc || '—'), (c.lac || '—') + ' / ' + (c.cid || '—'), (c.pci || '—') + ' / ' + (c.channel || '—')]]
			));
		}

		function renderSignal() {
			sigGrid.innerHTML = '';
			var c = state.cell;
			var items = [
				{ label: 'RSRP', value: c.rsrp != null ? c.rsrp + ' dBm' : '—', color: c.rsrp != null ? (c.rsrp >= -90 ? 'success' : c.rsrp >= -105 ? 'warning' : 'danger') : null },
				{ label: 'RSRQ', value: c.rsrq != null ? c.rsrq + ' dB' : '—' },
				{ label: 'SINR', value: c.sinr != null ? c.sinr + ' dB' : '—' },
				{ label: '信号百分比', value: c.signalPercent || '—' }
			];
			items.forEach(function (it) {
				sigGrid.appendChild(Mt5700.metric(it.label, it.value, it.color));
			});
		}

		function renderCarriers() {
			carrierBox.innerHTML = '';
			var rows = (state.carriers || []).map(function (c) {
				var kind = c.kind || c.sysMode || '—';
				return [
					kind,
					c.band != null ? AtWs.bandName(kind, c.band) : '—',
					c.channel || '—',
					c.bandwidth || '—',
					c.pci != null ? String(c.pci) : '—',
					c.rsrp != null ? c.rsrp + ' dBm' : '—',
					c.rsrq != null ? c.rsrq + ' dB' : '—',
					c.sinr != null ? c.sinr + ' dB' : '—'
				];
			});
			carrierBox.appendChild(Mt5700.table(
				['制式', '频段', '频点', '带宽', 'PCI', 'RSRP', 'RSRQ', 'SINR'],
				rows,
				{ striped: true }
			));
			renderSecondary();
		}

		/* ---------- 辅载波信号 ---------- */

		function renderSecondary() {
			secondaryBox.innerHTML = '';
			var nr = state.secondaryNR || [];
			var lte = state.secondaryLTE || [];
			if (!nr.length && !lte.length) {
				secondaryBox.appendChild(E('div', { 'class': 'mt5700-hint' },
					'未查询到辅载波（非 NSA / 未配置 CA 时 ^MONSSC 与 ^CASCELLINFO 正常失败，属预期情况）'));
				return;
			}
			// 按下行频点把信号质量对到 ^HFREQINFO 载波上
			var merged = [];
			state.carriers.forEach(function (c, i) {
				var sig = Parse.carrierSignalFor({ sysMode: c.sysMode === 'NR' ? 'NR' : 'LTE', dlFcn: String(c.channel) }, nr, lte);
				merged.push({
					title: i === 0 ? '主载波' : '辅载波 ' + i,
					kind: c.kind || c.sysMode, band: c.band, channel: c.channel, bandwidth: c.bandwidth,
					sig: sig
				});
			});
			var orphan = Parse.unmatchedSecondaries(
				state.carriers.map(function (c) { return { sysMode: c.sysMode === 'NR' ? 'NR' : 'LTE', dlFcn: String(c.channel) }; }),
				nr, lte
			);
			var rows = merged.map(function (m) {
				if (!m.sig) return [m.title, m.kind || '—', '—', m.channel || '—', m.bandwidth || '—', '—', '—', '—', '—', '—'];
				return [
					m.title,
					m.kind || '—',
					m.band != null ? AtWs.bandName(m.kind, m.band) : '—',
					m.channel || '—',
					m.bandwidth || '—',
					String(m.sig.pci),
					dash(m.sig.rsrp, ' dBm'),
					dash(m.sig.rsrq, ' dB'),
					m.sig.sinr != null ? dash(m.sig.sinr, ' dB') : dash(m.sig.rssi != null ? m.sig.rssi : null, ' dBm'),
					m.sig.measType || '—'
				];
			});
			secondaryBox.appendChild(Mt5700.table(
				['载波', '制式', '频段', '下行频点', '带宽', 'PCI', 'RSRP', 'RSRQ', 'SINR/RSSI', '测量'],
				rows,
				{ striped: true }
			));
			// 没能对上任何载波的辅小区单独列出，不丢数据
			if (orphan.nr.length || orphan.lte.length) {
				secondaryBox.appendChild(E('div', { 'class': 'mt5700-hint' },
					'以下小区来自 ^MONSSC / ^CASCELLINFO 上报，但频点没和 ^HFREQINFO 载波对上（两条命令上报时机可能不同步），单独列出以免数据丢失：'));
				var ul = E('ul', { 'class': 'mt5700-agree-list' });
				orphan.nr.forEach(function (c) {
					ul.appendChild(E('li', {}, 'NR 频点 ' + c.arfcn + ' · PCI ' + c.pci + '：' +
						dash(c.rsrp, ' dBm') + ' / ' + dash(c.rsrq, ' dB') + ' / ' + dash(c.sinr, ' dB')));
				});
				orphan.lte.forEach(function (c) {
					ul.appendChild(E('li', {}, 'LTE B' + c.band + ' · PCI ' + c.pci + '：' +
						dash(c.rsrp, ' dBm') + ' / ' + dash(c.rsrq, ' dB') + ' / ' + dash(c.rssi, ' dBm')));
				});
				secondaryBox.appendChild(ul);
			}
		}

		/* ---------- 连接诊断 ---------- */

		function renderDiag() {
			diagBox.innerHTML = '';
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
			var txVal = d.tx ? (dash(d.tx.pusch, ' dBm') + ' / ' + dash(d.tx.pucch, ' dBm')) : '—';
			var txVal2 = d.tx ? (dash(d.tx.srs, ' dBm') + ' / ' + dash(d.tx.prach, ' dBm')) : '—';
			var rows = [
				['ENDC 双连接', endcTag],
				['5G 核心网注册', regVal],
				['TAC / 小区', d.reg && d.reg.tac ? (d.reg.tac + ' / ' + (d.reg.ci || '—')) : '—'],
				['网络切片', d.reg && d.reg.nssai ? d.reg.nssai : '—'],
				['LTE PUSCH / PUCCH', txVal],
				['LTE SRS / PRACH', txVal2]
			];
			if (d.tx && d.tx.total != null) rows.push(['2G/3G 总功率', dash(d.tx.total, ' dBm')]);
			(d.nrTx || []).forEach(function (c, i) {
				rows.push(['NR CC' + (i + 1) + ' PUSCH', dash(c.pusch, ' dBm') + (c.freq ? ' · ' + (c.freq / 1000).toFixed(1) + ' MHz' : '')]);
			});
			diagBox.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
			if (d.addrs && d.addrs.length) {
				diagBox.appendChild(E('div', { 'class': 'mt5700-hint' }, 'PDP 地址：'));
				var ul = E('ul', { 'class': 'mt5700-agree-list' });
				d.addrs.forEach(function (a) {
					ul.appendChild(E('li', {}, 'CID ' + a.cid + ' · ' + a.family + '：' + a.address));
				});
				diagBox.appendChild(ul);
			} else {
				diagBox.appendChild(E('div', { 'class': 'mt5700-hint' }, '没有已激活的 PDP 上下文地址。'));
			}
		}

		/*
		 * 两个面板的渲染互相独立，各自只认自己的数据源：
		 *   - renderConn()  连「连接状态」面板，取签约速率（kbps）
		 *   - renderSpeed() 连「实时速率」面板，取接口实时速率（字节/秒）
		 * 早期版本两者共用一组变量，导致签约速率会盖掉实时速率、反之亦然。
		 */
		function renderSpeed() {
			speedRow.innerHTML = '';
			var d = splitSpeedUI(state.rtDown, 'bytes');
			var u = splitSpeedUI(state.rtUp, 'bytes');
			speedRow.appendChild(Mt5700.speedBox('↓ 下行', d.value + ' ' + d.unit));
			speedRow.appendChild(Mt5700.speedBox('↑ 上行', u.value + ' ' + u.unit));
			renderChart();
		}

		/*
		 * 把速率值格式化为 {value, unit}。
		 * unitMode：
		 *   'kbps'  —— 输入单位是 kbps（比特），直接乘 1000 得 bps（签约速率）；
		 *   'bytes' —— 输入单位是字节/秒，乘 8 得 bps（接口实时速率）。
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
				chart.appendChild(Mt5700.empty('等待数据…'));
				return;
			}
			chart.appendChild(Mt5700.lineChart(history, { width: chart.clientWidth || 600, height: 140 }));
		}

		function renderFlow() {
			flowGrid.innerHTML = '';
			var f = state.flow;
			[
				{ label: '当前会话时长', value: AtWs.formatDuration(f.lastDsTime, false) },
				{ label: '当前下行流量', value: AtWs.formatFlow(f.lastRxFlow) },
				{ label: '当前上行流量', value: AtWs.formatFlow(f.lastTxFlow) },
				{ label: '累计时长', value: AtWs.formatDuration(f.totalDsTime, true) },
				{ label: '累计下行', value: AtWs.formatFlow(f.totalRxFlow) },
				{ label: '累计上行', value: AtWs.formatFlow(f.totalTxFlow) }
			].forEach(function (it) {
				flowGrid.appendChild(Mt5700.metric(it.label, it.value));
			});
		}

		function renderTemp() {
			tempGrid.innerHTML = '';
			var t = state.temps;
			[
				{ label: 'Sub3G PA', value: t.sub3GPA }, { label: 'Sub6G PA', value: t.sub6GPA },
				{ label: 'MIMO PA', value: t.mimoPa }, { label: 'TCXO', value: t.tcxo },
				{ label: 'AP1', value: t.ap1 }, { label: 'AP2', value: t.ap2 }, { label: 'Modem1', value: t.modem1 }
			].forEach(function (it) {
				tempGrid.appendChild(Mt5700.metric(it.label, it.value ? it.value + ' ℃' : '—'));
			});
		}

		function renderDHCP() {
			dhcpBox.innerHTML = '';
			var rows = [];
			var v4 = state.dhcpv4, v6 = state.dhcpv6;
			if (v4) {
				rows.push(['IPv4 地址', v4.ipv4Address]);
				rows.push(['子网掩码', v4.subnetMask]);
				rows.push(['网关', v4.gateway]);
				rows.push(['DHCP 服务器', v4.dhcpServer]);
				rows.push(['主 DNS', v4.primaryDNS]);
				rows.push(['备 DNS', v4.secondaryDNS]);
			}
			if (v6) {
				rows.push(['IPv6 地址', v6.ipv6Address]);
				rows.push(['IPv6 前缀', v6.netmask]);
				rows.push(['IPv6 网关', v6.gateway]);
				rows.push(['IPv6 DNS', v6.primaryDNS + ' / ' + v6.secondaryDNS]);
			}
			if (state.ipv6Cap) rows.push(['IPv6 能力', state.ipv6Cap.description]);
			if (!rows.length) rows.push(['信息', '暂无数据']);
			dhcpBox.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
		}

		function renderMCS() {
			mcsGrid.innerHTML = '';
			var dl = state.downlinkMCS, ul = state.uplinkMCS;
			[
				{ label: '下行 MCS', value: dl ? (dl.mcs != null ? 'MCS ' + dl.mcs + (dl.rank ? ' · ' + dl.rank + ' 层' : '') : '—') : '—' },
				{ label: '上行 MCS', value: ul ? (ul.mcs != null ? 'MCS ' + ul.mcs + (ul.rank ? ' · ' + ul.rank + ' 层' : '') : '—') : '—' }
			].forEach(function (it) {
				mcsGrid.appendChild(Mt5700.metric(it.label, it.value));
			});
		}

		/* ---------- 数据获取 ---------- */

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
					state.networkStatus = AtWs.psRegText(stat);
				}
			});
		}

		function getOperator() {
			return AtWs.client.sendCommand('AT^EONS=2').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^EONS');
					var code = str ? (str.split(',')[1] || '').trim().replace(/"/g, '') : '';
					state.operator = AtWs.operatorFromCode(code);
				}
			});
		}

		function getAMBR() {
			return resolveActiveCid().then(function (cid) {
				var candidates = [];
				if (cid && cid > 0) candidates.push(cid);
				candidates.push(1);
				var unique = candidates.filter(function (v, i, a) { return a.indexOf(v) === i; });
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
								state.ambrDown = parseInt(parts[1], 10) || 0;
								state.ambrUp = parseInt(parts[2], 10) || 0;
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
									state.apn = apnRaw.replace(/^["']|["']$/g, '') || '未知';
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
				}).then(renderConn);
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
					if (row) state.qci = AtWs.qciLabel(row.split(',')[1] ? row.split(',')[1].trim() : '');
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
					renderConn();
				});
			});
		}

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
			// 这几条都可能因为「当前不是那个组网」而失败，属于正常情况，静默处理
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

		/* ---------- 实时速率（OpenWrt 接口统计采样） ---------- */

		/*
		 * 实时速率取自承载 5G 流量的网络接口累计字节数，按「两次采样差 ÷ 时间差」计算。
		 *
		 * 为什么不再用 PDCP：
		 *   PDCP 方案需要后端持续向模组下发 AT 命令订阅上报，既独占 AT 通道，
		 *   又会在用户手动发 AT 命令时产生干扰，直接影响模组工作。
		 *   接口统计是内核维护的计数器，读它不产生任何 AT 流量。
		 *
		 * 采样时序：用本机 Date.now() 做时间基准（与 RPC 往返无关），
		 * 避免 rpcd 与浏览器时钟不同源引入抖动。
		 */
		var rateSample = null;
		var rateTimer = null;

		function sampleRate() {
			return AtWs.netRate('').then(function (r) {
				if (!r.success) {
					/* 失败时清空基准，下次采样重新起算，避免用过期基准算出离谱速率 */
					rateSample = null;
					state.rtDown = 0;
					state.rtUp = 0;
					renderSpeed();
					return;
				}
				var now = Date.now();
				if (rateSample && rateSample.device === r.device) {
					var dt = (now - rateSample.t) / 1000;
					/* 间隔过短（<0.2s）时差分噪声大，跳过本次并保留原基准 */
					if (dt >= 0.2) {
						var drx = r.rx_bytes - rateSample.rx;
						var dtx = r.tx_bytes - rateSample.tx;
						/*
						 * 计数器回绕或接口重置会产生负差，此时不能输出负值，
						 * 直接以 0 处理并重置基准，下一拍即可恢复。
						 */
						state.rtDown = drx >= 0 ? drx / dt : 0;
						state.rtUp = dtx >= 0 ? dtx / dt : 0;
						history.push({ down: state.rtDown, up: state.rtUp });
						if (history.length > HISTORY_POINTS) history = history.slice(history.length - HISTORY_POINTS);
						rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
						renderSpeed();
						return;
					}
					return;
				}
				/* 首拍或设备变更：只记基准，不产生速率 */
				rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
			});
		}

		rateTimer = setInterval(sampleRate, 1000);
		sampleRate();

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
			}).then(function () { refreshing = false; });
		}

		/* ---------- 自动刷新 ---------- */

		var timer = null;
		var ar = Ui.autoRefresh(function (enabled, interval) {
			if (timer) { clearInterval(timer); timer = null; }
			if (enabled) timer = setInterval(refreshAll, interval * 1000);
		});
		timer = setInterval(refreshAll, 5000);

		var extra = Mt5700.panelActions(
			ar.el,
			Mt5700.primaryButton('刷新', function () { refreshAll(); })
		);
		body.appendChild(extra);

		/* ---------- 初始化 ---------- */

		renderConn();
		renderSignal();
		renderCarriers();
		renderDiag();
		renderSpeed();
		renderFlow();
		renderTemp();
		renderDHCP();
		renderMCS();

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [
					{ key: 'key', label: '连接密钥', type: 'password', hint: '该密钥保存在 UCI at-webserver.websocket.auth_key' }
				], function (values) {
					if (!values.key) return;
					AtWs.client.connect(values.key).catch(function (e) { Mt5700.error((e && e.message) || '认证失败'); });
				});
				return;
			}
			if (err) console.warn('连接失败', err);
		}).then(function () {
			refreshAll();
		});

		self._dispose = function () {
			if (timer) clearInterval(timer);
			if (rateTimer) clearInterval(rateTimer);
		};

		return page;
	}
});
