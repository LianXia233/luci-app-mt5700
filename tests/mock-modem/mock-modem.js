#!/usr/bin/env node
/**
 * mock-modem：MT5700 模组 AT 接口模拟器（本地链路验证用，非交付后端）。
 *
 * 监听 TCP 端口（默认 20249），应答常用 AT 命令并周期推送 URC，
 * 用于在无真实硬件时验证「LuCI JS → WS → Rust 后端 → 模组」完整链路。
 *
 * 用法：
 *   node mock-modem.js [port]
 * 支持的命令见 CMD_TABLE；未知命令返回 "ERROR\r\n"。
 *
 * 环境变量：
 *   MOCK_QUIET=1      关掉自发的周期 URC（信号 / 伪来电 / 伪短信）。
 *                     做推送模拟时必开：自发 URC 会混进结果，让收到的推送无法归因。
 *   MOCK_CMGL_TEXT=1  AT+CMGL=4 返回文本模式样本，而非 PDU 夹具。
 *
 * 短信内容来自 sms-fixtures.js（时间 = 当前北京时间 − 偏移），
 * 与前端渲染测试（sms-center-render.js）共用同一份样本。
 */
'use strict';

const net = require('net');
const fixtures = require('./sms-fixtures.js');

const PORT = parseInt(process.argv[2], 10) || 20249;

/*
 * 短信存储内容由夹具动态生成（时间 = 当前北京时间 − 偏移）。
 * 写死日期的样本看不出排序 / 分区对不对，也无法验证「时间戳走的是北京时间」。
 */
const SMS_LIST = fixtures.buildConversations();
/* 模组只把「对方发来的」放进收件箱；已发短信在 CMGL 里以 STO SENT 出现 */
const RECV_INDICES = SMS_LIST.filter(function (s) { return s.direction === 'received'; })
	.map(function (s) { return s.index; });

/* ---------- 状态 ---------- */
const state = {
	cfun: 1,
	cmgf: 0,
	cnmi: '2,1,0,2,0',
	clip: 1,
	cmee: 2,
	csca: '+8613800755500',
	imei: '862234051234567',
	rsrp: -95,      // 动态变化用于信号 URC
	ims: '1,1,1',
	smsSeq: 0,
	// 自动拨号：刻意从「开关已开、但方式为 2（转网口模式）」起步。
	// 只比开关不比方式的实现会判定已对齐而跳过下发，模组停在转网口模式，
	// USB 网口永远拿不到 DHCP —— e2e 用它做回归（见 e2e-test.js 第 10 项）。
	autodial: 1,
	autodialMode: 2,
	// USB 数据面状态：1=就绪。置 0 会让后端进入重试与周期对账路径。
	ndis: 1
};

/* 依次轮换收件箱索引，保证每次 AT+TESTPUSH=2 都能读到一条真实存在的短信 */
function nextSmsIndex() {
	state.smsSeq = (state.smsSeq % RECV_INDICES.length) + 1;
	return RECV_INDICES[state.smsSeq - 1];
}

/* ---------- 安全护栏 ---------- */

/*
 * 危险命令一律拒绝：IMEI 写入、序列号写入、恢复出厂设置、复位。
 *
 * 即使是模拟器也不给这些命令留入口 —— 模拟器的价值在于「测试脚本跑通了，
 * 换成真机也能跑」，那么它就绝不能对危险命令回 OK：
 * 一旦有人把测试指向真实模组（或改错了网络端口），
 * 日志里那句 OK 就会变成「已经执行过」的证据。
 *
 * 只读命令（AT+CGSN 读 IMEI、ATI 读型号）保留：后端启动时要读它们做设备识别，
 * 不做修改就没有不可逆后果。本插件的硬约束是「不碰 IMEI」，即不写、不改、不恢复。
 */
