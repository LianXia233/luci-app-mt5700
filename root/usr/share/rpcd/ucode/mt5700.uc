'use strict';
/*
 * rpcd ucode 插件：mt5700。
 * ★ 2026-09-28 更正下面这行语法说明（真机逐条实测，原文两条都不对）：
 *   原文写「无 ===/模板字符串」—— **实测两者都可用**：
 *     `1 === 1` → ok；`'1' === 1` → DIFF（是**严格**比较，没被当成 ==）；
 *     `1 !== 2` → ok；模板字符串 `x${a}y` 形式 → `x1y`。
 *   所以本文件里那 5 处 `===`（ES9+ 路径白名单、vowifi_set 的参数判定）是正常工作的。
 *   ★ 真正要避开的是 **typeof**：`typeof "AT"` 直接**语法错误**
 *     （Syntax error: Unexpected token / Expecting ')'），必须用 `type()`。
 *     这条**原文没写**，而它才是本文件唯一栽过的坑 ——
 *     2026-09-25 部署后 at_batch 的 20 条命令全部被拒就是这么来的（见那里的注释）。
 *
 * 属实的一条：无 `require('json')`（Runtime error: No module named 'json' 可复现），
 * 故序列化用 sprintf('%J')、反序列化用下面的内置迷你解析器。
 * 参数在 req.args 上（不是 req 顶层）。
 */

const fs = require('fs');
const uci = require('uci');

/*
 * 后端每个请求都会校验 UCI 里的 websocket_auth_key（见 src/rust/src/rpcserver.rs
 * 的认证分支），不一致时逐请求回这个错误码 —— **没有任何前置握手**。
 * 所以「认证失败」的表现是页面几十处同时报同一句话，而原因只有一个地方。
 */
