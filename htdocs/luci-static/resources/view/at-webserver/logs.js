'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 通知日志 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('通知日志', '系统日志与事件');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var logCard = Mt5700.card('系统日志', '最近的事件记录');
		var logBody = E('div', { 'class': 'mt5700-terminal' });
		logCard._body.appendChild(logBody);
		body.appendChild(logCard);

		var output = E('div', { 'class': 'mt5700-terminal-body', style: 'max-height: 500px;' });
		logBody.appendChild(output);

		var actions = Mt5700.panelActions(
			Mt5700.primaryButton('刷新', function () { loadLogs(); }),
			Mt5700.dangerButton('清空', function () { clearLogs(); })
		);
		logBody.appendChild(actions);

		function loadLogs() {
			output.innerHTML = '';
			output.appendChild(Mt5700.loading('加载中...'));
			AtWs.client.sendCommand('logread -e at-webserver -n 50').then(function (res) {
				output.innerHTML = '';
				if (res.success && res.data) {
					var lines = String(res.data).split('\n').filter(function (l) { return l.trim(); });
					if (!lines.length) {
						output.appendChild(Mt5700.empty('暂无日志'));
						return;
					}
					lines.forEach(function (line) {
						var lineEl = E('div', { 'class': 'mt5700-terminal-line' }, line);
						output.appendChild(lineEl);
					});
				} else {
					output.appendChild(Mt5700.errorState('加载日志失败'));
				}
			});
		}

		function clearLogs() {
			output.innerHTML = '';
			output.appendChild(Mt5700.empty('日志已清空'));
		}

		AtWs.client.connect().then(function () { loadLogs(); });

		return page;
	}
});
