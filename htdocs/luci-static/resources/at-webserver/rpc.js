'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/parse';
'require rpc';
/* global L, baseclass */

/**
 * AT LuCI RPC 客户端。
 *
 * 传输链路（LuCI RPC，无 WebSocket）：
 *   LuCI JS → L.rpc.declare('mt5700.at'/'mt5700.events') → rpcd → ucode 插件
 *   （/usr/share/rpcd/ucode/mt5700.uc）→ Rust 后端（127.0.0.1:<port>，TCP newline-JSON）
 *
 * 语义兼容：
 * - sendCommand(cmd) → {success,data,error}，保持 FIFO 顺序（RPC 逐条应答，前端仍串行化）
 * - subscribe/unsubscribe：事件轮询拉取增量（RPC 为请求-响应模型）。订阅者收到的事件类型：
 *   urc_data（由 raw_data 文本解析而来）/ new_sms / incoming_call / pdcp_data / memory_full / cellscan
 * - 认证：LuCI 登录态由 rpcd 会话/ACL 保证；UCI websocket_auth_key 由 ucode 代理附加，
 *   页面无需输入密钥（密钥配置保持向后兼容）
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
 * 模组 USB 链路速率（自动识别数据源）。
 * 由 mt5700.uc 的 usb 方法直接读 sysfs 下 USB 设备的 speed 节点，
 * 全程不下发任何 AT 命令，不占用 AT 通道、不干扰模组。
 * 返回 {success, speed_mbps, product, version}，速度单位 Mbps（如 5000 = USB 3.0）。
 */
var rpcUsb = L.rpc.declare({
	object: 'mt5700',
	method: 'usb',
	params: [],
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
	this.commandTimeout = 14000;
	/* 探活超时：略大于 ucode 的 12s 硬超时，避免提前掐断后端结论 */
	this.healthTimeout = 13000;
	this.subscribers = [];            // 推送订阅者
	this.stateCallbacks = [];
	this.state = 'idle';
	this.error = null;
	this.commandQueue = Promise.resolve();
	this.pollTimer = null;
	this.pollInterval = 1500;         // 事件轮询间隔（毫秒）
	this.eventSeq = 0;
	this.firstPoll = true;
	this.host = '127.0.0.1';
	this.port = 8765;
	/* 降级自动重连定时器与尝试次数（由 scheduleReconnect 维护，必须初始化，
	 * 否则 clearTimeout(undefined) 虽然无害，但 reconnectAttempts 累加会 NaN） */
	this.reconnectTimer = null;
	this.reconnectAttempts = 0;
	/* 命令熔断器：连续失败 failThreshold 次后开闸 circuitCooldownMs，
	 * 期间 sendCommand 立即返回，不再消耗 14s 超时预算 */
	this.failStreak = 0;
	this.failThreshold = 3;
	this.circuitOpenUntil = 0;
	this.circuitCooldownMs = 8000;
	/* 后端可用性结论（由 healthCheck 维护，供各页面数据请求共享） */
	this.backendKnownDown = false;
	this.backendDownCause = '';
	this.backendDownError = '';
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
		console.warn('加载 UCI 配置失败，使用默认值', err);
		self.port = 8765;
		self.bind = '127.0.0.1';
		self.host = '127.0.0.1';
		return self.port;
	});
};

/* ---------- 连接管理（RPC 模式下为逻辑连接） ---------- */

/*
 * 轻量探活：确认后端真的可用，而不是「假定可用」。
 *
 * 改动动机（原实现的稳定性缺陷）：
 *   原先 connect() 里直接 self.connected = true，这只是把「配置读到了」
 *   当成「后端好了」。后端没起来时，页面照样进入 connected 状态，
 *   随后每个区块的请求才逐个失败、各自报错，用户看到的是满屏报错
 *   而不是一句「服务未启动」。
 *
 * 探针选型（实机实测后确定）：用 events 而不是 netrate。
 *   - netrate 在 ucode 侧直读 /sys/class/net 的计数器，
 *     **根本不经过 Rust 后端**。实测把后端 SIGSTOP 冻结后 netrate 仍
 *     正常返回 —— 拿它探活等于没探。
 *   - events 一定会走「ucode → nc → Rust 后端」全链路，且语义最轻：
 *     只查事件环形缓冲的增量，不下发 AT、不占用 AT 通道、不干扰模组；
 *     后端不可用时 ucode 的 12s 硬超时会兜底返回。
 *
 * 三级结果，供调用方区分处理：
 *   'ok'       后端在跑且能应答
 *   'offline'  后端未运行 / 端口未监听 / 应答超时 —— 走降级，不算异常
 *   'error'    其它意外（保留给未来扩展，当前归入 offline 处理）
 *
 * 无论成败都不抛错：connect() 的契约是「永远 resolve」，
 * 由 state 回调驱动 UI 降级展示，避免调用方因未捕获 rejection 而整页卡住。
 */
