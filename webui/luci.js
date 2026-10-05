'use strict';
/*
 * LuCI 兼容垫片（Debian 独立 WebUI 专用）。
 *
 * 目标：让原 LuCI 视图代码（at-webserver/* 与 view/at-webserver/*）在不修改
 * 业务逻辑的前提下直接运行。仅实现本项目实际用到的那一小部分 LuCI API：
 *
 *   L.Class.extend / L.view.extend   —— 类与视图基类
 *   L.rpc.declare({object,method,params,expect})
 *                                    —— 映射到后端 HTTP API（/api/...）
 *   L.uci.load/get/set/changes/save/apply
 *                                    —— 映射到 /api/config（JSON 扁平键值配置）
 *   L.fs.read/write                  —— 映射到 /api/file/read|write（受限白名单）
 *   E(tag, attrs, text)              —— LuCI dom helper（语义与视图内实现一致）
 *
 * 传输层：全部走 HTTP（fetch）。实时事件沿用原有「增量轮询 events(since)」
 * 语义（后端事件总线序号单调递增），另有 /ws WebSocket 通道可供外部消费。
 *
 * 认证：后端配置 auth_key 后，所有 /api 请求需携带 X-Auth-Key 头；
 * 密钥保存在 localStorage('mt5700_key')，401 时抛 REQUIRE_AUTH_KEY 由
 * 视图层的 promptModal 流程接管（与原 LuCI 行为一致）。
 */

