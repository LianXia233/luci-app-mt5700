/* use strict */
/* require baseclass */
/* require at-webserver/compat */
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* global L, AtWs, Parse, baseclass */

/**
 * MT5700 LuCI 前端 - 新 UI 组件系统
 * 玻璃拟态 + 卡片式 + 数据可视化
 */

// 注入新样式
var MT5700_CSS_VERSION = '1.0.0';
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
		if (text != null) el.textContent = String(text);
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

	api.metric = function (label, value, color) {
		var m = E('div', { 'class': 'mt5700-metric' });
		m.appendChild(E('div', { 'class': 'mt5700-metric-label' }, label));
		var v = E('div', { 'class': 'mt5700-metric-value' }, value || '—');
		if (color) v.classList.add(color);
		m.appendChild(v);
		return m;
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

	/* ================= 连接状态条 ================= */

	api.renderConnectionBar = function (container) {
		var bar = E('div', { 'class': 'mt5700-conn-bar mt5700-conn-disconnected' });
		var dot = E('span', { 'class': 'mt5700-conn-dot' });
		var text = E('span', { 'class': 'mt5700-conn-text' }, '正在连接 AT 服务…');
		bar.appendChild(dot);
		bar.appendChild(text);
		container.appendChild(bar);

		var cl = AtWs.client;
		function labelConnected() {
			var port = cl.port || 8765;
			var host = cl.bind || cl.host || '127.0.0.1';
			var where = (host === '127.0.0.1' || host === 'localhost') ? '本机 RPC' : 'RPC ' + host;
			return 'AT 服务已连接 · ' + where + ' :' + port;
		}
		cl.onConnectionStateChange(function (state, err) {
			bar.className = 'mt5700-conn-bar mt5700-conn-' + state;
			if (state === 'connected') {
				text.textContent = labelConnected();
			} else if (state === 'error') {
				text.textContent = err || '连接失败';
			} else {
				var texts = {
					connecting: '正在连接 AT 服务…',
					authenticating: '正在验证访问密钥…',
					reconnecting: '连接中断，正在重连…',
					disconnected: '未连接 AT 服务',
					idle: '正在连接 AT 服务…'
				};
				text.textContent = texts[state] || state;
			}
		});
		return bar;
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

	// 折线图
	api.lineChart = function (data, options) {
		options = options || {};
		var w = options.width || 600;
		var h = options.height || 160;
		var max = options.max || 1;
		var downColor = options.downColor || '#3b82f6';
		var upColor = options.upColor || '#10b981';

		var svg = svgEl('svg', { width: w, height: h });

		if (!data || !data.length) {
			return svg;
		}

		// 找最大值
		var actualMax = max;
		if (actualMax <= 1) {
			data.forEach(function (p) {
				actualMax = Math.max(actualMax, p.down || 0, p.up || 0);
			});
		}

		// 绘制网格线
		var gridCount = 4;
		for (var i = 0; i <= gridCount; i++) {
			var y = 10 + (h - 30) * i / gridCount;
			svg.appendChild(svgEl('line', {
				x1: 2, y1: y, x2: w - 2, y2: y,
				stroke: 'rgba(0, 0, 0, 0.05)',
				'stroke-width': 1
			}));
		}

		// 绘制折线
		var points = [];
		var n = data.length;
		for (var j = 0; j < n; j++) {
			var x = (j / Math.max(1, n - 1)) * (w - 4) + 2;
			var y = h - 15 - ((data[j].down || 0) / actualMax) * (h - 30);
			points.push(x.toFixed(1) + ',' + y.toFixed(1));
		}
		if (points.length > 1) {
			svg.appendChild(svgEl('polyline', {
				fill: 'none',
				stroke: downColor,
				'stroke-width': 2,
				points: points.join(' ')
			}));
		}

		// 上行折线
		var upPoints = [];
		for (var k = 0; k < n; k++) {
			var x2 = (k / Math.max(1, n - 1)) * (w - 4) + 2;
			var y2 = h - 15 - ((data[k].up || 0) / actualMax) * (h - 30);
			upPoints.push(x2.toFixed(1) + ',' + y2.toFixed(1));
		}
		if (upPoints.length > 1) {
			svg.appendChild(svgEl('polyline', {
				fill: 'none',
				stroke: upColor,
				'stroke-width': 2,
				points: upPoints.join(' ')
			}));
		}

		return svg;
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

	/* ================= 速率显示 ================= */

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
