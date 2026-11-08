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
 * 取布尔参数。
 *
 * 必须**同时**认 JSON 真布尔与字符串两种写法：`rpc.js` 的 `sms()` 走的是
 * `params.enable === true || …`，序列化出去就是 JSON 的 `true`；而 ubus 命令行、
 * 旧版前端、以及手写的调用方习惯传 `'1'` / `'true'`。
 *
 * 实测故障：这里原来写成
 *     params.enable = (getStr(a, 'enable') == '1' || getStr(a, 'enable') == 'true');
 * 只认字符串。前端传过来的 `true` 是布尔，跟 `'1'`/`'true'` 都不等，
 * 于是「打开短信功能」「打开 IMS」两种操作**全部被当成 false 下发** ——
 * 界面上看着点了开，模组那边执行的是关。配合 `args` 里 `enable` 的声明
 * （原本是 `''`，见 `sms` 方法的注释）又会让请求直接返回 `[2]`，
 * 排查时两条线索互相掩盖，非常难定位。
 */
function getBool(obj, key) {
	let v = getStr(obj, key);
	if (v == null || v == '' || v == '0' || v == 'false' || v == 'no' || v == 'off') {
		return false;
	}
	return true;
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
				else if (e == 'b') { out += chr(8); }
				else if (e == 'f') { out += chr(12); }
				else if (e == '"') { out += '"'; }
				else if (e == '\\') { out += '\\'; }
				else if (e == '/') { out += '/'; }
				/*
				 * \uXXXX —— 必须真正还原成字符，不能一个字母一个字母往外吐。
				 *
				 * 为什么这条不是「锦上添花」：AT 终端的应答里会出现 ESC(0x1B)、
				 * Ctrl+Z(0x1A) 这类控制字符，serde_json 序列化时一定会写成
				 * \u001b / \u001a。旧实现的 else 分支把它们拆成 'u','0','0','1','b'
				 * 五个字符，于是 ucode 交给 rpcd、rpcd 再交给前端的那份
				 * data 里，本来一个字节的控制字符变成了五个可见字符：
				 *   - 页面显示的应答与实际下发/回传的内容不一致；
				 *   - 任何拿应答再做判断的逻辑（例如把 \u001a 当作提交结束符）
				 *     一律失配。
				 * 必须用 uchr() 而不是 chr()：chr 是字节级的，值 >255 直接截断成
				 * 0xFF（实机验证 chr(hex("4e2d")) 得到单字节 0xFF），一旦序列化方
				 * 改成对非 ASCII 也走 \u 转义就会静默产出乱码；uchr 编 UTF-8。
				 * serde_json 默认只对 <0x20 的控制字符写 \u00XX，但这里不依赖
				 * 序列化方的这个行为。只处理 BMP 内的四位数（JSON 里 \uXXXX 就是
				 * 四位十六进制）；代理对（\uD8xx）在本插件的应答里不会出现。
				 */
				else if (e == 'u') {
					let hexs = substr(s, i + 1, 4);
					if (length(hexs) == 4 && match(hexs, /^[0-9A-Fa-f]{4}$/) != null) {
						out += uchr(hex(hexs));
						i += 4;
					} else {
						out += e;
					}
				}
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
 * 短信提交（`AT+CMGS=<长度>` + 字面 `\r` + `<PDU>`，见 atclient::is_single_shot_cmgs）
 * 的 nc 硬超时。
 *
 * 后端为这条命令单独放宽到 40s（atclient::SMS_SUBMIT_TIMEOUT）：模组要把 TPDU
 * 交给网络侧，`+CMGS` 回执取决于信号与基站排队。若这里仍按 12s 掐断，用户看到
 * 的是「RPC 应答超时」而不是模组的真实结果 —— 一条本来成功的短信被报成失败，
 * 重新发送又会重复计费，比慢一点更糟。取 50s：比后端预算大 10s，保证先拿到
 * 后端给的明确结论（成功/模组拒绝/模组无响应）。
 */
const SMS_RPC_TIMEOUT_SEC = 50;

/*
 * 语义化短信接口（method=sms）的 nc 硬超时，按动作分档。
 *
 * 与后端预算的对应关系（后端 = 排队 + 执行 + 余量，这里必须比后端大）：
 *   send / purge  70s —— 后端 SMS_QUEUE_WAIT(10) + SMS_SEND_TOTAL_BUDGET(60) + 余量。
 *                        长短信要连续提交多片，总预算是**整个事务**的而不是每片的，
 *                        所以这里给的是总预算的量级；短信提交慢一点没关系，
 *                        被掐断才会出现「其实发出去了却报失败」。
 *   list / capacity / set_storage / get_smsc / set_smsc
 *                  40s —— 排队(10) + SMS_LIST_TIMEOUT(25) + 余量。
 *                        AT+CMGL=4 要吐出全部 PDU，几十条时远不止普通查询的 2s。
 *   delete         40s —— 排队(10) + 每个槽位一句 AT+CMGD(2) + 收尾回读(2)。
 *                        模组不收槽位列表，删除是一条一句（实机同理），耗时与
 *                        槽位数成正比；界面按 8 个槽位一批下发（sms_center.js 的
 *                        SMS_DELETE_CHUNK），最坏 10+16+2=28s，留 12s 余量。
 *                        这条以前没上榜，走默认 12s —— 删两条分段短信就会撞断
 *                        `nc`，而断掉的那次还会打开「后端不可用」的共享熔断，
 *                        连别的页面一起 15s 内全部快速失败。
 *   session_*      12s —— 纯内存操作，走默认预算。
 */
const SMS_ACTION_TIMEOUT = {
	'send': 70,
	'purge': 70,
	'delete': 40,
	'list': 40,
	'capacity': 40,
	'set_storage': 40,
	'get_smsc': 40,
	'set_smsc': 40,
	'power': 70,
	'set_ims': 40,
	'get_ims': 40,
	/* 归档三个动作只做本地文件读写，不下发任何 AT，预算给短一点 */
	'store_stats': 20,
	'store_read': 20,
	'store_drop': 20
};

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

/* 网卡计数器是否可读；不可用的物理绑定不能直接用于流量采样。
 * 注意顺序：ucode 不做函数声明提升（先声明后使用，与 JS 不同），
 * readCounter 必须写在本题之上，否则 netrate 运行时报
 * “access to undeclared variable readCounter”，整条 RPC 直接失败。 */
function netdevUsable(dev) {
	if (dev == null || dev == '') {
		return false;
	}
	return readCounter('/sys/class/net/' + dev + '/statistics/rx_bytes') != null;
}

/* 取 `uci show` 某行等号右侧的引号内取值，返回空格分隔的 token 串。
 * 标量 'eth2' 与列表 'a' 'b' 都能处理；无引号时退化为取首个空白分隔项。 */
function uciValueTokens(raw) {
	let parts = split(raw, "'");
	let out = '';
	for (let i = 1; i < length(parts); i += 2) {
		let v = trim(parts[i]);
		if (v != '') {
			out = out + v + ' ';
		}
	}
	if (out == '') {
		let plain = split(trim(raw), ' ');
		if (length(plain) > 0) {
			out = plain[0] + ' ';
		}
	}
	return out;
}

/* 执行 `uci -q show <pkg>`，把全部输出拼成一个文本返回（失败返回空串）。 */
function uciShowText(pkg) {
	let p;
	try {
		p = fs.popen('uci -q show ' + pkg, 'r');
	} catch (e) {
		return '';
	}
	if (!p) {
		return '';
	}
	let text = '';
	while (true) {
		let line = p.read('line');
		if (line == null) {
			break;
		}
		text = text + line;
	}
	p.close();
	return text;
}

/* 从 `uci show firewall` 文本里取指定区域（wan / lan）的逻辑接口名，空格分隔。
 * 先找 name='<zone>' 的 section，再取同 section 的 network 列表，
 * 兼容匿名 section（@zone[1]）与命名 section。 */
function zoneIfaces(text, zone) {
	let lines = split(text, '\n');
	let sections = ' ';
	for (let i = 0; i < length(lines); i++) {
		let pos = index(lines[i], '=');
		if (pos < 0) continue;
		let kp = split(trim(substr(lines[i], 0, pos)), '.');
		if (length(kp) != 3 || kp[2] != 'name') continue;
		let vals = split(trim(uciValueTokens(substr(lines[i], pos + 1))), ' ');
		if (length(vals) > 0 && vals[0] == zone) {
			sections = sections + kp[1] + ' ';
		}
	}
	let out = '';
	for (let i = 0; i < length(lines); i++) {
		let pos = index(lines[i], '=');
		if (pos < 0) continue;
		let kp = split(trim(substr(lines[i], 0, pos)), '.');
		if (length(kp) != 3 || kp[2] != 'network') continue;
		if (index(sections, ' ' + kp[1] + ' ') < 0) continue;
		let vals = split(trim(uciValueTokens(substr(lines[i], pos + 1))), ' ');
		for (let j = 0; j < length(vals); j++) {
			if (index(' ' + out, ' ' + vals[j] + ' ') < 0) {
				out = out + vals[j] + ' ';
			}
		}
	}
	return out;
}

/* 从 `uci show network` 文本里建立 section -> device/ifname 首值的映射。 */
function networkDevices(text) {
	let out = {};
	let lines = split(text, '\n');
	for (let i = 0; i < length(lines); i++) {
		let pos = index(lines[i], '=');
		if (pos < 0) continue;
		let kp = split(trim(substr(lines[i], 0, pos)), '.');
		if (length(kp) != 3 || (kp[2] != 'device' && kp[2] != 'ifname')) continue;
		let vals = split(trim(uciValueTokens(substr(lines[i], pos + 1))), ' ');
		if (length(vals) == 0) continue;
		/* device 优先于旧式 ifname；已写入则不再覆盖 */
		if (kp[2] == 'ifname' && out[kp[1]] != null) continue;
		out[kp[1]] = vals[0];
	}
	return out;
}

/* 逻辑接口 -> 物理网卡；@别名最多跟 4 层，防配置成环。 */
function resolveNetdev(iface, devs) {
	let cur = iface;
	for (let i = 0; i < 4; i++) {
		let v = devs[cur];
		if (v == null || v == '') return null;
		if (substr(v, 0, 1) == '@') {
			cur = substr(v, 1);
			continue;
		}
		return v;
	}
	return null;
}

/* LAN 侧网卡判定：硬排除 br-lan 及 VLAN 子接口、lo，以及 LAN 区域绑定的网卡。 */
function isLanSide(dev, lanTokens) {
	if (dev == null || dev == '' || dev == 'lo' || dev == 'br-lan') return true;
	if (substr(dev, 0, 7) == 'br-lan.') return true;
	if (index(' ' + lanTokens + ' ', ' ' + dev + ' ') >= 0) return true;
	return false;
}

/* 网卡是否被「非 LAN 区域」的 network 接口绑定：
 * 候选全无时给 USB 网卡做 WAN 侧归属校验。 */
function boundOutsideLan(dev, devs, lanIfaces) {
	let ks = keys(devs);
	let lanList = split(trim(lanIfaces), ' ');
	for (let i = 0; i < length(ks); i++) {
		let skip = false;
		for (let j = 0; j < length(lanList); j++) {
			if (lanList[j] == ks[i]) {
				skip = true;
				break;
			}
		}
		if (skip) continue;
		if (devs[ks[i]] == dev) return true;
	}
	return false;
}

/* 统计来源：netdev（默认，sysfs）/ modem（模组 AT^DSFLOWQRY）。
 * 非法值一律回落 netdev，避免误配导致口径漂移。 */
function usageSource() {
	let p;
	try {
		p = fs.popen('uci -q get at-webserver.config.usage_source', 'r');
	} catch (e) {
		return 'netdev';
	}
	if (!p) return 'netdev';
	let line = p.read('line');
	p.close();
	if (line != null && trim(line) == 'modem') return 'modem';
	return 'netdev';
}

/*
 * 选出流量统计用的唯一物理网卡（与 src/rust/src/usage.rs 同语义）。
 * 全程不写死任何网卡名，自动识别「模组创建的 WAN 口 / 物理网口」：
 *   1) WAN 区域成员（交集）USB 模组网口 -> 采用；
 *   2) 模组网口未命中时，取 WAN 区域里第一个非 LAN 侧的可用物理网口；
 *   3) 候选全无时，仍只接受「非 LAN 归属的 USB 网卡」；
 *   4) 全部失败返回 null —— 停止统计，绝不回退 LAN / br-lan。
 * 取数只走一次 `uci show firewall` + 一次 `uci show network`，
 * 比旧实现逐个 `uci get` 起子进程更省。
 */
function detectWanDevice() {
	let fwText = uciShowText('firewall');
	let netText = uciShowText('network');
	let wanIfaces = zoneIfaces(fwText, 'wan');
	let lanIfaces = zoneIfaces(fwText, 'lan');
	if (trim(wanIfaces) == '') {
		wanIfaces = 'MT5700M MT5700Mv6 wan wan6 ';
	}
	let devs = networkDevices(netText);

	let lanTokens = '';
	let lanList = split(trim(lanIfaces), ' ');
	for (let i = 0; i < length(lanList); i++) {
		let d = resolveNetdev(lanList[i], devs);
		if (d != null) lanTokens = lanTokens + d + ' ';
	}

	let candidates = '';
	let wanList = split(trim(wanIfaces), ' ');
	for (let i = 0; i < length(wanList); i++) {
		let d = resolveNetdev(wanList[i], devs);
		if (d == null || isLanSide(d, lanTokens)) continue;
		if (!netdevUsable(d)) continue;
		if (index(' ' + candidates, ' ' + d + ' ') >= 0) continue;
		candidates = candidates + d + ' ';
	}

	let usb = null;
	try {
		usb = detectUsbNetdev();
	} catch (e) {
		usb = null;
	}

	/* 1) 模组创建的 WAN 口 */
	if (usb != null && index(' ' + candidates, ' ' + usb + ' ') >= 0) return usb;
	/* 2) 默认 WAN 口所在的物理网卡：设备上没有模组专用 WAN 口可用时，
	 * 按 network.wan 反查出的物理网卡统计，仍绝不回退 LAN。
	 * 仅当 wan 逻辑接口确实属于 WAN 区域时才采用。 */
	if (index(' ' + trim(wanIfaces) + ' ', ' wan ') >= 0) {
		let defaultWan = resolveNetdev('wan', devs);
		if (defaultWan != null && !isLanSide(defaultWan, lanTokens)
			&& netdevUsable(defaultWan)) return defaultWan;
	}
	/* 3) WAN 区域内的其它物理网口。
	 * 实机 ucode 的 split('', ' ') 返回 [''] 而不是 []，必须跳过空项，
	 * 否则候选全无时会返回空串、直接吞掉下面第 3 级 USB 回落。 */
	let list = split(trim(candidates), ' ');
	for (let i = 0; i < length(list); i++) {
		if (list[i] != '') return list[i];
	}
	/* 4) 候选全无：只认非 LAN 归属的 USB 网卡 */
	if (usb != null && !isLanSide(usb, lanTokens) && netdevUsable(usb)
		&& boundOutsideLan(usb, devs, lanIfaces)) return usb;
	return null;
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
		/* script 必须整体用单引号包住：fs.popen 等价于 `sh -c "<整串>"`，裸拼的话
		 * 内层 sh 只会拿到第一个词（这里是 echo），剩下的 `for ... done` 跑到**没有
		 * timeout 包裹**的外层 shell 里执行 —— 6s 保护形同不存在。
		 * 写法与本文件 detectUsbNetdev() 里已验证的形态保持一致。 */
		let shCmd = "/bin/sh -c '" + script + "'";
		if (tbin != '') {
			shCmd = tbin + ' 6 ' + shCmd;
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
			let i = index(rest, '|');
			if (i < 0) {
				continue;
			}
			speed = trim(substr(rest, 0, i));
			let tail = substr(rest, i + 1);
			let k = index(tail, '|');
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

/*
 * 后端的 { id, error:{ message, ... } } 应答 → ucode 插件交给前端的扁平错误对象。
 *
 * 为什么要单独成函数：错误对象里的 cause 等字段是「分层预算」这套设计的判据
 * （前端据它区分超时 / 端口未监听 / 熔断，见 rpc.js 的 noteCommandFailure），
 * 而旧实现只把 message 搬出来，其余字段全丢，前端只能一律按「模组 ERROR」处理。
 * 这里把它们平移到顶层，与业务结果形态（resp.cause / resp.error）保持同一套读法。
 *
 * 只搬标量：嵌套对象/数组不进错误对象，避免前端拿到形状不确定的字段。
 *
 * 注意顺序：ucode 不做函数声明提升，本函数必须写在 rpcCall 之上 ——
 * 它只会在后端出错时被调用，一旦顺序反了，故障态下这条 catch 分支自己先抛
 * ReferenceError，前端看到的就不是结构化错误而是 “Unknown error”。
 */
function backendErrorShape(err, msg) {
	let out = { success: false, cause: 'backend-error' };
	let ks = keys(err);
	for (let i = 0; i < length(ks); i++) {
		let k = ks[i];
		if (k == 'message') {
			continue;
		}
		let v = err[k];
		if (v == null || type(v) == 'object' || type(v) == 'array') {
			continue;
		}
		out[k] = v;
	}
	out.error = msg;
	return out;
}

/*
 * timeoutSec 可选：单次调用的 nc 硬超时覆盖（秒）。目前只有短信提交用到，
 * 其余调用维持 RPCCALL_TIMEOUT_SEC，避免后端真挂掉时每条命令都白等更久。
 */

/*
 * 一次批量里最多允许几条命令。
 *
 * 上限不是为了省内存，而是限制「一条卡住、整批晚到」的最坏影响面：
 * 批量是同一条连接上逐行串行处理的，某条超时会把整批的应答一起往后推。
 * 32 条足够覆盖 status 页一轮的全部查询，又不会把单次等待放大到分钟级。
 */
const BATCH_RPC_TIMEOUT_SEC = 18;
const BATCH_MAX_CMDS = 32;

/*
 * RPC 门禁：配置读取、nc/timeout 定位、熔断窗口、回环端口预检。
 *
 * 抽成独立函数的原因：批量接口（batch）必须与单条接口（at）走**完全相同**的门禁。
 * 否则后端挂掉时批量路径会绕开熔断，一次批量把 rpcd worker 占住十几秒，
 * 又回到「整个 LuCI 转圈」的老问题。
 *
 * 返回 { port, authKey, ncBin, timeoutBin, rid, err }；err 非 null 即为应直接
 * 返回给前端的错误对象，调用方不必再往下走。
 */
function rpcGate(params) {
	const rpcCfg = readRpcConfig();
	const port = rpcCfg.port;
	const authKey = rpcCfg.authKey;

	/* 本固件 ucode fs 无 connect，经 busybox nc 管道访问回环 RPC。
	 * 各固件的 busybox 未必编译 nc applet，因此先定位可执行文件：
	 * 找不到时必须给出可诊断的报错，而不是笼统的「后端无应答」——
	 * 后者会让人误判成服务没起来，实际是装了插件却缺 nc。 */
	const ncBin = findNcBin();
	if (ncBin == '') {
		return { err: {
			success: false,
			error: '系统缺少 nc（busybox 未编译 nc applet），无法连接后端：请安装 netcat 后重试',
			cause: 'no-nc'
		} };
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
		return { err: {
			success: false,
			error: 'Rust 后端无应答，已暂停请求（约 ' + downRemain + 's 后自动恢复）',
			cause: 'circuit-open'
		} };
	}

	/*
	 * 快速失败：先查回环 RPC 端口是否在监听。
	 *
	 * 动机：后端未运行时，原先要写临时文件、起 nc 子进程、走完整个 12s
	 * 超时预算才失败；前端对每个区块都单独跑一次且串行叠加，累积起来
	 * 就是「页面转圈很久」。预检能把这个场景压到毫秒级返回，
	 * 且**不生成临时文件、不起子进程、不占用后端 AT 通道**。
	 *
	 * 实现选型（在实机上连续踩了两个坑后定的）：
	 *   - 不能用「nc 连一下看是否有应答」：busybox nc 在
	 *     `</dev/null` 时无论端口通不通**都返回 1**，stdout 也都是空，
	 *     两种情况完全不可区分（实测：已监听 rc=1、未监听 rc=1）。
	 *   - 因此改为**纯文件读 /proc/net/tcp**：这是内核暴露的 TCP 表，
	 *     监听态 st=0A，回环地址编码为 0100007F（小端 127.0.0.1），
	 *     端口为十六进制大写。
	 *   全程零子进程、零副作用，Linux / OpenWrt 一定存在该文件。
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
		/* 端口确实没监听：写明「后端不在」，并写熔断标记，
		 * 让同一页面接下来几十个并发请求直接快速失败 */
		noteBackendDown();
		return { err: {
			success: false,
			error: 'Rust 后端未运行（127.0.0.1:' + port + ' 未监听）：请确认 at-webserver 服务已启动',
			cause: 'not-listening'
		} };
	}

	/*
	 * 临时文件名必须唯一。
	 *
	 * 实测问题：原先固定为 /tmp/mt5700-rpc.json，而页面会**并发**发起多个 RPC
	 * （日志页一次就发 3 个：后端日志 + syslog + 通知文件），多个请求写同一个
	 * 文件、再各自读同一个文件，互相覆盖，表现为「RPC 返回空对象」这种极难排查
	 * 的间歇性故障 —— 单独手动调用却完全正常。
	 *
	 * 唯一性由调用方传入的 _rid 提供；没传时退化为「时间戳 + 自增」，
	 * 同一秒内的多次调用也能区分（ucode 的 time() 只有秒级）。
	 */
	let rid = safeRid(getStr(params, '_rid'));
	if (rid == null) {
		rid = sprintf('%d-%d', time(), rpcFallbackSeq++);
	}
	return { port: port, authKey: authKey, ncBin: ncBin, timeoutBin: timeoutBin, rid: rid, err: null };
}

/*
 * 超时 / 无应答的文案。
 *
 * 返回 null 的三种可能，必须给出可区分的文案，避免用户误判：
 * 1) 挂了 timeout → 后端在预算内没给出应答（长命令/正在重连）
 * 2) 没挂 timeout 且 nc 连不上 → 服务未运行
 * 3) nc 连上了但后端进程崩了/主动关闭 → 同上
 *
 * 无论哪种都要写熔断标记 —— 这正是对抗并发风暴的关键：
 * 第一个请求花掉预算探明「后端不会应答」之后，其余并发请求不该再各自重复等。
 */
function timeoutReply(hasTimeoutBin, budgetSec, port) {
	noteBackendDown();
	if (hasTimeoutBin) {
		return {
			success: false,
			error: 'Rust 后端应答超时（超过 ' + budgetSec
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

/*
 * 一行请求 = 一行应答地送进回环 RPC，读回原始应答行。
 *
 * 为什么可以一次送多行：回环 RPC 是「一行请求一行应答」的流式协议，
 * 后端在**同一条连接**上循环读行、逐行应答并逐行写回，
 * 因此把 N 条命令写进同一个临时文件、用**一个** nc 进程送过去，
 * 语义与原来「N 次调用各起一个 nc」完全一致（顺序也一致，后端逐行串行处理）。
 *
 * 收益（实机 status 页，普通模式冷启动）：单条调用的桥开销实测 17ms
 * （ucode 临时文件 + fork nc + rpcd 往返），一轮 25 条就是 400ms 以上；
 * 合并成一次只付一次。
 *
 * 这也是整个插件**唯一的阻塞点**，必须封顶：nc 用 busybox timeout 包住，
 * 超时后子进程被杀、管道关闭、read('line') 返回 null，把「永久阻塞」
 * 降级为「有限等待 + 明确错误」。
 *
 * 返回 { lines: [...], complete: bool, err: 错误对象|null }。
 */
function rpcSendLines(payloads, budgetSec, gate) {
	const tmp = '/tmp/mt5700-rpc-' + gate.rid + '.json';
	let f;
	try {
		f = fs.open(tmp, 'w');
	} catch (e) {
		return { lines: [], complete: false, err: { success: false, error: '无法写临时文件' } };
	}
	if (!f) {
		return { lines: [], complete: false, err: { success: false, error: '无法写临时文件' } };
	}
	for (let i = 0; i < length(payloads); i++) {
		f.write(sprintf('%J', payloads[i]) + '\n');
	}
	f.close();

	/* 重定向目标加单引号包裹（纵深防御：rid 已过白名单，这里再挡一层
	 * 意外引入的空白/元字符拼接问题），busybox sh 支持单引号。 */
	let raw = gate.ncBin + " 127.0.0.1 " + gate.port + " < '" + tmp + "'";
	if (gate.timeoutBin != '') {
		raw = gate.timeoutBin + ' ' + budgetSec + ' ' + raw;
	}

	let p;
	try {
		p = fs.popen(raw, 'r');
	} catch (e) {
		try { fs.unlink(tmp); } catch (e2) { /* 清不掉不影响主流程 */ }
		return { lines: [], complete: false, err: {
			success: false, error: '无法连接 Rust 后端: ' + e.message, cause: 'spawn-failed'
		} };
	}
	if (!p) {
		try { fs.unlink(tmp); } catch (e2) { /* 清不掉不影响主流程 */ }
		return { lines: [], complete: false, err: {
			success: false, error: '无法连接 Rust 后端', cause: 'spawn-failed'
		} };
	}

	let lines = [];
	while (length(lines) < length(payloads)) {
		let l = p.read('line');
		if (l == null || l == '') {
			break;
		}
		lines[length(lines)] = l;
	}
	p.close();
	/* 用完即删，避免每次 RPC 都在 /tmp 留一个文件 */
	try { fs.unlink(tmp); } catch (e) { /* 删不掉不影响主流程 */ }

	return { lines: lines, complete: (length(lines) == length(payloads)), err: null };
}

/*
 * 把一行原始应答整形为前端契约对象，字段与改动前的单条接口完全一致。
 * 返回 null 表示「这一行没有应答」，由调用方补超时/无应答文案。
 */
function shapeReply(line) {
	if (line == null || line == '') {
		return null;
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
			/* 字段搬运与理由见 backendErrorShape 的注释 */
			return backendErrorShape(resp.error, msg);
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

function rpcCall(method, params, timeoutSec) {
	const gate = rpcGate(params);
	if (gate.err != null) {
		return gate.err;
	}

	const payload = { id: 1, method: method, params: params };
	if (gate.authKey != '') {
		payload.params.auth_key = gate.authKey;
	}

	/* 预算说明：后端 AT 命令最长 8s 排队 + 2s 执行，RPC 服务端自身
	 * 还留了 3s 余量（见 rpcserver.rs），故这里取 12s —— 比后端预算
	 * 略大，保证「后端确实在干活」的请求不会被误杀，同时把最坏耗时
	 * 从「不可控」压缩到 12s。 */
	const budgetSec = (timeoutSec != null && timeoutSec > 0) ? timeoutSec : RPCCALL_TIMEOUT_SEC;
	const sent = rpcSendLines([payload], budgetSec, gate);
	if (sent.err != null) {
		return sent.err;
	}
	const shaped = shapeReply(sent.lines[0]);
	if (shaped != null) {
		return shaped;
	}
	return timeoutReply(gate.timeoutBin != '', budgetSec, gate.port);
}

/* 取网络接口累计字节数（只读，不累加任何东西）。
 *
 * 实时速率由前端按「两次采样差 / 时间差」计算；累计使用量由 Rust 后端
 * 常驻采样统计（src/rust/src/usage.rs），与本方法无关。
 *
 * 统计口径与后端一致，由 `usage_source` 手动切换：
 *   netdev（默认） -> 自动识别 WAN 区域模组物理网口，直读 sysfs，零 AT 负担；
 *   modem          -> 转发到 Rust 后端，取 AT^DSFLOWQRY 的 DS 累计值。
 * 两种情况都排除 br-lan / lo / LAN 区域网卡，取不到即 success:false，绝不回退 LAN。
 *
 * 本函数必须放在 rpcCall() 之后：ucode 不做函数声明提升，放在前面会在
 * 运行时报 "access to undeclared variable rpcCall"（见 AGENTS 声明顺序守卫）。
 */
function netrateCall(req) {
	let a = req.args;
	let dev = getStr(a, 'device');
	/* device 会拼进 sysfs 只读路径：只接受接口名字符（明确排除 '/'，
	 * 阻断 ../ 穿越）；非法值忽略并回落自动探测，不报错。 */
	if (dev != null && dev != '' && match(dev, /^[A-Za-z0-9._@:-]+$/) == null) {
		dev = null;
	}

	/* 模组来源：交给后端取 DS 累计值，保证速率与「本次使用量」同口径。
	 * 后端走已有的 2s 状态缓存，不会额外挤占 AT 通道。 */
	if (usageSource() == 'modem') {
		return rpcCall('netrate', {
			device: dev == null ? '' : dev,
			_rid: getStr(a, '_rid')
		});
	}

	let wan = detectWanDevice();
	/* 显式入参必须与自动识别结果一致：br-lan / lo / LAN 侧网卡一律拒绝，
	 * 防止旧前端或手工 RPC 把局域网桥接流量算成蜂窝流量。 */
	if (dev != null && dev != '' && dev != wan) {
		dev = null;
	}
	if (dev == null || dev == '') {
		dev = wan;
	}
	if (dev == null || dev == '') {
		return { success: false, device: '', error: '未识别到 WAN 区域网卡，已停止统计（不回退 LAN/br-lan）' };
	}

	const base = '/sys/class/net/' + dev;
	const rx = readCounter(base + '/statistics/rx_bytes');
	const tx = readCounter(base + '/statistics/tx_bytes');
	if (rx == null && tx == null) {
		return { success: false, device: dev, error: '读不到 WAN 接口计数器，设备可能不存在或未 up' };
	}
	return {
		success: true,
		device: dev,
		rx_bytes: rx == null ? 0 : rx,
		tx_bytes: tx == null ? 0 : tx
	};
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
				/* 短信提交：命令里同时带长度与 PDU。分隔符有两种写法 ——
				 * 字面的 `\r`（两个字符，业务路径与厂商 WebUI 的形态）与真实 CR
				 * （裸 AT 终端页手敲）。只报长度的那半步两种都没有，仍走默认超时。 */
				const smsSubmit = match(cmd, /^AT\+CMGS=[0-9]+/) != null &&
					(index(cmd, '\\r') >= 0 || index(cmd, '\r') >= 0);
				return rpcCall('at', { cmd: cmd, _rid: getStr(a, '_rid') },
					smsSubmit ? SMS_RPC_TIMEOUT_SEC : null);
			}
		},

		/*
		 * 批量只读查询：一次 RPC 送达 N 条 AT 命令，按序执行、按序返回。
		 *
		 * 专治 status 页「一轮 25 条命令 = 25 次 ucode 临时文件 + 25 次 fork nc」。
		 * 实机测得单条桥开销 17ms，一轮就是 400ms 以上的纯桥成本。
		 *
		 * 语义与逐条调用完全一致：后端在**同一条连接**上逐行处理（AT 通道仍然
		 * 是单通道串行，互斥语义不变），每条命令的 success/data/error/cause
		 * 原样透出并按 cmd 标注；任何一条失败都不影响其余命令。
		 *
		 * 超时按**整批**计（BATCH_RPC_TIMEOUT_SEC），已到达的行照常返回，
		 * 未到达的条目给 timeout 文案 —— 与逐条超时的结果一致。
		 *
		 * cmd 走字符串校验、不做拼接，杜绝 AT 注入；含 IMEI 写得动的命令
		 * 依旧由后端 run_command 内部的既有校验拦截，这里不额外放行。
		 */
		batch: {
			args: { cmds: [], _rid: '' },
			call: function (req) {
				let a = req.args;
				let list = (a == null) ? null : a['cmds'];
				if (type(list) != 'array' || length(list) == 0) {
					return { success: false, error: '缺少参数 cmds（需为命令数组）' };
				}
				if (length(list) > BATCH_MAX_CMDS) {
					return { success: false, error: '一次最多 ' + BATCH_MAX_CMDS + ' 条命令' };
				}
				let cmds = [];
				let payloads = [];
				for (let i = 0; i < length(list); i++) {
					let c = list[i];
					if (type(c) != 'string' || c == '') {
						return { success: false, error: 'cmds 第 ' + (i + 1) + ' 项不是合法命令' };
					}
					cmds[length(cmds)] = c;
					payloads[length(payloads)] = { id: i + 1, method: 'at', params: { cmd: c } };
				}

				const gate = rpcGate(a);
				if (gate.err != null) {
					return gate.err;
				}
				if (gate.authKey != '') {
					for (let i = 0; i < length(payloads); i++) {
						payloads[i].params.auth_key = gate.authKey;
					}
				}

				const sent = rpcSendLines(payloads, BATCH_RPC_TIMEOUT_SEC, gate);
				if (sent.err != null) {
					return sent.err;
				}

				let items = [];
				for (let i = 0; i < length(cmds); i++) {
					let one = shapeReply(sent.lines[i]);
					if (one == null) {
						one = timeoutReply(gate.timeoutBin != '', BATCH_RPC_TIMEOUT_SEC, gate.port);
					}
					one.cmd = cmds[i];
					items[length(items)] = one;
				}
				return { success: true, items: items };
			}
		},
		/*
		 * 语义化短信接口。
		 *
		 * 为什么不继续用 `at` 透传一串 AT+CMGF/CSCA/CMGS：那些命令是**多步**的，
		 * 每一步都是一次独立的 RPC，中间随时可能被后台巡检（信号、缓存、流量、
		 * 自动拨号对账）插进来，把「刚切到 PDU 模式 / 刚收到 > 提示符」的模组
		 * 上下文打乱。这里改成一次 RPC 交一个动作，由后端在**一次事务**里跑完
		 * 全部步骤，全程独占通道。
		 *
		 * action 走白名单，参数逐项取值后透传，不做命令拼接，杜绝 AT 注入。
		 */
		sms: {
			/*
			 * args 的**字面量类型**决定 rpcd 怎么校验入参，不是注释。
			 *
			 * 实测故障：`enable` 曾声明成 `''`（字符串），而 rpc.js 传的是布尔值
			 * （`params.enable === true || …`）；`indices` 声明成 `''`，而批量删除传的是数组。
			 * rpcd 对 ucode 插件会按声明的类型校验，类型不符直接返回
			 * `{"result":[2]}`（UBUS_STATUS_INVALID_ARGUMENT）——**插件函数压根不会被执行**，
			 * 于是 `list` / `capacity` / `send` / `session_open` 全部拿不到数据。
			 * 前端把 `result: 2` 当成后端应答，`send` 走了兜底分支报
			 * 「模组拒绝了这条短信」（那是 `r.message` 为 undefined 时的兜底文案），
			 * 看上去就像「模组拒收」。
			 * 因此这里必须按**实际传入的类型**声明：`enable` → 布尔，`indices` → 数组。
			 * 未提供的参数由 LuCI 省略（undefined 不进 JSON），不会触发校验。
			 */
			args: { action: '', destination: '', message: '', smsc: '', mem: '', indices: [], session_id: 0, ttl_ms: 0, dedup_key: '', enable: false, number: '', items: [], all: false, _rid: '' },
			call: function (req) {
				let a = req.args;
				let action = getStr(a, 'action');
				if (action == null || action == '') {
					return { success: false, error: '缺少参数 action' };
				}
			let known = ['list', 'send', 'delete', 'purge', 'capacity', 'set_storage',
				'get_smsc', 'set_smsc', 'power', 'set_ims', 'get_ims',
	'session_open', 'session_renew', 'session_release',
	'store_stats', 'store_read', 'store_drop'];
				if (index(known, action) < 0) {
					return { success: false, error: '不支持的短信动作: ' + action };
				}
				let params = { action: action, _rid: getStr(a, '_rid') };
				if (action == 'send') {
					params.destination = getStr(a, 'destination') || '';
					params.message = getStr(a, 'message') || '';
					let sc = getStr(a, 'smsc');
					if (sc != null && sc != '') params.smsc = sc;
					let dk = getStr(a, 'dedup_key');
					if (dk != null && dk != '') params.dedup_key = dk;
				} else if (action == 'delete') {
					params.indices = a.indices;
				} else if (action == 'set_storage') {
					params.mem = getStr(a, 'mem') || '';
				} else if (action == 'set_smsc') {
					params.smsc = getStr(a, 'smsc') || '';
				} else if (action == 'power' || action == 'set_ims') {
					params.enable = getBool(a, 'enable');
					if (action == 'power') {
						let sc = getStr(a, 'smsc');
						if (sc != null && sc != '') params.smsc = sc;
					}
				} else if (action == 'store_read' || action == 'store_drop') {
					params.number = getStr(a, 'number') || '';
					if (action == 'store_drop') {
						/* 指纹由后端计算，这里只透传原始字段 */
						params.items = a.items || [];
						params.indices = a.indices || [];
						params.all = getBool(a, 'all');
					}
				} else if (action == 'session_renew' || action == 'session_release') {
					params.session_id = int(getStr(a, 'session_id')) || 0;
					let ttl = int(getStr(a, 'ttl_ms'));
					if (ttl != null && ttl > 0) params.ttl_ms = ttl;
				} else if (action == 'session_open') {
					let ttl = int(getStr(a, 'ttl_ms'));
					if (ttl != null && ttl > 0) params.ttl_ms = ttl;
				}
				return rpcCall('sms', params, SMS_ACTION_TIMEOUT[action]);
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
		qq_menu: {
			args: { action: 'set', _rid: '' },
			call: function (req) {
				let a = req.args;
				let action = getStr(a, 'action');
				if (action == null || action == '') {
					action = 'set';
				}
				return rpcCall('qq_menu', { action: action, _rid: getStr(a, '_rid') });
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
			args: { action: '', day: 0, source: '', _rid: '' },
			call: function (req) {
				let a = req.args;
				let action = getStr(a, 'action');
				/* action 走白名单，不透传客户端原值；day / source 按动作带上 */
				if (action != 'reset' && action != 'persist_on' && action != 'persist_off'
					&& action != 'set_reset_day' && action != 'set_source') {
					return { success: false, error: '不支持的 usage_ctl 动作' };
				}
				let params = { action: action, _rid: getStr(a, '_rid') };
				if (action == 'set_reset_day') {
					/* 每月几号：1~31，越界交给后端夹取（大小月判定也在后端 monthly 模块） */
					params.day = int(getStr(a, 'day')) || 0;
				}
				if (action == 'set_source') {
					/* 来源走白名单：只认 netdev / modem，其它值后端也会回落 netdev */
					let source = getStr(a, 'source');
					if (source == 'modem') {
						params.source = 'modem';
					} else {
						params.source = 'netdev';
					}
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
			args: { since: 0, limit: 300, cats: '', _rid: '' },
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
				let params = { since: since, limit: limit, _rid: getStr(a, '_rid') };
				/* cats：可选的类别过滤，逗号分隔的类别键（如 "sms,at"），留空=不过滤。
				 * 这里**不做白名单校验**：合法的类别表在后端 logcat.rs 里，抄一份到
				 * ucode 只会两边漂移；非法键后端会直接丢弃（结果是空列表，而不是
				 * 静默返回全部，拼错参数的人不会以为自己筛对了）。 */
				let cats = getStr(a, 'cats');
				if (cats != null && cats != '') {
					params.cats = sprintf('%s', cats);
				}
				return rpcCall('logs', params);
			}
		}
	}
};
