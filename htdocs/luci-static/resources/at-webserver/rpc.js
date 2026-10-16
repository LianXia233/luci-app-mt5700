'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/parse';
'require rpc';
/* global L, baseclass */

/**
 * AT LuCI RPC 客户端（保持原 ATClient 的 API 面）。
 *
 * 传输链路（LuCI RPC，无 WebSocket）：
 *   LuCI JS → L.rpc.declare('mt5700.at'/'mt5700.events') → rpcd → ucode 插件
 *   （/usr/share/rpcd/ucode/mt5700.uc）→ Rust 后端（127.0.0.1:<port>，TCP newline-JSON）
 *
 * 语义兼容：
 * - sendCommand(cmd) → {success,data,error}，保持 FIFO 顺序（RPC 逐条应答，前端仍串行化）
 * - subscribe/unsubscribe：事件轮询拉取增量（RPC 为请求-响应模型）。
 *   前端认的事件类型与「谁产生」必须一一对得上，名单见 handlePush：
 *   raw_data / new_sms / incoming_call / pdcp_data / urc_data（其中 urc_data 是
 *   **本模块自己**在 dispatchRawData 里用 emitPush 造的，不是后端推的）。
 *
 *   ★ 2026-09-26：名单里原有的 `memory_full` 与 `cellscan` 已删除。
 *     · `memory_full`：后端只把它交给通知通道（日志/企微），**从不**发 WS 事件，
 *       前端这条分支从来收不到东西 —— 死分支。
 *     · `cellscan`：产生方是 Rust 后端为「全网扫频」保留的伪命令通路，而该功能
 *       页面已于 2.3.x 下线、无任何消费方（两个订阅者只处理 urc_data / new_sms）。
 *       后端仍会推，前端不再认，属于按预期丢弃。
 *     两处都见 tests/cellscan-removed-contract.test.js 的钉桩。
 * - 认证：LuCI 登录态由 rpcd 会话/ACL 保证；UCI websocket_auth_key 由 ucode 代理附加，
 *   页面无需输入密钥（原有密钥配置保持兼容）
 */

// rpcd 对象 mt5700 的方法声明（与 root/usr/share/rpcd/ucode/mt5700.uc 对应）
var rpcAt = L.rpc.declare({
	object: 'mt5700',
	method: 'at',
	params: ['cmd'],
	expect: {}
});

/*
 * 批量只读查询（对应 mt5700.uc 的 at_batch）。
 *
 * 存在的唯一理由是把每层的重复路费压到一次请求里：单条 AT 实测约 100ms，其中大头是
 * HTTP / rpcd / ucode / `nc` 这一路的固定开销，而不是串口本身。
 * 把一轮要问的只读命令合成一次请求，在 ucode 里逐条转发，省的就是这笔重复路费
 * （实测：20 条串行 2150ms → 单批次约 800ms）。
 *
 * 后端强制只读白名单，所以这里不存在「被塞进一条写命令」的可能。
 */
var rpcAtBatch = L.rpc.declare({
	object: 'mt5700',
	method: 'at_batch',
	params: ['cmds'],
	expect: {}
});

var rpcEvents = L.rpc.declare({
	object: 'mt5700',
	method: 'events',
	params: ['since'],
	expect: {}
});

/*
 * 接口累计字节数（实时速率数据源）。
 * 由 mt5700.uc 的 netrate 方法直接读 /sys/class/net/<dev>/statistics/，
 * 全程不下发任何 AT 命令，不占用 AT 通道、不干扰模组。
 * 返回 {success, device, rx_bytes, tx_bytes}，速率由调用方按采样差计算。
 */
var rpcNetRate = L.rpc.declare({
	object: 'mt5700',
	method: 'netrate',
	params: ['device'],
	expect: {}
});

/*
 * 断网排查：一次性取回系统侧事实（接口 / 路由 / ARP / 防火墙 / 服务 / USB / 探测）。
 *
 * 后端是 root/usr/share/mt5700/diag-probe.sh（只读采集，输出 key=value），
 * 由 mt5700.uc 的 sysdiag 方法转发。它**只给事实、不做判定** ——
 * 判定与建议全在页面侧的检查项注册表里。
 *
 * ★ 超时给 30s：脚本里三个 ICMP + 一次 DNS + 一次 TCP 握手，最坏约 15s，
 *   ucode 侧限时 25s，这里再留 rpcd 与网络栈的余量。
 *   比 AT 查询慢得多，所以只在用户点「一键排查」时才调（排查本身也不进页面自动跑）。
 */
var rpcSysDiag = L.rpc.declare({
	object: 'mt5700',
	method: 'sysdiag',
	params: [],
	expect: {}
});

/*
 * ES9+ 转发（eSIM profile 下载用）。
 *
 * 浏览器没法直连运营商的 SM-DP+ 服务器：SM-DP+ 不发 CORS 头，跨域会被拦
 * （这正是 lpac / luci-app-epm 都把下载甩给本机二进制的原因）。
 * 这里只让路由器代发一次 JSON POST，APDU 那一半仍在前端完成 ——
 * 走 AT+CGLA（优先）或 AT+CSIM（回退），见 euicc.js 的「APDU 传输层」。
 *
 * 后端的收紧项见 mt5700.uc 的 es9p：只认 https、主机必须是合法 FQDN
 * （拒绝 IP / localhost，防 SSRF）、路径在 5 个 ES9+ 端点白名单内、证书照验。
 */
var rpcEs9p = L.rpc.declare({
	object: 'mt5700',
	method: 'es9p',
	params: ['host', 'path', 'body', 'probe'],
	expect: {}
});

/*
 * 出口 IP 探测（「换卡换 IP」的判定依据）。
 *
 * ★ 为什么必须绕一圈让路由器去问：判断「互联网看到的我是谁」，只能由**数据链路那一侧**
 *   自己发出去一个请求、看对端认到的源地址。浏览器做不到这件事 —— 打开页面的电脑
 *   未必走这台设备的蜂窝链路，它问到的公网 IP 跟本设备毫无关系。
 *
 * 后端是 mt5700.uc 的 exitip（http 回显，端点写死白名单，不接受外部传入 URL），
 * 只回原文；IP 的解析与合法性校验在这里的 Parse.parseExitIpBody 完成。
 *
 * bind 用来锁定源地址（多出口时防止请求从以太网那条链路出去），传空串表示不绑定。
 */
var rpcExitIp = L.rpc.declare({
	object: 'mt5700',
	method: 'exitip',
	params: ['bind'],
	expect: {}
});

/*
 * VoWiFi 能力评估（卡身份 / IMS 身份 / AKA / ePDG / IMS 注册，五道门）。
 *
 * ★ 无参数是有意为之：域名由后端从 AT+CIMI 读到的 IMSI 自己拼，DNS 服务器与
 *   对照域名都是写死常量。这里一旦开放「传个域名进来查查」，这条通道就变成
 *   登录用户借路由器做任意 DNS 探测的接口 —— 不开这个口子。
 */
var rpcVowifi = L.rpc.declare({
	object: 'mt5700',
	method: 'vowifi',
	params: [],
	expect: {}
});

/*
 * VoWiFi 开关：只传一个 0/1。
 *
 * ★ 参数表只有 enable 一项，且后端只接受 0/1（其它一律报错）—— 命令本身
 *   （AT^IMSSWITCH=…）由后端拼，前端没有把任何字符串送进 AT 通道的路径。
 */
var rpcVowifiSet = L.rpc.declare({
	object: 'mt5700',
	method: 'vowifi_set',
	params: ['enable'],
	expect: {}
});

/*
 * 已发短信记录（设备端文件，跨浏览器可见的唯一真源）。
 *
 * ★ 为什么不能留在浏览器：localStorage 是**浏览器**的私有空间，换浏览器 /
 *   清缓存 / 换电脑打开页面就一条不剩。而「这台设备发出过什么」是所有浏览器
 *   都该看到同一份的事实，只能落在设备上。
 *
 * ★ 三个参数都是必需的：rpcd 按 args 的声明做**前置**类型校验（挡在 ucode
 *   之前），id 声明的是整型，传字符串会被 code=2 直接拒掉 —— 所以 del 时
 *   必须传数字，不能传 String(id)。
 *   entry 是 JSON 字符串（后端自己解析），与 es9p 的 body 同一套路。
 */
var rpcSmsLog = L.rpc.declare({
	object: 'mt5700',
	method: 'smslog',
	params: ['action', 'entry', 'id'],
	expect: {}
});

/*
 * 语音通话：dial / answer / hangup / dtmf / status。
 *
 * ★ number 与 digit 都只是白名单内的短串（后端 callNumberOk / callDtmfOk 再校验），
 *   命令串（ATD…; / ATA / ATH / AT+VTS=… / AT+CLCC）全部由后端拼 ——
 *   前端没有把任意字符串送进 AT 通道的路径。
 * ★ 老设备（rpcd 里没有 mt5700.call）时 response 为 undefined，由 fetchCall
 *   统一翻成 success:false + 明确文案（与 vowifi/smslog 同一约定）。
 */
var rpcCall = L.rpc.declare({
	object: 'mt5700',
	method: 'call',
	params: ['action', 'number', 'digit', 'record'],
	expect: {}
});

function withTimeout(p, ms, msg) {
	/*
	 * ★ P11（2026-09-19 会审）：竞速胜出后清掉另一路的定时器。
	 * 原来是 Promise.race([p, guard])，p 胜出后 guard 的 setTimeout 仍挂到 ms 到期 ——
	 * 每条 AT 命令都会留下一个最长 14 秒的悬空定时器，稳态下长期挂着二十几个。
	 * 这是**等价改写**（只消除悬空定时器），不声称任何性能提升。
	 */
	var h = null;
	var guard = new Promise(function (resolve, reject) {
		h = setTimeout(function () { reject(new Error(msg || '请求超时')); }, ms);
	});
	var clear = function () { if (h != null) { clearTimeout(h); h = null; } };
	return Promise.race([
		Promise.resolve(p).then(function (v) { clear(); return v; },
			function (e) { clear(); throw e; }),
		guard
	]);
}

function ATClient() {
	this.connected = false;
	this.authenticated = true;       // RPC 模式：登录态由 LuCI/rpcd 会话保证
	this.requireAuth = false;
	this.authKey = '';
	/*
	 * 单条命令的前端等待上限。后端最坏 13s（atclient 2s 应答 + 8s 排队 + 3s 写入），
	 * 这里给 14s 留 1s 余量。APDU 透传类命令另有更宽的预算，见 isApduCommand。
	 */
	this.commandTimeout = 14000;
	this.subscribers = [];            // 推送订阅者
	this.stateCallbacks = [];
	this.state = 'idle';
	this.error = null;
	this.commandQueue = Promise.resolve();
	this.pollTimer = null;
	this.pollInterval = 1500;         // 事件轮询间隔（毫秒）
	/*
	 * ★ 2026-09-30：事件游标必须**持久化**。原先只存在内存里，刷新页面后从 0 重新拉取，
	 *   服务端就把缓冲里的历史事件（含旧的 `+CMTI`）整批重投一遍。真机探针（[DEBUG-7f3a]）
	 *   抓到的调用栈证明这正是「已读短信刷新后又变未读」的触发源：
	 *     push → newSmsHandler → 把早已读过的短信标成 unread → buildContacts 算成未读。
	 *   首轮 `firstPoll` 只跳过"本次会话的第一次轮询"，挡不住后续往返，也挡不住重连。
	 *   游标持久化后，刷新是**续读**而不是重放；服务端重启导致序号回退时，
	 *   下一次响应里的 seq 会被采纳（下方 self.eventSeq = seq），可自愈。
	 */
	this.eventSeq = (function () {
		try {
			var v = parseInt(localStorage.getItem('mt5700_events_seq') || '0', 10);
			return (isFinite(v) && v > 0) ? v : 0;
		} catch (e) { return 0; }
	})();
	this.firstPoll = true;
	this.host = '127.0.0.1';
	this.port = 8765;
	this.configReady = this.loadConfig();
}

