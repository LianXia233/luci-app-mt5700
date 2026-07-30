'use strict';
'require baseclass';
'require ui';
'require fs';

function section(raw, label) {
	var marker = '===== ' + label + ':', active = false, output = [];
	(raw || '').split(/\n/).forEach(function(line) {
		if (line.indexOf('===== ') === 0) {
			active = line.indexOf(marker) === 0;
			return;
		}
		if (active && line.trim() && line.trim() !== 'OK')
			output.push(line.trim());
	});
	return output.join('\n');
}

function pick(text, expression, fallback) {
	var match = (text || '').match(expression);
	return match ? match[1] : fallback;
}

function csvValues(text, prefix) {
	var line = (text || '').split(/\n/).filter(function(item) { return item.indexOf(prefix) === 0; })[0] || '';
	return line.substring(prefix.length).replace(/^[ :]+/, '').replace(/"/g, '').split(',').map(function(value) { return value.trim(); });
}

function hexIPv4(value) {
	if (!/^[0-9a-f]{8}$/i.test(value || ''))
		return '';
	return [ 6, 4, 2, 0 ].map(function(offset) { return parseInt(value.substr(offset, 2), 16); }).join('.');
}

function hexNumber(value) {
	value = String(value || '').replace(/^0x/i, '');
	if (!/^[0-9a-f]+$/i.test(value))
		return 0;
	if (value.length <= 8)
		return parseInt(value, 16);
	return parseInt(value.slice(0, -8), 16) * 4294967296 + parseInt(value.slice(-8), 16);
}

function formatBytes(value) {
	var units = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], index = 0;
	value = Math.max(0, Number(value) || 0);
	while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
	return (index ? value.toFixed(value >= 10 ? 1 : 2) : String(Math.round(value))) + ' ' + units[index];
}

function formatDuration(seconds) {
	seconds = Math.max(0, Number(seconds) || 0);
	var days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
	return (days ? days + _('d') + ' ' : '') + (hours ? hours + _('h') + ' ' : '') + minutes + _('min');
}

function formatRate(value) {
	value = Number(value) || 0;
	if (value >= 1000000000) return (value / 1000000000).toFixed(2) + ' Gbps';
	if (value >= 1000000) return (value / 1000000).toFixed(1) + ' Mbps';
	return value ? Math.round(value / 1000) + ' Kbps' : '--';
}

