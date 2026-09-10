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
 */
'use strict';

const net = require('net');

const PORT = parseInt(process.argv[2], 10) || 20249;

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
	smsSeq: 0
};

/* ---------- 应答表 ---------- */
function replyFor(cmd) {
	const c = cmd.replace(/\r/g, '');
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
	if (c === 'AT^MONSC?') return '^MONSC: 0,460,01,0,250,29001,119,71,2360,46,20,97,0\r\nOK';
	if (c === 'AT^HFREQINFO?') return '^HFREQINFO: 0,2360,46,0,97,0\r\nOK';
	if (c === 'AT^LENDC?') return '^LENDC: 0,1,10,0,0\r\nOK';
	if (c === 'AT^TXPOWER?') return '^TXPOWER: 0,15,23\r\nOK';
	if (c === 'AT^NTXPOWER?') return '^NTXPOWER: 0,1,20,23\r\nOK';
	if (c === 'AT+CGPADDR') return '+CGPADDR: 1,"10.10.1.2"\r\n+CGPADDR: 2,"2408:8400:8000:0:0:0:0:1"\r\nOK';
	if (c === 'AT^CHIPTEMP?') return '^CHIPTEMP: 42\r\nOK';
	if (c === 'AT+CPIN?') return '+CPIN: READY\r\nOK';
	if (c === 'AT+CMGL=4') {
		state.smsSeq++;
		if (state.smsSeq <= 1) return '';
		// 第 2 次起给一条短信（PDU 或文本行）
		return '+CMGL: 1,"REC READ","+8613800138000",,"25/09/10,10:30:00+32"\r\n你好，这是测试短信。\r\nOK';
	}
	if (c.startsWith('AT+CMGR=')) {
		// SMS-DELIVER PDU（GSM7 "hello"，来自 Rust pdu.rs 测试用例）
		return '+CMGR: "REC READ",24\r\n00040B913108108300F000005280522100002305E8329BFD06';
	}
	if (c === 'AT+CSCA?') return '+CSCA: "' + state.csca + '",145\r\nOK';
	if (c.startsWith('AT+CSCA=')) { const m = c.match(/AT\+CSCA="([^"]+)"/); if (m) state.csca = m[1]; return 'OK'; }
	if (c === 'AT^CPMS?') return '^CPMS: "SM",1,50,"SM",1,50,"MT",1,50\r\nOK';
	if (c === 'AT+CPMS?') return '+CPMS: "SM",1,50,"SM",1,50,"MT",1,50\r\nOK';
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
	if (c.startsWith('AT^NDISSTATQRY')) return '^NDISSTATQRY: 1,1,0,0,0,0,0\r\nOK';
	if (c === 'AT+CGACT?') return '+CGACT: 1,1\r\nOK';
	if (c === 'AT+SETAUTODIAL?') return '+SETAUTODIAL: 1\r\nOK';
	if (c.startsWith('AT+SETAUTODIAL=')) return 'OK';
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
	if (c === 'AT&F') return 'OK';
	if (c === 'AT+RESET' || c === 'AT^RESET') return 'OK';
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
	if (c === 'AT+TESTPUSH=3') return 'push-rejinfo';
	return null;
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

	// 周期性推送：信号变化、伪来电、伪新短信
	const timers = [];
	timers.push(setInterval(function () {
		state.rsrp = state.rsrp + (Math.random() > 0.5 ? 1 : -1);
		push('^HCSQ: 0,0,0,0,17,45,' + Math.abs(state.rsrp) + ',10,14\r\n');
	}, 8000));
	timers.push(setInterval(function () {
		push('+CLIP: "+8613800138000",129,"",0\r\n');
	}, 30000));
	timers.push(setInterval(function () {
		state.smsSeq++;
		push('+CMTI: "SM",' + state.smsSeq + '\r\n');
	}, 45000));

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
				console.log('[mock] #' + id + ' > OK (test push sms)');
				push('OK\r\n');
				setTimeout(function () { state.smsSeq++; console.log('[mock] #' + id + ' >push +CMTI ' + state.smsSeq); push('+CMTI: "SM",' + state.smsSeq + '\r\n'); }, 100);
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
