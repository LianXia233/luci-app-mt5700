# 更新日志 (Changelog)

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [2.5.0] - 2026-10-26

### Added — v9 界面第一次真正上真机：自有外壳接管整屏

背景：用户两次反馈「预览图和真机完全不像」。核对后确认不是预览图错，而是
`docs/design-v9` 只是静态原型 —— **一行都没进过插件**，真机跑的一直是旧
Argon 壳。本版把外壳做了进去。

- **接管整屏**：`Mt5700.page()` 是全站唯一入口，在那里等节点入文档后把
  `.mt5700-page` 搬进自有外壳（左栏 + 顶栏 + 画布），再给 body 加
  `mt5700-sh-armed` 把 `.main` 藏掉。搬完才藏 —— 结构变了就退回旧界面，
  不白屏。
- **导航 12 项全覆盖**：总览 / 无线与频段 / 接入与拨号 / eSIM / 模组信息 /
  模组升级 / 短信 / 短信设置 / 语音 / AT 终端 / 运行日志 / 服务与升级。
  原型只有 11 项（升级与短信设置没单列），少一项就有页面进不去，所以补齐。
- **明暗可切**，记忆在 `localStorage`（默认深色）；`data-theme` 同时挂 html，
  让弹窗层也跟着变。
- **样式由原型生成**：`tools/gen-shell-css.py` 把原型 `<style>` 作用域化后
  写进 mt5700.css 的标记区段。原型是唯一真相，手抄一份就等于两份真相。
  `tools/bump-css.py` 把「重新生成 + 重算指纹 + bump 版本号」合成一条命令
  （这三步漏一步都是静默故障：样式没生效或契约测试莫名变红）。
- **总览正文改 12 列栅格**：载波与聚合（7 列）+ 信号质量（5 列）并排。

### Fixed — 宿主污染三处（都会让「壳」看着像坏掉）

| 现象 | 真因 |
|:--|:--|
| 顶栏有一条 1264×32 的蓝带，DOM 里查不到 | Argon 用 `header::after` 画装饰块，我们的顶栏也是 `<header>` |
| 切浅色后顶栏标题白底白字 | Argon 给 `header` 设了白色字，我们的令牌没盖住 |
| 弹窗在深色界面里是白底 | 弹窗挂在 body 上、在壳外，拿不到壳内的令牌 |

另有一处自伤：`body.mt5700-sh-armed .main{display:none}` 把**外壳自己的主列**
也藏了（Argon 容器同样叫 `.main`），右侧整片空白 —— 改成 `> .main`。

### Known — 还没对齐的部分（下一步）

外壳、配色、栅格已与原型一致；**页面内容编排仍是旧结构**：总览缺原型里的
4 个 KPI 卡与「常用动作」面板，区块顺序也没按原型排；其余 11 页套在新壳里
但内部还是老排布。逐页按原型重排是后续工作，不是本版承诺。

真机核对：网络状态、无线与频段两页在 1560 宽下与原型同构；顶栏/侧栏/
结论卡/链路条/载波表/信号仪表全部就位；深色与浅色都实拍确认。

## [2.4.48] - 2026-10-26

### Removed — 音频内核模块移出包（957KB，占包体积的四成）

2.4.30 把 11 个 ALSA 内核模块（`root/usr/share/mt5700/audio/6.12.112/*.kmod`）
随包分发，等的是「换成带 USB Audio Class 的模组」那一天。但这台设备的 USB
没有 Audio Class（`AT^SETMODE` 九个模式全为数据口、SoC 无 `/dev/snd`、
PCM 引脚采样全 0），模块在本机永远走不到 insmod —— 却是包体积里最大的一块：

| 版本 | 包内文件合计 | 构成 |
|:--|--:|:--|
| v2.0.0 | 574 KB | 前端 + ucode |
| v2.3.49 | 1343 KB | 加 jsQR（252 KB，eSIM 二维码） |
| v2.4.36 | 2512 KB | **加 11 个音频模块（957 KB）** |
| 本版 | **1603 KB** | 音频模块移出 |

一次卸载，`.kmod` 这类未压缩 ELF 在包里几乎 1:1 占位，所以是实打实的收益。

同步清掉的五处引用（少一处就是半截引用）：

- `root/usr/share/mt5700/audio-ko.sh`：装载器（probe UAC / 顺序 insmod / 卸载）
- `root/etc/hotplug.d/usb/99-mt5700-audio`：插拔事件入口（目录已空，一并删掉）
- `root/etc/init.d/at-webserver`：post_start 里的兜底装载
- `Makefile`：两条对应的 chmod
- `tests/audio-ko-contract.test.js` 与 `tools/verify-guards.py` 里 4 条变异样例
  （189 项仍全部检出、还原逐字节一致）

语音页文案同步改口径：原文写「插件已随包带模块，检测到 UAC 接口就自动装载」，
现在不能这么承诺了 —— 改成「换带 UAC 的模组是唯一出路，驱动需由固件自带」。

真机影响：无。这些模块从来没在本机加载过（每次 probe 都返回「没有 UAC」），
移出后语音页行为、AT 通道、通话信令全部不变。

## [2.4.47] - 2026-10-26

### Changed — 影响预告再铺两页（服务配置 / 模组升级）

- **服务配置**：三个按钮的破坏力差得很远，但差别只在确认框里才说清。现在按钮组
  下方常驻一条：「重载」只重启进程不断网（约 2 秒）；「重启」与「停止」会让全部
  页面的 AT 功能一起失效，期间读不到状态、短信和信号；停止后要点「重载」才恢复。
- **模组升级**：「开始升级」正上方加一条：烧写期间整机断网、结束后自动重启，
  中途断电可能导致模组无法启动。免责声明弹窗里本来就有，但用户点之前看不出风险。

真机核对：两页均在按钮正上方渲染，文案完整不断行（CSS 未变，仍 5.14.1）。

## [2.4.46] - 2026-10-26

### Fixed — 系统深色模式下整页看不清（真机实测，宿主污染）

插件是固定浅色纸面，但 Argon 的 `dark.css` 会从外部把颜色钉死：

- `.mt5700-page` 继承到 `body{color:#ccc}` —— 白底浅灰字 ≈1.6:1，
  所有没单独指定颜色的文本（表格单元格 / hint / li）全部看不清；
- `select{background-color:#1e1e1e !important}` —— 下拉框深底 + 我们的深色字
  ≈1.2:1，等于看不见（「自动刷新 5 秒」就是这种情况）；
- `.btn,button{border:1px solid #3c3c3c !important}` —— ghost 按钮凭空多一圈灰边。

修法：` .mt5700-page` 显式声明 `color`，并用同等强度的 `!important` 把表单控件
的底色/边框、以及各按钮变体的边框钉回来（全部限定在 `.mt5700-page` 内）。
新增守卫 `tests/host-dark-contract.test.js`（13 项，含三条反向断言）。

### Changed — 影响预告铺到「锁频设置」

保存锁频要先切飞行模式，这一步会立刻断网，而原本文案一个字都没提。
现在按钮下方常驻一条影响预告：「保存时先切飞行模式再重新驻网：当前连接会中断；
锁到本地区没有的频段就再也连不上，得回本页改回「关闭」或换频段。」

CSS 版本 5.14.1（指纹 `1d3737f01acf4b32`）。验证：92 个测试文件全绿、
`verify-guards` 193 项全绿、真机明暗两种系统偏好下六页截图核对。

## [2.4.45] - 2026-10-26

### Changed — 第五次改版：结论先行（结构与配色一起动）

前四次都在调「皮」（颜色、间距、层次）。这次改的是**读法**：原来 12 个页面
都是「一列平权卡片」，进页面先看到二十多个读数，用户得自己拼出结论。

- **主色换深青绿 `#0f766e`，纸面换浅色 `#f2f3f5`**：深色面板嵌在 LuCI 浅色
  内容区里像两块拼图，且琥珀色与本项目三档状态色（绿/黄/红）在色相上挤在一起。
  深青绿做按钮时白字 5.5:1、当文字色在白底上 5.5:1 —— 同一支颜色两头都过 4.5:1
  （原亮青 `#0891b2` 只有 3.3:1）。
- **「信息」色改蓝 `#1d4ed8`**：主色变青绿后，青系再当信息色就和主操作糊成一片。
- 新增四个组件（`Mt5700.verdict / todo / impact`，样式见 mt5700.css 的
  「结论区 / 需要处理 / 影响预告」段）：
  - **结论卡**：25px 一句话结论 + 至多 4 个佐证读数 + 一条四段链路条
    （模组 → SIM → 注册 → 拨号）。判定严格按链路顺序短路，一屏只出一个结论。
  - **需要处理**：有问题才出现（没有就返回 `null`，不留「一切正常」占位），
    每条说清「是什么 + 还能不能上网 + 去哪处理」。
  - **影响预告**：写在会占通道/会断网的按钮**正上方**，说明「多久 · 影响谁 ·
    会不会改配置」。塞进 tooltip 等于没有（触摸屏没有 hover）。
- **网络状态页置顶结论卡**：第一眼是「已连接，可以上网」而不是第一张卡的第一行字；
  链路条让断点自己亮灯；读数降为佐证。
- 「一键排查」按钮下方加影响预告：「点一次约 3 秒，断网时最慢十几秒：期间 AT 通道
  被占用，同页读数会变慢；全程只读，不改任何配置。」—— 时长是真机量出来的
  （正常 3.3 秒；断网时 L3 那几次 ICMP/TCP 会吃满超时）。

验证：全量 node 测试通过；`tools/verify-guards.py` 193 项全绿、还原逐字节一致；
`css-class-audit.py` MISSING 0 / DEAD 0；真机（CDP 同浏览器链路）截图核对
网络状态 / 网络设置 / 短信中心 / eSIM / AT 终端 / 语音通话 六页，CSS 版本 5.14.0。

## [2.4.44] - 2026-10-26

### Changed — 第三次重做：「琥珀深色控制台」（完全不同的设计语言）

前两次改版只换了令牌与间距，视觉语言没变（白卡片 + 细边框 + 左对齐读数 =
通用后台）。这一版换语言，用户要求「完完全全重新设计、更美观、有设计感」：

- **插件整体是一块深色控制台**：`.mt5700-page` 给出底色 `#0d1117`、圆角与内边距，
  整块嵌在 LuCI 浅色内容区里，像一台仪表而不是一堆白卡片。**不再跟随系统明暗** ——
  深色就是设计本身（`prefers-color-scheme` 覆盖全部删除，暗色值并入主规则）。
- **主色琥珀金 `#f5b942`**：与状态绿/黄/红全部拉开色相；做主按钮时用深色字
  （`--mt5700-on-accent`，白字在琥珀上只有 1.9:1），并带一圈极淡光晕作焦点。