ATClient.prototype.setConnectionState = function (state, err) {
	this.state = state;
	this.error = err || null;
	for (var i = 0; i < this.stateCallbacks.length; i++) {
		try { this.stateCallbacks[i](state, this.error); } catch (e) { /* 回调异常不影响主流程 */ }
	}
};

ATClient.prototype.isReady = function () {
	return this.connected;
};

/* ---------- 配置加载（保留 UCI 键语义；host 仅记录不再用于直连） ---------- */

ATClient.prototype.loadConfig = function () {
	var self = this;
	return L.uci.load('at-webserver').then(function () {
		var port = parseInt(L.uci.get('at-webserver', 'config', 'websocket_port') || '8765', 10) || 8765;
		var authKey = L.uci.get('at-webserver', 'config', 'websocket_auth_key') || '';
		var bind = L.uci.get('at-webserver', 'config', 'websocket_bind') || '';
		var allowWan = L.uci.get('at-webserver', 'config', 'websocket_allow_wan') === '1';
		if (!bind) {
			bind = allowWan ? '0.0.0.0' : '127.0.0.1';
		}
		self.port = port;
		self.bind = bind;
		self.host = bind;
		self.requireAuth = !!authKey;
		self.authKey = authKey;
		return self.port;
	}).catch(function (err) {
		self.port = 8765;
		self.bind = '127.0.0.1';
		self.host = '127.0.0.1';
		return self.port;
	});
};

/* ---------- 连接管理（RPC 模式下为逻辑连接） ---------- */

ATClient.prototype.connect = function () {
	if (this.isReady()) {
		this.setConnectionState('connected');
		return Promise.resolve(true);
	}
	var self = this;
	this.setConnectionState('connecting');
	return this.configReady.then(function () {
		self.connected = true;
		self.authenticated = true;
		self.firstPoll = true;
		self.reconnectAttempts = 0;
		self.setConnectionState('connected');
		if (self.subscribers.length) self.startPolling();
		return true;
	});
};

ATClient.prototype.disconnect = function () {
	this.clearPendingCommands('连接已手动断开');
	this.stopPolling();
	this.connected = false;
	this.authenticated = false;
	this.setConnectionState('disconnected');
	return Promise.resolve();
};

ATClient.prototype.reconnect = function () {
	var self = this;
	if (this.connected) return Promise.resolve();
	this.setConnectionState('reconnecting');
	return this.connect().catch(function () {});
};

/* ---------- 事件轮询 ---------- */

ATClient.prototype.startPolling = function () {
	var self = this;
	if (this.pollTimer) return;
	this.pollTimer = setInterval(function () { self.pollEvents(); }, this.pollInterval);
};

ATClient.prototype.stopPolling = function () {
	if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
};

ATClient.prototype.pollEvents = function () {
	var self = this;
	if (!this.connected) return;
	withTimeout(rpcEvents(this.eventSeq), 6000, '事件轮询超时').then(function (resp) {
		if (!self.connected) return;
		resp = resp || {};
		var seq = typeof resp.seq === 'number' ? resp.seq : self.eventSeq;
		var events = Array.isArray(resp.events) ? resp.events : [];
		self.eventSeq = seq;
		// ★ 持久化游标：刷新后续读，不再重放历史事件（见构造函数里的说明）
		try { localStorage.setItem('mt5700_events_seq', String(seq)); } catch (e) {}
		if (self.firstPoll) {
			// 首次连接只对齐序号，不重放服务启动前的事件（与原 WS 连接语义一致）
			self.firstPoll = false;
			return;
		}
		/*
		 * 事件分发必须自己兜住异常。
		 * handlePush → dispatchRawData → Parse.parseRawData 解析的是模组上报的
		 * 原始行，格式稍有出入就可能抛异常。若不在这里拦住，异常会冒泡到下面
		 * 的 catch，被当成「RPC 调用失败」——于是解析一个 URC 失败就会把整个
		 * 插件置为离线、停掉轮询、3 秒后重连，期间所有 AT 命令都只回
		 * 「未连接到调制解调器」。故障性质完全被误判，排查时会往网络方向找。
		 * 单条事件解析失败只应影响这一条事件，不该掀翻整条连接。
		 */
		for (var i = 0; i < events.length; i++) {
			try {
				self.handlePush(events[i]);
			} catch (e) {
				if (typeof console !== 'undefined' && console.warn) {
					console.warn('[mt5700] 事件处理异常，已跳过：', e);
				}
			}
		}
	}).catch(function (err) {
		if (self.connected && (err && err.message !== '事件轮询超时')) {
			self.setConnectionState('error', 'RPC 调用失败: ' + (err.message || err));
			self.connected = false;
			self.stopPolling();
			// rpcd/Rust 恢复后自动重连（有订阅者时）
			setTimeout(function () { self.reconnect(); }, 3000);
		}
	});
};

ATClient.prototype.handlePush = function (ev) {
	if (!ev || typeof ev.type !== 'string') return;
	if (ev.type === 'raw_data' && typeof ev.data === 'string') {
		this.dispatchRawData(ev.data);
		return;
	}
	if (['incoming_call', 'new_sms', 'pdcp_data', 'urc_data'].indexOf(ev.type) >= 0) {
		this.emitPush({ success: true, type: ev.type, data: ev.data });
	}
};

/* ---------- 命令发送（RPC，逐条独立应答） ---------- */

/*
 * 超时预算说明（对应「AT 终端只有 ATI 有回复」的修复）：
 * 后端把「排队等空闲通道」与「等模组应答」拆成了两段独立预算
 * （QUEUE_WAIT_TIMEOUT 8s + COMMAND_TIMEOUT 2s），最坏耗时约 10s。
 * 前端若仍用 8s，会在后端真正返回结果之前先报「命令执行超时」，
 * 把「模组无响应」和「后端还在排队」混为一谈。故前端放宽到 14s，
 * 留出网络与 rpcd 代理余量，让用户看到后端给出的准确原因。
 */
/*
 * 判断一条命令是否「可安全重试」。
 *
 * 本模组偶发单次 ERROR / 无响应（同一命令再发一次往往就正常），因此读类命令
 * 失败后自动重试若干次；写类命令绝不重试——重复下发可能造成重复操作
 * （例如短信重复发送、锁频命令重复生效）。
 */
/*
 * 不带 '?' 的纯读命令。
 *
 * 这里与下面 IDENTIFIER_COMMANDS / STATE_COMMANDS 一起构成「读命令」的完整名单，
 * 判断的是同一件事 —— 这条命令**没有副作用**，失败可以再发一次、结果可以缓存。
 * 三份名单必须集中在一处由 isRetryableRead 统一引用：早先这里和分档缓存各抄了一份，
 * 结果 IMEI / IMSI / 型号 / 固件（AT+CGSN / AT+CIMI / AT+CGMM / AT+CGMR）只进了
 * 缓存名单、没进重试名单，于是它们既拿不到 10 分钟缓存，还会走 sendCommand 的
 * 写命令分支 —— 每查一次 IMEI 就把状态类缓存全清一遍，分档等于白做。
 *
 * ★ 2026-09-26 补漏（`tools/audit-at-reads.py` 扫出来的，逐条对照技术手册）：
 *   一次性漏了四条**明确是查询**的命令，它们被当成写命令，于是
 *     ① 不缓存（每次刷新都打串口）② 不重试（偶发 ERROR 直接变红叉）
 *     ③ 不受忙态熔断保护（通道忙时一条条去撞 8 秒）
 *     ④ **成功后 `_dropStateCache()` 把状态类缓存整片清掉**——这条最隐蔽：
 *        AT+CNUM 每轮刷新都被调一次，等于把 CPIN?/SIMSQ?/CFUN?/CGDCONT? 的缓存全部作废。
 *   手册依据（《MT5700M-CN 5G系列模组AT命令手册》）：
 *     · AT+CGPADDR    7.8  查询 PDP 地址（语法 `AT+CGPADDR=[<cid>[,…]]`，参数可选）
 *     · AT+CNUM       5.26 查询本机号码
 *     · AT+CGEQOSRDP  13.30 读取 EPS QoS 参数（语法同样带可选参数）
 *     · AT+CGMI       3.7  查询制造商信息（ucode 的静态缓存名单里**本来就有它**，
 *                          前端却没有 —— 两边对同一条命令的判断不一致）
 *   真机复核（2026-09-26，只读）：CGPADDR/CGMI/CGEQOSRDP 均正常返回；
 *   CNUM 回 `+CME ERROR: not found`（卡上没写 MSISDN）—— 属**稳定失败**的查询，
 *   靠既有的「自适应降级」在连续两轮后收敛成单次下发，不需要为它开特例。
 */
var NON_QUESTION_READS = [
	'AT+CSQ', 'AT^MONSC', 'AT^MONNC', 'AT^MONSSC', 'AT^DSFLOWQRY',
	'AT+CGPADDR', 'AT+CNUM', 'AT+CGEQOSRDP', 'AT+CGMI'
];

/* 判断一条命令是否「可安全重试」，同时决定它是否可缓存（见 sendCommand）。 */
function isRetryableRead(command) {
	var cmd = String(command == null ? '' : command).trim();
	if (!cmd) return false;
	if (cmd === 'AT' || cmd === 'ATI') return true;
	if (cmd.charAt(cmd.length - 1) === '?') return true;
	var k = normalizeCommand(cmd);
	return NON_QUESTION_READS.indexOf(k) >= 0
		|| IDENTIFIER_SET[k] === true
		|| STATE_SET[k] === true;
}

/*
 * APDU 透传类命令（AT+CSIM / AT+CGLA / 逻辑通道管理）。
 *
 * ★ 它们的等待预算必须比普通命令宽（2026-09-20 真机：eSIM 下载到一半突然中断，
 *   报「模组无响应（已等待 2000ms，收到 4 行不完整数据）」）。
 *   原因：这类命令的耗时由**卡片**决定，模组只是搬运 —— eSIM 写卡时卡侧做密钥
 *   运算与非易失写入，单条跳到秒级是常态，而普通 AT 命令实测只有 130~205ms。
 *   后端对这类命令的应答预算是 APDU_TIMEOUT（默认 12s，UCI apdu_timeout），
 *   若前端还按普通命令的 14s/20s 等，就会在后端仍在等卡的时候先放弃。
 *
 * 预算与后端对齐：wait 30s（> 排队 8s + 应答 12s + 余量）、budget 45s（对齐 ucode
 * 的 `timeout 45 nc`）。两者都只放宽「上限」，不改变任何命令的语义。
 */
var APDU_WAIT_MS = 30000;
var APDU_BUDGET_MS = 45000;

function isApduCommand(command) {
	var c = String(command == null ? '' : command).trim();
	return /^AT\+(CSIM|CGLA|CCHO|CCHC|CCHP)\b/i.test(c);
}

/*
 * 模组把错误当普通文本返回时的判定（ERROR / +CME ERROR / +CMS ERROR）
 *
 * ★ 必须**行锚定**且**不带 /i**。早期写法
 *     /(^|[\s\r\n])(ERROR|\+CME ERROR|\+CMS ERROR)/i
 *   的分隔符含 `\s`（空格也算），于是应答**正文**里的英文单词一样会命中：
 *   Text 模式（CMGF=1）下 `AT+CMGL=4` 返回的一条短信正文含 "error"，
 *   整份短信列表就被当成「命令失败」，界面表现为列表空白、日志里还查不到 ERROR。
 *
 *   行锚定 + 去掉 /i 后：
 *     "My network error again"        → 不命中（前面是空格，不是行首）
 *     "\r\nERROR\r\n"                 → 命中
 *     "\r\n+CME ERROR: 10\r\n"        → 命中（错误码后可跟任意说明文字）
 *   守卫见 tests/at-error-text-contract.test.js。
 */
