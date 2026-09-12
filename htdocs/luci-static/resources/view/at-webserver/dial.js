'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 拨号设置 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/Dial.tsx：
 * 自动拨号开关、APN 设置、拨号方式、USB 端口模式、网口模式、后路由、DMZ、
 * PDP 上下文管理（新增 / 编辑 / 删除 / 激活）。
 *
 * 状态刷新要点（本次修复重点）：
 * - 进入页面即串行拉取拨号配置 / USB 模式 / 网口模式 / PDP 列表
 * - 每次写操作后重新拉取并回填表单，避免界面残留旧值
 * - 自动拨号期望值同步到 UCI，供后端在重连模组后对齐
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('拨号设置', '自动拨号、APN、模式配置与 PDP 上下文');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/*
		 * 未保存更改暂存器（OpenWrt 保存并应用语义）：
		 * 所有配置修改先暂存，由底部悬浮条统一「保存并应用 / 撤销更改」，
		 * 应用或撤销后重新拉取全部配置刷新界面。
		 */
		var staged = Mt5700.staged({ onChanged: function () { loadAll(); } });

		function stageHint() {
			Mt5700.info('更改已暂存，点击页面下方「保存并应用」后生效');
		}

		/* ---------- 常量 ---------- */
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

		function getDialModeText(mode) {
			if (mode == null) return '未识别';
			var map = { 1: 'USB网络接口', 2: '转网口模式' };
			return map[mode] || '未知';
		}
		function getUSBModeText(mode) {
			var map = {
				0: 'Linux-ECM正常模式', 1: 'Windows-NCM正常模式', 2: 'Linux-ECM调试模式',
				3: 'Windows-NCM调试模式', 4: 'Linux-NCM正常模式', 5: 'Linux-NCM调试模式',
				6: 'Windows-RNDIS单端口模式', 7: 'Windows-MBIM单端口模式(暂不支持)', 8: 'Windows/Linux-PPP端口模式'
			};
			return map[mode] || '未知模式';
		}
		function getInfcfgModeText(mode) {
			if (mode === 1) return 'USB Stick + 网口 E5 数传模式';
			if (mode === 2) return 'USB E5 + 网口 E5 数传模式';
			if (mode === 3) return '网口直通模式';
			return '未配置';
		}
		function getAuthTypeText(type) {
			if (type === 0) return '无鉴权';
			if (type === 1) return 'PAP鉴权';
			if (type === 2) return 'CHAP鉴权';
			return '未知';
		}
		function getPdpTypeText(type) {
			if (type === 'IP') return 'IPv4';
			if (type === 'IPV6') return 'IPv6';
			if (type === 'IPV4V6') return 'IPv4/IPv6';
			return type;
		}

		/* ---------- 状态 ---------- */
		var settings = { enable: 0, protocol: '', apn: '', username: '', password: '', authType: 0 };
		var apnForm = { apn: '', username: '', password: '', authType: 0 };
		var dmzConfig = { enabled: false, host: '' };
		var pdpList = [];

		/* ---------- 解析 ---------- */
		function parseAutoDialResponse(raw) {
			var line = raw.replace(/\r/g, '').split('\n').map(function (i) { return i.trim(); })
				.filter(function (i) { return i.indexOf('^SETAUTODIAL:') === 0; })[0];
			if (!line) return null;
			var payload = line.slice(line.indexOf(':') + 1).trim();
			var fields = (payload.match(/(?:[^,"]+|"[^"]*")+/g) || []).map(function (f) {
				return f.trim().replace(/^"|"$/g, '');
			});
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

		function ndisIsActive(raw) {
			return /\^NDISSTATQRY:\s*1\s*,/i.test(String(raw).replace(/\r/g, ''));
		}

		function parseTDCFG(raw) {
			var modeMatch = String(raw).match(/Mode\s*:\s*(\d+)/);
			var postRouteMatch = String(raw).match(/PostRoute\s*:\s*(\d+)/);
			var dmzLine = String(raw).replace(/\r/g, '').split('\n')
				.filter(function (l) { return l.trim().indexOf('Dmz:') === 0; })[0];
			var dmzValue = dmzLine ? dmzLine.split(':')[1].trim() : 'not cfg';
			return {
				mode: modeMatch ? parseInt(modeMatch[1], 10) : undefined,
				postRoute: postRouteMatch ? parseInt(postRouteMatch[1], 10) : undefined,
				dmz: { enabled: dmzValue !== 'not cfg', host: dmzValue !== 'not cfg' ? dmzValue : '' }
			};
		}

		/* ---------- 卡片：自动拨号 + APN ---------- */
		var dialCard = Mt5700.card('自动拨号与 APN', '开启后设备自动保持网络连接，建议保持开启');
		body.appendChild(dialCard);

		var dialStatus = E('div', { 'class': 'mt5700-inline' });
		dialCard._body.appendChild(dialStatus);

		var dialBody = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		dialCard._body.appendChild(dialBody);

		var dialSwitch = document.createElement('input');
		dialSwitch.type = 'checkbox';
		dialSwitch.className = 'cbi-input-checkbox';
		dialSwitch.addEventListener('change', function () { handleAutoDialChange(dialSwitch.checked); });
		dialBody.appendChild(Mt5700.formGroup('自动拨号', dialSwitch, '开启后设备将自动保持网络连接'));

		var apnInput = Mt5700.input('text', '请输入 APN');
		apnInput.maxLength = 99;
		apnInput.addEventListener('input', function () { apnForm.apn = apnInput.value; });

		var userInput = Mt5700.input('text', '请输入用户名（可选）');
		userInput.maxLength = 31;
		userInput.addEventListener('input', function () { apnForm.username = userInput.value; });

		var passInput = Mt5700.input('password', '请输入密码（可选）');
		passInput.maxLength = 31;
		passInput.addEventListener('input', function () { apnForm.password = passInput.value; });

		var authSel = Mt5700.select(AUTH_OPTIONS.map(function (o) {
			return { value: String(o.value), label: o.label };
		}), '0');
		authSel.addEventListener('change', function () { apnForm.authType = parseInt(authSel.value, 10); });

		dialBody.appendChild(Mt5700.formGroup('APN', apnInput));
		dialBody.appendChild(Mt5700.formGroup('用户名', userInput));
		dialBody.appendChild(Mt5700.formGroup('密码', passInput));
		dialBody.appendChild(Mt5700.formGroup('认证方式', authSel));

		var authCurrent = E('span', { 'class': 'mt5700-hint' }, '当前认证：无鉴权');
		dialCard._body.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('暂存 APN 更改', function () { handleApnSettingChange(); }),
			authCurrent
		));

		/* ---------- 卡片：模式配置 ---------- */
		var modeCard = Mt5700.card('模式配置', '拨号方式与 USB 端口模式');
		var modeBody = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		modeCard._body.appendChild(modeBody);
		body.appendChild(modeCard);

		var dialModeSel = Mt5700.select(DIAL_MODE_OPTIONS.map(function (o) {
			return { value: String(o.value), label: o.label };
		}), '1');
		dialModeSel.addEventListener('change', function () { handleDialModeChange(parseInt(dialModeSel.value, 10)); });

		var usbSel = Mt5700.select(USB_MODE_OPTIONS.map(function (o) {
			return { value: String(o.value), label: o.label };
		}), '0');
		usbSel.addEventListener('change', function () { handleUSBModeChange(parseInt(usbSel.value, 10)); });

		modeBody.appendChild(Mt5700.formGroup('拨号方式', dialModeSel));
		modeBody.appendChild(Mt5700.formGroup('USB 端口模式', usbSel));
		var usbCurrent = E('div', { 'class': 'mt5700-hint' }, '当前 USB 模式：未知');
		modeCard._body.appendChild(usbCurrent);

		/* ---------- 卡片：网口模式 + 后路由 + DMZ ---------- */
		var infCard = Mt5700.card('网口模式与 DMZ', '网口数传模式、后路由与 DMZ 主机');
		var infBody = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		infCard._body.appendChild(infBody);
		body.appendChild(infCard);

		var infcfgSel = Mt5700.select(INCFG_MODE_OPTIONS.map(function (o) {
			return { value: String(o.value), label: o.label };
		}), '1');
		infcfgSel.addEventListener('change', function () { handleInfcfgModeChange(parseInt(infcfgSel.value, 10)); });

		var postRouteSel = Mt5700.select([
			{ label: '关闭后路由', value: '0' }, { label: '开启后路由', value: '1' }
		], '0');
		postRouteSel.addEventListener('change', function () { handlePostRouteChange(parseInt(postRouteSel.value, 10)); });

		var dmzInput = Mt5700.input('text', '如 192.168.1.100');

		infBody.appendChild(Mt5700.formGroup('网口模式', infcfgSel));
		infBody.appendChild(Mt5700.formGroup('后路由', postRouteSel));
		infBody.appendChild(Mt5700.formGroup('DMZ 主机', dmzInput, '设置 DMZ 时必填'));

		var dmzStatus = E('div', { 'class': 'mt5700-hint' }, 'DMZ 状态：未配置');
		infCard._body.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('设置 DMZ', function () {
				if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(dmzInput.value.trim())) { Mt5700.error('请输入有效的 IP 地址'); return; }
				handleDMZ('enable', dmzInput.value.trim());
			}),
			Mt5700.dangerButton('关闭 DMZ', function () {
				handleDMZ('disable');
			})
		));
		infCard._body.appendChild(dmzStatus);

		/* ---------- 卡片：PDP 上下文 ---------- */
		var pdpCard = Mt5700.card('PDP 上下文', 'CGDCONT 列表：新增、编辑、删除、激活 / 去激活');
		body.appendChild(pdpCard);

		pdpCard._body.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('+ 新增', function () { openEdit(null); }),
			Mt5700.ghostButton('刷新', function () { fetchPDPContexts(); })
		));
		var pdpBody = E('div');
		pdpCard._body.appendChild(pdpBody);

		/* ---------- 渲染 ---------- */
		function renderDialStatus() {
			dialStatus.innerHTML = '';
			dialStatus.appendChild(Mt5700.badge(settings.enable === 1 ? '已开启' : '已关闭',
				settings.enable === 1 ? 'success' : 'warning'));
			dialStatus.appendChild(Mt5700.badge('拨号方式：' + getDialModeText(settings.dialMode), 'info'));
			dialStatus.appendChild(Mt5700.badge('协议：' + (settings.protocol || '-'), 'neutral'));
			authCurrent.textContent = '当前认证：' + getAuthTypeText(settings.authType);

			apnInput.value = apnForm.apn || '';
			userInput.value = apnForm.username || '';
			passInput.value = apnForm.password || '';
			authSel.value = String(apnForm.authType || 0);
			dialModeSel.value = String(settings.dialMode != null ? settings.dialMode : '');
			if (settings.usbMode != null) {
				usbSel.value = String(settings.usbMode);
				usbCurrent.textContent = '当前 USB 模式：' + getUSBModeText(settings.usbMode);
			}
			infcfgSel.value = String(settings.infcfgMode != null ? settings.infcfgMode : '');
			postRouteSel.value = String(settings.postRoute != null ? settings.postRoute : '');
			dmzStatus.textContent = 'DMZ 状态：' + (dmzConfig.enabled ? '已开启 → ' + dmzConfig.host : '未配置');
		}

		function renderPDP() {
			pdpBody.innerHTML = '';
			if (!pdpList.length) {
				pdpBody.appendChild(Mt5700.empty('暂无 PDP 上下文'));
				return;
			}
			var rows = pdpList.map(function (ctx) {
				var opWrap = E('div', { 'class': 'mt5700-inline' });
				opWrap.appendChild(Mt5700.button('编辑', function () { openEdit(ctx); }, 'secondary'));
				opWrap.appendChild(Mt5700.dangerButton('删除', function () {
					Mt5700.confirm('确定删除 CID ' + ctx.cid + ' 的 PDP 上下文？', function () {
						handleDeletePdp(ctx.cid);
					}, '确认删除');
				}));
				opWrap.appendChild(Mt5700.button(ctx.active ? '去激活' : '激活', function () {
					handleActivePdp(ctx.cid, !ctx.active);
				}, 'secondary'));
				return [
					String(ctx.cid),
					getPdpTypeText(ctx.type),
					ctx.apn || '-',
					Mt5700.badge(ctx.active ? '已激活' : '未激活', ctx.active ? 'success' : 'neutral'),
					opWrap
				];
			});
			pdpBody.appendChild(Mt5700.table(['CID', '协议类型', 'APN', '状态', '操作'], rows, { striped: true }));
		}

		/* ---------- 动作 ---------- */
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
					dialSwitch.checked = parsed.enable === 1;
					syncAutodialDefault(parsed.enable === 1, parsed.dialMode);
				}
				renderDialStatus();
			}).catch(function () { Mt5700.error('获取拨号配置失败'); });
		}

		// 把自动拨号期望状态写入 UCI，供后端在每次连上模组后对齐
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
			AtWs.uci.uciCommit('at-webserver').catch(function () { /* 不阻断页面 */ });
		}

		function handleAutoDialChange(checked) {
			/* 暂存而非立即下发，应用时才发送 AT 命令 */
			staged.set('autodial', '自动拨号：' + (checked ? '开启' : '关闭'), function () {
				var cmd = checked ? 'AT^SETAUTODIAL=1,' + (settings.dialMode || 1) : 'AT^SETAUTODIAL=0';
				return Ui.sendCmd(cmd).then(function (res) {
					if (!res.success) throw new Error('设置自动拨号失败');
					settings.enable = checked ? 1 : 0;
				});
			});
			stageHint();
		}

		function handleApnSettingChange() {
			staged.set('apn', 'APN 设置更新', function () {
				var cmd = 'AT^SETAUTODIAL=' + settings.enable + ',' + settings.dialMode + ',"' + settings.protocol + '","' +
					apnForm.apn + '","' + apnForm.username + '","' + apnForm.password + '",' + apnForm.authType;
				return Ui.sendCmd(cmd).then(function (res) {
					if (!res.success) throw new Error('APN 设置失败');
					settings.apn = apnForm.apn; settings.username = apnForm.username;
					settings.password = apnForm.password; settings.authType = apnForm.authType;
				});
			});
			stageHint();
		}

		function handleDialModeChange(mode) {
			if (settings.enable === 1) { Mt5700.warning('请先关闭自动拨号后再修改拨号方式'); renderDialStatus(); return; }
			staged.set('dialmode', '拨号方式：' + getDialModeText(mode), function () {
				return Ui.sendCmd('AT^SETAUTODIAL=1,' + mode).then(function (res) {
					if (!res.success) throw new Error('拨号方式设置失败');
					settings.dialMode = mode; settings.enable = 1;
				});
			});
			stageHint();
		}

		function handleUSBModeChange(mode) {
			staged.set('usbmode', 'USB 端口模式：' + getUSBModeText(mode), function () {
				return Ui.sendCmd('AT^SETMODE=' + mode).then(function (res) {
					if (!res.success) throw new Error('USB 端口模式设置失败');
					settings.usbMode = mode;
				});
			});
			Mt5700.info('已暂存。应用后设备将自动重启以生效');
		}

		function fetchUSBMode() {
			return Ui.sendCmd('AT^SETMODE?').then(function (res) {
				if (res.success && res.data) {
					var mode = parseInt(String(res.data).trim(), 10);
					if (!isNaN(mode)) { settings.usbMode = mode; renderDialStatus(); }
				}
			}).catch(function () { Mt5700.error('获取USB模式失败'); });
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
			}).catch(function () { Mt5700.error('获取网口模式配置失败'); });
		}

		function handleInfcfgModeChange(mode) {
			staged.set('infcfg', '网口模式：' + getInfcfgModeText(mode), function () {
				return Ui.sendCmd('AT^TDCFG="infcfg","mode",' + mode).then(function (res) {
					if (!res.success) throw new Error('网口模式设置失败');
					settings.infcfgMode = mode;
				});
			});
			Mt5700.info('已暂存。应用后设备需重启生效');
		}

		function handlePostRouteChange(value) {
			staged.set('postroute', value === 1 ? '后路由：开启' : '后路由：关闭', function () {
				if (value === 1) {
					return Ui.sendCmd('AT^IPFILTERSWITCH=0').then(function (ipFilter) {
						if (!ipFilter.success) throw new Error('关闭IP过滤失败');
						return Ui.sendCmd('AT^TDCFG="infcfg","PostRoute",' + value);
					}).then(function (res) {
						if (!res.success) throw new Error('设置后路由失败');
						settings.postRoute = value;
					});
				}
				return Ui.sendCmd('AT^TDCFG="infcfg","PostRoute",0').then(function (res) {
					if (!res.success) throw new Error('设置后路由失败');
					settings.postRoute = 0;
				});
			});
			stageHint();
		}

		function handleDMZ(action, ip) {
			staged.set('dmz', action === 'enable' ? 'DMZ 主机：' + ip : '关闭 DMZ', function () {
				var cmd = action === 'enable' ? 'AT^TDCFG="infcfg","dmz","' + ip + '"' : 'AT^TDCFG="infcfg","dmz","0"';
				return Ui.sendCmd(cmd).then(function (res) {
					if (!res.success) throw new Error(action === 'enable' ? 'DMZ配置失败' : '关闭DMZ失败');
					if (action === 'enable') {
						dmzConfig = { enabled: true, host: ip };
					} else {
						dmzConfig = { enabled: false, host: '' };
					}
				});
			});
			stageHint();
		}

		/* ---------- PDP 上下文 ---------- */
		function fetchPDPContexts() {
			return Ui.sendCmd('AT+CGDCONT?').then(function (resp1) {
				return Ui.sendCmd('AT+CGACT?').then(function (resp2) {
					var list = [];
					if (resp1.data) {
						String(resp1.data).replace(/\r/g, '').split('\n').forEach(function (line) {
							if (line.indexOf('+CGDCONT:') !== 0) return;
							var match = line.match(/\+CGDCONT: (\d+),"([^"]*)","([^"]*)",([^,]*),?(\d*),?(\d*)/);
							if (match) list.push({ cid: Number(match[1]), type: match[2], apn: match[3], pdp_addr: match[4] || '' });
						});
					}
					var actives = {};
					if (resp2.data) {
						String(resp2.data).replace(/\r/g, '').split('\n').forEach(function (line) {
							var match = line.match(/\+CGACT: (\d+),(\d+)/);
							if (match) actives[Number(match[1])] = match[2] === '1';
						});
					}
					list.forEach(function (ctx) { ctx.active = !!actives[ctx.cid]; });
					pdpList = list.filter(function (ctx) { return ctx.cid !== 0 && ctx.cid < 21; });
					renderPDP();
				});
			}).catch(function () { Mt5700.error('获取PDP上下文失败'); });
		}

		function openEdit(data) {
			var isNew = !data;
			var edit = data
				? { cid: data.cid, type: data.type, apn: data.apn || '', pdp_addr: data.pdp_addr || '' }
				: { cid: 1, type: 'IPV4V6', apn: '', pdp_addr: '' };
			Ui.promptModal(isNew ? '新增 PDP 上下文' : '编辑 PDP 上下文（CID ' + data.cid + '）', [
				{ key: 'cid', label: 'CID', value: edit.cid },
				{ key: 'type', label: '协议类型', type: 'select', value: edit.type, options: PDP_TYPE_OPTIONS },
				{ key: 'apn', label: 'APN', value: edit.apn, placeholder: '请输入 APN' },
				{ key: 'pdp_addr', label: 'PDP 地址', value: edit.pdp_addr, placeholder: '可留空' }
			], function (values) {
				var cid = Number(values.cid);
				if (!cid || !values.type) { Mt5700.error('请填写 CID 和协议类型'); return; }
				if (isNew && pdpList.some(function (ctx) { return ctx.cid === cid; })) {
					Mt5700.error('CID 已存在，请选择其他 CID');
					return;
				}
				var cmd = 'AT+CGDCONT=' + cid + ',"' + values.type + '","' + (values.apn || '') + '",' +
					(values.pdp_addr || '') + ',0,0';
				staged.set('pdp-' + cid, 'PDP 上下文 CID ' + cid, function () {
					return Ui.sendCmd(cmd).then(function (res) {
						if (!res.success) throw new Error('PDP 上下文保存失败');
					});
				});
				stageHint();
			});
		}

		function handleDeletePdp(cid) {
			staged.set('pdp-del-' + cid, '删除 PDP 上下文 CID ' + cid, function () {
				return Ui.sendCmd('AT+CGDCONT=' + cid).then(function (res) {
					if (!res.success) throw new Error('PDP 上下文删除失败');
				});
			});
			stageHint();
		}

		function handleActivePdp(cid, active) {
			staged.set('pdp-act-' + cid, (active ? '激活' : '去激活') + ' PDP CID ' + cid, function () {
				return Ui.sendCmd('AT+CGACT=' + (active ? 1 : 0) + ',' + cid).then(function (res) {
					if (!res.success) throw new Error('PDP 激活状态切换失败');
				});
			});
			stageHint();
		}

		/* ---------- 初始化 ---------- */
		renderDialStatus();
		renderPDP();

		function loadAll() {
			return fetchDialSettings().then(fetchUSBMode).then(fetchInfcfg).then(fetchPDPContexts);
		}

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						AtWs.client.connect(values.key).catch(function (e) {
							Mt5700.error((e && e.message) || '认证失败');
						});
					}
				});
				return;
			}
			if (err) console.warn(err);
		}).then(function () {
			loadAll();
		});

		/* 暂存应用条固定在页面底部 */
		body.appendChild(staged.el);

		return page;
	}
});
