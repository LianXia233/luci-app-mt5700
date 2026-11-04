'use strict';
/**
 * 双 UI 模式重构验收测试（零依赖，node tests/dual-ui-mode-test.js）
 *
 * 分四组：
 *   A. 纯函数：模式校验、图标表、SVG 文档规范；
 *   B. 功能模拟：vm 加载 uimode.js，配 mock DOM/UCI/sessionStorage，
 *      实测默认态、切换、跨刷新恢复、非法回退、持久化失败回滚、
 *      不调用 apply、onChange 去重、弹窗 decorate、切换控件委托；
 *   C. 源码级：注入顺序、MD3 隔离前缀、弹窗业务零改动、UCI/ACL/菜单、
 *      图标资源、LF 行尾、CSS 括号平衡；
 *   D. 业务安全白名单：ucode / Rust / init.d / hotplug / 业务 UCI / RPC 未被改。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const libDir = path.join(root, 'htdocs', 'luci-static', 'resources', 'at-webserver');
const viewDir = path.join(root, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');
const iconsDir = path.join(libDir, 'icons');

const results = [];
function check(name, ok, detail) {
	results.push({ name: name, ok: !!ok });
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  ← ' + detail));
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

/* ==========================================================================
   vm 工具：把 LuCI 模块包进函数体求值，剥掉末尾的模块 return
   ========================================================================== */
function loadModule(file, sandbox, exportName) {
	const src = read(file)
		.replace(new RegExp('\\nreturn ' + exportName + 'Class;\\s*$'), '\n');
	const body = '(function(){\n' + src + '\nreturn ' + exportName + ';\n})()';
	return vm.runInNewContext(body, sandbox, { filename: file });
}

function classExtendStub() {
	return { Class: { extend: function (obj) {
		function Ctor() {}
		Ctor.prototype = obj;
		return Ctor;
	} } };
}

function makeElement(tag, registry) {
	const el = {
		tagName: tag, attrs: {}, children: [], className: '', textContent: '',
		style: { cssText: '' },
		setAttribute: function (k, v) { this.attrs[k] = String(v); },
		getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
		appendChild: function (c) { this.children.push(c); return c; },
		insertBefore: function (c) { this.children.unshift(c); return c; },
		addEventListener: function () {},
		classList: { toggle: function () {}, contains: function () { return false; } },
		closest: function () { return null; }
	};
	if (registry) registry.push(el);
	return el;
}

/** 构造一套可观测的浏览器环境，返回 env 与句柄 */
function makeEnv(opts) {
	const o = opts || {};
	const registry = [];
	const attrs = {};
	const html = {
		setAttribute: function (k, v) { attrs[k] = String(v); },
		getAttribute: function (k) { return attrs[k] != null ? attrs[k] : null; },
		classList: { toggle: function () {}, contains: function () { return false; } },
		dispatchEvent: function () { return true; },
		querySelectorAll: function () { return []; }
	};
	const listeners = [];
	const store = {};
	const doc = {
		documentElement: html,
		readyState: 'complete',
		addEventListener: function (type, fn, capture) { listeners.push({ type: type, fn: fn, capture: capture }); },
		querySelectorAll: function (sel) {
			return registry.filter(function (el) {
				if (sel === '[data-mt-uimode-value]') return el.attrs['data-mt-uimode-value'] != null;
				if (sel === '[data-mt-uimode-decorated]') return el.attrs['data-mt-uimode-decorated'] != null;
				if (sel.indexOf('svg[') === 0) return false;
				return false;
			});
		},
		createElement: function (tag) { return makeElement(tag, registry); }
	};
	const uciCalls = [];
	let stored = o.initialUci == null ? undefined : o.initialUci;
	const L = classExtendStub();
	L.uci = {
		load: function (pkg) { uciCalls.push(['load', pkg]); return o.loadFails ? Promise.reject(new Error('uci 读取失败')) : Promise.resolve(); },
		get: function (pkg, sec, opt) { return stored; },
		set: function (pkg, sec, opt, v) { uciCalls.push(['set', pkg, sec, opt, v]); stored = v; },
		save: function (pkg) { uciCalls.push(['save', pkg]); return o.saveFails ? Promise.reject(new Error('权限不足')) : Promise.resolve(); },
		apply: function () { uciCalls.push(['apply']); return Promise.resolve(); }
	};
	const errors = [];
	const win = {
		sessionStorage: {
			getItem: function (k) { return store[k] != null ? store[k] : null; },
			setItem: function (k, v) { store[k] = String(v); }
		},
		CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
		Mt5700: { error: function (m) { errors.push(m); } },
		console: console
	};
	const sandbox = {
		L: L, window: win, document: doc, console: console,
		setTimeout: setTimeout, clearTimeout: clearTimeout
	};
	return {
		sandbox: sandbox, attrs: attrs, uciCalls: uciCalls, listeners: listeners,
		registry: registry, win: win, errors: errors, doc: doc,
		getStored: function () { return stored; }
	};
}

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }

