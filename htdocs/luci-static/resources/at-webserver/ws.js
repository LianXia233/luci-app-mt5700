'use strict';
'require at-webserver/parse';
/* global L, XHR */

/**
 * AT WebSocket 客户端（等价原 React 前端 services/at.ts 的 WebSocketATAdapter）。
 *
 * 协议契约（与 Go/Rust 服务端严格一致）：
 * - 地址 ws://<host>:<port>，配置来自 UCI at-webserver（原实现读 localStorage / CGI，LuCI 侧统一读 UCI）
 * - 服务端配置了密钥时：连接后先发 {"auth_key":"..."}，收到 {"success":true,"message":"认证成功"} 才算可用
 * - 心跳：客户端 20 秒发一次 "ping"，服务端 30 秒推一次 "ping"，收到回 "pong"
 * - 命令应答 {success, data, error}，按发送顺序 FIFO 匹配（无请求 ID）
 * - AT+CMGL=4 的应答可能被拆成多条消息，见到 OK/ERROR 才算读完
 * - 推送类型：raw_data / new_sms / incoming_call / pdcp_data / memory_full / cellscan / urc_data
 */

var AUTH_REJECTIONS = ['Authentication failed', 'Authentication timeout', 'Invalid authentication'];

function ATClient() {
	this.connected = false;
	this.ws = null;
	this.authenticated = false;
	this.requireAuth = false;
	this.authKey = '';
	this.host = '';
	this.port = 8765;
	this.reconnectAttempts = 0;
	this.maxReconnectAttempts = 3;
	this.reconnectDelay = 2000;
	this.commandTimeout = 6000;
	this.heartbeatTimer = null;
	this.reconnectTimer = null;
	this.pendingCommands = [];        // FIFO：{ resolve, timer }
	this.subscribers = [];            // 推送订阅者
	this.stateCallbacks = [];
	this.state = 'idle';
	this.error = null;
	this.connectingPromise = null;
	this.connectResolve = null;
	this.connectReject = null;
	this.connectTimeout = null;
	this.smsCollecting = false;
	this.smsBuffer = [];
	this.smsResolve = null;
	this.smsTimer = null;
	this.lastCommand = '';
	this.commandQueue = Promise.resolve();
	this.configReady = this.loadConfig();
	this.rememberDays = 30;
}

ATClient.prototype.setConnectionState = function (state, err) {
	this.state = state;
	this.error = err || null;
	for (var i = 0; i < this.stateCallbacks.length; i++) {
		try { this.stateCallbacks[i](state, this.error); } catch (e) { /* 回调异常不影响主流程 */ }
	}
};

ATClient.prototype.isReady = function () {
	return this.connected && (!this.requireAuth || this.authenticated);
};

/* ---------- 配置加载 ---------- */

ATClient.prototype.loadConfig = function () {
	var self = this;
	return L.uci.load('at-webserver').then(function () {
		var host = L.uci.get('at-webserver', 'websocket', 'host') || '';
		var port = parseInt(L.uci.get('at-webserver', 'websocket', 'port') || '8765', 10) || 8765;
		var authKey = L.uci.get('at-webserver', 'websocket', 'auth_key') || '';
		// 原前端以 /cgi-bin/at-ws-info 的返回值优先；LuCI 侧同一份 UCI，直接取。
		// host 为空时退回到当前页面主机（LuCI 与 AT 服务在同一台路由器上）。
		self.host = host || window.location.hostname || '192.168.8.1';
		self.port = port;
		self.requireAuth = !!authKey;
		self.authKey = authKey;
		// 兼容：也允许用户在浏览器里用 localStorage 覆盖（与原前端行为一致）。
		var lsHost = null, lsPort = null;
		try {
			lsHost = localStorage.getItem('atHost');
			lsPort = localStorage.getItem('atPort');
		} catch (e) { /* 隐私模式下 localStorage 不可用 */ }
		if (lsHost) self.host = lsHost;
		if (lsPort) self.port = parseInt(lsPort, 10) || self.port;
		return self.host;
	}).catch(function (err) {
		console.warn('加载 UCI 配置失败，使用默认值', err);
		self.host = window.location.hostname || '192.168.8.1';
		self.port = 8765;
		return self.host;
	});
};

/* ---------- 连接管理 ---------- */

