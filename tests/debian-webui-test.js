#!/usr/bin/env node
/* Debian 独立 WebUI 同步门禁：webui 资源必须与 main htdocs 逐字节一致，
 * 且独立外壳具备当前前端需要的垫片能力。main 分支没有 webui，自动跳过。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const webui = path.join(root, 'webui');
if (!fs.existsSync(webui)) { console.log('跳过：当前分支没有 Debian webui/'); process.exit(0); }

function walk(dir, rel) {
	const out = [];
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		const r = path.join(rel, name);
		if (fs.statSync(full).isDirectory()) out.push(...walk(full, r));
		else out.push(r);
	}
	return out.sort();
}
for (const rel of ['at-webserver', 'view/at-webserver']) {
	const a = path.join(root, 'htdocs/luci-static/resources', rel);
	const b = path.join(webui, 'luci-static/resources', rel);
	const fa = walk(a, ''), fb = walk(b, '');
	assert.deepEqual(fb, fa, rel + ' 文件清单必须与 htdocs 一致');
	for (const f of fa) assert.equal(fs.readFileSync(path.join(b, f)).compare(fs.readFileSync(path.join(a, f))), 0, rel + '/' + f + ' 内容漂移');
}
const shim = fs.readFileSync(path.join(webui, 'luci.js'), 'utf8');
assert.match(shim, /window\._ = function/, '垫片必须提供 _()');
assert.match(shim, /UCI_KEY_MAP/, '垫片必须把 websocket_* 映射到 Debian http_* 键');
assert.match(shim, /return \(result == null\) \? expect\[''\] : result/, 'expect { "": ... } 必须返回整个结果');
assert.match(shim, /sections: function/, '垫片必须提供 uci.sections');
const app = fs.readFileSync(path.join(webui, 'app.js'), 'utf8');
for (const m of ['config-common','config-drawer','config-connection','config-network','config-notify','config-templates']) {
	assert.ok(app.includes("'at-webserver/" + m + "'"), '加载顺序缺少 ' + m);
}
assert.match(app, /RESOURCE_VERSION = '1\.32\.13'/, '资源版本戳需同步 1.32.13');
assert.match(app, /replace\(\/\[\^A-Za-z0-9_\$\]\/g, '_'\)/, '模块别名校验必须清洗连字符');
const idx = fs.readFileSync(path.join(webui, 'index.html'), 'utf8');
assert.match(idx, /mt5700\.css\?v=1\.32\.13/, 'index.html 需带 CSS 版本戳');
console.log('Debian WebUI 同步检查通过：资源与 htdocs 一致，独立外壳能力齐备。');
