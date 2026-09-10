'use strict';
'require at-webserver/ws';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Ui */

/**
 * 服务配置（原 WebUI 服务 → 服务配置）
 * 合并旧版 LuCI config.js 的全部功能 + 新增项：
 * - connection_type / network_host / network_port / serial_port / baud_rate
 * - websocket_host / websocket_port / websocket_auth_key
 * - 通知开关：notify_*（来电/短信/信号/内存满/WebHook URL 与企业微信）
 * - 定时锁频总开关 schedule_enabled 与告警配置
 * - 保存后通过 ubus 重载服务（等价 /etc/init.d/at-webserver reload）
 */

return L.view.extend({
	load: function () {
		return Promise.all([
			L.uci.load('at-webserver'),
			L.rpc.declare({
				object: 'service',
				method: 'list',
				params: ['name'],
				expect: { '': {} }
			})('at-webserver').catch(function () { return {}; })
		]).then(function (res) {
			return {
				service: res[1] && res[1]['at-webserver'] ? res[1]['at-webserver'] : {}
			};
		});
	},

	render: function (data) {
		var self = this;
		var page = Ui.page('服务配置', 'AT WebSocket 服务与通知设置（保存后自动重载）');
		var body = page._body;

		var state = data || {};
		var serviceRunning = !!(state.service && state.service.instance);

		/* ---------- 服务状态 ---------- */
		var statusPanel = Ui.panel('服务状态', '');
		var statusEl = E('div', { 'class': 'at-tags' });
		statusEl.appendChild(Ui.tag(serviceRunning ? '运行中' : '未运行', serviceRunning ? 'green' : 'red'));
		var actions = E('div', { 'class': 'at-panel-actions' });
		var reloadBtn = Ui.button('重载服务', 'cbi-button-action', reloadService);
		var restartBtn = Ui.button('重启服务', 'cbi-button-action', restartService);
		actions.appendChild(reloadBtn);
		actions.appendChild(restartBtn);
		statusPanel._body.appendChild(statusEl);
		statusPanel._body.appendChild(actions);
		body.appendChild(statusPanel);

		/* ---------- 连接配置 ---------- */
		var connPanel = Ui.panel('调制解调器连接', '后端连接模组的通道');
		var connTypeSel = document.createElement('select');
		connTypeSel.className = 'cbi-input-select';
		[{ v: 'NETWORK', l: '网络连接（TCP）' }, { v: 'SERIAL', l: '串口连接' }, { v: 'AUTO', l: '自动探测（串口优先 ttyUSB1）' }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			connTypeSel.appendChild(opt);
		});
		connPanel._body.appendChild(Ui.field('连接类型', connTypeSel));

		var hostInput = document.createElement('input');
		hostInput.className = 'cbi-input-text';
		hostInput.placeholder = '192.168.8.1';
		connPanel._body.appendChild(Ui.field('网络主机', hostInput));

		var netPortInput = document.createElement('input');
		netPortInput.type = 'number';
		netPortInput.className = 'cbi-input-text';
		netPortInput.min = 1;
		netPortInput.max = 65535;
		connPanel._body.appendChild(Ui.field('网络端口', netPortInput, '模组 TCP 端口，默认 20249'));

		var serialInput = document.createElement('input');
		serialInput.className = 'cbi-input-text';
		serialInput.placeholder = '/dev/ttyUSB1';
		connPanel._body.appendChild(Ui.field('串口设备', serialInput, 'auto 表示自动探测'));

		var baudInput = document.createElement('input');
		baudInput.type = 'number';
		baudInput.className = 'cbi-input-text';
		baudInput.placeholder = '115200';
		connPanel._body.appendChild(Ui.field('波特率', baudInput));
		body.appendChild(connPanel);

		/* ---------- WebSocket ---------- */
		var wsPanel = Ui.panel('WebSocket 服务', 'LuCI 前端连接后端使用的服务端口与密钥');
		var wsHostInput = document.createElement('input');
		wsHostInput.className = 'cbi-input-text';
		wsHostInput.placeholder = '留空表示本机';
		wsPanel._body.appendChild(Ui.field('监听地址', wsHostInput, '留空监听所有接口'));

		var wsPortInput = document.createElement('input');
		wsPortInput.type = 'number';
		wsPortInput.className = 'cbi-input-text';
		wsPortInput.min = 1;
		wsPortInput.max = 65535;
		wsPanel._body.appendChild(Ui.field('WebSocket 端口', wsPortInput, '默认 8765'));

		var authKeyInput = document.createElement('input');
		authKeyInput.className = 'cbi-input-text';
		authKeyInput.placeholder = '留空表示无需认证';
		wsPanel._body.appendChild(Ui.field('认证密钥', authKeyInput, '前端连接时必须携带该密钥，留空放行'));
		body.appendChild(wsPanel);

		/* ---------- 定时锁频 ---------- */
		var schedPanel = Ui.panel('定时锁频', '总开关与默认参数');
		var schedChk = document.createElement('input');
		schedChk.type = 'checkbox';
		schedChk.className = 'cbi-input-checkbox';
		schedPanel._body.appendChild(Ui.field('启用定时锁频', schedChk, '在「网络 → 定时锁频」编排时段'));
		body.appendChild(schedPanel);

		/* ---------- 通知配置 ---------- */
		var notifPanel = Ui.panel('通知', '事件通知与 WebHook');
		var notifyCallsChk = document.createElement('input');
		notifyCallsChk.type = 'checkbox';
		notifyCallsChk.className = 'cbi-input-checkbox';
		notifPanel._body.appendChild(Ui.field('来电通知', notifyCallsChk));

		var notifySmsChk = document.createElement('input');
		notifySmsChk.type = 'checkbox';
		notifySmsChk.className = 'cbi-input-checkbox';
		notifPanel._body.appendChild(Ui.field('新短信通知', notifySmsChk));

		var notifySignalChk = document.createElement('input');
		notifySignalChk.type = 'checkbox';
		notifySignalChk.className = 'cbi-input-checkbox';
		notifPanel._body.appendChild(Ui.field('信号变化通知', notifySignalChk));

		var notifyMemChk = document.createElement('input');
		notifyMemChk.type = 'checkbox';
		notifyMemChk.className = 'cbi-input-checkbox';
		notifPanel._body.appendChild(Ui.field('短信存储满通知', notifyMemChk));

		var webhookInput = document.createElement('input');
		webhookInput.className = 'cbi-input-text';
		webhookInput.placeholder = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx';
		notifPanel._body.appendChild(Ui.field('企业微信 WebHook', webhookInput, '通知将推送到该 WebHook 地址'));
		body.appendChild(notifPanel);

		/* ---------- 载入 UCI ---------- */
		var get = function (section, key, def) {
			var v = L.uci.get('at-webserver', section, key);
			return v == null || v === '' ? def : v;
		};
		connTypeSel.value = String(get('connection', 'type', 'NETWORK'));
		hostInput.value = String(get('connection', 'host', '192.168.8.1'));
		netPortInput.value = String(get('connection', 'port', '20249'));
		serialInput.value = String(get('connection', 'serial_port', 'auto'));
		baudInput.value = String(get('connection', 'baud_rate', '115200'));
		wsHostInput.value = String(get('websocket', 'host', ''));
		wsPortInput.value = String(get('websocket', 'port', '8765'));
		authKeyInput.value = String(get('websocket', 'auth_key', ''));
		schedChk.checked = get('schedule', 'enabled', '0') === '1';
		notifyCallsChk.checked = get('notification', 'notify_call', '1') === '1';
		notifySmsChk.checked = get('notification', 'notify_sms', '1') === '1';
		notifySignalChk.checked = get('notification', 'notify_signal', '1') === '1';
		notifyMemChk.checked = get('notification', 'notify_memory_full', '1') === '1';
		webhookInput.value = String(get('notification', 'webhook_url', ''));

		/* ---------- 保存 ---------- */
		var saveBtn = Ui.primaryButton('保存配置', function () {
			var set = function (section, key, value) {
				if (!L.uci.get('at-webserver', section)) {
					L.uci.add('at-webserver', section, section);
				}
				L.uci.set('at-webserver', section, key, value);
			};
			set('connection', 'type', connTypeSel.value);
			set('connection', 'host', hostInput.value.trim() || '192.168.8.1');
			set('connection', 'port', String(parseInt(netPortInput.value, 10) || 20249));
			set('connection', 'serial_port', serialInput.value.trim() || 'auto');
			set('connection', 'baud_rate', String(parseInt(baudInput.value, 10) || 115200));
			set('websocket', 'host', wsHostInput.value.trim());
			set('websocket', 'port', String(parseInt(wsPortInput.value, 10) || 8765));
			set('websocket', 'auth_key', authKeyInput.value.trim());
			set('schedule', 'enabled', schedChk.checked ? '1' : '0');
			set('notification', 'notify_call', notifyCallsChk.checked ? '1' : '0');
			set('notification', 'notify_sms', notifySmsChk.checked ? '1' : '0');
			set('notification', 'notify_signal', notifySignalChk.checked ? '1' : '0');
			set('notification', 'notify_memory_full', notifyMemChk.checked ? '1' : '0');
			set('notification', 'webhook_url', webhookInput.value.trim());

			L.uci.save('at-webserver').then(function () {
				return L.uci.apply(false).then(function () {
					Ui.success('配置已保存');
					return reloadService();
				});
			}).catch(function (err) {
				Ui.error('保存失败: ' + ((err && err.message) || '未知错误'));
			});
		});
		var actions2 = E('div', { 'class': 'at-panel-actions' });
		actions2.appendChild(saveBtn);
		body.appendChild(actions2);

		/* ---------- 服务操作 ---------- */
		function reloadService() {
			reloadBtn.disabled = true;
			return L.rpc.declare({
				object: 'service',
				method: 'reload',
				params: ['name'],
				expect: { result: 0 }
			})('at-webserver').then(function () {
				Ui.success('服务已重载');
			}).catch(function (err) {
				Ui.error('重载失败: ' + ((err && err.message) || '未知错误'));
			}).finally(function () {
				reloadBtn.disabled = false;
			});
		}

		function restartService() {
			Ui.confirm('确定重启 AT 服务？现有 WebSocket 连接将中断。', function () {
				restartBtn.disabled = true;
				return L.rpc.declare({
					object: 'service',
					method: 'restart',
					params: ['name'],
					expect: { result: 0 }
				})('at-webserver').then(function () {
					Ui.success('服务已重启');
				}).catch(function (err) {
					Ui.error('重启失败: ' + ((err && err.message) || '未知错误'));
				}).finally(function () {
					restartBtn.disabled = false;
				});
			});
		}

		return page;
	}
});