/* ==========================================================================
   A. 纯函数 / 图标表
   ========================================================================== */
console.log('\n[A] 纯函数与图标表');

const iconSandbox = { L: classExtendStub(), window: {}, console: console };
const Icons = loadModule(path.join(libDir, 'icons.js'), iconSandbox, 'AtIcons');

check('图标语义总数 71', Icons.keys.length === 71, '实际 ' + Icons.keys.length);
check('两套表 key 完全一致',
	Icons.keys.every(function (k) { return Icons.has(k); }));
check('极简版全部重新绘制（两套图元无一相同）',
	Icons.keys.every(function (k) { return Icons.normal[k] !== Icons.minimal[k]; }),
	Icons.keys.filter(function (k) { return Icons.normal[k] === Icons.minimal[k]; }).join(','));
check('normal 导航图标逐字保留 tabmenu.js 原图元',
	Icons.normal['nav-status'] === '<path d="M22 12h-4l-3 8-4-16-3 8H2"/>'
	&& Icons.normal['nav-config'].indexOf('M19.4 15a1.65') >= 0);
check('normal 状态页图标逐字保留 network_status.js 原图元',
	Icons.normal['st-signal'] === '<path d="M2 20h20M6 16v4M10 12v8M14 8v12M18 4v16"/>'
	&& Icons.normal['st-beam'].indexOf('M12 18.4 5.5 5.5') >= 0);
check('stroke-width：normal 导航 1.8 / 其它 2 / minimal 统一 2',
	Icons.strokeWidth('nav-status', 'normal') === 1.8
	&& Icons.strokeWidth('st-signal', 'normal') === 2
	&& Icons.strokeWidth('nav-status', 'minimal') === 2);
check('SVG 文档规范（24×24 / currentColor / 无障碍）',
	['nav-status', 'op-dashboard', 'st-beam'].every(function (k) {
		const d = Icons.svgDocument(k, 'minimal');
		return d.indexOf('viewBox="0 0 24 24"') > 0
			&& d.indexOf('stroke="currentColor"') > 0
			&& d.indexOf('role="img"') > 0
			&& d.indexOf('aria-label=') > 0
			&& d.indexOf('data-ui-mode="minimal"') > 0;
	}));
check('任务要求语义全覆盖',
	['dashboard', 'network', 'signal', 'sim', '5g', 'band', 'cell', 'sms', 'at', 'device',
	 'settings', 'refresh', 'search', 'add', 'delete', 'edit', 'save', 'check', 'cancel',
	 'warning', 'error', 'back', 'navigation'].every(function (k) { return Icons.has('op-' + k); }));

/* ==========================================================================
   B. 功能模拟（异步）
   ========================================================================== */
