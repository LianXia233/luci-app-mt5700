'use strict';

/**
 * 短信发送 PDU 编码器（等价原前端 node-pdu 的 SMS-SUBMIT 编码）。
 * 3GPP 23.040 / 23.038：
 * - GSM 7bit 打包（低位在前），非 GSM 字符自动切 UCS2
 * - 长短信自动分片并带 8-bit 拼接头（IEI 0x00）
 * - SMSC 地址打包、TPDU 长度计算
 */

var SmsEncode = (function () {
	var api = {};

	var GSM7_ALPHABET = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

	function isGsm7Char(ch) {
		var code = ch.charCodeAt(0);
		// 基本字母表里的可打印字符
		if (GSM7_ALPHABET.indexOf(ch) >= 0) return true;
		// ESC 扩展表（^ 0x1B 转义）：|^€{}[]~\
		var esc = '|^€{}[]~\\';
		return esc.indexOf(ch) >= 0;
	}

	function gsm7Code(ch) {
		var code = ch.charCodeAt(0);
		var basic = GSM7_ALPHABET.indexOf(ch);
		if (basic >= 0) return basic;
		var esc = '|^€{}[]~\\';
		var e = esc.indexOf(ch);
		if (e >= 0) return e; // 扩展字符：输出 0x1B 前置
		if (code === 0x0d) return 13;
		if (code === 0x0a) return 10;
		if (code === 0x00) return 0;
		return null;
	}

	// 把字符列表编码成 7bit 位流（低位在前）。扩展字符输出 0x1B + 表内索引。
	function packSeptets(chars) {
		var bits = [];
		for (var i = 0; i < chars.length; i++) {
			var c = gsm7Code(chars[i]);
			if (c === null) return null;
			if (GSM7_ALPHABET.indexOf(chars[i]) < 0 && '|^€{}[]~\\'.indexOf(chars[i]) >= 0) {
				pushBits(bits, 0x1b, 7);
				pushBits(bits, c, 7);
			} else {
				pushBits(bits, c, 7);
			}
		}
		return bits;
	}

	function pushBits(bits, value, count) {
		for (var i = 0; i < count; i++) {
			bits.push((value >> i) & 1);
		}
	}

	function bitsToOctets(bits) {
		var octets = [];
		for (var i = 0; i + 7 < bits.length; i += 8) {
			var b = 0;
			for (var j = 0; j < 8; j++) b |= bits[i + j] << j;
			octets.push(b);
		}
		// 剩余不足 8 位也补一个字节
		if (bits.length % 8 !== 0) {
			var last = 0;
			var start = Math.floor(bits.length / 8) * 8;
			for (var j = start; j < bits.length; j++) last |= bits[j] << (j - start);
			octets.push(last);
		}
		return octets;
	}

	function octetsToHex(octets) {
		return octets.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').toUpperCase();
	}

	// SMSC 地址编码：+8613800755500 -> 91 683108700555F0
	function encodeAddress(number) {
		var digits = number.replace(/[^\d]/g, '');
		var hasPlus = number.indexOf('+') === 0;
		if (!digits.length) return '';
		var tonNpi = hasPlus ? 0x91 : 0x81;
		if (digits.length % 2 !== 0) digits += 'F';
		var packed = '';
		for (var i = 0; i < digits.length; i += 2) {
			packed += digits[i + 1] + digits[i];
		}
		var len = digits.length / 2; // 半字节数/2
		return len.toString(16).padStart(2, '0') + tonNpi.toString(16).padStart(2, '0') + packed.toUpperCase();
	}

	// 用户数据（TP-UD）构造
	function buildUserData(message, udhi, encoding) {
		var concatHeader = udhi ? [0x05, 0x00, 0x03, udhi.ref & 0xff, udhi.total & 0xff, udhi.seq & 0xff] : null;

		if (encoding === 'UCS2') {
			var bytes = [];
			for (var i = 0; i < message.length; i++) {
				var code = message.charCodeAt(i);
				bytes.push((code >> 8) & 0xff, code & 0xff);
			}
			if (concatHeader) bytes = concatHeader.concat(bytes);
			return { data: bytes, udl: bytes.length, septets: null };
		}

		// GSM 7bit：header 字节直接作为 8-bit 位流前置，然后用户 septets 连续打包
		var bits = [];
		if (concatHeader) {
			for (var i = 0; i < concatHeader.length; i++) pushBits(bits, concatHeader[i], 8);
		}
		var packed = packSeptets(Array.from(message));
		if (packed === null) return null; // 含 GSM7 无法表示的字符，调用方应改用 UCS2
		bits = bits.concat(packed);
		var octets = bitsToOctets(bits);
		return { data: octets, udl: message.length + (concatHeader ? 6 : 0), septets: message.length + (concatHeader ? 7 : 0) };
	}

	// 构建单条 SMS-SUBMIT 的 TPDU（不含 SMSC 部分），返回 hex
	function buildTpdu(opts) {
		var udhi = opts.udhi || null;
		var firstOctet = 0x01; // MTI=01 (SMS-SUBMIT)
		if (udhi) firstOctet |= 0x40; // TP-UDHI
		firstOctet |= 0x10; // TP-VPF=10 (relative)
		firstOctet |= 0x20; // TP-RD=1 (reject duplicates)

		var da = encodeAddress(opts.destination);
		var mr = '00';
		var pid = '00';
		var dcs = opts.encoding === 'UCS2' ? '08' : '00';
		var vp = 'AA'; // 24 小时（相对有效期，见 23.040 VP=0xAA）

		var ud = buildUserData(opts.message, udhi, opts.encoding);
		if (!ud) return null;
		var udl = opts.encoding === 'UCS2' ? ud.udl.toString(16).padStart(2, '0') : ud.udl.toString(16).padStart(2, '0');

		return firstOctet.toString(16).padStart(2, '0') + mr + da + pid + dcs + vp + udl + octetsToHex(ud.data);
	}

	// 计算分片参数
	var GSM7_MAX = 160;
	var GSM7_MAX_UDH = 153;
	var UCS2_MAX = 140;   // 70 字符
	var UCS2_MAX_UDH = 134; // 67 字符

	function needsUcs2(message) {
		var chars = Array.from(message);
		for (var i = 0; i < chars.length; i++) {
			if (gsm7Code(chars[i]) === null) return true;
		}
		return false;
	}

	api.messageStats = function (message) {
		if (!message) return { encoding: '7bit', parts: 0, chars: Array.from(message).length };
		var ucs2 = needsUcs2(message);
		var chars = Array.from(message).length;
		if (!ucs2) {
			// 扩展字符每个占 2 个 septet
			var septets = 0;
			Array.from(message).forEach(function (ch) {
				septets += '|^€{}[]~\\'.indexOf(ch) >= 0 ? 2 : 1;
			});
			var parts = septets <= GSM7_MAX ? 1 : Math.ceil(septets / GSM7_MAX_UDH);
			return { encoding: '7bit', parts: parts, chars: chars, septets: septets };
		}
		var parts = chars <= 70 ? 1 : Math.ceil(chars / (UCS2_MAX_UDH / 2));
		return { encoding: 'UCS2', parts: parts, chars: chars };
	};

	// 构建发送分片，等价 buildSubmitParts
	api.buildSubmitParts = function (opts) {
		var message = opts.message || '';
		var ucs2 = needsUcs2(message);
		var chars = Array.from(message);

		var parts = [];
		if (!ucs2) {
			// 先算总 septets
			var septets = 0;
			chars.forEach(function (ch) { septets += '|^€{}[]~\\'.indexOf(ch) >= 0 ? 2 : 1; });
			if (septets <= GSM7_MAX) {
				parts.push({ message: message, encoding: '7bit', udhi: null });
			} else {
				// 长短信：按字符分包（近似 septets，扩展字符少时按字符数分包即可）
				var per = GSM7_MAX_UDH;
				var count = Math.ceil(septets / per);
				var ref = Math.floor(Math.random() * 255) + 1;
				// 重新按字符精确分包
				var cur = [], curSeptets = 0, seq = 0, total = 0;
				// 先估算 total：按 septet 精确切分
				var chunks = [];
				var tmp = [], tmpS = 0;
				for (var i = 0; i < chars.length; i++) {
					var s = '|^€{}[]~\\'.indexOf(chars[i]) >= 0 ? 2 : 1;
					if (tmpS + s > per && tmp.length) {
						chunks.push(tmp); tmp = []; tmpS = 0;
					}
					tmp.push(chars[i]); tmpS += s;
				}
				if (tmp.length) chunks.push(tmp);
				total = chunks.length;
				for (var c = 0; c < chunks.length; c++) {
					parts.push({ message: chunks[c].join(''), encoding: '7bit', udhi: { ref: ref, total: total, seq: c + 1 } });
				}
			}
		} else {
			if (chars.length <= 70) {
				parts.push({ message: message, encoding: 'UCS2', udhi: null });
			} else {
				var perC = Math.floor(UCS2_MAX_UDH / 2); // 67 octets → 33 chars
				var totalC = Math.ceil(chars.length / perC);
				var refC = Math.floor(Math.random() * 255) + 1;
				for (var i = 0; i < totalC; i++) {
					parts.push({
						message: chars.slice(i * perC, (i + 1) * perC).join(''),
						encoding: 'UCS2',
						udhi: { ref: refC, total: totalC, seq: i + 1 }
					});
				}
			}
		}

		return parts.map(function (part) {
			var pdu = buildTpdu({
				destination: opts.destination,
				message: part.message,
				encoding: part.encoding,
				udhi: part.udhi
			});
			// SMSC 部分：有 smsc 时编码；没有则 00
			var sca = opts.smsc ? encodeAddress(opts.smsc) : '00';
			var fullPdu = sca + pdu;
			var scaOctets = sca.length / 2;
			return { pdu: fullPdu, tpduLength: pdu.length / 2 };
		});
	};

	return api;
})();
