'use strict';
'require at-webserver/rpc';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Ui, Mt5700 */

/**
 * 语音通话 - 通话管理台（拨号 / 接听 / 拒接 / 挂断 / DTMF / 记录）
 *
 * 功能（手册第 4 章呼叫控制 + 第 5 章网络服务 + 第 12 章鼎桥私有 URC）：
 *   · 拨号盘（0-9 / * / # / 国际前缀 +，退格、清空）
 *   · 拨打 / 接听 / 拒接 / 挂断 / 通话中 DTMF
 *   · 通话状态（^CCALLSTATE 等 URC 即时触发刷新 + AT+CLCC 2s 轮询兜底）
 *   · 通话时长（通话中按 active 起算；结束后以 ^CEND 给的秒数为准）
 *   · 麦克风静音（AT+CMUT）与扬声器音量读数（AT+CLVL）
 *   · 通话记录（设备侧持久化 /etc/mt5700/call-log.json，跨浏览器可见）
 *   · 来电铃声（Web Audio 生成，手机浏览器可响）
 *
 * ★★★ 声音的断点在哪（2026-10-22 六出口实测封死，详见 REFERENCE §声音）：
 *   本模组的语音音频在物理上就没引到软件能读到的地方：
 *   · USB：两个配置都解析过，六个接口全是 CDC-NCM / CDC-Data / vendor(ff/06)×4，
 *     **没有 Audio Class、没有等时端点**。
 *   · 手册：244 条命令里没有任何音频数据通道（^CSCHANNELINFO 只报带宽状态）。
 *   · AT 串口：通话中 ttyUSB 各 0 字节。
 *   · 模式切换：AT^SETMODE 九种模式全是数据口，无一种带音频。
 *   · 蓝牙：手册零条蓝牙命令，没有 HFP 可走。
 *   · SoC：AFE 节点 status=disabled，无 /dev/snd；通话中 PCM 引脚采样 120 次全 0。
 *   ⇒ 信令全通、音频断在硬件。想听到声音只有一条路：**换带 USB Audio Class
 *     的模组**。软件侧已经备好 —— 插件随包带了 11 个 ALSA 内核模块，
 *     检测到 UAC 接口就自动装载，不需要重编固件（见 root/usr/share/mt5700/audio-ko.sh）。
 *
 * ★ 状态来源：URC 打头，CLCC 兜底（2026-10-22 实测推翻了此前这里的结论）。
 *   此前写着「私有 URC 受 AT^CURC 控制、实测一个都不报」—— 那是误判：它们
 *   是**呼叫期** URC，空闲时自然安静，当时只是没有通话可报。
 *   实测拨 10086 全程一条开启命令都没发，事件链完整到达：
 *     ATD 响应内 ^CCALLSTATE:1,0,1 + ^ORIG:1,0
 *     t+2s 1,1,1 → t+6s 1,2,1 + ^CONF:1 → t+7s ^CONN:1,0 + 1,3,1
 *     CHUP 后 ^CEND:1,25,104,0 + 1,4,1
 *   而 +CLCC 到 t+12s 才变 stat=0，晚了 5 秒。
 *   ⇒ 不需要 AT+CRC，更不需要会卡死整条串口 12~15 秒的 AT+CLIP（红线 73）。
 *
 * ★ 但状态值仍由 CLCC 现算：^CCALLSTATE 的 <state> 与 CLCC 的 <stat> 是两套
 *   编号（同一个「接通」，一个是 3、一个是 0），且 CLCC 带方向、号码、呼叫 ID，
 *   是唯一能渲染完整那一行的来源。URC 只负责「现在就去读一次」，见 urcKick。
 *
 * ★ 来电仍以 CLCC 为准：+CLIP 是否上报取决于模组的 CLIP 设置，
 *   而 incoming_call 推送里没有呼叫 ID 与方向。
 *
 * ★ 号码校验前后端各一道：前端为了即时反馈，后端 callNumberOk 是真门禁
 *   （号码会原样进 AT 命令行，分号能分隔多条命令）。
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('语音通话', '拨打、接听、拒接、挂断、DTMF 与通话记录');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 能力提示 ---------- */
		/* 必须常驻：不写清楚，用户会把「接通了没声音」当成功能坏了。详细依据见 README §已知限制。 */
		body.appendChild(E('div', {
			'class': 'mt5700-notice mt5700-notice-warning'
		}, '这一页只管信令：能拨能接、状态与记录齐全，但通话内容听不到'
			+ '（MT5700M-CN 没有 USB Audio Class，换带 UAC 的模组即可）。'));

		/* ---------- 常量 ---------- */

		/* CLCC <state> 字段（手册 5.11） */
		var CALL_STATE = {
			0: '通话中',
			1: '保持中',
			2: '拨号中',
			3: '回铃中',
			4: '来电振铃',
			5: '等待中'
		};
		var CALL_DIR = { 0: '本机呼叫', 1: '网络来电' };
		var RESULT_TEXT = {
			answered: '已接通',
			missed: '未接',
			rejected: '已拒接',
			canceled: '已取消',
			failed: '未接通'
		};

		/*
		 * 阶段令牌 → 文案。令牌由后端 callStageOf 给（见 mt5700.uc），
		 * 取值与厂商 modemwebui-server 的状态机对齐：
		 *   unknown / idle / requesting / dialing / alerting / ringing /
		 *   waiting / active / held / ended
		 * requesting（"等待模组确认呼出"）是厂商的本地时序态，轮询模型观测
		 * 不到，本页不会收到；留着文案是为了两边共用一张表时不缺项。
		 */
		var STAGE_TEXT = {
			unknown: '状态未知',
			idle: '空闲',
			requesting: '等待模组确认呼出',
			dialing: '正在呼出',
			alerting: '对方振铃',
			ringing: '来电振铃',
			waiting: '来电等待',
			active: '已接通',
			held: '通话保持',
			ended: '已结束'
		};

		/* 前端号码白名单：与后端 callNumberOk 同口径（后端才是真门禁） */
		var NUMBER_RE = /^\+?[0-9*#]+$/;

		/* DTMF 键盘布局（与普通电话一致） */
		var KEYPAD = [
			['1', '2', '3'],
			['4', '5', '6'],
			['7', '8', '9'],
			['*', '0', '#']
		];

		/*
		 * 键面字母辅助（传统电话布局 2=ABC … 9=WXYZ）。
		 * 纯装饰：只显示、不进输入值（本页只拨号码，不搞 T9）。
		 */
		var KEY_LETTERS = {
			'2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL',
			'6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ'
		};

		/* ---------- 状态 ---------- */

		/*
		 * phase 由 CLCC 轮询结果驱动，不靠本地记忆勾选状态：
		 *   idle      无在途呼叫
		 *   outgoing  本机已发起（dialing/alerting）
		 *   incoming  网络来电（振铃）
		 *   active    已接通（含保持）
		 * busy 只挡「用户连点」，不参与状态判定。
		 */
		var st = {
			phase: 'idle',
			stage: null,      /* 后端 callStageOf 给的令牌；null＝还没读到过（红线 23） */
			/*
			 * voice_domain：只有 ^CCALLSTATE 的第三字段有，CLCC 不报。
			 * 0＝3GPP CS / 1＝IMS / 2＝3GPP2 CS / 3＝不在任何域。
			 * null＝本轮还没有 URC 观测（与「0 就是 CS 域」不是一回事，红线 23）。
			 */
			domain: null,
			number: '',       /* 拨号盘输入 / 在途呼叫号码 */
			activeAt: 0,      /* 首个 active 出现的时刻（时长基准） */
			calls: [],        /* 最近一次 status 的全部在途呼叫 */
			mute: null,       /* null＝还没读到（与「未静音 0」不是一回事，红线 23） */
			volume: null,     /* 同上 */
			busy: false,
			err: '',
			/*
			 * channelError：最近一次 status 读失败（后端无 call 方法 / AT 通道
			 * 故障）。与 backendOk 分工：backendOk 说"后端在不在"，这个说
			 * "刚才那一次通没通"。后者喂给 applyGates 灰化按钮（厂商 usable
			 * 纪律）。读失败时**不清** stage/calls —— 那会把故障渲染成空闲。
			 */
			channelError: false,
			ringEnabled: true,
			backendOk: true   /* false＝rpcd 没有 mt5700.call（后端未升级） */
		};

		/* 通话跟踪：进入非 idle 时建，回到 idle 时落一条记录 */
		var track = null;

		/* ---------- 事件驱动的辅助状态 ---------- */

		/*
		 * ^CEND 带来的权威通话时长（秒）。
		 * 为什么需要它：CLCC 在通话结束时直接消失，轮询拿不到时长；而前端用
		 * Date.now() 差值算，切后台、页面重载都会失准。实测 `^CEND: 1,25,104,0`
		 * 的第二个字段就是 25 秒 —— 后端直接给了答案，不用自己推。
		 */
		var pendingDuration = null;

		/* 上一次 CLCC 刷新的时刻 + 合并定时器，见 urcKick() */
		var lastStatusAt = 0;
		var kickTimer = 0;

		/*
		 * 事件轮询间隔（rpc.js 默认 1500ms）。
		 *
		 * ★ 为什么本页要压小：模组把 ^CCALLSTATE 写进事件总线是即时的，但前端
		 *   要等下一次 pollEvents 才看得到。默认 1500ms 意味着「URC 事件驱动」
		 *   相对原来的 2s CLCC 轮询只快 0.4 秒 —— 差不多等于没做。
		 *   通话是唯一「秒级可感知」的场景（来电响铃、通话计时），所以只在
		 *   本页压到 500ms，离开立刻还原。
		 *
		 * ★ 为什么敢压：events 是纯内存方法（读 500 条环形缓冲），不碰串口，
		 *   也不占用 AT 通道 —— 真正打在模组上的仍然只有那条 2s 的 CLCC。
		 *   500ms × 1 次 = 每秒 2 次轻量调用，占 rpcd 的量级在个位数百分比。
		 *
		 * ★ 为什么必须还原：pollInterval 是 AtWs.client 这个**共享单例**的属性。
		 *   不还原会让之后每个页面都按 500ms 拉 events，白白挤 rpcd 单线程
		 *   （红线 63：一条慢调用能拖住整个 LuCI）。
		 */
		var savedPollInterval = null;

		function tightenPoll() {
			var c = AtWs.client;
			if (!c || typeof c.pollInterval !== 'number') { return; }
			if (savedPollInterval == null) { savedPollInterval = c.pollInterval; }
			c.pollInterval = 500;
			/* setInterval 已按旧间隔在跑，要重开才会用新值；
			 * 没有订阅者时不动定时器 —— subscribe 时会用新的间隔启动 */
			if (c.subscribers && c.subscribers.length &&
				c.stopPolling && c.startPolling) {
				c.stopPolling();
				c.startPolling();
			}
		}

		function restorePoll() {
			var c = AtWs.client;
			if (!c || savedPollInterval == null) { return; }
			c.pollInterval = savedPollInterval;
			savedPollInterval = null;
			/* 此处本页仍在订阅，重启定时器是安全的；紧接着 unsubscribe 会在
			 * 订阅者为空时自动 stopPolling（见 rpc.js 的 unsubscribe） */
			if (c.subscribers && c.subscribers.length &&
				c.stopPolling && c.startPolling) {
				c.stopPolling();
				c.startPolling();
			}
		}

		/* ---------- DOM ---------- */

		var statusBadge = Mt5700.badge('空闲', 'neutral');
		var muteBadge = Mt5700.badge('静音 —', 'neutral');
		var headerExtra = E('span');
		headerExtra.appendChild(statusBadge);
		headerExtra.appendChild(E('span', {}, ' '));
		headerExtra.appendChild(muteBadge);

		var statusCard = Mt5700.card('通话状态', '状态来自 AT+CLCC 轮询（2 秒一次）', headerExtra);
		var statusMain = E('div');
		statusCard._body.appendChild(statusMain);

		var statusMetrics = E('div', { 'class': 'mt5700-metrics' });
		statusMain.appendChild(statusMetrics);
		var metricNumber = Mt5700.metric('号码', '—');
		var metricState = Mt5700.metric('状态', '空闲');
		var metricDir = Mt5700.metric('方向', '—');
		var metricDuration = Mt5700.metric('时长', '—');
		var metricVolume = Mt5700.metric('音量', '—');
		statusMetrics.appendChild(metricNumber);
		statusMetrics.appendChild(metricState);
		statusMetrics.appendChild(metricDir);
		statusMetrics.appendChild(metricDuration);
		statusMetrics.appendChild(metricVolume);

		/*
		 * 动作行走 .mt5700-callbar：CSS 负责按钮等宽（flex:1 + min-width），
		 * 不再逐按钮写内联定宽 —— 文案在「挂断↔拒接」「静音↔取消静音」
		 * 之间切换时整行宽度不抖（红线 41）。
		 */
		var statusActions = E('div', { 'class': 'mt5700-callbar' });
		statusMain.appendChild(statusActions);
		/*
		 * 四个通话动作**常驻可见**，用灰化表达"此刻不可用"（厂商 modemwebui
		 * call.js 的形态：答案/挂断/静音一直在位，只改 disabled）。
		 * 规格（大键 + 等宽）由 .mt5700-btn-lg + .mt5700-callbar 的 CSS 负责，
		 * 这里不再写内联样式。
		 *
		 * ★ 为什么从 display 隐藏改成常驻：上一版把"接听/挂断/静音"按状态
		 *   隐藏，用户在原地说"没看到接停电话"—— 找不到的按钮等于没有，
		 *   尤其来电就响那么几秒，藏起来的接听键根本指望不上。
		 */
		var answerBtn = Mt5700.successButton('接听', function () { doAnswer(); });
		var hangupBtn = Mt5700.dangerButton('挂断', function () { doHangup(); });
		var muteBtn = Mt5700.button('静音', function () { toggleMute(); }, 'secondary');
		var ringBtn = Mt5700.ghostButton('铃声：开', function () {
			st.ringEnabled = !st.ringEnabled;
			if (!st.ringEnabled) { ringStop(); }
			ringBtn.textContent = '铃声：' + (st.ringEnabled ? '开' : '关');
		});
		[answerBtn, hangupBtn, muteBtn, ringBtn].forEach(function (b) {
			b.classList.add('mt5700-btn-lg');
		});
		statusActions.appendChild(answerBtn);
		statusActions.appendChild(hangupBtn);
		statusActions.appendChild(muteBtn);
		statusActions.appendChild(ringBtn);

		var statusErr = E('p', { 'class': 'mt5700-hint' }, '');
		statusCard._body.appendChild(statusErr);

		body.appendChild(statusCard);

		/* ---------- 拨号盘 ---------- */

		var dialerCard = Mt5700.card('拨号盘', '输入号码后点「拨打」；* 与 # 可用于 USSD 与补充业务码');
		var dialerBody = E('div');
		dialerCard._body.appendChild(dialerBody);
		body.appendChild(dialerCard);

		var numberInput = Mt5700.input('text', '输入号码（数字、*、#，国际号码以 + 开头）');
		/* 大号显示屏样式走 .mt5700-num-display（等宽数字 + 居中 + 聚焦环），
		 * 不再手写内联字号 —— 那套写法在暗色下没有对应定义。 */
		numberInput.classList.add('mt5700-num-display');
		numberInput.setAttribute('inputmode', 'tel');
		numberInput.addEventListener('input', function () {
			/* 即时过滤：把白名单外字符直接挡在外面，错误在输入时就消除 */
			var v = numberInput.value;
			var cleaned = '';
			for (var i = 0; i < v.length; i++) {
				var c = v.charAt(i);
				if (i === 0 && c === '+') { cleaned += c; continue; }
				if ('0123456789*#'.indexOf(c) >= 0) { cleaned += c; }
			}
			if (cleaned !== v) { numberInput.value = cleaned; }
			st.number = numberInput.value;
		});
		dialerBody.appendChild(Mt5700.formGroup('号码', numberInput));

		/*
		 * 键盘走 .mt5700-keypad / .mt5700-keypad-key（CSS v5.6.0 通用件）：
		 * 3 列方键网格 + 键面双行（大号数字 + 字母辅助行）。
		 * 键的点击逻辑不变：空闲输号码、已接通送 DTMF（见下）。
		 */
		var keypad = E('div', { 'class': 'mt5700-keypad' });
		KEYPAD.forEach(function (row) {
			row.forEach(function (key) {
				var b = Mt5700.button('', function () {
					numberInput.value += key;
					st.number = numberInput.value;
					/*
					 * 同一排键盘两用：空闲＝输号码，**已接通**＝送 DTMF。
					 * 振铃态不发（AT+VTS 只在通话中有效，发了也是 ERROR），
					 * 保持态也不发（音频通道在远端）。
					 */
					if (st.phase === 'active') { sendDtmf(key); }
				}, 'secondary');
				b.classList.add('mt5700-keypad-key');
				b.appendChild(E('span', { 'class': 'k' }, key));
				if (KEY_LETTERS[key]) {
					b.appendChild(E('span', { 'class': 'sub' }, KEY_LETTERS[key]));
				}
				keypad.appendChild(b);
			});
		});
		dialerBody.appendChild(keypad);

		var dialerActions = E('div', { 'class': 'mt5700-callbar' });
		dialerBody.appendChild(dialerActions);
		var dialBtn = Mt5700.primaryButton('拨打', function () { doDial(); });
		/* 与状态卡的通话键同规格：这一页的主角是「打」和「接」 */
		dialBtn.classList.add('mt5700-btn-lg');
		var backspaceBtn = Mt5700.ghostButton('退格', function () {
			numberInput.value = numberInput.value.slice(0, -1);
			st.number = numberInput.value;
		});
		var clearBtn = Mt5700.ghostButton('清空', function () {
			numberInput.value = '';
			st.number = '';
		});
		dialerActions.appendChild(dialBtn);
		dialerActions.appendChild(backspaceBtn);
		dialerActions.appendChild(clearBtn);

		dialerBody.appendChild(E('p', { 'class': 'mt5700-hint' }, ''
			+ '通话会产生运营商通话费（10086 等客服号通常免费）。'
			+ '通话内容听不到 —— 音频断点见页面顶部说明。'));

		/* ---------- 通话记录 ---------- */

		var logCard = Mt5700.card('通话记录',
			'保存在设备上（/etc/mt5700/call-log.json），换浏览器也看得到；最多 100 条');
		var logHost = E('div');
		logCard._body.appendChild(logHost);

		var logActions = E('div', { 'class': 'mt5700-panel-actions' });
		logCard._body.appendChild(logActions);
		logActions.appendChild(Mt5700.ghostButton('刷新', function () { loadLog(); }));
		logActions.appendChild(Mt5700.ghostButton('清空', function () { clearLog(); }));

		body.appendChild(logCard);

		/* ---------- 动作 ---------- */

		function setBusy(on) {
			st.busy = on;
			/*
			 * 只改 busy 标志，禁用判定统一交给 applyGates —— 两处各写一套
			 * disabled 判据必然漂移（一次加"通道故障"条件就会漏掉一处）。
			 */
			applyGates();
		}

		function setErr(msg) {
			st.err = msg || '';
			statusErr.textContent = st.err;
		}

		function doDial() {
			var num = String(numberInput.value || '').trim();
			if (!num) { Mt5700.error('请先输入号码'); return; }
			if (!NUMBER_RE.test(num)) {
				Mt5700.error('号码含非法字符（只允许数字、*、# 与开头的 +）');
				return;
			}
			if (st.busy) { return; }
			primeRing();
			setBusy(true);
			setErr('');
			AtWs.call('dial', num).then(function (res) {
				setBusy(false);
				if (!res.success) {
					setErr(res.error || '拨号失败');
					Mt5700.error(res.error || '拨号失败');
					return;
				}
				/* ATD 回 OK 只代表「命令被接受」；成败看后续 CLCC */
				st.number = num;
				Mt5700.info('已发起呼叫 ' + num + '，接通情况以通话状态为准');
				refreshStatus();
			}).catch(function () {
				setBusy(false);
				setErr('拨号请求失败');
			});
		}

		function doAnswer() {
			if (st.busy) { return; }
			primeRing();
			setBusy(true);
			AtWs.call('answer').then(function (res) {
				setBusy(false);
				if (!res.success) {
					setErr(res.error || '接听失败');
					return;
				}
				refreshStatus();
			}).catch(function () {
				setBusy(false);
				setErr('接听请求失败');
			});
		}

		function doHangup() {
			if (st.busy) { return; }
			/* 来电振铃时挂断＝拒接：记录里区分「未接」与「已拒接」 */
			if (st.phase === 'incoming' && track) { track.rejected = true; }
			setBusy(true);
			AtWs.call('hangup').then(function (res) {
				setBusy(false);
				if (!res.success) {
					setErr(res.error || '挂断失败');
					return;
				}
				/* 挂断后立即刷一次，让「通话中」尽快回到空闲 */
				refreshStatus();
			}).catch(function () {
				setBusy(false);
				setErr('挂断请求失败');
			});
		}

		function toggleMute() {
			if (st.busy) { return; }
			var next = (st.mute === 1) ? 0 : 1;
			setBusy(true);
			AtWs.call('mute', null, String(next)).then(function (res) {
				setBusy(false);
				if (!res.success) {
					setErr(res.error || '静音设置失败');
					return;
				}
				/* 写命令回 OK 不等于状态已变 —— 回读一次 */
				refreshInfo();
			}).catch(function () {
				setBusy(false);
				setErr('静音设置失败');
			});
		}

		function sendDtmf(digit) {
			if (st.busy) { return; }
			setBusy(true);
			AtWs.call('dtmf', null, digit).then(function (res) {
				setBusy(false);
				if (!res.success) {
					setErr(res.error || 'DTMF 发送失败');
				}
			}).catch(function () {
				setBusy(false);
				setErr('DTMF 发送失败');
			});
		}

		/* ---------- 通话记录读写 ---------- */

		function fmtClock(ts) {
			if (!ts) { return '—'; }
			var d = new Date(ts * 1000);
			function p2(x) { return (x < 10 ? '0' : '') + x; }
			return p2(d.getMonth() + 1) + '-' + p2(d.getDate())
				+ ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
		}

		function fmtSeconds(sec) {
			var s = Number(sec) || 0;
			var m = Math.floor(s / 60);
			s = s % 60;
			return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
		}

		function renderLog(records) {
			logHost.innerHTML = '';
			var rows = (records || []).map(function (r) {
				var redialBtn = Mt5700.ghostButton('重拨', function () {
					numberInput.value = r.number || '';
					st.number = numberInput.value;
					doDial();
				});
				/* 方向优先用后端的 direction 字符串（厂商口径），老记录退回 dir 整数 */
				var dirText;
				if (r.direction === 'incoming') { dirText = '来电'; }
				else if (r.direction === 'outgoing') { dirText = '去电'; }
				else { dirText = (r.dir === 1) ? '来电' : '去电'; }
				return [
					fmtClock(r.time),
					r.number == null ? '—' : String(r.number),
					dirText,
					RESULT_TEXT[r.result] || (r.result == null ? '—' : String(r.result)),
					r.duration ? fmtSeconds(r.duration) : '—',
					redialBtn
				];
			});
			logHost.appendChild(Mt5700.table(
				['时间', '号码', '方向', '结果', '时长', ''], rows, { striped: true }));
		}

		function loadLog() {
			AtWs.call('loglist').then(function (res) {
				if (!res || !res.success) {
					/*
					 * ★「读不到」与「没有记录」分开（红线 23）：
					 *   失败时画错误提示，不画「暂无数据」那张空表。
					 */
					logHost.innerHTML = '';
					logHost.appendChild(E('p', { 'class': 'mt5700-hint' },
						(res && res.error) || '通话记录读取失败'));
					return;
				}
				renderLog(res.records || []);
			}).catch(function () {
				logHost.innerHTML = '';
				logHost.appendChild(E('p', { 'class': 'mt5700-hint' }, '通话记录读取失败'));
			});
		}

		function clearLog() {
			AtWs.call('logclear').then(function (res) {
				if (!res || !res.success) {
					Mt5700.error((res && res.error) || '清空失败');
					return;
				}
				loadLog();
			}).catch(function () { Mt5700.error('清空失败'); });
		}

		/*
		 * 通话结束时落一条记录。字段与后端 callLogEntry 的白名单一一对应；
		 * number 必须过前端白名单（后端还会再校验一次）。
		 * ★ 记录写失败不打扰用户：它是日志，不该因为一次写盘失败就弹错。
		 */
		function saveRecord(t) {
			var num = String(t.number || '');
			if (!num || !NUMBER_RE.test(num)) { return; }
			var result;
			if (t.answeredAt) { result = 'answered'; }
			else if (t.rejected) { result = 'rejected'; }
			else if (t.dir === 1) { result = 'missed'; }
			else { result = 'canceled'; }
			var rec = {
				number: num,
				dir: t.dir,
				/* direction 与 dir 同义，多给一份可读字符串：厂商口径的消费方
				 * （以及换语言/换主题时的展示）不必再各自维护 0/1 → 文案映射 */
				direction: (t.dir === 1) ? 'incoming' : 'outgoing',
				result: result,
				/*
				 * 优先用 ^CEND 给的秒数：模组自己是计时方，切后台、页面重载都不影响。
				 * 没有（老后端没转发这条 URC，或轮询先看到空闲而错过窗口）才回落到
				 * 前端差值 —— 那是降级路径，不是等价路径。
				 */
				duration: (t.endedDuration != null) ? t.endedDuration
					: (t.answeredAt ? Math.round((Date.now() - t.answeredAt) / 1000) : 0),
				time: Math.round(t.startedAt / 1000)
			};
			AtWs.call('logadd', null, null, JSON.stringify(rec)).then(function (res) {
				if (res && res.success) { loadLog(); }
			}).catch(function () { });
		}

		/* ---------- 来电铃声（Web Audio） ---------- */

		/*
		 * ★ 为什么用振荡器而不是音频文件：不引外部资源，且回铃音本来就是
		 *   450~480Hz 的断续正弦，两个振荡器足够。这是本页唯一能"让手机
		 *   出声"的地方 —— 但它只是**提醒**，不是通话。
		 * ★ 浏览器自动播放策略：AudioContext 在无用户手势时处于 suspended，
		 *   resume() 必须在手势回调里调。所以页面加载后挂一次性 click 预热；
		 *   若来电时仍是 suspended，就只靠 toast —— 不假装响了。
		 */
		var ring = { ctx: null, timer: 0 };

		function primeRing() {
			var Ctx = window.AudioContext || window.webkitAudioContext;
			if (!Ctx) { return; }
			try {
				if (!ring.ctx) { ring.ctx = new Ctx(); }
				if (ring.ctx.state === 'suspended') { ring.ctx.resume(); }
			} catch (e) { ring.ctx = null; }
		}

		function ringBurst() {
			if (!ring.ctx) { return; }
			var now = ring.ctx.currentTime;
			[450, 480].forEach(function (f) {
				var osc = ring.ctx.createOscillator();
				var gain = ring.ctx.createGain();
				osc.type = 'sine';
				osc.frequency.value = f;
				gain.gain.setValueAtTime(0.0001, now);
				gain.gain.exponentialRampToValueAtTime(0.12, now + 0.05);
				gain.gain.setValueAtTime(0.12, now + 0.85);
				gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
				osc.connect(gain);
				gain.connect(ring.ctx.destination);
				osc.start(now);
				osc.stop(now + 1.05);
			});
		}

		function ringStart() {
			if (!st.ringEnabled || ring.timer) { return; }
			primeRing();
			if (!ring.ctx) { return; }
			ringBurst();
			/* 响 1 秒、停 3 秒 —— 与国标回铃节奏接近，够听出是来电 */
			ring.timer = setInterval(ringBurst, 4000);
		}

		function ringStop() {
			if (ring.timer) { clearInterval(ring.timer); ring.timer = 0; }
		}

		/* ---------- 状态轮询 ---------- */

		function fmtDuration(ms) {
			var s = Math.floor(ms / 1000);
			var m = Math.floor(s / 60);
			s = s % 60;
			return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
		}

		/*
		 * 用 CLCC 结果反推 phase：
		 *   · 任一路 active(0)          → active（时长从这一刻起算）
		 *   · 本机 dialing/alerting     → outgoing
		 *   · 网络 incoming/waiting     → incoming
		 *   · 只剩 held(1)              → active（保持也是通话的一种存续）
		 *   · 空                        → idle
		 * ★ 时长基准只在**首次**看到 active 时置：轮询间隔 2s，若每次刷新都重置
		 *   基准，时长会永远显示 00:00~00:02。
		 */
		function applyCalls(calls) {
			st.calls = calls || [];
			var hasActive = false, hasOutgoing = false, hasIncoming = false, hasHeld = false;
			var first = null;
			for (var i = 0; i < st.calls.length; i++) {
				var c = st.calls[i];
				if (!first) { first = c; }
				if (c.state === 0) { hasActive = true; }
				else if (c.state === 2 || c.state === 3) { hasOutgoing = true; }
				else if (c.state === 4 || c.state === 5) { hasIncoming = true; }
				else if (c.state === 1) { hasHeld = true; }
			}
			var prev = st.phase;
			if (hasActive || hasHeld) { st.phase = 'active'; }
			else if (hasOutgoing) { st.phase = 'outgoing'; }
			else if (hasIncoming) { st.phase = 'incoming'; }
			else { st.phase = 'idle'; }

			if (st.phase === 'active' && prev !== 'active') {
				st.activeAt = Date.now();
			}
			if (st.phase !== 'active') {
				st.activeAt = 0;
			}
			st.number = (first && first.number) ? first.number : st.number;

			/*
			 * 来电提示与铃声只在**转换进来时**触发：applyCalls 每 2s 被轮询
			 * 调一次，放在渲染里就会每两秒弹一回、每两秒重响一次。
			 */
			if (st.phase === 'incoming' && prev !== 'incoming') {
				Mt5700.info('来电：' + (st.number || '未知号码'));
				ringStart();
			}
			if (st.phase !== 'incoming' && prev === 'incoming') {
				ringStop();
			}

			/*
			 * 语音域是「这一通」的属性，不是设备的属性：空闲时不清掉，
			 * 状态栏会一直挂着「空闲 · IMS」这种误导性的残留。
			 */
			if (st.phase === 'idle') { st.domain = null; }

			updateTrack(first);
			renderStatus();
		}

		/*
		 * 通话生命周期跟踪：第一次进入非 idle 建档，回到 idle 时落记录。
		 * 记录里的方向/号码以后到的读数覆盖（首次轮询可能还没拿到号码）。
		 */
		function updateTrack(first) {
			if (st.phase !== 'idle') {
				if (!track) {
					/*
					 * 新一通开始：上一通若因「轮询先看到空闲」而没来得及用上
					 * ^CEND 的时长，那个残留值必须作废，否则会被记到这一通头上。
					 */
					pendingDuration = null;
					track = { number: '', dir: 0, startedAt: Date.now(), answeredAt: 0, rejected: false };
				}
				if (first) {
					if (first.number) { track.number = String(first.number); }
					track.dir = (first.dir === 1) ? 1 : 0;
				} else if (st.number) {
					track.number = st.number;
				}
				if (st.phase === 'active' && !track.answeredAt) {
					track.answeredAt = Date.now();
				}
			} else if (track) {
				var t = track;
				track = null;
				if (pendingDuration != null) {
					t.endedDuration = pendingDuration;
					pendingDuration = null;
				}
				saveRecord(t);
			}
		}

		function refreshStatus() {
			/* 记发车时刻：urcKick 用它算防抖窗口（从发出算，不含 AT 往返） */
			lastStatusAt = Date.now();
			AtWs.call('status').then(function (res) {
				if (!res.success) {
					/*
					 * ★「读不到」与「没有通话」必须分开（红线 23）：
					 *   后端无 mt5700.call 方法 / 通道故障 → 如实报错，不清状态；
					 *   成功且 calls 为空数组才是真的空闲。
					 * ★ 判据用「不是数组」而不是「=== null」：后端若在失败分支
					 *   不回 calls 字段，`undefined === null` 为假 ⇒ 报错分支是
					 *   死代码，通道故障看起来像空闲。后端已补 `calls: null`，
					 *   这里同时放宽判据以兼容未升级的后端。
					 */
					if (!Array.isArray(res.calls)) {
						st.backendOk = false;
						/*
						 * 通道路故障：不只是报错，还要让动作按钮灰掉
						 * （applyGates 读这个标志）。否则通道已经断了，
						 * 按钮却照亮着，用户会一直点一个注定失败的通道 ——
						 * 这是厂商 usable 纪律里 !s.status?.error 那一半。
						 * ★ 不清 st.stage / st.calls：保留最后一次成功读到的
						 *   状态，只用灰化表达"当前不可操作"，避免读失败
						 *   被渲染成「空闲」（红线 23）。
						 */
						st.channelError = true;
						setErr(res.error || '通话状态读取失败');
						applyGates();
					}
					return;
				}
				st.backendOk = true;
				st.channelError = false;
				setErr('');
				st.stage = res.stage || null;
				applyCalls(res.calls || []);
			}).catch(function () {
				/* 网络抖动不清状态：下一次轮询会纠正 */
			});
		}

		/* 线路信息（静音 / 音量）：不进轮询，按需查 —— 见 ucode callLineInfo 注释 */
		function refreshInfo() {
			AtWs.call('info').then(function (res) {
				if (!res || !res.success) { return; }
				st.mute = res.mute;
				st.volume = res.volume;
				renderInfo();
			}).catch(function () { });
		}

	function renderInfo() {
		if (st.mute == null) {
			muteBadge.textContent = '静音 —';
			muteBadge.className = 'mt5700-badge mt5700-badge-neutral';
			muteBtn.textContent = '静音';
			/*
			 * ★ 不在这里写 muteBtn.disabled：applyGates 是 disabled 的
			 *   唯一出处。此前这里有一句 disabled = false，等于在通话外
			 *   又把静音键点亮，和 applyGates 的判定打架（两套判据必然漂移）。
			 */
		} else if (st.mute === 1) {
			muteBadge.textContent = '已静音';
			muteBadge.className = 'mt5700-badge mt5700-badge-warning';
			muteBtn.textContent = '取消静音';
		} else {
			muteBadge.textContent = '未静音';
			muteBadge.className = 'mt5700-badge mt5700-badge-neutral';
			muteBtn.textContent = '静音';
		}
		metricVolume.querySelector('.mt5700-metric-value').textContent =
			(st.volume == null) ? '—' : String(st.volume);
		/* 静音键文案变了（静音↔取消静音），可点性重新算一遍 */
		applyGates();
	}

		function renderStatus() {
			var badgeText = '空闲', badgeVariant = 'neutral';
			if (st.phase === 'outgoing') { badgeText = '呼叫中'; badgeVariant = 'primary'; }
			else if (st.phase === 'incoming') { badgeText = '来电'; badgeVariant = 'warning'; }
			else if (st.phase === 'active') { badgeText = '通话中'; badgeVariant = 'success'; }
			/*
			 * stage 粒度比 phase 细：CLCC 本来就把 dialing / alerting /
			 * ringing / waiting / held 分开了，厂商状态机也照此命名。
			 * 有令牌时用令牌细化徽标，没有就保持 phase 的粗粒度（兼容老后端）。
			 */
			if (st.stage === 'dialing') { badgeText = '正在呼出'; badgeVariant = 'primary'; }
			else if (st.stage === 'alerting') { badgeText = '对方振铃'; badgeVariant = 'primary'; }
			else if (st.stage === 'ringing') { badgeText = '来电振铃'; badgeVariant = 'warning'; }
			else if (st.stage === 'waiting') { badgeText = '来电等待'; badgeVariant = 'warning'; }
			else if (st.stage === 'held') { badgeText = '通话保持'; badgeVariant = 'warning'; }
			statusBadge.textContent = badgeText;
			statusBadge.className = 'mt5700-badge mt5700-badge-' + badgeVariant;

			metricNumber.querySelector('.mt5700-metric-value').textContent = st.number || '—';
			var first = st.calls.length ? st.calls[0] : null;
			/*
			 * 状态文案优先用后端给的 stage 令牌（那是协议语义，由后端定），
			 * 拿不到令牌时退回本地 <state> 整数映射。
			 */
			var stageText = (st.stage == null) ? null : (STAGE_TEXT[st.stage] || null);
			if (stageText == null && first) {
				stageText = CALL_STATE[first.state] || ('状态 ' + first.state);
			}
			/*
			 * 语音域挂在状态文案后面，不新开一格：状态卡已有 5 格，
			 * 再加一格会让窄屏换行（红线 41：固定尺寸，不按数据量撑开）。
			 * 这一项有诊断价值 —— 实测本机 `+CREG: 0,0` 却能拨通，正是因为
			 * voice_domain=1 走 IMS，不依赖 CS 注册。
			 */
			var stateText = stageText || '空闲';
			if (st.domain === 1) { stateText += ' · IMS'; }
			else if (st.domain === 0) { stateText += ' · CS'; }
			metricState.querySelector('.mt5700-metric-value').textContent = stateText;
			metricDir.querySelector('.mt5700-metric-value').textContent =
				first ? (CALL_DIR[first.dir] || '—') : '—';
			metricDuration.querySelector('.mt5700-metric-value').textContent =
				(st.phase === 'active' && st.activeAt) ? fmtDuration(Date.now() - st.activeAt) : '—';

		/*
		 * 按钮常驻可见，这里只改文案：挂断键在来电时改叫「拒接」——
		 * 后端是同一个 ATH，两种语境两个名字（记录里也按此区分结果）。
		 * 能不能点一律由 applyGates 判，此处不碰 disabled/style。
		 */
		hangupBtn.textContent = (st.phase === 'incoming') ? '拒接' : '挂断';

		applyGates();
		}

	/*
	 * 移植厂商 modemwebui call.js 的 usable 纪律：按钮「能不能点」由
	 * 三个条件与运算得出，而不是只看 busy。
	 *   ① 通道路是否正常 —— 通道故障时全部灰掉，避免用户对着一个
	 *      注定失败的通道反复点（厂商：!s.status?.error）。
	 *   ② 动作与当前通话态匹配 —— 空闲时"接听/挂断"不可点、通话中
	 *      "拨打"不可点、只有接通后"静音"才有意义。
	 *   ③ busy —— 单次操作在跑时谁都不许再发（AT 通道独占）。
	 *
	 * ★ 判据用 phase 而不是后端 stage 令牌：phase 由前端从 CLCC 原始
	 *   state 现算，老后端没有 stage 也能正确灰化；stage 是给徽标做
	 *   细粒度文案用的（令牌更细，现算更稳，各司其职）。
	 * ★ 这里是**唯一**写 disabled 的地方：setBusy / renderStatus /
	 *   refreshStatus / renderInfo 全部转交过来，避免两套判据漂移。
	 */
	function applyGates() {
		var blocked = st.busy || st.channelError;
		dialBtn.disabled = blocked || (st.phase !== 'idle');
		answerBtn.disabled = blocked || (st.phase !== 'incoming');
		hangupBtn.disabled = blocked || (st.phase === 'idle');
		muteBtn.disabled = blocked || (st.phase !== 'active');
		ringBtn.disabled = blocked;
	}

		/* ---------- 推送消费（来电 + 通话类 URC） ---------- */

		/*
		 * 两类推送：
		 *   · incoming_call —— urc.rs 从 RING/+CLIP/^CEND 派生的结构化事件，
		 *     只带号码与状态，没有呼叫 ID、方向、时长。
		 *   · urc_data —— 模组原始上报行，由 rpc.js::parseRawData 解析。
		 *     通话类的五条（^CCALLSTATE/^ORIG/^CONF/^CONN/^CEND）在这里。
		 */
		function onPush(ev) {
			if (!ev) { return; }

			if (ev.type === 'incoming_call') {
				/* 让号码比轮询早一两秒出现。判定仍以 CLCC 为准：+CLIP 是否上报
				 * 取决于模组 CLIP 设置，而这个推送里没有方向与呼叫 ID。 */
				if (ev.data && ev.data.number) {
					st.number = String(ev.data.number);
				}
				urcKick();
				return;
			}

			if (ev.type === 'urc_data' && ev.data && ev.data.type === 'CALL') {
				handleCallUrc(ev.data);
			}
		}

		/*
		 * URC 与轮询的分工，是这次改造的核心边界：
		 *
		 *   URC 只当**信号**用 —— 「模组的状态已经变了，现在就去读一次」；
		 *   状态值仍由 CLCC 现算（applyCalls）。这是有意的：^CCALLSTATE 的
		 *   state 编号（0 originate … 8 retrieve）与 CLCC 的 <stat>
		 *   （0 active … 5 waiting）是两套体系，混用必然错位，而且 CLCC 带
		 *   方向、号码、呼叫 ID，是唯一能渲染完整那一行的来源。
		 *
		 * 效果：状态可见延迟从「最多 2 秒」降到「一次 AT 往返」（实测 65~133ms）。
		 */
		function handleCallUrc(d) {
			if (d.event === 'CEND') {
				/* 通话时长以模组给的为准，落记录时优先用它 */
				if (d.duration != null) { pendingDuration = d.duration; }
				urcKick();
				return;
			}

			if (d.event === 'CCALLSTATE') {
				if (d.domain != null) { st.domain = d.domain; }
				/*
				 * state 5=InComing / 6=Waiting：来电第一时间响铃，不必等
				 * 下一次轮询。这是「来电就响那么几秒，藏起来的提醒等于没有」
				 * 的直接落点 —— 但响铃本身仍由 applyCalls 触发（它拿到号码
				 * 与方向后再响），这里只负责尽快把状态读回来。
				 */
				urcKick();
				return;
			}

			/* ^ORIG / ^CONF / ^CONN：只是「状态该变了」的信号 */
			urcKick();
		}

		/*
		 * 合并刷新请求。
		 *
		 * 同一批 URC 常常前后脚到达（实测 ^CONN 与 ^CCALLSTATE:1,3,1 在同一毫秒），
		 * 一条一条刷会把 AT 通道连占好几次（单条 65~133ms，串行执行）。
		 * 250ms 内的重复请求合并成一次延迟刷新，超窗口的直接发。
		 */
		function urcKick() {
			if (st.busy) { return; }

			var now = Date.now();
			if (now - lastStatusAt < 250) {
				if (!kickTimer) {
					kickTimer = setTimeout(function () {
						kickTimer = 0;
						if (!st.busy) { refreshStatus(); }
					}, 250);
				}
				return;
			}
			refreshStatus();
		}

	/* ---------- 初始化 ---------- */

	/*
	 * 建页后先按初始 phase（idle）灰化一遍：connectThen 要等后端握手，
	 * 那之前按钮是默认可用态 —— 空闲时"接听/挂断"亮着是个假象。
	 */
	applyGates();

	/* 浏览器要求用户手势后才能出声：首次点击时预热 AudioContext */
		function onGesture() {
			primeRing();
			document.removeEventListener('click', onGesture);
		}
		document.addEventListener('click', onGesture);

	/* ---------- CLCC 兜底轮询（自适应：空闲 5s / 通话中 2s） ---------- */

	/*
	 * ★ 为什么空闲能放慢：状态变化的主通道是 URC —— ^CCALLSTATE / ^CEND 一到，
	 *   onPush → urcKick 立刻读一次 CLCC（见下方「URC 事件驱动」）。这条定时器
	 *   只是「URC 丢了 / 老后端没转发」时的兜底：空闲时没有计时在跑，5s 的兜底
	 *   延迟完全无感（2s 时每页 30 条/分钟，5s 时 12 条/分钟）。
	 * ★ 为什么通话中仍 2s：接通/挂断的回显不能迟滞，此时 CLCC 是计时与状态的
	 *   唯一现算来源（URC 只当触发器）。
	 * ★ 为什么不用 Mt5700.interval：它是固定 setInterval，改不了「下一拍」。
	 *   这里自排 setTimeout；句柄与停止标志在 _onDispose 里清，与 kickTimer 同一处置。
	 */
	var clccTimer = 0;
	var clccStopped = false;

	function inCall() {
		return !!(st.calls && st.calls.length > 0);
	}

	function clccTick() {
		if (clccStopped) return;
		/* 页面已脱离文档（切页）：自停，绝不在别的页面上打 CLCC */
		var doc = page && page.ownerDocument;
		if (doc && !doc.contains(page)) { clccStopped = true; return; }
		/* 操作进行中不叠加查询：AT 通道是独占串行的 */
		if (!st.busy) refreshStatus();
		clccTimer = setTimeout(clccTick, inCall() ? 2000 : 5000);
	}

	Mt5700.connectThen(function () {
			/* 本页需要「秒级」状态可见性 —— 把事件轮询压到 500ms（见 tightenPoll） */
			tightenPoll();
			refreshStatus();
			refreshInfo();
			loadLog();
			/*
			 * 首拍 2s（进页面先拿一次状态），之后按「是否在通话」自适应排下一拍。
			 * 见 clccTick 上方说明。
			 */
			clccTimer = setTimeout(clccTick, 2000);
		});

		if (AtWs.client && AtWs.client.subscribe) {
			AtWs.client.subscribe(onPush);
		}

		page._onDispose(function () {
			ringStop();
			/*
			 * ★ 必须清掉合并定时器：它不在 Mt5700.interval 的托管名单里
			 *   （那是周期定时器，这个是一次性延迟），页面走了还会触发一次
			 *   refreshStatus —— 等于离开语音页之后仍有一条 CLCC 打到模组上。
			 */
			if (kickTimer) { clearTimeout(kickTimer); kickTimer = 0; }
			/* CLCC 兜底轮询是自排 setTimeout，不在 Mt5700.interval 的托管名单里 */
			clccStopped = true;
			if (clccTimer) { clearTimeout(clccTimer); clccTimer = 0; }
			/* 先还原轮询间隔再退订：此刻本页还订阅着，重启定时器用的是原值 */
			restorePoll();
			document.removeEventListener('click', onGesture);
			if (AtWs.client && AtWs.client.unsubscribe) {
				AtWs.client.unsubscribe(onPush);
			}
		});

		return page;
	}
});
