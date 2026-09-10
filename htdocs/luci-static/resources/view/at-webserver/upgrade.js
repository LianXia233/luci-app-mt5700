'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Parse, Ui */

/**
 * 模组升级（原 WebUI 系统 → 模组升级）
 * 等价迁移 system/Upgrade.tsx：
 * - 免责声明（首次强制确认）
 * - 当前版本 AT+CGMR
 * - FOTA 状态机轮询 AT^FOTASTATE?：11 查询中 / 12 发现新版本 / 13 查询失败 /
 *   14 无新版本 / 20 下载失败 / 30 下载中（AT^FOTADLQ 取进度）/ 31 挂起续传（AT^FOTADL=1）/
 *   40 下载完成（AT^FWUP）/ 50 升级中
 * - 设置 FOTA 地址 AT^FOTAMODE=0,1,0,1 + AT^FOTAOEMDL="<url>/"
 */

return L.view.extend({
	render: function () {
		var page = Ui.page('模组升级', 'FOTA 远程固件升级');
		var body = page._body;
		Ui.renderConnectionBar(body);

		var agreed = false;
		var showAgree = true;
		var upgrading = false;
		var progress = 0;
		var step = 0;
		var version = '';
		var fotaState = 10;

		/* ---------- 免责声明 ---------- */
		function showDisclaimer() {
			var mask = E('div', { 'class': 'at-modal-mask' });
			var box = E('div', { 'class': 'at-modal' });
			var h = E('h4', { 'class': 'at-modal-title' }, '固件升级免责声明');
			var ol = E('ol', { 'class': 'at-agree-list' });
			['升级过程中请确保供电稳定，切勿断电。', '升级过程中请勿进行其他操作。', '完成后设备将自动重启，请耐心等待。', '操作不当可能导致设备无法正常使用。', '升级前请备份重要数据。']
				.forEach(function (t) { ol.appendChild(E('li', {}, t)); });
			var actions = E('div', { 'class': 'at-modal-actions' });
			var cancel = Ui.button('不同意', 'cbi-button-negative', function () {
				if (mask.parentNode) mask.parentNode.removeChild(mask);
				showAgree = false;
				render();
			});
			var ok = Ui.button('同意并继续', 'cbi-button-positive', function () {
				if (mask.parentNode) mask.parentNode.removeChild(mask);
				agreed = true;
				showAgree = false;
				render();
			});
			actions.appendChild(cancel);
			actions.appendChild(ok);
			box.appendChild(h);
			box.appendChild(ol);
			box.appendChild(actions);
			mask.appendChild(box);
			mask.addEventListener('click', function (e) {
				if (e.target === mask) { showAgree = false; if (mask.parentNode) mask.parentNode.removeChild(mask); render(); }
			});
			document.body.appendChild(mask);
		}

		/* ---------- 状态 ---------- */
		var versionPanel = Ui.panel('当前版本', '');
		var versionEl = E('div', { 'class': 'at-mono' }, '未知');
		versionPanel._body.appendChild(versionEl);

		var upgradePanel = Ui.panel('升级', '');
		body.appendChild(versionPanel);
		body.appendChild(upgradePanel);

		var urlInput = document.createElement('input');
		urlInput.className = 'cbi-input-text';
		urlInput.placeholder = 'http://fota.example.com/path/';
		urlInput.style.width = '100%';
		urlInput.addEventListener('input', function () { /* keep */ });

		var startBtn = Ui.primaryButton('开始升级', start);
		var stepsEl = E('div', { 'class': 'at-steps' });
		var progressEl = E('div', { 'class': 'at-progress' });
		var noteEl = E('div', { 'class': 'at-note' });

		function render() {
			upgradePanel._body.innerHTML = '';
			versionEl.textContent = version || '未知';
			stepsEl.innerHTML = '';
			var labels = ['准备', '初始化', '下载', '升级', '完成'];
			for (var i = 0; i < labels.length; i++) {
				var s = E('div', { 'class': 'at-step' + (i < step ? ' at-step-done' : i === step ? ' at-step-current' : '') }, labels[i]);
				stepsEl.appendChild(s);
			}
			upgradePanel._body.appendChild(stepsEl);

			if (step === 0) {
				var row = E('div', { 'class': 'at-field' });
				row.appendChild(E('div', { 'class': 'at-field-label' }, 'FOTA 服务器地址'));
				var ctrl = E('div', { 'class': 'at-field-control' });
				ctrl.appendChild(urlInput);
				ctrl.appendChild(E('div', { 'class': 'at-field-hint' }, '仅支持 http 协议'));
				row.appendChild(ctrl);
				upgradePanel._body.appendChild(row);
				var actions = E('div', { 'class': 'at-panel-actions' });
				actions.appendChild(startBtn);
				upgradePanel._body.appendChild(actions);
			}

			if (step === 2 || step === 3) {
				progressEl.innerHTML = '';
				var p = E('div', { 'class': 'at-progress-bar' });
				var fill = E('div', { 'class': 'at-progress-fill', style: 'width:' + progress + '%' });
				p.appendChild(fill);
				progressEl.appendChild(p);
				progressEl.appendChild(E('div', { 'class': 'at-hint' }, progress + '%' + (fotaState === 50 ? ' (正在升级...)' : '')));
				upgradePanel._body.appendChild(progressEl);
			}

			if (upgrading) {
				noteEl.textContent = '升级过程中请勿断电或执行其他操作，完成后设备将自动重启。';
				upgradePanel._body.appendChild(noteEl);
			}
		}

		/* ---------- 逻辑（等价原件） ---------- */

		function fetchVersion() {
			return AtWs.client.sendCommand('AT+CGMR').then(function (res) {
				if (res.success && typeof res.data === 'string') {
					var lines = res.data.replace(/\r/g, '').split('\n').map(function (s) { return s.trim(); })
						.filter(function (l) { return l && l.toUpperCase() !== 'OK' && l.toUpperCase().indexOf('AT+CGMR') !== 0; });
					version = lines[0] || res.data.trim();
				}
			}).catch(function () { Ui.error('获取版本失败'); }).then(render);
		}

		function queryState() {
			return AtWs.client.sendCommand('AT^FOTASTATE?').then(function (res) {
				if (res.success && typeof res.data === 'string') {
					var raw = AtWs.extractATData(res.data, '^FOTASTATE') || res.data.split(':')[1];
					var state = parseInt(String(raw).trim(), 10);
					if (!isNaN(state)) { fotaState = state; return state; }
				}
				return null;
			});
		}

		function start() {
			var url = (urlInput.value || '').trim();
			if (!url) { Ui.error('请设置 FOTA 服务器地址'); return; }
			if (url.indexOf('http://') !== 0) { Ui.error('仅支持 http 协议'); return; }
			var formatted = url.endsWith('/') ? url : url + '/';
			upgrading = true;
			progress = 0;
			step = 1;
			render();
			Ui.info('正在初始化 FOTA…');
			AtWs.client.sendCommand('ATE0').then(function () {
				return AtWs.client.sendCommand('AT^FOTAMODE=0,1,0,1');
			}).then(function () {
				step = 2;
				render();
				return AtWs.client.sendCommand('AT^FOTAOEMDL="' + formatted + '"');
			}).then(function (res) {
				if (!res.success) {
					Ui.error('设置 FOTA 地址失败');
					upgrading = false;
					step = 0;
					render();
					return;
				}
				var timer = setInterval(function () {
					queryState().then(function (state) {
						switch (state) {
							case 11: Ui.info('正在查询新版本...'); break;
							case 12: Ui.info('发现新版本'); break;
							case 13:
								clearInterval(timer);
								Ui.error('查询新版本失败');
								upgrading = false; step = 0; render();
								break;
							case 14:
								clearInterval(timer);
								Ui.error('服务器无新版本');
								upgrading = false; step = 0; render();
								break;
							case 20:
								clearInterval(timer);
								Ui.error('固件下载失败');
								upgrading = false; step = 0; render();
								break;
							case 30:
								AtWs.client.sendCommand('AT^FOTADLQ').then(function (dl) {
									if (dl.success && typeof dl.data === 'string') {
										var nums = dl.data.replace(/\r|\n/g, '').split(',')
											.map(function (s) { return s.replace(/[^0-9]/g, ''); })
											.filter(Boolean)
											.map(function (s) { return parseInt(s, 10); });
										if (nums.length >= 2) {
											var total = nums[nums.length - 2];
											var downloaded = nums[nums.length - 1];
											if (total > 0) {
												progress = Math.max(0, Math.min(100, Math.floor((downloaded / total) * 100)));
												render();
											}
										}
									}
								});
								break;
							case 31:
								Ui.info('下载挂起，尝试续传');
								AtWs.client.sendCommand('AT^FOTADL=1').catch(function () {});
								break;
							case 40:
								clearInterval(timer);
								Ui.success('固件下载完成');
								step = 3;
								render();
								AtWs.client.sendCommand('AT^FWUP').then(function () {
									Ui.success('固件升级已开始，设备即将重启');
									step = 4;
									upgrading = false;
									render();
								}).catch(function () {
									Ui.error('触发固件升级失败');
									upgrading = false;
									render();
								});
								break;
							case 50:
								Ui.info('正在准备升级...');
								render();
								break;
							default: break;
						}
					}).catch(function () {});
				}, 1000);
				this._timer = timer;
			}).catch(function () {
				Ui.error('固件升级失败');
				upgrading = false;
				step = 0;
				render();
			});
		}

		/* ---------- 初始化 ---------- */
		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) AtWs.client.connect(values.key).catch(function (e) { Ui.error((e && e.message) || '认证失败'); });
				});
				return;
			}
			if (err) console.warn(err);
		}).then(function () {
			fetchVersion();
			if (!agreed && showAgree) showDisclaimer();
		});

		this._dispose = function () {
			if (this._timer) clearInterval(this._timer);
		};

		return page;
	}
});