(function () {
	/* ---------- E()：LuCI dom helper ---------- */

	function domCreate(tag, attrs, text) {
		var el = document.createElement(tag);
		if (attrs) {
			for (var k in attrs) {
				if (k === 'class' || k === 'className') {
					el.className = attrs[k];
				} else if (k === 'style') {
					el.style.cssText = attrs[k];
				} else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
					el.addEventListener(k.substring(2).toLowerCase(), attrs[k]);
				} else if (attrs[k] != null) {
					el.setAttribute(k, attrs[k]);
				}
			}
		}
		if (text != null) {
			if (Array.isArray(text)) {
				for (var j = 0; j < text.length; j++) {
					if (text[j] == null) continue;
					if (typeof text[j] === 'object' && text[j].nodeType) {
						el.appendChild(text[j]);
					} else {
						el.appendChild(document.createTextNode(String(text[j])));
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
	window.E = domCreate;

	/* ---------- HTTP 基础设施 ---------- */

	function authHeaders(extra) {
		var h = extra || {};
		try {
			var key = localStorage.getItem('mt5700_key');
			if (key) h['X-Auth-Key'] = key;
		} catch (e) { /* ignore */ }
		return h;
	}

	function httpJson(url, opts) {
		opts = opts || {};
		var init = {
			method: opts.method || 'GET',
			headers: authHeaders(opts.body ? { 'Content-Type': 'application/json' } : {})
		};
		if (opts.body != null) init.body = JSON.stringify(opts.body);
		return fetch(url, init).then(function (resp) {
			return resp.json().catch(function () { return {}; }).then(function (data) {
				if (resp.status === 401) {
					var err = new Error('REQUIRE_AUTH_KEY');
					err.authRequired = true;
					throw err;
				}
				if (!resp.ok) {
					throw new Error((data && data.error) || ('HTTP ' + resp.status));
				}
				return data;
			});
		});
	}

	/* ---------- L.Class / L.view ---------- */

	function classExtend(members, baseProto) {
		var proto = Object.create(baseProto || null);
		for (var k in members) {
			if (Object.prototype.hasOwnProperty.call(members, k)) proto[k] = members[k];
		}
		function Klass() {
			for (var key in proto) {
				/* LuCI 语义：成员直接挂在实例原型上，构造时不做深拷贝 */
			}
		}
		Klass.prototype = proto;
		Klass.prototype.constructor = Klass;
		Klass.prototype.super = function () { };
		Klass.extend = function (m) { return classExtend(m, proto); };
		return Klass;
	}

	/* ---------- L.rpc ---------- */

	var rpc = {
		declare: function (spec) {
			var object = spec.object;
			var method = spec.method;
			var expect = spec.expect || {};
			var expectKey = Object.keys(expect)[0];

			return function () {
				var args = Array.prototype.slice.call(arguments);
				var params = {};
				/* LuCI 约定：既可按位置传入（对应 params 顺序），也可传单一命名对象 */
				var names = spec.params || [];
				if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !args[0].nodeType) {
					for (var n = 0; n < names.length; n++) {
						if (args[0][names[n]] !== undefined) params[names[n]] = args[0][names[n]];
					}
				} else {
					for (var i = 0; i < names.length && i < args.length; i++) {
						params[names[i]] = args[i];
					}
				}

				var p = route(object, method, params);
				return p.then(function (result) {
					/* expect: {} → 完整结果；expect: {k: def} → result.k ?? def */
					if (expectKey != null && expectKey !== '') {
						var v = result ? result[expectKey] : undefined;
						return (v == null) ? expect[expectKey] : v;
					}
					if (expectKey === '') {
						var v2 = result ? result[''] : undefined;
						return (v2 == null) ? expect[''] : v2;
					}
					return result;
				});
			};
		}
	};

	function route(object, method, params) {
		/* mt5700 对象：AT 命令 / 事件 / 日志 / 接口速率 / USB 信息 */
		if (object === 'mt5700') {
			if (method === 'at') return httpJson('/api/at', { method: 'POST', body: { cmd: params.cmd } });
			if (method === 'events') return httpJson('/api/events?since=' + encodeURIComponent(params.since || 0));
			if (method === 'logs') return httpJson('/api/logs?since=' + encodeURIComponent(params.since || 0) + '&limit=' + encodeURIComponent(params.limit || 300));
			if (method === 'netrate') return httpJson('/api/netrate?device=' + encodeURIComponent(params.device || ''));
			if (method === 'usb') return httpJson('/api/usb');
		}
		/* log 对象：等价 rpcd log.read（syslog）→ /api/syslog */
		if (object === 'log' && method === 'read') {
			return httpJson('/api/syslog?lines=' + encodeURIComponent(params.lines || 200));
		}
		/* file 对象：等价 rpcd file.read / file.write（后端白名单受限） */
		if (object === 'file' && method === 'read') {
			return httpJson('/api/file/read?path=' + encodeURIComponent(params.path || ''));
		}
		if (object === 'file' && method === 'write') {
			return httpJson('/api/file/write', { method: 'POST', body: { path: params.path, data: params.data } });
		}
		/* 其它对象走通用 RPC 转发端点 */
		return httpJson('/api/rpc/' + encodeURIComponent(object) + '/' + encodeURIComponent(method), {
			method: 'POST', body: params
		});
	}

	/* ---------- L.uci：扁平键值配置（单 section `config`） ---------- */

	var uciCache = {};      /* 最近一次从后端拉到的键值 */
	var uciStaged = {};     /* set() 暂存、待 save() 落盘 */
	var uciLoaded = {};

	function normalizeVal(v) {
		return (v == null) ? null : String(v);
	}

	var uci = {
		load: function (name) {
			return httpJson('/api/config').then(function (map) {
				uciCache = map || {};
				uciLoaded[name || 'at-webserver'] = true;
				return uciCache;
			});
		},
		get: function (conf, section, option) {
			void conf; void section; /* Debian 后端为扁平键值，等价 config 段 */
			var k = option;
			if (uciStaged.hasOwnProperty(k)) return normalizeVal(uciStaged[k]);
			if (uciCache.hasOwnProperty(k)) return normalizeVal(uciCache[k]);
			return null;
		},
		set: function (conf, section, option, value) {
			void conf; void section;
			uciStaged[option] = normalizeVal(value);
			return Promise.resolve(true);
		},
		unset: function (conf, section, option) {
			void conf; void section;
			delete uciStaged[option];
			return Promise.resolve(true);
		},
		changes: function () {
			var keys = Object.keys(uciStaged);
			return Promise.resolve(keys.map(function (k) { return { key: k }; }));
		},
		save: function () {
			if (!Object.keys(uciStaged).length) {
				return Promise.resolve(true);
			}
			return httpJson('/api/config', { method: 'POST', body: uciStaged }).then(function (res) {
				/* 落盘成功后并入缓存 */
				for (var k in uciStaged) uciCache[k] = uciStaged[k];
				uciStaged = {};
				return res;
			});
		},
		apply: function () {
			return this.save().then(function () {
				return httpJson('/api/config/apply', { method: 'POST', body: {} });
			});
		}
	};

	/* ---------- L.fs：受限文件读写 ---------- */

	var fsApi = {
		read: function (path) {
			return httpJson('/api/file/read?path=' + encodeURIComponent(path)).then(function (r) {
				return (r && r.data != null) ? r.data : '';
			});
		},
		write: function (path, data) {
			return httpJson('/api/file/write', { method: 'POST', body: { path: path, data: data } }).then(function (r) {
				return (r && r.data != null) ? r.data : '';
			});
		},
		list: function (path) {
			return httpJson('/api/file/list?path=' + encodeURIComponent(path)).then(function (r) {
				return r || { entries: [] };
			});
		},
		stat: function (path) {
			return httpJson('/api/file/stat?path=' + encodeURIComponent(path)).then(function (r) {
				return r || null;
			});
		}
	};

	/* ---------- 组装 L ---------- */

	var L = {
		Class: { extend: function (members) { return classExtend(members, null); } },
		view: {
			extend: function (members) { return classExtend(members, null); }
		},
		rpc: rpc,
		uci: uci,
		fs: fsApi,
		env: {},
		url: function (path) { return path; },
		resolveDefault: function (v, def) { return (v == null) ? def : v; },
		bind: function (fn, ctx) {
			var args = Array.prototype.slice.call(arguments, 2);
			return fn.bind.apply(fn, [ctx].concat(args));
		},
		toArray: function (v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); },
		_httpJson: httpJson
	};

	window.L = L;
})();
