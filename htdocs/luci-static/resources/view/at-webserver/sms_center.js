'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/smsEncode';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, SmsEncode, Mt5700 */

/**
 * 短信中心页面：
 *
 * - 联系人聚合（按号码分组，按最后消息时间排序）
 * - 会话视图（聊天样式）、发送（自动编码 PDU + 长短信分片）
 * - 新短信推送实时更新（new_sms）
 * - 单条删除 / 批量删除、存储量显示
 * - 缓存已发消息到 localStorage
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('短信中心', '即时短信收发、会话列表、长短信拼接与存储箱管理', 'sms_center', '即时消息 · 会话管理');
		var body = page._body;


		var state = {
			contacts: [],        // [{ number, lastMessage, lastTime, unreadCount, messages: [] }]
			selectedContact: '',
			messages: [],        // 当前联系人消息
			storage: { used: 0, total: 0 }
		};

		/* ---------- 布局 ---------- */
		var layout = E('div', { 'class': 'mt5700-sms-layout' });
		body.appendChild(layout);

		// 左：联系人
		var left = E('div', { 'class': 'mt5700-sms-list' });
		var leftHead = E('div', { 'class': 'mt5700-sms-list-header' });
		var storageEl = E('div', { 'class': 'mt5700-hint' }, '存储：—');
		leftHead.appendChild(storageEl);
		left.appendChild(leftHead);
		var contactList = E('div', { 'class': 'mt5700-sms-list-body' });
		left.appendChild(contactList);
		var newContactWrap = E('div', { 'class': 'mt5700-sms-input' });
		newContactWrap.appendChild(Mt5700.primaryButton('+ 新短信', function () {
			Ui.promptModal('新短信', [
				{ key: 'number', label: '收件人号码', placeholder: '请输入 5-19 位手机号码' }
			], function (values) {
				var num = (values.number || '').trim();
				if (!num) { Mt5700.warning('请输入联系人号码'); return; }
				if (!Parse.isValidPhoneNumber(num)) { Mt5700.warning('请输入正确的 5-19 位手机号码'); return; }
				state.selectedContact = num;
				state.messages = [];
				renderContacts();
				renderConversation();
			});
		}));
		left.appendChild(newContactWrap);
		layout.appendChild(left);

		// 右：会话
		var right = E('div', { 'class': 'mt5700-sms-detail' });
		var convHead = E('div', { 'class': 'mt5700-sms-detail-header' }, '请选择联系人');
		right.appendChild(convHead);
		var convBody = E('div', { 'class': 'mt5700-sms-detail-body' });
		right.appendChild(convBody);

		var inputWrap = E('div', { 'class': 'mt5700-sms-input' });
		var msgInput = E('textarea', {
			'class': 'mt5700-input',
			rows: '3',
			placeholder: '输入短信内容，回车发送（Shift+Enter 换行）'
		});
		msgInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
		});
		var hintEl = E('div', { 'class': 'mt5700-hint' }, '');
		inputWrap.appendChild(msgInput);
		inputWrap.appendChild(hintEl);

		var sendBtn = Mt5700.primaryButton('发送', function () { send(); });
		inputWrap.appendChild(Mt5700.panelActions(
			sendBtn,
			Mt5700.dangerButton('批量删除', function () { batchDelete(); })
		));
		right.appendChild(inputWrap);
		layout.appendChild(right);

		/* ---------- 渲染 ---------- */

		function normalizeNumber(n) { return Parse.normalizePhoneNumber(n); }

		// 长短信拼接：把同一发件人、同一拼接引用号的各段合并为一条完整消息
		function mergeConcatenated(list) {
			var groups = {};
			var result = [];
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				if (m && m.type === 'received' && m.isConcatenated && m.concatenatedRef != null && m.concatenatedSeq != null) {
					var key = (m.number || '') + '|' + m.concatenatedRef;
					if (!groups[key]) groups[key] = [];
					groups[key].push(m);
				} else {
					result.push(m);
				}
			}
			for (var k in groups) {
				var parts = groups[k];
				parts.sort(function (a, b) { return (a.concatenatedSeq || 0) - (b.concatenatedSeq || 0); });
				var full = '';
				for (var j = 0; j < parts.length; j++) full += (parts[j].content || '');
				var first = parts[0];
				var last = parts[parts.length - 1];
				var idxs = [];
				for (var p = 0; p < parts.length; p++) if (parts[p].index != null) idxs.push(parts[p].index);
				result.push({
					index: first.index,
					partIndices: idxs,
					content: full,
					number: first.number,
					time: last.time,
					type: 'received',
					isConcatenated: false,
					concatenatedRef: first.concatenatedRef,
					concatenatedTotal: undefined,
					concatenatedSeq: undefined,
					partsCount: parts.length,
					partsExpected: first.concatenatedTotal
				});
			}
			return result;
		}

		function renderStorage() {
			storageEl.textContent = '存储：' + state.storage.used + ' / ' + state.storage.total;
		}

		function renderContacts() {
			contactList.innerHTML = '';
			if (!state.contacts.length) {
				contactList.appendChild(Mt5700.empty('暂无短信'));
			}
			for (var i = 0; i < state.contacts.length; i++) {
				var c = state.contacts[i];
				var item = E('div', {
					'class': 'mt5700-sms-item' + (c.number === state.selectedContact ? ' active' : '')
				});
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-number' }, c.number));
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, c.lastMessage || ''));
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, c.lastTime || ''));
				item.addEventListener('click', function (num) {
					return function () { selectContact(num); };
				}(c.number));
				contactList.appendChild(item);
			}
		}

		/*
		 * 单条消息气泡（含时间、长短信缺失提示与删除按钮）。
		 */
		function buildBubble(m, isSent) {
			var bubble = E('div', { 'class': 'mt5700-sms-bubble ' + (isSent ? 'mt5700-sms-bubble-sent' : 'mt5700-sms-bubble-recv') });
			bubble.appendChild(E('div', {}, m.content || '(空消息)'));
			/*
			 * 时间未知时如实显示「时间未知」：
			 * 空白会让人以为渲染丢了，直接不显示又会让人默认它是刚刚。
			 * 近似时间（来自 TP-VP 有效期）额外标注，避免被当成精确发送时刻。
			 */
			var timeText = m.time || '时间未知';
			if (m.time && m.timeApprox) timeText += '（有效期时间，非发送时刻）';
			bubble.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, timeText));
			if (m.partsExpected != null && m.partsCount != null && m.partsCount < m.partsExpected) {
				bubble.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' },
					'长短信已合并 ' + m.partsCount + '/' + m.partsExpected + ' 段（部分缺失）'));
			}
			var del = Mt5700.button('删除', function (mm) {
				return function () {
					Mt5700.confirm('确定删除该短信？', function () { deleteMessage(mm); });
				};
			}(m), 'danger');
			del.className = 'mt5700-btn mt5700-btn-danger mt5700-sms-del';
			bubble.appendChild(del);
			return bubble;
		}

		/*
		 * 会话分区：收到的在上、发出的在下，两块各自按时间升序。
		 *
		 * 为什么不是单条时间轴（用户明确要求「对面的消息和自己的消息不能挤在一起」）：
		 * 聊天式单轴的读法是「一条来一条回」交替出现，用来回顾对话很自然，
		 * 但「对方一共说了什么」「我到底回了哪些」这两个诉求要逐条翻。
		 * 分区之后两块各自连续，按时间一眼扫完，找起来是线性的。
		 * 代价是失去「来一回一」的对应关系 —— 所以保留了两块标题与各自条数，
		 * 需要看上下文时仍可对照时间戳。
		 */
		function appendSection(label, list, kind) {
			var section = E('div', { 'class': 'mt5700-sms-section mt5700-sms-section-' + kind });
			section.appendChild(E('div', { 'class': 'mt5700-sms-section-title' }, [
				E('span', {}, label),
				E('span', { 'class': 'mt5700-sms-section-count' }, list.length + ' 条')
			]));
			if (!list.length) {
				section.appendChild(E('div', { 'class': 'mt5700-sms-section-empty' },
					kind === 'recv' ? '该联系人还没有来消息' : '还没有发给该联系人的消息'));
			}
			for (var i = 0; i < list.length; i++) section.appendChild(buildBubble(list[i], kind === 'sent'));
			convBody.appendChild(section);
		}

		function renderConversation() {
			convHead.innerHTML = '';
			convHead.appendChild(E('div', { 'class': 'mt5700-sms-item-number' },
				state.selectedContact ? '与 ' + state.selectedContact + ' 的会话' : '请选择联系人'));
			convBody.innerHTML = '';
			if (!state.messages.length) {
				convBody.appendChild(Mt5700.empty('暂无消息，输入内容发送'));
				return;
			}
			var received = [];
			var sent = [];
			for (var i = 0; i < state.messages.length; i++) {
				(state.messages[i].type === 'sent' ? sent : received).push(state.messages[i]);
			}
			received.sort(compareAsc);
			sent.sort(compareAsc);
			appendSection('收到', received, 'recv');
			appendSection('发出', sent, 'sent');
			convBody.scrollTop = convBody.scrollHeight;
		}

		function renderHint() {
			var text = msgInput.value.trim();
			if (!text) { hintEl.textContent = ''; return; }
			var stats = SmsEncode.messageStats(text);
			var parts = stats.encoding === 'UCS2' ? '含中文等字符，按 UCS2 编码' : '纯 ASCII，按 GSM 7bit 编码';
			hintEl.textContent = stats.chars + ' 字 · ' + parts + (stats.parts > 1 ? ' · 将拆成 ' + stats.parts + ' 条' : '');
		}
		msgInput.addEventListener('input', renderHint);

		/* ---------- 数据 ---------- */

		function refreshStorage() {
			return AtWs.client.sendCommand('AT^CPMS?').then(function (res) {
				if (res.success && res.data) {
					/*
					 * 前缀必须同时接受 `+CPMS` 与 `^CPMS`：
					 * 请求用的是私有命令 `AT^CPMS?`，模组按惯例回 `^CPMS: "SM",<used>,<total>,...`，
					 * 只匹配 `\+CPMS` 会让存储用量永远停在 0 / 0（模拟环境下已复现）。
					 * 少数固件回标准 `+CPMS`，所以两种都要收。
					 */
					var m = String(res.data).match(/[\^+]CPMS: "\w+",(\d+),(\d+)/);
					if (m) {
						state.storage = { used: parseInt(m[1], 10), total: parseInt(m[2], 10) };
						renderStorage();
					}
				}
			}).catch(function () {});
		}

		function refresh() {
			return AtWs.client.sendCommand('AT+CMGL=4').then(function (res) {
				if (!res.success) {
					if (res.error && String(res.error).indexOf('CME ERROR') >= 0) {
						Mt5700.warning('短信功能可能未开启，请到「短信设置」开启');
					} else {
						Mt5700.error(String(res.error || '获取短信列表失败'));
					}
					return;
				}
				var raw = typeof res.data === 'string' ? res.data : '';
				var parsed = (raw && raw !== 'OK' && raw !== 'NO SMS') ? Parse.parseCMGL(raw) : [];
				/*
				 * 已发短信可能同时来自两处：模组存储（CMGL 返回的 SMS-SUBMIT PDU）
				 * 与浏览器缓存（localStorage）。解析器支持 SUBMIT 之后两边会撞车，
				 * 直接 concat 就会显示两条一样的已发消息，所以先去重。
				 */
				buildContacts(parsed.concat(dedupCachedSent(parsed, Parse.getCachedSentMessages())));
			}).catch(function () {
				Mt5700.error('获取短信列表失败');
			});
		}

		/*
		 * 单元格排序键：模组存储的序号。已发缓存用负数序号（-Date.now()），
		 * 数值越大表示越新，与模组序号无关但只用于「同一时刻」的兜底排序。
		 */
		function sortIndex(m) {
			return m && typeof m.index === 'number' ? m.index : 0;
		}

		/*
		 * 时间升序比较（会话内两种分区都用它）。
		 *
		 * 时间未知的消息一律排在最后 —— 界面会标注「时间未知」，
		 * 但绝不能把它们混在时间轴里：那会让「不知道什么时候收到的」
		 * 看起来像「最新收到的」。同一时刻（或都未知）用存储序号兜底，
		 * 保证同样的输入每次渲染顺序一致，列表不会来回跳。
		 */
		function compareAsc(a, b) {
			var ta = Parse.messageTimeMs(a.time);
			var tb = Parse.messageTimeMs(b.time);
			if (ta !== null && tb !== null) {
				if (ta !== tb) return ta - tb;
				return sortIndex(a) - sortIndex(b);
			}
			if (ta !== null) return -1;
			if (tb !== null) return 1;
			return sortIndex(a) - sortIndex(b);
		}

		/*
		 * 去掉「模组里已经有的」已发缓存副本。
		 *
		 * 判定：号码 + 正文相同，且两边都有时间时时间相差不超过 10 分钟。
		 * 模组是权威来源，冲突时丢缓存那份；模组那份没有时间时按号码+正文去重
		 * （此时无法用时间区分，宁可少一条缓存副本，也不让用户看到重复气泡）。
		 */
		function dedupCachedSent(modemList, cached) {
			function keyOf(m) { return normalizeNumber(m.number) + '|' + (m.content || ''); }
			var seen = {};
			for (var i = 0; i < modemList.length; i++) {
				if (modemList[i].type === 'sent') seen[keyOf(modemList[i])] = Parse.messageTimeMs(modemList[i].time);
			}
			return cached.filter(function (c) {
				var k = keyOf(c);
				if (!(k in seen)) return true;
				var tModem = seen[k];
				var tCached = Parse.messageTimeMs(c.time);
				if (tModem === null || tCached === null) return false;
				return Math.abs(tModem - tCached) > 10 * 60 * 1000;
			});
		}

		function buildContacts(list) {
			list = mergeConcatenated(list);
			var map = {};
			for (var i = 0; i < list.length; i++) {
				var msg = list[i];
				var num = normalizeNumber(msg.number);
				if (!num) continue;
				if (!map[num]) {
					map[num] = { number: num, lastMessage: msg.content, lastTime: msg.time, unreadCount: 0, messages: [] };
				}
				map[num].messages.push(msg);
			}
			var list2 = [];
			for (var key in map) {
				var c = map[key];
				c.messages.sort(compareAsc);
				/*
				 * 联系人列表里的「最近一条」取**时间最新**的那条，而不是数组末尾那条
				 * —— 排序把时间未知的消息放在了末尾，直接取末尾会拿错。
				 */
				var newest = null;
				for (var n = c.messages.length - 1; n >= 0; n--) {
					if (Parse.messageTimeMs(c.messages[n].time) !== null) { newest = c.messages[n]; break; }
				}
				if (!newest) newest = c.messages.length ? c.messages[c.messages.length - 1] : null;
				c.lastMessage = newest ? (newest.content || '') : '';
				c.lastTime = newest ? (newest.time || '') : '';
				list2.push(c);
			}
			/* 联系人按最近一次联系时间倒序；时间未知的沉底 */
			list2.sort(function (a, b) {
				var ta = Parse.messageTimeMs(a.lastTime);
				var tb = Parse.messageTimeMs(b.lastTime);
				if (ta !== null && tb !== null) return tb - ta;
				if (ta !== null) return -1;
				if (tb !== null) return 1;
				return 0;
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
			state.messages = [];
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

		/*
		 * 本机（浏览器）当前时间，用于给「刚发出去的消息」盖时间戳。
		 *
		 * 口径说明：这里用的是**浏览器所在终端的本地时间**，而插件后端
		 * （日志 / 推送 / 定时锁频）统一走设备系统时区（见 crate::localtime）。
		 * 日常使用中 LuCI 就在同一台设备所在的局域网内，两者一致；
		 * 若用异时区的电脑远程登录 LuCI，这条本地缓存的时间戳会按浏览器时区显示，
		 * 而从模组读到的收发短信时间始终以设备时区给出（PDU 时间戳原样保留）。
		 */
		function nowTimeStr() {
			var d = new Date();
			var pad = function (n) { return String(n).padStart(2, '0'); };
			return pad(d.getFullYear() % 100) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
				',' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
		}

		function send(explicitTarget) {
			var content = msgInput.value.trim();
			if (!content) { Mt5700.warning('请输入短信内容'); return; }
			var target = (explicitTarget || '').trim() || state.selectedContact || '';
			if (!target) { Mt5700.warning('请输入联系人号码'); return; }
			if (!Parse.isValidPhoneNumber(target)) { Mt5700.warning('请输入正确的 5-19 位手机号码'); return; }

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
				Mt5700.success('发送成功');
				refresh();
			}).catch(function (err) {
				Mt5700.error((err && err.message) || '发送失败');
			}).then(function () { sendBtn.disabled = false; });
		}

		/* ---------- 删除 ---------- */

		function deleteMessage(msg) {
			var storedIndices = (msg.partIndices && msg.partIndices.length)
				? msg.partIndices
				: (msg.index != null && msg.index >= 0 ? [msg.index] : []);
			if (storedIndices.length) {
				var chain = Promise.resolve();
				storedIndices.forEach(function (ix) {
					if (ix != null && ix >= 0) {
						chain = chain.then(function () { return AtWs.client.sendCommand('AT+CMGD=' + ix); });
					}
				});
				chain.then(function () { Mt5700.success('删除成功'); refresh(); })
					.catch(function () { Mt5700.error('删除失败'); });
			} else {
				// 缓存中的已发消息
				var updated = Parse.getCachedSentMessages().filter(function (m) { return m.index !== msg.index; });
				try { localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(updated)); } catch (e) {}
				Mt5700.success('删除成功');
				refresh();
			}
		}

		function batchDelete() {
			var mask = E('div', { 'class': 'mt5700-modal-mask' });
			var box = E('div', { 'class': 'mt5700-modal' });
			box.appendChild(E('div', { 'class': 'mt5700-modal-title' }, '批量删除短信'));
			var listEl = E('div', { 'class': 'mt5700-agree-list' });
			var checked = [];
			for (var i = 0; i < state.messages.length; i++) {
				var m = state.messages[i];
				var row = E('label', { 'class': 'mt5700-inline' });
				var chk = E('input', { type: 'checkbox' });
				(function (msg, cb) {
					cb.addEventListener('change', function () {
						var idx = checked.indexOf(msg);
						if (cb.checked && idx < 0) checked.push(msg);
						if (!cb.checked && idx >= 0) checked.splice(idx, 1);
					});
				})(m, chk);
				row.appendChild(chk);
				row.appendChild(E('span', { 'class': 'mt5700-hint' },
					(m.type === 'sent' ? '[发] ' : '[收] ') + (m.number || '') + '：' + (m.content || '').slice(0, 30)));
				listEl.appendChild(row);
			}
			if (!state.messages.length) listEl.appendChild(Mt5700.empty('当前会话没有可删除的短信'));
			var actions = E('div', { 'class': 'mt5700-modal-footer' });
			actions.appendChild(Mt5700.ghostButton('取消', function () {
				if (mask.parentNode) mask.parentNode.removeChild(mask);
			}));
			actions.appendChild(Mt5700.dangerButton('删除所选', function () {
				if (mask.parentNode) mask.parentNode.removeChild(mask);
				if (!checked.length) { Mt5700.warning('请先选择要删除的短信'); return; }
				var chain = Promise.resolve();
				checked.forEach(function (m) {
					var idxs = (m.partIndices && m.partIndices.length)
						? m.partIndices
						: (m.index != null && m.index >= 0 ? [m.index] : []);
					idxs.forEach(function (ix) {
						if (ix != null && ix >= 0) {
							chain = chain.then(function () { return AtWs.client.sendCommand('AT+CMGD=' + ix); });
						}
					});
				});
				chain.then(function () {
					var cachedIds = checked.filter(function (m) { return m.index < 0; }).map(function (m) { return m.index; });
					if (cachedIds.length) {
						var updated = Parse.getCachedSentMessages().filter(function (m) { return cachedIds.indexOf(m.index) < 0; });
						try { localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(updated)); } catch (e) {}
					}
					Mt5700.success('成功删除 ' + checked.length + ' 条短信');
					refresh();
				}).catch(function () { Mt5700.error('批量删除失败'); });
			}));
			box.appendChild(listEl);
			box.appendChild(actions);
			mask.appendChild(box);
			mask.addEventListener('click', function (e) {
				if (e.target === mask && mask.parentNode) mask.parentNode.removeChild(mask);
			});
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
				Mt5700.info('收到来自 ' + msg.number + ' 的新短信');
			}
		};
		AtWs.client.subscribe(newSmsHandler);

		self._dispose = function () { AtWs.client.unsubscribe(newSmsHandler); };

		/* ---------- 初始化 ---------- */

		Ui.startup(body, function () {
			refreshStorage();
			refresh();
		});

		renderStorage();
		renderContacts();
		renderConversation();

		return page;
	}
});
