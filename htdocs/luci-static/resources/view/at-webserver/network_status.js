'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
'require uci';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 网络状态 - 上游原版视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/Info.tsx，并按「一个主题一张卡片」重新组织，避免信息重叠：
 *   ① 信号质量     主小区 RSRP/RSRQ/SINR + 调制方式(MCS)，头部放刷新控制
 *   ② 连接状态     注册/运营商/签约速率 + 一张合并表（连接诊断 + 地址与 DNS）
 *   ③ 载波与聚合   主小区身份(PLMN/TAC/小区/PCI) + ^HFREQINFO 载波列表 + CA / EN-DC 状态
 *   ④ 速率与流量   实时速率 + 速率曲线 + 累计流量（卡头带「实时监测」开关与「清零」）
 *   ⑤ SIM 与设备   SIM 卡、模块标识、5G 模块温度（12 路传感器取最高）
 *   ⑥ 断网排查     三层体检（L1 模组 / L2 系统 / L3 端到端），点「一键排查」才跑的只读查询
 * 版式：载波与聚合满宽 → 信号质量满宽 → 双列卡区
 * [连接状态 | 右列（SIM 与设备 → 连接质量）]。
 *
 * ★ 为什么把「连接诊断 / 地址与 DNS」两张表合成一张（2026-09-18）：
 *   三者的行都是「项目 → 值」，拆三张只是多出两行表头、把同类信息切三刀；
 *   而「CID」「来源」两列又是纯内部概念 —— CID 1/5 用户无从干预，
 *   PDP 与 WAN 本来就是同一个地址，标了来源反而让人以为有两份地址。
 *   合并后按「连接诊断 / 地址与 DNS」两个分组标题行分隔。
 *
 * ★ 为什么把「连接质量」整卡换成「连接工具」（2026-09-18）：
 *   旧卡四项里，会话均速重复「速率与流量」、信号波动重复「信号质量」、
 *   空口丢包是自 PDU 会话建立起累加且模组从不清零的历史账，短信承载域又与主题无关；
 *   它没有独立的问题域，只是「别处不要的边角料」集中营。新卡全部换成能做事的工具。
 * 速率与流量位于右列、紧跟 SIM 与设备正下方，不再兜在页面最底部。载波表列与上游快照一致（制式/频段/频点/带宽/PCI/RSRP/RSRQ/SINR/强度）。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络状态', '实时网络信息与信号质量');
		var body = page._body;

		/* ---------- 顶部连接状态条 ----------
		 * 与其它页一致的 at-status-card（AT 服务 / RPC / SIM），不再做读数带。 */
		var connBar = E('div');
		Mt5700.renderConnectionBar(connBar);
		body.appendChild(connBar);

		/* ---------- 结论区（2026-10-26 新增） ----------
		 * 位置刻意在状态条之后、所有卡片之前：整页第一眼是「有没有网」，
		 * 而不是六张卡片的第一行字。见 renderVerdict 的注释。
		 * ★ 这两个节点必须在这里就建好并挂上：函数体后面的 `var todoBox = …`
		 *   声明会提升、赋值不会，晚一步 append 会拿到 undefined —— 真机上就是
		 *   一个 appendChild 报 TypeError、整页空白（已实测踩过）。 */
		var verdict = Mt5700.verdict();
		var todoBox = E('div');
		body.appendChild(verdict);
		body.appendChild(todoBox);

		/* ---------- KPI 行（v9：4 张指标卡，各占 3 列） ----------
		 * 原型里结论卡下面是「下行速率 / 上行速率 / 信号质量 / 本月流量」四张卡。
		 * 值由各自的刷新回调推给它们（见 renderSpeed / renderSignal / renderFlow），
		 * 这里只建壳，不发任何请求。
		 * ★ 趋势线用本轮监测的历史点归一化，不额外采样 —— 串口独占，多一条就是多一份延迟。 */
		var kpiDown = Mt5700.kpi('下行速率', '<path d="M12 5v14M6 13l6 6 6-6"/>');
		var kpiUp = Mt5700.kpi('上行速率', '<path d="M12 19V5M6 11l6-6 6 6"/>');
		var kpiSinr = Mt5700.kpi('信号质量', '<path d="M5 19V13M10 19V9M15 19v-6M20 19V5"/>');
		var kpiFlow = Mt5700.kpi('本月流量', '<path d="M12 4v6M12 14v6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="12" r="8.5"/>');
		var sparkDown = Mt5700.spark([]);
		var sparkUp = Mt5700.spark([]);
		kpiDown.el.appendChild(sparkDown.el);
		kpiUp.el.appendChild(sparkUp.el);
		kpiSinr.el.appendChild(E('div', { 'class': 'bars' }));
		/* 4 张卡直接作为栅格子项：套一层容器会打断
		   `.mt5700-page-body > .mt5700-c3` 这类子选择器（display:contents 也不行）。 */
		[kpiDown, kpiUp, kpiSinr, kpiFlow].forEach(function (k) {
			k.el.classList.add('mt5700-c3');
			body.appendChild(k.el);
		});

		/* ---------- 面板骨架（按「一个主题一张卡片」组织，避免信息重叠） ---------- */

		/* ① 信号质量：主小区 RSRP/RSRQ/SINR + 信号百分比 + 调制方式(MCS)
		 * 刷新控制（自动刷新 + 手动刷新）归位到这张卡的头部（相关控件按业务归位） */
		var sigExtra = E('div');
		var signalCard = Mt5700.card('信号质量', '主小区信号与调制方式', sigExtra);
		var sigGrid = E('div', { 'class': 'mt5700-metrics' });
		signalCard._body.appendChild(sigGrid);
		var mcsGrid = E('div', { 'class': 'mt5700-metrics mt5700-mt-md' });
		signalCard._body.appendChild(mcsGrid);
		/* 挂载在文件末尾的排版段（12 列栅格，顺序与 v9 原型一致），这里不 append */

		/* ② 连接状态：注册 / 运营商 / 签约速率 + 一张「连接明细」表。
		 * 连接诊断、地址与 DNS 两张表已合并成一张（见 renderConnDetail）。 */
		var connCard = Mt5700.card('连接状态', '注册、诊断与地址');
		/* 标题节点留个引用：renderConn 里要把它改成「连接状态 ・ 中国移动」 */
		var connTitleEl = connCard.querySelector('.mt5700-card-title');
		var connBody = E('div');
		connCard._body.appendChild(connBody);
		/* 合并后只剩一个容器：三张表的行都是「项目 → 值」，分组标题行负责分隔。 */
		var connDetailBox = E('div', { 'class': 'mt5700-mt-md' });
		connCard._body.appendChild(connDetailBox);

		/* ③ 载波聚合：^HFREQINFO 载波列表 + 聚合状态（原「载波聚合」+「辅载波信号」合并）
		 * 标题按 v9 原型改回「载波聚合」，与预览图逐字一致。 */
		var carrierCard = Mt5700.card('载波聚合', '主小区身份与各载波');
		carrierCard.classList.add('mt5700-c7');
		var carrierBox = E('div');
		carrierCard._body.appendChild(carrierBox);

		/* ④ 速率与流量：实时速率 + 速率曲线 + 收发流量统计（原三张卡合并）
		 * 头部放「实时监测」开关：关掉后停止每秒采样（不再读接口计数器），
		 * 流量统计仍随慢档刷新。 */
		var rateExtra = E('div');
		var rateCard = Mt5700.card('速率与流量', '实时速率与流量统计', rateExtra);
		var speedRow = E('div', { 'class': 'mt5700-speed-row' });
		rateCard._body.appendChild(speedRow);
		var chart = E('div', { 'class': 'mt5700-chart' });
		rateCard._body.appendChild(chart);
		var flowGrid = E('div', { 'class': 'mt5700-metrics mt5700-metrics-flow mt5700-mt-md' });
		rateCard._body.appendChild(flowGrid);


		/* ⑤ 设备与身份：SIM 卡、模块标识与 5G 模块温度（同一张表铺开，不跳转、不重复）
		 * 标题按 v9 原型改作「设备与身份」，占据原型里 c5 那一格。 */
		var devCard = Mt5700.card('设备与身份', 'SIM、模块标识与模块温度');
		devCard.classList.add('mt5700-c5');
		var devBody = E('div');
		devCard._body.appendChild(devBody);

		/* ⑥ 断网排查：这一页别处全是读数，这里放**能做事的工具**。
		 *   · 右列这张卡同时是「总控 + 明细」：一键排查按钮 + 一句话结论 + 三层通过计数，
		 *     明细默认折叠成一行入口，展开后在**卡内**分段切换（2026-09-19 用户口径：
		 *     不许再单独占一个页面区块）
		 *   · 逐项明细铺在页面底部那张**满宽**卡里（33 项，窄栏挤不下）
		 * 三层划分的理由：原来那 6 步连通性自检全在模组内部，只能回答「模组自己觉得通不通」，
		 * 而真机踩过的断网事故有一半根本不在模组里（缺接口 / 没 restart firewall /
		 * init.d 是 100644 / USB 枚举成 480M / 重枚举后不续约导致网关 ARP 一直 INCOMPLETE）。
		 * L1 走 AT 只读命令，L2/L3 走后端 mt5700.sysdiag（一次性取回系统侧事实）。
		 * ★「流量统计清零」已迁到「速率与流量」卡头：它是个动作按钮，
		 *   和同卡的流量数字放在一起才顺手，不该在「工具」里占一整块。
		 * ★「网络拒绝原因」已迁到「网络设置 → 网络拒绝」，「服务状态监听」已下线
		 *   —— 理由见下方连接工具区的注释。 */
		var diagCard = Mt5700.card('断网排查', '三层体检 · 一键定位');
		/* mt5700-card-fill：让这张卡吃掉右列剩余高度，两列底边齐平。
		   卡内多出来的空间全给明细区（内部滚动），所以卡片总高不随排查结果多少变化。 */
		diagCard.classList.add('mt5700-card-fill');
		var diagBody = E('div');
		diagCard._body.appendChild(diagBody);

		/* 明细容器：收进右列「断网排查」卡内部（2026-09-19 口径变更），默认折叠、展开才占地方；不再有独立满宽卡。
		   每项给「事实 + 建议命令」，不提供自动修复按钮 —— 自动改网络配置本身
		   就是断网源（重拉接口会短暂断网），用户明确选择「只诊断 + 给命令」。 */
		var diagDetailBody = E('div', { 'class': 'mt5700-diag-detail mt5700-mt-md' });
		diagCard._body.appendChild(diagDetailBody);

		/* ---------- 常用动作（v9 原型里的 c12 面板） ----------
		 * 原型放五个按钮，其中「重启模组」是灰的并附一句原因。这里照做，
		 * 但**每个按钮都必须是真能用的**：
		 *   · 连接自检 → 滚到下方「断网排查」并直接触发，不新增第二套自检逻辑；
		 *   · 锁定频段 / 运行日志 / 服务与升级 → 跳对应页面；
		 *   · 重启模组 → 禁用 + 说明（没有对应后端能力，界面上不许装作能用）。
		 * 红线 86：动作类控件常驻可见，不可用就灰化并写清原因，不隐藏。 */
		var actionCard = Mt5700.card('常用动作', '点击后立即执行；会中断连接的动作先说明影响');
		actionCard.classList.add('mt5700-c12');
		var actionRow = E('div', { 'class': 'mt5700-action-row' });
		actionCard._body.appendChild(actionRow);

		function actionBtn(label, primary, onClick, disabled) {
			var cls = 'btn' + (primary ? ' primary' : '') + (disabled ? ' danger' : '');
			var b = E('button', { 'class': cls }, label);
			if (disabled) b.disabled = true;
			else b.addEventListener('click', onClick);
			actionRow.appendChild(b);
			return b;
		}
		actionBtn('连接自检', true, function () {
			if (diagCard.scrollIntoView) diagCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
			if (typeof runDiagnosis === 'function') runDiagnosis();
		});
		actionBtn('锁定频段', false, function () {
			window.location.href = L.url('admin/modem/5g/network/settings');
		});
		actionBtn('运行日志', false, function () {
			window.location.href = L.url('admin/modem/5g/tools/logs');
		});
		actionBtn('服务与升级', false, function () {
			window.location.href = L.url('admin/modem/5g/tools/config');
		});
		actionBtn('重启模组', false, null, true);
		actionCard._body.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
			'重启模组需要先停 AT 服务，当前会话会立刻断开；本插件不提供该操作，' +
			'需要时到「服务与升级」重启服务。'));

		/* ---------- 版式（严格对齐 v9 原型） ----------
		     结论卡（满宽）
		     KPI ×4（各 3 列）
		     载波聚合（7） | 设备与身份（5）
		     常用动作（满宽）
		     信号质量（7） | 速率与流量（5）
		     连接状态（满宽）
		     断网排查（满宽）
		     服务状态条（满宽，垫底）
		   全部卡片都是 .mt5700-page-body 的直接子元素 —— 套 .mt5700-cards 之类的
		   容器会打断 12 列栅格的子选择器，跨列规则就失效（踩过）。 */
		carrierCard.classList.add('mt5700-c7');
		devCard.classList.add('mt5700-c5');
		signalCard.classList.add('mt5700-c7');
		rateCard.classList.add('mt5700-c5');
		connCard.classList.add('mt5700-c12');
		diagCard.classList.add('mt5700-c12');

		body.appendChild(carrierCard);
		body.appendChild(devCard);
		body.appendChild(actionCard);
		body.appendChild(signalCard);
		body.appendChild(rateCard);
		body.appendChild(connCard);
		body.appendChild(diagCard);
		body.appendChild(connBar);

		/* ---------- 状态 ---------- */

		var state = {
			cell: {
				mcc: '', mnc: '', lac: '', cid: '', channel: '', pci: 0,
				rsrp: null, rsrq: null, sinr: null, sysMode: '未知', signalPercent: ''
			},
			carriers: [],
			nrssbid: null,
			monnc: [],
			diag: { endc: null, reg: null, creg: null, cireg: null, rrc: null, cops: null, nrTx: [], addrs: [] },
			tools: {
				/* 断网排查：atSteps = L1 的 AT 逐步结果，items = L2/L3 由系统事实判定的结果。
				   facts 是后端 diag-probe.sh 回的 key=value，factsErr 非空说明后端没升级。 */
				diag: { busy: false, ran: false, at: 0, atSteps: [], items: [], facts: {}, factsErr: '' },
			},
			/* 12 路传感器温度，键名与 Parse.parseCHIPTEMP 的返回严格一一对应
			   （手册 17.1：sub3G/sub6G/MIMO/TCXO/peri1/peri2/ap1/ap2/modem1/modem2/bbp1/bbp2）。
			   有守卫 tests/ui-contract.test.js 校验两侧键数一致，补字段时别只改一边。 */
			temps: {
				sub3GPA: 0, sub6GPA: 0, mimoPa: 0, tcxo: 0,
				peri1: 0, peri2: 0, ap1: 0, ap2: 0,
				modem1: 0, modem2: 0, bbp1: 0, bbp2: 0
			},
			flow: { lastDsTime: 0, lastTxFlow: 0, lastRxFlow: 0, totalDsTime: 0, totalTxFlow: 0, totalRxFlow: 0 },
			dhcpv4: null, dhcpv6: null, ipv6Cap: null,
			uplinkMCS: null, downlinkMCS: null,
			activeCid: null,
			networkStatus: '等待状态中',
			/*
			 * PS 注册状态码原始值（AT+CGREG 的 <stat>），与 networkStatus 配对存放。
			 *
			 * ★ 存在的理由：网络制式的显示必须受它约束（见 systemModeLabel）。
			 *   真机实测：卡上没有可用 Profile 时 CGREG 报 1,2（未注册），但
			 *   AT^MONSC 照样回 `^MONSC: NR,000,000,0,0,...` —— 制式字段仍是 NR，
			 *   小区/PLMN 却全是 0。照单显示就成了「没网也显示 5G-NR」。
			 *   null = 这一轮没取到 stat（查询失败），此时退化为看 PLMN 是否有效。
			 */
			psRegStat: null,
			/* EPS 注册（AT+CEREG），5G 模组以它为准；判定顺序见 hasAnyPsService。 */
			psRegStatEps: null,
			operator: '未知运营商',
			apn: '未知',
			qci: '未知',
			/*
			 * 两个面板的数据源与单位都不同，必须各自独立存放，不可共用：
			 *   - ambrDown / ambrUp：签约速率，AT^DSAMBR，单位 kbps（本身即比特）
			 *   - rtDown  / rtUp  ：实时速率，OpenWrt 接口统计采样差分，单位字节/秒
			 * 共用同一组变量会导致两面板互相覆盖、数值与语义双双错乱。
			 */
			ambrDown: 0, ambrUp: 0,
			rtDown: 0, rtUp: 0,
			/* 本轮「实时监测」的峰值速率（字节/秒，与 rtDown/rtUp 同单位）。
			   只在采样时单向取 max，关掉监测再打开会归零重新累计。 */
			peakDown: 0, peakUp: 0
		};

		var history = [];
		var HISTORY_POINTS = 60;

		/*
		 * SIM 状态**只有一份码表**，在 parse.js（SIM_STATUS_SHORT / SIM_STATUS_WARN）。
		 * 这里只消费 Parse.simShort() / Parse.simIsWarn()，不再自带一份。
		 */

		/* 号段显示完整值（用户明确要求：本机状态页不打码） */
		function fullNum(v) {
			var t = String(v == null ? '' : v).trim();
			return t || '—';
		}

		function firstValueLine(data) {
			var lines = String(data == null ? '' : data).split('\n');
			for (var i = 0; i < lines.length; i++) {
				var t = lines[i].replace(/\s+/g, ' ').trim();
				if (!t || t === 'OK') continue;
				return t;
			}
			return '';
		}

		function manualPhoneNote() {
			try { return String(L.uci.get('at-webserver', 'config', 'phone_note') || '').trim(); }
			catch (e) { return ''; }
		}

	/* ⑦ 功能归位原则：同一数据不重复查询。
	 * ^NWTIME（网络时间）已整条移除：手册 §13.8.5 与真机实测都表明，网络未下发
	 * EMM/GMM/MM information 时模组固定输出占位符 90/01/06，本机正是如此，界面只能显示假日期。
	 * 随之删掉 maxTemp（^CHIPTEMP 的重复查询）——温度统一由 getTemp 在慢档取一次。 */

	var _devInfoAt = 0;

		var devRunning = null;   /* ★ P15：同 fastRunning / slowRunning，撞车时复用在跑的那条 */
		function loadDeviceInfo(force) {
			// 设备信息变化很慢：首次加载与每 60s 刷新一次，避免每轮都打十几条查询
			var now = Date.now();
			if (!force && _devInfoAt && now - _devInfoAt < 60000) return;
			/*
			 * ★ P15（2026-09-19 会审）：连点「刷新」会叠加两条 9 命令的链。
			 * refreshAll() 每次都 loadDeviceInfo(true) 强制绕过 60 秒节流，按钮也没有
			 * disabled，而 commandQueue 是全局单链 —— 撞车时 SIMSQ / CPIN / CNUM /
			 * TDSIMHP 会实发两次，把本页与其它页面的命令一起堵住。
			 * 与 refreshFast / refreshSlow 同一模式：撞车就复用在跑的那条。
			 */
			if (devRunning) return devRunning;
			_devInfoAt = now;

			var st = {};
			var q = function (cmd) {
				return AtWs.client.sendCommand(cmd).catch(function () { return { success: false }; });
			};
			var chain = q('AT^SIMSQ?').then(function (r) {
				/* SIMSQ 只准走 Parse.parseSimsq，别在这里另抄一份正则 */
				var sim = r && r.success ? Parse.parseSimsq(r.data) : null;
				st.sim = sim ? sim.status : null;
				return q('AT+CPIN?');
			}).then(function (r) {
				st.pin = (String(r && r.data ? r.data : '').match(/CPIN:\s*(\S+)/) || [])[1] || '';
				return q('AT+CNUM');
			}).then(function (r) {
				var m = String(r && r.data ? r.data : '').match(/"([+\d]{5,20})"/);
				st.phone = m ? m[1] : '';
				return q('AT^TDSIMHP?');
			}).then(function (r) {
				var m = String(r && r.data ? r.data : '').match(/TDSIMHP:\s*(\d+)/);
				st.hotplug = m ? parseInt(m[1], 10) : null;
				return q('AT+CIMI');
			}).then(function (r) {
				st.imsi = (String(r && r.data ? r.data : '').match(/\d{10,}/) || [''])[0];
				return q('AT^ICCID?');
			}).then(function (r) {
				st.iccid = (String(r && r.data ? r.data : '').match(/ICCID:\s*([0-9A-Fa-f]+)/) || [])[1] || '';
				return q('AT+CGMM');
			}).then(function (r) {
				st.model = firstValueLine(r && r.data);
				return q('AT+CGMR');
			}).then(function (r) {
				st.fw = firstValueLine(r && r.data);
				return q('AT+CGSN');
			}).then(function (r) {
				st.imei = (String(r && r.data ? r.data : '').match(/\d{10,}/) || [''])[0];
				renderDeviceInfo(st);
			});
			/* 守卫：链跑完（含失败）就清空，下一次 force 仍能真正重跑一次 */
			devRunning = chain.catch(function () { /* 失败时保留上一次数据，与快档一致 */ })
				.then(function () { devRunning = null; });
			return devRunning;
		}

		/*
		 * 「SIM 与设备」一张表铺开：SIM / 标识 与 各路传感器温度。
		 * 温度数据由 getTemp（慢档 30s，AT^CHIPTEMP? 只取一次）写入 state.temps，
		 * 两路数据到齐时都走同一个 renderDevCard，不会互相覆盖。
		 */
		/* ★ 5G 模块温度的**唯一取法**：12 路传感器取最高（AT^CHIPTEMP?，单位 0.1℃）。
		   2026-09-19：排查项「模组温度」直接采用「SIM 与设备」卡的「5G模块温度」，
		   两处必须同源于这一个函数 —— 否则会出现「卡上显示 48℃、排查里却说没读到」
		   这种自相矛盾。
		   0 视为「未上报」，既不参与取 max 也不进明细（实测部分传感器恒报 0）。
		   传感器名不对外：名字源在 parse.js 按手册修正前长期错标，把名字写进 UI
		   等于把历史错误固化（会审 R01）。
		   返回 { max: 最高温|null, vals: 各路有效读数 }。
		   ★ temps 可传：排查项的 eval(f, st) 是纯函数、用传入的 st 判定（测试靠这点
		   注入温度），不传时取页面当前的 state.temps。 */
		function maxModuleTemp(temps) {
			var t = temps || state.temps || {};
			var vals = [];
			for (var k in t) {
				var n = Number(t[k]);
				if (n > 0) vals.push(n);
			}
			return { max: vals.length ? Math.max.apply(null, vals) : null, vals: vals };
		}

		var devState = null;

		function renderDevCard() {
			if (!devBody) return;
			var st = devState;
			if (!st) return;
			devBody.innerHTML = '';
			var simText = Parse.simShort(st.sim);
			// 11（已初始化）**不算**告警：本卡长期停在 1,11，实测短信收发正常，
			// 自愈推卡也推不动它 —— 详见 parse.js 码表注释。
			var warn = Parse.simIsWarn(st.sim);

			var head = E('div', { 'class': 'mt5700-toolbar' });
			head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' + (warn ? '' : ' is-on') },
				'SIM：' + simText));
			if (st.pin) head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' }, 'PIN：' + st.pin));
			devBody.appendChild(head);

			if (warn) {
				devBody.appendChild(E('div', { 'class': 'mt5700-hint' },
					st.sim === 0 || st.sim === 99
						? '未检测到 SIM 卡：请检查卡是否插好、是否需要换槽位。'
						: 'SIM 未就绪：请检查卡是否插好、是否被 PIN/PUK 锁定。'));
			}

			var note = manualPhoneNote();
			var phone = st.phone ? (st.phone + '（SIM 卡）')
				: (note ? (note + '（手动备注）')
					: '未写入（可在「服务配置」手动备注）');

			var rows = [
				['手机号', phone],
				/* 手机号存储位置原来显示 "ON 0/2"（存储位置 ON、0 条记录、容量 2），
				   既不直观也与上方 SIM 状态重复，已移除；短信与电话能否接入见上方提示。 */
				['SIM 热插拔', st.hotplug == null ? '—' : (st.hotplug ? '已开启' : '已关闭')],
				['IMSI', fullNum(st.imsi)],
				['ICCID', fullNum(st.iccid)],
				['IMEI', fullNum(st.imei)],
				['模块 / 固件', (st.model || '—') + ' / ' + (st.fw || '—')]
			];

			/* 5G 模块温度：与排查项「模组温度」同源，都走 maxModuleTemp()（12 路取最高）。
			   明细挂 title，但**只给数值、不给传感器名** —— 名字源在 parse.js
			   按手册修正前长期错标（peri1/peri2/ap1 被标成 ap1/ap2/modem1），
			   现在把名字写进 UI 等于把历史错误固化；等名字稳定后再加不迟（会审 R01）。
			   温度属慢档 30s 才取一次，刚进页面会短暂显示「—」，排查项同样按「未读到」处理。 */
			var mt = maxModuleTemp();
			if (mt.max != null) {
				rows.push(['5G模块温度', E('span',
					{ title: '各传感器明细（℃）：' + mt.vals.join(' / ') },
					mt.max + ' ℃')]);
			} else {
				rows.push(['5G模块温度', '—']);
			}

			devBody.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
		}

		function renderDeviceInfo(st) {
			devState = st;
			renderDevCard();
		}

		/* ================= 断网排查 =================
		 * 其余卡片全是「读数」，这一张专放**能做事的按钮**。
		 *
		 * ★ 三层，共 33 项：
		 *   L1 模组与空口（11）  AT 只读命令 + 复用页面已有读数
		 *   L2 系统与网络（17）  后端 mt5700.sysdiag → diag-probe.sh 只读采集
		 *   L3 端到端连通（5）   同上（ping 网关 / 公网 IP / DNS / TCP 443）
		 *
		 * ★ 为什么换掉上一版「连接工具」的 6 步自检（2026-09-19）：
		 *   那 6 步（CPIN → C5GREG → CGACT → NDISSTATQRY → CGPADDR → DHCP）
		 *   全在模组内部，只能回答「模组自己觉得通不通」。而真机上真实发生过的
		 *   断网 / 掉速事故里，有一半根本不在模组里：
		 *     · 刷机后缺 MT5700M 接口（auto='1' 漏了）      → 完全没网，模组一切正常
		 *     · 加了 WAN 没 /etc/init.d/firewall restart   → 有 IP 但出不去
		 *     · init.d/at-webserver 是 100644             → AT 服务压根不自启
		 *     · 开机 USB 枚举成 480M，几百秒后重枚举成 5000M → 速率差三倍多
		 *     · 模组重枚举后 netifd 不续约 → 网关 ARP 永远 INCOMPLETE → 静默断网
		 *   这些 6 步里一条都覆盖不到，所以补齐 L1 的 APN / 射频开关 / 服务域，
		 *   再加 L2 / L3 两层，才谈得上「全面」。
		 *
		 * ★ 事实与判定分离：后端 diag-probe.sh 只输出 key=value 事实、不做任何判定；
		 *   判定（通过 / 存疑 / 未通过、给什么建议）全在前端的注册表里。
		 *   于是「加一项判据」只改前端、「加一项事实」才改后端，两边能独立扩展。
		 *
		 * ★★ 两项已迁走 / 下线（2026-09-18，别再搬回来）：
		 *   ①「网络拒绝原因」迁到「网络设置 → 网络拒绝」：它回答的是「为什么注册不上」，
		 *      与锁频、邻区扫描是同一条排查链，放设置页才找得到；^REJINFO 是模组自发
		 *      URC，放哪一页都不占 AT 通道。
		 *   ②「服务状态监听」整块下线：手册只有设置命令 AT^SRVST=<n>、没有读命令，
		 *      想看状态就得先开周期上报再等模组推 —— 正是 2.2.1 那类「页面进出自带写
		 *      命令、页面被强杀后上报常驻模组」的风险源，而收益只是「掉网时多一行记录」，
		 *      不值得为它占一条独占通道。
		 *
		 * ★★★ 安全底线（2.2.1 事故的硬教训，写在这里防回退）：
		 *   上一版为做「卡不卡」，让页面**进入时自动下发** AT^PDCPDATAINFO=1,5000
		 *   开周期上报、离开时才关。页面被强杀后上报永久常驻模组，与 1Hz 的 AT
		 *   轮询争抢同一条 AT 通道，真机事件队列积压 106 帧，只能重启服务才停。
		 *   因此：**本卡任何功能都不许在模组里留下常驻状态**，排查是一次性读；
		 *   将来若要再加「开上报 → 等推送」型功能，必须同时满足
		 *   ① 默认关、只能手动开；② 到点定时器强制关；③ 关不掉就显式报警 + 重试入口
		 *   —— 悄悄留下一个常驻上报，比测不到严重得多。
		 *
		 * ★★★ 排查不自动修（用户 2026-09-19 明确选择）：
		 *   只给「建议命令」，不提供修复按钮。续约 DHCP、重启 AT 服务这类动作
		 *   本身就是断网源（ifdown/ifup 会短暂断网），由用户在终端里确认后执行更稳妥。
		 *   （看门狗已于 2026-09-20 整体移除，现在没有任何常驻自愈，全靠人工处置。）
		 *   守卫：tests/connection-tools-contract.test.js / tests/diag-contract.test.js
		 */

		/* ★ 页面已卸载标记。点「一键排查」发起的链一共十几条只读查询 + 一次系统侧采集，
		   用户反复进出时，前一次的链还在独占的 AT 通道上排队（2.2.1 事故的形态：
		   虽是只读、不留下常驻状态，但排队本身会让整页读数变慢）。
		   _dispose 里置 true，链内每一步开头检查，让已发起的链尽快自然终止。 */
		var disposed = false;

		/* 工具块外壳：标题 + 右侧按钮，结果区由调用方 append */
		function toolBlock(title, btn) {
			var box = E('div', { 'class': 'mt5700-mt-md' });
			var bar = E('div', { 'class': 'mt5700-toolbar' });
			bar.appendChild(E('span', { 'class': 'mt5700-badge mt5700-badge-neutral' }, title));
			if (btn) bar.appendChild(btn);
			box.appendChild(bar);
			return box;
		}

		/* 排查结论的四种取值 —— 与 mt5700.css 的 .mt5700-diag-verdict.is-* 一一对应，
		   加一种就得同时加 CSS，否则文字会掉成默认色（暗色主题下看不清）。 */
		var DIAG_VERDICT = { ok: '通过', warn: '存疑', bad: '未通过', idle: '待检查' };

		/* 三层。明细表按这个顺序分组，总控卡按这个顺序出计数徽章。 */
		var DIAG_LAYERS = [
			{ id: 'L1', name: '模组与空口', short: '模组' },
			{ id: 'L2', name: '系统与网络', short: '系统' },
			{ id: 'L3', name: '端到端连通', short: '连通' }
		];

		/* ★ 当前层用闭包变量，不塞进 state.tools.diag：runDiagnosis 开头会整块重置 t
		   （atSteps/items/facts），状态放进去会被清掉。
		   ★ 2026-09-19：明细恒为展开态 —— 折叠/展开那套开关（入口按钮）已整体删除。 */
		var diagLayer = 'L1';

		function renderTools() {
			if (!diagBody) return;
			diagBody.innerHTML = '';
			diagBody.appendChild(buildDiagBlock());
			renderDiagDetail();   /* 卡内明细容器跟着一起重绘 */
		}

		/* ---------- ② L1：模组与空口（AT 只读命令） ----------
		 *
		 * 逐层走一遍「拿到网」的每一步。判据全部来自手册中该命令的取值定义，不猜：
		 *   CFUN         手册 x.x  <fun> 1=全功能；0/4 射频关 —— ★ 会直接把 eth2 挂死
		 *   CPIN         手册 6.x  <code> = READY 才就绪
		 *   CGDCONT      手册 7.x  <APN> 为空则 PDP 起不来（最大的一块空白：
		 *                         原 6 步里根本没有 APN，而 APN 错是最常见的断网原因）
		 *   SYSCFGEX     手册 13.2 第 4 个字段 <srvdomain>：0=CS_ONLY 只能打电话
		 *   C5GREG       手册 7.x  <stat> 1=已注册 5=已注册(漫游) 3=注册被拒
		 *   CGACT        手册 7.x  <state> 1=已激活
		 *   NDISSTATQRY  手册 16.4 <stat> 1=已连接
		 *   CGPADDR      手册 7.x  有地址才算拿到
		 *   DHCP         手册 16.x 第 3 个字段是网关（十六进制 IP）
		 *
		 * ★ 不再"卡住就停"：这是**排查**不是向导，要的是完整画面
		 *   （模组层没问题时，防火墙没覆盖 WAN 这类 L2 毛病也得看得见）。
		 *   9 条只读命令串行走完，成本与原来 6 条在同一量级。
		 */
		function checkSteps() {
			return [
				{
					name: '射频开关', cmd: 'AT+CFUN?',
					judge: function (data) {
						var m = String(data).match(/CFUN:\s*(\d+)/);
						if (!m) return { level: 'warn', text: '取不到射频状态' };
						var v = m[1];
						if (v === '1') return { level: 'ok', text: '全功能（CFUN=1）' };
						/* ★ 红线级：CFUN=0 会把 eth2 挂死，恢复要 ifdown/ifup。
						   这里只提示，绝不自动下发 AT+CFUN=1。 */
						return {
							level: 'bad',
							text: '射频已关（CFUN=' + v + '）—— 5G 网口 eth2 会被挂死，一切免谈',
							fix: 'AT+CFUN=1 打开射频（会重启模组射频）；恢复网口需 ifdown MT5700M; sleep 2; ifup MT5700M'
						};
					}
				},
				{
					name: 'SIM 就绪', cmd: 'AT+CPIN?',
					judge: function (data) {
						var m = String(data).match(/CPIN:\s*(\S+)/);
						var v = m ? m[1] : '';
						if (v === 'READY') return { level: 'ok', text: 'READY' };
						if (!v) return { level: 'bad', text: '取不到 SIM 状态（卡没插好或没识别）' };
						return { level: 'bad', text: 'SIM 未就绪：' + v };
					}
				},
				{
					/* ★ APN 是原 6 步里最大的空白：APN 空或错 → PDP 起不来 → 必然断网，
					   而模组侧其它读数（注册、信号）看起来全都是好的。 */
					name: 'APN 配置', cmd: 'AT+CGDCONT?',
					judge: function (data) {
						var apns = [];
						AtWs.extractATDataMultiline(String(data), '+CGDCONT').forEach(function (row) {
							/* +CGDCONT: <cid>,<PDP_type>,<APN>,<PDP_addr>,... —— APN 可能带引号 */
							var p = row.split(',');
							if (p.length < 3) return;
							var a = p[2].replace(/"/g, '').trim();
							if (a && apns.indexOf(a) < 0) apns.push(a);
						});
						if (!apns.length) {
							return {
								level: 'bad',
								text: '没有任何配了 APN 的 PDP 上下文 —— 拨号必然失败（这是断网最常见的原因）',
								fix: 'AT+CGDCONT=1,"IP","<运营商APN>"（移动 cmnet / 联通 3gnet / 电信 ctnet），改完重新拨号'
							};
						}
						return { level: 'ok', text: apns.join(' / ') };
					}
				},
				{
					/* 服务域 CS_ONLY（0）只能打电话不能上网；ANY（3）在含 4G/5G 时模组不允许 */
					name: '服务域与制式', cmd: 'AT^SYSCFGEX?',
					judge: function (data) {
						var str = AtWs.extractATData(String(data), '^SYSCFGEX');
						if (!str) return { level: 'warn', text: '取不到 ^SYSCFGEX（不影响上网本身）' };
						var d = str.split(',');
						var SRV = { 0: '仅语音 CS_ONLY', 1: '仅数据 PS_ONLY', 2: '语音+数据 CS_PS', 3: '不限 ANY', 4: '不修改' };
						var sv = d.length >= 4 ? Number(String(d[3]).replace(/"/g, '').trim()) : NaN;
						var txt = '接入顺序 ' + String(d[0] || '').replace(/"/g, '')
							+ (isNaN(sv) ? '' : ' · 服务域 ' + (SRV[sv] || sv));
						if (sv === 0) return { level: 'bad', text: txt + ' —— 只注册语音，上不了网', fix: '把服务域改成 2（语音+数据）：AT^SYSCFGEX=,,2' };
						if (sv === 1) return { level: 'warn', text: txt + ' —— 只注册数据，接打电话与收发短信会失效' };
						return { level: 'ok', text: txt };
					}
				},
				{
					name: '网络注册', cmd: 'AT+C5GREG?',
					judge: function (data) {
						var r = Parse.parseRegStat(String(data), '+C5GREG');
						if (!r) return { level: 'bad', text: '取不到注册状态' };
						if (r.stat === 1 || r.stat === 5) return { level: 'ok', text: r.statText };
						if (r.stat === 3) return { level: 'bad', text: '注册被拒绝 —— 看「网络设置 → 网络拒绝」' };
						return { level: 'warn', text: r.statText + '（还没注册上，先看信号与 SIM）' };
					}
				},
				{
					name: 'PDP 上下文激活', cmd: 'AT+CGACT?',
					judge: function (data) {
						var active = [];
						AtWs.extractATDataMultiline(String(data), '+CGACT').forEach(function (row) {
							var p = row.split(',');
							if (p[1] && p[1].trim() === '1' && Number(p[0]) > 0) active.push(Number(p[0]));
						});
						if (!active.length) return { level: 'bad', text: '没有任何已激活的 PDP 上下文（多为 APN 不对）' };
						return { level: 'ok', text: '已激活 CID ' + active.join(' / ') };
					}
				},
				{
					name: '拨号连接', cmd: 'AT^NDISSTATQRY?',
					judge: function (data) {
						var rows = AtWs.extractATDataMultiline(String(data), '^NDISSTATQRY');
						if (!rows.length) return { level: 'bad', text: '模组未返回连接状态' };
						var connected = [];
						rows.forEach(function (row) {
							var p = row.split(',');
							if (p.length >= 2 && p[1].trim() === '1') connected.push(p[0].trim());
						});
						if (!connected.length) return { level: 'bad', text: '未连接（stat=0）—— 拨号没起来或已断开' };
						return { level: 'ok', text: '已连接 CID ' + connected.join(' / ') };
					}
				},
				{
					name: '拿到 IP 地址', cmd: 'AT+CGPADDR',
					judge: function (data) {
						var list = (Parse.parseCgpaddr(String(data)) || [])
							.filter(function (a) { return a && a.address; });
						if (!list.length) return { level: 'bad', text: 'PDP 已激活但没拿到地址 —— 多为 APN 或运营商侧问题' };
						/* raw 供 L2「接口地址与模组一致」交叉比对用（那里要的是地址本身，
						   不是拼好的展示文本，从文本里正则抠 IP 太脆）。 */
						return {
							level: 'ok',
							text: list.map(function (a) { return a.address; }).join(' / '),
							raw: list.map(function (a) { return a.address; })
						};
					}
				},
				{
					name: '网关与 DNS', cmd: 'AT^DHCP?',
					judge: function (data) {
						var str = AtWs.extractATData(String(data), '^DHCP');
						if (!str) return { level: 'warn', text: '取不到 DHCP 下发的网关/DNS（不影响上网本身）' };
						var d = str.split(',');
						if (d.length < 6) return { level: 'warn', text: '返回字段不足，无法判断' };
						var gw = AtWs.hexToIP(d[2].trim());
						if (!gw || gw === '0.0.0.0') return { level: 'bad', text: '网关为空 —— 有地址但没有出口' };
						return { level: 'ok', text: '网关 ' + gw + ' · DNS ' + AtWs.hexToIP(d[4].trim()) };
					}
				}
			];
		}

		/* ---------- 系统侧事实的两个小工具 ----------
		 * 后端输出的是 key=value，**值全是字符串**。
		 * ★ fnum 的默认值语义：探测不到 = -1（未知），不是 0（假失败）。
		 *   判错的代价（照着不存在的问题去改配置）远大于"没测到"。 */
		function fv(f, k) {
			var v = f[k];
			return (v == null) ? '' : String(v);
		}
		function fnum(f, k, dflt) {
			var s = fv(f, k);
			if (s === '') return dflt;
			var n = parseFloat(s);
			return isNaN(n) ? dflt : n;
		}

		/* ---------- L1 派生 + L2 + L3：全部由事实判定，不再占 AT 通道 ----------
		 *
		 * L1 的两项派生（信号 / 温度）复用页面已有读数 —— 信号质量卡与 SIM 与设备卡
		 * 本来就在刷，为排查再各发一条 AT 是纯浪费。
		 *
		 * L2/L3 的每一项都对应一个真机踩过的坑，注释里写明是哪一次。
		 * 加项时请同步补 tests/diag-contract.test.js 的「事实键存在性」断言。
		 */
		function sysChecks() {
			return [
				/* ---- L1 派生 ---- */
				{
					layer: 'L1', name: '信号质量', eval: function (f, st) {
						var c = st.cell || {};
						if (c.rsrp == null && c.sinr == null) return { level: 'warn', text: '还没读到信号（信号质量卡无数据）' };
						var txt = 'RSRP ' + (c.rsrp == null ? '—' : c.rsrp) + ' dBm · SINR ' + (c.sinr == null ? '—' : c.sinr) + ' dB';
						if (c.rsrp != null && c.rsrp < -110) {
							return {
								level: 'bad', text: txt + ' —— RSRP 低于 -110 dBm，基本注册不上',
								fix: '挪动设备或接外置天线；再看「网络设置 → 邻区扫描」挑别的小区'
							};
						}
						if (c.sinr != null && c.sinr < 0) {
							return { level: 'warn', text: txt + ' —— SINR 为负，干扰重，能注册也跑不动', fix: '避开干扰源；必要时锁频到别的频点' };
						}
						return { level: 'ok', text: txt };
					}
				},
				{
					/* ★ 直接采用「SIM 与设备」卡的「5G模块温度」：同一个 maxModuleTemp()、
					   同一份 state.temps，两处永远一致（2026-09-19 用户口径）。
					   ★ 没读到时是「待检查」而不是「存疑」：温度走慢档 30s 才取一次，
					   刚进页面就点排查会暂时没有 —— 那是没取到，不是有故障，
					   挂「存疑」会让人以为温度出了问题。它也不计入通过/存疑的计数。 */
					layer: 'L1', name: '模组温度', eval: function (f, st) {
						var mt = maxModuleTemp(st && st.temps);
						if (mt.max == null) {
							return {
								level: 'idle',
								text: '还没取到（慢档 30 秒一次，与「SIM 与设备」卡同源）'
							};
						}
						var mx = mt.max;
						if (mx >= 85) {
							return {
								level: 'bad',
								text: '最高 ' + mx + ' ℃（同「SIM 与设备」卡）—— 过热会降速甚至掉网',
								fix: '改善通风 / 清灰；H5000M 可调风扇转速策略'
							};
						}
						if (mx >= 70) return { level: 'warn', text: '最高 ' + mx + ' ℃（同「SIM 与设备」卡），偏高' };
						return { level: 'ok', text: '最高 ' + mx + ' ℃（同「SIM 与设备」卡）' };
					}
				},

				/* ---- L2 系统与网络 ---- */
				{
					layer: 'L2', name: 'AT 服务在运行', eval: function (f) {
						if (fnum(f, 'svc_at_running', -1) === 1) return { level: 'ok', text: '运行中' };
						return { level: 'bad', text: 'AT 服务没在跑 —— 本页所有模组读数都会是空的', fix: '/etc/init.d/at-webserver start' };
					}
				},
				{
					layer: 'L2', name: 'AT 服务开机自启', eval: function (f) {
						return fnum(f, 'svc_at_enabled', 0) === 1
							? { level: 'ok', text: '已启用' }
							: { level: 'warn', text: '没设开机自启，重启后要手动拉起来', fix: '/etc/init.d/at-webserver enable' };
					}
				},
				{
					/* ★ 三大高复发故障之一：git 不继承 exec 位，100644 的 init.d 开机根本不自启
					   （用户实测踩过，项目红线第 9 条就是这个）。
					   ★★ 判据用 initd_exec 而不是解析权限数字：这台设备上没有 stat 命令，
					   采集脚本只能给 ls -l 的 rwx 串；直接比对 "755" 会把好机器判成故障。
					   [ -x ] 才是"能不能执行"的可靠口径。 */
					layer: 'L2', name: 'init.d 脚本权限', eval: function (f) {
						var m = fv(f, 'initd_mode');
						if (!m) return { level: 'bad', text: '找不到 /etc/init.d/at-webserver', fix: '重装 luci-app-mt5700' };
						if (fnum(f, 'initd_exec', 0) === 1) return { level: 'ok', text: m };
						return {
							level: 'bad', text: '权限是 ' + m + '（缺执行位）—— 开机不会自启',
							fix: 'chmod 755 /etc/init.d/at-webserver && /etc/init.d/at-webserver enable'
						};
					}
				},
				{
					layer: 'L2', name: '串口设备', eval: function (f) {
						var n = fnum(f, 'ttyusb_count', -1);
						/* ★ -1 = 脚本没取到（wc -l 失败之类），不是"没有串口"。
						   把它判成 bad 会让人照着不存在的问题去拆机。 */
						if (n < 0) return { level: 'warn', text: '取不到串口数量' };
						if (n > 0) return { level: 'ok', text: n + ' 个 /dev/ttyUSB*' };
						return {
							level: 'bad', text: '没有 /dev/ttyUSB* —— 模组没被枚举上（USB 没起来 / 被切到别的模式 / 掉了电）',
							fix: 'dmesg | grep -i usb 看重枚举记录；必要时重新插拔模组或重启设备'
						};
					}
				},
				{
					/* ★ 真机实测：开机枚举成 1-1 480M，几百秒后重枚举成 2-1 5000M，速率差三倍多。
					   所以 480 只判"存疑"并说明会自动恢复，不判死。 */
					layer: 'L2', name: 'USB 链路速率', eval: function (f) {
						var s = fnum(f, 'usb_speed', -1), p = fv(f, 'usb_path'), v = fv(f, 'usb_version');
						var prod = fv(f, 'usb_product');
						if (s < 0) return { level: 'warn', text: '取不到 USB 速率' };
						var txt = s + ' Mbps（' + (p || '未知路径') + (v ? ' · USB ' + v : '')
							+ (prod ? ' · ' + prod : '') + '）';
						if (s >= 5000) return { level: 'ok', text: txt };
						if (s === 480) {
							return {
								level: 'warn',
								text: txt + ' —— 这是 USB2.0 速率。开机早期常见，几百秒后会自己重枚举成 5000；'
									+ '若一直是 480，下行会被限在 ~400 Mbps',
								fix: '等几分钟再看；始终如此则检查 M.2 插槽与 USB 线缆'
							};
						}
						return { level: 'bad', text: txt + ' —— 比 USB2.0 还低，链路有问题', fix: '检查硬件连接' };
					}
				},
				{
					/* ★ 三大高复发故障之一：刷机后缺接口 → 完全没网，而模组侧读数一切正常 */
					layer: 'L2', name: '接口存在', eval: function (f) {
						var n = fv(f, 'iface_name');
						if (fnum(f, 'iface_exists', 0) === 1) return { level: 'ok', text: n + '（设备 ' + fv(f, 'iface_device') + '）' };
						return {
							level: 'bad', text: '找不到接口 ' + n + ' —— 刷机后最常见的"完全没网"，而模组一切正常',
							fix: '在 /etc/config/network 里补上该接口（别漏 auto=1），再 /etc/init.d/network restart'
						};
					}
				},
				{
					layer: 'L2', name: '接口自动拉起', eval: function (f) {
						var a = fv(f, 'iface_auto');
						/* netifd 里 auto 缺省即为 1，没写不算问题 */
						if (a === '' || a === '1') return { level: 'ok', text: a === '' ? '未设置（netifd 默认自动）' : 'auto=1' };
						return {
							level: 'bad', text: 'auto=' + a + ' —— 接口不会自动拉起，重启后没网',
							fix: 'uci set network.' + fv(f, 'iface_name') + '.auto=1 && uci commit network'
						};
					}
				},
				{
					layer: 'L2', name: '接口状态', eval: function (f) {
						if (fnum(f, 'iface_up', 0) === 1) return { level: 'ok', text: '已 UP' };
						if (fnum(f, 'iface_pending', 0) === 1) return { level: 'warn', text: '正在协商（pending）—— 稍等再排查一次' };
						return { level: 'bad', text: '接口是 DOWN', fix: 'ifup ' + fv(f, 'iface_name') + '；起不来就回头看上面几项' };
					}
				},
				{
					layer: 'L2', name: '默认路由', eval: function (f) {
						var gw = fv(f, 'route_gw'), dev = fv(f, 'route_dev'), cnt = fnum(f, 'route_count', 0);
						if (!gw) return { level: 'bad', text: '没有默认路由 —— 有 IP 也出不去', fix: 'ifup ' + fv(f, 'iface_name') + ' 重新协商' };
						var txt = '网关 ' + gw + ' 走 ' + dev;
						if (dev && fv(f, 'iface_device') && dev !== fv(f, 'iface_device')) {
							return { level: 'warn', text: txt + ' —— 默认路由不在 5G 口上，流量实际走的是 ' + dev };
						}
						if (cnt > 1) return { level: 'warn', text: txt + ' · 共 ' + cnt + ' 条默认路由（5G 与有线并存时按 metric 选路）' };
						return { level: 'ok', text: txt };
					}
				},
				{
					/* ★ 静默断网的经典形态：模组 USB 重枚举后 netifd 不续约，
					   接口 UP、有 IP，但网关邻居永远 INCOMPLETE —— 表现为
					   「路由能进但完全没网」，只能靠重新拉起接口（ifdown/ifup）解决。 */
					layer: 'L2', name: '网关 ARP', eval: function (f) {
						var n = fv(f, 'gw_neigh');
						if (!n) return { level: 'warn', text: '没查到网关邻居项（网关为空或接口刚起）' };
						if (n === 'REACHABLE' || n === 'STALE' || n === 'DELAY' || n === 'PROBE') return { level: 'ok', text: n };
						return {
							level: 'bad',
							text: '网关邻居状态 ' + n + ' —— 解析不到网关 MAC，表现为「接口 UP、有 IP，但就是上不了网」',
							fix: 'ifdown ' + fv(f, 'iface_name') + '; sleep 2; ifup ' + fv(f, 'iface_name') + '（重新协商租约）'
						};
					}
				},
				{
					layer: 'L2', name: '接口地址与模组一致', eval: function (f, st) {
						var sys = fv(f, 'iface_addr');
						var mod = (st.tools && st.tools.diag && st.tools.diag.modAddrs) || [];
						if (!sys) return { level: 'warn', text: '系统侧没取到接口地址' };
						if (!mod.length) return { level: 'warn', text: '模组侧没取到地址（见 L1「拿到 IP 地址」）' };
						if (mod.indexOf(sys) >= 0) return { level: 'ok', text: sys };
						return {
							level: 'bad', text: '系统是 ' + sys + '、模组是 ' + mod.join(' / ') + ' —— 租约已失效',
							fix: 'ifdown/ifup ' + fv(f, 'iface_name') + ' 重新拿地址'
						};
					}
				},
				{
					/* ★ 三大高复发故障之一：加了 WAN 没 restart firewall → 有 IP 但出不去 */
					layer: 'L2', name: '防火墙覆盖 WAN', eval: function (f) {
						if (fnum(f, 'fw_wan_cover', 0) === 1) return { level: 'ok', text: 'wan zone 已包含 ' + fv(f, 'iface_name') };
						return {
							level: 'bad',
							text: 'wan zone 里没有 ' + fv(f, 'iface_name') + '（当前包含：' + (fv(f, 'fw_wan_nets') || '空') + '）—— 有 IP 也出不去',
							fix: '把该接口加进 wan zone 后**必须** /etc/init.d/firewall restart（不 restart 不生效）'
						};
					}
				},
				{
					layer: 'L2', name: 'DNS 配置', eval: function (f) {
						var d = fv(f, 'dns_servers');
						var dnsm = fnum(f, 'dnsmasq_running', -1);
						if (!d) return { level: 'warn', text: 'resolv.conf 里没有 nameserver', fix: '检查接口有没有拿到 DNS' };
						return {
							level: dnsm === 1 ? 'ok' : 'warn',
							text: d + (dnsm === 1 ? ' · dnsmasq 运行中' : ' · dnsmasq 没在跑')
						};
					}
				},
				{
					/* ★ SQM 配到 eth1（DOWN）是陷阱；且 SQM 与 flow offload 互斥
					   （被卸载的连接绕过 qdisc，CAKE 直接失效）。 */
					layer: 'L2', name: 'SQM 与分载', eval: function (f) {
						var sqm = fnum(f, 'sqm_enabled', 0), si = fv(f, 'sqm_iface');
						var fo = fnum(f, 'flow_offload', 0), foh = fnum(f, 'flow_offload_hw', 0);
						var dev = fv(f, 'iface_device');
						var bits = [], fixes = [];
						/* ★ level 只许升不许降：SQM 配错接口是 bad，后面"分载互斥"是 warn，
						   让后者覆盖前者会把严重问题降级成提醒（真机上就会漏掉限速落空）。 */
						var level = 'ok';
						function worse(l) {
							var rank = { ok: 0, warn: 1, bad: 2 };
							if (rank[l] > rank[level]) level = l;
						}
						if (sqm === 1) {
							if (si && dev && si !== dev) {
								worse('bad');
								bits.push('SQM 配在 ' + si + '，而当前出口是 ' + dev + ' —— 限速落在别的接口上');
								fixes.push('把 SQM 的 interface 改成 ' + dev);
							} else {
								bits.push('SQM 已启用（' + si + '）');
							}
							if (fo === 1) {
								worse('warn');
								bits.push('flow offload 也开着，二者互斥，CAKE 会被绕过');
								fixes.push('SQM 与 flow offload 只留一个');
							}
						} else {
							bits.push('SQM 关闭（不限速）');
						}
						bits.push('软件分载 ' + (fo === 1 ? '开' : '关') + ' · 硬件分载 ' + (foh === 1 ? '开' : '关'));
						return { level: level, text: bits.join('；'), fix: fixes.join('；') };
					}
				},
				{
					layer: 'L2', name: 'MTU', eval: function (f) {
						var m = fnum(f, 'iface_mtu', 0);
						if (!m) return { level: 'warn', text: '取不到 MTU' };
						if (m === 1500) return { level: 'ok', text: '1500' };
						return { level: 'warn', text: m + '（非 1500）—— 与对端不一致时会出现部分站点打不开' };
					}
				},
				{
					/* 时间不同步 → HTTPS 证书校验失败 → 表现为"部分网站打不开" */
					layer: 'L2', name: '系统时间', eval: function (f) {
						var s = fnum(f, 'time_synced', -1);
						if (s === 1) return { level: 'ok', text: '已同步' };
						if (s < 0) return { level: 'warn', text: '取不到系统时间' };
						return { level: 'bad', text: '时间明显不对 —— HTTPS 证书校验会失败', fix: '确认 NTP 能通（sysntpd / ntpclient）' };
					}
				},

				/* ---- L3 端到端连通 ---- */
				{
					/* ★★ 真机坑（2026-09-19 实测）：本机网关 10.0.0.1 **根本不回应 ICMP**，
					   但公网 ping、HTTPS 全通 —— 网络完全正常。
					   若无条件把"网关 ping 不通"判成 bad，这台机器每次排查都会报一个
					   不存在的故障，而且会引导用户去做 ifdown/ifup（那才是真的会断网）。
					   → 必须结合公网探测判断：公网通 = 网关只是不回应 ICMP，属正常。 */
					layer: 'L3', name: 'ping 网关', eval: function (f) {
						var v = fnum(f, 'ping_gw', -1);
						if (v === 1) return { level: 'ok', text: '通' };
						if (v < 0) return { level: 'warn', text: '没测（没有网关，或设备上没有 ping 命令）' };
						var pub = (fnum(f, 'ping_public_a', -1) === 1 || fnum(f, 'ping_public_b', -1) === 1
							|| fnum(f, 'tcp_443', -1) === 1);
						if (pub) {
							return {
								level: 'ok',
								text: '网关不回应 ICMP，但公网通 —— 运营商网关不答 ping 很常见，不影响上网'
							};
						}
						return { level: 'bad', text: '网关 ping 不通，且公网也不通 —— 二层就没到出口', fix: '回头看 L2 的「网关 ARP」那一项' };
					}
				},
				{
					/* ★ 探测目标用公网 IP 而不是域名：本机装过 mosdns / OpenClash，
					   拿域名探测会被本地解析器误导，得出"能上网"的错误结论。 */
					layer: 'L3', name: 'ping 公网 IP', eval: function (f) {
						var a = fnum(f, 'ping_public_a', -1), b = fnum(f, 'ping_public_b', -1);
						if (a < 0 && b < 0) return { level: 'warn', text: '没测（设备上没有 ping 命令）' };
						if (a === 1 || b === 1) return { level: 'ok', text: '至少一路通（119.29.29.29 / 223.5.5.5）' };
						return {
							level: 'bad',
							text: '两路公网 IP 都 ping 不通 —— 用 IP 而非域名探测，可确定是「网络不通」而不是「DNS 不通」',
							fix: '回头看 L2 的路由 / ARP / 防火墙三项'
						};
					}
				},
				{
					layer: 'L3', name: 'DNS 解析', eval: function (f) {
						var v = fnum(f, 'dns_resolve_ok', -1);
						if (v < 0) return { level: 'warn', text: '没测（设备上没有 nslookup / drill）' };
						if (v === 1) return { level: 'ok', text: 'www.qq.com 解析成功' };
						return {
							level: 'bad',
							text: '解析失败 —— 若上面 ping 公网 IP 是通的，那就是纯 DNS 问题',
							fix: '检查 /etc/resolv.conf 与 dnsmasq；本机装过 mosdns / OpenClash，注意它们会接管解析'
						};
					}
				},
				{
					/* 有些网络禁 ICMP：ping 不通不代表上不了网，这一项兜住那种情况。
					   后端用 curl 打 https://www.qq.com，退出码 6 = 域名解析失败
					   —— 那是 DNS 的问题，不能算到链路上，所以要单独点出来。 */
					layer: 'L3', name: 'HTTPS 连通', eval: function (f) {
						var v = fnum(f, 'tcp_443', -1);
						if (v < 0) return { level: 'warn', text: '没测（设备上没有 curl）' };
						if (v === 1) return { level: 'ok', text: 'https://www.qq.com 握手成功（DNS + TCP + TLS 都通）' };
						if (v === 6) {
							return {
								level: 'bad',
								text: '域名解析失败（curl 退出码 6）—— 链路可能是好的，问题在 DNS',
								fix: '看上面「DNS 解析」那一项'
							};
						}
						return {
							level: 'warn',
							text: 'HTTPS 建连失败（curl 退出码 ' + v + '）—— 若这项也不通，那是真的上不了网（不是 ICMP 被禁的假象）'
						};
					}
				}
			];
		}

		/*
		 * 把所有检查项按「注册表顺序」铺平：
		 * 已跑过的用结果，没跑过的显示「待检查」。
		 * 这样排查前就能看到完整清单（知道自己会被查哪些项），而不是点了才冒出来一堆行。
		 */
		function diagItems() {
			var t = state.tools.diag;
			var done = {};
			(t.atSteps || []).forEach(function (s) { done[s.name] = s; });
			(t.items || []).forEach(function (s) { done[s.name] = s; });
			var out = [];
			function push(layer, name, cmd) {
				var d = done[name];
				out.push(d
					? { layer: layer, name: name, cmd: cmd || '', level: d.level, text: d.text, fix: d.fix || '', done: true }
					: { layer: layer, name: name, cmd: cmd || '', level: 'idle', text: '待检查', fix: '', done: false });
			}
			checkSteps().forEach(function (s) { push('L1', s.name, s.cmd); });
			sysChecks().forEach(function (c) { push(c.layer, c.name, ''); });
			return out;
		}

		/* 明细表的一行：结论 + 说明（建议命令挂在说明下面，不另起一列 ——
		   4 列会把「说明」挤成窄条，而建议往往是一整条命令）。 */
		function diagRow(i) {
			var cell = E('div');
			cell.appendChild(E('span', {}, i.text));
			if (i.fix) {
				cell.appendChild(E('div', { 'class': 'mt5700-hint mt5700-mt-sm' }, '建议：' + i.fix));
			}
			if (i.cmd) {
				cell.appendChild(E('div', { 'class': 'mt5700-hint mt5700-mt-sm mt5700-mono' }, i.cmd));
			}
			return [
				i.name,
				E('b', { 'class': 'mt5700-diag-verdict is-' + i.level }, DIAG_VERDICT[i.level] || '—'),
				cell
			];
		}

		function renderDiagDetail() {
			if (!diagDetailBody) return;
			/* R08：重建前记下滚动位置（若有），重建后恢复，避免每次 renderTools 重绘把滚动弹回顶部 */
			var _scroller = diagDetailBody.querySelector('.mt5700-diag-scroll');
			var _scrollTop = _scroller ? _scroller.scrollTop : 0;
			diagDetailBody.innerHTML = '';
			var t = state.tools.diag;
			var items = diagItems();

			/* factsErr：系统侧事实没取到时给块级提示 —— 模组层（L1）的检查不受影响。 */
			if (t.factsErr) {
				diagDetailBody.appendChild(Mt5700.empty('系统侧事实没取到：' + t.factsErr
					+ ' —— 需要升级设备端的 luci-app-mt5700。模组层（L1）的检查不受影响。'));
			}

			/* 三层分段切换（复用现成 Mt5700.segmented + DIAG_LAYERS，label 用「ID + 短名」省宽度）。不再插 {group} 分组行。 */
			var head = E('div', { 'class': 'mt5700-toolbar' });
			head.appendChild(Mt5700.segmented(DIAG_LAYERS.map(function (L) {
				return { label: L.id + ' ' + L.short, value: L.id };
			}), diagLayer, function (v) {
				diagLayer = v;
				renderTools();
			}).el);
			diagDetailBody.appendChild(head);

			var list = items.filter(function (i) { return i.layer === diagLayer; });
			/* 事实没取到时该层若是 L2/L3 全「待检查」，摆空表只会误导（R04）：给占位说明 */
			if (!(t.factsErr && diagLayer !== 'L1')) {
				var rows = list.map(function (i) { return diagRow(i); });
				var tbl = Mt5700.table(['项目', '结论', '说明'], rows, { striped: true });
				/* sticky 表头 + 限高滚动：max-height 加在 .mt5700-table-wrapper 上
				   （它自带 overflow-x:auto，按 CSS 规范 overflow-y 会被算成 auto），表头滚动时固定。 */
				tbl.classList.add('mt5700-diag-scroll');
				diagDetailBody.appendChild(tbl);
				if (_scrollTop) tbl.scrollTop = _scrollTop; /* R08 */
			} else {
				diagDetailBody.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'系统侧事实没取到（需升级 luci-app-mt5700），本层（' + diagLayer + '）无法判定；先看模组层 L1。'));
			}

			/* R05/R06：底部说明 —— 未排查时引导先排查，已排查时给「本层 N / 共 N」避免「丢了 21 项」的错觉 */
			if (!t.ran) {
				diagDetailBody.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'尚未排查 —— 点上方「一键排查」后，这里才会出各层的结论与建议命令。'));
			} else {
				diagDetailBody.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'本层 ' + list.length + ' 项 / 共 ' + items.length + ' 项。判定标准与阈值写在本页源码的注册表里；'
					+ '「建议」只是命令，不会自动执行 —— 续约、重启服务本身会短暂断网，确认后再在终端执行。'));
			}
		}

		/* ---------- 总控块（右列卡片） ---------- */
		function buildDiagBlock() {
			var t = state.tools.diag;
			/* ★ 2026-09-19：按钮恒定叫「一键排查」。排查改成只由点击触发后，
			   不再有「首次 / 重新」之分 —— 跑完再点就是再跑一次。 */
			var btn = Mt5700.ghostButton(t.busy ? '排查中…' : '一键排查', runDiagnosis);
			var box = toolBlock('三层体检', btn);

			var items = diagItems();
			var bad = null, warnN = 0;
			items.forEach(function (i) {
				if (!i.done) return;
				if (i.level === 'bad') { if (!bad) bad = i; }
				else if (i.level === 'warn') warnN++;
			});
			var summaryText = t.busy ? '排查中…'
				: (!t.ran ? '未排查'
					: (bad ? ('未通过：' + bad.name) : (warnN ? (warnN + ' 项存疑') : '全部通过')));
			/* 用现成 badge 而不是块级摘要：它是行内元素，塞进标题行不会把行撑高。 */
			box.firstChild.insertBefore(Mt5700.badge(summaryText,
				bad ? 'danger' : (warnN ? 'warning' : (t.ran && !t.busy ? 'success' : 'neutral'))), btn);

			/* 影响预告写在按钮正下方：这是一条会占住独占 AT 通道的动作，期间同页
			   其它读数都会变慢。用户点之前就该知道，塞进 tooltip 等于没说。
			   ★ 时长是真机量出来的（正常约 3 秒；断网时 L3 那几次 ICMP/TCP 会吃满
			   超时，最慢十几秒），不能按「感觉」写 —— 写小了用户以为卡死。 */
			box.appendChild(Mt5700.impact(['点一次约 ', { b: '3 秒' },
				'，断网时最慢十几秒：期间 AT 通道被占用，同页读数会变慢；全程只读，不改任何配置。']));

			/* 三层计数：一眼看出问题落在哪一层，不用到底部明细里数 */
			var chips = E('div', { 'class': 'mt5700-diag-chips' });
			DIAG_LAYERS.forEach(function (L) {
				var list = items.filter(function (i) { return i.layer === L.id; });
				/* ★ 计数排除 idle：已排查但没取到数据的项（如温度没读到）是「待检查」，
				   既不该算通过也不该算存疑 —— 混进分母会让「N/N 全通过」掺假。 */
				var done = list.filter(function (i) { return i.done && i.level !== 'idle'; });
				var b = 0, w = 0;
				done.forEach(function (i) {
					if (i.level === 'bad') b++;
					else if (i.level === 'warn') w++;
				});
				var txt = L.name + ' ' + (done.length ? (done.length - b - w) + '/' + done.length : '—');
				chips.appendChild(Mt5700.badge(txt,
					b ? 'danger' : (w ? 'warning' : (done.length ? 'success' : 'neutral'))));
			});
			box.appendChild(chips);

			box.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
				'共 ' + items.length + ' 项：L1 走 AT 只读命令，L2/L3 走后端只读采集。'
				+ '只给事实与建议命令，不自动改任何配置。明细就在本卡内，按 L1 / L2 / L3 分段查看。'));
			return box;
		}

		/*
		 * 跑一次完整排查。三步串行走，全程只读：
		 *   ① L1：9 条 AT 只读命令，走唯一的 AT 通道（独占，必须串行）
		 *   ② 取系统侧事实：一次 mt5700.sysdiag（后端跑 diag-probe.sh，不碰 AT 通道）
		 *   ③ L2/L3：拿事实逐项判定（纯前端计算，不额外发请求）
		 *
		 * ★ 为什么 sysdiag 放在 AT 之后：它内部有 3 次 ICMP + 1 次 DNS + 1 次 TCP 握手，
		 *   最坏 15 秒；先让 AT 这条独占通道跑完，免得 rpcd 那边慢下来拖住模组查询。
		 * ★ 全程不写任何配置、不下发任何写命令（用户 2026-09-19 明确只要诊断）。
		 * ★ 只在用户点「一键排查」时触发（v2.3.15）：这条链要占住独占的 AT 通道十几秒，
		 *   自动跑会和页面轮询、用户手动 AT 抢通道 —— 项目对"持续下发 AT"早有定论。
		 */
		function runDiagnosis() {
			var t = state.tools.diag;
			/* ★ 必须返回 Promise：按钮回调里如果哪天变成 .then(...) 链，
			   busy 时 return undefined 会让调用方抛 TypeError，被吞进没人 catch 的
			   rejected promise —— 表现为「排查静默不跑，页面上没有任何提示」。 */
			if (t.busy) return Promise.resolve();
			t.busy = true; t.atSteps = []; t.items = []; t.facts = {}; t.factsErr = ''; t.modAddrs = [];
			renderTools();

			var chain = Promise.resolve();
			checkSteps().forEach(function (s) {
				chain = chain.then(function () {
					if (disposed) return;
					return AtWs.client.sendCommand(s.cmd).then(function (res) {
						var data = (res && res.success) ? String(res.data || '') : '';
						var r = s.judge(data) || {};
						t.atSteps.push({
							name: s.name,
							level: r.level || 'warn',
							text: r.text || '（无法判断）',
							fix: r.fix || ''
						});
						/* 模组侧地址留给 L2「接口地址与模组一致」交叉比对 */
						if (r.raw) t.modAddrs = r.raw;
					}).catch(function (e) {
						t.atSteps.push({
							name: s.name, level: 'bad',
							text: '查询失败：' + ((e && e.message) || '模组无响应'),
							fix: '确认 AT 服务在运行（见 L2「AT 服务在运行」）'
						});
					}).then(renderTools);
				});
			});

			return chain.then(function () {
				if (disposed) return;
				return AtWs.sysDiag();
			}).then(function (r) {
				if (!r) return;
				t.facts = r.facts || {};
				t.factsErr = r.success ? '' : (r.error || '后端未返回');
			}).then(function () {
				t.items = sysChecks().map(function (c) {
					var r;
					try {
						r = c.eval(t.facts, state) || {};
					} catch (e) {
						/* 一项判定写崩不该带走整页：兜成「存疑」而不是让排查卡住 */
						r = { level: 'warn', text: '判定异常：' + ((e && e.message) || '未知错误') };
					}
					return {
						layer: c.layer, name: c.name,
						level: r.level || 'warn', text: r.text || '（无数据）', fix: r.fix || ''
					};
				});
			/* ★ 2026-09-19（P04，Reviewer 修正）：跑完无条件定位首个问题层，让用户一睁眼就落在问题上；
			   无问题项则保持当前层不变（不再有「展开/折叠」要管 —— 明细恒展开）。 */
			var _prob = [];
				(t.atSteps || []).forEach(function (s) {
					if (s.level === 'bad' || s.level === 'warn') _prob.push({ name: s.name, layer: 'L1' });
				});
				(t.items || []).forEach(function (s) {
					if (s.level === 'bad' || s.level === 'warn') _prob.push({ name: s.name, layer: s.layer });
				});
				if (_prob.length) {
					diagLayer = _prob[0].layer || 'L1';
				}
				t.busy = false; t.at = Date.now(); t.ran = true;
				if (!disposed) renderTools();
			}).catch(function (e) {
				/* R03：sysDiag/reject 时若不 catch，t.busy 永久卡 true、页面永久「排查中…」且自动展开永不触发。仍是只读无副作用。 */
				t.busy = false; t.ran = true;
				t.factsErr = String((e && e.message) || e);
				if (!disposed) renderTools();
			});
		}

		/*
		 * ③ 流量统计清零（手册 16.11 ^DSFLOWCLR）
		 * 入口挂在「速率与流量」卡头的「实时监测」开关后面（见下方 rateExtra 填充处），
		 * 不占独立卡片：它是个动作按钮，和同一张卡的流量数字放在一起才顺手。
		 * ★ 不可逆操作，必须走 Mt5700.confirm 二次确认。
		 */

		function clearFlowStats() {
			Mt5700.confirm('清零流量统计？本次与累计的流量、连接时长都会归零，且无法恢复。'
				+ '只清统计计数器、不会断网（手册 16.11 ^DSFLOWCLR）。'
				+ '适合核对套餐周期，或测某个应用耗了多少流量。', function () {
				return AtWs.client.sendCommand('AT^DSFLOWCLR').then(function (res) {
					if (!res || !res.success) {
						Mt5700.error('清零失败：' + ((res && res.error) || '模组未响应'));
						return;
					}
					Mt5700.success('已清零');
					/* 峰值是「本轮实时监测」的极值，计数既然归零，峰值也该跟着归零，
					   否则界面会同时出现「累计流量 0」和「峰值下行 300 Mbps」这种
					   自相矛盾的画面。速率曲线（history）不跟着清 —— 它是速率维度
					   的连续采样，清了只会让图空一大段，没有额外信息量。 */
					state.peakDown = 0;
					state.peakUp = 0;
					/* ★ 成功与失败都要重绘：
					   失败时把 state.flow 置空，让格子显示成「—」——
					   计数其实已经归零了，只是没读回来；若照旧显示旧数字，
					   用户会以为「没清成功」，那是比直接报错更糟的误读。 */
					return getFlow().then(renderFlow, function () {
						state.flow = {};
						renderFlow();
					});
				});
			}, '确认清零');
		}

		/* ---------- 渲染 ---------- */

		function dash(v, unit) { return v == null ? '—' : v + unit; }

		/*
		 * AT+C5GREG? 的 <tac> 与 <ci> 是十六进制字符串（实测 "14225C" / "0000000C027F5065"），
		 * 直接显示不易与运营商工参对照，这里统一转成十进制。
		 * 非十六进制（或超出 JS 安全整数范围的超长值）原样返回。
		 */
		function hexToDec(v) {
			if (v == null) return '';
			var s = String(v).trim().replace(/^0[xX]/, '').replace(/^0+/, '');
			if (!s || !/^[0-9a-fA-F]+$/.test(s) || s.length > 13) return String(v);
			return String(parseInt(s, 16));
		}

		/*
		 * 网络制式显示文案：裸值 NR / LTE 改成「代际-制式」写法（5G-NR / 4G-LTE）。
		 *
		 * ★ 这里的「5GA」是启发式判定，不是模组给的：
		 *   手册 13.1 的 AT^SYSINFOEX <sysmode> 合法值只有 0/1/3/5/6/11（11 = NR-5GC），
		 *   真机 AT^MONSC / AT^HCSQ 也只返回裸 "NR" —— 模组**没有任何 5G-Advanced 字段**，
		 *   手册全文检索不到 5G-A / 5GA / Advanced。所以只能按用户约定的规则推断：
		 *   NR 且聚合载波数 ≥ 2 → 5GA-NR，NR 单载波 → 5G-NR。
		 *
		 * ★ 另一条真机事实（2026-09-20）：**制式只在已注册时才成立**。
		 *   卡上没有可用 Profile 时，CGREG 报 1,2 / CEREG 报 2,2（都未注册），
		 *   但 AT^MONSC 照样回 `^MONSC: NR,000,000,0,0,0,...` —— 制式字段是 NR，
		 *   MCC/MNC/CID/PCI 却全是 0，AT^HFREQINFO? 直接 ERROR（一个载波都没有）。
		 *   这种情况把 NR 原样显示成「5G-NR」，等于告诉用户「你在 5G 网上」，
		 *   而实际连网都没有。故未注册时一律显示「—」：制式是驻留结果，
		 *   没有驻留就没有制式可报，宁可空着也不编。
		 *
		 * 后缀始终跟随真实 sysMode，不会把 LTE 标成 NR；无法识别的制式原样返回裸值
		 * （宁可显示 "NR-5GC" 也不要编一个代际出来）。
		 */
		/* AT 响应里的 <stat> 是字符串，取不到 / 非数字一律归一成 null（未知）。 */
		function normStat(stat) {
			if (stat === null || stat === undefined || String(stat).trim() === '') return null;
			var n = parseInt(stat, 10);
			return isNaN(n) ? null : n;
		}

		/* 单条注册状态的档位：1 = 已注册，0 = 明确未注册，-1 = 未知（没取到）。 */
		function regRank(psStat) {
			if (psStat === 1 || psStat === 5) return 1;
			if (psStat === 0 || psStat === 2 || psStat === 3 || psStat === 4) return 0;
			return -1;
		}

		function hasPsService(psStat, cell) {
			var r = regRank(psStat);
			if (r === 1) return true;
			if (r === 0) return false;
			/*
			 * null = 这一轮没取到（查询失败）。这时不能武断判「没服务」，
			 * 否则一次查询失败就把好端端的制式抹成「—」，反而丢信息。
			 * 退化为看驻留小区是否真实：未注册时 MONSC 的 MCC 是 "000"。
			 */
			var mcc = String((cell && cell.mcc) || '').replace(/[^0-9]/g, '');
			return !!mcc && !/^0+$/.test(mcc);
		}

		/*
		 * 综合判定「有没有真的驻留上」。
		 *
		 * ★ 取两条：CEREG（EPS = LTE/NR）与 CGREG（GPRS = 2G/3G）。
		 *   这条模组是 5G 的，**以 CEREG 为准**；CGREG 只在 CEREG 没取到时兜底 ——
		 *   否则纯 LTE/NR 场景下 CGREG 恒报 0，会把「已驻留」误判成没服务。
		 *   反过来只看 CGREG 也不行：NR-only 时它同样可能不反映真实驻留。
		 *
		 * 两条都没取到 → 退化看 MCC（未注册时 MONSC 的 MCC 是 "000"）。
		 */
		function hasAnyPsService(epsStat, gprsStat, cell) {
			var r = regRank(epsStat);
			if (r < 0) r = regRank(gprsStat);
			if (r === 1) return true;
			if (r === 0) return false;
			return hasPsService(null, cell);
		}

		/*
		 * 载波表里 **NR 载波**的条数。
		 * ★ NSA(EN-DC) 下 ^HFREQINFO **同时**上报 LTE 锚点与 NR 辅载波
		 *   （2026-09-29 真机：`0,6,3,…` + `0,7,41,…`），所以
		 *   `state.carriers.length`（=2）不等于 NR 载波数（=1）——
		 *   后者才是 5GA 判据的分母，也是「NR 到底在不在用」的证据。
		 */
		function nrCarrierCount(carriers) {
			return (carriers || []).filter(function (c) {
				return String((c && c.sysMode) || '').trim().toUpperCase() === 'NR';
			}).length;
		}

		function systemModeLabel(sysMode, nrCarrierNum, registered, nrActive) {
			if (registered === false) return '—';
			var m = String(sysMode || '').trim().toUpperCase();
			/*
			 * ★ 2026-09-29 真机 bug：NSA(EN-DC) 下 ^MONSC 报的是 **LTE 锚点**小区
			 *   （`^MONSC: LTE,460,00,…`），只吃它的 <sysmode> 就会把 5G 显示成
			 *   「4G-LTE」。而此刻 NR 其实已经在用 —— 同一轮里 ^LENDC 报
			 *   `<nr_pscell>=1`（EN-DC 已建立）、^HFREQINFO 里有 sysmode=7 的载波、
			 *   ^MONSSC 报出 NR 辅连接小区。
			 *   所以「是不是 5G」由第四参 <nrActive>（NR 侧真的在用）决定，
			 *   而不是锚点制式。第四参缺省时为假 → 老调用方与纯 LTE 行为不变。
			 */
			var isNr = m === 'NR' || m === 'NR-5GC' || m === '5G' || (m === 'LTE' && nrActive);
			if (isNr) {
				return (nrCarrierNum >= 2 ? '5GA' : '5G') + '-NR';
			}
			if (m === 'LTE') return '4G-LTE';
			if (m === 'WCDMA') return '3G-WCDMA';
			if (m === 'GSM') return '2G-GSM';
			return m || '—';
		}

		/*
		 * 「网络制式」唯一判定入口：把三路证据（^MONSC 的制式、^HFREQINFO 的载波、
		 * ^LENDC 的 EN-DC 状态）合成一个标签。
		 *
		 * ★ 抽成纯函数不是为好看 —— 这段判定原先直接写在 renderConn 里，测试够不到
		 *   （视图闭包），NSA 就是从这道缝里漏过去的。判据本身也容易漏东西，
		 *   只有能被真数据驱动才守得住（见 tests/sysmode-label.test.js 的 NSA 段）。
		 */
		function ratDisplay(sysMode, carriers, endc, registered) {
			if (registered === false) return '—';
			var nrCcs = nrCarrierCount(carriers);
			var dcActive = !!(endc && endc.established);
			return systemModeLabel(sysMode, nrCcs, registered, nrCcs > 0 || dcActive);
		}

		/*
		 * 「载波与聚合」徽章文案。
		 * ★ 1 条 LTE + 1 条 NR 是**双连接（DC）**，不是载波聚合 —— 聚合要求
		 *   同一制式内 ≥2 条载波。原判据是 `count > 1`，NSA 下 count=2，徽章
		 *   于是把 EN-DC 说成「2 载波聚合中」，与本块注释「避免把 EN-DC 双连接
		 *   与 NR 载波聚合混为一谈」自相矛盾（2026-09-29 真机）。
		 */
		function aggregationBadge(carrierCount, nrCount, dcActive) {
			if (!carrierCount) return '不可用';
			var caActive = carrierCount - nrCount > 1 || nrCount > 1;
			if (dcActive && caActive) return 'EN-DC 双连接 + ' + carrierCount + ' 载波';
			if (dcActive) return 'EN-DC 双连接';
			if (caActive) return carrierCount + ' 载波聚合中';
			return '单载波';
		}

		function renderConn() {
			connBody.innerHTML = '';
			/* 卡片标题带上运营商（「连接状态 ・ 中国移动」）。
			   operatorFromCode 拿不到 PLMN 时返回「未知运营商」，这种情况就不拼，
			   免得标题白白变长还看不出意义。 */
			if (connTitleEl) {
				var op = (state.operator && state.operator !== '未知运营商')
					? state.operator : '';
				connTitleEl.textContent = op ? ('连接状态 ・ ' + op) : '连接状态';
			}
			var c = state.cell;
			var ambrD = splitSpeedUI(state.ambrDown, 'kbps');
			var ambrU = splitSpeedUI(state.ambrUp, 'kbps');
			var grid = E('div', { 'class': 'mt5700-metrics' });
			[
				{ label: '网络状态', value: state.networkStatus, color: 'info' },
			/* 制式「5GA-NR / 5G-NR / 4G-LTE」由 ratDisplay 统一判定（规则与真机依据见那里）。
			   ★ 不能再传 `state.carriers.length` —— NSA 下它把 LTE 锚点与 NR 辅载波一起
			   数进来，分母就错了；ratDisplay 内部按 per-carrier <sysmode> 自己取 NR 条数。
			   第四参是「是否真的驻留上」：未注册时显示「—」，不把模组的残留制式字段
			   当成正在用的网络（真机依据见 systemModeLabel 注释）。 */
			{ label: '网络制式', value: ratDisplay(state.cell.sysMode, state.carriers,
				state.diag && state.diag.endc,
				hasAnyPsService(state.psRegStatEps, state.psRegStat, state.cell)) },
				/* 信号强度不在此重复：上方环形仪表与顶部状态条已各有一处 */
				{ label: 'APN', value: state.apn },
				{ label: 'QCI', value: state.qci },
				/* 连接状态面板展示的是签约速率（AT^DSAMBR），不是瞬时速率 */
				{ label: '下行速率（签约）', value: ambrD.value + ' ' + ambrD.unit },
				{ label: '上行速率（签约）', value: ambrU.value + ' ' + ambrU.unit }
			].forEach(function (it) {
				grid.appendChild(Mt5700.metric(it.label, it.value, it.color));
			});
			connBody.appendChild(grid);

			/* PLMN / TAC / 小区 / PCI 已并入「载波与聚合」卡片：那才是描述主小区的地方，
			   而且原表里的「频点」列其实取的是 TAC（0x14225C），标错了，真频点在载波表里。 */
		}

		/* ================= 结论区（一句结论 + 四段链路） =================
		 *
		 * 这一页有 6 个区、二十多个读数，但用户进页面其实只想知道三件事：
		 *   「现在有没有网」→ 一句结论
		 *   「哪一段不通」  → 链路条：模组 → SIM → 注册 → 拨号
		 *   「那要做什么」  → 下面的「需要处理」
		 *
		 * ★ 结论**不读新数据**，只消费别的区已在用的 state：单一数据源，
		 *   不会出现「结论说可以上网、连接状态却显示未注册」这种自相矛盾。
		 * ★ 判定严格按链路顺序短路：先断的那一段决定结论。四段各自出结论的话，
		 *   同一屏上就会同时出现「已连接」与「未注册」。
		 *
		 * 设备信息（devState）走 60 秒节流，首屏前几拍是 null —— SIM 段此时显示
		 * 「读取中」而不是「异常」：没取到 ≠ 有问题。
		 */
		function simKnown() { return !!devState; }
		function simWarnNow() { return devState ? Parse.simIsWarn(devState.sim) : false; }

		function firstV4Addr() {
			var list = buildAddrList();
			for (var i = 0; i < list.length; i++) {
				if (list[i].family === 'IPv4') return list[i];
			}
			return null;
		}

		/* 信号等级 → 结论区的语气（Parse.signalLevel 是全局唯一分级口径） */
		function sigTone(v) {
			var lv = Parse.signalLevel(v);
			if (lv == null) return '';
			if (lv === 'exc' || lv === 'good') return 'ok';
			if (lv === 'fair') return 'warn';
			return 'bad';
		}

		function renderVerdict() {
			var cell = state.cell || {};
			var registered = hasAnyPsService(state.psRegStatEps, state.psRegStat, cell);
			var v4 = firstV4Addr();
			var gw = state.dhcpv4 ? state.dhcpv4.gateway : '';
			var mt = maxModuleTemp();
			var main = (state.carriers || [])[0] || null;
			var band = main ? bandLabel(main.sysMode, main.band) : '';
			var rat = ratDisplay(cell.sysMode, state.carriers,
				state.diag && state.diag.endc, registered === true);
			var op = (state.operator && state.operator !== '未知运营商') ? state.operator : '';
			var down = splitSpeedUI(state.rtDown || 0, 'bytes');
			var up = splitSpeedUI(state.rtUp || 0, 'bytes');

			/* ---- 四段链路的判定 ---- */
			var simTone = simWarnNow() ? 'bad' : (simKnown() ? 'ok' : 'mute');
			var regTone = registered === true ? 'ok' : (registered === false ? 'bad' : 'mute');
			var dialTone = v4 ? 'ok' : (registered === true ? 'warn' : 'mute');

			/* ---- 一句结论 ---- */
			/* 默认语气留空（= 主色中性）：首屏还没读到数据时不是「存疑」，
			   拿琥珀色去吓用户一轮是误报。只有真的判出断点才换 warn / bad。 */
			var tone = '';
			var title = '正在读取模组状态';
			var sub = ['首屏读数要几秒钟，这一块会自动更新。'];

			if (simWarnNow()) {
				tone = 'bad';
				title = 'SIM 卡未就绪';
				sub = ['模组认不到这张卡，网络与短信都用不了。先确认卡插好、没有被 PIN 锁定。'];
			} else if (registered === false) {
				tone = 'bad';
				title = '未注册到网络';
				sub = ['模组读得到卡，但没有驻留到任何网络。常见原因是射频被关、天线没接好或频段被锁死。'];
			} else if (registered === true && !v4) {
				tone = 'warn';
				title = '已注册，但还没拿到地址';
				sub = ['驻留成功却没有 IP，通常是 APN 配置不对，或者 PDP 上下文没激活。'];
			} else if (v4) {
				tone = 'ok';
				title = '已连接，可以上网';
				sub = ['已获取地址 ', { b: v4.address }];
				if (gw) { sub.push('，网关 ', { b: gw }); }
				/* 「实时监测」关掉时采样根本不在跑，此时 rtDown 是上一轮的残值，
				   写进结论会变成一句假的现状 —— 那种情况下只说地址，不说速率。 */
				if (rateOn) {
					sub.push('，当前下行 ' + down.value + ' ' + down.unit);
				}
				sub.push('。');
			}

			/* ---- 需要处理：只收「真的会挡住用户」的事项，没网时最多两条 ---- */
			/* 顶栏那个状态徽标跟结论卡同源：一处判定，两处显示 ——
			   分开算迟早出现「顶栏说已连接、卡片说未注册」。 */
			Mt5700.shellPill(tone, title);
			var todos = [];
			function gotoDiag() {
				if (diagCard && diagCard.scrollIntoView) {
					diagCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
				}
			}
			if (simWarnNow()) {
				todos.push({
					title: 'SIM 卡未就绪',
					note: '当前无法上网；短信与通话同样不可用。',
					actions: [{ label: '去排查', variant: 'secondary', onClick: gotoDiag }]
				});
			} else if (registered === false) {
				todos.push({
					title: '没有注册到网络',
					note: '当前无法上网。',
					actions: [{ label: '去排查', variant: 'secondary', onClick: gotoDiag }]
				});
			} else if (registered === true && !v4) {
				todos.push({
					title: '已注册但没拿到地址',
					note: '路由器上不去网，客户端也拿不到地址。',
					actions: [{ label: '去排查', variant: 'secondary', onClick: gotoDiag }]
				});
			}
			/* 温度跟排查项用同一档阈值（70 提示 / 85 告警），两处永远一致 */
			if (mt.max != null && mt.max >= 70) {
				todos.push({
					title: '模组温度 ' + mt.max + ' ℃',
					note: mt.max >= 85 ? '已经很高，会降速甚至掉网，先改善通风。' : '偏高，留意散热。',
					actions: [{ label: '去排查', variant: 'secondary', onClick: gotoDiag }]
				});
			}

			var todoNode = Mt5700.todo(todos);
			todoBox.innerHTML = '';
			if (todoNode) todoBox.appendChild(todoNode);

			verdict.update({
				tone: tone,
				eyebrow: [op, rat && rat !== '—' ? rat : '', band].filter(function (x) { return x; }),
				title: title,
				sub: sub,
				chips: [
					{ label: '温度', value: mt.max == null ? '—' : mt.max + ' ℃' },
					{ label: 'APN', value: state.apn },
					{ label: '累计下行', value: (state.flow && state.flow.totalRxFlow != null)
						? AtWs.formatFlow(state.flow.totalRxFlow) : '—' }
				],
				nums: [
					{ label: 'RSRP', value: cell.rsrp, unit: 'dBm', tone: sigTone(cell.rsrp) },
					{ label: 'SINR', value: cell.sinr, unit: 'dB', tone: sigTone(cell.sinr) },
					{ label: '下行', value: down.value, unit: down.unit },
					{ label: '上行', value: up.value, unit: up.unit }
				],
				rail: [
					{
						no: '01', name: '模组', tone: simKnown() ? 'ok' : 'mute',
						text: simKnown() ? '运行正常' : '读取中',
						sub: devState && devState.model ? devState.model : ''
					},
					{
						no: '02', name: 'SIM 卡', tone: simTone,
						text: !simKnown() ? '读取中'
							: (simWarnNow() ? Parse.simShort(devState.sim) : '已就绪'),
						/* 证据行给「是哪张卡」：ICCID 尾 6 位。
						   ★ 不放状态码（1 / 11）—— 那是模组内部枚举，用户无从对照，
						     而 11 在本机是长期正常态，写出来只会被当成故障码。 */
						sub: simKnown() && devState.iccid
							? ('…' + String(devState.iccid).slice(-6)) : ''
					},
					{
						no: '03', name: '网络注册', tone: regTone,
						text: registered === true ? '已注册' : (registered === false ? '未注册' : '读取中'),
						sub: registered === true && band ? band : ''
					},
					{
						no: '04', name: '拨号连接', tone: dialTone,
						text: v4 ? '已连接' : (registered === true ? '未获取地址' : '未开始'),
						sub: v4 ? (v4.address + (gw ? ' / ' + gw : '')) : ''
					}
				]
			});
		}

		/* 环形仪表实例只创建一次，之后每次刷新仅更新数值与弧线 */
		var sigGauges = null;

		function renderSignal() {
			var c = state.cell;
			if (!sigGauges) {
				sigGrid.innerHTML = '';
				sigGauges = {
					rsrp: Mt5700.gauge('RSRP', 'dBm', 'rsrp'),
					rsrq: Mt5700.gauge('RSRQ', 'dB', 'rsrq'),
					sinr: Mt5700.gauge('SINR', 'dB', 'sinr')
				};
				sigGrid.appendChild(sigGauges.rsrp.el);
				sigGrid.appendChild(sigGauges.rsrq.el);
				sigGrid.appendChild(sigGauges.sinr.el);
			}
			sigGauges.rsrp.set(c.rsrp);
			sigGauges.rsrq.set(c.rsrq);
			sigGauges.sinr.set(c.sinr);

			/* KPI 的「信号质量」：数值用 SINR，柱子按等级点亮（与原型一致）。
			   没有读数时不点亮任何一格，也不写 0 —— 0 dB 与「没读到」是两件事。 */
			kpiSinr.set(c.sinr == null || c.sinr === '' ? '—' : c.sinr, 'SINR');
			var barsBox = kpiSinr.el.querySelector('.bars');
			if (barsBox) {
				/* 柱高固定 8 档，点亮格数由 SINR 换算（-5dB→1 格，23dB 以上满格）；
				   SINR 低于 10 时用警示色 —— 与页面里信号仪表的判级口径一致。 */
				var lit = (c.sinr == null || c.sinr === '') ? 0
					: Math.max(1, Math.min(8, Math.round((Number(c.sinr) + 5) / 3.5)));
				var warnTone = (c.sinr != null && Number(c.sinr) < 10);
				var heights = [8, 12, 16, 20, 24, 28, 32, 34];
				barsBox.innerHTML = '';
				for (var bi = 0; bi < 8; bi++) {
					var ib = E('i');
					ib.style.height = heights[bi] + 'px';
					if (bi < lit) ib.className = warnTone ? 'on warn' : 'on';
					barsBox.appendChild(ib);
				}
			}
		}

		/*
		 * 载波与聚合（原「载波聚合」+「辅载波信号」两张卡片合并）
		 *
		 * 数据来源：^HFREQINFO（手册 13.16），NR 支持多 CC（最多 4 个），LTE 只报主小区。
		 *   count     = 上报的载波数
		 *   caActive  = 载波数 > 1，即真正的载波聚合
		 *   dcActive  = ^LENDC? 报 EN-DC 双连接已建立
		 * 三者分开表达，避免把「EN-DC 双连接」与「NR 载波聚合」混为一谈。
		 *
		 * 注意 ^HFREQINFO **不含** RSRP/RSRQ/SINR：主载波行的信号取主小区实时值，
		 * 辅载波行尝试用 ^MONSSC / ^CASCELLINFO 按下行频点对上（本固件分别返回
		 * NONE / ERROR，对不上就是「—」）。表格列与上游快照一致：
		 * 制式 / 频段 / ARFCN / 带宽 / PCI / RSRP / RSRQ / SINR / 强度。
		 * 其中 ARFCN 主载波取 ^MONSC 服务小区频点（对得上手机），见 freqCell 注释。
		 */
		function fmtBw(khz) {
			if (khz == null) return '—';
			return khz >= 1000 ? (khz / 1000) + ' MHz' : khz + ' kHz';
		}
		/* 频段列用 3GPP 标识（n41 / B3），比频率描述更好与工参对照 */
		function bandLabel(sysMode, band) {
			if (band == null) return '—';
			return (sysMode === 'LTE' ? 'B' : 'n') + band;
		}
		/*
		 * 频点列 = ARFCN 数值本身，**不附 MHz 换算**。
		 *
		 * 换算值（504990 → 2524.95 MHz）是派生量，行内再放一个数字反而干扰：
		 * ARFCN 才是与工参、锁频配置、手机工程软件对齐的那个值，给一个就够。
		 * 手机里看到 504990、页面也写 504990，一眼就能对上。
		 *
		 * ★ 取值必须区分「服务小区频点」与「载波中心频点」，两者不是一回事：
		 *   - ^MONSC 的 <channel>（手册 13.9.3 注明是 SSB/服务小区 ARFCN），
		 *     与 ^NRSSBID 的服务小区 ARFCN、手机工程软件显示的都是同一个值；
		 *   - ^HFREQINFO 的 <dl_fcn> 是**载波中心**，13.16 注明「与上下行频点可不一致」。
		 *   本机实测 n41：服务小区 524910 vs 载波中心 528960（60 MHz 载波），
		 *   辅载波 SSB 504990 vs 载波中心 513000（100 MHz 载波），相差几十 MHz 属正常。
		 *   此前本列直接取 <dl_fcn>，用户拿手机一对就以为页面算错了。
		 *
		 * 逐行取哪个值由 renderCarriers 内的 ssbFcn(c) 决定（^MONSC 服务小区 →
		 * ^NRSSBID 邻区配对 → 兜底 <dl_fcn>），本函数只负责渲染成裸值。
		 */
		function freqCell(fcn) {
			if (!fcn) return '—';
			return String(fcn);
		}
		function renderCarriers() {
			carrierBox.innerHTML = '';
			var list = state.carriers || [];
			var count = list.length;
			var c0 = state.cell || {};
			/*
			 * ★ 判据交给 aggregationBadge：NSA 下 count 里含 **LTE 锚点**，
			 *   用 `count > 1` 会把 EN-DC 双连接误报成「2 载波聚合中」
			 *   （2026-09-29 真机：1 LTE + 1 NR）。聚合要同制式内 ≥2 载波。
			 */
			var endc = state.diag && state.diag.endc;
			var dcActive = !!(endc && endc.established);
			var nrCcs = nrCarrierCount(list);
			var caActive = count - nrCcs > 1 || nrCcs > 1;
			var badge = aggregationBadge(count, nrCcs, dcActive);

			/* 头部与上游快照一致：先「当前载波数：N 个」，再聚合状态徽章 */
			var head = E('div', { 'class': 'mt5700-carrier-head' });
			head.appendChild(E('span', { 'class': 'mt5700-carrier-headline' },
				count ? ('当前载波数：' + count + ' 个') : '当前载波数：—'));
			head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' + (caActive || dcActive ? ' is-on' : '') }, badge));

			/* 主小区身份：PLMN / TAC / 小区标识 / PCI。
			   原来这组信息单独占一张表放在「连接状态」里，而这里说的是同一个主小区，
			   两处各说一半；现在合并到一处。注意不收「频点」——逐载波频点本表已有，
			   原先那张表里的"频点"取值其实是 TAC（实测 0x14225C），是标错的。 */
			var idLine = [];
			if (c0.mcc || c0.mnc) idLine.push('PLMN ' + (c0.mcc || '—') + '/' + (c0.mnc || '—'));
			if (c0.lac) idLine.push('TAC ' + hexToDec(c0.lac));
			if (c0.cid) idLine.push('小区 ' + hexToDec(c0.cid));
			if (c0.pci) idLine.push('PCI ' + c0.pci);
			if (idLine.length) {
				carrierBox.appendChild(E('div', {
					'class': 'mt5700-hint',
					'style': 'margin:0 0 10px'
				}, idLine.join(' · ')));
			}

			/* 聚合总带宽：原页面只有逐载波带宽，没有合计，要自己心算。
			   多载波时把下行/上行带宽各自求和给出，一眼知道聚合了多少频谱。 */
			var sumDl = 0, sumUl = 0, hasUl = false;
			list.forEach(function (c) {
				if (c.dlBwKHz) sumDl += Number(c.dlBwKHz) || 0;
				if (!c.downlinkOnly && c.ulBwKHz) {
					sumUl += Number(c.ulBwKHz) || 0;
					hasUl = true;
				}
			});
			if (count > 1 && sumDl > 0) {
				head.appendChild(E('span', { 'class': 'mt5700-carrier-badge is-on' },
					'下行合计 ' + fmtBw(sumDl) + (hasUl ? ' · 上行合计 ' + fmtBw(sumUl) : '')));
			}
			carrierBox.appendChild(head);

			if (!count) {
				carrierBox.appendChild(E('div', { 'class': 'mt5700-hint' },
					'未读到载波信息。^HFREQINFO? 在 RRC null 态不支持查询，会返回错误。'));
				return;
			}

			/* 强度条：量程与等级的唯一真源在 Parse（mt5700.js「信号强度」段的明文纪律）。
			 * 这里原先自算 2*(rsrp+120)，是那份纪律里点名的第二份实现（B12）——
			 * 换成 Mt5700.rsrpBar（内部走 Parse.signalPercent + percentLevel）。 */

			/* ^NRSSBID 邻区按「SSB 频点落在载波下行带宽内」配对；同频有多个邻区时取 RSRP 最强者 */
			function nrssbidMatch(c) {
				var nb = state.nrssbid && state.nrssbid.neighbors;
				if (!nb || !nb.length || c.dlFreqMHz == null || !c.dlBwKHz) return null;
				var halfMHz = c.dlBwKHz / 2000;
				var best = null;
				nb.forEach(function (n) {
					var mhz = Parse.nrArfcnToMHz(n.arfcn);
					if (mhz == null || Math.abs(mhz - c.dlFreqMHz) > halfMHz) return;
					if (!best || (n.rsrp != null && (best.rsrp == null || n.rsrp > best.rsrp))) best = n;
				});
				return best;
			}

			/*
			 * 每个载波行都给 **SSB 频点**——手机工程软件显示的就是它，
			 * 不能拿 ^HFREQINFO 的 <dl_fcn> 顶上（那是载波中心，见 freqCell 注释）。
			 *
			 * 取值优先级：
			 *   1) ^MONSC 的服务小区频点（最权威），前提是它落在该载波的下行带宽内。
			 *      本机实测双载波聚合：^MONSC 报 524910（2624.55 MHz），
			 *      落在 60 MHz 载波（中心 528960 / 2644.8 MHz，带内 2614.8–2674.8）内，
			 *      不落在 100 MHz 载波（中心 513000 / 2565.0 MHz，带内 2515–2615）内
			 *      —— 据此自动认出哪一行是主载波，不依赖 ^HFREQINFO 的行序；
			 *   2) ^NRSSBID 邻区按「SSB 落在载波带宽内」配对（与辅载波信号列同源）。
			 *      本机实测辅载波命中 504990（2524.95 MHz，RSRP -80）；
			 *   3) 都取不到才退回 <dl_fcn>（载波中心），并在提示行明确标注。
			 *
			 * LTE 不参与 1) 和 2)：<channel> 是 EARFCN（各频段偏移不同，没有偏移表，
			 * 不能按 NR 全局栅格换算），^NRSSBID 也只报 NR，故 LTE 行直接用 <dl_fcn>。
			 */
			function ssbFcn(c) {
				if (c.sysMode === 'NR' && c0.channel && c.dlFreqMHz != null && c.dlBwKHz) {
					var m = Parse.nrArfcnToMHz(Number(c0.channel));
					if (m != null && Math.abs(m - c.dlFreqMHz) <= c.dlBwKHz / 2000) {
						return { fcn: Number(c0.channel), from: 'cell' };
					}
				}
				if (c.sysMode !== 'LTE') {
					var nb = nrssbidMatch(c);
					if (nb && nb.arfcn != null) return { fcn: Number(nb.arfcn), from: 'ssbid' };
				}
				return { fcn: c.dlFcn, from: c.dlFcn ? 'center' : 'none' };
			}

			/*
			 * ^NRSSBID 的邻区不带 RSRQ（手册 13.28 的邻区字段只有 PCI/ARFCN/RSRP/SINR
			 * + 波束），而 ^MONNC 报同一小区时是带的。本机实测 4/4 能按
			 * (ARFCN, PCI) 对上，故从这里回填；对不上返回 null 显示「—」，绝不猜值。
			 */
			function monncRsrq(nb) {
				if (!nb || !state.monnc || !state.monnc.length) return null;
				for (var i = 0; i < state.monnc.length; i++) {
					var c = state.monnc[i];
					if (c.rat === 'NR' && c.arfcn === nb.arfcn && c.pci === nb.pci) return c.rsrq;
				}
				return null;
			}

			/*
			 * 信号列数据源：
			 *   主载波  主小区实时值（^MONSC；PCI/TAC 是十六进制，已在解析时换算）
			 *   辅载波  ^NRSSBID 邻区按「SSB 频点落在载波带宽内」配对（无 RSRQ）
			 * 其余数据源（^MONSSC 仅 NSA、^CASCELLINFO 仅 LTE CA）在本机无效，已删除。
			 */
			var usedSsbid = false;
			var centerRows = [];
			var rows = list.map(function (c, i) {
				var sig;
				if (i === 0) {
					sig = { pci: c0.pci || null, rsrp: c0.rsrp, rsrq: c0.rsrq, sinr: c0.sinr };
				} else {
					var nb = nrssbidMatch(c);
					sig = nb ? { pci: nb.pci, rsrp: nb.rsrp, rsrq: monncRsrq(nb), sinr: nb.sinr } : {};
					if (nb) usedSsbid = true;
				}
				/* 见 ssbFcn：取该载波的 SSB 频点，取不到才退回载波中心 */
				var f = ssbFcn(c);
				if (f.from === 'center') centerRows.push(i + 1);
				return [
					c.sysMode || c.kind || '—',
					bandLabel(c.sysMode, c.band),
					freqCell(f.fcn),
					fmtBw(c.dlBwKHz),
					c.downlinkOnly ? '仅下行' : fmtBw(c.ulBwKHz),
					sig.pci != null ? String(sig.pci) : '—',
					sig.rsrp != null ? sig.rsrp + ' dBm' : '—',
					sig.rsrq != null ? sig.rsrq + ' dB' : '—',
					sig.sinr != null ? sig.sinr + ' dB' : '—',
					Mt5700.rsrpBar(sig.rsrp)
				];
			});
			carrierBox.appendChild(Mt5700.table(
				['制式', '频段', 'ARFCN', '下行带宽', '上行带宽', 'PCI', 'RSRP', 'RSRQ', 'SINR', '强度'],
				rows,
				{ striped: true }
			));

			var hint = '载波聚合要等到有数据业务时才会激活，空闲时通常只报主载波。';
			/*
			 * ARFCN 列逐行给的是该载波的 **SSB 频点**，与手机工程软件一致；
			 * ^HFREQINFO 的 <dl_fcn> 是**载波中心**，在 60/100 MHz 带宽下能差几十 MHz
			 * （本机：SSB 524910 vs 载波中心 528960；SSB 504990 vs 载波中心 513000）。
			 * 不写出来，用户拿手机一对就会以为页面算错了（这是真实报障，发生过两次）。
			 */
			hint += ' ARFCN 列取各载波的 SSB 频点（与手机工程软件一致）；'
				+ '^HFREQINFO 的 <dl_fcn> 是载波中心，仅在测不到 SSB 时兜底显示。';
			if (centerRows.length) {
				hint += ' 第 ' + centerRows.join('、') + ' 载波本轮没测到 SSB 频点，'
					+ '显示的是载波中心，与手机的数值会对不上。';
			}
			if (usedSsbid) {
				hint += ' 辅载波 PCI/RSRP/SINR 来自 ^NRSSBID 邻区测量（按频点配对），'
					+ 'RSRQ 由 ^MONNC 按 ARFCN+PCI 关联回填（^NRSSBID 邻区不带 RSRQ）。';
			} else if (list.length > 1) {
				/*
				 * ^NRSSBID 只报「按波束能量排序的前 4 个」小区，辅载波上的小区
				 * 常常排不进去（本机 9 次采样里只有 1 次命中）。此时整行空白容易被
				 * 误读成「没刷新」，必须把原因写出来。
				 */
				hint += ' 当前 ^NRSSBID 的前 4 强邻区都不在辅载波频带内，故辅载波信号列为空——'
					+ '这是该命令只报 4 个小区的固有局限，不是刷新失败。';
			}
			if (slowFailures.loadSecondary) {
				hint += ' 注意：本轮辅载波数据拉取失败（已保留上一次读数）。';
			}
			carrierBox.appendChild(E('div', { 'class': 'mt5700-hint' }, hint));

		}

		/* ---------- 连接明细（连接诊断 + 地址与 DNS，两张表合并） ----------
		 *
		 * 三张表的行本来都是「项目 → 值」，拆开只是多出两行表头、把同类信息切三刀。
		 * 合并后按分组标题行分隔，并砍掉两列：
		 *   - CID  ：PDP 上下文编号（本机 1=IPv4、5=IPv6），用户无从干预；
		 *   - 来源 ：AT+CGPADDR 与 AT^DHCP? 给的是**同一个地址**，标了来源反而
		 *            让人以为有两份地址（2026-09-18 实测两者完全相同）。
		 */

		function buildDiagRows() {
			var d = state.diag;
			var endcTag = '不适用';
			if (d.endc) {
				if (d.endc.established) endcTag = '已建立';
				else if (!d.endc.available) endcTag = '小区不支持';
				else if (!d.endc.plmnAvailable) endcTag = '运营商未开通';
				else if (d.endc.restricted) endcTag = '网络侧受限';
				else endcTag = '支持但未建立';
			}
			var regVal = d.reg ? (d.reg.statText + (d.reg.act ? ' · ' + d.reg.act : '')) : '未注册 5GC';
			var rows = [
				['ENDC 双连接', endcTag],
				['5G 核心网注册', regVal],
				/* TAC / 小区 / PCI / 频点 已在「注册与运营商」表里给出，此处不再重复 */
				['网络切片', d.reg && d.reg.nssai ? d.reg.nssai : '—']
			].filter(function (r) {
				/* 取不到数据的项直接不显示：一排「—」「不适用」只占版面、没有信息量 */
				return r[1] && r[1] !== '—' && r[1] !== '不适用';
			});
			if (d.creg) rows.push(['4G(EPS) 注册', d.creg.statText]);
			/*
			 * ★ 原先是 `d.cireg.info ? '（VoLTE/VoNR/IMS 短信可用）' : '（语音/IMS 短信不可用）'`，
			 *   两处都是谎报：
			 *   ① `info === 1` 只表示「IMS 已注册」，**不等于**语音/短信能力可用 ——
			 *      能开什么要看 `ext_info`（IMS 域能力值，手册 7.6）。注册上了但能力值里
			 *      没有 voice，「IMS 注册 OK 但打不了 VoLTE」是真实存在的故障态，
			 *      旧文案会把它报成可用。
			 *   ② 反过来，`info === null`（固件回了十六进制之类解析不了）时走进 else，
			 *      直接甩一句「语音/IMS 短信不可用」—— 那是把「我没读明白」说成「你不能用」。
			 *   现在的口径：能定的才定，定不了就写明「未上报 / 无法判定」。
			 */
			if (d.cireg) {
				var t = d.cireg.text;
				if (d.cireg.info === 1) {
					t += d.cireg.ext ? ('（IMS 能力值 ' + d.cireg.ext + '）') : '（IMS 能力值未上报）';
				} else if (d.cireg.info !== 0) {
					t += '（可用性无法判定）';
				}
				rows.push(['IMS 注册', t]);
			}
			if (d.rrc) rows.push(['RRC 状态', d.rrc.rrcText + (d.rrc.campText ? ' · ' + d.rrc.campText : '')]);
			if (d.cops) {
				var copsTxt = d.cops.modeText + (d.cops.oper ? ' · ' + d.cops.oper : '');
				if (d.cops.actText) copsTxt += ' · ' + d.cops.actText;
				rows.push(['选网模式', copsTxt]);
			}
			(d.nrTx || []).forEach(function (c, i) {
				rows.push(['NR CC' + (i + 1) + ' PUSCH', dash(c.pusch, ' dBm') + (c.freq ? ' · ' + (c.freq / 1000).toFixed(1) + ' MHz' : '')]);
			});
			return rows;
		}

		/* 地址去重：三个来源会给**同一个地址**：
		 *   ① AT+CGPADDR  PDP 上下文地址（CID 1 → IPv4，CID 5 → IPv6）
		 *   ② AT^DHCP?    运营商 DHCP 下发的 IPv4（本机与 CID 1 完全相同）
		 *   ③ AT^DHCPV6?  IPv6 地址/前缀（本机该命令直接 ERROR，取不到）
		 * 按（类型 + 地址）做键合并，一行只留一个地址。 */
		function addrKey(family, addr) {
			var v = String(addr == null ? '' : addr).trim().toLowerCase();
			return v ? (family + '|' + v) : '';
		}

		function buildAddrList() {
			var map = {};
			var order = [];
			function add(addr, family, cid) {
				var key = addrKey(family, addr);
				if (!key) return;
				var e = map[key];
				if (!e) {
					e = map[key] = { address: String(addr).trim(), family: family, cids: [] };
					order.push(e);
				}
				if (cid != null && e.cids.indexOf(cid) < 0) e.cids.push(cid);
			}
			(state.diag.addrs || []).forEach(function (a) { add(a.address, a.family, a.cid); });
			if (state.dhcpv4 && state.dhcpv4.ipv4Address) add(state.dhcpv4.ipv4Address, 'IPv4', null);
			if (state.dhcpv6 && state.dhcpv6.ipv6Address) add(state.dhcpv6.ipv6Address, 'IPv6', null);

			order.sort(function (a, b) {
				if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1;
				var ac = a.cids.length ? a.cids[0] : 99;
				var bc = b.cids.length ? b.cids[0] : 99;
				return ac - bc;
			});
			return order;
		}

		function buildAddrRows() {
			return buildAddrList().map(function (e) {
				/* 类型并进项目名（「IPv4 地址」），不再单独占一列 */
				return [e.family + ' 地址', e.address];
			});
		}

		function buildDhcpRows() {
			var rows = [];
			var v4 = state.dhcpv4, v6 = state.dhcpv6;
			if (v4) {
				/* IPv4/IPv6 地址本身不在这里重复：已并进上方「地址」分组 */
				rows.push(['子网掩码', v4.subnetMask]);
				rows.push(['网关', v4.gateway]);
				rows.push(['DHCP 服务器', v4.dhcpServer]);
				rows.push(['主 DNS', dnsCell(0, v4.primaryDNS)]);
				rows.push(['备 DNS', dnsCell(1, v4.secondaryDNS)]);
			}
			if (v6) {
				rows.push(['IPv6 前缀', v6.netmask]);
				rows.push(['IPv6 网关', v6.gateway]);
				rows.push(['IPv6 DNS', v6.primaryDNS + ' / ' + v6.secondaryDNS]);
			}
			if (state.ipv6Cap) rows.push(['IPv6 支持', state.ipv6Cap.description]);
			return rows;
		}

		function renderConnDetail() {
			if (!connDetailBox) return;
			connDetailBox.innerHTML = '';
			var rows = [];
			function pushGroup(title, list) {
				if (!list.length) return;   /* 整组没数据就别留一个空标题 */
				rows.push({ group: title });
				list.forEach(function (r) { rows.push(r); });
			}
			pushGroup('连接诊断', buildDiagRows());
			pushGroup('地址与 DNS', buildAddrRows().concat(buildDhcpRows()));
			if (!rows.length) {
				connDetailBox.appendChild(E('div', { 'class': 'mt5700-hint' }, '暂无连接明细数据。'));
				return;
			}
			connDetailBox.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
			if (dnsEditable) {
				connDetailBox.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'点击「主 DNS / 备 DNS」可修改，写入 network.' + netIface +
					'.dns 并重新连接网络（短暂断网）；两项都留空即恢复运营商下发的 DNS。'));
			}
		}


		/*
		 * 两个面板的渲染互相独立，各自只认自己的数据源：
		 *   - renderConn()  连「连接状态」面板，取签约速率（kbps）
		 *   - renderSpeed() 连「实时速率」面板，取接口实时速率（字节/秒）
		 * 早期版本两者共用一组变量，导致签约速率会盖掉实时速率、反之亦然。
		 */
		function renderSpeed() {
			speedRow.innerHTML = '';
			if (!rateOn) {
				speedRow.appendChild(Mt5700.speedBox('↓ 下行', '—'));
				speedRow.appendChild(Mt5700.speedBox('↑ 上行', '—'));
				chart.innerHTML = '';
				chart.appendChild(E('div', { 'class': 'mt5700-hint' },
					'实时速率监测已关闭（不再每秒读取接口计数器）；累计流量统计仍会自动刷新。'));
				kpiDown.set('—', '');
				kpiUp.set('—', '');
				sparkDown.set([]);
				sparkUp.set([]);
				return;
			}
			var d = splitSpeedUI(state.rtDown, 'bytes');
			var u = splitSpeedUI(state.rtUp, 'bytes');
			speedRow.appendChild(Mt5700.speedBox('↓ 下行', d.value + ' ' + d.unit));
			speedRow.appendChild(Mt5700.speedBox('↑ 上行', u.value + ' ' + u.unit));

			/* KPI 跟随同一次采样，不额外读接口。趋势线按本段监测的峰值归一化，
			   这样空口速度变化才看得出来（绝对值归一会被一两个尖峰压成全 0）。 */
			kpiDown.set(d.value, d.unit);
			kpiUp.set(u.value, u.unit);
			var maxD = 0, maxU = 0, i;
			for (i = 0; i < history.length; i++) {
				if (history[i].down > maxD) maxD = history[i].down;
				if (history[i].up > maxU) maxU = history[i].up;
			}
			sparkDown.set(history.map(function (h) { return maxD ? h.down / maxD : 0; }));
			sparkUp.set(history.map(function (h) { return maxU ? h.up / maxU : 0; }));

			renderChart();
		}

		/*
		 * 把速率值格式化为 {value, unit}。
		 * unitMode：
		 *   'kbps'  —— 输入单位是 kbps（比特），直接乘 1000 得 bps（签约速率）；
		 *   'bytes' —— 输入单位是字节/秒，乘 8 得 bps（接口实时速率）。
		 */
		function splitSpeedUI(value, unitMode) {
			var bits = (unitMode === 'kbps') ? (value * 1000) : (value * 8);
			if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps' };
			if (bits >= 1e6) return { value: (bits / 1e6).toFixed(2), unit: 'Mbps' };
			if (bits >= 1e3) return { value: (bits / 1e3).toFixed(2), unit: 'Kbps' };
			return { value: String(Math.round(bits)), unit: 'bps' };
		}

		/*
		 * ★ 图表宽度缓存（性能）：
		 *   renderChart() 每秒被 renderSpeed() 调一次。原实现是
		 *   `chart.innerHTML = ''` 之后立刻读 `chart.clientWidth` —— 按 MDN 对
		 *   「强制同步布局（forced synchronous layout / layout thrashing）」的说明，
		 *   读取 clientWidth 这类布局属性会迫使浏览器**立刻**完成挂起的样式重算与布局，
		 *   而上一行刚把子树作废。于是每秒都在「作废布局 → 马上算回来」，是教科书式的
		 *   反向优化；1Hz 下它还会和页面其它重绘抢主线程。
		 *   失效源用 ResizeObserver 而不是 window.resize：容器宽度还会因为
		 *   垂直滚动条出现/消失、断点切换、侧栏折叠而变化，这些**不一定**派发
		 *   window resize（只认 resize 等于把「宽度只随窗口变化」当成了既定事实）。
		 *   不支持 RO 的老浏览器退回 resize，功能不打折。
		 */
		var chartWidth = 0;
		var chartRO = null;
		var onResize = function () { chartWidth = 0; };
		if (typeof ResizeObserver === 'function') {
			chartRO = new ResizeObserver(onResize);
			chartRO.observe(chart);
		} else {
			window.addEventListener('resize', onResize);
		}

		function renderChart() {
			/* 不可见时不做重建：切后台那一刻在飞的 netRate 回来后仍会走到这里，
			   在看不见的页面里做一次完整子树重建纯属浪费。 */
			if (document.hidden) return;
			chart.innerHTML = '';
			if (!history.length) {
				chart.appendChild(Mt5700.empty('等待数据…'));
				return;
			}
			/* 只在缓存未命中时读一次布局属性。还没上屏时 clientWidth 为 0，
			   此时**不缓存**（免得把兜底的 600 当成真实宽度记住），
			   上屏后由 RO 的首次回调让它失效、下一拍重新量准。 */
			if (!chartWidth) {
				var measured = chart.clientWidth;
				if (measured) chartWidth = measured;
			}
			chart.appendChild(Mt5700.lineChart(history, {
				width: chartWidth || 600,
				height: 140,
				tipFormat: function (p) {
					var d = splitSpeedUI(p.down || 0, 'bytes');
					var u = splitSpeedUI(p.up || 0, 'bytes');
					return '↓ ' + d.value + ' ' + d.unit + ' · ↑ ' + u.value + ' ' + u.unit;
				}
			}));
		}

		function renderFlow() {
			flowGrid.innerHTML = '';
			var f = state.flow || {};
			/* 取不到时统一显示「—」而不是「NaN」：
			   清零成功后若重读失败，state.flow 会被置空，此时若照旧渲染旧数字，
			   用户会以为「没清成功」—— 那才是误报。
			   （AtWs.formatFlow(undefined) 会算出 "NaN TB"，所以必须在这一层挡掉。） */
			function durText(v, showDays) { return v == null ? '—' : AtWs.formatDuration(v, showDays); }
			function flowText(v) { return v == null ? '—' : AtWs.formatFlow(v); }
			/* 峰值是「本轮实时监测」内的最大值（关掉监测再开即归零），
			   单位与 rtDown/rtUp、state.peakDown/peakUp 一致（字节/秒），显示同样走 splitSpeedUI。 */
			function peakText(bps) {
				if (!bps) return '—';
				var s = splitSpeedUI(bps, 'bytes');
				return s.value + ' ' + s.unit;
			}
			[
				{ label: '当前会话时长', value: durText(f.lastDsTime, false) },
				{ label: '当前下行流量', value: flowText(f.lastRxFlow) },
				{ label: '当前上行流量', value: flowText(f.lastTxFlow) },
				{ label: '累计时长', value: durText(f.totalDsTime, true) },
				{ label: '累计下行', value: flowText(f.totalRxFlow) },
				{ label: '累计上行', value: flowText(f.totalTxFlow) },
				{ label: '峰值下行', value: peakText(state.peakDown) },
				{ label: '峰值上行', value: peakText(state.peakUp) }
			].forEach(function (it) {
				flowGrid.appendChild(Mt5700.metric(it.label, it.value));
			});

			/* KPI「本月流量」：累计收 + 发，副标题给本次会话。取不到就写「—」，
			   不能写 0（见上面注释：0 与「没读到」必须区分）。 */
			var totB = (f.totalRxFlow == null && f.totalTxFlow == null) ? null
				: (Number(f.totalRxFlow || 0) + Number(f.totalTxFlow || 0));
			var curB = (f.lastRxFlow == null && f.lastTxFlow == null) ? null
				: (Number(f.lastRxFlow || 0) + Number(f.lastTxFlow || 0));
			if (totB == null) {
				kpiFlow.set('—', '', '');
			} else {
				var fs = AtWs.formatFlow(totB).split(' ');
				kpiFlow.set(fs[0], fs[1] || '', curB == null ? '' : '本次会话 ' + AtWs.formatFlow(curB));
			}
		}

		function renderTemp() {
			/* 各路温度已并入「SIM 与设备」卡的那一张表（见 renderDevCard），
			   这里只触发重绘，不再单独占一块磁贴区。 */
			renderDevCard();
		}

		/* ---------- 自定义 DNS（UCI network.<iface>.dns） ----------
		 *
		 * ★ 必须先分清两个「DNS」来源，否则改完会发现界面没变化：
		 *   ① 表格里的「主/备 DNS」原本来自 AT^DHCP? —— 那是**运营商通过 DHCP 下发的**，
		 *      模组自己报的，改 UCI 不会让它变。
		 *   ② 真正能改的是 UCI 里 network.<iface>.dns 的静态项，由 netifd 写入
		 *      /tmp/resolv.conf.d/resolv.conf.auto，优先级高于运营商下发的。
		 *   所以显示值取「自定义 ?? 运营商下发」，改完显示立刻跟着自定义项走。
		 *
		 * 接口名的来源：原先读服务配置页里那个「监控接口」UCI 键，
		 * 但连接看门狗功能已于 2026-09-20 整体移除，那个键随之删除，
		 * 继续读只会恒为空、静默退回默认值。改为从 network 配置自己反查，
		 * 见 detectNetIface。
		 *
		 * 权限：rpcd ACL 的 uci 读写白名单必须含 network，否则 L.uci.load 会被拒。
		 * 被拒时这里**静默降级为只读**（dnsEditable=false），页面其余部分照常工作 ——
		 * 老版本 ACL 的机器上不会出现报错或空白。
		 */
		var netIface = 'MT5700M';

		/*
		 * 反查模组所在的逻辑接口名。
		 *
		 * ① 本机默认就叫 MT5700M，命中直接返回 —— 绝大多数情况走这条，零风险。
		 * ② 改名过的场景兜底：取 device 形如 ethN 的那个（模组是 USB 网口，
		 *    LAN 侧通常是 br-lan / 交换机端口，不会是 ethN 这种裸设备名）。
		 * ③ 全都拿不到（ACL 拒绝、旧版 uci 没有 sections）→ 回退 MT5700M。
		 *
		 * ★ 只做**读**判断，不会写 network；这里选错接口会导致 DNS 改到别的
		 *   接口上，所以宁可回退默认也不要瞎猜。
		 */
		function detectNetIface() {
			var fallback = 'MT5700M';
			try {
				var secs = (L.uci && L.uci.sections) ? (L.uci.sections('network', 'interface') || []) : [];
				var i, name;
				for (i = 0; i < secs.length; i++) {
					name = secs[i]['.name'];
					if (name === fallback) return fallback;
				}
				for (i = 0; i < secs.length; i++) {
					if (/^eth\d+$/.test(String(secs[i].device || '').trim())) return secs[i]['.name'];
				}
			} catch (e) { /* 读不到就用默认值，不影响页面其余部分 */ }
			return fallback;
		}

		var dnsCustom = [];      /* UCI 已配置的自定义 DNS：[主, 备] */
		var dnsEditable = false; /* ACL 允许写 network 才为 true */

		function isIPv4(v) {
			var p = String(v).trim().split('.');
			if (p.length !== 4) return false;
			for (var i = 0; i < 4; i++) {
				if (!/^\d{1,3}$/.test(p[i])) return false;
				var n = parseInt(p[i], 10);
				if (isNaN(n) || n < 0 || n > 255) return false;
			}
			return true;
		}

		function loadDnsConfig() {
			if (!L.uci || !L.uci.load) return Promise.resolve();
			return L.uci.load('network').then(function () {
				netIface = detectNetIface();
				var dns = L.uci.get('network', netIface, 'dns');
				dnsCustom = Array.isArray(dns) ? dns.slice(0, 2)
					: (dns ? String(dns).split(/\s+/).filter(Boolean).slice(0, 2) : []);
				dnsEditable = true;
			}).catch(function () {
				dnsEditable = false;
				dnsCustom = [];
			});
		}

		/* 保存自定义 DNS：写 UCI → save → apply。
		 * apply 会触发 netifd reload，接口重新协商（**短暂断网**），
		 * 所以按钮文案直接写明「会重连」，不另加确认弹窗（用户偏好少拦一层）。
		 * 两项都清空 = 删掉 dns 项并把 peerdns 还原成 1，彻底交回运营商下发。 */
		function saveDns(list) {
			var cfg = 'network', sec = netIface;
			if (list.length) {
				L.uci.set(cfg, sec, 'dns', list);
				/* peerdns=0：只认用户填的，避免「主/备」语义被下发的 DNS 冲淡 */
				L.uci.set(cfg, sec, 'peerdns', '0');
			} else {
				if (L.uci.unset) L.uci.unset(cfg, sec, 'dns');
				else L.uci.set(cfg, sec, 'dns', '');
				L.uci.set(cfg, sec, 'peerdns', '1');
			}
			AtWs.uci.markDirty();
			return AtWs.uci.uciSave('network').then(function () {
				dnsCustom = list;
				AtWs.uci.clearDirty();
				Mt5700.info('已保存并应用，网络正在重连');
			}, function (err) {
				AtWs.uci.clearDirty();
				Mt5700.error('保存失败：' + ((err && err.message) || '未知错误'));
				throw err;
			});
		}

		/* 单元格：常态显示值（自定义优先）＋「自定义」徽章；可编辑时点击变输入框 */
		function dnsCell(idx, peerValue) {
			var custom = dnsCustom[idx] || '';
			var wrap = E('span', { 'class': 'mt5700-dns-cell' });
			wrap.appendChild(E('span', { 'class': 'mt5700-dns-value' }, custom || peerValue || '—'));
			if (custom) wrap.appendChild(Mt5700.badge('自定义', 'primary'));
			if (!dnsEditable) return wrap;   /* 老版本 ACL：只读，不给点击假象 */
			wrap.classList.add('is-editable');
			wrap.title = '点击修改（保存会重新连接网络）';
			wrap.addEventListener('click', function () {
				startDnsEdit(wrap, idx, custom || '');
			});
			return wrap;
		}

		function startDnsEdit(cell, idx, current) {
			var form = E('span', { 'class': 'mt5700-dns-edit' });
			var input = Mt5700.input('text', current);
			input.value = current;
			input.setAttribute('placeholder', '留空=恢复自动');
			input.style.width = '132px';

			var finish = function () { renderConnDetail(); };
			var commit = function () {
				var v = input.value.trim();
				if (v && !isIPv4(v)) {
					Mt5700.error('请填 IPv4 地址，例如 223.5.5.5（留空表示恢复运营商下发）');
					return;
				}
				var next = dnsCustom.slice();
				next[idx] = v;
				var list = next.filter(Boolean);   /* 主空备非空时，备自动前提 */
				input.disabled = true;
				saveDns(list).then(finish, finish);
			};

			input.addEventListener('keydown', function (ev) {
				if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
				else if (ev.key === 'Escape') { ev.preventDefault(); finish(); }
			});
			form.appendChild(input);
			form.appendChild(Mt5700.primaryButton('保存并应用', commit));
			form.appendChild(Mt5700.ghostButton('取消', finish));
			cell.parentNode.replaceChild(form, cell);
			input.focus();
			input.select();
		}

		/* 调制方式展示：256QAM MCS 27 · 1 层（大小写与格式固定） */
		function mcsDisplay(m) {
			if (!m || m.mcs == null) return '—';
			var mod = Parse.mcsModulation(m.mcs);
			var txt = (mod ? mod + ' ' : '') + 'MCS ' + m.mcs;
			if (m.rank) txt += ' · ' + m.rank + ' 层';
			return txt;
		}

		function renderMCS() {
			mcsGrid.innerHTML = '';
			var dl = state.downlinkMCS, ul = state.uplinkMCS;
			[
				/* 信号强度百分比由 PS 状态解析得到（state.cell.signalPercent），
				   之前只存不用 —— 环形仪表给的是 dBm 绝对值，这里补一个直观的百分比。 */
				{ label: '信号强度', value: state.cell.signalPercent || '—' },
				{ label: '下行调制', value: mcsDisplay(dl) },
				{ label: '上行调制', value: mcsDisplay(ul) }
			].forEach(function (it) {
				mcsGrid.appendChild(Mt5700.metric(it.label, it.value));
			});
		}

		/* ---------- 数据获取 ---------- */

		function resolveActiveCid(force) {
			if (!force && state.activeCid !== null) return Promise.resolve(state.activeCid);
			return AtWs.client.sendCommand('AT+CGACT?').then(function (res) {
				if (!res.success || !res.data) return state.activeCid;
				var active = [];
				AtWs.extractATDataMultiline(res.data, '+CGACT').forEach(function (row) {
					var p = row.split(',');
					if (p[1] && p[1].trim() === '1' && Number(p[0]) > 0) active.push(Number(p[0]));
				});
				state.activeCid = active.length ? Math.min.apply(null, active) : null;
				return state.activeCid;
			});
		}

		function getPSReg() {
			return AtWs.client.sendCommand('AT+CGREG?').then(function (res) {
				if (res.success && res.data) {
					var stat = null;
					AtWs.extractATDataMultiline(res.data, '+CGREG').forEach(function (row) {
						var p = row.split(',');
						if (p.length >= 2) stat = p[1].trim();
					});
					/* 原始码单独存一份：网络制式要靠它判断「有没有真的驻留上」，
					   只留文案的话只能去做字符串比较，一改文案就失效。 */
					state.psRegStat = normStat(stat);
					state.networkStatus = AtWs.psRegText(stat);
				}
			}).then(function () {
				/*
				 * EPS 注册状态（AT+CEREG）：**5G 模组以它为准**。
				 * CGREG 是 2G/3G 的 GPRS 注册口径，纯 LTE/NR 的模组上它可能恒报 0，
				 * 单看它会把「已驻留 LTE」误判成没服务；反过来单看 CGREG 又会在
				 * NR-only 场景漏判。所以两条都取，判定顺序见 hasAnyPsService。
				 * 拿不到就留 null（= 未知），绝不拿 0 冒充「未注册」。
				 */
				return AtWs.client.sendCommand('AT+CEREG?').then(function (res) {
					if (res.success && res.data) {
						var stat = null;
						AtWs.extractATDataMultiline(res.data, '+CEREG').forEach(function (row) {
							var p = row.split(',');
							if (p.length >= 2) stat = p[1].trim();
						});
						state.psRegStatEps = normStat(stat);
					}
				});
			});
		}

		function getOperator() {
			return AtWs.client.sendCommand('AT^EONS=2').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^EONS');
					var code = str ? (str.split(',')[1] || '').trim().replace(/"/g, '') : '';
					state.operator = AtWs.operatorFromCode(code);
				}
			});
		}

		function getAMBR() {
			return resolveActiveCid().then(function (cid) {
				var candidates = [];
				if (cid && cid > 0) candidates.push(cid);
				candidates.push(1);
				var unique = candidates.filter(function (v, i, a) { return a.indexOf(v) === i; });
				var chain = Promise.resolve();
				unique.forEach(function (candidate) {
					chain = chain.then(function () {
						return AtWs.client.sendCommand('AT^DSAMBR=' + candidate).then(function (res) {
							if (!res.success || !res.data) return;
							var str = AtWs.extractATData(res.data, '^DSAMBR');
							if (!str) return;
							var parts = str.split(',');
							/*
							 * 手册 16.17 节：^DSAMBR: <cid>,<DlApnAmbr>,<UlApnAmbr>
							 *   DlApnAmbr / UlApnAmbr 均为 kbps（不是 bps、更不是字节）。
							 * 故此处保留 kbps 原值，并把单位口径标记为 'kbps'，
							 * 由 splitSpeedUI 按 kbps→bps（×1000）换算，
							 * 绝不能再走字节口径的 ×8（那会把 102.4 Mbps 显示成 819 bps）。
							 */
							if (parts.length >= 3) {
								state.ambrDown = parseInt(parts[1], 10) || 0;
								state.ambrUp = parseInt(parts[2], 10) || 0;
							}
							/*
							 * 第 4 个字段（索引 3）在手册标准格式中并不存在，
							 * 属部分固件版本的扩展字段且语义为 APN 字符串。
							 * 仅当它确实是「带引号的字符串」时才采信；若是纯数字
							 * （其他固件可能在此处返回计数值）则忽略，避免把数字当 APN。
							 */
							if (parts.length >= 4) {
								var apnRaw = parts[3].trim();
								if (/^".*"$/.test(apnRaw) || /^'.*'$/.test(apnRaw)) {
									state.apn = apnRaw.replace(/^["']|["']$/g, '') || '未知';
								}
							}
							throw 'done';
						}).catch(function (e) {
							if (e === 'done') return Promise.reject('break');
							return Promise.resolve();
						});
					});
				});
				return chain.catch(function (e) {
					/*
					 * ★ 2026-09-28 修：原来这里写的是
					 *     if (e === 'break') { …已找到… }   ← 里面是空语句
					 *     state.activeCid = null;
					 *   —— 那个 if 是**空语句**，清空写在它之外、**无条件执行**。
					 *   后果：resolveActiveCid() 的缓存判据是
					 *   `if (!force && state.activeCid !== null) return state.activeCid;`，
					 *   而每次 getAMBR 跑完都把它置 null，于是 getAMBR / getQCI 下一轮
					 *   又要重查一次 AT+CGACT?。慢档 30s 一轮，等于每轮白搭 1~2 条
					 *   串口往返 —— 而那句注释的本意显然是「已找到就保留」。
					 */
					if (e === 'break') return;   /* 已找到：保留 activeCid 作为缓存 */
					state.activeCid = null;
				}).then(renderConn);
			});
		}

		function getQCI() {
			return resolveActiveCid().then(function (cid) {
				return AtWs.client.sendCommand('AT+CGEQOSRDP').then(function (res) {
					if ((!res.success || !res.data) && cid) return AtWs.client.sendCommand('AT+CGEQOSRDP=' + cid);
					return res;
				}).then(function (res) {
					if (!res.success || !res.data) return;
					var rows = AtWs.extractATDataMultiline(res.data, '+CGEQOSRDP');
					var row = null;
					if (cid !== null) {
						for (var i = 0; i < rows.length; i++) {
							if (Number(rows[i].split(',')[0]) === cid) { row = rows[i]; break; }
						}
					}
					if (!row && rows.length) row = rows[0];
					if (row) state.qci = AtWs.qciLabel(row.split(',')[1] ? row.split(',')[1].trim() : '');
				});
			}).then(renderConn);
		}

		function getDHCP() {
			/* ★ attempts: 1 —— 实测（2026-09-18，走 8765 与前端同一通道）23 条只读命令里
			   AT^DHCPV6? 是**唯一恒定失败**的一条（本机本来就没有 IPv6），
			   其余 22 条全部 OK。它是「确定性失败」而不是「偶发 ERROR」，
			   默认 3 次重试 + 200/400ms 退避纯属白跑：每轮慢档刷新要多吃约 1.5s 串口时间，
			   而且这条命令排在链里，会把它后面所有读数一起推后。
			   降到 1 次不改变任何界面语义 —— 失败仍由 slowFailures 静默兜住；
			   将来真开通 IPv6 时，1 次尝试照样能成功（成功路径本来就不依赖重试）。 */
			return AtWs.client.sendCommand('AT^DHCPV6?', { attempts: 1 }).then(function (v6) {
				if (v6.success && v6.data) {
					var str = AtWs.extractATData(v6.data, '^DHCPV6');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.dhcpv6 = {
								ipv6Address: d[0].trim(), netmask: d[1].trim(), gateway: d[2].trim(),
								dhcpServer: d[3].trim(), primaryDNS: d[4].trim(), secondaryDNS: d[5].trim()
							};
						}
					}
				}
				return AtWs.client.sendCommand('AT^DHCP?');
			}).then(function (v4) {
				if (v4.success && v4.data) {
					var str = AtWs.extractATData(v4.data, '^DHCP');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.dhcpv4 = {
								ipv4Address: AtWs.hexToIP(d[0].trim()), subnetMask: AtWs.hexToIP(d[1].trim()),
								gateway: AtWs.hexToIP(d[2].trim()), dhcpServer: AtWs.hexToIP(d[3].trim()),
								primaryDNS: AtWs.hexToIP(d[4].trim()), secondaryDNS: AtWs.hexToIP(d[5].trim())
							};
						}
					}
				}
				return AtWs.client.sendCommand('AT^IPV6CAP?');
			}).then(function (cap) {
				if (cap.success && cap.data) {
					var str = AtWs.extractATData(cap.data, '^IPV6CAP');
					if (str) {
						var value = parseInt(str.trim(), 10);
						if (!isNaN(value)) state.ipv6Cap = { capValue: value, description: Parse.ipv6CapDescription(value) };
					}
				}
				/* 地址表吃 dhcpv4/dhcpv6，DHCP 拿到新值后要跟着重绘（它与 PDP 地址去重合并） */
			}).then(function () {
				renderConnDetail();
			});
		}

		function getFlow() {
			return AtWs.client.sendCommand('AT^DSFLOWQRY').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^DSFLOWQRY');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.flow = {
								lastDsTime: AtWs.parseHexValue(d[0]), lastTxFlow: AtWs.parseHexValue(d[1]),
								lastRxFlow: AtWs.parseHexValue(d[2]), totalDsTime: AtWs.parseHexValue(d[3]),
								totalTxFlow: AtWs.parseHexValue(d[4]), totalRxFlow: AtWs.parseHexValue(d[5])
							};
							renderFlow();
						}
					}
				}
			});
		}

		function getTemp() {
			return AtWs.client.sendCommand('AT^CHIPTEMP?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseCHIPTEMP(res.data);
					if (parsed) { state.temps = parsed; renderTemp(); }
				}
			});
		}

		function getMCS() {
			return AtWs.client.sendCommand('AT^MCS=1').then(function (dl) {
				if (dl.success && dl.data) state.downlinkMCS = Parse.parseMCS(dl.data);
				return AtWs.client.sendCommand('AT^MCS=0');
			}).then(function (ul) {
				if (ul.success && ul.data) state.uplinkMCS = Parse.parseMCS(ul.data);
				renderMCS();
		loadDeviceInfo();
			});
		}

		/*
		 * ^MONSC 的 LTE 布局**不带 SINR**（手册 13.9.3：<RSRP>,<RSRQ>,<RSSI>，
		 * 末位是 RSSI 工程值），所以 4G 下 SINR 只能由 ^HCSQ 补。
		 *
		 * 旧实现把补查条件写成「^HFREQINFO 一条载波都没返回」——而 4G 下
		 * ^HFREQINFO 正常返回 LTE 载波，条件恒不成立，**4G（含漫游回落）的
		 * SINR 永远是「—」**。现在改成「三项里有缺就补一次」。
		 *
		 * 只填空缺、不覆盖：^MONSC 是服务小区的实测值，^HCSQ 是模组侧的量，
		 * NR 下两者本来就有 1~2 dB 的差（实测 -65/28 对 -63/27.2），让 ^MONSC 优先。
		 */
		function fillSignalFromHCSQ() {
			if (state.cell.rsrp != null && state.cell.rsrq != null && state.cell.sinr != null) {
				return Promise.resolve();
			}
			return AtWs.client.sendCommand('AT^HCSQ?').then(function (hcsq) {
				var h = hcsq.success && hcsq.data ? AtWs.parseHCSQ(hcsq.data) : null;
				if (!h) return;
				/*
				 * 制式刚切的那一轮，^HCSQ 可能还报旧制式的值（漫游时 5G↔4G 来回
				 * 重选很频繁）。与 ^MONSC 报的制式不一致时不采信，等下一轮刷新对齐：
				 * 拿 NR 的 SINR 填进 LTE 那一栏，比留空更误导。
				 */
				if (h.networkMode && state.cell.sysMode && state.cell.sysMode !== '未知'
					&& h.networkMode !== state.cell.sysMode) return;
				if (state.cell.rsrp == null) state.cell.rsrp = h.rsrp;
				if (state.cell.rsrq == null) state.cell.rsrq = h.rsrq;
				if (state.cell.sinr == null) state.cell.sinr = h.sinr;
			}).catch(function () {
				/* 补查只是填空：失败就保持 ^MONSC 的结果，下一轮刷新会再试 */
			});
		}

		function updateNetworkInfo() {
			var carriers = [];
			return AtWs.client.sendCommand('AT^MONSC').then(function (monsc) {
				var serving = monsc.success && monsc.data ? AtWs.parseMONSC(monsc.data) : null;
				return AtWs.client.sendCommand('AT^HFREQINFO?').then(function (hfreq) {
					carriers = hfreq.success && hfreq.data ? AtWs.parseHFREQINFO(hfreq.data) : [];
					return null;
				}).then(function () {
					if (serving) {
						state.cell.mcc = serving.mcc; state.cell.mnc = serving.mnc;
						state.cell.lac = serving.lac; state.cell.cid = serving.cid;
						state.cell.channel = serving.channel; state.cell.pci = serving.pci;
						/*
						 * 每轮以本轮实测为准，取不到就是取不到（parseMONSC 的 num()
						 * 已把空串与非数字统一成 null，不会往下传 NaN）。
						 * 旧写法 `serving.sinr != null ? serving.sinr : state.cell.sinr`
						 * 在 5G→4G 掉制时会把掉线前 5G 的 SINR 一直留在界面上 ——
						 * 陈旧值伪装成当前值，比老实显示「—」更有误导性。
						 * 缺的那几项由下面的 fillSignalFromHCSQ() 补。
						 */
						state.cell.rsrp = serving.rsrp;
						state.cell.rsrq = serving.rsrq;
						state.cell.sinr = serving.sinr;
						state.cell.sysMode = serving.sysMode || state.cell.sysMode;
						state.cell.signalPercent = serving.signalPercent || '';
					}
					/*
					 * ^HFREQINFO 解析结果原样带过来（parseHFREQINFO 已按手册
					 * 每载波 7 字段解好），只把 band 归一为数字。
					 */
					state.carriers = carriers.map(function (c) {
						return {
							index: c.index, kind: c.kind, sysMode: c.sysMode,
							band: c.band ? Number(c.band) : null,
							dlFcn: c.dlFcn, dlFreqMHz: c.dlFreqMHz, dlBwKHz: c.dlBwKHz,
							ulFcn: c.ulFcn, ulFreqMHz: c.ulFreqMHz, ulBwKHz: c.ulBwKHz,
							downlinkOnly: !!c.downlinkOnly
						};
					});
					return fillSignalFromHCSQ();
				}).then(function () {
					renderSignal();
					renderCarriers();
					renderConn();
					/* 结论区跟着快档走：信号与注册状态一变，第一句话也要跟着变 */
					renderVerdict();
				});
			});
		}

		function loadSecondary() {
			/*
			 * 辅载波/邻区信号已统一由 ^NRSSBID 提供（见 renderCarriers 的 nrssbidMatch）：
			 *   - ^CASCELLINFO? 仅 LTE CA 有效，本机 NR CA 下恒回 ERROR；
			 *   - ^MONSSC 只用于 NSA 下的 NR 辅连接小区。
			 *     ★ 2026-09-29 更正：本段原先写「^MONSSC 本机 SA 组网恒回 NONE」——
			 *     那是 SA 时期的实测。本机切到 NSA(EN-DC) 后它**实回真实数据**
			 *     （`^MONSSC: NR,504990,114,-74,-10,14,0`）。**别因为这条注释就以为
			 *     它在本机无效**。之所以仍不查它，是因为 ^NRSSBID 已覆盖辅载波的
			 *     PCI/RSRP/SINR（每轮省 2 次串口往返），而不是「查不到」。
			 * 其解析函数已从 parse.js 一并移除。
			 */
			return AtWs.client.sendCommand('AT^NRSSBID?').then(function (ssbid) {
				state.nrssbid = ssbid.success && ssbid.data ? Parse.parseNrssbid(String(ssbid.data)) : null;
				/* ^MONNC 只为给 SSB 邻区补 RSRQ（SSB 不含该项）；查不到就整列「—」，
				   不影响辅载波本身的 PCI/RSRP/SINR。 */
				return AtWs.client.sendCommand('AT^MONNC');
			}).then(function (monnc) {
				state.monnc = monnc.success && monnc.data ? Parse.parseMonncAll(String(monnc.data)) : [];
				delete slowFailures.loadSecondary;   /* 成功一轮就抹掉失败留痕 */
				renderCarriers();
			});
		}

		function loadDiagnostics() {
			// 这几条都可能因为「当前不是那个组网」而失败，属于正常情况，静默处理
			return AtWs.client.sendCommand('AT^LENDC?').then(function (lendc) {
				state.diag.endc = lendc.success && lendc.data ? Parse.parseLendc(lendc.data) : null;
				return AtWs.client.sendCommand('AT+C5GREG?');
			}).then(function (c5g) {
				state.diag.reg = c5g.success && c5g.data ? Parse.parseC5greg(c5g.data) : null;
				/* 不再发 AT^TXPOWER?（LTE/GUL 发射功率）：手册 §13.23 注明仅 GUL 有效，
				   本机 NR SA 下实测 0/3 恒 ERROR，属无效查询。NR 侧用 ^NTXPOWER?。 */
				return AtWs.client.sendCommand('AT^NTXPOWER?');
			}).then(function (ntxp) {
				state.diag.nrTx = ntxp.success && ntxp.data ? Parse.parseNrTxPower(ntxp.data) : [];
				/* 4G(EPS) 注册：SA/NSA 下 LTE 侧的注册状态，与 CGREG(2/3G)、C5GREG(5G) 互补 */
				return AtWs.client.sendCommand('AT+CEREG?');
			}).then(function (creg) {
				state.diag.creg = creg.success && creg.data ? Parse.parseRegStat(String(creg.data), '+CEREG') : null;
				/* IMS 注册：直接决定 VoLTE / VoNR / IMS 短信能不能用 */
				return AtWs.client.sendCommand('AT+CIREG?');
			}).then(function (cireg) {
				state.diag.cireg = cireg.success && cireg.data ? Parse.parseCireg(String(cireg.data)) : null;
				/* RRC 状态：连接态/空闲态 —— 也解释了「空闲时看不到载波聚合」 */
				return AtWs.client.sendCommand('AT^RRCSTAT?');
			}).then(function (rrc) {
				state.diag.rrc = rrc.success && rrc.data ? Parse.parseRrcstat(String(rrc.data)) : null;
				/* 选网模式（+COPS?）：自动还是手动锁了运营商；读命令，安全 */
				return AtWs.client.sendCommand('AT+COPS?');
			}).then(function (cops) {
				state.diag.cops = cops.success && cops.data ? Parse.parseCops(String(cops.data)) : null;
				return AtWs.client.sendCommand('AT+CGPADDR');
			}).then(function (pdp) {
				state.diag.addrs = pdp.success && pdp.data ? Parse.parseCgpaddr(pdp.data) : [];
				renderConnDetail();
			});
		}

		/* ---------- 实时速率（OpenWrt 接口统计采样） ---------- */

		/*
		 * 实时速率取自承载 5G 流量的网络接口累计字节数，按「两次采样差 ÷ 时间差」计算。
		 *
		 * 为什么不再用 PDCP：
		 *   PDCP 方案需要后端持续向模组下发 AT 命令订阅上报，既独占 AT 通道，
		 *   又会在用户手动发 AT 命令时产生干扰，直接影响模组工作。
		 *   接口统计是内核维护的计数器，读它不产生任何 AT 流量。
		 *
		 * 采样时序：用本机 Date.now() 做时间基准（与 RPC 往返无关），
		 * 避免 rpcd 与浏览器时钟不同源引入抖动。
		 */
		var rateSample = null;
		var rateTimer = null;
		var rateOn = true;

		/* 「实时监测」开关：关闭即停表（不再每秒读接口计数器），重开时重新起基准。
		   ★ 页面在**后台标签页**里打开时（`document.hidden === true`，例如 Ctrl+点击
		   新标签页）不起表：看不见的时候每秒读一次网卡计数器是纯浪费，
		   回到前台由 onVisibility 补起 —— 那里同样会丢弃旧基准。 */
		function setRateEnabled(on) {
			rateOn = !!on;
			try { localStorage.setItem('mt5700.rateOn', rateOn ? '1' : '0'); } catch (e) {}
			if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
			if (rateOn && !document.hidden) {
				rateSample = null;
				/* 重新开始一段监测：峰值随之归零，否则上一轮的尖峰会一直挂着 */
				state.peakDown = 0;
				state.peakUp = 0;
				rateTimer = setInterval(sampleRate, 1000);
				sampleRate();
			}
			renderSpeed();
		}

		var rateChk = E('input', { 'type': 'checkbox' });
		rateChk.addEventListener('change', function () { setRateEnabled(rateChk.checked); });
		/* ★ E(tag, attrs, text) 只挂载第 3 个参数，第 4 个起会被**静默丢弃**
		   （它是全站共用 helper，改成变参影响面太大，footgun 已记在
		   docs/FRONTEND_REVIEW_REPORT.md）。所以 label 必须分两步建 ——
		   原来写成 E('label', {}, rateChk, document.createTextNode(' 实时监测'))，
		   「实时监测」这四个字从来就没显示过，只剩一个光秃秃的勾选框。 */
		var rateLabel = E('label', {}, rateChk);
		rateLabel.appendChild(document.createTextNode(' 实时监测'));
		/* 流量清零归位到这张卡：它清的就是本卡的流量统计，与速率/流量同一问题域，
		   放在「连接工具」里要跨卡找。
		   ★ 容器用 .mt5700-toolbar（mt5700.css:2590）而不是 .at-autorefresh：
		   后者是 Ui.autoRefresh 的私有类（ui.js:347），自带 margin 6px/10px 与
		   硬编码 #555（无深色变体），放进卡头会把这一排顶高、暗色下发灰；
		   而且它没有 flex-wrap，窄屏两个子元素不换行而是直接溢出。
		   .mt5700-toolbar 是 flex + gap + wrap，且「网络设置」页已在用它做卡头
		   工具条（mt5700.css:2742 的注释承认该用法）—— 零新增样式。 */
		var flowClearBtn = Mt5700.dangerButton('清零流量', clearFlowStats);
		flowClearBtn.title = '把本次与累计流量、连接时长全部归零（AT^DSFLOWCLR，手册 16.11）';
		var rateBar = E('div', { 'class': 'mt5700-toolbar' });
		rateBar.appendChild(rateLabel);
		rateBar.appendChild(flowClearBtn);
		rateExtra.appendChild(rateBar);

		/*
		 * 1Hz 采样，但一次 netRate 往返可能长得多（它的超时是 5s）。
		 * 没有在飞守卫就会多个采样重叠：后一次覆盖 rateSample 之后，先回来的那次
		 * 拿新基准配自己的旧时刻，dt 与字节差不是同一段区间 —— 速率曲线出现
		 * 尖刺，甚至因为差分为负而被抹成 0。重叠期间直接跳过即可，
		 * 下一拍（1 秒后）自然会用最新基准继续，不会丢数据。
		 */
		var rateInFlight = false;
		function sampleRate() {
			/* 不可见时不采样：定时器已停，这里挡的是「切后台瞬间在飞的那一次」。 */
			if (document.hidden) return Promise.resolve();
			if (rateInFlight) return Promise.resolve();
			rateInFlight = true;
			var settle = function () { rateInFlight = false; };
			return AtWs.netRate('').then(function (r) {
				settle();
				if (!r.success) {
					/* 失败时清空基准，下次采样重新起算，避免用过期基准算出离谱速率 */
					rateSample = null;
					state.rtDown = 0;
					state.rtUp = 0;
					renderSpeed();
					return;
				}
				var now = Date.now();
				if (rateSample && rateSample.device === r.device) {
					var dt = (now - rateSample.t) / 1000;
					/* 单侧计数器读不到（后端对瞬时不可读回 null 而非补 0）时，
					 * 本拍差分不可信：跳过并重置基准，下一拍恢复（B07） */
					if (rateSample.rx == null || rateSample.tx == null ||
					    r.rx_bytes == null || r.tx_bytes == null) {
						rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
						return;
					}
					/* 间隔过短（<0.2s）时差分噪声大，跳过本次并保留原基准 */
					if (dt >= 0.2) {
						var drx = r.rx_bytes - rateSample.rx;
						var dtx = r.tx_bytes - rateSample.tx;
						/*
						 * 计数器回绕或接口重置会产生负差，此时不能输出负值，
						 * 直接以 0 处理并重置基准，下一拍即可恢复。
						 */
						state.rtDown = drx >= 0 ? drx / dt : 0;
						state.rtUp = dtx >= 0 ? dtx / dt : 0;
					history.push({ down: state.rtDown, up: state.rtUp });
					if (history.length > HISTORY_POINTS) history = history.slice(history.length - HISTORY_POINTS);
					/* 峰值只在本段监测内累计（单位与 rt* 一致：字节/秒） */
					if (state.rtDown > state.peakDown) state.peakDown = state.rtDown;
					if (state.rtUp > state.peakUp) state.peakUp = state.rtUp;
						rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
						renderSpeed();
						return;
					}
					return;
				}
				/* 首拍或设备变更：只记基准，不产生速率 */
				rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
			}, function (err) {
				void err;
				/* 请求失败同样要放开守卫，否则速率监测会永久停摆 */
				settle();
				rateSample = null;
				state.rtDown = 0;
				state.rtUp = 0;
				renderSpeed();
			});
		}

		/* 恢复上次的开关状态（默认开） */
		var savedRateOn = '1';
		try { savedRateOn = localStorage.getItem('mt5700.rateOn') || '1'; } catch (e) {}
		rateChk.checked = savedRateOn !== '0';
		setRateEnabled(rateChk.checked);

		/* ---------- 刷新（分级） ----------
		 *
		 * 串口是独占资源，实测「每 5 秒把所有项目轮一遍」会稳定产生 ~5.5 次 AT 往返/秒，
		 * 已接近 115200 波特率下串口的吞吐上限，既拖慢界面也让模组持续被打扰。
		 * 因此按数据变化速度分档，只按需要快的项目走快档：
		 *
		 *   快档 5s  ：注册状态、实时流量、信号与载波
		 *   慢档 30s ：运营商、签约速率(AMBR)、QCI、DHCP/IP、温度、MCS、
		 *              辅载波查询、连接诊断(ENDC/5GC/发射功率/PDP)
		 *   超慢 60s ：SIM 与设备信息（loadDeviceInfo 自带 60s 节流）
		 *
		 * 运营商 / 签约速率 / QCI 都是「会话级」静态值，注册成功后基本不变，
		 * 放到快档纯属浪费串口往返，因此归入慢档。
		 *
		 * 另外 rpc.js 的只读缓存（2.5s TTL）会吃掉同一轮里重复的查询
		 * （例如 ^HFREQINFO? 同时被「载波与聚合」和「SIM 与设备」用到）。
		 */
		var FAST_MS = 5000;
		var SLOW_MS = 30000;

		/*
		 * 在跑的那一轮刷新。
		 *
		 * 原先撞车时直接 `return Promise.resolve()`，于是用户手动点「刷新」
		 * 而自动刷新正好在跑的话，整条 .then 链瞬间走完、一条命令都没发 ——
		 * 界面上按钮按了、转圈都没有，表现为「刷新按钮偶发没反应」。
		 * 现在撞车就复用在跑的那一轮：用户等到的仍是这一轮的真实数据，
		 * 自动刷新之间也依旧互斥，不会叠加着抢独占串口。
		 */
		var fastRunning = null;
		function refreshFast() {
			if (fastRunning) return fastRunning;
			var chain = Promise.resolve();
			/* 只保留「用户盯着看、需要秒级新鲜」的内容：信号与小区信息。
			   注册状态（AT+CGREG?）与模组侧累计流量（AT^DSFLOWQRY）不随秒变化，
			   已移到 30 秒慢档——实时速率另有 1Hz 的网卡计数采样，不受影响。 */
			[updateNetworkInfo]
				.forEach(function (fn) { chain = chain.then(fn); });
			fastRunning = chain.catch(function () { /* 刷新失败保留上一次数据 */ })
				.then(function () { fastRunning = null; });
			return fastRunning;
		}

		/*
		 * 慢档任务顺序：**辅载波（loadSecondary）排在最前**。
		 * 它过去排在第 9 位，要等前面 8 个函数（十余次串口往返）串行走完才执行，
		 * 首屏进入页面时辅载波读数要空等一轮，表现为「显示缓慢」。
		 * 它只依赖快档已取到的 state.carriers，没有前置依赖，放前面是安全的。
		 */
		/*
		 * 头段任务数 = 6：「连接状态」卡（网络状态 / APN / QCI / 签约速率）与
		 * 「载波与聚合」卡直接依赖这几个，必须最先拿到值。
		 * 尾段是地址与 DNS、温度、MCS、连接诊断 —— 它们在页面上更靠下，
		 * 晚一拍出来对观感没有影响。
		 */
		var SLOW_HEAD_COUNT = 6;
		var SLOW_TASKS = [loadSecondary, getPSReg, getFlow, getOperator, getAMBR,
			getQCI, getDHCP, getTemp, getMCS, loadDiagnostics];

		/*
		 * ★ P20（2026-09-25 性能专项）：慢档十个任务加起来是这一页**最重的一轮** ——
		 * 十余次串口往返，逐个串行发，实测单条往返约 100ms，整轮要好几秒，
		 * 表现为「进页面后各卡片一个一个慢慢填」。
		 *
		 * 这里先把它们要问的只读命令取回来（AtWs.client.warmCache，后端是
		 * mt5700.at_batch，一次 HTTP 里逐条转发），各任务照旧 sendCommand ——
		 * 此时几乎每条都命中既有读缓存，串口往返次数不变，但 HTTP 往返被压掉。
		 *
		 * ★ 为什么这样做是安全的：
		 *   · warmCache 只处理「sendCommand 本来就会缓存」的命令（同一个
		 *     isRetryableRead 判据），**失败结果不入缓存**（同一个 _cachePut），
		 *     所以一次偶发 ERROR 不会被固化成持续显示失败；
		 *   · 带 { fresh: true } 的调用天然绕过缓存，预热对它完全无效 ——
		 *     「这一项必须拿实时值」的语义没有被削弱；
		 *   · 预热失败只返回 0，不 reject，任务链完全不受影响。
		 *
		 * ★ 副产品其实是改善：原本十个任务读到的数据本来就是**不同时刻**的
		 * （前后差好几秒），而现在整轮取的是同一个时刻的快照，读数之间自洽了。
		 *
		 * 清单来自下面 SLOW_TASKS 各函数实际会发的命令；写命令（^EONS=2、
		 * ^DSAMBR=、^MCS=、含 cid 的拼接命令、AT+CGPADDR 这类不经缓存的读）
		 * 不在其中 —— 它们要么本来就不用缓存，要么参数要临时算。
		 *
		 * ==========================================================================
		 * ★★ 2026-09-28：清单**按「谁先用」切成两段**（SLOW_WARM / SLOW_WARM_REST）
		 * --------------------------------------------------------------------------
		 * 起因：用户反馈「连接状态这些读取信息速度不是很快」。
		 *
		 * 真机实测（经 LuCI /ubus，与前端同一条链路）：
		 *   · 一条 AT 往返 ≈ 100ms，而轻量 ubus（netray 那种不占串口的）只要 2ms
		 *     → 时间几乎全在**独占串口**上，串口是串行的，批量化并不能让它变快：
		 *       16 条逐条发 = 1680ms；同样 16 条一次 at_batch = 1670ms（同一批数据）
		 *   · 所以「预热」省的是 HTTP 往返（每条约 3ms），**不是**串口时间。
		 *
		 * 那真正的浪费在哪？—— **预热的整批是串行跑的，而且挡在第一个任务前面**：
		 *   旧顺序 = 预热 16 条（实测 1670ms）→ 才开始 loadSecondary
		 *   而「连接状态」只要 6 条命令（CGACT? / NRSSBID? / MONNC / CGREG? /
		 *   CEREG? / DSFLOWQRY），其余 10 条是页面更靠下的「地址与 DNS / 诊断」
		 *   才要用的。为了给靠下的卡片省 3ms/条的 HTTP，把最上面的卡整体推迟了
		 *   1.6 秒 —— 这才是「连接状态出得慢」的直接原因。
		 *
		 * 切两段后（头段预热 6 条 → 跑头段 6 个任务 → 再预热尾段 10 条 → 跑尾段）：
		 *   连接状态出值  ≈1.9s → ≈0.8s（−58%）
		 *   其余卡片      ≈2.07s → ≈2.06s（不变）
		 *   **串口总条数一条没少**（6 + 10 + 4 条不进缓存的写/参数化命令 = 20 条，
		 *   与旧实现完全相同）—— 改的只是先后次序，不是「少问模组」。
		 * ==========================================================================
		 */
		var SLOW_WARM = [
			'AT+CGACT?',       /* resolveActiveCid（getAMBR / getQCI 都要先问它） */
			'AT^NRSSBID?',     /* loadSecondary：辅载波与 SSB 邻区 */
			'AT^MONNC',        /* loadSecondary：给 SSB 邻区补 RSRQ */
			'AT+CGREG?',       /* getPSReg */
			'AT+CEREG?',       /* getPSReg + loadDiagnostics（同一轮复用同一份） */
			'AT^DSFLOWQRY'     /* getFlow */
		];
		var SLOW_WARM_REST = [
			'AT^DHCPV6?',      /* getDHCP */
			'AT^DHCP?',        /* getDHCP */
			'AT^IPV6CAP?',     /* getDHCP */
			'AT^CHIPTEMP?',    /* getTemp */
			'AT^LENDC?',       /* loadDiagnostics */
			'AT+C5GREG?',      /* loadDiagnostics */
			'AT^NTXPOWER?',    /* loadDiagnostics */
			'AT+CIREG?',       /* loadDiagnostics */
			'AT^RRCSTAT?',     /* loadDiagnostics */
			'AT+COPS?'         /* loadDiagnostics */
		];

		/* 慢档各任务的失败记录：逐步兜错后失败不再阻断后续，但要留痕，
		   否则「某一项一直失败」又会退化成看不见的静默问题。 */
		var slowFailures = {};
		var slowRunning = null;   /* 同 refreshFast：撞车时复用在跑的那一轮 */
		function refreshSlow() {
			if (slowRunning) return slowRunning;
			/*
			 * 串行，但**每个环节各自兜错**。
			 * 过去是 `chain.then(a).then(b)…` 末尾挂一个 catch：任何一步 reject，
			 * 后面全部静默跳过（含 loadSecondary），界面却毫无提示，
			 * 表现为「辅载波读数一直不刷新、像是卡住了」。
			 * 改成逐步兜错后，单点失败只丢那一项，其余照常更新。
			 */
			/* 起点是「头段预热」：先取回**连接状态卡要用的那 6 条**，
			   让最上面那张卡不必等尾段 10 条命令占完串口。见 SLOW_WARM 的注释。 */
			var chain = AtWs.client.warmCache(SLOW_WARM);
			SLOW_TASKS.forEach(function (fn, idx) {
				chain = chain.then(function () {
					/*
					 * ★ P12（2026-09-19 会审）：切页之后，已在飞的链不再继续打串口。
					 * 慢档一轮十余次串口往返，_dispose 只清定时器、管不到已经发出去的链；
					 * 撞在切页那一瞬间，就会让下一个页面的头十几秒跟着变慢。
					 * 与排查链（逐步检查 disposed）同一写法。
					 */
					if (disposed) return null;
					return Promise.resolve()
						.then(fn)
						.catch(function (err) { slowFailures[fn.name || '匿名任务'] = err; });
				});
				/*
				 * 头段任务跑完 → 预热尾段 → 再继续。插在这里（而不是一开始就
				 * 把 16 条预热完）是这次提速的关键，理由见 SLOW_WARM 上方的注释。
				 * 用 idx 判断而不是拆成两个数组：SLOW_TASKS 的**顺序本身就是契约**
				 * （neighbor-contract 钉着 loadSecondary 必须在首位），
				 * 拆数组会让「任务顺序」和「预热何时发生」两处各说一套。
				 */
				if (idx === SLOW_HEAD_COUNT - 1) {
					chain = chain.then(function () {
						if (disposed) return null;
						return AtWs.client.warmCache(SLOW_WARM_REST);
					});
				}
			});
			slowRunning = chain.then(function () {
				slowRunning = null;
				/* 地址 / 网关 / 温度 / APN 全在慢档：它们决定结论区的副标题与「需要处理」，
				   所以慢档整轮跑完再画一次（快档那边已经画过一次，先出的是信号与注册）。 */
				if (!disposed) renderVerdict();
			});
			return slowRunning;
		}

		/* 手动点「刷新」时全量拉一次（含设备信息，绕过 60s 节流） */
		function refreshAll() {
			loadDeviceInfo(true);
			return refreshFast().then(refreshSlow);
		}

		/* ---------- 自动刷新 ---------- */

		var timer = null, slowTimer = null;
		function resetTimers(enabled, interval) {
			if (timer) { clearInterval(timer); timer = null; }
			if (slowTimer) { clearInterval(slowTimer); slowTimer = null; }
			if (!enabled) return;
			if (document.hidden) return;   /* 后台标签页不重建定时器（见下方 visibilitychange） */
			// ★ 2026-09-28：原为 `(interval || 5) * 1000` —— 那个 5 是魔法数，
			//   而本文件上面已经定义了 FAST_MS = 5000（默认快档间隔），却从没被引用
			//   （同形态：定义了不用 + 硬编码同一含义，全仓另一例是 diag-probe.sh 的
			//   TCP_TIMEOUT）。改用常量；`interval` 为 0/缺省时同样落到 FAST_MS，
			//   与原 `(interval || 5)` 的语义一致。
			var fast = interval ? interval * 1000 : FAST_MS;
			timer = setInterval(refreshFast, fast);
			/* 慢档跟随快档倍数，但不少于 30 秒，避免小间隔下把慢档也拉成高频 */
			slowTimer = setInterval(refreshSlow, Math.max(SLOW_MS, fast * 6));
		}
		var ar = Ui.autoRefresh(resetTimers);
		resetTimers(true, 5);

		/*
		 * 标签页不可见时暂停轮询。
		 * 这一页是全插件轮询最密的（2026-09-13 实测稳态 2.60 次/秒，其中 AT 命令 1.73 次/秒），
		 * 而此前没有任何可见性判断——标签页切到后台后仍在全速占串口。
		 * 回到前台立即恢复并补一次刷新，避免看到陈旧读数。
		 */
		var onVisibility = function () {
			if (document.hidden) {
				/* ★ 1Hz 的速率采样也要停：页面看不见时每秒读一次接口计数器是纯浪费，
				   而它又是唯一不受 resetTimers 管辖的定时器。 */
				if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
				resetTimers(false);
				return;
			}
			resetTimers(ar.isEnabled(), ar.getInterval());
			refreshAll();
			if (rateOn && !rateTimer) {
				/* ★ 显式的语义决定：1Hz 速率采样只受「实时监测」开关管辖，
				   不受「自动刷新」开关约束 —— 前者是这张卡自己的开关（用户勾了
				   就是要看实时曲线），后者管的是读数类轮询。且它走的是 ubus
				   netrate（读接口计数器），**不占 AT 串口**，与红线里的
				   「AT 通道独占」不是一回事，所以不跟着 ar.isEnabled() 一起停。 */
				/* ★ 回到前台必须丢弃旧基准：否则 dt 等于整段隐藏时长，
				   字节差除以一个巨大的 dt 会落出一个被摊薄的假谷值，
				   还会污染峰值判定（峰值只升不降，假谷值虽不抬峰值，
				   但曲线上会留一段平躺的怪台阶）。 */
				rateSample = null;
				rateTimer = setInterval(sampleRate, 1000);
				sampleRate();
			}
		};
		document.addEventListener('visibilitychange', onVisibility);

		/* 刷新控制归位到「信号质量」卡片头部，不再单独占一行 */
		sigExtra.appendChild(Mt5700.panelActions(
			ar.el,
			Mt5700.primaryButton('刷新', function () { refreshAll(); })
		));

		/* ---------- 初始化 ---------- */

		renderConn();
		renderSignal();
		renderCarriers();
		/* 结论区先画一次空态：首屏前几秒数据还没回来，这一块要显示「正在读取」，
		   而不是一片空白等第一轮刷新（用户会以为页面坏了）。 */
		renderVerdict();
		renderConnDetail();    /* 连接明细：诊断 + 地址与 DNS（一张表） */
		renderTools();   /* 断网排查：右列总控卡 + 底部满宽明细卡 */
		renderSpeed();
		renderFlow();
		renderTemp();
		renderMCS();

		/* 自定义 DNS 是 UCI 侧的静态配置，跟 AT 无关，单独加载；
		   拿到后重绘一次，让「主/备 DNS」显示成自定义值并带上「自定义」徽章。
		   ACL 不含 network 时静默降级为只读，不影响上面任何渲染。 */
		loadDnsConfig().then(renderConnDetail);

		Mt5700.connectThen(function () {
			refreshAll();
			/* ★ 2026-09-19：排查**不再进页面自动跑**，只在用户点「一键排查」时才走。
			   这条链是 9 条 AT + 一次系统侧采集（后端含 3 次 ICMP / DNS / TCP 握手，
			   最坏 15 秒），要占住独占的 AT 通道十几秒；而页面本身有快档与慢档轮询，
			   每次进页面都插一杠子，等于让整页读数在头十几秒里变慢，也把用户手动发的
			   AT（短信 / 终端 / 拨号）挤到后面排队。用户口径：只有我按才排查。
			   （自动跑时代的两个前置项已先后下线：ADC 管脚电压 v2.3.13、本链 v2.3.15。）
			   未排查时明细区显示引导文案，不会让人误以为已经查过。 */
		});

		self._dispose = function () {
			/* 离开页面必须清干净：三个定时器 + 可见性监听 + 只读缓存，
			   否则反复进出会叠加倍轮询。
			   disposed 同时让已发起的排查链尽快停下（见其声明处注释）。
			   （本页已无任何常驻上报开关，不需要再做「关不掉就报警」的收尾） */
			disposed = true;
			if (timer) clearInterval(timer);
			if (slowTimer) clearInterval(slowTimer);
			if (rateTimer) clearInterval(rateTimer);
			timer = slowTimer = rateTimer = null;
			if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
			if (chartRO) { chartRO.disconnect(); chartRO = null; }
			else if (onResize) { window.removeEventListener('resize', onResize); }
			onResize = null;
			if (AtWs.client && AtWs.client.clearReadCache) AtWs.client.clearReadCache();
		};
		page._onDispose(self._dispose);

		return page;
	}
});
