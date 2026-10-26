/**
 * CSS 缓存击穿契约测试
 * ---------------------------------------------------------------------------
 * 背景（2026-09-16 真实事故）：
 *   把开关从 44×24 改成 iOS 几何 51×31 并推送后，用户反馈「web 没实现」。
 *   实测设备上的 /www/luci-static/resources/at-webserver/mt5700.css **内容已经是新的**
 *   （`width:51px;height:31px`、旋钮 27px 均在位），说明不是没编译。
 *
 *   真因是缓存：样式表由 mt5700.js 以
 *       /luci-static/resources/at-webserver/mt5700.css?v=<MT5700_CSS_VERSION>
 *   注入，问号后那串是唯一的缓存击穿器。而该常量自 fe70b2b 引入后**从未 bump 过**
 *   —— 期间 CSS 改了不知多少次。设备是 squashfs，文件 mtime 恒为 1970-01-01，
 *   uhttpd 又不送 Cache-Control，浏览器只能按启发式新鲜度缓存
 *   （RFC 9111 §4.2.2，用 Last-Modified 推算，1970 年的文件 ≈ 永不过期）。
 *   于是新 CSS 躺在磁盘上，浏览器一直用旧副本。
 *
 * 本测试钉住两件事：
 *   1) mt5700.css 的内容指纹 —— 一旦变了，就必须同步 bump MT5700_CSS_VERSION
 *      并更新这里的 CSS_FINGERPRINT（否则测试红，提醒你改）。
 *   2) 开关的 iOS 几何确实在 CSS 里（防止有人手滑改回旧值而没人发现）。
 *
 * 运行：node tests/css-cachebust-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CSSP = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css');
const JSP = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.js');

// 统一换行后再算指纹，避免 CRLF/LF 差异导致跨环境误报
const css = fs.readFileSync(CSSP, 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(JSP, 'utf8');

/*
 * mt5700.css 的内容指纹（sha256 前 16 位）。
 * 改了 mt5700.css 就一定会红 —— 这是有意的：
 *   ① bump mt5700.js 的 MT5700_CSS_VERSION；
 *   ② 把本常量改成新指纹（用本测试失败时打印出的实际值）。
 *
 * 变更日志：
 *   2026-09-28  短信批量删除重做（全选/计数/选择列表）→ 5.5.22
 *   2026-10-16  通话台 UI 重设计（voice_call 去全部内联样式；新增 keypad /
 *              callbar / num-display / verdict 四组件；metric 等宽数字；
 *              prefers-reduced-motion 降级）→ 5.6.0
 *   2026-09-20  eSIM 管理页重排（EID 等宽块 / Profile 行卡 / 卡内分区标题）→ 5.5.20
 *   2026-10-26  全局视觉改版（去玻璃/去半透明卡片、阴影三层→两层、主色加深、
 *              圆角收敛三档、表格等宽数字）→ 5.10.0
 */
const CSS_FINGERPRINT = 'd8b248d7dd533709';

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '\n      ' + extra : ''));
}

const actual = crypto.createHash('sha256').update(css, 'utf8').digest('hex').slice(0, 16);

/* ---------- 1. 缓存击穿器必须与 CSS 内容同步 ---------- */
ok('mt5700.css 指纹未变化（变了请先 bump MT5700_CSS_VERSION 再更新指纹）',
	actual === CSS_FINGERPRINT,
	'期望 ' + CSS_FINGERPRINT + '\n      实际 ' + actual +
	'\n      → 若你刚改过 mt5700.css：改 mt5700.js 的 MT5700_CSS_VERSION，并把本文件 CSS_FINGERPRINT 改成实际值。');

const verM = js.match(/MT5700_CSS_VERSION\s*=\s*'([^']+)'/);
ok('mt5700.js 里存在 MT5700_CSS_VERSION 常量', !!verM);
const ver = verM ? verM[1] : '';
ok('MT5700_CSS_VERSION 是 x.y.z 三段式', /^\d+\.\d+\.\d+$/.test(ver), '实际：' + ver);
ok('MT5700_CSS_VERSION 已高于事故时的 5.5.2（否则旧缓存不会失效）',
	ver !== '5.5.2', '实际：' + ver);

/* ---------- 2. 样式表确实按该版本号注入 ---------- */
ok('CSS 以 ?v=<版本号> 形式注入（缓存击穿器真的接在 URL 上）',
	js.indexOf('mt5700.css?v=\' + MT5700_CSS_VERSION') !== -1 ||
	js.indexOf('mt5700.css?v=" + MT5700_CSS_VERSION') !== -1,
	'找不到 mt5700.css?v= 与 MT5700_CSS_VERSION 的拼接');

