'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/rpc';
/* ★ 必须显式 require mt5700：本文件第 30 行 `var E = Mt5700.E;` 取的就是
   mt5700.js 的实现（经 api.E 导出）。此前缺这一行，Mt5700 未定义 → E 取不到，
   promptModal 每次调用都抛 `ReferenceError: E is not defined` ——
   改 IMEI / PUK 解锁 / eSIM 重命名 / eSIM 删除 / 新增 PDP / 新短信 /
   保存 AT 命令这 7 处弹窗入口全部点不开。
   （注：原文写「E 全站只有 mt5700.js 一份实现」，**与事实不符** —— LuCI 的
   cbi.js:135 另有一个全局 E（L.dom.create 转发），视图层 362 处裸 E(...) 用的是它。
   本文件**刻意**取 Mt5700.E 而不依赖全局，两套的行为差异见 mt5700.js:1131 的说明。） */
'require at-webserver/mt5700';
/* global L, AtWs, baseclass, Mt5700 */

/**
 * LuCI 页面公共 UI 辅助。
 *
 * 本文件只留**真有调用点**的入口：弹窗（promptModal）、AT 发送封装
 * （sendCmd / sleep / atErrorText / setFlightMode）与自动刷新（autoRefresh / interval）。
 * 页面骨架与提示（page / card / toast / confirm / empty …）一律走 mt5700.js 那套，
 * 详见下面「死代码清理」的说明 —— 这里曾经并存两套，是"改了没变化"的经典来源。
 */

/* 样式统一由 mt5700.css 提供（mt5700.js 负责注入），本文件不再注入任何样式表。
   所有页面都会 require at-webserver/mt5700，因此 mt5700.css 一定已加载。 */

