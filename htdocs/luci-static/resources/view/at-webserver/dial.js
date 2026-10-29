'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 拨号设置页面：
 * 自动拨号开关、APN 设置、拨号方式、USB 端口模式、网口模式、后路由、DMZ、
 * PDP 上下文管理（新增 / 编辑 / 删除 / 激活）。
 *
 * 状态刷新要点：
 * - 进入页面即串行拉取拨号配置 / USB 模式 / 网口模式 / PDP 列表
 * - 每次写操作后重新拉取并回填表单，避免界面残留旧值
 * - 自动拨号期望值同步到 UCI，供后端在重连模组后对齐
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('拨号设置', '自动拨号、APN 接入点、USB/网口工作模式与 PDP 上下文配置', 'dial', '数据链路 · APN 拨号');
		var body = page._body;

		/* 注入本页局部美化样式 */
		var dialStyle = E('style', {}, [
			'/* 拨号顶栏指标概览 */',
			'.mt-dial-overview { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 16px; background: rgba(139, 92, 246, 0.05); border: 1px solid rgba(139, 92, 246, 0.15); border-radius: 12px; margin-bottom: 16px; }',
			'.mt-dial-item { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; }',
			'.mt-dial-label { color: var(--mt5700-text-secondary); font-size: 12px; }',
			'/* 常用 APN 预设胶囊（按「公众卡 / 物联网卡」分组） */',
			'.mt-apn-presets { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; }',
			'.mt-apn-preset-title { font-size: 11px; color: var(--mt5700-text-secondary); }',
			'.mt-apn-preset-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
			'.mt-apn-preset-group { flex: 0 0 auto; min-width: 54px; font-size: 11px; color: var(--mt5700-text-secondary); }',
			'.mt-apn-chip { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: rgba(14, 165, 233, 0.08); border: 1px solid rgba(14, 165, 233, 0.25); color: var(--mt5700-cyan); cursor: pointer; transition: all 0.2s ease; user-select: none; white-space: nowrap; }',
			'.mt-apn-chip:hover { background: rgba(14, 165, 233, 0.18); border-color: var(--mt5700-cyan); transform: translateY(-1px); }',
			'.mt-apn-chip:active { transform: translateY(0); }',
			'/* 需用户名/密码鉴权的预设（电信物联网卡）用琥珀色区分 */',
			'.mt-apn-chip-auth { background: rgba(245, 158, 11, 0.10); border-color: rgba(245, 158, 11, 0.38); color: var(--mt5700-amber); }',
			'.mt-apn-chip-auth:hover { background: rgba(245, 158, 11, 0.20); border-color: var(--mt5700-amber); }',
			'/* 开关行美化 */',
			'.mt-switch-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: rgba(125, 125, 125, 0.03); border: 1px solid var(--mt5700-border); border-radius: 10px; margin-bottom: 14px; }',
			'.mt-switch-info { display: flex; flex-direction: column; gap: 3px; }',
			'.mt-switch-title { font-size: 13.5px; font-weight: 600; color: var(--mt5700-text); }',
			'.mt-switch-desc { font-size: 12px; color: var(--mt5700-text-secondary); }',
			'/* 提示条美化 */',
			'.mt-pdp-note { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 10px; background: linear-gradient(135deg, rgba(56, 189, 248, 0.08), rgba(139, 92, 246, 0.05)); border: 1px solid rgba(56, 189, 248, 0.25); font-size: 12.5px; line-height: 1.6; color: var(--mt5700-text); margin-bottom: 16px; }',
			'.mt-pdp-note-icon { font-size: 16px; flex-shrink: 0; line-height: 1.2; }',
			'/* PDP 卡片网格与视图优化 */',
			'.mt-pdp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }',
			'.mt-pdp-card { display: flex; flex-direction: column; justify-content: space-between; padding: 14px 16px; border-radius: 12px; background: rgba(125, 125, 125, 0.03); border: 1px solid var(--mt5700-border); transition: all 0.2s ease; }',
			'.mt-pdp-card:hover { transform: translateY(-2px); border-color: rgba(139, 92, 246, 0.35); box-shadow: 0 4px 12px rgba(139, 92, 246, 0.08); }',
			'.mt-pdp-card.is-active { border-color: rgba(16, 185, 129, 0.35); background: linear-gradient(135deg, rgba(16, 185, 129, 0.04), rgba(125, 125, 125, 0.02)); }',
			'.mt-pdp-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }',
			'.mt-pdp-card-tags { display: flex; align-items: center; gap: 6px; }',
			'.mt-pdp-cid { font-size: 13px; font-weight: 700; font-family: var(--mt5700-font-mono); color: #7c3aed; background: rgba(139, 92, 246, 0.1); padding: 2px 8px; border-radius: 6px; }',
			'.mt-pdp-card-body { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }',
			'.mt-pdp-field { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; }',
			'.mt-pdp-field-k { color: var(--mt5700-text-secondary); }',
			'.mt-pdp-field-v { font-weight: 600; color: var(--mt5700-text); }',
			'.mt-pdp-card-actions { display: flex; gap: 6px; padding-top: 10px; border-top: 1px dashed var(--mt5700-divider); }',
			'.mt-pdp-card-actions .mt5700-btn { flex: 1; padding: 6px 4px; font-size: 12px; justify-content: center; text-align: center; }',
			'.mt-pdp-card-add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 24px 16px; border-radius: 12px; border: 2px dashed rgba(139, 92, 246, 0.3); background: rgba(139, 92, 246, 0.02); cursor: pointer; transition: all 0.2s ease; min-height: 130px; }',
			'.mt-pdp-card-add:hover { border-color: #8b5cf6; background: rgba(139, 92, 246, 0.07); transform: translateY(-2px); }',
			'/* 紧凑表格视图约束 */',
			'.mt-pdp-table-wrap { max-width: 960px; margin: 0 auto; }',
			'/* 手机端：PDP 网格单列全宽、操作按钮换行、表格视图横向滑动查看 */',
			'@media (max-width: 640px) {',
			'  .mt-pdp-grid { grid-template-columns: 1fr !important; }',
			'  .mt-pdp-note { padding: 10px 12px; }',
			'  .mt-pdp-card { padding: 12px 14px; }',
			'  .mt-pdp-card-actions { flex-wrap: wrap; }',
			'  .mt-pdp-card-actions .mt5700-btn { flex: 1 1 44%; min-width: 96px; }',
			'  .mt-pdp-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: none; }',
			'  .mt-pdp-table-wrap .mt5700-table { min-width: 620px; }',
			'  .mt-pdp-table-wrap .mt5700-table th:nth-child(5), .mt-pdp-table-wrap .mt5700-table td:nth-child(5) { width: auto; }',
			'}',
			'.mt-pdp-table-wrap .mt5700-table th:nth-child(1), .mt-pdp-table-wrap .mt5700-table td:nth-child(1) { width: 70px; text-align: center; }',
			'.mt-pdp-table-wrap .mt5700-table th:nth-child(2), .mt-pdp-table-wrap .mt5700-table td:nth-child(2) { width: 120px; }',
			'.mt-pdp-table-wrap .mt5700-table th:nth-child(4), .mt-pdp-table-wrap .mt5700-table td:nth-child(4) { width: 90px; text-align: center; }',
			'.mt-pdp-table-wrap .mt5700-table th:nth-child(5), .mt-pdp-table-wrap .mt5700-table td:nth-child(5) { width: 190px; text-align: right; }',
			'/* 底部暂存条适配 */',
			'.mt5700-applybar { z-index: 100; }'
		].join('\n'));
		body.appendChild(dialStyle);

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
		/*
		 * 手册 11.8.3 的 <mode>：0~6、8 各有定义，7=Windows MBIM 明确标注「暂不支持」，
		 * 因此不提供该选项；读取到 7 时按下表的原文案显示，便于识别异常配置。
		 */
		var USB_MODE_OPTIONS = [
			{ label: 'Linux-ECM正常模式', value: 0 }, { label: 'Windows-NCM正常模式', value: 1 },
			{ label: 'Linux-ECM调试模式', value: 2 }, { label: 'Windows-NCM调试模式', value: 3 },
			{ label: 'Linux-NCM正常模式', value: 4 }, { label: 'Linux-NCM调试模式', value: 5 },
			{ label: 'Windows-RNDIS单端口模式', value: 6 }, { label: 'Windows/Linux-PPP端口模式', value: 8 }
		];
		/*
		 * 手册 16.23.3 的 <mode_value> 只有两档：
		 *   1 = USB Stick + 网口 E5 数传模式（缺省）
		 *   2 = USB E5 + 网口 E5 数传模式
		 * 早先这里多出一个「网口直通模式 (需执行拨号命令)」=3，全册没有出处，
		 * 下发 `AT^TDCFG="infcfg","mode",3` 只会被模组拒绝，删掉。
		 */
		var INCFG_MODE_OPTIONS = [
			{ label: 'USB Stick + 网口 E5 数传模式', value: 1 },
			{ label: 'USB E5 + 网口 E5 数传模式', value: 2 }
		];
		var AUTH_OPTIONS = [
			{ label: '无认证', value: 0 }, { label: 'PAP 认证', value: 1 }, { label: 'CHAP 认证', value: 2 }
		];
		var PDP_TYPE_OPTIONS = [
			{ label: 'IPv4', value: 'IP' }, { label: 'IPv6', value: 'IPV6' }, { label: 'IPv4/IPv6', value: 'IPV4V6' }
		];

		/*
		 * 常用运营商 APN 预设（按国内四大运营商的公众卡 / 物联网卡实际接入点整理）
		 *
		 *   中国移动  公众 cmnet ｜ 物联网 cmiot（4G 通用）、cmiot5g（5G 物联）
		 *   中国联通  公众 3gnet ｜ 物联网 unim2m.njm2mapn（备选 unim2m.gzm2mapn）
		 *   中国电信  公众 ctnet ｜ 物联网 ctnet + 鉴权（ctnet@mycdma.cn / vnet.mobi）
		 *   中国广电  公众 cbnet（700MHz，与中国移动共建共享）
		 *
		 * 仅收录 4G/5G 仍在用的接入点：移动 cmwap、联通 3gwap/uninet、电信 ctwap 等
		 * 2G/3G 时代的 WAP 网关与旧入口已从现网退网，不作为预设（联通 3gnet 是特例——
		 * 名字带 3G，但它就是联通 4G/5G 的标准互联网入口，仍在使用）。
		 *
		 * 三点注意：
		 * - 公众卡一律无需用户名密码，点选时会一并清空这两项，避免上一次 APN 的残留凭据被误提交；
		 * - 电信物联网卡走 ctnet 时需要 PAP/CHAP 鉴权，预设已连凭据一起填入，仍需与卡商核对；
		 * - 物联网卡若由卡商分配了专属 APN（形如 CMIOT+自定义，或服务商私有值），以卡商提供的为准手填；
		 *   物联网 APN 与公众 APN 不通用——普通手机卡填 cmiot 可能被限速甚至断网。
		 */
		var APN_PRESET_GROUPS = [
			{
				group: '公众卡',
				items: [
					{ label: '移动 cmnet', name: '中国移动', apn: 'cmnet', note: '4G/5G 通用最优，个人卡与 CPE 首选' },
					{ label: '联通 3gnet', name: '中国联通', apn: '3gnet', note: '4G/5G 标准入口（名带 3G 但现网通用）；IPv6 优化通道为 wonet' },
					{ label: '电信 ctnet', name: '中国电信', apn: 'ctnet', note: '4G/5G 通用' },
					{ label: '广电 cbnet', name: '中国广电', apn: 'cbnet', note: '4G/5G，700MHz 与中国移动共建共享' }
				]
			},
			{
				group: '物联网卡',
				items: [
					{ label: '移动 cmiot', name: '中国移动物联网', apn: 'cmiot', note: '4G 物联通用' },
					{ label: '移动 cmiot5g', name: '中国移动 5G 物联网', apn: 'cmiot5g', note: '5G 物联专用' },
					{ label: '联通 unim2m.njm2mapn', name: '中国联通物联网', apn: 'unim2m.njm2mapn', note: '4G/5G 物联通用；备选 unim2m.gzm2mapn' },
					{
						label: '电信 ctnet', name: '中国电信物联网', apn: 'ctnet', authChip: true,
						username: 'ctnet@mycdma.cn', password: 'vnet.mobi', auth: 2,
						note: '需 PAP/CHAP 鉴权，已连用户名密码一并填入'
					}
				]
			}
		];

		function getDialModeText(mode) {
			if (mode == null) return '未识别';
			/* 手册 16.18.3：<dial_mode> 0=模组内部拨号 1=上位机拨号(USB 数传) 2=上位机拨号(网口数传)。
			 * 界面只提供 1/2 两档（本插件自己管理 USB 数传通道，模组内部拨号不在此列），
			 * 但模组停在 0 时必须如实读回，不能再显示「未知」。 */
			var map = { 0: '模组内部拨号', 1: 'USB网络接口', 2: '转网口模式' };
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
			/* 手册 16.23.3 <mode_value>：1/2 之外没有定义值 */
			if (mode === 1) return 'USB Stick + 网口 E5 数传模式';
			if (mode === 2) return 'USB E5 + 网口 E5 数传模式';
			return '未配置';
		}
		function getAuthTypeText(type) {
			/* 与 AUTH_OPTIONS 同源派生，避免下拉「无认证」、徽章「无鉴权」各说各话 */
			for (var i = 0; i < AUTH_OPTIONS.length; i++) {
				if (AUTH_OPTIONS[i].value === type) return AUTH_OPTIONS[i].label;
			}
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
		/*
		 * 手册 16.18.1 给出两种应答形态，必须都能处理：
		 *   ^SETAUTODIAL:<enable>,<dial_mode>,[[<protocol>],[<apn>],[<usrname>,<password>,<authtype>]]
		 *   ^SETAUTODIAL:<enable>                       ← 只有开关，方式随后由 ^NDISSTATQRY? 兜底
		 * 同一节里前一种还印作 "^SETAUTODAIL:"（DIA 与 DAI 顺序互换）——手册两处口径不一致，
		 * 因此两种拼写都接受，否则真机回这一种时整页拨号状态读不出来。
		 * 16.18.3：apn/username/password 最长 99/31/31 字符且带双引号，可为空。
		 */
		function parseAutoDialResponse(raw) {
			var line = raw.replace(/\r/g, '').split('\n').map(function (i) { return i.trim(); })
				.filter(function (i) { return /^\^SETAUTOD(?:IA|AI)L:/.test(i); })[0];
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

		/* 手册 16.4.1/16.4.5：应答形如 "^NDISSTATQRY: 1,1,,,\"IPV4\",0,,,\"IPV6\""，
		 * 结构是 <cid>,<stat>,… —— 首字段是 CID，第二字段才是连接状态（1=已连接）。
		 * 本插件的数据通道固定 CID 1，所以只认 CID 1 那一行；早先按「首字段是 1」判连接，
		 * 模组回 1,0（CID 1 已断开）时界面同样显示已连接。 */
		function ndisIsActive(raw) {
			var m = String(raw).replace(/\r/g, '').match(/\^NDISSTATQRY:\s*1\s*,\s*(\d+)/i);
			return !!m && m[1] === '1';
		}

		/* ---------- 卡片 1：自动拨号与 APN 设置 ---------- */
		var dialCard = Mt5700.card('自动拨号与 APN 配置', '管理开机自启拨号策略、运营商 APN 接入点及鉴权认证');
		body.appendChild(dialCard);

		/* 顶部链路概览条 */
		var dialOverview = E('div', { 'class': 'mt-dial-overview' });
		dialCard._body.appendChild(dialOverview);

		/* 自动拨号开关行（二次元圆润 Switch） */
		var switchRow = E('div', { 'class': 'mt-switch-row' });
		var switchInfo = E('div', { 'class': 'mt-switch-info' });
		switchInfo.appendChild(E('span', { 'class': 'mt-switch-title' }, '自动拨号 (Auto Dial)'));
		switchInfo.appendChild(E('span', { 'class': 'mt-switch-desc' }, '开启后模组自动保持网络常驻连接，断线自愈重拨；建议始终保持开启'));
		switchRow.appendChild(switchInfo);

		var dialSwitch = Ui.switch(function (checked) {
			handleAutoDialChange(checked);
		});
		var dialSwitchInput = dialSwitch.querySelector('input');
		switchRow.appendChild(dialSwitch);
		dialCard._body.appendChild(switchRow);

		/* APN 表单网格 */
		var dialGrid = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		dialCard._body.appendChild(dialGrid);

		// APN 输入与快捷填入
		var apnWrap = E('div');
		var apnInput = Mt5700.input('text', '请输入 APN (例如: cmnet)');
		apnInput.maxLength = 99;
		apnInput.addEventListener('input', function () { apnForm.apn = apnInput.value; });
		apnWrap.appendChild(apnInput);

		// 运营商预设胶囊：先渲染并收集，点击事件在下方用户名/密码/鉴权控件就绪后统一绑定
		var presetBox = E('div', { 'class': 'mt-apn-presets' });
		var presetChips = [];
		presetBox.appendChild(E('div', { 'class': 'mt-apn-preset-title' }, '运营商预设（点击快速填入）'));
		APN_PRESET_GROUPS.forEach(function (grp) {
			var row = E('div', { 'class': 'mt-apn-preset-row' });
			row.appendChild(E('span', { 'class': 'mt-apn-preset-group' }, grp.group));
			grp.items.forEach(function (preset) {
				var chip = E('span', {
					'class': preset.authChip ? 'mt-apn-chip mt-apn-chip-auth' : 'mt-apn-chip',
					title: preset.name + '\nAPN: ' + preset.apn
						+ (preset.note ? '\n' + preset.note : '')
						+ '\n点击填入'
				}, preset.label);
				row.appendChild(chip);
				presetChips.push({ el: chip, preset: preset });
			});
			presetBox.appendChild(row);
		});
		apnWrap.appendChild(presetBox);

		var authSel = Mt5700.select(AUTH_OPTIONS.map(function (o) {
			return { value: String(o.value), label: o.label };
		}), '0');
		authSel.addEventListener('change', function () { apnForm.authType = parseInt(authSel.value, 10); });

		var userInput = Mt5700.input('text', '请输入用户名（可选）');
		userInput.maxLength = 31;
		userInput.addEventListener('input', function () { apnForm.username = userInput.value; });

		var passInput = Mt5700.input('password', '请输入密码（可选）');
		passInput.maxLength = 31;
		passInput.addEventListener('input', function () { apnForm.password = passInput.value; });

		// 预设胶囊：一并同步 APN / 用户名 / 密码 / 鉴权方式。
		// 不带凭据的预设会把用户名与密码清空——否则从「电信物联网」切到「公众卡」时，
		// 上一次填入的 ctnet@mycdma.cn / vnet.mobi 会残留并被一起下发，导致拨号鉴权失败。
		presetChips.forEach(function (item) {
			item.el.addEventListener('click', function () {
				var p = item.preset;

				apnInput.value = p.apn;
				apnForm.apn = p.apn;

				userInput.value = p.username || '';
				apnForm.username = p.username || '';
				passInput.value = p.password || '';
				apnForm.password = p.password || '';

				var auth = p.auth == null ? 0 : p.auth;
				authSel.value = String(auth);
				apnForm.authType = auth;

				Mt5700.info('已填入 ' + p.name + '　APN: ' + p.apn
					+ (p.auth ? '（含鉴权凭据，请与卡商核对）' : '')
					+ '，确认后点「暂存 APN 更改」');
			});
		});

		dialGrid.appendChild(Mt5700.formGroup('APN 接入点', apnWrap, '主数据通道 APN，留空时模组将使用默认接入点'));
		dialGrid.appendChild(Mt5700.formGroup('认证方式', authSel, '运营商专网所需鉴权方式，公开互联网卡一般选「无认证」'));
		dialGrid.appendChild(Mt5700.formGroup('用户名 (可选)', userInput));
		dialGrid.appendChild(Mt5700.formGroup('密码 (可选)', passInput));

		var authCurrent = E('span', { 'class': 'mt5700-hint', style: 'margin-left:8px;' }, '当前认证：' + getAuthTypeText(0));
		dialCard._body.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('暂存 APN 更改', function () { handleApnSettingChange(); }),
			authCurrent
		));

		/* ---------- 双列网格：模式配置 + 网口与 DMZ ---------- */
		var rowMode = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowMode);

		/* 卡片 2：模式配置 */
		var modeCard = Mt5700.card('数据端口与接口模式', '拨号工作方式、USB 端口及数传模式');
		rowMode.appendChild(modeCard);

		var dialModeSel = Mt5700.select(DIAL_MODE_OPTIONS.map(function (o) {
			return { value: String(o.value), label: o.label };
		}), '1');
		dialModeSel.addEventListener('change', function () { handleDialModeChange(parseInt(dialModeSel.value, 10)); });

		var usbSel = Mt5700.select(USB_MODE_OPTIONS.map(function (o) {
			return { value: String(o.value), label: o.label };
		}), '0');
		usbSel.addEventListener('change', function () { handleUSBModeChange(parseInt(usbSel.value, 10)); });

		var infcfgSel = Mt5700.select(INCFG_MODE_OPTIONS.map(function (o) {
			return { value: String(o.value), label: o.label };
		}), '1');
		infcfgSel.addEventListener('change', function () { handleInfcfgModeChange(parseInt(infcfgSel.value, 10)); });

		var usbCurrent = E('div', { 'class': 'mt5700-hint', style: 'margin-top:6px;' }, '当前 USB 模式：未知');

		modeCard._body.appendChild(Mt5700.formGroup('拨号方式', dialModeSel, '推荐「USB网络接口」，修改前需先关闭自动拨号'));
		modeCard._body.appendChild(Mt5700.formGroup('USB 端口模式', usbSel));
		modeCard._body.appendChild(usbCurrent);
		modeCard._body.appendChild(Mt5700.formGroup('网口数传模式', infcfgSel, '修改应用后模组需重启以对齐'));

		/* 卡片 3：网口模式与 DMZ
		 * 手册 16.23.2 的三条硬约束直接决定了这里的交互：
		 *   · E5 拨号只支持 1 路 DMZ，重复配置以最后一次为准；
		 *   · DMZ 与后路由**互斥**，不能同时配置；
		 *   · 配置 DMZ/后路由要在拨号之前，删除要在断开拨号之后；
		 *   · DMZ 目的地址只支持 IPv4 协议栈（16.23.3 <dmz_str>）。
		 */
		var infCard = Mt5700.card('路由与 DMZ 高级转发', '网口后路由与 DMZ 主机（两者互斥，需在拨号前配置）');
		rowMode.appendChild(infCard);

		var postRouteSel = Mt5700.select([
			{ label: '不启用后路由', value: '0' }, { label: '开启后路由', value: '1' }
		], '0');
		postRouteSel.addEventListener('change', function () { handlePostRouteChange(parseInt(postRouteSel.value, 10)); });

		var dmzInput = Mt5700.input('text', '如 192.168.1.100');

		infCard._body.appendChild(Mt5700.formGroup('后路由模式', postRouteSel,
			'开启后模组只负责拨号，由下游路由/设备做 NAT。开启前请先断开拨号，并且不要与 DMZ 同时使用（手册 16.23.2）。开启会自动关闭模组侧 IP 过滤，随后需一次射频重启（AT+CFUN=0/1）才生效。'));
		infCard._body.appendChild(Mt5700.formGroup('DMZ 主机 IP', dmzInput,
			'把未映射端口的全部外网 IPv4 流量直通到内网这台主机；仅支持 IPv4，且 E5 只支持 1 路 DMZ。请先断开拨号再配置（手册 16.23.2/16.23.3）。'));

		var dmzStatus = E('div', { 'class': 'mt5700-hint', style: 'margin-bottom:12px;' }, 'DMZ 状态：未配置');
		infCard._body.appendChild(dmzStatus);

		infCard._body.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('设置 DMZ', function () {
				if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(dmzInput.value.trim())) { Mt5700.error('请输入有效的 IPv4 地址'); return; }
				handleDMZ('enable', dmzInput.value.trim());
			}),
			Mt5700.dangerButton('关闭 DMZ', function () {
				handleDMZ('disable');
			})
		));

		/* ---------- 卡片 4：PDP 上下文 ---------- */
		var pdpViewMode = 'card'; // 'card' | 'table'

		var viewToggleBtn = Mt5700.ghostButton('切换表格视图', function () {
			pdpViewMode = (pdpViewMode === 'card') ? 'table' : 'card';
			viewToggleBtn.textContent = (pdpViewMode === 'card') ? '切换表格视图' : '切换卡片视图';
			renderPDP();
		});

		var pdpHeaderActions = E('div', { 'class': 'mt5700-inline', style: 'gap:8px;' }, [
			viewToggleBtn,
			Mt5700.ghostButton('刷新', function () { fetchPDPContexts(); }),
			Mt5700.primaryButton('+ 新增', function () { openEdit(null); })
		]);

		var pdpCard = Mt5700.card('PDP 上下文管理', 'CGDCONT 列表：通道参数与数据激活', pdpHeaderActions);
		body.appendChild(pdpCard);

		var pdpNoteBox = E('div');
		pdpCard._body.appendChild(pdpNoteBox);

		var pdpBody = E('div');
		pdpCard._body.appendChild(pdpBody);

		/* ---------- 渲染函数 ---------- */
		function renderDialStatus() {
			dialOverview.innerHTML = '';

			// 自动拨号徽标
			dialOverview.appendChild(E('div', { 'class': 'mt-dial-item' }, [
				E('span', { 'class': 'mt-dial-label' }, '自动拨号:'),
				Mt5700.badge(settings.enable === 1 ? '已开启' : '已关闭', settings.enable === 1 ? 'success' : 'warning')
			]));

			// 方式
			dialOverview.appendChild(E('div', { 'class': 'mt-dial-item' }, [
				E('span', { 'class': 'mt-dial-label' }, '接入方式:'),
				Mt5700.badge(getDialModeText(settings.dialMode), 'info')
			]));

			// 协议
			dialOverview.appendChild(E('div', { 'class': 'mt-dial-item' }, [
				E('span', { 'class': 'mt-dial-label' }, '协议:'),
				Mt5700.badge(settings.protocol || 'IPV4V6', 'neutral')
			]));

			// 鉴权
			dialOverview.appendChild(E('div', { 'class': 'mt-dial-item' }, [
				E('span', { 'class': 'mt-dial-label' }, '认证:'),
				Mt5700.badge(getAuthTypeText(settings.authType), 'neutral')
			]));

			// DMZ 状态
			dialOverview.appendChild(E('div', { 'class': 'mt-dial-item' }, [
				E('span', { 'class': 'mt-dial-label' }, 'DMZ:'),
				Mt5700.badge(dmzConfig.enabled ? ('已开启 → ' + dmzConfig.host) : '未配置', dmzConfig.enabled ? 'success' : 'neutral')
			]));

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
			/* 手册 16.23.3 的 <pr_value> 有 0/1/2 三种，界面只有两档：
			 * 1=开启，0（未配置）与 2（关闭）都归为「不启用」。 */
			postRouteSel.value = settings.postRoute === 1 ? '1' : '0';
			dmzStatus.textContent = 'DMZ 状态：' + (dmzConfig.enabled ? '已开启 → ' + dmzConfig.host : '未配置');
			if (dmzConfig.enabled && dmzConfig.host) {
				dmzInput.value = dmzConfig.host;
			}
		}

		function renderPDP() {
			pdpNoteBox.innerHTML = '';
			if (settings.enable === 1) {
				var note = E('div', { 'class': 'mt-pdp-note' }, [
					E('span', { 'class': 'mt-pdp-note-icon' }, '💡'),
					E('div', {}, '模组自主维护提示：自动拨号已开启时，PDP 上下文由模组底层自主调度管理。为避免争用 CID 导致断网，手工「激活 / 去激活」已暂时锁定；您仍可正常新增、编辑或删除上下文配置。如需手工激活特定 CID，请先关闭自动拨号。')
				]);
				pdpNoteBox.appendChild(note);
			}

			pdpBody.innerHTML = '';
			if (!pdpList.length) {
				pdpBody.appendChild(Mt5700.empty('暂无 PDP 上下文数据'));
				return;
			}

			var autodialOn = settings.enable === 1;

			if (pdpViewMode === 'card') {
				// 卡片网格视图：自适应长宽，桌面端多列均摊、移动端紧凑对齐
				var grid = E('div', { 'class': 'mt-pdp-grid' });
				pdpList.forEach(function (ctx) {
					var item = E('div', { 'class': 'mt-pdp-card' + (ctx.active ? ' is-active' : '') });

					// 头部
					var head = E('div', { 'class': 'mt-pdp-card-head' });
					var tags = E('div', { 'class': 'mt-pdp-card-tags' });
					tags.appendChild(E('span', { 'class': 'mt-pdp-cid' }, 'CID #' + ctx.cid));
					tags.appendChild(Mt5700.badge(getPdpTypeText(ctx.type), ctx.type === 'IPV4V6' ? 'info' : 'neutral'));
					head.appendChild(tags);
					head.appendChild(Mt5700.badge(ctx.active ? '已激活' : '未激活', ctx.active ? 'success' : 'neutral'));
					item.appendChild(head);

					var cleanApn = (ctx.apn && ctx.apn.replace(/^"|"$/g, '').trim()) || '';
					var cleanAddr = (ctx.pdp_addr && ctx.pdp_addr.replace(/^"|"$/g, '').trim()) || '';

					var bodyBox = E('div', { 'class': 'mt-pdp-card-body' });
					var apnRow = E('div', { 'class': 'mt-pdp-field' });
					apnRow.appendChild(E('span', { 'class': 'mt-pdp-field-k' }, 'APN 接入点:'));
					apnRow.appendChild(E('span', { 'class': 'mt-pdp-field-v mt5700-mono' }, cleanApn || '— (默认接入点)'));
					bodyBox.appendChild(apnRow);

					var addrRow = E('div', { 'class': 'mt-pdp-field' });
					addrRow.appendChild(E('span', { 'class': 'mt-pdp-field-k' }, 'PDP 地址:'));
					addrRow.appendChild(E('span', { 'class': 'mt-pdp-field-v', style: 'font-size:12px; color:var(--mt5700-text-secondary);' }, cleanAddr || '动态分配 (留空)'));
					bodyBox.appendChild(addrRow);
					item.appendChild(bodyBox);

					// 底部操作区（三按钮均分，不挤压）
					var acts = E('div', { 'class': 'mt-pdp-card-actions' });
					acts.appendChild(Mt5700.button('编辑', function () { openEdit(ctx); }, 'secondary'));

					var actBtn = Mt5700.button(ctx.active ? '去激活' : '激活', function () {
						if (autodialOn) {
							Mt5700.warning('自动拨号开启时由模组维护 PDP，手工激活/去激活会与之冲突，请先关闭自动拨号');
							return;
						}
						handleActivePdp(ctx.cid, !ctx.active);
					}, ctx.active ? 'ghost' : 'secondary');
					if (autodialOn) {
						actBtn.disabled = true;
						actBtn.title = '自动拨号开启时由模组自主维护 PDP，禁止手工切换';
					}
					acts.appendChild(actBtn);

					acts.appendChild(Mt5700.dangerButton('删除', function () {
						Mt5700.confirm('确定删除 CID ' + ctx.cid + ' 的 PDP 上下文？', function () {
							handleDeletePdp(ctx.cid);
						}, '确认删除');
					}));
					item.appendChild(acts);

					grid.appendChild(item);
				});

				// 末尾添加 "+ 新增 PDP 上下文" 快捷卡片
				var addCard = E('div', { 'class': 'mt-pdp-card-add' });
				addCard.appendChild(E('span', { style: 'font-size:26px; line-height:1; color:#8b5cf6; font-weight:bold;' }, '+'));
				addCard.appendChild(E('span', { style: 'font-size:13.5px; font-weight:600; color:var(--mt5700-text);' }, '新增 PDP 上下文'));
				addCard.appendChild(E('span', { style: 'font-size:11.5px; color:var(--mt5700-text-secondary);' }, '配置新的 CGDCONT 数据通道'));
				addCard.addEventListener('click', function () { openEdit(null); });
				grid.appendChild(addCard);

				pdpBody.appendChild(grid);
			} else {
				// 紧凑表格视图：居中限宽 960px，固定列宽，杜绝 1400px 无效横向拉伸
				var wrap = E('div', { 'class': 'mt-pdp-table-wrap' });
				var rows = pdpList.map(function (ctx) {
					var opWrap = E('div', { 'class': 'mt5700-inline', style: 'gap:6px;' });
					opWrap.appendChild(Mt5700.button('编辑', function () { openEdit(ctx); }, 'secondary'));
					opWrap.appendChild(Mt5700.dangerButton('删除', function () {
						Mt5700.confirm('确定删除 CID ' + ctx.cid + ' 的 PDP 上下文？', function () {
							handleDeletePdp(ctx.cid);
						}, '确认删除');
					}));
					var actBtn = Mt5700.button(ctx.active ? '去激活' : '激活', function () {
						if (autodialOn) {
							Mt5700.warning('自动拨号开启时 PDP 由模组维护，手工激活/去激活会与之冲突，请先关闭自动拨号');
							return;
						}
						handleActivePdp(ctx.cid, !ctx.active);
					}, ctx.active ? 'ghost' : 'secondary');

					if (autodialOn) {
						actBtn.disabled = true;
						actBtn.title = '自动拨号开启时由模组维护 PDP，禁止手工切换';
					}
					opWrap.appendChild(actBtn);

					var cidEl = E('span', { 'class': 'mt-pdp-cid' }, '#' + ctx.cid);
					var typeEl = Mt5700.badge(getPdpTypeText(ctx.type), ctx.type === 'IPV4V6' ? 'info' : 'neutral');
					var apnEl = E('span', { 'class': 'mt5700-mono', style: 'font-size:12.5px;' }, ctx.apn || '— (默认)');
					var statusEl = Mt5700.badge(ctx.active ? '已激活' : '未激活', ctx.active ? 'success' : 'neutral');

					return [cidEl, typeEl, apnEl, statusEl, opWrap];
				});
				wrap.appendChild(Mt5700.table(['CID', '协议类型', 'APN', '状态', '操作'], rows, { striped: true }));
				pdpBody.appendChild(wrap);
			}
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
					dialSwitchInput.checked = parsed.enable === 1;
					syncAutodialDefault(parsed.enable === 1);
				}
				renderDialStatus();
			}).catch(function () { Mt5700.error('获取拨号配置失败'); });
		}

		function syncAutodialDefault(enabled) {
			/* 出厂 UCI 已带 autodial_enable/autodial_mode 默认值（缺省时后端也按
			 * 开启/模式1 处理），无需前端播种。这里只做「配置期望 vs 模组实况」
			 * 的不一致提示。 */
			var curEnable = L.uci.get('at-webserver', 'config', 'autodial_enable');
			if (curEnable != null && enabled !== (String(curEnable) === '1')) {
				Mt5700.warning('模组当前自动拨号状态与配置期望不一致：配置=' +
					(String(curEnable) === '1' ? '开启' : '关闭') + '，模组=' + (enabled ? '开启' : '关闭') +
					'。后端会按配置继续对齐；如需以模组状态为准，请点击页面下方「保存并应用」。');
			}
		}

		function handleAutoDialChange(checked) {
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
			/*
			 * 三个字符串原样拼进带双引号的 AT 参数里：双引号会把参数截断，
			 * CR/LF 更会被模组当成命令结束符，直接下发一条额外指令。这里先挡住。
			 */
			if ([apnForm.apn, apnForm.username, apnForm.password].some(function (v) {
				return /["\r\n]/.test(v || '');
			})) {
				Mt5700.error('APN、用户名与密码不能包含双引号或换行');
				return;
			}
			staged.set('apn', 'APN 设置更新', function () {
				/*
				 * 手册 16.18.1 的参数位置固定：<enable> 之后必须是 <dial_mode>，
				 * 再往后才是 protocol/apn/usrname/password/authtype。首次回读若只拿到
				 * enable（16.18.1 的第二种应答），settings.dialMode/protocol 还是空，
				 * 直接拼串会下发 "AT^SETAUTODIAL=1,undefined,,..."，模组只会回 ERROR，
				 * 用户点了半天什么都没改进去。这里按 16.18.3 的合法值兜底。
				 */
				var proto = settings.protocol || 'IP';
				var cmd = 'AT^SETAUTODIAL=' + (settings.enable === 1 ? 1 : 0) + ',' + (settings.dialMode || 1) +
					',"' + proto + '","' + apnForm.apn + '","' + (apnForm.username || '') + '","' +
					(apnForm.password || '') + '",' + (apnForm.authType || 0);
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
				if (!res.success || !res.data) return;
				/*
				 * 手册 11.8 自身两处不一致：11.8.1 写应答是 "^SETMODE: <mode>"，
				 * 11.8.5 的举例又只回一个裸数字 "3"。按 parseInt 直接取裸数字的写法
				 * 遇到带前缀的固件会得到 NaN，USB 模式永远显示「未知」——
				 * 这里取应答里的第一个整数，两种形态都吃得下。
				 */
				var m = String(res.data).match(/(\d+)/);
				if (m) { settings.usbMode = parseInt(m[1], 10); renderDialStatus(); }
			}).catch(function () { Mt5700.error('获取USB模式失败'); });
		}

		function fetchInfcfg() {
			return Ui.sendCmd('AT^TDCFG?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseTdcfg(String(res.data));
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
			/* 手册 16.23.2：DMZ 与后路由互斥，不能同时配置 */
			if (value === 1 && dmzConfig.enabled) {
				/* 拒绝这次开启：把下拉框按回真实状态，否则界面显示「开启」而模组没开 */
				postRouteSel.value = settings.postRoute === 1 ? '1' : '0';
				Mt5700.error('当前已配置 DMZ，两者互斥（手册 16.23.2），请先关闭 DMZ');
				return;
			}
			staged.set('postroute', value === 1 ? '后路由：开启' : '后路由：关闭', function () {
				if (value === 1) {
					/* 手册 16.23.2：用后路由前先关 modem 侧 IP 过滤，
					 * 再 AT+CFUN=0/1 重启射频，最后才拨号。射频重启会瞬断数据，
					 * 这里不替用户按下重启，只在确认后提示手工执行。 */
					return Ui.sendCmd('AT^IPFILTERSWITCH=0').then(function (ipFilter) {
						if (!ipFilter.success) throw new Error('关闭IP过滤失败');
						return Ui.sendCmd('AT^TDCFG="infcfg","PostRoute",1');
					}).then(function (res) {
						if (!res.success) throw new Error('设置后路由失败');
						settings.postRoute = 1;
						Mt5700.info('后路由已开启：按手册 16.23.2 还需一次射频重启（AT+CFUN=0 后 AT+CFUN=1）再拨号才生效');
					});
				}
				/* 手册 16.23.3：<pr_value> 2=关闭后路由，0 是「未配置」的缺省态；
				 * 关掉一件已开启的功能应写 2，而不是把状态抹成未配置。 */
				return Ui.sendCmd('AT^TDCFG="infcfg","PostRoute",2').then(function (res) {
					if (!res.success) throw new Error('设置后路由失败');
					settings.postRoute = 2;
				});
			});
			stageHint();
		}

		function handleDMZ(action, ip) {
			if (action === 'enable' && settings.postRoute === 1) {
				Mt5700.error('后路由已开启，与 DMZ 互斥（手册 16.23.2），请先关闭后路由');
				return;
			}
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
							if (match) list.push({
								cid: Number(match[1]),
								type: match[2],
								apn: (match[3] || '').replace(/^"|"$/g, '').trim(),
								pdp_addr: (match[4] || '').replace(/^"|"$/g, '').trim()
							});
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
				{ key: 'cid', label: 'CID 标识 (1~20)', value: edit.cid },
				{ key: 'type', label: '协议类型', type: 'select', value: edit.type, options: PDP_TYPE_OPTIONS },
				{ key: 'apn', label: 'APN 接入点', value: edit.apn, placeholder: '请输入 APN' },
				{ key: 'pdp_addr', label: 'PDP 地址 (可选)', value: edit.pdp_addr, placeholder: '通常留空由基站动态分配' }
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

		Ui.startup(body, function () {
			loadAll();
		});

		/* 暂存应用条固定在页面底部 */
		body.appendChild(staged.el);

		return page;
	}
});