- **层次靠三种面 + 一道高光线**：画布 `#0d1117` / 卡片 `#151c26` / 凹陷 `#10161f`；
  卡片顶部 1px 琥珀渐变高光线替代了阴影分层（阴影在深底上只会发闷）。
- **数字是主角**：读数等宽 + 24px + 紧字距，标签 10px 大写灰；输入框、表头、
  日志区都按深底重新调过一档。
- 「信息」色改用青 `#56b6e0` 而不是主色 —— 琥珀在本项目代表「动作/主操作」，
  两者必须能分开（原来 info 直接等于 accent）。

### Fixed — 深色适配清理

- 信号等级 5 档、步骤条、日志三级、终端提示符、进度条、SIM 告警态等
  原本只在 `prefers-color-scheme: dark` 里生效的亮色值，全部并入主规则；
  6 处 `rgba(0,0,0,.0x)` 的「亮色专用淡化」改为淡白提亮。
- `.mt5700-input` 改用等宽字体（读数/APN/ARFCN 录入对齐），背景比卡片深一档。

验证：全量 node 测试通过；`tools/verify-guards.py` 193 项全绿、还原逐字节一致；
真机（CDP 同浏览器链路）截图核对 网络状态 / 网络设置 / 短信中心 / eSIM 四页，
CSS 版本 5.12.0，md5 与本地一致；改动前文件备份 `/root/css-v4-amber.bak`。

## [2.4.43] - 2026-10-26

### Changed — 版式重做（页面壳 / 卡片 / 读数 / 表格 / 控件）

只动视觉层：页面结构、交互、组件 API、AT 行为零改动。`MT5700_CSS_VERSION` 5.11.0。

- **页头压成横条**：标题 28px → 22px，说明并到标题右侧同一行，左侧一道 3px 主色竖线，
  下面一条发丝线收口。页头高度约 90px → 46px，首屏能多露出一整张卡。
- **卡片去「浮岛」**：不再有阴影与 hover 阴影加深（卡片本身不可点，浮起在暗示可点），
  只用 1px 实线 + 12px 圆角；标题前加主色竖条做层级锚点，标题与说明同行。
- **读数改「发丝带」**：原来每个读数是一个带阴影的小盒子，6 个读数就是 6 块浮岛；
  现在整组读数合成一条带 1px 分隔的读数带（`gap:1px` + 底色，任意列数都严丝合缝），
  读数左对齐、20px/600，去掉 hover 上浮。
- **表格收紧**：表头改 11px 中性小标 + 凹陷底，行内距 12px → 9px，一屏多 3~4 行。
- **控件收紧**：按钮固定 34px 高、8px 圆角、去阴影与位移；输入框 34px；徽章改 6px 小方角。
- **主色换靛蓝 `#4f46e5`**（原 `#2563eb` 与「信息蓝」分不开），30 处硬编码 tint 同步替换。
- 仪表 / 速率格 / EID 身份块改为卡片内的「凹陷井」；eSIM 行去阴影、终端去阴影；
  清理 reduced-motion 里已无对象的 hover 位移规则。

### Fixed — Argon 把裸 `h2`/`h3` 画成卡片（真机实测）

Argon 的 cascade.css 对**裸标题标签**生效：

```css
h2 { padding:1rem 1.25rem; background:var(--white); border-radius:.25rem; box-shadow:0 4px 8px … }
h3 { padding:.8755rem 1.25rem; display:block; width:100%; background:var(--white); … }
```

我们的页面标题是 h2、卡片标题是 h3，于是：页面标题外面真的多出一个白色方块
（实测 104×56、圆角 4px、带阴影），卡片标题被 `width:100%` 撑满整行、副标题被挤到
第二行（实测标题宽 1196px = 整行宽，卡头白占 88px 高）。两处都不会报错，只会「看着不对」。

修法：在 `.mt5700-page-title` / `.mt5700-card-title` 里清掉宿主的 background / box-shadow /
border-radius / padding，并用 `width: fit-content` 收回 h3 的宽度。
新增守卫 `tests/host-heading-reset-contract.test.js`（15 项，含反向验证）。

## [2.4.42] - 2026-10-26

### Changed — 菜单信息架构重组（12 项平铺 → 1 个总览 + 4 组）

12 个页面原来平铺在同一层，找「短信设置」得在 12 行里数。重组为：

- **网络状态**（总览，仍是点击顶级入口后的落地页）
- **网络**：网络设置、拨号设置
- **模组**：模组设置、模组升级、eSIM 管理
- **通信**：语音通话、短信中心、短信设置
- **工具**：AT 调试终端、运行日志、服务配置

**页面内容、交互与 AT 行为零改动**，只改菜单树与路径：

| 旧路径 | 新路径 |
|---|---|
| `/admin/modem/5g/settings` | `/admin/modem/5g/network/settings` |
| `/admin/modem/5g/dial` | `/admin/modem/5g/network/dial` |
| `/admin/modem/5g/modem-settings` | `/admin/modem/5g/modem/settings` |
| `/admin/modem/5g/upgrade` | `/admin/modem/5g/modem/upgrade` |
| `/admin/modem/5g/esim` | `/admin/modem/5g/modem/esim` |
| `/admin/modem/5g/voice-call` | `/admin/modem/5g/comm/voice` |
| `/admin/modem/5g/sms` | `/admin/modem/5g/comm/sms` |
| `/admin/modem/5g/sms-settings` | `/admin/modem/5g/comm/sms-settings` |
| `/admin/modem/5g/terminal` | `/admin/modem/5g/tools/terminal` |
| `/admin/modem/5g/logs` | `/admin/modem/5g/tools/logs` |
| `/admin/modem/5g/config` | `/admin/modem/5g/tools/config` |

★ 旧书签会 404，属预期。

新增 `tests/menu-ia-contract.test.js`（23 项）：菜单 JSON 可解析、每个 view 的
path 必须命中真实视图文件、12 个页面一个不少、分组不能是空壳、同级 order 不重复
—— 菜单拼错一个字母不会报错，只会让那一页从菜单里消失，这条守卫就是防这个。

真机验证：12 条新路径全部 `HTTP 200`，旧路径 `404`；登录页与后台无 500。

## [2.4.41] - 2026-10-26

### Changed — 全局视觉改版（去玻璃化 + 圆角/阴影收敛）

只动视觉层：页面结构、交互、组件 API 与 AT 行为**零改动**。
`MT5700_CSS_VERSION` 5.9.1 → 5.10.0（缓存击穿器，浏览器会自动取新样式）。

- **去玻璃、去半透明卡片**：卡片由 `rgba(255,255,255,.82)` + `backdrop-filter`
  改为**纯白实底 + 1px 实边**（暗色 `#171a21` + `#262b36`）。原来在 Argon 这类
  自带背景图的主题下会透出底色、发灰发糊；改后层次清楚，也省掉一层合成开销。
- **阴影三层 → 两层**，去掉白色内描边（浅底上会显脏），悬停只加深阴影、不位移。
- **主色加深** `#3b82f6 → #2563eb`（白字对比度更好），18 处硬编码的 accent tint
  （焦点环 / 选中底色 / 发光）同步替换。
- **圆角收敛为三档**：控件 10 / 卡片 14 / 胶囊 999（原 12/16/20）。
- **表格数字等宽**：`font-variant-numeric: tabular-nums`，5s 刷新时列宽不再左右抖。
- `tests/css-cachebust-contract.test.js` 同步更新指纹与变更日志。

## [2.4.40] - 2026-10-26

### Added — 自愈（只修自家组件，绝不碰网络）

意外发生时不再只能靠人工 SSH。分三层：

- **SIM 状态卡**：读失败与「模组答了但内容不认识」分开显示
  （`读取失败` vs `未知`，红线 23 的同一条纪律），读失败先 600ms 后补一次；
  连续 **3 次**（≈45s）仍失败且距上次自愈超 5 分钟，才调一次自愈。
- **手动自愈** `mt5700.selfheal`（ubus）：由前端触发，重启 AT 服务，10 分钟冷却。
- **自动巡检** cron 每 5 分钟跑 `/etc/init.d/at-webserver selfheal --auto`：
  要求**连续 2 次**（≈10 分钟）探测失败才动手——eSIM 写卡、短信发送这类正常
  长操作动辄占住串口十几秒，单次失败不能当故障。

边界（写进 `tests/selfheal-contract.test.js`，改坏即判红）：

- 只允许 `at-webserver restart` 与 `rpcd restart`，**禁止** wifi / wireless /
  network / ifup / firewall 任何动作（这个插件 2026-09-20 删掉过看门狗，
  原因正是「自动动作本身也是断网源」）。
- ubus 对象缺失（rpcd 没加载 ucode 插件）只由 cron 处理：重启 rpcd 会踢掉所有
  LuCI 登录，且经 rpcd 调用时重启 rpcd ＝ 让处理本次请求的进程自杀。
- `uci at-webserver.config.enabled=0`（用户主动停用）时一律不动手。
- 冷却：动作 10 分钟、rpcd 30 分钟；状态放 `/tmp`，重启即清；每个动作写 logger。

#### 修掉的真机坑

`selfheal` 经 ubus 被调用时自己就跑在 rpcd 里，若再做 `ubus call`，单线程的
rpcd 会**自己等自己** → 必然超时 → 把「一切正常」误判成故障并白重启一次
（实测：CLI 报「一切正常」、ubus 报「已重启 AT 服务」）。因此新增
`--from-ubus` 模式：跳过探测，按「调用方已判定需要修复」处理。

## [2.4.39] - 2026-10-24

### Fixed — 定时锁频「只有一个开关、看不到编排配置」

关闭定时锁频时整张编排表单被换成一行提示，用户看到的就只有「一个开关」，根本
不知道还有时段与锁频可配 —— 违反「藏起来的控件等于没有」。

另有一处独立成因：表单显隐还依赖后端 `AT+SCHED?` 的 `enabled`，而总开关写的是
UCI `schedule_enabled`；后端要等 procd 重载（`procd_add_reload_trigger`）才读到，
两者不同步的窗口里表单会凭空消失（真机取证：`AT+SCHED?` 返回 `"enabled":false`、
UCI 为 `0` 时页面只剩开关）。

- **表单常驻**：开关只控制「能不能改」。关闭时把控件与「保存编排」一起灰掉
  （原生 `disabled`），并在表单顶部说明原因，配置照样可见。
- **草稿构建不再要求 `cfg.enabled`**：后端返回的 `check_interval` / 夜间 / 日间
  字段即使 `enabled:false` 也是可用的，正是要改的内容。
- 切换开关**立即**灰/亮表单，不等 `uci commit` 与后端重载；写入失败时把视觉状态
  一并回滚，避免界面与真实状态不一致。

## [2.4.38] - 2026-10-24

### Changed — 语音通话页 CLCC 兜底轮询自适应（空闲 5s / 通话中 2s）

