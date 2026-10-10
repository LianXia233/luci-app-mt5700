'use strict';
/*
 * 独立 WebUI 应用外壳：模块加载器 + hash 路由。
 *
 * 独立 WebUI 的页面清单（path / title / view），视图代码位于
 * webui/luci-static/resources/view/at-webserver/*.js。
 *
 * 加载方式与 LuCI 的 require 一致：fetch 视图源码 → 剥离 'require ...'
 * 声明行 → new Function('L', code) 求值 → 取返回的视图类 →
 * 实例化后依次调用 load()/render() → 挂载到主区域。
 * 切页时调用实例的 _dispose()（若视图定义）并触发 Ui 的 hashchange 清理。
 */

(function () {
	/* 与 root/usr/share/luci/menu.d/luci-app-mt5700.json 一致的页面清单 */
	var PAGES = [
		{ path: 'network_status',    title: '网络状态',   view: 'network_status' },
		{ path: 'network_settings',  title: '网络设置',   view: 'network_settings' },
		{ path: 'dial',              title: '拨号设置',   view: 'dial' },
		{ path: 'scan',              title: '全网扫频',   view: 'scan' },
		{ path: 'schedule',          title: '定时锁频',   view: 'schedule' },
		{ path: 'modem-settings',    title: '模组设置',   view: 'modem_settings' },
		{ path: 'upgrade',           title: '模组升级',   view: 'upgrade' },
		{ path: 'sms',               title: '短信中心',   view: 'sms_center' },
		{ path: 'sms-settings',      title: '短信设置',   view: 'sms_settings' },
		{ path: 'terminal',          title: 'AT 调试终端', view: 'terminal' },
		{ path: 'logs',              title: '运行日志',   view: 'logs' },
		{ path: 'config',            title: '服务配置',   view: 'service' }
	];

	var RESOURCE_ORDER = [
		'at-webserver/compat',
		'at-webserver/parse',
		'at-webserver/rpc',
		'at-webserver/smsEncode',
		'at-webserver/mt5700',
		'at-webserver/ui'
	];

	var loadedResources = null;
	var loadedViews = {};
	var currentInstance = null;

	var navEl = document.getElementById('nav');
	var mainEl = document.getElementById('main');

	/* ---------- 模块加载 ---------- */

	function evalModule(url) {
		return fetch(url).then(function (resp) {
			if (!resp.ok) throw new Error('加载模块失败: ' + url + ' (HTTP ' + resp.status + ')');
			return resp.text();
		}).then(function (code) {
			/* 剥离 LuCI 'require ...' 声明行（普通 script 求值里它们只是字符串，无副作用） */
			code = code.replace(/^\s*'require [^']*';\s*$/mg, '');
			var factory = new Function('L', '"use strict";\n' + code + '\n');
			/* 返回值 = LuCI 约定的模块类；资源模块同时会把实例挂到 window */
			return factory(window.L);
		});
	}

	function loadResources() {
		if (loadedResources) return loadedResources;
		loadedResources = RESOURCE_ORDER.reduce(function (chain, name) {
			return chain.then(function () {
				return evalModule('/luci-static/resources/' + name + '.js');
			});
		}, Promise.resolve());
		return loadedResources;
	}

	function loadView(name) {
		if (loadedViews[name]) return Promise.resolve(loadedViews[name]);
		return evalModule('/luci-static/resources/view/at-webserver/' + name + '.js').then(function (klass) {
			loadedViews[name] = klass;
			return klass;
		});
	}

	/* ---------- 路由 ---------- */

	function currentPath() {
		var h = (location.hash || '').replace(/^#\/?/, '');
		if (!PAGES.some(function (p) { return p.path === h; })) return PAGES[0].path;
		return h;
	}

	function renderNav(activePath) {
		navEl.innerHTML = '';
		var group = document.createElement('div');
		group.className = 'nav-group';
		group.textContent = '5G 模组管理';
		navEl.appendChild(group);
		PAGES.forEach(function (p) {
			var a = document.createElement('a');
			a.href = '#/' + p.path;
			a.textContent = p.title;
			if (p.path === activePath) a.className = 'active';
			navEl.appendChild(a);
		});
	}

	function disposeCurrent() {
		if (currentInstance && typeof currentInstance._dispose === 'function') {
			try { currentInstance._dispose(); } catch (e) { console.warn(e); }
		}
		currentInstance = null;
		/* Ui.interval / Ui.subscribe 注册的清理回调随 hashchange 自动执行 */
		if (window.dispatchEvent) {
			/* hashchange 已由浏览器触发；编程式切换（首次加载）手动清一次 */
		}
	}

	function navigate() {
		var path = currentPath();
		renderNav(path);
		disposeCurrent();

		var loading = document.createElement('div');
		loading.className = 'loading-page';
		loading.textContent = '正在加载页面…';
		mainEl.innerHTML = '';
		mainEl.appendChild(loading);

		/* Ui 的 hashchange 清理回调延后一拍执行（setTimeout 0）；
		 * 先等它跑完，避免旧页定时器清掉新页刚注册的回调。 */
		var ready = loadResources().then(function () {
			return new Promise(function (resolve) { setTimeout(resolve, 0); });
		});

		ready.then(function () {
			return loadView(path2view(path));
		}).then(function (Klass) {
			var inst = new Klass();
			currentInstance = inst;
			var prepare = (typeof inst.load === 'function') ? inst.load() : Promise.resolve();
			return Promise.resolve(prepare).then(function (data) {
				if (currentInstance !== inst) return; /* 期间已切页 */
				var node = inst.render(data);
				mainEl.innerHTML = '';
				mainEl.appendChild(node);
			});
		}).catch(function (err) {
			console.error(err);
			if (/REQUIRE_AUTH_KEY/.test(err && err.message)) {
				mainEl.innerHTML = '';
				mainEl.appendChild(promptAuth(function () { navigate(); }));
				return;
			}
			mainEl.innerHTML = '';
			var box = document.createElement('div');
			box.className = 'loading-page';
			box.textContent = '页面加载失败: ' + ((err && err.message) || err);
			mainEl.appendChild(box);
		});
	}

	function path2view(path) {
		for (var i = 0; i < PAGES.length; i++) {
			if (PAGES[i].path === path) return PAGES[i].view;
		}
		return PAGES[0].view;
	}

	/* ---------- 认证 ---------- */

	function promptAuth(onOk) {
		var mask = document.createElement('div');
		mask.className = 'at-modal-mask';
		mask.style.position = 'fixed';
		var box = document.createElement('div');
		box.className = 'at-modal';
		var text = document.createElement('div');
		text.className = 'at-modal-text';
		text.textContent = '后端已启用访问密钥认证，请输入密钥';
		var input = document.createElement('input');
		input.type = 'password';
		input.style.cssText = 'width:100%;padding:8px 10px;margin:12px 0;border:1px solid #c9d6e0;border-radius:8px;font-size:14px;';
		var ok = document.createElement('button');
		ok.className = 'at-btn at-btn-primary';
		ok.textContent = '确定';
		ok.addEventListener('click', function () {
			try { localStorage.setItem('mt5700_key', input.value.trim()); } catch (e) { /* ignore */ }
			if (mask.parentNode) mask.parentNode.removeChild(mask);
			if (onOk) onOk();
		});
		box.appendChild(text);
		box.appendChild(input);
		box.appendChild(ok);
		mask.appendChild(box);
		document.body.appendChild(mask);
		return mask;
	}

	/* ---------- 侧栏页脚：版本与后端连通性 ---------- */

	function refreshFooter() {
		window.L._httpJson('/api/service/status').then(function (st) {
			var ver = document.getElementById('foot-version');
			if (ver && st.version) ver.textContent = 'at-webserver ' + st.version;
			var conn = document.getElementById('foot-conn');
			if (conn) {
				conn.className = 'foot-line ok';
				conn.textContent = '后端运行中 · PID ' + (st.pid || '-');
			}
		}).catch(function () {
			var conn = document.getElementById('foot-conn');
			if (conn) {
				conn.className = 'foot-line bad';
				conn.textContent = '后端连接失败';
			}
		});
	}

	/* ---------- 启动 ---------- */

	window.addEventListener('hashchange', navigate);
	loadResources().then(refreshFooter).catch(function (e) { console.warn('资源预加载失败', e); });
	navigate();
	setInterval(refreshFooter, 15000);
})();
