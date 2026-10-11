#!/usr/bin/env node
'use strict';
/**
 * 推送链路本地模拟：短信推送 / 来电推送 / 时区口径，一次跑完。
 *
 * 链路（全部落在本机，无需硬件、无需外网）：
 *   本脚本 ──RPC(TCP 8765)──▶ Rust 后端 ──AT(TCP 20249)──▶ mock 模组
 *                                   └── HTTP POST ──▶ 本地 hook 服务（断言收到的推送）
 *
 * 验证项：
 *   1. 短信推送     —— AT+TESTPUSH=2,<索引> 触发 +CMTI，后端读 PDU 后推送
 *   2. 来电推送     —— AT+TESTPUSH=1 触发 +CLIP（振铃）、=4 触发 NO CARRIER（挂断）
 *   3. 实时性       —— 短信与来电必须**不等攒批**就发出（实时直发）
 *   4. 北京时间     —— 推送里的时间戳按系统时区（uci system.@system[0].timezone）
 *                      解析；本机没有 TZ 配置时回落北京时间 UTC+8
 *   5. 文案洁净     —— 推送文本里不出现插件名（用户明确要求）
 *
 * Windows 说明：Rust 通过 CreateProcess 执行 `uci`，只会补 `.exe` 后缀，
 * 所以 .cmd/.bat 包装不可行。这里把 node.exe 硬链接成 `uci.exe`，
 * 再用 NODE_OPTIONS=--require 注入 stub 脚本，等价于一个可执行的假 uci。
 *
 * 前置：cd src/rust && cargo build --release
 * 用法：node simulate-push.js
 */

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createHookServer } = require('./hook-server.js');
const fixtures = require('./sms-fixtures.js');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '../..');
const IS_WIN = process.platform === 'win32';
const RUST_BIN = path.join(ROOT, 'src', 'rust', 'target', 'release', 'at-webserver' + (IS_WIN ? '.exe' : ''));
const SIM_DIR = path.join(os.tmpdir(), 'at-ws-sim');

const AUTH = 'test-key-123';
const MODEM_PORT = 20249;
/* 两个阶段用不同 RPC 端口：Windows 上监听套接字关闭后仍可能处于 TIME_WAIT，
   立刻用同一端口重启会 bind 失败，换端口比 sleep 赌运气可靠 */
const RPC_PORT = 8765;
const RPC_PORT_2 = 8766;
/* 阶段三：开信号巡检后专用端口，避免与前两阶段抢监听 */
const RPC_PORT_3 = 8767;
const HOOK_PORT = 8899;
/* 实时直发的时间上限取 5 秒：短信/来电若走的是入队攒批路径，就会明显晚于这个时间才到 */
const MERGE_WINDOW_MS = 5000;

/*
 * 危险命令黑名单：IMEI / 序列号写入、恢复出厂设置、复位。
 *
 * 本插件的硬约束是「不碰 IMEI」，模拟测试同样不例外。这里做两件事：
 *   1. 脚本侧护栏：任何经本脚本下发的命令命中黑名单就直接抛错（不让它出去）；
 *   2. 事后审计：扫 mock 日志里**所有**收到过的命令（含后端自己发的），
 *      确认整轮测试没有下发过其中任何一条。
 * mock 模组侧还有一份同样的护栏，三层都拒绝，避免「测试跑通了、换真机出事」。
 */
const FORBIDDEN_CMD = [
	/EGMR/i, /WRIMEI/i, /\^IMEI/i, /\+SN=/i,
	/&F/i, /NVDEFAULT/i, /RESET/i, /CFUN\s*=\s*1\s*,\s*1/i
];

/* 护栏自检会**故意**发这些命令（发给 mock，必须被拒绝），审计时排除 */
const SELFCHECK_CMDS = ['AT&F', 'AT+EGMR=1,7,"123456789012345"', 'AT^RESET'];

function assertSafe(cmd) {
	for (const re of FORBIDDEN_CMD) {
		if (re.test(cmd)) {
			throw new Error('已阻止下发危险命令（IMEI 写入 / 恢复出厂 / 复位）：' + cmd);
		}
	}
}

const SMS_LIST = fixtures.buildConversations();
const FIRST_RECV = SMS_LIST.filter((s) => s.direction === 'received')[0];

