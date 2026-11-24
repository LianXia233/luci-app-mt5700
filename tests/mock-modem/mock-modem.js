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
 *   MOCK_CMGL_TEXT=1  AT+CMGL=4 返回 9.9 的文本模式样本，而非 9.8 的 PDU 夹具。
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
	csca: '+8613800000000',
	imei: '862234051234567',
	rsrp: -95,      // 动态变化用于信号 URC
	ims: '1,1,1',
	/* 数据中心模式（AT+CEUS）：手册 3.15.3 写默认值是 1，但它是「设置后需要开关机生效」
	 * 的持久化项，旧版本应用会写成 0 —— 后端必须先读再决定要不要重启射频，所以这里
	 * 要能真实回读，并用 AT+TESTCEUS=0/1 造出两种设备。 */
	ceus: 1,
	/* 故障注入钩子（AT+TESTCEUSFAIL / AT+TESTCFUN1FAIL / AT+TESTCPMSFAIL / AT+TESTIMSFALSE） */
	faultCeus: false,
	faultCfun1: false,
	faultCpms: false,
	faultIms: false,
	smsSeq: 0,
	// 自动拨号：刻意从「开关已开、但方式为 2（转网口模式）」起步。
	// 只比开关不比方式的实现会判定已对齐而跳过下发，模组停在转网口模式，
	// USB 网口永远拿不到 DHCP —— e2e 用它做回归（见 e2e-test.js 第 10 项）。
	autodial: 1,
	autodialMode: 2,
	/* 自动拨号的 APN 参数（手册 16.18.3）：协议/IP、APN、用户名、密码、鉴权 0=无 1=PAP 2=CHAP */
	dialProtocol: 'IP',
	dialApn: '',
	dialUser: '',
	dialPass: '',
	dialAuth: 0,
	// USB 数据面状态：1=就绪。置 0 会让后端进入重试与周期对账路径。
	ndis: 1,
	/*
	 * AT^TDCFG / AT^IPFILTERSWITCH 的持久化状态（手册 16.23.4、16.24：掉电保存）。
	 * 缺省值全部按手册 16.23.3 的「缺省」标注取：mode=1、PostRoute=0（未配置）、
	 * Dmz="not cfg"、share-pdp=0、IP 过滤=0（未使能）。
	 */
	infcfgMode: 1,
	postRoute: 0,
	dmz: 'not cfg',
	lhcm: '192.168.10.1,255.255.255.0,192.168.10.100,192.168.10.200',
	sharePdp: 0,
	ipFilter: 0,
	/* USB 端口形态（手册 11.8.3）：0=Linux ECM 正常模式，掉电保存，设置后模组重启。 */
	setmode: 0
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
	// ^PHYNUM 在厂商四份文档里根本不存在，历史版本曾拿它写 IMEI：一并拦掉
	/^AT\^PHYNUM/i,
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
	if (c === 'AT+CFUN=1') {
		/* AT+TESTCFUN1FAIL=1 让下一次 AT+CFUN=1 被拒：用于验证后端「关了射频又开不回来」
		 * 时的回滚路径（真实模组在射频异常时确实会拒绝 AT+CFUN=1）。 */
		if (state.faultCfun1) { state.faultCfun1 = false; return '+CME ERROR: 50'; }
		state.cfun = 1; return 'OK';
	}
	if (c === 'AT+CEREG?') return '+CEREG: 0,' + (state.cfun === 1 ? '1' : '2') + '\r\nOK';
	if (c === 'AT+CSQ?') return '+CSQ: 25,99\r\nOK';
	if (c === 'AT^HCSQ?') return '^HCSQ: 0,0,0,0,17,45,25,10,14\r\nOK';
	if (c === 'AT+CGREG?') return '+CGREG: 0,5\r\nOK';
	if (c === 'AT+C5GREG?') return '+C5GREG: 0,5\r\nOK';
	if (c === 'AT+CREG?') return '+CREG: 0,1\r\nOK';
	/* 开短信功能后会轮询到注册恢复；缺了这条，真机会一直等到 15s 预算耗尽 */
	if (c === 'AT+CEREG?') return '+CEREG: 0,' + state.cereg + ',,"00001010","01A1B2C3",7\r\nOK';
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
	if (c === 'AT^MONSC' || c === 'AT^MONSC?') return '^MONSC: NR,460,00,501234,1,C1A2B3C,80,12345,-65,-10,28\r\nOK';
	if (c === 'AT^HFREQINFO?') return '^HFREQINFO: 0,7,41,513000,2565000,100000,0,0,0\r\nOK';
	if (c === 'AT^LENDC?') return '^LENDC: 0,1,10,0,0\r\nOK';
	if (c === 'AT^TXPOWER?') return '^TXPOWER: 0,15,23\r\nOK';
	if (c === 'AT^NTXPOWER?') return '^NTXPOWER: 0,1,20,23\r\nOK';
	if (c === 'AT+CGPADDR') return '+CGPADDR: 1,"10.10.1.2"\r\n+CGPADDR: 2,"2408:8400:8000:0:0:0:0:1"\r\nOK';
	/*
	 * 手册 17.1.1/17.1.5：^CHIPTEMP 恒为 **12 个字段**（sub3G,sub6G,MIMO,TCXO,
	 * peri1,peri2,ap1,ap2,modem1,modem2,bbp1,bbp2），单位 0.1℃，查询失败填 65535。
	 * 夹具用手册例句，确保前端按下标取数时 12 项都能对齐（只回一个数字会让
	 * 除 sub3GPA 之外的温度全部读不到，掩盖字段错位）。
	 */
	if (c === 'AT^CHIPTEMP?') return '^CHIPTEMP: 368,364,362,365,360,360,380,400,380,400,360,370\r\nOK';
	if (c === 'AT+CPIN?') return '+CPIN: READY\r\nOK';
	/*
	 * 短信列表与单条读取喂**动态夹具**（sms-fixtures.js），与短信中心渲染测试同源。
	 * 这两条应答的读者是后端的 PDU 解析（Rust pdu::parse_cmgl_response），形状必须严格按
	 * 手册 9.8.1 / 9.10.1 —— 夹具一旦写成文本模式的样子，后端解析器就被 mock 哄着跑。
	 * MOCK_CMGL_TEXT=1 时改回 9.9 的文本模式样本，覆盖「模组回了不该回的形状」这一路。
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
	/* 手册 8.1.3：<mem> 只有 "SM"（(U)SIM）与 "ME"（FLASH）两个值，模型不编 MT。 */
	if (c === 'AT^CPMS?') return '^CPMS: "SM",' + SMS_LIST.length + ',50,"SM",' + SMS_LIST.length + ',50,"ME",0,50\r\nOK';
	if (c === 'AT+CPMS?') return '+CPMS: "SM",' + SMS_LIST.length + ',50,"SM",' + SMS_LIST.length + ',50,"ME",0,50\r\nOK';
	if (c.startsWith('AT+CPMS=')) {
		/* AT+TESTCPMSFAIL=1：切到 SM 时被拒（手册里 +CME ERROR: 4 = 操作不允许），
		 * 用于验证「清空全部短信」部分失败时 deleted 与 errors 同时可见。 */
		if (state.faultCpms && c.indexOf('"SM"') >= 0) return '+CME ERROR: 4';
		return 'OK';
	}
	if (c === 'AT+CMGD=1,4') return 'OK';
	if (c.startsWith('AT+CMGD=')) return 'OK';
	if (c === 'AT^IMSSWITCH?') return '^IMSSWITCH: ' + state.ims + '\r\nOK';
	if (c.startsWith('AT^IMSSWITCH=')) {
		/* AT+TESTIMSFALSE=1：IMSSWITCH 被拒（手册 4.10.1 的失败原因，308=当前状态不允许）。
		 * 手册 4.10.2 还规定它「需要在上电初次开机后才能设置」，射频刚恢复时最容易撞上。 */
		if (state.faultIms && c.startsWith('AT^IMSSWITCH=1')) return '+CME ERROR: 308';
		const m = c.match(/AT\^IMSSWITCH=([^,]+)/); if (m) state.ims = m[1] + ',0,0'; return 'OK';
	}
	if (c === 'AT+CEUS?') return '+CEUS: ' + state.ceus + '\r\nOK';
	if (c === 'AT+CEUS=1') {
		/* AT+TESTCEUSFAIL=1：数据中心模式写不进去（手册 3.15 里的「设置失败」场景）。 */
		if (state.faultCeus) return '+CME ERROR: 3';
		state.ceus = 1; return 'OK';
	}
	if (c === 'AT+CEUS=0') { if (state.faultCeus) return '+CME ERROR: 3'; state.ceus = 0; return 'OK'; }
	/* ---------- 测试钩子（仅 mock，真实模组没有这些命令） ---------- */
	if (c === 'AT+TESTCEUS=0') { state.ceus = 0; return 'OK'; }
	if (c === 'AT+TESTCEUS=1') { state.ceus = 1; return 'OK'; }
	if (c === 'AT+TESTCEUSFAIL=1') { state.faultCeus = true; return 'OK'; }
	if (c === 'AT+TESTCEUSFAIL=0') { state.faultCeus = false; return 'OK'; }
	if (c === 'AT+TESTCFUN1FAIL=1') { state.faultCfun1 = true; return 'OK'; }
	if (c === 'AT+TESTCFUN1FAIL=0') { state.faultCfun1 = false; return 'OK'; }
	if (c === 'AT+TESTCPMSFAIL=1') { state.faultCpms = true; return 'OK'; }
	if (c === 'AT+TESTCPMSFAIL=0') { state.faultCpms = false; return 'OK'; }
	if (c === 'AT+TESTIMSFALSE=1') { state.faultIms = true; return 'OK'; }
	if (c === 'AT+TESTIMSFALSE=0') { state.faultIms = false; return 'OK'; }
	if (c === 'AT^LTEFREQLOCK?') return '^LTEFREQLOCK: 0,0,0,""\r\nOK';
	if (c.startsWith('AT^LTEFREQLOCK=')) return 'OK';
	if (c === 'AT^NRFREQLOCK?') return '^NRFREQLOCK: 0,0,0,""\r\nOK';
	if (c.startsWith('AT^NRFREQLOCK=')) return 'OK';
	/* 手册 13.17：私有前缀是 ^C5GOPTION，且插件只查询、从不写入 —— 早先这里留过
	 * 一条 `AT+C5GOPTION=0,1,0` 的写入夹具（前缀写错成 +，也没有调用方），删掉。 */
	if (c === 'AT^C5GOPTION?') return '^C5GOPTION: 0,1,0\r\nOK';
	if (c === 'AT^SYSINFO?') return '^SYSINFO: 0,7,2,0\r\nOK';
	if (c === 'AT+CGDCONT?') return '+CGDCONT: 1,"IP","ims","",0,0,0,0,1,1,1\r\nOK';
	if (c.startsWith('AT+CGDCONT=')) return 'OK';
	if (c.startsWith('AT+CGACT=')) return 'OK';
	/* 手册 16.4.1/16.4.5：^NDISSTATQRY? 回 "<cid>,<stat>,<err>,<wx_state>,<PDP_type>[,<stat>,…]"，
	 * 形如 ^NDISSTATQRY: 1,1,,,"IPV4",0,,,"IPV6" —— 首字段是 CID，第二字段才是状态。
	 * 夹具此前把 state.ndis 放在首字段（等于永远告诉调用方「CID 就是 ndis 的值」），
	 * 正好掩盖了解析端「按首字段判连接」的错误，现在按手册形状回。 */
	if (c.startsWith('AT^NDISSTATQRY')) {
		return '^NDISSTATQRY: 1,' + state.ndis + ',,,"IPV4",0,,,"IPV6"\r\nOK';
	}
	if (c === 'AT+CGACT?') return '+CGACT: 1,1\r\nOK';
	// 注意前缀：MT5700M 的私有命令带 '^'，与此处其它私有命令
	// （AT^NDISSTATQRY / AT^SETMODE / AT^TDCFG）一致。此前这里少写了一个 '^'，
	// 基于 mock 的联调永远看不到自动拨号成功，把真实缺陷掩盖成夹具缺陷。
	/*
	 * 手册 16.18.1 的写入形式：
	 *   AT^SETAUTODIAL=<enable>,<dial_mode>,[[<protocol>],[<apn>],[<usrname>,<password>,<authtype>]]
	 * 查询按 16.18.5 的实例回全字段。早先夹具把查询结果写死成 `"IP","","","",0`，
	 * 且无视 enable/dial_mode 的取值范围 —— 前端「写 APN 后回读」这条链路在本地
	 * 永远看到的是同一个串，改没改进模组根本测不出来。现在真实存值并按 16.18.3 校验。
	 */
	if (c === 'AT^SETAUTODIAL?') {
		return '^SETAUTODIAL: ' + state.autodial + ',' + state.autodialMode +
			',"' + state.dialProtocol + '","' + state.dialApn + '","' + state.dialUser +
			'","' + state.dialPass + '",' + state.dialAuth + '\r\nOK';
	}
	if (c.startsWith('AT^SETAUTODIAL=')) {
		var ad = c.slice('AT^SETAUTODIAL='.length).match(/(?:[^,"]+|"[^"]*")+/g) || [];
		var unq = function (v) { return String(v).trim().replace(/^"|"$/g, ''); };
		if (!/^[01]$/.test(unq(ad[0] || ''))) return '+CME ERROR: 3';
		/* 16.18.2：关闭自动拨号时不带 dial_mode */
		if (ad[1] !== undefined && !/^[012]$/.test(unq(ad[1]))) return '+CME ERROR: 3';
		state.autodial = parseInt(unq(ad[0]), 10);
		if (ad[1] !== undefined) state.autodialMode = parseInt(unq(ad[1]), 10);
		if (ad[2] !== undefined) state.dialProtocol = unq(ad[2]);
		if (ad[3] !== undefined) state.dialApn = unq(ad[3]);
		if (ad[4] !== undefined) state.dialUser = unq(ad[4]);
		if (ad[5] !== undefined) state.dialPass = unq(ad[5]);
		if (ad[6] !== undefined) {
			if (!/^[012]$/.test(unq(ad[6]))) return '+CME ERROR: 3';
			state.dialAuth = parseInt(unq(ad[6]), 10);
		}
		return 'OK';
	}
	/*
	 * 手册 11.8：查询应答是 "^SETMODE: <mode>"（11.8.1），11.8.5 的举例又只回裸数字；
	 * 两种都可能在真机上出现，这里按 11.8.1 的规范形态回，让前端的兼容解析真正被覆盖。
	 * <mode> 取 0~6、8（11.8.3），7=Windows MBIM 标注「暂不支持」，真机会拒绝，夹具同样拒绝。
	 */
	if (c === 'AT^SETMODE?') return '^SETMODE: ' + state.setmode + '\r\nOK';
	if (c.startsWith('AT^SETMODE=')) {
		var sm = c.slice('AT^SETMODE='.length).trim();
		if (!/^[0-68]$/.test(sm)) return '+CME ERROR: 3';
		state.setmode = parseInt(sm, 10);
		return 'OK';
	}
	/*
	 * 手册 16.23.1 的查询结果不是逗号串，而是「^TDCFG:」空行头 + 5 行键值文本：
	 *   Mode : <v> / Dmz : <v> / PostRoute：<v> / LHCM: <4 段> / Share-pdp：<v>
	 * 16.23.5 的示例又写成半角冒号（PostRoute: 1），两种冒号都可能出现在真机上。
	 * 早先夹具回的是 '^TDCFG: 1,1,1,1'，dial.js 的键值解析在本地联调里永远读不到值，
	 * DMZ 也永远显示「未配置」——现在按手册形状回，并按 16.23.2/16.23.3 校验写入。
	 */
	if (c === 'AT^TDCFG?') {
		return '^TDCFG:\r\n' +
			'Mode : ' + state.infcfgMode + '\r\n' +
			'Dmz : ' + state.dmz + '\r\n' +
			'PostRoute：' + state.postRoute + '\r\n' +
			'LHCM: ' + state.lhcm + '\r\n' +
			'Share-pdp：' + state.sharePdp + '\r\n' +
			'OK';
	}
	if (c.startsWith('AT^TDCFG=')) {
		var tdcfg = c.slice('AT^TDCFG='.length())
			.match(/^"infcfg"\s*,\s*"([^"]+)"\s*,\s*(.*)$/);
		if (!tdcfg) return '+CME ERROR: 3';
		var tdfunc = tdcfg[1].toLowerCase();
		var tdval = tdcfg[2].trim();
		if (tdfunc === 'mode') {
			if (tdval !== '1' && tdval !== '2') return '+CME ERROR: 3';
			state.infcfgMode = parseInt(tdval, 10);
			return 'OK';
		}
		if (tdfunc === 'postroute') {
			if (!/^[012]$/.test(tdval)) return '+CME ERROR: 3';
			if (tdval === '1' && state.dmz !== 'not cfg') return '+CME ERROR: 3';
			state.postRoute = parseInt(tdval, 10);
			return 'OK';
		}
		if (tdfunc === 'dmz') {
			var host = (tdval.match(/^"([^"]*)"$/) || [])[1];
			if (host === undefined) return '+CME ERROR: 3';
			/* 16.23.3：'0' 删除配置，否则必须是 IPv4 地址；16.23.2：与后路由互斥 */
			if (host !== '0' && !/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)) return '+CME ERROR: 3';
			if (host !== '0' && state.postRoute === 1) return '+CME ERROR: 3';
			state.dmz = host === '0' ? 'not cfg' : host;
			return 'OK';
		}
		if (tdfunc === 'share-pdp') {
			if (!/^[01]$/.test(tdval)) return '+CME ERROR: 3';
			state.sharePdp = parseInt(tdval, 10);
			return 'OK';
		}
		if (tdfunc === 'lhcm') {
			state.lhcm = tdval;
			return 'OK';
		}
		return '+CME ERROR: 3';
	}
	/* 手册 16.24.1：查询回 "^IPFILTERSWITCH: <switch>"，缺省 0=未使能 */
	if (c === 'AT^IPFILTERSWITCH?') return '^IPFILTERSWITCH: ' + state.ipFilter + '\r\nOK';
	if (c === 'AT^IPFILTERSWITCH=0') { state.ipFilter = 0; return 'OK'; }
	if (c === 'AT^IPFILTERSWITCH=1') { state.ipFilter = 1; return 'OK'; }
	if (c === 'AT^CONNECT?') return '+CONNECT: 0\r\nOK';
	if (c === 'AT^SYSCFGEX?') return '^SYSCFGEX: 1,0,1,1,1,2FFFFFFFFFFFFFFFF,0,0,0,0,0,0,0\r\nOK';
	if (c.startsWith('AT^SYSCFGEX=')) return 'OK';
	if (c === 'AT^SCICHG?') return '^SCICHG: 0\r\nOK';
	if (c.startsWith('AT^SCICHG=')) return 'OK';
	if (c === 'AT^HVSST?') return '^HVSST: 1,1,1,1\r\nOK';
	if (c === 'AT^TDSIMHP?') return '^TDSIMHP: 1\r\nOK';
	if (c.startsWith('AT^TDSIMHP=')) return 'OK';
	if (c === 'AT+CLCK?') return '+CLCK: "SC",1\r\nOK';
	if (c.startsWith('AT+CLCK=')) return 'OK';
	if (c === 'AT+CPWD?') return '+CPWD: "SC",8\r\nOK';
	if (c.startsWith('AT+CPWD=')) return 'OK';
	/*
	 * 手册 11.19 / 11.16 的严格参数形状（夹具要像真机一样拒绝参数不足的写入，
	 * 否则早先那种 `AT^TDPMCFG=1`（缺 3 个保留位）的错误命令在本地永远是绿的）：
	 *   AT^TDPMCFG=<mode>,<mode>,<mode>,<mode>   目前只有 byte[0]=PCIe 有效，每位 0/1
	 *   AT^TDPCIELANCFG=<n>                      n 只能是 1(RTL8111 1G) / 2(RTL8125 2.5G)
	 * 读命令：^TDPMCFG 回 4 个字段，^TDPCIELANCFG 回 1 个字段。
	 */
	if (c.startsWith('AT^TDPMCFG=')) {
		var pm = c.slice('AT^TDPMCFG='.length).split(',').map(function (v) { return v.trim(); });
		if (pm.length !== 4 || pm.some(function (v) { return !/^[01]$/.test(v); })) return '+CME ERROR: 3';
		return 'OK';
	}
	if (c.startsWith('AT^TDPCIELANCFG=')) {
		var pv = c.slice('AT^TDPCIELANCFG='.length).trim();
		if (pv !== '1' && pv !== '2') return '+CME ERROR: 3';
		return 'OK';
	}
	if (c === 'AT^TDPCIELANCFG?') return '^TDPCIELANCFG: 1\r\nOK';
	if (c === 'AT^TDPMCFG?') return '^TDPMCFG: 1,0,0,0\r\nOK';
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
	/*
	 * FOTA 状态机（手册 15.5.3 + 《FOTA 升级指南》4.1.1）：
	 * OEMDL 在 IDLE(10) 下发后随 FOTASTATE? 轮询推进 11→12→30，30 期间每次
	 * FOTADLQ 前进约 5%，下满即 40；FWUP 仅在 40 接受并进入 50；FOTADL=0 取消
	 * 回 10；FOTADL=1 从 31 续传回 30。12 的版本号按指南示例**不带引号**
	 * （`12,V100R001C00B002,6129664,…`），防止前端解析只认手册带引号形态的回归。
	 */
	const FOTA_PKG_SIZE = 68315612;   // 指南 4.1.1 FOTADLQ 示例的 file_size
	const FOTA_STEP = 3451955;        // 每次进度查询前进约 5%
	if (c === 'AT^FOTASTATE?') {
		if (!state.fota) state.fota = { st: 10, polls: 0, dl: 0 };
		var f = state.fota;
		f.polls++;
		if (f.st === 11 && f.polls >= 2) { f.st = 12; f.polls = 0; }
		else if (f.st === 12 && f.polls >= 2) { f.st = 30; f.polls = 0; }
		else if (f.st === 30 && f.dl >= FOTA_PKG_SIZE) { f.st = 40; f.polls = 0; }
		var extra = f.st === 12
			? ',V100R001C00B002,6129664,1.product_name="MT5700M-CN";2.update_mode="0";3.source_version="V100R001C00B002";en-us'
			: '';
		return '^FOTASTATE: ' + f.st + extra + '\r\nOK';
	}
	if (c === 'AT^FOTADLQ') {
		var f2 = state.fota || (state.fota = { st: 10, polls: 0, dl: 0 });
		if (f2.st === 30) f2.dl = Math.min(FOTA_PKG_SIZE, f2.dl + FOTA_STEP);
		/* 指南示例原文拼写就是 FIRMWARM1，照抄以校验解析不依赖文件名字符串 */
		return '^FOTADLQ: 1,"FIRMWARM1",' + f2.dl + ',' + FOTA_PKG_SIZE + '\r\nOK';
	}
	if (c.startsWith('AT^FOTAOEMDL=')) {
		var f3 = state.fota || (state.fota = { st: 10, polls: 0, dl: 0 });
		if (f3.st !== 10) return '+CME ERROR: 54';   // 指南：非 IDLE 下发撞冲突态
		f3.st = 11; f3.polls = 0; f3.dl = 0;
		return 'OK';
	}
	if (c === 'AT^FOTADL=0') {
		var f4 = state.fota;
		if (f4 && f4.st >= 30 && f4.st <= 40) { f4.st = 10; f4.dl = 0; f4.polls = 0; return 'OK'; }
		return '+CME ERROR: 3';
	}
	if (c === 'AT^FOTADL=1') {
		var f5 = state.fota;
		if (f5 && f5.st === 31) { f5.st = 30; return 'OK'; }
		return '+CME ERROR: 3';
	}
	/* AT^FOTAFAULT=SUSPEND/QUERYFAIL/DLFAIL/UPFAIL：故障注入，验证前端挂起续传与失败链路 */
	if (c.startsWith('AT^FOTAFAULT=')) {
		var mode = c.slice('AT^FOTAFAULT='.length);
		var f6 = state.fota || (state.fota = { st: 10, polls: 0, dl: 0 });
		if (mode === 'SUSPEND' && f6.st === 30) { f6.st = 31; return 'OK'; }
		if (mode === 'QUERYFAIL') { f6.st = 13; return 'OK'; }
		if (mode === 'DLFAIL') { f6.st = 20; return 'OK'; }
		if (mode === 'UPFAIL' && f6.st === 40) { f6.st = 70; return 'OK'; }
		return '+CME ERROR: 3';
	}
	if (c === 'AT^FWUP') {
		var f7 = state.fota;
		if (f7 && f7.st === 40) { f7.st = 50; return 'OK'; }   // 指南规范：仅 40 后接受
		return 'ERROR';
	}
	if (c.startsWith('AT^FOTA')) return 'OK';   // FOTAMODE 等设置类
	if (c === 'AT^CELLSCAN=STATE') return '^CELLSCAN: 0,0\r\nOK';
	if (c === 'AT^CELLSCAN=ABORT') return '^CELLSCAN: 0,0\r\nOK';
	if (c.startsWith('AT^CELLSCAN=')) return '^CELLSCAN: 0,0\r\nOK';
	/* 手册 13.8：私有前缀是 ^NWTIME，格式 <yy/MM/dd>,<hh:mm:ss±tz>,<dt>（tz 单位 15 分钟，+32=东八区） */
	if (c === 'AT^NWTIME?') return '^NWTIME: 25/09/10,10:30:00+32,00\r\nOK';
	if (c === 'AT+CMGS=0') return 'ERROR'; // 零长度 TPDU 非法，真实模组直接拒绝
	/*
	 * 一次性提交：`AT+CMGS=<len>` + **字面的 `\r`**（反斜杠 + 字母 r 两个字符）+ <PDU>。
	 * 这是手册 9.14.5 的举例形态（`AT+CMGS=18\r0011…`，并注明「使用 SSCOM 工具时
	 * 对应的 "\r" 应改为 "\\r"」），也是厂商 WebUI 实际下发的形态，同一台模组的
	 * 实机对照：
	 *   字面 `\r` 分隔 → 立即 `+CMGS: <mr>` / OK，全程没有 `> ` 提示符、不需要 Ctrl+Z；
	 *   真实 CR 分隔（长度与 PDU 一次写完）→ 只回显命令，随后静默。
	 * `<len>` 是**不含 SMSC 字段**的 TPDU 字节数（9.14.3／9.14.5：18 配 19 字节 PDU），
	 * 所以整条 PDU 的字节数应为 len+1；对不上就是编码侧写错了，按真实模组回 ERROR。
	 */
	const oneShot = /^AT\+CMGS=(\d+)\\r([0-9A-Fa-f]*)$/.exec(c);
	if (oneShot) {
		const hex = oneShot[2];
		if (hex.length % 2 !== 0 || hex.length / 2 !== Number(oneShot[1]) + 1) return 'ERROR';
		return '+CMGS: 1\r\nOK';
	}
	/*
	 * AT+CMGS=<len>（只报长度，等提示符）与 PDU 提交不在 replyFor 里处理：前者要回
	 * **无换行结尾**的 `> ` 提示符（replyFor 的返回值会被统一补 \r\n，会破坏提示符
	 * 语义），后者要以 Ctrl+Z(0x1A) 结尾才提交。两者都在 socket 数据层按真实模组的
	 * 两段式协议处理，见下面的连接处理部分。
	 */
	if (c.startsWith('AT+CMGS')) return 'ERROR'; // 裸 AT+CMGS / 真 CR 拼 PDU 的形态：模组不认
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
	/* 两段式提交的第二步标记：回过 `> ` 提示符之后，模组处在「只收 PDU」的
	 * 输入态，此时进来的行不是命令。见下面 socket.on('data') 里的处理。 */
	let awaitingPdu = false;

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
		/*
		 * CMGS 提交的几种形态，与这台真实模组逐字节对齐（手册 9.14.1／9.14.5）：
		 *   一次性 `AT+CMGS=<len>` + 字面 `\r` + <PDU> → 直接 `+CMGS: <mr>` / OK。
		 *     整段里没有真实 CR，所以在下面按 CR 切行时它是完整的一条命令，
		 *     由 replyFor 处理；模组这条路径不给 `> ` 提示符，也不需要 Ctrl+Z。
		 *   两段式第一步 `AT+CMGS=<len>` → 回 `\r\n> ` 输入提示符。
		 *     注意**结尾不能带换行** —— 后端的 consume() 正是靠「行尾残留全是空白
		 *     与 >」识别提示符并结束本次应答，补了 \r\n 就退化成一条普通 OK，
		 *     测不出提示符路径。这条路只为「一次性形态被本地 ERROR 拒掉之后的
		 *     两段式重试」（sms::needs_two_step_fallback）服务。
		 *   两段式第二步 <PDU hex> + Ctrl+Z(0x1A) → 回 `+CMGS: <mr>\r\nOK\r\n`。
		 *     结尾的 `\r\n` 不能省：后端按 `\n` 切行，只有 `OK` 单独成行才会触发
		 *     终止符结束应答；少了它应答会被截断成半条 `+CMGS: 1`。
		 *   输入态里进来一段**没有 Ctrl+Z** 的数据 → 什么都不回。这正是实机上
		 *     「长度 + 真 CR + PDU + CR 一次写完」的结局：PDU 被当成输入态数据
		 *     吃掉，等不到提交字符就一直静默。issue #19「显示成功但发不出去」
		 *     同属此类，mock 必须复现这份沉默，否则测试会以为任何写法都能拿到回执。
		 */
		if (awaitingPdu && !/^AT/.test(cmd)) {
			if (cmd.indexOf('\x1a') >= 0) {
				awaitingPdu = false;
				const shown = cmd.replace(/\x1a/g, '<^Z>');
				console.log('[mock] #' + id + ' PDU submit: ' + shown.slice(0, 60) + (shown.length > 60 ? '…' : ''));
				push('+CMGS: 1\r\nOK\r\n');
			} else {
				console.log('[mock] #' + id + ' PDU 输入态、无 Ctrl+Z：不回任何应答（复现实机沉默）');
			}
			continue;
		}
		/* 输入态下又进来一条 AT 命令：按「上一条已作废」处理，退出输入态。
		 * 真实模组会把这一行也当成 PDU 数据吃掉，但测试用的模组模型需要能自愈：
		 * 后端超时后不会补发 Ctrl+Z，不清状态会连累后面所有用例。 */
		awaitingPdu = false;
		if (/^AT\+CMGS=\d+$/.test(cmd)) {
			if (cmd === 'AT+CMGS=0') {
				console.log('[mock] #' + id + ' < ' + cmd + '  > ERROR');
				push('ERROR\r\n');
				continue;
			}
			console.log('[mock] #' + id + ' < ' + cmd + '  > (prompt)');
			awaitingPdu = true;
			push('\r\n> ');
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