通话状态的主通道是 URC（`^CCALLSTATE` / `^CEND` → `urcKick` 立即读一次 CLCC），
原先固定 2s 的轮询只是「URC 丢了 / 老后端没转发」时的兜底 —— 空闲时每页仍打
30 条/分钟，白占独占串口（串口只有一条，rpcd 还是单线程）。

- 空闲 **5s**（12 条/分钟），通话中仍 **2s**：接通/挂断的回显不能迟滞，
  此时 CLCC 是计时与状态的唯一现算来源。
- 改用自排 `setTimeout` + `clccTick()` —— `Mt5700.interval` 是固定周期，改不了
  「下一拍」。句柄与停止标志在 `_onDispose` 里清；页面脱离文档时自停
  （与 `kickTimer` 同一处置）。
- 同步 `tests/voice-call-contract.test.js` 的三条断言（原钉「固定 2s」与
  `if (st.busy) { return; }`，后者在自排链里会直接掐死定时器）。

## [2.4.37] - 2026-10-24

### Changed — 定时锁频面板合并为单卡（修「编排配置没内容」）

「定时锁频 · 运行状态」与「定时锁频 · 编排配置」两张卡合为一张「定时锁频」：
启用后**直接渲染编排表单**，不再需要先点「展开配置」。原先未启用时该卡只有一行
提示、启用后也只有一个按钮，读起来就是「这块是空的」—— 用户反馈的正是这个。
同时去掉「收起」按钮。

- **状态与表单的渲染路径拆开**：轮询只刷状态行（`renderStatusLine`），表单只在
  进入页面 / 保存后重载时重建（`renderForm`）。旧实现靠 `if (expanded) return`
  避免轮询冲掉草稿，代价是「一开始编辑，状态行就停止更新」。
- **状态轮询 15s → 60s，且后台标签页不轮询**：这里刷新的是「当前时段 / 下次切换 /
  已切换次数」，全部按小时甚至按天变化 —— 15s 一轮纯属白占独占串口
  （每进一次本页 4 条/分钟 → 1 条/分钟）。

## [2.4.36] - 2026-10-24

### Fixed — 缺少 `timeout` 的固件上整条 AT 链路全哑（界面表现为 SIM「未知」）

真机 Mwrt `@Manper-5.1.1150-24`（busybox 1.36.1）**既没有 `timeout` applet，
也没有 `coreutils-timeout` 包**。而插件有 8 处 shell 调用写成 `timeout <秒> <命令>`
（ucode 6 处 + `diag-probe.sh` 2 处）—— 缺这个程序时命令根本不执行，popen 读到空：

- `mt5700.at` 对**任何**指令都回「Rust 后端无应答（已限时 45 秒）」，且**瞬间**返回
  （实测 20/20，每次 0ms）→ 界面表现为 SIM「未知」、状态页全空；
- 断网诊断、出口 IP、DoH、VoWiFi epdg 解析、OTA 下载同样全哑；
- `diag-probe.sh` 内两条 DNS 探测恒失败（`dns_resolve_ok` 恒 0），
  看起来像「DNS 坏了」，其实只是缺程序。

Rust 后端与串口本身完全正常（绕过限时器直连 `nc 127.0.0.1 8765` 可拿到
`+CPIN: READY`），极易误判成模组故障。

#### 修法

- 新增随包限时器 `/usr/share/mt5700/to`：`timeout` 的等价实现（后台执行 +
  到期 `kill -9` + 退出码透传），并处理两个真机坑：
  - **ash 会把异步列表的 stdin 强制接 /dev/null** ⇒ 先 `exec 3<&0`，后台命令
    再 `<&3` 读回（否则 `nc` 收不到请求体，RPC 照旧全哑；`<&0` 与 `set -m` 都不行）；
  - 用标记文件防 pid 复用误杀（不直接 kill 等待者）。
- ucode 新增 `timeoutBin()`：`command -v timeout` 有就用系统 timeout，
  没有就用随包脚本；6 处调用全部经它解析，不再出现裸 `'timeout ` 前缀。
- `diag-probe.sh` 内新增 `to()` 兜底，两处 DNS 探测改走它。
- Makefile 为替代脚本装 `0755`。

#### 守卫

- 新增 `tests/portable-timeout-contract.test.js`（29 项，含**真跑**行为断言：
  正常结束透传 stdout / 退出码、超时确实中止、**stdin 透传**、无标记残留）。
- `tests/line-endings-contract.test.js` 补扫 `root/` 下**无扩展名**脚本
  （原来整类被漏掉 —— 新脚本正是这样带着 CRLF 装进设备，ash 报
  `unexpected end of file (expecting "then")`，而本地测试全绿），并加自检。
- 同步 3 处既有守卫的限时器写法（rpc-command-budget / ui-contract / diag-contract）。

#### 真机验证（`192.168.88.1`）

`AT^SIMSQ?` → `^SIMSQ: 1,12`、`AT+CPIN?` → `+CPIN: READY`、`AT+CSQ` → `+CSQ: 28,99`；
并经 LuCI 的 HTTP `/ubus`（与浏览器同一条链路）确认前端收到
`{"data":"^SIMSQ: 1,12\r\nOK","success":true}`。

## [2.4.35] - 2026-10-22

### Rust 后端全面优化（clippy 全清 + 三处语义修正）

以 `cargo clippy --all-targets` 为机械依据（此前本仓从未跑过 lint），17 条警告全部
处理，并借机修掉三处**语义**问题。所有改动等价或更正确，无对外协议/接口变化。

#### 语义修正

- **SINR 换算不再把 NaN 伪装成 30.0**（跨语言漂移）：raw 来自 `parseInt(p[8])`，
  `parseInt('nan')` = NaN，路径真实可达。JS 的 `Math.min/max` **传播** NaN，前端
  本来就对；而 Rust 的 `f64::min/max` **不传播**（返回非 NaN 那一侧）→ 后端给
  30.0「信号最好」、前端给 NaN，**同一读数两个值**。改用 `clamp` 与前端同口径，
  NaN 原样透传（JSON 侧序列化为 null，前端显示「读不到」，红线 23）。新增
  Rust 单测 + 前端契约断言各一条。
- **打断扫频前校验命令身份**（B-3）：`interrupt()` 原先只验「有 pending」，扫频刚
  结束而下一条命令已装入的窗口内，"abcd" 会打进**无关命令**的数据流致其失败。
  现在按 pending.echo 前缀（`AT^CELLSCAN`，大小写不敏感）校验，不匹配则无害失败。
- **pending 槽加 Drop 守卫**（B-05 通用化）：`send_command_inner` 的 future 被外层
  timeout 整体 drop 时，守卫清空 pending，杜绝「旧命令迟到的结束码被算进下一条
  命令」的 AT 应答错位。此前只靠「调用方预算对齐」这一约定防它，新增调用方
  一旦漏算就会错位。守卫 drop 顺序在 cmd_mu 之后声明（逆序 drop 时仍持锁），
  不会误清下一条命令的 pending。

#### clippy 17 条（惯用法/可读性，逐条复核 diff 后采纳）

`map_or(false, ..)` → `is_some_and`（3）、`(x + n - 1) / n` → `div_ceil`（3，PDU
解码的整数除法逐个核对等价）、`write(true)` 冗余（2）、`replace(|c| c==''||…)`
→ 字符数组（2）、连续 `replace` 合并（1）、`&cmd` 多余借用（1）、`if` 折叠进
`match`（1）、手剥前缀 → `strip_prefix`（1）、冗余闭包（1）、`min/max` 链 →
`clamp`（1）。

#### 同类问题全局排查

- Rust 侧其余 `min/max` 均为无符号整数运算，不存在 NaN 语义问题；
- 数组/字符串索引面：`cut(...)?[0]` 由 `cut` 的长度检查保证、`msgs[0]` 前有
  `is_empty` 早退 —— 无新增 panic 面；
- 非测试代码的 `unwrap/expect`：**0 处**（复查确认）。

#### 验证

- `cargo clippy --all-targets`：**0 警告**（含测试代码）；
- `cargo check --all-targets` 通过；
- 新增 Rust 单测 2 条（`convert_sinr` 的 NaN 语义、`echo_matches_prefix` 的边界）；
  **本机跑不了 `cargo test`**（该 crate 的测试目标是 Linux/musl，本机 Windows 缺
  Windows 专用依赖的 rlib，链接失败）—— 由 CI 跑；
- JS 契约测试全绿（新增 SINR NaN 断言）。

## [2.4.34] - 2026-10-22

### 修复：2.4.33 在本机 ucode 上不可用（重要，请从 2.4.33 直接升到本版）

**2.4.33 的 ucode 层在 ZJJCKA 25.12.5 固件上完全不可用**：安装后所有 mt5700.* 调用报
`-32000: Object not found`（日志/短信/状态/通话等全部页面），原因与处置如下。

**根因**：2.4.33 给 jsonParse 加的 4 处 `throw` 语句 —— **本固件的 ucode 不支持
throw 语句**（`try { throw "x"; }` 直接 `Syntax error`，真机实测）。ucode 是整个
文件编译的，一处 throw = 整个 mt5700.uc 编译失败 = rpcd 不注册 `mt5700` 对象。
当时误把既有注释里「解析失败是抛异常」当成了 throw 可用的证据 —— 那是错误注释，
不是实测。

**处置**：解析失败语义改用「**闭包内 fail 标志 + 返回 null**」（并发安全，不依赖
throw/模块级全局）。`rpcCall` 入口对 null 显式报「解析后端应答失败」，截断应答
不再按成功透传（B08 的语义完整保留）。

**真机取证与恢复**（2026-10-22 14:28–15:00）：

| 步骤 | 结果 |
|---|---|
| 设备 `md5sum` mt5700.uc | 与 2.4.33 逐字节一致（文件完整） |
| `ucode mt5700.uc` 直接编译 | `Syntax error: Unexpected token`，落在线 96 = 第一处 throw |
| 设备最小实验 `try { throw "x"; }` | `Syntax error` —— throw 不支持实锤 |
| 换 2.4.32 版 / 300 字节 mini 对象 / 改对象名 / 去扩展名 | 全部「签名注册可见、分发 Not found」（与内容无关的假象，SSH `ubus call` CLI 在本固件不可作判据） |
| 修复版部署 + `rpcd restart` | **session 链路 `mt5700.logs`/`mt5700.at` 全部恢复** |

**新守卫** `tests/ucode-syntax-guard.test.js`：mt5700.uc 无 throw 语句（去注释后
检查）+ fail 标志语义 + rpcCall 判空，共 3 项；故意加 throw 已验证精确报红。

### 升级说明

从 2.4.33 升级本版后 LuCI **需要重新登录**（rpcd 重启会清 session）。2.4.33 的
其余修复（审计 24 项）不受影响，本版只替换 ucode 文件的 jsonParse 实现与注释。

