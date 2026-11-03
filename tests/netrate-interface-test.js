'use strict';

/* 针对 rpcd 实时速率采集的接口选择回归测试，无需 OpenWrt 环境。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ucPath = path.join(__dirname, '..', 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const source = fs.readFileSync(ucPath, 'utf8');
const start = source.indexOf('function ifaceNetdev(cursor, name)');
const end = source.indexOf('/* 十进制', start);
assert(start >= 0 && end > start, '无法抽取流量统计接口选择函数');
const selectionSource = source.slice(start, end);
assert(!selectionSource.includes('detectUsbNetdev()'), 'USB 扫描不得覆盖模组物理绑定');
assert(!selectionSource.includes("iface_v4"), '流量统计不应再受逻辑承载接口配置影响');
/* ucode 不做函数声明提升：被调函数必须文本上先声明。
 * readCounter 若被移到 netdevUsable 之后，设备上 netrate 会在运行时报
 * “access to undeclared variable readCounter”，整条 RPC 直接失败 ——
 * Node 的 vm 有提升语义，测不出来，只能靠这条顺序断言兜底。 */
assert(
	selectionSource.indexOf('function readCounter(') >= 0 &&
		selectionSource.indexOf('function readCounter(') < selectionSource.indexOf('function netdevUsable('),
	'readCounter 必须声明在 netdevUsable 之前'
);

function detect(config, counters) {
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
		substr: function (value, start, length) {
			return String(value).substr(start, length);
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
		counters: { usb0: 100, 'br-lan': 200 },
		expected: 'usb0'
	},
	{
		name: '自动采用用户修改后的物理绑定',
		config: { 'network.MT5700M.device': 'eth3', 'network.lan.device': 'br-lan' },
		counters: { usb0: 100, eth3: 300, 'br-lan': 200 },
		expected: 'eth3'
	},
	{
		name: '模组网卡计数器不可读时回退 LAN',
		config: { 'network.MT5700M.device': 'usb0', 'network.lan.device': 'br-lan' },
		counters: { 'br-lan': 200 },
		expected: 'br-lan'
	},
	{
		name: '模组接口未配置时回退 LAN',
		config: { 'network.lan.device': 'br-lan' },
		counters: { 'br-lan': 200 },
		expected: 'br-lan'
	},
	{
		name: '兼容旧式 ifname 物理绑定',
		config: { 'network.MT5700M.ifname': 'usb1', 'network.lan.device': 'br-lan' },
		counters: { usb1: 100, 'br-lan': 200 },
		expected: 'usb1'
	},
	{
		name: '模组与 LAN 均未配置时使用默认 LAN 网桥',
		config: {},
		counters: {},
		expected: 'br-lan'
	}
];

for (const test of cases) {
	assert.strictEqual(detect(test.config, test.counters), test.expected, test.name);
	console.log('PASS ' + test.name);
}

console.log('netrate interface selection: ' + cases.length + ' tests passed');
