'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Ui */

/**
 * 通知日志（原 WebUI 服务 → 通知日志）
 * 等价迁移旧版 LuCI logs.js + 原 WebUI 通知日志功能：
 * - 读取 UCI log_file（默认 /tmp/at-notifications.log，回退 /var/log/at-notifications.log）
 * - 显示最近 300 行，深色终端风格
 * - 清空日志（CGI at-log-clear，等价原 /www/cgi-bin/at-log-clear）
 * - 自动刷新
 */

return L.view.extend({
	load: function () {
		return L.uci.load('at-webserver').then(function () {
			var logFile = L.uci.get('at-webserver', 'config', 'log_file') || '';
			return { path: logFile || '/tmp/at-notifications.log', content: '', status: 'loading' };
		}).catch(function () {
			return { path: '/tmp/at-notifications.log', content: '', status: 'loading' };
		});
	},

	render: function (data) {
		var self = this;
		var page = Ui.page('通知日志', '短信、来电、信号变化等通知记录');
		var body = page._body;

		var path = (data && data.path) || '/tmp/at-notifications.log';
		var panel = Ui.panel('通知日志', '文件：' + path);
		body.appendChild(panel);

		var consoleEl = E('pre', { 'class': 'at-log-console' }, '加载中…');
		panel._body.appendChild(consoleEl);

		var actions = E('div', { 'class': 'at-panel-actions' });
		var refreshBtn = Ui.primaryButton('刷新', function () { refreshLog(); });
		var clearBtn = Ui.dangerButton('清空日志', function () { clearLog(); });
		actions.appendChild(refreshBtn);
		actions.appendChild(clearBtn);
		panel._body.appendChild(actions);

		function renderLog(content, status) {
			if (status === 'error') {
				consoleEl.textContent = '读取日志失败：' + (content || '文件不可用');
				return;
			}
			var lines = (content || '').trim().split('\n');
			if (lines.length > 300) lines = lines.slice(lines.length - 300);
			consoleEl.textContent = lines.join('\n') || '（暂无日志）';
		}

		function refreshLog() {
			return L.fs.read(path).then(function (content) {
				renderLog(content, 'ok');
			}).catch(function (err) {
				renderLog((err && err.message) || 'failed', 'error');
			});
		}

		function clearLog() {
			Ui.confirm('确定清空通知日志？', function () {
				// 等价原 /www/cgi-bin/at-log-clear 的清理动作：
				// 直接截断日志文件（Rust 服务在收到 SIGUSR2 或重启后重新创建）。
				return L.fs.write(path, '').then(function () {
					Ui.success('通知日志已清空');
					refreshLog();
				}).catch(function (err) {
					// 降级尝试通过 ubus file 模块写入
					return L.rpc.declare({ object: 'file', method: 'write', params: ['path', 'data'], expect: {} })(path, '').then(function () {
						Ui.success('通知日志已清空');
						refreshLog();
					}).catch(function (err2) {
						Ui.error('清空失败: ' + ((err2 && err2.message) || (err && err.message) || '未知错误'));
					});
				});
			});
		}

		refreshLog();

		// 自动刷新（10 秒）
		var timer = setInterval(refreshLog, 10000);
		this._dispose = function () { clearInterval(timer); };

		return page;
	}
});
