'use strict';

/* 针对 rpcd 实时速率采集的接口选择回归测试，无需 OpenWrt 环境。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ucPath = path.join(__dirname, '..', 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const source = fs.readFileSync(ucPath, 'utf8');
const start = source.indexOf('function readCounter(');
const end = source.indexOf('/* 十进制', start);
assert(start >= 0 && end > start, '无法抽取流量统计接口选择函数');
const selectionSource = source.slice(start, end);
/* USB 扫描只允许作为第 2 级兜底（boundModemNetdev 内），
 * 不得直接参与 MT5700M 的绑定优先级，避免覆盖用户显式绑定。 */
const usbCallAt = selectionSource.indexOf('detectUsbNetdev()');
assert(
	usbCallAt < 0 || usbCallAt > selectionSource.indexOf('function boundModemNetdev('),
	'USB 扫描只能出现在 boundModemNetdev 内'
);
assert(!selectionSource.includes('iface_v4'), '流量统计不应再受逻辑承载接口配置影响');
/* 解析顺序：MT5700M → 绑定模组网口的其它接口 → LAN，LAN 只在前两级都取不到时生效 */
const orderMt = selectionSource.indexOf("ifaceNetdev(cursor, 'MT5700M')", selectionSource.indexOf('function detectModemDevice('));
const orderBound = selectionSource.indexOf('boundModemNetdev()', orderMt);
const orderLan = selectionSource.indexOf("ifaceNetdev(cursor, 'lan')", orderBound);
assert(orderMt > 0 && orderBound > orderMt && orderLan > orderBound, '接口解析顺序必须是 MT5700M → 绑定 → LAN');
/* ucode 不做函数声明提升：被调函数必须文本上先声明。
 * readCounter 若被移到 netdevUsable 之后，设备上 netrate 会在运行时报
 * “access to undeclared variable readCounter”，整条 RPC 直接失败 ——
 * Node 的 vm 有提升语义，测不出来，只能靠这条顺序断言兜底。 */
assert(
	selectionSource.indexOf('function readCounter(') >= 0 &&
		selectionSource.indexOf('function readCounter(') < selectionSource.indexOf('function netdevUsable('),
	'readCounter 必须声明在 netdevUsable 之前'
);
assert(
	selectionSource.indexOf('function netdevUsable(') < selectionSource.indexOf('function ifaceNetdev('),
	'netdevUsable 必须声明在 ifaceNetdev 之前'
);

/* 把配置对象渲染成 uci show network 的输出（list 表现为 'a' 'b'） */
function uciShowLines(config) {
	const lines = [];
	for (const key of Object.keys(config)) {
		const value = config[key];
		if (Array.isArray(value)) {
			lines.push(key + '=' + value.map(function (item) { return "'" + item + "'"; }).join(' '));
		} else {
			lines.push(key + "='" + value + "'");
		}
	}
	return lines;
}

function detect(config, counters, usb) {
	const context = {
		uci: {
			cursor: function () {
				return {
					get: function (section, name, option) {
						const key = section + '.' + name + '.' + option;
						return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : null;
					}
				};
			}
		},
		/* ucode 内建函数的等价桩 */
		type: function (value) {
			if (value === null || value === undefined) {
				return 'null';
			}
			return Array.isArray(value) ? 'array' : typeof value;
		},
		length: function (value) {
			if (Array.isArray(value) || typeof value === 'string') {
				return value.length;
			}
			return 0;
		},
		trim: function (value) {
			return String(value).trim();
		},
		split: function (value, sep) {
			const text = String(value);
			if (sep === undefined) {
				return text.split(/\s+/).filter(function (token) { return token.length > 0; });
			}
			return text.split(sep);
		},
		substr: function (value, start, length) {
			return String(value).substr(start, length);
		},
		/* 第 2 级兜底的 USB 扫描结果直接注入，避免依赖真实 sysfs 布局 */
		detectUsbNetdev: function () {
			return usb;
		},
		/* 走真实 readCounter：用 fs 桩提供 sysfs 视图，而不是替换 readCounter 本身 */
		int: function (value) {
			const n = Number(String(value).trim());
			return Number.isFinite(n) ? n : null;
		},
		fs: {
			open: function (filePath) {
				const match = /^\/sys\/class\/net\/([^/]+)\/statistics\/rx_bytes$/.exec(filePath);
				if (!match || counters[match[1]] == null) {
					return null;
				}
				return {
					read: function () {
						return String(counters[match[1]]) + '\n';
					},
					close: function () { }
				};
			},
			popen: function (cmd) {
				if (!String(cmd).includes('uci')) {
					throw new Error('未预期的 popen 命令: ' + cmd);
				}
				const lines = uciShowLines(config);
				let index = 0;
				return {
					read: function () {
						return index < lines.length ? lines[index++] + '\n' : null;
					},
					close: function () { }
				};
			}
		}
	};
	vm.createContext(context);
	vm.runInContext(selectionSource + '\nthis.detect = detectModemDevice;', context);
	return context.detect();
}

