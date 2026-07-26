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

// Robust DOM-node detector usable in any LuCI runtime.  Some environments
// report `instanceof HTMLElement` as false for nodes created by E(), so we
// also accept any object exposing nodeType === 1 (a real Element).  This is
// what prevents rich nodes (mcsDetailNode, signalBar, …) from being
// stringified to "[object HTMLElement]" when rendered as a row value.
function isNode(v) {
	return v && typeof v === 'object' && (v instanceof HTMLElement || v.nodeType === 1);
}

function matchValues(text, prefix) {
	var line = (text || '').split(/\n/).filter(function(item) { return item.indexOf(prefix) === 0; })[0] || '';
	// MT5700M private commands are inconsistent: most reply "^CMD: value" but
	// a few (notably ^NRSSBID) reply "^NRSSBID=value". Strip a leading colon
	// or equals sign so the first field is not corrupted by the delimiter.
	return line.substring(prefix.length).replace(/^[ :=]+/, '').replace(/"/g, '').split(',').map(function(value) { return value.trim(); });
}

// Collect EVERY line beginning with `prefix` and flatten all comma-split
// fields into one array. Required because AT^LTEFREQLOCK? / AT^NRFREQLOCK?
// reply with several prefixed lines: <operatetype>, then <forbidFlag>,<num>,
// then one line per locked cell (<band>,<freq/arfcn>,<scs>,<pci>). A single
// matchValues() call only returns the type digit, discarding the lock details.
function collectFreqLock(text, prefix) {
	return (text || '').split(/\n/).filter(function(item) { return item.indexOf(prefix) === 0; }).reduce(function(out, line) {
		var fields = line.substring(prefix.length).replace(/^[ :=]+/, '').replace(/"/g, '').split(',').map(function(v) { return v.trim(); });
		return out.concat(fields);
	}, []);
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
				pci: raw[o], arfcn: raw[o + 1],
				rsrp: cleanSignal(raw[o + 2]), sinr: cleanSignal(raw[o + 3])
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

// Drop the "invalid measurement" sentinels defined by the AT manual so the
// UI shows '--' instead of absurd numbers. NR invalid values are the real
// range multiplied by 8: RSRP -1256, RSRQ -348, SINR -188.
function cleanSignal(value) {
	if (value === undefined || value === null || value === '')
		return '';
	var v = parseFloat(value);
	if (isNaN(v)) return '';
	if (v === -1256 || v === -348 || v === -188 || v === 32767 || v === 255)
		return '';
	return String(value).trim();
}

// Parse AT^MONSC serving cell response (manual 13.9).
// RAT is a string ("NR"/"LTE"/"WCDMA"). Field layout differs per RAT:
//   NR:  NR,MCC,MNC,ARFCN,SCS,CellID,PCI,TAC,RSRP,RSRQ,SINR
//   LTE: LTE,MCC,MNC,ARFCN,CellID,PCI,TAC,RSRP,RSRQ,RSSI   (no SCS!)
function parseMonsc(text) {
	var lines = (text || '').split(/\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.indexOf('^MONSC:') === 0; });
	if (!lines.length) return null;
	var v = lines[0].replace(/^\^MONSC:/, '').replace(/^[ :=]+/, '').replace(/"/g, '').split(',').map(function(x) { return x.trim(); });
	var rat = String(v[0] || '').toUpperCase();
	if (!rat || rat === 'NONE') return null;
	if (rat.indexOf('NR') === 0)
		return { rat: 'NR', mcc: v[1], mnc: v[2], arfcn: v[3], scs: v[4], cellId: v[5], pci: v[6], tac: v[7],
			rsrp: cleanSignal(v[8]), rsrq: cleanSignal(v[9]), sinr: cleanSignal(v[10]) };
	if (rat.indexOf('LTE') === 0)
		return { rat: 'LTE', mcc: v[1], mnc: v[2], arfcn: v[3], scs: '', cellId: v[4], pci: v[5], tac: v[6],
			rsrp: cleanSignal(v[7]), rsrq: cleanSignal(v[8]), rssi: cleanSignal(v[9]), sinr: '' };
	// WCDMA / other: show what we can (RSCP as primary level)
	return { rat: rat, mcc: v[1], mnc: v[2], arfcn: v[3], scs: '', cellId: v[5], pci: v[4], tac: v[6],
		rsrp: cleanSignal(v[7]), rsrq: '', sinr: '' };
}

// Parse AT^MONNC neighbour cell responses (manual 13.10), one ^MONNC: per cell.
// Field layout per RAT (PCI comes BEFORE the signal values!):
//   NR:  NR,ARFCN,PCI,RSRP,RSRQ,SINR
//   LTE: LTE,ARFCN,PCI,RSRP,RSRQ,RXLEV
//   GSM/WCDMA/NONE: skipped (not lockable targets on this module)
function parseMonnc(text) {
	var lines = (text || '').split(/\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.indexOf('^MONNC:') === 0; });
	return lines.map(function(line) {
		var v = line.replace(/^\^MONNC:/, '').replace(/^[ :=]+/, '').replace(/"/g, '').split(',').map(function(x) { return x.trim(); });
		var rat = String(v[0] || '').toUpperCase();
		if (rat.indexOf('NR') === 0)
			return { rat: 'NR', arfcn: v[1], pci: v[2], rsrp: cleanSignal(v[3]), rsrq: cleanSignal(v[4]), sinr: cleanSignal(v[5]) };
		if (rat.indexOf('LTE') === 0)
			return { rat: 'LTE', arfcn: v[1], pci: v[2], rsrp: cleanSignal(v[3]), rsrq: cleanSignal(v[4]), rxlev: cleanSignal(v[5]), sinr: '' };
		return null;
	}).filter(function(item) { return item !== null; });
}

// Render cell scan results as structured panels with graphical signal bars
// and one-click lock buttons (reference: mt5700webui screenshot 4)
function renderCellScan(raw) {
	var self_ref = this; // capture for closure in cellLockCard calls
	var sections = [];
	// Serving cell from MONSC — with colored signal bars and band name
	var monsc = parseMonsc(controls.section(raw, 'Serving cell: AT^MONSC') || raw);
	if (monsc && monsc.rat) {
		var scsKhz = monsc.scs ? ({ '0':'15', '1':'30', '2':'60', '3':'120', '4':'240' }[monsc.scs] || '?') : '';
		var scRatLabel = monsc.rat;
		var scBand = arfcnToBand(monsc.arfcn, scRatLabel);
		var scBars = [ signalBar(monsc.rsrp, 'rsrp', 'RSRP'), signalBar(monsc.rsrq, 'rsrq', 'RSRQ') ];
		if (monsc.rat === 'LTE')
			scBars.push(signalBar(monsc.rssi, 'rsrp', 'RSSI'));
		else
			scBars.push(signalBar(monsc.sinr, 'sinr', 'SINR'));
		sections.push(E('section', { 'class':'mt-scan-panel mt-ui-card' }, [
			E('h4', {}, _('Serving cell')),
			E('div', { 'class':'mt-ssb-serving' }, [
				E('div', { 'class':'mt-ssb-serving-head' }, [
					E('span', { 'class':'mt-ssb-serving-title' }, scRatLabel + (scBand ? ' · ' + scBand : '') + (monsc.pci ? ' · PCI:' + monsc.pci : '') + (monsc.arfcn ? ' · ARFCN:' + monsc.arfcn : '')),
					E('span', { 'class':'mt-ssb-serving-meta' }, (monsc.cellId || '') + (scsKhz ? ' · SCS:' + scsKhz + 'kHz' : ''))
				])
			].concat(scBars))
		]));
	}
	// Neighbour cells from MONNC — split by RAT, show only group matching serving cell
	var monnc = parseMonnc(controls.section(raw, 'Neighbour cells: AT^MONNC') || raw);
	if (monnc.length) {
		var scRat = (monsc && monsc.rat) || '';
		var nrNbs = monnc.filter(function(nb) { return nb.rat === 'NR'; });
		var lteNbs = monnc.filter(function(nb) { return nb.rat === 'LTE'; });
		// Default the primary neighbour block to 5G (NR). The other RAT (LTE)
		// is shown only as a secondary block when NR neighbours are present or
		// as the primary fallback when no NR neighbours are reported at all.
		var activeNbs, activeLabel, otherNbs = [], otherLabel = '';
		if (nrNbs.length) {
			activeNbs = nrNbs;
			activeLabel = _('NR neighbour cells (%d)');
			if (lteNbs.length) { otherNbs = lteNbs; otherLabel = _('LTE neighbour cells (%d)'); }
		} else if (lteNbs.length) {
			activeNbs = lteNbs;
			activeLabel = _('LTE neighbour cells (%d)');
		} else {
			activeNbs = monnc;
			activeLabel = _('Neighbour cells (%d)');
		}
		if (activeNbs.length) {
			var nbCards = activeNbs.map(function(nb, i) {
				var ratType = nb.rat === 'NR' ? 'nr' : nb.rat === 'LTE' ? 'lte' : '';
				var band = arfcnToBand(nb.arfcn, nb.rat);
				return cellLockCard(nb, i, ratType, band);
			});
			sections.push(E('section', { 'class':'mt-scan-panel mt-ui-card' }, [
				E('h4', {}, activeLabel.format(activeNbs.length)),
				E('div', { 'class':'mt-lock-cell-grid' }, nbCards)
			]));
		}
		if (otherNbs.length && otherLabel) {
			var otherCards = otherNbs.map(function(nb, i) {
				var ratType = nb.rat === 'NR' ? 'nr' : nb.rat === 'LTE' ? 'lte' : '';
				var band = arfcnToBand(nb.arfcn, nb.rat);
				return cellLockCard(nb, i, ratType, band);
			});
			sections.push(E('section', { 'class':'mt-scan-panel mt-ui-card' }, [
				E('h4', {}, otherLabel.format(otherNbs.length)),
				E('div', { 'class':'mt-lock-cell-grid' }, otherCards)
			]));
		}
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

// ---------- Graphical signal helpers (mt5700webui reference) ----------

// Map a numeric signal value to a quality class for coloring.
// RSRP: excellent(>=-80), good(-90), fair(-100), weak(<-110)
// RSRQ: excellent(>=-10), good(-15), fair(-20), weak(<-25)
// SINR: excellent(>=20), good(13), fair(0), weak(<0)
function signalColorClass(value, kind) {
	var v = parseFloat(value);
	if (isNaN(v)) return 'unknown';
	if (kind === 'rsrp') { if (v >= -80) return 'excellent'; if (v >= -90) return 'good'; if (v >= -100) return 'fair'; return 'weak'; }
	if (kind === 'rsrq') { if (v >= -10) return 'excellent'; if (v >= -15) return 'good'; if (v >= -20) return 'fair'; return 'weak'; }
	// SINR or default
	if (v >= 20) return 'excellent'; if (v >= 13) return 'good'; if (v >= 0) return 'fair'; return 'weak';
}

// Return a percentage (0-100) for bar width based on value range.
function signalPercent(value, kind) {
	var v = parseFloat(value);
	if (isNaN(v)) return 0;
	if (kind === 'rsrp') return Math.max(0, Math.min(100, (v + 140) * 1.67));   // -140..-80 → 0..100
	if (kind === 'rsrq') return Math.max(0, Math.min(100, (v + 35) * 2.86));     // -35..0 → 0..100
	return Math.max(0, Math.min(100, (v + 10) * 3.33));                         // SINR -10..20 → 0..100
}

// Build a horizontal colored signal bar with optional label.
// Returns DOM: [label span] [track div > fill div] [value text]
function signalBar(value, kind, label) {
	var v = String(value || '--');
	var cls = signalColorClass(value, kind);
	var pct = signalPercent(value, kind);
	var labelText = label ? E('span', { 'class':'mt-sbar-label' }, label) : null;
	return E('div', { 'class':'mt-sbar ' + cls }, [
		labelText,
		E('div', { 'class':'mt-sbar-track', 'role':'progressbar', 'aria-valuenow':String(pct), 'aria-valuemin':'0', 'aria-valuemax':'100' },
			E('div', { 'class':'mt-sbar-fill', 'style':'width:' + pct.toFixed(1) + '%' })),
		E('span', { 'class':'mt-sbar-value' }, v + (kind === 'rsrp' ? 'dBm' : kind === 'rsrq' ? 'dB' : 'dB'))
	]);
}

// Map NR/LTE ARFCN to human-readable band name.
// Frequency ranges sourced from MT5700M-CN Hardware Design Guide Table 5-1.
// NR-ARFCN step = 5 kHz → freq(MHz) = arfcn * 0.005.
// Returns band string like 'n41' or 'B3' or null if unknown.
function arfcnToBand(arfcn, rat) {
	var n = parseInt(arfcn, 10);
	if (isNaN(n) || n < 0) return null;
	if (rat === '101' || rat === 'NR' || rat === 'nr') {
		var freqMHz = n * 0.005;
		// MT5700M-CN supported NR bands — ordered narrow → wide to avoid overlap
		if (freqMHz >= 703    && freqMHz <= 803)    return 'n28';   // 703-748 / 758-803
		if (freqMHz >= 824    && freqMHz <= 894)    return 'n5';    // 824-849 / 869-894
		if (freqMHz >= 880    && freqMHz <= 960)    return 'n8';    // 880-915 / 925-960
		if (freqMHz >= 1710   && freqMHz <= 1880)   return 'n3';    // 1710-1785 / 1805-1880
		if (freqMHz >= 1920   && freqMHz <= 2170)   return 'n1';    // 1920-1980 / 2110-2170
		if (freqMHz >= 2496   && freqMHz <= 2690)   return 'n41';   // 2496-2690 (most common China 5G)
		if (freqMHz >= 3300   && freqMHz <= 3800)   return 'n78';   // 3300-3800
		if (freqMHz >= 4400   && freqMHz <= 5000)   return 'n79';   // 4400-5000
		return 'NR';
	}
	// LTE EARFCN → band (MT5700M-CN supported LTE bands)
	if (rat === '1' || rat === 'LTE' || rat === 'lte') {
		if (n >= 0     && n <= 359)     return 'B1';    // FDD 1920-1980
		if (n >= 1200  && n <= 1949)    return 'B3';    // FDD 1710-1785
		if (n >= 2400  && n <= 2649)    return 'B5';    // FDD 824-849
		if (n >= 3450  && n <= 3799)    return 'B8';    // FDD 880-915
		if (n >= 10000 && n <= 10200)   return 'B34';   // TDD 2010-2025
		if (n >= 37750 && n <= 38249)   return 'B38';   // TDD 2570-2620
		if (n >= 38250 && n <= 38649)   return 'B39';   // TDD 1880-1920
		if (n >= 38650 && n <= 39649)   return 'B40';   // TDD 2300-2400
		if (n >= 39650 && n <= 41589)   return 'B41';   // TDD 2496-2690
		return 'LTE';
	}
	return null;
}

// Build a single SSB beam card (reference: mt5700webui beam grid)
function beamCard(beam) {
	var rsrp = parseFloat(beam.rsrp);
	var cls = isNaN(rsrp) ? 'unknown' : signalColorClass(beam.rsrp, 'rsrp');
	return E('div', { 'class':'mt-beam-card ' + cls }, [
		E('div', { 'class':'mt-beam-id' }, _('SSB-%s').format(beam.id)),
		E('div', { 'class':'mt-beam-rsrp' }, beam.rsrp ? beam.rsrp + ' dBm' : '--')
	]);
}

// Convert band name (n41, B3, etc.) to numeric band number for AT lock commands.
// The mt5700m-at backend expects plain numbers: n41→41, B3→3, n78→78, etc.
function bandNameToNumber(bandName) {
	if (!bandName) return '';
	var m = String(bandName).match(/^n(\d+)$/i);
	if (m) return m[1];                    // n41 → 41
	m = String(bandName).match(/^B(\d+)$/i);
	if (m) return m[1];                    // B3  → 3
	return '';
}

// Shared registry for lock panel input fields — allows cellLockCard's
// "fill panel" button to populate the frequency/cell selection form.
var lockPanelFields = { lte: null, nr: null };

// Build a neighbour cell card with one-click lock button (reference: mt5700webui lock grid).
// hideRsqr: set true for SSB neighbours — ^NRSSBID? does not report RSRQ for
//           neighbour cells (manual 13.28: only NB_PCI,NB_ARFCN,NB_RSRP,NB_SINR).
function cellLockCard(nb, index, rat, bandName, hideRsqr) {
	var rsrpCls = signalColorClass(nb.rsrp, 'rsrp');
	var sinrCls = signalColorClass(nb.sinr, 'sinr');
	var ratLabel = nb.rat === '101' || nb.rat === 'NR' ? 'NR'
		: nb.rat === '1' || nb.rat === 'LTE' ? 'LTE'
		: rat === 'nr' ? 'NR' : rat === 'lte' ? 'LTE' : nb.rat || '?';
	var bandDisplay = bandName || ratLabel;
	var bandNum = bandNameToNumber(bandName);    // e.g. 'n41' → '41' for backend
	// Copy this neighbour cell's data into the matching lock-panel form.
	// Returns true if the panel was found and filled. Used by both the
	// "Fill" button and the "Lock" button (auto-fill before apply).
	function applyFill() {
		var panelRat = (ratLabel === 'NR') ? 'nr' : 'lte';
		var fields = lockPanelFields[panelRat];
		if (!fields || !fields.type || !fields.bands || !fields.arfcns)
			return false;
		// Cell Lock (2) if PCI known, else ARFCN Lock (1)
		fields.type.value = (nb.pci && nb.pci !== '?') ? '2' : '1';
		fields.type.dispatchEvent(new Event('change')); // reveal/hide the right fields
		fields.bands.value = bandNum || '';
		fields.arfcns.value = nb.arfcn || '';
		if (fields.scs) fields.scs.value = '0';
		if (fields.pcis) fields.pcis.value = nb.pci || '';
		return true;
	}
	var lockBtn = E('button', { 'type':'button', 'class':'btn mt-lock-btn' }, _('Lock'));
	lockBtn.addEventListener('click', function() {
		var isNr = (ratLabel === 'NR');
		var lockType = nb.pci && nb.pci !== '?' ? '2' : '1'; // cell lock if PCI known, else ARFCN lock
		// Backend mt5700m-at expects: lock {lte|nr} <type> <bands> [arfcns] [scs] [pcis]
		// bands MUST be a valid numeric CSV — empty string causes exit 64
		var args = isNr
			? ['lock', 'nr', lockType, bandNum || '41', nb.arfcn || '',
			   isNr && lockType === '2' ? '0' : '', nb.pci || '']
			: ['lock', 'lte', lockType, bandNum || '3', nb.arfcn || '', '', nb.pci || ''];
		ui.showModal(_('Confirm lock'), [
			E('p', {}, _('Lock to %s cell? %s · ARFCN %s · PCI %s. Mobile service will reconnect.')
				.format(ratLabel, bandDisplay, nb.arfcn || '?', nb.pci || '?')),
			E('div', { 'class':'right' }, [
				E('button', { 'type':'button', 'class':'btn', 'click': ui.hideModal }, _('Cancel')),
				E('button', { 'type':'button', 'class':'btn cbi-button-negative', 'click': function() {
					ui.hideModal();
					// Auto-fill the lock panel so it reflects the chosen cell
					applyFill();
					fs.exec('/usr/sbin/mt5700m-at', args).then(function() {
						ui.addNotification(null, E('p', {}, _('Frequency lock applied.')));
						window.setTimeout(function() { window.location.reload(); }, 2500);
					}, function(err) {
						ui.addNotification(null, E('p', {}, err.message || _('Lock failed.')), 'danger');
					});
				} }, _('Lock'))
			])
		]);
	});
	// "Fill panel" button — copies this cell's data into the lock panel form
	var fillBtn = E('button', { 'type':'button', 'class':'btn mt-lock-btn mt-fill-btn' }, _('Fill'));
	fillBtn.addEventListener('click', function() {
		if (!applyFill()) {
			ui.addNotification(null, E('p', {}, _('Lock panel not found. Scroll down to "Frequency and cell selection".')), 'warning');
			return;
		}
		var panelRat = (ratLabel === 'NR') ? 'nr' : 'lte';
		ui.addNotification(null, E('p', {}, _('%s cell data filled into %s lock panel. Review and click "Review and apply".')
			.format(bandDisplay, panelRat === 'nr' ? '5G NR' : 'LTE')));
		// Scroll to the lock panel
		var fields = lockPanelFields[panelRat];
		var card = fields && fields.type && fields.type.closest ? fields.type.closest('.mt-freq-card') : null;
		if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
	});
	var thirdBar = (ratLabel === 'LTE' && nb.sinr === '' && nb.rxlev !== undefined)
		? signalBar(nb.rxlev, 'rsrp', 'RXLEV')
		: signalBar(nb.sinr, 'sinr', 'SINR');
	var cardChildren = [
		E('div', { 'class':'mt-lock-cell-head' }, [
			E('span', { 'class':'mt-lock-cell-band' }, bandDisplay + (nb.arfcn ? ' · ' + nb.arfcn : '')),
			E('div', { 'class':'mt-lock-cell-btns' }, [ fillBtn, lockBtn ])
		]),
		signalBar(nb.rsrp, 'rsrp', 'RSRP')
	];
	if (!hideRsqr)
		cardChildren.push(signalBar(nb.rsrq, 'rsrq', 'RSRQ'));
	cardChildren.push(thirdBar);
	if (nb.pci)
		cardChildren.push(E('div', { 'class':'mt-lock-cell-pci' }, 'PCI: ' + nb.pci));
	return E('div', { 'class':'mt-lock-cell-card' }, cardChildren);
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
			'.mt-net-title{font-size:25px;font-weight:720;line-height:1.2;margin:0 0 6px;display:flex;align-items:center;gap:10px}',
			'.mt-net-sub{font-size:13px;color:var(--text-color-medium,#68717d)}',
			'.mt-op-logo{width:28px;height:28px;border-radius:6px;flex-shrink:0;object-fit:contain}',
			'.mt-net-badge{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border-radius:999px;background:#dcf6eb;color:#08775d;font-size:12px;font-weight:700;white-space:nowrap}',
			'.mt-net-badge:before{content:"";width:7px;height:7px;border-radius:50%;background:#17b883}',
			'.mt-net-badge.off{background:#fff0e2;color:#99530a}.mt-net-badge.off:before{background:#e99737}',
			'.mt-net-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 16px}',
			'.mt-net-metric,.mt-net-panel{border:1px solid var(--border-color-medium,#d9dde4);border-radius:13px;background:var(--background-color-high,#fff);box-shadow:0 3px 12px rgba(20,32,50,.04)}',
			'.mt-net-metric{padding:16px}.mt-net-label{font-size:12px;color:var(--text-color-medium,#707985);margin-bottom:6px}',
			'.mt-net-value{font-size:23px;font-weight:720}.mt-net-unit{font-size:12px;color:#747c86;margin-left:5px}',
			'.mt-net-metric-top{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:9px}.mt-net-qual{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap}.mt-net-qual.excellent{background:#dcf6eb;color:#08775d}.mt-net-qual.good{background:#e2f3e4;color:#2f7a3f}.mt-net-qual.fair{background:#fdf0d8;color:#9a6a12}.mt-net-qual.weak{background:#fce4e0;color:#b23b30}.mt-net-qual.unknown{background:var(--background-color-low,#eef1f4);color:#8a939d}',
			'.mt-net-gauge{position:relative;height:7px;border-radius:999px;background:var(--border-color-low,#e3e8ee);overflow:hidden;margin-top:2px}.mt-net-gauge i{display:block;height:100%;min-width:3px;border-radius:inherit;background:#4b94df;transition:width .35s ease}.mt-net-gauge i.excellent{background:linear-gradient(90deg,#0fb783,#13a979)}.mt-net-gauge i.good{background:linear-gradient(90deg,#4bb985,#3fa66f)}.mt-net-gauge i.fair{background:linear-gradient(90deg,#f0b44f,#e4a23a)}.mt-net-gauge i.weak{background:linear-gradient(90deg,#e8756c,#db5b52)}.mt-net-gauge i.unknown{background:var(--border-color-low,#cfd6de)}.mt-net-gauge-scale{display:flex;justify-content:space-between;margin-top:4px;color:var(--text-color-medium,#9099a3);font-size:9px;opacity:.8}',
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
			// Graphical signal bars (mt5700webui reference)
			'.mt-sbar{display:flex;align-items:center;gap:8px;margin:4px 0}.mt-sbar-label{flex:0 0 44px;font-size:11px;font-weight:600;color:var(--text-color-medium,#707985)}.mt-sbar-track{flex:1;height:16px;border-radius:8px;background:#eef1f5;overflow:hidden;min-width:60px}.mt-sbar-fill{height:100%;border-radius:8px;transition:width .35s ease}.mt-sbar-value{flex:0 0 auto;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;min-width:72px;text-align:right}',
			'.mt-sbar.excellent .mt-sbar-fill{background:linear-gradient(90deg,#22c55e,#16a34a)}.mt-sbar.good .mt-sbar-fill{background:linear-gradient(90deg,#3b82f6,#2563eb)}.mt-sbar.fair .mt-sbar-fill{background:linear-gradient(90deg,#f59e0b,#d97706)}.mt-sbar.weak .mt-sbar-fill{background:linear-gradient(90deg,#ef4444,#dc2626)}',
			'.mt-sbar.excellent .mt-sbar-value{color:#15803d}.mt-sbar.good .mt-sbar-value{color:#1d4ed8}.mt-sbar.fair .mt-sbar-value{color:#b45309}.mt-sbar.weak .mt-sbar-value{color:#b91c1c}',
			// SSB beam cards grid
			'.mt-beam-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-top:10px}.mt-beam-card{padding:12px 8px;border-radius:10px;border:1px solid var(--border-color-low,#e8ecf0);text-align:center;transition:border-color .2s ease,box-shadow .2s ease}.mt-beam-card:hover{border-color:#9cc5ee;box-shadow:0 2px 8px rgba(18,100,216,.08)}.mt-beam-id{font-size:11px;color:var(--text-color-medium,#707985);margin-bottom:4px}.mt-beam-rsrp{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}',
			'.mt-beam-card.excellent{background:#f0fdf4;border-color:#bbf7d0}.mt-beam-card.excellent .mt-beam-rsrp{color:#15803d}',
			'.mt-beam-card.good{background:#eff6ff;border-color:#bfdbfe}.mt-beam-card.good .mt-beam-rsrp{color:#1d4ed8}',
			'.mt-beam-card.fair{background:#fffbeb;border-color:#fde68a}.mt-beam-card.fair .mt-beam-rsrp{color:#b45309}',
			'.mt-beam-card.weak{background:#fef2f2;border-color:#fecaca}.mt-beam-card.weak .mt-beam-rsrp{color:#b91c1c}',
			// Lock cell cards grid
			'.mt-lock-cell-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:10px}.mt-lock-cell-card{padding:14px;border-radius:12px;border:1px solid var(--border-color-medium,#d9dde4);background:var(--background-color-high,#fff);transition:border-color .2s ease,box-shadow .2s ease}.mt-lock-cell-card:hover{border-color:#9cc5ee;box-shadow:0 3px 12px rgba(20,32,50,.06)}',
			'.mt-lock-cell-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.mt-lock-cell-band{font-size:12px;font-weight:700;color:var(--text-color-high,#20242a)}.mt-lock-cell-btns{display:flex;gap:6px}.mt-lock-btn{flex:0 0 auto;padding:4px 12px;font-size:11px;border-radius:8px;background:#eef2f6;color:#176bc1;font-weight:700;border:1px solid #c9daf0;cursor:pointer;white-space:nowrap}.mt-lock-btn:hover{background:#dbeafe;border-color:#93c5fd;color:#1d4ed8}.mt-fill-btn{background:#f0fdf4;color:#15803d;border-color:#bbf7d0}.mt-fill-btn:hover{background:#dcfce7;border-color:#86efac;color:#166534}',
			'.mt-lock-cell-pci{margin-top:6px;font-size:10px;color:var(--text-color-medium,#707985);font-variant-numeric:tabular-nums}',
			// SSB serving cell enhanced
			'.mt-ssb-serving{padding:16px;border-radius:12px;background:linear-gradient(135deg,#f8fafc,#f1f5f9);border:1px solid var(--border-color-low,#e8ecf0);margin-bottom:12px}.mt-ssb-serving-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.mt-ssb-serving-title{font-size:13px;font-weight:700;color:var(--text-color-high,#20242a)}.mt-ssb-serving-meta{font-size:11px;color:var(--text-color-medium,#707985);font-variant-numeric:tabular-nums}',
			'@media(max-width:720px){.mt-net-hero{display:block}.mt-net-badge{margin-top:13px}.mt-net-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.mt-net-grid,.mt-freq-grid{grid-template-columns:1fr}.mt-band-options{grid-template-columns:repeat(2,minmax(0,1fr))}.mt-band-apply{display:block}.mt-band-apply .btn{width:100%;margin-top:12px}}',
			'@media(max-width:430px){.mt-band-head{display:block}.mt-band-head .btn{margin-top:10px}.mt-band-options{grid-template-columns:1fr}}'
		].join(''));
	},

	row: function(label, value) {
		// Support both plain-text values and rich DOM nodes (e.g. mcsDetailNode,
		// signalBar).  When value is already a DOM node, render it directly
		// instead of wrapping it inside <strong> – otherwise LuCI's E() helper
		// may toString() the node and emit "[object HTMLElement]".
		var valueNode = isNode(value) ? value : E('strong', {}, String(value || '--'));
		return E('div', { 'class': 'mt-net-row' }, [ E('span', {}, label), valueNode ]);
	},

	metric: function(label, value, unit) {
		return E('div', { 'class': 'mt-net-metric mt-ui-card' }, [
			E('div', { 'class': 'mt-net-label' }, label),
			E('span', { 'class': 'mt-net-value' }, value || '--'),
			value ? E('span', { 'class': 'mt-net-unit' }, unit) : null
		]);
	},

	// Colour-coded metric with a horizontal quality gauge (RSRP/RSRQ/SINR/temp).
	// kind decides thresholds & bar fill percentage; simple and easy to read.
	metricGauge: function(label, kind, rawValue, unit, scaleLow, scaleHigh) {
		var num = parseFloat(rawValue), has = !isNaN(num), pct = 0, cls = 'unknown', ql = '';
		var tags = { excellent:_('Excellent'), good:_('Good'), fair:_('Fair'), weak:_('Weak') };
		if (has) {
			if (kind === 'rsrp') { pct = (num + 120) * 2.5; cls = num >= -80 ? 'excellent' : num >= -90 ? 'good' : num >= -100 ? 'fair' : 'weak'; }
			else if (kind === 'rsrq') { pct = (num + 25) * 4; cls = num >= -10 ? 'excellent' : num >= -15 ? 'good' : num >= -20 ? 'fair' : 'weak'; }
			else if (kind === 'sinr') { pct = (num + 10) * 2.5; cls = num >= 20 ? 'excellent' : num >= 13 ? 'good' : num >= 0 ? 'fair' : 'weak'; }
			else { pct = (num - 20) / 60 * 100; cls = num < 45 ? 'excellent' : num < 55 ? 'good' : num < 65 ? 'fair' : 'weak'; }
			pct = Math.max(4, Math.min(100, pct));
			ql = tags[cls] || '';
		}
		return E('div', { 'class': 'mt-net-metric mt-ui-card' }, [
			E('div', { 'class': 'mt-net-metric-top' }, [
				E('span', { 'class': 'mt-net-label', 'style':'margin:0' }, label),
				E('span', { 'class': 'mt-net-qual ' + cls }, ql || _('No data'))
			]),
			E('div', {}, [
				E('span', { 'class': 'mt-net-value' }, has ? String(rawValue) : '--'),
				has ? E('span', { 'class': 'mt-net-unit' }, unit) : null
			]),
			E('div', { 'class': 'mt-net-gauge' }, [ E('i', { 'class': cls, 'style':'width:' + (has ? pct : 0) + '%' }) ]),
			E('div', { 'class': 'mt-net-gauge-scale' }, [ E('span', {}, scaleLow || ''), E('span', {}, scaleHigh || '') ])
		]);
	},

	// Turn a serving-cell metric {label,value,unit} into a coloured gauge.
	heroGauge: function(m) {
		m = m || { label:'', value:'', unit:'' };
		var scales = {
			RSRP:{ kind:'rsrp', lo:'-120', hi:'-70' }, RSRQ:{ kind:'rsrq', lo:'-25', hi:'-3' },
			SINR:{ kind:'sinr', lo:'-10', hi:'30' }, RSSI:{ kind:'rsrp', lo:'-110', hi:'-50' },
			RXLEV:{ kind:'rsrp', lo:'-110', hi:'-50' }
		};
		var s = scales[m.label] || { kind:'rsrp', lo:'', hi:'' };
		return this.metricGauge(m.label, s.kind, m.value, m.unit ? (' ' + m.unit) : '', s.lo, s.hi);
	},

	// Map English operator name (from AT+COPS) to Chinese name + inline SVG logo.
	operatorInfo: function(name) {
		var n = (name || '').toUpperCase();
		// Some modules reply with the numeric MCC-MNC instead of the operator
		// name (e.g. "+COPS: 0,0,"46000",7").  Normalise those to the alphabetic
		// key so the logo/name branches below still match.
		if (/^4600[02478]$/.test(n)) n = 'CHINA MOBILE';        // CMCC
		else if (/^4600[169]$/.test(n)) n = 'CHINA UNICOM';    // CUCC
		else if (/^460(03|05|11)$/.test(n)) n = 'CHINA TELECOM'; // CTCC
		// China Mobile — blue-green swirl logo
		if (n.indexOf('CHINA MOBILE') !== -1 || n.indexOf('CMCC') !== -1)
			return { name: '中国移动', logo: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0066B3"/><stop offset="100%" stop-color="#00A0E9"/></linearGradient></defs><rect width="40" height="40" rx="8" fill="url(#g)"/><path d="M8 28c0 0 4-12 14-12s12 8 12 8-4 6-12 6S8 28 8 28z" fill="#fff" opacity=".9"/><circle cx="22" cy="23" r="4" fill="#fff"/><path d="M10 14c2-4 7-7 13-6s9 5 10 9c-2-2-5-4-10-4s-11 3-13 1z" fill="#FFE600" opacity=".85"/></svg>') };
		// China Unicom — red "unicom" knot logo
		if (n.indexOf('CHINA UNICOM') !== -1 || n.indexOf('UNICOM') !== -1)
			return { name: '中国联通', logo: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#ED1C24"/><path d="M20 7c-7.2 0-13 5.8-13 13 0 3.6 1.5 6.9 3.9 9.3L20 33l9.1-3.7C31.5 26.9 33 23.6 33 20c0-7.2-5.8-13-13-13zm0 4c5 0 9 4 9 9s-4 9-9 9-9-4-9-9 4-9 9-9z" fill="#fff" opacity=".95"/><path d="M20 14c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6-2.7-6-6-6z" fill="#fff"/></svg>') };
		// China Telecom — blue wave logo
		if (n.indexOf('CHINA TELECOM') !== -1 || n.indexOf('TELECOM') !== -1)
			return { name: '中国电信', logo: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0066B3"/><stop offset="100%" stop-color="#0091DA"/></linearGradient></defs><rect width="40" height="40" rx="8" fill="url(#t)"/><path d="M7 24 Q15 14 25 20 T36 16" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M7 29 Q15 19 27 24 T36 22" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" opacity=".7"/><path d="M7 18 Q15 10 23 14 T34 11" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" opacity=".5"/></svg>') };
		// China Broadnet / 广电 — purple-orange logo
		if (n.indexOf('BROADNET') !== -1 || n.indexOf('GBA') !== -1 || n.indexOf('CHINA BROADCASTING') !== -1)
			return { name: '中国广电', logo: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#6B21A8"/><stop offset="100%" stop-color="#F97316"/></linearGradient></defs><rect width="40" height="40" rx="8" fill="url(#b)"/><text x="20" y="26" text-anchor="middle" fill="#fff" font-size="16" font-weight="bold" font-family="Arial">广</text></svg>') };
		return { name: name || _('Mobile Network'), logo: null };
	},

	// Parse ^LTEFREQLOCK? / ^NRFREQLOCK? raw array into structured lock info.
	// Raw format (from AT manual 13.12/13.13):
	//   LTE: [type, forbidFlag, num, band1, freq1, pci1, band2, freq2, pci2, ...]
	//   NR:  [type, forbidFlag, num, band1, arfcn1, scs1, pci1, band2, arfcn2, scs2, pci2, ...]
	parseLockData: function(rawArr, rat) {
		if (!rawArr || !rawArr.length || rawArr[0] === '' || rawArr[0] === undefined)
			return { type:'0', bands:'', arfcns:'', scs:'', pcis:'' };
		var type = String(rawArr[0] || '0');
		if (type === '0') return { type:'0', bands:'', arfcns:'', scs:'', pcis:'' };
		var num = Math.min(parseInt(rawArr[2] || '0', 10) || 0, 20);
		if (num < 1) return { type:type, bands:'', arfcns:'', scs:'', pcis:'' };
		var bands=[], arfcns=[], scs=[], pcis=[];
		if (rat === 'nr') {
			for (var i = 0; i < num; i++) {
				var base = 3 + i * 4;
				bands.push(rawArr[base] || '');
				arfcns.push(rawArr[base + 1] || '');
				scs.push(rawArr[base + 2] || '');
				pcis.push(rawArr[base + 3] || '');
			}
		} else {
			for (var j = 0; j < num; j++) {
				var b2 = 3 + j * 3;
				bands.push(rawArr[b2] || '');
				arfcns.push(rawArr[b2 + 1] || '');
				pcis.push(rawArr[b2 + 2] || '');
			}
		}
		return {
			type: type,
			bands: bands.filter(Boolean).join(','),
			arfcns: arfcns.filter(Boolean).join(','),
			scs: scs.filter(Boolean).join(','),
			pcis: pcis.filter(Boolean).join(',')
		};
	},

	lockPanel: function(title, rat, lockData) {
		var self = this;
		var parsed = this.parseLockData(Array.isArray(lockData) ? lockData : [], rat);
		var type = E('select', { 'class':'cbi-input-select' }, [E('option',{'value':'3'},_('Band Lock')),E('option',{'value':'1'},_('ARFCN Lock')),E('option',{'value':'2'},_('Cell Lock')),E('option',{'value':'0'},_('Remove Lock'))]);
		type.value = /^(0|1|2|3)$/.test(parsed.type || '') ? parsed.type : '0';
		var bands = E('input', { 'class':'cbi-input-text','placeholder':rat==='nr'?'78,41':'3,8','inputmode':'numeric', 'value':parsed.bands });
		var arfcns = E('input', { 'class':'cbi-input-text','placeholder':rat==='nr'?'630000,520000':'1850,3450','inputmode':'numeric', 'value':parsed.arfcns });
		var scs = E('input', { 'class':'cbi-input-text','placeholder':'1,1','inputmode':'numeric', 'value':parsed.scs });
		var pcis = E('input', { 'class':'cbi-input-text','placeholder':'100,200','inputmode':'numeric', 'value':parsed.pcis });
		// Register fields for "Fill panel" button from cellLockCard
		lockPanelFields[rat] = { type: type, bands: bands, arfcns: arfcns, scs: scs, pcis: pcis };
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
		// LTE (and any NR) neighbour cells from AT^MONNC — surface them as
		// lockable cards so LTE neighbours are visible on the main page too.
		var monnc = parseMonnc(controls.section(raw, 'Neighbour cells') || '');
		var nrMonnc = monnc.filter(function(nb) { return nb.rat === 'NR'; });
		var lteMonnc = monnc.filter(function(nb) { return nb.rat === 'LTE'; });
		// Default the diagnostics neighbour block to 5G (NR). Fall back to LTE
		// only when no NR neighbours are reported, so the panel is never empty.
		var diagNb = nrMonnc.length ? nrMonnc : lteMonnc;
		var extra = [ this.ssbPanel(ssbInfo) ];
		if (diagNb.length)
			extra.push(this.lockNeighbourSection(
				(nrMonnc.length ? _('NR neighbour cells (%d)') : _('LTE neighbour cells (%d)')).format(diagNb.length),
				diagNb, nrMonnc.length ? 'nr' : 'lte'));
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
			extra
		]);
	},

	// Render a panel of lockable neighbour cells from AT^MONNC data.
	// ratType: 'lte' or 'nr'. Used by the main-page diagnostics so LTE
	// neighbours also get the one-click Fill / Lock controls.
	lockNeighbourSection: function(title, list, ratType) {
		var cards = list.map(function(nb, i) {
			var band = arfcnToBand(nb.arfcn, ratType === 'nr' ? 'NR' : 'LTE');
			return cellLockCard(nb, i, ratType, band, ratType === 'nr');
		});
		return E('section', { 'class':'mt-net-panel mt-ui-card', 'style':'margin-top:12px' }, [
			E('h3', {}, title),
			cards.length ? E('div', { 'class':'mt-lock-cell-grid' }, cards)
				: E('div', { 'class':'mt-net-row' }, [ E('span', {}, ''), E('strong', {}, _('None reported')) ])
		]);
	},

	ssbPanel: function(info) {
		if (!info) {
			return E('section', { 'class':'mt-net-panel mt-ui-card', 'style':'margin-top:12px' }, [
				E('h3', {}, _('SSB information')),
				E('div', { 'class':'mt-net-row' }, [ E('span', {}, _('NR SSB measurement')), E('strong', {}, _('Not available')) ])
			]);
		}
		var self = this;
		// Serving cell with colored signal bars (reference: mt5700webui screenshot 4)
		var scBand = arfcnToBand(info.arfcn, 'NR');
		var serving = E('div', { 'class':'mt-ssb-serving' }, [
			E('div', { 'class':'mt-ssb-serving-head' }, [
				E('span', { 'class':'mt-ssb-serving-title' }, _('Serving cell') + (scBand ? ' · ' + scBand : '')),
				E('span', { 'class':'mt-ssb-serving-meta' },
					(info.pci && info.pci !== '65535' ? 'PCI:' + info.pci : '') +
					(info.arfcn && info.arfcn !== '4294967295' ? ' · ARFCN:' + info.arfcn : '')
				)
			]),
			signalBar(ssbValue(info.rsrp, [ '32767' ]), 'rsrp', 'RSRP'),
			signalBar(ssbValue(info.sinr, [ '32767' ]), 'sinr', 'SINR')
		]);
		// Beam cards grid
		var beamGrid;
		if (info.beams.length) {
			beamGrid = E('div', { 'class':'mt-beam-grid' }, info.beams.map(function(b) { return beamCard(b); }));
		} else {
			beamGrid = E('div', { 'class':'mt-net-row' }, [ E('span', {}, _('Serving beams')), E('strong', {}, _('No measurement')) ]);
		}
		// Neighbour cells as lockable card grid
		var nbSection;
		if (info.neighbours.length) {
			nbSection = E('div', {}, [
				E('h4', { 'style':'margin:14px 0 8px;font-size:13px' }, _('NR neighbour cells (%d)').format(info.neighbours.length)),
				E('div', { 'class':'mt-lock-cell-grid' }, info.neighbours.map(function(nb, i) {
					var nbBand = arfcnToBand(nb.arfcn, 'NR');
					return cellLockCard(nb, i, 'nr', nbBand, true);
				}))
			]);
		} else {
			nbSection = E('div', { 'style':'margin-top:10px' }, [ E('h4', { 'style':'font-size:13px;margin:0 0 6px' }, _('NR neighbour cells')), E('div', { 'class':'mt-net-row' }, [ E('span', {}, ''), E('strong', {}, _('None reported')) ]) ]);
		}
		return E('section', { 'class':'mt-net-panel mt-ui-card', 'style':'margin-top:12px' }, [
			E('h3', {}, _('SSB information')),
			serving,
			E('h4', { 'style':'margin:12px 0 8px;font-size:13px' }, _('Serving SSB beams (%d)').format(info.beams.length)),
			beamGrid,
			nbSection
		]);
	},

	render: function(results) {
		var res = results[0] || {}, radioSettings = results[1] || {};
		var raw = res.stdout || '', radioRaw = radioSettings.stdout || '';
		var signal = matchValues(sectionValue(raw, 'Signal'), '^HCSQ');
		var cell = parseServingCell(matchValues(sectionValue(raw, 'Serving cell'), '^MONSC'));
		var registration = matchValues(sectionValue(raw, 'Network registration'), '+CEREG');
		var operator = matchValues(sectionValue(raw, 'Operator'), '+COPS');
		var lteLock = collectFreqLock(sectionValue(raw, 'LTE lock'), '^LTEFREQLOCK');
		var nrLock = collectFreqLock(sectionValue(raw, 'NR lock'), '^NRFREQLOCK');
		var rrc = matchValues(sectionValue(raw, 'RRC state'), '^RRCSTAT');
		var rrcLabels = [ _('Idle'), _('Connected'), _('Inactive'), _('Invalid') ];
		var rrcState = rrc.length > 1 ? (rrcLabels[Number(rrc[1])] || rrc[1]) : '';
		if (rrc.length > 2)
			rrcState += rrc[2] === '98' ? ' · ' + _('Camped') : rrc[2] === '99' ? ' · ' + _('Not camped') : '';
		var registered = registration[1] === '1' || registration[1] === '5';
		var opInfo = this.operatorInfo(operator[2]);
		var operatorName = opInfo.name;
		var tempMatch = raw.match(/^temperature=([\d.]+)/m);
		var temperature = tempMatch ? tempMatch[1] : '';
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
					E('h2', { 'class': 'mt-net-title' }, [
					opInfo.logo ? E('img', { 'class': 'mt-op-logo', 'src': opInfo.logo, 'alt': operatorName }) : null,
					operatorName
				]),
					E('div', { 'class': 'mt-net-sub' }, _('Serving-cell and registration information reported by the modem.'))
				]),
				E('span', { 'class': 'mt-net-badge' + (registered ? '' : ' off') }, registered ? _('Registered') : _('Not registered'))
			]),
			E('div', { 'class': 'mt-net-metrics' }, [
				this.heroGauge(cell.metrics[0]),
				this.heroGauge(cell.metrics[1]),
				this.heroGauge(cell.metrics[2]),
				this.metricGauge(_('Temperature'), 'temp', temperature, '°C', '20', '80')
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
			E('div', { 'class':'mt-freq-grid' }, [this.lockPanel(_('LTE network'),'lte',lteLock),this.lockPanel(_('5G NR network'),'nr',nrLock)])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