## [2.4.33] - 2026-10-22

### 全仓库深度审计修复（四批次，24 项）

按「逻辑/性能/可读性/安全/可维护性」五维度做全仓审计（Rust 14 文件 / ucode 3592 行 / 前端 2 万行 / shell 与打包全量），问题清单见会话审计报告。无阻断级问题；本轮修复高危与中危全部 15 项中的 13 项 + 低危 9 项，其余进不改清单。

#### ucode 层

- **VoWiFi 评估链设总预算**（高危）：后端挂死/DNS 悬置时最坏 ~15 分钟冻结整个 LuCI（rpcd 单线程）。入口设绝对截止时刻（评估 30s / 开关后复评 20s），沿调用链传参，超窗降级为 unknown —— 那本来就是四态语义的合法结论。
- **callLineInfo 不再把通道故障吞成 mute:null**（高危，红线 23）：`m == null` 是死分支（rpcCall 永不返 null），通道忙时 CMUT 错误被静默吞掉。改为 `!m.success` 整体报错。
- **jsonParse 完整性校验**：被 timeout 掐断的半截应答此前会按「成功」解析出半截 data；现在未闭合/带尾随垃圾一律抛异常（8 个调用点全部已有 try/catch，原注释「解析失败是抛异常」由此真正成立）。
- **netrate 单侧计数器读不到回 null**（原来补 0 → 假速率尖峰），前端跳拍重置基准。
- **日志落盘临时文件改随机名**（smslog/calllog 固定 `.tmp` 并发互相覆盖 → 丢更新），失败时顺手清理。
- **RPC 临时文件收权 0600**（内容含 auth_key），`AT+CIMI` 移出静态缓存档（IMSI 随卡变，与 P03 的 ICCID 同判据），`AT+CSQ` 与三条「写形式的查询」（`AT^MCS`/`AT^EONS`/`AT^DSAMBR`，手册 13.22/13.3/16.17）补进只读名单 —— 预热批次不再被拒、30s 慢档不再每轮清全片状态缓存。
- readCounter 的 fd 在 read 抛异常时也会关闭。

#### 前端

- NON_QUESTION_READS 同步补三条带参查询，且 `isRetryableRead` 支持**前缀命中**（名单存命令头、实际调用带参数）。
- 载波表强度列改用 `Mt5700.rsrpBar`（原先自算公式是「唯一真源在 Parse」纪律点名的第二份实现）。
- 幻影未读修复：`parseMessageTime` 加 strict 参数（判定侧解析失败得 null 而不是回落「当前时刻」——回落值每次都领先水位线，会话永远消不掉红点）；显示侧行为不变。
- VoNR 下发失败回读真值对齐界面（原先只弹错，界面停在未生效的值）。
- 删 `refreshing`/`slowRefreshing` 两个只写不读的死变量；esim 手动模式 label 改两步建（全局 E 多参形态与本仓「只挂第 3 参」约定相反）；长短信发送切页后不再弹「页面已离开」的幽灵 toast；邻区自动刷新在后台标签页不再每 15s 打 3 条 AT；进网络设置页少一次空表重建；服务页刷新时重查二进制事实（原先停在 load() 快照）。

#### shell / 打包

- **init.d post_start 后台任务可被 stop 追杀**（高危）：start 后 ~90s 内执行 stop，后台任务会把防火墙规则重新加回 —— PID 落文件，stop 先 kill 再清。
- uci-defaults 在线补装加 60s 限时（feed 不可达时不再拖住包管理器数分钟）；`/etc/config/at-webserver` 统一 `chmod 0600`（含 auth_key 与 webhook）；后台启动加 120s stamp 防重入。
- hotplug 续约脚本：防抖改 mkdir 原子抢占（原「读-改-写」竞态会让两路续约重叠，锁超龄自愈）；设备名从 UCI 取（定制机型不再静默失效）。
- audio-ko.sh 的错误文件按进程区分（init.d 与 usb hotplug 并发时不再张冠李戴）。
- po/pot 的包标题 msgid 与 `LUCI_TITLE` 对齐（原先翻译永不命中），pot 的 msgstr 清空。

#### Rust 后端（cargo check 通过；行为验证需 CI 出包 + 刷机）

- **扫频 done/error 事件的 lines 按帧预算截断**（高危）：数百行 ≈ 数十 KB 单帧会吃穿 events 预算堵住游标；保留真实 count 并附 truncated 标志。
- **短信任务外层预算对齐内层最坏耗时**（高危）：16s < 17.1s 的缺口会让 future 被整体 drop，cmd_mu 提前释放 + pending 残留 → AT 应答错位。现 20.1s，并在 send_command 处写明 drop-safety 约定（WRITE_TIMEOUT/COMMAND_GAP 转 pub）。
- 长短信拼装改为「1..=total 每段都在」才组装（畸形分段不再拼出缺段正文）；分段缓存 key 加入 total（同号同 ref 不同分段数不互混）。
- accept 持续失败加指数退避（100ms→1.6s，原来紧循环刷日志）；退出路径的通知 flush 改为带 10s 上限的在位等待（原来 spawn 后立刻 return，最后一批通知随 runtime 关闭丢失）；通知日志文件收权 0600；`LOG_BUFFER_CAP`/`DEFAULT_SCAN_TIMEOUT` 单源化（原来 1200/180 各存两份字面量）。

#### 测试

- 名单契约扩展：BARE_READS 11 条逐个点名、NON_QUESTION_READS 12 条、`AT+CIMI` 不得回静态档（B10 反向验证：故意加回 → 精确报红）。
- 被钉住的旧形态锚点随行为迁移：渲染链复位断言改锚 `fastRunning`/`slowRunning`（死变量已删）、logs limit 上限改锚 `LOG_BUFFER_CAP`、vowifi 三处断言改锚预算后形态。
- verify-guards 192 条全部检出、还原逐字节一致；run-all 全绿。

### 未修复（决策记录）

- AT 应答错位的**通用** drop-safety（pending 的 Drop 守卫）：触发路径已由预算对齐消解，通用守卫动核心命令通路且 try_lock 残留引入新风险，待真机验证后再评估。
- `vowifi_set` 缺参 `enable` 是否被 rpcd 回填默认值 0：本机无法验证，需真机实测。
- conffiles 声明：apk 对 /etc 的保护行为需真机验证后再定。
- i18n 全量 `_()` 包裹：单语产品决策，非缺陷。


### 修复：随包内核模块让包在任何平台都编不过

CI 报：

```
Package luci-app-mt5700 is missing dependencies for the following libraries:
usbcore.ko
```

根因不在依赖声明（`LUCI_DEPENDS` 一直是空的），而在 OpenWrt 的打包期扫描：
`scripts/gen-dependencies.sh` 会对包内**每一个 `-name '*.ko'`** 文件
`objcopy -j .modinfo` 取出 `depends=`，展开成「需要哪些模块」，再与包自身
`.provides`（同一套 `*.ko` 规则收的文件名）做差集，差集非空即 `Error 1`。

本包随带的 11 个 ALSA 模块里，`snd-usb-audio` 与 `snd-usbmidi-lib` 的
`depends` 含 `usbcore`。而 `usbcore` 在 OpenWrt 各平台都是**内建**的、
根本不存在 `usbcore.ko` 可供 ⇒ 差集恒为 `{usbcore.ko}`，与目标平台无关，
`ipq50xx` / `MT7987` 一样会炸。

修法：11 个模块后缀由 `.ko` 改为 `.kmod`。两处 `*.ko` glob 同时不再命中，
扫描需求与 provides 一起消失；`insmod` 认的是 ELF 内容而非文件名，
运行期行为一字未变。`.gitattributes` 同步补 `*.kmod binary`（否则首行
`* text=auto eol=lf` 会改坏 ELF）。

### 新增守卫

- `root/` 下出现任何 `*.ko` 即红 —— 这是本次故障的根因，不靠人记
- 装载器取文件的后缀必须与磁盘一致（否则功能静默失效：找不到文件 → `return 4`）

两条都做过「故意违反」验证：塞一个 `snd.ko` → 精确报出路径；把装载器改回
`.ko` → 精确命中。第二条已固化进变异表（190 条），第一条属文件系统约束、
无法用文本变异表达，只保留手工验证。

## [2.4.31] - 2026-10-22

### 变更：界面不再显示取证报告

用户口径：「功能说明太多，看起来不简练」。语音页那条提示原有 208 字，讲 USB 六个接口里没有 Audio Class、手册 244 条命令、要不要重编固件；VoWiFi 卡片把 DNS 通配污染与 `mnc999` 阴性对照的推理也写在页面上 —— 那些是**开发时的判断过程**，不是用户此刻要的信息。

现在界面上只留「能做什么 / 不能做什么 / 怎么办」，依据移入 README §已知限制：

| 位置 | 原 | 现 |
|:--|--:|--:|
| 语音页能力提示 | 208 字 | 60 字 |
| VoWiFi 评估说明 | 111 字 | 52 字 |
| VoWiFi 开关说明 | 61 字 | 47 字 |
| ePDG 四态解释 | 最长 96 字 | 各 ≤ 40 字 |
| 日志三档说明 | 42 / 44 字 | 38 / 32 字 |
| eSIM「换卡换出口 IP」副标题 | 31 字 | 26 字 |

**操作确认、错误处置、字段含义一律不动** —— 那是用户当下做判断的依据。

### 变更：定时锁频并入网络设置

不再单独占菜单项，改为网络设置页「锁频设置」之后的一块。逻辑零改动 —— 抽成 `at-webserver/schedule_panel.js`，宿主页在 dispose 时调 `SchedulePanel.dispose()`，轮询由宿主页负责清理。

### 新增：UI 文案守卫 `tests/ui-copy-contract.test.js`

10 项断言，抓**内部取证语言**出现在用户文案里：带日期的实测标注、手册条数、`NXDOMAIN`、`mnc999`、指向开发记忆的引用；外加单条中文字符串 ≤ 100 字。只查字符串字面量，注释不受限（注释本来就该写这些）。

写这条守卫时先踩了自己的坑：第一版状态机不认识正则字面量，把 `/…/` 里的引号当字符串起点，整段代码被当文案 —— 8 处误报 + 62 处假超长。改成分两步（先剥注释，再逐行抽引号串、只保留含中文的）后归零。故意塞一条 `实测（2026-10-22）` 验证过它会红。

### 文档

README 新增 **§已知限制**（通话无声音的三层证据、VoWiFi 评估≠能通话、eSIM 无备份、`AT+CLIP?` 不可轮询）；页面表补上「语音通话」、把「定时锁频」并进「网络设置」。

## [2.4.30] - 2026-10-22

### 新增：通话状态改用 URC 事件驱动

