'use strict';
/*
 * rpcd ucode 插件：mt5700。
 * OpenWrt ucode 语法：无 ===/模板字符串；无 require('json')，
 * 序列化用 sprintf('%J')，反序列化用内置迷你解析器。
 * 参数在 req.args 上（不是 req 顶层）。
 */

const fs = require('fs');
const uci = require('uci');

/* 调用方没传 _rid 时的兜底自增号（同一秒内多次调用也能区分） */
let rpcFallbackSeq = 0;

function readRpcConfig() {
	const cursor = uci.cursor();
	const port = int(cursor.get('at-webserver', 'config', 'websocket_port')) || 8765;
	const authKey = cursor.get('at-webserver', 'config', 'websocket_auth_key') || '';
	return { port: port, authKey: authKey };
}

function getStr(obj, key) {
	if (obj == null) {
		return null;
	}
	let v = obj[key];
	if (v == null) {
		return null;
	}
	return v;
}

/* 迷你 JSON 解析：ucode 无 s[i]、嵌套函数不提升，用 substr + 前置声明 */
function jsonParse(s) {
	let i = 0;
	let n = length(s);
	let parseVal;

	function ch() {
		if (i >= n) {
			return '';
		}
		return substr(s, i, 1);
	}

	function ws() {
		while (i < n) {
			let c = ch();
			if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
				i++;
			} else {
				break;
			}
		}
	}

	function parseStr() {
		i++;
		let out = '';
		while (i < n) {
			let c = ch();
			if (c == '\\') {
				i++;
				let e = ch();
				if (e == 'n') { out += '\n'; }
				else if (e == 't') { out += '\t'; }
				else if (e == 'r') { out += '\r'; }
				else if (e == '"') { out += '"'; }
				else if (e == '\\') { out += '\\'; }
				else if (e == '/') { out += '/'; }
				else { out += e; }
				i++;
			} else if (c == '"') {
				i++;
				return out;
			} else {
				out += c;
				i++;
			}
		}
		return out;
	}

	function parseNum() {
		let start = i;
		if (ch() == '-') { i++; }
		while (i < n) {
			let c = ch();
			if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
				i++;
			} else {
				break;
			}
		}
		return int(substr(s, start, i - start));
	}

	function parseArr() {
		i++;
		let arr = [];
		ws();
		if (ch() == ']') { i++; return arr; }
		while (i < n) {
			// 本固件 ucode 的数组没有 push 方法（调用会抛
			// "left-hand side is not a function"），只能按下标追加。
			arr[length(arr)] = parseVal();
			ws();
			if (ch() == ',') { i++; ws(); continue; }
			if (ch() == ']') { i++; break; }
			break;
		}
		return arr;
	}

	function parseObj() {
		i++;
		let obj = {};
		ws();
		if (ch() == '}') { i++; return obj; }
		while (i < n) {
			ws();
			if (ch() != '"') { break; }
			let k = parseStr();
			ws();
			if (ch() == ':') { i++; }
			let v = parseVal();
			obj[k] = v;
			ws();
			if (ch() == ',') { i++; continue; }
			if (ch() == '}') { i++; break; }
			break;
		}
		return obj;
	}

	parseVal = function () {
		ws();
		let c = ch();
		if (c == '{') { return parseObj(); }
		if (c == '[') { return parseArr(); }
		if (c == '"') { return parseStr(); }
		if (c == 't') { i += 4; return true; }
		if (c == 'f') { i += 5; return false; }
		if (c == 'n') { i += 4; return null; }
		return parseNum();
	};

	return parseVal();
}

/*
 * 解析承载 5G 流量的网络设备名。
 * 优先 UCI network.MT5700M.device，其次 ifname，都拿不到才退回 eth2。
 * 不硬编码单一设备名，避免不同机型/接口命名下取不到计数。
 */
function detectModemDevice() {
	let dev = null;
	try {
		const cursor = uci.cursor();
		dev = cursor.get('network', 'MT5700M', 'device');
		if (dev == null || dev == '') {
			dev = cursor.get('network', 'MT5700M', 'ifname');
		}
	} catch (e) {
		dev = null;
	}
	if (dev == null || dev == '') {
		dev = 'eth2';
	}
	return dev;
}

/* 读取单个字节计数器；失败返回 null（不做静默补 0，避免算出假速率） */
function readCounter(path) {
	let f;
	try {
		f = fs.open(path, 'r');
	} catch (e) {
		return null;
	}
	if (!f) {
		return null;
	}
	let s = f.read('line');
	f.close();
	if (s == null) {
		return null;
	}
	let v = int(s);
	if (v == null) {
		return null;
	}
	return v;
}

