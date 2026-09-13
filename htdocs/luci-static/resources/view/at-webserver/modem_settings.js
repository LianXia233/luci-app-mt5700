'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 模组设置 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI system/Info.tsx 的全部可操作功能：
 * - 设备信息（ATI / IMEI / 连接模式 AT+CONNECT?）
 * - SIM 卡：槽位切换（SCICHG + HVSST + CFUN 重启）、热插拔（TDSIMHP）、PIN 状态/操作
 * - 飞行模式（CFUN）
 * - 网卡速率（TDPCIELANCFG）、电源管理（TDPMCFG）
 * - NR 能力：载波聚合 / VoNR / DSS（NRRCCAPQRY=3/2/5 + NRRCCAPCFG）
 * - 网络系统配置（SYSCFGEX）
 * - 温度保护（THERMAUTOFUN / THERMLD*）
 * - 重启（RESET）、恢复出厂（AT&F）
 *
 * 注意：IMEI 相关命令（AT+CGSN / AT^PHYNUM）完全沿用基准实现，未做任何改动。
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('模组设置', '模组设备信息、SIM、射频与系统控制');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 通用小工具 ---------- */

		function makeSwitch(onChange) {
			var wrap = E('div', { 'class': 'mt5700-switch' });
			var input = E('input', { type: 'checkbox' });
			input.addEventListener('change', function () { onChange(input.checked, input); });
			wrap.appendChild(input);
			return wrap;
		}

		function atText(res) {
			if (!res) return '';
			if (typeof res.data === 'string') return res.data;
			if (res.data && typeof res.data.raw === 'string') return res.data.raw;
			return String(res.data || '');
		}

		function send(cmd) {
			return AtWs.client.sendCommand(cmd);
		}

		/* ================= 设备信息 ================= */

		var devCard = Mt5700.card('设备信息', '');
		var devBody = E('div');
		devCard._body.appendChild(devBody);
		body.appendChild(devCard);

		var dev = { manufacturer: '', model: '', revision: '', imei: '', connectMode: '' };
		var imeiEl = E('span', { 'class': 'mt5700-mono' }, '—');

		function renderDev() {
			devBody.innerHTML = '';
			devBody.appendChild(Mt5700.table(
				['项目', '值'],
				[
					['制造商', dev.manufacturer || '—'],
					['型号', dev.model || '—'],
					['版本', dev.revision || '—'],
					['IMEI（点击 5 次可修改）', imeiEl],
					['连接模式', dev.connectMode || '—']
				]
			));
		}
		renderDev();

		var imeiClickCount = 0;
		imeiEl.style.cursor = 'pointer';
		imeiEl.addEventListener('click', function () {
			imeiClickCount++;
			if (imeiClickCount >= 5) {
				imeiClickCount = 0;
				Ui.promptModal('修改 IMEI', [
					{ key: 'imei', label: '新 IMEI（15 位数字）', value: dev.imei }
				], function (values) {
					var newImei = (values.imei || '').trim();
					if (!/^\d{15}$/.test(newImei)) { Mt5700.error('IMEI 必须是 15 位数字'); return; }
					Mt5700.confirm('确定将 IMEI 修改为 ' + newImei + '？此操作影响设备合法性，请谨慎。', function () {
						send('AT^PHYNUM=IMEI,' + newImei).then(function (res) {
							if (res.success) {
								Mt5700.success('IMEI 修改成功');
								dev.imei = newImei;
								imeiEl.textContent = newImei;
							} else {
								Mt5700.error('IMEI 修改失败');
							}
						}).catch(function () { Mt5700.error('IMEI 修改失败'); });
					});
				});
			}
		});

		/* ================= SIM 卡 ================= */

		var simCard = Mt5700.card('SIM 卡', '槽位切换、热插拔与 PIN');
		var simBody = E('div');
		simCard._body.appendChild(simBody);
		body.appendChild(simCard);

		var simStatusRow = E('div', { 'class': 'mt5700-inline' });
		var simSqEl = E('span', { 'class': 'mt5700-hint' }, 'SIM 状态：—');
		var pinStatusEl = E('span', { 'class': 'mt5700-hint' }, 'PIN 状态：—');
		simStatusRow.appendChild(simSqEl);
		simStatusRow.appendChild(pinStatusEl);
		simBody.appendChild(simStatusRow);

		var simSlotSel = Mt5700.select([
			{ label: '外置 SIM', value: '0' },
			{ label: '内置 SIM', value: '1' }
		], '0');
		var simSlotSelProxy = simSlotSel;
		simSlotSelProxy.addEventListener('change', function () {
			handleSimSwitch(parseInt(simSlotSelProxy.value, 10));
		});
		simBody.appendChild(Mt5700.formGroup('SIM 槽位', simSlotSelProxy));

		var hpSwitch = makeSwitch(function (checked, input) { handleSimHotPlug(checked, input); });
		simBody.appendChild(Mt5700.formGroup('SIM 卡热插拔', hpSwitch));
		var hpChk = hpSwitch.querySelector('input');

		var pinOps = Mt5700.panelActions(
			Mt5700.button('输入 PIN', function () { pinModal('verify'); }, 'primary'),
			Mt5700.button('修改 PIN', function () { pinModal('change'); }, 'primary'),
			Mt5700.button('禁用 PIN', function () { pinModal('disable'); }, 'primary'),
			Mt5700.button('启用 PIN', function () { pinModal('enable'); }, 'primary')
		);
		simBody.appendChild(pinOps);

		function pinModal(op) {
			var titles = { verify: '输入 PIN', change: '修改 PIN', disable: '禁用 PIN', enable: '启用 PIN' };
			var fields = [];
			if (op === 'change') {
				fields.push({ key: 'old', label: '当前 PIN', type: 'password' });
				fields.push({ key: 'new', label: '新 PIN', type: 'password' });
				fields.push({ key: 'confirm', label: '确认新 PIN', type: 'password' });
			} else {
				fields.push({ key: 'pin', label: 'PIN', type: 'password' });
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
						Mt5700.success('操作成功');
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

		function handleSimHotPlug(checked, input) {
			send('AT^TDSIMHP=' + (checked ? '1' : '0')).then(function (res) {
				if (res.success) {
					Mt5700.success((checked ? '开启' : '关闭') + ' SIM 卡热插拔成功');
				} else {
					Mt5700.error((checked ? '开启' : '关闭') + ' SIM 卡热插拔失败');
					if (input) input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('SIM 卡热插拔设置失败'); });
		}

		function fetchPinStatus() {
			return send('AT+CPIN?').then(function (res) {
				var ready = false;
				if (res.success && res.data) {
					var m = atText(res).match(/\+CPIN:\s*(\w+)/);
					if (m) { ready = m[1] === 'READY'; pinStatusEl.textContent = 'PIN 状态：' + m[1]; }
				}
				if (!ready) pinStatusEl.textContent = 'PIN 状态：READY';
				return send('AT+CLCK="SC",2');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/,(\d+)/);
					if (m) {
						var enabled = m[1] === '1';
						pinStatusEl.textContent = 'PIN 状态：READY，' + (enabled ? '已启用' : '未启用');
					}
				}
			}).catch(function () {});
		}

		/* ================= 飞行模式 ================= */

		var rfCard = Mt5700.card('射频控制', '飞行模式');
		var rfBody = E('div');
		rfCard._body.appendChild(rfBody);
		body.appendChild(rfCard);

		var airplaneSwitch = makeSwitch(function (checked, input) {
			send('AT+CFUN=' + (checked ? '0' : '1')).then(function (res) {
				if (res.success) Mt5700.success((checked ? '开启' : '关闭') + '飞行模式成功');
				else {
					Mt5700.error((checked ? '开启' : '关闭') + '飞行模式失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('飞行模式设置失败'); });
		});
		rfBody.appendChild(Mt5700.formGroup('飞行模式', airplaneSwitch, '开启后关闭射频，恢复网络连接'));
		var airplaneChk = airplaneSwitch.querySelector('input');

		/* ================= 设备控制 ================= */

		var ctrlCard = Mt5700.card('设备控制', '网卡速率与电源管理');
		var ctrlBody = E('div');
		ctrlCard._body.appendChild(ctrlBody);
		body.appendChild(ctrlCard);

		var nicSel = Mt5700.select([
			{ label: '自动协商', value: '0' },
			{ label: '1000Mbps 全双工', value: '1' },
			{ label: '100Mbps 全双工', value: '2' },
			{ label: '10Mbps 全双工', value: '3' }
		], '0');
		nicSel.addEventListener('change', function () { handleSetNic(parseInt(nicSel.value, 10)); });
		ctrlBody.appendChild(Mt5700.formGroup('网卡速率', nicSel));

		var pwrSwitch = makeSwitch(function (checked, input) {
			send('AT^TDPMCFG=' + (checked ? '1' : '0')).then(function (res) {
				if (res.success) Mt5700.success((checked ? '开启' : '关闭') + '电源管理成功');
				else {
					Mt5700.error((checked ? '开启' : '关闭') + '电源管理失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('电源管理设置失败'); });
		});
		ctrlBody.appendChild(Mt5700.formGroup('电源管理', pwrSwitch, '开启后模组在无业务时进入低功耗'));
		var pwrChk = pwrSwitch.querySelector('input');

		function handleSetNic(value) {
			send('AT^TDPCIELANCFG=' + value).then(function (res) {
				if (!res.success) { Mt5700.error('网卡速率设置失败'); return; }
				Mt5700.success('网卡速率设置成功，重启后生效');
				Mt5700.confirm('是否立即重启模组使配置生效？', function () {
					send('AT^RESET').then(function (r) {
						if (r.success) Mt5700.success('重启指令已发送');
						else Mt5700.error('重启指令发送失败');
					});
				}, '立即重启');
			}).catch(function () { Mt5700.error('网卡速率设置失败'); });
		}

		/* ================= NR 能力 ================= */

		var nrCard = Mt5700.card('NR 能力', '载波聚合、VoNR 与 DSS');
		var nrBody = E('div');
		nrCard._body.appendChild(nrBody);
		body.appendChild(nrCard);

		var caSwitch = makeSwitch(function (checked, input) {
			send('AT^NRRCCAPCFG=3,' + (checked ? 1 : 0)).then(function (res) {
				if (res.success) Mt5700.success((checked ? '开启' : '关闭') + '载波聚合成功');
				else {
					Mt5700.error((checked ? '开启' : '关闭') + '载波聚合失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('载波聚合设置失败'); });
		});
		nrBody.appendChild(Mt5700.formGroup('NR 载波聚合', caSwitch));
		var caChk = caSwitch.querySelector('input');

		var vonrSel = Mt5700.select([
			{ label: '关闭', value: '0' },
			{ label: 'FR1-VoNR', value: '1' },
			{ label: 'FR2-VoNR', value: '2' },
			{ label: 'FR1+FR2-VoNR', value: '3' }
		], '0');
		vonrSel.addEventListener('change', function () {
			send('AT^NRRCCAPCFG=2,' + parseInt(vonrSel.value, 10)).then(function (res) {
				if (res.success) Mt5700.success('VoNR 配置成功');
				else Mt5700.error('VoNR 配置失败');
			}).catch(function () { Mt5700.error('VoNR 配置失败'); });
		});
		nrBody.appendChild(Mt5700.formGroup('VoNR', vonrSel));

		var dssSwitch = makeSwitch(function (checked, input) {
			send('AT^NRRCCAPCFG=5,' + (checked ? 1 : 0) + ',0').then(function (res) {
				if (res.success) Mt5700.success('DSS 配置成功');
				else {
					Mt5700.error('DSS 配置失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('DSS 配置失败'); });
		});
		nrBody.appendChild(Mt5700.formGroup('NR DSS', dssSwitch, 'LTE/NR 动态频谱共享'));
		var dssChk = dssSwitch.querySelector('input');

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

		/* ================= 网络系统配置 SYSCFGEX ================= */

		var sysCard = Mt5700.card('网络系统配置', '选择模组搜索和驻留网络的方式');
		var sysBody = E('div');
		sysCard._body.appendChild(sysBody);
		body.appendChild(sysCard);

		sysBody.appendChild(Mt5700.fieldNote(
			'这一组设置决定模组用哪些制式、哪些频段去搜索网络。改错可能导致无法注册上网络，建议逐项修改后保存。',
			[
				'所有设置保存在模组侧，掉电不丢失。',
				'保存后模组会重新搜索网络，约需 10~30 秒恢复。',
				'如需在基站覆盖变差时保持通话可用，优先使用「优先」类选项而非「锁定」类。'
			]
		));

		var sysCfg = { acqorder: '', band: '', roam: 1, srvdomain: 2, lteband: '' };

		/*
		 * 接入顺序：原始参数是制式代码拼接的字符串（如 "080302" = NR → LTE → WCDMA）。
		 * 用户无法从码串理解含义，也无法自行组合，因此改为「按实际影响面选择」的卡片组，
		 * 每个选项都写清「选了会怎样」。取值严格限定在 AT^SYSCFGEX=? 支持的制式代码
		 * （01 GSM / 02 WCDMA / 03 LTE / 08 NR）之内，不会下发非法组合。
		 */
		var ACQ_OPTIONS = [
			{
				value: '080302', code: '08 → 03 → 02', label: '5G 优先，逐级回落', badge: '推荐',
				desc: '有 5G 信号就用 5G；没有则自动落到 4G，再没有落到 3G。速度与覆盖兼顾。'
			},
			{
				value: '08', code: '08', label: '仅 5G',
				desc: '只搜索 5G 网络，搜不到会持续重搜。5G 覆盖不稳时会出现无服务。'
			},
			{
				value: '0302', code: '03 → 02', label: '4G 优先，可回落 3G',
				desc: '优先驻留 4G；无 4G 时落到 3G。适合 5G 覆盖差、又希望保速率的场景。'
			},
			{
				value: '03', code: '03', label: '仅 4G',
				desc: '只搜索 4G 网络。信号稳定、耗电较低，但离开 4G 覆盖会无服务。'
			},
			{
				value: '0203', code: '02 → 03', label: '3G 优先，可回落 4G',
				desc: '优先驻留 3G；无 3G 时落到 4G。适合 3G 覆盖优于 4G 的地区。'
			},
			{
				value: '02', code: '02', label: '仅 3G',
				desc: '只搜索 3G 网络。速率较低，仅在特殊排查场景使用。'
			},
			{
				value: '99', code: '99', label: '保持当前设置',
				desc: '不修改接入顺序，只保存本页其它项。'
			}
		];

		var acqCards = Mt5700.radioCards('acq', ACQ_OPTIONS, '080302', function (v) {
			sysCfg.acqorder = v;
			sysRawAcq.setValue(v);
			/* 接入顺序变了，服务域的可选范围随之变化，立即重算 */
			applySrvConstraint();
		});
		/* 兜底：当前值不在预设选项内（用户曾手工写入过），补一个只读提示项，避免静默丢值 */
		var acqCustomEl = E('div', { 'class': 'mt5700-hint', 'style': 'display:none' });

		sysBody.appendChild(Mt5700.formGroup('网络接入顺序', acqCards,
			'决定模组按什么先后顺序搜索网络制式。默认「5G 优先，逐级回落」适用于绝大多数场景。'));
		sysBody.appendChild(acqCustomEl);

		/*
		 * 频段：原始值是十六进制位图（如 2000000680380），手写极易出错。
		 * 常规用户只需要「自动」或「全部」，因此改为预设档位；原始值单独只读展示，便于排障时对标。
		 */
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
		});
		sysBody.appendChild(Mt5700.formGroup('2G / 3G 频段', bandSel,
			'模组在 2G / 3G 制式下允许使用的频段范围。一般保持「自动」即可。'));

		/*
		 * 漫游：0 不支持 / 1 支持 / 2 无变化（官方手册 13.2.3）。
		 * 原界面缺 0 档，且文案「仅本网」与「自动漫游」没讲清「本网」指什么。
		 */
		var ROAM_OPTIONS = [
			{
				value: '1', label: '允许漫游', badge: '推荐',
				desc: '离开本地运营商网络后，可以使用合作运营商的网络，保持联网。'
			},
			{
				value: '0', label: '禁止漫游',
				desc: '只使用本地运营商网络。离开覆盖范围后不接入其它运营商，可避免漫游费用。'
			},
			{
				value: '2', label: '不修改',
				desc: '保持模组当前漫游设置不变。'
			}
		];

		var roamCards = Mt5700.radioCards('roam', ROAM_OPTIONS, '1', function (v) {
			sysCfg.roam = parseInt(v, 10);
		});
		sysBody.appendChild(Mt5700.formGroup('漫游', roamCards,
			'控制模组是否允许接入非本地运营商的网络。'));

		/*
		 * 服务域：0 CS_ONLY / 1 PS_ONLY / 2 CS_PS / 3 ANY / 4 无变化。
		 * 官方约束（手册 13.2.3 注 2）：接入制式含 LTE 或 NR 时，不允许设置为 0 或 3。
		 * 界面按此动态禁用，把原本只存在于文档里的约束显性化。
		 */
		var SRV_OPTIONS = [
			{
				value: '2', label: '语音 + 数据', badge: '推荐',
				desc: '同时注册语音（打电话）和数据（上网）网络，功能最完整。'
			},
			{
				value: '1', label: '仅数据',
				desc: '只注册数据网络，无法接打电话和收发短信。适合纯上网设备。'
			},
			{
				value: '0', label: '仅语音',
				desc: '只注册语音网络，无法上网。当前接入制式含 4G / 5G 时不可选。'
			},
			{
				value: '3', label: '不限（由网络决定）',
				desc: '由网络侧决定注册方式。当前接入制式含 4G / 5G 时不可选。'
			},
			{
				value: '4', label: '不修改',
				desc: '保持模组当前服务域设置不变。'
			}
		];

		var srvNote = E('div', { 'class': 'mt5700-hint', 'style': 'display:none; margin-top: 0; margin-bottom: var(--mt5700-space-md);' },
			'当前接入顺序包含 4G 或 5G，模组不允许使用「仅语音」和「不限」，已自动禁用。');

		var srvCards = Mt5700.radioCards('srv', SRV_OPTIONS, '2', function (v) {
			sysCfg.srvdomain = parseInt(v, 10);
		});
		sysBody.appendChild(Mt5700.formGroup('服务域', srvCards,
			'控制模组注册到语音域、数据域还是两者。'));
		sysBody.appendChild(srvNote);

		/* 依当前接入顺序动态施加官方约束：含 LTE(03) 或 NR(08) 时禁用 CS_ONLY / ANY */
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

		/*
		 * LTE 频段：同样是十六进制位图。实机值 1E200000095 = BC1+BC3+BC5+BC8+
		 * BC34+BC38+BC39+BC40+BC41 叠加，用户在文本框里根本无从判断。
		 */
		var LTE_PRESETS = [
			{ value: '', label: '不修改（保持模组当前设置）' },
			{ value: '1E200000095', label: '常用频段（BC1/3/5/8/34/38/39/40/41）' },
			{ value: '7FFFFFFFFFFFFFFF', label: '全部 LTE 频段' }
		];

		var lteBandSel = Mt5700.select(LTE_PRESETS, '');
		lteBandSel.addEventListener('change', function () {
			sysCfg.lteband = lteBandSel.value;
			sysRawLte.setValue(lteBandSel.value);
		});
		sysBody.appendChild(Mt5700.formGroup('4G / LTE 频段', lteBandSel,
			'模组在 4G 制式下允许使用的频段范围。更改为「全部」会增加搜网时间。'));

		/* ---------- 原始参数（只读，供排障对标 AT 手册） ---------- */

		var rawPanel = E('div', { 'class': 'mt5700-raw-panel' });
		rawPanel.appendChild(E('div', { 'class': 'mt5700-raw-panel-title' }, '当前原始参数（只读，来自模组）'));
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
			rawPanel.style.display = shown ? 'none' : '';
			rawToggle.textContent = shown ? '显示原始参数' : '隐藏原始参数';
		});
		rawPanel.style.display = 'none';

		/* 先挂载面板，再挂操作按钮——否则面板是游离节点，开关点了也没反应 */
		sysBody.appendChild(rawPanel);

		sysBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('保存网络配置', function () {
				/* 命令格式与后端契约保持不变：AT^SYSCFGEX="acq",band,roam,srv,lte,, */
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
					/* 先剥离 "OK" 回显，否则正则的 ([^,]*) 会把尾部 OK 一起吃进 LTE 频段值 */
					var txt = atText(res).replace(/\bOK\b/g, '').replace(/\r/g, '').replace(/\n/g, '');
					var m = txt.match(/\^SYSCFGEX:\s*"?([^",]*)"?\s*,\s*([^,]*?)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9A-Fa-f]*(?:\s|$))/);
					if (m) {
						sysCfg.acqorder = m[1];
						sysCfg.band = m[2].trim();
						sysCfg.roam = Number(m[3]);
						sysCfg.srvdomain = Number(m[4]);
						sysCfg.lteband = m[5].trim();

						/* 回填控件；若当前值不在预设内，保留原值并提示，绝不静默改写 */
						applyAcqValue(sysCfg.acqorder);
						applyPreset(bandSel, sysCfg.band);
						applyPreset(lteBandSel, sysCfg.lteband);
						applyCards(roamCards, String(sysCfg.roam));
						applyCards(srvCards, String(sysCfg.srvdomain));

						sysRawAcq.setValue(sysCfg.acqorder);
						sysRawBand.setValue(sysCfg.band);
						sysRawRoam.setValue(sysCfg.roam);
						sysRawSrv.setValue(sysCfg.srvdomain);
						sysRawLte.setValue(sysCfg.lteband);

						applySrvConstraint();
					}
				}
			}).catch(function () {});
		}

		/* 下拉回填：命中预设则选中；未命中则注入一条「当前值」临时项，避免用户看到错误档位 */
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

		/* 卡片组回填：命中则选中；未命中则清空选中（不擅自替用户改值） */
		function applyCards(cards, val) {
			cards.setValue(val, true);
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
		}

		/* ================= 温度保护 ================= */

		var thermCard = Mt5700.card('温度保护', '自动温度保护与检测参数（THERM）');
		var thermBody = E('div');
		thermCard._body.appendChild(thermBody);
		body.appendChild(thermCard);

		var thermStatus = E('div', { 'class': 'mt5700-hint' }, '温度保护：—');
		thermBody.appendChild(thermStatus);

		var thermLogsEl = E('div', { 'class': 'mt5700-hint' }, '');
		var thermThresholdsEl = E('div', { 'class': 'mt5700-hint' }, '');

		function thermCmd() {
			return 'AT^THERMAUTOFUN=' + (thermChk.checked ? 1 : 0) + ',' + (thermCaChk.checked ? 1 : 0) + ',' + (thermIntervalInput.value || 5);
		}

		var thermSwitch = makeSwitch(function (checked, input) {
			send(thermCmd()).then(function (res) {
				if (res.success) Mt5700.success((checked ? '开启' : '关闭') + '温度保护功能成功');
				else {
					Mt5700.error((checked ? '开启' : '关闭') + '温度保护功能失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('温度保护设置失败'); });
		});
		thermBody.appendChild(Mt5700.formGroup('温度保护功能', thermSwitch));
		var thermChk = thermSwitch.querySelector('input');

		var thermCaSwitch = makeSwitch(function () {});
		thermBody.appendChild(Mt5700.formGroup('高温时关闭 CA/MIMO', thermCaSwitch));
		var thermCaChk = thermCaSwitch.querySelector('input');

		var thermIntervalInput = Mt5700.input('number', '5', '5');
		thermIntervalInput.min = 1;
		thermIntervalInput.addEventListener('input', function () {
			send(thermCmd()).then(function (res) {
				if (res.success) Mt5700.success('温度检测间隔设置成功');
				else Mt5700.error('温度检测间隔设置失败');
			}).catch(function () { Mt5700.error('温度检测间隔设置失败'); });
		});
		thermBody.appendChild(Mt5700.formGroup('检测间隔（秒）', thermIntervalInput));

		thermBody.appendChild(thermLogsEl);
		thermBody.appendChild(thermThresholdsEl);

		function fetchThermConfig() {
			return send('AT^THERMAUTOFUN?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMAUTOFUN:\s*(\d+)\s+(\d+)\s+(\d+)/);
					if (m) {
						thermChk.checked = m[1] === '1';
						thermCaChk.checked = m[2] === '1';
						thermIntervalInput.value = String(m[3]);
					}
				}
				return send('AT^THERMLDLOGSW?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDLOGSW:\s*(\d+)\s+(\d+)/);
					if (m) thermLogsEl.textContent = '热抑制日志开关：' + (m[1] === '1' ? '开' : '关') + '，当前日志等级：' + m[2];
				}
				return send('AT^THERMLDAUTOPARA?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDAUTOPARA:\s*([\d,]+)/);
					if (m) thermThresholdsEl.textContent = '温保阈值参数：' + m[1];
				}
				return send('AT^THERMLDAUTOSTATUS?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDAUTOSTATUS:\s*([\d,]+)/);
					if (m) {
						var nums = m[1].split(',').map(Number);
						var levelText = '温度保护状态（1 正常 / 2 一级 / 3 二级 / 4 三级 / 5 四级温保）：' + m[1];
						if (nums.length >= 6) levelText += '，当前等级：' + nums[5];
						thermStatus.textContent = levelText;
					}
				}
			}).catch(function () {});
		}

		/* ================= 系统控制 ================= */

		var sysCtrlCard = Mt5700.card('系统控制', '重启与恢复出厂');
		var sysCtrlBody = E('div');
		sysCtrlCard._body.appendChild(sysCtrlBody);
		body.appendChild(sysCtrlCard);

		sysCtrlBody.appendChild(Mt5700.panelActions(
			Mt5700.dangerButton('重启模组', function () {
				Mt5700.confirm('确定重启模组？网络将暂时中断。', function () {
					send('AT^RESET').then(function (res) {
						if (res.success) Mt5700.success('重启指令已发送');
						else Mt5700.error('重启指令发送失败');
					}).catch(function () { Mt5700.error('重启指令发送失败'); });
				});
			}),
			Mt5700.dangerButton('恢复出厂设置', function () {
				Mt5700.confirm('确定恢复出厂设置？所有配置将被清空。', function () {
					send('AT&F').then(function (res) {
						if (res.success) Mt5700.success('恢复出厂设置指令已发送');
						else Mt5700.error('恢复出厂设置指令发送失败');
					}).catch(function () { Mt5700.error('恢复出厂设置指令发送失败'); });
				});
			})
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

		function fetchSimConfig() {
			return send('AT^SCICHG?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^SCICHG:\s*(\d+),\s*(\d+)/);
					if (m) simSlotSelProxy.value = String(m[1]);
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
						simSqEl.textContent = 'SIM 状态：' + sq.label + (sq.dead ? '（卡已失效，无法恢复）' : '');
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
					var m = atText(res).match(/\^TDPCIELANCFG:\s*(\d+)/);
					if (m) nicSel.value = String(m[1]);
				}
				return send('AT^TDPMCFG?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^TDPMCFG:\s*(\d+)/);
					if (m) pwrChk.checked = m[1] === '1';
				}
			}).catch(function () {});
		}

		function loadAll() {
			return Promise.resolve()
				.then(fetchDeviceInfo)
				.then(fetchSimConfig)
				.then(fetchAirplane)
				.then(fetchDeviceControl)
				.then(fetchNRCapability)
				.then(fetchSysCfg)
				.then(fetchThermConfig)
				.catch(function (err) { console.warn('部分数据加载失败', err); });
		}

		var bottomActions = Mt5700.panelActions(
			Mt5700.primaryButton('刷新', function () { loadAll(); })
		);
		body.appendChild(bottomActions);

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						AtWs.client.connect(values.key).catch(function (e) { Mt5700.error((e && e.message) || '认证失败'); });
					}
				});
				return;
			}
			if (err) console.warn(err);
		}).then(function () {
			loadAll();
		});

		return page;
	}
});