此前语音页头部写着「呼叫生命周期的私有 URC 受 `AT^CURC` 控制，实测一个都不报，
所以只用 `AT+CLCC` 轮询」。**这个结论是错的**：它们是**呼叫期** URC，空闲时
自然安静——当时没有通话可报而已。

2026-10-22 真机拨 10086 全程**一条开启命令都没发**，事件链完整到达：

```
ATD10086;  →  ^CCALLSTATE: 1,0,1 + ^ORIG: 1,0 + OK     ← 同一条响应体内
  t+2s     →  ^CCALLSTATE: 1,1,1                       Proceeding
  t+6s     →  ^CCALLSTATE: 1,2,1 + ^CONF: 1            对方振铃
  t+7s     →  ^CONN: 1,0 + ^CCALLSTATE: 1,3,1          ★ 接通
  t+12s    →  +CLCC: 1,0,0,...                         ★ 轮询晚 5 秒
AT+CHUP    →  OK
  t+1s     →  ^CEND: 1,25,104,0 + ^CCALLSTATE: 1,4,1   结束，通话 25 秒
```

于是：

- **`rpc.js`** 新增 `parseCcallState` / `parseCend`，在 `parseRawData` 里认领
  五条通话 URC（`^CCALLSTATE` / `^ORIG` / `^CONF` / `^CONN` / `^CEND`），产出
  `{type:'CALL', event, ...}`。数值字段一律归一到 `number | null`，不用 `NaN`。
- **`voice_call.js`** 消费它们，但**只当触发器**：URC 到达即立刻读一次 CLCC，
  状态值仍由 CLCC 现算。这是有意的边界——`^CCALLSTATE` 的 `<state>`
  （0 originate / 1 proceeding / 2 alerting / 3 connected / 4 released /
  5 incoming / 6 waiting / 7 hold / 8 retrieve）与 `+CLCC` 的 `<stat>`
  （0 active / 1 held / 2 dialing / 3 alerting / 4 incoming / 5 waiting）
  **是两套编号**，同一个「接通」一个是 3、一个是 0，混用会整体错位且不报错。
  CLCC 还是唯一带方向、号码、呼叫 ID 的来源。
- **事件轮询压到 500ms（仅本页）**：`^CCALLSTATE` 写进事件总线是即时的，但前端
  要等下一次 `pollEvents`（默认 1500ms）才看见——不压的话相对原来 2s 的 CLCC
  轮询只快 0.4 秒，等于白做。`pollInterval` 是 `AtWs.client` 共享单例的属性，
  离开页面立刻还原（否则之后每个页面都按 500ms 拉 events，白挤 rpcd 单线程）。
- **通话时长以 `^CEND` 为准**：第二个字段就是秒数（实测 25）。前端 `Date.now()`
  差值降级为兜底——切后台、页面重载都不再丢时长。
- **语音域显示**：`^CCALLSTATE` 第三字段（0 CS / 1 IMS / 2 3GPP2 / 3 无域）挂在
  状态文案后面，不新开一格（状态卡已有 5 格，红线 41）。实测全程为 1，正好解释
  了「`+CREG: 0,0` 却能拨通——语音走 IMS，不依赖 CS 注册」。
- **`atclient.rs`**：把五条前缀登记进 `is_passthrough_urc`。这一处必须改——
  `is_exclusive_urc` 管「要不要 emit」，而 broadcast 位取的是 `is_passthrough_urc`；
  只加前者，通话期间每 2 秒一次的 `AT+CLCC` 命令等待窗口里，URC 会被并进应答体，
  前端一条都收不到，而本地测试仍全绿。

### 新增：ALSA 内核模块随包分发，「换模组即出声」

本机声音做不到（见下），但**换成带 USB Audio Class 的模组**这件事，软件侧
已经被实测证明是零成本的：厂商固件 239 个 `.ko` 的 vermagic 全部是
`6.12.112 SMP mod_unload aarch64`，与本机内核字节一致；11 个音频模块逐个
`insmod` 全部 `rc=0`，dmesg 出现

```
usbcore: registered new interface driver snd-usb-audio
```

`/proc/asound/cards` 仍是 `no soundcards`（正常：没有 UAC 硬件）。

随包内容（`root/usr/share/mt5700/audio/6.12.112/`，953KB，附 `SHA256SUMS`
与 `MANIFEST.md` 说明来源与 GPL-2.0 许可）：

```
soundcore → snd → snd-timer → snd-pcm → snd-hwdep → snd-seq-device
→ snd-rawmidi → snd-usbmidi-lib → mc → input-core → snd-usb-audio
```

- `audio-ko.sh`：`probe` / `load` / `unload` / `status`。**先判 UAC 再进装载
  循环**——当前这台机器上 `load` 直接返回 3，一个模块都不装（零开销、零内存）。
  装载失败即中止并记录原因，不「跳过去继续装半套」（半套音频栈不会报错，只会让
  `/proc/asound` 空着）。
- 模块名做连字符→下划线转换（lsmod 里叫 `snd_usb_audio`），否则 `is_loaded`
  永远不命中，每次 load 都重复 insmod。
- 双入口：`etc/hotplug.d/usb/99-mt5700-audio`（插入即装）+ `init.d` 开机兜底。
- `.gitattributes` 新增 `*.ko binary`——否则首行 `* text=auto eol=lf` 会把 ELF
  当文本做换行转换，模块无法 insmod，而 git 侧看不出异常。

### 修正：语音页「听不到声音」的说明

旧文案推荐「在路由器上跑 SIP 软电话（Asterisk 已安装）」，而实测证明那条路
打不了 10086（没有 PSTN 出口），属于误导。新文案指向真实断点：MT5700M-CN 的
USB 六个接口里没有任何 Audio Class，手册 244 条命令也没有音频数据通道。

### 守卫

- `voice-call-contract`：115 → 126 项。跨层断言把「后端 `is_passthrough_urc`
  登记了这五条」与「前端认领了这五条」钉在一起（红线 85：「后端返回正确」
  ≠「页面拿到」）。
- 新增 `audio-ko-contract`：21 项。守文件集与装载清单一一对应、拓扑序、无 UAC
  时零动作、模块名转换、`.gitattributes` 的 binary 声明、`SHA256SUMS` 格式。
- `tools/verify-guards.py`：180 → 190 条变异，新增 `rustat` / `audioko` /
  `audiosum` 三个目标键。
- ★ 本次变异验证逮到两处**恒绿断言**：两条新断言写成
  `(function () { ... })` 而漏了调用括号 `()`，传进去的是函数对象（truthy），
  无论源码怎么改都通过。已修正为 `})())`。

## [2.4.29] - 2026-10-21

### 移除：旧 `.at-*` 命名空间整条下线

上一个版本把「永远匹配不到元素」的规则删掉了，但**还在用的** 24 个 `.at-*`
类仍在，于是同一份样式表里长期并存两套命名空间与两套配色：

| | 旧 `.at-*` | 现役 `.mt5700-*` |
|---|---|---|
| 主色 | `#1668dc` | `--mt5700-accent` `#3b82f6` |
| 边框 | `#ccc` / `#d0d5dd` | `--mt5700-border-subtle` |
| 圆角 | 6px | 8 / 12 / 16 / 20px |

迁移到一套之后：

- **按钮** `ui.js` 的 `api.button` 直接转交 `Mt5700.button`，全站只剩
  `.mt5700-btn` + 变体。原先把调用方传的 `cbi-button-*` **原样留在元素上**，
  同一个按钮同时被本文件与 LuCI 主题命中，外观取决于两份样式表的层叠顺序
  —— 换主题就变样，Argon 下两边 padding/圆角互相打架。
- **弹窗** `at-modal*` → `mt5700-modal*`（复用已有的 mask/title/body/footer，
  `at-modal-actions` 由 `mt5700-modal-footer` 取代）。
- **字段** `at-field*` → `mt5700-field*`；输入控件改用 `.mt5700-input`，
  不再叠主题的 `cbi-input-*`。label/hint 复用已有 `.mt5700-label` / `.mt5700-hint`。
- **状态卡** `at-status-*` → `mt5700-status-*`，局部变量 `--at-*` → `--mt5700-status-*`。
- **自动刷新** `at-autorefresh*` → `mt5700-autorefresh*`，两处内联 `style.width` 收进类。

### 美化：状态卡不再是自成一套的色板

`.mt5700-status-card` 原先自带 `--at-bg` / `--at-border` / `--at-text` 与一组
状态色（`#35b879` 绿、`#e7a63b` 琥珀、`#e45d5d` 红、`#8a938e` 灰）。同一个
「成功」在徽章/仪表里是 `#10b981`，在状态卡里是 `#35b879`，并排看是两个绿；
底色 0.62 alpha 与其它卡片的 0.82 也不同。现在只保留「状态色」和「次级灰度」
两个专属变量，其余全部接回全局令牌；四态颜色改指
`--mt5700-success` / `--mt5700-warning` / `--mt5700-danger` / `--mt5700-text-muted`。

### 性能

- `transition: all` 清零（2 处：`.mt5700-btn` / `.mt5700-step`）—— 改成显式
  属性表。`all` 会让引擎为每个属性建过渡，将来谁给按钮加个 padding/width 变化，
  就变成布局属性参与动画，每帧重排重绘。
- `.mt5700-status-card` 把写死的 `blur(18px)` 改回 `var(--mt5700-glass)`，
  以后调模糊半径只需改一处。
- 删掉 4 个空壳依赖：`logs.js` / `service.js` / `voice_call.js` / `ui.js` 都
  `require at-webserver/parse` 却一次都没用 `Parse`（94KB 的模块）。

### 新增守卫（防止老毛病长回来）

`tests/ui-contract.test.js` 末尾加了一段全量类名对齐扫描：按 `class` /
`className` 字面量、`className` 赋值、`classList.add|remove|toggle|contains`、
`+ ' mt5700-xxx'` 后缀拼接这几个「真会落到元素上」的位置提取类名，逐个断言
CSS 里有定义。历史上真出过多次「改了类名、样式没跟上」（`.at-sms-del`、
`is-warn` 无配对规则、两套命名空间只改一边），这一条把整类问题一次兜住。

同时钉住三条反向约束：JS 不许再产出 `at-*`、CSS 不许再定义 `.at-*`、
按钮卡口不许再把 `cbi-button-*` 落到 DOM 上。四条都做了「故意违反」变异
验证，确认会红。

### 工具链修复：`tools/verify-guards.py` 的崩溃恢复会静默覆盖改动

它就地改仓库源码做变异，为防「上一轮被强杀 → 变异留在工作区 → 下一轮把残留当
基线」，原先的语义是「启动时发现备份还在 ⇒ 按备份还原」。**这个推断不成立**：
备份还在的成因有两种 —— ① 上一轮没跑完；② 用户在新一轮里改了这些文件。两者从
磁盘状态上无法区分。本次真实踩中 ②：上一轮被 SIGTERM，备份留着，之后又改了一批
源码，下一次启动就把一小时的工作覆盖成备份里的旧内容，而且**一声不响**
（那些文件本来就"有改动"，`git status` 看着完全正常）。