/*
 * 取网络接口累计字节数。
 * 实时速率由前端按「两次采样差 / 时间差」计算，这里只返回原始计数与本机时钟，
 * 由前端统一时间基准，规避 rpcd 与浏览器时钟不同源的抖动。
 *
 * 关键：全程不向模组下发任何 AT 命令，避免占用 AT 通道、干扰模组工作。
 */
function netrateCall(req) {
	let a = req.args;
	let dev = getStr(a, 'device');
	if (dev == null || dev == '') {
		dev = detectModemDevice();
	}

	const base = '/sys/class/net/' + dev;
	const rx = readCounter(base + '/statistics/rx_bytes');
	const tx = readCounter(base + '/statistics/tx_bytes');

	if (rx == null && tx == null) {
		return { success: false, device: dev, error: '读不到接口计数器，设备可能不存在或未 up' };
	}

	return {
		success: true,
		device: dev,
		rx_bytes: rx == null ? 0 : rx,
		tx_bytes: tx == null ? 0 : tx
	};
}

/*
 * 取模组与路由器之间的 USB 链路速率（自动识别，不硬编码设备路径/产品名）。
 *
 * 原理：扫描 /sys/bus/usb/devices 下每个 USB 设备，跳过 xHCI 根集线器
 * （idVendor = 1d6b），剩下的真实 USB 设备即模组（本机实测为 2-1，
 * TDTECH MT5700M-CN，speed=5000 = USB 3.0 5 Gbps）。
 *
 * 实现细节：本固件的 ucode 数组/对象受限（fs.readdir 返回的数组无 length，
 * 直接 length(arr) 会抛 left-hand side is not a function），故复用 fs.popen
 * 走 busybox /bin/sh 一行脚本在设备侧枚举并逐行回显，本函数只做串行读取与解析，
 * 与 rpcCall() 里 fs.popen(nc ...) 的既有做法一致；speed/version 均为 sysfs
 * 直读，全程不发任何 AT 命令，不占用 AT 通道、不干扰模组。
 */
/* 查单字符分隔符下标（ucode 全局 index 在本固件未必可用，用 substr 逐字符扫描） */
function strIndexOf(s, ch) {
	let n = length(s);
	for (let i = 0; i < n; i++) {
		if (substr(s, i, 1) == ch) {
			return i;
		}
	}
	return -1;
}

function usbCall(req) {
	const script = 'echo USB_SCAN; '
		+ 'for x in /sys/bus/usb/devices/*/; do '
		+ 'p=$(cat "$x/product" 2>/dev/null); '
		+ '[ -z "$p" ] && continue; '
		+ 'v=$(cat "$x/idVendor" 2>/dev/null); '
		+ '[ "$v" = "1d6b" ] && continue; '
		+ 'echo "USB=$(cat "$x/speed" 2>/dev/null) | $p | $(cat "$x/version" 2>/dev/null)"; '
		+ 'break; done';
	let p;
	try {
		p = fs.popen('/bin/sh -c ' + script, 'r');
	} catch (e) {
		return { success: false, error: '无法读取 USB 信息: ' + e.message };
	}
	if (!p) {
		return { success: false, error: '无法读取 USB 信息' };
	}
	let speed = '';
	let product = '';
	let version = '';
	let guard = 0;
	while (1) {
		if (guard++ >= 20) {
			break;
		}
		let line = p.read('line');
		if (line == null) {
			break;
		}
		if (substr(line, 0, 4) == 'USB=') {
			let rest = trim(substr(line, 4));
			let i = strIndexOf(rest, '|');
			if (i < 0) {
				continue;
			}
			speed = trim(substr(rest, 0, i));
			let tail = substr(rest, i + 1);
			let k = strIndexOf(tail, '|');
			if (k >= 0) {
				product = trim(substr(tail, 0, k));
				version = trim(substr(tail, k + 1));
			} else {
				product = trim(tail);
			}
			break;
		}
	}
	p.close();
	if (speed == '') {
		return { success: false, error: '未检测到 USB 模组设备' };
	}
	let mbps = int(speed) || 0;
	return { success: true, speed_mbps: mbps, product: product, version: version };
}

