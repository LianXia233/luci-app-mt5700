'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 语音通话 - CS 域语音呼叫控制
 *
 * 功能（对应手册第 4 章 3GPP 呼叫控制 + 第 5 章网络服务 + 第 12 章鼎桥私有 URC）：
 *   · 拨号盘（0-9 / * / #，国际前缀 +，退格）
 *   · 拨打 / 接听 / 挂断 / 通话中 DTMF
 *   · 通话状态（AT+CLCC 轮询：dialing / alerting / active / incoming / waiting）
 *   · 通话时长（active 态起算）
 *
 * ★ 状态来源为什么是轮询而不是 URC：
 *   呼叫生命周期的私有 URC（^ORIG / ^CONF / ^CONN / ^CEND）受 AT^CURC 控制，
 *   而真机（2026-10-16）实测 ^CURC=0 —— 一个都不报。开它需要 mode=2 的
 *   位图掩码，而掩码位序（大端/小端）**未经真机验证**：猜错一位就会把
 *   ^DSFLOWRPT 之类的常驻上报放出来，那正是红线 22 要防的事故形态。
 *   在掩码验证之前，本页只用 AT+CLCC 轮询拿全量状态 —— 真机实测该命令
 *   在通话中照样应答（12.3s 时返回 +CLCC: 1,0,0,0,0,"1008611",161）。
 *   ^CURC 掩码验证通过后再升级为「URC 即时 + 轮询兜底」。
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
		var page = Mt5700.page('语音通话', '拨打、接听、挂断与 DTMF（CS 域语音呼叫）');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

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

		/* 前端号码白名单：与后端 callNumberOk 同口径（后端才是真门禁） */
		var NUMBER_RE = /^\+?[0-9*#]+$/;

		/* DTMF 键盘布局（与普通电话一致） */
		var KEYPAD = [
			['1', '2', '3'],
			['4', '5', '6'],
			['7', '8', '9'],
			['*', '0', '#']
		];

		/* ---------- 状态 ---------- */

		/*
		 * phase 由 CLCC 轮询结果驱动，不靠本地记忆勾选状态：
		 *   idle      无在途呼叫
		 *   outgoing  本机已发起（dialing/alerting）
		 *   incoming  网络来电（振铃）
		 *   active    已接通
		 * busy 只挡「用户连点」，不参与状态判定。
		 */
		var st = {
			phase: 'idle',
			number: '',       /* 拨号盘输入 / 在途呼叫号码 */
			activeAt: 0,      /* 首个 active 出现的时刻（时长基准） */
			calls: [],        /* 最近一次 status 的全部在途呼叫 */
			busy: false,
			err: '',
			backendOk: true   /* false＝rpcd 没有 mt5700.call（后端未升级） */
		};

		/* ---------- DOM ---------- */

		var statusBadge = Mt5700.badge('空闲', 'neutral');
		var statusCard = Mt5700.card('通话状态', '状态来自 AT+CLCC 轮询（2 秒一次）', statusBadge);
		var statusMain = E('div');
		statusCard._body.appendChild(statusMain);

		var statusMetrics = E('div', { 'class': 'mt5700-metrics' });
		statusMain.appendChild(statusMetrics);
		var metricNumber = Mt5700.metric('号码', '—');
		var metricState = Mt5700.metric('状态', '空闲');
		var metricDir = Mt5700.metric('方向', '—');
		var metricDuration = Mt5700.metric('时长', '—');
		statusMetrics.appendChild(metricNumber);
		statusMetrics.appendChild(metricState);
		statusMetrics.appendChild(metricDir);
		statusMetrics.appendChild(metricDuration);

		var statusActions = E('div', { 'class': 'mt5700-panel-actions' });
		statusMain.appendChild(statusActions);
		var answerBtn = Mt5700.successButton('接听', function () { doAnswer(); });
		var hangupBtn = Mt5700.dangerButton('挂断', function () { doHangup(); });
		statusActions.appendChild(answerBtn);
		statusActions.appendChild(hangupBtn);

		var statusErr = E('p', { 'class': 'mt5700-hint' }, '');
		statusCard._body.appendChild(statusErr);

		body.appendChild(statusCard);

		var dialerCard = Mt5700.card('拨号盘', '输入号码后点「拨打」；* 与 # 可用于 USSD 与补充业务码');
		var dialerBody = E('div');
		dialerCard._body.appendChild(dialerBody);
		body.appendChild(dialerCard);

		var numberInput = Mt5700.input('text', '输入号码（数字、*、#，国际号码以 + 开头）');
		numberInput.style.cssText = 'font-size:20px;letter-spacing:1px;text-align:center';
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

		var keypad = E('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:320px' });
		KEYPAD.forEach(function (row) {
			row.forEach(function (key) {
				var b = Mt5700.button(key, function () {
					numberInput.value += key;
					st.number = numberInput.value;
					/*
					 * 同一排键盘两用：空闲＝输号码，**已接通**＝送 DTMF。
					 * 振铃态不发（AT+VTS 只在通话中有效，发了也是 ERROR），
					 * 保持态也不发（音频通道在远端）。
					 */
					if (st.phase === 'active') { sendDtmf(key); }
				}, 'secondary');
				b.style.cssText = 'font-size:18px;padding:12px 0';
				keypad.appendChild(b);
			});
		});
		dialerBody.appendChild(keypad);

		var dialerActions = E('div', { 'class': 'mt5700-panel-actions' });
		dialerBody.appendChild(dialerActions);
		var dialBtn = Mt5700.primaryButton('拨打', function () { doDial(); });
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

		var dialerHint = E('p', { 'class': 'mt5700-hint' }, ''
			+ '通话会产生运营商通话费（10086 等客服号通常免费）。'
			+ '本页只控制呼叫本身，不通话音频——模组音频走 PCM，由模组与网络侧处理。');
		dialerBody.appendChild(dialerHint);

		/* ---------- 动作 ---------- */

		function setBusy(on) {
			st.busy = on;
			dialBtn.disabled = on;
			answerBtn.disabled = on;
			hangupBtn.disabled = on;
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
			 * 来电提示只在**转换进来时**弹一次：renderStatus 每 2s 被轮询
			 * 调一次，放在渲染里就会每两秒弹一回。
			 */
			if (st.phase === 'incoming' && prev !== 'incoming') {
				Mt5700.info('来电：' + (st.number || '未知号码'));
			}
			renderStatus();
		}

		function refreshStatus() {
			AtWs.call('status').then(function (res) {
				if (!res.success) {
					/*
					 * ★「读不到」与「没有通话」必须分开（红线 23）：
					 *   后端无 mt5700.call 方法 / 通道故障 → 如实报错，不清状态；
					 *   成功且 calls 为空数组才是真的空闲。
					 */
					if (res.calls === null) {
						st.backendOk = false;
						setErr(res.error || '通话状态读取失败');
					}
					return;
				}
				st.backendOk = true;
				setErr('');
				applyCalls(res.calls || []);
			}).catch(function () {
				/* 网络抖动不清状态：下一次轮询会纠正 */
			});
		}

		function renderStatus() {
			var badgeText = '空闲', badgeVariant = 'neutral';
			if (st.phase === 'outgoing') { badgeText = '呼叫中'; badgeVariant = 'primary'; }
			else if (st.phase === 'incoming') { badgeText = '来电'; badgeVariant = 'warning'; }
			else if (st.phase === 'active') { badgeText = '通话中'; badgeVariant = 'success'; }
			statusBadge.textContent = badgeText;
			statusBadge.className = 'mt5700-badge mt5700-badge-' + badgeVariant;

			metricNumber.querySelector('.mt5700-metric-value').textContent = st.number || '—';
			var first = st.calls.length ? st.calls[0] : null;
			metricState.querySelector('.mt5700-metric-value').textContent =
				first ? (CALL_STATE[first.state] || ('状态 ' + first.state)) : '空闲';
			metricDir.querySelector('.mt5700-metric-value').textContent =
				first ? (CALL_DIR[first.dir] || '—') : '—';
			metricDuration.querySelector('.mt5700-metric-value').textContent =
				(st.phase === 'active' && st.activeAt) ? fmtDuration(Date.now() - st.activeAt) : '—';

		/* 按钮可见性跟着状态走：空闲只能拨，来电只能接/挂，通话中只能挂 */
		answerBtn.style.display = (st.phase === 'incoming') ? '' : 'none';
		hangupBtn.style.display = (st.phase === 'idle') ? 'none' : '';
	}

		/* ---------- 来电推送 ---------- */

		/*
		 * urc.rs 的 RING/+CLIP 会推 incoming_call。它让号码比轮询早 ~2s 出现，
		 * 但**判定以来没它不行**：+CLIP 是否上报取决于模组 CLIP 设置，
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

		Mt5700.connectThen(function () {
			refreshStatus();
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
			if (AtWs.client && AtWs.client.unsubscribe) {
				AtWs.client.unsubscribe(onPush);
			}
		});

		return page;
	}
});
