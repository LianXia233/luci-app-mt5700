'use strict';
/**
 * 短信夹具：本地模拟「短信中心显示」与「短信推送」共用的真实 PDU 样本。
 *
 * 为什么必须是 PDU 而不是文本行：
 *   AT+CMGL=4 的文本形式（`+CMGL: 1,"REC READ","+86...",,"25/09/10,10:30:00+32"`）
 *   只带一个 stat 字段，方向要靠 stat 猜；而短信中心「收到 / 发出」分区的依据是
 *   PDU 首字节的 TP-MTI。要验证分区，就必须喂带 MTI 的 PDU。
 *   文本形式的方向判定仍由既有夹具（mock-modem.js 的 legacy 分支）覆盖。
 *
 * 时间基准：TP-SCTS 与绝对格式 TP-VP 都按「北京时间 = 当前时刻 + 偏移」动态生成。
 *   跑测试时看到的排序就是真实的相对顺序，不会因为写死旧日期而失去意义；
 *   同时这些时间戳本身就是「北京时间」口径的样本（时区字节 +8h = 32 个 15 分钟）。
 *
 * 本文件是**唯一来源**：mock 模组（AT+CMGR/AT+CMGL）与前端渲染测试都 require 它，
 * 避免两处各写一份样本后慢慢漂移。
 */

/* ---------- 编码基础 ---------- */

/* 两位十进制 → 交换半字节后的 hex（PDU 的地址长度、SCTS 各字段都用它） */
function bcd2(n) {
	var s = ('0' + (Math.abs(n) % 100)).slice(-2);
	return s.charAt(1) + s.charAt(0);
}

/* 纯二进制字节 → 两位 hex（TP-PID / TP-DCS / TP-UDL 等不走 BCD） */
function hex2(n) {
	return (n & 0xFF).toString(16).toUpperCase().padStart(2, '0');
}

/*
 * 号码 → PDU 地址字段：<数字个数><TON/NPI><数字对(交换半字节)>
 * 前面带 + 视为国际号码，TON/NPI = 0x91；否则国内 0x81。
 *
 * 长度字节是**普通二进制**（3GPP TS 23.040：地址长度以半字节计，直接编码），
 * 不是 BCD —— 这一点很容易搞错：SCTS 的每个字段才是交换半字节的 BCD。
 * 写成 BCD（13 → 0x31）会让解码器按 49 个半字节去读地址，直接越界判为非法 PDU。
 */
function addrField(number) {
	var intl = number.charAt(0) === '+';
	var digits = intl ? number.slice(1) : number;
	var len = digits.length;
	if (len % 2) digits += 'F';
	var out = '';
	for (var i = 0; i < digits.length; i += 2) {
		out += digits.charAt(i + 1) + digits.charAt(i);
	}
	return hex2(len) + (intl ? '91' : '81') + out;
}

/* 文本 → UCS2 hex（大端，不交换半字节；BMP 内字符 charCode 即码点） */
function ucs2(text) {
	var out = '';
	for (var i = 0; i < text.length; i++) {
		var c = text.charCodeAt(i);
		out += hex2(c >> 8) + hex2(c & 0xFF);
	}
	return out;
}

/* ---------- 时间 ---------- */

/*
 * UTC+8 = 8 × 4 = 32 个 15 分钟；PDU 时区字节。
 *
 * 这个字节**本身也要交换半字节**（和其它 BCD 字段一样，十位在低半字节）：
 * 32 刻 → "32" → `0x23`。写成 `0x32` 会被读成 "23" 刻 = +345 分钟，
 * 比东八区多 1 小时 45 分，而夹具下面另算的期望显示文本发现不了这一点 ——
 * `check-sms-fixtures.js` 就是为这一格准备的。
 */
var BEIJING_TZ_QUARTERS = 32;

/*
 * 「北京时间」的日历字段。
 * 刻意走 getUTC* + 手动加 8 小时，而不是 new Date().getHours()：
 * 后者取决于跑测试的机器时区，在不同机器上会给出不同的样本。
 */
function beijingParts(offsetMinutes) {
	var d = new Date(Date.now() + offsetMinutes * 60000 + 8 * 3600 * 1000);
	return {
		year: d.getUTCFullYear() % 100,
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds()
	};
}

/* 7 字节 TP-SCTS / 绝对格式 TP-VP：YY MM DD HH MM SS TZ（全部交换半字节） */
function timestampHex(parts) {
	return bcd2(parts.year) + bcd2(parts.month) + bcd2(parts.day)
		+ bcd2(parts.hour) + bcd2(parts.minute) + bcd2(parts.second)
		+ bcd2(BEIJING_TZ_QUARTERS);
}

