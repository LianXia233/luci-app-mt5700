#!/usr/bin/env python3
"""CSS 类覆盖率审计 —— 前端用到的类必须都有定义，定义了的类不该无人使用。

为什么需要它（真实故障，不是想象）：
  1. 样式表是**追加式**长出来的：旧 WebUI 的 `.at-*` 命名空间留在文件里，
     后来每版都往末尾叠一层补丁。结果近 25% 是从未被引用的死规则，
     还有同名类被定义 13 次、谁生效要看叠放顺序。
  2. 反过来更危险：JS 里拼出来的类名（`'mt5700-btn mt5700-btn-' + variant`）
     在 CSS 里漏定义时，页面**不报错、只是长得不对**，测试也全绿。

「哪些类在用」由 tools/css_scan.py 统一给出，本脚本不另立口径。

  MISSING：JS 用到但 CSS 没定义 → 必须修（页面静默长错）。
  DEAD   ：CSS 定义但全仓库无人引用 → 候选删除；`css-prune.py` 负责安全删。
  DYNAMIC_ALLOW：动态族的合法成员表。表里的成员必须真在代码里出现过——
          若某成员已无人引用，说明表本身过期了，这里会告警。

用法：
  python tools/css-class-audit.py            # 报告
  python tools/css-class-audit.py --strict   # MISSING 非空则退出码 1（给测试用）
"""
import re
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from css_scan import (CSS, used_classes, state_pairs_js,  # noqa: E402
                      state_pairs_css)
# 动态拼接族：CSS 里以 `前缀-` 定义的类，实际取值由 JS 运行时决定。
# value 是该族的合法成员，审计时按「前缀 + 成员」逐条核对是否存在定义。
DYNAMIC_ALLOW = {
    'mt5700-btn': ['primary', 'secondary', 'success', 'danger', 'ghost', 'sm', 'icon'],
    'mt5700-badge': ['neutral', 'success', 'warning', 'danger', 'info', 'primary', 'dot'],
    'mt5700-toast': ['success', 'error', 'warning', 'info'],
}

RE_CSS_SEL = re.compile(r'\.((?:mt5700|at)-[a-zA-Z0-9_-]+)')


def main():
    strict_mode = '--strict' in sys.argv
    # MISSING 用精确口径（只认类位置），DEAD 用宽松口径（宁可多留）
    exact, prefixes = used_classes(strict=True)
    broad_exact, broad_prefixes = used_classes(strict=False)
    css = CSS.read_text(encoding='utf-8', errors='replace')
    # 去注释后再提选择器：注释里常写「旧写法 .at-sms-del 已废弃」，若把注释
    # 当选择器，DEAD 列表会把这些"只在注释里出现"的类报成仍然存在。
    css_code = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    defined = set(RE_CSS_SEL.findall(css_code))

    # 动态族展开：前缀 + 成员
    expanded = set()
    for prefix in sorted(set(prefixes) | set(broad_prefixes)):
        members = DYNAMIC_ALLOW.get(prefix.rstrip('-'))
        if members:
            expanded.update(prefix + m for m in members)
    # 族的基本名（如 mt5700-btn）本身也是类，但只有登记在 DYNAMIC_ALLOW 里才算，
    # 否则 `mt5700-log-`（下载文件名）、`mt5700-grad-`（SVG 渐变 id）会凭空造出
    # `mt5700-log` / `mt5700-grad` 两条假的 MISSING。
    expanded.update(DYNAMIC_ALLOW)

    used = exact | expanded                 # MISSING 的分母（精确）
    used_broad = broad_exact | expanded     # DEAD 的分母（宽松）

    state_mods = {c for c in used if c.startswith(('is-', 'has-'))}
    used_cls = {c for c in used if not c.startswith(('is-', 'has-'))}

    missing = sorted(used_cls - defined)
    dead = sorted(c for c in (defined - used_broad)
                  if not c.startswith(('is-', 'has-'))
                  and not any(c.startswith(p) for p in broad_prefixes))

    # 允许表自检：登记了但代码里已无人引用的成员＝表过期
    stale = []
    for fam, members in DYNAMIC_ALLOW.items():
        for m in members:
            full = fam + '-' + m
            if full in defined and full not in used_cls:
                stale.append(full)

    print(f'CSS：{len(css)} 字符 / {css.count(chr(10))} 行 / 定义 {len(defined)} 类')
    print(f'JS 引用：{len(used_cls)} 类（另有 {len(state_mods)} 个 is-*/has-* 状态修饰符）')
    print(f'动态前缀：{sorted(prefixes) if prefixes else "（无）"}')
    print()
    if missing:
        print(f'❌ MISSING {len(missing)} 个 —— JS 用到但 CSS 未定义（页面会静默长错）：')
        for c in missing:
            print('   ·', c)
    else:
        print('✅ MISSING 0 个')
    print()
    if dead:
        print(f'⚠️  DEAD {len(dead)} 个 —— CSS 定义但无人引用（用 css-prune.py 安全删除）：')
        for c in dead:
            print('   ·', c)
    else:
        print('✅ DEAD 0 个')
    if stale:
        print()
        print(f'⚠️  允许表过期 {len(stale)} 个 —— DYNAMIC_ALLOW 登记但代码已不再使用：')
        for c in stale:
            print('   ·', c)

    # 第三段：状态类挂了却没有配对样式（真实故障形态，见 css_scan 注释）
    js_pairs, unresolved, total = state_pairs_js()
    css_pairs = state_pairs_css(css)
    # 元素可能同时挂多个类，只要**任一**宿主类有对应状态规则就算接上了
    unstyled = sorted((bases, s) for bases, s in js_pairs
                      if not any((b, s) in css_pairs for b in bases))
    print()
    if unstyled:
        print(f'❌ 状态类无样式 {len(unstyled)} 个 —— JS 会挂上，CSS 没有配对规则：')
        for bases, s in unstyled:
            print(f'   · {" / ".join("." + b for b in bases)} + .{s}')
    else:
        judged = len(js_pairs)
        print(f'✅ 已判定的状态类均有样式（{judged}/{total} 个挂载点可判定，'
              f'其余 {unresolved} 处宿主类不是就近 var 声明、未判定）')

    if strict_mode and missing:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
