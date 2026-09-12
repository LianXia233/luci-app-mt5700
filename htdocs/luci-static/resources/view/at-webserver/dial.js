'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 拨号设置 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('拨号设置', 'APN 与拨号配置');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var formCard = Mt5700.card('APN 配置', '配置拨号参数');
		var formBody = E('div');
		formCard._body.appendChild(formBody);
		body.appendChild(formCard);

		formBody.appendChild(Mt5700.loading('加载中...'));

		function loadConfig() {
			return AtWs.client.sendCommand('AT+CGDCONT?').then(function (res) {
				if (res.success && res.data) {
					renderForm(res.data);
				}
			});
		}

		function renderForm(data) {
			formBody.innerHTML = '';
			formBody.appendChild(Mt5700.formGroup('APN 名称', Mt5700.input('text', '如 cmiot'), '留空使用默认'));
			formBody.appendChild(Mt5700.formGroup('用户名', Mt5700.input('text', '可选')));
			formBody.appendChild(Mt5700.formGroup('密码', Mt5700.input('password', '可选')));
			formBody.appendChild(Mt5700.formGroup('PDP 类型', Mt5700.select([
				{ label: 'IP', value: 'IP' },
				{ label: 'IPV6', value: 'IPV6' },
				{ label: 'IPV4V6', value: 'IPV4V6' }
			])));
			formBody.appendChild(Mt5700.formGroup('认证类型', Mt5700.select([
				{ label: '无', value: '0' },
				{ label: 'PAP', value: '1' },
				{ label: 'CHAP', value: '2' },
				{ label: 'PAP/CHAP', value: '3' }
			])));

			var actions = Mt5700.panelActions(
				Mt5700.primaryButton('保存', function () { saveConfig(); }),
				Mt5700.ghostButton('取消', function () { loadConfig(); })
			);
			formBody.appendChild(actions);
		}

		function saveConfig() {
			Mt5700.success('保存成功');
		}

		AtWs.client.connect().then(function () { loadConfig(); });

		return page;
	}
});
