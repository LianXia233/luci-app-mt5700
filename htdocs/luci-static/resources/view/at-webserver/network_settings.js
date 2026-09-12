'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 网络设置 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/Settings.tsx：LTE/NR 锁频、邻区扫描（MONNC）、
 * 5G 选项（C5GOPTION）、网络拒绝原因（^REJINFO 主动上报）。
 * 锁频应用流程与基准一致：飞行模式 → 下发锁频命令 → 关闭飞行模式 → 重新查询。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络设置', '锁频、邻区与 5G 选项');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 锁频编辑器状态 ---------- */
		var lockState = {
			lteType: 0, lteMobility: 0, lteItems: [{}],
			nrType: 0, nrMobility: 0, nrItems: [{}],
			option5g: null
		};

		var lteCard = Mt5700.card('LTE 锁频', '锁定频段/频点/小区；应用时会自动切换飞行模式使配置生效');
		var lteBody = E('div');
		lteCard._body.appendChild(lteBody);
		body.appendChild(lteCard);

		var nrCard = Mt5700.card('NR 锁频', 'NR 锁频需单板支持 NR，SCS 未指定时按频段自动推断');
		var nrBody = E('div');
		nrCard._body.appendChild(nrBody);
		body.appendChild(nrCard);

		var neighCard = Mt5700.card('邻区扫描', 'AT^MONNC 查询当前邻区，可自动刷新');
		var neighBody = E('div');
		neighCard._body.appendChild(neighBody);
		body.appendChild(neighCard);

		var optCard = Mt5700.card('5G 选项', 'NR SA 支持 / DC 模式 / 接入模式');
		var optBody = E('div', { 'class': 'mt5700-metrics' });
		optCard._body.appendChild(optBody);
		body.appendChild(optCard);

		/* ---------- 网络拒绝原因（^REJINFO 主动上报） ---------- */

		var rejectCard = Mt5700.card('网络拒绝', '^REJINFO 主动上报的网络拒绝原因（注册失败时实时更新）');
		var rejectBody = E('div');
		rejectCard._body.appendChild(rejectBody);
		body.appendChild(rejectCard);
		var lastReject = null;

		function renderReject() {
			rejectBody.innerHTML = '';
			if (!lastReject) {
				rejectBody.appendChild(Mt5700.empty('尚无网络拒绝上报'));
				return;
			}
			var r = lastReject;
			rejectBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'网络拒绝：' + r.rejectTypeText + '（' + r.causeText + '）'));
			rejectBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				r.ratText + ' · PLMN ' + r.plmn + ' · ' + r.domainText + ' · 小区 ' + (r.cellId || '—')));
			rejectBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'原始原因值 #' + r.originalCause + ' · LAC ' + (r.lac || '—') + ' · RAC ' + (r.rac || '—') +
				(r.esmCause !== undefined ? ' · ESM 原因 #' + r.esmCause : '') +
				' · ' + new Date(r.at).toLocaleTimeString()));
		}
		renderReject();

		var rejectHandler = function (resp) {
			if (!resp || resp.type !== 'urc_data' || !resp.data) return;
			if (resp.data.type === 'REJINFO' && resp.data.parsed) {
				lastReject = resp.data.parsed;
				renderReject();
			}
		};
		AtWs.client.subscribe(rejectHandler);

		/* ---------- 锁频编辑器 ---------- */

		var TYPE_OPTIONS = Parse.LOCK_TYPES;
		var SCS_OPTIONS = Parse.SCS_TYPES;

		function bandOptionsFor(kind) {
			return kind === 'lte' ? Parse.LTE_BANDS : Parse.NR_BANDS;
		}

		function lockEditor(kind) {
			var wrap = E('div', { 'class': 'mt5700-lock-editor' });
			var typeSel = Mt5700.select(TYPE_OPTIONS.map(function (o) {
				return { label: o.label, value: String(o.value) };
			}), String(lockState[kind + 'Type']));
			typeSel.addEventListener('change', function () {
				lockState[kind + 'Type'] = parseInt(typeSel.value, 10);
				renderItems();
			});
			wrap.appendChild(Mt5700.formGroup('锁频类型', typeSel));

			var mobWrap = E('div');
			wrap.appendChild(mobWrap);

			var itemsWrap = E('div', { 'class': 'mt5700-lock-items' });
			wrap.appendChild(itemsWrap);

			var addBtn = Mt5700.button('+ 添加', function () {
				var items = lockState[kind + 'Items'];
				if (items.length >= Parse.MAX_LOCK_ITEMS) {
					Mt5700.warning(kind.toUpperCase() + ' 最多只能锁 ' + Parse.MAX_LOCK_ITEMS + ' 组');
					return;
				}
				items.push({});
				renderItems();
			}, 'ghost');
			wrap.appendChild(addBtn);

			function rowFor(item, index) {
				var row = E('div', { 'class': 'mt5700-lock-item' });

				var bandOpts = [{ label: '（未选择）', value: '' }].concat(bandOptionsFor(kind).map(function (b) {
					return { label: b.label, value: String(b.value) };
				}));
				var bandSel = Mt5700.select(bandOpts, String(item.band == null ? '' : item.band));
				bandSel.addEventListener('change', function () {
					item.band = bandSel.value ? Number(bandSel.value) : null;
				});
				row.appendChild(bandSel);

				var arfcn = Mt5700.input('text', '频点 ARFCN', item.arfcn != null ? String(item.arfcn) : '');
				arfcn.addEventListener('input', function () { item.arfcn = arfcn.value.trim(); });
				row.appendChild(arfcn);

				if (kind === 'nr') {
					var scsOpts = [{ label: '（自动）', value: '' }].concat(SCS_OPTIONS.map(function (o) {
						return { label: o.label, value: String(o.value) };
					}));
					var scs = Mt5700.select(scsOpts, String(item.scs == null ? '' : item.scs));
					scs.addEventListener('change', function () {
						item.scs = scs.value ? Number(scs.value) : null;
					});
					row.appendChild(scs);
				}

				var pci = Mt5700.input('text', 'PCI', item.pci != null ? String(item.pci) : '');
				pci.addEventListener('input', function () { item.pci = pci.value.trim(); });
				row.appendChild(pci);

				var del = Mt5700.button('删除', function () {
					lockState[kind + 'Items'].splice(index, 1);
					if (!lockState[kind + 'Items'].length) lockState[kind + 'Items'].push({});
					renderItems();
				}, 'danger');
				row.appendChild(del);
				return row;
			}

			function renderItems() {
				itemsWrap.innerHTML = '';
				var type = lockState[kind + 'Type'];
				var items = lockState[kind + 'Items'];
				mobWrap.innerHTML = '';
				if (type !== 0) {
					var mobSel = Mt5700.select([
						{ label: '低移动性', value: '0' },
						{ label: '中移动性', value: '1' },
						{ label: '高移动性', value: '2' }
					], String(lockState[kind + 'Mobility']));
					mobSel.addEventListener('change', function () { lockState[kind + 'Mobility'] = parseInt(mobSel.value, 10); });
					mobWrap.appendChild(Mt5700.formGroup('移动性', mobSel));
				}
				if (type === 1 || type === 2) {
					for (var i = 0; i < items.length; i++) itemsWrap.appendChild(rowFor(items[i], i));
				} else if (type === 3) {
					for (var j = 0; j < items.length; j++) {
						var row = E('div', { 'class': 'mt5700-lock-item' });
						var bandOpts2 = [{ label: '（未选择）', value: '' }].concat(bandOptionsFor(kind).map(function (b) {
							return { label: b.label, value: String(b.value) };
						}));
						var bandSel2 = Mt5700.select(bandOpts2, String(items[j].band == null ? '' : items[j].band));
						bandSel2.addEventListener('change', function (idx) {
							return function () { items[idx].band = bandSel2.value ? Number(bandSel2.value) : null; };
						}(j));
						row.appendChild(bandSel2);
						var del2 = Mt5700.button('删除', function (idx) {
							return function () {
								lockState[kind + 'Items'].splice(idx, 1);
								if (!lockState[kind + 'Items'].length) lockState[kind + 'Items'].push({});
								renderItems();
							};
						}(j), 'danger');
						row.appendChild(del2);
						itemsWrap.appendChild(row);
					}
				} else {
					itemsWrap.appendChild(Mt5700.empty('锁频类型为「关闭」时不需配置参数'));
				}
			}

			var applyBtn = Mt5700.primaryButton('应用 ' + kind.toUpperCase() + ' 锁频', function () { applyLock(kind); });
			wrap.appendChild(Mt5700.panelActions(applyBtn));
			renderItems();
			return wrap;
		}

		lteBody.appendChild(lockEditor('lte'));
		nrBody.appendChild(lockEditor('nr'));

		/* ---------- 锁频响应解析 ---------- */

		function parseLockResponse(raw, prefix) {
			var lines = String(raw).split('\n').map(function (l) { return l.trim(); })
				.filter(function (l) { return l && l.indexOf('OK') < 0 && l.indexOf('AT') !== 0; });
			var head = -1;
			for (var i = 0; i < lines.length; i++) {
				if (lines[i].indexOf(prefix) === 0) { head = i; break; }
			}
			if (head < 0) return null;
			var typeMatch = lines[head].match(new RegExp(prefix.replace('^', '\\^') + ':\\s*(\\d+)'));
			if (!typeMatch) return null;
			var lockType = Number(typeMatch[1]);
			if (lockType === 0) return { lockType: 0, mobility: 0, items: [{}] };
			var nm = (lines[head + 1] || '0,0').split(',').map(Number);
			var mobility = nm[0], num = nm[1];
			var items = [];
			for (var j = 0; j < num; j++) {
				var parts = (lines[head + j + 2] || '').split(',').map(function (v) { return v ? Number(v) : undefined; });
				if (prefix === '^LTEFREQLOCK') {
					items.push({ band: parts[0], arfcn: parts[1] != null ? String(parts[1]) : undefined, pci: parts[2] != null ? String(parts[2]) : undefined });
				} else {
					items.push({ band: parts[0], arfcn: parts[1] != null ? String(parts[1]) : undefined, scs: parts[2], pci: parts[3] != null ? String(parts[3]) : undefined });
				}
			}
			return { lockType: lockType, mobility: mobility, items: items.length ? items : [{}] };
		}

		/* ---------- 应用锁频 ---------- */

		var busy = false;
		function applyLock(kind) {
			if (busy) return;
			busy = true;
			var label = kind.toUpperCase();
			var cmd;
			try {
				var items = lockState[kind + 'Items'];
				var type = lockState[kind + 'Type'];
				var mobility = lockState[kind + 'Mobility'];
				if (type === 0) {
					cmd = (kind === 'lte' ? 'AT^LTEFREQLOCK=0' : 'AT^NRFREQLOCK=0');
				} else {
					cmd = Parse.buildLockCommand(kind, type, mobility, items);
				}
			} catch (err) {
				Mt5700.error(err.message || '锁频参数错误');
				busy = false;
				return;
			}
			Mt5700.info('正在应用 ' + label + ' 锁频（先切飞行模式）…');
			var radioOff = false;
			Ui.setFlightMode(true).then(function (ok) {
				if (!ok) throw new Error('开启飞行模式失败');
				radioOff = true;
				return Ui.sleep(1000);
			}).then(function () {
				return AtWs.client.sendCommand(cmd);
			}).then(function (res) {
				if (!res.success) throw new Error(Ui.atErrorText(res, label + '锁频设置失败'));
				Mt5700.success(label + '锁频设置成功');
				return Ui.sleep(2000);
			}).then(function () {
				return Ui.setFlightMode(false);
			}).then(function (off) {
				if (!off) throw new Error('关闭飞行模式失败');
				return Ui.sleep(2000);
			}).then(function () {
				return fetchCurrent();
			}).catch(function (err) {
				Mt5700.error(err.message || '锁频设置失败');
				if (radioOff) Ui.setFlightMode(false).catch(function () {});
			}).then(function () { busy = false; });
		}

		/* ---------- 查询当前锁频 ---------- */

		function fetchCurrent() {
			var chain = Promise.resolve();
			chain = chain.then(function () {
				return AtWs.client.sendCommand('AT^LTEFREQLOCK?').then(function (res) {
					if (res.success && res.data) {
						var parsed = parseLockResponse(res.data, '^LTEFREQLOCK');
						if (parsed) {
							lockState.lteType = parsed.lockType;
							lockState.lteMobility = parsed.mobility;
							lockState.lteItems = parsed.items;
						}
					}
				});
			});
			chain = chain.then(function () {
				return AtWs.client.sendCommand('AT^NRFREQLOCK?').then(function (res) {
					if (res.success && res.data) {
						var parsed = parseLockResponse(res.data, '^NRFREQLOCK');
						if (parsed) {
							lockState.nrType = parsed.lockType;
							lockState.nrMobility = parsed.mobility;
							lockState.nrItems = parsed.items;
						}
					}
				});
			});
			chain = chain.then(query5G);
			chain = chain.then(function () {
				// 回填锁频表单（基准：查询后重新渲染）
				lteBody.innerHTML = '';
				lteBody.appendChild(lockEditor('lte'));
				nrBody.innerHTML = '';
				nrBody.appendChild(lockEditor('nr'));
			});
			return chain;
		}

		/* ---------- 5G 选项 ---------- */

		function query5G() {
			return Ui.sleep(200).then(function () {
				return AtWs.client.sendCommand('AT^C5GOPTION?');
			}).then(function (res) {
				optBody.innerHTML = '';
				if (res.success && res.data) {
					var m = String(res.data).match(/\^C5GOPTION:\s*(\d+),(\d+),(\d+)/);
					if (m) {
						lockState.option5g = { nr_sa_support_flag: Number(m[1]), nr_dc_mode: Number(m[2]), gc_access_mode: Number(m[3]) };
						var saLabels = { 0: '不支持 NR SA', 1: '支持 NR SA' };
						var dcLabels = { 0: '不支持 DC', 1: '支持 EN-DC' };
						var gcLabels = { 0: '仅 4G', 1: '5G NSA', 2: '5G SA', 3: '5G SA+NSA' };
						var items = [
							{ label: 'NR SA 支持', value: saLabels[m[1]] || m[1] },
							{ label: 'NR DC 模式', value: dcLabels[m[2]] || m[2] },
							{ label: '接入模式', value: gcLabels[m[3]] || m[3] }
						];
						for (var i = 0; i < items.length; i++) {
							optBody.appendChild(Mt5700.metric(items[i].label, items[i].value));
						}
						return;
					}
				}
				optBody.appendChild(Mt5700.empty('暂无 5G 选项信息'));
			});
		}

		/* ---------- 邻区扫描 ---------- */

		var neighbors = [];
		var scanning = false;

		function renderNeighbors() {
			neighBody.innerHTML = '';
			var rows = [];
			for (var i = 0; i < neighbors.length; i++) {
				var c = neighbors[i];
				var lockBtn = Mt5700.button('锁定', function (idx) {
					return function () { lockCell(neighbors[idx]); };
				}(i), 'primary');
				rows.push([
					c.type,
					c.band != null ? (c.type === 'NR' ? 'n' + c.band : 'B' + c.band) : '—',
					c.arfcn,
					String(c.pci),
					c.rsrp != null ? c.rsrp + (typeof c.rsrp === 'number' ? ' dBm' : '') : '—',
					c.rsrq != null ? String(c.rsrq) : '—',
					c.sinr != null ? String(c.sinr) : '—',
					lockBtn
				]);
			}
			neighBody.appendChild(Mt5700.table(
				['制式', '频段', 'ARFCN', 'PCI', 'RSRP', 'RSRQ', 'SINR', '操作'],
				rows,
				{ striped: true }
			));
			if (!neighbors.length) {
				neighBody.appendChild(Mt5700.empty('暂无邻区数据，点击「扫描邻区」'));
			}
		}
		renderNeighbors();

		// 由频点反推频段
		function getBandFromArfcn(kind, arfcn) {
			if (kind === 'LTE') {
				var lteMap = [[1, 0, 599], [3, 1200, 1949], [5, 2400, 2649], [8, 3450, 3799], [34, 36200, 36349], [38, 37750, 38249], [39, 38250, 38649], [40, 38650, 39649], [41, 39650, 41589]];
				for (var i = 0; i < lteMap.length; i++) {
					if (arfcn >= lteMap[i][1] && arfcn <= lteMap[i][2]) return lteMap[i][0];
				}
				return null;
			}
			var nrMap = [[1, 422000, 434000], [3, 376000, 396000], [5, 173800, 175000], [8, 185000, 192000], [28, 151600, 160600], [41, 499200, 537999], [77, 620000, 680000], [78, 620000, 653333], [79, 693334, 733333]];
			for (var j = 0; j < nrMap.length; j++) {
				if (arfcn >= nrMap[j][1] && arfcn <= nrMap[j][2]) return nrMap[j][0];
			}
			return null;
		}

		function scanNeighbors() {
			if (scanning) return;
			scanning = true;
			scanBtn.disabled = true;
			AtWs.client.sendCommand('AT^MONNC').then(function (res) {
				var cells = [];
				if (res.success && res.data) {
					String(res.data).split('\n').forEach(function (line) {
						if (line.indexOf('^MONNC:') !== 0) return;
						var matched = line.match(/\^MONNC:\s*(\w+)(?:,(.+))?/);
						if (!matched || matched[1] === 'NONE') return;
						var type = matched[1];
						var values = (matched[2] || '').split(',').map(function (v) { return v.trim().replace(/"/g, ''); });
						if (type === 'LTE') {
							var arfcnL = values[0];
							cells.push({
								type: type, arfcn: arfcnL, pci: parseInt(values[1], 16),
								rsrp: values[2], rsrq: values[3], sinr: undefined,
								band: getBandFromArfcn('LTE', parseInt(arfcnL, 10))
							});
						} else if (type === 'NR') {
							var arfcnN = values[0];
							var scale = function (raw, big) {
								var n = parseInt(raw, 10);
								if (isNaN(n)) return raw;
								return Math.abs(n) > big ? (n / 8).toFixed(1) : n;
							};
							cells.push({
								type: type, arfcn: arfcnN, pci: parseInt(values[1], 16),
								rsrp: scale(values[2], 157), rsrq: scale(values[3], 43.5), sinr: scale(values[4], 40),
								band: getBandFromArfcn('NR', parseInt(arfcnN, 10))
							});
						}
					});
				}
				neighbors = cells;
				renderNeighbors();
			}).catch(function () {
				Mt5700.error('扫描邻区失败');
			}).then(function () {
				scanning = false;
				scanBtn.disabled = false;
			});
		}

		function lockCell(cell) {
			if (busy) return;
			busy = true;
			var kind = cell.type === 'LTE' ? 'lte' : 'nr';
			var cmd;
			try {
				if (cell.band == null) throw new Error('无法由频点 ' + cell.arfcn + ' 判断频段，请在上方锁频表单中手动选择');
				var arfcn = String(cell.arfcn).trim();
				if (!/^\d+$/.test(arfcn)) throw new Error(cell.type + ' 频点必须为整数');
				var pci = String(cell.pci).trim();
				if (!/^\d+$/.test(pci)) throw new Error(cell.type + ' PCI 必须为整数');
				var scs = cell.scs != null ? cell.scs : Parse.getDefaultScsType(cell.band);
				cmd = kind === 'lte'
					? 'AT^LTEFREQLOCK=2,0,1,"' + cell.band + '","' + arfcn + '","' + pci + '"'
					: 'AT^NRFREQLOCK=2,0,1,"' + cell.band + '","' + arfcn + '","' + scs + '","' + pci + '"';
			} catch (err) {
				Mt5700.error(err.message);
				busy = false;
				return;
			}
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
				Mt5700.success('已锁定 ' + cell.type + ' PCI ' + cell.pci);
				return fetchCurrent();
			}).catch(function (err) {
				Mt5700.error(err.message || '锁定失败');
				if (radioOff) Ui.setFlightMode(false).catch(function () {});
			}).then(function () { busy = false; });
		}

		var autoTimer = null;
		var scanBtn = Mt5700.primaryButton('扫描邻区', scanNeighbors);
		var autoRow = Mt5700.panelActions(scanBtn);
		var ar = Ui.autoRefresh(function (enabled, interval) {
			if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
			if (enabled) autoTimer = Ui.interval(interval * 1000, scanNeighbors);
		});
		autoRow.appendChild(ar.el);
		autoRow.appendChild(Mt5700.primaryButton('刷新锁频', function () { fetchCurrent(); }));
		body.appendChild(autoRow);

		/* ---------- 初始化 ---------- */

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						AtWs.client.connect(values.key).catch(function (e) { Mt5700.error((e && e.message) || '认证失败'); });
					}
				});
				return;
			}
			if (err) console.warn(err);
		}).then(function () {
			fetchCurrent();
		});

		self._dispose = function () {
			if (autoTimer) clearInterval(autoTimer);
			AtWs.client.unsubscribe(rejectHandler);
		};

		return page;
	}
});
