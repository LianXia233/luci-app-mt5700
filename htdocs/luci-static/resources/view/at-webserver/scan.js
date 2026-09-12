'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 全网扫频 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('全网扫频', '扫描周围网络信号');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var controlCard = Mt5700.card('扫频控制', '选择参数后开始扫描');
		var controlBody = E('div');
		controlCard._body.appendChild(controlBody);
		body.appendChild(controlCard);

		controlBody.appendChild(Mt5700.formGroup('接入技术', Mt5700.select([
			{ label: 'GSM', value: '0' },
			{ label: 'WCDMA', value: '1' },
			{ label: 'LTE', value: '2' },
			{ label: 'NR (5G)', value: '3' }
		])));

		var actions = Mt5700.panelActions(
			Mt5700.primaryButton('开始扫描', function () { startScan(); }),
			Mt5700.dangerButton('停止', function () { stopScan(); })
		);
		controlBody.appendChild(actions);

		var resultCard = Mt5700.card('扫描结果', '附近网络信息');
		var resultBody = E('div');
		resultCard._body.appendChild(resultBody);
		body.appendChild(resultCard);

		resultBody.appendChild(Mt5700.empty('点击开始扫描'));

		function startScan() {
			resultBody.innerHTML = '';
			resultBody.appendChild(Mt5700.loading('扫描中...'));
			AtWs.client.sendCommand('AT^CELLSCAN').then(function (res) {
				if (res.success) {
					parseResults(res.data);
				} else {
					resultBody.innerHTML = '';
					resultBody.appendChild(Mt5700.errorState('扫描失败', function () { startScan(); }));
				}
			});
		}

		function stopScan() {
			AtWs.client.sendCommand('AT^CELLSCAN=ABORT');
			Mt5700.info('已停止扫描');
		}

		function parseResults(data) {
			var lines = String(data).split('\n').filter(function (l) { return l.trim(); });
			var results = [];
			lines.forEach(function (line) {
				var parsed = Parse.parseScanLine(line);
				if (parsed) results.push(parsed);
			});

			resultBody.innerHTML = '';
			if (!results.length) {
				resultBody.appendChild(Mt5700.empty('未发现网络'));
				return;
			}

			var headers = ['制式', 'PLMN', '频点', 'PCI', 'RSRP', 'RSRQ', 'SINR'];
			var rows = results.map(function (r) {
				return [
					r.ratName || '—',
					r.plmn || '—',
					r.freq != null ? String(r.freq) : '—',
					r.pci != null ? String(r.pci) : '—',
					r.rsrp != null ? r.rsrp + ' dBm' : '—',
					r.rsrq != null ? r.rsrq + ' dB' : '—',
					r.sinr != null ? r.sinr + ' dB' : '—'
				];
			});
			resultBody.appendChild(Mt5700.table(headers, rows, { striped: true }));
		}

		AtWs.client.connect();

		return page;
	}
});
