'use strict';

/* Rust 后端版本与包版本联动的一致性检查（纯 Node，无外部依赖）。
 *
 * 背景：后端自报版本曾长期停在 `Cargo.toml` 的 1.29.0，与 `PKG_VERSION` 分叉，
 * 排障时无法从 `--version` 或启动日志判断设备上跑的是哪一版后端。
 * 现在版本号只有 `PKG_VERSION` 一个来源，经顶层 Makefile → src/Makefile →
 * cargo 环境变量 → `main.rs` 的 `VERSION` 常量一路传下去；
 * 本脚本把这条链逐环钉住，任何一环被改回「写死」或「跳过注入」都会失败。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = function (rel) {
	return fs.readFileSync(path.join(root, rel), 'utf8');
};

const makefile = read('Makefile');
const srcMakefile = read('src/Makefile');
const cargoToml = read('src/rust/Cargo.toml');
const cargoLock = read('src/rust/Cargo.lock');
const mainRs = read('src/rust/src/main.rs');

/* 一、单一来源：顶层 Makefile 的 PKG_VERSION */
const pkg = makefile.match(/^PKG_VERSION:=([0-9]+(?:\.[0-9]+)+)$/m);
assert(pkg, 'Makefile 缺少合法的 PKG_VERSION');
const pkgVersion = pkg[1];
assert(makefile.indexOf('export MT5700_VERSION:=$(PKG_VERSION)') >= 0,
	'顶层 Makefile 必须 export MT5700_VERSION:=$(PKG_VERSION)，否则子 make 拿不到版本号');

/* 二、注入：src/Makefile 把版本传给 cargo，并在缺省时解析上级 Makefile */
assert(srcMakefile.indexOf('MT5700_VERSION="$(MT5700_VERSION)"') >= 0,
	'src/Makefile 的 cargo build 必须显式传入 MT5700_VERSION');
assert(srcMakefile.indexOf("s/^PKG_VERSION:=//p") >= 0,
	'src/Makefile 缺少「从上级 Makefile 解析 PKG_VERSION」的兜底');
assert(srcMakefile.indexOf('$(CURDIR)/../Makefile') >= 0,
	'兜底解析必须指向上级 Makefile（OpenWrt 会把包目录连同 Makefile 一起拷进 build_dir）');

/* 三、消费：main.rs 优先注入值，保留 Cargo.toml 回退 */
assert(mainRs.indexOf('option_env!("MT5700_VERSION")') >= 0,
	'main.rs 的 VERSION 必须优先读取 option_env!("MT5700_VERSION")');
assert(mainRs.indexOf('env!("CARGO_PKG_VERSION")') >= 0,
	'main.rs 必须保留 Cargo.toml 版本作为本地构建回退');
assert(mainRs.indexOf('const VERSION: &str = env!("CARGO_PKG_VERSION");') < 0,
	'VERSION 不得退回只读 Cargo.toml（那会让二进制自报版本与包版本分叉）');

/* 四、元数据对齐：Cargo.toml 与 Cargo.lock 不得落后于 PKG_VERSION */
const tomlVer = cargoToml.match(/^version = "([0-9]+(?:\.[0-9]+)+)"$/m);
assert(tomlVer, 'Cargo.toml 缺少合法的 version');
assert(tomlVer[1] === pkgVersion,
	'Cargo.toml 版本（' + tomlVer[1] + '）必须与 PKG_VERSION（' + pkgVersion + '）一致');
const lockVer = cargoLock.match(/name = "at-webserver"\nversion = "([0-9]+(?:\.[0-9]+)+)"/);
assert(lockVer, 'Cargo.lock 缺少 at-webserver 条目');
assert(lockVer[1] === pkgVersion,
	'Cargo.lock 版本（' + lockVer[1] + '）必须与 PKG_VERSION（' + pkgVersion + '）一致，否则 cargo --locked 会失败');

console.log('rust version linkage (' + pkgVersion + '): 10 checks passed');
