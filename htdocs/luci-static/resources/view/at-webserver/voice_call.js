'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 语音通话 - 通话管理台（拨号 / 接听 / 拒接 / 挂断 / DTMF / 记录）
 *
 * 功能（手册第 4 章呼叫控制 + 第 5 章网络服务 + 第 12 章鼎桥私有 URC）：
 *   · 拨号盘（0-9 / * / # / 国际前缀 +，退格、清空）
 *   · 拨打 / 接听 / 拒接 / 挂断 / 通话中 DTMF
 *   · 通话状态（AT+CLCC 2s 轮询：dialing / alerting / active / incoming / waiting）
 *   · 通话时长（active 起算）
 *   · 麦克风静音（AT+CMUT）与扬声器音量读数（AT+CLVL）
 *   · 通话记录（设备侧持久化 /etc/mt5700/call-log.json，跨浏览器可见）
 *   · 来电铃声（Web Audio 生成，手机浏览器可响）
 *
 * ★★★ 声音的断点在哪（2026-10-16 实测 + 专项研究，方案见 REFERENCE §声音实现方案）：
 *   · 模组侧：`AT+CLVL=?` 真机回 **(1-12)** —— 手册 6.10 写明 1–12 是
 *     「车载 PCM 语音特性开关」打开时的档位（普通模式是 0–5）⇒ **模组的
 *     PCM 语音通路是开的**。但手册 90 条私有命令里没有任何配置 PCM/I2S
 *     或 USB 组成的 AT 命令 ⇒ 音频只能走硬件引脚，软件改不了。
 *   · 主机侧：模组 USB 面只有 CDC-NCM 数据口 + 4 个 AT 串口，无 audio
 *     class 接口；MT7987 的 AFE（audio-controller@11210000）在主线内核
 *     有驱动（CONFIG_SND_SOC_MT7986，兼容 mt7987），但本板设备树里
 *     status=disabled、板面无 codec，厂商与上游 DTS 都没引用 i2s/pcm 引脚。
 *   ⇒ 信令全通、音频断在主板。本页做「通话管理台」；想听到声音有两条路：
 *     路由器跑 SIP（Asterisk 已装，零硬件）或把模组 PCM 飞线到 SoC AFE
 *     （需先万用表验证 M.2 音频脚是否引出）。
 *
 * ★ 状态来源为什么是轮询而不是 URC：
 *   呼叫生命周期的私有 URC（^ORIG / ^CONF / ^CONN / ^CEND）受 AT^CURC 控制，
 *   而真机（2026-10-16）实测 ^CURC=0 —— 一个都不报。开它需要 mode=2 的
 *   位图掩码，而掩码位序（大端/小端）**未经真机验证**：猜错一位就会把
 *   ^DSFLOWRPT 之类的常驻上报放出来，那正是红线 22 要防的事故形态。
 *   在掩码验证之前，本页只用 AT+CLCC 轮询拿全量状态 —— 真机实测该命令
 *   在通话中照样应答（12.3s 时返回 +CLCC: 1,0,0,0,0,"1008611",161）。
 *
 * ★ 来电的瞬间通知走既有 incoming_call 推送（urc.rs 的 RING/+CLIP），
 *   但 +CLIP 是否上报取决于模组的 CLIP 设置，所以**来电检测以 CLCC 轮询
 *   为准**（dir=1 即网络来电），推送只是让号码早一两秒出现。
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
		/*
		 * 先说清楚「没有声音」再谈功能：用户第一眼就该知道这一页能做到
		 * 什么、做不到什么 —— 否则「接通了却没声音」会被当成功能坏了。
		 */
		/*
		 * 提示条走设计系统的 .mt5700-notice-warning（带 ! 图标、亮暗双模）。
		 * 此前这里是手写内联黄块（#fdf6e3 底 / #6b4e00 字）——暗色模式下
		 * 一片刺眼的亮黄，且与全插件视觉语言脱节。
		 */
		body.appendChild(E('div', {
			'class': 'mt5700-notice mt5700-notice-warning'
		}, '这一页管「信令」不管「声音」：拨号、接听、拒接、挂断、状态、DTMF、'
			+ '通话记录都能用，来电时页面还会响铃；但通话内容听不到。'
			+ '实测（2026-10-16）：模组侧 PCM 语音模式已开启（AT+CLVL 档位 1–12），'
			+ '断点在这台 CPE 的主板 —— 模组的音频引脚没有接到 SoC，板上也没有 codec。'
			+ '想听到声音：可在路由器上跑 SIP 软电话（Asterisk 已安装），'
			+ '或把模组 PCM 飞线到 SoC AFE（需先验证接线）。'));

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
				duration: t.answeredAt ? Math.round((Date.now() - t.answeredAt) / 1000) : 0,
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
				saveRecord(t);
			}
		}

		function refreshStatus() {
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
			metricState.querySelector('.mt5700-metric-value').textContent = stageText || '空闲';
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

		/* ---------- 来电推送 ---------- */

		/*
		 * urc.rs 的 RING/+CLIP 会推 incoming_call。它让号码比轮询早 ~2s 出现，
		 * 但**判定不能依赖它**：+CLIP 是否上报取决于模组 CLIP 设置，
		 * 而推送里没有呼叫 ID 与方向。所以这里只拿它做「预提示」——
		 * 立即刷一次状态，其余仍以 CLCC 为准。
		 */
		function onPush(ev) {
			if (!ev || ev.type !== 'incoming_call') { return; }
			if (ev.data && ev.data.number) {
				st.number = String(ev.data.number);
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

		Mt5700.connectThen(function () {
			refreshStatus();
			refreshInfo();
			loadLog();
			/*
			 * 2s 轮询：CLCC 单条 65~133ms，与网络状态页的信号轮询同量级。
			 * interval 自带 scopeEl 检查——离开页面自动停，不会跟用户抢串口。
			 */
			Mt5700.interval(2000, function () {
				/* 操作进行中不叠加查询：AT 通道是独占串行的 */
				if (st.busy) { return; }
				refreshStatus();
			}, page);
		});

		if (AtWs.client && AtWs.client.subscribe) {
			AtWs.client.subscribe(onPush);
		}

		page._onDispose(function () {
			ringStop();
			document.removeEventListener('click', onGesture);
			if (AtWs.client && AtWs.client.unsubscribe) {
				AtWs.client.unsubscribe(onPush);
			}
		});

		return page;
	}
});
