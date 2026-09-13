'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/rpc';
'require at-webserver/parse';
/* global L, AtWs, Parse, baseclass */

/**
 * MT5700 LuCI 前端 - Modern Dimensional Layering 组件系统 v2
 * 软极简 + 玻璃拟态材质 + 现代数据看板
 */

// 注入新样式
var MT5700_CSS_VERSION = '2.7.0';
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
		// 文本内容：字符串走 textContent，DOM 节点直接挂载（避免被 String() 序列化成 [object HTMLDivElement]）
		if (text != null) {
			if (typeof text === 'object' && text.nodeType) {
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

	/* ================= 页面结构 ================= */

	// 页面容器
	api.page = function (title, subtitle) {
		var node = E('div', { 'class': 'mt5700-page' });
		var h = E('div', { 'class': 'mt5700-page-header' });
		h.appendChild(E('h2', { 'class': 'mt5700-page-title' }, title || ''));
		if (subtitle) h.appendChild(E('p', { 'class': 'mt5700-page-subtitle' }, subtitle));
		node.appendChild(h);
		var body = E('div', { 'class': 'mt5700-page-body' });
		node.appendChild(body);
		node._body = body;
		return node;
	};

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
	 * 单位白名单：显式枚举，避免把「5G」「100%」这类纯文本误拆。
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
		 * 不传时行为与旧版完全一致，不影响既有调用。 */
		if (status) m.classList.add(status);
		return m;
	};

	/*
	 * 把网格内实际项数写入 data-count，供 CSS 选择最均衡的列数（尾行不留大片空白）。
	 * 调用时机：向 .mt5700-metrics 追加完所有 .mt5700-metric 之后。
	 * 幂等，可重复调用。
	 */
	api.syncMetrics = function (grid) {
		if (!grid) return grid;
		var n = grid.querySelectorAll('.mt5700-metric').length;
		if (n > 0) grid.setAttribute('data-count', String(n));
		else grid.removeAttribute('data-count');
		return grid;
	};

	/* ================= 温度状态判定 ================= */

	/*
	 * 模组温度分级（单位 ℃）—— 各芯片独立判定，互不平均。
	 *
	 * 阈值表驱动：按 min 从高到低匹配，首个满足 value >= min 的档位即结果。
	 * 档位由低到高（6 档）：
	 *   cold    深蓝    < 35        偏低（芯片刚上电/低温环境）
	 *   cool    蓝      35 - 52.9   温和
	 *   normal  绿      53 - 60.9   正常（长期工作舒适区）
	 *   warm    黄      61 - 68.9   偏暖（关注）
	 *   hot     橙      69 - 76.9   偏高（需散热）
	 *   high    红      >= 77       过高（告警）
	 *
	 * 阈值按 MT5700 实测区间（各芯片常态 40-50℃）校准，
	 * 使常驻温度落在 cool/normal 档，异常升温能逐级显现。
	 * 无效值（null / NaN / <= 0）返回 null，表示暂无数据，不参与着色。
	 */
	api.TEMP_LEVELS = [
		{ level: 'high',   min: 77 },
		{ level: 'hot',    min: 69 },
		{ level: 'warm',   min: 61 },
		{ level: 'normal', min: 53 },
		{ level: 'cool',   min: 35 },
		{ level: 'cold',   min: -Infinity }
	];

	/* 兼容旧字段：高危/告警阈值（供外部按单值判断时复用） */
	api.TEMP_WARN_C = 61;
	api.TEMP_HIGH_C = 77;

	api.tempLevel = function (value) {
		if (value == null || isNaN(value) || value <= 0) return null;
		for (var i = 0; i < api.TEMP_LEVELS.length; i++) {
			if (value >= api.TEMP_LEVELS[i].min) return api.TEMP_LEVELS[i].level;
		}
		return 'cold';
	};

	/* 温度等级 → CSS 状态类名 */
	api.tempClass = function (value) {
		var lv = api.tempLevel(value);
		return lv ? 'temp-' + lv : '';
	};

	/* 温度等级 → 中文标签（供汇总提示/无障碍属性使用） */
	api.TEMP_LABELS = {
		cold: '偏低', cool: '温和', normal: '正常',
		warm: '偏暖', hot: '偏高', high: '过高'
	};

	api.tempLabel = function (value) {
		var lv = api.tempLevel(value);
		return lv ? (api.TEMP_LABELS[lv] || '') : '';
	};

	/* ================= 环形仪表 (Circular Gauge) ================= */

	// 信号等级色 (绿→青→黄→橙→红)
	var GAUGE_COLORS = { exc: '#10b981', good: '#06b6d4', fair: '#f59e0b', poor: '#f97316', bad: '#ef4444' };
	var GAUGE_CAPTIONS = { exc: '优秀', good: '良好', fair: '一般', poor: '较差', bad: '极差' };

	/*
	 * 各指标在每一档位该说的人话。
	 * 仪表本身的数值（-64 dBm）只有专业用户看得懂，这里补一层「这意味着什么」，
	 * 让普通用户也能判断当前信号够不够用。
	 */
	var GAUGE_PLAIN = {
		rsrp: {
			exc: '信号很强，网速跑得动',
			good: '信号够用，日常使用顺畅',
			fair: '信号一般，速度可能偏慢',
			poor: '信号偏弱，容易卡顿掉线',
			bad: '信号极弱，基本无法上网'
		},
		rsrq: {
			exc: '信号纯净，干扰很小',
			good: '信号质量不错',
			fair: '有一定干扰，速度受影响',
			bad: '干扰严重，上网体验差'
		},
		sinr: {
			exc: '干扰极小，网速接近峰值',
			good: '干扰较小，网速稳定',
			fair: '干扰明显，速度会打折',
			bad: '干扰严重，容易出现卡顿'
		},
		pct: {
			exc: '综合信号非常好',
			good: '综合信号良好',
			fair: '综合信号一般',
			bad: '综合信号较差'
		}
	};

	/*
	 * 各信号指标使用独立阈值与量程，绝不共用一套 0-100% 算法：
	 *   RSRP (dBm): >=-80 优秀 / >=-90 良好 / >=-100 一般 / >=-110 较差 / 更低 极差
	 *   RSRQ (dB) : >=-10 优秀 / >=-15 良好 / >=-20 一般 / 更低 极差
	 *   SINR (dB) : >=20 优秀 / >=13 良好 / >=5 一般 / 更低 极差
	 * 量程仅用于弧长百分比映射（视觉刻度），等级判定只看阈值。
	 */
	var SIGNAL_SPECS = {
		rsrp: {
			min: -140, max: -44,
			level: function (v) {
				return v >= -80 ? 'exc' : v >= -90 ? 'good' : v >= -100 ? 'fair' : v >= -110 ? 'poor' : 'bad';
			}
		},
		rsrq: {
			min: -20, max: -3,
			level: function (v) {
				return v >= -10 ? 'exc' : v >= -15 ? 'good' : v >= -20 ? 'fair' : 'bad';
			}
		},
		sinr: {
			min: -10, max: 30,
			level: function (v) {
				return v >= 20 ? 'exc' : v >= 13 ? 'good' : v >= 5 ? 'fair' : 'bad';
			}
		},
		/* 信号百分比（0-100）：阈值与 RSRP 分级对齐（-80→75 / -90→50 / -100→25） */
		pct: {
			min: 0, max: 100,
			level: function (v) {
				return v >= 75 ? 'exc' : v >= 50 ? 'good' : v >= 25 ? 'fair' : 'bad';
			}
		}
	};

	// 判定信号等级（kind: rsrp | rsrq | sinr | pct），无法判定时返回 null
	api.signalLevel = function (kind, value) {
		var spec = SIGNAL_SPECS[kind];
		if (!spec || value == null || isNaN(value)) return null;
		return spec.level(value);
	};

	api.signalCaption = function (level) {
		return GAUGE_CAPTIONS[level] || '';
	};

	api.signalPlain = function (kind, level) {
		var m = GAUGE_PLAIN[kind];
		return (m && m[level]) || '';
	};

	/**
	 * 创建环形仪表。SVG viewBox 缩放自适应容器，DOM 开销固定（1 svg + 2 circle）。
	 * 返回 { el, set(value), setSub(text), setPlain(text) }。
	 *
	 * opts:
	 *   sub   —— 英文缩写（如 RSRP），显示在中文标签下方，保留给专业用户对照手册
	 *   plain —— 是否启用「人话描述」行（默认启用）
	 *
	 * 关于弧长的两点修正：
	 *   1. 量程按各指标物理可达范围设定（RSRP -140~-44 而非 -120~-70），
	 *      否则稍好的信号一律顶到满圈，用户无法分辨 -64 与 -80 的差别。
	 *   2. 弧长只是视觉刻度，档位判定仍只看阈值，两者不混淆。
	 */
	api.gauge = function (label, unit, kind, opts) {
		opts = opts || {};
		var C = (2 * Math.PI * 42).toFixed(2);
		var plainOn = opts.plain !== false;

		var root = E('div', { 'class': 'mt5700-gauge' });
		var dial = E('div', { 'class': 'mt5700-gauge-dial' });
		var svg = svgEl('svg', { viewBox: '0 0 100 100', role: 'img' });

		// 刻度环：把「量程」可视化，让弧长百分比有参照
		svg.appendChild(svgEl('circle', {
			'class': 'mt5700-gauge-track', cx: 50, cy: 50, r: 42, 'stroke-width': 8
		}));
		var bar = svgEl('circle', {
			'class': 'mt5700-gauge-bar', cx: 50, cy: 50, r: 42, 'stroke-width': 8,
			transform: 'rotate(-90 50 50)',
			'stroke-dasharray': C, 'stroke-dashoffset': C
		});
		svg.appendChild(bar);
		dial.appendChild(svg);

		var center = E('div', { 'class': 'mt5700-gauge-center' });
		var valueEl = E('div', { 'class': 'mt5700-gauge-value' }, '—');
		var unitEl = E('div', { 'class': 'mt5700-gauge-unit' }, unit || '');
		center.appendChild(valueEl);
		center.appendChild(unitEl);
		dial.appendChild(center);
		root.appendChild(dial);

		var labelBox = E('div', { 'class': 'mt5700-gauge-labelbox' });
		labelBox.appendChild(E('div', { 'class': 'mt5700-gauge-label' }, label || ''));
		if (opts.sub) labelBox.appendChild(E('div', { 'class': 'mt5700-gauge-sub' }, opts.sub));
		root.appendChild(labelBox);

		var caption = E('div', { 'class': 'mt5700-gauge-caption' });
		root.appendChild(caption);

		var plainEl = null;
		if (plainOn) {
			plainEl = E('div', { 'class': 'mt5700-gauge-plain' });
			root.appendChild(plainEl);
		}

		return {
			el: root,
			set: function (value) {
				var spec = SIGNAL_SPECS[kind];
				if (value == null || isNaN(value)) {
					valueEl.textContent = '—';
					bar.setAttribute('stroke-dashoffset', C);
					bar.removeAttribute('stroke');
					caption.textContent = '';
					caption.className = 'mt5700-gauge-caption';
					if (plainEl) plainEl.textContent = '暂无数据';
					root.classList.remove('mt5700-gauge-empty');
					return;
				}
				valueEl.textContent = String(value);
				var level = spec ? spec.level(value) : 'fair';
				var color = GAUGE_COLORS[level] || GAUGE_COLORS.fair;
				var pct = 0;
				if (spec) {
					pct = (value - spec.min) / (spec.max - spec.min);
					pct = Math.max(0, Math.min(1, pct));
				}
				bar.setAttribute('stroke', color);
				bar.setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(2));
				caption.textContent = GAUGE_CAPTIONS[level] || '';
				caption.className = 'mt5700-gauge-caption ' + level;
				if (plainEl) plainEl.textContent = (GAUGE_PLAIN[kind] || {})[level] || '';
				/* 档位同时挂到根节点，便于卡片级汇总与测试读取 */
				root.className = 'mt5700-gauge mt5700-gauge-' + level;
			}
		};
	};

	/*
	 * 信号总评横幅
	 *
	 * 四个仪表各说各的，用户看完仍不知道该得出什么结论。
	 * 这里把「无线信号」与「网络承载能力」两类证据汇总成一句可执行结论。
	 *
	 * 汇总规则分两层：
	 *   第一层 信号档（LEVEL_ORDER 木桶原理）：取 rsrp/rsrq/sinr/pct 四项中最差者。
	 *          任何一项拖后腿都会实际影响体验，取最差比取平均更贴近真实感受。
	 *   第二层 能力档（CAP_ORDER 木桶原理）：取「制式代际」「频段传播特性」「载波带宽」
	 *          三项中最差者。这一层回答的是「这条链路最快能跑多少」。
	 *
	 * 最终结论 = 两层取更差者。理由：信号好只说明「链路质量好」，不等于「网速快」。
	 * 例如 700MHz(n28) 上的 LTE 信号满格，RSRP -70 属"优秀"，但 20MHz 带宽 + 4G 制式
	 * 决定了它的峰值吞吐远不如 2.6GHz(n41) 的 5G 100MHz。旧版只看信号档就下
	 * 「适合看高清视频、下载大文件」的结论，属于典型的乐观误判。
	 */
	var LEVEL_ORDER = { exc: 0, good: 1, fair: 2, poor: 3, bad: 4 };

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

	/*
	 * 频段传播特性：按中心频率分三档。
	 *
	 * 低频（<1GHz）绕射强、穿透好、覆盖远，但频谱窄、带宽天生受限；
	 * Sub-6 中频（1~6GHz）是 5G 主力区，覆盖与容量均衡——中国现网 n41(2.6GHz)、
	 *   n78(3.5GHz)、n79(4.9GHz) 全在此区间，n78 更是联通/电信/广电的 5G 核心频段，
	 *   其 100MHz 带宽的实际速率优于低频，不应因"频率高"被降档；
	 * 毫米波（>6GHz）带宽极大但穿透极差、覆盖半径小，国内尚未商用。
	 *
	 * 判据用实测频率（^HFREQINFO 的 dlFreqKHz），而非频段号——
	 * 频段号到频率的映射随 3GPP 版本扩展，用频率更稳。
	 */
	var BAND_PROP = [
		{ maxMHz: 1000, level: 'good', label: '低频', note: '穿透与覆盖好，但频谱窄、带宽受限' },
		{ maxMHz: 6000, level: 'exc', label: '中频', note: 'Sub-6 主力频段，覆盖与带宽均衡' },
		{ maxMHz: Infinity, level: 'fair', label: '毫米波', note: '带宽大但穿透差，覆盖半径小' }
	];

	/*
	 * 单载波下行带宽档位。
	 *
	 * 带宽直接决定峰值吞吐，是最贴近「网速」的硬指标。但阈值必须按制式区分——
	 * LTE 单载波物理带宽上限就是 20MHz（3GPP 36.101：1.4/3/5/10/15/20MHz），
	 * 拿 NR 的尺子去量 LTE 会把「4G 满配」误判成「带宽不足」；
	 * 反之 NR 的 25/30/40MHz 已能跑数百 Mbps，不该与 20MHz 同档。
	 *
	 * 因此按制式给出各自的档位表，缺制式信息时退到 NR 表（更保守的宽容度）。
	 */
	var BW_CAP_NR = [
		{ minKHz: 80000, level: 'exc', note: '接近 5G 单载波满配' },
		{ minKHz: 45000, level: 'good', note: '带宽充裕' },
		{ minKHz: 24000, level: 'good', note: '带宽够用，峰值可观' },
		{ minKHz: 19000, level: 'fair', note: '带宽一般，峰值受限' },
		{ minKHz: 0, level: 'poor', note: '带宽偏窄，峰值明显受限' }
	];
	var BW_CAP_LTE = [
		{ minKHz: 19000, level: 'good', note: '已达 4G 单载波带宽上限' },
		{ minKHz: 14000, level: 'fair', note: '带宽尚可，峰值中等' },
		{ minKHz: 0, level: 'poor', note: '带宽偏窄，峰值明显受限' }
	];

	/*
	 * 结论文案。
	 * advice 是横幅里的一行摘要（单行显示、超长省略），因此刻意写得短，
	 * 保证在 205~340px 的摘要区里基本能完整显示；详细解释放在下方提示条。
	 */
	var VERDICT_TEXT = {
		exc: {
			title: '网络能力优秀',
			advice: '信号与频段带宽俱佳，适合高清视频及大文件下载'
		},
		good: {
			title: '网络能力良好',
			advice: '日常上网、视频与通话流畅无压力'
		},
		fair: {
			title: '网络能力一般',
			advice: '轻量使用够用，高清视频可能缓冲'
		},
		poor: {
			title: '网络能力偏弱',
			advice: '易卡顿掉线，建议调整位置或加天线',
			hint: '建议把设备移到靠窗或高处、加装外置天线，或联系运营商确认基站覆盖。'
		},
		bad: {
			title: '网络能力很差',
			advice: '基本无法上网，请检查天线与 SIM 卡',
			hint: '请依次检查天线是否接紧、SIM 卡是否插好并已激活，或联系运营商确认基站覆盖。'
		}
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

	function bandPropFor(freqKHz) {
		if (!freqKHz || freqKHz <= 0) return null;
		var mhz = freqKHz / 1000;
		for (var i = 0; i < BAND_PROP.length; i++) {
			if (mhz < BAND_PROP[i].maxMHz) return BAND_PROP[i];
		}
		return BAND_PROP[BAND_PROP.length - 1];
	}

	function bwCapFor(bwKHz, rat) {
		if (!bwKHz || bwKHz <= 0) return null;
		/* LTE 用 LTE 的尺子量，其余（含制式未知）用 NR 表 */
		var table = (rat === 'LTE') ? BW_CAP_LTE : BW_CAP_NR;
		for (var i = 0; i < table.length; i++) {
			if (bwKHz >= table[i].minKHz) return table[i];
		}
		return table[table.length - 1];
	}

	/* 暴露给页面与测试使用 */
	api.ratLabel = function (v) {
		var r = normRat(v);
		return r && RAT_CAP[r] ? RAT_CAP[r].label : (v ? String(v) : '—');
	};

	/*
	 * 评估网络承载能力（不依赖信号强弱）。
	 * opts: { sysMode, dlFreqKHz, dlBwKHz }
	 * 返回 { level, items:[{key,level,label,value,note}] } 或 null（数据不足）
	 */
	api.capabilityAssess = function (opts) {
		opts = opts || {};
		var items = [];
		var rat = normRat(opts.sysMode);
		if (rat && RAT_CAP[rat]) {
			items.push({
				key: 'rat', level: RAT_CAP[rat].level,
				label: '网络制式', value: RAT_CAP[rat].label, note: RAT_CAP[rat].note
			});
		}
		var bp = bandPropFor(opts.dlFreqKHz);
		if (bp) {
			var mhzTxt = (opts.dlFreqKHz / 1000).toFixed(0) + ' MHz';
			items.push({ key: 'band', level: bp.level, label: '频段特性', value: bp.label + ' ' + mhzTxt, note: bp.note });
		}
		var bw = bwCapFor(opts.dlBwKHz, rat);
		if (bw) {
			var bwTxt = (opts.dlBwKHz / 1000) + ' MHz';
			items.push({ key: 'bw', level: bw.level, label: '载波带宽', value: bwTxt, note: bw.note });
		}
		if (!items.length) return null;
		var worst = items.reduce(function (a, b) {
			return LEVEL_ORDER[b.level] > LEVEL_ORDER[a.level] ? b : a;
		});
		return { level: worst.level, items: items };
	};

	/* 档位中文名，供能力项复用 */
	api.levelCaption = function (level) { return GAUGE_CAPTIONS[level] || ''; };

	/*
	 * 状态图标（描边式，24 视口内绘制）+ 圆形底环。
	 * 用于横幅最左侧的「总状态」指示，与四项指标的图标区分开。
	 */
	function statusIcon() {
		var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
		svg.appendChild(svgEl('circle', { 'class': 'mt5700-status-halo', cx: 12, cy: 12, r: 8, fill: 'none' }));
		svg.appendChild(svgEl('circle', { 'class': 'mt5700-verdict-tower', cx: 12, cy: 12, r: 4.5 }));
		return svg;
	}

	/*
	 * 四项信号指标的图标（描边式），与参考稿一一对应：
	 *   rsrp → 柱状信号格   rsrq → 虚线波形
	 *   sinr → 雷达同心环   pct  → 圆圈对勾
	 * 每项都带各自的动效类，由 CSS 驱动。
	 */
	var SIGNAL_ICONS = {
		rsrp: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			[
				'M4 19h3v-5H4z',
				'M9 19h3V10H9z',
				'M14 19h3V7h-3z',
				'M19 19h1V4h-1z'
			].forEach(function (d) {
				svg.appendChild(svgEl('path', { 'class': 'mt5700-bar', d: d }));
			});
			return svg;
		},
		rsrq: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			svg.appendChild(svgEl('path', { 'class': 'mt5700-wave', d: 'M3 13c3-7 5 7 9 0s6 7 9 0', fill: 'none' }));
			return svg;
		},
		sinr: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			svg.appendChild(svgEl('circle', { 'class': 'mt5700-ring', cx: 12, cy: 12, r: 7, fill: 'none' }));
			svg.appendChild(svgEl('circle', { 'class': 'mt5700-ring mt5700-ring-r2', cx: 12, cy: 12, r: 4, fill: 'none' }));
			svg.appendChild(svgEl('circle', { 'class': 'mt5700-dot', cx: 12, cy: 12, r: 2 }));
			svg.appendChild(svgEl('path', { 'class': 'mt5700-sweep', d: 'M12 12l6-6', fill: 'none' }));
			return svg;
		},
		pct: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 8, fill: 'none' }));
			svg.appendChild(svgEl('path', { 'class': 'mt5700-check', d: 'm8 12 3 3 5-6', fill: 'none' }));
			return svg;
		}
	};

	/*
	 * 能力项图标（描边式，24 视口内绘制）。
	 * 按能力类型区分语义：制式=信号塔、频段=频率波形、带宽=双向带宽箭头。
	 * 统一 stroke:currentColor + fill:none，由外层档位色驱动着色。
	 */
	var CAP_ICONS = {
		rat: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			[
				'M12 21v-8',
				'M8.2 15.6a5 5 0 0 1 7.6 0',
				'M5.4 12.4a9 9 0 0 1 13.2 0',
				'M12 5.5v.01'
			].forEach(function (d) {
				svg.appendChild(svgEl('path', { d: d, fill: 'none' }));
			});
			return svg;
		},
		band: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			svg.appendChild(svgEl('path', { 'class': 'mt5700-band-pulse', d: 'M2 12h3.5l2-6 3 13 3-16 2.5 9H22', fill: 'none' }));
			return svg;
		},
		bw: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			[
				'M4 12h16',
				'M8 8l-4 4 4 4',
				'M16 8l4 4-4 4'
			].forEach(function (d) {
				svg.appendChild(svgEl('path', { d: d, fill: 'none' }));
			});
			return svg;
		}
	};

	/* 能力项键 → 图标；未知键退到带宽图标，保证不出现空位 */
	function capIconFor(key) {
		return (CAP_ICONS[key] || CAP_ICONS.bw)();
	}

	/* 信号项键 → 图标 */
	function signalIconFor(key) {
		return (SIGNAL_ICONS[key] || SIGNAL_ICONS.pct)();
	}

	/*
	 * 档位 → 柱状信号格点亮根数。
	 * exc(4) / good(3) / fair(2) / poor(1) / bad(1)，
	 * 与参考稿 data-bars 的 4/3/2/1 四档对齐。
	 */
	var BAR_COUNT = { exc: 4, good: 3, fair: 2, poor: 1, bad: 1 };

	/**
	 * 创建网络能力总评横幅。
	 * 返回 { el, set({rsrp, rsrq, sinr, pct, sysMode, dlFreqKHz, dlBwKHz}) }
	 * 任一指标为空则该项不参与汇总。
	 *
	 * 布局为**单行横向 flex**（PC 上一行放全，参考设计稿）：
	 *   [总状态图标] [标题+描述] [四指标卡片 × 4] [能力详情 × 3]
	 * 窄屏按 900 / 520 两档回流。
	 */
	api.signalVerdict = function () {
		var root = E('div', { 'class': 'mt5700-verdict' });

		/* 1) 最左：总状态图标 */
		var status = E('div', { 'class': 'mt5700-verdict-status' });
		status.appendChild(statusIcon());
		root.appendChild(status);

		/* 2) 摘要块：标题 + 一行描述（超长省略） */
		var summary = E('div', { 'class': 'mt5700-verdict-summary' });
		var title = E('div', { 'class': 'mt5700-verdict-title' }, '正在评估网络…');
		var advice = E('div', { 'class': 'mt5700-verdict-advice' });
		summary.appendChild(title);
		summary.appendChild(advice);
		root.appendChild(summary);

		/* 3) 四项信号指标：带边框的指标卡，横向网格 */
		var metrics = E('div', { 'class': 'mt5700-verdict-metrics' });
		root.appendChild(metrics);

		/* 4) 右侧能力详情：制式 / 频段 / 带宽，竖线分隔 */
		var capBar = E('div', { 'class': 'mt5700-verdict-cap' });
		root.appendChild(capBar);

		/* 5) 关键说明：被能力维度拉低时显示，独占一行 */
		var capNote = E('div', { 'class': 'mt5700-verdict-capnote' });
		root.appendChild(capNote);

		var LABELS = { rsrp: '信号强度', rsrq: '信号质量', sinr: '信噪比', pct: '综合' };

		return {
			el: root,
			set: function (vals) {
				vals = vals || {};
				var levels = [];
				['rsrp', 'rsrq', 'sinr', 'pct'].forEach(function (k) {
					var lv = api.signalLevel(k, vals[k]);
					if (lv) levels.push({ key: k, level: lv });
				});
				metrics.innerHTML = '';
				capBar.innerHTML = '';
				capNote.textContent = '';
				if (!levels.length) {
					root.className = 'mt5700-verdict mt5700-verdict-empty';
					title.textContent = '暂无信号数据';
					advice.textContent = '等待模组上报信号质量…';
					return;
				}
				/* 第一层：信号档 = 最差项（木桶原理） */
				var worst = levels.reduce(function (a, b) {
					return LEVEL_ORDER[b.level] > LEVEL_ORDER[a.level] ? b : a;
				});

				/* 第二层：能力档（制式 / 频段 / 带宽） */
				var cap = api.capabilityAssess({
					sysMode: vals.sysMode,
					dlFreqKHz: vals.dlFreqKHz,
					dlBwKHz: vals.dlBwKHz
				});

				/*
				 * 合成最终档位。信号与能力取更差者——信号决定「稳不稳」，
				 * 能力决定「快不快」，任一短板都约束真实体验。
				 */
				var finalLevel = worst.level;
				var cappedBy = null;
				if (cap && LEVEL_ORDER[cap.level] > LEVEL_ORDER[worst.level]) {
					finalLevel = cap.level;
					var capWorst = cap.items.reduce(function (a, b) {
						return LEVEL_ORDER[b.level] > LEVEL_ORDER[a.level] ? b : a;
					});
					cappedBy = capWorst;
				}

				var v = VERDICT_TEXT[finalLevel] || VERDICT_TEXT.fair;
				root.className = 'mt5700-verdict mt5700-verdict-' + finalLevel;
				title.textContent = v.title;
				advice.textContent = v.advice;

				/*
				 * 四项信号指标：每项一张带边框的小卡（图标 + 标签/值竖排）。
				 * 与能力项同理，只有「唯一短板」才加高亮描边——四项同为最差档时
				 * 全部点亮反而看不出重点，此时仅靠档位配色区分即可。
				 */
				var worstLevel = LEVEL_ORDER[worst.level];
				var worstCount = levels.filter(function (x) {
					return LEVEL_ORDER[x.level] === worstLevel;
				}).length;
				levels.forEach(function (it) {
					var card = E('div', {
						'class': 'mt5700-verdict-metric mt5700-verdict-metric-' + it.level
					});
					var icon = E('span', { 'class': 'mt5700-verdict-metricicon' });
					/*
					 * 柱状信号格按档位映射点亮根数，让图标形态跟着信号强弱走
					 * （参考稿用 data-bars 控制，这里在 JS 侧直接决定）。
					 */
					if (it.key === 'rsrp') {
						card.setAttribute('data-bars', BAR_COUNT[it.level] || 4);
					}
					icon.appendChild(signalIconFor(it.key));
					card.appendChild(icon);

					var box = E('div', { 'class': 'mt5700-verdict-metricbox' });
					box.appendChild(E('span', { 'class': 'mt5700-verdict-metricname' }, LABELS[it.key] || it.key));
					box.appendChild(E('span', { 'class': 'mt5700-verdict-metricval' },
						(api.signalCaption ? api.signalCaption(it.level) : '')));
					card.appendChild(box);

					if (worstCount === 1 && LEVEL_ORDER[it.level] === worstLevel) {
						card.classList.add('mt5700-verdict-metric-worst');
					}
					metrics.appendChild(card);
				});

				/*
				 * 能力项：图标 + 标签/值竖排，竖线分隔，排在指标区右侧。
				 * 仅当总评是被能力维度拉低、且该项是唯一短板时才加底色高亮——
				 * 若多项同为最差档（如制式/频段/带宽均为 exc），高亮就失去指向性。
				 */
				if (cap) {
					var capWorstLevel = LEVEL_ORDER[cap.level];
					var capWorstCount = cap.items.filter(function (x) {
						return LEVEL_ORDER[x.level] === capWorstLevel;
					}).length;
					cap.items.forEach(function (it) {
						var item = E('div', {
							'class': 'mt5700-verdict-capitem mt5700-verdict-capitem-' + it.level
						});
						/* 阈值依据放进 title：不占版面，悬停可查 */
						if (it.note) item.setAttribute('title', it.label + '：' + it.note);
						item.appendChild(E('span', { 'class': 'mt5700-verdict-capname' }, it.label));
						item.appendChild(E('span', { 'class': 'mt5700-verdict-capval' }, it.value));

						if (cappedBy && capWorstCount === 1 && LEVEL_ORDER[it.level] === capWorstLevel) {
							item.classList.add('mt5700-verdict-capitem-worst');
						}
						capBar.appendChild(item);
					});
				}

				/*
				 * 底部说明条，两种来源（能力受限优先，其次弱信号处理建议）：
				 *   1) 结论被能力维度拉低 → 点明「信号好≠网速快」及具体短板
				 *   2) 信号本身偏弱 → 给出可操作的排查建议
				 * 两者都不触发时整条隐藏，不占版面。
				 */
				if (cappedBy) {
					capNote.textContent = '注意：无线信号本身' + (api.signalCaption ? api.signalCaption(worst.level) : '') +
						'，但「' + cappedBy.label + '」为' + (api.levelCaption ? api.levelCaption(cappedBy.level) : '') +
						'（' + cappedBy.note + '），实际网速会受此限制。';
					capNote.classList.add('mt5700-verdict-capnote-on');
				} else if (v.hint) {
					capNote.textContent = v.hint;
					capNote.classList.add('mt5700-verdict-capnote-on');
				} else {
					capNote.classList.remove('mt5700-verdict-capnote-on');
				}
			}
		};
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

	api.successButton = function (label, onClick) {
		return api.button(label, onClick, 'success');
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

	/* ================= 连接状态卡片 ================= */
	// 独立 at-status-* 命名空间，样式自包含于 mt5700.css，不依赖 LuCI 主题

	api.renderConnectionBar = function (container) {
		var cl = AtWs.client;

		var card = E('div', { 'class': 'at-status-card is-connecting', 'id': 'at-service-status' });

		// SVG 状态图标（在线/连接中旋转，离线/未知静止）
		var icon = E('div', { 'class': 'at-status-icon' });
		var svg = svgEl('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' });
		svg.appendChild(svgEl('circle', { cx: 16, cy: 16, r: 11, 'stroke-dasharray': '5 3' }));
		svg.appendChild(svgEl('circle', { cx: 16, cy: 16, r: 4 }));
		svg.appendChild(svgEl('path', { d: 'M16 5V2' }));
		svg.appendChild(svgEl('path', { d: 'M16 30V27' }));
		icon.appendChild(svg);

		// 主信息：标题（状态点 + 文本）与描述
		var main = E('div', { 'class': 'at-status-main' });
		var title = E('div', { 'class': 'at-status-title' });
		var dot = E('span', { 'class': 'at-status-dot' });
		var text = E('span', { 'class': 'at-status-text' }, '正在连接 AT 服务');
		title.appendChild(dot);
		title.appendChild(text);
		var desc = E('div', { 'class': 'at-status-description' }, '正在建立 AT 服务连接');
		main.appendChild(title);
		main.appendChild(desc);

		// RPC 地址芯片
		var rpcBox = E('div', { 'class': 'at-status-rpc' });
		rpcBox.appendChild(E('span', { 'class': 'at-status-rpc-label' }, 'RPC'));
		var rpcValue = E('span', { 'class': 'at-status-rpc-value' }, '未连接');
		rpcBox.appendChild(rpcValue);

		card.appendChild(icon);
		card.appendChild(main);
		card.appendChild(rpcBox);
		container.appendChild(card);

		function rpcLabel() {
			var port = cl.port || 8765;
			var host = cl.bind || cl.host || '127.0.0.1';
			if (host === '0.0.0.0' || host === 'localhost') host = '127.0.0.1';
			return host + ':' + port;
		}

		// 后端连接状态 → 卡片四态映射
		var STATES = {
			connected:      { status: 'online',     text: 'AT 服务在线',      desc: 'AT 通信服务运行正常' },
			connecting:     { status: 'connecting', text: '正在连接 AT 服务', desc: '正在建立 AT 服务连接' },
			authenticating: { status: 'connecting', text: '正在连接 AT 服务', desc: '正在验证访问密钥' },
			idle:           { status: 'connecting', text: '正在连接 AT 服务', desc: '正在建立 AT 服务连接' },
			reconnecting:   { status: 'connecting', text: '正在连接 AT 服务', desc: '连接中断，正在重连' },
			disconnected:   { status: 'offline',    text: 'AT 服务离线',      desc: '无法连接 AT 通信服务' },
			error:          { status: 'offline',    text: 'AT 服务离线',      desc: null }
		};

		function apply(state, err) {
			var cfg = STATES[state] || { status: 'unknown', text: 'AT 服务状态未知', desc: '暂时无法获取服务状态' };
			card.classList.remove('is-online', 'is-connecting', 'is-offline', 'is-unknown');
			card.classList.add('is-' + cfg.status);
			text.textContent = cfg.text;
			desc.textContent = (cfg.status === 'offline' && err) ? err : (cfg.desc || '暂时无法获取服务状态');
			rpcValue.textContent = cfg.status === 'online' ? rpcLabel() : '未连接';
		}

		apply('connecting');
		cl.onConnectionStateChange(apply);
		return card;
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
		el.appendChild(E('div', { 'class': 'mt5700-spinner' }));
		if (text) el.appendChild(E('div', { 'class': 'mt5700-loading-text' }, text));
		return el;
	};

	api.empty = function (text) {
		var el = E('div', { 'class': 'mt5700-empty' });
		el.appendChild(E('div', { 'class': 'mt5700-empty-text' }, text || '暂无数据'));
		return el;
	};

	api.errorState = function (text, onRetry) {
		var el = E('div', { 'class': 'mt5700-error-state' });
		el.appendChild(E('div', { 'class': 'mt5700-error-text' }, text || '获取数据失败'));
		if (onRetry) {
			el.appendChild(api.primaryButton('重新尝试', onRetry));
		}
		return el;
	};

	/* ================= 自动刷新 ================= */

	api.autoRefresh = function (onChange) {
		var wrap = E('div', { 'class': 'mt5700-autorefresh' });
		var enabled = true;
		var interval = 5;
		var chk = document.createElement('input');
		chk.type = 'checkbox';
		chk.checked = true;
		chk.addEventListener('change', function () {
			enabled = chk.checked;
			if (onChange) onChange(enabled, interval);
		});
		var label = E('label', {}, '自动刷新 ');
		label.insertBefore(chk, label.firstChild);
		var sel = document.createElement('select');
		[3, 5, 10, 15, 30, 60].forEach(function (s) {
			var opt = E('option', { value: String(s) }, s + ' 秒');
			if (s === interval) opt.selected = true;
			sel.appendChild(opt);
		});
		sel.addEventListener('change', function () {
			interval = parseInt(sel.value, 10);
			if (onChange) onChange(enabled, interval);
		});
		label.appendChild(sel);
		wrap.appendChild(label);
		return {
			el: wrap,
			enabled: function () { return enabled; },
			interval: function () { return interval; }
		};
	};

	/* ================= 定时器管理 ================= */

	var _timers = [];

	api.interval = function (ms, fn) {
		var id = setInterval(fn, ms);
		_timers.push(function () { clearInterval(id); });
		return id;
	};

	api.clearAll = function () {
		_timers.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
		_timers = [];
	};

	/* ================= 图表 ================= */

	var _gradSeq = 0;

	/**
	 * 实时速率折线图（v2 视觉版）
	 * - 双折线（下行/上行）+ 下行面积渐变填充
	 * - 悬浮提示（tooltip，L4 浮层），数据格式通过 options.tipFormat(point, index) 定制
	 * - 函数签名与数据格式（[{down, up}, ...]）与 v1 完全兼容，旧调用无需改动
	 */
	api.lineChart = function (data, options) {
		options = options || {};
		var w = options.width || 600;
		var h = options.height || 160;
		var max = options.max || 1;
		var downColor = options.downColor || '#3b82f6';
		var upColor = options.upColor || '#10b981';

		// 外层容器（tooltip 需要 relative 定位与 L4 浮层）
		var wrap = E('div', { style: 'position:relative;width:100%;height:100%;' });
		var svg = svgEl('svg', {
			viewBox: '0 0 ' + w + ' ' + h,
			preserveAspectRatio: 'none'
		});
		wrap.appendChild(svg);
		var tip = E('div', { 'class': 'mt5700-chart-tip' });
		wrap.appendChild(tip);

		if (!data || !data.length) {
			return wrap;
		}

		// 找最大值（自然取整到 10 的倍数刻度，避免顶格）
		var actualMax = max;
		if (actualMax <= 1) {
			data.forEach(function (p) {
				actualMax = Math.max(actualMax, p.down || 0, p.up || 0);
			});
		}

		// 面积渐变定义
		var gradId = 'mt5700-grad-' + (++_gradSeq);
		var defs = svgEl('defs');
		var grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
		var stop1 = svgEl('stop', { offset: '0%', 'stop-color': downColor, 'stop-opacity': 0.22 });
		var stop2 = svgEl('stop', { offset: '100%', 'stop-color': downColor, 'stop-opacity': 0 });
		grad.appendChild(stop1);
		grad.appendChild(stop2);
		defs.appendChild(grad);
		svg.appendChild(defs);

		// 网格线
		var gridCount = 4;
		for (var i = 0; i <= gridCount; i++) {
			var gy = 10 + (h - 30) * i / gridCount;
			svg.appendChild(svgEl('line', {
				x1: 2, y1: gy, x2: w - 2, y2: gy,
				stroke: 'rgba(127, 127, 127, 0.14)',
				'stroke-width': 1
			}));
		}

		var n = data.length;
		function px(j) { return (j / Math.max(1, n - 1)) * (w - 4) + 2; }
		function py(v) { return h - 15 - (v / actualMax) * (h - 30); }

		var downPts = [], upPts = [];
		for (var j = 0; j < n; j++) {
			downPts.push(px(j).toFixed(1) + ',' + py(data[j].down || 0).toFixed(1));
			upPts.push(px(j).toFixed(1) + ',' + py(data[j].up || 0).toFixed(1));
		}

		// 下行面积填充
		if (n > 1) {
			svg.appendChild(svgEl('polygon', {
				fill: 'url(#' + gradId + ')',
				points: downPts.join(' ') + ' ' + px(n - 1).toFixed(1) + ',' + (h - 15) + ' ' + px(0).toFixed(1) + ',' + (h - 15)
			}));
		}

		// 双折线
		if (n > 1) {
			svg.appendChild(svgEl('polyline', {
				fill: 'none', stroke: downColor, 'stroke-width': 2,
				'stroke-linejoin': 'round', 'stroke-linecap': 'round',
				points: downPts.join(' ')
			}));
			svg.appendChild(svgEl('polyline', {
				fill: 'none', stroke: upColor, 'stroke-width': 2,
				'stroke-linejoin': 'round', 'stroke-linecap': 'round',
				points: upPts.join(' ')
			}));
		}

		// 悬浮提示：跟随鼠标取最近采样点
		function fmtDefault(p) {
			function f(v) { return v >= 1e6 ? (v / 1e6).toFixed(2) + ' Mbps' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' Kbps' : Math.round(v) + ' bps'; }
			return '↓ ' + f(p.down || 0) + ' · ↑ ' + f(p.up || 0);
		}
		wrap.addEventListener('mousemove', function (e) {
			var rect = wrap.getBoundingClientRect();
			var ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
			var idx = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
			var p = data[idx];
			if (!p) return;
			tip.textContent = options.tipFormat ? options.tipFormat(p, idx) : fmtDefault(p);
			var tx = Math.max(60, Math.min(rect.width - 60, px(idx) / w * rect.width));
			tip.style.left = tx + 'px';
			tip.style.top = (Math.max(py(p.down || 0), py(p.up || 0)) / h * rect.height) + 'px';
			tip.classList.add('show');
		});
		wrap.addEventListener('mouseleave', function () {
			tip.classList.remove('show');
		});

		return wrap;
	};

	// 信号强度条
	api.signalBar = function (value, max) {
		max = max || 100;
		var percent = Math.min(100, Math.max(0, (value / max) * 100));
		var color = percent >= 70 ? 'var(--mt5700-success)' :
				percent >= 40 ? 'var(--mt5700-warning)' : 'var(--mt5700-danger)';

		var el = E('div', { 'class': 'mt5700-signal-bar' });
		var bar = E('div', { 'class': 'mt5700-signal-bar-fill' });
		bar.style.width = percent + '%';
		bar.style.background = color;
		el.appendChild(bar);
		return el;
	};

	/* ================= 表格 ================= */

	api.table = function (headers, rows, options) {
		options = options || {};
		var wrapper = E('div', { 'class': 'mt5700-table-wrapper' });
		var table = E('table', { 'class': 'mt5700-table' });
		if (options.striped) table.classList.add('mt5700-table-striped');

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
				row.forEach(function (cell) {
					if (typeof cell === 'object' && cell.nodeType) {
						var td = E('td');
						td.appendChild(cell);
						tr.appendChild(td);
					} else {
						tr.appendChild(E('td', {}, cell || '—'));
					}
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
	 * 原始参数展示行
	 *
	 * 用途：界面用通俗文案，但底层编码仍要可见可审计（便于排障与对标 AT 手册）。
	 * 用等宽灰底呈现原始值，不参与编辑，用户不会误改。
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

	/*
	 * 只读状态行（用于展示「当前实际值」这类不需要编辑的信息）
	 */
	api.readonlyField = function (label, value, hint) {
		var group = E('div', { 'class': 'mt5700-form-group' });
		group.appendChild(E('label', { 'class': 'mt5700-label' }, label));
		var box = E('div', { 'class': 'mt5700-readonly' }, (value === '' || value == null) ? '—' : String(value));
		group.appendChild(box);
		if (hint) group.appendChild(E('div', { 'class': 'mt5700-hint' }, hint));
		return group;
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

	api.speedBox = function (label, value) {
		var box = E('div', { 'class': 'mt5700-speed-box' });
		box.appendChild(E('span', { 'class': 'mt5700-speed-label' }, label));
		box.appendChild(E('span', { 'class': 'mt5700-speed-value' }, value));
		return box;
	};

	return api;
})();

// 导出
var Mt5700Class = L.Class.extend(Mt5700);
if (typeof window !== 'undefined') {
	window.Mt5700 = new Mt5700Class();
}
return Mt5700Class;
