'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 模组升级 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('模组升级', '固件升级与版本信息');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var infoCard = Mt5700.card('当前版本', '模组固件信息');
		var infoBody = E('div');
		infoCard._body.appendChild(infoBody);
		body.appendChild(infoCard);

		infoBody.appendChild(Mt5700.loading('加载中...'));

		var upgradeCard = Mt5700.card('固件升级', '上传固件文件进行升级');
		var upgradeBody = E('div');
		upgradeCard._body.appendChild(upgradeBody);
		body.appendChild(upgradeCard);

		upgradeBody.appendChild(Mt5700.formGroup('固件文件', E('input', { type: 'file' }), '选择要升级的固件文件'));
		upgradeBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('开始升级', function () { startUpgrade(); })
		));

		function loadVersion() {
			return AtWs.client.sendCommand('ATI').then(function (res) {
				infoBody.innerHTML = '';
				if (res.success && res.data) {
					var lines = String(res.data).split('\n').filter(function (l) { return l.trim() && l !== 'OK'; });
					var headers = ['信息', ''];
					var rows = lines.map(function (l) { return [l, '']; });
					infoBody.appendChild(Mt5700.table(headers, rows));
				}
			});
		}

		function startUpgrade() {
			Mt5700.warning('升级功能需要后端支持');
		}

		AtWs.client.connect().then(function () { loadVersion(); });

		return page;
	}
});