function rpcCall(method, params) {
	const rpcCfg = readRpcConfig();
	const port = rpcCfg.port;
	const authKey = rpcCfg.authKey;

	const payload = { id: 1, method: method, params: params };
	if (authKey != '') {
		payload.params.auth_key = authKey;
	}

	/* 本固件 ucode fs 无 connect，经 busybox nc 管道访问回环 RPC。
	 * 各固件的 busybox 未必编译 nc applet，因此先定位可执行文件：
	 * 找不到时必须给出可诊断的报错，而不是笼统的「后端无应答」——
	 * 后者会让人误判成服务没起来，实际是装了插件却缺 nc。 */
	let ncBin = '';
	const ncCands = ['/usr/bin/nc', '/bin/nc', '/usr/sbin/nc', '/sbin/nc'];
	for (let i = 0; i < length(ncCands); i++) {
		let probe;
		try {
			probe = fs.open(ncCands[i], 'r');
		} catch (e) {
			probe = null;
		}
		if (probe) {
			probe.close();
			ncBin = ncCands[i];
			break;
		}
	}
	if (ncBin == '') {
		return {
			success: false,
			error: '系统缺少 nc（busybox 未编译 nc applet），无法连接后端：请安装 netcat 后重试'
		};
	}

	const body = sprintf('%J', payload);

	/*
	 * 临时文件名必须唯一。
	 *
	 * 实测问题：原先固定为 /tmp/mt5700-rpc.json，而页面会**并发**发起多个 RPC
	 * （日志页一次就发 3 个：后端日志 + syslog + 通知文件），多个请求写同一个
	 * 文件、再各自读同一个文件，互相覆盖，表现为「RPC 返回空对象」这种极难排查的
	 * 间歇性故障 —— 单独手动调用却完全正常。
	 *
	 * 唯一性由调用方传入的 _rid 提供；没传时退化为「时间戳 + 自增」，
	 * 同一秒内的多次调用也能区分（ucode 的 time() 只有秒级）。
	 */
	let rid = getStr(params, '_rid');
	if (rid == null || rid == '') {
		rid = sprintf('%d-%d', time(), rpcFallbackSeq++);
	}
	const tmp = '/tmp/mt5700-rpc-' + rid + '.json';
	let f;
	try {
		f = fs.open(tmp, 'w');
	} catch (e) {
		return { success: false, error: '无法写临时文件' };
	}
	if (!f) {
		return { success: false, error: '无法写临时文件' };
	}
	f.write(body + '\n');
	f.close();

	let p;
	try {
		p = fs.popen(ncBin + ' 127.0.0.1 ' + port + ' < ' + tmp, 'r');
	} catch (e) {
		return { success: false, error: '无法连接 Rust 后端: ' + e.message };
	}
	if (!p) {
		return { success: false, error: '无法连接 Rust 后端' };
	}

	let line = p.read('line');
	p.close();
	/* 用完即删，避免每次 RPC 都在 /tmp 留一个文件 */
	try {
		fs.unlink(tmp);
	} catch (e) {
		/* 删不掉不影响主流程 */
	}

	if (!line) {
		return { success: false, error: 'Rust 后端无应答（服务未运行或端口 ' + port + ' 未监听）' };
	}
	if (substr(line, 0, 1) != '{') {
		return { success: false, error: 'Rust 后端应答异常: ' + substr(line, 0, 160) };
	}

	try {
		let resp = jsonParse(line);
		if (resp.error) {
			let msg = 'RPC 错误';
			if (resp.error.message) {
				msg = resp.error.message;
			}
			return { success: false, error: msg };
		}
		if (resp.result) {
			return resp.result;
		}
		return {};
	} catch (e) {
		return { success: false, error: '解析应答失败: ' + e.message };
	}
}

return {
	mt5700: {
		at: {
			args: { cmd: '', _rid: '' },
			call: function (req) {
				let a = req.args;
				let cmd = getStr(a, 'cmd');
				if (cmd == null || cmd == '') {
					return { success: false, error: '缺少参数 cmd' };
				}
				return rpcCall('at', { cmd: cmd, _rid: getStr(a, '_rid') });
			}
		},
		events: {
			args: { since: 0, _rid: '' },
			call: function (req) {
				let a = req.args;
				let since = 0;
				let s = getStr(a, 'since');
				if (s != null && s != '') {
					since = int(s) || 0;
				}
				if (since < 0) {
					since = 0;
				}
				return rpcCall('events', { since: since, _rid: getStr(a, '_rid') });
			}
		},
		netrate: {
			args: { device: '' },
			call: function (req) {
				return netrateCall(req);
			}
		},
		usb: {
			args: { _rid: '' },
			call: function (req) {
				return usbCall(req);
			}
		},
		logs: {
			args: { since: 0, limit: 300, _rid: '' },
			call: function (req) {
				let a = req.args;
				let since = int(getStr(a, 'since')) || 0;
				let limit = int(getStr(a, 'limit')) || 300;
				if (since < 0) {
					since = 0;
				}
				if (limit <= 0 || limit > 1200) {
					limit = 300;
				}
				return rpcCall('logs', { since: since, limit: limit, _rid: getStr(a, '_rid') });
			}
		}
	}
};
