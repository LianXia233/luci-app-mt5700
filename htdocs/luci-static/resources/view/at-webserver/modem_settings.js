'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Parse, Ui */

/**
 * 模组设置（原 WebUI 系统 → 模组设置）
 * 等价迁移 system/Info.tsx 的全部可操作功能：
 * - 设备信息（ATI / IMEI / 连接模式 AT+CONNECT?）
 * - SIM 卡：槽位切换（SCICHG + HVSST + CFUN 重启）、热插拔（TDSIMHP）、PIN 状态/操作
 * - 飞行模式（CFUN）
 * - 网卡速率（TDPCIELANCFG）、电源管理（TDPMCFG）
 * - NR 能力：载波聚合 / VoNR / DSS（NRRCCAPQRY=3/2/5 + NRRCCAPCFG）
 * - 网络系统配置（SYSCFGEX）
 * - 温度保护（THERMAUTOFUN / THERMLD*）
 * - IMEI 修改（PHYNUM）、重启（RESET）、恢复出厂（AT&F）
 */

return L.view.extend({
	render: function () {
		var page = Ui.page('模组设置', '模组设备信息、SIM、射频与系统控制');
		var body = page._body;
		Ui.renderConnectionBar(body);

		/* ============ 设备信息 ============ */
		var devPanel = Ui.panel('设备信息', '');
		var devTable = E('table', { 'class': 'at-kv' });
		devPanel._body.appendChild(devTable);
		body.appendChild(devPanel);

		var dev = { manufacturer: '', model: '', revision: '', imei: '', connectMode: '' };
		var imeiEl = E('span', {}, '—');

		function renderDev() {
			devTable.innerHTML = '';
			var rows = [
				{ label: '制造商', value: dev.manufacturer || '—' },
				{ label: '型号', value: dev.model || '—' },
				{ label: '版本', value: dev.revision || '—' },
				{ label: 'IMEI（点击 5 次可修改）', value: imeiEl },
				{ label: '连接模式', value: dev.connectMode || '—' }
			];
			for (var i = 0; i < rows.length; i++) {
				var tr = E('tr');
				tr.appendChild(E('td', { 'class': 'at-kv-label' }, rows[i].label));
				var td = E('td', { 'class': 'at-kv-value' });
				if (typeof rows[i].value === 'string') td.textContent = rows[i].value;
				else td.appendChild(rows[i].value);
				tr.appendChild(td);
				devTable.appendChild(tr);
			}
		}

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
					if (!/^\d{15}$/.test(newImei)) { Ui.error('IMEI必须是15位数字'); return; }
					Ui.confirm('确定将 IMEI 修改为 ' + newImei + '？此操作影响设备合法性，请谨慎。', function () {
						AtWs.client.sendCommand('AT^PHYNUM=IMEI,' + newImei).then(function (res) {
							if (res.success) { Ui.success('IMEI修改成功'); dev.imei = newImei; imeiEl.textContent = newImei; }
							else { Ui.error('IMEI修改失败'); }
						}).catch(function () { Ui.error('IMEI修改失败'); });
					});
				});
			}
		});

		/* ============ SIM 卡 ============ */
		var simPanel = Ui.panel('SIM 卡', '槽位切换、热插拔与 PIN');
		var simStatus = E('div', { 'class': 'at-tags' });
		simPanel._body.appendChild(simStatus);

		var simSlotSel = document.createElement('select');
		simSlotSel.className = 'cbi-input-select';
		[{ v: '0', l: '外置 SIM' }, { v: '1', l: '内置 SIM' }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			simSlotSel.appendChild(opt);
		});
		simSlotSel.addEventListener('change', function () { handleSimSwitch(parseInt(simSlotSel.value, 10)); });
		simPanel._body.appendChild(Ui.field('SIM 槽位', simSlotSel));

		var hpChk = document.createElement('input');
		hpChk.type = 'checkbox';
		hpChk.className = 'cbi-input-checkbox';
		hpChk.addEventListener('change', function () { handleSimHotPlug(hpChk.checked); });
		simPanel._body.appendChild(Ui.field('SIM 卡热插拔', hpChk));

		var pinStatusEl = E('div', { 'class': 'at-hint' }, 'PIN 状态：—');
		simPanel._body.appendChild(pinStatusEl);

		// 手册 6.6：^SIMSQ 能区分卡不在位 / 被锁 / PUK 锁死，+CPIN 看不出来
		var simSqEl = E('div', { 'class': 'at-hint' }, 'SIM 状态：—');
		simPanel._body.appendChild(simSqEl);

		var pinOps = E('div', { 'class': 'at-panel-actions' });
		var pinUnlockBtn = Ui.button('输入 PIN', 'cbi-button-action', function () { pinModal('verify'); });
		var pinChangeBtn = Ui.button('修改 PIN', 'cbi-button-action', function () { pinModal('change'); });
		var pinDisableBtn = Ui.button('禁用 PIN', 'cbi-button-action', function () { pinModal('disable'); });
		var pinEnableBtn = Ui.button('启用 PIN', 'cbi-button-action', function () { pinModal('enable'); });
		pinOps.appendChild(pinUnlockBtn);
		pinOps.appendChild(pinChangeBtn);
		pinOps.appendChild(pinDisableBtn);
		pinOps.appendChild(pinEnableBtn);
		simPanel._body.appendChild(pinOps);
		body.appendChild(simPanel);

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
					if (values.new !== values.confirm) { Ui.error('两次输入的PIN码不一致'); return; }
					cmd = 'AT+CPIN="' + values.old + '","' + values.new + '"';
				} else if (op === 'disable') cmd = 'AT+CLCK="SC",0,"' + values.pin + '"';
				else cmd = 'AT+CLCK="SC",1,"' + values.pin + '"';
				AtWs.client.sendCommand(cmd).then(function (res) {
					if (res.success) {
						Ui.success('操作成功');
						fetchPinStatus();
					} else {
						Ui.error(Ui.atErrorText(res, 'PIN码操作失败'));
					}
				}).catch(function () { Ui.error('PIN码操作失败'); });
			});
		}

		function handleSimSwitch(target) {
			Ui.confirm('切换 SIM 卡需要重启射频与模组，确定切换到' + (target === 0 ? '外置' : '内置') + ' SIM 卡？', function () {
				var chain = Promise.resolve();
				chain = chain.then(function () { return AtWs.client.sendCommand('AT^HVSST=1,0'); });
				chain = chain.then(function () { return AtWs.client.sendCommand('AT^SCICHG=' + target + ',' + (1 - target)); });
				chain = chain.then(function () { return AtWs.client.sendCommand('AT^HVSST=1,1'); });
				chain = chain.then(function () { return AtWs.client.sendCommand('AT+CFUN=0'); });
				chain = chain.then(function () { return AtWs.client.sendCommand('AT+CFUN=1'); });
				chain.then(function () {
					Ui.success('正在切换到' + (target === 0 ? '外置' : '内置') + 'SIM卡，请等待设备重启...');
				}).catch(function () { Ui.error('切换SIM卡失败'); });
			});
		}

		function handleSimHotPlug(checked) {
			AtWs.client.sendCommand('AT^TDSIMHP=' + (checked ? '1' : '0')).then(function (res) {
				if (res.success) { Ui.success((checked ? '开启' : '关闭') + 'SIM卡热插拔成功'); }
				else { Ui.error((checked ? '开启' : '关闭') + 'SIM卡热插拔失败'); hpChk.checked = !checked; }
			}).catch(function () { Ui.error('SIM卡热插拔设置失败'); });
		}

		function fetchPinStatus() {
			return AtWs.client.sendCommand('AT+CPIN?').then(function (res) {
				var ready = false;
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CPIN:\s*(\w+)/);
					if (m) { ready = m[1] === 'READY'; pinStatusEl.textContent = 'PIN 状态：' + m[1]; }
				}
				if (!ready) pinStatusEl.textContent = 'PIN 状态：READY';
				// 查询 PIN 是否启用
				return AtWs.client.sendCommand('AT+CLCK="SC",2');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/,(\d+)/);
					if (m) {
						var enabled = m[1] === '1';
						pinStatusEl.textContent = 'PIN 状态：READY，' + (enabled ? '已启用' : '未启用');
					}
				}
			}).catch(function () {});
		}

		/* ============ 飞行模式 ============ */
		var rfPanel = Ui.panel('射频控制', '飞行模式');
		var airplaneChk = document.createElement('input');
		airplaneChk.type = 'checkbox';
		airplaneChk.className = 'cbi-input-checkbox';
		airplaneChk.addEventListener('change', function () {
			AtWs.client.sendCommand('AT+CFUN=' + (airplaneChk.checked ? '0' : '1')).then(function (res) {
				if (res.success) Ui.success((airplaneChk.checked ? '开启' : '关闭') + '飞行模式成功');
				else { Ui.error((airplaneChk.checked ? '开启' : '关闭') + '飞行模式失败'); airplaneChk.checked = !airplaneChk.checked; }
			}).catch(function () { Ui.error('飞行模式设置失败'); });
		});
		rfPanel._body.appendChild(Ui.field('飞行模式', airplaneChk, '开启后关闭射频，恢复网络连接'));
		body.appendChild(rfPanel);

		/* ============ 网卡速率 + 电源管理 ============ */
		var ctrlPanel = Ui.panel('设备控制', '网卡速率与电源管理');
		var nicSel = document.createElement('select');
		nicSel.className = 'cbi-input-select';
		[{ v: '0', l: '自动协商' }, { v: '1', l: '1000Mbps 全双工' }, { v: '2', l: '100Mbps 全双工' }, { v: '3', l: '10Mbps 全双工' }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			nicSel.appendChild(opt);
		});
		nicSel.addEventListener('change', function () { handleSetNic(parseInt(nicSel.value, 10)); });
		ctrlPanel._body.appendChild(Ui.field('网卡速率', nicSel));

		var pwrChk = document.createElement('input');
		pwrChk.type = 'checkbox';
		pwrChk.className = 'cbi-input-checkbox';
		pwrChk.addEventListener('change', function () {
			AtWs.client.sendCommand('AT^TDPMCFG=' + (pwrChk.checked ? '1' : '0')).then(function (res) {
				if (res.success) Ui.success((pwrChk.checked ? '开启' : '关闭') + '电源管理成功');
				else { Ui.error((pwrChk.checked ? '开启' : '关闭') + '电源管理失败'); pwrChk.checked = !pwrChk.checked; }
			}).catch(function () { Ui.error('电源管理设置失败'); });
		});
		ctrlPanel._body.appendChild(Ui.field('电源管理', pwrChk, '开启后模组在无业务时进入低功耗'));
		body.appendChild(ctrlPanel);

		function handleSetNic(value) {
			AtWs.client.sendCommand('AT^TDPCIELANCFG=' + value).then(function (res) {
				if (!res.success) { Ui.error('网卡速率设置失败'); return; }
				Ui.success('网卡速率设置成功，重启后生效');
				Ui.confirm('是否立即重启模组使配置生效？', function () {
					AtWs.client.sendCommand('AT^RESET').then(function (r) {
						if (r.success) Ui.success('重启指令已发送');
						else Ui.error('重启指令发送失败');
					});
				}, '立即重启');
			}).catch(function () { Ui.error('网卡速率设置失败'); });
		}

		/* ============ NR 能力 ============ */
		var nrPanel = Ui.panel('NR 能力', '载波聚合、VoNR 与 DSS');
		var caChk = document.createElement('input');
		caChk.type = 'checkbox';
		caChk.className = 'cbi-input-checkbox';
		caChk.addEventListener('change', function () {
			AtWs.client.sendCommand('AT^NRRCCAPCFG=3,' + (caChk.checked ? 1 : 0)).then(function (res) {
				if (res.success) Ui.success((caChk.checked ? '开启' : '关闭') + '载波聚合成功');
				else { Ui.error((caChk.checked ? '开启' : '关闭') + '载波聚合失败'); caChk.checked = !caChk.checked; }
			}).catch(function () { Ui.error('载波聚合设置失败'); });
		});
		nrPanel._body.appendChild(Ui.field('NR 载波聚合', caChk));

		var vonrSel = document.createElement('select');
		vonrSel.className = 'cbi-input-select';
		[{ v: '0', l: '关闭' }, { v: '1', l: 'FR1-VoNR' }, { v: '2', l: 'FR2-VoNR' }, { v: '3', l: 'FR1+FR2-VoNR' }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			vonrSel.appendChild(opt);
		});
		vonrSel.addEventListener('change', function () {
			AtWs.client.sendCommand('AT^NRRCCAPCFG=2,' + parseInt(vonrSel.value, 10)).then(function (res) {
				if (res.success) Ui.success('VoNR 配置成功');
				else Ui.error('VoNR 配置失败');
			}).catch(function () { Ui.error('VoNR 配置失败'); });
		});
		nrPanel._body.appendChild(Ui.field('VoNR', vonrSel));

		var dssChk = document.createElement('input');
		dssChk.type = 'checkbox';
		dssChk.className = 'cbi-input-checkbox';
		dssChk.addEventListener('change', function () {
			AtWs.client.sendCommand('AT^NRRCCAPCFG=5,' + (dssChk.checked ? 1 : 0) + ',0').then(function (res) {
				if (res.success) Ui.success('DSS 配置成功');
				else { Ui.error('DSS 配置失败'); dssChk.checked = !dssChk.checked; }
			}).catch(function () { Ui.error('DSS 配置失败'); });
		});
		nrPanel._body.appendChild(Ui.field('NR DSS', dssChk, 'LTE/NR 动态频谱共享'));
		body.appendChild(nrPanel);

		function fetchNRCapability() {
			return AtWs.client.sendCommand('AT^NRRCCAPQRY=3').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^NRRCCAPQRY:\s*3,(\d+)/);
					if (m) caChk.checked = m[1] === '1';
				}
				return AtWs.client.sendCommand('AT^NRRCCAPQRY=2');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^NRRCCAPQRY:\s*2,(\d+)/);
					if (m) vonrSel.value = String(parseInt(m[1], 10));
				}
				return AtWs.client.sendCommand('AT^NRRCCAPQRY=5');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^NRRCCAPQRY:\s*5,(\d+),(\d+)/);
					if (m) dssChk.checked = m[1] === '1';
				}
			}).catch(function () {});
		}

		/* ============ 网络系统配置 SYSCFGEX ============ */
		var sysPanel = Ui.panel('网络系统配置', '接入方式、频段、漫游与服务域（SYSCFGEX）');
		var sysCfg = { acqorder: '', band: '', roam: 1, srvdomain: 2, lteband: '' };

		var acqInput = document.createElement('input');
		acqInput.className = 'cbi-input-text';
		acqInput.placeholder = '如 0504030200（5G→4G→3G→2G）';
		acqInput.addEventListener('input', function () { sysCfg.acqorder = acqInput.value; });
		sysPanel._body.appendChild(Ui.field('接入顺序', acqInput));

		var bandInput = document.createElement('input');
		bandInput.className = 'cbi-input-text';
		bandInput.placeholder = '频段位图，留空为全部';
		bandInput.addEventListener('input', function () { sysCfg.band = bandInput.value; });
		sysPanel._body.appendChild(Ui.field('频段', bandInput));

		var roamSel = document.createElement('select');
		roamSel.className = 'cbi-input-select';
		[{ v: '1', l: '仅本网' }, { v: '2', l: '自动漫游' }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			roamSel.appendChild(opt);
		});
		roamSel.addEventListener('change', function () { sysCfg.roam = parseInt(roamSel.value, 10); });
		sysPanel._body.appendChild(Ui.field('漫游', roamSel));

		var srvSel = document.createElement('select');
		srvSel.className = 'cbi-input-select';
		[{ v: '0', l: '仅电路域' }, { v: '1', l: '仅分组域' }, { v: '2', l: '电路+分组域' }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			srvSel.appendChild(opt);
		});
		srvSel.addEventListener('change', function () { sysCfg.srvdomain = parseInt(srvSel.value, 10); });
		sysPanel._body.appendChild(Ui.field('服务域', srvSel));

		var lteBandInput = document.createElement('input');
		lteBandInput.className = 'cbi-input-text';
		lteBandInput.placeholder = 'LTE 频段位图，留空为全部';
		lteBandInput.addEventListener('input', function () { sysCfg.lteband = lteBandInput.value; });
		sysPanel._body.appendChild(Ui.field('LTE 频段', lteBandInput));

		var sysSaveBtn = Ui.primaryButton('保存网络配置', function () {
			var cmd = 'AT^SYSCFGEX="' + sysCfg.acqorder + '",' + sysCfg.band + ',' + sysCfg.roam + ',' + sysCfg.srvdomain + ',' + sysCfg.lteband + ',,';
			AtWs.client.sendCommand(cmd).then(function (res) {
				if (res.success) { Ui.success('网络系统配置已更新'); }
				else { Ui.error('网络系统配置更新失败'); }
			}).catch(function () { Ui.error('网络系统配置更新失败'); });
		});
		sysPanel._body.appendChild(sysSaveBtn);
		body.appendChild(sysPanel);

		function fetchSysCfg() {
			return AtWs.client.sendCommand('AT^SYSCFGEX?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^SYSCFGEX:\s*"([^"]*)",([^,]*),(\d+),(\d+),([^,]*)/);
					if (m) {
						sysCfg.acqorder = m[1]; sysCfg.band = m[2].trim(); sysCfg.roam = Number(m[3]);
						sysCfg.srvdomain = Number(m[4]); sysCfg.lteband = m[5].trim();
						acqInput.value = sysCfg.acqorder;
						bandInput.value = sysCfg.band;
						roamSel.value = String(sysCfg.roam);
						srvSel.value = String(sysCfg.srvdomain);
						lteBandInput.value = sysCfg.lteband;
					}
				}
			}).catch(function () {});
		}

		/* ============ 温度保护 ============ */
		var thermPanel = Ui.panel('温度保护', '自动温度保护与检测参数（THERM）');
		var thermStatus = E('div', { 'class': 'at-hint' }, '温度保护：—');
		thermPanel._body.appendChild(thermStatus);

		var thermChk = document.createElement('input');
		thermChk.type = 'checkbox';
		thermChk.className = 'cbi-input-checkbox';
		thermChk.addEventListener('change', function () {
			AtWs.client.sendCommand('AT^THERMAUTOFUN=' + (thermChk.checked ? 1 : 0) + ',' + (thermCaChk.checked ? 1 : 0) + ',' + (thermIntervalInput.value || 5)).then(function (res) {
				if (res.success) Ui.success((thermChk.checked ? '开启' : '关闭') + '温度保护功能成功');
				else { Ui.error((thermChk.checked ? '开启' : '关闭') + '温度保护功能失败'); thermChk.checked = !thermChk.checked; }
			}).catch(function () { Ui.error('温度保护设置失败'); });
		});
		thermPanel._body.appendChild(Ui.field('温度保护功能', thermChk));

		var thermCaChk = document.createElement('input');
		thermCaChk.type = 'checkbox';
		thermCaChk.className = 'cbi-input-checkbox';
		thermPanel._body.appendChild(Ui.field('高温时关闭 CA/MIMO', thermCaChk));

		var thermIntervalInput = document.createElement('input');
		thermIntervalInput.type = 'number';
		thermIntervalInput.className = 'cbi-input-text';
		thermIntervalInput.min = 1;
		thermIntervalInput.value = '5';
		thermIntervalInput.addEventListener('input', function () {
			AtWs.client.sendCommand('AT^THERMAUTOFUN=' + (thermChk.checked ? 1 : 0) + ',' + (thermCaChk.checked ? 1 : 0) + ',' + (thermIntervalInput.value || 5)).then(function (res) {
				if (res.success) Ui.success('温度检测间隔设置成功');
				else Ui.error('温度检测间隔设置失败');
			}).catch(function () { Ui.error('温度检测间隔设置失败'); });
		});
		thermPanel._body.appendChild(Ui.field('检测间隔（秒）', thermIntervalInput));

		var thermLogsEl = E('div', { 'class': 'at-hint' }, '');
		thermPanel._body.appendChild(thermLogsEl);

		var thermThresholdsEl = E('div', { 'class': 'at-hint' }, '');
		thermPanel._body.appendChild(thermThresholdsEl);
		body.appendChild(thermPanel);

		function fetchThermConfig() {
			return AtWs.client.sendCommand('AT^THERMAUTOFUN?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^THERMAUTOFUN:\s*(\d+)\s+(\d+)\s+(\d+)/);
					if (m) {
						thermChk.checked = m[1] === '1';
						thermCaChk.checked = m[2] === '1';
						thermIntervalInput.value = String(m[3]);
					}
				}
				return AtWs.client.sendCommand('AT^THERMLDLOGSW?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^THERMLDLOGSW:\s*(\d+)\s+(\d+)/);
					if (m) thermLogsEl.textContent = '热抑制日志开关：' + (m[1] === '1' ? '开' : '关') + '，当前日志等级：' + m[2];
				}
				return AtWs.client.sendCommand('AT^THERMLDAUTOPARA?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^THERMLDAUTOPARA:\s*([\d,]+)/);
					if (m) thermThresholdsEl.textContent = '温保阈值参数：' + m[1];
				}
				return AtWs.client.sendCommand('AT^THERMLDAUTOSTATUS?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^THERMLDAUTOSTATUS:\s*([\d,]+)/);
					if (m) {
						var nums = m[1].split(',').map(Number);
						var levelText = '温度保护状态（1 正常 / 2 一级 / 3 二级 / 4 三级 / 5 四级温保）：' + m[1];
						// 手册：第 6 个字段是当前温保等级
						if (nums.length >= 6) {
							levelText += '，当前等级：' + nums[5];
						}
						thermStatus.textContent = levelText;
					}
				}
			}).catch(function () {});
		}

		/* ============ 系统控制 ============ */
		var sysCtrlPanel = Ui.panel('系统控制', '重启与恢复出厂');
		var rebootBtn = Ui.dangerButton('重启模组', function () {
			Ui.confirm('确定重启模组？网络将暂时中断。', function () {
				AtWs.client.sendCommand('AT^RESET').then(function (res) {
					if (res.success) Ui.success('重启指令已发送');
					else Ui.error('重启指令发送失败');
				}).catch(function () { Ui.error('重启指令发送失败'); });
			});
		});
		var factoryBtn = Ui.dangerButton('恢复出厂设置', function () {
			Ui.confirm('确定恢复出厂设置？所有配置将被清空。', function () {
				AtWs.client.sendCommand('AT&F').then(function (res) {
					if (res.success) Ui.success('恢复出厂设置指令已发送');
					else Ui.error('恢复出厂设置指令发送失败');
				}).catch(function () { Ui.error('恢复出厂设置指令发送失败'); });
			});
		});
		var sysActions = E('div', { 'class': 'at-panel-actions' });
		sysActions.appendChild(rebootBtn);
		sysActions.appendChild(factoryBtn);
		sysCtrlPanel._body.appendChild(sysActions);
		body.appendChild(sysCtrlPanel);

		/* ============ 数据加载 ============ */

		function fetchDeviceInfo() {
			return AtWs.client.sendCommand('ATI').then(function (res) {
				if (res.success && res.data) {
					var lines = String(res.data).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
					lines.forEach(function (l) {
						if (l.indexOf('Manufacturer:') === 0) dev.manufacturer = l.split(':')[1].trim();
						if (l.indexOf('Model:') === 0) dev.model = l.split(':')[1].trim();
						if (l.indexOf('Revision:') === 0) dev.revision = l.split(':')[1].trim();
					});
				}
				return AtWs.client.sendCommand('AT+CGSN');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/(\d{15})/);
					if (m) { dev.imei = m[1]; imeiEl.textContent = m[1]; }
				}
				return AtWs.client.sendCommand('AT+CONNECT?');
			}).then(function (res) {
				if (res.success && res.data) {
					var lines = String(res.data).split(/[\r\n]+/).filter(function (l) { return l.trim(); });
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
			return AtWs.client.sendCommand('AT^SCICHG?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^SCICHG:\s*(\d+),\s*(\d+)/);
					if (m) simSlotSel.value = String(m[1]);
				}
				return AtWs.client.sendCommand('AT^TDSIMHP?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^TDSIMHP:\s*(\d+)/);
					if (m) hpChk.checked = m[1] === '1';
				}
				return AtWs.client.sendCommand('AT^SIMSQ?');
			}).then(function (res) {
				if (res.success && res.data) {
					var sq = Parse.parseSimsq(res.data);
					if (sq) {
						simSqEl.textContent = 'SIM 状态：' + sq.label +
							(sq.dead ? '（卡已失效，无法恢复）' : '');
					}
				}
				return fetchPinStatus();
			}).catch(function () {});
		}

		function fetchAirplane() {
			return AtWs.client.sendCommand('AT+CFUN?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CFUN:\s*(\d+)/);
					if (m) airplaneChk.checked = m[1] === '0';
				}
			}).catch(function () {});
		}

		function fetchDeviceControl() {
			return AtWs.client.sendCommand('AT^TDPCIELANCFG?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^TDPCIELANCFG:\s*(\d+)/);
					if (m) nicSel.value = String(m[1]);
				}
				return AtWs.client.sendCommand('AT^TDPMCFG?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^TDPMCFG:\s*(\d+)/);
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

		var refreshBtn = Ui.primaryButton('刷新', loadAll);
		var extra = E('div', { 'class': 'at-panel-actions' });
		extra.appendChild(refreshBtn);
		body.appendChild(extra);

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) AtWs.client.connect(values.key).catch(function (e) { Ui.error((e && e.message) || '认证失败'); });
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
