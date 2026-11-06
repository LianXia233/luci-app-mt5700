'use strict';

/* 流量统计口径回归测试（纯 Node，无需 OpenWrt 环境）。
 *
 * 覆盖 rpcd ucode 的 detectWanDevice / netrateCall 与 Rust usage.rs 同语义：
 * 优先认 WAN 区域里自动识别出的模组物理网口；无模组口时回落到默认 WAN 口
 * 的物理网卡，再回落到其它 WAN 成员；候选全无时只认非 LAN 归属的 USB 网卡，
 * 再不行就停止统计。全程排除 br-lan / lo / LAN 区域。
 * 同时验证 usage_source=modem 时 netrate 转发到 Rust 后端。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ucPath = path.join(__dirname, '..', 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const source = fs.readFileSync(ucPath, 'utf8');

/* 抽取「接口选择」段：readCounter 起到「十进制 → 十六进制」注释之前。 */
const start = source.indexOf('function readCounter(');
const end = source.indexOf('/* 十进制', start);
assert(start >= 0 && end > start, '无法抽取流量统计接口选择函数');
const selectionSource = source.slice(start, end);

/* netrateCall 现已移到 rpcCall 之后（ucode 不做函数声明提升）。 */
const nrStart = source.indexOf('function netrateCall(');
const nrEnd = source.indexOf('\nreturn {', nrStart);
assert(nrStart > source.indexOf('function rpcCall('), 'netrateCall 必须声明在 rpcCall 之后');
assert(nrStart >= 0 && nrEnd > nrStart, '无法抽取 netrateCall');
const netrateSource = source.slice(nrStart, nrEnd);

/* 旧实现已彻底移除，不允许再有「回退 LAN 网桥」的兜底。 */
for (const stale of ['function detectModemDevice(', 'function ifaceNetdev(',
	'function boundModemNetdev(', "return 'br-lan'", 'iface_v4']) {
	assert(!selectionSource.includes(stale), '不应残留旧接口选择逻辑: ' + stale);
}
/* ucode 声明顺序：被调函数必须文本上先声明。 */
const order = [
	'function readCounter(', 'function netdevUsable(', 'function uciValueTokens(',
	'function uciShowText(', 'function zoneIfaces(', 'function networkDevices(',
	'function resolveNetdev(', 'function isLanSide(', 'function boundOutsideLan(',
	'function usageSource(', 'function detectWanDevice('
];
for (let i = 1; i < order.length; i++) {
	assert(selectionSource.indexOf(order[i - 1]) >= 0 &&
		selectionSource.indexOf(order[i]) > selectionSource.indexOf(order[i - 1]),
		'声明顺序错误: ' + order[i] + ' 必须晚于 ' + order[i - 1]);
}

/* 把配置对象渲染成 `uci show` 的输出（list 表现为 'a' 'b'）。 */
function uciShowLines(config) {
	return Object.keys(config).map(function (key) {
		const value = config[key];
		if (Array.isArray(value)) {
			return key + '=' + value.map(function (v) { return "'" + v + "'"; }).join(' ');
		}
		return key + "='" + value + "'";
	});
}

/* 实机拓扑（ImmortalWrt SNAPSHOT 实测）：
 * WAN zone = MT5700M / MT5700Mv6 / wan / wan6，LAN zone = lan；
 * eth2 挂在 USB 总线上（模组网口），eth1 是 SoC 物理 WAN 口，br-lan 是 LAN 桥。 */
const REAL_FW = {
	'firewall.@zone[0].name': 'lan',
	'firewall.@zone[0].network': 'lan',
	'firewall.@zone[1].name': 'wan',
	'firewall.@zone[1].network': ['MT5700M', 'MT5700Mv6', 'wan', 'wan6']
};
const REAL_NET = {
	'network.lan.device': 'br-lan',
	'network.wan.device': 'eth1',
	'network.wan6.device': '@wan',
	'network.MT5700M.device': 'eth2',
	'network.MT5700Mv6.device': '@MT5700M'
};

