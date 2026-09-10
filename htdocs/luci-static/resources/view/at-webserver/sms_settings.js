'use strict';
'require at-webserver/ws';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/smsEncode';
/* global L, AtWs, Parse, Ui, SmsEncode */

/**
 * 短信设置（原 WebUI 短信 → 短信设置）+ USSD 查询（原短信 → USSD）
 * 等价迁移 sms/Settings.tsx 与 sms/UssdPanel.tsx：
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
		var page = Ui.page('短信设置', '短信功能开关、中心号码、存储管理与 USSD 查询');
		var body = page._body;
		Ui.renderConnectionBar(body);

		var state = {
			imsOn: false,
			smsOn: false,
			centerNumber: '',
			storage: { mem1: '', used1: 0, total1: 0, mem2: '', used2: 0, total2: 0, mem3: '', used3: 0, total3: 0 },
			cacheCount: 0
		};

		/* ---------- IMS 与短信开关 ---------- */
		var smsPanel = Ui.panel('短信服务', 'IMS 与短信收发开关');
		var imsChk = document.createElement('input');
		imsChk.type = 'checkbox';
		imsChk.className = 'cbi-input-checkbox';
		imsChk.addEventListener('change', function () {
			AtWs.client.sendCommand('AT^IMSSWITCH=' + (imsChk.checked ? '1,0,0' : '0,0,0')).then(function (res) {
				if (res.success) { Ui.success((imsChk.checked ? '开启' : '关闭') + 'IMS 成功'); }
				else { Ui.error((imsChk.checked ? '开启' : '关闭') + 'IMS 失败'); imsChk.checked = !imsChk.checked; }
			}).catch(function () { Ui.error('IMS 设置失败'); });
		});
		smsPanel._body.appendChild(Ui.field('IMS 短信', imsChk, '开启后可收发短信'));

		var smsOnChk = document.createElement('input');
		smsOnChk.type = 'checkbox';
		smsOnChk.className = 'cbi-input-checkbox';
		smsOnChk.addEventListener('change', function () { toggleSMS(smsOnChk.checked); });
		smsPanel._body.appendChild(Ui.field('短信功能', smsOnChk, '开启时按顺序下发 CEUS/IMSSWITCH/CFUN/CGDCONT/CSCA 配置'));
		body.appendChild(smsPanel);

		/* ---------- 短信中心号码 ---------- */
		var centerPanel = Ui.panel('短信中心号码', '用于发送短信的 SMSC');
		var centerInput = document.createElement('input');
		centerInput.className = 'cbi-input-text';
		centerInput.placeholder = '+8613800755500';
		centerInput.addEventListener('input', function () { state.centerNumber = centerInput.value; });
		centerPanel._body.appendChild(Ui.field('中心号码', centerInput));
		var centerSave = Ui.primaryButton('保存中心号码', function () {
			var num = centerInput.value.trim();
			if (!num) { Ui.error('请输入短信中心号码'); return; }
			AtWs.client.sendCommand('AT+CSCA="' + num + '"').then(function (res) {
				if (res.success) { Ui.success('短信中心号码已保存'); }
				else { Ui.error('保存失败'); }
			}).catch(function () { Ui.error('保存失败'); });
		});
		centerPanel._body.appendChild(centerSave);
		body.appendChild(centerPanel);

		/* ---------- 存储管理 ---------- */
		var storePanel = Ui.panel('存储管理', 'SIM 卡短信存储');
		var storageEl = E('div', { 'class': 'at-storage-info' }, '存储用量：—');
		storePanel._body.appendChild(storageEl);

		var locSel = document.createElement('select');
		locSel.className = 'cbi-input-select';
		[{ v: 'SM', l: 'SIM 卡' }, { v: 'ME', l: '模组内存' }, { v: 'MT', l: '自动（SIM 优先）' }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			locSel.appendChild(opt);
		});
		storePanel._body.appendChild(Ui.field('存储位置', locSel));
		var storeSave = Ui.primaryButton('保存存储位置', function () {
			var loc = locSel.value;
			AtWs.client.sendCommand('AT+CPMS="' + loc + '","' + loc + '","' + loc + '"').then(function (res) {
				if (res.success) { Ui.success('存储位置已保存'); loadStorage(); }
				else { Ui.error('保存失败'); }
			}).catch(function () { Ui.error('保存失败'); });
		});
		storePanel._body.appendChild(storeSave);

		var clearAllBtn = Ui.dangerButton('清空全部短信', function () {
			Ui.confirm('确定清空全部短信？此操作不可恢复。', function () {
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
					var unique = Array.from(new Set(storages));
					var chain = Promise.resolve();
					unique.forEach(function (st) {
						chain = chain.then(function () { return AtWs.client.sendCommand('AT+CMGF=0'); })
							.then(function () { return AtWs.client.sendCommand('AT+CPMS="' + st + '","' + st + '","' + st + '"'); })
							.then(function () { return AtWs.client.sendCommand('AT+CMGD=1,4'); });
					});
					return chain;
				}).then(function () {
					Ui.success('已清空全部短信');
					loadStorage();
				}).catch(function () { Ui.error('清空短信失败'); });
			});
		});
		storePanel._body.appendChild(clearAllBtn);
		body.appendChild(storePanel);

		/* ---------- 本地已发缓存 ---------- */
		var cachePanel = Ui.panel('本地已发缓存', '发送记录保存在浏览器本地，可导出/导入/清空');
		var cacheEl = E('div', { 'class': 'at-hint' }, '缓存条数：0');
		cachePanel._body.appendChild(cacheEl);
		var cacheActions = E('div', { 'class': 'at-panel-actions' });
		var exportBtn = Ui.button('导出缓存', 'cbi-button-action', exportCache);
		var importBtn = Ui.button('导入缓存', 'cbi-button-action', function () {
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
						if (!valid.length) { Ui.error('文件中没有有效的短信记录'); return; }
						var list = Parse.getCachedSentMessages().concat(valid);
						localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(list));
						Ui.success('导入成功，共 ' + valid.length + ' 条');
						refreshCacheCount();
					} catch (err) {
						Ui.error('导入失败：文件格式不正确');
					}
				};
				reader.readAsText(file);
			});
			input.click();
		});
		var clearCacheBtn = Ui.button('清空缓存', 'cbi-button-negative', function () {
			Ui.confirm('确定清空本地已发缓存？', function () {
				Parse.clearSentMessageCache();
				Ui.success('已清空');
				refreshCacheCount();
			});
		});
		cacheActions.appendChild(exportBtn);
		cacheActions.appendChild(importBtn);
		cacheActions.appendChild(clearCacheBtn);
		cachePanel._body.appendChild(cacheActions);
		body.appendChild(cachePanel);

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
			Ui.success('已导出 ' + messages.length + ' 条记录');
		}

		function refreshCacheCount() {
			state.cacheCount = Parse.getCachedSentMessages().length;
			cacheEl.textContent = '缓存条数：' + state.cacheCount;
		}

		/* ---------- USSD ---------- */
		var ussdPanel = Ui.panel('USSD 查询', '向运营商发送 USSD 代码，例如中国移动 *133#');
		var ussdInput = document.createElement('input');
		ussdInput.className = 'cbi-input-text';
		ussdInput.style.width = '220px';
		ussdInput.value = '*133#';
		ussdInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') sendUssd();
		});
		ussdPanel._body.appendChild(Ui.field('USSD 代码', ussdInput));
		var ussdReplyEl = E('div', { 'class': 'at-ussd-reply' });
		ussdPanel._body.appendChild(ussdReplyEl);
		var ussdActions = E('div', { 'class': 'at-panel-actions' });
		var ussdSendBtn = Ui.primaryButton('发送', sendUssd);
		var ussdCancelBtn = Ui.button('取消会话', 'cbi-button-action', function () {
			AtWs.client.sendCommand(Parse.USSD_CANCEL_COMMAND).catch(function () {});
			ussdBusy = false;
			ussdSendBtn.disabled = false;
			ussdCancelBtn.style.display = 'none';
		});
		ussdCancelBtn.style.display = 'none';
		ussdActions.appendChild(ussdSendBtn);
		ussdActions.appendChild(ussdCancelBtn);
		ussdPanel._body.appendChild(ussdActions);
		body.appendChild(ussdPanel);

		var ussdBusy = false;
		var ussdTimeout = null;

		function sendUssd() {
			var built = Parse.buildUssdCommand(ussdInput.value);
			if (built.error) { Ui.error(built.error); return; }
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
				Ui.error((err && err.message) || 'USSD 请求失败');
			});
			if (ussdTimeout) clearTimeout(ussdTimeout);
			ussdTimeout = setTimeout(function () {
				if (ussdBusy) {
					ussdBusy = false;
					ussdSendBtn.disabled = false;
					ussdCancelBtn.style.display = 'none';
					ussdReplyEl.textContent = '';
					Ui.warning('等待运营商回复超时，可重试或取消会话');
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
				ussdReplyEl.appendChild(E('div', { 'class': 'at-hint' }, extra));
				ussdBusy = false;
				ussdSendBtn.disabled = false;
				ussdCancelBtn.style.display = 'none';
				if (ussdTimeout) clearTimeout(ussdTimeout);
			}
		};
		AtWs.client.subscribe(ussdHandler);
		this._dispose = function () {
			AtWs.client.unsubscribe(ussdHandler);
			if (ussdTimeout) clearTimeout(ussdTimeout);
		};

		/* ---------- 短信开关步骤（等价原件 toggleSMS） ---------- */

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
								Ui.error('步骤「' + step[2] + '」失败');
								throw new Error(step[2] + ' 失败');
							}
							return Ui.sleep(step[1]);
						});
					});
				})(steps[i]);
			}
			chain.then(function () {
				Ui.success(enable ? '短信功能已开启' : '短信功能已关闭');
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
				Ui.error((err && err.message) || '操作失败');
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
			var html = '存储用量：';
			html += s.mem1 + ' ' + s.used1 + '/' + s.total1;
			if (s.mem2) html += ' · ' + s.mem2 + ' ' + s.used2 + '/' + s.total2;
			if (s.mem3) html += ' · ' + s.mem3 + ' ' + s.used3 + '/' + s.total3;
			storageEl.textContent = html;
			var pct = s.total1 > 0 ? Math.round((s.used1 / s.total1) * 100) : 0;
			var bar = E('div', { 'class': 'at-progress-bar' });
			var fill = E('div', { 'class': 'at-progress-fill' + (pct > 90 ? ' at-progress-danger' : ''), style: 'width:' + pct + '%' });
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

		/* ---------- 初始化 ---------- */
		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) AtWs.client.connect(values.key).catch(function (e) { Ui.error((e && e.message) || '认证失败'); });
				});
				return;
			}
			if (err) console.warn(err);
		}).then(function () {
			loadAll();
		});

		return page;
	}
});