function isErrorText(data) {
	if (data == null) return false;
	var txt = String(data);
	return /(^|[\r\n])[ \t]*(ERROR|\+CME ERROR|\+CMS ERROR)(:[^\r\n]*)?[ \t]*(?=[\r\n]|$)/.test(txt);
}

/*
 * 通道忙（busy）类失败 —— 前端必须认识它们，且**绝不能重试**
 * ============================================================================
 * 后端有三条「忙」应答，共同点：**重试毫无意义，只会排到更长的队尾**。
 *   · `等待空闲通道超时（8s）：模组正忙或正在重连，请稍后重试`
 *       出处 src/rust/src/atclient.rs（QUEUE_WAIT_TIMEOUT 的报错）
 *   · `模组正在发送短信，请稍候再试`        出处 rpcserver.rs
 *   · `正在扫频，模组暂时无法响应其它命令，请先取消扫频`  出处 rpcserver.rs
 *
 * 为什么必须特殊处理（真机 + 源码双重取证，2026-09-26）：
 *   后端**自己**早就为这类情况定了范式（rpcserver.rs:430-443）：忙时**立即失败返回**，
 *   注释原话「否则每个查询都要等满排队预算，一页十几个查询叠加起来就是『界面加载不出来』」。
 *   但前端原来一条都不认识 → 走普通失败 → `isRetryableRead()` 让 `?` 结尾的查询**重试 3 次**，
 *   而每次重试都要重新 `cmd_mu.lock()` 排队 8 秒 → 单条命令最坏烧掉 20 秒（预算上限），
 *   且 `commandQueue` 是**全局单链**：这 20 秒里本页其它命令、其它页面全部排队等待。
 *   → 用户看到「一片空白 / 新加载一个页面加载不出来」。
 *
 * 判据用「文案前缀」而不是全等：后端带格式化参数（`（{}s）`）。
 * ★ 改动后端文案时必须同步这里 —— tests/busy-fastfail-contract.test.js 会拦。
 */
var BUSY_PATTERNS = [
	'等待空闲通道超时',
	'模组正在发送短信',
	'正在扫频，模组暂时无法响应其它命令'
];

function isBusyError(msg) {
	if (msg == null) return false;
	var s = String(msg);
	if (!s) return false;
	for (var i = 0; i < BUSY_PATTERNS.length; i++) {
		if (s.indexOf(BUSY_PATTERNS[i]) >= 0) return true;
	}
	return false;
}

/*
 * 忙态熔断窗口。
 *
 * 取 8 秒 = 与后端 QUEUE_WAIT_TIMEOUT 同量级：后端等不到空闲通道要 8 秒才回错，
 * 在它给出下一个错误之前，前端再发多少次都是白排。所以窗口内**只读查询**
 * 直接快速失败（不发请求），页面立刻渲染出「模组正忙」而不是干等一片空白。
 *
 * 只作用于只读查询：**写命令照常下发**（读不到 ≠ 不许保存，熔断不能拦掉用户的操作），
 * `{fresh:true}` 同样放行（调用方明确要新值）。
 *
 * 窗口过期**自动半开放行一条探针**（不需要额外状态机）：
 *   · 探针成功 → 立刻解除熔断（不必再等一个窗口）；
 *   · 探针仍失败 → 重新武装（不会变成无限探针风暴）。
 */
const BUSY_COOLDOWN_MS = 8000;
ATClient.prototype._busyUntil = 0;
ATClient.prototype._busyReason = '';

ATClient.prototype._noteBusy = function (msg) {
	this._busyUntil = Date.now() + BUSY_COOLDOWN_MS;
	this._busyReason = msg || '';
};

/* 供页面显示「模组忙」提示用；不忙时返回 null。 */
ATClient.prototype.busyState = function () {
	if (Date.now() >= this._busyUntil) return null;
	return { reason: this._busyReason, until: this._busyUntil };
};