const RPC_ERR_AUTH_FAILED = -32001;

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
	/* 失败标志放在**闭包内**而不是模块级：rpcd 每个请求独立线程，模块级变量
	 * 会被并发请求互踩（红线 24）；解析器同步跑完，同一次调用的嵌套函数共享
	 * 这个标志即可。
	 * ★★ 为什么不用 throw（B08 第一版的教训，2026-10-22 真机实测）：
	 *   本固件的 ucode **不支持 throw 语句** —— `try { throw "x"; }` 直接
	 *   Syntax error，整个文件编译失败 → rpcd 不注册 mt5700 对象 → 所有页面
	 *   -32000 Object not found。本仓既有代码里只有 try/catch，从无 throw，
	 *   当时误把注释里「解析失败是抛异常」当成了证据。 */
	let fail = 0;
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
		/* 闭合引号前就到末尾 = 被 timeout 掐断的半截应答，按失败处理（B08） */
		fail = 1;
		return null;
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
			if (fail) { return null; }
			arr[length(arr)] = parseVal();
			if (fail) { return null; }
			ws();
			if (ch() == ',') { i++; ws(); continue; }
			if (ch() == ']') { i++; return arr; }
			break;
		}
		/* 没吃到闭合 ] 就退出 = 输入被截断或夹了非法字符（B08） */
		fail = 1;
		return null;
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
			if (fail) { return null; }
			ws();
			if (ch() == ':') { i++; }
			let v = parseVal();
			if (fail) { return null; }
			obj[k] = v;
			ws();
			if (ch() == ',') { i++; continue; }
			if (ch() == '}') { i++; return obj; }
			break;
		}
		/* 没吃到闭合 } 就退出 = 输入被截断或夹了非法字符（B08） */
		fail = 1;
		return null;
	}

	parseVal = function () {
		if (fail) { return null; }
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

	let v = parseVal();
	ws();
	/* 完整性校验（B08）：值之后必须恰好到末尾；fail=1 表示结构未闭合或非法。
	 * 解析失败返回 null —— 合法 JSON 的裸 null 只在 fail=0 时原样返回；
	 * 本仓全部调用点的合法值都是对象或数组，不存在裸 null，判 null 即失败。 */
	if (fail || i != n) {
		return null;
	}
	return v;
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

/*
 * 接口名白名单：只认 [A-Za-z0-9._-]，其余一律拒绝。
 *
 * device 可以直接从 RPC 参数传进来，而它会被拼进
 * `/sys/class/net/<dev>/statistics/rx_bytes`。rpcd 不做路径规范化，不过滤的话
 * 传一个带斜杠的名字就能把 ucode 的 fs.open 指到任意文件上 —— ucode 是以 root
 * 跑的，泄漏面取决于那个文件首行能不能被 int() 解析，但目录遍历本身就不该存在。
 *
 * 真实接口名全都落在这个集合里（eth2 / wwan0 / eth2.100），限制不会误伤。
 * 另外挡掉 "." / ".." 这类纯点名，避免拼出 /sys/class/net/.. 这种路径。
 */
function safeNetDevice(dev) {
	if (dev == null || dev == '') {
		return null;
	}
	if (length(dev) > 32) {
		return null;
	}
	let alnum = false;
	for (let i = 0; i < length(dev); i++) {
		let c = substr(dev, i, 1);
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			alnum = true;
		} else if (c != '.' && c != '_' && c != '-') {
			return null;
		}
	}
	if (!alnum) {
		return null;
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
	/* read 理论上可抛（ rpcd 进程内 fd 会累积），兜住并保证关闭 */
	let s;
	try {
		s = f.read('line');
	} catch (e) {
		f.close();
		return null;
	}
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
	dev = safeNetDevice(dev);
	if (dev == null) {
		return { success: false, error: '接口名不合法' };
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
		/* 单侧读不到时回 null 而不是补 0：接口 up/down 翻转瞬间 statistics
		 * 文件可能短暂不可读，补 0 会让前端差分出假尖峰或假归零。
		 * 前端对 null 的处理是跳过本拍并重置基准（2026-10-22 审计 B07）。 */
		rx_bytes: rx,
		tx_bytes: tx
	};
}

/*
 * 每次调用生成独立的临时文件名。
 *
 * 原来固定叫 /tmp/mt5700-rpc.json。LuCI 上多张卡片并行刷新是常态（状态页、邻区、
 * 载波各刷各的），两个请求会在极短的时间窗里先后写同一个文件：后写的那个会
 * 在前一个的 nc 读到之前把内容覆盖掉，于是前一个请求**实际发出去的是别人的
 * 命令**，拿回来的也是别人的应答 —— 表现为卡片偶尔显示别处的数据，且毫无报错。
 *
 * 另外这个文件里带着 auth_key（见下），固定路径等于把密钥长期明文摊在 /tmp。
 * 所以这里两件事一起做：文件名加随机后缀，且用完立刻删除。
 *
 * 后缀生成放在 try 里：万一某个固件的 ucode 没有 rand()，退回原来的固定名，
 * 行为与改动前一致，不会因为这个改动让整个 RPC 挂掉。
 */
function rpcTmpPath() {
	let suffix = '';
	try {
		suffix = '.' + sprintf('%d', time()) + '.' + sprintf('%d', rand());
	} catch (e) {
		suffix = '';
	}
	return '/tmp/mt5700-rpc' + suffix + '.json';
}

/* 所有退出路径都要删，早退分支也不能落下 */
function rpcTmpUnlink(path) {
	try { fs.unlink(path); } catch (e) { }
}

/*
 * 限时器路径 —— 有 timeout 就用它，没有就退回随包的 /usr/share/mt5700/to。
 *
 * ★ 为什么必须探测（2026-10-24 真机：Mwrt @Manper r33382 / busybox 1.36.1）：
 *   该固件的 busybox **没有编译 timeout applet**，/usr/bin/timeout 与
 *   /bin/timeout 都不存在。而本文件 6 处 shell 调用都写成「timeout <秒> <命令>」，
 *   缺它时命令根本不会执行，popen 只读到空 —— 表现为**所有 AT 命令瞬间失败**
 *   并报「Rust 后端无应答（已限时 45 秒）」（实测 20/20，每次 0ms 返回），
 *   而真正的病因一个字都不提。界面侧看到的就是 SIM「未知」、状态页全空、
 *   诊断 / 出口 IP / DoH / VoWiFi epdg / OTA 全哑。
 *   OpenWrt 上游默认带该 applet，所以这个坑只在定制固件上出现，极易误判成
 *   「串口坏了」或「模组挂了」—— 实际 Rust 侧一切正常（nc 直连可拿到 +CPIN: READY）。
 *
 * 探测结果缓存在模块级变量：它描述「这台设备有没有某个程序」，是设备常量，
 * 不是跨会话传值，不存在红线 24 的串号问题。
 * ★ 定义必须放在 rpcCall 之前 —— ucode 没有函数提升（红线 14b）。
 */
let TIMEOUT_BIN = null;

function timeoutBin() {
	if (TIMEOUT_BIN != null) {
		return TIMEOUT_BIN;
	}
	/* 先默认随包脚本：即使探测本身抛异常，RPC 也不会因此不可用 */
	TIMEOUT_BIN = '/usr/share/mt5700/to';
	try {
		let p = fs.popen('command -v timeout 2>/dev/null', 'r');
		if (p) {
			let line = p.read('line');
			p.close();
			if (line != null) {
				line = trim('' + line);
				if (line != '') {
					TIMEOUT_BIN = line;
				}
			}
		}
	} catch (e) {
	}
	return TIMEOUT_BIN;
}

function rpcCall(method, params) {
	const rpcCfg = readRpcConfig();
	const port = rpcCfg.port;
	const authKey = rpcCfg.authKey;

	const payload = { id: 1, method: method, params: params };
	if (authKey != '') {
		payload.params.auth_key = authKey;
	}

	/* 本固件 ucode fs 无 connect，经 busybox nc 管道访问回环 RPC */
	const body = sprintf('%J', payload);
	const tmp = rpcTmpPath();
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
	/* 文件内容含 auth_key（payload 里带）：收掉组/其他位，把「本地低权用户
	 * 可读」的窗口压到 open→chmod 之间的一两毫秒（B10，2026-10-22 审计）。
	 * nc 由 rpcd 以 root 拉起，收权不影响它读。chmod 包 try：个别固件
	 * fs 无此函数时不影响主流程。 */
	try { fs.chmod(tmp, 384); } catch (e) { }

	let p;

	/*
	 * 必须用 timeout 包住 nc。
	 *
	 * nc 连上后端、但后端迟迟不回包时会一直阻塞在读上（连接已被接受，对端既不
	 * 关闭也不发数据）。rpcd 每来一次 mt5700.* 调用就占一个 ucode 工作线程，
	 * 事件轮询每 1.5s 一发，几轮下来线程全被占住 —— 表现为「整个插件的页面
	 * 一起卡死、点什么都没反应」，而且没有任何报错可查。
	 *
	 * 注意：本固件的 busybox nc 是精简版，**不认 -w 选项**（传 -w 只会打印
	 * usage 并立刻退出，会让所有 RPC 全部失败），限时只能靠外部的 timeout。
	 * ★ 而 timeout 本身也不保证存在（有的定制固件没编译这个 applet），
	 *   所以这里统一走 timeoutBin()：有就用，没有就换随包等价脚本
	 *   （见 timeoutBin 的注释与 /usr/share/mt5700/to 的文件头）。
	 *
	 * 上限取 45 秒：后端最坏耗时是有上界的 ——
	 * 普通命令 QUEUE_WAIT(8s) + WRITE(3s) + COMMAND_TIMEOUT(2s) = 13s，
	 * 短信后台任务 QUEUE_WAIT(8s) + WRITE(3s) + SMS_SEND_TIMEOUT(6s) = 17s，
	 * APDU 透传（AT+CSIM / AT+CGLA，eSIM 读写卡）QUEUE_WAIT(8s) + WRITE(3s)
	 * + APDU_TIMEOUT(12s) = 23s。
	 * 45s 留了余量：只会兜住「真的不回包」，不会把正常的慢响应掐掉。
	 *
	 * ★ 为什么必须跟着 APDU 一起放宽（2026-09-20 真机：eSIM 下载到一半中断）：
	 *   卡侧处理一段 STORE DATA 可能要几秒，后端等得起而这里等不起的话，
	 *   一次正常的慢应答会被本层掐成「Rust 后端无应答」，病因完全对不上。
	 */
	try {
		p = fs.popen(timeoutBin() + ' 45 nc 127.0.0.1 ' + port + ' < ' + tmp, 'r');
	} catch (e) {
		rpcTmpUnlink(tmp);
		return { success: false, error: '无法连接 Rust 后端' };
	}
	if (!p) {
		rpcTmpUnlink(tmp);
		return { success: false, error: '无法连接 Rust 后端' };
	}

	let line = p.read('line');
	p.close();

	/*
	 * 立刻删掉：文件内容里含 auth_key（回环 RPC 的密钥），请求结束就不该再留在
	 * /tmp 里。文件存在的窗口只有 nc 那几十毫秒，但以前用固定文件名时会长期留着。
	 */
	rpcTmpUnlink(tmp);

	if (!line) {
		return { success: false, error: 'Rust 后端无应答（已限时 45 秒）' };
	}

	try {
		let resp = jsonParse(line);
		if (resp == null) {
			return { success: false, error: '解析后端应答失败（数据可能被截断）' };
		}
		if (resp.error) {
			let msg = 'RPC 错误';
			if (resp.error.message) {
				msg = resp.error.message;
			}
			/*
			 * ★ 认证失败必须带上处置指引。
			 *   后端只回四个字「认证失败」，而它其实是「UCI 里的 websocket_auth_key
			 *   与后端不一致」这一个原因 —— 页面里有几十个读数入口会同时报同一句
			 *   话，却没有一处说清该去哪改。翻译成本地可行动的文案后就一次到位。
			 *
			 * ★ 这是原来每个页面各写一遍的「弹输入框补密钥」唯一真正抵达用户的
			 *   对应物：那条路依赖 connect() 抛 REQUIRE_AUTH_KEY，而 RPC 模式下
			 *   它永远不 reject（rpc.js 的 ATClient.connect），等于没有。
			 *   （前缀保持「认证失败」，避免下游按原文匹配的逻辑失效。）
			 */
			if (resp.error.code == RPC_ERR_AUTH_FAILED) {
				msg = '认证失败：UCI 的 websocket_auth_key 与后端不一致，请到「服务配置」核对';
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

/*
 * ============================================================================
 * 只读缓存（保守版）
 * ----------------------------------------------------------------------------
 * 【为什么保守】FAN789/luci-app-mt5700m 的读缓存是为「每次读都起进程、开一次串口」
 * 的慢实现打的补丁（TTL 5s + 陈旧数据先返回 + 后台刷新）。我们的 AT 通道是
 * **Rust 常驻服务**：串口常开、有命令队列与并发处理，重复查询的代价远小于他们，
 * 所以不值得为省几次查询去牺牲数据新鲜度。
 *
 * 由此的取舍：
 *   · **只缓存「不变类」**（型号/固件/IMEI/ICCID/SMSC/接入模式）——这些值本来就不变，
 *     缓存零陈旧风险，收益是页面多次加载不再重复问模组；
 *   · **状态类（信号/载波/注册/温度）默认不缓存**（read_cache_ttl 默认 0），
 *     我们的后端完全扛得住实时轮询，宁可每拍都拿新的；
 *   · 任何**写命令**经过代理都清空缓存，保证「保存后读回」一定拿到新值；
 *   · Rust 后端自己维护状态的命令（扫频作业 AT^CELLSCAN、短信作业 AT^SMSJOB、
 *     FOTA 流程）**永不缓存** —— 见 NEVER_CACHE，缓存它们会返回过期的后端状态。
 *
 * UCI：read_cache_static_ttl（**默认 300**，0=关闭全部缓存）、read_cache_ttl（默认 0）。
 * ============================================================================
 */

const READ_CACHE_DIR = '/tmp/mt5700-read-cache';

/*
 * 不变类：写一次终身不变（或极少变），可安全长 TTL。
 *
 * 入选标准只有一条：**没有任何途径能让它变**。可选的项一律不进 ——
 * 早先把 `AT+CSCA?`（短信中心号）和 `AT^C5GOPTION?` 也列了进来，而这两项在
 * 短信页 / 网络设置页都能改。虽然写命令会清空全部缓存兜住了大部分情况，
 * 但缓存的语义是「这项不会变」，可写的项放进来等于给自己埋雷
 * （比如从别的途径改了短信中心号，界面最多陈旧 5 分钟）。
 */
/*
 * ★ P03（2026-09-19 会审）：'AT^ICCID?' 已移出本档。
 * 入选标准只有一条 ——「没有任何界面能改它」。ICCID 在换卡 / eSIM 切换 profile 之后
 * 会变，属于可被改的标识，放进来等于给自己埋雷（换完 profile 最长陈旧 5 分钟）。
 * 前端 esim.js 早已用 { fresh: true } 绕开前端缓存，但绕不过 ucode 侧这 300 秒。
 *
 * ★ B10（2026-10-22 全仓审计）：'AT+CIMI' 同判据移出。IMSI 与 ICCID 一样随卡变，
 * 留在静态档等于换卡后 5 分钟内其它入口还在读旧卡的 IMSI —— 正是 P03 要防的事。
 * 'AT+CGSN'（IMEI）是设备级标识、不随卡变，保留。
 */
const STATIC_READS = [
	'ATI', 'AT+CGMM', 'AT+CGMR', 'AT+CGSN', 'AT+CGMI',
	'AT^PHYNUM?', 'AT^VERSION?'
];

/* 无问号但属只读的查询（默认不启用缓存，留给 read_cache_ttl>0 时用）
 *
 * ★ 2026-09-26：补上 AT+CGPADDR / AT+CNUM / AT+CGEQOSRDP 三条。
 *   它们在前端 `NON_QUESTION_READS` 里已经按只读处理，这里不跟上的话，
 *   两侧对「什么算只读」的判断就不一致 —— 前端会把它们塞进 at_batch，
 *   后端按旧名单一律拒（表现为白跑一趟 + refused 计数虚高）。
 *   手册依据：CGPADDR 7.8 查询 PDP 地址｜CNUM 5.26 查询本机号码｜
 *   CGEQOSRDP 13.30 读取 EPS QoS 参数（三条语法都带可选参数，不带参即查询）。
 *   ★ 它们**不进 STATIC_READS**：PDP 地址/QoS 会随网络重配变化，不是「永不变」的标识。
 *
 * ★ B11（2026-10-22 全仓审计）：补上 AT+CSQ。前端 warmCache 名单里有它，
 *   这里不收的话每轮预热该条必被拒（refused 虚高、CSQ 永远预热不中）。
 *   手册依据：CSQ 6.2 查询信号强度，无参形式即查询。
 *
 * ★ B04（2026-10-22 全仓审计）：补上 AT^MCS / AT^EONS / AT^DSAMBR 三条「写形式的
 *   查询」（13.22 上下行 MCS｜13.3 运营商名称/EFSPN｜16.17 签约速率）——
 *   它们带参数但**无副作用**，前端 NON_QUESTION_READS 已收录；这里不收的话
 *   预热批次会被「不是只读查询」逐条拒掉（与 CSQ 同款症状）。 */
const BARE_READS = [
	'AT^DSFLOWQRY', 'AT^MONNC', 'AT^MONSC', 'AT^MONSSC',
	'AT+CGPADDR', 'AT+CNUM', 'AT+CGEQOSRDP', 'AT+CSQ',
	'AT^MCS', 'AT^EONS', 'AT^DSAMBR'
];

/* 后端自己维护状态：**永不缓存** */
/*
 * ★ P08（2026-09-19 会审）：第二项原写 'AT^SMSJOB'（脱字符），而真实命令是
 * 'AT+SMSJOB?'（加号 + 问号，见 rpcserver.rs:49 与 sms_center.js:476）。
 * cacheClass 用 index(cmd, ...) == 0 做前缀匹配，差一个字符就永不命中 ——
 * 一旦用户把 read_cache_ttl 调成非 0，短信作业状态就会被缓存住，与这里
 * 「后端自己维护状态的命令永不缓存」的约定完全相反。
 */
const NEVER_CACHE = ['AT^CELLSCAN', 'AT+SMSJOB', 'AT^FOTA', 'AT^FWUP', 'AT+CMG'];

function trimCmd(s) {
	let a = 0;
	let b = length(s);
	while (a < b) {
		let c = substr(s, a, 1);
		if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { a++; } else { break; }
	}
	while (b > a) {
		let c = substr(s, b - 1, 1);
		if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { b--; } else { break; }
	}
	return substr(s, a, b - a);
}

function cacheName(cmd) {
	let out = '';
	for (let i = 0; i < length(cmd); i++) {
		let c = substr(cmd, i, 1);
		if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) { out += c; }
		else { out += '_'; }
	}
	return substr(out, 0, 80) + '.' + length(cmd) + '.json';
}

/* 0=不缓存  1=状态类（默认关）  2=不变类 */
function cacheClass(cmd) {
	for (let i = 0; i < length(NEVER_CACHE); i++) {
		if (index(cmd, NEVER_CACHE[i]) == 0) { return 0; }
	}
	for (let i = 0; i < length(STATIC_READS); i++) {
		if (STATIC_READS[i] == cmd) { return 2; }
	}
	for (let i = 0; i < length(BARE_READS); i++) {
		if (BARE_READS[i] == cmd) { return 1; }
	}
	if (substr(cmd, length(cmd) - 1, 1) == '?' && index(cmd, '=') < 0) { return 1; }
	return 0;
}

function readCacheCfg() {
	let statik = 300;
	let volatileTtl = 0;
	try {
		const cursor = uci.cursor();
		let sv = cursor.get('at-webserver', 'config', 'read_cache_static_ttl');
		if (sv != null && sv != '') { statik = int(sv); }
		let v = cursor.get('at-webserver', 'config', 'read_cache_ttl');
		if (v != null && v != '') { volatileTtl = int(v); }
	} catch (e) { }
	if (statik == null || statik < 0) { statik = 300; }
	if (volatileTtl == null || volatileTtl < 0) { volatileTtl = 0; }
	return { statik: statik, volatile: volatileTtl };
}

function cacheGet(cmd, cls, cfg) {
	let ttl = (cls == 2) ? cfg.statik : cfg.volatile;
	if (ttl <= 0) { return null; }
	let file = READ_CACHE_DIR + '/' + cacheName(cmd);
	let raw = null;
	try { raw = fs.readfile(file); } catch (e) { return null; }
	if (raw == null || raw == '') { return null; }
	let entry = null;
	try { entry = jsonParse(raw); } catch (e) { return null; }
	if (entry == null || entry.t == null || entry.r == null) { return null; }
	let age = time() - entry.t;
	if (age < 0) { age = 0; }
	if (age > ttl) { return null; }
	return entry.r;
}

function cachePut(cmd, resp) {
	let file = READ_CACHE_DIR + '/' + cacheName(cmd);
	let tmp = file + '.tmp';
	try { fs.mkdir(READ_CACHE_DIR); } catch (e) { }
	try {
		fs.writefile(tmp, sprintf('%J', { t: time(), r: resp }));
		fs.rename(tmp, file);
	} catch (e) { }
}

function cacheClear() {
	let files = null;
	try { files = fs.lsdir(READ_CACHE_DIR); } catch (e) { return; }
	if (files == null) { return; }
	for (let i = 0; i < length(files); i++) {
		try { fs.unlink(READ_CACHE_DIR + '/' + files[i]); } catch (e) { }
	}
}

/* at 方法的唯一入口：读走缓存、写清缓存 */
function atCallCached(cmdRaw) {
	let cmd = trimCmd(cmdRaw);
	let cfg = readCacheCfg();
	let cls = cacheClass(cmd);
	if (cls > 0) {
		let hit = cacheGet(cmd, cls, cfg);
		if (hit != null) {
			hit.cached = true;
			return hit;
		}
		let resp = rpcCall('at', { cmd: cmd });
		if (resp != null && resp.success) { cachePut(cmd, resp); }
		return resp;
	}
	/*
	 * ★ P05（2026-09-19 会审）：这里原来是「cls == 0 就无条件 cacheClear()」。
	 * 但 cls == 0 里混着一堆**纯读**命令 —— AT+CSQ、AT+CNUM（network_status.js:236）、
	 * AT 这类既不带 '?' 也不在只读名单里的查询（cacheClass 只认「以 ? 结尾且不含 =」）。
	 * 后果：每查一次 AT+CNUM 就把 300 秒的 IMEI / 型号 / 固件缓存整目录删光，
	 * 本文件上面声称的「页面多次加载不再重复问模组」收益直接归零。
	 * 改为只在**确认是写命令**时清：含 '='，且不是 '=?' 测试命令（测试命令是只读的）。
	 * 判不准则宁可不清 —— 缓存最坏是陈旧（有 TTL 兜底），误清是白白多打串口。
	 */
	let eqIdx = index(cmd, '=');
	if (eqIdx >= 0 && substr(cmd, eqIdx + 1, 1) != '?') {
		/* 写命令：清掉读缓存，避免"保存后读回旧值" */
		cacheClear();
	}
	return rpcCall('at', { cmd: cmd });
}

/* 一次 at_batch 最多几条：既要能装下「网络状态页慢档那一轮」，
   又不能让人用一条请求把串口占上几十秒。 */
const AT_BATCH_MAX = 40;

/*
 * 「通道忙」文案前缀。
 * ============================================================================
 * 生产方在 Rust 侧：
 *   · `等待空闲通道超时（8s）…`            atclient.rs（QUEUE_WAIT_TIMEOUT 的报错）
 *   · `模组正在发送短信，请稍候再试`          rpcserver.rs
 *   · `正在扫频，模组暂时无法响应其它命令…`    rpcserver.rs
 * 前端 rpc.js 的 BUSY_PATTERNS 是同一份语义（它据此做快速失败 + 熔断）。
 * ★★ 这三处必须同步；tests/busy-fastfail-contract.test.js 会拦不同步。
 *
 * 为什么 at_batch 里必须认识它（2026-09-26 全局反省的产物）：
 *   batch 是**逐条**调 atCallCached，而一条命令撞上忙态要等满 QUEUE_WAIT_TIMEOUT(8s)
 *   才回错。原本 N 条就是 **N×8 秒全在一次 ucode 调用里跑完**，而 rpcd 是**单线程**、
 *   ucode 插件跑在它进程内 —— 这段时间整个 LuCI（含**新加载的页面**）全部冻结。
 *   实测对照：单次阻塞就能把轻量 ubus 调用从 32ms 放大到 3606ms（111×）。
 *   → 所以撞到忙就立即收尾，剩余条按同一原因标记 skipped，最坏从 N×8s 降到 ~8s。
 */
const BUSY_PREFIXES = [
	'等待空闲通道超时',
	'模组正在发送短信',
	'正在扫频，模组暂时无法响应其它命令'
];

function isBusyText(msg) {
	if (msg == null) { return false; }
	let s = '' + msg;
	for (let i = 0; i < length(BUSY_PREFIXES); i++) {
		if (index(s, BUSY_PREFIXES[i]) >= 0) { return true; }
	}
	return false;
}

/* 单条命令长度上限：与 at 方法同一口径（见 at args 的注释） */
const AT_BATCH_CMD_MAX = 4096;

/*
 * 「是不是只读查询」的服务端判据。
 *
 * 为什么这里是白名单而不是黑名单：
 * at_batch 一次请求就能下发几十条命令，一旦放进一条写命令（哪怕是
 * AT^RESET / AT+CFUN=0），代价就不是「多打一次串口」而是整个设备失控。
 * 所以这里只允许**明确认识形态**的查询——以 ? 结尾且不含 =、
 * 或在不带问号的只读名单里——认不出的形态一律拒绝。
 */
function batchReadable(cmd) {
	if (cmd == 'AT' || cmd == 'ATI') { return true; }
	if (substr(cmd, length(cmd) - 1, 1) == '?' && index(cmd, '=') < 0) { return true; }
	let i;
	for (i = 0; i < length(STATIC_READS); i++) {
		if (STATIC_READS[i] == cmd) { return true; }
	}
	for (i = 0; i < length(BARE_READS); i++) {
		if (BARE_READS[i] == cmd) { return true; }
	}
	return false;
}


/*
 * ================= ES9+ 转发（eSIM profile 下载） =================
 *
 * 为什么需要它：
 *   下载 eSIM profile 的 HTTPS 那一半（ES9+，GSMA SGP.22）必须能直连运营商的
 *   SM-DP+ 服务器。浏览器做不到 —— SM-DP+ 不发 CORS 头，跨域请求直接被拦。
 *   所以由路由器代发一次 POST，APDU 那一半仍在浏览器侧经 AT+CSIM 完成。
 *
 * ★ 安全边界（这本质上是一个「受限的外网 HTTP 客户端」，必须收紧）：
 *   ① 只认 https，URL 由本文件拼装，scheme 不可被参数影响；
 *   ② 主机必须是**合法 FQDN** —— 拒绝 IP 字面量 / localhost / 含端口或斜杠，
 *      否则这条通道就成了登录用户打内网的跳板（SSRF）；
 *   ③ 路径必须在 ES9+ 的 5 个端点白名单里，不接受任意路径；
 *   ④ 请求体必须是合法 JSON 且 ≤256KB；
 *   ⑤ 证书验证**保持开启**（不加 -k）。信任库＝系统 CA + 插件自带的
 *      GSMA CI（见下面 es9pCaBundle）；验不过就明确报失败，由界面原样
 *      呈现，而不是偷偷降低安全级别。
 */
const ES9P_PATHS = {
	initiateAuthentication: '/gsma/rsp2/es9plus/initiateAuthentication',
	authenticateClient: '/gsma/rsp2/es9plus/authenticateClient',
	getBoundProfilePackage: '/gsma/rsp2/es9plus/getBoundProfilePackage',
	handleNotification: '/gsma/rsp2/es9plus/handleNotification',
	cancelSession: '/gsma/rsp2/es9plus/cancelSession'
};

function es9pPathAllowed(path) {
	for (let k in ES9P_PATHS) {
		if (ES9P_PATHS[k] === path) {
			return true;
		}
	}
	return false;
}

/* 主机名白名单校验：只放行 [A-Za-z0-9.-] 的合法 FQDN */
function safeHost(h) {
	if (h == null || h == '') {
		return null;
	}
	let n = length(h);
	if (n < 4 || n > 253) {
		return null;
	}
	let dots = 0;
	let letters = 0;
	for (let i = 0; i < n; i++) {
		let c = substr(h, i, 1);
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			letters++;
		} else if ((c >= '0' && c <= '9') || c == '-') {
			/* 允许 */
		} else if (c == '.') {
			dots++;
		} else {
			return null;
		}
	}
	if (dots < 1 || letters < 1) {
		return null;   /* 无点 = 不是域名（也挡住 localhost/纯 IP） */
	}
	let first = substr(h, 0, 1);
	let last = substr(h, n - 1, 1);
	if (first == '.' || first == '-' || last == '.' || last == '-') {
		return null;
	}
	if (index(h, '..') >= 0) {
		return null;
	}
	return h;
}

/*
 * 临时文件必须用 mktemp 建，不能自己拼名字。
 *
 * /tmp 是 1777（任何本地用户都可写）。早先这里拼的是
 *   /tmp/mt5700-es9p-<tag>-<time()>.tmp
 * 时间戳是**秒级**的，本地用户可以提前算出下一次的文件名，在那里放一个符号链接
 * 指向 /etc/passwd 之类 —— 于是 fs.open(..., 'w') 与 curl -o 都会顺着链接写过去，
 * 等于以 root 身份覆盖任意文件（本地提权）。
 *
 * mktemp 用 O_EXCL 创建、权限 0600、文件名含随机数不可预测，且失败会明确报错。
 * 创建不成功就整个调用失败，绝不能退回可预测路径。
 */
/*
 * ================= 断网排查：系统侧只读采集 =================
 *
 * 分工（与前端的分界必须清楚，否则两边都会长成怪物）：
 *   本方法   —— 只**采集事实**（接口 up? 路由走哪个口? ARP 什么状态? USB 几速?），
 *                不做任何"通过/不通过"的判定；
 *   前端     —— 拿 facts 逐项判定、给文案与建议。
 * 这样"加一条判据"只改前端，"加一项事实"才动这里，两边都能独立扩展。
 *
 * ★ 为什么走外部脚本而不是在这里拼一长串 shell：
 *   ① 脚本可以手工跑（sh /usr/share/mt5700/diag-probe.sh）直接核对结果，
 *      排障时不用绕 rpcd；
 *   ② 脚本里加一项采集只加几行，ucode 不动。
 *
 * ★ 安全：命令与参数全部写死，不接受 req.args 的任何输入（脚本本身也忽略参数），
 *   因此没有命令注入面。
 */
const DIAG_PROBE = '/usr/share/mt5700/diag-probe.sh';

/* 上限 25 秒：脚本内三个 ICMP(2s×3) + DNS(5s) + TCP(4s) 最坏约 15s，留足余量。
   必须限时 —— rpcd 每个调用占一个 ucode 工作线程，脚本卡住会让整个插件无响应。 */
const DIAG_TIMEOUT = 25;
/* 事实条数上限，防止脚本异常输出把响应撑爆（同时也兜住下面的读循环） */
const DIAG_MAX_LINES = 200;

function diagFacts() {
	let f;
	try {
		f = fs.open(DIAG_PROBE, 'r');
	} catch (e) {
		return null;
	}
	if (!f) {
		return null;
	}
	f.close();

	let p;
	try {
		p = fs.popen(timeoutBin() + ' ' + DIAG_TIMEOUT + ' /bin/sh ' + DIAG_PROBE, 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}

	let facts = {};
	for (let i = 0; i < DIAG_MAX_LINES; i++) {
		let line = p.read('line');
		if (line == null) {
			break;
		}
		let s = trim(line);
		if (s == '') {
			continue;
		}
		let idx = index(s, '=');
		if (idx <= 0) {
			continue;
		}
		facts[substr(s, 0, idx)] = substr(s, idx + 1);
	}
	p.close();
	return facts;
}

/*
 * ================= 出口 IP 探测（「换卡换 IP」能不能成立的判定依据） =================
 *
 * 为什么非有它不可：AT+CGPADDR 给的是 **PDP 地址**（本模组是桥接模式，路由器 WAN
 * 侧拿到的就是它，见 network_status.js 关于 CGPADDR 与 ^DHCP 同源的说明）。但运营商
 * 普遍做 CGNAT，PDP 地址常常是 10.x / 100.x 这类私网地址 —— 此时「互联网看到的我」
 * 是 CGNAT 出口地址，**只看 PDP 地址根本判断不出换卡后公网出口到底变没变**。
 *
 * 对照 vohive 的做法（internal/netprobe/netprobe.go）：它也是从设备侧发一次 HTTP
 * 回显，用「对端看到的源地址」当公网 IP（`GetPublicIPv4AndV6NoCache`），并且区分
 * privateIP（承载地址）与 publicIP（回显地址）两个字段 —— 上面这段区别正是它分两
 * 个字段的原因。本项目此前完全没有这个手段，所以只能给出「观测」而不是「轮换」。
 *
 * 分工（与 sysdiag 保持一致）：这里只取回**原文**，不解析、不判定；解析与合法性校验
 * 交给前端 Parse.parseExitIpBody。加一个回显服务只改这里，加一条判据只改前端。
 *
 * ★ 安全：URL 写死在白名单常量里，不接受 req 传入任意地址 —— 没有命令注入面。
 *   唯一的用户输入是 bind（要绑定的源 IP），逐字符校验成 IPv4 点分十进制才拼进命令行。
 */
const EXITIP_MAX_BODY = 64;
const EXITIP_TIMEOUT = 12;

/* 全部走 http：设备上的 curl 未必带 CA 信任库，https 缺根时会静默失败
   （es9p 那边为了过 GSMA CI 得额外拼一份 CA，这里没必要引入那份复杂度）。
   传出去的只是「我的 IP 是多少」这种公开信息，不需要机密性。 */
const EXITIP_ENDPOINTS = [
	{ id: 'ipify', url: 'http://api.ipify.org' },
	{ id: 'ifconfig', url: 'http://ifconfig.me/ip' },
	{ id: 'ipip', url: 'http://myip.ipip.net' }
];

/* bind 校验：只放行 IPv4 点分十进制。返回 '' 表示不绑定，null 表示不合法。 */
function safeBindIp(s) {
	if (s == null || s == '') {
		return '';
	}
	if (length(s) > 15) {
		return null;
	}
	let dots = 0;
	let digits = 0;
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if (c >= '0' && c <= '9') {
			digits++;
		} else if (c == '.') {
			dots++;
		} else {
			return null;
		}
	}
	/* 3 个点 + 至少 4 位数字：挡掉 "...." / "1" / "999" 这类畸形输入 */
	if (dots != 3 || digits < 4) {
		return null;
	}
	return s;
}

function exitIpOnce(url, bind) {
	let cmd = timeoutBin() + ' ' + EXITIP_TIMEOUT + ' curl -sS --max-time 8';
	if (bind != null && bind != '') {
		cmd = cmd + ' --interface ' + bind;
	}
	cmd = cmd + ' ' + url;
	let p;
	try {
		p = fs.popen(cmd, 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}
	let body = '';
	for (let i = 0; i < 8; i++) {
		let line = p.read('line');
		if (line == null) {
			break;
		}
		body = body + line;
		if (length(body) > EXITIP_MAX_BODY) {
			break;
		}
	}
	p.close();
	if (body == '') {
		return null;
	}
	return substr(body, 0, EXITIP_MAX_BODY);
}

function es9pToolAvailable() {
	let p;
	try {
		p = fs.popen('command -v curl', 'r');
	} catch (e) {
		return false;
	}
	if (!p) {
		return false;
	}
	let s = p.read('line');
	p.close();
	return (s != null && length(trim(s)) > 0);
}

function exitIpFacts(bind) {
	if (!es9pToolAvailable()) {
		return { success: false, error: '设备上没有 curl，无法探测出口 IP' };
	}
	for (let i = 0; i < length(EXITIP_ENDPOINTS); i++) {
		let ep = EXITIP_ENDPOINTS[i];
		let body = exitIpOnce(ep.url, bind);
		if (body != null) {
			return { success: true, endpoint: ep.id, body: body };
		}
	}
	return { success: false, error: '三个回显服务都没返回内容（可能没网，或 DNS 未解析）' };
}

/*
 * ================= ePDG 探测（VoWiFi / Wi-Fi 通话的第一道门） =================
 *
 * VoWiFi 走的是「非 3GPP 接入 → ePDG → IMS」这条路，第一道门是：
 * **运营商在公网发布 ePDG 了吗**。直接查本运营商的 ePDG 域名，拿到 NXDOMAIN
 * 只能说明「这个域名查不到」，分不清三种完全不同的情况：
 *   ① 运营商压根没在公网发布 ePDG（国内三家实测就是这种）；
 *   ② 本机 / 链路的 DNS 坏了 —— 那 NXDOMAIN 是自己的问题，不是运营商的；
 *   ③ DNS 通配污染 —— 不存在的域名也返回一个假地址（实测 127.0.0.1），
 *      看着「解析到了」，其实那个地址根本不是 ePDG。
 * ★ 所以必须同时查两组对照（红线 49：判「不通」必须带对照组）：
 *     阳性对照 —— 境外已商用、长期稳定可解析的 ePDG（T-Mobile US）。
 *                 它都查不到 = 本机 DNS 有问题，此时**不许**下「运营商没发布」的结论；
 *     阴性对照 —— 必然不存在的 mnc999。它若跟本运营商域名返回同一个值，
 *                 就证明是通配污染，那个地址不是真 ePDG。
 *
 * ★ 安全：域名全部由后端从 AT+CIMI 读到的 IMSI 自己拼，DNS 服务器与对照域名都是
 *   写死常量，方法不接受任何入参（args 为空）→ 没有命令注入面。
 */
const EPDG_DNS = ['223.5.5.5', '114.114.114.114'];
/* 单个 nslookup 的限时：查不到时要能及时放弃（rpcd 一个调用占一个工作线程）。
   NXDOMAIN 是秒回的，跑满这个值只发生在 DNS 服务器整个不可达的时候。 */
const EPDG_TIMEOUT = 6;
const EPDG_PREFIX = 'epdg.epc.';
const EPDG_SUFFIX = '.pub.3gppnetwork.org';
/*
 * 阳性对照：AT&T US（MCC 310 / MNC 280），境外已商用 Wi-Fi Calling。
 * ★ 选它是因为**实测过**：它经 DoH 能解析出真实公网地址 107.122.31.31，
 *   不是靠"听说它开了 VoWiFi"。它解析不出来 = 这条 DNS 链路有问题，
 *   此时不许下「运营商没发布 ePDG」的结论（否则就是把环境的锅甩给运营商）。
 */
const EPDG_POS_FQDN = 'epdg.epc.mnc280.mcc310.pub.3gppnetwork.org';

/*
 * ---- 身份链：MNC 到底是 2 位还是 3 位，由卡自己说了算 ----
 * IMSI 里看不出 MNC 长度（460001234567890 既可读成 460/00 也可读成 460/000）。
 * 参考 VoCat 的 readExplicitMNCLength：读 EF_AD（0x6FAD）第 4 字节低 4 位。
 * 读不到就如实标注 "ambiguous"（两种写法都查，不挑一个当真）。
 * ★ 不猜：猜出来的 MNC 会拼出一个错的域名，而错的域名必然 NXDOMAIN，
 *   那会把"我拼错了"误报成"运营商没发布"。
 * ★ 本机实测（2026-09-24）：AT+CRSM=176,28589,0,0,4 -> +CRSM: 144,0,"00000002"
 *   -> 低 4 位 = 2 -> MNC = 00（2 位），canonical 补零成 000。
 *   （EF_EHPLMN 0x6F19 兜底分支保留：本机实测 success=false，走不到；换一张能读
 *     出来的卡时它才有意义。读不到一律按 ambiguous 处理，不猜。）
 */
const EF_AD_ID = 28589;       /* 0x6FAD */
const EF_EHPLMN_ID = 28441;   /* 0x6F19 */

/*
 * ---- DNS 的第二条路：DoH + EDNS Client Subnet ----
 * 参考 VoCat 的 resolveEPDG：系统 DNS 拿不到可用地址时，不直接判死，
 * 而是换一条解析链路（DoH）再问一次，并带上归属国的 EDNS Client Subnet ——
 * ePDG 的权威 DNS 常常只对归属国的解析器返回地址。
 * 端点选阿里是因为**实测可达**（cloudflare-dns / dns.google 在本网连不上）。
 */
const EPDG_DOH = 'https://dns.alidns.com/resolve';
const EPDG_ECS = '223.5.5.0/24';
const DOH_TIMEOUT = 8;

/* 3GPP TS 23.003 定义的 ePDG FQDN 格式 */
function epdgFqdn(mcc, mnc3) {
	return EPDG_PREFIX + 'mnc' + mnc3 + '.mcc' + mcc + EPDG_SUFFIX;
}

/* 只放行 epdg.epc.mncNNN.mccNNN.pub.3gppnetwork.org 这一种形状。
   IMSI 来自模组，不该有脏字符；但拼进 shell 命令行前一律再过一遍。 */
function safeEpdgFqdn(s) {
	if (s == null || length(s) < 32 || length(s) > 80) {
		return null;
	}
	if (substr(s, 0, length(EPDG_PREFIX)) != EPDG_PREFIX) {
		return null;
	}
	if (substr(s, length(s) - length(EPDG_SUFFIX)) != EPDG_SUFFIX) {
		return null;
	}
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.') {
			continue;
		}
		return null;
	}
	return s;
}

/* 从 AT 应答里抠出第一段够长的数字串（IMSI 是 15 位，模组应答里还夹着 OK） */
function extractImsi(s) {
	if (s == null) {
		return '';
	}
	let best = '';
	let cur = '';
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if (c >= '0' && c <= '9') {
			cur = cur + c;
			if (length(cur) > length(best)) {
				best = cur;
			}
		} else {
			cur = '';
		}
	}
	if (length(best) < 6 || length(best) > 15) {
		return '';
	}
	return best;
}

/* ---------- 身份链：从卡上读，不猜 ---------- */

const HEX_UP = '0123456789ABCDEF';
const HEX_LO = '0123456789abcdef';

/* 单个 hex 字符的数值，非 hex 返回 -1（只依赖 index()，不用 ord()） */
function hexDigit(c) {
	if (c == null || length(c) != 1) {
		return -1;
	}
	let k = index(HEX_UP, c);
	if (k >= 0) {
		return k;
	}
	return index(HEX_LO, c);
}

/* hex 串第 i 个「字符位置」起的两个字符组成的字节值 */
function hexPairVal(hex, i) {
	if (hex == null || i < 0 || i + 2 > length(hex)) {
		return -1;
	}
	let a = hexDigit(substr(hex, i, 1));
	let b = hexDigit(substr(hex, i + 1, 1));
	if (a < 0 || b < 0) {
		return -1;
	}
	return a * 16 + b;
}

/*
 * 从 AT+CRSM 的应答里取出 <response> 的 hex 串，并且**只在成功状态字下才认**。
 * 应答形如：+CRSM: 144,0,"00000002"   （144,0 就是 sw1=0x90 sw2=0x00 的十进制写法）
 * ★ 状态字不对时返回 null，绝不把错误应答里的数据当内容（红线 23：
 *   「读不出来」必须和「有，但是空的」分开）。
 */
function crsmHex(data) {
	if (data == null) {
		return null;
	}
	let k = index(data, '+CRSM:');
	if (k < 0) {
		return null;
	}
	let s = substr(data, k + length('+CRSM:'));
	let q1 = index(s, '"');
	if (q1 < 0) {
		return null;
	}
	let rest = substr(s, q1 + 1);
	let q2 = index(rest, '"');
	if (q2 < 0) {
		return null;
	}
	return substr(rest, 0, q2);
}

/* 状态字是不是 90 00（十进制 144,0）。CRSM 用十进制回 sw1,sw2。 */
function crsmOk(data) {
	if (data == null) {
		return false;
	}
	let k = index(data, '+CRSM:');
	if (k < 0) {
		return false;
	}
	let s = substr(data, k + length('+CRSM:'));
	let c = index(s, ',');
	if (c < 0) {
		return false;
	}
	let sw1 = trim(substr(s, 0, c));
	let s2 = substr(s, c + 1);
	let c2 = index(s2, ',');
	if (c2 < 0) {
		c2 = index(s2, '"');
	}
	if (c2 < 0) {
		c2 = length(s2);
	}
	let sw2 = trim(substr(s2, 0, c2));
	return (sw1 == '144' && sw2 == '0') || (sw1 == '0x90' && sw2 == '0x00');
}

/*
 * MNC 长度（2 或 3）—— EF_AD（0x6FAD）第 4 字节的低 4 位。
 * 参考 VoCat 的 readExplicitMNCLength，取不到就返回 null，由调用方决定兜底。
 */
function readMncLength() {
	let r = rpcCall('at', { cmd: 'AT+CRSM=176,' + EF_AD_ID + ',0,0,4', fresh: true });
	if (r == null || !r.success) {
		return null;
	}
	if (!crsmOk(r.data)) {
		return null;
	}
	let hex = crsmHex(r.data);
	if (hex == null || length(hex) < 8) {
		return null;
	}
	/*
	 * data[3] & 0x0f。
	 * ★ 2026-09-28 补实测依据：原文写「用取模，避免依赖位运算」，容易被读成
	 *   「位运算在这个固件上有坑」—— **实测没有**：`255 >> 4` = 15、`255 & 15` = 15、
	 *   `144 >> 4` = 9、`0 & 15` = 0，本文件的 decHex2 就一直在用位运算且工作正常。
	 *   这里与下面 readEhplmnMnc 用 % 16 只是更直观、与早期写法一致，**不是**被迫的。
	 */
	let n = hexPairVal(hex, 6) % 16;
	if (n == 2 || n == 3) {
		return n;
	}
	return null;
}

/*
 * 兜底：EF_EHPLMN（0x6F19）里第一个 PLMN 的 MNC 位数。
 * PLMN 是 3 字节 BCD：MNC 第三位为 F 表示 MNC 只有 2 位。
 */
function readEhplmnMnc() {
	let r = rpcCall('at', { cmd: 'AT+CRSM=176,' + EF_EHPLMN_ID + ',0,0,12', fresh: true });
	if (r == null || !r.success || !crsmOk(r.data)) {
		return '';
	}
	let hex = crsmHex(r.data);
	if (hex == null || length(hex) < 6) {
		return '';
	}
	/* 字节 0/1 拼 MCC 三位，字节 1 高半字节 + 字节 2 拼 MNC */
	let b0 = hexPairVal(hex, 0);
	let b1 = hexPairVal(hex, 2);
	let b2 = hexPairVal(hex, 4);
	if (b0 < 0 || b1 < 0 || b2 < 0) {
		return '';
	}
	let mcc = '' + (b0 % 16) + ((b0 / 16) % 16) + (b1 % 16);
	let mnc3 = (b1 / 16) % 16;
	let mnc = '' + (b2 % 16) + ((b2 / 16) % 16);
	if (mnc3 <= 9) {
		mnc = mnc + '' + mnc3;
	}
	if (length(mcc) != 3 || length(mnc) < 2 || length(mnc) > 3) {
		return '';
	}
	return mcc + ',' + mnc;
}

/*
 * UICC 上能做 AKA 的应用 AID。
 * ★ 取法是 AT+CRSM=242（STATUS）读当前目录的 FCI，再按 TLV 取 tag 84（AID），
 *   **不是**逐个 AID 去试 —— 盲扫未定义对象会把 AT 通道搞死（红线 27）。
 * 取到后还要过 USIM/ISIM 前缀校验（A0000000871002 / 04），防止命中的是别的数据。
 */
function uiccAkaAid() {
	let r = rpcCall('at', { cmd: 'AT+CRSM=242', fresh: true });
	if (r == null || !r.success || !crsmOk(r.data)) {
		return { aid: null, app: '', how: 'status-unavailable' };
	}
	let hex = crsmHex(r.data);
	if (hex == null) {
		return { aid: null, app: '', how: 'status-nodata' };
	}
	let n = length(hex);
	let i = 0;
	while (i + 4 <= n) {
		if (substr(hex, i, 2) == '84') {
			let lenByte = hexPairVal(hex, i + 2);
			if (lenByte >= 5 && lenByte <= 16 && i + 4 + lenByte * 2 <= n) {
				let aid = substr(hex, i + 4, lenByte * 2);
				if (substr(aid, 0, 12) == 'A00000008710') {
					let kind = substr(aid, 12, 2);
					if (kind == '02') {
						return { aid: aid, app: 'USIM', how: 'fci' };
					}
					if (kind == '04') {
						return { aid: aid, app: 'ISIM', how: 'fci' };
					}
				}
			}
		}
		i = i + 2;
	}
	return { aid: null, app: '', how: 'fci-no-usim-isim' };
}

/*
 * AKA 就绪证据 —— **只读，不开逻辑通道**。
 *
 * ★★ 真机事故（2026-09-24，本机）：用 AT+CCHO 开逻辑通道做「能不能鉴权」的验证，
 *   连开两次之后再 CCHO 一律 `+CME ERROR: missing resource`，而 **AT+CCHC 关不掉**
 *   （对已开的 session 一律回 `+CME ERROR: SIM failure`，其它 session id 同样无效）。
 *   也就是说：逻辑通道一旦占上就**无法回收**，只能重启模组才恢复。
 *
 *   参考实现（VoCat 的 CheckReady）确实会开一次通道，但它是**独占串口的单进程
 *   服务**，全生命周期只开一次；而这里是一个 LuCI 页面，用户可以反复点、页面可能被
 *   强杀 —— 每次点击都去占一份不可回收的卡资源，是红线 22 那类副作用常驻事故。
 *   ★ 结论：本设备不做开通道验证。
 *
 * ★ 替代证据（同样来自卡自己）：AT+CRSM=242 的 FCI 里 tag 84 报上来的 AID，
 *   过 USIM/ISIM 前缀校验。卡自己说「我有这个应用」——够用来判断「有没有 AKA 的料」，
 *   只是不能证明「此刻一定能做一次 AUTHENTICATE」。两者在返回里如实区分。
 */
function akaEvidence(aidInfo) {
	if (aidInfo == null || aidInfo.aid == null || aidInfo.aid == '') {
		return { ready: false, app: '', aid: null, how: (aidInfo == null ? 'no-aid' : aidInfo.how), verified: 'none' };
	}
	return {
		ready: true,
		app: aidInfo.app,
		aid: aidInfo.aid,
		how: aidInfo.how,
		/* fci = 卡上报的 AID（未开通道实测）；none = 连 AID 都没读到 */
		verified: 'fci'
	};
}

/*
 * ICCID（AT^ICCID?）。只认 18~20 位大写十六进制串 —— ICCID 末位可能是 F，
 * 所以**不能**用只收数字的 atFirstNumber。
 * 参考 VoCat：ICCID 用于和 IMSI 推出来的 HPLMN 交叉核对（换卡后对不上就是异常）。
 */
function readIccid() {
	let r = rpcCall('at', { cmd: 'AT^ICCID?', fresh: true });
	if (r == null || !r.success || r.data == null) {
		return '';
	}
	let k = index(r.data, '^ICCID:');
	if (k < 0) {
		return '';
	}
	let s = substr(r.data, k + length('^ICCID:'));
	let cur = '';
	let best = '';
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
			cur = cur + c;
			if (length(cur) > length(best)) {
				best = cur;
			}
		} else {
			cur = '';
		}
	}
	if (length(best) < 18 || length(best) > 20) {
		return '';
	}
	return best;
}

