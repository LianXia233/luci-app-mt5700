#!/usr/bin/env node
/*
 * init.d 服务管理契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 背景（2026-09-21 真机实测，三个真实缺陷）：
 *
 *   ① `ubus -q call` 是无效写法 —— busybox 的 ubus 根本没有 -q 选项，
 *      实测报 "unrecognized option: q" 并返回 1。于是 init.d 里那两个
 *      「已在运行 → 跳过」与「已注册未运行 → 清注册再登记」判断**恒为假**，
 *      后者正是 procd 崩溃-重试耗尽后唯一的自救路径，等于从来没有生效过。
 *
 *   ② 把 ① 修好之后反而更糟：rc.common 对 procd 服务的 start 是
 *      `rc_procd start_service` → `procd_open_service` →
 *      `ubus call service set {... "instances": {} ...}`，这个调用会把实例表清空，
 *      procd 随即 SIGTERM 运行中的实例（5s 后 SIGKILL）。此时若「已在运行 → 跳过」，
 *      就是「旧实例被杀 + 没有新实例注册」= 服务直接消失。
 *      实测日志特征：procd: Instance at-webserver::instance1 pid N not stopped on
 *      SIGTERM, sending SIGKILL instead。⇒ start 里不能有 early-return。
 *
 *   ③ reload 里用 `ubus call service delete` 停旧实例，删掉的是**整个服务对象**，
 *      随后 start_service 的 procd_open_instance 注册在一个正在被删除的对象上，
 *      服务收尾时把新实例一并清掉 —— reload 返回 0、日志正常，进程却没了。
 *
 * 这个测试把三条结论钉死在源码文本上，防止哪天又「顺手加回一个跳过」。
 * 断言一律做「定位」（看某个函数体里有没有），不做计数式；比较代码时先剥掉注释行，
 * 否则注释里举例提到的写法会被误判。反向断言用注入的方式验证守卫不是恒绿。
 *
 * 运行：node tests/initd-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INITD = 'root/etc/init.d/at-webserver';
const SRC = fs.readFileSync(path.join(ROOT, INITD), 'utf8');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}

/* 剥掉整行注释：注释里会举例提到 `ubus -q`、`ubus call service delete`
   这些"恰恰不能出现在代码里"的写法，比较代码时必须先去掉。 */
