'use strict';
/**
 * 四格动态信号图标单测（移植自 cellular-signal-preview.html）
 *
 * 覆盖三部分：
 *   1) 组件行为：setCellularState() 的 data-state 与信号格点亮数量；
 *   2) 状态映射：network_status.js 的 computeCellularState() 在各真实数据分支的取值；
 *   3) 一致性：每个状态都有对应的品质文案（CELLULAR_UI），不会出现「有状态无文案」。
 *
 * 运行：node tests/cellular-icon-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');
const viewDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');

/* ---------- 最小 DOM 桩（够 E / svgEl / cellularSignal 用） ---------- */

function makeEl(tag) {
	const el = {
		tag: tag,
		nodeType: 1,
		attrs: {},
		children: [],
		_classes: [],
		style: {},
		addEventListener: function () {},
		setAttribute: function (k, v) {
			this.attrs[k] = String(v);
			/* SVG 元素由 svgEl 通过 setAttribute('class', ...) 设置类名，这里同步到桩的类列表 */
			if (k === 'class') this._classes = String(v).split(/\s+/).filter(Boolean);
		},
		getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
		appendChild: function (c) { this.children.push(c); return c; }
	};
	Object.defineProperty(el, 'className', {
		get: function () { return this._classes.join(' '); },
		set: function (v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
	});
	el.classList = {
		add: function (c) { if (el._classes.indexOf(c) < 0) el._classes.push(c); },
		remove: function (c) { el._classes = el._classes.filter(function (x) { return x !== c; }); },
		contains: function (c) { return el._classes.indexOf(c) >= 0; }
	};
	el.querySelectorAll = function (sel) {
		const cls = sel.replace(/^\./, '');
		const out = [];
		(function walk(node) {
			node.children.forEach(function (c) {
				if (c._classes && c._classes.indexOf(cls) >= 0) out.push(c);
				walk(c);
			});
		})(el);
		return out;
	};
	return el;
}

const documentStub = {
	createElement: makeEl,
	createElementNS: function (ns, tag) { return makeEl(tag); },
	createTextNode: function (t) { return { nodeType: 3, textContent: String(t) }; }
};

/* ---------- 加载被测代码 ---------- */

const mt = fs.readFileSync(path.join(libDir, 'mt5700.js'), 'utf8');

function sliceCode(src, from, to) {
	const a = src.indexOf(from);
	const b = src.indexOf(to, a);
	if (a < 0 || b < 0) throw new Error('切片失败: ' + from + ' → ' + to);
	return src.slice(a, b);
}

const helpers = sliceCode(mt, 'function E(tag, attrs, text) {', '// SVG 创建') +
	sliceCode(mt, 'function svgEl(tag, attrs) {', 'api.constellationSvg');
const cellular = sliceCode(mt, 'var CELLULAR_LEVELS = {', 'api.page = function');

const cellularFactory = new Function('document', 'var api = {};\n' + helpers + cellular +
	'\n;return { cellularSignal: api.cellularSignal, LEVELS: api.CELLULAR_LEVELS, LABELS: api.CELLULAR_LABELS };');
const cel = cellularFactory(documentStub);

const ns = fs.readFileSync(path.join(viewDir, 'network_status.js'), 'utf8');
const stateCode = sliceCode(ns, 'var CELLULAR_UI = {', 'function renderSignalUI() {');
const stateFactory = new Function('state', stateCode +
	'\n;return { computeCellularState: computeCellularState, UI: CELLULAR_UI };');

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

try {
	/* ---------- 1. 组件行为 ---------- */
	{
		const el = cel.cellularSignal();
		check('默认状态为 searching（未拿到数据时不假装有信号）',
			el.getAttribute('data-state') === 'searching', 'data-state=' + el.getAttribute('data-state'));
		check('SVG 含 4 个信号格', el.querySelectorAll('.bar').length === 4, 'bars=' + el.querySelectorAll('.bar').length);
		check('含斜杠/连接点/错误角标三类覆盖层',
			el.querySelectorAll('.slash').length === 1 && el.querySelectorAll('.connecting-dot').length === 1 &&
			el.querySelectorAll('.error-mark').length === 1, 'overlays');

		const cases = [['none', 0], ['weak', 1], ['medium', 2], ['strong', 3], ['full', 4],
			['searching', 0], ['connecting', 0], ['disconnected', 0], ['error', 0]];
		cases.forEach(function (c) {
			const st = el.setCellularState(c[0]);
			const active = el.querySelectorAll('.bar').filter(function (b) { return b.classList.contains('active'); }).length;
			check('状态 ' + c[0] + ' → ' + c[1] + ' 格点亮',
				st === c[0] && active === c[1], 'state=' + st + ' active=' + active);
		});

		const unknown = el.setCellularState('bogus');
		check('未知状态回落到 searching', unknown === 'searching' && el.getAttribute('data-state') === 'searching', 'fallback=' + unknown);

		el.setCellularState('full');
		check('aria-label 随状态更新', el.getAttribute('aria-label') === cel.LABELS.full,
			'label=' + el.getAttribute('aria-label'));
	}

	/* ---------- 2. 真实数据 → 状态映射 ---------- */
	{
		const mk = (o) => stateFactory(Object.assign({
			cell: { rsrp: null }, networkStatus: '检测中...', simStatus: '检测中...', hfreqSuccess: null
		}, o)).computeCellularState();

		/* 核心回归：信号本身正常时，辅助遥测命令失败不得显示为读取异常 */
		check('有 RSRP 且主载波查询失败 → 仍按 RSRP 分档 (full)',
			mk({ simStatus: '正常 (READY)', networkStatus: '已注册（本地网络）', hfreqSuccess: false, cell: { rsrp: -64 } }) === 'full',
			'rsrp -64 + hfreq 失败');
		check('有 RSRP 且遥测异常 → 不受 telemetryError 影响',
			mk({ simStatus: '正常 (READY)', networkStatus: '已注册（本地网络）', hfreqSuccess: true, telemetryError: true, cell: { rsrp: -95 } }) === 'strong',
			'telemetryError');
		check('无 RSRP 且已注册但主载波查询失败 → error',
			mk({ simStatus: '正常 (READY)', networkStatus: '已注册（本地网络）', hfreqSuccess: false, cell: { rsrp: null } }) === 'error',
			'no-rsrp + hfreq 失败');
		check('主载波查询失败但尚未拿到注册结论 → searching（不误报异常）',
			mk({ hfreqSuccess: false }) === 'searching', 'initial + hfreq 失败');
		check('SIM 未就绪 → disconnected', mk({ simStatus: 'SIM PIN', hfreqSuccess: true, networkStatus: '已注册（本地网络）' }) === 'disconnected',
			'SIM PIN');
		check('SIM 未就绪优先于已有读数 → disconnected',
			mk({ simStatus: 'SIM PIN', networkStatus: '已注册（本地网络）', hfreqSuccess: true, cell: { rsrp: -70 } }) === 'disconnected',
			'SIM PIN + rsrp');
		check('注册中（未注册）→ searching', mk({ simStatus: '正常 (READY)', hfreqSuccess: true, networkStatus: '未注册，正在搜索' }) === 'searching',
			'未注册');
		check('注册被拒绝 → error', mk({ simStatus: '正常 (READY)', hfreqSuccess: true, networkStatus: '注册被拒绝' }) === 'error', '拒绝');
		check('注册状态未知 → error', mk({ simStatus: '正常 (READY)', hfreqSuccess: true, networkStatus: '未知' }) === 'error', '未知');
		check('初始「检测中...」→ searching', mk({ simStatus: '检测中...', networkStatus: '检测中...' }) === 'searching', 'initial');
		check('等待状态中 → searching', mk({ simStatus: '正常 (READY)', hfreqSuccess: true, networkStatus: '等待状态中' }) === 'searching', '等待');

		const reg = { simStatus: '正常 (READY)', hfreqSuccess: true, networkStatus: '已注册（本地网络）' };
		check('已注册但无读数 → connecting',
			mk(Object.assign({}, reg, { cell: { rsrp: null } })) === 'connecting', 'no-rsrp');
		check('RSRP -64 → full（实机取值）', mk(Object.assign({}, reg, { cell: { rsrp: -64 } })) === 'full', '-64');
		check('RSRP -80 → full', mk(Object.assign({}, reg, { cell: { rsrp: -80 } })) === 'full', '-80');
		check('RSRP -81 → strong', mk(Object.assign({}, reg, { cell: { rsrp: -81 } })) === 'strong', '-81');
		check('RSRP -95 → strong', mk(Object.assign({}, reg, { cell: { rsrp: -95 } })) === 'strong', '-95');
		check('RSRP -96 → medium', mk(Object.assign({}, reg, { cell: { rsrp: -96 } })) === 'medium', '-96');
		check('RSRP -110 → medium', mk(Object.assign({}, reg, { cell: { rsrp: -110 } })) === 'medium', '-110');
		check('RSRP -111 → weak', mk(Object.assign({}, reg, { cell: { rsrp: -111 } })) === 'weak', '-111');
		check('RSRP -139 → weak', mk(Object.assign({}, reg, { cell: { rsrp: -139 } })) === 'weak', '-139');
		check('RSRP -141（越界）→ none', mk(Object.assign({}, reg, { cell: { rsrp: -141 } })) === 'none', '-141');
		check('漫游注册同样按 RSRP 分档', mk(Object.assign({}, reg, { networkStatus: '已注册（漫游）', cell: { rsrp: -90 } })) === 'strong', 'roaming');

		/* 3. 每个状态都有品质文案 */
		const uiEnv = stateFactory({ cell: {}, networkStatus: '', simStatus: '', hfreqSuccess: null });
		const missing = Object.keys(cel.LEVELS).filter(function (k) { return !uiEnv.UI[k]; });
		check('全部状态均有品质文案', missing.length === 0, missing.join(',') || 'ok');
		const labelMissing = Object.keys(cel.LEVELS).filter(function (k) { return !cel.LABELS[k]; });
		check('全部状态均有可访问标签', labelMissing.length === 0, labelMissing.join(',') || 'ok');
	}
} catch (e) {
	check('单测执行', false, String((e && e.stack) || e));
}

const fails = results.filter(function (r) { return !r.ok; });
console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
if (fails.length) {
	fails.forEach(function (f) { console.log('FAILED: ' + f.name + ' — ' + f.detail); });
	process.exit(1);
}
process.exit(0);
