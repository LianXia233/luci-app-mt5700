'use strict';
/*
 * rpcd ucode 插件：mt5700 —— LuCI 与 Rust 后端（at-webserver-rust）之间的 RPC 代理。
 *
 * 链路：LuCI JS（L.rpc.declare）→ rpcd → 本 ucode → 127.0.0.1:<websocket_port>（TCP newline-JSON）
 *       → Rust 后端（AT 客户端 / 调度 / 事件总线）
 *
 * 认证：LuCI 登录态由 rpcd 会话/ACL 保证；Rust 侧密钥（websocket_auth_key）由本插件从 UCI
 *       读取并附加到每个请求，保持原配置语义兼容。
 *
 * rpcd 会自动加载 /usr/share/rpcd/ucode/*.uc 并注册返回对象中的 ubus 对象。
 */

const fs = require('fs');
const uci = require('uci');

/*
 * 实时读取 RPC 配置（每次调用都读，改配置无需重启 rpcd）。
 * 注意 UCI 段名：配置都在 `config at-webserver 'config'` 段下，
 * 键是 websocket_port / websocket_auth_key（没有 'websocket' 段）。
 */
function readRpcConfig() {
	const cursor = uci.cursor();
	const port = parseInt(cursor.get('at-webserver', 'config', 'websocket_port'), 10) || 8765;
	const authKey = cursor.get('at-webserver', 'config', 'websocket_auth_key') || '';
	return { port: port, authKey: authKey };
}

function rpcCall(method, params) {
	const rpcCfg = readRpcConfig();
	const port = rpcCfg.port;
	const authKey = rpcCfg.authKey;
	let sock;
	try {
		// 连接带 3s 超时，避免 rpcd worker 被不可达端口拖住
		sock = fs.connect(`127.0.0.1:${port}`, 3000);
	} catch (e) {
		return { success: false, error: 'Rust 后端未运行或端口不可达' };
	}

	const payload = { id: 1, method: method, params: params };
	if (authKey !== '') {
		payload.params.auth_key = authKey;
	}

	try {
		sock.write(JSON.stringify(payload) + '\n');
		// 读取 10s：须覆盖后端命令总超时（AT 2s + 余量 3s ≈ 5s），避免慢命令被误报「无应答」
		let line = sock.read('line', 10000);
		sock.close();
		if (!line) {
			return { success: false, error: 'Rust 后端无应答' };
		}
		let resp = JSON.parse(line);
		if (resp.error) {
			return { success: false, error: resp.error.message || 'RPC 错误' };
		}
		return resp.result || {};
	} catch (e) {
		try { sock.close(); } catch (_) { /* ignore */ }
		return { success: false, error: `RPC 调用失败: ${e.message}` };
	}
}

return {
	mt5700: {
		/* 执行 AT 命令（含 CONNECT?/SCHED?/CELLSCAN 伪命令），返回 {success,data,error} */
		at: {
			call: function (params) {
				let cmd = params && params.cmd;
				if (typeof cmd !== 'string' || cmd === '') {
					return { success: false, error: '缺少参数 cmd' };
				}
				return rpcCall('at', { cmd: cmd });
			}
		},
		/* 拉取自 since 之后的事件增量，返回 {seq, events} */
		events: {
			call: function (params) {
				let since = (params && params.since) ? parseInt(params.since, 10) || 0 : 0;
				if (since < 0) since = 0;
				return rpcCall('events', { since: since });
			}
		}
	}
};