const FORBIDDEN = [
	// IMEI / 序列号写入
	/^AT\+EGMR/i,
	/^AT\+WRIMEI/i,
	/^AT\^IMEI/i,
	/^AT\+SN=/i,
	/^AT\^SN=/i,
	// 恢复出厂设置 / 清 NV
	/^AT&F/i,
	/^AT\^NVDEFAULT/i,
	// 复位 / 重启
	/^AT\+RESET/i,
	/^AT\^RESET/i,
	/^AT\+CFUN=1\s*,\s*1$/i
];

/* ---------- 应答表 ---------- */
function replyFor(cmd) {
	const c = cmd.replace(/\r/g, '');
	for (let i = 0; i < FORBIDDEN.length; i++) {
		if (FORBIDDEN[i].test(c)) {
			console.log('[mock] 拒绝危险命令（IMEI 写入 / 恢复出厂 / 复位）: ' + c);
			return 'ERROR';
		}
	}
	if (c === 'AT') return 'OK';
	if (c === 'ATI') return 'Manufacturer: MTK\r\nModel: MT5700M\r\nRevision: MT5700M_CN_A0_V002\r\nIMEI: ' + state.imei + '\r\nOK';
	if (c === 'AT+CGSN') return state.imei + '\r\nOK';
	if (c === 'AT+CMEE=2') return 'OK';
	if (c === 'AT+CMEE?') return '+CMEE: 2\r\nOK';
	if (c === 'AT+CNMI?') return '+CNMI: ' + state.cnmi + '\r\nOK';
	if (c === 'AT+CNMI=' + state.cnmi) return 'OK';
	if (c === 'AT+CMGF?') return '+CMGF: ' + state.cmgf + '\r\nOK';
	if (c === 'AT+CMGF=0') { state.cmgf = 0; return 'OK'; }
	if (c === 'AT+CMGF=1') { state.cmgf = 1; return 'OK'; }
	if (c === 'AT+CLIP=1') return 'OK';
	if (c === 'AT+CFUN?') return '+CFUN: ' + state.cfun + '\r\nOK';
	if (c === 'AT+CFUN=0') { state.cfun = 0; return 'OK'; }
	if (c === 'AT+CFUN=1') { state.cfun = 1; return 'OK'; }
	if (c === 'AT+CSQ?') return '+CSQ: 25,99\r\nOK';
	if (c === 'AT^HCSQ?') return '^HCSQ: 0,0,0,0,17,45,25,10,14\r\nOK';
	if (c === 'AT+CGREG?') return '+CGREG: 0,5\r\nOK';
	if (c === 'AT+C5GREG?') return '+C5GREG: 0,5\r\nOK';
	if (c === 'AT+CREG?') return '+CREG: 0,1\r\nOK';
	if (c === 'AT+COPS?') return '+COPS: 0,0,"CHN-UNICOM",7\r\nOK';
	if (c === 'AT+COPS=3,2') return 'OK';
	/*
	 * 信号应答必须用**实机真实格式**：rpc.js parseMONSC 与 Rust urc::query_monsc
	 * 都按这个字段顺序取值，占位数字会让 RSRP 解析不出来（回落成 -140 dBm）。
	 * 行内是实机抓到的样本（NR n41、RSRP -65 / RSRQ -10 / SINR 28）。
	 */
	/*
	 * 命令名同样要与后端对齐：Rust `urc::query_monsc` 与前端 network_status.js
	 * 发的都是 `AT^MONSC`（**不带问号**）。夹具早先写成 `AT^MONSC?`，后端拿不到
	 * 应答便静默回落到 HCSQ，于是巡检报出 -140 dBm 这种假读数（页面也一起错），
	 * 掩盖了真正的信号值。两种写法都认，避免再踩。
	 */
	if (c === 'AT^MONSC' || c === 'AT^MONSC?') return '^MONSC: NR,460,00,504990,1,C2840C002,80,149002,-65,-10,28\r\nOK';
	if (c === 'AT^HFREQINFO?') return '^HFREQINFO: 0,7,41,513000,2565000,100000,0,0,0\r\nOK';
	if (c === 'AT^LENDC?') return '^LENDC: 0,1,10,0,0\r\nOK';
	if (c === 'AT^TXPOWER?') return '^TXPOWER: 0,15,23\r\nOK';
	if (c === 'AT^NTXPOWER?') return '^NTXPOWER: 0,1,20,23\r\nOK';
	if (c === 'AT+CGPADDR') return '+CGPADDR: 1,"10.10.1.2"\r\n+CGPADDR: 2,"2408:8400:8000:0:0:0:0:1"\r\nOK';
	if (c === 'AT^CHIPTEMP?') return '^CHIPTEMP: 42\r\nOK';
	if (c === 'AT+CPIN?') return '+CPIN: READY\r\nOK';
	/*
	 * 短信列表与单条读取喂**动态夹具**（sms-fixtures.js），与短信中心渲染测试同源。
	 * MOCK_CMGL_TEXT=1 时退回文本模式样本，覆盖前端的非 PDU 分支。
	 */
	if (c === 'AT+CMGL=4') {
		if (process.env.MOCK_CMGL_TEXT === '1') {
			return '+CMGL: 1,"REC READ","+8613800138000",,"25/09/10,10:30:00+32"\r\n你好，这是测试短信。\r\nOK';
		}
		return fixtures.cmglText(SMS_LIST);
	}
	if (c.startsWith('AT+CMGR=')) {
		const want = parseInt(c.slice('AT+CMGR='.length), 10);
		const item = SMS_LIST.filter(function (s) { return s.index === want; })[0];
		/* 收件箱里没有的（含已发短信）一律 ERROR：真模组也不会用 CMGR 取已发记录 */
		if (!item || item.direction !== 'received') return 'ERROR';
		return fixtures.cmgrText(item.pdu);
	}
	if (c === 'AT+CSCA?') return '+CSCA: "' + state.csca + '",145\r\nOK';
	if (c.startsWith('AT+CSCA=')) { const m = c.match(/AT\+CSCA="([^"]+)"/); if (m) state.csca = m[1]; return 'OK'; }
	/* 存储用量与夹具条数保持一致，否则界面会显示「存储 0/50」却列出 6 条短信 */
	if (c === 'AT^CPMS?') return '^CPMS: "SM",' + SMS_LIST.length + ',50,"SM",' + SMS_LIST.length + ',50,"MT",0,50\r\nOK';
	if (c === 'AT+CPMS?') return '+CPMS: "SM",' + SMS_LIST.length + ',50,"SM",' + SMS_LIST.length + ',50,"MT",0,50\r\nOK';
	if (c.startsWith('AT+CPMS=')) return 'OK';
	if (c === 'AT+CMGD=1,4') return 'OK';
	if (c.startsWith('AT+CMGD=')) return 'OK';
	if (c === 'AT^IMSSWITCH?') return '^IMSSWITCH: ' + state.ims + '\r\nOK';
	if (c.startsWith('AT^IMSSWITCH=')) { const m = c.match(/AT\^IMSSWITCH=([^,]+)/); if (m) state.ims = m[1] + ',0,0'; return 'OK'; }
	if (c === 'AT+CEUS=1' || c === 'AT+CEUS=0') return 'OK';
	if (c === 'AT^LTEFREQLOCK?') return '^LTEFREQLOCK: 0,0,0,""\r\nOK';
	if (c.startsWith('AT^LTEFREQLOCK=')) return 'OK';
	if (c === 'AT^NRFREQLOCK?') return '^NRFREQLOCK: 0,0,0,""\r\nOK';
	if (c.startsWith('AT^NRFREQLOCK=')) return 'OK';
	if (c === 'AT^C5GOPTION?') return '^C5GOPTION: 0,1,0\r\nOK';
	if (c === 'AT+C5GOPTION=0,1,0') return 'OK';
	if (c === 'AT^SYSINFO?') return '^SYSINFO: 0,7,2,0\r\nOK';
	if (c === 'AT+CGDCONT?') return '+CGDCONT: 1,"IP","ims","",0,0,0,0,1,1,1\r\nOK';
	if (c.startsWith('AT+CGDCONT=')) return 'OK';
	if (c.startsWith('AT+CGACT=')) return 'OK';
	if (c.startsWith('AT^NDISSTATQRY')) return '^NDISSTATQRY: ' + state.ndis + ',1,0,0,0,0,0\r\nOK';
	if (c === 'AT+CGACT?') return '+CGACT: 1,1\r\nOK';
	// 注意前缀：MT5700M 的私有命令带 '^'，与此处其它私有命令
	// （AT^NDISSTATQRY / AT^SETMODE / AT^TDCFG）一致。此前这里少写了一个 '^'，
	// 基于 mock 的联调永远看不到自动拨号成功，把真实缺陷掩盖成夹具缺陷。
	if (c === 'AT^SETAUTODIAL?') {
		return '^SETAUTODIAL: ' + state.autodial + ',' + state.autodialMode + ',"IP","","","",0\r\nOK';
	}
	if (c.startsWith('AT^SETAUTODIAL=')) {
		const m = c.match(/AT\^SETAUTODIAL=(\d+)(?:,(\d+))?/);
		if (m) {
			state.autodial = parseInt(m[1], 10);
			if (m[2] !== undefined) state.autodialMode = parseInt(m[2], 10);
		}
		return 'OK';
	}
	if (c === 'AT^SETMODE?') return '^SETMODE: 2,0,3\r\nOK';
	if (c.startsWith('AT^SETMODE=')) return 'OK';
	if (c === 'AT^TDCFG?') return '^TDCFG: 1,1,1,1\r\nOK';
	if (c.startsWith('AT^TDCFG=')) return 'OK';
	if (c === 'AT^IPFILTERSWITCH=0' || c === 'AT^IPFILTERSWITCH?') return 'OK';
	if (c === 'AT^DMZ=0') return 'OK';
	if (c.startsWith('AT^DMZ=')) return 'OK';
	if (c === 'AT^CONNECT?') return '+CONNECT: 0\r\nOK';
	if (c === 'AT^SYSCFGEX?') return '^SYSCFGEX: 1,0,1,1,1,2FFFFFFFFFFFFFFFF,0,0,0,0,0,0,0\r\nOK';
	if (c.startsWith('AT^SYSCFGEX=')) return 'OK';
	if (c === 'AT^PHYNUM?') return '^PHYNUM: 0,0\r\nOK';
	if (c === 'AT^SCICHG?') return '^SCICHG: 0\r\nOK';
	if (c.startsWith('AT^SCICHG=')) return 'OK';
	if (c === 'AT^HVSST?') return '^HVSST: 1,1,1,1\r\nOK';
	if (c === 'AT^TDSIMHP?') return '^TDSIMHP: 1\r\nOK';
	if (c.startsWith('AT^TDSIMHP=')) return 'OK';
	if (c === 'AT+CLCK?') return '+CLCK: "SC",1\r\nOK';
	if (c.startsWith('AT+CLCK=')) return 'OK';
	if (c === 'AT+CPWD?') return '+CPWD: "SC",8\r\nOK';
	if (c.startsWith('AT+CPWD=')) return 'OK';
	if (c === 'AT^TDPCIELANCFG?') return '^TDPCIELANCFG: 0,0\r\nOK';
	if (c === 'AT^TDPMCFG?') return '^TDPMCFG: 0,0,0\r\nOK';
	if (c === 'AT^NRRCCAPQRY?') return '^NRRCCAPQRY: 1,1,1,0,0\r\nOK';
	if (c.startsWith('AT^NRRCCAPCFG=')) return 'OK';
	if (c === 'AT^THERMAUTOFUN?') return '^THERMAUTOFUN: 1,85,0,0\r\nOK';
	// 手册 13.27 ^MONSSC：NSA 辅站（PCI 十六进制 0x86=134，RSRP -70 在合法区间原样用）
	if (c === 'AT^MONSSC') return '^MONSSC: "NR",2360,86,-70,-10,15,0\r\nOK';
	// 手册 13.18 ^CASCELLINFO?：LTE CA 辅小区（12 字段，dlbw=3→10MHz，dlfreq 17500=1750.0MHz）
	if (c === 'AT^CASCELLINFO?') return '^CASCELLINFO: 0,120,-75,-95,-12,3,1650,1750,16500,17500,3,3\r\nOK';
	// 手册 6.6 ^SIMSQ
	if (c === 'AT^SIMSQ?') return '^SIMSQ: 0,12\r\nOK';
	if (c === 'AT^THERMLDAUTOPARA?') return '^THERMLDAUTOPARA: 80,85,90,95,100,105,110,115,120\r\nOK';
	if (c === 'AT^THERMLDAUTOSTATUS?') return '^THERMLDAUTOSTATUS: 1,0,0,0,0,1\r\nOK';
	if (c.startsWith('AT^THERM')) return 'OK';
	/* AT&F / AT+RESET / AT^RESET 已由上面的 FORBIDDEN 护栏拦截，此处刻意不实现 */
	if (c === 'AT+CGMR') return 'MT5700M_CN_A0_V002\r\nOK';
	if (c === 'AT^FOTASTATE?') return '^FOTASTATE: 0\r\nOK';
	if (c.startsWith('AT^FOTA')) return 'OK';
	if (c === 'AT^CELLSCAN=STATE') return '^CELLSCAN: 0,0\r\nOK';
	if (c === 'AT^CELLSCAN=ABORT') return '^CELLSCAN: 0,0\r\nOK';
	if (c.startsWith('AT^CELLSCAN=')) return '^CELLSCAN: 0,0\r\nOK';
	if (c === 'AT+NWTIME?') return '+NWTIME: 25/09/10,10:30:00+32\r\nOK';
	if (c === 'AT+CMGS=0') return 'ERROR'; // 实际发送由带 \rPDU 的命令触发
	if (c.startsWith('AT+CMGS=')) return '\r\nOK';
	if (c === 'AT+CMGS') return '>';
	if (c === 'AT+CUSD') return 'ERROR';
	if (c.startsWith('AT+CUSD=')) return '\r\nOK';
	if (c.startsWith('AT+SCHED') || c.startsWith('AT^CELLSCAN')) return 'ERROR'; // 伪命令由后端处理
	// 通用回显未知命令
	return 'ERROR';
}

