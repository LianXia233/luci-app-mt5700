'use strict';
/**
 * 本地企业微信 webhook 接收端：把「推送到底发出去了什么」变成可断言的证据。
 *
 * 为什么用企业微信通道做本地模拟：
 *   QQ 机器人通道要真实 AppID/Secret 并访问 api.bot.qq.com，本地无法闭环；
 *   企业微信 webhook 只是一个 HTTP POST，把 wechat_webhook 指向本机即可。
 *   两条通道共用同一套 `Notifier::dispatch_body()`，所以「何时发、发什么」
 *   在这里验证通过，对 QQ 通道同样成立（差异只在 QqSender::send 的传输层）。
 *
 * 应答必须是企业微信格式：后端 post_webhook() 会解析响应 JSON 并校验
 * `errcode === 0`，返回别的东西（哪怕 HTTP 200）都会被判为失败并重试 3 次。
 *
 * 用法：node hook-server.js [port] [outFile]
 *   outFile 存在时，每条收到的请求追加一行 JSON，便于事后核对。
 */

const http = require('http');
const fs = require('fs');

function createHookServer(opts) {
	opts = opts || {};
	const received = [];

	const server = http.createServer(function (req, res) {
		let body = '';
		req.on('data', function (c) { body += c; });
		req.on('end', function () {
			let parsed = null;
			try { parsed = JSON.parse(body); } catch (e) { /* 保留原文供排障 */ }

			const record = {
				at: new Date().toISOString(),
				path: req.url,
				body: body,
				/* 企业微信文本消息的正文；非该格式时为 null */
				content: parsed && parsed.text && typeof parsed.text.content === 'string'
					? parsed.text.content : null
			};
			received.push(record);

			if (opts.outFile) {
				try { fs.appendFileSync(opts.outFile, JSON.stringify(record) + '\n'); } catch (e) { /* 落盘失败不影响断言 */ }
			}
			console.log('[hook] ' + req.url + ' ← ' + body.replace(/\r?\n/g, '\\n'));

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
		});
	});

	return {
		received: received,
		listen: function (port) {
			return new Promise(function (resolve, reject) {
				server.once('error', function (err) {
					/* 端口被占用等监听失败必须走 reject：server 的 'error' 事件没人接
					 * 会直接抛成未捕获异常，把整个模拟脚本带崩且看不出是哪一步。 */
					reject(err);
				});
				server.listen(port, '127.0.0.1', function () { resolve(port); });
			});
		},
		close: function () {
			return new Promise(function (resolve) { server.close(function () { resolve(); }); });
		}
	};
}

module.exports = { createHookServer: createHookServer };

if (require.main === module) {
	const port = parseInt(process.argv[2], 10) || 8899;
	const outFile = process.argv[3] || '';
	const h = createHookServer({ outFile: outFile });
	h.listen(port).then(function () {
		console.log('[hook] 监听 127.0.0.1:' + port + (outFile ? '，落盘到 ' + outFile : ''));
	});
}