/* SMSC 与 IMS 状态（身份链的最后两项） */

/* 短信中心号码（SMS-over-IMS 提交时要用到）—— 只在引号里取值，取不到返回空串 */
function readSmsc() {
	let r = rpcCall('at', { cmd: 'AT+CSCA?', fresh: true });
	if (r == null || !r.success || r.data == null) {
		return '';
	}
	let k = index(r.data, '+CSCA:');
	if (k < 0) {
		return '';
	}
	let s = substr(r.data, k + length('+CSCA:'));
	let q1 = index(s, '"');
	if (q1 < 0) {
		return '';
	}
	let rest = substr(s, q1 + 1);
	let q2 = index(rest, '"');
	if (q2 < 0) {
		return '';
	}
	return substr(rest, 0, q2);
}

/*
 * IMS 注册状态（AT+CIREG? 的第二个值）。
 * ★ 只如实上报：n=1 时不带 ext_info，拿不到就不倒推（前端那边也是这个口径）。
 */
function ciregStat() {
	let r = rpcCall('at', { cmd: 'AT+CIREG?', fresh: true });
	if (r == null || !r.success || r.data == null) {
		return null;
	}
	let k = index(r.data, '+CIREG:');
	if (k < 0) {
		return null;
	}
	let s = substr(r.data, k + length('+CIREG:'));
	let c = index(s, ',');
	if (c < 0) {
		return null;
	}
	let t = trim(substr(s, c + 1));
	if (length(t) == 0) {
		return null;
	}
	return substr(t, 0, 1);
}

