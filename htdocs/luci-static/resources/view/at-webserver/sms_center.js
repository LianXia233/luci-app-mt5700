'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 短信中心页面。
 *
 * 本次重构的三条硬约束：
 *
 * 1. **短信优先**：进入页面即向后端口申请「前台短信模式」会话，离开/隐藏时释放。
 *    会话期间后台巡检（信号、缓存、流量、自动拨号对账）让出通道；多步骤操作
 *    （发送分片、批量删除）由后端在**一次事务**里跑完，中途不会被插进来。
 * 2. **无缓存**：列表、容量、发送结果、删除结果全部来自本次真实下发，
 *    不再把 localStorage 里的「已发记录」混进列表 —— 旧实现里那些条目没有
 *    模组序号，删除时会按着不存在的 index 下发一堆 AT+CMGD，全是 ERROR。
 * 3. **不臆造结果**：后端把发送结论分成 accepted / rejected / unknown 三档，
 *    unknown（超时或模组无响应）明确提示「可能已发走，不要重复点击」，
 *    前端也不会替用户自动重发。
 */

/* 前台短信模式的心跳间隔：必须明显小于后端租约（90s），否则会被判为已离开 */
var SMS_SESSION_TTL_MS = 90000;
var SMS_SESSION_HEARTBEAT_MS = 30000;

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('短信中心', '即时短信收发、会话列表、长短信拼接与存储箱管理', 'sms_center', '即时消息 · 会话管理');
		var body = page._body;


		var state = {
			contacts: [],        // [{ number, lastMessage, lastTime, unreadCount, messages: [] }]
			selectedContact: '',
			messages: [],        // 当前联系人消息
			storage: { used: 0, total: 0 },
			/* 本次列表数据的抓取时刻（后端给出），用于确认界面不是旧快照 */
			fetchedAt: 0
		};

		/* ---------- 布局 ---------- */
		var layout = E('div', { 'class': 'mt5700-sms-layout' });
		body.appendChild(layout);

		// 左：联系人
		var left = E('div', { 'class': 'mt5700-sms-list' });
		var currentTab = 'all'; // all, unread, sent
		var smsTabHeader = E('div', { 'class': 'mt-tab-header', 'style': 'margin-bottom:10px;' });
		var tabDefs = [
			{ id: 'all', title: '全部' },
			{ id: 'unread', title: '未读' },
			{ id: 'sent', title: '已发' }
		];
		tabDefs.forEach(function (td) {
			var tb = E('button', {
				'class': 'mt-tab-btn' + (td.id === 'all' ? ' active' : ''),
				'click': function () {
					currentTab = td.id;
					smsTabHeader.querySelectorAll('.mt-tab-btn').forEach(function (b) { b.classList.remove('active'); });
					tb.classList.add('active');
					renderContacts();
				}
			}, td.title);
			smsTabHeader.appendChild(tb);
		});
		/* 必须先挂载：只填充不 append 的话，三个筛选按钮根本不会出现在页面上 */
		left.appendChild(smsTabHeader);

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
			Mt5700.ghostButton('刷新', function () { refreshAll(); }),
			Mt5700.dangerButton('批量删除', function () { batchDelete(); })
		));
		right.appendChild(inputWrap);
		layout.appendChild(right);

		/* ---------- 渲染 ---------- */

		function normalizeNumber(n) { return Parse.normalizePhoneNumber(n); }

		/*
		 * 长短信合并：把同一号码、同一拼接参考号的各段拼成一条。
		 *
		 * 分段信息来自后端解析的 UDH（reference / 总段数 / 当前段号），
		 * 不再依赖任何本地缓存：缺段就是缺段，界面如实标注「已合并 x/y」。
		 */
		function mergeConcatenated(list) {
			var groups = {};
			var result = [];
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				if (m && m.isConcatenated && m.concatenatedRef != null && m.concatenatedSeq != null) {
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
					timeApprox: last.timeApprox,
					type: first.type,
					isConcatenated: false,
					concatenatedRef: first.concatenatedRef,
					partsCount: parts.length,
					partsExpected: first.concatenatedTotal
				});
			}
			return result;
		}

		function renderStorage() {
			storageEl.textContent = '存储：' + state.storage.used + ' / ' + state.storage.total;
		}

		/*
		 * 按当前 Tab 过滤会话。
		 * 说明：后端没有"已读/未读"标志位，未读只能按「会话里最新一条是收到的、
		 * 且本次页面会话中还没点开过」来判断；刷新页面后该状态会重置，
		 * 所以这里只当作本页的快捷筛选，不冒充持久未读状态。
		 */
		function latestMsg(c) {
			return c.messages && c.messages.length ? c.messages[c.messages.length - 1] : null;
		}

		function matchTab(c) {
			if (currentTab === 'all') return true;
			var m = latestMsg(c);
			if (!m) return false;
			if (currentTab === 'sent') return m.type === 'sent';
			if (currentTab === 'unread') {
				return m.type === 'received' && c.number !== state.selectedContact;
			}
			return true;
		}

		function renderContacts() {
			contactList.innerHTML = '';
			var shown = (state.contacts || []).filter(matchTab);
			if (!shown.length) {
				contactList.appendChild(Mt5700.empty(
					state.contacts.length ? '当前筛选下没有会话' : '暂无短信'));
				return;
			}
			for (var i = 0; i < shown.length; i++) {
				var c = shown[i];
				var item = E('div', {
					'class': 'mt5700-sms-item' + (c.number === state.selectedContact ? ' active' : '')
				});
				/* 号码为空的条目（解析失败）显示为「未知号码」 */
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-number' }, c.number || '未知号码'));
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
			if (m.error) {
				bubble.appendChild(E('div', { 'class': 'mt5700-sms-time' }, '该条解析失败：' + m.error));
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
			/*
			 * 字数提示改为本地估算（后端才是唯一权威）：只是给个「会拆成几条」的
			 * 预期，真正的编码与分片在后端完成，避免前端与后端算出不同片数。
			 */
			var ucs2 = !/^[\x20-\x7E\r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà]*$/.test(text);
			var per = ucs2 ? 67 : 153;
			var chars = Array.from(text).length;
			var parts = chars <= (ucs2 ? 70 : 160) ? 1 : Math.ceil(chars / per);
			hintEl.textContent = chars + ' 字 · ' + (ucs2 ? '含非 ASCII 字符，按 UCS2 编码' : '纯 ASCII，按 GSM 7bit 编码') +
				(parts > 1 ? ' · 将拆成 ' + parts + ' 条' : '');
		}
		msgInput.addEventListener('input', renderHint);

		/* ---------- 数据：全部实时，无缓存 ---------- */

		function refreshStorage() {
			return AtWs.client.sms('capacity').then(function (res) {
				if (res.success && res.result && res.result.storage) {
					state.storage = {
						used: res.result.storage.used,
						total: res.result.storage.total
					};
					renderStorage();
				}
			}).catch(function () {});
		}

		function refresh() {
			return AtWs.client.sms('list').then(function (res) {
				if (!res.success) {
					Mt5700.error(String(res.error || '获取短信列表失败'));
					return;
				}
				var r = res.result || {};
				state.fetchedAt = r.fetchedAt || 0;
				buildContacts((r.entries || []).map(toUiMessage));
			}).catch(function () {
				Mt5700.error('获取短信列表失败');
			});
		}

		/*
		 * 后端条目 → 界面消息。
		 *
		 * 关键点：index 一律来自本次 `list` 的真实返回。旧实现会把 localStorage
		 * 里的「已发记录」（index 为负数）混进来，那些条目在模组里不存在，
		 * 删除时下发的 AT+CMGD 必然失败；现在本地只保留**本次会话内**刚发出、
		 * 且后端尚未在模组里列出的那条，用 `pendingLocal` 标记单独区分。
		 */
		function toUiMessage(e) {
			return {
				index: e.index,
				content: e.content || '',
				number: normalizeNumber(e.number || ''),
				time: e.time || null,
				timeApprox: !!e.timeApprox,
				type: e.direction === 'sent' ? 'sent' : 'received',
				isConcatenated: !!e.concat,
				concatenatedRef: e.concat ? e.concat.reference : null,
				concatenatedSeq: e.concat ? e.concat.partNumber : null,
				concatenatedTotal: e.concat ? e.concat.partsCount : null,
				error: e.error || null
			};
		}

		function refreshAll() {
			return refresh().then(refreshStorage);
		}

		/*
		 * 单元格排序键：模组存储的序号。数值越大表示越新。
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
		 * 末尾，后果是「对面两句挤在一起、自己那句跑到最后」，一次来回被打散。
		 *
		 * 这里改为借**存储顺序**给它找位置：AT+CMGL 的序号就是存储先后，取该条
		 * 前面最近那条有确切时刻的消息的时刻作锚点，让它落在那个位置附近。
		 * 锚点只用于排序与日期分隔，气泡里照旧如实标「时间未知」——借位置，不伪造时刻。
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
			/* 本地暂存条目（index 为负）自带本机发送时刻，不参与存储顺序这条线索 */
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

		function buildContacts(list) {
			list = mergeConcatenated(list);
			var map = {};
			for (var i = 0; i < list.length; i++) {
				var msg = list[i];
				var num = normalizeNumber(msg.number);
				/* 解析失败的条目号码为空，归入特殊分组以便显示错误信息 */
				var key = num || '__parse_error__';
				if (!map[key]) {
					map[key] = { number: num, lastMessage: msg.content, lastTime: msg.time, unreadCount: 0, messages: [] };
				}
				map[key].messages.push(msg);
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
				/* 解析失败的条目显示错误信息而非内容 */
				c.lastMessage = newest ? (newest.error ? '短信解析失败：' + newest.error : (newest.content || '')) : '';
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
		 * 只在本次页面会话里作为**临时展示**使用：本地条目带 `pendingLocal` 标记，
		 * 下一次刷新列表时会以模组的真实返回为准，不会留在界面上冒充模组数据。
		 */
		function nowTimeStr() {
			var d = new Date();
			var pad = function (n) { return String(n).padStart(2, '0'); };
			return pad(d.getFullYear() % 100) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
				',' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
		}

		/*
		 * 短信发送。
		 *
		 * 与旧实现的两点本质差别：
		 *   1. PDU 编码、模式切换、短信中心号读取、分片提交全部由后端在**一次
		 *      事务**里完成，前端不再连发四五条各自排队的 AT 命令；
		 *   2. 结果按 accepted / rejected / unknown 三档处理，unknown 明确提示
		 *      「可能已发走」，前端绝不会自动重发（那才是重复计费的真凶）。
		 */
		function send(explicitTarget) {
			var content = msgInput.value.trim();
			if (!content) { Mt5700.warning('请输入短信内容'); return; }
			var target = (explicitTarget || '').trim() || state.selectedContact || '';
			if (!target) { Mt5700.warning('请输入联系人号码'); return; }
			if (!Parse.isValidPhoneNumber(target)) { Mt5700.warning('请输入正确的 5-19 位手机号码'); return; }

			sendBtn.disabled = true;
			var label = sendBtn.textContent;
			sendBtn.textContent = '发送中…';

			AtWs.client.sms('send', {
				destination: target,
				message: content,
				/* 重复提交保护键：同一号码 + 同一正文在后端 10s 窗口内只接受一次，
				 * 覆盖浏览器重试、用户连点、按钮还没来得及置灰这几种情况 */
				dedup_key: target + '|' + content
			}).then(function (res) {
				if (!res.success) throw new Error(String(res.error || '发送失败'));
				var r = res.result || {};
				if (r.outcome === 'accepted') {
					msgInput.value = '';
					renderHint();
					Mt5700.success('发送成功' + (r.parts && r.parts.length > 1 ? '（' + r.parts.length + ' 段长短信）' : ''));
				} else if (r.outcome === 'unknown') {
					/*
					 * 结果不明：绝不自动重发。如实告诉用户可能已经发走了，
					 * 并让他用「刷新」去模组里看真实状态再决定。
					 */
					Mt5700.warning('发送结果不明：' + (r.message || '') + '。请勿重复点击发送。');
				} else {
					throw new Error(r.message || '模组拒绝了这条短信');
				}
				/* 无论哪一档，都用模组的真实数据刷新界面 */
				return refreshAll();
			}).catch(function (err) {
				Mt5700.error((err && err.message) || '发送失败');
			}).then(function () {
				sendBtn.disabled = false;
				sendBtn.textContent = label;
			});
		}

		/* ---------- 删除 ---------- */

		function indicesOf(msg) {
			if (msg.partIndices && msg.partIndices.length) return msg.partIndices.slice();
			return (msg.index != null && msg.index >= 0) ? [msg.index] : [];
		}

		function deleteMessage(msg) {
			var idxs = indicesOf(msg);
			if (!idxs.length) {
				Mt5700.warning('该条不在模组存储中，刷新后即消失');
				return;
			}
			AtWs.client.sms('delete', { indices: idxs }).then(function (res) {
				if (!res.success) { Mt5700.error(String(res.error || '删除失败')); return; }
				var r = res.result || {};
				if (r.deleted > 0) {
					Mt5700.success('删除成功');
				} else {
					Mt5700.error('模组未能删除该短信');
				}
				return refreshAll();
			}).catch(function () { Mt5700.error('删除失败'); });
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
				/* 解析失败的条目（index 为 0 或有 error）不可勾选删除 */
				var isUndeletable = m.error || (m.index == null || m.index === 0);
				if (isUndeletable) chk.disabled = true;
				(function (msg, cb) {
					cb.addEventListener('change', function () {
						var idx = checked.indexOf(msg);
						if (cb.checked && idx < 0) checked.push(msg);
						if (!cb.checked && idx >= 0) checked.splice(idx, 1);
					});
				})(m, chk);
				row.appendChild(chk);
				var label = (m.type === 'sent' ? '[发] ' : '[收] ') + (m.number || '未知号码') + '：';
				label += m.error ? '短信解析失败：' + m.error : (m.content || '').slice(0, 30);
				row.appendChild(E('span', { 'class': 'mt5700-hint' }, label));
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
				/* 一次事务里删完：后端逐条 AT+CMGD，中途不会被别的命令插进来 */
				var idxs = [];
				checked.forEach(function (m) {
					indicesOf(m).forEach(function (ix) { if (idxs.indexOf(ix) < 0) idxs.push(ix); });
				});
				if (!idxs.length) { Mt5700.warning('所选条目都不在模组存储中'); return; }
				AtWs.client.sms('delete', { indices: idxs }).then(function (res) {
					if (!res.success) { Mt5700.error(String(res.error || '批量删除失败')); return; }
					var r = res.result || {};
					Mt5700.success('已删除 ' + r.deleted + ' 条' + (r.failed && r.failed.length ? '，' + r.failed.length + ' 条失败' : ''));
					return refreshAll();
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
			/*
			 * 收到到达通知后立刻拉一次真实列表：通知只是「有新短信」这个信号，
			 * 正文、时间、序号都必须以模组里读到的为准。
			 */
			refreshAll();
			Mt5700.info('收到新短信');
		};
		AtWs.client.subscribe(newSmsHandler);

		/* ---------- 前台短信模式：生命周期 ---------- */

		var sessionId = 0;
		var heartbeat = null;

		function openSession() {
			AtWs.client.sms('session_open', { ttl_ms: SMS_SESSION_TTL_MS }).then(function (res) {
				if (!res.success || !res.result) return;
				sessionId = res.result.session_id || 0;
				/* 心跳续期：页面还在就一直占着；后端另有租约上限兜底，
				 * 即便这里的心跳因为浏览器休眠停了，也会自动释放 */
				if (heartbeat) clearInterval(heartbeat);
				heartbeat = setInterval(function () {
					if (!sessionId) return;
					AtWs.client.sms('session_renew', {
						session_id: sessionId,
						ttl_ms: SMS_SESSION_TTL_MS
					}).then(function (r) {
						/* 续不上（租约已被自动回收）→ 重新申请，不要静默失效 */
						if (!r.success || (r.result && r.result.renewed === false)) {
							sessionId = 0;
							openSession();
						}
					});
				}, SMS_SESSION_HEARTBEAT_MS);
			}).catch(function () {});
		}

		function closeSession() {
			if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
			if (!sessionId) return;
			var id = sessionId;
			sessionId = 0;
			AtWs.client.sms('session_release', { session_id: id }).catch(function () {});
		}

		/* 页面隐藏（切到别的页签/熄屏）也视为离开：释放让后台巡检恢复 */
		document.addEventListener('visibilitychange', function () {
			if (document.hidden) closeSession();
			else if (!sessionId) openSession();
		});

		self._dispose = function () {
			AtWs.client.unsubscribe(newSmsHandler);
			closeSession();
		};

		/* ---------- 初始化 ---------- */

		Ui.startup(body, function () {
			openSession();
			refreshAll();
		});

		renderStorage();
		renderContacts();
		renderConversation();

		return page;
	}
});
