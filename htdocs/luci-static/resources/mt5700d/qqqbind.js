// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require mt5700d/mt5700';
/* global L, E, Mt5700 */

/*
 * QQ 机器人「扫码绑定」独立模块。
 *
 * 为什么单独成文件：扫码是一条完整的小业务链（申请任务 → 画二维码 → 轮询 →
 * 回填表单 → 处理过期/取消），塞进通知配置页会把 config-notify.js 撑成第二个
 * 万能文件。这里只对外暴露一个 mount()，通知页负责把三个输入框交进来即可。
 *
 * 凭据边界：AppSecret 由后端解密后直接写 UCI，本模块拿到的只有 AppID 与 openid，
 * 不存在「前端接触明文密钥」这条路径。
 *
 * 用法（在配置页里）：
 *   'require mt5700d/qqqbind';
 *   MtQqBind.mount(bodyEl, {
 *       appId: qqAppId,          // AppID 输入框（会被回填）
 *       targetId: qqTargetId,    // 目标 ID 输入框（会被回填 openid）
 *       target: qqTarget,        // 目标类型下拉框（有 openid 时切到 c2c）
 *       enabled: qq.input        // QQ 推送开关（绑定成功后自动勾上）
 *   });
 */

var MtQqBind = (function () {
	/* 后端单次 HTTP 预算 10s，轮询间隔取 2s：与官方 SDK 的节奏一致，
	 * 再密只会把路由器 CPU 和 QQ 侧限流一起打满，再疏则扫码后要等明显一拍。 */
	var POLL_INTERVAL = 2000;
	/* 断线退避：5G 重拨 / 基站切换 / 换小区后连续断网十几秒是常态，固定 2s×3
	 * 次（6s）就放弃会把「马上就能扫完」的流程打断。这里指数退避到 15s 封顶，
	 * 总预算 ≈ 2+4+8+15×5 ≈ 89s，仍以「二维码本身已过期」为真正的终止条件。 */
	var MAX_ERROR_DELAY = 15000;
	var MAX_CONSECUTIVE_ERRORS = 8;

	function mount(bodyEl, hooks) {
		var h = hooks || {};

		var startRpc = L.rpc.declare({ object: 'mt5700', method: 'qq_qr_start', params: ['source', '_rid'], expect: {} });
		var pollRpc = L.rpc.declare({ object: 'mt5700', method: 'qq_qr_poll', params: ['_rid'], expect: {} });
		var cancelRpc = L.rpc.declare({ object: 'mt5700', method: 'qq_qr_cancel', params: ['_rid'], expect: {} });

		var panel = E('div', { 'class': 'mt5700-form-group', 'style': 'display:none' });
		// 固定画布 + 整数倍缩放：二维码是像素图案，带小数的缩放会把定位图案糊成灰边
		var canvas = E('canvas', { 'width': '256', 'height': '256',
			'style': 'width:256px;max-width:100%;height:auto;background:#fff;border-radius:8px;'
				+ 'padding:8px;box-sizing:border-box' });
		var urlLink = E('a', { 'target': '_blank', 'rel': 'noopener noreferrer',
			'class': 'mt5700-hint', 'style': 'display:block;word-break:break-all' }, '');
		var status = E('span', { 'class': 'mt5700-hint' }, '');
		var pending = false;   // 有未完成的任务：决定「关闭」时要不要通知后端取消
		var busy = false;      // 申请中：防连点重复出码
		var timer = null;
		var errors = 0;
		var bound = false;     // 已成功：重开面板时不再自动申请

		function draw(qr) {
			if (!qr || !qr.size || !qr.rows) return;
			var size = parseInt(qr.size, 10) || 0;
			var quiet = 4;                 // 静区：扫码器靠它定位，少于 4 个模块识别率明显下降
			var total = size + quiet * 2;
			var scale = Math.max(1, Math.floor(256 / total));
			canvas.width = total * scale;
			canvas.height = total * scale;
			/* 按位图真实像素设宽：CSS 里写死 256px 会把 245px 的位图做非整数放大，
			 * 定位图案多出灰边，低端扫码器识别率明显下降。只改 width，height 保持
			 * auto，窄屏 max-width:100% 缩小时仍能按 1:1 比例缩放。 */
			canvas.style.width = canvas.width + 'px';
			var g = canvas.getContext('2d');
			g.fillStyle = '#fff';
			g.fillRect(0, 0, canvas.width, canvas.height);
			g.fillStyle = '#000';
			for (var y = 0; y < size; y++) {
				var row = String(qr.rows[y] || '');
				for (var x = 0; x < size; x++) {
					if (row.charAt(x) === '1')
						g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
				}
			}
		}

		function stopPoll() {
			if (timer) { clearTimeout(timer); timer = null; }
		}

		function close(cancel) {
			stopPoll();
			panel.style.display = 'none';
			if (cancel && pending) {
				pending = false;
				cancelRpc('qrcancel-' + Date.now()).catch(function () {
					/* 取消失败无副作用：未完成的服务端任务会自行过期 */
				});
			}
		}

		function begin() {
			if (busy) return;
			busy = true;
			errors = 0;
			panel.style.display = '';
			status.textContent = '正在向 QQ 开放平台申请绑定任务…';
			startRpc('mt5700d', 'qrstart-' + Date.now()).then(function (res) {
				if (!res || !res.success) throw new Error((res && res.error) || '申请失败');
				draw(res.qr);
				urlLink.href = res.url;
				urlLink.textContent = res.url;
				pending = true;
				status.textContent = '用手机 QQ 扫码，在打开的页面上勾选机器人并点「连接」'
					+ '（二维码过期会自动换一张）';
				stopPoll();
				timer = setTimeout(poll, POLL_INTERVAL);
			}).catch(function (err) {
				pending = false;
				status.textContent = '申请失败：' + ((err && err.message) || err)
					+ '（确认路由器已拨号、系统时间正确后可重试）';
			}).then(function () { busy = false; });
		}

		function poll() {
			timer = null;
			if (!panel.isConnected || panel.style.display === 'none') {
				close(true);               // 面板已被关闭：顺手取消后端任务
				return;
			}
			pollRpc('qrpoll-' + Date.now()).then(function (res) {
				if (!res) throw new Error('RPC 无响应');
				var st = String(res.state || '');
				if (!res.success || st === 'failed') {
					// retryable=false 是后端明确的终态（应答残缺/解密失败）：同一条 task
					// 再轮询只会得到同样的结果，退避重试纯属浪费，直接停下让用户重出码。
					if (res.retryable === false) {
						stopPoll();
						pending = false;
						status.textContent = '绑定失败：' + (res.error || '未知原因')
							+ '（可点「刷新二维码」重试）';
						return;
					}
					throw new Error(res.error || '轮询失败');
				}
				errors = 0;
				if (st === 'pending') { timer = setTimeout(poll, POLL_INTERVAL); return; }
				if (st === 'expired') {
					status.textContent = '二维码已过期，正在换新…';
					begin();
					return;
				}
				if (st === 'idle') {
					status.textContent = '绑定任务已失效，正在重新申请…';
					begin();
					return;
				}
				if (st === 'success') { onSuccess(res); return; }
				timer = setTimeout(poll, POLL_INTERVAL);
			}).catch(function (err) {
				// 刚拨号时 DNS/TLS 抖动很常见：按指数退避重试，别把好不容易扫完的流程打断
				errors++;
				if (errors >= MAX_CONSECUTIVE_ERRORS) {
					stopPoll();
					status.textContent = '轮询失败：' + ((err && err.message) || err)
						+ '（可点「刷新二维码」重试）';
					return;
				}
				var wait = Math.min(MAX_ERROR_DELAY, POLL_INTERVAL * Math.pow(2, errors));
				status.textContent = '网络中断，' + Math.round(wait / 1000)
					+ ' 秒后重试（' + errors + '/' + MAX_CONSECUTIVE_ERRORS + '）…';
				timer = setTimeout(poll, wait);
			});
		}

		function onSuccess(res) {
			stopPoll();
			pending = false;
			bound = true;
			if (typeof h.onBound === 'function') h.onBound();
			// 后端已把 AppID/AppSecret/目标写回 UCI；这里同步表单，避免保存时用旧值覆盖。
			// openid 为空时**不能**清空目标输入框：后端刻意保留了原 group/channel 目标，
			// 前端一清空，保存时又会把目标写成空串。
			if (h.appId) h.appId.value = String(res.app_id || '');
			if (h.targetId && res.target_id) h.targetId.value = String(res.target_id);
			if (h.target && res.target_id) h.target.value = 'c2c';
			// 写回失败时不要勾开关：那会让用户在「配置其实没落盘」的状态下保存并重启，
			// 重启后凭据为空、通道静默不工作。
			if (h.enabled && res.saved) h.enabled.checked = true;
			var text = '绑定成功：AppID ' + (res.app_id || '?')
				+ (res.target_id ? '，openid 已回填' : '（未取到 openid，可配合「绑定」模式补）');
			// 写回失败时不要引导用户保存：此时 UCI 里没有新凭据，任何保存/应用都
			// 只会把设备重启到「无凭据」状态。
			status.textContent = res.saved
				? text + '。点底部「保存并应用」让开关与格式一起生效。'
				: text + '；但写回配置失败：' + (res.save_error || '未知原因')
					+ '。请检查 /etc/config/mt5700d 可写后重新扫码。';
		}

		panel.appendChild(canvas);
		panel.appendChild(urlLink);
		panel.appendChild(E('div', {}, status));
		panel.appendChild(E('div', { 'style': 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' },
			Mt5700.button('刷新二维码', function () { begin(); }, 'secondary'),
			Mt5700.button('关闭', function () { close(pending); }, 'ghost')));

		bodyEl.appendChild(E('div', { 'class': 'mt5700-form-group' },
			Mt5700.button('扫码绑定 QQ 机器人', function () {
				if (bound) bound = false;
				begin();
			}, 'secondary'),
			E('span', { 'class': 'mt5700-hint' },
				'免手抄：扫码授权后 AppID/AppSecret 由后端取回并直接写入 UCI，openid 一并回填；'
					+ '之后点「保存」不会用页面旧值覆盖新密钥。')));
		bodyEl.appendChild(panel);

		return { open: begin, close: close };
	}

	return { mount: mount };
})();

/* LuCI 26.x 的 factory 校验要求返回 Class 子类（`Class.isSubclass`），返回普通对象
 * 会抛 “factory yields invalid constructor” 并让整页 require 失败。与本目录其余
 * 模块保持一致：extend 成类 + 挂 window 供 `'require mt5700d/qqqbind'` 的页面直接用。 */
var MtQqBindClass = L.Class.extend(MtQqBind);
if (typeof window !== 'undefined') {
	window.MtQqBind = new MtQqBindClass();
}
return MtQqBindClass;
