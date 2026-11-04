'use strict';
'require baseclass';
/* global L */
/**
 * at-webserver/uimode.js —— 全局 UI Mode Manager
 * ---------------------------------------------------------------------------
 * 普通模式（normal）与极简模式（minimal）共用的唯一状态源。
 *
 * 设计约束（对应本次双 UI 重构需求）：
 *   - 状态写在 <html data-ui-mode="normal|minimal">，CSS 一次命中全页；
 *     弹窗挂在 document.body 下，同样是该属性的后代，自动跟随当前模式。
 *   - 切换只改属性 + 重绘图标，不重建页面 / 业务组件 / 轮询 / 定时器；
 *     不触碰 AT 指令、短信、拨号、USB、网络配置与后台服务。
 *   - 配置沿用现有 UCI：at-webserver.config.ui_mode（read/write 权限已在
 *     root/usr/share/rpcd/acl.d/luci-app-mt5700.json 中，无需改 ACL、无需新后端）。
 *     写入只调用 L.uci.set + L.uci.save（commit），**不调用 L.uci.apply()**，
 *     因此不会触发网络配置重新应用或任何服务重启。
 *   - 默认 normal；非法值 / 读取失败一律安全回退 normal。
 *   - 刷新 / 跨页面 / 重新登录后保持一致：每次模块求值都从 UCI 重新校准；
 *     sessionStorage 只保存「上次已确认的模式」作为首屏同步提示值，避免
 *     异步读 UCI 期间闪一下普通模式，权威值始终以 UCI 为准。
 *   - 模块级单例：boot() 幂等，document 上的点击委托只注册一次，
 *     onChange 去重，避免重复初始化与重复注册事件。
 */