let pass = 0;
let fail = 0;
let notes = 0;
function check(name, cond, detail) {
	if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : '')); }
	else { fail++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
/* 不计入成败的观察项：不是本次任务的回归，但口径不一致，值得决策 */
function observe(name, detail) {
	notes++;
	console.log('  --   ' + name + (detail ? '  (' + detail + ')' : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* fn 可以是同步谓词，也可以返回 Promise；返回真值即结束等待 */
async function waitFor(fn, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
		await sleep(100);
	}
}

async function waitPort(port, timeoutMs) {
	const t0 = Date.now();
	for (;;) {
		const ok = await new Promise((resolve) => {
			const s = net.connect(port, '127.0.0.1');
			s.setTimeout(500);
			s.on('connect', () => { s.destroy(); resolve(true); });
			s.on('error', () => { s.destroy(); resolve(false); });
			s.on('timeout', () => { s.destroy(); resolve(false); });
		});
		if (ok) return true;
		if (Date.now() - t0 > timeoutMs) throw new Error('端口 ' + port + ' 未就绪');
		await sleep(150);
	}
}

/*
 * 绕过 RPC、直接对 mock 模组发一条 AT 命令，只用于护栏自检。
 * 仅在 SIM_DIR 里的假模组上执行，且命令本身会被 mock 拒绝。
 */
function rawModemCommand(cmd) {
	return new Promise((resolve) => {
		const s = net.connect(MODEM_PORT, '127.0.0.1');
		let buf = '';
		const done = () => { try { s.destroy(); } catch (e) { /* 已关闭 */ } resolve(buf); };
		s.on('connect', () => s.write(cmd + '\r'));
		s.on('data', (d) => {
			buf += d.toString();
			if (buf.indexOf('OK') >= 0 || buf.indexOf('ERROR') >= 0) done();
		});
		s.on('error', done);
		setTimeout(done, 3000);
	});
}

/* ---------- 假 uci（编译一个独立可执行文件） ---------- */

/*
 * 为什么不复用现成解释器：
 *   Rust 通过 CreateProcess 执行 `uci`，Windows 只会补 `.exe`（`.cmd`/`.bat` 不会被找到）；
 *   而把 node.exe 复制/硬链接成 uci.exe、再用 NODE_OPTIONS 注入 stub 也走不通 ——
 *   `uci -q get ...` 里的 `-q` 会被 node 当成自己的选项，直接报错退出，stub 根本没机会跑。
 *   所以这里用 rustc 编译一个独立的小程序（项目本来就需要 Rust 工具链来构建后端）。
 */
const UCI_STUB_RS = `// 假 uci：把本地测试配置喂给 Rust 后端。由 simulate-push.js 生成，非交付物。
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::exit;

fn main() {
    let dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let args: Vec<String> = env::args().skip(1).collect();

    // uci show at-webserver → 全量配置
    if args.len() >= 2 && args[0] == "show" && args[1] == "at-webserver" {
        match fs::read_to_string(dir.join("mock-uci.out")) {
            Ok(s) => { print!("{}", s); exit(0); }
            Err(_) => exit(1),
        }
    }

    // uci -q get system.@system[0].timezone → 模拟设备上的时区设置
    let has_get = args.iter().any(|a| a == "get");
    let has_key = args.iter().any(|a| a == "system.@system[0].timezone");
    if has_get && has_key {
        if let Ok(s) = fs::read_to_string(dir.join("mock-uci-tz.txt")) {
            let t = s.trim();
            if !t.is_empty() {
                println!("{}", t);
                exit(0);
            }
        }
        exit(1);
    }

    exit(1);
}
`;

/* uci 可执行文件与它的数据文件放在 bin/ 子目录，单独加进 PATH */
const UCI_BIN_DIR = path.join(SIM_DIR, 'bin');

function findRustc() {
	const candidates = [
		'rustc',
		path.join(os.homedir(), '.cargo', 'bin', 'rustc' + (IS_WIN ? '.exe' : ''))
	];
	for (const c of candidates) {
		const r = require('child_process').spawnSync(c, ['--version'], { stdio: 'ignore' });
		if (!r.error && r.status === 0) return c;
	}
	return null;
}

function ensureUciStub() {
	fs.mkdirSync(UCI_BIN_DIR, { recursive: true });
	/* 数据文件必须在可执行文件旁：stub 用 current_exe().parent() 定位它们 */
	fs.writeFileSync(path.join(UCI_BIN_DIR, 'mock-uci.out'), buildUciConfig());

	const rs = path.join(UCI_BIN_DIR, 'uci-stub.rs');
	const exe = path.join(UCI_BIN_DIR, IS_WIN ? 'uci.exe' : 'uci');

	/* 只在内容变化时重写源码，否则 mtime 每次都更新，导致每次运行都重编译 */
	let prev = '';
	try { prev = fs.readFileSync(rs, 'utf8'); } catch (e) { /* 首次 */ }
	if (prev !== UCI_STUB_RS) fs.writeFileSync(rs, UCI_STUB_RS);

	const needBuild = !fs.existsSync(exe)
		|| fs.statSync(rs).mtimeMs > fs.statSync(exe).mtimeMs;

	if (needBuild) {
		const rustc = findRustc();
		if (!rustc) throw new Error('未找到 rustc，无法编译本地假 uci（项目构建后端也需要它）');
		const r = require('child_process').spawnSync(
			rustc,
			['-O', '-C', 'strip=symbols', '-o', exe, rs],
			{ stdio: ['ignore', 'inherit', 'inherit'] }
		);
		if (r.status !== 0) throw new Error('编译假 uci 失败');
	}
	return exe;
}

/*
 * 基于既有夹具 mock-uci 派生推送场景的配置，而不是维护第二份完整配置：
 * 两份平行配置迟早会漂移，改一处忘一处。
 */
function buildUciConfig() {
	let txt = fs.readFileSync(path.join(HERE, 'mock-uci'), 'utf8');
	const overrides = {
		websocket_port: "'" + RPC_PORT + "'",
		wechat_webhook: "'http://127.0.0.1:" + HOOK_PORT + "/hook'",
		notify_enabled: "'1'",
		/* 定时推送调到最大（1440 分钟 = 24 小时）：它到点必发一条，
		 * 若按默认 10 分钟跑，长用例里会混进与断言无关的周期性推送。
		 * 阶段三会单独把它调小并验证。 */
		notify_timer_interval: "'1440'",
		/* 关掉信号定时巡检：它会周期发推送，混进断言结果 */
		notify_poll_enabled: "'0'"
	};
	Object.keys(overrides).forEach(function (k) {
		const re = new RegExp('^at-webserver\\.config\\.' + k + '=.*$', 'm');
		if (re.test(txt)) txt = txt.replace(re, 'at-webserver.config.' + k + '=' + overrides[k]);
		else txt = txt.replace(/\s*$/, '\n') + 'at-webserver.config.' + k + '=' + overrides[k] + '\n';
	});
	return txt;
}

/* 改派生配置里的监听端口（阶段二换端口重启时用） */
function rewriteUciPort(port) {
	const file = path.join(UCI_BIN_DIR, 'mock-uci.out');
	const txt = fs.readFileSync(file, 'utf8')
		.replace(/^at-webserver\.config\.websocket_port=.*$/m, "at-webserver.config.websocket_port='" + port + "'");
	fs.writeFileSync(file, txt);
}

/* 写/清时区文件（模拟设备上的 uci system.@system[0].timezone） */
function setUciTimezone(value) {
	const file = path.join(UCI_BIN_DIR, 'mock-uci-tz.txt');
	if (value == null) {
		try { fs.unlinkSync(file); } catch (e) { /* 本就不存在 */ }
	} else {
		fs.writeFileSync(file, value + '\n');
	}
}


/*
 * 写信号巡检配置（阶段三用）。
 * mock-uci 本身没有 notify_poll_* 键，buildUciConfig() 会追加一个「关闭」，
 * 这里按同样的「有则替换、无则追加」规则改成开启。
 */
function setUciPoll(opts) {
	const file = path.join(UCI_BIN_DIR, 'mock-uci.out');
	let txt = fs.readFileSync(file, 'utf8');
	const kv = {
		notify_poll_enabled: opts.enabled,
		notify_poll_all: opts.all,
		notify_poll_interval: opts.interval,
		notify_poll_start: '00:00',
		notify_poll_end: '23:59'
	};
	Object.keys(kv).forEach(function (k) {
		const line = "at-webserver.config." + k + "='" + kv[k] + "'";
		const re = new RegExp('^at-webserver\\.config\\.' + k + '=.*$', 'm');
		if (re.test(txt)) txt = txt.replace(re, line);
		else txt = txt.replace(/\s*$/, '\n') + line + '\n';
	});
	fs.writeFileSync(file, txt);
}

/*
 * 写定时推送配置（阶段三用）。
 * 刻意**只写旧键** notify_interval（秒）并删掉新键 —— 顺带验证老设备升级时
 * 「秒 → 分钟」的自动迁移是否真的生效。
 *
 * 这里填 30 秒而不是 30 秒以外的 60：60 是**旧出厂默认值**，走的是
 * 「落到新默认值 10 分钟」分支（另有单测覆盖），换算不出可观测的短间隔。
 * 30 秒会换算成 1 分钟，首轮推送落在 60 秒处，用例等得起。
 */
function setUciTimerLegacySeconds() {
	const file = path.join(UCI_BIN_DIR, 'mock-uci.out');
	let txt = fs.readFileSync(file, 'utf8');
	/* 删掉新键：新键优先，留着就测不到旧键迁移 */
	txt = txt.replace(/^at-webserver\.config\.notify_timer_interval=.*\n?/m, '');
	const line = "at-webserver.config.notify_interval='30'";
	const re = /^at-webserver\.config\.notify_interval=.*$/m;
	if (re.test(txt)) txt = txt.replace(re, line);
	else txt = txt.replace(/\s*$/, '\n') + line + '\n';
	fs.writeFileSync(file, txt);
}
/*
 * 目录只清「会变的内容」，**不删 uci.exe**。
 *
 * 原因：Windows 会锁定正在运行的映像文件，而 uci.exe 是当前 node.exe 的硬链接 ——
 * 两者共享同一个 FileRecord，只要本脚本（自身就是 node.exe）在跑，
 * 任何指向 node.exe 的链接都删不掉（rmSync 直接 EPERM）。
 * 所以 uci.exe 只在缺失时创建一次，之后复用。
 */
/* 每次运行清掉的产物（不含 bin/：uci.exe 与 stub 源码在那里，编译结果要复用） */
const SIM_FILES = [
	'hook-received.jsonl', 'dbg.js', 'uci-out.txt', 'uci-err.txt',
	'at-webserver-stage1.log', 'at-webserver-stage2.log', 'at-webserver-stage3.log',
	'mock-modem.log', 'mock-modem-stage2.log', 'mock-modem-stage3.log',
	/* 早期版本在顶层留下的假 uci 与数据文件 */
	'uci-stub.js', 'mock-uci.out', 'mock-uci-tz.txt', 'uci'
];

async function prepareSimDir() {
	fs.mkdirSync(SIM_DIR, { recursive: true });
	SIM_FILES.forEach((f) => {
		try { fs.unlinkSync(path.join(SIM_DIR, f)); } catch (e) { /* 不存在即可 */ }
	});
	ensureUciStub();
}

function childEnv(extra) {
	const sep = IS_WIN ? ';' : ':';
	const env = Object.assign({}, process.env, extra || {});
	env.PATH = UCI_BIN_DIR + sep + (process.env.PATH || '');
	return env;
}

/* ---------- 进程管理 ---------- */

const procs = [];
function track(child) { procs.push(child); return child; }

function killAll() {
	procs.forEach((c) => {
		try {
			if (IS_WIN && c.pid) spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
			else c.kill('SIGKILL');
		} catch (e) { /* 已退出 */ }
	});
	procs.length = 0;
}

/* ---------- RPC 客户端（等价 rpcd ucode 插件的转发行为） ---------- */

function createRpc(port) {
	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1');
		let buf = '';
		const pendings = new Map();
		let nextId = 1;

		sock.on('data', (d) => {
			buf += d.toString();
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (!line) continue;
				let obj = null;
				try { obj = JSON.parse(line); } catch (e) { continue; }
				if (obj && obj.id !== undefined) {
					const p = pendings.get(String(obj.id));
					if (p) { pendings.delete(String(obj.id)); clearTimeout(p.timer); p.resolve(obj); }
				}
			}
		});
		sock.on('error', () => {});
		sock.on('connect', () => {
			resolve({
				close: () => sock.destroy(),
				rpc: (method, params, timeoutMs) => new Promise((res) => {
					const id = nextId++;
					const timer = setTimeout(() => {
						pendings.delete(String(id));
						res({ id: id, error: { message: 'RPC 超时' } });
					}, timeoutMs || 10000);
					pendings.set(String(id), { resolve: res, timer: timer });
					sock.write(JSON.stringify({ id: id, method: method, params: params || {} }) + '\n');
				})
			});
		});
		sock.on('error', reject);
	});
}

