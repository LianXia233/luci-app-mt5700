'use strict';
/**
 * 核心脚本权限与可执行属性回归测试（零依赖）
 *
 * 目的：防范跨平台提交（特别是 Windows 环境下编辑）导致核心服务脚本、
 * uci-defaults 首次配置、热插拔处理、构建入口与 on-uplink 脚本丢失 100755
 * 可执行权限位，进而导致下游 OpenWrt CI 构建或真实设备运行报 Permission denied。
 *
 * 运行方式：node tests/script-mode-test.js
 */

const fs = require('fs');
const path = require('path');
const { REQUIRED_EXECUTABLES, isValidShebang, collectModeProblems, hasUtf8Bom } = require('./lib/exec-mode');

const root = path.join(__dirname, '..');

let failed = false;
function assert(desc, ok, extra) {
	if (ok) {
		console.log('  ok   ' + desc);
	} else {
		failed = true;
		console.error('  FAIL ' + desc + (extra ? '\n        ' + extra : ''));
	}
}

console.log('==> 校验核心脚本 Git 索引权限位 (100755)');
const modeBad = collectModeProblems();
assert('核心脚本均可执行（' + REQUIRED_EXECUTABLES.length + ' 个文件为 100755）',
	modeBad.length === 0, modeBad.join('\n        '));

console.log('\n==> 校验核心脚本 Shebang、LF 换行与 BOM');
REQUIRED_EXECUTABLES.forEach(function (file) {
	const fullPath = path.join(root, file);
	assert(file + ' 文件存在', fs.existsSync(fullPath));
	if (!fs.existsSync(fullPath)) return;

	const content = fs.readFileSync(fullPath, 'utf8');
	assert(file + ' 无 CRLF 换行', content.indexOf('\r\n') === -1);
	assert(file + ' 无 UTF-8 BOM', !hasUtf8Bom(content));
	/* 诊断输出用 JSON.stringify：trim 会把 BOM 与前导空白藏起来，看不出失败原因 */
	assert(file + ' 具有合法 Shebang（#!/bin/sh 或 #!/bin/bash）',
		isValidShebang(content), '第一行: ' + JSON.stringify(content.split('\n')[0]));
});

if (failed) {
	console.error('\nFAIL: 核心脚本权限位或格式校验未通过！');
	process.exit(1);
} else {
	console.log('\nPASS: 全部核心脚本权限位与格式校验通过。');
	process.exit(0);
}