function delayMs(ms) {
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/*
 * 只读命令结果短时缓存
 * ----------------------------------------------------------------------------
 * 串口是独占资源，同一条只读查询被打两次（同一刷新周期内多个卡片各查一遍）
 * 或页面短时间来回切换时，缓存能直接省掉整条 AT 往返。
 *
 * 只缓存「只读查询」——由 isRetryableRead() 判定（AT/ATI、以 ? 结尾、
 * 以及少数不带 ? 的查询命令）。写命令、终端手动执行的命令一律不缓存。
 *
 * 默认 2500ms：比 5 秒的自动刷新略短，保证每轮刷新至少拿到一次新值，
 * 又足以吃掉同一轮里重复的查询。调用方可用 { fresh: true } 强制绕过。
 */
const READ_CACHE_TTL = 2500;
const READ_CACHE_MAX = 64;
ATClient.prototype._readCache = null;

/*
 * 缓存时长分档
 * ----------------------------------------------------------------------------
 * 一刀切 2500ms 时，缓存只在「同一轮刷新内去重」有用；而页面每 5~30 秒刷新
 * 一次，绝大多数查询都命中不了，像 IMEI 这种一辈子不变的值也被反复重查
 * （实测每条往返 240~300ms，7 条就是近 2 秒的纯等待）。
 *
 * 因此按「值本身多久会变」分三档。判据不是采样——采样会被 ^MONSC 这种
 * 「3 秒内恰好没变、实际随时会变」的命令骗到（实测它就曾被判成恒定），
 * 而是命令所读对象的物理属性：
 *
 *   ① IDENTIFIER（10 分钟）：读的是烧在模块里 / 刻在 SIM 卡上的标识。
 *      IMEI/SVN/MAC 在模块 EEPROM，IMSI/ICCID 在 SIM 卡，型号与固件版本由
 *      硬件与当前刷写的版本决定——除非换模块、换卡或升级固件，否则不会变。
 *      真机连查两次结果完全一致（356938035643809 / 460001234567890 等）。
 *      10 分钟上限是为了换卡后能自愈：换卡后最迟 10 分钟拿到新 IMSI。
 *
 *   ② STATE（15 秒）：会变，但只在用户主动操作后才变（插拔卡、切飞行
 *      模式、改 PIN）。比刷新周期(30s)短，保证每轮慢档刷新能拿到真实状态，
 *      又能吃掉页面来回切换时的重复查询。
 *      注意边界：^SYSINFOEX（系统模式/服务域）看起来像状态，但它会在
 *      5G↔4G 重选时**自行**变化，不属于「用户操作后才变」，故不进这一档。
 *
 *   ③ 其余一律 2500ms：信号、流量、温度这类连续量，一轮一查。
 *
 * 失败结果不缓存（_cachePut 只收 success）：本模组存在偶发单次 ERROR
 * （实测 AT^SYSINFOEX? 两次里有一次 ERROR），若把失败也缓存起来，一次
 * 偶发就会变成「持续显示失败」，比多等一次往返的代价大得多。
 */
var CACHE_TTL_IDENTIFIER = 10 * 60 * 1000;
var CACHE_TTL_STATE = 15 * 1000;

/* 物理标识类：模块/卡上写死，会话内不会变 */
var IDENTIFIER_COMMANDS = [
	'AT+CGSN',      /* IMEI */
	'AT+CIMI',      /* IMSI */
	'AT^ICCID?',    /* ICCID */
	'AT+CGMM',      /* 模块型号 */
	'AT+CGMR',      /* 固件版本 */
	'AT^PHYNUM?',   /* IMEI / MAC / SVN */
	'AT^VERSION?',  /* 各组件版本 */
	'ATI',          /* 厂商与模块标识 */
	/*
	 * ★ 2026-09-28 新增：IPv6 能力由 **NV 项**定制、会话内不会变。
	 *   手册 16.7.2 自己写着「**后台启动时**，调用此 AT 查询当前 MT 的 IPV6 能力」，
	 *   16.7.1 则说明「IPV6 能力配置数据由 NV 项定制」。也就是说它是**能力**，
	 *   不是状态 —— 与本清单「模块/卡上写死」的定义完全吻合。
	 *
	 *   而 network_status.js 的慢档（30s 一轮）此前每轮都真问它一次：按实测
	 *   一条 AT 往返 ≈100ms，等于每轮白搭 100ms、每小时 120 条串口往返。
	 *   它原本落在默认 2.5s 档，2.5s < 30s 的轮询间隔 ⇒ 缓存等于不存在。
	 *   （对照：AT^DHCPV6? 是**状态**，会随拨号变化，不能进这一档。）
	 */
	'AT^IPV6CAP?'   /* IPv6 能力：NV 定制，会话内不变 */
];

/* 状态类：只在用户操作后变化 */
var STATE_COMMANDS = [
	'AT+CPIN?',         /* SIM 锁状态 */
	'AT^SIMSQ?',        /* SIM 状态 */
	'AT+CFUN?',         /* 射频开关 */
	'AT+CLCK?',         /* PIN 锁开关 */
	'AT+CGDCONT?',      /* PDP 上下文 */
	'AT+CSCA?'          /* 短信中心号 */
];

var IDENTIFIER_SET = {};
IDENTIFIER_COMMANDS.forEach(function (c) { IDENTIFIER_SET[c] = true; });
var STATE_SET = {};
STATE_COMMANDS.forEach(function (c) { STATE_SET[c] = true; });

/* 命令归一化：忽略大小写与首尾空格，去掉重复空格 */
function normalizeCommand(command) {
	return String(command == null ? '' : command).trim().toUpperCase().replace(/\s+/g, '');
}

function cacheTtlFor(command) {
	var k = normalizeCommand(command);
	if (IDENTIFIER_SET[k]) return CACHE_TTL_IDENTIFIER;
	if (STATE_SET[k]) return CACHE_TTL_STATE;
	return READ_CACHE_TTL;
}

ATClient.prototype._cacheGet = function (command) {
	var c = this._readCache;
	if (!c) return null;
	var k = normalizeCommand(command);   /* 归一化只算一次（原来命中/过期两条路各算一遍） */
	var hit = c[k];
	if (!hit) return null;
	if (Date.now() - hit.t > cacheTtlFor(command)) {
		delete c[k];
		return null;
	}
	hit.hits = (hit.hits || 0) + 1;
	return hit.value;
};

ATClient.prototype._cachePut = function (command, value) {
	if (!value || value.success !== true) return;   /* 只缓存成功结果 */
	if (!this._readCache) { this._readCache = {}; this._cacheOrder = []; }
	var k = normalizeCommand(command);
	if (this._readCache[k]) {
		this._readCache[k] = { t: Date.now(), value: value, hits: 0 };
		return;
	}
	/*
	 * 淘汰改由 _cacheOrder（插入序数组）驱动，不再每次 put 都 Object.keys + sort：
	 * put 在**每条 AT 应答后**都跑一次，而满仓时原实现要把全部 key 排序一遍
	 * （O(n log n)/次）。插入序数组让淘汰变成「从队头丢几个」，O(淘汰个数)。
	 */
	var i;
	while ((i = this._cacheOrder.indexOf(k)) >= 0) this._cacheOrder.splice(i, 1);
	this._readCache[k] = { t: Date.now(), value: value, hits: 0 };
	this._cacheOrder.push(k);
	while (this._cacheOrder.length > READ_CACHE_MAX) {
		delete this._readCache[this._cacheOrder.shift()];
	}
};

ATClient.prototype.cacheStats = function () {
	var c = this._readCache || {};
	var n = 0, h = 0;
	Object.keys(c).forEach(function (k) { n++; h += (c[k].hits || 0); });
	return { entries: n, hits: h };
};

ATClient.prototype.clearReadCache = function () {
	this._readCache = null;
	this._cacheOrder = [];
};

/*
 * ★ P20（2026-09-25 性能专项）：**注定了要失败的命令，别再重试三次。**
 *
 * 实测（模拟浏览器经 /ubus）：成功的一条 AT 往返约 100ms，而只读命令最多
 * 重试三次、每次失败还要退避 `200ms × attempt`，于是**注定失败**的一条命令
 * 实际要烧掉 `100 + 200 + 100 + 400 + 100 ≈ 900ms` —— 九倍成本。
 * 本机正好有四类命令在特定状态下稳定返回 ERROR：
 *
 *   AT^SIMST?       ^SIMST 是**主动上报 URC**，根本没有查询语法
 *   AT^SYSINFOEX?   手册 13.1 写的语法是 `AT^SYSINFOEX`（**不带问号**）
 *   AT^SYSINFO      手册里没有这条命令
 *   AT^NRSSBID?     要 NR 连接态且网侧配了测量才有值，其余情况 +CME ERROR
 *
 * 它们不是某个页面偶发的抖动：网络状态页一轮三十余次调用全是串行，
 * 几条稳定失败的老命令就能把整轮拖长好几秒。
 *
 * 为什么是「自适应降级」而不是把 maxAttempts 改成 1：
 * 本模组存在**偶发**单次 ERROR（AT^HCSQ? / AT^MONSC 实测都遇到过一次即过），
 * 一次性砍掉重试会让一次偶然抖动直接变成界面上一个红叉。这里的规则是：
 *
 *   同一条命令**连续两轮**都没翻过身 → 认定它当前就是不支持，后续每轮只发一次；
 *   任意一次成功 → 立刻复位（否则一次偶发就被永久降级，等于把偶发失败钉死）。
 *
 * 判据是「同一条命令」：normalizeCommand 归一化后的 key，按键互不影响。
 * 队列本身是串行的，key 的读写不会被两条命令同时踩到。
 */
const RETRY_ATTEMPTS_DEFAULT = 3;      /* 常规重试次数（首次遇见失败时的容忍度） */
const RETRY_DOWNGRADE_STREAK = 2;      /* 连续失败到第几轮开始降级 */

/* 预热一次最多问几条：与后端 AT_BATCH_MAX 对齐 */
const WARM_CACHE_MAX = 40;
/* 预热的整体等待上限：后端逐条转发 40 条约需 1.6s（每条 40ms），给足余量 */
const WARM_CACHE_WAIT_MS = 12000;

/*
 * 批量预热读缓存（2026-09-25 P20 性能专项）。
 *
 * 想法很简单：一轮刷新要问的那批只读命令，**一次性**问回来，塞进本文件既有的
 * 读缓存，然后各自的卡片照旧用 sendCommand 去读——此时每一条都命中缓存，
 * 整轮的串口往返从「N 次 HTTP」压成「1 次 HTTP」。
 *
 * ★ 三条约束（决定了它能不能被放心用）：
 *   ① **只预热本来就会被缓存的命令**（isRetryableRead 判定，与 sendCommand
 *      的 cacheable 同源）。带 { fresh: true } 的调用天然绕过缓存，预热对它无效，
 *      也就不会破坏「这一项必须拿实时值」的语义。
 *   ② **失败结果绝不入缓存** —— 走的是同一个 `_cachePut`，它只收 success。
 *      否则一次偶发 ERROR 会被固化成「持续显示失败」（见 at-cache-contract 第 ③ 条）。
 *   ③ 预热失败必须**不阻断**后续任何逻辑，但也**不能静默**：失败计数与最后一次
 *      原因记在 _warmFailures / _warmError 上，可用 warmStats() 查。
 *
 * 返回值：成功写进缓存的条数（0 表示这次预热没帮上忙，走原路径，安全）。
 */
ATClient.prototype.warmCache = function (commands) {
	var self = this;
	var list = [];
	(commands || []).forEach(function (c) {
		if (isRetryableRead(c)) { list.push(c); }
	});
	if (!list.length) { return Promise.resolve(0); }
	if (list.length > WARM_CACHE_MAX) { list = list.slice(0, WARM_CACHE_MAX); }
	/*
	 * ★ 忙态时不要发批次（2026-09-26）。
	 * batch 在 ucode 里是**逐条**转发的：撞上忙态时后端每条都要等满 8 秒，
	 * 而这一整段跑在**一次** ucode 调用里、rpcd 又是单线程 —— 整个 LuCI
	 * （含新加载的页面）会跟着冻结。后端的 at_batch 已经会在撞到忙时提前收尾，
	 * 但更省事的是**根本别发**：直接返回 0，让各卡片走自己的 sendCommand
	 * （那时会命中 sendCommand 里的忙态快速失败，同样是瞬时的）。
	 */
	if (Date.now() < this._busyUntil) {
		this._warmFailures = (this._warmFailures || 0) + 1;
		this._warmError = this._busyReason || '模组正忙，跳过本轮预热';
		return Promise.resolve(0);
	}
	return withTimeout(rpcAtBatch(list), WARM_CACHE_WAIT_MS, '批量预热超时')
		.then(function (resp) {
			resp = resp || {};
			/*
			 * 后端在撞到忙态时会提前收尾并带 busy 标记（见 mt5700.uc 的 BUSY_PREFIXES）。
			 * 这里据此开熔断窗口，让本轮剩下的卡片直接快速失败，
			 * 而不是各自再去撞一次 8 秒。
			 */
			if (resp.busy === true) {
				self._noteBusy(resp.busy_reason || '模组正忙，请稍后重试');
			}
			var n = 0;
			var arr = resp.results || [];
			for (var i = 0; i < arr.length; i++) {
				var it = arr[i];
				/*
				 * 后端按顺序返回，但**位置不对就是数据错位** —— 以每条自带的 cmd
				 * 为准回填，宁可少缓存一条，也不把别人的应答当成它的。
				 */
				if (it && it.success === true && it.cmd) {
					self._cachePut(it.cmd, { success: true, data: it.data });
					n++;
				}
			}
			return n;
		})
		.catch(function (err) {
			self._warmFailures = (self._warmFailures || 0) + 1;
			self._warmError = (err && err.message) || '批量预热失败';
			return 0;
		});
};

ATClient.prototype.warmStats = function () {
	return { failures: this._warmFailures || 0, error: this._warmError || null };
};

ATClient.prototype._currentFailStreak = function (command) {
	if (!this._failStreak) return 0;
	return this._failStreak[normalizeCommand(command)] || 0;
};

/* 记账：成功清零、失败累加；返回累加后的连续失败轮数 */
ATClient.prototype._noteFailStreak = function (command, succeeded) {
	var k = normalizeCommand(command);
	if (!isRetryableRead(command)) return 0;   /* 写命令没有重试，不参与降级 */
	if (succeeded) {
		if (this._failStreak) delete this._failStreak[k];
		return 0;
	}
	if (!this._failStreak) this._failStreak = {};
	var n = (this._failStreak[k] || 0) + 1;
	this._failStreak[k] = n;
	return n;
};

/*
 * 只丢掉「状态类」缓存。
 * 写命令（改 PIN、切飞行模式、改 PDP、改短信中心号）执行成功后，被它改动的
 * 那些状态查询可能已经失效；物理标识类不受影响，没必要一起丢。
 */
ATClient.prototype._dropStateCache = function () {
	var c = this._readCache;
	if (!c) return;
	Object.keys(c).forEach(function (k) {
		if (STATE_SET[normalizeCommand(k)]) delete c[k];
	});
};

ATClient.prototype.sendCommand = function (command, opts) {
	var self = this;
	var opt = opts || {};
	var cacheable = !opt.fresh && isRetryableRead(command);
	if (cacheable) {
		var cached = this._cacheGet(command);
		if (cached) return Promise.resolve(cached);
	}
	/*
	 * ★ 忙态快速失败（见 BUSY_COOLDOWN_MS 的注释）。
	 * 位置放在**缓存命中之后**：熔断期间手里已有的旧值仍然照给，
	 * 比「因为忙就什么都不给」对用户更有用，也没有任何陈旧风险上的变化
	 * （缓存本来就有自己的 TTL）。
	 */
	var readOnly = isRetryableRead(command);
	if (readOnly && !opt.fresh && Date.now() < this._busyUntil) {
		return Promise.resolve({
			success: false,
			error: this._busyReason || '模组正忙，请稍后重试',
			busy: true,
			quickFail: true
		});
	}
	/*
	 * 重试次数的默认值不再是一个常数（见 RETRY_DOWNGRADE_STREAK 的注释）：
	 * 同一条命令连续失败两轮之后，每轮只发一次，成功即复位。
	 * 调用方显式传了 attempts 时以调用方为准，降级逻辑不插手。
	 */
	var maxAttempts = opt.attempts != null
		? opt.attempts
		: (!isRetryableRead(command)
			? 1
			: (self._currentFailStreak(command) >= RETRY_DOWNGRADE_STREAK
				? 1
				: RETRY_ATTEMPTS_DEFAULT));
	/*
	 * ★ P04（2026-09-19 会审）：给单条命令加总预算。
	 * 后端最坏 13s（atclient 2s 应答 + 8s 排队 + 3s 写入）、ucode 侧 `timeout 45 nc` 兜底；
	 * 而前端原本 3 次重试 × 14s ≈ 42.6s —— 其中约 29s 是后端早已放弃之后的纯空等，
	 * 并且 commandQueue 是全局单链，这段时间本页快/慢档、其它页面、用户手动刷新
	 * 的全部 AT 都排在它后面。默认 20000；调用方可传 opt.budgetMs 覆盖。
	 * APDU 透传类命令走更宽的 APDU_BUDGET_MS（见 isApduCommand 的注释）。
	 */
	var apdu = isApduCommand(command);
	var budget = opt.budgetMs != null ? opt.budgetMs : (apdu ? APDU_BUDGET_MS : 20000);
	var waitCap = apdu ? APDU_WAIT_MS : self.commandTimeout;
	var t0 = Date.now();

	this.commandQueue = this.commandQueue.then(function () {
		var attempt = 0;
		/*
		 * ★ 出队时**再查一次**熔断（2026-09-26，浏览器 A/B 实测补的）。
		 *
		 * 入队时的那次检查挡不住「同一条 `Promise.all` 里已经排好队的命令」：
		 * 一页十几条命令几乎都是同一 tick 里并发排进来的，它们**全部**通过了入队检查，
		 * 等轮到自己执行时通道早已被判忙 —— 于是照样一条条去撞 8 秒。
		 * 实测（真机浏览器 + 网络层中间人注入忙态，12 秒窗口）：
		 *   只做入队检查 → 忙态下仍下发 12 次；补上出队检查后才收敛到个位数。
		 * 命令一旦被判失败就立刻返回，等于把「排队等死」变成「排到才知道，且瞬间知道」。
		 */
		if (readOnly && !opt.fresh && Date.now() < self._busyUntil) {
			return {
				success: false,
				error: self._busyReason || '模组正忙，请稍后重试',
				busy: true,
				quickFail: true
			};
		}
		var attemptOnce = function () {
			attempt++;
			if (!self.connected) return { success: false, error: '未连接到调制解调器' };
			/* 第一次必发；此后预算用尽就不再重试 —— 不再空等后端已放弃的窗口 */
			if (attempt > 1 && (Date.now() - t0) >= budget) {
				return { success: false, error: '命令总预算已用尽（' + budget + 'ms）' };
			}
			var waitMs = Math.max(1000,
				Math.min(waitCap, budget - (Date.now() - t0)));
			return withTimeout(rpcAt(command), waitMs,
				'命令执行超时（模组可能正忙或正在重连，请稍后重试）').then(function (resp) {
				resp = resp || {};
				if (resp.success === false || isErrorText(resp.data)) {
					var emsg = resp.error || '命令执行失败';
					/*
					 * ★ 忙态：**不重试**（见 BUSY_PATTERNS 的注释）。重试只是重新排 8 秒的队，
					 * 而全局 commandQueue 会把这 8 秒×N 转嫁给整页与其它页面。
					 */
					if (isBusyError(emsg)) {
						self._noteBusy(emsg);
						return { success: false, error: emsg, busy: true };
					}
					if (attempt < maxAttempts) {
						return delayMs(200 * attempt).then(attemptOnce);
					}
					return { success: false, error: emsg };
				}
				/* 通道确实通了 —— 解除熔断（探针成功即恢复） */
				self._busyUntil = 0;
				self._busyReason = '';
				return { success: true, data: resp.data };
			}).catch(function (err) {
				var msg = (err && err.message) || '命令执行失败';
				/* 前端侧超时文案里也带「模组可能正忙…」，同样按忙态处理 */
				if (isBusyError(msg)) {
					self._noteBusy(msg);
					return { success: false, error: msg, busy: true };
				}
				if (attempt < maxAttempts) {
					return delayMs(200 * attempt).then(attemptOnce);
				}
				return { success: false, error: msg };
			});
		};
		return attemptOnce();
	});
	if (cacheable) {
		return this.commandQueue.then(function (res) {
			self._cachePut(command, res);
			self._noteFailStreak(command, !!(res && res.success));
			return res;
		});
	}
	/*
	 * 写命令：执行成功后丢掉状态类缓存。原先这里还有一个
	 * `invalidateReadCache()`（整仓清缓存）供页面手动调，但**全仓库零调用点**，
	 * 而写命令路径已经自动 `_dropStateCache()` 兜底 —— 留着只会让人以为
	 * 「记得手动清一下」是必经步骤。已删除；需要整仓清时用 clearReadCache()。
	 */
	return this.commandQueue.then(function (res) {
		if (res && res.success) self._dropStateCache();
		self._noteFailStreak(command, !!(res && res.success));
		return res;
	});
};

ATClient.prototype.clearPendingCommands = function (err) {
	// RPC 模式下无挂起 FIFO；保留函数以兼容调用点
	void err;
};

/* ---------- 订阅 ---------- */

ATClient.prototype.subscribe = function (cb) {
	if (this.subscribers.indexOf(cb) < 0) {
		this.subscribers.push(cb);
		if (this.connected) this.startPolling();
	}
};

ATClient.prototype.unsubscribe = function (cb) {
	var i = this.subscribers.indexOf(cb);
	if (i >= 0) this.subscribers.splice(i, 1);
	if (!this.subscribers.length) this.stopPolling();
};

ATClient.prototype.emitPush = function (resp) {
	for (var i = 0; i < this.subscribers.length; i++) {
		try { this.subscribers[i](resp); } catch (e) { console.error(e); }
	}
};

ATClient.prototype.onConnectionStateChange = function (cb) {
	this.stateCallbacks.push(cb);
	cb(this.state, this.error);
	/*
	 * 返回退订函数。
	 *
	 * 此前只进不出：每个页面进来都 push 一个闭包，闭包又持有该页的 DOM 节点，
	 * 于是进十次页面就积累十个永不回收的回调；而 connect() 在已就绪时仍会
	 * setConnectionState('connected')，每次渲染都会把历史回调全部触发一遍 ——
	 * 它们各自去更新一堆早已脱离文档的节点。
	 */
	var self = this;
	var detached = false;
	return function () {
		if (detached) return;
		detached = true;
		var i = self.stateCallbacks.indexOf(cb);
		if (i >= 0) self.stateCallbacks.splice(i, 1);
	};
};

ATClient.prototype.dispatchRawData = function (text) {
	var self = this;
	var parsed = parseRawData(text);
	for (var i = 0; i < parsed.length; i++) {
		self.emitPush({ success: true, type: 'urc_data', data: parsed[i] });
	}
};

ATClient.prototype.setConnection = function (host, port) {
	// RPC 模式下连接由 LuCI/rpcd 决定，仅记录参数保持兼容
	this.host = String(host || '').replace(/^\[|\]$/g, '');
	this.port = parseInt(port, 10) || this.port;
	try {
		localStorage.setItem('atHost', this.host);
		localStorage.setItem('atPort', String(this.port));
	} catch (e) { /* ignore */ }
	return Promise.resolve();
};

/* ================= UCI 保存/应用编排 =================
 *
 * 背景（问题一）：本应用原先在页面里直接连续调用
 *     L.uci.set(...) → L.uci.save() → L.uci.apply()
 * 这条链路存在三个与 OpenWrt 标准「保存及应用」流程不一致的地方：
 *
 *   1) 缺少「未保存更改的确认」。OpenWrt 的 CBI 表单在离开页面时会提示
 *      「有未保存的更改」，本应用的自定义 E() 表单没有挂到该机制上，
 *      用户改完不点保存直接切页，改动静默丢失，表现为「保存了但没生效」。
 *
 *   2) set/save/apply 三段各自独立，任何一段失败都只是整体 reject，
 *      无法区分「写内存失败」「落盘失败」「reload 失败」，用户看到的是
 *      一句笼统的「保存失败」。
 *
 *   3) reload 触发依赖 apply() 内部生成的配置 hash。当 at-webserver 的
 *      UCI 变更 hash 与上一次相同（例如只改了 service.js 里不写盘的派生
 *      项），rpcd 的 apply 会因为「无待应用变更」直接返回 ubus 状态码 5
 *      (NO_DATA)，前端把它当成失败——实际上配置已经生效。
 *
 * 本模块把上述流程收敛为一处，对外只暴露 uciSave(section) 与
 * uciHasChanges(section)，语义与 LuCI 的「保存并应用」按钮一致。
 */
var AtUci = {
	// 已注册「未保存更改」提示的页面数
	_dirty: false,
	_beforeUnload: null,
	_dirtyFlush: [],

	// 标记当前页面存在未保存更改，并在离开时提示（等价 LuCI 自带行为）
	markDirty: function () {
		if (this._dirty) return;
		this._dirty = true;
		this._beforeUnload = function (ev) {
			if (!AtUci._dirty) return undefined;
			ev.preventDefault();
			ev.returnValue = '';
			return '';
		};
		window.addEventListener('beforeunload', this._beforeUnload);
	},

	// 清除未保存标记（保存/应用成功、或用户主动放弃时调用）
	clearDirty: function () {
		this._dirty = false;
		if (this._beforeUnload) {
			window.removeEventListener('beforeunload', this._beforeUnload);
			this._beforeUnload = null;
		}
	},

	isDirty: function () { return this._dirty; },

	// 查询该配置是否存在待应用变更（rpcd uci.changes）
	uciHasChanges: function (section) {
		return L.uci.changes(section).then(function (changes) {
			return Array.isArray(changes) ? changes.length > 0 : !!changes;
		}).catch(function () {
			// changes 不可用时不阻断主流程，按「有变更」处理
			return true;
		});
	},

	/**
	 * 保存并应用（等价 CBI 底部「保存并应用」按钮）。
	 * 返回 { applied: bool, saved: bool, appliedSkipped: bool }
	 */
	uciSave: function (section, opts) {
		var options = opts || {};
		var result = { saved: false, applied: false, appliedSkipped: false, changes: null };

		return this.uciHasChanges(section).then(function (has) {
			result.changes = has;
			if (!has && options.skipWhenClean !== false) {
				// 无待应用变更：不需要 save/apply，直接视为已生效
				result.saved = true;
				result.appliedSkipped = true;
				return result;
			}
			return L.uci.save(section).then(function () {
				result.saved = true;
				return L.uci.apply(false, true);
			}).then(function () {
				result.applied = true;
				return result;
			}, function (err) {
				// ubus 状态码 5 = NO_DATA：rpcd 未收到待应用数据，通常表示
				// 变更已在上一轮 commit，配置实际已生效，不视为失败。
				var code = err && err.code;
				var msg = (err && err.message) || '';
				if (code === 5 || /未收到数据|No data|NO_DATA/i.test(msg)) {
					result.applied = true;
					result.appliedSkipped = true;
					return result;
				}
				throw err;
			});
		});
	},

	/**
	 * commit 型保存：仅落盘，不触发服务 reload。
	 * 用于「服务配置」这类自身不作为 reload 触发源、而由页面显式重载的场景。
	 */
	uciCommit: function (section) {
		var result = { saved: false, applied: false, appliedSkipped: false };
		return this.uciHasChanges(section).then(function (has) {
			if (!has) {
				result.saved = true;
				result.appliedSkipped = true;
				return result;
			}
			return L.uci.save(section).then(function () {
				result.saved = true;
				// append=true 表示「保存并应用」，会走 rpcd 的 commit+apply 全流程，
				// 从而正确记录 config hash 并触发 procd reload。
				return L.uci.apply(false, true);
			}).then(function () {
				result.applied = true;
				return result;
			}, function (err) {
				var code = err && err.code;
				var msg = (err && err.message) || '';
				if (code === 5 || /未收到数据|No data|NO_DATA/i.test(msg)) {
					result.applied = true;
					result.appliedSkipped = true;
					return result;
				}
				throw err;
			});
		});
	}
};

/* ================= 解析工具 ================= */

function extractATData(data, command) {
	var m = data.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*([^\\r\\n]+)'));
	return m ? m[1] : null;
}

function extractATDataMultiline(data, command) {
	var re = new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.+)');
	return data.split('\n')
		.map(function (line) { var m = line.match(re); return m ? m[1].trim() : null; })
		.filter(Boolean);
}

