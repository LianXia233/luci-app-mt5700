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
			/* 日期已由分隔条给出，气泡内只留时刻，
			   否则每条消息都把年月日重复一遍，读起来很吵 */
			var timeText = m.time ? (String(m.time).split(',')[1] || m.time) : '时间未知';
			if (m.time && m.timeApprox) timeText += '（有效期，非发送时刻）';
			bubble.appendChild(E('div', { 'class': 'mt5700-sms-time' }, timeText));
			if (m.partsExpected != null && m.partsCount != null && m.partsCount < m.partsExpected) {
				bubble.appendChild(E('div', { 'class': 'mt5700-sms-time' },
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
		 * 日期分隔条文案（`YY/MM/DD,HH:MM:SS` → `20YY-MM-DD`）。
		 *
		 * 无时刻的消息若借到了锚点位置，日期就用锚点那条的日期 —— 否则时间轴中间
		 * 会突然冒出一条「时间未知的消息」分隔，把一次来回劈成两半。真的连锚点都
		 * 没有（它排在最前）时，才单列一档如实说明。
		 */
		function dayLabel(m, keyOf) {
			var k = keyOf && keyOf[m];
			var timeStr = m.time || (k && k.anchorTime) || null;
			if (!timeStr) return '时间未知的消息';
			var day = String(timeStr).split(',')[0];
			var seg = day.split('/');
			if (seg.length === 3) return '20' + seg[0] + '-' + seg[1] + '-' + seg[2];
			return day;
		}

		/*
		 * 聊天式单条时间轴（用户要求「像 QQ 那样显示」）：
		 * 收发消息按时间顺序**混排在同一条轴上**，靠气泡左右位置区分方向 ——
		 * 对方在左、自己在右，跨天处插一条日期分隔条。
		 *
		 * 早期版本为了「对面的消息和自己的消息不能挤在一起」改成上下分区，
		 * 代价是丢失「来一回一」的对话对应关系；现按用户要求回到聊天式排布，
		 * 分区所需的块标题与空态一并去掉。
		 */
		function renderConversation() {
			convHead.innerHTML = '';
			convHead.appendChild(E('div', { 'class': 'mt5700-sms-item-number' },
				state.selectedContact ? '与 ' + state.selectedContact + ' 的会话' : '请选择联系人'));
			convBody.innerHTML = '';
			if (!state.messages.length) {
				convBody.appendChild(Mt5700.empty('暂无消息，输入内容发送'));
				return;
			}
			var ordered = conversationOrder(state.messages);
			var list = ordered.sorted;
			var lastDay = null;
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				var day = dayLabel(m, ordered.keyOf);
				if (day !== lastDay) {
					convBody.appendChild(E('div', { 'class': 'mt5700-sms-date' }, day));
					lastDay = day;
				}
				convBody.appendChild(buildBubble(m, m.type === 'sent'));
			}
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
			/*
			 * 必须用**标准** `AT+CPMS?`：本模组（MT5700M-CN）不认私有前缀的
			 * `AT^CPMS?`，实测直接回 ERROR，存储用量会永远停在 0 / 0。
			 * 同项目的「短信设置」页用的也是 `AT+CPMS?`，此处曾误写成 `^` 前缀。
			 */
			return AtWs.client.sendCommand('AT+CPMS?').then(function (res) {
				if (res.success && res.data) {
					/*
					 * 应答前缀两种都要收：标准 `+CPMS: "SM",<used>,<total>,...`，
					 * 少数固件（如 SIMCom 系）回私有 `^CPMS:`。只匹配 `\+CPMS`
					 * 会在那些固件上让用量永远停在 0 / 0。
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
				buildContacts(parsed.concat(mergeCachedSent(parsed, Parse.getCachedSentMessages())));
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
		 * 会话内排序。
		 *
		 * 时间轴成立的前提是每条消息都有时刻。收到短信没问题（PDU 的 TP-SCTS 一定
		 * 有），但**发出短信按 3GPP TS 23.040 就没有发送时刻**，只有 TP-VP 有效期 ——
		 * 模组存下来再读回去，时间是真的不知道。早先的实现把这类消息一律排到会话
		 * 末尾，后果是「对面两句挤在一起、自己那句跑到最后」，一次来回被打散，
		 * 看起来根本不像对话。
		 *
		 * 这里改为借**存储顺序**给它找位置：AT+CMGL 的序号就是存储先后，取该条
		 * 前面最近那条有确切时刻的消息的时刻作锚点，让它落在那个位置附近。
		 * 锚点只用于排序与日期分隔，气泡里照旧如实标「时间未知」——借位置，不伪造时刻。
		 *
		 * 返回 { sorted, keyOf }；keyOf 交给日期分隔条复用，免得「排序用的锚点」
		 * 与「显示的日期」各算一套、互相对不上。
		 */
		function conversationOrder(msgs) {
			var keyOf = {};
			var stored = [];
			for (var i = 0; i < msgs.length; i++) {
				if (msgs[i].index != null && msgs[i].index >= 0) stored.push(msgs[i]);
			}
			stored.sort(function (a, b) { return sortIndex(a) - sortIndex(b); });

			var anchorMs = null, anchorTime = null;
			for (var s = 0; s < stored.length; s++) {
				var t = Parse.messageTimeMs(stored[s].time);
				if (t !== null) { anchorMs = t; anchorTime = stored[s].time; }
				keyOf[stored[s]] = { ms: anchorMs, anchorTime: anchorTime, relaxed: t === null };
			}
			/* 缓存条目（index 为负）自带本机发送时刻，不参与存储顺序这条线索 */
			for (var j = 0; j < msgs.length; j++) {
				if (keyOf[msgs[j]]) continue;
				var tj = Parse.messageTimeMs(msgs[j].time);
				keyOf[msgs[j]] = { ms: tj, anchorTime: tj === null ? null : msgs[j].time, relaxed: tj === null };
			}

			var sorted = msgs.slice().sort(function (x, y) {
				var kx = keyOf[x], ky = keyOf[y];
				if (kx.ms !== ky.ms) {
					if (kx.ms === null) return -1;      /* 连锚点都没有 → 排最前 */
					if (ky.ms === null) return 1;
					return kx.ms - ky.ms;
				}
				/* 同一位置：有确切时刻的在前，借位置的紧随其后 */
				if (kx.relaxed !== ky.relaxed) return kx.relaxed ? 1 : -1;
				return sortIndex(x) - sortIndex(y);
			});
			return { sorted: sorted, keyOf: keyOf };
		}

		/*
		 * 把浏览器缓存里的「已发」记录与模组返回的合并（同一条则去重）。
		 *
		 * 判定：号码 + 正文相同即视为同一条；两边都有时间时，还要求时间相差不超过
		 * 10 分钟（否则只是内容恰好相同的另一条短信）。
		 *
		 * 关键点：模组存回来的 SMS-SUBMIT 按规范**不含发送时刻**，只有 TP-VP 有效期，
		 * 而缓存那条是本机发送当时打的时间戳 —— **缓存那条才是唯一带准确时间的**。
		 * 早先的实现在去重时保留模组那份、丢掉缓存那份，等于把唯一的时间信息一并
		 * 扔了，于是自己发的消息全部变成「时间未知」并沉到会话末尾。现在改为反向
		 * 吸收：把缓存的时间戳补给模组那条。模组的 index 仍然保留 —— 删除要走
		 * AT+CMGD，不能换成缓存的负数 index。
		 */
		function mergeCachedSent(modemList, cached) {
			function keyOf(m) { return normalizeNumber(m.number) + '|' + (m.content || ''); }
			/*
			 * 同一个「号码+正文」在模组里可能有不止一条（同内容重复发送），
			 * 所以按 key 分桶后用游标逐条配对，避免一条缓存把多条模组记录都
			 * 当成自己的副本而误消。
			 */
			var buckets = {};
			for (var i = 0; i < modemList.length; i++) {
				var m = modemList[i];
				if (m.type !== 'sent') continue;
				var k = keyOf(m);
				if (!buckets[k]) buckets[k] = [];
				buckets[k].push(m);
			}

			var cursor = {};
			return cached.filter(function (c) {
				var k = keyOf(c);
				var arr = buckets[k];
				if (!arr) return true;              /* 模组里没有 → 缓存这条独立保留 */

				var tCached = Parse.messageTimeMs(c.time);
				for (var i = cursor[k] || 0; i < arr.length; i++) {
					var tModem = Parse.messageTimeMs(arr[i].time);
					if (tModem !== null && !(tCached !== null && Math.abs(tModem - tCached) <= 10 * 60 * 1000)) {
						continue;                   /* 两边都有时间且差得远 → 是另一条 */
					}
					if (tModem === null && tCached !== null) {
						/*
						 * 模组那条没有时刻，把本机记录的时刻补上 ——
						 * 这是这条消息唯一的准确时间来源。
						 */
						arr[i].time = c.time;
						arr[i].timeApprox = false;
					}
					cursor[k] = i + 1;
					return false;                   /* 缓存这条已被模组记录吸收 */
				}
				return true;
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
				c.messages = conversationOrder(c.messages).sorted;
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
