'use strict';
/**
 * LuCI Tab 菜单增强单测（tabmenu.js）
 *
 * 覆盖：
 *   1) 图标库与 menu.d 页签名一一对应（12 个页签全覆盖 + 兜底图标）；
 *   2) 纯函数：tabKeyFromClass / clampScrollLeft 的边界；
 *   3) 真实模块端到端（new Function 加载 + DOM 桩）：
 *      - argon 场景（横向滚动条）：图标注入、选中项居中、幂等、点击保存偏移；
 *      - openwrt-2020 场景（cbi-tab 激活类）与 href 兜底识别；
 *      - sessionStorage 恢复：可见时恢复手动偏移，不可见时回退居中；
 *      - 换行场景（bootstrap/material，条不可滚动）：不误滚、图标照常注入；
 *      - 异步渲染场景：#tabmenu 初始为空，轮询渲染完成后自动增强；
 *      - 非本插件页面守卫：其他 LuCI 页面零副作用；
 *      - 未知页签走兜底图标。
 *
 * 运行：node tests/tabmenu-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');
const menuJson = JSON.parse(fs.readFileSync(
	path.join(__dirname, '..', 'root', 'usr', 'share', 'luci', 'menu.d', 'luci-app-mt5700.json'), 'utf8'));

/* menu.d 中 admin/modem/5g 下的页签名（Tab 菜单真实来源） */
const MENU_TAB_KEYS = Object.keys(menuJson)
	.filter(k => /^admin\/modem\/5g\/[^/]+$/.test(k))
	.map(k => k.replace(/^admin\/modem\/5g\//, ''));

/* ---------- 最小 DOM 桩 ---------- */

const SELECTOR_RE = /^([a-z]*)((?:\.[\w-]+)*)(?:\[class\*="([^"]+)"\])?$/;

function makeEl(tag) {
	const el = {
		tag: tag,
		nodeType: 1,
		attrs: {},
		children: [],
		_classes: [],
		style: {},
		parentNode: null,
		_listeners: {},
		scrollLeft: 0,
		scrollWidth: 0,
		clientWidth: 0,
		_w: 0,
		_x: 0,

		setAttribute: function (k, v) {
			this.attrs[k] = String(v);
			if (k === 'class') this._classes = String(v).split(/\s+/).filter(Boolean);
		},
		getAttribute: function (k) {
			return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
		},
		removeAttribute: function (k) { delete this.attrs[k]; },
		appendChild: function (c) { c.parentNode = this; this.children.push(c); return c; },
		removeChild: function (c) {
			const i = this.children.indexOf(c);
			if (i >= 0) this.children.splice(i, 1);
			c.parentNode = null;
			return c;
		},
		focus: function () { this._focused = true; },
		insertBefore: function (c, ref) {
			c.parentNode = this;
			const idx = ref ? this.children.indexOf(ref) : -1;
			if (idx < 0) this.children.push(c); else this.children.splice(idx, 0, c);
			return c;
		},
		addEventListener: function (type, fn) {
			(this._listeners[type] = this._listeners[type] || []).push(fn);
		},
		dispatch: function (type, ev) {
			(this._listeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); });
		},
		matches: function (sel) {
			const m = SELECTOR_RE.exec(sel);
			if (!m) return false;
			if (m[1] && this.tag !== m[1]) return false;
			const classes = (m[2] || '').split('.').filter(Boolean);
			for (const c of classes) if (this._classes.indexOf(c) < 0) return false;
			if (m[3] && (this.attrs.class || '').indexOf(m[3]) < 0) return false;
			return true;
		},
		closest: function (sel) {
			let node = this;
			while (node && node.nodeType === 1) {
				if (node.matches && node.matches(sel)) return node;
				node = node.parentNode;
			}
			return null;
		},
		querySelector: function (sel) { return this.querySelectorAll(sel)[0] || null; },
		querySelectorAll: function (sel) {
			const out = [];
			(function walk(node) {
				node.children.forEach(function (c) {
					if (c.nodeType !== 1) return;
					if (c.matches(sel)) out.push(c);
					walk(c);
				});
			})(this);
			return out;
		},
		getBoundingClientRect: function () {
			return this._rect ? this._rect() : { left: 0, right: 0, width: 0 };
		}
	};
	Object.defineProperty(el, 'className', {
		get: function () { return this._classes.join(' '); },
		set: function (v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
	});
	Object.defineProperty(el, 'firstChild', {
		get: function () { return this.children[0] || null; }
	});
	Object.defineProperty(el, 'textContent', {
		get: function () {
			if (this.nodeType === 3) return this._text || '';
			if (this._text != null) return this._text;
			return this.children.map(function (c) { return c.textContent || ''; }).join('');
		},
		set: function (v) { this.children = []; this._text = String(v); }
	});
	Object.defineProperty(el, 'href', {
		get: function () { return this._href || ''; },
		set: function (v) {
			this._href = String(v);
			this.pathname = String(v).split('?')[0].split('#')[0];
		}
	});
	el.classList = {
		add: function (c) { if (el._classes.indexOf(c) < 0) el._classes.push(c); },
		remove: function (c) { el._classes = el._classes.filter(function (x) { return x !== c; }); },
		contains: function (c) { return el._classes.indexOf(c) >= 0; },
		toggle: function (c, force) {
			const has = el._classes.indexOf(c) >= 0;
			const want = force == null ? !has : !!force;
			if (want && !has) el._classes.push(c);
			if (!want && has) el._classes = el._classes.filter(function (x) { return x !== c; });
			return want;
		}
	};
	return el;
}

/* 每个场景一套独立的 document / window / sessionStorage */
function makeEnv(pathname) {
	const sessionData = {};
	const winListeners = {};

	const documentStub = {
		readyState: 'complete',
		visibilityState: 'visible',
		body: makeEl('body'),
		_listeners: {},
		createElement: makeEl,
		createElementNS: function (ns, tag) { return makeEl(tag); },
		createTextNode: function (t) { return { nodeType: 3, textContent: String(t) }; },
		addEventListener: function (type, fn) {
			(this._listeners[type] = this._listeners[type] || []).push(fn);
		},
		dispatch: function (type, ev) {
			(this._listeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); });
		},
		getElementById: function (id) {
			const found = [];
			(function walk(node) {
				node.children.forEach(function (c) {
					if (c.nodeType !== 1) return;
					if (c.attrs.id === id) found.push(c);
					walk(c);
				});
			})(documentStub.body);
			return found[0] || null;
		},
		querySelector: function (sel) {
			return documentStub.body.querySelector(sel);
		},
		querySelectorAll: function (sel) {
			return documentStub.body.querySelectorAll(sel);
		}
	};

	const windowStub = {
		location: { pathname: pathname },
		sessionStorage: {
			getItem: function (k) {
				return Object.prototype.hasOwnProperty.call(sessionData, k) ? sessionData[k] : null;
			},
			setItem: function (k, v) { sessionData[k] = String(v); }
		},
		getComputedStyle: function (el) { return el._computed || { overflowX: 'visible' }; },
		addEventListener: function (type, fn) {
			(winListeners[type] = winListeners[type] || []).push(fn);
		},
		dispatch: function (type, ev) {
			(winListeners[type] || []).slice().forEach(function (fn) { fn(ev || {}); });
		},
		_sessionData: sessionData
	};

	return { documentStub: documentStub, windowStub: windowStub };
}

