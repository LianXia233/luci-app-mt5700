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
 * 这些脚本由 procd（init.d）、uci-defaults、hotplug、CI 构建入口、测试 harness
 * 或按路径直接调用，一旦在 git 索引里丢失 100755 就会 Permission denied
 * （曾发生：跨平台补 SPDX 头时把 on-uplink.sh 提交成 100644）。
 * 覆盖仓库全部 100755 入口；执行入口目录内的新增文件由 EXEC_ONLY_DIRS
 * 反向断言强制登记，不依赖人工自觉。
 */
const REQUIRED_EXECUTABLES = [
	'root/etc/init.d/at-webserver',
	'root/etc/uci-defaults/at-webserver',
	'root/etc/hotplug.d/iface/99-at-webserver',
	'root/etc/hotplug.d/usb/99-at-webserver',
	'root/usr/libexec/at-webserver/on-uplink.sh',
	'scripts/sdk-build.sh',
	'tests/iface/interface-selection.sh',
	'tests/mock-modem/e2e-test.js',
	'tests/mock-modem/mock-modem.js',
	'tests/mock-modem/mock-uci',
	'tests/mock-modem/run-e2e.sh',
	'tests/mock-modem/run-sim.sh'
];

/*
 * 清单中不由 /bin/sh|bash 解释的入口：这两个走 #!/usr/bin/env node。
 * 权限位同样必须保住，但不能用 shell 的 shebang 规则去判它们——否则
 * 「必须可执行」与「必须是 shell」两个职责耦合成一份清单，非 shell 入口
 * 就永远无法登记。新增非 shell 可执行文件时在此登记，漏登记会被 shebang
 * 断言直接判失败（fail loud，不会静默放过）。
 */
const NON_SHELL_EXECUTABLES = [
	'tests/mock-modem/e2e-test.js',
	'tests/mock-modem/mock-modem.js'
];

const SHELL_SCRIPTS = REQUIRED_EXECUTABLES.filter(function (f) {
	return NON_SHELL_EXECUTABLES.indexOf(f) < 0;
});

/*
 * 这些目录下的文件按定义就是执行入口（procd init.d / uci-defaults 首次配置 /
 * hotplug / libexec 调用脚本）。反向断言：目录内每个 git blob 都必须登记进
 * REQUIRED_EXECUTABLES。本仓库执行位回退已发生多次（init.d 两次、on-uplink.sh
 * 一次），「新增时记得登记」的注释约束正是历史上失效的那种，因此把登记完整性
 * 本身也变成断言：新增同类脚本忘记登记会直接失败，而不是静默漏过。
 */
const EXEC_ONLY_DIRS = [
	'root/etc/init.d',
	'root/etc/uci-defaults',
	'root/etc/hotplug.d',
	'root/usr/libexec'
];

/*
 * 合法 Shebang：/bin/sh 或 /bin/bash，允许带参数（init.d 使用
 * `#!/bin/sh /etc/rc.common`）。用 (?=\s|$) 做边界限定，拒绝
 * `#!/bin/shfoo` / `#!/bin/bashx`：内核会把它们当成另一个解释器路径，
 * 在目标设备上直接执行失败。
 */
const SHEBANG_RE = /^#!\s*\/bin\/(?:sh|bash)(?=\s|$)/;

/* UTF-8 BOM：字符串形态是 U+FEFF，字节形态是 EF BB BF */
function hasUtf8Bom(input) {
	if (typeof input === 'string') return input.charCodeAt(0) === 0xFEFF;
	return input[0] === 0xEF && input[1] === 0xBB && input[2] === 0xBF;
}

/*
 * 内核只认文件头两字节的 `#!`，所以首行不能 trim：BOM 与前导空格/Tab 都会
 * 让 execve 返回 ENOEXEC（hotplug / uci-defaults 由 procd 直接 execve，即失败），
 * 而 trim 会把它们吃掉造成假阴性。BOM+LF 不含 \r\n，行尾检查也拦不住。
 * `#! /bin/sh` 这种解释器路径前的空格内核是允许的，故保留 \s*；只去掉行尾 CR。
 */
function isValidShebang(content) {
	const s = String(content);
	if (hasUtf8Bom(s)) return false;
	return SHEBANG_RE.test(s.split('\n')[0].replace(/\r$/, ''));
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

/*
 * 反向断言：EXEC_ONLY_DIRS 内所有 git blob 都必须已登记。返回未登记路径说明
 * 数组（空数组代表全部通过）。无 git 时无法枚举，出声告警后跳过。
 */
function collectUnregisteredProblems() {
	const records = gitLsFiles(['--'].concat(EXEC_ONLY_DIRS));
	if (!records) {
		console.warn('  warn  未能枚举执行入口目录（' + gitError + '），登记完整性断言跳过');
		return [];
	}

	const bad = [];
	records.forEach(function (p) {
		if (REQUIRED_EXECUTABLES.indexOf(p) < 0) {
			bad.push(p + ' -> 位于必须可执行的目录但未登记到 REQUIRED_EXECUTABLES' +
				'（登记后才会校验其 100755 与 Shebang）');
		}
	});
	return bad;
}

module.exports = {
	ROOT: ROOT,
	REQUIRED_EXECUTABLES: REQUIRED_EXECUTABLES,
	SHELL_SCRIPTS: SHELL_SCRIPTS,
	EXEC_ONLY_DIRS: EXEC_ONLY_DIRS,
	hasUtf8Bom: hasUtf8Bom,
	isValidShebang: isValidShebang,
	readIndexModes: readIndexModes,
	collectModeProblems: collectModeProblems,
	collectUnregisteredProblems: collectUnregisteredProblems
};