/* ---------- DNS 的第二条路：DoH（+ EDNS Client Subnet） ---------- */

function looksLikeIp(v) {
	if (v == null || length(v) == 0) {
		return false;
	}
	for (let i = 0; i < length(v); i++) {
		let c = substr(v, i, 1);
		if ((c >= '0' && c <= '9') || c == '.' || c == ':') {
			continue;
		}
		return false;
	}
	return true;
}

/*
 * DoH 应答里所有 "data":"..." 的值，只留长得像 IP 的（CNAME 之类的杂项丢掉）。
 * 不引 JSON 解析器 —— 这里只需要两个字段，字符串扫就够了，也少一个依赖。
 */
function dohAddrs(txt) {
	let addrs = [];
	if (txt == null) {
		return addrs;
	}
	let pat = '"data":"';
	let from = 0;
	for (let guard = 0; guard < 40; guard++) {
		let k = index(substr(txt, from), pat);
		if (k < 0) {
			break;
		}
		let start = from + k + length(pat);
		let rest = substr(txt, start);
		let q = index(rest, '"');
		if (q < 0) {
			break;
		}
		let v = substr(rest, 0, q);
		if (looksLikeIp(v) && length(v) > 3) {
			addrs[length(addrs)] = v;
		}
		from = start + q + 1;
	}
	return addrs;
}

/* DoH 应答里的数字字段（Status）。返回**字符串**，省掉一次类型转换。 */
function dohNumField(txt, key) {
	if (txt == null) {
		return null;
	}
	let pat = '"' + key + '":';
	let k = index(txt, pat);
	if (k < 0) {
		return null;
	}
	let i = k + length(pat);
	let d = '';
	while (i < length(txt)) {
		let c = substr(txt, i, 1);
		if (c == '-' || (c >= '0' && c <= '9')) {
			d = d + c;
			i = i + 1;
			continue;
		}
		break;
	}
	if (length(d) == 0) {
		return null;
	}
	return d;
}

/*
 * 一条 DoH 查询。fqdn 必须已经过 safeEpdgFqdn（否则不许拼进命令行）。
 * 返回 { addrs, nx, status }；**读不出来返回 null**（不是空结果）——
 * 这个区别决定了后面是「无法判定」还是「查不到」。
 */
