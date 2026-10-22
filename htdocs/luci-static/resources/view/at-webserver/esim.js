'use strict';
'require at-webserver/rpc';
'require at-webserver/ui';
'require at-webserver/mt5700';
'require at-webserver/euicc';
'require at-webserver/parse';
/* global L, AtWs, Ui, Mt5700, Euicc, Parse, jsQR */
/* 注：jsQR **不走** 'require' —— LuCI 的 require 要求每个模块 return 一个 Class，
   而 jsQR 是第三方 UMD 包（只往全局挂 window.jsQR），硬塞进去会破坏加载契约；
   改为用户真的去用「上传图片 / 拍照」时才按需 <script> 注入（见 loadJsQr），
   平时这 250KB 根本不会下载，不拖慢任何其它页面。 */

/**
 * eSIM 管理（eUICC profile 引导态）
 *
 * 纯前端 APDU，经既有 ubus `mt5700.at` 下发（AtWs.client.sendCommand），
 * 零新增二进制、不抢串口、不引入 lpac（见提案 §1.0）。
 * 本地管理（读 EID / 列 Profile / 启用 / 禁用 / 删除 / 改昵称）全部在前端完成。
 *
 * 下载新 Profile（2026-09-18 补齐）：
 *   - APDU 那一半（ES10b）本页自己拼，经 AT+CSIM 下发；
 *   - HTTPS 那一半（ES9+）浏览器做不了（SM-DP+ 不发 CORS 头），
 *     经新增的 ubus `mt5700.es9p` 由路由器上的 curl 代发一次 POST。
 *   录入支持：粘贴激活码 / 摄像头扫码 / 二维码图片（选择·拖放·粘贴） / 手动填 SM-DP+ 与匹配码，
 *   四条路都收口到 Euicc.parseActivationCode 校验。
 *
 * 二维码识别（2026-09-19 重写）：原先只用 window.BarcodeDetector，而它**只在安全上下文
 *   （https / localhost）提供** —— 用 http://192.168.x.x 访问路由器时它是 undefined，
 *   「扫描二维码」「上传图片」两条路都变成「当前环境不支持」，等于功能没有。
 *   现改为：原生 BarcodeDetector 可用就先用（硬件加速、快），否则一律退回内置的 jsQR
 *   （纯 JS，任何协议下都能解）。摄像头本身仍受同一限制（http 下 getUserMedia 不可用），
 *   故 http 时把「扫码」降级成「用相机拍照」—— 走 <input capture> 调起系统相机，
 *   不需要网页摄像头权限，效果等价。
 *
 * 红线：
 *   - P01  只允许 sendCommand，禁止直连串口 / lpac
 *   - P08  四种引导态必须有落地 DOM，禁止白屏 / 假成功
 *   - P09  删除 = confirm + 输入 ICCID 末 4 位；启用/禁用 = 单层 confirm；重命名 = 不确认
 *   - P10  single-flight（busy 标志）+ 卸载复位 + 写操作绝不重试
 *   - P19  禁止行首裸 then（本文件所有 Promise 链均 .then( 形式）
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('eSIM 管理', '管理卡槽内 eUICC 卡上的 Profile（启用 / 禁用 / 删除 / 重命名）');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 唯一 AT 出口（P01）：只走 AtWs.client.sendCommand ---------- */
		function send(cmd, opts) {
			return AtWs.client.sendCommand(cmd, opts);
		}

		/* ---------- single-flight：独占串口，写操作绝不重试（P10） ---------- */
		var busy = false;

		/*
		 * 最近一次 Euicc.probe() 的结果（含 capacity）。
		 *
		 * ★ 为什么需要这个跨函数通道（审查意见 R01）：probe 的结果只在 renderOk(p)
		 *   的作用域里，而下载入口 runDownload(p, cc) 的那个 `p` 是
		 *   **Euicc.parseActivationCode() 解析出来的激活码**，两者同名不同对象 ——
		 *   直接在下载入口写 `p.capacity` 会恒为 undefined，预检就一次也不会触发，
		 *   而看上去像是已经做了。这里把 probe 结果挂到渲染闭包上，下载流程才够得着。
		 */
		var lastProbe = null;

		/*
		 * 数据承载 IP 观测记录（P13）：每次 Profile 切换收敛后记一笔 PDP 地址。
		 * 元素形如 { key: 归一化 ICCID, addr: 地址文本, time: 'HH:MM:SS' }。
		 * 用途见「数据承载 IP 观测卡」的说明：它是「靠切 Profile 换出口 IP」能否成立的前提证据，
		 * 不是功能入口。
		 */
		var ipObs = [];

		/* 观测卡正文容器（由 renderOk 创建观测卡后赋值）与渲染函数 —— 必须定义在外层，
		   否则 observeDataIp（定义在 renderOk 之外）够不着。 */
		var IP_OBS_MAX = 5;
		var ipObsBody = null;
		function renderIpObs() {
			if (!ipObsBody) return;
			ipObsBody.innerHTML = '';
			if (!ipObs.length) {
				ipObsBody.appendChild(E('div', { 'class': 'mt5700-hint' },
					'暂无记录。启用或禁用任一 Profile，在重注册完成后这里会自动记一笔；' +
					'也可以先点下面的按钮取一次当前出口 IP 作为基线（不切卡、不改任何配置）。'));
				/* 基线探测入口：不切卡就能先知道「现在互联网看到的我是谁」，
				   之后换卡才有得比。失败也要如实显示，不许静默。 */
				ipObsBody.appendChild(Mt5700.ghostButton('探测当前出口 IP', function () {
					if (busy) return;
					if (!AtWs.exitIp) { Mt5700.error('后端未升级：rpcd 没有 mt5700.exitip 方法'); return; }
					ipObsBody.innerHTML = '';
					ipObsBody.appendChild(Mt5700.loading('正在探测出口 IP…'));
					AtWs.exitIp('').then(function (r) {
						lastExitIp = (r && r.success) ? r.ip : '';
						ipObsBody.innerHTML = '';
						ipObsBody.appendChild(E('div', { 'class': r && r.success
							? 'mt5700-notice' : 'mt5700-notice-warning' },
							(r && r.success)
								? ('当前出口 IP：' + r.ip + '（来源 ' + (r.endpoint || '未知') + '）—— 已记为基线')
								: ('未取到出口 IP：' + ((r && r.error) || '未知原因'))));
						/* 探测完把常驻内容补回去，否则这里只剩一行结果 */
						later(renderIpObs, 0);
					});
				}));
				return;
			}
			ipObsBody.appendChild(E('div', { 'class': 'mt5700-esim-sectitle' },
				'最近观测（最多 ' + IP_OBS_MAX + ' 条）'));
			ipObs.slice(-IP_OBS_MAX).forEach(function (it) {
				var verdict = it.changed === 'yes' ? '出口 IP 已变'
					: it.changed === 'no' ? '出口 IP 未变'
						: '出口 IP 无法判定';
				ipObsBody.appendChild(E('div', { 'class': 'mt5700-hint mt5700-mono' },
					it.time + '  ' + it.key));
				ipObsBody.appendChild(E('div', { 'class': 'mt5700-hint mt5700-mono' },
					'　承载 ' + it.addr + '　出口 ' + it.exit + '　' + verdict));
			});

			/*
			 * 结论只在**有可比基线**时才下。
			 * 三者含义不同，别混成一句话：
			 *   ① 出口 IP 变了        → 换卡换 IP 在本机成立；
			 *   ② 出口 IP 没变        → 该运营商/APN 复用同一出口，换卡换不了 IP；
			 *   ③ 无法判定            → 基线或本次没取到，是「不知道」不是「没变」
			 *                          （红线 23：不许把读不出来当成结论）。
			 */
			var last = ipObs[ipObs.length - 1];
			if (last.changed === 'no') {
				ipObsBody.appendChild(E('div', { 'class': 'mt5700-notice-warning mt5700-mt-sm' },
					'换了 Profile 但出口 IP 没变 —— 该运营商/APN 会复用同一个出口地址，' +
					'此环境下「靠切 Profile 换出口 IP」不成立（承载地址也可能一样，见上面的记录）。'));
			} else if (last.changed === 'yes') {
				ipObsBody.appendChild(E('div', { 'class': 'mt5700-notice mt5700-mt-sm' },
					'出口 IP 已变化 —— 本机上「切 Profile ⇒ 换出口 IP」成立。'));
			} else if (last.exit === '未取到' || last.exit === '后端未升级') {
				ipObsBody.appendChild(E('div', { 'class': 'mt5700-notice-warning mt5700-mt-sm' },
					'本次没取到出口 IP（' + last.exit + '），因此**无法判定**换没换 —— 这不是「没变」。'));
			}
		}

		/*
		 * 出口 IP 基线 + 当前生效 Profile（本次会话内有效）。
		 *
		 * ★ 为什么必须是**会话内**的、而不是模块级全局（红线 24）：跨会话/并发传值
		 *   用全局变量会拿到别的页面甚至上一张卡留下的值。这里记的是「这台设备这一刻」
		 *   的状态，页面重载就重新取，绝不带到下一次。
		 *
		 * ★ 为什么要单独记「出口 IP」而不只看 PDP 地址：AT+CGPADDR 给的是承载地址，
		 *   运营商普遍 CGNAT 时它是 10.x/100.x 私网地址 —— 「互联网看到的我」是 CGNAT
		 *   出口地址，两者不是一回事。判断「换卡到底有没有换 IP」只能看后者。
		 *   （对照 vohive：internal/device/pool_health_ip.go 里 privateIP 与 publicIP
		 *   就是分开存、分开比的，本项目此前缺的正是 publicIP 这一半。）
		 */
		var lastExitIp = null;      /* null = 还没取过；'' = 取过但没取到 */
		var currentEnabledRaw = null;   /* 当前处于 enabled 的 Profile 的 iccidRaw */

		/*
		 * ★ 不给自动回滚，只给「一键切回」。
		 *
		 * vohive 在 pool_esim_switch 里有切换失败的 restore，但它的池子里有**多个模组**，
		 * 回滚只是把流量挪到另一条链路上。本设备是**单模组、蜂窝即唯一上行**：
		 * 自动再切一次 = 再制造一次全屋断网窗口，而且第二次切换同样可能失败，
		 * 于是变成「越救越断」。所以这里把决定权交回给用户：把「现在生效的可能是谁 /
		 * 数据承载有没有起来」说清楚，再给一个一键切回的按钮。
		 * 断网类操作必须可预期，这是本项目一贯的取舍（见红线：不自动下发周期类 AT）。
		 */
		function restoreProfile(prevRaw, why) {
			if (!prevRaw) {
				Mt5700.error('无法确定切换前是哪张 Profile，请手动在上方列表里启用要用的那张');
				return;
			}
			if (busy) return;
			Mt5700.confirm('切回原 Profile？' + (why || '') + ' 切换期间网络会再中断一次（约 10~30 秒）。', function () {
				if (busy) { Mt5700.error('有操作正在进行'); return; }
				busy = true;
				try { AtWs.client.clearReadCache(); } catch (e) { /* 无此实现时退化，不得阻断下发 */ }
				Euicc.enableProfile(send, { kind: 'iccid', hex: prevRaw }, true).then(function () {
					busy = false;
					Mt5700.success('已下发切回，等待重注册');
					pollListAfterToggle(prevRaw, '切回');
				}).catch(function (e) {
					busy = false;
					handleErr(e);
				});
			}, '切回');
		}

		/*
		 * 卸载清理清单（V01）：
		 * 启用/禁用成功后会挂 8s 提示与 12s 延迟刷新，扫码还会占着摄像头。
		 * 页面切走时这些定时器/流还在跑 —— 轻则往已卸载的 DOM 里写，
		 * 重则让摄像头指示灯一直亮着。这里统一登记，_onDispose 一次性清掉。
		 */
		var cleanups = [];
		/* P16：添加向导的清理句柄（stopScan）。开新向导前先执行并清掉上一个，
		 * 避免每开一次就 push 一个闭包、cleanups 堆积 N 个。 */
		var wizardStop = null;
		function later(fn, ms) {
			var t = setTimeout(function () {
				var i = cleanups.indexOf(t);
				if (i >= 0) cleanups.splice(i, 1);
				fn();
			}, ms);
			cleanups.push(t);
			return t;
		}

		/* ---------- 通用小工具 ---------- */

		function atText(res) {
			if (!res) return '';
			if (typeof res.data === 'string') return res.data;
			if (res.data && typeof res.data.raw === 'string') return res.data.raw;
			return String(res.data || '');
		}

		/*
		 * 下载失败的**步骤条**文案。
		 *
		 * ★ 不能只贴 e.message：卡片类错误的 message 就是裸状态码
		 *   （makeSwError 把 SW 直接当 message，如「6999」）。用户看到「下载失败：6999」
		 *   既不知道是什么、也不知道该重试还是该放弃 —— 这是真实反馈过的。
		 *   这里统一补上 swInfo 的人话解释，状态码本身仍保留（便于对账）。
		 */
		function downloadFailText(e) {
			if (!e) return '未知错误';
			if (e.swText) {
				return e.swText + '（SW=' + (e.message || '') + '）'
					+ (e.swHint ? '；' + e.swHint : '');
			}
			return (e && e.message) || '未知错误';
		}

		function handleErr(e) {
			var code = e && e.code;
			var msg;
			if (code === 'EUICC_NO_EUICC') {
				msg = '这张卡不是 eUICC，无法管理 Profile';
			} else if (code === 'EUICC_POLICY_DENIED') {
				msg = '该 Profile 的策略禁止此操作（常见于运营商预置 Profile 禁止删除）';
			} else if (code === 'EUICC_BUSY') {
				msg = '卡片工具箱正忙，约 10 秒后重试';
			} else if (code === 'EUICC_NO_CSIM') {
				msg = '当前固件不支持 AT+CSIM，无法与卡通信';
			} else if (code === 'EUICC_NO_CARD') {
				msg = '卡槽内未检测到 SIM 卡（AT 报 NOCARD），请检查插卡';
			} else if (code === 'EUICC_AT_ERROR') {
				/*
				 * R05：与「固件不支持 AT+CSIM」区分开 —— 这里明确是 AT 层没拿到应答。
				 *
				 * ★ 2026-09-20 真机：下载中途最常见的不是「服务挂了」，而是
				 *   「卡还在处理、模组没回结束码」（写卡时卡侧要做密钥运算与非易失
				 *   写入，单条跳到秒级是常态）。把它一律说成「AT 服务未就绪」会误导
				 *   用户去查服务，而实际上服务一直是好的、只是卡慢。这里拆开说。
				 */
				var em = String((e && e.message) || '');
				if (em.indexOf('查不到') >= 0) {
					/* 末块超时 + 核验时卡上确实没有这个 Profile → 是真的没装上 */
					msg = '安装没有完成：卡在处理最后一块时超时，之后重新读取 Profile 列表，'
						+ '卡上查不到这份 Profile。请整包重下；若反复失败，'
						+ '多半是这份 Profile 比卡的处理上限大（可试试重启模组后再下）。';
				} else if (em.indexOf('AT 通道正常') >= 0) {
					msg = '卡一直在忙、始终没吐回结果（补取也已用尽），但 AT 通道本身是好的。'
						+ '收尾安装阶段偶发，等几分钟让卡彻底空闲后整包重下即可。';
				} else if (em.indexOf('AT 通道本身也无响应') >= 0) {
					msg = '模组侧被上一条指令堵住了：连最简单的 AT 都收不到应答。'
						+ '这与 AT 服务无关（服务一直在跑），需要重启模组或整机断电一次才能恢复。';
				} else if (Euicc.isAtTimeoutError && Euicc.isAtTimeoutError(e)) {
					msg = '卡片没有在预期时间内回话。写卡时卡侧要做密钥运算与非易失写入，'
						+ '偶尔会比预期慢（已尝试向卡补取结果）。'
						+ '若反复出现，请确认下载期间没有重拨 / 动接口，然后整包重下。';
				} else {
					msg = 'AT 服务未就绪（未连接到调制解调器或拒绝了指令），请检查 AT 服务';
				}
			} else if (code === 'EUICC_NO_ES9P') {
				msg = '设备侧缺少 ES9+ 通道（rpcd 没有 mt5700.es9p 或设备上没有 curl）'
					+ '，无法与运营商服务器通信';
			} else if (code === 'EUICC_ES9P_FAILED') {
				/* 服务器侧的失败原因必须原样带出来：不同运营商的报错差得很远，
				   统一成一句「下载失败」等于让用户无从下手。 */
				msg = (e && e.message) || '运营商服务器返回失败';
			} else if (code === 'EUICC_CSIM_TRUNCATED') {
				/*
				 * ★ 2026-09-19 真机实测：这是模组固件的能力上限（AT+CSIM 单条响应
				 *   只回 256 字节），不是配置问题也不是组包 bug —— 重试没有任何意义。
				 *   必须单独成支：落到 else 分支只会显示一句原始 message，
				 *   用户看不出「这是设备做不到」，会反复重试甚至怀疑是插件坏了。
				 */
				msg = '当前设备无法下载 Profile：' + ((e && e.message) || '模组 AT+CSIM 单条响应上限 256 字节')
					+ ' 这是模组固件的限制，重试无效；读取 Profile、启用 / 禁用 / 删除不受影响。';
			} else if (code === 'EUICC_OP_FAILED' && e.result != null) {
				/* P07：ES10 结果码优先用中文人话（替代裸串「ES10 result n」） */
				msg = Euicc.es10ResultText(e.result);
			} else if (code === 'EUICC_OP_FAILED' && e.swText) {
				/* R08：优先用 §1.5① 错误矩阵的人话文案 + 提示 */
				msg = e.swText + (e.swHint ? '；' + e.swHint : '');
			} else {
				msg = (e && e.message) || '操作失败';
			}
			Mt5700.error(msg);
		}

		/* ---------- 引导态：G3 无卡（§1.6） ---------- */
		function renderNoCard() {
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			var notice = E('div', { 'class': 'mt5700-notice-warning' },
				'卡槽内未检测到 SIM 卡，请插卡后刷新。');
			card._body.appendChild(notice);
			card._body.appendChild(Mt5700.button('刷新', function () { render(); }, 'primary'));
			body.appendChild(card);
		}

		/* ---------- 引导态：G2 AT+CSIM 不可用（§1.6） ---------- */
		function renderNoCsim(p) {
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			card._body.appendChild(E('div', { 'class': 'mt5700-notice-danger' },
				'当前固件不支持 AT+CSIM，无法与卡通信。'));
			card._body.appendChild(E('p', { 'class': 'mt5700-hint' }, '实际应答原文（已截断）：'));
			/* R12：原样应答截断到 200 字符，避免把整段 AT 日志塞进 DOM */
			card._body.appendChild(E('div', { 'class': 'mt5700-mono' },
				(p && p.raw) ? String(p.raw).slice(0, 200) : '（无应答）'));
			card._body.appendChild(Mt5700.button('重试', function () { render(); }, 'primary'));
			body.appendChild(card);
		}

		/* ---------- 引导态：G1 非 eUICC（§1.6），同时读 ICCID 作佐证 ---------- */
		function renderNoEuicc() {
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			card._body.appendChild(E('div', { 'class': 'mt5700-notice' },
				'卡上没有 eUICC（ISD-R 未找到）。当前卡是普通 USIM，不支持 eSIM profile 管理。'));

			var iccidLine = E('div', { 'class': 'mt5700-hint' }, '正在读取卡槽 ICCID…');
			card._body.appendChild(iccidLine);
			send('AT^ICCID?', { fresh: true }).then(function (r) {
				var m = atText(r).match(/ICCID:\s*([0-9A-Fa-f]+)/);
				iccidLine.textContent = m ? ('卡槽 ICCID：' + m[1]) : '无法读取卡槽 ICCID';
			}).catch(function () {
				iccidLine.textContent = '无法读取卡槽 ICCID';
			});

			/*
			 * ★ 当前卡槽号（AT^SCICHG?）—— 裸值直出，不做猜测性文案。
			 *
			 *   为什么必须补这一行：手册《11 鼎桥私有接口：状态控制命令》明载本模组是
			 *   **单 Modem 双卡槽（卡槽 0 / 卡槽 1）**。选在外置卡槽上时，卡上没有 ISD-R
			 *   是**正常现象**，而页面原来只说「这张卡不是 eUICC」，把「选错卡槽」
			 *   误报成「卡不支持」—— 用户会据此得出错误结论（甚至去换卡）。
			 *
			 *   ★ 显示裸值而不是「请先切到内置卡槽」：后者是在替用户猜，且切卡槽走
			 *   ^HVSST/^SCICHG 写命令（高危、会断网），本页**不代劳**。读到几就显示几，
			 *   读不到就明说读不到 —— 不许把「读不出来」兜成「内置卡槽」（无差别 catch 红线）。
			 */
			var slotLine = E('div', { 'class': 'mt5700-hint' }, '正在读取当前卡槽…');
			card._body.appendChild(slotLine);
			send('AT^SCICHG?').then(function (r) {
				var m = atText(r).match(/\^SCICHG:\s*(\d+)/);
				slotLine.textContent = m ? ('当前卡槽：' + m[1]) : '无法读取当前卡槽（命令已返回但无法识别）';
			}).catch(function () {
				slotLine.textContent = '无法读取当前卡槽';
			});

			var explain = E('div', { 'class': 'mt5700-card' });
			explain.appendChild(E('div', { 'class': 'mt5700-card-header' },
				E('h3', { 'class': 'mt5700-card-title' }, '关于本页')));
			var eb = E('div', { 'class': 'mt5700-card-body' });
			eb.appendChild(E('p', { 'class': 'mt5700-hint' },
				'本页管理卡上的 Profile（启用 / 禁用 / 删除 / 重命名）。下载安装新 Profile 走的是自研链路：'
				+ '卡侧 APDU 经 AT+CGLA（探测不到时回退 AT+CSIM），HTTPS 那一半由路由器代发（ubus mt5700.es9p），'
				+ '全程不依赖任何第三方二进制。当前这张卡没有 ISD-R，不是 eUICC，因此下载同样不可用。'));
			explain.appendChild(eb);
			card._body.appendChild(explain);

			card._body.appendChild(buildAddZone());
			body.appendChild(card);
		}
		/*
		 * ★ 2026-09-19 真机排查暴露的问题：探测失败时页面只有一句「读取 eSIM 信息失败，
		 *   请稍后重试」，真实病因（err.code）只写进 console —— 用户（和排查的人）无从判断
		 *   到底是卡不支持、固件不支持透传、还是 AT 服务没起来，只能干等重试。
		 *   这里给每个 code 配一句中文说明显示出来。
		 *   R12 保持不变：内部诊断码字面量（EUICC_xxx）不进用户可见文案，只出中文。
		 */
		var ERR_HINT = {
			EUICC_AT_ERROR: 'AT 服务未就绪，或 AT 层拒绝了某条指令 —— 先确认模组已连接（状态页有信号），再重试。',
			EUICC_NO_CSIM: '固件不支持 AT+CSIM 透传，本页无法管理 eUICC（这与卡本身无关）。',
			EUICC_NO_CARD: '卡槽里没有检测到卡片。',
			EUICC_NO_CHANNEL: '逻辑通道申请失败，已自动改用基本通道后仍然失败。',
			EUICC_CHANNEL_LEAK: '疑似逻辑通道泄漏，建议重启模组后再试。',
			EUICC_NO_EUICC: '这张卡上没有 ISD-R（通常是普通 USIM，不是 eUICC）。',
			EUICC_BUSY: '卡片正忙，约 10 秒后重试。',
			/* ★ 2026-09-20：原文案「可能是 M2M 卡或厂家锁卡」已被真机推翻（见 euicc.js
			   swInfo('6985') 注释），且 ES10 result 3 与「卡被锁」并没有因果证据；
			   保持可读即可，不再往「M2M / 锁卡」上引。 */
			EUICC_POLICY_DENIED: '卡片当前不允许该操作（Profile 状态不符，或卡侧策略拒绝）。',
			EUICC_OP_FAILED: '卡片返回了失败状态字，本页无法完成该操作。',
			EUICC_TLV_TRUNCATED: '卡片返回的数据过长，分次取余超过了上限。',
			EUICC_UNSUPPORTED_TAG: '卡片返回了本页不认识的数据字段。',
			EUICC_BAD_HEX: '数据格式异常（十六进制解析失败）。',
			EUICC_BAD_APDU: '指令组装异常。',
			EUICC_NO_ES9P: '缺少下载通道（后端未提供 ES9+ 转发）。',
			EUICC_ES9P_FAILED: '下载服务器返回失败。'
		};

		function renderError(p) {
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			/* R12：code 是内部诊断码，绝不进用户可见文案；只出中文 + 进 console */
			var code = (p && p.error) || '';
			/* ★ 2026-09-19：主文案必须带原因。旧版恒为「读取 eSIM 信息失败，请稍后重试。」
			   而真正的诊断码只进 console —— 用户（和我排查时）根本无从判断是卡的问题、
			   固件不支持 CSIM、还是 AT 服务没起来。现在把中文原因直接放主文案。 */
		var hint = ERR_HINT[code];
		/*
		 * ★ 2026-09-20：probe 的 error 态现在会带回 swText / swHint（euicc.js 的
		 *   SW 错误矩阵），比按 code 查的通用文案具体得多 —— 同一个 EUICC_OP_FAILED
		 *   背后可能是十几种 SW。有就优先用，SW 原值保留便于对账（同 downloadFailText F2）。
		 */
		var detail = '';
		if (p && p.swText) {
			detail = p.swText + (p.swHint ? '；' + p.swHint : '') +
				(p.sw ? '（SW=' + p.sw + '）' : '');
		}
		card._body.appendChild(Mt5700.errorState(
			'读取 eSIM 信息失败：' + (detail || hint || '请稍后重试。'),
			function () { render(); }));
		body.appendChild(card);
		if (code && typeof console !== 'undefined' && console.warn) {
			console.warn('[esim] 探测错误 code=' + code);
		}
		}

		/*
		 * 卡级阻断（暂态）——2026-09-20 真机新增。
		 * ---------------------------------------------------------------------------
		 * 与 renderError 分开渲染的理由：这**不是**一句「读取失败」能说清的，用户需要
		 * 知道①不是页面/固件的锅 ②多做几次没有意义 ③下一步该做什么。
		 *
		 * ★ 落屏依据必须按 SW 分开说（第一版把它们混成一句，等于替 6999 那条路径
		 *   编造了没发生过的事实）。真 probe 打真设备（.workbuddy/tmp/probe_real.js）：
		 *   probe 先 detectTransport → `AT+CGLA=0,...` 回 `+CGLA: 4,"6999"` → transport
		 *   判成 cgla → 名义通道 1、不 open、无基本通道回退 → SELECT ISD-R 拿 6999。
		 *   也就是**根本没碰过基本通道**，此时说「基本通道上所有命令都 6985」是假话。
		 *   两条证据（判据见 euicc.js 的 api.isCardBlockedSw）：
		 *     · sw=6999（CGLA）：JavaCard SW_APPLET_SELECT_FAILED，ISD-R 选不上；
		 *     · sw=6985（CSIM 基本通道 ch=0）：卡对最后一条可用通道也拒。
		 *   同源成因：上一次写卡 / 选卡被中断后卡侧没有收尾，只能靠复位卡片
		 *   （重启模组 / 整机断电重上电）恢复，软件侧没有可用的复位入口。
		 *   · 6985 / 6999 与「M2M 卡 / 厂家锁卡」都没有证据链，别在这里写回去。
		 *
		 * 正文是 errorState 的**纯文本**子节点（不认 Markdown），不许出现 ** 星号。
		 */
		function renderBlocked(p) {
			var sw = (p && p.sw) || '';
			var why = (sw === '6999')
				? '卡片当前选不上 ISD-R 应用（SW=6999，应用选择失败）。'
				: '卡片对基本通道上的每一条命令都回 6985（SW=6985，使用条件不满足）。';
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			card._body.appendChild(Mt5700.errorState(
				'读取 eSIM 信息失败：卡片处于暂态阻断。' + why
				+ '这是上一次写卡 / 选卡过程被中断后卡侧没有收尾留下的状态，'
				+ '不是页面或固件的故障。反复操作不会改变结果，'
				+ '需要重启模组（或整机断电重上电）后恢复。',
				function () { render(); },
				'重新探测'));
			body.appendChild(card);
			if (typeof console !== 'undefined' && console.warn) {
				console.warn('[esim] 卡级阻断（SW=' + sw + '）：卡片需复位，反复探测不会改变结果');
			}
		}

		/* ---------- ES9+ 通道（后端转发） ----------
		 * 浏览器直连运营商的 SM-DP+ 会被 CORS 拦掉（SM-DP+ 不发 CORS 头），
		 * 所以 HTTPS 那一半由路由器代发（ubus mt5700.es9p → curl）；
		 * APDU 那一半仍在浏览器侧经 AT+CSIM 完成。
		 * 这里把它包成 Euicc 需要的形状：(host, path, json) => Promise<{status, body}>。
		 */
		function es9pSend(host, path, json) {
			return AtWs.es9p(host, path, json).then(function (r) {
				if (!r || !r.success) {
					var e = new Error((r && r.error) || '服务器请求失败');
					e.code = 'EUICC_ES9P_FAILED';
					throw e;
				}
				return { status: r.status, body: r.body };
			});
		}

		/*
		 * 通道可用性只问一次：老固件的 rpcd 里没有 mt5700.es9p 这个 ubus 方法，
		 * 那时 L.rpc.declare 会直接被拒 —— 必须给出「设备侧缺通道」的明确说明，
		 * 而不是让「添加」按钮点了没反应。
		 */
		var es9pState = { asked: false, available: false, error: '' };
		function probeEs9p(cb) {
			if (es9pState.asked) { cb(); return; }
			es9pState.asked = true;
			AtWs.es9pAvailable().then(function (r) {
				es9pState.available = !!(r && r.available);
				es9pState.error = (r && r.error) || '';
			}, function () {
				es9pState.available = false;
				es9pState.error = '探测失败';
			}).then(function () { cb(); });
		}

		/* ---------- 卡容量（展示） ----------
		 *
		 * 数据来自 GetEuiccInfo2（BF22）里的 extCardResource，由 Euicc.probe() 带回。
		 *
		 * ★ 只展示「剩余」，不编造「总量 / 百分比」：SGP.22 的 ExtCardResource
		 *   只定义 freeNonVolatileMemory / freeVolatileMemory / installedApplication
		 *   三项，**没有总容量字段**，卡也不提供已用字节数。硬凑一个分母只会显示假数，
		 *   所以这里如实给剩余量，并在界面上说明为什么没有百分比。
		 */
		function groupDigits(n) {
			return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		}
		function fmtBytes(n) {
			if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
			if (n < 1024) return groupDigits(n) + ' 字节';
			var kb = n / 1024;
			var tail = (kb >= 1024) ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
			return groupDigits(n) + ' 字节（' + tail + '）';
		}
		function hasNum(v) { return typeof v === 'number' && isFinite(v); }

		/* 「已装 Profile」那格要等列表读完才填得出来，先占位、后回填。 */
		var capProfileMetric = null;

		/* ---------- 添加 Profile（二维码 / 激活码 / 手动参数） ----------
		 *
		 * 三种录入方式都收口到同一个 parseActivationCode，差别只在「怎么把码弄进来」：
		 *   粘贴激活码 —— 最稳，任何环境都能用；
		 *   扫描 / 图片 —— 走浏览器原生 BarcodeDetector，只有在**安全上下文**
		 *                  （https 或 localhost）才存在；LuCI 是 http://192.168.x.x，
		 *                  所以这两项在大多数机器上不可用，届时按钮会被禁用并说明原因，
		 *                  绝不给一个点了没反应的假按钮。
		 *   手动填写   —— 运营商只给了 SM-DP+ 与匹配码（没有二维码）时的兜底。
		 */
		function buildAddZone() {
			/*
			 * ★ 原来这里用 .mt5700-danger-zone-title 当标题 —— 那是**危险操作区**的
			 *   样式（红字），而「添加 Profile」是完全正常的功能。红标题出现在正常
			 *   区域既误导（看着像有风险），又孤立（它的母容器并没有 .mt5700-danger-zone
			 *   的红框）。改用与卡内其它分区一致的 .mt5700-esim-sectitle。
			 */
			var zone = E('div', { 'class': 'mt5700-mt-lg' });
			zone.appendChild(E('div', { 'class': 'mt5700-esim-sectitle' }, '添加 Profile'));

			if (!es9pState.available) {
				zone.appendChild(E('p', { 'class': 'mt5700-hint' },
					'下载新 Profile 需要路由器能访问运营商的 SM-DP+ 服务器（ES9+ 通道）。'
					+ '当前不可用：' + (es9pState.error || '未探测到 mt5700.es9p 方法')
					+ '。请确认插件已升级到含该方法的版本、且设备上存在 curl。'));
				var off = Mt5700.button('添加 Profile', function () { }, 'primary');
				off.disabled = true;
				var offRow = E('div', { 'class': 'mt5700-inline mt5700-mt-sm' });
				offRow.appendChild(off);
				/* P02：列出 / 补发待发回执是纯 APDU，不需要 ES9+，故即便下载不可用也保留入口，
				 *      避免用户在没有 curl 的设备上连「卡上有没有待发回执」的知情权都没有。 */
				offRow.appendChild(Mt5700.ghostButton('处理待发回执', function () { processNotifications(); }));
				zone.appendChild(offRow);
				return zone;
			}

			zone.appendChild(E('p', { 'class': 'mt5700-hint' },
				'用运营商给的二维码或激活码下载并写入新 Profile。'
				+ '下载过程要与运营商服务器通信，期间请保持网络畅通、不要断电。'));

			/* ★ E(tag, attrs, child) 只挂载第 3 个参数、第 4 个起被**静默丢弃**。
			   原来在这里三个节点一次传进去，结果「处理待发回执」按钮从来没被挂上
			   —— 只有「添加 Profile」可见。必须逐个 appendChild。
			   host 先声明、后挂载（放按钮下方），按钮回调靠闭包延迟取值。 */
			var host = E('div', { 'class': 'mt5700-mt-sm' });
			var actRow = E('div', { 'class': 'mt5700-inline mt5700-mt-sm' });
			actRow.appendChild(Mt5700.button('添加 Profile', function () { openAddWizard(host); }, 'primary'));
			actRow.appendChild(Mt5700.ghostButton('处理待发回执', function () { processNotifications(); }));
			zone.appendChild(actRow);
			zone.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
				'「处理待发回执」用于补发卡上没发出去的安装结果：'
				+ '装完 Profile 后卡会生成一条回执，服务器收不到就会一直挂着未确认。'));
			zone.appendChild(host);
			return zone;
		}

		function hasBarcodeDetector() {
			return (typeof window !== 'undefined') && !!window.BarcodeDetector;
		}

		/* 摄像头能否调用。与 BarcodeDetector 一样受安全上下文限制：http 下为 false。 */
		function hasCamera() {
			return (typeof navigator !== 'undefined')
				&& !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
		}

		/* ---------- 二维码识别：原生优先、内置兜底（2026-09-19） ----------
		 * 原实现只认 window.BarcodeDetector，而它仅在 https / localhost 提供 →
		 * http 访问路由器时扫码与图片识别双双不可用。这里把「能不能识别」和
		 * 「用哪种实现」解耦：原生可用就用原生，否则一律用内置 jsQR。
		 * 全程只在本机 <canvas> 里解码，图片不上传、不走网络。 */

		/* 把 image / video / ImageBitmap 画进 canvas 取像素。maxSide 用于降采样提速。 */
		function qrToImageData(src, maxSide) {
			var w = src.videoWidth || src.naturalWidth || src.width;
			var h = src.videoHeight || src.naturalHeight || src.height;
			if (!w || !h) return null;
			var scale = 1;
			if (maxSide && (w > maxSide || h > maxSide)) scale = maxSide / Math.max(w, h);
			var cw = Math.max(1, Math.round(w * scale));
			var ch = Math.max(1, Math.round(h * scale));
			var cv = document.createElement('canvas');
			cv.width = cw;
			cv.height = ch;
			var ctx = cv.getContext('2d', { willReadFrequently: true });
			if (!ctx) return null;
			ctx.drawImage(src, 0, 0, cw, ch);
			return ctx.getImageData(0, 0, cw, ch);
		}

		/* 按需加载内置解码器。同一个向导里只注入一次（jsQrLoading 复用同一个 Promise），
		 * 失败时把标志清掉，下次点还会再试（不能因为一次网络抖动就永久废掉这条路）。 */
		var jsQrLoading = null;
		function loadJsQr() {
			if (typeof jsQR === 'function') return Promise.resolve(jsQR);
			if (jsQrLoading) return jsQrLoading;
			jsQrLoading = new Promise(function (resolve, reject) {
				var s = document.createElement('script');
				s.src = '/luci-static/resources/at-webserver/jsqr.js';
				s.async = true;
				s.onload = function () {
					resolve(typeof jsQR === 'function' ? jsQR : null);
				};
				s.onerror = function () {
					jsQrLoading = null;   /* 清掉才能重试 */
					reject(new Error('二维码解码库加载失败'));
				};
				document.head.appendChild(s);
			});
			return jsQrLoading;
		}

		/* 返回 Promise<string|null>：null = 没识别到（不抛异常，不打断录入流程） */
		function jsQrText(img) {
			return loadJsQr().then(function (fn) {
				if (!fn) return null;
				var r = null;
				/* 解码器对极端图可能抛异常：吞掉并按「没识别到」处理，
				   让它与「图里确实没有二维码」走同一条提示，不把用户带到报错页面。 */
				try {
					r = fn(img.data, img.width, img.height);
				} catch (e) {
					return null;
				}
				return (r && r.data) ? String(r.data) : null;
			/* 解码器整体失败（含 jsQR 内部抛异常）同样按「没识别到」处理，
			   与上面 try/catch 同一口径：让用户看到"没识别到"，而不是被带到报错页 */
			}).catch(function () { return null; });
		}

		/* 统一入口：返回 Promise<string|null>。null = 没识别到（不抛异常）。 */
		function decodeQr(src, maxSide) {
			var img = qrToImageData(src, maxSide);
			if (!img) return Promise.resolve(null);
			if (!hasBarcodeDetector()) return jsQrText(img);
			return Promise.resolve()
				.then(function () {
					return new window.BarcodeDetector({ formats: ['qr_code'] }).detect(src);
				})
				.then(function (codes) {
					if (codes && codes.length && codes[0].rawValue) return String(codes[0].rawValue);
					return null;
				})
				.catch(function () { return null; })
				/* 原生没认出来不等于图里没有：再让 jsQR 试一次（两者算法不同，互补） */
				.then(function (v) { return (v != null && v !== '') ? v : jsQrText(img); });
		}

		function fileToImage(file) {
			return new Promise(function (resolve, reject) {
				var rd = new FileReader();
				rd.onload = function () {
					var im = new Image();
					im.onload = function () { resolve(im); };
					im.onerror = function () { reject(new Error('这个图片格式解不开')); };
					im.src = String(rd.result);
				};
				rd.onerror = function () { reject(new Error('读取文件失败')); };
				rd.readAsDataURL(file);
			});
		}

		/* 剪贴板粘贴：整个页面只挂一次监听，具体 handler 由当前向导按需设置/清空，
		   避免每次打开向导都重复挂一个（旧 handler 的闭包指向已销毁的 DOM）。 */
		var pasteHandler = null;
		var pasteBound = false;
		function bindPasteOnce() {
			if (pasteBound || typeof document === 'undefined') return;
			pasteBound = true;
			document.addEventListener('paste', function (e) {
				if (!pasteHandler) return;
				var items = e.clipboardData && e.clipboardData.items;
				if (!items) return;
				for (var i = 0; i < items.length; i++) {
					var it = items[i];
					if (it && it.type && String(it.type).indexOf('image/') === 0) {
						var f = (typeof it.getAsFile === 'function') ? it.getAsFile() : null;
						if (f) {
							e.preventDefault();
							pasteHandler(f);
							return;
						}
					}
				}
			});
		}

		/* 逐级换尺度再解一次：小码在高倍降采样下会糊掉，尺度太大又慢。
		 * 两档基本覆盖手机截图与相机原图；都不行就如实判「没识别到」（不抛异常）。 */
		function decodeQrTry(im) {
			var sizes = [1000, 2000];
			var i = 0;
			function next() {
				if (i >= sizes.length) return Promise.resolve(null);
				var max = sizes[i++];
				return decodeQr(im, max).then(function (v) {
					return (v != null && v !== '') ? v : next();
				});
			}
			return next();
		}

		/* 图片录入的统一控件：选文件 / 拖放 / 剪贴板粘贴，三条路都收口到 opts.onText。
		 * opts.capture=true 时给 input 加 capture='environment'（手机直接调起后置相机），
		 * 这正是 http 页面无法 getUserMedia 时的替代方案：拍照不需要任何网页权限。 */
		function buildImagePicker(opts) {
			opts = opts || {};
			var tip = E('p', { 'class': 'mt5700-hint' }, opts.tip0 || '选择二维码图片。');
			var file = E('input', { 'class': 'mt5700-input', 'type': 'file', 'accept': 'image/*' });
			file.style.width = '100%';
			if (opts.capture) file.setAttribute('capture', 'environment');

			var zone = E('div', { 'class': 'mt5700-hint' },
				'也可以把二维码图片拖到这里，或直接粘贴（电脑 Ctrl+V / 手机长按粘贴）');
			zone.style.border = '1px dashed var(--mt5700-border, #999)';
			zone.style.padding = '14px';
			zone.style.textAlign = 'center';
			zone.style.cursor = 'pointer';
			zone.style.marginTop = '8px';

			function mark(on) { zone.style.background = on ? 'rgba(127,127,127,.12)' : ''; }

			function pick(f) {
				if (!f) return;
				/* 控件可能已被下一次 paintInput 换掉：还挂在文档上才继续，顺手解绑粘贴 */
				if (!tip.parentNode) { pasteHandler = null; return; }
				if (f.type && String(f.type).indexOf('image/') !== 0) {
					tip.textContent = '这不是图片文件（' + f.type + '）。';
					return;
				}
				tip.textContent = '识别中…';
				fileToImage(f).then(function (im) {
					return decodeQrTry(im);
				}).then(function (v) {
					if (!tip.parentNode) return;
					if (v == null || v === '') {
						tip.textContent = '这张图里没识别到二维码：换一张更清晰的（别裁掉四周白边），或改用「粘贴激活码」。';
						return;
					}
					opts.onText(String(v), tip);
				}).catch(function (e) {
					if (!tip.parentNode) return;
					tip.textContent = '识别失败：' + ((e && e.message) || '这个文件打不开');
				});
			}

			file.addEventListener('change', function () { pick(file.files && file.files[0]); });
			zone.addEventListener('click', function () { file.click(); });
			['dragenter', 'dragover'].forEach(function (ev) {
				zone.addEventListener(ev, function (e) { e.preventDefault(); mark(true); });
			});
			['dragleave', 'dragend'].forEach(function (ev) {
				zone.addEventListener(ev, function () { mark(false); });
			});
			zone.addEventListener('drop', function (e) {
				e.preventDefault();
				mark(false);
				var dt = e.dataTransfer;
				pick(dt && dt.files && dt.files[0]);
			});
			/* 页面级 paste 监听只挂一次（bindPasteOnce），这里只换 handler */
			pasteHandler = pick;

			var wrap = E('div');
			wrap.appendChild(Mt5700.formGroup(opts.label || '二维码图片', file,
				opts.hint || '图片只在本机解码，不上传'));
			wrap.appendChild(zone);
			wrap.appendChild(tip);
			return wrap;
		}

		function openAddWizard(host) {
			host.innerHTML = '';
			var box = E('div', { 'class': 'mt5700-card' });
			box.appendChild(E('div', { 'class': 'mt5700-card-header' },
				E('h3', { 'class': 'mt5700-card-title' }, '添加 Profile')));
			var b = E('div', { 'class': 'mt5700-card-body' });
			box.appendChild(b);
			host.appendChild(box);

			var mode = 'code';
			var stream = null;      /* 扫码用的摄像头流，关向导时必须停掉 */
			var scanTimer = null;

			var seg = Mt5700.segmented([
				{ label: '粘贴激活码', value: 'code' },
				{ label: '扫描二维码', value: 'scan' },
				{ label: '上传图片', value: 'image' },
				{ label: '手动填写', value: 'manual' }
			], mode, function (v) { stopScan(); mode = v; paintInput(); });
			b.appendChild(seg.el);
			if (!hasCamera()) {
				b.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'识别二维码本身不需要 https（已内置解码器）；但浏览器不允许 http 页面'
					+ '直接调用摄像头，所以「扫描二维码」在这里会改用相机拍照 —— 手机上点它就'
					+ '会打开相机，拍完自动识别，效果一样。（想要实时取景扫码，请用 https 访问路由器。）'));
			}
			bindPasteOnce();

			var inputBox = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(inputBox);
			var preview = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(preview);
			var ccBox = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(ccBox);
			var actions = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(actions);
			var logBox = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(logBox);

			/* 三种模式下「当前这份激活码」的统一取法 */
			var codeInput = null, smdpInput = null, midInput = null, oidInput = null;
			var ccInput = null, ccChk = null;

			function currentCode() {
				if (mode === 'manual') {
					var o = {
						smdp: (smdpInput && smdpInput.value) || '',
						matchingId: (midInput && midInput.value) || '',
						oid: (oidInput && oidInput.value) || ''
					};
					if (ccChk && ccChk.checked) o.confirmationCodeRequired = true;
					return Euicc.buildActivationCode(o);
				}
				return (codeInput && codeInput.value) || '';
			}

			function showPreview() {
				preview.innerHTML = '';
				var p = Euicc.parseActivationCode(currentCode());
				if (!currentCode()) return;
				if (!p.ok) {
					preview.appendChild(E('div', { 'class': 'mt5700-notice-warning' }, p.error));
					renderCc(p);
					return;
				}
				var rows = [
					['SM-DP+ 服务器', p.smdp],
					['匹配码', p.matchingId]
				];
				if (p.oid) rows.push(['OID', p.oid]);
				rows.push(['确认码', p.confirmationCodeRequired === true ? '必填'
					: (p.confirmationCodeRequired === false ? '不需要' : '服务器未声明')]);
				preview.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
				renderCc(p);
			}

			function renderCc(p) {
				ccBox.innerHTML = '';
				var need = p.ok && p.confirmationCodeRequired !== false;
				if (!need) return;
				ccInput = Mt5700.input('text', '确认码（区分大小写）');
				ccInput.type = 'password';
				ccBox.appendChild(Mt5700.formGroup('确认码', ccInput,
					p.confirmationCodeRequired === true
						? '该激活码声明需要确认码，必填'
						: '若运营商要求则填写；留空表示不发送确认码'));
			}

			function stopScan() {
				pasteHandler = null;   /* 关向导 / 换录入方式时解绑，避免旧 handler 指向已销毁的 DOM */
				if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
				if (stream) {
					try {
						stream.getTracks().forEach(function (t) { t.stop(); });
					} catch (e) { /* 停不掉就算了，页面卸载时浏览器也会回收 */ }
					stream = null;
				}
			}
			/* P16：push 前先执行并清掉上一个向导的 stopScan，cleanups 只保留最新一个 */
			if (wizardStop) {
				try { wizardStop(); } catch (e) { /* 清理失败忽略 */ }
				var wsIdx = cleanups.indexOf(wizardStop);
				if (wsIdx >= 0) cleanups.splice(wsIdx, 1);
			}
			wizardStop = stopScan;
			cleanups.push(stopScan);

			/* 识别结果落地：摄像头 / 拍照 / 图片三条路都过一遍 parseActivationCode；
			 * 不合法的也填进输入框让用户核对，而不是悄悄丢掉（P08：不许假成功也不许无反馈）。 */
			function applyQrText(text, tip) {
				if (!codeInput) return;
				var t = String(text == null ? '' : text).trim();
				if (!t) { tip.textContent = '识别结果为空，请重试或手动填写。'; return; }
				codeInput.value = t;
				var p = Euicc.parseActivationCode(t);
				tip.textContent = p.ok
					? '已识别，确认无误后点「开始下载」。'
					: '识别到了内容，但不是有效的激活码（' + p.error + '）；已填入下方输入框，请核对或手动修正。';
				showPreview();
			}

			/* 剪贴板里粘进来的是图片（而不是文字）时，直接切到「上传图片」——
			 * 用户本来就是想扫这张图，不该让他先手动切模式再粘一次。 */
			function pasteImageSwitch(f) {
				if (!f) return;
				stopScan();
				mode = 'image';
				seg.setValue('image');
				paintInput();
				var h = pasteHandler;
				if (h && h !== pasteImageSwitch) h(f);
			}

			function paintInput() {
				inputBox.innerHTML = '';
				preview.innerHTML = '';
				ccBox.innerHTML = '';
				ccInput = null;
				pasteHandler = null;

				if (mode === 'code') {
					codeInput = E('textarea', {
						'class': 'mt5700-input', 'rows': 3,
						'placeholder': 'LPA:1$smdp.example.com$MATCHING-ID'
					});
					codeInput.style.width = '100%';
					codeInput.addEventListener('input', showPreview);
					inputBox.appendChild(Mt5700.formGroup('激活码', codeInput,
						'运营商给的二维码扫出来就是这串；也可以直接粘贴。'));
					pasteHandler = pasteImageSwitch;
					return;
				}

				if (mode === 'scan') {
					if (!hasCamera()) {
						/* http 页面拿不到 getUserMedia（浏览器只给安全上下文），但「拍照」不需要
						 * 任何网页权限：<input capture> 由系统相机接管，拍完直接回页面解码，
						 * 手机上与实时取景扫码体验一致。 */
						inputBox.appendChild(E('p', { 'class': 'mt5700-hint' },
							'当前环境不能实时取景（浏览器只允许 https 页面直接开摄像头）。'
							+ '已改为「拍照识别」：点下面的按钮调起系统相机，拍完自动识别。'));
						codeInput = Mt5700.input('text', '识别结果');
						codeInput.addEventListener('input', showPreview);
						inputBox.appendChild(buildImagePicker({
							label: '拍照 / 选择二维码',
							capture: true,
							hint: '会调起系统相机（不是网页取景），拍完自动识别',
							tip0: '对准运营商给的二维码拍照。',
							onText: function (t, tip) { applyQrText(t, tip); }
						}));
						inputBox.appendChild(Mt5700.formGroup('识别结果', codeInput, '也可手动修正'));
						return;
					}
					var video = E('video');
					video.style.width = '100%';
					video.style.maxWidth = '360px';
					video.setAttribute('playsinline', '');
					inputBox.appendChild(video);
					var tip = E('p', { 'class': 'mt5700-hint' }, '正在启动摄像头…');
					inputBox.appendChild(tip);
					codeInput = Mt5700.input('text', '扫码结果');
					codeInput.addEventListener('input', showPreview);
					inputBox.appendChild(Mt5700.formGroup('扫码结果', codeInput, '也可手动修正'));

					navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
						.then(function (s) {
							stream = s;
							video.srcObject = s;
							video.play();
							tip.textContent = '把运营商的二维码对准摄像头…';
							(function loop() {
								scanTimer = setTimeout(function () {
									if (!stream) return;
									/* 逐帧解码走统一入口：原生 BarcodeDetector 可用就用，否则内置 jsQR */
									decodeQr(video, 640).then(function (v) {
										if (v != null && v !== '') {
											applyQrText(v, tip);
											stopScan();
											return;
										}
										if (stream) loop();
									/* 单帧解码失败不打断：继续下一帧，直到识别成功、用户取消或超时。
									   这里没有用户可见反馈是刻意的 —— 扫码过程中每一帧都可能失败，
									   逐帧提示只会让画面一直闪 */
								}).catch(function () { if (stream) loop(); });
								}, 300);
							})();
						}).catch(function (e) {
							tip.textContent = '摄像头启动失败：' + ((e && e.message) || '无权限或不支持')
								+ '（请改用「粘贴激活码」或「上传图片」）';
						});
					return;
				}

				if (mode === 'image') {
					codeInput = Mt5700.input('text', '识别结果');
					codeInput.addEventListener('input', showPreview);
					inputBox.appendChild(buildImagePicker({
						label: '二维码图片',
						hint: '图片只在本机解码，不上传',
						tip0: '选择运营商给的二维码截图。',
						onText: function (t, tip) { applyQrText(t, tip); }
					}));
					inputBox.appendChild(Mt5700.formGroup('识别结果', codeInput, '也可手动修正'));
					return;
				}

				/* manual */
				pasteHandler = pasteImageSwitch;
				smdpInput = Mt5700.input('text', 'smdp.example.com');
				midInput = Mt5700.input('text', 'MATCHING-ID');
				oidInput = Mt5700.input('text', '可留空');
				ccChk = E('input', { 'type': 'checkbox' });
				var sync = function () { showPreview(); };
				smdpInput.addEventListener('input', sync);
				midInput.addEventListener('input', sync);
				oidInput.addEventListener('input', sync);
				inputBox.appendChild(Mt5700.formGroup('SM-DP+ 服务器', smdpInput, '运营商给的下载服务器域名'));
				inputBox.appendChild(Mt5700.formGroup('匹配码', midInput, 'Activation Code / Matching ID'));
				inputBox.appendChild(Mt5700.formGroup('OID', oidInput, '多数运营商不需要'));
				inputBox.appendChild(E('label', { 'class': 'mt5700-hint' },
					ccChk, document.createTextNode(' 该运营商要求确认码')));
			}

			function start() {
				if (busy) return;
				var p = Euicc.parseActivationCode(currentCode());
				if (!p.ok) { Mt5700.error(p.error); return; }
				var cc = (ccInput && ccInput.value) ? ccInput.value.trim() : '';
				if (p.confirmationCodeRequired === true && !cc) {
					Mt5700.error('该激活码要求填写确认码');
					return;
				}
				Mt5700.confirm('开始从 ' + p.smdp + ' 下载并写入新 Profile？'
					+ '写入过程中不要断电或断开网络。', function () {
						runDownload(p, cc);
					}, '开始下载');
			}

			function runDownload(p, cc) {
				/*
				 * ★ 下载前的空间预检（P04 / R01）。
				 *
				 *   形态照抄 vohive internal/esim/manager.go 的 `FreeNvramBytes > 0 && < 阈值`
				 *   —— **那条 `> 0` 守卫是关键，不是可选项**：SGP.22 的 EUICCInfo2 只定义
				 *   「剩余多少」，读不到容量（0 / 未上报）时按「无法预检」放行并说明，
				 *   绝不能把「读不出来」当成「空间为零」去硬拦（无差别兜底红线）。
				 *
				 *   阈值不照搬 vohive 的 81920 —— 那是对它的卡型取的；这里取一个明显偏保守的
				 *   下限（30 KiB），宁可漏拦也不误拦；真机拿到实测后再据实调整。
				 *   容量取自 lastProbe（跨函数通道，见其声明处注释），**不是**本函数的 p。
				 */
				var freeNV = 0;
				if (lastProbe && lastProbe.capacity &&
					typeof lastProbe.capacity.freeNonVolatileMemory === 'number') {
					freeNV = lastProbe.capacity.freeNonVolatileMemory;
				}
				var MIN_FREE_NV = 30 * 1024;
				if (freeNV > 0 && freeNV < MIN_FREE_NV) {
					/* 注意：此处**不能**调内部 log() —— 它依赖下面才建好的 pre / lines */
					actions.innerHTML = '';
					logBox.innerHTML = '';
					logBox.appendChild(E('div', { 'class': 'mt5700-notice-warning' },
						'剩余非易失存储不足（实测 ' + freeNV + ' 字节，低于 ' + MIN_FREE_NV +
						' 字节）—— 继续下载会在写入中途失败。请先删除不用的 Profile 再试。'));
					Mt5700.error('卡上剩余空间不足（仅 ' + freeNV + ' 字节），已中止下载');
					busy = false;
					return;
				}

				busy = true;
				actions.innerHTML = '';
				logBox.innerHTML = '';
				/*
				 * P12：下载进度条（复用 Mt5700.signalBar，不新增 CSS）。
				 * ★ 只建一次、之后只改宽度 —— 写入阶段 onStep(8,…) 每块都会回调一次
				 *   （真机 546 块），每次重建 DOM 是纯浪费；颜色固定用项目蓝，
				 *   不用 signalBar 自带的「按百分比变色」（0% 会是红色，误导）。
				 */
				var progEl = Mt5700.signalBar(0, 100);
				var progFill = progEl.firstChild;
				if (progFill) progFill.style.background = 'var(--mt5700-accent)';
				logBox.appendChild(progEl);
				var aborted = false;   /* P08：取消下载标志 */
				var tx = null;          /* 下载会话事务号，取消时通知服务器 */
				var stepEl = E('div', { 'class': 'mt5700-notice' }, '准备中…');
				logBox.appendChild(stepEl);
				var pre = E('div', { 'class': 'mt5700-mono mt5700-terminal-log' });
				logBox.appendChild(pre);
				var lines = [];
			function log(s) {
				if (aborted) throw abortError();
				lines.push(String(s));
				/* 大包（真机 546 块）会堆上千行；界面只显示尾部 40 行，全部保留纯属白占内存 */
				if (lines.length > 160) lines.splice(0, lines.length - 160);
				pre.textContent = lines.slice(-40).join('\n');
			}
				/* P08：取消下载时由取消按钮置位；onStep / log 每块前检查，抛 EUICC_OP_FAILED 中止链路。 */
				function setProgress(pct) {
					if (!progFill) return;
					progFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
				}
				/*
				 * P12：进度 = 已完成步骤 + 当前步内的段进度。
				 * ★ 写入阶段（步骤 8）占整包耗时的绝大部分，只按「步骤号」算会让它
				 *   全程停在 80% 一动不动，等于没做进度条。段号从 onStep 文案里取
				 *   （euicc.js 传的是「写入卡片（段 X/Y，块 A/B）」），取不到就退化为按步算。
				 */
				function stepPct(n, text) {
					var frac = 0;
					var m = /段\s*(\d+)\s*\/\s*(\d+)/.exec(String(text || ''));
					if (m) {
						var cur = parseInt(m[1], 10), tot = parseInt(m[2], 10);
						if (tot > 0) frac = Math.min(1, Math.max(0, (cur - 1) / tot));
					}
					return ((n - 1) + frac) / 10 * 100;
				}
				function onStep(n, text) {
					if (aborted) throw abortError();
					stepEl.textContent = '步骤 ' + n + '/10：' + text;
					setProgress(stepPct(n, text));
				}
					function abortError() {
					var e = new Error('已取消');
					e.code = 'EUICC_OP_FAILED';
					return e;
				}
				/* P08：下载进行中出现「取消下载」按钮，二次确认后中止本地流程并 best-effort 通知服务器取消会话 */
				var cancelBtn = Mt5700.ghostButton('取消下载', function () {
					if (aborted) return;
					Mt5700.confirm('确定取消下载？已下载部分不会写入，正在通知服务器取消会话。', function () {
						aborted = true;
						if (tx) {
							/* 只发 ES9+ cancelSession，不下发卡侧 ES10b cancel（tag 未核对） */
							Euicc.cancelSession(es9pSend, p.smdp, tx).catch(function (e) {
								if (typeof console !== 'undefined' && console.warn) {
									console.warn('[esim] 取消会话失败：' + ((e && e.message) || e));
								}
							});
						}
					}, '取消下载');
				});
				actions.appendChild(cancelBtn);

			Euicc.downloadProfile(send, es9pSend, {
				activation: p,
				confirmationCode: cc,
				onStep: onStep,
				log: log,
				onTransactionId: function (t) { tx = t; }
			}).then(function (r) {
				busy = false;
				/* R04：流程已结束，禁用并移除「取消下载」入口，避免对已完成会话重复下发写命令 */
				cancelBtn.disabled = true;
				if (cancelBtn.parentNode) cancelBtn.parentNode.removeChild(cancelBtn);
				stepEl.textContent = '下载完成。';
				/* P01 + R05：装上了但回执没发出 / 卡上没产生回执（total=0）都按异常出红色横幅。
				 * 按 SGP.22，安装成功后卡上理应产生一条待发回执，一条都没有本身即异常。 */
				var nf = r.notification;
				if (!nf || nf.failed || !(nf && nf.total > 0)) {
					var msg;
					if (nf && nf.failed) {
						msg = 'Profile 已装上，但安装回执没发出去；服务器侧这份 Profile 可能一直挂未确认，删除前请先「处理待发回执」。';
					} else {
						msg = 'Profile 已装上，但卡上没有产生安装回执（total=0）；服务器侧可能一直挂未确认，删除前请先「处理待发回执」。';
					}
					var warn = E('div', { 'class': 'mt5700-notice-danger' }, msg);
					body.insertBefore(warn, body.firstChild);
					later(function () { if (warn.parentNode) warn.parentNode.removeChild(warn); }, 15000);
				}
				Mt5700.success('Profile 已写入，正在刷新列表…');
				var listCard = findListCard();
				if (listCard) later(function () { loadProfiles(listCard); }, 3000);
				else later(function () { render(); }, 3000);
			}).catch(function (e) {
				busy = false;
				/* R04：流程已结束，禁用并移除「取消下载」入口 */
				cancelBtn.disabled = true;
				if (cancelBtn.parentNode) cancelBtn.parentNode.removeChild(cancelBtn);
				/* P08：用户主动取消不算错误，仅提示，不弹红色错误 */
				if (aborted && e && e.code === 'EUICC_OP_FAILED') {
					stepEl.textContent = '已取消下载。';
					/* P18：取消后卡上可能残留半装 Profile、服务器订单可能仍挂着，
					 * 黄色 notice 提醒去「刷新列表」确认真实状态，别以为「取消=干净」。 */
					var cancelNotice = E('div', { 'class': 'mt5700-notice-warning' },
						'下载已取消；但卡上可能残留半装的 Profile、服务器订单可能仍挂着，请点「刷新列表」确认实际状态。');
					cancelNotice.appendChild(document.createTextNode(' '));
					cancelNotice.appendChild(Mt5700.ghostButton('刷新列表', function () { render(); }));
					logBox.appendChild(cancelNotice);
					return;
				}
				stepEl.textContent = '下载失败：' + downloadFailText(e);
				handleErr(e);
			});
		}

			paintInput();
			actions.appendChild(Mt5700.primaryButton('开始下载', function () { start(); }));
			actions.appendChild(document.createTextNode(' '));
			actions.appendChild(Mt5700.ghostButton('取消', function () {
				stopScan();
				host.innerHTML = '';
			}));
		}

		/* 补发卡上攒着的安装回执（用别的工具装了 Profile 时也需要这一步） */
		function processNotifications() {
			if (busy) return;
			busy = true;
			Euicc.processNotifications(send, es9pSend, {
				log: function (s) {
					if (typeof console !== 'undefined' && console.info) console.info('[esim] ' + s);
				}
			}).then(function (r) {
				busy = false;
				if (!r.total) { Mt5700.info('卡上没有待发的回执'); return; }
				Mt5700.success('已发出 ' + r.sent + '/' + r.total + ' 条回执');
			}).catch(function (e) {
				busy = false;
				handleErr(e);
			});
		}

		/*
		 * P02：删除 / 启用 / 禁用成功后，提醒用户「卡上可能还有没发出去的安装回执」。
		 * 只读列出（纯 APDU），不触碰 ES9+；有则插一条黄色横幅 + 「处理待发回执」按钮。
		 */
		function showPendingReceipts() {
			if (busy) return;
			/* ★ 与其它读操作一致置 busy：它也是一条独立 ISD-R 会话，异步期间不锁的话，
			   用户此刻点「启用 / 删除」会并发开第二条通道（卡只有 1~3 条，6A81）。 */
			busy = true;
			Euicc.listNotifications(send).then(function (r) {
				busy = false;
				var items = r.items || [];
				if (!items.length) return;
				var banner = E('div', { 'class': 'mt5700-notice-warning' },
					'卡上有 ' + items.length + ' 条待发回执未发出；删除 / 切换前建议先处理，否则服务器侧可能一直挂未确认。');
				var btn = Mt5700.ghostButton('处理待发回执', function () { processNotifications(); });
				banner.appendChild(document.createTextNode(' '));
				banner.appendChild(btn);
				body.insertBefore(banner, body.firstChild);
				later(function () {
					if (banner.parentNode) banner.parentNode.removeChild(banner);
				}, 15000);
			}).catch(function () {
				busy = false; /* 列出失败只静默，不掩盖主操作的成功提示 */
			});
		}

		/* ---------- 待发回执管理（P04 + P09） ----------
		 * 一张常驻卡片，列出卡上所有待发回执并支持「移除」（单条）与「发送全部」（批量）。
		 * 移除是不可逆操作，必须经 Mt5700.confirm 二次确认。发往地址（来自卡上 0C）
		 * 在表格中可见（P09）。R02：删掉逐行「发送」——它其实会整批发送并删除，与文案不符，
		 * 且制造一条多余不可逆路径；只保留「发送全部」+ 逐行「移除」。 */
		function loadNotifications(notifCard) {
			Euicc.listNotifications(send).then(function (r) {
				renderNotificationTable(notifCard, r.items || []);
			}).catch(function (e) {
				var code = (e && e.code) || '';
				/* R07：整页已切到其它引导态（无卡 / 无 CSIM），提示无意义且会往已摘除的 DOM 写，静默 */
				if (code === 'EUICC_NO_EUICC' || code === 'EUICC_NO_CSIM') return;
				notifCard._body.innerHTML = '';
				notifCard._body.appendChild(E('div', { 'class': 'mt5700-notice-warning' },
					'读取待发回执失败：' + ((e && e.message) || code || '')));
			});
		}

		function renderNotificationTable(notifCard, items) {
			notifCard._body.innerHTML = '';
			if (!items.length) {
				notifCard._body.appendChild(E('div', { 'class': 'mt5700-hint' }, '卡上没有待发的回执。'));
				return;
			}
			var headers = ['序号', 'ICCID', '操作类型', '发往', '操作'];
			var rows = items.map(function (n) {
				var actions = E('div');
				/* P04：移除不可逆，必须二次确认（R02：删掉逐行「发送」，只留移除 + 批量发送全部） */
				actions.appendChild(Mt5700.dangerButton('移除', function () {
					removeNotification(notifCard, n);
				}));
				return [
					n.seqHex,
					n.iccid || '—',
					n.opLabel || ('操作 ' + (isNaN(parseInt(n.operation, 16)) ? '?' : parseInt(n.operation, 16))),
					n.address || '（通知未提供地址）',
					actions
				];
			});
			notifCard._body.appendChild(Mt5700.table(headers, rows, { striped: true }));
			var batch = Mt5700.button('发送全部', function () { sendAllNotifications(notifCard); }, 'primary');
			notifCard._body.appendChild(batch);
		}

		function sendAllNotifications(notifCard) {
			if (busy) return;
			/* P15：批量「发送全部」是不可逆操作，必须经二次确认（与单条「移除」一致） */
			Mt5700.confirm('确定发送全部待发回执？发送后将从卡上移除，且不可逆。', function () {
				/* P03/R03：弹窗回调二次 busy 校验 —— 确认框停留期间用户可能已发起别的操作 */
				if (busy) { Mt5700.error('有操作正在进行'); return; }
				busy = true;
				Euicc.processNotifications(send, es9pSend, {}).then(function (r) {
					busy = false;
					Mt5700.success('已发出 ' + r.sent + '/' + r.total + ' 条回执');
					loadNotifications(notifCard);
				}).catch(function (e) {
					busy = false;
					handleErr(e);
				});
			}, '发送全部');
		}

		/* 移除一条回执（P04）：不可逆，二次确认后才下发 removeNotification */
		function removeNotification(notifCard, n) {
			if (busy) return;
			Mt5700.confirm('移除回执不可逆：删掉后这条安装结果就再也发不出去，确定移除？', function () {
				/* P03/R03：同 sendAllNotifications —— 弹窗回调内再判一次 busy */
				if (busy) { Mt5700.error('有操作正在进行'); return; }
				busy = true;
				Euicc.removeNotification(send, n.seqHex).then(function () {
					busy = false;
					Mt5700.success('已移除回执 ' + n.seqHex);
					loadNotifications(notifCard);
				}).catch(function (e) {
					busy = false;
					handleErr(e);
				});
			}, '移除');
		}


		/*
		 * 记一笔「数据承载地址 + 出口 IP」（P13 + 换 IP 验证）。
		 *
		 * 只在身份收敛之后被调用，因此读到的地址确实属于「刚生效的那张 Profile」。
		 * 读数失败**不追加重试**：这只是一条观测记录，缺一笔不影响任何功能；
		 * 但要把「读不到」如实记下来，不许写成 0.0.0.0 之类看起来像有地址的值
		 * （红线 23：不许把「读不出来」伪装成「没有/有」）。
		 *
		 * ★ 两个地址各是什么、为什么都要记：
		 *   entry.addr —— AT+CGPADDR 的 PDP 地址，即运营商给这条承载分配的地址；
		 *   entry.exit —— 从路由器侧发一次 HTTP 回显得到的「互联网看到的我」。
		 *   CGNAT 下前者是 10.x/100.x 私网地址，**只看它判断不出出口换没换**；
		 *   后者才是判据。两者都记下来，才能看出「换了卡但出口没变」到底发生在哪一层。
		 */
		function observeDataIp(iccidHex) {
			if (!ipObs) return;
			var now = new Date();
			var hh = String(now.getHours()).padStart(2, '0');
			var mm = String(now.getMinutes()).padStart(2, '0');
			var ss = String(now.getSeconds()).padStart(2, '0');
			var entry = {
				key: iccidHex ? Euicc.iccidKey(iccidHex) : '(未知 ICCID)',
				addr: '',
				exit: '',
				changed: 'unknown',
				time: hh + ':' + mm + ':' + ss
			};
			var pdpAddr = '';
			return send('AT+CGPADDR', { fresh: true }).then(function (r) {
				var list = (r && r.success && r.data) ? Parse.parseCgpaddr(String(r.data)) : [];
				var hit = null;
				for (var i = 0; i < list.length; i++) {
					if (list[i].family === 'IPv4') { hit = list[i]; break; }
				}
				if (!hit && list.length) hit = list[0];
				entry.addr = hit ? hit.address : '未取到地址';
				if (hit) pdpAddr = hit.address;
			}).catch(function () {
				/* 可吞：读不到地址不是"错"，是观测结果的一种 —— 这里把它如实写成
				   「未取到地址」并由 renderIpObs 显示出来，用户看得见，不是无声消失。 */
				entry.addr = '未取到地址';
			}).then(function () {
				/* 老固件的 rpcd 没有 mt5700.exitip，别让整条观测链挂掉 */
				if (!AtWs.exitIp) {
					entry.exit = '后端未升级';
					return;
				}
				/* 绑到刚读到的 PDP 地址：多出口时保证请求确实从蜂窝这条链路出去 */
				return AtWs.exitIp(pdpAddr).then(function (r) {
					if (!r || !r.success) {
						entry.exit = '未取到';
						return;
					}
					entry.exit = r.ip;
					if (lastExitIp === null) {
						entry.changed = 'unknown';       /* 没有切换前基线，无从比较 */
					} else if (lastExitIp === '') {
						entry.changed = 'unknown';       /* 基线本身就没取到 */
					} else {
						entry.changed = (r.ip === lastExitIp) ? 'no' : 'yes';
					}
					lastExitIp = r.ip;
				}).catch(function () {
					/* 可吞：探测失败同样是观测结果的一种，如实记为「未取到」，
					   由 renderIpObs 显示出来，不静默丢掉这一笔。 */
					entry.exit = '未取到';
				});
			}).then(function () {
				ipObs.push(entry);
				renderIpObs();
			});
		}

		/* ---------- 正常态：EID + Profile 表 + 操作 ---------- */
		function renderOk(p) {
			body.innerHTML = '';
			body.appendChild(connBar);
			/* R01：把 probe 结果留一份给下载流程做空间预检用（见 lastProbe 声明处注释） */
			if (p && p.capacity) lastProbe = p;

			var headCard = Mt5700.card('eSIM 状态');

			/*
			 * EID 用等宽文本块，**不**用 .mt5700-metric。
			 * metric 的 value 是 22px 粗体大数字 —— 那是给「数量」用的；EID 是
			 * 32 位十六进制**标识符**，大字号在窄屏折三行、字距被拉开，反而读不出
			 * 一个整体，也没法逐位核对。等宽 + user-select:all（见 CSS）刚好对症。
			 */
			var idBox = E('div', { 'class': 'mt5700-esim-idbox' });
			idBox.appendChild(E('div', { 'class': 'mt5700-esim-idlabel' }, 'EID（eUICC 标识符）'));
			idBox.appendChild(E('div', { 'class': 'mt5700-esim-idvalue' }, p.eid || '—'));
			headCard._body.appendChild(idBox);

			/*
			 * APDU 通路由 Euicc.probe() 运行时探测得到（能 CGLA 就 CGLA，否则 CSIM）。
			 *
			 * ★ 它**决定能不能下载** —— 走 CSIM 时必然卡在 AuthenticateServer。
			 *   原先这只是一行卡片底部的小灰字，用户会直接跳过；这里提成徽章 + 一句
			 *   说明，让「这台设备现在能不能装新 Profile」在第一屏就有答案。
			 */
			var badges = E('div', { 'class': 'mt5700-esim-badges' });
			badges.appendChild(Mt5700.badge('eUICC 已就绪', 'success'));
			badges.appendChild(Mt5700.badge(
				p.transport === 'cgla' ? '下载通路正常' : '下载通路受限',
				p.transport === 'cgla' ? 'info' : 'warning'));
			headCard._body.appendChild(badges);
			headCard._body.appendChild(E('div', { 'class': 'mt5700-hint' },
				p.transport === 'cgla'
					? 'APDU 经 AT+CGLA 透传，响应可分多轮取全，可下载安装新 Profile。'
					: 'APDU 经 AT+CSIM 透传，单条响应上限 256 字节，无法下载新 Profile'
						+ '（读取列表、启用 / 禁用 / 删除不受影响）。'));

			/* R04：展示疑似通道泄漏提示（若 probe 探测到） */
			if (p.channelNote) {
				headCard._body.appendChild(E('div', { 'class': 'mt5700-notice-warning mt5700-mt-md' }, p.channelNote));
			}

			/*
			 * 卡容量：EUICCInfo2 里的 extCardResource（见 Euicc.parseExtCardResource）。
			 *
			 * ★「已装 Profile」这格先占位 —— 它得等 Profile 列表读完才有值，
			 *   由 renderTable 回填；列表失败时保持「—」，不谎报 0。
			 */
			headCard._body.appendChild(E('div', { 'class': 'mt5700-esim-sectitle' }, '卡内存储'));
			capProfileMetric = null;
			if (p.capacity) {
				var capRow = E('div', { 'class': 'mt5700-metrics' });
				if (hasNum(p.capacity.freeNonVolatileMemory)) {
					capRow.appendChild(Mt5700.metric('剩余非易失存储', fmtBytes(p.capacity.freeNonVolatileMemory)));
				}
				if (hasNum(p.capacity.freeVolatileMemory)) {
					capRow.appendChild(Mt5700.metric('剩余易失存储', fmtBytes(p.capacity.freeVolatileMemory)));
				}
				if (hasNum(p.capacity.installedApplication)) {
					capRow.appendChild(Mt5700.metric('卡内已装程序', String(p.capacity.installedApplication)));
				}
				capProfileMetric = Mt5700.metric('已装 Profile', '读取中…');
				capRow.appendChild(capProfileMetric);
				headCard._body.appendChild(capRow);
				headCard._body.appendChild(E('div', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'由卡经 GetEuiccInfo2（BF22）上报。SGP.22 只定义「剩余」，不给总容量，故不做百分比。'));
			} else {
				headCard._body.appendChild(E('div', { 'class': 'mt5700-hint' },
					'本卡未在 EUICCInfo2 中上报 extCardResource（走 AT+CSIM 通路时也可能因 256 字节上限截断），暂不可读。'));
			}
			body.appendChild(headCard);

			var listCard = Mt5700.card('Profile 列表', '启用 / 禁用会触发卡片刷新，期间网络将短暂中断并重注册（约 10~30 秒）');
			listCard._body.appendChild(Mt5700.loading('正在读取 Profile 列表…'));
			body.appendChild(listCard);

			/*
			 * 换卡换出口 IP 卡（P13 + 出口 IP 实测）——「靠切 Profile 换 IP」在本机成不成立，
			 * 由这张卡给出**实测结论**，而不是靠推理。
			 *
			 * ★ 为什么要有「出口 IP」这一列：AT+CGPADDR 只给承载地址，运营商普遍 CGNAT 时
			 *   它是 10.x/100.x 私网地址，光看它根本判断不出「互联网看到的我」换没换。
			 *   所以这里补了 mt5700.exitip：从路由器侧发一次 HTTP 回显，取回真正的出口 IP。
			 *   （对照 vohive：pool_health_ip.go 里 privateIP 与 publicIP 分开存、分开比，
			 *    本项目 2.3.44 只有 privateIP 那一半，2.3.45 补齐 publicIP 这一半。）
			 *
			 * ★ 仍然**不自动轮换**：本设备是单模组、蜂窝即唯一上行，定时自动切换等于定时断网。
			 *   这里给的是「切一次 → 立刻拿到换没换的实测结论 + 失败可一键切回」，
			 *   是不是要定时轮换由用户自己按实测结论决定。
			 * ★ 固定尺寸：只显示最近 5 条，不按数据量撑开（UI 红线）。
			 */
			var ipObsCard = Mt5700.card('换卡换出口 IP',
				'每次切换后记录承载地址与出口 IP，看切 Profile 是否真的换 IP');
			ipObsBody = ipObsCard._body;
			body.appendChild(ipObsCard);
			renderIpObs();

			/*
			 * R01：Profile 列表与待发回执都各自开 ISD-R 逻辑通道（withIsdrSession）。
			 * 卡片只有 1~3 条逻辑通道，两个读操作并发会引发 open 失败（6A81/6A82）双双读不出。
			 * 串行化：等 loadProfiles 完成（其通道已关闭）再创建并读取回执卡片，零成本满足通道独占。
			 * 顺带解决 R07 的竞态：notifCard 的创建挪到 loadProfiles 成功之后，整页切走时不再有
			 * 「往被清空的 DOM 写报错」的窗口。
			 */
			/* P09：首屏把「Profile 列表 + 待发回执」合并为一次 ISD-R 会话读取
			 * （原来 loadProfiles().then(loadNotifications) 是两段串行，多开一次通道）。
			 * 只读一次，渲染两卡。
			 * ★ R05：这条路径不走 loadProfiles，busy 必须自己置位 —— 否则首屏读取期间
			 *   single-flight 是空的，与页面其它写操作抢同一条 ISD-R 通道。 */
			busy = true;
			Euicc.listProfilesAndNotifications(send).then(function (res) {
				busy = false;
				if (!body.contains(listCard)) return; /* 已切到其它引导态，不再挂卡片 */
				renderTable(listCard, res.list || []);
				/* 常驻「待发回执」卡片，列出卡上所有待发回执并支持移除（批量） */
				var notifCard = Mt5700.card('待发回执', '卡上攒着、还没发给运营商的安装结果；删除了就再也发不出去（不可逆）');
				notifCard._body.appendChild(Mt5700.loading('正在读取待发回执…'));
				body.appendChild(notifCard);
				renderNotificationTable(notifCard, res.items || []);
			}).catch(function (e) {
				busy = false;
				if (e && e.code === 'EUICC_NO_EUICC') { renderNoEuicc(); return; }
				/* ★ 卡级阻断（暂态）：probe 时是好的、读列表时卡锁了 —— 别只报一个裸
				 *   状态码，走与首屏一致的 blocked 面板（含下一步动作）。 */
				if (Euicc.isCardBlockedSw(e && e.sw, e && e.ch)) { renderBlocked({ sw: e.sw }); return; }
				listCard._body.innerHTML = '';
				listCard._body.appendChild(Mt5700.errorState('读取 Profile 列表失败：' +
					(e.swText ? e.swText + '（SW=' + e.sw + '）' : ((e && e.message) || '')),
					function () { loadProfiles(listCard); }));
			});
		}

		function loadProfiles(listCard) {
			if (busy) return Promise.resolve();
			busy = true;
		return Euicc.listProfiles(send).then(function (res) {
			busy = false;
			renderTable(listCard, res.list || []);
		}).catch(function (e) {
			busy = false;
			if (e && e.code === 'EUICC_NO_EUICC') { renderNoEuicc(); return; }
			/* ★ 同首屏 catch：卡级阻断走 blocked 面板，SW 矩阵人话优先于裸 message */
			if (Euicc.isCardBlockedSw(e && e.sw, e && e.ch)) { renderBlocked({ sw: e.sw }); return; }
			listCard._body.innerHTML = '';
			listCard._body.appendChild(Mt5700.errorState('读取 Profile 列表失败：' +
				(e.swText ? e.swText + '（SW=' + e.sw + '）' : ((e && e.message) || '')),
				function () { loadProfiles(listCard); }));
		});
		}

		function renderTable(listCard, list) {
			/*
			 * 顺手记下「当前哪张是启用的」。
			 * 用途只有一个：切换失败时给「一键切回」一个明确的目标 ——
			 * 不记的话，等用户发现网络没起来时，页面早就被重新渲染过，
			 * 谁也不知道刚才该切回哪张（这正是红线 24「旧身份带给新卡」的同类坑）。
			 */
			currentEnabledRaw = null;
			for (var k = 0; k < list.length; k++) {
				if (list[k].state === 'enabled' && list[k].iccidRaw) {
					currentEnabledRaw = list[k].iccidRaw;
					break;
				}
			}
			/* 卡容量那张卡上的「已装 Profile」在这里回填（列表读成功才有准数）。 */
			if (capProfileMetric) {
				capProfileMetric.lastChild.textContent = String(list.length);
			}
			listCard._body.innerHTML = '';
			if (!list.length) {
				/* 空态是行动的邀请，不是一句结论：直接告诉用户下一步做什么 */
				listCard._body.appendChild(Mt5700.empty('卡上还没有 Profile。用下面的「添加 Profile」扫码或粘贴激活码安装一个。'));
				listCard._body.appendChild(buildAddZone());
				return;
			}
			/*
			 * Profile 用行卡而不是表格（说明见 mt5700.css 的 eSIM 段顶部）。
			 * 要点：这一行**有哪些操作取决于行自己的状态** ——
			 *   已启用 → 只能「禁用」，且必须先禁用才能删除（deleteProfile 会拦）；
			 *   未启用 → 才能「启用」。
			 * 表格按列摊平会把这层关系打散，行卡把它绑在一起。
			 */
			var rows = E('div', { 'class': 'mt5700-esim-rows' });
			list.forEach(function (p) {
				var on = (p.state === 'enabled');
				var row = E('div', { 'class': 'mt5700-esim-row' + (on ? ' is-on' : '') });

				var top = E('div', { 'class': 'mt5700-esim-row-top' });
				top.appendChild(E('span', { 'class': 'mt5700-esim-row-iccid' },
					p.iccid || '（未读到 ICCID）'));
				top.appendChild(on
					? Mt5700.badge('已启用', 'success')
					: Mt5700.badge('已禁用', 'neutral'));
				row.appendChild(top);

				/* 运营商名与昵称合并成一行 —— 原先各占一列，两列都常常是「—」 */
				var name = p.profileName || p.spName || '';
				var alias = (p.nickname && p.nickname !== name) ? p.nickname : '';
				row.appendChild(E('div', { 'class': 'mt5700-esim-row-name' },
					[name, alias].filter(Boolean).join(' · ') || '未命名 Profile'));

				var acts = E('div', { 'class': 'mt5700-esim-row-acts' });
				acts.appendChild(Mt5700.button(on ? '禁用' : '启用',
					function () { toggleProfile(p, !on); }, 'primary'));
				acts.appendChild(Mt5700.button('重命名', function () { renameProfile(p); }, 'ghost'));
				acts.appendChild(Mt5700.dangerButton('删除', function () { deleteProfile(p); }));
				row.appendChild(acts);

				rows.appendChild(row);
			});
			listCard._body.appendChild(rows);
			listCard._body.appendChild(buildAddZone());
			/* P07：手动刷新入口（切换 Profile 后卡片正在重注册，自动刷新可能失败，
			 *      给用户一个兜底按钮，避免「列表卡在旧状态」又无处下手）。 */
			listCard._body.appendChild(Mt5700.ghostButton('刷新列表', function () {
				if (busy) return;
				loadProfiles(listCard);
			}));
		}

		/* ---------- P09 确认策略 ---------- */

		function toggleProfile(p, enable) {
			if (busy) return;
			var verb = enable ? '启用' : '禁用';
			Mt5700.confirm('确定' + verb + '该 Profile？操作后网络将短暂中断并重注册（约 10~30 秒）。', function () {
				/* ★ 顺序固定：先 busy 再 iccidRaw（见 deleteProfile 同名注释） */
				/* P03：弹窗回调 → 真正下发的第二道 busy 校验，确认期间防重入 */
				if (busy) { Mt5700.error('有操作正在进行'); return; }
				/* P17：iccidRaw 为空不下发，避免只弹一句「操作失败」 */
				if (!p.iccidRaw) { Mt5700.error('这个 Profile 没读到 ICCID，无法对该卡下发操作'); return; }
				/*
				 * ★ 切换前先抓一份「原来生效的是谁」。
				 *   必须在下发**之前**取：下发成功后列表会被重新渲染，
				 *   currentEnabledRaw 那时已经指向新卡了，再取就取不回来了。
				 */
				var prevRaw = currentEnabledRaw;
				busy = true;
				/*
				 * ★ 下发前主动作废读缓存（P03）。
				 *
				 *   为什么必须在**下发前**这一步做：rpc.js 的读缓存分三档，
				 *   IMSI / ICCID 落在 `CACHE_TTL_IDENTIFIER = 10 分钟` 那一档
				 *   （`rpc.js:404`、命令清单 `:408-417`），而写命令路径只调
				 *   `_dropStateCache()`（`:575`）—— 它清的是 STATE 档，**碰不到 IDENTIFIER 档**。
				 *   也就是说：切卡之后，其它页面（网络状态等）最长 10 分钟读到的还是**旧卡身份**。
				 *   这正是「旧卡身份带给新卡」那条事故（红线 24）的机械路径。
				 *
				 *   clearReadCache() 是 rpc.js:489 的现成 API，零新增；这里清空后，
				 *   后续任何一次身份读取都会被强制走真机。
				 */
				try { AtWs.client.clearReadCache(); } catch (e) { /* 无此实现时退化即可，不得阻断下发 */ }

				var op = enable ? Euicc.enableProfile : Euicc.disableProfile;
				op(send, { kind: 'iccid', hex: p.iccidRaw }, true).then(function (r) {
					busy = false;
					/* P06：ES10 结果码识别不出（result === null）按误报成功处理——这里纠正：
					 *      提示「已下发但未确认」，且不自动刷新覆盖旧列表，让用户手动确认。 */
					if (r && r.result === null) {
						var warn = E('div', { 'class': 'mt5700-notice-warning' },
							verb + '已下发，但卡片未返回结果码，请点击「刷新列表」确认状态。');
						body.insertBefore(warn, body.firstChild);
						later(function () { if (warn.parentNode) warn.parentNode.removeChild(warn); }, 10000);
						return;
					}
					var note = E('div', { 'class': 'mt5700-notice' },
						verb + '成功，网络将中断并重注册，约 10~30 秒后恢复。');
					body.insertBefore(note, body.firstChild);
					later(function () { if (note.parentNode) note.parentNode.removeChild(note); }, 8000);
				/* P07 + R03：有限轮询替换一刀切的 12 秒；回执读取挪到轮询结束之后串行调用 */
				pollListAfterToggle(p.iccidRaw, verb, prevRaw);
				}).catch(function (e) {
					busy = false;
					handleErr(e);
				});
			});
		}

		/* P07 + R03：切换后有限轮询刷新 Profile 列表。
		 * 退避 6s→12s→24s（覆盖「卡片正忙」窗口），attempt 统一封顶 3 次；
		 * 期间用户已发起其它操作（busy）时计入 attempt 并重排，而非静默丢弃；
		 * 回执读取（showPendingReceipts）挪到轮询结束之后串行调用，避免与轮询抢 ISD-R 通道。 */
		/*
		 * 切换后的收敛轮询（P02 + P09 + R03 + R10）。
		 *
		 * ★ 判据从「列表读成功」换成「目标 ICCID 真的生效了」。原因很实在：
		 *   Profile 列表是**卡自己**记的配置，而「当前实际生效哪张」是**模组/网络侧**的状态。
		 *   开关下发后两者会有一段不一致窗口，此时列表早已能读成功，但生效的仍是旧 Profile。
		 *   原实现就在这一刻收工，于是下游页面拿到的还是旧身份 —— 这正是红线 24
		 *   「旧卡身份带给新卡」那条事故的形状（对照 vohive 的处理：
		 *   internal/device/pool_esim_switch.go 明确写了「目标 ICCID 已知时必须等到目标卡生效」）。
		 *
		 * ★ 三条硬约束（审查意见 R03/R10，都是防止「改完比现状更差」）：
		 *   ① 列表**照常渲染**：收敛只决定提示条文案，绝不因为身份没读到就把已拿到的列表藏起来；
		 *   ② AT 探针读失败（卡片 busy / CME ERROR）**不计 attempt**——失败的是探针不是切换；
		 *   ③ 总时长上限维持 6+12+24=42s 不延长，不给同一轮里多发的命令加带宽。
		 */
		function pollListAfterToggle(expectIccidHex, verb, prevIccidHex) {
			var listCard = findListCard();
			if (!listCard) return;
			var attempt = 0;
			var backoff = [6000, 12000, 24000];
			var settled = false;
			var expectKey = expectIccidHex ? Euicc.iccidKey(expectIccidHex) : '';
			var noteEl = null;

			function dropNote() {
				if (noteEl && noteEl.parentNode) noteEl.parentNode.removeChild(noteEl);
				noteEl = null;
			}
			function putNote(cls, text) {
				dropNote();
				noteEl = E('div', { 'class': cls }, text);
				listCard._body.appendChild(noteEl);
			}

			/*
			 * 身份收敛：先 ICCID 命中，命中后再等 IMSI 非空。
			 * fresh 必须显式给：IMSI / ICCID 落在 rpc.js 的 10 分钟 IDENTIFIER 档。
			 * 等 IMSI 的理由同 vohive —— ICCID 已生效时 IMSI 可能仍在 USIM 重初始化窗口里读空，
			 * 此时把空 IMSI 放出去等于又制造一次「身份不明」。
			 */
			function confirmIdentity() {
				if (!expectKey) return Promise.resolve(true);   /* 无目标可言时保持旧语义 */
				return send('AT^ICCID?', { fresh: true }).then(function (r) {
					var m = atText(r).match(/ICCID:\s*([0-9A-Fa-f]+)/);
					var liveKey = m ? Euicc.iccidKey(m[1]) : '';
					if (!liveKey || liveKey !== expectKey) return false;
					return send('AT+CIMI', { fresh: true }).then(function (r2) {
						var im = atText(r2).match(/(\d{14,15})/);
						return !!(im && im[1]);
					});
				}).catch(function () {
					/* 探针读不出来 ≠ 没切成功；按「尚未确认」处理，交下一轮再探 */
					return false;
				});
			}

			function tryOnce() {
				if (settled) return;
				/* P09：被用户自己的操作占用 —— 只延后，不计 attempt（原来会把用户操作算成失败次数） */
				if (busy) { later(tryOnce, 3000); return; }
				attempt++;
				busy = true;
				Euicc.listProfiles(send).then(function (res) {
					busy = false;
					/* R03：列表无条件渲染 —— 读到的东西先给用户看 */
					renderTable(listCard, res.list || []);
				}).catch(function () {
					busy = false;   /* 读失败：保留旧列表，不覆盖成错误态 */
				}).then(confirmIdentity).then(function (converged) {
					if (converged) {
						settled = true;
						dropNote();
						/* 收敛达成：再清一次缓存，让其它页面立刻拿到新身份而不是等 10 分钟过期 */
						try { AtWs.client.clearReadCache(); } catch (e) { /* 无此实现时退化 */ }
						/* P13：身份已收敛，此时读到的 PDP 地址才是「新 Profile 的」地址 */
						observeDataIp(expectIccidHex);
						showPendingReceipts();
						return;
					}
					if (attempt < 3) {
						later(tryOnce, backoff[Math.min(attempt, backoff.length - 1)]);
						return;
					}
					settled = true;
					putNote('mt5700-notice-warning',
						(verb || '切换') + '已下发，但卡片仍在重注册：当前生效的可能还是原 Profile，' +
						'请稍后点击「刷新列表」确认。');
					/*
					 * 切过去没确认生效 → 给一个「切回原 Profile」的出口。
					 * 只在**启用另一张**时给：那才存在「新的没起来、旧的已经让位」的风险。
					 * 不给自动回滚的理由见 restoreProfile 上方的注释。
					 */
					if (verb === '启用' && prevIccidHex && prevIccidHex !== expectIccidHex) {
						listCard._body.appendChild(E('div', { 'class': 'mt5700-mt-sm' },
							Mt5700.dangerButton('切回原 Profile', function () {
								restoreProfile(prevIccidHex, '（当前这张没确认生效）');
							})));
					}
					showPendingReceipts();
				});
			}
			later(tryOnce, backoff[0]);
		}

		function renameProfile(p) {
			if (busy) return;
			Ui.promptModal('重命名 Profile', [
				{ key: 'name', label: '昵称（≤64 字节，留空清除）', type: 'text', value: p.nickname || '' }
			], function (values) {
				/* P03：弹窗回调二次 busy 校验，防重入 */
				if (busy) { Mt5700.error('有操作正在进行'); return; }
				/* P17：iccidRaw 为空不下发 */
				if (!p.iccidRaw) { Mt5700.error('这个 Profile 没读到 ICCID，无法对该卡下发操作'); return; }
				var name = (values.name || '').trim();
				busy = true;
				Euicc.setNickname(send, p.iccidRaw, name).then(function () {
					busy = false;
					var listCard = findListCard();
					if (listCard) loadProfiles(listCard);
				}).catch(function (e) {
					busy = false;
					handleErr(e);
				});
			});
		}

		function deleteProfile(p) {
			if (busy) return;
			/* P02：删除前必须先禁用，enabled 直接 delete 必返回 ES10 result 2（状态不符） */
			if (p.state === 'enabled') { Mt5700.error('请先禁用该 Profile 再删除'); return; }
			/* R09：校验 ISD-P AID 末 4 位（比 ICCID 末 4 位更有约束力，ICCID 已在表中明文可见）。
			 * 若 AID 缺省，回退为要求粘贴完整 ICCID。placeholder 清空，避免把答案直接暴露出来。 */
			var aidTail = (p.aid || '').slice(-4).toUpperCase();
			var needFullIccid = !aidTail;
			var expect = needFullIccid ? (p.iccid || '').toUpperCase() : aidTail;
			Mt5700.confirm('删除 Profile 不可逆，确定删除该 Profile？', function () {
				Ui.promptModal('确认删除', [
					{
						key: 'confirm',
						label: needFullIccid
							? ('请输入该 Profile 的完整 ICCID（ICCID：' + (p.iccid || '') + '）')
							: ('请输入该 Profile 的 AID 末 4 位（AID：' + (p.aid || '') + '）'),
						type: 'text',
						placeholder: ''
					}
				], function (values) {
					/* ★ 顺序固定：先 busy 再 iccidRaw —— 反过来会把「有操作正在进行」
					   误报成「没读到 ICCID」，用户得到的是错误病因。 */
					/* P03：弹窗回调二次 busy 校验，防重入（与 toggle / rename 一致） */
					if (busy) { Mt5700.error('有操作正在进行'); return; }
					/* P17：iccidRaw 为空不下发，避免只弹一句「操作失败」 */
					if (!p.iccidRaw) { Mt5700.error('这个 Profile 没读到 ICCID，无法对该卡下发操作'); return; }
					var input = String(values.confirm || '').trim().toUpperCase();
					if (input !== expect) {
						Mt5700.error('输入不匹配，已取消删除');
						return;
					}
					busy = true;
					Euicc.deleteProfile(send, { kind: 'iccid', hex: p.iccidRaw }).then(function (r) {
						busy = false;
						var listCard = findListCard();
						if (listCard) {
							/* P04：删除成功后串行读回执，避免与 loadProfiles 同时开两条 ISD-R 通道 */
							loadProfiles(listCard).then(function () { showPendingReceipts(); });
						} else {
							showPendingReceipts();
						}
					}).catch(function (e) {
						busy = false;
						handleErr(e);
					});
				});
			});
		}

		function findListCard() {
			var cards = body.querySelectorAll('.mt5700-card');
			for (var i = 0; i < cards.length; i++) {
				var title = cards[i].querySelector('.mt5700-card-title');
				if (title && /Profile 列表/.test(title.textContent)) return cards[i];
			}
			return null;
		}

		/* ---------- 入口：先探测引导态，再决定渲染 ---------- */
		function render() {
			body.innerHTML = '';
			body.appendChild(connBar);
			body.appendChild(Mt5700.loading('正在探测 eSIM…'));
			Euicc.probe(send).then(function (p) {
				/* 「添加」区要用到 ES9+ 通道的可用性，先问一次再渲染，
				   否则那块区域会先画出来再变一次，观感是闪一下。 */
				probeEs9p(function () {
					if (p.state === 'no_card') renderNoCard();
					else if (p.state === 'no_csim') renderNoCsim(p);
					else if (p.state === 'no_euicc') renderNoEuicc();
					else if (p.state === 'blocked') renderBlocked(p);
					else if (p.state === 'error') renderError(p);
					else renderOk(p);
				});
			}).catch(function (e) {
				renderError({ error: (e && e.code) || (e && e.message) || '未知错误' });
			});
		}

		/* ---------- 连接钩子：先 connect 成功，再拉 profile 列表 ---------- */
		Mt5700.connectThen(function () {
			render();
		});

		/* ---------- 卸载复位 busy + 清理定时器/摄像头（P10 / V01） ---------- */
		page._onDispose(function () {
			busy = false;
			cleanups.forEach(function (c) {
				if (typeof c === 'function') { try { c(); } catch (e) { } }
				else clearTimeout(c);
			});
			cleanups.length = 0;
		});

		return page;
	}
});