ATClient.prototype.connect = function (authKey) {
	if (this.isReady()) {
		this.setConnectionState('connected');
		return Promise.resolve(true);
	}
	if (this.connectingPromise) return this.connectingPromise;

	var self = this;
	this.setConnectionState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
	var connection = this.configReady.then(function () {
		return self._doConnect(authKey);
	});
	this.connectingPromise = connection;
	return connection.finally(function () {
		if (self.connectingPromise === connection) self.connectingPromise = null;
	});
};

ATClient.prototype._doConnect = function (authKey) {
	var self = this;
	if (self.requireAuth) {
		if (authKey) {
			self.authKey = authKey;
			self.saveAuthKey(authKey);
		} else if (!self.authKey) {
			var cached = self.getCachedAuthKey();
			if (cached) { self.authKey = cached; }
			else {
				self.setConnectionState('authenticating');
				return Promise.reject(new Error('REQUIRE_AUTH_KEY'));
			}
		}
	}

	var isIPv6 = self.host.indexOf(':') >= 0;
	var url = (window.location.protocol === 'https:' ? 'wss' : 'ws') + '://' + (isIPv6 ? '[' + self.host + ']' : self.host) + ':' + self.port;
	var socket;
	try {
		socket = new WebSocket(url);
	} catch (e) {
		self.setConnectionState('error', '连接调制解调器失败: ' + (e.message || e));
		return Promise.reject(e);
	}
	self.ws = socket;
	self.setupWebSocket(socket);

	return new Promise(function (resolve, reject) {
		self.connectResolve = resolve;
		self.connectReject = reject;
		self.connectTimeout = setTimeout(function () {
			if (self.ws !== socket || self.isReady()) return;
			var err = new Error('连接超时');
			self.setConnectionState('error', err.message);
			self.rejectPendingConnection(err);
			socket.close();
		}, 10000);
	});
};

ATClient.prototype.setupWebSocket = function (socket) {
	var self = this;
	socket.onopen = function () {
		if (self.ws !== socket) { socket.close(); return; }
		self.connected = true;
		if (self.requireAuth) {
			self.setConnectionState('authenticating');
			socket.send(JSON.stringify({ auth_key: self.authKey }));
			return;
		}
		self.onAuthenticated();
	};

	socket.onclose = function () {
		if (self.ws !== socket) return;
		var wasConnected = self.state === 'connected';
		self.ws = null;
		self.connected = false;
		self.authenticated = false;
		self.stopHeartbeat();
		self.rejectPendingConnection(new Error('AT WebSocket 连接已断开'));
		self.handleDisconnect(wasConnected);
	};

	socket.onerror = function () {
		if (self.ws !== socket) return;
		var message = window.location.protocol === 'https:'
			? '连接AT服务器失败：当前页面是 HTTPS，AT 服务只提供明文 WebSocket，请改用 http:// 访问'
			: '连接AT服务器失败';
		self.setConnectionState('error', message);
		self.rejectPendingConnection(new Error(message));
		if (socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) socket.close();
	};

	socket.onmessage = function (event) {
		if (self.ws !== socket) return;
		try {
			if (typeof event.data === 'string') self.handleWSMessage(event.data);
		} catch (e) {
			console.error('处理 WebSocket 消息失败:', e);
		}
	};
};

ATClient.prototype.onAuthenticated = function () {
	this.authenticated = true;
	this.reconnectAttempts = 0;
	this.setConnectionState('connected');
	this.startHeartbeat();
	this.resolvePendingConnection();
};

ATClient.prototype.startHeartbeat = function () {
	var self = this;
	this.stopHeartbeat();
	this.heartbeatTimer = setInterval(function () {
		if (self.ws && self.ws.readyState === WebSocket.OPEN) self.ws.send('ping');
	}, 20000);
};

ATClient.prototype.stopHeartbeat = function () {
	if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
};

ATClient.prototype.handleDisconnect = function (wasConnected) {
	var self = this;
	this.clearPendingCommands('连接已断开');

	if (this.requireAuth) {
		if (this.state !== 'error') this.setConnectionState('disconnected');
		return;
	}

	if (this.reconnectAttempts < this.maxReconnectAttempts) {
		this.reconnectAttempts++;
		this.setConnectionState('reconnecting');
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(function () {
			self.reconnectTimer = null;
			self.connect().catch(function () {});
		}, this.reconnectDelay);
		return;
	}
	this.setConnectionState('error', '自动重连失败，请检查设备连接');
};