function dohLookup(fqdn, ecs) {
	if (fqdn == null) {
		return null;
	}
	let url = EPDG_DOH + '?name=' + fqdn + '&type=A';
	if (ecs != null && ecs != '') {
		url = url + '&edns_client_subnet=' + ecs;
	}
	let p;
	try {
		p = fs.popen(timeoutBin() + ' ' + DOH_TIMEOUT + ' curl -s -m ' + DOH_TIMEOUT
			+ ' -H "accept: application/dns-json" "' + url + '" 2>&1', 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}
	let txt = '';
	for (let i = 0; i < 20; i++) {
		let line = p.read('line');
		if (line == null) {
			break;
		}
		txt = txt + line;
	}
	p.close();
	let status = dohNumField(txt, 'Status');
	if (status == null) {
		return null;
	}
	return { addrs: dohAddrs(txt), nx: (status == '3'), status: status };
}

/*
 * 从 nslookup 的输出行里挑出**真正的解析结果**。
 *
 * ★★ 真机踩到的坑（2026-09-24）：busybox nslookup 的输出是
 *      Server:		223.5.5.5
 *      Address:	223.5.5.5:53      ← ★ 带端口！
 *
 *      Name:		epdg.epc.mnc260.mcc310.pub.3gppnetwork.org
 *      Address 1:	198.51.100.9
 *   开头那两行是**输入**（DNS 服务器自己），不是结果。而且它是 "223.5.5.5:53"，
 *   跟传入的 dns 常量并不相等 —— 原来用「值 != dns」过滤**根本滤不掉它**。
 *   后果是灾难性的：任何一个域名（哪怕是必然不存在的 mnc999）都会「解析到地址」，
 *   总判定恒为 available，等于把最关键的结论反过来说。
 *
 * 正解：以 "Name:" 行为界，只收它**之后**的 Address 行。NXDOMAIN 的输出压根
 *   没有 Name: 段，自然一个地址都收不到 —— 与「查不到」自洽。
 *   （另留一道 `!= dns + ':53'` 的兜底，防止将来输出格式又变。）
 */
function nsPickAddrs(lines, dns) {
	let addrs = [];
	let seenName = false;
	for (let i = 0; i < length(lines); i++) {
		let line = lines[i];
		if (index(line, 'Name:') == 0) {
			seenName = true;
			continue;
		}
		if (!seenName) {
			continue;
		}
		if (index(line, 'Address') == 0) {
			let k = index(line, ':');
			if (k >= 0) {
				let v = trim(substr(line, k + 1));
				if (v != '' && v != dns && v != dns + ':53') {
					addrs[length(addrs)] = v;
				}
			}
		}
	}
	return addrs;
}

function nsLookup(fqdn, dns) {
	let p;
	try {
		p = fs.popen(timeoutBin() + ' ' + EPDG_TIMEOUT + ' nslookup ' + fqdn + ' ' + dns + ' 2>&1', 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}
	let lines = [];
	let nx = false;
	let cname = '';
	for (let i = 0; i < 40; i++) {
		let line = p.read('line');
		if (line == null) {
			break;
		}
		if (index(line, 'NXDOMAIN') >= 0) {
			nx = true;
		}
		if (index(line, 'canonical name') >= 0) {
			let k = index(line, '=');
			if (k >= 0) {
				cname = trim(substr(line, k + 1));
			}
		}
		lines[length(lines)] = line;
	}
	p.close();
	return { addrs: nsPickAddrs(lines, dns), nx: nx, cname: cname };
}

/* 环回地址＝通配污染的特征值（真 ePDG 不可能是 127.x / ::1） */
function isLoopbackAddr(v) {
	if (v == '::1') {
		return true;
	}
	return substr(v, 0, 4) == '127.';
}

/*
 * 单个域名的结论，四态 —— 「读不出来」单独一态，不许并进「没有」
 * （红线 23：无差别兜底会把「读不出来」伪装成「没有」）：
 *   available      解析到非环回地址
 *   polluted       只解析到环回地址 → 通配污染，不是真 ePDG
 *   not_published  NXDOMAIN
 *   unknown        没有确定结论（DNS 不通 / nslookup 不可用 / 超时）
 */
function epdgState(r) {
	if (r == null) {
		return 'unknown';
	}
	if (length(r.addrs) > 0) {
		let real = 0;
		for (let i = 0; i < length(r.addrs); i++) {
			if (!isLoopbackAddr(r.addrs[i])) {
				real++;
			}
		}
		if (real > 0) {
			return 'available';
		}
		return 'polluted';
	}
	if (r.nx) {
		return 'not_published';
	}
	return 'unknown';
}

/*
 * 单个域名走**系统 DNS** 的结论：逐个 DNS 试，拿到确定结论就停。
 *
 * ★ 这里只管系统 DNS 这一条路。换链路（DoH + ECS）那一层在 epdgProbe 里，
 *   而且它把两条路的结果**分开保存**（r 是系统 DNS、r.doh 是 DoH）——
 *   合在一个字段里就没法回答「两条路说的一样吗」了，而那个对比正是判污染的根据。
 *   （曾经两个函数各查一次 DoH，同一个域名被问两遍，耗时翻倍且结论互相覆盖。）
 */
function epdgResolve(fqdn) {
	let last = null;
	let lastDns = EPDG_DNS[length(EPDG_DNS) - 1];
	for (let i = 0; i < length(EPDG_DNS); i++) {
		last = nsLookup(fqdn, EPDG_DNS[i]);
		lastDns = EPDG_DNS[i];
		if (last == null) {
			last = { addrs: [], nx: false, cname: '' };
			continue;
		}
		let st = epdgState(last);
		if (st != 'unknown') {
			return {
				fqdn: fqdn, dns: EPDG_DNS[i], via: 'system',
				addrs: last.addrs, cname: last.cname, state: st
			};
		}
	}
	if (last == null) {
		last = { addrs: [], nx: false, cname: '' };
	}
	return {
		fqdn: fqdn, dns: lastDns, via: 'system',
		addrs: last.addrs, cname: last.cname, state: 'unknown'
	};
}

/*
 * 一个域名的最终结论：系统 DNS 先查，拿不到可用地址就**换一条链路**再问一次。
 *
 * ★ 参考 VoCat resolveEPDG 的两段式（系统 DNS -> DoH + ECS 地理回退）。
 *   真机实测（2026-09-24）：本机系统 DNS 对 *.3gppnetwork.org 有通配污染 ——
 *   必然不存在的 mnc999 也返回 127.0.0.1。于是「解析到了」可能是假的，
 *   「NXDOMAIN」也可能只是本地递归服务器的行为。只看一条路，结论可能正好说反。
 *
 * ★ 只有 DoH 给出**更确定**的结论时才覆盖系统 DNS 的结果（unknown 不覆盖）：
 *   换链路是为了纠偏，不是为了替换。
 * ★ 对照组也走同一个函数：对照与被测必须同链路才有可比性。
 */
function epdgProbe(fqdn) {
	let r = epdgResolve(fqdn);
	r.via = 'sys';
	r.doh = null;
	/*
	 * ★ 系统 DNS 的原结论要**单独留一份**：下面一旦被 DoH 覆盖，前端就只能看到
	 *   「最终结论」，看不到「两条路各说了什么」—— 而「系统 DNS 说污染、DoH 说
	 *   NXDOMAIN」这种不一致本身正是判污染的依据，丢掉等于把证据扔了。
	 */
	r.sysState = r.state;
	r.sysAddrs = r.addrs;
	if (r.state == 'available') {
		return r;
	}
	let d = dohLookup(fqdn, EPDG_ECS);
	if (d == null) {
		return r;
	}
	r.doh = { addrs: d.addrs, nx: d.nx, status: d.status, state: epdgState(d) };
	if (r.doh.state == 'unknown') {
		return r;
	}
	r.state = r.doh.state;
	r.addrs = d.addrs;
	r.via = 'doh';
	return r;
}
/*
 * 评估预算（B01，2026-10-22 全仓审计）：vowifi 链在最坏情况下（后端挂死、
 * DNS 悬置）能吃满 45s×N 条 rpcCall + 最多 4 次 DNS 探测 ≈ 15 分钟，而
 * rpcd 单线程 —— 期间整个 LuCI 一起冻结（红线 17 实测 32ms→3606ms 的放大版）。
 * 入口设一个**绝对截止时刻**，沿调用链传参（红线 24：不用模块级全局变量，
 * 并发会话会互踩）；每个耗时步骤前检查，超窗立即降级为「unknown / 读不到」
 * —— 那本来就是四态语义里的合法结论，不是错误数据。
 */
function dlExpired(dl) {
	return (dl != null && time() >= dl);
}

function epdgFacts(dl) {
	/* 预算已尽：连 IMSI 都不读，直接失败（调用方已有 success:false 分支） */
	if (dlExpired(dl)) {
		return { success: false, error: 'VoWiFi 评估预算已用尽' };
	}
	/*
	 * ★ 必须 fresh：AT+CIMI 曾在 STATIC_READS 里（缓存 300 秒）。换完卡立刻点探测会
	 *   拿到上一张卡的 IMSI，进而拼出上一张卡的 ePDG 域名 —— 与红线 24（旧卡身份
	 *   带给新卡）是同一类事故。（B10：CIMI 现已移出静态档，这里 fresh 保留双保险。)
	 */
	let resp = rpcCall('at', { cmd: 'AT+CIMI', fresh: true });
	if (resp == null || !resp.success) {
		return { success: false, error: '读不到 IMSI（AT+CIMI 失败），无法判断 ePDG' };
	}
	let imsi = extractImsi(resp.data);
	if (imsi == '') {
		return { success: false, error: 'AT+CIMI 的应答里没有 IMSI' };
	}
	/*
	 * ★ ICCID 也必须 fresh 且与 IMSI 同一次取：换卡后两者若来自不同时刻，
	 *   就会出现「新卡的 IMSI + 旧卡的 ICCID」——红线 24 的同款事故。
	 */
	let iccid = readIccid();
	let mcc = substr(imsi, 0, 3);

	/*
	 * MNC 长度：先问卡（EF_AD），再问 EHPLMN，都问不出来才两种都试。
	 * ★ 不猜 —— 猜错会拼出一个必然 NXDOMAIN 的域名，那等于把「我拼错了」
	 *   报成「运营商没发布」。
	 */
	let mncLen = readMncLength();
	let mncSource = '';
	let mnc = '';
	let eh = readEhplmnMnc();
	let ehMcc = '';
	let ehMnc = '';
	if (eh != '') {
		let c = index(eh, ',');
		if (c > 0) {
			ehMcc = substr(eh, 0, c);
			ehMnc = substr(eh, c + 1);
		}
	}
	if (mncLen != null) {
		mncSource = 'ef_ad';
		mnc = substr(imsi, 3, mncLen);
	} else if (ehMnc != '' && ehMcc == mcc) {
		mncSource = 'ehplmn';
		mncLen = length(ehMnc);
		mnc = ehMnc;
	} else {
		mncSource = 'ambiguous';
		mnc = substr(imsi, 3, 2);
	}

	/*
	 * 候选域名：3GPP 标准写法是 MNC 补零到三位（mnc000）；
	 * 若补出来的三位带前导零，有些运营商实际发布的是两位写法（mnc00）——
	 * 两种都查（参考 VoCat 的 alternate3GPPHostname）。
	 */
	let items = [];
	if (mncLen == null) {
		/* 长度没定下来：两种解读都构造 */
		let m2 = substr(imsi, 3, 2);
		let m3 = substr(imsi, 3, 3);
		let g2 = safeEpdgFqdn(epdgFqdn(mcc, '0' + m2));
		let g3 = safeEpdgFqdn(epdgFqdn(mcc, m3));
		if (g2 != null && !dlExpired(dl)) {
			let r = epdgProbe(g2);
			r.mnc = m2;
			r.label = 'MNC 按 2 位（mnc' + ('0' + m2) + '）';
			items[length(items)] = r;
		}
		if (g3 != null && g3 != g2 && !dlExpired(dl)) {
			let r = epdgProbe(g3);
			r.mnc = m3;
			r.label = 'MNC 按 3 位（mnc' + m3 + '）';
			items[length(items)] = r;
		}
	} else {
		let m3 = mnc;
		if (length(m3) == 2) {
			m3 = '0' + m3;
		}
		let fc = safeEpdgFqdn(epdgFqdn(mcc, m3));
		if (fc != null && !dlExpired(dl)) {
			let r = epdgProbe(fc);
			r.mnc = m3;
			r.label = '标准写法（mnc' + m3 + '）';
			r.canonical = true;
			items[length(items)] = r;
		}
		if (substr(m3, 0, 1) == '0' && !dlExpired(dl)) {
			let fa = safeEpdgFqdn(epdgFqdn(mcc, substr(m3, 1)));
			if (fa != null && fa != fc) {
				let r = epdgProbe(fa);
				r.mnc = substr(m3, 1);
				r.label = '两位变体（mnc' + substr(m3, 1) + '）';
				items[length(items)] = r;
			}
		}
	}

	/* AKA 就绪：AID 从 FCI 里解，不挨个试；**不开逻辑通道**（见 akaEvidence 注释） */
	let aidInfo = uiccAkaAid();
	let aka = akaEvidence(aidInfo);
	let smsc = readSmsc();
	let imsStat = ciregStat();

	/* 预算用尽时不发探测，置 unknown 哨兵 —— verdict 判定会解引用 posCtl.state */
	let posCtl = { state: 'unknown' };
	if (!dlExpired(dl)) {
		posCtl = epdgProbe(safeEpdgFqdn(EPDG_POS_FQDN));
	}
	let negFqdn = safeEpdgFqdn(epdgFqdn(mcc, '999'));
	let negCtl = null;
	if (negFqdn != null) {
		negCtl = epdgProbe(negFqdn);
	}

	let verdict = 'unknown';
	let hit = false;
	for (let i = 0; i < length(items); i++) {
		if (items[i].state == 'available') {
			hit = true;
		}
	}
	if (hit) {
		verdict = 'available';
	} else if (posCtl.state != 'available') {
		/* 阳性对照都查不到：说明本机 DNS 这条链路有问题，不是运营商没发布。
		   此时必须退回「无法判定」，不许把锅甩给运营商。 */
		verdict = 'unknown';
	} else {
		let allGone = true;
		let allPolluted = true;
		for (let i = 0; i < length(items); i++) {
			if (items[i].state != 'not_published') {
				allGone = false;
			}
			if (items[i].state != 'polluted') {
				allPolluted = false;
			}
		}
		/*
		 * ★ canonical（由 EF_AD 定长推出来的标准写法）是**唯一可信的那一个**，
		 *   它的结论优先。真机（2026-09-24 本机）：mnc000 明确 NXDOMAIN，
		 *   而两位变体 mnc00 返回 127.0.0.1 —— 那个值跟「必然不存在的 mnc999」
		 *   一模一样，是通配污染，**不是证据**。若不这么判，就会被污染的变体
		 *   把「运营商明确没发布」搅成「无法判定」。
		 */
		let canon = null;
		for (let i = 0; i < length(items); i++) {
			if (items[i].canonical) {
				canon = items[i];
			}
		}
		if (canon != null && canon.state == 'not_published') {
			verdict = 'not_published';
		} else if (allGone) {
			verdict = 'not_published';
		} else if (allPolluted) {
			verdict = 'polluted';
		} else {
			verdict = 'unknown';
		}
	}

	/*
	 * ★ 这里**不组装阶段链**：ePDG 只是 VoWiFi 五道门里的第三道。
	 *   阶段链、阻断清单、总判定都在 vowifiFacts() 里（那里才有五道门的全部事实）。
	 *   放在这里会变成「ePDG 探测顺手报一个四段链」，两套 stages 前端只认一套，
	 *   另一套必然是没人看的死数据。
	 */
	return {
		success: true,
		imsi: imsi,
		iccid: iccid,
		mcc: mcc,
		mnc: mnc,
		mncLen: mncLen,
		mncSource: mncSource,
		/* ★ 不再单独回 aid/app：它俩就是 aka.aid / aka.app，两处同值没人看第二处 */
		aka: aka,
		smsc: smsc,
		ims: { stat: imsStat, registered: (imsStat != null && imsStat == '1') },
		items: items,
		posCtl: posCtl,
		negCtl: negCtl,
		verdict: verdict,
		at: time()
	};
}

/* ---------- VoWiFi 的第二半：卡上装了哪些应用 / IMPI 从哪来 ----------
 *
 * ★ 参考 VoCat 的 identity discovery：VoWiFi 的 EAP-AKA 用的**不是 IMSI**，
 *   而是 IMPI（IMS Private Identity），形如
 *       <IMSI>@ims.mnc<MNC>.mcc<MCC>.3gppnetwork.org   （3GPP TS 23.003 §13.3）
 *   标准做法是**先读 ISIM 的 EF_IMPI**，卡上没有 ISIM 才按上式派生
 *   （VoCat 的 types.go 明确写了「IMS 没下发号码时不从 IMSI 推断」，
 *   但 IMPI 是可以从 IMSI 派生的，两者不是一回事）。
 *
 * ★★ 本设备实测（2026-09-24）→ 为什么这里一律走派生而不去读 ISIM：
 *   - AT+CRSM 的 <path> **不接受 AID**：传 16 字节 AID 一律回
 *     "+CME ERROR: Incorrect parameters"，只认 "3F00" 这种 MF 路径；
 *   - AT+CSIM 下 SELECT EF（00 A4 02 xx 02 <FID>）对本卡一律回 6B00。
 *   → ISIM 下面的 EF 在本机上**读不到**。不假装能读：identity.impiSource
 *     恒定是 "derived"，卡上有没有 ISIM 另外单独报（它本身就是要紧的证据）。
 */
const EF_DIR_ID = 12032;        /* 0x2F00　EF_DIR：列出卡上装了哪些应用 */
const EF_DIR_PATH = '3F00';     /* ★ 必须带 path，不带就 +CME ERROR: UNKNOWN（真机实测） */
const EF_DIR_MAX_REC = 6;       /* 线性记录文件，读满 6 条就停，不无限读 */

/*
 * ★★ AT+CSIM 在本模组上的命令长度上限（真机实测 2026-09-24）：
 *   42 个十六进制字符（21 字节）通过，44 起一律 "ERROR"（与命令内容无关 ——
 *   用同一条 SELECT 命令补填充到 44 也一样 ERROR）。
 *   而 USIM AUTHENTICATE（80 88 00 80 22 <RAND 16B><AUTN 16B> 00）需要 76 个
 *   十六进制字符 —— **发不出去**。
 *   → 「这张卡能不能真的算一次 AKA」在本机上无法实测。这不是漏实现，是通道
 *     不支持；aka.probe.supported 如实报 false，不写一个永远跑不到的分支。
 */
const CSIM_MAX_HEX = 42;
const AKA_AUTH_HEX = 76;

/* 十进制字符串 → 2 位十六进制（CRSM 的 sw1/sw2 是十进制回的） */
function decHex2(s) {
	let v = 0;
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if (c < '0' || c > '9') {
			return '??';
		}
		v = v * 10 + index('0123456789', c);
	}
	if (v > 255) {
		return '??';
	}
	return substr(HEX_UP, (v >> 4) & 15, 1) + substr(HEX_UP, v & 15, 1);
}

/*
 * CRSM 的状态字 → 4 位十六进制（如 "6A83"）。解析不出来返回 null。
 * ★ 与 crsmOk 的分工：crsmOk 只回答「是不是 9000」（读 EF 内容那几处在用），
 *   这里要拿**完整**状态字 —— EF_DIR 得靠 6A83 才知道「记录读完了」，
 *   只看成功/失败会把「读完」和「出错」混成一回事。
 */
function crsmSw(data) {
	if (data == null) {
		return null;
	}
	let k = index(data, '+CRSM:');
	if (k < 0) {
		return null;
	}
	let s = substr(data, k + length('+CRSM:'));
	let c = index(s, ',');
	if (c < 0) {
		return null;
	}
	let sw1 = trim(substr(s, 0, c));
	let s2 = substr(s, c + 1);
	let c2 = index(s2, ',');
	if (c2 < 0) {
		c2 = index(s2, '"');
	}
	if (c2 < 0) {
		c2 = length(s2);
	}
	let sw2 = trim(substr(s2, 0, c2));
	return decHex2(sw1) + decHex2(sw2);
}

/* 在 hex 串里找 <tag> 的值（BER-TLV，只认短格式长度）。找不到返回 null。 */
function tlvVal(hex, tag) {
	if (hex == null) {
		return null;
	}
	let n = length(hex);
	let i = 0;
	while (i + 4 <= n) {
		if (substr(hex, i, 2) == tag) {
			let lb = hexPairVal(hex, i + 2);
			if (lb > 0 && i + 4 + lb * 2 <= n) {
				return substr(hex, i + 4, lb * 2);
			}
		}
		i = i + 2;
	}
	return null;
}

const ASCII_VISIBLE = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

/* hex → 可打印 ASCII。★ 遇到**第一个**不可打印字节就停（不猜 UCS2/其它编码）。 */
function hexAscii(hex) {
	if (hex == null) {
		return '';
	}
	let out = '';
	for (let i = 0; i + 2 <= length(hex); i = i + 2) {
		let v = hexPairVal(hex, i);
		if (v < 32 || v > 126) {
			return out;
		}
		out = out + substr(ASCII_VISIBLE, v - 32, 1);
	}
	return out;
}

/* AID → 应用类型。★ 只认 3GPP 定义的两个前缀，别的如实说「其它」。 */
function appKind(aid) {
	if (aid == null || length(aid) < 14) {
		return 'other';
	}
	if (substr(aid, 0, 12) == 'A00000008710') {
		let k = substr(aid, 12, 2);
		if (k == '02') {
			return 'USIM';
		}
		if (k == '04') {
			return 'ISIM';
		}
	}
	return 'other';
}

/*
 * 卡上装了哪些应用（EF_DIR 逐条读记录）。
 *
 * ★ 结束条件：读到 6 条，或者状态字 6A83（记录不存在＝读完了）。
 *
 * ★★ 「读不出来」必须和「确实没有」分开（红线 23）：
 *   AT 通道挂了 / 状态字异常 → err 非空，调用方要显示「读不到」，
 *   **不许**落到「卡上没有 ISIM」——那会把一次读取失败说成一张卡的客观事实。
 *   只有读到 6A83（第一条就没有记录）才是真的「卡上没装任何应用」，err 保持空。
 */
function efDirApps(dl) {
	let apps = [];
	let err = '';
	for (let rec = 1; rec <= EF_DIR_MAX_REC; rec++) {
		/* 预算用尽：不再占用串口，按「读不到」收场（dirError 非空的原有语义） */
		if (dlExpired(dl)) {
			err = 'ef_dir_budget_exhausted';
			break;
		}
		let r = rpcCall('at', {
			cmd: 'AT+CRSM=178,' + EF_DIR_ID + ',' + rec + ',4,0,,"' + EF_DIR_PATH + '"',
			fresh: true
		});
		if (r == null || !r.success || r.data == null) {
			err = 'ef_dir_read_failed';
			break;
		}
		let sw = crsmSw(r.data);
		if (sw == null) {
			err = 'ef_dir_read_failed';
			break;
		}
		if (sw == '6A83') {
			break;             /* 记录不存在＝读完了（卡上就这些） */
		}
		if (sw != '9000') {
			err = 'ef_dir_sw_' + sw;
			break;
		}
		let hex = crsmHex(r.data);
		if (hex == null) {
			err = 'ef_dir_nodata';
			break;
		}
		let aid = tlvVal(hex, '4F');
		/* 这条记录没 AID（空记录/别的东西）：跳过继续读下一条，不当成结束 */
		if (aid != null) {
			apps[length(apps)] = {
				aid: aid,
				kind: appKind(aid),
				label: hexAscii(tlvVal(hex, '50'))
			};
		}
	}
	return { apps: apps, err: err };
}

function isimOf(apps) {
	for (let i = 0; i < length(apps); i++) {
		if (apps[i].kind == 'ISIM') {
			return apps[i];
		}
	}
	return null;
}

/* MNC 补成三位（TS 23.003 的域名里 MNC 恒三位，不足补前导零） */
function mnc3Of(mnc) {
	if (mnc == null || length(mnc) == 0 || length(mnc) > 3) {
		return '';
	}
	if (length(mnc) == 3) {
		return mnc;
	}
	return '0' + mnc;
}

/* IMPI 派生式（TS 23.003 §13.3）。参数不全就返回空串，不拼半个出来。 */
function deriveImpi(imsi, mcc, mnc3) {
	if (imsi == '' || length(mcc) != 3 || length(mnc3) != 3) {
		return '';
	}
	return imsi + '@ims.mnc' + mnc3 + '.mcc' + mcc + '.3gppnetwork.org';
}

/* 本模组能不能真的发一次 USIM AUTHENTICATE（见 CSIM_MAX_HEX 的实测注释） */
function akaProbeSupported() {
	return AKA_AUTH_HEX <= CSIM_MAX_HEX;
}

/* AT^IMSSWITCH? 的第一个值：LTE 上的 IMS 业务开关（1=开）。读不到返回 null。 */
function imsswitchStat() {
	let r = rpcCall('at', { cmd: 'AT^IMSSWITCH?', fresh: true });
	if (r == null || !r.success || r.data == null) {
		return null;
	}
	let k = index(r.data, '^IMSSWITCH:');
	if (k < 0) {
		return null;
	}
	let s = trim(substr(r.data, k + length('^IMSSWITCH:')));
	if (length(s) == 0) {
		return null;
	}
	return substr(s, 0, 1);
}

/*
 * ---------------------------------------------------------------------------
 * VoWiFi 编排：把上面这些事实**按顺序过五道门**
 * ---------------------------------------------------------------------------
 *
 * ★ 参考 VoCat orchestrator 的编排思想（Enable 的迁移条件逐条独立判定）：
 *   SIM 身份 → IMS 身份（IMPI）→ AKA 就绪 → ePDG 发布 → IMS 已注册。
 *   **「已请求/已启用」不是状态**（VoCat types.go 的注释），所以这里没有
 *   「开了 VoWiFi 就算 ready」这种说法；每一门的 ok 只由实测事实决定，
 *   不做「前面过了所以后面也应该过」的推理。
 *
 * ★ 与参考项目的**刻意差异**（CPE 不是手机）：
 *   VoCat 在启用时会先关蜂窝射频（CFUN=4），因为手机是把 Wi-Fi 当替代承载。
 *   这台设备的蜂窝是**唯一上行**，关射频＝断网，所以这里**全程只读**，
 *   一条会改动模组状态的命令都不发（也不发 AT+CCHO，见 akaEvidence 的注释）。
 */
function vowifiTraceId(iccid) {
	let tail = (iccid != null && length(iccid) >= 4) ? substr(iccid, length(iccid) - 4) : '0000';
	return 'vw-' + time() + '-' + tail;
}

function vowifiFacts(dl) {
	let ep = epdgFacts(dl);
	if (ep == null || !ep.success) {
		return { success: false, error: (ep == null ? 'ePDG 探测返回空' : ep.error) };
	}

	let dir = efDirApps(dl);
	let apps = dir.apps;
	let isim = isimOf(apps);
	let mnc3 = mnc3Of(ep.mnc);
	let impi = deriveImpi(ep.imsi, ep.mcc, mnc3);
	let imsDomain = (length(mnc3) == 3 && length(ep.mcc) == 3)
		? 'ims.mnc' + mnc3 + '.mcc' + ep.mcc + '.3gppnetwork.org' : '';
	let imssw = imsswitchStat();

	let simOk = (ep.imsi != '' && ep.mcc != '' && ep.mnc != '' && ep.mncSource != 'ambiguous');
	let akaOk = (ep.aka != null && ep.aka.ready);
	let epdgOk = (ep.verdict == 'available');
	let imsOk = (ep.ims.stat != null && ep.ims.stat == '1');

	let stages = [
		{
			key: 'sim',
			label: '卡身份（MCC/MNC）',
			ok: simOk,
			detail: 'IMSI ' + ep.imsi + ' · MCC ' + ep.mcc + ' / MNC ' + ep.mnc
				+ '（' + (ep.mncSource == 'ef_ad' ? 'EF_AD 定长'
					: (ep.mncSource == 'ehplmn' ? 'EF_EHPLMN 兜底' : '未定长，两种都查')) + '）'
		},
		{
			key: 'identity',
			label: 'IMS 身份（IMPI）',
			ok: (impi != ''),
			detail: (impi == '' ? 'IMSI/MCC/MNC 不全，无法构造 IMPI'
				: impi + '（派生；本模组读不到 ISIM 下的 EF_IMPI，见 efDirApps 注释）')
		},
		{
			key: 'aka',
			label: '卡上有 USIM/ISIM 应用',
			ok: akaOk,
			detail: (ep.aka.aid == null ? '没读到 AKA 应用 AID（' + ep.aka.how + '）'
				: (ep.aka.app + ' ' + ep.aka.aid + ' · 卡上 FCI 自报；'
					+ 'AUTHENTICATE 实测：' + (akaProbeSupported() ? '可发' : '本模组发不出去')))
		},
		{
			key: 'epdg',
			label: '运营商发布 ePDG',
			ok: epdgOk,
			detail: (epdgOk ? '已解析到 ePDG 地址'
				: (ep.verdict == 'not_published' ? '公网查不到该运营商的 ePDG'
					: (ep.verdict == 'polluted' ? 'DNS 通配污染，拿到的不是真地址'
						: '两条解析链路都没给出确定结论')))
		},
		{
			key: 'ims',
			label: 'IMS 已注册',
			ok: imsOk,
			detail: (ep.ims.stat == null ? 'AT+CIREG? 读不到'
				: '+CIREG stat=' + ep.ims.stat + (imsOk ? '（已注册）' : '（未注册）')
					+ ' · ^IMSSWITCH=' + (imssw == null ? '读不到' : imssw))
		}
	];

	/*
	 * 阻断清单 —— 「没过哪几道门」必须能逐条点名（参考 VoCat 前端的
	 * 「{items} 未就绪」），只给一个「不可用」用户不知道该换卡还是该等运营商。
	 */
	let blockers = [];
	if (!simOk) {
		blockers[length(blockers)] = (ep.mncSource == 'ambiguous') ? 'mnc_ambiguous' : 'sim_unread';
	}
	if (impi == '') {
		blockers[length(blockers)] = 'no_impi';
	}
	if (!akaOk) {
		blockers[length(blockers)] = 'no_usim_isim';
	}
	if (!epdgOk) {
		blockers[length(blockers)] = 'epdg_' + ep.verdict;
	}
	if (!imsOk) {
		blockers[length(blockers)] = 'ims_not_registered';
	}

	/*
	 * ★ phase 必须是**连续**通过的前缀，不是「最后一个 ok 的门」。
	 *   真机形态（sim✓ identity✓ aka✓ epdg✗ ims✓）：取「最后一个 ok」会算出
	 *   ims_ready，于是界面同时显示「走到：IMS 已注册」和「VoWiFi 不成立」——
	 *   自相矛盾，看着像只差最后一步。卡在第三道门就该报 aka_ready。
	 */
	const PHASE_BY_STAGE = ['sim_ready', 'identity_ready', 'aka_ready', 'access_ready', 'ims_ready'];
	let phase = 'blocked';
	for (let i = 0; i < length(stages); i++) {
		if (!stages[i].ok) {
			break;
		}
		phase = PHASE_BY_STAGE[i];
	}

	/* 总判定：五门全过才叫「这条路通」；ePDG 无法判定时不许说「不通」。 */
	let verdict = 'blocked';
	if (length(blockers) == 0) {
		verdict = 'capable';
	} else if (ep.verdict == 'unknown') {
		verdict = 'unknown';
	}

	return {
		success: true,
		traceId: vowifiTraceId(ep.iccid),
		at: time(),
		imsi: ep.imsi,
		iccid: ep.iccid,
		mcc: ep.mcc,
		mnc: ep.mnc,
		mncLen: ep.mncLen,
		mncSource: ep.mncSource,
		/*
		 * ★ 2026-09-28 加说明：identity / aka / epdg / ims 这四个方法**目前是空壳**，
		 *   前端没有任何调用点（`rpc.js` 的 L.rpc.declare 里也没有它们），
		 *   所以 `acl.d/luci-app-mt5700.json` 的 read/write 两段**都没有授权它们** ——
		 *   那是刻意的（最小权限），不是漏配。
		 *   ★ 将来真去实现这几个方法时，记得同步补 ACL，否则前端调用会得到
		 *     `Access denied`，而 LuCI 侧表现为"点了没反应"，很难查。
		 */
		identity: {
			impi: impi,
			impiSource: 'derived',
			imsDomain: imsDomain,
			/* dirError 非空 = **读不到** EF_DIR，此时 isim=null 不代表「没有 ISIM」 */
			dirError: dir.err,
			isim: (isim == null ? null : { aid: isim.aid, label: isim.label }),
			apps: apps
		},
		aka: {
			ready: akaOk,
			app: ep.aka.app,
			aid: ep.aka.aid,
			evidence: ep.aka.how,
			probe: {
				supported: akaProbeSupported(),
				apduHex: AKA_AUTH_HEX,
				maxHex: CSIM_MAX_HEX
			}
		},
		epdg: {
			verdict: ep.verdict,
			items: ep.items,
			posCtl: ep.posCtl,
			negCtl: ep.negCtl
		},
		ims: {
			stat: ep.ims.stat,
			registered: imsOk,
			imsswitch: imssw,
			smsc: ep.smsc
		},
		stages: stages,
		blockers: blockers,
		phase: phase,
		verdict: verdict
	};
}

/*
 * ---------------------------------------------------------------------------
 * VoWiFi 开关：开/关的是**本机这一半**（IMS 域能力）
 * ---------------------------------------------------------------------------
 *
 * ★ 为什么开关落在 AT^IMSSWITCH 上（2026-09-24 查手册 + 真机实测）：
 *   手册全部 238 条命令里**没有任何 VoWiFi / ePDG 命令**，跟 IMS 有关的只有
 *   AT^IMSSWITCH（4.10 IMS 业务能力开关）与 AT+CIREG（IMS 注册状态查询）。
 *   VoWiFi 走的正是 IMS，而 ePDG 隧道是**运营商侧的网元** —— 本机没有可下发的
 *   参数。所以开关只能管到「本机 IMS 域能力」这一层，这一点在界面上写明白，
 *   **不假装开了它 VoWiFi 就通**（红线 14：不写永远生效不了的开关）。
 *
 * ★ 真机实测（同一天）：
 *   AT^IMSSWITCH?  → `^IMSSWITCH: 1,0,0`（IMS 已开）
 *   AT^IMSSWITCH=? → `(0,1),(0,1),(0,1)`（值域正常，不是占位符）
 *   AT^IMSSWITCH=1,0,0 → OK，回读仍是 1,0,0 —— **真实可写，不是空壳**
 *   手册：掉电保存=Y、PIN=N；三条失败条件之一是「当前存在 IMS 业务时返回失败」。
 *
 * ★ 开启前先过**本地三门**（卡身份 / IMPI / AKA）：任一门不过就**一条写命令
 *   都不下发**，并把阻断项逐条回给前端 —— 用户要的是「不能开启则告知原因」，
 *   不是点了没反应，也不是下发一条注定失败的命令。
 * ★ ePDG 与「IMS 已注册」**不参与开启门禁**：前者由运营商决定，后者是开关
 *   开了之后才可能发生的事。开了开关仍不成立时，由 facts 里的 blockers 说明。
 *
 * ★ 写入后必须 fresh 回读（与 sms_settings.js 的 R04 同一套约定）：
 *   ^IMSSWITCH? 不在 rpc.js 的 IDENTIFIER/STATE 读缓存档，落到默认 2500ms，
 *   不 fresh 就会捞到下发前的旧值，把「已生效」误判成「没生效」。
 * ★ 回读与目标不一致时**只收敛到实测值，不反向重下发**（手册那三条失败条件
 *   在回滚那一刻通常仍然成立，反向命令大概率同样失败）。
 */
function vowifiSetCmd(enable) {
	return 'AT^IMSSWITCH=' + (enable ? '1,0,0' : '0,0,0');
}

/* 只有这四项是「本机/这张卡」的问题，够得上拒绝开启；其余是运营商侧或时序问题 */
function vowifiLocalBlockers(f) {
	let out = [];
	if (f == null || !f.success || f.blockers == null) {
		out[length(out)] = 'sim_unread';
		return out;
	}
	for (let i = 0; i < length(f.blockers); i++) {
		let b = f.blockers[i];
		if (b == 'sim_unread' || b == 'mnc_ambiguous' || b == 'no_impi' || b == 'no_usim_isim') {
			out[length(out)] = b;
		}
	}
	return out;
}

/*
 * 下发 + 回读。返回 { sent, actual, effective, unknown, err }：
 *   sent      写命令是否发出成功
 *   actual    回读到的实测值（'1'/'0'，null＝读不到）
 *   effective 回读值等于目标值
 *   unknown   回读不到 —— 不许据此断言生效与否，如实交给前端
 */
function imsswitchWrite(enable) {
	let r = rpcCall('at', { cmd: vowifiSetCmd(enable) });
	if (r == null || !r.success) {
		return {
			sent: false, actual: null, effective: false, unknown: true,
			err: (r == null ? 'AT 通道无响应' : (r.error || '下发失败'))
		};
	}
	let actual = imsswitchStat();
	if (actual == null) {
		return { sent: true, actual: null, effective: false, unknown: true, err: '' };
	}
	return {
		sent: true,
		actual: actual,
		effective: (actual == (enable ? '1' : '0')),
		unknown: false,
		err: ''
	};
}

function vowifiSet(enable) {
	let f = vowifiFacts(time() + 30);
	if (f == null || !f.success) {
		return { success: false, error: (f == null ? 'VoWiFi 评估返回空' : f.error) };
	}

	/* ★ 拒绝路径：本地三门没过 → 不下发任何写命令，把原因逐条带回去 */
	if (enable) {
		let local = vowifiLocalBlockers(f);
		if (length(local) > 0) {
			return {
				success: true,
				enable: enable,
				applied: false,
				refused: true,
				blockers: local,
				facts: f
			};
		}
	}

	let w = imsswitchWrite(enable);
	if (!w.sent) {
		return {
			success: true,
			enable: enable,
			applied: false,
			refused: false,
			error: w.err,
			imsswitch: null,
			facts: f
		};
	}

	/*
	 * 下发后**重跑一次五门**：开关状态与「VoWiFi 成不成立」是两件事，
	 *   前端要能同时显示「已开启」和「还差什么」（本机此时差的是 ePDG）。
	 *   重跑失败就退回下发前的那份，不因此否认这次写入。
	 */
	/* 第二遍预算收得更紧（B01）：开关写入不改变 IMSI/AKA/ePDG 这些门，
	 *   需要刷新的只有 IMS 注册态与开关值本身 —— 20s 内跑不完就退回第一遍
	 *   的结论（下方 after = f 的兜底分支），绝不为它把 rpcd 冻住。 */
	let after = vowifiFacts(time() + 20);
	if (after == null || !after.success) {
		after = f;
	}

	return {
		success: true,
		enable: enable,
		applied: true,
		refused: false,
		effective: w.effective,
		unknown: w.unknown,
		imsswitch: w.actual,
		error: w.err,
		blockers: after.blockers,
		verdict: after.verdict,
		phase: after.phase,
		facts: after
	};
}

function es9pMktemp() {
	let p;
	try {
		p = fs.popen('mktemp /tmp/mt5700-es9p-XXXXXX', 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}
	let s = p.read('line');
	p.close();
	s = (s != null) ? trim(s) : '';
	if (length(s) == 0 || substr(s, 0, 1) != '/') {
		return null;
	}
	return s;
}

function es9pUnlink(path) {
	if (path == null) {
		return;
	}
	try { fs.unlink(path); } catch (e) { }
}

/*
 * ★ 为什么必须自带一份 GSMA CI（2026-09-19 真机实测）：
 *   运营商的 SM-DP+ 用的是 **GSMA 自己的 PKI**，证书由 "GSM Association -
 *   RSP2 Root CI1" 这类根 CI 签发。这套根**不在任何公开 CA 库里**
 *   （Windows / OpenWrt 的 ca-certificates.crt 都没有），所以 curl 一律报
 *       SSL certificate ... unable to get local issuer certificate (20)
 *   HTTP 状态码 000 —— 表现就是「下载永远卡在第一步」，看起来像网络问题，
 *   实际是信任库缺根。真实案例：consumer.rsp.world 的叶子证书 issuer 正是
 *   RSP2 Root CI1，用系统库怎么验都失败，补上这根后立刻验过。
 *
 *   解决办法是**补根**而不是绕过：把插件自带的 GSMA CI 与系统信任库合并成
 *   一份临时 bundle 交给 curl --cacert，证书验证继续开着（不加 -k）。
 *   只信任 GSMA 会漏掉「SM-DP+ 用普通 Web PKI 证书」的运营商，
 *   只信系统会漏掉 GSMA PKI —— 所以两者都要，合并使用。
 */
const GSMA_CI_PEM = '/etc/ssl/certs/mt5700-gsma-rsp-ci.pem';
const SYS_CA_PEM = '/etc/ssl/certs/ca-certificates.crt';

/* 读不到（不存在 / 没权限 / 抛异常）就返回 null，不让任何一处 IO 拖垮请求 */
function es9pReadOpt(path) {
	let r;
	try {
		r = fs.readfile(path);
	} catch (e) {
		return null;
	}
	if (r == null || length(r) == 0) {
		return null;
	}
	return r;
}

/*
 * 返回 { arg: " --cacert '<file>'", temp: <要事后删除的路径 或 null> }；
 * 两份都读不到时返回 null —— 那时不加参数，交回 curl 的默认行为
 * （仍然验证，不降级）。
 */
function es9pCaBundle() {
	const sys = es9pReadOpt(SYS_CA_PEM);
	const gsma = es9pReadOpt(GSMA_CI_PEM);

	if (sys == null && gsma == null) {
		return null;
	}
	if (gsma == null) {
		return { arg: " --cacert '" + SYS_CA_PEM + "'", temp: null };
	}
	if (sys == null) {
		return { arg: " --cacert '" + GSMA_CI_PEM + "'", temp: null };
	}

	/* 两份都有：合并成一份临时 bundle（顺序无关，curl 会逐个试） */
	const tmp = es9pMktemp();
	if (tmp == null) {
		/* 合不了也别失败：退到系统库，总比没有强 */
		return { arg: " --cacert '" + SYS_CA_PEM + "'", temp: null };
	}
	let f = fs.open(tmp, 'w');
	if (!f) {
		es9pUnlink(tmp);
		return { arg: " --cacert '" + SYS_CA_PEM + "'", temp: null };
	}
	f.write(sys);
	f.write('\n');
	f.write(gsma);
	f.close();
	return { arg: " --cacert '" + tmp + "'", temp: tmp };
}

/* 清掉 es9pCaBundle() 生成的临时 bundle（它自己不带生命周期） */
function es9pCaDone(ca) {
	if (ca != null && ca.temp != null) {
		es9pUnlink(ca.temp);
	}
}

function es9pPost(host, path, body) {
	const bodyFile = es9pMktemp();
	const outFile = es9pMktemp();
	if (bodyFile == null || outFile == null) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		return { success: false, error: '无法创建临时文件（设备上没有 mktemp？）' };
	}

	/* 信任库：系统 CA + GSMA CI，缺根就永远验不过（见上面 GSMA_CI_PEM 的注释） */
	const ca = es9pCaBundle();
	const caArg = (ca != null) ? ca.arg : '';

	let f = fs.open(bodyFile, 'w');
	if (!f) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		es9pCaDone(ca);
		return { success: false, error: '无法写临时文件' };
	}
	f.write(body);
	f.close();

	const cmd = timeoutBin() + ' 45 curl -sS --max-time 35 -X POST' +
		" -H 'Content-Type: application/json'" +
		" -H 'X-Admin-Protocol: gsma/rsp/v2.2.2'" +
		" -H 'User-Agent: gsma-rsp-lpad'" +
		' --data-binary @' + bodyFile +
		' -o ' + outFile +
		" -w '%{http_code}'" +
		caArg +
		" 'https://" + host + path + "'";

	let p;
	try {
		p = fs.popen(cmd, 'r');
	} catch (e) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		es9pCaDone(ca);
		return { success: false, error: '无法发起 HTTPS 请求' };
	}
	if (!p) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		es9pCaDone(ca);
		return { success: false, error: '无法发起 HTTPS 请求' };
	}
	let codeLine = p.read('line');
	p.close();
	es9pUnlink(bodyFile);
	es9pCaDone(ca);

	let respBody = '';
	try {
		respBody = fs.readfile(outFile);
	} catch (e) {
		respBody = '';
	}
	es9pUnlink(outFile);

	let status = int(trim(codeLine != null ? codeLine : ''));
	if (status == null) {
		return { success: false, status: 0, body: respBody, error: '服务器无响应或连接失败' };
	}
	return { success: true, status: status, body: respBody };
}

