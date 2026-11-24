// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require at-webserver/mt5700';
'require at-webserver/rpc';
'require at-webserver/config-common';
/* global L, E, Mt5700, MtConfigCommon */

/*
 * 配置模块：默认 DNS 下发 + 定时锁频总开关 + 界面壁纸。
 * 这些是「网络与外观」类配置，独立成模块，与连接/通知解耦。
 */
var MtConfigNetwork = (function () {
	var C = MtConfigCommon;
	var DNS_DEFAULTS = {
		v4_1: '119.29.29.29', v4_2: '223.5.5.5',
		v6_1: '2402:4e00::', v6_2: '2400:3200::1'
	};

	function build(bodyEl, ctx) {
		C.ensureFormStyles();
		var baseline = {};

		bodyEl.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '默认 DNS 下发'));
		bodyEl.appendChild(E('div', { 'class': 'mt5700-hint' },
			'实测行为：写入的 DNS 会被 netifd 排在运营商下发的 DNS 之前；'
			+ '默认还开启「独占」，即只使用下面填写的地址。'
			+ '若「调制解调器连接」里关闭了自动管理接口，本项不生效。'));
		var grid = E('div', { 'class': 'mt5700-cfg-grid' });
		bodyEl.appendChild(grid);

		var dnsEnable = C.mkCheck();
		grid.appendChild(Mt5700.formGroup('启用默认 DNS 下发', dnsEnable.wrap,
			'关闭后不再下发，并清除此前写入的 dns / peerdns（接口恢复系统默认）。'));

		var v4a = Mt5700.input('text', DNS_DEFAULTS.v4_1, '');
		var v4b = Mt5700.input('text', DNS_DEFAULTS.v4_2, '');
		var v6a = Mt5700.input('text', DNS_DEFAULTS.v6_1, '');
		var v6b = Mt5700.input('text', DNS_DEFAULTS.v6_2, '');
		grid.appendChild(Mt5700.formGroup('IPv4 首选 DNS', v4a, '每次拨号成功后下发；留空表示不写这一条'));
		grid.appendChild(Mt5700.formGroup('IPv4 备用 DNS', v4b, '每次拨号成功后下发；留空表示不写这一条'));
		grid.appendChild(Mt5700.formGroup('IPv6 首选 DNS', v6a, '仅当本次拨号确实拿到 IPv6 时才下发'));
		grid.appendChild(Mt5700.formGroup('IPv6 备用 DNS', v6b, '本次未拿到 IPv6 时会清掉上次留下的 IPv6 DNS'));
		var dnsExcl = C.mkCheck();
		grid.appendChild(Mt5700.formGroup('独占 DNS（忽略运营商下发）', dnsExcl.wrap,
			'默认开启：只使用上面填写的地址（peerdns=0）。关闭后保留运营商 DNS 但排在后面。'));

		bodyEl.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '定时锁频'));
		var sched = C.mkCheck();
		bodyEl.appendChild(Mt5700.formGroup('启用定时锁频', sched.wrap,
			'总开关；具体时段与频段在「定时锁频」页面编排。'));

		bodyEl.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '界面'));
		var wallpaper = C.mkCheck();
		bodyEl.appendChild(Mt5700.formGroup('显示全局壁纸', wallpaper.wrap,
			'三角网格壁纸 + 随机角色立绘。保存后刷新页面生效。后端不读此项。'));

		function snap() {
			return [
				dnsEnable.input.checked, v4a.value, v4b.value, v6a.value, v6b.value,
				dnsExcl.input.checked, sched.input.checked, wallpaper.input.checked
			].join('\u0001');
		}
		function load() {
			dnsEnable.input.checked = C.get('dns_enable', '1') !== '0';
			v4a.value = String(C.get('dns_v4_1', DNS_DEFAULTS.v4_1));
			v4b.value = String(C.get('dns_v4_2', DNS_DEFAULTS.v4_2));
			v6a.value = String(C.get('dns_v6_1', DNS_DEFAULTS.v6_1));
			v6b.value = String(C.get('dns_v6_2', DNS_DEFAULTS.v6_2));
			dnsExcl.input.checked = C.get('dns_exclusive', '1') !== '0';
			sched.input.checked = C.get('schedule_enabled', '0') === '1';
			wallpaper.input.checked = C.get('wallpaper_enabled', '1') !== '0';
			baseline = snap();
		}
		function validate() { return null; }
		function save(set) {
			// 留空是合法的（表示不写这一条），不做非空回落
			set('dns_enable', dnsEnable.input.checked ? '1' : '0');
			set('dns_v4_1', v4a.value.trim());
			set('dns_v4_2', v4b.value.trim());
			set('dns_v6_1', v6a.value.trim());
			set('dns_v6_2', v6b.value.trim());
			set('dns_exclusive', dnsExcl.input.checked ? '1' : '0');
			set('schedule_enabled', sched.input.checked ? '1' : '0');
			set('wallpaper_enabled', wallpaper.input.checked ? '1' : '0');
		}
		return {
			load: load, validate: validate, save: save,
			isDirty: function () { return snap() !== baseline; }
		};
	}

	return {
		meta: {
			key: 'network',
			title: '网络与界面',
			icon: 'op-network',
			desc: '默认 DNS 下发、定时锁频总开关与全局壁纸'
		},
		build: build
	};
})();

var MtConfigNetworkClass = L.Class.extend(MtConfigNetwork);
if (typeof window !== 'undefined') {
	window.MtConfigNetwork = new MtConfigNetworkClass();
}
return MtConfigNetworkClass;
