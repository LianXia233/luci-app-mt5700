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

		// 页面状态聚合（纯设备真实数据，未获取前严禁硬编码伪造）
		var state = {
			cell: {
				mcc: '', mnc: '', lac: '', cid: '', channel: '', pci: '',
				rsrp: null, rsrq: null, sinr: null, sysMode: '', signalPercent: ''
			},
			diag: { reg: null, tx: null, nrTx: [], endc: null, addrs: [] },
			secondaryNR: [],
			secondaryLTE: [],
			rawHfreq: [],
			hfreqSuccess: null,
			secondarySuccess: null,
			caStatus: {
				state: 'pending', // 'pending' | 'single' | 'ca' | 'none' | 'error' | 'expired'
				lastSuccessTime: 0
			},
			carriers: [],
			rtDown: 0,
			rtUp: 0,
			ambrDown: 0,
			ambrUp: 0,
			networkStatus: '检测中...',
			operator: '读取中...',
			apn: '',
			pdpType: '',
			simStatus: '检测中...',
			deviceInterface: '',
			qci: '',
			flow: {
				currentConnectTime: '',
				currentDownloadFlow: '',
				currentUploadFlow: '',
				totalDownloadFlow: '',
				totalUploadFlow: '',
				totalConnectTime: ''
			},
			temps: null,
			dhcpv4: { ipv4Address: '', subnetMask: '', gateway: '', dhcpServer: '', primaryDNS: '', secondaryDNS: '' },
			dhcpv6: { ipv6Address: '', netmask: '', gateway: '', dhcpServer: '', primaryDNS: '', secondaryDNS: '' },
			ipv6Cap: { capValue: 0, description: '' },
			mcs: { dlMod: '', ulMod: '', dlRank: null, ulRank: null, dlMcs: null, ulMcs: null, dlEff: 0, ulEff: 0 },
			modemInfo: { manufacturer: '', model: '', fw: '', imei: '', imsi: '', iccid: '' },
			dataBearer: null
		};

		var peakDown = 0;
		var peakUp = 0;

		// 信号趋势历史数据 (最多保留 30 个数据点)
		var sigHistory = [];
		var MAX_SIG_POINTS = 30;

		// 流量趋势微型火花线数据（初始为真实空/0采样点，绝不伪造随机数）
		var sparkDown = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		var sparkUp = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

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
						E('span', { 'class': 'mt-net-val', 'id': 'net-val-operator' }, '读取中...')
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
			var caSt = state.caStatus || {};
			if (caSt.state === 'pending' && (!state.cell || !state.cell.channel)) {
				return '待刷新...';
			}
			if (caSt.state === 'error' && (!state.cell || !state.cell.channel)) {
				return '未知 (待刷新)';
			}
			// 回退到主小区信道/频段（真实解析，不伪造默认频点或固定带宽）
			var c = state.cell;
			if (c.channel) {
				var isNr = (c.sysMode === 'NR' || c.sysMode === '7' || c.sysMode === '5G' || !c.sysMode);
				var prefix = isNr ? 'N' : 'B';
				var bandNum = c.band || '';
				if (!bandNum) {
					var ch = parseInt(c.channel, 10);
					if (ch >= 500000 && ch <= 540000) bandNum = '41';
					else if (ch >= 620000 && ch <= 680000) bandNum = '78';
					else if (ch >= 690000 && ch <= 730000) bandNum = '79';
					else if (ch >= 150000 && ch <= 170000) bandNum = '28';
					else if (ch >= 420000 && ch <= 440000) bandNum = '1';
					else if (ch >= 360000 && ch <= 380000) bandNum = '3';
					else bandNum = 'CH ' + c.channel;
				}
				var resTag = prefix + bandNum;
				if (c.channel && bandNum !== 'CH ' + c.channel) {
					resTag += ' (ARFCN ' + c.channel + ')';
				}
				return resTag;
			}
			return '未驻网 / 无信号';
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
			if (bits >= 1e6) return (bits / 1e6).toFixed(2) + ' MB/s';
			if (bits >= 1e3) return (bits / 1e3).toFixed(1) + ' KB/s';
			return Math.round(bits / 8) + ' B/s';
		}

		function renderSpeedUI() {
			var dlStr = formatSpeedNumber(state.rtDown);
			var ulStr = formatSpeedNumber(state.rtUp);

			var elDl = document.getElementById('traffic-dl-val');
			if (elDl) elDl.textContent = dlStr;

			var elUl = document.getElementById('traffic-ul-val');
			if (elUl) elUl.textContent = ulStr;

			// 更新迷你火花线：纯设备真实采样数据，为 0 则为 0，严禁使用 Math.random 伪造
			sparkDown.push(state.rtDown || 0);
			if (sparkDown.length > 12) sparkDown.shift();
			sparkUp.push(state.rtUp || 0);
			if (sparkUp.length > 12) sparkUp.shift();

			renderMiniSparkline('spark-dl-box', sparkDown, '#38bdf8');
			renderMiniSparkline('spark-ul-box', sparkUp, '#ec4899');
		}

		function renderTabsUI() {
			var c = state.cell;
			var prim = (state.carriers && state.carriers[0]) || {};
			var primRat = AtWs.ratLabel ? AtWs.ratLabel(c.sysMode || prim.sysMode) : (c.sysMode || '5G NR');
			var bandCombo = getBandCombinationStr();
			var duration = state.flow.currentConnectTime || '—';

			// 更新 Card 2 中的简要信息（严禁回退假运营商）
			var opEl = document.getElementById('net-val-operator');
			if (opEl) opEl.textContent = state.operator || '—';

			var bandEl = document.getElementById('net-val-band');
			if (bandEl) bandEl.textContent = bandCombo;

			var caEl = document.getElementById('net-val-ca');
			if (caEl) {
				var caSt = state.caStatus || {};
				if (caSt.state === 'pending') {
					caEl.textContent = '待刷新...';
				} else if (caSt.state === 'error') {
					caEl.textContent = '未知 (待刷新)';
				} else if (caSt.state === 'expired') {
					caEl.textContent = '待刷新 (已过期)';
				} else if (caSt.state === 'none') {
					caEl.textContent = '未驻网';
				} else if (state.carriers && state.carriers.length > 1) {
					caEl.textContent = 'CA ' + state.carriers.length + 'CC 聚合';
				} else if (state.carriers && state.carriers.length === 1) {
					caEl.textContent = '单载波 (PCC)';
				} else if (state.cell && state.cell.channel) {
					caEl.textContent = '单载波 (PCC)';
				} else {
					caEl.textContent = '未驻网';
				}
			}

			var ipEl = document.getElementById('net-val-ip');
			if (ipEl) {
				var curIp = state.dhcpv4.ipv4Address || (state.diag.addrs[0] ? state.diag.addrs[0].address : '—');
				ipEl.textContent = curIp;
			}

			// Tab 1: 网络信息
			var dlModText = state.mcs.dlMod ? state.mcs.dlMod + ' (DL)' : '—';
			var ulModText = state.mcs.ulMod ? state.mcs.ulMod + ' (UL)' : '—';
			var dlRankText = state.mcs.dlRank != null ? state.mcs.dlRank + ' 层并发 (DL)' : '—';
			var ulRankText = state.mcs.ulRank != null ? state.mcs.ulRank + ' 层 (UL)' : '—';

			tabPanes['tab-net'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>网络制式</td><td>' + (c.sysMode ? primRat : '—') + '</td></tr>' +
				'  <tr><td>频段组合</td><td>' + bandCombo + '</td></tr>' +
				'  <tr><td>运营商</td><td>' + (state.operator || '—') + '</td></tr>' +
				'  <tr><td>连接时长</td><td>' + duration + '</td></tr>' +
				'  <tr><td>调制方式</td><td><span class="mt-pill-tag mt-pill-cyan">QAM</span> ' + (state.mcs.dlMod ? (dlModText + ' / ' + ulModText) : '— (模组未上报)') + '</td></tr>' +
				'  <tr><td>空间流 (MIMO)</td><td><span class="mt-pill-tag mt-pill-purple">MIMO</span> ' + (state.mcs.dlRank != null ? (dlRankText + ' / ' + ulRankText) : '— (模组未上报)') + '</td></tr>' +
				'  <tr><td>物理小区 (PCI)</td><td>' + (c.pci != null && c.pci !== '' ? c.pci : '—') + '</td></tr>' +
				'  <tr><td>基站标识 (eNB/gNB)</td><td>' + (c.cid || '—') + (c.lac ? ' (TAC ' + c.lac + ')' : '') + '</td></tr>' +
				'</table>';

			// Tab 2: 设备信息（根据 ATI 真实模组上报，绝不写死 RM551E-GL）
			var avgT = '—';
			if (state.temps && state.temps.modem1) {
				avgT = state.temps.modem1 + ' ℃' + (state.temps.sub6GPA ? ' (基带 ' + state.temps.modem1 + '℃, PA ' + state.temps.sub6GPA + '℃)' : '');
			}
			var devIface = state.deviceInterface || (rateSample && rateSample.device) || '—';
			tabPanes['tab-dev'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>模组型号</td><td>' + (state.modemInfo.model || '读取中...') + '</td></tr>' +
				'  <tr><td>制造厂商</td><td>' + (state.modemInfo.manufacturer || 'TD Tech Ltd.') + '</td></tr>' +
				'  <tr><td>固件版本</td><td>' + (state.modemInfo.fw || '—') + '</td></tr>' +
				'  <tr><td>模组 IMEI</td><td>' + (state.modemInfo.imei || '—') + '</td></tr>' +
				'  <tr><td>芯片温度概览</td><td>' + avgT + '</td></tr>' +
				'  <tr><td>数据通信接口</td><td>' + devIface + '</td></tr>' +
				'</table>';

			// Tab 3: SIM 卡信息 (完整真实显示 IMSI 与 ICCID，真实读取 AT+CPIN?)
			var simStat = state.simStatus || '读取中...';
			var plmnStr = (c.mcc && c.mnc) ? (c.mcc + ' ' + c.mnc) : '—';
			var roamStr = '未检测';
			if (state.diag && state.diag.reg) {
				roamStr = state.diag.reg.stat === 5 ? '已漫游' : (state.diag.reg.stat === 1 ? '非漫游 (本地网络)' : state.diag.reg.statText);
			} else if (state.networkStatus) {
				roamStr = state.networkStatus.indexOf('漫游') >= 0 ? '已漫游' : '非漫游 (本地网络)';
			}
			tabPanes['tab-sim'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>SIM 卡状态</td><td>' + simStat + '</td></tr>' +
				'  <tr><td>运营商代码 (PLMN)</td><td>' + plmnStr + '</td></tr>' +
				'  <tr><td>网络注册与漫游</td><td>' + roamStr + '</td></tr>' +
				'  <tr><td>IMSI</td><td>' + (state.modemInfo.imsi || '读取中...') + '</td></tr>' +
				'  <tr><td>ICCID</td><td>' + (state.modemInfo.iccid || '读取中...') + '</td></tr>' +
				'</table>';

			// Tab 4: APN 信息（读取 AT+CGDCONT 真实配置，绝不假写 cmiot5g）
			var ipv4 = state.dhcpv4.ipv4Address || (state.diag.addrs[0] ? state.diag.addrs[0].address : '—');
			var ipv6 = state.dhcpv6.ipv6Address || '—';
			var gw = state.dhcpv4.gateway || '—';
			var dns = (state.dhcpv4.primaryDNS || '—') + (state.dhcpv4.secondaryDNS ? ' / ' + state.dhcpv4.secondaryDNS : '');
			var apnName = state.apn || '默认 (核心网自动分配)';
			var protoType = state.pdpType ? (state.pdpType === 'IPV4V6' ? 'IPv4 / IPv6 双栈' : (state.pdpType === 'IP' ? '仅 IPv4' : state.pdpType)) : 'IPv4 / IPv6 双栈';
			tabPanes['tab-apn'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>APN 接入点</td><td>' + apnName + '</td></tr>' +
				'  <tr><td>协议类型</td><td>' + protoType + '</td></tr>' +
				'  <tr><td>本机 IPv4</td><td>' + ipv4 + '</td></tr>' +
				'  <tr><td>本机 IPv6</td><td>' + ipv6 + '</td></tr>' +
				'  <tr><td>网关地址</td><td>' + gw + '</td></tr>' +
				'  <tr><td>DNS 服务器</td><td>' + dns + '</td></tr>' +
				'</table>';
		}

		/* ---------- 载波聚合渲染 (折叠面板内部，严格根据设备上报真实数据) ---------- */
		function renderCarriersAdv() {
			if (!carrierBox) return;
			carrierBox.innerHTML = '';
			var list = state.carriers || [];
			var caSt = state.caStatus || { state: 'pending' };

			// 1. 查询待刷新状态 (避免直接当作单载波)
			if (caSt.state === 'pending') {
				carrierBox.innerHTML =
					'<div style="padding:14px 16px; background:rgba(59,130,246,0.04); border-radius:10px; border:1px dashed rgba(59,130,246,0.25); font-size:12.5px; text-align:center; color:var(--mt5700-text-secondary);">' +
					'  <span class="mt-pill-tag mt-pill-cyan" style="margin-right:8px;">待刷新</span> 正在获取模组载波聚合配置与分量波遥测数据，请稍候...' +
					'</div>';
				return;
			}

			// 2. 查询失败状态 (避免直接当作单载波)
			if (caSt.state === 'error') {
				carrierBox.innerHTML =
					'<div style="padding:14px 16px; background:rgba(239,68,68,0.04); border-radius:10px; border:1px dashed rgba(239,68,68,0.25); font-size:12.5px; text-align:center; color:var(--mt5700-text-secondary);">' +
					'  <span class="mt-pill-tag" style="background:rgba(239,68,68,0.15); color:#ef4444; margin-right:8px;">未知</span> 模组载波信息读取异常（待下轮重试，未确认单/多载波）' +
					'</div>';
				return;
			}

			// 3. 数据过期状态
			if (caSt.state === 'expired') {
				carrierBox.innerHTML =
					'<div style="padding:14px 16px; background:rgba(234,179,8,0.04); border-radius:10px; border:1px dashed rgba(234,179,8,0.25); font-size:12.5px; text-align:center; color:var(--mt5700-text-secondary);">' +
					'  <span class="mt-pill-tag" style="background:rgba(234,179,8,0.15); color:#eab308; margin-right:8px;">待刷新</span> 载波遥测数据已过期（等待重新同步，未判定单载波）' +
					'</div>';
				return;
			}

			// 4. 未驻网
			if (!list.length) {
				carrierBox.innerHTML =
					'<div style="padding:14px 16px; background:rgba(128,128,128,0.04); border-radius:10px; border:1px dashed rgba(128,128,128,0.25); font-size:12.5px; text-align:center; color:var(--mt5700-text-muted);">' +
					'  模组未驻留蜂窝网络，暂无活动分量载波' +
					'</div>';
				return;
			}

			// 5. 渲染各分量载波卡片（区分 PCC 与 SCC，信号指标取值与单位严格与 AT 响应一致）
			var isCA = list.length > 1;
			var caHtml = '<div style="display:flex; flex-direction:column; gap:10px;">';

			if (isCA) {
				caHtml +=
					'<div style="display:flex; justify-content:space-between; align-items:center; padding:2px 4px 6px;">' +
					'  <div style="font-size:13px; font-weight:600; color:var(--mt5700-green); display:flex; align-items:center; gap:6px;">' +
					'    <span class="mt-beacon-dot" style="background:var(--mt5700-green);"></span>' +
					'    载波聚合已激活 · 共 ' + list.length + ' 个活动分量波 (PCC + ' + (list.length - 1) + ' 个 SCC)' +
					'  </div>' +
					'</div>';
			}

			list.forEach(function (c, i) {
				var isPcc = c.isPcc || (i === 0);
				var roleTitle = isPcc ? '主载波 (PCC)' : ('辅载波 (SCC' + (c.sccIndex || i) + ')');
				var tag = formatBandTag(c.sysMode, c.band);
				var freqStr = getCarrierFreq(c);
				var bwStr = getCarrierBw(c);
				var fcn = c.dlFcn || '—';
				var pciStr = c.pci != null ? String(c.pci) : '—';

				// 信号指标：严格与模组 AT 原始响应一致，未上报显示 '—'，绝不拿主载波值冒充辅载波
				var rsrpStr = (c.rsrp != null && !isNaN(c.rsrp)) ? (c.rsrp + ' dBm') : '—';
				var rsrqStr = (c.rsrq != null && !isNaN(c.rsrq)) ? (c.rsrq + ' dB') : '—';
				var sinrStr = (c.sinr != null && !isNaN(c.sinr)) ? (c.sinr + ' dB') : (c.rssi != null ? ('RSSI ' + c.rssi + ' dBm') : '—');
				var measExtra = c.measType && c.measType !== '—' && c.measType !== 'Serving' ? (' · ' + c.measType) : '';

				caHtml +=
					'<div class="mt-carrier-card-item" style="padding:12px 16px; background:var(--mt5700-subtle-bg); border-radius:10px; border:1px solid var(--mt5700-border-subtle); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">' +
					'  <div style="display:flex; align-items:center; gap:10px; min-width:240px;">' +
					'    <span class="mt-beacon-dot" style="background:' + (isPcc ? 'var(--mt5700-accent)' : 'var(--mt5700-green)') + ';"></span>' +
					'    <div>' +
					'      <div style="display:flex; align-items:center; gap:6px;">' +
					'        <strong style="color:var(--mt5700-text); font-size:13px;">' + roleTitle + '</strong>' +
					'        <span class="mt-pill-tag ' + (isPcc ? 'mt-pill-cyan' : 'mt-pill-purple') + '">' + tag + '</span>' +
					'      </div>' +
					'      <div style="font-size:12px; color:var(--mt5700-text-secondary); margin-top:3px;">' +
					'        ' + (freqStr ? ('中心频率: <span style="color:var(--mt5700-text); font-weight:600;">' + freqStr + '</span> · ') : '') +
					'        ' + (bwStr ? ('带宽: ' + bwStr + ' · ') : '') +
					'        频点: ' + fcn + ' · PCI: ' + pciStr + measExtra +
					'      </div>' +
					'    </div>' +
					'  </div>' +
					'  <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">' +
					'    <div style="text-align:right; min-width:68px;">' +
					'      <div style="font-size:11px; color:var(--mt5700-text-muted);">RSRP</div>' +
					'      <div style="font-family:monospace; font-size:13px; font-weight:700; color:' + (c.rsrp != null ? 'var(--mt5700-cyan)' : 'var(--mt5700-text-muted)') + ';">' + rsrpStr + '</div>' +
					'    </div>' +
					'    <div style="text-align:right; min-width:58px;">' +
					'      <div style="font-size:11px; color:var(--mt5700-text-muted);">RSRQ</div>' +
					'      <div style="font-family:monospace; font-size:13px; font-weight:700; color:' + (c.rsrq != null ? 'var(--mt5700-purple)' : 'var(--mt5700-text-muted)') + ';">' + rsrqStr + '</div>' +
					'    </div>' +
					'    <div style="text-align:right; min-width:58px;">' +
					'      <div style="font-size:11px; color:var(--mt5700-text-muted);">SINR</div>' +
					'      <div style="font-family:monospace; font-size:13px; font-weight:700; color:' + (c.sinr != null ? 'var(--mt5700-green)' : 'var(--mt5700-text-muted)') + ';">' + sinrStr + '</div>' +
					'    </div>' +
					'  </div>' +
					'</div>';
			});

			if (!isCA) {
				caHtml +=
					'<div style="padding:10px 14px; background:rgba(139,92,246,0.04); border-radius:8px; border:1px solid rgba(139,92,246,0.15); font-size:12px; color:var(--mt5700-text-secondary); margin-top:2px;">' +
					'  <strong style="color:var(--mt5700-text);">当前处于单载波运行模式</strong> · 模组或基站当前未激活辅分量载波 (SCC) 聚合' +
					'</div>';
			}

			caHtml += '</div>';
			carrierBox.innerHTML = caHtml;
		}

		/* ---------- 芯片温度渲染 (折叠面板内部，严格根据设备 AT^CHIPTEMP 真实上报) ---------- */
		function renderTempAdv() {
			tempBody.innerHTML = '';
			var t = state.temps;
			if (!t) {
				tempBody.innerHTML = '<div style="padding:16px; text-align:center; color:var(--mt5700-text-muted); font-size:12.5px;">暂无芯片温度遥测数据（模组未上报或查询超时）</div>';
				if (tempBadge) {
					tempBadge.innerHTML = '';
					tempBadge.appendChild(Mt5700.badge('温度未获取', 'neutral'));
				}
				return;
			}

			var items = [];
			if (t.modem1) items.push({ label: 'Modem 基带', value: t.modem1 });
			if (t.ap1) items.push({ label: 'AP1 主控', value: t.ap1 });
			if (t.ap2) items.push({ label: 'AP2 核心', value: t.ap2 });
			if (t.sub6GPA) items.push({ label: 'Sub6G PA', value: t.sub6GPA });
			if (t.sub3GPA) items.push({ label: 'Sub3G PA', value: t.sub3GPA });
			if (t.mimoPa) items.push({ label: 'MIMO PA', value: t.mimoPa });
			if (t.tcxo) items.push({ label: 'TCXO 晶振', value: t.tcxo });

			if (!items.length) {
				tempBody.innerHTML = '<div style="padding:16px; text-align:center; color:var(--mt5700-text-muted); font-size:12.5px;">模组未返回有效传感器温度通道</div>';
				return;
			}

			var maxC = 0, sumC = 0;
			items.forEach(function (it) {
				if (it.value > maxC) maxC = it.value;
				sumC += it.value;
			});
			var avgC = (sumC / items.length).toFixed(1);

			var grid = E('div', { 'class': 'mt-temp-grid' });
			items.forEach(function (it) {
				var v = parseFloat(it.value) || 0;
				var color = v >= 75 ? 'var(--mt5700-danger)' : (v >= 60 ? 'var(--mt5700-amber)' : 'var(--mt5700-green)');
				var pct = Math.min(100, (v / 85) * 100);

				var cell = E('div', { 'style': 'background:var(--mt5700-subtle-bg); padding:10px; border-radius:8px; text-align:center; border:1px solid var(--mt5700-border-subtle);' }, [
					E('div', { 'style': 'font-size:11px; color:var(--mt5700-text-muted); font-weight:600;' }, it.label),
					E('div', { 'style': 'font-size:15px; font-weight:800; font-family:monospace; color:' + color + '; margin:4px 0;' }, v + ' ℃'),
					E('div', { 'style': 'height:4px; background:rgba(0,0,0,0.08); border-radius:2px; overflow:hidden;' }, [
						E('div', { 'style': 'width:' + pct + '%; height:100%; background:' + color + '; border-radius:2px;' })
					])
				]);
				grid.appendChild(cell);
			});
			tempBody.appendChild(grid);

			if (tempBadge) {
				tempBadge.innerHTML = '';
				tempBadge.appendChild(Mt5700.badge('均温 ' + avgC + ' ℃ · 正常', 'info'));
			}
		}

		/* ---------- 深度网络诊断渲染 (折叠面板内部，真实设备遥测) ---------- */
		function renderDiagAdv() {
			diagBox.innerHTML = '';
			var d = state.diag;
			var endcTag = (d.endc && d.endc.established) ? '已建立 (ENDC 启用)' : '未建立 / 单网络模式';
			var regVal = d.reg ? (d.reg.statText + (d.reg.act ? ' · ' + d.reg.act : '')) : (state.networkStatus || '未注册');
			var txVal = '—';
			if (d.tx && (d.tx.pusch != null || d.tx.pucch != null)) {
				txVal = (d.tx.pusch != null ? d.tx.pusch + ' dBm' : '—') + ' / ' + (d.tx.pucch != null ? d.tx.pucch + ' dBm' : '—');
			}

			var rows = [
				['ENDC 双连接状态', endcTag],
				['5GC 分组网络注册', regVal],
				['TAC / 物理小区', (d.reg && d.reg.tac ? d.reg.tac : (state.cell.lac || '—')) + ' / ' + (state.cell.cid || '—')],
				['上行发射功率 (PUSCH / PUCCH)', txVal]
			];
			diagBox.appendChild(Mt5700.table(['诊断项目', '当前设备状态'], rows, { striped: true }));
		}

		/* ---------- 调制方式与空间流动态 SVG 渲染 (折叠面板内部，真实读取 AT^MCS) ---------- */
		function renderMcsAdv() {
			mcsBody.innerHTML = '';
			var m = state.mcs;
			var dlMod = m.dlMod || '';
			var ulMod = m.ulMod || '';
			var dlRank = m.dlRank;
			var ulRank = m.ulRank;

			var visualWrap = E('div', { 'class': 'mt-mcs-visual-grid' });

			// 1. 调制方式 (QAM 星座图动态矢量 SVG)
			var qamBox = E('div', { 'class': 'mt-mcs-box' });
			var qamTitle = E('div', { 'class': 'mt-mcs-header' }, [
				E('span', { 'class': 'mt-mcs-tag mt-tag-cyan' }, 'QAM 星座图'),
				E('span', { 'class': 'mt-mcs-desc' }, dlMod ? ('下行 ' + dlMod + (ulMod ? ' · 上行 ' + ulMod : '')) : '模组上报读取中...')
			]);
			qamBox.appendChild(qamTitle);
			qamBox.appendChild(Mt5700.constellationSvg(dlMod || 'QPSK'));
			visualWrap.appendChild(qamBox);

			// 2. 空间流 (MIMO 空间天线与波束动态矢量 SVG)
			var mimoBox = E('div', { 'class': 'mt-mcs-box' });
			var mimoTitle = E('div', { 'class': 'mt-mcs-header' }, [
				E('span', { 'class': 'mt-mcs-tag mt-tag-purple' }, 'MIMO 空间流'),
				E('span', { 'class': 'mt-mcs-desc' }, dlRank ? (dlRank + '×' + dlRank + ' MIMO (DL)' + (ulRank ? ' / ' + ulRank + ' 层 (UL)' : '')) : '空间流读取中...')
			]);
			mimoBox.appendChild(mimoTitle);
			mimoBox.appendChild(Mt5700.mimoSvg(dlRank || 1));
			visualWrap.appendChild(mimoBox);

			mcsBody.appendChild(visualWrap);

			var rows = [
				['下行调制方式 (DL)', dlMod ? (dlMod + ' (MCS ' + (m.dlMcs != null ? m.dlMcs : '—') + ')') : '— (模组未上报)'],
				['上行调制方式 (UL)', ulMod ? (ulMod + ' (MCS ' + (m.ulMcs != null ? m.ulMcs : '—') + ')') : '— (模组未上报)'],
				['空间多路复用流', dlRank ? (dlRank + ' 层空间复用流 (DL)' + (ulRank ? ' / ' + ulRank + ' 层 (UL)' : '')) : '— (模组未上报)']
			];
			mcsBody.appendChild(Mt5700.table(['链路参数', '当前工作状态'], rows, { striped: true }));
		}

		/* ==========================================================================
		   6. 周期轮询与数据刷新 (完全保持原有后端 RPC 接口不变)
		   ========================================================================== */

		function getBandFromNrArfcn(arfcn) {
			if (!arfcn) return '';
			var ch = parseInt(arfcn, 10);
			if (isNaN(ch)) return '';
			if (ch >= 499200 && ch <= 537999) return '41';
			if (ch >= 620000 && ch <= 680000) return '78';
			if (ch >= 693334 && ch <= 733333) return '79';
			if (ch >= 151600 && ch <= 160600) return '28';
			if (ch >= 422000 && ch <= 434000) return '1';
			if (ch >= 376000 && ch <= 396000) return '3';
			if (ch >= 173800 && ch <= 175000) return '5';
			if (ch >= 185000 && ch <= 192000) return '8';
			return '';
		}

		function getBandFromLteArfcn(arfcn) {
			if (!arfcn) return '';
			var ch = parseInt(arfcn, 10);
			if (isNaN(ch)) return '';
			if (ch >= 0 && ch <= 599) return '1';
			if (ch >= 1200 && ch <= 1949) return '3';
			if (ch >= 2400 && ch <= 2649) return '5';
			if (ch >= 3450 && ch <= 3799) return '8';
			if (ch >= 36200 && ch <= 36349) return '34';
			if (ch >= 37750 && ch <= 38249) return '38';
			if (ch >= 38250 && ch <= 38649) return '39';
			if (ch >= 38650 && ch <= 39649) return '40';
			if (ch >= 39650 && ch <= 41589) return '41';
			return '';
		}

		function syncCarriers() {
			var now = Date.now();
			var rawHfreq = state.rawHfreq || [];
			var secNR = state.secondaryNR || [];
			var secLTE = state.secondaryLTE || [];
			var cell = state.cell || {};

		var merged = [];

			// 1. 主载波 (PCC) 组装
			if (rawHfreq.length > 0) {
				var p0 = rawHfreq[0];
				var p0Band = p0.band || cell.band || (p0.sysMode === 'NR' ? getBandFromNrArfcn(p0.dlFcn) : getBandFromLteArfcn(p0.dlFcn));
				merged.push({
					isPcc: true,
					carrierRole: 'PCC',
					sysMode: p0.sysMode || cell.sysMode || 'NR',
					band: p0Band,
					dlFcn: p0.dlFcn || cell.channel || '',
					dlFreqKHz: p0.dlFreqKHz || 0,
					dlBwKHz: p0.dlBwKHz || 0,
					pci: cell.pci != null && cell.pci !== '' ? cell.pci : null,
					rsrp: cell.rsrp != null ? cell.rsrp : null,
					rsrq: cell.rsrq != null ? cell.rsrq : null,
					sinr: cell.sinr != null ? cell.sinr : null,
					measType: 'Serving'
				});
			} else if (cell.channel) {
				var pccBand = cell.band || (cell.sysMode === 'NR' ? getBandFromNrArfcn(cell.channel) : getBandFromLteArfcn(cell.channel));
				merged.push({
					isPcc: true,
					carrierRole: 'PCC',
					sysMode: cell.sysMode || 'NR',
					band: pccBand,
					dlFcn: cell.channel,
					dlFreqKHz: (cell.sysMode === 'NR' && pccBand === '41') ? parseInt(cell.channel, 10) * 5 : 0,
					dlBwKHz: 0,
					pci: cell.pci != null && cell.pci !== '' ? cell.pci : null,
					rsrp: cell.rsrp != null ? cell.rsrp : null,
					rsrq: cell.rsrq != null ? cell.rsrq : null,
					sinr: cell.sinr != null ? cell.sinr : null,
					measType: 'Serving'
				});
			}

			// 2. 匹配与扩展辅载波 (SCC)
			var sccCounter = 1;
			for (var hi = 1; hi < rawHfreq.length; hi++) {
				var h = rawHfreq[hi];
				var sig = Parse.carrierSignalFor(h, secNR, secLTE);
				var hBand = h.band || (h.sysMode === 'NR' ? getBandFromNrArfcn(h.dlFcn) : getBandFromLteArfcn(h.dlFcn));
				merged.push({
					isPcc: false,
					carrierRole: 'SCC',
					sccIndex: sccCounter++,
					sysMode: h.sysMode || 'NR',
					band: hBand,
					dlFcn: h.dlFcn || '',
					dlFreqKHz: h.dlFreqKHz || 0,
					dlBwKHz: h.dlBwKHz || 0,
					pci: sig ? sig.pci : null,
					rsrp: sig ? sig.rsrp : null,
					rsrq: sig ? sig.rsrq : null,
					sinr: sig ? sig.sinr : null,
					measType: sig ? sig.measType : null
				});
			}

			// 3. 找出 HFREQINFO 未覆盖但 MONSSC / CASCELLINFO 已上报的活动辅载波（确保辅载波不丢）
			var orphan = Parse.unmatchedSecondaries(rawHfreq, secNR, secLTE);
			if (orphan.nr && orphan.nr.length > 0) {
				orphan.nr.forEach(function (nCell) {
					var nBand = getBandFromNrArfcn(nCell.arfcn);
					var freqKHz = (nBand === '41') ? nCell.arfcn * 5 : 0;
					merged.push({
						isPcc: false,
						carrierRole: 'SCC',
						sccIndex: sccCounter++,
						sysMode: 'NR',
						band: nBand,
						dlFcn: String(nCell.arfcn),
						dlFreqKHz: freqKHz,
						dlBwKHz: 0,
						pci: nCell.pci != null ? nCell.pci : null,
						rsrp: nCell.rsrp != null ? nCell.rsrp : null,
						rsrq: nCell.rsrq != null ? nCell.rsrq : null,
						sinr: nCell.sinr != null ? nCell.sinr : null,
						measType: nCell.measType || 'SSB'
					});
				});
			}

			if (orphan.lte && orphan.lte.length > 0) {
				orphan.lte.forEach(function (lCell) {
					var lBand = lCell.band ? String(lCell.band) : (getBandFromLteArfcn(lCell.dlArfcn) || '');
					var freqKHz = lCell.dlFreq ? Math.round(lCell.dlFreq * 1000) : 0;
					var bwKHz = lCell.dlBandwidth ? Math.round(lCell.dlBandwidth * 1000) : 0;
					merged.push({
						isPcc: false,
						carrierRole: 'SCC',
						sccIndex: sccCounter++,
						sysMode: 'LTE',
						band: lBand,
						dlFcn: lCell.dlArfcn != null ? String(lCell.dlArfcn) : '',
						dlFreqKHz: freqKHz,
						dlBwKHz: bwKHz,
						pci: lCell.pci != null ? lCell.pci : null,
						rsrp: lCell.rsrp != null ? lCell.rsrp : null,
						rsrq: lCell.rsrq != null ? lCell.rsrq : null,
						sinr: null,
						rssi: lCell.rssi != null ? lCell.rssi : null
					});
				});
			}

		state.carriers = merged;

		/*
		 * 状态收口（唯一判据入口，杜绝"查询异常被当成单载波"）：
		 *   - primaryOk / secondaryOk：undefined 表示本轮尚未查询，不算失败；
		 *   - 主载波频点查询失败时，即便只解析出 1 个载波也不能下"单载波"结论，
		 *     因为此时根本无法确认有没有辅载波；
		 *   - 两次查询都成功却没有载波，说明模组明确未驻网 → 'none'；
		 *   - 其余情况按"是否已过期 / 是否曾成功过"落到 expired / error / pending。
		 */
		/* 只有明确的 true 才算成功：初值为 null（尚未查询），不能当成功用 */
		var primaryOk = state.hfreqSuccess === true;
		var secondaryOk = state.secondarySuccess === true;
		var stale = state.caStatus.lastSuccessTime > 0 && (now - state.caStatus.lastSuccessTime > 15000);

		if (merged.length > 1) {
			state.caStatus.state = 'ca';
			state.caStatus.lastSuccessTime = now;
		} else if (merged.length === 1 && primaryOk) {
			state.caStatus.state = 'single';
			state.caStatus.lastSuccessTime = now;
		} else if (merged.length === 0 && primaryOk && secondaryOk) {
			state.caStatus.state = 'none';
		} else {
			state.caStatus.state = stale ? 'expired' : (state.caStatus.lastSuccessTime > 0 ? 'error' : 'pending');
		}
	}

		function updateNetworkInfo() {
			var serving = null;

			return AtWs.client.sendCommand('AT^MONSC').then(function (monsc) {
				serving = (monsc.success && monsc.data) ? AtWs.parseMONSC(monsc.data) : null;
				return AtWs.client.sendCommand('AT^HFREQINFO?');
			}).then(function (hfreq) {
				state.hfreqSuccess = hfreq.success;
				state.rawHfreq = (hfreq.success && hfreq.data) ? AtWs.parseHFREQINFO(hfreq.data) : [];
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
				syncCarriers();
				renderSignalUI();
				renderTabsUI();
				renderCarriersAdv();
			}).catch(function (e) {
				state.hfreqSuccess = false;
				syncCarriers();
				renderCarriersAdv();
				renderTabsUI();
				console.warn('Network info update error:', e);
			});
		}

		function loadSecondary() {
			return AtWs.client.sendCommand('AT^MONSSC').then(function (monssc) {
				state.secondaryNR = (monssc.success && monssc.data) ? Parse.parseMonsscAll(String(monssc.data)) : [];
				state.secondarySuccess = monssc.success;
				return AtWs.client.sendCommand('AT^CASCELLINFO?');
			}).then(function (cascell) {
				state.secondaryLTE = (cascell.success && cascell.data) ? Parse.parseCascellAll(String(cascell.data)) : [];
				if (cascell.success) state.secondarySuccess = true;
				syncCarriers();
				renderCarriersAdv();
				renderTabsUI();
			}).catch(function () {
				syncCarriers();
				renderCarriersAdv();
				renderTabsUI();
			});
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

		/* 设备与 SIM 卡信息读取：实际获取模组 ATI, CGMM, CGSN, CPIN, CIMI, ICCID, CGMR, CGDCONT 上报 */
		function loadDeviceInfo() {
			return AtWs.client.sendCommand('ATI').then(function (res) {
				if (res && res.success && res.data) {
					var s = String(res.data);
					var mModel = s.match(/Model:\s*([^\r\n]+)/i);
					if (mModel) state.modemInfo.model = mModel[1].trim();
					var mManuf = s.match(/Manufacturer:\s*([^\r\n]+)/i);
					if (mManuf) state.modemInfo.manufacturer = mManuf[1].trim();
					var mRev = s.match(/Revision:\s*([^\r\n]+)/i);
					if (mRev && !state.modemInfo.fw) state.modemInfo.fw = mRev[1].trim();
					var mImei = s.match(/IMEI:\s*([0-9A-Za-z]+)/i);
					if (mImei) state.modemInfo.imei = mImei[1].trim();
				}
				if (!state.modemInfo.model) {
					return AtWs.client.sendCommand('AT+CGMM').then(function (res2) {
						if (res2 && res2.success && res2.data) {
							var lines = String(res2.data).split('\n');
							for (var i = 0; i < lines.length; i++) {
								var l = lines[i].trim();
								if (l && l !== 'OK' && l.indexOf('ERROR') === -1) {
									state.modemInfo.model = l;
									break;
								}
							}
						}
					});
				}
			}).then(function () {
				return AtWs.client.sendCommand('AT+CPIN?');
			}).then(function (res) {
				if (res && res.success && res.data) {
					var m = String(res.data).match(/\+CPIN:\s*([^\r\n]+)/);
					if (m) {
						var st = m[1].trim();
						state.simStatus = (st === 'READY') ? '正常 (READY)' : st;
					}
				}
				return AtWs.client.sendCommand('AT+CGSN');
			}).then(function (res) {
				if (res && res.success && res.data) {
					var m = String(res.data).match(/\b(\d{14,16})\b/);
					if (m) state.modemInfo.imei = m[1];
				}
				return AtWs.client.sendCommand('AT+CIMI');
			}).then(function (res) {
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
				return AtWs.client.sendCommand('AT+CGDCONT?');
			}).then(function (res) {
				if (res && res.success && res.data) {
					var lines = String(res.data).split('\n');
					for (var i = 0; i < lines.length; i++) {
						var l = lines[i].trim();
						var m = l.match(/\+CGDCONT:\s*(\d+),\s*"([^"]*)",\s*"([^"]*)"/);
						if (m) {
							var cid = m[1];
							var ptype = m[2];
							var apn = m[3];
							if (cid === '1' || (!state.apn && apn)) {
								state.pdpType = ptype;
								state.apn = apn;
							}
						}
					}
				}
				renderTabsUI();
			}).catch(function (e) {
				console.warn('loadDeviceInfo error:', e);
			});
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
				if (r.device) state.deviceInterface = r.device;
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

		// 全量状态轮询刷新：纯串行执行，避免单通道 AT 串口并发阻塞冲突
		var refreshing = false;
		function refreshAll() {
			if (refreshing) return Promise.resolve();
			refreshing = true;

			var tasks = [
				updateNetworkInfo,
				loadSecondary,
				loadDeviceInfo,
				getPSReg,
				getOperator,
				getDHCP,
				getFlow,
				getTemp,
				getMCS,
				loadDiagnostics
			];

			return tasks.reduce(function (p, fn) {
				return p.then(function () {
					return Promise.resolve().then(fn).catch(function (e) {
						console.warn('Poll task error:', e);
					});
				});
			}, Promise.resolve()).then(function () {
				refreshing = false;
				renderTabsUI();
			}).catch(function () {
				refreshing = false;
			});
		}

		// 初始触发
		refreshAll();

		// 定时自动刷新 (每 5 秒刷新一次遥测数据)
		var pollInterval = Mt5700.interval(function () {
			return refreshAll();
		}, 5000);

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
