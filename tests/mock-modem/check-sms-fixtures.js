'use strict';
/**
 * 夹具自检：按后端解析器的读法（`pdu::decode_incoming_pdu` / `timezone_offset_minutes`）
 * 把 `sms-fixtures.js` 生成的每条 PDU 回读一遍，与夹具自己声明的期望值对齐。
 *
 * 为什么需要它：夹具里有两处「写歪了也不会有人喊」的坑 ——
 *   1. TP-SCTS 的时区字节要和其它 BCD 字段一样交换半字节（32 刻 = `0x23`，不是 `0x32`）；
 *   2. `+CMGL` 头行的 <length> 是 TPDU 字节数，不含短信中心字段。
 * 后端解析器不校验这两处，`sms-center-render` 的期望显示文本又是另外算的，
 * 于是错误可以静静躺很久。这个脚本把两边钉在一起。
 *
 * 只依赖 node 内置模块，不需要 Rust 工具链：`node tests/mock-modem/check-sms-fixtures.js`
 */

const path = require('path');
const fixtures = require(path.join(__dirname, 'sms-fixtures.js'));

/* 半字节交换的 BCD → 整数，与 `pdu::bcd_digit` 一致 */
function bcdDigit(b) { return (b & 0x0F) * 10 + (b >> 4); }

/* 与 `pdu::timezone_offset_minutes` 一致：十位在低半字节，bit7 为符号位，单位 15 分钟 */
function tzMinutes(tz) {
	const minutes = (((tz & 0x0F) * 10) + ((tz >> 4) & 0x07)) * 15;
	return (tz & 0x80) ? -minutes : minutes;
}

/* 读到 TP-SCTS 为止，返回 { tpdu, ts, udl, ud } —— 字段偏移按 23.040 SMS-DELIVER */
function splitDeliver(pduHex) {
	const raw = Buffer.from(pduHex, 'hex');
	let pos = 0;
	const smscLen = raw[pos++]; pos += smscLen;
	const first = raw[pos++];
	if ((first & 0x03) !== 0) throw new Error('不是 SMS-DELIVER：' + pduHex);
	const digits = raw[pos++];
	const toa = raw[pos++];
	const alpha = ((toa >> 4) & 0x07) === 0x05;
	pos += alpha ? Math.ceil(digits * 7 / 8) : Math.ceil(digits / 2);
	pos++;                                    /* TP-PID */
	pos++;                                    /* TP-DCS */
	const ts = raw.slice(pos, pos + 7); pos += 7;
	const udl = raw[pos++];
	return { tpduBytes: raw.length - smscLen - 1, ts: ts, udl: udl, ud: raw.slice(pos) };
}

let failed = 0;
function check(name, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) { failed++; console.log('  FAIL ' + name + '\n    实际: ' + JSON.stringify(got) + '\n    期望: ' + JSON.stringify(want)); }
	else console.log('  ok   ' + name);
}

console.log('== 时区字节 ==');
/* 东八区 = 8 × 4 = 32 刻；交换半字节后 0x23 */
check('32 刻编码为 0x23', fixtures.timestampHex({ year: 26, month: 10, day: 23, hour: 12, minute: 0, second: 0 }).slice(12), '23');
check('0x23 还原为 +480 分钟', tzMinutes(0x23), 480);

console.log('== 会话样本（6 条）==' );
const list = fixtures.buildConversations();
check('条数', list.length, 6);
for (const it of list) {
	if (it.direction === 'received') {
		const d = splitDeliver(it.pdu);
		check('#' + it.index + ' SCTS 时区 = +480', tzMinutes(d.ts[6]), 480);
		check('#' + it.index + ' TP-UDL = UD 字节数', d.udl, d.ud.length);
	}
	/* <length> 必须等于 TPDU 字节数：+CMGL 头行与 CMGR 头行共用这个口径 */
	const head = fixtures.cmglText([it]).split('\r\n')[0];
	const declared = parseInt(head.slice(head.lastIndexOf(',') + 1), 10);
	check('#' + it.index + ' <length> = PDU 字节数 − 短信中心字段', declared, it.pdu.length / 2 - 1);
}

if (failed) {
	console.log('\n' + failed + ' 项不一致');
	process.exit(1);
}
console.log('\n夹具与后端解析口径一致');