function convertRsrp(raw) { return raw === 0 ? -140 : (raw >= 97 ? -44 : -140 + raw); }
function convertRsrq(raw) { return raw === 0 ? -19.5 : (raw >= 34 ? -3 : -19.5 + raw * 0.5); }
function convertRssi(raw) { return raw === 0 ? -120 : (raw >= 96 ? -25 : -121 + raw); }

/*
 * SINR 步进 0.2 dB（一位小数），但 0.2 不是二进制有限小数：
 * `-20 + 146 * 0.2` 在 JS 里是 9.200000000000003，而界面是 `sinr + ' dB'`
 * 直接拼串 —— 尾数会原样显示给用户（RSRP/RSRQ/RSSI 都是整数或 0.5 步进，
 * 二进制能精确表示，不需要这一步）。所以换算出口统一收到一位小数，
 * 下游（文本 / 仪表 / 邻区表）拿到的都是干净值，不用各自 toFixed。
 */
function round1(v) { return Math.round(v * 10) / 10; }
function convertSinr(raw) {
	var v = raw === 0 ? -20 : (raw >= 251 ? 30 : -20 + raw * 0.2);
	return round1(Math.min(30, Math.max(-20, v)));
}

/*
 * 百分比只在这里算一次：量程与等级判定都在 Parse（见 parse.js 的「信号语义」段）。
 * 此前这里另用 -110~-70 量程，与 mt5700.js 的 -120~-70 打架 —— 同一个 RSRP
 * 在「网络设置」与「运行状态」两个页面给出两个百分比（-90 dBm：50% vs 60%）。
 * 本函数只负责 Parse 给的数字 → 带 % 的展示串（取不到给空串，由调用方渲染成「—」）。
 */
function calculateSignalPercent(rsrp) {
	var pct = Parse.signalPercent(rsrp);
	return pct == null ? '' : pct + '%';
}

function parseHexValue(hexStr) { return parseInt(hexStr, 16) || 0; }

function hexToIP(hex) {
	if (!hex || typeof hex !== 'string') return '0.0.0.0';
	var clean = hex.trim().replace(/[\r\n]/g, '');
	if (!/^[0-9A-Fa-f]+$/.test(clean)) return '0.0.0.0';
	if (clean.length !== 8) clean = clean.padStart(8, '0').substring(0, 8);
	var bytes = [];
	for (var i = 0; i < 8; i += 2) bytes.push(parseInt(clean.substring(i, i + 2), 16) || 0);
	while (bytes.length < 4) bytes.push(0);
	return bytes.reverse().join('.');
}

function parseTemperature(v) {
	var n = typeof v === 'number' ? v : parseInt(v, 10);
	if (n >= 65535 || isNaN(n) || n > 1500) return 0;
	return parseFloat((n / 10).toFixed(1));
}

function formatFlow(bytes) {
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
	if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
	if (bytes < 1099511627776) return (bytes / 1073741824).toFixed(2) + ' GB';
	return (bytes / 1099511627776).toFixed(2) + ' TB';
}

