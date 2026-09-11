'use strict';
/*
 * rpcd ucode 插件：mt5700。
 * OpenWrt ucode 语法：无 ===/模板字符串；无 require('json')，
 * 序列化用 sprintf('%J')，反序列化用内置迷你解析器。
 * 参数在 req.args 上（不是 req 顶层）。
 */

const fs = require('fs');
const uci = require('uci');

function readRpcConfig() {
	const cursor = uci.cursor();
	const port = int(cursor.get('at-webserver', 'config', 'websocket_port')) || 8765;
	const authKey = cursor.get('at-webserver', 'config', 'websocket_auth_key') || '';
	return { port: port, authKey: authKey };
}

function getStr(obj, key) {
	if (obj == null) {
		return null;
	}
	let v = obj[key];
	if (v == null) {
		return null;
	}
	return v;
}

/* 迷你 JSON 解析：ucode 无 s[i]、嵌套函数不提升，用 substr + 前置声明 */
function jsonParse(s) {
	let i = 0;
	let n = length(s);
	let parseVal;

	function ch() {
		if (i >= n) {
			return '';
		}
		return substr(s, i, 1);
	}

	function ws() {
		while (i < n) {
			let c = ch();
			if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
				i++;
			} else {
				break;
			}
		}
	}

	function parseStr() {
		i++;
		let out = '';
		while (i < n) {
			let c = ch();
			if (c == '\\') {
				i++;
				let e = ch();
				if (e == 'n') { out += '\n'; }
				else if (e == 't') { out += '\t'; }
				else if (e == 'r') { out += '\r'; }
				else if (e == '"') { out += '"'; }
				else if (e == '\\') { out += '\\'; }
				else if (e == '/') { out += '/'; }
				else { out += e; }
				i++;
			} else if (c == '"') {
				i++;
				return out;
			} else {
				out += c;
				i++;
			}
		}
		return out;
	}

	function parseNum() {
		let start = i;
		if (ch() == '-') { i++; }
		while (i < n) {
			let c = ch();
			if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
				i++;
			} else {
				break;
			}
		}
		return int(substr(s, start, i - start));
	}

	function parseArr() {
		i++;
		let arr = [];
		ws();
		if (ch() == ']') { i++; return arr; }
		while (i < n) {
			arr.push(parseVal());
			ws();
			if (ch() == ',') { i++; ws(); continue; }
			if (ch() == ']') { i++; break; }
			break;
		}
		return arr;
	}

	function parseObj() {
		i++;
		let obj = {};
		ws();
		if (ch() == '}') { i++; return obj; }
		while (i < n) {
			ws();
			if (ch() != '"') { break; }
			let k = parseStr();
			ws();
			if (ch() == ':') { i++; }
			let v = parseVal();
			obj[k] = v;
			ws();
			if (ch() == ',') { i++; continue; }
			if (ch() == '}') { i++; break; }
			break;
		}
		return obj;
	}

	parseVal = function () {
		ws();
		let c = ch();
		if (c == '{') { return parseObj(); }
		if (c == '[') { return parseArr(); }
		if (c == '"') { return parseStr(); }
		if (c == 't') { i += 4; return true; }
		if (c == 'f') { i += 5; return false; }
		if (c == 'n') { i += 4; return null; }
		return parseNum();
	};

	return parseVal();
}

function rpcCall(method, params) {
	const rpcCfg = readRpcConfig();
	const port = rpcCfg.port;
	const authKey = rpcCfg.authKey;

	const payload = { id: 1, method: method, params: params };
	if (authKey != '') {
		payload.params.auth_key = authKey;
	}

	/* 本固件 ucode fs 无 connect，经 busybox nc 管道访问回环 RPC */
	const body = sprintf('%J', payload);
	const tmp = '/tmp/mt5700-rpc.json';
	let f;
	try {
		f = fs.open(tmp, 'w');
	} catch (e) {
		return { success: false, error: '无法写临时文件' };
	}
	if (!f) {
		return { success: false, error: '无法写临时文件' };
	}
	f.write(body + '\n');
	f.close();

	let p;
	try {
		p = fs.popen('nc 127.0.0.1 ' + port + ' < ' + tmp, 'r');
	} catch (e) {
		return { success: false, error: '无法连接 Rust 后端' };
	}
	if (!p) {
		return { success: false, error: '无法连接 Rust 后端' };
	}

	let line = p.read('line');
	p.close();

	if (!line) {
		return { success: false, error: 'Rust 后端无应答' };
	}

	try {
		let resp = jsonParse(line);
		if (resp.error) {
			let msg = 'RPC 错误';
			if (resp.error.message) {
				msg = resp.error.message;
			}
			return { success: false, error: msg };
		}
		if (resp.result) {
			return resp.result;
		}
		return {};
	} catch (e) {
		return { success: false, error: '解析应答失败: ' + e.message };
	}
}

return {
	mt5700: {
		at: {
			args: { cmd: '' },
			call: function (req) {
				let a = req.args;
				let cmd = getStr(a, 'cmd');
				if (cmd == null || cmd == '') {
					return { success: false, error: '缺少参数 cmd' };
				}
				return rpcCall('at', { cmd: cmd });
			}
		},
		events: {
			args: { since: 0 },
			call: function (req) {
				let a = req.args;
				let since = 0;
				let s = getStr(a, 'since');
				if (s != null && s != '') {
					since = int(s) || 0;
				}
				if (since < 0) {
					since = 0;
				}
				return rpcCall('events', { since: since });
			}
		}
	}
};