/* 构造 #tabmenu > ul.tabs > li.tabmenu-item-* > a 的菜单 DOM */
function buildTabmenu(env, opts) {
	const doc = env.documentStub;
	const tabmenu = doc.createElement('div');
	tabmenu.setAttribute('id', 'tabmenu');
	doc.body.appendChild(tabmenu);

	const strip = doc.createElement('ul');
	strip.setAttribute('class', opts.stripClass || 'tabs');
	strip._computed = { overflowX: opts.scrollable ? 'auto' : 'visible' };

	const tabs = opts.tabs;
	let x = 0;
	tabs.forEach(function (t) {
		const li = doc.createElement('li');
		const cls = 'tabmenu-item-' + t.name + (t.name === opts.activeKey ? ' ' + (opts.activeClass || 'active') : '');
		li.setAttribute('class', cls);
		const a = doc.createElement('a');
		a.setAttribute('href', '/cgi-bin/luci/admin/modem/5g/' + t.name);
		a.appendChild(doc.createTextNode(t.title));
		li.appendChild(a);
		const w = t.width || 100;
		li._w = w;
		li._x = x;
		x += w;
		li.getBoundingClientRect = function () {
			return { left: li._x - strip.scrollLeft, right: li._x + li._w - strip.scrollLeft, width: li._w };
		};
		strip.appendChild(li);
	});

	const contentWidth = opts.contentWidth != null ? opts.contentWidth : x;
	const viewWidth = opts.viewWidth != null ? opts.viewWidth : contentWidth;
	strip.scrollWidth = contentWidth;
	strip.clientWidth = viewWidth;
	strip.getBoundingClientRect = function () {
		return { left: 0, right: viewWidth, width: viewWidth };
	};

	tabmenu.appendChild(strip);
	return { tabmenu: tabmenu, strip: strip };
}