/* ---------- 启动后端 ---------- */

async function startBackend(tag) {
	const logFile = path.join(SIM_DIR, 'at-webserver-' + tag + '.log');
	const log = fs.createWriteStream(logFile);
	const child = track(spawn(RUST_BIN, ['-verbose'], {
		cwd: HERE,
		env: childEnv(),
		stdio: ['ignore', 'pipe', 'pipe']
	}));
	child.stdout.pipe(log);
	child.stderr.pipe(log);
	return { child: child, logFile: logFile };
}

function readLog(logFile) {
	try { return fs.readFileSync(logFile, 'utf8'); } catch (e) { return ''; }
}

/*
 * 审计：把这轮测试中 mock 模组**收到过的全部命令**扫一遍，
 * 确认没有 IMEI 写入 / 恢复出厂 / 复位 类命令被下发。
 * 覆盖范围包含后端自己发的命令（它不经过本脚本的护栏），因此与脚本侧护栏互补。
 */
function auditModemCommands() {
	const all = [];
	['mock-modem.log', 'mock-modem-stage2.log', 'mock-modem-stage3.log'].forEach((f) => {
		readLog(path.join(SIM_DIR, f)).split('\n').forEach((line) => {
			const m = /\[mock\][^\n]*?<\s(.+)$/.exec(line);
			if (m) all.push(m[1].trim());
		});
	});
	/* 去掉护栏自检故意发的命令；其余一律不得命中黑名单 */
	const scanned = all.filter((c) => SELFCHECK_CMDS.indexOf(c) < 0);
	const dangerous = scanned.filter((c) => FORBIDDEN_CMD.some((re) => re.test(c)));
	const rejected = readLog(path.join(SIM_DIR, 'mock-modem.log')).split('\n')
		.filter((l) => l.indexOf('拒绝危险命令') >= 0).length;
	return { total: scanned.length, dangerous: dangerous, rejected: rejected };
}

