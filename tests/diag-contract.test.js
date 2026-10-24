#!/usr/bin/env node
/*
 * 断网排查（三层）契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-09-19：「连接工具」里的 6 步连通性自检 → 扩成三层 33 项的断网排查。
 *
 * 为什么要单独一个测试文件：
 *   这条链路横跨四个文件（前端注册表 / ucode 方法 / ACL / 只读采集脚本），
 *   任何一端改形都会让排查「看起来正常、实际查了个寂寞」，而这类故障
 *   在真机上表现为「点开始排查没反应 / 全是待检查」，很难一眼看出是哪端断的。
 *
 * 本测试覆盖：
 *   ① 采集脚本 diag-probe.sh：只读、不接受参数、探测带超时、未知给 -1
 *   ② 事实键一致性：前端用到的每个 key，脚本里必须真的 emit 了
 *   ③ 判定正确性：喂「健康 / 故障」两套事实，关键项必须翻转
 *   ④ 后端通路：ucode sysdiag 无参数、ACL 放行、rpc 声明、超时常量
 *   ⑤ 前端：注册表完整（层 id 合法、项名不重复）、只给建议不自动修
 *
 * 运行：node tests/diag-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NS_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
const PROBE = path.join(ROOT, 'root', 'usr', 'share', 'mt5700', 'diag-probe.sh');
const UCODE = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const ACL = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json');
const RPC_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const CSS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css');

const nsSrc = fs.readFileSync(NS_JS, 'utf8');
const probeSrc = fs.readFileSync(PROBE, 'utf8');
const ucSrc = fs.readFileSync(UCODE, 'utf8');
const aclSrc = fs.readFileSync(ACL, 'utf8');
const rpcSrc = fs.readFileSync(RPC_JS, 'utf8');
const cssSrc = fs.readFileSync(CSS, 'utf8');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}

/* 按括号配对抠出整个函数（改名请同步本测试） */
function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name + '（改名请同步本测试）');
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}

/* ---------- 1. diag-probe.sh：只读、无参数、带超时 ---------- */

