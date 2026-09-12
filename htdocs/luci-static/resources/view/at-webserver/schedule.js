'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 定时锁频 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('定时锁频', '按时间计划锁定频段');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var statusCard = Mt5700.card('当前状态', '锁频计划运行状态');
		var statusBody = E('div');
		statusCard._body.appendChild(statusBody);
		body.appendChild(statusCard);

		var configCard = Mt5700.card('锁频计划', '配置定时锁频规则');
		var configBody = E('div');
		configCard._body.appendChild(configBody);
		body.appendChild(configCard);

		configBody.appendChild(Mt5700.formGroup('启用', E('div', { 'class': 'mt5700-switch' }, E('input', { type: 'checkbox' }))));
		configBody.appendChild(Mt5700.formGroup('夜间锁频', Mt5700.select([
			{ label: '关闭', value: '0' },
			{ label: 'B1 2100MHz', value: '1' },
			{ label: 'B3 1800MHz', value: '3' }
		])));
		configBody.appendChild(Mt5700.formGroup('日间锁频', Mt5700.select([
			{ label: '关闭', value: '0' },
			{ label: 'B1 2100MHz', value: '1' },
			{ label: 'B3 1800MHz', value: '3' }
		])));

		var actions = Mt5700.panelActions(
			Mt5700.primaryButton('保存', function () { saveConfig(); })
		);
		configBody.appendChild(actions);

		function saveConfig() {
			Mt5700.success('保存成功');
		}

		AtWs.client.connect();

		return page;
	}
});
