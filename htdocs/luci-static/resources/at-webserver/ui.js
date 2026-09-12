'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/rpc';
'require at-webserver/parse';
/* global L, AtWs, Parse, baseclass */

/**
 * LuCI 页面公共 UI 辅助：连接状态条、面板、字段、提示、加载态。
 * 保持与原 WebUI（Semi Design）一致的交互语义：加载态、错误提示、确认弹窗、自动刷新。
 */

// 注入公共样式（at.css 与 ui.js 同目录）。
// uhttpd 给静态资源的 Last-Modified 为 1970，浏览器会长期复用缓存；LuCI 主题同样
// 采用「css?v=版本」的做法（aurora: main.css?v=1.3.1）。样式版本随包版本递增，
// 保证升级/修复样式后用户刷新即可生效。
var AT_CSS_VERSION = '1.5.0';

(function () {
	var cssPath = '/luci-static/resources/at-webserver/at.css?v=' + AT_CSS_VERSION;
	var links = document.querySelectorAll('link[rel="stylesheet"]');
	for (var i = 0; i < links.length; i++) {
		if (links[i].getAttribute('href') === cssPath) return;
	}
	var link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = cssPath;
	document.head.appendChild(link);
})();

var Ui = (function () {
	var api = {};

	api.panel = function (title, hint, extra) {
		// 容器使用本项目自有的 at-panel 类：外观完全由 at.css 控制，与任意 LuCI 主题解耦。
		var cbi = E('div', { 'class': 'at-panel' });
		var head = E('div', { 'class': 'at-panel-head' });
		var h = E('h3', { 'class': 'at-panel-title' }, title || '');
		head.appendChild(h);
		if (hint) head.appendChild(E('div', { 'class': 'at-panel-hint' }, hint));
		if (extra) {
			var ex = E('div', { 'class': 'at-panel-extra' });
			ex.appendChild(extra);
			head.appendChild(ex);
		}
		cbi.appendChild(head);
		var body = E('div', { 'class': 'at-panel-body' });
		cbi.appendChild(body);
		cbi._body = body;
		return cbi;
	};

	api.field = function (label, control, hint) {
		var row = E('div', { 'class': 'at-field' });
		var lb = E('div', { 'class': 'at-field-label' }, label || '');
		row.appendChild(lb);
		var ctrl = E('div', { 'class': 'at-field-control' });
		ctrl.appendChild(control);
		if (hint) ctrl.appendChild(E('div', { 'class': 'at-field-hint' }, hint));
		row.appendChild(ctrl);
		return row;
	};

	api.kv = function (items) {
		var table = E('table', { 'class': 'at-kv' });
		for (var i = 0; i < items.length; i++) {
			var tr = E('tr');
			tr.appendChild(E('td', { 'class': 'at-kv-label' }, items[i].label));
			var td = E('td', { 'class': 'at-kv-value' });
			if (typeof items[i].value === 'string' || typeof items[i].value === 'number') {
				td.textContent = String(items[i].value);
			} else if (items[i].value != null) {
				td.appendChild(items[i].value);
			} else {
				td.textContent = '—';
			}
			tr.appendChild(td);
			table.appendChild(tr);
		}
		return table;
	};

	api.tag = function (text, color) {
		var colors = {
			green: '#1b6b2f', blue: '#1a5eab', orange: '#b36b00', red: '#b3261e',
			grey: '#5f6368', violet: '#6a3fb5'
		};
		var tag = E('span', {
			'class': 'at-tag',
			style: 'background:' + (colors[color] || colors.grey) + '1a;color:' + (colors[color] || colors.grey) +
				';border:1px solid ' + (colors[color] || colors.grey) + '40;'
		}, text);
		return tag;
	};

	// 所有按钮都经由此卡口创建。cls 接收视图传入的 cbi-button-* 变体，
	// 通过映射附加 at-btn-* 系列类：外观完全由 at.css 决定，不受 LuCI 主题影响。
	api.button = function (label, cls, onClick) {
		var map = {
			'cbi-button-positive': 'at-btn-primary',
			'cbi-button-negative': 'at-btn-danger',
			'cbi-button-neutral': 'at-btn-neutral',
			'cbi-button-action': 'at-btn-action'
		};
		var extra = (cls || '').split(/\s+/).map(function (c) { return map[c] || ''; }).join(' ');
		var btn = E('button', { 'class': 'at-btn ' + extra + ' ' + (cls || '') }, label);
		btn.addEventListener('click', onClick);
		return btn;
	};

	api.primaryButton = function (label, onClick) {
		return api.button(label, 'cbi-button-positive', onClick);
	};

	api.dangerButton = function (label, onClick) {
		return api.button(label, 'cbi-button-negative', onClick);
	};

	api.toast = function (message, type) {
		var t = E('div', { 'class': 'at-toast at-toast-' + (type || 'info') }, message);
		document.body.appendChild(t);
		window.setTimeout(function () { t.classList.add('at-toast-hide'); }, 3200);
		window.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3600);
	};

	api.success = function (m) { api.toast(m, 'success'); };
	api.error = function (m) { api.toast(m, 'error'); };
	api.warning = function (m) { api.toast(m, 'warning'); };
	api.info = function (m) { api.toast(m, 'info'); };

	api.confirm = function (message, onOk, okText) {
		var mask = E('div', { 'class': 'at-modal-mask' });
		var box = E('div', { 'class': 'at-modal' });
		var text = E('div', { 'class': 'at-modal-text' }, message);
		var actions = E('div', { 'class': 'at-modal-actions' });
		var cancel = api.button('取消', 'cbi-button-neutral', function () {
			if (mask.parentNode) mask.parentNode.removeChild(mask);
		});
		var ok = api.button(okText || '确定', 'cbi-button-positive', function () {
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

	api.promptModal = function (title, fields, onOk) {
		var mask = E('div', { 'class': 'at-modal-mask' });
		var box = E('div', { 'class': 'at-modal at-modal-wide' });
		var h = E('h4', { 'class': 'at-modal-title' }, title);
		var body = E('div', { 'class': 'at-modal-body' });
		var inputs = {};
		for (var i = 0; i < fields.length; i++) {
			var f = fields[i];
			var row = E('div', { 'class': 'at-field' });
			row.appendChild(E('div', { 'class': 'at-field-label' }, f.label));
			var ctrl = E('div', { 'class': 'at-field-control' });
			var input;
			if (f.type === 'select') {
				input = document.createElement('select');
				input.className = 'cbi-input-select';
				for (var j = 0; j < f.options.length; j++) {
					var opt = document.createElement('option');
					opt.value = String(f.options[j].value);
					opt.textContent = f.options[j].label;
					if (String(f.options[j].value) === String(f.value)) opt.selected = true;
					input.appendChild(opt);
				}
			} else {
				input = document.createElement('input');
				input.type = f.type === 'password' ? 'password' : 'text';
				input.className = 'cbi-input-text';
				if (f.value != null) input.value = String(f.value);
				if (f.placeholder) input.placeholder = f.placeholder;
			}
			ctrl.appendChild(input);
			if (f.hint) ctrl.appendChild(E('div', { 'class': 'at-field-hint' }, f.hint));
			row.appendChild(ctrl);
			body.appendChild(row);
			inputs[f.key] = input;
		}
		var actions = E('div', { 'class': 'at-modal-actions' });
		var cancel = api.button('取消', 'cbi-button-neutral', function () {
			if (mask.parentNode) mask.parentNode.removeChild(mask);
		});
		var ok = api.button('确定', 'cbi-button-positive', function () {
			var values = {};
			for (var key in inputs) values[key] = inputs[key].value;
			if (mask.parentNode) mask.parentNode.removeChild(mask);
			if (onOk) onOk(values);
		});
		actions.appendChild(cancel);
		actions.appendChild(ok);
		box.appendChild(h);
		box.appendChild(body);
		box.appendChild(actions);
		mask.appendChild(box);
		mask.addEventListener('click', function (e) {
			if (e.target === mask && mask.parentNode) mask.parentNode.removeChild(mask);
		});
		document.body.appendChild(mask);
		return mask;
	};

	/* ---------- 连接状态条 ---------- */

	api.renderConnectionBar = function (container) {
		var bar = E('div', { 'class': 'at-conn-bar at-conn-idle' });
		function setText(state, text) {
			bar.className = 'at-conn-bar at-conn-' + state;
			bar.innerHTML = '';
			var dot = E('span', { 'class': 'at-conn-dot' });
			bar.appendChild(dot);
			bar.appendChild(E('span', { 'class': 'at-conn-text' }, text));
			return bar;
		}
		setText('idle', '正在连接 AT 服务…');
		container.appendChild(bar);

		var cl = AtWs.client;
		function labelConnected() {
			var port = cl.port || 8765;
			var host = cl.bind || cl.host || '127.0.0.1';
			var where;
			if (host === '127.0.0.1' || host === 'localhost') {
				where = '本机 RPC';
			} else if (host === '0.0.0.0' || host === '::') {
				where = 'RPC 所有接口';
			} else {
				where = 'RPC ' + host;
			}
			return 'AT 服务已连接 · ' + where + ' :' + port;
		}
		cl.onConnectionStateChange(function (state, err) {
			if (state === 'connected') {
				setText('connected', labelConnected());
				return;
			}
			if (state === 'error') {
				bar.className = 'at-conn-bar at-conn-error';
				bar.innerHTML = '';
				bar.appendChild(E('span', { 'class': 'at-conn-dot' }));
				bar.appendChild(E('span', { 'class': 'at-conn-text' }, err || '连接失败'));
				var retry = api.button('重试', 'cbi-button-action', function () {
					cl.connect().catch(function () {});
				});
				retry.style.marginLeft = '10px';
				bar.appendChild(retry);
				return;
			}
			var texts = {
				connecting: '正在连接 AT 服务…',
				authenticating: '正在验证访问密钥…',
				reconnecting: '连接中断，正在重连…',
				disconnected: '未连接 AT 服务',
				idle: '正在连接 AT 服务…'
			};
			setText(state, texts[state] || state);
		});
		return bar;
	};

	/* ---------- 常用 AT 辅助（等价 modem/atx.ts） ---------- */

	api.sleep = function (ms) {
		return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
	};

	// 原前端发命令前固定等 100ms，保证命令间隔
	api.sendCmd = function (command) {
		return api.sleep(100).then(function () { return AtWs.client.sendCommand(command); });
	};

	// 错误文本还原（等价 atx.ts 的 atErrorText）
	api.atErrorText = function (res, fallback) {
		if (!res || res.success) return fallback;
		var msg = res.error || fallback;
		if (typeof msg === 'string' && msg.indexOf('CME ERROR') >= 0) {
			var code = msg.match(/CME ERROR:\s*(\d+)/);
			if (code) {
				var map = {
					'1': '未指定的错误', '3': '操作不允许', '4': '操作不支持', '10': '模组忙',
					'11': 'PIN 未输入或错误', '13': 'SIM 故障', '14': 'SIM 已满', '21': '无效字符',
					'22': '无效索引', '100': '未知错误', '513': 'SIM 锁定', '515': 'SIM 错误',
					'516': '内存满', '517': '无效内存索引', '518': '内存错误'
				};
				return map[code[1]] || msg;
			}
		}
		return msg;
	};

	// 飞行模式：CFUN=0 开启（关射频），CFUN=1 关闭。返回是否成功。
	api.setFlightMode = function (on) {
		return api.sendCmd('AT+CFUN=' + (on ? '0' : '1')).then(function (res) { return !!res.success; });
	};

	api.deriveNetworkMode = function (mode) {
		if (!mode) return '';
		if (mode.indexOf('NR') === 0) return 'NR';
		if (mode.indexOf('LTE') === 0) return 'LTE';
		if (mode.indexOf('WCDMA') === 0) return 'WCDMA';
		return mode;
	};

	/* ---------- 通用渲染 ---------- */

	// 页面容器标准结构
	api.page = function (title, subtitle) {
		var node = E('div', { 'class': 'at-page' });
		var h = E('div', { 'class': 'at-page-head' });
		h.appendChild(E('h2', { 'class': 'at-page-title' }, title || ''));
		if (subtitle) h.appendChild(E('div', { 'class': 'at-page-subtitle' }, subtitle));
		node.appendChild(h);
		var body = E('div', { 'class': 'at-page-body' });
		node.appendChild(body);
		node._body = body;
		return node;
	};

	api.spinner = function (text) {
		var el = E('div', { 'class': 'at-spinner' }, text || '加载中…');
		return el;
	};

	/* ---------- 自动刷新（等价原 AutoRefresh 组件） ---------- */

	// 自动刷新开关 + 间隔选择。返回 { el, setEnabled, setInterval }
	api.autoRefresh = function (onChange) {
		var wrap = E('div', { 'class': 'at-autorefresh' });
		var enabled = true;
		var interval = 5;
		var chk = document.createElement('input');
		chk.type = 'checkbox';
		chk.checked = true;
		var label = E('label', { 'class': 'at-autorefresh-label' }, '自动刷新 ');
		label.insertBefore(chk, label.firstChild);
		var sel = document.createElement('select');
		sel.className = 'cbi-input-select';
		sel.style.width = '90px';
		[3, 5, 10, 15, 30, 60].forEach(function (s) {
			var opt = document.createElement('option');
			opt.value = String(s);
			opt.textContent = s + ' 秒';
			if (s === interval) opt.selected = true;
			sel.appendChild(opt);
		});
		sel.addEventListener('change', function () {
			interval = parseInt(sel.value, 10);
			if (onChange) onChange(enabled, interval);
		});
		chk.addEventListener('change', function () {
			enabled = chk.checked;
			if (onChange) onChange(enabled, interval);
		});
		label.appendChild(sel);
		wrap.appendChild(label);
		return {
			el: wrap,
			setEnabled: function (v) { enabled = v; chk.checked = v; },
			setInterval: function (s) { interval = s; sel.value = String(s); },
			getInterval: function () { return interval; },
			isEnabled: function () { return enabled; }
		};
	};

	/* ---------- 定时器/订阅生命周期（切页自动清理） ---------- */

	var _hooks = [];

	function _installHashHook() {
		if (_installHashHook._done) return;
		_installHashHook._done = true;
		window.addEventListener('hashchange', function () {
			// 延后一拍，避免同 tick 内先注册又被立刻清掉
			setTimeout(function () {
				var old = _hooks;
				_hooks = [];
				old.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
			}, 0);
		});
	}

	/**
	 * set interval，路由切换（hashchange）时自动 clear。
	 * 返回原 timer id。
	 */
	api.interval = function (ms, fn) {
		_installHashHook();
		var id = setInterval(fn, ms);
		_hooks.push(function () { clearInterval(id); });
		return id;
	};

	/**
	 * 订阅 AtWs 事件，hashchange 时自动 unsubscribe。
	 */
	api.subscribe = function (handler) {
		_installHashHook();
		if (AtWs && AtWs.client && typeof AtWs.client.subscribe === 'function') {
			AtWs.client.subscribe(handler);
		}
		_hooks.push(function () {
			if (AtWs && AtWs.client && typeof AtWs.client.unsubscribe === 'function') {
				AtWs.client.unsubscribe(handler);
			}
		});
		return handler;
	};

	return api;
})();

var UiClass = L.Class.extend(Ui);
if (typeof window !== 'undefined') {
	window.Ui = new UiClass();
}
return UiClass;