function runCase(cfg) {
	const config = Object.assign({}, cfg.firewall || {}, cfg.network || {});
	const lines = uciShowLines(config);
	const calls = [];
	const context = {
		/* ucode 内建函数等价桩 */
		type: function (v) { return v === null || v === undefined ? 'null' : (Array.isArray(v) ? 'array' : typeof v); },
		length: function (v) {
			/* 实机 ucode：对 null 求 length 会抛 "left-hand side expression is null" */
			if (v === null || v === undefined) throw new Error('left-hand side expression is null');
			return (Array.isArray(v) || typeof v === 'string') ? v.length : 0;
		},
		trim: function (v) { return String(v).trim(); },
		split: function (v, sep) {
			const text = String(v);
			/* 实机 ucode 的 split() 单参数返回 null，不会按空白切分。
			 * 这里必须保持同一语义，否则「单参数 split」的回归测不出来。 */
			if (sep === undefined) return null;
			return text.split(sep);
		},
		substr: function (v, start, len) { return String(v).substr(start, len); },
		index: function (v, needle) { return String(v).indexOf(needle); },
		keys: function (obj) { return Object.keys(obj); },
		int: function (v) { const n = Number(String(v).trim()); return Number.isFinite(n) ? n : null; },
		match: function (v, re) { return re.exec(String(v)); },
		getStr: function (args, key) {
			return args && args[key] != null ? String(args[key]) : null;
		},
		detectUsbNetdev: function () { return cfg.usb == null ? null : cfg.usb; },
		rpcCall: function (method, params) {
			calls.push({ method: method, params: params });
			return { success: true, device: 'modem:^DSFLOWQRY', rx_bytes: 1234, tx_bytes: 5678 };
		},
		fs: {
			open: function (filePath) {
				const m = /^\/sys\/class\/net\/([^/]+)\/statistics\/(rx|tx)_bytes$/.exec(filePath);
				if (!m || cfg.counters[m[1]] == null) return null;
				return {
					read: function () { return String(cfg.counters[m[1]]) + '\n'; },
					close: function () { }
				};
			},
			popen: function (cmd) {
				const text = String(cmd);
				let out;
				if (text.includes('uci -q get at-webserver.config.usage_source')) {
					out = [cfg.source || 'netdev'];
				} else if (text.includes('uci -q show firewall')) {
					out = lines.filter(function (l) { return l.startsWith('firewall.'); });
				} else if (text.includes('uci -q show network')) {
					out = lines.filter(function (l) { return l.startsWith('network.'); });
				} else {
					throw new Error('未预期的 popen 命令: ' + text);
				}
				let i = 0;
				return {
					read: function () { return i < out.length ? out[i++] + '\n' : null; },
					close: function () { }
				};
			}
		}
	};
	vm.createContext(context);
	vm.runInContext(
		selectionSource + '\n' + netrateSource +
		'\nthis.detect = detectWanDevice; this.netrate = netrateCall;',
		context
	);
	return {
		detect: context.detect(),
		netrate: function (device) { return context.netrate({ args: { device: device || '' } }); },
		calls: calls
	};
}

const base = {
	firewall: REAL_FW,
	network: REAL_NET,
	usb: 'eth2',
	source: 'netdev',
	counters: { eth2: 222126799063, eth1: 0, 'br-lan': 229510511167, lo: 164064442 }
};

