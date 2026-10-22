'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700 */

/**
 * 定时锁频面板 —— 原独立页面 view/at-webserver/schedule.js
 *
 * v2.4.31 归并进「网络设置」：定时锁频与手动锁频是同一条主题（一静一动），
 * 分成两个菜单项只让人来回跳页。菜单项撤掉，但**代码与后端契约一字未动** ——
 * AT+SCHED? / AT+SCHED=<json>、UCI 键名、Rust 调度逻辑全部照旧。
 *
 * 功能（等价迁移原 WebUI network/SchedulePanel.tsx）：
 * - 运行状态：当前时段 / 下次切换 / 已切换次数（AT+SCHED? 返回 status）
 * - 编排表单：检测间隔、无服务超时、解锁时是否下发 LTE/NR 解锁、切换飞行模式
 * - 夜间/日间两时段：各自 4G/5G 锁频（类型、移动性、频段/频点/PCI/SCS）
 * - 保存走伪命令 AT+SCHED=<json>，后端写 UCI 并热生效
 *
 * 对外只有两个入口：render(body) 往容器里挂两张卡；dispose() 清定时器。
 * 不创建 Mt5700.page、不画连接条 —— 那些由宿主页面（网络设置）统一负责。
 */

var SchedulePanel = (function () {
	var api = {};

	/*
	 * 模块级定时器：一个宿主页面只该有一份。
	 * 重复 render（切页回来）前必须先清旧的，否则每来一次就多一个 15s 轮询，
	 * 而 rpcd 是单线程的（红线 63），多出来的轮询会直接拖慢整个 LuCI。
	 */
	var statusTimer = null;

	api.render = function (body) {
		if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }

		var cfg = null;
		var draft = null;
		var busy = false;
		var expanded = false;

		/* ---------- 运行状态卡（含总开关） ---------- */
		var statusCard = Mt5700.card('定时锁频 · 运行状态',
			'按夜间/日间时段自动切换锁频；关闭后后端不再按时段切换');
		var statusCardBody = E('div');
		statusCard._body.appendChild(statusCardBody);
		body.appendChild(statusCard);

		var statusLine = E('div', { 'class': 'mt5700-inline' });
		statusCardBody.appendChild(statusLine);

		/*
		 * 总开关（原在「服务配置」页，现已归位到本面板）：
		 * 开关与配置在同一处，不必再来回跳页；写 UCI 后由后端调度生效。
		 */
		var schedChk = E('input', { type: 'checkbox' });
		var schedSwitch = E('div', { 'class': 'mt5700-switch' });
		schedSwitch.appendChild(schedChk);
		statusCardBody.appendChild(Mt5700.formGroup('启用定时锁频', schedSwitch,
			'关闭后后端不再按时段切换锁频；开启后才能编辑下方编排'));
		schedChk.addEventListener('change', function () {
			var on = schedChk.checked;
			try {
				L.uci.set('at-webserver', 'config', 'schedule_enabled', on ? '1' : '0');
			} catch (e) {
				Mt5700.error('无法写入配置');
				schedChk.checked = !on;
				return;
			}
			AtWs.uci.uciCommit('at-webserver').then(function () {
				Mt5700.success(on ? '定时锁频已启用' : '定时锁频已关闭');
				load();
			}).catch(function () {
				Mt5700.error('保存失败');
				schedChk.checked = !on;
			});
		});

		var formCard = Mt5700.card('定时锁频 · 编排配置',
			'先在「运行状态」卡打开总开关；夜间/日间时段各自独立启用');
		var formBody = E('div');
		formCard._body.appendChild(formBody);
		body.appendChild(formCard);

		/* ---------- 通用小工具 ---------- */

		function mkCheck(onChange) {
			var wrap = E('div', { 'class': 'mt5700-switch' });
			var input = E('input', { type: 'checkbox' });
			if (onChange) input.addEventListener('change', function () { onChange(input.checked); });
			wrap.appendChild(input);
			return wrap;
		}

		/* ---------- 时段编辑 ---------- */

		function periodEditor(which, p) {
			var wrap = E('div', { 'class': 'mt5700-lock-editor' });
			wrap.appendChild(E('div', { 'class': 'mt5700-modal-title' }, which === 'night' ? '夜间模式' : '日间模式'));

			var enabledChk = mkCheck(function (checked) { p.enabled = checked; });
			enabledChk.querySelector('input').checked = !!p.enabled;
			wrap.appendChild(Mt5700.formGroup('启用', enabledChk));

			if (which === 'night') {
				var startInput = Mt5700.input('text', '22:00', p.start || '22:00');
				startInput.style.maxWidth = '110px';
				startInput.addEventListener('input', function () { p.start = startInput.value; });
				var endInput = Mt5700.input('text', '06:00', p.end || '06:00');
				endInput.style.maxWidth = '110px';
				endInput.addEventListener('input', function () { p.end = endInput.value; });
				var row = E('div', { 'class': 'mt5700-inline' });
				row.appendChild(startInput);
				row.appendChild(E('span', { 'class': 'mt5700-hint' }, '至'));
				row.appendChild(endInput);
				wrap.appendChild(Mt5700.formGroup('夜间时段', row, '跨零点有效，其余时间按日间模式'));
			}

			wrap.appendChild(kindEditor(which, 'lte', p.lte));
			wrap.appendChild(kindEditor(which, 'nr', p.nr));
			return wrap;
		}

		function kindEditor(which, kind, lists) {
			var wrap = E('div');
			wrap.appendChild(E('div', { 'class': 'mt5700-hint' },
				(kind === 'lte' ? '4G 锁频' : '5G 锁频') + '（' + (which === 'night' ? '夜间' : '日间') + '）'));

			var typeSel = Mt5700.select(Parse.LOCK_TYPES.map(function (o) {
				return { label: o.label, value: String(o.value) };
			}), String(lists.type));
			typeSel.addEventListener('change', function () {
				lists.type = parseInt(typeSel.value, 10);
				renderItems();
			});
			wrap.appendChild(Mt5700.formGroup('类型', typeSel));

			var itemsWrap = E('div', { 'class': 'mt5700-lock-items' });
			wrap.appendChild(itemsWrap);

			function rowFor(item, index) {
				var row = E('div', { 'class': 'mt5700-lock-item' });

				var bandSel = Mt5700.select([{ label: '（未选择）', value: '' }].concat(
					(kind === 'lte' ? Parse.LTE_BANDS : Parse.NR_BANDS).map(function (b) {
						return { label: b.label, value: String(b.value) };
					})
				), String(item.band == null ? '' : item.band));
				bandSel.addEventListener('change', function () { item.band = bandSel.value ? Number(bandSel.value) : null; });
				row.appendChild(bandSel);

				var arfcn = Mt5700.input('text', '频点', item.arfcn != null ? String(item.arfcn) : '');
				arfcn.addEventListener('input', function () { item.arfcn = arfcn.value.trim(); });
				row.appendChild(arfcn);

				if (kind === 'nr') {
					var scs = Mt5700.select([{ label: '（自动）', value: '' }].concat(Parse.SCS_TYPES.map(function (o) {
						return { label: o.label, value: String(o.value) };
					})), String(item.scs == null ? '' : item.scs));
					scs.addEventListener('change', function () { item.scs = scs.value ? Number(scs.value) : null; });
					row.appendChild(scs);
				}

				var pci = Mt5700.input('text', 'PCI', item.pci != null ? String(item.pci) : '');
				pci.addEventListener('input', function () { item.pci = pci.value.trim(); });
				row.appendChild(pci);

				var del = Mt5700.button('删除', function () {
					lists.items.splice(index, 1);
					if (!lists.items.length) lists.items.push({});
					renderItems();
				}, 'danger');
				row.appendChild(del);
				return row;
			}

			function renderItems() {
				itemsWrap.innerHTML = '';
				var items = lists.items || [{}];
				lists.items = items;
				if (lists.type === 0) {
					itemsWrap.appendChild(Mt5700.empty('关闭：不锁频'));
					return;
				}
				for (var i = 0; i < items.length; i++) itemsWrap.appendChild(rowFor(items[i], i));
				var addBtn = Mt5700.button('+ 添加', function () {
					if (items.length >= Parse.MAX_LOCK_ITEMS) {
						Mt5700.warning('最多只能锁 ' + Parse.MAX_LOCK_ITEMS + ' 组');
						return;
					}
					items.push({});
					renderItems();
				}, 'ghost');
				itemsWrap.appendChild(addBtn);
			}
			renderItems();
			return wrap;
		}

		/* ---------- 表单 ---------- */

		function buildForm() {
			formBody.innerHTML = '';
			if (!draft) return;

			var checkIntervalInput = Mt5700.input('number', '10', String(draft.check_interval));
			checkIntervalInput.min = 10;
			/* min 属性只在表单提交时生效，这里没有表单 —— 键入 1 或 -5 会直接进 AT+SCHED 载荷，
			   后端就按 1 秒周期下发检测，和独占串口上的其它命令抢通道。*/
			checkIntervalInput.addEventListener('input', function () {
				draft.check_interval = Math.max(10, parseInt(checkIntervalInput.value, 10) || 10);
			});
			/* ★ 失焦时把钳后的值写回控件 —— 与 ui.js 的既定标准同一条：
			   「用户填 1 得到 2，界面必须写 2，否则界面在说谎」。只钳 draft 不回填，
			   输入框会一直显示那个（不会生效的）1。
			   回填只能放 blur，不能放 input：输 "15" 时第一下 "1" 就会被改写成
			   "10"，用户再也输不进 15。 */
			checkIntervalInput.addEventListener('blur', function () {
				checkIntervalInput.value = String(draft.check_interval);
			});
			formBody.appendChild(Mt5700.formGroup('检测间隔（秒）', checkIntervalInput, '多久检查一次当前时段'));

			var timeoutInput = Mt5700.input('number', '30', String(draft.timeout));
			timeoutInput.min = 30;
			timeoutInput.addEventListener('input', function () {
				draft.timeout = Math.max(30, parseInt(timeoutInput.value, 10) || 30);
			});
			/* 同「检测间隔」：失焦回填，避免界面显示一个不会下发的值。 */
			timeoutInput.addEventListener('blur', function () {
				timeoutInput.value = String(draft.timeout);
			});
			formBody.appendChild(Mt5700.formGroup('无服务超时（秒）', timeoutInput, '模组无服务超过此时长自动解锁'));

			var unlockLte = mkCheck(function (checked) { draft.unlock_lte = checked; });
			unlockLte.querySelector('input').checked = !!draft.unlock_lte;
			formBody.appendChild(Mt5700.formGroup('解锁时下发 LTE 解锁', unlockLte));

			var unlockNr = mkCheck(function (checked) { draft.unlock_nr = checked; });
			unlockNr.querySelector('input').checked = !!draft.unlock_nr;
			formBody.appendChild(Mt5700.formGroup('解锁时下发 NR 解锁', unlockNr));

			var toggleAirplane = mkCheck(function (checked) { draft.toggle_airplane = checked; });
			toggleAirplane.querySelector('input').checked = !!draft.toggle_airplane;
			formBody.appendChild(Mt5700.formGroup('切换飞行模式使其生效', toggleAirplane));

			formBody.appendChild(periodEditor('night', draft.night));
			formBody.appendChild(periodEditor('day', draft.day));

			formBody.appendChild(Mt5700.panelActions(
				Mt5700.primaryButton('保存编排', save),
				Mt5700.button('收起', function () {
					expanded = false;
					schedRender();
				}, 'ghost')
			));
		}

		/* ---------- 数据加载（AT+SCHED?） ---------- */

		function refreshStatus() {
			return AtWs.client.sendCommand('AT+SCHED?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseScheduleResponse(res.data);
					if (parsed) cfg = parsed;
				}
				schedRender();
			}).catch(function () { schedRender(); });
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
				schedRender();
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
				/*
				 * 首尾不能相同：后端的时段判断是
				 *   start > end → 跨零点（cur >= start || cur < end）
				 *   否则        → cur >= start && cur < end
				 * 当 start == end 时落到第二个式子，恒为 false —— 夜间模式会静默永不生效，
				 * 用户只会觉得"设了没用"。这里直接拦下并说清原因。
				 */
				if (draft.night.start === draft.night.end) {
					throw new Error('夜间时段的开始与结束时间不能相同（相同会导致该时段永不生效）');
				}

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
					Mt5700.success('定时锁频配置已保存，下个检测周期生效');
					return load();
				}).catch(function (err) {
					Mt5700.error((err && err.message) || '保存失败');
				}).then(function () { busy = false; });
			} catch (err) {
				Mt5700.error((err && err.message) || '保存失败');
				busy = false;
			}
		}

		/* ---------- 渲染 ---------- */

		/* 名字带 sched 前缀：宿主页面 network_settings.js 里另有一套 render，
		   同名函数在合并后极易混淆（本文件就在它眼皮底下被调用）。 */
		function schedRender() {
			// 状态行
			statusLine.innerHTML = '';
			if (cfg && cfg.status) {
				var st = cfg.status;
				statusLine.appendChild(E('span', { 'class': 'mt5700-hint' }, '当前时段：'));
				statusLine.appendChild(Mt5700.badge(Parse.modeText(st.current_mode || ''), 'primary'));
				statusLine.appendChild(E('span', { 'class': 'mt5700-hint' }, ' 下次切换：' + (st.next_switch || '—')));
				statusLine.appendChild(E('span', { 'class': 'mt5700-hint' }, ' 已切换 ' + (st.switch_count != null ? st.switch_count : 0) + ' 次'));
				if (st.applied === false) statusLine.appendChild(Mt5700.badge('配置已更新待生效', 'warning'));
			} else {
				statusLine.appendChild(E('span', { 'class': 'mt5700-hint' }, '暂无运行状态'));
			}

			// 总开关状态：卡片始终显示——未启用时给出可行动的提示，而不是把整张卡藏掉
			formCard.style.display = '';
			formBody.innerHTML = '';
			if (!cfg || !cfg.enabled || !draft) {
				formBody.appendChild(E('div', { 'class': 'mt5700-hint' },
					'定时锁频未启用：打开上方「启用定时锁频」开关后即可编排时段。'));
				return;
			}

			if (!expanded) {
				formBody.appendChild(Mt5700.primaryButton('展开配置', function () {
					expanded = true;
					buildForm();
				}));
			} else {
				buildForm();
			}
		}

		/* ---------- 初始化 ---------- */

		Mt5700.connectThen(function () {
			// 读取总开关（UCI）后再加载状态
			return L.uci.load('at-webserver').catch(function () {});
		}).then(function () {
			try {
				schedChk.checked = (L.uci.get('at-webserver', 'config', 'schedule_enabled') || '0') === '1';
			} catch (e) { /* 读不到就保持未勾选 */ }
			load();
		});

		// 定时刷新运行状态（不覆盖表单草稿）
		statusTimer = setInterval(function () {
			if (expanded) return;
			AtWs.client.sendCommand('AT+SCHED?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseScheduleResponse(res.data);
					if (parsed) { cfg = parsed; schedRender(); }
				}
				/* 只读探测失败：界面保持「—」或原值，下一轮刷新会再试；不弹错是因为一次查询失败不值得打断用户操作 */
			}).catch(function () {});
		}, 15000);

		return statusCard;
	};

	api.dispose = function () {
		if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
	};

	return api;
})();

// 导出（与 parse.js / ui.js / mt5700.js 同一种 LuCI 模块形状）
var SchedulePanelClass = L.Class.extend(SchedulePanel);
if (typeof window !== 'undefined') {
	window.SchedulePanel = new SchedulePanelClass();
}
return SchedulePanelClass;
