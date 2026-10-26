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
 * - FOTA 状态机 AT^FOTASTATE?：10 空闲 / 11 查询中 / 12 发现新版本 / 13 查询失败 /
 *   14 无新版本 / 20 下载失败 / 30 下载中（AT^FOTADLQ 取进度）/ 31 挂起续传（AT^FOTADL=1）/
 *   40 下载完成（随后 AT^FWUP）/ 50 升级中 / **70 升级失败**
 * - 设置 FOTA 地址 AT^FOTAMODE=0,1,0,1 + AT^FOTAOEMDL="<url>/"
 *
 * 状态值与终态语义全部依据《MT5700M-CN 5G 系列模组 FOTA 升级指南》第 5 章
 * 「FOTA 实现规范」与《AT 命令手册》15.4 / 15.5，不是猜的。三条容易踩空的：
 *   ① **70 才是升级失败的终态**，50 只是「升级指令设置成功」。发完 AT^FWUP 就
 *      停止轮询的话，永远看不到 70，失败会被当成成功。
 *   ② **静默失败**：下发 ^FOTAOEMDL 后状态可能走 11 → 10，既不上报 13/14 也不
 *      进 30。这时必须判失败，否则界面会永远停在「等待中」。
 *   ③ **成功要用版本复核**：FOTA 指南 4.2 明确「升级完毕后，通过 AT^VERSION?
 *      查询版本和时间变化判断是否升级成功」，50 不等于升级成功。
 *
 * 状态轮询（AT^FOTASTATE?）的节奏是**按阶段分档 + 无变化退避**的，不是固定 1 秒：
 *   查询新版本 / 发现新版本 / 下载完成 / 升级中 → 1s 起（状态切换就在这几步）；
 *   下载中 / 挂起续传                          → 3s 起（进度本身几分钟才动一次）；
 *   同一状态连续 3 次不变                       → 间隔翻倍，封顶 5s；
 *   状态一变立刻回到该档位的起始间隔。
 * 早期版本是固定 setInterval(…, 1000)：FOTA 下载动辄几十分钟，等于往独占串口
 * 里灌上千条查询，而且 setInterval 不等前一条应答 —— 模组响应一慢就堆积命令，
 * 把别的页面（短信、信号刷新、看门狗下发）一起拖住。
 * 现在改成「递归 setTimeout + in-flight 守卫」：同一时刻只有一条查询在飞。
 *
 * ★ 只降频、不放弃：轮询**没有总时限**，只有终态（成功 / 失败）才会停。
 *   退避封顶只是「最慢 5s 看一眼」，不是到点撒手 —— 升级这种事宁可多等，
 *   也不能在没等到结果前停掉，把「还在下载」误报成「失败」。
 *   超过 30 分钟只弹一次提示，让人自己去终端核，轮询照跑。
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

		/* ---------- 轮询节奏 ---------- */
		// 分档间隔（毫秒）：状态切换快的阶段查得勤，下载这种慢过程查得稀。
		var POLL_FAST = 1000;          // 查询新版本 / 发现新版本 / 下载完成 / 升级中
		var POLL_DOWNLOAD = 3000;      // 下载中、下载挂起
		// 退避封顶：最慢也就 5s 一次。注意**封顶不等于停止** —— 只要没走到
		// 成功/失败终态就一直查下去，这里收敛的只是「多久看一眼」。
		var POLL_MAX = 5000;
		// 连续多少次「状态没变」之后把间隔翻一倍。
		var POLL_BACKOFF_AFTER = 3;
		// 卡住提醒（只提示一次，不停止）：超过这个时长还没到终态，弹一条提示
		// 让用户自己去终端确认，但轮询继续 —— 升级这种事宁可多等，
		// 也不能在没等到成功或失败之前就撒手不管。
		var POLL_STALL_WARN = 30 * 60 * 1000;
		// 下发 ^FOTAOEMDL 后允许模组「还没动起来」的窗口。超过它状态仍是 10
		// 且从没进过 11/12，就说明这次压根没触发查询 —— 也是个必须报出来的终态。
		var QUERY_START_TIMEOUT = 60 * 1000;

		var pollBusy = false;          // in-flight 守卫：同一时刻只允许一条查询
		var pollKeep = false;          // 还需不需要继续排下一轮
		var pollStartedAt = 0;
		var pollStallWarned = false;
		var lastState = -1;
		var sameCount = 0;

		/* ---------- 终态判定需要的几个记忆位 ---------- */
		// 13 的子错误码：13=服务器访问失败，51=升级文件获取失败（见 FOTA 指南 5 章）
		var stateDetail = 0;
		// 是否见过 11/12（版本查询真的开始了）。没有它就无法区分「下发 OEMDL 后
		// 模组还没来得及切状态」和「查询已经结束、静默回到 IDLE」。
		var sawQuery = false;
		// 是否见过 30/31/40（下载真的开始了）。
		var sawDownload = false;
		// 是否见过 50（升级指令已生效）。50 之后模组会重启、状态回到 10 ——
		// 那时「回到 10」是升级流程结束，而不是「下载被取消」，靠这个位区分。
		var sawUpgrade = false;
		// AT^FWUP 只允许发一次：40 可能连续几轮都读到，重复下发会把升级打断。
		var fwupSent = false;
		/*
		 * AT^FWUP 的重试计数与上限。
		 * 下发被拒时不能只报错就完事：tick 的 case 40 是**先** `fwupSent = true`
		 * **再**调 beginFirmwareUpgrade，下一轮进来直接命中 `if (fwupSent) break;`
		 * —— 既不重发、也进不了 50/70 终态，界面永远停在「固件下载完成」。
		 * 所以失败要复位 fwupSent；但重试必须有上限（模组持续拒绝时不该无限刷屏、
		 * 白占独占串口）。
		 */
		var fwupTries = 0;
		var FWUP_MAX_TRIES = 3;
		// 31（下载挂起）续传的节流时间戳 —— 手册建议用 AT^FOTADL=1 续传，
		// 但不能每轮都发，否则又变成高频命令。
		var lastResumeAt = 0;
		var RESUME_MIN_GAP = 30000;
		// 升级前的固件版本：升级完成后用 AT+CGMR 复核，版本变了才算真的成功
		// （FOTA 指南 4.2：「升级完毕后，上位机可以通过 AT^VERSION? 查询版本和时间
		//  变化来判断是否升级成功」—— 50 并不代表升级成功）。
		var baseVersion = '';

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

		var urlInput = Mt5700.input('text', 'https://fota.example.com/path/');
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
		/*
		 * FOTA 状态文案 —— 状态值取自《MT5700M-CN FOTA 升级指南》5 章「FOTA 实现规范」
		 * 与《AT 命令手册》15.5 / 15.4：
		 *   10 空闲（IDLE，可发起下载）  11 版本查询中        12 发现新版本
		 *   13 查询失败（带子错误码）    14 服务器无新版本    20 下载失败
		 *   30 下载中                    31 下载挂起          40 下载完成（待升级）
		 *   50 准备升级（AT^FWUP 已被接受）70 升级失败
		 * ★ 50 只是「升级已被接受」，不是升级完成；70 才是升级失败的终态 ——
		 *   漏了它就会一直等下去，永远报不出失败。
		 */
		function fotaStateText(s) {
			var map = {
				10: '空闲（可发起升级）',
				11: '正在查询新版本', 12: '发现新版本', 13: '查询失败', 14: '无新版本',
				20: '下载失败', 30: '下载中', 31: '下载挂起', 40: '下载完成，待升级',
				// 手册 15.5 的状态列表里 50 叫「准备升级」：AT^FWUP 已被接受、模组正在
				// 烧写前的准备，升级本身还没完 —— 之后模组会重启、状态回到 10。
				50: '准备升级', 70: '升级失败'
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
				upgradeBody.appendChild(Mt5700.formGroup('FOTA 服务器地址', urlInput, '支持 http / https 协议，结尾自动补 /'));
				/* 破坏力写在按钮正上方：这一步烧的是模组固件，中途断电变砖，
				   而且整机最后会重启一次。免责声明弹窗里虽有，但用户点之前看不出风险。 */
				upgradeBody.appendChild(Mt5700.impact(['烧写期间', { b: '整机断网' },
					'，结束后自动重启；中途断电可能导致模组无法启动。升级前请确认供电稳定。']));
				upgradeBody.appendChild(Mt5700.panelActions(startBtn));
			}

			if (step === 2 || step === 3) {
				progressEl.innerHTML = '';
				var bar = E('div', { 'class': 'mt5700-progress-bar' });
				bar.appendChild(E('div', { 'class': 'mt5700-progress-fill', style: 'width:' + progress + '%' }));
				progressEl.appendChild(bar);
				progressEl.appendChild(E('div', { 'class': 'mt5700-hint' },
					progress + '%' + (fotaState === 50 ? ' （准备升级…）' : '')));
				upgradeBody.appendChild(progressEl);
			}

			if (upgrading) {
				noteEl.textContent = '升级过程中请勿断电或执行其他操作，完成后设备将自动重启。';
				upgradeBody.appendChild(noteEl);
			}
		}

		/* ---------- 逻辑（对齐基准 v1.3.4） ---------- */
		function fetchVersion() {
			return AtWs.client.sendCommand('AT+CGMR', { fresh: true }).then(function (res) {
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
					if (raw == null) return null;
					// 应答形如 `10`、`13,13`、`12,V100R001C00B002,6129664,1.product_name=...`
					// —— 第一个字段是状态，13 时第二个字段是子错误码。
					var parts = String(raw).split(',');
					var st = parseInt(parts[0], 10);
					if (isNaN(st)) return null;
					fotaState = st;
					stateDetail = (st === 13 && parts.length > 1) ? (parseInt(parts[1], 10) || 0) : 0;
					return st;
				}
				return null;
			});
		}

		/**
		 * 下一轮该等多久。
		 *
		 * 状态没变就按 POLL_BACKOFF_AFTER 次一档地翻倍，封顶后稳住；
		 * 状态一变立刻清零，回到该档位的起始间隔 —— 这样「卡在下载 20 分钟」
		 * 是 5s 一次，而「下载完成 → 升级中」这种关键跳变又是 1s 一次。
		 */
		function nextDelay(state) {
			if (state !== lastState) {
				lastState = state;
				sameCount = 0;
			} else {
				sameCount++;
			}
			var downloading = (state === 30 || state === 31);
			var base = downloading ? POLL_DOWNLOAD : POLL_FAST;
			var delay = base;
			for (var i = 0; i < Math.floor(sameCount / POLL_BACKOFF_AFTER); i++) {
				delay *= 2;
				if (delay >= POLL_MAX) { delay = POLL_MAX; break; }
			}
			return Math.min(delay, POLL_MAX);
		}

		function stopTimer() {
			pollKeep = false;
			if (timer) { clearTimeout(timer); timer = null; }
		}

		/* 递归 setTimeout：等上一轮应答回来才排下一轮，绝不重叠 */
		function pollOnce() {
			if (pollBusy) { schedule(); return; }
			// 卡住提醒：只提示一次，绝不因此停止 —— 没等到成功或失败就得继续查。
			if (!pollStallWarned && Date.now() - pollStartedAt > POLL_STALL_WARN) {
				pollStallWarned = true;
				Mt5700.info('已等待超过 30 分钟仍未出结果，继续等待中；可在终端执行 AT^FOTASTATE? 自行确认');
			}
			pollBusy = true;
			queryState().then(function (state) {
				pollBusy = false;
				tick(state);
				if (pollKeep) schedule(nextDelay(state));
			}).catch(function () {
				pollBusy = false;
				if (pollKeep) schedule(nextDelay(lastState));
			});
		}

		function schedule(delay) {
			if (!pollKeep) return;
			timer = setTimeout(pollOnce, delay == null ? POLL_FAST : delay);
		}

		function failReset() {
			upgrading = false;
			step = 0;
			renderUpgrade();
		}

		/**
		 * 升级流程走到 IDLE（10）后的收尾：用 AT+CGMR 复核固件版本。
		 *
		 * FOTA 指南 4.2 明确写了判成功的方法：「FOTA 升级完毕后，上位机可以通过
		 * AT^VERSION? 命令查询版本和时间变化来判断是否升级成功」。
		 * 也就是说 **50（升级指令设置成功）不等于升级成功** —— 不复核版本，
		 * 就只能「发出去就算完」，跟官方 WebUI 那个假成功没区别。
		 */
		function finishByIdle() {
			stopTimer();
			AtWs.client.sendCommand('AT+CGMR', { fresh: true }).then(function (res) {
				var now = '';
				if (res.success && typeof res.data === 'string') {
					var lines = res.data.replace(/\r/g, '').split('\n')
						.map(function (s) { return s.trim(); })
						.filter(function (l) {
							return l && l.toUpperCase() !== 'OK' && l.toUpperCase().indexOf('AT+CGMR') !== 0;
						});
					now = lines[0] || '';
				}
				upgrading = false;
				/*
				 * ★ 三态判定：成功 / 版本未变化 / 无法判定。
				 *
				 * 原判据是 `now && baseVersion && now !== baseVersion`，它把「基准缺失」这一态
				 * 混进了「失败」：升级前这次 AT+CGMR 若没取到（首屏失败、或用户抢在版本回来前
				 * 就点了开始），baseVersion 就是空串；此时即使升级**真的成功**（now 已是新版本），
				 * 那个 `baseVersion &&` 也会短路成假，一路落到下面报「固件版本未变化」。
				 * —— 把「不知道基准」说成了「没变化」，等于替设备背了个没观测到的结论。
				 *
				 * 拿不到基准时无法自动判定成败，就诚实说无法判定，并指引用 AT^VERSION? 复核
				 * —— 与全项目「解析不了就明说解析不了」的红线一致。
				 */
				if (!baseVersion) {
					step = 0;
					renderVersion();
					renderUpgrade();
					Mt5700.info('升级流程已结束。升级前未能读到固件版本，无法自动判定是否成功'
						+ '（当前版本 ' + (now || '未知')
						+ '）—— 请到终端用 AT^FOTASTATE? 与 AT^VERSION? 复核');
					return;
				}
				if (now && now !== baseVersion) {
					version = now;
					step = 4;
					renderVersion();
					renderUpgrade();
					Mt5700.success('固件升级成功：' + baseVersion + ' → ' + now);
					return;
				}
				step = 0;
				renderVersion();
				renderUpgrade();
				Mt5700.error('升级流程已结束，但固件版本未变化（升级前 ' + (baseVersion || '未知')
					+ '，当前 ' + (now || '未知') + '）—— 请到终端用 AT^FOTASTATE? 与 AT^VERSION? 复核');
			}).catch(function () {
				upgrading = false;
				step = 0;
				renderUpgrade();
				Mt5700.error('升级流程已结束，但复核固件版本失败，请手动确认');
			});
		}

		/**
		 * 下载完成后触发真正的烧写：AT^FWUP。
		 *
		 * ★ 刻意放在 tick 之外：tick 是「读到一个状态 → 决定要不要继续等」的纯状态机，
		 *   里面不该夹带 stopTimer（除了明确的失败终态）。
		 *   这里唯一的 stopTimer 是 AT^FWUP 这条命令本身下发失败 —— 那是确凿的失败，
		 *   而 **不是**「40 这个状态结束了」；40 之后还要继续等 50 / 70。
		 *   混在一起写，就会让人（和契约测试）分不清到底是谁结束了轮询。
		 */
		function beginFirmwareUpgrade() {
			AtWs.client.sendCommand('AT^FWUP').then(function (res) {
				/* 不判 success 就把「下发被拒」报成「升级已开始」；而 fwupSent 一旦
				   置位就封死了重发，失败无法自愈，只能干等轮询超时。
				   ★ 所以失败时还要**复位 fwupSent**（下面），否则这条链就死在这里：
				     case 40 是先置位再调本函数，下一轮直接 `if (fwupSent) break;`，
				     既不重发也进不了 50/70 终态 —— 界面永远停在「固件下载完成」，
				     直到 30 分钟后那条「已等待超过 30 分钟」提示。
				     先前只在调用处补了「判 success」，没解决复位，是同一问题的另一半。*/
				if (res && res.success === false) {
					fwupSent = false;
					fwupTries += 1;
					if (fwupTries >= FWUP_MAX_TRIES) {
						stopTimer();
						Mt5700.error('触发升级失败（已重试 ' + fwupTries + ' 次）：'
							+ String(res.error || '模组未接受') + '。请检查模组状态后重新开始升级');
						failReset();
						return;
					}
					Mt5700.error('触发升级失败（第 ' + fwupTries + ' 次）：'
						+ String(res.error || '模组未接受') + '，稍后自动重试');
					return;
				}
				Mt5700.success('固件升级已开始，设备即将重启');
				renderUpgrade();
			}).catch(function () {
				stopTimer();
				Mt5700.error('触发固件升级失败');
				failReset();
			});
		}

		/**
		 * 处理一次 FOTA 状态。
		 * 需要结束轮询的分支直接 stopTimer()（它会把 pollKeep 置 false），
		 * 调用方据此决定是否排下一轮。
		 *
		 * 终态判定（依据《FOTA 升级指南》5 章 +《AT 命令手册》15.4 / 15.5）：
		 *   · 模组明确给出的失败类终态：13（查询失败）、14（无新版本）、
		 *     20（下载失败）、70（升级失败）；
		 *   · **静默失败**：下发 AT^FOTAOEMDL 后状态走 11（查询中）→ 10（IDLE），
		 *     既不上报 13/14，也不进 30（下载）。这种情况必须判失败 —— 不判的话
		 *     界面会永远停在「等待中」，同样是「检测不到失败」。
		 *     判据：见过 11/12 且没见过 30/31/40，且不是刚下发时的过渡值。
		 *   · 成功：50 之后模组重启、状态回到 10，此时用版本复核来确认（见 finishByIdle）。
		 */
		function tick(state) {
			// 提示只在状态刚变化时弹一次：否则每轮一条 toast，退避前会刷屏。
			var fresh = (sameCount === 0);
			switch (state) {
				case 10:
					if (!upgrading) break;                 // 流程没启动，10 就是正常空闲
					if (sawDownload) { finishByIdle(); break; }
					// 见过 11/12 → 查询确实跑过、只是没转成下载任务。
					// 最常见的就是**服务器没有比当前更新的版本**（有些固件并不上报 14，
					// 而是直接回到 IDLE），也可能是地址/端口/证书不对。
					// 无论哪种，结论都是确定的「本次没升成」—— 必须报出来，不能干等。
					if (sawQuery && sameCount >= 1) {
						stopTimer();
						Mt5700.warning('版本查询已结束但未开始下载：通常是服务器没有更新的版本，'
							+ '也可能是地址/端口/证书不可用 —— 本次未升级');
						failReset();
						break;
					}
					// 连查询都没进去：给模组一个启动窗口，超时仍停在 10 就判终态。
					if (!sawQuery && (Date.now() - pollStartedAt > QUERY_START_TIMEOUT)) {
						stopTimer();
						Mt5700.error('模组始终未进入版本查询流程（' + (QUERY_START_TIMEOUT / 1000)
							+ ' 秒内状态一直是 10）：请检查 FOTA 地址与网络');
						failReset();
					}
					break;
				case 11:
					sawQuery = true;
					if (fresh) Mt5700.info('正在查询新版本...');
					break;
				case 12:
					sawQuery = true;
					if (fresh) Mt5700.info('发现新版本');
					break;
				case 13:
					stopTimer();
					// 子错误码：13=服务器访问失败，51=升级文件获取失败（FOTA 指南 5 章）
					if (stateDetail === 51) {
						Mt5700.error('获取升级文件失败（13,51）：请检查 URL、端口与证书配置');
					} else if (stateDetail === 13) {
						Mt5700.error('服务器访问失败（13,13）：请检查网络与服务器地址');
					} else {
						Mt5700.error('查询新版本失败' + (stateDetail ? '（13,' + stateDetail + '）' : ''));
					}
					failReset();
					break;
				case 14:
					stopTimer();
					Mt5700.error('服务器无新版本：请检查服务器上升级文件的配置');
					failReset();
					break;
				case 20:
					stopTimer();
					Mt5700.error('固件下载失败：请排查网络与存储');
					failReset();
					break;
				case 30:
					sawDownload = true;
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
						/*
						 * 进度查询失败（模组正忙 / 超时 / RPC reject）不能让 Promise 悬着：
						 * 没有 catch 就是 unhandled rejection，而界面停在**上一次**的
						 * 进度数字上 —— 看着像「下载卡死」，实际只是这一轮没读到。
						 * 静默吞掉即可，下一轮（3s 后）会再查，进度照常继续走。
						 */
					}).catch(function () { });
					break;
				case 31:
					sawDownload = true;
					if (fresh) Mt5700.info('下载挂起，尝试续传');
					// 手册建议 31 用 AT^FOTADL=1 或重新下发 AT^FOTAOEMDL 续传，
					// 但**每轮都发就又成了高频命令** —— 至少隔 RESUME_MIN_GAP 才发一次。
					if (Date.now() - lastResumeAt > RESUME_MIN_GAP) {
						lastResumeAt = Date.now();
						/* 续传是尽力而为：失败不打断轮询，下一轮到点会再试，故不弹错 */
						AtWs.client.sendCommand('AT^FOTADL=1').catch(function () {});
					}
					break;
				case 40:
					sawDownload = true;
					// ★ 这里**不能** stopTimer：手册 15.4 明确「若升级失败，上报 ^FOTASTATE: 70」，
					//   发完 AT^FWUP 就停止轮询，等于永远看不到 70，把失败报成成功。
					if (fwupSent) break;                  // 已发过，继续等 50 / 70
					fwupSent = true;
					Mt5700.success('固件下载完成');
					step = 3;
					renderUpgrade();
					beginFirmwareUpgrade();
					break;
				case 50:
					sawUpgrade = true;
					sawDownload = true;
					step = 3;
					if (fresh) Mt5700.info('模组正在升级，完成后会自动重启…');
					renderUpgrade();
					break;
				case 70:
					stopTimer();
					Mt5700.error('固件升级失败（^FOTASTATE: 70）：请排查环境影响因素后重试');
					failReset();
					break;
				default: break;
			}
		}

		function start() {
			if (!agreed) { showDisclaimer(); return; }
			// 连点「开始升级」会起两条轮询链，命令量直接翻倍 —— 在入口就挡掉。
			if (pollKeep || pollBusy) { Mt5700.info('升级流程已在运行中'); return; }
			var url = (urlInput.value || '').trim();
			if (!url) { Mt5700.error('请设置 FOTA 服务器地址'); return; }
			/*
			 * 协议白名单：http 与 https 都放行。
			 *
			 * 手册 15.7.3《AT^FOTAOEMDL》明确写着「支持 HTTP、HTTPS 协议类型」，
			 * 15.7.5 还给出了 https 举例：
			 *   AT^FOTAOEMDL="https://10.14.10.153:443/OnlineUpdate/files/" → OK
			 *
			 * 原先只放行 `http://` 前缀，而 `'https://'.indexOf('http://') === -1` ——
			 * 于是**更安全的那个协议反而被挡在门外**，用户只能用明文下载固件
			 * （固件地址交给模组自己去取，链路上谁替换了镜像都会被装进设备，
			 * 而这条链路此前没有任何校验和/签名校验）。
			 */
			if (!/^https?:\/\//i.test(url)) { Mt5700.error('仅支持 http / https 协议'); return; }
			var formatted = url.charAt(url.length - 1) === '/' ? url : url + '/';

			upgrading = true;
			progress = 0;
			step = 1;
			renderUpgrade();
			Mt5700.info('正在初始化 FOTA…');

			// 每轮流程的记忆位必须清干净，否则上一轮的「见过下载」会带进这一轮，
			// 把新的静默失败误判成「升级结束」。
			stateDetail = 0;
			sawQuery = false;
			sawDownload = false;
			sawUpgrade = false;
			fwupSent = false;
			fwupTries = 0;
			lastResumeAt = 0;
			pollStallWarned = false;

			// 升级前的固件版本是最后判定「到底升没升成功」的基准，必须先拿到。
			var chain = version ? Promise.resolve() : fetchVersion();
			chain.then(function () {
				baseVersion = version;
				return AtWs.client.sendCommand('ATE0');
			}).then(function () {
				return AtWs.client.sendCommand('AT^FOTAMODE=0,1,0,1');
			}).then(function () {
				// 【规范】FOTA 指南 5 章：^FOTAOEMDL 必须在 FOTA 处于 IDLE（10）时下发。
				// 卡在 30/31/40 时要先 AT^FOTADL=0 取消当前任务回到 IDLE（手册 15.3）。
				return queryState();
			}).then(function (st) {
				if (st !== null && st !== 10) {
					throw new Error('模组当前 FOTA 状态为 ' + st + '（' + fotaStateText(st)
						+ '），不是空闲状态 10；请先执行 AT^FOTADL=0 取消当前任务再重试');
				}
				step = 2;
				renderUpgrade();
				/* 只校验 http:// 前缀挡不住引号/换行：值里带 \r\n 就能续接第二条 AT */
				return AtWs.client.sendCommand('AT^FOTAOEMDL="' + Parse.sanitizeAtParam(formatted) + '"');
			}).then(function (res) {
				if (!res.success) {
					Mt5700.error('设置 FOTA 地址失败');
					upgrading = false; step = 0; renderUpgrade();
					return;
				}
				pollStartedAt = Date.now();
				lastState = -1;
				sameCount = 0;
				pollBusy = false;
				pollKeep = true;
				pollOnce();
			}).catch(function (err) {
				stopTimer();
				Mt5700.error((err && err.message) || '固件升级失败');
				upgrading = false;
				step = 0;
				renderUpgrade();
			});
		}

		/* ---------- 初始化 ---------- */
		renderUpgrade();

		Mt5700.connectThen(function () {
			fetchVersion();
			if (!agreed) showDisclaimer();
		});

		self._dispose = function () { stopTimer(); };
		page._onDispose(self._dispose);

		return page;
	}
});
