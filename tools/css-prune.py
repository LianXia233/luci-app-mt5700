#!/usr/bin/env python3
"""CSS 死规则裁剪器 —— 只删「选择器里的类从未被应用」的规则。

安全论证（为什么删了不可能影响渲染）：
  一条 CSS 规则只有当它的**任一选择器能匹配到元素**时才起作用。选择器里
  出现的每一个类，都必须是某个元素上真实存在的 class。若一条规则的所有选择器
  都含有「全仓库从未被应用」的类，则它永远匹配不到任何元素 —— 删除它是
  **可证明的 no-op**，与视觉零关系。

  「哪些类在用」由 tools/css_scan.py 统一给出（最大匹配切词 + 后缀拼接 +
  真实动态前缀三条判据），本脚本不自行实现，避免两处口径漂移。

保留判据（宁可少删，不可错删）：
  · 选择器里**没有任何类**（元素选择器、:root、@keyframes 外层）→ 保留；
  · 选择器含至少一个「在用类」→ 保留；
  · @media / @supports 递归裁剪内部规则，空壳自动丢弃；
  · @keyframes 只保留被「保留下来的声明」引用到的名字；
  · CSS 变量定义（:root）永远保留。

排版：保留下来的规则一律拼**原始片段**（raw），只对含删除项的 @media 重建，
重建时沿用 `{` 之前的原文前缀 —— 保证 diff 只反映被删的行。

用法：
  python tools/css-prune.py           # 预演，只报数
  python tools/css-prune.py --apply   # 真删（先备份到 .workbuddy/tmp/）
"""
import re
import sys
import pathlib
import shutil

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from css_scan import CSS, ROOT, NAMESPACES, used_classes, is_used  # noqa: E402

RE_SEL_CLASS = re.compile(r'\.([A-Za-z0-9_-]+)')
RE_ANIM = re.compile(r'animation(?:-name)?\s*:\s*([A-Za-z0-9_-]+)')

# ('raw', pre, body, raw) | ('rule'|'at', pre, body, raw)  —— pre 是 `{` 之前的原文
RAW, RULE, AT = 'raw', 'rule', 'at'


def split_sel_list(body):
    """按顶层逗号切选择器列表，保留每段自己的前后空白（重建时零排版漂移）。

    `:not(.a, .b)` / `:is(...)` 里的逗号不算分隔符，故做括号深度判断。
    """
    out = []
    buf = ''
    depth = 0
    for ch in body:
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == ',' and depth == 0:
            out.append(buf)
            buf = ''
            continue
        buf += ch
    out.append(buf)
    return out


def sel_alive(s, exact, prefixes):
    """单个选择器是否可能匹配到元素。

    判据用 all 而不是 any：`.a.b` 与 `.a .b` 都要求**每一环**都有元素带着那个类，
    只要其中有一个类从未被应用，整条选择器就永远匹配不上。

    只看**我们自己的命名空间**（mt5700- / at-）。`cbi-*` 这类 LuCI 核心类由主题
    运行时挂上去，我们扫不到、也就无法证伪 —— 一律当作「可能在场」，不参与判定。
    否则 `.mt5700-card .cbi-input-text` 会被误判成死规则。
    """
    owned = [c for c in RE_SEL_CLASS.findall(s) if c.startswith(NAMESPACES)]
    if not owned:
        return True             # 元素 / 伪元素 / 纯外部类 → 无法证明死亡，保留
    return all(is_used(c, exact, prefixes) for c in owned)


def prune_selector(pre, exact, prefixes, dropped):
    """返回裁剪后的选择器原文；整条选择器列表全死则返回 None。"""
    body = pre.rstrip()
    tail = pre[len(body):]
    alive = []
    for piece in split_sel_list(body):
        s = piece.strip()
        if not s:
            continue
        if sel_alive(s, exact, prefixes):
            alive.append(piece)
        else:
            dropped.append(s)
    if not alive:
        return None
    return ','.join(alive) + tail


