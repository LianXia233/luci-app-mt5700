'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 定时锁频编排页面：
 * - 运行状态：总开关 / 当前时段 / 下次切换 / 已切换次数（AT+SCHED? 的 status 段）
 * - 调度参数：检测间隔、无服务超时、解锁时是否下发 LTE/NR 解锁、是否切飞行模式
 * - 夜间 / 日间两个时段卡：各自开启 4G/5G 锁频（类型、频段 / 频点 / SCS / PCI）
 * - 保存走伪命令 AT+SCHED=<json>，后端写 UCI 并热生效
 *
 * 排版与控件约定（与本项目其它纯表单页保持一致）：
 * - 字段统一走 Mt5700.formGroup + .mt5700-form-grid 双列栅格，窄屏自动回落单列；
 * - 开关统一走 Ui.switch（ui.js 里带「模组拒绝则回滚勾选」的约定），不再各写一份裸 checkbox；
 * - 输入框一律**不预填任何值**：后端没给值就留空，示例只写在 placeholder 里。
 *   这样「框里看到的值」永远等于「已保存的配置」，不会把默认值伪装成用户填的内容。
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('定时锁频编排', '按夜间/日间时段自动切换锁频策略，UCI 驱动后端守护调度', 'schedule', '时段调度 · 智能倒换');
		var body = page._body;

		var cfg = null;     // AT+SCHED? 的原始回读
		var draft = null;   // 正在编辑的值（表单的唯一数据源）
		var busy = false;

		/* ---------- 通用小工具 ---------- */

		// 后端没给值就留空，绝不把 undefined / 臆造的默认值写进输入框
		function raw(v) { return (v == null || v === '') ? '' : String(v); }

		function toNum(v) {
			var s = String(v == null ? '' : v).trim();
			if (s === '') return null;
			var n = Number(s);
			return isFinite(n) ? n : null;
		}

		function pick(obj, key, fallback) {
			var o = obj || {};
			return (o[key] === undefined || o[key] === null) ? fallback : o[key];
		}

		function periodOf(src) {
			var o = src || {};
			var lte = pick(o, 'lte', {});
			var nr = pick(o, 'nr', {});
			return {
				enabled: !!pick(o, 'enabled', false),
				start: raw(pick(o, 'start', '')),
				end: raw(pick(o, 'end', '')),
				lte: { type: toNum(pick(lte, 'type', 0)) || 0, items: Parse.fromLockLists('lte', lte) },
				nr: { type: toNum(pick(nr, 'type', 0)) || 0, items: Parse.fromLockLists('nr', nr) }
			};
		}

		/* ---------- 运行状态 ---------- */

		var statusCard = Mt5700.card('运行状态', '由后端常驻调度维护，页面关掉也照常执行；时间以插件时间源为准');
		var statusGrid = E('div', { 'class': 'mt5700-metrics' });
		var statusClock = E('div', { 'class': 'mt5700-hint' });
		var statusNote = E('div', { 'class': 'mt5700-hint' });
		statusCard._body.appendChild(statusGrid);
		statusCard._body.appendChild(statusClock);
		statusCard._body.appendChild(statusNote);
		body.appendChild(statusCard);

		/* ---------- 未启用空态 ---------- */

		var lockedCard = Mt5700.card('功能未启用', '');
		var lockedBody = E('div');
		lockedCard._body.appendChild(lockedBody);
		lockedBody.appendChild(E('div', { 'class': 'mt5700-hint' },
			'定时锁频的总开关当前是关闭状态。请到「服务配置 → 定时锁频」把「启用定时锁频」打开，' +
			'保存后回到本页即可编排时段策略。'));
		body.appendChild(lockedCard);

		/* ---------- 调度参数 ---------- */

		var paramCard = Mt5700.card('调度参数', '后端守护进程的检测节奏与倒换方式');
		var paramBody = E('div', { 'class': 'mt5700-form-grid' });
		paramCard._body.appendChild(paramBody);
		body.appendChild(paramCard);

		/* ---------- 时段（夜间 / 日间） ---------- */

		var periodRow = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(periodRow);

		var nightCard = Mt5700.card('夜间模式', '起止时间之间按本卡的配置锁频，其余时间走日间模式');
		var dayCard = Mt5700.card('日间模式', '夜间时段之外的时间');
		periodRow.appendChild(nightCard);
		periodRow.appendChild(dayCard);

		/* ---------- 操作栏 ---------- */

		var saveBtn = Mt5700.primaryButton('保存编排', save);
		var resetBtn = Mt5700.button('放弃修改并重载', function () {
			if (busy) return;
			reload();
		}, 'ghost');
		var actionBar = Mt5700.panelActions(saveBtn, resetBtn);
		body.appendChild(actionBar);

		/* ---------- 开关 ---------- */

		/*
		 * 带状态文字的开关行。
		 *
		 * 裸 checkbox 开与关只有颜色差异，表单里连排好几个时很难一眼确认当前值，
		 * 所以旁边补一个「已开启 / 已停用」小字，颜色跟主题 success / muted 走。
		 * 这里只做展示同步 —— 调用方通过 onChange 拿到布尔值，不需要关心 DOM。
		 */
		function switchRow(checked, onChange, onText, offText) {
			var wrap = E('div', { 'class': 'mt5700-switch-row' });
			var sw = Ui.switch(function (v) {
				checked = v;
				onChange(v);
			});
			var input = sw.querySelector('input');
			var state = E('span', { 'class': 'mt5700-switch-state' });

			function sync() {
				var on = input.checked;
				state.textContent = on ? (onText || '已开启') : (offText || '已停用');
				state.className = 'mt5700-switch-state ' + (on ? 'is-on' : 'is-off');
			}

			input.addEventListener('change', sync);
			input.checked = !!checked;
			sync();

			wrap.appendChild(sw);
			wrap.appendChild(state);
			return wrap;
		}

		/* ---------- 单个时段内的 4G / 5G 锁频 ---------- */

		function typeHintText(type) {
			if (type === 1) return '锁定频点：按「频段 + 频点」锁到指定频点（NR 另含 SCS）。';
			if (type === 2) return '锁定小区：在锁定频点之上再指定 PCI，锁到具体小区。';
			if (type === 3) return '锁定频段：只下发频段列表，模组在频段内自由选择小区。';
			return '关闭：该时段不锁频，模组恢复自由选网。';
		}

		function kindEditor(kind, lists) {
			var wrap = E('div', { 'class': 'mt5700-sched-sub' });
			wrap.appendChild(E('div', { 'class': 'mt5700-sched-sub-title' },
				kind === 'lte' ? '4G（LTE）锁频' : '5G（NR）锁频'));

			var typeSel = Mt5700.select(Parse.LOCK_TYPES.map(function (o) {
				return { label: o.label, value: String(o.value) };
			}), String(lists.type));

			var typeHint = E('div', { 'class': 'mt5700-hint' }, typeHintText(lists.type));
			wrap.appendChild(Mt5700.formGroup('锁频类型', typeSel));
			wrap.appendChild(typeHint);

			var itemsWrap = E('div', { 'class': 'mt5700-lock-items' });
			wrap.appendChild(itemsWrap);

			/* 实时预览：把这一组将要下发的内容拼给人看，避免「填完了却不知道填成了什么」 */
			var preview = E('div', { 'class': 'mt5700-sched-preview' });
			wrap.appendChild(preview);

			typeSel.addEventListener('change', function () {
				lists.type = parseInt(typeSel.value, 10) || 0;
				typeHint.textContent = typeHintText(lists.type);
				renderItems();
			});

			function bandOptions() {
				return [{ label: '未选择', value: '' }].concat(
					(kind === 'lte' ? Parse.LTE_BANDS : Parse.NR_BANDS).map(function (b) {
						return { label: b.label, value: String(b.value) };
					})
				);
			}

			/* 字段级 label + 控件：锁频这一组字段多，只靠 placeholder 分不清每一列的含义 */
			function field(label, control, hint) {
				var g = E('div', { 'class': 'mt5700-form-group' });
				g.appendChild(E('label', { 'class': 'mt5700-label' }, label));
				g.appendChild(control);
				if (hint) g.appendChild(E('div', { 'class': 'mt5700-hint' }, hint));
				return g;
			}

			function rowFor(item, index) {
				var row = E('div', { 'class': 'mt5700-lock-row' });
				row.appendChild(E('div', { 'class': 'mt5700-lock-row-index' }, '#' + (index + 1)));

				var fields = E('div', { 'class': 'mt5700-lock-fields' });
				row.appendChild(fields);

				var bandSel = Mt5700.select(bandOptions(), item.band == null ? '' : String(item.band));
				bandSel.addEventListener('change', function () {
					item.band = bandSel.value === '' ? null : Number(bandSel.value);
					renderPreview();
				});
				fields.appendChild(field('频段', bandSel));

				/*
				 * 手册 13.12.3 / 13.13.3：类型 3（锁 Band）只下发 band 列表，
				 * 类型 1（锁频点）不带 PCI。按类型裁剪字段，不展示用不到的输入框 ——
				 * 否则用户会以为「锁频段也要填频点」，填上反而保存失败。
				 */
				if (lists.type === 1 || lists.type === 2) {
					var arfcn = Mt5700.input('number', 'ARFCN', raw(item.arfcn));
					arfcn.min = '0';
					arfcn.max = String(Parse.MAX_ARFCN);
					arfcn.addEventListener('input', function () {
						item.arfcn = toNum(arfcn.value);
						renderPreview();
					});
					fields.appendChild(field('频点', arfcn));

					if (kind === 'nr') {
						var scs = Mt5700.select([{ label: '自动（按频段推断）', value: '' }].concat(
							Parse.SCS_TYPES.map(function (o) {
								return { label: o.label, value: String(o.value) };
							})
						), item.scs == null ? '' : String(item.scs));
						scs.addEventListener('change', function () {
							item.scs = scs.value === '' ? null : Number(scs.value);
							renderPreview();
						});
						fields.appendChild(field('SCS', scs));
					}

					if (lists.type === 2) {
						var maxPci = Parse.MAX_PCI[kind];
						var pci = Mt5700.input('number', 'PCI', raw(item.pci));
						pci.min = '0';
						pci.max = String(maxPci);
						pci.addEventListener('input', function () {
							item.pci = toNum(pci.value);
							renderPreview();
						});
						fields.appendChild(field('PCI', pci, '0 - ' + maxPci));
					}
				}

				/* 字段数为奇数时（如类型 1 的 NR：频段/频点/SCS）让最后一格整行宽，
				 * 否则两列栅格右边会空出一格，看起来像少画了一个控件。 */
				if (fields.children.length % 2 === 1) {
					fields.lastChild.classList.add('is-wide');
				}

				var del = Mt5700.button('删除', function () {
					lists.items.splice(index, 1);
					if (!lists.items.length) lists.items.push({});
					renderItems();
				}, 'danger');
				row.appendChild(del);
				return row;
			}

			function renderPreview() {
				preview.className = 'mt5700-sched-preview';
				if (lists.type === 0) {
					/* 类型「关闭」时上面已有一行说明，这里不再重复 */
					preview.textContent = '';
					preview.hidden = true;
					return;
				}
				preview.hidden = false;
				try {
					var l = Parse.toLockLists(kind, lists.type, lists.items);
					var parts = ['band=' + (l.bands || '—')];
					if (l.arfcns) parts.push('arfcn=' + l.arfcns);
					if (l.scs_types) parts.push('scs=' + l.scs_types);
					if (l.pcis) parts.push('pci=' + l.pcis);
					preview.textContent = '将下发：' + parts.join(' · ');
				} catch (e) {
					preview.className = 'mt5700-sched-preview is-pending';
					preview.textContent = '待补全：' + ((e && e.message) || '请检查已填内容');
				}
			}

			function renderItems() {
				itemsWrap.innerHTML = '';
				var items = lists.items || [{}];
				lists.items = items;

				if (lists.type === 0) {
					/* 用一行说明代替原来的大立绘空态：四个锁频块各插一张会把卡片拉得很长 */
					itemsWrap.appendChild(E('div', { 'class': 'mt5700-sched-note' },
						'类型为「关闭」，无需配置锁频条目'));
					renderPreview();
					return;
				}

				for (var i = 0; i < items.length; i++) itemsWrap.appendChild(rowFor(items[i], i));

				itemsWrap.appendChild(Mt5700.button('+ 添加一组', function () {
					if (items.length >= Parse.MAX_LOCK_ITEMS) {
						Mt5700.warning('最多只能锁 ' + Parse.MAX_LOCK_ITEMS + ' 组');
						return;
					}
					items.push({});
					renderItems();
				}, 'ghost'));

				renderPreview();
			}

			renderItems();
			return wrap;
		}

		/* ---------- 时段编辑 ---------- */

		function periodEditor(which, p) {
			var host = E('div');
			var detail = E('div', { 'class': 'mt5700-sched-detail' });

			/* 停用说明：默认隐藏，随开关文案一起联动 */
			var offNote = E('div', { 'class': 'mt5700-sched-note' },
				'该时段已停用，后端不会进入它；下面已填的配置会原样保留，重新启用后立即参与调度。');

			var switchWrap = switchRow(p.enabled, function (checked) {
				p.enabled = checked;
				detail.classList.toggle('is-off', !checked);
				offNote.hidden = checked;
			});

			host.appendChild(Mt5700.formGroup('启用该时段', switchWrap,
				which === 'night' ? '关闭后全天按日间模式执行' : '关闭后日间不做任何锁频'));

			if (which === 'night') {
				var startInput = Mt5700.input('text', '如 22:00', p.start);
				var endInput = Mt5700.input('text', '如 06:00', p.end);
				startInput.addEventListener('input', function () { p.start = startInput.value.trim(); });
				endInput.addEventListener('input', function () { p.end = endInput.value.trim(); });
				var timeRow = E('div', { 'class': 'mt5700-sched-time' });
				timeRow.appendChild(startInput);
				timeRow.appendChild(E('span', { 'class': 'mt5700-sched-time-sep' }, '至'));
				timeRow.appendChild(endInput);
				host.appendChild(Mt5700.formGroup('夜间时段', timeRow, 'HH:MM 格式，支持跨零点（如 22:00 至 06:00）'));
			}

			host.appendChild(offNote);
			host.appendChild(detail);

			detail.appendChild(kindEditor('lte', p.lte));
			detail.appendChild(kindEditor('nr', p.nr));

			detail.classList.toggle('is-off', !p.enabled);
			offNote.hidden = !!p.enabled;
			return host;
		}

		/* ---------- 表单 ---------- */

		function buildForm() {
			paramBody.innerHTML = '';
			nightCard._body.innerHTML = '';
			dayCard._body.innerHTML = '';
			if (!draft) return;

			var intervalInput = Mt5700.input('number', '10 - 3600', raw(draft.check_interval));
			intervalInput.min = '10';
			intervalInput.max = '3600';
			intervalInput.addEventListener('input', function () { draft.check_interval = toNum(intervalInput.value); });
			paramBody.appendChild(Mt5700.formGroup('检测间隔（秒）', intervalInput,
				'多久检查一次当前所处时段，下限 10 秒'));

			var timeoutInput = Mt5700.input('number', '30 - 3600', raw(draft.timeout));
			timeoutInput.min = '30';
			timeoutInput.max = '3600';
			timeoutInput.addEventListener('input', function () { draft.timeout = toNum(timeoutInput.value); });
			paramBody.appendChild(Mt5700.formGroup('无服务超时（秒）', timeoutInput,
				'模组无服务超过此时长就自动解锁，下限 30 秒'));

			var unlockLte = switchRow(draft.unlock_lte, function (checked) { draft.unlock_lte = checked; });
			paramBody.appendChild(Mt5700.formGroup('解锁时下发 LTE 解锁', unlockLte,
				'恢复默认网络时是否下发 AT^LTEFREQLOCK=0'));

			var unlockNr = switchRow(draft.unlock_nr, function (checked) { draft.unlock_nr = checked; });
			paramBody.appendChild(Mt5700.formGroup('解锁时下发 NR 解锁', unlockNr,
				'恢复默认网络时是否下发 AT^NRFREQLOCK=0'));

			var airplane = switchRow(draft.toggle_airplane, function (checked) { draft.toggle_airplane = checked; });
			paramBody.appendChild(Mt5700.formGroup('切换飞行模式使其生效', airplane,
				'关开一次 CFUN 让锁频立即生效，代价是短暂断网'));

			nightCard._body.appendChild(periodEditor('night', draft.night));
			dayCard._body.appendChild(periodEditor('day', draft.day));
		}

		/* ---------- 数据加载（AT+SCHED?） ---------- */

		function draftFromConfig(c) {
			return {
				check_interval: toNum(pick(c, 'check_interval', null)),
				timeout: toNum(pick(c, 'timeout', null)),
				unlock_lte: !!pick(c, 'unlock_lte', false),
				unlock_nr: !!pick(c, 'unlock_nr', false),
				toggle_airplane: !!pick(c, 'toggle_airplane', false),
				night: periodOf(pick(c, 'night', {})),
				day: periodOf(pick(c, 'day', {}))
			};
		}

		function fetchStatus() {
			return AtWs.client.sendCommand('AT+SCHED?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseScheduleResponse(res.data);
					if (parsed) cfg = parsed;
				}
			}).catch(function () { /* 状态轮询失败不打扰正在填写的表单 */ });
		}

		function reload() {
			return fetchStatus().then(function () {
				draft = (cfg && cfg.enabled) ? draftFromConfig(cfg) : null;
				buildForm();
				renderStatus();
				return true;
			});
		}

		/* ---------- 保存（AT+SCHED=<json>） ---------- */

		function HHMM(str) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(str || '')); }

		function setBusy(v) {
			busy = v;
			saveBtn.disabled = !!v;
			resetBtn.disabled = !!v;
			saveBtn.textContent = v ? '保存中…' : '保存编排';
		}

		function save() {
			if (busy) return;
			if (!draft) { Mt5700.error('总开关未启用，或配置尚未加载'); return; }

			try {
				var interval = toNum(draft.check_interval);
				if (interval == null) throw new Error('请填写检测间隔（秒）');
				if (interval < 10) throw new Error('检测间隔不能小于 10 秒');

				var timeout = toNum(draft.timeout);
				if (timeout == null) throw new Error('请填写无服务超时（秒）');
				if (timeout < 30) throw new Error('无服务超时不能小于 30 秒');

				/* 时段边界无论如何都要合法：后端要用它算「当前属于哪一段」，
				 * 留空会让夜间/日间的划分失去依据，所以即使该时段停用也要求填。 */
				if (!HHMM(draft.night.start) || !HHMM(draft.night.end)) {
					throw new Error('夜间时段请按 HH:MM 填写（例如 22:00 至 06:00）');
				}

				var payload = {
					enabled: true,
					check_interval: interval,
					timeout: timeout,
					unlock_lte: !!draft.unlock_lte,
					unlock_nr: !!draft.unlock_nr,
					toggle_airplane: !!draft.toggle_airplane,
					night: {
						enabled: !!draft.night.enabled,
						start: draft.night.start,
						end: draft.night.end,
						lte: Parse.toLockLists('lte', draft.night.lte.type, draft.night.lte.items),
						nr: Parse.toLockLists('nr', draft.night.nr.type, draft.night.nr.items)
					},
					day: {
						enabled: !!draft.day.enabled,
						lte: Parse.toLockLists('lte', draft.day.lte.type, draft.day.lte.items),
						nr: Parse.toLockLists('nr', draft.day.nr.type, draft.day.nr.items)
					}
				};
				var cmd = Parse.buildScheduleSetCommand(payload);

				setBusy(true);
				AtWs.client.sendCommand(cmd).then(function (res) {
					if (!res.success) throw new Error(String(res.error || '保存定时锁频配置失败'));
					Mt5700.success('已保存到后台调度，页面可以关掉，到点自动切换');
					return reload();
				}).catch(function (err) {
					Mt5700.error((err && err.message) || '保存失败');
				}).then(function () { setBusy(false); });
			} catch (err) {
				Mt5700.error((err && err.message) || '保存失败');
			}
		}

		/* ---------- 渲染 ---------- */

		function metric(label, value, color) {
			var box = E('div', { 'class': 'mt5700-metric' });
			box.appendChild(E('div', { 'class': 'mt5700-metric-label' }, label));
			box.appendChild(E('div', { 'class': 'mt5700-metric-value' + (color ? ' ' + color : '') }, value));
			return box;
		}

		/* 后端 status.current_mode 给的是时段标识（night/day），直接回显成英文太生硬 */
		function modeText(mode) {
			var m = String(mode == null ? '' : mode).trim().toLowerCase();
			if (m === 'night') return '夜间';
			if (m === 'day') return '日间';
			if (m === '' || m === 'none' || m === 'unlocked') return '不锁频';
			return String(mode);
		}

		/*
		 * 秒数 → 人话。只用于「距下次切换」这种最长一天的间隔，
		 * 因此不处理月/年，超过一小时也只说「N 小时 M 分」。
		 */
		function humanSpan(sec) {
			var s = Number(sec);
			if (!isFinite(s) || s < 0) return '';
			if (s < 60) return s + ' 秒';
			var m = Math.floor(s / 60);
			if (m < 60) return m + ' 分钟';
			var h = Math.floor(m / 60);
			return h + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
		}

		/* "2026-10-31 22:00" → "10-31 22:00"，指标卡里不需要年份 */
		function shortStamp(v) {
			var s = String(v == null ? '' : v);
			return s.length >= 16 ? s.slice(5, 16) : s;
		}

		/* 时段端点跨零点时下一次切换在明天，只显示 HH:MM 会被误读成今天 */
		function dayWord(serverTime, nextTime) {
			var a = String(serverTime || '').slice(0, 10);
			var b = String(nextTime || '').slice(0, 10);
			if (!a || !b) return '';
			return a === b ? '今天' : '明天';
		}

		function renderStatus() {
			var st = (cfg && cfg.status) ? cfg.status : null;

			statusGrid.innerHTML = '';
			statusGrid.appendChild(metric('总开关', cfg && cfg.enabled ? '已启用' : '未启用',
				cfg && cfg.enabled ? 'success' : ''));
			statusGrid.appendChild(metric('当前时段', st ? modeText(st.current_mode) : '—', 'accent'));
			statusGrid.appendChild(metric('下次切换', st ? (st.next_switch || '—') : '—'));
			statusGrid.appendChild(metric('已切换次数', st && st.switch_count != null ? String(st.switch_count) : '0'));

			/*
			 * 时间口径全部来自后端（插件自己的时间源，NTP 优先），
			 * 不用浏览器时钟：手机时区设错、系统时间偏了都会让「下次切换」
			 * 显示成一段毫无意义的相对时间。
			 */
			var clock = [];
			if (st && st.server_time) clock.push('插件时间 ' + st.server_time);
			if (st && st.next_switch_time) {
				var span = humanSpan(st.next_switch_in);
				clock.push('下次切换 ' + shortStamp(st.next_switch_time) +
					'（' + dayWord(st.server_time, st.next_switch_time) +
					(span ? '，还有 ' + span : '') + '）');
			}
			statusClock.textContent = clock.join(' · ');
			statusClock.hidden = !clock.length;

			if (cfg && !st) {
				statusNote.textContent = '后端暂未返回 status 段（多为刚起步或后端未实现该字段）。';
			} else if (st && st.applied === false) {
				statusNote.textContent = '编排已保存，等待后台调度按当前时段下发到模组。';
			} else {
				statusNote.textContent = '';
			}
			// 没有话要说时把整行收掉，避免给指标卡下面留一条 4px 的空隙
			statusNote.hidden = statusNote.textContent === '';

			// 未启用：只留空态卡，表单相关全部收起
			var enabled = !!(cfg && cfg.enabled);
			lockedCard.style.display = enabled ? 'none' : '';
			paramCard.style.display = enabled ? '' : 'none';
			periodRow.style.display = enabled ? '' : 'none';
			actionBar.style.display = enabled ? '' : 'none';
		}

		/* ---------- 初始化 ---------- */

		statusGrid.appendChild(Mt5700.loading('正在读取编排配置…'));

		Ui.startup(body, function () {
			reload();
		});

		/*
		 * 状态每 15 秒轮询一次，但**只刷新状态卡，不重建表单**：
		 * 表单每次重建都会夺走正在输入的焦点，而 draft 才是正在编辑的值，
		 * 刷新 GET 到的数据不该覆盖它。要覆盖时用户会显式按「放弃修改并重载」。
		 * Ui.interval 已随 hash 路由切换自动 clear，无需再挂 onLeave。
		 */
		Ui.interval(15000, function () {
			fetchStatus().then(renderStatus);
		});

		return page;
	}
});
