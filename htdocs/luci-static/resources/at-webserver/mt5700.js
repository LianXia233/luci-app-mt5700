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
/*
 * ⚠️ 改 mt5700.css 后必须 bump 这个常量。
 * 它是样式表 URL `.../mt5700.css?v=<版本>` 里唯一的缓存击穿器：固件 squashfs 的
 * 文件 mtime 恒为 1970-01-01，uhttpd 不送 Cache-Control，浏览器按启发式新鲜度
 * 会把该文件缓存到近乎永久。2026-09-16 的教训：开关改成 iOS 几何（44×24 → 51×31）
 * 后，设备上 CSS 内容已经是新的，用户浏览器却还在用旧副本 —— 代码改了界面没变。
 * 守卫：tests/css-cachebust-contract.test.js（mt5700.css 内容指纹一变就必须改这里）。
 */
var MT5700_CSS_VERSION = '6.4.1';
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

		/*
		 * LuCI 没有页面卸载钩子：各视图给的 self._dispose 全仓库零调用点，
		 * 于是切页只是换掉视图 DOM，定时器与订阅一个都不会停 —— 进几次页面
		 * 就有几个在后台各跑各的，跟用户操作抢独占的 AT 串口。
		 *
		 * 判据用「曾进入文档、现已脱离」这个**转换**，而不是「现在不在文档里」：
		 * 页面刚构建、尚未插入文档的那一瞬也会被判成不在，只认转换可避免误清。
		 */
		var cleanups = [];
		node._onDispose = function (fn) {
			if (typeof fn === 'function') cleanups.push(fn);
		};
		/* 卸载走统一的 detach 巡检（见「定时器管理」段），不再每个页面各起一个 1s 定时器 */
		api.onDetach(node, function () {
			for (var ci = 0; ci < cleanups.length; ci++) {
				try { cleanups[ci](); } catch (e) { /* 清理失败不能影响其余 */ }
			}
			cleanups.length = 0;
			/* 外壳是全局单例：页面走了就得拆，否则下一页面会套在两个壳里 */
			api.unmountShell();
		});

		/* v9 外壳：等节点进文档后接管整屏（见文件末尾「v9 外壳」段） */
		shWhenAttached(node);
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
	 * 指标卡片。
	 *
	 * ★ value 过长时自动加 .is-long（默认 9 个字符）：
	 *   .mt5700-metrics 的格子是 minmax(150px, 1fr)，而读数本身是
	 *   white-space: nowrap（防止「1000 Mbps」被挤成两行）。两者一撞，
	 *   偏长的中文读数（如 PS 注册状态文案）就直接顶破卡片。
	 *   这里不改容器宽度（用户要求固定尺寸、不按内容撑开），而是让长文本
	 *   换行并降一号字 —— 由 .is-long 在 CSS 侧消化，短数值不受任何影响。
	 */
	api.metric = function (label, value, color) {
		var m = E('div', { 'class': 'mt5700-metric' });
		m.appendChild(E('div', { 'class': 'mt5700-metric-label' }, label));
		var text = value || '—';
		var v = E('div', { 'class': 'mt5700-metric-value' }, text);
		if (String(text).length > 9) v.classList.add('is-long');
		if (color) v.classList.add(color);
		m.appendChild(v);
		return m;
	};

	/* ================= 结论区（verdict） + 链路条（rail） ================= */

	/*
	 * 进页面第一眼应该是一句**结论**，而不是二十个读数。
	 *
	 * 用法：
	 *   var v = Mt5700.verdict();
	 *   body.appendChild(v);
	 *   v.update({
	 *     tone: 'ok',                        // ok | warn | bad —— 只决定竖线与状态点
	 *     eyebrow: ['中国联通', '5G SA', 'n78'],
	 *     title: '已连接，可以上网',
	 *     sub: ['已获取地址 ', { b: '10.1.2.3' }, '，DNS 正常'],
	 *     nums: [{ label: 'RSRP', value: '-83', unit: 'dBm', tone: 'ok' }],
	 *     rail: [{ no: '01', name: '模组', tone: 'ok',
	 *              text: '运行正常', sub: 'MT5700M-CN' }]
	 *   });
	 *
	 * ★ 为什么 update 是**整块重建**而不是逐个 setText：这一块只有 4 段链路 +
	 *   至多 4 个读数，重建成本可以忽略；而逐字段维护「保留旧值 / 取不到显示 —」
	 *   极容易漏一处，出现「换了卡结论还是上一张卡」这类不报错的静默错误。
	 *
	 * ★ tone 只影响颜色，不改文案：同一个数字在三种语气下都要能读，
	 *   不能让「变红」成为唯一的信息载体（色弱用户看不见）。
	 */
	api.verdict = function () {
		var node = E('div', { 'class': 'mt5700-verdict' });
		var main = E('div', { 'class': 'mt5700-verdict-main' });
		var lead = E('div', { 'class': 'mt5700-verdict-lead' });
		var eyebrow = E('div', { 'class': 'mt5700-verdict-eyebrow' });
		var title = E('div', { 'class': 'mt5700-verdict-title' });
		var dot = E('span', { 'class': 'mt5700-verdict-dot' });
		var titleTx = E('span');
		var sub = E('p', { 'class': 'mt5700-verdict-sub' });
		var chips = E('div', { 'class': 'mt5700-verdict-chips' });
		var nums = E('div', { 'class': 'mt5700-verdict-nums' });
		var rail = E('div', { 'class': 'mt5700-rail' });

		title.appendChild(dot);
		title.appendChild(titleTx);
		lead.appendChild(eyebrow);
		lead.appendChild(title);
		lead.appendChild(sub);
		lead.appendChild(chips);
		main.appendChild(lead);
		main.appendChild(nums);
		node.appendChild(main);
		node.appendChild(rail);

		/* 语气修饰符集中在一处拼：CSS 侧 .is-ok/.is-warn/.is-bad 三档 */
		function toneCls(base, tone) {
			return base + (tone ? ' is-' + tone : '');
		}

		/*
		 * sub 允许混排「普通文字 + 等宽强调值」（地址、网关这类要对得上的值走等宽）。
		 * 只接受两种元素：字符串，或 { b: '值' } —— 不接受任意 HTML，
		 * 页面上的值全部来自 AT 回包，拼 HTML 等于把回包内容当代码执行。
		 */
		function fillSub(parts) {
			sub.innerHTML = '';
			if (!parts) { sub.style.display = 'none'; return; }
			sub.style.display = '';
			(Array.isArray(parts) ? parts : [parts]).forEach(function (p) {
				if (p == null) return;
				if (typeof p === 'object' && p.b != null) {
					sub.appendChild(E('b', null, String(p.b)));
				} else {
					sub.appendChild(document.createTextNode(String(p)));
				}
			});
		}

		node.update = function (cfg) {
			cfg = cfg || {};
			node.className = toneCls('mt5700-verdict', cfg.tone);
			titleTx.textContent = cfg.title || '';

			eyebrow.innerHTML = '';
			var eb = (cfg.eyebrow || []).filter(function (t) { return t; });
			eb.forEach(function (t, i) {
				if (i) eyebrow.appendChild(E('span', null, '·'));
				eyebrow.appendChild(E('span', null, String(t)));
			});
			eyebrow.style.display = eb.length ? '' : 'none';

			fillSub(cfg.sub);

			chips.innerHTML = '';
			(cfg.chips || []).forEach(function (c) {
				if (!c) return;
				var chip = E('span', { 'class': 'mt5700-chip' });
				if (c.label) chip.appendChild(document.createTextNode(c.label + ' '));
				chip.appendChild(E('b', null, String(c.value == null ? '—' : c.value)));
				chips.appendChild(chip);
			});
			chips.style.display = chips.childNodes.length ? '' : 'none';

			nums.innerHTML = '';
			(cfg.nums || []).forEach(function (n) {
				if (!n) return;
				var cell = E('div', { 'class': 'mt5700-vnum' });
				cell.appendChild(E('div', { 'class': 'mt5700-vnum-label' }, n.label));
				var hasVal = n.value != null && n.value !== '';
				var val = E('div', { 'class': toneCls('mt5700-vnum-value', n.tone) },
					hasVal ? String(n.value) : '—');
				/* 没取到就不挂单位：「— dBm」会读成「读数是某个值，单位 dBm」，
				   而事实是这一项没有值。留一个干净的「—」才不含歧义。 */
				if (hasVal && n.unit) val.appendChild(E('i', null, String(n.unit)));
				cell.appendChild(val);
				nums.appendChild(cell);
			});
			nums.style.display = nums.childNodes.length ? '' : 'none';

			rail.innerHTML = '';
			(cfg.rail || []).forEach(function (seg) {
				if (!seg) return;
				var s = E('div', { 'class': toneCls('mt5700-rail-seg', seg.tone) });
				var key = E('div', { 'class': 'mt5700-rail-key' });
				key.appendChild(E('i'));
				key.appendChild(document.createTextNode(
					(seg.no ? seg.no + ' ' : '') + (seg.name || '')));
				s.appendChild(key);
				s.appendChild(E('div', { 'class': 'mt5700-rail-text' }, seg.text || ''));
				if (seg.sub) s.appendChild(E('div', { 'class': 'mt5700-rail-sub' }, seg.sub));
				rail.appendChild(s);
			});
			rail.style.display = rail.childNodes.length ? '' : 'none';
			return node;
		};

		return node;
	};

	/* ================= 需要处理（todo） + 影响预告（impact） ================= */

	/*
	 * 「需要处理」条：**有问题才出现**，没有就整块不占地方（不留一条「一切正常」）。
	 * items: [{ title, note, actions: [{ label, variant, onClick }] }]
	 *
	 * ★ 为什么把「还能不能上网」写进这一条：用户看到黄条第一反应是「我现在还有网吗」。
	 *   先说影响（当前可正常上网），再给去向（去处理），他才有余裕决定要不要立刻动。
	 * ★ 返回 null 而不是空盒子：调用方 append 前不用判断，也不会有隐藏节点占着 DOM。
	 */
	api.todo = function (items) {
		if (!items || !items.length) return null;
		var wrap = E('div');
		items.forEach(function (it) {
			if (!it || !it.title) return;
			var row = E('div', { 'class': 'mt5700-todo' });
			row.appendChild(E('span', { 'class': 'mt5700-todo-icon' }, '!'));
			var tx = E('div', { 'class': 'mt5700-todo-text' });
			tx.appendChild(E('b', null, it.title));
			if (it.note) tx.appendChild(E('span', null, it.note));
			row.appendChild(tx);
			if (it.actions && it.actions.length) {
				var acts = E('div', { 'class': 'mt5700-todo-actions' });
				it.actions.forEach(function (a) {
					if (!a || !a.label) return;
					var v = a.variant || 'secondary';
					var btn = E('button', {
						'class': 'mt5700-btn mt5700-btn-sm mt5700-btn-' + v,
						'type': 'button'
					}, a.label);
					if (a.onClick) btn.addEventListener('click', a.onClick);
					acts.appendChild(btn);
				});
				row.appendChild(acts);
			}
			wrap.appendChild(row);
		});
		return wrap.childNodes.length ? wrap : null;
	};

	/*
	 * 「影响预告」：写在会断网/会占串口的按钮**上方**，说明三件事 ——
	 * 会发生什么 · 大概多久 · 影响谁。塞进 tooltip 等于没有（触摸屏没有 hover）。
	 */
	api.impact = function (parts) {
		var box = E('div', { 'class': 'mt5700-impact' });
		box.appendChild(E('span', { 'class': 'mt5700-impact-bar' }));
		var tx = E('div', { 'class': 'mt5700-impact-text' });
		(Array.isArray(parts) ? parts : [parts]).forEach(function (p) {
			if (p == null) return;
			if (typeof p === 'object' && p.b != null) tx.appendChild(E('b', null, String(p.b)));
			else tx.appendChild(document.createTextNode(String(p)));
		});
		box.appendChild(tx);
		return box;
	};

	/* ================= 分段选择器（单选按钮组） ================= */

	/*
	 * 少量互斥选项（如锁频类型 4 项、接入模式 3 项）用分段按钮而不是下拉：
	 * 全部选项一眼可见、一次点选到位。返回 { el, setValue, getValue }。
	 */
	api.segmented = function (options, value, onChange) {
		var wrap = E('div', { 'class': 'mt5700-segmented' });
		var current = value;
		var btns = [];
		options.forEach(function (opt) {
			var btn = E('button', { 'class': 'mt5700-segmented-btn', 'type': 'button' }, opt.label);
			btn.addEventListener('click', function () {
				if (current === opt.value) return;
				current = opt.value;
				paint();
				if (onChange) onChange(opt.value);
			});
			btns.push({ el: btn, value: opt.value });
			wrap.appendChild(btn);
		});
		function paint() {
			btns.forEach(function (b) {
				b.el.classList.toggle('is-active', b.value === current);
			});
		}
		paint();
		return {
			el: wrap,
			setValue: function (v) { current = v; paint(); },
			getValue: function () { return current; }
		};
	};

	/* ================= 信号强度（RSRP → 条） ================= */

	/*
	 * 量程与等级的**唯一真源在 Parse**（见 parse.js「信号语义」段）。
	 * 此前这里自算 `2*(rsrp+120)`（-120~-70），而 rpc.js 用 -110~-70，
	 * 同一信号在两个页面两个百分比；这里只保留薄适配。
	 */
	api.signalPercent = function (rsrp) {
		return Parse.signalPercent(rsrp);
	};

	api.rsrpBar = function (rsrp) {
		var pct = api.signalPercent(rsrp);
		if (pct == null) return document.createTextNode('—');
		var level = Parse.percentLevel(pct);
		var color = (level === 'exc' || level === 'good') ? 'var(--mt5700-success)'
			: level === 'fair' ? 'var(--mt5700-warning)' : 'var(--mt5700-danger)';
		return E('div', { 'class': 'mt5700-signal-bar' },
			E('div', { 'class': 'mt5700-signal-bar-fill',
				'style': 'width:' + pct + '%;background:' + color }));
	};

	
	/* ================= 环形仪表 (Circular Gauge) ================= */

	/*
	 * 信号等级色 (绿→青→琥珀→橙→红) 直接从 CSS 变量读取，
	 * 这样仪表与图表会随浅色 / 深色主题自动切换：
	 * 深色下若沿用浅色的深绿（#0c7a54 之类），在深底上对比度只有 3.7:1，几乎糊在一起。
	 */
	function cssColor(name, fallback) {
		try {
			var v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
			v = (v || '').trim();
			return v || fallback;
		} catch (e) {
			return fallback;
		}
	}

	var GAUGE_COLOR_VARS = {
		exc: '--mt5700-sig-exc', good: '--mt5700-sig-good', fair: '--mt5700-sig-fair',
		poor: '--mt5700-sig-poor', bad: '--mt5700-sig-bad'
	};
	var GAUGE_COLOR_FALLBACK = {
		exc: '#0c7a54', good: '#0b7a70', fair: '#9a5c00', poor: '#c05621', bad: '#c62828'
	};
	function gaugeColor(level) {
		var key = GAUGE_COLOR_VARS[level] ? level : 'fair';
		return cssColor(GAUGE_COLOR_VARS[key], GAUGE_COLOR_FALLBACK[key]);
	}
	var GAUGE_CAPTIONS = { exc: '优秀', good: '良好', fair: '一般', poor: '较差', bad: '极差' };

	/*
	 * 各信号指标使用独立阈值与量程，绝不共用一套 0-100% 算法：
	 *   RSRP (dBm): >=-80 优秀 / >=-90 良好 / >=-100 一般 / >=-110 较差 / 更低 极差
	 *   RSRQ (dB) : >=-10 优秀 / >=-15 良好 / >=-20 一般 / 更低 极差
	 *   SINR (dB) : >=20 优秀 / >=13 良好 / >=5 一般 / 更低 极差
	 * 量程仅用于弧长百分比映射（视觉刻度），等级判定只看阈值。
	 */
	var SIGNAL_SPECS = {
		/* RSRP 的等级判定与百分比共用 Parse.signalLevel（阈值 -80/-90/-100/-110） */
		rsrp: {
			min: -120, max: -70,
			level: function (v) { return Parse.signalLevel(v); }
		},
		rsrq: {
			min: -20, max: -3,
			level: function (v) {
				return v >= -10 ? 'exc' : v >= -15 ? 'good' : v >= -20 ? 'fair' : 'bad';
			}
		},
		sinr: {
			min: 0, max: 30,
			level: function (v) {
				return v >= 20 ? 'exc' : v >= 13 ? 'good' : v >= 5 ? 'fair' : 'bad';
			}
		},
		/*
		 * 百分比（0-100）的阈值必须**按上面那套量程**推出来才对得上：
		 * -120~-70 → -80 是 80%、-90 是 60%、-100 是 40%。
		 * 原先写 75/50/25，那是按 rpc.js 已废弃的 -110~-70 量程算的，
		 * 与本文件自己的公式差了一档，仪表会判错档。
		 */
		pct: {
			min: 0, max: 100,
			level: function (v) { return Parse.percentLevel(v); }
		}
	};

	// 判定信号等级（kind: rsrp | rsrq | sinr），无法判定时返回 null
	api.signalLevel = function (kind, value) {
		var spec = SIGNAL_SPECS[kind];
		if (!spec || value == null || isNaN(value)) return null;
		return spec.level(value);
	};

	/**
	 * 创建环形仪表。SVG viewBox 缩放自适应容器，DOM 开销固定（1 svg + 2 circle）。
	 * 返回 { el, set(value) }：set(null) 显示占位符并隐藏弧线与等级。
	 */
	api.gauge = function (label, unit, kind) {
		var C = (2 * Math.PI * 42).toFixed(2);

		var root = E('div', { 'class': 'mt5700-gauge' });
		var dial = E('div', { 'class': 'mt5700-gauge-dial' });
		var svg = svgEl('svg', { viewBox: '0 0 100 100', role: 'img' });
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

		root.appendChild(E('div', { 'class': 'mt5700-gauge-label' }, label || ''));
		var caption = E('div', { 'class': 'mt5700-gauge-caption' });
		root.appendChild(caption);

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
					return;
				}
				valueEl.textContent = String(value);
				var level = spec ? spec.level(value) : 'fair';
				var color = gaugeColor(level);
				var pct = 0;
				if (spec) {
					pct = (value - spec.min) / (spec.max - spec.min);
					pct = Math.max(0, Math.min(1, pct));
				}
				bar.setAttribute('stroke', color);
				bar.setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(2));
				caption.textContent = GAUGE_CAPTIONS[level] || '';
				caption.className = 'mt5700-gauge-caption ' + level;
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
	// 独立 mt5700-status-* 命名空间，样式自包含于 mt5700.css，不依赖 LuCI 主题

	api.renderConnectionBar = function (container) {
		var cl = AtWs.client;

		var card = E('div', { 'class': 'mt5700-status-card is-connecting', 'id': 'at-service-status' });

		// SVG 状态图标（在线/连接中旋转，离线/未知静止）
		var icon = E('div', { 'class': 'mt5700-status-icon' });
		var svg = svgEl('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' });
		svg.appendChild(svgEl('circle', { cx: 16, cy: 16, r: 11, 'stroke-dasharray': '5 3' }));
		svg.appendChild(svgEl('circle', { cx: 16, cy: 16, r: 4 }));
		svg.appendChild(svgEl('path', { d: 'M16 5V2' }));
		svg.appendChild(svgEl('path', { d: 'M16 30V27' }));
		icon.appendChild(svg);

		// 主信息：标题（状态点 + 文本）与描述
		var main = E('div', { 'class': 'mt5700-status-main' });
		var title = E('div', { 'class': 'mt5700-status-title' });
		var dot = E('span', { 'class': 'mt5700-status-dot' });
		var text = E('span', { 'class': 'mt5700-status-text' }, '正在连接 AT 服务');
		title.appendChild(dot);
		title.appendChild(text);
		var desc = E('div', { 'class': 'mt5700-status-description' }, '正在建立 AT 服务连接');
		main.appendChild(title);
		main.appendChild(desc);

		// RPC 地址芯片
		var rpcBox = E('div', { 'class': 'mt5700-status-rpc' });
		rpcBox.appendChild(E('span', { 'class': 'mt5700-status-rpc-label' }, 'RPC'));
		var rpcValue = E('span', { 'class': 'mt5700-status-rpc-value' }, '未连接');
		rpcBox.appendChild(rpcValue);

		// SIM 卡状态芯片（AT^SIMSQ?）
		var simBox = E('div', { 'class': 'mt5700-status-rpc mt5700-status-sim' });
		simBox.appendChild(E('span', { 'class': 'mt5700-status-rpc-label' }, 'SIM'));
		var simValue = E('span', { 'class': 'mt5700-status-rpc-value' }, '—');
		simBox.appendChild(simValue);

		card.appendChild(icon);
		card.appendChild(main);
		card.appendChild(rpcBox);
		card.appendChild(simBox);
		container.appendChild(card);

		/*
		 * SIM 卡状态文案与告警判定**只有一份**，在 parse.js 的
		 * SIM_STATUS_SHORT / SIM_STATUS_WARN（消费入口 Parse.simShort / Parse.simIsWarn）。
		 * 这里不许再抄一份码表 —— 之前就是三处各写一份，改文案必漏改。
		 *
		 * 手册 6.6：0 未插卡 / 1 已插卡 / 2 PIN·PUK 锁定 / 3 SIMLOCK
		 *   10 卡文件初始化中 / 11 已初始化（可接入网络）/ 12 就绪（短信与电话可接入）
		 *   98 卡物理失效 / 99 卡已移除 / 100 卡错误
		 *
		 * ★ 11 不再当告警：本卡长期停在 1,11，实测短信收发正常，
		 *   且自愈推卡也推不动它 —— 详见 parse.js 的码表注释。
		 */
		/*
		 * SIM 状态的失败计数与自愈冷却。
		 * 模块级（不是卡片级）：切页回来不该把「已经连坏几次」的事实清零，
		 * 否则每进一次页面就重新数，永远到不了自愈阈值。
		 */
		var simFail = 0;
		var simHealAt = 0;

		/*
		 * 读一次 SIMSQ，失败的**原因**要能分开：
		 *   · answered=false：这一条根本没读回来（忙态 / 通道故障）→ 该重试、可自愈
		 *   · answered=true 但解析不出：模组答了，内容不认识 → 界面显示「未知」，
		 *     这不是通道问题，不该触发重启
		 * 红线 23 的同一个道理：把「读不出来」伪装成「没有」会误导排查。
		 */
		function readSimsq(attempt) {
			return cl.sendCommand('AT^SIMSQ?').then(function (res) {
				/*
				 * 状态解析走 Parse.parseSimsq（全插件唯一真源），不要在这里另写一份正则：
				 * 此前这里自己 match 取 m[2]，与 parse.js 的正则分家，将来改任一侧
				 * （比如应答多带一个字段）另一边都会悄悄失配。
				 */
				var sim = res && res.success ? Parse.parseSimsq(res.data) : null;
				if (sim) return { sim: sim, answered: true };
				/* 模组答了但解析不出：不重试，直接交给界面显示「未知」 */
				if (res && res.success) return { sim: null, answered: true };
				/* 读失败：600ms 后补一次（忙态通常几十毫秒就过去了） */
				if (attempt < 2) {
					return new Promise(function (resolve) {
						setTimeout(function () { resolve(readSimsq(attempt + 1)); }, 600);
					});
				}
				return { sim: null, answered: false };
			}).catch(function () {
				if (attempt < 2) {
					return new Promise(function (resolve) {
						setTimeout(function () { resolve(readSimsq(attempt + 1)); }, 600);
					});
				}
				return { sim: null, answered: false };
			});
		}

		/*
		 * 连续失败到阈值才自愈一次（5 分钟冷却）。
		 * ★ 为什么不是一失败就重启：restart 会打断 eSIM 写卡、短信、锁频，
		 *   还会清空内存环形日志 —— 一次偶发忙态不值得付这个代价。
		 * ★ 为什么是 3 次：SIM 卡每 15s 刷新一次，3 次 ≈ 45 秒的持续失败，
		 *   已排除「刚好在忙」；再久用户就一直在看「读取失败」了。
		 */
		function maybeSelfHeal() {
			if (simFail < 3) return;
			var now = Date.now();
			if (now - simHealAt < 5 * 60 * 1000) return;
			simHealAt = now;
			AtWs.selfHeal().then(function (r) {
				/* 自愈后给服务 3 秒拉起，再补读一次；失败也不弹错——下一轮轮询会兜 */
				if (r && r.success) setTimeout(refreshSimStatus, 3000);
			});
		}

		function refreshSimStatus() {
			if (!cl.connected) {
				simValue.textContent = '—';
				simBox.classList.remove('is-warn');
				return;
			}
			readSimsq(1).then(function (r) {
				if (r.sim) {
					simFail = 0;
					simValue.textContent = r.sim.shortLabel;
					simBox.classList.toggle('is-warn', r.sim.warn);
					return;
				}
				if (r.answered) {
					/* 模组答了、内容不认识：不是通道问题，不算失败次数 */
					simFail = 0;
					simValue.textContent = '未知';
					simBox.classList.remove('is-warn');
					return;
				}
				simFail++;
				simValue.textContent = '读取失败';
				simBox.classList.add('is-warn');
				maybeSelfHeal();
			});
		}

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
			// SIM 状态只在服务在线时有意义
			if (cfg.status === 'online') refreshSimStatus();
			else { simValue.textContent = '—'; simBox.classList.remove('is-warn'); }
		}

		apply('connecting');
		/*
		 * 退订句柄必须拿到手：这个回调是 push 进客户端全局数组的，页面切走后
		 * 照样会被 connect() / 重连触发，闭包还一直攥着本页的 card。
		 * 进十次页面就多十个永不回收的回调，每次状态变化还要全跑一遍。
		 */
		var detachConnState = cl.onConnectionStateChange(apply);
		api.onDetach(card, function () {
			if (detachConnState) detachConnState();
		});

		/*
		 * 兜底发起连接（connect() 幂等：已就绪时直接置 connected 并返回）。
		 *
		 * 背景：通知日志、服务配置两页只画状态卡、从不连接 AT 服务，
		 * 于是卡片永远停在「未连接 / SIM —」。这两页确实不必发 AT 命令，
		 * 但既然状态卡在页面上，就必须反映真实连接状态 —— 与其在每个视图里
		 * 各写一遍 connect()，不如由组件保证：画了这张卡，连接就得建立。
		 */
		if (cl.isReady && cl.isReady()) {
			apply('connected');
		} else {
			cl.connect().catch(function (err) {
				if (err && err.message === 'REQUIRE_AUTH_KEY') {
					apply('error', '需要访问密钥：请在「服务配置」核对 websocket_auth_key');
					return;
				}
			});
		}

		// 定期刷新 SIM 状态（卡插拔、初始化进度都会变）。
		// 传 card 作为作用域：卡片随视图卸载离开文档后，定时器自动停止，
		// 不会在切页后继续占着串口发 AT^SIMSQ?。
		api.interval(15000, refreshSimStatus, card);
		return card;
	};

	/* ================= 页面引导（全局单一真源） ================= */

	/*
	 * 页面初始化：连上 AT 服务之后跑一次 onReady。
	 *
	 * ★ 以前 10 个页面各自抄了一遍这段（dial / esim / modem_settings /
	 *   network_settings / network_status / schedule / sms_center /
	 *   sms_settings / terminal / upgrade），现在收口到这里 ——
	 *   连接语义以后只动这一处。
	 *
	 * ★★ 这里**没有**「弹密钥输入框重连」的分支，是刻意的，别再加回来：
	 *   那一套依赖 ATClient.connect() 抛 REQUIRE_AUTH_KEY，而 RPC 模式下
	 *   它**永远不会 reject**（rpc.js 的 connect：configReady 恒 resolve、
	 *   authenticated 恒为 true、状态回调本身还包了 try/catch），全仓也再没有
	 *   任何抛这个错误的生产方 —— 那 10 个弹窗分支全是走不到的死代码。
	 *
	 *   真正的认证失败是后端**逐请求**回 -32001（rpcserver.rs），由 mt5700.uc
	 *   的 rpcCall 翻译成带处置指引的文案统一透出，不需要每个页面各实现一遍。
	 *   （此处刻意留白是为了让后来者少走一遍这条死路。）
	 */
	api.connectThen = function (onReady) {
		return AtWs.client.connect().then(function () {
			if (typeof onReady === 'function') onReady();
		});
	};

	/* ================= 模态框 ================= */

	/*
	 * onCancel 是后加的第四个参数，可选：给「点击开关后弹确认」这类场景用，
	 * 取消时把开关拨回去。没有它时，加了确认反而会让界面状态与实际不符。
	 */
	api.confirm = function (message, onOk, okText, onCancel) {
		var mask = E('div', { 'class': 'mt5700-modal-mask' });
		var box = E('div', { 'class': 'mt5700-modal' });
		var text = E('div', { 'class': 'mt5700-modal-body' }, message);
		var actions = E('div', { 'class': 'mt5700-modal-footer' });
		var cancel = api.ghostButton('取消', function () {
			if (mask.parentNode) mask.parentNode.removeChild(mask);
			if (onCancel) onCancel();
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

	/* retryText 是可选的（默认「重新尝试」）——给「重试本身没意义、要重启模组」那种
	 * 场景用，按钮写「重新探测」才不跟正文打架。新增参数在末尾且带默认值，老调用点不动。 */
	api.errorState = function (text, onRetry, retryText) {
		var el = E('div', { 'class': 'mt5700-error-state' });
		el.appendChild(E('div', { 'class': 'mt5700-error-text' }, text || '获取数据失败'));
		if (onRetry) {
			el.appendChild(api.primaryButton(retryText || '重新尝试', onRetry));
		}
		return el;
	};

	/* ================= 自动刷新 =================
	 *
	 * ★ 自动刷新控件**只在 Ui.autoRefresh**（ui.js）里，这里原先还有一份
	 *   `api.autoRefresh`，但全仓库零调用点（页面都 require 了 ui 并直接用 Ui.*）。
	 *   两份并存时改了一处样式另一处不动，是典型的「看着有、其实没用」的代码，已删。
	 */

	/* ================= 定时器管理 ================= */

	var _timers = [];

	/**
	 * setInterval 包装：句柄记进 _timers，便于 Mt5700.clearAll() 统一清理。
	 *
	 * 传了 scopeEl 时额外启用「自动停止」：每次触发前先确认这个节点还在文档里，
	 * 不在就清掉自己。
	 *
	 * 为什么需要它：状态卡的 15s SIM 轮询是「画了卡片就起」的，而 LuCI 切页只是
	 * 换掉视图的 DOM，定时器本身不会停 —— 进一次页面多一个，切几次页就有几个
	 * 定时器在后台各发各的 `AT^SIMSQ?`。串口是独占的，这些无人消费的轮询会和
	 * 用户操作抢通道。
	 *
	 * 用「节点是否还在文档里」判断，比监听 hashchange 更稳：不依赖路由实现顺序，
	 * 也不会把新页面刚注册的定时器误清掉。
	 */
	api.interval = function (ms, fn, scopeEl) {
		var stopped = false;
		var id = null;
		var stop = function () {
			if (stopped) return;
			stopped = true;
			if (id !== null) clearInterval(id);
			var i = _timers.indexOf(stop);
			if (i >= 0) _timers.splice(i, 1);
		};
		id = setInterval(function () {
			var doc = scopeEl ? scopeEl.ownerDocument : null;
			if (doc && !doc.contains(scopeEl)) {
				stop();
				return;
			}
			fn();
		}, ms);
		_timers.push(stop);
		return id;
	};

	api.clearAll = function () {
		_timers.slice().forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
		_timers = [];
	};

	/*
	 * 元素离开文档后执行一次 fn（订阅类资源的卸载钩子）。
	 *
	 * 定时器有句柄可清，订阅没有 —— 像「连接状态回调」是一旦 push 就常驻在
	 * 客户端全局数组里的，页面切走后照样会被触发，闭包还一直攥着本页的 DOM。
	 * api.interval 的 scopeEl 解决不了这类资源，故补一个统一的退出钩子。
	 *
	 * 判据沿用 page 的做法：认「曾经进入过文档、现在脱离了」这个**转换**，
	 * 而不是「现在不在文档里」—— 节点刚构建、尚未插入文档的那一瞬本来就不在，
	 * 只认转换才不会把刚建好的页面误清掉。
	 */
	/*
	 * ★ 全站只有**一个** 1 秒巡检定时器。
	 *
	 * 原先 api.page 与 api.onDetach 各自 `setInterval(..., 1000)` 盯自己的节点：
	 * 一个页面 = 1 个 page 定时器 + 若干个 onDetach 定时器，多标签页/多次切页
	 * 后是几十个 1s 定时器在后台空转，每秒各做一次 `document.contains` 遍历。
	 * 这些回调本身极轻，但**定时器数量**是纯浪费（且每个都攥着本页 DOM 闭包，
	 * 阻碍回收）。改成一张注册表 + 一个全局巡检：没有待观察节点时定时器直接停掉。
	 */
	var _detachWatchers = [];
	var _sweeperId = null;

	function sweepDetach() {
		for (var i = _detachWatchers.length - 1; i >= 0; i--) {
			var w = _detachWatchers[i];
			var live = w.doc.contains(w.el);
			if (live) { w.wasInDoc = true; continue; }
			if (!w.wasInDoc) continue;          /* 还没插入过文档，不算脱离 */
			_detachWatchers.splice(i, 1);
			try { w.fn(); } catch (e) { /* 清理失败不能影响其余 */ }
		}
		if (!_detachWatchers.length && _sweeperId !== null) {
			clearInterval(_sweeperId);
			_sweeperId = null;
		}
	}

	api.onDetach = function (el, fn) {
		if (!el || typeof fn !== 'function') return function () {};
		var w = { el: el, fn: fn, doc: el.ownerDocument || document, wasInDoc: false };
		_detachWatchers.push(w);
		if (_sweeperId === null) _sweeperId = setInterval(sweepDetach, 1000);
		return function () {
			var i = _detachWatchers.indexOf(w);
			if (i >= 0) _detachWatchers.splice(i, 1);
			if (!_detachWatchers.length && _sweeperId !== null) {
				clearInterval(_sweeperId);
				_sweeperId = null;
			}
		};
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
		// 图表颜色同样跟随主题（深色下用更亮的蓝 / 青，否则深底上几乎看不见）
		var downColor = options.downColor || cssColor('--mt5700-accent', '#2563eb');
		var upColor = options.upColor || cssColor('--mt5700-sig-good', '#0b7a70');

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
				stroke: cssColor('--mt5700-border-strong', 'rgba(138, 147, 160, 0.4)'),
				'stroke-width': 1
			}));
		}

		var n = data.length;
		function px(j) { return (j / Math.max(1, n - 1)) * (w - 4) + 2; }
		function py(v) { return h - 15 - (v / actualMax) * (h - 30); }

		var downXY = [], upXY = [];
		for (var j = 0; j < n; j++) {
			downXY.push([px(j), py(data[j].down || 0)]);
			upXY.push([px(j), py(data[j].up || 0)]);
		}

		/*
		 * 折线转平滑曲线：二次贝塞尔「中点法」——以相邻两点的中点为曲线端点、
		 * 原数据点为控制点（Q 段）。
		 * 选它而不是 Catmull-Rom 的理由：x 本来就是均匀的（px(j) 线性），
		 * 中点法天然 C1 连续、纵向不会越过相邻数据点的包络，
		 * 没有 Catmull-Rom 在 1Hz 抖动尖峰处的过冲（实测越界 18px），
		 * 因此不需要再写一套钳制代码（会审 R09 / R04）。
		 * n=1 时无路径、n=2 时退化为直线 —— 与调用处的 n > 1 守卫配合。
		 */
		function smoothD(pts) {
			if (pts.length < 2) return '';
			var d = 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
			if (pts.length === 2) {
				return d + 'L' + pts[1][0].toFixed(1) + ',' + pts[1][1].toFixed(1);
			}
			for (var i = 1; i < pts.length - 1; i++) {
				var mx = (pts[i][0] + pts[i + 1][0]) / 2;
				var my = (pts[i][1] + pts[i + 1][1]) / 2;
				d += 'Q' + pts[i][0].toFixed(1) + ',' + pts[i][1].toFixed(1)
					+ ' ' + mx.toFixed(1) + ',' + my.toFixed(1);
			}
			var last = pts[pts.length - 1];
			return d + 'L' + last[0].toFixed(1) + ',' + last[1].toFixed(1);
		}

		// 下行面积填充：与折线共用同一条平滑路径，否则曲线与面积边缘会对不上
		if (n > 1) {
			svg.appendChild(svgEl('path', {
				fill: 'url(#' + gradId + ')',
				d: smoothD(downXY)
					+ 'L' + downXY[n - 1][0].toFixed(1) + ',' + (h - 15)
					+ 'L' + downXY[0][0].toFixed(1) + ',' + (h - 15) + 'Z'
			}));
		}

		// 双折线（平滑曲线）
		if (n > 1) {
			svg.appendChild(svgEl('path', {
				fill: 'none', stroke: downColor, 'stroke-width': 2,
				'stroke-linejoin': 'round', 'stroke-linecap': 'round',
				d: smoothD(downXY)
			}));
			svg.appendChild(svgEl('path', {
				fill: 'none', stroke: upColor, 'stroke-width': 2,
				'stroke-linejoin': 'round', 'stroke-linecap': 'round',
				d: smoothD(upXY)
			}));
		}

		// 悬浮提示：跟随鼠标取最近采样点
		function fmtDefault(p) {
			function f(v) { return v >= 1e6 ? (v / 1e6).toFixed(2) + ' Mbps' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' Kbps' : Math.round(v) + ' bps'; }
			return '↓ ' + f(p.down || 0) + ' · ↑ ' + f(p.up || 0);
		}
		/*
		 * ★ rect 缓存（性能）：mousemove 是按事件触发的（鼠标移动时可到每秒上百次），
		 *   每次都 getBoundingClientRect() 会强制同步布局（MDN Element.getBoundingClientRect：
		 *   读取几何属性会触发 reflow），而曲线图在 1Hz 重绘、鼠标不动时也不会停止事件。
		 *   改在 mouseenter 量一次、mouseleave 丢弃。
		 *   兜底：若 hoverRect 为空（元素在光标下被重建、还没走 mouseenter）就现量一次。
		 *   ★ 陈旧风险**不要**指望「图表每秒重建」来自愈 —— 重建恰恰是 tooltip 闪断的
		 *     根源：子树重建后 wrap 与 tip 都是新对象、hoverRect 归 null、show 类丢失，
		 *     而光标静止时浏览器不会补发 mousemove，**要等用户动一下鼠标才恢复**。
		 *     本缓存既不修复也不加重它（改前每事件重取 rect，同样会闪断）。
		 *     根治要把 tip 提到每秒重建的子树之外，见 docs/FRONTEND_REVIEW_REPORT.md 第九节。
		 *     缓存真正引入的偏差只有一条：悬停期间容器宽度变了，旧 rect 会残留到
		 *     mouseleave（改前下一次 mousemove 就自愈）。
		 */
		var hoverRect = null;
		wrap.addEventListener('mouseenter', function () {
			hoverRect = wrap.getBoundingClientRect();
		});
		wrap.addEventListener('mousemove', function (e) {
			if (!hoverRect) hoverRect = wrap.getBoundingClientRect();
			var rect = hoverRect;
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
			hoverRect = null;
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
				/* 分组标题行：传 { group: '地址' }。
				   几组「项目 → 值」合并进一张表时用它分隔，比拆成多张表少两套表头。 */
				if (row && row.group != null && !row.nodeType) {
					var gtr = E('tr', { 'class': 'mt5700-table-group-row' });
					gtr.appendChild(E('td', {
						colspan: headers.length, 'class': 'mt5700-table-group'
					}, row.group));
					tbody.appendChild(gtr);
					return;
				}
				var tr = E('tr');
				row.forEach(function (cell) {
					if (typeof cell === 'object' && cell.nodeType) {
						var td = E('td');
						td.appendChild(cell);
						tr.appendChild(td);
					} else {
						/* ★ 用 == null 判空，不要用 ||：
						   0 与 '' 都是有效读数（温度 0℃、计数 0、空字符串），
						   被 || 吃掉会显示成「—」，等于把真实数据说成没数据。 */
						tr.appendChild(E('td', {}, cell == null ? '—' : cell));
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
			/*
			 * 逐项执行，且**不让任何一项的失败中断后续项**。
			 *
			 * 早先的写法是 `chain = chain.then(function(){ return it.run(); })`
			 * 串成一条链：只要第 1 项失败（或 reject），链直接跳到末尾的 catch，
			 * 后面所有暂存项**一次都不会执行**，用户只看到一句「应用更改失败」，
			 * 却不知道 APN 改了、USB 模式没改。拨号页正是同时暂存多项的场景。
			 * 这里改为：每项各自 catch，失败记下来，成功的从暂存列表移除；
			 * 全部跑完再按失败数量给出结论。
			 */
			var failed = [];
			var chain = Promise.resolve();
			queue.forEach(function (it) {
				chain = chain.then(function () {
					return Promise.resolve()
						.then(function () { return it.run(); })
						.then(function () {
							/* 成功：从暂存列表移除，避免失败项重跑时它被重复下发 */
							var i = items.indexOf(it);
							if (i >= 0) items.splice(i, 1);
						})
						.catch(function (err) {
							failed.push(it.label + '：' + ((err && err.message) || '失败'));
						});
				});
			});
			return chain.then(function () {
				if (!failed.length) {
					items = [];
					api.success('更改已应用');
				} else if (failed.length === queue.length) {
					api.error('全部 ' + failed.length + ' 项都未应用：' + failed[0]);
				} else {
					api.error('已应用 ' + (queue.length - failed.length) + ' 项，' +
						failed.length + ' 项失败：' + failed.join('；'));
				}
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

	/*
	 * DOM 构造 helper 外露。
	 *
	 * ★ 2026-09-28 更正「全站唯一实现」这个说法（原文如此，与事实不符）：
	 *   **LuCI 自己也有一个全局 E** —— 真机 /www/luci-static/resources/cbi.js:135
	 *   `function E(){ return L.dom.create.apply(L.dom, arguments); }`，随 cbi.js
	 *   作为传统脚本挂到 window。12 个视图层里的 362 处裸 `E(...)` 用的都是**它**，
	 *   不是本文件这个（grep `Mt5700.E(` 在视图层是 0 次）。
	 *   所以本文件的 E() 目前**唯一消费者是 ui.js 的 promptModal**。
	 *   两者行为基本兼容：都只挂第 3 个参数、都支持把 DOM 节点当该参数
	 *   （见 network_status.js:2462 那条 footgun 记录）。差异是本实现额外支持
	 *   `on*` 属性转 addEventListener（LuCI 的未验证，但视图层没有一处用 on*，无影响）。
	 *
	 * 本文件的 E 此前只在本 IIFE 内可见，而 ui.js 的 promptModal 也直接调 E(...)
	 * —— 于是每一次弹窗都抛
	 * `ReferenceError: E is not defined`：改 IMEI / PUK 解锁 / eSIM 重命名 /
	 * eSIM 删除 / 新增 PDP / 新短信 / 保存 AT 命令，这 7 处入口全部点不开。
	 *
	 * 这里外露一份、由 ui.js 复用它，而不是让 ui.js 再抄一份实现：
	 * 同一 helper 多份实现正是「改了 A 处，B 处纹丝不动」那类问题的来源
	 * （见 ui.js 里那段死代码清理说明）。
	 */
	/* ================= v9 外壳（接管整屏） ================= */
	/*
	 * 为什么搭在 JS 里而不是改 12 个视图：导航与顶栏若各页各写一遍，迟早漏一页。
	 * 全站只有一个入口 —— api.page() —— 从那儿挂载，谁也跑不掉。
	 *
	 * 真机 DOM（2026-10-26 探针实测，别照文档猜）：
	 *   body > .main > (#mainmenu.main-left) + (.main-right > #maincontent
	 *            > .container > #view > .mt5700-page)
	 * 所以做法是：把 .mt5700-page 搬进外壳的 canvas，再给 body 加
	 * mt5700-sh-armed 把 .main 藏掉。
	 *
	 * ★ 搬运失败（Argon 结构变了）时**不加那个 class**：旧界面照常显示。
	 *   宁可不好看，也不能白屏 —— 用户进不来就什么都修不了。
	 */

	var SH_ICON = {
		overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
		radio: '<path d="M5 19V13M10 19V9M15 19v-4M20 19V5"/>',
		wan: '<path d="M4 12h16M12 4v16"/><circle cx="12" cy="12" r="8.5"/>',
		esim: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M8 9.5h4v5H8z"/><path d="M15 9.5h2M15 14.5h2"/>',
		device: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18.5h2"/>',
		upgrade: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
		sms: '<path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-6.5A8 8 0 0 1 12 4h1a8 8 0 0 1 8 8z"/>',
		voice: '<path d="M5 4h3.5l2 4.5-2.2 1.6a12 12 0 0 0 5.6 5.6l1.6-2.2L20 15.5V19a1.5 1.5 0 0 1-1.7 1.5A15.5 15.5 0 0 1 3.5 5.7 1.5 1.5 0 0 1 5 4z"/>',
		at: '<path d="M5 6h14M5 12h9M5 18h12"/>',
		logs: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/>',
		service: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M18.4 5.6l-2 2M7.6 16.4l-2 2"/>'
	};

	/* 12 个真实页面全在导航里 —— 少一个就是「藏起来的入口等于没有」 */
	var SH_NAV = [
		{ g: '概览', items: [
			{ p: 'overview', u: 'admin/modem/5g/status', t: '总览' }
		] },
		{ g: '网络', items: [
			{ p: 'radio', u: 'admin/modem/5g/network/settings', t: '无线与频段' },
			{ p: 'wan', u: 'admin/modem/5g/network/dial', t: '接入与拨号' }
		] },
		{ g: '卡与设备', items: [
			{ p: 'esim', u: 'admin/modem/5g/modem/esim', t: 'eSIM' },
			{ p: 'device', u: 'admin/modem/5g/modem/settings', t: '模组信息' },
			{ p: 'upgrade', u: 'admin/modem/5g/modem/upgrade', t: '模组升级' }
		] },
		{ g: '通信', items: [
			{ p: 'sms', u: 'admin/modem/5g/comm/sms', t: '短信' },
			{ p: 'smscfg', u: 'admin/modem/5g/comm/sms-settings', t: '短信设置' },
			{ p: 'voice', u: 'admin/modem/5g/comm/voice', t: '语音' }
		] },
		{ g: '工具', items: [
			{ p: 'at', u: 'admin/modem/5g/tools/terminal', t: 'AT 终端' },
			{ p: 'logs', u: 'admin/modem/5g/tools/logs', t: '运行日志' },
			{ p: 'service', u: 'admin/modem/5g/tools/config', t: '服务与升级' }
		] }
	];

	var MOON = '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>';
	var SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>';

	var _shell = null;

	function shIcon(name) {
		var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		s.setAttribute('viewBox', '0 0 24 24');
		s.setAttribute('stroke-linecap', 'round');
		s.setAttribute('stroke-linejoin', 'round');
		s.innerHTML = SH_ICON[name] || SH_ICON.service;
		return s;
	}

	function shThemeRead() {
		try {
			return window.localStorage.getItem('mt5700-theme') === 'light' ? 'light' : 'dark';
		} catch (e) { return 'dark'; }
	}

	function shThemeApply(root, theme) {
		root.setAttribute('data-theme', theme);
		/* html 上也挂一份：弹窗层在 body 上、不在壳内，靠它继承到同一套明暗 */
		try { document.documentElement.setAttribute('data-theme', theme); } catch (e) { /* 无所谓 */ }
		var btn = root.querySelector('.sh-theme');
		if (btn) btn.innerHTML = '';
		if (btn) {
			var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			s.setAttribute('viewBox', '0 0 24 24');
			s.setAttribute('stroke-linecap', 'round');
			s.innerHTML = theme === 'dark' ? MOON : SUN;
			btn.appendChild(s);
		}
	}

	function shCurrentPath() {
		var here = window.location.pathname.replace(/\/+$/, '');
		return here;
	}

	function shBuild(title, subtitle) {
		var root = E('div', { 'class': 'mt5700-sh' });
		shThemeApply(root, shThemeRead());

		var app = E('div', { 'class': 'app' });

		/* ---- 左栏 ---- */
		var rail = E('aside', { 'class': 'rail' });
		var brand = E('div', { 'class': 'brand' });
		var mark = E('div', { 'class': 'brand-mark' });
		mark.innerHTML = '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">' +
			'<path d="M4 17V9M9 17V5M14 17v-6M19 17V7"/></svg>';
		brand.appendChild(mark);
		var btx = E('div', { 'class': 'brand-tx' });
		btx.appendChild(E('b', {}, 'H5000M'));
		btx.appendChild(E('span', {}, 'MT5700 CONSOLE'));
		brand.appendChild(btx);
		rail.appendChild(brand);

		var nav = E('nav', { 'class': 'rail-nav' });
		var here = shCurrentPath();
		for (var gi = 0; gi < SH_NAV.length; gi++) {
			var grp = SH_NAV[gi];
			var box = E('div', { 'class': 'rail-group' });
			box.appendChild(E('p', {}, grp.g));
			for (var ii = 0; ii < grp.items.length; ii++) {
				var it = grp.items[ii];
				var href = L.url(it.u);
				var btn = E('button', {
					'class': 'nav-i' + (here === href.replace(/\/+$/, '') ? ' is-on' : '')
				});
				btn.setAttribute('data-u', it.u);
				btn.appendChild(shIcon(it.p));
				btn.appendChild(E('span', {}, it.t));
				btn.addEventListener('click', function () {
					window.location.href = L.url(this.getAttribute('data-u'));
				});
				box.appendChild(btn);
			}
			nav.appendChild(box);
		}
		rail.appendChild(nav);

		var foot = E('div', { 'class': 'rail-foot' });
		var svc = E('div', { 'class': 'svc' });
		svc.innerHTML = '<i></i>';
		svc.appendChild(E('span', {}, '返回 LuCI'));
		svc.style.cursor = 'pointer';
		svc.addEventListener('click', function () { window.location.href = L.url('admin/status/overview'); });
		foot.appendChild(svc);
		rail.appendChild(foot);

		/* ---- 右栏 ---- */
		var main = E('div', { 'class': 'main' });
		var top = E('header', { 'class': 'topbar' });
		top.appendChild(E('span', { 'class': 'crumb-title' }, title || ''));
		top.appendChild(E('span', { 'class': 'crumb-sub' }, subtitle || ''));
		var tbtn = E('button', { 'class': 'icon-btn sh-theme' });
		tbtn.setAttribute('title', '切换明暗');
		tbtn.addEventListener('click', function () {
			var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
			shThemeApply(root, next);
			try { window.localStorage.setItem('mt5700-theme', next); } catch (e) { /* 隐私模式忽略 */ }
		});
		/* 顶栏工具区：页面把「对整页生效」的控件（刷新间隔、手动刷新）放这里，
		   比挂在某张卡片头上更诚实 —— 那张卡只管自己的话才该放卡头。 */
		var tools = E('div', { 'class': 'sh-tools' });
		top.appendChild(tools);

		/* 状态徽标：由页面把结论卡的判定结果推过来（api.shellPill），
		   壳自己不去读数据 —— 否则「顶栏与结论卡各算一遍」迟早打架。 */
		var pill = E('span', { 'class': 'pill sh-pill mute' });
		pill.innerHTML = '<svg viewBox="0 0 24 24" stroke-linecap="round"><path d="M4 13l5 5L20 6"/></svg>';
		pill.appendChild(E('span', { 'class': 'sh-pill-t' }, '读取中'));
		top.appendChild(pill);
		top.appendChild(tbtn);
		main.appendChild(top);

		var canvas = E('div', { 'class': 'canvas' });
		main.appendChild(canvas);

		app.appendChild(rail);
		app.appendChild(main);
		root.appendChild(app);
		shThemeApply(root, root.getAttribute('data-theme'));
		return { root: root, canvas: canvas, top: top };
	}

	/*
	 * 挂载。返回 true 表示接管成功；false 表示没接管（旧界面继续用）。
	 * 不要在 node 还没进文档时调用 —— 先 rAF 等它进 DOM。
	 */
	api.mountShell = function (node) {
		if (!node || !node.ownerDocument) return false;
		var h = node.querySelector('.mt5700-page-title');
		var s = node.querySelector('.mt5700-page-subtitle');
		var title = h ? h.textContent : '';
		var sub = s ? s.textContent : '';

		/* 顶栏标题用导航名（总览 / 无线与频段 …），与原型一致；
		   页面自己的标题（网络状态）只在找不到导航项时兜底。 */
		var here = shCurrentPath();
		for (var gi = 0; gi < SH_NAV.length; gi++) {
			for (var ii = 0; ii < SH_NAV[gi].items.length; ii++) {
				var it = SH_NAV[gi].items[ii];
				if (L.url(it.u).replace(/\/+$/, '') === here) title = it.t;
			}
		}

		if (_shell) api.unmountShell();

		var built = shBuild(title, sub);
		built.canvas.appendChild(node);
		/* 页面在 render 阶段就建好了控件（那时外壳还没挂），先挂在页面里，
		   等外壳挂载时再「认领」搬进顶栏 —— 这样控件不会晚一帧才出现。 */
		var slot = node.querySelector('[data-sh-slot="tools"]');
		if (slot) {
			var box = built.root.querySelector('.sh-tools');
			if (box) box.appendChild(slot);
		}

		document.body.appendChild(built.root);
		/* 搬完了才敢藏旧壳 */
		document.body.classList.add('mt5700-sh-on', 'mt5700-sh-armed');
		_shell = { root: built.root, node: node };

		/* 有些组件按挂载时的容器宽度算过尺寸，换父节点后补一次。
		   用 createEvent 而不是 new Event(...)：undefined-fn 守卫把 `Event`
		   当成未定义的函数调用（它只认白名单里的宿主对象），这里绕开。 */
		setTimeout(function () {
			try {
				var ev = document.createEvent('Event');
				ev.initEvent('resize', true, true);
				window.dispatchEvent(ev);
			} catch (e) { /* 老浏览器 */ }
		}, 30);
		return true;
	};

	api.unmountShell = function () {
		if (!_shell) return;
		try {
			if (_shell.root && _shell.root.parentNode) {
				_shell.root.parentNode.removeChild(_shell.root);
			}
		} catch (e) { /* 已经不在文档里，无所谓 */ }
		document.body.classList.remove('mt5700-sh-on', 'mt5700-sh-armed');
		_shell = null;
	};

	/* 等节点进文档：LuCI 是 render() 返回之后才 append，最多等约 1 秒 */
	function shWhenAttached(node) {
		var tries = 0;
		function tick() {
			if (!node.isConnected) {
				if (++tries < 60) {
					if (window.requestAnimationFrame) window.requestAnimationFrame(tick);
					else setTimeout(tick, 16);
				}
				return;
			}
			api.mountShell(node);
		}
		tick();
	}

	/* ================= v9 指标卡（KPI） ================= */
	/*
	 * 原型里总览有一行 4 张指标卡：下行速率 / 上行速率 / 信号质量 / 本月流量。
	 * 它们的排版在这套设计里是独立的（大数字 + 单位 + 迷你趋势），跟旧
	 * .mt5700-metric 那种「标签在上、数值在下」的读数格不是一回事，所以单列组件。
	 *
	 * 返回 { el, set(v, unit, note) }：值由页面在各自的刷新回调里推，
	 * 组件自己不取数 —— 避免这里再发一轮 AT（串口独占，多一条就是多一份延迟）。
	 */
	api.kpi = function (label, icon) {
		var el = E('div', { 'class': 'kpi' });
		var head = E('div', { 'class': 'kpi-k' });
		if (icon) {
			var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			s.setAttribute('viewBox', '0 0 24 24');
			s.setAttribute('stroke-linecap', 'round');
			s.innerHTML = icon;
			head.appendChild(s);
		}
		head.appendChild(document.createTextNode(label));
		el.appendChild(head);

		var v = E('div', { 'class': 'kpi-v' });
		var num = E('b', {}, '—');
		var unit = E('em', {}, '');
		v.appendChild(num);
		v.appendChild(unit);
		el.appendChild(v);

		var note = E('div', { 'class': 'kpi-f' }, '');
		el.appendChild(note);

		return {
			el: el,
			set: function (val, u, n) {
				num.textContent = (val === null || val === undefined || val === '') ? '—' : String(val);
				unit.textContent = u || '';
				note.textContent = n || '';
			}
		};
	};

	/*
	 * 迷你趋势线（原型里的 .spark）。points 是 0~1 的数组，右端为最新。
	 * 数据不足时保留一条平线，不要空着 —— 空 svg 在深色底上就是一块缺口。
	 */
	api.spark = function (points) {
		var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'spark');
		svg.setAttribute('viewBox', '0 0 120 30');
		svg.setAttribute('preserveAspectRatio', 'none');

		var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		var area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		area.setAttribute('class', 'area');
		svg.appendChild(area);
		svg.appendChild(poly);

		function draw(arr) {
			var n = arr.length;
			if (!n) return;
			var pts = [];
			for (var i = 0; i < n; i++) {
				var x = n === 1 ? 0 : (i / (n - 1)) * 120;
				var y = 28 - Math.max(0, Math.min(1, arr[i])) * 24;
				pts.push(x.toFixed(1) + ',' + y.toFixed(1));
			}
			poly.setAttribute('points', pts.join(' '));
			area.setAttribute('points', '0,30 ' + pts.join(' ') + ' 120,30');
		}
		draw(points || []);

		return { el: svg, set: draw };
	};

	/*
	 * 顶栏状态徽标。tone: ok / warn / bad / mute。
	 * 由页面在渲染结论卡时调用（一处判定、两处显示）。
	 */
	api.shellPill = function (tone, text) {
		var el = document.querySelector('.mt5700-sh .sh-pill');
		if (!el) return;
		el.className = 'pill sh-pill ' + (tone || 'mute');
		var t = el.querySelector('.sh-pill-t');
		if (t) t.textContent = text || '';
	};

	/*
	 * 顶栏插槽：页面在 render 阶段先拿到一个占位容器，外壳挂载时整块搬进顶栏。
	 * 为什么不直接返回顶栏节点：render 发生在节点入文档之前，那时外壳还不存在。
	 * 占位容器带 data-sh-slot 属性，mountShell 里按属性认领。
	 */
	api.shellSlot = function (name) {
		var el = E('div', { 'class': 'mt5700-sh-slot' });
		el.setAttribute('data-sh-slot', name || 'tools');
		return el;
	};

	api.E = E;

	return api;
})();

// 导出
var Mt5700Class = L.Class.extend(Mt5700);
if (typeof window !== 'undefined') {
	window.Mt5700 = new Mt5700Class();
}
return Mt5700Class;