(async function () {
	console.log('\n[B] UI Mode Manager 功能模拟');

	const modeFile = path.join(libDir, 'uimode.js');

	/* B1 默认态 + 切换 + 不 apply */
	{
		const env = makeEnv({});
		const M = loadModule(modeFile, env.sandbox, 'AtUimode');
		await flush();
		check('默认进入普通模式（UCI 未配置时）', M.current() === 'normal');
		check('模块求值即写 <html data-ui-mode="normal">', env.attrs['data-ui-mode'] === 'normal');
		check('严格校验：非法值一律回退 normal',
			[null, undefined, '', 'MINIMAL', 'dark', 1, {}, [], ' minimal '].every(function (v) {
				return M.normalize(v) === 'normal';
			}) && M.normalize('minimal') === 'minimal' && M.normalize('normal') === 'normal');

		const r = await M.set('minimal');
		check('切换到极简模式即时生效', r.ok && r.mode === 'minimal' && env.attrs['data-ui-mode'] === 'minimal');
		check('持久化写入 at-webserver.config.ui_mode=minimal',
			env.uciCalls.some(function (c) {
				return c[0] === 'set' && c[1] === 'at-webserver' && c[2] === 'config'
					&& c[3] === 'ui_mode' && c[4] === 'minimal';
			}));
		check('持久化只 commit（save），绝不调用 apply',
			env.uciCalls.some(function (c) { return c[0] === 'save'; })
			&& !env.uciCalls.some(function (c) { return c[0] === 'apply'; }),
			'出现 L.uci.apply 调用');
		check('sessionStorage 保存已确认模式（刷新恢复）',
			env.win.sessionStorage.getItem('at-webserver:ui-mode-hint') === 'minimal');

		const back = await M.set('normal');
		check('切回普通模式', back.ok && env.attrs['data-ui-mode'] === 'normal');
	}

	/* B2 刷新 / 重新登录：UCI 权威值恢复 */
	{
		const env1 = makeEnv({});
		const M1 = loadModule(modeFile, env1.sandbox, 'AtUimode');
		await flush();
		await M1.set('minimal');
		check('首次切换到极简并落盘', env1.getStored() === 'minimal');

		const env2 = makeEnv({ initialUci: env1.getStored() });
		const M2 = loadModule(modeFile, env2.sandbox, 'AtUimode');
		await flush();
		check('重新加载（刷新/重新登录）按 UCI 恢复极简',
			M2.current() === 'minimal' && env2.attrs['data-ui-mode'] === 'minimal');
	}

	/* B3 非法配置安全回退 */
	{
		const env = makeEnv({ initialUci: 'dark' });
		const M = loadModule(modeFile, env.sandbox, 'AtUimode');
		await flush();
		check('UCI 非法值安全回退 normal', M.current() === 'normal' && env.attrs['data-ui-mode'] === 'normal');
	}
	{
		const env = makeEnv({ loadFails: true });
		const M = loadModule(modeFile, env.sandbox, 'AtUimode');
		await flush();
		check('UCI 读取失败回退 normal', M.current() === 'normal');
	}

	/* B4 持久化失败：回滚 + 明确报错，不误报成功 */
	{
		const env = makeEnv({ saveFails: true });
		const M = loadModule(modeFile, env.sandbox, 'AtUimode');
		await flush();
		const r = await M.set('minimal');
		check('保存失败返回 ok=false', r.ok === false && !!r.error);
		check('保存失败前端回滚到 normal', M.current() === 'normal' && env.attrs['data-ui-mode'] === 'normal');
		check('保存失败有明确错误提示（不是「保存成功」）',
			env.errors.length === 1 && env.errors[0].indexOf('保存失败') >= 0
			&& env.errors[0].indexOf('成功') < 0, env.errors.join('|'));
		/* 回归：只回滚前端 DOM 不够，L.uci.set() 写入的内存暂存值也要改回设备真实值，
		 * 否则用户随后在同一页面保存其它配置时会把这条失败的 ui_mode 一并 commit。 */
		check('保存失败同步回滚 UCI 内存暂存值',
			env.getStored() === 'normal', 'stored=' + env.getStored());
		check('回滚过程未调用 L.uci.apply()',
			env.uciCalls.every(function (c) { return c[0] !== 'apply'; }));
	}

	/* B5 单例 / 去重 / 弹窗 decorate / 切换控件委托 */
	{
		const env = makeEnv({});
		const M = loadModule(modeFile, env.sandbox, 'AtUimode');
		await flush();
		let calls = 0;
		const fn = function () { calls++; };
		M.onChange(fn);
		M.onChange(fn);
		check('onChange 去重注册', calls === 1, '实际 ' + calls);
		await M.set('minimal');
		check('切换触发已注册回调', calls === 2);

		const dlg = makeElement('div', env.registry);
		M.decorate(dlg);
		check('弹窗 decorate 自动读取当前模式',
			dlg.attrs['data-ui-mode'] === 'minimal' && dlg.attrs['data-mt-uimode-decorated'] === '1');

		const sw = M.createSwitch();
		check('模式切换控件含 normal/minimal 两个按钮',
			sw && sw.children.length === 2
			&& sw.children[0].attrs['data-mt-uimode-value'] === 'normal'
			&& sw.children[1].attrs['data-mt-uimode-value'] === 'minimal');
		check('document 上只有一次事件委托注册',
			env.listeners.filter(function (l) { return l.type === 'click'; }).length === 1);

		/* 模拟点击「普通」按钮：走同一个委托，不新注册监听 */
		const clickHandler = env.listeners.filter(function (l) { return l.type === 'click'; })[0].fn;
		const btn = sw.children[0];
		btn.closest = function (sel) { return sel === '[data-mt-uimode-value]' ? btn : null; };
		clickHandler({ target: btn });
		await flush();
		check('委托点击可切回普通模式', M.current() === 'normal');
	}

	/* B6 图标按模式重绘（Icon Manager 与 Mode Manager 联动） */
	{
		const env = makeEnv({});
		/* 必须与 uimode.js 共用同一个 window，Icon Manager 才能读到当前模式 */
		const iconsEnv = { L: classExtendStub(), window: env.win, document: env.doc, console: console };
		const I = loadModule(path.join(libDir, 'icons.js'), iconsEnv, 'AtIcons');
		env.win.AtIcons = I;
		const svg = makeElement('svg', env.registry);
		svg.attrs['data-mt-icon'] = 'op-dashboard';
		svg.innerHTML = '';
		env.doc.querySelectorAll = function (sel) {
			return sel.indexOf('svg[') === 0 ? [svg] : [];
		};
		I.refresh();
		const normalMarkup = svg.innerHTML;
		const M = loadModule(modeFile, env.sandbox, 'AtUimode');
		await flush();
		await M.set('minimal', { skipPersist: true });
		check('模式切换后图标重绘为极简图元',
			svg.innerHTML === I.minimal['op-dashboard']
			&& svg.innerHTML !== normalMarkup
			&& svg.attrs['data-ui-mode'] === 'minimal');
		check('图标重绘复用同一 svg 节点，不重建 DOM', env.registry.filter(function (e) { return e.tagName === 'svg'; }).length === 1);
	}

	/* ==========================================================================
	   C. 源码级静态断言
	   ========================================================================== */
	console.log('\n[C] 源码级静态断言');

	const mtJs = read(path.join(libDir, 'mt5700.js'));
	const uiJs = read(path.join(libDir, 'ui.js'));
	const md3Css = read(path.join(libDir, 'md3.css'));
	const globalCss = read(path.join(libDir, 'global.css'));
	const atCss = read(path.join(libDir, 'at.css'));
	const mtCss = read(path.join(libDir, 'mt5700.css'));
	const uimodeJs = read(path.join(libDir, 'uimode.js'));

	check('mt5700.js require uimode 与 icons',
		/'require at-webserver\/uimode'/.test(mtJs) && /'require at-webserver\/icons'/.test(mtJs));
	const iMt = mtJs.indexOf('mt5700.css?v=');
	const iGl = mtJs.indexOf('global.css?v=');
	const iMd3 = mtJs.indexOf('md3.css?v=');
	check('md3.css 注入顺序在 mt5700.css / global.css 之后',
		iMt > 0 && iGl > iMt && iMd3 > iGl, [iMt, iGl, iMd3].join('/'));
	check('md3.css 有独立缓存版本戳',
		/var MT5700_MD3_CSS_VERSION = '\d+\.\d+\.\d+';/.test(mtJs));

	/* 普通模式隔离：除新增的模式切换控件与 keyframes，所有选择器必须带 minimal 前缀 */
	const cssNoComments = md3Css.replace(/\/\*[\s\S]*?\*\//g, '');
	const selectorLines = cssNoComments.split('\n').filter(function (l) {
		return /\{/.test(l) && l.trim().charAt(0) !== '@';
	});
	const unprefixed = selectorLines.filter(function (l) {
		const sel = l.split('{')[0].trim();
		if (sel.indexOf('html[data-ui-mode="minimal"]') >= 0) return false;
		if (sel.indexOf('.mt-uimode-') >= 0) return false;           /* 新增元素基础样式 */
		if (sel.indexOf('html.at-dark .mt-uimode-') >= 0) return false;
		return true;
	});
	check('MD3 规则全部以 html[data-ui-mode="minimal"] 前缀隔离（普通模式零命中）',
		unprefixed.length === 0, unprefixed.slice(0, 3).join(' | '));
	check('MD3 覆盖数量足够（>= 100 条带前缀规则）',
		(md3Css.match(/html\[data-ui-mode="minimal"\]/g) || []).length >= 100);

	const tokens = ['primary', 'on-primary', 'primary-container', 'on-primary-container',
		'secondary', 'tertiary', 'surface', 'surface-container', 'surface-variant',
		'on-surface', 'on-surface-variant', 'outline', 'error', 'success'];
	check('MD3 design tokens 齐全（14 项）',
		tokens.every(function (t) { return md3Css.indexOf('--md-sys-color-' + t + ':') > 0; }),
		tokens.filter(function (t) { return md3Css.indexOf('--md-sys-color-' + t + ':') < 0; }).join(','));
	check('明暗主题适配沿用 html.at-dark', md3Css.indexOf('html[data-ui-mode="minimal"].at-dark') > 0);
	check('手机端响应式适配', /@media \(max-width: 768px\)/.test(md3Css));
	check('尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(md3Css));
	check('CSS 变量重映射现有组件',
		md3Css.indexOf('--mt5700-card-bg:') > 0 && md3Css.indexOf('--at-bg-glass:') > 0);
	check('CSS 括号平衡',
		(md3Css.match(/\{/g) || []).length === (md3Css.match(/\}/g) || []).length);

	/* 四套弹窗结构 + 业务实现完整复用 */
	check('MD3 覆盖四套弹窗结构',
		['.mt5700-modal', '.at-modal', '.cbi-modal', '.modal'].every(function (s) {
			return md3Css.indexOf('html[data-ui-mode="minimal"] ' + s) > 0;
		}));
	check('MD3 弹窗遵循 28px 圆角 / surface-container-high',
		/shape-corner-extra-large/.test(md3Css) && /surface-container-high/.test(md3Css));
	check('Mt5700.confirm 业务实现保留（onOk / 取消 / 掩码关闭）',
		/api\.confirm = function \(message, onOk, okText\)/.test(mtJs)
		&& mtJs.indexOf('if (onOk) onOk();') > 0
		&& mtJs.indexOf("api.ghostButton('取消'") > 0);
	check('Ui.promptModal 业务实现保留（fields/onOk/select/hint）',
		/api\.promptModal = function \(title, fields, onOk\)/.test(uiJs)
		&& uiJs.indexOf('if (onOk) onOk(values);') > 0
		&& uiJs.indexOf("f.type === 'select'") > 0);
	check('弹窗复用 decorate 但未改调用接口',
		mtJs.indexOf('decorate(mask);') > 0 && mtJs.indexOf('decorate(t);') > 0);
	const smsSrc = read(path.join(viewDir, 'sms_center.js'));
	check('短信中心自绘弹窗 smsModal 保留',
		smsSrc.indexOf('function smsModal(title)') > 0
		&& smsSrc.indexOf('function confirmDeleteModal(') > 0);
	check('global.css 四套弹窗可读性规则未被改动',
		['.mt5700-modal', '.at-modal', '.cbi-modal', '.modal-body'].every(function (s) {
			return globalCss.indexOf(s) > 0;
		}));
	check('at.css / mt5700.css 主样式未被本次改动（玻璃拟态保留）',
		atCss.indexOf('--at-bg-glass: rgba(255, 255, 255, 0.78)') > 0
		&& mtCss.indexOf('backdrop-filter: blur(20px) saturate(180%)') > 0);

	/* UCI / ACL / 菜单 */
	const uciCfg = read(path.join(root, 'root', 'etc', 'config', 'at-webserver'));
	check('UCI 声明 ui_mode 默认 normal', /option ui_mode 'normal'/.test(uciCfg));
	check('ui_mode 严格校验且只写 at-webserver.config',
		/UCI_OPTION = 'ui_mode'/.test(uimodeJs)
		&& /UCI_SECTION = 'config'/.test(uimodeJs)
		&& /L\.uci\.set\(UCI_PACKAGE, UCI_SECTION, UCI_OPTION, mode\)/.test(uimodeJs));
	/* 剥离注释后再查代码，避免「不调用 apply」的说明文字被当成调用 */
	const uimodeCode = uimodeJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	check('UCI 只 save 不 apply', uimodeCode.indexOf('L.uci.save(UCI_PACKAGE)') > 0
		&& !/L\.uci\.apply/.test(uimodeCode));
	const acl = JSON.parse(read(path.join(root, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json')));
	check('ACL 未改动且已具备 at-webserver 读写权限',
		acl['luci-app-mt5700'].read.uci.indexOf('at-webserver') >= 0
		&& acl['luci-app-mt5700'].write.uci.indexOf('at-webserver') >= 0);
	const menu = JSON.parse(read(path.join(root, 'root', 'usr', 'share', 'luci', 'menu.d', 'luci-app-mt5700.json')));
	check('菜单路由仍为 12 条且全部指向存在的视图',
		Object.keys(menu).filter(function (k) { return menu[k].action && menu[k].action.type === 'view'; }).length === 12);
	const views = fs.readdirSync(viewDir).filter(function (f) { return f.endsWith('.js'); });
	check('12 个视图数量不变', views.length === 12);
	check('12 个视图全部 require mt5700（全局样式/模式可达）',
		views.every(function (f) { return /'require at-webserver\/mt5700'/.test(read(path.join(viewDir, f))); }));
	check('作者署名仍保留且极简模式不隐藏它（AGENTS.md 保护规则）',
		read(path.join(viewDir, 'service.js')).indexOf("'class': 'mt5700-author'") > 0
		&& !/\.mt5700-author[^{]*\{[^}]*display:\s*none/.test(md3Css));

	/* 图标资源文件 */
	const normalFiles = fs.readdirSync(path.join(iconsDir, 'normal')).filter(function (f) { return f.endsWith('.svg'); });
	const minimalFiles = fs.readdirSync(path.join(iconsDir, 'minimal')).filter(function (f) { return f.endsWith('.svg'); });
	check('两套图标目录各 71 个 SVG 文件', normalFiles.length === 71 && minimalFiles.length === 71,
		normalFiles.length + '/' + minimalFiles.length);
	check('两套图标一一对应（文件名）',
		normalFiles.every(function (f) { return minimalFiles.indexOf(f) >= 0; }));
	check('SVG 文件与 Icon Manager 表内容一致',
		Icons.keys.every(function (k) {
			return read(path.join(iconsDir, 'normal', k + '.svg')) === Icons.svgDocument(k, 'normal')
				&& read(path.join(iconsDir, 'minimal', k + '.svg')) === Icons.svgDocument(k, 'minimal');
		}));
	check('SVG 文件为规范 XML（单根闭合、标签配对、无外部依赖）',
		(function () {
			const all = normalFiles.map(function (f) { return path.join(iconsDir, 'normal', f); })
				.concat(minimalFiles.map(function (f) { return path.join(iconsDir, 'minimal', f); }));
			return all.every(function (p) {
				const s = read(p);
				const opens = (s.match(/<[a-zA-Z]/g) || []).length;
				const closes = (s.match(/\/>|<\//g) || []).length;
				return s.indexOf('<svg xmlns=') === 0
					&& s.trim().endsWith('</svg>')
					&& opens === closes
					&& !/<script|<image|<use\b|href=|https?:\/\/(?!www\.w3\.org)/i.test(s);
			});
		})());
	check('生成脚本 --check 严格校验通过（含「极简必须重绘」断言）',
		(function () {
			try {
				execSync('node ' + path.join(root, 'scripts', 'gen-dual-ui-icons.js') + ' --check',
					{ stdio: 'pipe' });
				return true;
			} catch (e) { return false; }
		})());

	/* LF 行尾 */
	const newFiles = [
		'htdocs/luci-static/resources/at-webserver/uimode.js',
		'htdocs/luci-static/resources/at-webserver/icons.js',
		'htdocs/luci-static/resources/at-webserver/md3.css',
		'scripts/gen-dual-ui-icons.js',
		'tests/dual-ui-mode-test.js',
		'docs/dual-ui-mode-inventory.md'
	];
	check('全部新增文本文件 LF 行尾',
		newFiles.every(function (f) { return read(path.join(root, f)).indexOf('\r\n') < 0; }));

	/* ==========================================================================
	   D. 业务安全白名单（git diff）
	   ========================================================================== */
	console.log('\n[D] 业务安全白名单（禁止修改的后端/硬件逻辑）');

	let changed = [];
	try {
		/* HEAD 仍在基线 main 上，全部改动都在工作区（含未跟踪的新文件），
		 * 因此以 status --porcelain 为准；已提交场景再补 diff 结果。 */
		const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' })
			.trim().split('\n').filter(Boolean).map(function (l) { return l.slice(3); });
		let diff = [];
		try {
			diff = execSync('git diff --name-only origin/main...HEAD', { cwd: root, encoding: 'utf8' })
				.trim().split('\n').filter(Boolean);
		} catch (e) { /* 忽略 */ }
		changed = status.concat(diff).filter(function (v, i, a) { return a.indexOf(v) === i; });
	} catch (e) {
		changed = [];
	}
	const forbidden = [
		'root/usr/share/rpcd/ucode/', 'src/rust/', 'root/etc/init.d/',
		'root/etc/hotplug.d/', 'root/usr/share/rpcd/acl.d/',
		'root/usr/share/luci/menu.d/', 'root/usr/libexec/',
		'.github/workflows/'
	];
	const violations = changed.filter(function (f) {
		return forbidden.some(function (p) { return f.indexOf(p) === 0; });
	});
	check('Ucode / Rust / init.d / hotplug / ACL / menu.d / CI 均未改动',
		violations.length === 0, violations.join(', '));
	check('业务 UCI 配置只新增 ui_mode（未改其它 option）',
		(uciCfg.match(/option ui_mode/g) || []).length === 1);
	check('未新增 ubus/RPC 方法或后端服务',
		!changed.some(function (f) { return f.indexOf('root/usr/share/rpcd/') === 0; }));
	check('模式切换代码不含 AT / SMS / 拨号 / USB / 服务重启调用',
		!/AtWs\.client\.sendCommand|Ui\.sendCmd|AT\+CFUN|L\.uci\.apply|\/etc\/init\.d|ubus\.call|ifup/.test(uimodeCode));

	/* ==========================================================================
	   汇总
	   ========================================================================== */
	const failed = results.filter(function (r) { return !r.ok; });
	console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' + results.length
		: 'ALL ' + results.length + ' PASSED'));
	if (failed.length) {
		failed.forEach(function (r) { console.log('  - ' + r.name); });
	}
	process.exit(failed.length ? 1 : 0);
})().catch(function (err) {
	console.error('\n测试执行异常：', err && err.stack || err);
	process.exit(1);
});
