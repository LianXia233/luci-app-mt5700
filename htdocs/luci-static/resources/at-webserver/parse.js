'use strict';
'require baseclass';
/* global AtWs, baseclass */

/**
 * 补充解析库：运行状态 / 短信 / 锁频 / 定时锁频 / 系统配置解读 DTO。
 * 全部从原 React 前端 modem/*.ts 等价迁移，与 Rust 后端的应答格式严格一致。
 */

var Parse = (function () {
	var api = {};

	/* ================= 公共取值工具（全文件唯一真源） =================
	 *
	 * 此前「剥引号」「转数字」「转十六进制」在各函数体内各写一份，且**契约不一致**：
	 * parseRejInfo 里的 num() 缺字段时返回 0，于是「域」字段一丢就被
	 * REJ_DOMAINS[0] 渲染成「CS 域」——把「没取到」伪装成了「取到了 CS 域」。
	 * 统一后的契约：缺字段 / 非法值一律 **null**（null 才表示「没取到」），
	 * 绝不用 0 兜底（0 在 RSRP/域/制式里都是**合法取值**，会和真实测量混淆）。
	 */

	/* 剥掉首尾成对的引号。只剥首尾各一对，字段内部的引号不动。 */
	function unquote(v) {
		return String(v == null ? '' : v).trim().replace(/^"|"$/g, '');
	}

	/* 数字或 null：空串与非法值都归 null（注意 Number('') === 0，必须显式判空） */
	function numOrNull(v) {
		var t = String(v == null ? '' : v).trim();
		if (t === '') return null;
		var n = Number(t);
		return isFinite(n) ? n : null;
	}

	/*
	 * 十六进制字段（PCI / TAC / Cell-ID 都是）。
	 *
	 * 必须先判空再用 parseInt：parseInt(undefined, 16) 是 NaN，而 NaN 会一路
	 * 传到界面变成字面上的「NaN」，还会让「锁定小区」的校验把它当成非法值拒掉。
	 * 字段缺失（`^MONNC: NR,524910` 或尾随逗号）时应当显示「—」而不是 NaN。
	 */
	function hexOrNull(v) {
		var t = String(v == null ? '' : v).trim().replace(/"/g, '');
		if (t === '') return null;
		var n = parseInt(t, 16);
		return isFinite(n) ? n : null;
	}

	/*
	 * 取十六进制字符串第 bitIndex 位（0 = 最低位）。
	 *
	 * ★ 为什么不能用数值做位测试：手册里 WCDMA VIII/IX/XIX 的宏值在第 49/50/60 位，
	 *   `parseInt(hex,16)` 一旦超过 2^53 就开始丢低位（2^60 附近的浮点间隔是 256），
	 *   此时 `Math.floor(v/mask) % 2` 会把「GSM 1800 + WCDMA XIX」这种组合里的
	 *   低位判丢 —— 掩码越大越危险。改成直接在十六进制串上按字符取位，任意位宽都精确。
	 */
	function hexBit(hexStr, bitIndex) {
		var pos = hexStr.length - 1 - Math.floor(bitIndex / 4);
		if (pos < 0) return false;
		var d = parseInt(hexStr.charAt(pos), 16);
		return !isNaN(d) && ((d >> (bitIndex % 4)) & 1) === 1;
	}

	/* 把一组位下标还原成十六进制串（用于「未识别位」提示，同样不受 2^53 限制）
	 *
	 * 位下标**不必**有序：下面用 reduce 取真正的最大值来定 nibble 数组长度。
	 * 原先写的是 `bits[bits.length - 1]` —— 那**暗中要求调用方升序**：一旦有人
	 * 传入未排序的数组，数组就会初始化不足，中间出现稀疏空洞（undefined），
	 * 随后 `nibbles[j].toString(16)` 抛 TypeError。本函数是**导出的**
	 * （`api.hexFromBits`），契约不该藏在调用方的书写习惯里。
	 * （现有两处调用方传的都是升序，所以这是加固、不是修故障。）
	 */
	function hexFromBits(bits) {
		if (!bits.length) return '';
		var maxBit = bits.reduce(function (m, b) { return b > m ? b : m; }, 0);
		var nibbles = [];
		for (var i = 0; i <= Math.floor(maxBit / 4); i++) nibbles.push(0);
		bits.forEach(function (b) { nibbles[Math.floor(b / 4)] |= 1 << (b % 4); });
		var out = '';
		for (var j = nibbles.length - 1; j >= 0; j--) out += nibbles[j].toString(16);
		return out.replace(/^0+/, '') || '0';
	}
	api.hexFromBits = hexFromBits;

	/* ================= 信号语义（百分比 / 等级）唯一真源 =================
	 *
	 * 此前 rpc.js 的 calculateSignalPercent 用 -110~-70 量程、mt5700.js 的
	 * signalPercent 用 -120~-70，**同一个 RSRP 在两个页面显示两个百分比**
	 * （-90 dBm 一处 50%、一处 60%），而且 mt5700.js 里给百分比定的分级阈值
	 * （75/50/25）又是按 -110~-70 那套算出来的，与自己文件里的公式对不上。
	 *
	 * 现在统一到 -120 dBm=0% / -70 dBm=100%（RSRP 的可用动态范围），
	 * 分级阈值同步按新公式重算，rpc.js 与 mt5700.js 一律消费这里。
	 */

	var SIGNAL_RANGE = { min: -120, max: -70 };
	var PERCENT_LEVELS = [
		[80, 'exc'], [60, 'good'], [40, 'fair'], [0, 'bad']
	];

	/* RSRP(dBm) → 0-100 的整数百分比；取不到返回 null（null 才渲染成「—」）
	 *
	 * ★ 为什么把 >= 0 也当「没取到」：RSRP 实测上限是 -44 dBm，0 dBm 不存在。
	 *   而多条解析路径用 0 当「未测到」的哨兵值（例如 convertRsrp 的入参），
	 *   若不拦，0 会被算成满格 100% —— 界面上是「信号满格」，实际是没测到。
	 */
	api.signalPercent = function (rsrp) {
		if (rsrp == null || !isFinite(Number(rsrp)) || Number(rsrp) >= 0) return null;
		var span = SIGNAL_RANGE.max - SIGNAL_RANGE.min;
		var pct = Math.round(100 * (Number(rsrp) - SIGNAL_RANGE.min) / span);
		return Math.max(0, Math.min(100, pct));
	};

	/*
	 * RSRP → 等级（exc/good/fair/poor/bad）。
	 * 阈值与上面百分比的 80/60/40 对齐：-80→80%、-90→60%、-100→40%。
	 */
	api.signalLevel = function (rsrp) {
		if (rsrp == null || !isFinite(Number(rsrp)) || Number(rsrp) >= 0) return null;
		var v = Number(rsrp);
		return v >= -80 ? 'exc' : v >= -90 ? 'good' : v >= -100 ? 'fair' : v >= -110 ? 'poor' : 'bad';
	};

	/* 百分比 → 等级（仪表/条共用一套判定，不再各写一个三元表达式） */
	api.percentLevel = function (pct) {
		if (pct == null || !isFinite(Number(pct))) return null;
		for (var i = 0; i < PERCENT_LEVELS.length; i++) {
			if (Number(pct) >= PERCENT_LEVELS[i][0]) return PERCENT_LEVELS[i][1];
		}
		return 'bad';
	};

	/* ================= 状态类 ================= */

	// AT^LENDC?
	api.parseLendc = function (text) {
		var match = String(text == null ? '' : text).match(/\^LENDC:\s*([\d,\s]+)/);
		if (!match) return null;
		/*
		 * ★ 手册 11.7.1 的两种应答**字段数不同**，这是本函数要区分的第一件事：
		 *     AT^LENDC?  查询 → ^LENDC:<enable>,<endc_available>,<endc_plmn_available>,
		 *                             <endc_restricted>,<nr_pscell>        （5 段，第一段是 <enable>）
		 *     URC 主动上报    → ^LENDC:<endc_available>,<endc_plmn_available>,
		 *                             <endc_restricted>,<nr_pscell>        （4 段，无 <enable>）
		 *   所以"段数够 5 就跳过 <enable>"—— 这一步的依据就是手册。
		 *
		 * ★ 但**不能拿"过滤掉非数字之后的长度"来判**：查询应答里的字段可能为空
		 *   （例如 `^LENDC: 0,1,1,0,`，<nr_pscell> 没上报），过滤后只剩 4 段，就会被
		 *   误判成 URC 形态，进而整体错位 —— 界面上把 <enable> 当成 <endc_available>。
		 *   手册同节写明「本命令仅在 LTE 主模查询结果有效」，所以非 LTE 主模下字段为空
		 *   是可能发生的，这条路径不是纯理论。
		 *   改为：**先按原始段数定位，再逐个转数**（numOrNull 对空串返回 null）。
		 */
		var nums = match[1].split(',').map(function (v) { return numOrNull(v); });
		var v = nums.length >= 5 ? nums.slice(1) : nums;
		if (v.length < 4) return null;
		/* 缺字段（null）一律不判为 1，避免把"没上报"读成确定结论 */
		return {
			available: v[0] === 1,
			plmnAvailable: v[1] === 1,
			restricted: v[2] === 0,
			established: v[3] === 1
		};
	};

	var INVALID_POWER = 999;
	var power = function (v) {
		/*
		 * 空字段必须当「无测量」返回 null。
		 * Number('') 是 0 且 isFinite(0) 为真，缺字段（`1,2,3,,5`）会被算成
		 * 0 dBm —— 界面上就是「发射功率 0」，看着像故障，其实是没测到。
		 * 数值转换走公共 numOrNull，这里只加「999 = 无效读数」这一条业务规则。
		 */
		var n = numOrNull(v);
		if (n === null || n === INVALID_POWER) return null;
		return n;
	};

	// AT^TXPOWER?
	api.parseNrTxPower = function (text) {
		var match = String(text == null ? '' : text).match(/\^NTXPOWER:\s*(.+)/);
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

	var REG_STATES = { 0: '未注册，未搜网', 1: '已注册', 2: '未注册，搜网中', 3: '注册被拒绝', 4: '未知原因', 5: '已注册（漫游）', 8: '仅紧急业务' };
	/*
	 * 对外暴露：**注册态文案以这张表为唯一口径**（3GPP TS 27.007 的 +CEREG/+C5GREG stat 定义）。
	 * rpc.js 的 psRegText 原先自己另写了一套（0 号写成「未注册，正在搜索」、2 号缀上
	 * 「但允许紧急呼叫」），于是同一个 stat 码在网络状态页和诊断项里显示成两种说法。
	 * 现在两边共用这一张表 —— 改文案只改这里。
	 */
	api.REG_STATES = REG_STATES;
	var ACT_TYPES = { 10: 'EUTRAN-5GC', 11: 'NR-5GC' };

	// AT+C5GREG?
	api.parseC5greg = function (text) {
		var match = String(text == null ? '' : text).match(/\+C5GREG:\s*(.+)/);
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
		return String(text == null ? '' : text).split(/\r?\n/)
			.map(function (line) { return line.match(/\+CGPADDR:\s*(\d+),?\s*"?([^"\r\n]*)"?/); })
			.filter(function (m) { return m !== null && m[2].trim() !== ''; })
			.map(function (m) {
				var fmt = formatPdpAddress(m[2].trim());
				return { cid: Number(m[1]), address: fmt.address, family: fmt.family };
			});
	};

	/*
	 * 出口 IP 回显响应解析（mt5700.exitip 的 body）。
	 *
	 * ★ 为什么解析放在前端而不是 ucode：后端只负责「取回原文」，不解读含义 ——
	 *   与 sysdiag「只给事实、判定交前端」是同一条分工线。回显服务返回的是纯文本
	 *   （有的带 HTML、有的带换行），这里必须严格校验成合法 IP 才认，
	 *   不能把一段错误页当地址显示出去。
	 *
	 * 返回 null 表示「取回来的东西不是 IP」—— 调用方必须按「无法判定」呈现，
	 * 不许退化成 0.0.0.0 之类看起来像有值的占位（红线 23 的同构要求）。
	 */
	api.parseExitIpBody = function (text) {
		var s = String(text == null ? '' : text).trim();
		if (!s) return null;
		/* 先整串试：ipify / ifconfig.me/ip 这类回的就是一个裸 IP */
		if (isIpLiteral(s)) return s;
		/* 再退而求其次：从响应里抠第一个像 IP 的片段（myip.ipip.net 会带「当前 IP：x.x.x.x 来自于：…」） */
		var m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
		if (m && isIpLiteral(m[1])) return m[1];
		var m6 = s.match(/([0-9A-Fa-f:]{2,39})/);
		if (m6 && isIpLiteral(m6[1])) return m6[1];
		return null;
	};

	/* 严格 IP 字面量校验：IPv4 四段各 0~255；IPv6 交给 Node/浏览器不兜，
	 *   这里只认「含冒号且每段 1~4 位十六进制」的形态。 */
	function isIpLiteral(s) {
		var v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
		if (v4) {
			for (var i = 1; i <= 4; i++) {
				var n = Number(v4[i]);
				if (!Number.isInteger(n) || n < 0 || n > 255) return false;
			}
			return true;
		}
		if (s.indexOf(':') < 0) return false;
		if (!/^[0-9A-Fa-f:]+$/.test(s)) return false;
		var parts = s.split(':');
		if (parts.length < 3 || parts.length > 8) return false;
		for (var j = 0; j < parts.length; j++) {
			if (parts[j].length === 0) continue;   /* "::" 压缩写法允许空段 */
			if (parts[j].length > 4) return false;
			if (!/^[0-9A-Fa-f]+$/.test(parts[j])) return false;
		}
		return true;
	}

	/* ================= 空口健康 ================= */

	/*
	 * AT^PDCPDATAINFO? —— 按 DRB 粒度上报的 PDCP 统计（手册 5.36）。
	 *
	 * 手册列的 14 个字段：
	 *   <id>,<pduSessionId>,<discardTimerLen>,<avgDelay>,<minDelay>,<maxDelay>,
	 *   <highPriQueMaxBuffTime>,<lowPriQueMaxBuffTime>,<highPriQueBuffPktNums>,
	 *   <lowPriQueBuffPktNums>,<ulPdcpRate>,<dlPdcpRate>,<ulDiscardCnt>,<dlDiscardCnt>
	 *
	 * ★ 真机比手册多回 2 个字段（2026-09-18 实测）：
	 *     ^PDCPDATAINFO: 2,6,500,0,0,0,0,0,0,0,0,0,17333,0,574750503,558267589
	 *     ^PDCPDATAINFO: 11,5,65535,0,0,0,0,0,0,0,0,0,0,0,45072,45072
	 *   末尾两个大数手册无记载（疑似累计收发字节），**没有依据就不解读**：
	 *   只取前 14 个，多余的忽略——绝不能把未知字段当丢包数显示给用户。
	 *
	 * ★ 主动查询时 avgDelay / minDelay / maxDelay / ulPdcpRate / dlPdcpRate 恒为 0
	 *   （手册原文：「主动查询时为 0」），只有「丢包总数 / 队列缓存 / 丢弃定时器」是真值。
	 *   所以这几个 0 字段干脆不解析，免得被当成「时延 0 / 速率 0」的假故障。
	 *
	 * ★ discardTimerLen 报 65535 = 该 DRB 未配置（实测第二个 DRB 就是），
	 *   按「无测量」返回 null，界面显示「—」而不是「65535 ms」。
	 *   但丢包总数是累计值，65535 在这里可能是真值，不过滤。
	 */
	var PDCP_UNSET = 65535;
	api.parsePdcpDataInfo = function (text) {
		var out = [];
		String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
			var m = line.match(/\^PDCPDATAINFO:\s*([\d,\s]+)/);
			if (!m) return;
			var f = m[1].split(',').map(function (s) { return s.trim(); });
			if (f.length < 14) return;
			/* 配置类字段：未配置（65535）→ null */
			var conf = function (i) {
				var n = Number(f[i]);
				return (isFinite(n) && n !== PDCP_UNSET) ? n : null;
			};
			/* 计数类字段：0 是真值，不能用 65535 过滤 */
			var cnt = function (i) {
				var n = Number(f[i]);
				return isFinite(n) ? n : null;
			};
			out.push({
				id: cnt(0),
				pduSessionId: cnt(1),
				discardTimerLen: conf(2),
				highPriQueMaxBuffTime: conf(6),
				lowPriQueMaxBuffTime: conf(7),
				highPriQueBuffPktNums: cnt(8),
				lowPriQueBuffPktNums: cnt(9),
				ulDiscardCnt: cnt(12),
				dlDiscardCnt: cnt(13)
			});
		});
		return out;
	};

	/*
	 * 已删除 Parse.parseFastdorm 与它的 FASTDORM_TYPES 表（2026-09-28）。
	 *
	 * 它是 2.3.x 早期「空口健康」卡显示快速休眠状态的遗留：那一版把 ^FASTDORM
	 * 当成一项要展示的指标，后来判定它「只是复述一个用户既改不了也无需改的模组
	 * 开关，每轮白搭一次串口往返」，查询被移除，解析器随之失去调用方。
	 * 全仓确认**零调用点**（parse.js 之外无任何文件引用 parseFastdorm /
	 * FASTDORM_TYPES），属于死代码。若日后要恢复该展示，直接从 git 历史取回即可。
	 */

	/*
	 * AT+CGSMS? —— 短信承载域（手册 7.7）。
	 *   0 只选 PS 域 / 1 只选 CS 域 / 2 优先 PS 域 / 3 优先 CS 域（默认 3）
	 * ★ 手册原文：「为提高短信发送成功率，实际配置如下：0、2 优先选择 PS 域；1、3 优先选择 CS 域」。
	 *   5G SA 下根本没有 CS 域，保持默认的「优先 CS」会让短信发不出去，
	 *   所以这里要能给出 preferCs 判定，界面才好提示改成 PS 优先。
	 */
	var CGSMS_SERVICES = {
		0: '只选 PS 域',
		1: '只选 CS 域',
		2: '优先 PS 域',
		3: '优先 CS 域'
	};
	api.parseCgsms = function (text) {
		var m = String(text == null ? '' : text).match(/\+CGSMS:\s*(\d+)/);
		if (!m) return null;
		var s = Number(m[1]);
		return {
			service: s,
			text: CGSMS_SERVICES[s] || ('取值 ' + s),
			preferCs: s === 1 || s === 3,
			preferPs: s === 0 || s === 2
		};
	};

	/*
	 * AT+CREG? —— CS 域注册状态（手册 CREG；stat 与 +CEREG 同一套定义，见上面 REG_STATES）。
	 *
	 * ★ 为什么必须补这一个原语：短信可达性里「承载域选了 CS 优先」那条告警原来是
	 *   **无条件**触发的，措辞还写死「5G SA 下没有 CS 域」——那是**假设**，不是实测。
	 *   真机实测（2026-09-24，中国移动卡）：
	 *       +CREG: 0,0        ← CS 域未注册
	 *       +CEREG: 2,1 / +C5GREG: 2,1   ← PS 侧正常
	 *       +CGSMS: 3         ← 承载域却选了「优先 CS」
	 *   三条合起来才是「短信被指向了一个不存在的域」的证据，缺 +CREG 就缺了最关键一环。
	 *
	 *   反过来，机器回落到 GSM/UMTS 时 CS 域是**存在**的，那时 CGSMS=3 是正确的，
	 *   无条件告警会误报。所以判据必须是「preferCs」**且**「CS 域实测未注册」两个条件同时成立。
	 *
	 * ★ registered 只对 stat ∈ {1, 5} 为 true（已注册本地网 / 已注册漫游）；
	 *   其余（0 未注册、2 搜网中、3 被拒、4 未知、8 仅紧急）一律 false。
	 * ★ 解析不出来返回 null —— 由调用方归入「读不到」，不许按乐观值补齐（红线 23）。
	 */
	api.parseCsDomain = function (text) {
		var r = api.parseRegStat(String(text == null ? '' : text), '+CREG');
		if (!r) return null;
		return { stat: r.stat, text: r.statText, registered: r.stat === 1 || r.stat === 5 };
	};

	/* ================= 温度 ================= */

	// AT^CHIPTEMP?
	api.parseCHIPTEMP = function (text) {
		/*
		 * ★ 先包一层 String(text == null ? '' : text) —— 与同文件的 parseCgsms /
		 *   parseCsDomain / parseC5greg 等保持一致。
		 *
		 *   本函数唯一的调用点是 `network_status.js` 的
		 *   `Parse.parseCHIPTEMP(res.data)`，而 `res.data` 在请求失败时可能是
		 *   null / undefined（同一文件其它地方普遍写成 `String(r && r.data ? r.data : '')`
		 *   正是因为它可空）。原写法直接 `text.match(...)`，传 null 会抛 TypeError
		 *   并带崩那一块渲染；解析不出来本该是「读不到」，不是「崩掉」。
		 */
		var match = String(text == null ? '' : text).match(/\^CHIPTEMP:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		var g = function (i) { return f[i] !== undefined ? AtWs.parseTemperature(f[i]) : 0; };
		/*
		 * ^CHIPTEMP 返回 12 路传感器温度，顺序见鼎桥手册 17.1：
		 *   sub3G PA, sub6G PA, MIMO PA, TCXO, peri1, peri2, ap1, ap2,
		 *   modem1, modem2, bbp1, bbp2
		 * ★ 旧实现只取前 7 路，且把 f[4]/f[5]/f[6] 错标成 ap1/ap2/modem1
		 *   （实为 peri1/peri2/ap1）——既漏了最热的 modem/bbp，名字也全错位。
		 *   现按手册补全 12 路并改正命名。65535（无效值）由 parseTemperature 归 0。
		 */
		return {
		sub3GPA: g(0), sub6GPA: g(1), mimoPa: g(2), tcxo: g(3),
		peri1: g(4), peri2: g(5), ap1: g(6), ap2: g(7),
		modem1: g(8), modem2: g(9), bbp1: g(10), bbp2: g(11)
		};
	};

	/* ================= MCS ================= */

	// AT^MCS=0 / =1
	/*
	 * ^MCS 实测格式（5 字段，纯十进制文本，无字节序问题）：
	 *   ^MCS: <方向回显>,<层数>,<码字/保留>,<MCS 值>,<保留>
	 *   下行查询 AT^MCS=1 → "^MCS: 1,1,1,0,255"
	 *   上行查询 AT^MCS=0 → "^MCS: 0,1,1,20,255"
	 * f0 是查询方向回显（1=DL / 0=UL），不是 MCS；MCS 在 f3。
	 * MCS 有效值域 0-31，超出（如 255）视为无效，回退 null。
	 */
	api.parseMCS = function (text) {
		var match = String(text == null ? '' : text).match(/\^MCS:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		var mcs = f[3] !== undefined ? parseInt(f[3], 10) : NaN;
		var rank = f[1] !== undefined ? parseInt(f[1], 10) : NaN;
		return {
			mcs: (mcs >= 0 && mcs <= 31) ? mcs : null,
			rank: (rank >= 1 && rank <= 8) ? rank : null
		};
	};

	/*
	 * MCS → 调制方式显示映射（3GPP TS 38.214 MCS 表 2 口径，兼顾两例锚点）：
	 *   0-9   → QPSK
	 *   10-16 → 16QAM
	 *   17-25 → 64QAM   （上行 MCS 20 → 64QAM）
	 *   26-31 → 256QAM  （下行 MCS 27 → 256QAM）
	 * 无效值返回 null，由调用方回退既有占位符。
	 */
	api.mcsModulation = function (mcs) {
		if (mcs == null || isNaN(mcs) || mcs < 0 || mcs > 31) return null;
		if (mcs <= 9) return 'QPSK';
		if (mcs <= 16) return '16QAM';
		if (mcs <= 25) return '64QAM';
		return '256QAM';
	};

	/* ================= IPv6 CAP ================= */

	/*
	 * IPv6 能力值（手册 16.7.3）：
	 *   0x01 = IPV4 ONLY
	 *   0x02 = IPV6 ONLY
	 *   0x07 = IPV4 ONLY + IPV6 ONLY + IPV4V6 使用相同 APN（双栈，同一 APN）
	 *   0x0B = IPV4 ONLY + IPV6 ONLY + IPV4V6 使用不同 APN（双栈，分用 APN）
	 *   其它值（含 0x00）手册标「保留」，一律按「未知能力值 N」原样展示，不编造支持/不支持。
	 *
	 * ★ 两处历史坑：
	 *   ① 旧代码把 0 判成「不支持 IPv6」、1 判成「支持 IPv6」—— 按手册 1 是**仅 IPv4**，
	 *      恰好译反。已纠正，守卫见 tests/connection-tools-contract.test.js 第 8 节。
	 *   ② 界面此前直接显示「能力值 7」，用户看不懂。真机 ^IPV6CAP: 7 就是双栈同 APN。
	 * 行名保持「IPv6 支持」；「能力」与「当前是否已取到 IPv6 地址」是两回事，这里只给能力。
	 */
	api.ipv6CapDescription = function (v) {
		/* 手册只定义了 1 / 2 / 7 / 11 四个取值，其余（含 0）一律原样给裸值 ——
		   0 不在码表里，「未获取能力值」是我们编的解读，不干这事。 */
		if (v === 1) return '仅 IPv4';
		if (v === 2) return '仅 IPv6';
		if (v === 7) return '支持 · 双栈（同一 APN）';
		if (v === 11) return '支持 · 双栈（分用 APN）';
		return '未知能力值 ' + v;
	};

	/* ================= 系统配置解读（SYSCFGEX，手册 13.2） =================
	 * 这几个字段都是编码/位掩码，直接摆十六进制没人看得懂，这里翻成中文/频段号。
	 */

	/*
	 * 解析 `AT^SYSCFGEX?` 应答 → { acqorder, band, roam, srvdomain, lteband }
	 *
	 * 为什么必须清洗字段：应答形如
	 *   ^SYSCFGEX: "080302",2000000680380,1,2,1E200000095\r\nOK
	 * 最后一段后面没有逗号收尾，若用 ([^,]*) 抓取会把 "\r\nOK" 一起吞进来。
	 * 这些值要原样拼回 AT^SYSCFGEX= 命令，带换行会把命令行截断成两条，
	 * 因此这里统一去掉换行与应答尾部的 OK/ERROR。
	 */
	api.parseSysCfg = function (text) {
		var m = String(text == null ? '' : text)
			.match(/\^SYSCFGEX:\s*"([^"]*)",\s*([^,]*),\s*(\d+),\s*(\d+),\s*([^,\r\n]*)/);
		if (!m) return null;
		/* 只比公共 unquote 多两件事：应答尾部可能带 \r\n 与 OK/ERROR（见上） */
		var tok = function (v) {
			return unquote(String(v == null ? '' : v)
				.replace(/[\r\n]+/g, '')
				.replace(/\s*(OK|ERROR)\s*$/i, ''));
		};
		return {
			acqorder: tok(m[1]), band: tok(m[2]),
			roam: Number(m[3]), srvdomain: Number(m[4]),
			lteband: tok(m[5])
		};
	};

	/* 把回读字段拼成可安全下发的 AT^SYSCFGEX 命令（空值视为「不修改」用 99/0 占位由调用方决定） */
	api.buildSysCfgCommand = function (cfg) {
		var c = cfg || {};
		var num = function (v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; };
		/*
		 * ★ 三个字符串字段必须先清洗再拼接 —— 它们是**直接拼进 AT 命令**的，
		 *   而值来自模组回读：`parseSysCfg` 里 `band` 取自 `([^,]*)`、
		 *   `lteband` 取自 `([^,\r\n]*)`，**两者都允许含引号**。
		 *   一个 `"` 就能闭合 `<acqorder>` 的字符串参数、把后面的内容改写成新参数。
		 *
		 *   这里**只剥 `" \r \n`，不剥逗号与分号** —— 与公共的 `api.sanitizeAtParam`
		 *   刻意不同：那一个是为「参数值」设计的、会连 `,` `;` 一起去掉，
		 *   而 `<acqorder>` 的语法里逗号是否带分隔含义我无法从手册确证；
		 *   现有取值（如 "080302"）本就不含逗号，保守起见不动它。
		 */
		var clean = function (v) { return String(v == null ? '' : v).replace(/["\r\n]/g, ''); };
		return 'AT^SYSCFGEX="' + clean(c.acqorder) + '",' + clean(c.band) + ','
			+ num(c.roam, 1) + ',' + num(c.srvdomain, 2) + ',' + clean(c.lteband) + ',,';
	};

	var SYSCFG_FIELDS = [
		{ key: 'acqorder', label: '网络接入顺序', bitmap: false },
		{ key: 'band', label: '2G / 3G 频段', bitmap: true },
		{ key: 'roam', label: '漫游', bitmap: false },
		{ key: 'srvdomain', label: '服务域', bitmap: false },
		{ key: 'lteband', label: '4G / LTE 频段', bitmap: true }
	];

	/* 十六进制归一化到大写无前导零；不是合法十六进制返回空（无法按位判定） */
	function normHexForCompare(v) {
		var t = String(v == null ? '' : v).trim().toUpperCase();
		if (!/^[0-9A-F]+$/.test(t)) return '';
		t = t.replace(/^0+/, '');
		return t || '0';
	}

	/* got ⊆ want ? 在十六进制串上逐位测，不受 2^53 限制 */
	function hexMaskSubset(wantHex, gotHex) {
		var w = normHexForCompare(wantHex), g = normHexForCompare(gotHex);
		if (!w || !g) return false;
		for (var i = 0; i < g.length * 4; i++) {
			if (hexBit(g, i) && !hexBit(w, i)) return false;
		}
		return true;
	}

	/*
	 * 写后校验：列出「本次真的下发了」的每个字段及其生效情况。
	 *
	 * ★★ 存在的理由 —— 本机实测 AT 回 OK 并不代表写进去了：
	 *   ① <band> 下发 ANY(3FFFFFFF) → 回 OK，NV 一字不改
	 *   ② <lteband> 下发 ALL → 回 OK，被硬件能力掩码裁剪成较小的集合
	 *   只看 result.success 会把 ① 报成成功，把 ② 报成失败，两者都是骗人。
	 *
	 * state 语义：
	 *   exact    完全一致
	 *   clipped  回读是下发值的子集 —— **已生效**，只是能力不支持的位被裁掉了
	 *   rejected 回读既不等于下发值、也不是它的子集 —— 模组没接受
	 *   unknown  回读不到，不臆断，交给调用方另做提示
	 *
	 * 值为空（界面上的「不修改」）的字段没有下发，不参与校验。
	 */
	api.sysCfgApplyCheck = function (wanted, actual) {
		var w = wanted || {}, a = actual || {}, out = [];
		SYSCFG_FIELDS.forEach(function (f) {
			var wv = String(w[f.key] == null ? '' : w[f.key]).trim();
			if (!wv) return;                       /* 没下发就不算账 */
			var av = String(a[f.key] == null ? '' : a[f.key]).trim();
			var row = { key: f.key, label: f.label, want: wv, got: av, state: 'unknown' };
			if (!av) {
				row.state = 'unknown';
			} else if (f.bitmap) {
				/*
				 * ★ 位图分支必须先判「能不能比」——normHexForCompare 对非十六进制返回空串，
				 *   而 hexMaskSubset 拿到空串会**直接 return false**。若不加这层守卫，
				 *   回读值只要不是合法十六进制（模组异常应答、被别处写成乱码），
				 *   就会一路落到 'rejected'，被消费端断言成「模组未接受：该取值本机不支持」
				 *   —— 那是**凭空替模组背了个书面结论**，而真实情况是「根本没法比较」。
				 *   与上面 !av 的处理同构：拿不到可比的值，就诚实报 unknown，交给上层提示复核。
				 */
				if (!normHexForCompare(wv) || !normHexForCompare(av)) row.state = 'unknown';
				else if (normHexForCompare(wv) === normHexForCompare(av)) row.state = 'exact';
				else if (hexMaskSubset(wv, av)) row.state = 'clipped';
				else row.state = 'rejected';
			} else {
				/* 非位图字段严格相等：命令里的 1 与回读的 "1" 是同一个值，
				   但 '080302' 绝不能被当成 '0803' 的某种变体 —— 那正是要报出来的。
				 *
				 * ★ 数值等价只在**两边都真的是数字**时才成立。
				 *   原写法是 `String(Number(wv)) === String(Number(av))`，它有个漏洞：
				 *   两边都不是数字时 Number 都返回 NaN，而 `String(NaN)` 是 `'NaN'`
				 *   —— 于是两个毫不相干的字符串（'abc' 与 'xyz'）会被判成 exact，
				 *   与上面那句"严格相等"的判据正好相反。补上有限性守卫。
				 */
				var nw = Number(wv), na = Number(av);
				var numericEqual = isFinite(nw) && isFinite(na) && nw === na;
				if (wv.toUpperCase() === av.toUpperCase() || numericEqual) row.state = 'exact';
				else row.state = 'rejected';
			}
			out.push(row);
		});
		return out;
	};

	/* ================= NR 能力（NRRCCAPQRY，手册 13.26） =================
	 * 真机语法只有 AT^NRRCCAPQRY=<mode>（带 ? 的形式恒回 ERROR，实测 0/3）。
	 * 应答形如 `^NRRCCAPQRY: <mode>,<para1>,<para2>,…`，取第 1 个参数即为该能力开关。
	 * 界面用到 mode：2 = VoNR 能力、3 = NR CA 能力、5 = DSS 能力。
	 */
	api.parseNrrcCapQry = function (text, mode) {
		var m = String(text == null ? '' : text)
			.match(new RegExp('\\^NRRCCAPQRY:\\s*' + Number(mode) + '\\s*,\\s*(\\d+)'));
		return m ? Number(m[1]) : null;
	};

	/* <acqorder>：每 2 位一个制式，按顺序表示搜索优先级 */
	var ACQ_CODES = { '01': 'GSM', '02': 'WCDMA', '03': 'LTE', '04': 'CDMA 1X', '07': 'CDMA EVDO', '08': 'NR', '99': '（不修改）' };
	api.decodeAcqOrder = function (s) {
		var t = String(s == null ? '' : s).trim().replace(/^"|"$/g, '');
		if (!t) return '未设置';
		if (t === '99') return '不修改（保持原有接入次序）';
		var out = [];
		/*
		 * 每 2 位一组。原判据是 `i + 1 < t.length + 1`（两边同减 1 即 `i < t.length`），
		 * 多写的 +1 会让人误以为边界更宽泛。直接写 `i < t.length`，末组不足 2 位时
		 * 由下面 `code.length < 2` 丢弃 —— 畸形的半个制式码不该被译成制式。
		 * 已实测：等价改写后对 '01'/'0103'/'010304'/'01 03' 输出完全一致。
		 */
		for (var i = 0; i < t.length; i += 2) {
			var code = t.substr(i, 2);
			if (code.length < 2) break;
			out.push(ACQ_CODES[code] || ('未知(' + code + ')'));
		}
		return out.length ? out.join(' → ') : '未设置';
	};

	/*
	 * <band>（GSM/WCDMA 频带位掩码）。手册 13.2.3 的宏值 → **位下标**。
	 * 0x00680380 是手册特别标注的「自动」组合；0x3FFFFFFF=任何频带；0x40000000=不修改。
	 *
	 * ★ 存位下标而不是掩码值：掩码值一旦超过 2^53 就装不进双精度，
	 *   `Math.floor(v/0x1000000000000000)%2` 这类测位会在存在低位时判丢。
	 */
	var BAND_BITS = [
		[7, 'GSM 1800'], [8, 'GSM 900(EGSM)'], [9, 'GSM 900(PGSM)'],
		[19, 'GSM 850'], [20, 'GSM 900(铁路)'], [21, 'GSM 1900'],
		[22, 'WCDMA I (2100)'], [23, 'WCDMA II (1900)'],
		[25, 'WCDMA IX (1700/AWS)'],
		[26, 'WCDMA V (850)'], [27, 'WCDMA VI (800)'],
		[49, 'WCDMA VIII (900)'], [50, 'WCDMA IX (1700)'],
		[60, 'WCDMA XIX (850)']
	];

	/*
	 * <band> 的「全部频段」取值 —— **必须是逐个单值的位叠加，不能是 ANY**。
	 *
	 * ★★ 实测证据（2026-09-26，本机 MT5700M-CN 固件 V200R001C20B025）：
	 *   下发 AT^SYSCFGEX="080302",3FFFFFFF,1,2,1E200000095,, 模组**回 OK**，
	 *   但回读 NV 一字未改；为进一步排除「裁剪后恰好等于原值」，先把 band 压成
	 *   别的值再发 ANY，回读**依旧纹丝不动** —— 即 MANUAL ANY 这条分支在该固件
	 *   上 request 收下了但没写 NV。改成本函数算出的叠加值后，14 个位一次全落盘。
	 *
	 * ★ 不能写死字面量：由 BAND_BITS 推导，改位表即改取值，不会失配。
	 * ★ 也不能用 Number 累加后 toString(16)：bit7..bit60 跨 54 位，超过双精度
	 *   53 位安全范围会丢低位 —— 一律走 hexFromBits 按 nibble 拼串。
	 */
	api.BAND_ALL_MASK = hexFromBits(BAND_BITS.map(function (b) { return b[0]; })).toUpperCase();

	api.decodeBandMask = function (s) {
		var t = String(s == null ? '' : s).trim();
		if (!t) return '未设置';
		var h = t.replace(/^0+/, '').toUpperCase();
		if (!h) h = '0';
		if (!/^[0-9A-F]+$/.test(h)) return '无法解析（应为十六进制）';
		if (h === '3FFFFFFF') return '任何频带（不限制）';
		if (h === '40000000') return '不修改';
		if (h === '680380') {
			return '自动（GSM 850/900/1800/1900 + WCDMA I；如需含 WCDMA 900，值为 2000000680380）';
		}
		/* 位测试直接在十六进制串上做，任意位宽都精确（见 hexBit 的说明） */
		var names = [];
		var known = {};
		BAND_BITS.forEach(function (b) {
			if (hexBit(h, b[0])) { names.push(b[1]); known[b[0]] = true; }
		});
		var unknown = [];
		for (var i = 0; i < h.length * 4; i++) {
			if (hexBit(h, i) && !known[i]) unknown.push(i);
		}
		if (unknown.length) names.push('未识别位 0x' + hexFromBits(unknown).toUpperCase());
		return names.length ? names.join(' · ') : '未设置';
	};

	/*
	 * <lteband> 的「全部频段」沿用手册 magic value 0x7FFFFFFFFFFFFFFF —— 与 <band>
	 * **故意不同**，因为本机实测这一条是**生效**的：先把 lteband 压到 1（仅 BC1）
	 * 再下发该值，回读被撑回 1E200000095（BC1/3/5/8/34/38/39/40/41），即模组只是
	 * 按硬件能力掩码做了按位与。后果是本机日常就处在能力全集上，保存后看不出变化
	 * —— 那是「已经最大」，不是「没写进去」，写后校验要用位图子集判定（见
	 * sysCfgApplyCheck），不能靠字符串相等，否则会把正常裁剪误报成失败。
	 */
	api.LTE_BAND_ALL_MASK = '7FFFFFFFFFFFFFFF';

	/* <lteband>：位掩码，第 n 位 = LTE B(n+1)（手册 13.2.3 逐条列出，与位序一致） */
	api.decodeLteBandMask = function (s) {
		var t = String(s == null ? '' : s).trim();
		if (!t) return '未设置';
		/*
		 * ★ 与上面的 decodeBandMask 同构：先归一化十六进制串，位测试一律走 hexBit。
		 *
		 * 这里原先用 `parseInt(t,16)` + `Math.floor(v/2)` 逐位取。而本文件上方的
		 * 注释已经写明「掩码值一旦超过 2^53 就装不进双精度……这类测位会在存在
		 * 低位时判丢」—— lteband 的「全部频段」宏值 0x7FFFFFFFFFFFFFFF 有 63 位
		 * 有效位，早超出安全范围：实测 '7FFFFFFFFFFFFFF0' 只解出 B64（低位成片
		 * 被吞）。<band> 那侧已经改成逐字符取位，<lteband> 当时漏改。
		 *
		 * 全频段判据也必须拿**归一化后**的 h 去比：拿原始 t 比时，前导零会让它
		 * 失配（'07FFFFFFFFFFFFFF' 落进 parseInt 分支 → 只解出 B60）。
		 */
		var h = t.replace(/^0+/, '').toUpperCase();
		if (!h) h = '0';
		if (!/^[0-9A-F]+$/.test(h)) return '无法解析（应为十六进制）';
		if (h === '7FFFFFFFFFFFFFFF') return '任何频段（不限制）';
		var out = [];
		for (var i = 0; i < h.length * 4; i++) {
			if (hexBit(h, i)) out.push('B' + (i + 1));
		}
		return out.length ? out.join(', ') : '未设置';
	};

	/*
	 * 漫游取值文案。只给「这句人话」，不再把另一套语义以括号尾巴的形式塞进同一个
	 * label（旧版写成「0 · 开启国内国际漫游（旧语义：不支持漫游）」，一行里两套含义
	 * 并列，读的人根本分不清当前生效的是哪套 —— 那是把歧义摆到界面上，不是消除它）。
	 * 用哪套由 AT^SYSCFGEX=? 实报范围决定，见 roamOptions()。
	 */
	api.ROAM_TEXT = {
		0: '0 · 国内 + 国际都允许',
		1: '1 · 仅允许国内漫游',
		2: '2 · 仅允许国际漫游',
		3: '3 · 国内国际都不允许'
	};

	/*
	 * 漫游有**两套语义**（手册 13.2.3），取决于 NV 项「漫游特性」是否激活：
	 *   未激活（AT^SYSCFGEX=? 报 0-2）：0 不支持漫游 / 1 支持漫游 / 2 无变化
	 *   已激活（报 0-3）               ：0 开启国内国际 / 1 开国内关国际 /
	 *                                    2 关国内开国际 / 3 关闭国内国际
	 *
	 * ⚠️ 同一个数值在两套语义下含义**完全相反**：0 在前者是「禁止漫游」、
	 * 在后者是「国内国际全开」。因此下拉项与文案必须由模组实报的取值范围决定，
	 * 写死任何一套都会在另一台设备上把意思显示反 —— 这正是下面两个函数存在的理由。
	 *
	 * ★ 数值前缀「0 · / 1 · …」是**故意保留**的：只有漫游存在两套语义，用户拿
	 * 这个数字才能去手册 13.2.3 核对本机到底适用哪套。其余下拉（接入顺序、服务域）
	 * 没有歧义，前缀一律去掉。
	 */
	api.ROAM_TEXT_BASIC = {
		0: '0 · 不允许漫游',
		1: '1 · 允许漫游',
		2: '2 · 不修改'
	};

	/*
	 * 解析 AT^SYSCFGEX=? 的取值范围（只需 roam 与 srvdomain）。
	 * 实测应答：^SYSCFGEX: ("01","02","03","08"),((...),(...)),(0-2),(0-4),((...),(...))
	 * 只有这两项是 (a-b) 形式，其余都是枚举串，故直接抓所有 (a-b) 即可。
	 */
	api.parseSysCfgRanges = function (text) {
		var all = String(text == null ? '' : text).match(/\((\d+)\s*-\s*(\d+)\)/g) || [];
		var ranges = all.map(function (t) {
			var m = t.match(/\((\d+)\s*-\s*(\d+)\)/);
			return { min: Number(m[1]), max: Number(m[2]) };
		});
		return { roam: ranges[0] || null, srvdomain: ranges[1] || null };
	};

	/*
	 * 解析 AT^TDPCIELANCFG=? 的实报（**仅供展示，不再决定下拉取值**）。
	 *
	 * ★ 2026-09-28 更正：本段原写「为什么必须按 =? 实报取：写死任何一套都可能在别的
	 *   固件上把模组不认的值发下去」「解析不出时由调用方禁用下拉」—— **这两句都已
	 *   被推翻**，且与同仓 modem_settings.js 的实测结论直接冲突：
	 *     · 本机固件 `AT^TDPCIELANCFG=?` 自称只支持 (0,1)，而实测**接受 `=2` 并读回 2**
	 *       —— 自报残缺，不能当值域来源（否则界面永远看不到 2.5G 那一档）；
	 *     · 值域改按手册 11.19 与厂家固件取 1 / 2（见 modem_settings.js 的 NIC_VALUES
	 *       与它上方那段实测说明）；
	 *     · 所以本函数的结果现在只做一件事：把模组**自称**的值域展示给用户
	 *       （调用处变量名就叫 claimed），不参与任何「选项去留」的决策。
	 *   契约测试 device-control-contract.test.js 的 hasNot(...) 已把「不再用 =? 的解
	 *   结果去决定选项去留」钉住，防止回退。
	 *
	 * 两种风格都吃：枚举式 `(0,1)` 与范围式 `(0-1)`（同一固件的 AT^TDPMCFG=? 用的就是
	 * 范围式，所以这里不能只认枚举）。解析不出（固件回文档占位符
	 * `(list of supported <n>s)`）或范围宽得不合理时返回 null（调用方据此显示「未知」）。
	 */
	api.parseNicRange = function (text) {
		var m = String(text == null ? '' : text).match(/\^TDPCIELANCFG:\s*\(([\d,\s-]*)\)/);
		if (!m) return null;
		var seen = {};
		var out = [];
		function push(v) {
			if (/^\d+$/.test(v) && !seen[v]) { seen[v] = 1; out.push(v); }
		}
		m[1].split(',').forEach(function (part) {
			var bits = part.trim().split('-');
			if (bits.length === 1) { push(bits[0].trim()); return; }
			var a = Number(bits[0]);
			var b = Number(bits[1]);
			/* 跨度异常大（固件给了个宽范围）就不展开成几十个选项，交给调用方禁用 */
			if (b < a || b - a > 8) return;
			for (var i = a; i <= b; i++) push(String(i));
		});
		return out.length ? out : null;
	};

	/*
	 * 按实测上限生成漫游下拉项。范围未知时退回基础语义（0-2）：
	 * 本机 =? 实测就是 (0-2)，且基础语义是两台设备都支持的交集，取它最保守。
	 */
	api.roamOptions = function (max) {
		var table = (max != null && max >= 3) ? api.ROAM_TEXT : api.ROAM_TEXT_BASIC;
		var upper = (max != null ? max : 2);
		var out = [];
		for (var i = 0; i <= upper; i++) {
			if (table[i] == null) continue;
			out.push({ label: table[i], value: String(i) });
		}
		return out;
	};

	/*
	 * 服务域（srvdomain，手册 13.2.3）。与漫游不同，它**只有一套语义**、且实测
	 * 范围恒为 0-4，不需要按 =? 动态切换，故直接写死选项。
	 *
	 * ★ 2026-09-28 更正：原文写的是「实测范围恒为 0-4（枚举而非范围）」，
	 *   其中「枚举而非范围」与真机不符 —— 真机 AT^SYSCFGEX=? 回的是 (0-2) 与 (0-4)，
	 *   即 roam 与 srvdomain **都是 (a-b) 范围式**。这正是 parseSysCfgRanges 能用
	 *   「抓所有 (a-b)、取第 1 与第 2 个」解析的前提（那里也写明了"只有这两项是
	 *   (a-b) 形式"）。写死选项的真正理由是**语义唯一**（不存在漫游那种两套相反
	 *   含义），不是「值域是枚举」。
	 *
	 * 分成两张表：下拉 label 只给中文（「仅语音」），手册原名（CS_ONLY）只出现在
	 * 选中后的说明里 —— 缩写是给排障对手册用的，塞进 label 会让选项看起来像代号。
	 */
	api.SRV_DOMAIN_CODE = {
		0: 'CS_ONLY',
		1: 'PS_ONLY',
		2: 'CS_PS',
		3: 'ANY',
		4: '不修改'
	};

	api.srvDomainOptions = function () {
		return [
			{ value: '0', label: '仅语音' },
			{ value: '1', label: '仅数据' },
			{ value: '2', label: '语音 + 数据' },
			{ value: '3', label: '不限' },
			{ value: '4', label: '不修改' }
		];
	};


	/* ================= 补充注册/连接状态（对标 FAN789 项目用到的命令） ================= */

	/* +CEREG? / +C5GREG? 这类「<n>,<stat>」结构的通用解析 */
	api.parseRegStat = function (text, prefix) {
		/*
		 * ★ prefix 是**拼进正则**的，必须先转义它的元字符。
		 *
		 *   原写法 `'\\' + prefix` 只给 prefix 的**第一个**字符加了反斜杠，其余位置的
		 *   `.` `*` `(` `[` 等仍是正则元字符 —— 匹配范围会悄悄变宽（例如传 '+C.REG'
		 *   会连 '+CXREG' 一起命中）。本函数是导出的（api.parseRegStat），
		 *   调用方可传任意字符串，所以这层不能省。
		 *
		 *   对现有调用方（传的都是 '+CEREG' / '+C5GREG' 这类字面常量）**行为等价**：
		 *   转义后同样是 `\+CEREG`。
		 */
		var esc = String(prefix == null ? '' : prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		var m = String(text).match(new RegExp(esc + ':\\s*([^\\r\\n]*)'));
		if (!m) return null;
		var f = m[1].split(',').map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
		var stat = Number(f[1]);
		if (!isFinite(stat)) return null;
		return { stat: stat, statText: REG_STATES[stat] || ('状态 ' + stat) };
	};

	/* +CIREG?（IMS 注册）：<n>,<reg_info>[,<ext_info>]（手册 7.6） */
	api.parseCireg = function (text) {
		var m = String(text).match(/\+CIREG:\s*([^\r\n]*)/);
		if (!m) return null;
		var f = m[1].split(',').map(function (x) { return x.trim(); });
		var rawInfo = f[1];
		/*
		 * ★ ext_info（第三段）原先**被整个丢弃**。而手册 7.6 明说这一项才是
		 *   「IMS 域能力值」（取值 [1,0xFFFFFFFF]，列举 voice / text / SMS over IMS / video）。
		 *   丢掉它的直接后果不是少一个字段，而是下游凭 `reg_info===1` 就宣称
		 *   「VoLTE/VoNR/IMS 短信可用」——「IMS 注册上了但语音能力没开」这个最常见的
		 *   故障态会被**谎报成可用**。
		 *
		 *   ★ 只**原样透出字符串，不做位解码**：手册同一节既写「每个 bit 位表示不同的能力」
		 *     又按枚举方式列了取值，两处口径本身不一致；没有真机实测前就解码等于编造语义。
		 *
		 *   ★ 是否带第三段取决于 <n>（URC 上报看到的是 n=2 才带），把 n 设成 2 是**写命令**，
		 *     本页不静默下发 —— 读到就有、读不到就显示「未上报」。
		 */
		var ext = (f.length > 2 && f[2] !== '') ? f[2] : null;
		var info = Number(rawInfo);
		if (isFinite(info)) {
			var txt = (info === 1) ? '已注册' : (info === 0 ? '未注册' : '未知取值 ' + rawInfo);
			return { info: info, ext: ext, text: txt };
		}
		/*
		 * 固件返回非十进制（例如十六进制 0x03）时走到这里。
		 * ★ 旧实现把它与「未注册」混同 → UI 直接显示「语音/IMS 短信不可用」，
		 *   那是**编造的坏消息**；解析不了就该明说解析不了。
		 */
		return {
			info: null,
			ext: ext,
			text: rawInfo ? ('无法识别该取值（' + rawInfo + '）') : '未上报'
		};
	};

	/* ^RRCSTAT?：<enable>,<rrc_status>[,<camp_status>]（手册 13.21） */
	api.RRC_TEXT = { 0: '空闲（非连接态）', 1: '连接态', 2: 'INACTIVE（NR 非激活）', 3: '无效' };
	api.CAMP_TEXT = { 98: '已驻留', 99: '未驻留' };
	api.parseRrcstat = function (text) {
		var m = String(text).match(/\^RRCSTAT:\s*([^\r\n]*)/);
		if (!m) return null;
		var f = m[1].split(',').map(function (x) { return x.trim(); });
		var rrc = Number(f[1]);
		var camp = f[2] !== undefined ? Number(f[2]) : null;
		return {
			enable: Number(f[0]),
			rrc: isFinite(rrc) ? rrc : null,
			/*
			 * rrc 解析失败时不能拼出「状态 NaN」：NaN 是解析失败的产物，
			 * 不是模组报上来的状态值，显示出来只会让人以为是某种未知状态。
			 * 真机 AT^RRCSTAT? 常回 `^RRCSTAT: 0,1` —— 只有 <enable>,<rrc> 两段、没有 <camp>，
			 * 此时 camp 为 undefined、走的就是这条路径（2026-09-28 实测确证；原文举的例子
			 * 写的是「只有一个字段」，与真机形态不符，已订正）。
			 */
			rrcText: isFinite(rrc) ? (api.RRC_TEXT[rrc] || ('状态 ' + rrc)) : null,
			camp: (camp != null && isFinite(camp)) ? camp : null,
			campText: api.CAMP_TEXT[camp] || null
		};
	};


	/* +COPS?：<mode>,<format>,"<oper>",<act>（27.007）—— 当前是自动选网还是手动锁了运营商 */
	api.C0PS_MODE = { 0: '自动选网', 1: '手动选网', 2: '已注销', 3: '仅限手动', 4: '自动/手动' };
	api.C0PS_ACT = {
		0: 'GSM', 2: 'UMTS', 3: 'GSM/EGPRS', 4: 'UMTS/HSDPA', 5: 'UMTS/HSUPA', 6: 'UMTS/HSPA',
		7: 'LTE（E-UTRAN）', 8: 'CDMA2000 HRPD', 9: 'LTE-A', 10: 'LTE NB-IoT', 11: 'NR（5G）', 12: 'NR（5G）'
	};
	api.parseCops = function (text) {
		var m = String(text).match(/\+COPS:\s*([^\r\n]*)/);
		if (!m) return null;
		var f = m[1].split(',').map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
		var mode = Number(f[0]);
		var act = f[3] !== undefined && f[3] !== '' ? Number(f[3]) : null;
		return {
			mode: isFinite(mode) ? mode : null,
			modeText: api.C0PS_MODE[mode] || ('模式 ' + f[0]),
			oper: f[2] || '',
			act: act,
			actText: (act != null && api.C0PS_ACT[act]) ? api.C0PS_ACT[act] : (act != null ? ('制式 ' + act) : '')
		};
	};

	/* ^VERSION?：多行 ^VERSION:<KEY>:<value>；挑有用的几项 */
	api.parseVersion = function (text) {
		var out = {};
		String(text).split(/\r?\n/).forEach(function (line) {
			var m = line.match(/\^VERSION:([A-Z]+):(.*)$/);
			if (m) out[m[1]] = m[2].trim();
		});
		return (out.EXTS || out.EXTH || out.ROMSIZE) ? out : null;
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

	/*
	 * AT 命令「参数」转义 —— 前端是 AT 通道的唯一入口，凡把用户输入拼进 AT 命令
	 * 的地方都必须过一遍，否则一个带引号或换行的值就能闭合字符串、续接第二条命令。
	 * 例如下面这个 APN 会让模组在设拨号参数的同时把射频关掉：
	 *     cmnet\r\nAT+CFUN=0\r\n
	 * 剥掉的四个字符各有讲究：
	 *   "    闭合字符串参数，是注入的基础；
	 *   \r\n  另起一行写下一条命令（后端按行下发，等于一次请求发两条）；
	 *   ; ,  参数分隔符，会让一个值变成多个参数。
	 * 只用于「参数值」；整条命令不能过这个函数（命令本身需要引号与逗号）。
	 */
	/* 逐段判 0-255：只约束形状的正则会把 999.999.999.999 也放行。 */
	api.isValidIPv4 = function (v) {
		var parts = String(v == null ? '' : v).trim().split('.');
		if (parts.length !== 4) return false;
		for (var i = 0; i < 4; i++) {
			if (!/^\d{1,3}$/.test(parts[i])) return false;
			if (Number(parts[i]) > 255) return false;
		}
		return true;
	};

	api.sanitizeAtParam = function (value) {
		return String(value == null ? '' : value).replace(/["\r\n;,]/g, '');
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
			var y = 2000 + parseInt(match[1], 10);
			var mo = parseInt(match[2], 10);
			var dy = parseInt(match[3], 10);
			var hh = parseInt(match[4], 10);
			var mi = parseInt(match[5], 10);
			var ss = parseInt(match[6], 10);
			/*
			 * ★ 2026-09-28 补：**逐字段的独立范围检查**，与 decodeTimestamp 对齐。
			 *
			 * 下面那段「回读三个日期分量」只挡得住**会改变日期**的越界
			 * （26/02/31 → 3/3、24:00:00 → 次日 00:00），而**只改时间**的越界会漏过去：
			 *   `26/09/28,12:60:00` → new Date(2026,8,28,12,60,0) 被 JS 进位成 13:00:00，
			 *   年月日三个分量**一个都没变** ⇒ 不回落，返回了一个「看起来完全正常」的
			 *   13:00:00。而本函数上面那段注释自称「与 decodeTimestamp 同口径」——
			 *   实际并不同：decodeTimestamp:1185 有这一道检查，这里没有。
			 * 依据：`sms-time-contract.test.js` 的「12:60:00 回落」用例（该用例此前一直
			 * 靠「运行当天恰好等于数据里的日期」而误判为通过）。
			 */
			if (mo < 1 || mo > 12 || dy < 1 || dy > 31
				|| hh > 23 || mi > 59 || ss > 60) {
				return new Date();
			}
			var d = new Date(y, mo - 1, dy, hh, mi, ss);
			/*
			 * ★ 与 decodeTimestamp 同口径：**回读三个日期分量做越界回落**。
			 *
			 *   JS 的 Date 构造函数会自动进位（26/02/31,12:00:00 → new Date(2026,1,31)
			 *   → 2026-03-03），而这里的时间串是 `YY/MM/DD,HH:MM:SS` 的**字面**字段。
			 *   进位会把一个畸形时间渲染成**看似合理**的错误日期，比直接显示"读不到"
			 *   更容易误导。
			 *
			 *   本函数的输入可能来自**用户导入的文件**（sms_settings.js 的「导入记录」，
			 *   其 time 字段只校验了 `typeof === 'string'`，不校验日期合法性），
			 *   所以这条路径是真实可达的。
			 *
			 *   2.3.78 修的是 decodeTimestamp（PDU 的 SCTS 解析），当时漏了这里 ——
			 *   同一问题的第二处。后端 pdu.rs 的 decode_timestamp 走 chrono 的
			 *   with_ymd_and_hms，越界返回 None 并回落当前时间，三处现已同口径。
			 */
			if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== dy) {
				return new Date();
			}
			return d;
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
		/*
		 * ★ 循环结束后**不能**再补一个 (acc & 0x7F)。
		 *
		 * 此时 bits 必定落在 1..=6 —— 那只是末尾字节里的**填充位**，不是一个真实码位。
		 * 补上它就会凭空造出一个由填充位拼出来的字符，表现为短信正文尾部莫名多一个
		 * '@' 之类，并会原样进入界面与推送。
		 *
		 * 后端 src/rust/src/pdu.rs 的 unpack_septets 早已按「数据不足时宁可截断，
		 * 也不要造字」删掉了这一步（那边注释记着同一现象）；本文件此前漏改，
		 * 于是同一份 PDU 走前端解码与走后端解码会得到**不同长度**的正文。
		 * 2026-09-28 对齐。
		 */
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

	/*
	 * UCS2 字节解码（PDU 用，入参为字节数组）。
	 * 注意：上方另有一个入参为 hex 字符串的 var decodeUcs2（USSD 用），
	 * var 赋值会遮蔽函数声明——若重名会让 PDU 正文整体乱码，故这里改名 _Bytes。
	 */
	function decodeUcs2Bytes(data) {
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
		var d = new Date(year, month - 1, day, hour, minute, second);
		/*
		 * ★ JS 的 Date 构造函数会**自动进位**（2026-02-31 → 2026-03-03），
		 *   而 SCTS 是「年月日时分秒」的**字面**字段 —— 进位会把一条畸形时间戳
		 *   渲染成一个看似合理的错误日期，比显示"取不到"更容易误导。
		 *
		 *   上面那道检查只看每个字段的**独立**范围（月 1-12、日 1-31…），
		 *   但「日」的合法上限取决于月份 —— 2 月 31 日能过它，却不是真实日期。
		 *   这里回读三个日期分量，做与后端相同的"越界即回落"：`pdu.rs` 的
		 *   `decode_timestamp` 走 chrono 的 `with_ymd_and_hms`，越界返回 None 并
		 *   回落到当前时间。两侧口径必须一致，否则同一条短信在前端列表与后端通知
		 *   （企业微信推送）里会显示**不同的收信时间**。
		 */
		if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
			return new Date();
		}
		return d;
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
			/*
			 * ★ 只接受真正的十进制半字节（0–9）。
			 *   原写成 `if (d1 < 0x0F) digits += String(d1);` —— 0xA–0xE 这类非十进制
			 *   半字节会被 String() 变成 "10"…"14" **两个字符**混进号码（例如 0x1A
			 *   会产出 "10"），号码因此错乱。
			 *   后端 src/rust/src/pdu.rs 的 decode_number 用的是 `lo <= 9`，
			 *   两侧口径必须一致（这是同一份 PDU 的前端/后端两条解码路径）。
			 */
			if (d1 <= 9) digits += String(d1);
			if (d2 <= 9) digits += String(d2);
			nibbles -= 2;
			i += 1;
		}
		if (ton === 5) {
			var alphaBytes = raw.slice(start, i);
			/* 半字节长度折算 septet 数：向下取整（多余填充位不构成字符） */
			var septets = unpackSeptets(alphaBytes, Math.floor(lenNibbles * 4 / 7));
			return { address: septetsToString(septets), ton: ton };
		}
		if (ton === 1) return { address: '+' + digits, ton: ton };
		return { address: digits, ton: ton };
	}

	/*
	 * TP-DCS 编码判定（3GPP TS 23.038）：
	 *   0x00-0x3F 一般数据编码组：bit3-2 选编码（00=7bit 01=8bit 10=UCS2）
	 *   0x40-0xBF 保留/自动丢弃组：按 bit3-2 判定
	 *   0xC0-0xDF 消息等待组：bit3=1 为 UCS2，否则 GSM7
	 *   0xF0-0xFF 数据编码/消息类别组：固定 GSM7（bit3-2 是类别不是编码！）
	 * 返回 0=GSM7 / 1=8bit / 2=UCS2。
	 * 旧实现用 dcs & 0x0C，会把 F 组的类别位误读成编码位导致乱码。
	 */
	function dcsEncoding(dcs) {
		var group = dcs >> 4;
		if (group === 0xC || group === 0xD || group === 0xE) {
			return (dcs & 0x08) ? 2 : 0;
		}
		if (group === 0xF) {
			return 0;
		}
		return (dcs >> 2) & 0x03;
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
		/*
		 * 长度口径必须和下面的解码口径同源。旧实现用 dcs & 0x0C 推长度、又用
		 * dcsEncoding 决定怎么解，两者对 0xF 组（数据编码/消息类别组）结论相反：
		 * 该组的 bit3-2 是消息类别、不是编码，固定按 GSM7 处理，而旧的长度分支
		 * 会当 8bit/UCS2 取字节数，正文因此被截断或读到界外。
		 * 已按 256 个 DCS 全量自检：差异只落在 0xF 组，常见 DCS 完全等价。
		 */
		var enc = dcsEncoding(dcs);
		var udLen;
		/*
		 * ★ 2026-09-30：UCS2 / 8bit 的 udl 计**八位组**，不是字符 —— 原先写 `udl * 2`
		 * （按字符计）是隐患：它只靠下面 `Math.min(pos + udLen, raw.length)` 的越界钳制
		 * 才在本仓常见输入上"碰巧"正确。一旦 raw 的 UD 之后还有字节（多行应答拼接、
		 * 调用方多传、将来的解析改动），`udl * 2` 就会把那段数据当成正文吞进来。
		 *
		 * 依据（2026-09-30 对 tests/fixtures/pdu-samples.json 全量测算）：4 条 UCS2 样本的
		 * udl 分别为 4 / 4 / 136 / 4，**逐条等于实到 UD 字节数**（按字符计会是 8 / 8 / 272 / 8），
		 * 其中 136 那条是**真机样本**（10086 的 UCS2 长短信首段）；8bit 样本（DCS 0x04）
		 * 同为 udl=4 == 4 字节。Rust 侧 src/rust/src/pdu.rs 同一处已按八位组校验并裁剪，
		 * 两侧口径必须一致（tests/pdu-udl-unit-contract.test.js 钉住这一点）。
		 */
		if (enc === 1 || enc === 2) udLen = udl;
		else udLen = Math.ceil(udl * 7 / 8);
		var ud = raw.slice(pos, Math.min(pos + udLen, raw.length));

		var content = '';
		var partial = null;
		var udhi = (firstOctet & 0x40) !== 0;
		var userData = ud;
		var headerLen = 0;
		/*
		 * 16 位端口寻址（IEI 0x05）的**目的端口**。真机依据（2026-09-30，设备收件箱
		 * IDX 23/24，发件人 12520115）：UDH = `05 04 0b 84 23 f0 …` → 目的端口
		 * 0x0B84 = **2948**（WAP Push / 彩信通知），载荷是二进制报头
		 * （ASCII 里可见 `application/vnd.wap.mms-message`、`/TYPE=PLMN`）。
		 * 这类报文不是文本：8bit 按 Latin-1 逐字节显示就是 `Ã¤Â¸Â` 之类的乱码。
		 * 与 Rust 侧 src/rust/src/pdu.rs 的 udh_app_port() 同一口径。
		 */
		var wapPort = null;

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
				} else if (iei === 0x05 && iel >= 2) {
					wapPort = (ieData[0] << 8) | ieData[1];
				}
				p += 2 + iel;
			}
		}

		if (enc === 2) {
			content = decodeUcs2Bytes(userData);
		} else if (enc === 1) {
			/*
			 * 8bit 默认按 Latin-1 逐字节映射（1 字节 = 1 字符，不丢信息）。
			 * 但 WAP Push / 彩信通知走同一编码、载荷是二进制报头 —— 按文本显示即乱码
			 * （用户报的"12520115 短信乱码"就是这个）。这里按目的端口明确标注，
			 * 文案必须与 Rust 侧 pdu.rs 的 MMS_NOTICE_TEXT **逐字一致**：
			 * tests/fixtures/pdu-samples.json 的共享样本会在两侧同时校验。
			 */
			if (wapPort === 2948 || wapPort === 2949) {
				content = '[彩信通知] 本机不支持彩信，请用手机查看该条内容';
			} else {
				var c8 = '';
				for (var k = 0; k < userData.length; k++) c8 += String.fromCharCode(userData[k]);
				content = c8;
			}
		} else {
			/*
			 * 7-bit：UDH 占用的 septet 数按其八位组长度折算，
			 * 必须先解「完整 UD 字节流」的 septet 序列、再跳过头部码位；
			 * 旧实现先按字节切掉 UDH 再解包，位流错位导致长短信正文乱码。
			 */
			var udhSeptets = (udhi && ud.length > 0) ? Math.ceil((ud[0] + 1) * 8 / 7) : 0;
			var totalSeptets = Math.max(udl, udhSeptets);
			var septets = unpackSeptets(ud, totalSeptets);
			content = udhSeptets <= septets.length
				? septetsToString(septets.slice(udhSeptets))
				: '';
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

			/* 状态位 <stat>：PDU 模式是数字，文本模式是带引号的 "REC UNREAD" 等。
			   按鼎桥《AT 命令手册》9.8/9.10：0=收到的未读短信，1=已读，
			   2/3=存储的未发送/已发送。
			   文本模式第二字段以引号开头，不会被这条数字正则命中，故不会串味。 */
			var statM = block.match(/\+CMGL:\s*\d+\s*,\s*(\d+)\s*,/);
			var stat = statM ? parseInt(statM[1], 10) : null;

			// 已解码文本行：+CMGL: idx,"REC READ","<number>",,"<time>"
			var simple = block.match(/\+CMGL:\s*\d+,"([^"]*)","([^"]*)",,"([^"]*)"/);
			if (simple) {
				sms.push({
					index: idx,
					content: block.split('\n').slice(1).join('\n').trim(),
					number: api.normalizePhoneNumber(simple[2] || ''),
					time: simple[3] || '',
					type: simple[1].indexOf('REC') === 0 ? 'received' : 'sent',
					unread: /UNREAD/i.test(simple[1] || '')
				});
				continue;
			}

			// PDU 块：+CMGL: idx,stat,,,<len> 下一行是 PDU hex
			//
			// PDU 行的识别用「≥20 个十六进制字符」这个启发式：最短的 DELIVER
			// （SCA=00 + 11 位号码 + 7 字节时间戳 + 1 字节正文）也有 21 字节 = 42 个
			// 十六进制字符，所以正常 PDU 都远高于这个门槛；而 +CMGL 头行含空格与逗号，
			// 不会被它命中。
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
						/*
						 * ★ 这里只把 stat === 0 当"未读"，即 **2/3（草稿 / 已发）按已读显示**；
						 *   而后端 smsclean.rs 的 parse_cmgl_entries 是 `read = (stat == 1)`，
						 *   把 2/3 当**未读**（注释写的是"未读、草稿、已发一律按未读对待，
						 *   绝不优先删"）。两者对 2/3 的解释**相反**，但不是缺陷：
						 *   · 后端的口径更保守（不会误删用户没看过的），方向安全；
						 *   · 本固件**不用 CMGW 存已发**（smsEncode.js 末尾专门论证过
						 *     "拿稀缺的收信槽位换一条便利，稳定性上不划算"），
						 *     所以 SM 里实际不会出现 stat=2/3 的条目。
						 *   记在这里是为了避免后来人看到两边写法不同就去"统一"——
						 *   统一的任一侧都会改变该侧行为。
						 */
						unread: stat === 0,
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

/*
 * ============================================================================
 * 「已发短信存在哪」—— 这一层已于 2.3.58 **整块删除**，不要再往回加
 * ----------------------------------------------------------------------------
 * 原先这里有一组 localStorage 缓存（SMS_CACHE_KEY / getCachedSentMessages /
 * saveSentMessageToCache / clearSentMessageCache），已发短信全靠它。
 *
 * 那是**浏览器**的私有空间：换一个浏览器、清一次缓存、换一台电脑打开页面，
 * 发过的记录就一条不剩 —— 而「这台设备发出过什么」明明是所有浏览器都该看到
 * 同一份的事实。把设备级的事实存进浏览器级的地方，源头就错了。
 *
 * 现在唯一真源是设备上的 /etc/mt5700/sms-sent.json，经 ubus
 * `mt5700.smslog`（list/add/del/clear）读写，封装在 AtWs.smsLog() 里。
 *
 * ★ 没选「写进模组短信存储（AT+CMGW=…,3）」的原因：模组 SM 只有 50 个槽位，
 *   本机实测已占 44；且 smsclean 的解码器只认 SMS-DELIVER，SUBMIT 解不出时间
 *   就进不了淘汰名单 —— 存满之后谁都删不掉它，表现为短信再也收不进来。
 *   该路径真机验证过可行（AT+CMGW 受理、AT+CMGL 回得到 `+CMGL: 41,3,,25`），
 *   是评估后放弃，不是没试过。
 * ============================================================================
 */

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

	// 前端拼锁频命令（即时生效场景）
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

	/* ================= 辅载波/辅站小区码表（手册 13.18 / 13.27） =================
	 * ★ 这三个常量当前全仓无引用，且对应通路在本固件上不可用：^CASCELLINFO 未实现
	 *   （连 `=?` 都回 ERROR），^MONSSC 只在 NSA 双连接建立后才有内容（本机 ^LENDC 全 0），
	 *   ^HFREQINFO 的带宽本身就是数值、不需要码表。
	 *   保留是因为逐项都有手册出处，换固件或插上 NSA 场景可能有用；**不要以为它正在生效**。
	 *   实测过程见 REFERENCE §辅载波常量。 */

	var MEAS_TYPES = { 0: 'SSB', 1: 'CSI-RS' };
	var NR_INVALID = { rsrp: -1256, rsrq: -348, sinr: -188 };
	// 手册 13.18.3 <ulbw>/<dlbw>
	var LTE_BANDWIDTHS = { 0: 1.4, 1: 3, 2: 5, 3: 10, 4: 15, 5: 20 };

	var descale = function (value, min, max) {
		return value < min || value > max ? Number((value / 8).toFixed(1)) : value;
	};
	/* numOrNull / hexOrNull 已上移到文件顶部的「公共取值工具」，全文件共用一份 */

	/*
	 * 解析 ^NRSSBID（手册 13.28）：SA 连接态且网侧配置测量时，报服务小区
	 * 与最多 4 个邻区的 SSB 测量。这是本固件在 SA 下**唯一**能拿到
	 * 其他小区 PCI/RSRP/SINR 的途径（^MONSSC 仅 NSA、^CASCELLINFO 仅 LTE CA）。
	 * 注意：邻区测量**不含 RSRQ**。
	 * 结构：ARFCN,CID,PCI,RSRP,SINR,TA, 8×(SSBID,RSRP), N_NB,
	 *       N×[PCI,ARFCN,RSRP,SINR, 4×(SSBID,RSRP)]
	 * 无效值：PCI 0xFFFF、RSRP/SINR 0x7FFF、ARFCN 0xFFFFFFFF。
	 */
	api.parseNrssbid = function (text) {
		var m = String(text).match(/\^NRSSBID:\s*([^\r\n]*)/);
		if (!m) return null;
		var f = m[1].split(',').map(function (s) { return s.trim(); });
		if (f.length < 23) return null;
		var valid = function (v, bad) {
			var n = numOrNull(v);
			return (n === null || bad.indexOf(n) >= 0) ? null : n;
		};
		/* 波束对：每 2 个字段是 (SSBID, RSRP)，RSRP 无效值 32767 直接丢弃 */
		var beamsOf = function (from, count) {
			var out = [];
			for (var i = 0; i < count; i++) {
				var id = numOrNull(f[from + i * 2]);
				var rsrp = valid(f[from + i * 2 + 1], [32767]);
				if (id === null || rsrp === null || id === 255) continue;
				out.push({ id: id, rsrp: rsrp });
			}
			return out;
		};
		var serving = {
			arfcn: valid(f[0], [4294967295]),
			cid: f[1] || '',
			pci: valid(f[2], [65535]),
			rsrp: valid(f[3], [32767]),
			sinr: valid(f[4], [32767]),
			ta: numOrNull(f[5]),
			beams: beamsOf(6, 8)
		};
		if (serving.arfcn === null) return null;
		var nNb = numOrNull(f[22]) || 0;
		var neighbors = [];
		for (var i = 0; i < nNb; i++) {
			var o = 23 + i * 12;
			if (o + 3 >= f.length) break;
			var nb = {
				pci: valid(f[o], [65535]),
				arfcn: valid(f[o + 1], [4294967295]),
				rsrp: valid(f[o + 2], [32767]),
				sinr: valid(f[o + 3], [32767]),
				beams: beamsOf(o + 4, 4)
			};
			if (nb.arfcn !== null) neighbors.push(nb);
		}
		return { serving: serving, neighbors: neighbors };
	};

	/*
	 * 解析 ^MONNC（当前邻区）：每行 `^MONNC: <RAT>,<arfcn>,<pci_hex>,<rsrp>,<rsrq>[,<sinr>]`。
	 * NR 的 RSRP/RSRQ/SINR 在超范围时是 ×8 定点（如 -1256），这里还原；
	 * PCI 是十六进制（实测出现过 "10A" / "16B"）。
	 */
	api.parseMonncAll = function (text) {
		var out = [];
		String(text).split(/\r?\n/).forEach(function (line) {
			var m = line.match(/\^MONNC:\s*(\w+)\s*(?:,(.+))?/);
			if (!m || m[1] === 'NONE' || !m[2]) return;
			var v = m[2].split(',').map(function (s) { return s.trim().replace(/"/g, ''); });
			var cell = { rat: m[1], arfcn: numOrNull(v[0]), pci: hexOrNull(v[1]) };
			/* 无效码按「无测量」处理：RSRP -157/-1256、RSRQ -44/-348、SINR -24/-188 */
			var fix = function (raw, big, invalid) {
				var n = numOrNull(raw);
				if (n === null) return null;
				if (invalid.indexOf(n) >= 0) return null;
				var val = Math.abs(n) > big ? Number((n / 8).toFixed(1)) : n;
				return invalid.indexOf(val) >= 0 ? null : val;
			};
			if (m[1] === 'NR') {
				cell.rsrp = fix(v[2], 157, [-157, -1256]);
				cell.rsrq = fix(v[3], 43.5, [-44, -348, -5.5]);
				cell.sinr = fix(v[4], 40, [-24, -188, -23.5]);
			} else {
				var rsrp = numOrNull(v[2]);
				var rsrq = numOrNull(v[3]);
				cell.rsrp = (rsrp === null || rsrp <= -140) ? null : rsrp;
				cell.rsrq = (rsrq === null || rsrq <= -20) ? null : rsrq;
			}
			cell.band = api.arfcnToBand(m[1], cell.arfcn);
			out.push(cell);
		});
		return out;
	};

	/* ARFCN → 频段号（常用频段表；测不准返回 null，调用方按 null 处理） */
	api.arfcnToBand = function (rat, arfcn) {
		var n = numOrNull(arfcn);
		if (n === null) return null;
		var table = rat === 'LTE'
			? [[1, 0, 599], [3, 1200, 1949], [5, 2400, 2649], [8, 3450, 3799],
				[34, 36200, 36349], [38, 37750, 38249], [39, 38250, 38649],
				[40, 38650, 39649], [41, 39650, 41589]]
			/*
			 * ★ 顺序有讲究：本函数是**顺序匹配、命中即返回**，而 3GPP 里
			 *   n77 与 n78 本来就重叠 ——
			 *     n77 = 3300–4200 MHz → ARFCN 620000–680000
			 *     n78 = 3300–3800 MHz → ARFCN 620000–653333（n78 ⊂ n77）
			 *   单凭 ARFCN **无法**区分两者。若按 n77 在前，3300–3800 MHz 一律被判成
			 *   n77，可 **n78 才是中国 / 欧洲 3.5 GHz 的主力部署频段**，
			 *   界面（network_settings.js 的三处调用）就会把 n78 小区显示成 n77。
			 *   这是一次取舍：优先给实际部署最多的那个，n77 只管它独有的
			 *   653334–680000 那段。
			 */
			: [[1, 422000, 434000], [3, 376000, 396000], [5, 173800, 175000], [8, 185000, 192000],
				[28, 151600, 160600], [41, 499200, 537999],
				[78, 620000, 653333], [77, 620000, 680000],
				[79, 693334, 733333]];
		for (var i = 0; i < table.length; i++) {
			if (n >= table[i][1] && n <= table[i][2]) return table[i][0];
		}
		return null;
	};

	/* NR-ARFCN → MHz（3GPP 全局栅格：<600000 时 5kHz 步进，以上 15kHz） */
	api.nrArfcnToMHz = function (n) {
		n = Number(n);
		if (!isFinite(n) || n <= 0) return null;
		return n < 600000 ? n * 0.005 : 3000 + (n - 600000) * 0.015;
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
		/*
		 * num 原来是 `isFinite(n) ? n : 0`——缺字段就归 0，而 0 在下面三张表里
		 * **都是合法取值**：domain 0 = CS 域、rat 0 = GSM、rejectType 0 也有含义。
		 * 于是「这一位没上报」被渲染成「CS 域 / GSM」，用户看到的不是「未知」
		 * 而是一个看似确凿、实则编造的结论。改为公共 numOrNull：缺 → null，
		 * 下面的 xxxText 判 `!= null` 时自然落到「域 0 → 未上报」这类文案。
		 */
		var num = function (v) { return numOrNull(unquote(v)); };
		var domain = num(f[1]), cause = num(f[2]), rat = num(f[3]), rejectType = num(f[4]);
		var text = function (table, v, noun) {
			return v == null ? (noun + '未上报') : (table[v] != null ? table[v] : noun + ' ' + v);
		};
		return {
			plmn: unquote(f[0]),
			domain: domain,
			domainText: text(REJ_DOMAINS, domain, '域'),
			cause: cause,
			causeText: cause == null ? '原因未上报' : api.rejectCauseText(cause),
			rat: rat,
			ratText: text(REJ_RATS, rat, '制式'),
			rejectType: rejectType,
			rejectTypeText: text(REJ_TYPES, rejectType, '类型'),
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

	/* ================= ADC 管脚值 ^ADCREADEX（手册 11.5） ================= */

/*
 * ^ADCREADEX（手册 11.5，ADC 管脚原始值，单位 mV）解析器已于 2026-09-19
 * 随「ADC 管脚电压」功能一并删除：手册明写「不同产品的 ADC 管脚的数量不同」，
 * 且**没有说明每个管脚接的是什么**，界面只能原样给数值、无法解读，
 * 实测本机 3 个管脚都是 1798/1799 mV —— 摆在页面上既不说明问题也不指导动作，
 * 却要占排查卡的一整块、并在进页面时多发 5 条 AT。用户决定整块下线。
 * 需要恢复时按手册 11.5 重建：/^\^ADCREADEX:\s*(-?\d+)/ 取数值即可。
 */

	/*
	 * ^SRVST（服务状态）解析器已于 2026-09-18 随功能一并删除：
	 * 「服务状态监听」整块下线（手册只有设置命令 AT^SRVST=<n>、没有读命令，
	 * 要看状态就得先开周期上报再等模组推，会在模组里留下常驻上报）。
	 * 需要恢复时按手册 13.7 重建：0 无服务 / 1 限制服务 / 2 服务有效 /
	 * 3 区域服务限制 / 4 省电或休眠；注意 null 是「没取到」，不能显示成「无服务」。
	 */

	/* ================= SIM 卡状态 ^SIMSQ（手册 6.6） ================= */

	/*
	 * SIM 状态码表 —— **全插件唯一真源**。
	 * mt5700.js（顶部状态芯片）与 network_status.js（SIM 徽章）只准消费
	 * simShort() / simIsWarn() / simDetail()，不许再各抄一份 —— 此前三处各写一份，
	 * 改一次文案要改三遍，迟早漏一处。
	 *
	 * ★ 11 与 12 到底差在哪（2026-09-14 真机结论，推翻了此前「11 就不能发短信」的判断）：
	 *   手册写的是「12 才算短信与电话可接入」。但本卡长期停在 1,11，实测：
	 *     · 短信收发完全正常（CPMS "SM",44,50，向 10086 实发并收到回复）；
	 *     · 开机自愈推 HVSST 之后状态**仍停在 11**，根本推不动。
	 *   也就是说 11 既不影响短信，也不是能靠推卡修好的故障 —— 它是这张卡的常态。
	 *   所以 11 不再算告警态，文案也不再写「短信未接入」这种与实际不符、还吓人的话。
	 */
	var SIM_STATUS = {
		0: '卡不在位', 1: '卡已插入', 2: '卡被 PIN/PUK 锁定', 3: 'SIMLOCK 锁定',
		10: '卡文件初始化中',
		11: '卡初始化完成，可接入网络（手册标注「短信与电话未接入」；本机实测 11 下短信收发正常）',
		12: '卡初始化完成，短信与电话可接入', 98: '卡已失效（PUK 锁死或物理损坏）',
		99: '卡已移除', 100: '卡初始化失败'
	};

	/* 徽章 / 状态芯片用的短标签（详细说明走 simDetail） */
	var SIM_STATUS_SHORT = {
		0: '未插卡', 1: '已插卡', 2: 'PIN 锁定', 3: 'SIM 锁定',
		10: '初始化中', 11: '已初始化 · 可接入网络', 12: '就绪 · 短信与电话可接入',
		98: '卡失效', 99: '已移除', 100: '卡错误'
	};

	/*
	 * 哪些状态要点提示色。
	 * ★ 11 刻意**不**告警：本卡常态，且短信不受影响（见上）。
	 *   1（已插卡）只是过渡态，同样不告警。
	 *   未收录的状态按「告警」处理（保守：宁可提示，不要漏）。
	 */
	var SIM_STATUS_WARN = {
		0: true, 1: false, 2: true, 3: true,
		10: true, 11: false, 12: false,
		98: true, 99: true, 100: true
	};

	function simLabel(table, s) {
		if (s == null || s === '') return '未知';
		return table[s] != null ? table[s] : '状态 ' + s;
	}

	api.simDetail = function (s) { return simLabel(SIM_STATUS, s); };
	api.simShort = function (s) { return simLabel(SIM_STATUS_SHORT, s); };
	api.simIsWarn = function (s) {
		if (s == null || s === '') return false;   // 没读到状态时不该报警
		return SIM_STATUS_WARN[s] !== false;
	};

	api.parseSimsq = function (text) {
		var match = String(text).match(/\^SIMSQ:\s*(\d+)\s*,\s*(\d+)/);
		if (!match) return null;
		var status = Number(match[2]);
		return {
			status: status,
			label: api.simDetail(status),
			shortLabel: api.simShort(status),
			warn: api.simIsWarn(status),
			dead: status === 98,
			present: status !== 0 && status !== 99
		};
	};

	/* ================= AT 危险指令识别（唯一真源） =================
	 *
	 * 「哪些 AT 会动到射频 / 重启模组 / 删数据」这类知识原先散在各页面：有的页面
	 * 写了确认文案、有的没写 —— 短信设置页翻一下开关就直接发 `AT+CFUN=0` 加
	 * `AT+CMGD=1,4`（清空全部短信），全程没有任何确认。
	 *
	 * 判定收在这里，终端页与设置页消费同一张表，将来手册新增危险命令只改一处。
	 *
	 * ★ 这是**提示**不是**拦截**：终端的用途就是发原始指令，拦下来排障就走不下去了。
	 *   所以只返回「为什么危险」的说明，由调用方决定要不要二次确认。
	 * ★ 结尾带 `?` 的是查询/测试命令（AT+CFUN=? / AT^SYSCFGEX=?），一律不算危险。
	 */
	var AT_DANGER = [
		{ re: /^\s*AT\+CFUN\s*=\s*1\s*,\s*1/i, hint: '重启模组，5G 拨号会断开重连' },
		{ re: /^\s*AT\+CFUN\s*=\s*0/i, hint: '关闭射频（飞行模式），5G WAN（eth2）会断开' },
		{ re: /^\s*AT\+CFUN\s*=/i, hint: '改动射频状态，5G WAN（eth2）会短暂中断' },
		{ re: /^\s*AT\^RESET/i, hint: '重启模组，期间全部业务中断' },
		{ re: /^\s*AT\^SETMODE/i, hint: '切换模组工作模式，可能改变网卡形态并需要重新拨号' },
		{ re: /^\s*AT\s*&\s*F/i, hint: '恢复出厂设置，所有已改配置丢失' },
		{ re: /^\s*ATZ/i, hint: '复位模组到默认配置' },
		{ re: /^\s*AT\+CMGD\s*=\s*[^,]*,\s*4/i, hint: '删除存储里的全部短信，不可恢复' },
		{ re: /^\s*AT\+CLCK/i, hint: 'PIN 锁定操作；输错 PUK 会永久锁卡（本项目界面不下发）' },
		{ re: /^\s*AT\+CPIN\s*=/i, hint: 'PIN 码操作；输错会锁卡（本项目不碰 PIN）' },
		{ re: /^\s*AT\^HVSST/i, hint: 'SIM 热插拔，卡会重新上电，正在进行的 eSIM 操作会中断' },
		{ re: /^\s*AT\^TDSIMHP\s*=/i, hint: 'SIM 热插拔开关，改动会触发卡重新上电' },
		{ re: /^\s*AT\^SCICHG/i, hint: '切换当前使用的卡，会重新注册网络' },
		{ re: /^\s*AT\^SYSCFGEX\s*=/i, hint: '改接入制式/频段，模组会重新搜网，可能长时间无服务' },
		{ re: /^\s*AT\^NRRCCAPCFG/i, hint: '改 NR 能力配置，影响 5G 载波聚合与 VoNR' },
		{ re: /FOTA/i, hint: '固件升级指令，中途断电会变砖' }
	];

	/* 返回「为什么危险」的说明；不危险（或只是查询）返回 null */
	api.atDangerHint = function (cmd) {
		var t = String(cmd == null ? '' : cmd).trim();
		if (!t || /\?\s*$/.test(t)) return null;
		for (var i = 0; i < AT_DANGER.length; i++) {
			if (AT_DANGER[i].re.test(t)) return AT_DANGER[i].hint;
		}
		return null;
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
