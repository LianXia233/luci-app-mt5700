'use strict';
'require fs';
'require uci';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700 */

/**
 * 通知日志 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * - 读取 UCI log_file（默认 /tmp/at-notifications.log，回退 /var/log/at-notifications.log）
 * - 显示最近 300 行，单色文本风格
 * - 清空日志（L.fs.write，失败降级 ubus file.write）
 * - 10 秒自动刷新
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
		var page = Mt5700.page('通知日志', '短信、来电、信号变化等通知记录');
		var body = page._body;

		var path = (data && data.path) || '/tmp/at-notifications.log';

		var logCard = Mt5700.card('通知日志', '文件：' + path);
		var logBody = E('div');
		logCard._body.appendChild(logBody);
		body.appendChild(logCard);

		var consoleEl = E('pre', { 'class': 'mt5700-terminal-log' }, '加载中…');
		logBody.appendChild(consoleEl);

		var fileRead = L.rpc.declare({
			object: 'file',
			method: 'read',
			params: ['path'],
			expect: { data: '' }
		});
		var fileWrite = L.rpc.declare({
			object: 'file',
			method: 'write',
			params: ['path', 'data'],
			expect: {}
		});

		// L.fs 在部分 LuCI 版本被移除，缺失时降级到 rpcd 的 file 插件
		function readFile(p) {
			if (L.fs && typeof L.fs.read === 'function') return L.fs.read(p);
			return fileRead(p).then(function (r) { return (r && r.data != null) ? r.data : ''; });
		}

		function writeFile(p, content) {
			if (L.fs && typeof L.fs.write === 'function') return L.fs.write(p, content);
			return fileWrite(p, content);
		}

		var actions = Mt5700.panelActions(
			Mt5700.primaryButton('刷新', function () { refreshLog(); }),
			Mt5700.dangerButton('清空日志', function () { clearLog(); })
		);
		logBody.appendChild(actions);

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
			return readFile(path).then(function (content) {
				renderLog(content, 'ok');
			}).catch(function (err) {
				var msg = (err && err.message) || 'failed';
				// 后端尚未写入过通知时日志文件不存在，这不算错误，按空日志展示
				if (/未找到资源|Not found|No such file|ENOENT/.test(msg)) {
					renderLog('', 'ok');
					return;
				}
				renderLog(msg, 'error');
			});
		}

		function clearLog() {
			Mt5700.confirm('确定清空通知日志？', function () {
				return writeFile(path, '').then(function () {
					Mt5700.success('通知日志已清空');
					refreshLog();
				}).catch(function (err) {
					// 两条通道都试过仍失败才报错
					return fileWrite(path, '').then(function () {
						Mt5700.success('通知日志已清空');
						refreshLog();
					}).catch(function (err2) {
						Mt5700.error('清空失败：' + ((err2 && err2.message) || (err && err.message) || '未知错误'));
					});
				});
			});
		}

		refreshLog();

		// 自动刷新（10 秒）
		var timer = setInterval(refreshLog, 10000);
		self._dispose = function () { clearInterval(timer); };

		return page;
	}
});
