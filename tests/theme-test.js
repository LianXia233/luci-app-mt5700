'use strict';
/**
 * 主题明暗检测单测（theme.js，issue #26）
 *
 * 覆盖：
 *   1) 纯函数：parseColor / relLuma / contrastRatio / composite；
 *   2) markerVerdict：Aurora(data-darkmode) / Argon3(data-argon-mode) /
 *      通用 data-theme / 遗留 body class / 无标记返回 null / 优先级；
 *   3) probeVerdict：color-scheme / body 背景亮度 / 透明背景叠加 /
 *      壁纸场景正文浅字启发 / 缺环境返回 null；
 *   4) mediaVerdict 与 decide 优先级；
 *   5) 真实模块端到端（new Function 加载 + DOM 桩）：
 *      - 求值即写 html.at-dark / data-at-theme；
 *      - 标记变化后 apply() 翻转并通知 onChange；
 *      - 结论不变时零写零通知。
 *
 * 运行：node tests/theme-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');

/* ---------- 最小 DOM 桩（同 tabmenu-test 风格） ---------- */

function makeEl(tag) {
	const el = {
		tag: tag,
		nodeType: 1,
		attrs: {},
		children: [],
		_classes: [],
		parentNode: null,
		setAttribute: function (k, v) {
			this.attrs[k] = String(v);
			if (k === 'class') this._classes = String(v).split(/\s+/).filter(Boolean);
		},
		getAttribute: function (k) {
			return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
		},
		appendChild: function (c) { c.parentNode = this; this.children.push(c); return c; },
		addEventListener: function () { },
		classList: {
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
		}
	};
	Object.defineProperty(el, 'className', {
		get: function () { return this._classes.join(' '); },
		set: function (v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
	});
	return el;
}

function makeEnv(opts) {
	opts = opts || {};
	const htmlEl = makeEl('html');
	const bodyEl = makeEl('body');
	bodyEl.parentNode = htmlEl;
	(Object.keys(opts.htmlAttrs || {})).forEach(function (k) { htmlEl.setAttribute(k, opts.htmlAttrs[k]); });
	(Object.keys(opts.bodyAttrs || {})).forEach(function (k) { bodyEl.setAttribute(k, opts.bodyAttrs[k]); });
	(Object.keys(opts.htmlClasses || {})).forEach(function (c) { htmlEl.classList.add(c); });
	(Object.keys(opts.bodyClasses || {})).forEach(function (c) { bodyEl.classList.add(c); });
	htmlEl._computed = opts.htmlComputed || {};
	bodyEl._computed = opts.bodyComputed || {};

	const documentStub = {
		readyState: 'complete',
		documentElement: htmlEl,
		body: bodyEl,
		addEventListener: function () { }
	};

	const windowStub = {
		document: documentStub,
		getComputedStyle: function (el) { return el._computed || {}; }
	};
	if (opts.matchMedia) {
		windowStub.matchMedia = function () { return { matches: opts.matchMedia, addEventListener: function () { } }; };
	}
	return { documentStub: documentStub, windowStub: windowStub, htmlEl: htmlEl, bodyEl: bodyEl };
}

function loadModule(env) {
	const src = fs.readFileSync(path.join(libDir, 'theme.js'), 'utf8');
	const factory = new Function('L', 'document', 'window', src);
	const L_STUB = {
		Class: {
			extend: function (o) {
				return function AtThemeClass() { Object.assign(this, o); };
			}
		}
	};
	return new (factory(L_STUB, env.documentStub, env.windowStub))();
}

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

/* ---------- 1. 纯函数 ---------- */
(function () {
	const env = makeEnv({});
	const api = loadModule(env);

	check('parseColor #rrggbb', (function () {
		const c = api.parseColor('#8b5cf6');
		return c && c.r === 139 && c.g === 92 && c.b === 246 && c.a === 1;
	})());
	check('parseColor #rgb', (function () {
		const c = api.parseColor('#0f8');
		return c && c.r === 0 && c.g === 255 && c.b === 136;
	})());
	check('parseColor rgb()',
		(function () { const c = api.parseColor('rgb(24, 24, 25)'); return c && c.r === 24 && c.g === 24 && c.b === 25 && c.a === 1; })());
	check('parseColor rgba() 小数 alpha',
		(function () { const c = api.parseColor('rgba(255, 255, 255, 0.72)'); return c && c.a === 0.72; })());
	check('parseColor rgba() 百分比 alpha',
		(function () { const c = api.parseColor('rgba(0, 0, 0, 45%)'); return c && Math.abs(c.a - 0.45) < 1e-9; })());
	check('parseColor 非法输入返回 null',
		api.parseColor('transparent') === null && api.parseColor('') === null && api.parseColor(null) === null);
	check('relLuma 黑 0 白 1',
		api.relLuma({ r: 0, g: 0, b: 0 }) === 0 && Math.abs(api.relLuma({ r: 255, g: 255, b: 255 }) - 1) < 1e-9);
	check('contrastRatio 黑白 21:1 同色 1:1',
		Math.abs(api.contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }) - 21) < 0.01 &&
		api.contrastRatio({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 }) === 1);
	check('contrastRatio 深灰对白 > 7（Argon Tab 文字 #404040）',
		(function () {
			return api.contrastRatio(api.parseColor('#404040'), { r: 255, g: 255, b: 255 }) > 7;
		})());
	check('composite 半透明白叠黑底', (function () {
		const out = api.composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
		return out.r === 128 && out.g === 128 && out.b === 128;
	})());
	check('composite 不透明色原样返回', (function () {
		const out = api.composite({ r: 10, g: 20, b: 30, a: 1 }, { r: 0, g: 0, b: 0, a: 1 });
		return out.r === 10 && out.g === 20 && out.b === 30;
	})());
})();

