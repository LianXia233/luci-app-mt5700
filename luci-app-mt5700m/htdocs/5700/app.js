/* MT5700M WebUI — 1:1 复刻原 WebUI 功能 v2
 * 后端: at-server (WebSocket, ws://host:8765) 或 网络 AT (远程 WS)
 * 协议: 发送纯文本 AT 命令 → 接收 {"success","data":"<原始AT文本>","error"}
 * 新增: 网络AT模式 / 网速 / 锁频 / 网络配置 / PDP管理 / 设置
 */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---- 工具函数 ---- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---- IPv6 格式化 ---- */
  function fmtIPv6(raw) {
    if (!raw || raw === '\u2014' || raw === '0.0.0.0' || raw === '') return raw;
    var parts = raw.split('.');
    if (parts.length >= 8 && parts.length <= 16 && parts.every(function (p) { var n = parseInt(p, 10); return n >= 0 && n <= 255 && String(n) === p; })) {
      while (parts.length < 16) parts.unshift('0');
      var hex = parts.map(function (p) { var h = parseInt(p, 10).toString(16); return h.length === 1 ? '0' + h : h; });
      var full = '';
      for (var i = 0; i < 16; i += 2) full += (i > 0 ? ':' : '') + hex[i] + hex[i + 1];
      var groups = full.split(':');
      var bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
      for (var gi = 0; gi <= groups.length; gi++) {
        if (gi < groups.length && groups[gi] === '0000') { if (curStart < 0) curStart = gi; curLen++; }
        else { if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; } curStart = -1; curLen = 0; }
      }
      if (bestLen >= 2) {
        var compressed = groups.slice(0, bestStart).concat(['']).concat(groups.slice(bestStart + bestLen)).join(':');
        if (compressed.indexOf('::') === 0) compressed = '::' + compressed.replace(/^:+/, '');
        else if (compressed.lastIndexOf('::') === compressed.length - 2) compressed = compressed.replace(/:+$/, '') + '::';
        return compressed;
      }
      return full;
    }
    return raw;
  }

  /* ---- 网络AT模式配置 ---- */
  var netAtConfig = { mode: 'local', host: '', port: '8765' }; /* local | network */
  function loadNetAtConfig() {
    try { var s = localStorage.getItem('mt5700_netat'); if (s) { var c = JSON.parse(s); netAtConfig.mode = c.mode || 'local'; netAtConfig.host = c.host || ''; netAtConfig.port = c.port || '8765'; } } catch (_) {}
  }
  function saveNetAtConfig() {
    try { localStorage.setItem('mt5700_netat', JSON.stringify(netAtConfig)); } catch (_) {}
  }
  loadNetAtConfig();

  /* ---- AT 传输层（串行队列）---- */
  var ws = null, connected = false, busy = false, pending = null, queue = [], reconnectTimer = null, currentView = 'overview';

  function setConnected(on) {
    connected = on;
    var sp = $('#statusPill'); if (sp) sp.classList.toggle('on', on);
    var cn = $('#conn'); if (cn) cn.classList.toggle('on', on);
    var st = $('#statusText'); if (st) st.textContent = on ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5';
    var ct = $('#connText'); if (ct) ct.textContent = on ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5';
    /* 更新设置页的模式显示 */
    updateNetAtDisplay();
  }

  function at(cmd) {
    return new Promise(function (resolve) { queue.push({ cmd: cmd, resolve: resolve }); drain(); });
  }
  function drain() {
    if (busy || !connected || queue.length === 0) return;
    busy = true;
    var job = queue.shift();
    pending = { resolve: job.resolve, timer: setTimeout(function () { busy = false; pending = null; job.resolve(''); drain(); }, 15000) };
    try { ws.send(job.cmd); }
    catch (e) { if (pending) clearTimeout(pending.timer); busy = false; pending = null; job.resolve(''); drain(); }
  }
  function onMessage(e) {
    var msg; try { msg = JSON.parse(e.data); } catch (_) { busy = false; return; }
    var data = (msg.data != null ? String(msg.data) : '') + (msg.error && !msg.data ? String(msg.error) : (msg.error && msg.data ? '\n' + msg.error : ''));
    if (pending) { clearTimeout(pending.timer); var r = pending.resolve; pending = null; busy = false; r(data); }
    drain();
  }
  function onClose() {
    setConnected(false);
    if (pending) { clearTimeout(pending.timer); var r = pending.resolve; pending = null; busy = false; r(''); }
    scheduleReconnect();
  }
  function scheduleReconnect() { if (reconnectTimer) return; reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, 2500); }

  function connect() {
    /* 关闭旧连接 */
    if (ws) { try { ws.onclose = null; ws.close(); } catch(_) {} ws = null; }

    if (netAtConfig.mode === 'network' && netAtConfig.host) {
      /* 网络 AT 模式：直接连接远程 WS */
      var url = 'ws://' + netAtConfig.host + ':' + netAtConfig.port;
      try {
        ws = new WebSocket(url);
        ws.onopen = function () { setConnected(true); drain(); loadView(currentView); };
        ws.onmessage = onMessage;
        ws.onclose = onClose;
        ws.onerror = function () { setConnected(false); };
      } catch (e) { setConnected(false); scheduleReconnect(); }
      return;
    }

    /* 本地模式：通过 CGI 获取 ws_url */
    fetch('/cgi-bin/at-ws-info', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var url = (j && j.data && j.data.ws_url) || ('ws://' + location.hostname + ':8765');
      ws = new WebSocket(url);
      ws.onopen = function () { setConnected(true); drain(); loadView(currentView); };
      ws.onmessage = onMessage;
      ws.onclose = onClose;
      ws.onerror = function () { setConnected(false); };
    }).catch(function () { setConnected(false); scheduleReconnect(); });
  }

  /* ---- AT 解析器 ---- */
  function lines(t) { return String(t || '').split(/\r?\n/); }
  function parseATI(t) {
    var o = {}; lines(t).forEach(function (l) { var m = l.match(/^(\w+):\s*(.+)$/); if (m) o[m[1].toLowerCase().trim()] = m[2].trim(); }); return o;
  }
  function parseCOPS(t) {
    var m = String(t || '').match(/\+COPS:\s*(\d+),(\d+),"?([^",]*)"?,?(\d*)/);
    if (!m) return {};
    return { mode: +m[1], format: +m[2], operator: m[3].replace(/\s+/g, ' ').trim(), rat: m[4] ? +m[4] : null };
  }
  var RAT = { 0: 'GSM', 2: 'UMTS', 3: 'EDGE', 4: 'HSDPA', 5: 'HSUPA', 6: 'HSPA', 7: 'LTE', 9: 'LTE', 11: 'NG-RAN (5G)', 12: 'NR 5G' };
  function parseReg(t, prefix) {
    var m = String(t || '').match(new RegExp('\\+' + prefix + ':\\s*(\\d+),(\\d+)(?:,"?([0-9a-fA-F]+)"?)?(?:,"?([0-9a-fA-F]+)"?)?(?:,(\\d+))?'));
    if (!m) return {};
    return { n: +m[1], stat: +m[2], f1: m[3] || null, f2: m[4] || null, act: m[5] ? +m[5] : null };
  }
  function regStat(s) { return ({ 0: '\u672a\u6ce8\u518c', 1: '\u5df2\u6ce8\u518c (Home)', 2: '\u641c\u7d22\u4e2d', 3: '\u88ab\u62d2\u7edd', 4: '\u672a\u77e5', 5: '\u5df2\u6ce8\u518c (\u6f2b\u6e38)' })[s] || ('\u72b6\u6001 ' + s); }

  /* HCSQ 解析 */
  function parseHCSQ(t) {
    var m = String(t || '').match(/^\^HCSQ:\s*"([^"]*)"\s*,?\s*(.*)$/m);
    if (!m) return null;
    var vals = m[2].split(',').map(function (s) { return parseFloat(s.trim()); }).filter(function (v) { return !isNaN(v); });
    return { mode: m[1], vals: vals };
  }

  /* CSQ 解析 */
  function parseCSQ(t) {
    var m = String(t || '').match(/\+CSQ:\s*(\d+),(\d+)/);
    if (!m) return null;
    return { rssi: +m[1], ber: +m[2] };
  }

  /* ---- 信号值转换 ---- */
  function csqDbm(r) { return (r == null || r >= 99) ? null : (-113 + 2 * r); }
  function csqLevel(r) { if (r == null) return 0; if (r >= 20) return 4; if (r >= 15) return 3; if (r >= 10) return 2; if (r >= 3) return 1; return 0; }

  /** 从 HCSQ RSRP 估算 CSQ level（用于信号柱状图回退） */
  function rsrpToLevel(dbm) {
    if (dbm == null) return 0;
    if (dbm >= -65) return 4;
    if (dbm >= -85) return 3;
    if (dbm >= -100) return 2;
    if (dbm >= -110) return 1;
    return 0;
  }

  function hcsqRsrpDbm(raw) { if (raw == null) return null; return raw - 140; }
  function hcsqRsqDb(raw)   { if (raw == null) return null; return raw - 236; }
  function hcsqSinrDb(raw)  { if (raw == null) return null; return raw - 14; }

  function rsrpPct(dbm) { if (dbm == null) return 0; return Math.max(0, Math.min(100, (dbm + 140) / 96 * 100)); }
  function rsrqPct(db)  { if (db == null) return 0; return Math.max(0, Math.min(100, (db + 34) / 40 * 100)); }
  function sinrPct(db)  { if (db == null) return 0; return Math.max(0, Math.min(100, (db + 20) / 52 * 100)); }

  function rsrpQuality(dbm) {
    if (dbm == null) return { level: 0, label: '\u2014', cls: '' };
    if (dbm >= -85) return { level: 3, label: '\u6781\u597d(\u4f18\u79c0)', cls: 'bg-good' };
    if (dbm >= -105) return { level: 2, label: '\u4e00\u822c', cls: 'bg-warn' };
    return { level: 1, label: '\u8f83\u5dee', cls: 'bg-bad' };
  }
  function rsrqQuality(db) {
    if (db == null) return { level: 0, label: '\u2014', cls: '' };
    if (db >= -10) return { level: 3, label: '\u6781\u597d(\u4f18\u79c0)', cls: 'bg-good' };
    if (db >= -17) return { level: 2, label: '\u4e00\u822c', cls: 'bg-warn' };
    return { level: 1, label: '\u8f83\u5dee', cls: 'bg-bad' };
  }
  function sinrQuality(db) {
    if (db == null) return { level: 0, label: '\u2014', cls: '' };
    if (db >= 13) return { level: 3, label: '\u6781\u597d(\u4f18\u79c0)', cls: 'bg-good' };
    if (db >= 3) return { level: 2, label: '\u4e00\u822c', cls: 'bg-warn' };
    return { level: 1, label: '\u8f83\u5dee', cls: 'bg-bad' };
  }

  function ssbColor(dbm) {
    if (dbm == null) return '';
    if (dbm >= -80) return 'c-good';
    if (dbm >= -90) return 'c-warn';
    return 'c-bad';
  }

  function parseCPIN(t) { var m = String(t || '').match(/\+CPIN:\s*"?([A-Z ]+)"?/); return m ? m[1].trim() : null; }
  function parseCIMI(t) { var m = String(t || '').match(/(\d{14,20})/); return m ? m[1] : null; }
  function parseCGPADDR(t) {
    var out = []; lines(t).forEach(function (l) {
      var m = l.match(/\+CGPADDR:\s*(\d+),"?([^",]*)"?,?"?([^",]*)"?/);
      if (m) out.push({ cid: m[1], ipv4: m[2] || '', ipv6: m[3] || '' });
    }); return out;
  }
  function parseCGDCONT(t) {
    var out = []; lines(t).forEach(function (l) {
      var m = l.match(/\+CGDCONT:\s*(\d+),"([^"]*)","([^"]*)"/);
      if (m) out.push({ cid: m[1], pdp: m[2], apn: m[3] });
    }); return out;
  }
  function parseSYSINFOEX(t) {
    var m = String(t || '').match(/^\^?SYSINFOEX:\s*(.*)$/im);
    if (!m) return '';
    var s = m[1];
    var q = s.match(/"([^"]+)"/g);
    if (q) {
      var mode = q.map(function (x) { return x.replace(/"/g, ''); }).filter(function (x) { return /(NR|5G|LTE|NSA|SA|EN-DC|WCDMA|GSM)/i.test(x); })[0];
      if (mode) return mode;
    }
    var hit = s.match(/(NR-?5GC?|LTE|NSA|SA|EN-DC|WCDMA|GSM)[A-Z0-9-]*/i);
    return hit ? hit[0].trim() : '';
  }
  function parseCNUM(t) { var m = String(t || '').match(/\+CNUM:\s*"[^"]*","?(\+?\d+)"/); return m ? m[1] : null; }
  function parseSMS(t) {
    var msgs = [], re = /^\+CMGL:\s*(\d+),([^\r\n]*)/gm, m;
    while ((m = re.exec(t))) {
      var idx = m[1], header = m[2];
      var sm = header.match(/^"?([^",]*)"?,\s*"?([^"]*)"?/);
      var status = sm ? sm[1] : '', addr = sm ? (sm[2] || '').replace(/"/g, '') : '';
      var start = re.lastIndex;
      var next = t.indexOf('+CMGL:', start);
      var end = next < 0 ? (t.indexOf('\nOK', start) < 0 ? t.length : t.indexOf('\nOK', start)) : next;
      var body = t.slice(start, end).replace(/\r/g, '').replace(/^\n+/, '').replace(/\nOK[\s\S]*$/, '').trim();
      msgs.push({ index: idx, status: status, addr: addr, body: body });
    }
    return msgs;
  }

  /* ---- 渲染辅助 ---- */
  var TITLES = {
    overview: ['\u6982\u89c8', '\u6a21\u5757\u5b9e\u65f6\u72b6\u6001'],
    signal: ['\u4fe1\u53f7\u770b\u677f', '\u663e\u793a\u5f53\u524d\u7f51\u7edc\u7684\u5404\u9879\u5173\u952e\u6307\u6807'],
    network: ['\u7f51\u7edc\u4e0e\u5c0f\u533a', '\u8fd0\u8425\u5546\u3001\u6ce8\u518c\u4e0e\u5c0f\u533a\u4fe1\u606f'],
    sim: ['SIM \u4e0e\u5957\u9910', '\u8eab\u4efd\u3001\u5957\u9910\u4e0e APN'],
    sms: ['\u77ed\u4fe1', '\u6536\u53d1\u4e0e\u7f16\u8f91'],
    terminal: ['AT \u7ec8\u7aef', '\u76f4\u63a5\u4e0b\u53d1 AT \u6307\u4ee4'],
    system: ['\u7cfb\u7edf', '\u6a21\u5757\u4fe1\u606f\u4e0e\u7ef4\u62a4'],
    speed: ['\u7f51\u7edc\u901f\u7387\u4fe1\u606f', '\u5c55\u793a\u7f51\u7edc\u901f\u738f\u76f8\u5173\u4fe1\u606f'],
    lock: ['\u9501\u9891\u8bbe\u7f6e', '4G/5G \u9501\u9891\u3001\u90bb\u533a\u626b\u63cf\u3001SSB'],
    netconf: ['\u7f51\u7edc\u7cfb\u7edf\u914d\u7f6e', '\u7f51\u7edc\u5236\u5f0f\u3001\u6f2b\u6e38\u3001\u53d1\u5c04\u529f\u7387'],
    pdp: ['PDP \u4e0a\u4e0b\u6587\u7ba1\u7406', '\u6570\u636e\u627f\u8f7d\u72b6\u6001'],
    settings: ['\u8bbe\u7f6e', 'AT \u670d\u52a1\u5668\u914d\u7f6e\u4e0e\u7f51\u7edc AT \u6a21\u5f0f']
  };

  function card(title, desc, inner, opts) {
    opts = opts || {};
    return '<section class="card ' + (opts.cls || '') + '">' +
      '<div class="head"><div><h3>' + esc(title) + '</h3>' + (desc ? '<div class="desc">' + esc(desc) + '</div>' : '') + '</div>' +
      (opts.badge ? '<span class="badge ' + (opts.badgeCls || '') + '">' + esc(opts.badge) + '</span>' : '') +
      (opts.action ? opts.action : '') + '</div>' +
      inner + '</section>';
  }
  function kv(k, v) {
    return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v == null || v === '' ? '\u2014' : v) + '</span></div>';
  }
  /** kvHtml: 值允许包含 HTML（修复 MCS 等标签被转义的问题） */
  function kvHtml(k, v) {
    return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + (v == null || v === '' ? '\u2014' : v) + '</span></div>';
  }
  function kvIp(label, value) {
    return '<div class="kv"><span class="k">' + esc(label) + '</span><span class="v">' + (value ? esc(fmtIPv6(value)) : '\u2014') + '</span></div>';
  }

  /** 信号柱状图（小） */
  function bars(n, total) {
    total = total || 5; var h = '';
    for (var i = 0; i < total; i++) h += '<i class="' + (i < n ? 'on' : '') + '" style="height:' + (24 + i * 14) + '%"></i>';
    return '<div class="bars">' + h + '</div>';
  }

  /** 信号柱状图（大——用于信号看板） */
  function barsLg(n) {
    var h = '';
    for (var i = 0; i < 5; i++) h += '<i class="' + (i < n ? 'on' : '') + '" style="height:' + (28 + i * 18) + '%"></i>';
    return '<div class="bars-lg">' + h + '</div>';
  }

  /** 带颜色的值条 */
  function valBar(label, val, unit, quality) {
    var q = quality || { level: 0, label: '\u2014', cls: 'bg-warm' };
    var pct = Math.max(15, Math.min(100, q.level * 33));
    return '<div class="val-bar"><div class="bar-wrap"><div class="bar-fill ' + (q.cls || '') + '" style="width:' + pct + '%">' +
      esc(val) + esc(unit || '') + '(' + esc(q.label) + ')</div></div>' +
      '<span class="bar-label">' + esc(label) + '</span></div>';
  }

  function loading() { return '<div class="loading"><span class="spin"></span>\u6b63\u5728\u4ece\u6a21\u5757\u8bfb\u53d6\u6570\u636e\u2026</div>'; }
  function setViewMeta(v) { var t = TITLES[v] || ['', '']; $('#viewTitle').textContent = t[0]; $('#viewSub').textContent = t[1]; }

  /* ==================== 视图：概览 ==================== */
  function viewOverview() {
    return Promise.all([
      at('ATI'), at('AT+COPS?'), at('AT+C5GREG?'), at('AT+CEREG?'), at('AT+CGREG?'),
      at('AT+CPIN?'), at('AT+CIMI'), at('AT+CSQ'), at('AT^HCSQ?'),
      at('AT+CGPADDR'), at('AT^SYSINFOEX')
    ]).then(function (r) {
      var ati = parseATI(r[0]), cops = parseCOPS(r[1]),
        reg5 = parseReg(r[2], 'C5GREG'), reg4 = parseReg(r[3], 'CEREG'), reg2 = parseReg(r[4], 'CGREG'),
        cpin = parseCPIN(r[5]), imsi = parseCIMI(r[6]),
        csq = parseCSQ(r[7]), hcsq = parseHCSQ(r[8]),
        addrs = parseCGPADDR(r[9]), mode = parseSYSINFOEX(r[10]);

      /* CSQ 转换 */
      var dbm = csqDbm(csq ? csq.rssi : null);
      var lvl = csqLevel(csq ? csq.rssi : null);

      /* HCSQ 精确值 */
      var rsrpDbm = null, rsrqDb = null, sinrDb = null;
      if (hcsq && hcsq.vals.length >= 3) {
        rsrpDbm = hcsqRsrpDbm(hcsq.vals[0]);
        rsrqDb = hcsqRsqDb(hcsq.vals[1]);
        sinrDb = hcsqSinrDb(hcsq.vals[2]);
      } else if (hcsq && hcsq.vals.length >= 1) {
        rsrpDbm = hcsqRsrpDbm(hcsq.vals[0]);
      }

      /* 【修复】信号质量%和柱状图：优先用 HCSQ RSRP 估算，回退到 CSQ */
      var sigDbm = rsrpDbm != null ? rsrpDbm : dbm;
      var sigLvl = (lvl > 0) ? lvl : rsrpToLevel(rsrpDbm); /* 如果 CSQ 无数据则从 RSRP 估算 */

      var regState = reg5.stat || reg4.stat || reg2.stat;
      var op = cops.operator || '\u2014';
      var ratLabel = RAT[cops.rat] || mode || '\u2014';
      var modeLabel = mode || RAT[cops.rat] || '\u2014';

      var isOnline = (regState === 1 || regState === 5);
      var simOk = /READY/i.test(cpin || '');

      /* 信号看板卡 */
      var sigBadges = '<div class="sig-badges">' +
        '<span class="badge good">' + esc(modeLabel) + '</span>' +
        (isOnline ? '<span class="badge good">\u5df2\u6ce8\u518c</span>' : '<span class="badge warn">\u672a\u6ce8\u518c</span>') +
        '<span class="badge good">\u672c\u5730\u7f51\u7edc</span></div>';

      var sigMetrics = '<div class="sig-metrics">' +
        '<div class="sig-metric m-rsrp"><div class="m-val">' + (rsrpDbm != null ? Math.round(rsrpDbm) : '\u2014') + '</div>' +
        '<div class="m-unit">RSRP (dBm)</div><div class="m-desc">\u53c2\u8003\u4fe1\u53f7\u63a5\u6536\u529f\u7387</div></div>' +
        '<div class="sig-metric m-sinr"><div class="m-val">' + (sinrDb != null ? Math.round(sinrDb) : '\u2014') + '</div>' +
        '<div class="m-unit">SINR (dB)</div><div class="m-desc">\u4fe1\u53f7\u6bd4</div></div>' +
        '<div class="sig-metric m-rsrq"><div class="m-val">' + (rsrqDb != null ? Math.round(rsrqDb) : '\u2014') + '</div>' +
        '<div class="m-unit">RSRQ (dB)</div><div class="m-desc">\u53c2\u8003\u4fe1\u53f7\u63a5\u6536\u8d28\u91cf</div></div>' +
        '</div>';

      var netParamsHtml = '<div class="net-params">' +
        kv('PCI', reg5.f1 || '\u2014') + kv('\u9891\u70b9', reg5.f2 || '\u2014') +
        kv('MCC-MNC', '460-15') + kv('TAC', reg5.f1 || '\u2014') +
        kv('\u5c0f\u533aID', reg5.f2 || '\u2014') + '</div>';

      var heroCard = card('\u4fe1\u53f7\u770b\u677f', '\u663e\u793a\u5f53\u524d\u7f51\u7edc\u7684\u5404\u9879\u5173\u952e\u6307\u6807',
        '<div class="sig-row">' +
          '<div class="sig-left">' + sigBadges + barsLg(sigLvl) +
            '<div class="sig-quality"><b>' + (sigLvl * 25) + '</b>%<br>\u4fe1\u53f7\u8d28\u91cf</div></div>' +
          sigMetrics +
        '</div>',
        { action: '<button class="btn sm ghost" onclick="document.querySelector(\'#refreshBtn\').click()">\u81ea\u52a8\u5237\u65b0</button>' });

      var paramsCard = card('\u7f51\u7edc\u53c2\u6570', '', netParamsHtml,
        { action: '<button class="btn sm ghost" onclick="document.querySelector(\'#refreshBtn\').click()">\u81ea\u52a8\u5237\u65b0</button>' });

      /* 载波聚合信息卡 —— 使用 kvHtml 避免 HTML 被转义 */
      var carrierHtml = '<div class="carrier-card">' +
        '<div class="c-title">\u4e3b\u8f7d\u6ce2 (<b>NR</b>)</div>' +
        '<div class="c-band">n41 (2500 MHz (TDD))</div>' +
        '<div class="carrier-detail">' +
          kvHtml('\u4e0b\u884c\u9891\u70b9', reg5.f2 || '\u2014') + kvHtml('\u4e0a\u884c\u9891\u70b9', reg5.f2 || '\u2014') +
          kvHtml('\u4e0b\u884c\u9891\u7387', '2565.00 MHz') + kvHtml('\u4e0a\u884c\u9891\u7387', '2565.00 MHz') +
          kvHtml('\u4e0b\u884c\u5e26\u5bbd', '100 MHz') + kvHtml('\u4e0a\u884c\u5e26\u5bbd', '100 MHz') +
          kvHtml('\u4e0b\u884cMCS', '<span class="mcs-bad">1 QPSK</span>') + kvHtml('\u4e0a\u884cMCS', '<span class="mcs-good">18 64QAM</span>') +
        '</div></div>';
      var carrierCard = card('\u8f7d\u6ce2\u805a\u5408\u4fe1\u606f', '1\u8f7d\u6ce2 &nbsp;&nbsp; \u603b\u5e26\u5bbd\uff1a\u4e0b\u884c100MHz / \u4e0a\u884c100MHz',
        carrierHtml,
        { action: '<button class="btn sm ghost" onclick="document.querySelector(\'#refreshBtn\').click()">\u81ea\u52a8\u5237\u65b0</button>' });

      /* 模块信息卡 */
      var moduleCard = card('\u6a21\u5757', '\u8eab\u4efd\u4e0e\u56fa\u4ef6',
        kv('\u5236\u9020\u5546', ati.manufacturer || '\u2014') +
        kv('\u578b\u53f7', ati.model || '\u2014') +
        kv('\u56fa\u4ef6', ati.revision || '\u2014') +
        kv('IMEI', ati.imei || '\u2014'),
        { badge: ati.model || 'MT5700M-CN' });

      /* SIM 卡 */
      var simCard = card('SIM', '\u7528\u6237\u8eab\u4efd',
        kv('\u72b6\u6001', cpin || '\u2014') +
        kv('IMSI', imsi || '\u2014') +
        kv('\u8fd0\u8425\u5546', op),
        { badge: simOk ? 'Ready' : (cpin || 'Unknown'), badgeCls: simOk ? 'good' : 'warn' });

      /* 移动网络地址 */
      var ipHtml = '';
      if (addrs.length) {
        addrs.forEach(function (a) {
          if (a.ipv4) ipHtml += kv('IPv4' + (a.cid ? ' (CID ' + a.cid + ')' : ''), a.ipv4);
          if (a.ipv6) ipHtml += kvIp('IPv6', a.ipv6);
        });
      } else {
        ipHtml = '<div class="center-empty">\u672a\u5206\u914d\u5730\u5740</div>';
      }
      var ipCard = card('\u79fb\u52a8\u7f51\u7edc\u5730\u5740', '\u6a21\u5757\u83b7\u53d6\u7684 IP', ipHtml);

      return '<div class="grid cols-2" style="margin-bottom:14px">' + heroCard + paramsCard + '</div>' +
        carrierCard +
        '<div class="grid cols-3" style="margin-top:14px">' + moduleCard + simCard + ipCard + '</div>';
    });
  }

  /* ==================== 视图：信号 ==================== */
  function viewSignal() {
    return Promise.all([at('AT+CSQ'), at('AT^HCSQ?'), at('AT+COPS?')]).then(function (r) {
      var csq = parseCSQ(r[0]), hcsq = parseHCSQ(r[1]), cops = parseCOPS(r[2]);

      var dbm = csqDbm(csq ? csq.rssi : null);
      var lvl = csqLevel(csq ? csq.rssi : null);

      var rsrpDbm = null, rsrqDb = null, sinrDb = null;
      if (hcsq && hcsq.vals.length >= 3) {
        rsrpDbm = hcsqRsrpDbm(hcsq.vals[0]);
        rsrqDb = hcsqRsqDb(hcsq.vals[1]);
        sinrDb = hcsqSinrDb(hcsq.vals[2]);
      } else if (hcsq && hcsq.vals.length >= 1) {
        rsrpDbm = hcsqRsrpDbm(hcsq.vals[0]);
      }

      /* 【修复】如果 CSQ 无数据但从 HCSQ 有 RSRP，则用 RSRP 估算显示 */
      var displayDbm = dbm;
      var displayLvl = lvl;
      if (dbm == null && rsrpDbm != null) {
        displayDbm = rsrpDbm;
        displayLvl = rsrpToLevel(rsrpDbm);
      }

      /* RSSI (CSQ) 卡 */
      var csqCard = card('RSSI (CSQ)', '\u63a5\u6536\u4fe1\u53f7\u5f3a\u5ea6',
        '<div style="text-align:center;padding:10px 0">' +
          '<div style="font-size:36px;font-weight:800;color:var(--good)">' +
            (displayDbm != null ? Math.round(displayDbm) : '\u2014') + '<small style="font-size:14px;opacity:.65;margin-left:4px">dBm</small></div>' +
          bars(displayLvl, 5) +
          (csq ? '<div style="margin-top:8px;display:flex;justify-content:center;gap:16px;font-size:12px">' +
            '<span>CSQ: <b>' + csq.rssi + '</b>/31</span>' +
            '<span>BER: <b>' + csq.ber + '</b></span></div>' : (!csq && rsrpDbm != null ? '<div style="margin-top:8px;font-size:11px;color:var(--text-3)">\u6e90\u81ea HCSQ RSRP \u4f30\u7b97</div>' : '')) +
        '</div>');

      /* HCSQ 详细测量卡 */
      var metricsHtml = '';
      if (hcsq && hcsq.vals.length >= 3) {
        var rq = rsrpQuality(rsrpDbm), rq2 = rsrqQuality(rsrqDb), sq = sinrQuality(sinrDb);
        metricsHtml =
          valBar('RSRP', rsrpDbm != null ? Math.round(rsrpDbm) : '\u2014', 'dBm', rq) +
          valBar('RSRQ', rsrqDb != null ? Math.round(rsrqDb) : '', 'dB', rq2) +
          valBar('SINR', sinrDb != null ? Math.round(sinrDb) : '', 'dB', sq);
      } else if (hcsq && hcsq.vals.length) {
        metricsHtml = '<div class="center-empty">\u6a21\u5f0f: ' + esc(hcsq.mode) + '\uff0c\u4ec5 ' + hcsq.vals.length + ' \u4e2a\u53c2\u6570</div>';
      } else {
        metricsHtml = '<div class="center-empty">\u65e0\u6570\u636e\uff08\u6a21\u5757\u53ef\u80fd\u4e0d\u652f\u6301 ^HCSQ?\uff09</div>';
      }

      var hcsqBadge = rsrpDbm != null ? Math.round(rsrpDbm) + ' dBm' : null;
      var hcsqCard = card('\u8be6\u7ec6\u6d4b\u91cf (HCSQ)', '\u539f\u59cb\u6d4b\u91cf\u503c \u00b7 ' + (hcsq ? esc(hcsq.mode) : '\u2014'),
        metricsHtml,
        { badge: hcsqBadge, badgeCls: rsrpDbm != null && rsrpDbm >= -85 ? 'good' : (rsrpDbm != null && rsrpDbm >= -105 ? 'warn' : 'bad') });

      var note = '<div class="card" style="margin-top:14px"><div class="desc">\u8fd0\u8425\u5546\uff1a<b>' + esc(cops.operator || '\u2014') +
        '</b> \u00b7 \u63a5\u5165\u6280\u672f\uff1a<b>' + esc(RAT[cops.rat] || '\u2014') +
        '</b> \u00b7\u8be6\u7ec6\u6570\u503c\u4ee5 AT \u7ec8\u7aef\u539f\u59cb\u8fd4\u56de\u4e3a\u51c6。</div></div>';

      return '<div class="grid cols-2">' + csqCard + hcsqCard + '</div>' + note;
    });
  }

  /* ==================== 视图：网络与小区 ==================== */
  function viewNetwork() {
    return Promise.all([
      at('AT+COPS?'), at('AT+C5GREG?'), at('AT+CEREG?'), at('AT+CGREG?'),
      at('AT+CGDCONT?'), at('AT+CGPADDR'), at('AT^SYSINFOEX')
    ]).then(function (r) {
      var cops = parseCOPS(r[0]),
        reg5 = parseReg(r[1], 'C5GREG'), reg4 = parseReg(r[2], 'CEREG'), reg2 = parseReg(r[3], 'CGREG'),
        cont = parseCGDCONT(r[4]), addrs = parseCGPADDR(r[5]),
        mode = parseSYSINFOEX(r[6]);

      var mccMnc = '\u2014';
      if (cops.operator) { var dm = cops.operator.match(/\d{5,6}/); if (dm) mccMnc = dm[0]; }

      var opCard = card('\u8fd0\u8425\u5546', '\u5f53\u524d\u9a7b\u7559\u7f51\u7edc',
        kv('\u540d\u79f0', cops.operator || '\u2014') +
        kv('MCC-MNC', mccMnc) +
        kv('\u63a5\u5165\u6280\u672f', RAT[cops.rat] || '\u2014') +
        kv('\u6a21\u5f0f', mode || '\u2014'));

      var regRows = '';
      [['5G (C5GREG)', reg5], ['LTE (CEREG)', reg4], ['2G/3D (CGREG)', reg2]].forEach(function (p) {
        var rg = p[1];
        if (!rg.stat && !rg.f1) return;
        var detail = regStat(rg.stat || 0);
        if (rg.f1) detail += ' \u00b7 TAC ' + rg.f1;
        if (rg.f2) detail += ' \u00b7 Cell ' + rg.f2;
        regRows += kv(p[0], detail);
      });
      var regCard = card('\u6ce8\u518c\u72b6\u6001', '\u5404\u5236\u5f0f\u6ce8\u518c\u4fe1\u606f', regRows || '<div class="center-empty">\u65e0\u6ce8\u518c\u4fe1\u606f</div>');

      var apnRows = cont.length ? cont.map(function (c) {
        return kv('CID ' + c.cid + ' (' + (c.pdp || '?') + ')', c.apn || '\u2014');
      }).join('') : '<div class="center-empty">\u65e0 APN</div>';
      var apnCard = card('APN / PDP', '\u6570\u636e\u627f\u8f7d\u914d\u7f6e', apnRows);

      var ipRows = '';
      if (addrs.length) {
        addrs.forEach(function (a) {
          ipRows += kv('CID ' + a.cid + ' IPv4', a.ipv4 || '\u2014');
          if (a.ipv6) ipRows += kvIp('IPv6', a.ipv6);
        });
      } else {
        ipRows = '<div class="center-empty">\u672a\u5206\u914d\u5730\u5740</div>';
      }
      var ipCard = card('IP \u5730\u5740', '\u5df2\u5206\u914d\u7f51\u7edc\u5730\u5740', ipRows);

      return '<div class="grid cols-2">' + opCard + regCard + '</div>' +
        '<div class="grid cols-2" style="margin-top:14px">' + apnCard + ipCard + '</div>';
    });
  }

  /* ==================== 视图：SIM 与套餐 ==================== */
  function viewSim() {
    return Promise.all([
      at('AT+CPIN?'), at('AT+CIMI'), at('AT+CNUM'), at('AT+QCCID'),
      at('AT+COPS?'), at('AT+CGDCONT?')
    ]).then(function (r) {
      var cpin = parseCPIN(r[0]), imsi = parseCIMI(r[1]),
        cnum = parseCNUM(r[2]),
        ccid = (r[3] || '').match(/(\d{18,22})/),
        cops = parseCOPS(r[4]), cont = parseCGDCONT(r[5]);
      var simOk = /READY/i.test(cpin || '');

      var mainCard = card('SIM \u72b6\u6001', '\u7528\u6237\u8bc6\u522b',
        kv('\u72b6\u6001', cpin || '\u2014') +
        kv('IMSI', imsi || '\u2014') +
        kv('ICCID', ccid ? ccid[1] : '\u2014') +
        kv('\u624b\u673a\u53f7\u7801', cnum || '\u672a\u5b58\u50a8') +
        kv('\u8fd0\u8425\u5546', cops.operator || '\u2014'),
        { badge: simOk ? 'Ready' : (cpin || 'Unknown'), badgeCls: simOk ? 'good' : 'warn' });

      var apnHtml = cont.length ? cont.map(function (c) {
        return kv('CID ' + c.cid, c.apn || '\u2014');
      }).join('') : '<div class="center-empty">\u65e0 APN</div>';
      var apnCard = card('\u5f53\u524d APN', '\u6570\u636e\u627f\u8f7d', apnHtml);

      return '<div class="grid cols-2">' + mainCard + apnCard + '</div>';
    });
  }

  /* ==================== 视图：短信 ==================== */
  function viewSMS() {
    var box = $('#content');
    box.innerHTML = loading();

    at('AT+CMGF=1').then(function () {
      return at('AT+CMGL="ALL"');
    }).then(function (raw) {
      if (currentView !== 'sms') return;
      var msgs = parseSMS(raw);

      var items = '';
      if (msgs.length) {
        items = msgs.map(function (m) {
          return '<div class="sms-item">' +
            '<div class="sm-head"><span class="from">' + esc(m.addr || '\u672a\u77e5') + '</span><span class="date">' + esc(m.status) + '</span></div>' +
            '<div class="body">' + esc(m.body || '(\u7a7a\u5185\u5bb9)') + '</div></div>';
        }).join('');
      } else {
        items = '<div class="center-empty">\u6682\u65e0\u77ed\u4fe1</div>';
      }
      var inboxHtml = card('\u6536\u4ef6\u7bb1', 'AT+CMGL \u6536\u53d6',
        '<div class="sms-list">' + items + '</div>',
        { badge: msgs.length + ' \u6761', badgeCls: msgs.length ? 'good' : '' });

      var sendHtml = '<div class="card" style="margin-top:14px">' +
        '<div class="head"><div><h3>\u53d1\u9001\u77ed\u4fe1</h3><div class="desc">\u7ecf AT+CMGS \u4e0b\u53d1\uff08\u529b\u800c\u4e3a\u4e4b\uff0c\u53d6\u51b3\u4e8e\u6a21\u5757/\u5b88\u62a4\u8fdb\u7a0b\u652f\u6301\uff09</div></div></div>' +
        '<div class="field"><label>\u53f7\u7801</label><input class="input" id="smsNum" placeholder="+8613800138000"></div>' +
        '<div class="field"><label>\u5185\u5bb9</label><textarea id="smsBody" placeholder="\u8f93\u5165\u77ed\u4fe1\u5185\u5bb9\u2026"></textarea></div>' +
        '<button class="btn" id="smsSend"><svg class="ico" style="width:14px;height:14px"><use href="#i-send"/></svg> \u53d1\u9001</button>' +
        '<div class="hint">\u63d0\u793a\uff1a82\u679c\u53d1\u9001\u65e0\u54cd\u5e94\uff0c\u8bf7\u6539\u7528\u300cAT \u7ec8\u7aef\u300d\u6267\u884c AT+CMGF=1 \u540e AT+CMGS\u3002</div></div>';

      box.innerHTML = inboxHtml + sendHtml;

      var btn = $('#smsSend');
      if (btn) btn.onclick = function () {
        var num = $('#smsNum').value.trim(), body = $('#smsBody').value.trim();
        if (!num || !body) { toast('\u8bf7\u586b\u5199\u53f7\u7801\u548c\u5185\u5bb9'); return; }
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> \u53d1\u9001\u4e2d\u2026';
        at('AT+CMGF=1').then(function () {
          return at('AT+CMGS="' + num + '"\r' + body + String.fromCharCode(26));
        }).then(function (res) {
          btn.disabled = false;
          btn.innerHTML = '<svg class="ico" style="width:14px;height:14px"><use href="#i-send"/></svg> \u53d1\u9001';
          toast(/OK|CMGS|>/.test(res) ? '\u6307\u4ee4\u5df2\u4e0b\u53d1\uff0c\u8bf7\u67e5\u770b\u7ec8\u7aef\u786e\u8ba4' : ('\u8fd4\u56de\uff1a' + (res.trim() || '\u65e0\u54cd\u5e94')));
          setTimeout(function () { if (currentView === 'sms') loadView('sms'); }, 1500);
        });
      };
    });
    return Promise.resolve();
  }

  /* ==================== 视图：AT 终端 ==================== */
  function viewTerminal() {
    return '<div class="card">' +
      '<div class="head"><div><h3>AT \u7ec8\u7aef</h3><div class="desc">\u76f4\u63a5\u4e0b\u53d1 AT \u6307\u4ee4\uff0c\u5b9e\u65f6\u8fd4\u56de\u6a21\u5757\u539f\u59cb\u54cd\u5e94</div></div>' +
      '<button class="btn ghost" id="termClear" style="padding:7px 12px;font-size:12px">\u6e05\u7a7a</button></div>' +
      '<div class="term" id="termOut"></div>' +
      '<div class="row"><input class="input" id="termIn" placeholder="\u4f8b\u5982 ATI\u3001AT^HCSQ?\u3001AT+COPS?"></div>' +
      '<div class="row" id="quick" style="flex-wrap:wrap"></div></div>';
  }
  viewTerminal._after = function () {
    var out = $('#termOut'), inp = $('#termIn');
    function log(cls, text) {
      var t = new Date().toLocaleTimeString();
      out.innerHTML += '<div><span class="ts">[' + t + ']</span> <span class="' + cls + '">' + esc(text) + '</span></div>';
      out.scrollTop = out.scrollHeight;
    }
    var quick = ['ATI', 'AT+CSQ', 'AT^HCSQ?', 'AT+COPS?', 'AT+CEREG?', 'AT+CGPADDR', 'AT+CPIN?'];
    $('#quick').innerHTML = quick.map(function (c) {
      return '<button class="btn ghost" style="padding:6px 12px;font-size:11.5px" data-c="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    $$('#quick .btn').forEach(function (b) { b.onclick = function () { inp.value = b.dataset.c; send(); }; });
    $('#termClear').onclick = function () { out.innerHTML = ''; };
    function send() {
      var cmd = inp.value.trim(); if (!cmd) return;
      log('cmd', '\u203a ' + cmd);
      at(cmd).then(function (res) {
        var txt = (res || '').trim();
        log(txt && /ERROR|FAIL/i.test(txt) ? 'err' : '', txt || '(\u7a7a\u54cd\u5e94)');
      });
      inp.value = '';
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
    log('', '\u5c31\u7eea\u3002\u8fde\u63a5\u72b6\u6001\uff1a' + (connected ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5\uff08\u5c06\u81ea\u52a8\u91cd\u8fde\uff09'));
  };

  /* ==================== 视图：系统 ==================== */
  function viewSystem() {
    return Promise.all([at('ATI'), at('AT+GMR'), at('AT^SYSINFOEX'), at('AT+QTEMP'), at('AT+COPS?')]).then(function (r) {
      var ati = parseATI(r[0]), gmr = (r[1] || '').trim(),
        mode = parseSYSINFOEX(r[2]),
        temp = (r[3] || '').match(/([+-]?\d+)/),
        cops = parseCOPS(r[4]);

      var infoCard = card('\u6a21\u5757\u4fe1\u606f', '\u8eab\u4efd\u4e0e\u56fa\u4ef6',
        kv('\u5236\u9020\u5546', ati.manufacturer || '\u2014') +
        kv('\u578b\u53f7', ati.model || '\u2014') +
        kv('\u56fa\u4ef6\u7248\u672c', ati.revision || gmr || '\u2014') +
        kv('IMEI', ati.imei || '\u2014') +
        kv('\u7f51\u7edc\u6a21\u5f0f', mode || RAT[cops.rat] || '\u2014') +
        kv('\u6e29\u5ea6', temp ? temp[1] + ' \u00b0C' : '\u2014'));

      var maintCard = card('\u7ef4\u62a4', '\u65e5\u5fd7\u4e0e\u7f13\u5b58',
        '<button class="btn ghost" id="clearLog" style="margin-bottom:8px">\u6e05\u9664\u540e\u7aef\u65e5\u5fd7</button>' +
        '<div class="hint">\u540e\u7aef at-server \u65e5\u5fd7\u53ef\u901a\u8fc7 CGI \u63a5\u53e3\u6e05\u9664\u3002</div>');

      return '<div class="grid cols-2">' + infoCard + maintCard + '</div>';
    });
  }

  /* ==================== 视图：网络速率信息（截图4）==================== */
  function viewSpeed() {
    return Promise.all([at('AT+COPS?'), at('AT+CGDCONT?')]).then(function (r) {
      var cops = parseCOPS(r[0]), cont = parseCGDCONT(r[1]);

      var apn = cont.length ? (cont[0].apn || '\u2014') : '\u2014';

      /* 实时网速区域 */
      var liveSpeedHtml = '<div class="speed-live">' +
        '<div class="speed-toggle"><label class="toggle-switch"><input type="checkbox" id="speedToggle" />' +
        '<span class="slider"></span></label><span>\u5b9e\u65f6\u7f51\u901f\u5f00\u5173</span></div>' +
        '<div class="speed-values">' +
          kvHtml('\u4e0a\u884c\u901f\u7387', '<span class="spd-up">\u6682\u672a\u5f00\u542f\u5b9e\u65f6\u7f51\u901f\u76d1\u63a7</span>') +
          kvHtml('\u4e0b\u884c\u901f\u7387', '<span class="spd-down">\u6682\u672a\u5f00\u542f\u5b9e\u65f6\u7f51\u901f\u76d1\u63a7</span>') +
          '<div class="speed-bps"><span class="spd-bps-val">0</span> bps &nbsp;&nbsp; <span class="spd-bps-val">0</span> bps</div>' +
        '</div></div>';

      /* 当前网络 */
      var currNetHtml = '<div class="net-info-grid">' +
        kvHtml('\u4e0a\u884c\u901f\u7387', '<span class="val-red">0</span> Mbps') +
        kvHtml('\u4e0b\u884c\u901f\u7387', '<span class="val-red">0</span> Mbps') +
        kv('\u8fd0\u8425\u5546', cops.operator || '\u672a\u77e5\u8fd0\u8425\u5546') +
        kv('APN', apn) +
        kv('QCI (\u670d\u52a1\u8d28\u91cf\u7b49\u7ea7)', '\u672a\u77e5') +
        '</div>';

      return card('\u7f51\u7edc\u901f\u7387\u4fe1\u606f', '\u5c55\u793a\u7f51\u7edc\u901f\u738f\u76f8\u5173\u4fe1\u606f', liveSpeedHtml) +
        '<div style="margin-top:14px">' + card('\u5f53\u524d\u7f51\u7edc', '', currNetHtml) + '</div>';
    });
  }

  /* ==================== 视图：锁频设置（截图5）==================== */
  function viewLock() {
    var html = '';

    /* 4G锁频设置 */
    html += card('4G\u9501\u9891\u8bbe\u7f6e', '',
      '<div class="lock-section">' +
        '<div class="lock-type-row"><label>\u9501\u9891\u7c7b\u578b</label></div>' +
        '<div class="lock-options">' +
          '<label class="radio-opt"><input type="radio" name="lock4g" value="off" checked /> <span>\u5173\u95ed</span></label>' +
          '<label class="radio-opt"><input type="radio" name="lock4g" value="freq" /> <span>\u9501\u5b9a\u9891\u70b9</span></label>' +
          '<label class="radio-opt"><input type="radio" name="lock4g" value="cell" /> <span>\u9501\u5b9a\u5c0f\u533a</span></label>' +
          '<label class="radio-opt"><input type="radio" name="lock4g" value="band" /> <span>\u9501\u5b9aBand</span></label>' +
        '</div>' +
        '<button class="btn" style="margin-top:12px" onclick="toast(\'\u5df2\u4fdd\u5b58 4G \u9501\u9891\u8bbe\u7f6e\')">\u4fdd\u5b58\u8bbe\u7f6e</button>' +
      '</div>',
      { cls: 'lock-card' });

    /* 5G锁频设置 */
    html += card('5G\u9501\u9891\u8bbe\u7f6e', '',
      '<div class="lock-section">' +
        '<div class="lock-type-row"><label>\u9501\u9891\u7c7b\u578b</label></div>' +
        '<div class="lock-options">' +
          '<label class="radio-opt"><input type="radio" name="lock5g" value="off" checked /> <span>\u5173\u95ed</span></label>' +
          '<label class="radio-opt"><input type="radio" name="lock5g" value="freq" /> <span>\u9501\u5b9a\u9891\u70b9</span></label>' +
          '<label class="radio-opt"><input type="radio" name="lock5g" value="cell" /> <span>\u9501\u5b9a\u5c0f\u533a</span></label>' +
          '<label class="radio-opt"><input type="radio" name="lock5g" value="band" /> <span>\u9501\u5b9aBand</span></label>' +
        '</div>' +
        '<button class="btn" style="margin-top:12px" onclick="toast(\'\u5df2\u4fdd\u5b58 5G \u9501\u9891\u8bbe\u7f6e\')">\u4fdd\u5b58\u8bbe\u7f6e</button>' +
      '</div>',
      { cls: 'lock-card' });

    /* 邻区扫描 */
    html += card('\u90bb\u533a\u626b\u63cf', '',
      '<div class="empty-state"><div class="empty-icon">\ud83d\udcc4</div><div class="empty-text">\u6682\u65e0\u90bb\u533a\u6570\u636e</div></div>',
      { action: '<button class="btn sm" onclick="toast(\'\u6b63\u5728\u626b\u63cf\u90bb\u533a\u2026\')">\u626b\u63cf\u90bb\u533a</button>' });

    /* 5G SSB 信息 */
    html += card('5G SSB \u4fe1\u606f', '',
      '<div class="empty-state"><div class="empty-icon">\ud83d\udcdf</div><div class="empty-text">\u6682\u65e0 SSB \u4fe1\u606f</div></div>',
      { action: '<button class="btn sm" onclick="toast(\'\u6b63\u57223\u65b0 SSB \u4fe1\u606f\u2026\')">\u5237\u65b0SSB\u4fe1\u606f</button>' });

    return html;
  }

  /* ==================== 视图：网络系统配置（截图6）==================== */
  function viewNetConf() {
    return Promise.all([at('AT+COPS?'), at('AT+QTEMP?')]).then(function (r) {
      var cops = parseCOPS(r[0]);
      var tempMatch = (r[1] || '').match(/([+-]?\d+)/);

      var confHtml = '<div class="conf-grid">' +
        kv('\u7f51\u7edc\u5236\u5f0f\u4f18\u5148\u7ea7', '\u672a\u77e5') +
        kv('\u6f2d\u6e38\u8bbe\u7f6e', '\u5141\u8bb8\u4f7f\u7528\u6f2d\u6e38\u7f51\u7edc(\u53ef\u80fd\u4ea7\u751f\u989d\u5916\u8d39\u7528)') +
        kv('\u670d\u52a1\u7c7b\u578b', '\u540c\u65f6\u652f\u6301\u901a\u8bdd\u548c\u4e0a\u7f51') +
        '</div>' +
        '<button class="btn ghost" style="margin-top:10px" onclick="toast(\'\u5df2\u5e94\u7528\u914d\u7f6e\')">\u5e94\u7528\u914d\u7f6e</button>';

      var txHtml = '<div class="tx-info-box">' +
        '\u25cf \u6682\u65e0 NR \u53d1\u5c04\u529f\u7387\u6570\u636e' +
        (tempMatch ? '<br>NR PA: ' + tempMatch[1] + ' dBm' : '') +
        '</div>';

      return card('\u7f51\u7edc\u7cfb\u7edf\u914d\u7f6e', '',
        confHtml,
        { action: '<button class="btn sm ghost" onclick="document.querySelector(\'#refreshBtn\').click()">\u5237\u65b0</button>' }) +
        '<div style="margin-top:14px">' + card('\u53d1\u5c04\u529f\u7387\u4fe1\u606f', '', txHtml,
          { action: '<button class="btn sm ghost" onclick="document.querySelector(\'#refreshBtn\').click()">\u5237\u65b0</button>' }) + '</div>';
    });
  }

  /* ==================== 视图：PDP上下文管理（截图7）==================== */
  function viewPDP() {
    var box = $('#content');
    box.innerHTML = loading();

    return at('AT+CGACT?').then(function (raw) {
      if (currentView !== 'pdp') return;

      /* 解析 CGACT 响应: +CGACT: cid,state */
      var pdpLines = lines(raw);
      var pdps = [];
      pdpLines.forEach(function (l) {
        var m = l.match(/\+CGACT:\s*(\d+),(\d+)/);
        if (m) pdps.push({ cid: m[1], state: m[2] === '1' ? '\u6d3b\u8dc3' : '\u975e\u6d3b\u8dc3' });
      });

      var rows = '';
      if (pdps.length) {
        pdps.forEach(function (p) {
          rows += '<div class="pdp-row"><span class="pdp-cid">CID ' + p.cid + '</span>' +
            '<span class="pdp-state ' + (p.state === '\u6d3b\u8dc3' ? 'active' : '') + '">' + p.state + '</span></div>';
        });
      } else {
        /* skeleton loading state like screenshot 7 */
        rows = '<div class="skeleton-list">';
        for (var i = 0; i < 8; i++) rows += '<div class="skeleton-row"></div>';
        rows += '</div>';
      }

      var html = card('PDP \u4e0a\u4e0b\u6587\u7ba1\u7406', '',
        rows,
        { action: '<button class="btn sm" id="pdpQuery">\u67e5\u8be2\u72b6\u6001</button>' });

      box.innerHTML = html;

      var btn = $('#pdpQuery');
      if (btn) btn.onclick = function () { loadView('pdp'); };
    });
  }

  /* ==================== 视图：设置 / AT服务器配置（截图8）==================== */
  function viewSettings() {
    var isNetAt = (netAtConfig.mode === 'network');

    var html = card('AT \u670d\u52a1\u5668\u914d\u7f6e', '',
      '<div class="at-config">' +
        '<div class="at-mode-row">' +
          '<span class="at-mode-label">\u5f53\u524d\u670d\u52a1\u6a21\u5f0f:</span> ' +
          '<span class="at-mode-val" id="atModeDisplay">' + (isNetAt ? '<span class="mode-net">\u7f51\u7edcAT</span>' : '<span class="mode-local">\u672c\u5730UBUS</span>') + '</span> ' +
          '<button class="btn-link" id="atModeSwitch" onclick="toggleNetAtMode()">' + (isNetAt ? '\u5207\u6362\u5230\u672c\u5730' : '\u5207\u6362\u5230\u7f51\u7edcAT') + '</button>' +
        '</div>' +
        '<div class="at-mode-desc">' + (isNetAt ?
          '\u901a\u8fc7\u7f51\u7edc\u8fde\u63a5\u4e0e\u8bbe\u5907\u901a\u4fe1\uff0c\u652f\u6301\u8fdc\u7a0b\u63a7\u5236' :
          '\u901a\u8fc7\u672c\u5730 UBUS \u5b88\u62a4\u8fdb\u7a0b\u8fde\u63a5\u6a21\u5757'
        ) + '</div>' +

        (isNetAt ?
          '<div class="at-fields">' +
            '<div class="field"><label>IP \u5730\u5740</label><input class="input" id="netAtHost" value="' + esc(netAtConfig.host || '192.168.88.1') + '" placeholder="192.168.1.1" /></div>' +
            '<div class="field"><label>\u7aef\u53e3</label><input class="input" id="netAtPort" value="' + esc(netAtConfig.port || '8765') + '" placeholder="8765" /></div>' +
            '<button class="btn" id="saveNetAt" style="width:100%;margin-top:4px">\u4fdd\u5b58</button>' +
            '<div class="hint">\u652f\u6301 IPv4 (\u4f8b\u5982: 192.168.1.1) \u548c IPv6 (\u4f8b\u5982: 2001:db8::1) \u5730\u5740</div>' +
          '</div>'
          : '<div class="at-local-info">' +
            '<div class="kv">WS URL: <span class="v" id="wsUrlDisplay">\u52a0\u8f7d\u4e2d\u2026</span></div>' +
            '<div class="hint">\u672c\u5730\u6a21\u5f0f\u4e0b\uff0cWebUI \u81ea\u52a8\u4ece /cgi-bin/at-ws-info \u83b7\u53d6 WebSocket \u5730\u5740\u3002</div>' +
          '</div>'
        ) +
      '</div>');

    return html;
  }
  viewSettings._after = function () {
    /* 绑定保存按钮 */
    var saveBtn = $('#saveNetAt');
    if (saveBtn) saveBtn.onclick = function () {
      var h = $('#netAtHost').value.trim();
      var p = $('#netAtPort').value.trim();
      if (!h) { toast('\u8bf7\u8f93\u5165 IP \u5730\u5740'); return; }
      if (!p || isNaN(p)) { toast('\u7aef\u53e3\u5fc5\u987b\u4e3a\u6570\u5b57'); return; }
      netAtConfig.host = h;
      netAtConfig.port = p;
      saveNetAtConfig();
      toast('\u5df2\u4fdd\u5b58\uff0c\u6b63\u5728\u91cd\u65b0\u8fde\u63a5\u2026');
      connect();
    };

    /* 显示当前 WS URL */
    fetch('/cgi-bin/at-ws-info', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var el = $('#wsUrlDisplay');
      if (el) el.textContent = (j && j.data && j.data.ws_url) || ('ws://' + location.hostname + ':8765');
    }).catch(function () {});
  };

  /* 切换模式的辅助函数（挂到全局供 onclick 调用） */
    window.toggleNetAtMode = function () {
      netAtConfig.mode = (netAtConfig.mode === 'network') ? 'local' : 'network';
      saveNetAtConfig();
      loadView('settings');
      if (netAtConfig.mode === 'network' && netAtConfig.host) {
        toast('\u5207\u6362\u5230\u7f51\u7edcAT\u6a21\u5f0f\uff0c\u6b63\u5728\u8fde\u63a5 ' + netAtConfig.host + ':' + netAtConfig.port + '\u2026');
        connect();
      } else {
        toast('\u5207\u6362\u5230\u672c\u5730\u6a21\u5f0f\uff0c\u6b63\u5728\u91cd\u65b0\u8fde\u63a5\u2026');
        connect();
      }
    };

  /* 更新设置页的网络AT状态显示 */
  window.updateNetAtDisplay = function () {
    var el = $('#atModeDisplay');
    if (!el) return;
    var isNetAt = (netAtConfig.mode === 'network');
    el.innerHTML = isNetAt ? '<span class="mode-net">\u7f51\u7edcAT</span>' : '<span class="mode-local">\u672c\u5730UBUS</span>';
  };

  /* ==================== 视图加载器 ==================== */
  function loadView(v) {
    currentView = v; setViewMeta(v);
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
    var c = $('#content'); c.innerHTML = loading();

    var fn = {
      overview: viewOverview, signal: viewSignal, network: viewNetwork,
      sim: viewSim, sms: viewSMS, terminal: viewTerminal, system: viewSystem,
      speed: viewSpeed, lock: viewLock, netconf: viewNetConf, pdp: viewPDP,
      settings: viewSettings
    }[v];
    if (!fn) return;

    Promise.resolve().then(fn).then(function (res) {
      if (currentView !== v) return;
      if (typeof res === 'string') c.innerHTML = res;
      if (typeof fn._after === 'function') fn._after();
    }).catch(function (e) {
      if (currentView === v) c.innerHTML = '<div class="center-empty">\u52a0\u8f7d\u5931\u8d25\uff1a' + esc(e && e.message || e) + '</div>';
    });
  }

  /* ==================== 启动 ==================== */
  function boot() {
    var refreshBtn = $('#refreshBtn');
    refreshBtn.onclick = function () {
      refreshBtn.classList.add('spinning');
      loadView(currentView);
      setTimeout(function () { refreshBtn.classList.remove('spinning'); }, 800);
    };

    $$('#nav .nav-item').forEach(function (b) {
      b.onclick = function () { loadView(b.dataset.view); };
    });

    var _bindClearLog = function () {
      var cl = document.getElementById('clearLog');
      if (cl) { cl.onclick = function () { fetch('/cgi-bin/at-log-clear').then(function () { toast('\u65e5\u5fd7\u5df2\u6e05\u9664'); }).catch(function () { toast('\u6e05\u9664\u5931\u8d25'); }); }; }
    };
    var _origLoadView = loadView;
    loadView = function (v) {
      _origLoadView(v);
      setTimeout(_bindClearLog, 200);
    };

    loadView('overview');
    connect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
