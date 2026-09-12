'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/smsEncode';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, SmsEncode, Mt5700 */

/**
 * 短信设置 - 新 UI 视觉 + 基准 v1.3.4 功能（含 USSD 查询）
 *
 * - IMS 开关（AT^IMSSWITCH? / AT^IMSSWITCH=1,0,0 等）
 * - 短信开关（开启步骤：CEUS=1/IMSSWITCH=1/CFUN=1/CGDCONT=5/CSCA；关闭步骤反向）
 * - 短信中心号码（AT+CSCA? / AT+CSCA="..."）
 * - 存储位置与用量（AT+CMGF=0 + AT+CPMS? / AT+CPMS=...）
 * - 清空全部短信（AT+CMGD=1,4 逐存储）
 * - 本地已发缓存导出/导入/清空
 * - USSD 查询（AT+CUSD，GSM7 打包，+CUSD URC 回复）
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('短信设置', '短信功能开关、中心号码、存储管理与 USSD 查询');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var state = {
			imsOn: false,
			smsOn: false,
			centerNumber: '',
			storage: { mem1: '', used1: 0, total1: 0, mem2: '', used2: 0, total2: 0, mem3: '', used3: 0, total3: 0 },
			cacheCount: 0
		};

		function mkCheck(onChange) {
			var wrap = E('div', { 'class': 'mt5700-switch' });
			var input = E('input', { type: 'checkbox' });
			if (onChange) input.addEventListener('change', function () { onChange(input.checked, input); });
			wrap.appendChild(input);
			return wrap;
		}

		/* ---------- IMS 与短信开关 ---------- */
		var smsCard = Mt5700.card('短信服务', 'IMS 与短信收发开关');
		var smsBody = E('div');
		smsCard._body.appendChild(smsBody);
		body.appendChild(smsCard);

		var imsSwitch = mkCheck(function (checked, input) {
			AtWs.client.sendCommand('AT^IMSSWITCH=' + (checked ? '1,0,0' : '0,0,0')).then(function (res) {
				if (res.success) {
					Mt5700.success((checked ? '开启' : '关闭') + ' IMS 成功');
				} else {
					Mt5700.error((checked ? '开启' : '关闭') + ' IMS 失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('IMS 设置失败'); });
		});
		var imsChk = imsSwitch.querySelector('input');
		smsBody.appendChild(Mt5700.formGroup('IMS 短信', imsSwitch, '开启后可收发短信'));

		var smsOnSwitch = mkCheck(function (checked) { toggleSMS(checked); });
		var smsOnChk = smsOnSwitch.querySelector('input');
		smsBody.appendChild(Mt5700.formGroup('短信功能', smsOnSwitch, '开启时按顺序下发 CEUS/IMSSWITCH/CFUN/CGDCONT/CSCA 配置'));

		/* ---------- 短信中心号码 ---------- */
		var centerCard = Mt5700.card('短信中心号码', '用于发送短信的 SMSC');
		var centerBody = E('div');
		centerCard._body.appendChild(centerBody);
		body.appendChild(centerCard);

		var centerInput = Mt5700.input('text', '+8613800755500', '');
		centerInput.addEventListener('input', function () { state.centerNumber = centerInput.value; });
		centerBody.appendChild(Mt5700.formGroup('中心号码', centerInput));
		centerBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('保存中心号码', function () {
				var num = centerInput.value.trim();
				if (!num) { Mt5700.error('请输入短信中心号码'); return; }
				AtWs.client.sendCommand('AT+CSCA="' + num + '"').then(function (res) {
					if (res.success) Mt5700.success('短信中心号码已保存');
					else Mt5700.error('保存失败');
				}).catch(function () { Mt5700.error('保存失败'); });
			})
		));

		/* ---------- 存储管理 ---------- */
		var storeCard = Mt5700.card('存储管理', 'SIM 卡短信存储');
		var storeBody = E('div');
		storeCard._body.appendChild(storeBody);
		body.appendChild(storeCard);

		var storageEl = E('div', { 'class': 'mt5700-hint' }, '存储用量：—');
		storeBody.appendChild(storageEl);

		var locSel = Mt5700.select([
			{ label: 'SIM 卡', value: 'SM' },
			{ label: '模组内存', value: 'ME' },
			{ label: '自动（SIM 优先）', value: 'MT' }
		], 'SM');
		storeBody.appendChild(Mt5700.formGroup('存储位置', locSel));

		storeBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('保存存储位置', function () {
				var loc = locSel.value;
				AtWs.client.sendCommand('AT+CPMS="' + loc + '","' + loc + '","' + loc + '"').then(function (res) {
					if (res.success) { Mt5700.success('存储位置已保存'); loadStorage(); }
					else { Mt5700.error('保存失败'); }
				}).catch(function () { Mt5700.error('保存失败'); });
			}),
			Mt5700.dangerButton('清空全部短信', function () {
				Mt5700.confirm('确定清空全部短信？此操作不可恢复。', function () {
					AtWs.client.sendCommand('AT+CPMS?').then(function (res) {
						var storages = [];
						if (res.success && res.data) {
							var m = String(res.data).match(/(?:,"(\w+)",\d+,\d+)/g) || [];
							for (var i = 0; i < m.length; i++) {
								var s = m[i].match(/"(\w+)"/);
								if (s) storages.push(s[1]);
							}
						}
						if (!storages.length) storages = ['SM', 'ME', 'MT'];
						var unique = storages.filter(function (v, i, a) { return a.indexOf(v) === i; });
						var chain = Promise.resolve();
						unique.forEach(function (st) {
							chain = chain.then(function () { return AtWs.client.sendCommand('AT+CMGF=0'); })
								.then(function () { return AtWs.client.sendCommand('AT+CPMS="' + st + '","' + st + '","' + st + '"'); })
								.then(function () { return AtWs.client.sendCommand('AT+CMGD=1,4'); });
						});
						return chain;
					}).then(function () {
						Mt5700.success('已清空全部短信');
						loadStorage();
					}).catch(function () { Mt5700.error('清空短信失败'); });
				});
			})
		));

		/* ---------- 本地已发缓存 ---------- */
		var cacheCard = Mt5700.card('本地已发缓存', '发送记录保存在浏览器本地，可导出/导入/清空');
		var cacheBody = E('div');
		cacheCard._body.appendChild(cacheBody);
		body.appendChild(cacheCard);

		var cacheEl = E('div', { 'class': 'mt5700-hint' }, '缓存条数：0');
		cacheBody.appendChild(cacheEl);

		function exportCache() {
			var messages = Parse.getCachedSentMessages();
			var exportData = { app: 'at-webserver', version: 1, exportedAt: new Date().toISOString(), messages: messages };
			var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
			var url = URL.createObjectURL(blob);
			var link = document.createElement('a');
			link.href = url;
			link.download = 'sms-cache-export.json';
			link.click();
			URL.revokeObjectURL(url);
			Mt5700.success('已导出 ' + messages.length + ' 条记录');
		}

		function refreshCacheCount() {
			state.cacheCount = Parse.getCachedSentMessages().length;
			cacheEl.textContent = '缓存条数：' + state.cacheCount;
		}

		cacheBody.appendChild(Mt5700.panelActions(
			Mt5700.button('导出缓存', exportCache, 'primary'),
			Mt5700.button('导入缓存', function () {
				var input = document.createElement('input');
				input.type = 'file';
				input.accept = 'application/json';
				input.addEventListener('change', function () {
					var file = input.files && input.files[0];
					if (!file) return;
					var reader = new FileReader();
					reader.onload = function (e) {
						try {
							var data = JSON.parse(String(e.target.result));
							var messages = Array.isArray(data) ? data : (data.messages || []);
							var valid = messages.filter(function (m) {
								return m && typeof m.content === 'string' && typeof m.number === 'string' &&
									typeof m.time === 'string' && (m.type === 'sent' || m.type === 'received');
							});
							if (!valid.length) { Mt5700.error('文件中没有有效的短信记录'); return; }
							var list = Parse.getCachedSentMessages().concat(valid);
							localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(list));
							Mt5700.success('导入成功，共 ' + valid.length + ' 条');
							refreshCacheCount();
						} catch (err) {
							Mt5700.error('导入失败：文件格式不正确');
						}
					};
					reader.readAsText(file);
				});
				input.click();
			}, 'primary'),
			Mt5700.dangerButton('清空缓存', function () {
				Mt5700.confirm('确定清空本地已发缓存？', function () {
					Parse.clearSentMessageCache();
					Mt5700.success('已清空');
					refreshCacheCount();
				});
			})
		));

		/* ---------- USSD ---------- */
		var ussdCard = Mt5700.card('USSD 查询', '向运营商发送 USSD 代码，例如中国移动 *133#');
		var ussdBody = E('div');
		ussdCard._body.appendChild(ussdBody);
		body.appendChild(ussdCard);

		var ussdInput = Mt5700.input('text', '*133#', '*133#');
		ussdInput.style.maxWidth = '260px';
		ussdInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') sendUssd();
		});
		ussdBody.appendChild(Mt5700.formGroup('USSD 代码', ussdInput));

		var ussdReplyEl = E('div', { 'class': 'mt5700-terminal-log' });
		ussdBody.appendChild(ussdReplyEl);

		var ussdSendBtn = Mt5700.primaryButton('发送', function () { sendUssd(); });
		var ussdCancelBtn = Mt5700.button('取消会话', function () {
			AtWs.client.sendCommand(Parse.USSD_CANCEL_COMMAND).catch(function () {});
			ussdBusy = false;
			ussdSendBtn.disabled = false;
			ussdCancelBtn.style.display = 'none';
		}, 'ghost');
		ussdCancelBtn.style.display = 'none';
		ussdBody.appendChild(Mt5700.panelActions(ussdSendBtn, ussdCancelBtn));

		var ussdBusy = false;
		var ussdTimeout = null;

		function sendUssd() {
			var built = Parse.buildUssdCommand(ussdInput.value);
			if (built.error) { Mt5700.error(built.error); return; }
			ussdBusy = true;
			ussdSendBtn.disabled = true;
			ussdCancelBtn.style.display = '';
			ussdReplyEl.textContent = '等待运营商回复…';
			AtWs.client.sendCommand(built.command).then(function (res) {
				if (!res.success) throw new Error('模组拒绝了 USSD 请求');
				var inline = Parse.parseUssd(String(res.data || ''));
				if (inline && inline.text) {
					ussdReplyEl.textContent = inline.text;
					ussdBusy = false;
					ussdSendBtn.disabled = false;
					ussdCancelBtn.style.display = 'none';
				}
			}).catch(function (err) {
				ussdBusy = false;
				ussdSendBtn.disabled = false;
				ussdCancelBtn.style.display = 'none';
				Mt5700.error((err && err.message) || 'USSD 请求失败');
			});
			if (ussdTimeout) clearTimeout(ussdTimeout);
			ussdTimeout = setTimeout(function () {
				if (ussdBusy) {
					ussdBusy = false;
					ussdSendBtn.disabled = false;
					ussdCancelBtn.style.display = 'none';
					ussdReplyEl.textContent = '';
					Mt5700.warning('等待运营商回复超时，可重试或取消会话');
				}
			}, 30000);
		}

		// +CUSD URC 订阅
		var ussdHandler = function (resp) {
			if (!resp || resp.type !== 'urc_data') return;
			var urc = resp.data;
			var parsed = urc && urc.raw ? Parse.parseUssd(urc.raw) : null;
			if (parsed) {
				ussdReplyEl.textContent = parsed.text || '（无内容）';
				var extra = parsed.mText + (parsed.needsReply ? '：可继续输入选项后再次发送' : '');
				ussdReplyEl.appendChild(E('div', { 'class': 'mt5700-hint' }, extra));
				ussdBusy = false;
				ussdSendBtn.disabled = false;
				ussdCancelBtn.style.display = 'none';
				if (ussdTimeout) clearTimeout(ussdTimeout);
			}
		};
		AtWs.client.subscribe(ussdHandler);

		self._dispose = function () {
			AtWs.client.unsubscribe(ussdHandler);
			if (ussdTimeout) clearTimeout(ussdTimeout);
		};

		/* ---------- 短信开关步骤 ---------- */

		function toggleSMS(enable) {
			smsOnChk.disabled = true;
			var steps = enable ? [
				['AT+CEUS=1', 1000, '开启 CEUS'],
				['AT^IMSSWITCH=1,0,0', 2000, '开启 IMS'],
				['AT+CFUN=1', 2000, '恢复射频'],
				['AT+CGDCONT=5,"IPV4V6","","",0,0,0,0,1,1,1,,,,,,0,,0,0,0,0', 1000, '配置数据承载'],
				['AT+CSCA="' + (centerInput.value || '') + '"', 0, '配置中心号码']
			] : [
				['AT+CEUS=0', 500, '关闭 CEUS'],
				['AT^IMSSWITCH=0,0,0', 500, '关闭 IMS'],
				['AT+CFUN=0', 500, '关闭射频'],
				['AT+CMGD=1,4', 0, '清空短信']
			];
			var chain = Promise.resolve();
			for (var i = 0; i < steps.length; i++) {
				(function (step) {
					chain = chain.then(function () {
						if (!step[0]) return { success: true };
						return AtWs.client.sendCommand(step[0]).then(function (res) {
							if (!res.success) {
								Mt5700.error('步骤「' + step[2] + '」失败');
								throw new Error(step[2] + ' 失败');
							}
							return Ui.sleep(step[1]);
						});
					});
				})(steps[i]);
			}
			chain.then(function () {
				Mt5700.success(enable ? '短信功能已开启' : '短信功能已关闭');
				state.smsOn = enable;
				smsOnChk.checked = enable;
				loadStorage();
				return AtWs.client.sendCommand('AT+CSCA?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CSCA: "([^"]+)"/);
					if (m) { state.centerNumber = m[1]; centerInput.value = m[1]; }
				}
				smsOnChk.disabled = false;
			}).catch(function (err) {
				Mt5700.error((err && err.message) || '操作失败');
				smsOnChk.disabled = false;
				loadIMS();
			});
		}

		/* ---------- 加载 ---------- */

		function loadIMS() {
			return AtWs.client.sendCommand('AT^IMSSWITCH?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^IMSSWITCH:\s*(\d+),\d+,\d+/);
					if (m) {
						imsChk.checked = m[1] === '1';
						if (m[1] === '1') {
							return AtWs.client.sendCommand('AT+CSCA?').then(function (res2) {
								if (res2.success && res2.data) {
									var cm = String(res2.data).match(/\+CSCA: "([^"]+)"/);
									if (cm) { state.centerNumber = cm[1]; centerInput.value = cm[1]; }
								}
								smsOnChk.checked = true;
								state.smsOn = true;
							});
						}
						smsOnChk.checked = false;
						state.smsOn = false;
					}
				}
			}).catch(function () {});
		}

		function loadStorage() {
			return AtWs.client.sendCommand('AT+CMGF=0').then(function () {
				return AtWs.client.sendCommand('AT+CPMS?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CPMS: "(\w+)",(\d+),(\d+),"(\w+)",(\d+),(\d+),"(\w+)",(\d+),(\d+)/);
					if (m) {
						state.storage = {
							mem1: m[1], used1: parseInt(m[2], 10), total1: parseInt(m[3], 10),
							mem2: m[4], used2: parseInt(m[5], 10), total2: parseInt(m[6], 10),
							mem3: m[7], used3: parseInt(m[8], 10), total3: parseInt(m[9], 10)
						};
						renderStorage();
					}
				}
			}).catch(function () {});
		}

		function renderStorage() {
			var s = state.storage;
			var text = '存储用量：';
			text += s.mem1 + ' ' + s.used1 + '/' + s.total1;
			if (s.mem2) text += ' · ' + s.mem2 + ' ' + s.used2 + '/' + s.total2;
			if (s.mem3) text += ' · ' + s.mem3 + ' ' + s.used3 + '/' + s.total3;
			storageEl.textContent = text;
			var pct = s.total1 > 0 ? Math.round((s.used1 / s.total1) * 100) : 0;
			var bar = E('div', { 'class': 'mt5700-progress' });
			var fill = E('div', { 'class': 'mt5700-progress-fill' });
			fill.style.width = pct + '%';
			bar.appendChild(fill);
			storageEl.appendChild(bar);
		}

		function loadAll() {
			return Promise.resolve()
				.then(loadIMS)
				.then(loadStorage)
				.then(refreshCacheCount)
				.catch(function (err) { console.warn(err); });
		}

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						AtWs.client.connect(values.key).catch(function (e) { Mt5700.error((e && e.message) || '认证失败'); });
					}
				});
				return;
			}
			if (err) console.warn(err);
		}).then(function () {
			loadAll();
		});

		renderStorage();
		refreshCacheCount();

		return page;
	}
});
