// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require at-webserver/rpc';
'require at-webserver/mt5700';
/* 本页是插件里唯一不依赖 ui.js 的视图（配置全走 ubus/rpcd），但「后端未就绪」
 * 提示条这个**插件级组件**必须每页都有 —— 保存与重载都要 at-webserver 起来才
 * 有效，连不上时正是最需要提示的场景。样式见 global.css，注入见 mt5700.js。 */
'require at-webserver/ui';
/* 配置模块化：各功能拆成独立模块，通过统一响应式抽屉分别打开。 */
'require at-webserver/config-common';
'require at-webserver/config-drawer';
'require at-webserver/config-connection';
'require at-webserver/config-network';
'require at-webserver/config-notify';
'require at-webserver/config-templates';
/* global L, E, AtWs, Mt5700, Ui, MtConfigCommon, MtConfigDrawer,
 * MtConfigConnection, MtConfigNetwork, MtConfigNotify, MtConfigTemplates */

/*
 * 服务配置页面（模块化编排层）。
 *
 * 本页原先在一个 render 里平铺了全部配置控件（连接 / RPC / DNS / 定时锁频 /
 * 通知 / 文案等），彼此共享状态、共用一个「保存并应用」，改动极易相互覆盖。
 * 现在改为「模块化入口 + 独立弹窗」：
 *   - 每个配置功能是一个独立模块（at-webserver/config-*.js），自带控件、状态、
 *     校验、读写与联动，只写自己负责的 UCI 键；
 *   - 主页面只渲染入口卡片与实时服务状态；点击「配置」打开统一响应式抽屉
 *     （PC 右侧抽屉 / 移动端底部面板），每个模块独立打开、编辑、保存、取消；
 *   - 公共逻辑（UCI 读写、夹取、时间校验、模板转义）收敛到 config-common.js；
 *   - 抽屉交互（防误触、ESC、未保存二次确认、焦点/滚动、防重复提交）统一在
 *     config-drawer.js。
 *
 * 配置项清单、默认值与业务逻辑完全不变；作者署名（项目明确要求保留）仍在页脚。
 */

var SERVICE = 'at-webserver';
var BINARY = '/usr/bin/at-webserver-rust';

/* /dev/serial/by-id 稳定符号链接目录（与 Rust 侧 BY_ID_DIR 及 init.d 保持一致）。 */
var BY_ID_DIR = '/dev/serial/by-id';

/** 扫描 procd service.list 响应里的实例运行状态（load/fetchRunning/refreshStatus 三处共用）。 */
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

