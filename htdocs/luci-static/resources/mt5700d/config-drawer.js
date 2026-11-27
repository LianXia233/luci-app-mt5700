// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require mt5700d/mt5700';
'require mt5700d/ui';
'require mt5700d/rpc';
/* global L, E, Mt5700, Ui, Mt5700d */

/*
 * 统一响应式配置弹窗：PC 右侧抽屉（Right Drawer）/ 移动端底部面板（Bottom Sheet）。
 *
 * 交互契约（PC 与移动端一致，均由 JS 实现而非纯 CSS 视觉伪装）：
 *   - 点击遮罩层 / 弹窗外部：不关闭（防误触；仅做一次轻微抖动提示）
 *   - 点击关闭按钮：走关闭逻辑
 *   - ESC：不直接关闭未处理的配置；无未保存修改时才允许关闭
 *   - 存在未保存修改：弹出二次确认，用户确认放弃后才丢弃
 *   - 保存/取消按钮明确；保存中禁用按钮防重复提交
 *   - 保存失败：保留用户已填数据、显示具体错误，不关闭
 *   - 焦点管理：打开后聚焦首个可交互控件，Tab 焦点锁在弹窗内，关闭后归还焦点
 *   - 滚动：内容区独立滚动、body 滚动锁定、移动端避免键盘遮挡与横向溢出
 *   - Android 视口变化：用 visualViewport 高度动态调整面板最大高度
 *
 * 用法：
 *   var d = MtConfigDrawer.open({
 *     title: '调制解调器连接',
 *     subtitle: '后端连接模组的通道',
 *     render: function (bodyEl, api) { ...; return { load: fn, validate: fn, save: fn }; },
 *     onSaved: function () { ... }   // 保存成功回调（刷新状态等）
 *   });
 *   render 返回的对象：
 *     load()            -> 从当前状态回填控件（打开时调用一次）
 *     validate()        -> 返回 null 表示通过，否则返回错误字符串
 *     save(set)         -> 用 set(key, value) 写入各配置项；可抛异常
 *   d.close() 可主动关闭（走未保存确认）。
 */