/* ============================================================================
 * 已发短信记录（smslog）—— 跨浏览器可见的唯一真源
 * ----------------------------------------------------------------------------
 * ★ 为什么要有这一层：已发短信原先只写在浏览器的 localStorage 里，那是
 *   **浏览器**的私有空间 —— 换一个浏览器、清一次缓存、换一台电脑打开页面，
 *   发送过的记录就一条都不剩。而「这台设备发出过什么」的权威记录只能落在
 *   **设备**上：所有浏览器读的是同一个文件，看到的就是同一份历史。
 *
 * ★★ 为什么不是写进模组短信存储（AT+CMGW=<len>,3）：模组的 SM 只有 50 个槽位，
 *   本机实测已占用 44。把发送日志写进去，发几条就写满；而 smsclean 的解码器
 *   只认 SMS-DELIVER（SUBMIT 解不出短信中心时间就不进淘汰名单），结果是
 *   **存满以后谁都删不掉它** —— 表现为短信再也收不进来。
 *   用稀缺的收信槽位换一条便利，稳定性上划不来，不做。
 *   该路径的可行性已真机验证（AT+CMGW 受理、AT+CMGL 可回读 `+CMGL: 41,3,,25`），
 *   是**评估过之后放弃**，不是没试过。
 *
 * 落盘用「写临时文件 + rename」：同一目录内 rename 是原子的，写到一半断电也
 * 不会留下半个 JSON（与 READ_CACHE_DIR 的 cachePut 同一套路）。
 * ============================================================================ */

const SMS_LOG_DIR = '/etc/mt5700';
const SMS_LOG_FILE = SMS_LOG_DIR + '/sms-sent.json';
/* 条数上限：一条约 200 字节，1000 条约 200KB。记录是日志，超了丢最旧的 */
const SMS_LOG_MAX = 1000;
/* 单条正文上限：短信拼到极限也就几百字，4KB 纯粹是挡异常输入 */
const SMS_LOG_TEXT_MAX = 4096;

function smsLogRead() {
	let raw = null;
	try { raw = fs.readfile(SMS_LOG_FILE); } catch (e) { return []; }
	if (raw == null || raw == '') { return []; }
	let list = null;
	try { list = jsonParse(raw); } catch (e) { return []; }
	return (type(list) == 'array') ? list : [];
}

/* 日志落盘的临时文件名：随机后缀 + 同目录 rename（原子替换）。
 * 固定 .tmp 名在「两个浏览器同时写日志」时会互相覆盖 —— 并发双方都写同一个
 * tmp，先落盘的内容被后写者盖掉，rename 进主文件的内容就是串的
 * （丢更新、id 重复）。B09，2026-10-22 全仓审计。 */
function logTmpPath(file) {
	let suffix = '';
	try {
		suffix = '.' + sprintf('%d', time()) + '.' + sprintf('%d', rand());
	} catch (e) {
		suffix = '';
	}
	return file + suffix + '.tmp';
}

function smsLogWrite(list) {
	try { fs.mkdir(SMS_LOG_DIR); } catch (e) { }
	let tmp = logTmpPath(SMS_LOG_FILE);
	try {
		fs.writefile(tmp, sprintf('%J', list));
		fs.rename(tmp, SMS_LOG_FILE);
		return true;
	} catch (e) {
		try { fs.unlink(tmp); } catch (e2) { }
		return false;
	}
}

/*
 * 只收界面画得出来的四个字段。
 * 这条通路能把内容写进设备文件，多收一个字段就多一条「借短信记录往设备里
 * 塞任意内容」的路子 —— 宁可少存，也不开这个口子。
 */
function smsLogEntry(m) {
	if (type(m) != 'object') { return null; }
	if (type(m.content) != 'string' || type(m.number) != 'string' || type(m.time) != 'string') { return null; }
	if (m.type != 'sent' && m.type != 'received') { return null; }
	if (length(m.content) > SMS_LOG_TEXT_MAX || length(m.number) > 32 || length(m.time) > 32) { return null; }
	return { content: m.content, number: m.number, time: m.time, type: m.type };
}

function smsLogNextId(list) {
	let max = 0;
	for (let i = 0; i < length(list); i++) {
		if (type(list[i]) != 'object') { continue; }
		let v = int(list[i].id);
		if (v != null && v > max) { max = v; }
	}
	return max + 1;
}

/* ---------- 语音通话（2026-10-16） ---------- */

/*
 * 通话号码白名单校验。
 *
 * ★ 为什么必须是白名单：这个字符串会被**原样拼进 AT 命令**（ATD<number>;）。
 *   AT 的行语义认分号 —— 号码里若能带 ';'，一条请求就变成两条命令
 *   （如 "10086;AT+CFUN=0" 直接关射频，而调用方看到的只是「拨号失败」）。
 *   所以只放行：
 *     · 数字 0-9
 *     · * 与 #（USSD / 补充业务码，如 *21*6361# 查询呼叫转移）
 *     · 开头的 +（国际前缀，**仅第 0 位**；中间出现 + 一律拒）
 *   分号、等号、字母、引号、空白、控制字符全部拒绝。
 *   长度上限 24：E.164 最长 15 位，USSD 码约 20 字符，24 够用且挡住异常输入。
 */
function callNumberOk(s) {
	if (s == null || type(s) != 'string') {
		return false;
	}
	let n = length(s);
	if (n < 1 || n > 24) {
		return false;
	}
	for (let i = 0; i < n; i++) {
		let c = substr(s, i, 1);
		if (i == 0 && c == '+') {
			continue;
		}
		if (index('0123456789*#', c) < 0) {
			return false;
		}
	}
	return true;
}

/* DTMF 码白名单：手册 4.7，AT+VTS 取值 (0-9,A-D,*,#)，只收单字符 */
function callDtmfOk(s) {
	if (s == null || type(s) != 'string' || length(s) != 1) {
		return false;
	}
	return index('0123456789ABCD*#', s) >= 0;
}

/*
 * 拆一行 CLCC 应答的字段，**引号字段整体取出**（号码回的是 "1008611" 或
 * "+86100861" 带引号形态）。输入行不含 '+CLCC:' 前缀；返回字段数组（引号已剥）。
 * 纯 substr/index 实现 —— 与本文件其余解析保持一致（crsmHex 同款）。
 */
function clccFields(line) {
	let out = [];
	let s = trim(line);
	while (length(s) > 0) {
		if (substr(s, 0, 1) == '"') {
			let rest = substr(s, 1);
			let q = index(rest, '"');
			if (q < 0) {
				break;
			}
			out[length(out)] = substr(rest, 0, q);
			let tail = trim(substr(rest, q + 1));
			if (substr(tail, 0, 1) != ',') {
				break;
			}
			s = trim(substr(tail, 1));
		} else {
			let c = index(s, ',');
			if (c < 0) {
				out[length(out)] = s;
				break;
			}
			out[length(out)] = trim(substr(s, 0, c));
			s = trim(substr(s, c + 1));
		}
	}
	return out;
}

/*
 * 解析 AT+CLCC 应答，返回通话数组（可能多条：多方通话）。
 * 单行格式（手册 5.11）：
 *   +CLCC: <id>,<dir>,<state>,<mode>,<mpty>,"<number>",<type>
 *     id     1~7 呼叫 ID
 *     dir    0=本机发起(MO)  1=网络来电(MT)
 *     state  0=active 1=held 2=dialing 3=alerting 4=incoming 5=waiting
 *     mode   0=语音 1=data 2=fax …
 *     mpty   多方通话标志
 *     number 号码（带引号）
 *     type   号码类型（145=国际 / 129=国内 / 161=未知…）
 *
 * ★ 无通话时模组只回 OK（无 +CLCC 行）→ 返回**空数组**。这与「读不到」
 *   是两件事：读不到由调用方的 RPC 失败分支表达（红线 23），空数组才是
 *   「确实没有通话」。
 */
