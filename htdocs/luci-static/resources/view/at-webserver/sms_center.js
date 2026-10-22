'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/smsEncode';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, SmsEncode, Mt5700 */

/**
 * 短信中心 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * - 联系人聚合（按号码分组，按最后消息时间排序）
 * - 会话视图（聊天样式）、发送（自动编码 PDU + 长短信分片）
 * - 新短信推送实时更新（new_sms）
 * - 单条删除 / 批量删除、存储量显示
 * - 已发记录保存在**设备上**（/etc/mt5700/sms-sent.json），换浏览器也看得到
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('短信中心', '收发短信与联系人会话');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var state = {
			contacts: [],        // [{ number, lastMessage, lastTime, unreadCount, messages: [] }]
			selectedContact: '',
			messages: [],        // 当前联系人消息
			storage: { used: 0, total: 0 },
			receivedCount: 0
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

		/* ---------- 未读标记 ---------- */
		/*
		 * 为什么不能只依赖模组的状态位：鼎桥 AT 手册 9.8 / 9.10 写明，本模组的
		 * +CMGL 与 +CMGR 读取成功后都会把「收到的未读短信」置为「已读」。
		 * 而服务端收到 +CMTI 后会立刻 AT+CMGR 取内容用于通知，前端每次刷新又是一次
		 * AT+CMGL=4 —— 短信往往还没等用户看到，状态就已经被读成「已读」了。
		 * 实测也印证：真机 17 条短信的 <stat> 全是 1，一条未读都没有。
		 *
		 * 所以这里以「号码」为键自行记录未读，两个来源取并集：
		 *   A. 新短信推送：短信刚到达、用户还没点开，必然是未读；
		 *   B. 列表里仍带着未读状态（<stat>=0）的短信：服务未运行期间到达的情形。
		 *
		 * 用号码而不是 index 做键：短信删除后存储位置会被复用，用 index 会张冠李戴。
		 */
		var UNREAD_KEY = 'mt5700_sms_unread_numbers';
		var unreadNumbers = (function () {
			try {
				var arr = JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]');
				if (!Array.isArray(arr)) return [];
				/*
				 * ★ 2026-09-28 加归一化 + 去重（自愈）。
				 *
				 * 这里原来只过滤 `typeof x === 'string'`，把**原样的字符串**收进名单。
				 * 而下面 markUnread / clearUnread / isUnread 一律用
				 * `Parse.normalizePhoneNumber()` 的结果做键 —— 两者形态不一致时，
				 * `indexOf` 会返回 -1：
				 *   · isUnread() 查不到 → 该号码的未读徽章「时有时无」；
				 *   · clearUnread() 里 `if (i >= 0)` 不成立 → **localStorage 不写**，
				 *     但函数后半段的内存清理是**无条件**执行的（见那里的注释）。
				 *     于是当场看着清了、刷新后从 localStorage 重读又冒出来。
				 * 名单是跨版本持久化的（键名一直没变），历史数据里出现非归一化号码
				 * 完全可能，所以这里在读取时就地收敛，而不是等某个分支去兜。
				 */
				var out = [];
				for (var i = 0; i < arr.length; i++) {
					if (typeof arr[i] !== 'string') continue;
					var n = normalizeNumber(arr[i]);
					if (n && out.indexOf(n) < 0) out.push(n);
				}
				return out;
			} catch (e) { return []; }
		})();

		function saveUnread() {
			try { localStorage.setItem(UNREAD_KEY, JSON.stringify(unreadNumbers.slice(-200))); } catch (e) {}
		}

		function markUnread(num) {
			num = normalizeNumber(num || '');
			if (!num || unreadNumbers.indexOf(num) >= 0) return;
			unreadNumbers.push(num);
			saveUnread();
		}

		function clearUnread(num) {
			num = normalizeNumber(num || '');
			var i = unreadNumbers.indexOf(num);
			if (i >= 0) unreadNumbers.splice(i, 1);
			/*
			 * ★ 2026-09-28：原来 saveUnread() 写在 `if (i >= 0)` 里面，而下面的内存清理
			 *   （msg.unread / c.unreadCount / c.unread）是**无条件**的。这个不对称会在
			 *   `i === -1` 时留下一份「内存已清、localStorage 未清」的状态：
			 *   徽章当场消失（内存生效），刷新页面后从 localStorage 重读又回来 ——
			 *   用户报的就是这个现象（"点了会话，徽章当场消失，但刷新页面后又出现"）。
			 *   现在无条件落盘：即使这次没在名单里找到，也把当前名单写回去，
			 *   保证存储与内存始终一致。读取侧同时还做了归一化自愈（见上面）。
			 */
			saveUnread();
			/* clearUnread 不盖水位线：调用方含 buildContacts 的名单收敛（用户并没读） */
			/*
			 * 同时清掉内存里这些短信自带的未读标记。否则同一次会话内再调
			 * buildContacts 时，来源 B 会依据仍是 true 的 msg.unread 把它们标回未读，
			 * 表现为「点开了，未读徽章却又冒出来」。
			 */
			for (var ci = 0; ci < state.contacts.length; ci++) {
				if (state.contacts[ci].number !== num) continue;
				var c = state.contacts[ci];
				var msgs = c.messages;
				for (var mi = 0; mi < msgs.length; mi++) msgs[mi].unread = false;
				/*
				 * 会话自己缓存的未读数也要一起清零。renderContacts 读的是 c.unread，
				 * 它是 buildContacts 时算好的；只清名单和 msg.unread 的话，
				 * 徽章会一直留在屏幕上（真机实测到过：名单已空，徽章还在）。
				 */
				c.unreadCount = 0;
				c.unread = false;
			}
		}

		function isUnread(num) {
			return unreadNumbers.indexOf(normalizeNumber(num || '')) >= 0;
		}

		/* ---------- 已读水位线（2026-09-30，真机探针定位后新增）----------
		 *
		 * 为什么需要它：真机探针（[DEBUG-7f3a]）抓到的调用栈显示，每次**页面加载**都会重放旧的
		 * `+CMTI` 推送 → `newSmsHandler` 把那条**早已读过**的消息标成 `unread = true` →
		 * `buildContacts` 依此算出「未读 1」→ 徽章复现。而设备审计同时显示 `+CPMS` 未变、
		 * `AT+CMGL=0` 为空（模组侧没有任何未读）—— 即未读完全是前端被推送重放"唤醒"的。
		 *
		 * 为什么不能只治推送路径：`unread` 这个标志会被三条路径碰到（推送重放、列表解析、
		 * 内存缓存）。只堵一条必然漏。水位线把判定收敛成一句**与来源无关**的规则：
		 *   用户读过某会话的时刻之前到达的消息，永远算已读。
		 * 这样无论谁把 `unread` 置上，旧消息都不会再变成未读；而**真正新到**的（晚于水位线）
		 * 依旧显示未读 —— 不会把新短信吞掉（tests/sms-unread-refresh-loop.test.js 场景①②守着）。
		 */
		var READ_UPTO_KEY = 'mt5700_sms_read_upto';
		var readUptoMap = (function () {
			try {
				var m = JSON.parse(localStorage.getItem(READ_UPTO_KEY) || '{}');
				return (m && typeof m === 'object') ? m : {};
			} catch (e) { return {}; }
		})();

		function readUptoOf(num) {
			return readUptoMap[normalizeNumber(num || '')] || 0;
		}

		function markReadUpto(num) {
			var n = normalizeNumber(num || '');
			if (!n) return;
			readUptoMap[n] = Date.now();
			try { localStorage.setItem(READ_UPTO_KEY, JSON.stringify(readUptoMap)); } catch (e) {}
		}

		/* 与来源无关的未读判定：只有「未读标志 + 晚于水位线」才算未读 */
		function isMsgUnread(c, m) {
			if (!m || !m.unread) return false;
			/* ★ B13（2026-10-22 审计）：strict 模式下解析失败返回 null —— 原先
			 * parseMessageTime 恒回落「当前时刻」，`if (!t)` 是死分支，而回落值
			 * 每次都领先于水位线，这条路的会话成了「点开也消不掉」的幻影未读。
			 * 解析不出来就不参与未读判定：不冒未读，也不会堵死消红点。 */
			var t = Parse.parseMessageTime(m.time, true);
			if (!t) return false;
			return !(readUptoOf(c && c.number) >= t.getTime());
		}

		/*
		 * 该会话是否还有"晚于已读水位线"的消息 —— 号码级信号是否仍然有效。
		 * messages 为空时也算 true：那是"推送已到、列表未刷新"的真未读。
		 * 单独提成函数，便于诊断回路抽取（tests/sms-unread-refresh-loop.test.js 场景③）。
		 */
		function hasMsgNewerThanRead(c) {
			if (!c || !c.messages || c.messages.length === 0) return true;
			for (var i = 0; i < c.messages.length; i++) {
				var t = Parse.parseMessageTime(c.messages[i].time);
				if (t && t.getTime() > readUptoOf(c.number)) return true;
			}
			return false;
		}

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
				/*
				 * 未读状态按「任一分段未读即未读」归并：parseCMGL 会给每段单独置
				 * unread（<stat>=0），合并后不继承的话，服务停止期间到达的长短信
				 * 永远进不了未读统计（buildContacts 的来源 B 只读 msg.unread）。
				 */
				var anyUnread = false;
				for (var u = 0; u < parts.length; u++) if (parts[u].unread) anyUnread = true;
				/*
				 * 分段没到齐：这只是一个「读取时机偏早」的中间态，不是真的缺段。
				 * 标出来给两处消费 ——① 安排一次延迟重拉补齐；② 服务端拼完整推送
				 * 过来时把这条剔掉。不标记就会出现「残缺版 + 完整版」两条并排。
				 */
				var incomplete = first.concatenatedTotal != null && parts.length < first.concatenatedTotal;
				result.push({
					index: first.index,
					partIndices: idxs,
					content: full,
					number: first.number,
					time: last.time,
					type: 'received',
					unread: anyUnread,
					isConcatenated: false,
					concatenatedRef: first.concatenatedRef,
					concatenatedTotal: undefined,
					concatenatedSeq: undefined,
					partsCount: parts.length,
					partsExpected: first.concatenatedTotal,
					partialPending: incomplete
				});
			}
			return result;
		}

		function renderStorage() {
			var used = state.storage.used;
			var total = state.storage.total;
			var txt = '存储：';
			if (state.receivedCount > 0) txt += '收到 ' + state.receivedCount + ' 条 · ';
			txt += '占用 ' + used + ' / ' + total;
			/*
			 * 存满之后模组收不下新短信（会回 +CMS ERROR: 322 / ^SMMEMFULL，
			 * 后端 urc.rs 已识别并推送通知）。这里提前在界面上给个可见的提醒，
			 * 别等真收不到短信了才知道。
			 */
			if (total > 0 && used >= total) txt += '（已满，新短信收不到）';
			else if (total > 0 && used / total >= 0.9) txt += '（将满）';
			storageEl.textContent = txt;
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
				var numEl = E('div', { 'class': 'mt5700-sms-item-number' }, c.number);
				if (c.unread) {
					numEl.appendChild(document.createTextNode(' '));
					/*
					 * 未读取 danger（红）而不是 info（蓝）：蓝底在这套配色里和状态标签
					 * 容易混，而「有没看过的短信」是要一眼看见的那类信息。
					 */
					numEl.appendChild(Mt5700.badge(
						c.unreadCount > 1 ? ('未读 ' + c.unreadCount) : '未读', 'danger'));
				}
				item.appendChild(numEl);
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, c.lastMessage || ''));
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, c.lastTime || ''));
				item.addEventListener('click', function (num) {
					return function () { selectContact(num); };
				}(c.number));
				contactList.appendChild(item);
			}
		}

		function renderConversation() {
			/*
			 * ★ 2026-09-30：会话被**显示**就视为已读，不再只认"点击左侧联系人行"。
			 *   原先只有 selectContact（联系人行的点击回调）会 clearUnread，于是：
			 *     · 刷新后自动恢复上次会话、或会话本就处于打开状态时，用户明明读了内容，
			 *       号码却一直留在未读名单里；
			 *     · 名单里那条又通过下面的 unreadCount 回退显示成"未读 1"，刷新也不会消。
			 *   真机复现（2026-09-30）：10086 的【订购成功提醒】全文已被用户读过，仍显示未读。
			 *   clearUnread 是幂等的（名单里没有时只多做一次落盘），放在渲染入口无副作用。
			 */
			if (state.selectedContact) {
				clearUnread(state.selectedContact);
				/* ★ 水位线只在这里盖章：会话被显示 == 用户读到了 */
				markReadUpto(state.selectedContact);
			}
			convHead.innerHTML = '';
			convHead.appendChild(E('div', { 'class': 'mt5700-sms-item-number' },
				state.selectedContact ? '与 ' + state.selectedContact + ' 的会话' : '请选择联系人'));
			convBody.innerHTML = '';
			if (!state.messages.length) {
				convBody.appendChild(Mt5700.empty('暂无消息，输入内容发送'));
			}
			for (var i = 0; i < state.messages.length; i++) {
				var m = state.messages[i];
				var isSent = m.type === 'sent';
				var bubble = E('div', { 'class': 'mt5700-sms-bubble ' + (isSent ? 'mt5700-sms-bubble-sent' : 'mt5700-sms-bubble-recv') });
				bubble.appendChild(E('div', {}, m.content || '(空消息)'));
				/*
				 * 未读标记挂到具体那一条上。此前只有左侧联系人列表有个总数，
				 * 打开会话后看不出哪几条是新的。
				 */
				var meta = E('div', { 'class': 'mt5700-sms-item-preview' }, m.time || '');
				if (m.unread) {
					meta.appendChild(document.createTextNode(' '));
					meta.appendChild(Mt5700.badge('未读', 'danger'));
				}
				bubble.appendChild(meta);
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
				convBody.appendChild(bubble);
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
			/* 注意：命令是 AT+CPMS?（标准 3GPP）。此前误写成 AT^CPMS?，
			   而本模组并不支持 ^CPMS，导致短信存储用量一直是空的。 */
			return AtWs.client.sendCommand('AT+CPMS?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CPMS: "\w+",(\d+),(\d+)/);
					if (m) {
						state.storage = { used: parseInt(m[1], 10), total: parseInt(m[2], 10) };
						renderStorage();
					}
				}
				/* 只读探测失败：界面保持「—」或原值，下一轮刷新会再试；不弹错是因为一次查询失败不值得打断用户操作 */
			}).catch(function () {});
		}

		/*
		 * 长短信是逐段到达的，若在片段到齐前读取列表就会拼出一条残缺消息。
		 * 这里给它一次自愈机会：延迟 1.5s 重拉一次，最多 2 次。
		 * 只在确实存在残缺时才排期 —— 正常路径一次都不会多打 AT，
		 * 不会增加稳态的串口压力。
		 */
		var partialRetryTimer = null;
		var partialRetryLeft = 2;

		/*
		 * waitSmsJob 的轮询句柄表与页面存活标志。
		 * 发长短信时它会以 350ms 间隔连查 AT+SMSJOB? 最多 20 秒；若中途离开页面，
		 * 必须能把这些 setTimeout 收掉，否则会继续占用独占的 AT 通道。
		 */
		var jobPollers = [];
		var disposed = false;
		function schedulePartialRetry() {
			if (partialRetryTimer) return;
			if (partialRetryLeft <= 0) return;
			partialRetryLeft--;
			partialRetryTimer = setTimeout(function () {
				partialRetryTimer = null;
				refresh();
			}, 1500);
		}

		/*
		 * ============ 已发记录的唯一真源：设备 ============
		 *
		 * 已发短信原先只写 localStorage —— 那是**浏览器**的私有空间，换浏览器 /
		 * 清缓存 / 换电脑打开页面就一条不剩。现在它落在设备上的
		 * /etc/mt5700/sms-sent.json（ubus mt5700.smslog），任何浏览器打开都是
		 * 同一份；localStorage 那一层已整块删除，不留第二个来源 —— 两个来源
		 * 就是「同一条短信画两个气泡」的温床（2.3.57 刚修过一次）。
		 */

		/* 老版本的键：升级后要把它搬到设备上，搬完才清 */
		var LEGACY_SMS_KEY = 'sms_sent_messages_cache';

		function legacySentMessages() {
			try {
				var raw = localStorage.getItem(LEGACY_SMS_KEY);
				if (!raw) return [];
				var arr = JSON.parse(raw);
				if (!Array.isArray(arr)) return [];
				return arr.filter(function (m) {
					return m && typeof m.content === 'string' && typeof m.number === 'string' &&
						typeof m.time === 'string' && (m.type === 'sent' || m.type === 'received');
				});
			} catch (e) { return []; }
		}

		/*
		 * 一次性迁移：老版本把已发记录留在 localStorage，升级后必须搬到设备上，
		 * 否则用户升级完发现「以前发过的全没了」。
		 * 只在设备端为空时搬一次，且**搬成功才清本地** —— 写失败就留着，下次
		 * 进页面再试；没搬成的那些也照样显示出来（只是没有 logId，删不掉）。
		 */
		function migrateLegacySent(serverList) {
			if (serverList.length) return Promise.resolve(serverList);
			var legacy = legacySentMessages();
			if (!legacy.length) return Promise.resolve(serverList);
			return AtWs.smsLog('add', JSON.stringify(legacy)).then(function (r) {
				if (!r.success) return legacy.map(function (m) {
					return { content: m.content, number: m.number, time: m.time, type: m.type, logId: null };
				});
				try { localStorage.removeItem(LEGACY_SMS_KEY); } catch (e) {}
				return toSentRecords(r.messages);
			});
		}

		/*
		 * 一条已发记录的「设备端编号」。
		 *
		 * ★ 2026-09-28 修复（用户报「删除不了已发送的短信」的根因）：
		 *   两个字段名都要认 —— 后端原始记录用 `id`，界面内部用 `logId`。
		 *   此前删除路径只读 `m.logId`，而 `logId` 只由 `toSentRecords()` 产生，
		 *   偏偏 `loadSentLog()` 在**主路径**（设备端已有记录）上是
		 *   `migrateLegacySent()` 的 `Promise.resolve(serverList)` 直通，
		 *   把后端原始记录（字段是 `id`）原样交给了界面。于是：
		 *     · 单条删除落进「既没有模组槽位、也没有设备编号」的兜底分支，
		 *       弹的是「这条记录还没同步到设备上，无法删除」——驴唇不对马嘴；
		 *     · 批量删除里 `logIds` 恒为空，一条也删不掉，最后还报
		 *       「成功删除 0 条短信」（假成功）。
		 *   只有「localStorage 老数据迁移成功」那条冷路径才带 `logId`，
		 *   所以这个缺陷在日常使用中**必然复现**。
		 */
		function logIdOf(m) {
			if (!m) return null;
			if (m.logId != null) return m.logId;
			return (m.id != null) ? m.id : null;
		}

		/*
		 * 设备返回的记录 → 界面用的记录（id 改名 logId，避免与模组槽位 index 混淆）。
		 * **必须幂等**：既能吃后端原始记录（带 id），也能吃已经转换过的（带 logId），
		 * 因为 loadSentLog 会对 migrateLegacySent 的结果再统一过一遍。
		 */
		function toSentRecords(list) {
			var out = [];
			for (var i = 0; i < (list || []).length; i++) {
				var m = list[i];
				if (!m) continue;
				out.push({
					content: m.content, number: m.number, time: m.time, type: m.type,
					logId: logIdOf(m)
				});
			}
			return out;
		}

		/*
		 * 读不到设备记录时返回空数组，但**不把「读不到」伪装成「没有」**：
		 * 后端没升级 / 文件不可写都要在别处给出说法，这里只保证界面不炸。
		 */
		function loadSentLog() {
			return AtWs.smsLog('list').then(function (r) {
				if (!r.success) return [];
				/*
				 * ★ 2026-09-28：无论走哪条路径，出去之前都统一过一遍 toSentRecords。
				 *   原来这里是 `return migrateLegacySent(r.messages || [])`，
				 *   而 migrateLegacySent 在「设备端已有记录」这条主路径上是
				 *   `Promise.resolve(serverList)` —— 直接把后端原始记录交了出去，
				 *   字段名是 `id` 而不是界面要的 `logId`，导致已发短信删不掉。
				 *   详见 logIdOf() 的注释。
				 */
				return migrateLegacySent(r.messages || []).then(toSentRecords);
			});
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
				return loadSentLog().then(function (sent) {
					buildContacts(parsed.concat(sent));
				});
			}).catch(function () {
				Mt5700.error('获取短信列表失败');
			});
		}

		/*
		 * ============ 收件箱归并（唯一收口） ============
		 *
		 * 同一条短信会从两条路进到这里：
		 *   A. AT+CMGL=4 拉回的存储列表 —— 长短信在这里由 mergeConcatenated 拼成一条，
		 *      带 index / partIndices；
		 *   B. new_sms 推送里服务端拼好的那条 —— 拼出来的完整消息不带 index。
		 *
		 * 此前两路在**各自的调用点**拼数组（还各自处理一遍残缺项），谁也不知道对方已经
		 * 把这条画出来了，于是同一个内容出现两个气泡；而刷新页面只走 A，一刷新就只剩
		 * 一条 —— 现象看着像偶发时序，根子其实是「哪两条记录算同一条」没有归属地。
		 *
		 * 所以把身份判定收在这里：不管来源是几个、怎么组合，都先归并一次再往下走。
		 * 删除这段会怎样？判定会重新散回各个调用点各自漂移 —— 这就是删除测试的答案。
		 */

		/*
		 * 内容逐字相同时允许的时间偏差。
		 * 同一条短信的两个来源，时间口径可能不一致（一边是短信中心时间 SCTS，
		 * 一边是本地时钟兜底），给一个窗吸收这种差；运营商真连着发两条一模一样的短信，
		 * 落地间隔不会只有几秒，所以这个窗不会把两条真短信并成一条。
		 */
		var SAME_SMS_WINDOW_MS = 5000;

		function partIndicesOf(m) {
			if (!m) return [];
			if (m.partIndices && m.partIndices.length) return m.partIndices;
			return (m.index != null && m.index >= 0) ? [m.index] : [];
		}

		function smsTextKey(m) {
			return String((m && m.content) || '').replace(/\s+/g, '');
		}

		function smsTimeMs(m) {
			if (!m || !m.time) return NaN;
			var t = Parse.parseMessageTime(m.time).getTime();
			return isFinite(t) ? t : NaN;
		}

		function isSameSms(a, b) {
			if (!a || !b) return false;
			if (normalizeNumber(a.number) !== normalizeNumber(b.number)) return false;
			var ia = partIndicesOf(a), ib = partIndicesOf(b);
			if (ia.length && ib.length) {
				/*
				 * 两边都落在存储槽位上：以槽位为准，逐段全等才算同一条。
				 * 槽位会被复用（删掉旧短信后新短信填同一个位置），只比内容会把
				 * 到达时间不同、内容恰好相同的两条真短信并掉 —— 那就漏短信了。
				 */
				if (ia.length !== ib.length) return false;
				for (var i = 0; i < ia.length; i++) if (ib.indexOf(ia[i]) < 0) return false;
				return true;
			}
			/* 至少一边只有内容、没有槽位（推送拼出的长短信正是这种）：退回内容 + 时间窗 */
			var ka = smsTextKey(a), kb = smsTextKey(b);
			if (!ka || ka !== kb) return false;
			var ta = smsTimeMs(a), tb = smsTimeMs(b);
			/* 有一边取不到时间：内容已逐字相同，按同一条处理 */
			if (isNaN(ta) || isNaN(tb)) return true;
			return Math.abs(ta - tb) <= SAME_SMS_WINDOW_MS;
		}

		function copySms(m) {
			var o = {};
			for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) o[k] = m[k];
			return o;
		}

		/*
		 * 留下信息更全的一条：带物理槽位的一条才删得掉（AT+CMGD 要拿 index，
		 * 推送来的那条没有），所以有槽位的一方赢。
		 * 未读取「或」：任一路认为用户还没看过，就算没看过 —— 否则推送标的那次
		 * 未读会在归并里被丢掉，表现为「新短信来了却不显示未读」。
		 */
		function keepRicher(cur, next) {
			var keep = partIndicesOf(cur).length ? cur : (partIndicesOf(next).length ? next : cur);
			var drop = (keep === cur) ? next : cur;
			var merged = copySms(keep);
			if (!merged.time && drop.time) merged.time = drop.time;
			if (drop.unread) merged.unread = true;
			if (!partIndicesOf(merged).length && partIndicesOf(drop).length) merged.partIndices = partIndicesOf(drop);
			return merged;
		}

		function mergeSmsDuplicates(list) {
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				if (!m || m.type !== 'received') { out.push(m); continue; }
				var hit = -1;
				for (var j = 0; j < out.length; j++) {
					if (out[j] && out[j].type === 'received' && isSameSms(out[j], m)) { hit = j; break; }
				}
				if (hit < 0) out.push(m);
				else out[hit] = keepRicher(out[hit], m);
			}
			return out;
		}

		function buildContacts(list) {
			list = mergeSmsDuplicates(mergeConcatenated(list));
			/*
			 * 合并长短信分片之后才是「完整短信」条数；state.storage.used 是
			 * AT+CPMS? 的物理槽位占用，一条 3 段的长短信占 3 格但只算 1 条，
			 * 两个数含义不同，界面上必须分开显示。
			 */
			var fullReceived = 0;
			for (var fi = 0; fi < list.length; fi++) {
				if (list[fi] && list[fi].type === 'received') fullReceived++;
			}
			state.receivedCount = fullReceived;
			var map = {};
			for (var i = 0; i < list.length; i++) {
				var msg = list[i];
				var num = normalizeNumber(msg.number);
				if (!num) continue;
				// 来源 B：列表里确实还带着未读状态（<stat>=0）的短信
				if (msg.unread) markUnread(num);
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
				/*
				 * 未读数优先按短信自身的状态位统计；一条都没标时，若该号码被新短信
				 * 推送标过未读，至少算 1 条（那种情况只知道号码、不知道具体哪几条）。
				 */
				/*
				 * ★ 2026-09-30 修「读了刷新又未读」（幻影未读）：
				 *
				 *   原写法 `c.unreadCount = unreadN || (isUnread(c.number) ? 1 : 0)` 里，
				 *   那个"名单里有号码就至少算 1"的回退是幻影未读的来源 ——
				 *   会话里其实一条未读都没有（用户读过、模组侧也全是 stat=1），
				 *   但只要号码还留在名单里，徽章就永远显示"未读 1"，刷新也照旧
				 *   （列表重建时又走一遍这条回退）。真机复现：10086 的【订购成功提醒】已读仍显示未读。
				 *
				 *   现在只按**短信自身的状态位**统计；回退收窄到唯一真正需要它的场景：
				 *   新短信推送已到达、但列表还没刷新回来（此时该会话**一条消息对象都没有**）。
				 */
				var unreadN = 0;
				for (var mi = 0; mi < c.messages.length; mi++) {
					/*
					 * ★ 2026-09-30：不走 `c.messages[mi].unread` 裸判，改用 isMsgUnread（水位线）。
					 *   真机探针确认：推送重放会把**早已读过**的消息标回 unread=true，
					 *   裸判就会让"读了刷新又变未读"永远复现。判定规则见 isMsgUnread 处注释。
					 */
					if (isMsgUnread(c, c.messages[mi])) unreadN++;
				}
				/*
				 * ★ 名单自动收敛：列表已经带来了该会话的消息、且里面一条未读都没有
				 *   → 名单里的该号码是残留（用户读过 / 模组侧已置读），就地剔除并落盘。
				 *   没有这一步，残留会一直挂着，每次重建都把徽章算回来。
				 *   注意只在 `c.messages.length > 0` 时收敛：消息对象还没到时不能剔，
				 *   否则会把"推送已到、列表未刷新"的真未读一起清掉。
				 */
				var newerThanRead = hasMsgNewerThanRead(c);
				if (c.messages.length > 0 && isUnread(c.number) && unreadN === 0 && !newerThanRead) {
					clearUnread(c.number);
				}
				c.unreadCount = unreadN || ((isUnread(c.number) && newerThanRead) ? 1 : 0);
				c.unread = c.unreadCount > 0;
				list2.push(c);
			}

			// 短信删掉后把它的号码从未读名单里摘掉，避免名单无界增长
			var known = {};
			for (var k2 in map) known[k2] = 1;
			var kept = unreadNumbers.filter(function (n) { return known[n]; });
			if (kept.length !== unreadNumbers.length) { unreadNumbers = kept; saveUnread(); }
			list2.sort(function (a, b) {
				return Parse.parseMessageTime(b.lastTime).getTime() - Parse.parseMessageTime(a.lastTime).getTime();
			});
			/*
			 * 存在未收齐的分段 → 安排重拉；已经齐了 → 把重试配额复位，
			 * 这样下一条长短信到来时还能再享受 2 次补齐机会。
			 */
			var pendingParts = 0;
			for (var pp = 0; pp < list.length; pp++) if (list[pp] && list[pp].partialPending) pendingParts++;
			if (pendingParts > 0) schedulePartialRetry();
			else partialRetryLeft = 2;
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
			clearUnread(num);        // 打开会话即视为已读
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

		function nowTimeStr() {
			var d = new Date();
			var pad = function (n) { return String(n).padStart(2, '0'); };
			return pad(d.getFullYear() % 100) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
				',' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
		}

		/*
		 * 轮询后台短信任务结果。
		 * 后端把 AT+CMGS 转入独立任务后立刻返回受理，这里按 ~350ms 轮询
		 * AT+SMSJOB?，直到任务结束或超时（默认 20s）。
		 * 注意：轮询走的是短信专用查询命令，不会被「发送中」的忙状态挡住。
		 */
		function waitSmsJob(timeoutMs) {
			var deadline = Date.now() + (timeoutMs || 20000);
			var nextTimer = null;
			var pending = jobPollers.length;
			jobPollers.push(null);
			return new Promise(function (resolve, reject) {
				var tick = function () {
					/*
					 * 离开页面后必须停下：这条链每 350ms 就要往独占串口发一条
					 * AT+SMSJOB?，页面切走了还继续发，会把别的页面的命令全堵在
					 * 队列后面。_dispose 只清得掉 partialRetryTimer，管不到这里，
					 * 故用一个模块级标志 + 句柄双保险。
					 */
					if (disposed) { jobPollers[pending] = null; reject(new Error('页面已离开，等待中止')); return; }
					/*
		 * ★ P09（2026-09-19 会审）：必须带 fresh。
		 * 前端读缓存 TTL 2500ms（rpc.js CACHE_TTL_STATE 之外那一档）大于这里 350ms 的轮询
		 * 间隔，不带 fresh 时连续 7 拍拿到同一个缓存对象，350ms 的设计意图直接落空，
		 * 发送结果反馈最多延迟 2.5 秒。与 euicc.js:648 的已有写法一致。
		 */
		AtWs.client.sendCommand('AT+SMSJOB?', { fresh: true }).then(function (res) {
						var st = null;
						try { st = JSON.parse(String(res && res.data ? res.data : '{}')); }
						catch (e) { st = null; }
						if (!st || typeof st.running !== 'boolean') {
							reject(new Error('无法获取短信任务状态'));
							return;
						}
						if (st.running) {
							if (Date.now() > deadline) { reject(new Error('等待模组确认超时')); return; }
							if (disposed) { reject(new Error('页面已离开，等待中止')); return; }
							nextTimer = setTimeout(tick, 350);
							jobPollers[pending] = nextTimer;
							return;
						}
						if (st.ok) resolve(st.message || '发送成功');
						else reject(new Error(st.message || '发送失败'));
					}).catch(function (err) {
						reject(new Error(String((err && err.message) || err || '查询任务状态失败')));
					});
				};
				if (disposed) { reject(new Error('页面已离开，等待中止')); return; }
				nextTimer = setTimeout(tick, 300);
				jobPollers[pending] = nextTimer;
			});
		}

		/* 解析 AT+CMGF? 的应答：0 = PDU，1 = Text；取不到按 PDU 处理 */
		function parseCmgf(res) {
			var m = String((res && res.data) || '').match(/\+CMGF:\s*(\d)/);
			return m ? parseInt(m[1], 10) : 0;
		}

		/*
		 * 提交一条短信命令并取结果（PDU / Text 两种模式共用）。
		 *
		 * 后端会把 AT+CMGS 转入独立任务、先回 SMS_ACCEPTED，这里再轮询
		 * AT+SMSJOB? 拿最终结果；旧后端是同步返回，此时必须看到 +CMGS / OK
		 * 才算成功 —— 只回显命令而没有 +CMGS，说明模组没接受数据，不能报成功。
		 */
		function submitSms(cmd) {
			return AtWs.client.sendCommand(cmd).then(function (res) {
				if (!res || res.success === false) {
					throw new Error(String((res && res.error) || '发送失败'));
				}
				var txt = String(res.data == null ? '' : res.data);
				if (/\bERROR\b/i.test(txt)) {
					throw new Error('模组返回错误：' + txt.replace(/\s+/g, ' ').trim());
				}
				if (txt.indexOf('SMS_ACCEPTED') >= 0) {
					return waitSmsJob();
				}
				if (!/(\+CMGS:|\bOK\b)/.test(txt)) {
					throw new Error('模组未确认短信提交（无 +CMGS/OK 应答，短信未发出）');
				}
				return txt;
			});
		}

		/*
		 * PDU 模式（AT+CMGF=0）发送。
		 * 命令形态见 SmsEncode.buildPduSendCommand 的注释：命令与 PDU 之间必须用
		 * 字面 "\r" 分隔，整条命令只在末尾有一个回车（由后端补）。
		 */
		function sendPduMode(target, content) {
			return AtWs.client.sendCommand('AT+CMGF?')
				.then(function (res) {
					if (parseCmgf(res) === 1) {
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
					/*
					 * 保留号码开头的 '+'：TP-DA 的类型字节（TOA）要靠它区分
					 * 0x91（国际号码，带国家码）与 0x81（国内/未知）。
					 * 编码器内部自己会过滤非数字字符，不需要在这里预处理。
					 */
					var parts = SmsEncode.buildSubmitParts({ smsc: smsc, destination: target, message: content });
					var c = Promise.resolve();
					for (var i = 0; i < parts.length; i++) {
						c = c.then(function (part) {
							return submitSms(SmsEncode.buildPduSendCommand(part));
						}.bind(null, parts[i]));
					}
					return c;
				});
		}

		/*
		 * Text 模式（AT+CMGF=1）发送。
		 *  - 纯 ASCII 且不超过 160 字符：直接下发明文；
		 *  - 含中文：临时切 AT+CSCS="UCS2"，号码与正文都写成 UCS2 十六进制，
		 *    发完立刻切回 IRA（字符集是全局设置，不恢复会让整条 AT 通道的
		 *    应答都变成 UCS2 编码，其它页面集体读不出来）；
		 *  - 超长：Text 模式没有分片语法（拼接头只能自己写 PDU），
		 *    降级为 PDU 模式发送，发完再切回 Text。
		 */
		function sendTextMode(target, content) {
			var ucs2 = SmsEncode.usesUcs2(content);
			var limit = ucs2 ? SmsEncode.TEXT_MAX_UCS2 : SmsEncode.TEXT_MAX_ASCII;
			if (content.length > limit) {
				return AtWs.client.sendCommand('AT+CMGF=0')
					.then(function () { return sendPduMode(target, content); })
					.then(function (r) {
						return AtWs.client.sendCommand('AT+CMGF=1')
							.then(function () { return r; }, function () { return r; });
					});
			}

			var plan = SmsEncode.buildTextSendCommand({ destination: target, message: content });
			var restore = function () {
				var c = Promise.resolve();
				(plan.post || []).forEach(function (cmd) {
					c = c.then(function () { return AtWs.client.sendCommand(cmd); });
				});
				return c;
			};
			var run = Promise.resolve();
			(plan.pre || []).forEach(function (cmd) {
				run = run.then(function () { return AtWs.client.sendCommand(cmd); });
			});
			run = run.then(function () { return submitSms(plan.cmd); });
			// 成功失败都要恢复现场
			return run.then(
				function (r) { return restore().then(function () { return r; }, function () { return r; }); },
				function (e) { return restore().then(function () { throw e; }, function () { throw e; }); }
			);
		}

		var sending = false;

		function send(explicitTarget) {
			var content = msgInput.value.trim();
			if (!content) { Mt5700.warning('请输入短信内容'); return; }
			var target = (explicitTarget || '').trim() || state.selectedContact || '';
			if (!target) { Mt5700.warning('请输入联系人号码'); return; }
			if (!Parse.isValidPhoneNumber(target)) { Mt5700.warning('请输入正确的 5-19 位手机号码'); return; }

			/*
			 * 回车发送绕得开按钮的 disabled：textarea 的 keydown 不看按钮状态。
			 * 长短信多片串行下发期间连按回车会并行插入多组 AT+CMGS，既造成重复
			 * 短信、也打乱独占串口上的命令顺序。守卫放在校验之后，保证校验失败
			 * 不会把标志卡死。
			 */
			if (sending) return;
			sending = true;
			sendBtn.disabled = true;
			/*
			 * ★ 时间戳必须在「点下发送」这一刻就固定，不能等 chain 跑完再取。
			 * 收到的短信用的是短信中心时间（SCTS），已发送短信走的则是本地时钟；
			 * 若取「发送完成」时刻，AT+CMGS 的耗时（实测可达数秒）会把本地时间
			 * 推到对方回复之后 —— 表现就是 10086 的回复反而排在发出的「套餐」前面。
			 */
			var sentAt = nowTimeStr();
			/*
			 * 跟随模组当前的短信格式，而不是强扭成 PDU：
			 * 模组可能正被别的工具（或用户自己）设在 Text 模式，强行切换会改动
			 * 别人的现场；两种模式我们都支持，按当前模式构造命令即可。
			 */
			var chain = AtWs.client.sendCommand('AT+CMGF?')
				.then(function (res) {
					return (parseCmgf(res) === 1)
						? sendTextMode(target, content)
						: sendPduMode(target, content);
				});

			chain.then(function (lastRes) {
				if (lastRes && lastRes.success === false) throw new Error(String(lastRes.error || '发送失败'));
				/*
				 * 已发出 ≠ 已记账。记录写不进设备时必须分开说：短信确实出去了，
				 * 但换个浏览器就看不到它 —— 那正是这次要治的毛病，不能拿
				 * 「发送成功」一句话把两件事都盖过去（红线 23）。
				 */
				return AtWs.smsLog('add', JSON.stringify({
					content: content, number: target, time: sentAt, type: 'sent'
				})).then(function (r) {
					msgInput.value = '';
					renderHint();
					if (!r.success) {
						Mt5700.warning('已发出，但发送记录未写入设备：' + (r.error || '未知原因'));
						return refresh();
					}
					/*
					 * 立刻把这条画出来，不等 refresh 的下一轮拉取。
					 * 取后端刚追加的那一条（追加在末尾），logId 是后端分配的编号，
					 * 有了它「删除」按钮当场就能用。
					 */
					var all = toSentRecords(r.messages);
					var rec = all.length ? all[all.length - 1] : null;
					if (rec && rec.time === sentAt && rec.content === content) {
						state.messages.push(rec);
						renderConversation();
					}
					Mt5700.success('发送成功');
					return refresh();
				});
			}).catch(function (err) {
				/* 切页造成的「等待中止」不弹错（2026-10-22 审计）：用户已经在别的
				 * 页面，挂在 body 上的 toast 会追过去 —— 幽灵提示。发送链本身已随
				 * disposed 停止，不需要用户处置，静默即可。 */
				var msg = (err && err.message) || '';
				if (msg.indexOf('页面已离开') < 0) Mt5700.error(msg || '发送失败');
			}).then(function () { sending = false; sendBtn.disabled = false; });
		}

		/* ---------- 删除 ---------- */

		/*
		 * 一条短信身上「删得掉」的凭据，可能同时有两种：
		 *   · indices —— 模组存储槽位（AT+CMGD）。收到的短信有；模块自己存过的已发短信也有。
		 *   · logId   —— 设备端已发记录编号（ubus mt5700.smslog del）。本应用发出去的走这条。
		 *
		 * 一条记录**可能两者都有**（长短信合并后、或模组把已发也存了一份），所以必须**都收**。
		 * 原来单条写成 `if (idxs.length) … else if (logId)`、批量写成
		 * `if (!idxs.length && logId)` —— 只要带了槽位就永远轮不到设备记录，
		 * 表现出来就是「删了模组那条、设备上那条还在」。
		 */
		function deleteTargetsOf(m) {
			return { indices: partIndicesOf(m), logId: logIdOf(m) };
		}

		/*
		 * 串行删除一批短信。单条删除与批量删除**共用这一份**，
		 * 免得两处逻辑各自漂移 —— 本轮修的两个缺陷正是两处同源的漏字段。
		 *
		 * 按「短信条数」判定：一条短信的所有模组槽位都删成功、且它若有设备记录也删成功，
		 * 这条才算删掉。这样报出来的数字是条数，不是 AT 命令成功数。
		 */
		function runDeletes(messages) {
			var stats = { ok: 0, fail: 0, unsynced: 0 };
			var chain = Promise.resolve();
			messages.forEach(function (m) {
				chain = chain.then(function () {
					var t = deleteTargetsOf(m);
					var idxs = t.indices.filter(function (ix) { return ix != null && ix >= 0; });
					if (!idxs.length && t.logId == null) {
						/* 既没有模组槽位、也没有设备编号：搬迁没成功的旧记录 */
						stats.unsynced++;
						return;
					}
					/* 逐段删模组槽位；任一段失败，这条就算失败 */
					var seq = Promise.resolve(true);
					idxs.forEach(function (ix) {
						seq = seq.then(function (sofar) {
							return AtWs.client.sendCommand('AT+CMGD=' + ix).then(function (res) {
								/*
								 * sendCommand 以 {success:false} 而非 rejection 表示失败，
								 * 不判就会「提示删除成功、模组上的短信还在」。
								 */
								return sofar && !(res && res.success === false);
							});
						});
					});
					return seq.then(function (atOk) {
						if (t.logId == null) {
							if (atOk) stats.ok++; else stats.fail++;
							return;
						}
						/*
						 * 已发记录：删的是设备上的那一条。
						 * ★ 编号必须传数字 —— ucode 里 args 声明的是整型，rpcd 会在进 ucode
						 *   之前把字符串形态以 code=2 拒掉，界面只会落一个「删除失败」。
						 */
						return AtWs.smsLog('del', '', t.logId).then(function (r) {
							if (atOk && r && r.success) stats.ok++; else stats.fail++;
						});
					});
				});
			});
			return chain.then(function () { return stats; }, function () { return stats; });
		}

		/* 把结果说清楚：报真实条数，绝不把「没删成」伪装成成功 */
		function reportDeleteResult(s) {
			if (!s.ok && s.unsynced) {
				/*
				 * 既没有模组槽位、也没有设备编号：这是搬迁没成功的旧记录，
				 * 只存在于当前浏览器的内存里。删不掉就明说，不要假装删掉了。
				 */
				Mt5700.warning('这条记录还没同步到设备上，无法删除（请到「短信设置」清空后重试）');
				return;
			}
			var tail = s.unsynced ? '，另有 ' + s.unsynced + ' 条未同步到设备、删不掉' : '';
			if (s.fail) Mt5700.error('删除：成功 ' + s.ok + ' 条、失败 ' + s.fail + ' 条' + tail);
			else Mt5700.success('成功删除 ' + s.ok + ' 条短信' + tail);
		}

		function deleteMessage(msg) {
			runDeletes([msg]).then(function (s) {
				reportDeleteResult(s);
				refresh();
			});
		}

		var openMask = null;

		function closeMask(mask) {
			if (openMask === mask) openMask = null;
			if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
		}

		function bindMaskClose(mask) {
			mask.addEventListener('click', function (e) {
				if (e.target === mask) closeMask(mask);
			});
		}

		/*
		 * 批量删除对话框。
		 *
		 * ★ 2026-09-28 重做（用户反馈「没有全选按钮、样式太丑」）：
		 *   原来直接套「同意条款」那组组件（同意条款列表 + 单行内联），
		 *   每行只有一截灰字「[发] 号码：内容…」—— 没有方向标识、没有时间、
		 *   没有全选、也看不出已经选了几条；标题用的 mt5700-modal-title 直接贴在
		 *   弹窗边缘（那个类没有内边距，要配 mt5700-modal-header 才有）。
		 *   现在改成：工具栏（全选 / 实时计数 / 反选）+ 选择列表（方向徽章 +
		 *   号码 + 时间 + 正文预览，整行可点）+ 底部动作区。
		 *
		 * 正文一律走 E 的第三个参数（textContent），绝不拼 HTML ——
		 * 短信正文是不可信输入。
		 */
		function batchDelete() {
			var mask = E('div', { 'class': 'mt5700-modal-mask' });
			openMask = mask;
			var box = E('div', { 'class': 'mt5700-modal mt5700-modal-wide' });
			var header = E('div', { 'class': 'mt5700-modal-header' });
			header.appendChild(E('div', { 'class': 'mt5700-modal-title' }, '批量删除短信'));
			box.appendChild(header);

			var messages = state.messages.slice();
			if (!messages.length) {
				var emptyBody = E('div', { 'class': 'mt5700-modal-body' });
				emptyBody.appendChild(Mt5700.empty('当前会话没有可删除的短信'));
				box.appendChild(emptyBody);
				var emptyFoot = E('div', { 'class': 'mt5700-modal-footer' });
				emptyFoot.appendChild(Mt5700.ghostButton('关闭', function () { closeMask(mask); }));
				box.appendChild(emptyFoot);
				mask.appendChild(box);
				bindMaskClose(mask);
				document.body.appendChild(mask);
				return;
			}

			var rows = [];
			var delBtn = null;
			var countEl = E('span', { 'class': 'mt5700-sms-pick-count' });

			/* --- 工具栏：全选 + 计数 + 反选 --- */
			var toolbar = E('div', { 'class': 'mt5700-sms-pick-toolbar' });
			var allWrap = E('label', { 'class': 'mt5700-checkbox mt5700-sms-pick-all' });
			var allChk = E('input', { type: 'checkbox' });
			allWrap.appendChild(allChk);
			allWrap.appendChild(E('span', {}, '全选'));
			toolbar.appendChild(allWrap);
			toolbar.appendChild(countEl);
			toolbar.appendChild(Mt5700.ghostButton('反选', function () {
				for (var i = 0; i < rows.length; i++) rows[i].chk.checked = !rows[i].chk.checked;
				sync();
			}));
			box.appendChild(toolbar);

			/* --- 列表：一条短信一行，整行可点 --- */
			var listEl = E('div', { 'class': 'mt5700-sms-pick-list' });
			messages.forEach(function (m) {
				var row = E('label', { 'class': 'mt5700-sms-pick-row' });
				var chkWrap = E('span', { 'class': 'mt5700-checkbox' });
				var chk = E('input', { type: 'checkbox' });
				chkWrap.appendChild(chk);
				row.appendChild(chkWrap);

				var main = E('span', { 'class': 'mt5700-sms-pick-main' });
				var line = E('span', { 'class': 'mt5700-sms-pick-head' });
				line.appendChild(Mt5700.badge(m.type === 'sent' ? '发' : '收',
					m.type === 'sent' ? 'primary' : 'info'));
				line.appendChild(E('span', { 'class': 'mt5700-sms-pick-num' }, m.number || '未知号码'));
				line.appendChild(E('span', { 'class': 'mt5700-sms-pick-time' }, m.time || ''));
				/*
				 * 删不掉的当场标出来，别等用户点了「删除所选」才发现 ——
				 * 那种记录是旧版本搬迁没成功的，只活在浏览器内存里。
				 */
				var tg = deleteTargetsOf(m);
				if (!tg.indices.length && tg.logId == null) {
					line.appendChild(Mt5700.badge('未同步', 'warning'));
				}
				main.appendChild(line);
				main.appendChild(E('span', { 'class': 'mt5700-sms-pick-text' }, m.content || '(空消息)'));
				row.appendChild(main);

				chk.addEventListener('change', function () { sync(); });
				listEl.appendChild(row);
				rows.push({ msg: m, chk: chk });
			});
			box.appendChild(listEl);

			/* --- 底部动作区 --- */
			var actions = E('div', { 'class': 'mt5700-modal-footer' });
			actions.appendChild(Mt5700.ghostButton('取消', function () { closeMask(mask); }));
			delBtn = Mt5700.dangerButton('删除所选', function () {
				var picked = [];
				for (var i = 0; i < rows.length; i++) if (rows[i].chk.checked) picked.push(rows[i].msg);
				if (!picked.length) { Mt5700.warning('请先选择要删除的短信'); return; }
				delBtn.disabled = true;
				delBtn.textContent = '正在删除…';
				runDeletes(picked).then(function (s) {
					closeMask(mask);
					reportDeleteResult(s);
					refresh();
				});
			});
			actions.appendChild(delBtn);
			box.appendChild(actions);

			/*
			 * 选中状态只有一处真相（各行的 checkbox），
			 * 全选框 / 计数 / 按钮文案都从这里派生，免得三处各自记数再对不上。
			 */
			function sync() {
				var n = 0;
				for (var i = 0; i < rows.length; i++) if (rows[i].chk.checked) n++;
				allChk.checked = n > 0 && n === rows.length;
				allChk.indeterminate = n > 0 && n < rows.length;   /* 部分选中：浏览器原生半选态 */
				countEl.textContent = '已选 ' + n + ' / 共 ' + rows.length + ' 条';
				delBtn.disabled = n === 0;
				delBtn.textContent = n ? ('删除所选（' + n + '）') : '删除所选';
			}

			allChk.addEventListener('change', function () {
				for (var i = 0; i < rows.length; i++) rows[i].chk.checked = allChk.checked;
				sync();
			});

			mask.appendChild(box);
			bindMaskClose(mask);
			document.body.appendChild(mask);
			sync();
		}

		/* ---------- 新短信推送 ---------- */

		var newSmsHandler = function (resp) {
			if (!resp || resp.type !== 'new_sms' || !resp.data) return;
			var d = resp.data;
			/*
			 * 时间一律换算成与列表同一种写法。
			 * 推送里的时间是 Rust 侧 `sms.date.format("%Y-%m-%d %H:%M:%S")` 出来的
			 * `2026-09-27 21:33:13`，而 AT+CMGL 那边是 `26/09/27,21:33:13`。
			 * 同一条短信的两个来源时间长得不一样，看上去就像两条不同的短信。
			 */
			var arrivedAt = d.time ? Parse.formatPDUTime(Parse.parseMessageTime(d.time)) : nowTimeStr();
			var msg = {
				index: d.index != null ? d.index : -Date.now(),
				content: d.content || '',
				number: normalizeNumber(d.sender || d.number || ''),
				time: arrivedAt,
				type: 'received',
				isConcatenated: d.isComplete === false ? true : false
			};
			// 完整消息直接进列表；长短信由服务端拼接后推送（isComplete=true）
			if (d.isComplete !== false) {
				/*
				 * 正开着这个号码的会话时，新短信是当场落在眼前的 —— 再标未读等于
				 * 「刚看完又冒个红点」，所以只有在没盯着它时才算未读。
				 */
				var watching = !!msg.number && normalizeNumber(state.selectedContact) === msg.number;
				msg.unread = !watching;
				if (!watching) markUnread(msg.number);   // 刚到达、用户尚未点开 → 未读
				/*
				 * 完整消息到达时，同号码尚未收齐的残缺合并消息必须剔除。
				 * 那只是「某次读取时片段还没到齐」的中间态，留着会与这条完整消息
				 * 并排显示成两条 —— 实测到的现象就是刷新前多出一条
				 * 「长短信已合并 2/4 段（部分缺失）」。
				 */
				var base = state.contacts.reduce(function (acc, c) { return acc.concat(c.messages); }, [])
					.filter(function (m) {
						return !(m.partialPending && normalizeNumber(m.number) === msg.number);
					});
				buildContacts(base.concat([msg]));
				Mt5700.info('收到来自 ' + msg.number + ' 的新短信');
			}
		};
		AtWs.client.subscribe(newSmsHandler);

		self._dispose = function () {
			disposed = true;
			jobPollers.forEach(function (t) { if (t) clearTimeout(t); });
			jobPollers = [];
			AtWs.client.unsubscribe(newSmsHandler);
			if (partialRetryTimer) { clearTimeout(partialRetryTimer); partialRetryTimer = null; }
			if (openMask && openMask.parentNode) openMask.parentNode.removeChild(openMask);
			self._dispose = function () {};
		};
		page._onDispose(self._dispose);

		/* ---------- 初始化 ---------- */

		Mt5700.connectThen(function () {
			refreshStorage();
			refresh();
		});

		renderStorage();
		renderContacts();
		renderConversation();

		return page;
	}
});