ATClient.prototype.healthCheck = function () {
	var self = this;
	/*
	 * 探活预算取 healthTimeout（13s），略大于 ucode 的 12s 硬超时，
	 * 让 ucode 的明确结论先到达，而不是被前端提前掐断。
	 * 之前用过 3s，会把「刚启动、正在做首次串口探测」的正常后端
	 * 误判成未就绪，导致页面无谓降级。
	 */
	return withTimeout(rpcEvents(0), self.healthTimeout, 'HEALTH_TIMEOUT').then(function (resp) {
		resp = resp || {};
		/* ucode 在端口未监听 / 缺 nc / 超时 时都会带 cause 字段并置 success=false */
		if (resp.success === false) {
			self.markBackendDown(resp.cause, resp.error);
			return { status: 'offline', error: resp.error || 'Rust 后端未就绪', cause: resp.cause || '' };
		}
		self.markBackendUp();
		/* events 正常应答形如 { events: [...], seq: N }；只要拿到对象就说明后端活了 */
		return { status: 'ok' };
	}).catch(function (err) {
		var msg = (err && err.message) || '探活失败';
		if (msg === 'HEALTH_TIMEOUT') {
			self.markBackendDown('timeout', null);
			return { status: 'offline', error: '后端响应超时，可能正在启动或已卡住', cause: 'timeout' };
		}
		self.markBackendDown('error', msg);
		return { status: 'offline', error: msg, cause: 'error' };
	});
};

/*
 * 后端可用性标记。用于让所有页面的数据请求共享同一份结论，
 * 避免「探活说离线、数据请求说在线」这种自相矛盾的状态。
 */
ATClient.prototype.markBackendDown = function (cause, error) {
	this.backendKnownDown = true;
	this.backendDownCause = cause || '';
	this.backendDownError = error || '';
};

ATClient.prototype.markBackendUp = function () {
	this.backendKnownDown = false;
	this.backendDownCause = '';
	this.backendDownError = '';
};

/*
 * 连接（RPC 模式下为逻辑连接）。
 *
 * 设计要点：**乐观放行 + 后台探活**，而不是「先探活再决定」。
 *
 * 为什么不能先探活再放行：
 *   后端半死（进程在但卡住）时探活要等满 ucode 的 12s 硬超时，
 *   而所有 10 个页面都在 page() 里 await connect()，
 *   等于每个页面首屏都白白多等 12s —— 这恰恰违背了本次优化目标。
 *
 * 现在的语义：
 *   1. 配置就绪即乐观置 connected='true 并立即 resolve，
 *      页面马上开始加载数据（正常场景零额外延迟）；
 *   2. 探活在后台同时跑：
 *        - 成功  -> 什么也不做（已处于 connected）；
 *        - 失败  -> 置 'degraded' 并派发 state 回调，
 *                   各页面据此弹出「后端未就绪」提示条；
 *                   同时启动退避重连，恢复后自动刷新。
 *   3. 若首个数据请求先于探活返回错误，sendCommand 里的熔断
 *      会把 failStreak 累起来；探活结论到达时二者自然一致。
 *
 * 这样「后端正常」时零开销，「后端异常」时也不额外拖延首屏。
 */