/* 一、网卡自动识别 */
const detectCases = [
	{
		name: '实机拓扑自动识别 USB 模组 WAN 口', cfg: base, expected: 'eth2'
	},
	{
		name: '模组尚未枚举时回落默认 WAN 口物理网卡，不碰 br-lan',
		cfg: Object.assign({}, base, { usb: null }), expected: 'eth1'
	},
	{
		name: '只有默认 WAN 口（无模组专用接口）时选其物理网卡',
		cfg: {
			firewall: { 'firewall.@zone[0].name': 'wan',
				'firewall.@zone[0].network': ['wan', 'wan6'],
				'firewall.@zone[1].name': 'lan', 'firewall.@zone[1].network': 'lan' },
			network: { 'network.lan.device': 'br-lan', 'network.wan.device': 'eth1',
				'network.wan6.device': '@wan' },
			usb: null, counters: { eth1: 100, 'br-lan': 999 }
		}, expected: 'eth1'
	},
	{
		name: 'wan 接口不在 WAN 区域时不能仅凭名字选其物理网卡',
		cfg: {
			firewall: { 'firewall.@zone[0].name': 'wan',
				'firewall.@zone[0].network': 'badwan',
				'firewall.@zone[1].name': 'lan', 'firewall.@zone[1].network': 'lan' },
			network: { 'network.lan.device': 'br-lan', 'network.wan.device': 'eth1',
				'network.badwan.device': 'br-lan' },
			usb: null, counters: { eth1: 100, 'br-lan': 999 }
		}, expected: null
	},
	{
		name: 'WAN 区域误写 br-lan 时拒绝统计',
		cfg: {
			firewall: { 'firewall.@zone[0].name': 'wan', 'firewall.@zone[0].network': ['badwan'],
				'firewall.@zone[1].name': 'lan', 'firewall.@zone[1].network': 'lan' },
			network: { 'network.badwan.device': 'br-lan', 'network.lan.device': 'br-lan' },
			usb: 'br-lan', counters: base.counters
		}, expected: null
	},
	{
		name: 'LAN 区域物理网卡即使出现在 WAN 列表里也排除',
		cfg: {
			firewall: { 'firewall.@zone[0].name': 'wan', 'firewall.@zone[0].network': 'wan',
				'firewall.@zone[1].name': 'lan', 'firewall.@zone[1].network': 'lan' },
			network: { 'network.wan.device': 'eth0', 'network.lan.device': 'eth0' },
			usb: null, counters: { eth0: 10 }
		}, expected: null
	},
	{
		name: '无 WAN 区域时用白名单逻辑接口而非 LAN',
		cfg: Object.assign({}, base, { firewall: {} }), expected: 'eth2'
	},
	{
		name: '候选全无时绑定非 LAN 归属的 USB 网卡',
		cfg: {
			firewall: {}, network: { 'network.wwan.device': 'usb0' },
			usb: 'usb0', counters: { usb0: 100 }
		}, expected: 'usb0'
	},
	{
		name: 'USB 网卡只被 LAN 绑定时拒绝',
		cfg: {
			firewall: { 'firewall.@zone[0].name': 'lan', 'firewall.@zone[0].network': 'lan' },
			network: { 'network.lan.device': 'usb0' },
			usb: 'usb0', counters: { usb0: 100 }
		}, expected: null
	},
	{
		name: '旧式 ifname 与 @别名均能解析',
		cfg: {
			firewall: REAL_FW,
			network: { 'network.lan.ifname': 'br-lan', 'network.wan.ifname': 'eth1',
				'network.wan6.device': '@wan', 'network.MT5700M.ifname': 'eth2',
				'network.MT5700Mv6.device': '@MT5700M' },
			usb: 'eth2', counters: base.counters
		}, expected: 'eth2'
	},
	{
		name: '全部计数器不可读时停止统计',
		cfg: Object.assign({}, base, { counters: {} }), expected: null
	},
	{
		name: '什么都不存在时不回退 LAN',
		cfg: { firewall: {}, network: {}, usb: null, counters: {} }, expected: null
	}
];

for (const t of detectCases) {
	assert.strictEqual(runCase(t.cfg).detect, t.expected, t.name);
	console.log('PASS ' + t.name);
}

/* 二、netrate 入参与来源分流 */
const auto = runCase(base);
const r1 = auto.netrate('');
assert.strictEqual(r1.success, true);
assert.strictEqual(r1.device, 'eth2');
assert.strictEqual(r1.rx_bytes, 222126799063);
console.log('PASS 自动探测返回 WAN 模组网口计数器');

const r2 = auto.netrate('br-lan');
assert.strictEqual(r2.device, 'eth2', '显式 br-lan 必须被拒绝');
assert.notStrictEqual(r2.rx_bytes, 229510511167, '绝不能读到 br-lan 的计数器');
console.log('PASS 显式 br-lan 入参被拒绝，绝不计入 LAN 流量');

const noWan = runCase(Object.assign({}, base, {
	firewall: { 'firewall.@zone[0].name': 'wan', 'firewall.@zone[0].network': 'badwan' },
	network: { 'network.badwan.device': 'br-lan', 'network.lan.device': 'br-lan' },
	usb: 'br-lan'
}));
assert.strictEqual(noWan.netrate('').success, false, '无可用 WAN 网卡时应停止统计');
console.log('PASS 无 WAN 网卡时返回 success:false 而非回退 LAN');

const modem = runCase(Object.assign({}, base, { source: 'modem' }));
const r3 = modem.netrate('');
assert.strictEqual(r3.success, true);
assert.strictEqual(r3.device, 'modem:^DSFLOWQRY');
assert.strictEqual(modem.calls.length, 1, 'modem 来源必须转发到 Rust 后端');
assert.strictEqual(modem.calls[0].method, 'netrate');
console.log('PASS 模组来源转发到后端 netrate，口径与 usage 一致');

const netdev = runCase(base);
netdev.netrate('');
assert.strictEqual(netdev.calls.length, 0, 'netdev 来源不应触碰后端/AT 通道');
console.log('PASS 物理网卡来源零 AT 通道代价');

console.log('netrate / WAN interface selection: ' +
	(detectCases.length + 6) + ' checks passed');
