'use strict';
'require view';
'require fs';
'require ui';
'require dom';
'require mt5700m.controls as controls';

function sectionValue(raw, label) {
	var marker = '===== ' + label + ':';
	var lines = (raw || '').split(/\n/);
	var active = false;
	var result = [];

	lines.forEach(function(line) {
		if (line.indexOf('===== ') === 0) {
			active = line.indexOf(marker) === 0;
			return;
		}
		if (active && line.trim() && line.trim() !== 'OK')
			result.push(line.trim());
	});

	return result.join('\n');
}

function matchValues(text, prefix) {
	var line = (text || '').split(/\n/).filter(function(item) { return item.indexOf(prefix) === 0; })[0] || '';
	// MT5700M private commands are inconsistent: most reply "^CMD: value" but
	// a few (notably ^NRSSBID) reply "^NRSSBID=value". Strip a leading colon
	// or equals sign so the first field is not corrupted by the delimiter.
	return line.substring(prefix.length).replace(/^[ :=]+/, '').replace(/"/g, '').split(',').map(function(value) { return value.trim(); });
}

function ssbValue(value, invalid) {
	// The manual defines dedicated "invalid" sentinels for the SSB fields:
	// ARFCN 0xFFFFFFFF (4294967295), PCI 0xFFFF (65535) and the signed
	// RSRP/SINR/TA fields 0x7FFF (32767) / -1. Hide those instead of showing
	// the raw sentinel so the panel only renders meaningful measurements.
	if (value === undefined || value === null || value === '')
		return '';
	if ((invalid || []).some(function(item) { return String(value) === String(item); }))
		return '';
		return value;
	}

	// Parse a full AT^NRSSBID? response (manual 13.28) into a structured object.
	// Field layout: [0]ARFCN [1]CID [2]PCI [3]RSRP [4]SINR [5]TA
	// [6..21] 8 serving beams (SSBID, RSRP pairs)
	// [22] N_NB_CELL, then per neighbour (up to 4): NB_PCI, NB_ARFCN, NB_RSRP,
	// NB_SINR and 4 neighbour SSB beams. The module strips the leading '=' so the
	// first field is no longer corrupted.
	function parseNrsSbid(text) {
		var raw = matchValues(text, '^NRSSBID');
		if (!raw.length)
			return null;
		var info = {
			arfcn: raw[0], cid: raw[1], pci: raw[2], rsrp: raw[3], sinr: raw[4], ta: raw[5],
			beams: [], neighbours: []
		};
		for (var i = 0; i < 8; i++) {
			var id = raw[6 + i * 2];
			var rsrp = raw[7 + i * 2];
			var idNum = parseInt(id, 10);
			// A valid serving SSB ID is 0..7; the module reports the 0xFF/0x7FFF
			// sentinels (255 / 32767) for beams with no measurement.
			if (!(idNum >= 0 && idNum <= 7))
				continue;
			info.beams.push({ id: id, rsrp: rsrp === '32767' ? '' : rsrp });
		}
		// N_NB_CELL (0..4) follows the serving beams. The AT manual's documented
		// layout places it at index 22, but some firmware/example outputs insert a
		// stray field, shifting it to index 23. Probe both so the neighbour block
		// is located correctly either way.
		var nbIdx = 22;
		var n = parseInt(raw[nbIdx], 10);
		if (!(n >= 0 && n <= 4)) {
			nbIdx = 23;
			n = parseInt(raw[nbIdx], 10);
			if (!(n >= 0 && n <= 4))
				n = 0;
		}
		if (n > 4)
			n = 4;
		var base = nbIdx + 1;
		for (var j = 0; j < n; j++) {
			var o = base + j * 12;
			info.neighbours.push({
				pci: raw[o], arfcn: raw[o + 1], rsrp: raw[o + 2], sinr: raw[o + 3]
			});
		}
		return info;
	}

	function cleanCsv(value) {
	return (value || '').replace(/\s+/g, '').replace(/^,+|,+$/g, '').replace(/,+/g, ',');
}

function validCsv(value) {
	return /^[0-9]+(,[0-9]+)*$/.test(value);
}

function csvInRange(value, minimum, maximum) {
	return validCsv(value) && value.split(',').every(function(item) {
		var number = Number(item);
		return number >= minimum && number <= maximum;
	});
}

function countLines(text, prefix) {
	return (text || '').split(/\n/).filter(function(line) { return line.indexOf(prefix) === 0; }).length;
}

// Map an MCS index to its modulation scheme, accounting for the 3GPP table
// the module reports (NR TABLE 1/2/3 and uplink TABLE 4/5; LTE uses its own
// tables). Invalid sentinels (255) yield an empty string.
function mcsModulation(mcs, table, rat) {
	if (mcs === undefined || mcs === null || mcs === '' || mcs === '255')
		return '';
	var m = parseInt(mcs, 10);
	if (!(m >= 0 && m <= 31))
		return '';
	var t = parseInt(table, 10);
	if (rat === '0') { // LTE (TS36.213 Table 7.1.7.1-1)
		if (m <= 6) return 'QPSK';
		if (m <= 15) return '16QAM';
		if (m <= 27) return '64QAM';
		return '256QAM';
	}
	if (t === 4) { // NR uplink 64QAM (TS38.214 Table 6.1.4.2)
		if (m <= 10) return 'QPSK';
		if (m <= 20) return '16QAM';
		return '64QAM';
	}
	if (t === 5) { // NR uplink 256QAM
		if (m <= 10) return 'QPSK';
		if (m <= 20) return '16QAM';
		if (m <= 26) return '64QAM';
		return '256QAM';
	}
	if (t === 3) { // NR low-SE table
		if (m <= 9) return 'QPSK';
		if (m <= 16) return '16QAM';
		return '64QAM';
	}
	if (m <= 9) return 'QPSK'; // NR TABLE 1/2 default
	if (m <= 16) return '16QAM';
	if (m <= 28) return '64QAM';
	return '256QAM';
}

// Parse a full MCS section. The module can return several ^MCS: lines for
// multi-carrier / EN-DC, each describing one RAT with one group of three
// fields (table index, codeword0, codeword1) per carrier.
function parseMcsSection(text) {
	var lines = (text || '').split(/\n/).map(function(l) { return l.trim(); })
		.filter(function(l) { return l.indexOf('^MCS') === 0; });
	return lines.map(function(line) {
		var body = line.replace(/^\^MCS/, '').replace(/^[ :=]+/, '').replace(/"/g, '');
		var v = body.split(',').map(function(x) { return x.trim(); });
		var rat = v[1];
		var carriers = [];
		for (var i = 2; i + 2 < v.length; i += 3) {
			carriers.push({ table: v[i], code0: v[i + 1], code1: v[i + 2] });
		}
		return { rat: rat, carriers: carriers };
	});
}

// Build a readable modulation summary node for an MCS section.
// Single-carrier single-codeword cases use a compact one-liner
// (e.g. "NR · MCS 20 · 64QAM"); multi-carrier / EN-DC cases expand into
// a per-carrier detail list.
function mcsDetailNode(text) {
	var groups = parseMcsSection(text);
	if (!groups.length)
		return E('span', {}, _('Not available'));
	// Fast path: single RAT, single carrier → compact one-liner
	if (groups.length === 1 && groups[0].carriers.length === 1) {
		var g = groups[0], c = g.carriers[0];
		var c0 = mcsModulation(c.code0, c.table, g.rat);
		var c1 = mcsModulation(c.code1, c.table, g.rat);
		var ratName = g.rat === '1' ? 'NR' : g.rat === '0' ? 'LTE' : '';
		var parts = [];
		if (c0) parts.push('MCS ' + c.code0 + ' · ' + c0);
		if (c1) parts.push('MCS ' + c.code1 + ' · ' + c1);
		if (!parts.length)
			return E('span', {}, _('Not available'));
		return E('strong', {}, (ratName ? ratName + ' · ' : '') + parts.join(' / '));
	}
	// Multi-carrier / EN-DC: expanded detail list
	var rows = [];
	groups.forEach(function(group) {
		var ratName = group.rat === '1' ? 'NR' : group.rat === '0' ? 'LTE' : '';
		group.carriers.forEach(function(c, idx) {
			var c0 = mcsModulation(c.code0, c.table, group.rat);
			var c1 = mcsModulation(c.code1, c.table, group.rat);
			var parts = [];
			if (c0) parts.push('MCS ' + c.code0 + ' · ' + c0);
			if (c1) parts.push('MCS ' + c.code1 + ' · ' + c1);
			if (!parts.length)
				return;
			var label = _('Carrier %d').format(idx + 1);
			if (ratName && groups.length > 1)
				label = ratName + ' ' + label;
			rows.push(E('div', { 'class': 'mt-mcs-row' }, [
				E('span', {}, label),
				E('strong', {}, parts.join('   ·   '))
			]));
		});
	});
	if (!rows.length)
		return E('span', {}, _('Not available'));
	return E('div', { 'class': 'mt-mcs-list' }, rows);
}

// ---------- Cell scan parsers & renderer ----------

// Parse AT^MONSC serving cell response.
// Format: ^MONSC: <RAT>,<MCC>,<MNC>,<ARFCN>,<SCS>,<CellID>,<PCI>,<TAC>,
//         <RSRP>,<RSRQ>,<SINR>[,<...>]
function parseMonsc(text) {
	var lines = (text || '').split(/\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.indexOf('^MONSC:') === 0; });
	if (!lines.length) return null;
	var v = lines[0].replace(/^\^MONSC:/, '').replace(/^[ :=]+/, '').replace(/"/g, '').split(',').map(function(x) { return x.trim(); });
	if (!v[0]) return null;
	return { rat: v[0], mcc: v[1], mnc: v[2], arfcn: v[3], scs: v[4], cellId: v[5], pci: v[6], tac: v[7], rsrp: v[8], rsrq: v[9], sinr: v[10] };
}

// Parse AT^MONNC neighbour cell responses (one ^MONNC: per neighbour).
// Format: ^MONSC: <RAT>,<ARFCN>,<RSRP>,<RSRQ>,<SINR>
function parseMonnc(text) {
	var lines = (text || '').split(/\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.indexOf('^MONNC:') === 0; });
	return lines.map(function(line) {
		var v = line.replace(/^\^MONNC:/, '').replace(/^[ :=]+/, '').replace(/"/g, '').split(',').map(function(x) { return x.trim(); });
		return { rat: v[0], arfcn: v[1], rsrp: v[2], rsrq: v[3], sinr: v[4] };
	});
}

// Render cell scan results as structured panels instead of raw <pre> text.
function renderCellScan(raw) {
	var sections = [];
	// Serving cell from MONSC
	var monsc = parseMonsc(controls.section(raw, 'Serving cell: AT^MONSC') || raw);
	if (monsc && monsc.rat) {
		var scsKhz = monsc.scs ? ({ '0':'15', '1':'30', '2':'60', '3':'120', '4':'240' }[monsc.scs] || '?') : '';
		sections.push(E('section', { 'class':'mt-scan-panel mt-ui-card' }, [
			E('h4', {}, _('Serving cell')),
			E('table', { 'class':'mt-scan-table' }, [
				E('tbody', {}, [
					tr(_('RAT'), monsc.rat),
					tr('ARFCN', monsc.arfcn),
					tr('PCI', monsc.pci),
					tr('RSRP', monsc.rsrp ? monsc.rsrp + ' dBm' : '--'),
					tr('RSRQ', monsc.rsrq ? monsc.rsrq + ' dB' : '--'),
					tr('SINR', monsc.sinr ? monsc.sinr + ' dB' : '--'),
					scsKhz ? tr(_('SCS'), scsKhz + ' kHz') : null,
					tr('Cell ID', monsc.cellId || '--'),
					tr('TAC', monsc.tac || '--')
				].filter(Boolean))
			])
		]));
	}
	// Neighbour cells from MONNC
	var monnc = parseMonnc(controls.section(raw, 'Neighbour cells: AT^MONNC') || raw);
	if (monnc.length) {
		var nbRows = monnc.map(function(nb, i) {
			return E('tr', {}, [
				E('td', {}, String(i + 1)),
				E('td', {}, nb.rat || '--'),
				E('td', {}, nb.arfcn || '--'),
				E('td', {}, nb.rsrp ? nb.rsrp + ' dBm' : '--'),
				E('td', {}, nb.rsrq ? nb.rsrq + ' dB' : '--'),
				E('td', {}, nb.sinr ? nb.sinr + ' dB' : '--')
			]);
		});
		sections.push(E('section', { 'class':'mt-scan-panel mt-ui-card' }, [
			E('h4', {}, _('Neighbour cells (%d)').format(monnc.length)),
			E('table', { 'class':'mt-scan-table' }, [
				E('thead', {}, E('tr', {}, [E('th', {}, '#'), E('th', {}, _('RAT')), E('th', {}, 'ARFCN'), E('th', {}, 'RSRP'), E('th', {}, 'RSRQ'), E('th', {}, 'SINR')])),
				E('tbody', {}, nbRows)
			])
		]));
	}
	// CELLSCAN frequency scan (raw — may be empty or ERROR)
	var cellscanSection = controls.section(raw, 'Frequency scan: AT^CELLSCAN');
	var cellscanLines = (cellscanSection || '').split(/\n/).filter(function(l) { return l.trim() && l.trim() !== 'OK'; });
	var hasCellScanData = cellscanLines.some(function(l) { return l.indexOf('^CELLSCAN:') === 0; });
	var hasCellScanError = cellscanLines.some(function(l) { return l.indexOf('ERROR') !== -1; });
	if (hasCellScanData) {
		sections.push(E('section', { 'class':'mt-scan-panel mt-ui-card' }, [
			E('h4', {}, _('Frequency scan')),
			E('pre', { 'class':'mt-net-raw mt-scan-raw' }, cellscanSection)
		]));
	} else if (hasCellScanError) {
		sections.push(E('section', { 'class':'mt-scan-panel mt-ui-card' }, [
			E('h4', {}, _('Frequency scan')),
			E('div', { 'class':'mt-scan-note' }, _('Frequency scan is not available while the module is camped on a cell (%s).').format('+CME ERROR: 3'))
		]));
	}
	if (!sections.length)
		return E('div', {}, E('div', { 'class':'alert-message warning' }, _('No scan data received.')));
	return E('div', { 'class':'mt-scan-results' }, sections);
}

// Helper: table row for key-value pairs
function tr(label, value) {
	return E('tr', {}, [ E('td', {}, label), E('td', {}, value || '--') ]);
}

function bandChecklist(options, mask, anyMask) {
	var numeric = parseInt(mask || '0', 16);
	var all = String(mask || '').toUpperCase() === anyMask;
	var checks = options.map(function(item) {
		var value = parseInt(item[0], 16);
		return E('input', {
			'type':'checkbox',
			'value':item[0],
			'checked':all || (numeric && Math.floor(numeric / value) % 2 === 1) ? 'checked' : null
		});
	});
	var node = E('div', { 'class':'mt-band-options' }, options.map(function(item, index) {
		return E('label', { 'class':'mt-band-option' }, [ checks[index], E('span', {}, item[1]) ]);
	}));
	node._bandCheckboxes = checks;
	return node;
}

function selectedBandMask(node, anyMask) {
	var selected = node._bandCheckboxes.filter(function(checkbox) { return checkbox.checked; });
	if (!selected.length)
		return '';
	if (selected.length === node._bandCheckboxes.length)
		return anyMask;
	return selected.reduce(function(total, checkbox) { return total + parseInt(checkbox.value, 16); }, 0).toString(16).toUpperCase();
}

function bandPanel(title, description, checklist) {
	return E('section', { 'class':'mt-band-card mt-ui-card' }, [
		E('div', { 'class':'mt-band-head' }, [
			E('div', {}, [ E('h3', {}, title), E('p', {}, description) ]),
			E('button', {
				'type':'button',
				'class':'btn',
				'click':function() { checklist._bandCheckboxes.forEach(function(checkbox) { checkbox.checked = true; }); }
			}, _('Select all'))
		]),
		checklist
	]);
}

function parseServingCell(values) {
	var rat = String(values[0] || '').toUpperCase();
	var cell = {
		rat: values[0] || '', mcc: values[1] || '', mnc: values[2] || '',
		arfcn: '', scs: '', cellId: '', pci: '', tac: '', metrics: []
	};

	if (rat.indexOf('NR') === 0) {
		cell.arfcn = values[3] || '';
		cell.scs = values[4] || '';
		cell.cellId = values[5] || '';
		cell.pci = values[6] || '';
		cell.tac = values[7] || '';
		cell.metrics = [
			{ label: 'RSRP', value: values[8] || '', unit: 'dBm' },
			{ label: 'RSRQ', value: values[9] || '', unit: 'dB' },
			{ label: 'SINR', value: values[10] || '', unit: 'dB' }
		];
	} else if (rat.indexOf('LTE') === 0) {
		cell.arfcn = values[3] || '';
		cell.cellId = values[4] || '';
		cell.pci = values[5] || '';
		cell.tac = values[6] || '';
		cell.metrics = [
			{ label: 'RSRP', value: values[7] || '', unit: 'dBm' },
			{ label: 'RSRQ', value: values[8] || '', unit: 'dB' },
			{ label: 'RSSI', value: values[9] || '', unit: 'dBm' }
		];
	} else if (rat.indexOf('WCDMA') === 0) {
		cell.arfcn = values[3] || '';
		cell.cellId = values[5] || '';
		cell.tac = values[6] || '';
		cell.metrics = [
			{ label: 'RSCP', value: values[7] || '', unit: 'dBm' },
			{ label: 'RXLEV', value: values[8] || '', unit: 'dBm' },
			{ label: 'ECIO', value: values[9] || '', unit: 'dB' }
		];
	} else {
		cell.metrics = [
			{ label: 'RSRP', value: '', unit: 'dBm' },
			{ label: 'RSRQ', value: '', unit: 'dB' },
			{ label: 'SINR', value: '', unit: 'dB' }
		];
	}

	return cell;
}

return view.extend({
	load: function() {
		return Promise.all([
			fs.exec('/usr/sbin/mt5700m-at', [ 'network' ]).catch(function(err) {
				return { stdout: '', stderr: err.message || String(err) };
			}),
			fs.exec('/usr/sbin/mt5700m-at', [ 'advanced', 'radio' ]).catch(function(err) {
				return { stdout: '', stderr: err.message || String(err) };
			})
		]);
	},

	styleNode: function() {
		return E('style', {}, [
			'.mt-net{max-width:1120px;margin:0 auto;color:var(--text-color-high,#20242a)}',
			'.mt-net-hero{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:21px 23px;border:1px solid #cfe4fb;border-radius:15px;background:linear-gradient(135deg,#f4f9ff,#eefaf8);margin-bottom:16px}',
			'.mt-net-kicker{font-size:12px;color:#2470a9;font-weight:700;margin-bottom:5px}',
			'.mt-net-title{font-size:25px;font-weight:720;line-height:1.2;margin:0 0 6px}',
			'.mt-net-sub{font-size:13px;color:var(--text-color-medium,#68717d)}',
			'.mt-net-badge{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border-radius:999px;background:#dcf6eb;color:#08775d;font-size:12px;font-weight:700;white-space:nowrap}',
			'.mt-net-badge:before{content:"";width:7px;height:7px;border-radius:50%;background:#17b883}',
			'.mt-net-badge.off{background:#fff0e2;color:#99530a}.mt-net-badge.off:before{background:#e99737}',
			'.mt-net-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 16px}',
			'.mt-net-metric,.mt-net-panel{border:1px solid var(--border-color-medium,#d9dde4);border-radius:13px;background:var(--background-color-high,#fff);box-shadow:0 3px 12px rgba(20,32,50,.04)}',
			'.mt-net-metric{padding:16px}.mt-net-label{font-size:12px;color:var(--text-color-medium,#707985);margin-bottom:6px}',
			'.mt-net-value{font-size:23px;font-weight:720}.mt-net-unit{font-size:12px;color:#747c86;margin-left:5px}',
			'.mt-net-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
			'.mt-net-panel{padding:16px}.mt-net-panel h3{font-size:14px;margin:0 0 12px}',
			'.mt-net-row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid var(--border-color-low,#edf0f4);font-size:13px}',
			'.mt-net-row:last-child{border-bottom:0}.mt-net-row span:first-child{color:var(--text-color-medium,#707985)}.mt-net-row strong{text-align:right;word-break:break-word}',
			'.mt-mcs-list{display:flex;flex-direction:column;gap:7px;padding:3px 0}.mt-mcs-row{display:flex;justify-content:space-between;gap:14px;font-size:12.5px;line-height:1.5}.mt-mcs-row span:first-child{color:var(--text-color-medium,#707985);flex:0 0 auto}.mt-mcs-row strong{text-align:right;word-break:break-word;font-weight:600}',
			'.mt-net-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:15px}.mt-net-actions .btn{border-radius:9px;padding:7px 14px}',
			'.mt-scan-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:12px;margin-top:12px}.mt-scan-panel{padding:16px}.mt-scan-panel h4{font-size:14px;margin:0 0 12px;color:var(--text-color-high,#20242a)}.mt-scan-table{width:100%;border-collapse:collapse;font-size:12.5px}.mt-scan-table th,.mt-scan-table td{padding:6px 10px;border-bottom:1px solid var(--border-color-low,#edf0f4);text-align:left}.mt-scan-table th{color:var(--text-color-medium,#707985);font-weight:600;background:var(--background-color-low,#f8fafb)}.mt-scan-table td{text-align:right;font-weight:600}.mt-scan-table td:first-child{text-align:left;font-weight:400}.mt-scan-note{color:var(--text-color-medium,#707985);font-size:12px;padding:8px 0}.mt-scan-raw{margin-top:8px}',
			'.mt-net-details{margin-top:14px;border:1px solid var(--border-color-medium,#d9dde4);border-radius:12px;overflow:hidden}',
			'.mt-net-details summary{cursor:pointer;padding:13px 15px;font-size:13px;font-weight:650}.mt-net-raw{margin:0;padding:14px;background:#17202a;color:#dce6ef;white-space:pre-wrap;word-break:break-word;font:12px/1.55 monospace;max-height:420px;overflow:auto}',
			'.mt-freq-head{margin-top:20px;padding:19px 20px;border-radius:13px;background:linear-gradient(135deg,#f4f7fb,#f1f8f6);border:1px solid #dce7ee}.mt-freq-head h3{font-size:18px;margin:0 0 6px}.mt-freq-head p{margin:0;color:var(--text-color-medium,#68717d);font-size:12px}',
			'.mt-freq-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}.mt-freq-card{padding:17px;border:1px solid var(--border-color-medium,#d9dde4);border-radius:13px;background:var(--background-color-high,#fff)}.mt-freq-card h4{margin:0 0 12px;font-size:14px}.mt-freq-field{margin:11px 0}.mt-freq-field label{display:block;font-size:12px;color:var(--text-color-medium,#6d7680);margin-bottom:5px}.mt-freq-field input,.mt-freq-field select{width:100%;box-sizing:border-box}.mt-freq-help{font-size:11px;color:var(--text-color-medium,#7b838c);margin-top:5px}.mt-freq-actions{display:flex;justify-content:flex-end;margin-top:14px}',
			'.mt-band-card{padding:18px}.mt-band-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:14px}.mt-band-head h3{margin:0 0 4px;font-size:15px}.mt-band-head p{margin:0;color:var(--text-color-medium,#6d7680);font-size:11px;line-height:1.45}.mt-band-head .btn{flex:0 0 auto}.mt-band-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.mt-band-option{display:flex;align-items:center;gap:9px;min-height:40px;padding:7px 10px;border:1px solid var(--border-color-low,#e8ecf0);border-radius:9px;background:var(--background-color-low,#f8fafb);cursor:pointer;font-size:12px;transition:border-color .15s ease,background-color .15s ease}.mt-band-option:hover{border-color:#9cc5ee;background:#f1f7fd}.mt-band-option input{flex:0 0 auto;width:16px!important;height:16px;margin:0}.mt-band-apply{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:18px;padding:15px 18px}.mt-band-apply p{margin:0;color:var(--text-color-medium,#6d7680);font-size:11px;line-height:1.5}.mt-band-apply .btn{flex:0 0 auto}',
			'@media(max-width:720px){.mt-net-hero{display:block}.mt-net-badge{margin-top:13px}.mt-net-metrics{grid-template-columns:1fr}.mt-net-grid,.mt-freq-grid{grid-template-columns:1fr}.mt-band-options{grid-template-columns:repeat(2,minmax(0,1fr))}.mt-band-apply{display:block}.mt-band-apply .btn{width:100%;margin-top:12px}}',
			'@media(max-width:430px){.mt-band-head{display:block}.mt-band-head .btn{margin-top:10px}.mt-band-options{grid-template-columns:1fr}}'
		].join(''));
	},

	row: function(label, value) {
		return E('div', { 'class': 'mt-net-row' }, [ E('span', {}, label), E('strong', {}, value || '--') ]);
	},

	metric: function(label, value, unit) {
		return E('div', { 'class': 'mt-net-metric mt-ui-card' }, [
			E('div', { 'class': 'mt-net-label' }, label),
			E('span', { 'class': 'mt-net-value' }, value || '--'),
			value ? E('span', { 'class': 'mt-net-unit' }, unit) : null
		]);
	},

	lockPanel: function(title, rat, currentType) {
		var self = this;
		var type = E('select', { 'class':'cbi-input-select' }, [E('option',{'value':'3'},_('Band Lock')),E('option',{'value':'1'},_('ARFCN Lock')),E('option',{'value':'2'},_('Cell Lock')),E('option',{'value':'0'},_('Remove Lock'))]);
		type.value = /^(0|1|2|3)$/.test(currentType || '') ? currentType : '0';
		var bands = E('input', { 'class':'cbi-input-text','placeholder':rat==='nr'?'78,41':'3,8','inputmode':'numeric' });
		var arfcns = E('input', { 'class':'cbi-input-text','placeholder':rat==='nr'?'630000,520000':'1850,3450','inputmode':'numeric' });
		var scs = E('input', { 'class':'cbi-input-text','placeholder':'1,1','inputmode':'numeric' });
		var pcis = E('input', { 'class':'cbi-input-text','placeholder':'100,200','inputmode':'numeric' });
		var wraps = {};
		function field(key,label,input,help){wraps[key]=E('div',{'class':'mt-freq-field'},[E('label',{},label),input,E('div',{'class':'mt-freq-help'},help)]);return wraps[key];}
		function update(){var t=type.value;wraps.bands.style.display=t==='0'?'none':'';wraps.arfcns.style.display=t==='1'||t==='2'?'':'none';if(wraps.scs)wraps.scs.style.display=t==='1'||t==='2'?'':'none';wraps.pcis.style.display=t==='2'?'':'none';}
		function apply(){
			var t=type.value, values=[cleanCsv(bands.value),cleanCsv(arfcns.value),cleanCsv(scs.value),cleanCsv(pcis.value)];
			var required=t==='0'?[]:t==='3'?[0]:t==='1'?(rat==='nr'?[0,1,2]:[0,1]):(rat==='nr'?[0,1,2,3]:[0,1,3]);
			if(required.some(function(i){return !validCsv(values[i]);}))return ui.addNotification(null,E('p',{},_('Complete all required fields using comma-separated numbers.')),'warning');
				var lengths=required.map(function(i){return values[i].split(',').length;});
				if(lengths.some(function(n){return n!==lengths[0];}))return ui.addNotification(null,E('p',{},_('Each field must contain the same number of values.')),'warning');
				if(lengths[0]>20)return ui.addNotification(null,E('p',{},_('The MT5700M manual allows at most 20 lock entries.')),'warning');
				if(rat==='nr'&&(t==='1'||t==='2')&&!csvInRange(values[2],0,4))return ui.addNotification(null,E('p',{},_('NR SCS type must be between 0 and 4.')),'warning');
				if(t==='2'&&!csvInRange(values[3],0,rat==='nr'?1007:503))return ui.addNotification(null,E('p',{},_('PCI is outside the valid range for the selected radio technology.')),'warning');
				var args=rat==='nr'?['lock',rat,t,values[0],values[1],values[2],values[3]]:['lock',rat,t,values[0],values[1],values[3]];
				ui.showModal(_('Confirm frequency change'),[E('p',{},[t==='0'?_('Remove the current %s frequency lock?').format(rat.toUpperCase()):_('Apply this %s frequency lock? Mobile connectivity may reconnect.').format(rat.toUpperCase()),' ',_('Mobile service will disconnect briefly while the module enters airplane mode.')]),E('div',{'class':'right'},[E('button',{'type':'button','class':'btn','click':ui.hideModal},_('Cancel')),' ',E('button',{'type':'button','class':'btn cbi-button-negative','click':function(){ui.hideModal();fs.exec('/usr/sbin/mt5700m-at',args).then(function(){ui.addNotification(null,E('p',{},_('Frequency lock updated.')));window.setTimeout(function(){window.location.reload();},2500);},function(err){ui.addNotification(null,E('p',{},err.message||_('The modem rejected this setting.')),'danger');});}},t==='0'?_('Remove Lock'):_('Apply Lock'))])]);
		}
		type.addEventListener('change',update);
		var body=[field('type',_('Lock Type'),type,_('Choose the least restrictive mode that meets your need.')),field('bands',_('Bands'),bands,_('Use numbers separated by commas.')),field('arfcns',_('ARFCNs'),arfcns,_('One ARFCN for each band.'))];
		if(rat==='nr')body.push(field('scs',_('SCS Types'),scs,_('One SCS type for each NR band.')));
		body.push(field('pcis','PCI',pcis,_('One PCI for each band and ARFCN.')),E('div',{'class':'mt-freq-actions'},E('button',{'type':'button','class':'btn cbi-button-apply','click':apply},_('Review and apply'))));
		var card=E('section',{'class':'mt-freq-card mt-ui-card'},[E('h4',{},title)].concat(body));window.setTimeout(update,0);return card;
	},

	radioDiagnostics: function(raw) {
		var uplinkMcsText = controls.section(raw, 'Uplink MCS');
		var downlinkMcsText = controls.section(raw, 'Downlink MCS');
		var txPower = matchValues(controls.section(raw, 'NR transmit power'), '^NTXPOWER');
		var ssbRaw = controls.section(raw, 'NR SSB beam');
		var ssb = matchValues(ssbRaw, '^NRSSBID');
		var qos = matchValues(controls.section(raw, 'QoS'), '+CGEQOSRDP');
		var dataRegistration = matchValues(controls.section(raw, 'Data registration'), '+C5GREG');
		var ims = matchValues(controls.section(raw, 'IMS registration'), '+CIREG');
		var endc = matchValues(controls.section(raw, 'Dual connectivity'), '^LENDC');
		var lteSecondary = countLines(controls.section(raw, 'LTE secondary cells'), '^CASCELLINFO');
		var nsaSecondary = countLines(controls.section(raw, 'NSA secondary cells'), '^MONSSC: NR');
		var ssbInfo = parseNrsSbid(ssbRaw);
		return E('div', { 'class':'mt-net-ssb-wrap' }, [
			E('div', { 'class':'mt-net-grid', 'style':'margin-top:12px' }, [
				E('section', { 'class':'mt-net-panel mt-ui-card' }, [
					E('h3', {}, _('Radio link details')),
					this.row(_('Uplink modulation'), mcsDetailNode(uplinkMcsText)), this.row(_('Downlink modulation'), mcsDetailNode(downlinkMcsText)),
					this.row(_('QoS class'), qos[1] ? 'QCI ' + qos[1] : ''), this.row(_('NR PUSCH power'), txPower[0] && txPower[0] !== '999' ? txPower[0] + ' dBm' : ''),
					this.row(_('NR PUCCH power'), txPower[1] && txPower[1] !== '999' ? txPower[1] + ' dBm' : ''), this.row(_('NR transmit frequency'), txPower[4] && txPower[4] !== '0' ? (Number(txPower[4]) / 1000).toFixed(1) + ' MHz' : '')
				]),
				E('section', { 'class':'mt-net-panel mt-ui-card' }, [
					E('h3', {}, _('5G beam and service')), this.row(_('LTE secondary carriers'), String(lteSecondary)), this.row(_('NSA secondary connections'), String(nsaSecondary)),
					this.row(_('NR neighbour cells'), ssbInfo ? String(ssbInfo.neighbours.length) : (ssb.length > 6 ? '0' : '')),
					this.row(_('Data registration'), dataRegistration[1] === '1' || dataRegistration[1] === '5' ? _('Registered') : dataRegistration.length ? _('Not registered') : ''),
					this.row(_('IMS registration'), ims[1] === '1' ? _('Registered') : ims.length ? _('Not registered') : ''), this.row(_('LTE-NR dual connectivity'), endc[0] === '1' ? _('Enabled') : endc.length ? _('Disabled') : '')
				])
			]),
			this.ssbPanel(ssbInfo)
		]);
	},

	ssbPanel: function(info) {
		if (!info) {
			return E('section', { 'class':'mt-net-panel mt-ui-card', 'style':'margin-top:12px' }, [
				E('h3', {}, _('SSB information')),
				E('div', { 'class':'mt-net-row' }, [ E('span', {}, _('NR SSB measurement')), E('strong', {}, _('Not available')) ])
			]);
		}
		var serving = E('div', {}, [
			this.row(_('SSB ARFCN'), ssbValue(info.arfcn, [ '4294967295' ])),
			this.row(_('Serving beam PCI'), ssbValue(info.pci, [ '65535' ])),
			this.row(_('Beam RSRP'), ssbValue(info.rsrp, [ '32767' ]) ? info.rsrp + ' dBm' : ''),
			this.row(_('Beam SINR'), ssbValue(info.sinr, [ '32767' ]) ? info.sinr + ' dB' : ''),
			this.row(_('Timing advance'), ssbValue(info.ta, [ '-1' ]) ? info.ta + ' us' : '')
		]);
		var beamChildren = [];
		if (info.beams.length) {
			info.beams.forEach(function(b) {
				beamChildren.push(E('div', { 'class':'mt-net-row' }, [
					E('span', {}, _('SSB ID %s').format(b.id)),
					E('strong', {}, ssbValue(b.rsrp, [ '32767' ]) ? b.rsrp + ' dBm' : '--')
				]));
			});
		} else {
			beamChildren.push(E('div', { 'class':'mt-net-row' }, [ E('span', {}, _('Serving beams')), E('strong', {}, _('No measurement')) ]));
		}
		var nbChildren = [];
		if (info.neighbours.length) {
			info.neighbours.forEach(function(nb, i) {
				nbChildren.push(E('div', { 'class':'mt-net-row' }, [
					E('span', {}, _('Neighbour %d').format(i + 1)),
					E('strong', {}, [
						ssbValue(nb.pci, [ '65535' ]) ? _('PCI %s').format(nb.pci) : _('PCI ?'),
						'  ·  ',
						ssbValue(nb.arfcn, [ '4294967295' ]) ? 'ARFCN ' + nb.arfcn : _('ARFCN ?'),
						'  ·  ',
						ssbValue(nb.rsrp, [ '32767' ]) ? nb.rsrp + ' dBm' : '--',
						ssbValue(nb.sinr, [ '32767' ]) ? '  ·  ' + nb.sinr + ' dB' : ''
					])
				]));
			});
		} else {
			nbChildren.push(E('div', { 'class':'mt-net-row' }, [ E('span', {}, _('NR neighbour cells')), E('strong', {}, _('None reported')) ]));
		}
		return E('section', { 'class':'mt-net-panel mt-ui-card', 'style':'margin-top:12px' }, [
			E('h3', {}, _('SSB information')),
			E('div', { 'class':'mt-net-grid', 'style':'margin-top:8px' }, [
				E('div', {}, [ E('h4', { 'style':'margin:0 0 8px;font-size:13px' }, _('Serving cell')), serving ]),
				E('div', {}, [ E('h4', { 'style':'margin:0 0 8px;font-size:13px' }, _('Serving SSB beams (%d)').format(info.beams.length)) ].concat(beamChildren)),
				E('div', { 'style':'grid-column:1 / -1' }, [ E('h4', { 'style':'margin:0 0 8px;font-size:13px' }, _('NR neighbour cells (%d)').format(info.neighbours.length)) ].concat(nbChildren))
			])
		]);
	},

	render: function(results) {
		var res = results[0] || {}, radioSettings = results[1] || {};
		var raw = res.stdout || '', radioRaw = radioSettings.stdout || '';
		var signal = matchValues(sectionValue(raw, 'Signal'), '^HCSQ');
		var cell = parseServingCell(matchValues(sectionValue(raw, 'Serving cell'), '^MONSC'));
		var registration = matchValues(sectionValue(raw, 'Network registration'), '+CEREG');
		var operator = matchValues(sectionValue(raw, 'Operator'), '+COPS');
		var lteLock = matchValues(sectionValue(raw, 'LTE lock'), '^LTEFREQLOCK');
		var nrLock = matchValues(sectionValue(raw, 'NR lock'), '^NRFREQLOCK');
		var rrc = matchValues(sectionValue(raw, 'RRC state'), '^RRCSTAT');
		var rrcLabels = [ _('Idle'), _('Connected'), _('Inactive'), _('Invalid') ];
		var rrcState = rrc.length > 1 ? (rrcLabels[Number(rrc[1])] || rrc[1]) : '';
		if (rrc.length > 2)
			rrcState += rrc[2] === '98' ? ' · ' + _('Camped') : rrc[2] === '99' ? ' · ' + _('Not camped') : '';
		var registered = registration[1] === '1' || registration[1] === '5';
		var operatorName = operator[2] || _('Mobile Network');
		var lteLockState = !lteLock[0] ? '--' : lteLock[0] === '0' ? _('Not locked') : _('Locked');
		var nrLockState = !nrLock[0] ? '--' : nrLock[0] === '0' ? _('Not locked') : _('Locked');
		var systemValues = matchValues(controls.section(radioRaw, 'Radio mode'), '^SYSCFGEX');
		var radioCode = systemValues[0] || '';
		var wcdmaMask = systemValues[1] || '3FFFFFFF';
		var roamValue = systemValues[2] || '1';
		var serviceDomain = systemValues[3] || '2';
		var lteMask = systemValues[4] || '7FFFFFFFFFFFFFFF';
		var radioLabels = {
			'00': _('Automatic'), '01': 'GSM', '02': 'WCDMA', '03': 'LTE', '08': '5G NR',
			'0302': 'LTE / WCDMA', '030201': 'LTE / WCDMA / GSM',
			'0803': '5G NR / LTE', '080302': '5G NR / LTE / WCDMA'
		};
		var radioMode = radioLabels[radioCode] ? radioLabels[radioCode] + ' · ' + radioCode : radioCode;
		var radioModeSelect = controls.select([
			['080302',_('5G NR / LTE / WCDMA (recommended)')],['0803',_('5G NR / LTE')],['08',_('5G NR only')],
			['03',_('LTE only')],['0302',_('LTE / WCDMA')],['02','WCDMA']
		], radioCode || '080302');
		var roaming = controls.select([['0',_('Home network only')],['1',_('Allow roaming')]], roamValue);
		var service = controls.select([['1',_('Data service only')],['2',_('Voice and data service')]], serviceDomain);
		var wcdmaBands = bandChecklist([['400000','B1 · 2100 MHz'],['2000000000000','B8 · 900 MHz']], wcdmaMask, '3FFFFFFF');
		var lteBands = bandChecklist([
			['1','B1'],['4','B3'],['10','B5'],['80','B8'],['200000000','B34'],
			['2000000000','B38'],['4000000000','B39'],['8000000000','B40'],['10000000000','B41']
		], lteMask, '7FFFFFFFFFFFFFFF');
		var accessValues = matchValues(controls.section(radioRaw, '5G access mode'), '^C5GOPTION');
		var accessCode = accessValues.slice(0, 3).join(',');
		var accessPreset = controls.select([
			['option23',_('SA + NSA (Option 2 + 3)')],['option2',_('SA only (Option 2)')],['option3',_('NSA only (Option 3)')]
		], accessCode === '1,0,1' ? 'option2' : accessCode === '0,1,0' ? 'option3' : 'option23');
		var ca = controls.pick(controls.section(radioRaw, 'NR carrier aggregation'), /\^NRRCCAPQRY:\s*3,(\d+)/, '');
		var vonr = controls.pick(controls.section(radioRaw, 'VoNR'), /\^NRRCCAPQRY:\s*2,(\d+)/, '');
		var dssMatch = controls.section(radioRaw, 'DSS').match(/\^NRRCCAPQRY:\s*5,(\d+),(\d+)/);
		var caEnabled = controls.select([['1',_('Enabled')],['0',_('Disabled')]], ca);
		var vonrMode = controls.select([['0',_('Disabled')],['1','FR1 VoNR'],['2','FR2 VoNR'],['3','FR1 + FR2 VoNR']], vonr);
		var dssRate = controls.select([['0',_('Keep factory capability')],['1',_('Force capability off')]], dssMatch ? dssMatch[1] : '0');
		var dssDmrs = controls.select([['0',_('Keep factory capability')],['1',_('Force capability off')]], dssMatch ? dssMatch[2] : '0');
		var diagnosticHost = E('div', { 'class':'mt-net-diagnostics' }, E('div', { 'class':'alert-message notice' }, _('Loading detailed radio diagnostics…')));
		var self = this;
		window.setTimeout(function() {
			fs.exec('/usr/sbin/mt5700m-at', [ 'advanced', 'radio-diagnostics' ]).then(function(result) {
				dom.content(diagnosticHost, self.radioDiagnostics(result.stdout || ''));
			}, function(err) {
				dom.content(diagnosticHost, E('div', { 'class':'alert-message warning' }, err.message || String(err)));
			});
		}, 0);
		var radioControls = E('section', { 'class':'mt-control-section' }, [
			E('div', { 'class':'mt-control-section-head' }, [
				E('h3', {}, _('Radio preferences')),
				E('p', {}, _('5G service capabilities reported by the MT5700M. Keep the carrier defaults unless compatibility troubleshooting requires a change.'))
			]),
			radioSettings.stderr ? E('div', { 'class':'alert-message warning' }, radioSettings.stderr) : null,
			E('div', { 'class':'mt-control-grid' }, [
				controls.card(_('Network access policy'), _('Select radio priority, roaming and the service domain. These values are applied together as required by the MT5700M manual.'), [
					controls.row(_('Radio access order'), radioModeSelect),
					controls.row(_('Roaming policy'), roaming),
					controls.row(_('Service domain'), service)
				], true),
				bandPanel(_('WCDMA bands'), _('Select the WCDMA bands the module may use.'), wcdmaBands),
				bandPanel(_('LTE bands'), _('Select the LTE bands the module may use.'), lteBands),
				E('section', { 'class':'mt-band-apply mt-ui-card' }, [
					E('p', {}, _('Keep all bands selected for normal use. Restricting bands can prevent registration when travelling.')),
					E('button', { 'type':'button', 'class':'btn cbi-button-apply', 'click':function() {
						var selectedWcdma = selectedBandMask(wcdmaBands, '3FFFFFFF');
						var selectedLte = selectedBandMask(lteBands, '7FFFFFFFFFFFFFFF');
						if (!selectedWcdma || !selectedLte)
							return ui.addNotification(null, E('p', {}, _('Select at least one WCDMA band and one LTE band.')), 'warning');
						controls.confirmRun(_('Change network policy'), _('The module may lose service if the selected radio technology or bands are unavailable.'), [ 'advanced-set', 'radio-policy', radioModeSelect.value, selectedWcdma, roaming.value, service.value, selectedLte ], true);
					} }, _('Apply network and band settings'))
				]),
				controls.card(_('5G access architecture'), _('Choose whether the module may use standalone 5G, non-standalone 5G, or both.'), [
					controls.row(_('5G access mode'), accessPreset),
					E('div', { 'class':'mt-control-note' }, _('The MT5700M manual requires an airplane-mode cycle before this setting and a module restart afterwards. The cycle is handled automatically; restart when ready.')),
					controls.action(_('Apply 5G access mode'), function() {
						controls.confirmRun(_('Change 5G access mode'), _('Mobile service will disconnect briefly while the module enters airplane mode.'), [ 'advanced-set', '5g-access', accessPreset.value ], true);
					})
				]),
				controls.card(_('5G service capabilities'), _('Carrier aggregation and voice capability advertised by the module.'), [
					controls.state(_('Current radio mode'), radioMode),
					controls.row(_('NR carrier aggregation capability'), caEnabled),
					controls.action(_('Apply carrier aggregation'), function() {
						controls.confirmRun(_('NR carrier aggregation capability'), _('Apply the selected carrier aggregation capability?'), [ 'advanced-set', 'carrier-aggregation', caEnabled.value ], true);
					}),
					controls.row(_('VoNR mode'), vonrMode),
					controls.action(_('Apply VoNR mode'), function() {
						controls.confirmRun(_('VoNR mode'), _('Apply the selected VoNR capability?'), [ 'advanced-set', 'vonr', vonrMode.value ], true);
					})
				]),
				controls.card(_('DSS compatibility'), _('Restrict optional DSS capabilities only when required by the mobile network.'), [
					controls.row(_('DSS rate matching capability'), dssRate),
					controls.row(_('Additional DMRS capability'), dssDmrs),
					E('div', { 'class':'mt-control-note' }, _('Force capability off is a compatibility override. Keep the factory capability for normal operation.')),
					controls.action(_('Apply DSS settings'), function() {
						controls.confirmRun('DSS', _('Apply the selected DSS capability restrictions?'), [ 'advanced-set', 'dss', dssRate.value, dssDmrs.value ], true);
					})
				])
			])
		]);

		return E('div', { 'class': 'mt-net mt-ui-page' }, [
			this.styleNode(),
			controls.styleNode(),
			res.stderr ? E('div', { 'class': 'alert-message warning' }, res.stderr) : null,
			E('section', { 'class': 'mt-net-hero mt-ui-hero' }, [
				E('div', {}, [
					E('div', { 'class': 'mt-net-kicker' }, _('NETWORK AND CELL')),
					E('h2', { 'class': 'mt-net-title' }, operatorName),
					E('div', { 'class': 'mt-net-sub' }, _('Serving-cell and registration information reported by the modem.'))
				]),
				E('span', { 'class': 'mt-net-badge' + (registered ? '' : ' off') }, registered ? _('Registered') : _('Not registered'))
			]),
			E('div', { 'class': 'mt-net-metrics' }, [
				this.metric(cell.metrics[0].label, cell.metrics[0].value, cell.metrics[0].unit),
				this.metric(cell.metrics[1].label, cell.metrics[1].value, cell.metrics[1].unit),
				this.metric(cell.metrics[2].label, cell.metrics[2].value, cell.metrics[2].unit)
			]),
			E('div', { 'class': 'mt-net-grid' }, [
				E('section', { 'class': 'mt-net-panel' }, [
					E('h3', {}, _('Serving cell')),
					this.row(_('Radio access'), cell.rat || signal[0]),
					this.row('MCC / MNC', cell.mcc && cell.mnc ? '%s / %s'.format(cell.mcc, cell.mnc) : ''),
					this.row('ARFCN', cell.arfcn),
					this.row('PCI', cell.pci),
					this.row(_('Cell ID'), cell.cellId),
					this.row('TAC / LAC', cell.tac),
					cell.scs ? this.row(_('SCS type'), cell.scs + ' · ' + ([ '15', '30', '60', '120', '240' ][Number(cell.scs)] || '?') + ' kHz') : null,
					this.row(_('Registration'), registered ? (registration[1] === '5' ? _('Roaming') : _('Home network')) : _('Not registered'))
				]),
				E('section', { 'class': 'mt-net-panel' }, [
					E('h3', {}, _('Radio status')),
					this.row(_('Operator'), operatorName),
					this.row(_('RRC state'), rrcState),
					this.row(_('LTE Lock'), lteLockState),
					this.row(_('NR Lock'), nrLockState)
				])
			]),
			diagnosticHost,
			E('div', { 'class': 'mt-net-actions' }, [
				E('button', { 'class': 'btn cbi-button-action', 'click': function() { window.location.reload(); } }, _('Refresh status')),
				E('button', { 'class': 'btn cbi-button', 'click': function() {
					return ui.showModal(_('Confirm Action'), [
						E('p', {}, _('Cell scan may take some time and can briefly increase modem load.')),
						E('div', { 'class': 'right' }, [ E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ', E('button', { 'class': 'btn cbi-button-apply', 'click': function() {
							ui.hideModal();
							fs.exec('/usr/sbin/mt5700m-at', [ 'cellscan' ]).then(function(scan) {
								var body = scan.stdout ? renderCellScan(scan.stdout) : E('div', { 'class':'alert-message warning' }, _('No response.'));
								ui.showModal(_('Cell Scan'), [ body, E('div', { 'class': 'right', 'style':'margin-top:14px' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))) ]);
							});
						} }, _('Continue')) ])
					]);
				} }, _('Cell Scan'))
			]),
			E('details', { 'class': 'mt-net-details mt-ui-details' }, [
				E('summary', {}, [
					E('span', { 'class':'mt-ui-summary-copy' }, E('span', { 'class':'mt-ui-summary-title' }, _('Technical details'))),
					E('span', { 'class':'mt-ui-chevron', 'aria-hidden':'true' }, '›')
				]),
				E('pre', { 'class': 'mt-net-raw mt-ui-details-body' }, raw || _('No response.'))
			]),
			radioControls,
			E('section', { 'class':'mt-freq-head mt-ui-card' }, [E('h3',{},_('Frequency and cell selection')),E('p',{},_('Advanced controls for limiting LTE or 5G NR bands, frequencies and cells. Leave these unlocked for normal automatic network selection.'))]),
			E('div', { 'class':'mt-freq-grid' }, [this.lockPanel(_('LTE network'),'lte',lteLock[0]),this.lockPanel(_('5G NR network'),'nr',nrLock[0])])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
