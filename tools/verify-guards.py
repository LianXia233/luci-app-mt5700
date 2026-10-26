#!/usr/bin/env python3
"""守卫有效性验证（红线 16：写了守卫 ≠ 有了守卫）。

做法：对源码 / 契约测试文件施加**故意违反契约**的变异（全部保持语法合法，
避免"语法错误导致崩溃"被误当成"守卫检出了"），跑对应契约测试并断言判红；
随后从备份逐字节还原并复核。

用法：python tools/verify-guards.py
新增守卫时应在上面的 MUTATIONS 里补一条「故意违反」样例。
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ATWB = ROOT / "htdocs" / "luci-static" / "resources" / "at-webserver"
ESIM = ROOT / "htdocs" / "luci-static" / "resources" / "view" / "at-webserver" / "esim.js"

TARGETS = {
    "js": ATWB / "euicc.js",
    "esimjs": ESIM,
    "esimcss": ATWB / "mt5700.css",
    # ★ 2026-09-28：init.d 此前【有守卫但从未被变异验证】—— 即 initd-contract
    #   里的断言可能是恒绿的。它守的是实机才暴露的问题（reload 删掉服务对象后
    #   进程列表一个后端都没有），最需要验证。
    "initd": ROOT / "root" / "etc" / "init.d" / "at-webserver",
    # ★ 2026-09-28 新增：compat.js 是 7 个前端共享模块里最后被纳入变异验证的一个
    #   （覆盖率盘点发现它此前被 0 个测试文件提到）。它是**全局兜底**：补
    #   String.prototype.format，失效后果不是"某个功能坏了"而是整个插件不可用。
    "compatjs": ATWB / "compat.js",
    "test": ROOT / "tests" / "euicc-download-contract.test.js",
    # euicc.js 的**同一份文件**再挂一个键：卡级阻断那组守卫在 esim-contract 里，
    # 而 "js" 键固定跑下载契约测试。一份文件两条测试通道，别把守卫挂错测试上。
    "js2": ATWB / "euicc.js",
    # mt5700.js 是**全站共用**组件（errorState 的按钮文案默认值就在这里），
    # 也要能被变异、被还原 —— 单独挂键，别和 euicc.js 混。
    "mt5700js": ATWB / "mt5700.js",
    # mt5700.js 再挂一个键：它同时被 single-source 契约守着（信号百分比真源），
    # 而 "mt5700js" 固定跑 esim-contract —— 一份文件两条测试通道，别挂错。
    "mt5700js2": ATWB / "mt5700.js",
    # 同一份 euicc.js 再挂第三个键：tag 白名单守卫走它自己的测试文件。
    "js3": ATWB / "euicc.js",
    # esim.js 再挂一个键：静默 catch 守卫是独立测试文件。
    "esimjs2": ESIM,
    # euicc.js 再挂第四个键：SW 9xxx 分支那组守卫在 euicc-contract 里
    # （「js」键跑的是下载契约测试，别挂错 —— 挂错就是变到别处、守卫恒绿）。
    "js4": ATWB / "euicc.js",
    # shell 脚本也要能变异：C 风格注释那条事故（glob 被当命令执行）守的是 .sh。
    "shell": ROOT / "root" / "usr" / "share" / "mt5700" / "diag-probe.sh",
    "msjs": ATWB.parent / "view" / "at-webserver" / "modem_settings.js",
    "upgjs": ATWB.parent / "view" / "at-webserver" / "upgrade.js",
    # 测试文件自身也要能被变异：断言签名守卫查的就是测试文件的写法。
    "test2": ROOT / "tests" / "device-control-contract.test.js",
    # 「单一真源」契约（tests/single-source-contract.test.js）覆盖多个文件，
    # 每个被它守着的文件都要能单独变异 —— 一份文件一个键，别混。
    "rpcjs": ATWB / "rpc.js",
    # rpc.js 再挂一个键：**通话响应透传**（stage / preflight 四字段）。
    # 2026-10-16 真实故障：中间这层没搬字段，后端在回、前端在读，唯独它没传 ——
    # 真机用 ubus 直调验证时**绕过**了这一层，所以没能暴露。见 MUTATIONS 175-177。
    "rpcjs8": ATWB / "rpc.js",
    "parsejs": ATWB / "parse.js",
    "termjs": ATWB.parent / "view" / "at-webserver" / "terminal.js",
    "smssetjs": ATWB.parent / "view" / "at-webserver" / "sms_settings.js",
    # 短信中心视图：收件箱归并（列表一份 + 推送一份不能各留一份）+ 未读标记。
    "smsjs": ATWB.parent / "view" / "at-webserver" / "sms_center.js",
    # Rust 后端也在守卫范围内（事件帧预算）；.rs 不做语法预检，见 syntax_ok。
    "rsrust": ROOT / "src" / "rust" / "src" / "rpcserver.rs",
    # ucode 后端（rpcd 插件）也在守卫范围内：exitip 的 bind 校验是**命令注入面**，
    # 必须能被故意违反并验证守卫判红。.uc 不做语法预检，见 syntax_ok。
    "uc": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    # parse.js 再挂一个键：出口 IP 解析那组守卫在 exitip-contract 里，
    # 而 "parsejs" 固定跑 single-source-contract —— 一份文件两条测试通道，别挂错。
    "parsejs2": ATWB / "parse.js",
    # ★ 再挂两个键（2026-09-24 真机校准）：短信可达性的「承载域 × CS 域」交叉判据
    #   横跨 parse.js（parseCsDomain）与 sms_settings.js（判据表达式），
    #   守卫在自己的 sms-reachability-contract 里。
    #   ★ 复用 parsejs2 / smssetjs 会**跑错测试**（它们分别固定跑 exitip-contract
    #   与 single-source-contract）→ 变异生效但没人判红 → 比没守卫更危险（红线 16b）。
    "parsejs3": ATWB / "parse.js",
    "smssetjs2": ATWB.parent / "view" / "at-webserver" / "sms_settings.js",
    # ★ 再挂三个键（2026-09-24）：VoWiFi 判定的守卫在自己的 vowifi-contract 里。
    #   复用 uc / rpcjs / msjs 会**跑错测试**（它们分别固定跑 exitip-contract、
    #   single-source-contract、device-control-contract）→ 变异生效却没人判红
    #   → 比没守卫更危险（红线 16b）。
    "uc2": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    # ucsyn：与 uc2 同文件、独立键（红线 16b）—— 挂 ucode 语法安全守卫
    "ucsyn": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    "rpcjs2": ATWB / "rpc.js",
    # ★★ 2026-09-24 迁页：VoWiFi 已整块搬到**模组设置**页，它的变异必须跟着改挂
    #   vowifijs（同为 modem_settings.js，但跑 vowifi-contract，不是 device-control）。
    #   原 "nsjs" 键指向 network_status.js 却配 vowifi-contract —— 迁页后这是**跑错
    #   测试**的组合（红线 16b），所以删键而不是留着。
    "vowifijs": ATWB.parent / "view" / "at-webserver" / "modem_settings.js",
    # ★ 2026-09-28：服务状态页的「读不到 ≠ 没有」守卫（service-status-unknown-contract）
    #   守 service.js 的三个 catch 是否留痕、resolveStatus 是否先判 unknown。
    #   service.js 此前没有任何变异目标 —— 新守卫当时只在本地手工验过，没进自动验证。
    "svcjs": ATWB.parent / "view" / "at-webserver" / "service.js",
    # 「调用了未定义的函数」守卫（tests/undefined-fn-contract.test.js）也按文件变异。
    "undeffnjs": ATWB.parent / "view" / "at-webserver" / "modem_settings.js",
    # ★ 再挂三个键（2026-09-25 全量审计）：引导收口契约（tests/bootstrap-contract.test.js）
    #   同时守着 mt5700.js 的 connectThen 定义、某个 view 页的用法、以及 ucode 的
    #   -32001 翻译。★ 复用 mt5700js / upgjs / uc2 会**跑错测试**（它们分别跑
    #   esim-contract、read-command-fresh-contract、vowifi-contract）
    #   → 变异生效却没人判红（红线 16b）。
    # ★★ 2026-09-25 性能专项的三份新契约，各自跑自己的测试文件（红线 16b）：
    #   复用 rpcjs / rpcjs2 / nsjs(旧) 都会跑错测试 → 变异生效却没人判红。
    #   · rpcjs3  守「失败命令自适应降级」（retry-backoff-contract）
    #   · warmjs  守「批量预热」的 rpc.js 侧行为（warm-cache-contract）
    #   · nsjs    守「慢档真的接了预热」（同一个 warm-cache-contract 的静态断言）
    "rpcjs3": ATWB / "rpc.js",
    "warmjs": ATWB / "rpc.js",
    "nsjs": ATWB.parent / "view" / "at-webserver" / "network_status.js",
    "uc4": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    "corejs": ATWB / "mt5700.js",
    "dialjs": ATWB.parent / "view" / "at-webserver" / "dial.js",
    "uc3": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    # ★ 频段「改不了」修复（2026-09-26）：同一批文件再挂键。
    #   modem_settings.js 已有 "msjs"（跑 device-control-contract）、
    #   parse.js 已有 "parsejs"/"parsejs2"/"parsejs3"（各跑自己的测试）——
    #   都跑错测试，所以另开：msjs2 / parsejs4（band 契约）、
    #   parsejs5（模块提取锚点）、test3（测试文件自身的提取正则）。
    "msjs2": ATWB.parent / "view" / "at-webserver" / "modem_settings.js",
    "parsejs4": ATWB / "parse.js",
    "parsejs5": ATWB / "parse.js",
    "test3": ROOT / "tests" / "parse-contract.test.js",
    # ★ 再挂五个键（2026-09-26 用户追问「全网扫频为什么不删干净」）：
    #   下线残留守卫在 tests/cellscan-removed-contract.test.js，它横跨
    #   前端事件名单 / 配置注释 / ucode 黑名单 / Rust 拦截 / i18n 五处。
    #   ★ 复用 rpcjs3 / uc4 / rsrust 都会**跑错测试**（它们分别固定跑
    #   retry-backoff、at-batch、single-source）→ 变异生效却没人判红（红线 16b）。
    "rpcjs4": ATWB / "rpc.js",
    "uc5": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    "rsrust2": ROOT / "src" / "rust" / "src" / "rpcserver.rs",
    "cfg1": ROOT / "root" / "etc" / "config" / "at-webserver",
    "po1": ROOT / "po" / "zh_Hans" / "luci-app-mt5700.po",
    # ★ 再挂四个键（2026-09-26「通道忙快速失败 + 读命令分类」）：
    #   · rpcjs5 / uc6 → busy-fastfail-contract（前端熔断行为 + ucode 提前收尾）
    #   · rpcjs6 / uc7 → at-read-classification-contract（读命令分类与手册一致）
    #   ★ 复用 rpcjs3/rpcjs4/uc4/uc5 都会**跑错测试**（红线 16b）。
    "rpcjs5": ATWB / "rpc.js",
    "rpcjs6": ATWB / "rpc.js",
    "uc6": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    "uc7": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    # ★ 再挂六个键（2026-09-27「换个浏览器看不到已发短信」）：
    #   已发记录的真源从 localStorage 搬到设备文件，横跨 sms_center / sms_settings /
    #   rpc.js / ucode / smsEncode（否决方案的残留）/ ACL 六处，守卫在自己的
    #   tests/sms-sent-log-contract.test.js 里。
    #   ★ 复用 smsjs / smssetjs / rpcjs / uc 都会**跑错测试**（红线 16b）。
    "smsjs2": ATWB.parent / "view" / "at-webserver" / "sms_center.js",
    "smssetjs3": ATWB.parent / "view" / "at-webserver" / "sms_settings.js",
    "rpcjs7": ATWB / "rpc.js",
    "uc8": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    "smsencjs": ATWB / "smsEncode.js",
    # ACL 是无扩展名之外的 .json：syntax_ok 对非 .js 一律放行，变异只改一个字符串。
    "acljson": ROOT / "root" / "usr" / "share" / "rpcd" / "acl.d" / "luci-app-mt5700.json",
    # ★ 再挂三个键（2026-09-28「统一保存 + 连接状态读取提速」）：
    #   · smssetjs4 → 短信设置页改用页面级 staged（去掉两个卡片级保存按钮）
    #   · msjs3     → 模组设置「高温时关闭 CA/MIMO」原本是空回调（改了存不下来）
    #   · nsjs2     → 网络状态慢档按「谁先用」拆两段预热
    #   ★ 复用 smssetjs / smssetjs2 / smssetjs3 / msjs / msjs2 / nsjs / warmjs
    #     都会**跑错测试**（红线 16b：变异生效却没人判红）。
    "smssetjs4": ATWB.parent / "view" / "at-webserver" / "sms_settings.js",
    "msjs3": ATWB.parent / "view" / "at-webserver" / "modem_settings.js",
    "nsjs2": ATWB.parent / "view" / "at-webserver" / "network_status.js",
    # ★ 再挂一个键（2026-09-29「NSA 下把 5G 显示成 4G」）：
    #   制式判定的守卫在自己的 sysmode-label-contract 里。
    #   ★ 复用 nsjs / nsjs2 会**跑错测试**（它们分别固定跑 warm-cache-contract 与
    #     ui-consistency-contract），变异生效却没人判红 —— 红线 16b。
    "nsjs3": ATWB.parent / "view" / "at-webserver" / "network_status.js",
    # ★ 再挂两个键（2026-10-16「厂商 beta 固件的电话功能移植」）：
    #   状态机令牌 / preflight 前置检查 / 记录 direction 三组守卫横跨
    #   htdocs 的 voice_call.js 与 ucode 的 mt5700.uc，都跑 tests/voice-call-contract。
    #   ★ 复用 uc / uc2..uc8 会**跑错测试**（各自固定跑 exitip / vowifi / bootstrap /
    #     at-batch / cellscan / busy-fastfail / at-read-classification / sms-sent-log），
    #     变异生效却没人判红 —— 红线 16b。
    "voicejs": ATWB.parent / "view" / "at-webserver" / "voice_call.js",
    # ★ 2026-10-22 UI 文案守卫：**同一文件另挂一个键**（红线 16b：复用 voicejs
    #   会让变异生效却没人判红 —— 那个键跑的是 voice-call-contract）。
    #   守的是「界面不许再贴取证报告」：那条能力提示一旦被写回 208 字的实测
    #   报告，用户就得在打电话的页面上读实验记录。
    "voicecopy": ATWB.parent / "view" / "at-webserver" / "voice_call.js",
    # ★ 2026-10-22 通话事件驱动改造：Rust 侧的 URC 分类是**另一层**
    #   ——is_exclusive_urc 管「要不要 emit」，is_passthrough_urc 管
    #   「emit 时带不带 broadcast」，两者只改一处就会出现「URC 被并进
    #   AT+CLCC 应答体、前端一条收不到、而所有本地测试全绿」。
    #   跨层断言写在 voice-call-contract 里，所以单独挂键，别复用 voicejs。
    "rustat": ROOT / "src" / "rust" / "src" / "atclient.rs",
    "uc9": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
}

# 每个目标改动后该跑哪个契约测试（esim.js / mt5700.css 都归 esim-contract）
TARGET_TEST = {
    "js": ROOT / "tests" / "euicc-download-contract.test.js",
    "test": ROOT / "tests" / "euicc-download-contract.test.js",
    "esimjs": ROOT / "tests" / "esim-contract.test.js",
    "esimcss": ROOT / "tests" / "esim-contract.test.js",
    "initd": ROOT / "tests" / "initd-contract.test.js",
    "compatjs": ROOT / "tests" / "compat-shim-contract.test.js",
    "js2": ROOT / "tests" / "esim-contract.test.js",
    "mt5700js": ROOT / "tests" / "esim-contract.test.js",
    "mt5700js2": ROOT / "tests" / "single-source-contract.test.js",
    "js3": ROOT / "tests" / "euicc-tag-whitelist-contract.test.js",
    "esimjs2": ROOT / "tests" / "silent-catch-contract.test.js",
    "js4": ROOT / "tests" / "euicc-contract.test.js",
    "shell": ROOT / "tests" / "shell-comment-style-contract.test.js",
    "msjs": ROOT / "tests" / "device-control-contract.test.js",
    "upgjs": ROOT / "tests" / "read-command-fresh-contract.test.js",
    "test2": ROOT / "tests" / "assert-signature-contract.test.js",
    "rpcjs": ROOT / "tests" / "single-source-contract.test.js",
    "parsejs": ROOT / "tests" / "single-source-contract.test.js",
    "termjs": ROOT / "tests" / "single-source-contract.test.js",
    "smssetjs": ROOT / "tests" / "single-source-contract.test.js",
    "rsrust": ROOT / "tests" / "single-source-contract.test.js",
    "uc": ROOT / "tests" / "exitip-contract.test.js",
    "parsejs2": ROOT / "tests" / "exitip-contract.test.js",
    "parsejs3": ROOT / "tests" / "sms-reachability-contract.test.js",
    "smssetjs2": ROOT / "tests" / "sms-reachability-contract.test.js",
    "uc2": ROOT / "tests" / "vowifi-contract.test.js",
    "ucsyn": ROOT / "tests" / "ucode-syntax-guard.test.js",
    "rpcjs2": ROOT / "tests" / "vowifi-contract.test.js",
    "vowifijs": ROOT / "tests" / "vowifi-contract.test.js",
    "svcjs": ROOT / "tests" / "service-status-unknown-contract.test.js",
    "undeffnjs": ROOT / "tests" / "undefined-fn-contract.test.js",
    "corejs": ROOT / "tests" / "bootstrap-contract.test.js",
    "dialjs": ROOT / "tests" / "bootstrap-contract.test.js",
    "uc3": ROOT / "tests" / "bootstrap-contract.test.js",
    "rpcjs3": ROOT / "tests" / "retry-backoff-contract.test.js",
    "warmjs": ROOT / "tests" / "warm-cache-contract.test.js",
    "nsjs": ROOT / "tests" / "warm-cache-contract.test.js",
    "uc4": ROOT / "tests" / "at-batch-contract.test.js",
    # ★ 再挂四个键（2026-09-26 频段「改不了」修复）：
    #   · "msjs" / "parsejs" 等旧键固定跑它们各自的测试，复用会**跑错测试**
    #     （变异生效却没人判红，比没守卫更危险 —— 红线 16b），所以另开键。
    #   · msjs2 / parsejs4 → syscfg-band-contract（全部频段取值 + 写后校验）
    #   · parsejs5 / test3 → module-extract-anchor（模块提取锚点）
    "msjs2": ROOT / "tests" / "syscfg-band-contract.test.js",
    "parsejs4": ROOT / "tests" / "syscfg-band-contract.test.js",
    "parsejs5": ROOT / "tests" / "module-extract-anchor.test.js",
    "test3": ROOT / "tests" / "module-extract-anchor.test.js",
    # ★ 全网扫频下线残留守卫（五个键都跑它）
    "rpcjs4": ROOT / "tests" / "cellscan-removed-contract.test.js",
    "uc5": ROOT / "tests" / "cellscan-removed-contract.test.js",
    "rsrust2": ROOT / "tests" / "cellscan-removed-contract.test.js",
    "cfg1": ROOT / "tests" / "cellscan-removed-contract.test.js",
    "po1": ROOT / "tests" / "cellscan-removed-contract.test.js",
    # ★ 忙态快速失败 + 读命令分类
    "rpcjs5": ROOT / "tests" / "busy-fastfail-contract.test.js",
    "uc6": ROOT / "tests" / "busy-fastfail-contract.test.js",
    "rpcjs6": ROOT / "tests" / "at-read-classification-contract.test.js",
    "uc7": ROOT / "tests" / "at-read-classification-contract.test.js",
    "smsjs": ROOT / "tests" / "sms-concurrency-contract.test.js",
    # ★ 已发记录真源（2026-09-27）：六个键都跑 sms-sent-log-contract
    "smsjs2": ROOT / "tests" / "sms-sent-log-contract.test.js",
    "smssetjs3": ROOT / "tests" / "sms-sent-log-contract.test.js",
    "rpcjs7": ROOT / "tests" / "sms-sent-log-contract.test.js",
    "uc8": ROOT / "tests" / "sms-sent-log-contract.test.js",
    "smsencjs": ROOT / "tests" / "sms-sent-log-contract.test.js",
    "acljson": ROOT / "tests" / "sms-sent-log-contract.test.js",
    # ★ UI 一致性与读取时序（2026-09-28）
    "smssetjs4": ROOT / "tests" / "ui-consistency-contract.test.js",
    "msjs3": ROOT / "tests" / "ui-consistency-contract.test.js",
    "nsjs2": ROOT / "tests" / "ui-consistency-contract.test.js",
    # ★ 制式判定（NSA 下 ^MONSC 只报 LTE 锚点）—— 别复用 nsjs / nsjs2。
    "nsjs3": ROOT / "tests" / "sysmode-label.test.js",
    # ★ 厂商 beta 固件电话功能移植（2026-10-16）：两个键都跑语音契约。
    "voicejs": ROOT / "tests" / "voice-call-contract.test.js",
    "voicecopy": ROOT / "tests" / "ui-copy-contract.test.js",
    "rustat": ROOT / "tests" / "voice-call-contract.test.js",
    "uc9": ROOT / "tests" / "voice-call-contract.test.js",
    # ★ rpc.js 的第三个键：**通话响应透传**（2026-10-16 真实故障）。
    #   既有 7 个 rpcjs* 键分别跑 single-source / vowifi / retry-offload /
    #   cellscan-removed / busy-fastfail / at-read-classification / sms-sent-log，
    #   复用任何一个都会「变异生效却没人判红」（红线 16b）。
    "rpcjs8": ROOT / "tests" / "voice-call-contract.test.js",
}

def _resolve_node() -> str:
    """定位 node 可执行文件。

    CI（ubuntu）上没有下面那条 Windows 绝对路径，写死会让整个脚本在 CI 上直接崩，
    而崩掉和"判红"从退出码上分不出来（见下面 syntax_ok 那条注释）。
    解析顺序：显式 NODE_BIN → 本机托管 node → PATH 里的 node。
    """
    env = os.environ.get("NODE_BIN")
    if env:
        return env
    # ★ 2026-09-28：这里原先还有一条写死的本机路径
    #   （r"C:\Users\<某开发者>\.workbuddy\binaries\node\versions\<版本>\node.exe"）。
    #   两个问题：① 把开发机的用户名与目录结构泄进了仓库；② 对别人和 CI 毫无意义 ——
    #   CI（ubuntu）上没有该路径，本来就只有下面 shutil.which 那条会命中。
    #   要指定 node 请用 NODE_BIN 环境变量（上面那条分支就是它）。
    found = shutil.which("node")
    if found:
        return found
    raise SystemExit("找不到 node：请设置 NODE_BIN 环境变量指向 node 可执行文件")


NODE = _resolve_node()

# ---------------------------------------------------------------------------
# 崩溃恢复：本工具会**就地改仓库源码**做变异。一旦上一轮没跑完（被 kill、
# 断电、CI 取消），变异的文件就留在工作区里。更糟的是下一轮启动时会把
# **残留的变异当成基线**（ORIG 从磁盘读）—— 于是「基线绿、还原逐字节一致」，
# 而仓库其实已经被改坏，只有那条被跳过的断言能发现。
#
# 2026-10-21 真踩过两次：`sms_center.js` 的 warning 被留成 success；
# `mt5700.js` 的 '重新尝试' 被留成 '再来一次'，之后连续两轮把所有测试都
# 报成"全部通过"，实际那两条断言一直在红。
#
# 做法：开跑前把每个目标的 sha256 写进 .workbuddy/tmp/verify-guards.bak/
# manifest.json，正常收尾时删掉。启动时发现清单还在 ⇒ 上一轮不正常，
# **报警并中止**（详见 _check_stale 里那段事故记录）。
# ---------------------------------------------------------------------------
BAK_DIR = ROOT / ".workbuddy" / "tmp" / "verify-guards.bak"
BAK_MANIFEST = BAK_DIR / "manifest.json"


def _save_backups():
    """只落一份哈希清单，**不复制文件内容**。

    ★ 2026-10-21 两处改动：
      ① 崩溃恢复不再自动还原（见 _check_stale），于是"文件内容备份"失去了
         唯一的用途 —— 还原走内存里的 ORIG，报告差异只需哈希。
      ② 原来要写 65 个 .bak，销账时一次删 65 个文件会撞上外层的批量删除
         保护（阈值 50），结果是 18 个删不掉、目录留着，下一轮又被误判成
         "上一轮没结束"。清单只有一个文件，销账不可能失败。
    """
    BAK_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {k: hashlib.sha256(blob).hexdigest() for k, blob in ORIG.items()}
    BAK_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                            encoding="utf-8")


def _clear_backups():
    for f in (BAK_MANIFEST,):
        try:
            f.unlink()
        except OSError:
            pass
    try:
        BAK_DIR.rmdir()
    except OSError:
        pass


def _check_stale():
    """上一轮留下的备份：只**报告**，绝不自动写回目标文件。

    ★ 这里曾经是"发现备份还在就按备份还原"，2026-10-21 因此真实丢过改动：
      上一轮跑测试被 SIGTERM 打断 → 备份留在盘上；此后又改了一批源码；
      下一次启动直接把一小时的工作覆盖成备份里的旧内容，而且**一声不响**，
      因为那些文件本来就"有改动"，看起来像正常状态。

      自动还原的根本问题：它拿"存在备份"推断"磁盘上是残留变异"，但同一个
      现象也完全可能是"用户在新一轮工作里改了这些文件"。这两种情况从磁盘
      状态上无法区分，所以只能交给人判断。

    现在的语义：备份还在 ⇒ 报警并中止。要么确认工作区没问题后手工删掉
    .workbuddy/tmp/verify-guards.bak，要么用 git 还原被变异的那几个文件。
    """
    if not BAK_DIR.is_dir():
        return
    try:
        manifest = json.loads(BAK_MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {}
    diff = []
    for k, path in TARGETS.items():
        want = manifest.get(k)
        if want is None:
            continue
        if hashlib.sha256(path.read_bytes()).hexdigest() != want:
            diff.append(path.name)
    print("")
    print("=" * 72)
    print("⛔ 发现上一轮 verify-guards 留下的备份目录：")
    print("   " + str(BAK_DIR))
    print("   这说明上一轮没有正常收尾（被强杀 / 崩溃），工作区可能停在被变异的中间态。")
    if diff:
        print("   与备份内容不一致的文件（很可能就是被变异的）：")
        for n in sorted(diff):
            print("     · " + n)
    else:
        print("   磁盘内容与备份逐字节一致 —— 上一轮没来得及变异，属于干净状态。")
    print("")
    print("   本工具**不会**自动还原（那会把新一轮的改动覆盖成旧内容）。请自行确认：")
    print("     git diff <上面列出的文件>     # 是不是残留变异")
    print("     git checkout -- <文件>        # 确认后还原")
    print("   确认工作区干净后，删掉该目录再重跑：")
    print("     rm -rf .workbuddy/tmp/verify-guards.bak")
    print("=" * 72)
    return 2


_rc = _check_stale()
if _rc:
    raise SystemExit(_rc)

ORIG = {k: v.read_bytes() for k, v in TARGETS.items()}

# (名字, 目标, 旧片段, 新片段, 期望被点名的断言关键词)
MUTATIONS = [
    # ★ 2026-09-28 新增：init.d 的三条。它此前有守卫（initd-contract.test.js）
    #   但从没被变异验证过 —— 无法排除那些断言是恒绿的。
    #   锚点唯一性已核（`start "$@"` 1 次；`ipv4-address|ipv6-address` 1 次；
    #   带制表符缩进的 `\tensure_enabled` 1 次）。
    (
        # 用 ubus call service delete 代替标准 start：删掉的是**整个服务对象**，
        # 紧接着 procd_open_instance 往一个正在被删除的对象上注册 —— 收尾时新实例
        # 一并被清掉。2026-09-21 实测：reload 返回 0、日志打满「配置重新加载完成」，
        # 但进程列表里一个后端都没有。同时破坏「不得 delete」与「必须走 start」两条。
        "init.d：reload 用 ubus call service delete 代替标准 start（旧实例与新实例一起没了）",
        "initd",
        '\tstart "$@"\n',
        '\tubus call service delete at-webserver\n',
        "reload_service 不得调用 ubus call service delete",
    ),
    (
        # 就绪判据退化：改成匹配关键字本身，于是空数组 `[]` 也算「已就绪」，
        # 接口还没拿到地址就报成功（up=true 造成的假成功那一类）。
        "init.d：就绪判据不再要求「数组里有元素」（空数组也判就绪）",
        "initd",
        "ipv4-address|ipv6-address",
        "ipv4Address|ipv6Address",
        "就绪判据匹配「数组里有元素」",
    ),
    (
        # 把 ensure_enabled 的调用点从「enabled 检查之后」挪走（这里直接删掉），
        # 于是禁用状态下 start 也会把 S99 自启链接补回来：界面显示已启用、
        # 开机又因 enabled=0 退出，两个结论互相矛盾。
        "init.d：去掉 ensure_enabled 调用（禁用状态下也会补回自启链接）",
        "initd",
        "\tensure_enabled\n",
        "\t:\n",
        "ensure_enabled 在 start_service 里被调用",
    ),
    # ★ 2026-09-28 新增：compat.js（LuCI core 兼容垫片）的三条。
    #   它是全局兜底，失效 = 页面能打开但功能全不可用。
    #   锚点唯一性已核（每条在 compat.js 里只出现 1 次）。
    (
        # 去掉 %% 转义分支：'100%%' 会被当成 %s 吃掉参数，格式串错位。
        "compat：%% 转义分支被删（格式串错位）",
        "compatjs",
        "if (m === '%%') return '%';",
        "if (false) return '%';",
        "%% 转义为字面 %",
    ),
    (
        # 去掉"已有实现就不覆盖"：会覆盖上游 luci 的 format 实现。
        "compat：丢失「已有上游实现就不覆盖」（垫片变成劫持）",
        "compatjs",
        "if (typeof String.prototype.format === 'function') return false;",
        "if (false) return false;",
        "已有上游实现时 install() 返回 false",
    ),
    (
        # 让 install() 不执行：垫片形同不存在，页面全废。
        "compat：模块求值不再安装（垫片形同不存在）",
        "compatjs",
        "api.installed = api.install();",
        "api.installed = true;",
        "模块求值即安装",
    ),
    (
        # ★ 锚点唯一性已核：service.js 里 `if (state.binUnknown) {` 只出现 1 次。
        #   去掉它 → 读失败重新落到「未安装」并劝用户重装
        #   （红线 23：把读不出来伪装成确定的故障结论 + 给出错误的修复建议）。
        "读失败时退回「未安装」并劝人重装（status unknown 分支被删）",
        "svcjs",
        "if (state.binUnknown) {",
        "if (false) {",
        "读失败时不下「未安装」的结论",
    ),
    (
        # ★ 锚点唯一性已核：service.js 里 `if (state.svcUnknown) {` 只出现 1 次。
        "读失败时退回「未注册」并把用户引去查 init 脚本（svcUnknown 分支被删）",
        "svcjs",
        "if (state.svcUnknown) {",
        "if (false) {",
        "serviceList 读失败时不许把人引去查 init.d",
    ),
    (
        # ★ 锚点唯一性已核：service.js 里这行 catch 只出现 1 次。
        "rpc 读失败不再留痕（catch 静默返回空壳，读不到与真的没有再次不可区分）",
        "svcjs",
        "statBinary(BINARY).catch(function () { statFailed = true; return null; })",
        "statBinary(BINARY).catch(function () { return null; })",
        "statBinary 的 catch 会置 statFailed",
    ),
    (
        "超时后立刻向卡敲门（2026-09-20 那个把整包打死的旧 bug）",
        "js",
        "(cut > 0 ? em.slice(0, cut) : em)",
        "(handshakeKnock(send, ch, api.getResponseApdu(ch, 0)), "
        "cut > 0 ? em.slice(0, cut) : em)",
        "不许出现任何卡侧 APDU",
    ),
    (
        "接回函数在拿到迟到回包之前就去敲卡",
        "js",
        "\t\tvar ps = [];",
        "\t\tvar _probe = api.getResponseApdu(ch, 0);\n"
        "\t\tsendAndCollect(send, ch, _probe, 0, '');\n"
        "\t\tvar ps = [];",
        "不发任何卡侧 APDU",
    ),
    (
        # ★ 回归锚点唯一性已核：euicc.js 里 `if (sw.charAt(0) === '9') {` 只出现 1 次
        #   （变异工具改的是全文件第一次出现，同形多处会变到别处 → 误判守卫恒绿）。
        "去掉 SW 9xxx 分支（9100 掉回兜底被当失败，三处放行判据变死代码）",
        "js4",
        "\t\tif (sw.charAt(0) === '9') {",
        "\t\tif (false) {",
        "91xx 判「成功待 refresh」",
    ),
    (
        # ★ 锚点唯一性已核：mt5700.uc 里 `let bind = safeBindIp(getStr(req.args, 'bind'));`
        #   只出现 1 次（就在 exitip 方法里）—— 变异工具改的是全文件第一次出现。
        "exitip 绕过 bind 校验直接拼进命令行（命令注入面）",
        "uc",
        "let bind = safeBindIp(getStr(req.args, 'bind'));",
        "let bind = getStr(req.args, 'bind');",
        "拼 --interface 之前先过 safeBindIp",
    ),
    (
        # ★ 锚点唯一性已核：parse.js 里 `if (!s) return null;` 只出现 1 次（parseExitIpBody 内）。
        "出口 IP 取不到时返回 0.0.0.0 占位（红线 23：把读不出来伪装成有值）",
        "parsejs2",
        "if (!s) return null;",
        "if (!s) return '0.0.0.0';",
        "空串 → null（不是 0.0.0.0）",
    ),
    (
        # ★ 锚点唯一性已核：sms_settings.js 里 `preferCs && !v.cs.registered`
        #   只出现 1 次（renderReachability 的判据表达式，缩进 3 个 tab）。
        "短信可达性退化成单条件（只看承载域，不交叉 CS 域实测 → 回落 GSM/UMTS 时误报）",
        "smssetjs2",
        "\t\t\telse if (v.cgsms.preferCs && !v.cs.registered) {",
        "\t\t\telse if (v.cgsms.preferCs) {",
        "两个条件在同一个 && 表达式里",
    ),
    (
        # ★ 锚点唯一性已核：parse.js 里 `registered: r.stat === 1 || r.stat === 5`
        #   只出现 1 次（parseCsDomain 内）。
        "CS 域判定丢掉 stat=5（漫游态被当未注册 → 漫游时误报短信不可达）",
        "parsejs3",
        "registered: r.stat === 1 || r.stat === 5",
        "registered: r.stat === 1",
        "stat=5（已注册漫游）→ registered",
    ),
    (
        # ★★ 锚点唯一性已核：mt5700.uc 里 `} else if (posCtl.state != 'available') {`
        #   只出现 1 次（epdgFacts 的总判定处）。
        #   这一条是本功能最容易被写歪的地方：本机 DNS 坏了也会被判成「运营商没发布」。
        "ePDG 丢掉阳性对照门禁（本机 DNS 故障被算到运营商头上）",
        "uc2",
        "\t} else if (posCtl.state != 'available') {",
        "\t} else if (false) {",
        "阳性对照查不到时，verdict 必须退回 unknown",
    ),
    (
        # ★ 锚点唯一性已核：`{ cmd: 'AT+CIMI', fresh: true }` 只出现 1 次。
        #   AT+CIMI 在 STATIC_READS 里缓存 300s，不 fresh 就会拿上一张卡的 IMSI
        #   去拼上一张卡的 ePDG 域名（红线 24 的同型事故）。
        "ePDG 读 IMSI 不 fresh（换卡后 300 秒内拼出上一张卡的 ePDG 域名）",
        "uc2",
        "rpcCall('at', { cmd: 'AT+CIMI', fresh: true })",
        "rpcCall('at', { cmd: 'AT+CIMI' })",
        "AT+CIMI 走 fresh",
    ),
    (
        # ★ 锚点唯一性已核：EPDG_PREFIX 前缀校验只出现 1 次（safeEpdgFqdn 内）。
        "ePDG 域名不校验前缀就拼进命令行（命令注入面）",
        "uc2",
        "\tif (substr(s, 0, length(EPDG_PREFIX)) != EPDG_PREFIX) {",
        "\tif (false) {",
        "前缀不对但长度合规",
    ),
    (
        # ★ 锚点唯一性已核：EPDG_SUFFIX 后缀校验只出现 1 次（safeEpdgFqdn 内）。
        "ePDG 域名只校验前缀不校验后缀（.attacker.example.com 之类能混进命令行）",
        "uc2",
        "\tif (substr(s, length(s) - length(EPDG_SUFFIX)) != EPDG_SUFFIX) {",
        "\tif (false) {",
        "后缀不对但长度合规",
    ),
    (
        # ★ 锚点唯一性已核：`let d = dohLookup(fqdn, EPDG_ECS);` 全仓 1 次（epdgProbe 内）。
        #   真机（2026-09-24）：系统 DNS 对 *.3gppnetwork.org 有通配污染，只看一条路
        #   会把「污染」当「有」、把「本机 DNS 抽风」当「运营商没发布」。
        "ePDG 不再做 DoH 回退（单条链路的结论可能正好说反）",
        "uc2",
        "\tlet d = dohLookup(fqdn, EPDG_ECS);",
        "\tlet d = null;",
        "系统 DNS 没给出 available 时，要换 DoH 再问一次",
    ),
    (
        # ★ 锚点唯一性已核：`url = url + '&edns_client_subnet=' + ecs;` 全仓 1 次。
        #   ePDG 的权威 DNS 常只对归属国的解析器返回地址（参考 VoCat 的地理回退），
        #   不带 ECS 等于白问一趟。
        "ePDG 的 DoH 不带 EDNS Client Subnet（归属国权威 DNS 不给答案）",
        "uc2",
        "\t\turl = url + '&edns_client_subnet=' + ecs;",
        "\t\turl = url;",
        "DoH 要带归属国的 EDNS Client Subnet",
    ),
    (
        # ★ 锚点唯一性已核：`if (r.doh.state == 'unknown') {` 全仓 1 次。
        #   换链路是为了**纠偏**，不是替换：DoH 自己也说不清时不许覆盖系统 DNS 的结论。
        "ePDG 的 DoH 无条件覆盖系统 DNS 结论（换链路从纠偏变成替换）",
        "uc2",
        "\tif (r.doh.state == 'unknown') {",
        "\tif (false) {",
        "只有 DoH 给出**更确定**的结论才覆盖系统 DNS",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次。
        #   真机：mnc000 明确 NXDOMAIN、mnc00 返回 127.0.0.1（与必然不存在的 mnc999 同值）。
        #   去掉 canonical 优先后，「运营商明确没发布」会被污染的变体搅成「无法判定」。
        "ePDG 丢掉 canonical 优先（被污染的变体把「没发布」搅成「无法判定」）",
        "uc2",
        "\t\tif (canon != null && canon.state == 'not_published') {",
        "\t\tif (false) {",
        "权威域名说 NXDOMAIN 时，被污染的变体不许把结论搅成 unknown",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次。
        #   覆盖后前端只能看到「最终结论」，看不到「两条路各说了什么」——
        #   而那个不一致正是判污染的根据。
        "ePDG 覆盖系统 DNS 结论时不留原值（页面看不到两条路的对比）",
        "uc2",
        "\tr.sysState = r.state;",
        "\tr.sysState = null;",
        "系统 DNS 的原结论要单独留一份",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次（epdgFacts 内）。
        #   猜成固定 2 位：换一张 3 位 MNC 的卡就会拼出必然 NXDOMAIN 的域名，
        #   把「我拼错了」报成「运营商没发布」。
        "ePDG 的 MNC 长度改成猜（不从卡上 EF_AD 读）",
        "uc2",
        "\tlet mncLen = readMncLength();",
        "\tlet mncLen = 2;",
        "MNC 长度先问卡（EF_AD）",
    ),
    (
        # ★★ 真机事故（2026-09-24）：在页面里发 AT+CCHO 开逻辑通道，通道占上后
        #   AT+CCHC 关不掉（一律 SIM failure），只能重启模组才恢复。
        #   这里变异成「加回一条 CCHO」，反向断言必须把它判红。
        "ePDG/VoWiFi 探测里又出现 AT+CCHO（逻辑通道占上后不可回收）",
        "uc2",
        "\tlet aka = akaEvidence(aidInfo);",
        "\tlet aka = akaEvidence(aidInfo);\n\trpcCall('at', { cmd: 'AT+CCHO=\"A0000000871002\"' });",
        # ★ 断言名随方法改名（epdg → vowifi）同步改名，关键词必须跟着改，
        #   否则变异生效却匹配不到断言 → 显示「被放过」（红线 16b）。
        "VoWiFi 评估全程不许发 AT+CCHO",
    ),
    (
        # ★★ 真机真踩过这一条（2026-09-24）：去掉这道门禁后，busybox nslookup 开头的
        #   Server/Address 两行（223.5.5.5:53）会被当成解析结果 —— 连必然不存在的
        #   mnc999 都「解析到了地址」，总判定恒为 available，最关键的结论被反过来说。
        # ★ 锚点唯一性已核：下面这段多行锚点在全仓只出现 1 次（nsPickAddrs 内）。
        # ★★ 为什么必须**两道一起拆**（2026-09-24 第 3 次修正）：
        #     只拆 `!seenName` 门禁 → `v != dns + ':53'` 兜底接住，判不出来；
        #     只拆 `v != dns + ':53'` → seenName 门禁接住，也判不出来（放过过一次）。
        #     NXDOMAIN 的输出里只有 Server 段那一行 Address，任一防线单独存在都足以
        #     把它挡掉。两道互为冗余是好事，但**变异必须模拟「两道都失效」**，
        #     否则守卫会显示「能检出」而其实根本没验证到这个失效模式。
        "nslookup 输出不过滤 Server 段（DNS 服务器自己被当成结果 → 任何域名都判「解析到了」）",
        "uc2",
        "\t\tif (!seenName) {\n\t\t\tcontinue;\n\t\t}\n"
        "\t\tif (index(line, 'Address') == 0) {\n"
        "\t\t\tlet k = index(line, ':');\n"
        "\t\t\tif (k >= 0) {\n"
        "\t\t\t\tlet v = trim(substr(line, k + 1));\n"
        "\t\t\t\tif (v != '' && v != dns && v != dns + ':53') {\n"
        "\t\t\t\t\taddrs[length(addrs)] = v;\n"
        "\t\t\t\t}\n"
        "\t\t\t}\n"
        "\t\t}",
        "\t\tif (index(line, 'Address') == 0) {\n"
        "\t\t\tlet k = index(line, ':');\n"
        "\t\t\tif (k >= 0) {\n"
        "\t\t\t\tlet v = trim(substr(line, k + 1));\n"
        "\t\t\t\tif (v != '') {\n"
        "\t\t\t\t\taddrs[length(addrs)] = v;\n"
        "\t\t\t\t}\n"
        "\t\t\t}\n"
        "\t\t}",
        "NXDOMAIN 输出（真机格式）一个地址都不产生",
    ),
    # ---------- 2026-09-24 VoWiFi 五道门：EF_DIR / IMPI / AKA 实测能力 ----------
    (
        # ★★ 真机（2026-09-24）：AT+CRSM 读 EF_DIR **不带 path** 一律回
        #   "+CME ERROR: UNKNOWN"，整条身份链直接断在第一步。
        # ★ 锚点唯一性已核：这条命令串全仓只出现 1 次（efDirApps 内）。
        "EF_DIR 读记录不带 path（真机实测：一律 +CME ERROR: UNKNOWN，身份链断在第一步）",
        "uc2",
        "'AT+CRSM=178,' + EF_DIR_ID + ',' + rec + ',4,0,,\"' + EF_DIR_PATH + '\"'",
        "'AT+CRSM=178,' + EF_DIR_ID + ',' + rec + ',4,0,'",
        # ★ 关键词要指向**真的会红的那条断言**：改的是使用处，判红的是
        #   「EF_DIR 用 AT+CRSM=178 读记录」；常量的那条断言不会红（常量没动）。
        "EF_DIR 用 AT+CRSM=178 读记录",
    ),
    (
        # ★ 锚点唯一性已核：`if (sw != '9000') {` 全仓 1 次（efDirApps 内）。
        #   异常状态字（6A88/6A82/6981…）下必须**停**并留痕；删掉这段会一路读到 6 条上限，
        #   把错误应答的内容当 EF_DIR 记录塞进 apps，且不留下任何「读不到」的痕迹。
        # ★ 关键词随断言改名同步（现在是「其它非 9000 状态字要留下 err」）。
        "EF_DIR 不再看异常状态字（一路读到上限，空记录被当应用且不留痕）",
        "uc2",
        "\t\tif (sw != '9000') {\n\t\t\terr = 'ef_dir_sw_' + sw;\n\t\t\tbreak;\n\t\t}",
        "",
        "留下 err",
    ),
    (
        # ★ 锚点唯一性已核：`return decHex2(sw1) + decHex2(sw2);` 全仓 1 次。
        #   CRSM 的 sw 是**十进制**回的（106,131），不转十六进制就判不出 6A83。
        "crsmSw 不再把十进制 sw 转成十六进制（6A83 判不出来）",
        "uc2",
        "return decHex2(sw1) + decHex2(sw2);",
        "return sw1 + sw2;",
        "106,131 解成 6A83",
    ),
    (
        # ★★ 锚点唯一性已核：`if (k == '02') {\n\t\t\treturn 'USIM';\n\t\t}` 全仓 1 次
        #   （appKind 内；uiccAkaAid 里那段变量名是 kind，写法不同）。
        #   真机本卡 EF_DIR 里只有一条 USIM 记录（rec2 起就是 6A83）——
        #   一旦把别的应用也判成 USIM，「卡上没有 ISIM」这类关键事实就没了。
        "appKind 把非 USIM 的 AID 也判成 USIM（应用类型全失真）",
        "uc2",
        "\t\tif (k == '02') {\n\t\t\treturn 'USIM';\n\t\t}",
        "\t\treturn 'USIM';",
        "appKind 认 ISIM",
    ),
    (
        # ★ 锚点唯一性已核：mnc3Of 的补零分支全仓 1 次。
        #   TS 23.003 的 IMS 域名里 MNC 恒三位；不补就会拼出 mnc00.mcc460 这种错域名。
        "MNC 不补零（TS 23.003 的 IMS 域名里 MNC 恒三位）",
        "uc2",
        "\tif (length(mnc) == 3) {\n\t\treturn mnc;\n\t}\n\treturn '0' + mnc;",
        "\treturn mnc;",
        "两位 MNC 补成三位",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次（deriveImpi 内）。
        "IMPI 派生式少拼 ims. 段（EAP-AKA 拿到一个运营商不认的身份）",
        "uc2",
        "return imsi + '@ims.mnc' + mnc3 + '.mcc' + mcc + '.3gppnetwork.org';",
        "return imsi + '@mnc' + mnc3 + '.mcc' + mcc + '.3gppnetwork.org';",
        "拼出真机 IMPI",
    ),
    (
        # ★★★ 本轮最重要的一条。真机实测：AT+CSIM 上限 42 个十六进制字符，
        #   而 USIM AUTHENTICATE 需要 76 —— **发不出去**。
        #   拍成 true 等于凭空宣称「能实测 AKA」，是红线 14 那类空壳能力。
        # ★ 锚点唯一性已核：全仓 1 次。
        "AKA 实测能力拍成「支持」（抹掉 42<76 这条真机事实，宣称能发 AUTHENTICATE）",
        "uc2",
        "return AKA_AUTH_HEX <= CSIM_MAX_HEX;",
        "return true;",
        "本模组不支持 AUTHENTICATE 实测",
    ),
    (
        # ★ 同上：把常量拍大也能让 supported 变 true，是同一条事实的另一条逃逸路径。
        "CSIM 上限常量拍大（AUTHENTICATE 被当成能发出去）",
        "uc2",
        "const CSIM_MAX_HEX = 42;",
        "const CSIM_MAX_HEX = 512;",
        "CSIM 上限常量取真机实测值 42",
    ),
    (
        # ★ 锚点唯一性已核：`ok: (impi != ''),` 全仓 1 次（vowifiFacts 的 identity 门）。
        #   VoWiFi 用的是 IMPI 不是 IMSI —— 省掉这道门等于把「身份都没有」算作通过。
        "identity 门恒绿（不判 IMPI 有没有就放行）",
        "uc2",
        "\t\t\tok: (impi != ''),",
        "\t\t\tok: true,",
        "identity 门独立存在",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次。
        #   阻断清单的价值在于**逐条点名**：只给一个「不可用」，用户不知道该换卡还是该等运营商。
        "阻断清单丢掉 no_usim_isim（卡上没 USIM/ISIM 这条关键事实不再点名）",
        "uc2",
        "\t\tblockers[length(blockers)] = 'no_usim_isim';",
        "\t\tblockers[length(blockers)] = '';",
        "逐条点名",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次。
        #   ePDG 无法判定（两条链路都没结论）时必须说 unknown，不许说「不通」。
        "ePDG 无法判定时总判定仍落 blocked（把「测不出来」说成「不通」）",
        "uc2",
        "\t} else if (ep.verdict == 'unknown') {\n\t\tverdict = 'unknown';",
        "\t} else if (false) {\n\t\tverdict = 'unknown';",
        "ePDG 无法判定时总判定不许说",
    ),
    (
        # ★★ 真机形态 sim✓ identity✓ aka✓ epdg✗ ims✓ 下，「最后一个 ok」会算出 ims_ready，
        #   界面于是同时显示「走到：IMS 已注册」和「VoWiFi 不成立」——自相矛盾。
        # ★ 锚点唯一性已核：`if (!stages[i].ok) {` 全仓 1 次（vowifiFacts 的 phase 循环）。
        "phase 退回「取最后一个 ok 的门」（卡在第 3 道门却报 ims_ready，界面自相矛盾）",
        "uc2",
        "\t\tif (!stages[i].ok) {\n\t\t\tbreak;\n\t\t}\n\t\tphase = PHASE_BY_STAGE[i];",
        "\t\tif (stages[i].ok) {\n\t\t\tphase = PHASE_BY_STAGE[i];\n\t\t}",
        "phase 是「连续通过的前缀」",
    ),
    (
        # ★ 红线 23：AT 通道挂了 = 读不到，不是「卡上没装应用」。
        #   去掉这两处 err，调用方会拿到空 apps 并把一次失败说成「没有 ISIM」。
        # ★ 锚点唯一性已核：`err = 'ef_dir_read_failed';` 全仓 2 次，锚点含上下文只命中第 1 处。
        "EF_DIR 读失败不留 err（一次 AT 失败被当成「卡上没有 ISIM」）",
        "uc2",
        "\t\tif (r == null || !r.success || r.data == null) {\n\t\t\terr = 'ef_dir_read_failed';\n\t\t\tbreak;\n\t\t}",
        "\t\tif (r == null || !r.success || r.data == null) {\n\t\t\tbreak;\n\t\t}",
        "都要留 err",
    ),
    (
        # ★ 6A83 是「记录不存在＝读完了」，是**卡的客观事实**。
        #   删掉这个分支后它会掉进 `sw != '9000'`，于是「读完了」被记成「读不到」。
        "EF_DIR 丢掉 6A83 分支（「读完了」被当成「读不到」）",
        "uc2",
        "\t\tif (sw == '6A83') {\n\t\t\tbreak;",
        "\t\tif (false) {\n\t\t\tbreak;",
        "6A83 就停",
    ),
    (
        # ★ 与上一条相反：给 6A83 也置 err，同样是把「没装应用」说成「读不到」。
        "EF_DIR 给 6A83 也置 err（「卡上没装应用」被说成「读不到」）",
        "uc2",
        "\t\tif (sw == '6A83') {\n\t\t\tbreak;",
        "\t\tif (sw == '6A83') {\n\t\t\terr = 'ef_dir_sw_' + sw;\n\t\t\tbreak;",
        "6A83 分支只 break 不置 err",
    ),
    (
        # ★ 返回体少了 err，调用方拿不到「读不到」这个信息，前端只能显示「没有」。
        "efDirApps 退化成只回 apps（读不到的信息在调用链上丢掉）",
        "uc2",
        "\treturn { apps: apps, err: err };",
        "\treturn apps;",
        "efDirApps 返回 { apps, err }",
    ),
    (
        # 前端：dirError 分支一去掉，「读不到」就又变成「没有 ISIM」。
        "前端不再区分 dirError（读不到又被显示成「没有 ISIM」）",
        "vowifijs",
        "\t\t\t\tif (d.identity.dirError) {",
        "\t\t\t\tif (false) {",
        "读不到 EF_DIR",
    ),
    (
        # ★★ 开关的方向写反：点「开」实际下发的是关 IMS 的命令。
        #   真机后果＝IMS 短信与 VoLTE 语音一起断掉，而界面还显示「已开启」。
        "开关方向写反（点「开」下发的是 AT^IMSSWITCH=0,0,0，直接断掉 IMS）",
        "uc2",
        "return 'AT^IMSSWITCH=' + (enable ? '1,0,0' : '0,0,0');",
        "return 'AT^IMSSWITCH=' + (enable ? '0,0,0' : '1,0,0');",
        "开 = AT^IMSSWITCH=1,0,0",
    ),
    (
        # ★★ 缺 enable 时默认成 0 = 默认「关 IMS」。
        #   任何漏传参数的调用方（含未来的新页面）都会静默断掉 IMS，是有后果的动作。
        "开关缺 enable 时默认成 0（漏传参数＝静默关掉 IMS）",
        "uc2",
        "\t\t\t\tif (v == null) {\n\t\t\t\t\treturn { success: false, error: '缺少 enable 参数（0=关，1=开）' };\n\t\t\t\t}",
        "\t\t\t\tif (v == null) {\n\t\t\t\t\tv = 0;\n\t\t\t\t}",
        "缺 enable 必须报错",
    ),
    (
        # ★★ ePDG 是运营商侧的网元，本机改不了。把它也算进「不能开启」的门禁，
        #   这个开关在本机（中国移动卡）就永远是死的 —— 又回到「空壳开关」。
        "把 epdg_not_published 也算进开启门禁（开关在本机永远是死的）",
        "uc2",
        "if (b == 'sim_unread' || b == 'mnc_ambiguous' || b == 'no_impi' || b == 'no_usim_isim') {",
        "if (b == 'sim_unread' || b == 'mnc_ambiguous' || b == 'no_impi' || b == 'no_usim_isim'"
        " || b == 'epdg_not_published') {",
        "ePDG 没发布不挡开启",
    ),
    (
        # ★ 开启方向的门禁一去掉，本地三门没过也会去下发一条注定失败的命令，
        #   而用户拿到的是一句「下发失败」，不是「为什么开不了」。
        "开启不再过本地门禁（先下发再失败，用户拿不到原因）",
        "uc2",
        "\tif (enable) {\n\t\tlet local = vowifiLocalBlockers(f);",
        "\tif (false) {\n\t\tlet local = vowifiLocalBlockers(f);",
        "只有开启方向设门禁",
    ),
    (
        # ★ ^IMSSWITCH? 不在 rpc.js 的读缓存档 → 落到默认 2500ms 缓存，
        #   不 fresh 会捞到下发前的旧值，把「已生效」误判成「没生效」（R04 同一套约定）。
        "开关回读不再 fresh（读到下发前的旧值，制造假故障）",
        "uc2",
        "{ cmd: 'AT^IMSSWITCH?', fresh: true }",
        "{ cmd: 'AT^IMSSWITCH?' }",
        "回读 ^IMSSWITCH? 必须 fresh",
    ),
    (
        # ★ 开关状态与「VoWiFi 成不成立」是两件事，都要回。
        #   不重跑的话界面只会显示「已开启」，看不到还差 ePDG 这一门。
        "下发后不再重跑五门（开了开关却不说还差什么；B01 后带 20s 预算）",
        "uc2",
        "\tlet after = vowifiFacts(time() + 20);",
        "\tlet after = f;",
        "下发后重跑五门",
    ),
    (
        # ★ 参数表多一个口子，前端就能把别的东西送进 ubus。
        "rpc 给 vowifi_set 多开一个参数（开关的口子被开大）",
        "rpcjs2",
        "\tmethod: 'vowifi_set',\n\tparams: ['enable'],",
        "\tmethod: 'vowifi_set',\n\tparams: ['enable', 'cmd'],",
        "参数只有 enable",
    ),
    (
        # ★ 关 IMS 会断掉 IMS 短信与 VoLTE 语音 —— 必须确认，且取消要把开关拨回去。
        "关 IMS 不再确认（误点一下就断掉短信与 VoLTE）",
        "vowifijs",
        "\t\t\tif (!on) {\n\t\t\t\tMt5700.confirm('关闭会下发 AT^IMSSWITCH=0,0,0，"
        "IMS 短信与 VoLTE 语音会一起断掉。确定关闭？',\n\t\t\t\t\tfunction () { doVowifiSet(0); }, '确定关闭',"
        "\n\t\t\t\t\tfunction () { renderVowifiSwitch(); });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tdoVowifiSet(1);",
        "\t\t\tdoVowifiSet(on ? 1 : 0);",
        "关 IMS 要先确认",
    ),
    (
        # ★★ 同上实测的后端侧：`args: { enable: 0 }` 是整型，字符串/布尔进不了 ucode。
        #   给 enable 补字符串分支＝写一段永远跑不到的代码，还让人误以为类型不敏感。
        "后端又给 enable 补字符串分支（rpcd 挡在前面，这段永远跑不到）",
        "uc2",
        "\t\t\t\tlet enable = -1;\n\t\t\t\tif (v === 1) {",
        "\t\t\t\tlet enable = -1;\n\t\t\t\tif (v === 1 || v === '1') {",
        "后端只认数字 0/1",
    ),
    (
        # ★★ 真机实测（2026-09-24）：`args: { enable: 0 }` 声明整型，传字符串 '1'
        #   被 rpcd 以 code=2（Invalid argument）整包拒掉 —— 点了开关完全没反应，
        #   连 ucode 里的报错都走不到，界面只会显示兜底的「设置失败」。
        "前端给开关传字符串 '1'（被 rpcd 以 Invalid argument 拒，点了没反应）",
        "rpcjs2",
        "\treturn withTimeout(rpcVowifiSet(enable ? 1 : 0), 60000, 'VoWiFi 开关超时')",
        "\treturn withTimeout(rpcVowifiSet(enable ? '1' : '0'), 60000, 'VoWiFi 开关超时')",
        "前端传的是数字 0/1",
    ),
    (
        # ★ 被拒绝时只报「设置失败」，用户不知道该换卡还是该等运营商 ——
        #   正是本轮要治的「点了没反应 / 只给一句失败」。
        "被拒绝时前端只报「设置失败」（不给原因）",
        "vowifijs",
        "\t\t\t\tt.setMsg = '无法开启：' + blockersToText(r.blockers);",
        "\t\t\t\tt.setMsg = '设置失败';",
        "无法开启",
    ),
    (
        # 前端：不发不出去的命令，但**要说清为什么发不出去**，否则用户以为是没实现。
        "前端不再展示 AUTHENTICATE 实测能力（用户看不出为什么没实测）",
        "vowifijs",
        "\t\t\tirows.push(['AUTHENTICATE 实测',",
        "\t\t\tirows.push(['AKA 实测',",
        "前端展示 AUTHENTICATE 实测能力",
    ),
    (
        # 前端：阻断清单少一项，界面就会显示 undefined（测试逐 key 断言覆盖）。
        "前端 BLOCKER_TEXT 少了 epdg_not_published（界面显示 undefined）",
        "vowifijs",
        "\t\t\tepdg_not_published: '运营商未在公网发布 ePDG（这台设备改不了，只能换一张其运营商发布了 ePDG 的卡）',\n",
        "",
        "覆盖了后端阻断项 epdg_not_published",
    ),
    (
        # ★★ 这个变异守的是**守卫本身**：`epdgResultNode` 曾被调用 3 次却从未定义，
        #   语法检查与全部契约测试都放行，只有真机渲染才会炸（而真机前端渲染在本环境
        #   做不了）。现在由 tests/undefined-fn-contract.test.js 静态兜住 —— 这条变异
        #   就是证明它**真能检出**，不是又一个恒绿的摆设。
        "又出现「调用了未定义的函数」（语法合法，只有渲染时才炸）",
        "undeffnjs",
        "\t\trenderVowifi();   /* 出初始态（未评估时不发任何请求） */",
        "\t\trenderVowifi();\n\t\tvar _x = epdgResultNodeGhost({ state: 'x' });",
        "没有「调用了未定义的函数」",
    ),
    (
        # ★ 一旦开放 params，这个登录用户能用的口子就变成「借路由器做任意 DNS 探测」。
        "rpc 声明开放 params（域名由后端拼的口子被打开）",
        "rpcjs2",
        "\tmethod: 'vowifi',\n\tparams: [],",
        "\tmethod: 'vowifi',\n\tparams: ['fqdn'],",
        "rpc 声明不带 params",
    ),
    (
        "去掉时间窗（退化成只靠轮数上限）",
        "js",
        "if (attempt > maxPolls || Date.now() >= opts.deadline) {",
        "if (attempt > maxPolls) {",
        "时间窗过期后立刻抛错",
    ),
    (
        "末块不再给长窗（和普通块一样）",
        "js",
        "var LATE_FINAL_WINDOW_MS = 90000;",
        "var LATE_FINAL_WINDOW_MS = 1000;",
        "时间窗是显式的毫秒常量",
    ),
    (
        "日志不再说清「不碰卡」",
        "js",
        "改为只发普通 AT 等模组吐回包（不碰卡）",
        "正在恢复",
        "改为只发普通 AT 等回包",
    ),
    (
        "接回结果不标出来（和正常回执长得一样）",
        "js",
        "r.recovered ? '（接回模组迟到的应答）' : ''",
        "''",
        "接回结果在日志里标出来",
    ),
    (
        "轮询漏传 fresh（真机上被 rpc.js 只读缓存吃掉，永远接不回来）",
        "js",
        "send('AT', { fresh: true })",
        "send('AT')",
        "缓存",
    ),
    (
        "往 asyncTests 里 push 裸函数（Promise.all 会放行 → 检查恒绿）",
        "test",
        "/* ---------- 汇总 ---------- */",
        "asyncTests.push(function () { ok('永远不会执行', false); });\n\n"
        "/* ---------- 汇总 ---------- */",
        "每一项都是 Promise",
    ),
    # ---------- 2026-09-20 eSIM 页 UI 重排的形态守卫 ----------
    (
        "EID 退回成 metric 大数字格（32 位标识符被大字号折行、无法逐位核对）",
        "esimjs",
        "E('div', { 'class': 'mt5700-esim-idvalue' }, p.eid",
        "E('div', { 'class': 'mt5700-mono' }, p.eid",
        "EID 用等宽标识块",
    ),
    (
        "EID 块在 CSS 里丢掉等宽字体（只留类名，界面悄悄退回比例字体）",
        "esimcss",
        ".mt5700-esim-idvalue {\n  margin-top: 2px;\n  font-family: var(--mt5700-font-mono);",
        ".mt5700-esim-idvalue {\n  margin-top: 2px;\n  font-family: var(--mt5700-font-sans);",
        "在 CSS 里确实是等宽",
    ),
    (
        "ICCID 丢掉行卡等宽类（长卡号变回比例字体）",
        "esimjs",
        "E('span', { 'class': 'mt5700-esim-row-iccid' }",
        "E('span', { 'class': 'mt5700-mono' }",
        "ICCID 用行卡等宽类展示",
    ),
    (
        "昵称顶替官方名（同一张卡在不同地方叫法不一致）",
        "esimjs",
        "var name = p.profileName || p.spName || ''",
        "var name = p.profileName || p.spName || p.nickname",
        "昵称不顶替官方名",
    ),
    (
        "通路徽章不再由 p.transport 决定（固定报「正常」，下载失败时误导）",
        "esimjs",
        "p.transport === 'cgla' ? '下载通路正常' : '下载通路受限'",
        "'下载通路正常'",
        "通路徽章由 p.transport 决定",
    ),
    (
        "行卡「已启用」色条类名被改掉（CSS 侧应当场判红）",
        "esimcss",
        ".mt5700-esim-row.is-on::before",
        ".mt5700-esim-row.is-enabled::before",
        "行卡与「已启用」色条",
    ),
    # ---------- 2026-09-20 卡级阻断（基本通道全 6985）的状态分流守卫 ----------
    (
        "卡级阻断不再单独报（SW 混回 EUICC_OP_FAILED，页面又变成一句「读取失败」）",
        "js2",
        "if (api.isCardBlockedSw(e.sw, e.ch)) return { state: 'blocked', sw: e.sw };",
        "if (false) return { state: 'blocked', sw: e.sw };",
        "基本通道 6985 → state=blocked",
    ),
    (
        "异常不再带 SW / 通道号（判定失去依据，阻断态判不出来）",
        "js2",
        "se.sw = a.sw;\n\t\t\tse.ch = ch;",
        "se.sw = '';\n\t\t\tse.ch = null;",
        "基本通道 6985 → state=blocked",
    ),
    (
        "阻断判据丢掉「基本通道」这一半（逻辑通道 6985 也误报成阻断）",
        "js2",
        "\t\treturn sw === '6985' && ch === 0;",
        "\t\treturn sw === '6985';",
        "阻断判据必须限定基本通道",
    ),
    (
        "阻断判据丢掉 6999 这一半（本机实际命中的那条路径 → 又退回「读取失败」）",
        "js2",
        "\t\tif (sw === '6999') return true;",
        "\t\tif (false) return true;",
        "CGLA 通路 6999",
    ),
    (
        "把被推翻的「M2M eUICC / 厂家锁卡」结论写回 6985 文案",
        "js2",
        "text: '卡片拒绝了该操作（6985：使用条件不满足）',",
        "text: '这张是 M2M eUICC（SGP.02）或被厂家锁卡',",
        "不再把 6985 的成因写成 M2M",
    ),
    (
        "阻断面板不再被状态分流调用（新增状态直接掉进兜底分支）",
        "esimjs",
        "p.state === 'blocked') renderBlocked(p);",
        "false) renderBlocked(p);",
        "renderBlocked 且被状态分流调用",
    ),
    (
        "阻断面板文案丢掉下一步动作（只说失败，用户不知道要重启模组）",
        "esimjs",
        "反复操作不会改变结果",
        "请稍后重新进入本页",
        "给出下一步",
    ),
    # ---------- 2026-09-20 阻断面板的文案 / 按钮形态（本轮真踩过的两个坑） ----------
    (
        "阻断面板正文写进 Markdown 星号（errorState 只渲染纯文本 → 界面原样显示星号）",
        "esimjs",
        "卡片对基本通道上的每一条命令都回 ",
        "卡片对基本通道上的**所有**命令都回 ",
        "不含 Markdown 星号",
    ),
    (
        "阻断面板按钮退回默认「重新尝试」（正文说反复操作无意义，按钮自相矛盾）",
        "esimjs",
        "function () { render(); },\n\t\t\t\t'重新探测'));",
        "function () { render(); },\n\t\t\t\t'重新尝试'));",
        "按钮文案是「重新探测」",
    ),
    (
        "errorState 的默认按钮文案被改（全站共用组件，一改所有页面跟着变）",
        "mt5700js",
        "api.primaryButton(retryText || '重新尝试', onRetry)",
        "api.primaryButton(retryText || '再来一次', onRetry)",
        "默认仍是「重新尝试」",
    ),
    (
        "阻断面板按 6985 一句写死（6999 路径下等于陈述没发生过的事实）",
        "esimjs",
        "var why = (sw === '6999')",
        "var why = (false)",
        "按 SW 分文案",
    ),
    # ---------- 2026-09-20 全面审计：操作码按位映射 / error 态人话 / 资源与并发 ----------
    (
        "操作码按位映射被废（真实安装回执 81=80 又显示成「操作 128」）",
        "js2",
        "if (opNum & PMO_BITS[bi][0]) opNames.push(PMO_BITS[bi][1]);",
        "if (false) opNames.push(PMO_BITS[bi][1]);",
        "操作码 80",
    ),
    (
        "probe 的 error 态丢掉 SW 矩阵人话（页面又只剩一句「卡片返回了失败状态字」）",
        "js2",
        "sw: e.sw || '', swText: e.swText || '', swHint: e.swHint || ''",
        "sw: '', swText: '', swHint: ''",
        "X1 error.swText",
    ),
    (
        "renderError 丢掉 detail 优先级（swText 到了页面却不展示）",
        "esimjs",
        "'读取 eSIM 信息失败：' + (detail || hint || '请稍后重试。'),",
        "'读取 eSIM 信息失败：' + (hint || '请稍后重试。'),",
        "X2 renderError",
    ),
    (
        "首屏列表 catch 不再识别卡级阻断（阻断时显示裸状态码）",
        "esimjs",
        "走与首屏一致的 blocked 面板（含下一步动作）。 */\n\t\t\t\tif (Euicc.isCardBlockedSw(e && e.sw, e && e.ch)) { renderBlocked({ sw: e.sw }); return; }",
        "走与首屏一致的 blocked 面板（含下一步动作）。 */\n\t\t\t\tif (false) { renderBlocked({ sw: e.sw }); return; }",
        "X3 两处列表读取 catch",
    ),
    (
        "下载日志行数不再封顶（上千行常驻内存）",
        "esimjs",
        "if (lines.length > 160) lines.splice(0, lines.length - 160);",
        "/* no cap */",
        "X4 下载日志行数封顶",
    ),
    (
        "showPendingReceipts 读取期间不置 busy（可与写操作并发开第二条 ISD-R 通道）",
        "esimjs",
        "卡只有 1~3 条，6A81）。 */\n\t\t\tbusy = true;\n\t\t\tEuicc.listNotifications(send).then(function (r) {",
        "卡只有 1~3 条，6A81）。 */\n\t\t\tEuicc.listNotifications(send).then(function (r) {",
        "X5 showPendingReceipts",
    ),
    # ↓ 以下三条守的是「守卫本身是否有效」—— 它们对应的契约测试都是新加的，
    #   新守卫最容易犯的错就是恒绿（看起来在防，其实永远通过）。
    (
        "shell 里写 C 风格注释（会被 glob 展开成根目录文件列表并当命令执行）",
        "shell",
        "#!/bin/sh\n",
        "#!/bin/sh\n/* 兼容老模组的分支 */\n",
        "会被 glob 展开",
    ),
    (
        "向卡发送白名单外的 tag（盲目探测 tag 曾把模组 AT 通道锁死，只能整机断电）",
        "js3",
        "var payload = 'BF2D'",
        "var payload = 'BF99'",
        "白名单外",
    ),
    (
        "扫码逐帧解码的 catch 不再交代为何吞错（又变成「读不出来」=「没有」）",
        "esimjs2",
        "\t" * 9 + "/* 单帧解码失败不打断：继续下一帧，直到识别成功、用户取消或超时。\n"
        + "\t" * 9 + "   这里没有用户可见反馈是刻意的 —— 扫码过程中每一帧都可能失败，\n"
        + "\t" * 9 + "   逐帧提示只会让画面一直闪 */\n",
        "",
        "每个无参数 catch 都有交代",
    ),
    (
        "暂存项 led 的 run 不再 reject（界面会报「已应用」而模组其实没改）",
        "msjs",
        "return send('AT^LEDSWITCH=' + (checked ? 1 : 0)).then(function (res) {\n"
        "\t\t\t\t\tif (!res.success) throw new Error('模组返回失败');\n",
        "return send('AT^LEDSWITCH=' + (checked ? 1 : 0)).then(function (res) {\n",
        "暂存项 led",
    ),
    (
        "finishByIdle 的版本查询去掉 fresh（FOTA 版本复核会读到旧版本）",
        "upgjs",
        "\t\t\tAtWs.client.sendCommand('AT+CGMR', { fresh: true })",
        "\t\t\tAtWs.client.sendCommand('AT+CGMR')",
        "finishByIdle",
    ),
    (
        "删掉 deleteProfile 的二次 busy 拦截（确认框停留期可重入）",
        "esimjs",
        "\t\t\t\t\tif (busy) { Mt5700.error('有操作正在进行'); return; }\n"
        "\t\t\t\t\t/* P17：iccidRaw 为空不下发，避免只弹一句「操作失败」 */",
        "\t\t\t\t\t/* P17：iccidRaw 为空不下发，避免只弹一句「操作失败」 */",
        # ★ expect 必须是测试里**当前的**措辞（2026-09-24 校准）：出口 IP 探测按钮那次
        #   把拦截数从 5 提到 6，测试断言同步改成「恰好 6 处」，这里没跟着改，
        #   于是变异明明被判红（rc=1）却因关键词失配报成「变异被放过」——假警报。
        #   ★ 改拦截数量时必须同步：esim-contract 的断言文案 + 本 expect，两处。
        "恰好 6 处",
    ),
    (
        "把断言写成定义相反的顺序（字符串落进条件位 → 恒为真）",
        "test2",
        "\tok(!!m, '暂存项 ' + key + ' 走 ctrlStaged.set（不逐项立即写模组）');",
        "\tok('暂存项 ' + key + ' 走 ctrlStaged.set（不逐项立即写模组）', !!m);",
        "调用顺序都与自身定义一致",
    ),
    # ---- 以下 8 条守的是 tests/single-source-contract.test.js（「同一件事只有一个家」）----
    (
        "rpc.js 又自己算 -110 量程的信号百分比（两页面显示两个百分比）",
        "rpcjs",
        "\tvar pct = Parse.signalPercent(rsrp);",
        "\tvar pct = Math.round(100 * (rsrp - (-110)) / ((-70) - (-110)));",
        "rpc.js 又开始自己算百分比了",
    ),
    (
        "mt5700.js 又自己算 2*(rsrp+120)（与 parse.js 的公式分家）",
        "mt5700js2",
        "\t\treturn Parse.signalPercent(rsrp);",
        "\t\treturn Math.max(0, Math.min(100, Math.round(2 * (Number(rsrp) + 120))));",
        "mt5700.js 又开始自己算百分比了",
    ),
    (
        "终端页不再查危险 AT（AT+CFUN=0 会直接把 5G 断掉）",
        "termjs",
        "var danger = Parse.atDangerHint(command);",
        "var danger = null;",
        "终端又没有危险指令提示了",
    ),
    (
        "短信设置页不再查危险 AT（不经确认就清空全部短信）",
        "smssetjs",
        "var hint = Parse.atDangerHint(s[0]);",
        "var hint = null;",
        "短信开关又会不经确认就发",
    ),
    (
        "parseRejInfo 缺字段又归 0（「没上报」显示成「CS 域」）",
        "parsejs",
        "var num = function (v) { return numOrNull(unquote(v)); };",
        "var num = function (v) { var n = Number(unquote(v)); return isFinite(n) ? n : 0; };",
        "缺字段又归 0 了",
    ),
    (
        "parse.js 里再抄一份 numOrNull（两份契约迟早不一致）",
        "parsejs",
        "\t/* numOrNull / hexOrNull 已上移到文件顶部的「公共取值工具」，全文件共用一份 */",
        "\tvar numOrNull = function (v) { return Number(v); };",
        "恰好定义一处",
    ),
    (
        "EventBus::since 去掉 budget 参数（500 条事件一次全回撑爆 8192 单帧）",
        "rsrust",
        "fn since(&self, since: u64, budget: usize) -> (u64, Vec<serde_json::Value>) {",
        "fn since(&self, since: u64) -> (u64, Vec<serde_json::Value>) {",
        "since 又没有字节预算了",
    ),
    (
        "events 调用点不再传帧预算",
        "rsrust",
        "self.hub.bus.since(since, EVENT_FRAME_BUDGET)",
        "self.hub.bus.since(since, 0)",
        "events 调用点传入 EVENT_FRAME_BUDGET",
    ),
    (
        # ★★ 2026-09-25 全量审计：这段代码在 10 个页面里各抄过一遍，而它依赖的
        #   REQUIRE_AUTH_KEY **永远不会被抛出**（RPC 模式 connect() 不 reject）。
        #   守卫要防的是「有人照抄老页面把它带回来」，所以变异＝注入死分支。
        "某个页面里加回 REQUIRE_AUTH_KEY 弹窗分支（该错误 RPC 模式下无人抛出）",
        "dialjs",
        "\t\tMt5700.connectThen(function () {\n\t\t\tloadAll();\n\t\t});",
        "\t\tAtWs.client.connect().catch(function (err) {\n"
        "\t\t\tif (err && err.message === 'REQUIRE_AUTH_KEY') {\n"
        "\t\t\t\tUi.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (v) { });\n"
        "\t\t\t\treturn;\n\t\t\t}\n"
        "\t\t}).then(function () {\n\t\t\tloadAll();\n\t\t});",
        "REQUIRE_AUTH_KEY",
    ),
    (
        # ★ 不等连接成功就跑回调＝没连上就发，必然失败。这条守的是「先等」的语义。
        "connectThen 不再等连接成功就跑回调",
        "corejs",
        "\t\treturn AtWs.client.connect().then(function () {\n"
        "\t\t\tif (typeof onReady === 'function') onReady();\n"
        "\t\t});",
        "\t\tif (typeof onReady === 'function') onReady();\n"
        "\t\treturn AtWs.client.connect();",
        "connectThen",
    ),
    (
        # ★ 后端只回四个字「认证失败」，页面上几十个入口会同时复读，
        #   没有这句翻译用户完全不知道是密钥错了、该去哪儿改。
        "ucode 不再把 -32001 翻成带处置指引的文案（认证失败又只剩四个字）",
        "uc3",
        "\t\t\tif (resp.error.code == RPC_ERR_AUTH_FAILED) {\n"
        "\t\t\t\tmsg = '认证失败：UCI 的 websocket_auth_key 与后端不一致，请到「服务配置」核对';\n"
        "\t\t\t}\n",
        "",
        "-32001",
    ),
    # ---------------- 2026-09-25 性能专项 ----------------
    (
        # ★ 锚点唯一性已核：这段三元表达式在 rpc.js 里只出现 1 次（就在 sendCommand 里）。
        #   去掉降级后，注定了要失败的命令会回到「三次重试 + 600ms 退避」，
        #   这正是本机每轮慢档被拖长好几秒的原因。
        "失败命令取消自适应降级（回到固定三次重试）",
        "rpcjs3",
        "\t\t\t: (self._currentFailStreak(command) >= RETRY_DOWNGRADE_STREAK\n"
        "\t\t\t\t? 1\n"
        "\t\t\t\t: RETRY_ATTEMPTS_DEFAULT));",
        "\t\t\t: RETRY_ATTEMPTS_DEFAULT);",
        "连续两轮失败之后降级为只发一次",
    ),
    (
        # ★ 锚点唯一性已核：`self._cachePut(it.cmd, { success: true, data: it.data });`
        #   在 rpc.js 里只出现在 warmCache 里。
        #   预热不写缓存 = 整轮还是一条一条HttpRequest，实测收益归零。
        "预热取回的结果不写进读缓存（提速彻底失效）",
        "warmjs",
        "\t\t\t\tself._cachePut(it.cmd, { success: true, data: it.data });",
        "\t\t\t\t/* 变异：不写缓存 */",
        # ★ 关键词必须写**真的会报出来的那条断言名**：
        #   warmCache 的返回值只是「成功应答有几条」，光判返回值的话，
        #   「压根不写缓存」这种变异会不红 —— 真正会红的是「同一轮还要再下发」。
        "预热之后同一轮的查询不再打串口",
    ),
    (
        "慢档不再以预热开头（实现了却不用）",
        "nsjs",
        "\t\t\tvar chain = AtWs.client.warmCache(SLOW_WARM);",
        "\t\t\tvar chain = Promise.resolve();",
        "慢档以预热开头",
    ),
    (
        # ★ 多行锚点：mt5700.uc 里 `return false;` 不止一处，必须带上它前面那整个
        #   BARE_READS 循环，才能锁到 batchReadable 的最后一句。
        "batchReadable 改成兜底放行（at_batch 从此能下发写命令）",
        "uc4",
        "\tfor (i = 0; i < length(BARE_READS); i++) {\n"
        "\t\tif (BARE_READS[i] == cmd) { return true; }\n"
        "\t}\n"
        "\treturn false;",
        "\tfor (i = 0; i < length(BARE_READS); i++) {\n"
        "\t\tif (BARE_READS[i] == cmd) { return true; }\n"
        "\t}\n"
        "\treturn true;",
        "batchReadable 的兜底是拒绝",
    ),

    # ================= 频段「改不了」（2026-09-26） =================

    (
        # ★ 锚点唯一性已核：modem_settings.js 里 `var rows = Parse.sysCfgApplyCheck(`
        #   只出现 1 次。改成空数组 → 保存流程只看 res.success 就报成功，
        #   「回 OK 但没写进 NV」会再次被报成成功 —— 正是本次故障的表象。
        "保存流程不做写后校验（AT 回 OK 就报成功）",
        "msjs2",
        "\t\t\t\t\t\tvar rows = Parse.sysCfgApplyCheck(wanted, got);",
        "\t\t\t\t\t\tvar rows = [];",
        "写后校验",
    ),
    (
        # ★ 锚点唯一性已核：`{ value: Parse.BAND_ALL_MASK, label: '全部频段' }` 只 1 处。
        "「全部频段」改回手册 ANY magic value（本机固件回 OK 但不写入）",
        "msjs2",
        "\t\t\t{ value: Parse.BAND_ALL_MASK, label: '全部频段' }",
        "\t\t\t{ value: '3FFFFFFF', label: '全部频段' }",
        # ★ 关键词要写**真会报出来的那条断言名**：这条变异动的是页面选项，
        #   parse.js 里的 BAND_ALL_MASK 没变，所以红的不是 A2（"不是 ANY magic
        #   value"），而是 F2（"选项引用 Parse.BAND_ALL_MASK"）与 F3（反向断言）。
        "引用 Parse.BAND_ALL_MASK",
    ),
    (
        # ★ 锚点唯一性已核：parse.js 里 `hexMaskSubset(wv, av)` 只出现 1 次。
        #   去掉子集判定 → LTE ALL 被能力掩码裁剪会被误报成 rejected（把正常说成失败）。
        "写后校验不再按位图子集判定（正常裁剪被误报成未生效）",
        "parsejs4",
        "\t\t\t\telse if (hexMaskSubset(wv, av)) row.state = 'clipped';",
        "\t\t\t\telse if (false) row.state = 'clipped';",
        "被裁剪判定为 clipped",
    ),
    (
        # ★ 锚点唯一性已核：`api.BAND_ALL_MASK = hexFromBits(` 只出现 1 次。
        "BAND_ALL_MASK 改成手写字面量 ANY（位叠加失效，复发）",
        "parsejs4",
        "\tapi.BAND_ALL_MASK = hexFromBits(BAND_BITS.map(function (b) { return b[0]; })).toUpperCase();",
        "\tapi.BAND_ALL_MASK = '3FFFFFFF';",
        "ANY magic value 3FFFFFFF",
    ),
    (
        # ★ 锚点唯一性已核：parse.js 里顶格 `})();` 只有模块收尾这一处（内部 IIFE 都带缩进）。
        #   给它加一层缩进 → 锚定提取正则再也匹配不到，23 处测试一起崩。
        "模块收尾不再是顶格（锚定提取正则失配）",
        "parsejs5",
        "\n})();\n",
        "\n\t})();\n",
        "能取到完整函数体",
    ),
    (
        # ★ 锚点唯一性已核：parse-contract.test.js 里这条提取正则只出现 1 次。
        "测试里的提取正则退回未加锚的脆弱版（内部 IIFE 会截断它）",
        "test3",
        "/var Parse = \\((function[\\s\\S]*?\\n\\})\\)\\(\\);/",
        "/var Parse = \\((function[\\s\\S]*?)\\)\\(\\);/",
        "未加锚的模块提取正则",
    ),
    # ---------- 全网扫频下线残留（2026-09-26 用户追问「为什么不删干净」） ----------
    (
        # ★ 锚点唯一性已核：事件名单这一行在 rpc.js 里只出现 1 次。
        #   把已无消费方的 cellscan 放回名单 → 守卫必须判红。
        "把没有消费方的 cellscan 放回前端事件名单",
        "rpcjs4",
        "\tif (['incoming_call', 'new_sms', 'pdcp_data', 'urc_data'].indexOf(ev.type) >= 0) {",
        "\tif (['incoming_call', 'new_sms', 'pdcp_data', 'cellscan', 'urc_data'].indexOf(ev.type) >= 0) {",
        "不再认 cellscan",
    ),
    (
        # ★ 锚点唯一性已核：cellscan_timeout 那一行在配置文件里只出现 1 次。
        #   把注释退回「一次 ^CELLSCAN 全网扫频允许运行的秒数」的旧口径
        #   （把已下线功能描述成活的）→ 守卫必须判红。
        "配置里把已下线的扫频描述成活功能（旧注释口径回流）",
        "cfg1",
        "\toption cellscan_timeout '180'           # 仅用于终端误发 AT^CELLSCAN 时的超时上限（秒，下限 10）",
        "\toption cellscan_timeout '180'           # 一次 ^CELLSCAN 全网扫频允许运行的秒数（下限 10）",
        "旧的错误口径",
    ),
    (
        # ★ 锚点唯一性已核：NEVER_CACHE 定义在 mt5700.uc 里只有 1 处。
        #   只拆掉「三处耦合」中的 ucode 这一条 → 守卫必须判红。
        "只拆掉 ucode 永不缓存名单里的 AT^CELLSCAN（三处耦合失衡）",
        "uc5",
        "const NEVER_CACHE = ['AT^CELLSCAN', ",
        "const NEVER_CACHE = [",
        "三者必须同步",
    ),
    (
        # ★ 锚点唯一性已核：这一句 starts_with 在 rpcserver.rs 里只有 1 处
        #   （ABORT / STATE 用的是 eq_ignore_ascii_case）。
        #   拆掉 Rust 的拦截 → 守卫必须判红（并在人看的时候提示：
        #   真删拦截会让终端直发变成无上限扫频）。
        "拆掉 Rust 侧 AT^CELLSCAN 拦截（三处耦合失衡）",
        "rsrust2",
        'starts_with("AT^CELLSCAN")',
        'starts_with("AT^NOPE")',
        "三者必须同步",
    ),
    (
        # ★ 锚点唯一性已核：msgid "网络状态" 在 po 里只出现 1 次。
        #   把已清除的孤儿翻译放回 → 守卫必须判红。
        "把已清除的「全网扫频」孤儿翻译放回 po",
        "po1",
        'msgid "网络状态"',
        'msgid "全网扫频"\nmsgstr "全网扫频"\n\nmsgid "网络状态"',
        "po 里不再有",
    ),
    # ---------- 通道忙快速失败 + 读命令分类（2026-09-26） ----------
    (
        # ★ 锚点唯一性已核：出队时那次检查用的是 `self._busyUntil`，
        #   入队时那次用 `this._busyUntil`、warmCache 也用 `this._busyUntil`。
        #   去掉它 → 同一 tick 并发排队的一整轮命令又会各自去撞 8 秒
        #   （浏览器 A/B 实测：忙态下发从 12 次回到 30 次）。
        "去掉出队时的熔断检查（同 tick 排队的一整轮又会撞满 8 秒）",
        "rpcjs5",
        "\t\tif (readOnly && !opt.fresh && Date.now() < self._busyUntil) {",
        "\t\tif (false) {",
        "同一 tick",
    ),
    (
        # ★ 锚点唯一性已核：`skipped++;` 在 mt5700.uc 里只出现 1 次。
        #   去掉它 → 撞到忙的收尾计数丢失（静态结构检查会报红）。
        "ucode 撞到忙不再逐步收尾（skipped 计数丢失）",
        "uc6",
        "\t\t\t\t\t\t\tskipped++;",
        "",
        "提前收尾",
    ),
    (
        # ★ 锚点唯一性已核：'AT+CGPADDR' 在 NON_QUESTION_READS 里只出现 1 次。
        "把 AT+CGPADDR 从只读名单里删掉（手册 7.8 明确是查询）",
        "rpcjs6",
        "'AT+CGPADDR', 'AT+CNUM', 'AT+CGEQOSRDP', 'AT+CGMI'",
        "'AT+CNUM', 'AT+CGEQOSRDP', 'AT+CGMI'",
        "AT+CGPADDR",
    ),
    (
        # ★ 锚点唯一性已核：ucode BARE_READS 里的这一行只出现 1 次。
        #   只删 ucode 那一侧 → 前后端对「什么算只读」不一致
        #   （前端塞进 batch、后端一律拒）。
        "只删 ucode BARE_READS 里的 AT+CGPADDR（前后端不一致）",
        "uc7",
        "\t'AT^DSFLOWQRY', 'AT^MONNC', 'AT^MONSC', 'AT^MONSSC',\n\t'AT+CGPADDR', 'AT+CNUM', 'AT+CGEQOSRDP'",
        "\t'AT^DSFLOWQRY', 'AT^MONNC', 'AT^MONSC', 'AT^MONSSC',\n\t'AT+CNUM', 'AT+CGEQOSRDP'",
        "前后端一致",
    ),
    # ★★ 2026-09-27「VoWiFi 评估改成不自动进行」的五条守卫（跑 vowifi-contract）：
    #   前两条专门验证**负向断言**有没有牙齿 ——「不许出现 X」默认就是绿的，
    #   是最容易写成恒绿的一类，必须把旧写法真的加回去看它红不红。
    (
        # ★ 锚点唯一性已核：`Mt5700.connectThen(function () {` 在 modem_settings.js 只 1 次。
        "把「进页面自动跑五道门」加回去（用户口径：改成不自动进行）",
        "vowifijs",
        "\t\tMt5700.connectThen(function () {\n\t\t\tloadAll();\n\t\t});",
        "\t\tMt5700.connectThen(function () {\n\t\t\tloadAll();\n\t\t}).then(function () { runVowifi(); });",
        "进页面不再自动跑五道门",
    ),
    (
        # ★ 锚点唯一性已核：刷新按钮那段 `Mt5700.primaryButton('刷新'` 只 1 次。
        "把「刷新连带跑评估」加回去",
        "vowifijs",
        "\t\t\tMt5700.primaryButton('刷新', function () {\n\t\t\t\tloadAll();\n\t\t\t})",
        "\t\t\tMt5700.primaryButton('刷新', function () {\n\t\t\t\tloadAll().then(function () { runVowifi(); });\n\t\t\t})",
        "刷新按钮不再连带跑五道门",
    ),
    (
        # ★ 锚点唯一性已核：那条只读只有一处。
        "开关状态那条读不吃读缓存（会显示成下发前的旧值）",
        "vowifijs",
        "sendCommand('AT^IMSSWITCH?', { fresh: true })",
        "sendCommand('AT^IMSSWITCH?')",
        "页面加载只读一条开关状态",
    ),
    (
        # ★ 锚点唯一性已核：loadAll 链里 `.then(fetchImsSwitch)` 只 1 次。
        "把开关状态那条读从 loadAll 链里摘掉（点「刷新」不再刷新开关）",
        "vowifijs",
        "\t\t\t\t.then(fetchImsSwitch)\n",
        "",
        "那条读挂在 loadAll 链里",
    ),
    (
        # ★ 锚点唯一性已核：`var known = (t.imssw` 只 1 次。
        "开关状态改回读评估结果（不评估就没数据 → 显示成「关」）",
        "vowifijs",
        "\t\t\tvar known = (t.imssw === '1' || t.imssw === '0');\n"
        "\t\t\tvowifiSwitch.checked = (t.imssw === '1');",
        "\t\t\tvar known = true;\n"
        "\t\t\tvowifiSwitch.checked = !!(t.data && t.data.ims && String(t.data.ims.imsswitch) === '1');",
        "开关状态取实测值",
    ),
    (
        # ★ 锚点唯一性已核：disabled 那一行只 1 次。
        "读不到开关状态时仍然画成「关」（红线 23：读不到 ≠ 确实是 0）",
        "vowifijs",
        "vowifiSwitch.disabled = !known || !!(t.busy || t.setBusy);",
        "vowifiSwitch.disabled = !!(t.busy || t.setBusy);",
        "读不到开关状态时不许显示成",
    ),

    # ============ 短信中心：收件箱归并 + 未读标记（2026-09-27 重复显示） ============
    # ★ 锚点唯一性已逐条核对：8 条锚点各出现 1 次。
    (
        "拿掉归并（列表一份 + 推送一份各自留一份 → 同一条短信显示两次）",
        "smsjs",
        "\t\t\tlist = mergeSmsDuplicates(mergeConcatenated(list));",
        "\t\t\tlist = mergeConcatenated(list);",
        "buildContacts 第一步就归并",
    ),
    (
        "归并时间窗放大到无限（内容相同的两条真短信被吞掉一条）",
        "smsjs",
        "Math.abs(ta - tb) <= SAME_SMS_WINDOW_MS",
        "true",
        "无槽位时按时间窗区分",
    ),
    (
        "取消「槽位优先」只看内容（删掉旧短信后槽位被复用 → 张冠李戴）",
        "smsjs",
        "\t\t\tif (ia.length && ib.length) {",
        "\t\t\tif (false) {",
        "槽位不同时，内容相同且只隔 3 秒也是两条",
    ),
    (
        # ★ 这条要整段换：只改「选谁留下」会被下面的「把更全的字段补过来」救回来
        #   （补的那行会把 partIndices 一起搬过来），于是变异看着生效、测试却照样绿 ——
        #   互为冗余的两道防线必须一次全拆（红线 16c）。
        "归并时留下后来的那条（推送那份没有槽位，删不掉：提示删除成功、模组上还在）",
        "smsjs",
        "\t\t\tvar keep = partIndicesOf(cur).length ? cur : (partIndicesOf(next).length ? next : cur);\n"
        "\t\t\tvar drop = (keep === cur) ? next : cur;\n"
        "\t\t\tvar merged = copySms(keep);\n"
        "\t\t\tif (!merged.time && drop.time) merged.time = drop.time;\n"
        "\t\t\tif (drop.unread) merged.unread = true;\n"
        "\t\t\tif (!partIndicesOf(merged).length && partIndicesOf(drop).length) merged.partIndices = partIndicesOf(drop);\n"
        "\t\t\treturn merged;",
        "\t\t\treturn next;",
        "不论先后都留能删的那条",
    ),
    (
        "归并时丢掉未读标记（新短信来了却不显示未读）",
        "smsjs",
        "\t\t\tif (drop.unread) merged.unread = true;",
        "",
        "归并不得丢掉未读",
    ),
    (
        "推送时间不再换算（同一条短信两个来源的时间长得不一样，看着像两条）",
        "smsjs",
        "\t\t\tvar arrivedAt = d.time ? Parse.formatPDUTime(Parse.parseMessageTime(d.time)) : nowTimeStr();",
        "\t\t\tvar arrivedAt = d.time || nowTimeStr();",
        "推送时间换算成与列表同一种写法",
    ),
    (
        "正在看的会话也标未读（当面落下来的短信还要冒红点）",
        "smsjs",
        "\t\t\t\tif (!watching) markUnread(msg.number);",
        "\t\t\t\tmarkUnread(msg.number);",
        "正在看的会话不再标未读",
    ),
    (
        "会话里不再逐条标未读（只剩左侧一个总数，看不出哪几条是新的）",
        "smsjs",
        "\t\t\t\tvar meta = E('div', { 'class': 'mt5700-sms-item-preview' }, m.time || '');\n"
        "\t\t\t\tif (m.unread) {\n"
        "\t\t\t\t\tmeta.appendChild(document.createTextNode(' '));\n"
        "\t\t\t\t\tmeta.appendChild(Mt5700.badge('未读', 'danger'));\n"
        "\t\t\t\t}\n"
        "\t\t\t\tbubble.appendChild(meta);",
        "\t\t\t\tbubble.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, m.time || ''));",
        "会话里逐条标出未读",
    ),

    # ============ 短信中心：已发记录真源搬到设备（2026-09-27 换浏览器看不到） ============
    (   # 锚点唯一性已核：下面 10 条各出现 1 次（ACL 那条靠多行锚点取到 write 段）。
        "refresh 不并设备记录（换浏览器依旧看不到已发短信，就是这个 BUG 本身）",
        "smsjs2",
        "buildContacts(parsed.concat(sent));",
        "buildContacts(parsed);",
        "refresh() 把设备记录并入列表",
    ),
    (
        "发送后只列不写（短信发出去了，记录还是没落设备）",
        "smsjs2",
        "AtWs.smsLog('add', JSON.stringify({",
        "AtWs.smsLog('list', JSON.stringify({",
        "发送成功后写设备记录",
    ),
    (
        "写记录失败却报成功（拿一句「发送成功」把两件事盖过去）",
        "smsjs2",
        "Mt5700.warning('已发出，但发送记录未写入设备",
        "Mt5700.success('已发出，但发送记录未写入设备",
        "写记录失败要分开说",
    ),
    (
        # ★ 字符串形态会被 rpcd 以 code=2 拒掉，界面只剩一个「删除失败」——
        #   与「传错参数」长得一模一样，最难排查，所以单独钉一条。
        "删除已发记录时把 id 传成字符串",
        "smsjs2",
        # ★ 2026-09-28：删除逻辑收口到 runDeletes()，
        #   变量名从 msg.logId 改为 t.logId（编号统一经 logIdOf 取）。
        #   锚点跟着改，否则变异落不到地方（出现 0 次）。
        "AtWs.smsLog('del', '', t.logId)",
        "AtWs.smsLog('del', '', String(t.logId))",
        "删除已发记录走设备（编号经 logIdOf 取，且传数字）",
    ),
    (
        "设置页的清空按钮不作用到设备",
        "smssetjs3",
        "AtWs.smsLog('clear')",
        "AtWs.smsLog('list')",
        "设置页三个按钮都走 AtWs.smsLog",
    ),
    (
        "rpc 声明的方法名写错（前端调用全落到「后端未升级」）",
        "rpcjs7",
        "method: 'smslog'",
        "method: 'smslog_typo'",
        "rpc.js 声明了 mt5700.smslog",
    ),
    (
        "直接写目标文件（写到一半断电留下半个 JSON，整份记录读不出来）",
        "uc8",
        "\t\tfs.writefile(tmp, sprintf('%J', list));\n\t\tfs.rename(tmp, SMS_LOG_FILE);",
        "\t\tfs.writefile(SMS_LOG_FILE, sprintf('%J', list));",
        "ucode 用「临时文件 + rename」落盘",
    ),
    (
        "写盘失败却回报成功（三处 success:false 永远走不到）",
        "uc8",
        # B09 后 catch 里先清 tmp 再 return false —— 锚点随行为迁移；
        # callLogWrite 有同构 catch，锚点必须带 SMS_LOG_FILE 限定到 smsLogWrite
        "\t\tfs.writefile(tmp, sprintf('%J', list));\n\t\tfs.rename(tmp, SMS_LOG_FILE);\n\t\treturn true;\n\t} catch (e) {\n\t\ttry { fs.unlink(tmp); } catch (e2) { }\n\t\treturn false;\n\t}",
        "\t\tfs.writefile(tmp, sprintf('%J', list));\n\t\tfs.rename(tmp, SMS_LOG_FILE);\n\t\treturn true;\n\t} catch (e) {\n\t\ttry { fs.unlink(tmp); } catch (e2) { }\n\t\treturn true;\n\t}",
        "smsLogWrite 自己也要如实回报失败",
    ),
    (
        # ★ 这是**否决方案**的残留守卫：把相对有效期换成绝对（VP 写发送时刻）
        #   会让短信一出就过期。已发记录改走设备文件后，这条路不该再出现。
        "改用绝对有效期（短信一出就过期，会被短消息中心丢弃）",
        "smsencjs",
        "firstOctet |= 0x10;",
        "firstOctet |= 0x18;",
        "smsEncode.js 仍用相对有效期",
    ),
    (
        "ACL 的 write 段没放行 smslog（add/del/clear 全被拒，页面只落「读不到」）",
        "acljson",
        "\t\t\t\t\t\"events\",\n\t\t\t\t\t\"selfheal\",\n\t\t\t\t\t\"es9p\",\n\t\t\t\t\t\"exitip\",\n\t\t\t\t\t\"vowifi\",\n\t\t\t\t\t\"vowifi_set\",\n\t\t\t\t\t\"smslog\"",
        "\t\t\t\t\t\"events\",\n\t\t\t\t\t\"selfheal\",\n\t\t\t\t\t\"es9p\",\n\t\t\t\t\t\"exitip\",\n\t\t\t\t\t\"vowifi\",\n\t\t\t\t\t\"vowifi_set\"",
        "ACL 的 write 允许 mt5700.smslog",
    ),

    # ============ UI 一致性与读取时序（2026-09-28） ============
    # ★ 锚点唯一性已逐条核（每条各出现 1 次）。
    (
        "应用/撤销后不重新加载（界面停在假状态，应用失败也看不出来）",
        "smssetjs4",
        "var staged = Mt5700.staged({ onChanged: function () { loadAll(); } });",
        "var staged = Mt5700.staged({ onChanged: function () { } });",
        "应用/撤销后回到模组真实状态",
    ),
    (
        "暂存项失败被吞掉（没写进去却当成写进去了）",
        "smssetjs4",
        "if (!res.success) throw new Error(Ui.atErrorText(res, '中心号码保存失败'));",
        "if (!res.success) return;",
        "暂存项失败必须抛出去",
    ),
    (
        "中心号码不接暂存（改了没有任何保存入口 —— 用户报的就是这个）",
        "smssetjs4",
        "centerInput.addEventListener('change', function () { stageCenter(centerInput.value); });",
        "centerInput.addEventListener('change', function () { });",
        "中心号码改动走暂存",
    ),
    (
        "悬浮条不挂到页面（有暂存却没有任何「保存并应用」入口）",
        "smssetjs4",
        "\t\tbody.appendChild(staged.el);",
        "\t\tstaged.el;",
        "悬浮条只挂一次",
    ),
    (
        "空中心号码也暂存（会下发 AT+CSCA=\"\" 把中心号清掉）",
        "smssetjs4",
        "if (!num) {",
        "if (num) {",
        "空中心号码不暂存",
    ),
    (
        # ★ 「空回调」扫描是**源码文本级**判据，所以这里喂的缺陷样例必须真的把
        #   `makeSwitch(function () {})` 这个形态写进源码 —— 直接把原回调整体换成
        #   空回调会让花括号失衡（变异后语法非法，无法归因），故改为在紧邻处补一行
        #   同形态的控件：判据看的是「文件里还有没有空回调控件」，这正是它的语义。
        "页面里重新出现空回调控件（界面变了、命令一条不发）",
        "msjs3",
        "\t\tvar thermCaChk = thermCaSwitch.querySelector('input');",
        "\t\tvar thermCaChk = thermCaSwitch.querySelector('input');\n"
        "\t\tvar _probeEmptyHandler = makeSwitch(function () {});",
        "全站页面里没有「空回调」的可编辑控件",
    ),
    (
        "回调在但不下发命令（同样存不下来）",
        "msjs3",
        "\t\tvar thermCaSwitch = makeSwitch(function (checked, input) {\n\t\t\tsend(thermCmd()).then(function (res) {",
        "\t\tvar thermCaSwitch = makeSwitch(function (checked, input) {\n\t\t\tPromise.resolve({ success: true }).then(function (res) {",
        "高温时关闭 CA/MIMO 开关会真的下发命令",
    ),
    (
        "尾段预热不插在头段任务之后（连接状态又被整批预热挡住 1.6 秒）",
        "nsjs2",
        "if (idx === SLOW_HEAD_COUNT - 1) {",
        "if (idx === -1) {",
        "尾段预热插在头段任务之后",
    ),
    (
        "拆清单时尾段漏抄一条（少问一次模组，那一项读数永远为空）",
        "nsjs2",
        "\t\t\t'AT+COPS?'         /* loadDiagnostics */\n\t\t];",
        "\t\t];",
        "两段合起来仍是完整 16 条",
    ),
    (
        "拆清单时把一条抄进两段（每条多打一次串口，把优化反着做）",
        "nsjs2",
        "'AT^DSFLOWQRY'     /* getFlow */",
        "'AT+COPS?'         /* getFlow */",
        "头段＝连接状态与载波表要用的那 6 条",
    ),
    # ★ 2026-09-29 NSA 下把 5G 显示成「4G-LTE」。
    #   真机根因：^MONSC 在 NSA 下报 **LTE 锚点**小区（^LENDC 却已报 <nr_pscell>=1、
    #   ^HFREQINFO 里有 sysmode=7 的 NR 载波），而制式判定只吃了锚点的 <sysmode>。
    #   四处锚点分别锁：判定入口漏证据 / 纯判定函数漏分支 / 调用点没接线 / 徽章判据。
    (
        "判定入口 ratDisplay 不把 NR 证据传下去（NSA 又退回 4G-LTE）",
        "nsjs3",
        "return systemModeLabel(sysMode, nrCcs, registered, nrCcs > 0 || dcActive);",
        "return systemModeLabel(sysMode, nrCcs, registered, false);",
        "★ LTE 锚点 + NR 在用 → 5G-NR",
    ),
    (
        "systemModeLabel 丢掉「锚点是 LTE 但 NR 在用」这一支",
        "nsjs3",
        "var isNr = m === 'NR' || m === 'NR-5GC' || m === '5G' || (m === 'LTE' && nrActive);",
        "var isNr = m === 'NR' || m === 'NR-5GC' || m === '5G';",
        "★ LTE 锚点 + NR 在用 → 5G-NR",
    ),
    (
        # 2026-10-26：连接状态卡的「网络制式」格已删（去重），ratDisplay 的唯一调用点
        # 搬到了结论卡，签名也从 `state.cell.sysMode` 变成局部变量 `cell.sysMode`。
        # 变异随之改锚 —— 要求不变：**载波表必须真的传给 ratDisplay**，
        # 少传这一路，NSA 下的 LTE 锚点就会被判成 4G（2026-09-29 真机 bug）。
        "结论卡没把载波表交给 ratDisplay（改了纯函数却没接线 —— 最常见的半程修复）",
        "nsjs3",
        "ratDisplay(cell.sysMode, state.carriers,",
        "ratDisplay(cell.sysMode, [],",
        "走统一判定入口 ratDisplay",
    ),
    (
        "聚合徽章退回 count>1（NSA 下把 EN-DC 双连接说成「2 载波聚合中」）",
        "nsjs3",
        "var badge = aggregationBadge(count, nrCcs, dcActive);",
        "var badge = (!count ? '不可用' : count > 1"
        " ? (count + ' 载波聚合中') : dcActive ? 'EN-DC 双连接' : '单载波');",
        "renderCarriers 改用 aggregationBadge",
    ),
    # ★ 2026-10-16 厂商 beta 固件电话功能移植。此处现存三条，守的是
    #   「通道故障不许被渲染成空闲」与「禁用判据只准一处」。
    #   原 preflight 相关的六条（只读结构 CIREG? / QCFG 混入 / SIM 判据 /
    #   承载域判据 / 四字段透传 / ready 宽松取值）已随 v2.4.27 preflight 下线
    #   一并删除 —— 变异条目必须与断言同生共死，否则每次跑守卫都报
    #   "锚点出现 0 次"，把真问题淹掉。
    (
        # 把「不是数组」判据退回 `=== null`：后端若不回 calls 字段，
        # undefined === null 为假 ⇒ 报错分支不可达 ⇒ 通道故障看起来像空闲
        # —— 这正是本次修掉的真实 bug（红线 23）。
        "视图：失败判据退回 res.calls === null（报错分支变死代码，故障像空闲）",
        "voicejs",
        "if (!Array.isArray(res.calls)) {",
        "if (res.calls === null) {",
        "视图判据用 Array.isArray，不是 === null（否则报错分支是死代码）",
    ),
    (
        # 令牌表缺一项：后端给出 held 时前端查不到 → 退回「状态未知」。
        "视图：STAGE_TEXT 少了 held 令牌（保持中的通话显示成「状态未知」）",
        "voicejs",
        "\t\t\theld: '通话保持',\n",
        "",
        "STAGE_TEXT 覆盖后端会给出的全部令牌",
    ),
    (
        # 记录不再写 direction：厂商口径的消费方与老记录兼容链一起断。
        "视图：记录不再写 direction 字符串（只剩 dir 整数）",
        "voicejs",
        "direction: (t.dir === 1) ? 'incoming' : 'outgoing',",
        "direction: 'incoming',",
        "视图记录写出 direction 字段",
    ),
    (
        # 失败分支不显式回 calls:null：前端拿到 undefined，判据若同时退化就会误判。
        "ucode：callStatus 无响应分支丢掉 calls: null",
        "uc9",
        "calls: null, error: 'AT 通道无响应' }",
        "error: 'AT 通道无响应' }",
        "callStatus 无响应分支显式回 calls: null",
    ),
    (
        # 把厂商的 Quectel 私有命令当成「数据」留在代码行里（注释外）。
        # 它是 MT5700M-CN 手册里没有的命令，一旦被下发就是未定义行为（红线 27）。
        "ucode：代码行里混进 Quectel 私有命令 AT+QCFG（红线 27）",
        "uc9",
        "let r = rpcCall('at', { cmd: 'AT+CLCC' });",
        "let r = rpcCall('at', { cmd: 'AT+CLCC', qcfg: 'AT+QCFG=\"ims\"' });",
        "★ Quectel 私有命令只出现在注释里（不得成为真实下发命令）",
    ),
    (
        # 总态优先级倒置：同时「已接通」与「来电振铃」时挑错的那个。
        "ucode：callOverallStage 优先级倒置（已接通被来电振铃盖住）",
        "uc9",
        "['active', 'held', 'waiting', 'ringing', 'alerting', 'dialing']",
        "['dialing', 'alerting', 'ringing', 'waiting', 'held', 'active']",
        "总态优先级序 active > held > waiting > ringing > alerting > dialing",
    ),
    (
        # ★★ 2026-10-16 真实故障（不是假想）：rpc.js 的 fetchCall 没搬 stage。
        #   ucode 真机确实回 "stage":"idle"，视图也确实读 res.stage，但中间这层
        #   没透传 ⇒ res.stage 恒 undefined ⇒ st.stage 恒 null ⇒ 徽标一直退回
        #   CALL_STATE 的 0-5 粗判。上一轮真机验证用 ubus 直调**绕过**了这一层，
        #   所以没暴露。守卫必须覆盖「相邻两层的字段名」而不只是单层。
        "rpc.js：fetchCall 漏搬 stage（后端在回、前端在读，中间层丢弃）",
        "rpcjs8",
        "stage: (resp.stage == null) ? null : resp.stage,",
        "/* stage 未透传 */",
        "★ fetchCall 透传 stage（后端在回、前端在读，这一层不能漏）",
    ),
    (
        # 按钮禁用不再看通道故障：用户对着一个已经断了的通道反复点。
        "视图：applyGates 不再把通道故障算进禁用",
        "voicejs",
        "var blocked = st.busy || st.channelError;",
        "var blocked = st.busy;",
        "applyGates 把「通道故障」算进禁用（厂商 !s.status?.error 那一半）",
    ),
    (
        # 通话中还能再拨一个号（第二个 ATD 会被模组拒，前端该自己挡住）。
        "视图：通话中「拨打」仍可点（会发出第二条 ATD）",
        "voicejs",
        "dialBtn.disabled = blocked || (st.phase !== 'idle');",
        "dialBtn.disabled = blocked;",
        "拨打只在 idle 可点（通话中不该还能再拨一个）",
    ),
    (
        # 接听判定丢掉 blocked：通道忙/故障时接听键仍可点，对着一个
        # 注定失败的通道反复点（厂商 usable 里 !s.status?.error 那一半）。
        "视图：接听判定丢掉 blocked（通道故障时仍可点接听）",
        "voicejs",
        "answerBtn.disabled = blocked",
        "answerBtn.disabled = false && blocked",
        "接听只在来电（incoming）可点 —— 判据用 phase 不用 stage 令牌",
    ),
    (
        # 通话按钮退回 display 隐藏：用户原地反馈「没看到接停电话」——
        # 来电只响几秒，藏起来的接听键根本指望不上。
        "视图：通话按钮退回 display 隐藏（用户看不到接听/挂断）",
        "voicejs",
        "\t\thangupBtn.textContent = (st.phase === 'incoming') ? '拒接' : '挂断';\n\n\t\tapplyGates();",
        "\t\tanswerBtn.style.display = (st.phase === 'incoming') ? '' : 'none';\n\t\thangupBtn.textContent = (st.phase === 'incoming') ? '拒接' : '挂断';\n\n\t\tapplyGates();",
        "通话按钮常驻可见，不用 display 隐藏（用户原话：没看到接停电话）",
    ),
    (
        # 铃声开关不纳入禁用判据：通道忙/故障时还能切铃声，判据漏一个按钮。
        "视图：铃声开关不纳入 applyGates（禁用判据漏一个按钮）",
        "voicejs",
        "\t\tringBtn.disabled = blocked;\n",
        "",
        "铃声开关也纳入 applyGates（通道忙时不该切铃声）",
    ),
    (
        # 接听判据从 phase 退回 stage 令牌：老后端没有 stage（st.stage=null）时，
        # 来电振铃中接听键却是灰的 —— 令牌细但脆，现算的 phase 才稳。
        "视图：接听判据退回 stage 令牌（老后端上来电接听键是灰的）",
        "voicejs",
        "answerBtn.disabled = blocked || (st.phase !== 'incoming');",
        "answerBtn.disabled = blocked\n\t\t\t|| ((st.stage !== 'ringing') && (st.stage !== 'waiting'));",
        "接听只在来电（incoming）可点 —— 判据用 phase 不用 stage 令牌",
    ),
    (
        # 建页后不灰化：connectThen 握手完成前按钮是默认可用态，
        # 空闲时「接听/挂断」亮着是个假象。
        "视图：建页后不立即 applyGates（握手前按钮是可用态假象）",
        "voicejs",
        "\tapplyGates();\n\n\t/* 浏览器要求用户手势后才能出声",
        "\n\t/* 浏览器要求用户手势后才能出声",
        "建页后立即 applyGates 一次（connectThen 握手前按钮不能是可用态）",
    ),
    (
        # 读失败后不复位通道标志 ⇒ 一次抖动就让按钮永久灰化。
        "视图：status 读成功后不复位 channelError（按钮永久灰化）",
        "voicejs",
        "\t\t\tst.channelError = false;\n",
        "\t\t\t/* 未复位 */\n",
        "status 读失败置 channelError 且成功时复位（否则永久灰化）",
    ),
    (
        # 禁用判据散落回 setBusy —— 第二套判据必然与 applyGates 漂移。
        "视图：setBusy 里另写一套 disabled（禁用判据漂移）",
        "voicejs",
        "\t\t\tapplyGates();\n\t\t}\n\n\t\tfunction setErr(msg) {",
        "\t\t\tdialBtn.disabled = on;\n\t\t}\n\n\t\tfunction setErr(msg) {",
        "setBusy 只改 busy 标志并转交 applyGates",
    ),
    # 原「视图：三态记号退回 core（CS 未过 + IMS 已过…）」条目已随 v2.4.27
    # 的 preflight 下线一并删除：被变异的代码与被守卫的断言同时不存在了。
    # ★ 2026-10-22 通话事件驱动（^CCALLSTATE）：四条视图 + 一条 Rust。
    #   锚点唯一性已核（各出现 1 次）。
    (
        # 把 URC 的 state 直接当 phase 用 —— 这是最容易犯、也最难查的错：
        # ^CCALLSTATE 的 3=connected 与 CLCC 的 0=active 是两套编号，
        # 写进 applyCalls 会整体错位，而页面「看起来还在动」。
        "视图：URC 直接改 phase（两套状态编号混用）",
        "voicejs",
        "\t\t\tif (d.domain != null) { st.domain = d.domain; }",
        "\t\t\tif (d.domain != null) { st.domain = d.domain; }\n\t\t\tst.phase = 'active';",
        "URC 只当触发器",
    ),
    (
        # 去掉合并窗口：同一批 URC（^CONN 与 ^CCALLSTATE 常常同毫秒到）
        # 会连发几条 CLCC，串行占满 AT 通道（单条 65~133ms）。
        "视图：URC 触发刷新没有合并窗口（同批 URC 连发 CLCC）",
        "voicejs",
        "\t\t\tif (now - lastStatusAt < 250) {",
        "\t\t\tif (now - lastStatusAt < 0) {",
        "250ms 合并窗口",
    ),
    (
        # 时长退回前端差值：切后台、页面重载就丢，而 ^CEND 的第二个字段
        # 本来就是模组给的秒数（实测 25 对应 25 秒通话）。
        "视图：通话时长不用 ^CEND（回落到前端差值）",
        "voicejs",
        "duration: (t.endedDuration != null) ? t.endedDuration\n"
        "\t\t\t\t\t: (t.answeredAt ? Math.round((Date.now() - t.answeredAt) / 1000) : 0),",
        "duration: (t.answeredAt ? Math.round((Date.now() - t.answeredAt) / 1000) : 0),",
        "通话时长优先用 ^CEND",
    ),
    (
        # 新一通不清残留：上一通没来得及用上的 ^CEND 时长会被记到这一通头上。
        "视图：新一通开始不清 ^CEND 残留（时长记到下一通）",
        "voicejs",
        "\t\t\t\t\tpendingDuration = null;\n\t\t\t\t\ttrack = {",
        "\t\t\t\t\ttrack = {",
        "新一通开始清掉",
    ),
    (
        # 后端不再把 ^CCALLSTATE 登记为 passthrough：命令等待期（每 2 秒一次
        # AT+CLCC）这条 URC 会被并进应答体，前端收不到 —— 而本地测试仍全绿，
        # 因为断言只查了前端。变异它验证的正是那条跨层断言。
        "Rust：is_passthrough_urc 漏掉 ^CCALLSTATE（命令等待期广播位丢失）",
        "rustat",
        '    if line.starts_with("^CCALLSTATE:")\n',
        '    if line.starts_with("^XXCCALLSTATE:")\n',
        "is_passthrough_urc 登记了五条通话 URC",
    ),
    (
        # 不还原共享单例的 pollInterval：切走之后每个页面都按 500ms 拉 events，
        # 白挤 rpcd 单线程（红线 63）。
        "视图：离开页面不还原事件轮询间隔（其它页面被按 500ms 拉 events）",
        "voicejs",
        "\t\t\tc.pollInterval = savedPollInterval;\n",
        "\t\t\t/* 未还原 */\n",
        "把事件轮询压到 500ms",
    ),
    (
        # 不清合并定时器：离开语音页之后还会触发一次 refreshStatus，
        # 等于对着一张已卸载的页面往模组打一条 CLCC。
        "视图：离开页面不清 URC 合并定时器（走后仍打一条 CLCC）",
        "voicejs",
        "\t\t\tif (kickTimer) { clearTimeout(kickTimer); kickTimer = 0; }\n",
        "\n",
        "离开页面清掉 URC 合并定时器",
    ),
    (
        # 把取证语言写回用户文案：2026-10-22 之前语音页那条提示就是这么开的头，
        # 全句 208 字，讲 USB 六个接口、手册 244 条命令、要不要重编固件。
        # 用户点进「语音通话」是要打电话，不是读实验记录。
        "文案：能力提示里写回「实测（日期）」（界面变实验记录）",
        "voicecopy",
        "\t\t}, '这一页只管信令：能拨能接",
        "\t\t}, '实测（2026-10-22）这一页只管信令：能拨能接",
        "没有内部取证语言",
    ),
    (
        # 本固件 ucode 不支持 throw 语句：一处 throw = 整个 mt5700.uc 编译失败 =
        # rpcd 不注册 mt5700 对象 = 所有页面 -32000（2026-10-22 真机事故）。
        "ucode：混入 throw 语句（本固件 ucode 直接 Syntax error，对象全体消失）",
        "ucsyn",
        "\tlet fail = 0;\n",
        "\tlet fail = 0;\n\tfunction _t(){ throw \'x\'; }\n",
        "mt5700.uc 无 throw 语句",
    ),
]


# 单个测试文件的执行上限。正常的契约测试都在数秒内结束，这里纯粹是兜底：
# 没有它，一个永不退出的测试进程会把 CI 拖到 GitHub 默认的 6 小时上限。
TEST_TIMEOUT = 300


def run_test(tgt):
    test = TARGET_TEST[tgt]
    # timeout 是兜底、不是预算：契约测试正常都在几秒内结束。它只防「某个测试进程
    # 永不退出」把 CI 空转到 GitHub 默认的 6 小时上限。
    try:
        p = subprocess.run([NODE, str(test)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=TEST_TIMEOUT)
    except subprocess.TimeoutExpired:
        return 1, "测试超时（>%ds）：%s" % (TEST_TIMEOUT, test)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def syntax_ok(path):
    """语法预检：确认变异本身没把文件写坏，否则"判红"可能只是崩了。

    两种文件需要两条路，别混用：
      · tests/ 下的契约测试是 CommonJS（首行还有 #! shebang）→ node --check 直接可用；
      · LuCI 的 view / require 模块顶层常是 `return L.view.extend({...})`，在 CommonJS
        里属非法 return，--check 必然报错 → 包一层 new Function()（函数体内 return 合法，
        仍能抓出真的语法错误）。
        ★ 注意 new Function 不认 shebang，所以测试文件不能走这条路。
       · CSS 不做预检（改的是属性值 / 选择器，不会产生解析错误）。
       · shell 也不做预检：变异只是插入/删除注释行，不会产生语法错误；
         而 `bash -n` 在 Windows 与 CI 上路径不同，为一条永远合法的变异去
         引入平台分支不值得（真想查可以本地跑 bash -n）。
    """
    if path.suffix == ".css":
        return True
    if path.suffix == ".sh":
        return True
    # Rust 不做预检：本机与 CI 都没有 cargo/编译器，而 `new Function(源码)` 对
    # Rust 语法必然报错。这些变异只改标识符/参数/常量，不会把文件写坏。
    if path.suffix == ".rs":
        return True
    # ucode 不做预检：本机与 CI 都没有 ucode 解释器；而 `new Function(源码)` 对
    # ucode 的顶层写法（对象常量、纯声明式结构）可能误报语法错误。
    # 这些变异只改一个表达式/一个分支，语法上必然仍合法。
    if path.suffix == ".uc":
        return True
    # ★ 兜底：只有 .js 才做 JS 预检。
    #   2026-09-26 踩到：新加了两个非 JS 目标（`root/etc/config/at-webserver` 是无扩展名
    #   的 UCI 配置、`po/zh_Hans/*.po` 是翻译表），它们既不是 .css/.sh/.rs/.uc，
    #   又带非空后缀，于是落到下面的 `new Function` 分支 → 必然「语法非法」，
    #   变异被归因成「无法归因」，看着像守卫没生效。用白名单方向写死，以后加
    #   任何新类型都不会再撞。
    if path.suffix != ".js":
        return True
    if "tests" in path.parts:
        args = [NODE, "--check", str(path)]
    else:
        args = [NODE, "-e",
                "new Function(require('fs').readFileSync(process.argv[1],'utf8'));",
                str(path)]
    p = subprocess.run(args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode == 0


def self_check_maps():
    """自省：TARGETS / TARGET_TEST / MUTATIONS 三张表必须自洽。

    ★ 2026-09-28 新增。为什么需要它：仓库红线 16b 写着 —— 变异挂错测试文件时，
      「变异生效却没人判红，**比没守卫更危险**」。而这三张表原来全靠人工对照，
      TARGETS 的注释里反复写「别挂错」「一份文件两条测试通道」，
      却**没有任何机器检查**。于是新增守卫时忘了补映射、或改了键名漏改另一处，
      都会静默退化成"变异改了、没人判红"，而输出仍然全绿。
      这里把它变成会判红的断言。
    """
    bad = []
    for k in TARGETS:
        if k not in TARGET_TEST:
            bad.append("TARGETS 的键 %r 在 TARGET_TEST 里没有映射"
                       "（变异会生效但没人判红）" % k)
    for k, t in TARGET_TEST.items():
        if k not in TARGETS:
            bad.append("TARGET_TEST 的键 %r 在 TARGETS 里没有对应目标" % k)
        if not t.exists():
            bad.append("TARGET_TEST 的键 %r 指向的测试文件不存在：%s" % (k, t))
    for i, item in enumerate(MUTATIONS, 1):
        name, tgt = item[0], item[1]
        if tgt not in TARGETS:
            bad.append("MUTATIONS[%d]（%s）的目标键 %r 不在 TARGETS 里" % (i, name, tgt))
        elif tgt not in TARGET_TEST:
            bad.append("MUTATIONS[%d]（%s）的目标键 %r 没有 TARGET_TEST 映射"
                       "（变异生效却没人判红）" % (i, name, tgt))
    return bad


def restore_all():
    for k, path in TARGETS.items():
        path.write_bytes(ORIG[k])


def _install_signal_guard():
    """被 SIGTERM / SIGINT 杀掉时也要还原。

    ★ 2026-10-21 真踩过：一次 `python tools/verify-guards.py` 被 SIGTERM 打断
    （命令超时），进程直接终止，`finally` 根本没跑 —— `sms_center.js` 里
    `Mt5700.warning(...)` 被留成了变异后的 `Mt5700.success(...)`。表面上
    `run-all.js` 还「全部通过」，实际那条契约测试正在红：断言要的是 warning。
    变异残留比崩溃更危险，因为它把仓库改成了「看起来正常但其实坏了」的状态。

    `finally` 只能兜异常，兜不住信号；信号处理器里必须用 os._exit，
    否则 KeyboardInterrupt 会再抛一次、把还原流程自己打断。
    """
    import signal

    def _handler(signum, _frame):
        try:
            restore_all()
        except Exception:
            pass
        sys.stderr.write(f"\n收到信号 {signum}，已还原被变异的文件后退出\n")
        sys.stderr.flush()
        os._exit(130)

    for name in ("SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            pass        # 非主线程 / 平台不支持，忽略


def check_anchors():
    """只校验变异锚点，不跑任何测试（约 1 秒）。

    为什么单独有这个模式：删改 UI 之后，断言改了、**变异锚点没跟着改** 是这类
    检查最常失效的方式（2026-10-26 实例：删掉「网络制式」格后 ratDisplay 调用点
    搬家，变异锚点仍指向旧签名，CI 报「出现 0 次」）。完整验证要跑十几分钟，
    没有人会在每次改完界面后跑 —— 这个模式可以。
    """
    bad = 0
    for i, (name, tgt, old, new, key) in enumerate(MUTATIONS, 1):
        if tgt not in TARGETS:
            print(f"[{i}] ✗ 目标键未登记：{tgt}（{name}）")
            bad += 1
            continue
        text = TARGETS[tgt].read_text(encoding="utf-8")
        cnt = text.count(old)
        if cnt != 1:
            rel = TARGETS[tgt].relative_to(ROOT) if str(TARGETS[tgt]).startswith(str(ROOT)) else TARGETS[tgt]
            print(f"[{i}] ✗ 锚点出现 {cnt} 次：{name}")
            print(f"      锚  ：{old!r}")
            print(f"      目标：{rel}")
            bad += 1
    print(f"\n锚点自检：{len(MUTATIONS) - bad}/{len(MUTATIONS)} 可用")
    return 0 if bad == 0 else 1


def main():
    if "--anchors" in sys.argv:
        return check_anchors()

    for tgt in ("js", "esimjs", "js2", "mt5700js"):
        rc0, out0 = run_test(tgt)
        print("基线[%s]:" % tgt, "绿色（0 失败）" if rc0 == 0 else "红！先修基线再验证守卫")
        if rc0 != 0:
            print(out0)
            return 1

    bad = 0
    # 基线确认是绿的之后才落备份：此刻磁盘状态就是干净的 ORIG
    _save_backups()
    try:
        for i, (name, tgt, old, new, key) in enumerate(MUTATIONS, 1):
            path = TARGETS[tgt]
            text = ORIG[tgt].decode("utf-8")
            if text.count(old) != 1:
                print(f"[{i}] ✗ 变异锚点不唯一/找不到（出现 {text.count(old)} 次）：{name}")
                bad += 1
                continue
            path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="")
            # ↑ newline="" 是关键：Windows 上 write_text 默认把 \n 翻成 \r\n，
            #   会把整个文件变成 CRLF。仓库约定 LF，而测试全靠「读源码 + 假设 LF 的正则」，
            #   一旦变 CRLF，那种正则静默匹配不上、反向守卫直接失效
            #   （2026-09-20 真踩过，见 tests/line-endings-contract.test.js）。
            try:
                # 先确认变异本身语法合法 —— 否则"判红"可能只是崩了
                if not syntax_ok(path):
                    print(f"[{i}] ✗ 变异后语法非法，无法归因：{name}")
                    bad += 1
                    continue
                rc, out = run_test(tgt)
                hit = key in out
                if rc != 0 and hit and "异步用例异常" not in out:
                    # ★ 统计口径（2026-09-24 修正）：全仓测试统一用 `'  ✗ '` 前缀输出失败项。
                    #   原先这里写 `'\n  ✗'`，会把**第一行**失败漏掉（首行前面没有 '\n'）→
                    #   「只被 1 条断言抓住」的变异会显示「判红 0 处」，看着像守卫没生效，
                    #   实际是 off-by-one。去掉 '\n' 约束即可；`'  ✗'` 仍足以与汇总行区分
                    #   （汇总行是无前导空格的 `'\n✗ N 项断言失败'`）。
                    print(f"[{i}] ✓ 变异被断言检出：{name}（判红 {out.count('  ✗')} 处）")
                else:
                    print(f"[{i}] ✗ 变异被放过：{name}（rc={rc}, 关键词命中={hit}）")
                    bad += 1
            finally:
                # ★ 还原必须放 finally：本工具会**改仓库源码**，只要有一条异常路径
                #   跳过还原（Ctrl-C、CI 取消、node 被杀、TARGET_TEST 缺键、甚至
                #   下面 print 里的 ✓ 在 GBK 控制台上抛 UnicodeEncodeError），
                #   故意改坏的 euicc.js / mt5700.uc 就会留在工作区里。
                #   2026-09-28 真踩过：一次 UnicodeEncodeError 崩在 print 上，
                #   把 euicc.js 的变异留了下来，下一次运行于是误报「基线红！」——
                #   查了半天才发现基线根本没坏，是上一轮的残留。
                restore_all()
    finally:
        # 外层再兜一次：循环本身抛异常（例如 MUTATIONS 结构不对）时同样要还原。
        restore_all()

    same = all(TARGETS[k].read_bytes() == ORIG[k] for k in TARGETS)
    print("还原复核:", "逐字节一致" if same else "*** 不一致！***")
    if same:
        _clear_backups()        # 只有确认还原到位才销账，否则留着给下一轮恢复
    rc, _ = run_test("esimjs")
    print("还原后基线:", "绿色" if rc == 0 else "红！")
    return 1 if (bad or rc != 0 or not same) else 0


# ★ 2026-09-28：表自洽是**纯静态**检查，放在所有定义之后、进入 main 之前。
#   ★ 实测校准（别把它想得比实际更强）：模块级的 `NODE = _resolve_node()` 仍在**更前面**
#     执行，所以本机没设 NODE_BIN 时这里同样**跑不到** —— 只会看到「找不到 node」。
#     它能拦住的是"新增守卫忘了补映射"这类结构性退化：在 CI（有 node）与设了 NODE_BIN
#     的本机上，它都会在 main() 之前跑完并判红。
_map_bad = self_check_maps()
if _map_bad:
    print("三张表（TARGETS / TARGET_TEST / MUTATIONS）不自洽，先修表再谈验证守卫：")
    for _m in _map_bad:
        print("  ✗", _m)
    sys.exit(1)


if __name__ == "__main__":
    # ★ Windows 控制台默认是 GBK，而本脚本要打印 ✓ / ✗ —— Python 会抛
    #   UnicodeEncodeError 并**中断整个流程**（不是只丢一行输出）。
    #   2026-09-28 真踩过：崩在 print(f"... ✓ ...") 上，那一轮的 restore_all()
    #   被跳过，euicc.js 的变异留在了工作区，下一次运行便误报「基线红！」。
    #   这里把两个流强制成 UTF-8，并容错无法编码的字符：即便某个控制台仍不支持，
    #   也只会显示成 ?，不会再中断流程。
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    # 先装信号兜底再进门：一旦开始变异，任何中断都必须先还原
    _install_signal_guard()
    sys.exit(main())
