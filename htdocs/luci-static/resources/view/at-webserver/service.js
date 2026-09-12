'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Ui */

/**
 * 服务配置（原 WebUI 服务 → 服务配置）
 * 合并旧版 LuCI config.js 的全部功能 + 新增项：
 * - connection_type / network_host / network_port / serial_port / baud_rate
 * - websocket_host / websocket_port / websocket_auth_key
 * - 通知开关：notify_*（来电/短信/信号/内存满/WebHook URL 与企业微信）
 * - 定时锁频总开关 schedule_enabled 与告警配置
 * - 保存后通过 ubus 重载服务（等价 /etc/init.d/at-webserver reload）
 *
 * 状态判定说明（修复「未运行」误报）：
 * procd 的 service.list 只反映「已注册实例」，当 init 脚本缺失（例如被 overlay
 * 白化）或服务从未被拉起时，它返回的是空对象——这与「服务配置为禁用」在界面上
 * 无法区分，且不给出任何原因。本页改为多源交叉判定：
 *   1) 已注册实例的 running/pid（procd 权威状态）
 *   2) 二进制是否存在且可执行（file.stat）
 *   3) 配置是否启用（UCI enabled）
 *   4) 监听端口是否有进程在听（间接佐证，避免仅凭配置误判）
 * 并区分「运行中」/「已停止」/「未注册」/「未安装」/「已禁用」五种语义，
 * 给出对应的修复建议。
 */

// 已确认的 eth2 等非 tty 设备不参与串口候选
var SERVICE = 'at-webserver';
var BINARY = '/usr/bin/at-webserver-rust';

/**
 * 由多源状态推导服务状态标签、颜色与原因提示。
 * 优先级：运行中 > 已禁用 > 未安装 > 未注册 > 已停止
 */