var Ui = (function () {
	var api = {};

	/* DOM 构造 helper 取自 mt5700.js（全站唯一实现，经 api.E 导出）。
	   取一次赋给局部 E，下面所有 E(...) 调用写法不变，也不必再引入第二份实现。 */
	var E = Mt5700.E;

	/* 所有按钮都经由此卡口创建，而卡口直接转交 Mt5700.button —— 全站只有
	   一套按钮实现（mt5700-btn + mt5700-btn-<variant>，样式来自设计变量）。

	   ★ 旧实现把调用方传来的 cbi-button-* **原样保留**到元素上，于是同一个
	     按钮身上同时挂着本文件自有的按钮类和 LuCI 主题自己的按钮类 —— 外观
	     最后取决于两份样式表的层叠顺序，换个主题就变样，在 Argon 下更是两边
	     的 padding/圆角互相打架。现在**只输出一套类**：cbi-button-* 仅作为
	     「调用方意图」在下面的映射表里被读取，不再落到 DOM 上。 */
	var BTN_VARIANT = {
		'cbi-button-positive': 'primary',
		'cbi-button-negative': 'danger',
		'cbi-button-neutral': 'secondary',
		'cbi-button-action': 'primary',
		'cbi-button-reset': 'ghost'
	};

	api.button = function (label, cls, onClick) {
		var variant = 'secondary';
		(cls || '').split(/\s+/).forEach(function (c) {
			if (BTN_VARIANT[c]) variant = BTN_VARIANT[c];
		});
		return Mt5700.button(label, onClick, variant);
	};

	/*
	 * ★ 死代码清理（2026-09-22 全量审查）：本文件原先还导出 panel / field / kv /
	 *   tag / primaryButton / dangerButton / toast(+success/error/warning/info) /
	 *   confirm / renderConnectionBar / deriveNetworkMode / page / spinner /
	 *   subscribe 共 13 个函数，全仓库 grep 下来**一个调用点都没有** —— 页面实际
	 *   用的是 mt5700.js 那套（Mt5700.page / Mt5700.toast / Mt5700.confirm …）。
	 *   两库并存的结果是：改了 mt5700.js 的 toast 样式，ui.js 那份（用的是旧的
	 *   at-toast 类）纹丝不动，读代码的人还得先判断「该用哪个」。
	 *   现已全部删除；下面只保留**真有调用点**的入口
	 *   （`api.button` 无外部调用点，但 promptModal 内部要用，留在原处）。
	 */


	api.promptModal = function (title, fields, onOk) {
		var mask = E('div', { 'class': 'mt5700-modal-mask' });
		var box = E('div', { 'class': 'mt5700-modal mt5700-modal-wide' });
		var head = E('div', { 'class': 'mt5700-modal-header' });
		var h = E('div', { 'class': 'mt5700-modal-title' }, title);
		var body = E('div', { 'class': 'mt5700-modal-body' });
		var inputs = {};
		for (var i = 0; i < fields.length; i++) {
			var f = fields[i];
			var row = E('div', { 'class': 'mt5700-field' });
			row.appendChild(E('div', { 'class': 'mt5700-label mt5700-field-label' }, f.label));
			var ctrl = E('div', { 'class': 'mt5700-field-control' });
			var input;
			if (f.type === 'select') {
				input = document.createElement('select');
				input.className = 'mt5700-input mt5700-select';
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
				input.className = 'mt5700-input';
				if (f.value != null) input.value = String(f.value);
				if (f.placeholder) input.placeholder = f.placeholder;
			}
			ctrl.appendChild(input);
			if (f.hint) ctrl.appendChild(E('div', { 'class': 'mt5700-hint' }, f.hint));
			row.appendChild(ctrl);
			body.appendChild(row);
			inputs[f.key] = input;
		}
		var actions = E('div', { 'class': 'mt5700-modal-footer' });
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
		head.appendChild(h);
		box.appendChild(head);
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

	/* ---------- 常用 AT 辅助（等价 modem/atx.ts） ---------- */

	api.sleep = function (ms) {
		return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
	};

	/*
	 * ★ 2026-09-28 去掉固定 sleep(100)，改为直接下发。
	 *
	 * 原来是「发命令前固定等 100ms，保证命令间隔」—— 那是旧实现的口径。现在
	 * `AtWs.client.sendCommand` 自己就**严格串行**：rpc.js 里 queue 是全局单链
	 *   `this.commandQueue = this.commandQueue.then(...)`（rpc.js:212/870），
	 *   上一条的 Promise 完成（等到模组回 OK/ERROR）才发下一条。
	 * 也就是说「间隔」已经由应答本身保证了，这 100ms 是**纯等待**。
	 *
	 * 代价是实打实的：dial.js 有 19 处调用，典型流程是串行链
	 *   `sendCmd('AT+CGDCONT?').then(function () { return sendCmd('AT+CGACT?'); })`
	 * —— 两条各自白等 100ms。用户手动「刷新」拨号页时，这些毫秒直接叠在
	 * 界面响应上，而串口那边一条命令都没少发。
	 *
	 * 保留 sendCmd 这个入口（接口不变），只是不再插入固定延时。
	 */
	api.sendCmd = function (command) {
		return AtWs.client.sendCommand(command);
	};

	// 错误文本还原（等价 atx.ts 的 atErrorText）
	api.atErrorText = function (res, fallback) {
		if (!res || res.success) return fallback;
		var msg = res.error || fallback;
		if (typeof msg === 'string' && msg.indexOf('CME ERROR') >= 0) {
			var code = msg.match(/CME ERROR:\s*(\d+)/);
			if (code) {
				/*
				 * CME ERROR 码表（3GPP TS 27.007 §9.2 的标准部分）。
				 *
				 * ★ 2026-09-28 更正四处**码义错配**（原表会把用户引向完全错误的排查方向）：
				 *   · 10 原写「模组忙」   → 标准是 **SIM not inserted（SIM 卡未插入）**
				 *   · 14 原写「SIM 已满」 → 标准是 **SIM busy（SIM 忙）**；
				 *     「内存满」在标准里是 **20**，原表漏收，一并补上
				 *   · 21 原写「无效字符」 → 标准是 **invalid index（无效索引）**
				 *   · 22 原写「无效索引」 → 标准是 **not found（未找到）**
				 *   依据：3GPP TS 27.007 §9.2。模组手册只写「+CME ERROR: <err>」而**未收录
				 *   码表**（已查手册 171 / 262 / 263 / 395 等处确认），故以标准为准。
				 *   513/515/516/517/518 属**厂商特定**范围，无标准可依，原样保留。
				 */
				var map = {
					'1': '未指定的错误', '3': '操作不允许', '4': '操作不支持',
					'10': 'SIM 卡未插入', '11': 'PIN 未输入或错误', '12': '需要 SIM PUK',
					'13': 'SIM 故障', '14': 'SIM 忙', '15': 'SIM 错误', '16': '密码错误',
					'20': '内存满', '21': '无效索引', '22': '未找到',
					'100': '未知错误', '513': 'SIM 锁定', '515': 'SIM 错误',
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

	/* ---------- 通用渲染 ---------- */

	/* ---------- 自动刷新（等价原 AutoRefresh 组件） ---------- */

	/*
	 * 自定义间隔的上下限（秒）。
	 *
	 * 下限不能是 0，这不是洁癖：调用方（network_status.js 的 resetTimers）把
	 * interval 直接当 setInterval 的毫秒基数，而按 HTML 标准，定时器延时为 0
	 * 时会被钳到约 4ms（嵌套层级下的最小值）。真落到 0，「自动刷新」就变成
	 * 每 4 毫秒打一次串口 —— AT 通道是独占的，等于把自己打死。
	 * 上限只防手滑多敲几个 0，换来一个永远等不到的刷新。
	 */
	var AR_MIN_SEC = 2;
	var AR_MAX_SEC = 3600;
	var AR_CUSTOM_VALUE = 'custom';

	/*
	 * 把任意输入收敛成合法秒数；解析不出数字返回 null（由调用方保持原值，
	 * 不猜一个数、也不让界面显示与真实间隔不符）。
	 * parseInt 首位非数字即 NaN（MDN: parseInt），故 '' / 'abc' 都会走 null。
	 */
	function clampRefreshSec(value) {
		var n = parseInt(value, 10);
		if (isNaN(n)) return null;
		return Math.min(AR_MAX_SEC, Math.max(AR_MIN_SEC, n));
	}

	// 自动刷新开关 + 间隔（六档预设 + 自定义秒数）。返回 { el, setEnabled, setInterval, getInterval, isEnabled }
	api.autoRefresh = function (onChange) {
		var wrap = E('div', { 'class': 'mt5700-autorefresh' });
		var enabled = true;
		var interval = 5;
		var chk = document.createElement('input');
		chk.type = 'checkbox';
		chk.checked = true;
		var label = E('label', { 'class': 'mt5700-autorefresh-label' }, '自动刷新 ');
		label.insertBefore(chk, label.firstChild);
		var sel = document.createElement('select');
		sel.className = 'mt5700-input mt5700-select mt5700-autorefresh-interval';
		[3, 5, 10, 15, 30, 60].forEach(function (s) {
			var opt = document.createElement('option');
			opt.value = String(s);
			opt.textContent = s + ' 秒';
			if (s === interval) opt.selected = true;
			sel.appendChild(opt);
		});
		var customOpt = document.createElement('option');
		customOpt.value = AR_CUSTOM_VALUE;
		customOpt.textContent = '自定义…';
		sel.appendChild(customOpt);

		/* 自定义秒数：只在选中「自定义…」时才出现，平时不占版面。
		   用 number 而不是 text：由浏览器先挡掉一批非法输入，
		   真值仍以 clampRefreshSec 为准（type=number 挡不住手敲的 0）。 */
		var custom = document.createElement('input');
		custom.type = 'number';
		custom.className = 'mt5700-input mt5700-autorefresh-custom';
		custom.min = String(AR_MIN_SEC);
		custom.max = String(AR_MAX_SEC);
		custom.step = '1';
		custom.style.display = 'none';
		custom.title = '自定义刷新间隔，' + AR_MIN_SEC + '~' + AR_MAX_SEC + ' 秒';

		function emit() { if (onChange) onChange(enabled, interval); }

		/* 把 interval 反映到控件上：命中预设就选预设，否则切到「自定义…」并回填秒数。
		   回填是必须的 —— 用户填 1 得到 2，界面必须写 2，否则界面在说谎。 */
		function syncControls() {
			var hit = false;
			for (var i = 0; i < sel.options.length; i++) {
				if (sel.options[i].value === String(interval)) { hit = true; break; }
			}
			if (hit) sel.value = String(interval);
			else { sel.value = AR_CUSTOM_VALUE; custom.value = String(interval); }
			custom.style.display = sel.value === AR_CUSTOM_VALUE ? '' : 'none';
		}

		function applyCustom() {
			var v = clampRefreshSec(custom.value);
			/* 非法输入：回填当前真值即可，不改间隔、不通知调用方 */
			if (v == null) { syncControls(); return; }
			interval = v;
			syncControls();
			emit();
		}

		sel.addEventListener('change', function () {
			if (sel.value === AR_CUSTOM_VALUE) {
				/* 只展开输入框并预填当前值，等用户填完再改间隔 ——
				   选中的瞬间就改会让间隔莫名其妙跳一次 */
				custom.style.display = '';
				custom.value = String(interval);
				custom.focus();
				return;
			}
			interval = parseInt(sel.value, 10);
			custom.style.display = 'none';
			emit();
		});
		/* 用 change（失焦/回车）而不是 input：逐字符通知会不停地重建定时器 */
		custom.addEventListener('change', applyCustom);
		custom.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { e.preventDefault(); applyCustom(); }
		});
		chk.addEventListener('change', function () {
			enabled = chk.checked;
			emit();
		});
		label.appendChild(sel);
		label.appendChild(custom);
		wrap.appendChild(label);
		return {
			el: wrap,
			setEnabled: function (v) { enabled = !!v; chk.checked = !!v; emit(); },
			setInterval: function (s) {
				/* 非法值直接拒绝，保留当前间隔（不猜值） */
				var v = clampRefreshSec(s);
				if (v == null) return;
				interval = v;
				syncControls();
				emit();
			},
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

	return api;
})();

var UiClass = L.Class.extend(Ui);
if (typeof window !== 'undefined') {
	window.Ui = new UiClass();
}
return UiClass;
