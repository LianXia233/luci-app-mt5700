'use strict';
'require at-webserver/rpc';
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
		var listSerial = L.rpc.declare({
			object: 'file',
			method: 'list',
			params: ['path'],
			expect: { entries: [] }
		});
		return Promise.all([
			L.uci.load('at-webserver'),
			L.rpc.declare({
				object: 'service',
				method: 'list',
				params: ['name'],
				expect: { '': {} }
			})('at-webserver').catch(function () { return {}; }),
			listSerial('/dev').catch(function () { return { entries: [] }; })
		]).then(function (res) {
			var entries = (res[2] && res[2].entries) || [];
			var serials = [];
			entries.forEach(function (e) {
				if (!e || !e.name) return;
				if (/^(ttyUSB|ttyACM|ttyAMA|ttyS)/.test(e.name)) {
					serials.push('/dev/' + e.name);
				}
			});
			serials.sort();
			return {
				service: res[1] && res[1]['at-webserver'] ? res[1]['at-webserver'] : {},
				serials: serials
			};
		});
	},

	render: function (data) {
		var self = this;
		var page = Ui.page('服务配置', 'AT 服务与通知设置（保存后自动重载）');
		var body = page._body;

		var state = data || {};
		var svc = state.service || {};
		// rpcd service.list 结构：{at-webserver:{instances:{instance1:{running:...}}}}
		var inst = (svc.instances && (svc.instances.instance1 || svc.instances.at-webserver)) || svc.instance || {};
		var serviceRunning = !!(inst.running || inst.pid);

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
		[{ v: 'SERIAL', l: 'PCUI 串口（默认，优先 /dev/ttyUSB1）' }, { v: 'NETWORK', l: '网络连接（TCP，备用）' }].forEach(function (o) {
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

		/* 串口：下拉 + 自定义；选项来自系统 /dev 识别结果 */
		var serialSel = document.createElement('select');
		serialSel.className = 'cbi-input-select';
		function fillSerialOptions(current) {
			while (serialSel.firstChild) serialSel.removeChild(serialSel.firstChild);
			function add(v, label) {
				var o = document.createElement('option');
				o.value = v; o.textContent = label || v;
				serialSel.appendChild(o);
			}
			add('auto', '自动探测（优先 /dev/ttyUSB1 PCUI）');
			(state.serials || []).forEach(function (p) {
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
				if (!exists && current !== '__custom__') serialSel.value = current;
			}
		}
		var serialCustom = document.createElement('input');
		serialCustom.className = 'cbi-input-text';
		serialCustom.placeholder = '例如 /dev/ttyUSB2';
		serialCustom.style.display = 'none';
		serialSel.addEventListener('change', function () {
			serialCustom.style.display = serialSel.value === '__custom__' ? '' : 'none';
		});
		connPanel._body.appendChild(Ui.field('串口设备', serialSel, '列出系统已识别的 ttyUSB/ttyACM/ttyS 设备'));
		connPanel._body.appendChild(Ui.field('自定义串口路径', serialCustom, '仅在选择「自定义路径」时生效'));

		var baudInput = document.createElement('input');
		baudInput.type = 'number';
		baudInput.className = 'cbi-input-text';
		baudInput.placeholder = '115200';
		connPanel._body.appendChild(Ui.field('波特率', baudInput));
		body.appendChild(connPanel);

		/* ---------- RPC 服务 ---------- */
		var wsPanel = Ui.panel('RPC 服务', 'LuCI 经 rpcd/ucode 代理连接后端使用的端口与密钥（仅回环监听，不对外暴露）');
		var wsHostInput = document.createElement('input');
		wsHostInput.className = 'cbi-input-text';
		wsHostInput.placeholder = '留空表示本机';
		wsPanel._body.appendChild(Ui.field('监听地址', wsHostInput, '保留兼容：RPC 固定监听 127.0.0.1，该键不再生效'));

		var wsPortInput = document.createElement('input');
		wsPortInput.type = 'number';
		wsPortInput.className = 'cbi-input-text';
		wsPortInput.min = 1;
		wsPortInput.max = 65535;
		wsPanel._body.appendChild(Ui.field('RPC 端口', wsPortInput, '默认 8765'));

		var authKeyInput = document.createElement('input');
		authKeyInput.className = 'cbi-input-text';
		authKeyInput.placeholder = '留空表示无需认证';
		wsPanel._body.appendChild(Ui.field('认证密钥', authKeyInput, 'ucode 代理自动附带该密钥；LuCI 登录态由 rpcd 会话保证'));
		body.appendChild(wsPanel);

		/* ---------- 定时锁频 ---------- */
		var schedPanel = Ui.panel('定时锁频', '总开关与默认参数');
		var schedChk = document.createElement('input');
		schedChk.type = 'checkbox';
		schedChk.className = 'cbi-input-checkbox';
		schedPanel._body.appendChild(Ui.field('启用定时锁频', schedChk, '在「服务 → 模组管理 → 定时锁频」编排时段'));
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

		/* ---------- 载入 UCI（单 section `config` + 扁平键，与 Rust/ucode 一致） ---------- */
		var get = function (key, def) {
			var v = L.uci.get('at-webserver', 'config', key);
			return v == null || v === '' ? def : v;
		};
		connTypeSel.value = String(get('connection_type', 'SERIAL'));
		hostInput.value = String(get('network_host', '192.168.8.1'));
		netPortInput.value = String(get('network_port', '20249'));
		fillSerialOptions(String(get('serial_port', 'auto')));
		baudInput.value = String(get('serial_baudrate', '115200'));
		wsHostInput.value = '';
		wsPortInput.value = String(get('websocket_port', '8765'));
		authKeyInput.value = String(get('websocket_auth_key', ''));
		schedChk.checked = get('schedule_enabled', '0') === '1';
		notifyCallsChk.checked = get('notify_call', '1') === '1';
		notifySmsChk.checked = get('notify_sms', '1') === '1';
		notifySignalChk.checked = get('notify_signal', '1') === '1';
		notifyMemChk.checked = get('notify_memory_full', '1') === '1';
		webhookInput.value = String(get('wechat_webhook', ''));

		/* ---------- 保存 ---------- */
		var saveBtn = Ui.primaryButton('保存配置', function () {
			var set = function (key, value) {
				L.uci.set('at-webserver', 'config', key, value);
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
			set('websocket_port', String(parseInt(wsPortInput.value, 10) || 8765));
			set('websocket_auth_key', authKeyInput.value.trim());
			set('schedule_enabled', schedChk.checked ? '1' : '0');
			set('notify_call', notifyCallsChk.checked ? '1' : '0');
			set('notify_sms', notifySmsChk.checked ? '1' : '0');
			set('notify_signal', notifySignalChk.checked ? '1' : '0');
			set('notify_memory_full', notifyMemChk.checked ? '1' : '0');
			set('wechat_webhook', webhookInput.value.trim());

			L.uci.save('at-webserver').then(function () {
				return L.uci.apply(false).then(function () {
					Ui.success('配置已保存');
					return reloadService();
				}, function (err) {
					// ubus 5 = NO_DATA：无待应用变更时 rpcd 不回数据，视为成功
					var code = err && err.code;
					var msg = (err && err.message) || '';
					if (code === 5 || /未收到数据|No data/i.test(msg)) {
						Ui.success('配置已保存');
						return reloadService();
					}
					throw err;
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
			Ui.confirm('确定重启 AT 服务？现有 RPC 调用将短暂中断。', function () {
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