ATClient.prototype.connect = function () {
	if (this.isReady() && this.state !== 'degraded') {
		this.setConnectionState('connected');
		return Promise.resolve(true);
	}
	var self = this;
	var wasDegraded = (this.state === 'degraded' || this.state === 'error');
	this.setConnectionState('connecting');
	return this.configReady.then(function () {
		/*
		 * 乐观放行仅在「首次连接」时使用；从降级态重连时**不**乐观放行。
		 *
		 * 实测问题：若重连也乐观置 connected，时间线会变成
		 *   degraded → connecting → connected → degraded → connecting → ...
		 * 每 3s 一轮，页面的提示条被反复移除/恢复，用户看到闪烁，
		 * 而且每次都会白跑一轮数据请求。因此降级期重连改为
		 * 「先探活、拿到结论再定状态」，这样状态只会在真正恢复时翻转。
		 */
		if (!wasDegraded) {
			self.connected = true;
			self.authenticated = true;
			self.firstPoll = true;
			self.reconnectAttempts = 0;
			if (self.reconnectTimer) {
				clearTimeout(self.reconnectTimer);
				self.reconnectTimer = null;
			}
			self.failStreak = 0;
			self.circuitOpenUntil = 0;
			self.setConnectionState('connected');
			if (self.subscribers.length) self.startPolling();
		}

		/* 探活：首次连接时后台跑（不阻塞首屏）；重连时前台跑（决定状态）。 */
		var hc = self.healthCheck().then(function (res) {
			if (!res || res.status !== 'ok') {
				self.connected = false;
				self.stopPolling();
				self.setConnectionState('degraded', res.error || 'Rust 后端未就绪');
				if (!self.reconnectTimer) self.scheduleReconnect();
			} else if (wasDegraded) {
				/* 重连成功：清熔断、恢复状态 */
				self.connected = true;
				self.authenticated = true;
				self.firstPoll = true;
				self.reconnectAttempts = 0;
				self.failStreak = 0;
				self.circuitOpenUntil = 0;
				if (self.reconnectTimer) {
					clearTimeout(self.reconnectTimer);
					self.reconnectTimer = null;
				}
				self.setConnectionState('connected');
				if (self.subscribers.length) self.startPolling();
			}
			return res;
		});

		if (wasDegraded) {
			/* 重连：等探活结论，让状态翻转只在真有结果时发生 */
			return hc.then(function () { return self.connected; });
		}
		/* 首次连接：立即放行，探活在后台继续 */
		return true;
	}).catch(function (err) {
		/* 配置加载等意外：仍然放行，避免整页不可用；
		 * 数据请求自身会失败并由熔断处理。 */
		console.warn('连接初始化异常', err);
		self.connected = true;
		self.setConnectionState('connected');
		return true;
	});
};

/*
 * 降级期的自动重连（指数退避，5s 起、上限 60s）。
 * 与 pollEvents 失败后的重连共用同一入口，避免出现两条独立的
 * 定时器互相叠加（旧的 bug：pollEvents 里 setTimeout(reconnect, 3000)
 * 与页面自身轮询同时跑，重连风暴）。
 *
 * 退避起点取 5s：ucode 侧的熔断窗口是 15s，探活最坏 12s，
 * 若重连间隔比这个还短，会出现「上一轮探活还没结束、下一轮已经开始」
 * 的叠加，实测表现为状态每 3s 抖动一次、页面提示条闪烁。
 * 5s 起步 + 每轮 +5s 能保证上一轮结论先落地。
 */
ATClient.prototype.scheduleReconnect = function () {
	var self = this;
	if (this.reconnectTimer) return;
	this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
	var delay = Math.min(5000 * this.reconnectAttempts, 60000);
	this.reconnectTimer = setTimeout(function () {
		self.reconnectTimer = null;
		/* 降级态下重新走一次探活；成功则由 connect() 内部恢复 */
		if (!self.connected) {
			self.connect().catch(function () { /* connect 自身不 reject，这里只兜底 */ });
		}
	}, delay);
};

