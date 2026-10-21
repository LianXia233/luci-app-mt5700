#!/usr/bin/env python3
"""前端 CSS 类使用面扫描 —— css-class-audit.py / css-prune.py 的共用口径。

为什么单独成模块（真实故障）：审计脚本与裁剪脚本各自实现了一遍「哪些类在用」，
两边口径一旦漂移，就会出现「审计说没用、裁剪却删了在用的类」这种自相矛盾的结果。
判据只留一处。

两种口径，方向相反，各自服务一个目的：

  broad   （宽松）—— 源码里**任何位置**出现的、长得像类名的 token 都算在用。
          服务 css-prune.py：裁剪是不可逆的破坏性动作，宁可多留不可错删。

  strict  （精确）—— 只认真正「挂在元素上」的写法：class 属性、classList、
          setAttribute('class')、class 变量的 `+=` 拼接、HTML 字符串里的 class="…"。
          服务 audit 的 MISSING：宽口径会把 id（`at-service-status`）、URI
          （`at-webserver`、`mt5700-rpc`）、文件名（`mt5700-log-*.txt`）、
          SVG 渐变 id（`mt5700-grad-*`）全算成类，MISSING 列表就灌成噪声没人看了。

三个必须堵住的坑，全部来自实测假阳性：
  ① **子串误伤**：`mt5700-app` 会匹配上 `mt5700-applybar` 的前半段。
     → 先按 `[A-Za-z0-9_-]+` 做最大匹配切词，再筛前缀，绝不直接 `in` 判子串。
  ② **后缀拼接**：`cls += ' mt5700-notice-success'` —— 类名出现在普通字符串里，
     既不在 `class:` 属性上，也不是 `classList.add()`。
     → broad 口径整份源码切词；strict 口径单列一条 `cls +=` 规则。
  ③ **动态前缀**：`'mt5700-btn mt5700-btn-' + variant`
     → 只认「引号闭合后紧跟 `+`」或「`${` 之前」的尾部连字符。
     注释里写的 `at-btn-*`（词法上切出 `at-btn-`）**不是**拼接，不能当通配，
     否则一个注释就能让整个命名空间免于裁剪。
"""
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSS = ROOT / 'htdocs/luci-static/resources/at-webserver/mt5700.css'

JS_DIRS = [ROOT / 'htdocs/luci-static/resources']
SCAN_EXTRA = [ROOT / 'root' / 'usr' / 'share' / 'rpcd' / 'ucode' / 'mt5700.uc']

# 第三方库不参与本插件类名
SKIP_FILES = {'jsqr.js'}

# 本插件的命名空间。`at-` 是旧 WebUI Semi Design 迁移层，`mt5700-` 是现役设计系统。
NAMESPACES = ('mt5700-', 'at-')

RE_TOKEN = re.compile(r'[A-Za-z0-9_-]+')
# 字符串字面量（单引号 / 双引号 / 模板）。模板里允许 ${}，故单独处理。
RE_STR = re.compile(r"'([^'\\\n]*)'|\"([^\"\\\n]*)\"|`([^`\\]*)`")
RE_TAIL_WS = re.compile(r'\s*')

# 「类名真正挂在元素上」的写法 —— 只用于 strict 口径
RE_CLASS_POS = [
    # E('div', { 'class': 'a b' })  /  { className: 'a b' }  /  模板字面量
    re.compile(r"""['"]?(?:class|className)['"]?\s*:\s*'([^'\\\n]*)'"""),
    re.compile(r'''['"]?(?:class|className)['"]?\s*:\s*"([^"\\\n]*)"'''),
    re.compile(r"""['"]?(?:class|className)['"]?\s*:\s*`([^`\\]*)`"""),
    # classList.add('a b') / remove / toggle / contains
    re.compile(r"""classList\.(?:add|remove|toggle|contains)\(\s*'([^'\\\n]*)'"""),
    re.compile(r'''classList\.(?:add|remove|toggle|contains)\(\s*"([^"\\\n]*)"'''),
    # setAttribute('class', 'a b')
    re.compile(r"""setAttribute\(\s*['"]class['"]\s*,\s*'([^'\\\n]*)'"""),
    # 后缀拼接：cls += ' mt5700-notice-success'
    re.compile(r"""(?:cls|class|className)\s*\+=\s*'([^'\\\n]*)'"""),
    # HTML 字符串：class="a b"
    re.compile(r"""class="([^"\\\n]*)\""""),
]


def iter_source_files():
    for d in JS_DIRS:
        for p in d.rglob('*.js'):
            if p.name in SKIP_FILES:
                continue
            yield p
    for p in SCAN_EXTRA:
        if p.exists():
            yield p


def _tail_token(s):
    """取字符串内容的最后一个 token。"""
    toks = RE_TOKEN.findall(s)
    return toks[-1] if toks else ''


def _absorb(tok, exact, prefixes):
    """把单个 token 归入 exact 或 prefixes。"""
    if not tok.startswith(NAMESPACES):
        return
    if tok.endswith('-'):
        prefixes.add(tok)
    else:
        exact.add(tok)


def _absorb_group(content, exact, prefixes):
    """把一段类名列表（空格分隔）逐 token 归入。"""
    for tok in content.split():
        _absorb(tok, exact, prefixes)
    for piece in content.split('${')[:-1]:
        tail = _tail_token(piece)
        if tail.startswith(NAMESPACES) and tail.endswith('-'):
            prefixes.add(tail)


