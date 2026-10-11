'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700 */

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
			listSerial(BY_ID_DIR).catch(function () { return { entries: [] }; })
		]).then(function (res) {
			var raw = res[2];
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
				var list = [];
				if (Array.isArray(r)) {
					list = r;
				} else if (r && Array.isArray(r.entries)) {
					list = r.entries;
				} else if (r && typeof r === 'object') {
					Object.keys(r).forEach(function (k) {
						var v = r[k];
						if (v && typeof v === 'object') {
							list.push(Object.assign({ name: k }, v));
						} else {
							list.push({ name: k, type: String(v || '') });
						}
					});
				}
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
			var found = false;
			var pid = null;
			if (svc.instances) {
				Object.keys(svc.instances).forEach(function (k) {
					var it = svc.instances[k] || {};
					if (it.running || it.pid) {
						found = true;
						if (!pid && it.pid) pid = it.pid;
					}
				});
			}
			if (!found && (svc.running || svc.pid)) {
				found = true;
				pid = svc.pid || null;
			}

			var st = res[3];
			// rpcd file.stat 返回 {type:'file', mode:0755, ...}；失败时返回 null
			var binExists = !!(st && (st.type || st.mode !== undefined));
			var binExec = binExists && !!(st.mode & parseInt('0111', 8));

			var enabled = L.uci.get(SERVICE, 'config', 'enabled');
			enabled = enabled === null || enabled === undefined ? '1' : String(enabled);

			return {
				service: svc,
				running: found,
				registered: registered,
				pid: pid,
				binExists: binExists,
				binExec: binExec,
				enabled: enabled,
				serials: serials,
				byIdSerials: byIdEntries
			};
		});
	},

	render: function (data) {
		var self = this;
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
		var connBody = E('div');
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
					// if12 = PC UI Interface（AT 口），是本插件最常用的那个
					var hint = /-if12(-|$)/.test(p) ? '（PCUI / AT 口）' : '';
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
		serialCustom.style.display = 'none';
		serialSel.addEventListener('change', function () {
			serialCustom.style.display = serialSel.value === '__custom__' ? '' : 'none';
		});
		connBody.appendChild(Mt5700.formGroup('串口设备', serialSel,
			'优先选「稳定路径」分组：它由 VID:PID 与接口描述符生成，换 USB 口或重启后路径不变；' +
			'「内核编号」分组在插口变化时会整体平移，仅作回退。'));
		connBody.appendChild(Mt5700.formGroup('自定义串口路径', serialCustom, '仅在选择「自定义路径」时生效'));

		var baudInput = Mt5700.input('number', '115200', '');
		connBody.appendChild(Mt5700.formGroup('波特率', baudInput));

		/* ---------- RPC 服务 ---------- */
		var wsCard = Mt5700.card('RPC 服务', 'LuCI 经 rpcd/ucode 代理连接后端使用的端口与密钥（仅回环监听，不对外暴露）');
		var wsBody = E('div');
		wsCard._body.appendChild(wsBody);
		rowConn.appendChild(wsCard);

		var wsHostInput = Mt5700.input('text', '留空表示本机', '');
		wsBody.appendChild(Mt5700.formGroup('监听地址', wsHostInput, '保留兼容：RPC 固定监听 127.0.0.1，该键不再生效'));

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
		var notifBody = E('div');
		notifCard._body.appendChild(notifBody);
		body.appendChild(notifCard);

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

		var pollBox = E('div', { 'class': 'mt5700-poll-box' });
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

		/* 控件联动：总开关是根，巡检开关次之，阈值只对「仅变化时推送」有意义。
		 * 置灰后控件不再响应输入，用户一眼能看出哪些项当前不起作用。 */
		function syncPollState() {
			var masterOn = notifyMaster.input.checked;
			var pollOn = masterOn && pollEnable.input.checked;
			[pollStartInput, pollEndInput, pollIntervalInput, pollModeSel].forEach(function (el) {
				el.disabled = !pollOn;
			});
			pollDeltaInput.disabled = !pollOn || pollModeSel.value !== 'change';
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
		notifBody.appendChild(Mt5700.formGroup('QQ 机器人 AppID', qqAppIdInput, '也可用环境变量 QQ_BOT_APP_ID 覆盖'));
		notifBody.appendChild(Mt5700.formGroup('QQ 机器人 AppSecret', qqSecretInput, '建议留空并经环境变量 QQ_BOT_APP_SECRET 注入，避免凭据落盘 UCI'));
		notifBody.appendChild(Mt5700.formGroup('QQ 推送目标类型', qqTargetSel, '选「绑定」：保存并应用后，用你的 QQ 给机器人发一条消息即自动完成绑定'));
		notifBody.appendChild(Mt5700.formGroup('绑定 QQ 号', qqBindInput, '仅用于日志标识（平台事件里拿不到 QQ 号），openid 由后端自动抓取'));
		notifBody.appendChild(Mt5700.formGroup('QQ 推送目标 ID', qqTargetIdInput, '绑定模式留空即可；手动模式填 openid（非 QQ 号）'));

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
			if (String(get('wechat_webhook', '')) !== '') channels.push('wechat');
			if (String(get('qq_target_type', '')) === 'bind' || String(get('qq_app_id', '')) !== '') channels.push('qq');
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
		notifBody.appendChild(E('div', { 'class': 'mt5700-form-group' }, E('strong', {}, '绑定进度：'), bindStatusLine));
		var bindState = '';
		var bindTimer = setInterval(function () {
			/* 页面已卸载时停止轮询 */
			if (!bindStatusLine.isConnected) { clearInterval(bindTimer); return; }
			qqBindStatus('bind-' + Date.now()).then(function (res) {
				if (!res) return;
				bindState = String(res.state || 'idle');
				var left = parseInt(res.left, 10) || 0;
				var isBind = String(get('qq_target_type', '')) === 'bind' || qqTargetSel.value === 'bind';
				if (bindState === 'waiting') {
					bindStatusLine.textContent = '等待绑定：用你的 QQ 给机器人发一条消息即可完成（剩余 ' + left + ' 秒，超时后重启服务自动重试）';
				} else if (bindState === 'success') {
					var tid = String(res.target_id || '');
					bindStatusLine.textContent = '绑定成功：目标 ' + (res.target_type || '') + ' ' + (tid.length > 12 ? tid.slice(0, 12) + '…' : tid) + '（已写回 UCI 并生效）';
				} else if (bindState === 'failed') {
					bindStatusLine.textContent = '绑定失败：' + (res.error || '未知原因') + '（下次服务重启自动重试）';
				} else if (isBind) {
					bindStatusLine.textContent = '已配置绑定模式：保存并应用后开始等待消息';
				} else {
					bindState = '';
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
		var tplBody = E('div');
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
		var tplBatchInput = Mt5700.input('text', '批量通知汇总', '');

		var PLACEHOLDER_HINT =
			'可用占位符：{sender} 发送者 · {content} 事件正文 · {time} 事件时刻 · ' +
			'{kind} 事件类型（新短信 / 来电 / 信号变化 / 存储空间已满） · {count} 本条消息合并的条数；' +
			'未识别的占位符会原样保留。';

		tplBody.appendChild(Mt5700.formGroup('前缀（所有推送消息最前面）', tplPrefixInput,
			'支持 {time} 与 {count}；留空则不添加前缀。测试通知也会带上它，便于一次性验证。'));
		tplBody.appendChild(Mt5700.formGroup('新短信', tplSmsInput, PLACEHOLDER_HINT));
		tplBody.appendChild(Mt5700.formGroup('来电', tplCallInput, PLACEHOLDER_HINT));
		tplBody.appendChild(Mt5700.formGroup('信号变化', tplSignalInput, PLACEHOLDER_HINT));
		tplBody.appendChild(Mt5700.formGroup('短信存储满', tplMemInput, PLACEHOLDER_HINT));
		tplBody.appendChild(Mt5700.formGroup('批量汇总标题', tplBatchInput,
			'合并窗口已于 v1.14.20 移除，不再有「多条事件合并成一条」的场景；' +
			'此项保留仅为兼容已有配置，当前不会被触发。'));

		/* 内置默认文案：必须与 Rust 侧 config.rs 的 DEFAULT_TPL_* 保持一致。
		 * 仅用于「恢复默认文案」按钮与初始回填，后端始终以自己的默认为准。 */
		var TPL_DEFAULTS = {
			prefix: '',
			sms: '喵呜～，有新短信到啦！快来看看是谁给你发消息了喵~\n发送者: {sender}\n内容: {content}',
			call: '喵呜～有电话打进来啦，快接起来看看是谁找你喵！\n{content}',
			signal: '{content}',
			memory: '喵呜～短信存储空间已经满啦，请尽快清理一下喵，不然可能收不到新的短信了哦！',
			batch: '喵～有一批新通知需要查看哦，快来看看都有哪些消息吧！'
		};

		var tplStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var tplResetBtn = Mt5700.button('恢复默认文案', function () {
			tplPrefixInput.value = TPL_DEFAULTS.prefix;
			tplSmsInput.value = TPL_DEFAULTS.sms;
			tplCallInput.value = TPL_DEFAULTS.call;
			tplSignalInput.value = TPL_DEFAULTS.signal;
			tplMemInput.value = TPL_DEFAULTS.memory;
			tplBatchInput.value = TPL_DEFAULTS.batch;
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
		wsHostInput.value = '';
		wsPortInput.value = String(get('websocket_port', '8765'));
		var bindCur = get('websocket_bind', '');
		if (!bindCur) {
			bindCur = get('websocket_allow_wan', '0') === '1' ? '0.0.0.0' : '127.0.0.1';
		}
		wsBindSel.value = bindCur === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
		authKeyInput.value = String(get('websocket_auth_key', ''));
		schedChk.checked = get('schedule_enabled', '0') === '1';
		notifyMaster.input.checked = get('notify_enabled', '1') === '1';
		notifyCalls.input.checked = get('notify_call', '1') === '1';
		notifySms.input.checked = get('notify_sms', '1') === '1';
		notifySignal.input.checked = get('notify_signal', '1') === '1';
		notifyMem.input.checked = get('notify_memory_full', '1') === '1';
		webhookInput.value = String(get('wechat_webhook', ''));
		qqAppIdInput.value = String(get('qq_app_id', ''));
		qqSecretInput.value = String(get('qq_app_secret', ''));
		qqTargetSel.value = String(get('qq_target_type', 'group'));
		qqBindInput.value = String(get('qq_bind_qq', ''));
		qqTargetIdInput.value = String(get('qq_target_id', ''));
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
		/* 载入完成后按当前值同步一次置灰状态 */
		syncNotifyState();
		tplPrefixInput.value = tplFromUci(String(get('notify_tpl_prefix', '')));
		tplSmsInput.value = tplLoad('notify_tpl_sms', TPL_DEFAULTS.sms);
		tplCallInput.value = tplLoad('notify_tpl_call', TPL_DEFAULTS.call);
		tplSignalInput.value = tplLoad('notify_tpl_signal', TPL_DEFAULTS.signal);
		tplMemInput.value = tplLoad('notify_tpl_memory', TPL_DEFAULTS.memory);
		tplBatchInput.value = tplLoad('notify_tpl_batch', TPL_DEFAULTS.batch);

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
			set('connection_type', connTypeSel.value);
			set('network_host', hostInput.value.trim() || '192.168.8.1');
			set('network_port', String(parseInt(netPortInput.value, 10) || 20249));
			var serialVal = serialSel.value;
			if (serialVal === '__custom__') {
				serialVal = serialCustom.value.trim() || 'auto';
			}
			set('serial_port', serialVal || 'auto');
			set('serial_baudrate', String(parseInt(baudInput.value, 10) || 115200));
			set('websocket_port', String(parseInt(wsPortInput.value, 10) || 8765));
			var bind = wsBindSel.value === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
			set('websocket_bind', bind);
			set('websocket_allow_wan', bind === '0.0.0.0' ? '1' : '0');
			set('websocket_auth_key', authKeyInput.value.trim());
			set('schedule_enabled', schedChk.checked ? '1' : '0');
			set('notify_enabled', notifyMaster.input.checked ? '1' : '0');
			set('notify_call', notifyCalls.input.checked ? '1' : '0');
			set('notify_sms', notifySms.input.checked ? '1' : '0');
			set('notify_signal', notifySignal.input.checked ? '1' : '0');
			set('notify_memory_full', notifyMem.input.checked ? '1' : '0');
			set('wechat_webhook', webhookInput.value.trim());
			set('qq_app_id', qqAppIdInput.value.trim());
			set('qq_app_secret', qqSecretInput.value.trim());
			set('qq_target_type', qqTargetSel.value);
			set('qq_bind_qq', qqBindInput.value.trim());
			set('qq_target_id', qqTargetIdInput.value.trim());
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
			set('notify_tpl_prefix', tplToUci(tplPrefixInput.value));
			set('notify_tpl_sms', tplToUci(tplSmsInput.value));
			set('notify_tpl_call', tplToUci(tplCallInput.value));
			set('notify_tpl_signal', tplToUci(tplSignalInput.value));
			set('notify_tpl_memory', tplToUci(tplMemInput.value));
			set('notify_tpl_batch', tplToUci(tplBatchInput.value));

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
				var svc = (resp && resp[SERVICE]) || {};
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
				return { running: running, pid: pid };
			});
		}

		function refreshStatus() {
			return Promise.all([
				rpcServiceList(SERVICE).catch(function () { return {}; }),
				L.uci.load(SERVICE)
			]).then(function (res) {
				var svc = (res[0] && res[0][SERVICE]) || {};
				var found = false;
				var pid = null;
				if (svc.instances) {
					Object.keys(svc.instances).forEach(function (k) {
						var it = svc.instances[k] || {};
						if (it.running || it.pid) {
							found = true;
							if (!pid && it.pid) pid = it.pid;
						}
					});
				}
				var en = L.uci.get(SERVICE, 'config', 'enabled');
				state.running = found;
				state.pid = pid;
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

		return page;
	}
});
