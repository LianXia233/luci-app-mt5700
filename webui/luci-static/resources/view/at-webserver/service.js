'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
'require at-webserver/ui';
/* global L, AtWs, Parse, Mt5700, Ui */

/**
 * 服务配置 - Debian 独立服务版
 *
 * 与 OpenWrt 版的差异：
 * - 服务状态/重启改经后端 /api/service/status|restart（systemd 管理进程，
 *   重启 = 后端优雅退出，由 systemd Restart=always 自动拉起）。
 * - 串口设备列表来自后端扫描 /dev（ttyUSB/ttyACM/ttyAMA/ttyS）。
 * - 保存流程：暂存键值 → /api/config 落盘 → /api/config/apply 热应用；
 *   结构性配置（连接类型/串口/端口等）提示重启后生效。
 * - 定时锁频支持热应用（schedule_enabled 与时段参数即时生效，无需重启）。
 * - 通知卡提供「推送测试」：固定文案经后端 /api/rpc/mt5700/notify_test
 *   直发已保存的 WebHook，用于验证企业微信通道是否通畅。
 * - 推送相关入口（自动推送总开关 / 企业微信 / 定时推送 / 信号定时巡检 / QQ 推送）
 *   全部走本分支既有的 /api/config 扁平键值，不依赖 ubus 或 UCI 包：
 *   保存后由 /api/config/apply 判定是否需要重启（这些通道都在启动时构造）。
 * - 流量统计来源不在本页：状态页的「统计来源」下拉经 /api/rpc/mt5700/usage_ctl
 *   的 set_source 动作即时换源，无需重启。
 */

var SERVICE = 'at-webserver';

function resolveStatus(state) {
	if (!state.alive) {
		return {
			label: '离线', variant: 'danger', pid: null,
			hint: '无法连接后端服务。请检查 systemd 状态：systemctl status at-webserver'
		};
	}
	return { label: '运行中', variant: 'success', pid: state.pid || null, hint: '' };
}