const cases = [
	{
		name: '优先使用模组接口的物理绑定',
		config: { 'network.MT5700M.device': 'usb0', 'network.lan.device': 'br-lan' },
		counters: { usb0: 100, eth2: 300, 'br-lan': 200 },
		usb: 'eth2',
		expected: 'usb0'
	},
	{
		name: '自动采用用户修改后的物理绑定',
		config: { 'network.MT5700M.device': 'eth3', 'network.lan.device': 'br-lan' },
		counters: { usb0: 100, eth3: 300, 'br-lan': 200 },
		usb: 'eth2',
		expected: 'eth3'
	},
	{
		name: '模组网卡计数器不可读时回退 LAN',
		config: { 'network.MT5700M.device': 'usb0', 'network.lan.device': 'br-lan' },
		counters: { 'br-lan': 200 },
		usb: 'usb0',
		expected: 'br-lan'
	},
	{
		name: '模组接口未配置时回退 LAN',
		config: { 'network.lan.device': 'br-lan' },
		counters: { 'br-lan': 200 },
		usb: 'eth2',
		expected: 'br-lan'
	},
	{
		name: '兼容旧式 ifname 物理绑定',
		config: { 'network.MT5700M.ifname': 'usb1', 'network.lan.device': 'br-lan' },
		counters: { usb1: 100, 'br-lan': 200 },
		usb: 'eth2',
		expected: 'usb1'
	},
	{
		name: '模组与 LAN 均未配置时使用默认 LAN 网桥',
		config: {},
		counters: {},
		usb: null,
		expected: 'br-lan'
	},
	{
		name: '无 MT5700M 但有 wan 直接绑 eth2 时取 eth2',
		config: { 'network.wan.device': 'eth2', 'network.lan.device': 'br-lan' },
		counters: { eth2: 100, 'br-lan': 200 },
		usb: 'eth2',
		expected: 'eth2'
	},
	{
		name: '无 MT5700M 但 wan 用 ifname 绑 eth2 时取 eth2',
		config: { 'network.wan.ifname': 'eth2', 'network.lan.device': 'br-lan' },
		counters: { eth2: 100, 'br-lan': 200 },
		usb: 'eth2',
		expected: 'eth2'
	},
	{
		name: '只扫到 USB 网卡但没有接口绑定时不得覆盖 LAN',
		config: { 'network.lan.device': 'br-lan' },
		counters: { eth2: 100, 'br-lan': 200 },
		usb: 'eth2',
		expected: 'br-lan'
	},
	{
		name: 'ifname 为列表时取首项',
		config: { 'network.MT5700M.ifname': ['eth2', 'eth3'], 'network.lan.device': 'br-lan' },
		counters: { eth2: 100, eth3: 300, 'br-lan': 200 },
		usb: 'eth2',
		expected: 'eth2'
	}
];

for (const test of cases) {
	assert.strictEqual(detect(test.config, test.counters, test.usb), test.expected, test.name);
	console.log('PASS ' + test.name);
}

console.log('netrate interface selection: ' + cases.length + ' tests passed');