function stripComments(s) {
	return s.split('\n').filter(function (l) { return !/^\s*#/.test(l); }).join('\n');
}
const CODE = stripComments(SRC);

/* 取一个 shell 函数的函数体（从 `name() {` 到行首的 `}`） */
function body(s, name) {
	const re = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(\\) \\{', 'm');
	const m = s.match(re);
	if (!m) return null;
	const rest = s.slice(m.index + m[0].length);
	const end = rest.search(/^\}/m);
	return end < 0 ? rest : rest.slice(0, end);
}
/* 函数体里的可执行代码（去注释） */
function bodyCode(s, name) {
	const b = body(s, name);
	return b === null ? null : stripComments(b);
}

/* ---------- 1. `ubus -q` 必须彻底绝迹（只在非注释代码里判） ---------- */
const ubusQ = stripComments(SRC).split('\n').filter(function (l) { return /ubus\s+-q\b/.test(l); });
ok('代码中不再出现无效的 ubus -q（busybox ubus 无 -q 选项）',
	ubusQ.length === 0, ubusQ[0] ? ubusQ[0].trim() : '');
ok('注释里留了 ubus -q 的教训（不能被静默删掉）',
	/ubus -q/.test(SRC) && /unrecognized option|无效选项|没有 -q/.test(SRC));

/* ---------- 2. start 里不能有 early-return（rc.common 已把实例表清空） ---------- */
const startCode = bodyCode(SRC, 'start_service');
ok('能定位到 start_service 函数体', startCode !== null);
ok('★ start_service 里不得有「已在运行 → 跳过」的早退（否则服务被停掉且不再拉起）',
	startCode !== null && !/跳过重复启动/.test(startCode) && !/is already running/.test(startCode));
ok('start_service 里保留了「rc.common 会先清空实例表」的原因说明',
	body(SRC, 'start_service') !== null && /procd_open_service|service set/.test(body(SRC, 'start_service')));

/* ---------- 3. 崩溃循环自愈：判据必须兼容两种 ubus 输出 ---------- */
ok('崩溃循环自愈的 running 判据是宽松写法（pretty / -S 紧凑都能命中）',
	/"running"\[\[:space:\]\]\*:\[\[:space:\]\]\*true/.test(SRC));
ok('崩溃循环自愈：先摘旧注册再重新登记',
	/崩溃循环放弃态/.test(SRC) && startCode !== null && /ubus call service delete/.test(startCode));

/* ---------- 4. reload 必须走标准 start，不能自己 delete 服务对象 ---------- */
const reloadCode = bodyCode(SRC, 'reload_service');
ok('能定位到 reload_service 函数体', reloadCode !== null);
ok('★ reload_service 不得调用 ubus call service delete（会连服务对象一起删）',
	reloadCode !== null && !/ubus call service delete/.test(reloadCode));
ok('reload_service 通过标准 start 路径重启（procd_open_service + start_service）',
	reloadCode !== null && /^\s*start "\$@"\s*$/m.test(reloadCode));

/* ---------- 5. 新增能力必须真的挂上去 ---------- */
const ensureEnabledBody = body(SRC, 'ensure_enabled');
ok('ensure_enabled 已定义', ensureEnabledBody !== null);
ok('ensure_enabled 在 start_service 里被调用（开机自启自愈）',
	startCode !== null && /ensure_enabled/.test(startCode));
ok('ensure_enabled 先补执行位再 enable（丢 +x 是实机故障）',
	ensureEnabledBody !== null && /chmod 0755/.test(ensureEnabledBody) && /enable/.test(ensureEnabledBody));
/* ★ 调用位置：必须在 enabled 检查之后。否则用户禁用状态下 start 会把 S99 补回来，
   界面显示「已启用」而开机又因 enabled=0 退出 —— 两个结论互相矛盾。 */
ok('★ ensure_enabled 只在 enabled 检查之后调用（禁用时不补自启链接）',
	startCode !== null &&
	startCode.indexOf('config_get_bool enabled') >= 0 &&
	startCode.indexOf('ensure_enabled') > startCode.indexOf('config_get_bool enabled'));
/* 取函数定义**上方**的注释块（能力边界这类说明写在函数头，不在函数体内） */
function headComment(s, name) {
	const re = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(\\) \\{', 'm');
	const m = s.match(re);
	if (!m) return '';
	return s.slice(0, m.index).split('\n').slice(-30).join('\n');
}
ok('ensure_enabled 注释里写明了能力边界（执行位丢失时它救不了）',
	/边界/.test(headComment(SRC, 'ensure_enabled')) &&
	/跑不起来|没机会跑/.test(headComment(SRC, 'ensure_enabled')));

const ifaceAddrBody = bodyCode(SRC, 'iface_has_address');
ok('iface_has_address 已定义', ifaceAddrBody !== null);
ok('就绪判据匹配「数组里有元素」而不是关键字本身（空数组 [] 不能命中）',
	ifaceAddrBody !== null && /ipv4-address\|ipv6-address/.test(ifaceAddrBody) &&
		/\\\[\[\[:space:\]\]\*\\\{/.test(ifaceAddrBody));

const ensureIfaceCode = bodyCode(SRC, 'ensure_modem_interface');
ok('ensure_modem_interface 用 iface_has_address 判断就绪（不再用 "up": true）',
	ensureIfaceCode !== null && /iface_has_address/.test(ensureIfaceCode));
ok('★ 不再写「已就绪（等待 Ns 后拿到地址）」这种 up=true 造成的假成功',
	!/已就绪（等待/.test(CODE));

ok('每次启动都核对 wan 区登记（接口已存在但漏登记时补）',
	ensureIfaceCode !== null && /ensure_wan_zone "\$i"/.test(ensureIfaceCode));
ok('ensure_wan_zone 仍是幂等实现（列表里已有就返回，不重载防火墙）',
	/case " \$list " in[\s\S]*?\*" \$iface "\*\) return 0/.test(SRC));

/* ---------- 6. ensure_interfaces 子命令必须零副作用 ---------- */
/* ★ 2026-10-26：EXTRA_COMMANDS 现在是 "ensure_interfaces selfheal"，
   断言改成「两者都在」而不是精确等于 —— 新增自愈子命令不该让这条守卫失效。 */
ok('EXTRA_COMMANDS 暴露 ensure_interfaces',
	/EXTRA_COMMANDS="[^"]*\bensure_interfaces\b/.test(SRC));
const ensureInterfacesCode = bodyCode(SRC, 'ensure_interfaces');
ok('能定位到 ensure_interfaces 函数体', ensureInterfacesCode !== null);
ok('★ ensure_interfaces 不重启后端：不得出现 killall / restart / ubus call service delete',
	ensureInterfacesCode !== null &&
	!/killall/.test(ensureInterfacesCode) &&
	!/\brestart\b/.test(ensureInterfacesCode) &&
	!/service delete/.test(ensureInterfacesCode));
ok('ensure_interfaces 复用 ensure_modem_interface（与开机路径同源）',
	ensureInterfacesCode !== null && /ensure_modem_interface/.test(ensureInterfacesCode));

/* ---------- 7. uci-defaults 的说明不能与实现脱节 ---------- */
const UCI_DEFAULTS = fs.readFileSync(path.join(ROOT, 'root/etc/uci-defaults/at-webserver'), 'utf8');
ok('uci-defaults 不再声称 start_service 内部有「已在运行则跳过」保护',
	!/内部有[^\n]*跳过/.test(UCI_DEFAULTS));
ok('uci-defaults 安装期会先 ensure_interfaces 再 start（存量设备补 wan 区）',
	/ensure_interfaces/.test(UCI_DEFAULTS) && /start/.test(UCI_DEFAULTS));
ok('uci-defaults 的接口对齐放在后台跑（不拖住包管理器）',
	/^\s*\(\s*$/m.test(UCI_DEFAULTS) || /\)\s*>\s*\/dev\/null 2>&1 &/.test(UCI_DEFAULTS));

/* ---------- 8. 反向断言：守卫本身必须能检出违规 ---------- */
function hasUbusQ(s) { return /ubus\s+-q\b/.test(stripComments(s)); }
function startHasSkip(s) {
	const b = bodyCode(s, 'start_service');
	return b !== null && /跳过重复启动/.test(b);
}
function reloadHasDelete(s) {
	const b = bodyCode(s, 'reload_service');
	return b !== null && /ubus call service delete/.test(b);
}
ok('★ 反向：把 ubus -q 塞回代码，守卫必须检出',
	hasUbusQ(SRC) === false &&
	hasUbusQ('# ubus -q 只许出现在注释里\nubus -q call service list\n') === true);
ok('★ 反向：(去注释后)注入「跳过重复启动」必须被检出',
	startHasSkip(SRC) === false &&
	startHasSkip(SRC.replace('\tlogger -t at-webserver "配置 procd 实例..."',
		'\tlogger -t at-webserver "服务已在运行，跳过重复启动"')) === true);
ok('★ 反向：注入 ubus call service delete 到 reload_service 必须被检出',
	reloadHasDelete(SRC) === false &&
	reloadHasDelete(SRC.replace('\tstart "$@"',
		'\tubus call service delete \'{"name":"at-webserver"}\'\n\tstart "$@"')) === true);
ok('★ 反向：body() 对不存在的函数返回 null（否则上面定位断言会恒真）',
	body(SRC, 'no_such_function_here') === null && body(SRC, 'start_service') !== null);

function ensureEnabledBeforeCheck(s) {
	const b = stripComments(body(s, 'start_service') || '');
	const iEn = b.indexOf('ensure_enabled');
	const iChk = b.indexOf('config_get_bool enabled');
	return iEn >= 0 && iChk >= 0 && iEn < iChk;
}
ok('★ 反向：把 ensure_enabled 挪到 enabled 检查之前必须被检出',
	ensureEnabledBeforeCheck(SRC) === false &&
	ensureEnabledBeforeCheck(SRC
		.replace('\tensure_enabled\n', '')
		.replace('\tlogger -t at-webserver "开始启动服务..."',
			'\tlogger -t at-webserver "开始启动服务..."\n\tensure_enabled')) === true);

/* ---------- 汇总 ---------- */
if (fails.length) {
	console.log('✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（init.d 服务管理契约成立）');