// 测试触发命令：返回特殊标记让 socket 层执行推送
function specialAction(c) {
	if (c === 'AT+TESTPUSH=1') return 'push-call';
	if (c === 'AT+TESTPUSH=2') return 'push-sms';
	/* AT+TESTPUSH=2,<索引>：指定要推送哪一条存储短信（默认按收件箱顺序轮换） */
	if (/^AT\+TESTPUSH=2,\d+$/.test(c)) return 'push-sms';
	if (c === 'AT+TESTPUSH=3') return 'push-rejinfo';
	if (c === 'AT+TESTPUSH=4') return 'push-hangup';
	return null;
}

/* 从 AT+TESTPUSH=2[,<索引>] 里取出要读的短信索引 */
function smsIndexFrom(c) {
	const m = /^AT\+TESTPUSH=2,(\d+)$/.exec(c);
	return m ? parseInt(m[1], 10) : nextSmsIndex();
}

/* ---------- 连接处理 ---------- */
let connId = 0;
const server = net.createServer(function (socket) {
	const id = ++connId;
	console.log('[mock] client #' + id + ' connected');
	let buf = '';

	const push = function (text) {
		if (!socket.destroyed) socket.write(text);
	};

	/*
	 * 周期性推送：信号变化、伪来电、伪新短信。
	 * MOCK_QUIET=1 时全部关掉 —— 做推送模拟时这些自发 URC 会混进结果，
	 * 让「收到的推送」里出现无法归因的条目。
	 */
	const timers = [];
	if (process.env.MOCK_QUIET !== '1') {
	timers.push(setInterval(function () {
		state.rsrp = state.rsrp + (Math.random() > 0.5 ? 1 : -1);
		push('^HCSQ: 0,0,0,0,17,45,' + Math.abs(state.rsrp) + ',10,14\r\n');
	}, 8000));
	timers.push(setInterval(function () {
		push('+CLIP: "+8613800138000",129,"",0\r\n');
	}, 30000));
	timers.push(setInterval(function () {
		push('+CMTI: "SM",' + nextSmsIndex() + '\r\n');
	}, 45000));
	}

	socket.on('data', function (chunk) {
		buf += chunk.toString('binary');
		// 按 \r 分割命令（AT 命令以 CR 结尾）
		let idx;
		while ((idx = buf.indexOf('\r')) >= 0) {
			const cmd = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (!cmd) continue;
			// 处理 > 提示符后的 PDU（CMGS）
			if (cmd.indexOf('\n') >= 0) {
				// 多行 PDU 内容，仅确认
				console.log('[mock] #' + id + ' PDU: ' + cmd.replace(/\n/g, '\\n').slice(0, 60) + '…');
				push('+CMGS: 1\r\nOK');
				continue;
			}
			console.log('[mock] #' + id + ' < ' + cmd);
			const action = specialAction(cmd);
			if (action === 'push-call') {
				console.log('[mock] #' + id + ' > OK (test push call)');
				push('OK\r\n');
				setTimeout(function () { console.log('[mock] #' + id + ' >push +CLIP'); push('+CLIP: "+8613800138000",129,"",0\r\n'); }, 100);
				continue;
			}
			if (action === 'push-sms') {
				const idx = smsIndexFrom(cmd);
				console.log('[mock] #' + id + ' > OK (test push sms, index ' + idx + ')');
				push('OK\r\n');
				setTimeout(function () {
					console.log('[mock] #' + id + ' >push +CMTI "SM",' + idx);
					push('+CMTI: "SM",' + idx + '\r\n');
				}, 100);
				continue;
			}
			if (action === 'push-hangup') {
			/* 挂断：真实模组在对方挂机时给 NO CARRIER，后端据此发「通话结束」 */
			console.log('[mock] #' + id + ' > OK (test push hangup)');
			push('OK\r\n');
			setTimeout(function () { console.log('[mock] #' + id + ' >push NO CARRIER'); push('NO CARRIER\r\n'); }, 100);
			continue;
		}
		if (action === 'push-rejinfo') {
				console.log('[mock] #' + id + ' > OK (test push rejinfo)');
				push('OK\r\n');
				// 手册 13.14 示例：^REJINFO:46000,1,40,2,3,40,"0026F8","FF","0A444202"
				setTimeout(function () { console.log('[mock] #' + id + ' >push ^REJINFO'); push('^REJINFO:46000,1,40,2,3,40,"0026F8","FF","0A444202"\r\n'); }, 100);
				continue;
			}
			const resp = replyFor(cmd);
			console.log('[mock] #' + id + ' > ' + resp.replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
			push(resp + '\r\n');
			// CMGS 的 > 提示符场景：命令带 PDU 内容时模组返回 OK
		}
	});
	socket.on('error', function () {});
	socket.on('close', function () {
		timers.forEach(clearInterval);
		console.log('[mock] client #' + id + ' disconnected');
	});
});

server.listen(PORT, '0.0.0.0', function () {
	console.log('[mock] MT5700 AT modem simulator listening on 0.0.0.0:' + PORT);
});
