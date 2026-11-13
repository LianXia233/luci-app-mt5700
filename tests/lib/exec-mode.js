'use strict';
/**
 * 核心脚本可执行位与 Shebang 校验的共享实现（零依赖）
 *
 * 被 tests/static-check.js（静态门禁第 5 项）与 tests/script-mode-test.js 共用，
 * 避免两处各自维护一份「必须可执行」清单而逐渐漂移。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

/*
 * 这些脚本由 procd（init.d）、uci-defaults、hotplug、CI 构建入口或按路径直接调用，
 * 一旦在 git 索引里丢失 100755 就会 Permission denied（曾发生：跨平台补 SPDX 头时
 * 把 on-uplink.sh 提交成 100644）。新增同类脚本时必须登记到这里。
 */
const REQUIRED_EXECUTABLES = [
	'root/etc/init.d/at-webserver',
	'root/etc/uci-defaults/at-webserver',
	'root/etc/hotplug.d/iface/99-at-webserver',
	'root/etc/hotplug.d/usb/99-at-webserver',
	'root/usr/libexec/at-webserver/on-uplink.sh',
	'scripts/sdk-build.sh',
	'tests/iface/interface-selection.sh'
];

/*
 * 合法 Shebang：/bin/sh 或 /bin/bash，允许带参数（init.d 使用
 * `#!/bin/sh /etc/rc.common`）。用 (?=\s|$) 做边界限定，拒绝
 * `#!/bin/shfoo` / `#!/bin/bashx`：内核会把它们当成另一个解释器路径，
 * 在目标设备上直接执行失败。
 */
const SHEBANG_RE = /^#!\s*\/bin\/(?:sh|bash)(?=\s|$)/;

function isValidShebang(content) {
	const firstLine = String(content).split('\n')[0].trim();
	return SHEBANG_RE.test(firstLine);
}

/*
 * git ls-files 的统一入口。-z 以 NUL 分隔记录且路径原样输出，不做 C 转义：
 * 默认 core.quotePath 会把非 ASCII 路径写成 \346\226\207 形式，与清单字面量
 * 对不上而误报「未跟踪」；按行解析再 trim 还会吃掉路径的尾随空格。
 * 失败时保留 stderr / error 供调用方告警，不静默吞掉原因。
 */
let gitError = null;

function gitLsFiles(args) {
	const r = spawnSync('git', ['ls-files', '-z'].concat(args), {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	});
	if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
		gitError = (r.error && r.error.message) ||
			(r.stderr || '').trim() || ('git 退出码 ' + r.status);
		return null;
	}
	gitError = null;
	return r.stdout.split('\0').filter(Boolean);
}

/*
 * 读取 git 索引权限位，返回 { 路径: 模式 }；无 git 命令或当前目录不是 git 仓库时
 * 返回 null，由调用方降级处理。用 spawnSync 传参数组，避免 Windows cmd 与 POSIX sh
 * 的引号差异，也避免路径被 shell 二次解释。
 */
function readIndexModes(files) {
	const records = gitLsFiles(['-s', '--'].concat(files));
	if (!records) return null;

	const entries = {};
	records.forEach(function (rec) {
		const m = /^(\d{6}) \S+ (\d+)\t([\s\S]+)$/.exec(rec);
		/* 只认 stage 0：合并冲突态下同一路径会有 1/2/3 三条，不能任取一条 */
		if (m && m[2] === '0') entries[m[3]] = m[1];
	});
	return entries;
}

/*
 * 返回不符合 100755 的条目说明数组（空数组代表全部通过）。
 * 优先信任 git 索引：Windows 工作区没有可执行位概念，只有索引模式能反映真实提交内容；
 * 无 git 时在 POSIX 上退回文件系统模式，Windows 则不做断言（CI 始终有 git）。
 * 降级必须出声：否则本地 Windows 无 git 时门禁会变成显示 PASS 的空操作。
 */
function collectModeProblems(files) {
	const list = files || REQUIRED_EXECUTABLES;
	const modes = readIndexModes(list);
	const bad = [];
	const skipWin = !modes && process.platform === 'win32';

	if (!modes) {
		console.warn('  warn  未能读取 git 索引（' + gitError + '），权限位校验降级' +
			(skipWin ? '：Windows 无可执行位概念，本轮不做权限断言' : '：退回文件系统模式'));
	}

	list.forEach(function (f) {
		if (modes) {
			if (!modes[f]) {
				bad.push(f + ' -> git 索引无 stage 0 条目（未跟踪、已删除或处于合并冲突态）');
			} else if (modes[f] !== '100755') {
				bad.push(f + ' -> 权限位为 ' + modes[f] +
					'（必须为 100755；执行 git update-index --chmod=+x ' + f + ' 修复）');
			}
			return;
		}

		const full = path.join(ROOT, f);
		if (!fs.existsSync(full)) {
			bad.push(f + ' -> 文件不存在');
			return;
		}
		if (skipWin) return;
		if ((fs.statSync(full).mode & 0o111) === 0) {
			bad.push(f + ' -> 文件缺少执行权限位 (+x)');
		}
	});

	return bad;
}

module.exports = {
	ROOT: ROOT,
	REQUIRED_EXECUTABLES: REQUIRED_EXECUTABLES,
	isValidShebang: isValidShebang,
	readIndexModes: readIndexModes,
	collectModeProblems: collectModeProblems
};
