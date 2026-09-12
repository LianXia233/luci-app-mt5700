'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Parse, Ui */

/**
 * 拨号设置（原 WebUI 网络 → 拨号设置）
 * 等价迁移 network/Dial.tsx：自动拨号开关、APN 设置、拨号方式、USB 端口模式、
 * 网口模式、后路由、DMZ、PDP 上下文管理（增删改激活）。
 */

return L.view.extend({
	render: function () {
		var page = Ui.page('拨号设置', '自动拨号、APN、模式配置与 PDP 上下文');
		var body = page._body;
		Ui.renderConnectionBar(body);

		/* ---------- 常量（等价原件） ---------- */
		var DIAL_MODE_OPTIONS = [
			{ label: 'USB网络接口', value: 1 }, { label: '转网口模式', value: 2 }
		];
		var USB_MODE_OPTIONS = [
			{ label: 'Linux-ECM正常模式', value: 0 }, { label: 'Windows-NCM正常模式', value: 1 },
			{ label: 'Linux-ECM调试模式', value: 2 }, { label: 'Windows-NCM调试模式', value: 3 },
			{ label: 'Linux-NCM正常模式', value: 4 }, { label: 'Linux-NCM调试模式', value: 5 },
			{ label: 'Windows-RNDIS单端口模式', value: 6 }, { label: 'Windows/Linux-PPP端口模式', value: 8 }
		];
		var INCFG_MODE_OPTIONS = [
			{ label: 'USB Stick + 网口 E5 数传模式', value: 1 },
			{ label: 'USB E5 + 网口 E5 数传模式', value: 2 },
			{ label: '网口直通模式(需执行拨号命令)', value: 3 }
		];
		var AUTH_OPTIONS = [
			{ label: '无认证', value: 0 }, { label: 'PAP 认证', value: 1 }, { label: 'CHAP 认证', value: 2 }
		];
		var PDP_TYPE_OPTIONS = [
			{ label: 'IPv4', value: 'IP' }, { label: 'IPv6', value: 'IPV6' }, { label: 'IPv4/IPv6', value: 'IPV4V6' }
		];

		var getDialModeText = function (mode) {
			if (mode == null) return '未识别';
			var map = { 1: 'USB网络接口', 2: '转网口模式' };
			return map[mode] || '未知';
		};
		var getUSBModeText = function (mode) {
			var map = {
				0: 'Linux-ECM正常模式', 1: 'Windows-NCM正常模式', 2: 'Linux-ECM调试模式',
				3: 'Windows-NCM调试模式', 4: 'Linux-NCM正常模式', 5: 'Linux-NCM调试模式',
				6: 'Windows-RNDIS单端口模式', 7: 'Windows-MBIM单端口模式(暂不支持)', 8: 'Windows/Linux-PPP端口模式'
			};
			return map[mode] || '未知模式';
		};
		var getInfcfgModeText = function (mode) {
			if (mode === 1) return 'USB Stick + 网口 E5 数传模式';
			if (mode === 2) return 'USB E5 + 网口 E5 数传模式';
			if (mode === 3) return '网口直通模式';
			return '未配置';
		};
		var getAuthTypeText = function (type) {
			if (type === 0) return '无鉴权';
			if (type === 1) return 'PAP鉴权';
			if (type === 2) return 'CHAP鉴权';
			return '未知';
		};
		var getPdpTypeText = function (type) {
			if (type === 'IP') return 'IPv4';
			if (type === 'IPV6') return 'IPv6';
			if (type === 'IPV4V6') return 'IPv4/IPv6';
			return type;
		};

		/* ---------- 状态 ---------- */
		var settings = { enable: 0, protocol: '', apn: '', username: '', password: '', authType: 0 };
		var apnForm = { apn: '', username: '', password: '', authType: 0 };
		var dmzConfig = { enabled: false, host: '' };
		var pdpList = [];

		/* ---------- 解析（等价原件） ---------- */
		function parseAutoDialResponse(raw) {
			var line = raw.replace(/\r/g, '').split('\n').map(function (i) { return i.trim(); })
				.find(function (i) { return i.indexOf('^SETAUTODIAL:') === 0; });
			if (!line) return null;
			var payload = line.slice(line.indexOf(':') + 1).trim();
			var fields = (payload.match(/(?:[^,"]+|"[^"]*")+/g) || []).map(function (f) { return f.trim().replace(/^"|"$/g, ''); });
			if (!fields.length || !/^\d+$/.test(fields[0])) return null;
			var parsed = { enable: Number(fields[0]) };
			if (fields.length >= 2 && /^\d+$/.test(fields[1])) parsed.dialMode = Number(fields[1]);
			if (fields.length >= 3) parsed.protocol = fields[2] || '';
			if (fields.length >= 4) parsed.apn = fields[3] || '';
			if (fields.length >= 5) parsed.username = fields[4] || '';
			if (fields.length >= 6) parsed.password = fields[5] || '';
			if (fields.length >= 7 && /^\d+$/.test(fields[6])) parsed.authType = Number(fields[6]);
			return parsed;
		}

		var ndisIsActive = function (raw) { return /\^NDISSTATQRY:\s*1\s*,/i.test(String(raw).replace(/\r/g, '')); };

		function parseTDCFG(raw) {
			var modeMatch = String(raw).match(/Mode\s*:\s*(\d+)/);
			var postRouteMatch = String(raw).match(/PostRoute\s*:\s*(\d+)/);
			var dmzLine = String(raw).split('\n').find(function (l) { return l.trim().indexOf('Dmz:') === 0; });
			var dmzValue = dmzLine ? dmzLine.split(':')[1].trim() : 'not cfg';
			return {
				mode: modeMatch ? parseInt(modeMatch[1], 10) : undefined,
				postRoute: postRouteMatch ? parseInt(postRouteMatch[1], 10) : undefined,
				dmz: { enabled: dmzValue !== 'not cfg', host: dmzValue !== 'not cfg' ? dmzValue : '' }
			};
		}

		/* ---------- 面板：自动拨号 ---------- */
		var dialPanel = Ui.panel('自动拨号', '开启后设备将自动保持网络连接，建议保持开启状态');
		var dialStatus = E('div', { 'class': 'at-tags' });
		dialPanel._body.appendChild(dialStatus);

		var apnRow = Ui.field('APN', (function () {
			var input = document.createElement('input');
			input.className = 'cbi-input-text';
			input.placeholder = '请输入 APN';
			input.maxLength = 99;
			input.addEventListener('input', function () { apnForm.apn = input.value; });
			return input;
		})());
		dialPanel._body.appendChild(apnRow);

		var userRow = Ui.field('用户名', (function () {
			var input = document.createElement('input');
			input.className = 'cbi-input-text';
			input.placeholder = '请输入用户名（可选）';
			input.maxLength = 31;
			input.addEventListener('input', function () { apnForm.username = input.value; });
			return input;
		})());
		dialPanel._body.appendChild(userRow);

		var passRow = Ui.field('密码', (function () {
			var input = document.createElement('input');
			input.className = 'cbi-input-text';
			input.placeholder = '请输入密码（可选）';
			input.maxLength = 31;
			input.addEventListener('input', function () { apnForm.password = input.value; });
			return input;
		})());
		dialPanel._body.appendChild(passRow);

		var authSel = document.createElement('select');
		authSel.className = 'cbi-input-select';
		AUTH_OPTIONS.forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = String(o.value); opt.textContent = o.label;
			authSel.appendChild(opt);
		});
		authSel.addEventListener('change', function () { apnForm.authType = parseInt(authSel.value, 10); });
		dialPanel._body.appendChild(Ui.field('认证方式', authSel));

		var apnSaveBtn = Ui.primaryButton('保存 APN 设置', function () { handleApnSettingChange(); });
		var authCurrent = E('span', { 'class': 'at-hint' }, '当前认证：无鉴权');
		var apnActions = E('div', { 'class': 'at-panel-actions' });
		apnActions.appendChild(apnSaveBtn);
		apnActions.appendChild(authCurrent);
		dialPanel._body.appendChild(apnActions);
		body.appendChild(dialPanel);

		/* ---------- 面板：拨号方式 + USB ---------- */
		var modePanel = Ui.panel('模式配置', '拨号方式与 USB 端口模式');
		var dialModeSel = document.createElement('select');
		dialModeSel.className = 'cbi-input-select';
		DIAL_MODE_OPTIONS.forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = String(o.value); opt.textContent = o.label;
			dialModeSel.appendChild(opt);
		});
		dialModeSel.addEventListener('change', function () { handleDialModeChange(parseInt(dialModeSel.value, 10)); });
		modePanel._body.appendChild(Ui.field('拨号方式', dialModeSel));

		var usbSel = document.createElement('select');
		usbSel.className = 'cbi-input-select';
		USB_MODE_OPTIONS.forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = String(o.value); opt.textContent = o.label;
			usbSel.appendChild(opt);
		});
		usbSel.addEventListener('change', function () { handleUSBModeChange(parseInt(usbSel.value, 10)); });
		modePanel._body.appendChild(Ui.field('USB 端口模式', usbSel));
		body.appendChild(modePanel);

		/* ---------- 面板：网口模式 + DMZ ---------- */
		var infPanel = Ui.panel('网口模式与 DMZ', '网口数传模式、后路由与 DMZ 主机');
		var infcfgSel = document.createElement('select');
		infcfgSel.className = 'cbi-input-select';
		INCFG_MODE_OPTIONS.forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = String(o.value); opt.textContent = o.label;
			infcfgSel.appendChild(opt);
		});
		infcfgSel.addEventListener('change', function () { handleInfcfgModeChange(parseInt(infcfgSel.value, 10)); });
		infPanel._body.appendChild(Ui.field('网口模式', infcfgSel));

		var postRouteSel = document.createElement('select');
		postRouteSel.className = 'cbi-input-select';
		[{ label: '关闭后路由', value: 0 }, { label: '开启后路由', value: 1 }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = String(o.value); opt.textContent = o.label;
			postRouteSel.appendChild(opt);
		});
		postRouteSel.addEventListener('change', function () { handlePostRouteChange(parseInt(postRouteSel.value, 10)); });
		infPanel._body.appendChild(Ui.field('后路由', postRouteSel));

		var dmzInput = document.createElement('input');
		dmzInput.className = 'cbi-input-text';
		dmzInput.placeholder = '如 192.168.1.100';
		var dmzSetBtn = Ui.button('设置 DMZ', 'cbi-button-action', function () {
			if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(dmzInput.value.trim())) { Ui.error('请输入有效的 IP 地址'); return; }
			Ui.confirm('确定将 DMZ 主机设置为 ' + dmzInput.value.trim() + '？', function () { handleDMZ('enable', dmzInput.value.trim()); });
		});
		var dmzRow = Ui.field('DMZ 主机', dmzInput);
		dmzRow.querySelector('.at-field-control').appendChild(dmzSetBtn);
		infPanel._body.appendChild(dmzRow);
		var dmzStatus = E('div', { 'class': 'at-hint' }, 'DMZ 状态：未配置');
		infPanel._body.appendChild(dmzStatus);
		var dmzDisableBtn = Ui.button('关闭 DMZ', 'cbi-button-negative', function () {
			Ui.confirm('确定关闭 DMZ？', function () { handleDMZ('disable'); });
		});
		infPanel._body.appendChild(dmzDisableBtn);
		body.appendChild(infPanel);

		/* ---------- 面板：PDP 上下文 ---------- */
		var pdpPanel = Ui.panel('PDP 上下文', 'CGDCONT 列表：新增、编辑、删除、激活/去激活');
		var pdpAddBtn = Ui.primaryButton('+ 新增', function () { openEdit(null); });
		var pdpRefresh = Ui.button('刷新', 'cbi-button-action', function () { fetchPDPContexts(); });
		var pdpActions = E('div', { 'class': 'at-panel-actions' });
		pdpActions.appendChild(pdpAddBtn);
		pdpActions.appendChild(pdpRefresh);
		pdpPanel._body.appendChild(pdpActions);
		var pdpTable = E('table', { 'class': 'cbi-section-table at-table' });
		pdpPanel._body.appendChild(pdpTable);
		body.appendChild(pdpPanel);

		/* ---------- 动作（等价原件） ---------- */

		function renderDialStatus() {
			dialStatus.innerHTML = '';
			dialStatus.appendChild(Ui.tag(settings.enable === 1 ? '已开启' : '已关闭', settings.enable === 1 ? 'green' : 'orange'));
			dialStatus.appendChild(Ui.tag('拨号方式：' + getDialModeText(settings.dialMode), 'blue'));
			dialStatus.appendChild(Ui.tag('协议：' + (settings.protocol || '-'), 'red'));
			authCurrent.textContent = '当前认证：' + getAuthTypeText(settings.authType);
			// 同步表单
			var inputs = dialPanel._body.querySelectorAll('.cbi-input-text');
			inputs[0].value = apnForm.apn || '';
			inputs[1].value = apnForm.username || '';
			inputs[2].value = apnForm.password || '';
			authSel.value = String(apnForm.authType || 0);
			dialModeSel.value = String(settings.dialMode != null ? settings.dialMode : '');
			usbSel.value = String(settings.usbMode != null ? settings.usbMode : '');
			infcfgSel.value = String(settings.infcfgMode != null ? settings.infcfgMode : '');
			postRouteSel.value = String(settings.postRoute != null ? settings.postRoute : '');
			dmzStatus.textContent = 'DMZ 状态：' + (dmzConfig.enabled ? '已开启 → ' + dmzConfig.host : '未配置');
		}

		function fetchDialSettings() {
			return Ui.sendCmd('AT^SETAUTODIAL?').then(function (res) {
				if (res.success && res.data) {
					var parsed = parseAutoDialResponse(String(res.data));
					if (!parsed) throw new Error('无法解析自动拨号状态');
					if (parsed.dialMode == null) {
						return Ui.sendCmd('AT^NDISSTATQRY?').then(function (ndis) {
							if (ndis.success && ndis.data && ndisIsActive(String(ndis.data))) parsed.dialMode = 1;
							return parsed;
						});
					}
					return parsed;
				}
				return null;
			}).then(function (parsed) {
				if (parsed) {
					Object.keys(parsed).forEach(function (k) { settings[k] = parsed[k]; });
					if (parsed.apn != null) apnForm.apn = parsed.apn;
					if (parsed.username != null) apnForm.username = parsed.username;
					if (parsed.password != null) apnForm.password = parsed.password;
					if (parsed.authType != null) apnForm.authType = parsed.authType;

					// 同步复选框，避免界面上显示的开关状态与模组实际状态不一致。
					dialSwitch.checked = parsed.enable === 1;

					// 模组实际状态与 UCI 期望值不一致时，把「默认开启」持久化下来，
					// 让服务重启后依然按此配置对齐（见后端 ensure_autodial）。
					syncAutodialDefault(parsed.enable === 1, parsed.dialMode);
				}
				renderDialStatus();
			}).catch(function () { Ui.error('获取拨号配置失败'); });
		}

		// 把自动拨号期望状态写入 UCI，供后端在每次连上模组后对齐。
		// 仅在值发生变化时写盘，避免每次进页面都产生一次无谓的 commit。
		function syncAutodialDefault(enabled, mode) {
			var wantEnable = enabled ? '1' : '0';
			var wantMode = String(mode != null ? mode : 1);
			if (wantMode !== '1' && wantMode !== '2') wantMode = '1';

			var curEnable = L.uci.get('at-webserver', 'config', 'autodial_enable');
			var curMode = L.uci.get('at-webserver', 'config', 'autodial_mode');
			if (curEnable === wantEnable && curMode === wantMode) return;
			if (curEnable == null && wantEnable === '1' && curMode == null) return;

			L.uci.set('at-webserver', 'config', 'autodial_enable', wantEnable);
			L.uci.set('at-webserver', 'config', 'autodial_mode', wantMode);
			AtWs.uci.uciCommit('at-webserver').catch(function () {
				/* 持久化失败不阻断页面，后端仍按当前 UCI 值工作 */
			});
		}

		function handleAutoDialChange(checked) {
			var cmd = checked ? 'AT^SETAUTODIAL=1,' + (settings.dialMode || 1) : 'AT^SETAUTODIAL=0';
			Ui.sendCmd(cmd).then(function (res) {
				if (res.success) {
					Ui.success(checked ? '已开启自动拨号' : '已关闭自动拨号');
					settings.enable = checked ? 1 : 0;
					renderDialStatus();
				} else {
					Ui.error('设置失败');
				}
				return fetchDialSettings();
			}).catch(function () { Ui.error('操作失败，请重试'); });
		}

		function handleApnSettingChange() {
			var cmd = 'AT^SETAUTODIAL=' + settings.enable + ',' + settings.dialMode + ',"' + settings.protocol + '","' +
				apnForm.apn + '","' + apnForm.username + '","' + apnForm.password + '",' + apnForm.authType;
			Ui.sendCmd(cmd).then(function (res) {
				if (res.success) {
					Ui.success('APN 设置已更新');
					settings.apn = apnForm.apn; settings.username = apnForm.username;
					settings.password = apnForm.password; settings.authType = apnForm.authType;
					return fetchDialSettings();
				}
				Ui.error('设置失败');
			}).catch(function () { Ui.error('设置失败，请重试'); });
		}

		function handleDialModeChange(mode) {
			if (settings.enable === 1) { Ui.warning('请先关闭自动拨号后再修改拨号方式'); return; }
			Ui.confirm('确定将拨号方式改为「' + getDialModeText(mode) + '」？修改后需重新开启自动拨号才能生效，过程中网络可能临时中断。', function () {
				Ui.sendCmd('AT^SETAUTODIAL=1,' + mode).then(function (res) {
					if (res.success) {
						Ui.success('拨号方式修改成功并已开启自动拨号');
						settings.dialMode = mode; settings.enable = 1;
					} else {
						Ui.error('设置失败');
					}
					return fetchDialSettings();
				}).catch(function () { Ui.error('设置失败，请重试'); });
			});
		}

		function handleUSBModeChange(mode) {
			Ui.confirm('修改 USB 端口模式后，设备将会自动重启以应用新的配置。确定继续？', function () {
				Ui.sendCmd('AT^SETMODE=' + mode).then(function (res) {
					if (res.success) {
						Ui.success('USB端口模式设置成功，设备即将重启');
						settings.usbMode = mode;
					} else {
						Ui.error('设置失败');
					}
					return fetchUSBMode();
				}).catch(function () { Ui.error('设置失败，请重试'); });
			});
		}

		function fetchUSBMode() {
			return Ui.sendCmd('AT^SETMODE?').then(function (res) {
				if (res.success && res.data) {
					var mode = parseInt(String(res.data).trim(), 10);
					if (!isNaN(mode)) { settings.usbMode = mode; renderDialStatus(); }
				}
			}).catch(function () { Ui.error('获取USB模式失败'); });
		}

		function fetchInfcfg() {
			return Ui.sendCmd('AT^TDCFG?').then(function (res) {
				if (res.success && res.data) {
					var parsed = parseTDCFG(String(res.data));
					if (parsed.mode !== undefined) settings.infcfgMode = parsed.mode;
					if (parsed.postRoute !== undefined) settings.postRoute = parsed.postRoute;
					dmzConfig = parsed.dmz;
					renderDialStatus();
				}
			}).catch(function () { Ui.error('获取网口模式配置失败'); });
		}

		function handleInfcfgModeChange(mode) {
			Ui.confirm('网口模式设置成功，设备需要重启生效。确定将网口模式改为「' + getInfcfgModeText(mode) + '」？', function () {
				Ui.sendCmd('AT^TDCFG="infcfg","mode",' + mode).then(function (res) {
					if (res.success) {
						Ui.success('网口模式设置成功，设备需要重启生效');
						settings.infcfgMode = mode;
						renderDialStatus();
					} else { Ui.error('设置失败'); }
				}).catch(function () { Ui.error('设置失败，请重试'); });
			});
		}

		function handlePostRouteChange(value) {
			if (value === 1) {
				Ui.sendCmd('AT^IPFILTERSWITCH=0').then(function (ipFilter) {
					if (!ipFilter.success) throw new Error('关闭IP过滤失败');
					return Ui.sendCmd('AT^TDCFG="infcfg","PostRoute",' + value);
				}).then(function (res) {
					if (res.success) {
						Ui.success('已开启后路由');
						settings.postRoute = value;
						renderDialStatus();
					} else { Ui.error('设置失败'); }
				}).catch(function (err) { Ui.error(err && err.message ? err.message : '设置后路由失败'); });
			} else {
				Ui.sendCmd('AT^TDCFG="infcfg","PostRoute",0').then(function (res) {
					if (res.success) {
						Ui.success('已关闭后路由');
						settings.postRoute = 0;
						renderDialStatus();
					} else { Ui.error('设置失败'); }
				}).catch(function () { Ui.error('设置后路由失败'); });
			}
		}

		function handleDMZ(action, ip) {
			var cmd = action === 'enable' ? 'AT^TDCFG="infcfg","dmz","' + ip + '"' : 'AT^TDCFG="infcfg","dmz","0"';
			Ui.sendCmd(cmd).then(function (res) {
				if (res.success) {
					if (action === 'enable') { Ui.success('DMZ配置成功，建议重新拨号以确保生效'); dmzConfig = { enabled: true, host: ip }; }
					else { Ui.success('DMZ已关闭'); dmzConfig = { enabled: false, host: '' }; }
					renderDialStatus();
				} else {
					Ui.error(action === 'enable' ? 'DMZ配置失败' : '关闭DMZ失败');
				}
			}).catch(function () { Ui.error(action === 'enable' ? 'DMZ配置失败' : '关闭DMZ失败'); });
		}

		/* ---------- PDP 上下文 ---------- */
		function fetchPDPContexts() {
			return Ui.sendCmd('AT+CGDCONT?').then(function (resp1) {
				return Ui.sendCmd('AT+CGACT?').then(function (resp2) {
					var list = [];
					if (resp1.data) {
						String(resp1.data).split('\n').forEach(function (line) {
							if (line.indexOf('+CGDCONT:') !== 0) return;
							var match = line.match(/\+CGDCONT: (\d+),"([^"]*)","([^"]*)",([^,]*),?(\d*),?(\d*)/);
							if (match) list.push({ cid: Number(match[1]), type: match[2], apn: match[3], pdp_addr: match[4] || '' });
						});
					}
					var actives = {};
					if (resp2.data) {
						String(resp2.data).split('\n').forEach(function (line) {
							var match = line.match(/\+CGACT: (\d+),(\d+)/);
							if (match) actives[Number(match[1])] = match[2] === '1';
						});
					}
					list.forEach(function (ctx) { ctx.active = !!actives[ctx.cid]; });
					pdpList = list.filter(function (ctx) { return ctx.cid !== 0 && ctx.cid < 21; });
					renderPDP();
				});
			}).catch(function () { Ui.error('获取PDP上下文失败'); });
		}

		function renderPDP() {
			pdpTable.innerHTML = '';
			var head = E('thead');
			var hr = E('tr');
			['CID', '协议类型', 'APN', '状态', '操作'].forEach(function (h) { hr.appendChild(E('th', {}, h)); });
			head.appendChild(hr);
			pdpTable.appendChild(head);
			var tb = E('tbody');
			if (!pdpList.length) {
				var tr0 = E('tr');
				tr0.appendChild(E('td', { 'colspan': '5', 'class': 'at-empty' }, '暂无 PDP 上下文'));
				tb.appendChild(tr0);
			} else {
				for (var i = 0; i < pdpList.length; i++) {
					var ctx = pdpList[i];
					var tr = E('tr');
					tr.appendChild(E('td', {}, String(ctx.cid)));
					tr.appendChild(E('td', {}, getPdpTypeText(ctx.type)));
					tr.appendChild(E('td', {}, ctx.apn || '-'));
					var tdStatus = E('td');
					tdStatus.appendChild(Ui.tag(ctx.active ? '已激活' : '未激活', ctx.active ? 'green' : 'grey'));
					tr.appendChild(tdStatus);
					var tdOp = E('td', { 'class': 'at-op-cell' });
					var editBtn = Ui.button('编辑', 'cbi-button-action', function (c) { return function () { openEdit(c); }; }(ctx));
					var delBtn = Ui.button('删除', 'cbi-button-negative', function (c) { return function () {
						Ui.confirm('确定删除 CID ' + c.cid + ' 的 PDP 上下文？', function () { handleDeletePdp(c.cid); });
					}; }(ctx));
					var actBtn = Ui.button(ctx.active ? '去激活' : '激活', 'cbi-button-action', function (c) { return function () { handleActivePdp(c.cid, !c.active); }; }(ctx));
					tdOp.appendChild(editBtn);
					tdOp.appendChild(delBtn);
					tdOp.appendChild(actBtn);
					tr.appendChild(tdOp);
					tb.appendChild(tr);
				}
			}
			pdpTable.appendChild(tb);
		}

		function openEdit(data) {
			var isNew = !data;
			var edit = data ? { cid: data.cid, type: data.type, apn: data.apn || '', pdp_addr: data.pdp_addr || '' } : { cid: 1, type: 'IPV4V6', apn: '', pdp_addr: '' };
			Ui.promptModal(isNew ? '新增 PDP 上下文' : '编辑 PDP 上下文（CID ' + data.cid + '）', [
				{ key: 'cid', label: 'CID', value: edit.cid },
				{
					key: 'type', label: '协议类型', type: 'select', value: edit.type,
					options: PDP_TYPE_OPTIONS
				},
				{ key: 'apn', label: 'APN', value: edit.apn, placeholder: '请输入 APN' },
				{ key: 'pdp_addr', label: 'PDP 地址', value: edit.pdp_addr, placeholder: '可留空' }
			], function (values) {
				var cid = Number(values.cid);
				if (!cid || !values.type) { Ui.error('请填写 CID 和协议类型'); return; }
				if (isNew && pdpList.some(function (ctx) { return ctx.cid === cid; })) { Ui.error('CID 已存在，请选择其他 CID'); return; }
				var cmd = 'AT+CGDCONT=' + cid + ',"' + values.type + '","' + (values.apn || '') + '",' + (values.pdp_addr || '') + ',0,0';
				Ui.sendCmd(cmd).then(function (res) {
					if (res.success) { Ui.success('保存成功'); return fetchPDPContexts(); }
					Ui.error('保存失败');
				}).catch(function () { Ui.error('保存失败，请重试'); });
			});
		}

		function handleDeletePdp(cid) {
			Ui.sendCmd('AT+CGDCONT=' + cid).then(function (res) {
				if (res.success) { Ui.success('删除成功'); return fetchPDPContexts(); }
				Ui.error('删除失败');
			}).catch(function () { Ui.error('删除失败，请重试'); });
		}

		function handleActivePdp(cid, active) {
			Ui.sendCmd('AT+CGACT=' + (active ? 1 : 0) + ',' + cid).then(function (res) {
				if (res.success) {
					Ui.success(active ? '激活成功' : '去激活成功');
					return Ui.sleep(2000).then(fetchPDPContexts);
				}
				Ui.error('操作失败');
			}).catch(function () { Ui.error('操作失败，请重试'); });
		}

		/* ---------- 自动拨号开关 ---------- */
		var dialSwitch = document.createElement('input');
		dialSwitch.type = 'checkbox';
		dialSwitch.className = 'cbi-input-checkbox';
		dialSwitch.addEventListener('change', function () { handleAutoDialChange(dialSwitch.checked); });
		var swRow = Ui.field('自动拨号', dialSwitch, '开启后设备将自动保持网络连接');
		dialPanel._body.insertBefore(swRow, dialPanel._body.firstChild);

		/* ---------- 初始化 ---------- */
		function loadAll() {
			return fetchDialSettings().then(fetchUSBMode).then(fetchInfcfg).then(fetchPDPContexts);
		}

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
