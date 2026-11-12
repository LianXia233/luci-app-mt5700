// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require baseclass';
/* global L */
/**
 * at-webserver/icons.js —— 全局 Icon Manager（双 UI 模式图标资源）
 * ---------------------------------------------------------------------------
 * 背景：本仓库原本没有独立的 .svg 文件，全部图标都是各视图 / 公共库里的
 * 内联 SVG 片段：
 *   - tabmenu.js        TAB_ICONS：12 个导航页签 + _fallback（24×24，stroke 1.8）
 *   - network_status.js svgIcon()：12 个卡片标题图标（24×24，stroke 2）
 *   - mt5700.js         cellularSignal / loading / 星座图 / MIMO 图
 *   - mt5700.css / logs.js 若干 data:image/svg+xml（下拉箭头、搜索等）
 *
 * 本模块把这些「实际使用的图标」逐一盘点成一张统一键值表，并提供两套资源：
 *
 *   NORMAL  —— 普通模式。**逐字搬运**现有内联 SVG 片段（nav- 与 st- 前缀），
 *              视觉与改造前完全一致；op- 前缀是按同一线性风格补齐的
 *              语义图标（现有页面不引用，不影响普通模式任何一页）。
 *   MINIMAL —— 极简模式。**全部重新绘制**：MD3 / Material Symbols 的几何
 *              造型语言，统一 24×24 viewBox、2px 描边、圆端点、2px 安全边距，
 *              不使用渐变 / 阴影 / 发光 / 滤镜，不复用 NORMAL 的路径数据。
 *
 * 两套表同时由 scripts/gen-dual-ui-icons.js 导出为真实的 .svg 资源文件：
 *   icons/normal/<key>.svg   icons/minimal/<key>.svg
 * 目录互相隔离，文件是项目内部可直接 <img>/CSS 引用的规范 SVG（currentColor）。
 *
 * 运行时「按模式自动选择」：所有经过 Icon Manager 创建的图标节点都带
 * data-mt-icon="<key>"；切换 UI 模式时 AtUimode 调用 refresh() 扫描 DOM 并
 * 重绘这些节点的内部图元，不重建业务组件、不重新初始化轮询。
 *
 * 模块求值时不触碰 DOM（纯数据 + 工厂函数），因此可被 Node 测试脚本用 vm
 * 直接加载来校验表与 .svg 产物的一致性。
 */

