'use strict';
/**
 * 生成双 UI 模式的 SVG 图标资源文件。
 *
 * 数据源唯一：htdocs/luci-static/resources/at-webserver/icons.js 里的
 * NORMAL / MINIMAL 两张图元表。运行时由 Icon Manager 内联注入（currentColor、
 * 可跟随 MD3 动态色），本脚本把同一份数据导出为项目内部可直接引用的
 * .svg 文件，便于逐页核对、外部引用与回归测试。
 *
 * 目录隔离：icons/normal/<key>.svg 与 icons/minimal/<key>.svg。
 * 强制校验：两套表 key 完全一致；同一 key 的图元字符串必须不同
 *          （防止「改颜色 / 改描边 / 改尺寸」冒充重绘）。
 *
 * 用法：node scripts/gen-dual-ui-icons.js [--check]
 *   --check 只做校验，不写文件（供 CI / 测试调用）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const libDir = path.join(root, 'htdocs', 'luci-static', 'resources', 'at-webserver');
const iconsDir = path.join(libDir, 'icons');
const source = path.join(libDir, 'icons.js');
const checkOnly = process.argv.indexOf('--check') >= 0;

function loadIconData() {
	/* LuCI 模块末尾有顶层 return，包进函数体才能求值；同时剥掉那句模块返回，
	 * 否则包装函数会提前返回 Class 而不是数据表。模块求值阶段不触碰 DOM。 */
	const src = fs.readFileSync(source, 'utf8').replace(/\nreturn AtIconsClass;\s*$/, '\n');
	const sandbox = {
		L: { Class: { extend: function (obj) {
			function Ctor() {}
			Ctor.prototype = obj;
			return Ctor;
		} } },
		window: {},
		console: console
	};
	const wrapped = '(function(){\n' + src + '\nreturn AtIcons;\n})()';
	return vm.runInNewContext(wrapped, sandbox, { filename: source });
}

const data = loadIconData();
const keys = data.keys;
const problems = [];

if (!keys.length) problems.push('图标表为空');

keys.forEach(function (key) {
	if (!data.has(key)) problems.push(key + ': 两套表缺一');
	const n = data.normal[key];
	const m = data.minimal[key];
	if (!n || !m) problems.push(key + ': 图元为空');
	if (n === m) problems.push(key + ': 极简版与普通版图元相同（未重绘）');
	if (!/^(nav|st|op)-/.test(key)) problems.push(key + ': 命名前缀不合规');
});

/* 规范 SVG：单根、viewBox 24×24、currentColor、无障碍属性、无外部依赖 */
keys.forEach(function (key) {
	['normal', 'minimal'].forEach(function (mode) {
		const doc = data.svgDocument(key, mode);
		if (doc.indexOf('<svg xmlns=') !== 0) problems.push(key + '/' + mode + ': 根元素异常');
		if (doc.indexOf('viewBox="0 0 24 24"') < 0) problems.push(key + '/' + mode + ': viewBox 非 24×24');
		if (doc.indexOf('stroke="currentColor"') < 0) problems.push(key + '/' + mode + ': 未使用 currentColor');
		if (doc.indexOf('role="img"') < 0 || doc.indexOf('aria-label=') < 0) {
			problems.push(key + '/' + mode + ': 缺少无障碍属性');
		}
		/* xmlns 的 http://www.w3.org/2000/svg 是标准命名空间，不算外部依赖 */
		if (/<script|<image|<use\b|href=|url\(\s*['"]?https?:/i.test(doc)) {
			problems.push(key + '/' + mode + ': 含外部依赖或脚本');
		}
		if ((doc.match(/</g) || []).length !== (doc.match(/>/g) || []).length) {
			problems.push(key + '/' + mode + ': 尖括号不配对');
		}
	});
});

if (problems.length) {
	console.error('图标校验失败（' + problems.length + ' 项）：');
	problems.forEach(function (p) { console.error('  - ' + p); });
	process.exit(1);
}

if (!checkOnly) {
	['normal', 'minimal'].forEach(function (mode) {
		const dir = path.join(iconsDir, mode);
		fs.mkdirSync(dir, { recursive: true });
		keys.forEach(function (key) {
			/* 一律 LF，与 .gitattributes 约定一致 */
			fs.writeFileSync(path.join(dir, key + '.svg'), data.svgDocument(key, mode), 'utf8');
		});
	});
}

console.log('图标校验通过：' + keys.length + ' 个语义 × 2 套 = ' + (keys.length * 2) + ' 个 SVG 资源');
console.log('  前缀分布：nav-* ' + keys.filter(function (k) { return k.indexOf('nav-') === 0; }).length
	+ ' / st-* ' + keys.filter(function (k) { return k.indexOf('st-') === 0; }).length
	+ ' / op-* ' + keys.filter(function (k) { return k.indexOf('op-') === 0; }).length);
console.log(checkOnly ? '  --check：未写文件' : '  已写入 ' + path.relative(root, iconsDir));
