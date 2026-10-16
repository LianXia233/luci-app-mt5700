'use strict';
'require baseclass';
'require at-webserver/compat';
/* global L */
/**
 * MT5700 LuCI 前端公共组件库：页面骨架、卡片/面板、表单控件、
 * 信号仪表与网络能力总评（木桶原理取最差项），以及实时速率折线图。
 */

// 注入新样式
var MT5700_CSS_VERSION = '2.23.0';
(function () {
	var cssPath = '/luci-static/resources/at-webserver/mt5700.css?v=' + MT5700_CSS_VERSION;
	var links = document.querySelectorAll('link[rel="stylesheet"]');
	for (var i = 0; i < links.length; i++) {
		if (links[i].getAttribute('href') === cssPath) return;
	}
	var link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = cssPath;
	document.head.appendChild(link);
})();

var Mt5700 = (function () {
	var api = {};

	/* ================= 工具函数 ================= */

	// 创建 DOM 元素
	function E(tag, attrs, text) {
		var el = document.createElement(tag);
		if (attrs) {
			for (var k in attrs) {
				if (k === 'class' || k === 'className') {
					el.className = attrs[k];
				} else if (k === 'style') {
					el.style.cssText = attrs[k];
				} else if (k.startsWith('on')) {
					el.addEventListener(k.substring(2).toLowerCase(), attrs[k]);
				} else {
					el.setAttribute(k, attrs[k]);
				}
			}
		}
		// 文本内容：字符串走 textContent，DOM 节点/数组直接挂载
		if (text != null) {
			if (Array.isArray(text)) {
				for (var j = 0; j < text.length; j++) {
					if (text[j] != null) {
						if (typeof text[j] === 'object' && text[j].nodeType) {
							el.appendChild(text[j]);
						} else {
							el.appendChild(document.createTextNode(String(text[j])));
						}
					}
				}
			} else if (typeof text === 'object' && text.nodeType) {
				el.appendChild(text);
			} else {
				el.textContent = String(text);
			}
		}
		return el;
	}

	// SVG 创建
	function svgEl(tag, attrs) {
		var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
		if (attrs) {
			for (var k in attrs) {
				el.setAttribute(k, attrs[k]);
			}
		}
		return el;
	}

	api.constellationSvg = function (modType) {
		var svg = svgEl('svg', {
			'class': 'mt-constellation-svg',
			viewBox: '0 0 160 140',
			fill: 'none',
			xmlns: 'http://www.w3.org/2000/svg'
		});

		// 背景与坐标系 (中心点 80, 70)
		svg.appendChild(svgEl('rect', { x: '4', y: '4', width: '152', height: '132', rx: '12', fill: 'rgba(15, 23, 42, 0.65)', stroke: 'rgba(167, 139, 250, 0.25)', 'stroke-width': '1' }));
		svg.appendChild(svgEl('circle', { cx: '80', cy: '70', r: '46', stroke: 'rgba(56, 189, 248, 0.2)', 'stroke-width': '1', 'stroke-dasharray': '4 4' }));

		// 坐标轴 I / Q
		svg.appendChild(svgEl('line', { x1: '16', y1: '70', x2: '144', y2: '70', stroke: 'rgba(255, 255, 255, 0.2)', 'stroke-width': '1' }));
		svg.appendChild(svgEl('line', { x1: '80', y1: '12', x2: '80', y2: '128', stroke: 'rgba(255, 255, 255, 0.2)', 'stroke-width': '1' }));

		var textI = svgEl('text', { x: '138', y: '66', fill: '#94a3b8', 'font-size': '8', 'font-family': 'sans-serif' });
		textI.textContent = 'I';
		svg.appendChild(textI);

		var textQ = svgEl('text', { x: '84', y: '20', fill: '#94a3b8', 'font-size': '8', 'font-family': 'sans-serif' });
		textQ.textContent = 'Q';
		svg.appendChild(textQ);

		// 生成星座图阵列点 (按 16QAM / 64QAM / 256QAM)
		var points = [];
		var mod = String(modType || '').toUpperCase();
		if (mod.indexOf('QPSK') >= 0) {
			[-20, 20].forEach(function (x) {
				[-20, 20].forEach(function (y) { points.push([80 + x, 70 + y]); });
			});
		} else if (mod.indexOf('256QAM') >= 0) {
			/* 256QAM 必须画 16×16 = 256 个映射点；与 64QAM 共用 6×6 点阵的话，
			 * 角标写着 256QAM、图上却只有 36 个点，可视化就是假的。 */
			for (var ix = 0; ix < 16; ix++) {
				for (var iy = 0; iy < 16; iy++) {
					points.push([80 - 37.5 + ix * 5, 70 - 37.5 + iy * 5]);
				}
			}
		} else if (mod.indexOf('64QAM') >= 0) {
			[-36, -24, -12, 12, 24, 36].forEach(function (x) {
				[-36, -24, -12, 12, 24, 36].forEach(function (y) { points.push([80 + x, 70 + y]); });
			});
		} else {
			// 默认 16QAM (4x4 阵列)
			[-32, -11, 11, 32].forEach(function (x) {
				[-32, -11, 11, 32].forEach(function (y) { points.push([80 + x, 70 + y]); });
			});
		}

		// 星座点着色与光晕
		/* 256 点时半径缩小，避免点阵糊成一团 */
		var ptR = points.length > 64 ? '1.4' : '2.5';
		points.forEach(function (pt) {
			svg.appendChild(svgEl('circle', {
				cx: String(pt[0]),
				cy: String(pt[1]),
				r: ptR,
				fill: '#38bdf8',
				'class': 'mt-anim-pulse'
			}));
		});

		// 调制方式类型角标
		svg.appendChild(svgEl('rect', { x: '10', y: '10', width: '50', height: '16', rx: '5', fill: 'rgba(139, 92, 246, 0.35)', stroke: '#a78bfa', 'stroke-width': '1' }));
		var badge = svgEl('text', { x: '35', y: '21', 'text-anchor': 'middle', fill: '#ffffff', 'font-size': '8.5', 'font-weight': 'bold', 'font-family': 'sans-serif' });
		badge.textContent = mod || '16QAM';
		svg.appendChild(badge);

		return svg;
	};

	api.mimoSvg = function (rank) {
		var svg = svgEl('svg', {
			'class': 'mt-mimo-svg',
			viewBox: '0 0 200 140',
			fill: 'none',
			xmlns: 'http://www.w3.org/2000/svg'
		});

		var numRank = parseInt(rank, 10) || 4;
		svg.appendChild(svgEl('rect', { x: '4', y: '4', width: '192', height: '132', rx: '12', fill: 'rgba(15, 23, 42, 0.65)', stroke: 'rgba(167, 139, 250, 0.25)', 'stroke-width': '1' }));

		// 左侧基站发射天线阵列 Tx1..Tx4
		var txY = [32, 54, 76, 98];
		txY.forEach(function (y, i) {
			svg.appendChild(svgEl('circle', { cx: '24', cy: String(y), r: '4', fill: '#8b5cf6', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('line', { x1: '16', y1: String(y), x2: '24', y2: String(y), stroke: '#a78bfa', 'stroke-width': '2' }));
			var t = svgEl('text', { x: '10', y: String(y + 3), fill: '#94a3b8', 'font-size': '7', 'font-family': 'monospace' });
			t.textContent = 'T' + (i + 1);
			svg.appendChild(t);
		});

		// 右侧模组接收天线阵列 Rx1..Rx4
		var rxY = [32, 54, 76, 98];
		rxY.forEach(function (y, i) {
			svg.appendChild(svgEl('circle', { cx: '176', cy: String(y), r: '4', fill: '#38bdf8', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('line', { x1: '176', y1: String(y), x2: '184', y2: String(y), stroke: '#38bdf8', 'stroke-width': '2' }));
			var t = svgEl('text', { x: '186', y: String(y + 3), fill: '#94a3b8', 'font-size': '7', 'font-family': 'monospace' });
			t.textContent = 'R' + (i + 1);
			svg.appendChild(t);
		});

		// 空间流波束连接曲线
		var streamColors = ['#8b5cf6', '#38bdf8', '#f472b6', '#34d399'];
		for (var s = 0; s < Math.min(numRank, 4); s++) {
			var startY = txY[s];
			var endY = rxY[s];
			var pathData = 'M 24 ' + startY + ' C 75 ' + (startY - 10) + ', 125 ' + (endY + 10) + ', 176 ' + endY;
			svg.appendChild(svgEl('path', {
				d: pathData,
				stroke: streamColors[s % streamColors.length],
				'stroke-width': '2.2',
				'stroke-linecap': 'round',
				'stroke-dasharray': '5 3',
				'class': 'mt-anim-stream'
			}));
		}

		// 徽标显示 Rank
		svg.appendChild(svgEl('rect', { x: '68', y: '112', width: '64', height: '16', rx: '5', fill: 'rgba(56, 189, 248, 0.25)', stroke: '#38bdf8', 'stroke-width': '1' }));
		var rText = svgEl('text', { x: '100', y: '123', 'text-anchor': 'middle', fill: '#ffffff', 'font-size': '8.5', 'font-weight': 'bold', 'font-family': 'sans-serif' });
		rText.textContent = 'MIMO ' + numRank + '×' + numRank;
		svg.appendChild(rText);

		return svg;
	};

	/*
	 * 看板娘：保留头像本体（图片 + 悬浮动效），对话气泡功能已移除。
	 * 之前的气泡会挤占英雄栏标题并在窄屏下遮挡内容，按需求不再提供。
	 */
	api.mascot = function () {
		var wrap = E('div', { 'class': 'mt-mascot-speech-wrap' });

		// 二次元蓝发猫耳看板娘头像图片，外圈带光环与悬浮动效
		var avatar = E('div', { 'class': 'mt-mascot-avatar' });
		var img = E('img', {
			'class': 'mt-mascot-img',
			'src': '/luci-static/resources/at-webserver/mascot.png?v=' + MT5700_CSS_VERSION,
			'alt': '可可的看板娘'
		});
		avatar.appendChild(img);
		wrap.appendChild(avatar);

		return { el: wrap };
	};

	/* ================= 四格动态信号图标 (cellular signal) =================
	 *
	 * 移植自 cellular-signal-preview.html：状态由 data-state 属性驱动，
	 * 颜色与动画全部交给 mt5700.css 的 .cellular[data-state=...] 规则。
	 *
	 * 状态语义（与 CSS 一一对应，页面必须按真实数据选择，不得凭空指定）：
	 *   none          无信号（0 格 + 斜杠）
	 *   weak/medium/strong/full   1 / 2 / 3 / 4 格
	 *   searching     正在搜索网络（信号格依次扫描）
	 *   connecting    正在连接网络（右上角圆点闪烁）
	 *   disconnected  网络已断开（0 格 + 斜杠）
	 *   error         连接错误（感叹号角标）
	 */
	var CELLULAR_LEVELS = {
		none: 0, weak: 1, medium: 2, strong: 3, full: 4,
		searching: 0, connecting: 0, disconnected: 0, error: 0
	};

	var CELLULAR_LABELS = {
		none: '无信号', weak: '弱信号', medium: '中等信号', strong: '强信号', full: '信号满格',
		searching: '正在搜索网络', connecting: '正在连接网络',
		disconnected: '网络已断开', error: '网络连接错误'
	};


	api.cellularSignal = function () {
		var wrap = E('span', {
			'class': 'cellular',
			'data-state': 'searching',
			'role': 'img',
			'aria-label': CELLULAR_LABELS.searching
		});

		var svg = svgEl('svg', {
			viewBox: '0 0 32 32',
			xmlns: 'http://www.w3.org/2000/svg',
			'aria-hidden': 'true'
		});

		/* 四格信号柱（高度递增） */
		[[3, 22, 5, 7], [10, 17, 5, 12], [17, 11, 5, 18], [24, 5, 5, 24]].forEach(function (b) {
			svg.appendChild(svgEl('rect', { 'class': 'bar', x: b[0], y: b[1], width: b[2], height: b[3], rx: 1 }));
		});

		/* 无信号 / 已断开：斜杠 */
		var slash = svgEl('g', {
			'class': 'overlay slash', fill: 'none', stroke: 'currentColor',
			'stroke-width': '2.4', 'stroke-linecap': 'round'
		});
		slash.appendChild(svgEl('path', { d: 'M5 5 L27 27' }));
		svg.appendChild(slash);

		/* 连接中：右上角圆点 */
		svg.appendChild(svgEl('circle', { 'class': 'overlay connecting-dot', cx: 26, cy: 5, r: 3, fill: 'currentColor' }));

		/* 错误：感叹号角标 */
		var errMark = svgEl('g', { 'class': 'overlay error-mark' });
		errMark.appendChild(svgEl('circle', { cx: 25, cy: 7, r: 6, fill: 'currentColor' }));
		errMark.appendChild(svgEl('path', { d: 'M25 3.8 V7.5 M25 10 V10.1', stroke: '#ffffff', 'stroke-width': '1.6', 'stroke-linecap': 'round' }));
		svg.appendChild(errMark);

		wrap.appendChild(svg);

		var bars = svg.querySelectorAll('.bar');

		/* 按状态更新格数与可访问标签；未知状态退到 searching，绝不静默留空 */
		wrap.setCellularState = function (state) {
			if (!Object.prototype.hasOwnProperty.call(CELLULAR_LEVELS, state)) state = 'searching';
			wrap.setAttribute('data-state', state);
			var level = CELLULAR_LEVELS[state];
			for (var i = 0; i < bars.length; i++) {
				if (i < level) bars[i].classList.add('active');
				else bars[i].classList.remove('active');
			}
			wrap.setAttribute('aria-label', CELLULAR_LABELS[state]);
			return state;
		};

		return wrap;
	};

	api.page = function (title, subtitle, pageKey, badgeText) {
		var node = E('div', { 'class': 'mt5700-page' });

		// 自动匹配 pageKey（如果没传）
		if (!pageKey) {
			var t = String(title || '');
			if (/状态|status/i.test(t)) pageKey = 'network_status';
			else if (/网络设置|settings/i.test(t)) pageKey = 'network_settings';
			else if (/拨号|dial/i.test(t)) pageKey = 'dial';
			else if (/扫频|scan/i.test(t)) pageKey = 'scan';
			else if (/定时|schedule/i.test(t)) pageKey = 'schedule';
			else if (/模组设置|modem/i.test(t)) pageKey = 'modem_settings';
			else if (/升级|upgrade/i.test(t)) pageKey = 'upgrade';
			else if (/短信中心|sms_center/i.test(t)) pageKey = 'sms_center';
			else if (/短信设置|sms_settings/i.test(t)) pageKey = 'sms_settings';
			else if (/终端|terminal/i.test(t)) pageKey = 'terminal';
			else if (/日志|log/i.test(t)) pageKey = 'logs';
			else if (/服务|service|config/i.test(t)) pageKey = 'service';
			else pageKey = 'default';
		}

		if (!badgeText) {
			var badgeMap = {
				network_status: '实时遥测 · 5G NR/LTE',
				network_settings: '射频频段 · 锁频策略',
				dial: '数据链路 · APN 拨号',
				scan: '基站探测 · 载波扫描',
				schedule: '时段调度 · 智能倒换',
				modem_settings: '模组核心 · 硬件控制',
				upgrade: '固件更新 · FOTA 在线',
				sms_center: '即时消息 · 会话管理',
				sms_settings: '短信配置 · 存储/USSD',
				terminal: 'AT 控制台 · 交互调试',
				logs: '事件审计 · 运行日志',
				service: '守护进程 · 后台服务',
				'default': 'MT5700 5G 模组'
			};
			badgeText = badgeMap[pageKey] || 'MT5700 5G 模组';
		}

		var hero = E('div', { 'class': 'mt5700-hero-card' });
		var content = E('div', { 'class': 'mt5700-hero-content' });

		var badge = E('div', { 'class': 'mt5700-hero-badge' }, [
			E('span', { 'class': 'mt5700-hero-badge-dot' }),
			E('span', {}, badgeText)
		]);
		content.appendChild(badge);

		content.appendChild(E('h2', { 'class': 'mt5700-hero-title' }, title || ''));
		if (subtitle) {
			content.appendChild(E('p', { 'class': 'mt5700-hero-desc' }, subtitle));
		}
		hero.appendChild(content);

		var art = E('div', { 'class': 'mt5700-hero-art' });

		/* 看板娘完整保留（含图片、气泡、点击换台词与动画） */
		var mascot = api.mascot();
		art.appendChild(mascot.el);
		hero.appendChild(art);
		node._mascot = mascot;

		node.appendChild(hero);

		var body = E('div', { 'class': 'mt5700-page-body' });
		node.appendChild(body);
		node._body = body;
		node._hero = hero;
		return node;
	};

	/* ================= 骨架屏加载态 (Responsive Skeleton) ================= */


	/* ================= 卡片 ================= */

	api.card = function (title, subtitle, extra) {
		var card = E('div', { 'class': 'mt5700-card' });
		var header = E('div', { 'class': 'mt5700-card-header' });
		header.appendChild(E('h3', { 'class': 'mt5700-card-title' }, title || ''));
		if (subtitle) header.appendChild(E('p', { 'class': 'mt5700-card-subtitle' }, subtitle));
		if (extra) {
			var ex = E('div', { 'class': 'mt5700-card-extra' });
			ex.appendChild(extra);
			header.appendChild(ex);
		}
		card.appendChild(header);
		var body = E('div', { 'class': 'mt5700-card-body' });
		card.appendChild(body);
		card._body = body;
		return card;
	};

	/* ================= 指标卡片 ================= */

	/*
	 * 单位白名单：显式枚举。
	 * 只有命中白名单才做「数字 + 单位」分段渲染，否则整段原样输出。
	 */
	var METRIC_UNITS = [
		'Mbps', 'Gbps', 'kbps', 'Kbps', 'Bps',
		'dBm', 'dB', 'MHz', 'GHz', 'kHz', 'Hz',
		'ms', 'us', 'ns', 's',
		'℃', '°C', '%',
		'MB', 'GB', 'KB', 'TB', 'B',
		'次', '个', '台'
	];

	api.metricValue = function (el, value) {
		var text = (value == null || value === '') ? '—' : String(value);
		/* 形如「102.40 Mbps」：数字 + 空格 + 白名单单位 */
		var m = /^([-+]?[\d.,]+)\s*(\S+)$/.exec(text);
		if (m && METRIC_UNITS.indexOf(m[2]) >= 0) {
			el.appendChild(document.createTextNode(m[1]));
			el.appendChild(E('span', { 'class': 'unit' }, m[2]));
			/* 数字位数多时同步降字号，避免超出卡片 */
			if (m[1].replace(/[.,]/g, '').length >= 7) el.classList.add('len-md');
			return el;
		}

		el.appendChild(document.createTextNode(text));

		/*
		 * 纯文本值的宽度分级：按「显示宽度」估算（CJK 记 1，ASCII 记 0.55）。
		 * 分档阈值经 176px 卡宽实测校准：≤6 全尺寸，>6 逐级降到 0.62em。
		 */
		var w = 0;
		for (var i = 0; i < text.length; i++) {
			w += /[\u2e80-\u9fff\uff00-\uffef]/.test(text.charAt(i)) ? 1 : 0.55;
		}
		if (w > 6 && w <= 9) el.classList.add('len-md');
		else if (w > 9 && w <= 12) el.classList.add('len-lg');
		else if (w > 12) el.classList.add('len-xl');
		return el;
	};

	api.metric = function (label, value, color, status) {
		var m = E('div', { 'class': 'mt5700-metric' });
		m.appendChild(E('div', { 'class': 'mt5700-metric-label', title: label || '' }, label));
		var v = E('div', { 'class': 'mt5700-metric-value', title: (value == null ? '' : String(value)) });
		api.metricValue(v, value);
		if (color) v.classList.add(color);
		m.appendChild(v);
		/* status 为可选状态类（如温度 temp-normal），用于整卡背景着色；
		 * 不传时不加任何状态类，仅渲染基础指标卡。 */
		if (status) m.classList.add(status);
		return m;
	};


	/* ================= 温度状态判定 ================= */







	/* ================= 环形仪表 (Circular Gauge) ================= */









	/*
	 * 制式代际档位。代际决定的是「理论峰值与调度效率」的量级差异，
	 * 与当前信号强弱无关。
	 *   NR   5G：Sub-6 单载波 100MHz 可跑数百 Mbps
	 *   LTE  4G：20MHz 典型 100~150Mbps，Cat 等级决定上限
	 *   WCDMA 3G：个位数到十余 Mbps
	 */
	var RAT_CAP = {
		'NR': { level: 'exc', label: '5G', note: '5G 制式，单载波带宽上限最高' },
		'LTE': { level: 'good', label: '4G', note: '4G 制式，理论峰值明显低于 5G' },
		'WCDMA': { level: 'poor', label: '3G', note: '3G 制式，仅够轻量上网' },
		'GSM': { level: 'bad', label: '2G', note: '2G 制式，无法承载数据业务' }
	};




	/* 制式名归一：^HFREQINFO 返回 6/7，^MONSC 返回 LTE/NR，页面 state 可能给任意形式 */
	function normRat(v) {
		if (v == null || v === '') return null;
		var s = String(v).trim().toUpperCase();
		if (s === '6' || s.indexOf('LTE') === 0) return 'LTE';
		if (s === '7' || s === '11' || s.indexOf('NR') === 0) return 'NR';
		if (s.indexOf('WCDMA') === 0 || s === '3') return 'WCDMA';
		if (s.indexOf('GSM') === 0 || s === '1') return 'GSM';
		return null;
	}
	/* 制式代号 → 可读标签（供页面展示与无障碍属性使用） */
	api.ratLabel = function (v) {
		var r = normRat(v);
		return r && RAT_CAP[r] ? RAT_CAP[r].label : (v ? String(v) : '—');
	};














	/* ================= 按钮 ================= */

	api.button = function (label, onClick, variant) {
		variant = variant || 'secondary';
		var btn = E('button', { 'class': 'mt5700-btn mt5700-btn-' + variant }, label);
		if (onClick) btn.addEventListener('click', onClick);
		return btn;
	};

	api.primaryButton = function (label, onClick) {
		return api.button(label, onClick, 'primary');
	};


	api.dangerButton = function (label, onClick) {
		return api.button(label, onClick, 'danger');
	};

	api.ghostButton = function (label, onClick) {
		return api.button(label, onClick, 'ghost');
	};

	/* ================= 状态标签 ================= */

	api.badge = function (text, variant) {
		variant = variant || 'neutral';
		return E('span', { 'class': 'mt5700-badge mt5700-badge-' + variant }, text);
	};


	/* ================= 模态框 ================= */

	api.confirm = function (message, onOk, okText) {
		var mask = E('div', { 'class': 'mt5700-modal-mask' });
		var box = E('div', { 'class': 'mt5700-modal' });
		var text = E('div', { 'class': 'mt5700-modal-body' }, message);
		var actions = E('div', { 'class': 'mt5700-modal-footer' });
		var cancel = api.ghostButton('取消', function () {
			if (mask.parentNode) mask.parentNode.removeChild(mask);
		});
		var ok = api.primaryButton(okText || '确定', function () {
			if (mask.parentNode) mask.parentNode.removeChild(mask);
			if (onOk) onOk();
		});
		actions.appendChild(cancel);
		actions.appendChild(ok);
		box.appendChild(text);
		box.appendChild(actions);
		mask.appendChild(box);
		mask.addEventListener('click', function (e) {
			if (e.target === mask && mask.parentNode) mask.parentNode.removeChild(mask);
		});
		document.body.appendChild(mask);
		return mask;
	};

	/* ================= Toast 通知 ================= */

	api.toast = function (message, type) {
		type = type || 'info';
		var t = E('div', { 'class': 'mt5700-toast mt5700-toast-' + type }, message);
		document.body.appendChild(t);
		setTimeout(function () { t.classList.add('mt5700-toast-hide'); }, 3000);
		setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
	};

	api.success = function (m) { api.toast(m, 'success'); };
	api.error = function (m) { api.toast(m, 'error'); };
	api.warning = function (m) { api.toast(m, 'warning'); };
	api.info = function (m) { api.toast(m, 'info'); };

	/* ================= Loading / Error / Empty ================= */

	api.loading = function (text) {
		var el = E('div', { 'class': 'mt5700-loading' });
		var sp = E('div', { 'class': 'mt-anime-spinner-box' });
		var svg = svgEl('svg', {
			'class': 'mt-anime-spinner-svg mt-anim-spin',
			viewBox: '0 0 50 50',
			width: '38',
			height: '38',
			fill: 'none',
			xmlns: 'http://www.w3.org/2000/svg'
		});
		svg.appendChild(svgEl('circle', {
			cx: '25', cy: '25', r: '20',
			stroke: 'rgba(167, 139, 250, 0.25)',
			'stroke-width': '4'
		}));
		svg.appendChild(svgEl('path', {
			d: 'M25 5 A20 20 0 0 1 45 25',
			stroke: '#8b5cf6',
			'stroke-width': '4',
			'stroke-linecap': 'round'
		}));
		svg.appendChild(svgEl('circle', { cx: '25', cy: '5', r: '3.5', fill: '#f472b6' }));
		sp.appendChild(svg);
		el.appendChild(sp);
		el.appendChild(E('div', { 'class': 'mt5700-loading-text' }, text || '正在全力加载中喵~ ♡'));
		return el;
	};

	api.empty = function (text) {
		var el = E('div', { 'class': 'mt5700-empty' });
		var svg = svgEl('svg', {
			'class': 'mt-anime-empty-svg',
			viewBox: '0 0 100 80',
			width: '80',
			height: '64',
			fill: 'none',
			xmlns: 'http://www.w3.org/2000/svg'
		});
		// 萌系软云与浮动星光
		svg.appendChild(svgEl('path', {
			d: 'M25 55 C18 55 12 49 14 42 C15 36 21 32 27 33 C30 24 41 20 49 25 C54 21 64 22 68 28 C74 27 80 32 80 38 C86 41 87 48 83 53 C81 55 76 55 75 55 Z',
			fill: 'rgba(237, 233, 254, 0.85)',
			stroke: '#c7d2fe',
			'stroke-width': '1.5',
			'class': 'mt-anim-float'
		}));
		svg.appendChild(svgEl('circle', { cx: '40', cy: '42', r: '2', fill: '#8b5cf6' }));
		svg.appendChild(svgEl('circle', { cx: '60', cy: '42', r: '2', fill: '#8b5cf6' }));
		svg.appendChild(svgEl('path', { d: 'M 47 47 Q 50 50 53 47', stroke: '#ec4899', 'stroke-width': '1.5', fill: 'none' }));
		svg.appendChild(svgEl('path', { d: 'M18 24 L20 18 L22 24 L28 26 L22 28 L20 34 L18 28 L12 26 Z', fill: '#fbbf24', 'class': 'mt-anim-pulse' }));
		svg.appendChild(svgEl('path', { d: 'M76 18 L77.5 13 L79 18 L84 19.5 L79 21 L77.5 26 L76 21 L71 19.5 Z', fill: '#f472b6', 'class': 'mt-anim-pulse' }));
		el.appendChild(svg);
		el.appendChild(E('div', { 'class': 'mt5700-empty-text' }, text || '暂无数据喵~'));
		return el;
	};


	/* ================= 自动刷新 ================= */


	/* ================= 定时器管理 ================= */

	var _timers = [];

	api.interval = function (ms, fn) {
		var id = setInterval(fn, ms);
		_timers.push(function () { clearInterval(id); });
		return id;
	};


	/* ================= 图表 ================= */




	/* ================= 表格 ================= */

	api.table = function (headers, rows, options) {
		options = options || {};
		var wrapper = E('div', { 'class': 'mt5700-table-wrapper' });
		var table = E('table', { 'class': 'mt5700-table' });
		if (options.striped) table.classList.add('mt5700-table-striped');

		/*
		 * 手机端（<=600px）表格改为「卡片式堆叠」：隐藏表头，每个单元格
		 * 用 ::before 显示自己的列名。因此这里把表头文案写进每个 td 的
		 * data-label，CSS 侧用 content: attr(data-label) 读取。
		 * 桌面端 data-label 不显示，对既有布局零影响。
		 */
		var labelOf = function (i) {
			var h = headers[i];
			return (h == null) ? '' : String(h);
		};

		/*
		 * 只有两列的键值表：手机端不适用「一行一卡」的堆叠（会把每项
		 * 拆成上下两行，项数多时反而更高），改由 .mt5700-table-kv
		 * 走「标签左 / 值右」的紧凑分栏行。
		 */
		if (headers.length === 2) table.classList.add('mt5700-table-kv');

		// 表头
		var thead = E('thead');
		var tr = E('tr');
		headers.forEach(function (h) {
			tr.appendChild(E('th', {}, h));
		});
		thead.appendChild(tr);
		table.appendChild(thead);

		// 表体
		var tbody = E('tbody');
		if (!rows || !rows.length) {
			var tr0 = E('tr');
			tr0.appendChild(E('td', { colspan: headers.length, 'class': 'mt5700-empty' }, '暂无数据'));
			tbody.appendChild(tr0);
		} else {
			rows.forEach(function (row) {
				var tr = E('tr');
				row.forEach(function (cell, ci) {
					var td;
					if (typeof cell === 'object' && cell.nodeType) {
						td = E('td');
						td.appendChild(cell);
					} else {
						td = E('td', {}, cell || '—');
					}
					var lbl = labelOf(ci);
					if (lbl) td.setAttribute('data-label', lbl);
					tr.appendChild(td);
				});
				tbody.appendChild(tr);
			});
		}
		table.appendChild(tbody);
		wrapper.appendChild(table);
		return wrapper;
	};

	/* ================= 表单 ================= */

	api.formGroup = function (label, input, hint, required) {
		var group = E('div', { 'class': 'mt5700-form-group' });
		var lbl = E('label', { 'class': 'mt5700-label' + (required ? ' mt5700-label-required' : '') }, label);
		group.appendChild(lbl);
		group.appendChild(input);
		if (hint) group.appendChild(E('div', { 'class': 'mt5700-hint' }, hint));
		return group;
	};

	api.input = function (type, placeholder, value) {
		var input = E('input', { 'class': 'mt5700-input', type: type || 'text' });
		if (placeholder) input.placeholder = placeholder;
		if (value != null) input.value = value;
		return input;
	};

	api.select = function (options, value) {
		var sel = E('select', { 'class': 'mt5700-input mt5700-select' });
		options.forEach(function (opt) {
			var o = E('option', { value: opt.value }, opt.label);
			if (opt.value === value) o.selected = true;
			sel.appendChild(o);
		});
		return sel;
	};

	/* ================= 面板操作区 ================= */

	api.panelActions = function () {
		var el = E('div', { 'class': 'mt5700-panel-actions' });
		for (var i = 0; i < arguments.length; i++) {
			el.appendChild(arguments[i]);
		}
		return el;
	};

	/* ================= 高级控件 ================= */

	/*
	 * 卡片式单选组
	 *
	 * 用途：把「用户看不懂的编码」变成「用户可以按影响面直接选」的选项。
	 * 与原生 <select> 的区别：每个选项都有独立标题与说明文案，说明始终可见，
	 * 不需要展开下拉才能比较。适合选项数量少（<=8）且每项都需要解释的场景。
	 *
	 * options: [{ value, label, desc, badge }]
	 *   value —— 真实下发值（如 "080302"），onChange 收到它
	 *   label —— 选项主标题（通俗中文）
	 *   desc  —— 选项说明，讲清「选了会怎样」
	 *   badge —— 可选角标，如「推荐」「仅搜索」
	 *
	 * 返回值为容器元素，额外挂载：
	 *   el.getValue()         取当前值
	 *   el.setValue(v, silent) 设当前值（silent=true 时不触发 onChange）
	 *   el.setDisabled(v, off) 单项禁用（用于「含 LTE 时不允许 CS_ONLY」这类互斥约束）
	 */
	api.radioCards = function (name, options, value, onChange) {
		var wrap = E('div', { 'class': 'mt5700-radio-cards' });
		var items = [];

		options.forEach(function (opt, idx) {
			var id = 'mt5700-rc-' + name + '-' + idx;
			var label = E('label', { 'class': 'mt5700-radio-card', 'for': id });
			var input = E('input', { type: 'radio', name: 'mt5700-rc-' + name, id: id, value: opt.value });
			var body = E('div', { 'class': 'mt5700-radio-card-body' });
			var head = E('div', { 'class': 'mt5700-radio-card-head' });
			head.appendChild(E('span', { 'class': 'mt5700-radio-card-title' }, opt.label));
			if (opt.badge) head.appendChild(E('span', { 'class': 'mt5700-radio-card-badge' }, opt.badge));
			body.appendChild(head);
			if (opt.desc) body.appendChild(E('div', { 'class': 'mt5700-radio-card-desc' }, opt.desc));
			if (opt.code) body.appendChild(E('code', { 'class': 'mt5700-radio-card-code' }, opt.code));
			label.appendChild(input);
			label.appendChild(E('span', { 'class': 'mt5700-radio-card-dot' }));
			label.appendChild(body);
			wrap.appendChild(label);
			items.push({ input: input, label: label, option: opt });
			input.addEventListener('change', function () {
				if (input.checked && typeof onChange === 'function') onChange(opt.value, opt);
			});
		});

		function apply(v) {
			items.forEach(function (it) { it.input.checked = (it.option.value === v); });
		}
		apply(value);

		wrap.getValue = function () {
			for (var i = 0; i < items.length; i++) if (items[i].input.checked) return items[i].option.value;
			return '';
		};
		wrap.setValue = function (v, silent) {
			apply(v);
			if (!silent && typeof onChange === 'function') {
				var hit = items.filter(function (it) { return it.option.value === v; })[0];
				if (hit) onChange(v, hit.option);
			}
		};
		/* 单项禁用：用于官方约束（如 srvdomain 含 LTE/NR 时不允许 0 或 3） */
		wrap.setDisabled = function (v, off) {
			items.forEach(function (it) {
				if (it.option.value !== v) return;
				it.input.disabled = !!off;
				it.label.classList.toggle('mt5700-radio-card-disabled', !!off);
				if (off && it.input.checked) it.input.checked = false;
			});
		};
		wrap.setAllDisabled = function (off) {
			items.forEach(function (it) {
				it.input.disabled = !!off;
				it.label.classList.toggle('mt5700-radio-card-disabled', !!off);
			});
		};
		return wrap;
	};

	/*
	 * 底层参数展示行
	 *
	 * 用途：界面用通俗文案，但底层编码仍要可见可审计（便于排障与对标 AT 手册）。
	 * 用等宽灰底呈现编码值，不参与编辑，用户不会误改。
	 */
	api.rawValue = function (label, value) {
		var row = E('div', { 'class': 'mt5700-raw-row' });
		row.appendChild(E('span', { 'class': 'mt5700-raw-label' }, label));
		var val = E('code', { 'class': 'mt5700-raw-value' }, (value === '' || value == null) ? '—' : String(value));
		row.appendChild(val);
		row.setValue = function (v) { val.textContent = (v === '' || v == null) ? '—' : String(v); };
		return row;
	};

	/*
	 * 字段说明块
	 *
	 * 比 formGroup 的 hint 更结构化：支持一个主说明 + 若干条要点。
	 * 用于把一个技术字段的作用、影响面、注意事项讲清楚。
	 */
	api.fieldNote = function (summary, points) {
		var box = E('div', { 'class': 'mt5700-field-note' });
		if (summary) box.appendChild(E('div', { 'class': 'mt5700-field-note-summary' }, summary));
		if (points && points.length) {
			var ul = E('ul', { 'class': 'mt5700-field-note-list' });
			points.forEach(function (p) { ul.appendChild(E('li', {}, p)); });
			box.appendChild(ul);
		}
		return box;
	};


	/* ================= 未保存更改（暂存 / 保存并应用 / 撤销） ================= */

	/*
	 * OpenWrt 标准「保存并应用」语义的前端实现：
	 * - 页面修改不立即下发，先调用 staged.set(key, label, run) 暂存
	 * - 同一 key 重复修改自动覆盖（只应用最后一次）
	 * - 悬浮条实时显示未保存项数量，提供「保存并应用」「撤销更改」两个入口
	 * - 应用时逐项执行 run()（返回 Promise），成功/失败后回调刷新实际状态
	 */
	api.staged = function (options) {
		options = options || {};
		var items = []; // { key, label, run }
		var bar = E('div', { 'class': 'mt5700-applybar mt5700-applybar-hidden' });
		var text = E('span', { 'class': 'mt5700-applybar-text' });
		var actions = E('div', { 'class': 'mt5700-applybar-actions' });
		var revertBtn = api.ghostButton('撤销更改', doRevert);
		var applyBtn = api.primaryButton('保存并应用', doApply);
		actions.appendChild(revertBtn);
		actions.appendChild(applyBtn);
		bar.appendChild(text);
		bar.appendChild(actions);

		function refresh() {
			if (items.length) {
				text.textContent = '有 ' + items.length + ' 项未保存的更改';
				bar.classList.remove('mt5700-applybar-hidden');
			} else {
				bar.classList.add('mt5700-applybar-hidden');
			}
		}

		function doApply() {
			if (!items.length) return;
			var queue = items.slice();
			applyBtn.disabled = true;
			revertBtn.disabled = true;
			text.textContent = '正在应用更改（' + queue.length + ' 项）…';
			var chain = Promise.resolve();
			queue.forEach(function (it) {
				chain = chain.then(function () { return it.run(); });
			});
			return chain.then(function () {
				items = [];
				api.success('更改已应用');
			}).catch(function (err) {
				api.error((err && err.message) || '应用更改失败');
			}).then(function () {
				applyBtn.disabled = false;
				revertBtn.disabled = false;
				refresh();
				/* 成败都重新拉取，让界面与实际状态对齐 */
				if (options.onChanged) options.onChanged();
			});
		}

		function doRevert() {
			api.confirm('确定放弃全部未保存的更改？', function () {
				items = [];
				refresh();
				if (options.onChanged) options.onChanged();
			}, '放弃更改');
		}

		return {
			el: bar,
			/* key 相同的暂存项会被覆盖，避免重复下发同一配置 */
			set: function (key, label, run) {
				for (var i = 0; i < items.length; i++) {
					if (items[i].key === key) {
						items[i].label = label;
						items[i].run = run;
						refresh();
						return;
					}
				}
				items.push({ key: key, label: label, run: run });
				refresh();
			},
			remove: function (key) {
				items = items.filter(function (it) { return it.key !== key; });
				refresh();
			},
			clear: function () { items = []; refresh(); },
			count: function () { return items.length; }
		};
	};

	/* ================= 速率显示 (L3 浮动) ================= */


	return api;
})();

// 导出
var Mt5700Class = L.Class.extend(Mt5700);
if (typeof window !== 'undefined') {
	window.Mt5700 = new Mt5700Class();
}
return Mt5700Class;
