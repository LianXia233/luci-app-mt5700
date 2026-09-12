'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 全网扫频 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/ScanPanel.tsx：
 * - 筛选：接入技术 / PLMN / 频段 / 频点 / PCI / 子载波间隔，命令按手册约束构建
 * - 异步扫描：服务端推送 cellscan 状态（running 逐行 / done / aborted / error）
 * - 页面刷新时通过 AT^CELLSCAN=STATE 恢复扫描中状态
 * - 结果一键锁定（转成 LTEFREQLOCK / NRFREQLOCK）
 * - 扫描期间模组被独占，离开页面时主动收掉本页发起的扫频
 *
 * 注意：扫频结果是异步推送的，不能用单条 AT 命令的返回值当结果
 * （旧实现正是错在这里，导致「扫描无结果」）。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('全网扫频', '扫出频段、频点、PCI 与子载波间隔，可据此一键锁定；支持无卡扫描');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var filter = { rat: '', plmn: '', freq: '', pci: '', band: '', scs: '' };
		var scanning = false;
		var startedRef = false;
		var cells = [];
		var note = '';

		/* ---------- 筛选卡片 ---------- */
		var filterCard = Mt5700.card('扫频条件', '扫描期间模组被独占，其它操作请先取消');
		var filterBody = E('div', { 'class': 'mt5700-grid mt5700-grid-2' });
		filterCard._body.appendChild(filterBody);
		body.appendChild(filterCard);

		var RAT_OPTIONS = [
			{ value: '', label: '全部制式' },
			{ value: '2', label: 'LTE' },
			{ value: '3', label: 'NR' },
			{ value: '1', label: 'WCDMA' }
		];

		var ratSel = Mt5700.select(RAT_OPTIONS, '');
		ratSel.addEventListener('change', function () {
			filter.rat = ratSel.value;
			if (filter.rat !== '3') { filter.scs = ''; scsSel.value = ''; }
			var curBand = filter.band;
			syncBandOptions();
			bandSel.value = curBand || '';
			filter.band = bandSel.value;
			scsField.style.display = filter.rat === '3' ? '' : 'none';
		});

		var plmnInput = Mt5700.input('text', '46000');
		plmnInput.addEventListener('input', function () { filter.plmn = plmnInput.value; });

		var bandSel = Mt5700.select([{ value: '', label: '全频段' }], '');
		bandSel.addEventListener('change', function () { filter.band = bandSel.value; });

		var freqInput = Mt5700.input('text', '留空则不限');
		freqInput.addEventListener('input', function () { filter.freq = freqInput.value; });

		var pciInput = Mt5700.input('text', '留空则不限');
		pciInput.addEventListener('input', function () { filter.pci = pciInput.value; });

		var scsSel = Mt5700.select([{ value: '', label: '不限' }].concat(
			Parse.SCS_TYPES.map(function (o) { return { value: String(o.value), label: o.label }; })
		), '');
		scsSel.addEventListener('change', function () { filter.scs = scsSel.value; });

		var scsField = Mt5700.formGroup('子载波间隔', scsSel, 'NR 指定频点或 PCI 时必填');
		scsField.style.display = 'none';

		filterBody.appendChild(Mt5700.formGroup('接入技术', ratSel));
		filterBody.appendChild(Mt5700.formGroup('PLMN', plmnInput, '留空扫描所有运营商，例如 46000'));
		filterBody.appendChild(Mt5700.formGroup('频段', bandSel, '与频点二选一，留空则全频段扫描'));
		filterBody.appendChild(Mt5700.formGroup('频点', freqInput, '指定频点时必须选择接入技术'));
		filterBody.appendChild(Mt5700.formGroup('PCI', pciInput, '需同时指定频点，仅 LTE/NR 支持'));
		filterBody.appendChild(scsField);

		function syncBandOptions() {
			var opts = filter.rat === '3' ? Parse.NR_BANDS : Parse.LTE_BANDS;
			var cur = bandSel.value;
			bandSel.innerHTML = '';
			var empty = document.createElement('option');
			empty.value = ''; empty.textContent = '全频段';
			bandSel.appendChild(empty);
			opts.forEach(function (b) {
				var opt = document.createElement('option');
				opt.value = String(b.value); opt.textContent = b.label;
				bandSel.appendChild(opt);
			});
			if (cur && bandSel.querySelector('option[value="' + cur + '"]')) bandSel.value = cur;
		}
		syncBandOptions();

		/* ---------- 操作按钮 ---------- */
		var startBtn = Mt5700.primaryButton('开始扫描', function () { start(); });
		var cancelBtn = Mt5700.dangerButton('取消扫描', function () { cancel(); });
		cancelBtn.style.display = 'none';
		filterBody.appendChild(Mt5700.panelActions(startBtn, cancelBtn));

		var noteEl = E('div', { 'class': 'mt5700-hint' });
		filterCard._body.appendChild(noteEl);

		/* ---------- 结果卡片 ---------- */
		var resultCard = Mt5700.card('扫描结果', '扫描到的邻区列表，可一键锁定');
		var resultBody = E('div');
		resultCard._body.appendChild(resultBody);
		body.appendChild(resultCard);

		function renderNote() {
			noteEl.textContent = note;
			noteEl.style.display = note ? '' : 'none';
		}

		function signalText(cell) {
			if (cell.rsrp != null) return cell.rsrp + ' dBm';
			if (cell.rxlev != null) return cell.rxlev + ' dBm';
			return '—';
		}

		function render() {
			renderNote();
			resultBody.innerHTML = '';
			if (!cells.length) {
				resultBody.appendChild(Mt5700.empty(scanning ? '扫描中…' : '暂无扫描结果'));
				return;
			}
			var rows = cells.map(function (cell) {
				var lockable = (cell.ratName === 'LTE' || cell.ratName === 'NR')
					&& cell.band != null && cell.freq != null && cell.pci != null;
				var lockBtn = Mt5700.button('锁定', function () { lockCell(cell); }, 'secondary');
				lockBtn.disabled = scanning || !lockable;
				return [
					cell.ratName || '—',
					cell.plmn || '—',
					cell.band != null ? (cell.ratName === 'NR' ? 'n' + cell.band : 'B' + cell.band) : '—',
					cell.freq != null ? String(cell.freq) : '—',
					cell.pci != null ? String(cell.pci) : '—',
					signalText(cell),
					cell.sinr != null ? String(cell.sinr) : '—',
					lockBtn
				];
			});
			resultBody.appendChild(Mt5700.table(
				['制式', 'PLMN', '频段', '频点', 'PCI', '信号', 'SINR', '操作'], rows, { striped: true }
			));
		}

		/* ---------- 动作 ---------- */
		function start() {
			var built = Parse.buildScanCommand(filter);
			if (built.error) { Mt5700.error(built.error); return; }
			cells = [];
			note = '';
			scanning = true;
			startedRef = true;
			startBtn.style.display = 'none';
			cancelBtn.style.display = '';
			render();
			Mt5700.info('扫描中，全频段扫描可能需要几分钟');
			AtWs.client.sendCommand(built.command).then(function (res) {
				if (!res.success) throw new Error(res.error || '模组拒绝了扫频命令');
				note = '扫描中，全频段扫描可能需要几分钟';
				renderNote();
			}).catch(function (err) {
				scanning = false;
				startedRef = false;
				startBtn.style.display = '';
				cancelBtn.style.display = 'none';
				Mt5700.error((err && err.message) || '启动扫频失败');
				render();
			});
		}

		function cancel() {
			// 提示要在等应答之前给：模组收尾很快，结束推送常常比命令应答先到
			note = '已下发取消，等待模组收尾';
			renderNote();
			AtWs.client.sendCommand(Parse.SCAN_ABORT_COMMAND).then(function (res) {
				if (!res.success) throw new Error(res.error || '取消失败');
			}).catch(function (err) {
				Mt5700.error((err && err.message) || '取消扫频失败');
			});
		}

		function lockCell(cell) {
			var kind = cell.ratName === 'LTE' ? 'lte' : 'nr';
			var scs = cell.scs != null ? cell.scs : Parse.getDefaultScsType(cell.band);
			var cmd = Parse.buildLockCommand(kind, 2, 0, [{
				band: cell.band, arfcn: String(cell.freq), pci: String(cell.pci), scs: scs
			}]);
			Mt5700.confirm('确定锁定 ' + cell.ratName + ' Band ' + cell.band
				+ '（频点 ' + cell.freq + '，PCI ' + cell.pci + '）？', function () {
				var radioOff = false;
				Ui.setFlightMode(true).then(function (ok) {
					if (!ok) throw new Error('开启飞行模式失败');
					radioOff = true;
					return Ui.sleep(1000);
				}).then(function () {
					return AtWs.client.sendCommand(cmd);
				}).then(function (res) {
					if (!res.success) throw new Error(Ui.atErrorText(res, '锁定失败'));
					return Ui.setFlightMode(false);
				}).then(function (off) {
					if (!off) throw new Error('关闭飞行模式失败');
					Mt5700.success('已锁定 ' + cell.ratName + ' PCI ' + cell.pci);
				}).catch(function (err) {
					Mt5700.error((err && err.message) || '锁定失败');
					if (radioOff) Ui.setFlightMode(false).catch(function () {});
				});
			}, '确认锁定');
		}

		/* ---------- cellscan 推送订阅 ---------- */
		var handler = function (resp) {
			if (!resp || resp.type !== 'cellscan') return;
			var push = resp.data;
			if (!push) return;

			if (push.state === 'running') {
				var cell = push.cell ? Parse.parseScanLine(push.cell) : null;
				if (cell) { cells.push(cell); render(); }
				return;
			}

			scanning = false;
			startedRef = false;
			startBtn.style.display = '';
			cancelBtn.style.display = 'none';
			// 结束推送带完整结果，用它覆盖，避免中途丢包导致列表和 count 对不上
			if (push.lines) cells = Parse.parseScanLines(push.lines);

			if (push.state === 'error') {
				note = '';
				render();
				Mt5700.error('扫频失败：' + (push.error || '未知错误'));
				return;
			}
			note = push.state === 'aborted'
				? '已取消，保留已扫到的 ' + push.count + ' 个小区'
				: '扫描完成，共 ' + push.count + ' 个小区';
			render();
		};
		AtWs.client.subscribe(handler);

		/* ---------- 页面恢复 + 轮询核对 ---------- */
		function checkState() {
			AtWs.client.sendCommand(Parse.SCAN_STATE_COMMAND).then(function (res) {
				if (res.success && Parse.isScanRunning(String(res.data || ''))) {
					scanning = true;
					startBtn.style.display = 'none';
					cancelBtn.style.display = '';
					note = '检测到后台仍在扫描，可取消或等待结果';
					render();
				}
			});
		}

		var pollTimer = Ui.interval(2000, function () {
			if (!scanning) return;
			AtWs.client.sendCommand(Parse.SCAN_STATE_COMMAND).then(function (res) {
				if (res.success && !Parse.isScanRunning(String(res.data || ''))) {
					scanning = false;
					startedRef = false;
					startBtn.style.display = '';
					cancelBtn.style.display = 'none';
					note = '扫描已结束';
					render();
				}
			});
		});

		self._dispose = function () {
			clearInterval(pollTimer);
			AtWs.client.unsubscribe(handler);
			// 离开页面时主动收掉本页发起的扫频
			if (startedRef) AtWs.client.sendCommand(Parse.SCAN_ABORT_COMMAND).catch(function () {});
		};

		/* ---------- 初始化 ---------- */
		render();

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						AtWs.client.connect(values.key).catch(function (e) {
							Mt5700.error((e && e.message) || '认证失败');
						});
					}
				});
				return;
			}
			if (err) console.warn(err);
		}).then(function () {
			checkState();
		});

		return page;
	}
});
