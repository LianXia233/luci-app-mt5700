'use strict';
/* require at-webserver/rpc */
/* require at-webserver/parse */
/* require at-webserver/mt5700 */
/* global L, AtWs, Parse, Mt5700 */

/**
 * AT 调试终端 - 新 UI
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('AT 调试终端', 'AT 命令调试');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var terminal = E('div', { 'class': 'mt5700-terminal' });
		body.appendChild(terminal);

		var header = E('div', { 'class': 'mt5700-terminal-header' });
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-red' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-yellow' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-green' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-title' }, 'AT Terminal - MT5700M'));
		terminal.appendChild(header);

		var output = E('div', { 'class': 'mt5700-terminal-body' });
		terminal.appendChild(output);

		var inputRow = E('div', { 'class': 'mt5700-terminal-input' });
		var input = E('input', { 'class': 'mt5700-input', type: 'text', placeholder: '输入 AT 命令，如 ATI' });
		var sendBtn = Mt5700.primaryButton('发送', function () { sendCommand(); });
		inputRow.appendChild(input);
		inputRow.appendChild(sendBtn);
		terminal.appendChild(inputRow);

		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') sendCommand();
		});

		var history = [];
		var historyIdx = -1;

		function sendCommand() {
			var cmd = input.value.trim();
			if (!cmd) return;
			
			history.push(cmd);
			historyIdx = -1;
			
			addLine('mt5700-terminal-prompt', '> ' + cmd);
			input.value = '';
			
			AtWs.client.sendCommand(cmd).then(function (res) {
				if (res.success) {
					addLine('', String(res.data || 'OK'));
				} else {
					addLine('mt5700-terminal-error', 'ERROR: ' + (res.error || '命令执行失败'));
				}
			});
		}

		function addLine(cls, text) {
			var line = E('div', { 'class': 'mt5700-terminal-line ' + cls }, text);
			output.appendChild(line);
			output.scrollTop = output.scrollHeight;
		}

		// 命令历史
		input.addEventListener('keydown', function (e) {
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (history.length > 0) {
					historyIdx = Math.max(0, historyIdx + 1);
					input.value = history[history.length - historyIdx] || '';
				}
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				historyIdx = Math.max(-1, historyIdx - 1);
				input.value = historyIdx >= 0 ? (history[history.length - historyIdx] || '') : '';
			}
		});

		// 常用命令快捷按钮
		var quickCard = Mt5700.card('常用命令', '快速发送常用 AT 命令');
		var quickBody = E('div', { 'class': 'mt5700-flex-wrap' });
		quickCard._body.appendChild(quickBody);
		body.appendChild(quickCard);

		var quickCmds = [
			{ label: 'ATI', cmd: 'ATI' },
			{ label: 'AT+CGMM', cmd: 'AT+CGMM' },
			{ label: 'AT+CIMI', cmd: 'AT+CIMI' },
			{ label: 'AT+CGSN', cmd: 'AT+CGSN' },
			{ label: 'AT+COPS?', cmd: 'AT+COPS?' },
			{ label: 'AT+CSQ', cmd: 'AT+CSQ' },
			{ label: 'AT^HCSQ?', cmd: 'AT^HCSQ?' },
			{ label: 'AT^MONSC', cmd: 'AT^MONSC' }
		];

		quickCmds.forEach(function (q) {
			var btn = Mt5700.ghostButton(q.label, function () {
				input.value = q.cmd;
				sendCommand();
			});
			quickBody.appendChild(btn);
		});

		AtWs.client.connect();

		return page;
	}
});
