'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/smsEncode';
/* global L, AtWs, Parse, Ui, SmsEncode */

/**
 * 短信中心（原 WebUI 短信 → 短信中心）
 * 等价迁移 sms/Center.tsx：
 * - 联系人聚合（按号码分组，按最后消息时间排序）
 * - 会话视图（右侧聊天样式）、发送（自动编码 PDU + 长短信分片）
 * - 新短信推送实时更新（new_sms）
 * - 单条删除 / 批量删除、存储量显示
 * - 缓存已发消息到 localStorage（等价 sms_sent_messages_cache）
 */

return L.view.extend({
	render: function () {
		var page = Ui.page('短信中心', '收发短信与联系人会话');
		var body = page._body;
		Ui.renderConnectionBar(body);

		var state = {
			contacts: [],        // [{ number, lastMessage, lastTime, unreadCount, messages: [] }]
			selectedContact: '',
			messages: [],        // 当前联系人消息
			inputMessage: '',
			newContactNumber: '',
			storage: { used: 0, total: 0 },
			smsEnabled: true,
			imsEnabled: true
		};

		/* ---------- 布局 ---------- */
		var panel = Ui.panel('短信', '选择左侧联系人查看会话，或发送新短信');
		body.appendChild(panel);

		var layout = E('div', { 'class': 'at-sms-layout' });
		panel._body.appendChild(layout);

		// 左：联系人
		var left = E('div', { 'class': 'at-sms-left' });
		var storageEl = E('div', { 'class': 'at-sms-storage' }, '存储：—');
		left.appendChild(storageEl);
		var contactList = E('div', { 'class': 'at-sms-contacts' });
		left.appendChild(contactList);
		var newContactBtn = Ui.primaryButton('+ 新短信', function () {
			Ui.promptModal('新短信', [
				{ key: 'number', label: '收件人号码', placeholder: '请输入 5-19 位手机号码' }
			], function (values) {
				var num = (values.number || '').trim();
				if (!num) { Ui.warning('请输入联系人号码'); return; }
				if (!Parse.isValidPhoneNumber(num)) { Ui.warning('请输入正确的5-19位手机号码'); return; }
				state.selectedContact = num;
				state.messages = [];
				renderConversation();
				selectContact(num);
			});
		});
		left.appendChild(newContactBtn);
		layout.appendChild(left);

		// 右：会话
		var right = E('div', { 'class': 'at-sms-right' });
		var convHead = E('div', { 'class': 'at-sms-conv-head' }, '请选择联系人');
		right.appendChild(convHead);
		var convBody = E('div', { 'class': 'at-sms-conv-body' });
		right.appendChild(convBody);
		var inputRow = E('div', { 'class': 'at-sms-input-row' });
		var msgInput = document.createElement('textarea');
		msgInput.className = 'at-sms-textarea';
		msgInput.placeholder = '输入短信内容，回车发送（Shift+Enter 换行）';
		msgInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
		});
		var hintEl = E('div', { 'class': 'at-sms-hint' }, '');
		var sendBtn = Ui.primaryButton('发送', send);
		var batchDeleteBtn = Ui.button('批量删除', 'cbi-button-negative', batchDelete);
		inputRow.appendChild(msgInput);
		inputRow.appendChild(hintEl);
		var btns = E('div', { 'class': 'at-panel-actions' });
		btns.appendChild(sendBtn);
		btns.appendChild(batchDeleteBtn);
		right.appendChild(inputRow);
		right.appendChild(btns);
		layout.appendChild(right);

		/* ---------- 渲染 ---------- */

		function normalizeNumber(n) { return Parse.normalizePhoneNumber(n); }

		function renderStorage() {
			storageEl.textContent = '存储：' + state.storage.used + ' / ' + state.storage.total;
		}

		function renderContacts() {
			contactList.innerHTML = '';
			if (!state.contacts.length) {
				contactList.appendChild(E('div', { 'class': 'at-empty' }, '暂无短信'));
			}
			for (var i = 0; i < state.contacts.length; i++) {
				var c = state.contacts[i];
				var item = E('div', { 'class': 'at-sms-contact' + (c.number === state.selectedContact ? ' at-sms-contact-active' : '') });
				item.appendChild(E('div', { 'class': 'at-sms-contact-num' }, c.number));
				item.appendChild(E('div', { 'class': 'at-sms-contact-last' }, c.lastMessage || ''));
				item.appendChild(E('div', { 'class': 'at-sms-contact-time' }, c.lastTime || ''));
				item.addEventListener('click', function (num) { return function () { selectContact(num); }; }(c.number));
				contactList.appendChild(item);
			}
		}

		function renderConversation() {
			convHead.textContent = state.selectedContact ? '与 ' + state.selectedContact + ' 的会话' : '请选择联系人';
			convBody.innerHTML = '';
			if (!state.messages.length) {
				convBody.appendChild(E('div', { 'class': 'at-empty' }, '暂无消息，输入内容发送'));
			}
			for (var i = 0; i < state.messages.length; i++) {
				var m = state.messages[i];
				var isSent = m.type === 'sent';
				var bubble = E('div', { 'class': 'at-sms-bubble ' + (isSent ? 'at-sms-sent' : 'at-sms-recv') });
				var content = E('div', { 'class': 'at-sms-msg-content' }, m.content || '(空消息)');
				bubble.appendChild(content);
				var meta = E('div', { 'class': 'at-sms-msg-meta' }, m.time || '');
				bubble.appendChild(meta);
				if (m.isConcatenated && m.concatenatedTotal > 1) {
					bubble.appendChild(E('div', { 'class': 'at-sms-msg-part' },
						'片段 ' + m.concatenatedSeq + '/' + m.concatenatedTotal));
				}
				// 删除按钮
				var del = Ui.button('删除', 'cbi-button-negative', function (mm) { return function () {
					Ui.confirm('确定删除该短信？', function () { deleteMessage(mm); });
				}; }(m));
				del.className = 'at-sms-del';
				bubble.appendChild(del);
				convBody.appendChild(bubble);
			}
			convBody.scrollTop = convBody.scrollHeight;
		}

		function renderHint() {
			var text = msgInput.value.trim();
			var stats = SmsEncode.messageStats(text);
			if (!text) { hintEl.textContent = ''; return; }
			var parts = stats.encoding === 'UCS2' ? '含中文等字符，按 UCS2 编码' : '纯 ASCII，按 GSM 7bit 编码';
			hintEl.textContent = stats.chars + ' 字 · ' + parts + (stats.parts > 1 ? ' · 将拆成 ' + stats.parts + ' 条' : '');
		}
		msgInput.addEventListener('input', renderHint);

		/* ---------- 数据 ---------- */

		function refreshStorage() {
			return AtWs.client.sendCommand('AT^CPMS?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CPMS: "\w+",(\d+),(\d+)/);
					if (m) { state.storage = { used: parseInt(m[1], 10), total: parseInt(m[2], 10) }; renderStorage(); }
				}
			}).catch(function () {});
		}

		function refresh() {
			return AtWs.client.sendCommand('AT+CMGL=4').then(function (res) {
				if (!res.success) {
					if (res.error && String(res.error).indexOf('CME ERROR') >= 0) {
						Ui.warning('短信功能可能未开启，请到「短信设置」开启');
					} else {
						Ui.error(String(res.error || '获取短信列表失败'));
					}
					return;
				}
				var raw = typeof res.data === 'string' ? res.data : '';
				var parsed = (raw && raw !== 'OK' && raw !== 'NO SMS') ? Parse.parseCMGL(raw) : [];
				var cached = Parse.getCachedSentMessages();
				buildContacts(parsed.concat(cached));
			}).catch(function () {
				Ui.error('获取短信列表失败');
			});
		}

		function buildContacts(list) {
			var map = {};
			for (var i = 0; i < list.length; i++) {
				var msg = list[i];
				var num = normalizeNumber(msg.number);
				if (!num) continue;
				if (!map[num]) {
					map[num] = { number: num, lastMessage: msg.content, lastTime: msg.time, unreadCount: 0, messages: [] };
				}
				map[num].messages.push(msg);
				var t = Parse.parseMessageTime(msg.time).getTime();
				if (t >= Parse.parseMessageTime(map[num].lastTime).getTime()) {
					map[num].lastMessage = msg.content;
					map[num].lastTime = msg.time;
				}
			}
			var list2 = [];
			for (var key in map) {
				var c = map[key];
				c.messages.sort(function (a, b) {
					return Parse.parseMessageTime(a.time).getTime() - Parse.parseMessageTime(b.time).getTime();
				});
				list2.push(c);
			}
			list2.sort(function (a, b) {
				return Parse.parseMessageTime(b.lastTime).getTime() - Parse.parseMessageTime(a.lastTime).getTime();
			});
			state.contacts = list2;
			if (state.selectedContact) {
				var sel = null;
				for (var j = 0; j < list2.length; j++) {
					if (normalizeNumber(list2[j].number) === normalizeNumber(state.selectedContact)) { sel = list2[j]; break; }
				}
				state.messages = sel ? sel.messages : [];
			}
			renderContacts();
			renderConversation();
		}

		function selectContact(num) {
			state.selectedContact = num;
			for (var i = 0; i < state.contacts.length; i++) {
				if (normalizeNumber(state.contacts[i].number) === normalizeNumber(num)) {
					state.messages = state.contacts[i].messages;
					break;
				}
			}
			renderContacts();
			renderConversation();
		}

		/* ---------- 发送 ---------- */

		function nowTimeStr() {
			var d = new Date();
			var pad = function (n) { return String(n).padStart(2, '0'); };
			return pad(d.getFullYear() % 100) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
				',' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
		}

		function send(explicitTarget) {
			var content = msgInput.value.trim();
			if (!content) { Ui.warning('请输入短信内容'); return; }
			var target = (explicitTarget || '').trim() || state.selectedContact || '';
			if (!target) { Ui.warning('请输入联系人号码'); return; }
			if (!Parse.isValidPhoneNumber(target)) { Ui.warning('请输入正确的5-19位手机号码'); return; }

			sendBtn.disabled = true;
			var chain = Promise.resolve();
			// 确保 PDU 模式
			chain = chain.then(function () { return AtWs.client.sendCommand('AT+CMGF?'); })
				.then(function (res) {
					if (res.success && String(res.data).indexOf('+CMGF: 1') >= 0) {
						return AtWs.client.sendCommand('AT+CMGF=0');
					}
					return { success: true };
				})
				.then(function () { return AtWs.client.sendCommand('AT+CSCA?'); })
				.then(function (res) {
					var smsc = '';
					if (res.success && res.data) {
						var m = String(res.data).match(/\+CSCA: "([^"]+)"/);
						if (m) smsc = m[1];
					}
					var formatted = target.replace(/^\+/, '');
					var parts = SmsEncode.buildSubmitParts({ smsc: smsc, destination: formatted, message: content });
					var chain2 = Promise.resolve();
					for (var i = 0; i < parts.length; i++) {
						chain2 = chain2.then(function (part) {
							return AtWs.client.sendCommand('AT+CMGS=' + part.tpduLength + '\r' + part.pdu);
						}.bind(null, parts[i]));
					}
					return chain2;
				});

			chain.then(function (lastRes) {
				if (lastRes && lastRes.success === false) throw new Error(String(lastRes.error || '发送失败'));
				var sent = {
					index: -Date.now(),
					content: content,
					number: target,
					time: nowTimeStr(),
					type: 'sent'
				};
				Parse.saveSentMessageToCache(sent);
				state.messages.push(sent);
				msgInput.value = '';
				renderHint();
				renderConversation();
				Ui.success('发送成功');
				refresh();
			}).catch(function (err) {
				Ui.error((err && err.message) || '发送失败');
			}).finally(function () { sendBtn.disabled = false; });
		}

		/* ---------- 删除 ---------- */

		function deleteMessage(msg) {
			if (msg.index >= 0) {
				AtWs.client.sendCommand('AT+CMGD=' + msg.index).then(function (res) {
					if (res.success) { Ui.success('删除成功'); refresh(); }
					else { Ui.error('删除失败'); }
				}).catch(function () { Ui.error('删除失败'); });
			} else {
				// 缓存中的已发消息
				var updated = Parse.getCachedSentMessages().filter(function (m) { return m.index !== msg.index; });
				try { localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(updated)); } catch (e) {}
				Ui.success('删除成功');
				refresh();
			}
		}

		function batchDelete() {
			// 等价原件：先勾选，这里简化——列出当前会话消息让用户勾选
			var mask = E('div', { 'class': 'at-modal-mask' });
			var box = E('div', { 'class': 'at-modal at-modal-wide' });
			box.appendChild(E('h4', { 'class': 'at-modal-title' }, '批量删除短信'));
			var listEl = E('div', { 'class': 'at-batch-list' });
			var checked = [];
			for (var i = 0; i < state.messages.length; i++) {
				var m = state.messages[i];
				var row = E('label', { 'class': 'at-batch-item' });
				var chk = document.createElement('input');
				chk.type = 'checkbox';
				chk.className = 'cbi-input-checkbox';
				(function (msg, cb) {
					cb.addEventListener('change', function () {
						var idx = checked.indexOf(msg);
						if (cb.checked && idx < 0) checked.push(msg);
						if (!cb.checked && idx >= 0) checked.splice(idx, 1);
					});
				})(m, chk);
				row.appendChild(chk);
				row.appendChild(E('span', {}, (m.type === 'sent' ? '[发] ' : '[收] ') + (m.number || '') + '：' + (m.content || '').slice(0, 30)));
				listEl.appendChild(row);
			}
			if (!state.messages.length) listEl.appendChild(E('div', { 'class': 'at-empty' }, '当前会话没有可删除的短信'));
			var actions = E('div', { 'class': 'at-modal-actions' });
			var cancel = Ui.button('取消', 'cbi-button-neutral', function () { if (mask.parentNode) mask.parentNode.removeChild(mask); });
			var ok = Ui.button('删除所选', 'cbi-button-negative', function () {
				if (mask.parentNode) mask.parentNode.removeChild(mask);
				if (!checked.length) { Ui.warning('请先选择要删除的短信'); return; }
				var chain = Promise.resolve();
				checked.forEach(function (m) {
					chain = chain.then(function () {
						if (m.index >= 0) return AtWs.client.sendCommand('AT+CMGD=' + m.index);
						return Promise.resolve({ success: true });
					});
				});
				chain.then(function () {
					var cachedIds = checked.filter(function (m) { return m.index < 0; }).map(function (m) { return m.index; });
					if (cachedIds.length) {
						var updated = Parse.getCachedSentMessages().filter(function (m) { return cachedIds.indexOf(m.index) < 0; });
						try { localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(updated)); } catch (e) {}
					}
					Ui.success('成功删除 ' + checked.length + ' 条短信');
					refresh();
				}).catch(function () { Ui.error('批量删除失败'); });
			});
			actions.appendChild(cancel);
			actions.appendChild(ok);
			box.appendChild(listEl);
			box.appendChild(actions);
			mask.appendChild(box);
			mask.addEventListener('click', function (e) { if (e.target === mask) { if (mask.parentNode) mask.parentNode.removeChild(mask); } });
			document.body.appendChild(mask);
		}

		/* ---------- 新短信推送 ---------- */

		var newSmsHandler = function (resp) {
			if (!resp || resp.type !== 'new_sms' || !resp.data) return;
			var d = resp.data;
			var msg = {
				index: d.index != null ? d.index : -Date.now(),
				content: d.content || '',
				number: normalizeNumber(d.sender || d.number || ''),
				time: d.time || nowTimeStr(),
				type: 'received',
				isConcatenated: d.isComplete === false ? true : false
			};
			// 完整消息直接进列表；长短信由服务端拼接后推送（isComplete=true）
			if (d.isComplete !== false) {
				buildContacts(state.contacts.reduce(function (acc, c) { return acc.concat(c.messages); }, []).concat([msg]));
				Ui.info('收到来自 ' + msg.number + ' 的新短信');
			}
		};
		AtWs.client.subscribe(newSmsHandler);

		this._dispose = function () { AtWs.client.unsubscribe(newSmsHandler); };

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
			refreshStorage();
			refresh();
		});

		return page;
	}
});
