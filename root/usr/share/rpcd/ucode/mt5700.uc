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

/*
 * 白名单校验客户端传入的 _rid。
 *
 * 安全背景（必须过滤，不能信任客户端）：
 *   _rid 会被拼进临时文件路径与 shell 重定向命令：
 *     tmp = '/tmp/mt5700-rpc-' + _rid + '.json'
 *     raw = '... nc 127.0.0.1 < ' + tmp   （经 fs.popen 交给 /bin/sh，root 身份）
 *   未校验时，任何拥有本插件 ACL 的 LuCI 会话都可以：
 *     1) 命令注入：_rid = 'x; touch /tmp/pwned; #' → 拼出的 shell 里
 *        '; ' 分隔出第二条命令，以 root 执行；
 *     2) /tmp 内文件名注入：写/删到意料之外的文件，配合符号链接
 *        可能扩大影响。
 *   因此只接受 [A-Za-z0-9_-]{1,64}；其余一律视为未提供，
 *   退回服务端生成的唯一号（时间戳 + 自增），功能不受影响。
 */
function safeRid(v) {
	if (v == null) {
		return null;
	}
	if (length(v) == 0 || length(v) > 64) {
		return null;
	}
	if (match(v, /^[A-Za-z0-9_-]+$/) == null) {
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
 * 共享工具：给所有 fs.popen 子进程加硬超时的执行器。
 *
 * 背景（本文件最重要的一处健壮性保障）：ucode 的 fs.popen 本身没有超时参数，
 * 一旦子进程不返回（例如 nc 连到一个「端口在监听但对端不读不写」的后端，
 * 或者 pid 空间耗尽的极端情况），p.read('line') 会永久阻塞。
 * 而 rpcd 的 ucode 上下文是共享的，一个请求挂死会连带阻塞后续所有 RPC 请求，
 * 表现出来就是「整个 LuCI 页面转圈直到浏览器自己超时」。
 *
 * 手段：用 busybox 自带的 timeout 包一层子进程。
 * 这里不用 fs.popen 返回的句柄做 kill —— ucode 的 popen 句柄没有 kill 语义，
 * 只能靠 timeout 在子进程侧自杀，超时后管道关闭、read('line') 返回 null，
 * 从而把「永久阻塞」降级为「有限等待 + 明确错误」。
 *
 * 不引入任何新外部依赖：timeout 与 nc 一样来自 busybox（本机实测
 * /usr/bin/timeout 与 /usr/bin/nc 都是指向 /bin/busybox 的符号链接）。
 */
const RPCCALL_TIMEOUT_SEC = 12;

/*
 * 「后端不可用」共享熔断标记。
 *
 * 为什么必须做（实测暴露的严重问题）：
 *   单个请求有 12s 硬超时只能保护「一个请求不永久挂死」，
 *   但保护不了**并发风暴**。实测把后端 SIGSTOP 冻结后打开 LuCI 5G 页面：
 *   10 个页面 × 每页十几个 RPC（loadAll / refreshAll 各自成批），
 *   每个请求都各等满 12s，rpcd 的 ucode worker 被迅速占满，
 *   最终 uhttpd（-t 60）先超时，浏览器报 "XHR request timed out"、
 *   后续页面直接 ERR_CONNECTION_RESET —— 依然表现为「整个 LuCI 不可用」。
 *
 *   因此需要跨请求共享的熔断状态：一旦某次请求确认「后端无应答」，
 *   后续请求在 15s 内直接快速失败返回，不再各自消耗 12s，
 *   把 worker 从占用中释放出来，页面才能正常渲染降级提示。
 *
 * 实现：写一个带时间戳的小文件。ucode 的 fs 没有共享内存，
 * 但 /tmp 下的普通文件对所有 rpcd worker 可见，且读写都是毫秒级。
 * 不用 uci/ubus 是为了避免再引入一次 IPC 往返（那时候更要快）。
 */
const BACKEND_DOWN_FLAG = '/tmp/mt5700-backend-down';
const BACKEND_DOWN_TTL = 15;

/* 记录「后端无应答」，供后续请求快速失败 */
function noteBackendDown() {
	try {
		let f = fs.open(BACKEND_DOWN_FLAG, 'w');
		if (f) {
			f.write(sprintf('%d', time()));
			f.close();
		}
	} catch (e) {
		/* 写不了标记不影响主流程，只是退化为每个请求各自超时 */
	}
}

/* 清除标记（后端恢复应答时调用） */
function clearBackendDown() {
	try {
		fs.unlink(BACKEND_DOWN_FLAG);
	} catch (e) {
		/* 不存在即已清除 */
	}
}

/*
 * 检查是否处于「后端已知不可用」窗口内。
 * 返回剩余秒数（0 表示不在熔断窗口）。
 */
function backendDownRemain() {
	let f;
	try {
		f = fs.open(BACKEND_DOWN_FLAG, 'r');
	} catch (e) {
		return 0;
	}
	if (!f) {
		return 0;
	}
	let s = f.read(32);
	f.close();
	let at = int(s);
	if (at == null || at <= 0) {
		clearBackendDown();
		return 0;
	}
	let elapsed = time() - at;
	if (elapsed < 0 || elapsed >= BACKEND_DOWN_TTL) {
		clearBackendDown();
		return 0;
	}
	return BACKEND_DOWN_TTL - elapsed;
}

/*
 * 在候选路径里找第一个真实可执行的文件。
 * 沿用原有 fs.open(path,'r') 探测法：本固件的 fs 可用键不含 stat 的
 * 便捷封装语义，直接 fopen 是既有且验证可用的做法。
 */
function findBinary(cands) {
	for (let i = 0; i < length(cands); i++) {
		let probe;
		try {
			probe = fs.open(cands[i], 'r');
		} catch (e) {
			probe = null;
		}
		if (probe) {
			probe.close();
			return cands[i];
		}
	}
	return '';
}

/*
 * busybox timeout 的候选路径。
 * 找不到时返回 ''，调用方需自行降级（退回不带 timeout 的裸执行，
 * 并对 p.read('line') 的返回值做 null 判定，至少不会比改动前更差）。
 */
function findTimeoutBin() {
	return findBinary(['/usr/bin/timeout', '/bin/timeout', '/usr/sbin/timeout', '/sbin/timeout']);
}

/* busybox nc 的候选路径 */
function findNcBin() {
	return findBinary(['/usr/bin/nc', '/bin/nc', '/usr/sbin/nc', '/sbin/nc']);
}

/* 在 /sys/class/net 里找第一个挂在 USB 总线上的网卡（与 init.d 的 detect_usb_netdev 同口径）。
 * 脚本整体用单引号交给 sh -c，保证 timeout 包住的是整个扫描而不只是第一个词。 */
function detectUsbNetdev() {
	const script = 'for d in /sys/class/net/*; do n=${d##*/}; '
		+ 'case "$n" in lo|br-*) continue ;; esac; [ -e "$d/device" ] || continue; '
		+ 'case "$(readlink -f "$d/device" 2>/dev/null)" in *usb*) echo "NETDEV=$n"; break ;; esac; done';
	let tbin = findTimeoutBin();
	let cmd = "/bin/sh -c '" + script + "'";
	if (tbin != '') {
		cmd = tbin + ' 3 ' + cmd;
	}
	let p;
	try {
		p = fs.popen(cmd, 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}
	let line = p.read('line');
	p.close();
	if (line == null || substr(line, 0, 7) != 'NETDEV=') {
		return null;
	}
	return trim(substr(line, 7));
}

/* 接口的网卡名（device，其次旧式 ifname）；'@别名' 不是网卡名，视为取不到 */
function ifaceNetdev(cursor, name) {
	let dev = cursor.get('network', name, 'device');
	if (dev == null || dev == '') {
		dev = cursor.get('network', name, 'ifname');
	}
	if (dev == null || dev == '' || substr(dev, 0, 1) == '@') {
		return null;
	}
	return dev;
}

/*
 * 解析承载 5G 流量的网络设备名，与 init.d 的承载接口选择同口径：
 *   1) at-webserver.config.iface_v4 手动指定了接口 → 用该接口的网卡；
 *   2) 自动扫描（默认）→ 按 sysfs 找挂在 USB 总线上的网卡（承载的可能是固件自带的 wan）；
 *   3) 退回 MT5700M 接口的网卡，最后才是 eth2。
 * 不硬编码单一设备名，避免不同机型/接口命名下取不到计数。
 */
function detectModemDevice() {
	let dev = null;
	let cursor = null;
	try {
		cursor = uci.cursor();
		let name = cursor.get('at-webserver', 'config', 'iface_v4');
		if (name != null && name != '' && name != 'auto' && match(name, /^[A-Za-z0-9_]+$/)) {
			dev = ifaceNetdev(cursor, name);
		}
	} catch (e) {
		dev = null;
	}
	if (dev == null || dev == '') {
		dev = detectUsbNetdev();
	}
	if ((dev == null || dev == '') && cursor != null) {
		try {
			dev = ifaceNetdev(cursor, 'MT5700M');
		} catch (e) {
			dev = null;
		}
	}
	if (dev == null || dev == '') {
		dev = 'eth2';
	}
	return dev;
}

/* 十进制 → 大写十六进制（ucode 无 sprintf('%X') 之外的便捷格式化，自己拼） */
function toHexUpper(v) {
	const digits = '0123456789ABCDEF';
	let n = int(v) || 0;
	if (n < 0) {
		n = 0;
	}
	if (n == 0) {
		return '0';
	}
	let out = '';
	while (n > 0) {
		let d = n % 16;
		out = substr(digits, d, 1) + out;
		n = (n - d) / 16;
	}
	return out;
}

/*
 * 在 /proc/net/tcp 的内容里判断「回环地址上某端口是否处于 LISTEN」。
 *
 * /proc/net/tcp 行格式（内核固定 ABI）：
 *   sl  local_address rem_address   st tx_queue rx_queue ...
 *    5: 0100007F:223D 00000000:0000 0A 00000000:00000000 ...
 * local_address 是「小端十六进制 IP : 大写十六进制端口」，
 * 127.0.0.1 → 0100007F；st=0A 表示 TCP_LISTEN。
 *
 * 用 ucode 原生 split()/index()（实机 ucode 1.x 两者均可用，
 * 比手写逐字符扫描稳妥）。注意：本函数必须**先命中 local_address
 * 再判状态**，不能只搜端口号 —— 反向连接行的 rem_address 也含同一
 * 端口（如 "0100007F:EC96 0100007F:223D 06 ..." 是 TIME_WAIT），
 * 只看端口会把它们误判成监听。
 */
function tcpHasListen(tcpContent, port) {
	const key = '0100007F:' + toHexUpper(port);
	let lines = split(tcpContent, '\n');
	for (let i = 0; i < length(lines); i++) {
		let line = lines[i];
		if (index(line, key) < 0) {
			continue;
		}
		/* 状态列必须是 LISTEN(0A)：形如 "... 0000 0A 00000000..."，
		 * 用 ' 0A ' 前后带空格，避免匹配到 inode/计时列里的 0A 子串。 */
		if (index(line, ' 0A ') >= 0) {
			return true;
		}
	}
	return false;
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
	/* 计数最大 20 位（u64 上限约 1.8e19），多读几个字符不影响 int() 解析，
	 * 但能防止读到一个非计数器文件（例如误配成 fifo/块设备）时无限读取。 */
	let s = f.read(24);
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
 * 取网络接口累计字节数（只读，不累加任何东西）。
 *
 * 实时速率由前端按「两次采样差 / 时间差」计算；累计使用量改由 Rust 后端
 * 常驻采样统计（见 src/rust/src/usage.rs），与本方法无关 —— 那样才能做到
 * 前端关闭 / 刷新都不影响统计。
 *
 * 关键：全程不向模组下发任何 AT 命令，避免占用 AT 通道、干扰模组工作。
 */
function netrateCall(req) {
	let a = req.args;
	let dev = getStr(a, 'device');
	/* device 会拼进 sysfs 只读路径：只接受接口名字符（明确排除 '/'，
	 * 阻断 ../ 穿越）；非法值忽略并回落自动探测，不报错。 */
	if (dev != null && dev != '' && match(dev, /^[A-Za-z0-9._@:-]+$/) == null) {
		dev = null;
	}
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
		/* 走 sysfs 枚举，理论上是本机文件读取、毫秒级完成；仍加 6s 硬超时，
		 * 因为 usbCall 与 rpcCall 走的是同一套 fs.popen 机制，一旦子进程
		 * 卡住（sysfs 上有设备在异常热插拔时可能长时间阻塞在 d 状态），
		 * 同样会把 rpcd 上下文一起拖死。 */
		let tbin = findTimeoutBin();
		let shCmd = '/bin/sh -c ' + script;
		if (tbin != '') {
			shCmd = tbin + ' 6 /bin/sh -c ' + script;
		}
		p = fs.popen(shCmd, 'r');
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
	const ncBin = findNcBin();
	if (ncBin == '') {
		return {
			success: false,
			error: '系统缺少 nc（busybox 未编译 nc applet），无法连接后端：请安装 netcat 后重试',
			cause: 'no-nc'
		};
	}
	const timeoutBin = findTimeoutBin();

	/*
	 * 熔断窗口内直接快速失败，不再消耗 12s。
	 *
	 * 这是「单个请求超时」之外的第二道保护，用于对抗并发风暴：
	 * 第一个请求确认后端无应答后会写下标记，之后 15s 内的所有请求
	 * （可能是同一页面的几十个并发 RPC）都是在毫秒级返回，
	 * rpcd worker 不会被长时间占满，页面能正常渲染降级提示。
	 */
	let downRemain = backendDownRemain();
	if (downRemain > 0) {
		return {
			success: false,
			error: 'Rust 后端无应答，已暂停请求（约 ' + downRemain + 's 后自动恢复）',
			cause: 'circuit-open'
		};
	}

	/*
	 * 快速失败：先查回环 RPC 端口是否在监听。
	 *
	 * 动机：后端未运行时，原先要写临时文件、起 nc 子进程、走完整个 12s
	 * 超时预算才失败；前端对每个区块都单独跑一次且串行叠加，累积起来
	 * 就是「页面转圈很久」。预检能把这个场景压到毫秒级返回，
	 * 且**不生成临时文件、不起子进程、不占用后端 AT 通道**。
	 *
	 * 实现选型（本喵在实机上连续踩了两个坑后定的）：
	 *   - 不能用「nc 连一下看是否有应答」：busybox nc 在
	 *     `</dev/null` 时无论端口通不通**都返回 1**，stdout 也都是空，
	 *     两种情况完全不可区分（实测：已监听 rc=1、未监听 rc=1）。
	 *     而 fs.popen 句柄又拿不到退出码。
	 *   - 因此改为**纯文件读 /proc/net/tcp**：这是内核暴露的 TCP 表，
	 *     行格式为 "sl local_address rem_address st ..."，
	 *     监听态 st=0A，回环地址编码为 0100007F（小端 127.0.0.1），
	 *     端口为十六进制大写。
	 *     例：127.0.0.1:8765 → "0100007F:223D"（8765 = 0x223D）。
	 *   全程零子进程、零副作用，uLinux/OpenWrt 一定存在该文件。
	 *
	 * 判定失败时保守放行（继续走正常 RPC），宁可多走一次流程，
	 * 也绝不误判成「服务没起来」——误判的代价是用户以为插件坏了。
	 */
	let portUp = false;
	let portChecked = false;
	try {
		const tcp = fs.readfile('/proc/net/tcp');
		if (tcp != null && length(tcp) > 0) {
			portChecked = true;
			portUp = tcpHasListen(tcp, port);
		}
	} catch (e) {
		portChecked = false;
	}
	if (portChecked && !portUp) {
		/* 端口确实没监听：这是明确的「后端不在」，写下熔断标记，
		 * 让同一页面接下来几十个并发请求直接快速失败 */
		noteBackendDown();
		return {
			success: false,
			error: 'Rust 后端未运行（127.0.0.1:' + port + ' 未监听）：请确认 at-webserver 服务已启动',
			cause: 'not-listening'
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
	let rid = safeRid(getStr(params, '_rid'));
	if (rid == null) {
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

	/*
	 * 这是整个插件的**唯一阻塞点必须封顶**之处。
	 *
	 * 原先的实现是裸 fs.popen(nc ...) + p.read('line')：read 没有超时语义，
	 * nc 只要不退出（半开连接、后端 accept 后卡住不写回复、后端正在做长
	 * AT 扫描等），这个 ucode 请求就永久挂在 rpcd 上下文里，
	 * 后续所有 LuCI RPC 全部排队等待 —— 即用户看到的「整个页面卡死」。
	 *
	 * 改法：用 busybox timeout 给 nc 本身设硬上限，超时后 nc 被杀、
	 * 管道关闭、read('line') 返回 null，我们在下面把这种 null 明确
	 * 区分为「超时」而不是笼统的「无应答」，前端据此展示可读提示。
	 *
	 * 预算说明：后端 AT 命令最长 8s 排队 + 2s 执行，RPC 服务端自身
	 * 还留了 3s 余量（见 rpcserver.rs），故这里取 12s —— 比后端预算
	 * 略大，保证「后端确实在干活」的请求不会被误杀，同时把最坏耗时
	 * 从「不可控」压缩到 12s。
	 */
	/* 重定向目标加单引号包裹（纵深防御：rid 已过白名单，这里再挡一层
	 * 意外引入的空白/元字符拼接问题），busybox sh 支持单引号。 */
	let raw = ncBin + " 127.0.0.1 " + port + " < '" + tmp + "'";
	let timedOut = false;
	if (timeoutBin != '') {
		raw = timeoutBin + ' ' + RPCCALL_TIMEOUT_SEC + ' ' + raw;
	}

	let p;
	try {
		p = fs.popen(raw, 'r');
	} catch (e) {
		try { fs.unlink(tmp); } catch (e2) { /* 清不掉不影响主流程 */ }
		return { success: false, error: '无法连接 Rust 后端: ' + e.message, cause: 'spawn-failed' };
	}
	if (!p) {
		try { fs.unlink(tmp); } catch (e2) { /* 清不掉不影响主流程 */ }
		return { success: false, error: '无法连接 Rust 后端', cause: 'spawn-failed' };
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
		/*
		 * 返回 null 的三种可能，给出可区分的文案，避免用户误判：
		 * 1) 上面挂了 timeout → 后端在 12s 内没给出应答（长命令/正在重连）
		 * 2) 没挂 timeout 且 nc 连不上 → 服务未运行
		 * 3) nc 连上了但后端进程崩了/主动关闭 → 同上
		 *
		 * 无论哪种，都要写熔断标记 —— 这正是对抗并发风暴的关键：
		 * 第一个请求花 12s 探明「后端不会应答」之后，同页面其余几十个
		 * 并发请求就不该再各自重复这 12s（那会把 rpcd worker 耗尽，
		 * 最终浏览器看到的是整个 LuCI 的 XHR 超时，而不是降级提示）。
		 */
		noteBackendDown();
		if (timeoutBin != '') {
			return {
				success: false,
				error: 'Rust 后端应答超时（超过 ' + RPCCALL_TIMEOUT_SEC
					+ 's 未返回）：模组可能正在重连或执行长命令，请稍后重试',
				cause: 'timeout'
			};
		}
		return {
			success: false,
			error: 'Rust 后端无应答（服务未运行或端口 ' + port + ' 未监听）',
			cause: 'no-reply'
		};
	}
	if (substr(line, 0, 1) != '{') {
		return { success: false, error: 'Rust 后端应答异常: ' + substr(line, 0, 160), cause: 'bad-reply' };
	}

	try {
		let resp = jsonParse(line);
		if (resp.error) {
			let msg = 'RPC 错误';
			if (resp.error.message) {
				msg = resp.error.message;
			}
			return { success: false, error: msg, cause: 'backend-error' };
		}
		/* 后端能正常应答业务请求：清除熔断标记，恢复正常服务。
		 * 注意清标记放在「拿到合法应答」之后，而不是「端口在监听」时 ——
		 * 端口监听但进程卡死（SIGSTOP）的场景正是我们要持续熔断的。 */
		clearBackendDown();
		if (resp.result) {
			return resp.result;
		}
		return {};
	} catch (e) {
		return { success: false, error: '解析应答失败: ' + e.message, cause: 'parse-failed' };
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
		notify_test: {
			args: { channel: '', _rid: '' },
			call: function (req) {
				let a = req.args;
				let ch = getStr(a, 'channel');
				if (ch == null || ch == '') {
					return { success: false, error: '缺少参数 channel' };
				}
				return rpcCall('notify_test', { channel: ch, _rid: getStr(a, '_rid') });
			}
		},
		qq_bind_status: {
			args: { _rid: '' },
			call: function (req) {
				return rpcCall('qq_bind_status', { _rid: getStr(req.args, '_rid') });
			}
		},
		netrate: {
			args: { device: '' },
			call: function (req) {
				return netrateCall(req);
			}
		},
		usage: {
			args: { _rid: '' },
			call: function (req) {
				return rpcCall('usage', { _rid: getStr(req.args, '_rid') });
			}
		},
		usage_ctl: {
			args: { action: '', days: 0, _rid: '' },
			call: function (req) {
				let a = req.args;
				let action = getStr(a, 'action');
				/* action 走白名单，不透传客户端原值；days 只在 set_auto_reset_days 时带上 */
				if (action != 'reset' && action != 'persist_on' && action != 'persist_off' && action != 'set_auto_reset_days') {
					return { success: false, error: '不支持的 usage_ctl 动作' };
				}
				let params = { action: action, _rid: getStr(a, '_rid') };
				if (action == 'set_auto_reset_days') {
					params.days = int(getStr(a, 'days')) || 0;
				}
				return rpcCall('usage_ctl', params);
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