/*
 * 已删除 formatSpeed / splitSpeed（2026-09-28 全量审查）。
 * 全仓（htdocs / root / src / tests）grep `formatSpeed` 与 `splitSpeed` 只有
 * 「本文件定义 + 本文件导出」两处，**零消费点**；同族的 formatFlow 仍在用，
 * 说明速率展示后来改走了别的路径。属于死代码，按本仓惯例删除。
 */

function formatDuration(seconds, showDays) {
	if (showDays) {
		var d = Math.floor(seconds / 86400);
		var h = Math.floor((seconds % 86400) / 3600);
		var m = Math.floor((seconds % 3600) / 60);
		return d + '天' + h + '时' + m + '分' + (seconds % 60) + '秒';
	}
	var h2 = Math.floor(seconds / 3600);
	var m2 = Math.floor((seconds % 3600) / 60);
	return h2 + '时' + m2 + '分' + (seconds % 60) + '秒';
}

/*
 * 已删除本文件私有的 NR_BANDS / LTE_BANDS 与 bandName（2026-09-28 全量审查）。
 *
 * 它们与 parse.js 的 `Parse.NR_BANDS` / `Parse.LTE_BANDS` **同名且并存**，但
 * 实际在用的是 parse.js 那套（network_settings.js:159 与 schedule.js:132 都写的是
 * `Parse.NR_BANDS` / `Parse.LTE_BANDS`）；本文件这套 `{ key: label }` 一个消费点都没有。
 * 两套同名表并存正是「改了一处、另一处纹丝不动」的温床，故整块删除。
 */

/* ---- ^HCSQ / 信号 ---- */

function parseHCSQ(data) {
	/*
	 * ★ NSA(EN-DC) 下 `AT^HCSQ?` 会回 **两行**（2026-09-29 真机）：
	 *     ^HCSQ: "LTE",81,73,146,24     ← LTE 锚点
	 *     ^HCSQ: "NR",68,176,30         ← NR 辅载波
	 *   而 extractATData 只取**第一行**，所以这里恒按 LTE 解析。
	 *   本机这套是**自洽**的、不是 bug：布局由该行自己的 <sysmode> 选
	 *   （LTE 比 NR 前面多一个 RSSI，SINR/RSRQ 位置也不同，混用会两项全错），
	 *   不会串位；调用方 fillSignalFromHCSQ 还要求 networkMode 与 ^MONSC 的
	 *   sysMode 一致，NSA 下两边都是 LTE，补空缺的语义仍然成立。
	 *   ⚠ 改这里之前先想清楚：若改成「优先取 NR 行」，上面那条一致性守卫会
	 *   立刻不成立（'NR' !== 'LTE'）→ 4G 下 SINR 永远补不上、界面留「—」。
	 */
	var str = extractATData(data, '^HCSQ');
	if (!str) return null;
	var p = str.split(',');
	var mode = p[0] ? p[0].replace(/"/g, '').trim() : '';
	var networkMode;
	if (mode.indexOf('NR') === 0) networkMode = 'NR';
	else if (mode.indexOf('LTE') === 0) networkMode = 'LTE';
	else if (mode.indexOf('WCDMA') === 0) networkMode = 'WCDMA';
	else networkMode = mode || '';
	/*
	 * 工程值字段缺位 / 非数字时一律为 null。
	 * convert*(NaN) 会原样返回 NaN（NaN 不 ===0、也不 >= 阈值，直接进线性公式），
	 * 而 NaN 会一路传到界面：信号条变成 `width:NaN%`、仪表盘显示 NaN。
	 */
	var eng = function (v, conv) {
		var n = parseInt(v, 10);
		if (!isFinite(n)) return null;
		/*
		 * ★ 手册 13.5.3 的四张换算表（rssi / rsrp / sinr / rsrq）都以
		 *   `255 未知或不可测` 结尾 —— 而线性公式会把它算成"信号最好"：
		 *   rsrp 255 命中 >=97 钳位得 -44、sinr 255 命中 >=251 得 30、
		 *   rsrq 255 命中 >=34 得 -3。于是模组明确说"测不出来"时，
		 *   界面反而显示满格，比不显示更误导。这里统一按未知处理
		 *   （返回 null → 由调用方渲染成「—」）。
		 *   后端 src/rust/src/urc.rs 的 eng_value() 同步做同一件事。
		 */
		if (n === 255) return null;
		var out = conv(n);
		return isFinite(out) ? out : null;
	};
	var result = { networkMode: networkMode, rssi: null, rsrp: null, rsrq: null, sinr: null };
	if (networkMode === 'NR') {
		/*
		 * NR 格式（实测 ^HCSQ: "NR",77,236,31）与 LTE 顺序不同：
		 *   "NR",<5g_rsrp>,<5g_sinr>,<5g_rsrq>
		 * 交叉验证：rsrp 77 → -63 dBm、sinr 236 → 27.2 dB，与 ^MONSC 的
		 * -65 dBm / 28 dB 独立吻合，故按此顺序解析（兼容 3 或 4 数值字段）。
		 */
		if (p.length >= 2) result.rsrp = eng(p[1], convertRsrp);
		if (p.length >= 3) result.sinr = eng(p[2], convertSinr);
		if (p.length >= 4) result.rsrq = eng(p[3], convertRsrq);
	} else if (networkMode === 'LTE') {
		/*
		 * 手册 13.5 的 LTE 字段表（**与 NR 顺序不同**，此前一律按 NR 的
		 * <rsrp>,<sinr>,<rsrq> 套，SINR 与 RSRQ 整个对调）：
		 *   "LTE",<lte_rssi>,<lte_rsrp>,<lte_sinr>,<lte_rsrq>
		 * 即 LTE 比 NR 前面多一个 RSSI，且 **SINR 在 value3、RSRQ 在 value4**
		 * （NR 恰好相反：SINR 在 value2、RSRQ 在 value3）。
		 * 实测 ^HCSQ: "LTE",45,34,106,19 → RSSI -76 / RSRP -106 / SINR 1.2 / RSRQ -10；
		 * 错位时 SINR 吃到的是 RSRQ 的工程值（19 → -16.2 dB），RSRQ 又吃到 SINR 的
		 * 工程值（106 → 被 rsrq 的 34 上限截成 -3），两项同时错。
		 */
		if (p.length >= 2) result.rssi = eng(p[1], convertRssi);
		if (p.length >= 3) result.rsrp = eng(p[2], convertRsrp);
		if (p.length >= 4) result.sinr = eng(p[3], convertSinr);
		if (p.length >= 5) result.rsrq = eng(p[4], convertRsrq);
	} else {
		if (p.length >= 2) result.rssi = eng(p[1], convertRssi);
	}
	return result;
}

/* ---- PS 注册状态 ---- */

function psRegText(stat) {
	/*
	 * 注册态文案统一到 Parse.REG_STATES（3GPP TS 27.007 的 stat 定义）。
	 * 这里原先另有一套 switch：0 号写「未注册，正在搜索」、2 号缀「但允许紧急呼叫」，
	 * 与 parse.js 那张表对不上 —— 同一个 stat 码在不同页面两种说法。
	 * stat 0 的准确含义是「未注册，且当前没在搜网」（正在搜网是 2 号），
	 * 紧急呼叫也不是 2 号的语义。现在以 parse.js 为唯一口径。
	 */
	var t = Parse.REG_STATES ? Parse.REG_STATES[parseInt(stat, 10)] : null;
	return t || '等待状态中';
}

/* ---- 主动上报识别 ---- */

function isUnsolicitedText(text) {
	if (!text) return false;
	if (text === 'RING' || text === 'IRING' || text === '^IRING' || text === 'NO CARRIER') return true;
	return text.indexOf('+CMTI:') === 0 || text.indexOf('^CEND:') === 0 ||
		text.indexOf('^SMMEMFULL') === 0 || text.indexOf('MEMORY FULL') >= 0 ||
		text.indexOf('^REJINFO') === 0 || text.indexOf('^SRVST') === 0 ||
		(text.indexOf('+CUSD:') === 0 && text.indexOf(',') >= 0);
}

/* ---- raw_data 拆分（^PDCPDATAINFO / URC） ---- */

function parseRawData(text) {
	var out = [];
	var re = /\^PDCPDATAINFO:\s*([^\r\n]+)/g;
	/*
	 * 原实现在循环里 `rest.replace(m[0],'')`：每命中一次就把整段报文重新拷一遍，
	 * 周期上报（^PDCPDATAINFO 一帧几十条）时是 O(n²)。改成按匹配下标切片，
	 * 只在最后 join 一次 —— 总拷贝量从 O(n×k) 降到 O(n)。
	 */
	var m, cursor = 0;
	var gaps = [];
	while ((m = re.exec(text)) !== null) {
		gaps.push(text.slice(cursor, m.index));
		cursor = m.index + m[0].length;
		/* 只切分、不再造条目：{type:'PDCP'} 没有任何消费方（见上面 parsePDCP 的删除说明） */
	}
	gaps.push(text.slice(cursor));
	var rest = gaps.join('');
	// 其余 URC
	var lines = rest.split('\n');
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i].trim();
		if (!line) continue;
		if (line.indexOf('^HCSQ:') === 0) {
			out.push({ type: 'HCSQ', raw: line, parsed: parseHCSQ(line) });
		} else if (line.indexOf('^CERSSI:') === 0) {
			out.push({ type: 'CERSSI', raw: line });
		} else if (line.indexOf('^REJINFO') === 0) {
			// 网络拒绝原因主动上报，解析后进 REJINFO 类型
			out.push({ type: 'REJINFO', raw: line, parsed: Parse.parseRejInfo(line) });
		}
		/*
		 * ^SRVST（服务状态）**不再解析分发**：对应功能「服务状态监听」已整块下线
		 * （手册只有设置命令 AT^SRVST=<n>、没有读命令，要看状态就得先开周期上报
		 *   再等模组推 —— 那会在模组里留下常驻上报，是 2.2.1 那类事故的源头）。
		 * 它仍留在上面的 isUnsolicitedText 里：万一有人从 AT 终端手动开过上报，
		 * 这条 URC 也能被正确归类成「非命令响应」，不会被当成某次查询的应答。
		 */
	}
	return out;
}

/* ---- PDCP 14 字段 ---- */

/*
 * 已删除 `parsePDCP` 与 `PDCP_FIELDS`（2026-09-28）。
 *
 * 它们是早期「前端自己解析 ^PDCPDATAINFO」的遗留，有两个问题：
 *   ① **字段解释与真机不符** —— 按 <rx_bytes>,<tx_bytes>,<rx_pkts>,… 读，
 *      而真机（2026-09-28 实测）回的是 <id>,<pduSessionId>,<discardTimerLen>,…
 *      （见 parse.js::parsePdcpDataInfo 与 urc.rs::PDCP_FIELDS，后两者一致）。
 *      即 fields[0] 是 DRB id 却被当成 rx_bytes、fields[12] 是丢包数却被当成
 *      rx_volte_bytes —— 整份数据错位。
 *   ② **产出无人消费** —— parseRawData 造的是 {type:'PDCP'}（大写），而前端订阅者
 *      认的是后端 urc.rs 推的 {type:'pdcp_data'}；全仓 grep 零消费点，
 *      PDCP_FIELDS / downSpeed / upSpeed 同样无人用。
 * 前端展示的 5G 速率与流量走另一条路（fetchNetRate 读 /sys/class/net 计数），
 * 与 ^PDCPDATAINFO 无关。故整块删除；parseRawData 仍会切掉 PDCP 行（见那里）。
 */
/* ---- MONSC ---- */

