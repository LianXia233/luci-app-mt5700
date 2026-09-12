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

		var sysCard = Mt5700.card('网络系统配置', '接入方式、频段、漫游与服务域（SYSCFGEX）');
		var sysBody = E('div');
		sysCard._body.appendChild(sysBody);
		body.appendChild(sysCard);

		var sysCfg = { acqorder: '', band: '', roam: 1, srvdomain: 2, lteband: '' };

		var acqInput = Mt5700.input('text', '如 0504030200（5G→4G→3G→2G）', '');
		acqInput.addEventListener('input', function () { sysCfg.acqorder = acqInput.value; });
		sysBody.appendChild(Mt5700.formGroup('接入顺序', acqInput));

		var bandInput = Mt5700.input('text', '频段位图，留空为全部', '');
		bandInput.addEventListener('input', function () { sysCfg.band = bandInput.value; });
		sysBody.appendChild(Mt5700.formGroup('频段', bandInput));

		var roamSel = Mt5700.select([
			{ label: '仅本网', value: '1' },
			{ label: '自动漫游', value: '2' }
		], '1');
		roamSel.addEventListener('change', function () { sysCfg.roam = parseInt(roamSel.value, 10); });
		sysBody.appendChild(Mt5700.formGroup('漫游', roamSel));

		var srvSel = Mt5700.select([
			{ label: '仅电路域', value: '0' },
			{ label: '仅分组域', value: '1' },
			{ label: '电路+分组域', value: '2' }
		], '2');
		srvSel.addEventListener('change', function () { sysCfg.srvdomain = parseInt(srvSel.value, 10); });
		sysBody.appendChild(Mt5700.formGroup('服务域', srvSel));

		var lteBandInput = Mt5700.input('text', 'LTE 频段位图，留空为全部', '');
		lteBandInput.addEventListener('input', function () { sysCfg.lteband = lteBandInput.value; });
		sysBody.appendChild(Mt5700.formGroup('LTE 频段', lteBandInput));

		sysBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('保存网络配置', function () {
				var cmd = 'AT^SYSCFGEX="' + sysCfg.acqorder + '",' + sysCfg.band + ',' + sysCfg.roam + ',' + sysCfg.srvdomain + ',' + sysCfg.lteband + ',,';
				send(cmd).then(function (res) {
					if (res.success) Mt5700.success('网络系统配置已更新');
					else Mt5700.error('网络系统配置更新失败');
				}).catch(function () { Mt5700.error('网络系统配置更新失败'); });
			})
		));

		function fetchSysCfg() {
			return send('AT^SYSCFGEX?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^SYSCFGEX:\s*"([^"]*)",([^,]*),(\d+),(\d+),([^,]*)/);
					if (m) {
						sysCfg.acqorder = m[1];
						sysCfg.band = m[2].trim();
						sysCfg.roam = Number(m[3]);
						sysCfg.srvdomain = Number(m[4]);
						sysCfg.lteband = m[5].trim();
						acqInput.value = sysCfg.acqorder;
						bandInput.value = sysCfg.band;
						roamSel.value = String(sysCfg.roam);
						srvSel.value = String(sysCfg.srvdomain);
						lteBandInput.value = sysCfg.lteband;
					}
				}
			}).catch(function () {});
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