return L.view.extend({
	load: function () {
		var status = L._httpJson('/api/service/status').catch(function () {
			return { alive: false };
		});
		return Promise.all([
			L.uci.load(SERVICE),
			status
		]).then(function (res) {
			var st = res[1] || {};
			var enabled = L.uci.get(SERVICE, 'config', 'enabled');
			enabled = enabled === null || enabled === undefined ? '1' : String(enabled);
			return {
				status: st,
				enabled: enabled
			};
		});
	},

	render: function (data) {
		var self = this;
		var page = Mt5700.page('服务配置', 'AT 后台守护进程、串口/TCP 探测与异步通知联动配置', 'service', '守护进程 · 后台服务');
		var body = page._body;

		var state = data || {};
		var svc = state.status || {};

		/* ---------- 服务状态判定 ---------- */
		var status = resolveStatus({
			alive: svc.alive !== false,
			running: !!svc.pid,
			pid: svc.pid,
			enabled: state.enabled
		});

		/* 服务状态 + 定时锁频：双列并排（定时锁频卡在下方创建，此处先建容器） */
		var rowTop = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowTop);

		var statusCard = Mt5700.card('服务状态', '');
		var statusBody = E('div');
		statusCard._body.appendChild(statusBody);
		rowTop.appendChild(statusCard);

		var statusRow = E('div', { 'class': 'mt5700-inline' });
		statusRow.appendChild(Mt5700.badge(status.label, status.variant));
		if (status.pid) statusRow.appendChild(Mt5700.badge('PID ' + status.pid, 'neutral'));
		if (svc.version) statusRow.appendChild(Mt5700.badge('v' + svc.version, 'neutral'));
		statusBody.appendChild(statusRow);

		var actions = Mt5700.panelActions(
			Mt5700.button('热应用配置', function () { applyConfig(); }, 'primary'),
			Mt5700.button('重启服务', function () { restartService(); }, 'primary')
		);
		var reloadBtn = actions.firstChild;
		var restartBtn = actions.lastChild;

		if (svc.uptime_secs != null) {
			statusBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'已运行 ' + AtWs.formatDuration(svc.uptime_secs) + '；进程由 systemd 管理（at-webserver.service）'));
		}
		if (status.hint) {
			statusBody.appendChild(E('div', { 'class': 'mt5700-hint' }, status.hint));
		}
		statusBody.appendChild(actions);

		/* ---------- 连接配置 + Web 服务（双列并排） ---------- */
		var rowConn = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowConn);

		var connCard = Mt5700.card('调制解调器连接', '后端连接模组的通道');
		var connBody = E('div');
		connCard._body.appendChild(connBody);
		rowConn.appendChild(connCard);

		var connTypeSel = Mt5700.select([
			{ label: 'PCUI 串口（默认，优先 /dev/ttyUSB1）', value: 'SERIAL' },
			{ label: '网络连接（TCP，备用）', value: 'NETWORK' }
		], 'SERIAL');
		connBody.appendChild(Mt5700.formGroup('连接类型', connTypeSel));

		var hostInput = Mt5700.input('text', '192.168.8.1', '');
		connBody.appendChild(Mt5700.formGroup('网络主机', hostInput));

		var netPortInput = Mt5700.input('number', '20249', '');
		netPortInput.min = 1;
		netPortInput.max = 65535;
		connBody.appendChild(Mt5700.formGroup('网络端口', netPortInput, '模组 TCP 端口，默认 20249'));

		/* 串口：下拉 + 自定义；选项来自系统 /dev 识别结果（后端扫描） */
		var serialSel = Mt5700.select([], '');
		function fillSerialOptions(current) {
			while (serialSel.firstChild) serialSel.removeChild(serialSel.firstChild);
			function add(v, label) {
				var o = E('option', { value: v }, label || v);
				serialSel.appendChild(o);
			}
			add('auto', '自动探测（优先 /dev/ttyUSB1 PCUI）');
			(svc.serials || []).forEach(function (p) {
				var hint = p === '/dev/ttyUSB1' ? '（PCUI 推荐）' : '';
				add(p, p + hint);
			});
			add('__custom__', '自定义路径…');
			if (current) {
				var exists = false;
				for (var i = 0; i < serialSel.options.length; i++) {
					if (serialSel.options[i].value === current) { exists = true; break; }
				}
				if (!exists && current !== '__custom__') {
					add(current, current + '（当前配置）');
				}
				serialSel.value = current;
			}
		}
		var serialCustom = Mt5700.input('text', '例如 /dev/ttyUSB2', '');
		serialCustom.style.display = 'none';
		serialSel.addEventListener('change', function () {
			serialCustom.style.display = serialSel.value === '__custom__' ? '' : 'none';
		});
		connBody.appendChild(Mt5700.formGroup('串口设备', serialSel, '列出系统已识别的 ttyUSB/ttyACM/ttyS 设备'));
		connBody.appendChild(Mt5700.formGroup('自定义串口路径', serialCustom, '仅在选择「自定义路径」时生效'));

		var baudInput = Mt5700.input('number', '115200', '');
		connBody.appendChild(Mt5700.formGroup('波特率', baudInput));

		/* ---------- Web 服务（HTTP API + WebUI） ---------- */
		var wsCard = Mt5700.card('Web 服务', '独立 WebUI 与 HTTP API 的监听配置');
		var wsBody = E('div');
		wsCard._body.appendChild(wsBody);
		rowConn.appendChild(wsCard);

		var wsPortInput = Mt5700.input('number', '9000', '');
		wsPortInput.min = 1;
		wsPortInput.max = 65535;
		wsBody.appendChild(Mt5700.formGroup('HTTP 端口', wsPortInput, '默认 9000，浏览器访问 http://<设备IP>:9000'));

		var wsBindSel = Mt5700.select([
			{ label: '所有接口（0.0.0.0，推荐）', value: '0.0.0.0' },
			{ label: '仅本机（127.0.0.1）', value: '127.0.0.1' }
		], '0.0.0.0');
		wsBody.appendChild(Mt5700.formGroup('监听范围', wsBindSel, '对外监听时建议设置认证密钥'));

		var authKeyInput = Mt5700.input('text', '留空表示无需认证', '');
		wsBody.appendChild(Mt5700.formGroup('认证密钥', authKeyInput, '设置后 WebUI 与 API 均需携带该密钥'));

		/* ---------- 定时锁频 ---------- */
		var schedCard = Mt5700.card('定时锁频', '总开关（时段参数在「定时锁频」页编排，保存后即时生效）');
		var schedBody = E('div');
		schedCard._body.appendChild(schedBody);
		rowTop.appendChild(schedCard);

		var schedSwitch = E('div', { 'class': 'mt5700-switch' });
		var schedChk = E('input', { type: 'checkbox' });
		schedSwitch.appendChild(schedChk);
		schedBody.appendChild(Mt5700.formGroup('启用定时锁频', schedSwitch, '在「5G 模组管理 → 定时锁频」编排时段'));

		/* ---------- 通知配置 ---------- */
		var notifCard = Mt5700.card('通知', '事件通知与 WebHook');
		var notifBody = E('div');
		notifCard._body.appendChild(notifBody);
		body.appendChild(notifCard);

		function mkCheck() {
			var wrap = E('div', { 'class': 'mt5700-switch' });
			var input = E('input', { type: 'checkbox' });
			wrap.appendChild(input);
			return { wrap: wrap, input: input };
		}

		/* 自动推送总开关：后端所有外发消息的闸门，关闭后仅保留本地通知日志，
		 * 信号定时巡检也一并停止。放在通知卡最前，避免用户逐条关开关还关不掉。 */
		var notifyMaster = mkCheck();
		notifBody.appendChild(Mt5700.formGroup('自动推送总开关', notifyMaster.wrap,
			'关闭后后端不再外发任何消息（仅保留本地通知日志），信号定时巡检也一并停止'));

		var notifyCalls = mkCheck();
		var notifySms = mkCheck();
		var notifySignal = mkCheck();
		var notifyMem = mkCheck();
		var wechatChk = mkCheck();

		notifBody.appendChild(Mt5700.formGroup('来电通知', notifyCalls.wrap, '实时推送，不受定时推送间隔影响'));
		notifBody.appendChild(Mt5700.formGroup('新短信通知', notifySms.wrap, '实时推送，不受定时推送间隔影响'));
		notifBody.appendChild(Mt5700.formGroup('信号变化通知', notifySignal.wrap, '受下方「信号类通知最小间隔」限频'));
		notifBody.appendChild(Mt5700.formGroup('短信存储满通知', notifyMem.wrap));
		notifBody.appendChild(Mt5700.formGroup('企业微信推送', wechatChk.wrap,
			'与 QQ 推送互不影响，两者各自单独控制'));

	var webhookInput = Mt5700.input('text', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', '');
	notifBody.appendChild(Mt5700.formGroup('企业微信 WebHook', webhookInput, '通知将推送到该 WebHook 地址'));

	/* 推送测试：固定文案直发 WebHook，验证通知通道是否通畅 */
	var notifyTestBtn = Mt5700.button('推送测试', function () {
		if (!webhookInput.value.trim()) {
			Mt5700.error('请先填写企业微信 WebHook 地址并保存，再测试推送');
			return;
		}
		notifyTestBtn.disabled = true;
		L._httpJson('/api/rpc/mt5700/notify_test', { method: 'POST', body: {} }).then(function (res) {
			if (res && res.success) {
				Mt5700.success('测试通知已推送，请检查企业微信群消息');
			} else {
				Mt5700.error('推送失败：' + ((res && res.error) || '未知错误'));
			}
		}).catch(function (err) {
			Mt5700.error('推送失败：' + ((err && err.message) || '未知错误'));
		}).then(function () {
			notifyTestBtn.disabled = false;
		});
	});
	notifBody.appendChild(Mt5700.formGroup('通道测试', notifyTestBtn, '发送一条固定文案的测试通知（使用已保存的 WebHook 配置）'));

		/* ---------- 定时推送 + 信号定时巡检（两条独立的周期线） ---------- */
		var rowPush = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowPush);

		var timerCard = Mt5700.card('定时推送', '每隔一段时间主动推一次「当前实际情况」');
		var timerBody = E('div');
		timerCard._body.appendChild(timerBody);
		rowPush.appendChild(timerCard);

		var timerInput = Mt5700.input('number', '10', '');
		timerInput.min = 1;
		timerInput.max = 1440;
		timerInput.step = 1;
		timerBody.appendChild(Mt5700.formGroup('推送间隔（分钟）', timerInput,
			'1 ~ 1440 分钟，默认 10。语义是「每 N 分钟推一次现状」，不是事件攒批'));

		var timerQuick = Mt5700.select([
			{ label: '自定义（手动填上面）', value: '' },
			{ label: '1 分钟', value: '1' },
			{ label: '5 分钟', value: '5' },
			{ label: '10 分钟（默认）', value: '10' },
			{ label: '30 分钟', value: '30' },
			{ label: '1 小时', value: '60' },
			{ label: '3 小时', value: '180' },
			{ label: '12 小时', value: '720' },
			{ label: '24 小时', value: '1440' }
		], '');
		timerQuick.addEventListener('change', function () {
			if (timerQuick.value) timerInput.value = timerQuick.value;
			if (typeof AtWs !== 'undefined' && AtWs.uci) AtWs.uci.markDirty();
		});
		timerBody.appendChild(Mt5700.formGroup('常用间隔', timerQuick, '选择后自动填入上方输入框'));

		var pollCard = Mt5700.card('信号定时巡检', '按固定周期采样信号，变化超过阈值才推送');
		var pollBody = E('div');
		pollCard._body.appendChild(pollBody);
		rowPush.appendChild(pollCard);

		var pollChk = mkCheck();
		pollBody.appendChild(Mt5700.formGroup('启用信号巡检', pollChk.wrap,
			'关闭后不再周期采样；实时事件通知（信号变化/来电/短信）不受影响'));

		var pollStart = Mt5700.input('time', '', '');
		var pollEnd = Mt5700.input('time', '', '');
		pollBody.appendChild(Mt5700.formGroup('巡检时段开始', pollStart, 'HH:MM，默认 00:00'));
		pollBody.appendChild(Mt5700.formGroup('巡检时段结束', pollEnd, 'HH:MM，默认 23:59；跨零点可填 22:00 ~ 06:00'));

		var pollInterval = Mt5700.input('number', '300', '');
		pollInterval.min = 30;
		pollInterval.max = 3600;
		pollBody.appendChild(Mt5700.formGroup('采样间隔（秒）', pollInterval, '30 ~ 3600 秒，默认 300'));

		var pollDelta = Mt5700.input('number', '3', '');
		pollDelta.min = 1;
		pollDelta.max = 30;
		pollBody.appendChild(Mt5700.formGroup('信号变化阈值（dB）', pollDelta, '1 ~ 30 dB，默认 3；仅在关闭「每次巡检都推送」时生效'));

		var pollAllChk = mkCheck();
		pollBody.appendChild(Mt5700.formGroup('每次巡检都推送', pollAllChk.wrap, '开启后不判断变化幅度，每次采样都推'));

		var sigMinInput = Mt5700.input('number', '60', '');
		sigMinInput.min = 0;
		sigMinInput.max = 10080;
		pollBody.appendChild(Mt5700.formGroup('信号类通知最小间隔（分钟）', sigMinInput,
			'0 表示不限频，默认 60。只约束事件驱动的信号通知；短信与来电始终实时'));

		/* ---------- QQ 推送 ---------- */
		var qqCard = Mt5700.card('QQ 推送', 'QQ 机器人（官方 API v2），与企业微信通道互不影响');
		var qqBody = E('div');
		qqCard._body.appendChild(qqBody);
		body.appendChild(qqCard);

		var qqChk = mkCheck();
		qqBody.appendChild(Mt5700.formGroup('启用 QQ 推送', qqChk.wrap, '凭据不全时后端不会外发，开启本身不会报错'));

		var qqAppId = Mt5700.input('text', '机器人 AppID', '');
		var qqAppSecret = Mt5700.input('password', 'AppSecret', '');
		qqBody.appendChild(Mt5700.formGroup('AppID', qqAppId, 'QQ 开放平台 → 机器人 → 开发设置'));
		qqBody.appendChild(Mt5700.formGroup('AppSecret', qqAppSecret, '留空可改用环境变量 QQ_BOT_APP_SECRET（环境变量优先级更高）'));

		var qqTargetSel = Mt5700.select([
			{ label: '群聊（group）', value: 'group' },
			{ label: '单聊（c2c）', value: 'c2c' },
			{ label: '频道（channel）', value: 'channel' },
			{ label: '绑定当前用户（bind）', value: 'bind' }
		], 'group');
		qqBody.appendChild(Mt5700.formGroup('推送目标类型', qqTargetSel,
			'bind 模式下目标 ID 留空：机器人首次收到消息时自动抓取 openid 并写回配置'));

		var qqTargetId = Mt5700.input('text', '群 / 用户 openid', '');
		qqBody.appendChild(Mt5700.formGroup('推送目标 ID', qqTargetId, 'group / c2c / channel 模式下必填'));

		var qqBindQq = Mt5700.input('text', '绑定用户 QQ 号（仅展示）', '');
		qqBody.appendChild(Mt5700.formGroup('绑定用户 QQ 号', qqBindQq, '仅作展示标签，事件回调里拿不到 QQ 号'));

		var qqFmtSel = Mt5700.select([
			{ label: '自动（Markdown 优先，失败回落纯文本）', value: 'auto' },
			{ label: '仅 Markdown', value: 'markdown' },
			{ label: '仅纯文本', value: 'text' }
		], 'auto');
		qqBody.appendChild(Mt5700.formGroup('消息格式', qqFmtSel, 'Markdown 连续失败时后端会冷却 10 分钟并直接发纯文本'));

		var qqRateInput = Mt5700.input('number', '10', '');
		qqRateInput.min = 0;
		qqRateInput.max = 60;
		qqBody.appendChild(Mt5700.formGroup('每分钟最多推送（条）', qqRateInput,
			'0 表示不节流，默认 10。QQ 平台频控：群 30~60 条/分钟、单聊 20 条/分钟，超限消息会被平台丢弃'));

		/* ---------- 载入配置（JSON 扁平键，与后端 config.json 一致） ---------- */
		var get = function (key, def) {
			var v = L.uci.get(SERVICE, 'config', key);
			return v == null || v === '' ? def : v;
		};
		connTypeSel.value = String(get('connection_type', 'SERIAL'));
		hostInput.value = String(get('network_host', '192.168.8.1'));
		netPortInput.value = String(get('network_port', '20249'));
		fillSerialOptions(String(get('serial_port', 'auto')));
		baudInput.value = String(get('serial_baudrate', '115200'));
		wsPortInput.value = String(get('http_port', '9000'));
		wsBindSel.value = String(get('http_bind', '0.0.0.0')) === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
		authKeyInput.value = String(get('auth_key', ''));
		schedChk.checked = get('schedule_enabled', '0') === '1';
		notifyCalls.input.checked = get('notify_call', '1') === '1';
		notifySms.input.checked = get('notify_sms', '1') === '1';
		notifySignal.input.checked = get('notify_signal', '1') === '1';
		notifyMem.input.checked = get('notify_memory_full', '1') === '1';
		webhookInput.value = String(get('wechat_webhook', ''));
		notifyMaster.input.checked = get('notify_enabled', '1') === '1';
		wechatChk.input.checked = get('wechat_enabled', '1') === '1';

		/* 定时推送 / 信号巡检 */
		timerInput.value = String(get('notify_timer_interval', '10'));
		pollChk.input.checked = get('notify_poll_enabled', '1') === '1';
		pollStart.value = String(get('notify_poll_start', '00:00'));
		pollEnd.value = String(get('notify_poll_end', '23:59'));
		pollInterval.value = String(get('notify_poll_interval', '300'));
		pollDelta.value = String(get('notify_poll_delta', '3'));
		pollAllChk.input.checked = get('notify_poll_all', '0') === '1';
		sigMinInput.value = String(get('notify_signal_min_interval', '60'));

		/* QQ 推送 */
		qqChk.input.checked = get('qq_enabled', '0') === '1';
		qqAppId.value = String(get('qq_app_id', ''));
		qqAppSecret.value = String(get('qq_app_secret', ''));
		var qqTargetType = String(get('qq_target_type', 'group'));
		qqTargetSel.value = ['group', 'c2c', 'channel', 'bind'].indexOf(qqTargetType) >= 0 ? qqTargetType : 'group';
		qqTargetId.value = String(get('qq_target_id', ''));
		qqBindQq.value = String(get('qq_bind_qq', ''));
		var qqMsgFormat = String(get('qq_msg_format', 'auto'));
		qqFmtSel.value = ['auto', 'markdown', 'text'].indexOf(qqMsgFormat) >= 0 ? qqMsgFormat : 'auto';
		qqRateInput.value = String(get('qq_max_per_minute', '10'));

		/* ---------- 保存（落盘 + 热应用；结构性变更提示重启） ---------- */
		var saveStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var saveBtn = Mt5700.primaryButton('保存并应用', function () {
			var set = function (key, value) {
				L.uci.set(SERVICE, 'config', key, value);
			};
			set('connection_type', connTypeSel.value);
			set('network_host', hostInput.value.trim() || '192.168.8.1');
			set('network_port', String(parseInt(netPortInput.value, 10) || 20249));
			var serialVal = serialSel.value;
			if (serialVal === '__custom__') {
				serialVal = serialCustom.value.trim() || 'auto';
			}
			set('serial_port', serialVal || 'auto');
			set('serial_baudrate', String(parseInt(baudInput.value, 10) || 115200));
			set('http_port', String(parseInt(wsPortInput.value, 10) || 9000));
			set('http_bind', wsBindSel.value);
			set('auth_key', authKeyInput.value.trim());
			set('schedule_enabled', schedChk.checked ? '1' : '0');
			set('notify_call', notifyCalls.input.checked ? '1' : '0');
			set('notify_sms', notifySms.input.checked ? '1' : '0');
			set('notify_signal', notifySignal.input.checked ? '1' : '0');
			set('notify_memory_full', notifyMem.input.checked ? '1' : '0');
			set('wechat_webhook', webhookInput.value.trim());
			set('notify_enabled', notifyMaster.input.checked ? '1' : '0');
			set('wechat_enabled', wechatChk.input.checked ? '1' : '0');

			/* 数值键统一夹到后端接受区间，避免手输越界后被静默回落 */
			var num = function (raw, def, lo, hi) {
				var n = parseInt(raw, 10);
				if (isNaN(n)) n = def;
				return String(Math.min(hi, Math.max(lo, n)));
			};

			/* 定时推送 / 信号巡检 */
			set('notify_timer_interval', num(timerInput.value, 10, 1, 1440));
			set('notify_poll_enabled', pollChk.input.checked ? '1' : '0');
			set('notify_poll_start', pollStart.value.trim() || '00:00');
			set('notify_poll_end', pollEnd.value.trim() || '23:59');
			set('notify_poll_interval', num(pollInterval.value, 300, 30, 3600));
			set('notify_poll_delta', num(pollDelta.value, 3, 1, 30));
			set('notify_poll_all', pollAllChk.input.checked ? '1' : '0');
			set('notify_signal_min_interval', num(sigMinInput.value, 60, 0, 10080));

			/* QQ 推送 */
			set('qq_enabled', qqChk.input.checked ? '1' : '0');
			set('qq_app_id', qqAppId.value.trim());
			set('qq_app_secret', qqAppSecret.value.trim());
			set('qq_target_type', qqTargetSel.value);
			set('qq_target_id', qqTargetId.value.trim());
			set('qq_bind_qq', qqBindQq.value.trim());
			set('qq_msg_format', qqFmtSel.value);
			set('qq_max_per_minute', num(qqRateInput.value, 10, 0, 60));

			// 写内存后立刻标脏，未点保存就离开会被浏览器拦截
			AtWs.uci.markDirty();
			saveBtn.disabled = true;
			saveStatus.textContent = '正在保存并应用…';

			AtWs.uci.uciSave(SERVICE).then(function (res) {
				AtWs.uci.clearDirty();
				if (res.appliedSkipped) {
					saveStatus.textContent = '配置已应用（无待处理的变更）';
				} else {
					saveStatus.textContent = '配置已保存并应用';
				}
				Mt5700.success('配置已保存并应用');
				return applyConfig(true);
			}).catch(function (err) {
				var msg = (err && err.message) || '未知错误';
				saveStatus.textContent = '保存失败：' + msg;
				Mt5700.error('保存失败：' + msg);
			}).then(function () {
				saveBtn.disabled = false;
			});
		});

		var bottomActions = Mt5700.panelActions(saveBtn, saveStatus);
		body.appendChild(bottomActions);

		/* ---------- 作者署名（页脚） ----------
		 * 该元素为项目明确要求保留的项目元素：任何 UI 重构、样式调整、组件替换、
		 * 模板重写都必须保留署名文案与其指向仓库的链接。
		 */
		body.appendChild(E('div', { 'class': 'mt5700-author' }, [
			E('span', { 'class': 'mt5700-author-label' }, '作者：'),
			E('a', {
				'class': 'mt5700-author-link',
				'href': 'https://github.com/LianXia233/luci-app-mt5700',
				'target': '_blank',
				'rel': 'noopener noreferrer'
			}, 'LianXia233')
		]));

		// 任何表单控件变更都标记为「未保存」，离开页面时由浏览器拦截提醒
		page.addEventListener('change', function () { AtWs.uci.markDirty(); });
		page.addEventListener('input', function () { AtWs.uci.markDirty(); });

		/* ---------- 服务操作 ---------- */

		/*
		 * 热应用：通知后端重读配置文件。
		 * schedule_* 等可热应用键立即生效；若存在结构性变更，
		 * 后端返回 restart_required=true，此时提示用户重启服务。
		 */
		function applyConfig(silent) {
			reloadBtn.disabled = true;
			return L._httpJson('/api/config/apply', { method: 'POST', body: {} }).then(function (res) {
				if (res && res.restart_required) {
					if (!silent) {
						Mt5700.confirm('存在需要重启服务才能生效的配置，是否立即重启？', function () {
							doRestart();
						}, '立即重启');
					}
				} else if (!silent) {
					Mt5700.success('配置已热应用，无需重启');
				}
				return refreshStatus();
			}).catch(function (err) {
				if (!silent) Mt5700.error('应用失败：' + ((err && err.message) || '未知错误'));
			}).then(function () {
				reloadBtn.disabled = false;
			});
		}

		function doRestart() {
			return L._httpJson('/api/service/restart', { method: 'POST', body: {} }).then(function () {
				Mt5700.info('重启指令已下发，服务将在数秒内恢复…');
				/* systemd 重启期间 HTTP 会短暂中断，轮询等待恢复 */
				var attempts = 0;
				var timer = setInterval(function () {
					attempts++;
					L._httpJson('/api/service/status').then(function () {
						clearInterval(timer);
						Mt5700.success('服务已恢复');
						refreshStatus();
					}).catch(function () {
						if (attempts >= 20) {
							clearInterval(timer);
							Mt5700.error('等待服务恢复超时，请检查 systemctl status at-webserver');
						}
					});
				}, 1000);
			}).catch(function (err) {
				Mt5700.error('重启失败：' + ((err && err.message) || '未知错误'));
			});
		}

		function restartService() {
			Mt5700.confirm('确定重启 AT 服务？现有 API 调用将短暂中断。', function () {
				restartBtn.disabled = true;
				doRestart().then(function () {
					restartBtn.disabled = false;
				});
			});
		}

		function refreshStatus() {
			return L._httpJson('/api/service/status').then(function (st) {
				svc = st || {};
				state.status = svc;
				var stt = resolveStatus({
					alive: svc.alive !== false,
					running: !!svc.pid,
					pid: svc.pid,
					enabled: state.enabled
				});
				statusRow.innerHTML = '';
				statusRow.appendChild(Mt5700.badge(stt.label, stt.variant));
				if (stt.pid) statusRow.appendChild(Mt5700.badge('PID ' + stt.pid, 'neutral'));
				if (svc.version) statusRow.appendChild(Mt5700.badge('v' + svc.version, 'neutral'));
			}).catch(function () { /* 后端重启中，静默 */ });
		}

		/* 统一启动入口：注入 at.css 并启用全页一致的浮动提示条。
		 * 本页不依赖 AT 通道，回读仍在 load() 完成。 */
		Ui.startup(page, null);

		void self;

		return page;
	}
});