function parseMONSC(data) {
	var str = extractATData(data, '^MONSC');
	if (!str) return null;
	var p = str.split(',').map(function (s) { return s.trim(); });
	/*
	 * 手册 13.9.3 的字段序（**按 RAT 不同**，此前把三者当成同一套，导致 TAC/频点/PCI 全错位）：
	 *   NR ：<MCC>,<MNC>,<ARFCN-NR>,<SCS>,<Cell_ID>,<PCI>,<TAC>,<RSRP>,<RSRQ>,<SINR>
	 *   LTE：<MCC>,<MNC>,<ARFCN>,<Cell_ID>,<PCI>,<TAC>,<RSRP>,<RSRQ>,<RSSI>   （无 SCS）
	 * 实测 NR：^MONSC: NR,460,00,524910,1,C027F5065,114,14225C,-73,-9,24
	 *    → ARFCN 524910（**SSB 频点**，手册注：与上下行频点可不一致）、SCS 1(30kHz)、
	 *      Cell_ID C027F5065、PCI 0x114=276、TAC 0x14225C=1319516。
	 *      PCI 与 ^NRSSBID 的服务小区 PCI 276 交叉验证一致。
	 * 注意：<PCI> 与 <TAC> 是**十六进制**（LTE/NR 皆然），必须按 hex 解析/展示。
	 */
	/*
	 * 3GPP 的字符串型参数模组会带引号回（实测 `^MONSC` 的 <sysmode> 回 `"NR"`，
	 * 同文件 `^HCSQ` 的解析里就是这么处理的）。若不在入口统一剥掉：
	 *   ① `rat` 变成 '"NR"'，NR / LTE 三个分支全落空，后面的字段整体错位
	 *      —— PCI 会被当成十六进制去解析 Cell_ID，rsrp 拿到 NaN；
	 *   ② 而 NaN 会一路传到界面（信号条宽度变成 `width:NaN%`）。
	 * 在每个分支里各剥一次容易漏，所以在解析入口统一剥。
	 */
	var stripQuote = function (v) {
		return String(v === undefined || v === null ? '' : v).trim().replace(/"/g, '');
	};
	var hexInt = function (v) {
		var s = stripQuote(v);
		if (s === '') return null;
		var n = parseInt(s, 16);
		return isNaN(n) ? null : n;
	};
	var num = function (v) {
		var s = stripQuote(v);
		if (s === '') return null;
		var n = parseFloat(s);
		return isNaN(n) ? null : n;   /* 空串与非数字一律转 null，不让 NaN 往界面传 */
	};
	var hasLeadingMode = p.length > 0 && !/^-?\d+$/.test(stripQuote(p[0]));
	var d;
	if (hasLeadingMode) {
		var rat = stripQuote(p[0]).toUpperCase();
		if (rat === 'NR') {
			d = {
				sysMode: 'NR',
				mcc: p[1] || '', mnc: p[2] || '',
				channel: p[3] || '',                       // ARFCN（SSB 频点）
				scs: hexInt(p[4]),
				cid: p[5] || '',
				pci: hexInt(p[6]),                         // 十六进制
				lac: p[7] || '',                           // TAC（十六进制，展示时转十进制）
				rsrp: num(p[8]), rsrq: num(p[9]), sinr: num(p[10])
			};
		} else if (rat === 'LTE') {
			d = {
				sysMode: 'LTE',
				mcc: p[1] || '', mnc: p[2] || '',
				channel: p[3] || '',
				scs: null,
				cid: p[4] || '',
				pci: hexInt(p[5]),
				lac: p[6] || '',
				rsrp: num(p[7]), rsrq: num(p[8]), sinr: null, rssi: num(p[9])
			};
		} else {
			/* WCDMA 等：手册字段与 LTE 相近（PSC 代替 PCI），按 LTE 位序宽松解析 */
			d = {
				sysMode: rat,
				mcc: p[1] || '', mnc: p[2] || '',
				channel: p[3] || '',
				cid: p[4] || '',
				pci: hexInt(p[5]),
				lac: p[6] || '',
				rsrp: num(p[7]), rsrq: num(p[8]), sinr: null
			};
		}
	} else {
		/* 旧版格式（无前导制式，原始编码值） */
		d = {
			mcc: p[0] || '',
			mnc: p[1] || '',
			lac: p[2] || '',
			cid: p[3] || '',
			pci: hexInt(p[4]),
			channel: p[5] ? p[5].trim() : '',
			rsrp: p[6] !== undefined ? convertRsrp(parseInt(p[6], 10)) : null,
			rsrq: p[7] !== undefined ? convertRsrq(parseInt(p[7], 10)) : null,
			sinr: p[8] !== undefined ? convertSinr(parseInt(p[8], 10)) : null,
			sysMode: p[9] ? p[9].replace(/"/g, '').trim() : ''
		};
	}
	d.signalPercent = calculateSignalPercent(d.rsrp);
	return d;
}

/* ---- HFREQINFO 载波 ----
 *
 * 手册 13.16.1 语法结构 / 13.16.3 参数说明：
 *   ^HFREQINFO:<n>,<sysmode>,[<band>,<dl_fcn>,<dl_freq>,<dl_bw>,<ul_fcn>,<ul_freq>,<ul_bw>] ×1..4
 *   <n>        0 禁止主动上报 / 1 使能主动上报  —— **不是载波数**
 *   <sysmode>  1 GSM / 3 WCDMA（均不支持）/ 6 LTE / 7 NR
 *   每载波固定 7 个字段，NR 最多 4 个载波；LTE 只报主小区
 *   <dl_freq>/<ul_freq>：NR 单位 kHz，LTE 单位 100kHz；<dl_bw>/<ul_bw> 单位 kHz；无效值取 0
 *   TDD（如 n41）下 <dl_fcn> 与 <ul_fcn> 相同；辅载波常只报下行，上行字段为 0
 *
 * 真实应答示例（本机 NR 双载波聚合）：
 *   ^HFREQINFO: 0,7,41,528960,2644800,60000,528960,2644800,60000,41,513000,2565000,100000,0,0,1400
 *   = n=0, sysmode=7(NR)，随后 14 个字段 = 2 个载波 × 7
 *
 * 注意：本命令**不含** RSRP/RSRQ/SINR。按载波的信号质量要另取 ^MONSSC / ^CASCELLINFO
 * （本固件分别返回 NONE / ERROR，故按载波信号不可得）。
 *
 * 历史 bug：早期实现把应答当作「每行 8 字段（kind,band,channel,bandwidth,pci,rsrp,rsrq,sinr）」，
 * 既没跳过头两个字段、也没按 7 字段分组，导致整行右移、载波数算成 1（误判单载波），
 * 还把带宽/频点当信号原始值送进 convertRsrp/convertRsrq/convertSinr，
 * 凭空造出 -44 dBm / -3 dB / 30 dB 这种假信号值。
 */

var HFREQ_SYS_MODE = { 1: 'GSM', 3: 'WCDMA', 6: 'LTE', 7: 'NR' };

function parseHFREQINFO(data) {
	var out = [];
	var lines = extractATDataMultiline(data, '^HFREQINFO');
	for (var i = 0; i < lines.length; i++) {
		var f = lines[i].split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
		if (f.length < 3) continue;
		var sysMode = HFREQ_SYS_MODE[Number(f[1])] || ('模式 ' + f[1]);
		/*
		 * ★ 不能把空字段 filter 掉再分组：每载波固定 7 个字段、**位置即语义**
		 * （手册 13.16.3：band/dl_fcn/dl_freq/dl_bw/ul_fcn/ul_freq/ul_bw）。
		 * 删掉一个空字段会让后面整体左移（把 dl_bw 当 ul_fcn、把 ul_bw 当 band），
		 * 更直接的是长度落到 6 时 `Math.floor(6/7) === 0` —— **整个载波一个都不
		 * 输出**，界面上载波数变成 0。空值交给下面的 int() 归 0，位置必须保留。
		 */
		var rest = f.slice(2);
		var n = Math.floor(rest.length / 7);
		for (var k = 0; k < n; k++) {
			var c = rest.slice(k * 7, k * 7 + 7);
			var int = function (v) { var x = parseInt(v, 10); return isFinite(x) ? x : 0; };
			var band = int(c[0]);
			var dlFreq = int(c[2]);
			var ulFcn = int(c[4]);
			var ulFreq = int(c[5]);
			/* NR 频率单位 kHz，LTE 单位 100kHz */
			var toMHz = function (v) { return v ? (sysMode === 'LTE' ? v / 10 : v / 1000) : null; };
			out.push({
				index: k,
				kind: sysMode,
				sysMode: sysMode,
				band: band || null,
				dlFcn: int(c[1]),
				dlFreqMHz: toMHz(dlFreq),
				dlBwKHz: int(c[3]) || null,
				ulFcn: ulFcn,
				ulFreqMHz: toMHz(ulFreq),
				ulBwKHz: int(c[6]) || null,
				/* 上行频点与带宽都为 0 → 该载波只报了下行（常见于辅载波 SCell） */
				downlinkOnly: !ulFcn && !ulFreq
			});
		}
	}
	return out;
}

function operatorFromCode(code) {
	if (!code) return '未知运营商';
	var table = {
		'46000': '中国移动', '46001': '中国联通', '46002': '中国移动', '46003': '中国电信',
		'46004': '中国移动', '46005': '中国电信', '46006': '中国联通', '46007': '中国移动',
		'46008': '中国移动', '46009': '中国联通', '46011': '中国电信', '46013': '中国电信'
	};
	return table[code] || code;
}

function qciLabel(qci) {
	var table = { '1': 'QCI1 (VoLTE)', '2': 'QCI2', '3': 'QCI3', '4': 'QCI4', '5': 'QCI5 (IMS信令)', '6': 'QCI6', '7': 'QCI7', '8': 'QCI8', '9': 'QCI9 (默认承载)' };
	return table[String(qci).trim()] || ('QCI' + qci);
}

/* ================= 导出 ================= */

// eslint-disable-next-line no-undef
var atClient = (function () {
	var instance = null;
	return function () {
		if (!instance) instance = new ATClient();
		return instance;
	};
})();

/*
 * 取承载 5G 流量的网络接口累计字节数。
 *
 * 与 PDCP 方案的本质区别：此路径完全不下发 AT 命令，只经 rpcd 读
 * /sys/class/net/<dev>/statistics/，因此不占用 AT 通道、不会影响模组工作。
 *
 * 返回 Promise<{success, device, rx_bytes, tx_bytes}>。
 * 速率（字节/秒）需由调用方按「两次采样差 ÷ 时间差」计算，
 * 因为单次计数是累计值，本身不含速率语义。
 */
function fetchNetRate(device) {
	return withTimeout(rpcNetRate(device || ''), 5000, '接口统计读取超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { success: false, error: (resp && resp.error) || '读不到接口计数器' };
			}
			return {
				success: true,
				device: resp.device,
				rx_bytes: Number(resp.rx_bytes) || 0,
				tx_bytes: Number(resp.tx_bytes) || 0
			};
		})
		.catch(function (err) {
			return { success: false, error: (err && err.message) || '接口统计读取失败' };
		});
}

/*
 * 取系统侧排查事实。
 * 返回 Promise<{success, facts, error}>；facts 是 key → 字符串 的扁平映射。
 * 老固件上还没有 mt5700.sysdiag 这个方法，会被 rpcd 拒掉 —— 那时页面必须
 * 明确说"后端未升级"，而不是让"一键排查"点了没反应。
 */
function fetchSysDiag() {
	return withTimeout(rpcSysDiag(), 30000, '系统排查超时（脚本未返回）')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { success: false, facts: {}, error: (resp && resp.error) || 'rpcd 没有 mt5700.sysdiag 方法' };
			}
			return { success: true, facts: resp.facts || {}, at: Number(resp.at) || 0 };
		})
		.catch(function (err) {
			return { success: false, facts: {}, error: (err && err.message) || '系统排查失败' };
		});
}

/*
 * ES9+ 转发：向指定 SM-DP+ 主机发一次 JSON POST。
 * 返回 Promise<{success, status, body}>；失败时 success=false 且带 error。
 * 超时给 60s —— 后端 curl 上限 35s，加上 rpcd 与 ucode 的开销留足余量。
 */