/* ---------- 2. markerVerdict ---------- */
(function () {
	function marker(opts) {
		const env = makeEnv(opts);
		return loadModule(env).markerVerdict(env.htmlEl, env.bodyEl);
	}
	check('Aurora: data-darkmode=true → dark', marker({ htmlAttrs: { 'data-darkmode': 'true' } }) === 'dark');
	check('Aurora: data-darkmode=false → light', marker({ htmlAttrs: { 'data-darkmode': 'false' } }) === 'light');
	check('Argon3: data-argon-mode=dark → dark', marker({ htmlAttrs: { 'data-argon-mode': 'dark' } }) === 'dark');
	check('Argon3: data-argon-mode=light → light', marker({ htmlAttrs: { 'data-argon-mode': 'light' } }) === 'light');
	check('通用: data-theme=dark → dark', marker({ htmlAttrs: { 'data-theme': 'dark' } }) === 'dark');
	check('遗留: body.dark-theme → dark', marker({ bodyClasses: { 'dark-theme': 1 } }) === 'dark');
	check('html.dark class → dark', marker({ htmlClasses: { dark: 1 } }) === 'dark');
	check('无任何标记 → null', marker({}) === null);
	check('优先级: html 标记压过 body class',
		marker({ htmlAttrs: { 'data-darkmode': 'light' }, bodyClasses: { 'dark-theme': 1 } }) === 'light');
})();

