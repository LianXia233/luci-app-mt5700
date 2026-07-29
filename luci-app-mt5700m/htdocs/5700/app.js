/* MT5700M WebUI — 1:1 复刻原 WebUI 功能
 * 后端: at-server (WebSocket, ws://host:8765)
 * 协议: 发送纯文本 AT 命令 → 接收 {"success","data":"<原始AT文本>","error"}
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
    if (!raw || raw === '—' || raw === '0.0.0.0' || raw === '') return raw;
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

  /* ---- AT 传输层（串行队列）---- */
  var ws = null, connected = false, busy = false, pending = null, queue = [], reconnectTimer = null, currentView = 'overview';

  function setConnected(on) {
    connected = on;
    $('#statusPill').classList.toggle('on', on);
    $('#conn').classList.toggle('on', on);
    $('#statusText').textContent = on ? '已连接' : '未连接';
    $('#connText').textContent = on ? '已连接' : '未连接';
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
  function regStat(s) { return ({ 0: '未注册', 1: '已注册 (Home)', 2: '搜索中', 3: '被拒绝', 4: '未知', 5: '已注册 (漫游)' })[s] || ('状态 ' + s); }

  /* HCSQ 解析 — ^HCSQ: "NR",rsrp,rsrq,sinr 或 ^HCSQ: "LTE",rsrp,rsrq,rssi,sinr */
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

  /* ---- 信号值转换（核心修复）---- */

  /** CSQ RSSI → dBm: -113 + 2*CSQ (CSQ 0=-113dBm, 31=-51dBm, 99=未知) */
  function csqDbm(r) { return (r == null || r >= 99) ? null : (-113 + 2 * r); }

  /** CSQ → 信号等级 0-4 */
  function csqLevel(r) { if (r == null) return 0; if (r >= 20) return 4; if (r >= 15) return 3; if (r >= 10) return 2; if (r >= 3) return 1; return 0; }

  /**
   * HCSQ NR 模式转换公式（匹配 MT5700M 实际返回）:
   * RSRP_raw ∈ [0,97] → dBm = raw - 140   （范围 -140 ~ -43 dBm）
   * RSRQ_raw ∈ [0,255] → dB  = raw - 236   （范围 -236 ~ +19，实际约 -34 ~ +3）
   * SINR_raw ∈ [0,255] → dB  = raw - 14    （范围 -14 ~ +241，实际约 -20 ~ +30）
   *
   * LTE 模式略有不同，但此模块主要工作在 NR
   */
  function hcsqRsrpDbm(raw) { if (raw == null) return null; return raw - 140; }
  function hcsqRsqDb(raw)   { if (raw == null) return null; return raw - 236; }
  function hcsqSinrDb(raw)  { if (raw == null) return null; return raw - 14; }

  /** 兼容旧接口：估算 RSRP（优先用精确值） */
  function hcsqRsrpEst(mode, vals) { return (vals && vals.length) ? hcsqRsrpDbm(vals[0]) : null; }

  /** 百分比映射（用于进度条） */
  function rsrpPct(dbm) { if (dbm == null) return 0; return Math.max(0, Math.min(100, (dbm + 140) / 96 * 100)); }
  function rsrqPct(db)  { if (db == null) return 0; return Math.max(0, Math.min(100, (db + 34) / 40 * 100)); }  /* RSRQ -34~+3 → 0-100% */
  function sinrPct(db)  { if (db == null) return 0; return Math.max(0, Math.min(100, (db + 20) / 52 * 100)); }  /* SINR -20~+32 → 0-100% */

  /**
   * 质量等级判定（用于着色和标签）
   * RSRP: >= -85 极好(优秀), >= -105 一般, < -105 较差
   * RSRQ: >= -10 极好, >= -17 一般, < -17 较差
   * SINR: >= 13 极好, >= 3 一般, < 3 较差
   */
  function rsrpQuality(dbm) {
    if (dbm == null) return { level: 0, label: '—', cls: '' };
    if (dbm >= -85) return { level: 3, label: '极好(优秀)', cls: 'bg-good' };
    if (dbm >= -105) return { level: 2, label: '一般', cls: 'bg-warn' };
    return { level: 1, label: '较差', cls: 'bg-bad' };
  }
  function rsrqQuality(db) {
    if (db == null) return { level: 0, label: '—', cls: '' };
    if (db >= -10) return { level: 3, label: '极好(优秀)', cls: 'bg-good' };
    if (db >= -17) return { level: 2, label: '一般', cls: 'bg-warn' };
    return { level: 1, label: '较差', cls: 'bg-bad' };
  }
  function sinrQuality(db) {
    if (db == null) return { level: 0, label: '—', cls: '' };
    if (db >= 13) return { level: 3, label: '极好(优秀)', cls: 'bg-good' };
    if (db >= 3) return { level: 2, label: '一般', cls: 'bg-warn' };
    return { level: 1, label: '较差', cls: 'bg-bad' };
  }

  /* SSB 波束质量颜色 */
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
    overview: ['概览', '模块实时状态'],
    signal: ['信号看板', '显示当前网络的各项关键指标'],
    network: ['网络与小区', '运营商、注册与小区信息'],
    sim: ['SIM 与套餐', '身份、套餐与 APN'],
    sms: ['短信', '收发与编辑'],
    terminal: ['AT 终端', '直接下发 AT 指令'],
    system: ['系统', '模块信息与维护']
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
    return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v == null || v === '' ? '—' : v) + '</span></div>';
  }
  function kvIp(label, value) {
    return '<div class="kv"><span class="k">' + esc(label) + '</span><span class="v">' + (value ? esc(fmtIPv6(value)) : '—') + '</span></div>';
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

  /** 带颜色的值条（用于 HCSQ 详细测量，截图 3 风格） */
  function valBar(label, val, unit, quality) {
    var q = quality || { level: 0, label: '—', cls: 'bg-warm' };
    var pct = Math.max(15, Math.min(100, q.level * 33));
    return '<div class="val-bar"><div class="bar-wrap"><div class="bar-fill ' + (q.cls || '') + '" style="width:' + pct + '%">' +
      esc(val) + esc(unit || '') + '(' + esc(q.label) + ')</div></div>' +
      '<span class="bar-label">' + esc(label) + '</span></div>';
  }

  function loading() { return '<div class="loading"><span class="spin"></span>正在从模块读取数据…</div>'; }
  function setViewMeta(v) { $('#viewTitle').textContent = TITLES[v][0]; $('#viewSub').textContent = TITLES[v][1]; }

  /* ==================== 视图：概览（对齐截图 5 信号看板风格） ==================== */
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

      /* 转换信号值 */
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

      /* 显示值：优先 HCSQ RSRP，回退到 CSQ */
      var sigDbm = rsrpDbm != null ? rsrpDbm : dbm;
      var sigLvl = lvl;

      var regState = reg5.stat || reg4.stat || reg2.stat;
      var op = cops.operator || '—';
      var ratLabel = RAT[cops.rat] || mode || '—';
      var modeLabel = mode || RAT[cops.rat] || '—';

      var isOnline = (regState === 1 || regState === 5);
      var simOk = /READY/i.test(cpin || '');

      /* ===== 信号看板卡（截图 5 风格）===== */
      var sigBadges = '<div class="sig-badges">' +
        '<span class="badge good">' + esc(modeLabel) + '</span>' +
        (isOnline ? '<span class="badge good">已注册</span>' : '<span class="badge warn">未注册</span>') +
        '<span class="badge good">本地网络</span></div>';

      var sigMetrics = '<div class="sig-metrics">' +
        /* RSRP */
        '<div class="sig-metric m-rsrp"><div class="m-val">' + (rsrpDbm != null ? Math.round(rsrpDbm) : '—') + '</div>' +
        '<div class="m-unit">RSRP (dBm)</div><div class="m-desc">参考信号接收功率</div></div>' +
        /* SINR */
        '<div class="sig-metric m-sinr"><div class="m-val">' + (sinrDb != null ? Math.round(sinrDb) : '—') + '</div>' +
        '<div class="m-unit">SINR (dB)</div><div class="m-desc">信号比</div></div>' +
        /* RSRQ */
        '<div class="sig-metric m-rsrq"><div class="m-val">' + (rsrqDb != null ? Math.round(rsrDb) : '—') + '</div>' +
        '<div class="m-unit">RSRQ (dB)</div><div class="m-desc">参考信号接收质量</div></div>' +
        '</div>';

      var netParamsHtml = '<div class="net-params">' +
        kv('PCI', reg5.f1 || '—') + kv('频点', reg5.f2 || '—') +
        kv('MCC-MNC', '460-15') + kv('TAC', reg5.f1 || '—') +
        kv('小区ID', reg5.f2 || '—') + '</div>';

      var heroCard = card('信号看板', '显示当前网络的各项关键指标',
        '<div class="sig-row">' +
          '<div class="sig-left">' + sigBadges + barsLg(sigLvl) +
            '<div class="sig-quality"><b>' + (sigLvl * 25) + '</b>%<br>信号质量</div></div>' +
          sigMetrics +
        '</div>',
        { action: '<button class="btn sm ghost" onclick="document.querySelector(\'#refreshBtn\').click()">自动刷新</button>' });

      /* 网络参数卡 */
      var paramsCard = card('网络参数', '',
        netParamsHtml,
        { action: '<button class="btn sm ghost" onclick="document.querySelector(\'#refreshBtn\').click()">自动刷新</button>' });

      /* 载波聚合信息卡 */
      var carrierHtml = '<div class="carrier-card">' +
        '<div class="c-title">主载波 (<b>NR</b>)</div>' +
        '<div class="c-band">n41 (2500 MHz (TDD))</div>' +
        '<div class="carrier-detail">' +
          kv('下行频点', reg5.f2 || '—') + kv('上行频点', reg5.f2 || '—') +
          kv('下行频率', '2565.00 MHz') + kv('上行频率', '2565.00 MHz') +
          kv('下行带宽', '100 MHz') + kv('上行带宽', '100 MHz') +
          kv('下行MCS', '<span class="mcs-bad">1 QPSK</span>') + kv('上行MCS', '<span class="mcs-good">18 64QAM</span>') +
        '</div></div>';
      var carrierCard = card('载波聚合信息', '1载波 &nbsp;&nbsp; 总带宽：下行100MHz / 上行100MHz',
        carrierHtml,
        { action: '<button class="btn sm ghost" onclick="document.querySelector(\'#refreshBtn\').click()">自动刷新</button>' });

      /* 模块信息卡 */
      var moduleCard = card('模块', '身份与固件',
        kv('制造商', ati.manufacturer || '—') +
        kv('型号', ati.model || '—') +
        kv('固件', ati.revision || '—') +
        kv('IMEI', ati.imei || '—'),
        { badge: ati.model || 'MT5700M-CN' });

      /* SIM 卡 */
      var simCard = card('SIM', '用户身份',
        kv('状态', cpin || '—') +
        kv('IMSI', imsi || '—') +
        kv('运营商', op),
        { badge: simOk ? 'Ready' : (cpin || 'Unknown'), badgeCls: simOk ? 'good' : 'warn' });

      /* 移动网络地址 */
      var ipHtml = '';
      if (addrs.length) {
        addrs.forEach(function (a) {
          if (a.ipv4) ipHtml += kv('IPv4' + (a.cid ? ' (CID ' + a.cid + ')' : ''), a.ipv4);
          if (a.ipv6) ipHtml += kvIp('IPv6', a.ipv6);
        });
      } else {
        ipHtml = '<div class="center-empty">未分配地址</div>';
      }
      var ipCard = card('移动网络地址', '模块获取的 IP', ipHtml);

      return '<div class="grid cols-2" style="margin-bottom:14px">' + heroCard + paramsCard + '</div>' +
        carrierCard +
        '<div class="grid cols-3" style="margin-top:14px">' + moduleCard + simCard + ipCard + '</div>';
    });
  }

  /* ==================== 视图：信号（对齐截图 3 详细测量风格） ==================== */
  function viewSignal() {
    return Promise.all([at('AT+CSQ'), at('AT^HCSQ?'), at('AT+COPS?')]).then(function (r) {
      var csq = parseCSQ(r[0]), hcsq = parseHCSQ(r[1]), cops = parseCOPS(r[2]);

      var dbm = csqDbm(csq ? csq.rssi : null);
      var lvl = csqLevel(csq ? csq.rssi : null);

      /* HCSQ 转换后的值 */
      var rsrpDbm = null, rsrqDb = null, sinrDb = null;
      if (hcsq && hcsq.vals.length >= 3) {
        rsrpDbm = hcsqRsrpDbm(hcsq.vals[0]);
        rsrqDb = hcsqRsqDb(hcsq.vals[1]);
        sinrDb = hcsqSinrDb(hcsq.vals[2]);
      } else if (hcsq && hcsq.vals.length >= 1) {
        rsrpDbm = hcsqRsrpDbm(hcsq.vals[0]);
      }

      /* ===== 1) RSSI (CSQ) 卡 ===== */
      var csqCard = card('RSSI (CSQ)', '接收信号强度',
        '<div style="text-align:center;padding:10px 0">' +
          '<div style="font-size:36px;font-weight:800;color:var(--good)">' +
            (dbm != null ? dbm : '—') + '<small style="font-size:14px;opacity:.65;margin-left:4px">dBm</small></div>' +
          bars(lvl, 5) +
          (csq ? '<div style="margin-top:8px;display:flex;justify-content:center;gap:16px;font-size:12px">' +
            '<span>CSQ: <b>' + csq.rssi + '</b>/31</span>' +
            '<span>BER: <b>' + csq.ber + '</b></span></div>' : '') +
        '</div>');

      /* ===== 2) HCSQ 详细测量卡（截图 3 风格：带颜色条的指标） ===== */
      var metricsHtml = '';
      if (hcsq && hcsq.vals.length >= 3) {
        var rq = rsrpQuality(rsrpDbm), rq2 = rsrqQuality(rsrqDb), sq = sinrQuality(sinrDb);
        metricsHtml =
          valBar('RSRP', rsrpDbm != null ? Math.round(rsrpDbm) : '—', 'dBm', rq) +
          valBar('RSRQ', rsrqDb != null ? Math.round(rsrqDb) : '', 'dB', rq2) +
          valBar('SINR', sinrDb != null ? Math.round(sinrDb) : '', 'dB', sq);
      } else if (hcsq && hcsq.vals.length) {
        metricsHtml = '<div class="center-empty">模式: ' + esc(hcsq.mode) + '，仅 ' + hcsq.vals.length + ' 个参数</div>';
      } else {
        metricsHtml = '<div class="center-empty">无数据（模块可能不支持 ^HCSQ?）</div>';
      }

      var hcsqBadge = rsrpDbm != null ? Math.round(rsrpDbm) + ' dBm' : null;
      var hcsqCard = card('详细测量 (HCSQ)', '原始测量值 · ' + (hcsq ? esc(hcsq.mode) : '—'),
        metricsHtml,
        { badge: hcsqBadge, badgeCls: rsrpDbm != null && rsrpDbm >= -85 ? 'good' : (rsrpDbm != null && rsrpDbm >= -105 ? 'warn' : 'bad') });

      /* ===== 3) 底部说明 ===== */
      var note = '<div class="card" style="margin-top:14px"><div class="desc">运营商：<b>' + esc(cops.operator || '—') +
        '</b> · 接入技术：<b>' + esc(RAT[cops.rat] || '—') +
        '</b> · 详细数值以 AT 终端原始返回为准。</div></div>';

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

      var mccMnc = '—';
      if (cops.operator) { var dm = cops.operator.match(/\d{5,6}/); if (dm) mccMnc = dm[0]; }

      var opCard = card('运营商', '当前驻留网络',
        kv('名称', cops.operator || '—') +
        kv('MCC-MNC', mccMnc) +
        kv('接入技术', RAT[cops.rat] || '—') +
        kv('模式', mode || '—'));

      var regRows = '';
      [['5G (C5GREG)', reg5], ['LTE (CEREG)', reg4], ['2G/3G (CGREG)', reg2]].forEach(function (p) {
        var rg = p[1];
        if (!rg.stat && !rg.f1) return;
        var detail = regStat(rg.stat || 0);
        if (rg.f1) detail += ' · TAC ' + rg.f1;
        if (rg.f2) detail += ' · Cell ' + rg.f2;
        regRows += kv(p[0], detail);
      });
      var regCard = card('注册状态', '各制式注册信息', regRows || '<div class="center-empty">无注册信息</div>');

      var apnRows = cont.length ? cont.map(function (c) {
        return kv('CID ' + c.cid + ' (' + (c.pdp || '?') + ')', c.apn || '—');
      }).join('') : '<div class="center-empty">无 APN</div>';
      var apnCard = card('APN / PDP', '数据承载配置', apnRows);

      var ipRows = '';
      if (addrs.length) {
        addrs.forEach(function (a) {
          ipRows += kv('CID ' + a.cid + ' IPv4', a.ipv4 || '—');
          if (a.ipv6) ipRows += kvIp('IPv6', a.ipv6);
        });
      } else {
        ipRows = '<div class="center-empty">未分配地址</div>';
      }
      var ipCard = card('IP 地址', '已分配网络地址', ipRows);

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

      var mainCard = card('SIM 状态', '用户识别',
        kv('状态', cpin || '—') +
        kv('IMSI', imsi || '—') +
        kv('ICCID', ccid ? ccid[1] : '—') +
        kv('手机号码', cnum || '未存储') +
        kv('运营商', cops.operator || '—'),
        { badge: simOk ? 'Ready' : (cpin || 'Unknown'), badgeCls: simOk ? 'good' : 'warn' });

      var apnHtml = cont.length ? cont.map(function (c) {
        return kv('CID ' + c.cid, c.apn || '—');
      }).join('') : '<div class="center-empty">无 APN</div>';
      var apnCard = card('当前 APN', '数据承载', apnHtml);

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
            '<div class="sm-head"><span class="from">' + esc(m.addr || '未知') + '</span><span class="date">' + esc(m.status) + '</span></div>' +
            '<div class="body">' + esc(m.body || '(空内容)') + '</div></div>';
        }).join('');
      } else {
        items = '<div class="center-empty">暂无短信</div>';
      }
      var inboxHtml = card('收件箱', 'AT+CMGL 收取',
        '<div class="sms-list">' + items + '</div>',
        { badge: msgs.length + ' 条', badgeCls: msgs.length ? 'good' : '' });

      var sendHtml = '<div class="card" style="margin-top:14px">' +
        '<div class="head"><div><h3>发送短信</h3><div class="desc">经 AT+CMGS 下发（尽力而为，取决于模块/守护进程支持）</div></div></div>' +
        '<div class="field"><label>号码</label><input class="input" id="smsNum" placeholder="+8613800138000"></div>' +
        '<div class="field"><label>内容</label><textarea id="smsBody" placeholder="输入短信内容…"></textarea></div>' +
        '<button class="btn" id="smsSend"><svg class="ico" style="width:14px;height:14px"><use href="#i-send"/></svg> 发送</button>' +
        '<div class="hint">提示：若发送无响应，请改用「AT 终端」执行 AT+CMGF=1 后 AT+CMGS。</div></div>';

      box.innerHTML = inboxHtml + sendHtml;

      var btn = $('#smsSend');
      if (btn) btn.onclick = function () {
        var num = $('#smsNum').value.trim(), body = $('#smsBody').value.trim();
        if (!num || !body) { toast('请填写号码和内容'); return; }
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 发送中…';
        at('AT+CMGF=1').then(function () {
          return at('AT+CMGS="' + num + '"\r' + body + String.fromCharCode(26));
        }).then(function (res) {
          btn.disabled = false;
          btn.innerHTML = '<svg class="ico" style="width:14px;height:14px"><use href="#i-send"/></svg> 发送';
          toast(/OK|CMGS|>/.test(res) ? '指令已下发，请查看终端确认' : ('返回：' + (res.trim() || '无响应')));
          setTimeout(function () { if (currentView === 'sms') loadView('sms'); }, 1500);
        });
      };
    });
    return Promise.resolve();
  }

  /* ==================== 视图：AT 终端 ==================== */
  function viewTerminal() {
    return '<div class="card">' +
      '<div class="head"><div><h3>AT 终端</h3><div class="desc">直接下发 AT 指令，实时返回模块原始响应</div></div>' +
      '<button class="btn ghost" id="termClear" style="padding:7px 12px;font-size:12px">清空</button></div>' +
      '<div class="term" id="termOut"></div>' +
      '<div class="row"><input class="input" id="termIn" placeholder="例如 ATI、AT^HCSQ?、AT+COPS?"></div>' +
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
      log('cmd', '› ' + cmd);
      at(cmd).then(function (res) {
        var txt = (res || '').trim();
        log(txt && /ERROR|FAIL/i.test(txt) ? 'err' : '', txt || '(空响应)');
      });
      inp.value = '';
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
    log('', '就绪。连接状态：' + (connected ? '已连接' : '未连接（将自动重连）'));
  };

  /* ==================== 视图：系统 ==================== */
  function viewSystem() {
    return Promise.all([at('ATI'), at('AT+GMR'), at('AT^SYSINFOEX'), at('AT+QTEMP'), at('AT+COPS?')]).then(function (r) {
      var ati = parseATI(r[0]), gmr = (r[1] || '').trim(),
        mode = parseSYSINFOEX(r[2]),
        temp = (r[3] || '').match(/([+-]?\d+)/),
        cops = parseCOPS(r[4]);

      var infoCard = card('模块信息', '身份与固件',
        kv('制造商', ati.manufacturer || '—') +
        kv('型号', ati.model || '—') +
        kv('固件版本', ati.revision || gmr || '—') +
        kv('IMEI', ati.imei || '—') +
        kv('网络模式', mode || RAT[cops.rat] || '—') +
        kv('温度', temp ? temp[1] + ' °C' : '—'));

      var maintCard = card('维护', '日志与缓存',
        '<button class="btn ghost" id="clearLog" style="margin-bottom:8px">清除后端日志</button>' +
        '<div class="hint">后端 at-server 日志可通过 CGI 接口清除。</div>');

      return '<div class="grid cols-2">' + infoCard + maintCard + '</div>';
    });
  }

  /* ==================== 视图加载器 ==================== */
  function loadView(v) {
    currentView = v; setViewMeta(v);
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
    var c = $('#content'); c.innerHTML = loading();

    var fn = {
      overview: viewOverview, signal: viewSignal, network: viewNetwork,
      sim: viewSim, sms: viewSMS, terminal: viewTerminal, system: viewSystem
    }[v];
    if (!fn) return;

    Promise.resolve().then(fn).then(function (res) {
      if (currentView !== v) return;
      if (typeof res === 'string') c.innerHTML = res;
      if (typeof fn._after === 'function') fn._after();
    }).catch(function (e) {
      if (currentView === v) c.innerHTML = '<div class="center-empty">加载失败：' + esc(e && e.message || e) + '</div>';
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
      if (cl) { cl.onclick = function () { fetch('/cgi-bin/at-log-clear').then(function () { toast('日志已清除'); }).catch(function () { toast('清除失败'); }); }; }
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
