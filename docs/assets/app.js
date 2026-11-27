'use strict';

(function () {
  var WALLPAPERS = [
    '',
    'https://files.seeusercontent.com/2026/10/31/aE1a/145952531_p1.jpg',
    'https://files.seeusercontent.com/2026/06/29/uu4H/bg1.jpg'
  ];

  var GALLERY_ITEMS = [
    { src: 'images/network-status.png', cat: 'desktop', title: '网络状态总控制台', desc: 'RSRP / SINR 射频看板、CA 聚合、双轨速率与 7 通道结温' },
    { src: 'images/schedule-layout-desktop.png', cat: 'desktop', title: '定时锁频策略编排（桌面端）', desc: '多时段 4G/5G 频段与 PCI 自动切换，避免夜间基站休眠掉线' },
    { src: 'images/schedule-layout-dark.png', cat: 'mobile-dark', title: '夜间模式自适应界面', desc: '自动识别 Aurora / Argon / Vantage / Bootstrap 主题明暗' },
    { src: 'images/schedule-layout-mobile.png', cat: 'mobile-dark', title: '移动端响应式布局', desc: '小屏自适应卡片与底部配置抽屉（Bottom Sheet）交互' },
    { src: 'images/notice-float.png', cat: 'desktop', title: '全局悬浮提示条与弹窗对比度', desc: 'fixed 悬浮通知不挤压页面布局，明暗主题文字清晰可读' },
    { src: 'auto-dial-sequence.png', cat: 'arch', title: '自动拨号与全链路对账时序', desc: '串口独占调度、CDC_NCM 接口状态机与断流自愈重拨' },
    { src: 'topology.png', cat: 'arch', title: '系统全栈拓扑架构图', desc: 'LuCI 12 视图 ↔ rpcd/ucode ↔ Rust/Tokio ↔ MT5700M 模组' }
  ];

  var MASCOT_LINES = [
    '“薄荷正在守护您的 5G 链路哦，当前 RSRP -85 dBm，网络超顺畅~”',
    '“检测到 5G n78 100MHz 载波已就绪，下行 256QAM 已激活！”',
    '“7 通道芯片综合均温 51.9℃，全部处于健康安全区~”',
    '“v2.1.3 已修复普通模式夜间配置抽屉可读性，欢迎更新体验！”',
    '“AT 调试终端已升级为 9 条高频只读 + 46 条分组手册指令库啦~”',
    '“支持 QQ 机器人扫码一键绑定，断网/短信告警直达手机！”'
  ];

  var AT_RESPONSES = {
    'AT^HCSQ?': '^HCSQ: "NR",55,52,24,18\n\nOK',
    'ATI': 'Manufacturer: MediaTek\nModel: MT5700M\nRevision: MT5700M_V200R001C20\n+GCAP: +CGSM,+DS\n\nOK',
    'AT+CPIN?': '+CPIN: READY\n\nOK',
    'AT^ICCID?': '^ICCID: 898600XXXXXXXXXXXXXX\n\nOK',
    'AT+CIMI': '46000XXXXXXXXXX\n\nOK',
    'AT+CREG?': '+CREG: 0,1\n\nOK',
    'AT+CGREG?': '+CGREG: 0,1\n\nOK',
    'AT^NWTIME?': '^NWTIME: "26/11/27,22:18:05+32,00"\n\nOK',
    'AT+CGSN': '860000000000000 (示例占位)\n\nOK',
    'AT^MONSC': '^MONSC: "NR",460,00,627264,312,0A1B2C3,-85,-11,24\n\nOK',
    'AT^HFREQINFO?': '^HFREQINFO: 0,7,78,627264,3500000,100000,627264,3500000,100000\n\nOK',
    'AT+CSQ': '+CSQ: 31,99\n\nOK',
    'AT': 'OK'
  };

  function $(id) { return document.getElementById(id); }

  function showToast(msg) {
    var stack = $('toastStack');
    if (!stack) return;
    var el = document.createElement('div');
    el.className = 'toast-item';
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 2400);
  }

  /* 1. Theme (Light / Dark) */
  function applyTheme(dark, silent) {
    var html = document.documentElement;
    if (dark) html.classList.add('dark');
    else html.classList.remove('dark');

    var lbl = $('themeToggleText');
    if (lbl) lbl.textContent = dark ? '浅色' : '夜间';
    var demoLbl = $('consoleThemeBtn');
    if (demoLbl) demoLbl.textContent = dark ? '☀️ 切回日间预览' : '🌙 夜间模式预览';

    try { localStorage.setItem('mt5700_pages_theme', dark ? 'dark' : 'light'); } catch (e) {}
    if (!silent) showToast(dark ? '已切换至夜间模式' : '已切换至日间模式');
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('mt5700_pages_theme'); } catch (e) {}
    var preferDark = saved === 'dark';
    applyTheme(preferDark, true);

    var btn = $('themeToggleBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        applyTheme(!document.documentElement.classList.contains('dark'));
      });
    }
    var cbtn = $('consoleThemeBtn');
    if (cbtn) {
      cbtn.addEventListener('click', function () {
        applyTheme(!document.documentElement.classList.contains('dark'));
      });
    }
  }

  /* 2. Wallpaper & Glass Controls + Zen Mode */
  function setWallpaper(idx) {
    var url = WALLPAPERS[idx] || '';
    if (url) {
      document.documentElement.style.setProperty('--wallpaper-url', "url('" + url + "')");
      document.body.classList.add('has-wallpaper');
    } else {
      document.documentElement.style.removeProperty('--wallpaper-url');
      document.body.classList.remove('has-wallpaper');
    }
    document.querySelectorAll('.wp-chip').forEach(function (chip) {
      chip.classList.toggle('active', Number(chip.getAttribute('data-wp')) === idx);
    });
  }

  function initWallpaperControls() {
    var toggle = $('wpToggleBtn');
    var panel = $('wpPanel');
    var closeBtn = $('wpCloseBtn');
    if (toggle && panel) {
      toggle.addEventListener('click', function () { panel.classList.toggle('hidden'); });
    }
    if (closeBtn && panel) {
      closeBtn.addEventListener('click', function () { panel.classList.add('hidden'); });
    }

    var opSlider = $('opacitySlider');
    var opLabel = $('opacityValLabel');
    if (opSlider) {
      opSlider.addEventListener('input', function (e) {
        var v = e.target.value;
        document.documentElement.style.setProperty('--card-opacity', (v / 100).toFixed(2));
        if (opLabel) opLabel.textContent = v + '%';
      });
    }

    var blurSlider = $('blurSlider');
    var blurLabel = $('blurValLabel');
    if (blurSlider) {
      blurSlider.addEventListener('input', function (e) {
        var v = e.target.value;
        document.documentElement.style.setProperty('--wallpaper-blur', v + 'px');
        if (blurLabel) blurLabel.textContent = v + ' px';
      });
    }

    document.querySelectorAll('.wp-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var idx = Number(chip.getAttribute('data-wp'));
        setWallpaper(idx);
        showToast(idx === 0 ? '已恢复柔和网格渐变背景' : '已切换壁纸预设 #' + idx);
      });
    });

    function toggleZen() {
      if (!document.body.classList.contains('has-wallpaper')) {
        setWallpaper(1);
      }
      document.body.classList.toggle('zen-mode');
      if (panel) panel.classList.add('hidden');
    }
    var zenBtn = $('zenBtn');
    var zenPanelBtn = $('zenPanelBtn');
    var zenExit = $('zenExitHint');
    if (zenBtn) zenBtn.addEventListener('click', toggleZen);
    if (zenPanelBtn) zenPanelBtn.addEventListener('click', toggleZen);
    if (zenExit) zenExit.addEventListener('click', function () { document.body.classList.remove('zen-mode'); });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.body.classList.remove('zen-mode');
        closeLightbox();
        closeModal('lockModal');
        closeModal('smsModal');
      }
    });
  }

  /* 3. Mobile Nav */
  function initMobileNav() {
    var btn = $('mobileNavToggle');
    var nav = $('mobileNav');
    if (btn && nav) {
      btn.addEventListener('click', function () { nav.classList.toggle('open'); });
      nav.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () { nav.classList.remove('open'); });
      });
    }
  }

  /* 4. Mascot Poke */
  function initMascot() {
    var idx = 0;
    function poke() {
      idx = (idx + 1) % MASCOT_LINES.length;
      var speech = $('mascotSpeech');
      if (speech) speech.textContent = MASCOT_LINES[idx];
    }
    var avatar = $('mascotAvatarBtn');
    var pokeBtn = $('mascotPokeBtn');
    if (avatar) avatar.addEventListener('click', poke);
    if (pokeBtn) pokeBtn.addEventListener('click', poke);
  }

  /* 5. Live Demo Console Tabs + Speed Chart + Temp Highlight + Scan + SMS + AT */
  var speedChartStarted = false;
  var speedChartRedraw = null;
  function initSpeedChart() {
    if (speedChartStarted) {
      if (speedChartRedraw) speedChartRedraw();
      return;
    }
    speedChartStarted = true;
    var canvas = $('speedChartCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var points = 36;
    var dl = [];
    var ul = [];
    for (var i = 0; i < points; i++) {
      dl.push(290 + Math.random() * 85);
      ul.push(44 + Math.random() * 24);
    }

    function resize() {
      var dpr = window.devicePixelRatio || 1;
      var w = canvas.parentElement.clientWidth - 16;
      var h = canvas.parentElement.clientHeight - 16;
      canvas.width = Math.max(200, w * dpr);
      canvas.height = Math.max(120, h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    function draw() {
      var w = canvas.parentElement.clientWidth - 16;
      var h = canvas.parentElement.clientHeight - 16;
      ctx.clearRect(0, 0, w, h);
      var step = w / (points - 1);

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
      ctx.lineWidth = 1;
      for (var g = 1; g <= 3; g++) {
        var gy = (h / 4) * g;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(w, gy);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(0, h);
      for (var i = 0; i < points; i++) {
        var y = h - (dl[i] / 420) * (h * 0.86);
        ctx.lineTo(i * step, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(6, 182, 212, 0.16)';
      ctx.fill();

      ctx.beginPath();
      for (var j = 0; j < points; j++) {
        var y1 = h - (dl[j] / 420) * (h * 0.86);
        if (j === 0) ctx.moveTo(0, y1);
        else ctx.lineTo(j * step, y1);
      }
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.beginPath();
      for (var k = 0; k < points; k++) {
        var y2 = h - (ul[k] / 420) * (h * 0.86);
        if (k === 0) ctx.moveTo(0, y2);
        else ctx.lineTo(k * step, y2);
      }
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    speedChartRedraw = function () {
      resize();
      draw();
    };
    window.addEventListener('resize', speedChartRedraw);
    draw();
    setInterval(function () {
      dl.shift();
      dl.push(285 + Math.random() * 90);
      ul.shift();
      ul.push(42 + Math.random() * 24);
      var dlEl = $('demoDlSpeed');
      var ulEl = $('demoUlSpeed');
      if (dlEl) dlEl.textContent = dl[dl.length - 1].toFixed(1);
      if (ulEl) ulEl.textContent = ul[ul.length - 1].toFixed(1);
      draw();
    }, 1000);
  }

  function initDemoTabs() {
    var btns = document.querySelectorAll('.demo-tab-btn');
    var panes = document.querySelectorAll('.demo-tab-pane');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-tab');
        btns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        panes.forEach(function (p) { p.classList.add('hidden'); });
        var target = $('demo-tab-' + id);
        if (target) {
          target.classList.remove('hidden');
          if (id === 'speed') initSpeedChart();
        }
      });
    });

    // Thermal sensor highlight
    document.querySelectorAll('.temp-sensor').forEach(function (tile) {
      tile.addEventListener('click', function () {
        document.querySelectorAll('.temp-sensor').forEach(function (t) { t.classList.remove('is-active'); });
        tile.classList.add('is-active');
        showToast(tile.getAttribute('data-label') + '：' + tile.getAttribute('data-temp'));
      });
    });

    // Scan button
    var scanBtn = $('simScanBtn');
    if (scanBtn) {
      scanBtn.addEventListener('click', function () {
        scanBtn.disabled = true;
        scanBtn.textContent = '扫频中...';
        setTimeout(function () {
          scanBtn.disabled = false;
          scanBtn.textContent = '快速扫频';
          showToast('扫频完成：已刷新周边 3 个 4G/5G 小区');
        }, 700);
      });
    }

    // Lock PCI buttons -> in-page modal
    document.querySelectorAll('.lock-cell-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var band = btn.getAttribute('data-band');
        var pci = btn.getAttribute('data-pci');
        var arfcn = btn.getAttribute('data-arfcn');
        $('lockTargetText').textContent = '频段 ' + band + ' · PCI ' + pci + ' · 频点 ' + arfcn;
        $('lockModal').classList.remove('hidden');
      });
    });
    var lockConfirm = $('lockConfirmBtn');
    if (lockConfirm) {
      lockConfirm.addEventListener('click', function () {
        closeModal('lockModal');
        showToast('已模拟下发 AT 锁频指令并更新状态');
      });
    }

    // SMS compose modal
    var smsNewBtn = $('smsNewBtn');
    if (smsNewBtn) {
      smsNewBtn.addEventListener('click', function () {
        $('smsModal').classList.remove('hidden');
      });
    }
    var smsSendBtn = $('smsSendBtn');
    if (smsSendBtn) {
      smsSendBtn.addEventListener('click', function () {
        var to = $('smsToInput').value.trim();
        var body = $('smsBodyInput').value.trim();
        if (!to || !body) {
          showToast('请填写收件人与短信内容');
          return;
        }
        var list = $('smsList');
        if (list) {
          var item = document.createElement('div');
          item.className = 'sms-item';
          item.innerHTML =
            '<div class="sms-avatar" style="background:var(--brand-soft);color:var(--brand-ink);">发</div>' +
            '<div class="sms-body">' +
            '<div class="sms-meta"><strong>发送至 ' + escapeHtml(to) + '</strong><span>刚刚 · UCS2 PDU</span></div>' +
            '<p class="sms-text">' + escapeHtml(body) + '</p>' +
            '</div>';
          list.insertBefore(item, list.firstChild);
        }
        $('smsBodyInput').value = '';
        closeModal('smsModal');
        showToast('已模拟通过 UCS2 PDU 发送至 ' + to);
      });
    }

    // AT Terminal
    function runAtCommand(raw) {
      var cmd = raw.trim();
      if (!cmd) return;
      var out = $('terminalOutput');
      if (!out) return;
      var now = new Date().toTimeString().split(' ')[0];
      var cmdEl = document.createElement('div');
      cmdEl.style.marginTop = '8px';
      cmdEl.style.color = '#94a3b8';
      cmdEl.innerHTML = '[' + now + '] <span style="color:#fde047;">' + escapeHtml(cmd) + '</span>';
      out.appendChild(cmdEl);

      var upper = cmd.toUpperCase();
      var reply = AT_RESPONSES[upper] || 'OK';
      setTimeout(function () {
        var resEl = document.createElement('div');
        resEl.style.whiteSpace = 'pre-wrap';
        resEl.style.paddingLeft = '10px';
        resEl.style.color = '#e2e8f0';
        resEl.textContent = reply;
        out.appendChild(resEl);
        out.scrollTop = out.scrollHeight;
      }, 180);
    }

    var atInput = $('terminalInput');
    var atSend = $('terminalSendBtn');
    var atClear = $('terminalClearBtn');
    if (atSend && atInput) {
      atSend.addEventListener('click', function () {
        runAtCommand(atInput.value);
        atInput.value = '';
      });
      atInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          runAtCommand(atInput.value);
          atInput.value = '';
        }
      });
    }
    if (atClear) {
      atClear.addEventListener('click', function () {
        var out = $('terminalOutput');
        if (out) out.innerHTML = '<div style="color:#34d399;">[SYSTEM] 终端输出已清空，等待下一条 AT 指令。</div>';
      });
    }
    document.querySelectorAll('.quick-at-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        runAtCommand(btn.getAttribute('data-cmd'));
      });
    });
  }

  function closeModal(id) {
    var el = $(id);
    if (el) el.classList.add('hidden');
  }
  window.closeModalById = closeModal;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 6. Gallery Filter & Lightbox */
  var currentGalleryList = GALLERY_ITEMS.slice();
  var currentLightboxIndex = 0;

  function renderGallery(filter) {
    var grid = $('galleryGrid');
    if (!grid) return;
    currentGalleryList = GALLERY_ITEMS.filter(function (item) {
      return filter === 'all' || item.cat === filter;
    });
    grid.innerHTML = '';
    currentGalleryList.forEach(function (item, idx) {
      var card = document.createElement('div');
      card.className = 'glass-card glass-card-hover gallery-item';
      card.innerHTML =
        '<div class="gallery-thumb"><img src="' + item.src + '" alt="' + escapeHtml(item.title) + '" loading="lazy"></div>' +
        '<div class="gallery-caption">' +
        '<div><h4>' + escapeHtml(item.title) + '</h4><p>' + escapeHtml(item.desc) + '</p></div>' +
        '<span style="color:var(--brand);font-size:12px;font-weight:700;flex-shrink:0;">放大 &rarr;</span>' +
        '</div>';
      card.addEventListener('click', function () { openLightbox(idx); });
      grid.appendChild(card);
    });
  }

  function openLightbox(idx) {
    currentLightboxIndex = idx;
    var item = currentGalleryList[idx];
    if (!item) return;
    $('lightboxImg').src = item.src;
    $('lightboxCaption').textContent = item.title + ' — ' + item.desc;
    $('lightboxModal').classList.remove('hidden');
  }

  function closeLightbox() {
    var modal = $('lightboxModal');
    if (modal) modal.classList.add('hidden');
  }

  function initGallery() {
    renderGallery('all');
    document.querySelectorAll('.filter-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        document.querySelectorAll('.filter-pill').forEach(function (p) { p.classList.remove('active'); });
        pill.classList.add('active');
        renderGallery(pill.getAttribute('data-filter'));
      });
    });

    var prev = $('lbPrevBtn');
    var next = $('lbNextBtn');
    var close = $('lbCloseBtn');
    var modal = $('lightboxModal');
    if (prev) prev.addEventListener('click', function (e) {
      e.stopPropagation();
      openLightbox((currentLightboxIndex - 1 + currentGalleryList.length) % currentGalleryList.length);
    });
    if (next) next.addEventListener('click', function (e) {
      e.stopPropagation();
      openLightbox((currentLightboxIndex + 1) % currentGalleryList.length);
    });
    if (close) close.addEventListener('click', closeLightbox);
    if (modal) modal.addEventListener('click', closeLightbox);
    window.addEventListener('keydown', function (e) {
      if (!modal || modal.classList.contains('hidden')) return;
      if (e.key === 'ArrowLeft') openLightbox((currentLightboxIndex - 1 + currentGalleryList.length) % currentGalleryList.length);
      if (e.key === 'ArrowRight') openLightbox((currentLightboxIndex + 1) % currentGalleryList.length);
    });
  }

  /* 7. Install Tabs & Copy Buttons */
  function initInstallAndCopy() {
    document.querySelectorAll('.seg-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-install');
        document.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.install-pane').forEach(function (p) { p.classList.add('hidden'); });
        var target = $('install-' + tab);
        if (target) target.classList.remove('hidden');
      });
    });

    document.querySelectorAll('.copy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-clipboard');
        if (!text || !navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(function () {
          var orig = btn.textContent;
          btn.textContent = '已复制 ✓';
          showToast('命令已复制到剪贴板');
          setTimeout(function () { btn.textContent = orig; }, 1600);
        }).catch(function () {});
      });
    });
  }

  /* 8. GitHub Stars Sync */
  function initGithubStars() {
    fetch('https://api.github.com/repos/LianXia233/luci-app-mt5700')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && typeof data.stargazers_count === 'number') {
          var el = $('githubStarCount');
          if (el) el.textContent = String(data.stargazers_count);
        }
      })
      .catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initWallpaperControls();
    initMobileNav();
    initMascot();
    initDemoTabs();
    initGallery();
    initInstallAndCopy();
    initGithubStars();
  });
})();