- 恢复逻辑改为**只报告不落笔**：点名「当前内容 ≠ 备份」的文件，`exit 2` 中止，
  由人用 `git diff` / `git checkout` 判断。
- 备份从「复制 65 个文件」改为**只存 sha256 清单**。原因之二：销账时一次删 65 个
  文件会撞上外层的批量删除保护（阈值 50），结果 18 个删不掉、目录留着，下一轮又
  被误判成"上一轮没结束"。清单只有一个文件，销账不会失败。
- 端到端验证：伪造一份残缺清单 → `exit=2`、目标文件哈希不变、清单不被擅自删除、
  正确点名被改动的文件。

### 验证

- `tests/run-all.js`：83 个文件全部通过（ui-contract 280 项）
- `tools/verify-guards.py`：180 条变异全部被断言检出，还原逐字节一致
- `tools/css-class-audit.py`：MISSING 0 / DEAD 0 / 状态类配对无误
- `tools/css-prune.py` 复跑 0 条（幂等）
- `tools/check-line-endings.py`：全部 LF
- `MT5700_CSS_VERSION` 5.8.0 → 5.9.0

## [2.4.28] - 2026-10-21

### 性能 / 体积：样式表删掉 20.8% 的死规则

样式表是**追加式**长出来的：旧 WebUI 的 `.at-*` 命名空间一直留在文件里，之后
每版都往末尾叠一层补丁。3419 行里有 204 个选择器永远匹配不到任何元素
（对应的类全仓库无人挂载）。删除的依据是可证明的：一个选择器只有当它引用的
每个自有类都被某个元素真实挂着时才可能命中；只要有一个从未被应用，它就是个
恒假条件。

- 结果：`94367 → 74767` 字符 / `3419 → 2816` 行（**−20.8%**），删除 204 个
  选择器，其中 14 个是从组选择器里摘出来的（`.mt5700-grid-2, .mt5700-grid-3,
  .mt5700-grid-4 {}` 之前一个活类就整组保留）。
- **零内容改动**：diff 里除选择器组收敛外，新增行全是空白。
- 清理掉的具体死块：旧 WebUI 迁移层（`.at-page` / `.at-panel` / `.at-kv` /
  `.at-sms-*` / `.at-conn-*` / `.at-console-*` / `.at-batch-*` / `.at-lock-*`
  等 109 个孤儿类）、`.mt5700-app` / `.mt5700-tabs` / `.mt5700-verdict` /
  `.mt5700-readout*` / `.mt5700-diag-summary*` / `.mt5700-beams*` /
  `.mt5700-autorefresh` 等改版后遗留的重复定义。
- 顺带删掉 `.mt5700-readout` / `.mt5700-readouts` 的两条**空壳契约断言**：
  取证确认这两个类在 htdocs + root（含 ucode / shell）里已经没有任何元素挂载，
  只剩下 mt5700.css 和断言自己提到它们。改为反向断言，谁再加回来就必须同时
  补组件与样式。
- `MT5700_CSS_VERSION` 5.6.0 → 5.7.0（样式内容变了，浏览器缓存必须失效）。

### 修复：SIM 告警态挂了状态类却没有样式

`mt5700.js#renderConnectionBar` 里 `simBox.classList.toggle('is-warn', sim.warn)`
一直在切状态类，而 `mt5700.css` 从来没有 `.at-status-sim.is-warn` —— 告警永远
看不见。页面不报错、测试全绿，属于「功能白写」的典型形态。补上亮/暗两套规则
（底色 + 描边 + 文字色，不只改字色）。同时给 `.at-status-text` 补
`min-width:0` + 省略号收敛，长 SIM/RPC 文案不再把标题行挤歪。

### 新增：三个样式表工具（把这次的手工核对固化成可复跑）

- `tools/css_scan.py`：类使用面扫描，两种口径——宽松（全源码切词，服务裁剪，
  宁可多留）与精确（只认 class 属性/classList/setAttribute/`cls +=`，服务
  MISSING 审计）。堵住三类实测假阳性：子串误伤（`mt5700-app` 命中
  `mt5700-applybar`）、后缀拼接（`cls += ' mt5700-notice-success'`）、
  注释里的 `xxx-*` 被当成动态前缀通配。
- `tools/css-prune.py`：死选择器裁剪，选择器级判定（不是规则级），
  `@media` 递归、空壳自动丢弃、`@keyframes` 只留被引用的、排版零漂移、幂等。
- `tools/css-class-audit.py`：MISSING / DEAD / 状态类配对三段报告。
  状态类配对这一段就是上面那个 bug 的通用化——`X.classList.toggle('is-y')` 的
  宿主类若在 CSS 里没有配对规则，直接报出来。

### 当前状态

- `node tests/run-all.js`：82 个测试文件全部通过（ui-contract 275 项）。
- 审计结论：MISSING 0 / DEAD 0 / 状态类配对无误。

## [2.4.27] - 2026-10-21

### 移除（用户判定「语音通话 - 可用性自检」是无用功能，直接删除）

- **删除「可用性自检」卡片与 `preflight` 全链路**。四步只读查询（SIMSQ/CREG/
  CIREG/CLIP）+ 结论灯的定位是「拨不出去时指出卡在哪一环」，但本机拨号一直
  正常，卡片只是每次都要读一遍的噪音。按红线 62「下线一个功能要四处同步清」：
  · 前端 `voice_call.js`：卡片、`renderPreflight` / `runPreflight`、
    `st.pf` / `st.pfBusy`、`applyGates` 与 2s 轮询里的 pfBusy 守卫全删；
  · ucode `mt5700.uc`：`callPreflight()`（约 160 行含判据注释）、只被它用的
    `callNumsAfter()`、`call` 分发分支、未知 action 文案里的 `preflight` 全删；
  · `rpc.js#fetchCall`：`ready` / `volte` / `blocked` / `steps` 四字段透传与
    两条失败分支里的对应默认值全删（`stage` 保留 —— 徽标还在用）；
  · 测试：`voice-call-contract` 的 preflight 段换成**反向断言**（函数/分支/
    卡片/字段都不许长回来），`call-passthrough-contract` 同理。
- **保留的教训**：厂商 voicePreparation 的 Quectel 私有命令禁令（`AT+QCALLCFG`
  / `AT+QCFG` 只许出现在注释里）继续由契约测试守着 —— 删功能不等于删纪律。

## [2.4.26] - 2026-10-16

### 变更（UI 全局优化，用户反馈「这个 UI 不好看，整个插件也要优化」）

- **★★ voice_call 页去内联样式（7 处清零），全面接入 mt5700 设计系统**：
  此前该页是"三种风格混战"—— Mt5700 组件 + 手写内联 style + 硬编码色值，
  且内联黄块/色块不响应暗色模式（`#fdf6e3` 底在暗色下一片刺眼）。
  现在提示条走 `.mt5700-notice-warning`、自检结论走 `.mt5700-verdict`、
  号码输入走 `.mt5700-num-display`、键盘走 `.mt5700-keypad`、
  通话动作行走 `.mt5700-callbar`，亮暗双模、与全插件同一套语言。
- **新增四个通用组件**（CSS v5.6.0，`.mt5700-keypad` / `.mt5700-callbar` /
  `.mt5700-num-display` / `.mt5700-verdict`）：电话键盘（3 列方键 + 字母辅助
  2=ABC…9=WXYZ + 按压回弹）、通话动作条（按钮等宽，文案在"挂断↔拒接"间
  切换时整行不抖）、大号号码显示屏（等宽数字 + 聚焦环）、结论色块
  （is-ok / is-bad / is-warn）。均按通用件设计，别处页面可直接取用。
- **全局增强（12 个页面共同受益）**：
  · `.mt5700-metric-value` 加 `font-variant-numeric: tabular-nums` ——
    读数类页面（网络状态 1s 轮询）数值跳动时卡片宽度不抖；
  · 新增 `prefers-reduced-motion` 降级：尊重系统"减少动态效果"偏好，
    同时给 CPE 的 CPU 省合成器开销（18px 毛玻璃 + 多层阴影本就吃力）；
    spinner 旋转保留——它是"正在处理"的唯一反馈，停转会被误判为卡死。
- `renderInfo()` 历史遗留的错乱缩进修正（不影响逻辑）；通话页键盘键面
  补字母辅助行（纯装饰，不进输入值）。

### 质量门禁

- 82 个测试文件 + `run-all.js` 全绿；voice-call 契约 145 项断言通过；
  变异守卫 187 条全检出、还原逐字节一致；CSS 缓存契约指纹已同步
  （`MT5700_CSS_VERSION` 5.5.22 → **5.6.0**，`CSS_FINGERPRINT` 已更新）。

## [2.4.25] - 2026-10-16

### 修复（用户实测反馈）

- **★★ 通话动作按钮「看不到」：接听/挂断/静音从 display 隐藏改为常驻可见 + 灰化**
  （厂商 modemwebui 的形态）。上一版把非当前态的按钮藏起来，用户在原地说
  "没看到接停电话"—— 来电只响几秒，藏起来的接听键根本指望不上。现在四个
  动作（接听/挂断/静音/铃声）一直在位，能不能点由 `applyGates()` 统一判定：
  空闲时接听/挂断/静音灰化，来电时接听点亮、挂断改叫「拒接」。
- `renderInfo()` 里直写 `muteBtn.disabled = false` 会绕过 `applyGates`
  把静音键在通话外又点亮 —— 已删，disabled 的判据只准有一处。
- 建页后立即 `applyGates()` 一次：`connectThen` 握手完成前，按钮不再是
  默认可用态（空闲时"接听/挂断"亮着是假象）。

### 变更

- 接听判据从"stage 令牌"改为"phase"：phase 由前端从 CLCC 原始 state 现算，
  **老后端没有 stage 时也能正确灰化**；stage 令牌留给徽标做细粒度文案。
- 拨号盘放大（输入框 22px、键位 20px/14px 内距、拨打键与通话键同规格）；
  自检结论改为绿/红色块（"可以拨号" / "卡在哪一环"），一眼可读。
- 文件头与页面顶部提示更新为最新取证结论：**模组侧 PCM 语音模式已开启**
  （`AT+CLVL=?` 实测回 `(1-12)`，手册 6.10 的车载 PCM 档位），断点在主板
  （M.2 音频脚未接到 SoC、板面无 codec）。声音实现方案见
  `.workbuddy/声音实现方案-20261016.md`（两条路线：路由器 SIP / 飞线到 AFE）。

### 测试

- 契约测试 `tests/voice-call-contract.test.js` 扩到 **145 项断言**
  （新增：按钮常驻可见、phase 判据、铃声纳入禁用、建页即灰化等 5 组）；
  `tools/verify-guards.py` 增 **5 条**变异（第 180–184 条）。
