'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 短信设置 - 新 UI (含 USSD)
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('短信设置', '短信中心与 USSD 配置');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var smsCard = Mt5700.card('短信设置', '短信相关配置');
		var smsBody = E('div');
		smsCard._body.appendChild(smsBody);
		body.appendChild(smsCard);

		smsBody.appendChild(Mt5700.formGroup('短信中心号码', Mt5700.input('text', '如 +8613800571500')));
		smsBody.appendChild(Mt5700.formGroup('存储位置', Mt5700.select([
			{ label: 'SIM 卡', value: 'SM' },
			{ label: '模组内存', value: 'ME' }
		])));

		var actions = Mt5700.panelActions(
			Mt5700.primaryButton('保存', function () { saveSmsConfig(); })
		);
		smsBody.appendChild(actions);

		var ussdCard = Mt5700.card('USSD', '查询余额等 USSD 服务');
		var ussdBody = E('div');
		ussdCard._body.appendChild(ussdBody);
		body.appendChild(ussdCard);

		ussdBody.appendChild(Mt5700.formGroup('USSD 代码', Mt5700.input('text', '如 *100#', '')));
		ussdBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('发送', function () { sendUssd(); }),
			Mt5700.ghostButton('取消', function () { cancelUssd(); })
		));

		var result = E('div', { 'class': 'mt5700-mt-md' });
		ussdBody.appendChild(result);

		function saveSmsConfig() {
			Mt5700.success('保存成功');
		}

		function sendUssd() {
			var input = ussdBody.querySelector('input');
			var code = input.value.trim();
			if (!code) {
				Mt5700.warning('请输入 USSD 代码');
				return;
			}
			result.innerHTML = '';
			result.appendChild(Mt5700.loading('发送中...'));
			var cmd = Parse.buildUssdCommand(code);
			if (cmd.error) {
				Mt5700.error(cmd.error);
				return;
			}
			AtWs.client.sendCommand(cmd.command).then(function (res) {
				result.innerHTML = '';
				if (res.success && res.data) {
					var parsed = Parse.parseUssd(String(res.data));
					if (parsed) {
						result.appendChild(E('div', { 'class': 'mt5700-card' }, parsed.text));
					}
				} else {
					result.appendChild(Mt5700.errorState('USSD 请求失败'));
				}
			});
		}

		function cancelUssd() {
			AtWs.client.sendCommand(Parse.USSD_CANCEL_COMMAND);
			Mt5700.info('已取消 USSD 会话');
		}

		AtWs.client.connect();

		return page;
	}
});