var MtConfigDrawer = (function () {
	var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
	var openStack = [];

	function injectStyles() {
		if (document.getElementById('mt5700-drawer-styles')) return;
		var st = E('style', { id: 'mt5700-drawer-styles' });
		st.textContent =
			'.mt5700-drawer-mask{position:fixed;inset:0;z-index:9000;background:rgba(10,14,22,.46);'
			+ 'backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);}'
			+ '.mt5700-drawer{position:absolute;background:var(--md-sys-color-surface-container-high,var(--mt5700-float-bg,#f7f7fa));'
			+ 'color:var(--md-sys-color-on-surface,var(--mt5700-text,var(--at-text,#1c2430)));display:flex;flex-direction:column;'
			+ 'box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden;}'
			+ 'html.at-dark .mt5700-drawer{background:var(--md-sys-color-surface-container-high,var(--mt5700-float-bg,#1a1f36));'
			+ 'color:var(--md-sys-color-on-surface,var(--mt5700-text,#f1f5f9));}'
			/* PC：右侧抽屉，固定视口右侧，限宽与最大高度，独立滚动，底部固定 */
			+ '@media (min-width: 641px){'
			+ '.mt5700-drawer{top:0;right:0;height:100%;width:min(520px,92vw);'
			+ 'border-radius:16px 0 0 16px;animation:mt5700-drawer-in .22s ease-out;}'
			+ '.mt5700-drawer-head{padding:18px 20px 12px;border-bottom:1px solid rgba(127,127,127,.2);}'
			+ '.mt5700-drawer-body{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:16px 20px;}'
			+ '.mt5700-drawer-foot{padding:12px 20px calc(14px + env(safe-area-inset-bottom,0px));'
			+ 'border-top:1px solid rgba(127,127,127,.2);display:flex;gap:10px;justify-content:flex-end;}'
			+ '}'
			/* 移动端：底部面板，顶部圆角，安全区适配，内容独立滚动，按钮常驻 */
			+ '@media (max-width: 640px){'
			+ '.mt5700-drawer{left:0;right:0;bottom:0;width:100%;max-height:86vh;'
			+ 'border-radius:20px 20px 0 0;animation:mt5700-sheet-in .24s ease-out;}'
			+ '.mt5700-drawer-head{padding:14px 16px 10px;border-bottom:1px solid rgba(127,127,127,.2);'
			+ 'position:relative;}'
			+ '.mt5700-drawer-head:before{content:"";position:absolute;top:6px;left:50%;transform:translateX(-50%);'
			+ 'width:38px;height:4px;border-radius:2px;background:rgba(127,127,127,.4);}'
			+ '.mt5700-drawer-body{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;'
			+ '-webkit-overflow-scrolling:touch;padding:12px 16px;}'
			+ '.mt5700-drawer-foot{padding:10px 16px calc(12px + env(safe-area-inset-bottom,0px));'
			+ 'border-top:1px solid rgba(127,127,127,.2);display:flex;gap:8px;}'
			+ '.mt5700-drawer-foot .mt5700-btn{flex:1 1 0;min-height:44px;}'
			+ '}'
			+ '.mt5700-drawer-head h3{margin:0;font-size:17px;font-weight:700;}'
			+ '.mt5700-drawer-head p{margin:4px 0 0;font-size:12.5px;opacity:.7;}'
			+ '.mt5700-drawer-close{position:absolute;top:10px;right:14px;width:34px;height:34px;'
			+ 'border-radius:50%;border:0;background:rgba(127,127,127,.16);color:inherit;cursor:pointer;'
			+ 'font-size:19px;line-height:34px;text-align:center;}'
			+ '.mt5700-drawer-err{color:#d33b3b;font-size:12.5px;margin:0 0 6px;min-height:0;}'
			+ 'html.at-dark .mt5700-drawer-err{color:#f87171;}'
			+ 'html.at-dark .mt5700-drawer-foot .mt5700-btn-ghost{color:var(--mt5700-modal-ghost-ink,#c9bcff)!important;}'
			+ '.mt5700-drawer-nudge{animation:mt5700-nudge .22s ease-in-out;}'
			+ '.mt5700-drawer-confirm{background:rgba(210,70,70,.12);border:1px solid rgba(210,70,70,.4);'
			+ 'border-radius:10px;padding:10px 12px;margin:0 0 10px;font-size:13px;}'
			+ '.mt5700-drawer-confirm .row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px;}'
			+ '@keyframes mt5700-drawer-in{from{transform:translateX(100%);}to{transform:translateX(0);}}'
			+ '@keyframes mt5700-sheet-in{from{transform:translateY(100%);}to{transform:translateY(0);}}'
			+ '@keyframes mt5700-nudge{0%,100%{transform:translateX(0);}25%{transform:translateX(-4px);}75%{transform:translateX(4px);}}';
		(document.head || document.body).appendChild(st);
	}

	function open(opts) {
		injectStyles();
		var mask = E('div', { 'class': 'mt5700-drawer-mask' });
		var panel = E('div', { 'class': 'mt5700-drawer', 'role': 'dialog', 'aria-modal': 'true' });
		var head = E('div', { 'class': 'mt5700-drawer-head' });
		var titleId = 'mt5700-drawer-title-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
		panel.setAttribute('aria-labelledby', titleId);
		var h3 = E('h3', { 'id': titleId }, opts.title || '配置');
		head.appendChild(h3);
		if (opts.subtitle) head.appendChild(E('p', {}, opts.subtitle));
		var closeBtn = E('button', { 'class': 'mt5700-drawer-close', 'type': 'button', 'aria-label': '关闭' }, '×');
		head.appendChild(closeBtn);

		var bodyEl = E('div', { 'class': 'mt5700-drawer-body' });
		var foot = E('div', { 'class': 'mt5700-drawer-foot' });
		var errEl = E('div', { 'class': 'mt5700-drawer-err' });
		var confirmWrap = E('div', { 'class': 'mt5700-drawer-confirm', 'style': 'display:none;' });
		var cancelBtn = Mt5700.button('取消', function () { requestClose(false); }, 'ghost');
		var saveBtn = Mt5700.primaryButton('保存', function () { doSave(); });
		foot.appendChild(errEl);
		foot.appendChild(cancelBtn);
		foot.appendChild(saveBtn);

		panel.appendChild(head);
		panel.appendChild(bodyEl);
		// 确认条插在 body 顶部，避免与底部按钮挤在一行
		bodyEl.insertBefore(confirmWrap, bodyEl.firstChild);
		panel.appendChild(foot);
		mask.appendChild(panel);

		var controller = null;
		var saved = false;
		var submitting = false;
		var confirmOpen = false;
		var prevFocus = document.activeElement;
		var prevOverflow = document.body.style.overflow;
		var vv = window.visualViewport;
		var vvHandler = null;
		// 打开前页面是否已有未保存更改：放弃关闭时只清除本抽屉引入的脏标记，
		// 不能把打开前就存在的页面级脏状态一并清掉。
		var prevDirty = Mt5700d.uci.isDirty();
		// 本抽屉经 L.uci.set 暂存过的键 → 首次写入前的原值（null=原本不存在）。
		// 保存失败后用户选择「放弃修改」时按此回滚，避免被放弃的值被后续
		// 其它模块的成功保存连带 commit（Codex P2）。
		var stagedBackup = {};
		// 最近一次保存失败是否发生在「save 已落盘、apply 失败」阶段：
		// 此时被放弃的值已在磁盘上，回滚不能只改内存暂存，还要重新 save。
		var saveCommitted = false;

		function revertStaged() {
			var keys = Object.keys(stagedBackup);
			if (!keys.length) return;
			keys.forEach(function (key) {
				var v = stagedBackup[key];
				if (v == null) L.uci.unset('mt5700d', 'config', key);
				else L.uci.set('mt5700d', 'config', key, v);
			});
			stagedBackup = {};
			if (saveCommitted) {
				// 变更已 commit 到磁盘：把回滚后的原值也落盘，恢复保存前状态。
				// 不 apply——失败的 apply 本就没让运行时重载，保持现状即可。
				L.uci.save('mt5700d').catch(function () { /* 落盘失败时内存暂存仍是原值，下次保存会带上 */ });
				saveCommitted = false;
			}
		}

		function showConfirm() {
			confirmOpen = true;
			confirmWrap.style.display = '';
			confirmWrap.innerHTML = '';
			confirmWrap.appendChild(E('div', {}, '有未保存的修改，确定要放弃并关闭吗？'));
			var row = E('div', { 'class': 'row' });
			row.appendChild(Mt5700.button('继续编辑', function () { hideConfirm(); }, 'ghost'));
			row.appendChild(Mt5700.button('放弃修改', function () {
				hideConfirm();
				forceClose();
			}, 'danger'));
			confirmWrap.appendChild(row);
			/* 确认条插在可滚动 body 的顶部，而「关闭」按钮在底部 foot：用户滚到底部
			 * 点关闭时确认条落在视野之外，表现为「点了没反应 / 关不掉」。这里把它
			 * 滚进视野，并把焦点放在「继续编辑」（不默认聚焦危险按钮）。 */
			if (typeof confirmWrap.scrollIntoView === 'function')
				confirmWrap.scrollIntoView({ block: 'nearest' });
			var firstBtn = row.querySelector('button');
			if (firstBtn && typeof firstBtn.focus === 'function') {
				try { firstBtn.focus(); } catch (e) { /* ignore */ }
			}
		}
		function hideConfirm() {
			confirmOpen = false;
			confirmWrap.style.display = 'none';
			confirmWrap.innerHTML = '';
		}
		function isDirty() {
			return !!(controller && typeof controller.isDirty === 'function' && controller.isDirty());
		}
		function requestClose(viaButton) {
			if (confirmOpen) { hideConfirm(); return; }
			if (submitting) return;
			if (isDirty()) { showConfirm(); return; }
			forceClose();
		}
		function forceClose() {
			// 放弃关闭：回滚本抽屉暂存过、但未成功保存的 UCI 键（Codex P2）。
			// 否则保存失败后选择「放弃修改」，这些被放弃的值仍留在暂存区，
			// 之后任何模块的一次成功保存都会把它们连带 commit。
			revertStaged();
			// 本抽屉引入的脏标记随之清除（打开前页面已有的脏状态保留）。
			if (!prevDirty) Mt5700d.uci.clearDirty();
			// 无条件通知模块清理自身资源（如通知模块的绑定进度轮询定时器），
			// 与是否保存无关；否则取消/放弃时定时器会随 DOM 销毁变成孤儿轮询。
			if (controller && typeof controller.onClose === 'function') controller.onClose();
			document.removeEventListener('keydown', onKey, true);
			if (vv && vvHandler) { vv.removeEventListener('resize', vvHandler); vv = null; }
			if (mask.parentNode) mask.parentNode.removeChild(mask);
			document.body.style.overflow = prevOverflow;
			var idx = openStack.indexOf(api);
			if (idx >= 0) openStack.splice(idx, 1);
			if (prevFocus && typeof prevFocus.focus === 'function') {
				try { prevFocus.focus(); } catch (e) { /* ignore */ }
			}
			if (typeof opts.onClose === 'function') opts.onClose(saved);
		}
		function nudge() {
			panel.classList.remove('mt5700-drawer-nudge');
			void panel.offsetWidth;
			panel.classList.add('mt5700-drawer-nudge');
		}
		function onKey(e) {
			// 只响应栈顶弹窗
			if (openStack[openStack.length - 1] !== api) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				if (confirmOpen) { hideConfirm(); return; }
				// ESC 不直接关闭有未保存修改的配置
				requestClose(false);
				return;
			}
			if (e.key === 'Tab') {
				var nodes = Array.prototype.filter.call(panel.querySelectorAll(FOCUSABLE), function (n) {
					return n.offsetParent !== null || n === document.activeElement;
				});
				if (!nodes.length) return;
				var first = nodes[0], last = nodes[nodes.length - 1];
				// 焦点已在弹窗外（如点击遮罩后落到 body）：拉回弹窗内，
				// 否则 Tab 会聚焦到背景页面，aria-modal 形同虚设。
				if (!panel.contains(document.activeElement)) {
					e.preventDefault();
					(e.shiftKey ? last : first).focus();
				}
				else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
				else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
			}
		}
		function doSave() {
			if (submitting) return;
			errEl.textContent = '';
			if (typeof controller.validate === 'function') {
				var problem = controller.validate();
				if (problem) { errEl.textContent = problem; return; }
			}
			submitting = true;
			saveBtn.disabled = true;
			cancelBtn.disabled = true;
			closeBtn.disabled = true;
			var ok = false;
			try {
				controller.save(function (key, value) {
					// 首次触碰的键记录写入前的原值，供放弃时回滚（含多次失败重试）。
					if (!Object.prototype.hasOwnProperty.call(stagedBackup, key)) {
						stagedBackup[key] = L.uci.get('mt5700d', 'config', key);
					}
					L.uci.set('mt5700d', 'config', key, value);
				});
				ok = true;
			} catch (e) {
				errEl.textContent = '保存失败：' + ((e && e.message) || '未知错误');
			}
			if (!ok) { submitting = false; saveBtn.disabled = false; cancelBtn.disabled = false; closeBtn.disabled = false; return; }

			Mt5700d.uci.markDirty();
			saveBtn.textContent = '保存中…';
			Mt5700d.uci.uciSave('mt5700d').then(function () {
				Mt5700d.uci.clearDirty();
				saved = true;
				// 已成功落盘：原值备份作废，之后的关闭不再回滚。
				stagedBackup = {};
				saveCommitted = false;
				if (typeof opts.onSaved === 'function') {
					// 回调异常（如刷新状态失败）不能误报成「保存失败」
					try { opts.onSaved(); } catch (e) { /* ignore */ }
				}
				// 成功：即使 isDirty 也不再询问（保存后基线已同步）
				if (controller && typeof controller.onClose === 'function') controller.onClose();
				document.removeEventListener('keydown', onKey, true);
				if (vv && vvHandler) { vv.removeEventListener('resize', vvHandler); vv = null; }
				if (mask.parentNode) mask.parentNode.removeChild(mask);
				document.body.style.overflow = prevOverflow;
				var idx = openStack.indexOf(api);
				if (idx >= 0) openStack.splice(idx, 1);
				if (prevFocus && typeof prevFocus.focus === 'function') { try { prevFocus.focus(); } catch (e) {} }
				if (typeof opts.onClose === 'function') opts.onClose(true);
			}).catch(function (err) {
				// 失败：保留用户已填数据，仅关闭提交锁，显示具体错误。
				// 记录失败阶段：save 已落盘时，放弃修改需要把回滚值重新落盘。
				saveCommitted = !!(err && err.uciSaveResult && err.uciSaveResult.saved);
				errEl.textContent = '保存失败：' + ((err && err.message) || '写入配置失败，请重试');
				Mt5700d.uci.markDirty();
			}).then(function () {
				submitting = false;
				saveBtn.disabled = false;
				cancelBtn.disabled = false;
				closeBtn.disabled = false;
				saveBtn.textContent = '保存';
			});
		}

		var api = {
			el: mask,
			close: function () { requestClose(true); }
		};

		// 事件绑定：遮罩与外部点击不关闭（只抖动提示），关闭按钮走关闭逻辑
		mask.addEventListener('click', function (e) {
			if (e.target === mask || (panel.contains(e.target) && !head.contains(e.target) && !foot.contains(e.target) && e.target === bodyEl)) {
				nudge();
			}
		});
		closeBtn.addEventListener('click', function () { requestClose(true); });

		// 抽屉挂在 body 下、不在 .mt5700-page 内，页面的 input/change 脏标记
		// 监听覆盖不到这里：必须自行接线，否则编辑后直接刷新/关页会静默丢改动
		// （Codex P2，与 service.js 页面级行为对齐）。
		panel.addEventListener('input', function () { Mt5700d.uci.markDirty(); });
		panel.addEventListener('change', function () { Mt5700d.uci.markDirty(); });

		// 挂载并初始化
		document.body.appendChild(mask);
		document.addEventListener('keydown', onKey, true);
		openStack.push(api);
		prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		// Android 视口变化（软键盘弹出/收起）：按 visualViewport 高度收紧最大高度，避免被遮挡
		if (window.visualViewport) {
			vvHandler = function () {
				var h = Math.floor(window.visualViewport.height);
				var p = panel;
				p.style.maxHeight = h + 'px';
			};
			window.visualViewport.addEventListener('resize', vvHandler);
		}

		try {
			controller = (typeof opts.render === 'function') ? opts.render(bodyEl, api) : {};
			if (controller && typeof controller.load === 'function') controller.load();
		} catch (e) {
			// 渲染/回填异常不能让抽屉卡死：显示错误并允许直接关闭
			controller = {};
			errEl.textContent = '配置界面初始化失败：' + ((e && e.message) || '未知错误');
		}
		// 焦点：优先内容区首个输入控件，其次面板内首个可聚焦控件（关闭按钮）
		var firstFocus = bodyEl.querySelector(FOCUSABLE) || panel.querySelector(FOCUSABLE);
		if (firstFocus && typeof firstFocus.focus === 'function') { try { firstFocus.focus(); } catch (e) {} }

		return api;
	}

	return { open: open };
})();

var MtConfigDrawerClass = L.Class.extend(MtConfigDrawer);
if (typeof window !== 'undefined') {
	window.MtConfigDrawer = new MtConfigDrawerClass();
}
return MtConfigDrawerClass;
