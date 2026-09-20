'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 5G/4G 模组网络状态 - 赛博极客全动态 SVG 工业级精装重构版 (v3.3)
 *
 * 核心提升：
 *  1. 【模组温度图表重构】：大画幅 PCB 纯矢量电路版图，集成热传导总线、芯片引脚焊盘、动态呼吸光晕，搭配 4×2 完美平衡读数矩阵；
 *  2. 【调制方式与空间流】：新增「上行频谱效率利用率」双轨进度条，与 I/Q 正交星座点阵共同填满卡片空间，消除留白塌陷；
 *  3. 【三列黄金等高对齐】：流量统计、IP/DNS 与调制方式三张卡片高度严格自适应等高（~440px）。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络状态', '实时蜂窝无线链路、物理射频载波与硬件工况遥测');
		var body = page._body;

		/* ---------- 1. 注入自适应 NOC 极客响应式全局样式表 ---------- */
		var style = E('style', {}, [
			':root {',
			'  --mt-bg-card: var(--background-color-high, rgba(255, 255, 255, 0.95));',
			'  --mt-border: var(--border-color-low, rgba(140, 155, 180, 0.2));',
			'  --mt-shadow: 0 8px 24px rgba(0, 0, 0, 0.04);',
			'  --c-exc: #00f5a0; --c-good: #00b4d8; --c-fair: #f59e0b; --c-poor: #f97316; --c-crit: #ef4444;',
			'  --c-dl: #00b4d8; --c-ul: #10b981;',
			'}',
			'@media (prefers-color-scheme: dark) {',
			'  :root {',
			'    --mt-bg-card: rgba(20, 26, 38, 0.92);',
			'    --mt-border: rgba(255, 255, 255, 0.09);',
			'    --mt-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);',
			'  }',
			'}',
			'.mt-root-wrap { display: flex; flex-direction: column; gap: 16px; margin-top: 10px; width: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
			'.mt-row-2col { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 16px; align-items: stretch; width: 100%; }',
			'.mt-row-3col { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; align-items: stretch; width: 100%; }',
			'@media (max-width: 1180px) { .mt-row-3col { grid-template-columns: 1fr; } }',
			/* 信号 4 联卡片 */
			'.mt-sig-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 12px; margin-bottom: 6px; }',
			'@media (max-width: 1080px) { .mt-sig-row { grid-template-columns: repeat(2, 1fr); } }',
			'@media (max-width: 580px) { .mt-sig-row { grid-template-columns: 1fr; } }',
			'.mt-sig-box { background: var(--mt-bg-card); border: 1px solid var(--mt-border); border-radius: 12px; box-shadow: var(--mt-shadow); padding: 14px 14px 12px 14px; display: flex; flex-direction: column; position: relative; overflow: hidden; transition: transform 0.2s ease, border-color 0.2s ease; }',
			'.mt-sig-box:hover { transform: translateY(-2px); border-color: rgba(0, 180, 216, 0.45); }',
			'.mt-sig-box-head { display: flex; align-items: center; justify-content: space-between; width: 100%; margin-bottom: 4px; }',
			'.mt-sig-box-title { font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px; color: var(--text-color-high, inherit); }',
			'.mt-sig-tag { font-size: 10px; font-family: "JetBrains Mono", monospace; font-weight: 800; padding: 1px 6px; border-radius: 4px; background: rgba(125, 125, 125, 0.12); }',
			'.mt-sig-ref { font-size: 10.5px; opacity: 0.55; font-family: "JetBrains Mono", monospace; }',
			'.mt-sig-box-svg { width: 100%; display: flex; justify-content: center; align-items: center; margin: 4px 0; }',
			'.mt-sig-box-foot { display: flex; align-items: center; justify-content: space-between; width: 100%; padding-top: 8px; border-top: 1px dashed rgba(125, 125, 125, 0.16); margin-top: 4px; }',
			'.mt-sig-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 700; border: 1px solid transparent; }',
			'.mt-sig-dot { width: 6px; height: 6px; border-radius: 50%; box-shadow: 0 0 6px currentColor; animation: mt-beacon 1.8s infinite ease-in-out; }',
			'.mt-sig-sub { font-size: 11px; opacity: 0.65; font-weight: 600; }',
			'.mt-sig-bar-rail { position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: rgba(125,125,125,0.1); }',
			'.mt-sig-bar-fill { height: 100%; width: 0%; transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.4s ease; }',
			/* 速率 HUD */
			'.mt-speed-hud { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }',
			'.mt-speed-tile { padding: 14px 16px; border-radius: 10px; border: 1px solid var(--mt-border); background: rgba(125, 125, 125, 0.04); position: relative; overflow: hidden; }',
			'.mt-speed-tile::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; }',
			'.mt-speed-tile.dl::before { background: linear-gradient(90deg, #00b4d8, #00f2fe); }',
			'.mt-speed-tile.ul::before { background: linear-gradient(90deg, #10b981, #00f5a0); }',
			'.mt-speed-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }',
			'.mt-speed-val { font-size: 26px; font-weight: 900; font-family: "JetBrains Mono", Consolas, monospace; line-height: 1.1; }',
			'.mt-speed-unit { font-size: 13px; font-weight: 600; margin-left: 4px; opacity: 0.8; }',
			/* 模组芯片温度 4x2 矩阵 */
			'@media (max-width: 640px) { .mt-temp-grid-4x2 { grid-template-columns: repeat(2, 1fr); } }',
			'.mt-temp-cell { border: 1px solid rgba(125, 125, 125, 0.16); border-radius: 8px; padding: 10px 10px; background: rgba(125, 125, 125, 0.03); display: flex; flex-direction: column; justify-content: center; gap: 6px; }',
			'.mt-temp-gauge-bg { width: 100%; height: 5px; background: rgba(125, 125, 125, 0.15); border-radius: 3px; overflow: hidden; margin-top: 3px; }',
			'.mt-temp-gauge-bar { height: 100%; border-radius: 3px; transition: width 0.4s ease, background-color 0.4s ease; }',
			/* 卡片等高填充：card -> body -> stretch-body 三层贯通，消除底部留白 */
			'.mt-stretch-card { display: flex; flex-direction: column; }',
			'.mt-stretch-card > .mt5700-card-body { flex: 1; display: flex; flex-direction: column; }',
			'.mt-stretch-body { flex: 1; display: flex; flex-direction: column; gap: 8px; min-height: 0; }',
			'.mt-temp-svg-wrap { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }',
			'.mt-temp-grid-4x2 { display: grid; grid-template-columns: repeat(4, 1fr); grid-auto-rows: 1fr; gap: 8px; flex: 1; }',
			/* 底部三列等高容器卡片 */
			'.mt-card-box { height: 100%; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; }',
			/* 流量统计重构 */
			'.mt-flow-sect { background: rgba(125, 125, 125, 0.03); border: 1px solid var(--mt-border); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }',
			'.mt-flow-sect-head { display: flex; justify-content: space-between; align-items: center; }',
			'.mt-flow-title { font-size: 12px; font-weight: 700; color: var(--text-color-high, inherit); display: flex; align-items: center; gap: 6px; }',
			'.mt-flow-time { font-size: 12px; font-weight: 800; font-family: "JetBrains Mono", monospace; color: #00b4d8; }',
			'.mt-flow-duo { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }',
			'.mt-flow-tile { background: rgba(125, 125, 125, 0.04); border-radius: 6px; padding: 8px 10px; }',
			'.mt-flow-sub { font-size: 10.5px; opacity: 0.65; font-weight: 600; margin-bottom: 2px; }',
			'.mt-flow-num { font-size: 17px; font-weight: 900; font-family: "JetBrains Mono", monospace; }',
			'.mt-flow-ratio-rail { width: 100%; height: 6px; background: #10b981; border-radius: 3px; overflow: hidden; display: flex; margin-top: 4px; }',
			'.mt-flow-ratio-dl { height: 100%; background: #00b4d8; transition: width 0.5s ease; }',
			/* IP 与 DNS 分组样式 */
			'.mt-ip-block { background: rgba(125, 125, 125, 0.03); border: 1px solid var(--mt-border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }',
			'.mt-ip-row { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; padding: 3px 0; border-bottom: 1px dashed rgba(125,125,125,0.1); }',
			'.mt-ip-row:last-child { border-bottom: none; }',
			'.mt-ip-lbl { opacity: 0.65; font-weight: 600; }',
			'.mt-ip-val { font-family: "JetBrains Mono", monospace; font-weight: 700; color: var(--text-color-high, inherit); word-break: break-all; text-align: right; max-width: 68%; }',
			/* 调制方式星座图与空间流 */
			'.mt-mcs-top { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }',
			'.mt-mcs-tile { border: 1px solid var(--mt-border); border-radius: 8px; padding: 10px 12px; background: rgba(125, 125, 125, 0.03); position: relative; overflow: hidden; }',
			'.mt-mcs-tile::before { content: ""; position: absolute; top: 0; left: 0; bottom: 0; width: 3px; }',
			'.mt-mcs-tile.dl::before { background: #00b4d8; }',
			'.mt-mcs-tile.ul::before { background: #10b981; }',
			'.mt-constell-box { background: rgba(125, 125, 125, 0.03); border: 1px solid var(--mt-border); border-radius: 10px; padding: 10px; display: flex; align-items: center; justify-content: space-around; }',
			/* 通用微标与动画 */
			/* 载波聚合频谱面板：与下方表格同风格，消除孤立感 */
			/* 速率曲线悬浮查看 */
			'.mt-chart-hint { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center; opacity: 0.4; font-size: 12px; pointer-events: none; }',
			'.mt-chart-tip { position: absolute; display: none; pointer-events: none; z-index: 6; background: rgba(18,24,34,0.95); color: #fff; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; padding: 7px 10px; font-size: 11.5px; line-height: 1.55; font-family: "JetBrains Mono", Consolas, monospace; white-space: nowrap; box-shadow: 0 6px 18px rgba(0,0,0,0.3); }',
			'.mt-chart-tip-time { font-size: 10.5px; opacity: 0.72; margin-bottom: 3px; }',
			'.mt-chart-tip-row { display: flex; align-items: center; gap: 5px; }',
			'.mt-chart-tip-row i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }',
			'.mt-chart-tip-row b { margin-left: auto; padding-left: 12px; font-weight: 700; }',
			'.mt-ca-chart-box { background: rgba(125,125,125,0.03); border: 1px solid var(--mt-border); border-radius: 10px; padding: 10px 14px 6px; margin-bottom: 12px; }',
			'.mt-pill-ca { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; background: rgba(16, 185, 129, 0.14); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }',
			'.mt-pill-pcc { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; background: rgba(0, 180, 216, 0.14); color: #00b4d8; border: 1px solid rgba(0, 180, 216, 0.3); }',
			'@keyframes mt-beacon { 0% { opacity: 0.35; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.15); } 100% { opacity: 0.35; transform: scale(0.9); } }',
			'@keyframes mt-radar-sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
			'.mt-radar-line { transform-origin: 100px 75px; animation: mt-radar-sweep 4s linear infinite; }',
			'.mt-actions-bar { background: var(--mt-bg-card); border: 1px solid var(--mt-border); border-radius: 10px; box-shadow: var(--mt-shadow); padding: 10px 16px; margin-top: 10px; display: flex; align-items: center; justify-content: space-between; }'
		]);
		body.appendChild(style);

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var layout = E('div', { 'class': 'mt-root-wrap' });
		body.appendChild(layout);

		/* ==================== 1. 射频信号质量 (全景置顶) ==================== */
		var signalCard = Mt5700.card('射频信号质量', '3GPP 蜂窝空口场强、纯度、信噪比与综合健康度');
		var signalBody = E('div');
		signalCard._body.appendChild(signalBody);
		layout.appendChild(signalCard);

		var verdict = Mt5700.signalVerdict();
		signalBody.appendChild(verdict.el);

		var sigRow = E('div', { 'class': 'mt-sig-row' });
		signalBody.appendChild(sigRow);

		var sigRefPanel = E('div', { 'class': 'mt5700-field-note', 'style': 'display:none; margin-top:12px;' });
		sigRefPanel.appendChild(E('div', { 'class': 'mt5700-field-note-summary' }, '各射频指标 3GPP 协议参考区间依据'));
		var sigRefUl = E('ul', { 'class': 'mt5700-field-note-list' });
		[
			'信号强度 (RSRP)：物理参考信号接收功率。≥-80 dBm 极佳，-80~-90 良好，-90~-100 一般，≤-110 弱区。',
			'信号质量 (RSRQ)：有效信号占频带能量比值。≥-10 dB 极佳，-10~-13 良好，-13~-16 一般，≤-18 干扰拥塞。',
			'信噪比 (SINR)：有用信号相比白噪与信道干扰强度。≥20 dB 极佳 (可满阶 MCS)，≤0 dB 频发重传丢包。',
			'综合信号：模组内部算法按当前综合链路环境计算得出的信号百分比。'
		].forEach(function (t) { sigRefUl.appendChild(E('li', {}, t)); });
		sigRefPanel.appendChild(sigRefUl);
		signalBody.appendChild(sigRefPanel);

		var sigRefToggle = Mt5700.ghostButton('查看指标参考说明', function () {
			var shown = sigRefPanel.style.display !== 'none';
			sigRefPanel.style.display = shown ? 'none' : '';
			sigRefToggle.textContent = shown ? '查看指标参考说明' : '收起参考说明';
		});
		signalBody.appendChild(Mt5700.panelActions(sigRefToggle));

		/* ==================== 2. 第一排双列：实时速率 + 速率曲线 ==================== */
		var rowSpeed = E('div', { 'class': 'mt-row-2col' });
		layout.appendChild(rowSpeed);

		var speedCard = Mt5700.card('实时速率', '网卡物理接口流量差分（1000ms 采样率）');
		var speedRow = E('div');
		speedCard._body.appendChild(speedRow);
		rowSpeed.appendChild(speedCard);

		var historyCard = Mt5700.card('速率曲线', '最近 60 秒双轨平滑吞吐波形');
		var chart = E('div', { 'style': 'width: 100%; height: 180px; min-height: 180px; position: relative;' });
		historyCard._body.appendChild(chart);
		rowSpeed.appendChild(historyCard);

		/* ==================== 3. 第二排双列：连接状态 + 模组芯片温度 ==================== */
		var rowMid = E('div', { 'class': 'mt-row-2col' });
		layout.appendChild(rowMid);

		var connCard = Mt5700.card('连接状态', '当前网络注册与主载波物理参数');
		var connBody = E('div');
		connCard._body.appendChild(connBody);
		rowMid.appendChild(connCard);

		var tempBadge = E('span');
		var tempCard = Mt5700.card('模组温度', '7 通道芯片结温物理分布（单位 ℃）', tempBadge);
		tempCard.classList.add('mt-stretch-card');
		var tempBody = E('div', { 'class': 'mt-stretch-body' });
		tempCard._body.appendChild(tempBody);
		rowMid.appendChild(tempCard);

		/* ==================== 4. 载波聚合 CA (全宽大卡) ==================== */
		var carrierCard = Mt5700.card('载波聚合 (Carrier Aggregation)', '当前激活物理分量载波与射频频谱分布');
		var carrierBox = E('div');
		carrierCard._body.appendChild(carrierBox);
		layout.appendChild(carrierCard);

		/* ==================== 5. 第三排双列：辅载波信号 + 连接诊断 ==================== */
		var rowDiag = E('div', { 'class': 'mt-row-2col' });
		layout.appendChild(rowDiag);

		var secondaryCard = Mt5700.card('辅载波信号遥测', '^MONSSC (NSA 辅站) 与 ^CASCELLINFO (LTE CA) 交叉校准');
		var secondaryBox = E('div');
		secondaryCard._body.appendChild(secondaryBox);
		rowDiag.appendChild(secondaryCard);

		var diagCard = Mt5700.card('连接诊断', 'ENDC 双连接、5GC 核心网注册、发射功率与 PDP 上下文');
		var diagBox = E('div');
		diagCard._body.appendChild(diagBox);
		rowDiag.appendChild(diagCard);

		/* ==================== 6. 第四排三列：流量统计 + DHCP + 调制空间流 ==================== */
		var rowMisc = E('div', { 'class': 'mt-row-3col' });
		layout.appendChild(rowMisc);

		var flowCard = Mt5700.card('流量统计', '会话在线时长与物理吞吐流量');
		var flowBody = E('div', { 'class': 'mt-card-box' });
		flowCard._body.appendChild(flowBody);
		rowMisc.appendChild(flowCard);

		var dhcpCard = Mt5700.card('IP 与 DNS', '局域网与广域网寻址分配');
		var dhcpBody = E('div', { 'class': 'mt-card-box' });
		dhcpCard._body.appendChild(dhcpBody);
		rowMisc.appendChild(dhcpCard);

		var mcsCard = Mt5700.card('调制方式与空间流', '上下行 MCS、QAM 星座图与 MIMO 空间流');
		var mcsBody = E('div', { 'class': 'mt-card-box' });
		mcsCard._body.appendChild(mcsBody);
		rowMisc.appendChild(mcsCard);

		/* ---------- 状态核心 ---------- */

		var state = {
			cell: {
				mcc: '', mnc: '', lac: '', cid: '', channel: '', pci: 0,
				rsrp: null, rsrq: null, sinr: null, sysMode: '未知', signalPercent: ''
			},
			carriers: [],
			secondaryNR: [], secondaryLTE: [],
			diag: { endc: null, reg: null, tx: null, nrTx: [], addrs: [] },
			temps: { sub3GPA: 0, sub6GPA: 0, mimoPa: 0, tcxo: 0, ap1: 0, ap2: 0, modem1: 0 },
			flow: { lastDsTime: 0, lastTxFlow: 0, lastRxFlow: 0, totalDsTime: 0, totalTxFlow: 0, totalRxFlow: 0 },
			dhcpv4: null, dhcpv6: null, ipv6Cap: null,
			uplinkMCS: null, downlinkMCS: null,
			activeCid: null,
			networkStatus: '等待状态中',
			operator: '未知运营商',
			apn: '未知',
			qci: '未知',
			ambrDown: 0, ambrUp: 0,
			rtDown: 0, rtUp: 0
		};

		var history = [];
		var HISTORY_POINTS = 60;
		var peakDown = 0;
		var peakUp = 0;

		/* ---------- 2. 顶奢级 240° 赛博 HUD 射频动态仪表 ---------- */

		var GAUGE_METRICS = {
			rsrp: {
				title: '信号强度', code: 'RSRP', unit: 'dBm', refText: '基准 ≥ -80',
				eval: function (v) {
					if (v == null) return { text: '无信号', status: '等待上报', color: '#94a3b8', pct: 0 };
					if (v >= -80) return { text: '极佳', status: '覆盖极佳', color: '#00f5a0', pct: (v + 140) / 96 };
					if (v >= -90) return { text: '良好', status: '工况优良', color: '#00b4d8', pct: (v + 140) / 96 };
					if (v >= -100) return { text: '一般', status: '信号偏弱', color: '#f59e0b', pct: (v + 140) / 96 };
					if (v >= -110) return { text: '较差', status: '边缘弱区', color: '#f97316', pct: (v + 140) / 96 };
					return { text: '极差', status: '频发脱网', color: '#ef4444', pct: Math.max(0, (v + 140) / 96) };
				}
			},
			rsrq: {
				title: '信号质量', code: 'RSRQ', unit: 'dB', refText: '基准 ≥ -10',
				eval: function (v) {
					if (v == null) return { text: '无信号', status: '等待上报', color: '#94a3b8', pct: 0 };
					if (v >= -10) return { text: '极佳', status: '纯净通畅', color: '#00f5a0', pct: (v + 20) / 17 };
					if (v >= -13) return { text: '良好', status: '轻微扰动', color: '#00b4d8', pct: (v + 20) / 17 };
					if (v >= -16) return { text: '一般', status: '中度负载', color: '#f59e0b', pct: (v + 20) / 17 };
					if (v >= -18) return { text: '较差', status: '邻区拥塞', color: '#f97316', pct: (v + 20) / 17 };
					return { text: '极差', status: '强干扰区', color: '#ef4444', pct: Math.max(0, (v + 20) / 17) };
				}
			},
			sinr: {
				title: '信噪比', code: 'SINR', unit: 'dB', refText: '基准 ≥ 20',
				eval: function (v) {
					if (v == null) return { text: '无信号', status: '等待上报', color: '#94a3b8', pct: 0 };
					if (v >= 20) return { text: '极佳', status: '顶速阶数', color: '#00f5a0', pct: (v + 10) / 40 };
					if (v >= 13) return { text: '良好', status: '稳定传输', color: '#00b4d8', pct: (v + 10) / 40 };
					if (v >= 5) return { text: '一般', status: '速率受限', color: '#f59e0b', pct: (v + 10) / 40 };
					if (v >= 0) return { text: '较差', status: '频发重传', color: '#f97316', pct: (v + 10) / 40 };
					return { text: '极差', status: '严重丢包', color: '#ef4444', pct: Math.max(0, (v + 10) / 40) };
				}
			},
			pct: {
				title: '综合信号', code: 'SIGNAL', unit: '%', refText: '满分 100%',
				eval: function (v) {
					if (v == null || isNaN(v)) return { text: '无信号', status: '等待上报', color: '#94a3b8', pct: 0 };
					if (v >= 80) return { text: '极佳', status: '满格服务', color: '#00f5a0', pct: v / 100 };
					if (v >= 60) return { text: '良好', status: '稳定连接', color: '#00b4d8', pct: v / 100 };
					if (v >= 40) return { text: '一般', status: '基础覆盖', color: '#f59e0b', pct: v / 100 };
					if (v >= 20) return { text: '较差', status: '微弱临界', color: '#f97316', pct: v / 100 };
					return { text: '极差', status: '濒临掉线', color: '#ef4444', pct: Math.max(0, v / 100) };
				}
			}
		};

		function createUltraSignalCard(type) {
			var conf = GAUGE_METRICS[type];
			var box = E('div', { 'class': 'mt-sig-box' });
			var cx = 100, cy = 96, R = 62;
			var totalArc = 259.7;

			var ticks = '';
			for (var i = 0; i <= 12; i++) {
				var deg = 150 + (i / 12) * 240;
				var rad = deg * Math.PI / 180;
				var rIn = 70, rOut = (i % 3 === 0) ? 77 : 74;
				var x1 = (cx + rIn * Math.cos(rad)).toFixed(1);
				var y1 = (cy + rIn * Math.sin(rad)).toFixed(1);
				var x2 = (cx + rOut * Math.cos(rad)).toFixed(1);
				var y2 = (cy + rOut * Math.sin(rad)).toFixed(1);
				var sW = (i % 3 === 0) ? 1.5 : 0.9;
				var sOp = (i % 3 === 0) ? 0.38 : 0.18;
				ticks += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="currentColor" stroke-opacity="' + sOp + '" stroke-width="' + sW + '"/>';
			}

			box.innerHTML =
				'<div class="mt-sig-box-head">' +
				'  <div class="mt-sig-box-title">' +
				'    <span class="mt-sig-tag">' + conf.code + '</span>' +
				'    <span>' + conf.title + '</span>' +
				'  </div>' +
				'  <div class="mt-sig-ref">' + conf.refText + '</div>' +
				'</div>' +
				'<div class="mt-sig-box-svg">' +
				'  <svg viewBox="0 0 200 156" width="100%" height="135" style="overflow:visible;">' +
				'    <defs>' +
				'      <filter id="glow-filter-' + type + '" x="-20%" y="-20%" width="140%" height="140%">' +
				'        <feGaussianBlur stdDeviation="3.2" result="blur"/>' +
				'        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>' +
				'      </filter>' +
				'      <radialGradient id="dish-grad-' + type + '" cx="50%" cy="50%" r="50%">' +
				'        <stop offset="0%" stop-color="#00f5a0" stop-opacity="0.12" class="dish-stop"/>' +
				'        <stop offset="100%" stop-color="transparent" stop-opacity="0"/>' +
				'      </radialGradient>' +
				'    </defs>' +
				'    <circle cx="' + cx + '" cy="' + cy + '" r="54" fill="url(#dish-grad-' + type + ')"/>' +
				'    ' + ticks +
				'    <path d="M 52.8 127 A 54 54 0 1 1 147.2 127" fill="none" stroke="rgba(125,125,125,0.12)" stroke-width="1" stroke-dasharray="3 3"/>' +
				'    <path d="M 46.3 127 A 62 62 0 1 1 153.7 127" fill="none" stroke="rgba(125,125,125,0.18)" stroke-width="7" stroke-linecap="round"/>' +
				'    <path class="g-arc-active" d="M 46.3 127 A 62 62 0 1 1 153.7 127" fill="none" stroke="#94a3b8" stroke-width="7" stroke-linecap="round" stroke-dasharray="' + totalArc + '" stroke-dashoffset="' + totalArc + '" style="transition: stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1), stroke 0.35s ease;" filter="url(#glow-filter-' + type + ')"/>' +
				'    <circle class="g-bead-halo" cx="46.3" cy="127" r="7.5" fill="#94a3b8" opacity="0.32" style="transition: cx 0.6s cubic-bezier(0.4,0,0.2,1), cy 0.6s cubic-bezier(0.4,0,0.2,1), fill 0.35s ease;"/>' +
				'    <circle class="g-bead" cx="46.3" cy="127" r="4.2" fill="#ffffff" style="transition: cx 0.6s cubic-bezier(0.4,0,0.2,1), cy 0.6s cubic-bezier(0.4,0,0.2,1);"/>' +
				'    <text class="g-val-text" x="' + cx + '" y="' + (cy - 1) + '" text-anchor="middle" font-size="36" font-weight="900" font-family=\"JetBrains Mono\", Consolas, monospace" fill="currentColor" letter-spacing="-0.8">—</text>' +
				'    <text class="g-unit-text" x="' + cx + '" y="' + (cy + 19) + '" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" opacity="0.6">' + conf.unit + '</text>' +
				'  </svg>' +
				'</div>' +
				'<div class="mt-sig-box-foot">' +
				'  <div class="mt-sig-pill g-pill" style="background:rgba(148,163,184,0.12);color:#94a3b8;border-color:rgba(148,163,184,0.25);">' +
				'    <span class="mt-sig-dot g-dot" style="background:#94a3b8;"></span>' +
				'    <span class="g-pill-txt">等待中</span>' +
				'  </div>' +
				'  <div class="mt-sig-sub g-sub-txt">初始化...</div>' +
				'</div>' +
				'<div class="mt-sig-bar-rail">' +
				'  <div class="mt-sig-bar-fill g-bar-fill"></div>' +
				'</div>';

			var arcActive = box.querySelector('.g-arc-active');
			var beadHalo = box.querySelector('.g-bead-halo');
			var bead = box.querySelector('.g-bead');
			var valText = box.querySelector('.g-val-text');
			var pill = box.querySelector('.g-pill');
			var dot = box.querySelector('.g-dot');
			var pillTxt = box.querySelector('.g-pill-txt');
			var subTxt = box.querySelector('.g-sub-txt');
			var barFill = box.querySelector('.g-bar-fill');
			var dishStop = box.querySelector('.dish-stop');

			return {
				el: box,
				set: function (val) {
					var res = conf.eval(val);
					var clamped = Math.max(0, Math.min(1, res.pct));
					var offset = totalArc * (1 - clamped);

					arcActive.style.strokeDashoffset = offset;
					arcActive.style.stroke = res.color;
					if (dishStop) dishStop.setAttribute('stop-color', res.color);

					var curDeg = 150 + clamped * 240;
					var curRad = curDeg * Math.PI / 180;
					var beadX = (cx + R * Math.cos(curRad)).toFixed(2);
					var beadY = (cy + R * Math.sin(curRad)).toFixed(2);

					beadHalo.setAttribute('cx', beadX);
					beadHalo.setAttribute('cy', beadY);
					beadHalo.setAttribute('fill', res.color);
					bead.setAttribute('cx', beadX);
					bead.setAttribute('cy', beadY);

					valText.textContent = (val != null && !isNaN(val)) ? val : '—';
					pill.style.background = 'rgba(125, 125, 125, 0.08)';
					pill.style.color = res.color;
					pill.style.borderColor = res.color;
					dot.style.background = res.color;
					pillTxt.textContent = res.text;
					subTxt.textContent = res.status;

					barFill.style.width = (clamped * 100).toFixed(1) + '%';
					barFill.style.backgroundColor = res.color;
				}
			};
		}

		var sigGauges = null;

		function renderSignal() {
			var c = state.cell;
			if (!sigGauges) {
				sigRow.innerHTML = '';
				sigGauges = {
					rsrp: createUltraSignalCard('rsrp'),
					rsrq: createUltraSignalCard('rsrq'),
					sinr: createUltraSignalCard('sinr'),
					pct: createUltraSignalCard('pct')
				};
				sigRow.appendChild(sigGauges.rsrp.el);
				sigRow.appendChild(sigGauges.rsrq.el);
				sigRow.appendChild(sigGauges.sinr.el);
				sigRow.appendChild(sigGauges.pct.el);
			}
			sigGauges.rsrp.set(c.rsrp);
			sigGauges.rsrq.set(c.rsrq);
			sigGauges.sinr.set(c.sinr);
			var pct = parseInt(c.signalPercent, 10);
			sigGauges.pct.set(isNaN(pct) ? null : pct);

			var primary = (state.carriers && state.carriers[0]) || {};
			verdict.set({
				rsrp: c.rsrp,
				rsrq: c.rsrq,
				sinr: c.sinr,
				pct: isNaN(pct) ? null : pct,
				sysMode: primary.sysMode || c.sysMode,
				dlFreqKHz: primary.dlFreqKHz,
				dlBwKHz: primary.bandwidth
			});
		}

		/* ---------- 3. 实时速率与曲线 ---------- */

		function splitSpeedUI(value, unitMode) {
			var bits = (unitMode === 'kbps') ? (value * 1000) : (value * 8);
			if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps', bps: bits };
			if (bits >= 1e6) return { value: (bits / 1e6).toFixed(2), unit: 'Mbps', bps: bits };
			if (bits >= 1e3) return { value: (bits / 1e3).toFixed(2), unit: 'Kbps', bps: bits };
			return { value: String(Math.round(bits)), unit: 'bps', bps: bits };
		}

		function renderSpeed() {
			var d = splitSpeedUI(state.rtDown, 'bytes');
			var u = splitSpeedUI(state.rtUp, 'bytes');
			if (d.bps > peakDown) peakDown = d.bps;
			if (u.bps > peakUp) peakUp = u.bps;
			var peakD = splitSpeedUI(peakDown / 8, 'bytes');
			var peakU = splitSpeedUI(peakUp / 8, 'bytes');

			speedRow.innerHTML =
				'<div class="mt-speed-hud">' +
				'  <div class="mt-speed-tile dl">' +
				'    <div class="mt-speed-label" style="color:#00b4d8;">↓ 实时下行速率 (Downlink)</div>' +
				'    <div style="display:flex;align-items:baseline;">' +
				'      <span class="mt-speed-val" style="color:#00b4d8;">' + d.value + '</span>' +
				'      <span class="mt-speed-unit">' + d.unit + '</span>' +
				'    </div>' +
				'    <div style="font-size:11px;opacity:0.65;margin-top:4px;">采样峰值: ' + peakD.value + ' ' + peakD.unit + '</div>' +
				'  </div>' +
				'  <div class="mt-speed-tile ul">' +
				'    <div class="mt-speed-label" style="color:#10b981;">↑ 实时上行速率 (Uplink)</div>' +
				'    <div style="display:flex;align-items:baseline;">' +
				'      <span class="mt-speed-val" style="color:#10b981;">' + u.value + '</span>' +
				'      <span class="mt-speed-unit">' + u.unit + '</span>' +
				'    </div>' +
				'    <div style="font-size:11px;opacity:0.65;margin-top:4px;">采样峰值: ' + peakU.value + ' ' + peakU.unit + '</div>' +
				'  </div>' +
				'</div>' +
				'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px;">' +
				'  <div style="font-size:11px;opacity:0.75;padding:8px 12px;border:1px dashed var(--mt-border);border-radius:6px;">' +
				'    <span>下行签约限制 (AMBR): </span><strong>' + (splitSpeedUI(state.ambrDown, 'kbps').value) + ' ' + (splitSpeedUI(state.ambrDown, 'kbps').unit) + '</strong>' +
				'  </div>' +
				'  <div style="font-size:11px;opacity:0.75;padding:8px 12px;border:1px dashed var(--mt-border);border-radius:6px;">' +
				'    <span>上行签约限制 (AMBR): </span><strong>' + (splitSpeedUI(state.ambrUp, 'kbps').value) + ' ' + (splitSpeedUI(state.ambrUp, 'kbps').unit) + '</strong>' +
				'  </div>' +
				'</div>';

			renderChart();
		}

		var chartHoverIdx = -1;

		/* 图表外壳只建一次：svg / 空态提示 / tooltip 均持久，避免每秒重绘清掉 hover 状态。
		   注意 E('svg') 会得到 HTMLUnknownElement，必须走 innerHTML 让解析器按 SVG 命名空间创建。 */
		function ensureChartShell() {
			if (chart._shellReady) return;
			chart._shellReady = true;
			chart.innerHTML = '';

			var holder = E('div');
			holder.innerHTML = '<svg class="mt-chart-svg" viewBox="0 0 600 175" preserveAspectRatio="none" ' +
				'style="display:block;width:100%;height:100%;overflow:visible;"></svg>';
			var svg = holder.firstElementChild;
			chart.appendChild(svg);
			chart._svg = svg;

			var hint = E('div', { 'class': 'mt-chart-hint' }, '正在建立网卡流量采样时序...');
			chart.appendChild(hint);
			chart._hint = hint;

			var tip = E('div', { 'class': 'mt-chart-tip' });
			chart.appendChild(tip);
			chart._tip = tip;

			chart.addEventListener('mousemove', function (ev) {
				handleChartHover(ev.clientX, ev.clientY);
			});
			chart.addEventListener('mouseleave', hideChartTip);
			chart.addEventListener('touchstart', function (ev) {
				if (ev.touches && ev.touches[0]) handleChartHover(ev.touches[0].clientX, ev.touches[0].clientY);
			}, { passive: true });
			chart.addEventListener('touchmove', function (ev) {
				if (ev.touches && ev.touches[0]) handleChartHover(ev.touches[0].clientX, ev.touches[0].clientY);
			}, { passive: true });
			chart.addEventListener('touchend', hideChartTip);
		}

		function handleChartHover(clientX, clientY) {
			var svg = chart._svg;
			if (!svg || !history.length) { hideChartTip(); return; }
			var rect = svg.getBoundingClientRect();
			if (!rect.width) return;
			var vbW = 600;
			var step = vbW / (HISTORY_POINTS - 1);
			var off = HISTORY_POINTS - history.length;
			var vbX = (clientX - rect.left) / rect.width * vbW;
			var idx = Math.round(vbX / step) - off;
			if (idx < 0 || idx >= history.length) { hideChartTip(); return; }
			showChartTip(idx, clientX, clientY);
		}

		function showChartTip(idx, clientX, clientY) {
			var tip = chart._tip;
			if (!tip) return;
			chartHoverIdx = idx;
			var d = history[idx] || { down: 0, up: 0 };
			var ago = history.length - 1 - idx;
			var dSp = splitSpeedUI(d.down || 0, 'bytes');
			var uSp = splitSpeedUI(d.up || 0, 'bytes');

			tip.innerHTML =
				'<div class="mt-chart-tip-time">' + (ago === 0 ? '当前采样' : ago + ' 秒前') + '</div>' +
				'<div class="mt-chart-tip-row"><i style="background:#00b4d8;"></i>下行<b>' + dSp.value + ' ' + dSp.unit + '</b></div>' +
				'<div class="mt-chart-tip-row"><i style="background:#10b981;"></i>上行<b>' + uSp.value + ' ' + uSp.unit + '</b></div>';
			tip.style.display = 'block';

			/* 定位：默认在光标右下方，贴近边界时自动翻到另一侧 */
			var hostRect = chart.getBoundingClientRect();
			var tw = tip.offsetWidth, th = tip.offsetHeight;
			var relX = clientX - hostRect.left, relY = clientY - hostRect.top;
			var left = relX + 14;
			if (left + tw > chart.clientWidth - 4) left = relX - tw - 14;
			if (left < 4) left = 4;
			var top = relY - th - 12;
			if (top < 4) top = relY + 18;
			if (top + th > chart.clientHeight - 4) top = chart.clientHeight - th - 4;
			tip.style.left = Math.round(left) + 'px';
			tip.style.top = Math.round(Math.max(4, top)) + 'px';

			drawChartCursor(idx);
		}

		function hideChartTip() {
			chartHoverIdx = -1;
			if (chart._tip) chart._tip.style.display = 'none';
			var svg = chart._svg;
			if (svg) {
				var c = svg.querySelector('.mt-chart-cursor');
				if (c && c.parentNode) c.parentNode.removeChild(c);
			}
		}

		function drawChartCursor(idx) {
			var svg = chart._svg, geo = chart._geo;
			if (!svg || !geo) return;
			var old = svg.querySelector('.mt-chart-cursor');
			if (old && old.parentNode) old.parentNode.removeChild(old);
			var d = history[idx];
			if (!d) return;
			var x = (idx + geo.offsetPoints) * geo.step;
			var yD = geo.H - ((d.down || 0) / geo.maxVal) * (geo.H - 26) - 10;
			var yU = geo.H - ((d.up || 0) / geo.maxVal) * (geo.H - 26) - 10;
			var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
			g.setAttribute('class', 'mt-chart-cursor');
			g.innerHTML =
				'<line x1="' + x + '" y1="3" x2="' + x + '" y2="' + (geo.H - 8) + '" stroke="rgba(125,125,125,0.6)" stroke-width="1" stroke-dasharray="3 3"/>' +
				'<circle cx="' + x + '" cy="' + yD + '" r="3.6" fill="#00b4d8" stroke="#ffffff" stroke-width="1.2"/>' +
				'<circle cx="' + x + '" cy="' + yU + '" r="3.6" fill="#10b981" stroke="#ffffff" stroke-width="1.2"/>';
			svg.appendChild(g);
		}

		function renderChart() {
			ensureChartShell();
			var svg = chart._svg;

			if (!history.length) {
				svg.innerHTML = '';
				chart._hint.style.display = '';
				hideChartTip();
				return;
			}
			chart._hint.style.display = 'none';

			var W = 600, H = 175;
			var maxVal = 1000;
			for (var i = 0; i < history.length; i++) {
				if (history[i].down > maxVal) maxVal = history[i].down;
				if (history[i].up > maxVal) maxVal = history[i].up;
			}
			maxVal = maxVal * 1.15;

			var step = W / (HISTORY_POINTS - 1);
			var offsetPoints = HISTORY_POINTS - history.length;

			function getCoords(key) {
				var pts = [];
				for (var idx = 0; idx < history.length; idx++) {
					var x = (idx + offsetPoints) * step;
					var val = history[idx][key] || 0;
					var y = H - (val / maxVal) * (H - 26) - 10;
					pts.push({ x: x, y: y });
				}
				return pts;
			}

			function buildSmooth(pts) {
				if (pts.length === 0) return '';
				if (pts.length === 1) return 'M ' + pts[0].x + ' ' + pts[0].y;
				var p = 'M ' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
				for (var k = 0; k < pts.length - 1; k++) {
					var cpX = (pts[k].x + pts[k + 1].x) / 2;
					p += ' C ' + cpX.toFixed(1) + ' ' + pts[k].y.toFixed(1) + ', ' + cpX.toFixed(1) + ' ' + pts[k + 1].y.toFixed(1) + ', ' + pts[k + 1].x.toFixed(1) + ' ' + pts[k + 1].y.toFixed(1);
				}
				return p;
			}

			var dPts = getCoords('down');
			var uPts = getCoords('up');
			var dPath = buildSmooth(dPts);
			var uPath = buildSmooth(uPts);
			var startX = (offsetPoints * step).toFixed(1);
			var dArea = dPath + ' L ' + W + ' ' + (H - 8) + ' L ' + startX + ' ' + (H - 8) + ' Z';
			var maxFormatted = splitSpeedUI(maxVal, 'bytes');

			svg.innerHTML =
				'  <defs>' +
				'    <linearGradient id="chartDlGrad" x1="0" y1="0" x2="0" y2="1">' +
				'      <stop offset="0%" stop-color="#00b4d8" stop-opacity="0.32"/>' +
				'      <stop offset="100%" stop-color="#00b4d8" stop-opacity="0.0"/>' +
				'    </linearGradient>' +
				'  </defs>' +
				'  <line x1="0" y1="' + (H - 10) + '" x2="' + W + '" y2="' + (H - 10) + '" stroke="rgba(125,125,125,0.18)" stroke-width="1"/>' +
				'  <line x1="0" y1="' + ((H - 26) / 2 + 10) + '" x2="' + W + '" y2="' + ((H - 26) / 2 + 10) + '" stroke="rgba(125,125,125,0.1)" stroke-width="1" stroke-dasharray="4 4"/>' +
				'  <text x="6" y="16" font-size="10" fill="currentColor" opacity="0.5" font-family="monospace">动态标尺上限: ' + maxFormatted.value + ' ' + maxFormatted.unit + '</text>' +
				'  <text x="' + (W - 6) + '" y="16" text-anchor="end" font-size="10" font-weight="700" fill="currentColor">' +
				'    <tspan fill="#00b4d8">● 下行</tspan> · <tspan fill="#10b981">-- 上行</tspan>' +
				'  </text>' +
				'  <path d="' + dArea + '" fill="url(#chartDlGrad)"/>' +
				'  <path d="' + dPath + '" fill="none" stroke="#00b4d8" stroke-width="2.4" stroke-linecap="round"/>' +
				'  <path d="' + uPath + '" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-dasharray="5 3"/>';

			/* 几何参数留给 hover 光标复用 */
			chart._geo = { H: H, step: step, offsetPoints: offsetPoints, maxVal: maxVal };

			if (chartHoverIdx >= 0 && history[chartHoverIdx]) drawChartCursor(chartHoverIdx);
		}

		/* ==================== 4. 模组温度全面优化：PCB 拓扑重构 + 4x2 完美平衡矩阵 ==================== */

		function getChipTempColor(temp) {
			if (!temp || temp <= 0) return { color: '#94a3b8', label: '无数据' };
			if (temp >= 85) return { color: '#ef4444', label: '过热' };
			if (temp >= 75) return { color: '#f97316', label: '警戒' };
			if (temp >= 60) return { color: '#f59e0b', label: '偏暖' };
			if (temp >= 40) return { color: '#10b981', label: '正常' };
			return { color: '#00b4d8', label: '清凉' };
		}

		function renderTemp() {
			tempBody.innerHTML = '';
			var t = state.temps;
			// 优化芯片坐标与尺寸，确保层次分明、导流线自然舒展
			var items = [
				{ label: 'Modem1 基带', value: t.modem1, x: 195, y: 16, w: 145, h: 66, type: 'soc' },
				{ label: 'AP1 主控', value: t.ap1, x: 26, y: 20, w: 118, h: 44, type: 'core' },
				{ label: 'AP2 核心', value: t.ap2, x: 26, y: 76, w: 118, h: 44, type: 'core' },
				{ label: 'Sub6G PA', value: t.sub6GPA, x: 390, y: 14, w: 120, h: 32, type: 'pa' },
				{ label: 'Sub3G PA', value: t.sub3GPA, x: 390, y: 52, w: 120, h: 32, type: 'pa' },
				{ label: 'MIMO PA', value: t.mimoPa, x: 390, y: 90, w: 120, h: 32, type: 'pa' },
				{ label: 'TCXO 晶振', value: t.tcxo, x: 215, y: 92, w: 105, h: 36, type: 'clock' }
			];

			var maxC = -1, sumC = 0, countC = 0;
			var svgChips = '';

			items.forEach(function (it) {
				var v = it.value || 0;
				if (v > 0) { sumC += v; countC++; }
				if (v > maxC) maxC = v;
				var st = getChipTempColor(v);

				// 芯片微封装：外引脚倒角 + 铜箔微边框 + 高亮温度标签
				svgChips +=
					'<g>' +
					'  <!-- 芯片本体与外扩散晕 -->' +
					'  <rect x="' + it.x + '" y="' + it.y + '" width="' + it.w + '" height="' + it.h + '" rx="5" fill="rgba(125,125,125,0.04)" stroke="' + st.color + '" stroke-width="1.6"/>' +
					'  <rect x="' + (it.x + 3) + '" y="' + (it.y + 3) + '" width="' + (it.w - 6) + '" height="' + (it.h - 6) + '" rx="3" fill="' + st.color + '" fill-opacity="0.08"/>' +
					'  <!-- 芯片定位点 -->' +
					'  <circle cx="' + (it.x + 8) + '" cy="' + (it.y + 8) + '" r="1.5" fill="' + st.color + '" opacity="0.6"/>' +
					'  <!-- 标签与实时温度 -->' +
					'  <text x="' + (it.x + it.w / 2) + '" y="' + (it.y + (it.h > 40 ? 16 : 13)) + '" font-size="9.5" font-weight="700" fill="currentColor" opacity="0.78" text-anchor="middle">' + it.label + '</text>' +
					'  <text x="' + (it.x + it.w / 2) + '" y="' + (it.y + it.h - (it.h > 40 ? 10 : 6)) + '" font-size="' + (it.h > 50 ? '16' : '13') + '" font-weight="900" font-family=\"JetBrains Mono\", monospace" fill="' + st.color + '" text-anchor="middle">' + (v ? v + ' ℃' : '—') + '</text>' +
					'</g>';
			});

			var avgC = countC ? (sumC / countC).toFixed(1) : '—';

			// 纯矢量高科技 PCB 沉金电路拓扑大图
			var svgLayout =
				'<div class="mt-temp-svg-wrap">' +
				'  <svg viewBox="0 0 535 136" width="100%" height="148" style="overflow:visible;max-height:100%;">' +
				'    <!-- PCB 沉金底板与安装孔 -->' +
				'    <rect x="4" y="4" width="527" height="128" rx="8" fill="rgba(125,125,125,0.02)" stroke="rgba(125,125,125,0.16)" stroke-width="1.2"/>' +
				'    <circle cx="14" cy="14" r="2.5" fill="none" stroke="rgba(125,125,125,0.25)" stroke-width="1"/>' +
				'    <circle cx="521" cy="14" r="2.5" fill="none" stroke="rgba(125,125,125,0.25)" stroke-width="1"/>' +
				'    <circle cx="14" cy="122" r="2.5" fill="none" stroke="rgba(125,125,125,0.25)" stroke-width="1"/>' +
				'    <circle cx="521" cy="122" r="2.5" fill="none" stroke="rgba(125,125,125,0.25)" stroke-width="1"/>' +
				'    <!-- 高速总线与热管导流线 -->' +
				'    <path d="M 144 42 L 195 42" stroke="rgba(0,180,216,0.35)" stroke-width="1.5" stroke-dasharray="3 2"/>' +
				'    <path d="M 144 96 L 170 96 L 195 62" fill="none" stroke="rgba(0,180,216,0.35)" stroke-width="1.5" stroke-dasharray="3 2"/>' +
				'    <path d="M 267 82 L 267 92" stroke="rgba(125,125,125,0.3)" stroke-width="1.5"/>' +
				'    <path d="M 340 30 L 390 30" stroke="rgba(16,185,129,0.35)" stroke-width="1.5" stroke-dasharray="3 2"/>' +
				'    <path d="M 340 48 L 365 48 L 390 66" fill="none" stroke="rgba(16,185,129,0.35)" stroke-width="1.5" stroke-dasharray="3 2"/>' +
				'    <path d="M 340 64 L 365 64 L 390 104" fill="none" stroke="rgba(16,185,129,0.35)" stroke-width="1.5" stroke-dasharray="3 2"/>' +
				'    ' + svgChips +
				'  </svg>' +
				'</div>';

			tempBody.innerHTML = svgLayout;

			// 构筑 4x2 完美平衡对称读数矩阵 (7 芯片 + 1 综合均温)
			var gridItems = items.concat([
				{ label: '芯片综合均温', value: avgC, isSummary: true }
			]);

			var grid = E('div', { 'class': 'mt-temp-grid-4x2' });
			gridItems.forEach(function (it) {
				var v = parseFloat(it.value) || 0;
				var st = getChipTempColor(v);
				var pct = Math.max(0, Math.min(100, (v / 100) * 100));

				var cell = E('div', { 'class': 'mt-temp-cell' }, [
					E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;' }, [
						E('span', { 'style': 'font-size:11px;font-weight:600;opacity:0.8;' }, it.label),
						E('span', { 'style': 'font-size:10px;font-weight:700;color:' + st.color + ';' }, st.label)
					]),
					E('div', { 'style': 'font-size:15px;font-weight:800;font-family:Consolas,monospace;color:' + st.color + ';' }, v ? v + ' ℃' : '—'),
					E('div', { 'class': 'mt-temp-gauge-bg' }, [
						E('div', { 'class': 'mt-temp-gauge-bar', 'style': 'width:' + pct + '%;background-color:' + st.color + ';' })
					])
				]);
				grid.appendChild(cell);
			});
			tempBody.appendChild(grid);

			if (tempBadge) {
				tempBadge.innerHTML = '';
				if (maxC > 0) {
					var badgeTone = maxC >= 75 ? 'danger' : (maxC >= 60 ? 'warning' : 'info');
					tempBadge.appendChild(Mt5700.badge('最高 ' + maxC.toFixed(1) + ' ℃ · ' + (Mt5700.tempLabel(maxC) || '—'), badgeTone));
				}
			}
		}

		/* ---------- 5. 载波聚合 CA ---------- */

		function renderCarriers() {
			carrierBox.innerHTML = '';
			var list = state.carriers || [];
			if (!list.length) {
				carrierBox.appendChild(E('div', { 'class': 'mt5700-hint' }, '未查询到激活载波（^HFREQINFO 无返回）'));
				renderSecondary();
				return;
			}

			var totalBw = 0;
			list.forEach(function (c) { totalBw += (c.bandwidth ? (c.bandwidth / 1000) : 20); });
			totalBw = Math.max(totalBw, 40);

			/* 画布 1200×100 使缩放比≈1（原 600×50 在千余像素宽下会把内容缩得很小） */
			var svgCa = '<div class="mt-ca-chart-box">' +
				'  <svg viewBox="0 0 1200 100" style="display:block;width:100%;height:auto;aspect-ratio:1200/100;">' +
				'    <rect x="0" y="88" width="1200" height="3" rx="1.5" fill="rgba(125,125,125,0.2)"/>';

			var GAP = 24, PAD = 6;
			var avail = 1200 - PAD * 2 - GAP * Math.max(0, list.length - 1);
			var curX = PAD;
			list.forEach(function (c, i) {
				var bw = c.bandwidth ? (c.bandwidth / 1000) : 20;
				var w = Math.max(220, Math.floor((bw / totalBw) * avail));
				var isPcc = (i === 0);
				var col = isPcc ? '#00b4d8' : '#10b981';
				var title = isPcc ? 'PCC 主载波' : 'SCC 辅载波 ' + i;
				var bandStr = c.band ? AtWs.bandName(c.sysMode, c.band) : (c.sysMode || 'Carrier');

				svgCa +=
					'    <g transform="translate(' + curX + ', 4)">' +
					'      <rect x="0" y="0" width="' + w + '" height="78" rx="10" fill="' + col + '" fill-opacity="0.12" stroke="' + col + '" stroke-width="1.6"/>' +
					'      <circle cx="24" cy="26" r="5" fill="' + col + '"/>' +
					'      <text x="40" y="31" font-size="15" font-weight="700" fill="' + col + '">' + title + '</text>' +
					'      <text x="24" y="61" font-size="12" font-family="monospace" fill="currentColor" opacity="0.75">' + bandStr + ' · ' + bw + ' MHz</text>' +
					'      <text x="' + (w - 24) + '" y="61" font-size="12" font-family="monospace" fill="currentColor" opacity="0.55" text-anchor="end">频点 ' + (c.channel || '—') + '</text>' +
					'    </g>';
				curX += w + GAP;
			});
			svgCa += '  </svg></div>';

			var caChartHost = E('div', { 'class': 'mt-ca-chart' });
			caChartHost.innerHTML = svgCa;
			carrierBox.appendChild(E('div', {}, [
				caChartHost,
				Mt5700.table(
					['角色', '制式', '频段', '频点', '下行频率', '带宽', 'RSRP', 'RSRQ', 'SINR'],
					list.map(function (c, idx) {
						var isPcc = idx === 0;
						var badge = E('span', { 'class': isPcc ? 'mt-pill-pcc' : 'mt-pill-ca' }, isPcc ? 'PCC 主载波' : 'SCC 辅载波 ' + idx);
						return [
							badge,
							c.sysMode || c.kind || '—',
							c.band != null ? AtWs.bandName(c.sysMode || c.kind, c.band) : '—',
							c.channel || '—',
							c.dlFreqKHz ? (c.dlFreqKHz / 1000) + ' MHz' : '—',
							c.bandwidth ? (c.bandwidth / 1000) + ' MHz' : '—',
							c.rsrp != null ? c.rsrp + ' dBm' : '—',
							c.rsrq != null ? c.rsrq + ' dB' : '—',
							c.sinr != null ? c.sinr + ' dB' : '—'
						];
					}),
					{ striped: true }
				)
			]));

			if (list.length === 1) {
				carrierBox.appendChild(E('div', { 'class': 'mt5700-hint', 'style': 'margin-top:8px;' },
					'当前仅 1 个激活载波（未做载波聚合）。信号三项取自 ^MONSC 主小区，与上方仪表盘同源。'));
			}
			renderSecondary();
		}

		/* ---------- 6. 辅载波信号 ---------- */

		function renderSecondary() {
			secondaryBox.innerHTML = '';
			var nr = state.secondaryNR || [];
			var lte = state.secondaryLTE || [];
			if (!nr.length && !lte.length) {
				var radarHtml =
					'<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px 0;opacity:0.85;">' +
					'  <svg viewBox="0 0 200 150" width="180" height="135">' +
					'    <circle cx="100" cy="75" r="55" fill="none" stroke="rgba(0,180,216,0.18)" stroke-width="1.2"/>' +
					'    <circle cx="100" cy="75" r="35" fill="none" stroke="rgba(0,180,216,0.25)" stroke-width="1.2"/>' +
					'    <circle cx="100" cy="75" r="15" fill="none" stroke="rgba(0,180,216,0.35)" stroke-width="1.2"/>' +
					'    <line x1="45" y1="75" x2="155" y2="75" stroke="rgba(125,125,125,0.2)" stroke-width="1"/>' +
					'    <line x1="100" y1="20" x2="100" y2="130" stroke="rgba(125,125,125,0.2)" stroke-width="1"/>' +
					'    <line class="mt-radar-line" x1="100" y1="75" x2="150" y2="40" stroke="#00b4d8" stroke-width="2" stroke-linecap="round"/>' +
					'  </svg>' +
					'  <div style="font-size:12px;font-weight:700;color:#00b4d8;margin-top:6px;">未挂载辅载波 (单载波 SA 模式)</div>' +
					'  <div style="font-size:11px;opacity:0.55;margin-top:2px;">基站当前未下发 SCC 分量配置，属于预期常态</div>' +
					'</div>';
				secondaryBox.innerHTML = radarHtml;
				return;
			}
			var merged = [];
			state.carriers.forEach(function (c, i) {
				var sig = Parse.carrierSignalFor({ sysMode: c.sysMode === 'NR' ? 'NR' : 'LTE', dlFcn: String(c.channel) }, nr, lte);
				merged.push({
					title: i === 0 ? '主载波' : '辅载波 ' + i,
					kind: c.sysMode || c.kind, band: c.band, channel: c.channel, bandwidth: c.bandwidth,
					sig: sig
				});
			});
			var rows = merged.map(function (m) {
				var mBw = m.bandwidth ? (m.bandwidth / 1000) + ' MHz' : '—';
				if (!m.sig) return [m.title, m.kind || '—', '—', m.channel || '—', mBw, '—', '—', '—', '—', '—'];
				return [
					m.title, m.kind || '—',
					m.band != null ? AtWs.bandName(m.kind, m.band) : '—',
					m.channel || '—', mBw, String(m.sig.pci),
					dash(m.sig.rsrp, ' dBm'), dash(m.sig.rsrq, ' dB'),
					m.sig.sinr != null ? dash(m.sig.sinr, ' dB') : dash(m.sig.rssi != null ? m.sig.rssi : null, ' dBm'),
					m.sig.measType || '—'
				];
			});
			secondaryBox.appendChild(Mt5700.table(
				['载波', '制式', '频段', '下行频点', '带宽', 'PCI', 'RSRP', 'RSRQ', 'SINR/RSSI', '测量'],
				rows,
				{ striped: true }
			));
		}

		/* ==================== 7. 流量统计 (2x2看板 + 上下行占比条) ==================== */

		function renderFlow() {
			flowBody.innerHTML = '';
			var f = state.flow;
			var sessionTime = AtWs.formatDuration(f.lastDsTime, false);
			var totalTime = AtWs.formatDuration(f.totalDsTime, true);
			var sessDl = AtWs.formatFlow(f.lastRxFlow);
			var sessUl = AtWs.formatFlow(f.lastTxFlow);
			var totDl = AtWs.formatFlow(f.totalRxFlow);
			var totUl = AtWs.formatFlow(f.totalTxFlow);

			var sumSess = (f.lastRxFlow || 0) + (f.lastTxFlow || 0);
			var dlPct = sumSess > 0 ? Math.round(((f.lastRxFlow || 0) / sumSess) * 100) : 50;

			var html =
				'<div class="mt-flow-sect">' +
				'  <div class="mt-flow-sect-head">' +
				'    <span class="mt-flow-title">⏱️ 本次连接会话</span>' +
				'    <span class="mt-flow-time">' + sessionTime + '</span>' +
				'  </div>' +
				'  <div class="mt-flow-duo">' +
				'    <div class="mt-flow-tile">' +
				'      <div class="mt-flow-sub" style="color:#00b4d8;">↓ 本次下行吞吐</div>' +
				'      <div class="mt-flow-num" style="color:#00b4d8;">' + sessDl + '</div>' +
				'    </div>' +
				'    <div class="mt-flow-tile">' +
				'      <div class="mt-flow-sub" style="color:#10b981;">↑ 本次上行吞吐</div>' +
				'      <div class="mt-flow-num" style="color:#10b981;">' + sessUl + '</div>' +
				'    </div>' +
				'  </div>' +
				'  <div style="margin-top:2px;">' +
				'    <div style="display:flex;justify-content:space-between;font-size:10px;opacity:0.65;">' +
				'      <span>下行占比 ' + dlPct + '%</span>' +
				'      <span>上行占比 ' + (100 - dlPct) + '%</span>' +
				'    </div>' +
				'    <div class="mt-flow-ratio-rail">' +
				'      <div class="mt-flow-ratio-dl" style="width:' + dlPct + '%;"></div>' +
				'    </div>' +
				'  </div>' +
				'</div>' +
				'<div class="mt-flow-sect">' +
				'  <div class="mt-flow-sect-head">' +
				'    <span class="mt-flow-title">📊 历史累计使用</span>' +
				'    <span class="mt-flow-time" style="color:currentColor;opacity:0.75;">' + totalTime + '</span>' +
				'  </div>' +
				'  <div class="mt-flow-duo">' +
				'    <div class="mt-flow-tile">' +
				'      <div class="mt-flow-sub">累计下行总计</div>' +
				'      <div class="mt-flow-num">' + totDl + '</div>' +
				'    </div>' +
				'    <div class="mt-flow-tile">' +
				'      <div class="mt-flow-sub">累计上行总计</div>' +
				'      <div class="mt-flow-num">' + totUl + '</div>' +
				'    </div>' +
				'  </div>' +
				'</div>';

			flowBody.innerHTML = html;
		}

		/* ==================== 8. IP 与 DNS (IPv4/IPv6 双栈卡片化) ==================== */

		function renderDHCP() {
			dhcpBody.innerHTML = '';
			var v4 = state.dhcpv4, v6 = state.dhcpv6;

			var ipv4Html =
				'<div class="mt-ip-block">' +
				'  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">' +
				'    <span style="font-size:12px;font-weight:700;color:#00b4d8;">🌐 IPv4 寻址与网关</span>' +
				'    <span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:rgba(0,180,216,0.15);color:#00b4d8;">DHCP就绪</span>' +
				'  </div>' +
				'  <div class="mt-ip-row"><span class="mt-ip-lbl">本机 IP 地址</span><span class="mt-ip-val" style="color:#00b4d8;font-size:12.5px;">' + (v4 ? v4.ipv4Address : '—') + '</span></div>' +
				'  <div class="mt-ip-row"><span class="mt-ip-lbl">子网掩码 / 网关</span><span class="mt-ip-val">' + (v4 ? (v4.subnetMask + ' / ' + v4.gateway) : '—') + '</span></div>' +
				'  <div class="mt-ip-row"><span class="mt-ip-lbl">首选 / 备用 DNS</span><span class="mt-ip-val">' + (v4 ? (v4.primaryDNS + ' / ' + v4.secondaryDNS) : '—') + '</span></div>' +
				'</div>';

			var ipv6Html =
				'<div class="mt-ip-block">' +
				'  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">' +
				'    <span style="font-size:12px;font-weight:700;color:#10b981;">⚡ IPv6 广域网双栈</span>' +
				'    <span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:rgba(16,185,129,0.15);color:#10b981;">' + (state.ipv6Cap ? state.ipv6Cap.description : '双栈可用') + '</span>' +
				'  </div>' +
				'  <div class="mt-ip-row"><span class="mt-ip-lbl">IPv6 前缀地址</span><span class="mt-ip-val" style="font-size:10.5px;color:#10b981;">' + (v6 && v6.ipv6Address ? v6.ipv6Address : '—') + '</span></div>' +
				'  <div class="mt-ip-row"><span class="mt-ip-lbl">IPv6 网关</span><span class="mt-ip-val" style="font-size:11px;">' + (v6 && v6.gateway ? v6.gateway : '::') + '</span></div>' +
				'  <div class="mt-ip-row"><span class="mt-ip-lbl">IPv6 DNS</span><span class="mt-ip-val" style="font-size:10.5px;">' + (v6 && v6.primaryDNS ? (v6.primaryDNS + ' / ' + (v6.secondaryDNS || '—')) : '—') + '</span></div>' +
				'</div>';

			dhcpBody.innerHTML = ipv4Html + ipv6Html;
		}

		/* ==================== 9. 调制方式与空间流 (新增上行频谱效率利用率) ==================== */

		function mcsDisplay(m) {
			if (!m || m.mcs == null) return { mod: '—', mcs: '—', rank: '—', full: '—' };
			var mod = Parse.mcsModulation(m.mcs) || 'QAM';
			var rank = m.rank ? m.rank : '1';
			return {
				mod: mod,
				mcs: m.mcs,
				rank: rank,
				full: mod + ' MCS ' + m.mcs + ' · ' + rank + ' 层'
			};
		}

		function renderConstellationSvg(modType, color) {
			var svg = '<svg viewBox="0 0 90 90" width="80" height="80" style="overflow:visible;">';
			svg += '<line x1="45" y1="6" x2="45" y2="84" stroke="rgba(125,125,125,0.22)" stroke-width="1"/>';
			svg += '<line x1="6" y1="45" x2="84" y2="45" stroke="rgba(125,125,125,0.22)" stroke-width="1"/>';
			svg += '<circle cx="45" cy="45" r="36" fill="none" stroke="rgba(125,125,125,0.12)" stroke-dasharray="3 3"/>';

			var pts = [];
			var type = (modType || '').toUpperCase();

			if (type.indexOf('QPSK') !== -1 || type.indexOf('BPSK') !== -1) {
				pts = [ {x: 28, y: 28}, {x: 62, y: 28}, {x: 28, y: 62}, {x: 62, y: 62} ];
			} else if (type.indexOf('16QAM') !== -1) {
				[22, 37, 53, 68].forEach(function (x) {
					[22, 37, 53, 68].forEach(function (y) { pts.push({ x: x, y: y }); });
				});
			} else {
				[16, 24, 32, 40, 50, 58, 66, 74].forEach(function (x) {
					[16, 24, 32, 40, 50, 58, 66, 74].forEach(function (y) { pts.push({ x: x, y: y }); });
				});
			}

			var r = pts.length <= 4 ? 3.6 : (pts.length <= 16 ? 2.5 : 1.6);
			pts.forEach(function (p) {
				svg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' + color + '"/>';
			});
			svg += '</svg>';
			return svg;
		}

		function renderMCS() {
			mcsBody.innerHTML = '';
			var dl = state.downlinkMCS, ul = state.uplinkMCS;
			var dlInfo = mcsDisplay(dl);
			var ulInfo = mcsDisplay(ul);

			var dlSvg = renderConstellationSvg(dlInfo.mod, '#00b4d8');
			var ulSvg = renderConstellationSvg(ulInfo.mod, '#10b981');

			// 依据 3GPP 物理层 28 阶 MCS 计算频谱效率利用率
			var dlEffPct = Math.min(100, Math.round(((parseInt(dlInfo.mcs, 10) || 0) / 28) * 100));
			var ulEffPct = Math.min(100, Math.round(((parseInt(ulInfo.mcs, 10) || 0) / 28) * 100));

			var html =
				'<!-- 1. 顶部 MCS 与调制方式 -->' +
				'<div class="mt-mcs-top">' +
				'  <div class="mt-mcs-tile dl">' +
				'    <div style="font-size:10.5px;font-weight:700;color:#00b4d8;text-transform:uppercase;">↓ 下行调制 (DL)</div>' +
				'    <div style="font-size:15px;font-weight:900;margin-top:2px;font-family:JetBrains Mono,monospace;">' + dlInfo.mod + ' MCS ' + dlInfo.mcs + '</div>' +
				'    <div style="font-size:10.5px;opacity:0.65;margin-top:2px;">' + dlInfo.rank + ' 层空间复用</div>' +
				'  </div>' +
				'  <div class="mt-mcs-tile ul">' +
				'    <div style="font-size:10.5px;font-weight:700;color:#10b981;text-transform:uppercase;">↑ 上行调制 (UL)</div>' +
				'    <div style="font-size:15px;font-weight:900;margin-top:2px;font-family:JetBrains Mono,monospace;">' + ulInfo.mod + ' MCS ' + ulInfo.mcs + '</div>' +
				'    <div style="font-size:10.5px;opacity:0.65;margin-top:2px;">' + ulInfo.rank + ' 层物理传输</div>' +
				'  </div>' +
				'</div>' +
				'<!-- 2. 中部核心：双正交 I/Q 星座图 -->' +
				'<div class="mt-constell-box">' +
				'  <div style="text-align:center;">' +
				'    <div style="font-size:10.5px;font-weight:700;color:#00b4d8;margin-bottom:6px;">下行 I/Q 星座态</div>' +
				'    ' + dlSvg +
				'  </div>' +
				'  <div style="width:1px;height:75px;background:rgba(125,125,125,0.15);"></div>' +
				'  <div style="text-align:center;">' +
				'    <div style="font-size:10.5px;font-weight:700;color:#10b981;margin-bottom:6px;">上行 I/Q 星座态</div>' +
				'    ' + ulSvg +
				'  </div>' +
				'</div>' +
				'<!-- 3. 底部双轨物理层频谱效率利用率条 (上行在上，下行在下) -->' +
				'<div style="background:rgba(125,125,125,0.03);border:1px solid var(--mt-border);border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:7px;">' +
				'  <!-- 上行频谱效率 -->' +
				'  <div>' +
				'    <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">' +
				'      <span style="opacity:0.75;">上行频谱效率利用率 (UL Eff)</span>' +
				'      <strong style="color:#10b981;font-family:monospace;">' + (ulEffPct || 20) + '%</strong>' +
				'    </div>' +
				'    <div style="width:100%;height:4px;background:rgba(125,125,125,0.12);border-radius:2px;overflow:hidden;">' +
				'      <div style="height:100%;width:' + (ulEffPct || 20) + '%;background:#10b981;border-radius:2px;transition:width 0.4s ease;"></div>' +
				'    </div>' +
				'  </div>' +
				'  <!-- 下行频谱效率 -->' +
				'  <div>' +
				'    <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;">' +
				'      <span style="opacity:0.75;">下行频谱效率利用率 (DL Eff)</span>' +
				'      <strong style="color:#00b4d8;font-family:monospace;">' + (dlEffPct || 20) + '%</strong>' +
				'    </div>' +
				'    <div style="width:100%;height:4px;background:rgba(125,125,125,0.12);border-radius:2px;overflow:hidden;">' +
				'      <div style="height:100%;width:' + (dlEffPct || 20) + '%;background:#00b4d8;border-radius:2px;transition:width 0.4s ease;"></div>' +
				'    </div>' +
				'  </div>' +
				'</div>';

			mcsBody.innerHTML = html;
		}

		/* ---------- 10. 基础连接与诊断常规渲染 ---------- */

		function renderConn() {
			connBody.innerHTML = '';
			var c = state.cell;
			var ambrD = splitSpeedUI(state.ambrDown, 'kbps');
			var ambrU = splitSpeedUI(state.ambrUp, 'kbps');
			var grid = E('div', { 'class': 'mt5700-metrics' });

			var prim = (state.carriers && state.carriers[0]) || {};
			var primRat = AtWs.ratLabel ? AtWs.ratLabel(c.sysMode || prim.sysMode) : (c.sysMode || '—');
			var primBand = prim.band != null ? AtWs.bandName(prim.sysMode === 'NR' ? 'NR' : 'LTE', prim.band) : '—';
			var primBw = prim.bandwidth ? (prim.bandwidth / 1000) + ' MHz' : '—';

			[
				{ label: '网络状态', value: state.networkStatus, color: 'info' },
				{ label: '运营商', value: state.operator },
				{ label: '网络模式', value: primRat },
				{ label: '信号强度', value: c.signalPercent || '—' },
				{ label: 'APN / QCI', value: state.apn + ' / QCI ' + state.qci },
				{ label: '主载波频段与带宽', value: primBand + ' (' + primBw + ')' },
				{ label: '下行签约速率 (AMBR)', value: ambrD.value + ' ' + ambrD.unit },
				{ label: '上行签约速率 (AMBR)', value: ambrU.value + ' ' + ambrU.unit }
			].forEach(function (it) {
				grid.appendChild(Mt5700.metric(it.label, it.value, it.color));
			});
			connBody.appendChild(grid);
			Mt5700.syncMetrics(grid);

			connBody.appendChild(Mt5700.table(
				['PLMN', 'LAC / 小区', 'PCI / 频点'],
				[[(c.mcc || '—') + ' / ' + (c.mnc || '—'), (c.lac || '—') + ' / ' + (c.cid || '—'), (c.pci || '—') + ' / ' + (c.channel || '—')]]
			));
		}

		function dash(v, unit) { return v == null ? '—' : v + unit; }

		function renderDiag() {
			diagBox.innerHTML = '';
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
			var txVal = d.tx ? (dash(d.tx.pusch, ' dBm') + ' / ' + dash(d.tx.pucch, ' dBm')) : '—';
			var txVal2 = d.tx ? (dash(d.tx.srs, ' dBm') + ' / ' + dash(d.tx.prach, ' dBm')) : '—';
			var rows = [
				['ENDC 双连接', endcTag],
				['5G 核心网注册', regVal],
				['TAC / 小区', d.reg && d.reg.tac ? (d.reg.tac + ' / ' + (d.reg.ci || '—')) : '—'],
				['网络切片', d.reg && d.reg.nssai ? d.reg.nssai : '—'],
				['LTE PUSCH / PUCCH', txVal],
				['LTE SRS / PRACH', txVal2]
			];
			if (d.tx && d.tx.total != null) rows.push(['2G/3G 总功率', dash(d.tx.total, ' dBm')]);
			(d.nrTx || []).forEach(function (c, i) {
				rows.push(['NR CC' + (i + 1) + ' PUSCH', dash(c.pusch, ' dBm') + (c.freq ? ' · ' + (c.freq / 1000).toFixed(1) + ' MHz' : '')]);
			});
			diagBox.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
			if (d.addrs && d.addrs.length) {
				diagBox.appendChild(E('div', { 'class': 'mt5700-hint', 'style': 'margin-top:8px;' }, 'PDP 地址：'));
				var ul = E('ul', { 'class': 'mt5700-agree-list' });
				d.addrs.forEach(function (a) {
					ul.appendChild(E('li', {}, 'CID ' + a.cid + ' · ' + a.family + '：' + a.address));
				});
				diagBox.appendChild(ul);
			} else {
				diagBox.appendChild(E('div', { 'class': 'mt5700-hint', 'style': 'margin-top:8px;' }, '没有已激活的 PDP 上下文地址。'));
			}
		}

		/* ---------- 11. AT 状态获取流程 ---------- */

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
					state.networkStatus = AtWs.psRegText(stat);
				}
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
							if (parts.length >= 3) {
								state.ambrDown = parseInt(parts[1], 10) || 0;
								state.ambrUp = parseInt(parts[2], 10) || 0;
							}
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
			});
		}

		function getDHCP() {
			return AtWs.client.sendCommand('AT^DHCPV6?').then(function (v6) {
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
			}).then(renderDHCP);
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
			});
		}

		function updateNetworkInfo() {
			var carriers = [];
			var serving = null;
			return AtWs.client.sendCommand('AT^MONSC').then(function (monsc) {
				serving = monsc.success && monsc.data ? AtWs.parseMONSC(monsc.data) : null;
				return AtWs.client.sendCommand('AT^HFREQINFO?');
			}).then(function (hfreq) {
				carriers = hfreq.success && hfreq.data ? AtWs.parseHFREQINFO(hfreq.data) : [];
				if (serving) {
					state.cell.mcc = serving.mcc; state.cell.mnc = serving.mnc;
					state.cell.lac = serving.lac; state.cell.cid = serving.cid;
					state.cell.channel = serving.channel; state.cell.pci = serving.pci;
					state.cell.rsrp = serving.rsrp != null ? serving.rsrp : state.cell.rsrp;
					state.cell.rsrq = serving.rsrq != null ? serving.rsrq : state.cell.rsrq;
					state.cell.sinr = serving.sinr != null ? serving.sinr : state.cell.sinr;
					state.cell.sysMode = serving.sysMode || state.cell.sysMode;
					state.cell.signalPercent = serving.signalPercent || '';
				}
				var needHcsq = state.cell.rsrp == null || state.cell.rsrq == null || state.cell.sinr == null;
				if (!needHcsq) return null;
				return AtWs.client.sendCommand('AT^HCSQ?').then(function (hcsq) {
					var hcsqData = hcsq.success && hcsq.data ? AtWs.parseHCSQ(hcsq.data) : null;
					if (hcsqData) {
						if (state.cell.rsrp == null) state.cell.rsrp = hcsqData.rsrp;
						if (state.cell.rsrq == null) state.cell.rsrq = hcsqData.rsrq;
						if (state.cell.sinr == null) state.cell.sinr = hcsqData.sinr;
						if ((!state.cell.sysMode || state.cell.sysMode === '未知') &&
							(hcsqData.networkMode === 'NR' || hcsqData.networkMode === 'LTE')) {
							state.cell.sysMode = hcsqData.networkMode;
						}
					}
					return null;
				});
			}).then(function () {
				var primaryMode = carriers.length ? String(carriers[0].sysMode || '').toUpperCase() : '';
				var servingMode = serving && serving.sysMode ? String(serving.sysMode).toUpperCase() : '';
				var sameRat = !!serving && (!primaryMode || !servingMode || primaryMode === servingMode);

				state.carriers = carriers.map(function (c, idx) {
					var isPrimary = idx === 0;
					var canFill = isPrimary && sameRat;
					return {
						sysMode: c.sysMode || c.kind || '',
						band: c.band ? Number(c.band) : null,
						channel: c.dlFcn || '',
						bandwidth: c.dlBwKHz || 0,
						dlFreqKHz: c.dlFreqKHz || 0,
						ulBwKHz: c.ulBwKHz || 0,
						pci: canFill && serving.pci != null ? serving.pci : null,
						rsrp: canFill && state.cell.rsrp != null ? state.cell.rsrp : null,
						rsrq: canFill && state.cell.rsrq != null ? state.cell.rsrq : null,
						sinr: canFill && state.cell.sinr != null ? state.cell.sinr : null
					};
				});
				renderSignal();
				renderCarriers();
				renderConn();
			});
		}

		function loadSecondary() {
			return AtWs.client.sendCommand('AT^MONSSC').then(function (monssc) {
				state.secondaryNR = monssc.success && monssc.data ? Parse.parseMonsscAll(String(monssc.data)) : [];
				return AtWs.client.sendCommand('AT^CASCELLINFO?');
			}).then(function (cascell) {
				state.secondaryLTE = cascell.success && cascell.data ? Parse.parseCascellAll(String(cascell.data)) : [];
				renderSecondary();
			});
		}

		function loadDiagnostics() {
			return AtWs.client.sendCommand('AT^LENDC?').then(function (lendc) {
				state.diag.endc = lendc.success && lendc.data ? Parse.parseLendc(lendc.data) : null;
				return AtWs.client.sendCommand('AT+C5GREG?');
			}).then(function (c5g) {
				state.diag.reg = c5g.success && c5g.data ? Parse.parseC5greg(c5g.data) : null;
				return AtWs.client.sendCommand('AT^TXPOWER?');
			}).then(function (txp) {
				state.diag.tx = txp.success && txp.data ? Parse.parseTxPower(txp.data) : null;
				return AtWs.client.sendCommand('AT^NTXPOWER?');
			}).then(function (ntxp) {
				state.diag.nrTx = ntxp.success && ntxp.data ? Parse.parseNrTxPower(ntxp.data) : [];
				return AtWs.client.sendCommand('AT+CGPADDR');
			}).then(function (pdp) {
				state.diag.addrs = pdp.success && pdp.data ? Parse.parseCgpaddr(pdp.data) : [];
				renderDiag();
			});
		}

		/* ---------- 12. 接口速率差分采样 ---------- */

		var rateSample = null;
		var rateTimer = null;

		function sampleRate() {
			return AtWs.netRate('').then(function (r) {
				if (!r.success) {
					rateSample = null;
					state.rtDown = 0;
					state.rtUp = 0;
					renderSpeed();
					return;
				}
				var now = Date.now();
				if (rateSample && rateSample.device === r.device) {
					var dt = (now - rateSample.t) / 1000;
					if (dt >= 0.2) {
						var drx = r.rx_bytes - rateSample.rx;
						var dtx = r.tx_bytes - rateSample.tx;
						state.rtDown = drx >= 0 ? drx / dt : 0;
						state.rtUp = dtx >= 0 ? dtx / dt : 0;
						history.push({ down: state.rtDown, up: state.rtUp });
						if (history.length > HISTORY_POINTS) history = history.slice(history.length - HISTORY_POINTS);
						rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
						renderSpeed();
						return;
					}
					return;
				}
				rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
			});
		}

		rateTimer = setInterval(sampleRate, 1000);
		sampleRate();

		/* ---------- 13. 统一调度刷新与挂载 ---------- */

		var refreshing = false;
		function refreshAll() {
			if (refreshing) return Promise.resolve();
			refreshing = true;
			var chain = Promise.resolve();
			[getPSReg, getOperator, getAMBR, getQCI, getDHCP, getFlow, getTemp, getMCS, updateNetworkInfo, loadSecondary, loadDiagnostics]
				.forEach(function (fn) { chain = chain.then(fn); });
			return chain.catch(function (err) {
				console.warn('刷新遥测数据异常', err);
			}).then(function () { refreshing = false; });
		}

		var timer = null;
		var ar = Ui.autoRefresh(function (enabled, interval) {
			if (timer) { clearInterval(timer); timer = null; }
			if (enabled) timer = setInterval(refreshAll, interval * 1000);
		});
		timer = setInterval(refreshAll, 5000);

		var actionContainer = E('div', { 'class': 'mt-actions-bar' }, [
			E('div', { 'style': 'display:flex;align-items:center;gap:10px;' }, [
				E('span', { 'style': 'font-size:12px;font-weight:700;opacity:0.75;' }, '⚙️ 遥测守护调度:'),
				ar.el
			]),
			Mt5700.primaryButton('立即刷新遥测', function () { refreshAll(); })
		]);
		body.appendChild(actionContainer);

		renderConn();
		renderSignal();
		renderCarriers();
		renderDiag();
		renderSpeed();
		renderFlow();
		renderTemp();
		renderDHCP();
		renderMCS();

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [
					{ key: 'key', label: '连接密钥', type: 'password', hint: '该密钥保存在 UCI at-webserver.websocket.auth_key' }
				], function (values) {
					if (!values.key) return;
					AtWs.client.connect(values.key).catch(function (e) { Mt5700.error((e && e.message) || '认证失败'); });
				});
				return;
			}
			if (err) console.warn('连接异常', err);
		}).then(function () {
			refreshAll();
		});

		self._dispose = function () {
			if (timer) clearInterval(timer);
			if (rateTimer) clearInterval(rateTimer);
		};

		return page;
	}
});
