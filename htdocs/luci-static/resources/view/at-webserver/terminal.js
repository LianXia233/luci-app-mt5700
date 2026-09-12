'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * AT 调试终端 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI at/Terminal.tsx，并保留 v1.4.x 终端外观：
 * - 命令输入 + 回车发送、发送 / 清空 / 保存命令
 * - 终端式输出（成功 / 失败着色，自动滚动到底部）
 * - 常用命令快捷按钮：点击后先二次确认再发送（避免误触，尤其是写命令）
 * - 已保存命令（localStorage savedAtCommands），支持删除
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('AT 调试终端', '直接向模组发送 AT 指令');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var entries = [];
		var saved = [];

		try {
			var raw = localStorage.getItem('savedAtCommands');
			if (raw) saved = JSON.parse(raw);
		} catch (e) { /* ignore */ }

		/* ---------- 终端主体 ---------- */
		var termCard = Mt5700.card('AT 调试终端', '输入指令后按回车或点击发送；清空仅清除本页日志，不影响模组');
		var termBody = E('div');
		termCard._body.appendChild(termBody);
		body.appendChild(termCard);

		var terminal = E('div', { 'class': 'mt5700-terminal' });
		termBody.appendChild(terminal);

		var header = E('div', { 'class': 'mt5700-terminal-header' });
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-red' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-yellow' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-dot mt5700-terminal-dot-green' }));
		header.appendChild(E('span', { 'class': 'mt5700-terminal-title' }, 'AT Terminal - MT5700M'));
		terminal.appendChild(header);

		var consoleEl = E('div', { 'class': 'mt5700-terminal-body' });
		terminal.appendChild(consoleEl);

		var inputRow = E('div', { 'class': 'mt5700-terminal-input mt5700-inline' });
		var cmdInput = Mt5700.input('text', '输入 AT 指令，回车发送');
		cmdInput.style.flex = '1 1 240px';
		var sendBtn = Mt5700.primaryButton('发送', function () { send(); });
		var clearBtn = Mt5700.ghostButton('清空', function () {
			entries = [];
			renderConsole();
		});
		var saveBtn = Mt5700.ghostButton('保存命令', saveCurrent);

		inputRow.appendChild(cmdInput);
		inputRow.appendChild(sendBtn);
		inputRow.appendChild(clearBtn);
		inputRow.appendChild(saveBtn);
		terminal.appendChild(inputRow);

		cmdInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') send();
		});

		/* ---------- 常用命令 ---------- */
		var commonCard = Mt5700.card('常用命令', '点击后需二次确认才会真正下发到模组');
		var commonWrap = E('div', { 'class': 'mt5700-inline' });
		commonCard._body.appendChild(commonWrap);
		body.appendChild(commonCard);

		var COMMON = [
			{ label: '查询信号强度', command: 'AT^HCSQ?' },
			{ label: '查询版本', command: 'ATI' },
			{ label: '查询 SIM 状态', command: 'AT+CPIN?' },
			{ label: '查询网络注册', command: 'AT+CREG?' },
			{ label: '查询基站信息', command: 'AT+CGREG?' },
			{ label: '查询网络时间', command: 'AT^NWTIME?' },
			/* 以下条目与 IMEI 相关，完全沿用基准实现，未做任何改动 */
			{ label: '查询 IMEI', command: 'AT+CGSN' }
		];

		COMMON.forEach(function (item) {
			commonWrap.appendChild(Mt5700.button(item.label, function () {
				confirmAndSend(item.command, item.label);
			}, 'secondary'));
		});

		/* ---------- 已保存命令 ---------- */
		var savedCard = Mt5700.card('已保存的命令', '来自本机浏览器 localStorage');
		var savedWrap = E('div', { 'class': 'mt5700-inline' });
		savedCard._body.appendChild(savedWrap);
		body.appendChild(savedCard);

		function renderSaved() {
			savedWrap.innerHTML = '';
			if (!saved.length) {
				savedWrap.appendChild(Mt5700.empty('暂无已保存命令'));
				return;
			}
			saved.forEach(function (item) {
				var btn = Mt5700.button(item.remark || item.command, function () {
					confirmAndSend(item.command, item.remark || item.command);
				}, 'secondary');
				var wrap = E('span', { 'class': 'mt5700-inline' });
				wrap.appendChild(btn);
				wrap.appendChild(Mt5700.dangerButton('删除', function () {
					saved = saved.filter(function (c) { return c.command !== item.command; });
					persistSaved();
					renderSaved();
				}));
				savedWrap.appendChild(wrap);
			});
		}

		function persistSaved() {
			try {
				localStorage.setItem('savedAtCommands', JSON.stringify(saved));
			} catch (e) { /* ignore */ }
		}

		/* ---------- 输出渲染 ---------- */
		function renderConsole() {
			consoleEl.innerHTML = '';
			if (!entries.length) {
				consoleEl.appendChild(E('div', { 'class': 'mt5700-terminal-line' },
					'暂无输出，输入 AT 指令开始调试'));
				return;
			}
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				var head = E('div', { 'class': 'mt5700-terminal-line mt5700-terminal-prompt' });
				head.appendChild(E('span', {}, '› ' + e.cmd + '  '));
				head.appendChild(E('span', { 'class': 'mt5700-log-cmd' }, e.at));
				consoleEl.appendChild(head);
				consoleEl.appendChild(E('div', {
					'class': 'mt5700-terminal-line ' + (e.ok ? 'mt5700-log-ok' : 'mt5700-log-err')
				}, e.body));
			}
			consoleEl.scrollTop = consoleEl.scrollHeight;
		}

		/* ---------- 发送 ---------- */
		var sending = false;

		function send(cmd) {
			var command = (cmd != null ? cmd : cmdInput.value).trim();
			if (!command) { Mt5700.warning('请输入 AT 指令'); return; }
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
				Mt5700.error('发送失败');
			}).then(function () {
				sending = false;
				sendBtn.disabled = false;
			});
		}

		/* 常用命令 / 已保存命令：点击后二次确认再下发 */
		function confirmAndSend(command, label) {
			Mt5700.confirm('确认向模组发送该指令？\n\n' + label + '（' + command + '）', function () {
				send(command);
			}, '确认发送');
		}

		function saveCurrent() {
			var cmd = (cmdInput.value || '').trim();
			if (!cmd) { Mt5700.warning('请输入要保存的指令'); return; }
			Ui.promptModal('保存 AT 命令', [
				{ key: 'cmd', label: '命令', value: cmd },
				{ key: 'remark', label: '备注' }
			], function (values) {
				var remark = (values.remark || '').trim();
				if (!remark) { Mt5700.warning('请输入备注'); return; }
				if (saved.some(function (c) { return c.command === values.cmd; })) {
					Mt5700.warning('该命令已存在');
					return;
				}
				saved.push({ command: values.cmd, remark: remark });
				persistSaved();
				Mt5700.success('已保存');
				renderSaved();
			});
		}

		/* ---------- 初始化 ---------- */
		renderSaved();
		renderConsole();

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						AtWs.client.connect(values.key).catch(function (e) {
							Mt5700.error((e && e.message) || '认证失败');
						});
					}
				});
				return;
			}
			if (err) console.warn(err);
		});

		return page;
	}
});
