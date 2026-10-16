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
/* global L, AtWs, Parse, Mt5700 */

	/*
	 * 网络状态卡的信号发射塔图标（用户指定图形，1024×1024 视口）。
	 * 颜色统一走 currentColor，由 renderSignalUI 按真实网络状态动态切换，
	 * 与四格信号图标、状态药丸保持同一套配色，不再写死颜色。
	 */
	var BROADCAST_TOWER_PATHS = [
		'M531.131544 281.055965c11.863291-6.054469 20.424802-18.134507 20.424802-33.010584 0-19.601163-17.953885-35.279203-37.901843-35.279203s-37.901843 15.67804-37.901843 35.279203c0 14.883301 8.56151 26.956114 20.424802 33.010584-5.6282 21.168967-32.447041 122.050292-160.270031 602.896509-1.878475 7.557249 1.878475 17.007422 9.406824 20.786047l71.40372 32.027996c-0.180623 1.444981-0.288996 2.911636-0.288996 4.407191 0 20.020207 16.971298 36.254565 37.901843 36.254565 20.930545 0 37.901843-16.234358 37.901842-36.254565s-16.971298-36.254565-37.901842-36.254565c-6.206192 0-12.058364 1.437756-17.231395 3.966472-11.465922-5.519826-27.844777-13.402196-51.267914-24.68027 16.740101-9.992041 52.228826-31.168233 127.41117-76.034882 32.345892 19.44944 74.127508 44.570429 128.097537 77.017469l-50.588774 24.398499c-5.736573-2.969435-12.354585-4.674512-19.413315-4.674513-21.840883 0-39.549121 16.234358-39.549121 36.254565s17.708238 36.254565 39.549121 36.254565 39.549121-16.234358 39.549121-36.254565c0-1.076511-0.057799-2.138571-0.158948-3.186182 15.562442-7.261028 38.234188-17.838286 71.273672-33.249005 7.521124-3.778624 11.285299-13.228798 9.406824-20.786047-0.007225 0.01445-0.01445 0.007225-160.277256-602.889284z m-69.366297 263.875144c5.20193 3.576327 14.673779 10.100415 31.919623 21.963707-12.260661 8.503711-27.432958 19.02317-46.210482 32.035221 4.47944-16.949623 9.240651-34.925183 14.290859-53.998928z m16.111535-60.877035c4.255468 2.96221 9.789744 6.827534 17.000197 11.856066-7.246578 5.071882-15.446843 10.808455-24.709169 17.289194 2.499817-9.464623 5.071882-19.174893 7.708972-29.14526z m67.256625-23.307538l-31.486129 22.02873c-8.626535-6.032794-18.524652-12.961477-29.89665-20.916095 9.450174-35.683798 19.702311-74.423729 30.835887-116.494342 0 0 0.007225 0 30.546892 115.381707zM533.197866 567.183812c9.963142-6.856433 21.219541-14.60153 33.928146-23.350888 4.696187 17.729913 9.811419 37.049304 15.374595 58.095448-9.392374-6.618011-24.622471-17.354218-49.302741-34.74456z m37.901843 53.001891s-0.007225 0-57.452431 34.845708c-16.566703-10.049841-35.589874-21.588011-57.452431-34.845708 0 0 0.007225 0 57.452431-39.541896 14.97 10.302712 33.790873 23.249739 57.452431 39.541896z m-57.705303-66.960405c-9.385149-6.618011-19.81791-13.965738-31.413879-22.137103 0 0 0.007225-0.007225 31.673976-22.08653 8.886631 6.198967 19.341066 13.488895 31.673976 22.08653-0.007225 0.007225-0.007225 0.007225-31.934073 22.137103z m46.051534-38.407586c-5.837722-4.08207-14.413682-10.085965-27.021138-18.907572 5.555951-3.879773 11.733243-8.185815 18.582451-12.961476 2.62264 9.890893 5.433127 20.504276 8.438687 31.869048zM437.569046 636.326137c7.766771 4.674512 23.16304 13.944063 53.659357 32.302542l-74.105834 44.946124c5.960545-22.527249 12.737505-48.139531 20.446477-77.248666z m76.078232 45.798662c21.595236 13.004826 48.746423 29.347557 82.876866 49.895182 0 0-0.007225 0.007225-83.209212 49.237717-23.661558-14.110236-50.978918-30.409618-82.537295-49.237717 0 0 0-0.007225 82.869641-49.895182z m22.4261-13.49612c15.902012-9.572997 34.209917-20.598199 55.277735-33.277904 6.459064 24.412948 13.46722 50.884994 21.067819 79.58231-11.55262-7.008156-33.740299-20.460926-76.345554-46.304406z m-22.4261-432.34544c7.976293 0 13.965738 5.881071 13.965738 11.762142 0 7.83902-5.98222 13.720091-13.965738 13.720092s-13.965738-5.881071-13.965738-13.720092c0-5.881071 5.989445-11.762143 13.965738-11.762142zM378.006943 861.324076c4.428866-16.732876 13.228798-49.967431 30.705839-115.995823 8.94443 5.375328 30.416843 18.28623 81.995428 49.302741-28.928513 17.123021-65.782745 38.935004-112.701267 66.693082z m242.193209-116.985634c9.645246 36.427963 20.164705 76.179381 31.645077 119.5577-15.461293-9.218977-47.908334-28.581718-116.017498-69.207349 24.355149-14.529281 52.301075-31.211582 84.372421-50.350351z',
		'M454.554794 310.685293c5.649874 7.557249 16.949623 7.557249 22.599497 0 7.535574-7.557249 7.535574-17.000198 0-24.557446-11.299749-9.442949-16.949623-22.671747-16.949623-37.786245 0-28.336071 24.485197-51.007818 52.734569-51.007817 28.249372 0 50.84887 22.671747 50.84887 51.007817 0 15.114498-5.649874 28.336071-16.949623 39.671945-7.535574 5.664324-7.535574 17.000198-1.8857 22.671746 3.764175 3.778624 9.414049 5.671549 13.185449 5.671549 3.764175 0 7.535574-1.8857 11.299749-3.778624 16.949623-17.000198 28.249372-39.671944 28.249372-64.229391 0-47.229193-37.670646-85.015438-84.755341-85.015437s-86.633816 37.786244-86.633816 85.015437c0.007225 24.550222 11.306974 47.221968 28.256597 62.336466z',
		'M383.967488 354.041938c1.943499 1.878475 5.830497 3.749725 9.717495 3.749725 5.830497 0 11.660994-1.878475 13.604493-7.49945 5.830497-7.49945 3.886998-18.755849-3.886998-22.505573 0-1.878475-31.103209-22.505574-31.103209-78.765897 0-54.381847 29.15971-75.008946 31.103209-76.887421 7.773996-3.749725 9.717495-14.998899 3.886998-22.505574-3.886998-7.49945-15.547992-9.377925-23.321988-5.6282-1.943499 1.878475-46.651201 30.005024-46.651201 105.01397 0 73.152146 44.707702 105.02842 46.651201 105.02842z',
		'M281.279937 249.027968c0 109.240538 62.155843 152.553834 64.034318 154.439534 3.764175 1.8857 5.649874 3.764175 9.414049 3.764175 5.649874 0 11.299749-3.764175 15.063924-7.535574 3.764175-7.535574 1.8857-18.835323-5.649875-24.485198-1.8857-1.8857-48.970395-35.784946-48.970395-126.190162s47.084695-122.418762 48.970395-124.304462c7.535574-5.649874 9.414049-16.949623 5.649875-24.485197-5.649874-7.535574-16.949623-9.414049-24.485198-3.764175-1.87125 1.8857-64.027093 43.32052-64.027093 152.561059z',
		'M327.815539 421.211865s-68.376485-49.194367-68.376485-172.183897c0-124.882454 64.576186-170.290972 68.376485-172.183896 7.600598-3.785849 9.493523-15.136172 3.800299-22.707871-3.800299-7.571699-15.193972-9.457398-22.79457-5.678774-3.800299 3.785849-83.570457 56.766066-83.570457 200.563316 0 141.911551 79.770158 198.670392 83.570457 200.563317 1.90015 1.892925 5.700449 3.785849 9.493523 3.785849 5.700449 0 11.393673-3.785849 13.293822-7.571698 5.707674-7.557249 3.807524-18.914797-3.793074-24.586346zM620.178478 327.78664c-7.434426 3.749725-9.298451 14.998899-3.720826 22.505573 3.720825 5.6282 7.434426 7.49945 13.012051 7.49945 3.720825 0 7.434426-1.878475 9.298451-3.749725 1.8568 0 44.621003-31.876274 44.621003-105.01397 0-75.008946-42.764203-103.14272-44.621003-105.01397-7.434426-3.749725-16.732876-1.878475-22.310502 5.6282-5.577625 7.49945-3.720825 16.877374 3.720826 22.505574 1.8568 1.878475 29.744927 22.505574 29.744927 76.887421 0 56.245872-27.888127 76.880196-29.744927 78.751447z',
		'M656.555866 124.716281c1.8857 0 48.970395 33.899246 48.970395 124.304462 0 90.405215-47.084695 124.304462-48.970395 126.190162-7.535574 5.649874-9.414049 16.949623-3.764175 24.485198 1.8857 3.764175 7.535574 7.535574 13.185449 7.535574 3.764175 0 7.535574-1.8857 9.414049-3.764175 3.764175-1.8857 64.034318-45.198995 64.034318-154.439534s-62.155843-150.675359-64.034318-152.553834c-7.535574-5.649874-18.835323-3.764175-22.599498 3.764175-5.657099 7.528349-3.7714 18.828098 3.764175 24.477972z',
		'M712.722265 48.457427c-7.82457-3.785849-17.599865-1.892925-23.459262 5.678774-5.866622 7.571699-3.908673 18.922022 3.908673 22.707871 1.957949 1.892925 70.385008 47.301442 70.385008 172.183896 0 122.98953-66.476336 170.290972-70.385008 172.183897-7.82457 5.678774-9.775294 17.029097-3.908673 24.600796 3.908673 3.785849 9.775294 7.571699 13.683967 7.571698s7.82457-1.892925 11.733243-3.785849c1.957949-1.892925 84.0762-58.65899 84.076201-200.563317-0.007225-143.811701-82.125476-196.791917-86.034149-200.577766z',
	];

	/* 网络状态 → 图标配色（与 CELLULAR_UI 同源语义） */
	var TOWER_COLORS = {
		full: 'var(--mt5700-green)',
		strong: 'var(--mt5700-cyan)',
		medium: 'var(--mt5700-amber)',
		weak: 'var(--mt5700-danger)',
		none: 'var(--mt5700-text-muted)',
		searching: 'var(--mt5700-cyan)',
		connecting: 'var(--mt5700-accent)',
		disconnected: 'var(--mt5700-text-muted)',
		error: 'var(--mt5700-danger)'
	};