function callParseClcc(data) {
	let calls = [];
	if (data == null) {
		return calls;
	}
	let rest = data;
	while (true) {
		let k = index(rest, '+CLCC:');
		if (k < 0) {
			break;
		}
		rest = substr(rest, k + length('+CLCC:'));
		let nl = index(rest, '\n');
		let line = (nl < 0) ? rest : substr(rest, 0, nl);
		let f = clccFields(line);
		if (length(f) >= 6) {
			calls[length(calls)] = {
				id: int(f[0]),
				dir: int(f[1]),
				state: int(f[2]),
				mode: int(f[3]),
				mpty: int(f[4]),
				number: f[5],
				type: (length(f) >= 7 ? int(f[6]) : null)
			};
		}
	}
	return calls;
}

/*
 * 通话阶段（stage）：把 CLCC 的 <state> 整数翻成**状态令牌**。
 *
 * ★ 为什么要这层翻译：<state> 是 3GPP 的裸整数（0~5），前端画表要自己
 *   维护映射；而"这条通道到底处于哪个阶段"是**协议语义**，应该由后端
 *   定了再往外给 —— 前端只负责显示。
 * ★ 令牌取值对齐厂商实现（modemwebui-server 的 voiceCall 状态机，
 *   2026-10-16 从 H5000M「带电话功能beta」固件逆向得到）：
 *     unknown / idle / requesting / dialing / alerting / ringing /
 *     waiting / active / held / ended
 *   厂商多一个 requesting（"等待模组确认呼出"，即 ATD 已发但 CLCC 还没
 *   建起呼叫）—— 那是**本地时序状态**，轮询模型里观测不到，故本实现不产出
 *   该值；其余令牌一一对应，前端可用同一套文案表。
 * ★ 为什么不用对象字面量做表：ucode 的对象键必须是标识符或字符串字面量，
 *   数字键 `{0:'active'}` 在部分版本上解析行为不稳（红线：本文件只在
 *   Rust 侧编译、设备上直接跑，语法差异没有编译期兜底）。用 if 链最稳。
 */
function callStageOf(c) {
	if (type(c) != 'object') {
		return 'unknown';
	}
	let s = int(c.state);
	if (s == 0) { return 'active'; }
	if (s == 1) { return 'held'; }
	if (s == 2) { return 'dialing'; }
	if (s == 3) { return 'alerting'; }
	if (s == 4) { return 'ringing'; }
	if (s == 5) { return 'waiting'; }
	return 'unknown';
}

/*
 * 多路呼叫时的整体阶段：按"最靠前于用户的阶段"取优先级。
 * 优先级 active > held > waiting > ringing > alerting > dialing
 * —— 有一路接通就得报"已接通"，不能被另一路的拨号态盖过去。
 * 空数组 → idle（这是"确实没有通话"，与"读不到"无关，红线 23）。
 */
function callOverallStage(calls) {
	if (type(calls) != 'array' || length(calls) == 0) {
		return 'idle';
	}
	let order = ['active', 'held', 'waiting', 'ringing', 'alerting', 'dialing'];
	for (let i = 0; i < length(order); i++) {
		for (let j = 0; j < length(calls); j++) {
			if (callStageOf(calls[j]) == order[i]) {
				return order[i];
			}
		}
	}
	return 'unknown';
}

/*
 * 拨号 / 接听 / 挂断 / DTMF 的统一出口。
 *
 * ★ 命令由本文件拼装，前端只传白名单内的参数 —— 前端没有任何把任意字符串
 *   送进 AT 通道的路径（与 vowifi_set 同一约定）。
 * ★ 回传 raw：ATD 的应答只有 OK，但 BUSY / NO CARRIER / +CME ERROR 会随后
 *   出现（或以 ^CEND 收尾），原始应答留给前端展示，不在本层做语义猜测。
 */
function callDo(action, cmd) {
	let r = rpcCall('at', { cmd: cmd });
	if (r == null) {
		return { success: false, action: action, sent: false, raw: '', error: 'AT 通道无响应' };
	}
	if (!r.success) {
		return {
			success: false, action: action, sent: false, raw: '',
			error: (r.error || '命令执行失败')
		};
	}
	return {
		success: true, action: action, sent: true,
		raw: (r.data == null ? '' : r.data), error: ''
	};
}

/*
 * 通话状态：AT+CLCC → 结构化通话数组 + 整体阶段。
 *
 * ★★★ 失败分支必须显式给 `calls: null`：前端用 `res.calls === null` 区分
 *   「读不到」与「确实没有通话」（红线 23）。早先这里只回 error 不给 calls，
 *   前端拿到的是 undefined —— `undefined === null` 为假，于是**报错分支成了
 *   死代码**，通道故障时页面只是"看着像空闲"，用户以为没通话其实是无读数。
 *   这类"失败被静默吞掉"的形态正是红线 23 要拦的，故在此显式声明。
 */
function callStatus() {
	let r = rpcCall('at', { cmd: 'AT+CLCC' });
	if (r == null) {
		return { success: false, action: 'status', calls: null, error: 'AT 通道无响应' };
	}
	if (!r.success) {
		return { success: false, action: 'status', calls: null, error: (r.error || '查询失败') };
	}
	let calls = callParseClcc(r.data);
	for (let i = 0; i < length(calls); i++) {
		calls[i].stage = callStageOf(calls[i]);
	}
	return {
		success: true, action: 'status',
		calls: calls,
		stage: callOverallStage(calls)
	};
}

/*
 * 取应答里某前缀后的第一个整数（'+CMUT: 0' → 0）。
 * 找不到返回 null —— 调用方据此区分「没有这一项」与「值就是 0」
 * （与 callParseClcc 的「空数组 vs 读不到」同一原则，红线 23）。
 */
function callNumAfter(text, prefix) {
	if (text == null || prefix == null) {
		return null;
	}
	let k = index(text, prefix);
	if (k < 0) {
		return null;
	}
	let rest = substr(text, k + length(prefix));
	let i = 0;
	while (i < length(rest)) {
		let c = substr(rest, i, 1);
		if (c != ' ' && c != ':' && c != '\t') {
			break;
		}
		i++;
	}
	let digits = '';
	while (i < length(rest)) {
		let c = substr(rest, i, 1);
		if (index('0123456789', c) < 0) {
			break;
		}
		digits = digits + c;
		i++;
	}
	return (digits == '') ? null : int(digits);
}

/*
 * 通话线路信息：麦克风静音（CMUT）与扬声器音量（CLVL）。
 *
 * ★ 为什么不并进 status 轮询：status 每 2 秒一轮，并进这两条就是把每轮
 *   串口占用从 1 条变 3 条（真机单条 65–133ms，串口独占串行 —— 红线 70：
 *   多查不会更快，只会更久）。而 CMUT/CLVL 几乎不变，做成按需查询。
 * ★★★ 这里**不能**写 rpcCall('at_batch', ...)：at_batch 是 rpcd 层注册的
 *   ubus 方法（本文件下面 dispatch 里那个），而 rpcCall() 只认 **Rust 服务
 *   （127.0.0.1:8765）** 的方法名。真机实测（2026-10-16）写错时 Rust 直接回
 *   `"error": "未知方法: at_batch"` —— 于是 CMUT/CLVL 一个都取不到。
 *   两条命令就老老实实两次 rpcCall('at')。
 * ★ 两项独立降级：CMUT 拿不到 = 通道不通（整体报错）；CLVL 拿不到只把
 *   volume 留 null —— 调用方据此区分「没读到」与「值是 0」（红线 23）。
 * ★ 真机实测：`+CMUT: 0`、`+CLVL: 7`。
 *   CLVL 取值：普通模式 0–5，**车载 PCM 模式 1–12**（NV wpgPcmFlag 控制，
 *   手册 6.10）—— 读到 7 即说明本模组当前处于车载 PCM 语音模式。
 */
function callLineInfo() {
	let out = { success: true, action: 'info', mute: null, volume: null, raw: '' };

	let m = rpcCall('at', { cmd: 'AT+CMUT?' });
	/* CMUT 拿不到 = 通道不通，整体报错 —— 这是本函数注释与红线 23 的既有约定。
	 * 原先判 m == null 是死分支：rpcCall 所有退出路径都返回对象，通道忙/错时
	 * m.success == false，被下面的 if 静默吞掉后 mute 恒 null，页面把
	 * 「通道故障」画成「未静音」（B02，2026-10-22 全仓审计）。 */
	if (!m.success) {
		return {
			success: false, action: 'info',
			mute: null, volume: null, raw: '',
			error: (m.error || 'CMUT 查询失败')
		};
	}
	if (type(m.data) == 'string') {
		out.raw = out.raw + m.data;
		out.mute = callNumAfter(m.data, '+CMUT:');
	}

	/* CLVL 保持独立降级：拿不到只把 volume 留 null，不影响整体（红线 23） */
	let v = rpcCall('at', { cmd: 'AT+CLVL?' });
	if (v.success && type(v.data) == 'string') {
		out.raw = out.raw + v.data;
		out.volume = callNumAfter(v.data, '+CLVL:');
	}

	return out;
}

/* ---------- 通话记录（设备侧持久化，跨浏览器可见的唯一真源） ---------- */

const CALL_LOG_DIR = '/etc/mt5700';
const CALL_LOG_FILE = CALL_LOG_DIR + '/call-log.json';
/* 条数上限：一条约 120 字节，100 条约 12KB。记录是日志，超了丢最旧的 */
const CALL_LOG_MAX = 100;
/* 单次通话时长上限（秒）：86400＝24 小时，纯粹是挡异常输入 */
const CALL_LOG_DUR_MAX = 86400;

function callLogRead() {
	let raw = null;
	try { raw = fs.readfile(CALL_LOG_FILE); } catch (e) { return []; }
	if (raw == null || raw == '') { return []; }
	let list = null;
	try { list = jsonParse(raw); } catch (e) { return []; }
	if (type(list) != 'array') {
		return [];
	}
	/*
	 * ★ 老记录（本次升级前落的）只有 dir 没有 direction：在**读侧补**，
	 *   不做落盘迁移 —— 迁移要重写整份文件，一旦中途掉电就是记录全丢；
	 *   读侧补齐的代价是每次多走一趟循环，几乎为零。
	 */
	for (let i = 0; i < length(list); i++) {
		if (type(list[i]) == 'object' && list[i].direction == null) {
			list[i].direction = (int(list[i].dir) == 1) ? 'incoming' : 'outgoing';
		}
	}
	return list;
}

function callLogWrite(list) {
	try { fs.mkdir(CALL_LOG_DIR); } catch (e) { }
	let tmp = logTmpPath(CALL_LOG_FILE);
	try {
		fs.writefile(tmp, sprintf('%J', list));
		fs.rename(tmp, CALL_LOG_FILE);
		return true;
	} catch (e) {
		try { fs.unlink(tmp); } catch (e2) { }
		return false;
	}
}

/*
 * 只收界面画得出来的字段（照 smsLogEntry 的收敛原则）。
 * ★ number 必须过 callNumberOk：这条通路能把内容写进设备文件，
 *   不校验就等于开一条「往 /etc/mt5700 塞任意字符串」的路子。
 * ★ result 是白名单枚举，不是自由文本；duration 钳到 [0, DUR_MAX]。
 * ★ time 客户端可传（前端在通话结束时上报本地时间），缺失或非法时补 time()。
 * ★ 兼容厂商口径（modemwebui-server 的 callRecord，2026-10-16 逆向所得）：
 *     · 方向可写成字符串 direction='incoming'|'outgoing'（等价 dir=1|0）
 *     · 结果别名 unanswered ≡ failed（厂商枚举里没有 canceled/rejected，
 *       但有 unanswered —— 收敛到本项目的 failed，读侧再统一展示）
 *   注意**只做入参兼容**：落盘仍用本项目的 canonical 形态，避免同一份记录
 *   出现两套字段各写一半（那正是"两处名单必须一致"类事故的温床，红线 66）。
 * ★ 落盘额外带 direction 字符串：厂商前端与我们前端都能直接画，不必各自
 *   再维护一份 0/1 → 文案的映射。
 */
function callLogEntry(m) {
	if (type(m) != 'object' || type(m.number) != 'string' || !callNumberOk(m.number)) {
		return null;
	}
	let dir = null;
	if (m.dir != null) {
		dir = int(m.dir);
	} else if (m.direction == 'incoming') {
		dir = 1;
	} else if (m.direction == 'outgoing') {
		dir = 0;
	}
	if (dir != 0 && dir != 1) {
		return null;
	}
	let result = m.result;
	if (result == 'unanswered') {
		result = 'failed';
	}
	if (result == null && m.answered == true) {
		result = 'answered';
	}
	if (result != 'answered' && result != 'missed' && result != 'rejected' &&
	    result != 'canceled' && result != 'failed') {
		return null;
	}
	let dur = int(m.duration);
	if (dur == null || dur < 0) {
		dur = 0;
	}
	if (dur > CALL_LOG_DUR_MAX) {
		dur = CALL_LOG_DUR_MAX;
	}
	let ts = int(m.time);
	if (ts == null || ts <= 0) {
		ts = time();
	}
	return {
		number: m.number, dir: dir,
		direction: (dir == 1) ? 'incoming' : 'outgoing',
		result: result, duration: dur, time: ts
	};
}

function callLogAdd(rec) {
	let e = callLogEntry(rec);
	if (e == null) {
		return { success: false, error: '记录字段非法（number/dir/result 需在白名单内）' };
	}
	let list = callLogRead();
	/* 新的排最前：界面按数组顺序画就是时间倒序 */
	let out = [e];
	for (let i = 0; i < length(list); i++) {
		if (type(list[i]) == 'object') {
			out[length(out)] = list[i];
		}
	}
	if (length(out) > CALL_LOG_MAX) {
		let cut = [];
		for (let i = 0; i < CALL_LOG_MAX; i++) {
			cut[i] = out[i];
		}
		out = cut;
	}
	if (!callLogWrite(out)) {
		return { success: false, error: '写记录失败（/etc/mt5700 不可写？）' };
	}
	return { success: true, added: true, count: length(out) };
}

function callLogClear() {
	if (!callLogWrite([])) {
		return { success: false, error: '清空记录失败' };
	}
	return { success: true, cleared: true };
}

