/* MT5700M WebUI — VisionOS style frontend
 * Talks to the at-server backend over WebSocket (ws://host:8765).
 * Protocol: send plain-text AT command, receive {"success", "data": "<raw AT text>", "error"}.
 */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---------------- AT transport (single sequential channel) ---------------- */
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

  /* ---------------- Parsers ---------------- */
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
  function parseHCSQ(t) {
    var m = String(t || '').match(/^\^HCSQ:\s*"([^"]*)"\s*,?\s*(.*)$/m);
    if (!m) return null;
    var vals = m[2].split(',').map(function (s) { return parseFloat(s.trim()); }).filter(function (v) { return !isNaN(v); });
    return { mode: m[1], vals: vals };
  }
  function parseCSQ(t) {
    var m = String(t || '').match(/\+CSQ:\s*(\d+),(\d+)/);
    if (!m) return null;
    return { rssi: +m[1], ber: +m[2] };
  }
  function csqDbm(r) { return (r == null || r >= 99) ? null : (-113 + 2 * r); }
  function csqLevel(r) { if (r == null) return 0; if (r >= 20) return 4; if (r >= 15) return 3; if (r >= 10) return 2; if (r >= 3) return 1; return 0; }
  function hcsqRsrpEst(mode, vals) { if (!vals || !vals.length) return null; return vals[0] - 140; } // common Quectel/TD-Tech offset
  function rsrpPct(dbm) { if (dbm == null) return 0; return Math.max(0, Math.min(100, (dbm + 140) / 96 * 100)); }
  function parseCPIN(t) { var m = String(t || '').match(/\+CPIN:\s*"?([A-Z ]+)"?/); return m ? m[1].trim() : null; }
  function parseCIMI(t) { var m = String(t || '').match(/(\d{10,20})/); return m ? m[1] : null; }
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
    var hit = s.match(/(NR-?5G|LTE|NSA|SA|EN-DC|WCDMA|GSM)[A-Z0-9-]*/i);
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

  /* ---------------- Rendering helpers ---------------- */
  var TITLES = {
    overview: ['概览', '模块实时状态'],
    signal: ['信号', '实时无线质量'],
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
      (opts.badge ? '<span class="badge ' + (opts.badgeCls || '') + '">' + esc(opts.badge) + '</span>' : '') + '</div>' + inner + '</section>';
  }
  function kv(k, v) { return '<div class="kv"><span>' + esc(k) + '</span><b>' + esc(v == null || v === '' ? '—' : v) + '</b></div>'; }
  function bars(n, total) {
    total = total || 5; var h = '';
    for (var i = 0; i < total; i++) h += '<i class="' + (i < n ? 'on' : '') + '" style="height:' + (28 + i * 12) + '%"></i>';
    return '<div class="bars">' + h + '</div>';
  }
  function loading() { return '<div class="loading"><span class="spin"></span>正在从模块读取数据…</div>'; }
  function setViewMeta(v) { $('#viewTitle').textContent = TITLES[v][0]; $('#viewSub').textContent = TITLES[v][1]; }

  /* ---------------- Views ---------------- */
  function loadView(v) {
    currentView = v; setViewMeta(v);
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
    var c = $('#content'); c.innerHTML = loading();
    var fn = { overview: viewOverview, signal: viewSignal, network: viewNetwork, sim: viewSim, sms: viewSMS, terminal: viewTerminal, system: viewSystem }[v];
    if (!fn) return;
    Promise.resolve().then(fn).then(function (res) {
      if (currentView !== v) return;
      if (typeof res === 'string') c.innerHTML = res;
      if (typeof fn._after === 'function') fn._after();
    }).catch(function (e) { if (currentView === v) c.innerHTML = '<div class="center-empty">加载失败：' + esc(e && e.message || e) + '</div>'; });
  }

  function viewOverview() {
    return Promise.all([at('ATI'), at('AT+COPS?'), at('AT+C5GREG?'), at('AT+CEREG?'), at('AT+CGREG?'), at('AT+CPIN?'), at('AT+CIMI'), at('AT+CSQ'), at('AT^HCSQ?'), at('AT+CGPADDR'), at('AT^SYSINFOEX')]).then(function (r) {
      var ati = parseATI(r[0]), cops = parseCOPS(r[1]), reg5 = parseReg(r[2], 'C5GREG'), reg4 = parseReg(r[3], 'CEREG'), reg2 = parseReg(r[4], 'CGREG'),
        cpin = parseCPIN(r[5]), imsi = parseCIMI(r[6]), csq = parseCSQ(r[7]), hcsq = parseHCSQ(r[8]), addrs = parseCGPADDR(r[9]), mode = parseSYSINFOEX(r[10]);
      var dbm = csqDbm(csq ? csq.rssi : null), rsrpEst = hcsqRsrpEst(hcsq && hcsq.mode, hcsq && hcsq.vals);
      var sigVal = dbm != null ? dbm + ' dBm' : (rsrpEst != null ? '≈ ' + rsrpEst + ' dBm' : '—');
      var sigLvl = dbm != null ? csqLevel(csq.rssi) : (rsrpEst != null ? csqLevel(Math.round((rsrpEst + 113) / 2)) : 0);
      var regState = reg5.stat || reg4.stat || reg2.stat;
      var op = cops.operator || '—';

      var hero = '<section class="card hero">' +
        '<div class="head"><div><h3>实时信号</h3></div><span class="badge" style="background:rgba(255,255,255,.2);color:#fff">' + esc(mode || (RAT[cops.rat] || '—')) + '</span></div>' +
        '<div class="big">' + esc(sigVal) + (csq && csq.rssi != null ? '<small>CSQ ' + csq.rssi + '</small>' : (hcsq ? '<small>HCSQ ' + esc(hcsq.mode) + '</small>' : '')) + '</div>' +
        bars(sigLvl) +
        '<div class="meta"><span>运营商<b>' + esc(op || '—') + '</b></span><span>网络模式<b>' + esc(mode || (RAT[cops.rat] || '—')) + '</b></span><span>注册<b>' + esc(regStat(regState || 0)) + '</b></span></div>' +
        '</section>';

      var module = card('模块', '身份与固件',
        kv('制造商', ati.manufacturer) + kv('型号', ati.model) + kv('固件', ati.revision) + kv('IMEI', ati.imei),
        { badge: ati.model || 'MT5700M' });

      var net = card('网络', '运营商与注册',
        kv('运营商', op) + kv('接入技术', RAT[cops.rat] || (mode || '—')) + kv('注册状态', regStat(regState || 0)) +
        (reg5.f1 ? kv('TAC', reg5.f1) : '') + (reg5.f2 ? kv('小区 ID', reg5.f2) : ''),
        { badge: (regState === 1 || regState === 5) ? '在线' : '离线', badgeCls: (regState === 1 || regState === 5) ? 'good' : 'warn' });

      var simOk = /READY/i.test(cpin || '');
      var sim = card('SIM', '用户身份',
        kv('状态', cpin || '—') + kv('IMSI', imsi) + kv('运营商', op),
        { badge: simOk ? 'Ready' : (cpin || 'Unknown'), badgeCls: simOk ? 'good' : 'warn' });

      var ipHtml = addrs.length ? addrs.map(function (a) {
        return kv('IPv4' + (a.cid ? ' (CID ' + a.cid + ')' : ''), a.ipv4) + (a.ipv6 ? kv('IPv6', a.ipv6) : '');
      }).join('') : '<div class="center-empty">未分配地址</div>';
      var ipCard = card('移动网络地址', '模块获取的 IP', ipHtml);

      return '<div class="grid cols-3">' + hero + module + net + '</div>' +
        '<div class="grid cols-2" style="margin-top:14px">' + sim + ipCard + '</div>';
    });
  }

  function viewSignal() {
    return Promise.all([at('AT+CSQ'), at('AT^HCSQ?'), at('AT+COPS?')]).then(function (r) {
      var csq = parseCSQ(r[0]), hcsq = parseHCSQ(r[1]), cops = parseCOPS(r[2]);
      var dbm = csqDbm(csq ? csq.rssi : null), lvl = dbm != null ? csqLevel(csq.rssi) : 0;
      var rsrpEst = hcsqRsrpEst(hcsq && hcsq.mode, hcsq && hcsq.vals);

      var csqCard = card('RSSI (CSQ)', '接收信号强度',
        '<div class="big" style="font-size:34px;font-weight:800">' + (dbm != null ? dbm + ' <small style="font-size:14px;opacity:.7">dBm</small>' : '—') + '</div>' +
        bars(lvl, 5) +
        (csq ? kv('BER', csq.ber) : '') + (csq && csq.rssi != null ? kv('CSQ 等级', csq.rssi + ' / 31') : ''));

      var labels = (hcsq && hcsq.mode === 'NR') ? ['RSRP', 'RSRQ', 'SINR'] : ['RSRP', 'RSRQ', 'RSSI', 'SINR'];
      var metrics = '';
      if (hcsq) {
        hcsq.vals.forEach(function (v, i) {
          var name = labels[i] || ('参数 ' + (i + 1));
          var pct = rsrpPct(hcsq.mode === 'NR' && i === 0 ? v - 140 : (hcsq.mode === 'LTE' && i === 0 ? v - 140 : v - 140));
          metrics += '<div class="metric"><div class="top"><span>' + esc(name) + '</span><span>' + esc(v) + '</span></div>' +
            '<div class="gauge"><i style="width:' + Math.round(pct) + '%"></i></div></div>';
        });
      }
      var hcsqCard = card('详细测量 (HCSQ)', '原始测量值 · ' + (hcsq ? esc(hcsq.mode) : '—'), metrics || '<div class="center-empty">无数据</div>',
        { badge: rsrpEst != null ? '≈ ' + rsrpEst + ' dBm' : null });

      return '<div class="grid cols-2">' + csqCard + hcsqCard + '</div>' +
        '<div class="card" style="margin-top:14px"><div class="desc">运营商：<b>' + esc(cops.operator || '—') + '</b> · 接入技术：<b>' + esc(RAT[cops.rat] || '—') + '</b>。详细数值以 AT 终端原始返回为准。</div></div>';
    });
  }

  function viewNetwork() {
    return Promise.all([at('AT+COPS?'), at('AT+C5GREG?'), at('AT+CEREG?'), at('AT+CGREG?'), at('AT+CGDCONT?'), at('AT+CGPADDR'), at('AT^SYSINFOEX')]).then(function (r) {
      var cops = parseCOPS(r[0]), reg5 = parseReg(r[1], 'C5GREG'), reg4 = parseReg(r[2], 'CEREG'), reg2 = parseReg(r[3], 'CGREG'),
        cont = parseCGDCONT(r[4]), addrs = parseCGPADDR(r[5]), mode = parseSYSINFOEX(r[6]);

      var opCard = card('运营商', '当前驻留网络',
        kv('名称', cops.operator || '—') + kv('MCC-MNC', cops.operator && cops.operator.match(/\d{5,6}/) ? cops.operator.match(/\d{5,6}/)[0] : '—') +
        kv('接入技术', RAT[cops.rat] || (mode || '—')) + kv('模式', mode || '—'));

      var regRows = '';
      [['5G (C5GREG)', reg5], ['LTE (CEREG)', reg4], ['2G/3G (CGREG)', reg2]].forEach(function (p) {
        var rg = p[1]; if (!rg.stat && !rg.f1) return;
        regRows += kv(p[0], regStat(rg.stat || 0) + (rg.f1 ? ' · TAC ' + rg.f1 : '') + (rg.f2 ? ' · Cell ' + rg.f2 : ''));
      });
      var regCard = card('注册状态', '各制式注册信息', regRows || '<div class="center-empty">无注册信息</div>');

      var apnRows = cont.length ? cont.map(function (c) { return kv('CID ' + c.cid + ' (' + (c.pdp || '?') + ')', c.apn || '—'); }).join('') : '<div class="center-empty">无 APN</div>';
      var apnCard = card('APN / PDP', '数据承载配置', apnRows);

      var ipRows = addrs.length ? addrs.map(function (a) { return kv('CID ' + a.cid + ' IPv4', a.ipv4) + (a.ipv6 ? kv('IPv6', a.ipv6) : ''); }).join('') : '<div class="center-empty">未分配地址</div>';
      var ipCard = card('IP 地址', '已分配网络地址', ipRows);

      return '<div class="grid cols-2">' + opCard + regCard + '</div><div class="grid cols-2" style="margin-top:14px">' + apnCard + ipCard + '</div>';
    });
  }

  function viewSim() {
    return Promise.all([at('AT+CPIN?'), at('AT+CIMI'), at('AT+CNUM'), at('AT+QCCID'), at('AT+COPS?'), at('AT+CGDCONT?')]).then(function (r) {
      var cpin = parseCPIN(r[0]), imsi = parseCIMI(r[1]), cnum = parseCNUM(r[2]), ccid = (r[3] || '').match(/(\d{18,22})/), cops = parseCOPS(r[4]), cont = parseCGDCONT(r[5]);
      var simOk = /READY/i.test(cpin || '');
      var main = card('SIM 状态', '用户识别',
        kv('状态', cpin || '—') + kv('IMSI', imsi) + kv('ICCID', ccid ? ccid[1] : '—') + kv('本机号码', cnum || '未存储') + kv('运营商', cops.operator || '—'),
        { badge: simOk ? 'Ready' : (cpin || 'Unknown'), badgeCls: simOk ? 'good' : 'warn' });
      var apn = card('当前 APN', '数据承载', cont.length ? cont.map(function (c) { return kv('CID ' + c.cid, c.apn || '—'); }).join('') : '<div class="center-empty">无 APN</div>');
      return '<div class="grid cols-2">' + main + apn + '</div>';
    });
  }

  function viewSMS() {
    var box = $('#content');
    at('AT+CMGF=1').then(function () { return at('AT+CMGL="ALL"'); }).then(function (raw) {
      var msgs = parseSMS(raw);
      var items = msgs.length ? msgs.map(function (m) {
        return '<div class="sms-item"><span class="date">' + esc(m.status) + '</span><div class="from">' + esc(m.addr || '未知') + '</div><div class="body">' + esc(m.body || '') + '</div></div>';
      }).join('') : '<div class="center-empty">暂无短信</div>';
      var html = card('收件箱', 'AT+CMGL 读取的短信', '<div class="sms-list">' + items + '</div>', { badge: msgs.length + ' 条', badgeCls: 'good' });
      html += '<div class="card" style="margin-top:14px"><div class="head"><div><h3>发送短信</h3><div class="desc">经 AT+CMGS 下发（尽力而为，取决于模块/守护进程支持）</div></div></div>' +
        '<div class="field"><label>号码</label><input class="input" id="smsNum" placeholder="+8613800138000"></div>' +
        '<div class="field"><label>内容</label><textarea id="smsBody" placeholder="输入短信内容…"></textarea></div>' +
        '<button class="btn" id="smsSend"><svg class="ico" style="width:16px;height:16px"><use href="#i-send"/></svg>发送</button>' +
        '<div class="hint">提示：若发送无响应，请改用「AT 终端」执行 AT+CMGF=1 后 AT+CMGS。</div></div>';
      if (currentView === 'sms') box.innerHTML = html;
      var btn = $('#smsSend'); if (btn) btn.onclick = function () {
        var num = $('#smsNum').value.trim(), body = $('#smsBody').value;
        if (!num || !body) { toast('请填写号码和内容'); return; }
        btn.disabled = true; btn.textContent = '发送中…';
        at('AT+CMGF=1').then(function () { return at('AT+CMGS="' + num + '"\r' + body + String.fromCharCode(26)); }).then(function (res) {
          btn.disabled = false; btn.innerHTML = '<svg class="ico" style="width:16px;height:16px"><use href="#i-send"/></svg>发送';
          toast(/OK|CMGS|>/.test(res) ? '指令已下发，请查看终端确认' : ('返回：' + (res.trim() || '无响应')));
          setTimeout(function () { if (currentView === 'sms') viewSMS(); }, 1500);
        });
      };
    });
    return Promise.resolve();
  }

  function viewTerminal() {
    return '<div class="card"><div class="head"><div><h3>AT 终端</h3><div class="desc">直接下发 AT 指令，实时返回模块原始响应</div></div>' +
      '<button class="btn ghost" id="termClear">清空</button></div>' +
      '<div class="term" id="termOut"></div>' +
      '<div class="row"><input class="input" id="termIn" placeholder="例如 ATI、AT^HCSQ?、AT+COPS?"></div>' +
      '<div class="row" id="quick"></div></div>';
  }
  viewTerminal._after = function () {
    var out = $('#termOut'), inp = $('#termIn');
    function log(cls, text) { var t = new Date().toLocaleTimeString(); out.innerHTML += '<div><span class="ts">[' + t + ']</span> <span class="' + cls + '">' + esc(text) + '</span></div>'; out.scrollTop = out.scrollHeight; }
    var quick = ['ATI', 'AT+CSQ', 'AT^HCSQ?', 'AT+COPS?', 'AT+CEREG?', 'AT+CGPADDR', 'AT+CPIN?'];
    $('#quick').innerHTML = quick.map(function (c) { return '<button class="btn ghost" data-c="' + esc(c) + '">' + esc(c) + '</button>'; }).join('');
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

  function viewSystem() {
    return Promise.all([at('ATI'), at('AT+GMR'), at('AT^SYSINFOEX'), at('AT+QTEMP'), at('AT+COPS?')]).then(function (r) {
      var ati = parseATI(r[0]), mode = parseSYSINFOEX(r[2]), temp = (r[3] || '').match(/([+-]?\d+)/), cops = parseCOPS(r[4]);
      var info = card('模块信息', '身份与固件',
        kv('制造商', ati.manufacturer) + kv('型号', ati.model) + kv('固件版本', ati.revision || r[1].trim()) + kv('IMEI', ati.imei) + kv('网络模式', mode || (RAT[cops.rat] || '—')) +
        kv('温度', temp ? temp[1] + ' °C' : '—'));
      var maint = card('维护', '日志与缓存',
        '<button class="btn ghost" id="clearLog">清除后端日志</button><div class="hint">后端 at-server 日志可通过 CGI 接口清除。</div>');
      return '<div class="grid cols-2">' + info + maint + '</div>';
    });
  }

  /* ---------------- Boot ---------------- */
  function boot() {
    // refresh button in topbar
    var refresh = document.createElement('button');
    refresh.className = 'btn ghost'; refresh.style.marginLeft = '10px';
    refresh.innerHTML = '<svg class="ico" style="width:16px;height:16px"><use href="#i-refresh"/></svg>';
    refresh.onclick = function () { loadView(currentView); };
    $('#statusPill').parentNode.insertBefore(refresh, $('#statusPill'));
    $$('#nav .nav-item').forEach(function (b) { b.onclick = function () { loadView(b.dataset.view); }; });
    $('#clearLog') && ($('#clearLog').onclick = function () {
      fetch('/cgi-bin/at-log-clear').then(function () { toast('日志已清除'); }).catch(function () { toast('清除失败'); });
    });
    loadView('overview');
    connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
