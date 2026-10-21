'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 短信设置页面（含 USSD 查询）：
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
		var page = Mt5700.page('短信设置', '短信服务开关、服务中心号码 (SMSC)、存储器映射与 USSD 代码查询', 'sms_settings', '短信配置 · 存储/USSD');
		var body = page._body;


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

		/* ---------- IMS 与短信开关 + 短信中心号码（双列并排） ---------- */
		var rowSms = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowSms);

		var smsCard = Mt5700.card('短信服务', 'IMS 与短信收发开关');
		var smsBody = E('div');
		smsCard._body.appendChild(smsBody);
		rowSms.appendChild(smsCard);

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
		rowSms.appendChild(centerCard);

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
		/* 存储管理 + 本地已发缓存：双列并排 */
		var rowStore = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowStore);

		var storeCard = Mt5700.card('存储管理', 'SIM 卡短信存储');
		var storeBody = E('div');
		storeCard._body.appendChild(storeBody);
		rowStore.appendChild(storeCard);

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
				AtWs.client.sms('set_storage', { mem: loc }).then(function (res) {
					if (res.success && res.result && res.result.storage) {
						Mt5700.success('存储位置已保存');
						applyStorage(res.result.storage);
					} else { Mt5700.error('保存失败：' + (res.error || '')); }
				}).catch(function () { Mt5700.error('保存失败'); });
			}),
			Mt5700.dangerButton('清空全部短信', function () {
				Mt5700.confirm('确定清空全部短信？此操作不可恢复。', function () {
					/*
					 * 清空是「切存储区 + AT+CMGD=1,4」的循环，必须由后端在**一次事务**
					 * 里跑完：中间被别的命令插进来会留下没清干净的存储区。
					 */
					AtWs.client.sms('purge').then(function (res) {
						if (res.success && res.result && res.result.storage) {
							Mt5700.success('已清空全部短信');
							applyStorage(res.result.storage);
						} else { Mt5700.error('清空短信失败：' + (res.error || '')); }
					}).catch(function () { Mt5700.error('清空短信失败'); });
				});
			})
		));

		/* ---------- 旧版本本地缓存残留 ---------- */
		/*
		 * 这里**不再是短信的数据源**。
		 *
		 * 旧版本把已发短信存在浏览器 localStorage 里并混进列表，后果是：
		 * 那些条目没有模组序号，删除时按着不存在的 index 下发一堆 AT+CMGD，
		 * 全是 ERROR；模组里删掉/清空的短信还会继续显示在界面上。
		 * 现在列表一律以模组实时返回为准，这一栏只用来清掉历史遗留数据。
		 */
		var cacheCard = Mt5700.card('旧版本本地缓存', '历史版本遗留的浏览器本地记录，已不再作为数据来源');
		var cacheBody = E('div');
		cacheCard._body.appendChild(cacheBody);
		cacheBody.appendChild(E('div', { 'class': 'mt5700-hint' },
			'短信列表已改为实时读取模组，本地不再保存任何短信副本。'));
		var cacheEl = E('div', { 'class': 'mt5700-hint' }, '残留条数：0');
		cacheBody.appendChild(cacheEl);

		function refreshCacheCount() {
			state.cacheCount = Parse.countLegacySentMessages();
			cacheEl.textContent = '残留条数：' + state.cacheCount;
		}

		cacheBody.appendChild(Mt5700.panelActions(
			Mt5700.dangerButton('清除残留', function () {
				if (!state.cacheCount) { Mt5700.success('没有残留数据'); return; }
				Mt5700.confirm('清除旧版本遗留的本地记录？（不影响模组里的短信）', function () {
					Parse.clearSentMessageCache();
					Mt5700.success('已清除');
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

		/*
		 * 短信功能开关。
		 *
		 * 旧实现在前端连发五条各自排队的 AT 命令，后台巡检随时会从中间插进来，
		 * 把「射频刚被拉起来」的状态打断 —— 表现为开关看着勾上了、短信却发不出去。
		 * 现在整串（含模组需要的处理间隔）由后端在**一次事务**里独占通道跑完，
		 * 并把每一步的结果如实回传。
		 */
		function toggleSMS(enable) {
			smsOnChk.disabled = true;
			AtWs.client.sms('power', { enable: enable, smsc: centerInput.value || '' })
				.then(function (res) {
					if (!res.success) throw new Error(res.error || '操作失败');
					var r = res.result || {};
					if (r.failedAt) {
						throw new Error('步骤「' + r.failedAt + '」失败');
					}
					Mt5700.success(enable ? '短信功能已开启' : '短信功能已关闭');
					state.smsOn = enable;
					smsOnChk.checked = enable;
					/* 以模组回读到的真实值为准 */
					if (r.smsc) { state.centerNumber = r.smsc; centerInput.value = r.smsc; }
					if (r.storage) applyStorage(r.storage);
				}).catch(function (err) {
					Mt5700.error((err && err.message) || '操作失败');
					loadIMS();
				}).then(function () {
					smsOnChk.disabled = false;
				});
		}

		/* ---------- 加载 ---------- */

		/*
		 * IMS 与短信中心号码：都走短信接口的实时读取，不缓存、不猜测。
		 * `enabled` 为 null 表示模组没给出可判定的值（界面保持原状，不硬勾）。
		 */
		function loadIMS() {
			return AtWs.client.sms('get_ims').then(function (res) {
				if (res.success && res.result && res.result.enabled !== null && res.result.enabled !== undefined) {
					state.imsOn = !!res.result.enabled;
					imsChk.checked = state.imsOn;
					smsOnChk.checked = state.imsOn;
					state.smsOn = state.imsOn;
					return AtWs.client.sms('get_smsc').then(function (r2) {
						if (r2.success && r2.result && r2.result.smsc) {
							state.centerNumber = r2.result.smsc;
							centerInput.value = r2.result.smsc;
						}
					});
				}
			}).catch(function () {});
		}

		/*
		 * 存储用量：一次真实下发 `AT+CPMS?`（后端读），界面显示的永远是模组当次读数。
		 * 旧实现把 `AT+CMGF=0` 与 `AT+CPMS?` 拆成两条独立命令，中间可能被巡检插进来；
		 * 现在两条都在后端一次事务里完成。
		 */
		function applyStorage(st) {
			if (!st) return;
			state.storage = {
				mem1: st.mem1 || '', used1: st.used || 0, total1: st.total || 0,
				mem2: st.mem2 || '', used2: 0, total2: 0,
				mem3: st.mem3 || '', used3: 0, total3: 0
			};
			renderStorage();
		}

		function loadStorage() {
			return AtWs.client.sms('capacity').then(function (res) {
				if (res.success && res.result && res.result.storage) applyStorage(res.result.storage);
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

		Ui.startup(body, function () {
			loadAll();
		});

		renderStorage();
		refreshCacheCount();

		return page;
	}
});