return L.view.extend({
	render: function () {
		var page = Mt5700.page('MT5700 设备状态', '5G 蜂窝网络 · 射频链路与硬件遥测', 'network_status', '在线');
		var body = page._body;

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
			telemetryError: false,
			caStatus: {
				state: 'pending', // 'pending' | 'single' | 'ca' | 'none' | 'error' | 'expired'
				lastSuccessTime: 0
			},
			carriers: [],
			rtDown: 0,
			rtUp: 0,
			// 本次使用量（由设备侧累计并返回，页面刷新不失效；默认内存、可选落盘）
			usage: null,
			ambrDown: 0,
			ambrUp: 0,
			networkStatus: '检测中...',
			operator: '读取中...',
			apn: '',
			pdpType: '',
			apnCid: '',
			imsApn: '',
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
			// 签约速率（Session-AMBR，来自 AT+C5GQOSRDP=1）
			subRate: null,
			dataBearer: null
		};


		// 信号趋势历史数据 (最多保留 30 个真实采样点，绝不伪造基线)
		var sigHistory = [];
		var MAX_SIG_POINTS = 30;
		// 图表可见序列开关（点选图例切换）与显示范围（点数）
		var chartSeries = { rsrp: true, sinr: true, rsrq: true };
		var chartRange = MAX_SIG_POINTS;
		// 三条曲线的配色（Soft-Anime 调色）
		var CHART_COLORS = { rsrp: '#38bdf8', sinr: '#10b981', rsrq: '#c084fc' };

		// 当前选中的趋势点（按时间戳记录，重绘后据此恢复常显的悬浮卡）
		var trendHoverTime = null;

		/* 收起信号趋势悬浮卡：触摸点选后常显，点图表外或再次点选同一点时收起 */
		function hideTrendHover() {
			var layer = document.getElementById('mt-trend-hover-layer');
			if (layer) layer.style.display = 'none';
			trendHoverTime = null;
		}

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
				E('span', { 'class': 'mt-pill-tag', 'id': 'sig-rat-tag' }, '—')
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
				E('div', { 'class': 'mt-sig-cellular-box', 'id': 'sig-cellular-box' }, [
					Mt5700.cellularSignal()
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
					E('span', { 'class': 'mt-beacon-dot' }),
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
					E('span', { 'class': 'mt-beacon-dot' }),
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
			]),
			// 本次使用量（后端常驻统计：页面关闭/刷新都不影响；可选持久化、可自动清零）
			E('div', { 'class': 'mt-traffic-usage' }, [
				E('div', { 'class': 'mt-usage-head' }, [
					E('span', { 'class': 'mt-usage-title' }, '本次使用量'),
					E('div', { 'class': 'mt-usage-actions' }, [
						E('button', {
							'class': 'mt-usage-btn', 'id': 'usage-persist', 'type': 'button',
							'title': '开启后：使用量写入闪存，重启后依然保留（约每 10 分钟写一次）',
							'click': toggleUsagePersist
						}, '持久化'),
						E('button', {
							'class': 'mt-usage-btn danger', 'id': 'usage-reset', 'type': 'button',
							'title': '清零本次使用量（同时清空闪存里的记录文件）', 'click': resetUsage
						}, '清零')
					])
				]),
				E('div', { 'class': 'mt-usage-grid' }, [
					E('div', { 'class': 'mt-usage-cell' }, [
						E('span', { 'class': 'mt-usage-lbl' }, '下行'),
						E('span', { 'class': 'mt-usage-val', 'id': 'usage-dl' }, '0 B')
					]),
					E('div', { 'class': 'mt-usage-cell' }, [
						E('span', { 'class': 'mt-usage-lbl' }, '上行'),
						E('span', { 'class': 'mt-usage-val', 'id': 'usage-ul' }, '0 B')
					]),
					E('div', { 'class': 'mt-usage-cell' }, [
						E('span', { 'class': 'mt-usage-lbl' }, '合计'),
						E('span', { 'class': 'mt-usage-val total', 'id': 'usage-total' }, '0 B')
					]),
					E('div', { 'class': 'mt-usage-cell' }, [
						E('span', { 'class': 'mt-usage-lbl' }, '累计时长'),
						E('span', { 'class': 'mt-usage-val', 'id': 'usage-dur' }, '00:00:00')
					]),
					E('div', { 'class': 'mt-usage-cell wide' }, [
						E('span', { 'class': 'mt-usage-lbl' }, '峰值速率'),
						E('span', { 'class': 'mt-usage-val', 'id': 'usage-peak' }, '↓0 B/s · ↑0 B/s')
					]),
					E('div', { 'class': 'mt-usage-cell wide auto' }, [
						E('span', { 'class': 'mt-usage-lbl' }, '自动清零'),
						E('span', { 'class': 'mt-usage-auto' }, [
							E('input', {
								'class': 'mt-usage-days', 'id': 'usage-days', 'type': 'number',
								'min': '1', 'max': '3650', 'step': '1', 'value': '30',
								'title': '累计满这么多天就自动清零（1~3650 天）'
							}),
							E('span', { 'class': 'mt-usage-unit' }, '天'),
							E('button', {
								'class': 'mt-usage-btn', 'id': 'usage-days-save', 'type': 'button',
								'title': '保存自动清零天数（写入配置，重启后仍生效）',
								'click': saveUsageAutoResetDays
							}, '保存')
						])
					])
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
		/* 图例开关：点按钮切换对应曲线的显隐 */
		function makeLegendToggle(key, label, dashed) {
			var color = CHART_COLORS[key];
			var lineStyle = dashed
				? 'background:repeating-linear-gradient(90deg,' + color + ' 0 4px,transparent 4px 7px);'
				: 'background:' + color + ';';
			var chip = E('button', {
				'type': 'button',
				'class': 'mt-legend-item mt-legend-btn' + (chartSeries[key] ? ' active' : ''),
				'style': 'color:' + color + ';',
				'click': function () {
					chartSeries[key] = !chartSeries[key];
					chip.classList.toggle('active', chartSeries[key]);
					renderSignalTrendChart();
				}
			}, [
				E('span', { 'class': 'mt-legend-line', 'style': lineStyle }),
				E('span', {}, label)
			]);
			return chip;
		}

		/* 显示范围：最近 15 点 / 全部 30 点 */
		function makeRangeButton(points, label) {
			return E('button', {
				'type': 'button',
				'class': 'mt-range-btn' + (chartRange === points ? ' active' : ''),
				'data-points': String(points),
				'click': function () {
					chartRange = points;
					var all = document.querySelectorAll('.mt-range-btn');
					for (var i = 0; i < all.length; i++) {
						all[i].classList.toggle('active', Number(all[i].getAttribute('data-points')) === points);
					}
					renderSignalTrendChart();
				}
			}, label);
		}

		var chartCard = E('div', { 'class': 'mt-card mt-chart-card' }, [
			E('div', { 'class': 'mt-chart-head' }, [
				E('div', { 'class': 'mt-card-title' }, [
					svgIcon('trend'),
					E('span', {}, '信号趋势')
				]),
				E('div', { 'class': 'mt-chart-controls' }, [
					E('div', { 'class': 'mt-chart-legend' }, [
						makeLegendToggle('rsrp', 'RSRP', false),
						makeLegendToggle('sinr', 'SINR', false),
						makeLegendToggle('rsrq', 'RSRQ', true)
					]),
					E('div', { 'class': 'mt-chart-range', 'title': '显示最近多少个采样点' }, [
						makeRangeButton(15, '15点'),
						makeRangeButton(30, '30点')
					])
				])
			]),
			E('div', { 'class': 'mt-chart-readout', 'id': 'sig-trend-readout' }),
			E('div', { 'class': 'mt-chart-svg-box', 'id': 'sig-trend-chart-box' })
		]);
		midGrid.appendChild(chartCard);

		/* 点击/触摸图表以外的区域时收起趋势悬浮卡（整页仅注册一次） */
		document.addEventListener('pointerdown', function (ev) {
			var b = document.getElementById('sig-trend-chart-box');
			if (b && !b.contains(ev.target)) hideTrendHover();
		}, true);

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

		function createCellularTowerSvg() {
			var wrap = E('div', { 'class': 'mt-tower-svg-box' });
			var svg = '<svg viewBox="0 0 1024 1024" width="72" height="72" fill="currentColor" aria-hidden="true">';
			for (var i = 0; i < BROADCAST_TOWER_PATHS.length; i++) {
				svg += '<path d="' + BROADCAST_TOWER_PATHS[i] + '"></path>';
			}
			svg += '</svg>';
			wrap.innerHTML = svg;
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

		/*
		 * 四格信号图标对应的品质文案与配色（与图标状态同源，避免图标和文字各说各话）
		 */
		var CELLULAR_UI = {
			full: { text: '极佳 · 满格服务', color: 'var(--mt5700-green)', bg: 'var(--mt5700-green-pale)' },
			strong: { text: '良好 · 信号稳定', color: 'var(--mt5700-cyan)', bg: 'var(--mt5700-cyan-pale)' },
			medium: { text: '一般 · 信号稍弱', color: 'var(--mt5700-amber)', bg: 'rgba(245, 158, 11, 0.15)' },
			weak: { text: '较差 · 边缘覆盖', color: 'var(--mt5700-danger)', bg: 'rgba(239, 68, 68, 0.15)' },
			none: { text: '无信号', color: 'var(--mt5700-text-muted)', bg: 'rgba(148, 163, 184, 0.15)' },
			searching: { text: '正在搜索网络', color: 'var(--mt5700-cyan)', bg: 'var(--mt5700-cyan-pale)' },
			connecting: { text: '正在连接网络', color: 'var(--mt5700-accent)', bg: 'var(--mt5700-accent-pale)' },
			disconnected: { text: '网络已断开', color: 'var(--mt5700-text-muted)', bg: 'rgba(148, 163, 184, 0.15)' },
			error: { text: '信号读取异常', color: 'var(--mt5700-danger)', bg: 'rgba(239, 68, 68, 0.15)' }
		};

		/*
		 * 真实数据 → 四格信号图标状态。判定优先级（顺序即语义）：
		 *   1) SIM 未就绪（明确非"正常"且非"检测中"）→ disconnected
		 *   2) **已有 RSRP 读数 → 直接按电平分档**：信号本身正常时绝不显示异常，
		 *      不受 HFREQINFO / HCSQ 等辅助遥测命令偶发失败的影响；
		 *   3) 注册状态：含"未注册" → searching；"注册被拒绝"/"未知" → error；
		 *      空 / 检测中 / 等待状态 → searching；
		 *   4) 已注册但尚无读数：仅当主载波查询明确失败才 → error，
		 *      否则 → connecting（首轮采集中）。
		 */
		function computeCellularState() {
			var c = state.cell || {};
			var raw = c.rsrp;
			var rsrp = (raw !== null && raw !== undefined && raw !== '' && !isNaN(raw)) ? Number(raw) : null;
			var reg = String(state.networkStatus || '');
			var sim = String(state.simStatus || '');

			if (sim !== '' && sim.indexOf('检测中') < 0 && sim.indexOf('正常') < 0) return 'disconnected';

			if (rsrp !== null) {
				if (rsrp >= -80) return 'full';
				if (rsrp >= -95) return 'strong';
				if (rsrp >= -110) return 'medium';
				if (rsrp > -140) return 'weak';
				return 'none';
			}

			if (reg.indexOf('未注册') >= 0) return 'searching';
			if (reg.indexOf('注册被拒绝') >= 0 || reg.indexOf('未知') >= 0) return 'error';
			if (reg === '' || reg.indexOf('检测中') >= 0 || reg.indexOf('等待状态') >= 0) return 'searching';

			return state.hfreqSuccess === false ? 'error' : 'connecting';
		}

		/* 制式角标短文案：NR→5G、LTE→4G、WCDMA→3G、GSM→2G。
		 * 与 Mt5700.normRat 同口径，取不到就返回空，由调用方决定占位。 */
		function ratBadgeText(sysMode) {
			var s = String(sysMode || '').toUpperCase();
			if (!s) return '';
			if (s === 'NR' || s === '7' || s === '11' || s.indexOf('NR') === 0) return '5G';
			if (s.indexOf('LTE') === 0 || s === '6') return '4G';
			if (s.indexOf('WCDMA') === 0 || s === '3') return '3G';
			if (s.indexOf('GSM') === 0 || s === '1') return '2G';
			return s;
		}

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

			/* 信号图标状态与品质文案同源判定，保证图形与文字完全一致 */
			var sigState = computeCellularState();
			var sigUI = CELLULAR_UI[sigState] || CELLULAR_UI.searching;

			var elPill = document.getElementById('sig-quality-pill');
			var elText = document.getElementById('sig-quality-text');
			if (elPill && elText) {
				elPill.style.background = sigUI.bg;
				elPill.style.color = sigUI.color;
				elText.textContent = sigUI.text;
			}

			/* 制式角标与当前驻网制式同源：NR→5G、LTE→4G，不再写死 5G
			 * （原来写死 '5G'，4G 下也显示 5G，与真实制式不符）。 */
			var elRatTag = document.getElementById('sig-rat-tag');
			if (elRatTag) {
				var primCarrier = (state.carriers && state.carriers[0]) || {};
				var ratTxt = ratBadgeText(c.sysMode || primCarrier.sysMode);
				elRatTag.textContent = ratTxt || '—';
			}

			/* 更新四格信号图标（状态取自真实数据） */
			var celBox = document.getElementById('sig-cellular-box');
			var celEl = celBox ? celBox.querySelector('.cellular') : null;
			if (celEl && typeof celEl.setCellularState === 'function') celEl.setCellularState(sigState);

			/* 信号塔图标配色与状态同源（不再写死紫色） */
			var towerBox = document.querySelector('.mt-tower-svg-box');
			if (towerBox) towerBox.style.color = TOWER_COLORS[sigState] || TOWER_COLORS.searching;


			// 更新趋势历史（只记录设备真实采样；不再用合成数据伪造首屏曲线）
			var now = new Date();
			var timeStr = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());

			var hasRsrp = (rsrp != null && rsrp !== '' && !isNaN(rsrp));
			var numRsrq = (rsrq != null && rsrq !== '' && !isNaN(rsrq)) ? Number(rsrq) : null;
			var numSinr = (sinr != null && sinr !== '' && !isNaN(sinr)) ? Number(sinr) : null;

			/* 每轮轮询落一个点；缺读数写 null，由绘图按断点如实断开，
			   而不是把缺口连成一条并不存在的平滑线。 */
			var sample = {
				time: timeStr,
				rsrp: hasRsrp ? Number(rsrp) : null,
				rsrq: numRsrq,
				sinr: numSinr
			};
			var lastPt = sigHistory[sigHistory.length - 1];
			if (lastPt && lastPt.time === timeStr) {
				sigHistory[sigHistory.length - 1] = sample;   /* 同一秒内重复刷新则覆盖，避免重影 */
			} else {
				sigHistory.push(sample);
				if (sigHistory.length > MAX_SIG_POINTS) sigHistory.shift();
			}
			renderSignalTrendChart();
		}

		/* ==========================================================================
		   信号趋势图（v1.19 重绘）
		   --------------------------------------------------------------------------
		   纯原生 SVG，双 Y 轴（RSRP 左 / SINR 右），避免不同量纲曲线挤在同一坐标系误读：
		     · 左轴 RSRP (dBm, -125 ~ -53)：主曲线 + 面积渐变
		     · 右轴 SINR (dB,  -5  ~ 35) ：副曲线
		     · RSRQ (dB, -20 ~ -3)       ：细虚线（量纲独立，仅作参考，不参与双轴刻度）
		   数据诚实：只画设备真实采样；缺读数写 null，曲线在该处如实断开，
		             绝不合成基线或把缺口连成并不存在的平滑线。
		   交互：图例可点选显隐曲线；范围可切 15/30 点；鼠标悬浮或触摸拖动查看任意点读数。
		   背景按 RSRP 质量分区着色（极佳 / 良好 / 一般 / 较差），一眼可判读链路质量。
		   曲线经 Catmull-Rom → 三次贝塞尔平滑，末端点带呼吸脉冲标记“当前”。
		   ========================================================================== */

		/* RSRP 质量分区（阈值与 computeCellularState 的分档保持一致） */
		/* 档位中文名（用于悬浮数据卡的“质量”字段；图内不再绘制档位文字） */
		var SIGNAL_TIERS = [
			{ label: '较差', min: -125, max: -110, color: '#ef4444' },
			{ label: '一般', min: -110, max: -95, color: '#f59e0b' },
			{ label: '良好', min: -95, max: -80, color: '#0ea5e9' },
			{ label: '极佳', min: -80, max: -53, color: '#10b981' }
		];

		/* RSRP → 质量分区下标；无有效读数返回 -1 */
		function signalTierIndex(rsrp) {
			if (rsrp === null || rsrp === undefined || rsrp === '' || isNaN(rsrp)) return -1;
			var v = Number(rsrp);
			for (var i = 0; i < SIGNAL_TIERS.length; i++) {
				if (v >= SIGNAL_TIERS[i].min && v < SIGNAL_TIERS[i].max) return i;
			}
			return v >= SIGNAL_TIERS[SIGNAL_TIERS.length - 1].max ? SIGNAL_TIERS.length - 1 : 0;
		}

		/* 折线点集 → 平滑路径（Catmull-Rom 转三次贝塞尔），y 超出绘图区时钳制 */
		function smoothPathPoints(pts, top, bottom) {
			if (!pts || !pts.length) return '';
			function clampY(y) { return Math.max(top, Math.min(bottom, y)); }
			var d = 'M ' + pts[0][0].toFixed(1) + ' ' + clampY(pts[0][1]).toFixed(1);
			for (var i = 0; i < pts.length - 1; i++) {
				var p0 = pts[i - 1] || pts[i];
				var p1 = pts[i];
				var p2 = pts[i + 1];
				var p3 = pts[i + 2] || p2;
				var c1x = p1[0] + (p2[0] - p0[0]) / 6;
				var c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
				var c2x = p2[0] - (p3[0] - p1[0]) / 6;
				var c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
				d += ' C ' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ', ' +
					c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ', ' +
					p2[0].toFixed(1) + ' ' + clampY(p2[1]).toFixed(1);
			}
			return d;
		}

		/* 线性映射：值域 [min, max] → 像素 [top, bottom]，越界钳制 */
		function chartScale(value, min, max, top, bottom) {
			var v = Number(value);
			if (!isFinite(v)) v = min;
			if (v < min) v = min;
			if (v > max) v = max;
			return top + (bottom - top) * (1 - (v - min) / (max - min));
		}

		/*
		 * 双轴刻度表：y 为绘图区内相对位置（0 = 顶部），rsrp / sinr 为该位置对应的刻度值。
		 * 值必须与 y 单调一致（自顶向下递减），否则轴标签会与实际位置不符。
		 */
		var CHART_TICKS = [
			{ y: 0, rsrp: -53, sinr: 35 },
			{ y: 0.25, rsrp: -71, sinr: 25 },
			{ y: 0.5, rsrp: -89, sinr: 15 },
			{ y: 0.75, rsrp: -107, sinr: 5 },
			{ y: 1, rsrp: -125, sinr: -5 }
		];

		/* 两位补零（时间格式化） */
		function pad2(n) { return (n < 10 ? '0' : '') + n; }

		/*
		 * 取窗口内某序列的连续分段（遇 null / NaN 断开）。
		 * 返回 [[[x, y], ...], ...]：缺口保持缺口，不会被人为连成一条并不存在的平滑线。
		 */
		function seriesSegments(items, key, min, max, top, bottom, padL, chartW) {
			var n = items.length;
			var segs = [];
			var cur = [];
			for (var i = 0; i < n; i++) {
				var v = items[i][key];
				var x = padL + (i / (n - 1)) * chartW;
				if (v === null || v === undefined || v === '' || isNaN(v)) {
					if (cur.length) { segs.push(cur); cur = []; }
				} else {
					cur.push([x, chartScale(Number(v), min, max, top, bottom)]);
				}
			}
			if (cur.length) segs.push(cur);
			return segs;
		}

		/* 顶部读数条：始终展示最新真实读数；被隐藏的序列弱化显示 */
		function updateChartReadout() {
			var el = document.getElementById('sig-trend-readout');
			if (!el) return;
			var last = null;
			for (var i = sigHistory.length - 1; i >= 0; i--) {
				var p = sigHistory[i];
				if (p.rsrp != null || p.sinr != null || p.rsrq != null) { last = p; break; }
			}
			var cells = [
				{ key: 'rsrp', label: 'RSRP', unit: 'dBm' },
				{ key: 'sinr', label: 'SINR', unit: 'dB' },
				{ key: 'rsrq', label: 'RSRQ', unit: 'dB' }
			];
			var html = '';
			for (var c = 0; c < cells.length; c++) {
				var cc = cells[c];
				var raw = last ? last[cc.key] : null;
				var valStr = (raw != null && !isNaN(raw)) ? raw : '—';
				html += '<span class="mt-readout-cell' + (chartSeries[cc.key] ? '' : ' off') + '">' +
					'<i class="mt-readout-dot" style="background:' + CHART_COLORS[cc.key] + '"></i>' +
					'<span class="mt-readout-label">' + cc.label + '</span>' +
					'<span class="mt-readout-val">' + valStr + '<em>' + cc.unit + '</em></span>' +
					'</span>';
			}
			html += '<span class="mt-readout-count">实时采样 · 每 5 秒 · ' + sigHistory.length + '/' + MAX_SIG_POINTS + ' 点</span>';
			el.innerHTML = html;
		}

		function renderSignalTrendChart() {
			var box = document.getElementById('sig-trend-chart-box');
			if (!box) return;

			// 顶部读数条始终跟随最新真实读数（即使历史点不足 2 个也更新）
			updateChartReadout();

			// 可见窗口：默认全部历史，可切到最近 15 点
			var view = sigHistory.length > chartRange ? sigHistory.slice(sigHistory.length - chartRange) : sigHistory;
			var n = view.length;
			if (n < 2) {
				box.innerHTML = '<div class="mt-chart-empty">正在采集实时信号趋势数据（至少需要 2 个真实采样点，每 5 秒一次）…</div>';
				return;
			}

			/*
			 * 尺寸自适应：SVG 按宽度等比缩放，窄屏改用更窄的 viewBox（380 宽）让缩放比接近 1:1，
			 * 否则 560 的 viewBox 在手机里会把图内文字压到无法辨认。窄屏额外加高，改善可读性。
			 */
			var boxW = box.clientWidth || 560;
			var narrow = boxW < 480;
			var w = narrow ? 380 : 560;
			var h = narrow ? 320 : 340;
			var padL = narrow ? 44 : 52, padR = narrow ? 44 : 52, padT = 26, padB = 34;
			var chartW = w - padL - padR;
			var chartH = h - padT - padB;
			var bottom = padT + chartH;
			var fsTick = narrow ? 11.5 : 11;
			var fsTime = narrow ? 11 : 11;
			var tipFs = 11.5;
			var tipFsTitle = narrow ? 12 : 11.5;

			var RSRP_MIN = -125, RSRP_MAX = -53;
			var SINR_MIN = -5, SINR_MAX = 35;
			var RSRQ_MIN = -20, RSRQ_MAX = -3;

			var xAt = function (i) { return padL + (i / (n - 1)) * chartW; };

			/* 序列元数据：颜色 / 量纲 / 轴值域，绘制与悬浮卡共用 */
			var seriesMeta = [
				{ key: 'rsrp', color: CHART_COLORS.rsrp, label: 'RSRP', unit: 'dBm', min: RSRP_MIN, max: RSRP_MAX },
				{ key: 'sinr', color: CHART_COLORS.sinr, label: 'SINR', unit: 'dB', min: SINR_MIN, max: SINR_MAX },
				{ key: 'rsrq', color: CHART_COLORS.rsrq, label: 'RSRQ', unit: 'dB', min: RSRQ_MIN, max: RSRQ_MAX }
			];
			var activeMeta = [];
			for (var sm = 0; sm < seriesMeta.length; sm++) {
				if (chartSeries[seriesMeta[sm].key]) activeMeta.push(seriesMeta[sm]);
			}

			/* 各序列的连续分段（缺口断开） */
			var segsByKey = {};
			for (var sk = 0; sk < seriesMeta.length; sk++) {
				var meta = seriesMeta[sk];
				segsByKey[meta.key] = seriesSegments(view, meta.key, meta.min, meta.max, padT, bottom, padL, chartW);
			}

			/* 末端有效采样点（脉冲点 / 端点标注用） */
			function lastValid(m) {
				for (var i = n - 1; i >= 0; i--) {
					var v = view[i][m.key];
					if (v != null && v !== '' && !isNaN(v)) return [xAt(i), chartScale(Number(v), m.min, m.max, padT, bottom)];
				}
				return null;
			}

			/* ---- 背景质量分区带（窄屏不标注档位文字，避免拥挤） ---- */
			var bands = '';
			for (var b = 0; b < SIGNAL_TIERS.length; b++) {
				var t = SIGNAL_TIERS[b];
				var y1 = chartScale(t.max, RSRP_MIN, RSRP_MAX, padT, bottom);
				var y2 = chartScale(t.min, RSRP_MIN, RSRP_MAX, padT, bottom);
				var bandH = Math.max(1, y2 - y1);
				bands += '<rect x="' + padL + '" y="' + y1.toFixed(1) + '" width="' + chartW +
					'" height="' + bandH.toFixed(1) + '" fill="' + t.color + '" opacity="0.045"/>';
				if (!narrow) {
					bands += '<text x="' + (padL + chartW - 4) + '" y="' + (y1 + bandH / 2 + 3).toFixed(1) +
						'" font-size="9.5" font-family="sans-serif" fill="' + t.color + '" opacity="0.5" text-anchor="end">' + t.label + '</text>';
				}
			}

			/* ---- 水平网格 + 左右双轴刻度 ---- */
			var grid = '';
			var ticks = CHART_TICKS;
			for (var k = 0; k < ticks.length; k++) {
				var gy = padT + chartH * ticks[k].y;
				var dash = (ticks[k].y === 0 || ticks[k].y === 1) ? '' : ' stroke-dasharray="3 3"';
				grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (w - padR) +
					'" y2="' + gy.toFixed(1) + '" stroke="var(--mt5700-border-subtle)"' + dash + '/>';
				grid += '<text x="' + (padL - 7) + '" y="' + (gy + 3).toFixed(1) +
					'" font-size="' + fsTick + '" font-family="monospace" fill="#0ea5e9" text-anchor="end">' + ticks[k].rsrp + '</text>';
				grid += '<text x="' + (w - padR + 7) + '" y="' + (gy + 3).toFixed(1) +
					'" font-size="' + fsTick + '" font-family="monospace" fill="#10b981" text-anchor="start">' + ticks[k].sinr + '</text>';
			}

			/* ---- 路径构建：分段平滑，缺口如实断开 ---- */
			function strokePathFor(key) {
				var segs = segsByKey[key], out = [];
				for (var i = 0; i < segs.length; i++) {
					if (segs[i].length >= 2) out.push(smoothPathPoints(segs[i], padT, bottom));
				}
				return out.join(' ');
			}
			function areaPathFor(key) {
				var segs = segsByKey[key], out = '';
				for (var i = 0; i < segs.length; i++) {
					var s = segs[i];
					if (s.length < 2) continue;
					out += smoothPathPoints(s, padT, bottom) + ' L ' + s[s.length - 1][0].toFixed(1) + ' ' + bottom.toFixed(1) +
						' L ' + s[0][0].toFixed(1) + ' ' + bottom.toFixed(1) + ' Z ';
				}
				return out;
			}
			/* 孤立采样点（两侧都是缺口）：补一个点，避免该采样在图上消失 */
			function isolatedDotsFor(m) {
				var segs = segsByKey[m.key], out = '';
				for (var i = 0; i < segs.length; i++) {
					if (segs[i].length === 1) {
						out += '<circle cx="' + segs[i][0][0].toFixed(1) + '" cy="' + segs[i][0][1].toFixed(1) + '" r="2" fill="' + m.color + '"/>';
					}
				}
				return out;
			}

			/* ---- 主曲线层（按图例可见性渲染） ---- */
			var seriesLayer = '';
			if (chartSeries.rsrp) {
				seriesLayer += '<path d="' + areaPathFor('rsrp') + '" fill="url(#rsrp-area)"/>' +
					'<path d="' + strokePathFor('rsrp') + '" fill="none" stroke="' + CHART_COLORS.rsrp + '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
					isolatedDotsFor(seriesMeta[0]);
			}
			if (chartSeries.sinr) {
				seriesLayer += '<path d="' + strokePathFor('sinr') + '" fill="none" stroke="' + CHART_COLORS.sinr + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
					isolatedDotsFor(seriesMeta[1]);
			}
			if (chartSeries.rsrq) {
				seriesLayer += '<path d="' + strokePathFor('rsrq') + '" fill="none" stroke="' + CHART_COLORS.rsrq + '" stroke-width="1.6" stroke-dasharray="5 4" stroke-linecap="round" opacity="0.9"/>' +
					isolatedDotsFor(seriesMeta[2]);
			}

			/* ---- 末端脉冲点：标记“当前”，呼吸动效来自 .mt-beacon-dot ---- */
			var endDots = '';
			for (var em = 0; em < activeMeta.length; em++) {
				var lp = lastValid(activeMeta[em]);
				if (!lp) continue;
				var er = activeMeta[em].key === 'rsrp' ? 3.6 : (activeMeta[em].key === 'sinr' ? 3.2 : 2.6);
				endDots += '<circle class="mt-beacon-dot" cx="' + lp[0].toFixed(1) + '" cy="' + lp[1].toFixed(1) +
					'" r="' + er + '" fill="' + activeMeta[em].color + '" stroke="#ffffff" stroke-width="1.3"/>';
			}

			/* ---- 时间横轴（一律保留到秒：同一分钟内多点时只写 时:分 会出现三条重复标签） ---- */
			function fmtTime(ts) { return ts; }
			var firstTime = fmtTime(view[0].time);
			var midTime = fmtTime(view[Math.floor(n / 2)].time);
			var lastTime = fmtTime(view[n - 1].time);

			/* ---- 悬浮卡：只列出当前可见序列，高度随可见数量自适应 ---- */
			var tipW = narrow ? 170 : 188;
			var rowH = 20;
			var tipH = 34 + activeMeta.length * rowH + 20;
			var tipRows = '';
			var hoverDots = '';
			for (var tm = 0; tm < activeMeta.length; tm++) {
				var mm = activeMeta[tm];
				var ry = 44 + tm * rowH;
				tipRows += '<circle cx="18" cy="' + (ry - 4) + '" r="4" fill="' + mm.color + '"/>' +
					'<text id="mt-tip-val-' + mm.key + '" x="30" y="' + ry + '" fill="#e2e8f0" font-size="' + tipFs + '" font-family="monospace">' + mm.label + ' —</text>';
				hoverDots += '<circle id="mt-hover-dot-' + mm.key + '" r="4.5" fill="' + mm.color + '" stroke="#ffffff" stroke-width="2"/>';
			}
			var tierY = 44 + activeMeta.length * rowH - 4;

			box.innerHTML =
				'<svg id="mt-trend-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="overflow:visible; display:block;">' +
				'  <defs>' +
				'    <linearGradient id="rsrp-area" x1="0" y1="0" x2="0" y2="1">' +
				'      <stop offset="0%" stop-color="' + CHART_COLORS.rsrp + '" stop-opacity="0.35"/>' +
				'      <stop offset="100%" stop-color="' + CHART_COLORS.rsrp + '" stop-opacity="0.02"/>' +
				'    </linearGradient>' +
				'  </defs>' +
				/* 质量分区背景 */
				bands +
				/* 网格与双轴刻度 */
				grid +
				/* 主/副曲线 */
				seriesLayer +
				/* 末端脉冲点 */
				endDots +
				/* 时间横轴 */
				'  <text x="' + padL + '" y="' + (h - 8) + '" font-size="' + fsTime + '" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="start">' + firstTime + '</text>' +
				'  <text x="' + (w / 2) + '" y="' + (h - 8) + '" font-size="' + fsTime + '" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="middle">' + midTime + '</text>' +
				'  <text x="' + (w - padR) + '" y="' + (h - 8) + '" font-size="' + fsTime + '" font-family="monospace" fill="var(--mt5700-text-muted)" text-anchor="end">' + lastTime + '</text>' +
				/* 悬浮层：十字准星 + 可见序列指示点 + 数据卡 */
				'  <g id="mt-trend-hover-layer" style="display:none; pointer-events:none;">' +
				'    <line id="mt-hover-crosshair" x1="0" y1="' + padT + '" x2="0" y2="' + bottom + '" stroke="#a78bfa" stroke-width="1.4" stroke-dasharray="3 3"/>' +
				hoverDots +
				'    <g id="mt-hover-tip-card" transform="translate(0, 0)">' +
				'      <rect x="0" y="0" width="' + tipW + '" height="' + tipH + '" rx="9" fill="rgba(15, 23, 42, 0.94)" stroke="rgba(167, 139, 250, 0.6)" stroke-width="1.2"/>' +
				'      <text id="mt-tip-val-time" x="14" y="22" fill="#f8fafc" font-size="' + tipFsTitle + '" font-weight="bold" font-family="sans-serif">时间: --:--:--</text>' +
				tipRows +
				'      <text id="mt-tip-val-tier" x="14" y="' + tierY + '" fill="#94a3b8" font-size="' + tipFs + '" font-family="monospace">质量: —</text>' +
				'    </g>' +
				'  </g>' +
				'  <rect id="mt-chart-hitbox" x="' + padL + '" y="' + padT + '" width="' + chartW + '" height="' + chartH + '" fill="transparent" style="cursor:crosshair; touch-action:none;"/>' +
				'</svg>';

			var hitbox = document.getElementById('mt-chart-hitbox');
			if (!hitbox) return;

			var dragging = false;

			function showIndex(idx) {
				idx = Math.max(0, Math.min(n - 1, idx));
				var item = view[idx];
				if (!item) return;
				trendHoverTime = item.time;

				var curX = xAt(idx);
				var layer = document.getElementById('mt-trend-hover-layer');
				if (layer) layer.style.display = 'block';

				var cross = document.getElementById('mt-hover-crosshair');
				if (cross) { cross.setAttribute('x1', curX.toFixed(1)); cross.setAttribute('x2', curX.toFixed(1)); }

				var topY = bottom;
				for (var m = 0; m < activeMeta.length; m++) {
					var meta = activeMeta[m];
					var v = item[meta.key];
					var dot = document.getElementById('mt-hover-dot-' + meta.key);
					var txt = document.getElementById('mt-tip-val-' + meta.key);
					if (v != null && v !== '' && !isNaN(v)) {
						var y = chartScale(Number(v), meta.min, meta.max, padT, bottom);
						if (dot) { dot.style.display = ''; dot.setAttribute('cx', curX.toFixed(1)); dot.setAttribute('cy', y.toFixed(1)); }
						if (txt) txt.textContent = meta.label + ': ' + v + ' ' + meta.unit;
						if (y < topY) topY = y;
					} else {
						if (dot) dot.style.display = 'none';
						if (txt) txt.textContent = meta.label + ': —';
					}
				}

				var tipX = curX + 12;
				if (tipX + tipW > w - 6) tipX = curX - tipW - 12;
				if (tipX < 4) tipX = 4;
				var tipY = topY - 16;
				if (tipY < padT) tipY = padT;
				if (tipY + tipH > h - 4) tipY = h - tipH - 4;
				var tipCard = document.getElementById('mt-hover-tip-card');
				if (tipCard) tipCard.setAttribute('transform', 'translate(' + tipX.toFixed(1) + ',' + tipY.toFixed(1) + ')');

				var elTime = document.getElementById('mt-tip-val-time');
				if (elTime) elTime.textContent = '时间: ' + item.time;
				var elT = document.getElementById('mt-tip-val-tier');
				var ti = signalTierIndex(item.rsrp);
				if (elT) elT.textContent = '质量: ' + (ti >= 0 ? SIGNAL_TIERS[ti].label : '—');
			}

			function indexAtClientX(clientX) {
				var rect = hitbox.getBoundingClientRect();
				var frac = (clientX - rect.left) / rect.width;
				if (frac < 0) frac = 0;
				if (frac > 1) frac = 1;
				return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
			}

			/* 长按会弹系统菜单/选中文本，这里直接屏蔽，避免与取数交互冲突 */
			hitbox.addEventListener('contextmenu', function (e) { e.preventDefault(); });

			/* pointer 事件同时覆盖鼠标悬浮与触摸点选：
			   触摸单击 → 常显；拖动 → 移动；在原点再点一次 → 收起；点图表外 → 收起（见上方 document 监听）。 */
			hitbox.addEventListener('pointerdown', function (e) {
				var idx = indexAtClientX(e.clientX);
				var beforeTime = trendHoverTime;
				dragging = true;
				if (hitbox.setPointerCapture) {
					try { hitbox.setPointerCapture(e.pointerId); } catch (err) { /* 部分浏览器不支持捕获，忽略 */ }
				}
				if (e.pointerType === 'touch' && beforeTime !== null && view[idx] && view[idx].time === beforeTime) {
					hideTrendHover();
					dragging = false;
				} else {
					showIndex(idx);
				}
				e.preventDefault();
			});
			hitbox.addEventListener('pointermove', function (e) {
				if (e.pointerType === 'touch' && !dragging) return;
				showIndex(indexAtClientX(e.clientX));
			});
			hitbox.addEventListener('pointerup', function () {
				/* 触摸松开后保持常显，不再自动收起 */
				dragging = false;
			});
			hitbox.addEventListener('pointercancel', function () { dragging = false; });
			hitbox.addEventListener('pointerleave', function (e) {
				if (e.pointerType !== 'touch' && !dragging) hideTrendHover();
			});

			/* 每 5 秒重绘会重建 SVG：按时间戳恢复上一次选中的点，保证选中状态不闪没 */
			if (trendHoverTime !== null) {
				var ri = -1;
				for (var hi = 0; hi < n; hi++) {
					if (view[hi].time === trendHoverTime) { ri = hi; break; }
				}
				if (ri >= 0) showIndex(ri); else hideTrendHover();
			}
		}

		/* 字节量格式化，用于累计使用量。注意与 formatSpeedNumber 区别：
		   这里的换算单位是 B / KB / MB / GB（已是字节，不再乘 8）。 */
		function formatBytes(bytes) {
			var b = Number(bytes);
			if (!isFinite(b) || b < 0) b = 0;
			if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
			if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
			if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
			return Math.round(b) + ' B';
		}

		/* 秒 → HH:MM:SS（用于采样时长；起止时间戳均来自设备侧，无浏览器时钟偏差） */
		function formatUsageDuration(sec) {
			var s = Math.floor(isFinite(sec) && sec > 0 ? sec : 0);
			return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60);
		}

		/* kbps → 人话（用于签约速率）：≥1000 显示 Mbps，否则 Kbps。
		 * 按十进制换算（102400 kbps = 102.4 Mbps），不做"凑整"处理——
		 * 模组上报的就是这个值，四舍五入成整数反而与实网不符。 */
		function formatKbps(kbps) {
			var v = Number(kbps);
			if (!isFinite(v) || v <= 0) return '—';
			if (v >= 1000) {
				var m = Math.round((v / 1000) * 10) / 10;
				return m + ' Mbps';
			}
			return Math.round(v) + ' Kbps';
		}

		/* 签约速率文案：有值才显示，没有就如实说明模组未上报 */
		function subRateText() {
			var q = state.subRate;
			if (!q || (!q.dlAmbr && !q.ulAmbr)) return '模组未上报';
			var ul = formatKbps(q.ulAmbr);
			var dl = formatKbps(q.dlAmbr);
			if (q.dlAmbr && q.ulAmbr) return '↑ ' + ul + ' / ↓ ' + dl;
			return q.dlAmbr ? ('↓ ' + dl) : ('↑ ' + ul);
		}

		/* 清零本次使用量（后端一并清空闪存里的记录文件，持久化开着也清） */
		function resetUsage() {
			AtWs.usageCtl('reset').then(function (r) {
				if (r && r.success && r.usage) {
					state.usage = r.usage;
					renderSpeedUI();
				}
			});
		}

		/* 切换「持久化」：开启后使用量落盘闪存、重启后保留 */
		function toggleUsagePersist() {
			var on = !!(state.usage && state.usage.persist);
			AtWs.usageCtl(on ? 'persist_off' : 'persist_on').then(function (r) {
				if (r && r.success && r.usage) {
					state.usage = r.usage;
					renderSpeedUI();
				}
			});
		}

		/* 保存自动清零天数（1~3650，写 UCI，重启后仍生效） */
		function saveUsageAutoResetDays() {
			var el = document.getElementById('usage-days');
			if (!el) return;
			var days = parseInt(el.value, 10);
			if (!isFinite(days) || days < 1) days = 1;
			if (days > 3650) days = 3650;
			AtWs.usageCtl('set_auto_reset_days', days).then(function (r) {
				if (r && r.success && r.usage) {
					state.usage = r.usage;
					renderSpeedUI();
				}
			});
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

			// 更新迷你火花线：纯设备真实采样数据，为 0 则为 0，严禁使用 Math.random 伪造
			/* 空闲（或计数器采样被重置）时老实现会塞随机数，图上在跑流量而数字是 0 B/s，
			 * 自相矛盾。没有流量就如实画 0。 */
			sparkDown.push(state.rtDown > 0 ? state.rtDown : 0);
			if (sparkDown.length > 12) sparkDown.shift();
			sparkUp.push(state.rtUp > 0 ? state.rtUp : 0);
			if (sparkUp.length > 12) sparkUp.shift();

			renderMiniSparkline('spark-dl-box', sparkDown, '#38bdf8');
			renderMiniSparkline('spark-ul-box', sparkUp, '#ec4899');

			/* 本次使用量（设备侧累计，来自 netrate 返回的 usage） */
			var u = state.usage;
			var uDl = document.getElementById('usage-dl');
			if (uDl) uDl.textContent = u ? formatBytes(u.total_rx) : '0 B';
			var uUl = document.getElementById('usage-ul');
			if (uUl) uUl.textContent = u ? formatBytes(u.total_tx) : '0 B';
			var uTot = document.getElementById('usage-total');
			if (uTot) uTot.textContent = u ? formatBytes(u.total_rx + u.total_tx) : '0 B';
			var uPeak = document.getElementById('usage-peak');
			if (uPeak) uPeak.textContent = u
				? '↓' + formatSpeedNumber(u.peak_rx) + ' · ↑' + formatSpeedNumber(u.peak_tx)
				: '↓0 B/s · ↑0 B/s';
			var uDur = document.getElementById('usage-dur');
			if (uDur) {
				/* 时长用后端给的 now_ts 减 start_ts：统计由后端常驻做，
				 * 用浏览器时钟会在页面刚打开时算出一段假时长。 */
				var endTs = (u && u.now_ts) ? u.now_ts : ((u && u.last_ts) || 0);
				uDur.textContent = (u && u.start_ts && endTs >= u.start_ts)
					? formatUsageDuration(endTs - u.start_ts)
					: '00:00:00';
			}
			var elDays = document.getElementById('usage-days');
			if (elDays && u && u.auto_reset_days && document.activeElement !== elDays) {
				elDays.value = String(u.auto_reset_days);
			}
			var uPersist = document.getElementById('usage-persist');
			if (uPersist) {
				if (u && u.persist) uPersist.classList.add('on');
				else uPersist.classList.remove('on');
			}
		}

		function renderTabsUI() {
			var c = state.cell;
			var prim = (state.carriers && state.carriers[0]) || {};
			var primRat = Mt5700.ratLabel(c.sysMode || prim.sysMode);
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
				var pdpIpv4 = (state.diag.addrs || []).filter(function (a) { return a.family === 'IPv4'; })[0];
			var curIp = state.dhcpv4.ipv4Address || (pdpIpv4 ? pdpIpv4.address : '—');
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
				'  <tr><td>签约速率</td><td>' + subRateText() + '</td></tr>' +
				'  <tr><td>IMSI</td><td>' + (state.modemInfo.imsi || '读取中...') + '</td></tr>' +
				'  <tr><td>ICCID</td><td>' + (state.modemInfo.iccid || '读取中...') + '</td></tr>' +
				'</table>';

			// Tab 4: APN 信息（读取 AT+CGDCONT 真实配置，绝不假写 cmiot5g）
			/* PDP 地址按 family 取值：parseCgpaddr 现在会返回双栈两条记录 */
			var pdpIpv4 = (state.diag.addrs || []).filter(function (a) { return a.family === 'IPv4'; })[0];
			var pdpIpv6 = (state.diag.addrs || []).filter(function (a) { return a.family === 'IPv6'; })[0];
			var ipv4 = state.dhcpv4.ipv4Address || (pdpIpv4 ? pdpIpv4.address : '—');
			var ipv6 = state.dhcpv6.ipv6Address || (pdpIpv6 ? pdpIpv6.address : '—');
			var gw = state.dhcpv4.gateway || '—';
			var dns = (state.dhcpv4.primaryDNS || '—') + (state.dhcpv4.secondaryDNS ? ' / ' + state.dhcpv4.secondaryDNS : '');
			var apnName = state.apn || '默认 (核心网自动分配)';
			var protoType = state.pdpType ? (state.pdpType === 'IPV4V6' ? 'IPv4 / IPv6 双栈' : (state.pdpType === 'IP' ? '仅 IPv4' : state.pdpType)) : 'IPv4 / IPv6 双栈';
			tabPanes['tab-apn'].innerHTML =
				'<table class="mt-info-table">' +
				'  <tr><td>APN 接入点</td><td>' + apnName + '</td></tr>' +
				'  <tr><td>数据通道 (CID)</td><td>' + (state.apnCid ? ('CID ' + state.apnCid + '（数据承载）') : '—') + '</td></tr>' +
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
			var hasAnyTemp = items.some(function (it) { return it.value != null && !isNaN(parseFloat(it.value)); });
			if (!hasAnyTemp) {
				tempBody.innerHTML = '<div style="padding:16px; text-align:center; color:var(--mt5700-text-muted); font-size:12.5px;">暂无芯片温度遥测数据（模组未上报或查询超时）</div>';
				if (tempBadge) {
					tempBadge.innerHTML = '';
					tempBadge.appendChild(Mt5700.badge('温度未获取', 'neutral'));
				}
				return;
			}

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

		/* ---------- 深度网络诊断渲染 (折叠面板内部，真实设备遥测) ---------- */
		function renderDiagAdv() {
			diagBox.innerHTML = '';
			var d = state.diag;
			/* 查询未完成/失败时如实显示占位符：把「没查到」画成「已注册 5G」
			 * 或「23 dBm 正常发射」，用户会拿着假状态去排障。 */
			var endcTag = d.endc ? (d.endc.established ? '已建立 (ENDC 启用)' : '未建立') : '—';
			var regVal = d.reg ? (d.reg.statText + (d.reg.act ? ' · ' + d.reg.act : '')) : (state.networkStatus || '—');
			var txVal = '—';
			/* 发射功率优先取 NR（AT^NTXPOWER?）：ENDC/SA 场景只有 NR 有上报，
			 * 无 NR 数据时再回退 GUL（AT^TXPOWER?，纯 LTE 场景）。 */
			var nrTx = (d.nrTx || []).filter(function (c) { return c.pusch != null || c.pucch != null; });
			if (nrTx.length === 1) {
				txVal = (nrTx[0].pusch != null ? nrTx[0].pusch + ' dBm' : '—') + ' / ' + (nrTx[0].pucch != null ? nrTx[0].pucch + ' dBm' : '—');
			} else if (nrTx.length > 1) {
				txVal = nrTx.map(function (c, i) {
					return '载波' + (i + 1) + ' ' + (c.pusch != null ? c.pusch : '—') + ' / ' + (c.pucch != null ? c.pucch : '—');
				}).join('；') + ' dBm';
			} else if (d.tx && (d.tx.pusch != null || d.tx.pucch != null)) {
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
				state.telemetryError = false;
				syncCarriers();
				renderSignalUI();
				renderTabsUI();
				renderCarriersAdv();
			}).catch(function (e) {
				/*
				 * 这里无法判断是哪一步失败（MONSC / HFREQINFO / HCSQ / 渲染），
				 * 因此不再无条件把 hfreqSuccess 置 false —— 那样会让「信号正常、
				 * 只是辅助遥测偶发失败」的情况被误判成信号读取异常。
				 * HFREQINFO 自身的成败已在上一级 then 中如实记录。
				 */
				state.telemetryError = true;
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
				/* NR 下 AT^TXPOWER? 恒返回 ERROR（该命令仅 GUL 有效），
				 * 必须再查 AT^NTXPOWER?（NR 各信道发射功率）才能拿到数据 */
				return AtWs.client.sendCommand('AT^NTXPOWER?');
			}).then(function (ntxp) {
				state.diag.nrTx = (ntxp.success && ntxp.data) ? Parse.parseNrTxPower(ntxp.data) : [];
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

		/*
		 * 判断 APN 是否属于**非数据**专用承载（IMS / 紧急 / MMS / SUPL 等）。
		 * 这些上下文由模组为 IMS 等业务预留，不能拿来当「数据通道 APN」展示。
		 */
		function isNonDataApn(apn) {
			var a = String(apn || '').trim().toLowerCase();
			if (!a) return false;
			if (/^(ims|xcap|sos|emergency|mms|supl|dun|fota|cbs|ia)([.\-_]|$)/.test(a)) return true;
			/* 形如 ims.mnc000.mcc460.3gppnetwork.org 的完整域名形态 */
			if (/(^|[.\-_])ims([.\-_]|$)/.test(a)) return true;
			return false;
		}

		/*
		 * 从 AT+CGDCONT? 的原始响应里挑出**数据通道**上下文。
		 * 实机响应示例（含 IMS 专用承载 cid=5）：
		 *   +CGDCONT: 1,"IPV4V6","",...
		 *   +CGDCONT: 5,"IPV4V6","ims",...
		 * 规则：剔除 IMS/紧急等专用承载 → 优先 CID 1 → 命中即锁定，
		 * 保证数据通道 APN 为空（由核心网分配）时也不会被后面的 ims 顶掉。
		 */
		function pickDataContext(text) {
			var picked = null;
			var imsApn = '';
			var lines = String(text || '').split('\n');
			for (var i = 0; i < lines.length; i++) {
				var m = lines[i].trim().match(/\+CGDCONT:\s*(\d+),\s*"([^"]*)",\s*"([^"]*)"/);
				if (!m) continue;
				var cid = m[1];
				var ptype = m[2];
				var apn = m[3] || '';
				if (isNonDataApn(apn)) {
					if (!imsApn) imsApn = apn;
					continue;
				}
				/* CID 1 优先级最高；已锁定 CID 1 后不再被后续上下文覆盖 */
				if (!picked || (picked.cid !== '1' && cid === '1')) {
					picked = { cid: cid, ptype: ptype, apn: apn };
				}
			}
			return { data: picked, imsApn: imsApn };
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
					/* 只认数据通道：详见 pickDataContext 的说明 */
					var ctx = pickDataContext(res.data);
					if (ctx.imsApn) state.imsApn = ctx.imsApn;
					if (ctx.data) {
						state.pdpType = ctx.data.ptype;
						state.apn = ctx.data.apn;
						state.apnCid = ctx.data.cid;
					}
				}
				/* 签约速率只查**数据上网**那条上下文，绝不查 IMS。
				 * state.apnCid 来自 pickDataContext —— 它已剔除 IMS / 紧急 / MMS / SUPL
				 * 等专用承载 APN，所以这里拿到的必然是数据通道 CID；
				 * 万一没解析到，退回 CID 1（默认数据上下文，实机 +CGACT: 1,1 即上网承载）。
				 *
				 * 优先用厂商私有命令 AT^DSAMBR（手册 16.17「签约速率查询」）：
				 * 它 4G/5G 下都能拿到真实的上下行签约速率（kbps）。
				 * 只有它不返回时，才退回标准命令 AT+C5GQOSRDP（Session-AMBR）。 */
				var dataCid = state.apnCid || '1';
				return AtWs.client.sendCommand('AT^DSAMBR=' + dataCid);
			}).then(function (res) {
				var q = (res && res.success && res.data) ? Parse.parseDsambr(res.data) : null;
				if (!q || (!q.dlAmbr && !q.ulAmbr)) {
					return AtWs.client.sendCommand('AT+C5GQOSRDP=' + (state.apnCid || '1'));
				}
				q.source = 'dsambr';
				state.subRate = q;
				return null;
			}).then(function (res) {
				if (res && res.data) {
					var q2 = Parse.parseC5gQosRdp(res.data);
					/* 5QI 1（VoLTE 语音）/ 5（IMS 信令）是 IMS 专用承载的特征值：
					 * 万一真拿到这种值，说明查到的不是数据上网那条上下文，
					 * 宁可不显示也不张冠李戴。 */
					if (q2 && q2.qci !== 1 && q2.qci !== 5 && (q2.ambrUl || q2.ambrDl)) {
						q2.source = 'qosrdp';
						state.subRate = {
							dlAmbr: q2.ambrDl, ulAmbr: q2.ambrUl,
							apn: state.apn, cid: q2.cid, source: 'qosrdp'
						};
					} else {
						state.subRate = null;
					}
				} else {
					/* DSAMBR 已经给出结果时 res 为 null，无需再动 */
					if (!state.subRate || state.subRate.source !== 'dsambr') state.subRate = null;
				}
				renderTabsUI();
			}).catch(function (e) {
				console.warn('loadDeviceInfo error:', e);
			});
		}

		// 实时网络速率采样 (每 1000ms 采样一次接口统计)
		var rateSample = null;
		var rateTimer = null;

		/* 本次使用量由 Rust 后端常驻统计（见 src/rust/src/usage.rs），
		 * 前端关闭 / 刷新都不影响累计；这里只负责拉取快照展示。 */
		function sampleUsage() {
			return AtWs.usage().then(function (r) {
				if (r && r.success && r.usage) {
					state.usage = r.usage;
					renderSpeedUI();
				}
			});
		}

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
				renderSpeedUI();
			}).catch(function () {});
		}

		rateTimer = setInterval(sampleRate, 1000);
		sampleRate();
		/* 使用量单独一条轮询线：与速率解耦，互不阻塞。
		 * 累计由后端常驻做，这里拉不到只影响展示，不影响统计本身。 */
		setInterval(sampleUsage, 1000);
		sampleUsage();

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