ATClient.prototype.disconnect = function () {
	this.clearPendingCommands('连接已手动断开');
	this.stopPolling();
	if (this.reconnectTimer) {
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}
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
			// 首次连接只对齐序号，不重放服务启动前的事件（与事件流语义一致）
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
			/* 统一经由 scheduleReconnect 走指数退避重连，不再自带一个
			 * 固定 3s 的独立定时器（与原 connect 里的重连定时器叠加时
			 * 会造成重连风暴）。 */
			self.scheduleReconnect();
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

/*
 * 超时预算说明（对应「AT 终端只有 ATI 有回复」的修复）：
 * 后端把「排队等空闲通道」与「等模组应答」拆成了两段独立预算
 * （QUEUE_WAIT_TIMEOUT 8s + COMMAND_TIMEOUT 2s），最坏耗时约 10s。
 * 前端若仍用 8s，会在后端真正返回结果之前先报「命令执行超时」，
 * 把「模组无响应」和「后端还在排队」混为一谈。故前端放宽到 14s，
 * 留出网络与 rpcd 代理余量，让用户看到后端给出的准确原因。
 */
ATClient.prototype.sendCommand = function (command) {
	var self = this;
	this.commandQueue = this.commandQueue.then(function () {
		/*
		 * 不可用判据用 state 而不是 connected：
		 * connect() 已改为「乐观放行」，connected 初始就是 true，
		 * 只有探活结论到达后 state 才是权威状态。若这里只看 connected，
		 * 降级态下仍会照常发请求，继续占用 rpcd worker ——
		 * 这正是实测中「后端冻结时浏览器报 XHR 超时」的直接原因。
		 */
		if (self.state === 'degraded' || self.state === 'error' || self.state === 'disconnected') {
			return {
				success: false,
				error: self.error || '未连接到调制解调器',
				cause: 'not-connected'
			};
		}
		/* 熔断：连续失败到阈值后，短期内直接快速失败，
		 * 不再逐条把 14s 超时预算耗完。
		 *
		 * 动机（原实现的稳定性缺陷）：原先每条命令都独立超时、彼此
		 * 不共享失败记忆。模组掉线时，页面里 20 条串行 AT 会一条一条
		 * 各等 14s，用户要等 4 分钟以上才看到全部失败——
		 * 而实际上第 3 条失败时就已经能断定「通道不可用了」。
		 *
		 * 注意：熔断只针对**连续失败**，任何一次成功都会清零计数，
		 * 因此不会影响正常的偶发抖动。
		 */
		if (self.circuitOpenUntil > Date.now()) {
			var wait = Math.ceil((self.circuitOpenUntil - Date.now()) / 1000);
			return {
				success: false,
				error: 'AT 通道连续失败，已暂停请求（约 ' + wait + 's 后自动恢复）',
				cause: 'circuit-open'
			};
		}
		/* ucode 侧的共享熔断：后端在其它请求里已确认无应答时，
		 * 这里也直接跳过，避免重复触发 12s 硬超时 */
		if (self.backendKnownDown) {
			return {
				success: false,
				error: self.backendDownError || 'Rust 后端无应答，请稍后重试',
				cause: 'circuit-open'
			};
		}
		return withTimeout(rpcAt(command), self.commandTimeout,
			'命令执行超时（模组可能正忙或正在重连，请稍后重试）').then(function (resp) {
			resp = resp || {};
			if (resp.success === false) {
				/* ucode 侧熔断标记生效时，同步到前端，让后续请求立即短路 */
				if (resp.cause === 'circuit-open') {
					self.markBackendDown('circuit-open', resp.error);
				}
				self.noteCommandFailure(resp.cause);
				return { success: false, error: resp.error || '命令执行失败', cause: resp.cause };
			}
			self.noteCommandSuccess();
			self.markBackendUp();
			return { success: true, data: resp.data };
		}).catch(function (err) {
			self.noteCommandFailure('timeout');
			return { success: false, error: (err && err.message) || '命令执行失败', cause: 'timeout' };
		});
	});
	return this.commandQueue;
};

/*
 * 熔断器状态更新。
 *   - 'not-listening' / 'not-connected' / 'circuit-open' 视为
 *     「后端或链路整体不可用」，直接开闸（这些错误重试必然还是失败）。
 *   - 其它失败（含超时、模组返回 ERROR）累计到 3 次才开闸。
 * 开闸时长固定 8s：够后端完成一轮重连退避，又不会让用户等太久。
 *
 * 关键：开闸的同时把 state 置为 'degraded'，让所有页面立刻：
 *   a) 停止继续发请求（sendCommand 开头就会拦下）；
 *   b) 弹出「后端未就绪」提示条。
 * 这一步不能只依赖 healthCheck —— 探活在并发场景下可能还没返回，
 * 而数据请求已经先失败了；让熔断与探活两条路径都能驱动降级，
 * 才能保证「后端异常时页面一定给出提示」。
 */
ATClient.prototype.noteCommandFailure = function (cause) {
	if (cause === 'not-listening' || cause === 'not-connected' || cause === 'circuit-open') {
		this.failStreak = this.failThreshold;
	} else {
		this.failStreak = (this.failStreak || 0) + 1;
	}
	if (this.failStreak >= this.failThreshold) {
		this.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
		if (this.state !== 'degraded') {
			this.connected = false;
			this.stopPolling();
			this.setConnectionState('degraded',
				this.backendDownError || 'AT 通道连续失败，后端可能未运行或已卡住');
			this.scheduleReconnect();
		}
	}
};

ATClient.prototype.noteCommandSuccess = function () {
	this.failStreak = 0;
	this.circuitOpenUntil = 0;
};

/*
 * 批量发送（并发分组）：用于页面初始化 / 定时刷新这类「一批命令一起要」的场景。
 *
 * 与 sendCommand 的区别：sendCommand 走全局 FIFO，保证单条命令的先后次序；
 * sendBatch 把一批命令分成若干组，**组内串行、组间并发**，在不违反
 * 「同一 AT 通道同一时刻只跑一条命令」的前提下，把往返延迟重叠起来。
 *
 * 为什么不是全并发：Rust 后端有优先级门闸（at_queue::PriLock），
 * 全并发只会让请求在门闸里排队，前端侧看到的延迟不变，却放大了
 * rpcd 与 ucode 的并发压力。分组（默认 3 组）是实测比较平衡的取值。
 *
 * 返回与入参等长的结果数组，顺序与入参一致；任一命令失败不影响其它命令，
 * 调用方按索引取用即可（这正是「单个接口失败不影响其他区块」的基础）。
 */
ATClient.prototype.sendBatch = function (commands, groups) {
	var self = this;
	var list = Array.isArray(commands) ? commands : [];
	if (!list.length) return Promise.resolve([]);

	var n = parseInt(groups, 10) || 3;
	if (n < 1) n = 1;
	if (n > list.length) n = list.length;

	var results = new Array(list.length);
	var buckets = [];
	for (var i = 0; i < n; i++) buckets.push([]);
	/* 轮转分配：把耗时差异较大的命令均匀打散到各组，
	 * 避免「一组长、一组空」导致整体被最慢组拖住 */
	for (var j = 0; j < list.length; j++) {
		buckets[j % n].push(j);
	}

	var runners = [];
	for (var b = 0; b < buckets.length; b++) {
		runners.push((function (idxList) {
			var chain = Promise.resolve();
			idxList.forEach(function (idx) {
				chain = chain.then(function () {
					return self.sendCommand(list[idx]).then(function (r) {
						results[idx] = r;
					}).catch(function (err) {
						results[idx] = { success: false, error: (err && err.message) || '命令执行失败' };
					});
				});
			});
			return chain;
		})(buckets[b]));
	}

	return Promise.all(runners).then(function () { return results; });
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

/* ================= UCI 保存/应用编排 =================
 *
 * 背景：直接在页面里连续调用 set → save → apply
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
	// 当前页面是否有未保存更改（true=有）
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
	 * commit 型保存：save 后同样调用 apply，走完整 commit+apply 流程
	 * （与 uciSave 实现一致，会记录 config hash 并触发 procd reload）。
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
function convertSinr(raw) {
	var v = raw === 0 ? -20 : (raw >= 251 ? 30 : -20 + raw * 0.2);
	v = Math.min(30, Math.max(-20, v));
	/* 0.2 dB 步进的二进制浮点误差会拼出 25.200000000000003 这类显示，统一保留 1 位小数 */
	return Math.round(v * 10) / 10;
}
function convertRssi(raw) { return raw === 0 ? -120 : (raw >= 96 ? -25 : -121 + raw); }
/* WCDMA 的 RSCP 与 RSSI 同量程（-120…-25 dBm，96 表示 -25 dBm 及以上） */
/* WCDMA 的 Ec/Io：0 → < -32 dB，步进 0.5 dB，65 → 0 dB 及以上 */
function convertEcio(raw) { return raw === 0 ? -32 : (raw >= 65 ? 0 : -32 + raw * 0.5); }

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

/*
 * 手册 13.5「AT^HCSQ - 查询上报信号强度」的权威字段表（第 323 页）：
 *
 *   <sysmode>   value1       value2       value3       value4    value5
 *   "GSM"       gsm_rssi     -            -            -         -
 *   "WCDMA"     wcdma_rssi   wcdma_rscp   wcdma_ecio   -         -
 *   "LTE"       lte_rssi     lte_rsrp     lte_sinr     lte_rsrq  -
 *   "NR"        5g_rsrp      5g_sinr      5g_rsrq      -         -
 *   "NOSERVICE" -            -            -            -         -
 *
 * 两个制式既不同字段数也不同顺序，绝不能共用同一套下标：
 *   - NR 没有 RSSI，第一个数值就是 RSRP，SINR 在 value2、RSRQ 在 value3；
 *   - LTE 前面多一个 RSSI，SINR 在 value3、RSRQ 在 value4（与 NR 相反）。
 *
 * 注意：若把 LTE 当成 <rsrp>,<rsrq>,<sinr> 解析，4G 下 RSRQ 与 SINR 会整体
 * 错位：^HCSQ: "LTE",45,34,106,19 会被解成 RSRP=-106 / RSRQ=-3 / SINR=-16.2，
 * 而按手册应为 RSSI=-76 / RSRP=-106 / SINR=1.2 / RSRQ=-10 —— 真正的 SINR
 * （106 → 1.2 dB）被当成 RSRQ 吃掉，界面上表现为「4G 下 SINR 读不出来」。
 */
function parseHCSQ(data) {
	var str = extractATData(data, '^HCSQ');
	if (!str) return null;
	var p = str.split(',');
	var mode = p[0] ? p[0].replace(/"/g, '').trim() : '';
	var networkMode;
	if (mode.indexOf('NR') === 0) networkMode = 'NR';
	else if (mode.indexOf('LTE') === 0) networkMode = 'LTE';
	else if (mode.indexOf('WCDMA') === 0) networkMode = 'WCDMA';
	else if (mode.indexOf('GSM') === 0) networkMode = 'GSM';
	else networkMode = mode || '';
	var result = { networkMode: networkMode, rssi: null, rscp: null, ecio: null, rsrp: null, rsrq: null, sinr: null };
	/*
	 * 取第 i 个数值字段并换算。255（手册：未知或不可测）与非数字一律按「无数据」
	 * 返回 null，避免把无效值换算成 -44 dBm / -3 dB 这类看着正常、实为假的数据。
	 */
	function pick(i, conv) {
		if (i >= p.length) return null;
		var v = parseInt(p[i], 10);
		if (isNaN(v) || v === 255) return null;
		return conv(v);
	}
	if (networkMode === 'NR') {
		/* "NR",<5g_rsrp>,<5g_sinr>,<5g_rsrq>（兼容 3 或 4 个数值字段） */
		result.rsrp = pick(1, convertRsrp);
		result.sinr = pick(2, convertSinr);
		result.rsrq = pick(3, convertRsrq);
	} else if (networkMode === 'LTE') {
		/* "LTE",<lte_rssi>,<lte_rsrp>,<lte_sinr>,<lte_rsrq> */
		result.rssi = pick(1, convertRssi);
		result.rsrp = pick(2, convertRsrp);
		result.sinr = pick(3, convertSinr);
		result.rsrq = pick(4, convertRsrq);
	} else if (networkMode === 'WCDMA') {
		/* "WCDMA",<wcdma_rssi>,<wcdma_rscp>,<wcdma_ecio> */
		result.rssi = pick(1, convertRssi);
		result.rscp = pick(2, convertRssi);
		result.ecio = pick(3, convertEcio);
	} else {
		/* "GSM",<gsm_rssi>，以及未知 / 纯数字制式的兜底 */
		result.rssi = pick(1, convertRssi);
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
	obj.downSpeed = obj.rx_rate / 1024;   // Kbps（原始速率）
	obj.upSpeed = obj.tx_rate / 1024;
	return obj;
}

/* ---- MONSC ---- */

function parseMONSC(data) {
	var str = extractATData(data, '^MONSC');
	if (!str) return null;
	var p = str.split(',').map(function (s) { return s.trim(); });
	/*
	 * 两种实测格式，按首字段是否为纯数字自动判别：
	 *   格式 A（NR，带前导制式）:
	 *     ^MONSC: NR,<mcc>,<mnc>,<tac>,<flag>,<cid>,<pci>,<arfcn>,<rsrp>,<rsrq>,<sinr>
	 *     实测: ^MONSC: NR,460,00,504990,1,C2840C002,80,149002,-65,-10,28
	 *     RSRP/RSRQ/SINR 为直接工程值（dBm/dB/dB），无需 convert* 换算。
	 *     与 ^HCSQ: "NR",77,236,31 独立交叉验证一致（77→-63, 236→27.2）。
	 *   格式 B（旧编码，无前导制式，直接给出编码值）:
	 *     ^MONSC: <mcc>,<mnc>,<lac>,<cid>,<pci>,<ch>,<rsrp_raw>,<rsrq_raw>,<sinr_raw>,<sysmode>
	 */
	var hasLeadingMode = p.length > 0 && !/^-?\d+$/.test(p[0]);
	var d;
	if (hasLeadingMode && (p[0] || '').replace(/"/g, '').trim().toUpperCase() === 'LTE') {
		/*
		 * 手册 13.9.3/13.9.5：LTE 的 <cell_paras> 与 NR 布局差异很大（实测
		 * ^MONSC: LTE,460,00,38400,D975244,8,24C8,-85,-10,-54）：
		 *   LTE,<mcc>,<mnc>,<tac_hex>,<cid_hex>,<pci_hex>,<arfcn_hex>,<rsrp>,<rsrq>,<rssi>
		 * 与 NR 相比：没有 flag 位、PCI/ARFCN/TAC 为十六进制、末位是 RSSI
		 * （-90~-25 dBm 工程值），且 **没有 SINR 字段**——4G 的 SINR 一律由
		 * ^HCSQ 兜底补齐（见 network_status 的 needHcsq 逻辑）。
		 * 注意：若直接套用 NR 布局，4G 下 cid/pci/channel/rsrp/rsrq 会全部错位
		 * （rsrp 取到 rsrq、rsrq 取到 RSSI、channel 变成 "-85"）。
		 */
		d = {
			sysMode: 'LTE',
			mcc: p[1] || '',
			mnc: p[2] || '',
			lac: p[3] || '',
			cid: p[4] || '',
			pci: p[5] !== undefined && p[5] !== '' ? parseInt(p[5], 16) : 0,
			channel: p[6] || '',
			rsrp: p[7] !== undefined && p[7] !== '' ? parseFloat(p[7]) : null,
			rsrq: p[8] !== undefined && p[8] !== '' ? parseFloat(p[8]) : null,
			sinr: null,
			rssi: p[9] !== undefined && p[9] !== '' ? parseFloat(p[9]) : null
		};
	} else if (hasLeadingMode) {
		d = {
			sysMode: p[0] || '',
			mcc: p[1] || '',
			mnc: p[2] || '',
			lac: p[3] || '',
			cid: p[5] || '',
			pci: p[6] !== undefined ? parseInt(p[6], 10) : 0,
			channel: p[7] || '',
			rsrp: p[8] !== undefined && p[8] !== '' ? parseFloat(p[8]) : null,
			rsrq: p[9] !== undefined && p[9] !== '' ? parseFloat(p[9]) : null,
			sinr: p[10] !== undefined && p[10] !== '' ? parseFloat(p[10]) : null
		};
	} else {
		d = {
			mcc: p[0] || '',
			mnc: p[1] || '',
			lac: p[2] || '',
			cid: p[3] || '',
			pci: p[4] ? parseInt(p[4], 10) : 0,
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

/* ---- HFREQINFO 载波 ---- */

/*
 * ^HFREQINFO:<n>,<sysmode>,<band_classN>,<dl_fcnN>,<dl_freqN>,<dl_bwN>,
 *            <ul_fcnN>,<ul_freqN>,<ul_bwN>   （N 为载波号，NR 最多 4 个）
 *
 * 手册 13.16.3 权威字段顺序（实测 NR n41）：
 *   0,7,41,513000,2565000,100000,513000,2565000,100000
 *   -> n=0  sysmode=7(NR)  band=41  dl_fcn=513000
 *      dl_freq=2565000kHz(2565MHz)  dl_bw=100000kHz(100MHz)
 *      ul_fcn=513000  ul_freq=2565000kHz  ul_bw=100000kHz
 *
 * 注意：本命令只上报频率/带宽，不返回 RSRP/RSRQ/SINR。信号质量一律取自
 * ^MONSC（13.9.3），不要在此处解析信号字段。
 */
function parseHFREQINFO(data) {
	var out = [];
	var lines = extractATDataMultiline(data, '^HFREQINFO');
	for (var i = 0; i < lines.length; i++) {
		var p = lines[i].split(',').map(function (s) { return s.trim(); });
		if (!p.length) continue;
		var syscode = p[1] ? p[1].replace(/"/g, '').trim() : '';
		out.push({
			n: p[0] !== undefined ? parseInt(p[0], 10) : 0,
			sysModeCode: syscode,
			sysMode: sysModeName(syscode),
			band: p[2] ? p[2].trim() : '',
			dlFcn: p[3] ? p[3].trim() : '',
			dlFreqKHz: p[4] ? parseInt(p[4], 10) : 0,
			dlBwKHz: p[5] ? parseInt(p[5], 10) : 0,
			ulFcn: p[6] ? p[6].trim() : '',
			ulFreqKHz: p[7] ? parseInt(p[7], 10) : 0,
			ulBwKHz: p[8] ? parseInt(p[8], 10) : 0
		});
	}
	return out;
}

/*
 * <sysmode> 制式编码（手册 13.16.3，^HFREQINFO 专用）：
 *   1 GSM（不支持）  3 WCDMA（不支持）  6 LTE  7 NR
 * 与 ^SYSINFOEX 的 <sysmode>（6=LTE、11=NR-5GC）不同，勿混用。
 */
function sysModeName(code) {
	if (code === '' || code == null) return '';
	var table = { '1': 'GSM', '3': 'WCDMA', '6': 'LTE', '7': 'NR' };
	var key = String(code).trim();
	return table[key] || String(code);
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
 * 取模组与路由器之间的 USB 链路速率（Mbps，sysfs 自动识别）。
 * 返回 Promise<{success, found, speed_mbps, product, version}>。
 */
function fetchUsb() {
	return withTimeout(rpcUsb(), 4000, 'USB 信息读取超时')
		.then(function (resp) {
			resp = resp || {};
			if (resp.success === false) {
				return { success: false, error: (resp && resp.error) || '读不到 USB 信息' };
			}
			return {
				success: true,
				found: !!Number(resp.speed_mbps),
				speed_mbps: Number(resp.speed_mbps) || 0,
				product: resp.product || '',
				version: resp.version || ''
			};
		})
		.catch(function (err) {
			return { success: false, error: (err && err.message) || 'USB 信息读取失败' };
		});
}

/*
 * USB 速率（Mbps）格式化成人话：5000 → "5.0 Gbps（USB 3.0）"。
 * sysfs 的 speed 单位为 Mbps，对应 USB 规范速率：
 *   12 → USB 1.x  480 → USB 2.0  5000 → USB 3.0  10000 → USB 3.1  20000 → USB 3.2
 */
function usbSpeedText(mbps) {
	var m = Number(mbps) || 0;
	if (m <= 0) return '';
	var g = (m / 1000).toFixed(1);
	var rate = m >= 1000 ? g + ' Gbps' : Math.round(m) + ' Mbps';
	var spec = '';
	if (m === 12) spec = 'USB 1.x';
	else if (m === 480) spec = 'USB 2.0';
	else if (m === 5000) spec = 'USB 3.0';
	else if (m === 10000) spec = 'USB 3.1';
	else if (m === 20000) spec = 'USB 3.2';
	return spec ? rate + '（' + spec + '）' : rate;
}

var AtWs = {
	client: atClient(),
	netRate: fetchNetRate,
	usb: fetchUsb,
	usbSpeedText: usbSpeedText,
	extractATData: extractATData,
	extractATDataMultiline: extractATDataMultiline,
	convertRsrp: convertRsrp,
	convertRsrq: convertRsrq,
	convertSinr: convertSinr,
	convertRssi: convertRssi,
	convertEcio: convertEcio,
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
	sysModeName: sysModeName,
	parsePDCP: parsePDCP,
	parseRawData: parseRawData,
	PDCP_FIELDS: PDCP_FIELDS,
	signalColor: signalColor,
	psRegText: psRegText,
	operatorFromCode: operatorFromCode,
	qciLabel: qciLabel,
	bandName: bandName,
	isUnsolicitedText: isUnsolicitedText,
	uci: AtUci
};

/* LuCI factory 必须返回 Class 子类；挂 window.AtWs 供页面使用 */
var AtWsClass = L.Class.extend(AtWs);
if (typeof window !== 'undefined') {
	window.AtWs = new AtWsClass();
}
return AtWsClass;
