#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""改完 mt5700.css 后的一条命令收尾：同步外壳区段 → 重算指纹 → bump 版本号。

为什么要有它
------------
这三步必须同时正确，漏一步的后果都不是报错，而是「静默变成旧界面」或
「契约测试莫名其妙变红」：

  ① 原型改过没重新生成 → 真机样式与 docs/design-v9 不一致（两份真相）
  ② CSS 变了没 bump MT5700_CSS_VERSION → 设备方 squashfs 的 mtime 恒 1970，
     浏览器会一直用缓存副本（2026-09-16 真实事故）
  ③ 版本 bump 了没更新 CSS_FINGERPRINT → css-cachebust 契约测试红

⚠️ 反面教材（2026-10-26 实际踩到）：手工用 `io.open(p,'w')` 包住
`io.open(p).read()` 写测试文件 —— 外层 open 先截断，内层读到空串，
把 9.4KB 的契约测试写成了 0 字节。**永远先读完整内容，再打开写入。**

用法：
    python tools/bump-css.py 6.1.0        # 生成 + 指纹 + 版本号
    python tools/bump-css.py 6.1.0 --dry  # 只看会改什么
"""
import hashlib
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css')
JS = os.path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.js')
TEST = os.path.join(ROOT, 'tests', 'css-cachebust-contract.test.js')


def read(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(s)


def fingerprint(css_text):
    # 与 tests/css-cachebust-contract.test.js 完全一致：统一换行后取 sha256 前 16 位
    norm = css_text.replace('\r\n', '\n').encode('utf-8')
    return hashlib.sha256(norm).hexdigest()[:16]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    version = sys.argv[1]
    dry = '--dry' in sys.argv

    # ① 先按原型重新生成外壳区段
    gen = importlib.import_module('gen-shell-css')
    block = gen.build()
    css = read(CSS)
    if gen.BEGIN in css and gen.END in css:
        a = css.index(gen.BEGIN)
        b = css.index(gen.END) + len(gen.END)
        new_css = css[:a] + block + css[b:]
    else:
        new_css = css.rstrip('\n') + '\n\n' + block + '\n'
    gen_changed = new_css != css
    if gen_changed and not dry:
        write(CSS, new_css)
        css = new_css

    # ② 指纹
    fp = fingerprint(css)
    test_src = read(TEST)
    m = re.search(r"const CSS_FINGERPRINT = '([0-9a-f]{16})';", test_src)
    old_fp = m.group(1) if m else None
    new_test = test_src
    if old_fp != fp:
        new_test = re.sub(r"const CSS_FINGERPRINT = '[0-9a-f]{16}';",
                          "const CSS_FINGERPRINT = '%s';" % fp, test_src)
    if not dry:
        write(TEST, new_test)

    # ③ 版本号
    js_src = read(JS)
    vm = re.search(r"var MT5700_CSS_VERSION = '([0-9.]+)';", js_src)
    old_v = vm.group(1) if vm else None
    if not dry:
        write(JS, re.sub(r"var MT5700_CSS_VERSION = '[0-9.]+';",
                         "var MT5700_CSS_VERSION = '%s';" % version, js_src))

    print('%s外壳区段：%s' % ('[dry] ' if dry else '', '已按原型重生成' if gen_changed else '无变化'))
    print('%s指纹：%s → %s' % ('[dry] ' if dry else '', old_fp, fp))
    print('%s版本：%s → %s' % ('[dry] ' if dry else '', old_v, version))
    return 0


if __name__ == '__main__':
    sys.exit(main())
