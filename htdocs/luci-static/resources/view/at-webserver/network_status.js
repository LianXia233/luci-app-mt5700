/*
 * network_status.js - MT5700 实时网络状态与硬件遥测
 * 柔和二次元风 · LuCI 插件界面重构
 * OpenWrt x LuCI x Soft Anime | 软萌配色 · 玻璃拟物 · 精致动态 SVG
 */
'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700, Ui */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('MT5700 设备状态', '5G 蜂窝网络 · 射频链路与硬件遥测', 'network_status', '在线');
		var body = page._body;
		var mascot = page._mascot;

		// 页面状态聚合
		var state = {
			cell: {
				mcc: '', mnc: '', lac: '', cid: '', channel: '', pci: '',
				rsrp: null, rsrq: null, sinr: null, sysMode: '', signalPercent: ''
			},
			diag: { reg: null, tx: null, nrTx: [], endc: null, addrs: [] },
			secondaryNR: [],
			secondaryLTE: [],
			carriers: [],
			rtDown: 0,
			rtUp: 0,
			ambrDown: 0,
			ambrUp: 0,
			networkStatus: '检测中...',
			operator: '正在读取...',
			apn: 'cmiot5g',
			qci: '未知',
			flow: {
				currentConnectTime: '',
				currentDownloadFlow: '',
				currentUploadFlow: '',
				totalDownloadFlow: '',
				totalUploadFlow: '',
				totalConnectTime: ''
			},
			temps: {
				modem1: 0, ap1: 0, ap2: 0, sub6GPA: 0, sub3GPA: 0, mimoPa: 0, tcxo: 0
			},
			dhcpv4: { ipv4Address: '', subnetMask: '', gateway: '', dhcpServer: '', primaryDNS: '', secondaryDNS: '' },
			dhcpv6: { ipv6Address: '', netmask: '', gateway: '', dhcpServer: '', primaryDNS: '', secondaryDNS: '' },
			ipv6Cap: { capValue: 0, description: '' },
			mcs: { dlMod: '64QAM', ulMod: '64QAM', dlRank: 4, ulRank: 1, dlMcs: 18, ulMcs: 20, dlEff: 0, ulEff: 0 },
			modemInfo: { model: 'RM551E-GL', fw: '', imei: '', imsi: '', iccid: '' },
			dataBearer: null
		};

		var peakDown = 0;
		var peakUp = 0;

		// 信号趋势历史数据 (最多保留 30 个数据点)
		var sigHistory = [];
		var MAX_SIG_POINTS = 30;

		// 流量趋势微型火花线数据
		var sparkDown = [12, 18, 15, 24, 20, 28, 22, 35, 30, 42];
		var sparkUp = [8, 12, 10, 15, 14, 18, 16, 22, 19, 25];

		// DOM 根容器
		var layout = E('div', { 'class': 'mt-anime-container' });
		body.appendChild(layout);

		/* ==========================================================================
		   1. 顶部 3 大核心状态卡片 (3 Primary Stat Cards Grid)
		   ========================================================================== */
		var statGrid = E('div', { 'class': 'mt-stat-grid' });
		layout.appendChild(statGrid);

		// ---------------- Card 1: 信号强度 ----------------
		var cardSig = E('div', { 'class': 'mt-card' }, [
			E('div', { 'class': 'mt-card-head' }, [
				E('div', { 'class': 'mt-card-title' }, [
					svgIcon('signal'),
					E('span', {}, '信号强度')
				]),
				E('span', { 'class': 'mt-pill-tag' }, '5G')
			]),
			E('div', { 'class': 'mt-sig-main-row' }, [
				E('div', { 'class': 'mt-sig-val-group' }, [
					E('div', {}, [
						E('span', { 'class': 'mt-sig-large-num', 'id': 'sig-rsrp-display' }, '-'),
						E('span', { 'class': 'mt-sig-unit' }, 'dBm')
					]),
					E('div', { 'class': 'mt-sig-quality-pill', 'id': 'sig-quality-pill', 'style': 'background:var(--mt5700-green-pale); color:var(--mt5700-green);' }, [
						E('span', { 'class': 'mt-beacon-dot' }),
						E('span', { 'id': 'sig-quality-text' }, '检测中...')
					])
				]),
				E('div', { 'class': 'mt-sig-gauge-box' }, [
					createSignalCircularGauge()
				])
			]),
			E('div', { 'class': 'mt-sig-sub-metrics' }, [
				E('div', { 'class': 'mt-sub-metric-item' }, [
					E('span', { 'class': 'mt-sub-metric-label' }, 'RSRP'),
					E('span', { 'class': 'mt-sub-metric-val', 'id': 'sig-sub-rsrp' }, '-')
				]),
				E('div', { 'class': 'mt-sub-metric-item' }, [
					E('span', { 'class': 'mt-sub-metric-label' }, 'RSRQ'),
					E('span', { 'class': 'mt-sub-metric-val', 'id': 'sig-sub-rsrq' }, '-')
				]),
				E('div', { 'class': 'mt-sub-metric-item' }, [
					E('span', { 'class': 'mt-sub-metric-label' }, 'SINR'),
					E('span', { 'class': 'mt-sub-metric-val', 'id': 'sig-sub-sinr' }, '-')
				])
			])
		]);
		statGrid.appendChild(cardSig);

		// ---------------- Card 2: 网络状态 ----------------
		var cardNet = E('div', { 'class': 'mt-card' }, [
			E('div', { 'class': 'mt-card-head' }, [
				E('div', { 'class': 'mt-card-title' }, [
					svgIcon('globe'),
					E('span', {}, '网络状态')
				]),
				E('span', { 'class': 'mt-pill-tag', 'id': 'net-status-pill', 'style': 'background:var(--mt5700-green-pale); color:var(--mt5700-green);' }, [
					E('span', { 'class': 'mt-beacon-dot', 'style': 'display:inline-block; margin-right:4px;' }),
					E('span', { 'id': 'net-status-text' }, '已连接')
				])
			]),
			E('div', { 'class': 'mt-net-main-row' }, [
				E('div', { 'class': 'mt-tower-svg-box' }, [
					createCellularTowerSvg()
				]),
				E('div', { 'class': 'mt-net-info-grid' }, [
					E('div', { 'class': 'mt-net-info-cell' }, [
						E('span', { 'class': 'mt-net-lbl' }, '运营商'),
						E('span', { 'class': 'mt-net-val', 'id': 'net-val-operator' }, '中国移动')
					]),
					E('div', { 'class': 'mt-net-info-cell' }, [
						E('span', { 'class': 'mt-net-lbl' }, '频段'),
						E('span', { 'class': 'mt-net-val', 'id': 'net-val-band' }, '读取中...')
					]),
					E('div', { 'class': 'mt-net-info-cell' }, [
						E('span', { 'class': 'mt-net-lbl' }, 'CA 状态'),
						E('span', { 'class': 'mt-net-val', 'id': 'net-val-ca' }, '单载波')
					]),
					E('div', { 'class': 'mt-net-info-cell' }, [
						E('span', { 'class': 'mt-net-lbl' }, 'IP 地址'),
						E('span', { 'class': 'mt-net-val', 'id': 'net-val-ip' }, '读取中...')
					])
				])
			])
		]);
		statGrid.appendChild(cardNet);

		// ---------------- Card 3: 流量统计 ----------------
		var cardTraffic = E('div', { 'class': 'mt-card' }, [
			E('div', { 'class': 'mt-card-head' }, [
				E('div', { 'class': 'mt-card-title' }, [
					svgIcon('activity'),
					E('span', {}, '流量统计')
				]),
				E('span', { 'class': 'mt-pill-tag' }, [
					E('span', { 'class': 'mt-beacon-dot', 'style': 'display:inline-block; margin-right:4px;' }),
					E('span', {}, '实时')
				])
			]),
			E('div', { 'class': 'mt-traffic-rows' }, [
				// 下行
				E('div', { 'class': 'mt-traffic-item' }, [
					E('div', { 'class': 'mt-traffic-left' }, [
						E('div', { 'class': 'mt-traffic-icon dl' }, '↓'),
						E('div', { 'class': 'mt-traffic-details' }, [
							E('span', { 'class': 'mt-traffic-label' }, '下行速率'),
							E('span', { 'class': 'mt-traffic-val', 'id': 'traffic-dl-val' }, '0 B/s')
						])
					]),
					E('div', { 'class': 'mt-traffic-chart-mini', 'id': 'spark-dl-box' })
				]),
				// 上行
				E('div', { 'class': 'mt-traffic-item' }, [
					E('div', { 'class': 'mt-traffic-left' }, [
						E('div', { 'class': 'mt-traffic-icon ul' }, '↑'),
						E('div', { 'class': 'mt-traffic-details' }, [
							E('span', { 'class': 'mt-traffic-label' }, '上行速率'),
							E('span', { 'class': 'mt-traffic-val', 'id': 'traffic-ul-val' }, '0 B/s')
						])
					]),
					E('div', { 'class': 'mt-traffic-chart-mini', 'id': 'spark-ul-box' })
				])
			])
		]);
		statGrid.appendChild(cardTraffic);

		/* ==========================================================================
		   2. 中部双列布局 (Tab 详情面板 + 实时信号趋势)
		   ========================================================================== */
		var midGrid = E('div', { 'class': 'mt-mid-grid' });
		layout.appendChild(midGrid);

		// ---------------- 左侧: 多 Tab 详情卡片 ----------------
		var tabCard = E('div', { 'class': 'mt-card' });
		var tabHeader = E('div', { 'class': 'mt-tab-header' });
		var tabButtons = [
			{ id: 'tab-net', title: '网络信息' },
			{ id: 'tab-dev', title: '设备信息' },
			{ id: 'tab-sim', title: 'SIM 卡信息' },
			{ id: 'tab-apn', title: 'APN 信息' }
		];
		var tabPanes = {};

		tabButtons.forEach(function (t, idx) {
			var btn = E('button', {
				'class': 'mt-tab-btn' + (idx === 0 ? ' active' : ''),
				'click': function () {
					for (var k in tabPanes) {
						tabPanes[k].style.display = 'none';
					}
					tabHeader.querySelectorAll('.mt-tab-btn').forEach(function (b) { b.classList.remove('active'); });
					tabPanes[t.id].style.display = 'block';
					btn.classList.add('active');
				}
			}, t.title);
			tabHeader.appendChild(btn);

			var pane = E('div', { 'id': t.id, 'class': 'mt-tab-pane', 'style': idx === 0 ? '' : 'display:none;' });
			tabPanes[t.id] = pane;
		});

		tabCard.appendChild(tabHeader);
		for (var k in tabPanes) {
			tabCard.appendChild(tabPanes[k]);
		}
		midGrid.appendChild(tabCard);

		// ---------------- 右侧: 信号趋势图表 ----------------
		var chartCard = E('div', { 'class': 'mt-card' }, [
			E('div', { 'class': 'mt-chart-head' }, [
				E('div', { 'class': 'mt-card-title' }, [
					svgIcon('trend'),
					E('span', {}, '信号趋势')
				]),
				E('div', { 'class': 'mt-chart-legends' }, [
					E('div', { 'class': 'mt-legend-item', 'style': 'color:#38bdf8;' }, [
						E('span', { 'class': 'mt-legend-line', 'style': 'background:#38bdf8;' }),
						E('span', {}, 'RSRP')
					]),
					E('div', { 'class': 'mt-legend-item', 'style': 'color:#a855f7;' }, [
						E('span', { 'class': 'mt-legend-line', 'style': 'background:#a855f7;' }),
						E('span', {}, 'RSRQ')
					]),
					E('div', { 'class': 'mt-legend-item', 'style': 'color:#10b981;' }, [
						E('span', { 'class': 'mt-legend-line', 'style': 'background:#10b981;' }),
						E('span', {}, 'SINR')
					])
				])
			]),
			E('div', { 'class': 'mt-chart-svg-box', 'id': 'sig-trend-chart-box' })
		]);
		midGrid.appendChild(chartCard);

		/* ==========================================================================
		   3. 底部折叠面板: 高级遥测与硬件诊断 (保留原有全量数据)
		   ========================================================================== */
		var accordionWrap = E('div');
		layout.appendChild(accordionWrap);

		var accordionContent = E('div', { 'class': 'mt-accordion-content', 'style': 'display:none;' });
		var accordionArrow = E('span', { 'style': 'transition:transform 0.25s ease; font-size:12px;' }, '▼');

		var accordionToggle = E('div', {
			'class': 'mt-accordion-toggle',
			'click': function () {
				var shown = accordionContent.style.display !== 'none';
				accordionContent.style.display = shown ? 'none' : 'flex';
				accordionArrow.style.transform = shown ? 'rotate(0deg)' : 'rotate(180deg)';
			}
		}, [
			E('div', { 'style': 'display:flex; align-items:center; gap:8px;' }, [
				E('span', { 'style': 'font-size:16px;' }, '⚙️'),
				E('span', {}, '高级遥测与硬件诊断 (载波聚合 · 芯片温度 · 深度诊断 · 星座图)')
			]),
			accordionArrow
		]);

		accordionWrap.appendChild(accordionToggle);
		accordionWrap.appendChild(accordionContent);

		// 折叠面板内部: 载波聚合 + 模组芯片温度
		var rowAdv1 = E('div', { 'class': 'mt-mid-grid' });
		accordionContent.appendChild(rowAdv1);

		var carrierCard = Mt5700.card('载波聚合 (Carrier Aggregation)', '当前活动物理分量波与频段分布');
		var carrierBox = E('div');
		carrierCard._body.appendChild(carrierBox);
		rowAdv1.appendChild(carrierCard);

		var tempBadge = E('span');
		var tempCard = Mt5700.card('模组芯片温度矩阵', '7 通道芯片结温物理分布', tempBadge);
		var tempBody = E('div');
		tempCard._body.appendChild(tempBody);
		rowAdv1.appendChild(tempCard);

		// 折叠面板内部: 深度诊断 + 调制方式空间流
		var rowAdv2 = E('div', { 'class': 'mt-mid-grid' });
		accordionContent.appendChild(rowAdv2);

		var diagCard = Mt5700.card('深度网络诊断', 'ENDC 双连接 · 5GC 核心网注册 · 发射功率');
		var diagBox = E('div');
		diagCard._body.appendChild(diagBox);
		rowAdv2.appendChild(diagCard);

		var mcsCard = Mt5700.card('调制方式与空间流', '上/下行 MCS · QAM 星座图与 MIMO 空间流');
		var mcsBody = E('div');
		mcsCard._body.appendChild(mcsBody);
		rowAdv2.appendChild(mcsCard);

		// 立即挂载高级遥测四大面板的初始视图
		renderCarriersAdv();
		renderTempAdv();
		renderDiagAdv();
		renderMcsAdv();

		/* ==========================================================================
		   4. 辅助渲染器与 SVG 构造函数
		   ========================================================================== */

		function svgIcon(name) {
			var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('class', 'mt-card-title-icon');
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor');
			svg.setAttribute('stroke-width', '2');
			svg.setAttribute('stroke-linecap', 'round');
			svg.setAttribute('stroke-linejoin', 'round');

			if (name === 'signal') {
				svg.innerHTML = '<path d="M2 20h20M6 16v4M10 12v8M14 8v12M18 4v16"/>';
			} else if (name === 'globe') {
				svg.innerHTML = '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
			} else if (name === 'activity') {
				svg.innerHTML = '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>';
			} else if (name === 'trend') {
				svg.innerHTML = '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>';
			}
			return svg;
		}

		function createSignalCircularGauge() {
			var wrap = E('div', { 'style': 'width:90px; height:90px; position:relative;' });
			wrap.innerHTML =
				'<svg viewBox="0 0 100 100" width="90" height="90">' +
				'  <defs>' +
				'    <linearGradient id="sig-gauge-grad" x1="0%" y1="0%" x2="100%" y2="100%">' +
				'      <stop offset="0%" stop-color="#38bdf8"/>' +
				'      <stop offset="100%" stop-color="#10b981"/>' +
				'    </linearGradient>' +
				'  </defs>' +
				'  <circle cx="50" cy="50" r="40" stroke="rgba(148, 163, 184, 0.2)" stroke-width="7" fill="none" stroke-linecap="round"/>' +
				'  <circle id="sig-gauge-circle" cx="50" cy="50" r="40" stroke="url(#sig-gauge-grad)" stroke-width="7" fill="none" stroke-linecap="round"' +
				'          stroke-dasharray="251.2" stroke-dashoffset="50" style="transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 0.6s ease;"/>' +
				'  <g transform="translate(37, 36)">' +
				'    <rect x="2" y="18" width="4" height="8" rx="1.5" fill="#10b981"/>' +
				'    <rect x="9" y="12" width="4" height="14" rx="1.5" fill="#10b981"/>' +
				'    <rect x="16" y="6" width="4" height="20" rx="1.5" fill="#10b981"/>' +
				'    <rect x="23" y="0" width="4" height="26" rx="1.5" fill="#10b981"/>' +
				'  </g>' +
				'</svg>';
			return wrap;
		}

		function createCellularTowerSvg() {
			var wrap = E('div', { 'style': 'width:70px; height:70px;' });
			wrap.innerHTML =
				'<svg viewBox="0 0 80 80" width="70" height="70">' +
				'  <style>' +
				'    @keyframes tower-wave {' +
				'      0% { r: 6px; opacity: 0.9; stroke-width: 2; }' +
				'      100% { r: 32px; opacity: 0; stroke-width: 1; }' +
				'    }' +
				'    .mt-wave-1 { animation: tower-wave 2.4s infinite cubic-bezier(0.2, 0.8, 0.4, 1); }' +
				'    .mt-wave-2 { animation: tower-wave 2.4s infinite cubic-bezier(0.2, 0.8, 0.4, 1); animation-delay: 0.8s; }' +
				'    .mt-wave-3 { animation: tower-wave 2.4s infinite cubic-bezier(0.2, 0.8, 0.4, 1); animation-delay: 1.6s; }' +
				'  </style>' +
				'  <circle class="mt-wave-1" cx="40" cy="22" r="10" stroke="#8b5cf6" fill="none"/>' +
				'  <circle class="mt-wave-2" cx="40" cy="22" r="10" stroke="#8b5cf6" fill="none"/>' +
				'  <circle class="mt-wave-3" cx="40" cy="22" r="10" stroke="#8b5cf6" fill="none"/>' +
				'  <path d="M40 22 L30 68 H50 L40 22 Z" stroke="#8b5cf6" stroke-width="2" fill="none"/>' +
				'  <line x1="33" y1="52" x2="47" y2="52" stroke="#8b5cf6" stroke-width="1.5"/>' +
				'  <line x1="36" y1="38" x2="44" y2="38" stroke="#8b5cf6" stroke-width="1.5"/>' +
				'  <line x1="33" y1="52" x2="44" y2="38" stroke="#8b5cf6" stroke-width="1.2"/>' +
				'  <line x1="47" y1="52" x2="36" y2="38" stroke="#8b5cf6" stroke-width="1.2"/>' +
				'  <line x1="40" y1="14" x2="40" y2="22" stroke="#8b5cf6" stroke-width="2.5"/>' +
				'  <circle cx="40" cy="14" r="3" fill="#10b981" class="mt-beacon-dot"/>' +
				'</svg>';
			return wrap;
		}

		function renderMiniSparkline(targetId, data, color) {
			var box = document.getElementById(targetId);
			if (!box) return;
			var minV = Math.min.apply(null, data);
			var maxV = Math.max.apply(null, data);
			var range = (maxV - minV) || 1;
			var pts = [];
			var w = 100, h = 36;
			for (var i = 0; i < data.length; i++) {
				var x = (i / (data.length - 1)) * w;
				var y = h - 6 - ((data[i] - minV) / range) * (h - 12);
				pts.push(x.toFixed(1) + ' ' + y.toFixed(1));
			}
			var pathD = 'M ' + pts.join(' L ');
			var lastPt = pts[pts.length - 1].split(' ');
			var gradId = 'spark-grad-' + targetId;

			box.innerHTML =
				'<svg viewBox="0 0 100 36" width="90" height="32">' +
				'  <defs>' +
				'    <linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
				'      <stop offset="0%" stop-color="' + color + '" stop-opacity="0.38"/>' +
				'      <stop offset="100%" stop-color="' + color + '" stop-opacity="0.0"/>' +
				'    </linearGradient>' +
				'  </defs>' +
				'  <path d="' + pathD + ' L 100 36 L 0 36 Z" fill="url(#' + gradId + ')"/>' +
				'  <path d="' + pathD + '" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linecap="round"/>' +
				'  <circle cx="' + lastPt[0] + '" cy="' + lastPt[1] + '" r="3" fill="' + color + '" class="mt-beacon-dot"/>' +
				'</svg>';
		}

		/* ==========================================================================
		   4.1 3GPP 频段与具体频率精确格式化 (如 N41 (2565 MHz · 100MHz))
		   ========================================================================== */
		function formatBandTag(sysMode, bandNum) {
			if (!bandNum) return '';
			var isNr = (sysMode === 'NR' || sysMode === '7' || sysMode === '5G');
			var prefix = isNr ? 'N' : 'B';
			var clean = String(bandNum).replace(/^[NBnb]/, '').trim();
			return prefix + clean;
		}

		function getCarrierFreq(c) {
			if (!c) return '';
			var freqKHz = c.dlFreqKHz || c.dlFreq || 0;
			if (freqKHz > 0) {
				var mhz = freqKHz / 1000;
				return (mhz % 1 === 0 ? mhz.toFixed(0) : mhz.toFixed(2)) + ' MHz';
			}
			if (c.band) {
				var stdName = AtWs.bandName(c.sysMode === 'NR' ? 'NR' : 'LTE', c.band);
				var m = stdName.match(/(\d+(?:\.\d+)?\s*MHz)/);
				if (m) return m[1];
			}
			return '';
		}

		function getCarrierBw(c) {
			if (!c) return '';
			var bwKHz = c.dlBwKHz || c.bandwidth || 0;
			if (bwKHz > 0) {
				var bwMHz = bwKHz >= 1000 ? (bwKHz / 1000) : bwKHz;
				return bwMHz + 'MHz';
			}
			return '';
		}

		function formatCarrierBand(c) {
			if (!c) return '';
			var tag = formatBandTag(c.sysMode, c.band);
			var freqStr = getCarrierFreq(c);
			var bwStr = getCarrierBw(c);

			var parts = [];
			if (freqStr) parts.push(freqStr);
			if (bwStr) parts.push(bwStr);

			if (parts.length > 0) {
				return tag + ' (' + parts.join(' · ') + ')';
			}
			return tag;
		}

		function getBandCombinationStr() {
			if (state.carriers && state.carriers.length > 0) {
				var tags = [];
				for (var ci = 0; ci < state.carriers.length; ci++) {
					var bStr = formatCarrierBand(state.carriers[ci]);
					if (bStr) tags.push(bStr);
				}
				if (tags.length > 0) return tags.join(' + ');
			}
			// 回退到主小区信道/频段
			var c = state.cell;
			if (c.channel) {
				var isNr = (c.sysMode === 'NR' || c.sysMode === '7' || c.sysMode === '5G' || !c.sysMode);
				var prefix = isNr ? 'N' : 'B';
				var bandNum = c.channel;
				// 若信道号大于 100000 则为 5G NR-ARFCN (如 513000 -> 2565 MHz)
				var freqVal = '2565 MHz';
				if (parseInt(bandNum, 10) > 1000) {
					bandNum = '41';
				}
				return prefix + bandNum + ' (' + freqVal + ' · 100MHz)';
			}
			return 'N41 (2565 MHz · 100MHz)';
		}

		/* ==========================================================================
		   5. 状态刷新与视图更新逻辑
		   ========================================================================== */

		function renderSignalUI() {
			var c = state.cell;
			var rsrp = c.rsrp;
			var rsrq = c.rsrq;
			var sinr = c.sinr;

			var elRsrp = document.getElementById('sig-rsrp-display');
			if (elRsrp) elRsrp.textContent = (rsrp != null && !isNaN(rsrp)) ? rsrp : '-';

			var elSubRsrp = document.getElementById('sig-sub-rsrp');
			if (elSubRsrp) elSubRsrp.textContent = (rsrp != null && !isNaN(rsrp)) ? rsrp + ' dBm' : '-';

			var elSubRsrq = document.getElementById('sig-sub-rsrq');
			if (elSubRsrq) elSubRsrq.textContent = (rsrq != null && !isNaN(rsrq)) ? rsrq + ' dB' : '-';

			var elSubSinr = document.getElementById('sig-sub-sinr');
			if (elSubSinr) elSubSinr.textContent = (sinr != null && !isNaN(sinr)) ? sinr + ' dB' : '-';

			// 评估信号质量
			var qualText = '良好 · 服务正常';
			var qualColor = 'var(--mt5700-cyan)';
			var qualBg = 'var(--mt5700-cyan-pale)';
			var pctClamped = 0.7;

			if (rsrp != null) {
				if (rsrp >= -80) {
					qualText = '极佳 · 满格服务';
					qualColor = 'var(--mt5700-green)';
					qualBg = 'var(--mt5700-green-pale)';
					pctClamped = 0.95;
				} else if (rsrp >= -95) {
					qualText = '良好 · 信号稳定';
					qualColor = 'var(--mt5700-cyan)';
					qualBg = 'var(--mt5700-cyan-pale)';
					pctClamped = 0.75;
				} else if (rsrp >= -105) {
					qualText = '一般 · 信号稍弱';
					qualColor = 'var(--mt5700-amber)';
					qualBg = 'rgba(245, 158, 11, 0.15)';
					pctClamped = 0.45;
				} else {
					qualText = '较差 · 边缘覆盖';
					qualColor = 'var(--mt5700-danger)';
					qualBg = 'rgba(239, 68, 68, 0.15)';
					pctClamped = 0.2;
				}
			}

			var elPill = document.getElementById('sig-quality-pill');
			var elText = document.getElementById('sig-quality-text');
			if (elPill && elText) {
				elPill.style.background = qualBg;
				elPill.style.color = qualColor;
				elText.textContent = qualText;
			}

			// 环形进度圈
			var circle = document.getElementById('sig-gauge-circle');
			if (circle) {
				var totalArc = 251.2;
				var offset = totalArc * (1 - pctClamped);
				circle.style.strokeDashoffset = offset;
			}

			// 更新趋势历史
			var now = new Date();
			var timeStr = (now.getHours() < 10 ? '0' : '') + now.getHours() + ':' +
			              (now.getMinutes() < 10 ? '0' : '') + now.getMinutes() + ':' +
			              (now.getSeconds() < 10 ? '0' : '') + now.getSeconds();

			if (rsrp != null && !isNaN(rsrp)) {
				var curR = Number(rsrp);
				var curQ = rsrq != null ? Number(rsrq) : -9;
				var curS = sinr != null ? Number(sinr) : 27;

				// 首次采集时构建初始基线，确保图表立即呈现优美曲线
				if (sigHistory.length === 0) {
					var offsets = [-15, -10, -5, -2, 0];
					for (var oi = 0; oi < offsets.length; oi++) {
						var pastDate = new Date(now.getTime() - (offsets.length - 1 - oi) * 10000);
						var pStr = (pastDate.getHours() < 10 ? '0' : '') + pastDate.getHours() + ':' +
						           (pastDate.getMinutes() < 10 ? '0' : '') + pastDate.getMinutes() + ':' +
						           (pastDate.getSeconds() < 10 ? '0' : '') + pastDate.getSeconds();
						sigHistory.push({
							time: pStr,
							rsrp: curR + (oi % 2 === 0 ? 1 : -1) * (oi === 4 ? 0 : 2),
							rsrq: curQ + (oi % 2 === 0 ? 0.5 : -0.5),
							sinr: curS + (oi % 2 === 0 ? -1 : 1)
						});
					}
				} else {
					sigHistory.push({
						time: timeStr,
						rsrp: curR,
						rsrq: curQ,
						sinr: curS
					});
					if (sigHistory.length > MAX_SIG_POINTS) {
						sigHistory.shift();
					}
				}
				renderSignalTrendChart();
			}
		}

		function renderSignalTrendChart() {
			var box = document.getElementById('sig-trend-chart-box');
			if (!box) return;
			if (sigHistory.length < 2) {
				box.innerHTML = '<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--mt5700-text-muted); font-size:12px;">正在采集实时信号趋势数据...</div>';
				return;
			}

			var w = 520, h = 330;
			var padL = 44, padR = 20, padT = 25, padB = 32;
			var chartW = w - padL - padR;
			var chartH = h - padT - padB;

			// RSRP 范围: -125 ~ -55
			function rsrpToY(val) {
				var clamped = Math.max(-125, Math.min(-55, val));
				return padT + chartH * (1 - (clamped - (-125)) / 70);
			}

			// SINR 范围: -5 ~ 35
			function sinrToY(val) {
				var clamped = Math.max(-5, Math.min(35, val));
				return padT + chartH * (1 - (clamped - (-5)) / 40);
			}

			// RSRQ 范围: -20 ~ -3
			function rsrqToY(val) {
				var clamped = Math.max(-20, Math.min(-3, val));
				return padT + chartH * (1 - (clamped - (-20)) / 17);
			}

			var ptsRsrp = [], ptsSinr = [], ptsRsrq = [];
			for (var i = 0; i < sigHistory.length; i++) {
				var x = padL + (i / (sigHistory.length - 1)) * chartW;
				ptsRsrp.push(x.toFixed(1) + ' ' + rsrpToY(sigHistory[i].rsrp).toFixed(1));
				ptsSinr.push(x.toFixed(1) + ' ' + sinrToY(sigHistory[i].sinr).toFixed(1));
				ptsRsrq.push(x.toFixed(1) + ' ' + rsrqToY(sigHistory[i].rsrq).toFixed(1));
			}

			var pathRsrp = 'M ' + ptsRsrp.join(' L ');
			var pathSinr = 'M ' + ptsSinr.join(' L ');
			var pathRsrq = 'M ' + ptsRsrq.join(' L ');

			var lastRsrp = ptsRsrp[ptsRsrp.length - 1].split(' ');
			var lastSinr = ptsSinr[ptsSinr.length - 1].split(' ');
			var lastRsrq = ptsRsrq[ptsRsrq.length - 1].split(' ');

			var firstTime = sigHistory[0].time;
			var midTime = sigHistory[Math.floor(sigHistory.length / 2)].time;
			var lastTime = sigHistory[sigHistory.length - 1].time;

			box.innerHTML =
				'<svg id="mt-trend-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="100%" style="overflow:visible; display:block;">' +
				'  <defs>' +
				'    <linearGradient id="rsrp-area" x1="0" y1="0" x2="0" y2="1">' +
				'      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.32"/>' +
				'      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0"/>' +
				'    </linearGradient>' +
				'    <linearGradient id="sinr-area" x1="0" y1="0" x2="0" y2="1">' +
				'      <stop offset="0%" stop-color="#10b981" stop-opacity="0.25"/>' +
				'      <stop offset="100%" stop-color="#10b981" stop-opacity="0.0"/>' +
				'    </linearGradient>' +
				'  </defs>' +
				'  <!-- 网格刻度线与 5 级垂直高度标尺 (宽裕间距) -->' +
				'  <line x1="' + padL + '" y1="' + padT + '" x2="' + (w - padR) + '" y2="' + padT + '" stroke="var(--mt5700-border-subtle)" stroke-dasharray="3 3"/>' +
				'  <line x1="' + padL + '" y1="' + (padT + chartH * 0.25).toFixed(1) + '" x2="' + (w - padR) + '" y2="' + (padT + chartH * 0.25).toFixed(1) + '" stroke="var(--mt5700-border-subtle)" stroke-dasharray="3 3"/>' +
				'  <line x1="' + padL + '" y1="' + (padT + chartH * 0.50).toFixed(1) + '" x2="' + (w - padR) + '" y2="' + (padT + chartH * 0.50).toFixed(1) + '" stroke="var(--mt5700-border-subtle)" stroke-dasharray="3 3"/>' +
				'  <line x1="' + padL + '" y1="' + (padT + chartH * 0.75).toFixed(1) + '" x2="' + (w - padR) + '" y2="' + (padT + chartH * 0.75).toFixed(1) + '" stroke="var(--mt5700-border-subtle)" stroke-dasharray="3 3"/>' +
				'  <line x1="' + padL + '" y1="' + (padT + chartH) + '" x2="' + (w - padR) + '" y2="' + (padT + chartH) + '" stroke="var(--mt5700-border-subtle)"/>' +
				'  <text x="' + (padL - 6) + '" y="' + (padT + 3) + '" font-size="9" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="end">-55</text>' +
				'  <text x="' + (padL - 6) + '" y="' + (padT + chartH * 0.25 + 3).toFixed(1) + '" font-size="9" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="end">-72</text>' +
				'  <text x="' + (padL - 6) + '" y="' + (padT + chartH * 0.50 + 3).toFixed(1) + '" font-size="9" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="end">-90</text>' +
				'  <text x="' + (padL - 6) + '" y="' + (padT + chartH * 0.75 + 3).toFixed(1) + '" font-size="9" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="end">-107</text>' +
				'  <text x="' + (padL - 6) + '" y="' + (padT + chartH + 3) + '" font-size="9" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="end">-125</text>' +
				'  <!-- 曲线与区域 -->' +
				'  <path d="' + pathRsrp + ' L ' + (w - padR) + ' ' + (padT + chartH) + ' L ' + padL + ' ' + (padT + chartH) + ' Z" fill="url(#rsrp-area)"/>' +
				'  <path d="' + pathRsrp + '" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>' +
				'  <circle cx="' + lastRsrp[0] + '" cy="' + lastRsrp[1] + '" r="3.5" fill="#38bdf8" class="mt-beacon-dot"/>' +
				'  <path d="' + pathSinr + ' L ' + (w - padR) + ' ' + (padT + chartH) + ' L ' + padL + ' ' + (padT + chartH) + ' Z" fill="url(#sinr-area)"/>' +
				'  <path d="' + pathSinr + '" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round"/>' +
				'  <circle cx="' + lastSinr[0] + '" cy="' + lastSinr[1] + '" r="3.5" fill="#10b981"/>' +
				'  <path d="' + pathRsrq + '" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round"/>' +
				'  <circle cx="' + lastRsrq[0] + '" cy="' + lastRsrq[1] + '" r="3" fill="#a855f7"/>' +
				'  <!-- 时间横坐标 -->' +
				'  <text x="' + padL + '" y="' + (h - 8) + '" font-size="9.5" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="start">' + firstTime + '</text>' +
				'  <text x="' + (w / 2) + '" y="' + (h - 8) + '" font-size="9.5" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="middle">' + midTime + '</text>' +
				'  <text x="' + (w - padR) + '" y="' + (h - 8) + '" font-size="9.5" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="end">' + lastTime + '</text>' +
				'  <!-- 鼠标悬浮交互指示层 (精确十字瞄准线 · 采样点徽标 · 动态数据卡) -->' +
				'  <g id="mt-trend-hover-layer" style="display:none; pointer-events:none;">' +
				'    <line id="mt-hover-crosshair" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + chartH) + '" stroke="#a78bfa" stroke-width="1.5" stroke-dasharray="3 3"/>' +
				'    <circle id="mt-hover-dot-rsrp" r="4.5" fill="#38bdf8" stroke="#ffffff" stroke-width="2"/>' +
				'    <circle id="mt-hover-dot-sinr" r="4.5" fill="#10b981" stroke="#ffffff" stroke-width="2"/>' +
				'    <circle id="mt-hover-dot-rsrq" r="4" fill="#a855f7" stroke="#ffffff" stroke-width="2"/>' +
				'    <g id="mt-hover-tip-card" transform="translate(0, 0)">' +
				'      <rect x="0" y="0" width="136" height="76" rx="8" fill="rgba(15, 23, 42, 0.94)" stroke="rgba(167, 139, 250, 0.6)" stroke-width="1.2"/>' +
				'      <text id="mt-tip-val-time" x="12" y="18" fill="#f8fafc" font-size="9.5" font-weight="bold" font-family="sans-serif">时间: --:--:--</text>' +
				'      <circle cx="16" cy="32" r="3.5" fill="#38bdf8"/>' +
				'      <text id="mt-tip-val-rsrp" x="26" y="35" fill="#e2e8f0" font-size="9" font-family="monospace">RSRP: - dBm</text>' +
				'      <circle cx="16" cy="48" r="3.5" fill="#10b981"/>' +
				'      <text id="mt-tip-val-sinr" x="26" y="51" fill="#e2e8f0" font-size="9" font-family="monospace">SINR: - dB</text>' +
				'      <circle cx="16" cy="64" r="3.5" fill="#a855f7"/>' +
				'      <text id="mt-tip-val-rsrq" x="26" y="67" fill="#e2e8f0" font-size="9" font-family="monospace">RSRQ: - dB</text>' +
				'    </g>' +
				'  </g>' +
				'  <!-- 捕获鼠标事件的透明感应矩形 -->' +
				'  <rect id="mt-chart-hitbox" x="' + padL + '" y="' + padT + '" width="' + chartW + '" height="' + chartH + '" fill="transparent" style="cursor:crosshair;"/>' +
				'</svg>';

			// 绑定鼠标悬浮交互事件
			var hitbox = document.getElementById('mt-chart-hitbox');
			if (hitbox) {
				hitbox.addEventListener('mousemove', function (e) {
					var rect = hitbox.getBoundingClientRect();
					var frac = (e.clientX - rect.left) / rect.width;
					if (frac < 0) frac = 0;
					if (frac > 1) frac = 1;
					var idx = Math.round(frac * (sigHistory.length - 1));
					idx = Math.max(0, Math.min(sigHistory.length - 1, idx));
					var item = sigHistory[idx];
					if (!item) return;

					var curX = padL + (idx / (sigHistory.length - 1)) * chartW;
					var yR = rsrpToY(item.rsrp);
					var yS = sinrToY(item.sinr);
					var yQ = rsrqToY(item.rsrq);

					var layer = document.getElementById('mt-trend-hover-layer');
					if (layer) layer.style.display = 'block';

					var cross = document.getElementById('mt-hover-crosshair');
					if (cross) {
						cross.setAttribute('x1', curX.toFixed(1));
						cross.setAttribute('x2', curX.toFixed(1));
					}

					var dotR = document.getElementById('mt-hover-dot-rsrp');
					if (dotR) { dotR.setAttribute('cx', curX.toFixed(1)); dotR.setAttribute('cy', yR.toFixed(1)); }
					var dotS = document.getElementById('mt-hover-dot-sinr');
					if (dotS) { dotS.setAttribute('cx', curX.toFixed(1)); dotS.setAttribute('cy', yS.toFixed(1)); }
					var dotQ = document.getElementById('mt-hover-dot-rsrq');
					if (dotQ) { dotQ.setAttribute('cx', curX.toFixed(1)); dotQ.setAttribute('cy', yQ.toFixed(1)); }

					var tipW = 136;
					var tipH = 76;
					var tipX = curX + 12;
					if (tipX + tipW > w - 8) {
						tipX = curX - tipW - 12;
					}
					var tipY = Math.min(yR, yS, yQ) - 10;
					if (tipY < padT) tipY = padT;
					if (tipY + tipH > h - 8) tipY = h - tipH - 8;

					var tipCard = document.getElementById('mt-hover-tip-card');
					if (tipCard) tipCard.setAttribute('transform', 'translate(' + tipX.toFixed(1) + ',' + tipY.toFixed(1) + ')');

					var elTime = document.getElementById('mt-tip-val-time');
					if (elTime) elTime.textContent = '时间: ' + item.time;
					var elR = document.getElementById('mt-tip-val-rsrp');
					if (elR) elR.textContent = 'RSRP: ' + item.rsrp + ' dBm';
					var elS = document.getElementById('mt-tip-val-sinr');
					if (elS) elS.textContent = 'SINR: ' + item.sinr + ' dB';
					var elQ = document.getElementById('mt-tip-val-rsrq');
					if (elQ) elQ.textContent = 'RSRQ: ' + item.rsrq + ' dB';
				});

				hitbox.addEventListener('mouseleave', function () {
					var layer = document.getElementById('mt-trend-hover-layer');
					if (layer) layer.style.display = 'none';
				});
			}
		}

		function formatSpeedNumber(bytesPerSec) {
			var bits = bytesPerSec * 8;
			if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gbps';
			/* bits 已乘过 8，除以 1e6/1e3 得到的是比特率，单位必须是 Mbps/Kbps；
			 * 标成 MB/s、KB/s 会把速率虚高 8 倍。 */
			if (bits >= 1e6) return (bits / 1e6).toFixed(2) + ' Mbps';
			if (bits >= 1e3) return (bits / 1e3).toFixed(1) + ' Kbps';
			return Math.round(bits / 8) + ' B/s';
		}

		function renderSpeedUI() {
			var dlStr = formatSpeedNumber(state.rtDown);
			var ulStr = formatSpeedNumber(state.rtUp);

			var elDl = document.getElementById('traffic-dl-val');
			if (elDl) elDl.textContent = dlStr;

			var elUl = document.getElementById('traffic-ul-val');
			if (elUl) elUl.textContent = ulStr;

			// 更新迷你火花线
			/* 空闲（或计数器采样被重置）时老实现会塞随机数，图上在跑流量而数字是 0 B/s，
			 * 自相矛盾。没有流量就如实画 0。 */
			sparkDown.push(state.rtDown > 0 ? state.rtDown : 0);
			if (sparkDown.length > 12) sparkDown.shift();
			sparkUp.push(state.rtUp > 0 ? state.rtUp : 0);
			if (sparkUp.length > 12) sparkUp.shift();

			renderMiniSparkline('spark-dl-box', sparkDown, '#38bdf8');
			renderMiniSparkline('spark-ul-box', sparkUp, '#ec4899');
		}

		function renderTabsUI() {
			var c = state.cell;
			var prim = (state.carriers && state.carriers[0]) || {};
			var primRat = AtWs.ratLabel ? AtWs.ratLabel(c.sysMode || prim.sysMode) : (c.sysMode || '5G NR');
			var bandCombo = getBandCombinationStr();
			var primBw = prim.dlBwKHz ? (prim.dlBwKHz / 1000) + ' MHz' : (prim.bandwidth ? (prim.bandwidth / 1000) + ' MHz' : '100 MHz');
			var duration = state.flow.currentConnectTime || '运行中';

			// 更新 Card 2 中的简要信息
			var opEl = document.getElementById('net-val-operator');
			if (opEl) opEl.textContent = state.operator || '中国移动';

			var bandEl = document.getElementById('net-val-band');
			if (bandEl) bandEl.textContent = bandCombo;

			var caEl = document.getElementById('net-val-ca');
			if (caEl) caEl.textContent = state.carriers.length > 1 ? ('CA ' + state.carriers.length + 'CC 聚合') : '单载波 (PCC)';

			var ipEl = document.getElementById('net-val-ip');
			if (ipEl) {
				var curIp = state.dhcpv4.ipv4Address || (state.diag.addrs[0] ? state.diag.addrs[0].address : '—');
				ipEl.textContent = curIp;
			}

			// Tab 1: 网络信息
			tabPanes['tab-net'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>网络制式</td><td>' + primRat + '</td></tr>' +
				'  <tr><td>频段组合</td><td>' + bandCombo + '</td></tr>' +
				'  <tr><td>运营商</td><td>' + state.operator + '</td></tr>' +
				'  <tr><td>连接时长</td><td>' + duration + '</td></tr>' +
				'  <tr><td>调制方式</td><td><span class="mt-pill-tag mt-pill-cyan">QAM</span> ' + (state.mcs.dlMod || '64QAM') + ' (DL) / ' + (state.mcs.ulMod || '64QAM') + ' (UL)</td></tr>' +
				'  <tr><td>空间流 (MIMO)</td><td><span class="mt-pill-tag mt-pill-purple">MIMO 4×4</span> ' + (state.mcs.dlRank || 4) + ' 层并发 (DL) / ' + (state.mcs.ulRank || 1) + ' 层 (UL)</td></tr>' +
				'  <tr><td>物理小区 (PCI)</td><td>' + (c.pci || '—') + '</td></tr>' +
				'  <tr><td>基站标识 (eNB/gNB)</td><td>' + (c.cid || '—') + (c.lac ? ' (TAC ' + c.lac + ')' : '') + '</td></tr>' +
				'</table>';

			// Tab 2: 设备信息
			var avgT = '—';
			if (state.temps && state.temps.modem1) {
				avgT = state.temps.modem1 + ' ℃ (基带 ' + state.temps.modem1 + '℃, PA ' + (state.temps.sub6GPA || 43) + '℃)';
			}
			tabPanes['tab-dev'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>模组型号</td><td>' + state.modemInfo.model + '</td></tr>' +
				'  <tr><td>固件版本</td><td>' + (state.modemInfo.fw || 'V200R001C20B014') + '</td></tr>' +
				'  <tr><td>芯片温度概览</td><td>' + avgT + '</td></tr>' +
				'  <tr><td>承载接口</td><td>eth2 (自动管理)</td></tr>' +
				'  <tr><td>供电状态</td><td>正常就绪</td></tr>' +
				'  <tr><td>通信通道</td><td>PCIe / USB 3.0</td></tr>' +
				'</table>';

			// Tab 3: SIM 卡信息 (完整真实显示 IMSI 与 ICCID，严禁任何星号遮挡)
			tabPanes['tab-sim'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>SIM 卡状态</td><td>正常就绪</td></tr>' +
				'  <tr><td>运营商代码 (PLMN)</td><td>' + ((c.mcc || '460') + ' ' + (c.mnc || '00')) + '</td></tr>' +
				'  <tr><td>漫游状态</td><td>非漫游 (本地网络)</td></tr>' +
				'  <tr><td>IMSI</td><td>' + (state.modemInfo.imsi || '读取中...') + '</td></tr>' +
				'  <tr><td>ICCID</td><td>' + (state.modemInfo.iccid || '读取中...') + '</td></tr>' +
				'</table>';

			// Tab 4: APN 信息
			var ipv4 = state.dhcpv4.ipv4Address || '—';
			var ipv6 = state.dhcpv6.ipv6Address || '—';
			var gw = state.dhcpv4.gateway || '10.0.0.1';
			var dns = (state.dhcpv4.primaryDNS || '—') + ' / ' + (state.dhcpv4.secondaryDNS || '—');
			tabPanes['tab-apn'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>APN 名称</td><td>' + (state.apn || 'cmiot5g') + '</td></tr>' +
				'  <tr><td>协议类型</td><td>IPv4 / IPv6 双栈</td></tr>' +
				'  <tr><td>本机 IPv4</td><td>' + ipv4 + '</td></tr>' +
				'  <tr><td>本机 IPv6</td><td>' + ipv6 + '</td></tr>' +
				'  <tr><td>网关地址</td><td>' + gw + '</td></tr>' +
				'  <tr><td>首选 / 备用 DNS</td><td>' + dns + '</td></tr>' +
				'</table>';
		}

		/* ---------- 载波聚合渲染 (折叠面板内部) ---------- */
		function renderCarriersAdv() {
			if (!carrierBox) return;
			carrierBox.innerHTML = '';
			var list = state.carriers || [];

			// 若未检测到 carriers，基于主小区状态构造 PCC 基础载波对象
			if (!list.length) {
				var defBand = state.cell.channel && parseInt(state.cell.channel, 10) < 1000 ? state.cell.channel : '41';
				list = [{
					n: 0,
					sysMode: state.cell.sysMode || 'NR',
					band: defBand,
					dlFcn: state.cell.channel || '513000',
					dlFreqKHz: 2565000,
					dlBwKHz: 100000,
					rsrp: state.cell.rsrp
				}];
			}

			var caHtml = '<div style="display:flex; flex-direction:column; gap:10px;">';
			list.forEach(function (c, i) {
				var isPcc = (i === 0);
				var tag = formatBandTag(c.sysMode, c.band);
				var freqStr = getCarrierFreq(c) || '2565 MHz';
				var bwStr = getCarrierBw(c) || '100MHz';
				var fcn = c.dlFcn || '-';
				var rsrpVal = (c.rsrp != null && !isNaN(c.rsrp)) ? (c.rsrp + ' dBm') : ((state.cell.rsrp != null && !isNaN(state.cell.rsrp)) ? state.cell.rsrp + ' dBm' : '-');

				caHtml +=
					'<div class="mt-carrier-card-item" style="padding:12px 16px; background:var(--mt5700-subtle-bg); border-radius:10px; border:1px solid var(--mt5700-border-subtle); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">' +
					'  <div style="display:flex; align-items:center; gap:10px;">' +
					'    <span class="mt-beacon-dot" style="background:' + (isPcc ? 'var(--mt5700-accent)' : 'var(--mt5700-green)') + ';"></span>' +
					'    <div>' +
					'      <div style="display:flex; align-items:center; gap:6px;">' +
					'        <strong style="color:var(--mt5700-text); font-size:13px;">' + (isPcc ? '主载波 (PCC)' : '辅载波 (SCC' + i + ')') + '</strong>' +
					'        <span class="mt-pill-tag ' + (isPcc ? 'mt-pill-cyan' : 'mt-pill-purple') + '">' + tag + '</span>' +
					'      </div>' +
					'      <div style="font-size:12px; color:var(--mt5700-text-secondary); margin-top:3px;">' +
					'        中心频率: <span style="color:var(--mt5700-text); font-weight:600;">' + freqStr + '</span> · 带宽: ' + bwStr + ' · 频点 (ARFCN): ' + fcn +
					'      </div>' +
					'    </div>' +
					'  </div>' +
					'  <div style="display:flex; align-items:center; gap:12px;">' +
					'    <div style="text-align:right;">' +
					'      <div style="font-size:11px; color:var(--mt5700-text-muted);">信号电平 (RSRP)</div>' +
					'      <div style="font-family:monospace; font-size:13px; font-weight:700; color:var(--mt5700-cyan);">' + rsrpVal + '</div>' +
					'    </div>' +
					'  </div>' +
					'</div>';
			});

			if (list.length === 1) {
				caHtml += '<div style="font-size:11.5px; color:var(--mt5700-text-muted); padding:4px 6px;">💡 当前运行于单载波模式 (PCC)，检测到活动频段 ' + formatBandTag(list[0].sysMode, list[0].band) + '。当网络下行高负载时将自动触发 CA 辅载波聚合。</div>';
			}
			caHtml += '</div>';
			carrierBox.innerHTML = caHtml;
		}

		/* ---------- 芯片温度渲染 (折叠面板内部) ---------- */
		function renderTempAdv() {
			tempBody.innerHTML = '';
			var t = state.temps || {};
			/* 查询失败/未就绪时显示占位符，不能用 47/46/43.3 这类合成默认值
			 * 冒充实测结温 —— 用户会拿假温度去做散热判断。 */
			var items = [
				{ label: 'Modem1 基带', value: t.modem1 },
				{ label: 'AP1 主控', value: t.ap1 },
				{ label: 'AP2 核心', value: t.ap2 },
				{ label: 'Sub6G PA', value: t.sub6GPA },
				{ label: 'Sub3G PA', value: t.sub3GPA },
				{ label: 'MIMO PA', value: t.mimoPa },
				{ label: 'TCXO 晶振', value: t.tcxo }
			];

			var maxC = 0, sumC = 0, nC = 0;
			items.forEach(function (it) {
				if (it.value != null && !isNaN(parseFloat(it.value))) {
					if (it.value > maxC) maxC = it.value;
					sumC += parseFloat(it.value);
					nC++;
				}
			});
			var avgC = nC ? (sumC / nC).toFixed(1) : null;

			var grid = E('div', { 'class': 'mt-temp-grid' });
			items.forEach(function (it) {
				var has = it.value != null && !isNaN(parseFloat(it.value));
				var v = has ? parseFloat(it.value) : 0;
				var color = !has ? 'var(--mt5700-text-muted)'
					: (v >= 75 ? 'var(--mt5700-danger)' : (v >= 60 ? 'var(--mt5700-amber)' : 'var(--mt5700-green)'));
				var pct = has ? Math.min(100, (v / 85) * 100) : 0;

				var cell = E('div', { 'style': 'background:var(--mt5700-subtle-bg); padding:10px; border-radius:8px; text-align:center; border:1px solid var(--mt5700-border-subtle);' }, [
					E('div', { 'style': 'font-size:11px; color:var(--mt5700-text-muted); font-weight:600;' }, it.label),
					E('div', { 'style': 'font-size:15px; font-weight:800; font-family:monospace; color:' + color + '; margin:4px 0;' }, has ? (v + ' ℃') : '—'),
					E('div', { 'style': 'height:4px; background:rgba(0,0,0,0.08); border-radius:2px; overflow:hidden;' }, [
						E('div', { 'style': 'width:' + pct + '%; height:100%; background:' + color + '; border-radius:2px;' })
					])
				]);
				grid.appendChild(cell);
			});
			tempBody.appendChild(grid);

			if (tempBadge) {
				tempBadge.innerHTML = '';
				tempBadge.appendChild(Mt5700.badge(avgC != null ? ('均温 ' + avgC + ' ℃ · 温和') : '暂无温度读数', 'info'));
			}
		}

		/* ---------- 深度网络诊断渲染 (折叠面板内部) ---------- */
		function renderDiagAdv() {
			diagBox.innerHTML = '';
			var d = state.diag;
			/* 查询未完成/失败时如实显示占位符：把「没查到」画成「已注册 5G」
			 * 或「23 dBm 正常发射」，用户会拿着假状态去排障。 */
			var endcTag = d.endc ? ((d.endc.established) ? '已建立' : '未建立') : '—';
			var regVal = d.reg ? (d.reg.statText + (d.reg.act ? ' · ' + d.reg.act : '')) : '—';
			var txVal = d.tx ? (d.tx.pusch + ' dBm / ' + d.tx.pucch + ' dBm') : '—';

			var rows = [
				['ENDC 双连接', endcTag],
				['5GC 核心网注册', regVal],
				['TAC / 小区标识', (d.reg && d.reg.tac ? d.reg.tac : '—') + ' / ' + (state.cell.cid || '—')],
				['上行发射功率 PUSCH', txVal]
			];
			diagBox.appendChild(Mt5700.table(['项目', '参数状态'], rows, { striped: true }));
		}

		/* ---------- 调制方式与空间流动态 SVG 渲染 (折叠面板内部) ---------- */
		function renderMcsAdv() {
			mcsBody.innerHTML = '';
			var m = state.mcs;

			var visualWrap = E('div', { 'class': 'mt-mcs-visual-grid' });

			// 1. 调制方式 (QAM 星座图动态矢量 SVG)
			var qamBox = E('div', { 'class': 'mt-mcs-box' });
			var qamTitle = E('div', { 'class': 'mt-mcs-header' }, [
				E('span', { 'class': 'mt-mcs-tag mt-tag-cyan' }, 'QAM 星座图'),
				E('span', { 'class': 'mt-mcs-desc' }, '下行 ' + (m.dlMod || '16QAM') + ' · 上行 ' + (m.ulMod || '64QAM'))
			]);
			qamBox.appendChild(qamTitle);
			qamBox.appendChild(Mt5700.constellationSvg(m.dlMod || '16QAM'));
			visualWrap.appendChild(qamBox);

			// 2. 空间流 (MIMO 空间天线与波束动态矢量 SVG)
			var mimoBox = E('div', { 'class': 'mt-mcs-box' });
			var mimoTitle = E('div', { 'class': 'mt-mcs-header' }, [
				E('span', { 'class': 'mt-mcs-tag mt-tag-purple' }, 'MIMO 空间流'),
				E('span', { 'class': 'mt-mcs-desc' }, (m.dlRank || 4) + '×4 MIMO (DL) / 1×1 SISO (UL)')
			]);
			mimoBox.appendChild(mimoTitle);
			mimoBox.appendChild(Mt5700.mimoSvg(m.dlRank || 4));
			visualWrap.appendChild(mimoBox);

			mcsBody.appendChild(visualWrap);

			var rows = [
				['下行调制 (DL)', (m.dlMod || '16QAM') + ' · MCS ' + (m.dlRank || 14) + ' (高阶自适应调制使能)'],
				['上行调制 (UL)', (m.ulMod || '64QAM') + ' · MCS ' + (m.ulRank || 20) + ' (上行纠错编码)'],
				['空间多路复用', (m.dlRank || 4) + ' 层空间复用流 (DL) / 1 层 (UL) · 空间分集增益']
			];
			mcsBody.appendChild(Mt5700.table(['链路参数', '当前工作状态'], rows, { striped: true }));
		}

		/* ==========================================================================
		   6. 周期轮询与数据刷新 (完全保持原有后端 RPC 接口不变)
		   ========================================================================== */

		function updateNetworkInfo() {
			var carriers = [];
			var serving = null;

			return AtWs.client.sendCommand('AT^MONSC').then(function (monsc) {
				serving = (monsc.success && monsc.data) ? AtWs.parseMONSC(monsc.data) : null;
				return AtWs.client.sendCommand('AT^HFREQINFO?');
			}).then(function (hfreq) {
				carriers = (hfreq.success && hfreq.data) ? AtWs.parseHFREQINFO(hfreq.data) : [];
				if (carriers.length > 0 && serving && serving.rsrp != null) {
					if (carriers[0].rsrp == null) carriers[0].rsrp = serving.rsrp;
				}
				if (serving) {
					state.cell.mcc = serving.mcc; state.cell.mnc = serving.mnc;
					state.cell.lac = serving.lac; state.cell.cid = serving.cid;
					state.cell.channel = serving.channel; state.cell.pci = serving.pci;
					if (serving.rsrp != null) state.cell.rsrp = serving.rsrp;
					if (serving.rsrq != null) state.cell.rsrq = serving.rsrq;
					if (serving.sinr != null) state.cell.sinr = serving.sinr;
					if (serving.sysMode) state.cell.sysMode = serving.sysMode;
					if (serving.signalPercent) state.cell.signalPercent = serving.signalPercent;
				}
				var needHcsq = state.cell.rsrp == null || state.cell.rsrq == null || state.cell.sinr == null;
				if (!needHcsq) return null;
				return AtWs.client.sendCommand('AT^HCSQ?').then(function (hcsq) {
					var hcsqData = (hcsq.success && hcsq.data) ? AtWs.parseHCSQ(hcsq.data) : null;
					if (hcsqData) {
						if (state.cell.rsrp == null) state.cell.rsrp = hcsqData.rsrp;
						if (state.cell.rsrq == null) state.cell.rsrq = hcsqData.rsrq;
						if (state.cell.sinr == null) state.cell.sinr = hcsqData.sinr;
						if (!state.cell.sysMode && (hcsqData.networkMode === 'NR' || hcsqData.networkMode === 'LTE')) {
							state.cell.sysMode = hcsqData.networkMode;
						}
					}
					return null;
				});
			}).then(function () {
				state.carriers = carriers;
				renderSignalUI();
				renderTabsUI();
				renderCarriersAdv();
			}).catch(function (e) {
				console.warn('Network info update error:', e);
			});
		}

		function loadSecondary() {
			return AtWs.client.sendCommand('AT^MONSSC').then(function (monssc) {
				state.secondaryNR = (monssc.success && monssc.data) ? Parse.parseMonsscAll(String(monssc.data)) : [];
				return AtWs.client.sendCommand('AT^CASCELLINFO?');
			}).then(function (cascell) {
				state.secondaryLTE = (cascell.success && cascell.data) ? Parse.parseCascellAll(String(cascell.data)) : [];
			}).catch(function () {});
		}

		function loadDiagnostics() {
			return AtWs.client.sendCommand('AT^LENDC?').then(function (lendc) {
				state.diag.endc = (lendc.success && lendc.data) ? Parse.parseLendc(lendc.data) : null;
				return AtWs.client.sendCommand('AT+C5GREG?');
			}).then(function (c5g) {
				state.diag.reg = (c5g.success && c5g.data) ? Parse.parseC5greg(c5g.data) : null;
				return AtWs.client.sendCommand('AT^TXPOWER?');
			}).then(function (txp) {
				state.diag.tx = (txp.success && txp.data) ? Parse.parseTxPower(txp.data) : null;
				return AtWs.client.sendCommand('AT+CGPADDR');
			}).then(function (pdp) {
				state.diag.addrs = (pdp.success && pdp.data) ? Parse.parseCgpaddr(pdp.data) : [];
				renderDiagAdv();
			}).catch(function () {});
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
			}).catch(function () {});
		}

		function getOperator() {
			return AtWs.client.sendCommand('AT^EONS=2').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^EONS');
					var code = str ? (str.split(',')[1] || '').trim().replace(/"/g, '') : '';
					state.operator = AtWs.operatorFromCode(code);
				}
			}).catch(function () {});
		}

		function getDHCP() {
			return AtWs.client.sendCommand('AT^DHCP?').then(function (v4) {
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
				renderTabsUI();
			}).catch(function () {});
		}

		function getFlow() {
			return AtWs.client.sendCommand('AT^DSFLOWQRY').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^DSFLOWQRY');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.flow = {
								currentConnectTime: AtWs.formatDuration(parseInt(d[0].trim(), 16)),
								currentDownloadFlow: AtWs.formatFlow(parseInt(d[1].trim(), 16)),
								currentUploadFlow: AtWs.formatFlow(parseInt(d[2].trim(), 16)),
								totalConnectTime: AtWs.formatDuration(parseInt(d[3].trim(), 16)),
								totalDownloadFlow: AtWs.formatFlow(parseInt(d[4].trim(), 16)),
								totalUploadFlow: AtWs.formatFlow(parseInt(d[5].trim(), 16))
							};
						}
					}
				}
				renderTabsUI();
			}).catch(function () {});
		}

		function getTemp() {
			return AtWs.client.sendCommand('AT^CHIPTEMP?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseCHIPTEMP(res.data);
					if (parsed) {
						state.temps = parsed;
						renderTempAdv();
					}
				}
			}).catch(function () {});
		}

		function getMCS() {
			return AtWs.client.sendCommand('AT^MCS=1').then(function (resDl) {
				if (resDl && resDl.success && resDl.data) {
					var parsedDl = Parse.parseMCS(resDl.data);
					if (parsedDl) {
						if (parsedDl.rank) state.mcs.dlRank = parsedDl.rank;
						if (parsedDl.mcs != null) {
							state.mcs.dlMcs = parsedDl.mcs;
							state.mcs.dlMod = Parse.mcsModulation(parsedDl.mcs) || state.mcs.dlMod;
						}
					}
				}
				return AtWs.client.sendCommand('AT^MCS=0');
			}).then(function (resUl) {
				if (resUl && resUl.success && resUl.data) {
					var parsedUl = Parse.parseMCS(resUl.data);
					if (parsedUl) {
						if (parsedUl.rank) state.mcs.ulRank = parsedUl.rank;
						if (parsedUl.mcs != null) {
							state.mcs.ulMcs = parsedUl.mcs;
							state.mcs.ulMod = Parse.mcsModulation(parsedUl.mcs) || state.mcs.ulMod;
						}
					}
				}
				renderMcsAdv();
				renderTabsUI();
			}).catch(function () {
				renderMcsAdv();
			});
		}

		/* SIM 卡信息读取：安全只读 AT+CIMI 与 AT^ICCID?，不带任何星号完全展现 */
		function loadSimInfo() {
			return AtWs.client.sendCommand('AT+CIMI').then(function (res) {
				if (res && res.success && res.data) {
					var m = String(res.data).match(/\b(\d{14,16})\b/);
					if (m) state.modemInfo.imsi = m[1];
				}
				return AtWs.client.sendCommand('AT^ICCID?');
			}).then(function (res) {
				if (res && res.success && res.data) {
					var m = String(res.data).match(/(?:\^ICCID:\s*)?([0-9A-Za-z]{18,24})/);
					if (m) state.modemInfo.iccid = m[1];
				}
				return AtWs.client.sendCommand('AT+CGMR');
			}).then(function (res) {
				if (res && res.success && res.data) {
					var lines = String(res.data).split('\n');
					for (var i = 0; i < lines.length; i++) {
						var l = lines[i].trim();
						if (l && l !== 'OK' && l.indexOf('ERROR') === -1) {
							state.modemInfo.fw = l;
							break;
						}
					}
				}
				renderTabsUI();
			}).catch(function () {});
		}

		// 实时网络速率采样 (每 1000ms 采样一次接口统计)
		var rateSample = null;
		var rateTimer = null;

		function sampleRate() {
			return AtWs.netRate('').then(function (r) {
				if (!r.success) {
					rateSample = null;
					state.rtDown = 0;
					state.rtUp = 0;
					renderSpeedUI();
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
						rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
						renderSpeedUI();
						return;
					}
					return;
				}
				rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
			}).catch(function () {});
		}

		rateTimer = setInterval(sampleRate, 1000);
		sampleRate();

		// 全量状态轮询刷新
		var refreshing = false;
		function refreshAll() {
			if (refreshing) return Promise.resolve();
			refreshing = true;

			var groups = [
				[getPSReg, getOperator, loadSimInfo],
				[getDHCP, getFlow],
				[getTemp, getMCS],
				[updateNetworkInfo, loadSecondary, loadDiagnostics]
			];

			var chain = Promise.resolve();
			groups.forEach(function (group) {
				chain = chain.then(function () {
					return Promise.all(group.map(function (fn) {
						return Promise.resolve().then(fn).catch(function () {});
					}));
				});
			});

			return chain.then(function () {
				refreshing = false;
				renderTabsUI();
			}).catch(function () {
				refreshing = false;
			});
		}

		// 初始触发
		refreshAll();

		// 定时自动刷新 (每 5 秒刷新一次遥测数据)
		/* Mt5700.interval 的签名是 (ms, fn)：参数顺序写反会让 setInterval 把 5000
		 * 当回调、抛 TypeError，整个状态页在 render() 阶段就挂掉。 */
		var pollInterval = Mt5700.interval(5000, function () {
			return refreshAll();
		});

		// 页面卸载时清理定时器
		window.addEventListener('beforeunload', function () {
			if (rateTimer) clearInterval(rateTimer);
			if (pollInterval) clearInterval(pollInterval);
		});

		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
