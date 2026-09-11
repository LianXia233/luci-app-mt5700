'use strict';
'require baseclass';
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
 * - subscribe/unsubscribe：事件轮询拉取增量（RPC 为请求-响应模型），推送类型与原 WS 一致：
 *   raw_data / new_sms / incoming_call / pdcp_data / memory_full / cellscan / urc_data
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

var rpcEvents = L.rpc.declare({
	object: 'mt5700',
	method: 'events',
	params: ['since'],
	expect: {}
});

function withTimeout(p, ms, msg) {
	return Promise.race([
		p,
		new Promise(function (resolve, reject) {
			setTimeout(function () { reject(new Error(msg || '请求超时')); }, ms);
		})
	]);
}

function ATClient() {
	this.connected = false;
	this.authenticated = true;       // RPC 模式：登录态由 LuCI/rpcd 会话保证
	this.requireAuth = false;
	this.authKey = '';
	this.commandTimeout = 8000;
	this.subscribers = [];            // 推送订阅者
	this.stateCallbacks = [];
	this.state = 'idle';
	this.error = null;
	this.commandQueue = Promise.resolve();
	this.pollTimer = null;
	this.pollInterval = 1500;         // 事件轮询间隔（毫秒）
	this.eventSeq = 0;
	this.firstPoll = true;
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
		// UCI 键都在 config 段下（websocket_port / websocket_auth_key），没有 'websocket' 段
		var port = parseInt(L.uci.get('at-webserver', 'config', 'websocket_port') || '8765', 10) || 8765;
		var authKey = L.uci.get('at-webserver', 'config', 'websocket_auth_key') || '';
		self.port = port;
		self.requireAuth = !!authKey;
		self.authKey = authKey;
		return self.port;
	}).catch(function (err) {
		console.warn('加载 UCI 配置失败，使用默认值', err);
		self.port = 8765;
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
		if (self.firstPoll) {
			// 首次连接只对齐序号，不重放服务启动前的事件（与原 WS 连接语义一致）
			self.firstPoll = false;
			return;
		}
		for (var i = 0; i < events.length; i++) {
			self.handlePush(events[i]);
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
	if (['incoming_call', 'new_sms', 'pdcp_data', 'memory_full', 'cellscan', 'urc_data'].indexOf(ev.type) >= 0) {
		this.emitPush({ success: true, type: ev.type, data: ev.data });
	}
};

/* ---------- 命令发送（RPC，逐条独立应答） ---------- */

ATClient.prototype.sendCommand = function (command) {
	var self = this;
	this.commandQueue = this.commandQueue.then(function () {
		if (!self.connected) return { success: false, error: '未连接到调制解调器' };
		return withTimeout(rpcAt(command), self.commandTimeout, '命令执行超时').then(function (resp) {
			resp = resp || {};
			if (resp.success === false) {
				return { success: false, error: resp.error || '命令执行失败' };
			}
			return { success: true, data: resp.data };
		}).catch(function (err) {
			return { success: false, error: (err && err.message) || '命令执行失败' };
		});
	});
	return this.commandQueue;
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
function convertSinr(raw) {
	var v = raw === 0 ? -20 : (raw >= 251 ? 30 : -20 + raw * 0.2);
	return Math.min(30, Math.max(-20, v));
}
function convertRssi(raw) { return raw === 0 ? -120 : (raw >= 96 ? -25 : -121 + raw); }

function calculateSignalPercent(rsrp) {
	if (!rsrp || rsrp >= 0) return '';
	var ratio = (rsrp - (-110)) / ((-70) - (-110));
	return Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
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

function formatSpeed(bytesPerSecond) {
	var bits = bytesPerSecond * 8;
	if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gbps';
	if (bits >= 1e6) return (bits / 1e6).toFixed(2) + ' Mbps';
	if (bits >= 1e3) return (bits / 1e3).toFixed(2) + ' Kbps';
	return Math.round(bits) + ' bps';
}

function splitSpeed(bytesPerSecond) {
	var bits = bytesPerSecond * 8;
	if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps' };
	if (bits >= 1e6) return { value: (bits / 1e6).toFixed(2), unit: 'Mbps' };
	if (bits >= 1e3) return { value: (bits / 1e3).toFixed(1), unit: 'Kbps' };
	return { value: Math.round(bits).toString(), unit: 'bps' };
}

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

var NR_BANDS = {
	'1': '2100 MHz (FDD)', '2': '1900 MHz (FDD)', '3': '1800 MHz (FDD)', '5': '850 MHz (FDD)',
	'7': '2600 MHz (FDD)', '8': '900 MHz (FDD)', '20': '800 MHz (FDD)', '28': '700 MHz (FDD)',
	'38': '2600 MHz (TDD)', '40': '2300 MHz (TDD)', '41': '2500 MHz (TDD)', '77': '3700 MHz (TDD)',
	'78': '3500 MHz (TDD)', '79': '4700 MHz (TDD)'
};
var LTE_BANDS = {
	'1': '2100 MHz', '2': '1900 MHz', '3': '1800 MHz', '4': '1700 MHz (AWS)', '5': '850 MHz',
	'7': '2600 MHz', '8': '900 MHz', '12': '700 MHz', '20': '800 MHz', '28': '700 MHz', '38': '2600 MHz',
	'39': '1900 MHz', '40': '2300 MHz', '41': '2500 MHz', '42': '3400 MHz', '43': '3700 MHz'
};
function bandName(kind, band) {
	var table = kind === 'NR' ? NR_BANDS : LTE_BANDS;
	return table[String(band)] || ('Band ' + band);
}

/* ---- ^HCSQ / 信号 ---- */

function parseHCSQ(data) {
	var str = extractATData(data, '^HCSQ');
	if (!str) return null;
	var p = str.split(',');
	var mode = p[0] ? p[0].replace(/"/g, '').trim() : '';
	var networkMode;
	if (mode.indexOf('NR') === 0) networkMode = 'NR';
	else if (mode.indexOf('LTE') === 0) networkMode = 'LTE';
	else if (mode.indexOf('WCDMA') === 0) networkMode = 'WCDMA';
	else networkMode = mode || '';
	var result = { networkMode: networkMode, rssi: null, rsrp: null, rsrq: null, sinr: null };
	if (networkMode === 'NR') {
		if (p.length >= 4) { result.rsrp = convertRsrp(parseInt(p[2], 10)); result.sinr = convertSinr(parseInt(p[3], 10)); }
		if (p.length >= 5) result.rsrq = convertRsrq(parseInt(p[4], 10));
	} else if (networkMode === 'LTE') {
		if (p.length >= 3) result.rsrp = convertRsrp(parseInt(p[2], 10));
		if (p.length >= 4) result.rsrq = convertRsrq(parseInt(p[3], 10));
		if (p.length >= 5) result.sinr = convertSinr(parseInt(p[4], 10));
	} else {
		if (p.length >= 2) result.rssi = convertRssi(parseInt(p[1], 10));
	}
	return result;
}

function signalColor(rsrp) {
	if (rsrp == null || rsrp >= 0) return '#8f8f8f';
	if (rsrp >= -90) return '#2e7d32';
	if (rsrp >= -105) return '#f9a825';
	return '#c62828';
}

/* ---- PS 注册状态 ---- */

function psRegText(stat) {
	switch (parseInt(stat, 10)) {
		case 0: return '未注册，正在搜索';
		case 1: return '已注册（本地网络）';
		case 2: return '未注册，正在搜索（但允许紧急呼叫）';
		case 3: return '注册被拒绝';
		case 4: return '未知';
		case 5: return '已注册（漫游）';
		default: return '等待状态中';
	}
}

/* ---- 主动上报识别 ---- */

function isUnsolicitedText(text) {
	if (!text) return false;
	if (text === 'RING' || text === 'IRING' || text === '^IRING' || text === 'NO CARRIER') return true;
	return text.indexOf('+CMTI:') === 0 || text.indexOf('^CEND:') === 0 ||
		text.indexOf('^SMMEMFULL') === 0 || text.indexOf('MEMORY FULL') >= 0 ||
		text.indexOf('^REJINFO') === 0 || (text.indexOf('+CUSD:') === 0 && text.indexOf(',') >= 0);
}

/* ---- raw_data 拆分（^PDCPDATAINFO / URC） ---- */

function parseRawData(text) {
	var out = [];
	var re = /\^PDCPDATAINFO:\s*([^\r\n]+)/g;
	var m, rest = text;
	while ((m = re.exec(text)) !== null) {
		var fields = m[1].split(',');
		out.push({ type: 'PDCP', raw: m[1], parsed: parsePDCP(fields) });
		rest = rest.replace(m[0], '');
	}
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
	}
	return out;
}

/* ---- PDCP 14 字段 ---- */

var PDCP_FIELDS = [
	{ key: 'rx_bytes', label: '下行字节' },
	{ key: 'tx_bytes', label: '上行字节' },
	{ key: 'rx_pkts', label: '下行包数' },
	{ key: 'tx_pkts', label: '上行包数' },
	{ key: 'rx_rate', label: '下行速率' },
	{ key: 'tx_rate', label: '上行速率' },
	{ key: 'rx_pdcp_delay', label: '下行 PDCP 时延(0.1ms)' },
	{ key: 'tx_pdcp_delay', label: '上行 PDCP 时延(0.1ms)' },
	{ key: 'rx_pkt_loss', label: '下行丢包率' },
	{ key: 'tx_pkt_loss', label: '上行丢包率' },
	{ key: 'rx_retx_pct', label: '下行重传率' },
	{ key: 'tx_retx_pct', label: '上行重传率' },
	{ key: 'rx_volte_bytes', label: '下行 VoLTE 字节' },
	{ key: 'tx_volte_bytes', label: '上行 VoLTE 字节' }
];

function parsePDCP(fields) {
	var obj = {};
	obj.rx_bytes = parseInt(fields[0], 10) || 0;
	obj.tx_bytes = parseInt(fields[1], 10) || 0;
	obj.rx_pkts = parseInt(fields[2], 10) || 0;
	obj.tx_pkts = parseInt(fields[3], 10) || 0;
	obj.rx_rate = parseInt(fields[4], 10) || 0;
	obj.tx_rate = parseInt(fields[5], 10) || 0;
	obj.rx_pdcp_delay = parseInt(fields[6], 10) || 0;
	obj.tx_pdcp_delay = parseInt(fields[7], 10) || 0;
	obj.rx_pkt_loss = parseInt(fields[8], 10) || 0;
	obj.tx_pkt_loss = parseInt(fields[9], 10) || 0;
	obj.rx_retx_pct = parseInt(fields[10], 10) || 0;
	obj.tx_retx_pct = parseInt(fields[11], 10) || 0;
	obj.rx_volte_bytes = parseInt(fields[12], 10) || 0;
	obj.tx_volte_bytes = parseInt(fields[13], 10) || 0;
	obj.downSpeed = obj.rx_rate / 1024;   // Kbps 原始
	obj.upSpeed = obj.tx_rate / 1024;
	return obj;
}

/* ---- MONSC ---- */

function parseMONSC(data) {
	var str = extractATData(data, '^MONSC');
	if (!str) return null;
	var p = str.split(',');
	var d = {
		mcc: p[0] ? p[0].trim() : '',
		mnc: p[1] ? p[1].trim() : '',
		lac: p[2] ? p[2].trim() : '',
		cid: p[3] ? p[3].trim() : '',
		pci: p[4] ? parseInt(p[4], 10) : 0,
		channel: p[5] ? p[5].trim() : '',
		rsrp: p[6] !== undefined ? convertRsrp(parseInt(p[6], 10)) : null,
		rsrq: p[7] !== undefined ? convertRsrq(parseInt(p[7], 10)) : null,
		sinr: p[8] !== undefined ? convertSinr(parseInt(p[8], 10)) : null,
		sysMode: p[9] ? p[9].replace(/"/g, '').trim() : ''
	};
	d.signalPercent = calculateSignalPercent(d.rsrp);
	return d;
}

/* ---- HFREQINFO 载波 ---- */

function parseHFREQINFO(data) {
	var out = [];
	var lines = extractATDataMultiline(data, '^HFREQINFO');
	for (var i = 0; i < lines.length; i++) {
		var p = lines[i].split(',');
		out.push({
			kind: p[0] ? p[0].replace(/"/g, '').trim() : '',
			band: p[1] ? p[1].trim() : '',
			channel: p[2] ? p[2].trim() : '',
			bandwidth: p[3] ? p[3].trim() : '',
			pci: p[4] ? parseInt(p[4], 10) : 0,
			rsrp: p[5] !== undefined ? convertRsrp(parseInt(p[5], 10)) : null,
			rsrq: p[6] !== undefined ? convertRsrq(parseInt(p[6], 10)) : null,
			sinr: p[7] !== undefined ? convertSinr(parseInt(p[7], 10)) : null
		});
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

var AtWs = {
	client: atClient,
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
	formatSpeed: formatSpeed,
	splitSpeed: splitSpeed,
	formatDuration: formatDuration,
	parseHCSQ: parseHCSQ,
	parseMONSC: parseMONSC,
	parseHFREQINFO: parseHFREQINFO,
	parsePDCP: parsePDCP,
	parseRawData: parseRawData,
	PDCP_FIELDS: PDCP_FIELDS,
	signalColor: signalColor,
	psRegText: psRegText,
	operatorFromCode: operatorFromCode,
	qciLabel: qciLabel,
	bandName: bandName,
	isUnsolicitedText: isUnsolicitedText
};

/* LuCI factory 必须返回 Class 子类；挂 window.AtWs 供页面使用 */
var AtWsClass = baseclass.extend(AtWs);
if (typeof window !== 'undefined') {
	window.AtWs = new AtWsClass();
}
return AtWsClass;