/* ---------- 3. 开关的 iOS 几何在 CSS 里（防手滑改回旧值） ---------- */
const switchRule = (css.match(/\.mt5700-switch input\[type="checkbox"\]\{[^}]*\}/) || [])[0] ||
	(css.match(/\.mt5700-switch input\[type="checkbox"\]\s*\{[^}]*\}/) || [])[0] || '';
ok('CSS 存在 .mt5700-switch 复选框规则', !!switchRule);
ok('轨道为 iOS 几何 51×31（旧值是 44×24）',
	/width:\s*51px/.test(switchRule) && /height:\s*31px/.test(switchRule),
	'实际规则：' + switchRule);
ok('轨道显式 appearance:none（否则浏览器画原生复选框）',
	/appearance:\s*none/.test(switchRule));
/*
 * ★ 主题压制守卫（2026-09-16 第二次事故 + 开态对勾）：
 *   Argon 主题 /luci-static/argon/css/cascade.css 里
 *       input[type="checkbox"]{width:1rem !important;height:1rem !important}
 *       input[type="checkbox"]:checked{background-image:url(对勾SVG) !important;
 *                                      background-color:var(--primary)}
 *   —— 都带 !important，我们选择器特异性再高也压不过。
 *   ① 不加 !important 的 width/height：51×31 轨道被压成 16×16，27px 旋钮整个盖住它，
 *      观感「开关被挤扁、只剩一个小白球」；
 *   ② 不压掉 background-image：开态蓝色胶囊正中被盖一个主题对勾，很难看。
 */
ok('轨道 width 带 !important（Argon 用 !important 把复选框压成 1rem）',
	/width:\s*51px\s*!important/.test(switchRule), '实际规则：' + switchRule);
ok('轨道 height 带 !important（同上）',
	/height:\s*31px\s*!important/.test(switchRule), '实际规则：' + switchRule);
ok('轨道有 min-width/min-height 兜底（即便再被 !important 覆盖也不塌）',
	/min-width:\s*51px/.test(switchRule) && /min-height:\s*31px/.test(switchRule),
	'实际规则：' + switchRule);

const checkedRule = (css.match(/\.mt5700-switch input\[type="checkbox"\]:checked\s*\{[^}]*\}/) || [])[0] || '';
ok('开态用 !important 指定背景色（主题用 background-color:var(--primary) 顶色）',
	/background-color:\s*var\(--mt5700-accent\)\s*!important/.test(checkedRule),
	'实际规则：' + checkedRule);
ok('开态用 !important 压掉主题的对勾 background-image（否则蓝胶囊中间一个勾）',
	/background-image:\s*none\s*!important/.test(checkedRule),
	'实际规则：' + checkedRule);

const knobRule = (css.match(/\.mt5700-switch input\[type="checkbox"\]::before\s*\{[^}]*\}/) || [])[0] || '';
ok('旋钮 27×27（旧值 20×20）',
	/width:\s*27px/.test(knobRule) && /height:\s*27px/.test(knobRule),
	'实际规则：' + knobRule);

const onRule = (css.match(/\.mt5700-switch input\[type="checkbox"\]:checked::before\s*\{[^}]*\}/) || [])[0] || '';
ok('开态位移 20px', /translateX\(20px\)/.test(onRule), '实际规则：' + onRule);

const activeRule = (css.match(/\.mt5700-switch input\[type="checkbox"\]:checked:active::before\s*\{[^}]*\}/) || [])[0] || '';
/*
 * 按压时旋钮撑到 31px，on 态位移必须同步收到 16px：
 * 2(左) + 16 + 31 = 49 <= 51，若仍用 20px 则 20 + 31 = 51 会顶出轨道右缘。
 */
ok('on+active 时位移收为 16px（否则 31px 旋钮捅出轨道）',
	/translateX\(16px\)/.test(activeRule) && /width:\s*31px/.test(activeRule),
	'实际规则：' + activeRule);

/* ---------- 4. 关态轨道用专用变量，不复用描边色 ---------- */
ok('关态用 --mt5700-switch-off（--mt5700-border-subtle 是描边色，暗色下几乎不可见）',
	/--mt5700-switch-off:/.test(css) &&
	!/\.mt5700-switch input\[type="checkbox"\]\s*\{[^}]*background:\s*var\(--mt5700-border-subtle\)/.test(css));

/* ---------- 5. 警示注释在位（防后人不知道要 bump） ---------- */
ok('mt5700.css 头部写了「改本文件必须 bump MT5700_CSS_VERSION」',
	/MT5700_CSS_VERSION/.test(css.slice(0, 2000)));

if (fails.length) {
	console.error('FAIL  ' + fails.length + ' 项未通过：');
	fails.forEach(function (f) { console.error('  ✗ ' + f); });
	console.error('\n通过 ' + pass + ' 项');
	process.exit(1);
}
console.log('PASS  ' + pass + ' css-cachebust-contract.test.js');
