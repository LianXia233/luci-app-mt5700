'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700 */

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
				'已运行 ' + Mt5700.formatDuration(svc.uptime_secs) + '；进程由 systemd 管理（at-webserver.service）'));
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

		var notifyCalls = mkCheck();
		var notifySms = mkCheck();
		var notifySignal = mkCheck();
		var notifyMem = mkCheck();

		notifBody.appendChild(Mt5700.formGroup('来电通知', notifyCalls.wrap));
		notifBody.appendChild(Mt5700.formGroup('新短信通知', notifySms.wrap));
		notifBody.appendChild(Mt5700.formGroup('信号变化通知', notifySignal.wrap));
		notifBody.appendChild(Mt5700.formGroup('短信存储满通知', notifyMem.wrap));

		var webhookInput = Mt5700.input('text', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', '');
		notifBody.appendChild(Mt5700.formGroup('企业微信 WebHook', webhookInput, '通知将推送到该 WebHook 地址'));

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

		void self;

		return page;
	}
});
