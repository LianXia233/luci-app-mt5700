// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require at-webserver/mt5700';
'require at-webserver/rpc';
'require at-webserver/config-common';
/* global L, E, Mt5700, MtConfigCommon */

/*
 * 配置模块：调制解调器连接 + RPC 服务。
 * 独立持有自己的控件、状态与读写逻辑；只写自己负责的 UCI 键，
 * 不触碰其它模块的配置项，避免相互覆盖。
 */
var MtConfigConnection = (function () {
	var C = MtConfigCommon;

	function build(bodyEl, ctx) {
		var state = ctx.data || {};
		var controls = {};
		var baseline = {};

		bodyEl.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, '调制解调器连接'));
		var grid = E('div', { 'class': 'mt5700-cfg-grid' });
		bodyEl.appendChild(grid);

		var connTypeSel = Mt5700.select([
			{ label: 'PCUI 串口（默认，优先 /dev/ttyUSB1）', value: 'SERIAL' },
			{ label: '网络连接（TCP，备用）', value: 'NETWORK' }
		], 'SERIAL');
		grid.appendChild(Mt5700.formGroup('连接类型', connTypeSel));

		var hostInput = Mt5700.input('text', '192.168.8.1', '');
		grid.appendChild(Mt5700.formGroup('网络主机', hostInput));

		var netPortInput = Mt5700.input('number', '20249', '');
		netPortInput.min = 1; netPortInput.max = 65535;
		grid.appendChild(Mt5700.formGroup('网络端口', netPortInput, '模组 TCP 端口，默认 20249'));

		/* 串口：下拉（by-id / 内核编号 / 自定义分组） */
		var serialSel = Mt5700.select([], '');
		function fillSerial(current) {
			while (serialSel.firstChild) serialSel.removeChild(serialSel.firstChild);
			function add(v, label) { serialSel.appendChild(E('option', { value: v }, label || v)); }
			add('auto', '自动探测（优先 by-id / PCUI）');
			var byIds = state.byIdSerials || [];
			if (byIds.length) {
				var g1 = E('optgroup', { label: '稳定路径（推荐，不受插口变化影响）' });
				byIds.forEach(function (p) {
					var hint = /-if(03|12)(-|$)/.test(p) ? '（PCUI / AT 口）' : '';
					g1.appendChild(E('option', { value: p }, p + hint));
				});
				serialSel.appendChild(g1);
			}
			var bare = state.serials || [];
			if (bare.length) {
				var g2 = E('optgroup', { label: '内核编号（可能随插口变化）' });
				bare.forEach(function (p) {
					var hint = p === '/dev/ttyUSB1' ? '（常见 PCUI 编号）' : '';
					g2.appendChild(E('option', { value: p }, p + hint));
				});
				serialSel.appendChild(g2);
			}
			add('__custom__', '自定义路径…');
			if (current) {
				var exists = false;
				for (var i = 0; i < serialSel.options.length; i++) {
					if (serialSel.options[i].value === current) { exists = true; break; }
				}
				if (!exists && current !== '__custom__') add(current, current + '（当前配置）');
				serialSel.value = current;
			}
		}
		var serialCustom = Mt5700.input('text', '例如 /dev/ttyUSB2', '');
		var serialCustomGroup = Mt5700.formGroup('自定义串口路径', serialCustom, '仅在选择「自定义路径」时生效');
		serialCustomGroup.hidden = true;
		serialSel.addEventListener('change', function () {
			serialCustomGroup.hidden = serialSel.value !== '__custom__';
		});
		var serialGroup = Mt5700.formGroup('串口设备', serialSel,
			'优先选「稳定路径」分组：由 VID:PID 与接口描述符生成，换 USB 口或重启后路径不变。');
		serialGroup.classList.add('mt5700-cfg-span2');
		grid.appendChild(serialGroup);
		grid.appendChild(serialCustomGroup);

		var baudInput = Mt5700.input('number', '115200', '');
		grid.appendChild(Mt5700.formGroup('波特率', baudInput));

		var manageIface = C.mkCheck();
		grid.appendChild(Mt5700.formGroup('自动管理网络接口', manageIface.wrap,
			'开启：承载接口不存在时自动创建并设为开机自启；关闭：不创建、不修改任何接口与防火墙。'));

		var v4 = C.ifaceSelect([], 'auto', '自动扫描（推荐）', false, state.netIfaces);
		var v6 = C.ifaceSelect([], 'auto', '自动（跟随 IPv4 接口）', true, state.netIfaces);
		grid.appendChild(Mt5700.formGroup('IPv4 承载接口', v4.sel,
			'自动扫描：使用已挂在模组网口上的接口，没有则使用（并开启管理时创建）MT5700M。'));
		grid.appendChild(Mt5700.formGroup('IPv4 接口名', v4.custom, '仅「手动填写」时生效，只能是字母/数字/下划线'));
		grid.appendChild(Mt5700.formGroup('IPv6 承载接口', v6.sel,
			'自动：使用以「@IPv4 接口」为设备的接口，没有则为「IPv4 接口名 + v6」。'));
		grid.appendChild(Mt5700.formGroup('IPv6 接口名', v6.custom, '仅「手动填写」时生效，只能是字母/数字/下划线'));

		/* ---- RPC 服务 ---- */
		bodyEl.appendChild(E('div', { 'class': 'mt5700-cfg-title' }, 'RPC 服务'));
		var grid2 = E('div', { 'class': 'mt5700-cfg-grid' });
		bodyEl.appendChild(grid2);
		var wsPort = Mt5700.input('number', '8765', '');
		wsPort.min = 1; wsPort.max = 65535;
		grid2.appendChild(Mt5700.formGroup('RPC 端口', wsPort, '默认 8765'));
		var wsBind = Mt5700.select([
			{ label: '仅本机（127.0.0.1，经 rpcd 代理）', value: '127.0.0.1' },
			{ label: '所有接口（0.0.0.0，可被外部访问）', value: '0.0.0.0' }
		], '127.0.0.1');
		grid2.appendChild(Mt5700.formGroup('RPC 监听范围', wsBind, '对外监听时请务必设置认证密钥'));
		var authKey = Mt5700.input('text', '留空表示无需认证', '');
		grid2.appendChild(Mt5700.formGroup('认证密钥', authKey, 'ucode 代理自动附带；LuCI 登录态由 rpcd 会话保证'));

		var fields = {
			connection_type: connTypeSel, network_host: hostInput, network_port: netPortInput,
			serial_port: serialSel, serial_custom: serialCustom, serial_baudrate: baudInput,
			manage_interface: manageIface.input, iface_v4: v4, iface_v6: v6,
			websocket_port: wsPort, websocket_bind: wsBind, websocket_auth_key: authKey
		};
		function snap() {
			return {
				connection_type: connTypeSel.value,
				network_host: hostInput.value,
				network_port: netPortInput.value,
				serial_port: serialSel.value,
				serial_custom: serialCustom.value,
				serial_baudrate: baudInput.value,
				manage_interface: manageIface.input.checked ? '1' : '0',
				iface_v4: v4.sel.value + '|' + v4.custom.value,
				iface_v6: v6.sel.value + '|' + v6.custom.value,
				websocket_port: wsPort.value,
				websocket_bind: wsBind.value,
				websocket_auth_key: authKey.value
			};
		}
		function load() {
			connTypeSel.value = String(C.get('connection_type', 'SERIAL'));
			hostInput.value = String(C.get('network_host', '192.168.8.1'));
			netPortInput.value = String(C.get('network_port', '20249'));
			fillSerial(String(C.get('serial_port', 'auto')));
			baudInput.value = String(C.get('serial_baudrate', '115200'));
			manageIface.input.checked = C.get('manage_interface', '1') !== '0';
			// 手动回填接口（ifaceSelect 创建时以 auto 初始化，这里设真实值并同步显隐）
			var cur4 = String(C.get('iface_v4', 'auto'));
			setIface(v4, cur4);
			var cur6 = String(C.get('iface_v6', 'auto'));
			setIface(v6, cur6);
			wsPort.value = String(C.get('websocket_port', '8765'));
			var bind = C.get('websocket_bind', '');
			if (!bind) bind = C.get('websocket_allow_wan', '0') === '1' ? '0.0.0.0' : '127.0.0.1';
			wsBind.value = bind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
			authKey.value = String(C.get('websocket_auth_key', ''));
			baseline = snap();
		}
		function setIface(pair, cur) {
			var c = cur || 'auto';
			var exists = false;
			for (var i = 0; i < pair.sel.options.length; i++) {
				if (pair.sel.options[i].value === c) { exists = true; break; }
			}
			if (!exists) {
				pair.sel.appendChild(E('option', { value: c }, c + '（当前配置，接口暂不存在）'));
			}
			pair.sel.value = c;
			if (pair.custom.parentElement) pair.custom.parentElement.hidden = (c !== '__custom__');
		}
		function validate() {
			if (v4.value() == null || v6.value() == null) {
				return '承载接口名只能包含字母、数字和下划线';
			}
			return null;
		}
		function save(set) {
			set('connection_type', connTypeSel.value);
			set('network_host', hostInput.value.trim() || '192.168.8.1');
			set('network_port', String(parseInt(netPortInput.value, 10) || 20249));
			var sv = serialSel.value === '__custom__' ? (serialCustom.value.trim() || 'auto') : serialSel.value;
			set('serial_port', sv || 'auto');
			set('serial_baudrate', String(parseInt(baudInput.value, 10) || 115200));
			set('manage_interface', manageIface.input.checked ? '1' : '0');
			set('iface_v4', v4.value());
			set('iface_v6', v6.value());
			set('websocket_port', String(parseInt(wsPort.value, 10) || 8765));
			var b = wsBind.value === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
			set('websocket_bind', b);
			set('websocket_allow_wan', b === '0.0.0.0' ? '1' : '0');
			set('websocket_auth_key', authKey.value.trim());
		}
		return {
			load: load,
			validate: validate,
			save: save,
			isDirty: function () {
				var now = snap();
				return JSON.stringify(now) !== JSON.stringify(baseline);
			}
		};
	}

	return {
		meta: {
			key: 'connection',
			title: '调制解调器连接',
			icon: 'op-device',
			desc: '连接类型、串口（含稳定 by-id 路径）、网络接口与 RPC 端口密钥'
		},
		build: build
	};
})();

var MtConfigConnectionClass = L.Class.extend(MtConfigConnection);
if (typeof window !== 'undefined') {
	window.MtConfigConnection = new MtConfigConnectionClass();
}
return MtConfigConnectionClass;