return {
	mt5700: {
		at: {
			args: { cmd: '' },
			call: function (req) {
				let a = req.args;
				let cmd = getStr(a, 'cmd');
				if (cmd == null || cmd == '') {
					return { success: false, error: '缺少参数 cmd' };
				}
				/*
				 * 长度上限：最长的是短信 PDU（70 个 UCS2 字符 ≈ 280 个十六进制
				 * 字符，长短信再分几条），4096 留了十倍余量，正常业务绝不会触到。
				 * 拦的是异常输入 —— 它会被写进临时文件、经 nc 打到模组，
				 * 没有上限时一条请求就能把串口堵上好几秒。
				 */
				if (length(cmd) > 4096) {
					return { success: false, error: 'AT 命令过长（上限 4096 字节）' };
				}
				return atCallCached(cmd);
			}
		},
		/*
		 * 批量只读查询（2026-09-25 P20 性能专项）。
		 *
		 * 起因：一条 AT 从浏览器到模组再回来约 100ms，而其中绝大部分**不在串口上**——
		 * 是 HTTP / rpcd / ucode / `nc 127.0.0.1` 这一路的固定开销。网络状态页一轮
		 * 三十余次调用，实测串行 20 条就要 2150ms，而同样的 20 条在本机 ubus 里
		 * 逐条跑只要约 800ms（这里每一条仍是同一个 atCallCached，没有新通道）。
		 * 于是把「一轮里要问的那些只读命令」合成一次 HTTP 请求，只是在 ucode 内部
		 * 逐条转发，省掉的就是那部分重复的路费。
		 *
		 * ★ 三条边界（这是它能被放心用的前提）：
		 *   ① **只放行只读查询**（batchReadable），写命令一律原样退回并计数；
		 *   ② 有上限：条数 AT_BATCH_MAX、单条长度 AT_BATCH_CMD_MAX（与 at 同口径）；
		 *   ③ 逐条独立：某条失败不影响其它条，结果按**入参顺序**返回，每条都带
		 *      自己的 cmd，前端可以据此核对有没有错位。
		 */
		at_batch: {
			args: { cmds: [] },
			call: function (req) {
				let a = req.args;
				let list = (a != null) ? a.cmds : null;
				if (list == null) {
					return { success: false, error: '缺少参数 cmds（字符串数组）' };
				}
				let n = length(list);
				if (n == 0) {
					return { success: false, error: '参数 cmds 为空' };
				}
				if (n > AT_BATCH_MAX) {
					return {
						success: false,
						error: '一次最多 ' + AT_BATCH_MAX + ' 条（收到 ' + n + ' 条）'
					};
				}
				let results = [];
				let refused = 0;
				let skipped = 0;
				/*
				 * ★★ 一旦某条撞上「通道忙」，后面所有条都不必再撞 ——
				 *   后端等空闲通道要 8 秒才回错，N 条就是 N×8 秒，
				 *   而这段全在**一次 ucode 调用**里、rpcd 又是单线程，
				 *   于是整个 LuCI（含新加载的页面）一起冻结。
				 *   见 BUSY_PREFIXES 的注释与 tests/busy-fastfail-contract.test.js。
				 *   注意：剩余条**仍按入参顺序占位**并带上自己的 cmd，
				 *   前端按 cmd 回填，不会错位（at-batch-contract 在守这条）。
				 */
				let busyReason = null;
				for (let i = 0; i < n; i++) {
					let raw = list[i];
					let item = null;
					/*
					 * ★★ 判类型只能用 type()：**本固件的 ucode 里 typeof 返回的是
					 *   值本身，不是类型名**（实测 `typeof 'AT'` → `AT`，
					 *   `typeof [1]` → 数组的字面量），拿它做 `'string'` 比较会
					 *   把**每一条**都判成「不是字符串」—— 2026-09-25 部署后
					 *   20 条命令全部被拒就是这么来的。
					 *   另：`typeof x != 'string'` 还额外触发语法错误（Expecting ')'）。
					 */
					if (raw == null || type(raw) != 'string') {
						item = { cmd: '', success: false, error: '第 ' + (i + 1) + ' 项不是字符串' };
						refused++;
					} else {
						let cmd = trimCmd(raw);
						if (cmd == '') {
							item = { cmd: cmd, success: false, error: '第 ' + (i + 1) + ' 项为空' };
							refused++;
						} else if (length(cmd) > AT_BATCH_CMD_MAX) {
							item = { cmd: cmd, success: false, error: '第 ' + (i + 1) + ' 项过长' };
							refused++;
						} else if (!batchReadable(cmd)) {
							item = { cmd: cmd, success: false, error: '第 ' + (i + 1) + ' 项不是只读查询，已拒绝下发' };
							refused++;
						} else if (busyReason != null) {
							/* 已经确认通道忙：不再消耗 8 秒去撞第二次 */
							item = { cmd: cmd, success: false, error: busyReason, skipped: true };
							skipped++;
						} else {
							let r = atCallCached(cmd);
							if (r == null) {
								item = { cmd: cmd, success: false, error: '后端无应答' };
							} else {
								item = {
									cmd: cmd,
									success: r.success === true,
									data: r.data,
									error: r.error,
									cached: r.cached === true
								};
								if (item.success != true && isBusyText(item.error)) {
									busyReason = item.error;
								}
							}
						}
					}
					results[length(results)] = item;
				}
				if (refused == n) {
					return { success: false, results: results, error: '全部 ' + n + ' 条都被拒绝下发' };
				}
				if (busyReason != null) {
					/*
					 * 明确告诉前端「这一轮是因为通道忙提前收尾的」，
					 * 前端据此开熔断窗口（rpc.js 的 _noteBusy），
					 * 而不是把「没取到」当成「没有」。
					 */
					return {
						success: true, at: time(), count: n, refused: refused,
						skipped: skipped, busy: true, busy_reason: busyReason,
						results: results
					};
				}
				return { success: true, at: time(), count: n, refused: refused, results: results };
			}
		},
		events: {
			args: { since: 0 },
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
				return rpcCall('events', { since: since });
			}
		},
		/* 后端运行日志：服务进程的内存环形缓冲（ubus mt5700.logs）。
		   本服务的 eprintln 输出不进 syslog，拨号对齐 / 串口探测 / URC 分发这些
		   过程只在缓冲里，LuCI「运行日志 → 模组拨号」视图读的就是它。 */
		logs: {
			args: { since: 0, limit: 300 },
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
				return rpcCall('logs', { since: since, limit: limit });
			}
		},
		netrate: {
			args: { device: '' },
			call: function (req) {
				return netrateCall(req);
			}
		},
		/* 断网排查：一次性取回系统侧事实（只读，无参数）。
		   返回 { success, at, facts } —— facts 是 key → 字符串 的扁平映射，
		   判定全部交给前端。 */
		sysdiag: {
			args: {},
			call: function (req) {
				let facts = diagFacts();
				if (facts == null) {
					return {
						success: false,
						error: '系统排查脚本不可用（/usr/share/mt5700/diag-probe.sh 缺失或执行失败）'
					};
				}
				return { success: true, at: time(), facts: facts };
			}
		},
		/* 自愈：只修本插件自己的组件（AT 服务 / rpcd 的 ucode 插件注册），
		   绝不动 network / wireless / firewall —— 自动动作本身不该成为断网源。

		   ★ 手动模式（本方法）只做「重启 AT 服务」：
		     ubus 对象缺失时唯一修法是重启 rpcd，而本方法就跑在 rpcd 里，
		     在那里重启 rpcd 等于让处理本次请求的进程自杀。对象缺失的情况
		     交给 cron 的 `selfheal --auto`（独立进程）。
		   ★ 必须传 --from-ubus：脚本此时跑在 rpcd 里，若它再做 `ubus call`
		     就是让单线程的 rpcd 等自己 —— 必然超时，把「一切正常」误判成故障。
		   ★ 阈值与冷却全在 init.d 的 selfheal() 里，这里只负责触发并回传输出。 */
		selfheal: {
			args: {},
			call: function (req) {
				let p;
				try {
					p = fs.popen('/etc/init.d/at-webserver selfheal --from-ubus', 'r');
				} catch (e) {
					return { success: false, error: '无法执行自愈入口' };
				}
				if (!p) {
					return { success: false, error: '无法执行自愈入口' };
				}
				let out = '';
				let line;
				while ((line = p.read('line')) != null) {
					out += line + '\n';
				}
				p.close();
				return { success: true, output: trim(out) };
			}
		},
		/* 出口 IP 探测：从路由器侧取「互联网看到的我」—— 换卡换 IP 的判定依据。
		   只回原文（端点 id + 响应前 64 字节），解析与合法性校验在前端。
		   bind 可选：绑定到指定源 IP，多出口时用它锁定蜂窝那条链路。 */
		exitip: {
			args: { bind: '' },
			call: function (req) {
				let bind = safeBindIp(getStr(req.args, 'bind'));
				if (bind == null) {
					return { success: false, error: 'bind 不是合法 IPv4 地址' };
				}
				return exitIpFacts(bind);
			}
		},
		/*
		 * VoWiFi 能力评估：按顺序过五道门（卡身份 / IMS 身份 / AKA / ePDG / IMS 注册）。
		 * 无参数 —— 域名由后端从 IMSI 自己拼，DNS 与对照域名都是常量。
		 * 返回 { success, traceId, identity, aka, epdg, ims, stages[], blockers[], phase, verdict }，
		 * 只给事实与逐门结论，文案与排版在前端。
		 * ★ 全程只读：这台设备的蜂窝是唯一上行，任何关射频 / 停数据的动作都是断网。
		 */
		vowifi: {
			args: {},
			call: function (req) {
				return vowifiFacts(time() + 30);
			}
		},
		/*
		 * VoWiFi 开关：enable=1 开 / =0 关，动作是 AT^IMSSWITCH（本机 IMS 域能力）。
		 * ★ 参数只有 0/1 两种取值，其它一律报错 —— 不接收命令片段、域名、通道号，
		 *   没有任何注入面。
		 * ★ 本地三门不过时**拒绝下发**并回 blockers（「不能开启则告知原因」）。
		 * 返回 { success, enable, applied, refused, effective, unknown, imsswitch, blockers, facts }
		 *   —— applied=false + refused=true 表示「没下发，原因见 blockers」。
		 */
		vowifi_set: {
			args: { enable: 0 },
			call: function (req) {
				let v = getStr(req.args, 'enable');
				if (v == null) {
					return { success: false, error: '缺少 enable 参数（0=关，1=开）' };
				}
				/*
				 * ★ 只认数字 0/1，且**不写缺省值**（缺省 0 就是「关 IMS」这种有后果的动作）。
				 * ★★ 真机实测（2026-09-24）：上面 `args: { enable: 0 }` 声明的是整型，
				 *   rpcd 会在进 ucode **之前**把字符串 '1' 与布尔 true 一律以
				 *   code=2（Invalid argument）拒掉 —— 所以这里不需要（也拿不到）其它形态，
				 *   前端必须传 `enable ? 1 : 0`。这条由契约测试与变异守卫钉住。
				 */
				let enable = -1;
				if (v === 1) {
					enable = 1;
				} else if (v === 0) {
					enable = 0;
				}
				if (enable < 0) {
					return { success: false, error: 'enable 只能是 0 或 1' };
				}
				return vowifiSet(enable);
			}
		},
		es9p: {
			args: { host: '', path: '', body: '', probe: 0 },
			call: function (req) {
				let a = req.args;

				/* probe=1：只探测通道可用性，不发任何网络请求 */
				if (a.probe) {
					let ok = es9pToolAvailable();
					return {
						success: true,
						available: ok,
						error: ok ? '' : '设备上没有 curl，无法访问 SM-DP+ 服务器'
					};
				}

				let host = safeHost(getStr(a, 'host'));
				if (host == null) {
					return { success: false, error: '主机地址不合法（必须是域名，不接受 IP）' };
				}
				let path = getStr(a, 'path');
				if (path == null || !es9pPathAllowed(path)) {
					return { success: false, error: '路径不在 ES9+ 白名单内' };
				}
				let body = getStr(a, 'body');
				if (body == null || body == '') {
					return { success: false, error: '缺少请求体' };
				}
				/* BPP 最大也就几十 KB，256KB 足够，顺手挡住异常输入 */
				if (length(body) > 262144) {
					return { success: false, error: '请求体过大（上限 256KB）' };
				}
				/* jsonParse 解析失败返回 null（本固件 ucode 不支持 throw，
				 * 见 jsonParse 头部注释） */
				if (jsonParse(body) == null) {
					return { success: false, error: '请求体不是合法 JSON' };
				}
				if (!es9pToolAvailable()) {
					return { success: false, error: '设备上没有 curl，无法访问 SM-DP+ 服务器' };
				}
				return es9pPost(host, path, body);
			}
		},

		/*
		 * 已发短信记录（跨浏览器可见的唯一真源，落在 /etc/mt5700/sms-sent.json）。
		 *
		 *   action='list'  → { success, messages: [...] }
		 *   action='add'   → entry = JSON 字符串（单条对象或数组）→ 追加后回全量
		 *   action='del'   → id = 记录编号 → 删该条后回全量
		 *   action='clear' → 清空
		 *
		 * ★ entry 走「JSON 字符串」而不是结构化参数：rpcd 只按 args 的声明做前置
		 *   类型校验，对象/数组形态根本传不进来；统一成字符串由这里自己解析，
		 *   与 es9p 的 body 同一套路。
		 * ★ 写盘失败必须回 success:false —— 记录没落盘却报成功，下次刷新用户会
		 *   以为「又丢了」，那正是这个功能要解决的毛病（红线 23 的同构要求）。
		 */
		smslog: {
			args: { action: '', entry: '', id: 0 },
			call: function (req) {
				let a = req.args;
				let action = getStr(a, 'action');
				if (action == null || action == '') {
					return { success: false, error: '缺少参数 action（list/add/del/clear）' };
				}

				if (action == 'list') {
					return { success: true, messages: smsLogRead() };
				}

				if (action == 'clear') {
					if (!smsLogWrite([])) {
						return { success: false, error: '写入已发记录失败（设备存储不可写）' };
					}
					return { success: true, messages: [] };
				}

				if (action == 'del') {
					let id = getStr(a, 'id');
					if (id == null) {
						return { success: false, error: '缺少参数 id' };
					}
					let list = smsLogRead();
					let kept = [];
					let removed = 0;
					for (let i = 0; i < length(list); i++) {
						if (type(list[i]) == 'object' && list[i].id == id) {
							removed = removed + 1;
						} else {
							kept[length(kept)] = list[i];
						}
					}
					if (!removed) {
						return { success: false, error: '没有找到该条已发记录（可能已被删除）' };
					}
					if (!smsLogWrite(kept)) {
						return { success: false, error: '写入已发记录失败（设备存储不可写）' };
					}
					return { success: true, messages: kept, removed: removed };
				}

				if (action == 'add') {
					let raw = getStr(a, 'entry');
					if (raw == null || raw == '') {
						return { success: false, error: '缺少参数 entry' };
					}
					let incoming = null;
					try {
						incoming = jsonParse(raw);
					} catch (e) {
						return { success: false, error: 'entry 不是合法 JSON' };
					}
					let batch = (type(incoming) == 'array') ? incoming : [incoming];
					if (length(batch) > 200) {
						return { success: false, error: '一次最多追加 200 条' };
					}
					let list = smsLogRead();
					let nextId = smsLogNextId(list);
					let added = 0;
					for (let i = 0; i < length(batch); i++) {
						let e = smsLogEntry(batch[i]);
						if (e == null) { continue; }
						e.id = nextId;
						nextId = nextId + 1;
						list[length(list)] = e;
						added = added + 1;
					}
					if (!added) {
						return { success: false, error: 'entry 里没有合法的短信记录' };
					}
					/* 超出上限丢最旧的：这是日志，最近发过的才有意义 */
					if (length(list) > SMS_LOG_MAX) {
						let keep = [];
						let from = length(list) - SMS_LOG_MAX;
						for (let k = from; k < length(list); k++) {
							keep[length(keep)] = list[k];
						}
						list = keep;
					}
					if (!smsLogWrite(list)) {
						return { success: false, error: '写入已发记录失败（设备存储不可写）' };
					}
					return { success: true, messages: list, added: added };
				}

				return { success: false, error: '未知的 action：' + action };
			}
		},
		/*
		 * 语音通话：dial / answer / hangup / dtmf / status / info / log*。
		 *
		 * ★ 为什么自成方法而不是让前端直接发 AT：号码是**用户输入**，而它会
		 *   原样进 AT 命令行。放前端拼就等于给 AT 通道开一个注入面（分号可
		 *   分隔多条命令）。收敛到这里之后，号码与 DTMF 码都只过白名单
		 *   （callNumberOk / callDtmfOk），命令串在本文件拼装。
		 * ★ 命令集（手册第 4 章 3GPP + 第 12 章鼎桥私有 URC）：
		 *     dial     ATD<number>;   （分号＝语音呼叫，真机 2026-10-16 实测可用）
		 *     answer   ATA            （手册 4.2）
		 *     hangup   ATH            （单路挂断；多方时逐路断，手册 4.3；来电时即拒接）
		 *     mute     AT+CMUT=0/1    （麦克风静音，通话中生效）
		 *     dtmf     AT+VTS=<d>     （通话中送 DTMF，手册 4.7）
		 *     status   AT+CLCC        （手册 5.11，返回全部在途呼叫，附 stage 令牌）
		 *     info     CMUT? + CLVL?  （麦克风静音 + 扬声器音量，按需查询不进轮询）
		 *     loglist / logadd / logclear
		 *                             （通话记录，落 /etc/mt5700/call-log.json）
		 *
		 * ★★ 本方法的**方法论来源**：H5000M「带电话功能beta」
		 *   官方固件里的 modemwebui-server（Go，2026-10-16 逆向）。它把
		 *   通话拆成：voicePreparation（拨号前准备）+ 状态机 + 通话记录 +
		 *   跨页来电通知，前端只做展示。移植时**只搬结构与语义，不搬命令**：
		 *   厂商的 voicePreparation 写的是 Quectel 私有的
		 *   AT+QCALLCFG="voice_disable",0 与 AT+QCFG="ims"，MT5700M-CN
		 *   手册里没有这两条 —— 盲目照搬就是给模组发未定义命令（红线 27）。
		 * ★ 状态机由前端轮询 status 驱动：CLCC 的 <state> 字段给全了
		 *   dialing/alerting/active/incoming，不需要改 Rust、不需要开任何
		 *   周期上报（^CURC 掩码未真机验证前不启用，避免开错位把
		 *   ^DSFLOWRPT 之类的常驻上报放出来 —— 红线 22）。
		 *   来电瞬间通知走既有 incoming_call 推送（urc.rs 的 RING/+CLIP）。
		 * ★★ 本机**没有音频硬件**（实测：无 /dev/snd、无 /proc/asound、dmesg
		 *   无音频驱动、模组 USB 无 audio class 接口、设备树无 sound/i2s 节点）。
		 *   模组语音音频的出口是它自己的 PCM 引脚（CLVL 读到 7 ⇒ 车载 PCM 模式），
		 *   主机侧只有 4 个 AT 串口 —— 语音流**不可能**到浏览器。
		 *   所以本模块提供的是「通话管理台」（拨号/接听/挂断/状态/记录），
		 *   不是软电话；音频需外接硬件。详见 README 与页面提示条。
		 */
		call: {
			args: { action: '', number: '', digit: '', record: '' },
			call: function (req) {
				let a = req.args;
				let action = getStr(a, 'action');
				if (action == null || action == '') {
					return { success: false, error: '缺少参数 action' };
				}
				if (action == 'status') {
					return callStatus();
				}
				if (action == 'info') {
					return callLineInfo();
				}
				if (action == 'loglist') {
					return { success: true, action: action, records: callLogRead() };
				}
				if (action == 'logclear') {
					return callLogClear();
				}
				if (action == 'logadd') {
					/*
					 * ★ record 走**JSON 字符串**而不是对象参数：与 smslog 的 entry
					 *   同一约定（ubus 的 args schema 声明为字符串，对象在传输层
					 *   容易被展平/丢弃）。解析失败明确报错，不当成空记录。
					 */
					let raw = getStr(a, 'record');
					if (raw == null || raw == '') {
						return { success: false, action: action, error: '缺少参数 record（JSON 字符串）' };
					}
					let rec = null;
					try {
						rec = jsonParse(raw);
					} catch (e) {
						return { success: false, action: action, error: 'record 不是合法 JSON' };
					}
					return callLogAdd(rec);
				}
				if (action == 'answer') {
					return callDo('answer', 'ATA');
				}
				if (action == 'hangup') {
					return callDo('hangup', 'ATH');
				}
				if (action == 'dial') {
					let num = getStr(a, 'number');
					if (num == null || num == '') {
						return { success: false, action: action, sent: false, error: '缺少参数 number' };
					}
					if (!callNumberOk(num)) {
						return {
							success: false, action: action, sent: false,
							error: '号码含非法字符（只允许 0-9、*、# 与开头的 +）'
						};
					}
					return callDo('dial', 'ATD' + num + ';');
				}
				if (action == 'mute') {
					/*
					 * 麦克风静音（AT+CMUT）。digit 只收 '0'/'1' —— 不接收任意
					 * 取值再拼进 AT 命令，参数面越窄越好。
					 */
					let v = getStr(a, 'digit');
					if (v != '0' && v != '1') {
						return {
							success: false, action: action, sent: false,
							error: 'mute 只接受 digit=0（取消静音）或 1（静音）'
						};
					}
					return callDo('mute', 'AT+CMUT=' + v);
				}
				if (action == 'dtmf') {
					let d = getStr(a, 'digit');
					if (!callDtmfOk(d)) {
						return {
							success: false, action: action, sent: false,
							error: 'DTMF 码只允许单字符 0-9、A-D、*、#'
						};
					}
					return callDo('dtmf', 'AT+VTS=' + d);
				}
				return {
					success: false,
					error: '未知 action（支持 dial/answer/hangup/mute/dtmf/status/info/loglist/logadd/logclear）'
				};
			}
		}
	}
};
