'use strict';
'require at-webserver/rpc';
'require at-webserver/mt5700';
/* 本页是插件里唯一不依赖 ui.js 的视图（配置全走 ubus/rpcd），但「后端未就绪」
 * 提示条这个**插件级组件**必须每页都有 —— 保存与重载都要 at-webserver 起来才
 * 有效，连不上时正是最需要提示的场景。样式见 global.css，注入见 mt5700.js。 */
'require at-webserver/ui';
/* global L, AtWs, Mt5700, Ui */

/**
 * 服务配置页面，覆盖以下配置项：
 * - connection_type / network_host / network_port / serial_port / baud_rate
 * - websocket_host / websocket_port / websocket_auth_key
 * - 通知总开关：notify_enabled（关闭后仅写本地通知日志，外发全部停止）
 * - 通知开关：notify_*（来电/短信/信号/内存满/WebHook URL 与企业微信）
 * - 定时推送间隔：notify_timer_interval（分钟，默认 10；到点推送当前实际情况）
 * - 信号定时巡检：notify_poll_enabled / notify_poll_start / notify_poll_end /
 *   notify_poll_interval / notify_poll_all / notify_poll_delta
 *   （本模组不会主动上报信号，必须由后端在时段内主动轮询才会产生信号通知）
 * - 自定义推送文案：notify_tpl_prefix / notify_tpl_sms / notify_tpl_call /
 *   notify_tpl_signal / notify_tpl_memory / notify_tpl_batch（多行按 `\n` 转义存储）
 * - 定时锁频总开关 schedule_enabled
 * - 保存后通过 ubus 重载服务（等价 /etc/init.d/at-webserver reload）
 *
 * 状态判定说明（修复「未运行」误报）：
 * procd 的 service.list 只反映「已注册实例」，当 init 脚本缺失（例如被 overlay
 * 白化）或服务从未被拉起时，它返回的是空对象——这与「服务配置为禁用」在界面上
 * 无法区分，且不给出任何原因。本页改为多源交叉判定：
 *   1) 已注册实例的 running/pid（procd 权威状态）
 *   2) 二进制是否存在（file.stat）
 *   3) 二进制是否可执行（file.stat 的执行位）
 *   4) 配置是否启用（UCI enabled）
 * 并区分「运行中」/「已禁用」/「未安装」/「不可执行」/「未注册」/「已停止」六种语义，
 * 给出对应的修复建议。
 */

var SERVICE = 'at-webserver';
var BINARY = '/usr/bin/at-webserver-rust';

/* /dev/serial/by-id 稳定符号链接目录（与 Rust 侧 BY_ID_DIR 及 init.d 保持一致）。
 * 由 init.d 的 sync_serial_by_id 维护：本机没有 udev/mdev，没有组件会替我们建它。 */
var BY_ID_DIR = '/dev/serial/by-id';

/**
 * 扫描 procd service.list 响应里的实例运行状态（load/fetchRunning/refreshStatus 三处共用）。
 * 末尾的 svc.running/svc.pid 兜底是给非标准应答留的；正常 procd 顶层不携带这两个字段。
 */
function scanProcdInstances(svc) {
	svc = svc || {};
	var running = false;
	var pid = null;
	if (svc.instances) {
		Object.keys(svc.instances).forEach(function (k) {
			var it = svc.instances[k] || {};
			if (it.running || it.pid) {
				running = true;
				if (!pid && it.pid) pid = it.pid;
			}
		});
	}
	if (!running && (svc.running || svc.pid)) {
		running = true;
		pid = svc.pid || null;
	}
	return { running: running, pid: pid };
}

/**
 * 归一化 rpcd file.list 应答：兼容数组 / {entries} / {name: type} 映射三种形态。
 */
function normalizeFileList(raw) {
	var entries = [];
	if (Array.isArray(raw)) {
		entries = raw;
	} else if (raw && Array.isArray(raw.entries)) {
		entries = raw.entries;
	} else if (raw && typeof raw === 'object') {
		// 某些 rpcd 返回 { name: type } 映射
		Object.keys(raw).forEach(function (k) {
			var v = raw[k];
			if (v && typeof v === 'object') {
				entries.push(Object.assign({ name: k }, v));
			} else {
				entries.push({ name: k, type: String(v || '') });
			}
		});
	}
	return entries;
}

/**
 * 由多源状态推导服务状态标签、颜色与原因提示。
 * 优先级：运行中 > 已禁用 > 未安装 > 不可执行 > 未注册 > 已停止
 */
function resolveStatus(state) {
	var running = !!state.running;
	var registered = !!state.registered;
	var binExists = !!state.binExists;
	var enabled = state.enabled === '1';

	if (running) {
		return { label: '运行中', variant: 'success', pid: state.pid || null, hint: '' };
	}
	if (!enabled) {
		return {
			label: '已禁用', variant: 'neutral', pid: null,
			hint: '配置中 enabled=0，服务被刻意关闭。需要启动请在下方勾选后保存，或执行 uci set at-webserver.config.enabled=1。'
		};
	}
	if (!binExists) {
		return {
			label: '未安装', variant: 'danger', pid: null,
			hint: '未找到可执行文件 ' + BINARY + '，后端可能未安装或安装不完整。请重新安装 luci-app-mt5700。'
		};
	}
	if (!state.binExec) {
		return {
			label: '不可执行', variant: 'danger', pid: null,
			hint: BINARY + ' 缺少可执行权限。请执行 chmod 0755 ' + BINARY + ' 后重试。'
		};
	}
	if (!registered) {
		return {
			label: '未注册', variant: 'warning', pid: null,
			hint: '进程未运行，且 procd 中不存在 at-webserver 实例。最常见原因是服务没有注册开机自启' +
				'（/etc/rc.d/S99at-webserver 软链接缺失，历史上由 init.d 执行位回退导致安装期 enable 失败），' +
				'其次才是 /etc/init.d/at-webserver 缺失或被 overlay 覆盖（例如存在白化字符设备）。' +
				'点击「重载服务」会自动补注册；也可手动执行 /etc/init.d/at-webserver enable && /etc/init.d/at-webserver start。'
		};
	}
	return {
		label: '已停止', variant: 'danger', pid: null,
		hint: '实例已在 procd 注册但进程未运行，可能启动失败或被反复重启。请查看系统日志（logread -e at-webserver）后重载服务。'
	};
}