- 全量 84 个测试文件 + 本地 CI + 187 条变异验证全绿。

## [2.4.24] - 2026-10-16

### 修复

- **★★ `rpc.js#fetchCall` 漏搬字段，导致 v2.4.23 的两个新功能在页面上完全没生效**
  （本条是真实故障，不是假想防御。详见下方「发现过程」）

  | 字段 | 谁产出 | 谁消费 | 漏了会怎样 |
  |---|---|---|---|
  | `stage` | ucode `callOverallStage` | 视图 `st.stage` | 厂商粒度状态机**完全不生效**：徽标一直退回 `CALL_STATE` 的 0-5 粗判，「正在呼出/对方振铃/来电等待/通话保持」四种状态分不出来 |
  | `ready`/`volte`/`blocked`/`steps` | ucode `callPreflight` | 视图 `renderPreflight` | 可用性自检**永远只显示「检查失败」**，那四行读数一条都渲染不出来 |

- 两条失败分支（`success === false` 与 Promise reject）补齐 `stage: null` /
  `steps: []` / `ready: false` / `volte: false` / `blocked: ''`：
  省略时前端读到的是 `undefined`，与「还没查到过」混同（红线 23）；
  且成功分支给布尔 `false`、失败分支给 `undefined`，类型不一致，
  将来任何 `ready === undefined` 判据都会被绊倒。

### 新增

- **移植厂商 `modemwebui` 的按钮禁用纪律（`usable` 语义）**：
  新增 `applyGates()`，禁用判据**只此一处**。判据 = 忙/自检中/通道故障
  ∨ 动作与状态不匹配：

  | 按钮 | 可点条件 |
  |---|---|
  | 拨打 | 仅 `idle`（通话中不再能发出第二条 `ATD`） |
  | 接听 | 仅 `ringing`/`waiting`（对齐厂商口径） |
  | 挂断 | 非 `idle` |
  | 静音 | 仅 `active` |

  新增 `st.channelError`：`status` 读失败时置位、成功时复位，
  通道故障期间按钮灰化，不再让用户对着一个已断的通道反复点。
  **读失败不清 `stage`/`calls`** —— 那会把故障渲染成「空闲」。
  `setBusy` 改为只改标志并转交 `applyGates`（此前它自己写了一套
  `disabled`，两处判据必然漂移）。

### 发现过程（值得记一笔）

上一轮真机验证用的是 `ubus call mt5700 call '{"action":"status"}'` **直调**，
它返回了正确的 `"stage":"idle"`，于是一度认为状态机移植成功。
但直调**绕过**了 `rpc.js` 这一层 —— 后端在回、前端在读，唯独中间层没搬。
**「后端返回正确」不等于「页面拿到」。**
教训固化为两条守卫：

- `tests/voice-call-contract.test.js` 新增 ⑪b/⑪c/⑨ 三组断言（**142 项**），
  把相邻两层的字段名钉在一起，并要求禁用判据只有 `applyGates` 一处。
- 新增 `tests/call-passthrough-contract.test.js`（**16 项**）：把**真机实抓**
  的 `status` / `preflight` 响应喂进**未经修改的** `fetchCall` 源码执行，
  验证字段真能活着到视图。样本用真数据而非手编 —— 手写容易「恰好符合
  自己的假设」，真机能暴露字段名/类型不一致。
- `tools/verify-guards.py` 新增 `rpcjs8` 键（既有 7 个 `rpcjs*` 各跑别的测试，
  复用会「变异生效却没人判红」）+ **8 条变异（第 176–183 条）**。

## [2.4.23] - 2026-10-16

### Added

**127. ★★★ 从厂商「带电话功能beta」固件移植通话管理台的**语义**（而不是命令）**

参考对象：`H5000M-OpenWrt-25.12.5-6.12.112-带电话功能beta-中lan-password.bin`。

逆向结论（先说清楚它是什么）：该固件的「电话功能」是**通话管理台，不是软电话**——
三条独立证据钉死它没有音频通路：① 228 个内核模块里 `snd` / `soc` / `afe` 一个都没有；
② 没有 `/dev/snd`；③ 整个 `/www` 里搜不到 `getUserMedia` / `RTCPeerConnection`，
也没有任何 RTP / PCM / Opus 库。它的后端是 Go 写的 `modemwebui-server`
（HTTP `:8001` + WebSocket `:8765`），只做 `ATD`/`ATA`/`ATH`/`AT+CLCC`/`AT+VTS`
＋状态推送＋通话记录，LuCI 侧由 `luci.controller.modemwebui` 转接。所谓「电话功能」
= 把模组那 4 个 AT 串口的通话能力做成一个带状态机的管理界面。

据此移植三样**结构**：

1. **状态机令牌（厂商粒度）**。ucode 新增 `callStageOf` / `callOverallStage`：
   `AT+CLCC` 的 `<state>` 0..5 → `active` / `held` / `dialing` / `alerting` /
   `ringing` / `waiting`；多路呼叫的总态按优先级
   `active > held > waiting > ringing > alerting > dialing` 归并。
   前端 `STAGE_TEXT` 用与厂商同一套令牌名，徽标从「只有 5 个粗态」变成能
   分开显示「正在呼出 / 对方振铃 / 来电振铃 / 保持中」。
   ★ 厂商那个 `requesting`（"等待模组确认呼出"）是它自家前端的本地时序态，
   本实现靠 2 秒轮询观测不到，故只在表里留位、不产生。
2. **`preflight` 前置检查**（源自厂商的 `voicePreparation` 方法论）。
   四条**只读查询**：`AT^SIMSQ?`（`sim_status` 需为 12）/ `AT+CREG?`
   （`stat` 需为 1 或 5）/ `AT+CIREG?`（`reg_info`=1 表示 IMS 已注册）/
   `AT+CLIP?`（`m`=1 才报主叫号码）。核心项＝SIM + CS 注册，决定「能不能拨」；
   IMS 与 CLIP 只影响「体验好不好」，未过不阻断拨号（IMS 不通会回落 CS 域）。
   ★★ **厂商真正用的那两条命令没有移植**：它写的是 Quectel 私有的
   `AT+QCALLCFG="voice_disable",0` 与 `AT+QCFG="ims"`，MT5700M-CN 手册里
   没有这两条——照搬就是给模组发未定义命令（红线 27）。所以「先准备」在本实现里
   落地为四条手册内的只读查询，并把这两个命令名**只允许出现在注释里**
   （契约测试扫全文件：出现在代码行即判红）。
3. **通话记录的 `direction` 字符串**，与既有 `dir` 整数**双向兼容**：
   入口接受 `direction` / `dir` 任一种，`unanswered` 归一为 `failed`、
   `answered==true` 归一为 `answered`；出口同时写 `dir` 与 `direction`；
   老记录在**读侧**用 `dir` 补齐 `direction`（不做落盘迁移——迁移要重写整份
   文件，中途掉电就是记录全丢，而读侧补齐的代价约为零）。

**明确放弃的一项**：厂商的「跨页面来电通知」（它靠 WS 推送，任何页面上都能弹条）。
本项目的来电通知是轮询驱动的，照搬就得让 **每个** LuCI 页面都去轮询 AT ——
串口独占 + rpcd 单线程（红线 63），代价远大于收益，不做。

### Fixed

**128. ★★★ `callStatus` 失败分支不显式回 `calls: null`（前端报错分支是死代码）**

`callStatus` 原来在「AT 通道无响应 / 查询失败」两个分支里**只回 `error`**，
而前端判据写的是 `res.calls === null` —— `undefined === null` 为假，于是那条
报错分支**一次也走不到**：后端挂了和「确实没有通话（空闲）」在界面上长得一模一样
（红线 23：把「读不出来」伪装成「没有」）。
两边同时修：ucode 两个失败分支显式回 `calls: null`；前端判据放宽为
`!Array.isArray(res.calls)`（这样即便后端未升级也不会退回假空闲）。
两条都已写成契约断言，并各有一条变异条目证明它们真的会判红。

契约测试：`tests/voice-call-contract.test.js` 扩到 **121 项断言**
（新增状态机令牌 / preflight 只读结构 / Quectel 命令禁入 / direction 双向 /
视图接线五组），`tools/verify-guards.py` 增 **8 条**变异（第 165–172 条）。

**129. ★★★ preflight 判据按真机校准：语音不要求 CS 注册（原判据是假阴性）**

部署到真机（192.168.88.1）后立刻按红线 42 用**原始 AT 响应**复核了四条查询，
量出一个反直觉但很关键的状态：

| 查询 | 原始响应 | 含义 |
|---|---|---|
| `AT^SIMSQ?` | `^SIMSQ: 1,11` | 卡已初始化（可接入网络） |
| `AT+CREG?` | `+CREG: 0,0` | **CS 域没注册** |
| `AT+CGREG?` | `+CGREG: 1,1` | PS 域已注册（数据通） |
| `AT+CEREG?` | `+CEREG: 2,1` | EPS 已注册 |
| `AT+CIREG?` | `+CIREG: 1,1` | **IMS 已注册** |
| `AT+CLIP?` | `+CME ERROR: UNKNOWN` | 本模组不支持查询 CLIP |

据此修正三处（都是「照搬文档/参考实现」会踩的坑）：

1. **`ready` 判据从「SIM + CS 注册」改为「SIM 已初始化 且（CS 或 IMS 任一可用）」。**
   原判据会把本机（CS 未注册、IMS 已注册）判成「不能打电话」—— 假阴性。
   **依据不是猜的**：手册 4.6 的 `^CCALLSTATE` 里 `<voice_domain>` 明确有
   「1：IMS 域语音电话」这一档，即语音呼叫本身**不要求 CS 注册**
   （红线 49：判定要带对照组；所以同时量了 CGREG/CEREG 做对照）。
2. **`sim_status` 门槛从 `== 12` 改为 `11 || 12`。** 手册 6.6.3 原文：11 = 卡初始化
   完成（可接入网络）、12 = 卡初始化完成（**短信和电话本**可接入）—— 12 讲的是
   短信/电话本，不是「才能打电话」。把 12 当语音门槛是过度解读，实测本机停在 11。
3. **`AT+CLIP?` 在代码里不再被当成「读到但没开」**：实测它是**命令被拒**
   （`AT+CLIP=?` 却正常回 `+CLIP: (0,1)`），故 preflight 把「命令被拒」与
   「读到了但没此项」分开报（红线 23），该项为提示项、不参与 `ready`。

配套：步骤对象新增 `blocking` 字段（"未过且确实挡住拨号"），前端三态记号
✓/✗/○ 改用它而不是 `core` —— 否则「CS 未过 + IMS 已过」会显示成一个红叉，
让人以为完全不能拨；`blocked` 也从「步骤标题」改成一句原因短语。
契约测试 **127 项**、变异 **11 条**（第 165–175 条）。