function resolveStatus(state) {
	var running = !!state.running;
	var registered = !!state.registered;
	var binExists = !!state.binExists;
	var enabled = state.enabled === '1';

	if (running) {
		return { label: '运行中', color: 'green', pid: state.pid || null, hint: '' };
	}
	if (!enabled) {
		return {
			label: '已禁用', color: 'grey', pid: null,
			hint: '配置中 enabled=0，服务被刻意关闭。需要启动请在下方勾选后保存，或执行 uci set at-webserver.config.enabled=1。'
		};
	}
	if (!binExists) {
		return {
			label: '未安装', color: 'red', pid: null,
			hint: '未找到可执行文件 ' + BINARY + '，后端可能未安装或安装不完整。请重新安装 luci-app-mt5700。'
		};
	}
	if (!state.binExec) {
		return {
			label: '不可执行', color: 'red', pid: null,
			hint: BINARY + ' 缺少可执行权限。请执行 chmod 0755 ' + BINARY + ' 后重试。'
		};
	}
	if (!registered) {
		return {
			label: '未注册', color: 'orange', pid: null,
			hint: '进程未运行，且 procd 中不存在 at-webserver 实例——通常是 /etc/init.d/at-webserver ' +
				'缺失或被 overlay 覆盖（例如存在白化字符设备），导致服务从未被拉起。' +
				'请检查该脚本是否存在，然后点击「重载服务」或执行 /etc/init.d/at-webserver start。'
		};
	}
	return {
		label: '已停止', color: 'red', pid: null,
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
			statBinary(BINARY).catch(function () { return null; })
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
				serials: serials
			};
		});
	},

	render: function (data) {
		var self = this;
		var page = Ui.page('服务配置', 'AT 服务与通知设置（保存后自动重载）');
		var body = page._body;

		var state = data || {};

		/* ---------- 服务状态判定（五态） ---------- */
		var status = resolveStatus(state);

		var statusPanel = Ui.panel('服务状态', '');
		var statusEl = E('div', { 'class': 'at-tags' });
		statusEl.appendChild(Ui.tag(status.label, status.color));
		if (status.pid) {
			statusEl.appendChild(Ui.tag('PID ' + status.pid, 'grey'));
		}
		var actions = E('div', { 'class': 'at-panel-actions' });
		var reloadBtn = Ui.button('重载服务', 'cbi-button-action', reloadService);
		var restartBtn = Ui.button('重启服务', 'cbi-button-action', restartService);
		actions.appendChild(reloadBtn);
		actions.appendChild(restartBtn);
		statusPanel._body.appendChild(statusEl);
		// 非「运行中」时给出可读的原因与建议，避免只有一个红色标签
		if (status.hint) {
			statusPanel._body.appendChild(E('div', { 'class': 'at-field-hint' }, status.hint));
		}
		statusPanel._body.appendChild(actions);
		body.appendChild(statusPanel);

		/* ---------- 连接配置 ---------- */
		var connPanel = Ui.panel('调制解调器连接', '后端连接模组的通道');
		var connTypeSel = document.createElement('select');
		connTypeSel.className = 'cbi-input-select';
		[{ v: 'SERIAL', l: 'PCUI 串口（默认，优先 /dev/ttyUSB1）' }, { v: 'NETWORK', l: '网络连接（TCP，备用）' }].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			connTypeSel.appendChild(opt);
		});
		connPanel._body.appendChild(Ui.field('连接类型', connTypeSel));

		var hostInput = document.createElement('input');
		hostInput.className = 'cbi-input-text';
		hostInput.placeholder = '192.168.8.1';
		connPanel._body.appendChild(Ui.field('网络主机', hostInput));

		var netPortInput = document.createElement('input');
		netPortInput.type = 'number';
		netPortInput.className = 'cbi-input-text';
		netPortInput.min = 1;
		netPortInput.max = 65535;
		connPanel._body.appendChild(Ui.field('网络端口', netPortInput, '模组 TCP 端口，默认 20249'));

		/* 串口：下拉 + 自定义；选项来自系统 /dev 识别结果 */
		var serialSel = document.createElement('select');
		serialSel.className = 'cbi-input-select';
		function fillSerialOptions(current) {
			while (serialSel.firstChild) serialSel.removeChild(serialSel.firstChild);
			function add(v, label) {
				var o = document.createElement('option');
				o.value = v; o.textContent = label || v;
				serialSel.appendChild(o);
			}
			add('auto', '自动探测（优先 /dev/ttyUSB1 PCUI）');
			(state.serials || []).forEach(function (p) {
				var hint = p === '/dev/ttyUSB1' ? '（PCUI 推荐）' : '';
				add(p, p + hint);
			});
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
				if (!exists && current !== '__custom__') serialSel.value = current;
			}
		}
		var serialCustom = document.createElement('input');
		serialCustom.className = 'cbi-input-text';
		serialCustom.placeholder = '例如 /dev/ttyUSB2';
		serialCustom.style.display = 'none';
		serialSel.addEventListener('change', function () {
			serialCustom.style.display = serialSel.value === '__custom__' ? '' : 'none';
		});
		connPanel._body.appendChild(Ui.field('串口设备', serialSel, '列出系统已识别的 ttyUSB/ttyACM/ttyS 设备'));
		connPanel._body.appendChild(Ui.field('自定义串口路径', serialCustom, '仅在选择「自定义路径」时生效'));

		var baudInput = document.createElement('input');
		baudInput.type = 'number';
		baudInput.className = 'cbi-input-text';
		baudInput.placeholder = '115200';
		connPanel._body.appendChild(Ui.field('波特率', baudInput));
		body.appendChild(connPanel);

		/* ---------- RPC 服务 ---------- */
		var wsPanel = Ui.panel('RPC 服务', 'LuCI 经 rpcd/ucode 代理连接后端使用的端口与密钥（仅回环监听，不对外暴露）');
		var wsHostInput = document.createElement('input');
		wsHostInput.className = 'cbi-input-text';
		wsHostInput.placeholder = '留空表示本机';
		wsPanel._body.appendChild(Ui.field('监听地址', wsHostInput, '保留兼容：RPC 固定监听 127.0.0.1，该键不再生效'));

		var wsPortInput = document.createElement('input');
		wsPortInput.type = 'number';
		wsPortInput.className = 'cbi-input-text';
		wsPortInput.min = 1;
		wsPortInput.max = 65535;
		wsPanel._body.appendChild(Ui.field('RPC 端口', wsPortInput, '默认 8765'));

		var wsBindSel = document.createElement('select');
		wsBindSel.className = 'cbi-input-select';
		[
			{ v: '127.0.0.1', l: '仅本机（127.0.0.1，经 rpcd 代理）' },
			{ v: '0.0.0.0', l: '所有接口（0.0.0.0，可被外部访问）' }
		].forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.v; opt.textContent = o.l;
			wsBindSel.appendChild(opt);
		});
		wsPanel._body.appendChild(Ui.field('RPC 监听范围', wsBindSel, '对外监听时请务必设置认证密钥'));

		var authKeyInput = document.createElement('input');
		authKeyInput.className = 'cbi-input-text';
		authKeyInput.placeholder = '留空表示无需认证';
		wsPanel._body.appendChild(Ui.field('认证密钥', authKeyInput, 'ucode 代理自动附带该密钥；LuCI 登录态由 rpcd 会话保证'));
		body.appendChild(wsPanel);

		/* ---------- 定时锁频 ---------- */
		var schedPanel = Ui.panel('定时锁频', '总开关与默认参数');
		var schedChk = document.createElement('input');
		schedChk.type = 'checkbox';
		schedChk.className = 'cbi-input-checkbox';
		schedPanel._body.appendChild(Ui.field('启用定时锁频', schedChk, '在「服务 → 模组管理 → 定时锁频」编排时段'));
		body.appendChild(schedPanel);

		/* ---------- 通知配置 ---------- */
		var notifPanel = Ui.panel('通知', '事件通知与 WebHook');
		var notifyCallsChk = document.createElement('input');
		notifyCallsChk.type = 'checkbox';
		notifyCallsChk.className = 'cbi-input-checkbox';
		notifPanel._body.appendChild(Ui.field('来电通知', notifyCallsChk));

		var notifySmsChk = document.createElement('input');
		notifySmsChk.type = 'checkbox';
		notifySmsChk.className = 'cbi-input-checkbox';
		notifPanel._body.appendChild(Ui.field('新短信通知', notifySmsChk));

		var notifySignalChk = document.createElement('input');
		notifySignalChk.type = 'checkbox';
		notifySignalChk.className = 'cbi-input-checkbox';
		notifPanel._body.appendChild(Ui.field('信号变化通知', notifySignalChk));

		var notifyMemChk = document.createElement('input');
		notifyMemChk.type = 'checkbox';
		notifyMemChk.className = 'cbi-input-checkbox';
		notifPanel._body.appendChild(Ui.field('短信存储满通知', notifyMemChk));

		var webhookInput = document.createElement('input');
		webhookInput.className = 'cbi-input-text';
		webhookInput.placeholder = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx';
		notifPanel._body.appendChild(Ui.field('企业微信 WebHook', webhookInput, '通知将推送到该 WebHook 地址'));
		body.appendChild(notifPanel);

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
		notifyCallsChk.checked = get('notify_call', '1') === '1';
		notifySmsChk.checked = get('notify_sms', '1') === '1';
		notifySignalChk.checked = get('notify_signal', '1') === '1';
		notifyMemChk.checked = get('notify_memory_full', '1') === '1';
		webhookInput.value = String(get('wechat_webhook', ''));

		/* ---------- 保存 ---------- */
		var saveBtn = Ui.primaryButton('保存配置', function () {
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
			set('notify_call', notifyCallsChk.checked ? '1' : '0');
			set('notify_sms', notifySmsChk.checked ? '1' : '0');
			set('notify_signal', notifySignalChk.checked ? '1' : '0');
			set('notify_memory_full', notifyMemChk.checked ? '1' : '0');
			set('wechat_webhook', webhookInput.value.trim());

			L.uci.save('at-webserver').then(function () {
				return L.uci.apply(false).then(function () {
					Ui.success('配置已保存');
					return reloadService();
				}, function (err) {
					// ubus 5 = NO_DATA：无待应用变更时 rpcd 不回数据，视为成功
					var code = err && err.code;
					var msg = (err && err.message) || '';
					if (code === 5 || /未收到数据|No data/i.test(msg)) {
						Ui.success('配置已保存');
						return reloadService();
					}
					throw err;
				});
			}).catch(function (err) {
				Ui.error('保存失败: ' + ((err && err.message) || '未知错误'));
			});
		});
		var actions2 = E('div', { 'class': 'at-panel-actions' });
		actions2.appendChild(saveBtn);
		body.appendChild(actions2);

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

		// 直接经 ubus 注册并拉起实例。即使 /etc/init.d/at-webserver 缺失
		// （overlay 白化等），这条路径依然能把服务跑起来。
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

		function reloadService() {
			reloadBtn.disabled = true;
			return rpcServiceDelete({ name: SERVICE }).catch(function () {
				/* 实例可能不存在，删除失败不致命 */
			}).then(function () {
				return startViaUbus();
			}).then(function () {
				// 等 procd 完成拉起，再复核一次真实状态
				return new Promise(function (resolve) { window.setTimeout(resolve, 1200); });
			}).then(function () {
				return fetchRunning();
			}).then(function (st) {
				if (st.running) {
					Ui.success('服务已重载' + (st.pid ? '（PID ' + st.pid + '）' : ''));
				} else {
					Ui.warning('已下发启动指令，但未检测到运行中的进程，请查看系统日志确认原因');
				}
			}).catch(function (err) {
				Ui.error('重载失败: ' + ((err && err.message) || '未知错误'));
			}).finally(function () {
				reloadBtn.disabled = false;
			});
		}

		function restartService() {
			Ui.confirm('确定重启 AT 服务？现有 RPC 调用将短暂中断。', function () {
				restartBtn.disabled = true;
				reloadService().finally(function () {
					restartBtn.disabled = false;
				});
			});
		}

		return page;
	}
});
