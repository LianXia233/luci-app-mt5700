'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 模组设置 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('模组设置', '模组相关配置');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var simCard = Mt5700.card('SIM 卡状态', 'SIM 卡信息');
		var simBody = E('div');
		simCard._body.appendChild(simBody);
		body.appendChild(simCard);

		var configCard = Mt5700.card('模组配置', '飞行模式、省电等');
		var configBody = E('div');
		configCard._body.appendChild(configBody);
		body.appendChild(configCard);

		configBody.appendChild(Mt5700.formGroup('飞行模式', E('div', { 'class': 'mt5700-switch' }, E('input', { type: 'checkbox' }))));
		configBody.appendChild(Mt5700.formGroup('自动拨号', E('div', { 'class': 'mt5700-switch' }, E('input', { type: 'checkbox', checked: true }))));

		var actions = Mt5700.panelActions(
			Mt5700.primaryButton('保存', function () { saveConfig(); }),
			Mt5700.dangerButton('重启模组', function () { rebootModem(); })
		);
		configBody.appendChild(actions);

		function loadSimStatus() {
			return AtWs.client.sendCommand('AT^SIMSQ?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseSimsq(res.data);
					simBody.innerHTML = '';
					if (parsed) {
						simBody.appendChild(Mt5700.metric('状态', parsed.label, parsed.dead ? 'danger' : (parsed.present ? 'success' : 'warning')));
					}
				}
			});
		}

		function saveConfig() {
			Mt5700.success('保存成功');
		}

		function rebootModem() {
			Mt5700.confirm('确定要重启模组吗？重启期间网络会短暂中断。', function () {
				AtWs.client.sendCommand('AT+CFUN=1,1').then(function (res) {
					if (res.success) Mt5700.success('重启命令已发送');
					else Mt5700.error('重启失败');
				});
			});
		}

		AtWs.client.connect().then(function () { loadSimStatus(); });

		return page;
	}
});
