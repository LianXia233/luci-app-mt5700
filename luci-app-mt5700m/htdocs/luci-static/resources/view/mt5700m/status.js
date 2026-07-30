'use strict';
'require view';
'require fs';
'require rpc';
'require mt5700m.controls as controls';

var callManagerStatus = rpc.declare({ object: 'mt5700m', method: 'status', expect: { } });
var callTraffic = rpc.declare({ object: 'mt5700m-traffic', method: 'summary', expect: { } });

function trafficTotal(item) {
	return (Number(item && item.rx) || 0) + (Number(item && item.tx) || 0);
}

function trafficDateKey(item, monthly) {
	var date = item && item.date || {};
	var month = String(date.month || 0).padStart(2, '0');
	var day = String(date.day || 0).padStart(2, '0');
	return monthly ? [ date.year || 0, month ].join('-') : [ date.year || 0, month, day ].join('-');
}

function sortedTraffic(items, monthly) {
	return (items || []).slice().sort(function(a, b) { return trafficDateKey(a, monthly).localeCompare(trafficDateKey(b, monthly)); });
}

function currentTraffic(items, monthly) {
	var now = new Date();
	var key = monthly
		? [ now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0') ].join('-')
		: [ now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0') ].join('-');
	return (items || []).filter(function(item) { return trafficDateKey(item, monthly) === key; })[0] || {};
}

function trafficUpdated(iface) {
	var value = iface && iface.updated;
	if (!value || !value.date || value.date.year < 2024)
		return _('Waiting for data');
	return '%04d-%02d-%02d %02d:%02d'.format(value.date.year || 0, value.date.month || 0,
		value.date.day || 0, value.time && value.time.hour || 0, value.time && value.time.minute || 0);
}

return view.extend({
	load: function() {
		return callManagerStatus().catch(function() { return {}; }).then(function(manager) {
			return Promise.all([
				fs.exec('/usr/sbin/mt5700m-at', [ 'status' ]).catch(function(err) { return { stdout:'', stderr:err.message || String(err) }; }),
				fs.exec('/usr/sbin/mt5700m-at', [ 'advanced', 'session' ]).catch(function(err) { return { stdout:'', stderr:err.message || String(err) }; }),
				callTraffic().catch(function() { return { interfaces:[] }; })
			]).then(function(results) {
				return { native:results[0], session:results[1], traffic:results[2], manager:manager };
			});
		});
	},

	parseStatus: function(res) {
		var data = {};
		(res.native && res.native.stdout || '').trim().split(/\n/).forEach(function(line) {
			var pos = line.indexOf('=');
			if (pos > -1)
				data[line.substring(0, pos)] = line.substring(pos + 1);
		});

		data.reachable = data.connected === '1' ? '1' : '0';
		data.model = data.product_name || 'MT5700M';
		data.temperature = String(data.temperature || '').replace(/[^0-9.-]/g, '');
		data.sysmode_detail = data.network_mode || data.sysmode_detail || data.sysmode || '';
		data.at_port = data.at_port || res.manager.at_port || '';
		data.connected = res.manager.connected === true && data.reachable === '1' && !/^(|NOSERVICE|NO SERVICE|UNKNOWN)$/i.test(data.sysmode || data.sysmode_detail || '') ? '1' : '0';
		if (/^(upgrade|dump|unknown)$/.test(data.usb_state || '')) {
			data.reachable = '0';
			data.connected = '0';
		}
		data.network_interface = res.manager.network || '';
		data.error = res.native && res.native.stderr || '';
		return data;
	},

	styleNode: function() {
		return E('style', {}, [
			'.mt5700m-page{max-width:1120px;margin:0 auto;color:var(--text-color-high,#20242a)}',
			'.mt5700m-hero{position:relative;overflow:hidden;display:flex;justify-content:space-between;align-items:center;gap:20px;padding:22px 24px;margin-bottom:14px;border-radius:16px;background:linear-gradient(135deg,#1264d8 0%,#087eae 58%,#07988e 100%);color:#fff;box-shadow:0 10px 28px rgba(14,92,155,.16)}',
			'.mt5700m-hero:after{content:"";position:absolute;width:210px;height:210px;right:-78px;top:-118px;border:42px solid rgba(255,255,255,.08);border-radius:50%}.mt5700m-hero-copy,.mt5700m-hero-side{position:relative;z-index:1}',
			'.mt5700m-title{margin:0 0 6px;color:#fff;font-size:27px;line-height:1.2}.mt5700m-summary{font-size:13px;line-height:1.5;color:rgba(255,255,255,.84)}',
			'.mt5700m-hero-meta{display:flex;flex-wrap:wrap;gap:7px 18px;margin-top:13px;font-size:11px;color:rgba(255,255,255,.72)}.mt5700m-hero-meta strong{margin-left:5px;color:#fff;font-weight:700}.mt5700m-hero-op{display:inline-flex;align-items:center;gap:6px;margin-left:0}.mt5700m-hero-op img{width:26px;height:26px;border-radius:4px;object-fit:contain;flex:none;background:transparent}.mt5700m-hero-op strong{margin-left:0;font-size:14px;font-weight:750;letter-spacing:.02em}',
			'.mt5700m-hero-side{display:flex;flex-direction:row;align-items:center;gap:10px;flex-wrap:nowrap}.mt5700m-status{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,.16);font-size:12px;font-weight:700;white-space:nowrap}.mt5700m-dot{width:8px;height:8px;border-radius:50%;background:#ffcd57;box-shadow:0 0 0 4px rgba(255,205,87,.18)}.mt5700m-status.online .mt5700m-dot{background:#78f2b0;box-shadow:0 0 0 4px rgba(120,242,176,.18)}',
			'.mt5700m-focus-grid{display:grid;grid-template-columns:1.12fr .88fr 1.18fr;gap:12px;margin-bottom:12px}.mt5700m-focus{display:flex;flex-direction:column;padding:17px 18px}.mt5700m-focus-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:13px}.mt5700m-focus-title{font-size:14px;font-weight:750}.mt5700m-focus-desc{margin-top:3px;color:var(--mt-ui-muted);font-size:10px;line-height:1.4}',
			'.mt5700m-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:999px;background:#eef2f6;color:#6b7480;font-size:10px;font-weight:750;white-space:nowrap}.mt5700m-badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.mt5700m-badge.good,.mt5700m-badge.active{background:#e8f8f1;color:#087c60}.mt5700m-badge.fair{background:#fff5df;color:#9b6500}.mt5700m-badge.weak{background:#fff0ee;color:#b84035}',
			'.mt5700m-signal-value{display:flex;align-items:baseline;gap:6px}.mt5700m-signal-value strong{font-size:31px;letter-spacing:-.04em}.mt5700m-signal-value span{font-size:11px;color:var(--mt-ui-muted)}.mt5700m-signal-bars{display:flex;align-items:flex-end;gap:3px;height:52px;margin:5px 0 13px}.mt5700m-signal-bar{flex:1;min-width:2px;border-radius:2px 2px 1px 1px;background:var(--mt-ui-border);opacity:.55}.mt5700m-signal-bar.on{background:#4b94df;opacity:1}.mt5700m-signal-bars.excellent .on{background:#13a979}.mt5700m-signal-bars.fair .on{background:#e4a23a}.mt5700m-signal-bars.weak .on{background:#db5b52}',
			'.mt5700m-signal-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:auto}.mt5700m-mini{padding:8px 9px;border-radius:9px;background:var(--background-color-low,#f5f7f9)}.mt5700m-mini-top{display:flex;align-items:baseline;justify-content:space-between;gap:4px;margin-bottom:6px}.mt5700m-mini span{color:var(--mt-ui-muted);font-size:9px}.mt5700m-mini strong{font-size:12px;font-variant-numeric:tabular-nums}',
			'.mt5700m-gauge-track{position:relative;height:6px;border-radius:999px;background:var(--mt-ui-border,#e3e8ee);overflow:hidden}.mt5700m-gauge-track i{display:block;height:100%;min-width:3px;border-radius:inherit;background:#4b94df;transition:width .35s ease}.mt5700m-gauge-track i.excellent{background:linear-gradient(90deg,#0fb783,#13a979)}.mt5700m-gauge-track i.good{background:linear-gradient(90deg,#4bb985,#3fa66f)}.mt5700m-gauge-track i.fair{background:linear-gradient(90deg,#f0b44f,#e4a23a)}.mt5700m-gauge-track i.weak{background:linear-gradient(90deg,#e8756c,#db5b52)}.mt5700m-gauge-track i.unknown{background:var(--mt-ui-border,#cfd6de)}.mt5700m-mini-scale{display:flex;justify-content:space-between;margin-top:3px;color:var(--mt-ui-muted);font-size:8px;opacity:.75}',
			'.mt5700m-carrier-main{margin:2px 0 12px}.mt5700m-carrier-main strong{display:block;font-size:29px;line-height:1.15;letter-spacing:-.03em}.mt5700m-carrier-main span{display:block;margin-top:4px;color:var(--mt-ui-muted);font-size:11px}.mt5700m-band-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.mt5700m-band{padding:5px 8px;border-radius:8px;background:#edf5ff;color:#176bc1;font-size:10px;font-weight:700}.mt5700m-carrier-stats{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:auto}.mt5700m-cc-list{display:flex;flex-direction:column;gap:7px;margin-bottom:12px}.mt5700m-cc-row{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border-radius:10px;background:var(--background-color-low,#f5f7f9);border:1px solid var(--mt-ui-border,#e8ecf0)}.mt5700m-cc-role{display:flex;align-items:center;gap:8px}.mt5700m-cc-badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;font-size:9px;font-weight:750;white-space:nowrap}.mt5700m-cc-badge.primary{background:#e8f1ff;color:#176bc1}.mt5700m-cc-badge.secondary{background:#eef2f6;color:#6b7480}.mt5700m-cc-band{font-size:12px;font-weight:700;color:var(--text-color-high,#20242a)}.mt5700m-cc-detail{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:10px;color:var(--mt-ui-muted)}.mt5700m-cc-detail span{font-variant-numeric:tabular-nums}',
			'.mt5700m-ip-list{display:grid;gap:9px}.mt5700m-ip-row{padding:10px 11px;border-radius:10px;background:var(--background-color-low,#f5f7f9)}.mt5700m-ip-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:5px;font-size:10px;color:var(--mt-ui-muted)}.mt5700m-ip-state{font-weight:700;color:#9a6200}.mt5700m-ip-state.on{color:#087c60}.mt5700m-ip-value{font:600 12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.mt5700m-ip-meta{display:flex;justify-content:space-between;gap:10px;margin-top:9px;color:var(--mt-ui-muted);font-size:10px}',
			'.mt5700m-card-link{display:inline-flex;align-items:center;gap:5px;margin-top:auto;padding-top:12px;color:#176bc1;font-size:10px;font-weight:700;text-decoration:none}.mt5700m-card-link:after{content:"›";font-size:16px;line-height:10px}',
			'.mt5700m-info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}.mt5700m-info{display:flex;flex-direction:column;padding:17px 18px}.mt5700m-info-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:13px}.mt5700m-info-title{font-size:14px;font-weight:750}.mt5700m-info-desc{margin-top:3px;color:var(--mt-ui-muted);font-size:10px;line-height:1.4}.mt5700m-info-list{display:flex;flex-direction:column;flex:1;justify-content:center}.mt5700m-info-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:8px 0;border-bottom:1px solid var(--mt-ui-border-soft,#edf0f4);font-size:12px}.mt5700m-info-row:last-child{border-bottom:0}.mt5700m-info-row span{color:var(--mt-ui-muted)}.mt5700m-info-row strong{text-align:right;word-break:break-all;font-weight:600;font-variant-numeric:tabular-nums}',
			'.mt5700m-traffic{padding:18px;margin-bottom:12px}.mt5700m-traffic-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px}.mt5700m-traffic-head h3{margin:0 0 4px;font-size:16px}.mt5700m-traffic-head p{margin:0;color:var(--mt-ui-muted);font-size:10px}.mt5700m-traffic-side{text-align:right}.mt5700m-updated{color:var(--mt-ui-muted);font-size:10px;white-space:nowrap}.mt5700m-legend{display:flex;justify-content:flex-end;gap:10px;margin-top:5px;color:var(--mt-ui-muted);font-size:9px}.mt5700m-legend span:before{content:"";display:inline-block;width:7px;height:3px;margin-right:4px;border-radius:9px;background:#337de8;vertical-align:middle}.mt5700m-legend span:last-child:before{background:#16a085}',
			'.mt5700m-traffic-layout{display:grid;grid-template-columns:repeat(3,minmax(0,.62fr)) minmax(300px,1.8fr);gap:10px}.mt5700m-traffic-stat{padding:13px;border-radius:11px;background:var(--background-color-low,#f5f7f9)}.mt5700m-traffic-label{font-size:10px;color:var(--mt-ui-muted);margin-bottom:6px}.mt5700m-traffic-value{font-size:18px;font-weight:750;letter-spacing:-.02em}.mt5700m-traffic-split{margin-top:5px;color:var(--mt-ui-muted);font-size:9px;line-height:1.45}',
			'.mt5700m-days{display:flex;flex-direction:column;justify-content:center;gap:6px;padding:2px 0 2px 8px}.mt5700m-day{display:grid;grid-template-columns:42px minmax(80px,1fr) 112px;align-items:center;gap:8px;font-size:9px}.mt5700m-date{color:var(--mt-ui-muted);font-weight:650}.mt5700m-bars{display:flex;flex-direction:column;gap:2px}.mt5700m-bar{height:4px;border-radius:999px;background:var(--background-color-low,#eef1f5);overflow:hidden}.mt5700m-bar i{display:block;height:100%;min-width:2px;border-radius:inherit;background:#337de8}.mt5700m-bar.tx i{background:#16a085}.mt5700m-values{text-align:right;font-variant-numeric:tabular-nums;color:var(--mt-ui-muted)}',
			'.mt5700m-shortcuts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.mt5700m-shortcut{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;color:inherit;text-decoration:none}.mt5700m-shortcut strong{display:block;font-size:12px}.mt5700m-shortcut span{display:block;margin-top:3px;color:var(--mt-ui-muted);font-size:9px;line-height:1.4}.mt5700m-shortcut b{color:#176bc1;font-size:20px}.mt5700m-alert{margin-bottom:12px}',
		'.mt5700m-webui-cta{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:999px;text-decoration:none!important;color:#fff;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.28);cursor:pointer;transition:background .15s ease,transform .12s ease;white-space:nowrap;font-size:0;-webkit-tap-highlight-color:transparent}.mt5700m-webui-cta:hover{background:rgba(255,255,255,.30);transform:translateY(-1px)}.mt5700m-webui-cta:active{transform:scale(.96)}.mt5700m-webui-cta *{text-decoration:none!important}.mt5700m-webui-cta-icon{font-size:15px;line-height:1}.mt5700m-webui-cta-text strong{font-size:12px;font-weight:700;letter-spacing:.1px}.mt5700m-webui-cta-text span{display:none}.mt5700m-webui-cta b{font-size:13px;font-weight:700;margin-left:2px;opacity:.8}',
			'.mt5700m-refresh{border-color:rgba(255,255,255,.30)!important;background:rgba(255,255,255,.10)!important;color:#fff!important}',
			'@media(max-width:900px){.mt5700m-focus-grid{grid-template-columns:1fr 1fr}.mt5700m-address-card{grid-column:1/-1;min-height:auto}.mt5700m-traffic-layout{grid-template-columns:repeat(3,1fr)}.mt5700m-days{grid-column:1/-1;padding:8px 0 0}}',
			'@media(max-width:650px){.mt5700m-hero{display:block}.mt5700m-hero-side{flex-direction:row;flex-wrap:wrap;align-items:flex-start;margin-top:14px;gap:8px}.mt5700m-focus-grid,.mt5700m-shortcuts,.mt5700m-info-grid{grid-template-columns:1fr}.mt5700m-address-card{grid-column:auto}.mt5700m-focus{min-height:auto}.mt5700m-traffic-layout{grid-template-columns:1fr}.mt5700m-days{grid-column:auto}.mt5700m-day{grid-template-columns:38px 1fr}.mt5700m-values{grid-column:2;text-align:left}.mt5700m-traffic-head{display:block}.mt5700m-updated{margin-top:7px}}'
		].join(''));
	},

	signalQuality: function(kind, value) {
		var percentage, levels, index;
		if (isNaN(value))
			return { label:_('No data'), cls:'unknown', percentage:0 };
		if (kind === 'rsrp') { percentage = (value + 120) * 2.5; levels = [ -80, -90, -100 ]; }
		else if (kind === 'rsrq') { percentage = (value + 25) * 4; levels = [ -10, -15, -20 ]; }
		else { percentage = (value + 10) * 2.5; levels = [ 20, 13, 0 ]; }
		index = value >= levels[0] ? 0 : value >= levels[1] ? 1 : value >= levels[2] ? 2 : 3;
		return {
			label:[ _('Excellent'), _('Good'), _('Fair'), _('Weak') ][index],
			cls:[ 'excellent', 'good', 'fair', 'weak' ][index],
			percentage:Math.max(0, Math.min(100, percentage))
		};
	},

	carrierInfo: function(data) {
		var count = parseInt(data.carrier_count || '0', 10) || 0;
		var carriers = [], parts, i;
		for (i = 1; i <= count; i++) {
			parts = String(data['carrier_' + i] || '').split('|');
			if (parts.length < 8) continue;
			carriers.push({ radio:parts[0], band:parts[1], arfcn:parts[2], dlFreq:parts[3], dlBandwidth:parts[4], ulFreq:parts[6], ulBandwidth:parts[7] });
		}
		return {
			available:carriers.length > 0,
			active:data.ca_active === '1' && carriers.length > 1,
			dual:data.dc_active === '1', mode:data.ca_mode || '', count:carriers.length,
			dlBandwidth:data.ca_dl_bandwidth || '', ulBandwidth:data.ca_ul_bandwidth || '', carriers:carriers
		};
	},

	// Small colour-coded horizontal gauge for a single scalar metric.
	// kind: 'rsrq' | 'sinr' | 'temp' — decides the good/fair/weak thresholds.
	metricGauge: function(label, kind, rawValue, unit, scaleLow, scaleHigh) {
		var num = parseFloat(rawValue), has = !isNaN(num), pct = 0, cls = 'unknown';
		if (has) {
			if (kind === 'rsrq') { pct = (num + 25) * 4; cls = num >= -10 ? 'excellent' : num >= -15 ? 'good' : num >= -20 ? 'fair' : 'weak'; }
			else if (kind === 'sinr') { pct = (num + 10) * 2.5; cls = num >= 20 ? 'excellent' : num >= 13 ? 'good' : num >= 0 ? 'fair' : 'weak'; }
			else { pct = (num - 20) / 60 * 100; cls = num < 45 ? 'excellent' : num < 55 ? 'good' : num < 65 ? 'fair' : 'weak'; }
			pct = Math.max(4, Math.min(100, pct));
		}
		return E('div', { 'class':'mt5700m-mini' }, [
			E('div', { 'class':'mt5700m-mini-top' }, [ E('span', {}, label), E('strong', {}, has ? (String(rawValue) + (unit || '')) : '--') ]),
			E('div', { 'class':'mt5700m-gauge-track' }, [ E('i', { 'class':cls, 'style':'width:' + (has ? pct : 0) + '%' }) ]),
			E('div', { 'class':'mt5700m-mini-scale' }, [ E('span', {}, scaleLow || ''), E('span', {}, scaleHigh || '') ])
		]);
	},

	signalCard: function(data) {
		var rsrp = parseFloat(data.rsrp), rsrq = parseFloat(data.rsrq), sinr = parseFloat(data.sinr);
		var quality = this.signalQuality('rsrp', rsrp), active = isNaN(rsrp) ? 0 : Math.max(1, Math.round(quality.percentage / 100 * 14));
		var bars = [], i;
		for (i = 0; i < 14; i++)
			bars.push(E('span', { 'class':'mt5700m-signal-bar' + (i < active ? ' on' : ''), 'style':'height:%dpx'.format(8 + i * 3) }));
		return E('section', { 'class':'mt5700m-focus mt-ui-card' }, [
			E('div', { 'class':'mt5700m-focus-head' }, [
				E('div', {}, [ E('div', { 'class':'mt5700m-focus-title' }, _('Signal')), E('div', { 'class':'mt5700m-focus-desc' }, _('Current radio quality at a glance')) ]),
				E('span', { 'class':'mt5700m-badge ' + quality.cls }, quality.label)
			]),
			E('div', { 'class':'mt5700m-signal-value' }, [ E('strong', {}, isNaN(rsrp) ? '--' : String(data.rsrp)), E('span', {}, 'RSRP · dBm') ]),
			E('div', { 'class':'mt5700m-signal-bars ' + quality.cls, 'aria-hidden':'true' }, bars),
			E('div', { 'class':'mt5700m-signal-meta' }, [
				this.metricGauge('RSRQ', 'rsrq', data.rsrq, ' dB', '-25', '-3'),
				this.metricGauge('SINR', 'sinr', data.sinr, ' dB', '-10', '30'),
				this.metricGauge(_('Temperature'), 'temp', data.temperature, '°C', '20', '80')
			])
		]);
	},

	carrierCard: function(info) {
		var active = info.active || info.dual;
		var badge = !info.available ? _('Unavailable') : info.active ? _('Aggregating') : info.dual ? _('Dual connectivity') : _('Single carrier');
		var headline = !info.available ? '--' : info.active ? info.count + 'CA' : info.dual ? (info.mode || 'EN-DC') : (info.carriers[0] ? info.carriers[0].band : _('Single carrier'));
		// Expand every component carrier when more than one is active so the
		// serving cell (PCell + SCells) is fully listed (not just a summary).
		var ccList = null;
		if (info.carriers.length > 1) {
			ccList = E('div', { 'class':'mt5700m-cc-list' }, info.carriers.map(function(item, idx) {
				var role = idx === 0 ? _('PCell') : _('SCell %d').format(idx);
				return E('div', { 'class':'mt5700m-cc-row' }, [
					E('div', { 'class':'mt5700m-cc-role' }, [
						E('span', { 'class':'mt5700m-cc-badge ' + (idx === 0 ? 'primary' : 'secondary') }, role),
						E('span', { 'class':'mt5700m-cc-band' }, item.radio + ' · ' + item.band)
					]),
					E('div', { 'class':'mt5700m-cc-detail' }, [
						item.arfcn ? E('span', {}, 'ARFCN ' + item.arfcn) : null,
						E('span', {}, _('DL') + ' ' + (item.dlFreq ? item.dlFreq + ' MHz' : '--') + ' / ' + (item.dlBandwidth ? item.dlBandwidth + ' MHz' : '--')),
						E('span', {}, _('UL') + ' ' + (item.ulFreq ? item.ulFreq + ' MHz' : '--') + ' / ' + (item.ulBandwidth ? item.ulBandwidth + ' MHz' : '--'))
					].filter(Boolean))
				]);
			}));
		}
		return E('section', { 'class':'mt5700m-focus mt-ui-card' }, [
			E('div', { 'class':'mt5700m-focus-head' }, [
				E('div', {}, [ E('div', { 'class':'mt5700m-focus-title' }, _('Carrier status')), E('div', { 'class':'mt5700m-focus-desc' }, _('Carrier aggregation and bandwidth')) ]),
				E('span', { 'class':'mt5700m-badge' + (active ? ' active' : '') }, badge)
			]),
			E('div', { 'class':'mt5700m-carrier-main' }, [ E('strong', {}, headline), E('span', {}, info.mode || _('Mobile network')) ]),
			E('div', { 'class':'mt5700m-band-list' }, info.carriers.length ? info.carriers.map(function(item) { return E('span', { 'class':'mt5700m-band' }, item.radio + ' · ' + item.band); }) : E('span', { 'class':'mt5700m-focus-desc' }, _('Current carrier information is unavailable.'))),
			ccList,
			E('div', { 'class':'mt5700m-carrier-stats' }, [
				E('div', { 'class':'mt5700m-mini' }, [ E('span', {}, _('Downlink bandwidth')), E('strong', {}, info.dlBandwidth ? info.dlBandwidth + ' MHz' : '--') ]),
				E('div', { 'class':'mt5700m-mini' }, [ E('span', {}, _('Uplink bandwidth')), E('strong', {}, info.ulBandwidth ? info.ulBandwidth + ' MHz' : '--') ])
			]),
			E('a', { 'class':'mt5700m-card-link', 'href':L.url('admin/modem/mt5700m/network') }, _('View radio and cell details'))
		]);
	},

	addressCard: function(session) {
		var active = session.ipv4Connected || session.ipv6Connected;
		return E('section', { 'class':'mt5700m-focus mt5700m-address-card mt-ui-card' }, [
			E('div', { 'class':'mt5700m-focus-head' }, [
				E('div', {}, [ E('div', { 'class':'mt5700m-focus-title' }, _('Mobile IP')), E('div', { 'class':'mt5700m-focus-desc' }, _('Addresses assigned by the mobile network')) ]),
				E('span', { 'class':'mt5700m-badge' + (active ? ' active' : '') }, active ? _('Active') : _('Disconnected'))
			]),
			E('div', { 'class':'mt5700m-ip-list' }, [
				E('div', { 'class':'mt5700m-ip-row' }, [ E('div', { 'class':'mt5700m-ip-head' }, [ E('span', {}, 'IPv4'), E('span', { 'class':'mt5700m-ip-state' + (session.ipv4Connected ? ' on' : '') }, session.ipv4Connected ? _('Connected') : _('Not assigned')) ]), E('div', { 'class':'mt5700m-ip-value' }, session.ipv4Address || '--') ]),
				E('div', { 'class':'mt5700m-ip-row' }, [ E('div', { 'class':'mt5700m-ip-head' }, [ E('span', {}, 'IPv6'), E('span', { 'class':'mt5700m-ip-state' + (session.ipv6Connected ? ' on' : '') }, session.ipv6Connected ? _('Connected') : _('Not assigned')) ]), E('div', { 'class':'mt5700m-ip-value' }, session.ipv6Address || '--') ])
			]),
			E('div', { 'class':'mt5700m-ip-meta' }, [ E('span', {}, session.capability || '--'), E('span', {}, 'MTU ' + (session.mtu || '--')) ]),
			E('a', { 'class':'mt5700m-card-link', 'href':L.url('admin/modem/mt5700m/connection') }, _('View connection details'))
		]);
	},

	// Robust node detector: some LuCI runtimes (older L.dom) build nodes that
	// are NOT `instanceof HTMLElement` but still have nodeType === 1.  Using
	// only `instanceof HTMLElement` (as v2.3.9 did) mis-classifies those nodes
	// as scalars and toString()s them into "[object HTMLElement]".  nodeType===1
	// is the reliable cross-runtime test.
	isNode: function(v) {
		return v && typeof v === 'object' && (v instanceof HTMLElement || v.nodeType === 1);
	},

	infoRow: function(label, value) {
		var valueNode = this.isNode(value) ? value : E('strong', {}, (value == null || value === '') ? '--' : String(value));
		return E('div', { 'class':'mt5700m-info-row' }, [ E('span', {}, label), valueNode ]);
	},

	moduleCard: function(data) {
		return E('section', { 'class':'mt5700m-info mt-ui-card' }, [
			E('div', { 'class':'mt5700m-info-head' }, [
				E('div', {}, [ E('div', { 'class':'mt5700m-info-title' }, _('Module')), E('div', { 'class':'mt5700m-info-desc' }, _('Identity and firmware')) ]),
				E('span', { 'class':'mt5700m-badge active' }, data.product_name || 'MT5700M')
			]),
			E('div', { 'class':'mt5700m-info-list' }, [
				this.infoRow(_('Manufacturer'), data.manufacturer),
				this.infoRow(_('Model'), data.model),
				this.infoRow(_('Firmware'), data.revision),
				this.infoRow('IMEI', data.imei),
				this.infoRow(_('AT port'), data.at_port || data.network_interface)
			])
		]);
	},

	simCard: function(data) {
		var simState = data.sim || '';
		var simOk = /READY/i.test(simState);
		// Format AMBR rate as "Down XXX Mbps / Up XXX Mbps"
		var downRate = data.ambr_down_mbps ? parseFloat(data.ambr_down_mbps) : NaN;
		var upRate = data.ambr_up_mbps ? parseFloat(data.ambr_up_mbps) : NaN;
		var rateText = (!isNaN(downRate) && !isNaN(upRate))
			? _('Down %s / Up %s').format(
				downRate >= 1 ? downRate.toFixed(0) + ' Mbps' : (downRate * 1000).toFixed(0) + ' Kbps',
				upRate >= 1 ? upRate.toFixed(0) + ' Mbps' : (upRate * 1000).toFixed(0) + ' Kbps')
			: '';
		return E('section', { 'class':'mt5700m-info mt-ui-card' }, [
			E('div', { 'class':'mt5700m-info-head' }, [
				E('div', {}, [ E('div', { 'class':'mt5700m-info-title' }, _('SIM & Subscription')), E('div', { 'class':'mt5700m-info-desc' }, _('Subscriber identity and service plan')) ]),
				E('span', { 'class':'mt5700m-badge' + (simOk ? ' active' : '') }, simOk ? _('Ready') : (simState || _('Unknown')))
			]),
			E('div', { 'class':'mt5700m-info-list' }, [
				this.infoRow(_('Operator'), data.operator),
				this.infoRow(_('Access technology'), data.sysmode_detail || data.sysmode),
				this.infoRow(_('APN'), data.active_apn),
				this.infoRow(_('QCI'), data.qci ? 'QCI ' + data.qci : ''),
				this.infoRow('ICCID', data.iccid),
				this.infoRow('IMSI', data.imsi),
				this.infoRow(_('Phone number'), data.phone_number_state === 'not_stored' ? _('Not stored') : data.phone_number),
				rateText ? this.infoRow(_('Subscription rate'), rateText) : null
			].filter(Boolean))
		]);
	},

	trafficPanel: function(report, interfaceName) {
		var iface = (report.interfaces || []).filter(function(item) { return item.name === interfaceName; })[0] ||
			(report.interfaces || []).filter(function(item) { return item.name === 'eth2'; })[0] || { traffic:{} };
		var traffic = iface.traffic || {}, days = sortedTraffic(traffic.day, false), months = sortedTraffic(traffic.month, true);
		var today = currentTraffic(days, false), month = currentTraffic(months, true), lifetime = traffic.total || {};
		var recentDays = days.slice(-7).reverse(), maximum = Math.max.apply(Math, recentDays.map(trafficTotal).concat([ 1 ]));
		var dayRows = recentDays.length ? recentDays.map(function(item) {
			var rx = Number(item.rx) || 0, tx = Number(item.tx) || 0;
			return E('div', { 'class':'mt5700m-day' }, [
				E('span', { 'class':'mt5700m-date' }, trafficDateKey(item, false).substring(5)),
				E('div', { 'class':'mt5700m-bars' }, [ E('div', { 'class':'mt5700m-bar' }, E('i', { 'style':'width:' + Math.max(1, rx / maximum * 100).toFixed(1) + '%' })), E('div', { 'class':'mt5700m-bar tx' }, E('i', { 'style':'width:' + Math.max(1, tx / maximum * 100).toFixed(1) + '%' })) ]),
				E('span', { 'class':'mt5700m-values' }, controls.formatBytes(trafficTotal(item)))
			]);
		}) : [ E('div', { 'class':'mt5700m-focus-desc' }, _('Statistics appear after the MT5700M data interface has carried traffic for a few minutes.')) ];
		function stat(label, item) {
			return E('div', { 'class':'mt5700m-traffic-stat' }, [ E('div', { 'class':'mt5700m-traffic-label' }, label), E('div', { 'class':'mt5700m-traffic-value' }, controls.formatBytes(trafficTotal(item))), E('div', { 'class':'mt5700m-traffic-split' }, _('Download %s · Upload %s').format(controls.formatBytes(item.rx), controls.formatBytes(item.tx))) ]);
		}
		return E('section', { 'class':'mt5700m-traffic mt-ui-card' }, [
			E('div', { 'class':'mt5700m-traffic-head' }, [ E('div', {}, [ E('h3', {}, _('Traffic Statistics')), E('p', {}, _('Local usage recorded only for the MT5700M data interface')) ]), E('div', { 'class':'mt5700m-traffic-side' }, [ E('div', { 'class':'mt5700m-updated' }, _('Last updated') + ' · ' + trafficUpdated(iface)), E('div', { 'class':'mt5700m-legend' }, [ E('span', {}, _('Download')), E('span', {}, _('Upload')) ]) ]) ]),
			E('div', { 'class':'mt5700m-traffic-layout' }, [ stat(_('Today'), today), stat(_('This month'), month), stat(_('All-time total'), lifetime), E('div', { 'class':'mt5700m-days' }, dayRows) ])
		]);
	},

	shortcut: function(title, description, path) {
		return E('a', { 'class':'mt5700m-shortcut mt-ui-card', 'href':L.url(path) }, [ E('div', {}, [ E('strong', {}, title), E('span', {}, description) ]), E('b', {}, '›') ]);
	},

	// Map English operator name (from AT+COPS) to Chinese name + inline SVG logo.
	operatorInfo: function(name) {
		// Collapse runs of whitespace: MT5700M firmware reports the long name
		// with a double space (e.g. "CHINA  MOBILE"), which would defeat the
		// single-space indexOf matches below.
		var n = (name || '').toUpperCase().replace(/\s+/g, ' ').trim();
		// Some firmwares emit the full +COPS tuple (e.g. "0,2,,46000,7") or a
		// numeric MCC-MNC instead of the operator name.  Strip to the 5–6 digit
		// MCC-MNC token so the normalisation below still matches.
		var mccMnc = n.match(/(\d{5,6})/);
		if (mccMnc && n.indexOf(',') !== -1) n = mccMnc[1];
		// Some modules reply with the numeric MCC-MNC instead of the operator
		// name.  Normalise those to the alphabetic key for logo/name matching.
		if (/^4600[02478]$/.test(n)) n = 'CHINA MOBILE';        // CMCC
		else if (/^4600[169]$/.test(n)) n = 'CHINA UNICOM';    // CUCC
		else if (/^460(03|05|11)$/.test(n)) n = 'CHINA TELECOM'; // CTCC
		else if (/^46015$/.test(n)) n = 'CHINA BROADNET';      // CBN
		if (n.indexOf('CHINA MOBILE') !== -1 || n.indexOf('CMCC') !== -1)
			return { name: '中国移动', logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABu0lEQVR4nG1TO07DQBB9jiA0RCQI0ca5wdIADSE5gckJIELUELfmE6S4daBOESQOAD5BfgUolTkB0CNkEAWfBj17NiyBaVaa2ffm82Ys/Gd+dABgH4AtnhjAOTzVnP5qTQHzAK4AVCYgoA9ACSF9VXiKb2IZA8xsPQETVBLACQBHyKLkT5rIqMCPlIAZuADQMCqBABl7EFJbV5KRD9NgXQmtDk+twFMlIbDlZQJYwajYdofhnQTOBKwkUyMoO5F8ZrzfGncGz+/LjsTDzOvnYj4oO5syYRNcDcpOLD6thjpc3XPyc099qdjJNG+7DKpgVOwagyJYSWY9sLq78Vhg/Hhtt5LLxmwDFvyol8vG8en6ti1gzmALQNfYgYY7DBlLkiQVA+ro5jIlYBaWRWZpQVvSijsMzUFHHCorfvtasKkCo3H8sVRpjTuhDFJLR7ApceKDHzXdYTiYn30Z6D3oGfoyQ138O0YrKRhoA6A/hqcKMxKsSZZUZz+6F0LdznWyDyY4JTNuIV1PkjAT94Ja09gWF0xLzHgNnhIV/h6T7ldLysHykOij/gRPjuk3wQ8Rl0qDaMzGc9YDntg3CCWtdUcoEzEAAAAASUVORK5CYII=' };
		if (n.indexOf('CHINA UNICOM') !== -1 || n.indexOf('UNICOM') !== -1)
			return { name: '中国联通', logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABU0lEQVR4nK2TQU7DQAxFnyddt2kr9iyA5Dj0KJyEo8BxkhYJ9og26j5j9CeTttlVFEtRxo79/f2dMYDWymfgFbjnOvsCXirv3i0Xv/E32wjg87Kzu/MUD5g5bVinWBV/cDe2YYmZTZhYa6WPXnSnjh3bYpl8AclUmPz+QBNKwgXIbELIYmbRA0GQJ1bjecgpziUtC3cMgSpRqbV36KBuMrHCoLFSrzSGMA1npoLKhxl3xWocBoGGxEJY8jwVCuCx3w8a2Qpzd2+tTMmPvk8F6lQQeIjfyf8Id/TEgRmwsxWRSOVdbnGLNdLAe48xiok3Vp59lunRWTF9U87JZ+EzzdTaeiKiNqC4aCalB+nyNkhaDSJqjVmYJJZF6v5Ia/MEUmdNpJHg6nikKeYYRWooiNlkHh8kMRv3PPrKzjHlXPyM//Ir33SZgq6kDvmKXmvK3aj2F3NoxdeFZE2BAAAAAElFTkSuQmCC' };
		if (n.indexOf('CHINA TELECOM') !== -1 || n.indexOf('TELECOM') !== -1)
			return { name: '中国电信', logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEeElEQVR4nMVWbUyTVxR++vJWavkqBSuDyqfTwKSdKIx9CVExcSYDDCYywshkkizGZdkWp2FjMehYRsxCtjESt7n5Rx0O4kIQM5ygbAoKMpAqfvIpUmQFFIqU0uVeae3b20KLLD5J2/uee997np773HOOSJFdZsIzBE++tMPjz8S5wkcC7mk2kIjdoPSTghOJBHZ/L3dkr41AQpQCcs8Fs0fAVRB/uZtfwO7UKHi48+gcGMV7By/i5OU+Ov9g3IDi7auxgOcwZTKh8ZYOv57vxMHqWxgeMwj24px1ul4VAE/JY74Fb6mRv1VFnROELPJAxZ4EpMYp6fMjwxRSvjqLI3Wd9Dl2qRyFmSvRVZKMrMQw4Z9RZJeZZtLAm6uDkLdlBVaFy7Fxfw0ejk/iXP56u2tH9AZEf1iJrvtjFlta/BKUfvSaYF3WtxdwuPbOzBpYHuiN6ry1OPHJGuo0ZlcVqpr7UJj5ot31PYNj8JKI8WWGcP74hW5G5AeyVoJ3EznWwLvrIlD0ziqIeRF2/tiI705dh8kEGoX4Zf7M+s+OtmDfb22IDPJm5pb4SeHv7c6IVCmXYmzCyBLYl66iAjNOmbC58Bx+v9RrmXs7QXh+BFd7R/BFmcYytoYbJ8L3ObHMLSF/hohRzHPCI9iVHEmdE3xd0S5wTpAcG8QQ+KXmDlW6LdzFHH7eEY9NMYHM3N/tA9CNTtAxbzaqQmQoyFBbFpWe7xK8RJROPraobLrL2KKDZdR5TLgv7CH3SItlzJsHeWkrBKGKUvqg4eag5fmV5ezZE3G2dQ8LSO5JjaJJyCwyW+wtvYJajZYlsEEdIFhYtC0GBuMUvcskxOoQGbPZtd4RKtQN6kBkJYQhJU5Jz90RCso12Fvaaj8PTB7bavflPp0ef17pR0y4nFH50OgEFZI5ITkCidSOHy7Ru28NkgcsbzZ36Og1s8VzvguR8Xqo3Y1lHjPnebNGdv7UiNv9D+3Oc+ZB3jFhaJ4WddcGkJR/BpsKah06J+CtmW4rrkdJTiwtInMBScVl9d0oPnUDF2/+69Q7vPXDoTO3UdOmxe7USGx5ORi+ToSYpODq1nuobOpDRWMv9BNGl0iLHBUjco3IVSR3erGPBO+/sYzJA0WV7fjgUBPmCoEIbTFpNKGlc4h+zHnAloBMOnuEZgPv7MK7Oj1jC/aXMralAV5IiQtCz6AeR/963A/MBM5ZAh3aUcYWqmBT8/50FW0+xA4y4ZwJ/NOpY2xhCk/4eQlLbdzzfvS3uWNongl02N/wpWmHBKRBDV3kQTOkpmd4fgncf/AIrV0siSTVkxqS/moI/f2j5R7tJ+aVAIG567VG5ppQeC0U0/qfkxRBbeUNPXAWvNMrp5sP0rRYg2igKjeRJiByA0ijUV7vPAHOFQLkXE+39jN2kiPWRS+m429OXse4wflsyMFFfHz4st0WzJyWC09cdWk/zlUCpGx/atVSmUGOIO1AHa39/ysBTHc220saaJklwTir0SLx89Oov/GkhXMWtBjNhcR84T/wVJ3gylHtAwAAAABJRU5ErkJggg==' };
		if (n.indexOf('BROADNET') !== -1 || n.indexOf('GBA') !== -1 || n.indexOf('CHINA BROADCASTING') !== -1 || n.indexOf('CBN') !== -1)
			return { name: '中国广电', logo: 'data:image/png;base64,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' };
		return { name: name || _('Mobile Network'), logo: null };
	},

	render: function(res) {
		var data = this.parseStatus(res), session = controls.parseSession(res.session && res.session.stdout || '');
		var reachable = data.reachable === '1', connected = data.connected === '1', carrierInfo = this.carrierInfo(data);
		var opInfo = this.operatorInfo(data.operator);
		var operator = opInfo.name;
		if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(operator)) operator = '';
		var usbNames = { upgrade:_('Upgrade mode'), dump:_('Dump mode'), unknown:_('Unknown USB mode') };
		var abnormalUsb = data.usb_state === 'upgrade' || data.usb_state === 'dump' || data.usb_state === 'unknown';
		// Override raw AT+COPS operator name with Chinese-mapped version for SIM card
		data.operator = operator;
		return E('div', { 'class':'mt5700m-page mt-ui-page' }, [
			this.styleNode(), controls.styleNode(),
			data.error ? E('div', { 'class':'alert-message warning mt5700m-alert' }, data.error) : null,
			res.session && res.session.stderr ? E('div', { 'class':'alert-message warning mt5700m-alert' }, res.session.stderr) : null,
			abnormalUsb ? E('div', { 'class':'alert-message warning mt5700m-alert' }, _('The MT5700M is in %s. Mobile data and AT management are unavailable until normal mode returns.').format(usbNames[data.usb_state])) : null,
			E('section', { 'class':'mt5700m-hero' }, [
				E('div', { 'class':'mt5700m-hero-copy' }, [
				E('h2', { 'class':'mt5700m-title' }, [
					_('MT5700M Module')
				]),
				E('div', { 'class':'mt5700m-summary' }, !reachable ? _('The modem did not respond. Check the module connection.') : connected ? _('Mobile network is connected and ready.') : _('The module is online, but mobile data is not connected.')),
				E('div', { 'class':'mt5700m-hero-meta' }, [ E('span', { 'class':'mt5700m-hero-op' }, [ opInfo.logo ? E('img', { 'src': opInfo.logo, 'alt': operator }) : null, E('strong', {}, operator || '--') ]), E('span', {}, [ _('Network Mode'), E('strong', {}, data.sysmode_detail || data.sysmode || '--') ]), E('span', {}, [ _('Network interface'), E('strong', {}, data.network_interface || '--') ]) ])
				]),
				E('div', { 'class':'mt5700m-hero-side' }, [
					E('div', { 'class':'mt5700m-status' + (connected ? ' online' : '') }, [ E('span', { 'class':'mt5700m-dot' }), connected ? _('Connected') : reachable ? _('Module online') : _('Unavailable') ]),
					E('a', { 'class':'mt5700m-webui-cta', 'href':'/5700/', 'target':'_blank', 'rel':'noopener' }, [
						E('span', { 'class':'mt5700m-webui-cta-icon' }, '🌐'),
						E('span', { 'class':'mt5700m-webui-cta-text' }, [ E('strong', {}, _('WebUI')) ]),
						E('b', {}, '↗')
					]),
					E('button', { 'class':'btn mt5700m-refresh', 'click':function() { window.location.reload(); } }, _('Refresh'))
				])
			]),
			E('div', { 'class':'mt5700m-focus-grid' }, [ this.signalCard(data), this.carrierCard(carrierInfo), this.addressCard(session) ]),
			E('div', { 'class':'mt5700m-info-grid' }, [ this.moduleCard(data), this.simCard(data) ]),
			this.trafficPanel(res.traffic || {}, data.network_interface || 'eth2'),
			E('div', { 'class':'mt5700m-shortcuts' }, [
				this.shortcut(_('Mobile data'), _('APN, dialing, IP details and session counters'), 'admin/modem/mt5700m/connection'),
				this.shortcut(_('Radio and Cells'), _('Bands, cells, radio policy and diagnostics'), 'admin/modem/mt5700m/network'),
				this.shortcut(_('Module and SIM'), _('Module identity, SIM information and maintenance'), 'admin/modem/mt5700m/system')
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
