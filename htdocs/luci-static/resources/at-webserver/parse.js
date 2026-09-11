'use strict';
'require baseclass';
/* global AtWs, baseclass */

/**
 * 补充解析库：运行状态 / 扫频 / USSD / 短信 / 锁频 / 定时锁频 DTO。
 * 全部从原 React 前端 modem/*.ts 等价迁移，与 Rust 后端的应答格式严格一致。
 */

var Parse = (function () {
	var api = {};

	/* ================= 状态类 ================= */

	// AT^LENDC?
	api.parseLendc = function (text) {
		var match = text.match(/\^LENDC:\s*([\d,\s]+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (v) { return Number(v.trim()); })
			.filter(function (v) { return isFinite(v); });
		var v = f.length >= 5 ? f.slice(1) : f;
		if (v.length < 4) return null;
		return {
			available: v[0] === 1,
			plmnAvailable: v[1] === 1,
			restricted: v[2] === 0,
			established: v[3] === 1
		};
	};

	var INVALID_POWER = 999;
	var power = function (v) {
		var n = Number((v || '').trim());
		if (!isFinite(n) || n === INVALID_POWER) return null;
		return n;
	};

	// AT^TXPOWER?
	api.parseTxPower = function (text) {
		var match = text.match(/\^TXPOWER:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',');
		if (f.length < 5) return null;
		var total = power(f[0]);
		return {
			total: total === null ? null : Number((total / 10).toFixed(1)),
			pusch: power(f[1]), pucch: power(f[2]), srs: power(f[3]), prach: power(f[4])
		};
	};

	// AT^NTXPOWER? 每 5 字段一个载波
	api.parseNrTxPower = function (text) {
		var match = text.match(/\^NTXPOWER:\s*(.+)/);
		if (!match) return [];
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		var carriers = [];
		for (var i = 0; i + 4 < f.length && carriers.length < 4; i += 5) {
			var freq = Number(f[i + 4]);
			carriers.push({
				pusch: power(f[i]), pucch: power(f[i + 1]), srs: power(f[i + 2]), prach: power(f[i + 3]),
				freq: isFinite(freq) && freq !== 0 ? freq : null
			});
		}
		return carriers;
	};

	var REG_STATES = { 0: '未注册，未搜网', 1: '已注册本地网络', 2: '未注册，搜网中', 3: '注册被拒绝', 4: '未知原因', 5: '已注册漫游网络', 8: '仅紧急业务' };
	var ACT_TYPES = { 10: 'EUTRAN-5GC', 11: 'NR-5GC' };

	// AT+C5GREG?
	api.parseC5greg = function (text) {
		var match = text.match(/\+C5GREG:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
		if (f.length < 2) return null;
		var stat = Number(f[1]);
		if (!isFinite(stat)) return null;
		var act = Number(f[4]);
		return {
			stat: stat,
			statText: REG_STATES[stat] || ('状态 ' + stat),
			registered: stat === 1 || stat === 5,
			tac: f[2] || '', ci: f[3] || '',
			act: ACT_TYPES[act] || '',
			nssai: f[6] || ''
		};
	};

	var compressIPv6 = function (groups) {
		var bestStart = -1, bestLen = 0, start = -1, len = 0;
		groups.forEach(function (g, i) {
			if (g === '0') {
				if (start < 0) start = i;
				len += 1;
				if (len > bestLen) { bestLen = len; bestStart = start; }
			} else { start = -1; len = 0; }
		});
		if (bestLen < 2) return groups.join(':');
		var head = groups.slice(0, bestStart).join(':');
		var tail = groups.slice(bestStart + bestLen).join(':');
		return head + '::' + tail;
	};

	var formatPdpAddress = function (raw) {
		var parts = raw.split('.').map(function (v) { return Number(v); });
		if (parts.length === 4 && parts.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
			return { address: parts.join('.'), family: 'IPv4' };
		}
		if (parts.length === 16 && parts.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
			var groups = [];
			for (var i = 0; i < 16; i += 2) groups.push(((parts[i] << 8) | parts[i + 1]).toString(16));
			return { address: compressIPv6(groups), family: 'IPv6' };
		}
		return { address: raw, family: raw.indexOf(':') >= 0 ? 'IPv6' : '未知' };
	};

	// AT+CGPADDR
	api.parseCgpaddr = function (text) {
		return text.split(/\r?\n/)
			.map(function (line) { return line.match(/\+CGPADDR:\s*(\d+),?\s*"?([^"\r\n]*)"?/); })
			.filter(function (m) { return m !== null && m[2].trim() !== ''; })
			.map(function (m) {
				var fmt = formatPdpAddress(m[2].trim());
				return { cid: Number(m[1]), address: fmt.address, family: fmt.family };
			});
	};

	/* ================= 温度 ================= */

	// AT^CHIPTEMP?
	api.parseCHIPTEMP = function (text) {
		var match = text.match(/\^CHIPTEMP:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		var g = function (i) { return f[i] !== undefined ? AtWs.parseTemperature(f[i]) : 0; };
		return { sub3GPA: g(0), sub6GPA: g(1), mimoPa: g(2), tcxo: g(3), ap1: g(4), ap2: g(5), modem1: g(6) };
	};

	/* ================= MCS ================= */

	// AT^MCS=0 / =1
	api.parseMCS = function (text) {
		var match = text.match(/\^MCS:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',');
		return { mcs: f[0] !== undefined ? parseInt(f[0], 10) : null, rank: f[1] !== undefined ? parseInt(f[1], 10) : null };
	};

	/* ================= IPv6 CAP ================= */

	api.ipv6CapDescription = function (v) {
		if (v === 0) return '不支持 IPv6';
		if (v === 1) return '支持 IPv6';
		return '能力值 ' + v;
	};

	/* ================= 扫频 ================= */

	var RAT_NAMES = { 0: 'GSM', 1: 'WCDMA', 2: 'LTE', 3: 'NR' };
	var INVALID_MEASURE = 99;
	var MAX_BAND = 512;

	var dec = function (v) { var t = v.trim(); if (t === '') return null; var n = Number(t); return isFinite(n) ? n : null; };
	var hexv = function (v) { var t = v.trim(); if (t === '') return null; var n = parseInt(t, 16); return isNaN(n) ? null : n; };
	var measure = function (v, scale) {
		var n = dec(v);
		if (n === null || n === INVALID_MEASURE) return null;
		return scale === 1 ? n : n * scale;
	};
	var parseBand = function (v) {
		var n = hexv(v);
		if (n === null || n <= 0 || n > MAX_BAND) return null;
		return n;
	};

	api.parseScanLine = function (line) {
		var idx = line.indexOf('^CELLSCAN:');
		if (idx < 0) return null;
		var body = line.slice(idx + '^CELLSCAN:'.length).trim();
		if (body === '' || /^(STARTED|OK)$/i.test(body)) return null;
		var f = body.split(',').map(function (s) { return s.trim(); });
		while (f.length < 15) f.push('');
		var rat = dec(f[0]);
		if (rat === null || !(rat in RAT_NAMES)) return null;
		return {
			rat: rat, ratName: RAT_NAMES[rat], plmn: f[1].replace(/"/g, ''),
			freq: dec(f[2]), pci: dec(f[3]), band: parseBand(f[4]),
			lac: f[5].trim(), cid: f[6].trim(),
			rxlev: dec(f[7]), bsic: dec(f[8]), psc: dec(f[9]),
			scs: dec(f[10]), rsrp: measure(f[11]),
			rsrq: measure(f[12], 0.5),
			sinr: rat === 2 ? measure(f[14], 0.125) : measure(f[13], 0.5),
			raw: line.trim()
		};
	};

	api.parseScanLines = function (lines) {
		var out = [];
		for (var i = 0; i < lines.length; i++) {
			var c = api.parseScanLine(lines[i]);
			if (c) out.push(c);
		}
		return out;
	};

	// 1<<(band-1) 十六进制位图
	api.scanBandMask = function (band) {
		return (BigInt(1) << BigInt(band - 1)).toString(16).toUpperCase();
	};

	api.buildScanCommand = function (f) {
		var rat = f.rat || '', plmn = (f.plmn || '').trim(), freq = (f.freq || '').trim();
		var pci = (f.pci || '').trim(), band = (f.band || '').trim(), scs = (f.scs || '').trim();
		if ((freq || pci) && rat === '') return { command: '', error: '指定频点或 PCI 时必须选择接入技术' };
		if (pci && !freq) return { command: '', error: '指定 PCI 时必须同时指定频点' };
		if (band && freq) return { command: '', error: '频段与频点不能同时指定' };
		if (pci && rat !== '2' && rat !== '3') return { command: '', error: '只有 LTE 与 NR 支持指定 PCI' };
		if (rat === '3' && (freq || pci) && scs === '') return { command: '', error: 'NR 指定频点或 PCI 时必须同时选择子载波间隔' };

		var bandArg = '';
		if (band) {
			var n = Number(band);
			if (!Number.isInteger(n) || n < 1 || n > MAX_BAND) return { command: '', error: '频段号超出范围（1-' + MAX_BAND + '）' };
			bandArg = api.scanBandMask(n);
		}
		var args = [rat, plmn ? '"' + plmn + '"' : '', freq, pci, bandArg, scs];
		while (args.length > 0 && args[args.length - 1] === '') args.pop();
		if (args.length === 0) return { command: 'AT^CELLSCAN' };
		return { command: 'AT^CELLSCAN=' + args.join(',') };
	};

	api.SCAN_ABORT_COMMAND = 'AT^CELLSCAN=ABORT';
	api.SCAN_STATE_COMMAND = 'AT^CELLSCAN=STATE';
	api.isScanRunning = function (text) { return /\^CELLSCAN:\s*RUNNING/i.test(text); };

	/* ================= USSD ================= */

	var packGsm7 = function (text) {
		var octets = [], acc = 0, bits = 0;
		for (var i = 0; i < text.length; i++) {
			acc |= (text.charCodeAt(i) & 0x7f) << bits;
			bits += 7;
			while (bits >= 8) { octets.push(acc & 0xff); acc >>= 8; bits -= 8; }
		}
		if (bits > 0) octets.push(acc & 0xff);
		return octets.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').toUpperCase();
	};

	var unpackGsm7 = function (hex) {
		var out = '', acc = 0, bits = 0;
		for (var i = 0; i + 1 < hex.length; i += 2) {
			var byte = parseInt(hex.slice(i, i + 2), 16);
			if (isNaN(byte)) return out;
			acc |= byte << bits;
			bits += 8;
			while (bits >= 7) { out += String.fromCharCode(acc & 0x7f); acc >>= 7; bits -= 7; }
		}
		return out.replace(/\0+$/, '');
	};

	var decodeUcs2 = function (hex) {
		var out = '';
		for (var i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
		return out;
	};

	var isHex = function (s) { return /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0; };

	api.buildUssdCommand = function (code) {
		var text = code.trim();
		if (!text) return { command: '', error: '请输入 USSD 代码，例如 *133#' };
		if (text.length > 160) return { command: '', error: 'USSD 字符串最长 160 个字符' };
		if (!/^[0-9*#+]+$/.test(text)) return { command: '', error: 'USSD 代码只能包含数字与 * # +' };
		return { command: 'AT+CUSD=1,"' + packGsm7(text) + '",15' };
	};

	api.USSD_CANCEL_COMMAND = 'AT+CUSD=2';

	var USSD_RESULT_TYPES = { 0: '网络无需回复', 1: '网络等待进一步输入', 2: '会话已被网络释放', 3: '其他客户端已响应', 4: '操作不支持', 5: '网络超时' };

	api.parseUssd = function (line) {
		var match = line.match(/\+CUSD:\s*(\d+)(?:\s*,\s*"?([^"]*)"?\s*(?:,\s*(\d+))?)?/);
		if (!match) return null;
		var m = Number(match[1]);
		var dcs = match[3] !== undefined ? Number(match[3]) : 15;
		var raw = (match[2] || '').trim();
		var text = raw;
		if (isHex(raw)) {
			if (dcs === 72) text = decodeUcs2(raw);
			else if (dcs === 68) { var a = ''; for (var i = 0; i + 1 < raw.length; i += 2) a += String.fromCharCode(parseInt(raw.slice(i, i + 2), 16)); text = a; }
			else text = unpackGsm7(raw);
		}
		return { m: m, mText: USSD_RESULT_TYPES[m] || ('状态 ' + m), text: text, needsReply: m === 1 };
	};

	/* ================= 短信 ================= */

	api.normalizePhoneNumber = function (phoneNumber) {
		if (!phoneNumber) return '';
		var normalized = phoneNumber.replace(/^\+/, '');
		if (normalized.indexOf('86') === 0 && normalized.length > 2) {
			var rest = normalized.substring(2);
			if (/^\d+$/.test(rest)) return rest;
		}
		if (/^\d+$/.test(normalized)) return normalized;
		var digits = normalized.replace(/\D/g, '');
		return digits || normalized;
	};

	api.isValidPhoneNumber = function (number) {
		return /^\d{5,19}$/.test(api.normalizePhoneNumber(number));
	};

	api.formatPDUTime = function (ts) {
		var d = ts instanceof Date ? ts : new Date(ts);
		if (isNaN(d.getTime())) return new Date().toLocaleString('zh-CN');
		var pad = function (n) { return String(n).padStart(2, '0'); };
		return pad(d.getFullYear() % 100) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
			',' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
	};

	api.parseMessageTime = function (timeStr) {
		if (!timeStr) return new Date();
		var match = String(timeStr).trim().match(/(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})/);
		if (match) {
			return new Date(2000 + parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10),
				parseInt(match[4], 10), parseInt(match[5], 10), parseInt(match[6], 10));
		}
		var parsed = new Date(timeStr);
		return isNaN(parsed.getTime()) ? new Date() : parsed;
	};

	/* ================= 短信 PDU 解码（等价 Rust pdu.rs / Go pdu.go） ================= */

	var GSM7_ALPHABET = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

	function gsm7Extension(c) {
		var table = {
			0x0A: '\u000C', 0x14: '^', 0x28: '{', 0x29: '}', 0x2F: '\\',
			0x3C: '[', 0x3D: '~', 0x3E: ']', 0x40: '|', 0x65: '€'
		};
		return table[c] !== undefined ? table[c] : null;
	}

	function unpackSeptets(data, count) {
		var out = [];
		var acc = 0, bits = 0;
		for (var i = 0; i < data.length && out.length < count; i++) {
			acc |= data[i] << bits;
			bits += 8;
			while (bits >= 7 && out.length < count) {
				out.push(acc & 0x7F);
				acc >>= 7;
				bits -= 7;
			}
		}
		if (bits > 0 && out.length < count) out.push(acc & 0x7F);
		return out;
	}

	function septetsToString(septets) {
		var sb = '';
		var i = 0;
		while (i < septets.length) {
			var c = septets[i];
			if (c === 0x1B && i + 1 < septets.length) {
				var ext = gsm7Extension(septets[i + 1]);
				if (ext !== null) { sb += ext; i += 2; continue; }
			}
			if (c < GSM7_ALPHABET.length) sb += GSM7_ALPHABET[c];
			else sb += '?';
			i += 1;
		}
		return sb;
	}

	function decodeUcs2(data) {
		var out = '';
		for (var i = 0; i + 1 < data.length; i += 2) {
			out += String.fromCharCode((data[i] << 8) | data[i + 1]);
		}
		return out;
	}

	function bcdDigit(b) { return (b & 0x0F) * 10 + (b >> 4); }

	function decodeTimestamp(ts) {
		if (ts.length < 7) return new Date();
		var year = 2000 + bcdDigit(ts[0]);
		var month = bcdDigit(ts[1]);
		var day = bcdDigit(ts[2]);
		var hour = bcdDigit(ts[3]);
		var minute = bcdDigit(ts[4]);
		var second = bcdDigit(ts[5]);
		if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
			return new Date();
		}
		return new Date(year, month - 1, day, hour, minute, second);
	}

	function decodeAddress(raw, offset) {
		var lenNibbles = raw[offset];
		var ton = (raw[offset + 1] >> 4) & 0x07;
		var start = offset + 2;
		var digits = '';
		var nibbles = lenNibbles;
		var i = start;
		while (nibbles > 0 && i < raw.length) {
			var b = raw[i];
			var d1 = b & 0x0F;
			var d2 = (b >> 4) & 0x0F;
			if (d1 < 0x0F) digits += String(d1);
			if (d2 < 0x0F) digits += String(d2);
			nibbles -= 2;
			i += 1;
		}
		if (ton === 5) {
			var alphaBytes = raw.slice(start, i);
			var septets = unpackSeptets(alphaBytes, Math.ceil(lenNibbles * 4 / 7));
			return { address: septetsToString(septets), ton: ton };
		}
		if (ton === 1) return { address: '+' + digits, ton: ton };
		return { address: digits, ton: ton };
	}

	// 解析一条 SMS-DELIVER PDU（hex），返回 { sender, content, date, partial }
	api.decodeIncomingPdu = function (hex) {
		var raw = [];
		for (var i = 0; i + 1 < hex.length; i += 2) {
			raw.push(parseInt(hex.slice(i, i + 2), 16));
		}
		if (raw.length < 2) return null;
		var smscLen = raw[0];
		var pos = 1 + smscLen;
		if (pos >= raw.length) return null;
		var firstOctet = raw[pos];
		var mti = firstOctet & 0x03;
		if (mti !== 0) return null; // 只处理 SMS-DELIVER
		pos += 1;
		var oaLen = raw[pos];
		if (pos + 1 + Math.ceil(oaLen / 2) > raw.length) return null;
		var addr = decodeAddress(raw, pos);
		pos += 2 + Math.ceil(oaLen / 2);
		if (pos + 1 >= raw.length) return null;
		var pid = raw[pos]; pos += 1;
		var dcs = raw[pos]; pos += 1;
		if (pos + 7 > raw.length) return null;
		var ts = raw.slice(pos, pos + 7);
		var date = decodeTimestamp(ts);
		pos += 7;
		if (pos >= raw.length) return null;
		var udl = raw[pos]; pos += 1;
		var udLen;
		if ((dcs & 0x0C) === 0x04) udLen = udl;
		else if ((dcs & 0x0C) === 0x08) udLen = udl * 2;
		else udLen = Math.ceil(udl * 7 / 8);
		var ud = raw.slice(pos, Math.min(pos + udLen, raw.length));

		var content = '';
		var partial = null;
		var udhi = (firstOctet & 0x40) !== 0;
		var userData = ud;
		var headerLen = 0;

		if (udhi && ud.length > 0) {
			headerLen = ud[0];
			var hdr = ud.slice(1, 1 + headerLen);
			userData = ud.slice(1 + headerLen);
			var p = 0;
			while (p + 1 < hdr.length) {
				var iei = hdr[p];
				var iel = hdr[p + 1];
				if (p + 2 + iel > hdr.length) break;
				var ieData = hdr.slice(p + 2, p + 2 + iel);
				if (iei === 0x00 && iel >= 3) {
					partial = { reference: ieData[0], parts_count: ieData[1], part_number: ieData[2] };
				} else if (iei === 0x08 && iel >= 4) {
					partial = { reference: ((ieData[0] << 8) | ieData[1]), parts_count: ieData[2], part_number: ieData[3] };
				}
				p += 2 + iel;
			}
		}

		if ((dcs & 0x0C) === 0x08) {
			content = decodeUcs2(userData);
		} else if ((dcs & 0x0C) === 0x04) {
			var c8 = '';
			for (var k = 0; k < userData.length; k++) c8 += String.fromCharCode(userData[k]);
			content = c8;
		} else {
			var headerSeptets = Math.ceil(headerLen * 8 / 7);
			var remaining = udl - headerSeptets;
			if (remaining < 0) remaining = 0;
			content = septetsToString(unpackSeptets(userData, remaining));
		}

		return { sender: addr.address, content: content, date: date, partial: partial };
	};

	// 解析 CMGL=4 应答（PDU 块 / 已解码文本行），输出 SMS[]（等价 modem/sms.ts parseCMGL + PDU 解析）
	api.parseCMGL = function (data) {
		var sms = [];
		var text = data;
		try {
			var jsonData = JSON.parse(data);
			if (jsonData.success && jsonData.data) text = jsonData.data;
		} catch (e) { /* not json */ }
		if (typeof text !== 'string') return sms;

		var blocks = text.split(/(?=\+CMGL:\s*\d+)/);
		for (var b = 0; b < blocks.length; b++) {
			var block = blocks[b];
			var idxM = block.match(/\+CMGL:\s*(\d+)/);
			var idx = idxM ? parseInt(idxM[1], 10) : null;
			if (!idxM) continue;

			// 已解码文本行：+CMGL: idx,"REC READ","<number>",,"<time>"
			var simple = block.match(/\+CMGL:\s*\d+,"([^"]*)","([^"]*)",,"([^"]*)"/);
			if (simple) {
				sms.push({
					index: idx,
					content: block.split('\n').slice(1).join('\n').trim(),
					number: api.normalizePhoneNumber(simple[2] || ''),
					time: simple[3] || '',
					type: simple[1].indexOf('REC') === 0 ? 'received' : 'sent'
				});
				continue;
			}

			// PDU 块：+CMGL: idx,stat,,,<len> 下一行是 PDU hex
			var lines = block.split('\n').map(function (l) { return l.trim(); });
			var pduHex = '';
			for (var li = 0; li < lines.length; li++) {
				if (/^[0-9A-Fa-f]{20,}$/.test(lines[li])) { pduHex = lines[li]; break; }
			}
			if (pduHex) {
				var decoded = api.decodeIncomingPdu(pduHex);
				if (decoded) {
					sms.push({
						index: idx,
						content: decoded.content,
						number: api.normalizePhoneNumber(decoded.sender || ''),
						time: api.formatPDUTime(decoded.date),
						type: 'received',
						isConcatenated: !!decoded.partial,
						concatenatedRef: decoded.partial ? decoded.partial.reference : undefined,
						concatenatedSeq: decoded.partial ? decoded.partial.part_number : undefined,
						concatenatedTotal: decoded.partial ? decoded.partial.parts_count : undefined
					});
				}
			}
		}
		return sms;
	};

	// 短信中心保存的已发消息缓存（等价原 localStorage sms_sent_messages_cache）
	api.SMS_CACHE_KEY = 'sms_sent_messages_cache';
	api.MAX_SMS_CACHE = 1000;

	api.getCachedSentMessages = function () {
		try {
			var raw = localStorage.getItem(api.SMS_CACHE_KEY);
			if (!raw) return [];
			var parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed;
		} catch (e) { /* ignore */ }
		return [];
	};

	api.saveSentMessageToCache = function (msg) {
		var list = api.getCachedSentMessages();
		list.unshift(msg);
		if (list.length > api.MAX_SMS_CACHE) list = list.slice(0, api.MAX_SMS_CACHE);
		try { localStorage.setItem(api.SMS_CACHE_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
		return list;
	};

	api.clearSentMessageCache = function () {
		try { localStorage.removeItem(api.SMS_CACHE_KEY); } catch (e) { /* ignore */ }
	};

	/* ================= 锁频 ================= */

	api.LOCK_TYPES = [
		{ label: '关闭', value: 0 }, { label: '锁定频点', value: 1 },
		{ label: '锁定小区', value: 2 }, { label: '锁定 Band', value: 3 }
	];
	api.LTE_BANDS = [
		{ label: 'B1 2100MHz', value: 1 }, { label: 'B3 1800MHz', value: 3 }, { label: 'B5 850MHz', value: 5 },
		{ label: 'B8 900MHz', value: 8 }, { label: 'B34 2100MHz TDD', value: 34 }, { label: 'B38 2600MHz TDD', value: 38 },
		{ label: 'B39 1900MHz TDD', value: 39 }, { label: 'B40 2300MHz TDD', value: 40 }, { label: 'B41 2500MHz TDD', value: 41 }
	];
	api.NR_BANDS = [
		{ label: 'n1 2100MHz', value: 1 }, { label: 'n3 1800MHz', value: 3 }, { label: 'n5 850MHz', value: 5 },
		{ label: 'n8 900MHz', value: 8 }, { label: 'n28 700MHz', value: 28 }, { label: 'n41 2500MHz', value: 41 },
		{ label: 'n77 3700MHz', value: 77 }, { label: 'n78 3500MHz', value: 78 }, { label: 'n79 4700MHz', value: 79 }
	];
	api.SCS_TYPES = [
		{ label: '15 kHz', value: 0 }, { label: '30 kHz', value: 1 }, { label: '60 kHz', value: 2 },
		{ label: '120 kHz', value: 3 }, { label: '240 kHz', value: 4 }
	];
	api.MAX_LOCK_ITEMS = 20;
	api.MAX_ARFCN = 4294967295;
	api.MAX_PCI = { lte: 503, nr: 1007 };

	api.getDefaultScsType = function (band) {
		// mmWave: 257/258/260/261 -> 3 (120kHz)，TDD 常用 -> 1 (30kHz)，其余 0
		if ([257, 258, 260, 261].indexOf(Number(band)) >= 0) return 3;
		if ([41, 48, 77, 78, 79].indexOf(Number(band)) >= 0) return 1;
		return 0;
	};

	var checkArfcn = function (label, raw) {
		if (!/^\d+$/.test(raw)) throw new Error(label + ' 频点必须为 0-' + api.MAX_ARFCN + ' 的整数');
		if (Number(raw) > api.MAX_ARFCN) throw new Error(label + ' 频点超出范围（0-' + api.MAX_ARFCN + '）');
		return raw;
	};
	var checkPci = function (kind, raw) {
		var max = api.MAX_PCI[kind];
		var label = kind === 'lte' ? 'LTE' : 'NR';
		if (!/^\d+$/.test(raw)) throw new Error(label + ' PCI 必须为 0-' + max + ' 的整数');
		if (Number(raw) > max) throw new Error(label + ' PCI 超出范围（0-' + max + '）');
		return raw;
	};

	api.toLockLists = function (kind, type, items) {
		var empty = { type: type, bands: '', arfcns: '', scs_types: '', pcis: '' };
		if (type === 0) return empty;
		var label = kind === 'lte' ? 'LTE' : 'NR';
		var valid = items.filter(function (i) { return i.band != null; });
		if (!valid.length) throw new Error('请至少输入一个有效的 ' + label + ' 频段');
		if (valid.length > api.MAX_LOCK_ITEMS) throw new Error(label + ' 最多只能锁 ' + api.MAX_LOCK_ITEMS + ' 组');
		var bands = valid.map(function (i) { return String(i.band); }).join(',');
		if (type === 3) return { type: type, bands: bands, arfcns: '', scs_types: '', pcis: '' };
		var arfcns = valid.map(function (i) { return checkArfcn(label, String(i.arfcn || '').trim()); }).join(',');
		var scs_types = kind === 'nr' ? valid.map(function (i) { return String(i.scs != null ? i.scs : api.getDefaultScsType(i.band)); }).join(',') : '';
		if (type === 1) return { type: type, bands: bands, arfcns: arfcns, scs_types: scs_types, pcis: '' };
		var pcis = valid.map(function (i) { return checkPci(kind, String(i.pci || '').trim()); }).join(',');
		return { type: type, bands: bands, arfcns: arfcns, scs_types: scs_types, pcis: pcis };
	};

	// 原前端拼锁频命令（即时生效场景，如扫频结果一键锁定）
	api.buildLockCommand = function (kind, type, mobility, items) {
		var cmd = kind === 'lte' ? 'AT^LTEFREQLOCK' : 'AT^NRFREQLOCK';
		if (type === 0) return cmd + '=0';
		var l = api.toLockLists(kind, type, items);
		var num = l.bands.split(',').length;
		var head = cmd + '=' + type + ',' + mobility + ',' + num;
		if (type === 3) return head + ',"' + l.bands + '"';
		if (kind === 'lte') {
			return type === 1
				? head + ',"' + l.bands + '","' + l.arfcns + '"'
				: head + ',"' + l.bands + '","' + l.arfcns + '","' + l.pcis + '"';
		}
		return type === 1
			? head + ',"' + l.bands + '","' + l.arfcns + '","' + l.scs_types + '"'
			: head + ',"' + l.bands + '","' + l.arfcns + '","' + l.scs_types + '","' + l.pcis + '"';
	};

	api.fromLockLists = function (kind, lists) {
		var split = function (v) { return (v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); };
		var bands = split(lists.bands);
		if (!bands.length) return [{}];
		var arfcns = split(lists.arfcns);
		var scs = split(lists.scs_types);
		var pcis = split(lists.pcis);
		return bands.map(function (band, i) {
			return {
				band: Number(band), arfcn: arfcns[i], pci: pcis[i],
				scs: kind === 'nr' ? (scs[i] != null ? Number(scs[i]) : api.getDefaultScsType(Number(band))) : undefined
			};
		});
	};

	/* ================= 定时锁频 DTO ================= */

	// AT+SCHED? -> "+SCHED: {json}\r\nOK"
	api.parseScheduleResponse = function (data) {
		var json = String(data).match(/\+SCHED:\s*(\{[\s\S]*\})/);
		if (!json) return null;
		try { return JSON.parse(json[1]); } catch (e) { return null; }
	};

	api.buildScheduleSetCommand = function (cfg) {
		var payload = {};
		Object.keys(cfg).forEach(function (k) { if (k !== 'status') payload[k] = cfg[k]; });
		return 'AT+SCHED=' + JSON.stringify(payload);
	};

	api.modeText = function (mode) { return mode === '' ? '当前时段不锁频' : mode; };

	/* ================= 辅载波/辅站小区（carrier.ts 等价迁移） ================= */
	// 手册 13.27 AT^MONSSC — NSA 下 5G 辅连接服务小区（最多 8CC）
	// 手册 13.18 AT^CASCELLINFO? — LTE CA 的辅小区（最多 4 个 SCELL）
	// ^HFREQINFO 只给频点与带宽，这两条补每个辅载波各自的信号质量。

	var MEAS_TYPES = { 0: 'SSB', 1: 'CSI-RS' };
	var NR_INVALID = { rsrp: -1256, rsrq: -348, sinr: -188 };
	// 手册 13.18.3 <ulbw>/<dlbw>
	var LTE_BANDWIDTHS = { 0: 1.4, 1: 3, 2: 5, 3: 10, 4: 15, 5: 20 };

	var descale = function (value, min, max) {
		return value < min || value > max ? Number((value / 8).toFixed(1)) : value;
	};
	var numOrNull = function (v) {
		var t = String(v == null ? '' : v).trim();
		if (t === '') return null;
		var n = Number(t);
		return isFinite(n) ? n : null;
	};

	// 解析一行 ^MONSSC。NONE（非 ENDC）或解析失败返回 null。
	api.parseMonssc = function (line) {
		var match = line.match(/\^MONSSC:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		var rat = String(f[0] || '').replace(/"/g, '').toUpperCase();
		if (rat !== 'NR' || f.length < 3) return null; // NONE 表示非 ENDC，LTE 分支手册标注暂不支持
		var arfcn = numOrNull(f[1]);
		// 手册 13.27.3：<PCI> 十六进制，取值范围 0~0x3EF
		var pci = f[2] === '' ? null : parseInt(f[2], 16);
		if (arfcn === null || pci === null || isNaN(pci)) return null;
		var rawRsrp = numOrNull(f[3]), rawRsrq = numOrNull(f[4]), rawSinr = numOrNull(f[5]);
		var meas = numOrNull(f[6]);
		return {
			arfcn: arfcn,
			pci: pci,
			rsrp: rawRsrp === null || rawRsrp === NR_INVALID.rsrp ? null : descale(rawRsrp, -156, -31),
			rsrq: rawRsrq === null || rawRsrq === NR_INVALID.rsrq ? null : descale(rawRsrq, -43, 20),
			sinr: rawSinr === null || rawSinr === NR_INVALID.sinr ? null : descale(rawSinr, -23, 40),
			measType: meas !== null && MEAS_TYPES[meas] ? MEAS_TYPES[meas] : '—'
		};
	};

	api.parseMonsscAll = function (text) {
		return String(text).split(/\r?\n/).map(api.parseMonssc).filter(Boolean);
	};

	// 解析一行 ^CASCELLINFO。CA 未配置时模组直接回 ERROR，这里自然解析不到。
	api.parseCascell = function (line) {
		var match = line.match(/\^CASCELLINFO:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		if (f.length < 12) return null;
		var index = numOrNull(f[0]), pci = numOrNull(f[1]);
		if (index === null || pci === null) return null;
		var bw = function (v) {
			var n = numOrNull(v);
			return n === null ? null : (LTE_BANDWIDTHS[n] != null ? LTE_BANDWIDTHS[n] : null);
		};
		var freq = function (v) {
			var n = numOrNull(v);
			// 手册：<ulfreq>/<dlfreq> 单位 100kHz，换成 MHz 显示
			return n === null ? null : Number((n / 10).toFixed(1));
		};
		return {
			index: index,
			pci: pci,
			rssi: numOrNull(f[2]),
			rsrp: numOrNull(f[3]),
			rsrq: numOrNull(f[4]),
			band: numOrNull(f[5]) || 0,
			ulArfcn: numOrNull(f[6]),
			dlArfcn: numOrNull(f[7]),
			ulFreq: freq(f[8]),
			dlFreq: freq(f[9]),
			ulBandwidth: bw(f[10]),
			dlBandwidth: bw(f[11])
		};
	};

	api.parseCascellAll = function (text) {
		return String(text).split(/\r?\n/).map(api.parseCascell).filter(Boolean);
	};

	// 把 ^MONSSC / ^CASCELLINFO 的信号质量对应到 ^HFREQINFO 报出来的某个载波上。
	api.carrierSignalFor = function (carrier, nr, lte) {
		var arfcn = Number(carrier.dlFcn);
		if (!isFinite(arfcn)) return null;
		if (carrier.sysMode === 'NR') {
			var hit = nr.find(function (c) { return c.arfcn === arfcn; });
			return hit
				? { pci: hit.pci, rsrp: hit.rsrp, rsrq: hit.rsrq, sinr: hit.sinr, measType: hit.measType }
				: null;
		}
		var lHit = lte.find(function (c) { return c.dlArfcn === arfcn; });
		return lHit ? { pci: lHit.pci, rsrp: lHit.rsrp, rsrq: lHit.rsrq, sinr: null, rssi: lHit.rssi } : null;
	};

	// 找出没能对应到任何载波的辅小区，合并后不把数据悄悄丢掉。
	api.unmatchedSecondaries = function (carriers, nr, lte) {
		var arfcns = {};
		carriers.forEach(function (c) { arfcns[Number(c.dlFcn)] = true; });
		return {
			nr: nr.filter(function (c) { return !arfcns[c.arfcn]; }),
			lte: lte.filter(function (c) { return c.dlArfcn === null || !arfcns[c.dlArfcn]; })
		};
	};

	/* ================= 网络拒绝原因 ^REJINFO（reject.ts 等价迁移） ================= */
	// 手册 13.14：注册或业务请求或网络 DETACH 过程被网络拒绝时主动上报。
	// 锁频锁错小区导致掉网时，这条上报能直接区分"被网络拒绝"和"根本没覆盖"。

	var REJ_DOMAINS = { 0: 'CS 域', 1: 'PS 域', 2: 'CS+PS 域' };
	var REJ_RATS = {
		0: 'GERAN(2G)', 1: 'UTRAN(3G)', 2: 'E-UTRAN(4G)',
		5: 'NR-5GC(5G SA)', 6: '其他'
	};
	var REJ_TYPES = {
		0: 'LAU 被拒', 1: '鉴权失败', 2: '业务请求被拒', 3: '网络 detach 被拒',
		4: 'ATTACH 被拒', 5: 'RAU 被拒', 6: 'TAU 被拒'
	};
	// 原因值来自 3GPP TS 24.008 / 24.301 / 24.501，未收录的原样显示编号
	var REJ_CAUSES = {
		2: 'IMSI 未在 HSS 登记', 3: '非法终端', 5: 'IMEI 不被接受', 6: '非法设备',
		7: '不允许使用分组域业务', 8: '不允许使用分组域和非分组域业务', 9: '网络无法识别终端身份',
		10: '已被网络隐式分离', 11: '不允许使用该 PLMN', 12: '不允许在该跟踪区注册',
		13: '该跟踪区不允许漫游', 14: '该 PLMN 不提供分组域业务', 15: '跟踪区内没有合适的小区',
		16: 'MSC 暂时不可达', 17: '网络故障', 18: 'CS 域不可用', 19: 'ESM 流程失败',
		20: 'MAC 校验失败', 21: '同步失败', 22: '网络拥塞', 23: '终端安全能力不匹配',
		24: '安全模式被拒绝', 25: '未授权接入该 CSG', 26: '非 EPS 鉴权不可接受',
		27: '不允许使用 N1 模式', 28: '受限的服务区域', 31: '需要重定向到 4G 核心网',
		35: '该 PLMN 未授权所请求的业务', 39: 'CS 业务暂时不可用', 40: '没有激活的 EPS 承载',
		42: '严重网络故障', 43: 'LADN 不可用', 62: '没有可用的网络切片',
		65: '已达到 PDU 会话数量上限', 67: '切片与 DNN 资源不足',
		71: '不允许通过非 3GPP 接入 5G 核心网', 72: '服务网络未授权',
		95: '消息语义错误', 96: '必选信元无效', 97: '消息类型不存在或未实现',
		98: '消息类型与协议状态不匹配', 99: '信元不存在或未实现',
		100: '条件信元错误', 101: '消息与协议状态不匹配', 111: '协议错误',
		256: '鉴权失败（模组内部扩展）', 258: '联合注册中 CS 失败（其他原因）',
		301: 'CS/PS 注册网络无响应', 302: 'CS/PS 注册建链异常', 303: 'CS/PS 注册建链异常'
	};
	// 手册 13.14.2：USIM 鉴权失败的原因值从 65537 开始，共 65537~65543
	var USIM_CAUSE_MIN = 65537, USIM_CAUSE_MAX = 65543;

	api.rejectCauseText = function (cause) {
		if (REJ_CAUSES[cause]) return REJ_CAUSES[cause];
		if (cause >= USIM_CAUSE_MIN && cause <= USIM_CAUSE_MAX) return 'USIM 鉴权失败（#' + cause + '）';
		return '未知原因（#' + cause + '）';
	};

	// 解析一行 ^REJINFO 上报，不匹配时返回 null。手册正文用了全角冒号，两种都收。
	api.parseRejInfo = function (line) {
		var match = line.match(/\^REJINFO[：:]\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (v) { return v.trim(); });
		if (f.length < 6) return null;
		var unquote = function (v) { return String(v == null ? '' : v).trim().replace(/^"|"$/g, ''); };
		var num = function (v) {
			var n = Number(unquote(v));
			return isFinite(n) ? n : 0;
		};
		var domain = num(f[1]), cause = num(f[2]), rat = num(f[3]), rejectType = num(f[4]);
		return {
			plmn: unquote(f[0]),
			domain: domain,
			domainText: REJ_DOMAINS[domain] != null ? REJ_DOMAINS[domain] : '域 ' + domain,
			cause: cause,
			causeText: api.rejectCauseText(cause),
			rat: rat,
			ratText: REJ_RATS[rat] != null ? REJ_RATS[rat] : '制式 ' + rat,
			rejectType: rejectType,
			rejectTypeText: REJ_TYPES[rejectType] != null ? REJ_TYPES[rejectType] : '类型 ' + rejectType,
			originalCause: num(f[5]),
			lac: unquote(f[6] || ''),
			rac: unquote(f[7] || ''),
			cellId: unquote(f[8] || ''),
			// 手册：当 LNAS 注册被拒绝 #19 时才会带上这个值
			esmCause: f[9] !== undefined ? num(f[9]) : undefined,
			raw: line.trim(),
			at: Date.now()
		};
	};

	/* ================= SIM 信号质量 ^SIMSQ（sim.ts 等价迁移） ================= */
	// 手册 6.6：^SIMSQ 能区分卡不在位 / 被锁 / PUK 锁死，+CPIN 看不出来。
	var SIM_STATUS = {
		0: '卡不在位', 1: '卡已插入', 2: '卡被 PIN/PUK 锁定', 3: 'SIMLOCK 锁定',
		10: '卡文件初始化中', 11: '卡初始化完成，可接入网络',
		12: '卡就绪，短信与电话本可用', 98: '卡已失效（PUK 锁死或物理损坏）',
		99: '卡已移除', 100: '卡初始化失败'
	};

	api.parseSimsq = function (text) {
		var match = String(text).match(/\^SIMSQ:\s*(\d+)\s*,\s*(\d+)/);
		if (!match) return null;
		var status = Number(match[2]);
		return {
			status: status,
			label: SIM_STATUS[status] != null ? SIM_STATUS[status] : '状态 ' + status,
			dead: status === 98,
			present: status !== 0 && status !== 99
		};
	};

	return api;
})();

/*
 * LuCI requires factory to return a Class subclass (instantiated once).
 * Also set window.Parse for page-side global.
 */
var ParseClass = L.Class.extend(Parse);
if (typeof window !== 'undefined') {
	window.Parse = new ParseClass();
}
return ParseClass;