return L.view.extend({
	load: function () {
		var listSerial = L.rpc.declare({
			object: 'file',
			method: 'list',
			params: ['path'],
			expect: { entries: [] }
		});
		var statBinary = L.rpc.declare({
			object: 'file',
			method: 'stat',
			params: ['path'],
			expect: {}
		});
		var serviceList = L.rpc.declare({
			object: 'service',
			method: 'list',
			params: ['name'],
			expect: { '': {} }
		});
		return Promise.all([
			L.uci.load(SERVICE),
			serviceList(SERVICE).catch(function () { return {}; }),
			listSerial('/dev').catch(function () { return { entries: [] }; }),
			statBinary(BINARY).catch(function () { return null; }),
			/* by-id 稳定路径目录可能不存在（无模组 / 尚未执行 sync_serial_by_id），
			 * 这里独立请求并独立 catch：失败不能影响其它五项，页面照常渲染 */
			listSerial(BY_ID_DIR).catch(function () { return { entries: [] }; }),
			/* 网络接口列表：供「承载接口」下拉选择；读不到时仍可手动填写 */
			L.uci.load('network').catch(function () { return null; })
		]).then(function (res) {
			var netIfaces = [];
			try {
				netIfaces = L.uci.sections('network', 'interface').map(function (sec) {
					return sec['.name'];
				}).filter(function (n) { return n && n !== 'loopback'; });
			} catch (e) {
				netIfaces = [];
			}
			var raw = res[2];
			var entries = normalizeFileList(raw);
			var serials = [];
			entries.forEach(function (e) {
				var name = e && (e.name || e.path || '');
				if (!name) return;
				name = String(name).replace(/^\/dev\//, '');
				if (/^(ttyUSB|ttyACM|ttyAMA|ttyS)\d+/.test(name)) {
					serials.push('/dev/' + name);
				}
			});
			serials = serials.filter(function (p, i, a) { return a.indexOf(p) === i; });
			serials.sort();

			/* ---- by-id 稳定路径（优先展示） ----
			 *
			 * 与上面 ttyUSB* 列表分开收集、分开排序：两者用途不同，
			 * by-id 是「配置里应当持久化的那个」，ttyUSB* 是「回退与排障用」。
			 * 下拉框里分组呈现，避免用户混选后又遇到编号漂移。
			 */
			var byIdEntries = (function () {
				var r = res[4];
				var list = normalizeFileList(r);
				var out = [];
				list.forEach(function (e) {
					var n = e && (e.name || '');
					if (!n) return;
					// 只要符号链接条目（by-id 下应当全是链接）
					var t = e && e.type ? String(e.type) : '';
					if (t && t !== 'link' && t !== 'symlink') return;
					out.push(BY_ID_DIR + '/' + String(n).replace(/^.*\//, ''));
				});
				out = out.filter(function (p, i, a) { return a.indexOf(p) === i; });
				out.sort();
				return out;
			})();

			/* ---------- 服务状态多源判定 ---------- */
			var svc = (res[1] && res[1][SERVICE]) || {};
			var registered = !!(res[1] && res[1][SERVICE]);
			var procd = scanProcdInstances(svc);
			var found = procd.running;
			var pid = procd.pid;

			var st = res[3];
			// rpcd file.stat 返回 {type:'file', mode:0755, ...}；失败时返回 null
			var binExists = !!(st && (st.type || st.mode !== undefined));
			var binExec = binExists && !!(st.mode & parseInt('0111', 8));

			var enabled = L.uci.get(SERVICE, 'config', 'enabled');
			enabled = enabled === null || enabled === undefined ? '1' : String(enabled);

			return {
				running: found,
				registered: registered,
				pid: pid,
				binExists: binExists,
				binExec: binExec,
				enabled: enabled,
				serials: serials,
				byIdSerials: byIdEntries,
				netIfaces: netIfaces
			};
		});
	},

	render: function (data) {
		var page = Mt5700.page('服务配置', 'AT 后台守护进程、串口/TCP 探测与异步通知联动配置', 'service', '守护进程 · 后台服务');
		var body = page._body;

		var state = data || {};

		/* ---------- 服务状态判定（五态） ---------- */
		var status = resolveStatus(state);

		/* 服务状态 + 定时锁频：双列并排（定时锁频卡在下方创建，此处先建容器） */
		var rowTop = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowTop);

		var statusCard = Mt5700.card('服务状态', '');
		var statusBody = E('div');
		statusCard._body.appendChild(statusBody);
		rowTop.appendChild(statusCard);

		var statusRow = E('div', { 'class': 'mt5700-inline' });
		statusRow.appendChild(Mt5700.badge(status.label, status.variant));
		if (status.pid) statusRow.appendChild(Mt5700.badge('PID ' + status.pid, 'neutral'));
		statusBody.appendChild(statusRow);

		var actions = Mt5700.panelActions(
			Mt5700.button('重载服务', function () { reloadService(); }, 'primary'),
			Mt5700.button('重启服务', function () { restartService(); }, 'primary')
		);
		var reloadBtn = actions.firstChild;
		var restartBtn = actions.lastChild;

		// 非「运行中」时给出可读的原因与建议，避免只有一个红色标签
		if (status.hint) {
			statusBody.appendChild(E('div', { 'class': 'mt5700-hint' }, status.hint));
		}
		statusBody.appendChild(actions);

		/* ---------- 连接配置 + RPC 服务（双列并排） ---------- */
		var rowConn = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(rowConn);

		var connCard = Mt5700.card('调制解调器连接', '后端连接模组的通道');
		/* 两列表单网格（.mt5700-form-grid）：本页字段多、说明长，一行一个字段
		 * 在桌面端会拉出 5000px 以上的滚动距离；两列后说明文字按列宽换行即可。 */
		var connBody = E('div', { 'class': 'mt5700-form-grid' });
		connCard._body.appendChild(connBody);
		rowConn.appendChild(connCard);

		var connTypeSel = Mt5700.select([
			{ label: 'PCUI 串口（默认，优先 /dev/ttyUSB1）', value: 'SERIAL' },
			{ label: '网络连接（TCP，备用）', value: 'NETWORK' }
		], 'SERIAL');
		connBody.appendChild(Mt5700.formGroup('连接类型', connTypeSel));

		var hostInput = Mt5700.input('text', '192.168.8.1', '');
		connBody.appendChild(Mt5700.formGroup('网络主机', hostInput));

		var netPortInput = Mt5700.input('number', '20249', '');
		netPortInput.min = 1;
		netPortInput.max = 65535;
		connBody.appendChild(Mt5700.formGroup('网络端口', netPortInput, '模组 TCP 端口，默认 20249'));

		/* 串口：下拉 + 自定义；选项来自系统 /dev 识别结果 */
		var serialSel = Mt5700.select([], '');
		function fillSerialOptions(current) {
			while (serialSel.firstChild) serialSel.removeChild(serialSel.firstChild);
			function add(v, label) {
				var o = E('option', { value: v }, label || v);
				serialSel.appendChild(o);
			}
			/* 分组呈现（<optgroup>），把「稳定路径」与「会漂移的裸编号」在视觉上
			 * 分开：
			 *   - 第一组 by-id：跨 USB 口/控制器稳定，是**应当持久化到配置**的那个，
			 *     默认推荐选它；
			 *   - 第二组 ttyUSB*：会随枚举顺序平移，仅作回退与排障用。
			 * 不分组直接平铺，用户很容易随手选了 ttyUSB1，之后拔插一次就失效。 */
			add('auto', '自动探测（优先 by-id / PCUI）');

			var byIds = state.byIdSerials || [];
			if (byIds.length) {
				var gById = E('optgroup', { label: '稳定路径（推荐，不受插口变化影响）' });
				byIds.forEach(function (p) {
					/*
					 * PCUI（AT 口）在 by-id 名字里的接口号：
					 * 《MT5700M-CN USB 接口应用指南》Linux 侧端口表给出 NCM 0x00/0x01、
					 * DIAG 0x02、PCUI 0x03、Serial_B 0x04、Serial_C 0x05、GPS 0x06，
					 * 文档口径是 if03；本机实测固件枚举出的接口更多，AT 口落在 if12。
					 * 两个都认，避免换固件/换 USB 形态后提示消失。
					 */
					var hint = /-if(03|12)(-|$)/.test(p) ? '（PCUI / AT 口）' : '';
					gById.appendChild(E('option', { value: p }, p + hint));
				});
				serialSel.appendChild(gById);
			}

			var bare = state.serials || [];
			if (bare.length) {
				var gBare = E('optgroup', { label: '内核编号（可能随插口变化）' });
				bare.forEach(function (p) {
					var hint = p === '/dev/ttyUSB1' ? '（常见 PCUI 编号）' : '';
					gBare.appendChild(E('option', { value: p }, p + hint));
				});
				serialSel.appendChild(gBare);
			}

			add('__custom__', '自定义路径…');
			if (current) {
				var exists = false;
				for (var i = 0; i < serialSel.options.length; i++) {
					if (serialSel.options[i].value === current) { exists = true; break; }
				}
				if (!exists && current !== '__custom__') {
					add(current, current + '（当前配置）');
				}
				serialSel.value = current;
			}
		}
		var serialCustom = Mt5700.input('text', '例如 /dev/ttyUSB2', '');
		/* 自定义路径整组一起收起：只藏输入框的话，标号和说明会留下一个空占位，
		 * 在两列网格里尤其像渲染坏了。 */
		var serialCustomGroup = Mt5700.formGroup('自定义串口路径', serialCustom,
			'仅在选择「自定义路径」时生效');
		serialCustomGroup.hidden = true;
		serialSel.addEventListener('change', function () {
			/* 用 hidden 而不是 style.display：移动端为横排写了
			 * `display: grid !important`，内联样式压不住它（见 mt5700.css）。 */
			serialCustomGroup.hidden = serialSel.value !== '__custom__';
		});
		/* 串口选择器占整行：by-id 路径很长，两列宽度下会被下拉框截断到看不出区别。 */
		var serialGroup = Mt5700.formGroup('串口设备', serialSel,
			'优先选「稳定路径」分组：它由 VID:PID 与接口描述符生成，换 USB 口或重启后路径不变；' +
			'「内核编号」分组在插口变化时会整体平移，仅作回退。');
		serialGroup.classList.add('mt5700-span-2');
		connBody.appendChild(serialGroup);
		connBody.appendChild(serialCustomGroup);

		var baudInput = Mt5700.input('number', '115200', '');
		connBody.appendChild(Mt5700.formGroup('波特率', baudInput));

		/* 接口管理开关：固件已自带指向模组网口的上行接口（如 wan/wan6 → usb0）时关闭，
		 * 避免插件再建 MT5700M/MT5700Mv6，导致同一网卡上两套 DHCP 与两条默认路由。 */
		var manageIfaceSwitch = E('div', { 'class': 'mt5700-switch' });
		var manageIfaceChk = E('input', { type: 'checkbox' });
		manageIfaceSwitch.appendChild(manageIfaceChk);
		connBody.appendChild(Mt5700.formGroup('自动管理网络接口', manageIfaceSwitch,
			'开启：承载接口不存在时自动创建，并设为开机自启、登记到上行防火墙区域。' +
			'关闭：不创建、不修改任何接口与防火墙，拨号就绪后只拉起下面选定的承载接口。' +
			'关闭不会删除已创建的 MT5700M / MT5700Mv6，需要时请在「网络 → 接口」中手动删除。'));

		/* 承载接口：自动扫描（挂在模组网口上的现有接口优先，例如固件自带的 wan → usb0）
		 * 或手动设置（从现有接口中选，或填写接口名）。 */
		var ifaceV4Sel = Mt5700.select([], 'auto');
		var ifaceV4Custom = Mt5700.input('text', '例如 wan', '');
		var ifaceV6Sel = Mt5700.select([], 'auto');
		var ifaceV6Custom = Mt5700.input('text', '例如 wan6', '');

		function fillIfaceOptions(sel, input, current, autoLabel, allowNone) {
			while (sel.firstChild) sel.removeChild(sel.firstChild);
			function add(v, label) {
				sel.appendChild(E('option', { value: v }, label || v));
			}
			add('auto', autoLabel);
			if (allowNone) add('none', '不使用 IPv6');
			(state.netIfaces || []).forEach(function (n) { add(n); });
			add('__custom__', '手动填写…');
			var cur = current || 'auto';
			var exists = false;
			for (var i = 0; i < sel.options.length; i++) {
				if (sel.options[i].value === cur) { exists = true; break; }
			}
			if (!exists) add(cur, cur + '（当前配置，接口暂不存在）');
			sel.value = cur;
			/* 「接口名」这一格只在「手动填写」时才有意义；整组收起比只藏输入框
			 * 干净 —— 否则会留下一个只有标号与说明的空行。 */
			if (input.parentElement) input.parentElement.hidden = (cur !== '__custom__');
		}
		[[ifaceV4Sel, ifaceV4Custom], [ifaceV6Sel, ifaceV6Custom]].forEach(function (pair) {
			pair[0].addEventListener('change', function () {
				if (pair[1].parentElement) {
					pair[1].parentElement.hidden = pair[0].value !== '__custom__';
				}
			});
		});
		connBody.appendChild(Mt5700.formGroup('IPv4 承载接口', ifaceV4Sel,
			'自动扫描：使用已挂在模组网口上的接口，没有则使用（并在开启管理时创建）MT5700M。'));
		connBody.appendChild(Mt5700.formGroup('IPv4 接口名', ifaceV4Custom, '仅在选择「手动填写」时生效，只能包含字母、数字和下划线'));
		connBody.appendChild(Mt5700.formGroup('IPv6 承载接口', ifaceV6Sel,
			'自动：使用以「@IPv4 接口」为设备的接口（如 wan6 → @wan），没有则为「IPv4 接口名 + v6」。'));
		connBody.appendChild(Mt5700.formGroup('IPv6 接口名', ifaceV6Custom, '仅在选择「手动填写」时生效，只能包含字母、数字和下划线'));

		/* 读取下拉 + 手动输入的结果；不合法返回 null */
		function ifaceValue(sel, input, allowNone) {
			var v = sel.value === '__custom__' ? input.value.trim() : sel.value;
			if (!v) v = 'auto';
			if (v === 'auto' || (allowNone && v === 'none')) return v;
			return /^[A-Za-z0-9_]+$/.test(v) ? v : null;
		}

		/* ---------- RPC 服务 ---------- */
		var wsCard = Mt5700.card('RPC 服务', 'LuCI 经 rpcd/ucode 代理连接后端使用的端口与密钥（仅回环监听，不对外暴露）');
		var wsBody = E('div', { 'class': 'mt5700-form-grid' });
		wsCard._body.appendChild(wsBody);
		rowConn.appendChild(wsCard);

		/* 旧 UCI 键 websocket_host 已废弃：RPC 固定监听 127.0.0.1，页面不再提供输入框 */

		var wsPortInput = Mt5700.input('number', '8765', '');
		wsPortInput.min = 1;
		wsPortInput.max = 65535;
		wsBody.appendChild(Mt5700.formGroup('RPC 端口', wsPortInput, '默认 8765'));

		var wsBindSel = Mt5700.select([
			{ label: '仅本机（127.0.0.1，经 rpcd 代理）', value: '127.0.0.1' },
			{ label: '所有接口（0.0.0.0，可被外部访问）', value: '0.0.0.0' }
		], '127.0.0.1');
		wsBody.appendChild(Mt5700.formGroup('RPC 监听范围', wsBindSel, '对外监听时请务必设置认证密钥'));

		var authKeyInput = Mt5700.input('text', '留空表示无需认证', '');
		wsBody.appendChild(Mt5700.formGroup('认证密钥', authKeyInput, 'ucode 代理自动附带该密钥；LuCI 登录态由 rpcd 会话保证'));

	/* ---------- 默认 DNS 下发 ----------
	 *
	 * 地址集中定义在 UCI（at-webserver.config.dns_*），拨号成功后由 init.d 的
	 * apply_default_dns 写入承载接口。这里只负责让用户改地址 / 关开关。 */
	var DNS_DEFAULTS = {
		v4_1: '119.29.29.29',
		v4_2: '223.5.5.5',
		v6_1: '2402:4e00::',
		v6_2: '2400:3200::1'
	};

	var dnsCard = Mt5700.card('默认 DNS 下发', '拨号成功后写入承载接口的解析服务器，可自行更换或关闭');
	var dnsBody = E('div', { 'class': 'mt5700-form-grid' });
	dnsCard._body.appendChild(dnsBody);
	body.appendChild(dnsCard);

	/* 优先级口径必须写在页面上：很多人以为「兜底」等于「运营商没给才用」，
	 * 实测 netifd 把 UCI 手写的 dns 排在 DHCP/RA 下发的 DNS 之前，
	 * 所以它同时是实际优先使用的那一个 —— 不写清楚会被当成配置没生效。 */
	dnsBody.appendChild(E('div', { 'class': 'mt5700-hint' },
		'实测行为：写入的 DNS 会被 netifd 排在运营商下发的 DNS 之前；'
		+ '默认还开启了「独占」，即只使用下面填写的地址，运营商下发的DNS排在后面。'));

	var dnsEnableSwitch = E('div', { 'class': 'mt5700-switch' });
	var dnsEnableChk = E('input', { type: 'checkbox' });
	dnsEnableSwitch.appendChild(dnsEnableChk);
	dnsBody.appendChild(Mt5700.formGroup('启用默认 DNS 下发', dnsEnableSwitch,
		'关闭后不再下发，并清除此前已写入的 dns / peerdns（接口恢复系统默认行为）。'
		+ '若上方「自动管理网络接口」关闭，本插件不改动任何接口配置，此项也不生效。'));

	var dnsV4A = Mt5700.input('text', DNS_DEFAULTS.v4_1, '');
	var dnsV4B = Mt5700.input('text', DNS_DEFAULTS.v4_2, '');
	var dnsV6A = Mt5700.input('text', DNS_DEFAULTS.v6_1, '');
	var dnsV6B = Mt5700.input('text', DNS_DEFAULTS.v6_2, '');

	dnsBody.appendChild(Mt5700.formGroup('IPv4 首选 DNS', dnsV4A, '每次拨号成功后都会下发；留空表示不写这一条'));
	dnsBody.appendChild(Mt5700.formGroup('IPv4 备用 DNS', dnsV4B, '每次拨号成功后都会下发；留空表示不写这一条'));
	dnsBody.appendChild(Mt5700.formGroup('IPv6 首选 DNS', dnsV6A,
		'仅当本次拨号确实拿到 IPv6（PDP 类型为 IPv6 / IPv4v6）时才下发'));
	dnsBody.appendChild(Mt5700.formGroup('IPv6 备用 DNS', dnsV6B,
		'同上；本次未拿到 IPv6 时会清掉上一次留下的 IPv6 DNS，'
		+ '避免出现「无 IPv6 连通性却配着 IPv6 DNS」（表现为解析随机超时）'));

	var dnsExclSwitch = E('div', { 'class': 'mt5700-switch' });
	var dnsExclChk = E('input', { type: 'checkbox' });
	dnsExclSwitch.appendChild(dnsExclChk);
	dnsBody.appendChild(Mt5700.formGroup('独占 DNS（忽略运营商下发的 DNS）', dnsExclSwitch,
		'默认开启：只使用上面填写的地址（peerdns=0）。关闭后保留运营商下发的 DNS，但排在自己后面。'));

	/* ---------- 定时锁频 ---------- */
	var schedCard = Mt5700.card('定时锁频', '总开关与默认参数');
		var schedBody = E('div');
		schedCard._body.appendChild(schedBody);
		rowTop.appendChild(schedCard);

		var schedSwitch = E('div', { 'class': 'mt5700-switch' });
		var schedChk = E('input', { type: 'checkbox' });
		schedSwitch.appendChild(schedChk);
		schedBody.appendChild(Mt5700.formGroup('启用定时锁频', schedSwitch, '在「服务 → 模组管理 → 定时锁频」编排时段'));

		/* ---------- 通知配置 ---------- */
		var notifCard = Mt5700.card('通知', '事件通知与 WebHook');
		var notifBody = E('div', { 'class': 'mt5700-form-grid' });
		notifCard._body.appendChild(notifBody);
		body.appendChild(notifCard);

		/* ---------- 界面 ---------- */
		/* 全局壁纸开关：只影响前端展示（mt5700.js 的全局背景层），后端不读这个键。
		 * 存在 uci 是为了跨页面/跨会话记住偏好；缺省视为开启。 */
		var uiCard = Mt5700.card('界面', '外观显示');
		var uiBody = E('div', { 'class': 'mt5700-form-grid' });
		uiCard._body.appendChild(uiBody);
		body.appendChild(uiCard);

		var wallpaperSwitch = E('div', { 'class': 'mt5700-switch' });
		var wallpaperChk = E('input', { type: 'checkbox' });
		wallpaperSwitch.appendChild(wallpaperChk);
		uiBody.appendChild(Mt5700.formGroup('显示全局壁纸', wallpaperSwitch,
			'三角网格壁纸 + 随机角色立绘（每次刷新随机显示其一）。保存后刷新页面生效。'));

		function mkCheck() {
			var wrap = E('div', { 'class': 'mt5700-switch' });
			var input = E('input', { type: 'checkbox' });
			wrap.appendChild(input);
			return { wrap: wrap, input: input };
		}

		/* 时间口径说明：所有对外时间都跟本机系统时区走（取不到时默认北京时间）。
		 * 放在通知卡片最前 —— 用户最容易在「推送时间不对」时来这里找原因。 */
		notifBody.appendChild(E('div', { 'class': 'mt5700-hint' },
			'时间口径：推送与日志中的时间一律使用本机系统时区（LuCI「系统 → 时间同步 → 时区」）；'
			+ '系统未配置时区时回落北京时间 UTC+08:00。'));

		/* 自动推送总开关：放在通知卡片最前 —— 它是「所有推送」的总闸门。
		 * 关闭后后端不再外发任何消息（仅保留本地通知日志），并停止信号定时巡检。 */
		var notifyMaster = mkCheck();
		notifBody.appendChild(Mt5700.formGroup('自动推送总开关', notifyMaster.wrap,
			'关闭后所有事件都不再推送，仅写入本地通知日志；信号定时巡检也会一并停止。'));

		var notifyCalls = mkCheck();
		var notifySms = mkCheck();
		var notifySignal = mkCheck();
		var notifyMem = mkCheck();

		notifBody.appendChild(Mt5700.formGroup('来电通知', notifyCalls.wrap, '实时推送，不受定时推送间隔影响'));
		notifBody.appendChild(Mt5700.formGroup('新短信通知', notifySms.wrap, '实时推送，不受定时推送间隔影响'));
		notifBody.appendChild(Mt5700.formGroup('信号变化通知', notifySignal.wrap,
			'需配合下方「信号定时巡检」才会产生数据：模组不会主动上报信号读数'));
		notifBody.appendChild(Mt5700.formGroup('短信存储满通知', notifyMem.wrap));

		var webhookInput = Mt5700.input('text', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', '');
		var wechatChk = mkCheck();
		notifBody.appendChild(Mt5700.formGroup('企业微信推送', wechatChk.wrap,
			'独立开关，默认关闭。开启后事件通知才会推送到企业微信机器人；'
			+ '与 QQ 推送互不影响，两者各自单独控制。'));
		notifBody.appendChild(Mt5700.formGroup('企业微信 WebHook', webhookInput, '通知将推送到该 WebHook 地址'));

		/* 定时推送间隔。
		 * 语义是「每 N 分钟主动推一次当前实际情况」（信号读数 + 短信存储用量），
		 * 不是「事件攒够一批再发」 —— 后者（合并窗口、秒）已在 v1.14.20 移除：
		 * 用户想知道的是「现在怎么样」，而不是「刚才发生了什么」。
		 * 单位用分钟：这个间隔的合理量级是几分钟到几小时，秒级既没必要也容易误填
		 * （60 秒和 60 分钟只差一个字，写错就是 60 倍）。
		 * 与下面的「信号定时巡检」是两条独立的周期线，各自按自己的节奏推。 */
		var notifyTimerInput = Mt5700.input('number', '10', '');
		notifyTimerInput.min = 1;
		notifyTimerInput.max = 1440;
		notifyTimerInput.step = 1;
		/* 快捷时长：填数字前先给几个常见量级，顺带把「分钟」这个单位讲清楚 */
		var timerQuick = Mt5700.select([
			{ label: '自定义（手动填上面）', value: '' },
			{ label: '1 分钟', value: '1' },
			{ label: '5 分钟', value: '5' },
			{ label: '10 分钟（默认）', value: '10' },
			{ label: '30 分钟', value: '30' },
			{ label: '1 小时', value: '60' },
			{ label: '3 小时', value: '180' },
			{ label: '12 小时', value: '720' },
			{ label: '24 小时', value: '1440' }
		], '');
		var timerHuman = E('span', { 'class': 'mt5700-hint' }, '');
		function timerText(min) {
			var n = parseInt(min, 10);
			if (!n || n < 1 || n > 1440) {
				return '当前值无效，保存后会被夹取到 1-1440 之间（无效时取默认 10 分钟）';
			}
			var tail = '推送一次当前实际情况（信号读数 + 短信存储用量）';
			if (n < 60) return '每 ' + n + ' 分钟' + tail;
			var h = Math.floor(n / 60), m = n % 60;
			return '每 ' + (m ? h + ' 小时 ' + m + ' 分钟' : h + ' 小时') + tail;
		}
		function timerSync() {
			timerQuick.value = notifyTimerInput.value;
			timerHuman.textContent = timerText(notifyTimerInput.value);
		}
		timerQuick.addEventListener('change', function () {
			if (timerQuick.value) notifyTimerInput.value = timerQuick.value;
			timerHuman.textContent = timerText(notifyTimerInput.value);
		});
		notifyTimerInput.addEventListener('input', timerSync);
		notifBody.appendChild(Mt5700.formGroup('定时推送间隔（分钟）', notifyTimerInput,
			'范围 1-1440（即最长 24 小时），默认 10。到点主动推送当前实际情况，' +
			'不管期间有没有事件发生；下面的信号巡检是另一条独立周期线。' +
			'短信与来电仍是实时推送，不受此间隔影响。'));
		notifBody.appendChild(Mt5700.formGroup('快捷时长', timerQuick, timerHuman));

		/* ---------- 信号定时巡检 ----------
		 *
		 * 为什么必须有它：本模组（TDTECH / Fibocom 系）不会主动上报 ^HCSQ / ^CERSSI
		 * —— 实机 1200 条 AT 记录里自发信号上报为 0 条，因此「信号变化通知」开关
		 * 若没有后端主动查询就永远是死的。这里由后端在指定时段内定期查询。
		 *
		 * 时段外一条 AT 都不发：既不占串口，也不会在半夜无意义地打扰用户。 */
		var pollEnable = mkCheck();
		var pollStartInput = Mt5700.input('time', '', '00:00');
		var pollEndInput = Mt5700.input('time', '', '23:59');
		var pollIntervalInput = Mt5700.input('number', '300', '');
		pollIntervalInput.min = 30;
		pollIntervalInput.max = 3600;
		var pollModeSel = Mt5700.select([
			{ label: '仅信号变化时推送（推荐）', value: 'change' },
			{ label: '每次巡检都推送当前状态', value: 'always' }
		], 'change');
		var pollDeltaInput = Mt5700.input('number', '3', '');
		pollDeltaInput.min = 1;
		pollDeltaInput.max = 30;

		/* 巡检子区块整体加一层轻边框，视觉上与其它通知项区分开：
		 * 它是「信号类通知」的专属数据源，而不是又一组平级开关。 */
		notifBody.appendChild(E('style', {},
			'.mt5700-poll-box{border:1px solid rgba(127,127,127,.25);border-radius:8px;' +
			'padding:10px 12px 2px;margin:4px 0 10px;background:rgba(127,127,127,.05)}' +
			'.mt5700-poll-title{font-size:13px;font-weight:600;opacity:.85;margin-bottom:8px}' +
			'.mt5700-poll-row{display:flex;align-items:center;gap:8px}' +
			'.mt5700-poll-row input{flex:1 1 0;min-width:0}' +
			'.mt5700-poll-sep{opacity:.7;font-size:12px}' +
			'.mt5700-poll-box input:disabled,.mt5700-poll-box select:disabled{opacity:.45;cursor:not-allowed}'));

		var pollRow = E('div', { 'class': 'mt5700-poll-row' });
		pollRow.appendChild(pollStartInput);
		pollRow.appendChild(E('span', { 'class': 'mt5700-poll-sep' }, '至'));
		pollRow.appendChild(pollEndInput);

		var pollBox = E('div', { 'class': 'mt5700-poll-box mt5700-form-grid' });
		pollBox.appendChild(E('div', { 'class': 'mt5700-poll-title' }, '信号定时巡检'));
		pollBox.appendChild(Mt5700.formGroup('启用信号定时巡检', pollEnable.wrap,
			'仅「信号变化通知」依赖它；短信与来电由模组主动上报，不受影响'));
		pollBox.appendChild(Mt5700.formGroup('巡检时段', pollRow,
			'该时段内按间隔查询信号，时段外不查询也不推送。起点晚于终点表示跨零点（如 22:00 至 06:00）；' +
			'两端相同视为全天。'));
		pollBox.appendChild(Mt5700.formGroup('巡检间隔', pollIntervalInput,
			'单位秒，范围 30-3600，默认 300。间隔越短越灵敏，也越占串口与推送配额。'));
		pollBox.appendChild(Mt5700.formGroup('推送策略', pollModeSel,
			'「仅变化时推送」只在信号明显变化时通知；「每次巡检都推送」会按间隔持续发送当前状态。'));
		pollBox.appendChild(Mt5700.formGroup('变化阈值', pollDeltaInput,
			'单位 dB，范围 1-30，默认 3，仅在「仅变化时推送」下生效。1=任何一档变化都推，30=只推剧烈变化。'));
		notifBody.appendChild(pollBox);

		/* ---------- 推送频率限制（防刷屏） ----------
		 *
		 * 为什么必须有它：模组在 LTE↔NR 覆盖边缘来回切换时，巡检每一轮都判定为「有变化」
		 * —— 上面的「变化阈值」只管 RSRP 波动，管不住制式切换（模式一变必推）。
		 * 于是「推送间隔」实际退化成了「巡检间隔」：默认 300 秒轮询下，
		 * 一次来回切换能连着推好几条，把 QQ 刷屏。
		 *
		 * 因此在「该不该推」之上再加一层时间闸门：两条信号类通知之间至少间隔 N 分钟，
		 * 默认 60（一小时最多一条）。范围上限 10080 = 7 天，0 = 不限频（回到旧行为）。
		 *
		 * 只管信号类：短信与来电仍由模组上报、实时直发；
		 * 上面的「定时推送间隔」也不受限制（那是用户自己定的固定节奏，压它就是替用户做决定）。
		 * 被闸门压住的那轮不会刷新基线，累计变化在到点后立刻补推，不会因为限频而永远漏掉。 */
		var rateMinInput = Mt5700.input('number', '60', '');
		rateMinInput.min = 0;
		rateMinInput.max = 10080;
		rateMinInput.step = 1;
		/* 快捷档位：先给几个常见量级，顺便说明 0 的含义（防刷屏默认开启，要刷屏才选 0） */
		var rateQuick = Mt5700.select([
			{ label: '自定义（手动填上面）', value: '' },
			{ label: '5 分钟', value: '5' },
			{ label: '15 分钟', value: '15' },
			{ label: '30 分钟', value: '30' },
			{ label: '1 小时（默认）', value: '60' },
			{ label: '3 小时', value: '180' },
			{ label: '6 小时', value: '360' },
			{ label: '12 小时', value: '720' },
			{ label: '24 小时', value: '1440' },
			{ label: '不限频（旧行为，切换频繁时会刷屏）', value: '0' }
		], '60');
		var rateHuman = E('span', { 'class': 'mt5700-hint' }, '');
		function rateText(min) {
			var raw = String(min == null ? '' : min).trim();
			var n = parseInt(raw, 10);
			if (raw === '' || isNaN(n) || n < 0) {
				return '当前值为空或非法，保存后按默认 1 小时处理';
			}
			if (n === 0) {
				return '不限频：每次判定为「有变化」都立即推送（制式来回切换时可能一分钟好几条）';
			}
			if (n > 10080) {
				return '当前值 ' + n + ' 分钟超出上限，保存后按 10080 分钟（7 天）处理';
			}
			var d = Math.floor(n / 1440), h = Math.floor((n % 1440) / 60), m = n % 60;
			var parts = [];
			if (d) parts.push(d + ' 天');
			if (h) parts.push(h + ' 小时');
			if (m || !parts.length) parts.push(m + ' 分钟');
			return '信号类通知最少间隔 ' + parts.join(' ') + '，即这段时间内最多一条';
		}
		function rateSync() {
			rateQuick.value = rateMinInput.value;
			rateHuman.textContent = rateText(rateMinInput.value);
		}
		rateQuick.addEventListener('change', function () {
			if (rateQuick.value) rateMinInput.value = rateQuick.value;
			rateHuman.textContent = rateText(rateMinInput.value);
		});
		rateMinInput.addEventListener('input', rateSync);

		var rateBox = E('div', { 'class': 'mt5700-poll-box mt5700-form-grid' });
		rateBox.appendChild(E('div', { 'class': 'mt5700-poll-title' }, '推送频率限制（防刷屏）'));
		rateBox.appendChild(Mt5700.formGroup('网络切换提醒最小间隔（分钟）', rateMinInput,
			'范围 0-10080，默认 60（一小时内最多一条），0=不限频。' +
			'只约束信号类通知（网络切换提醒）；短信与来电始终实时直发，' +
			'上面的「定时推送间隔」也不受此项限制。'));
		rateBox.appendChild(Mt5700.formGroup('快捷间隔', rateQuick, rateHuman));
		notifBody.appendChild(rateBox);

		/* QQ 主动消息节流：把「一次挤进来一批」摊平成按间隔排队发送。
		 * 平台频控是群 30~60 条/分钟、单聊 20 条/分钟，超限会被直接丢弃甚至封禁，
		 * 因此这里默认 10 条/分钟 —— 注意是延后发送而不是丢弃，消息仍会送达。 */
		var qqRateInput = Mt5700.input('number', '10', '');
		qqRateInput.min = 0;
		qqRateInput.max = 60;
		qqRateInput.step = 1;
		var qqRateHuman = E('span', { 'class': 'mt5700-hint' }, '');
		var QQ_RATE_TAIL = '。QQ 平台频控：群 30~60 条/分钟、单聊 20 条/分钟，超限的消息会被平台直接丢弃。';
		function qqRateText(n) {
			if (isNaN(n) || n < 0) return '当前值为空或非法，保存后按默认 10 条/分钟处理' + QQ_RATE_TAIL;
			if (n === 0) return '不节流：按事件发生顺序立即发送' + QQ_RATE_TAIL;
			if (n > 60) n = 60;
			/* 上限 60 条/分钟 ⇒ 间隔最小正好 1 秒，不需要毫秒分支 */
			var gapMs = Math.round(60000 / n);
			var gapText = (gapMs / 1000).toFixed(gapMs % 1000 ? 1 : 0) + ' 秒';
			return '最多 ' + n + ' 条/分钟（约每 ' + gapText + '一条），超出的排队延后发送而不是丢弃' + QQ_RATE_TAIL;
		}
		qqRateInput.addEventListener('input', function () {
			qqRateHuman.textContent = qqRateText(parseInt(qqRateInput.value, 10));
		});

		/* 控件联动：总开关是根，巡检开关次之，阈值只对「仅变化时推送」有意义。
		 * 置灰后控件不再响应输入，用户一眼能看出哪些项当前不起作用。 */
		function syncPollState() {
			var masterOn = notifyMaster.input.checked;
			var pollOn = masterOn && pollEnable.input.checked;
			[pollStartInput, pollEndInput, pollIntervalInput, pollModeSel].forEach(function (el) {
				el.disabled = !pollOn;
			});
			pollDeltaInput.disabled = !pollOn || pollModeSel.value !== 'change';
			/* 频率闸门只作用于信号类通知：信号开关关掉时它没有约束对象，一并置灰。
			 * 巡检关掉但 URC 上报仍在的场合不用操心 —— 本模组不自发上报信号，
			 * 关掉巡检就等于没有信号推送。 */
			var rateOn = notifyMaster.input.checked && notifySignal.input.checked;
			rateMinInput.disabled = !rateOn;
			rateQuick.disabled = !rateOn;
		}

		function syncNotifyState() {
			var on = notifyMaster.input.checked;
			[notifyCalls.input, notifySms.input, notifySignal.input, notifyMem.input].forEach(function (el) {
				el.disabled = !on;
			});
			pollEnable.input.disabled = !on;
			syncPollState();
		}

		notifyMaster.input.addEventListener('change', syncNotifyState);
		pollEnable.input.addEventListener('change', syncPollState);
		pollModeSel.addEventListener('change', syncPollState);
		notifySignal.input.addEventListener('change', syncPollState);

		/* QQ 机器人（官方 API v2）：AppID+AppSecret+目标 ID 全部填写后启用 */
		var qqAppIdInput = Mt5700.input('text', 'QQ 开放平台 AppID（纯数字）', '');
		var qqSecretInput = Mt5700.input('password', '留空则回退环境变量 QQ_BOT_APP_SECRET', '');
		var qqTargetSel = Mt5700.select([
			{ label: '群聊（group_openid）', value: 'group' },
			{ label: '单聊（用户 openid）', value: 'c2c' },
			{ label: '频道（channel_id）', value: 'channel' },
			{ label: '绑定（自动获取 openid，推荐首次使用）', value: 'bind' }
		], 'group');
		var qqBindInput = Mt5700.input('text', '你的 QQ 号（仅作绑定标签）', '');
		var qqTargetIdInput = Mt5700.input('text', 'group_openid / 用户 openid / channel_id', '');
		var qqChk = mkCheck();
		notifBody.appendChild(Mt5700.formGroup('QQ 推送', qqChk.wrap,
			'独立开关，默认关闭。开启后事件通知才会推送到 QQ 机器人；'
			+ '与企业微信推送互不影响，两者各自单独控制。'));
		notifBody.appendChild(Mt5700.formGroup('QQ 机器人 AppID', qqAppIdInput, '也可用环境变量 QQ_BOT_APP_ID 覆盖'));
		notifBody.appendChild(Mt5700.formGroup('QQ 机器人 AppSecret', qqSecretInput, '建议留空并经环境变量 QQ_BOT_APP_SECRET 注入，避免凭据落盘 UCI'));
		notifBody.appendChild(Mt5700.formGroup('QQ 推送目标类型', qqTargetSel, '选「绑定」：保存并应用后，用你的 QQ 给机器人发一条消息即自动完成绑定'));
		notifBody.appendChild(Mt5700.formGroup('绑定 QQ 号', qqBindInput, '仅用于日志标识（平台事件里拿不到 QQ 号），openid 由后端自动抓取'));
		notifBody.appendChild(Mt5700.formGroup('QQ 推送目标 ID', qqTargetIdInput,
		'openid 是平台分配的联系人标识，不是 QQ 号，也无法由 QQ 号换算。'
		+ '绑定模式留空即可（保存并应用后，用你的 QQ 给机器人发一条消息即自动写回）；'
		+ '手动模式请粘贴完整 openid（绑定成功后的日志里也能看到）。'));

	/* QQ 富文本与交互（v1.28.0）：消息格式 / 内嵌键盘 / 自定义菜单。
	 * 后端实现见 src/rust/src/qqpush.rs；格式降级（富文本失败回落纯文本）
	 * 在后端自动完成，这里只暴露选择。 */
	var qqFormatSel = Mt5700.select([
		{ label: '自动（富文本优先，失败自动回落纯文本，推荐）', value: 'auto' },
		{ label: '富文本 Markdown（只发结构化消息，失败不回落）', value: 'markdown' },
		{ label: '纯文本（只发普通文本）', value: 'text' }
	], 'auto');
	var qqKbChk = mkCheck();
	var qqKbUrlInput = Mt5700.input('text', '留空则按局域网 IP 自动推导，如 http://192.168.1.1/', '');
	var qqMenuChk = mkCheck();
	notifBody.appendChild(Mt5700.formGroup('QQ 消息格式', qqFormatSel,
		'富文本 = Markdown 结构化消息（标题、列表、引用排版）；纯文本为兜底形态。'
		+ '「自动」在富文本发送失败时自动改发纯文本，保证消息不丢失。'));
	/* 节流目前只实现在 QQ 通道（QqSender）上：刷屏问题就是 QQ 侧反馈的，
	 * 而且平台对主动消息有明确频控（群 30~60 条/分钟、单聊 20 条/分钟）。
	 * 企业微信 webhook 未接这层，若将来也要限，应在 Notifier 的通道投递处统一做。
	 * 两级限制层次不同：上面的「最小间隔」决定「这条通知到底发不发」，
	 * 这里决定「已经确定要发的消息隔多久发一条」。 */
	notifBody.appendChild(Mt5700.formGroup('QQ 每分钟最多条数', qqRateInput, qqRateHuman));
	notifBody.appendChild(Mt5700.formGroup('富文本附带「打开管理页」按钮', qqKbChk.wrap,
		'在 QQ 富文本消息底部附带一个跳转按钮，点击直达本机管理页。'
		+ '按钮跳转地址填在下一项；留空则按局域网 IP 自动推导。'));
	notifBody.appendChild(Mt5700.formGroup('按钮跳转地址', qqKbUrlInput,
		'按钮点击后打开的地址（http/https）。一般填路由器管理地址；'
		+ '仅在使用非标准端口或域名访问时才需要改。'));
	notifBody.appendChild(Mt5700.formGroup('启动时自动配置 QQ 菜单', qqMenuChk.wrap,
		'在 QQ 单聊窗口底部配置「查询状态 / 查询流量」两个菜单项（仅单聊场景生效）。'
		+ '点击菜单项会把指令填入输入框；机器人应答指令需要长连接支持（当前版本未实现）。'
		+ '也可随时用下方「配置 QQ 菜单」按钮手动配置。'));

	/* 手动配置 QQ 自定义菜单（不等重启，立即生效） */
	var qqMenuRpc = L.rpc.declare({
		object: 'mt5700', method: 'qq_menu',
		params: ['action', '_rid'], expect: {}
	});
	var qqMenuStatus = E('span', { 'class': 'mt5700-hint' }, '');
	var qqMenuBtn = Mt5700.button('配置 QQ 菜单', function () {
		qqMenuBtn.disabled = true;
		qqMenuStatus.textContent = '正在配置 QQ 自定义菜单…';
		qqMenuRpc('set', 'menu-' + Date.now()).then(function (res) {
			if (res && res.success) {
				qqMenuStatus.textContent = '菜单已配置（version=' + (res.version || '?')
					+ '）：QQ 单聊窗口底部可见「查询状态 / 查询流量」';
				Mt5700.success('QQ 自定义菜单已配置');
			} else {
				qqMenuStatus.textContent = '配置失败：' + ((res && res.error) || '未知原因');
				Mt5700.error('QQ 菜单配置失败');
			}
		}).catch(function (err) {
			qqMenuStatus.textContent = '配置失败：' + ((err && err.message) || 'RPC 调用失败');
			Mt5700.error('QQ 菜单配置失败');
		}).finally(function () {
			qqMenuBtn.disabled = false;
		});
	});
	notifBody.appendChild(E('div', { 'class': 'mt5700-form-group' }, qqMenuBtn, qqMenuStatus));

		/* 测试推送：两种粒度，回答两个不同的问题
		 *   通道连通性（企业微信 / QQ）—— 这条通道到底通不通，不看事件类型；
		 *   事件类型（短信 / 来电）—— 这两类只能由模组 URC 触发，想验证文案与实时性
		 *   就得等一条真短信或一通真电话。故提供同形状事件的注入入口：它走的是与真实
		 *   事件完全相同的链路（总开关 → 类型开关 → 实时直发 → 文案模板 → 通道投递），
		 *   收到的文本与真实短信/来电一字不差。 */
		var notifyTest = L.rpc.declare({
			object: 'mt5700', method: 'notify_test',
			params: ['channel', '_rid'], expect: {}
		});
		var testStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var testBtn = Mt5700.button('发送测试通知', function () {
			testBtn.disabled = true;
			testStatus.textContent = '正在发送测试通知…';
			var channels = [];
			/* 通道可见性跟随两个独立开关：开关关掉时对应通道不参与测试 */
			if (wechatChk.input.checked && String(get('wechat_webhook', '')) !== '') channels.push('wechat');
			if (qqChk.input.checked && (String(get('qq_target_type', '')) === 'bind' || String(get('qq_app_id', '')) !== '')) channels.push('qq');
			if (channels.length === 0) {
				testStatus.textContent = '没有已启用的推送通道（先填写企业微信 WebHook 或 QQ 配置并保存）';
				testBtn.disabled = false;
				return;
			}
			Promise.all(channels.map(function (ch) {
				return notifyTest(ch, 'test-' + ch + '-' + Date.now()).then(function (res) {
					return { channel: ch, ok: !!(res && res.success), error: (res && res.error) || '' };
				}).catch(function (err) {
					return { channel: ch, ok: false, error: (err && err.message) || 'RPC 调用失败' };
				});
			})).then(function (results) {
				var text = results.map(function (r) {
					return (r.channel === 'qq' ? 'QQ 机器人' : '企业微信') + '：' + (r.ok ? '发送成功' : '失败（' + r.error + '）');
				}).join('；');
				testStatus.textContent = text;
				results.forEach(function (r) {
					if (r.ok) { Mt5700.success((r.channel === 'qq' ? 'QQ 机器人' : '企业微信') + '测试通知已发送'); }
					else { Mt5700.error((r.channel === 'qq' ? 'QQ 机器人' : '企业微信') + '测试失败'); }
				});
			}).finally(function () {
				testBtn.disabled = false;
			});
		});
		/* 按事件类型测试：开关没开时后端会明确报错，这里原样转述，避免「显示成功却没收到」 */
		var smsTestBtn = Mt5700.button('测试短信推送', function () {
			runKindTest(smsTestBtn, 'sms', '短信');
		});
		var callTestBtn = Mt5700.button('测试来电推送', function () {
			runKindTest(callTestBtn, 'call', '来电');
		});
		function runKindTest(btn, channel, label) {
			btn.disabled = true;
			testStatus.textContent = '正在发送测试' + label + '推送…';
			notifyTest(channel, 'test-' + channel + '-' + Date.now()).then(function (res) {
				if (res && res.success) {
					testStatus.textContent = label + '测试推送已发送（走的是与真实' + label + '相同的链路）';
					Mt5700.success(label + '测试推送已发送');
				} else {
					var why = (res && res.error) || '未知原因';
					testStatus.textContent = label + '测试推送未发送：' + why;
					Mt5700.error(label + '测试推送未发送：' + why);
				}
			}).catch(function (err) {
				testStatus.textContent = label + '测试推送失败：' + ((err && err.message) || 'RPC 调用失败');
				Mt5700.error(label + '测试推送失败');
			}).finally(function () {
				btn.disabled = false;
			});
		}
		notifBody.appendChild(E('div', { 'class': 'mt5700-form-group' }, testBtn, smsTestBtn, callTestBtn, testStatus));

		/* 绑定进度：轮询后端 qq_bind_status，展示状态与 600 秒窗口倒计时 */
		var qqBindStatus = L.rpc.declare({
			object: 'mt5700', method: 'qq_bind_status',
			params: ['_rid'], expect: {}
		});
		var bindStatusLine = E('span', { 'class': 'mt5700-hint' }, '');
		/* 进度条：600 秒监听窗口的剩余比例。仅 waiting 状态显示，
		 * 其余状态整条隐藏，避免「没在绑定也挂着一条空进度」的误解。 */
		var bindBarWrap = E('div', { 'style': 'display:none;width:240px;max-width:100%;height:6px;'
			+ 'background:rgba(127,127,127,.25);border-radius:3px;overflow:hidden;margin-top:6px;' });
		var bindBar = E('div', { 'style': 'height:100%;width:100%;border-radius:3px;'
			+ 'background:var(--mt5700-accent,#3f8edc);transition:width .5s linear;' });
		bindBarWrap.appendChild(bindBar);
		notifBody.appendChild(E('div', { 'class': 'mt5700-form-group' },
			E('strong', {}, '绑定进度：'), bindStatusLine, bindBarWrap));
		var bindState = '';
		/* 秒 → m:ss（进度条旁的剩余时间显示） */
		function fmtMmSs(sec) {
			var m = Math.floor(sec / 60);
			var s = sec % 60;
			return m + ':' + (s < 10 ? '0' : '') + s;
		}
		var bindTimer = setInterval(function () {
			/* 页面已卸载时停止轮询 */
			if (!bindStatusLine.isConnected) { clearInterval(bindTimer); return; }
			qqBindStatus('bind-' + Date.now()).then(function (res) {
				if (!res) return;
				bindState = String(res.state || 'idle');
				var left = parseInt(res.left, 10) || 0;
				var isBind = String(get('qq_target_type', '')) === 'bind' || qqTargetSel.value === 'bind';
				if (bindState === 'waiting') {
					bindBarWrap.style.display = '';
					bindBar.style.width = Math.max(0, Math.min(100, left / 600 * 100)) + '%';
					bindStatusLine.textContent = '等待绑定：用你的 QQ 给机器人发一条消息即可完成'
						+ '（剩余 ' + fmtMmSs(left) + ' / 10:00，超时后重启服务自动重试）';
				} else if (bindState === 'success') {
					bindBarWrap.style.display = 'none';
					var tid = String(res.target_id || '');
					bindStatusLine.textContent = '绑定成功：目标 ' + (res.target_type || '') + ' '
						+ (tid.length > 12 ? tid.slice(0, 12) + '…' : tid) + '（已写回 UCI 并生效）';
				} else if (bindState === 'failed') {
					bindBarWrap.style.display = 'none';
					bindStatusLine.textContent = '绑定失败：' + (res.error || '未知原因') + '（下次服务重启自动重试）';
				} else if (isBind) {
					bindBarWrap.style.display = 'none';
					bindStatusLine.textContent = '已配置绑定模式：保存并应用后开始等待消息';
				} else {
					bindState = '';
					bindBarWrap.style.display = 'none';
					bindStatusLine.textContent = '';
				}
			}).catch(function () { /* RPC 暂不可用时静默，下个周期重试 */ });
		}, 2000);

		/* ---------- 自定义推送文案 ----------
		 *
		 * UCI 的 option 值是单行的，多行模板统一按 `\n` 转义存储
		 * （与 Rust 侧 config::escape_template / unescape_template 一一对应）。
		 * 页面在此做「真实换行 <-> \n」双向转换，用户只管在文本框里正常换行。
		 *
		 * 文本框留空表示沿用内置默认文案：后端在配置读取阶段回落，
		 * 因此升级后未被改动过的文案仍会跟随版本更新。
		 */
		var tplCard = Mt5700.card('推送文案', '四类事件各自的推送正文；留空则使用内置默认文案');
		var tplBody = E('div', { 'class': 'mt5700-form-grid' });
		tplCard._body.appendChild(tplBody);
		body.appendChild(tplCard);

		/* 模板是多行文本，等宽字体 + 保留空白更便于校对 */
		tplBody.appendChild(E('style', {},
			'.mt5700-tpl-area{width:100%;box-sizing:border-box;min-height:74px;padding:8px 10px;' +
			'resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
			'font-size:12.5px;line-height:1.5;white-space:pre-wrap;}'));

		function mkTplArea(rows) {
			var ta = E('textarea', { 'class': 'mt5700-input mt5700-tpl-area', rows: String(rows || 3) });
			ta.spellcheck = false;
			return ta;
		}

		var tplPrefixInput = mkTplArea(2);
		var tplSmsInput = mkTplArea(3);
		var tplCallInput = mkTplArea(3);
		var tplSignalInput = mkTplArea(3);
		var tplMemInput = mkTplArea(3);
		/* 与上面五项用同一种文本框（两行，和「前缀」一致）：
		 * 原来这里是普通单行 input，等宽字体、高度、边框都和相邻的模板框不同，
		 * 在卡片里显得像另一个控件。它和「前缀」一样是短文本，两行足够。 */
		var tplBatchInput = mkTplArea(2);
		/* QQ 富文本短信卡片：Markdown 多行模板，行高给足 */
		var tplQqSmsInput = mkTplArea(9);

		var PLACEHOLDER_HINT =
			'可用占位符：{sender} 发送者 · {content} 事件正文 · {time} 事件时刻 · ' +
			'{kind} 事件类型（新短信 / 来电 / 信号变化 / 存储空间已满） · {count} 本条消息合并的条数；' +
			'未识别的占位符会原样保留。';

		tplBody.appendChild(Mt5700.formGroup('前缀（所有推送消息最前面）', tplPrefixInput,
			'默认 {time} {count}（事件时刻 + 本条消息条数）。所有推送只带这一种前缀，'
			+ '各事件模板不再自带其他前缀；留空则不添加。测试通知也会带上它，便于一次性验证。'));
		tplBody.appendChild(Mt5700.formGroup('新短信', tplSmsInput, PLACEHOLDER_HINT));
		tplBody.appendChild(Mt5700.formGroup('来电', tplCallInput, PLACEHOLDER_HINT));
		tplBody.appendChild(Mt5700.formGroup('信号变化', tplSignalInput, PLACEHOLDER_HINT));
		tplBody.appendChild(Mt5700.formGroup('短信存储满', tplMemInput, PLACEHOLDER_HINT));
		tplBody.appendChild(Mt5700.formGroup('批量汇总标题', tplBatchInput,
			'合并窗口已于 v1.14.20 移除，不再有「多条事件合并成一条」的场景；' +
			'此项保留仅为兼容已有配置，当前不会被触发。'));
		tplBody.appendChild(Mt5700.formGroup('QQ 富文本短信卡片', tplQqSmsInput,
			'仅 QQ 富文本（Markdown）消息生效；企业微信与 QQ 纯文本仍用上方「新短信」模板。'
			+ '占位符：{sender} 发送者 · {content} 短信正文 · {time} 接收时间 · {count} 消息序号。'
			+ '留空 = 内置默认卡片；写成 {body} 则改用通用转换（不加卡片版式）。'
			+ '分隔线请用空行包裹的 ---，页脚用 *斜体*（QQ 不支持 <sub> 等 HTML 标签）。'));

		/* 内置默认文案：必须与 Rust 侧 config.rs 的 DEFAULT_TPL_* 保持一致。
		 * 仅用于「恢复默认文案」按钮与初始回填，后端始终以自己的默认为准。 */
		var TPL_DEFAULTS = {
			prefix: '{time} {count}',
			sms: '新短信\n发送者：{sender}\n内容：{content}',
			call: '来电\n{content}',
			signal: '{content}',
			memory: '短信存储空间已满\n后果：清理前可能收不到新短信',
			batch: '批量汇总',
			qq_sms_md: '## 喵呜～收到新短信啦\n'
				+ '有新的消息送到喵，快来看看是谁给你寄来了信笺。\n'
				+ '**发送者：** `{sender}`\n'
				+ '**接收时间：** `{time}`\n'
				+ '**消息序号：** `{count}`\n'
				+ '\n'
				+ '---\n'
				+ '\n'
				+ '### 信笺内容\n'
				+ '\n'
				+ '{content}\n'
				+ '\n'
				+ '---\n'
				+ '\n'
				+ '*本喵已经把信笺整理好啦，记得及时查收喵。*'
		};

		var tplStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var tplResetBtn = Mt5700.button('恢复默认文案', function () {
			tplPrefixInput.value = TPL_DEFAULTS.prefix;
			tplSmsInput.value = TPL_DEFAULTS.sms;
			tplCallInput.value = TPL_DEFAULTS.call;
			tplSignalInput.value = TPL_DEFAULTS.signal;
			tplMemInput.value = TPL_DEFAULTS.memory;
			tplBatchInput.value = TPL_DEFAULTS.batch;
			tplQqSmsInput.value = TPL_DEFAULTS.qq_sms_md;
			AtWs.uci.markDirty();
			tplStatus.textContent = '已填入默认文案，点击「保存并应用」后生效';
		});
		tplBody.appendChild(E('div', { 'class': 'mt5700-form-group' }, tplResetBtn, tplStatus));

		/* 真实换行 <-> `\n` 转义。转义必须先处理反斜杠，
		 * 否则用户文本里的 `\n` 会被二次解释；还原用单遍扫描保证可逆。 */
		function tplToUci(v) {
			return String(v == null ? '' : v)
				.replace(/\\/g, '\\\\')
				.replace(/\n/g, '\\n')
				.replace(/\r/g, '\\r')
				.replace(/\t/g, '\\t');
		}
		function tplFromUci(v) {
			return String(v == null ? '' : v).replace(/\\([ntr\\])/g, function (m, c) {
				return c === 'n' ? '\n' : (c === 't' ? '\t' : (c === 'r' ? '\r' : '\\'));
			});
		}
		/* 读配置：UCI 为空时回填内置默认，让输入框自带文档性 */
		function tplLoad(key, def) {
			var v = String(get(key, ''));
			return v === '' ? def : tplFromUci(v);
		}

		/* <input type="time"> 只接受 HH:MM 且会静默清空非法值：用户手改 UCI 写成
		 * "8:30" 或 "8:7" 这类格式时，浏览器会让输入框变空且不报错，看起来像配置丢了。
		 * 这里统一校验并补零，非法/越界一律回落到默认值，与后端 load_config 的
		 * 回落策略保持一致（后端也会把非法值换成默认并按告警记录一条日志）。 */
		function setTimeInput(el, raw, def) {
			var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(raw == null ? '' : raw).trim());
			if (!m) { el.value = def; return; }
			var h = parseInt(m[1], 10);
			var mi = parseInt(m[2], 10);
			if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) { el.value = def; return; }
			el.value = (h < 10 ? '0' + h : String(h)) + ':' + (mi < 10 ? '0' + mi : String(mi));
		}

		/* ---------- 载入 UCI（单 section `config` + 扁平键，与 Rust/ucode 一致） ---------- */
		var get = function (key, def) {
			var v = L.uci.get('at-webserver', 'config', key);
			return v == null || v === '' ? def : v;
		};
		connTypeSel.value = String(get('connection_type', 'SERIAL'));
		hostInput.value = String(get('network_host', '192.168.8.1'));
		netPortInput.value = String(get('network_port', '20249'));
		fillSerialOptions(String(get('serial_port', 'auto')));
		baudInput.value = String(get('serial_baudrate', '115200'));
		manageIfaceChk.checked = get('manage_interface', '1') !== '0';
		fillIfaceOptions(ifaceV4Sel, ifaceV4Custom, String(get('iface_v4', 'auto')),
			'自动扫描（推荐）', false);
	fillIfaceOptions(ifaceV6Sel, ifaceV6Custom, String(get('iface_v6', 'auto')),
		'自动（跟随 IPv4 接口）', true);
	/* 默认 DNS：缺省值写在脚本里，老配置升级上来（UCI 里没有这些键）也能显示出厂值 */
	dnsEnableChk.checked = get('dns_enable', '1') !== '0';
	dnsV4A.value = String(get('dns_v4_1', DNS_DEFAULTS.v4_1));
	dnsV4B.value = String(get('dns_v4_2', DNS_DEFAULTS.v4_2));
	dnsV6A.value = String(get('dns_v6_1', DNS_DEFAULTS.v6_1));
	dnsV6B.value = String(get('dns_v6_2', DNS_DEFAULTS.v6_2));
	dnsExclChk.checked = get('dns_exclusive', '1') !== '0';
		wsPortInput.value = String(get('websocket_port', '8765'));
		var bindCur = get('websocket_bind', '');
		if (!bindCur) {
			bindCur = get('websocket_allow_wan', '0') === '1' ? '0.0.0.0' : '127.0.0.1';
		}
		wsBindSel.value = bindCur === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
		authKeyInput.value = String(get('websocket_auth_key', ''));
		schedChk.checked = get('schedule_enabled', '0') === '1';
		wallpaperChk.checked = get('wallpaper_enabled', '1') !== '0';
		notifyMaster.input.checked = get('notify_enabled', '1') === '1';
		notifyCalls.input.checked = get('notify_call', '1') === '1';
		notifySms.input.checked = get('notify_sms', '1') === '1';
		notifySignal.input.checked = get('notify_signal', '1') === '1';
		notifyMem.input.checked = get('notify_memory_full', '1') === '1';
		wechatChk.input.checked = get('wechat_enabled', '0') === '1';
		webhookInput.value = String(get('wechat_webhook', ''));
		qqChk.input.checked = get('qq_enabled', '0') === '1';
		qqAppIdInput.value = String(get('qq_app_id', ''));
		qqSecretInput.value = String(get('qq_app_secret', ''));
		qqTargetSel.value = String(get('qq_target_type', 'group'));
		qqBindInput.value = String(get('qq_bind_qq', ''));
		qqTargetIdInput.value = String(get('qq_target_id', ''));
		qqFormatSel.value = String(get('qq_msg_format', 'auto')) || 'auto';
		qqKbChk.input.checked = get('qq_keyboard_enabled', '0') === '1';
		qqKbUrlInput.value = String(get('qq_keyboard_url', ''));
		qqMenuChk.input.checked = get('qq_menu_enabled', '0') === '1';
		/* 节流条数：UCI 里可能是空值或脏数据，回落默认 10；0 是合法值（= 不节流），不能当空处理 */
		var qqRateRaw = parseInt(get('qq_max_per_minute', '10'), 10);
		qqRateInput.value = String(isNaN(qqRateRaw) ? 10 : qqRateRaw);
		qqRateHuman.textContent = qqRateText(parseInt(qqRateInput.value, 10));
		/* 定时推送间隔（分钟）。旧的 notify_interval（秒）由后端换算迁移，
		 * 这里把换算结果显示出来并说明一句，避免用户以为自己填过的频率丢了。 */
		var timerRaw = String(get('notify_timer_interval', ''));
		var legacySecs = parseInt(get('notify_interval', ''), 10) || 0;
		if (timerRaw === '' && legacySecs > 0) {
			/* 60 秒是旧出厂默认值，不是用户的选择：与后端一致地落到新默认值 10 分钟，
			 * 而不是换算成 1 分钟 —— 否则升级后每台设备都会每分钟推一条。 */
			if (legacySecs === 60) {
				notifyTimerInput.value = '10';
				timerHuman.textContent = timerText('10') +
					'（旧值 60 秒是出厂默认值，已按新默认值 10 分钟迁移，保存后写入新字段）';
			} else {
				notifyTimerInput.value = String(Math.max(1, Math.ceil(legacySecs / 60)));
				timerHuman.textContent = timerText(notifyTimerInput.value) +
					'（由旧的 ' + legacySecs + ' 秒换算而来，保存后写入新字段）';
			}
		} else {
			notifyTimerInput.value = timerRaw || '10';
			timerHuman.textContent = timerText(notifyTimerInput.value);
		}
		timerQuick.value = notifyTimerInput.value;
		pollEnable.input.checked = get('notify_poll_enabled', '1') === '1';
		setTimeInput(pollStartInput, get('notify_poll_start', '00:00'), '00:00');
		setTimeInput(pollEndInput, get('notify_poll_end', '23:59'), '23:59');
		pollIntervalInput.value = String(parseInt(get('notify_poll_interval', '300'), 10) || 300);
		pollModeSel.value = get('notify_poll_all', '0') === '1' ? 'always' : 'change';
		pollDeltaInput.value = String(parseInt(get('notify_poll_delta', '3'), 10) || 3);
		/* 网络切换提醒最小间隔（分钟）。升级前的 UCI 里没有这一项，按默认 60 显示，
		 * 保存后写入 —— 也就是「装上新版本就等于开了防刷屏」，不需要用户额外操作。
		 * 0 是合法值（不限频），所以这里不能用 || 兜底。 */
		var rateRaw = parseInt(get('notify_signal_min_interval', '60'), 10);
		rateMinInput.value = String(isNaN(rateRaw) || rateRaw < 0 ? 60 : rateRaw);
		rateQuick.value = rateMinInput.value;
		rateHuman.textContent = rateText(rateMinInput.value);
		/* 载入完成后按当前值同步一次置灰状态 */
		syncNotifyState();
		tplPrefixInput.value = tplFromUci(String(get('notify_tpl_prefix', '')));
		tplSmsInput.value = tplLoad('notify_tpl_sms', TPL_DEFAULTS.sms);
		tplCallInput.value = tplLoad('notify_tpl_call', TPL_DEFAULTS.call);
		tplSignalInput.value = tplLoad('notify_tpl_signal', TPL_DEFAULTS.signal);
		tplMemInput.value = tplLoad('notify_tpl_memory', TPL_DEFAULTS.memory);
		tplBatchInput.value = tplLoad('notify_tpl_batch', TPL_DEFAULTS.batch);
		tplQqSmsInput.value = tplLoad('notify_tpl_qq_sms_md', TPL_DEFAULTS.qq_sms_md);

		/* ---------- 保存（OpenWrt 标准「保存并应用」流程） ----------
		 *
		 * 修复（问题一）：
		 *  - 变更先只写 UCI 内存，页面立刻标记「未保存更改」，离开时浏览器会拦截；
		 *  - 点击「保存并应用」才走 changes → save → apply 完整链路，apply 成功即
		 *    代表 procd reload trigger 已生效（at-webserver 有 procd_add_reload_trigger）；
		 *  - 无待应用变更（ubus NO_DATA）视为成功，不再误报「保存失败」。
		 */
		var saveStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var saveBtn = Mt5700.primaryButton('保存并应用', function () {
			var set = function (key, value) {
				L.uci.set('at-webserver', 'config', key, value);
			};
			var ifaceV4 = ifaceValue(ifaceV4Sel, ifaceV4Custom, false);
			var ifaceV6 = ifaceValue(ifaceV6Sel, ifaceV6Custom, true);
			if (ifaceV4 == null || ifaceV6 == null) {
				Mt5700.error('承载接口名只能包含字母、数字和下划线');
				return;
			}
			set('connection_type', connTypeSel.value);
			set('network_host', hostInput.value.trim() || '192.168.8.1');
			set('network_port', String(parseInt(netPortInput.value, 10) || 20249));
			var serialVal = serialSel.value;
			if (serialVal === '__custom__') {
				serialVal = serialCustom.value.trim() || 'auto';
			}
			set('serial_port', serialVal || 'auto');
			set('serial_baudrate', String(parseInt(baudInput.value, 10) || 115200));
			set('manage_interface', manageIfaceChk.checked ? '1' : '0');
		set('iface_v4', ifaceV4);
		set('iface_v6', ifaceV6);
		/* 默认 DNS：留空是合法的（表示「不写这一条」），所以不做非空回落 */
		set('dns_enable', dnsEnableChk.checked ? '1' : '0');
		set('dns_v4_1', dnsV4A.value.trim());
		set('dns_v4_2', dnsV4B.value.trim());
		set('dns_v6_1', dnsV6A.value.trim());
		set('dns_v6_2', dnsV6B.value.trim());
		set('dns_exclusive', dnsExclChk.checked ? '1' : '0');
			set('websocket_port', String(parseInt(wsPortInput.value, 10) || 8765));
			var bind = wsBindSel.value === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
			set('websocket_bind', bind);
			set('websocket_allow_wan', bind === '0.0.0.0' ? '1' : '0');
			set('websocket_auth_key', authKeyInput.value.trim());
			set('schedule_enabled', schedChk.checked ? '1' : '0');
			set('wallpaper_enabled', wallpaperChk.checked ? '1' : '0');
			set('notify_enabled', notifyMaster.input.checked ? '1' : '0');
			set('notify_call', notifyCalls.input.checked ? '1' : '0');
			set('notify_sms', notifySms.input.checked ? '1' : '0');
			set('notify_signal', notifySignal.input.checked ? '1' : '0');
			set('notify_memory_full', notifyMem.input.checked ? '1' : '0');
			set('wechat_enabled', wechatChk.input.checked ? '1' : '0');
			set('wechat_webhook', webhookInput.value.trim());
			set('qq_enabled', qqChk.input.checked ? '1' : '0');
			set('qq_app_id', qqAppIdInput.value.trim());
			set('qq_app_secret', qqSecretInput.value.trim());
			set('qq_target_type', qqTargetSel.value);
			set('qq_bind_qq', qqBindInput.value.trim());
			set('qq_target_id', qqTargetIdInput.value.trim());
			set('qq_msg_format', qqFormatSel.value);
			set('qq_keyboard_enabled', qqKbChk.input.checked ? '1' : '0');
			set('qq_keyboard_url', qqKbUrlInput.value.trim());
			set('qq_menu_enabled', qqMenuChk.input.checked ? '1' : '0');
			var timerMin = parseInt(notifyTimerInput.value, 10) || 10;
			timerMin = Math.min(1440, Math.max(1, timerMin));
			set('notify_timer_interval', String(timerMin));
			/* 旧键 notify_interval（合并窗口秒数）已废弃：置空，
			 * 免得 UCI 里留着一个不再生效的「推送频率」让人以为它还在控制推送。 */
			set('notify_interval', '');
			set('notify_poll_enabled', pollEnable.input.checked ? '1' : '0');
			/* time 输入在部分浏览器上允许留空，留空时回落到默认时段而不是写空值：
			 * 空值会让后端走「格式非法 → 全天」的回落路径，虽然结果相同，
			 * 但界面上会留下一个空输入框，下次打开容易被误读成「没配置」。 */
			set('notify_poll_start', pollStartInput.value || '00:00');
			set('notify_poll_end', pollEndInput.value || '23:59');
			set('notify_poll_interval', String(parseInt(pollIntervalInput.value, 10) || 300));
			set('notify_poll_all', pollModeSel.value === 'always' ? '1' : '0');
			set('notify_poll_delta', String(parseInt(pollDeltaInput.value, 10) || 3));
			/* 频率闸门与 QQ 节流：夹取到各自范围，空值按默认（60 分钟 / 10 条）。
			 * 这里刻意不「顺手」清掉旧值 —— 用户填 0 是明确的「我要不限频」，照写。 */
			var rateMin = parseInt(rateMinInput.value, 10);
			if (isNaN(rateMin) || rateMin < 0) rateMin = 60;
			set('notify_signal_min_interval', String(Math.min(10080, rateMin)));
			var qqRate = parseInt(qqRateInput.value, 10);
			if (isNaN(qqRate) || qqRate < 0) qqRate = 10;
			set('qq_max_per_minute', String(Math.min(60, qqRate)));
			set('notify_tpl_prefix', tplToUci(tplPrefixInput.value));
			set('notify_tpl_sms', tplToUci(tplSmsInput.value));
			set('notify_tpl_call', tplToUci(tplCallInput.value));
			set('notify_tpl_signal', tplToUci(tplSignalInput.value));
			set('notify_tpl_memory', tplToUci(tplMemInput.value));
			set('notify_tpl_batch', tplToUci(tplBatchInput.value));
			set('notify_tpl_qq_sms_md', tplToUci(tplQqSmsInput.value));

			// 写内存后立刻标脏，未点保存就离开会被浏览器拦截
			AtWs.uci.markDirty();
			saveBtn.disabled = true;
			saveStatus.textContent = '正在保存并应用…';

			AtWs.uci.uciSave(SERVICE).then(function (res) {
				AtWs.uci.clearDirty();
				if (res.appliedSkipped) {
					saveStatus.textContent = '配置已应用（无待处理的变更）';
				} else {
					saveStatus.textContent = '配置已保存并应用';
				}
				Mt5700.success('配置已保存并应用');
				return reloadService();
			}).catch(function (err) {
				var msg = (err && err.message) || '未知错误';
				saveStatus.textContent = '保存失败：' + msg;
				Mt5700.error('保存失败：' + msg);
			}).then(function () {
				saveBtn.disabled = false;
			});
		});

		var bottomActions = Mt5700.panelActions(saveBtn, saveStatus);
		body.appendChild(bottomActions);

		/* ---------- 作者署名（页脚） ----------
		 * Project author attribution: preserve unless explicitly authorized by the
		 * project maintainer. 保护规则见仓库根目录 AGENTS.md「作者署名保护规则」。
		 * 该元素为项目明确要求保留的项目元素：任何 UI 重构、样式调整、组件替换、
		 * 模板重写都必须保留署名文案与其指向仓库的链接。
		 */
		body.appendChild(E('div', { 'class': 'mt5700-author' }, [
			E('span', { 'class': 'mt5700-author-label' }, '作者：'),
			E('a', {
				'class': 'mt5700-author-link',
				'href': 'https://github.com/LianXia233/luci-app-mt5700',
				'target': '_blank',
				'rel': 'noopener noreferrer'
			}, 'LianXia233')
		]));

		// 任何表单控件变更都标记为「未保存」，与 CBI 表单行为对齐
		page.addEventListener('change', function () { AtWs.uci.markDirty(); });
		page.addEventListener('input', function () { AtWs.uci.markDirty(); });

		/* ---------- 服务操作（经 ubus service set，避免 init.d/firewall 阻塞） ---------- */
		var rpcServiceSet = L.rpc.declare({
			object: 'service',
			method: 'set',
			params: ['name', 'instances']
		});
		var rpcServiceDelete = L.rpc.declare({
			object: 'service',
			method: 'delete',
			params: ['name']
		});
		var rpcServiceList = L.rpc.declare({
			object: 'service',
			method: 'list',
			params: ['name'],
			expect: { '': {} }
		});

		// 经 rpcd 的 rc 对象调用 init.d（等价 /etc/init.d/at-webserver <action>）。
		// 这是首选路径：init.d 里内置了开机自启注册自愈，顺带把
		// /etc/rc.d/S99at-webserver 补上，服务重启后仍在。
		var rpcRcInit = L.rpc.declare({
			object: 'rc',
			method: 'init',
			params: ['name', 'action']
		});

		// 直接经 ubus 注册并拉起实例。即使 /etc/init.d/at-webserver 缺失
		// （overlay 白化等）或 rc 调用被拒绝，这条路径依然能把服务跑起来；
		// 但它只做临时实例注册，不补 /etc/rc.d 开机自启链接，仅作兜底。
		function startViaUbus() {
			return rpcServiceSet({
				name: SERVICE,
				instances: {
					instance1: {
						command: [BINARY],
						respawn: ['3600', '5', '5'],
						stdout: true,
						stderr: true
					}
				}
			});
		}

		// 拉取当前实例状态，用于操作后复核，避免「提示成功但实际没起来」
		function fetchRunning() {
			return rpcServiceList(SERVICE).catch(function () { return {}; }).then(function (resp) {
				return scanProcdInstances((resp && resp[SERVICE]) || {});
			});
		}

		function refreshStatus() {
			return Promise.all([
				rpcServiceList(SERVICE).catch(function () { return {}; }),
				L.uci.load(SERVICE)
			]).then(function (res) {
				var svc = (res[0] && res[0][SERVICE]) || {};
				var procd = scanProcdInstances(svc);
				var en = L.uci.get(SERVICE, 'config', 'enabled');
				state.running = procd.running;
				state.pid = procd.pid;
				state.registered = !!(res[0] && res[0][SERVICE]);
				state.enabled = (en === null || en === undefined) ? '1' : String(en);

				var st = resolveStatus(state);
				statusRow.innerHTML = '';
				statusRow.appendChild(Mt5700.badge(st.label, st.variant));
				if (st.pid) statusRow.appendChild(Mt5700.badge('PID ' + st.pid, 'neutral'));
			});
		}

		function reloadService() {
			reloadBtn.disabled = true;
			return rpcServiceDelete({ name: SERVICE }).catch(function () {
				/* 实例可能不存在，删除失败不致命 */
			}).then(function () {
				// 首选 init.d 路径：能顺带补建 /etc/rc.d 开机自启链接，避免重启后复发。
				return rpcRcInit({ name: SERVICE, action: 'start' }).catch(function () {
					// init.d 不可用（脚本缺失/异常，或 rpcd rc 未被授权）时回退到 ubus 直连
					return startViaUbus();
				});
			}).then(function () {
				// 等 procd 完成拉起，再复核一次真实状态
				return new Promise(function (resolve) { window.setTimeout(resolve, 1200); });
			}).then(function () {
				return fetchRunning();
			}).then(function (st) {
				if (st.running) {
					Mt5700.success('服务已重载' + (st.pid ? '（PID ' + st.pid + '）' : ''));
				} else {
					Mt5700.warning('已下发启动指令，但未检测到运行中的进程，请查看系统日志确认原因');
				}
				return refreshStatus();
			}).catch(function (err) {
				Mt5700.error('重载失败：' + ((err && err.message) || '未知错误'));
			}).then(function () {
				reloadBtn.disabled = false;
			});
		}

		function restartService() {
			Mt5700.confirm('确定重启 AT 服务？现有 RPC 调用将短暂中断。', function () {
				restartBtn.disabled = true;
				reloadService().then(function () {
					restartBtn.disabled = false;
				});
			});
		}

		/* 探活 + 降级提示：与其他页使用同一入口，保证「后端未就绪」在这里也是
		 * 同一条悬浮提示条（固定定位、可关闭、恢复后自动消失），而不是本页
		 * 独有的「已停止」文字。onReady 传 null —— 本页数据全走 ubus，
		 * 不依赖 AT 通道，无需在恢复时重新拉取。 */
		Ui.startup(page, null);

		return page;
	}
});
