'use strict';
/**
 * 核心脚本权限与可执行属性回归测试（零依赖）
 *
 * 目的：防范跨平台提交（特别是 Windows 环境下编辑）导致核心服务脚本、
 * uci-defaults 首次配置、热插拔处理及 on-uplink 脚本丢失 100755 可执行权限位，
 * 进而导致下游 OpenWrt CI 构建或真实设备运行报 Permission denied。
 *
 * 运行方式：node tests/script-mode-test.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

const REQUIRED_EXECUTABLES = [
	'root/etc/init.d/at-webserver',
	'root/etc/uci-defaults/at-webserver',
	'root/etc/hotplug.d/iface/99-at-webserver',
	'root/etc/hotplug.d/usb/99-at-webserver',
	'root/usr/libexec/at-webserver/on-uplink.sh',
	'tests/iface/interface-selection.sh'
];

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
try {
	const out = execSync('git ls-files -s ' + REQUIRED_EXECUTABLES.join(' '), {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	});
	const entries = {};
	out.trim().split('\n').filter(Boolean).forEach(function (line) {
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 4) {
			entries[parts[3]] = parts[0];
		}
	});

	REQUIRED_EXECUTABLES.forEach(function (file) {
		const mode = entries[file];
		assert(file + ' mode = 100755', mode === '100755', '实际 mode: ' + (mode || '未跟踪'));
	});
} catch (e) {
	console.warn('  note: 未检测到 git 命令或非 git 仓库，跳过索引权限断言');
}

console.log('\n==> 校验核心脚本 Shebang 与 LF 换行');
REQUIRED_EXECUTABLES.forEach(function (file) {
	const fullPath = path.join(root, file);
	assert(file + ' 文件存在', fs.existsSync(fullPath));
	if (!fs.existsSync(fullPath)) return;

	const content = fs.readFileSync(fullPath, 'utf8');
	assert(file + ' 无 CRLF 换行', content.indexOf('\r\n') === -1);

	const firstLine = content.split('\n')[0].trim();
	assert(file + ' 具有合法 Shebang', firstLine.startsWith('#!/bin/sh') || firstLine.startsWith('#!/bin/bash'), '第一行: ' + firstLine);
});

if (failed) {
	console.error('\nFAIL: 核心脚本权限位或格式校验未通过！');
	process.exit(1);
} else {
	console.log('\nPASS: 全部核心脚本权限位与格式校验通过。');
	process.exit(0);
}