def used_classes(strict=False):
    """返回 (exact, prefixes)。

    exact    —— 完整类名集合（已切词，无子串污染）
    prefixes —— 动态拼接前缀，形如 'mt5700-btn-'（含尾部连字符）

    strict=True 只认类位置（审计 MISSING 用）；
    strict=False 全源码切词（裁剪 DEAD 用，宁可多留）。
    """
    exact = set()
    prefixes = set()
    for p in iter_source_files():
        text = p.read_text(encoding='utf-8', errors='replace')
        if strict:
            for rx in RE_CLASS_POS:
                for m in rx.finditer(text):
                    _absorb_group(m.group(1), exact, prefixes)
                    # { class: 'mt5700-btn mt5700-btn-' + variant }
                    nxt = RE_TAIL_WS.match(text, m.end()).end()
                    if nxt < len(text) and text[nxt] == '+':
                        tail = _tail_token(m.group(1))
                        if tail.startswith(NAMESPACES):
                            prefixes.add(tail if tail.endswith('-') else tail + '-')
            continue
        for tok in RE_TOKEN.findall(text):
            # 尾部连字符在宽松模式下不认：注释里的 `mt5700-*`、`at-btn-*` 词法上
            # 切出来就是 `mt5700-` / `at-btn-`，一旦当成前缀通配，整个命名空间
            # 就永久免于裁剪了。真拼接由下面 RE_STR 那段按「引号后紧跟 +」判。
            if tok.endswith('-'):
                continue
            _absorb(tok, exact, prefixes)
        for m in RE_STR.finditer(text):
            content = next(g for g in m.groups() if g is not None)
            # 情形 A：字符串后面紧跟 `+` —— 'xxx mt5700-btn-' + variant
            nxt = RE_TAIL_WS.match(text, m.end()).end()
            if nxt < len(text) and text[nxt] == '+':
                tail = _tail_token(content)
                if tail.startswith(NAMESPACES) and tail.endswith('-'):
                    prefixes.add(tail)
            # 情形 B：模板插值 —— `mt5700-toast-${type}`
            if '${' in content:
                for piece in content.split('${')[:-1]:
                    tail = _tail_token(piece)
                    if tail.startswith(NAMESPACES) and tail.endswith('-'):
                        prefixes.add(tail)
    return exact, prefixes


def is_used(cls, exact, prefixes):
    """单个类名是否「可能在用」。"""
    if cls in exact:
        return True
    return any(cls.startswith(p) for p in prefixes)


# ---- 状态类（is-*）与宿主类的配对检查 -------------------------------------
# 真实故障：`simBox.classList.toggle('is-warn', sim.warn)` 挂了两年，
# CSS 里没有 `.at-status-sim.is-warn` —— 状态类切换完全无视觉效果，
# 页面不报错、测试全绿，用户只看到"告警了但界面毫无反应"。

# 元素创建：var X = E('div', { 'class': 'a b' }) / Mt5700.card(…)
RE_VAR_CREATE = re.compile(
    r"""(?:var|let|const)\s+(\w+)\s*=\s*E\(\s*'[^']*'\s*,\s*\{[^}]{0,400}?['"]?class['"]?\s*:\s*'([^']*)'""",
    re.S)
# 状态类挂载：X.classList.add('is-y') / X.classList.toggle('is-y', cond)
RE_VAR_STATE = re.compile(r"""(\w+)\.classList\.(?:add|toggle)\(\s*'(is-[a-z0-9-]+)'""")
# CSS 复合选择器里的类 token
RE_CSS_CLASS = re.compile(r'\.([A-Za-z0-9_-]+)')


def state_pairs_js():
    """返回 (pairs, unresolved, total)。

    pairs      —— 已确定宿主类的 (base_classes:tuple, state:str)
    unresolved —— 找不到就近 `var X = E(...)` 的状态挂载（不判定，只报数）
    total      —— 状态挂载点总数（用来如实说明"判定了多少、漏了多少"）
    """
    pairs = set()
    unresolved = 0
    total = 0
    for p in iter_source_files():
        text = p.read_text(encoding='utf-8', errors='replace')
        creates = [(m.start(), m.group(1), m.group(2).split())
                   for m in RE_VAR_CREATE.finditer(text)]
        for m in RE_VAR_STATE.finditer(text):
            total += 1
            var = m.group(1)
            # 就近向前找同名变量的创建点（同函数内先建后挂）
            cands = [c for c in creates if c[1] == var and c[0] < m.start()]
            if not cands:
                unresolved += 1
                continue
            pairs.add((tuple(cands[-1][2]), m.group(2)))
    return pairs, unresolved, total


def state_pairs_css(css_text):
    """从 CSS 选择器里抽出 (宿主类, 状态类) 配对。"""
    code = re.sub(r'/\*.*?\*/', '', css_text, flags=re.S)
    out = set()
    # 只看选择器部分（`{` 之前）
    for sel in re.findall(r'([^{}]+)\{', code):
        for compound in re.split(r'[,\n]', sel):
            toks = RE_CSS_CLASS.findall(compound)
            states = [t for t in toks if t.startswith(('is-', 'has-'))]
            bases = [t for t in toks if not t.startswith(('is-', 'has-'))]
            if states and bases:
                for s in states:
                    for b in bases:
                        out.add((b, s))
    return out


def scan_report():
    for label, strict in (('宽松（裁剪用）', False), ('精确（审计用）', True)):
        exact, prefixes = used_classes(strict)
        print(f'{label}：{len(exact)} 个类名，前缀 {sorted(prefixes)}')
    print(f'源文件：{sum(1 for _ in iter_source_files())} 个')


if __name__ == '__main__':
    scan_report()