const L_STUB = {
	Class: {
		extend: function (o) {
			return function AtTabmenuClass() { Object.assign(this, o); };
		}
	}
};

function loadModule(env) {
	const src = fs.readFileSync(path.join(libDir, 'tabmenu.js'), 'utf8');
	const factory = new Function('L', 'document', 'window', 'location', src);
	const AtTabmenuClass = factory(L_STUB, env.documentStub, env.windowStub, env.windowStub.location);
	return new AtTabmenuClass(); // 与 window.AtTabmenu 同一实例语义
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

const TWELVE_TABS = [
	{ name: 'status', title: '网络状态' },
	{ name: 'settings', title: '网络设置' },
	{ name: 'dial', title: '拨号设置' },
	{ name: 'scan', title: '全网扫频' },
	{ name: 'schedule', title: '定时锁频' },
	{ name: 'modem-settings', title: '模组设置' },
	{ name: 'upgrade', title: '模组升级' },
	{ name: 'sms', title: '短信中心' },
	{ name: 'sms-settings', title: '短信设置' },
	{ name: 'terminal', title: 'AT 调试终端' },
	{ name: 'logs', title: '运行日志' },
	{ name: 'config', title: '服务配置' }
];

(async function main() {

	/* ---------- 1. 图标库与 menu.d 对齐 ---------- */
	const env0 = makeEnv('/cgi-bin/luci/admin/modem/5g/logs');
	const api0 = loadModule(env0);
	const ICONS = api0.icons;

	check('menu.d 解析出 12 个页签', MENU_TAB_KEYS.length === 12, MENU_TAB_KEYS.join(','));
	check('图标库覆盖全部 12 个页签（无需兜底）',
		MENU_TAB_KEYS.every(function (k) { return Array.isArray(ICONS[k]) && ICONS[k].length > 0; }),
		MENU_TAB_KEYS.filter(function (k) { return !ICONS[k]; }).join(',') || '全部命中');
	check('图标库提供兜底图标', Array.isArray(ICONS._fallback) && ICONS._fallback.length > 0);
	check('图标均为合法 SVG 图元描述',
		Object.keys(ICONS).every(function (k) {
			return ICONS[k].every(function (p) { return p && typeof p.tag === 'string' && p.tag.length > 0; });
		}));

	/* ---------- 2. 纯函数 ---------- */
	check('tabKeyFromClass 提取页签名',
		api0.tabKeyFromClass('tabmenu-item-modem-settings active') === 'modem-settings' &&
		api0.tabKeyFromClass('tabmenu-item-sms-settings cbi-tab') === 'sms-settings' &&
		api0.tabKeyFromClass('tabmenu-item-status') === 'status');
	check('tabKeyFromClass 无匹配返回 null',
		api0.tabKeyFromClass('cbi-tab active') === null && api0.tabKeyFromClass('') === null);

	check('clampScrollLeft 正常夹取',
		api0.clampScrollLeft(0, 870, 840) === 840 && api0.clampScrollLeft(100, -130, 840) === 0 &&
		api0.clampScrollLeft(50, 20, 840) === 70 && api0.clampScrollLeft(0, 100, 0) === 0);

	/* ---------- 3. argon 场景：横向滚动条 + 选中项居中 + 幂等 + 点击保存 ---------- */
	{
		const env = makeEnv('/cgi-bin/luci/admin/modem/5g/logs');
		loadModule(env); // 模块加载时菜单尚未渲染 → 进入轮询等待
		const dom = buildTabmenu(env, {
			tabs: TWELVE_TABS, activeKey: 'logs', scrollable: true, contentWidth: 1200, viewWidth: 360
		});
		await sleep(200); // 轮询命中：enhance + bindEvents（与真实流程一致）
		const api = env.windowStub.AtTabmenu;

		const links = dom.strip.querySelectorAll('li a');
		const icons = dom.strip.querySelectorAll('.at-tabmenu-icon');
		check('12 个页签全部注入图标', icons.length === 12, 'icons=' + icons.length);
		check('图标位于链接文字之前（第一个子节点）',
			links.every(function (a) { return a.children[0] && a.children[0]._classes.indexOf('at-tabmenu-icon') >= 0; }));
		const svg = icons[0].children[0];
		check('SVG 规格统一（viewBox/currentColor/线帽）',
			svg.tag === 'svg' && svg.getAttribute('viewBox') === '0 0 24 24' &&
			svg.getAttribute('stroke') === 'currentColor' &&
			svg.getAttribute('stroke-linecap') === 'round' && svg.getAttribute('aria-hidden') === 'true',
			'svg=' + svg.tag + ' viewBox=' + svg.getAttribute('viewBox'));
		check('logs 页签图标为文件文本（3 个图元）',
			icons[10].children[0].children.length === 3, 'parts=' + icons[10].children[0].children.length);

		// logs 为第 11 个页签：x=1000，宽 100，视区 360 → 居中目标 870，夹取到最大值 840
		check('选中项（运行日志）被滚入可视区（居中夹取）',
			dom.strip.scrollLeft === 840, 'scrollLeft=' + dom.strip.scrollLeft);

		api.enhance();
		check('重复 enhance 不产生重复图标',
			dom.strip.querySelectorAll('.at-tabmenu-icon').length === 12);

		env.documentStub.dispatch('click', {
			target: { closest: function (s) { return s === '#tabmenu a' ? {} : null; } }
		});
		check('点击 Tab 时保存当前滚动偏移',
			env.windowStub._sessionData['at-tabmenu-scroll:/cgi-bin/luci/admin/modem/5g/logs'] === '840',
			'saved=' + env.windowStub._sessionData['at-tabmenu-scroll:/cgi-bin/luci/admin/modem/5g/logs']);
	}

	/* ---------- 4. openwrt-2020 场景：cbi-tab 激活类 ---------- */
	{
		const env = makeEnv('/cgi-bin/luci/admin/modem/5g/terminal');
		loadModule(env);
		const dom = buildTabmenu(env, {
			tabs: TWELVE_TABS, activeKey: 'terminal', activeClass: 'cbi-tab',
			scrollable: true, contentWidth: 1200, viewWidth: 360
		});
		env.windowStub.AtTabmenu.enhance();
		// terminal 为第 10 个页签：x=900，居中目标 770（未超最大值 840）
		check('cbi-tab 激活类正确识别并居中',
			dom.strip.scrollLeft === 770, 'scrollLeft=' + dom.strip.scrollLeft);
	}

	/* ---------- 5. href 兜底识别（无任何激活类） ---------- */
	{
		const env = makeEnv('/cgi-bin/luci/admin/modem/5g/config');
		loadModule(env);
		const dom = buildTabmenu(env, {
			tabs: TWELVE_TABS, activeKey: 'config', activeClass: '__none__',
			scrollable: true, contentWidth: 1200, viewWidth: 360
		});
		env.windowStub.AtTabmenu.enhance();
		// config 为第 12 个页签：x=1100，居中目标 970，夹取到 840
		check('无激活类时按 href 识别当前页并居中',
			dom.strip.scrollLeft === 840, 'scrollLeft=' + dom.strip.scrollLeft);
	}

	/* ---------- 6. sessionStorage 恢复 ---------- */
	{
		// 6a. 选中项在记忆偏移处仍完整可见 → 恢复手动偏移
		const env = makeEnv('/cgi-bin/luci/admin/modem/5g/sms');
		env.windowStub.sessionStorage.setItem('at-tabmenu-scroll:/cgi-bin/luci/admin/modem/5g/sms', '0');
		loadModule(env);
		const dom = buildTabmenu(env, { tabs: TWELVE_TABS, activeKey: 'sms', scrollable: true, contentWidth: 1200, viewWidth: 360 });
		env.windowStub.AtTabmenu.enhance();
		// sms 为第 8 个页签 x=700；记忆值 0 处 sms 位于 [700,800] 不可见 → 回退居中（570）
		check('记忆偏移处选中项不可见 → 回退居中',
			dom.strip.scrollLeft === 570, 'scrollLeft=' + dom.strip.scrollLeft);

		// 6b. 选中项靠近左侧、记忆偏移处可见 → 恢复记忆值
		const env2 = makeEnv('/cgi-bin/luci/admin/modem/5g/status');
		env2.windowStub.sessionStorage.setItem('at-tabmenu-scroll:/cgi-bin/luci/admin/modem/5g/status', '0');
		loadModule(env2);
		const dom2 = buildTabmenu(env2, {
			tabs: TWELVE_TABS, activeKey: 'status', scrollable: true, contentWidth: 1200, viewWidth: 360
		});
		env2.windowStub.AtTabmenu.enhance();
		// status x=0：居中目标为负 → 夹取 0；记忆值 0 同样可见 → 结果一致（0）
		check('选中项在记忆偏移处可见 → 恢复记忆值',
			dom2.strip.scrollLeft === 0, 'scrollLeft=' + dom2.strip.scrollLeft);

		// 6c. 区分「恢复」与「居中」：前两个页签加宽后两种策略结果不同
		const env3 = makeEnv('/cgi-bin/luci/admin/modem/5g/dial');
		loadModule(env3);
		const tabs3 = TWELVE_TABS.map(function (t, i) {
			return { name: t.name, title: t.title, width: i < 2 ? 200 : 100 };
		});
		const dom3 = buildTabmenu(env3, { tabs: tabs3, activeKey: 'dial', scrollable: true, contentWidth: 1400, viewWidth: 360 });
		env3.windowStub.AtTabmenu.enhance();
		// dial x=400，宽 100，居中目标 = 400 + 50 - 180 = 270
		check('无记忆时纯居中（dial → 270）', dom3.strip.scrollLeft === 270, 'scrollLeft=' + dom3.strip.scrollLeft);
		env3.windowStub.sessionStorage.setItem('at-tabmenu-scroll:/cgi-bin/luci/admin/modem/5g/dial', '200');
		dom3.strip.scrollLeft = 0;
		env3.windowStub.AtTabmenu.refresh();
		// 记忆值 200 处 dial 位于 [200,300] ⊂ [0,360] → 恢复 200（区别于居中的 270）
		check('记忆偏移处可见 → 恢复 200 而非居中 270',
			dom3.strip.scrollLeft === 200, 'scrollLeft=' + dom3.strip.scrollLeft);
	}

	/* ---------- 7. 换行场景（bootstrap/material）：条不可滚动 ---------- */
	{
		const env = makeEnv('/cgi-bin/luci/admin/modem/5g/scan');
		loadModule(env);
		const dom = buildTabmenu(env, {
			tabs: TWELVE_TABS, activeKey: 'scan', scrollable: false, contentWidth: 1200, viewWidth: 1200
		});
		env.windowStub.AtTabmenu.enhance();
		check('换行布局不产生横向滚动', dom.strip.scrollLeft === 0, 'scrollLeft=' + dom.strip.scrollLeft);
		check('换行布局图标照常注入', dom.strip.querySelectorAll('.at-tabmenu-icon').length === 12);
	}

	/* ---------- 8. 异步渲染：初始无 #tabmenu，轮询渲染后自动增强 ---------- */
	{
		const env = makeEnv('/cgi-bin/luci/admin/modem/5g/config');
		loadModule(env); // 此时 #tabmenu 尚不存在 → 轮询等待
		check('菜单未渲染时不报错（初始无图标）',
			env.documentStub.getElementById('tabmenu') === null);

		buildTabmenu(env, {
			tabs: TWELVE_TABS, activeKey: 'config', scrollable: true, contentWidth: 1200, viewWidth: 360
		});
		await sleep(200); // 轮询间隔 50ms
		const strip = env.documentStub.getElementById('tabmenu').querySelector('ul');
		check('轮询命中后自动注入图标', strip.querySelectorAll('.at-tabmenu-icon').length === 12);
		check('轮询命中后选中项居中', strip.scrollLeft === 840, 'scrollLeft=' + strip.scrollLeft);
	}

	/* ---------- 9. 非本插件页面守卫 ---------- */
	{
		const env = makeEnv('/cgi-bin/luci/admin/status/overview');
		loadModule(env);
		const dom = buildTabmenu(env, {
			tabs: TWELVE_TABS, activeKey: 'status', scrollable: true, contentWidth: 1200, viewWidth: 360
		});
		await sleep(200);
		check('其他 LuCI 页面不注入图标（零副作用）',
			dom.strip.querySelectorAll('.at-tabmenu-icon').length === 0);
		check('其他 LuCI 页面不修改滚动位置', dom.strip.scrollLeft === 0);
	}

	/* ---------- 10. 未知页签兜底图标 ---------- */
	{
		const env = makeEnv('/cgi-bin/luci/admin/modem/5g/future');
		loadModule(env);
		const dom = buildTabmenu(env, {
			tabs: [{ name: 'future', title: '未来功能' }, { name: 'status', title: '网络状态' }],
			activeKey: 'future', scrollable: true, contentWidth: 200, viewWidth: 100
		});
		env.windowStub.AtTabmenu.enhance();
		const icons = dom.strip.querySelectorAll('.at-tabmenu-icon');
		check('未知页签走兜底图标（同心圆）',
			icons.length === 2 && icons[0].children[0].children.length === 2 &&
			icons[0].children[0].children[0].tag === 'circle',
			'parts=' + icons[0].children[0].children.length);
	}

	/* ---------- 11. 主题 Tab 栏对比度兜底（issue #26） ---------- */
	{
		/* 加载真实 theme.js 作为 themeUtil（与浏览器 require 链一致） */
		const themeSrc = fs.readFileSync(path.join(libDir, 'theme.js'), 'utf8');
		const themeFactory = new Function('L', 'document', 'window',
			themeSrc);
		const L_THEME = { Class: { extend: function (o) { return function () { Object.assign(this, o); }; } } };

		function makeContrastEnv(linkColor, stripBg) {
			const env = makeEnv('/cgi-bin/luci/admin/modem/5g/logs');
			env.documentStub.documentElement = { nodeType: 1, parentNode: null };
			env.windowStub.AtTheme = new (themeFactory(L_THEME, env.documentStub, env.windowStub))();
			const api = loadModule(env); // 求值即挂 window.AtTabmenu，返回实例
			const dom = buildTabmenu(env, {
				tabs: [{ name: 'status', title: '网络状态' }, { name: 'logs', title: '运行日志' }],
				activeKey: 'logs', scrollable: false
			});
			const firstLi = dom.strip.children[0]; // 首个未选中项的 li
			const a = firstLi.children[0];
			a._computed = { color: linkColor };
			dom.strip._computed = { overflowX: 'visible', backgroundColor: stripBg };
			return { env: env, dom: dom, api: api };
		}

		/* Argon 2.x 暗色：深灰字挂在深底上，对比度不足 → 需要提亮 */
		{
			const c = makeContrastEnv('#404040', 'rgb(24, 24, 25)');
			const link = c.api.firstInactiveLink(c.dom.tabmenu);
			check('对比度兜底: 识别首个未选中 Tab', !!link);
			check('对比度兜底: 深底深字判定需修复', c.api.tabNeedsFix(link, c.env.windowStub, c.env.windowStub.AtTheme),
				'fg=#404040 bg=rgb(24,24,25)');
		}
		/* 亮色主题：深灰字挂白底，对比度充足 → 零改动 */
		{
			const c = makeContrastEnv('#404040', 'rgb(255, 255, 255)');
			const link = c.api.firstInactiveLink(c.dom.tabmenu);
			check('对比度兜底: 白底深字无需修复', !c.api.tabNeedsFix(link, c.env.windowStub, c.env.windowStub.AtTheme));
		}
		/* 端到端：enhance + 对比度检查后按对比度给容器加/不加 .at-tabmenu-fix */
		{
			const c = makeContrastEnv('#404040', 'rgb(24, 24, 25)');
			c.api.enhance();
			c.api.checkTabContrast();
			check('对比度兜底: 暗色场景容器挂 .at-tabmenu-fix',
				c.dom.tabmenu.classList.contains('at-tabmenu-fix'));
		}
		{
			const c = makeContrastEnv('#404040', 'rgb(255, 255, 255)');
			c.api.enhance();
			c.api.checkTabContrast();
			check('对比度兜底: 亮色场景容器零改动',
				!c.dom.tabmenu.classList.contains('at-tabmenu-fix'));
		}
	}

	/* ---------- 12. 窄屏悬浮菜单（Vantage 结构 / 无 #tabmenu） ---------- */
	{
		/* 构造 nav#vt-tabs > .vt-pagetabs > a.vt-tab（ImmortalWrt Vantage 等新主题） */
		function buildVantage(env, opts) {
			const doc = env.documentStub;
			const nav = doc.createElement('nav');
			nav.setAttribute('id', 'vt-tabs');
			nav.setAttribute('class', 'vt-tabs');
			const strip = doc.createElement('div');
			strip.setAttribute('class', 'vt-pagetabs');
			opts.tabs.forEach(function (t) {
				const a = doc.createElement('a');
				a.setAttribute('class', 'vt-tab');
				a.setAttribute('href', '/cgi-bin/luci/admin/modem/5g/' + t.name);
				if (t.name === opts.activeKey) a.setAttribute('aria-current', 'page');
				a.appendChild(doc.createTextNode(t.title));
				strip.appendChild(a);
			});
			nav.appendChild(strip);
			doc.body.appendChild(nav);
			return { nav: nav, strip: strip };
		}

		/* 模拟窄屏：matchMedia 命中，可随时改 matches 模拟旋转/拉宽 */
		function goMobile(env) {
			const mq = {
				matches: true,
				addEventListener: function () {}, removeEventListener: function () {},
				addListener: function () {}, removeListener: function () {}
			};
			env.windowStub.innerWidth = 390;
			env.windowStub.matchMedia = function () { return mq; };
			return mq;
		}

		check('tabKeyFromHref 从地址末段取页签名',
			api0.tabKeyFromHref('/cgi-bin/luci/admin/modem/5g/modem-settings') === 'modem-settings' &&
			api0.tabKeyFromHref('/cgi-bin/luci/admin/modem/5g/status/') === 'status' &&
			api0.tabKeyFromHref('/cgi-bin/luci/admin/status/overview') === null);

		/* 12a. 窄屏：构建触发器 + 浮层，原生 Tab 条保持原样 */
		const envM = makeEnv('/cgi-bin/luci/admin/modem/5g/status');
		const mq = goMobile(envM);
		const domM = buildVantage(envM, { tabs: TWELVE_TABS, activeKey: 'status' });
		/* 先建 DOM 再加载模块：init 一次命中并绑定事件（与真实加载顺序一致） */
		const apiM = loadModule(envM);
		apiM.enhance();

		check('窄屏: body 挂 .at-tabmenu-mobile', envM.documentStub.body.classList.contains('at-tabmenu-mobile'));
		const wrapM = domM.nav.querySelector('.at-tabmenu-float');
		check('窄屏: 触发器挂在原生 Tab 条之前',
			!!wrapM && domM.nav.children[0] === wrapM);
		const triggerM = wrapM && wrapM.querySelector('.at-tabmenu-trigger');
		const panelM = wrapM && wrapM.querySelector('.at-tabmenu-panel');
		check('窄屏: 触发器/浮层均生成', !!triggerM && !!panelM);
		check('窄屏: 浮层默认收起（hidden + aria-expanded=false）',
			panelM.getAttribute('hidden') !== null && triggerM.getAttribute('aria-expanded') === 'false');
		check('窄屏: 浮层条目与原 Tab 一一对应（12 条）',
			panelM.querySelectorAll('a.at-tabmenu-panel-item').length === 12,
			'n=' + panelM.querySelectorAll('a.at-tabmenu-panel-item').length);
		check('窄屏: 条目文字沿用原 Tab 标题',
			panelM.querySelectorAll('a.at-tabmenu-panel-item')[10].textContent === '运行日志');
		check('窄屏: 当前页条目标记 is-active + aria-current',
			panelM.querySelectorAll('a.at-tabmenu-panel-item')[0].classList.contains('is-active') &&
			panelM.querySelectorAll('a.at-tabmenu-panel-item')[0].getAttribute('aria-current') === 'page' &&
			panelM.querySelectorAll('a.at-tabmenu-panel-item')[1].getAttribute('aria-current') === 'false');
		check('窄屏: 触发器显示当前页标题与页签总数',
			triggerM.querySelector('.at-tabmenu-trigger-label').textContent === '网络状态' &&
			triggerM.querySelector('.at-tabmenu-trigger-count').textContent === '12');
		check('窄屏: 不给 Vantage 原生 Tab 注入图标（桌面观感零改动）',
			domM.strip.querySelectorAll('.at-tabmenu-icon').length === 0);

		/* 12b. 点击展开 / 再点收起 */
		triggerM.dispatch('click', { preventDefault: function () {} });
		check('窄屏: 点击触发器展开浮层',
			panelM.getAttribute('hidden') === null &&
			triggerM.getAttribute('aria-expanded') === 'true' &&
			wrapM.classList.contains('is-open'));
		triggerM.dispatch('click', { preventDefault: function () {} });
		check('窄屏: 再次点击收起浮层',
			panelM.getAttribute('hidden') !== null && triggerM.getAttribute('aria-expanded') === 'false');

		/* 12c. Esc 收起并回焦触发器 */
		triggerM.dispatch('click', { preventDefault: function () {} });
		envM.documentStub.dispatch('keydown', { key: 'Escape' });
		check('窄屏: Esc 收起浮层并把焦点交还触发器',
			panelM.getAttribute('hidden') !== null && triggerM._focused === true);

		/* 12d. 点击外部收起 */
		triggerM.dispatch('click', { preventDefault: function () {} });
		envM.documentStub.dispatch('click', { target: { closest: function () { return null; } } });
		check('窄屏: 点击浮层外部收起', panelM.getAttribute('hidden') !== null);

		/* 12e. 点击浮层条目后收起（随后由浏览器正常跳转） */
		triggerM.dispatch('click', { preventDefault: function () {} });
		const itemM = panelM.querySelectorAll('a.at-tabmenu-panel-item')[1];
		panelM.dispatch('click', { target: itemM });
		check('窄屏: 选中条目后浮层收起', panelM.getAttribute('hidden') !== null);

		/* 12f. 拉宽到桌面：悬浮菜单销毁，原生 Tab 条恢复可用 */
		mq.matches = false;
		apiM.enhance();
		check('桌面: 悬浮菜单被销毁且 body 类摘除',
			domM.nav.querySelector('.at-tabmenu-float') === null &&
			!envM.documentStub.body.classList.contains('at-tabmenu-mobile'));
		check('桌面: 原生 Vantage Tab 条仍在且未注入图标',
			domM.strip.querySelectorAll('a.vt-tab').length === 12 &&
			domM.strip.querySelectorAll('.at-tabmenu-icon').length === 0);

		/* 12g. 一直处于桌面宽度：完全不构建悬浮菜单 */
		const envD = makeEnv('/cgi-bin/luci/admin/modem/5g/status');
		const apiD = loadModule(envD);
		const domD = buildVantage(envD, { tabs: TWELVE_TABS, activeKey: 'status' });
		apiD.enhance();
		check('桌面: 不生成悬浮菜单（零副作用）',
			domD.nav.querySelector('.at-tabmenu-float') === null &&
			!envD.documentStub.body.classList.contains('at-tabmenu-mobile'));

		/* 12h. #tabmenu 系主题在窄屏下也走同一套悬浮菜单 */
		const envL = makeEnv('/cgi-bin/luci/admin/modem/5g/logs');
		goMobile(envL);
		const apiL = loadModule(envL);
		const domL = buildTabmenu(envL, { tabs: TWELVE_TABS, activeKey: 'logs', scrollable: false });
		apiL.enhance();
		check('窄屏: #tabmenu 系同样生成悬浮菜单',
			!!domL.tabmenu.querySelector('.at-tabmenu-float') &&
			envL.documentStub.body.classList.contains('at-tabmenu-mobile'));
		check('窄屏: #tabmenu 系浮层复用已注入的图标',
			domL.tabmenu.querySelector('.at-tabmenu-float').querySelectorAll('.at-tabmenu-icon').length === 12);
	}

	/* ---------- 汇总 ---------- */
	const failed = results.filter(function (r) { return !r.ok; });
	console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL ' + results.length + ' PASSED'));
	if (failed.length) {
		failed.forEach(function (r) { console.log('  ✗ ' + r.name + '  ' + r.detail); });
		process.exitCode = 1;
	}
})().catch(function (e) {
	console.error('测试执行异常:', e);
	process.exitCode = 1;
});
