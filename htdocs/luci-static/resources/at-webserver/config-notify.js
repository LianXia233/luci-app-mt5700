// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require at-webserver/mt5700';
'require at-webserver/rpc';
'require at-webserver/ui';
'require at-webserver/config-common';
/* global L, E, Mt5700, AtWs, Ui, MtConfigCommon */

/*
 * 配置模块：通知（事件开关 / 推送通道 / 定时推送 / 信号巡检 / 频率与时段门控 /
 * 测试推送 / QQ 绑定）。原本这些逻辑全部平铺在 service.js 的通知卡片里，此处
 * 独立成模块，拥有自己的控件、状态、联动、读写，不触碰其它模块的配置键。
 *
 * 本模块还承载本次新增的「每种推送类型独立的频率限制 + 推送时段」配置：
 * 四类（短信/来电/存储满/信号）各一套六项 UCI 键（notify_limit_*），互不干扰。
 */
var MtConfigNotify = (function () {
	var C = MtConfigCommon;

	/* 四种类型门控的元数据：UCI 前缀、标题、说明 */
	var GATE_KINDS = [
		{ key: 'sms', label: '新短信', prefix: 'notify_limit_sms' },
		{ key: 'call', label: '来电', prefix: 'notify_limit_call' },
		{ key: 'memory', label: '短信存储满', prefix: 'notify_limit_memory' },
		{ key: 'signal', label: '信号变化', prefix: 'notify_limit_signal' }
	];

	function build(bodyEl, ctx) {
		var baseline = {};
		var all = {}; // 所有需要 dirty 比对的控件

		bodyEl.appendChild(E('div', { 'class': 'mt5700-hint' },
			'时间口径：推送与日志中的时间一律使用本机系统时区；未配置时区时回落北京时间 UTC+08:00。'));

		/* ---- 总开关 + 四类事件开关 ---- */
		bodyEl.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '事件通知'));
		var master = C.mkCheck();
		bodyEl.appendChild(Mt5700.formGroup('自动推送总开关', master.wrap,
			'关闭后所有事件都不再推送，仅写入本地通知日志；信号定时巡检也会一并停止。'));
		var notifyCalls = C.mkCheck(), notifySms = C.mkCheck(),
			notifySignal = C.mkCheck(), notifyMem = C.mkCheck();
		bodyEl.appendChild(Mt5700.formGroup('来电通知', notifyCalls.wrap, '实时推送，不受定时推送间隔影响'));
		bodyEl.appendChild(Mt5700.formGroup('新短信通知', notifySms.wrap, '实时推送，不受定时推送间隔影响'));
		bodyEl.appendChild(Mt5700.formGroup('信号变化通知', notifySignal.wrap,
			'需配合下方「信号定时巡检」才会产生数据：模组不会主动上报信号读数'));
		bodyEl.appendChild(Mt5700.formGroup('短信存储满通知', notifyMem.wrap));
		all.master = master.input; all.calls = notifyCalls.input; all.sms = notifySms.input;
		all.signal = notifySignal.input; all.mem = notifyMem.input;

		/* ---- 推送通道 ---- */
		bodyEl.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '推送通道'));
		var wechat = C.mkCheck();
		var webhook = Mt5700.input('text', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', '');
		bodyEl.appendChild(Mt5700.formGroup('企业微信推送', wechat.wrap,
			'独立开关，默认关闭；与 QQ 推送互不影响。'));
		bodyEl.appendChild(Mt5700.formGroup('企业微信 WebHook', webhook, '通知将推送到该 WebHook 地址'));
		all.wechat = wechat.input; all.webhook = webhook;

		var qq = C.mkCheck();
		var qqAppId = Mt5700.input('text', 'QQ 开放平台 AppID（纯数字）', '');
		var qqSecret = Mt5700.input('password', '留空则回退环境变量 QQ_BOT_APP_SECRET', '');
		var qqTarget = Mt5700.select([
			{ label: '群聊（group_openid）', value: 'group' },
			{ label: '单聊（用户 openid）', value: 'c2c' },
			{ label: '频道（channel_id）', value: 'channel' },
			{ label: '绑定（自动获取 openid，推荐首次使用）', value: 'bind' }
		], 'group');
		var qqBind = Mt5700.input('text', '你的 QQ 号（仅作绑定标签）', '');
		var qqTargetId = Mt5700.input('text', 'group_openid / 用户 openid / channel_id', '');
		bodyEl.appendChild(Mt5700.formGroup('QQ 推送', qq.wrap, '独立开关，默认关闭；与企业微信互不影响。'));
		bodyEl.appendChild(Mt5700.formGroup('QQ 机器人 AppID', qqAppId, '也可用环境变量 QQ_BOT_APP_ID 覆盖'));
		bodyEl.appendChild(Mt5700.formGroup('QQ 机器人 AppSecret', qqSecret, '建议留空并经环境变量注入，避免凭据落盘 UCI'));
		bodyEl.appendChild(Mt5700.formGroup('QQ 推送目标类型', qqTarget,
			'选「绑定」：保存并应用后，用你的 QQ 给机器人发一条消息即自动完成绑定'));
		bodyEl.appendChild(Mt5700.formGroup('绑定 QQ 号', qqBind, '仅用于日志标识，openid 由后端自动抓取'));
		bodyEl.appendChild(Mt5700.formGroup('QQ 推送目标 ID', qqTargetId,
			'绑定模式留空即可；手动模式请粘贴完整 openid。'));
		all.qq = qq.input; all.qqAppId = qqAppId; all.qqSecret = qqSecret;
		all.qqTarget = qqTarget; all.qqBind = qqBind; all.qqTargetId = qqTargetId;

		var qqFormat = Mt5700.select([
			{ label: '自动（富文本优先，失败回落纯文本，推荐）', value: 'auto' },
			{ label: '富文本 Markdown（失败不回落）', value: 'markdown' },
			{ label: '纯文本', value: 'text' }
		], 'auto');
		var qqKb = C.mkCheck();
		var qqKbUrl = Mt5700.input('text', '留空则按局域网 IP 自动推导', '');
		var qqMenu = C.mkCheck();
		bodyEl.appendChild(Mt5700.formGroup('QQ 消息格式', qqFormat, '富文本=Markdown 结构化消息；纯文本为兜底。'));
		var qqRate = Mt5700.input('number', '10', '');
		qqRate.min = 0; qqRate.max = 60; qqRate.step = 1;
		var qqRateHuman = E('span', { 'class': 'mt5700-hint' }, '');
		bodyEl.appendChild(Mt5700.formGroup('QQ 每分钟最多条数', qqRate, qqRateHuman));
		bodyEl.appendChild(Mt5700.formGroup('富文本附带「打开管理页」按钮', qqKb.wrap,
			'在 QQ 富文本消息底部附带跳转按钮。'));
		bodyEl.appendChild(Mt5700.formGroup('按钮跳转地址', qqKbUrl, '一般填路由器管理地址；留空按局域网 IP 推导。'));
		bodyEl.appendChild(Mt5700.formGroup('启动时自动配置 QQ 菜单', qqMenu.wrap,
			'在 QQ 单聊窗口底部配置「查询状态 / 查询流量」菜单项（仅单聊场景）。'));
		all.qqFormat = qqFormat; all.qqRate = qqRate; all.qqKb = qqKb.input;
		all.qqKbUrl = qqKbUrl; all.qqMenu = qqMenu.input;

		var QQ_RATE_TAIL = '。QQ 平台频控：群 30~60 条/分钟、单聊 20 条/分钟，超限的消息会被平台直接丢弃。';
		function qqRateText(n) {
			if (isNaN(n) || n < 0) return '当前值为空或非法，保存后按默认 10 条/分钟处理' + QQ_RATE_TAIL;
			if (n === 0) return '不节流：按事件发生顺序立即发送' + QQ_RATE_TAIL;
			n = Math.min(60, n);
			var gapMs = Math.round(60000 / n);
			var gapText = (gapMs / 1000).toFixed(gapMs % 1000 ? 1 : 0) + ' 秒';
			return '最多 ' + n + ' 条/分钟（约每 ' + gapText + '一条），超出的排队延后发送而不是丢弃' + QQ_RATE_TAIL;
		}
		qqRate.addEventListener('input', function () {
			qqRateHuman.textContent = qqRateText(parseInt(qqRate.value, 10));
		});

		/* ---- 定时推送间隔 ---- */
		bodyEl.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '定时推送间隔'));
		var timerInput = Mt5700.input('number', '10', '');
		timerInput.min = 1; timerInput.max = 1440; timerInput.step = 1;
		var timerQuick = Mt5700.select([
			{ label: '自定义', value: '' }, { label: '1 分钟', value: '1' },
			{ label: '5 分钟', value: '5' }, { label: '10 分钟（默认）', value: '10' },
			{ label: '30 分钟', value: '30' }, { label: '1 小时', value: '60' },
			{ label: '3 小时', value: '180' }, { label: '12 小时', value: '720' },
			{ label: '24 小时', value: '1440' }
		], '');
		timerQuick.addEventListener('change', function () {
			if (timerQuick.value) timerInput.value = timerQuick.value;
		});
		var timerGrid = E('div', { 'class': 'mt5700-cfg-grid' });
		timerGrid.appendChild(Mt5700.formGroup('定时推送间隔（分钟）', timerInput,
			'范围 1-1440，默认 10。到点主动推送当前实际情况，与下面信号巡检是两条独立周期线。'));
		timerGrid.appendChild(Mt5700.formGroup('快捷时长', timerQuick));
		bodyEl.appendChild(timerGrid);
		all.timer = timerInput;

		/* ---- 信号定时巡检 ---- */
		var pollBox = E('div', { 'class': 'mt5700-cfg-box' });
		pollBox.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '信号定时巡检'));
		var pollEnable = C.mkCheck();
		var pollStart = Mt5700.input('time', '', '00:00');
		var pollEnd = Mt5700.input('time', '', '23:59');
		var pollInterval = Mt5700.input('number', '300', '');
		pollInterval.min = 30; pollInterval.max = 3600;
		var pollMode = Mt5700.select([
			{ label: '仅信号变化时推送（推荐）', value: 'change' },
			{ label: '每次巡检都推送当前状态', value: 'always' }
		], 'change');
		var pollDelta = Mt5700.input('number', '3', '');
		pollDelta.min = 1; pollDelta.max = 30;
		var pg = E('div', { 'class': 'mt5700-cfg-grid' });
		pollBox.appendChild(Mt5700.formGroup('启用信号定时巡检', pollEnable.wrap,
			'仅「信号变化通知」依赖它；短信与来电由模组主动上报，不受影响'));
		var pollRow = E('div', { 'class': 'mt5700-cfg-row' });
		pollRow.appendChild(pollStart);
		pollRow.appendChild(E('span', { 'class': 'mt5700-cfg-sep' }, '至'));
		pollRow.appendChild(pollEnd);
		var pollRowGroup = Mt5700.formGroup('巡检时段', pollRow,
			'起点晚于终点表示跨零点（如 22:00 至 06:00）；两端相同视为全天。');
		pollRowGroup.classList.add('mt5700-cfg-span2');
		pg.appendChild(pollRowGroup);
		pg.appendChild(Mt5700.formGroup('巡检间隔（秒）', pollInterval, '范围 30-3600，默认 300'));
		pg.appendChild(Mt5700.formGroup('推送策略', pollMode));
		pg.appendChild(Mt5700.formGroup('变化阈值（dB）', pollDelta, '范围 1-30，默认 3，仅「仅变化时推送」生效'));
		pollBox.appendChild(pg);
		bodyEl.appendChild(pollBox);
		all.pollEnable = pollEnable.input; all.pollStart = pollStart; all.pollEnd = pollEnd;
		all.pollInterval = pollInterval; all.pollMode = pollMode; all.pollDelta = pollDelta;

		/* ---- 信号类最小间隔（生产者侧，原有功能） ---- */
		var rateBox = E('div', { 'class': 'mt5700-cfg-box' });
		rateBox.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '网络切换提醒最小间隔（防刷屏）'));
		var rateMin = Mt5700.input('number', '60', '');
		rateMin.min = 0; rateMin.max = 10080; rateMin.step = 1;
		var rateQuick = Mt5700.select([
			{ label: '自定义', value: '' }, { label: '5 分钟', value: '5' },
			{ label: '15 分钟', value: '15' }, { label: '30 分钟', value: '30' },
			{ label: '1 小时（默认）', value: '60' }, { label: '3 小时', value: '180' },
			{ label: '6 小时', value: '360' }, { label: '12 小时', value: '720' },
			{ label: '24 小时', value: '1440' }, { label: '不限频', value: '0' }
		], '60');
		var rateHuman = E('span', { 'class': 'mt5700-hint' }, '');
		rateQuick.addEventListener('change', function () {
			if (rateQuick.value) rateMin.value = rateQuick.value;
			rateHuman.textContent = C.rateText(rateMin.value);
		});
		rateMin.addEventListener('input', function () { rateHuman.textContent = C.rateText(rateMin.value); });
		rateBox.appendChild(Mt5700.formGroup('信号类最小间隔（分钟）', rateMin,
			'范围 0-10080，默认 60；0=不限频。只约束信号类巡检与 URC 上报；短信来电与定时推送不受限。'));
		rateBox.appendChild(Mt5700.formGroup('快捷间隔', rateQuick, rateHuman));
		bodyEl.appendChild(rateBox);
		all.rateMin = rateMin; all.rateQuick = rateQuick;

		/* ---- 每种推送类型独立的频率 + 时段门控（本次新增） ---- */
		var gateBox = E('div', { 'class': 'mt5700-cfg-box' });
		gateBox.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '分类型推送频率与时段（独立控制）'));
		gateBox.appendChild(E('div', { 'class': 'mt5700-hint' },
			'四类事件各有独立的频率与时段限制，互不影响。频率：同类两条之间的最小间隔（0=不限）；'
			+ '时段：仅在该时段内投递，起点>终点可跨零点，窗外可选延迟补发或丢弃。默认全关，与改造前行为一致。'));
		var gateCtrls = {};
		GATE_KINDS.forEach(function (g) {
			var sub = E('div', { 'class': 'mt5700-cfg-box' });
			sub.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, g.label));
			var gg = E('div', { 'class': 'mt5700-cfg-grid' });
			var rateOn = C.mkCheck();
			var minInt = Mt5700.input('number', '60', '');
			minInt.min = 0; minInt.max = 10080; minInt.step = 1;
			var winOn = C.mkCheck();
			var wStart = Mt5700.input('time', '', '00:00');
			var wEnd = Mt5700.input('time', '', '23:59');
			var wAction = Mt5700.select([
				{ label: '延迟到窗口开启后补发（同类只留最新一条）', value: 'defer' },
				{ label: '直接丢弃窗外事件', value: 'drop' }
			], 'defer');
			gg.appendChild(Mt5700.formGroup('启用频率限制', rateOn.wrap));
			gg.appendChild(Mt5700.formGroup('最小间隔（分钟，0=不限）', minInt, '范围 0-10080'));
			gg.appendChild(Mt5700.formGroup('启用推送时段', winOn.wrap));
			var wr = E('div', { 'class': 'mt5700-cfg-row' });
			wr.appendChild(wStart); wr.appendChild(E('span', { 'class': 'mt5700-cfg-sep' }, '至')); wr.appendChild(wEnd);
			var wrg = Mt5700.formGroup('允许时段', wr, '起点>终点=跨零点；两端相同=全天');
			wrg.classList.add('mt5700-cfg-span2');
			gg.appendChild(wrg);
			gg.appendChild(Mt5700.formGroup('窗外策略', wAction));
			sub.appendChild(gg);
			gateBox.appendChild(sub);
			gateCtrls[g.key] = { rateOn: rateOn.input, minInt: minInt, winOn: winOn.input, wStart: wStart, wEnd: wEnd, wAction: wAction };
		});
		bodyEl.appendChild(gateBox);

		/* ---- 操作区：测试推送 / QQ 菜单 / 绑定进度（即时 RPC，不写 UCI） ---- */
		var notifyTest = L.rpc.declare({
			object: 'mt5700', method: 'notify_test', params: ['channel', '_rid'], expect: {}
		});
		var testStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var testBtn = Mt5700.button('发送测试通知', function () {
			testBtn.disabled = true;
			testStatus.textContent = '正在发送测试通知…';
			var channels = [];
			if (wechat.input.checked && String(C.get('wechat_webhook', '')) !== '') channels.push('wechat');
			if (qq.input.checked && (qqTarget.value === 'bind' || qqAppId.value.trim() !== '')) channels.push('qq');
			if (!channels.length) {
				testStatus.textContent = '没有已启用的推送通道（先填写 WebHook 或 QQ 配置并保存）';
				testBtn.disabled = false; return;
			}
			Promise.all(channels.map(function (ch) {
				return notifyTest(ch, 'test-' + ch + '-' + Date.now()).then(function (res) {
					return { channel: ch, ok: !!(res && res.success), error: (res && res.error) || '' };
				}).catch(function (err) {
					return { channel: ch, ok: false, error: (err && err.message) || 'RPC 调用失败' };
				});
			})).then(function (results) {
				testStatus.textContent = results.map(function (r) {
					return (r.channel === 'qq' ? 'QQ 机器人' : '企业微信') + '：' + (r.ok ? '发送成功' : '失败（' + r.error + '）');
				}).join('；');
			}).then(function () { testBtn.disabled = false; });
		});
		var smsTestBtn = Mt5700.button('测试短信推送', function () { runKindTest(smsTestBtn, 'sms', '短信'); });
		var callTestBtn = Mt5700.button('测试来电推送', function () { runKindTest(callTestBtn, 'call', '来电'); });
		function runKindTest(btn, channel, label) {
			btn.disabled = true;
			testStatus.textContent = '正在发送测试' + label + '推送…';
			notifyTest(channel, 'test-' + channel + '-' + Date.now()).then(function (res) {
				testStatus.textContent = (res && res.success)
					? label + '测试推送已发送'
					: label + '测试推送未发送：' + ((res && res.error) || '未知原因');
			}).catch(function (err) {
				testStatus.textContent = label + '测试推送失败：' + ((err && err.message) || 'RPC 失败');
			}).then(function () { btn.disabled = false; });
		}
		var qr = E('div', { 'class': 'mt5700-form-group' });
		qr.appendChild(testBtn); qr.appendChild(smsTestBtn); qr.appendChild(callTestBtn); qr.appendChild(testStatus);
		bodyEl.appendChild(qr);

		var qqMenuRpc = L.rpc.declare({
			object: 'mt5700', method: 'qq_menu', params: ['action', '_rid'], expect: {}
		});
		var qqMenuStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var qqMenuBtn = Mt5700.button('配置 QQ 菜单', function () {
			qqMenuBtn.disabled = true;
			qqMenuStatus.textContent = '正在配置 QQ 自定义菜单…';
			qqMenuRpc('set', 'menu-' + Date.now()).then(function (res) {
				qqMenuStatus.textContent = (res && res.success) ? '菜单已配置' : '配置失败：' + ((res && res.error) || '未知原因');
			}).catch(function (err) {
				qqMenuStatus.textContent = '配置失败：' + ((err && err.message) || 'RPC 失败');
			}).then(function () { qqMenuBtn.disabled = false; });
		});
		bodyEl.appendChild(E('div', { 'class': 'mt5700-form-group' }, qqMenuBtn, qqMenuStatus));

		var qqBindStatus = L.rpc.declare({ object: 'mt5700', method: 'qq_bind_status', params: ['_rid'], expect: {} });
		var bindLine = E('span', { 'class': 'mt5700-hint' }, '');
		var bindBarWrap = E('div', { 'style': 'display:none;width:240px;max-width:100%;height:6px;'
			+ 'background:rgba(127,127,127,.25);border-radius:3px;overflow:hidden;margin-top:6px;' });
		var bindBar = E('div', { 'style': 'height:100%;width:100%;border-radius:3px;'
			+ 'background:var(--mt5700-accent,#3f8edc);transition:width .5s linear;' });
		bindBarWrap.appendChild(bindBar);
		bodyEl.appendChild(E('div', { 'class': 'mt5700-form-group' },
			E('strong', {}, '绑定进度：'), bindLine, bindBarWrap));
		function fmtMmSs(sec) {
			var m = Math.floor(sec / 60), s = sec % 60;
			return m + ':' + (s < 10 ? '0' : '') + s;
		}
		var bindTimer = setInterval(function () {
			if (!bindLine.isConnected) { clearInterval(bindTimer); return; }
			qqBindStatus('bind-' + Date.now()).then(function (res) {
				if (!res) return;
				var st = String(res.state || 'idle');
				var left = parseInt(res.left, 10) || 0;
				var isBind = qqTarget.value === 'bind';
				if (st === 'waiting') {
					bindBarWrap.style.display = '';
					bindBar.style.width = Math.max(0, Math.min(100, left / 600 * 100)) + '%';
					bindLine.textContent = '等待绑定：用你的 QQ 给机器人发一条消息即可完成（剩余 ' + fmtMmSs(left) + '）';
				} else if (st === 'success') {
					bindBarWrap.style.display = 'none';
					bindLine.textContent = '绑定成功（已写回 UCI 并生效）';
				} else if (st === 'failed') {
					bindBarWrap.style.display = 'none';
					bindLine.textContent = '绑定失败：' + (res.error || '未知原因');
				} else if (isBind) {
					bindBarWrap.style.display = 'none';
					bindLine.textContent = '已配置绑定模式：保存并应用后开始等待消息';
				} else {
					bindBarWrap.style.display = 'none'; bindLine.textContent = '';
				}
			}).catch(function () { /* 静默重试 */ });
		}, 2000);

		/* ---- 控件联动 ---- */
		function syncPollState() {
			var masterOn = master.input.checked;
			var pollOn = masterOn && pollEnable.input.checked;
			[pollStart, pollEnd, pollInterval, pollMode].forEach(function (el) { el.disabled = !pollOn; });
			pollDelta.disabled = !pollOn || pollMode.value !== 'change';
			var rateOn = master.input.checked && notifySignal.input.checked;
			rateMin.disabled = !rateOn; rateQuick.disabled = !rateOn;
		}
		function syncNotifyState() {
			var on = master.input.checked;
			[notifyCalls.input, notifySms.input, notifySignal.input, notifyMem.input].forEach(function (el) { el.disabled = !on; });
			pollEnable.input.disabled = !on;
			syncPollState();
		}
		master.input.addEventListener('change', syncNotifyState);
		pollEnable.input.addEventListener('change', syncPollState);
		pollMode.addEventListener('change', syncPollState);
		notifySignal.input.addEventListener('change', syncPollState);

		/* ---- 读写 ---- */
		function snap() {
			var o = {};
			Object.keys(all).forEach(function (k) {
				var el = all[k];
				o[k] = (el && el.type === 'checkbox') ? el.checked : (el ? el.value : '');
			});
			GATE_KINDS.forEach(function (g) {
				var c = gateCtrls[g.key];
				o['g_' + g.key] = [c.rateOn.checked, c.minInt.value, c.winOn.checked, c.wStart.value, c.wEnd.value, c.wAction.value].join('|');
			});
			return JSON.stringify(o);
		}
		function load() {
			master.input.checked = C.get('notify_enabled', '1') === '1';
			notifyCalls.input.checked = C.get('notify_call', '1') === '1';
			notifySms.input.checked = C.get('notify_sms', '1') === '1';
			notifySignal.input.checked = C.get('notify_signal', '1') === '1';
			notifyMem.input.checked = C.get('notify_memory_full', '1') === '1';
			wechat.input.checked = C.get('wechat_enabled', '0') === '1';
			webhook.value = String(C.get('wechat_webhook', ''));
			qq.input.checked = C.get('qq_enabled', '0') === '1';
			qqAppId.value = String(C.get('qq_app_id', ''));
			qqSecret.value = String(C.get('qq_app_secret', ''));
			qqTarget.value = String(C.get('qq_target_type', 'group'));
			qqBind.value = String(C.get('qq_bind_qq', ''));
			qqTargetId.value = String(C.get('qq_target_id', ''));
			qqFormat.value = String(C.get('qq_msg_format', 'auto')) || 'auto';
			var qr = parseInt(C.get('qq_max_per_minute', '10'), 10);
			qqRate.value = String(isNaN(qr) ? 10 : qr);
			qqRateHuman.textContent = qqRateText(parseInt(qqRate.value, 10));
			qqKb.input.checked = C.get('qq_keyboard_enabled', '0') === '1';
			qqKbUrl.value = String(C.get('qq_keyboard_url', ''));
			qqMenu.input.checked = C.get('qq_menu_enabled', '0') === '1';

			var tr = String(C.get('notify_timer_interval', ''));
			var legacy = parseInt(C.get('notify_interval', ''), 10) || 0;
			if (tr === '' && legacy > 0) {
				timerInput.value = legacy === 60 ? '10' : String(Math.max(1, Math.ceil(legacy / 60)));
			} else {
				timerInput.value = tr || '10';
			}
			timerQuick.value = timerInput.value;

			pollEnable.input.checked = C.get('notify_poll_enabled', '1') === '1';
			C.setTimeInput(pollStart, C.get('notify_poll_start', '00:00'), '00:00');
			C.setTimeInput(pollEnd, C.get('notify_poll_end', '23:59'), '23:59');
			pollInterval.value = String(parseInt(C.get('notify_poll_interval', '300'), 10) || 300);
			pollMode.value = C.get('notify_poll_all', '0') === '1' ? 'always' : 'change';
			pollDelta.value = String(parseInt(C.get('notify_poll_delta', '3'), 10) || 3);
			var rr = parseInt(C.get('notify_signal_min_interval', '60'), 10);
			rateMin.value = String(isNaN(rr) || rr < 0 ? 60 : rr);
			rateQuick.value = rateMin.value;
			rateHuman.textContent = C.rateText(rateMin.value);

			GATE_KINDS.forEach(function (g) {
				var c = gateCtrls[g.key], p = g.prefix;
				c.rateOn.checked = C.get(p + '_rate_enabled', '0') === '1';
				c.minInt.value = String(C.clampIntAllowZero(C.get(p + '_min_interval', '60'), 60, 10080));
				c.winOn.checked = C.get(p + '_window_enabled', '0') === '1';
				C.setTimeInput(c.wStart, C.get(p + '_window_start', '00:00'), '00:00');
				C.setTimeInput(c.wEnd, C.get(p + '_window_end', '23:59'), '23:59');
				c.wAction.value = C.get(p + '_window_action', 'defer') === 'drop' ? 'drop' : 'defer';
			});
			syncNotifyState();
			baseline = snap();
		}
		function validate() { return null; }
		function save(set) {
			set('notify_enabled', master.input.checked ? '1' : '0');
			set('notify_call', notifyCalls.input.checked ? '1' : '0');
			set('notify_sms', notifySms.input.checked ? '1' : '0');
			set('notify_signal', notifySignal.input.checked ? '1' : '0');
			set('notify_memory_full', notifyMem.input.checked ? '1' : '0');
			set('wechat_enabled', wechat.input.checked ? '1' : '0');
			set('wechat_webhook', webhook.value.trim());
			set('qq_enabled', qq.input.checked ? '1' : '0');
			set('qq_app_id', qqAppId.value.trim());
			set('qq_app_secret', qqSecret.value.trim());
			set('qq_target_type', qqTarget.value);
			set('qq_bind_qq', qqBind.value.trim());
			set('qq_target_id', qqTargetId.value.trim());
			set('qq_msg_format', qqFormat.value);
			set('qq_keyboard_enabled', qqKb.input.checked ? '1' : '0');
			set('qq_keyboard_url', qqKbUrl.value.trim());
			set('qq_menu_enabled', qqMenu.input.checked ? '1' : '0');
			var qn = parseInt(qqRate.value, 10);
			set('qq_max_per_minute', String(Math.min(60, isNaN(qn) || qn < 0 ? 10 : qn)));
			var tm = Math.min(1440, Math.max(1, parseInt(timerInput.value, 10) || 10));
			set('notify_timer_interval', String(tm));
			set('notify_interval', ''); // 旧键置空
			set('notify_poll_enabled', pollEnable.input.checked ? '1' : '0');
			set('notify_poll_start', pollStart.value || '00:00');
			set('notify_poll_end', pollEnd.value || '23:59');
			set('notify_poll_interval', String(parseInt(pollInterval.value, 10) || 300));
			set('notify_poll_all', pollMode.value === 'always' ? '1' : '0');
			set('notify_poll_delta', String(parseInt(pollDelta.value, 10) || 3));
			var rn = parseInt(rateMin.value, 10);
			set('notify_signal_min_interval', String(Math.min(10080, isNaN(rn) || rn < 0 ? 60 : rn)));
			GATE_KINDS.forEach(function (g) {
				var c = gateCtrls[g.key], p = g.prefix;
				var mn = parseInt(c.minInt.value, 10);
				set(p + '_rate_enabled', c.rateOn.checked ? '1' : '0');
				set(p + '_min_interval', String(Math.min(10080, isNaN(mn) || mn < 0 ? 60 : mn)));
				set(p + '_window_enabled', c.winOn.checked ? '1' : '0');
				set(p + '_window_start', c.wStart.value || '00:00');
				set(p + '_window_end', c.wEnd.value || '23:59');
				set(p + '_window_action', c.wAction.value === 'drop' ? 'drop' : 'defer');
			});
		}
		return {
			load: load, validate: validate, save: save,
			isDirty: function () { return snap() !== baseline; },
			onClose: function () { if (bindTimer) clearInterval(bindTimer); }
		};
	}

	return {
		meta: {
			key: 'notify',
			title: '通知与推送',
			icon: 'op-sms',
			desc: '事件开关、企业微信/QQ 通道、定时推送、信号巡检与分类型频率时段控制'
		},
		build: build
	};
})();

var MtConfigNotifyClass = L.Class.extend(MtConfigNotify);
if (typeof window !== 'undefined') {
	window.MtConfigNotify = new MtConfigNotifyClass();
}
return MtConfigNotifyClass;
