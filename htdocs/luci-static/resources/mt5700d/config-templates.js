// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require mt5700d/mt5700';
'require mt5700d/rpc';
'require mt5700d/config-common';
/* global L, E, Mt5700, Mt5700d, MtConfigCommon */

/*
 * 配置模块：自定义推送文案。多行模板以 \n 转义存入 UCI，留空回落内置默认。
 * 「批量汇总标题」已删除（合并窗口移除后为孤立功能）。
 */
var MtConfigTemplates = (function () {
	var C = MtConfigCommon;

	function build(bodyEl, ctx) {
		C.ensureFormStyles();
		var baseline = {};
		bodyEl.appendChild(E('div', { 'class': 'mt5700-hint' },
			'四类事件各自的推送正文；留空则使用内置默认文案。多行按真实换行输入，保存时自动转义。'));
		var grid = E('div', { 'class': 'mt5700-cfg-grid' });
		bodyEl.appendChild(grid);

		var prefix = C.mkTplArea(2);
		var sms = C.mkTplArea(3), call = C.mkTplArea(3), signal = C.mkTplArea(3), memory = C.mkTplArea(3);
		var qqMd = C.mkTplArea(9);
		var PH = '可用占位符：{sender} 发送者 · {content} 事件正文 · {time} 事件时刻 · '
			+ '{kind} 事件类型 · {count} 本条消息条数；未识别的占位符原样保留。';

		function span(group) { group.classList.add('mt5700-cfg-span2'); return group; }
		span(grid.appendChild(Mt5700.formGroup('前缀（所有推送消息最前面）', prefix,
			'默认 {time} {count}；留空则不添加。测试通知也会带上它。')));
		grid.appendChild(Mt5700.formGroup('新短信', sms, PH));
		grid.appendChild(Mt5700.formGroup('来电', call, PH));
		grid.appendChild(Mt5700.formGroup('信号变化', signal, PH));
		grid.appendChild(Mt5700.formGroup('短信存储满', memory, PH));
		span(grid.appendChild(Mt5700.formGroup('QQ 富文本短信卡片', qqMd,
			'仅 QQ 富文本（Markdown）消息生效；企业微信与 QQ 纯文本仍用「新短信」模板。'
			+ '占位符：{sender} · {content} · {time} · {count}。留空=内置默认卡片；写成 {body}=通用转换。')));

		var resetStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var resetBtn = Mt5700.button('恢复默认文案', function () {
			prefix.value = C.TPL_DEFAULTS.prefix;
			sms.value = C.TPL_DEFAULTS.sms;
			call.value = C.TPL_DEFAULTS.call;
			signal.value = C.TPL_DEFAULTS.signal;
			memory.value = C.TPL_DEFAULTS.memory;
			qqMd.value = C.TPL_DEFAULTS.qq_sms_md;
			Mt5700d.uci.markDirty();
			resetStatus.textContent = '已填入默认文案，点击「保存」后生效';
		});
		bodyEl.appendChild(E('div', { 'class': 'mt5700-form-group' }, resetBtn, resetStatus));

		var ctrls = { prefix: prefix, sms: sms, call: call, signal: signal, memory: memory, qqMd: qqMd };
		function snap() {
			return Object.keys(ctrls).map(function (k) { return ctrls[k].value; }).join('\u0001');
		}
		function load() {
			prefix.value = C.tplFromUci(String(C.get('notify_tpl_prefix', '')));
			sms.value = C.tplLoad('notify_tpl_sms', C.TPL_DEFAULTS.sms);
			call.value = C.tplLoad('notify_tpl_call', C.TPL_DEFAULTS.call);
			signal.value = C.tplLoad('notify_tpl_signal', C.TPL_DEFAULTS.signal);
			memory.value = C.tplLoad('notify_tpl_memory', C.TPL_DEFAULTS.memory);
			qqMd.value = C.tplLoad('notify_tpl_qq_sms_md', C.TPL_DEFAULTS.qq_sms_md);
			baseline = snap();
		}
		function validate() { return null; }
		function save(set) {
			set('notify_tpl_prefix', C.tplToUci(prefix.value));
			set('notify_tpl_sms', C.tplToUci(sms.value));
			set('notify_tpl_call', C.tplToUci(call.value));
			set('notify_tpl_signal', C.tplToUci(signal.value));
			set('notify_tpl_memory', C.tplToUci(memory.value));
			set('notify_tpl_qq_sms_md', C.tplToUci(qqMd.value));
		}
		return {
			load: load, validate: validate, save: save,
			isDirty: function () { return snap() !== baseline; }
		};
	}

	return {
		meta: {
			key: 'templates',
			title: '推送文案',
			icon: 'op-edit',
			desc: '来电、短信、信号、存储满、QQ 富文本卡片与全局前缀的自定义模板'
		},
		build: build
	};
})();

var MtConfigTemplatesClass = L.Class.extend(MtConfigTemplates);
if (typeof window !== 'undefined') {
	window.MtConfigTemplates = new MtConfigTemplatesClass();
}
return MtConfigTemplatesClass;