function es9pPost(host, path, json) {
	return withTimeout(rpcEs9p(host, path, json, 0), 60000, 'ES9+ 请求超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { success: false, status: 0, body: '', error: (resp && resp.error) || 'ES9+ 请求失败' };
			}
			return { success: true, status: Number(resp.status) || 0, body: String(resp.body || '') };
		})
		.catch(function (err) {
			return { success: false, status: 0, body: '', error: (err && err.message) || 'ES9+ 请求失败' };
		});
}

/*
 * ES9+ 通道可用性探测（不发任何网络请求，只问后端有没有 curl）。
 * 老设备 / 裁剪过的固件上没有 mt5700.es9p 这个方法，L.rpc.declare 会直接
 * 被 rpcd 拒掉 —— 那时 esim.js 必须给出「设备侧缺少通道」的明确说明，
 * 而不是让「下载」按钮点了没反应。
 */
function es9pAvailable() {
	return withTimeout(rpcEs9p('', '', '', 1), 10000, 'ES9+ 探测超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { available: false, error: (resp && resp.error) || 'rpcd 没有 mt5700.es9p 方法' };
			}
			return { available: !!resp.available, error: resp.error || '' };
		})
		.catch(function (err) {
			return { available: false, error: (err && err.message) || 'rpcd 没有 mt5700.es9p 方法' };
		});
}

/*
 * 探测出口 IP：返回 Promise<{success, ip, endpoint, error}>。
 *
 * ★ ip 为空串必须按「无法判定」处理，不许退化成 0.0.0.0 之类占位（红线 23）：
 *   回显服务返回了 HTML 错误页、DNS 没解析、curl 不存在，都会走到这里，
 *   它们都不是「出口 IP 是 0.0.0.0」。
 *
 * 超时给 20s：后端三个端点各限时 8s，最坏 24s 才轮完，这里取 20s 让它先失败并
 * 如实报「未取到」，而不是让用户干等 —— 探测是手动触发的，快失败比慢成功更有用。
 */
function fetchExitIp(bind) {
	return withTimeout(rpcExitIp(bind || ''), 20000, '出口 IP 探测超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { success: false, ip: '', endpoint: '', error: (resp && resp.error) || 'rpcd 没有 mt5700.exitip 方法（后端未升级）' };
			}
			var ip = Parse.parseExitIpBody(resp.body);
			if (!ip) {
				/* 取到了响应但里面不是 IP —— 如实说明，别假装成功 */
				return { success: false, ip: '', endpoint: String(resp.endpoint || ''), error: '回显服务返回的内容不是 IP（可能没网或返回了错误页）' };
			}
			return { success: true, ip: ip, endpoint: String(resp.endpoint || '') };
		})
		.catch(function (err) {
			return { success: false, ip: '', endpoint: '', error: (err && err.message) || '出口 IP 探测失败' };
		});
}

/*
 * VoWiFi 能力评估：返回 Promise<{success, traceId, identity, aka, epdg, ims, stages[], blockers[], phase, verdict} | {success:false, error}>。
 *
 * 后端已经把域名解析成「四态结论」（available / polluted / not_published / unknown），
 * 并把五道门各自判过；这里只做传输与失败兜底，不重新判定 —— 判定规则只有一处，
 * 改起来才不会两边打架。
 *
 * 超时给 60s：后端最多 4 个域名 × 2 个 DNS × 6s，外加 EF_DIR 逐条读记录。
 * 正常情况（NXDOMAIN 秒回）远小于此，只有 DNS 服务器整个不可达才会跑满，
 * 那时如实报超时比让用户干等强。
 */
function fetchVowifi() {
	return withTimeout(rpcVowifi(), 60000, 'VoWiFi 评估超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { success: false, error: (resp && resp.error) || 'rpcd 没有 mt5700.vowifi 方法（后端未升级）' };
			}
			return resp;
		})
		.catch(function (err) {
			return { success: false, error: (err && err.message) || 'VoWiFi 评估失败' };
		});
}

/*
 * VoWiFi 开关：enable=1 开 / 0 关。
 *
 * 返回 Promise<{success, enable, applied, refused, effective, unknown, imsswitch, blockers, facts}>。
 * ★ refused=true 表示**后端拒绝下发**（本地三门没过），原因在 blockers 里 ——
 *   这不是失败，是「告知原因」，前端要原样展示，不能笼统报「设置失败」。
 * ★ unknown=true 表示下发成功但回读不到实测值，同样不许断言成「已生效」。
 */
function fetchVowifiSet(enable) {
	return withTimeout(rpcVowifiSet(enable ? 1 : 0), 60000, 'VoWiFi 开关超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return {
					success: false,
					error: (resp && resp.error) || 'rpcd 没有 mt5700.vowifi_set 方法（后端未升级）'
				};
			}
			return resp;
		})
		.catch(function (err) {
			return { success: false, error: (err && err.message) || 'VoWiFi 开关设置失败' };
		});
}

/*
 * 已发短信记录：list / add / del / clear。
 *
 * 返回 Promise<{success, messages, error}>。
 * ★ 后端没升级（rpcd 里没有 mt5700.smslog）时 response 会是 undefined，
 *   这里统一翻成 success:false + 明确文案 —— 调用方据此退化到「本地无记录」，
 *   绝不能把「读不到」当成「没有」（红线 23）。
 */
function fetchSmsLog(action, entry, id) {
	return withTimeout(
		rpcSmsLog(action || 'list', entry == null ? '' : String(entry), (id == null ? 0 : id)),
		15000, '已发记录操作超时'
	).then(function (resp) {
		if (!resp || resp.success === false) {
			return {
				success: false,
				messages: [],
				error: (resp && resp.error) || 'rpcd 没有 mt5700.smslog 方法（后端未升级）'
			};
		}
		return { success: true, messages: resp.messages || [], added: resp.added, removed: resp.removed };
	}).catch(function (err) {
		return { success: false, messages: [], error: (err && err.message) || '已发记录操作失败' };
	});
}

/*
 * 语音通话动作。
 *
 * 用法：fetchCall('status') / fetchCall('dial', '1008611') /
 *       fetchCall('answer') / fetchCall('hangup') / fetchCall('dtmf', null, '5')
 *
 * 返回：
 *   dial/answer/hangup/dtmf → Promise<{success, action, sent, raw, error}>
 *     sent=false + error  ＝后端拒绝或通道故障，命令没到模组
 *   status                  → Promise<{success, action, calls: [{id,dir,state,mode,mpty,number,type}]}>
 *     calls 为空数组＝**确实没有通话**（与「读不到」是两件事，红线 23）
 *   info                    → Promise<{success, action, mute, volume}>
 *     mute/volume 为 null ＝后端没拿到该项（不是「值是 0」）
 *   loglist                 → Promise<{success, action, records: [{number,dir,result,duration,time}]}>
 *   logadd（record=JSON 串） → Promise<{success, action, added, count}>
 *   logclear                → Promise<{success, action, cleared}>
 *
 * ★ record 走 **JSON 字符串**：与 smslog 的 entry 同一约定（ubus args schema
 *   声明为字符串，对象在传输层容易被展平）。由调用方 JSON.stringify。
 *
 * 超时 14s：与 sendCommand 同口径（后端最坏 8s 排队 + 3s 写入 + 2s 应答）。
 */
function fetchCall(action, number, digit, record) {
	return withTimeout(
		rpcCall(
			action || '',
			number == null ? '' : String(number),
			digit == null ? '' : String(digit),
			record == null ? '' : String(record)
		),
		14000, '通话操作超时'
	).then(function (resp) {
		if (!resp || resp.success === false) {
			return {
				success: false,
				action: action,
				sent: false,
				calls: null,
				/*
				 * 失败分支必须显式给 stage: null，不能省。省略的话前端读到
				 * undefined，与「还没查到过」混同；而这里的真实语义是
				 * 「查过了，失败了」—— 前端要能把它与空闲区分开（红线 23）。
				 */
				stage: null,
				steps: [],
				records: null,
				/*
				 * ready/volte 在失败分支必须显式给 false。省略时读到的是
				 * undefined —— 虽然 falsy、当前 UI 表现一致，但成功分支给的是
				 * 布尔 false，两边类型不一致；将来任何 ready === undefined
				 * 之类的判据都会被这个洞绊倒。显式写出来，类型就统一了。
				 */
				ready: false,
				volte: false,
				blocked: '',
				error: (resp && resp.error) || 'rpcd 没有 mt5700.call 方法（后端未升级）'
			};
		}
		return {
			success: true,
			action: resp.action || action,
			sent: resp.sent !== false,
			raw: resp.raw || '',
			calls: Array.isArray(resp.calls) ? resp.calls : null,
			/*
			 * stage 必须在这里透传：后端 callOverallStage 给的总态令牌
			 * （active/held/waiting/ringing/alerting/dialing/idle）。
			 * ★ 曾经的坑：本层漏了它，视图 st.stage 恒为 null，徽标一直退回
			 *   CALL_STATE 的 0-5 粗判，厂商粒度的状态机等于白写（后端在回、
			 *   前端在读，只有中间这层没搬）。null 保留「还没读到过」的语义
			 *   —— 与 'idle' 不同，后者是读到了且确实空闲（红线 23）。
			 */
			stage: (resp.stage == null) ? null : resp.stage,
			/*
			 * preflight 的判定结果同样要透传。与 stage 同一个坑：
			 * 只回 error 不带 steps/ready/volte/blocked，前端拿到的是
			 * 「检查失败」，自检卡片永远渲染不出那四行。
			 * ready 用 resp.ready === true 严格取，**不让 undefined 变 true**
			 * （「没读到」不等于「就绪」，红线 23）。
			 */
			ready: resp.ready === true,
			volte: resp.volte === true,
			blocked: resp.blocked || '',
			steps: Array.isArray(resp.steps) ? resp.steps : [],
			records: Array.isArray(resp.records) ? resp.records : null,
			mute: (resp.mute == null) ? null : resp.mute,
			volume: (resp.volume == null) ? null : resp.volume,
			added: resp.added === true,
			count: (resp.count == null) ? null : resp.count,
			cleared: resp.cleared === true,
			error: resp.error || ''
		};
	}).catch(function (err) {
		return {
			success: false, action: action, sent: false,
			calls: null, stage: null, steps: [], records: null,
			ready: false, volte: false, blocked: '',
			error: (err && err.message) || '通话操作失败'
		};
	});
}

var AtWs = {
	client: atClient(),
	netRate: fetchNetRate,
	sysDiag: fetchSysDiag,
	smsLog: fetchSmsLog,
	es9p: es9pPost,
	exitIp: fetchExitIp,
	vowifi: fetchVowifi,
	vowifiSet: fetchVowifiSet,
	call: fetchCall,
	es9pAvailable: es9pAvailable,
	extractATData: extractATData,
	extractATDataMultiline: extractATDataMultiline,
	convertRsrp: convertRsrp,
	convertRsrq: convertRsrq,
	convertSinr: convertSinr,
	convertRssi: convertRssi,
	calculateSignalPercent: calculateSignalPercent,
	parseHexValue: parseHexValue,
	hexToIP: hexToIP,
	parseTemperature: parseTemperature,
	formatFlow: formatFlow,
	formatDuration: formatDuration,
	parseHCSQ: parseHCSQ,
	parseMONSC: parseMONSC,
	parseHFREQINFO: parseHFREQINFO,
	parseRawData: parseRawData,
	psRegText: psRegText,
	operatorFromCode: operatorFromCode,
	qciLabel: qciLabel,
	isUnsolicitedText: isUnsolicitedText,
	uci: AtUci
};

/* LuCI factory 必须返回 Class 子类；挂 window.AtWs 供页面使用 */
var AtWsClass = L.Class.extend(AtWs);
if (typeof window !== 'undefined') {
	window.AtWs = new AtWsClass();
}
return AtWsClass;