ATClient.prototype.disconnect = function () {
	var self = this;
	if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
	this.clearPendingCommands('连接已手动断开');
	this.stopHeartbeat();
	this.rejectPendingConnection(new Error('连接已手动断开'));
	var socket = this.ws;
	this.ws = null;
	if (socket) socket.close();
	this.connected = false;
	this.authenticated = false;
	this.reconnectAttempts = 0;
	this.connectingPromise = null;
	this.setConnectionState('disconnected');
	return Promise.resolve();
};

/* ---------- 认证 ---------- */

ATClient.prototype.getCachedAuthKey = function () {
	try {
		var key = localStorage.getItem('at_ws_auth_key');
		var expiry = localStorage.getItem('at_ws_auth_key_expiry');
		if (key && expiry && Date.now() < parseInt(expiry, 10)) return key;
		if (key) this.clearAuthKey();
	} catch (e) { /* ignore */ }
	return '';
};

ATClient.prototype.saveAuthKey = function (key) {
	try {
		localStorage.setItem('at_ws_auth_key', key);
		localStorage.setItem('at_ws_auth_key_expiry', String(Date.now() + this.rememberDays * 86400000));
	} catch (e) { /* ignore */ }
};

ATClient.prototype.clearAuthKey = function () {
	this.authKey = '';
	this.authenticated = false;
	try {
		localStorage.removeItem('at_ws_auth_key');
		localStorage.removeItem('at_ws_auth_key_expiry');
	} catch (e) { /* ignore */ }
};

/* ---------- 消息处理 ---------- */

ATClient.prototype.handleWSMessage = function (data) {
	var self = this;
	if (data === 'ping' || data === 'pong') return;

	var parsed;
	try { parsed = JSON.parse(data); }
	catch (e) { this.handleTextMessage(data); return; }

	// 认证握手
	if (this.requireAuth && !this.authenticated) {
		if (parsed.success && parsed.message === '认证成功') {
			this.onAuthenticated();
			return;
		}
		if (parsed.error || parsed.message === '认证失败') {
			var msg = parsed.message || '密钥认证失败';
			this.authenticated = false;
			this.connected = false;
			this.setConnectionState('error', msg);
			this.rejectPendingConnection(new Error(msg));
			if (this.ws) this.ws.close();
			return;
		}
		return;
	}

	// 服务端要求密钥但配置没报告（旧版本 CGI 场景）
	if (typeof parsed.error === 'string' && AUTH_REJECTIONS.indexOf(parsed.error) >= 0) {
		this.requireAuth = true;
		this.authenticated = false;
		this.connected = false;
		this.setConnectionState('error', '需要连接密钥');
		this.rejectPendingConnection(new Error('REQUIRE_AUTH_KEY'));
		if (this.ws) this.ws.close();
		return;
	}

	// 结构化推送，直接转发给订阅者
	if (['incoming_call', 'new_sms', 'pdcp_data', 'memory_full', 'cellscan', 'urc_data'].indexOf(parsed.type) >= 0) {
		this.emitPush({ success: true, type: parsed.type, data: parsed.data });
		return;
	}

	// raw_data 里只有主动上报，不能拿去匹配等待中的命令
	if (parsed.type === 'raw_data' && typeof parsed.data === 'string') {
		this.dispatchRawData(parsed.data);
		return;
	}

	// AT+CMGL=4 多包收集
	if (this.smsCollecting) {
		if (parsed.success === false) {
			this.finishSMSCollect({ success: false, error: parsed.error || '读取短信失败' });
		} else {
			this.collectSMSChunk(typeof parsed.data === 'string' ? parsed.data : data);
		}
		return;
	}

	// 应答和当前命令对不上就丢弃：宁可让这条命令超时，也不能污染下一条。
	if (typeof parsed.data === 'string' && !this.matchesLastCommand(parsed.data)) return;

	this.handleResponse({
		success: parsed.success !== false,
		data: parsed.data,
		error: parsed.error
	});
};

ATClient.prototype.handleTextMessage = function (data) {
	if (this.smsCollecting) { this.collectSMSChunk(data); return; }
	if (isUnsolicitedText(data)) return;
	this.handleResponse({ success: data.indexOf('ERROR') < 0, data: data });
};