**实测闭环（同一次会话内完成，非推断）**：在 CS 未注册的状态下实拨 `1008611`，
`AT+CLCC` 的 stage 令牌按预期推进 ——

```
t+0~2s  state=2 → dialing      （正在呼出）
t+3s    state=3 → alerting     （对方振铃）
t+4s    state=0 → active       （已接通，脚本立即挂断）
```

**呼叫在 `+CREG: 0,0` 下接通**，且 `ATH` 的响应里带出一条
`^IMSCTRLMSGU:1,280,"04010000…"`（IMS 控制消息）—— 两个独立信号共同证明
这次呼叫走的是 **IMS 域**。所以 `ready` 的新判据不是放宽，是纠正：
旧判据会把一台「能打电话的机器」说成不能打。挂断后 `status` 回到
`idle`/`calls:[]`，状态机全链路（dialing→alerting→active→idle）真机走通。

## [2.4.22] - 2026-10-16

### Added

**125. ★★ 通话板块完善：静音 / 线路信息 / 通话记录 / 来电铃声 / 拒接**

在 2.4.21 的五动作之上补齐「通话管理台」：

- **`info` 动作**：`AT+CMUT?` + `AT+CLVL?` → 麦克风静音与扬声器音量。
  按需查询（页面加载 + 手动刷新），**不进 2s 轮询** —— 并进轮询就是把每轮
  串口占用从 1 条变 3 条（红线 70：串口独占串行，多查不会更快只会更久）。
- **`mute` 动作**：`AT+CMUT=0/1`，digit 只收 '0'/'1'，写后回读确认。
- **通话记录**：`loglist` / `logadd` / `logclear`，落
  `/etc/mt5700/call-log.json`（与短信已发记录同目录，写 tmp 再 rename）。
  字段收敛为 `number/dir/result/duration/time`，其中 `number` 必须过
  `callNumberOk` —— 这条通路能把内容写进设备文件，不校验就是一条注入面。
- **视图**：状态徽章 + 静音徽章、号码/状态/方向/时长/音量五项、
  接听/拒接/挂断、静音开关、通话记录表（点「重拨」直接回拨）、
  **来电铃声**（Web Audio 生成，手机浏览器可响 —— 这是本页唯一能让手机出声的部分）。
- **能力提示条**：首屏明示「本机无音频硬件」，避免把「接通了却没声音」当成功能坏了。

### Fixed

**126. ★★★ 两个真机踩出来的加载/调用陷阱（都已写成契约守卫）**

1. **rpcd 的 ucode 插件会加载 `/usr/share/rpcd/ucode/` 下的所有文件，不看扩展名。**
   升级时把旧版备份成同目录的 `mt5700.uc.bak-2.4.21` ⇒ 那份**旧代码里的
   `return { mt5700: ... }` 照样注册 ubus 对象**，把新文件的对象抢注/覆盖。
   现象极具迷惑性：文件 md5 双向校验全对、`restart`/`stop+start` 都无用、
   `ubus -v list` 看不到新参数、**甚至把正主文件移走对象依然在**。
   ⇒ 判据＝`ubus list` 的对象是否随 rpcd 停止而消失；**备份一律放目录外**（`/root/...`）。
2. **`rpcCall()` 只认 Rust 服务（127.0.0.1:8765）的方法名。**
   `at_batch` 是本文件在 rpcd 层注册的 ubus 方法，在 ucode 内部写
   `rpcCall('at_batch', ...)` 会被 Rust 直接回 `"未知方法: at_batch"`。
   ⇒ 线路信息老老实实两次 `rpcCall('at')`。

### Notes

- **本机无音频硬件（完整取证）**：模组 USB 6 个接口全是 NCM/vendor-AT
  （`bInterfaceClass` = 01 的计数为 0），设备侧无 `/dev/snd`、无 `/proc/asound`、
  dmesg 无任何音频驱动、设备树无 sound/i2s 节点。`AT+CLVL` 读到 **7**
  （普通模式 0–5、**车载 PCM 模式 1–12**）⇒ 模组处于车载 PCM 语音模式，
  音频出口在模组自己的 PCM 引脚上。⇒ 语音流到不了浏览器，**本页不可能做软电话**；
  要出声必须外接音频硬件，或换支持 USB Audio Class 的模组。
- 真机端到端实测（192.168.88.1，拨 1008611，用户授权）：
  拨号中 → 回铃 → **6s 接通** → 通话中 `mute=1` 写入后回读 `+CMUT: 1`
  → 挂断 → CLCC 空 → 记录落盘与回读一致。
- 边界拒绝实测：注入串号（`10086;AT+CFUN=0`）、非法 `result`、非法 `dir`、
  非 JSON 记录**全部被拒**，且不污染已存记录。
- 契约测试 65 项；9 组变异（删 mute 分支、去掉 `callNumberOk` 校验、
  记录去掉 rename、视图去掉 Web Audio 等）全部被抓。

## [2.4.21] - 2026-10-16

### Added

**124. ★★★ 语音通话（拨打 / 接听 / 挂断 / 状态 / DTMF）—— 新增独立页面 `admin/modem/5g/voice-call`**

真机实测授权拨打 1008611 后落地（MT5700M-CN V200R001C20B025，NR SA 注册态）：

- **后端** `mt5700.uc` 新增 `call` ubus 方法（action: `dial` / `answer` / `hangup` /
  `status`），ACL 的 read/write 两段同步登记：
  - `dial`：`ATD<号码>;`（分号＝语音呼叫，缺分号会按数据呼叫走）；
  - `answer`：`ATA`；`hangup`：`ATH`；
  - `status`：`AT+CLCC` 解析为结构化列表（`idx/dir/state/mode/mpty/number/type`），
        状态位按 3GPP TS 27.007 映射（0 活跃 / 1 保持 / 2 主叫拨出 / 3 被叫振铃 / …）。
- **号码白名单**：仅放行 `+ * #` 与数字（≤32 位），拒绝其他一切字符 —— 拨号字符串
  直接进 AT 通道，必须前置校验。
- **前端** 新增 `voice_call.js` 视图：拨号盘（12 键）、通话状态卡（CLCC 2s 轮询 +
  计时）、来电「接听/挂断」、通话中 DTMF 键盘；事件订阅走 `page._onDispose` 退订。
- **契约测试** `tests/voice-call-contract.test.js` 41 项：号码白名单、CLCC 解析、
  ucode/前端/ACL/菜单四处接线一致性；4 组变异（删 ACL、视图直发 ATD、ucode 去分号）
  全部被抓（红线 16）。

**实测数据**（192.168.88.1，2026-10-16）：`ATD1008611;` → `OK` → 8s 后
`+CLCC: 1,0,0,0,0,"1008611",161`（接通）→ `ATH` → `OK` → CLCC 空。
`AT^CURC?` = 0（呼叫类 URC 全部禁止上报）⇒ 状态只能靠 CLCC 轮询，
故采用 2s 轮询而非即时推送（详见 REFERENCE §语音通话）。

### Notes

- Rust 侧无需改动：`at` 通道已具备所有能力（拨号命令 2s 超时即返回 OK）。
- 本机无 Rust 工具链（红线 64），本次改动全部在 ucode/前端/测试层，可本地全量验证。

## [2.4.20] - 2026-10-16

### Fixed

**123. ★ 缺 `timeout` 命令导致 `/admin/modem/5g` 页面读不到任何信息（MWRT 固件运行时兜底）**

真机现象：换 MWRT 固件（r33382 / kernel 6.6.94）后，整个 `/admin/modem/5g`
页面读不到任何信息，所有 AT 调用统一失败：

```json
{ "success": false, "error": "Rust 后端无应答（已限时 45 秒）" }
```

同时 `exitip` / `sysdiag` / DoH / ePDG 一起失效。

**根因** —— 不是模组、串口或 Rust 后端的问题，是**这条错误文案在撒谎**。

`/usr/share/rpcd/ucode/mt5700.uc` 的 `rpcCall()`（第 356 行）用
`timeout` 包住回环 RPC：

```ucode
p = fs.popen('timeout 45 nc 127.0.0.1 ' + port + ' < ' + tmp, 'r');
```

该固件的 busybox 1.36.1 **不含 `timeout` applet**，实测三处都找不到：

```
$ busybox timeout 5 true        → timeout: applet not found
$ /bin/sh -c 'timeout 5 true'   → timeout: not found
$ command -v timeout            → （空）
```

于是 shell 直接 **rc=127**、一行输出都没有，ucode 侧 `p.read('line')` 得到空串，
统一报成「无应答（已限时 45 秒）」。**实测该调用耗时 0.00 秒** —— 不可能等满 45 秒，
文案与病因完全对不上（这正是它难查的原因）。

**对照证据**（同一时刻、同一台设备）：

| 探测 | 结果 |
|---|---|
| 直连 `nc 127.0.0.1 8765`（不带 timeout） | `{"data":"TD Tech Ltd.\r\nOK","success":true}`，连续 5 次全成功 |
| 通知日志 | 15:06:29 有真实数据（NR / RSRP −86 / 频点 504990 / PCI 276） |
| `ttyUSB1` 持有者 | 仅 `at-webserver-rust`（fd 10/11），未被抢占 |
| 不过串口的 `netrate` | `success: true` |

⇒ **AT 通道与后端都活着**，所以「重启服务 / 换串口 / 重装插件」全是白费力气。

**修复** —— 在 `root/etc/uci-defaults/at-webserver` 加运行时兜底：检测到
`command -v timeout` 缺失时补装 `coreutils-timeout`（仅 20KB，
Depends 只有 libc/coreutils/librt），装不上则打可定位告警。
不改 `mt5700.uc` 任何一行。

**为什么不在 `LUCI_DEPENDS` 声明它** —— 与文件头"netcat 不设硬依赖"是同一条理由：
目标源缺同名包时，硬依赖会让 opkg 直接安装失败，而缺失是可诊断的。

**验证**（修复后真机实测）：`AT+CGMI=TD Tech Ltd.`、`AT+CSQ=+CSQ:`、
`AT+CEREG?=+CEREG:2,1`、`AT^CHIPTEMP?=12 路温度`；`at_batch` 2/2；
`sysdiag` 20+ 字段；`exitip=111.55.210.93`；LuCI 全站 0 个 error500；
限时语义正确（`timeout 3 sleep 30` → rc=124 / 3s）。

**注意**：存量已装机不会重跑 uci-defaults，需手动执行一次
`sh /etc/uci-defaults/at-webserver`（幂等）或 `opkg install coreutils-timeout`。

## 更早版本

2.4.19（2026-09-30）及更早的条目已归档到
[docs/changelog-archive.md](docs/changelog-archive.md)，检索方式不变。
