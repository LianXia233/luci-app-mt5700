#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 docs/design-v9/index.html 里的原型样式转成插件可用的 CSS。

为什么要有这步
--------------
原型（docs/design-v9/index.html）是「真机长什么样」的唯一口径。手抄一份到
mt5700.css 就等于有两份真相，改了一边忘了另一边 —— 历史上已经踩过
（设计稿与实现各走各的，最后谁也说不清哪个对）。

所以：**原型是源，mt5700.css 的同名区段是生成物**。
改完原型跑一次本脚本，两块永远同步。

转换规则
--------
1. `:root` / `html, body` → `.mt5700-sh`：令牌与基础排印挂在外壳根节点上，
   不污染 LuCI 全局（Argon 自己也在用 body 上的样式）。
2. `html[data-theme="light"]` → `.mt5700-sh[data-theme="light"]`。
3. `*` → `.mt5700-sh, .mt5700-sh *`（只给外壳内部重置 box-sizing）。
4. 其余选择器逐个加 `.mt5700-sh ` 前缀；@media 内部同样递归处理。
5. `@media` 以外的 @ 规则原样保留（本原型没有 @font-face/@keyframes）。

用法
----
    python tools/gen-shell-css.py          # 写入
    python tools/gen-shell-css.py --check  # 只比对，不写（给守卫用）

退出码：0 一致 / 1 不一致（--check）
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'docs', 'design-v9', 'index.html')
DST = os.path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css')

BEGIN = '/* ==== BEGIN v9-shell（由 tools/gen-shell-css.py 生成，勿手改） ==== */'
END = '/* ==== END v9-shell ==== */'

SCOPE = '.mt5700-sh'

# 这些选择器整体替换，不做前缀拼接
# body 也要挂一份：弹窗/提示层是 appendChild 到 body 的，落在壳外，
# 只给 .mt5700-sh 的话它们在深色界面里还是旧浅色（实测弹窗全白）。
BODY = 'body.mt5700-sh-on'

EXACT = {
    ':root': SCOPE + ', ' + BODY,
    'html, body': SCOPE,
    '*': SCOPE + ', ' + SCOPE + ' *',
    'html[data-theme="light"]': SCOPE + '[data-theme="light"], html[data-theme="light"] ' + BODY,
}


def split_blocks(css):
    """把 CSS 切成 [(prelude, body_or_None)]；body 为 None 表示这是一条语句。"""
    out = []
    i = 0
    n = len(css)
    while i < n:
        j = css.find('{', i)
        k = css.find('}', i)
        # 注释优先跳过（整段照抄）
        c = css.find('/*', i)
        if c >= 0 and (j < 0 or c < j) and (k < 0 or c < k):
            e = css.find('*/', c + 2)
            out.append((css[i:e + 2], None))
            i = e + 2
            continue
        if j < 0:
            tail = css[i:].strip()
            if tail:
                out.append((tail, None))
            break
        prelude = css[i:j].strip()
        # 配对找到本块的结束花括号
        depth = 0
        p = j
        while p < n:
            if css[p] == '{':
                depth += 1
            elif css[p] == '}':
                depth -= 1
                if depth == 0:
                    break
            p += 1
        body = css[j + 1:p]
        out.append((prelude, body))
        i = p + 1
    return out


def scope_selector_list(sel):
    parts = [s.strip() for s in sel.split(',')]
    fixed = []
    for s in parts:
        if not s:
            continue
        if s in EXACT:
            fixed.append(EXACT[s])
        elif s.startswith(SCOPE):
            fixed.append(s)
        elif s.startswith('@'):
            fixed.append(s)
        else:
            fixed.append(SCOPE + ' ' + s)
    return ', '.join(fixed)


def transform(css, indent=''):
    chunks = []
    for prelude, body in split_blocks(css):
        if body is None:
            chunks.append(prelude)
            continue
        if prelude.startswith('@'):
            # 只有 @media 需要往下递归；其它 @ 规则原样保留
            if prelude.startswith('@media'):
                chunks.append(prelude + ' {\n' + transform(body, indent + '  ') + '\n}')
            else:
                chunks.append(prelude + ' {' + body + '}')
            continue
        chunks.append(scope_selector_list(prelude) + ' {' + body + '}')
    return '\n'.join(chunks)


def build():
    src = io.open(SRC, 'r', encoding='utf-8').read()
    m = re.search(r'<style>(.*?)</style>', src, re.S)
    if not m:
        raise SystemExit('原型里找不到 <style> 块')
    raw = m.group(1).strip()

    body = transform(raw)
    head = (
        BEGIN + '\n'
        '/* 来源：docs/design-v9/index.html 的 <style> 块，经作用域化后原样搬入。\n'
        '   作用域：所有规则限定在 ' + SCOPE + ' 内，不影响 Argon 与 LuCI 其它页面。\n'
        '   重新生成：python tools/gen-shell-css.py */\n'
    )
    return head + body + '\n' + END


def main():
    block = build()
    css = io.open(DST, 'r', encoding='utf-8', newline='').read()

    if BEGIN in css and END in css:
        a = css.index(BEGIN)
        b = css.index(END) + len(END)
        new = css[:a] + block + css[b:]
    else:
        new = css.rstrip('\n') + '\n\n' + block + '\n'

    if '--check' in sys.argv:
        if new != css:
            print('✗ mt5700.css 里的 v9-shell 区段与原型不一致，请跑 tools/gen-shell-css.py')
            return 1
        print('✓ v9-shell 区段与原型一致')
        return 0

    if new == css:
        print('无变化（原型未改）')
        return 0
    io.open(DST, 'w', encoding='utf-8', newline='\n').write(new)
    print('已写入 %s（v9-shell 区段 %d 字节）' % (os.path.relpath(DST, ROOT), len(block)))
    return 0


if __name__ == '__main__':
    # GBK 控制台下 print('✓ ...') 会抛 UnicodeEncodeError 并中断整个流程，
    # 这里把两个流强制成 UTF-8（守卫：tests/tool-gbk-encoding-contract.test.js）
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    sys.exit(main())
