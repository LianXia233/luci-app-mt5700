'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
/* global L, AtWs, Parse, Ui */

/**
 * 全网扫频（原 WebUI 网络 → 全网扫频）
 * 等价迁移 network/ScanPanel.tsx：
 * - 筛选：接入技术/PLMN/频段/频点/PCI/SCS，命令按手册约束构建
 * - 异步扫描：服务端推送 cellscan 状态（running 逐行 / done / aborted / error）
 * - 页面刷新时通过 AT^CELLSCAN=STATE 恢复扫描中状态
 * - 结果一键锁定（转成 LTEFREQLOCK / NRFREQLOCK）
 * - 扫描期间模组被独占，禁止其它命令
 */

return L.view.extend({
	render: function () {
		var page = Ui.page('全网扫频', '模组直接扫出频段、频点、PCI 与子载波间隔，可据此一键锁定；支持无卡扫描');
		var body = page._body;
		Ui.renderConnectionBar(body);

		var filter = { rat: '', plmn: '', freq: '', pci: '', band: '', scs: '' };
		var scanning = false;
		var startedRef = false;
		var cells = [];
		var note = '';

		var panel = Ui.panel('全网扫频', '扫描期间模组被独占，其它操作请先取消');
		body.appendChild(panel);

		/* ---------- 筛选条件 ---------- */
		var RAT_OPTIONS = [
			{ value: '', label: '全部制式' }, { value: '2', label: 'LTE' },
			{ value: '3', label: 'NR' }, { value: '1', label: 'WCDMA' }
		];

		var ratSel = document.createElement('select');
		ratSel.className = 'cbi-input-select';
		RAT_OPTIONS.forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = o.value; opt.textContent = o.label;
			ratSel.appendChild(opt);
		});
		ratSel.addEventListener('change', function () {
			filter.rat = ratSel.value;
			if (filter.rat !== '3') { filter.scs = ''; scsSel.value = ''; }
			bandSel.value = filter.band || '';
			syncBandOptions();
		});
		panel._body.appendChild(Ui.field('接入技术', ratSel));

		var plmnInput = document.createElement('input');
		plmnInput.className = 'cbi-input-text';
		plmnInput.placeholder = '46000';
		plmnInput.addEventListener('input', function () { filter.plmn = plmnInput.value; });
		panel._body.appendChild(Ui.field('PLMN', plmnInput, '留空扫描所有运营商，例如 46000'));

		var bandSel = document.createElement('select');
		bandSel.className = 'cbi-input-select';
		bandSel.appendChild(document.createElement('option'));
		bandSel.addEventListener('change', function () { filter.band = bandSel.value; });
		panel._body.appendChild(Ui.field('频段', bandSel, '与频点二选一，留空则全频段扫描'));

		var freqInput = document.createElement('input');
		freqInput.className = 'cbi-input-text';
		freqInput.placeholder = '留空则不限';
		freqInput.addEventListener('input', function () { filter.freq = freqInput.value; });
		panel._body.appendChild(Ui.field('频点', freqInput, '指定频点时必须选择接入技术'));

		var pciInput = document.createElement('input');
		pciInput.className = 'cbi-input-text';
		pciInput.placeholder = '留空则不限';
		pciInput.addEventListener('input', function () { filter.pci = pciInput.value; });
		panel._body.appendChild(Ui.field('PCI', pciInput, '需同时指定频点，仅 LTE/NR 支持'));

		var scsSel = document.createElement('select');
		scsSel.className = 'cbi-input-select';
		scsSel.appendChild(document.createElement('option'));
		Parse.SCS_TYPES.forEach(function (o) {
			var opt = document.createElement('option');
			opt.value = String(o.value); opt.textContent = o.label;
			scsSel.appendChild(opt);
		});
		scsSel.addEventListener('change', function () { filter.scs = scsSel.value; });
		var scsField = Ui.field('子载波间隔', scsSel, 'NR 指定频点或 PCI 时必填');
		scsField.style.display = 'none';
		panel._body.appendChild(scsField);

		function syncBandOptions() {
			scsField.style.display = filter.rat === '3' ? '' : 'none';
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

		/* ---------- 按钮 ---------- */
		var startBtn = Ui.primaryButton('开始扫描', start);
		var cancelBtn = Ui.dangerButton('取消扫描', cancel);
		cancelBtn.style.display = 'none';
		var actions = E('div', { 'class': 'at-panel-actions' });
		actions.appendChild(startBtn);
		actions.appendChild(cancelBtn);
		panel._body.appendChild(actions);

		var noteEl = E('div', { 'class': 'at-note' });
		panel._body.appendChild(noteEl);

		/* ---------- 结果表格 ---------- */
		var table = E('table', { 'class': 'cbi-section-table at-table' });
		panel._body.appendChild(table);

		function renderNote() {
			noteEl.textContent = note;
			noteEl.style.display = note ? '' : 'none';
		}

		function render() {
			renderNote();
			table.innerHTML = '';
			var head = E('thead');
			var hr = E('tr');
			['制式', 'PLMN', '频段', '频点', 'PCI', '信号', 'SINR', '操作'].forEach(function (h) { hr.appendChild(E('th', {}, h)); });
			head.appendChild(hr);
			table.appendChild(head);
			var tb = E('tbody');
			if (!cells.length) {
				var tr0 = E('tr');
				tr0.appendChild(E('td', { 'colspan': '8', 'class': 'at-empty' }, scanning ? '扫描中…' : '暂无扫描结果'));
				tb.appendChild(tr0);
			} else {
				for (var i = 0; i < cells.length; i++) {
					var cell = cells[i];
					var tr = E('tr');
					tr.appendChild(E('td', {}, cell.ratName || '—'));
					tr.appendChild(E('td', {}, cell.plmn || '—'));
					tr.appendChild(E('td', {}, cell.band != null ? (cell.ratName === 'NR' ? 'n' + cell.band : 'B' + cell.band) : '—'));
					tr.appendChild(E('td', {}, cell.freq != null ? String(cell.freq) : '—'));
					tr.appendChild(E('td', {}, cell.pci != null ? String(cell.pci) : '—'));
					tr.appendChild(E('td', {}, signalText(cell)));
					tr.appendChild(E('td', {}, cell.sinr != null ? String(cell.sinr) : '—'));
					var tdOp = E('td');
					var lockable = (cell.ratName === 'LTE' || cell.ratName === 'NR') && cell.band != null && cell.freq != null && cell.pci != null;
					var lockBtn = Ui.button('锁定', 'cbi-button-action', function (c) { return function () { lockCell(c); }; }(cell));
					lockBtn.disabled = scanning || !lockable;
					tdOp.appendChild(lockBtn);
					tr.appendChild(tdOp);
					tb.appendChild(tr);
				}
			}
			table.appendChild(tb);
		}

		function signalText(cell) {
			if (cell.rsrp != null) return cell.rsrp + ' dBm';
			if (cell.rxlev != null) return cell.rxlev + ' dBm';
			return '—';
		}

		/* ---------- 动作 ---------- */
		function start() {
			var built = Parse.buildScanCommand(filter);
			if (built.error) { Ui.error(built.error); return; }
			cells = [];
			note = '';
			scanning = true;
			startedRef = true;
			startBtn.style.display = 'none';
			cancelBtn.style.display = '';
			render();
			Ui.info('扫描中，全频段扫描可能需要几分钟');
			AtWs.client.sendCommand(built.command).then(function (res) {
				if (!res.success) throw new Error(res.error || '模组拒绝了扫频命令');
				note = '扫描中，全频段扫描可能需要几分钟';
				renderNote();
			}).catch(function (err) {
				scanning = false;
				startedRef = false;
				startBtn.style.display = '';
				cancelBtn.style.display = 'none';
				Ui.error((err && err.message) || '启动扫频失败');
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
				Ui.error((err && err.message) || '取消扫频失败');
			});
		}

		function lockCell(cell) {
			var kind = cell.ratName === 'LTE' ? 'lte' : 'nr';
			var scs = cell.scs != null ? cell.scs : Parse.getDefaultScsType(cell.band);
			var cmd = Parse.buildLockCommand(kind, 2, 0, [{ band: cell.band, arfcn: String(cell.freq), pci: String(cell.pci), scs: scs }]);
			Ui.confirm('确定锁定 ' + cell.ratName + ' Band ' + cell.band + '（频点 ' + cell.freq + '，PCI ' + cell.pci + '）？', function () {
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
					Ui.success('已锁定 ' + cell.ratName + ' PCI ' + cell.pci);
				}).catch(function (err) {
					Ui.error((err && err.message) || '锁定失败');
					if (radioOff) Ui.setFlightMode(false).catch(function () {});
				});
			});
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
				Ui.error('扫频失败：' + (push.error || '未知错误'));
				return;
			}
			note = push.state === 'aborted'
				? '已取消，保留已扫到的 ' + push.count + ' 个小区'
				: '扫描完成，共 ' + push.count + ' 个小区';
			render();
		};
		AtWs.client.subscribe(handler);

		/* ---------- 页面恢复 + 轮询核对 + 离开时收掉 ---------- */
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

		var pollTimer = setInterval(function () {
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
		}, 5000);

		this._dispose = function () {
			clearInterval(pollTimer);
			AtWs.client.unsubscribe(handler);
			// 离开页面时主动收掉本页发起的扫频
			if (startedRef) AtWs.client.sendCommand(Parse.SCAN_ABORT_COMMAND).catch(function () {});
		};

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
			checkState();
		});

		return page;
	}
});