ATClient.prototype.matchesLastCommand = function (data) {
	var m = this.lastCommand.match(/AT([^\s=?]*)/);
	if (!m) return true;
	var prefix = m[1];
	if (!prefix) return true;
	if (data.indexOf(prefix) >= 0 || data.indexOf('OK') >= 0 || data.indexOf('ERROR') >= 0) return true;
	return false;
};

ATClient.prototype.handleResponse = function (resp) {
	if (!this.pendingCommands.length) return;
	var cmd = this.pendingCommands.shift();
	clearTimeout(cmd.timer);
	cmd.resolve(resp);
};

ATClient.prototype.clearPendingCommands = function (err) {
	while (this.pendingCommands.length) {
		var cmd = this.pendingCommands.shift();
		clearTimeout(cmd.timer);
		cmd.resolve({ success: false, error: err });
	}
};

ATClient.prototype.resolvePendingConnection = function () {
	if (this.connectTimeout) { clearTimeout(this.connectTimeout); this.connectTimeout = null; }
	var r = this.connectResolve;
	this.connectResolve = null;
	this.connectReject = null;
	if (r) r(true);
};

ATClient.prototype.rejectPendingConnection = function (err) {
	if (this.connectTimeout) { clearTimeout(this.connectTimeout); this.connectTimeout = null; }
	var r = this.connectReject;
	this.connectResolve = null;
	this.connectReject = null;
	if (r) r(err);
};

/* ---------- 命令发送 ---------- */

ATClient.prototype.sendCommand = function (command) {
	var self = this;
	this.commandQueue = this.commandQueue.then(function () {
		if (!self.connected || !self.ws) return { success: false, error: '未连接到调制解调器' };

		// 短信列表可能被拆成多条消息返回，单独收集
		if (command.trim() === 'AT+CMGL=4') {
			self.smsCollecting = true;
			self.smsBuffer = [];
			return new Promise(function (resolve) {
				self.smsResolve = resolve;
				self.smsTimer = setTimeout(function () {
					self.finishSMSCollect({ success: false, error: '短信数据收集超时' });
				}, 10000);
				self.ws.send(command.endsWith('\r') ? command : command + '\r');
			});
		}

		self.lastCommand = command;
		return new Promise(function (resolve) {
			var timer = setTimeout(function () {
				// 从 FIFO 里移除自己
				for (var i = 0; i < self.pendingCommands.length; i++) {
					if (self.pendingCommands[i].timer === timer) { self.pendingCommands.splice(i, 1); break; }
				}
				resolve({ success: false, error: '命令执行超时' });
			}, self.commandTimeout);
			self.pendingCommands.push({ resolve: resolve, timer: timer });
			self.ws.send(command.endsWith('\r') ? command : command + '\r');
		});
	}).catch(function (err) {
		return { success: false, error: (err && err.message) || '命令执行失败' };
	});
	return this.commandQueue;
};

/* ---------- CMGL=4 收集 ---------- */

ATClient.prototype.collectSMSChunk = function (content) {
	if (content.indexOf('OK') < 0 && content.indexOf('ERROR') < 0) {
		this.smsBuffer.push(content);
		return;
	}
	var all = this.smsBuffer.concat([content]).join('\n');
	this.finishSMSCollect({ success: all.indexOf('ERROR') < 0, data: all });
};

ATClient.prototype.finishSMSCollect = function (resp) {
	if (this.smsTimer) { clearTimeout(this.smsTimer); this.smsTimer = null; }
	this.smsCollecting = false;
	this.smsBuffer = [];
	var r = this.smsResolve;
	this.smsResolve = null;
	if (r) r(resp);
};

/* ---------- 订阅 ---------- */

ATClient.prototype.subscribe = function (cb) {
	if (this.subscribers.indexOf(cb) < 0) this.subscribers.push(cb);
};

ATClient.prototype.unsubscribe = function (cb) {
	var i = this.subscribers.indexOf(cb);
	if (i >= 0) this.subscribers.splice(i, 1);
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
	this.host = host.replace(/^\[|\]$/g, '');
	this.port = port;
	try {
		localStorage.setItem('atHost', this.host);
		localStorage.setItem('atPort', String(port));
	} catch (e) { /* ignore */ }
	var self = this;
	return this.disconnect().then(function () { return self.connect(); });
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
			// 手册 13.14：网络拒绝原因主动上报，解析后进 REJINFO 类型
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

// 保持与旧代码一致的“按需重连”语义：连接状态回调驱动页面展示，
// 页面在需要时主动 connect()（无密钥环境会自动连接）。
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
