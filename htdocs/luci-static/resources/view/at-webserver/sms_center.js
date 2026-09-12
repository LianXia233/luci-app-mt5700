'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * 短信中心 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('短信中心', '短信收发管理');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var layout = E('div', { 'class': 'mt5700-sms-layout' });
		body.appendChild(layout);

		var listCard = Mt5700.card('短信列表', '收件箱');
		var listBody = E('div', { 'class': 'mt5700-sms-list-body' });
		listCard._body.appendChild(listBody);
		layout.appendChild(listCard);

		var detailCard = Mt5700.card('短信详情', '选择一条短信查看详情');
		var detailBody = E('div', { 'class': 'mt5700-empty' });
		detailBody.appendChild(E('div', { 'class': 'mt5700-empty-text' }, '选择一条短信查看'));
		detailCard._body.appendChild(detailBody);
		layout.appendChild(detailCard);

		var inputCard = Mt5700.card('发送短信', '新短信');
		var inputBody = E('div');
		inputCard._body.appendChild(inputBody);
		body.appendChild(inputCard);

		inputBody.appendChild(Mt5700.formGroup('收件人', Mt5700.input('text', '手机号码')));
		inputBody.appendChild(Mt5700.formGroup('内容', E('textarea', { 'class': 'mt5700-input', rows: 4, placeholder: '短信内容' })));
		inputBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('发送', function () { sendSms(); })
		));

		var currentSms = null;

		function loadSms() {
			listBody.innerHTML = '';
			listBody.appendChild(Mt5700.loading('加载中...'));
			AtWs.client.sendCommand('AT+CMGL="REC UNREAD"').then(function (res) {
				if (res.success && res.data) {
					var sms = Parse.parseCMGL(res.data);
					renderList(sms);
				}
			});
		}

		function renderList(sms) {
			listBody.innerHTML = '';
			if (!sms.length) {
				listBody.appendChild(Mt5700.empty('暂无短信'));
				return;
			}
			sms.forEach(function (s) {
				var item = E('div', { 'class': 'mt5700-sms-item' });
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-number' }, s.number));
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, s.content));
				item.addEventListener('click', function () { showDetail(s); });
				listBody.appendChild(item);
			});
		}

		function showDetail(sms) {
			currentSms = sms;
			detailBody.innerHTML = '';
			var header = E('div', { 'class': 'mt5700-sms-detail-header' });
			header.appendChild(E('div', { 'class': 'mt5700-sms-item-number' }, sms.number));
			header.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, sms.time));
			detailBody.appendChild(header);
			var content = E('div', { 'class': 'mt5700-sms-detail-body' });
			var bubble = E('div', { 'class': 'mt5700-sms-bubble ' + (sms.type === 'sent' ? 'mt5700-sms-bubble-sent' : 'mt5700-sms-bubble-recv') }, sms.content);
			content.appendChild(bubble);
			detailBody.appendChild(content);
		}

		function sendSms() {
			Mt5700.success('短信发送功能需要后端支持');
		}

		AtWs.client.connect().then(function () { loadSms(); });

		return page;
	}
});