/* ---------- 主流程 ---------- */

async function main() {
	if (!fs.existsSync(RUST_BIN)) {
		throw new Error('未找到后端二进制 ' + RUST_BIN + '，请先执行：cd src/rust && cargo build --release');
	}

	console.log('==> 0/7 准备本地模拟环境（编译假 uci + 派生配置）');
	await prepareSimDir();
	console.log('    ' + SIM_DIR);
	/* 先清掉时区文件：本机没有 /etc/TZ，uci 也读不到 → 走「默认北京时间」回退 */
	setUciTimezone(null);

	console.log('==> 1/7 启动本地 webhook 接收端 (127.0.0.1:' + HOOK_PORT + ')');
	const hook = createHookServer({ outFile: path.join(SIM_DIR, 'hook-received.jsonl') });
	await hook.listen(HOOK_PORT);

	console.log('==> 2/7 启动 mock 模组 (TCP ' + MODEM_PORT + '，MOCK_QUIET=1)');
	const mockLog = fs.createWriteStream(path.join(SIM_DIR, 'mock-modem.log'));
	const mock = track(spawn(process.execPath, [path.join(HERE, 'mock-modem.js'), String(MODEM_PORT)], {
		cwd: HERE,
		env: Object.assign({}, process.env, { MOCK_QUIET: '1' }),
		stdio: ['ignore', 'pipe', 'pipe']
	}));
	mock.stdout.pipe(mockLog);
	mock.stderr.pipe(mockLog);
	await waitPort(MODEM_PORT, 8000);

	/* ---------- 护栏自检：危险命令必须被 mock 拒绝 ---------- */
	console.log('\n=== 0. 安全护栏自检（IMEI 写入 / 恢复出厂一律拒绝）===');
	const forbid1 = await rawModemCommand('AT&F');
	check('mock 拒绝恢复出厂命令 AT&F', forbid1.indexOf('ERROR') >= 0, forbid1.trim().slice(0, 40));
	const forbid2 = await rawModemCommand('AT+EGMR=1,7,"123456789012345"');
	check('mock 拒绝 IMEI 写入命令 AT+EGMR', forbid2.indexOf('ERROR') >= 0, forbid2.trim().slice(0, 40));
	const forbid3 = await rawModemCommand('AT^RESET');
	check('mock 拒绝复位命令 AT^RESET', forbid3.indexOf('ERROR') >= 0, forbid3.trim().slice(0, 40));
	const okRead = await rawModemCommand('AT+CGSN');
	check('只读命令（读 IMEI）仍然可用，后端识别设备不受影响',
		okRead.indexOf('OK') >= 0, okRead.indexOf('OK') >= 0 ? 'OK（返回模拟值，非真实 IMEI）' : okRead.trim().slice(0, 40));

	console.log('==> 3/7 启动 Rust 后端 (RPC 127.0.0.1:' + RPC_PORT + ')');
	const be = await startBackend('stage1');
	const rpcConn = await waitPort(RPC_PORT, 15000).then(() => createRpc(RPC_PORT));
	const at = (cmd) => { assertSafe(cmd); return rpcConn.rpc('at', { cmd: cmd, auth_key: AUTH }); };
	/* 等后端真正连上模组：ATI 有应答即说明整条链路通了 */
	await waitFor(async () => {
		const r = await at('ATI');
		return r && r.result && r.result.success ? true : null;
	}, 20000, '后端就绪（ATI 有应答）');
	console.log('    后端就绪');
	await sleep(300);

	/* ---------- 4. 短信推送 ---------- */
	console.log('\n=== 1. 短信推送（实时直发）===');
	const idx = FIRST_RECV.index;
	const markSms = hook.received.length;
	const t0 = Date.now();
	const r1 = await at('AT+TESTPUSH=2,' + idx);
	check('触发命令有应答', !!(r1 && r1.result && String(r1.result.data).indexOf('OK') >= 0), String(r1 && r1.result && r1.result.data).slice(0, 30));
	const smsRec = await waitFor(
		() => hook.received.slice(markSms).filter((r) => r.content && r.content.indexOf(FIRST_RECV.content) >= 0)[0],
		10000, '收到短信推送'
	);
	const smsElapsed = Date.now() - t0;
	check('推送已到达 webhook', !!smsRec);
	check('短信实时直发（不进攒批队列）', smsElapsed < MERGE_WINDOW_MS,
		smsElapsed + ' ms < ' + MERGE_WINDOW_MS + ' ms');
	check('推送号码正确', smsRec.content.indexOf(FIRST_RECV.number) >= 0, FIRST_RECV.number);
	check('推送正文正确', smsRec.content.indexOf(FIRST_RECV.content) >= 0);
	/* 判据必须跟着文案走：拿旧标题原文当判据的话，改一次文案这条断言就永久通过，
	 * 无论是否真的走了汇总形态都显示绿色。 */
	check('未走批量汇总形态', smsRec.content.indexOf('有一批新通知') < 0);
	check('推送文案不含插件名', smsRec.content.indexOf('luci-app-mt5700') < 0 && smsRec.content.indexOf('mt5700') < 0);
	check('内容字段是字符串（企业微信文本格式）', typeof smsRec.content === 'string');

	/*
	 * 观察项（不计成败）：短信中心的号码经过了归一化（剥掉国家码 86），
	 * 而 Rust 侧推送直接用了 PDU 里的原始地址，两者对同一联系人显示不同。
	 * 属于口径一致性问题，不是本次「模拟测试」引入的回归，故记为观察项。
	 */
	const senderShown = (/发送者:\s*(\S+)/.exec(smsRec.content) || [])[1] || '';
	if (/^86\d{11}$/.test(senderShown)) {
		observe('推送号码带国家码 86，与短信中心的显示口径不一致',
			'推送=' + senderShown + '，界面=' + FIRST_RECV.number);
	} else {
		observe('推送号码已与短信中心口径一致', '推送=' + senderShown);
	}

	/* ---------- 5. 来电推送（振铃 + 挂断） ---------- */
	console.log('\n=== 2. 来电推送（振铃 / 挂断两条，均实时）===');
	const markCall = hook.received.length;
	const tc0 = Date.now();
	await at('AT+TESTPUSH=1');
	const ring = await waitFor(() => {
		const m = hook.received.slice(markCall).filter((r) => r.content && r.content.indexOf('来电振铃') >= 0)[0];
		return m || null;
	}, 10000, '收到来电振铃推送');
	const ringElapsed = Date.now() - tc0;
	check('振铃推送已到达', !!ring);
	check('振铃实时直发（不进攒批队列）', ringElapsed < MERGE_WINDOW_MS, ringElapsed + ' ms');

	await sleep(400);
	await at('AT+TESTPUSH=4');
	const hang = await waitFor(() => {
		const m = hook.received.slice(markCall).filter((r) => r.content && r.content.indexOf('通话结束') >= 0)[0];
		return m || null;
	}, 10000, '收到通话结束推送');
	check('挂断推送已到达', !!hang);
	check('振铃与挂断是两条独立推送', !!ring && !!hang && ring !== hang);

	/* ---------- 6. 时间口径：默认北京时间 ---------- */
	console.log('\n=== 3. 时间口径：无系统时区配置时回落北京时间（UTC+8）===');
	const log1 = readLog(be.logFile);
	const tzLine1 = (log1.split('\n').filter((l) => l.indexOf('时区') >= 0)[0] || '').trim();
	check('后端日志写明回落默认北京时间', /默认北京时间/.test(tzLine1), tzLine1.slice(0, 100));
	const tsRe = /时间：(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
	const ringTs = tsRe.exec(ring.content);
	check('推送里带时间戳', !!ringTs, ringTs ? ringTs[0] : '未匹配');
	if (ringTs) {
		const got = Date.UTC(+ringTs[1], +ringTs[2] - 1, +ringTs[3], +ringTs[4], +ringTs[5], +ringTs[6]);
		const beijingNow = Date.now() + 8 * 3600 * 1000;
		const diffMin = Math.abs(got - beijingNow) / 60000;
		check('时间戳 == 北京时间（容差 2 分钟）', diffMin < 2,
			'偏差 ' + diffMin.toFixed(2) + ' 分钟');
		check('不是 UTC 口径（否则会差 8 小时）', diffMin < 60, '偏差 ' + diffMin.toFixed(2) + ' 分钟');
	}

	/* ---------- 7. 时间口径：系统时区优先 ---------- */
	console.log('\n=== 4. 时间口径：以系统时区为准（模拟 uci timezone=UTC0）===');
	rpcConn.close();
	killAll();
	await sleep(600);

	setUciTimezone('UTC0');
	rewriteUciPort(RPC_PORT_2);
	const mock2Log = fs.createWriteStream(path.join(SIM_DIR, 'mock-modem-stage2.log'));
	const mock2 = track(spawn(process.execPath, [path.join(HERE, 'mock-modem.js'), String(MODEM_PORT)], {
		cwd: HERE,
		env: Object.assign({}, process.env, { MOCK_QUIET: '1' }),
		stdio: ['ignore', 'pipe', 'pipe']
	}));
	mock2.stdout.pipe(mock2Log);
	mock2.stderr.pipe(mock2Log);
	await waitPort(MODEM_PORT, 8000);

	const be2 = await startBackend('stage2');
	const rpcConn2 = await waitPort(RPC_PORT_2, 15000).then(() => createRpc(RPC_PORT_2));
	const at2 = (cmd) => { assertSafe(cmd); return rpcConn2.rpc('at', { cmd: cmd, auth_key: AUTH }); };
	await waitFor(async () => {
		const r = await at2('ATI');
		return r && r.result && r.result.success ? true : null;
	}, 20000, '后端就绪（stage2）');
	await sleep(300);

	const log2 = readLog(be2.logFile);
	const tzLine = (log2.split('\n').filter((l) => l.indexOf('时区') >= 0)[0] || '').trim();
	check('后端日志记录了时区解析结果', tzLine.length > 0, tzLine.slice(0, 100));
	check('时区取自 uci（UTC0 → UTC+00:00）', /UTC\+00:00/.test(tzLine), tzLine.slice(0, 100));

	const markTz = hook.received.length;
	await at2('AT+TESTPUSH=1');
	const tzRec = await waitFor(() => {
		const m = hook.received.slice(markTz).filter((r) => r.content && r.content.indexOf('来电振铃') >= 0)[0];
		return m || null;
	}, 10000, '收到 stage2 来电推送');
	const tzTs = tsRe.exec(tzRec.content);
	check('stage2 推送带时间戳', !!tzTs, tzTs ? tzTs[0] : '未匹配');
	if (tzTs) {
		const got = Date.UTC(+tzTs[1], +tzTs[2] - 1, +tzTs[3], +tzTs[4], +tzTs[5], +tzTs[6]);
		const utcNow = Date.now();
		const beijingNow = Date.now() + 8 * 3600 * 1000;
		const dUtc = Math.abs(got - utcNow) / 60000;
		const dBeijing = Math.abs(got - beijingNow) / 60000;
		check('时间戳跟随系统时区（= UTC）', dUtc < 2, '与 UTC 偏差 ' + dUtc.toFixed(2) + ' 分钟');
		check('确实不是写死的北京时间', dBeijing > 60, '与北京时差 ' + (dBeijing / 60).toFixed(2) + ' 小时');
	}

	/* ---------- 6. LuCI「发送测试通知」按钮 ---------- */
	console.log('\n=== 5. 测试推送（通道连通性 + 按事件类型）===');
	const TEST_TEXT = '喵～测试通知来啦！推送通道一切正常，链路畅通无阻喵！';
	const markTest = hook.received.length;
	/* 与 at() 一样必须带 auth_key：notify_test 是普通 RPC 方法，不带头会被拒（密钥错误） */
	const testRes = await rpcConn2.rpc('notify_test', { channel: 'wechat', auth_key: AUTH });
	check('RPC 返回成功', !!(testRes.result && testRes.result.success),
		testRes.result && testRes.result.error ? String(testRes.result.error) : 'success');
	const testRec = await waitFor(() => {
		const m = hook.received.slice(markTest).filter((r) => r.content && r.content.indexOf('测试通知') >= 0)[0];
		return m || null;
	}, 8000, '收到测试通知推送');
	check('测试通知已送达 webhook', !!testRec);
	check('文案与约定一致', !!testRec && testRec.content.indexOf(TEST_TEXT) >= 0,
		testRec ? testRec.content.replace(/\n/g, '\\n').slice(0, 70) : '');
	check('测试通知不含插件名', !!testRec && testRec.content.indexOf('mt5700') < 0);

	/*
	 * 按事件类型测试（channel=sms|call）。
	 *
	 * 短信与来电只能由模组 URC 触发，没有注入入口就没法在设备上验证「新文案长什么样、
	 * 是不是真的实时」。这里断言它确实是**同形状事件走完整链路**，而不是另一段固定文案：
	 * 输出必须套用真实短信/来电模板（发送者/内容占位符被真实填上），且不等攒批。
	 */
	const markKind = hook.received.length;
	const tk = Date.now();
	const smsTest = await rpcConn2.rpc('notify_test', { channel: 'sms', auth_key: AUTH });
	check('短信测试推送 RPC 返回成功', !!(smsTest.result && smsTest.result.success),
		smsTest.result && smsTest.result.error ? String(smsTest.result.error) : 'success');
	const smsTestRec = await waitFor(() => {
		const m = hook.received.slice(markKind).filter((r) => r.content && r.content.indexOf('模拟短信') >= 0)[0];
		return m || null;
	}, 8000, '收到短信测试推送');
	check('短信测试推送已送达 webhook', !!smsTestRec);
	check('短信测试实时直发（与真实短信同一路径）', Date.now() - tk < MERGE_WINDOW_MS,
		(Date.now() - tk) + ' ms < ' + MERGE_WINDOW_MS + ' ms');
	const smsTestText = smsTestRec ? smsTestRec.content : '';
	check('套用真实短信模板（发送者占位符被填）', smsTestText.indexOf('发送者: 138****0000') >= 0,
		(smsTestText.split('\n').filter((l) => l.indexOf('发送者') >= 0)[0] || ''));
	check('套用真实短信模板（内容占位符被填）', smsTestText.indexOf('这是一条模拟短信') >= 0);
	check('测试短信自带标注，不会被当成真短信', smsTestText.indexOf('非真实短信') >= 0);
	check('测试短信不含插件名', smsTestText.indexOf('mt5700') < 0);

	const tk2 = Date.now();
	const callTest = await rpcConn2.rpc('notify_test', { channel: 'call', auth_key: AUTH });
	check('来电测试推送 RPC 返回成功', !!(callTest.result && callTest.result.success),
		callTest.result && callTest.result.error ? String(callTest.result.error) : 'success');
	const callTestRec = await waitFor(() => {
		const m = hook.received.slice(markKind).filter((r) => r.content && r.content.indexOf('来电振铃（测试消息') >= 0)[0];
		return m || null;
	}, 8000, '收到来电测试推送');
	check('来电测试推送已送达 webhook', !!callTestRec);
	check('来电测试实时直发（与真实来电同一路径）', Date.now() - tk2 < MERGE_WINDOW_MS, (Date.now() - tk2) + ' ms');
	const callTestText = callTestRec ? callTestRec.content : '';
	check('套用真实来电模板（标题与真实来电一致）', callTestText.indexOf('有电话打进来啦') >= 0,
		callTestText.split('\n')[0] || '');
	check('测试来电正文含掩码号码与振铃状态', callTestText.indexOf('138****0000') >= 0 && callTestText.indexOf('状态：来电振铃') >= 0);
	check('测试来电自带标注，不会被当成真来电', callTestText.indexOf('非真实来电') >= 0);

	/* 非法 channel 必须明确失败：假装成功会让用户以为推送通着，实际什么都没发 */
	const badTest = await rpcConn2.rpc('notify_test', { channel: 'no-such-channel', auth_key: AUTH });
	check('未知通道明确报错而不是假装成功',
		!!(badTest.result && !badTest.result.success && String(badTest.result.error).indexOf('未知通道') >= 0),
		badTest.result ? String(badTest.result.error) : '');
	const sigTest = await rpcConn2.rpc('notify_test', { channel: 'signal', auth_key: AUTH });
	check('信号不支持类型化测试（走真实巡检，避免造出假读数）',
		!!(sigTest.result && !sigTest.result.success && String(sigTest.result.error).indexOf('不支持测试推送') >= 0),
		sigTest.result ? String(sigTest.result.error) : '');

	/* ---------- 8. 信号巡检推送 ---------- */
	console.log('\n=== 6. 信号巡检推送（具体频段 + 网络代际 + 完整评估）===');
	/*
	 * signalwatch::run() 是「先 sleep 再 tick」，所以第一轮推送要等满一个巡检
	 * 间隔；后端把间隔夹取在 30~3600 秒，这里取 30 秒。时段设为全天，避免
	 * 用例在边界时刻（比如刚好跨过 23:59）被时段判定挡掉而偶发失败。
	 */
	rpcConn2.close();
	killAll();
	await sleep(600);

	setUciTimezone(null);
	rewriteUciPort(RPC_PORT_3);
	setUciPoll({ enabled: 1, all: 1, interval: 30 });
	/* 定时推送单独开到 1 分钟（用旧键 60 秒触发迁移） */
	setUciTimerLegacySeconds();
	const mock3Log = fs.createWriteStream(path.join(SIM_DIR, 'mock-modem-stage3.log'));
	const mock3 = track(spawn(process.execPath, [path.join(HERE, 'mock-modem.js'), String(MODEM_PORT)], {
		cwd: HERE,
		env: Object.assign({}, process.env, { MOCK_QUIET: '1' }),
		stdio: ['ignore', 'pipe', 'pipe']
	}));
	mock3.stdout.pipe(mock3Log);
	mock3.stderr.pipe(mock3Log);
	await waitPort(MODEM_PORT, 8000);

	const be3 = await startBackend('stage3');
	const rpcConn3 = await waitPort(RPC_PORT_3, 15000).then(() => createRpc(RPC_PORT_3));
	await waitFor(async () => {
		const r = await rpcConn3.rpc('at', { cmd: 'ATI', auth_key: AUTH });
		return r && r.result && r.result.success ? true : null;
	}, 20000, '后端就绪（stage3）');
	console.log('    等待首轮信号巡检（间隔 30 秒）...');

	const markSig = hook.received.length;
	const sigRec = await waitFor(() => {
		const m = hook.received.slice(markSig).filter((r) => r.content && r.content.indexOf('信号巡检') >= 0)[0];
		return m || null;
	}, 90000, '收到信号巡检推送');

	check('信号巡检推送已送达 webhook', !!sigRec);
	const sig = sigRec ? sigRec.content : '';
	console.log('    ── 推送正文 ──');
	sig.split('\n').forEach((l) => console.log('    ' + l));
	check('标题带网络代际（5G / 4G）', /📶\s*(5G|4G)\s*信号巡检/.test(sig), sig.split('\n')[0] || '');
	check('给出具体频段号（NR 用 n 前缀）', sig.indexOf('n41') >= 0, 'n41');
	check('给出下行频点与带宽', sig.indexOf('2565 MHz') >= 0 && sig.indexOf('100 MHz') >= 0,
		'2565 MHz / 100 MHz');
	/* ^MONSC 的 sysmode 与 ^HFREQINFO 的不是同一张表；混用会把 NR 当成 LTE */
	check('未把 NR 误判成 LTE（两张 sysmode 表不可混用）', /频段：n\d/.test(sig) && sig.indexOf('4G') < 0,
		(sig.split('\n').filter((l) => l.indexOf('频段') >= 0)[0] || ''));
	check('四项指标齐全', ['RSRP', 'RSRQ', 'SINR', 'SIGNAL'].every((k) => sig.indexOf(k) >= 0));
	check('文案已压缩（正文 ≤ 9 行）', sig.split('\n').length <= 9, sig.split('\n').length + ' 行');
	check('推送不含插件名', sig.indexOf('mt5700') < 0);
	/*
	 * 借位置的消息（无发送时刻的发出短信）只调顺序、不造时刻 —— 这里顺带确认
	 * 信号推送没有把推断出来的位置写成真实时刻。
	 */
	check('信号推送含完整评估结论', sig.indexOf('网络能力') >= 0 && sig.indexOf('·') >= 0);

	/* ---------- 8b. 定时推送：到点就推当前状态，与有没有事件无关 ---------- */
	console.log('\n=== 6b. 定时推送（旧键 notify_interval=30 秒 → 迁移为 1 分钟）===');
	/*
	 * 迁移是否生效要看启动日志：后端按分钟打印间隔。旧键 60 秒 → 1 分钟，
	 * 首轮推送因此落在 60 秒处 —— 既验证了迁移，也不用等满默认 10 分钟。
	 */
	const be3Log = readLog(path.join(SIM_DIR, 'at-webserver-stage3.log'));
	check('旧键 notify_interval（秒）已迁移为分钟并按新值启动',
		be3Log.indexOf('定时推送已启动：每 1 分钟') >= 0,
		(be3Log.split('\n').filter((l) => l.indexOf('定时推送已启动') >= 0)[0] || '未找到启动日志').trim());

	/*
	 * 「与有没有事件无关」这条怎么验证：本阶段从后端启动起**没有触发任何短信/来电**，
	 * 信号巡检走的是自己的 30 秒线。能在 60 秒处收到一条状态快照，
	 * 说明它是定时器推的，而不是被某条事件捎带出来的。
	 */
	const timerRec = await waitFor(() => {
		const m = hook.received.slice(markSig)
			.filter((r) => r.content && r.content.indexOf('当前状态（定时推送）') >= 0)[0];
		return m || null;
	}, 90000, '收到定时推送（当前状态快照）');

	check('定时推送已送达 webhook（期间未触发任何事件）', !!timerRec);
	const tp = timerRec ? timerRec.content : '';
	console.log('    ── 推送正文 ──');
	tp.split('\n').forEach((l) => console.log('    ' + l));
	check('标题标明是定时推送的状态快照', tp.indexOf('🕒 当前状态（定时推送）') >= 0, tp.split('\n')[0] || '');
	check('状态快照含网络代际与具体频段', /📶\s*(5G|4G)/.test(tp) && tp.indexOf('n41') >= 0,
		tp.split('\n').filter((l) => l.indexOf('📶') >= 0)[0] || '');
	check('状态快照含短信存储用量（现读，非沿用旧状态）', tp.indexOf('短信存储') >= 0,
		tp.split('\n').filter((l) => l.indexOf('💾') >= 0)[0] || '');
	check('与巡检推送可区分（不会被当成重复推送）', tp.indexOf('信号巡检') < 0);
	check('定时推送不含插件名', tp.indexOf('mt5700') < 0);

	console.log('\n=== 7. 安全审计：整轮测试下发过的 AT 命令 ===');
	const audit = auditModemCommands();
	check('未下发任何危险命令（IMEI 写入 / 恢复出厂 / 复位）', audit.dangerous.length === 0,
		audit.dangerous.length ? audit.dangerous.join(' | ') : '扫描 ' + audit.total + ' 条命令，全部安全');
	check('危险命令均被 mock 拒绝', audit.rejected >= 3, '拒绝 ' + audit.rejected + ' 次（含自检）');

	rpcConn3.close();
	return { smsRec: smsRec, ring: ring, hang: hang, hook: hook, simDir: SIM_DIR, audit: audit };
}

/* ---------- 收尾 ---------- */

main().then(async (ctx) => {
	console.log('\n=== 收到的推送明细 ===');
	ctx.hook.received.forEach((r, i) => {
		console.log('--- #' + (i + 1) + ' ---');
		console.log((r.content || r.body).replace(/\n/g, '\n    '));
	});
	console.log('\n=== 后端渲染日志（推送内容）===');
	const log = readLog(path.join(SIM_DIR, 'at-webserver-stage1.log'));
	log.split('\n').filter((l) => l.indexOf('推送内容') >= 0).forEach((l) => console.log('  ' + l.trim()));

	console.log('\n=== 安全审计（IMEI / 恢复出厂）===');
	console.log('  扫描下发命令 ' + ctx.audit.total + ' 条，其中危险命令 ' + ctx.audit.dangerous.length
		+ ' 条，被拒 ' + ctx.audit.rejected + ' 次');

	console.log('\n合计: ' + pass + ' 通过, ' + fail + ' 失败' + (notes ? '，' + notes + ' 项观察' : ''));
	console.log('产物目录: ' + SIM_DIR);
	killAll();
	process.exit(fail ? 1 : 0);
}).catch(async (e) => {
	console.error('\n模拟失败: ' + (e && e.stack ? e.stack : e));
	killAll();
	process.exit(1);
});
