# -*- coding: utf-8 -*-
"""
短信中心显示效果截图：把 sms-fixtures.js 的 PDU 夹具喂给真实的 parse.js / sms_center.js，
用 Chromium 渲染成一张能直接看的图（多会话列表 / 收到与发出分区 / 时间未知标注）。

与 sms-center-render.js 的关系：
    那个脚本用 DOM 桩做**断言**（分区数量、顺序、条数、文案），跑得快、无外部依赖；
    这个脚本复用同一份夹具与同一份前端代码做**渲染**，回答「界面到底长什么样」。
    两者互补：断言防回归，截图给人看。

依赖（可选，不装也不影响 sms-center-render.js 与 simulate-push.js）：
    pip install playwright && playwright install chromium

用法：
    python render-shot.py [输出目录]
    默认输出到系统临时目录。
"""

import pathlib
import sys
import tempfile

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
RES = ROOT / "htdocs" / "luci-static" / "resources"
TESTS = ROOT / "tests" / "mock-modem"

OUT_DIR = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(tempfile.gettempdir()) / "at-ws-sms-shot"
HTML = OUT_DIR / "sms_center_sim.html"
PNG = OUT_DIR / "sms_center_sim.png"

OUT_DIR.mkdir(parents=True, exist_ok=True)


def read(p):
    return p.read_text(encoding="utf-8")


# ---------- 预处理前端代码（剥离 LuCI 语法糖） ----------

fixtures_js = read(TESTS / "sms-fixtures.js")
fixtures_js = "var module = { exports: {} };\n" + fixtures_js + "\nvar fixtures = module.exports;\n"

parse_src = read(RES / "at-webserver" / "parse.js").replace("'require baseclass';", "")
cut = parse_src.index("var ParseClass =")
parse_js = parse_src[:cut]

view_src = read(RES / "view" / "at-webserver" / "sms_center.js")
view_src = "\n".join(l for l in view_src.split("\n") if not l.strip().startswith("'require "))
view_js = "var viewDef = (function () {\n" + view_src + "\n})();\n"

css = read(RES / "at-webserver" / "mt5700.css")

# ---------- LuCI 最小桩 ----------
STUB = r"""
function E(tag, attrs, children) {
	var el = document.createElement(tag);
	if (attrs) Object.keys(attrs).forEach(function (k) {
		if (k === 'class') el.className = attrs[k];
		else el.setAttribute(k, attrs[k]);
	});
	if (children != null) {
		if (Array.isArray(children)) children.forEach(function (c) { if (c) el.appendChild(c); });
		else if (typeof children === 'object') el.appendChild(children);
		else el.textContent = String(children);
	}
	return el;
}
var L = { view: { extend: function (d) { return d; } }, Class: { extend: function (d) { return d; } } };
var Ui = { startup: function (body, cb) { cb(); }, promptModal: function () {} };
var SmsEncode = {
	messageStats: function (t) {
		return { chars: t.length, encoding: /[^\x00-\x7F]/.test(t) ? 'UCS2' : 'GSM7', parts: 1 };
	}
};
var AtWs = {
	client: {
		sendCommand: function (cmd) {
			if (cmd === 'AT+CMGL=4') return Promise.resolve({ success: true, data: window.CMGL_TEXT });
			/*
			 * 实机（MT5700M-CN）只认**标准** `AT+CPMS?`；私有前缀 `AT^CPMS?` 直接回 ERROR。
			 * 这里刻意让私有写法失败，截图才与真机同一个口径 —— 否则前端退回错误前缀后，
			 * 截图仍然会「看起来正常」，反而掩盖问题。
			 */
			if (cmd === 'AT+CPMS?') return Promise.resolve({ success: true, data: '+CPMS: "SM",6,50,"SM",6,50,"MT",0,50' });
			if (cmd === 'AT^CPMS?') return Promise.resolve({ success: false, error: 'ERROR' });
			return Promise.resolve({ success: true, data: 'OK' });
		},
		subscribe: function () {},
		unsubscribe: function () {}
	}
};
var Mt5700 = {
	page: function (title, desc) {
		var wrap = document.createElement('div');
		wrap.className = 'mt5700-page';
		var head = document.createElement('div');
		head.style.cssText = 'padding:14px 18px 6px;font-size:20px;font-weight:600;';
		head.textContent = title;
		var sub = document.createElement('div');
		sub.style.cssText = 'padding:0 18px 10px;opacity:.65;font-size:12px;';
		sub.textContent = desc;
		wrap.appendChild(head);
		wrap.appendChild(sub);
		var body = document.createElement('div');
		wrap.appendChild(body);
		document.getElementById('root').appendChild(wrap);
		return { _body: body, className: 'mt5700-page' };
	},
	primaryButton: function (label) { return E('button', { 'class': 'mt5700-btn mt5700-btn-primary' }, label); },
	dangerButton: function (label) { return E('button', { 'class': 'mt5700-btn mt5700-btn-danger' }, label); },
	ghostButton: function (label) { return E('button', { 'class': 'mt5700-btn mt5700-btn-ghost' }, label); },
	button: function (label) { return E('button', { 'class': 'mt5700-btn' }, label); },
	empty: function (t) { return E('div', { 'class': 'mt5700-empty' }, t); },
	panelActions: function () {
		var w = E('div', { 'class': 'mt5700-panel-actions' });
		for (var i = 0; i < arguments.length; i++) w.appendChild(arguments[i]);
		return w;
	},
	warning: function () {}, error: function () {}, info: function () {}, success: function () {}, confirm: function () {}
};
"""

BOOT = r"""
window.CMGL_TEXT = fixtures.cmglText(fixtures.buildConversations());
var page = viewDef.render.call(viewDef);
"""

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>短信中心 · 模拟渲染</title>
<style>
body {{ margin: 0; padding: 18px; background: #0b1626; color: #e8eef6;
	font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }}
#root {{ max-width: 1180px; margin: 0 auto; }}
</style>
<style>
{css}
</style>
</head>
<body>
<div id="root"></div>
<script>{STUB}</script>
<script>{fixtures_js}</script>
<script>{parse_js}</script>
<script>{view_js}</script>
<script>{BOOT}</script>
</body>
</html>
"""

HTML.write_text(html, encoding="utf-8")
print(f"HTML 已生成: {HTML}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    # color_scheme=dark：mt5700.css 的深色变量在 @media (prefers-color-scheme: dark) 里，
    # 用浅色渲染会让「收到」气泡是浅底、正文却是本页设的浅色字，看起来像正文丢了一样。
    page = browser.new_page(viewport={"width": 1240, "height": 900},
                            device_scale_factor=2, color_scheme="dark")
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(HTML.as_uri())
    page.wait_for_selector(".mt5700-sms-item", timeout=10000)
    # 选中「有来有回」的会话，才能同时看到收到区与发出区
    page.click('.mt5700-sms-item:has-text("13800138000")')
    page.wait_for_timeout(300)
    page.screenshot(path=str(PNG), full_page=True)
    browser.close()

if errors:
    print("页面报错：")
    for e in errors:
        print("  " + e)
    sys.exit(1)

print(f"截图已生成: {PNG}")
