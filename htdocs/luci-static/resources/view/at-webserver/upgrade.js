'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700 */

/**
 * 模组升级 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI system/Upgrade.tsx，并保留 v1.4.x 玻璃拟态卡片风格：
 * - 免责声明（未同意前不允许开始升级）
 * - 当前版本 AT+CGMR
 * - FOTA 状态机轮询 AT^FOTASTATE?：11 查询中 / 12 发现新版本 / 13 查询失败 /
 *   14 无新版本 / 20 下载失败 / 30 下载中（AT^FOTADLQ 取进度）/ 31 挂起续传（AT^FOTADL=1）/
 *   40 下载完成（随后 AT^FWUP）/ 50 升级中
 * - 设置 FOTA 地址 AT^FOTAMODE=0,1,0,1 + AT^FOTAOEMDL="<url>/"
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('模组升级', 'FOTA 远程固件升级');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 状态 ---------- */
		var agreed = false;
		var upgrading = false;
		var progress = 0;
		var step = 0;            // 0 准备 1 初始化 2 下载 3 升级 4 完成
		var version = '';
		var fotaState = 10;
		var timer = null;

		/* ---------- 当前版本卡片 ---------- */
		var versionCard = Mt5700.card('当前版本', '模组固件版本信息');
		var versionBody = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		versionCard._body.appendChild(versionBody);
		body.appendChild(versionCard);
		versionBody.appendChild(Mt5700.loading('加载中...'));

		/* ---------- 升级卡片 ---------- */
		var upgradeCard = Mt5700.card('固件升级', 'FOTA 远程固件升级');
		var upgradeBody = E('div');
		upgradeCard._body.appendChild(upgradeBody);
		body.appendChild(upgradeCard);

		var urlInput = Mt5700.input('text', 'http://fota.example.com/path/');
		urlInput.style.width = '100%';

		var startBtn = Mt5700.primaryButton('开始升级', function () { start(); });
		var stepsEl = E('div', { 'class': 'mt5700-steps' });
		var progressEl = E('div', { 'class': 'mt5700-progress' });
		var noteEl = E('div', { 'class': 'mt5700-hint' });

		/* ---------- 免责声明 ---------- */
		function showDisclaimer() {
			var box = E('div');
			box.appendChild(E('div', { 'class': 'mt5700-modal-title' }, '固件升级免责声明'));
			var ol = E('ol', { 'class': 'mt5700-agree-list' });
			['升级过程中请确保供电稳定，切勿断电。',
				'升级过程中请勿进行其他操作。',
				'完成后设备将自动重启，请耐心等待。',
				'操作不当可能导致设备无法正常使用。',
				'升级前请备份重要数据。'
			].forEach(function (t) { ol.appendChild(E('li', {}, t)); });
			box.appendChild(ol);
			Mt5700.confirm(box, function () {
				agreed = true;
				renderUpgrade();
			}, '同意并继续');
		}

		/* ---------- 渲染 ---------- */
		function fotaStateText(s) {
			var map = {
				11: '正在查询新版本', 12: '发现新版本', 13: '查询失败', 14: '无新版本',
				20: '下载失败', 30: '下载中', 31: '下载挂起', 40: '下载完成', 50: '升级中'
			};
			return map[s] || (s ? '状态 ' + s : '未知');
		}

		function renderVersion() {
			versionBody.innerHTML = '';
			versionBody.appendChild(Mt5700.metric('固件版本', version || '未知'));
			versionBody.appendChild(Mt5700.metric('FOTA 状态', fotaStateText(fotaState)));
		}

		function renderUpgrade() {
			upgradeBody.innerHTML = '';
			stepsEl.innerHTML = '';
			var labels = ['准备', '初始化', '下载', '升级', '完成'];
			for (var i = 0; i < labels.length; i++) {
				var cls = 'mt5700-step' + (i < step ? ' mt5700-step-done' : i === step ? ' mt5700-step-current' : '');
				stepsEl.appendChild(E('div', { 'class': cls }, labels[i]));
			}
			upgradeBody.appendChild(stepsEl);

			if (step === 0) {
				if (!agreed) {
					upgradeBody.appendChild(E('div', { 'class': 'mt5700-hint' },
						'请先阅读并同意免责声明，然后填写 FOTA 服务器地址。'));
				}
				upgradeBody.appendChild(Mt5700.formGroup('FOTA 服务器地址', urlInput, '仅支持 http 协议，结尾自动补 /'));
				upgradeBody.appendChild(Mt5700.panelActions(startBtn));
			}

			if (step === 2 || step === 3) {
				progressEl.innerHTML = '';
				var bar = E('div', { 'class': 'mt5700-progress-bar' });
				bar.appendChild(E('div', { 'class': 'mt5700-progress-fill', style: 'width:' + progress + '%' }));
				progressEl.appendChild(bar);
				progressEl.appendChild(E('div', { 'class': 'mt5700-hint' },
					progress + '%' + (fotaState === 50 ? ' （正在升级...）' : '')));
				upgradeBody.appendChild(progressEl);
			}

			if (upgrading) {
				noteEl.textContent = '升级过程中请勿断电或执行其他操作，完成后设备将自动重启。';
				upgradeBody.appendChild(noteEl);
			}
		}

		/* ---------- 逻辑（对齐基准 v1.3.4） ---------- */
		function fetchVersion() {
			return AtWs.client.sendCommand('AT+CGMR').then(function (res) {
				if (res.success && typeof res.data === 'string') {
					var lines = res.data.replace(/\r/g, '').split('\n')
						.map(function (s) { return s.trim(); })
						.filter(function (l) {
							return l && l.toUpperCase() !== 'OK' && l.toUpperCase().indexOf('AT+CGMR') !== 0;
						});
					version = lines[0] || res.data.trim();
				}
				renderVersion();
			}).catch(function () {
				Mt5700.error('获取版本失败');
				renderVersion();
			});
		}

		function queryState() {
			return AtWs.client.sendCommand('AT^FOTASTATE?').then(function (res) {
				if (res.success && typeof res.data === 'string') {
					var raw = AtWs.extractATData(res.data, '^FOTASTATE') || res.data.split(':')[1];
					var st = parseInt(String(raw).trim(), 10);
					if (!isNaN(st)) { fotaState = st; return st; }
				}
				return null;
			});
		}

		function stopTimer() {
			if (timer) { clearInterval(timer); timer = null; }
		}

		function start() {
			if (!agreed) { showDisclaimer(); return; }
			var url = (urlInput.value || '').trim();
			if (!url) { Mt5700.error('请设置 FOTA 服务器地址'); return; }
			if (url.indexOf('http://') !== 0) { Mt5700.error('仅支持 http 协议'); return; }
			var formatted = url.charAt(url.length - 1) === '/' ? url : url + '/';

			upgrading = true;
			progress = 0;
			step = 1;
			renderUpgrade();
			Mt5700.info('正在初始化 FOTA…');

			AtWs.client.sendCommand('ATE0').then(function () {
				return AtWs.client.sendCommand('AT^FOTAMODE=0,1,0,1');
			}).then(function () {
				step = 2;
				renderUpgrade();
				return AtWs.client.sendCommand('AT^FOTAOEMDL="' + formatted + '"');
			}).then(function (res) {
				if (!res.success) {
					Mt5700.error('设置 FOTA 地址失败');
					upgrading = false; step = 0; renderUpgrade();
					return;
				}
				timer = setInterval(function () {
					queryState().then(function (state) {
						switch (state) {
							case 11: Mt5700.info('正在查询新版本...'); break;
							case 12: Mt5700.info('发现新版本'); break;
							case 13:
								stopTimer();
								Mt5700.error('查询新版本失败');
								upgrading = false; step = 0; renderUpgrade();
								break;
							case 14:
								stopTimer();
								Mt5700.error('服务器无新版本');
								upgrading = false; step = 0; renderUpgrade();
								break;
							case 20:
								stopTimer();
								Mt5700.error('固件下载失败');
								upgrading = false; step = 0; renderUpgrade();
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
												renderUpgrade();
											}
										}
									}
								});
								break;
							case 31:
								Mt5700.info('下载挂起，尝试续传');
								AtWs.client.sendCommand('AT^FOTADL=1').catch(function () {});
								break;
							case 40:
								stopTimer();
								Mt5700.success('固件下载完成');
								step = 3;
								renderUpgrade();
								AtWs.client.sendCommand('AT^FWUP').then(function () {
									Mt5700.success('固件升级已开始，设备即将重启');
									step = 4;
									upgrading = false;
									renderUpgrade();
								}).catch(function () {
									Mt5700.error('触发固件升级失败');
									upgrading = false;
									renderUpgrade();
								});
								break;
							case 50:
								Mt5700.info('正在准备升级...');
								renderUpgrade();
								break;
							default: break;
						}
					}).catch(function () {});
				}, 1000);
			}).catch(function () {
				Mt5700.error('固件升级失败');
				upgrading = false;
				step = 0;
				renderUpgrade();
			});
		}

		/* ---------- 初始化 ---------- */
		renderUpgrade();

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Mt5700.error('需要提供连接密钥');
				return;
			}
			if (err) console.warn(err);
		}).then(function () {
			fetchVersion();
			if (!agreed) showDisclaimer();
		});

		self._dispose = function () { stopTimer(); };

		return page;
	}
});