ok('采集脚本存在且是 sh', /^#!\/bin\/sh/.test(probeSrc));

/* 脚本里唯一合法使用位置参数的地方就是函数自己的入参
   （emit 的 $2、have_cmd 的 $1、两个 config_foreach 回调的 $1、to 的 "$@"）。
   把这些函数体抠掉后再看主体有没有碰位置参数 —— 这是唯一可能的注入面。
   ★ 2026-10-24 加入 to()：它只是把入参原样转交给限时器（timeout 或随包替代），
     不读取脚本自己的 $1/$@，与 emit/have_cmd 同类，不属于注入面。 */
function stripFn(src, name) {
	const marker = name + '() {';
	const a = src.indexOf(marker);
	if (a < 0) return src;
	let depth = 0, begun = false, end = a;
	for (let i = a; i < src.length; i++) {
		if (src[i] === '{') { depth++; begun = true; }
		else if (src[i] === '}') { depth--; if (begun && depth === 0) { end = i + 1; break; } }
	}
	return src.slice(0, a) + src.slice(end);
}
const probeBody = ['emit', 'have_cmd', 'scan_zone', 'scan_sqm', 'to'].reduce(stripFn, probeSrc)
	/* ★ 还要剥掉单引号区段：awk 程序里的 $1/$2/$3 是**awk 的字段引用**，
	   不是 shell 位置参数（不剥会把 5 处 awk 全误判成"脚本接受了参数"）。 */
	.replace(/'[^']*'/g, "''");

/* 去掉纯注释行：源码注释里会**刻意**提到被废弃的写法（stat -c、nc -z），
   那是留给后来人的教训，不能被当成"你还在用这个命令"。 */
const probeCode = probeSrc.split('\n')
	.filter(function (l) { return !/^\s*#/.test(l); })
	.join('\n');
ok('★ 脚本主体不接受任何参数（无 $1/$@/$*，命令注入面为零）',
	!/\$\d/.test(probeBody) && !/\$@/.test(probeBody) && !/\$\*/.test(probeBody),
	(probeBody.match(/\$[\d@*]/g) || []).join(' '));
/* ★ 扫描器自检：往主体里塞一个 $1，必须被抓出来（否则上面恒绿＝假守卫） */
ok('★ 参数扫描器自检：主体里出现 $1 必须被判出（防假守卫）',
	/\$\d/.test(probeBody + '\necho "$1"'));

/* 只读底线：这些一旦出现，排查就从"体检"变成"会改配置的脚本" */
const WRITE_PAT = [
	['uci set', /uci\s+set/],
	['uci commit', /uci\s+commit/],
	['uci delete', /uci\s+delete/],
	['uci add', /uci\s+add/],
	['reboot', /\breboot\b/],
	['ifup / ifdown', /\b(ifup|ifdown)\b/],
	['service restart', /service\s+\S+\s+(restart|stop|reload)/],
	['写文件的重定向', />\s*\/etc\//],
	['rm', /\brm\s+-/],
	['AT 写命令', /AT\+(CFUN|CPIN|CLCK|CGDCONT|CMGD)\s*=/]
];
WRITE_PAT.forEach(function (p) {
	ok('★ 采集脚本不含「' + p[0] + '」（只读底线）', !p[1].test(probeSrc));
});

ok('★ 网络探测都带 timeout（不设会把 rpcd 工作线程挂住）',
	/timeout "\$PROBE_TIMEOUT"/.test(probeSrc) || /ping -c1 -W "\$PROBE_TIMEOUT"/.test(probeSrc));
ok('★ 探测目标写死为公网 IP（本机装过 mosdns/OpenClash，拿域名探测会被误导）',
	/119\.29\.29\.29/.test(probeSrc) && /223\.5\.5\.5/.test(probeSrc)
	&& !/ping[^\n]*www\./.test(probeSrc));
ok('★ 探测不到时输出 -1（未知）而不是 0（假失败）', /emit ping_gw -1/.test(probeSrc));
ok('★ 明确覆盖「刷机后缺接口」这个高复发故障（iface_exists + iface_auto）',
	/emit iface_exists/.test(probeSrc) && /emit iface_auto/.test(probeSrc));
ok('★ 明确覆盖「网关 ARP INCOMPLETE」这个静默断网形态',
	/emit gw_neigh/.test(probeSrc));
ok('★ 明确覆盖「init.d 是 100644 不自启」这个高复发故障',
	/emit initd_exec/.test(probeSrc));
/* ★★ 真机坑：这台设备上 busybox 没有编 stat，`stat -c '%a'` 拿回空串，
   会把一台正常的机器报成「缺执行位」。判据必须走 [ -x ]。 */
ok('★ 不依赖 stat 命令（该设备上不存在，会静默返回空值）',
	!/stat -c/.test(probeCode) && /\[ -x \/etc\/init\.d\/at-webserver \]/.test(probeCode));
ok('★ 权限位取 ls -l 的 rwx 串（stat 不可用时的可移植写法）',
	/ls -l \/etc\/init\.d\/at-webserver[^|]*\| cut -c1-10/.test(probeCode));

ok('★ 明确覆盖 USB 链路速率（开机 480M → 后来 5000M 那个坑）',
	/emit usb_speed/.test(probeSrc) && /emit usb_version/.test(probeSrc));
/* ★★ 真机坑：直接取最大值会取到**根 Hub**（本机 usb2 报 20000，而真实模组
   2-1 只有 5000），排查界面会显示一条高三倍的假速率，问题被完全掩盖。 */
ok('★ USB 速率排除集线器（bDeviceClass=09，否则会取到根 Hub 的 20000）',
	/bDeviceClass" 2>\/dev\/null\)" = "09"/.test(probeSrc));
ok('★ USB 速率排除 usbN 根节点（双保险）',
	/case "\$\{d\#\#\*\/\}" in usb\*\) continue ;; esac/.test(probeSrc));
ok('★ 带上 USB 设备名（一眼确认取到的是不是模组）', /emit usb_product/.test(probeSrc));

/* ★★ 两个真机坑：busybox 的 nc 不支持 -z；119.29.29.29:443 不开 HTTPS（curl rc=28） */
ok('★ 不用 nc -z（busybox 的 nc 不支持，永远返回 1 → 天天误报）',
	!/nc -z/.test(probeCode));
/*
 * ★ 2026-09-28 修：这条断言原来把超时值也锁死了（`--max-time 4`），而断言名说的意图
 *   只是「改走 curl（而不是 busybox 的 nc -z）」。锁死实现细节的后果是：
 *   `diag-probe.sh` 里那个 `TCP_TIMEOUT=4` 常量**全脚本只被定义、从没被引用** ——
 *   有人硬编码了 4、守卫再把 4 锁死，于是常量成了死的、改它也不生效还没人发现。
 *   现在改为断言「引用了 TCP_TIMEOUT 常量」，改回硬编码会立刻判红。
 */
ok('★ HTTPS 探测改走 curl（该设备上可用，退出码可区分"连上但证书不认"）',
	/curl -s -o \/dev\/null --max-time "?\$TCP_TIMEOUT"? https:\/\/www\.qq\.com/.test(probeSrc));

/* 防"死常量"：三个探测超时常量都必须真的被引用（定义处各算一次） */
/* 计数用的是 `$NAME`（带美元号的**引用**）；定义处 `NAME=4` 不算，所以门槛是 ≥1 */
['PROBE_TIMEOUT', 'NS_TIMEOUT', 'TCP_TIMEOUT'].forEach(function (name) {
	const n = (probeSrc.match(new RegExp('\\$' + name, 'g')) || []).length;
	ok('★ ' + name + ' 常量真的被引用（≥1 处；只定义不用 = 改它不生效）',
		n >= 1, '实际引用 ' + n + ' 处');
});
ok('★ curl 退出码 6（解析失败）单独区分，不算到链路上',
	/6\) emit tcp_443 6/.test(probeSrc));

/* ---------- 2. 事实键一致性 ---------- */

const sysChecksSrc = extractFn(nsSrc, 'sysChecks');
/* 前端用到的每个事实键：fv(f, 'x') / fnum(f, 'x' */
const KEYS = [];
sysChecksSrc.replace(/(?:fv|fnum)\(f, '([a-z0-9_]+)'/g, function (m, k) {
	if (KEYS.indexOf(k) < 0) KEYS.push(k);
	return m;
});
ok('扫到了事实键（扫描器没哑火）', KEYS.length >= 25, '实际 ' + KEYS.length + ' 个');
const missing = KEYS.filter(function (k) {
	return !new RegExp("emit " + k + " ").test(probeSrc);
});
eq('★ 前端用到的每个事实键，脚本里都真的 emit 了', missing, []);

/* ★ 扫描器自检：喂一个不存在的键，必须被抓出来 ——
   否则上面的断言会因为"一个都扫不到"而恒绿（假守卫）。 */
const fakeSrc = sysChecksSrc + "\n// fv(f, 'this_key_does_not_exist')";
const fakeKeys = [];
fakeSrc.replace(/(?:fv|fnum)\(f, '([a-z0-9_]+)'/g, function (m, k) {
	if (fakeKeys.indexOf(k) < 0) fakeKeys.push(k);
	return m;
});
ok('★ 键扫描器自检：喂不存在的键必须被判缺失（防假守卫）',
	fakeKeys.indexOf('this_key_does_not_exist') >= 0
	&& !new RegExp("emit this_key_does_not_exist ").test(probeSrc));

/* ---------- 3. 判定正确性（喂两套事实真跑） ---------- */

/* eslint-disable no-eval */
/* ★ maxModuleTemp 是「模组温度」的取法（12 路取最高）。排查项现在直接调它，
   而 sysChecks 是被扣出来单独 eval 的 —— 不把它一起注入，eval 里就会
   ReferenceError → 那一项判成 THREW，断言全红。这里给一份同签名的实现。 */
function maxModuleTempImpl(temps) {
	const t = temps || {};
	const vals = [];
	for (const k in t) { const n = Number(t[k]); if (n > 0) vals.push(n); }
	return { max: vals.length ? Math.max.apply(null, vals) : null, vals: vals };
}
const sysChecks = new Function('fv', 'fnum', 'maxModuleTemp',
	extractFn(nsSrc, 'fv') + '\n' + extractFn(nsSrc, 'fnum') + '\n'
	+ extractFn(nsSrc, 'maxModuleTemp') + '\n'
	+ sysChecksSrc + '\nreturn sysChecks;')(
	function (f, k) { const v = f[k]; return (v == null) ? '' : String(v); },
	function (f, k, d) {
		const s = (f[k] == null) ? '' : String(f[k]);
		if (s === '') return d;
		const n = parseFloat(s);
		return isNaN(n) ? d : n;
	},
	maxModuleTempImpl)();

const HEALTHY = {
	svc_at_running: '1', svc_at_enabled: '1', initd_mode: '-rwxr-xr-x', initd_exec: '1',
	ttyusb_count: '4',
	usb_speed: '5000', usb_path: '2-1', usb_version: '3.00',
	iface_name: 'MT5700M', iface_device: 'eth2', iface_exists: '1', iface_auto: '1',
	iface_up: '1', iface_pending: '0', iface_addr: '10.1.1.2', iface_mtu: '1500',
	route_dev: 'eth2', route_gw: '10.1.1.1', route_count: '1', gw_neigh: 'REACHABLE',
	fw_wan_cover: '1', fw_wan_nets: 'wan wan6 MT5700M',
	dns_servers: '119.29.29.29,223.5.5.5', dnsmasq_running: '1',
	sqm_enabled: '0', sqm_iface: '', flow_offload: '1', flow_offload_hw: '0',
	/* svc_watchdog 已于 2026-09-20 随看门狗一并删除，不再出现在事实表里 */
	time_synced: '1',
	ping_gw: '1', ping_public_a: '1', ping_public_b: '1', dns_resolve_ok: '1', tcp_443: '1'
};
const HEALTHY_ST = {
	cell: { rsrp: -85, sinr: 15 },
	temps: { sub6GPA: 45, ap1: 48 },
	tools: { diag: { modAddrs: ['10.1.1.2'] } }
};

function run(facts, st) {
	const out = {};
	sysChecks.forEach(function (c) {
		let r;
		try { r = c.eval(facts, st) || {}; } catch (e) { r = { level: 'THREW', text: String(e && e.message) }; }
		out[c.name] = r;
	});
	return out;
}

const good = run(HEALTHY, HEALTHY_ST);
const notOk = Object.keys(good).filter(function (n) { return good[n].level !== 'ok'; });
eq('★ 健康事实 → 全部判 ok（不许把正常状态误报成故障）', notOk, []);

const BROKEN = Object.assign({}, HEALTHY, {
	svc_at_running: '0', initd_exec: '0', ttyusb_count: '0', usb_speed: '480',
	iface_exists: '0', iface_auto: '0', iface_up: '0', iface_addr: '10.1.1.9',
	route_gw: '', gw_neigh: 'INCOMPLETE', fw_wan_cover: '0',
	sqm_enabled: '1', sqm_iface: 'eth1', time_synced: '0',
	ping_gw: '0', ping_public_a: '0', ping_public_b: '0', dns_resolve_ok: '0', tcp_443: '0'
});
const bad = run(BROKEN, Object.assign({}, HEALTHY_ST, { tools: { diag: { modAddrs: ['10.1.1.2'] } } }));

function bad2(name) { return bad[name] && bad[name].level === 'bad'; }
ok('AT 服务没跑 → bad', bad2('AT 服务在运行'));
ok('init.d 没有执行位 → bad（initd_exec=0）', bad2('init.d 脚本权限'));
ok('★ init.d 有执行位时，权限串是 rwx 形式也要判 ok（该设备没有 stat，拿不到 755）',
	good['init.d 脚本权限'].level === 'ok', good['init.d 脚本权限'].text);
ok('没有 /dev/ttyUSB* → bad', bad2('串口设备'));
ok('USB 480M → warn 而不是 bad（开机早期会自己恢复）', bad['USB 链路速率'].level === 'warn');
ok('缺接口 → bad', bad2('接口存在'));
ok('auto=0 → bad', bad2('接口自动拉起'));
ok('接口 DOWN → bad', bad2('接口状态'));
ok('没默认路由 → bad', bad2('默认路由'));
ok('网关 ARP INCOMPLETE → bad', bad2('网关 ARP'));
ok('接口地址与模组不一致 → bad', bad2('接口地址与模组一致'));
ok('防火墙没覆盖 WAN → bad', bad2('防火墙覆盖 WAN'));
ok('SQM 配在 eth1 而出口是 eth2 → bad', bad2('SQM 与分载'));
ok('时间没同步 → bad', bad2('系统时间'));
ok('网关 ping 不通 + 公网也不通 → bad', bad2('ping 网关'));
/* ★ 真机：网关 10.0.0.1 不回应 ICMP，但公网 ping 与 HTTPS 全通。
   这种配置在国内运营商里很常见，判 bad 就是天天报假故障。 */
ok('★ 网关不回应 ICMP 但公网通 → 判 ok（真机就是这种网关）',
	run(Object.assign({}, HEALTHY, { ping_gw: '0' }), HEALTHY_ST)['ping 网关'].level === 'ok');
ok('★ 网关不回应 ICMP 且公网也不通 → 才判 bad',
	run(Object.assign({}, HEALTHY, { ping_gw: '0', ping_public_a: '0', ping_public_b: '0', tcp_443: '0' }),
		HEALTHY_ST)['ping 网关'].level === 'bad');
ok('公网 IP 都 ping 不通 → bad', bad2('ping 公网 IP'));
ok('DNS 解析失败 → bad', bad2('DNS 解析'));
eq('★ curl 退出码 6（解析失败）→ bad 且指路 DNS 项',
	run(Object.assign({}, HEALTHY, { tcp_443: '6' }), HEALTHY_ST)['HTTPS 连通'].level, 'bad');
ok('★ curl 退出码 6 的文案要说明「链路可能是好的，问题在 DNS」',
	/DNS/.test(run(Object.assign({}, HEALTHY, { tcp_443: '6' }), HEALTHY_ST)['HTTPS 连通'].text));

/* 未知（-1）不许被判成故障：这是「判错代价 > 没测到」的硬要求 */
const UNKNOWN = Object.assign({}, HEALTHY, {
	ping_gw: '-1', ping_public_a: '-1', ping_public_b: '-1',
	dns_resolve_ok: '-1', tcp_443: '-1', usb_speed: '-1', ttyusb_count: '-1'
});
const unk = run(UNKNOWN, HEALTHY_ST);
['ping 网关', 'ping 公网 IP', 'DNS 解析', 'HTTPS 连通', 'USB 链路速率'].forEach(function (n) {
	ok('★ ' + n + ' 探测不到（-1）→ 判 warn 不判 bad', unk[n].level === 'warn', unk[n] && unk[n].level);
});
ok('★ 串口数为 0 才判 bad，-1 是"取不到"不该判死', unk['串口设备'].level !== 'bad');

/* 派生项：信号与温度 */
eq('RSRP -85 / SINR 15 → ok',
	run(HEALTHY, { cell: { rsrp: -85, sinr: 15 }, temps: {}, tools: HEALTHY_ST.tools })['信号质量'].level, 'ok');
eq('RSRP -115 → bad',
	run(HEALTHY, { cell: { rsrp: -115, sinr: 10 }, temps: {}, tools: HEALTHY_ST.tools })['信号质量'].level, 'bad');
eq('SINR -3 → warn',
	run(HEALTHY, { cell: { rsrp: -90, sinr: -3 }, temps: {}, tools: HEALTHY_ST.tools })['信号质量'].level, 'warn');
eq('温度 90℃ → bad',
	run(HEALTHY, { cell: {}, temps: { ap1: 90 }, tools: HEALTHY_ST.tools })['模组温度'].level, 'bad');
eq('温度 45℃ → ok',
	run(HEALTHY, { cell: {}, temps: { ap1: 45 }, tools: HEALTHY_ST.tools })['模组温度'].level, 'ok');
eq('温度 70℃ → warn',
	run(HEALTHY, { cell: {}, temps: { ap1: 70 }, tools: HEALTHY_ST.tools })['模组温度'].level, 'warn');
/* 2026-09-19 真机反馈：进页面就自动排查时温度（慢档 30s）还没取到，这项挂「存疑 ·
   还没读到温度」，让人以为温度出了问题。改：① 排查改为点按钮才跑；② 没读到时判
   idle（待检查）—— 那是"没取到"不是"有故障"，也不计入通过/存疑的计数。 */
eq('★ 没读到温度 → idle（不是 warn）',
	run(HEALTHY, { cell: {}, temps: {}, tools: HEALTHY_ST.tools })['模组温度'].level, 'idle');

/* ★ 温度同源（用户 2026-09-19 明确要求：排查项采用「SIM 与设备」卡的 5G模块温度）。
   两处必须走同一个 maxModuleTemp，否则会出现「卡上 48℃、排查说没读到」的自相矛盾。 */
ok('★ 温度取法唯一：maxModuleTemp 定义处接受 temps 参数（好让判定是纯函数）',
	/function maxModuleTemp\(temps\)/.test(nsSrc));
ok('★ 「SIM 与设备」卡的 5G模块温度走 maxModuleTemp（不另算一遍）',
	/var mt = maxModuleTemp\(\);/.test(nsSrc) && /mt\.max \+ ' ℃'/.test(nsSrc));
ok('★ 排查项的温度走传入的 st.temps（纯函数；读闭包 state 会让判定与卡片脱钩、测试也注入不了）',
	/maxModuleTemp\(st && st\.temps\)/.test(nsSrc));
ok('★ 温度判定不再直接遍历 st.temps（那是两处会走偏的旧写法）',
	!/for \(var k in \(st\.temps/.test(nsSrc));
ok('★ 三层计数排除 idle（没取到数据的项不算通过，避免「N/N 全通过」掺假）',
	/i\.done && i\.level !== 'idle'/.test(nsSrc));

/* ---------- 4. 注册表结构 ---------- */

ok('注册表每项都有 layer / name / eval',
	sysChecks.every(function (c) {
		return typeof c.layer === 'string' && typeof c.name === 'string' && typeof c.eval === 'function';
	}));
const LAYERS = sysChecks.map(function (c) { return c.layer; });
ok('层 id 只有 L1/L2/L3（与 DIAG_LAYERS 一致）',
	LAYERS.every(function (l) { return l === 'L1' || l === 'L2' || l === 'L3'; }),
	LAYERS.join(','));
const names = sysChecks.map(function (c) { return c.name; });
eq('项名不重复（重名会让 diagItems 的 done 映射互相覆盖）',
	names.length, new Set(names).size);
ok('★ L1 派生项只有 2 项（信号 / 温度，复用页面读数，不多占 AT 通道）',
	LAYERS.filter(function (l) { return l === 'L1'; }).length === 2);
ok('L2 至少 15 项（系统侧是这次排查的主要增量）',
	LAYERS.filter(function (l) { return l === 'L2'; }).length >= 15,
	String(LAYERS.filter(function (l) { return l === 'L2'; }).length));
ok('L3 是 5 项（网关 / 公网 / DNS / TCP，外加…共 4~6）',
	LAYERS.filter(function (l) { return l === 'L3'; }).length >= 4);

/* L1 的 AT 步数由 connection-tools-contract 守卫，这里只钉「总数」 */
const l1At = (nsSrc.match(/name: '/g) || []).length;
ok('源码里有足够多的检查项（粗筛，防整块被误删）', l1At >= 30, String(l1At));

/* ---------- 5. 后端通路 ---------- */

ok('ucode 注册了 mt5700.sysdiag', /\bsysdiag: \{/.test(ucSrc));
ok('★ sysdiag 不接受任何参数（args: {}，无用户输入面）', /sysdiag: \{\s*\n\s*args: \{\}/.test(ucSrc));
/* ★ 2026-10-24：限时器改经 timeoutBin() 解析（定制固件可能没有 timeout applet），
   约束不变：采集脚本必须被限时器包住。 */
ok('ucode 用限时器包住采集脚本', /popen\(timeoutBin\(\) \+ ' ' \+ DIAG_TIMEOUT/.test(ucSrc));
ok('采集超时 25s（脚本内部最坏约 15s，留足余量）', /const DIAG_TIMEOUT = 25;/.test(ucSrc));
ok('读行数有上限（异常输出不会把响应撑爆）', /const DIAG_MAX_LINES = 200;/.test(ucSrc));
ok('脚本缺失时返回明确错误而不是空结果',
	/系统排查脚本不可用/.test(ucSrc));
ok('★ ACL read 段放行了 sysdiag（漏了就是 rpcd Access denied）',
	/"sysdiag"/.test(aclSrc));
ok('rpc.js 声明了 sysDiag', /sysDiag: fetchSysDiag/.test(rpcSrc)
	&& /method: 'sysdiag'/.test(rpcSrc));
ok('★ rpc 侧有超时兜底（30s）', /withTimeout\(rpcSysDiag\(\), 30000/.test(rpcSrc));
ok('★ 后端没升级时给出明确说明，而不是让按钮点了没反应',
	/rpcd 没有 mt5700\.sysdiag 方法/.test(rpcSrc));
ok('★ 事实取不到时，明细卡明说需要升级设备端（否则「待检查」会被误读成正常）',
	/需要升级设备端的 luci-app-mt5700/.test(nsSrc));

/* ---------- 6. 前端：只诊断不自动修 ---------- */

ok('★ 排查链路里没有任何写命令（CFUN=/CPIN=/CLCK= 都是红线）',
	!/sendCommand\('AT\+(CFUN|CPIN|CLCK|CGDCONT|CMGD|SYSCFGEX)=/.test(nsSrc));
ok('★ 排查只下发只读查询（9 条 AT 全是 ? 或 CGPADDR）',
	(nsSrc.match(/name: '[^']+', cmd: '([^']+)'/g) || []).every(function (m) {
		const c = m.match(/cmd: '([^']+)'/)[1];
		return /\?$/.test(c) || c === 'AT+CGPADDR';
	}));
/* 只钉"真的做了按钮"，不钉注释里出现「修复」二字（注释里必然会提到） */
ok('★ 没有自动修复按钮（用户明确选择「只诊断 + 给命令」）',
	!/(?:ghostButton|primaryButton|dangerButton)\('[^']*(修复|恢复|续约|重启服务)/.test(nsSrc)
	&& !/Mt5700\.confirm\([^)]*(ifdown|ifup|firewall restart)/.test(nsSrc));
ok('明细行把建议挂在说明下面（不另起第 4 列，否则说明被挤成窄条）',
	/'建议：' \+ i\.fix/.test(nsSrc)
	&& /Mt5700\.table\(\['项目', '结论', '说明'\]/.test(nsSrc));
ok('★ 三层徽章容器有独立 CSS 类（不复用 ADC 的 readouts，语义与间距都不同）',
	/mt5700-diag-chips/.test(nsSrc) && /\.mt5700-diag-chips \{/.test(cssSrc));
ok('runDiagnosis 在 busy 时返回 Promise（入口是 .then(runDiagnosis)，返回 undefined 会静默崩）',
	/if \(t\.busy\) return Promise\.resolve\(\);[\s\S]{0,400}function runDiagnosis/.test(nsSrc)
	|| /function runDiagnosis\(\)[\s\S]{0,400}if \(t\.busy\) return Promise\.resolve\(\);/.test(nsSrc));
ok('★ 单项判定写崩不会带走整页（try/catch 兜成存疑）',
	/try \{\s*r = c\.eval\(t\.facts, state\)[\s\S]{0,200}catch \(e\)/.test(nsSrc));
ok('★ 排查链可被页面卸载中断（复用 disposed 标记）',
	/function runDiagnosis\(\)[\s\S]{0,900}if \(disposed\) return;/.test(nsSrc));
ok('★ sysdiag 排在 AT 之后（先让独占的 AT 通道跑完，不被 rpcd 的 15s 探测拖住）',
	nsSrc.indexOf('AtWs.client.sendCommand(s.cmd)') < nsSrc.indexOf('AtWs.sysDiag()'));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（断网排查：只读底线 / 事实键一致 / 判定翻转 / 后端通路 / 注册表结构）');
