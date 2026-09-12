'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 网络设置 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络设置', '网络模式与频段配置');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var formCard = Mt5700.card('网络设置', '配置网络模式与频段');
		var formBody = E('div');
		formCard._body.appendChild(formBody);
		body.appendChild(formCard);

		formBody.appendChild(Mt5700.loading('加载中...'));

		function loadConfig() {
			return AtWs.client.sendCommand('AT^SYSCFG?').then(function (res) {
				if (res.success && res.data) {
					renderForm(res.data);
				}
			});
		}

		function renderForm(data) {
			formBody.innerHTML = '';
			var modeGroup = Mt5700.formGroup('网络模式', Mt5700.select([
				{ label: '自动', value: 'auto' },
				{ label: '5G Only', value: '5g' },
				{ label: '4G Only', value: '4g' },
				{ label: '3G Only', value: '3g' },
				{ label: '2G Only', value: '2g' }
			]), '选择网络模式');
			formBody.appendChild(modeGroup);

			var bandGroup = Mt5700.formGroup('频段', Mt5700.input('text', '如 1,3,5'), '留空表示自动选择');
			formBody.appendChild(bandGroup);

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
