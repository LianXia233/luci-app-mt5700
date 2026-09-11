'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Parse, Ui */

/**
 * 定时锁频编排（原 WebUI 网络 → 定时锁频）
 * 等价迁移 network/SchedulePanel.tsx：
 * - 运行状态：当前时段 / 下次切换 / 已切换次数（AT+SCHED? 返回 status）
 * - 编排表单：检测间隔、无服务超时、解锁时是否下发 LTE/NR 解锁、切换飞行模式
 * - 夜间/日间两时段：各自 4G/5G 锁频（类型、移动性、频段/频点/PCI/SCS）
 * - 保存走伪命令 AT+SCHED=<json>，后端写 UCI 并热生效（等价 schedconfig.go）
 */

return L.view.extend({
	render: function () {
		var page = Ui.page('定时锁频编排', '按夜间/日间时段自动切换锁频，配置存 UCI 并由后端调度生效');
		var body = page._body;
		Ui.renderConnectionBar(body);

		var cfg = null;
		var draft = null;
		var busy = false;
		var expanded = false;

		var statusPanel = Ui.panel('运行状态', '');
		var statusLine = E('div', { 'class': 'at-tags' });
		statusPanel._body.appendChild(statusLine);
		body.appendChild(statusPanel);

		var formPanel = Ui.panel('编排配置', '总开关在「服务 → 模组管理 → 服务配置」的 schedule_enabled，启用后此页才可编辑');
		formPanel.style.display = 'none';
		body.appendChild(formPanel);

		/* ---------- 时段编辑 ---------- */

		function periodEditor(which, p) {
			var wrap = E('div', { 'class': 'at-period' });
			var head = E('h4', {}, which === 'night' ? '夜间模式' : '日间模式');
			wrap.appendChild(head);

			var enabledChk = document.createElement('input');
			enabledChk.type = 'checkbox';
			enabledChk.className = 'cbi-input-checkbox';
			enabledChk.checked = !!p.enabled;
			enabledChk.addEventListener('change', function () { p.enabled = enabledChk.checked; });
			wrap.appendChild(Ui.field('启用', enabledChk));

			if (which === 'night') {
				var startInput = document.createElement('input');
				startInput.className = 'cbi-input-text';
				startInput.style.width = '90px';
				startInput.placeholder = '22:00';
				startInput.value = p.start || '22:00';
				startInput.addEventListener('input', function () { p.start = startInput.value; });
				var endInput = document.createElement('input');
				endInput.className = 'cbi-input-text';
				endInput.style.width = '90px';
				endInput.placeholder = '06:00';
				endInput.value = p.end || '06:00';
				endInput.addEventListener('input', function () { p.end = endInput.value; });
				var row = E('div', { 'class': 'at-inline' });
				row.appendChild(startInput);
				row.appendChild(E('span', { 'class': 'at-hint' }, '至'));
				row.appendChild(endInput);
				wrap.appendChild(Ui.field('夜间时段', row, '跨零点有效，其余时间按日间模式'));
			}

			wrap.appendChild(kindEditor(which, 'lte', p.lte));
			wrap.appendChild(kindEditor(which, 'nr', p.nr));
			return wrap;
		}

		function kindEditor(which, kind, lists) {
			var wrap = E('div', { 'class': 'at-period-kind' });
			var title = E('h5', {}, (kind === 'lte' ? '4G 锁频' : '5G 锁频') + '（' + (which === 'night' ? '夜间' : '日间') + '）');
			wrap.appendChild(title);

			var typeSel = document.createElement('select');
			typeSel.className = 'cbi-input-select';
			Parse.LOCK_TYPES.forEach(function (o) {
				var opt = document.createElement('option');
				opt.value = String(o.value); opt.textContent = o.label;
				if (lists.type === o.value) opt.selected = true;
				typeSel.appendChild(opt);
			});
			typeSel.addEventListener('change', function () {
				lists.type = parseInt(typeSel.value, 10);
				renderItems();
			});
			wrap.appendChild(Ui.field('类型', typeSel));

			var itemsWrap = E('div', { 'class': 'at-lock-items' });
			wrap.appendChild(itemsWrap);

			function rowFor(item, index) {
				var row = E('div', { 'class': 'at-lock-item' });
				var bandSel = document.createElement('select');
				bandSel.className = 'cbi-input-select';
				bandSel.appendChild(document.createElement('option'));
				(kind === 'lte' ? Parse.LTE_BANDS : Parse.NR_BANDS).forEach(function (b) {
					var opt = document.createElement('option');
					opt.value = String(b.value); opt.textContent = b.label;
					if (String(item.band) === String(b.value)) opt.selected = true;
					bandSel.appendChild(opt);
				});
				bandSel.addEventListener('change', function () { item.band = bandSel.value ? Number(bandSel.value) : null; });
				row.appendChild(E('label', {}, '频段'));
				row.appendChild(bandSel);

				var arfcn = document.createElement('input');
				arfcn.type = 'text';
				arfcn.className = 'cbi-input-text';
				arfcn.placeholder = '频点';
				arfcn.value = item.arfcn != null ? String(item.arfcn) : '';
				arfcn.addEventListener('input', function () { item.arfcn = arfcn.value.trim(); });
				row.appendChild(E('label', {}, '频点'));
				row.appendChild(arfcn);

				if (kind === 'nr') {
					var scs = document.createElement('select');
					scs.className = 'cbi-input-select';
					scs.appendChild(document.createElement('option'));
					Parse.SCS_TYPES.forEach(function (o) {
						var opt = document.createElement('option');
						opt.value = String(o.value); opt.textContent = o.label;
						if (String(item.scs) === String(o.value)) opt.selected = true;
						scs.appendChild(opt);
					});
					scs.addEventListener('change', function () { item.scs = scs.value ? Number(scs.value) : null; });
					row.appendChild(E('label', {}, 'SCS'));
					row.appendChild(scs);
				}

				var pci = document.createElement('input');
				pci.type = 'text';
				pci.className = 'cbi-input-text';
				pci.placeholder = 'PCI';
				pci.value = item.pci != null ? String(item.pci) : '';
				pci.addEventListener('input', function () { item.pci = pci.value.trim(); });
				row.appendChild(E('label', {}, 'PCI'));
				row.appendChild(pci);

				var del = Ui.button('删除', 'cbi-button-negative', function () {
					lists.items.splice(index, 1);
					if (!lists.items.length) lists.items.push({});
					renderItems();
				});
				row.appendChild(del);
				return row;
			}

			function renderItems() {
				itemsWrap.innerHTML = '';
				var items = lists.items || [{}];
				lists.items = items;
				if (lists.type === 0) {
					itemsWrap.appendChild(E('div', { 'class': 'at-empty' }, '关闭：不锁频'));
					return;
				}
				for (var i = 0; i < items.length; i++) itemsWrap.appendChild(rowFor(items[i], i));
				var addBtn = Ui.button('+ 添加', 'cbi-button-action', function () {
					if (items.length >= Parse.MAX_LOCK_ITEMS) { Ui.warning('最多只能锁 ' + Parse.MAX_LOCK_ITEMS + ' 组'); return; }
					items.push({});
					renderItems();
				});
				itemsWrap.appendChild(addBtn);
			}
			renderItems();
			return wrap;
		}

		/* ---------- 表单 ---------- */

		var checkIntervalInput = null, timeoutInput = null;
		var unlockLteChk = null, unlockNrChk = null, toggleAirplaneChk = null;
		var nightWrap = null, dayWrap = null;

		function buildForm() {
			formPanel._body.innerHTML = '';
			if (!draft) return;

			checkIntervalInput = document.createElement('input');
			checkIntervalInput.type = 'number';
			checkIntervalInput.className = 'cbi-input-text';
			checkIntervalInput.min = 10;
			checkIntervalInput.value = String(draft.check_interval);
			checkIntervalInput.addEventListener('input', function () { draft.check_interval = Number(checkIntervalInput.value) || 10; });
			formPanel._body.appendChild(Ui.field('检测间隔（秒）', checkIntervalInput, '多久检查一次当前时段'));

			timeoutInput = document.createElement('input');
			timeoutInput.type = 'number';
			timeoutInput.className = 'cbi-input-text';
			timeoutInput.min = 30;
			timeoutInput.value = String(draft.timeout);
			timeoutInput.addEventListener('input', function () { draft.timeout = Number(timeoutInput.value) || 30; });
			formPanel._body.appendChild(Ui.field('无服务超时（秒）', timeoutInput, '模组无服务超过此时长自动解锁'));

			unlockLteChk = document.createElement('input');
			unlockLteChk.type = 'checkbox';
			unlockLteChk.className = 'cbi-input-checkbox';
			unlockLteChk.checked = !!draft.unlock_lte;
			unlockLteChk.addEventListener('change', function () { draft.unlock_lte = unlockLteChk.checked; });
			formPanel._body.appendChild(Ui.field('解锁时下发 LTE 解锁', unlockLteChk));

			unlockNrChk = document.createElement('input');
			unlockNrChk.type = 'checkbox';
			unlockNrChk.className = 'cbi-input-checkbox';
			unlockNrChk.checked = !!draft.unlock_nr;
			unlockNrChk.addEventListener('change', function () { draft.unlock_nr = unlockNrChk.checked; });
			formPanel._body.appendChild(Ui.field('解锁时下发 NR 解锁', unlockNrChk));

			toggleAirplaneChk = document.createElement('input');
			toggleAirplaneChk.type = 'checkbox';
			toggleAirplaneChk.className = 'cbi-input-checkbox';
			toggleAirplaneChk.checked = !!draft.toggle_airplane;
			toggleAirplaneChk.addEventListener('change', function () { draft.toggle_airplane = toggleAirplaneChk.checked; });
			formPanel._body.appendChild(Ui.field('切换飞行模式使其生效', toggleAirplaneChk));

			nightWrap = periodEditor('night', draft.night);
			dayWrap = periodEditor('day', draft.day);
			formPanel._body.appendChild(nightWrap);
			formPanel._body.appendChild(dayWrap);

			var actions = E('div', { 'class': 'at-panel-actions' });
			var saveBtn = Ui.primaryButton('保存编排', save);
			var collapseBtn = Ui.button('收起', 'cbi-button-action', function () {
				expanded = false;
				render();
			});
			actions.appendChild(saveBtn);
			actions.appendChild(collapseBtn);
			formPanel._body.appendChild(actions);
		}

		/* ---------- 数据加载（AT+SCHED?） ---------- */

		function refreshStatus() {
			return AtWs.client.sendCommand('AT+SCHED?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseScheduleResponse(res.data);
					if (parsed) cfg = parsed;
				}
				render();
			}).catch(function () { render(); });
		}

		function load() {
			return refreshStatus().then(function () {
				if (cfg && cfg.enabled) {
					draft = {
						check_interval: cfg.check_interval,
						timeout: cfg.timeout,
						unlock_lte: cfg.unlock_lte,
						unlock_nr: cfg.unlock_nr,
						toggle_airplane: cfg.toggle_airplane,
						night: {
							enabled: cfg.night.enabled, start: cfg.night.start || '22:00', end: cfg.night.end || '06:00',
							lte: Parse.fromLockLists('lte', cfg.night.lte),
							nr: Parse.fromLockLists('nr', cfg.night.nr)
						},
						day: {
							enabled: cfg.day.enabled,
							lte: Parse.fromLockLists('lte', cfg.day.lte),
							nr: Parse.fromLockLists('nr', cfg.day.nr)
						}
					};
					// fromLockLists 返回数组，需要包一层带 type 的对象
					draft.night.lte = { type: cfg.night.lte.type, items: draft.night.lte };
					draft.night.nr = { type: cfg.night.nr.type, items: draft.night.nr };
					draft.day.lte = { type: cfg.day.lte.type, items: draft.day.lte };
					draft.day.nr = { type: cfg.day.nr.type, items: draft.day.nr };
				}
				render();
			});
		}

		/* ---------- 保存（AT+SCHED=<json>） ---------- */

		function HHMM(str) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(str); }

		function save() {
			if (busy) return;
			busy = true;
			try {
				if (!draft) throw new Error('配置未加载');
				if (!HHMM(draft.night.start) || !HHMM(draft.night.end)) throw new Error('夜间时段请填写 HH:MM 格式，例如 22:00');

				var payload = {
					enabled: true,
					check_interval: draft.check_interval,
					timeout: draft.timeout,
					unlock_lte: draft.unlock_lte,
					unlock_nr: draft.unlock_nr,
					toggle_airplane: draft.toggle_airplane,
					night: {
						enabled: draft.night.enabled, start: draft.night.start, end: draft.night.end,
						lte: Parse.toLockLists('lte', draft.night.lte.type, draft.night.lte.items),
						nr: Parse.toLockLists('nr', draft.night.nr.type, draft.night.nr.items)
					},
					day: {
						enabled: draft.day.enabled,
						lte: Parse.toLockLists('lte', draft.day.lte.type, draft.day.lte.items),
						nr: Parse.toLockLists('nr', draft.day.nr.type, draft.day.nr.items)
					}
				};
				var cmd = Parse.buildScheduleSetCommand(payload);
				AtWs.client.sendCommand(cmd).then(function (res) {
					if (!res.success) throw new Error(String(res.error || '保存定时锁频配置失败'));
					Ui.success('定时锁频配置已保存，下个检测周期生效');
					return load();
				}).catch(function (err) {
					Ui.error((err && err.message) || '保存失败');
				}).finally(function () { busy = false; });
			} catch (err) {
				Ui.error((err && err.message) || '保存失败');
				busy = false;
			}
		}

		/* ---------- 渲染 ---------- */

		function render() {
			// 状态行
			statusLine.innerHTML = '';
			if (cfg && cfg.status) {
				var st = cfg.status;
				statusLine.appendChild(E('span', {}, '当前时段：'));
				statusLine.appendChild(Ui.tag(Parse.modeText(st.current_mode || ''), 'blue'));
				statusLine.appendChild(E('span', { 'class': 'at-hint' }, ' 下次切换：' + (st.next_switch || '—')));
				statusLine.appendChild(E('span', { 'class': 'at-hint' }, ' 已切换 ' + (st.switch_count != null ? st.switch_count : 0) + ' 次'));
				if (st.applied === false) statusLine.appendChild(Ui.tag('配置已更新待生效', 'orange'));
			} else {
				statusLine.appendChild(E('span', { 'class': 'at-hint' }, '暂无运行状态'));
			}

			// 总开关状态
			formPanel.style.display = '';
			if (!cfg || !cfg.enabled || !draft) {
				formPanel.style.display = 'none';
				statusLine.appendChild(E('span', { 'class': 'at-hint' }, ' （定时锁频未启用，请到「服务 → 模组管理 → 服务配置」开启 schedule_enabled）'));
				return;
			}

			formPanel._body.innerHTML = '';
			if (!expanded) {
				var expandBtn = Ui.primaryButton('展开配置', function () {
					expanded = true;
					buildForm();
					render();
				});
				formPanel._body.appendChild(expandBtn);
			} else {
				buildForm();
			}
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
			load();
		});

		// 定时刷新运行状态（不覆盖表单草稿）
		var statusTimer = Ui.interval(15000, function () {
			if (expanded) return;
			AtWs.client.sendCommand('AT+SCHED?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseScheduleResponse(res.data);
					if (parsed) { cfg = parsed; render(); }
				}
			}).catch(function () {});
		});

		this._dispose = function () { clearInterval(statusTimer); };

		return page;
	}
});
