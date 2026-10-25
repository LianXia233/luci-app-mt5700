'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 模组升级页面（依据《MT5700M-CN 5G 系列模组 FOTA 升级指南》与 AT 命令手册第 15 章）。
 *
 * 指令序列（指南 4.2 演示 + 手册 15.1/15.7）：
 *   AT+CEREG?                 发起前确认已注册网络（指南 4.1.1 / §5【建议】：
 *                             stat 1 本网 / 5 漫游才继续，其余直接终止）
 *   AT^FOTAMODE=0,1,0,1        手动检测 / 自动下载 / 手动升级 / 使能断点续传
 *                              （当前模组只支持 dectect_mode=0、download_mode=1；
 *                                update_mode=0 表示下载完成后需用户确认才升级）
 *   AT^FOTAOEMDL="<url>/"      触发版本查询并开始下载，必须在 IDLE(10) 状态下下发（指南规范）
 *   AT^FOTASTATE?              轮询状态；AT^FOTADLQ 取下载进度
 *   AT^FWUP                    仅在 40（下载完成）后由用户确认触发（指南规范），
 *                             下发前复核状态仍为 40，避免用户停留页面过久状态已迁移
 *
 * 状态（手册 15.5.3）：10 空闲 / 11 查询 / 12 发现新版本 / 13 查询失败 / 14 未发现版本 /
 * 20 下载失败 / 30 正在下载 / 31 下载挂起 / 40 下载完成 / 50 准备升级 /
 * 70 升级失败（见手册 15.4.5 示例）。
 * 13 与 20 带 <error_code>，界面必须把它显示出来，否则用户只能看到「失败」两个字。
 * 30/31/40 可用 AT^FOTADL=0 取消并回到 IDLE（手册 15.3.3）；
 * 31 挂起可按指南 §5 用 AT^FOTADL=1 续传（会话内自动重试 3 次，页面重载后提供手动续传）。
 * ^FWUP 成功后进入升级观察期：持续轮询 50（指令已接受）→ 写入重启期间 AT 链路断开
 * 属预期，链路恢复回到 10 即按指南 4.2 回读版本号判定升级完成；期间上报 70 判失败。
 *
 * 页面重载后模组可能仍停在 30/31/40：31 给出「续传下载」、40 直接给出「立即升级」，
 * 不再迫使整包取消重下。
 *
 * HTTPS 升级（指南 3.2「搭建 HTTPS 服务器(暂未支持)」）本版本不开放，只接受 http:// 地址。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('模组升级', 'FOTA 在线升级：版本检测、下载进度与升级确认', 'upgrade', '固件更新 · FOTA 在线');
		var body = page._body;

		/* ---------- 状态 ---------- */
		var agreed = false;
		var upgrading = false;
		var progress = 0;          // 0~100，来自 ^FOTADLQ 的 dl_size / file_size
		var dlBytes = null;        // 已下载字节数
		var totalBytes = null;     // 文件总字节数
		var step = 0;              // 0 准备 1 初始化 2 下载 3 等待确认 4 升级 5 完成
		var version = '';          // 当前固件版本（AT+CGMR）
		var newVersion = '';       // 服务器发现的新版本（^FOTASTATE: 12 上报），不覆盖当前版本
		var fotaState = null;      // null = 尚未读到
		var fotaError = null;      // 13/20 的 error_code
		var timer = null;
		var resumeTries = 0;       // 挂起续传次数，避免无限重试
		var startAt = 0;           // 下发 OEMDL 的时刻，用于识别「模组还没离开 IDLE」
		var fwupAt = 0;            // ^FWUP 已接受的时刻；非 0 = 处于升级观察期
		var commFails = 0;         // 观察期内连续查询失败次数（写入重启会断开 AT 链路）

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
			var err = fotaError != null ? '（' + Parse.fotaErrorText(fotaError) + '）' : '';
			switch (state) {
				case 12: return { icon: '↑', variant: 'success', title: '发现新固件版本', desc: '服务器上存在可用新版本' + (newVersion ? '（' + newVersion + '）' : '') + '，模组正在自动下载固件包。' };
				case 30: case 31: return { icon: '⭳', variant: 'info', title: '固件正在下载', desc: '正在从 FOTA 服务器拉取固件，请保持网络与供电稳定。' };
				case 40: return { icon: '✓', variant: 'success', title: '固件下载完成', desc: '下载已就绪。指南要求升级前由用户确认：点击下方「立即升级」开始写入，或取消下载回到空闲状态。' };
				case 50: return { icon: '⚡', variant: 'danger', title: '固件升级中', desc: '模组正在写入固件，此过程请勿断电、勿做任何操作。' };
				case 70: return { icon: '!', variant: 'danger', title: '固件升级失败', desc: '模组上报升级失败' + err + '，可重新发起升级；反复失败请联系模组厂商。' };
				case 13: return { icon: '!', variant: 'danger', title: '版本查询失败', desc: '检查 FOTA 地址与网络后重试' + err + '。' };
				case 20: return { icon: '!', variant: 'danger', title: '固件下载失败', desc: '下载中断' + err + '，可在升级页面重新发起。' };
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
		var confirmBtn = Mt5700.dangerButton('立即升级', function () { confirmUpgrade(); });
		var resumeBtn = Mt5700.primaryButton('续传下载', function () { resumeDownload(); });
		var cancelBtn = Mt5700.ghostButton('取消下载', function () { cancelDownload(); });
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
				'FOTA 会被语音、数据与拨号业务阻塞，请先停止正在使用的业务。',
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

		function renderVersion() {
			versionBody.innerHTML = '';
			var meta = Parse.fotaStateMeta(fotaState);
			versionBody.appendChild(Mt5700.metric('固件版本', version || '未知'));
			/* 状态大字 + 语义配色（查询中=蓝 / 发现新版、完成=绿 / 失败、升级中=红 / 挂起=橙），一眼可判 */
			versionBody.appendChild(Mt5700.metric('FOTA 状态', meta.text, meta.color));
			/* 12 上报的是服务器新版本，与「固件版本」并列展示而不是覆盖它 */
			if (newVersion) versionBody.appendChild(Mt5700.metric('服务器新版本', newVersion, 'success'));
		}

		function renderUpgrade() {
			upgradeBody.innerHTML = '';
			stepsEl.innerHTML = '';
			var labels = ['准备', '初始化', '下载', '确认升级', '升级', '完成'];
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
				upgradeBody.appendChild(Mt5700.formGroup('FOTA 服务器地址', urlInput,
					'仅支持 http 协议（HTTPS 指南 3.2 标注暂未支持），需指向升级文件所在目录（结尾自动补 /），长度不超过 255 字节'));
				upgradeBody.appendChild(Mt5700.panelActions(startBtn));
			}

			if (step === 2 || step === 4) {
				var isUpgrading = step >= 4 || fotaState === 50;
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
					isUpgrading ? '正在升级，请勿断电或执行其他操作' : dlHint()));
				upgradeBody.appendChild(progressEl);
			}

			/* 下载完成（状态 40）：指南要求「用户知情且可取消」，此处不自动下发 AT^FWUP。
			 * 页面重载后停在 40 同样给出「立即升级」入口，不必整包取消重下。 */
			if (step === 3 || (fotaState === 40 && !fwupAt)) {
				upgradeBody.appendChild(Mt5700.panelActions(confirmBtn, cancelBtn));
			} else if (Parse.isFotaCancellable(fotaState)) {
				/* 30/31（含页面重载后的遗留会话）：31 提供手动续传（指南 §5 建议 ^FOTADL=1） */
				var actions = fotaState === 31 ? [resumeBtn, cancelBtn] : [cancelBtn];
				upgradeBody.appendChild(Mt5700.panelActions.apply(null, actions));
			}

			if (upgrading) {
				noteEl.textContent = '升级过程中请勿断电或执行其他操作，完成后设备将自动重启。';
				upgradeBody.appendChild(noteEl);
			}

			/* 同步升级提醒横幅(独立于上述内容，始终刷新) */
			renderBanner();
		}

		/* 下载文案：把 ^FOTADLQ 的真实字节数带上，避免只有百分比时无从判断包体大小 */
		function dlHint() {
			if (totalBytes) {
				return '已下载 ' + AtWs.formatFlow(dlBytes || 0) + ' / ' + AtWs.formatFlow(totalBytes) + '，请勿断电或执行其他操作';
			}
			return '正在从 FOTA 服务器下载固件…';
		}

		/* ---------- FOTA 流程 ---------- */
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

		/* 读一次 ^FOTASTATE?：状态与错误码同步进页面状态量。
		 * 该指令已从后端状态缓存白名单移除，每秒轮询拿到的是模组实时状态。 */
		function queryState() {
			return AtWs.client.sendCommand('AT^FOTASTATE?').then(function (res) {
				if (!res.success || typeof res.data !== 'string') return null;
				var parsed = Parse.parseFotaState(res.data);
				if (!parsed) return null;
				fotaState = parsed.state;
				fotaError = parsed.errorCode;
				if (parsed.version) newVersion = parsed.version;
				renderVersion();
				return parsed.state;
			});
		}

		function readProgress() {
			return AtWs.client.sendCommand('AT^FOTADLQ').then(function (res) {
				if (!res.success || typeof res.data !== 'string') return;
				var dlq = Parse.parseFotaDlq(res.data);
				if (!dlq || dlq.percent == null) return;
				progress = dlq.percent;
				dlBytes = dlq.downloaded;
				totalBytes = dlq.total;
				renderUpgrade();
			}).catch(function () {});
		}

		function stopTimer() {
			if (timer) { clearInterval(timer); timer = null; }
		}

		/* 一次升级会话结束：停轮询、回到准备页，并补读一次版本号 */
		function finish(msg, kind) {
			stopTimer();
			upgrading = false;
			step = 0;
			fwupAt = 0;
			commFails = 0;
			progress = 0;
			dlBytes = null;
			totalBytes = null;
			newVersion = '';
			if (msg) {
				if (kind === 'error') Mt5700.error(msg); else Mt5700.success(msg);
			}
			renderUpgrade();
			fetchVersion();
		}

		function start() {
			if (!agreed) { showDisclaimer(); return; }
			var formatted = Parse.normalizeFotaUrl(urlInput.value);
			if (!formatted) {
				Mt5700.error(urlInput.value && String(urlInput.value).trim()
					? 'FOTA 地址不合法：仅支持 http://、不能含空格或引号，且不超过 255 字节'
					: '请设置 FOTA 服务器地址');
				return;
			}
			urlInput.value = formatted;

			/*
			 * 指南【规范】：^FOTAOEMDL 必须在 FOTA 处于 IDLE(10) 时下发。
			 * 上一次会话可能停在 30/31/40（例如页面刷新后重进），此时直接下发
			 * 会被模组拒绝或撞上「54 FOTA is in collision state」，所以先读状态。
			 */
			Mt5700.info('正在检查 FOTA 状态…');
			queryState().then(function (state) {
				if (state != null && state !== 10) {
					if (state === 40) {
						/* 上次会话已下载完成：直接进入确认升级（指南规范 ^FWUP 在 40 后下发） */
						fotaState = state;
						step = 3;
						upgrading = false;
						progress = 100;
						renderUpgrade();
						Mt5700.success('已下载完成的固件仍在模组内，可直接升级或取消');
					} else if (Parse.isFotaCancellable(state)) {
						fotaState = state;
						step = 0;
						upgrading = false;
						renderUpgrade();
						Mt5700.info('上一次下载尚未结束（' + Parse.fotaStateMeta(state).text + '），可续传或取消后重试');
					} else {
						Mt5700.error('模组当前处于 ' + Parse.fotaStateMeta(state).text + '，需等待其回到空闲后再发起');
					}
					return;
				}
				beginUpgrade(formatted);
			}).catch(function () {
				Mt5700.error('无法读取 FOTA 状态，请稍后重试');
			});
		}

		function beginUpgrade(formatted) {
			upgrading = true;
			progress = 0;
			dlBytes = null;
			totalBytes = null;
			fotaError = null;
			resumeTries = 0;
			step = 1;
			renderUpgrade();
			Mt5700.info('正在初始化 FOTA…');

			/* ATE0：关掉回显，避免指令原文混进 ^FOTASTATE/^FOTADLQ 的应答里 */
			AtWs.client.sendCommand('ATE0').then(function () {
				/* 指南 4.1.1/§5【建议】：注册成功后才进行 FOTA（stat 1 本网 / 5 漫游）；
				 * 读不到注册状态时不硬拦，交由后续 11→13 的错误链路兜底 */
				return AtWs.client.sendCommand('AT+CEREG?').then(function (r) {
					var stat = (r.success && typeof r.data === 'string') ? Parse.parseCeregStat(r.data) : null;
					if (stat != null && stat !== 1 && stat !== 5) {
						throw { ceregStat: stat };
					}
				});
			}).then(function () {
				/* 手动检测 + 自动下载 + 手动升级 + 断点续传（模组当前仅支持 dectect_mode=0） */
				return AtWs.client.sendCommand('AT^FOTAMODE=0,1,0,1');
			}).then(function () {
				step = 2;
				renderUpgrade();
				return AtWs.client.sendCommand('AT^FOTAOEMDL="' + formatted + '"');
			}).then(function (res) {
				if (!res.success) {
					finish('设置 FOTA 地址失败', 'error');
					return;
				}
				startAt = Date.now();
				timer = setInterval(tick, 1000);
				tick();
			}).catch(function (e) {
				if (e && e.ceregStat != null) {
					finish('模组未注册网络（CEREG 状态 ' + e.ceregStat + '），FOTA 需在网络注册成功后进行', 'error');
					return;
				}
				finish('固件升级初始化失败', 'error');
			});
		}

		/* 状态机轮询（指南【规范】：按 ^FOTASTATE 的取值决定下一步动作） */
		function tick() {
			if (timer == null) return;
			queryState().then(function (state) {
				commFails = 0;

				/* ^FWUP 已接受后的升级观察期：等 50→写入重启→回到 10（或链路断开）。
				 * 指南 4.2：升级完毕后靠回读版本号判断成功。 */
				if (fwupAt) {
					switch (state) {
						case 50:
							if (step < 4) step = 4;
							renderUpgrade();
							break;
						case 70:
							finish('模组上报升级失败：' + (Parse.fotaErrorText(fotaError) || '可重新发起升级'), 'error');
							break;
						case 10:
							/* 写入重启完成回到空闲：成功收尾，fetchVersion 会回读新版本号 */
							finish('固件升级完成，模组已回到空闲状态', 'success');
							break;
						case 40:
							/* 指令被接受却迟迟不进入写入，多半是升级条件不满足（并发业务等） */
							if (Date.now() - fwupAt > 30000) {
								finish('模组未进入升级（仍处于下载完成状态），请停止语音/数据/拨号业务后重试', 'error');
							}
							break;
						default: break;
					}
					return;
				}

				switch (state) {
					case 10:
						/* 刚下发 OEMDL 时模组可能还停在 IDLE，超过 10s 仍无迁移才判失败 */
						if (Date.now() - startAt > 10000) finish('模组未开始查询版本，请检查 FOTA 地址与网络', 'error');
						break;
					case 11:
						Mt5700.info('正在查询新版本...');
						break;
					case 12:
						Mt5700.info('发现新版本，正在下载');
						break;
					case 13:
						finish('查询新版本失败：' + (Parse.fotaErrorText(fotaError) || '请检查 FOTA 地址与网络'), 'error');
						break;
					case 14:
						finish('服务器无新版本', 'success');
						break;
					case 20:
						finish('固件下载失败：' + (Parse.fotaErrorText(fotaError) || '请检查网络与存储'), 'error');
						break;
					case 30:
						resumeTries = 0;
						if (step < 2) { step = 2; }
						readProgress();
						break;
					case 31:
						/* 指南建议：挂起时用 ^FOTADL=1 续传；连续 3 次无效则停止，避免无限重试 */
						if (resumeTries >= 3) {
							finish('下载持续挂起，续传无效，请检查网络后重新发起', 'error');
							break;
						}
						resumeTries++;
						Mt5700.info('下载挂起，正在尝试续传（第 ' + resumeTries + ' 次）');
						AtWs.client.sendCommand('AT^FOTADL=1').catch(function () {});
						readProgress();
						break;
					case 40:
						/* 手册 15.1.3：update_mode=0 为手动升级，需用户确认后下发 ^FWUP */
						stopTimer();
						progress = 100;
						step = 3;
						upgrading = false;
						renderUpgrade();
						Mt5700.success('固件下载完成，请在下方确认是否立即升级');
						break;
					case 50:
						if (step < 4) step = 4;
						renderUpgrade();
						break;
					case 70:
						finish('模组上报升级失败：' + (Parse.fotaErrorText(fotaError) || '可重新发起升级'), 'error');
						break;
					default: break;
				}
			}).catch(function () {
				/* 观察期内 AT 链路断开属预期（模组写入固件并重启）：
				 * 连续 10 秒查询无应答就按「正在重启」收尾，让用户稍后核对版本号 */
				if (fwupAt && ++commFails >= 10) {
					finish('升级指令已执行，模组正在写入并重启，稍后刷新页面核对版本号', 'success');
				}
			});
		}

		/* 用户确认后才触发升级（指南【建议】：升级前必须提示用户，做到知情并可取消） */
		function confirmUpgrade() {
			Mt5700.confirm(E('div', {}, [
				E('div', { 'class': 'mt5700-modal-title' }, '确认开始固件升级'),
				E('div', { 'class': 'mt5700-hint' }, '模组将写入已下载的固件并自动重启，过程中请勿断电，也不要执行其他操作。FOTA 会被语音、数据与拨号业务阻塞，如有此类业务请先停止。')
			]), function () {
				/* 指南【规范】：^FWUP 需在 40（下载完成）后发起，确认弹窗停留期间状态可能已迁移 */
				queryState().then(function (state) {
					if (state !== 40 && state !== 50) {
						Mt5700.error('FOTA 状态已变化（' + Parse.fotaStateMeta(state).text + '），请重新发起');
						return;
					}
					if (state === 50) { enterWatchPhase(); return; }
					AtWs.client.sendCommand('AT^FWUP').then(function (res) {
						if (!res.success) {
							finish('触发固件升级失败', 'error');
							return;
						}
						enterWatchPhase();
					}).catch(function () {
						finish('触发固件升级失败', 'error');
					});
				}).catch(function () {
					Mt5700.error('无法读取 FOTA 状态，请稍后重试');
				});
			}, '开始升级');
		}

		/* ^FWUP 已接受：进入升级观察期，轮询 50 / 70 / 回到 10（指南 4.2 以版本回读收尾） */
		function enterWatchPhase() {
			upgrading = true;
			step = 4;
			fwupAt = Date.now();
			commFails = 0;
			renderUpgrade();
			Mt5700.success('固件升级已开始，模组即将写入固件并重启');
			stopTimer();
			timer = setInterval(tick, 1000);
			tick();
		}

		/* 手动续传（指南 §5：31 挂起建议 ^FOTADL=1 续传；同一下载流无版本错配问题） */
		function resumeDownload() {
			Mt5700.info('正在恢复断点续传…');
			AtWs.client.sendCommand('AT^FOTADL=1').then(function (res) {
				if (!res.success) {
					Mt5700.error('续传指令被模组拒绝，可取消下载后重新发起');
					return;
				}
				upgrading = true;
				step = 2;
				progress = 0;
				resumeTries = 0;
				startAt = Date.now();
				stopTimer();
				timer = setInterval(tick, 1000);
				renderUpgrade();
				tick();
			}).catch(function () {
				Mt5700.error('续传失败，请检查模组连接');
			});
		}

		/* 手册 15.3.3：^FOTADL=0 取消下载、删除已下载文件并回到 IDLE */
		function cancelDownload() {
			AtWs.client.sendCommand('AT^FOTADL=0').then(function (res) {
				if (!res.success) {
					Mt5700.error('取消下载失败');
					return;
				}
				Mt5700.info('已取消下载，FOTA 回到空闲状态');
				finish(null);
				queryState();
			}).catch(function () {
				Mt5700.error('取消下载失败');
			});
		}

		/* ---------- 初始化 ---------- */
		renderUpgrade();

		Ui.startup(body, function () {
			fetchVersion();
			/* 进页面先读一次状态：40 直接给出「立即升级」，30/31 给出续传/取消出口 */
			queryState().then(function (state) {
				if (state == null || state === 10) return;
				if (state === 40) { step = 3; progress = 100; }
				renderUpgrade();
			}).catch(function () {});
			if (!agreed) showDisclaimer();
		});

		self._dispose = function () { stopTimer(); };

		return page;
	}
});
