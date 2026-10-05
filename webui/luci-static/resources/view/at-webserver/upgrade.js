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
		var page = Mt5700.page('模组升级', 'FOTA 在线与本地固件版本升级、校验与刷新维护', 'upgrade', '固件更新 · FOTA 在线');
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

		/* 升级提醒横幅：检测/下载/升级等关键状态的醒目可视化，挂在升级卡底部(独立容器，不被 renderUpgrade 清空) */
		var bannerEl = E('div');
		upgradeCard._body.appendChild(bannerEl);

		/* 提醒横幅绘制：按 FOTA 状态给出 icon、标题、说明与配色(variant) */
		function bannerOf(state) {
			switch (state) {
				case 12: return { icon: '↑', variant: 'success', title: '发现新固件版本', desc: '服务器上存在可用新版本，点击上方「开始升级」即可拉取安装。' };
				case 30: case 31: return { icon: '⭳', variant: 'info', title: '固件正在下载', desc: '正在从 FOTA 服务器拉取固件，请保持网络与供电稳定。' };
				case 40: return { icon: '✓', variant: 'success', title: '固件下载完成', desc: '下载已就绪，即将触发模组执行升级，请勿断电。' };
				case 50: return { icon: '⚡', variant: 'danger', title: '固件升级中', desc: '模组正在写入固件，此过程请勿断电、勿做任何操作。' };
				case 13: case 20: return { icon: '!', variant: 'danger', title: '升级失败', desc: '未完成升级，请检查 FOTA 地址与网络后重试。' };
				default: return null;
			}
		}

		function renderBanner() {
			bannerEl.innerHTML = '';
			var b = bannerOf(fotaState);
			if (!b) return;
			var box = E('div', { 'class': 'mt5700-banner mt5700-banner-' + b.variant });
			box.appendChild(E('span', { 'class': 'mt5700-banner-icon' }, b.icon));
			var bodyx = E('div', { 'class': 'mt5700-banner-body' });
			bodyx.appendChild(E('div', { 'class': 'mt5700-banner-title' }, b.title));
			bodyx.appendChild(E('div', { 'class': 'mt5700-banner-desc' }, b.desc));
			box.appendChild(bodyx);
			bannerEl.appendChild(box);
		}

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

		/* FOTA 状态 → 徽章变体与数值配色（让状态一眼可判） */
		function fotaMeta(s) {
			var map = {
				11: { badge: 'info', color: 'accent', text: '正在查询新版本' },
				12: { badge: 'success', color: 'success', text: '发现新版本' },
				13: { badge: 'danger', color: 'danger', text: '查询失败' },
				14: { badge: 'neutral', color: '', text: '无新版本' },
				20: { badge: 'danger', color: 'danger', text: '下载失败' },
				30: { badge: 'warning', color: 'warning', text: '下载中' },
				31: { badge: 'warning', color: 'warning', text: '下载挂起' },
				40: { badge: 'success', color: 'success', text: '下载完成' },
				50: { badge: 'danger', color: 'danger', text: '升级中' }
			};
			return map[s] || { badge: 'neutral', color: '', text: (s ? '状态 ' + s : '未知') };
		}

		function renderVersion() {
			versionBody.innerHTML = '';
			var meta = fotaMeta(fotaState);
			versionBody.appendChild(Mt5700.metric('固件版本', version || '未知'));
			/* 状态大字 + 语义配色（查询中=蓝 / 发现新版、完成=绿 / 失败、升级中=红 / 挂起=橙），一眼可判 */
			versionBody.appendChild(Mt5700.metric('FOTA 状态', meta.text, meta.color));
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
				var isUpgrading = fotaState === 50;
				var phaseLabel = isUpgrading ? '升级进度' : '下载进度';
				var phaseColor = isUpgrading ? 'danger' : 'accent';
				var fillColor = isUpgrading ? '#c83d55' : '#3b82f6';
				progressEl.innerHTML = '';
				/* 大数字进度：metric 会自动把「40%」拆成数字 40 + 单位 % 两段 */
				progressEl.appendChild(Mt5700.metric(phaseLabel, progress + '%', phaseColor));
				/* 彩色进度条(颜色随阶段切换：下载=蓝 / 升级=红) */
				var bar = E('div', { 'class': 'mt5700-progress-bar' });
				bar.appendChild(E('div', { 'class': 'mt5700-progress-fill', style: 'width:' + progress + '%;background:' + fillColor }));
				progressEl.appendChild(bar);
				progressEl.appendChild(E('div', { 'class': 'mt5700-hint' },
					isUpgrading ? '正在升级，请勿断电或执行其他操作' : '正在从 FOTA 服务器下载固件…'));
				upgradeBody.appendChild(progressEl);
			}

			if (upgrading) {
				noteEl.textContent = '升级过程中请勿断电或执行其他操作，完成后设备将自动重启。';
				upgradeBody.appendChild(noteEl);
			}

			/* 同步升级提醒横幅(独立于上述内容，始终刷新) */
			renderBanner();
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
