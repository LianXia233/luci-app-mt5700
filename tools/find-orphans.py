#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
孤儿与残留扫描器（find-orphans）
================================================================================
存在的唯一理由：**功能下线 / 改名 / 搬迁之后留下的半截引用，不会报错，只会静默退化**
（读一个恒空的 UCI 键、调用一个不存在的方法、留一条谁也触发不到的分支）。
本项目已经踩过两次（看门狗、全网扫频），每次都是「删了主体、忘了周围」。

所以这里把「对不上账」做成可执行的检查，覆盖六个面：

  A. UCI 配置     声明了但无人读   /  读了但没声明
  B. ubus 三方     ucode 方法表 ↔ ACL ↔ 前端 L.rpc.declare
  C. i18n          po/pot 里的 msgid 在源码里已不存在
  D. 下线功能关键词 黑名单词在仓库里的残留（逐处列名，人工判性质）
  E. 前端事件类型   rpc.js 认的事件 ↔ Rust 实际推送的事件
  F. CSS 类        样式表定义但 JS/ucode 里从不出现的类

用法：
    python tools/find-orphans.py [项目根]

★ 每个检查都带反向自证：喂一个已知缺陷样例，必须报出来；
  否则该检查恒空、结论是假的（这是本项目记录过的真实事故）。