function parseSession(raw) {
	var ndis = csvValues(section(raw, 'Data session'), '^NDISSTATQRY');
	var dhcp4 = csvValues(section(raw, 'IPv4 lease'), '^DHCP');
	var dhcp6 = csvValues(section(raw, 'IPv6 lease'), '^DHCPV6');
	var flow = csvValues(section(raw, 'Data flow'), '^DSFLOWQRY');
	var mtu = csvValues(section(raw, 'MTU'), '^CGMTU');
	var pdpAddress = csvValues(section(raw, 'PDP address'), '+CGPADDR');
	var capability = pick(section(raw, 'IP capability'), /\^IPV6CAP:\s*(\w+)/, '');
	var capabilityNames = { '1':_('IPv4 only'), '2':_('IPv6 only'), '7':_('IPv4 / IPv6 · same APN'), '0B':_('IPv4 / IPv6 · separate APNs'), '0b':_('IPv4 / IPv6 · separate APNs') };
	var detailed = (section(raw, 'Detailed sessions') || '').split(/\n/).map(function(line) {
		var match = line.match(/^\^DCONNSTAT:\s*(\d+)(?:[,，]["“”]?([^,"“”]*)["“”]?[,，](\d+)[,，](\d+)[,，](\d+)(?:[,，](\d+))?)?/);
		return match ? { cid:match[1], apn:match[2] || '', ipv4:match[3] === '1', ipv6:match[4] === '1', type:match[5] || '', ethernet:match[6] === '1' } : null;
	}).filter(function(item) { return item && item.apn; });

	return {
		ipv4Connected:ndis[0] === '1' && ndis[4] === 'IPV4',
		ipv6Connected:ndis[5] === '1' && ndis[8] === 'IPV6',
		ipv4Address:hexIPv4(dhcp4[0]) || pdpAddress[1] || '',
		ipv4Gateway:hexIPv4(dhcp4[2]),
		ipv4Dns:[ hexIPv4(dhcp4[4]), hexIPv4(dhcp4[5]) ].filter(Boolean).join(' · '),
		ipv6Address:dhcp6[0] && dhcp6[0] !== '::' ? dhcp6[0] : '',
		ipv6Dns:[ dhcp6[4], dhcp6[5] ].filter(function(value) { return value && value !== '::'; }).join(' · '),
		capability:capabilityNames[capability] || capability,
		mtu:mtu[1] && mtu[1] !== '0' ? mtu[1] : _('Network default'),
		currentDuration:hexNumber(flow[0]), currentTx:hexNumber(flow[1]), currentRx:hexNumber(flow[2]),
		totalDuration:hexNumber(flow[3]), totalTx:hexNumber(flow[4]), totalRx:hexNumber(flow[5]),
		maximumDown:dhcp4[6] || dhcp6[6], maximumUp:dhcp4[7] || dhcp6[7], detailed:detailed
	};
}

function select(options, value) {
	var node = E('select', { 'class': 'cbi-input-select' }, options.map(function(item) {
		return E('option', { 'value': item[0] }, item[1]);
	}));
	if (value != null)
		node.value = String(value);
	return node;
}

function confirmRun(title, message, args, restartRequired) {
	return ui.showModal(title, [
		E('p', {}, message),
		restartRequired ? E('div', { 'class': 'alert-message warning' }, _('A module restart or airplane-mode cycle is required before this change takes effect.')) : null,
		E('div', { 'class': 'right' }, [
			E('button', { 'type': 'button', 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
			E('button', {
				'type': 'button',
				'class': 'btn cbi-button-negative',
				'click': function() {
					ui.hideModal();
					fs.exec('/usr/sbin/mt5700m-at', args).then(function() {
						ui.addNotification(null, E('p', {}, _('Settings applied.')));
						window.setTimeout(function() { window.location.reload(); }, 900);
					}, function(err) {
						ui.addNotification(null, E('p', {}, err.message || String(err)), 'danger');
					});
				}
			}, _('Apply'))
		])
	]);
}

function row(label, input) {
	return E('div', { 'class': 'mt-control-row' }, [ E('label', {}, label), input ]);
}

function action(label, handler) {
	return E('div', { 'class': 'mt-control-actions' }, E('button', {
		'type': 'button',
		'class': 'btn cbi-button-apply',
		'click': handler
	}, label));
}

function card(title, desc, body, wide) {
	return E('section', { 'class': 'mt-control-card mt-ui-card' + (wide ? ' wide' : '') }, [
		E('h3', {}, title),
		E('div', { 'class': 'mt-control-desc' }, desc)
	].concat(body));
}

function state(label, value) {
	return E('div', { 'class': 'mt-control-state' }, [ E('span', {}, label), E('strong', {}, value || '--') ]);
}

function styleNode() {
	return E('style', {}, [
		'.mt-ui-page{--mt-ui-accent:#1264d8;--mt-ui-teal:#07988e;--mt-ui-border:var(--border-color-medium,#d9dde4);--mt-ui-border-soft:var(--border-color-low,#edf0f4);--mt-ui-surface:var(--background-color-high,#fff);--mt-ui-muted:var(--text-color-medium,#69717d);max-width:1120px;margin:0 auto;color:var(--text-color-high,#20242a)}',
		'.mt-ui-hero{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:22px 24px;margin:0 0 16px;border:0;border-radius:16px;background:linear-gradient(135deg,#1264d8 0%,#087eae 58%,#07988e 100%);color:#fff;box-shadow:0 10px 28px rgba(14,92,155,.16)}.mt-ui-hero h2{margin:0 0 6px;color:#fff;font-size:24px;line-height:1.2}.mt-ui-hero p,.mt-ui-hero [class*="-sub"]{margin:0;color:rgba(255,255,255,.78);font-size:12px;line-height:1.5}.mt-ui-hero [class*="kicker"],.mt-ui-hero [class*="eyebrow"]{color:rgba(255,255,255,.68);font-size:11px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}',
		'.mt-ui-card{border:1px solid var(--mt-ui-border);border-radius:14px;background:var(--mt-ui-surface);box-shadow:0 3px 12px rgba(20,32,50,.04)}',
		'.mt-ui-page .btn{border-radius:9px}.mt-ui-page input,.mt-ui-page select,.mt-ui-page textarea{border-radius:8px}',
		'.mt-ui-details{margin-top:14px;border:1px solid var(--mt-ui-border);border-radius:14px;background:var(--mt-ui-surface);overflow:hidden}.mt-ui-details>summary{display:grid;grid-template-columns:minmax(0,1fr) 34px;align-items:center;gap:14px;min-height:54px;padding:10px 12px 10px 18px;cursor:pointer;list-style:none;transition:background-color .16s ease}.mt-ui-details>summary::-webkit-details-marker{display:none}.mt-ui-details>summary:hover{background:var(--background-color-low,#f6f8fa)}.mt-ui-summary-copy{min-width:0}.mt-ui-summary-title{display:block;font-size:14px;font-weight:700;line-height:1.35}.mt-ui-summary-desc{display:block;margin-top:3px;color:var(--mt-ui-muted);font-size:11px;font-weight:400;line-height:1.45}.mt-ui-chevron{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--mt-ui-border-soft);border-radius:9px;background:var(--background-color-low,#f5f7f9);color:var(--mt-ui-muted);font-size:22px;line-height:1;transform:rotate(0deg);transition:transform .18s ease,background-color .18s ease,color .18s ease}.mt-ui-details[open]>summary .mt-ui-chevron{transform:rotate(90deg);background:#eaf4ff;color:#176bc1}.mt-ui-details[open]>summary{border-bottom:1px solid var(--mt-ui-border-soft)}.mt-ui-details:not([open])>.mt-ui-details-body{display:none}',
		'.mt-control-section{margin-top:20px}.mt-control-section-head{margin:0 0 11px}.mt-control-section-head h3{margin:0 0 4px;font-size:17px}.mt-control-section-head p{margin:0;color:var(--text-color-medium,#6e7783);font-size:12px;line-height:1.5}',
		'.mt-control-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.mt-control-card{padding:18px;border:1px solid var(--border-color-medium,#d9dde4);border-radius:13px;background:var(--background-color-high,#fff)}.mt-control-card.wide{grid-column:1/-1}',
		'.mt-control-card h3{margin:0 0 5px;font-size:15px}.mt-control-desc{font-size:12px;color:var(--text-color-medium,#6e7783);margin-bottom:14px;line-height:1.5}.mt-control-row{display:grid;grid-template-columns:145px 1fr;gap:10px;align-items:center;margin:11px 0}.mt-control-row label{font-size:12px;color:var(--text-color-medium,#6e7783)}.mt-control-row input,.mt-control-row select{width:100%;box-sizing:border-box}',
		'.mt-control-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}.mt-control-note{padding:10px 12px;border-radius:8px;background:#fff7e5;color:#795300;font-size:11px;line-height:1.5;margin-top:12px}.mt-control-state{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid var(--border-color-low,#edf0f4);font-size:12px}.mt-control-state:last-child{border-bottom:0}.mt-control-state span{color:var(--text-color-medium,#6e7783)}.mt-control-state strong{text-align:right}',
		'.mt-control-card.mt-ui-card{border-radius:14px}',
		'@media(max-width:760px){.mt-ui-hero{display:block;padding:20px}.mt-ui-card{border-radius:13px}.mt-ui-page .btn{min-height:36px}.mt-ui-page input:not([type="checkbox"]):not([type="radio"]),.mt-ui-page select{min-height:36px}.mt-ui-details>summary{grid-template-columns:minmax(0,1fr) 32px;padding-left:15px}.mt-control-grid{grid-template-columns:1fr}.mt-control-row{grid-template-columns:1fr;gap:5px}}'
	].join(''));
}

// Map an English operator name (from AT+COPS) to a Chinese name + logo.
// Centralised here so the LuCI status page, the network page and any other
// view always render the SAME four-carrier logos (China Mobile / Unicom /
// Telecom / Broadnet).  Returns { name: <zh>, logo: <data URI> | null }.
function operatorInfo(name) {
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
}

return baseclass.extend({
	section: section,
	pick: pick,
	csvValues: csvValues,
	hexIPv4: hexIPv4,
	hexNumber: hexNumber,
	formatBytes: formatBytes,
	formatDuration: formatDuration,
	formatRate: formatRate,
	parseSession: parseSession,
	select: select,
	confirmRun: confirmRun,
	row: row,
	action: action,
	card: card,
	state: state,
	styleNode: styleNode,
	operatorInfo: operatorInfo
});