/** 归一化 rpcd file.list 应答：兼容数组 / {entries} / {name: type} 映射三种形态。 */
function normalizeFileList(raw) {
	var entries = [];
	if (Array.isArray(raw)) {
		entries = raw;
	} else if (raw && Array.isArray(raw.entries)) {
		entries = raw.entries;
	} else if (raw && typeof raw === 'object') {
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

/** 由多源状态推导服务状态标签、颜色与原因提示。 */
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
			hint: '配置中 enabled=0，服务被刻意关闭。需要启动请在「服务状态」卡片执行重载，或执行 uci set at-webserver.config.enabled=1。'
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
			hint: '进程未运行，且 procd 中不存在 at-webserver 实例。点击「重载服务」会自动补注册；'
				+ '也可手动执行 /etc/init.d/at-webserver enable && /etc/init.d/at-webserver start。'
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
			object: 'file', method: 'list', params: ['path'], expect: { entries: [] }
		});
		var statBinary = L.rpc.declare({
			object: 'file', method: 'stat', params: ['path'], expect: {}
		});
		var serviceList = L.rpc.declare({
			object: 'service', method: 'list', params: ['name'], expect: { '': {} }
		});
		return Promise.all([
			L.uci.load(SERVICE),
			serviceList(SERVICE).catch(function () { return {}; }),
			listSerial('/dev').catch(function () { return { entries: [] }; }),
			statBinary(BINARY).catch(function () { return null; }),
			listSerial(BY_ID_DIR).catch(function () { return { entries: [] }; }),
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
			var entries = normalizeFileList(res[2]);
			var serials = [];
			entries.forEach(function (e) {
				var name = e && (e.name || e.path || '');
				if (!name) return;
				name = String(name).replace(/^\/dev\//, '');
				if (/^(ttyUSB|ttyACM|ttyAMA|ttyS)\d+/.test(name)) serials.push('/dev/' + name);
			});
			serials = serials.filter(function (p, i, a) { return a.indexOf(p) === i; });
			serials.sort();

			var byIdEntries = (function () {
				var list = normalizeFileList(res[4]);
				var out = [];
				list.forEach(function (e) {
					var n = e && (e.name || '');
					if (!n) return;
					var t = e && e.type ? String(e.type) : '';
					if (t && t !== 'link' && t !== 'symlink') return;
					out.push(BY_ID_DIR + '/' + String(n).replace(/^.*\//, ''));
				});
				out = out.filter(function (p, i, a) { return a.indexOf(p) === i; });
				out.sort();
				return out;
			})();

			var svc = (res[1] && res[1][SERVICE]) || {};
			var registered = !!(res[1] && res[1][SERVICE]);
			var procd = scanProcdInstances(svc);
			var st = res[3];
			var binExists = !!(st && (st.type || st.mode !== undefined));
			var binExec = binExists && !!(st.mode & parseInt('0111', 8));
			var enabled = L.uci.get(SERVICE, 'config', 'enabled');
			enabled = enabled === null || enabled === undefined ? '1' : String(enabled);

			return {
				running: procd.running, registered: registered, pid: procd.pid,
				binExists: binExists, binExec: binExec, enabled: enabled,
				serials: serials, byIdSerials: byIdEntries, netIfaces: netIfaces
			};
		});
	},

	render: function (data) {
		var page = Mt5700.page('服务配置', 'AT 后台守护进程、串口/TCP 探测与异步通知联动配置', 'service', '守护进程 · 后台服务');
		var body = page._body;
		var state = data || {};
		var status = resolveStatus(state);

		/* ---------- 服务状态卡片（实时状态 + 重载/重启，非配置项） ---------- */
		var statusCard = Mt5700.card('服务状态', 'AT 后台守护进程运行状态');
		var statusBody = E('div');
		statusCard._body.appendChild(statusBody);
		body.appendChild(statusCard);

		var statusRow = E('div', { 'class': 'mt5700-inline' });
		statusRow.appendChild(Mt5700.badge(status.label, status.variant));
		if (status.pid) statusRow.appendChild(Mt5700.badge('PID ' + status.pid, 'neutral'));
		statusBody.appendChild(statusRow);
		if (status.hint) {
			statusBody.appendChild(E('div', { 'class': 'mt5700-hint' }, status.hint));
		}

		/* ---------- 模块化配置入口 ---------- */
		body.appendChild(E('div', { 'class': 'mt5700-card-header' },
			E('h3', { 'class': 'mt5700-card-title' }, '配置模块'),
			E('p', { 'class': 'mt5700-card-subtitle' }, '按功能分别配置，各自独立保存，互不影响')));
		var entryGrid = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		body.appendChild(entryGrid);

		var modules = [
			MtConfigConnection,
			MtConfigNetwork,
			MtConfigNotify,
			MtConfigTemplates
		];
		modules.forEach(function (mod) {
			var m = mod.meta;
			var card = E('div', { 'class': 'mt5700-card' });
			var cb = E('div', { 'class': 'mt5700-card-body' });
			card.appendChild(cb);
			cb.appendChild(E('h3', { 'class': 'mt5700-card-title' }, m.title));
			cb.appendChild(E('p', { 'class': 'mt5700-card-subtitle' }, m.desc));
			cb.appendChild(E('div', { 'class': 'mt5700-panel-actions' },
				Mt5700.button('配置', function () {
					MtConfigDrawer.open({
						title: m.title,
						subtitle: m.desc,
						render: function (bodyEl) {
							return mod.build(bodyEl, { data: state });
						}
					});
				}, 'primary')
			));
			entryGrid.appendChild(card);
		});

		/* ---------- 服务操作按钮（经后端 RPC 调用 init.d，含自愈） ----------
		 * 注意：bottomActions 必须在作者署名之前 append —— 署名固定为页脚最后一项，
		 * author-attribution-test.js 以「署名在 body.appendChild(bottomActions) 之后」为门禁。 */
		var bottomActions = Mt5700.panelActions(
			Mt5700.button('重载服务', function () { reloadService(); }, 'primary'),
			Mt5700.button('重启服务', function () { restartService(); }, 'primary')
		);
		var reloadBtn = bottomActions.firstChild;
		var restartBtn = bottomActions.lastChild;
		body.appendChild(bottomActions);

		/* ---------- 作者署名（页脚，项目明确要求保留，任何 UI 重构都不得移除） ----------
		 * Project author attribution: preserve unless explicitly authorized by the
		 * project maintainer. 保护规则见仓库根目录 AGENTS.md「作者署名保护规则」。 */
		body.appendChild(E('div', { 'class': 'mt5700-author' }, [
			E('a', {
				'class': 'mt5700-author-link',
				'href': 'https://github.com/LianXia233/luci-app-mt5700',
				'target': '_blank',
				'rel': 'noopener noreferrer'
			}, '© 2026 LianXia233 · 开发与维护'),
			E('span', {
				'class': 'mt5700-author-license',
				'title': 'GNU General Public License v3.0 only'
			}, 'GPL-3.0-only')
		]));

		/* 任何表单控件变更都标记为「未保存」，与 CBI 表单行为对齐 */
		page.addEventListener('change', function () { AtWs.uci.markDirty(); });
		page.addEventListener('input', function () { AtWs.uci.markDirty(); });

		/* ---------- 服务操作（经 ubus service set，避免 init.d/firewall 阻塞） ---------- */
		var rpcServiceSet = L.rpc.declare({
			object: 'service', method: 'set', params: ['name', 'instances']
		});
		var rpcServiceDelete = L.rpc.declare({
			object: 'service', method: 'delete', params: ['name']
		});
		var rpcServiceList = L.rpc.declare({
			object: 'service', method: 'list', params: ['name'], expect: { '': {} }
		});
		var rpcRcInit = L.rpc.declare({
			object: 'rc', method: 'init', params: ['name', 'action']
		});

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
				return rpcRcInit({ name: SERVICE, action: 'start' }).catch(function () {
					return startViaUbus();
				});
			}).then(function () {
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

		/* 探活 + 降级提示：与其他页同一入口 */
		Ui.startup(page, null);

		return page;
	}
});