/* ---------- PDU 构造 ---------- */

/*
 * SMS-DELIVER（对方发来的）：有 TP-SCTS，时间去信。
 * 结构：<SCA 00><first octet><TP-OA><TP-PID><TP-DCS><TP-SCTS><TP-UDL><TP-UD>
 */
function buildDeliver(number, text, offsetMinutes, opts) {
	opts = opts || {};
	var ud = ucs2(text);
	/* bit6 = TP-UDHI；bit2 = TP-MMS（还有更多消息） */
	var first = opts.udhi ? 0x44 : 0x04;
	return '00'
		+ hex2(first)
		+ addrField(number)
		+ '00'                                   /* TP-PID：普通短消息 */
		+ '08'                                   /* TP-DCS：UCS2 */
		+ timestampHex(beijingParts(offsetMinutes))
		+ hex2(ud.length / 2)                    /* TP-UDL：UCS2 以字节计 */
		+ ud;
}

/*
 * SMS-SUBMIT（本机发出的）：没有发送时刻，只有 TP-VP 有效期。
 *   opts.vpOffsetMinutes 省略 → TP-VPF = 相对格式（1 字节），解不出绝对时间，
 *                              前端会显示「时间未知」（这正是插件自己发信用的格式）；
 *   给数值          → TP-VPF = 绝对格式（7 字节），能解出时间但语义是「有效期截止」，
 *                              前端会标注「（有效期时间，非发送时刻）」。
 * 结构：<SCA 00><first octet><TP-MR><TP-DA><TP-PID><TP-DCS><TP-VP><TP-UDL><TP-UD>
 */
function buildSubmit(number, text, opts) {
	opts = opts || {};
	var ud = ucs2(text);
	var vpAbs = opts.vpOffsetMinutes != null;
	/* bit4:bit3 = TP-VPF（10 相对 / 11 绝对）；bit5 = TP-SRR；bit0 = TP-MTI=1 */
	var first = 0x01 | 0x20 | (vpAbs ? 0x18 : 0x10);
	var vp = vpAbs ? timestampHex(beijingParts(opts.vpOffsetMinutes)) : 'AA';
	return '00'
		+ hex2(first)
		+ hex2(opts.mr || 1)                     /* TP-MR */
		+ addrField(number)
		+ '00'                                   /* TP-PID */
		+ '08'                                   /* TP-DCS：UCS2 */
		+ vp
		+ hex2(ud.length / 2)
		+ ud;
}

/* ---------- 会话样本 ---------- */

var CONTACT_A = '+8613800138000';
var CONTACT_B = '+8613900139000';
var CONTACT_C = '+8610690000000';

/*
 * 三个会话、六条消息，刻意覆盖四种显示分支：
 *   A：收到 → 发出 → 收到（时间交错，用来验证「对面的和我自己的不挤在一起」）
 *      其中「发出」用相对 VP，时间是**未知**的 → 验证未知时间沉底显示「时间未知」
 *   B：单条收到 → 验证只有一个分区时另一分区显示空态
 *   C：收到 + 发出（发出用绝对 VP）→ 验证「（有效期时间，非发送时刻）」标注
 *
 * 号码一律用国际格式（+86）写入 PDU，模拟真实模组存的是什么：
 *   前端 normalizePhoneNumber 会剥掉国家码，这正是收 / 发能聚到同一联系人的前提。
 */
