'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/tabmenu';
/* global L */
/**
 * MT5700 LuCI 前端公共组件库：页面骨架、卡片/面板、表单控件、
 * 信号仪表与网络能力总评（木桶原理取最差项），以及实时速率折线图。
 */

// 注入新样式
var MT5700_CSS_VERSION = '2.40.0';
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

	api.metric = function (label, value, color) {
		var m = E('div', { 'class': 'mt5700-metric' });
		m.appendChild(E('div', { 'class': 'mt5700-metric-label', title: label || '' }, label));
		var v = E('div', { 'class': 'mt5700-metric-value', title: (value == null ? '' : String(value)) });
		api.metricValue(v, value);
		if (color) v.classList.add(color);
		m.appendChild(v);
		return m;
	};



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

	/*
	 * 空态立绘源码（小吱-喜欢，1000x1000 方图）。
	 *
	 * 整段 innerHTML 注入而不是逐个 appendChild：这幅画有 20 多个渐变 /
	 * 滤镜定义，用 DOM API 拼既不可读也没法维护。defs 里的 id 在注入时
	 * 按实例加后缀（见下方 replace），避免同页多个空态互相串色 ——
	 * 重复 id 会让 url(#...) 全部解析到文档里第一份，渲染虽然一致，
	 * 但调试时根本分不清是哪一份。
	 */
	var MT_ANIME_EMPTY_SEQ = 0;
	var MT_ANIME_EMPTY_SVG = `<defs>
    <!-- 腮红柔化滤镜 -->
    <filter id="soft-blur" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="10" />
    </filter>
    <filter id="glow-blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" />
    </filter>

    <!-- 头发主渐变 -->
    <linearGradient id="hair-base" x1="15%" y1="0%" x2="35%" y2="100%">
      <stop offset="0%" stop-color="#ffdbe8" />
      <stop offset="40%" stop-color="#ffb3cd" />
      <stop offset="85%" stop-color="#f48bb0" />
      <stop offset="100%" stop-color="#e07298" />
    </linearGradient>

    <!-- 头发深色暗部渐变 -->
    <linearGradient id="hair-dark" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#d97596" />
      <stop offset="60%" stop-color="#b55677" />
      <stop offset="100%" stop-color="#8f3d59" />
    </linearGradient>

    <!-- 右侧发髻光照渐变 -->
    <linearGradient id="hair-loop-right" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffd6e5" />
      <stop offset="55%" stop-color="#ffa8c5" />
      <stop offset="100%" stop-color="#e3789c" />
    </linearGradient>

    <!-- 皮肤渐变 -->
    <linearGradient id="skin-base" x1="20%" y1="0%" x2="40%" y2="100%">
      <stop offset="0%" stop-color="#fffaf7" />
      <stop offset="65%" stop-color="#fff0eb" />
      <stop offset="100%" stop-color="#ffe0d8" />
    </linearGradient>

    <!-- 皮肤阴影渐变 -->
    <linearGradient id="skin-shadow" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f7cbc4" />
      <stop offset="100%" stop-color="#ebbab2" stop-opacity="0.6" />
    </linearGradient>

    <!-- 光环金属渐变 -->
    <linearGradient id="halo-metal" x1="0%" y1="30%" x2="100%" y2="60%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="35%" stop-color="#e3e8ed" />
      <stop offset="65%" stop-color="#61666e" />
      <stop offset="88%" stop-color="#383b40" />
      <stop offset="100%" stop-color="#26282b" />
    </linearGradient>

    <!-- 光环内部半透明辉光 -->
    <radialGradient id="halo-inner-glow" cx="50%" cy="50%" r="50%">
      <stop offset="40%" stop-color="#d8e4f0" stop-opacity="0" />
      <stop offset="85%" stop-color="#b0c2d4" stop-opacity="0.35" />
      <stop offset="100%" stop-color="#8da2b8" stop-opacity="0.55" />
    </radialGradient>

    <!-- 白色帽饰渐变 -->
    <linearGradient id="cap-grad" x1="0%" y1="0%" x2="20%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="70%" stop-color="#f5eef0" />
      <stop offset="100%" stop-color="#dfd3d8" />
    </linearGradient>

    <!-- 金元宝船体渐变 -->
    <linearGradient id="ingot-body" x1="10%" y1="0%" x2="30%" y2="100%">
      <stop offset="0%" stop-color="#fff2ad" />
      <stop offset="35%" stop-color="#f7d374" />
      <stop offset="75%" stop-color="#dead46" />
      <stop offset="100%" stop-color="#bd8422" />
    </linearGradient>

    <!-- 金元宝凹槽内壁渐变 -->
    <linearGradient id="ingot-basin" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#c98e28" />
      <stop offset="50%" stop-color="#f0c765" />
      <stop offset="100%" stop-color="#d49a33" />
    </linearGradient>

    <!-- 金元宝中心圆顶径向渐变 -->
    <radialGradient id="ingot-dome" cx="42%" cy="32%" r="62%">
      <stop offset="0%" stop-color="#ffffed" />
      <stop offset="30%" stop-color="#ffea96" />
      <stop offset="70%" stop-color="#ecc05b" />
      <stop offset="100%" stop-color="#c9902c" />
    </radialGradient>

    <!-- 金币正面渐变 -->
    <linearGradient id="coin-face" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff8bf" />
      <stop offset="45%" stop-color="#fae078" />
      <stop offset="85%" stop-color="#e8bd4d" />
      <stop offset="100%" stop-color="#d49e2a" />
    </linearGradient>

    <!-- 金币厚度侧边渐变 -->
    <linearGradient id="coin-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#e3ab42" />
      <stop offset="50%" stop-color="#bd8222" />
      <stop offset="100%" stop-color="#8c5a0e" />
    </linearGradient>

    <!-- 珍珠径向渐变 -->
    <radialGradient id="pearl-sphere" cx="32%" cy="28%" r="68%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="50%" stop-color="#faf2f5" />
      <stop offset="82%" stop-color="#decad2" />
      <stop offset="100%" stop-color="#bfa6b0" />
    </radialGradient>

    <!-- 星星渐变 -->
    <radialGradient id="star-glow" cx="50%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#ffb700" />
      <stop offset="45%" stop-color="#ffdf2b" />
      <stop offset="100%" stop-color="#fff176" />
    </radialGradient>
  </defs>

  <!-- 纯白背景 -->
  <rect width="1000" height="1000" fill="#ffffff" />

  <g stroke-linecap="round" stroke-linejoin="round">

    <!-- ================================================================= -->
    <!-- 1. 后景层：白色软帽、光环、左右双环发髻 -->
    <!-- ================================================================= -->

    <!-- 后方白色软帽/女仆头饰底座 -->
    <g>
      <path d="M 232 455 C 212 268, 392 162, 636 248 C 662 278, 652 338, 622 372 Z" fill="url(#cap-grad)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 帽沿内侧柔和暗部 -->
      <path d="M 244 432 C 242 292, 398 198, 622 268 L 615 310 C 425 230, 275 315, 255 438 Z" fill="#e3d5dc" opacity="0.7" />
    </g>

    <!-- 头顶金属光环与粉色环扣 -->
    <g transform="translate(302, 206) rotate(-32)">
      <!-- 光环内部半透明阴影圈 -->
      <ellipse cx="0" cy="2" rx="122" ry="48" fill="url(#halo-inner-glow)" />
      <!-- 光环主体（带内外圈描边） -->
      <path d="M -136 0 A 136 58 0 1 0 136 0 A 136 58 0 1 0 -136 0 Z
               M -111 4 A 111 42 0 1 1 111 4 A 111 42 0 1 1 -111 4 Z" fill="url(#halo-metal)" fill-rule="evenodd" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 光环高光条 -->
      <path d="M -124 -8 A 124 48 0 0 1 15 -51" fill="none" stroke="#ffffff" stroke-width="4" opacity="0.9" />
      <!-- 光环上的粉色小圆环扣 -->
      <path d="M 28 -65 C 42 -68, 53 -51, 48 -33 C 43 -18, 26 -13, 14 -23 C 4 -32, 7 -54, 21 -63" fill="none" stroke="#2b1d21" stroke-width="13.5" />
      <path d="M 28 -65 C 42 -68, 53 -51, 48 -33 C 43 -18, 26 -13, 14 -23 C 4 -32, 7 -54, 21 -63" fill="none" stroke="#ff73a2" stroke-width="6.5" />
      <path d="M 32 -62 C 40 -62, 45 -50, 42 -38" fill="none" stroke="#ffb8d0" stroke-width="2.5" />
      <!-- 光环顶部淡粉色小蝴蝶结 -->
      <path d="M 14 -72 C 3 -85, -10 -73, 1 -59 C -8 -50, 7 -40, 18 -53 C 24 -60, 20 -68, 14 -72 Z" fill="#ffe0eb" stroke="#2b1d21" stroke-width="4.5" />
      <circle cx="8" cy="-60" r="3.5" fill="#ff85ad" />
    </g>

    <!-- 右上角大环形发髻 -->
    <g>
      <!-- 发髻内壁深色折面 -->
      <path d="M 552 218 C 552 152, 635 122, 678 182 C 705 222, 668 278, 618 272
               C 642 238, 652 185, 620 164 C 594 148, 568 178, 574 218 Z" fill="url(#hair-dark)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 发髻内壁发丝纹理线 -->
      <path d="M 588 162 C 618 165, 635 198, 625 245" fill="none" stroke="#782e47" stroke-width="3" opacity="0.6" />
      <!-- 发髻外层主亮面 -->
      <path d="M 510 245 C 492 158, 584 92, 650 104 C 706 114, 732 190, 696 256 C 676 288, 635 298, 608 285
               C 655 268, 675 210, 640 166 C 614 140, 568 160, 575 225 C 578 248, 558 262, 510 245 Z" fill="url(#hair-loop-right)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 发髻顶部弧形高光 -->
      <path d="M 532 185 C 552 135, 612 115, 658 130" fill="none" stroke="#fff0f5" stroke-width="6" opacity="0.65" />
      <!-- 发髻右下角外翘发尾 -->
      <path d="M 615 284 C 665 316, 712 295, 732 250 C 706 272, 675 275, 648 264 Z" fill="url(#hair-base)" stroke="#2b1d21" stroke-width="5.5" />
    </g>

    <!-- 左侧环形发髻与白色波浪垂带 -->
    <g>
      <!-- 左发髻内部暗面 -->
      <path d="M 255 415 C 182 392, 128 435, 144 486 C 155 522, 215 538, 256 512 Z" fill="url(#hair-dark)" stroke="#2b1d21" stroke-width="5.5" />
      <path d="M 155 465 C 165 495, 205 510, 245 495" fill="none" stroke="#782e47" stroke-width="3" opacity="0.6" />
      <!-- 左发髻外层亮面 -->
      <path d="M 262 394 C 194 348, 114 394, 117 468 C 119 516, 165 540, 206 533
               C 162 508, 150 454, 190 430 C 216 416, 245 430, 258 455 Z" fill="url(#hair-base)" stroke="#2b1d21" stroke-width="5.5" />
      <path d="M 134 435 C 145 398, 185 382, 225 395" fill="none" stroke="#fff0f5" stroke-width="5" opacity="0.6" />
      <!-- 穿插在左发髻下的粉色小发束 -->
      <path d="M 212 502 C 215 532, 232 548, 258 542 C 262 522, 258 498, 245 488 Z" fill="url(#hair-base)" stroke="#2b1d21" stroke-width="5" />
      <!-- 白色波浪形垂带 -->
      <path d="M 256 460 C 218 460, 214 478, 210 498 C 206 516, 166 498, 166 526 C 166 546, 174 564, 175 572
               L 198 558 C 194 536, 222 532, 228 510 C 232 490, 246 488, 262 482 Z" fill="#ffffff" stroke="#2b1d21" stroke-width="5" />
      <path d="M 248 472 C 224 475, 222 492, 218 508 C 214 522, 182 515, 182 536" fill="none" stroke="#dfd3d8" stroke-width="3.5" />
    </g>

    <!-- ================================================================= -->
    <!-- 2. 中后景层：左右两侧后方金元宝 -->
    <!-- ================================================================= -->

    <!-- 左侧后方金元宝 -->
    <g>
      <!-- 船形底座 -->
      <path d="M 192 702 C 184 650, 242 612, 312 614 L 322 776 C 250 786, 202 752, 192 702 Z" fill="url(#ingot-body)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 凹槽阴影 -->
      <path d="M 196 692 C 222 712, 268 718, 305 708 L 302 652 C 255 645, 210 662, 196 692 Z" fill="url(#ingot-basin)" />
      <!-- 元宝圆顶 -->
      <path d="M 222 672 C 238 625, 288 628, 306 672 C 282 690, 245 690, 222 672 Z" fill="url(#ingot-dome)" stroke="#2b1d21" stroke-width="5" />
      <!-- 船沿高光与暗部线 -->
      <path d="M 195 696 C 222 716, 265 722, 295 715" fill="none" stroke="#9e6914" stroke-width="4" />
      <path d="M 200 688 C 215 655, 248 632, 285 628" fill="none" stroke="#fff9c4" stroke-width="3.5" opacity="0.8" />
    </g>

    <!-- 右侧大金元宝 -->
    <g>
      <!-- 元宝船形主体 -->
      <path d="M 654 620 C 664 584, 796 584, 864 638 C 866 696, 836 746, 764 760 C 694 766, 648 700, 654 620 Z" fill="url(#ingot-body)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 元宝顶部凹槽面 -->
      <path d="M 660 626 C 712 666, 804 670, 858 640 C 835 602, 715 595, 660 626 Z" fill="url(#ingot-basin)" />
      <!-- 元宝中心圆顶 -->
      <path d="M 686 626 C 694 560, 788 550, 810 632 C 776 654, 714 650, 686 626 Z" fill="url(#ingot-dome)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 元宝圆顶高光 -->
      <ellipse cx="762" cy="592" rx="14" ry="8" transform="rotate(-12 762 592)" fill="#ffffff" opacity="0.85" />
      <!-- 元宝内沿线与光泽 -->
      <path d="M 662 628 C 714 666, 805 670, 858 642" fill="none" stroke="#8f5d10" stroke-width="4.5" />
      <path d="M 672 638 C 722 672, 802 676, 852 648" fill="none" stroke="#fff8bd" stroke-width="3.5" opacity="0.85" />
    </g>

    <!-- ================================================================= -->
    <!-- 3. 角色身体与服饰细节 -->
    <!-- ================================================================= -->
    <g>
      <!-- 脖子与锁骨区阴影 -->
      <path d="M 510 610 L 568 595 L 575 645 L 515 655 Z" fill="#f2beb6" stroke="#2b1d21" stroke-width="4.5" />
      <!-- 粉色连衣裙主体 -->
      <path d="M 552 615 L 642 605 L 655 785 L 542 785 Z" fill="#ff6699" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 连衣裙暗部褶皱 -->
      <path d="M 565 620 L 622 615 L 628 775 L 595 775 C 602 720, 595 665, 565 620 Z" fill="#e0487b" opacity="0.65" />
      <!-- 侧面黑色百褶荷叶边 -->
      <path d="M 632 632 C 652 638, 654 656, 638 666
               C 656 674, 656 692, 640 702
               C 656 710, 656 728, 638 738
               C 652 746, 650 762, 634 768
               L 614 760 L 618 630 Z" fill="#3d3339" stroke="#2b1d21" stroke-width="5" />
      <!-- 荷叶边内部灰色褶皱线 -->
      <path d="M 622 652 L 638 666 M 620 688 L 640 702 M 618 724 L 638 738" fill="none" stroke="#6e6068" stroke-width="3.5" />
      <!-- 领口蝴蝶结与飘带 -->
      <path d="M 518 628 L 566 602 L 574 646 L 532 662 Z" fill="#3d3339" stroke="#2b1d21" stroke-width="5" />
      <path d="M 544 618 L 562 666" stroke="#ff7aa6" stroke-width="5.5" />
      <path d="M 526 635 L 548 625" stroke="#6e6068" stroke-width="3" />
    </g>

    <!-- ================================================================= -->
    <!-- 4. 角色头部、五官、表情与精细发丝 -->
    <!-- ================================================================= -->

    <!-- 脸部皮肤底座 -->
    <path d="M 314 445 C 294 536, 344 642, 435 645 C 526 648, 628 595, 625 485 C 622 375, 535 320, 440 335 C 355 348, 326 390, 314 445 Z" fill="url(#skin-base)" stroke="#2b1d21" stroke-width="5.5" />

    <!-- 刘海在额头与脸侧投下的柔和皮肤阴影 -->
    <path d="M 318 455 C 335 495, 365 525, 392 538 C 385 512, 378 485, 372 465
             C 395 495, 425 518, 448 525 C 445 505, 442 490, 440 480
             C 462 502, 482 512, 502 515 C 502 498, 498 482, 495 472
             C 528 452, 538 418, 530 380 C 568 412, 594 458, 605 502
             C 622 465, 622 415, 605 370 L 420 340 L 325 395 Z" fill="url(#skin-shadow)" />

    <!-- 双颊红晕与斜线腮红纹理 -->
    <g>
      <ellipse cx="384" cy="586" rx="40" ry="23" transform="rotate(-18 384 586)" fill="#ff8da8" opacity="0.6" filter="url(#soft-blur)" />
      <ellipse cx="572" cy="506" rx="44" ry="24" transform="rotate(-18 572 506)" fill="#ff8da8" opacity="0.65" filter="url(#soft-blur)" />
      <!-- 右脸颊斜线腮红细节 -->
      <g stroke="#f06e8c" stroke-width="3" opacity="0.65">
        <line x1="548" y1="512" x2="554" y2="524" />
        <line x1="562" y1="506" x2="568" y2="518" />
        <line x1="576" y1="500" x2="582" y2="512" />
        <line x1="590" y1="494" x2="596" y2="506" />
      </g>
      <!-- 左脸颊斜线腮红细节 -->
      <g stroke="#f06e8c" stroke-width="3" opacity="0.6">
        <line x1="368" y1="588" x2="374" y2="598" />
        <line x1="382" y1="582" x2="388" y2="592" />
        <line x1="396" y1="576" x2="402" y2="586" />
      </g>
    </g>

    <!-- 开心眯起的左眼（含多层睫毛与内部光泽） -->
    <g>
      <!-- 眼睑上方的双眼皮折线 -->
      <path d="M 374 548 C 384 524, 408 514, 430 518" fill="none" stroke="#7a4953" stroke-width="3" opacity="0.7" />
      <!-- 眯眼主体外框 -->
      <path d="M 385 590 C 376 555, 404 524, 439 532 C 443 542, 436 552, 422 556 C 408 560, 402 572, 396 590 Z" fill="#3d1923" stroke="#2b1d21" stroke-width="5" />
      <!-- 眼睑内侧粉紫色高光带 -->
      <path d="M 392 568 C 397 548, 414 538, 431 542" fill="none" stroke="#c47e90" stroke-width="5.5" />
      <path d="M 396 556 C 404 544, 416 539, 426 541" fill="none" stroke="#ffdae3" stroke-width="2.5" />
      <!-- 眼角睫毛分叉 -->
      <path d="M 382 562 L 366 565 M 384 574 L 372 580" stroke="#2b1d21" stroke-width="4.5" />
      <!-- 左眉毛 -->
      <path d="M 354 512 C 364 490, 386 486, 406 494" fill="none" stroke="#2b1d21" stroke-width="5" />
    </g>

    <!-- 开心眯起的右眼（含多层睫毛与内部光泽） -->
    <g>
      <!-- 双眼皮折线 -->
      <path d="M 520 468 C 542 448, 574 446, 596 458" fill="none" stroke="#7a4953" stroke-width="3" opacity="0.7" />
      <!-- 眯眼主体外框 -->
      <path d="M 514 509 C 510 472, 565 446, 603 472 C 603 485, 588 490, 568 492 C 548 495, 532 504, 514 509 Z" fill="#3d1923" stroke="#2b1d21" stroke-width="5" />
      <!-- 眼睑内侧粉紫色高光带 -->
      <path d="M 525 493 C 542 472, 572 464, 591 476" fill="none" stroke="#c47e90" stroke-width="5.5" />
      <path d="M 538 482 C 552 470, 572 467, 585 474" fill="none" stroke="#ffdae3" stroke-width="2.5" />
      <!-- 右眼外眼角睫毛 -->
      <path d="M 600 470 L 614 466 M 598 480 L 610 482" stroke="#2b1d21" stroke-width="4.5" />
      <!-- 右眉毛 -->
      <path d="M 472 432 C 495 414, 528 414, 552 425" fill="none" stroke="#2b1d21" stroke-width="5.5" />
    </g>

    <!-- 微笑张开的猫咪嘴 -->
    <g>
      <!-- 口腔内部底色 -->
      <path d="M 477 559 C 488 594, 529 596, 533 559 C 535 547, 530 536, 526 534 C 512 548, 492 556, 477 559 Z" fill="#c95b6e" stroke="#612836" stroke-width="4.5" />
      <!-- 粉嫩舌头亮面 -->
      <path d="M 484 568 C 495 592, 528 592, 532 562 C 520 554, 498 558, 484 568 Z" fill="#ff9eb0" />
      <!-- 上唇猫咪弧线 -->
      <path d="M 464 564 C 480 563, 496 556, 504 548 C 514 546, 526 538, 534 526" fill="none" stroke="#612836" stroke-width="5" />
    </g>

    <!-- 头发主层（右后垂发、两侧鬓角、多层次刘海、呆毛） -->
    <g>
      <!-- 右侧垂在肩膀与元宝前的深色发束 -->
      <path d="M 614 542 C 628 605, 648 656, 676 682 C 686 646, 678 590, 658 545 Z" fill="url(#hair-dark)" stroke="#2b1d21" stroke-width="5.5" />
      <path d="M 632 565 C 644 610, 656 645, 670 668" fill="none" stroke="#8f3d59" stroke-width="3.5" />

      <!-- 左侧贴脸长鬓角（带内侧暗面层） -->
      <path d="M 295 450 C 288 515, 302 582, 345 612 L 315 625 C 275 585, 265 515, 280 450 Z" fill="url(#hair-dark)" />
      <path d="M 278 335 C 242 415, 245 555, 282 628 C 308 632, 332 622, 345 612
               C 320 572, 312 512, 324 462 Z" fill="url(#hair-base)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 左鬓角发丝细线 -->
      <path d="M 272 465 C 268 525, 278 585, 302 624" fill="none" stroke="#d4688c" stroke-width="3.5" />

      <!-- 右侧蓬松外翘侧发（带层次暗部与发丝线） -->
      <path d="M 555 262 C 655 292, 725 385, 722 475 C 742 495, 765 535, 798 532
               C 788 565, 762 578, 742 576 C 755 595, 768 602, 778 605
               C 748 618, 722 612, 705 595 C 712 612, 718 625, 722 632
               C 685 625, 658 598, 645 568 C 618 575, 598 575, 588 570
               C 618 540, 635 505, 635 468 C 615 495, 598 508, 585 512
               C 612 465, 615 412, 595 368 Z" fill="url(#hair-base)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 右侧侧发阴影色块 -->
      <path d="M 722 475 C 712 515, 685 548, 645 568 C 658 595, 682 618, 715 628
               C 708 612, 702 595, 705 595 C 722 610, 745 615, 770 604
               C 752 595, 740 576, 740 576 C 725 565, 715 535, 722 475 Z" fill="#e3789c" opacity="0.45" />

      <!-- 额前主刘海 -->
      <path d="M 372 325 C 345 268, 455 222, 578 268
               C 615 282, 655 325, 668 385
               C 645 375, 622 365, 602 355
               C 625 405, 625 465, 602 505
               C 592 462, 565 415, 525 385
               C 535 425, 522 462, 495 485
               C 498 498, 498 508, 495 518
               C 472 512, 452 502, 438 488
               C 442 505, 445 518, 442 528
               C 412 518, 385 495, 368 468
               C 372 495, 378 525, 388 542
               C 352 525, 325 492, 315 452
               C 305 472, 298 492, 295 508
               C 272 468, 275 395, 312 342
               C 332 315, 358 312, 372 325 Z" fill="url(#hair-base)" stroke="#2b1d21" stroke-width="5.5" />

      <!-- 额前发根深色凹陷阴影（发际分缝处） -->
      <path d="M 382 322 C 385 282, 445 268, 498 298 C 462 302, 415 318, 382 322 Z" fill="url(#hair-dark)" stroke="#2b1d21" stroke-width="4.5" />

      <!-- 刘海内部结构线与发丝纹理 -->
      <path d="M 385 385 C 402 435, 445 475, 495 485" fill="none" stroke="#2b1d21" stroke-width="5" />
      <path d="M 442 355 C 468 395, 502 422, 528 425" fill="none" stroke="#2b1d21" stroke-width="4.5" />
      <path d="M 628 465 C 665 455, 695 425, 712 385" fill="none" stroke="#2b1d21" stroke-width="5" />
      <path d="M 645 568 C 685 548, 712 518, 722 475" fill="none" stroke="#2b1d21" stroke-width="5" />
      <!-- 粉色细发丝内部刻画 -->
      <path d="M 345 405 C 348 455, 365 495, 385 525" fill="none" stroke="#d4688c" stroke-width="3" />
      <path d="M 408 372 C 425 425, 455 462, 488 475" fill="none" stroke="#d4688c" stroke-width="3" />
      <path d="M 488 338 C 525 362, 565 405, 592 458" fill="none" stroke="#d4688c" stroke-width="3.5" />

      <!-- 刘海椭圆高光群 -->
      <ellipse cx="445" cy="395" rx="20" ry="11" transform="rotate(-25 445 395)" fill="#fff5f8" opacity="0.88" />
      <ellipse cx="528" cy="365" rx="24" ry="12" transform="rotate(-15 528 365)" fill="#fff5f8" opacity="0.88" />
      <ellipse cx="346" cy="435" rx="15" ry="9" transform="rotate(-35 346 435)" fill="#fff5f8" opacity="0.8" />
      <circle cx="482" cy="382" r="6" fill="#ffffff" opacity="0.9" />
      <circle cx="382" cy="418" r="5" fill="#ffffff" opacity="0.85" />

      <!-- 左侧高高翘起的长呆毛 -->
      <path d="M 372 325 C 335 202, 252 192, 210 295 C 184 356, 184 426, 198 476
               C 202 415, 218 345, 252 292 C 285 242, 332 258, 365 332 Z" fill="url(#hair-base)" stroke="#2b1d21" stroke-width="5.5" />
      <path d="M 232 268 C 262 222, 312 222, 348 275" fill="none" stroke="#fff5f8" stroke-width="4.5" opacity="0.75" />
    </g>

    <!-- 额前白色云朵荷叶边发带（带内部立体褶皱） -->
    <g>
      <path d="M 310 438 C 298 418, 310 390, 335 390 C 338 370, 355 360, 372 366
               C 375 344, 402 330, 425 340 C 435 316, 465 314, 482 324
               C 496 316, 514 328, 508 346 C 495 364, 468 366, 452 355
               C 442 376, 418 386, 398 378 C 388 396, 368 402, 355 398
               C 355 418, 338 442, 310 438 Z" fill="#ffffff" stroke="#2b1d21" stroke-width="5" />
      <!-- 发带分段褶皱阴影线 -->
      <path d="M 335 390 C 344 394, 350 396, 355 398" fill="none" stroke="#d4c5cb" stroke-width="4" />
      <path d="M 372 366 C 382 372, 390 376, 398 378" fill="none" stroke="#d4c5cb" stroke-width="4" />
      <path d="M 425 340 C 435 348, 444 352, 452 355" fill="none" stroke="#d4c5cb" stroke-width="4" />
    </g>

    <!-- 右上刘海十字发夹 -->
    <g>
      <!-- 发夹下方投影 -->
      <path d="M 560 362 L 636 322 L 642 336 L 566 376 Z" fill="#b55677" opacity="0.5" />
      <!-- 横向底条 -->
      <path d="M 556 355 L 632 315 L 640 332 L 564 372 Z" fill="#382228" stroke="#211216" stroke-width="4.5" />
      <path d="M 565 360 L 631 324" stroke="#c95b78" stroke-width="4.5" />
      <!-- 纵向顶条 -->
      <path d="M 598 302 L 616 305 L 596 382 L 578 378 Z" fill="#382228" stroke="#211216" stroke-width="4.5" />
      <path d="M 606 310 L 588 374" stroke="#c95b78" stroke-width="4.5" />
    </g>

    <!-- ================================================================= -->
    <!-- 5. 前景主金元宝与角色双手 -->
    <!-- ================================================================= -->

    <!-- 正前方主金元宝 -->
    <g>
      <!-- 元宝船形底座 -->
      <path d="M 270 672 C 268 648, 310 638, 345 642 C 405 648, 472 648, 528 638
               C 545 636, 548 665, 542 705 C 532 768, 475 815, 405 815
               C 332 815, 274 758, 270 672 Z" fill="url(#ingot-body)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 元宝底部暖金反光层 -->
      <path d="M 285 725 C 315 785, 475 795, 532 720 C 522 772, 468 812, 405 812 C 338 812, 295 772, 285 725 Z" fill="#b87b18" opacity="0.45" />
      <!-- 元宝顶面凹槽暗部 -->
      <path d="M 274 668 C 325 718, 485 718, 542 665 C 542 645, 525 638, 495 642
               C 435 650, 355 650, 305 642 C 282 640, 272 652, 274 668 Z" fill="url(#ingot-basin)" stroke="#2b1d21" stroke-width="5" />
      <!-- 元宝船沿亮边高光 -->
      <path d="M 278 674 C 328 720, 482 720, 538 670" fill="none" stroke="#fff9c4" stroke-width="4.5" opacity="0.9" />
      <!-- 元宝中央圆润凸起 -->
      <path d="M 328 675 C 328 594, 472 584, 482 678 C 442 702, 368 702, 328 675 Z" fill="url(#ingot-dome)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 元宝高光点 -->
      <ellipse cx="428" cy="634" rx="16" ry="10" transform="rotate(-15 428 634)" fill="#ffffff" opacity="0.9" />
      <circle cx="398" cy="648" r="5.5" fill="#ffffff" opacity="0.85" />
    </g>

    <!-- 角色右手（搭在主元宝顶部的白手套） -->
    <g>
      <path d="M 325 638 C 318 612, 352 588, 385 592 C 405 595, 412 608, 402 618
               C 392 628, 368 625, 352 642 C 342 652, 328 650, 325 638 Z" fill="#ffffff" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 手套底部柔和阴影 -->
      <path d="M 330 642 C 345 648, 362 630, 398 616 C 388 625, 365 628, 350 644 Z" fill="#d9cdd2" />
      <!-- 手套指缝线 -->
      <path d="M 342 642 C 348 625, 362 612, 375 608" fill="none" stroke="#2b1d21" stroke-width="4.5" />
      <path d="M 362 632 C 368 618, 380 608, 392 605" fill="none" stroke="#2b1d21" stroke-width="4.5" />
    </g>

    <!-- 角色左臂与左手（抱住金元宝右侧） -->
    <g>
      <!-- 肩膀与手臂皮肤 -->
      <path d="M 572 608 C 585 572, 628 575, 632 618 L 605 725 L 518 765 L 502 732 L 568 682 Z" fill="url(#skin-base)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 手臂内侧阴影 -->
      <path d="M 565 688 L 515 732 L 525 752 L 592 715 Z" fill="#f2cbc4" opacity="0.6" />
      <!-- 白色泡泡袖口与绊带纽扣 -->
      <path d="M 560 642 C 585 634, 622 640, 638 655 C 642 688, 625 715, 592 715
               C 565 715, 550 688, 560 642 Z" fill="#ffffff" stroke="#2b1d21" stroke-width="5.5" />
      <path d="M 564 655 C 588 650, 618 655, 634 666" fill="none" stroke="#d9cdd2" stroke-width="4" />
      <!-- 袖口袢带与小圆点扣 -->
      <path d="M 578 668 L 598 670 L 594 698 L 574 695 Z" fill="#f5eef0" stroke="#2b1d21" stroke-width="4" />
      <circle cx="586" cy="684" r="2.5" fill="#2b1d21" />
      <!-- 左手白色手套（带腕部荷叶褶边） -->
      <path d="M 496 716 C 515 720, 538 744, 546 768 C 532 785, 518 792, 505 792
               C 492 808, 462 820, 442 815 C 438 802, 448 792, 458 785
               C 448 778, 452 762, 468 755 C 462 745, 472 735, 485 735 Z" fill="#ffffff" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 手套手腕褶皱与指缝 -->
      <path d="M 492 732 C 508 738, 522 752, 528 772" fill="none" stroke="#cfc2c8" stroke-width="4.5" />
      <path d="M 458 785 C 474 778, 488 772, 502 768" fill="none" stroke="#2b1d21" stroke-width="4" />
      <path d="M 468 755 C 480 752, 492 750, 500 750" fill="none" stroke="#2b1d21" stroke-width="4" />
    </g>

    <!-- ================================================================= -->
    <!-- 6. 精细金币堆（带立体侧边与船锚十字浮雕）、切面蓝宝石、珍珠 -->
    <!-- ================================================================= -->

    <!-- 金币1：最左侧竖立金币 -->
    <g>
      <path d="M 155 662 C 185 645, 232 685, 252 745 C 272 805, 245 842, 212 842
               C 178 842, 142 785, 138 725 C 135 685, 142 668, 155 662 Z" fill="url(#coin-rim)" stroke="#2b1d21" stroke-width="5.5" />
      <!-- 侧边刻度纹理 -->
      <path d="M 142 705 L 160 700 M 142 735 L 162 728 M 148 765 L 168 756 M 160 795 L 180 785" stroke="#8c5a0e" stroke-width="3.5" />
      <ellipse cx="206" cy="748" rx="44" ry="88" transform="rotate(-22 206 748)" fill="url(#coin-face)" stroke="#2b1d21" stroke-width="5" />
      <ellipse cx="206" cy="748" rx="33" ry="72" transform="rotate(-22 206 748)" fill="none" stroke="#dead46" stroke-width="3.5" />
      <!-- 币面浮雕纹样 -->
      <path d="M 186 715 C 202 708, 222 735, 222 768 M 185 745 L 222 735" fill="none" stroke="#dead46" stroke-width="5.5" />
    </g>

    <!-- 金币2：左下倾斜金币 -->
    <g>
      <path d="M 255 768 C 285 735, 365 768, 398 825 C 415 855, 395 882, 355 880
               C 305 878, 242 825, 255 768 Z" fill="url(#coin-rim)" stroke="#2b1d21" stroke-width="5.5" />
      <ellipse cx="332" cy="814" rx="76" ry="44" transform="rotate(28 332 814)" fill="url(#coin-face)" stroke="#2b1d21" stroke-width="5" />
      <ellipse cx="332" cy="814" rx="60" ry="32" transform="rotate(28 332 814)" fill="none" stroke="#e0a638" stroke-width="3.5" />
      <!-- 船锚十字浮雕 -->
      <path d="M 294 794 L 366 834 M 316 792 L 304 816 M 342 802 C 362 816, 352 838, 326 832" fill="none" stroke="#e0a638" stroke-width="5.5" />
      <circle cx="290" cy="791" r="5" fill="none" stroke="#e0a638" stroke-width="4" />
    </g>

    <!-- 金币3：底部中后枚平铺金币 -->
    <g>
      <path d="M 465 812 C 465 785, 612 775, 615 805 L 615 832 C 612 858, 465 865, 465 838 Z" fill="url(#coin-rim)" stroke="#2b1d21" stroke-width="5.5" />
      <ellipse cx="540" cy="805" rx="74" ry="24" transform="rotate(-5 540 805)" fill="url(#coin-face)" stroke="#2b1d21" stroke-width="5" />
      <ellipse cx="540" cy="805" rx="55" ry="15" transform="rotate(-5 540 805)" fill="none" stroke="#e0a638" stroke-width="3.5" />
    </g>

    <!-- 金币4：底部中左枚平铺金币 -->
    <g>
      <path d="M 358 842 C 358 820, 488 820, 488 842 L 488 865 C 488 885, 358 885, 358 865 Z" fill="url(#coin-rim)" stroke="#2b1d21" stroke-width="5.5" />
      <path d="M 385 858 L 385 878 M 415 860 L 415 880 M 445 860 L 445 880" stroke="#8c5a0e" stroke-width="3.5" />
      <ellipse cx="423" cy="842" rx="64" ry="20" fill="url(#coin-face)" stroke="#2b1d21" stroke-width="5" />
      <ellipse cx="423" cy="842" rx="46" ry="12" fill="none" stroke="#e0a638" stroke-width="3.5" />
    </g>

    <!-- 金币5：底部中右枚平铺金币 -->
    <g>
      <path d="M 542 838 C 542 812, 688 812, 688 838 L 688 865 C 688 888, 542 888, 542 865 Z" fill="url(#coin-rim)" stroke="#2b1d21" stroke-width="5.5" />
      <path d="M 575 858 L 575 880 M 615 860 L 615 882 M 655 858 L 655 878" stroke="#8c5a0e" stroke-width="3.5" />
      <ellipse cx="615" cy="838" rx="72" ry="22" fill="url(#coin-face)" stroke="#2b1d21" stroke-width="5" />
      <ellipse cx="615" cy="836" rx="52" ry="14" fill="none" stroke="#e0a638" stroke-width="3.5" />
      <path d="M 585 836 L 645 836 M 615 828 L 615 844" stroke="#e0a638" stroke-width="4.5" />
    </g>

    <!-- 金币6：右侧偏上大金币 -->
    <g>
      <path d="M 658 725 C 668 662, 725 618, 765 638 C 795 652, 792 718, 762 768
               C 732 812, 650 785, 658 725 Z" fill="url(#coin-rim)" stroke="#2b1d21" stroke-width="5.5" />
      <ellipse cx="715" cy="705" rx="74" ry="50" transform="rotate(-55 715 705)" fill="url(#coin-face)" stroke="#2b1d21" stroke-width="5" />
      <ellipse cx="715" cy="705" rx="58" ry="38" transform="rotate(-55 715 705)" fill="none" stroke="#e0a638" stroke-width="3.5" />
      <!-- 船锚十字浮雕 -->
      <path d="M 695 738 L 732 672 M 700 715 L 726 728 M 695 695 C 712 678, 738 695, 725 718" fill="none" stroke="#e0a638" stroke-width="5.5" />
    </g>

    <!-- 金币7：最右侧斜伸金币 -->
    <g>
      <path d="M 785 772 C 815 738, 882 718, 895 745 C 908 772, 858 825, 805 832 Z" fill="url(#coin-rim)" stroke="#2b1d21" stroke-width="5.5" />
      <ellipse cx="838" cy="775" rx="62" ry="30" transform="rotate(-30 838 775)" fill="url(#coin-face)" stroke="#2b1d21" stroke-width="5" />
      <ellipse cx="838" cy="775" rx="46" ry="20" transform="rotate(-30 838 775)" fill="none" stroke="#e0a638" stroke-width="3.5" />
      <path d="M 812 788 L 862 760 M 828 762 C 845 758, 855 772, 842 785" fill="none" stroke="#e0a638" stroke-width="4.5" />
    </g>

    <!-- 金币8：右下前景大金币 -->
    <g>
      <path d="M 678 815 C 675 765, 745 715, 795 735 C 835 752, 822 825, 775 862
               C 732 895, 680 865, 678 815 Z" fill="url(#coin-rim)" stroke="#2b1d21" stroke-width="5.5" />
      <ellipse cx="742" cy="798" rx="76" ry="52" transform="rotate(-38 742 798)" fill="url(#coin-face)" stroke="#2b1d21" stroke-width="5.5" />
      <ellipse cx="742" cy="798" rx="60" ry="39" transform="rotate(-38 742 798)" fill="none" stroke="#e0a638" stroke-width="3.5" />
      <!-- 清晰的船锚十字浮雕 -->
      <path d="M 708 825 L 775 772 M 736 782 L 758 808 M 706 798 C 702 822, 725 836, 748 824" fill="none" stroke="#e0a638" stroke-width="6" />
      <circle cx="778" cy="769" r="5" fill="none" stroke="#e0a638" stroke-width="4" />
    </g>

    <!-- 4颗多切面蓝宝石（含高光切面、中调切面与深蓝背光面） -->
    <!-- 1. 左侧蓝宝石 -->
    <g>
      <polygon points="196,795 218,770 250,776 260,804 235,850 196,828" fill="#78ccf5" stroke="#2b1d21" stroke-width="5" />
      <polygon points="218,770 250,776 240,800 208,796" fill="#d4f2ff" />
      <polygon points="196,795 218,770 208,796" fill="#9be0ff" />
      <polygon points="208,796 240,800 235,850 196,828" fill="#62bce8" />
      <polygon points="240,800 260,804 235,850" fill="#398ec2" />
      <path d="M 196 795 L 240 800 L 260 804 M 218 770 L 208 796 L 235 850 L 240 800 L 250 776" fill="none" stroke="#2b1d21" stroke-width="3.5" />
    </g>

    <!-- 2. 中左蓝宝石 -->
    <g>
      <polygon points="375,812 396,784 428,790 438,818 418,864 376,845" fill="#78ccf5" stroke="#2b1d21" stroke-width="5" />
      <polygon points="396,784 428,790 416,816 386,810" fill="#d4f2ff" />
      <polygon points="386,810 416,816 418,864 376,845" fill="#62bce8" />
      <polygon points="416,816 438,818 418,864" fill="#398ec2" />
      <path d="M 375 812 L 416 816 L 438 818 M 396 784 L 386 810 L 418 864 L 416 816 L 428 790" fill="none" stroke="#2b1d21" stroke-width="3.5" />
    </g>

    <!-- 3. 中右蓝宝石 -->
    <g>
      <polygon points="626,765 655,744 688,754 694,785 662,830 630,798" fill="#78ccf5" stroke="#2b1d21" stroke-width="5" />
      <polygon points="655,744 688,754 672,780 642,772" fill="#d4f2ff" />
      <polygon points="642,772 672,780 662,830 630,798" fill="#62bce8" />
      <polygon points="672,780 694,785 662,830" fill="#398ec2" />
      <path d="M 626 765 L 672 780 L 694 785 M 655 744 L 642 772 L 662 830 L 672 780 L 688 754" fill="none" stroke="#2b1d21" stroke-width="3.5" />
    </g>

    <!-- 4. 右上蓝宝石 -->
    <g>
      <polygon points="720,728 748,706 784,716 788,745 752,762 724,748" fill="#78ccf5" stroke="#2b1d21" stroke-width="5" />
      <polygon points="748,706 784,716 765,738 735,730" fill="#d4f2ff" />
      <polygon points="765,738 784,716 788,745 752,762" fill="#398ec2" />
      <path d="M 720 728 L 765 738 L 788 745 M 748 706 L 735 730 L 752 762 L 765 738 L 784 716" fill="none" stroke="#2b1d21" stroke-width="3.5" />
    </g>

    <!-- 7颗圆润白珍珠（带高光点与底侧反光） -->
    <g>
      <!-- 1. 左后珍珠 -->
      <circle cx="246" cy="765" r="14" fill="url(#pearl-sphere)" stroke="#2b1d21" stroke-width="4.5" />
      <circle cx="241" cy="759" r="3.5" fill="#ffffff" />
      <!-- 2. 左前珍珠 -->
      <circle cx="216" cy="852" r="17" fill="url(#pearl-sphere)" stroke="#2b1d21" stroke-width="5" />
      <circle cx="210" cy="845" r="4.5" fill="#ffffff" />
      <!-- 3. 左下大珍珠 -->
      <circle cx="360" cy="865" r="18" fill="url(#pearl-sphere)" stroke="#2b1d21" stroke-width="5" />
      <circle cx="354" cy="858" r="4.5" fill="#ffffff" />
      <!-- 4. 左下小珍珠 -->
      <circle cx="386" cy="877" r="12.5" fill="url(#pearl-sphere)" stroke="#2b1d21" stroke-width="4.5" />
      <circle cx="382" cy="872" r="3" fill="#ffffff" />
      <!-- 5. 右中珍珠 -->
      <circle cx="802" cy="745" r="15" fill="url(#pearl-sphere)" stroke="#2b1d21" stroke-width="4.5" />
      <circle cx="797" cy="739" r="3.5" fill="#ffffff" />
      <!-- 6. 右下外侧珍珠 -->
      <circle cx="826" cy="825" r="17" fill="url(#pearl-sphere)" stroke="#2b1d21" stroke-width="5" />
      <circle cx="820" cy="818" r="4.5" fill="#ffffff" />
      <!-- 7. 右下内侧珍珠 -->
      <circle cx="805" cy="846" r="15" fill="url(#pearl-sphere)" stroke="#2b1d21" stroke-width="5" />
      <circle cx="800" cy="840" r="4" fill="#ffffff" />
    </g>

    <!-- ================================================================= -->
    <!-- 7. 四角星闪光特效（3处） -->
    <!-- ================================================================= -->

    <!-- 左侧四角星（带柔和白晕衬底以区分发梢与金元宝） -->
    <g transform="translate(225, 595)">
      <path d="M 0 -52 C 6 -18, 14 -10, 42 -6 C 14 2, 8 12, 4 52 C -4 14, -12 4, -40 2 C -12 -6, -6 -16, 0 -52 Z" fill="none" stroke="#ffffff" stroke-width="11" />
      <path d="M 0 -52 C 6 -18, 14 -10, 42 -6 C 14 2, 8 12, 4 52 C -4 14, -12 4, -40 2 C -12 -6, -6 -16, 0 -52 Z" fill="url(#star-glow)" />
      <ellipse cx="1" cy="-1" rx="8" ry="12" fill="#f59e00" opacity="0.55" filter="url(#glow-blur)" />
    </g>

    <!-- 右上刘海四角星（保留发丝上的白色分离轮廓） -->
    <g transform="translate(675, 360)">
      <path d="M 0 -46 C 5 -15, 12 -8, 38 -4 C 12 2, 6 10, 2 46 C -4 12, -10 4, -36 2 C -10 -4, -5 -14, 0 -46 Z" fill="none" stroke="#ffffff" stroke-width="12" />
      <path d="M 0 -46 C 5 -15, 12 -8, 38 -4 C 12 2, 6 10, 2 46 C -4 12, -10 4, -36 2 C -10 -4, -5 -14, 0 -46 Z" fill="url(#star-glow)" />
      <ellipse cx="1" cy="0" rx="7" ry="10" fill="#f59e00" opacity="0.55" filter="url(#glow-blur)" />
    </g>

    <!-- 最右侧独立四角星 -->
    <g transform="translate(840, 495)">
      <path d="M 4 -54 C 8 -18, 16 -10, 44 -4 C 16 4, 8 14, -2 54 C -6 14, -14 4, -42 -2 C -14 -8, -4 -18, 4 -54 Z" fill="url(#star-glow)" />
      <ellipse cx="1" cy="0" rx="8" ry="12" fill="#f59e00" opacity="0.55" filter="url(#glow-blur)" />
    </g>

  </g>`;

	api.empty = function (text) {
		var el = E('div', { 'class': 'mt5700-empty' });
		/*
		 * 140px 见方：原图是 1000x1000 的方图；空态容器（.mt5700-empty）
		 * 上下留白 36px，140px 在 320px 窄屏上也放得下，再大就开始挤正文。
		 */
		var svg = svgEl('svg', {
			'class': 'mt-anime-empty-svg',
			viewBox: '0 0 1000 1000',
			width: '140',
			height: '140',
			xmlns: 'http://www.w3.org/2000/svg'
		});
		var uid = ++MT_ANIME_EMPTY_SEQ;
		svg.innerHTML = MT_ANIME_EMPTY_SVG
			.replace(/id="([^"]+)"/g, 'id="$1-' + uid + '"')
			.replace(/url\(#([^)]+)\)/g, 'url(#$1-' + uid + ')');
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
