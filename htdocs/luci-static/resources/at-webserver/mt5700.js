'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/rpc';
'require at-webserver/parse';
/* global L, AtWs, Parse, baseclass */

/**
 * MT5700 LuCI 前端公共组件库：页面骨架、卡片/面板、表单控件、
 * 信号仪表与网络能力总评（木桶原理取最差项），以及实时速率折线图。
 */

// 注入新样式
var MT5700_CSS_VERSION = '2.17.0';
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

	/* ================= 动态 SVG 动效组件系统 ================= */

	/**
	 * 生成带 CSS 动画的现代化动态矢量插画 (160x120 viewBox)
	 * 为每个页面呈现定制的高科技白色毛玻璃动态图形
	 */
	api.heroIllustration = function (pageKey) {
		var svg = svgEl('svg', {
			'class': 'mt5700-hero-svg',
			viewBox: '0 0 160 120',
			fill: 'none',
			xmlns: 'http://www.w3.org/2000/svg'
		});

		var defs = svgEl('defs');
		// 柔和二次元渐变 1：薰衣草紫/靛蓝 (主色)
		var g1 = svgEl('linearGradient', { id: 'mt-g-accent', x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
		g1.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#a78bfa' }));
		g1.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#7c3aed' }));
		defs.appendChild(g1);

		// 柔和二次元渐变 2：青空蓝/薄荷绿
		var g2 = svgEl('linearGradient', { id: 'mt-g-cyan', x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
		g2.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#38bdf8' }));
		g2.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#06b6d4' }));
		defs.appendChild(g2);

		// 柔和二次元渐变 3：樱花粉/蜜桃红
		var g3 = svgEl('linearGradient', { id: 'mt-g-pink', x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
		g3.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#f472b6' }));
		g3.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#ec4899' }));
		defs.appendChild(g3);

		// 柔和二次元渐变 4：毛玻璃光晕底
		var g4 = svgEl('linearGradient', { id: 'mt-g-glass', x1: '0%', y1: '0%', x2: '0%', y2: '100%' });
		g4.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': '0.9' }));
		g4.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#ede9fe', 'stop-opacity': '0.45' }));
		defs.appendChild(g4);

		svg.appendChild(defs);

		// 二次元软萌外环星轨背景
		svg.appendChild(svgEl('circle', {
			cx: 80, cy: 60, r: 48,
			fill: 'url(#mt-g-glass)',
			stroke: 'rgba(199, 210, 254, 0.75)',
			'stroke-width': 1.5,
			'stroke-dasharray': '6 3'
		}));

		// 浮动小星芒
		svg.appendChild(svgEl('path', {
			d: 'M40 32 L42 26 L44 32 L50 34 L44 36 L42 42 L40 36 L34 34 Z',
			fill: '#fbbf24', 'class': 'mt-anim-pulse'
		}));
		svg.appendChild(svgEl('path', {
			d: 'M126 84 L127.5 79 L129 84 L134 85.5 L129 87 L127.5 92 L126 87 L121 85.5 Z',
			fill: '#f472b6', 'class': 'mt-anim-pulse'
		}));

		if (pageKey === 'network_status') {
			// 5G 实时遥测：基站信号波与二次元星环
			svg.appendChild(svgEl('circle', { cx: 80, cy: 56, r: 10, 'class': 'mt-anim-wave1', stroke: '#8b5cf6', 'stroke-width': '1.5', fill: 'none' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 56, r: 10, 'class': 'mt-anim-wave2', stroke: '#38bdf8', 'stroke-width': '1.5', fill: 'none' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 56, r: 10, 'class': 'mt-anim-wave3', stroke: '#f472b6', 'stroke-width': '1.5', fill: 'none' }));
			// 信号塔
			svg.appendChild(svgEl('path', { d: 'M70 94L80 44L90 94M74 76H86M77 62H83', stroke: '#6366f1', 'stroke-width': '2.2', 'stroke-linecap': 'round' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 42, r: 4.5, fill: 'url(#mt-g-pink)', 'class': 'mt-anim-pulse' }));
			// 5G 柔和气泡徽标
			svg.appendChild(svgEl('rect', { x: 104, y: 28, width: 32, height: 18, rx: 7, fill: 'url(#mt-g-accent)' }));
			var t = svgEl('text', { x: 120, y: 41, 'text-anchor': 'middle', fill: '#ffffff', 'font-size': '10', 'font-weight': 'bold', 'font-family': 'sans-serif' });
			t.textContent = '5G';
			svg.appendChild(t);
		} else if (pageKey === 'network_settings') {
			// 锁频与射频策略：科技陀螺仪与萌系锁头
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 36, stroke: '#a78bfa', 'stroke-width': '1.5', 'stroke-dasharray': '5 3', 'class': 'mt-anim-spin' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 24, fill: 'url(#mt-g-accent)', 'class': 'mt-anim-pulse' }));
			// 锁扣
			svg.appendChild(svgEl('rect', { x: 73, y: 55, width: 14, height: 13, rx: 3, fill: '#ffffff' }));
			svg.appendChild(svgEl('path', { d: 'M76 55V49C76 46.8 77.8 45 80 45C82.2 45 84 46.8 84 49V55', stroke: '#ffffff', 'stroke-width': '2.2', fill: 'none' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 61, r: 2, fill: '#6366f1' }));
			// 卫星频点节点
			svg.appendChild(svgEl('circle', { cx: 112, cy: 44, r: 4.5, fill: '#34d399', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('circle', { cx: 48, cy: 76, r: 4.5, fill: '#38bdf8', 'class': 'mt-anim-pulse' }));
		} else if (pageKey === 'dial') {
			// 拨号高速隧道：流动萌光火箭与数据泡
			svg.appendChild(svgEl('path', { d: 'M34 60C50 35 110 35 126 60C110 85 50 85 34 60Z', stroke: 'rgba(167, 139, 250, 0.35)', 'stroke-width': '2', fill: 'none' }));
			svg.appendChild(svgEl('path', { d: 'M34 60C50 35 110 35 126 60', stroke: '#8b5cf6', 'stroke-width': '2.8', fill: 'none', 'class': 'mt-anim-stream' }));
			svg.appendChild(svgEl('circle', { cx: 42, cy: 60, r: 7.5, fill: 'url(#mt-g-accent)', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('circle', { cx: 118, cy: 60, r: 7.5, fill: 'url(#mt-g-pink)', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 5.5, fill: '#0ea5e9' }));
		} else if (pageKey === 'scan') {
			// 全网扫频：360° 萌彩雷达与星图
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 38, stroke: 'rgba(139, 92, 246, 0.25)', 'stroke-width': '1.5', fill: 'none' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 24, stroke: 'rgba(56, 189, 248, 0.35)', 'stroke-width': '1', fill: 'none' }));
			svg.appendChild(svgEl('line', { x1: 42, y1: 60, x2: 118, y2: 60, stroke: 'rgba(167, 139, 250, 0.3)', 'stroke-width': '1' }));
			svg.appendChild(svgEl('line', { x1: 80, y1: 22, x2: 80, y2: 98, stroke: 'rgba(167, 139, 250, 0.3)', 'stroke-width': '1' }));
			var sweepG = svgEl('g', { 'class': 'mt-anim-sweep', style: 'transform-origin: 80px 60px;' });
			sweepG.appendChild(svgEl('line', { x1: 80, y1: 60, x2: 114, y2: 36, stroke: '#38bdf8', 'stroke-width': '2.5', 'stroke-linecap': 'round' }));
			sweepG.appendChild(svgEl('polygon', { points: '80,60 114,36 100,24', fill: 'rgba(167,139,250,0.3)' }));
			svg.appendChild(sweepG);
			svg.appendChild(svgEl('circle', { cx: 96, cy: 46, r: 3.5, fill: '#10b981', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('circle', { cx: 64, cy: 72, r: 3, fill: '#ec4899', 'class': 'mt-anim-pulse' }));
		} else if (pageKey === 'schedule') {
			// 定时调度：二次元星月怀表
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 34, stroke: '#8b5cf6', 'stroke-width': '2', fill: 'none' }));
			svg.appendChild(svgEl('path', { d: 'M80 32A28 28 0 0 1 108 60', stroke: '#f472b6', 'stroke-width': '4', fill: 'none', 'stroke-linecap': 'round' }));
			svg.appendChild(svgEl('line', { x1: 80, y1: 60, x2: 80, y2: 40, stroke: '#6366f1', 'stroke-width': '2.5', 'stroke-linecap': 'round' }));
			svg.appendChild(svgEl('line', { x1: 80, y1: 60, x2: 98, y2: 60, stroke: '#38bdf8', 'stroke-width': '2', 'stroke-linecap': 'round' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 4.5, fill: '#8b5cf6', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('path', { d: 'M62 46 C60 42 66 38 70 42 C67 44 64 45 62 46 Z', fill: '#fbbf24' }));
		} else if (pageKey === 'modem_settings') {
			// 模组核心 SoC：猫耳芯片与总线
			svg.appendChild(svgEl('path', { d: 'M62 38 L54 26 L68 32 Z', fill: 'url(#mt-g-pink)' }));
			svg.appendChild(svgEl('path', { d: 'M98 38 L106 26 L92 32 Z', fill: 'url(#mt-g-pink)' }));
			svg.appendChild(svgEl('rect', { x: 56, y: 36, width: 48, height: 48, rx: 10, fill: 'url(#mt-g-accent)', stroke: '#ffffff', 'stroke-width': '2', 'class': 'mt-anim-float' }));
			svg.appendChild(svgEl('rect', { x: 67, y: 47, width: 26, height: 26, rx: 6, fill: '#ffffff', 'fill-opacity': '0.92' }));
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 4, fill: '#ec4899' }));
			[44, 52, 60, 68, 76].forEach(function (y) {
				svg.appendChild(svgEl('line', { x1: 44, y1: y, x2: 56, y2: y, stroke: '#a78bfa', 'stroke-width': '2', 'stroke-linecap': 'round' }));
				svg.appendChild(svgEl('line', { x1: 104, y1: y, x2: 116, y2: y, stroke: '#a78bfa', 'stroke-width': '2', 'stroke-linecap': 'round' }));
			});
		} else if (pageKey === 'upgrade') {
			// 固件升级：云端胶囊与上升光芒
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 36, stroke: '#8b5cf6', 'stroke-width': '2', 'stroke-dasharray': '8 4', fill: 'none', 'class': 'mt-anim-spin' }));
			svg.appendChild(svgEl('path', { d: 'M62 66C60 62 62 55 68 53C70 45 80 43 85 47C90 44 98 48 97 55C102 58 101 66 96 68H64', fill: 'url(#mt-g-accent)', opacity: '0.88' }));
			var upArrow = svgEl('path', { d: 'M80 80V58M72 66L80 58L88 66', stroke: '#ffffff', 'stroke-width': '2.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'class': 'mt-anim-float' });
			svg.appendChild(upArrow);
		} else if (pageKey === 'sms_center') {
			// 短信中心：爱心信笺与浮动气泡
			svg.appendChild(svgEl('rect', { x: 44, y: 36, width: 52, height: 34, rx: 10, fill: 'url(#mt-g-accent)', 'class': 'mt-anim-float' }));
			svg.appendChild(svgEl('line', { x1: 54, y1: 47, x2: 86, y2: 47, stroke: '#ffffff', 'stroke-width': '2.2', 'stroke-linecap': 'round' }));
			svg.appendChild(svgEl('line', { x1: 54, y1: 55, x2: 76, y2: 55, stroke: 'rgba(255,255,255,0.75)', 'stroke-width': '2.2', 'stroke-linecap': 'round' }));
			svg.appendChild(svgEl('rect', { x: 74, y: 56, width: 46, height: 30, rx: 10, fill: '#ffffff', stroke: 'rgba(167,139,250,0.5)', 'stroke-width': '1.5', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('path', { d: 'M97 66 C95 62 90 64 92 68 C94 72 97 75 97 75 C97 75 100 72 102 68 C104 64 99 62 97 66 Z', fill: '#f43f5e' }));
		} else if (pageKey === 'sms_settings') {
			// 短信设置：萌信封与齿轮星标
			svg.appendChild(svgEl('rect', { x: 48, y: 44, width: 64, height: 42, rx: 8, fill: 'url(#mt-g-glass)', stroke: '#8b5cf6', 'stroke-width': '2' }));
			svg.appendChild(svgEl('path', { d: 'M48 48L80 70L112 48', stroke: '#8b5cf6', 'stroke-width': '2.2', fill: 'none' }));
			svg.appendChild(svgEl('circle', { cx: 108, cy: 44, r: 12, fill: 'url(#mt-g-pink)', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('circle', { cx: 108, cy: 44, r: 5, fill: '#ffffff' }));
		} else if (pageKey === 'terminal') {
			// 终端：二次元毛玻璃赛博控制台
			svg.appendChild(svgEl('rect', { x: 40, y: 34, width: 80, height: 52, rx: 9, fill: '#1e1b4b', stroke: 'rgba(167,139,250,0.4)', 'stroke-width': '1.5' }));
			svg.appendChild(svgEl('circle', { cx: 48, cy: 42, r: 2.5, fill: '#f43f5e' }));
			svg.appendChild(svgEl('circle', { cx: 56, cy: 42, r: 2.5, fill: '#fbbf24' }));
			svg.appendChild(svgEl('circle', { cx: 64, cy: 42, r: 2.5, fill: '#34d399' }));
			var p = svgEl('text', { x: 48, y: 60, fill: '#38bdf8', 'font-size': '8.5', 'font-family': 'monospace', 'font-weight': 'bold' });
			p.textContent = '> AT+CSQ';
			svg.appendChild(p);
			svg.appendChild(svgEl('rect', { x: 90, y: 53, width: 5, height: 9, fill: '#a78bfa', 'class': 'mt-anim-pulse' }));
		} else if (pageKey === 'logs') {
			// 日志：心跳星波图
			svg.appendChild(svgEl('rect', { x: 38, y: 36, width: 84, height: 48, rx: 8, fill: '#1e1b4b', stroke: 'rgba(167,139,250,0.3)', 'stroke-width': '1.5' }));
			svg.appendChild(svgEl('path', {
				d: 'M44 60H56L62 48L68 72L74 54L80 64L86 60H116',
				stroke: '#34d399', 'stroke-width': '2.2', fill: 'none',
				'stroke-linecap': 'round', 'stroke-linejoin': 'round',
				'class': 'mt-anim-stream'
			}));
			svg.appendChild(svgEl('circle', { cx: 114, cy: 60, r: 3.5, fill: '#ec4899', 'class': 'mt-anim-pulse' }));
		} else if (pageKey === 'service') {
			// 后台服务：机柜与旋转护盾光环
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 38, stroke: '#8b5cf6', 'stroke-width': '1.5', 'stroke-dasharray': '6 4', 'class': 'mt-anim-spin' }));
			svg.appendChild(svgEl('rect', { x: 56, y: 34, width: 48, height: 52, rx: 8, fill: 'url(#mt-g-accent)', stroke: '#ffffff', 'stroke-width': '1.5' }));
			svg.appendChild(svgEl('rect', { x: 62, y: 40, width: 36, height: 10, rx: 3, fill: 'rgba(255,255,255,0.88)' }));
			svg.appendChild(svgEl('rect', { x: 62, y: 55, width: 36, height: 10, rx: 3, fill: 'rgba(255,255,255,0.88)' }));
			svg.appendChild(svgEl('rect', { x: 62, y: 70, width: 36, height: 10, rx: 3, fill: 'rgba(255,255,255,0.88)' }));
			svg.appendChild(svgEl('circle', { cx: 90, cy: 45, r: 2.2, fill: '#34d399', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('circle', { cx: 90, cy: 60, r: 2.2, fill: '#34d399', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('circle', { cx: 90, cy: 75, r: 2.2, fill: '#34d399', 'class': 'mt-anim-pulse' }));
		} else {
			// 默认互联水晶节点
			svg.appendChild(svgEl('circle', { cx: 80, cy: 60, r: 16, fill: 'url(#mt-g-accent)', 'class': 'mt-anim-pulse' }));
			svg.appendChild(svgEl('circle', { cx: 48, cy: 42, r: 9, fill: 'url(#mt-g-cyan)', 'class': 'mt-anim-float' }));
			svg.appendChild(svgEl('circle', { cx: 112, cy: 78, r: 11, fill: 'url(#mt-g-pink)', 'class': 'mt-anim-float' }));
			svg.appendChild(svgEl('line', { x1: 48, y1: 42, x2: 80, y2: 60, stroke: '#a78bfa', 'stroke-width': '1.8' }));
			svg.appendChild(svgEl('line', { x1: 80, y1: 60, x2: 112, y2: 78, stroke: '#a78bfa', 'stroke-width': '1.8' }));
		}

		return svg;
	};

		/* ================= 调制方式星座图与 MIMO 空间流 SVG ================= */

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

api.mascotSvg = function () {
		var svg = svgEl('svg', {
			'class': 'mt-anime-mascot-svg',
			viewBox: '0 0 200 160',
			width: '100%',
			height: '100%',
			fill: 'none',
			xmlns: 'http://www.w3.org/2000/svg'
		});

		var defs = svgEl('defs');
		var gHair = svgEl('linearGradient', { id: 'm-hair-grad', x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
		gHair.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#f8f9ff' }));
		gHair.appendChild(svgEl('stop', { offset: '50%', 'stop-color': '#e0e7ff' }));
		gHair.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#c7d2fe' }));
		defs.appendChild(gHair);

		var gEar = svgEl('linearGradient', { id: 'm-ear-inner', x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
		gEar.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#fbcfe8' }));
		gEar.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#f472b6' }));
		defs.appendChild(gEar);

		var gEye = svgEl('linearGradient', { id: 'm-eye-grad', x1: '0%', y1: '0%', x2: '0%', y2: '100%' });
		gEye.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#4f46e5' }));
		gEye.appendChild(svgEl('stop', { offset: '60%', 'stop-color': '#6366f1' }));
		gEye.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#38bdf8' }));
		defs.appendChild(gEye);

		svg.appendChild(defs);

		var g = svgEl('g', { style: 'transform-origin: 100px 140px;' });
		// Ears
		g.appendChild(svgEl('path', { d: 'M 62 48 Q 45 10 75 16 Z', fill: 'url(#m-hair-grad)', stroke: '#a5b4fc', 'stroke-width': '1.5' }));
		g.appendChild(svgEl('path', { d: 'M 64 42 Q 52 18 72 23 Z', fill: 'url(#m-ear-inner)', opacity: '0.85' }));
		g.appendChild(svgEl('path', { d: 'M 138 48 Q 155 10 125 16 Z', fill: 'url(#m-hair-grad)', stroke: '#a5b4fc', 'stroke-width': '1.5' }));
		g.appendChild(svgEl('path', { d: 'M 136 42 Q 148 18 128 23 Z', fill: 'url(#m-ear-inner)', opacity: '0.85' }));

		// Back Hair
		g.appendChild(svgEl('path', { d: 'M 52 65 C 40 95 48 135 58 145 C 65 130 68 110 70 85 Z', fill: '#c7d2fe' }));
		g.appendChild(svgEl('path', { d: 'M 148 65 C 160 95 152 135 142 145 C 135 130 132 110 130 85 Z', fill: '#c7d2fe' }));

		// Clothes
		g.appendChild(svgEl('path', { d: 'M 68 120 C 60 135 50 152 46 160 L 154 160 C 150 152 140 135 132 120 Z', fill: '#ffffff', stroke: '#c7d2fe', 'stroke-width': '1.5' }));
		g.appendChild(svgEl('path', { d: 'M 85 125 L 100 136 L 115 125 L 100 120 Z', fill: '#e0e7ff', stroke: '#a5b4fc', 'stroke-width': '1' }));
		g.appendChild(svgEl('circle', { cx: '100', cy: '136', r: '3', fill: '#fbbf24' }));

		// Face
		g.appendChild(svgEl('path', { d: 'M 68 62 C 68 95 82 112 100 112 C 118 112 132 95 132 62 C 132 40 118 36 100 36 C 82 36 68 40 68 62 Z', fill: '#fffdfa' }));
		// Blushes
		g.appendChild(svgEl('ellipse', { cx: '80', cy: '85', rx: '7', ry: '4', fill: '#f472b6', opacity: '0.4' }));
		g.appendChild(svgEl('ellipse', { cx: '120', cy: '85', rx: '7', ry: '4', fill: '#f472b6', opacity: '0.4' }));

		// Eyes
		g.appendChild(svgEl('path', { d: 'M 77 68 C 81 65 89 65 92 68', stroke: '#312e81', 'stroke-width': '2.6', 'stroke-linecap': 'round' }));
		g.appendChild(svgEl('ellipse', { cx: '85', cy: '74', rx: '5.5', ry: '7', fill: 'url(#m-eye-grad)' }));
		g.appendChild(svgEl('circle', { cx: '83.5', cy: '71.5', r: '2.2', fill: '#ffffff' }));
		g.appendChild(svgEl('circle', { cx: '87.5', cy: '77', r: '1.2', fill: '#a5f3fc' }));

		g.appendChild(svgEl('path', { d: 'M 123 68 C 119 65 111 65 108 68', stroke: '#312e81', 'stroke-width': '2.6', 'stroke-linecap': 'round' }));
		g.appendChild(svgEl('ellipse', { cx: '115', cy: '74', rx: '5.5', ry: '7', fill: 'url(#m-eye-grad)' }));
		g.appendChild(svgEl('circle', { cx: '113.5', cy: '71.5', r: '2.2', fill: '#ffffff' }));
		g.appendChild(svgEl('circle', { cx: '117.5', cy: '77', r: '1.2', fill: '#a5f3fc' }));

		// Smile
		g.appendChild(svgEl('path', { d: 'M 96 92 Q 100 95 104 92', stroke: '#4338ca', 'stroke-width': '1.5', 'stroke-linecap': 'round', fill: 'none' }));
		g.appendChild(svgEl('path', { d: 'M 98 93 Q 100 96 102 93', fill: '#f43f5e', opacity: '0.6' }));

		// Bangs
		g.appendChild(svgEl('path', { d: 'M 68 56 C 65 72 68 88 74 92 C 75 84 76 72 78 58 Z', fill: 'url(#m-hair-grad)' }));
		g.appendChild(svgEl('path', { d: 'M 76 45 C 80 58 84 66 87 68 C 88 60 90 52 92 45 Z', fill: 'url(#m-hair-grad)' }));
		g.appendChild(svgEl('path', { d: 'M 90 45 C 93 58 97 68 100 70 C 103 68 107 58 110 45 Z', fill: 'url(#m-hair-grad)' }));
		g.appendChild(svgEl('path', { d: 'M 108 45 C 110 52 112 60 113 68 C 116 66 120 58 124 45 Z', fill: 'url(#m-hair-grad)' }));
		g.appendChild(svgEl('path', { d: 'M 132 56 C 135 72 132 88 126 92 C 125 84 124 72 122 58 Z', fill: 'url(#m-hair-grad)' }));

		// Ahoge
		g.appendChild(svgEl('path', { d: 'M 100 28 Q 108 14 114 18 Q 112 24 102 28 Z', fill: 'url(#m-hair-grad)', stroke: '#a5b4fc', 'stroke-width': '1' }));

		svg.appendChild(g);
		return svg;
	};

	api.mascot = function (defaultText, pageKey) {
		var wrap = E('div', { 'class': 'mt-mascot-speech-wrap' });

		// 优化看板娘文案：亲切称呼用户为「可可」
		var voiceMap = {
			network_status: [
				'可可，5G 信号满格，冲浪快如闪电喵！⚡',
				'无线链路超健康，随时为可可服务喵~ 🐾',
				'网络已连接~ 正在全力守护可可的信号喵~ ♡',
				'可可辛苦啦~ 今天我也在认真巡检网络呢！♡',
				'喵呜~ 可可，有我在，网络绝对不掉线喵！✨'
			],
			network_settings: [
				'可可，锁定高速 5G 频段，告别拥堵喵！✨',
				'SA / NSA 模式已就绪，听从可可的指令喵~ 🛰️',
				'射频通道状态极佳，正在帮可可锁定最佳基站喵！📶',
				'可可放心，频段锁定策略随时为您待命喵~ ♡'
			],
			dial: [
				'可可，APN 高速通道已就绪，一键起飞喵！🚀',
				'双栈 IPv4/IPv6 隧道全速畅通，可可冲浪超丝滑喵~ 🌐',
				'守护进程全天候待命，为可可保驾护航喵！🐾',
				'数据链路稳如磐石，可可尽管畅享高速喵~ ♡'
			],
			scan: [
				'雷达全向扫描启动！周边基站正在向可可汇报喵~ 📡',
				'正在为可可探索更优质的载波与小区喵！✨',
				'扫频完成啦，可可想锁定哪个小区呢喵？🐾'
			],
			schedule: [
				'智能定时调度已排班，准时为可可执行喵~ ⏰',
				'夜间闲时智能倒换，帮可可省心又省电喵！💤',
				'定时优化模组状态，让可可的网速永远飞起喵~ ♡'
			],
			modem_settings: [
				'MT5700 核心 SoC 运转正常，温度刚刚好，可可请放心喵~ 💻',
				'PCI 物理小区锁定已生效，为可可开启最强抗干扰喵！🛡️',
				'硬件状态优异，全心全意服务可可喵~ 🐾'
			],
			upgrade: [
				'固件升级防护盾已开启，守护可可的设备安全喵！☁️',
				'完整性校验中，可可请放心升级喵~ ⚡',
				'保持最新版本，让可可体验最强 5G 性能喵！♡'
			],
			sms_center: [
				'信箱整理得井井有条，新短信第一时间汇报给可可喵！💌',
				'支持长短信无损合并，可可的消息一条都不漏喵~ 💬',
				'重要验证码我帮可可盯得紧紧的喵！🐾'
			],
			sms_settings: [
				'短信自动化转发与 Webhook 已为可可配置妥当喵！📮',
				'钉钉/飞书/Telegram 实时推送，绝不让可可漏信喵~ 🔔',
				'存储空间充足，随收随转，可可超省心喵~ ♡'
			],
			terminal: [
				'AT 交互控制台就绪，请可可下发调试指令喵！💻',
				'底层指令审计中，保证可可的操作安全无虞喵~ ✨',
				'回车即发，高阶命令我随时陪可可测试喵！🐾'
			],
			logs: [
				'事件日志流实时追踪，异常波动立刻汇报给可可喵~ 📜',
				'全天候日志审计，透明可视，可可一目了然喵！🔍',
				'运行健康度优异，一切尽在可可掌握中喵~ ♡'
			],
			service: [
				'后台守护进程全天候巡检中，随时响应可可喵！🛡️',
				'服务健康度 100%，内存超轻量，可可放心喵~ ⚡',
				'模组通信守护就绪，陪伴可可每一秒喵！♡'
			]
		};

		var voices = voiceMap[pageKey] || [
			'可可，5G 信号满格，冲浪快如闪电喵！⚡',
			'可可辛苦啦~ 今天我也在认真巡检网络呢！♡',
			'网络已连接~ 正在全力守护可可的信号喵~ ♡',
			'喵呜~ 可可，有我在，网络绝对不掉线喵！✨'
		];

		var initText = defaultText || voices[0];
		var bubble = E('div', { 'class': 'mt-speech-bubble' }, initText);

		// 采用用户指定的二次元蓝发猫耳看板娘头像图片，外圈带光环与悬浮动效
		var avatar = E('div', { 'class': 'mt-mascot-avatar' });
		var img = E('img', {
			'class': 'mt-mascot-img',
			'src': '/luci-static/resources/at-webserver/mascot.png?v=' + MT5700_CSS_VERSION,
			'alt': '可可的看板娘'
		});
		avatar.appendChild(img);

		var idx = 0;
		function nextVoice() {
			idx = (idx + 1) % voices.length;
			bubble.textContent = voices[idx];
		}
		bubble.addEventListener('click', nextVoice);
		avatar.addEventListener('click', nextVoice);

		wrap.appendChild(bubble);
		wrap.appendChild(avatar);

		return {
			el: wrap,
			bubble: bubble,
			setBubble: function (t) { if (t) bubble.textContent = t; }
		};
	};

	api.themeToggle = function () {
		var btn = E('div', { 'class': 'mt-theme-toggle' });
		var icon = E('span', {}, '🌓');
		var txt = E('span', {}, '主题切换');
		btn.appendChild(icon);
		btn.appendChild(txt);

		function updateBtnState() {
			var isDark = document.body.classList.contains('mt-theme-dark') || 
			            (document.documentElement.getAttribute('data-theme') === 'dark') ||
			            (!document.body.classList.contains('mt-theme-light') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
			if (isDark) {
				icon.textContent = '🌙';
				txt.textContent = '暗色模式';
			} else {
				icon.textContent = '☀️';
				txt.textContent = '浅色模式';
			}
		}

		// Init from saved pref
		try {
			var saved = localStorage.getItem('mt5700_theme');
			if (saved === 'dark') {
				document.body.classList.add('mt-theme-dark');
				document.body.classList.remove('mt-theme-light');
			} else if (saved === 'light') {
				document.body.classList.add('mt-theme-light');
				document.body.classList.remove('mt-theme-dark');
			}
		} catch (e) {}
		updateBtnState();

		btn.addEventListener('click', function () {
			var isDark = document.body.classList.contains('mt-theme-dark');
			if (isDark) {
				document.body.classList.remove('mt-theme-dark');
				document.body.classList.add('mt-theme-light');
				try { localStorage.setItem('mt5700_theme', 'light'); } catch (e) {}
			} else {
				document.body.classList.add('mt-theme-dark');
				document.body.classList.remove('mt-theme-light');
				try { localStorage.setItem('mt5700_theme', 'dark'); } catch (e) {}
			}
			updateBtnState();
		});

		return btn;
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
		var toggle = api.themeToggle();
		art.appendChild(toggle);

		// 专属动态矢量插画 (160x120 viewBox)
		var illuWrap = E('div', { 'class': 'mt5700-hero-illu-box' }, [api.heroIllustration(pageKey)]);
		art.appendChild(illuWrap);

		var mascot = api.mascot(null, pageKey);
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

	api.skeleton = function () {
		var wrap = E('div', { 'class': 'mt-skeleton-wrap' });
		for (var i = 0; i < 2; i++) {
			var card = E('div', { 'class': 'mt-skeleton-card' });
			card.appendChild(E('div', { 'class': 'mt-skeleton-line mt-skeleton-line-title' }));
			card.appendChild(E('div', { 'class': 'mt-skeleton-line mt-skeleton-line-full' }));
			card.appendChild(E('div', { 'class': 'mt-skeleton-line mt-skeleton-line-3q' }));
			card.appendChild(E('div', { 'class': 'mt-skeleton-line mt-skeleton-line-half' }));
			wrap.appendChild(card);
		}
		return wrap;
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

	/* 兼容字段：warm 阈值 61℃、high 阈值 77℃，供外部按单值判断时复用 */
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
	 * 返回 { el, set(value) }；sub / plain 为构造期静态选项，创建后不可改。
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
	 *   第二层 能力档（同样取最差项）：对「制式代际」「频段传播特性」「载波带宽」
	 *          三项中最差者。这一层回答的是「这条链路最快能跑多少」。
	 *
	 * 最终结论 = 两层取更差者。理由：信号好只说明「链路质量好」，不等于「网速快」。
	 * 例如 700MHz(n28) 上的 LTE 信号满格，RSRP -70 属"优秀"，但 20MHz 带宽 + 4G 制式
	 * 决定了它的峰值吞吐远不如 2.6GHz(n41) 的 5G 100MHz。若只看信号档就下
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
	 * 状态图标：外圈淡描边 + 内实心圆（实心圆带脉冲动画）。
	 * 结构与既有状态 SVG 一致：
	 *   <circle cx=12 cy=12 r=8 fill=none stroke=currentColor opacity=.16/>
	 *   <circle class=tower cx=12 cy=12 r=4.5 fill=currentColor/>
	 */
	function statusIcon() {
		var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
		svg.appendChild(svgEl('circle', {
			'class': 'mt5700-status-halo',
			cx: 12, cy: 12, r: 8, fill: 'none', stroke: 'currentColor', opacity: '0.16'
		}));
		svg.appendChild(svgEl('circle', {
			'class': 'mt5700-verdict-tower',
			cx: 12, cy: 12, r: 4.5, fill: 'currentColor'
		}));
		return svg;
	}

	/*
	 * 四项信号指标的图标，沿用统一的绘制约定：
	 *   svg 级：fill:none + stroke:var(--accent) + stroke-width:1.8 + linecap/linejoin:round
	 *   个别元素自带 fill:currentColor（雷达内点）或 fill:none（描边路径）覆盖
	 *   rsrp → 4 根闭合柱（闭合路径由 stroke 描出轮廓，实机呈现为实心格）
	 *   rsrq → 虚线波形   sinr → 雷达同心环 + 内点 + 扫描线   pct → 圆圈对勾
	 */
	var SIGNAL_ICONS = {
		rsrp: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true', 'class': 'mt5700-signal' });
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
			svg.appendChild(svgEl('path', {
				'class': 'mt5700-wave-path',
				d: 'M3 13c3-7 5 7 9 0s6 7 9 0', fill: 'none'
			}));
			return svg;
		},
		sinr: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			svg.appendChild(svgEl('circle', { 'class': 'mt5700-radar-ring', cx: 12, cy: 12, r: 7 }));
			svg.appendChild(svgEl('circle', { 'class': 'mt5700-radar-ring mt5700-radar-ring-r2', cx: 12, cy: 12, r: 4 }));
			svg.appendChild(svgEl('circle', { 'class': 'mt5700-dot', cx: 12, cy: 12, r: 2, fill: 'currentColor' }));
			svg.appendChild(svgEl('path', { 'class': 'mt5700-sweep', d: 'M12 12l6-6' }));
			return svg;
		},
		pct: function () {
			var svg = svgEl('svg', { viewBox: '0 0 24 24', role: 'img', 'aria-hidden': 'true' });
			svg.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 8 }));
			svg.appendChild(svgEl('path', { 'class': 'mt5700-check', d: 'm8 12 3 3 5-6' }));
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
	 * exc 4 格 / good 3 格 / fair 2 格 / poor 与 bad 均为 1 格（共 4 种取值）。
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
					 * （静态稿用 data-bars 控制，这里由 JS 侧直接决定）。
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
	// 连接状态卡片已按需求从所有页面移除：保留空实现兜底，任何调用不再渲染任何内容
	api.renderConnectionBar = function () {
		return E('div', { 'style': 'display:none' });
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
	 * 实时速率折线图
	 * - 双折线（下行/上行）+ 下行面积渐变填充
	 * - 悬浮提示（tooltip，L4 浮层），数据格式通过 options.tipFormat(point, index) 定制
	 * - 数据格式 [{down, up}, ...]，缺省 width/height/max 时分别取 600/160/1
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