def split_rules(text):
    """切成扁平序列，支持任意深度 @media 嵌套（外层只切片，不展开）。"""
    out = []
    i = 0
    n = len(text)
    while i < n:
        m = re.match(r'\s+', text[i:])
        if m:
            out.append((RAW, '', '', m.group(0)))
            i += len(m.group(0))
            continue
        if text.startswith('/*', i):
            j = text.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append((RAW, '', '', text[i:j]))
            i = j
            continue
        k = text.find('{', i)
        if k < 0:
            out.append((RAW, '', '', text[i:]))
            break
        depth = 0
        j = k
        while j < n:
            if text[j] == '{':
                depth += 1
            elif text[j] == '}':
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        pre = text[i:k]
        kind = AT if pre.strip().startswith('@') else RULE
        out.append((kind, pre, text[k + 1:j - 1], text[i:j]))
        i = j
    return out


def prune_body(body, exact, prefixes, dropped):
    """递归裁剪块体，返回保留片段拼接文本。"""
    kept = []
    for kind, pre, inner, raw in split_rules(body):
        if kind == RAW:
            kept.append(raw)
            continue
        if kind == AT and pre.strip().startswith(('@media', '@supports')):
            sub = prune_body(inner, exact, prefixes, dropped)
            if '{' in sub:
                kept.append(pre + '{' + sub + '}')
            continue
        if kind == RULE:
            new_pre = prune_selector(pre, exact, prefixes, dropped)
            if new_pre is not None:
                kept.append(raw if new_pre == pre else new_pre + '{' + inner + '}')
            continue
        kept.append(raw)                        # @keyframes / @font-face 等
    return ''.join(kept)


def main():
    apply_ = '--apply' in sys.argv
    text = CSS.read_text(encoding='utf-8')
    exact, prefixes = used_classes(strict=False)

    dropped = []
    out = []
    for kind, pre, body, raw in split_rules(text):
        if kind == RAW:
            out.append(raw)
            continue
        if kind == AT and pre.strip().startswith(('@media', '@supports')):
            sub = prune_body(body, exact, prefixes, dropped)
            if '{' in sub:
                out.append(pre + '{' + sub + '}')
            continue
        if kind == RULE:
            new_pre = prune_selector(pre, exact, prefixes, dropped)
            if new_pre is not None:
                out.append(raw if new_pre == pre else new_pre + '{' + body + '}')
            continue
        out.append(raw)                         # @keyframes / @font-face / @charset

    assembled = ''.join(out)

    # 第二轮：丢弃没被任何保留声明引用的 @keyframes
    anim_refs = set(RE_ANIM.findall(assembled))
    final = []
    for kind, pre, body, raw in split_rules(assembled):
        if kind == AT and pre.strip().startswith('@keyframes'):
            if pre.split()[-1] not in anim_refs:
                dropped.append(pre.strip())
                continue
        final.append(raw)

    new_text = re.sub(r'\n{3,}', '\n\n', ''.join(final))

    print(f'原：{len(text)} 字符 / {text.count(chr(10))} 行')
    print(f'新：{len(new_text)} 字符 / {new_text.count(chr(10))} 行')
    print(f'删除选择器 {len(dropped)} 条')
    print(f'节省 {len(text) - len(new_text)} 字符（{(len(text)-len(new_text))/len(text)*100:.1f}%）')
    if dropped:
        print('\n被删选择器（全量）：')
        for s in dropped:
            print('  ·', ' '.join(s.split())[:100])

    if apply_:
        bak = ROOT / '.workbuddy' / 'tmp' / 'mt5700.css.before-prune'
        bak.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(CSS, bak)
        CSS.write_text(new_text, encoding='utf-8', newline='\n')
        print(f'\n已写入（备份：{bak}）')
    else:
        print('\n（预演；加 --apply 才写入）')


if __name__ == '__main__':
    main()
