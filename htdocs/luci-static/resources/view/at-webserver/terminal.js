'use strict';
'require at-webserver/ws';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Parse, Ui */

/**
 * AT 调试终端（原 WebUI AT → AT 调试终端）
 * 等价迁移 at/Terminal.tsx：
 * - 命令输入 + 回车发送、发送/清空/保存命令
 * - 终端式输出（成功/失败着色，自动滚动到底部）
 * - 常用命令快捷按钮、已保存命令（localStorage savedAtCommands）
 */

return L.view.extend({
	render: function () {
		var page = Ui.page('AT 调试终端', '直接向模组发送指令');
		var body = page._body;
		Ui.renderConnectionBar(body);

		var entries = [];
		var saved = [];

		// 加载已保存命令
		try {
			var raw = localStorage.getItem('savedAtCommands');
			if (raw) saved = JSON.parse(raw);
		} catch (e) { /* ignore */ }

		var panel = Ui.panel('AT 调试终端', '输入指令后按回车或点击发送；清空仅清除本页日志，不影响模组');
		body.appendChild(panel);

		var consoleEl = E('div', { 'class': 'at-console' });
		consoleEl.appendChild(E('div', { 'class': 'at-empty' }, '暂无输出，输入 AT 指令开始调试'));
		panel._body.appendChild(consoleEl);

		var inputRow = E('div', { 'class': 'at-terminal-input' });
		var cmdInput = document.createElement('input');
		cmdInput.className = 'cbi-input-text';
		cmdInput.placeholder = '输入 AT 指令，回车发送';
		cmdInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') send();
		});
		var sendBtn = Ui.primaryButton('发送', send);
		var clearBtn = Ui.button('清空', 'cbi-button-action', function () {
			entries = [];
			renderConsole();
		});
		var saveBtn = Ui.button('保存命令', 'cbi-button-action', function () {
			var cmd = cmdInput.value.trim();
			if (!cmd) { Ui.warning('请输入要保存的指令'); return; }
			Ui.promptModal('保存 AT 命令', [
				{ key: 'cmd', label: '命令', value: cmd },
				{ key: 'remark', label: '备注' }
			], function (values) {
				var remark = (values.remark || '').trim();
				if (!remark) { Ui.warning('请输入备注'); return; }
				if (saved.some(function (c) { return c.command === values.cmd; })) { Ui.warning('该命令已存在'); return; }
				saved.push({ command: values.cmd, remark: remark });
				localStorage.setItem('savedAtCommands', JSON.stringify(saved));
				Ui.success('已保存');
				renderSaved();
			});
		});
		inputRow.appendChild(cmdInput);
		inputRow.appendChild(sendBtn);
		inputRow.appendChild(clearBtn);
		inputRow.appendChild(saveBtn);
		panel._body.appendChild(inputRow);

		/* 常用命令 */
		var COMMON = [
			{ label: '查询信号强度', command: 'AT^HCSQ?' },
			{ label: '查询 IMEI', command: 'AT+CGSN' },
			{ label: '查询版本', command: 'ATI' },
			{ label: '查询 SIM 状态', command: 'AT+CPIN?' },
			{ label: '查询网络注册', command: 'AT+CREG?' },
			{ label: '查询基站信息', command: 'AT+CGREG?' },
			{ label: '查询网络时间', command: 'AT^NWTIME?' }
		];
		var commonPanel = Ui.panel('常用命令', '');
		var commonWrap = E('div', { 'class': 'at-chips' });
		COMMON.forEach(function (item) {
			var btn = Ui.button(item.label, 'cbi-button-action', function () {
				cmdInput.value = item.command;
			});
			commonWrap.appendChild(btn);
		});
		commonPanel._body.appendChild(commonWrap);
		body.appendChild(commonPanel);

		/* 已保存命令 */
		var savedPanel = Ui.panel('已保存的命令', '');
		var savedWrap = E('div', { 'class': 'at-chips' });
		savedPanel._body.appendChild(savedWrap);
		body.appendChild(savedPanel);

		function renderSaved() {
			savedWrap.innerHTML = '';
			if (!saved.length) {
				savedWrap.appendChild(E('div', { 'class': 'at-empty' }, '暂无已保存命令'));
				return;
			}
			saved.forEach(function (item, index) {
				var btn = Ui.button(item.remark, 'cbi-button-action', function () {
					cmdInput.value = item.command;
				});
				var del = E('span', { 'class': 'at-chip-del', 'title': '删除' }, '×');
				del.addEventListener('click', function () {
					saved.splice(index, 1);
					localStorage.setItem('savedAtCommands', JSON.stringify(saved));
					renderSaved();
				});
				var wrap = E('span', { 'class': 'at-chip' });
				wrap.appendChild(btn);
				wrap.appendChild(del);
				savedWrap.appendChild(wrap);
			});
		}

		function renderConsole() {
			consoleEl.innerHTML = '';
			if (!entries.length) {
				consoleEl.appendChild(E('div', { 'class': 'at-empty' }, '暂无输出，输入 AT 指令开始调试'));
				return;
			}
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				var block = E('div', { 'class': 'at-console-entry' });
				var head = E('div', { 'class': 'at-console-cmd' });
				head.appendChild(E('span', { 'class': 'at-console-prompt' }, '›'));
				head.appendChild(E('b', {}, e.cmd));
				head.appendChild(E('time', {}, e.at));
				block.appendChild(head);
				var pre = E('pre', { 'class': e.ok ? 'at-console-res' : 'at-console-res at-console-res--err' }, e.body);
				block.appendChild(pre);
				consoleEl.appendChild(block);
			}
			consoleEl.scrollTop = consoleEl.scrollHeight;
		}

		var sending = false;
		function send(cmd) {
			var command = (cmd != null ? cmd : cmdInput.value).trim();
			if (!command) { Ui.warning('请输入 AT 指令'); return; }
			if (sending) return;
			sending = true;
			sendBtn.disabled = true;
			AtWs.client.sendCommand(command).then(function (res) {
				entries.push({
					cmd: command,
					body: res.success ? String(res.data || '(无输出)') : String(res.error || '未知错误'),
					ok: !!res.success,
					at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
				});
				cmdInput.value = '';
				renderConsole();
			}).catch(function () {
				Ui.error('发送失败');
			}).finally(function () {
				sending = false;
				sendBtn.disabled = false;
			});
		}

		renderSaved();
		renderConsole();

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) AtWs.client.connect(values.key).catch(function (e) { Ui.error((e && e.message) || '认证失败'); });
				});
				return;
			}
			if (err) console.warn(err);
		});

		return page;
	}
});