var AtUimode = (function () {
	var api = {};

	var DEFAULT = 'normal';
	var VALID = ['normal', 'minimal'];
	var ATTR = 'data-ui-mode';
	var DECORATED = 'data-mt-uimode-decorated';
	var STORAGE_KEY = 'at-webserver:ui-mode-hint';
	var UCI_PACKAGE = 'at-webserver';
	var UCI_SECTION = 'config';
	var UCI_OPTION = 'ui_mode';
	var EVENT = 'mt5700:uimodechange';

	var current = DEFAULT;
	var listeners = [];
	var booted = false;
	var delegateBound = false;
	var bootPromise = null;

	/* ================= 纯函数（可单测） ================= */

	api.modes = VALID.slice();
	api.defaultMode = DEFAULT;
	api.option = { package: UCI_PACKAGE, section: UCI_SECTION, option: UCI_OPTION };

	api.isValid = function (v) {
		return v === 'normal' || v === 'minimal';
	};

	/* 严格校验：只允许 normal / minimal，其它（含空、大小写差异、对象）回退 normal */
	api.normalize = function (v) {
		return api.isValid(v) ? v : DEFAULT;
	};

	api.label = function (v) {
		return api.normalize(v) === 'minimal' ? '极简模式' : '普通模式';
	};

	api.current = function () { return current; };

	/* ================= 环境小工具 ================= */

	function docEl() {
		try {
			return (typeof document !== 'undefined' && document.documentElement)
				? document.documentElement : null;
		} catch (e) { return null; }
	}

	function readHint() {
		try {
			if (typeof window !== 'undefined' && window.sessionStorage) {
				return window.sessionStorage.getItem(STORAGE_KEY);
			}
		} catch (e) { /* 隐私模式 / 禁用存储 */ }
		return null;
	}

	function writeHint(v) {
		try {
			if (typeof window !== 'undefined' && window.sessionStorage) {
				window.sessionStorage.setItem(STORAGE_KEY, v);
			}
		} catch (e) { /* 静默：hint 只是加速首屏，失败不影响功能 */ }
	}

	function notify(mode) {
		for (var i = 0; i < listeners.length; i++) {
			try { listeners[i](mode); } catch (e) { /* 单个回调异常不阻断 */ }
		}
		if (typeof document !== 'undefined' && document.documentElement
			&& typeof window !== 'undefined' && window.CustomEvent) {
			try {
				document.documentElement.dispatchEvent(new window.CustomEvent(EVENT, {
					detail: { mode: mode }, bubbles: false
				}));
			} catch (e) { /* 老引擎降级为仅 listeners */ }
		}
	}

	/* 同步所有由 decorate() 标记的弹窗 / 浮层节点上的模式标记 */
	function syncDecorated(mode) {
		if (typeof document === 'undefined' || !document.querySelectorAll) return;
		var nodes = document.querySelectorAll('[' + DECORATED + ']');
		for (var i = 0; i < nodes.length; i++) {
			try { nodes[i].setAttribute(ATTR, mode); } catch (e) { /* ignore */ }
		}
	}

	/* 同步所有模式切换控件的选中态（无实例监听器，不会泄漏） */
	function syncSwitches(mode) {
		if (typeof document === 'undefined' || !document.querySelectorAll) return;
		var btns = document.querySelectorAll('[data-mt-uimode-value]');
		for (var i = 0; i < btns.length; i++) {
			var v = btns[i].getAttribute('data-mt-uimode-value');
			var on = (v === mode);
			try {
				btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
				btns[i].classList.toggle('is-active', on);
			} catch (e) { /* ignore */ }
		}
	}

	/* 只改外观状态，不写 UCI、不重建任何业务组件 */
	function applyDom(mode) {
		var root = docEl();
		if (root) {
			try {
				root.setAttribute(ATTR, mode);
				root.setAttribute('data-ui-mode-ready', '1');
			} catch (e) { /* 极老引擎降级 */ }
		}
		writeHint(mode);
		syncDecorated(mode);
		syncSwitches(mode);
		/* 图标按模式重绘：只替换 <svg> 内部图元 */
		try {
			if (typeof window !== 'undefined' && window.AtIcons
				&& typeof window.AtIcons.refresh === 'function') {
				window.AtIcons.refresh();
			}
		} catch (e) { /* ignore */ }
		notify(mode);
		return mode;
	}

	/* ================= UCI 读写（沿用现有权限机制，不新增后端） ================= */

	function uciAvailable() {
		try {
			return !!(typeof L !== 'undefined' && L.uci
				&& typeof L.uci.load === 'function'
				&& typeof L.uci.get === 'function'
				&& typeof L.uci.set === 'function'
				&& typeof L.uci.save === 'function');
		} catch (e) { return false; }
	}

	/* 读取失败 / 未配置 → null → normalize 回退 normal */
	function loadFromUci() {
		return new Promise(function (resolve) {
			if (!uciAvailable()) { resolve(null); return; }
			try {
				Promise.resolve(L.uci.load(UCI_PACKAGE)).then(function () {
					resolve(L.uci.get(UCI_PACKAGE, UCI_SECTION, UCI_OPTION));
				}, function () { resolve(null); });
			} catch (e) { resolve(null); }
		});
	}
	api.loadFromUci = loadFromUci;

	/**
	 * 写入配置。只 commit，不 apply —— 绝不触发网络配置重新应用、服务重启、
	 * AT 重新初始化、模块重新拨号或 USB 接口重建。
	 * 返回 { ok, error }，永不 reject，便于调用方明确区分成功/失败。
	 */
	function persist(mode) {
		if (!uciAvailable()) {
			return Promise.resolve({ ok: false, error: '当前环境不支持 UCI 写入' });
		}
		try {
			L.uci.set(UCI_PACKAGE, UCI_SECTION, UCI_OPTION, mode);
			return Promise.resolve(L.uci.save(UCI_PACKAGE)).then(function () {
				return { ok: true, error: '' };
			}, function (err) {
				return { ok: false, error: (err && (err.message || err.code)) || 'UCI 保存失败' };
			});
		} catch (e) {
			return Promise.resolve({ ok: false, error: e && e.message ? e.message : 'UCI 写入异常' });
		}
	}
	api.persist = persist;

	/**
	 * 持久化失败时，把 L.uci.set() 写入的**内存暂存值**改回设备真实模式。
	 * LuCI 的 set() 只改浏览器内的 uci state，save() 才 commit 到设备；
	 * 若只回滚前端 DOM 而留下暂存值，用户随后在同一页面保存其它配置时，
	 * 这条失败的 ui_mode 会被一并提交，刷新后模式与用户所见不一致。
	 */
	function restoreStaged(mode) {
		try {
			if (uciAvailable()) L.uci.set(UCI_PACKAGE, UCI_SECTION, UCI_OPTION, mode);
		} catch (e) { /* 尽力恢复即可，不得掩盖原始错误 */ }
	}

	/* ================= 启动：单例、幂等 ================= */

	api.boot = function () {
		if (booted) return bootPromise;
		booted = true;
		bindDelegate();

		/* 1) 同步首屏：用上次已确认的模式，避免异步读 UCI 期间闪烁 */
		current = api.normalize(readHint());
		applyDom(current);

		/* 2) UCI 为权威：加载完成后校准（非法值 / 读取失败均回退 normal） */
		bootPromise = loadFromUci().then(function (raw) {
			var authoritative = api.normalize(raw);
			if (authoritative !== current) {
				current = authoritative;
				applyDom(current);
			}
			return current;
		});
		return bootPromise;
	};
	api.ready = function () { return bootPromise || api.boot(); };

	/* ================= 模式切换 ================= */

	/**
	 * 切换模式：立即更新前端（免刷新），随后持久化。
	 * 持久化失败时回滚到设备上的真实模式并明确报错，绝不显示「保存成功」。
	 * 返回 Promise<{ ok, changed, mode, error? }>，永不 reject。
	 */
	api.set = function (mode, opts) {
		var next = api.normalize(mode);
		var o = opts || {};
		if (next === current && !o.force) {
			return Promise.resolve({ ok: true, changed: false, mode: current });
		}
		var prev = current;
		current = next;
		applyDom(next);

		/* 显式跳过持久化（供单测 / 预览使用） */
		if (o.skipPersist) {
			return Promise.resolve({ ok: true, changed: true, mode: next, persisted: false });
		}

		return api.ready().then(function () {
			return persist(next);
		}).then(function (res) {
			if (res.ok) {
				return { ok: true, changed: true, mode: next, persisted: true };
			}
			/* 失败：回滚前端状态 + UCI 内存暂存值，保证「看到的」与「设备里存的」一致 */
			current = prev;
			applyDom(prev);
			restoreStaged(prev);
			var msg = '界面模式保存失败：' + res.error + '；已恢复为' + api.label(prev) + '。';
			try {
				if (typeof window !== 'undefined' && window.Mt5700
					&& typeof window.Mt5700.error === 'function') {
					window.Mt5700.error(msg);
				} else if (typeof console !== 'undefined' && console.warn) {
					console.warn('[AtUimode] ' + msg);
				}
			} catch (e) { /* ignore */ }
			return { ok: false, changed: false, mode: prev, error: res.error };
		}, function (err) {
			current = prev;
			applyDom(prev);
			restoreStaged(prev);
			return { ok: false, changed: false, mode: prev,
				error: (err && err.message) || '未知错误' };
		});
	};

	api.toggle = function () {
		return api.set(current === 'minimal' ? 'normal' : 'minimal');
	};

	/* ================= 订阅（去重，避免重复注册） ================= */

	api.onChange = function (fn) {
		if (typeof fn === 'function' && listeners.indexOf(fn) < 0) {
			listeners.push(fn);
			try { fn(current); } catch (e) { /* ignore */ }
		}
		return function () {
			var i = listeners.indexOf(fn);
			if (i >= 0) listeners.splice(i, 1);
		};
	};

	/**
	 * 给弹窗 / 浮层根节点打上当前模式标记。
	 * 弹窗业务代码（Mt5700.confirm / Ui.promptModal / smsModal / toast / loading）
	 * 完全不改动，只在创建后调用本函数即可「自动读取当前模式」。
	 */
	api.decorate = function (el) {
		if (!el || typeof el.setAttribute !== 'function') return el;
		try {
			el.setAttribute(DECORATED, '1');
			el.setAttribute(ATTR, current);
		} catch (e) { /* ignore */ }
		return el;
	};

	/* ================= 切换控件 =================
	 * 采用 document 上的单次事件委托，控件本身不注册监听器；
	 * 页面销毁后不会残留闭包，切页 / 刷新都不会重复注册。
	 */

	function E(tag, attrs, text) {
		var el = document.createElement(tag);
		if (attrs) {
			for (var k in attrs) {
				if (k === 'class') el.className = attrs[k];
				else if (k === 'style') el.style.cssText = attrs[k];
				else el.setAttribute(k, attrs[k]);
			}
		}
		if (text != null) el.textContent = String(text);
		return el;
	}

	function bindDelegate() {
		if (delegateBound || typeof document === 'undefined') return;
		delegateBound = true;
		document.addEventListener('click', function (ev) {
			var t = ev.target;
			if (!t || typeof t.closest !== 'function') return;
			var btn = t.closest('[data-mt-uimode-value]');
			if (!btn) return;
			if (btn.disabled) return;
			api.set(btn.getAttribute('data-mt-uimode-value'));
		}, true);
	}

	api.createSwitch = function () {
		if (typeof document === 'undefined') return null;
		var wrap = E('div', {
			'class': 'mt-uimode-switch',
			'data-mt-uimode-switch': '1',
			'role': 'group',
			'aria-label': '界面模式切换'
		});
		wrap.appendChild(E('button', {
			'type': 'button',
			'class': 'mt-uimode-btn',
			'data-mt-uimode-value': 'normal',
			'aria-pressed': 'true',
			'title': '普通模式：完整仪表盘与玻璃拟态视觉'
		}, '普通'));
		wrap.appendChild(E('button', {
			'type': 'button',
			'class': 'mt-uimode-btn',
			'data-mt-uimode-value': 'minimal',
			'aria-pressed': 'false',
			'title': '极简模式：Material Design 3 视觉'
		}, '极简'));
		syncSwitches(current);
		return wrap;
	};

	/* ================= 模块求值即启动 =================
	 * 此时 <html> 已存在；先同步落属性，再异步用 UCI 校准，避免首屏明暗/模式闪烁。
	 */
	api.boot();

	return api;
})();

var AtUimodeClass = L.Class.extend(AtUimode);
if (typeof window !== 'undefined') {
	window.AtUimode = new AtUimodeClass();
}
return AtUimodeClass;
