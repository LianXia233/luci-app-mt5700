'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 模组设置页面：
 * - 设备信息（ATI / IMEI / 连接模式 AT+CONNECT? / USB 速率）、修改 IMEI（AT^PHYNUM，5 次确认）
 * - SIM 卡：槽位切换（SCICHG + HVSST + CFUN 重启）、热插拔（TDSIMHP）、PIN 状态/操作
 * - 射频与 5G 增强：飞行模式（CFUN）、NR 载波聚合 / VoNR / DSS（NRRCCAPQRY/CFG）
 * - 设备控制：网卡速率（TDPCIELANCFG）、电源管理（TDPMCFG）
 * - 网络系统配置（SYSCFGEX）
 * - 温度保护（THERMAUTOFUN / THERMLD*）
 * - 系统控制：重启（RESET）、恢复出厂（AT&F）
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('模组设置', '硬件信息遥测、SIM/USIM 状态、射频模式与系统重置控制', 'modem_settings', '模组核心 · 硬件控制');
		var body = page._body;

		/* 局部美化样式注入 */
		var modemStyle = E('style', {}, [
			'/* 模组样式增强 */',
			'.mt-modem-grid-compact { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin-bottom: 12px; }',
			'.mt-imei-box { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border: 1px solid var(--mt5700-border); border-radius: 12px; background: rgba(125, 125, 125, 0.03); margin-bottom: 12px; }',
			'.mt-imei-code { font-size: 17px; font-weight: 700; font-family: var(--mt5700-font-mono); letter-spacing: 0.08em; color: var(--mt5700-text); }',
			'.mt-pin-actions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 10px; }',
			'.mt-pin-actions .mt5700-btn { width: 100%; justify-content: center; }',
			'.mt-spec-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--mt5700-divider); }',
			'.mt-spec-row:last-child { border-bottom: none; }',
			'.mt-spec-label { font-size: 13px; color: var(--mt5700-text-secondary); font-weight: 500; flex-shrink: 0; white-space: nowrap; }',
			'.mt-spec-val { font-size: 13.5px; font-weight: 600; color: var(--mt5700-text); text-align: right; }',
			'@media (max-width: 600px) {',
			'  .mt-spec-row { flex-direction: column; align-items: flex-start; gap: 5px; }',
			'  .mt-spec-val { text-align: left; }',
			'}',
			'.mt-therm-badge-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }',
			'.mt-therm-stat-chip { font-size: 12px; padding: 4px 10px; border-radius: 8px; background: rgba(125, 125, 125, 0.06); border: 1px solid var(--mt5700-border); color: var(--mt5700-text-secondary); }',
			/* 网络系统配置 (SYSCFGEX) 紧凑排版优化 */
			'.mt-sys-overview { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 12px; background: linear-gradient(135deg, rgba(139, 92, 246, 0.05), rgba(14, 165, 233, 0.04)); border: 1px solid rgba(139, 92, 246, 0.16); border-radius: 10px; margin-bottom: 8px; }',
			'.mt-sys-stat-item { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; }',
			'.mt-sys-stat-label { color: var(--mt5700-text-secondary); font-size: 11px; }',
			'.mt-sys-tip { font-size: 11.5px; color: var(--mt5700-text-secondary); padding: 5px 10px; border-radius: 8px; background: rgba(14, 165, 233, 0.05); border: 1px solid rgba(14, 165, 233, 0.15); margin-bottom: 8px; line-height: 1.45; }',
			'/* 接入顺序 12 列对称紧凑响应式网格 */',
			'.mt-sys-acq-cards { display: grid; gap: 8px; margin-bottom: 8px; }',
			'@media (min-width: 900px) {',
			'  .mt-sys-acq-cards { grid-template-columns: repeat(12, 1fr); }',
			'  .mt-sys-acq-cards > label:nth-child(1), .mt-sys-acq-cards > label:nth-child(2), .mt-sys-acq-cards > label:nth-child(3), .mt-sys-acq-cards > label:nth-child(4) { grid-column: span 3; }',
			'  .mt-sys-acq-cards > label:nth-child(5), .mt-sys-acq-cards > label:nth-child(6), .mt-sys-acq-cards > label:nth-child(7) { grid-column: span 4; }',
			'}',
			'@media (max-width: 899px) and (min-width: 601px) {',
			'  .mt-sys-acq-cards { grid-template-columns: repeat(2, 1fr); }',
			'  .mt-sys-acq-cards > label:nth-child(7) { grid-column: span 2; }',
			'}',
			'@media (max-width: 600px) {',
			'  .mt-sys-acq-cards { grid-template-columns: 1fr; gap: 6px; }',
			'}',
			'.mt-sys-acq-cards .mt5700-radio-card { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; background: var(--mt5700-card-bg); border: 1px solid var(--mt5700-border); transition: all 0.2s ease; min-height: 38px; }',
			'.mt-sys-acq-cards .mt5700-radio-card:hover { transform: translateY(-1px); border-color: rgba(139, 92, 246, 0.4); box-shadow: 0 3px 10px rgba(139, 92, 246, 0.08); }',
			'.mt-sys-acq-cards .mt5700-radio-card.mt5700-radio-card-active, .mt-sys-acq-cards .mt5700-radio-card:has(input[type="radio"]:checked) { border-color: #8b5cf6; background: linear-gradient(135deg, rgba(139, 92, 246, 0.08), rgba(14, 165, 233, 0.03)); box-shadow: 0 3px 10px rgba(139, 92, 246, 0.12); }',
			'.mt-sys-acq-cards .mt5700-radio-card-dot { margin-top: 0; }',
			'.mt-sys-acq-cards .mt5700-radio-card-body { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex: 1 1 auto; min-width: 0; }',
			'.mt-sys-acq-cards .mt5700-radio-card-head { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; min-width: 0; }',
			'.mt-sys-acq-cards .mt5700-radio-card-title { font-size: 12.5px; font-weight: 600; color: var(--mt5700-text); white-space: nowrap; }',
			'.mt-sys-acq-cards .mt5700-radio-card-badge { font-size: 10px; padding: 0 5px; border-radius: 999px; background: rgba(139, 92, 246, 0.15); color: #7c3aed; font-weight: 600; flex-shrink: 0; }',
			'.mt-sys-acq-cards .mt5700-radio-card-code { font-size: 10px; font-family: var(--mt5700-font-mono); padding: 1px 5px; border-radius: 4px; background: rgba(125, 125, 125, 0.08); color: var(--mt5700-text-secondary); margin-top: 0; flex-shrink: 0; white-space: nowrap; }',
			'/* 左右对称双面板紧凑布局 */',
			'.mt-sys-subpanel { display: flex; flex-direction: column; gap: 8px; padding: 10px 14px; background: rgba(125, 125, 125, 0.025); border: 1px solid var(--mt5700-border); border-radius: 10px; }',
			'.mt-sys-subpanel-title { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; font-size: 13px; font-weight: 700; color: var(--mt5700-text); padding-bottom: 6px; border-bottom: 1px solid var(--mt5700-divider); margin-bottom: 0; }',
			'/* 漫游卡片极简药丸排版 */',
			'.mt-sys-roam-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }',
			'@media (max-width: 600px) { .mt-sys-roam-cards { grid-template-columns: 1fr; } }',
			'.mt-sys-roam-cards .mt5700-radio-card { padding: 6px 10px; border-radius: 8px; min-height: 38px; align-items: center; }',
			'.mt-sys-roam-cards .mt5700-radio-card.mt5700-radio-card-active, .mt-sys-roam-cards .mt5700-radio-card:has(input[type="radio"]:checked) { border-color: #10b981; background: rgba(16, 185, 129, 0.06); }',
			'.mt-sys-roam-cards .mt5700-radio-card-title { font-size: 12px; font-weight: 600; }',
			'/* 服务域卡片极简药丸排版 */',
			'.mt-sys-srv-cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }',
			'.mt-sys-srv-cards > label:nth-child(5) { grid-column: span 2; }',
			'@media (max-width: 600px) { .mt-sys-srv-cards { grid-template-columns: 1fr; } .mt-sys-srv-cards > label:nth-child(5) { grid-column: span 1; } }',
			'.mt-sys-srv-cards .mt5700-radio-card { padding: 6px 10px; border-radius: 8px; min-height: 38px; align-items: center; }',
			'.mt-sys-srv-cards .mt5700-radio-card.mt5700-radio-card-active, .mt-sys-srv-cards .mt5700-radio-card:has(input[type="radio"]:checked) { border-color: #0284c7; background: rgba(2, 132, 199, 0.06); }',
			'.mt-sys-srv-cards .mt5700-radio-card-title { font-size: 12px; font-weight: 600; }',
			'/* 约束提示紧凑化 */',
			'.mt-sys-srv-note { display: flex; align-items: flex-start; gap: 6px; padding: 6px 10px; border-radius: 6px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); color: #b45309; font-size: 11px; line-height: 1.4; margin-top: 4px; }',
			'.mt-sys-srv-note-tag { flex-shrink: 0; font-weight: 700; }',
			'/* 原始参数面板 */',
			'.mt-sys-raw-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px; margin-top: 8px; padding: 10px 12px; border-radius: 8px; background: rgba(125, 125, 125, 0.03); border: 1px dashed var(--mt5700-border); }',
			'/* 系统控制 */',
			'.mt-sysctl { display: flex; flex-direction: column; gap: 12px; }',
			'.mt-sysctl-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border: 1px solid var(--mt5700-border); border-radius: 12px; background: rgba(125, 125, 125, 0.03); transition: border-color .2s ease, box-shadow .2s ease; }',
			'.mt-sysctl-item:hover { border-color: rgba(41, 169, 225, 0.3); }',
			'.mt-sysctl-item.is-warn { border-color: rgba(245, 158, 11, 0.28); background: linear-gradient(135deg, rgba(245, 158, 11, 0.06), rgba(245, 158, 11, 0.02)); }',
			'.mt-sysctl-item.is-warn:hover { border-color: rgba(245, 158, 11, 0.5); }',
			'.mt-sysctl-item.is-danger { border-color: rgba(239, 68, 68, 0.28); background: linear-gradient(135deg, rgba(239, 68, 68, 0.06), rgba(239, 68, 68, 0.02)); }',
			'.mt-sysctl-item.is-danger:hover { border-color: rgba(239, 68, 68, 0.5); }',
			'.mt-sysctl-info { flex: 1 1 auto; min-width: 0; }',
			'.mt-sysctl-name { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 700; color: var(--mt5700-text); }',
			'.mt-sysctl-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }',
			'.mt-sysctl-item.is-warn .mt-sysctl-dot { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15); }',
			'.mt-sysctl-item.is-danger .mt-sysctl-dot { background: #ef4444; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15); }',
			'.mt-sysctl-desc { font-size: 12px; color: var(--mt5700-text-secondary); line-height: 1.55; margin-top: 4px; }',
			'.mt-sysctl-item .mt5700-btn { flex: 0 0 auto; min-width: 120px; }',
			'.mt5700-btn-warn { color: #b45309; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.4); }',
			'.mt5700-btn-warn:hover:not(:disabled) { background: rgba(245, 158, 11, 0.18); border-color: rgba(245, 158, 11, 0.6); }'
		].join('\n'));
		body.appendChild(modemStyle);

		/* ---------- 通用小工具 ---------- */
		/* 开关统一走 Ui.switch（带回滚约定，Codex P2），实现与单测在 ui.js 中 */

		function atText(res) {
			if (!res) return '';
			if (typeof res.data === 'string') return res.data;
			if (res.data && typeof res.data.raw === 'string') return res.data.raw;
			return String(res.data || '');
		}

		function send(cmd) {
			return AtWs.client.sendCommand(cmd);
		}

		/* ================= 第一行：设备信息 + 设备标识 (IMEI) ================= */
		var rowDev = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowDev);

		/* 卡片 1-1：设备信息 */
		var devCard = Mt5700.card('硬件规格与链路信息', '模组核心厂商、固件版本、总线模式与链路协商速率');
		var devBody = E('div');
		devCard._body.appendChild(devBody);
		rowDev.appendChild(devCard);

		var dev = { manufacturer: '', model: '', revision: '', imei: '', connectMode: '', usb: '' };

		function renderDev() {
			devBody.innerHTML = '';
			var list = E('div', { style: 'display:flex; flex-direction:column;' });

			function addRow(label, valNode) {
				var row = E('div', { 'class': 'mt-spec-row' });
				row.appendChild(E('span', { 'class': 'mt-spec-label' }, label));
				if (typeof valNode === 'string') {
					row.appendChild(E('span', { 'class': 'mt-spec-val' }, valNode || '—'));
				} else {
					row.appendChild(valNode);
				}
				list.appendChild(row);
			}

			addRow('设备制造商', dev.manufacturer || '—');
			addRow('模组型号', dev.model || '—');
			addRow('固件版本', E('code', { 'class': 'mt5700-mono', style: 'font-weight:600;' }, dev.revision || '—'));

			var connNode = dev.connectMode
				? Mt5700.badge(dev.connectMode, dev.connectMode === '网络连接' ? 'success' : 'info')
				: E('span', { 'class': 'mt-spec-val' }, '—');
			addRow('连接工作模式', connNode);

			var usbNode = dev.usb
				? Mt5700.badge(dev.usb, 'info')
				: E('span', { 'class': 'mt-spec-val' }, '—');
			addRow('USB 链路速率', usbNode);

			devBody.appendChild(list);
		}
		renderDev();

		/* 卡片 1-2：设备标识 (IMEI) */
		var imeiCard = Mt5700.card('设备标识（IMEI）', '模组唯一身份硬件标识，读取自 AT+CGSN');
		var imeiBody = E('div');
		imeiCard._body.appendChild(imeiBody);
		rowDev.appendChild(imeiCard);

		var imeiEl = E('span', { 'class': 'mt-imei-code' }, '—');

		var imeiBox = E('div', { 'class': 'mt-imei-box' });
		var imeiLeft = E('div', { style: 'display:flex; flex-direction:column; gap:4px;' });
		imeiLeft.appendChild(E('span', { style: 'font-size:12px; color:var(--mt5700-text-secondary);' }, '当前设备 IMEI:'));
		imeiLeft.appendChild(imeiEl);
		imeiBox.appendChild(imeiLeft);

		var copyBtn = Mt5700.ghostButton('复制', function () {
			if (!dev.imei) { Mt5700.warning('当前尚未读取到 IMEI'); return; }
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(dev.imei).then(function () {
					Mt5700.success('IMEI 已成功复制到剪贴板');
				});
			} else {
				Mt5700.info('IMEI: ' + dev.imei);
			}
		});
		imeiBox.appendChild(copyBtn);
		imeiBody.appendChild(imeiBox);

		/*
		 * 「修改IMEI」（恢复此前更新中误删除的入口）。
		 * 写入指令 AT^PHYNUM=IMEI,<imei>；改写设备唯一标识属高危操作，
		 * 流程强制 5 次确认：2 次风险告知 → 2 次输入新 IMEI（须为 15 位纯
		 * 数字且通过 Luhn 校验位校验，两次必须完全一致）→ 1 次最终确认，
		 * 弹窗全部使用插件统一弹窗样式（Mt5700.confirm）。
		 */
		imeiBody.appendChild(sysCtlItem(
			'is-danger', '修改设备 IMEI', '高危操作：改写模组出厂唯一硬件标识，需连续 5 次确认（含两次 IMEI 输入一致性校验）。',
			'修改IMEI', 'danger',
			startImeiModify
		));

		/* IMEI 第 15 位是 Luhn 校验位（同 ISO/IEC 7812-1 银行卡算法）：
		 * 从左起第 2、4…14 位翻倍（超过 9 则减 9），全部求和后须能被 10 整除 */
		function luhnValid(imei) {
			var sum = 0;
			for (var i = 0; i < 15; i++) {
				var d = parseInt(imei.charAt(i), 10);
				if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
				sum += d;
			}
			return sum % 10 === 0;
		}

		/* 输入步骤：复用插件确认弹窗（Mt5700.confirm），内嵌数字输入框并即时过滤非法字符 */
		function askImeiInput(message, okText, onValid) {
			var input = Mt5700.input('text', '请输入 15 位数字 IMEI', '');
			input.maxLength = 15;
			input.autocomplete = 'off';
			input.addEventListener('input', function () {
				input.value = input.value.replace(/\D/g, '').slice(0, 15);
			});
			var content = E('div', { style: 'display:flex; flex-direction:column; gap:8px; text-align:left;' }, [
				E('div', {}, message),
				E('div', { style: 'font-size:12px; color:var(--mt5700-text-secondary);' }, '仅允许 15 位纯数字（0-9），末位校验位需通过 Luhn 校验'),
				input
			]);
			Mt5700.confirm(content, function () {
				var v = String(input.value || '').trim();
				if (!/^\d{15}$/.test(v)) {
					Mt5700.error('IMEI 必须为 15 位纯数字，请重新输入');
					askImeiInput(message, okText, onValid);
					return;
				}
				if (!luhnValid(v)) {
					Mt5700.error('IMEI 末位校验位未通过 Luhn 校验，请核对后重新输入');
					askImeiInput(message, okText, onValid);
					return;
				}
				if (v === dev.imei) {
					Mt5700.error('新 IMEI 与当前 IMEI 相同，无需修改');
					askImeiInput(message, okText, onValid);
					return;
				}
				onValid(v);
			}, okText);
		}

		function startImeiModify() {
			if (!dev.imei) { Mt5700.warning('尚未读取到当前 IMEI，请刷新页面后重试'); return; }
			var pending = '';

			function step1() {
				Mt5700.confirm('【确认 1/5】修改 IMEI 属于高风险操作，可能违反当地无线电通信法律法规，并导致设备无法正常使用。是否继续？', step2, '继续（1/5）');
			}
			function step2() {
				Mt5700.confirm('【确认 2/5】IMEI 是模组出厂写入的唯一硬件标识，改写后可能导致无法注册网络、失去官方保修，且操作不可逆。确定继续？', step3, '继续（2/5）');
			}
			function step3() {
				askImeiInput('【确认 3/5】请输入新的 IMEI（第一次）', '继续（3/5）', function (v) {
					pending = v;
					step4();
				});
			}
			function step4() {
				askImeiInput('【确认 4/5】请再次输入新的 IMEI（第二次，需与第一次完全一致）', '继续（4/5）', function (v) {
					if (v !== pending) {
						Mt5700.error('两次输入的 IMEI 不一致，请从第一次输入重新开始');
						step3();
						return;
					}
					step5();
				});
			}
			function step5() {
				Mt5700.confirm('【确认 5/5】最后确认：即将把设备 IMEI 由 ' + dev.imei + ' 修改为 ' + pending + '，此操作不可撤销。确认下发写入指令？', function () {
					send('AT^PHYNUM=IMEI,' + pending).then(function (res) {
						if (res.success) {
							Mt5700.success('IMEI 修改指令已下发');
							/* 回读 IMEI 刷新展示；部分固件需重启模组后新号才生效 */
							send('AT+CGSN').then(function (r) {
								if (r.success && r.data) {
									var m = atText(r).match(/(\d{15})/);
									if (m) { dev.imei = m[1]; imeiEl.textContent = m[1]; }
								}
							}).catch(function () {});
						} else {
							Mt5700.error(Ui.atErrorText(res, 'IMEI 修改失败'));
						}
					}).catch(function () { Mt5700.error('IMEI 修改失败'); });
				}, '确认修改（5/5）');
			}

			step1();
		}

		imeiBody.appendChild(Mt5700.fieldNote(
			'IMEI 为模组出厂写入的唯一设备标识（读取自 AT+CGSN）。「修改IMEI」为高危功能，需连续 5 次确认。',
			[
				'新 IMEI 须为 15 位纯数字、末位校验位通过 Luhn 校验，且不能与当前 IMEI 相同；两次输入完全一致后才会下发写入指令 AT^PHYNUM=IMEI,<imei>。',
				'改写 IMEI 可能违反当地无线电通信法律法规，由此产生的后果需自行承担。'
			]
		));

		/* ================= 第二行：SIM 卡管理 + 射频与 5G 增强 ================= */
		var rowSimRf = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowSimRf);

		/* 卡片 2-1：SIM 卡管理 */
		var simCard = Mt5700.card('SIM / USIM 卡管理', '物理卡槽切换、热插拔支持与 PIN 码安全锁');
		rowSimRf.appendChild(simCard);

		var simStatusRow = E('div', { 'class': 'mt5700-inline', style: 'margin-bottom:12px; gap:8px;' });
		var simSqBadge = Mt5700.badge('SIM: 检查中…', 'neutral');
		var pinStatusBadge = Mt5700.badge('PIN: 检查中…', 'neutral');
		simStatusRow.appendChild(simSqBadge);
		simStatusRow.appendChild(pinStatusBadge);
		simCard._body.appendChild(simStatusRow);

		var simSlotSel = Mt5700.select([
			{ label: '外置 SIM 卡槽 (Slot 0)', value: '0' },
			{ label: '内置 SIM 卡槽 (Slot 1)', value: '1' }
		], '0');
		simSlotSel.addEventListener('change', function () {
			handleSimSwitch(parseInt(simSlotSel.value, 10));
		});
		simCard._body.appendChild(Mt5700.formGroup('SIM 槽位切换', simSlotSel, '切换卡槽将自动重置模组射频'));

		var hpSwitch = Ui.switch(function (checked) { return handleSimHotPlug(checked); });
		var hpChk = hpSwitch.querySelector('input');
		simCard._body.appendChild(Mt5700.formGroup('SIM 卡热插拔', hpSwitch, '开启后模组支持不关机插拔 SIM 卡即时识别'));

		// PIN 码操作按钮组（2x2 网格）
		var pinGroup = E('div', { 'class': 'mt5700-form-group' });
		pinGroup.appendChild(E('label', { 'class': 'mt5700-label' }, 'PIN 安全码操作'));
		var pinGrid = E('div', { 'class': 'mt-pin-actions' });
		pinGrid.appendChild(Mt5700.button('输入 PIN 解锁', function () { pinModal('verify'); }, 'primary'));
		pinGrid.appendChild(Mt5700.button('修改 PIN 码', function () { pinModal('change'); }, 'secondary'));
		pinGrid.appendChild(Mt5700.button('启用 PIN 锁', function () { pinModal('enable'); }, 'secondary'));
		pinGrid.appendChild(Mt5700.button('停用 PIN 锁', function () { pinModal('disable'); }, 'ghost'));
		pinGroup.appendChild(pinGrid);
		simCard._body.appendChild(pinGroup);

		function pinModal(op) {
			var titles = { verify: '输入 PIN 码解锁', change: '修改当前 PIN 码', disable: '停用 PIN 码验证', enable: '启用 PIN 码保护' };
			var fields = [];
			if (op === 'change') {
				fields.push({ key: 'old', label: '当前旧 PIN', type: 'password' });
				fields.push({ key: 'new', label: '新 PIN 码 (4~8位)', type: 'password' });
				fields.push({ key: 'confirm', label: '确认新 PIN', type: 'password' });
			} else {
				fields.push({ key: 'pin', label: '请输入 PIN 码', type: 'password' });
			}
			Ui.promptModal(titles[op], fields, function (values) {
				var cmd;
				if (op === 'verify') cmd = 'AT+CPIN="' + values.pin + '"';
				else if (op === 'change') {
					if (values['new'] !== values.confirm) { Mt5700.error('两次输入的 PIN 码不一致'); return; }
					cmd = 'AT+CPIN="' + values.old + '","' + values['new'] + '"';
				} else if (op === 'disable') cmd = 'AT+CLCK="SC",0,"' + values.pin + '"';
				else cmd = 'AT+CLCK="SC",1,"' + values.pin + '"';
				send(cmd).then(function (res) {
					if (res.success) {
						Mt5700.success('PIN 操作成功');
						fetchPinStatus();
					} else {
						Mt5700.error(Ui.atErrorText(res, 'PIN 码操作失败'));
					}
				}).catch(function () { Mt5700.error('PIN 码操作失败'); });
			});
		}

		function handleSimSwitch(target) {
			Mt5700.confirm('切换 SIM 卡需要重启射频与模组，确定切换到' + (target === 0 ? '外置' : '内置') + ' SIM 卡？', function () {
				var chain = Promise.resolve();
				chain = chain.then(function () { return send('AT^HVSST=1,0'); });
				chain = chain.then(function () { return send('AT^SCICHG=' + target + ',' + (1 - target)); });
				chain = chain.then(function () { return send('AT^HVSST=1,1'); });
				chain = chain.then(function () { return send('AT+CFUN=0'); });
				chain = chain.then(function () { return send('AT+CFUN=1'); });
				chain.then(function () {
					Mt5700.success('正在切换到' + (target === 0 ? '外置' : '内置') + ' SIM 卡，请等待设备重启…');
				}).catch(function () { Mt5700.error('切换 SIM 卡失败'); });
			});
		}

		function handleSimHotPlug(checked) {
			return send('AT^TDSIMHP=' + (checked ? '1' : '0')).then(function (res) {
				if (res.success) {
					Mt5700.success((checked ? '开启' : '关闭') + ' SIM 卡热插拔成功');
					return true;
				}
				Mt5700.error((checked ? '开启' : '关闭') + ' SIM 卡热插拔失败');
				return false;
			}).catch(function () {
				Mt5700.error('SIM 卡热插拔设置失败');
				return false;
			});
		}

		function fetchPinStatus() {
			return send('AT+CPIN?').then(function (res) {
				var ready = false;
				if (res.success && res.data) {
					var m = atText(res).match(/\+CPIN:\s*(\w+)/);
					if (m) {
						ready = m[1] === 'READY';
						pinStatusBadge.textContent = 'PIN: ' + m[1];
						pinStatusBadge.className = 'mt5700-badge ' + (ready ? 'mt5700-badge-success' : 'mt5700-badge-warning');
					}
				}
				if (!ready) {
					pinStatusBadge.textContent = 'PIN: READY';
					pinStatusBadge.className = 'mt5700-badge mt5700-badge-success';
				}
				return send('AT+CLCK="SC",2');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/,(\d+)/);
					if (m) {
						var enabled = m[1] === '1';
						pinStatusBadge.textContent = 'PIN: ' + (enabled ? '已开启锁保护' : '未上锁 (READY)');
					}
				}
			}).catch(function () {});
		}

		/* 卡片 2-2：射频控制与 5G 增强特性 */
		var rfCard = Mt5700.card('射频控制与 5G 增强', '飞行模式、载波聚合 (CA)、动态频谱共享与 VoNR');
		rowSimRf.appendChild(rfCard);

		var airplaneSwitch = Ui.switch(function (checked) {
			return send('AT+CFUN=' + (checked ? '0' : '1')).then(function (res) {
				if (res.success) {
					Mt5700.success((checked ? '开启' : '关闭') + '飞行模式成功');
					return true;
				}
				Mt5700.error((checked ? '开启' : '关闭') + '飞行模式失败');
				return false;
			}).catch(function () {
				Mt5700.error('飞行模式设置失败');
				return false;
			});
		});
		var airplaneChk = airplaneSwitch.querySelector('input');
		rfCard._body.appendChild(Mt5700.formGroup('飞行模式 (CFUN)', airplaneSwitch, '开启后彻底关断射频，适合应急断网排障或重连基站'));

		var caSwitch = Ui.switch(function (checked) {
			return send('AT^NRRCCAPCFG=3,' + (checked ? 1 : 0)).then(function (res) {
				if (res.success) {
					Mt5700.success((checked ? '开启' : '关闭') + '载波聚合成功');
					return true;
				}
				Mt5700.error((checked ? '开启' : '关闭') + '载波聚合失败');
				return false;
			}).catch(function () {
				Mt5700.error('载波聚合设置失败');
				return false;
			});
		});
		var caChk = caSwitch.querySelector('input');
		rfCard._body.appendChild(Mt5700.formGroup('NR 载波聚合 (CA)', caSwitch, '开启后允许多个 5G 载波聚合成倍提升吞吐'));

		var dssSwitch = Ui.switch(function (checked) {
			return send('AT^NRRCCAPCFG=5,' + (checked ? 1 : 0) + ',0').then(function (res) {
				if (res.success) {
					Mt5700.success('DSS 配置成功');
					return true;
				}
				Mt5700.error('DSS 配置失败');
				return false;
			}).catch(function () {
				Mt5700.error('DSS 配置失败');
				return false;
			});
		});
		var dssChk = dssSwitch.querySelector('input');
		rfCard._body.appendChild(Mt5700.formGroup('NR 动态频谱共享 (DSS)', dssSwitch, '允许 4G LTE 与 5G NR 动态共用同一频谱'));

		var vonrSel = Mt5700.select([
			{ label: '关闭 VoNR (回落 EPS FB)', value: '0' },
			{ label: 'FR1-VoNR (Sub-6G 超清语音)', value: '1' },
			{ label: 'FR2-VoNR (毫米波超清语音)', value: '2' },
			{ label: 'FR1 + FR2 全频段 VoNR', value: '3' }
		], '0');
		vonrSel.addEventListener('change', function () {
			send('AT^NRRCCAPCFG=2,' + parseInt(vonrSel.value, 10)).then(function (res) {
				if (res.success) Mt5700.success('VoNR 配置成功');
				else Mt5700.error('VoNR 配置失败');
			}).catch(function () { Mt5700.error('VoNR 配置失败'); });
		});
		rfCard._body.appendChild(Mt5700.formGroup('VoNR 超清语音通话', vonrSel, '5G 原生语音通道，开启后无需回落 4G'));

		function fetchNRCapability() {
			return send('AT^NRRCCAPQRY=3').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^NRRCCAPQRY:\s*3,(\d+)/);
					if (m) caChk.checked = m[1] === '1';
				}
				return send('AT^NRRCCAPQRY=2');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^NRRCCAPQRY:\s*2,(\d+)/);
					if (m) vonrSel.value = String(parseInt(m[1], 10));
				}
				return send('AT^NRRCCAPQRY=5');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^NRRCCAPQRY:\s*5,(\d+),(\d+)/);
					if (m) dssChk.checked = m[1] === '1';
				}
			}).catch(function () {});
		}

		/* ================= 第三行：硬件控制与低功耗节能 ================= */
		var ctrlCard = Mt5700.card('硬件控制与能耗管理', 'PCIe 板载网口 PHY 类型与 PCIe 控制器功耗开关（手册 11.19 / 11.16）');
		body.appendChild(ctrlCard);

		var ctrlGrid = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		ctrlCard._body.appendChild(ctrlGrid);

		/* 手册 11.19.3：^TDPCIELANCFG 设置的是 **PCIe 总线所连网口 PHY 芯片类型**，
		 * 只有两个合法值 —— 1 = RTL8111（1G，默认）、2 = RTL8125（2.5G）；
		 * 手册没有「自动协商」「100M」「10M」这些档位，早先的 0/1/2/3 四项里
		 * 0 与 3 会被模组直接拒（+CME ERROR），2 也不是百兆而是 2.5G。
		 * 属性：掉电保存 Y、无需 PIN（11.19.4）。 */
		var nicSel = Mt5700.select([
			{ label: 'RTL8111 · 1G（默认）', value: '1' },
			{ label: 'RTL8125 · 2.5G', value: '2' }
		], '1');
		nicSel.addEventListener('change', function () { handleSetNic(parseInt(nicSel.value, 10)); });
		ctrlGrid.appendChild(Mt5700.formGroup('板载网口 PHY 类型', nicSel, '选择 PCIe 总线上连接的 PHY 芯片（1=RTL8111 1G / 2=RTL8125 2.5G），选错会导致网口不(link)，掉电保存'));

		/* 手册 11.16：^TDPMCFG=<mode>,<mode>,<mode>,<mode> 四个参数缺一不可
		 * （11.16.5 例句 AT^TDPMCFG=1,0,0,0），目前只有 byte[0] 有效，控制
		 * **PCIe 控制器**：1=打开（功耗上升）、0=关闭（省电，但 PCIe 上的
		 * 板载网口随之不可用）。其余三位手册明确是保留位，恒填 0。
		 * 早先这里只发 AT^TDPMCFG=1，参数不足会报错；文案也把它说成
		 * 「无业务时自动进入低功耗待机」，与手册语义正好相反。 */
		var pwrSwitch = Ui.switch(function (checked) {
			return send('AT^TDPMCFG=' + (checked ? '1' : '0') + ',0,0,0').then(function (res) {
				if (res.success) {
					Mt5700.success((checked ? '打开' : '关闭') + ' PCIe 控制器成功');
					return true;
				}
				Mt5700.error((checked ? '打开' : '关闭') + ' PCIe 控制器失败');
				return false;
			}).catch(function () {
				Mt5700.error('PCIe 控制器设置失败');
				return false;
			});
		});
		var pwrChk = pwrSwitch.querySelector('input');
		ctrlGrid.appendChild(Mt5700.formGroup('PCIe 控制器功耗', pwrSwitch, '开启=PCIe 控制器工作（高性能、功耗上升）；关闭=省电，但经 PCIe 连接的板载网口会一并失效（手册 11.16.2，掉电保存）'));

		function handleSetNic(value) {
			/* 手册只认 1/2，其它值不发下去，避免白跑一条注定报错的命令 */
			if (value !== 1 && value !== 2) {
				Mt5700.error('PHY 类型只能是 1（RTL8111）或 2（RTL8125）');
				return;
			}
			send('AT^TDPCIELANCFG=' + value).then(function (res) {
				if (!res.success) { Mt5700.error('网口 PHY 类型设置失败'); return; }
				Mt5700.success('网口 PHY 类型已设置（掉电保存）');
				/* 手册 11.19 没有规定生效时机；换 PHY 驱动通常需要重连链路，
				 * 因此把重启作为**可选项**询问，而不是当成必须步骤写死。 */
				Mt5700.confirm('是否立即重启模组以便重新协商链路？', function () {
					send('AT^RESET').then(function (r) {
						if (r.success) Mt5700.success('重启指令已发送');
						else Mt5700.error('重启指令发送失败');
					});
				}, '立即重启');
			}).catch(function () { Mt5700.error('网口 PHY 类型设置失败'); });
		}

		/* ================= 第四行：网络系统配置 SYSCFGEX ================= */
		var sysCard = Mt5700.card('网络系统配置 (SYSCFGEX)', '配置模组网络制式接入顺序、频段范围、漫游及服务域');
		var sysBody = E('div');
		sysCard._body.appendChild(sysBody);
		body.appendChild(sysCard);

		/* 顶部配置概览条 */
		var sysOverview = E('div', { 'class': 'mt-sys-overview' });
		sysBody.appendChild(sysOverview);

		sysBody.appendChild(E('div', { 'class': 'mt-sys-tip' },
			'💡 设置保存在模组 NVRAM 掉电不丢失，保存后模组将重新驻网（约 10~30 秒）；建议保持「5G 优先，逐级回落」。'
		));

		var sysCfg = { acqorder: '', band: '', roam: 1, srvdomain: 2, lteband: '' };

		var ACQ_OPTIONS = [
			{ value: '080302', code: '08→03→02', label: '5G 优先，逐级回落', badge: '推荐' },
			{ value: '08', code: '08', label: '仅 5G (SA)' },
			{ value: '0302', code: '03→02', label: '4G 优先，回落 3G' },
			{ value: '03', code: '03', label: '仅 4G (LTE)' },
			{ value: '0203', code: '02→03', label: '3G 优先，回落 4G' },
			{ value: '02', code: '02', label: '仅 3G' },
			{ value: '99', code: '99', label: '保持当前设置' }
		];

		var acqCards = Mt5700.radioCards('acq', ACQ_OPTIONS, '080302', function (v) {
			sysCfg.acqorder = v;
			sysRawAcq.setValue(v);
			applySrvConstraint();
			updateSysOverview();
		});
		acqCards.classList.add('mt-sys-acq-cards');

		var acqCustomEl = E('div', { 'class': 'mt5700-hint', style: 'display:none; margin-bottom:6px;' });

		sysBody.appendChild(Mt5700.formGroup('网络接入顺序 (Acquisition Order)', acqCards));
		sysBody.appendChild(acqCustomEl);

		/* 左右两栏布局：左侧频段限制，右侧漫游与服务域 */
		var sysDualGrid = E('div', { 'class': 'mt5700-grid mt5700-grid-2', style: 'margin-top: 8px;' });
		sysBody.appendChild(sysDualGrid);

		/* 左栏：频段范围限制 */
		var bandPanel = E('div', { 'class': 'mt-sys-subpanel' });
		var bandTitle = E('div', { 'class': 'mt-sys-subpanel-title' }, [
			E('span', {}, '📶 频段掩码限制'),
			Mt5700.badge('硬件射频过滤', 'neutral')
		]);
		bandPanel.appendChild(bandTitle);

		var BAND_PRESETS = [
			{ value: '', label: '不修改（保持模组当前设置）' },
			{ value: '00680380', label: '自动（由模组按运营商选择）' },
			{ value: '3FFFFFFF', label: '全部频段（GSM / WCDMA 全频段）' },
			{ value: '2000000680380', label: 'WCDMA 900 + WCDMA 1700 + 自动' }
		];
		var bandSel = Mt5700.select(BAND_PRESETS, '');
		bandSel.addEventListener('change', function () {
			sysCfg.band = bandSel.value;
			sysRawBand.setValue(bandSel.value);
			updateSysOverview();
		});
		bandPanel.appendChild(Mt5700.formGroup('2G / 3G 频段设置', bandSel, '模组 2G/3G 频段范围，建议保持「自动」'));

		var LTE_PRESETS = [
			{ value: '', label: '不修改（保持模组当前设置）' },
			{ value: '1E200000095', label: '常用频段（BC1/3/5/8/34/38/39/40/41）' },
			{ value: '7FFFFFFFFFFFFFFF', label: '全部 LTE 频段' }
		];
		var lteBandSel = Mt5700.select(LTE_PRESETS, '');
		lteBandSel.addEventListener('change', function () {
			sysCfg.lteband = lteBandSel.value;
			sysRawLte.setValue(lteBandSel.value);
			updateSysOverview();
		});
		bandPanel.appendChild(Mt5700.formGroup('4G / LTE 频段设置', lteBandSel, '建议选择「常用频段」，全频段会延长首次搜网时间'));
		sysDualGrid.appendChild(bandPanel);

		/* 右栏：漫游策略与服务域 */
		var srvPanel = E('div', { 'class': 'mt-sys-subpanel' });
		var srvTitle = E('div', { 'class': 'mt-sys-subpanel-title' }, [
			E('span', {}, '🌐 漫游与服务域策略'),
			Mt5700.badge('核心网策略', 'info')
		]);
		srvPanel.appendChild(srvTitle);

		/* 漫游卡片 */
		var ROAM_OPTIONS = [
			{ value: '1', label: '允许漫游', badge: '推荐' },
			{ value: '0', label: '禁止漫游' },
			{ value: '2', label: '不修改' }
		];
		var roamCards = Mt5700.radioCards('roam', ROAM_OPTIONS, '1', function (v) {
			sysCfg.roam = parseInt(v, 10);
			sysRawRoam.setValue(v);
			updateSysOverview();
		});
		roamCards.classList.add('mt-sys-roam-cards');
		srvPanel.appendChild(Mt5700.formGroup('网络漫游控制 (Roaming)', roamCards));

		/* 服务域卡片 */
		var SRV_OPTIONS = [
			{ value: '2', label: '语音 + 数据', badge: '推荐' },
			{ value: '1', label: '仅数据 (纯上网)' },
			{ value: '0', label: '仅语音 (受限)' },
			{ value: '3', label: '不限 (网络决定)' },
			{ value: '4', label: '不修改' }
		];
		var srvNote = E('div', { 'class': 'mt-sys-srv-note', style: 'display:none;' }, [
			E('span', { 'class': 'mt-sys-srv-note-tag' }, '⚠️ 约束提示:'),
			E('span', {}, '当前接入制式包含 4G 或 5G，官方规范已自动禁用「仅语音」和「不限」。')
		]);

		var srvCards = Mt5700.radioCards('srv', SRV_OPTIONS, '2', function (v) {
			sysCfg.srvdomain = parseInt(v, 10);
			sysRawSrv.setValue(v);
			updateSysOverview();
		});
		srvCards.classList.add('mt-sys-srv-cards');
		srvPanel.appendChild(Mt5700.formGroup('服务域选择 (Service Domain)', srvCards));
		srvPanel.appendChild(srvNote);

		sysDualGrid.appendChild(srvPanel);

		function applySrvConstraint() {
			var acq = sysCfg.acqorder || '';
			var hasLteOrNr = acq.indexOf('03') >= 0 || acq.indexOf('08') >= 0;
			srvCards.setDisabled('0', hasLteOrNr);
			srvCards.setDisabled('3', hasLteOrNr);
			if (hasLteOrNr && (sysCfg.srvdomain === 0 || sysCfg.srvdomain === 3)) {
				srvCards.setValue('2', true);
				sysCfg.srvdomain = 2;
			}
			srvNote.style.display = hasLteOrNr ? '' : 'none';
		}

		function getAcqLabel(val) {
			var opt = ACQ_OPTIONS.find(function (o) { return o.value === val; });
			if (opt) return opt.label;
			return val ? '自定义 (' + val + ')' : '未获取';
		}
		function getRoamLabel(val) {
			var opt = ROAM_OPTIONS.find(function (o) { return String(o.value) === String(val); });
			return opt ? opt.label : (val != null ? String(val) : '—');
		}
		function getSrvLabel(val) {
			var opt = SRV_OPTIONS.find(function (o) { return String(o.value) === String(val); });
			return opt ? opt.label : (val != null ? String(val) : '—');
		}
		function getBandPresetLabel(val) {
			var opt = BAND_PRESETS.find(function (o) { return o.value === val; });
			return opt ? opt.label.split('（')[0] : (val ? '自定义' : '保持当前');
		}
		function getLteBandPresetLabel(val) {
			var opt = LTE_PRESETS.find(function (o) { return o.value === val; });
			return opt ? opt.label.split('（')[0] : (val ? '自定义' : '保持当前');
		}

		function updateSysOverview() {
			sysOverview.innerHTML = '';
			var items = [
				{ label: '首选制式', value: getAcqLabel(sysCfg.acqorder), type: 'info' },
				{ label: '漫游策略', value: getRoamLabel(sysCfg.roam), type: sysCfg.roam === 1 ? 'success' : 'neutral' },
				{ label: '服务域', value: getSrvLabel(sysCfg.srvdomain), type: sysCfg.srvdomain === 2 ? 'accent' : 'neutral' },
				{ label: '4G 频段', value: getLteBandPresetLabel(sysCfg.lteband), type: 'neutral' },
				{ label: '2G/3G 频段', value: getBandPresetLabel(sysCfg.band), type: 'neutral' }
			];
			items.forEach(function (it) {
				var el = E('div', { 'class': 'mt-sys-stat-item' }, [
					E('span', { 'class': 'mt-sys-stat-label' }, it.label + ':'),
					Mt5700.badge(it.value, it.type)
				]);
				sysOverview.appendChild(el);
			});
		}

		/* 原始参数面板（只读） */
		var rawPanel = E('div', { 'class': 'mt-sys-raw-grid' });
		var sysRawAcq = Mt5700.rawValue('接入顺序', '');
		var sysRawBand = Mt5700.rawValue('2G/3G 频段', '');
		var sysRawRoam = Mt5700.rawValue('漫游', '');
		var sysRawSrv = Mt5700.rawValue('服务域', '');
		var sysRawLte = Mt5700.rawValue('LTE 频段', '');
		rawPanel.appendChild(sysRawAcq);
		rawPanel.appendChild(sysRawBand);
		rawPanel.appendChild(sysRawRoam);
		rawPanel.appendChild(sysRawSrv);
		rawPanel.appendChild(sysRawLte);

		var rawToggle = Mt5700.ghostButton('显示原始参数', function () {
			var shown = rawPanel.style.display !== 'none';
			rawPanel.style.display = shown ? 'none' : 'grid';
			rawToggle.textContent = shown ? '显示原始参数' : '隐藏原始参数';
		});
		rawPanel.style.display = 'none';

		sysBody.appendChild(rawPanel);

		sysBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('保存网络系统配置', function () {
				var cmd = 'AT^SYSCFGEX="' + sysCfg.acqorder + '",' + sysCfg.band + ',' + sysCfg.roam + ',' + sysCfg.srvdomain + ',' + sysCfg.lteband + ',,';
				send(cmd).then(function (res) {
					if (res.success) {
						Mt5700.success('网络系统配置已更新');
						return fetchSysCfg();
					}
					Mt5700.error('网络系统配置更新失败');
				}).catch(function () { Mt5700.error('网络系统配置更新失败'); });
			}),
			rawToggle
		));

		function fetchSysCfg() {
			return send('AT^SYSCFGEX?').then(function (res) {
				if (res.success && res.data) {
					var txt = atText(res).replace(/\bOK\b/g, '').replace(/\r/g, '').replace(/\n/g, '');
					var m = txt.match(/\^SYSCFGEX:\s*"?([^",]*)"?\s*,\s*([^,]*?)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9A-Fa-f]*(?:\s|$))/);
					if (m) {
						sysCfg.acqorder = m[1];
						sysCfg.band = m[2].trim();
						sysCfg.roam = Number(m[3]);
						sysCfg.srvdomain = Number(m[4]);
						sysCfg.lteband = m[5].trim();

						applyAcqValue(sysCfg.acqorder);
						applyPreset(bandSel, sysCfg.band);
						applyPreset(lteBandSel, sysCfg.lteband);
						roamCards.setValue(String(sysCfg.roam), true);
						srvCards.setValue(String(sysCfg.srvdomain), true);

						sysRawAcq.setValue(sysCfg.acqorder);
						sysRawBand.setValue(sysCfg.band);
						sysRawRoam.setValue(sysCfg.roam);
						sysRawSrv.setValue(sysCfg.srvdomain);
						sysRawLte.setValue(sysCfg.lteband);

						applySrvConstraint();
						updateSysOverview();
					}
				}
			}).catch(function () {});
		}

		function applyPreset(sel, val) {
			var hit = false;
			for (var i = 0; i < sel.options.length; i++) {
				if (sel.options[i].value === val) { hit = true; break; }
			}
			if (!hit) {
				var stale = sel.querySelector('option[data-dynamic="1"]');
				if (stale) stale.remove();
				if (val !== '') {
					var o = E('option', { value: val, 'data-dynamic': '1' }, '当前值：' + val);
					sel.insertBefore(o, sel.firstChild);
				}
			}
			sel.value = val;
		}

		function applyAcqValue(val) {
			var known = ACQ_OPTIONS.some(function (o) { return o.value === val; });
			acqCards.setValue(val, true);
			if (known) {
				acqCustomEl.style.display = 'none';
				acqCards.setAllDisabled(false);
			} else {
				acqCustomEl.style.display = '';
				acqCustomEl.textContent = '模组当前接入顺序为「' + val + '」，不在本页预设选项内。如需更改，请从上方选择一个新值；不作改动则保持原值不变。';
				acqCards.setAllDisabled(false);
			}
			sysRawAcq.setValue(val);
			updateSysOverview();
		}

		/* ================= 第五行：温度保护 + 系统控制 ================= */
		var rowSys = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowSys);

		/* 卡片 5-1：温度保护 */
		var thermCard = Mt5700.card('温度监控与保护 (THERM)', '自动温控保护、高温限制 CA/MIMO 与采样参数');
		var thermBody = E('div');
		thermCard._body.appendChild(thermBody);
		rowSys.appendChild(thermCard);

		var thermBadgeRow = E('div', { 'class': 'mt-therm-badge-row' });
		var thermLevelBadge = Mt5700.badge('温控状态: 检查中…', 'neutral');
		var thermThresholdChip = E('span', { 'class': 'mt-therm-stat-chip' }, '温保阈值: —');
		var thermLogChip = E('span', { 'class': 'mt-therm-stat-chip' }, '温保日志: —');
		thermBadgeRow.appendChild(thermLevelBadge);
		thermBadgeRow.appendChild(thermThresholdChip);
		thermBadgeRow.appendChild(thermLogChip);
		thermBody.appendChild(thermBadgeRow);

		function thermCmd() {
			return 'AT^THERMAUTOFUN=' + (thermChk.checked ? 1 : 0) + ',' + (thermCaChk.checked ? 1 : 0) + ',' + (thermIntervalInput.value || 5);
		}

		/* 采样间隔取值范围：手册未给上限，这里按 1s~1h 收敛，避免把非法值送进模组 */
		var THERM_INTERVAL_MIN = 1;
		var THERM_INTERVAL_MAX = 3600;
		/* 最近一次被模组确认接受的间隔值，写入失败时用它回滚输入框 */
		var thermIntervalLastOk = '5';

		/* 温控三参数共用同一条 AT^THERMAUTOFUN 写指令，成功/失败一律回传布尔值 */
		function applyThermConfig(okMsg, failMsg) {
			return send(thermCmd()).then(function (res) {
				if (res.success) {
					Mt5700.success(okMsg);
					return true;
				}
				Mt5700.error(failMsg);
				return false;
			}).catch(function () {
				Mt5700.error(failMsg);
				return false;
			});
		}

		var thermSwitch = Ui.switch(function (checked) {
			return applyThermConfig(
				(checked ? '开启' : '关闭') + '温度保护功能成功',
				(checked ? '开启' : '关闭') + '温度保护功能失败'
			);
		});
		var thermChk = thermSwitch.querySelector('input');
		thermBody.appendChild(Mt5700.formGroup('自动温度保护开关', thermSwitch, '芯片过热时自动采取阶梯降频与功率保护'));

		var thermCaSwitch = Ui.switch(function () {
			return applyThermConfig('高温策略已更新', '高温策略更新失败');
		});
		var thermCaChk = thermCaSwitch.querySelector('input');
		thermBody.appendChild(Mt5700.formGroup('高温时关闭 CA/MIMO', thermCaSwitch, '高温状态下自动降级为单载波以减少功耗'));

		var thermIntervalInput = Mt5700.input('number', '5', '5');
		thermIntervalInput.min = THERM_INTERVAL_MIN;
		thermIntervalInput.max = THERM_INTERVAL_MAX;
		thermIntervalInput.addEventListener('change', function () {
			var txt = String(thermIntervalInput.value || '').trim();
			if (!/^\d+$/.test(txt)) {
				thermIntervalInput.value = thermIntervalLastOk;
				Mt5700.error('温度检测间隔必须为正整数，已还原为 ' + thermIntervalLastOk + ' 秒');
				return;
			}
			var val = parseInt(txt, 10);
			if (val < THERM_INTERVAL_MIN || val > THERM_INTERVAL_MAX) {
				val = val < THERM_INTERVAL_MIN ? THERM_INTERVAL_MIN : THERM_INTERVAL_MAX;
				thermIntervalInput.value = String(val);
				Mt5700.error('温度检测间隔需在 ' + THERM_INTERVAL_MIN + '~' + THERM_INTERVAL_MAX + ' 秒之间，已修正为 ' + val);
			}
			applyThermConfig('温度检测间隔设置成功', '温度检测间隔设置失败').then(function (ok) {
				if (ok) thermIntervalLastOk = String(val);
				else thermIntervalInput.value = thermIntervalLastOk;
			});
		});
		thermBody.appendChild(Mt5700.formGroup('采样检测间隔 (秒)', thermIntervalInput));

		function fetchThermConfig() {
			return send('AT^THERMAUTOFUN?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMAUTOFUN:\s*(\d+)\s+(\d+)\s+(\d+)/);
					if (m) {
						thermChk.checked = m[1] === '1';
						thermCaChk.checked = m[2] === '1';
						thermIntervalInput.value = String(m[3]);
						thermIntervalLastOk = String(m[3]);
					}
				}
				return send('AT^THERMLDLOGSW?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDLOGSW:\s*(\d+)\s+(\d+)/);
					if (m) {
						/* 手册 17.5.3：两个字段依次是 tempthreshold_log_switch（串口日志打印开关）
						 * 与 tempthreshold_file_switch（日志文件存储开关），都是 0/1 开关。
						 * 早先显示成「开 (等级 n)」把第二个开关当成了档位。 */
						thermLogChip.textContent = '温保日志: 串口 ' + (m[1] === '1' ? '开' : '关') +
							' · 文件 ' + (m[2] === '1' ? '开' : '关');
					}
				}
				return send('AT^THERMLDAUTOPARA?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDAUTOPARA:\s*([\d,]+)/);
					if (m) {
						thermThresholdChip.textContent = '温保阈值: ' + m[1].replace(/,+$/, '') + '°C';
					}
				}
				return send('AT^THERMLDAUTOSTATUS?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDAUTOSTATUS:\s*([\d,]+)/);
					if (m) {
						var nums = m[1].split(',').map(Number);
						var cur = nums.length >= 6 ? nums[5] : nums[0];
						var label = '运行正常 · 舒适';
						var variant = 'success';
						if (cur === 2) { label = '一级温保 · 适度降频'; variant = 'warning'; }
						else if (cur === 3) { label = '二级温保 · 功率限制'; variant = 'warning'; }
						else if (cur === 4) { label = '三级温保 · 深度保护'; variant = 'danger'; }
						else if (cur >= 5) { label = '四级温保 · 关断射频'; variant = 'danger'; }
						thermLevelBadge.textContent = '温控: ' + label + ' (状态 ' + cur + ')';
						thermLevelBadge.className = 'mt5700-badge mt5700-badge-' + variant;
					}
				}
			}).catch(function () {});
		}

		/* 卡片 5-2：系统控制 (重启 / 恢复出厂) */
		var sysCtrlCard = Mt5700.card('系统维护与硬件重置', '模组软重启与恢复出厂设置（高危操作，需逐级验证）');
		var sysCtrlBody = E('div');
		sysCtrlCard._body.appendChild(sysCtrlBody);
		rowSys.appendChild(sysCtrlCard);

		var sysCtlZone = E('div', { 'class': 'mt-sysctl' });
		sysCtrlBody.appendChild(sysCtlZone);

		function sysCtlItem(variant, name, desc, btnLabel, btnVariant, onClick) {
			var item = E('div', { 'class': 'mt-sysctl-item ' + variant });
			var info = E('div', { 'class': 'mt-sysctl-info' });
			var nameRow = E('div', { 'class': 'mt-sysctl-name' });
			nameRow.appendChild(E('span', { 'class': 'mt-sysctl-dot' }));
			nameRow.appendChild(E('span', {}, name));
			info.appendChild(nameRow);
			info.appendChild(E('div', { 'class': 'mt-sysctl-desc' }, desc));
			var btn = (btnVariant === 'warn') ? Mt5700.button(btnLabel, onClick, 'warn') : Mt5700.dangerButton(btnLabel, onClick);
			item.appendChild(info);
			item.appendChild(btn);
			return item;
		}

		sysCtlZone.appendChild(sysCtlItem(
			'is-warn', '重启模组芯片', '模组将重新初始化并重新搜网注网，期间数据业务将中断约 1~2 分钟。',
			'重启模组', 'warn',
			function () {
				Mt5700.confirm('确定重启模组？执行后网络将暂时中断约 1~2 分钟。', function () {
					send('AT^RESET').then(function (res) {
						if (res.success) Mt5700.success('重启指令已发送，模组正在重启');
						else Mt5700.error('重启指令发送失败');
					}).catch(function () { Mt5700.error('重启指令发送失败'); });
				}, '确认重启');
			}
		));

		sysCtlZone.appendChild(sysCtlItem(
			'is-danger', '恢复模组出厂设置', '清空全部用户配置（APN、频段锁频、SIM 设置等），且不可撤销。需连续 3 次确认。',
			'恢复出厂设置', 'danger',
			function () {
				var steps = [
					'【第 1/3 步】即将恢复出厂设置：所有用户配置（APN、频段、锁频、SIM 设置等）将被清空。是否继续？',
					'【第 2/3 步】恢复出厂后模组将无法联网，需要重新配置才能恢复数据服务。确定继续？',
					'【第 3/3 步】最后确认：这是高危操作且后果需自行承担。确认下发恢复出厂设置指令？'
				];
				function ask(i) {
					if (i >= steps.length) {
						send('AT&F').then(function (res) {
							if (res.success) Mt5700.success('恢复出厂设置指令已发送');
							else Mt5700.error('恢复出厂设置指令发送失败');
						}).catch(function () { Mt5700.error('恢复出厂设置指令发送失败'); });
						return;
					}
					Mt5700.confirm(steps[i], function () { ask(i + 1); }, '继续（' + (i + 1) + '/3）');
				}
				ask(0);
			}
		));

		/* ================= 数据加载 ================= */
		function fetchDeviceInfo() {
			return send('ATI').then(function (res) {
				if (res.success && res.data) {
					var lines = atText(res).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
					lines.forEach(function (l) {
						if (l.indexOf('Manufacturer:') === 0) dev.manufacturer = l.split(':')[1].trim();
						if (l.indexOf('Model:') === 0) dev.model = l.split(':')[1].trim();
						if (l.indexOf('Revision:') === 0) dev.revision = l.split(':')[1].trim();
					});
				}
				return send('AT+CGSN');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/(\d{15})/);
					if (m) { dev.imei = m[1]; imeiEl.textContent = m[1]; }
				}
				return send('AT+CONNECT?');
			}).then(function (res) {
				if (res.success && res.data) {
					var lines = atText(res).split(/[\r\n]+/).filter(function (l) { return l.trim(); });
					var connectLine = null;
					for (var i = 0; i < lines.length; i++) {
						if (lines[i].indexOf('+CONNECT:') >= 0) { connectLine = lines[i]; break; }
					}
					if (connectLine) {
						var modeValue = connectLine.split('+CONNECT:')[1].trim();
						if (modeValue === '0') dev.connectMode = '网络连接';
						else if (modeValue === '1') dev.connectMode = '串口连接';
						else dev.connectMode = modeValue;
					}
				}
				renderDev();
			}).catch(function () { renderDev(); });
		}

		function fetchUsb() {
			return AtWs.usb().then(function (res) {
				if (res && res.success && res.found) {
					dev.usb = AtWs.usbSpeedText(res.speed_mbps);
					if (res.product) dev.usb += ' · ' + res.product;
				} else {
					dev.usb = '';
				}
				renderDev();
			}).catch(function () {
				dev.usb = '';
				renderDev();
			});
		}

		function fetchSimConfig() {
			return send('AT^SCICHG?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^SCICHG:\s*(\d+),\s*(\d+)/);
					if (m) simSlotSel.value = String(m[1]);
				}
				return send('AT^TDSIMHP?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^TDSIMHP:\s*(\d+)/);
					if (m) hpChk.checked = m[1] === '1';
				}
				return send('AT^SIMSQ?');
			}).then(function (res) {
				if (res.success && res.data) {
					var sq = Parse.parseSimsq(res.data);
					if (sq) {
						simSqBadge.textContent = 'SIM: ' + sq.label + (sq.dead ? '（失效）' : '');
						simSqBadge.className = 'mt5700-badge ' + (sq.dead ? 'mt5700-badge-danger' : 'mt5700-badge-success');
					}
				}
				return fetchPinStatus();
			}).catch(function () {});
		}

		function fetchAirplane() {
			return send('AT+CFUN?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\+CFUN:\s*(\d+)/);
					if (m) airplaneChk.checked = m[1] === '0';
				}
			}).catch(function () {});
		}

		function fetchDeviceControl() {
			return send('AT^TDPCIELANCFG?').then(function (res) {
				if (res.success && res.data) {
					/* 手册 11.19.1：读命令返回单个 <n> */
					var m = atText(res).match(/\^TDPCIELANCFG:\s*(\d+)/);
					if (m && (m[1] === '1' || m[1] === '2')) nicSel.value = m[1];
				}
				return send('AT^TDPMCFG?');
			}).then(function (res) {
				if (res.success && res.data) {
					/* 手册 11.16.1：^TDPMCFG 返回 4 个 <mode>，byte[0] 才是 PCIe 开关 */
					var m = atText(res).match(/\^TDPMCFG:\s*(\d+)/);
					if (m) pwrChk.checked = m[1] === '1';
				}
			}).catch(function () {});
		}

		function loadAll() {
			var groups = [
				[fetchDeviceInfo, fetchUsb],
				[fetchSimConfig, fetchAirplane],
				[fetchDeviceControl, fetchNRCapability],
				[fetchSysCfg, fetchThermConfig]
			];
			var runners = groups.map(function (g) {
				var chain = Promise.resolve();
				g.forEach(function (fn) {
					chain = chain.then(fn).catch(function (err) {
						console.warn('数据块加载失败', err);
					});
				});
				return chain;
			});
			return Promise.all(runners);
		}

		/* 底部操作条 */
		var bottomActions = Mt5700.panelActions(
			Mt5700.primaryButton('刷新模组全部数据', function () {
				Mt5700.info('正在刷新模组配置与硬件状态…');
				loadAll().then(function () {
					Mt5700.success('模组数据已刷新');
				});
			})
		);
		body.appendChild(bottomActions);

		Ui.startup(body, function () { loadAll(); });

		return page;
	}
});