function buildConversations() {
	var defs = [
		{ index: 1, dir: 'received', number: CONTACT_A, content: '明天上午的评审改到十点，方便吗？', offset: -32 },
		{ index: 2, dir: 'sent', number: CONTACT_A, content: '方便，我九点半到会议室。', offset: -30, vp: null },
		{ index: 3, dir: 'received', number: CONTACT_A, content: '好，会议室在 3 号楼 502。', offset: -28 },
		{ index: 4, dir: 'received', number: CONTACT_B, content: '您本月话费已出账，共 68.00 元。', offset: -12 },
		{ index: 5, dir: 'received', number: CONTACT_C, content: '【模拟】您的验证码是 861234，5 分钟内有效。', offset: -3 },
		{ index: 6, dir: 'sent', number: CONTACT_C, content: '收到，谢谢。', offset: -2, vp: -2 }
	];

	var list = [];
	for (var i = 0; i < defs.length; i++) {
		var d = defs[i];
		var pdu = d.dir === 'received'
			? buildDeliver(d.number, d.content, d.offset)
			: buildSubmit(d.number, d.content, { mr: d.index, vpOffsetMinutes: d.vp });
		/*
		 * 期望的界面显示文本（YY/MM/DD,HH:MM:SS）。在**生成 PDU 的同一时刻**算好，
		 * 测试直接拿它比对，避免「断言时再取一次当前时间」带来的秒级漂移。
		 */
		var p = beijingParts(d.dir === 'received' ? d.offset : (d.vp == null ? 0 : d.vp));
		var pad = function (n) { return String(n).padStart(2, '0'); };
		list.push({
			index: d.index,
			direction: d.dir,
			/* PDU 里写的是国际格式，前端归一化后会剥掉 86 */
			pduNumber: d.number,
			number: d.number.replace(/^\+86/, ''),
			content: d.content,
			offsetMinutes: d.offset,
			/* 只有带绝对 VP 的 SUBMIT 才有近似时间 */
			timeApprox: d.dir === 'sent' && d.vp != null,
			/* 相对 VP 的 SUBMIT 解不出时间 */
			timeKnown: d.dir === 'received' || d.vp != null,
			/* 界面应显示的时间文本；时间未知时为空串 */
			display: (d.dir === 'received' || d.vp != null)
				? `${pad(p.year)}/${pad(p.month)}/${pad(p.day)},${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
				: '',
			pdu: pdu
		});
	}
	return list;
}

/*
 * 会话样本 → `AT+CMGL=4` 的应答文本，形状照手册 9.8.1（PDU 模式）：
 *
 *   +CMGL: <index>,<stat>,[<reserved>],<length>
 *   <pdu>
 *
 * 两处容易写错、写错了也不会立刻暴露的地方，钉在这里：
 *   - <stat> 是**数字**（9.8.3：0 收到的未读 / 1 收到的已读 / 2 存储的未发送 /
 *     3 存储的已发送）。`"REC READ"` 那种带引号的字符串属于 9.9 的文本模式，
 *     混进 PDU 夹具就等于伪造了一台不存在的模组；
 *   - <length> 是**十进制**的 TPDU 字节数，不含整个短信中心字段。手册 9.8.5 的
 *     例子是 34 字节 PDU、首字节 `08` 表示中心字段再跟 8 字节（合计 9），
 *     所以头行写 `+CMGL: 1,0,,25`。本夹具的中心字段就只有一个 `00`（长度 0 =
 *     用卡里配的中心号），于是 length = 总字节数 − 1。
 * 解析侧（Rust `pdu::parse_cmgl_response`）不读 <stat>/<length>，所以夹具写错
 * 形状时测试照样全绿；这两条注释和下面的构造就是这个漂移的唯一报警器。
 */
function cmglText(list) {
	var out = '';
	for (var i = 0; i < list.length; i++) {
		var it = list[i];
		var stat = it.direction === 'sent' ? 3 : 1;
		var tpduBytes = it.pdu.length / 2 - 1;   /* 减去 SMSC 长度那一字节 */
		out += '+CMGL: ' + it.index + ',' + stat + ',,' + tpduBytes + '\r\n'
			+ it.pdu + '\r\n';
	}
	return out + 'OK';
}

/*
 * 单条 PDU → `AT+CMGR=<index>` 的应答文本（手册 9.10.1）。
 *
 * 头行**没有 index 字段**：`+CMGR: <stat>,[<reserved>],<length>`，
 * 手册 9.10.5 的实例就是 `+CMGR: 1,,25`；序号由命令本身带着，应答不回传。
 * 本函数只服务收件箱（mock 对已发短信回 ERROR），所以 <stat> 固定 1（收到的已读）。
 */
function cmgrText(hex) {
	return '+CMGR: 1,,' + (hex.length / 2 - 1) + '\r\n' + hex + '\r\nOK';
}

module.exports = {
	buildDeliver: buildDeliver,
	buildSubmit: buildSubmit,
	buildConversations: buildConversations,
	cmglText: cmglText,
	cmgrText: cmgrText,
	beijingParts: beijingParts,
	timestampHex: timestampHex,
	/* 只给离线校验脚本用（按 pdu.rs 的读法回读一份夹具） */
	BEIJING_TZ_QUARTERS: BEIJING_TZ_QUARTERS,
	CONTACT_A: CONTACT_A,
	CONTACT_B: CONTACT_B,
	CONTACT_C: CONTACT_C
};
