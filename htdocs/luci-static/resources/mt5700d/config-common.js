// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require mt5700d/mt5700';
'require mt5700d/rpc';
/* global L, E, Mt5700, Mt5700d */

/*
 * Config 页面模块化公共工具。
 *
 * 把 service.js 里原本散落在单一 render 中的「读 / 写 / 校验 / 控件工厂」收敛到一处，
 * 供各配置模块（config-connection / config-notify / ...）共用，避免重复实现。
 * 所有函数保持与改造前完全一致的语义、默认值与夹取范围 —— 这是「UI 重构不改变
 * 业务逻辑」的关键：逻辑只搬家，不改写。
 */
var MtConfigCommon = (function () {
	var api = {};

	/* ---------- UCI 读写入口（单 section `config` + 扁平键，与 Rust/ucode 一致） ---------- */
	api.get = function (key, def) {
		var v = L.uci.get('mt5700d', 'config', key);
		return v == null || v === '' ? def : v;
	};
	api.set = function (key, value) {
		L.uci.set('mt5700d', 'config', key, value);
	};

	/* ---------- 数值 / 时间夹取与校验 ---------- */
	api.clampInt = function (raw, def, min, max) {
		var n = parseInt(raw, 10);
		if (isNaN(n)) return def;
		return Math.min(max, Math.max(min, n));
	};
	/* 允许 0 的夹取（不限频语义）：空/非法回落 def，0 照收 */
	api.clampIntAllowZero = function (raw, def, max) {
		var n = parseInt(raw, 10);
		if (isNaN(n) || n < 0) return def;
		return Math.min(max, n);
	};

	api.validHHMM = function (v) {
		var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
		if (!m) return false;
		var h = parseInt(m[1], 10);
		var mi = parseInt(m[2], 10);
		return h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
	};
	/* <input type="time"> 只认 HH:MM 且会静默清空非法值；统一校验补零，非法回落默认。 */
	api.setTimeInput = function (el, raw, def) {
		if (!api.validHHMM(raw)) { el.value = def; return; }
		var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(raw).trim());
		var h = parseInt(m[1], 10);
		var mi = parseInt(m[2], 10);
		el.value = (h < 10 ? '0' + h : String(h)) + ':' + (mi < 10 ? '0' + mi : String(mi));
	};
	api.readTime = function (el, def) {
		return api.validHHMM(el.value) ? el.value : def;
	};

	/* ---------- 多行文案 <-> UCI 的 \n 转义 ---------- */
	api.tplToUci = function (v) {
		return String(v == null ? '' : v)
			.replace(/\\/g, '\\\\')
			.replace(/\n/g, '\\n')
			.replace(/\r/g, '\\r')
			.replace(/\t/g, '\\t');
	};
	api.tplFromUci = function (v) {
		return String(v == null ? '' : v).replace(/\\([ntr\\])/g, function (m, c) {
			return c === 'n' ? '\n' : (c === 't' ? '\t' : (c === 'r' ? '\r' : '\\'));
		});
	};
	api.tplLoad = function (key, def) {
		var v = String(api.get(key, ''));
		return v === '' ? def : api.tplFromUci(v);
	};

	/* 内置默认文案：必须与 Rust config.rs 的 DEFAULT_TPL_* 保持一致。 */
	api.TPL_DEFAULTS = {
		prefix: '{time} {count}',
		sms: '新短信\n发送者：{sender}\n内容：{content}',
		call: '来电\n{content}',
		signal: '{content}',
		memory: '短信存储空间已满\n后果：清理前可能收不到新短信',
		qq_sms_md: '## 喵呜～收到新短信啦\n'
			+ '有新的消息送到喵，快来看看是谁给你寄来了信笺。\n'
			+ '**发送者：** `{sender}`\n'
			+ '**接收时间：** `{time}`\n'
			+ '**消息序号：** `{count}`\n'
			+ '\n'
			+ '---\n'
			+ '\n'
			+ '### 信笺内容\n'
			+ '\n'
			+ '{content}\n'
			+ '\n'
			+ '---\n'
			+ '\n'
			+ '*本喵已经把信笺整理好啦，记得及时查收喵。*'
	};

	/* ---------- 控件工厂（与改造前一致，方便模块内直接复用） ---------- */
	api.mkCheck = function () {
		var wrap = E('div', { 'class': 'mt5700-switch' });
		var input = E('input', { type: 'checkbox' });
		wrap.appendChild(input);
		return { wrap: wrap, input: input };
	};
	api.mkTplArea = function (rows) {
		var ta = E('textarea', { 'class': 'mt5700-input mt5700-tpl-area', rows: String(rows || 3) });
		ta.spellcheck = false;
		return ta;
	};

	/* 下拉 + 手动输入 + 联动显隐（连接接口用）。返回 { sel, custom, value() } */
	api.ifaceSelect = function (options, current, autoLabel, allowNone, state) {
		var sel = Mt5700.select(options || [], 'auto');
		var custom = Mt5700.input('text', allowNone ? '例如 wan6' : '例如 wan', '');
		function fill(cur) {
			while (sel.firstChild) sel.removeChild(sel.firstChild);
			function add(v, label) { sel.appendChild(E('option', { value: v }, label || v)); }
			add('auto', autoLabel);
			if (allowNone) add('none', '不使用 IPv6');
			(state || []).forEach(function (n) { add(n); });
			add('__custom__', '手动填写…');
			var c = cur || 'auto';
			var exists = false;
			for (var i = 0; i < sel.options.length; i++) {
				if (sel.options[i].value === c) { exists = true; break; }
			}
			if (!exists) add(c, c + '（当前配置，接口暂不存在）');
			sel.value = c;
			if (custom.parentElement) custom.parentElement.hidden = (c !== '__custom__');
		}
		fill(current);
		sel.addEventListener('change', function () {
			if (custom.parentElement) custom.parentElement.hidden = sel.value !== '__custom__';
		});
		return {
			sel: sel,
			custom: custom,
			value: function () {
				var v = sel.value === '__custom__' ? custom.value.trim() : sel.value;
				if (!v) v = 'auto';
				if (v === 'auto' || (allowNone && v === 'none')) return v;
				return /^[A-Za-z0-9_]+$/.test(v) ? v : null;
			}
		};
	};

	/* 防刷屏 / 时长的人性化文案（从 service.js 原样迁移） */
	api.rateText = function (min) {
		var raw = String(min == null ? '' : min).trim();
		var n = parseInt(raw, 10);
		if (raw === '' || isNaN(n) || n < 0) {
			return '当前值为空或非法，保存后按默认 1 小时处理';
		}
		if (n === 0) {
			return '不限频：每次判定为「有变化」都立即推送（制式来回切换时可能一分钟好几条）';
		}
		if (n > 10080) {
			return '当前值 ' + n + ' 分钟超出上限，保存后按 10080 分钟（7 天）处理';
		}
		var d = Math.floor(n / 1440), h = Math.floor((n % 1440) / 60), m = n % 60;
		var parts = [];
		if (d) parts.push(d + ' 天');
		if (h) parts.push(h + ' 小时');
		if (m || !parts.length) parts.push(m + ' 分钟');
		return '信号类通知最少间隔 ' + parts.join(' ') + '，即这段时间内最多一条';
	};

	/* 通用输入框样式（抽屉内表单，等宽字体仅文案模块需要；这里提供统一 textarea 规则挂载） */
	api.ensureFormStyles = function () {
		if (document.getElementById('mt5700-config-form-styles')) return;
		var st = E('style', { id: 'mt5700-config-form-styles' });
		st.textContent =
			'.mt5700-tpl-area{width:100%;box-sizing:border-box;min-height:74px;padding:8px 10px;'
			+ 'resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
			+ 'font-size:12.5px;line-height:1.5;white-space:pre-wrap;}'
			+ '.mt5700-cfg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;}'
			+ '.mt5700-cfg-span2{grid-column:1 / -1;}'
			+ '.mt5700-cfg-box{border:1px solid rgba(127,127,127,.25);border-radius:10px;'
			+ 'padding:12px 14px 2px;margin:8px 0 14px;background:rgba(127,127,127,.05);}'
			+ '.mt5700-cfg-title{font-size:13px;font-weight:600;opacity:.85;margin-bottom:10px;}'
			+ '.mt5700-cfg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}'
			+ '.mt5700-cfg-row input{flex:1 1 0;min-width:0;}'
			+ '.mt5700-cfg-sep{opacity:.7;font-size:12px;}'
			+ '@media (max-width: 640px){.mt5700-cfg-grid{grid-template-columns:1fr;}}';
		(document.head || document.body).appendChild(st);
	};

	return api;
})();

var MtConfigCommonClass = L.Class.extend(MtConfigCommon);
if (typeof window !== 'undefined') {
	window.MtConfigCommon = new MtConfigCommonClass();
}
return MtConfigCommonClass;
