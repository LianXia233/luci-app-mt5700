'use strict';
/**
 * 仓库静态检查（零依赖，可在本地与 CI 共用）
 *
 * 覆盖：
 *   1) 语法：所有 *.js 通过 `node --check`（视图、公共库、脚本、测试）；
 *   2) 数据：所有 *.json 可被 JSON.parse（menu.d / acl.d / package.json）；
 *   3) 行尾：文本文件统一 LF（CRLF 会导致 BusyBox ash / procd 侧异常）；
 *   4) 路由：menu.d 中 action.type = "view" 的路径必须存在对应视图文件
 *      （避免改动菜单或重命名视图后出现 404 页面）。
 *
 * 运行：node tests/static-check.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const root = path.join(__dirname, '..');

/* 二进制资源不参与语法与行尾检查 */
const BINARY_EXT = [
	'.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf',
	'.woff', '.woff2', '.ttf', '.gz', '.tgz', '.zip', '.apk', '.ipk'
];

const results = [];
function check(name, ok, detail) {
	results.push({ name: name, ok: !!ok });
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail && !ok ? '\n        ' + detail : ''));
}

/* ---------- 文件清单：优先 git（忽略未跟踪产物），无 git 时退回遍历 ---------- */
function listFiles() {
	try {
		const out = execSync('git ls-files -z', { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
		return out.toString('utf8').split('\u0000').filter(Boolean);
	} catch (e) {
		const acc = [];
		(function walk(dir) {
			fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
				if (d.name === '.git' || d.name === 'node_modules') return;
				const p = path.join(dir, d.name);
				if (d.isDirectory()) walk(p);
				else acc.push(path.relative(root, p).split(path.sep).join('/'));
			});
		})(root);
		return acc;
	}
}

const files = listFiles();
const textFiles = files.filter(function (f) {
	return BINARY_EXT.indexOf(path.extname(f).toLowerCase()) < 0;
});
const jsFiles = textFiles.filter(function (f) { return f.endsWith('.js'); });
const jsonFiles = textFiles.filter(function (f) { return f.endsWith('.json'); });

console.log('仓库文件 %d 个（文本 %d / JS %d / JSON %d）\n',
	files.length, textFiles.length, jsFiles.length, jsonFiles.length);

/* ---------- 1) JS 语法 ---------- */
const syntaxBad = [];
jsFiles.forEach(function (f) {
	const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
	if (r.status !== 0) {
		/* 只保留相对路径，避免运行器绝对路径刷屏 */
		const msg = ((r.stderr || '') + (r.stdout || ''))
			.replace(root + path.sep, '')
			.replace(root + '/', '')
			.trim().split('\n').slice(0, 3).join(' ');
		syntaxBad.push(f + ' -> ' + (msg || 'unknown error'));
	}
});
check('JS 语法（' + jsFiles.length + ' 个文件）', syntaxBad.length === 0, syntaxBad.join('\n        '));

/* ---------- 2) JSON 合法性 ---------- */
const jsonBad = [];
jsonFiles.forEach(function (f) {
	try {
		JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
	} catch (e) {
		jsonBad.push(f + ' -> ' + e.message);
	}
});
check('JSON 合法性（' + jsonFiles.length + ' 个文件）', jsonBad.length === 0, jsonBad.join('\n        '));

/* ---------- 3) 行尾 LF ---------- */
const crlfBad = textFiles.filter(function (f) {
	return fs.readFileSync(path.join(root, f)).indexOf('\r\n') >= 0;
});
check('行尾统一 LF（' + textFiles.length + ' 个文本文件）', crlfBad.length === 0, crlfBad.join(', '));

/* ---------- 4) 菜单路由 → 视图文件 ---------- */
const MENU_DIR = path.join(root, 'root', 'usr', 'share', 'luci', 'menu.d');
const VIEW_DIR = path.join(root, 'htdocs', 'luci-static', 'resources', 'view');
const routes = [];
const routeBad = [];

if (fs.existsSync(MENU_DIR)) {
	fs.readdirSync(MENU_DIR).filter(function (f) { return f.endsWith('.json'); }).forEach(function (f) {
		let menu;
		try {
			menu = JSON.parse(fs.readFileSync(path.join(MENU_DIR, f), 'utf8'));
		} catch (e) {
			routeBad.push(f + ' 无法解析');
			return;
		}
		Object.keys(menu).forEach(function (key) {
			const act = (menu[key] && menu[key].action) || {};
			if (act.type !== 'view' || !act.path) return;
			routes.push(key);
			const view = path.join(VIEW_DIR, act.path + '.js');
			if (!fs.existsSync(view)) {
				routeBad.push(key + ' -> 缺少视图 ' + path.relative(root, view).split(path.sep).join('/'));
			}
		});
	});
}
check('菜单路由视图存在（' + routes.length + ' 条）', routeBad.length === 0, routeBad.join('\n        '));

/* ---------- 汇总 ---------- */
const failed = results.filter(function (r) { return !r.ok; });
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + ' / ' + results.length
	: 'ALL ' + results.length + ' PASSED'));
process.exit(failed.length ? 1 : 0);