/* ---------- 3. probeVerdict ---------- */
(function () {
	function probe(opts) {
		const env = makeEnv(opts);
		return loadModule(env).probeVerdict(env.windowStub);
	}
	check('probe: color-scheme=dark → dark',
		probe({ htmlComputed: { colorScheme: 'dark' } }) === 'dark');
	check('probe: color-scheme=light → light',
		probe({ htmlComputed: { colorScheme: 'light' } }) === 'light');
	check('probe: body 深色背景 → dark（Argon 2.x 暗色）',
		probe({ bodyComputed: { backgroundColor: 'rgb(24, 24, 25)', color: 'rgb(230, 230, 230)' } }) === 'dark');
	check('probe: body 浅色背景 → light',
		probe({ bodyComputed: { backgroundColor: 'rgb(245, 243, 255)', color: 'rgb(30, 27, 75)' } }) === 'light');
	check('probe: body 半透明叠加 html 深底 → dark',
		probe({
			htmlComputed: { backgroundColor: 'rgb(13, 17, 30)' },
			bodyComputed: { backgroundColor: 'rgba(22, 27, 46, 0.6)' }
		}) === 'dark');
	check('probe: 全透明背景 + 正文浅字 → dark（壁纸主题）',
		probe({
			htmlComputed: { backgroundColor: 'rgba(0, 0, 0, 0)' },
			bodyComputed: { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(230, 230, 230)' }
		}) === 'dark');
	check('probe: 全透明背景 + 正文深字 → light',
		probe({
			bodyComputed: { backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(30, 27, 75)' }
		}) === 'light');
	check('probe: 无 doc/无 computed → null',
		probe({}) === null &&
		loadModule(makeEnv({})).probeVerdict({}) === null);
})();

/* ---------- 4. mediaVerdict 与 decide 优先级 ---------- */
(function () {
	const envDark = makeEnv({ matchMedia: true });
	const envLight = makeEnv({ matchMedia: false });
	const api = loadModule(envDark);
	check('mediaVerdict: prefers-dark → dark', api.mediaVerdict(envDark.windowStub) === 'dark');
	check('mediaVerdict: prefers-light → light', api.mediaVerdict(envLight.windowStub) === 'light');
	check('decide: 显式标记优先于媒体查询',
		(function () {
			const env = makeEnv({ htmlAttrs: { 'data-darkmode': 'light' }, matchMedia: true });
			return api.decide(env.htmlEl, env.bodyEl, env.windowStub) === 'light';
		})());
	check('decide: 无标记时探测优先于媒体查询',
		(function () {
			const env = makeEnv({
				matchMedia: true,
				bodyComputed: { backgroundColor: 'rgb(245, 243, 255)', color: 'rgb(30, 27, 75)' }
			});
			return api.decide(env.htmlEl, env.bodyEl, env.windowStub) === 'light';
		})());
	check('decide: 全空回落媒体查询',
		(function () {
			const env = makeEnv({ matchMedia: true });
			return api.decide(env.htmlEl, env.bodyEl, env.windowStub) === 'dark';
		})());
})();

/* ---------- 5. 端到端：求值即写标记 / 翻转通知 / 幂等 ---------- */
(async function main() {

	const env = makeEnv({ htmlAttrs: { 'data-darkmode': 'true' } });
	const api = loadModule(env);

	check('求值即判定: html.at-dark 已写入', env.htmlEl.classList.contains('at-dark'));
	check('求值即判定: data-at-theme=dark', env.htmlEl.getAttribute('data-at-theme') === 'dark');
	check('求值即判定: at-light 未写入', !env.htmlEl.classList.contains('at-light'));
	check('dark() / current() 语义', api.dark() === true && api.current() === 'dark');

	let fired = 0;
	api.onChange(function (v) { fired++; });

	env.htmlEl.setAttribute('data-darkmode', 'false');
	api.apply();
	check('标记翻转: 切到 light', !api.dark() && env.htmlEl.classList.contains('at-light') && !env.htmlEl.classList.contains('at-dark'));
	check('标记翻转: data-at-theme=light', env.htmlEl.getAttribute('data-at-theme') === 'light');
	check('标记翻转: onChange 收到一次通知', fired === 1, 'fired=' + fired);

	api.apply();
	check('结论不变: 再次 apply 零写零通知', fired === 1 && api.current() === 'light');

	/* Aurora 运行时切换模拟：属性变化后手动触发 apply（真实浏览器由 MutationObserver 驱动） */
	env.htmlEl.setAttribute('data-darkmode', 'true');
	api.apply();
	check('Aurora 按钮切回暗色: 状态与通知一致', api.dark() && fired === 2);

	/* ---------- Argon 2.x 场景：无标记，靠背景探测 ---------- */
	const env2 = makeEnv({
		bodyComputed: { backgroundColor: 'rgb(24, 24, 25)', color: 'rgb(230, 230, 230)' },
		matchMedia: false
	});
	const api2 = loadModule(env2);
	check('Argon 2.x 无标记: 背景探测判暗', api2.dark() === true && env2.htmlEl.getAttribute('data-at-theme') === 'dark');

	/* ---------- 官方主题场景：无标记无背景，回落媒体查询 ---------- */
	const env3 = makeEnv({ matchMedia: true });
	const api3 = loadModule(env3);
	check('官方主题: 回落系统媒体查询判暗', api3.dark() === true);

	/* ---------- 汇总 ---------- */
	const failed = results.filter(function (r) { return !r.ok; });
	console.log('\n' + (failed.length ? 'FAILED ' + failed.length : 'ALL ' + results.length + ' PASSED'));
	process.exit(failed.length ? 1 : 0);
})();