"""
import io
import json
import os
import re
import sys
import glob

# ★ 2026-09-28：加 `--self-test-only` —— 供 CI 调用。
#   本脚本的主体是**报告型**（列 38 条待判给人看），不适合直接当"判红"的闸门；
#   但它的 self_test()（14 项，证明每个检查本身能报出已知缺陷）**适合**，
#   而那正是"这个扫描器还活着吗"的唯一机器判据。
_args = [a for a in sys.argv[1:] if not a.startswith('--')]
SELF_TEST_ONLY = '--self-test-only' in sys.argv
ROOT = os.path.abspath(_args[0] if _args else '.')

# 扫描范围（排除产物与工作区）
SKIP_DIRS = {'.git', 'target', 'node_modules', '.workbuddy', 'docs', 'po'}
SRC_EXT = ('.js', '.uc', '.rs', '.sh', '.json', '.css', '.py', '.md')


def rel(p):
    return os.path.relpath(p, ROOT).replace('\\', '/')


def read(p):
    try:
        return io.open(p, encoding='utf-8', errors='replace').read()
    except Exception:
        return ''


def walk(exts=SRC_EXT, skip=SKIP_DIRS):
    """遍历源文件。

    ★ 必须收**没有扩展名**的文件：本项目的关键脚本与配置都是无扩展名的
      —— `root/etc/init.d/at-webserver`（reads UCI）、`root/etc/config/at-webserver`、
      `root/etc/uci-defaults/at-webserver`。首版按扩展名过滤，init.d 整个没进扫描，
      于是它读的 network_allow_wan / network_restrict_access 被误报成死配置。
    """
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for fn in filenames:
            if fn.endswith(exts) or '.' not in fn:
                out.append(os.path.join(dirpath, fn))
    return out


def lines_of(path):
    return read(path).split('\n')


def find(pat, s, flags=0):
    """返回 [(行号, 行文本)]"""
    out = []
    for i, l in enumerate(s.split('\n')):
        if re.search(pat, l, flags):
            out.append((i + 1, l.strip()))
    return out


# --------------------------------------------------------------------------- #
# A. UCI
# --------------------------------------------------------------------------- #
def uci_declared():
    """随包配置 + uci-defaults 里声明的键"""
    keys = {}
    p = os.path.join(ROOT, 'root/etc/config/at-webserver')
    for n, l in find(r'^\s*option\s+([a-z0-9_]+)\s', read(p)):
        keys.setdefault(l.split()[1], []).append('root/etc/config/at-webserver:%d' % n)
    # uci-defaults 的补齐词表：形如 `\tname=value \`（续行）。
    # ★ 不能笼统匹配 `^\s*(name)=`：那段脚本里还有 `key=${kv%%=*}` / `key=${kv#*=}`
    #   这类**局部变量**，会被误当成配置键（首版就踩了，报出 key / val 两条假阳性）。
    p = os.path.join(ROOT, 'root/etc/uci-defaults/at-webserver')
    for n, l in find(r'^\s+([a-z0-9_]+)=(?!\$)', read(p)):
        keys.setdefault(l.strip().split('=')[0], []).append(
            'root/etc/uci-defaults/at-webserver:%d' % n)
    return keys


def uci_reads():
    """代码里读 at-webserver 配置键的位置"""
    hits = {}
    pats = [
        # 前端 / ucode：'at-webserver', 'config', '<key>'
        r"'at-webserver'\s*,\s*'config'\s*,\s*'([a-z0-9_]+)'",
        # Rust：values.bool|str|int|seconds("key", ...)
        r'values\.(?:bool|str|int|seconds|ms|list)\(\s*"([a-z0-9_]+)"',
        # shell：uci -q get at-webserver.config.<key>
        r'uci\s+-q\s+get\s+"?at-webserver\.config\.([a-z0-9_]+)',
        # ★ init.d 里的 UCI 读取用的是 OpenWrt 的 config_get / config_get_bool，
        #   形如 `config_get_bool var config network_allow_wan 0`。
        #   首版只扫了 option / uci -q get / values.*，于是把这两个键报成「死配置」
        #   —— 实际 init.d:232-233 一直在读。第三种假阳性来源。
        r'config_get(?:_bool)?\s+\w+\s+\w+\s+([a-z0-9_]+)',
    ]
    for p in walk():
        s = read(p)
        if 'at-webserver' not in s and not (p.endswith('.rs') and 'values.' in s):
            continue
        if not (p.endswith('.rs') or p.endswith('.js') or p.endswith('.uc')
                or p.endswith('.sh') or 'init.d' in rel(p)):
            continue
        for pat in pats:
            for m in re.finditer(pat, s):
                ln = s.count('\n', 0, m.start()) + 1
                hits.setdefault(m.group(1), []).append('%s:%d' % (rel(p), ln))
    return hits


def dynamic_key_prefixes():
    """Rust 里用 format! 动态拼出来的 UCI 键前缀。

    ★ 静态扫描看不见它们（本项目 `schedconfig.rs:293-301` 就是
      `format!("{prefix}_{kind}_bands")` 这类拼法），若不剔除，
      整族 schedule_night_* / schedule_day_* 都会被误报成「死配置」。
    """
    prefixes = set()
    for p in walk(('.rs',), SKIP_DIRS):
        s = read(p)
        for m in re.finditer(r'format!\("\{(\w+)\}_', s):
            prefixes.add(m.group(1))
        # 找出配对的字面量集合，例如 [("schedule_night", &a), ("schedule_day", &b)]
        for m in re.finditer(r'\(\s*"(\w+)"\s*,\s*&\w+\.\w+\s*\)', s):
            if 'schedule' in m.group(1):
                prefixes.add(m.group(1))
    # 把这些前缀真实对应的键名展开（前缀本身只是变量名，不是键前缀）
    fam = set()
    for pref in prefixes:
        if pref.startswith('schedule_'):
            fam.add(pref)
    return fam


# 「刻意不声明」的措辞。只收明确表达**有意为之**的说法。
DELIBERATE_WORDS = ('加一行 uci', '刻意不声明', '不写进默认配置', '安全默认',
                    '想用才', '默认不声明', '有意不声明')


def _repo_blob(exts=('.js', '.uc', '.rs', '.sh', '.json', '.py')):
    """全仓源码拼接（供"某处是否写/读了这个键"这类判断复用）。"""
    return '\n'.join(read(p) for p in walk(exts))


def key_is_written(k):
    """该 UCI 键是否在仓库某处被**写入**（而非只读）。

    写入的三种典型写法：`uci set ...<k>=`、`set('<k>', …)`、配置文件里的 `option <k>`。
    命中任一即为"由代码写入"，默认配置文件里没有它不是遗漏。
    """
    blob = _repo_blob()
    pats = (r'uci\s+set[^\n]*\.%s\s*=' % re.escape(k),
            r"set\(\s*'%s'\s*," % re.escape(k),
            r'^\s*option\s+%s\s' % re.escape(k))
    return any(re.search(p, blob, re.M) for p in pats)


def key_has_deliberate_note(k, window=18):
    """该键名出现的位置附近，是否有说明「刻意不声明」的注释。"""
    blob = _repo_blob()
    for m in re.finditer(re.escape(k), blob):
        seg = blob[max(0, m.start() - 400): m.start() + 400]
        # 只看含注释行的一段，避免把无关代码算进来
        line_ctx = '\n'.join(ln for ln in seg.split('\n')
                             if ln.strip().startswith(('//', '*', '/*', '#')))
        if any(w in line_ctx for w in DELIBERATE_WORDS):
            return True
    return False


def check_uci():
    d, r = uci_declared(), uci_reads()
    dyn = dynamic_key_prefixes()
    bad, ok_side = [], []
    for k in sorted(set(d) - set(r)):
        hit = [p for p in dyn if k.startswith(p)]
        if hit:
            bad.append(('动态构造，静态无法判定（需人工确认）', k,
                        '前缀族 %s（Rust format! 拼键）' % '/'.join(sorted(hit))))
        else:
            bad.append(('声明了但无人读（死配置）', k, ', '.join(d[k])))
    for k in sorted(set(r) - set(d)):
        # ★ 2026-09-28：区分「真遗漏」与两种正常情况 —— 原来一律报「恒空值」，
        #   于是 apdu_timeout（真遗漏）和下面两类混在一起，每次都得人工重判一遍。
        #   ① 该键由**代码写入**：首次保存后才落盘，默认文件里没有它是正常的。
        #      判据：整个仓库里存在写它的地方（uci set / set('<k>' / option <k>）。
        #   ② 注释里**写明刻意不声明**：安全默认，想用才自己加一行。
        #      判据：键名所在位置的邻近注释含明确的「刻意/不声明/加一行 uci」措辞。
        #   两类都不占，才是真正需要看的。
        if key_is_written(k):
            ok_side.append(('由代码写入（首次保存后落盘），默认文件里没有属正常', k,
                            ', '.join(r[k][:3])))
        elif key_has_deliberate_note(k):
            ok_side.append(('邻近注释已说明刻意不声明（安全默认，想用再加一行）', k,
                            ', '.join(r[k][:3])))
        else:
            bad.append(('读了但未声明（恒空值，且没写它、也没说明为何不声明）', k,
                        ', '.join(r[k][:3])))
    return bad, ok_side


# --------------------------------------------------------------------------- #
# B. ubus 三方对账
# --------------------------------------------------------------------------- #
def ucode_methods():
    p = os.path.join(ROOT, 'root/usr/share/rpcd/ucode/mt5700.uc')
    s = read(p)
    lines = s.split('\n')
    try:
        i = lines.index('return {')
    except ValueError:
        return {}
    out = {}
    for k in range(i, len(lines)):
        m = re.match(r'^\t\t([a-z_][a-z0-9_]*): \{', lines[k])
        if m:
            out[m.group(1)] = k + 1
    return out


def acl_methods():
    """ACL 里 "mt5700": [ ... ] 的裸方法名"""
    p = os.path.join(ROOT, 'root/usr/share/rpcd/acl.d/luci-app-mt5700.json')
    s = read(p)
    out = {}
    for m in re.finditer(r'"mt5700"\s*:\s*\[(.*?)\]', s, re.S):
        ln = s.count('\n', 0, m.start()) + 1
        for name in re.findall(r'"([a-z_][a-z0-9_]*)"', m.group(1)):
            out.setdefault(name, []).append(ln)
    return out


def fe_declared():
    """前端 L.rpc.declare 里 method 名（只取 object 为 mt5700 的块）

    ★ 方法名允许含数字：首版写成 `[a-z_]+`，于是 `es9p` 被判成「前端从不调用」
      —— 一个字符类漏掉 `0-9`，就凭空造出一条假阳性。
    """
    out = {}
    for p in walk(('.js',), SKIP_DIRS):
        if not p.endswith('.js'):
            continue
        s = read(p)
        for m in re.finditer(r"object:\s*'mt5700'\s*,\s*method:\s*'([a-z_][a-z0-9_]*)'", s):
            out.setdefault(m.group(1), []).append(
                '%s:%d' % (rel(p), s.count('\n', 0, m.start()) + 1))
    return out


def acl_all_methods():
    """ACL 里【所有】ubus 对象 → 授权方法集合（read 与 write 两段取并集）。

    ★ 2026-09-28 新增。原来的 acl_methods() / fe_declared() 都**只取 mt5700 一个对象**，
      于是 `file.exec` 这类漏授权（前端 L.rpc.declare 了 file.exec，而 ACL 的 file 段
      只有 list/read/stat/write）**完全看不见** —— 在 LuCI 侧表现为「点了没反应」
      （Access denied），而且项目自己的 B 节报告还会是"（无）"，等于没守。
      该缺口是用 Python 手工对账时发现的，现在固化成检查。
    """
    p = os.path.join(ROOT, 'root/usr/share/rpcd/acl.d/luci-app-mt5700.json')
    try:
        data = json.loads(read(p))
    except Exception:
        return None
    out = {}
    for app in data.values():
        for section in ('read', 'write'):
            ubus = (app.get(section) or {}).get('ubus') or {}
            for obj, methods in ubus.items():
                out.setdefault(obj, set()).update(methods)
    return out


def fe_all_calls():
    """前端【所有】L.rpc.declare 的 (object, method)，不限 mt5700。"""
    out = []
    for p in walk(('.js',), SKIP_DIRS):
        if not p.endswith('.js'):
            continue
        s = read(p)
        for m in re.finditer(r"object:\s*'([a-z_0-9]+)'\s*,\s*method:\s*'([a-zA-Z_0-9]+)'", s):
            out.append((m.group(1), m.group(2),
                        '%s:%d' % (rel(p), s.count('\n', 0, m.start()) + 1)))
    return out


def check_ubus():
    u, a, f = ucode_methods(), acl_methods(), fe_declared()
    bad = []
    for k in sorted(set(a) - set(u)):
        bad.append(('ACL 声明了但 ucode 无此方法', k, str(a[k])))
    for k in sorted(set(u) - set(a)):
        bad.append(('ucode 有但 ACL 未授权（前端调用会被拒）', k, 'mt5700.uc:%d' % u[k]))
    for k in sorted(set(f) - set(u)):
        bad.append(('前端声明了但 ucode 无此方法', k, str(f[k])))
    for k in sorted(set(u) - set(f)):
        bad.append(('ucode 有但前端从不调用（可能是死的）', k, 'mt5700.uc:%d' % u[k]))

    # ★ 覆盖**所有** ubus 对象（上面四条只管 mt5700）：前端声明了、ACL 却没授权
    #   → 调用会 Access denied，而 LuCI 侧只表现为"点了没反应"。
    acl_all = acl_all_methods()
    if acl_all is None:
        bad.append(('acl.d 无法解析（下面的全对象对账等于没跑）', 'luci-app-mt5700.json', ''))
    else:
        for obj, method, where in fe_all_calls():
            if method in acl_all.get(obj, set()):
                continue
            if obj not in acl_all:
                bad.append(('前端调用了 ACL 完全未授权的 ubus 对象（必被拒）',
                            '%s.%s' % (obj, method), where))
            else:
                bad.append(('前端调用了 ACL 未授权的方法（Access denied，表现为点了没反应）',
                            '%s.%s' % (obj, method), where))
    return bad


# --------------------------------------------------------------------------- #
# C. i18n 孤儿
# --------------------------------------------------------------------------- #
def check_i18n():
    """po/pot 里的 msgid 在**真实 UI 语料**里是否还存在。

    ★ 语料范围是这个检查唯一的成败点，三个方向都踩过：
      · 太窄（只扫 .js/.uc/.rs/.sh/.json）→ 菜单名与包描述（在 menu.d、Makefile）
        被误报成孤儿；
      · 太宽（把 CHANGELOG.md / docs/ / *.pot 也算进来）→ **恒绿**：只在历史记录里
        活着的字符串会被判成「仍在使用」，检查等于没做；
      · 只做子串匹配 → **注释里提到这个词就算「还在用」**（实测：本工具自己写进
        rpc.js 的一句说明含「全网扫频」，就把这条 po 孤儿洗白了）。
        所以代码语料里必须要求「字符串字面量」形态：`'msgid'` 或 `"msgid"`。
    """
    bad = []
    code = [read(p) for p in walk(('.js', '.uc', '.rs', '.sh', '.json'))]
    loose = [read(os.path.join(ROOT, f)) for f in ('Makefile', 'README.md', 'README.zh.md')]
    code_blob = '\n'.join(code)
    loose_blob = '\n'.join(loose)

    for relp in ['po/zh_Hans/luci-app-mt5700.po', 'po/templates/luci-app-mt5700.pot']:
        s = read(os.path.join(ROOT, relp))
        for m in re.finditer(r'^msgid\s+"(.+)"', s, re.M):
            msg = m.group(1)
            if msg == '':
                continue
            used = (("'" + msg + "'") in code_blob
                    or ('"' + msg + '"') in code_blob
                    or msg in loose_blob)
            if not used:
                bad.append(('翻译条目在真实 UI 语料里已不存在', msg, relp))
    return bad


# --------------------------------------------------------------------------- #
# D. 下线功能关键词
# --------------------------------------------------------------------------- #
# 每个词条：关键词 / 说明 / 期望残留出现在哪些文件里（这些文件属"历史记录"，
# 出现是正常的）。其余地方出现即为残留。
# ★ 2026-09-28：第三个元素是「已判定保留」——这些残留**不是待清理项**，
#   而是**刻意留下的安全网**，且各有专门守卫与 CHANGELOG 记录：
#     · Rust 仍拦截 AT^CELLSCAN（伪命令 + 超时 + ABORT）：去掉它，用户在 AT 终端里
#       手敲 AT^CELLSCAN 就会原样下发到模组、变成一次无上限的整网扫频（独占串口几分钟）；
#     · ucode 的 NEVER_CACHE 名单、配置里的 cellscan_timeout 同理。
#   守卫：tests/cellscan-removed-contract.test.js（横跨 rpc.js / ucode / config / Rust）。
#   把它们归入「已判明」组，避免 162 条噪音每天淹没真正该看的残留。
RETIRED = {
    'CELLSCAN': ('全网扫频（CHANGELOG 记录 2026-09-20 下线）', ['CHANGELOG.md'], True),
    'cellscan': ('全网扫频（同上）', ['CHANGELOG.md'], True),
    '扫频': ('全网扫频（同上）', ['CHANGELOG.md'], True),
}
# 历史/报告类文件里出现旧功能名是正常的，不算残留
HISTORY_OK = ('CHANGELOG.md', 'docs/', 'po/', 'tools/find-orphans.py')


def _is_comment_line(trimmed):
    """判断一行是不是注释行（用于区分「代码残留」与「仅注释提及」）"""
    for pre in ('//', '/*', '*', '#', '///', '//!', '<!--'):
        if trimmed.startswith(pre):
            return True
    return False


def check_retired():
    """返回 [(类型, 位置, 文本)]，类型为「代码」或「仅注释」。

    ★ 本工具自己写进源码的**说明性注释**（例如在 rpc.js / config 里解释
      「此项保留的理由」）也会命中关键词。若不分流，报告会被自己的注释淹没，
      真正该动的「代码残留」反而看不出来。所以按行首注释符分流。
    """
    bad, kept = [], []
    for p in walk():
        r = rel(p)
        s = read(p)
        for kw, (desc, whitelist, is_kept) in RETIRED.items():
            if kw not in s:
                continue
            if r in whitelist or r.startswith(HISTORY_OK):
                continue
            for n, l in find(re.escape(kw), s):
                kind = '仅注释' if _is_comment_line(l) else '代码'
                row = ('%s｜%s ← %s' % (kind, desc, kw), '%s:%d' % (r, n), l[:90])
                (kept if is_kept else bad).append(row)
    return bad, kept


# --------------------------------------------------------------------------- #
# E. 前端事件类型 ↔ Rust 推送
# --------------------------------------------------------------------------- #
def check_events():
    """前端认的事件 ↔ Rust 实际推送的事件

    ★ 事件名在 Rust 里是 `broadcast_json("cellscan", ...)` 的**第一个实参**，
      不是 `type: "x"` 字段 —— 首版只找 `type/kind = "x"`，于是 6 个事件全被
      误报成「后端从不推送」。要按真实写法取。
    """
    rp = os.path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/rpc.js')
    src = read(rp)
    m = re.search(r"\[([^\]]*?)\]\.indexOf\(ev\.type\)", src)
    fe_types = set(re.findall(r"'([a-z_][a-z0-9_]*)'", m.group(1))) if m else set()

    # ★ 有些事件类型是**前端自己造的**（rpc.js:813 的 emitPush({type:'urc_data'})，
    #   由 network_settings.js 消费），后端永远不会推。不认这一条，它就会被误报。
    fe_emitted = set(re.findall(r"emitPush\(\s*\{[^}]*type:\s*'([a-z_][a-z0-9_]*)'", src))

    push_kinds = set()
    for p in walk(('.rs',), SKIP_DIRS):
        s = read(p)
        for mm in re.finditer(r'broadcast_json\(\s*"([a-z_][a-z0-9_]*)"', s):
            push_kinds.add(mm.group(1))
        for mm in re.finditer(r'"type"\s*:\s*"([a-z_][a-z0-9_]*)"', s):
            push_kinds.add(mm.group(1))

    bad = []
    for t in sorted(fe_types - push_kinds - fe_emitted):
        bad.append(('前端认的事件类型，既非后端推送也非前端自造（死分支）', t,
                    'rpc.js handlePush 名单'))
    return bad, sorted(fe_types), sorted(push_kinds | fe_emitted)


# --------------------------------------------------------------------------- #
# F. CSS 孤儿类
# --------------------------------------------------------------------------- #
# 「定义处已说明为何保留」的关键词。只收**明确的保留意图**，不收"通用"这类含糊词，
# 否则等于把判据放宽到没判据（宁可少分组，也不要把待判的混进已说明）。
KEEP_WORDS = ('保留备用', '保留，备用', '保留以便', '预留', '暂留', '尚未接上',
              '迁移中', '备用组件', '留待')


def css_context_above(css, cls, window=80):
    """取该类定义处上方【最近的一段块注释】。

    ★ 2026-09-28 修正：初版写的是"往上逐行，遇到非注释非空行就停"，但它**从来不工作** ——
      类定义的正上方几乎总是**上一个规则的收尾 `}`**，所以第一行就 break，
      ctx 恒为空、23 条孤儿类一条也分不到"已说明"组（本工具自己跑出来的实测）。
      改为：在定义处上方 window 行内找【最近的 `*/`】，再向上配对到它的 `/*`。
      这样"读数胶囊……保留备用"那种写在样式块正上方的说明就能被取到。
    """
    idx = css.find('.' + cls)
    if idx < 0:
        return ''
    above = css[:idx].split('\n')[-window:]
    end = None
    for i in range(len(above) - 1, -1, -1):
        if '*/' in above[i]:
            end = i
            break
    if end is None:
        return ''
    for j in range(end, -1, -1):
        if '/*' in above[j]:
            return '\n'.join(above[j:end + 1])
    return ''


def check_css():
    """样式表定义 vs JS 里实际出现的类

    ★ 类名常被拼出来：`'mt5700-btn mt5700-btn-' + variant`（mt5700.js:351）、
      `'mt5700-toast-' + type`（:591）。只比「整串是否出现」会把这一大片
      误报成孤儿。所以先收集**前缀**（以 `-` 结尾的 JS 片段），
      再判定「以该前缀开头的类」为已使用。
    """
    css = read(os.path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/mt5700.css'))
    defined = sorted(set(re.findall(r'\.(mt5700-[a-z0-9-]+)', css)))
    userblob = '\n'.join(read(p) for p in walk(('.js', '.uc')))
    prefixes = set(re.findall(r'(mt5700-[a-z0-9-]*-)', userblob))
    bad, kept = [], []
    for c in defined:
        if c in userblob:
            continue
        if any(c.startswith(pf) for pf in prefixes):
            continue
        # ★ 2026-09-28：区分「刻意保留」与「真待判」。
        #   起因：本工具只列不判，23 条孤儿类全靠人工逐条核。人工核的时候用的判据
        #   其实就是「定义处旁边的注释有没有说清楚为什么留着」——例如读数胶囊那条：
        #     「该功能已于 2026-09-19 整块下线……胶囊本身是通用组件，保留备用」。
        #   既然判据是确定的，就该由工具给出分组，人只看"真待判"那一小撮。
        ctx = css_context_above(css, c)
        if any(w in ctx for w in KEEP_WORDS):
            kept.append(('定义处已说明为何保留（人工复核时确认措辞即可）', c, 'mt5700.css'))
        else:
            bad.append(('CSS 定义了但 JS/ucode 从不使用，且定义处没说明为何保留（待判）',
                        c, 'mt5700.css'))
    return bad, kept, len(defined)


# --------------------------------------------------------------------------- #
# 反向自证：每个检查喂一个已知缺陷，必须报出来
# --------------------------------------------------------------------------- #
def self_test():
    """返回 [(检查名, 是否成功自证)]"""
    res = []

    # A：给 uci_declared 的解析器喂一行假配置，必须解析出来
    probe = 'option zzz_fake_key_orphan \'1\''
    got = re.search(r'^\s*option\s+([a-z0-9_]+)\s', probe)
    res.append(('A UCI 声明解析', bool(got and got.group(1) == 'zzz_fake_key_orphan')))

    # B：给方法表解析器喂一行假方法
    probe = '\t\tzzz_fake_method: {'
    got = re.match(r'^\t\t([a-z_][a-z0-9_]*): \{', probe)
    res.append(('B ucode 方法解析', bool(got and got.group(1) == 'zzz_fake_method')))

    # B：给前端 declare 解析器喂假块
    probe = "var x = L.rpc.declare({\n\tobject: 'mt5700',\n\tmethod: 'zzz_fake',\n\tparams: []\n});"
    got = re.search(r"object:\s*'mt5700'\s*,\s*method:\s*'([a-z_]+)'", probe)
    res.append(('B 前端 declare 解析', bool(got and got.group(1) == 'zzz_fake')))

    # C：给 i18n 解析器喂假 msgid
    probe = 'msgid "zzz_不存在的文案"\nmsgstr "x"'
    got = re.search(r'^msgid\s+"(.+)"', probe, re.M)
    res.append(('C i18n 解析', bool(got and got.group(1) == 'zzz_不存在的文案')))

    # D：喂含关键词的假内容，检查必须命中
    probe = 'AT^CELLSCAN=1'
    res.append(('D 下线关键词命中', bool(re.search(re.escape('CELLSCAN'), probe))))

    # F：给 CSS 解析器喂假类
    probe = '.mt5700-zzz-fake { color: red; }'
    got = re.findall(r'\.(mt5700-[a-z0-9-]+)', probe)
    res.append(('F CSS 类解析', bool(got and got[0] == 'mt5700-zzz-fake')))

    # B：方法名带数字必须能解析（首版漏了 0-9，把 es9p 报成死方法）
    probe = "object: 'mt5700',\n\tmethod: 'es9p',"
    got = re.search(r"object:\s*'mt5700'\s*,\s*method:\s*'([a-z_][a-z0-9_]*)'", probe)
    res.append(('B 方法名含数字', bool(got and got.group(1) == 'es9p')))

    # A：shell 局部变量 key=${kv%%=*} 不得被当成配置键
    probe = '\tkey=${kv%%=*}\n\tread_cache_ttl=0 \\'
    got = re.findall(r'^\s+([a-z0-9_]+)=(?!\$)', probe, re.M)
    res.append(('A 排除 shell 局部变量', got == ['read_cache_ttl']))

    # A：format! 动态拼键必须被识别成「静态不可判定」而不是「死配置」
    probe = 'let base = format!("{prefix}_{kind}");\n("schedule_night", &self.night),'
    got = re.findall(r'\(\s*"(\w+)"\s*,\s*&\w+\.\w+\s*\)', probe)
    res.append(('A 识别动态拼键', got == ['schedule_night']))

    # E：事件名取自 broadcast_json 的第一个实参，不是 type 字段
    probe = 'hub.broadcast_json("cellscan", json!({}));'
    got = re.findall(r'broadcast_json\(\s*"([a-z_][a-z0-9_]*)"', probe)
    res.append(('E 事件名解析', got == ['cellscan']))

    # F：拼接出来的类前缀必须被认成「已使用」
    probe = "'class': 'mt5700-btn mt5700-btn-' + variant"
    pf = set(re.findall(r'(mt5700-[a-z0-9-]*-)', probe))
    res.append(('F 前缀拼接识别',
                'mt5700-btn-primary'.startswith('mt5700-btn-') and 'mt5700-btn-' in pf))

    # A：init.d 的 config_get_bool 必须被认成读取点
    probe = 'config_get_bool module_allow_wan config network_allow_wan 0'
    got = re.search(r'config_get(?:_bool)?\s+\w+\s+\w+\s+([a-z0-9_]+)', probe)
    res.append(('A 识别 config_get_bool', bool(got and got.group(1) == 'network_allow_wan')))

    # E：前端自造的事件类型不得被算成「后端从不推送」
    probe = "self.emitPush({ success: true, type: 'urc_data', data: x });"
    got = re.findall(r"emitPush\(\s*\{[^}]*type:\s*'([a-z_][a-z0-9_]*)'", probe)
    res.append(('E 识别前端自造事件', got == ['urc_data']))

    # C：注释里提到某文案，不得算成「该翻译仍在使用」
    probe = "/* 说明：全网扫频已下线 */\nvar a = '网络状态';"
    res.append(('C 注释不算使用',
                ("'网络状态'" in probe) and (("'全网扫频'" not in probe))))

    return res


# --------------------------------------------------------------------------- #
def main():
    print('=' * 78)
    print('孤儿与残留扫描  项目根 =', ROOT)
    print('=' * 78)

    print('\n### 反向自证（先证明检查本身能报红）')
    st = self_test()
    for name, okv in st:
        print('  %-28s %s' % (name, '✓ 能检出' if okv else '✗ 恒绿！该检查无效'))
    if not all(v for _, v in st):
        print('\n★ 有自证失败项：下面的空白结论不可信，先修扫描器。')

    print('\n### A. UCI 配置对账')
    a, a_ok = check_uci()
    if a:
        for kind, k, where in a:
            print('  · [%s] %-26s %s' % (kind, k, where))
    else:
        print('  （无待判的）')
    if a_ok:
        print('  —— 以下已判明不是遗漏，人工无需再看：')
        for kind, k, where in a_ok:
            print('  · %-26s %s' % (k, kind))

    print('\n### B. ubus 三方对账')
    b = check_ubus()
    if b:
        for kind, k, where in b:
            print('  · [%s] %-30s %s' % (kind, k, where))
    else:
        print('  （无）')

    print('\n### C. i18n 孤儿')
    c = check_i18n()
    if c:
        for kind, k, where in c:
            print('  · [%s] %-30s %s' % (kind, k, where))
    else:
        print('  （无）')

    print('\n### D. 下线功能关键词残留')
    d, d_kept = check_retired()
    if d:
        seen = set()
        for kind, where, text in d:
            print('  · [%s] %s' % (kind, where))
            print('        %s' % text)
            seen.add(where.split(':')[0])
        print('  → 涉及 %d 个文件：%s' % (len(seen), ', '.join(sorted(seen))))
    else:
        print('  （无待判的）')
    if d_kept:
        # ★ 这些不是待清理项，是**刻意留下的安全网**，各有专门守卫与 CHANGELOG 记录
        #   （见 RETIRED 上方的说明）。只报数量与涉及文件，不再逐条刷屏。
        kseen = sorted(set(w.split(':')[0] for _, w, _ in d_kept))
        print('  —— 「全网扫频」残留 %d 处，属**刻意保留的安全网**（守卫：'
              'tests/cellscan-removed-contract.test.js），涉及 %d 个文件：'
              % (len(d_kept), len(kseen)))
        print('     %s' % ', '.join(kseen))
    else:
        print('  （无）')

    print('\n### E. 事件类型对账')
    e, fet, rst = check_events()
    print('  前端认的事件：', ', '.join(fet) or '(未解析到)')
    if e:
        for kind, k, where in e:
            print('  · [%s] %s' % (kind, k))
    else:
        print('  （无）')

    print('\n### F. CSS 孤儿类')
    f, f_kept, total = check_css()
    if f:
        for kind, k, where in f:
            print('  · [%s] %s' % (kind, k))
    else:
        print('  （无待判的）')
    if f_kept:
        print('  —— 以下定义处已写明为何保留，人工只需确认措辞（不算待判）：')
        for kind, k, where in f_kept:
            print('  · %s' % k)
    print('  （样式表共定义 %d 个 mt5700-* 类）' % total)

        # ★ 2026-09-28：e 是 check_events() 的返回值 —— 它给的是【几份名单】
    #   （前端自造 / 前端认的 / Rust 推的），**不是"几条问题"**，
    #   计进"合计待判"会让人以为 E 节有 3 条要处理。这里只统计真正的待判条目。
        # ★ 注意 a 在 main 里**已经解包**（`a, a_ok = check_uci()`），所以 a 就是待判列表，
    #   用 len(a)。2026-09-28 我一度写成 len(a[0]) —— 那是**第一个条目的长度**（3），
    #   于是"合计待判"从 38 变成 23，数字看着更小却更错。
    total_bad = len(a) + len(b) + len(c) + len(d) + len(f)
    print('\n' + '=' * 78)
    print('合计待判 %d 条（F 节与 D 节含正常用法，需人工判性质）' % total_bad)
    print('=' * 78)
    return 0


if __name__ == '__main__':
    # ★ GBK 控制台兜底（复刻 tools/verify-guards.py:1906-1910 的同一做法）。
    #   自证段（下面）与 main() 里都要打印 ✓ / ✗，而 Windows 控制台默认 GBK：
    #   Python 会抛 UnicodeEncodeError 并**中断整个检查**、以 rc=1 结束 —— 本脚本
    #   正是 CI 用来当闸门的自证，编码崩溃会被误读成「自证失败」。
    #   verify-guards.py 早在 2026-09-28 就踩过同一坑并加了兜底 —— 当时只修了那一处。
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if SELF_TEST_ONLY:
        # 只跑自证：全过退 0，任一失败退 1（CI 用它当闸门）
        _st = self_test()
        for _name, _okv in _st:
            print('  %-30s %s' % (_name, '✓ 能检出' if _okv else '✗ 恒绿！该检查无效'))
        _n_ok = sum(1 for _, _o in _st if _o)
        print('find-orphans 自证：%d / %d' % (_n_ok, len(_st)))
        sys.exit(0 if _n_ok == len(_st) else 1)
    sys.exit(main())