var AtIcons = (function () {
	var api = {};

	/* ================= 普通模式：逐字保留现有内联 SVG =================
	 * nav-* 来自 tabmenu.js TAB_ICONS；st-* 来自 network_status.js svgIcon()。
	 * 字符串与源码中的 path/circle/rect 完全一致，保证普通模式视觉零变化。
	 */
	var NORMAL = {
		/* ---- 导航页签（tabmenu.js，stroke-width 1.8） ---- */
		'nav-status': '<path d="M22 12h-4l-3 8-4-16-3 8H2"/>',
		'nav-settings': '<path d="M3 4h4M11 4h10"/><path d="M3 12h10M17 12h4"/><path d="M3 20h8M15 20h6"/><circle cx="9" cy="4" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="13" cy="20" r="2"/>',
		'nav-dial': '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v5"/>',
		'nav-scan': '<path d="M19.07 4.93a10 10 0 1 0-14.14 14.14"/><path d="M16.24 7.76a6 6 0 1 0-8.48 8.48"/><path d="M12 12 18.5 7.5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
		'nav-schedule': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		'nav-modem-settings': '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
		'nav-upgrade': '<circle cx="12" cy="12" r="9"/><path d="M12 16V8"/><path d="m8 12 4-4 4 4"/>',
		'nav-sms': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
		'nav-sms-settings': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="8.5" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1" fill="currentColor" stroke="none"/>',
		'nav-terminal': '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
		'nav-logs': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
		'nav-config': '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/><circle cx="12" cy="12" r="3"/>',
		'nav-fallback': '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',

		/* ---- 网络状态卡片标题（network_status.js svgIcon，stroke-width 2） ---- */
		'st-signal': '<path d="M2 20h20M6 16v4M10 12v8M14 8v12M18 4v16"/>',
		'st-globe': '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
		'st-activity': '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
		'st-trend': '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
		'st-bars': '<path d="M4 20v-4M9 20v-8M14 20v-13M19 20v-17"/>',
		'st-sim': '<rect x="3" y="3" width="18" height="18" rx="3.5"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.2"/><path d="M12 3v3M12 18v3"/>',
		'st-band': '<path d="M12 21V9"/><path d="M8.6 12.6a5 5 0 0 1 6.8 0"/><path d="M5.4 9.2a9.6 9.6 0 0 1 13.2 0"/>',
		'st-layers': '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>',
		'st-internet': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
		'st-ip': '<path d="M9.5 15.5H7a3.5 3.5 0 0 1 0-7h2.5"/><path d="M14.5 8.5H17a3.5 3.5 0 0 1 0 7h-2.5"/><path d="M8.5 12h7"/>',
		'st-ipv6': '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.8 2.8M16.2 16.2 19 19M19 5l-2.8 2.8M7.8 16.2 5 19"/>',
		'st-beam': '<circle cx="12" cy="20" r="1.6"/><path d="M12 18.4 5.5 5.5"/><path d="M12 18.4V4"/><path d="M12 18.4 18.5 5.5"/>',

		/* ---- 语义/业务操作图标：按现有线性风格补齐（现有页面不引用，零影响） ---- */
		'op-dashboard': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
		'op-network': '<path d="M22 12h-4l-3 8-4-16-3 8H2"/>',
		'op-signal': '<path d="M2 20h20M6 16v4M10 12v8M14 8v12M18 4v16"/>',
		'op-sim': '<rect x="3" y="3" width="18" height="18" rx="3.5"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.2"/><path d="M12 3v3M12 18v3"/>',
		'op-5g': '<circle cx="12" cy="12" r="9"/><path d="M8 9h4a2.5 2.5 0 0 1 0 5H8V9M8 14h4.5"/><path d="M16 9v6"/>',
		'op-band': '<path d="M12 21V9"/><path d="M8.6 12.6a5 5 0 0 1 6.8 0"/><path d="M5.4 9.2a9.6 9.6 0 0 1 13.2 0"/>',
		'op-cell': '<path d="M12 2 4 7v10l8 5 8-5V7z"/><path d="M12 7 8 9.5v5L12 17l4-2.5v-5z"/>',
		'op-sms': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
		'op-at': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3M12 15h6"/>',
		'op-device': '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 5h4"/><circle cx="12" cy="18" r="1" fill="currentColor" stroke="none"/>',
		'op-settings': '<path d="M3 4h4M11 4h10"/><path d="M3 12h10M17 12h4"/><path d="M3 20h8M15 20h6"/><circle cx="9" cy="4" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="13" cy="20" r="2"/>',
		'op-refresh': '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/>',
		'op-search': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
		'op-add': '<path d="M12 5v14M5 12h14"/>',
		'op-delete': '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
		'op-edit': '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
		'op-save': '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
		'op-check': '<path d="m5 12.5 4.5 4.5L19 7"/>',
		'op-cancel': '<path d="M6 6l12 12M18 6 6 18"/>',
		'op-warning': '<path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17v.1"/>',
		'op-error': '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v.1"/>',
		'op-back': '<path d="m15 5-7 7 7 7"/>',
		'op-navigation': '<path d="M12 2 3 21l9-4 9 4z"/>',
		'op-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.1"/>',
		'op-success': '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5 5.5-6"/>',
		'op-loading': '<circle cx="12" cy="12" r="9" opacity="0.3"/><path d="M12 3a9 9 0 0 1 9 9"/>',
		'op-dial': '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v5"/>',
		'op-scan': '<path d="M19.07 4.93a10 10 0 1 0-14.14 14.14"/><path d="M16.24 7.76a6 6 0 1 0-8.48 8.48"/><path d="M12 12 18.5 7.5"/>',
		'op-schedule': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		'op-modem': '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
		'op-upgrade': '<circle cx="12" cy="12" r="9"/><path d="M12 16V8"/><path d="m8 12 4-4 4 4"/>',
		'op-terminal': '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
		'op-logs': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
		'op-config': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
		'op-usb': '<path d="M12 21V7M12 7 9 10M12 7l3 3"/><circle cx="12" cy="21" r="1.5"/><path d="M7 3h10v4H7z"/>',
		'op-power': '<path d="M12 3v9"/><path d="M6.5 6.5a9 9 0 1 0 11 0"/>',
		'op-download': '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
		'op-upload': '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/>',
		'op-shield': '<path d="M12 2 4 5v7c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V5z"/><path d="m9 12 2 2 4-4"/>',
		'op-link': '<path d="M9.5 15.5H7a3.5 3.5 0 0 1 0-7h2.5"/><path d="M14.5 8.5H17a3.5 3.5 0 0 1 0 7h-2.5"/><path d="M8.5 12h7"/>',
		'op-close': '<path d="M6 6l12 12M18 6 6 18"/>',
		'op-filter': '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
		'op-clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		'op-file': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
		'op-theme': '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18"/>',
		'op-help': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7M12 17v.1"/>'
	};

	/* ================= 极简模式：全部重新绘制（MD3 几何语言） =================
	 * 与 NORMAL 无一条路径相同：改用圆角矩形 / 正多边形 / 阶梯方块 / 简化弧，
	 * 统一 2px 描边、round 端点、2px 安全边距，不依赖任何滤镜或渐变。
	 */
	var MINIMAL = {
		'nav-status': '<rect x="3" y="9" width="4" height="6" rx="1"/><rect x="8.5" y="6" width="4" height="12" rx="1"/><rect x="14" y="3" width="4" height="18" rx="1"/><path d="M20 12h2"/>',
		'nav-settings': '<path d="M12 2.5 20 7v10l-8 4.5L4 17V7z"/><circle cx="12" cy="12" r="3"/>',
		'nav-dial': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/><path d="M12 3v2M21 12h-2"/>',
		'nav-scan': '<path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',
		'nav-schedule': '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><rect x="7" y="13" width="4" height="4" rx="1" fill="currentColor" stroke="none"/>',
		'nav-modem-settings': '<rect x="4" y="4" width="16" height="16" rx="4"/><rect x="9" y="9" width="6" height="6" rx="1.5"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
		'nav-upgrade': '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 16V8M8.5 11.5 12 8l3.5 3.5"/>',
		'nav-sms': '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/><path d="M8 9h8M8 12.5h5"/>',
		'nav-sms-settings': '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/><circle cx="9" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="10.5" r="1.2" fill="currentColor" stroke="none"/>',
		'nav-terminal': '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m6.5 9.5 3 2.5-3 2.5M11.5 15h5"/>',
		'nav-logs': '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
		'nav-config': '<rect x="3" y="4" width="18" height="5" rx="2.5"/><rect x="3" y="15" width="18" height="5" rx="2.5"/><circle cx="8" cy="6.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="16" cy="17.5" r="1.6" fill="currentColor" stroke="none"/>',
		'nav-fallback': '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',

		'st-signal': '<rect x="3" y="15" width="3.5" height="6" rx="1.2"/><rect x="8" y="11" width="3.5" height="10" rx="1.2"/><rect x="13" y="7" width="3.5" height="14" rx="1.2"/><rect x="18" y="3" width="3.5" height="18" rx="1.2"/>',
		'st-globe': '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3v18"/>',
		'st-activity': '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m5 13 3.5-3.5 3 3L16 7l3 5"/>',
		'st-trend': '<path d="M3 18h4V13h4V8h4v5h4v5h2"/><rect x="3" y="18" width="18" height="2" rx="1"/>',
		'st-bars': '<rect x="3" y="14" width="4" height="7" rx="1"/><rect x="10" y="9" width="4" height="12" rx="1"/><rect x="17" y="4" width="4" height="17" rx="1"/>',
		'st-sim': '<rect x="5" y="2.5" width="14" height="19" rx="3"/><rect x="8.5" y="7" width="7" height="7" rx="1.5"/><path d="M9 18h6"/>',
		'st-band': '<path d="M3 18h18M5 13h14M8 8h8M11 3h2"/>',
		'st-layers': '<rect x="3" y="4" width="18" height="5" rx="2"/><rect x="3" y="10" width="18" height="5" rx="2"/><rect x="3" y="16" width="18" height="5" rx="2"/>',
		'st-internet': '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
		'st-ip': '<rect x="2.5" y="7" width="19" height="10" rx="3"/><path d="M7 12h10M7 12l2-2M7 12l2 2M17 12l-2-2M17 12l-2 2"/>',
		'st-ipv6': '<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M6.5 9.5h4M6.5 14.5h7"/><circle cx="17" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
		'st-beam': '<path d="M12 20 5 5M12 20V4M12 20l7-15"/><circle cx="12" cy="20" r="2" fill="currentColor" stroke="none"/>',

		'op-dashboard': '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>',
		'op-network': '<rect x="9" y="2.5" width="6" height="6" rx="1.5"/><rect x="2.5" y="15.5" width="6" height="6" rx="1.5"/><rect x="15.5" y="15.5" width="6" height="6" rx="1.5"/><path d="M12 8.5v3.5M5.5 15.5V12h13v3.5"/>',
		'op-signal': '<rect x="3" y="15" width="3.5" height="6" rx="1.2"/><rect x="8" y="11" width="3.5" height="10" rx="1.2"/><rect x="13" y="7" width="3.5" height="14" rx="1.2"/><rect x="18" y="3" width="3.5" height="18" rx="1.2"/>',
		'op-sim': '<rect x="5" y="2.5" width="14" height="19" rx="3"/><rect x="8.5" y="7" width="7" height="7" rx="1.5"/><path d="M9 18h6"/>',
		'op-5g': '<path d="M3 9.5a10 10 0 0 1 18 0"/><path d="M6.5 13a6 6 0 0 1 11 0"/><circle cx="12" cy="18" r="2" fill="currentColor" stroke="none"/>',
		'op-band': '<rect x="3" y="15" width="4" height="6" rx="1"/><rect x="10" y="9" width="4" height="12" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/>',
		'op-cell': '<path d="M12 2.5 20 7v10l-8 4.5L4 17V7z"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
		'op-sms': '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/><path d="M8 9h8M8 12.5h5"/>',
		'op-at': '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m6.5 9.5 3 2.5-3 2.5M11.5 15h5"/>',
		'op-device': '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M9.5 5h5"/><circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none"/>',
		'op-settings': '<path d="M12 2.5 20 7v10l-8 4.5L4 17V7z"/><circle cx="12" cy="12" r="3"/>',
		'op-refresh': '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15"/><path d="M4 20v-5h5"/>',
		'op-search': '<rect x="3" y="3" width="13" height="13" rx="3"/><path d="m13.5 13.5 6 6"/>',
		'op-add': '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
		'op-delete': '<rect x="4" y="6" width="16" height="15" rx="2"/><path d="M9 6V4h6v2M3 6h18M10 10v7M14 10v7"/>',
		'op-edit': '<rect x="3" y="16" width="18" height="5" rx="1.5"/><path d="M5 16 16 5l3 3L8 19"/>',
		'op-save': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 3v6h10V3M7 21v-7h10v7"/>',
		'op-check': '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5 5.5-6"/>',
		'op-cancel': '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
		'op-warning': '<rect x="2.5" y="2.5" width="19" height="19" rx="5"/><path d="M12 7v7M12 17v.1"/>',
		'op-error': '<path d="M12 2.5 21 7v10l-9 4.5L3 17V7z"/><path d="M12 8v5M12 16v.1"/>',
		'op-back': '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m13 8-4 4 4 4"/>',
		'op-navigation': '<path d="M12 2.5 20 21l-8-4-8 4z"/>',
		'op-info': '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 11v6M12 7.5v.1"/>',
		'op-success': '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9"/>',
		'op-loading': '<circle cx="12" cy="12" r="8.5" opacity="0.35"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/>',
		'op-dial': '<rect x="4" y="3" width="16" height="8" rx="3"/><path d="M12 11v4M8 21h8M9 15h6v6H9z"/>',
		'op-scan': '<path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/><path d="M8 12h8"/>',
		'op-schedule': '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><rect x="7" y="13" width="4" height="4" rx="1" fill="currentColor" stroke="none"/>',
		'op-modem': '<rect x="4" y="4" width="16" height="16" rx="4"/><rect x="9" y="9" width="6" height="6" rx="1.5"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
		'op-upgrade': '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 16V8M8.5 11.5 12 8l3.5 3.5"/>',
		'op-terminal': '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m6.5 9.5 3 2.5-3 2.5M11.5 15h5"/>',
		'op-logs': '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
		'op-config': '<rect x="3" y="4" width="18" height="5" rx="2.5"/><rect x="3" y="15" width="18" height="5" rx="2.5"/><circle cx="8" cy="6.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="16" cy="17.5" r="1.6" fill="currentColor" stroke="none"/>',
		'op-usb': '<rect x="7" y="2.5" width="10" height="5" rx="1.5"/><path d="M12 7.5V15M9 12l3 3 3-3"/><rect x="9" y="17" width="6" height="4.5" rx="1.5"/>',
		'op-power': '<rect x="4" y="4" width="16" height="16" rx="5"/><path d="M12 7v5"/><path d="M8.5 9.5a5 5 0 1 0 7 0"/>',
		'op-download': '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 7v10M8.5 13.5 12 17l3.5-3.5"/>',
		'op-upload': '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 17V7M8.5 10.5 12 7l3.5 3.5"/>',
		'op-shield': '<path d="M12 2.5 20 5.5v6.5c0 4.5-3.2 8-8 9.5-4.8-1.5-8-5-8-9.5V5.5z"/><path d="m9 12 2 2 4-4"/>',
		'op-link': '<rect x="2.5" y="8" width="9" height="8" rx="2.5"/><rect x="12.5" y="8" width="9" height="8" rx="2.5"/><path d="M9 12h6"/>',
		'op-close': '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
		'op-filter': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M9 13h6M11 17h2"/>',
		'op-clock': '<circle cx="12" cy="12" r="9"/><rect x="11" y="6.5" width="2" height="6" rx="1" fill="currentColor" stroke="none"/><path d="m12 12 3.5 2"/>',
		'op-file': '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
		'op-theme': '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
		'op-help': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.1 1-1.1 1.8M12 17v.1"/>'
	};

	/* 中文可读名：用于 role="img" 的 aria-label（无障碍） */
	var LABELS = {
		'nav-status': '网络状态', 'nav-settings': '网络设置', 'nav-dial': '拨号设置',
		'nav-scan': '全网扫频', 'nav-schedule': '定时锁频', 'nav-modem-settings': '模组设置',
		'nav-upgrade': '模组升级', 'nav-sms': '短信中心', 'nav-sms-settings': '短信设置',
		'nav-terminal': 'AT 调试终端', 'nav-logs': '运行日志', 'nav-config': '服务配置',
		'nav-fallback': '页面',
		'st-signal': '信号强度', 'st-globe': '全球网络', 'st-activity': '实时速率',
		'st-trend': '信号趋势', 'st-bars': '电平柱状', 'st-sim': 'SIM 卡',
		'st-band': '频段', 'st-layers': '协议层', 'st-internet': '互联网',
		'st-ip': 'IP 地址', 'st-ipv6': 'IPv6', 'st-beam': 'SSB 波束',
		'op-dashboard': '仪表盘', 'op-network': '网络状态', 'op-signal': '信号强度',
		'op-sim': 'SIM 卡', 'op-5g': '5G 网络', 'op-band': '频段', 'op-cell': '小区信息',
		'op-sms': '短信', 'op-at': 'AT 命令', 'op-device': '设备信息', 'op-settings': '设置',
		'op-refresh': '刷新', 'op-search': '搜索', 'op-add': '添加', 'op-delete': '删除',
		'op-edit': '编辑', 'op-save': '保存', 'op-check': '确认', 'op-cancel': '取消',
		'op-warning': '警告', 'op-error': '错误', 'op-back': '返回', 'op-navigation': '导航',
		'op-info': '信息', 'op-success': '成功', 'op-loading': '加载中', 'op-dial': '拨号',
		'op-scan': '扫频', 'op-schedule': '定时', 'op-modem': '模组', 'op-upgrade': '升级',
		'op-terminal': '终端', 'op-logs': '日志', 'op-config': '服务配置', 'op-usb': 'USB',
		'op-power': '电源', 'op-download': '下载', 'op-upload': '上传', 'op-shield': '安全',
		'op-link': '连接', 'op-close': '关闭', 'op-filter': '筛选', 'op-clock': '时钟',
		'op-file': '文件', 'op-theme': '主题', 'op-help': '帮助'
	};

	api.normal = NORMAL;
	api.minimal = MINIMAL;
	api.labels = LABELS;
	api.keys = Object.keys(NORMAL);
	api.ATTR = 'data-mt-icon';

	api.has = function (name) {
		return Object.prototype.hasOwnProperty.call(NORMAL, name)
			&& Object.prototype.hasOwnProperty.call(MINIMAL, name);
	};

	/* 当前模式：只依赖全局 AtUimode；未加载时按 normal 兜底（安全回退） */
	function currentMode() {
		try {
			if (typeof window !== 'undefined' && window.AtUimode
				&& typeof window.AtUimode.current === 'function') {
				return window.AtUimode.current() === 'minimal' ? 'minimal' : 'normal';
			}
		} catch (e) { /* ignore */ }
		return 'normal';
	}
	api.currentMode = currentMode;

	function table(mode) {
		return mode === 'minimal' ? MINIMAL : NORMAL;
	}

	/* 普通模式导航图标沿用 tabmenu.js 的 1.8 描边，其余 2；极简模式统一 2 */
	function strokeWidth(name, mode) {
		if (mode === 'minimal') return 2;
		return name.indexOf('nav-') === 0 ? 1.8 : 2;
	}
	api.strokeWidth = strokeWidth;

	function markup(name, mode) {
		var t = table(mode);
		return Object.prototype.hasOwnProperty.call(t, name) ? t[name] : t['nav-fallback'];
	}
	api.markup = markup;

	/* 一份完整、规范的 SVG 文档（用于生成 .svg 文件 / 单测断言） */
	api.svgDocument = function (name, mode) {
		var m = mode === 'minimal' ? 'minimal' : 'normal';
		var label = LABELS[name] || name;
		return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
			+ 'width="24" height="24" fill="none" stroke="currentColor" '
			+ 'stroke-width="' + strokeWidth(name, m) + '" stroke-linecap="round" '
			+ 'stroke-linejoin="round" role="img" aria-label="' + label + '" '
			+ 'focusable="false" data-ui-mode="' + m + '">'
			+ markup(name, m) + '</svg>\n';
	};

	/* 把 key 对应的图元画进已有的 <svg> 节点（切换模式时复用节点，不重建 DOM） */
	api.paint = function (svg, name) {
		if (!svg || typeof svg.setAttribute !== 'function') return svg;
		var mode = currentMode();
		var key = svg.getAttribute(api.ATTR) || name;
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', String(strokeWidth(key, mode)));
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', LABELS[key] || key);
		svg.setAttribute('focusable', 'false');
		svg.setAttribute('data-ui-mode', mode);
		if (typeof svg.innerHTML === 'string' || svg.innerHTML != null) {
			try { svg.innerHTML = markup(key, mode); } catch (e) { /* 老引擎降级：保留原图元 */ }
		}
		return svg;
	};

	/**
	 * 创建并注册一个图标 <svg>。
	 * opts.w / opts.h 只影响展示尺寸，不改变 viewBox 与图元（与原有调用一致）。
	 */
	api.build = function (name, opts) {
		if (typeof document === 'undefined' || !document.createElementNS) return null;
		var o = opts || {};
		var key = api.has(name) ? name : 'nav-fallback';
		var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute(api.ATTR, key);
		if (o.className) svg.setAttribute('class', o.className);
		if (o.w) svg.setAttribute('width', String(o.w));
		if (o.h) svg.setAttribute('height', String(o.h));
		return api.paint(svg, key);
	};

	/**
	 * 模式切换后重绘页面上所有已注册图标。
	 * 只改 <svg> 内部图元，不动任何业务 DOM、不重新初始化组件/轮询。
	 */
	api.refresh = function () {
		if (typeof document === 'undefined' || !document.querySelectorAll) return 0;
		var nodes = document.querySelectorAll('svg[' + api.ATTR + ']');
		for (var i = 0; i < nodes.length; i++) api.paint(nodes[i]);
		return nodes.length;
	};

	return api;
})();

var AtIconsClass = L.Class.extend(AtIcons);
if (typeof window !== 'undefined') {
	window.AtIcons = new AtIconsClass();
}
return AtIconsClass;
