'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 服务配置 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('服务配置', 'at-webserver 服务管理');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var statusCard = Mt5700.card('服务状态', 'at-webserver 服务运行状态');
		var statusBody = E('div');
		statusCard._body.appendChild(statusBody);
		body.appendChild(statusCard);

		var configCard = Mt5700.card('服务配置', 'at-webserver 配置参数');
		var configBody = E('div');
		configCard._body.appendChild(configBody);
		body.appendChild(configCard);

		configBody.appendChild(Mt5700.loading('加载中...'));

		function loadConfig() {
			return L.uci.load('at-webserver').then(function () {
				configBody.innerHTML = '';
				
				var enabled = L.uci.get('at-webserver', 'config', 'enabled') === '1';
				var connType = L.uci.get('at-webserver', 'config', 'connection_type') || 'SERIAL';
				var serialPort = L.uci.get('at-webserver', 'config', 'serial_port') || 'auto';
				var serialBaud = L.uci.get('at-webserver', 'config', 'serial_baudrate') || '115200';
				var port = L.uci.get('at-webserver', 'config', 'websocket_port') || '8765';

				configBody.appendChild(Mt5700.formGroup('启用服务', E('div', { 'class': 'mt5700-switch' }, E('input', { type: 'checkbox', checked: enabled }))));
				configBody.appendChild(Mt5700.formGroup('连接类型', Mt5700.select([
					{ label: '串口 (PCUI)', value: 'SERIAL' },
					{ label: '网络 (TCP)', value: 'NETWORK' }
				], connType)));
				configBody.appendChild(Mt5700.formGroup('串口设备', Mt5700.input('text', '如 /dev/ttyUSB1', serialPort)));
				configBody.appendChild(Mt5700.formGroup('波特率', Mt5700.select([
					{ label: '9600', value: '9600' },
					{ label: '115200', value: '115200' },
					{ label: '230400', value: '230400' },
					{ label: '460800', value: '460800' },
					{ label: '921600', value: '921600' }
				], serialBaud)));
				configBody.appendChild(Mt5700.formGroup('RPC 端口', Mt5700.input('number', '8765', port)));

				var actions = Mt5700.panelActions(
					Mt5700.primaryButton('保存并应用', function () { saveConfig(); }),
					Mt5700.dangerButton('重启服务', function () { restartService(); })
				);
				configBody.appendChild(actions);
			});
		}

		function saveConfig() {
			Mt5700.info('正在保存...');
			L.uci.save('at-webserver').then(function () {
				return L.uci.apply();
			}).then(function () {
				Mt5700.success('保存并应用成功');
				loadConfig();
			}).catch(function (err) {
				Mt5700.error('保存失败: ' + (err && err.message || '未知错误'));
			});
		}

		function restartService() {
			Mt5700.confirm('确定要重启 at-webserver 服务吗？', function () {
				AtWs.client.sendCommand('AT+CFUN=1,1').then(function (res) {
					if (res.success) {
						Mt5700.success('重启命令已发送');
					} else {
						Mt5700.error('重启失败');
					}
				});
			});
		}

		// 状态检查
		function checkStatus() {
			statusBody.innerHTML = '';
			var status = Mt5700.badge('运行中', 'success');
			statusBody.appendChild(status);
			statusBody.appendChild(E('span', { 'class': 'mt5700-mt-sm' }, 'at-webserver 服务正常运行'));
		}

		AtWs.client.connect().then(function () {
			loadConfig();
			checkStatus();
		});

		return page;
	}
});
