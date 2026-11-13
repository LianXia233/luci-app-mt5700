'use strict';
/**
 * 核心脚本权限与可执行属性回归测试（零依赖）
 *
 * 目的：防范跨平台提交（特别是 Windows 环境下编辑）导致核心服务脚本、
 * uci-defaults 首次配置、热插拔处理、构建入口、测试 harness 与 on-uplink 脚本
 * 丢失 100755 可执行权限位，进而导致下游 OpenWrt CI 构建或真实设备运行报
 * Permission denied；同时拦截 BOM / 前导空白顶掉 `#!` 与 CRLF 污染。
 *
 * 除逐个校验清单外，还对执行入口目录做反向断言：目录内出现未登记的新脚本
 * 直接失败，避免「新增同类脚本忘记登记」造成静默漏覆盖。
 *
 * 运行方式：node tests/script-mode-test.js
 */

const fs = require('fs');
const path = require('path');
const {
	REQUIRED_EXECUTABLES,
	SHELL_SCRIPTS,
	isValidShebang,
	collectModeProblems,
	collectUnregisteredProblems,
	hasUtf8Bom
} = require('./lib/exec-mode');

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

console.log('\n==> 校验执行入口目录的登记完整性（反向断言）');
const unregBad = collectUnregisteredProblems();
assert('init.d / uci-defaults / hotplug.d / libexec 内无未登记脚本',
	unregBad.length === 0, unregBad.join('\n        '));

console.log('\n==> 校验核心脚本 Shebang、LF 换行与 BOM');
REQUIRED_EXECUTABLES.forEach(function (file) {
	const fullPath = path.join(root, file);
	assert(file + ' 文件存在', fs.existsSync(fullPath));
	if (!fs.existsSync(fullPath)) return;

	const content = fs.readFileSync(fullPath, 'utf8');
	assert(file + ' 无 CRLF 换行', content.indexOf('\r\n') === -1);
	assert(file + ' 无 UTF-8 BOM', !hasUtf8Bom(content));
	/* 非 shell 入口（#!/usr/bin/env node）只校权限位与格式，不套 shell shebang 规则 */
	if (SHELL_SCRIPTS.indexOf(file) < 0) return;
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
