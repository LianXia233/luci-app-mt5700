# Changelog

## v1.14.21 (2026-10-12)

### 旧键迁移：出厂默认值不参与换算

- **fix(config)**: 迁移策略区分「出厂默认值」与「用户改过的值」。旧键 `notify_interval` 的 **60 秒是出厂默认值** —— 包内 `root/etc/config` 原本就写死 60，所以实机上看到 `notify_interval='60'` 绝大多数代表「用户从没改过」，而不是「用户刻意选了 60 秒」。v1.14.20 一视同仁地按公式换算，结果是**每台升级的设备都变成每分钟推一条**（每天 1440 条，远超 QQ 主动消息频控：单关系 20 条/分钟、群 30~60 条/分钟、1000 条/群/天），等于把一次语义升级变成推送轰炸。
- **fix(config)**: 现改为 —— 旧值等于 `LEGACY_DEFAULT_NOTIFY_INTERVAL_SECS`（60）时落到**新默认值 10 分钟**；被改过的值（如 300 秒）才按「向上取整到分钟」换算成 5 分钟。前端加载时的换算显示与后端同口径，避免界面与后端算出两个值。
- **note**: v1.14.20 的 tag 与 Release 在本修正之前已发布，故修正走新版本号，不追溯改写已发布版本的发布说明。
- **test**: `cargo test` **141 passed / 0 failed / 2 ignored**（新增 `legacy_default_seconds_falls_to_new_default_not_one_minute`：钉住 60 秒 → 10 分钟、300 秒 → 5 分钟、30 秒 → 1 分钟）；端到端用例改用**非默认值 30 秒**验证换算路径（60 秒走的是新默认值分支，换算不出可观测的短间隔）。
- **docs**: 新增 `docs/release-notes/v1.14.21.md`；README 补「老设备升级怎么迁移」一段。

## v1.14.20 (2026-10-12)

### 推送频率（合并窗口）→ 定时推送间隔（分钟）

- **change(config)**: UCI `notify_interval`（**秒**，5~3600，默认 60，语义「攒一批一起发」）改为 **`notify_timer_interval`（**分钟**，1~1440，默认 10，语义「到点就发一次当前状态」）**。旧键由后端 `secs_to_timer_minutes()` 向上取整换算后自动迁移（`60` → `1`），前端保存时写新键并把旧键置空 —— 老设备升级无需手工改配置。
- **feat(timerpush)**: 新增定时推送模块：每到一个间隔推送一次**当前实际情况**（最新信号读数 + 短信存储占用），与期间有没有事件到达**无关**。原「窗口内无事件则不发送」的逻辑一并移除。
- **change(notify)**: `notify()` 不再攒批 —— 有可用通道就**所有类型都直发**；待发队列只剩一个用途：QQ 绑定模式下绑定完成前暂存事件，绑定成功后由 `run()` 每 10 秒扫一次**逐条**补发（不再合并成批量）。
- **docs**: README 与包内 UCI 注释写明权衡 —— 间隔越短状态越新鲜，但条数越多、越易撞 QQ 主动消息频控（单关系 20 条/分钟、群 30~60 条/分钟、1000 条/群/天）；间隔越长越安静，但单次推送承载的内容更多，且两次之间发生的变化要等到下一个整点才被看到。日常建议 5~30 分钟。
- **docs**: 默认从 60 秒改为 **10 分钟**的理由 —— 定时推送**每轮必发一条**，若仍按 60 秒就是每天 1440 条，远超上述频控；10 分钟为每天 144 条，兼顾「状态新鲜」与「不刷屏」。想要更实时把间隔调小即可（最小 1 分钟）。
- **feat(luci)**: 数字输入改 `min=1 max=1440 step=1`，新增「快捷时长」下拉（1 / 5 / 10 / 30 / 60 分钟 / 3 / 12 / 24 小时）与实时换算提示（如「每 1 小时 30 分钟推送一次…」）；旧键在加载时自动换算显示并说明已迁移。
- **note**: 短信与来电**不受此配置影响**，始终实时直发；信号巡检（`notify_poll_*`）与定时推送**并存互不影响** —— 巡检抓突变，定时推送做保底。只想保留突变通知时，把间隔拉到 1440 分钟（24 小时）即可近似关闭。

### 定时推送读的是「现在」，不是「刚才」

- **feat(timerpush)**: 采样复用 `signalwatch::sample_signal()` / `band_label()` / `fmt_num()` —— 两条线同一口径。否则同一时刻两条推送的 RSRP 差几个 dB，用户会以为设备在骗人。
- **feat(urc)**: 新增 `query_storage()`（`AT+CPMS?`，同时兼容私有 `^CPMS:` 前缀）读取短信存储用量。为什么必须现读：存储满的 `^SMMEMFULL` **只在恰好收满那一刻来一次**，此后即便用户清理过也不会再来，沿用旧状态会一直卡在「已满」。容量读到 0 视为**没读到**而非「满了」。
- **fix(timerpush)**: 没有读数时**明说「暂无读数」**，不拿上一轮旧值冒充当前状态；存储满时一并说明后果（清理前可能收不到新短信）。
- **fix(timerpush)**: 首轮**先睡满一个间隔**再推 —— 开局立刻采样，此刻串口/网络往往还在建立连接，只会推出一条「暂无读数」，比晚几分钟推一条真实的更糟。
- **fix(timerpush)**: 总开关关闭 / 模组未连接 / 长命令（扫频）进行中时跳过本轮、一条 AT 都不发 —— 关掉自动推送就该连后台定时读取一起停，否则用户会以为开关无效。

### 其它

- **test**: `cargo test` **140 passed / 0 failed / 2 ignored**（新增 7 条：秒→分钟迁移与上下界夹取、按分钟读取与越界夹取、状态快照含代际/频段/频点带宽/RSRP/SIGNAL/存储、存储满带后果、无读数时如实说明、正文 ≤ 9 行、存储行解析）。
- **security**: 本轮同样不触碰 IMEI 与恢复出厂设置。
- **note(notify)**: 攒批合并移除后，`notify_tpl_batch` （批量汇总标题）与 `{count}` 的「多于一条」分支**不再会被触发** —— 生产路径逐条直发。模板与占位符保留（已自定义的配置不丢、单测仍覆盖），LuCI 页面上标注了「保留仅为兼容，当前不会被触发」。若日后出现「一批事件一起推」的场景可直接复用。
- **chore**: 清理「合并窗口」遗留说法 —— 含一条**用户可见**的报错文案（`channel=signal` 原回「其余走合并窗口」，现改为「信号请等定时推送或真实巡检」）与一条启动日志（原「其余按合并窗口批量发送」）。
- **docs**: 新增 `docs/release-notes/v1.14.20.md`；README「推送频率与自定义文案」改写为「定时推送间隔与自定义文案」，事件类型表补「当前状态（定时器）」一行。


## v1.14.19 (2026-10-12)

### 测试推送：从「只测通道」扩展为「可按事件类型测」

- **feat(notify)**: 新增 `Notifier::notify_test_event()`，RPC `notify_test` 的 `channel` 开放 `sms` / `call`。原「发送测试通知」只能回答**通道通不通**（固定文案、不走事件链路），而短信与来电**只能由模组 URC 触发**（`+CMTI` / `+CLIP` / `^CEND`）—— 想验证「新文案长什么样、是不是真的实时」就得等一条真短信或一通真电话。新入口构造一条与真实事件**同形状**的事件交给 `notify()`，走的是完全相同的路径（总开关 → 该类型开关 → **实时直发** → 文案模板 → 通道投递），因此收到的文本与真实短信/来电**一字不差**。
- **fix(notify)**: 开关未开启时**明确报错而不是返回成功** —— `notify()` 在总开关 / 分类开关关闭时是静默 `return` 的，若照直调用后返回 `Ok`，界面会显示「发送成功」而手机毫无动静，这是发送侧全绿、接收侧全无的最难排查的一类失败。四类原因（总开关关闭 / 该类型开关关闭 / 没有可用通道 / 类型不受支持）各自带可辨文案，并逐条加单测锁定。
- **feat(notify)**: 测试事件**自带可辨识标注** —— 号码用掩码 `138****0000`（刻意不用 `13800138000` 这类看起来像真号的号码，避免用户真的回拨过去），正文带「（测试消息，非真实短信 / 非真实来电）」。
- **feat(notify)**: **信号不提供类型化测试** —— 信号指标是真实读数（`AT^HFREQINFO?` 的频点带宽 + `AT^MONSC` 的 RSRP/RSRQ/SINR），造一条假的「RSRP -xx dBm」只会把人引向错误方向。`channel=signal` / `memory_full` 返回**带理由**的错误，而不是笼统的「未知通道」——后者会让人以为只是拼错了名字，反复试。
- **feat(luci)**: 通知卡片新增「测试短信推送」「测试来电推送」两个按钮，与「发送测试通知」并列；失败时把后端给出的具体原因**原样转述**，不再只显示「失败」。

### 其它

### 存储满提醒换成喵系口吻

- **chore(notify)**: 短信存储满的提醒文案换成 `喵呜～短信存储空间已经满啦，请尽快清理一下喵，不然可能收不到新的短信了哦！`，与短信/来电的喵系口吻统一。原文案是「⚠️ 警告：短信存储空间已满」两行式，语气偏系统告警；存储满是**可以自己解决**的事（删几条短信即可），用提醒而非告警更贴切。同步更新 Rust `DEFAULT_TPL_MEMORY`、前端「恢复默认文案」内置值、README 示例与包内 UCI 注释。
- **note**: 同短信/来电那条规则 —— **已自定义过文案的设备不受影响**（后端只在 `notify_tpl_memory` 为空时回落默认值）。想让实机也换成新文案，清空该项即可：`uci -q delete at-webserver.config.notify_tpl_memory`。

### 批量汇总标题换成喵系口吻

- **chore(notify)**: 批量通知汇总的首行标题换成 `喵～有一批新通知需要查看哦，快来看看都有哪些消息吧！`，与短信/来电/存储满统一。原标题 `📑 批量通知汇总` 只说明「这是一批」，没说要做什么；新标题把动作（查看）和范围（一批）都讲清楚。同步更新 Rust `DEFAULT_TPL_BATCH`、前端「恢复默认文案」内置值、README 示例与包内 UCI 注释。
- **fix(test)**: `simulate-push.js` 里「未走批量汇总形态」这条断言原来是拿**旧标题原文**当判据（`indexOf('批量通知汇总') < 0`）。文案一换，它就会永久通过 —— 无论是否真的走了汇总形态，属于改文案后失活的断言。改为按新标题判定。

- **test**: `cargo test` **133 passed / 0 failed / 2 ignored**（新增 3 条：短信模板渲染、来电实时直发与正文结构、四类「发不出去」的原因逐条可辨）；`simulate-push.js` 由 40 通过增至 **55 通过 / 0 失败，1 项观察**（新增 15 条：类型化测试推送走真实模板与实时路径、测试标注、非法 channel 明确失败、`signal` 给出不支持的理由）。
- **security**: 本轮同样不触碰 IMEI 与恢复出厂设置；类型化测试推送**不下发任何 AT 命令**，事件在进程内构造。
- **docs**: 新增 `docs/release-notes/v1.14.19.md`；README 补「推送自检（测试推送）」小节并同步版本号。

## v1.14.18 (2026-10-12)

### 巡检推送显示具体频段与网络代际

- **feat(signalwatch)**: 推送**显示具体频段与网络代际** —— 标题给出 `5G` / `4G`，频段行给出 `n41 · 2565 MHz / 100 MHz`。频段号取自 `AT^HFREQINFO?` 的 `<band_classN>`（手册 13.16.3），该字段此前被整段丢弃，只能笼统写「中频 2565 MHz」。
- **fix(urc)**: `^HFREQINFO` 的 `<sysmode>` 编码（`1` GSM / `3` WCDMA / `6` LTE / `7` NR）与 `^SYSINFOEX` 的 `<sysmode>`（`6`=LTE、`11`=NR-5GC）**不是同一张表**，混用会把 NR 误判成 LTE；单列 `hfreq_sysmode_name()` 并加断言隔离。
- **feat(urc)**: 频段解析抽成纯函数 `parse_hfreq_line()`，用**实机原始应答** `^HFREQINFO: 0,7,41,513000,2565000,100000,...` 做回归；频点 ≤ 0 视为「没有读数」而非「0 Hz」（模组未注册 / 无服务时会填 0）。
- **feat(signalwatch)**: NR 用 `n` 前缀、LTE 用 `B` 前缀；**制式未知时退回中性的 `Band 41`，不猜是 4G 还是 5G**。制式优先信 `^MONSC`，它没给出时用 `^HFREQINFO` 的 `<sysmode>` 兜底 —— 否则会出现「拿到了频段号却不知道该写成 `n41` 还是 `B41`」。
- **refactor(signalwatch)**: 推送排版压缩（12 行 → 9 行）：制式进标题、频段与带宽合成一行、总评一行、四指标各一行；与网页「射频信号质量」卡片的口径仍逐项一致。

### 短信中心：会话改为聊天式单时间轴

- **feat(sms)**: 同一联系人的对话改为**聊天式单时间轴**（上一版的分区排列废弃）—— 收发按时间升序**混排在同一条轴上**，靠气泡左右位置区分方向（**对方在左、自己在右**），跨天处插居中日期分隔条（形如 `2026-10-12`）。上版分区会让一次来回被拆到上下两处，读起来要来回跳。
- **fix(sms)**: **自己发的消息被甩到会话末尾，一次来回被打散** —— 发出短信的 SMS-SUBMIT 按 `3GPP TS 23.040` 就**不含发送时刻**（只有 TP-VP 有效期），前端把「时间未知」的消息一律沉到会话末尾，渲染出来是「左、左、右」而不是「你一句我一句」。改为按**模组存储序号**（`AT+CMGL` 的 index 即存储先后）给它找锚点：取该条前面最近那条有确切时刻的消息的时刻，让它落回那个位置附近。锚点只用于排序与日期分隔，气泡里照旧如实标「时间未知」—— 借位置，不伪造时刻。
- **fix(sms)**: **去重时把唯一带准确时间的记录丢了** —— 同一会话的已发短信可能同时来自模组存储与浏览器缓存，原实现「模组是权威来源，冲突时丢缓存那份」。可模组那份（SMS-SUBMIT）恰恰没有时刻，缓存那份才是本机发送当时打的时间戳 —— 丢掉缓存等于把时间信息一并扔掉。改为反向**吸收**：把缓存的时间戳补给模组那条，模组的 index 仍然保留（删除走 `AT+CMGD`，不能换成缓存的负数 index）。同一「号码+正文」在模组里有多条时按游标逐条配对，不误消。
- **feat(sms)**: 借位置的消息日期并入当天，不再在时间轴中间插一条「时间未知的消息」分隔把一次来回劈成两半。
- **fix(sms)**: 气泡宽度原先写成「不超过 80%」的**块级元素**，而块级元素默认占满可用宽度，导致 `margin-left: auto` **完全失效** —— 发出的消息贴不到右边，看上去与收到的没区别；改为 `width: fit-content` 后左右分列才真正成立。这是自气泡存在起就一直错着的样式，不是新功能。
- **feat(sms)**: 日期由分隔条承担后，气泡内**只留时刻**（原先每条都重复一遍年月日）；时间未知的消息归拢到末尾的「时间未知的消息」分隔下。
- **feat(sms)**: 「删除」按钮改为**悬停显现**（触屏设备常显），不再让红色按钮盖过正文。
- **fix(sms)**: **存储用量仍显示 0 / 0** —— 上一版只改了响应正则，实机验收发现**请求本身就没成功**：前端发的是私有前缀 `AT^CPMS?`，本模组（MT5700M-CN）不认私有前缀，**直接回 ERROR**（同项目的「短信设置」页一直用的就是标准写法，此处系笔误）。改用标准 `AT+CPMS?`；响应侧保留 `[\^+]CPMS` 双前缀匹配，兼容个别回私有前缀的固件。

### 推送文案：短信与来电换成喵系口吻

- **chore(notify)**: 短信与来电提醒的首行换成更口语化的写法 —— 短信 `喵呜～，有新短信到啦！快来看看是谁给你发消息了喵~`、来电 `喵呜～有电话打进来啦，快接起来看看是谁找你喵！`；`{sender}` / `{content}` 等占位符与后续行不变。同步更新 Rust `DEFAULT_TPL_SMS` / `DEFAULT_TPL_CALL`、前端「恢复默认文案」内置值、包内 UCI 默认配置注释与 README 示例。
- **note**: **已自定义过文案的设备不受影响** —— 后端只在 `notify_tpl_sms` / `notify_tpl_call` 为空时才回落默认值（`config.rs` 的 `tpl()`）。想让实机也换成新文案，把这两项清空即可：`uci -q delete at-webserver.config.notify_tpl_sms`（来电同理）。

### 其它

- **test**: `cargo test` **130 passed / 0 failed / 2 ignored**；`sms-center-render.js` **36 通过 / 0 失败**；`simulate-push.js` **40 通过 / 0 失败，1 项观察**；`cargo build --release` 成功（仅 2 条既有 `dead_code` 告警）。
- **test**: `sms-center-render.js` 的桩**刻意让私有前缀 `AT^CPMS?` 返回失败** —— 前端一旦退回该写法，存储用量断言会立刻挂掉。会话断言由「分区顺序」整段改为「单时间轴」：断言不再存在 `mt5700-sms-section`、日期条格式、左右气泡方向、气泡内只留时刻。
- **test**: 排序修复加了两条互补断言 —— ① 会话 A（模组有该条、本机无缓存）必须渲染成 **收-发-收**，且借位置那条仍如实标「时间未知」；② 预置一条带本机发送时刻的缓存记录，断言它被**吸收**（气泡仍是 3 条不重复）且发出那条拿到了本机时刻。为此让 `parse.js` 的 vm 沙箱与 `sms_center.js` **共用同一个 localStorage** —— 两边各拿一个空 store 的话，缓存路径根本测不到。
- **fix(test)**: **模拟模组的服务小区查询多写了一个问号** —— 夹具写成 `AT^MONSC?`，而后端 `urc::query_monsc` 与前端 `network_status.js` 发的都是 `AT^MONSC`（不带问号）。命令匹配不上便回落到 `AT^HCSQ?`，巡检长期报出 `RSRP -140 dBm` 这种假读数（表面看是「信号极差」，实际是夹具没接上）。该缺陷只有在**第一次真正跑通信号巡检用例**时才暴露 —— 此前模拟环境从未触发过巡检。夹具现两种写法都认，并注明命令名必须与后端对齐。
- **test**: `simulate-push.js` 新增第 6 段「信号巡检推送」，端到端验证网络代际（`5G`）、具体频段（`n41`）、下行频点与带宽、四项指标齐全，且正文压缩后 ≤ 9 行。signalwatch 的 `run()` 是「先 sleep 再 tick」，故该用例需等满一个巡检间隔（取夹取下限 30 秒）。
- **security**: 本轮遵守 IMEI / 恢复出厂设置不可触碰的硬约束；新增的 `AT^HFREQINFO?` / `AT+CPMS?` 均为只读查询命令。
- **docs**: 新增 `docs/release-notes/v1.14.18.md`；README 同步版本号、功能矩阵与巡检推送内容说明。

## v1.14.17 (2026-10-12)

### 时间口径统一为系统时区（默认北京时间）

- **fix(time)**: **推送与日志时间整体早 8 小时** —— 根因有两层，缺一不可：① `TZ` 环境变量只由 `/etc/profile` 为**登录 shell** 导出，procd 拉起的守护进程拿不到；② 本固件不打包 tzdata（实机 `/usr/share/zoneinfo` 不存在），musl 的 `localtime_r` 在无 `TZ` 时**不报错、静默退化成 UTC**。表现为 SSH 里 `date` 是 `CST`、服务日志却是 UTC。
- **feat(localtime)**: 新增 `crate::localtime` 模块，三级回退解析本地偏移 —— `TZ` 环境变量 → `/etc/TZ` → `uci -q get system.@system[0].timezone` → 默认 `CST-8`（北京时间 UTC+08:00）。启动即打一条「时区: CST-8 → UTC+08:00」，未配置时打「未配置时区，使用默认北京时间 UTC+08:00（默认）」，让口径在日志里可见而非靠猜。
- **feat(initd)**: `/etc/init.d/at-webserver` 按**完全相同的顺序**取值，并通过 `procd_set_param env TZ=...` 注入给后端，保证服务内外口径一致。
- **refactor(time)**: 后端所有 `chrono::Local` 调用点改走 `localtime::now()` / `chrono::DateTime<localtime::Tz>` —— `pdu`（短信时间戳解码）、`logger`（通知日志时间戳）、`schedule` + `schedconfig`（定时锁频判定与「下一次切换时刻」）。不再有任何一处隐式依赖进程环境。
- **docs**: README 新增「时区与时间口径」小节，写明取值顺序，并特别标注 **POSIX TZ 串符号与直觉相反**（`CST-8` = UTC+8，写成 `CST+8` 会得到 UTC−8，比不设时区更糟）。
- **verify**: 模拟环境两段断言形成闭环 —— ① 不给任何时区配置时，通知时间戳 == `Date.now() + 8h`（防「默认值不是北京时间」）；② 注入 `system.@system[0].timezone=UTC0` 后重启，时间戳整体回落 UTC（防「把默认值写死、无视系统设置」）。

### 巡检推送携带完整射频信号评估

- **feat(signalgrade)**: 新增 `signalgrade` 模块，把网页「射频信号质量」卡片的评估逻辑**完整搬到推送侧** —— 网络能力结论 + 场景说明、信号强度 / 信号质量 / 信噪比 / 综合四项评级，以及 RSRP / RSRQ / SINR / SIGNAL 四行「基准 ≥ 阈值 → 实测值 → 结论」对照。原来只报一个 RSRP 数值，不足以判断链路是否真的可用。
- **refactor(urc)**: `parse_signal_reading()` 与评估模块**共用同一套换算与分级规则**，否则同一组读数会在网页与推送里给出两个不同的结论。
- **docs**: README 巡检小节补充推送内容说明。

### 短信中心：会话内收发分区排列

- **feat(sms)**: 同一联系人的对话改为**两块分区**渲染 —— 上区只放收到的短信、下区只放发出的短信，各自按时间升序，中间以分隔标题（「收到 N 条」/「发出 N 条」）区分；会话列表按最近联系时间**倒序**。原实现收发交错，会让「哪条是自己发的」难以辨认，群发场景下更会与对面的消息挤在一起。
- **fix(sms)**: **存储用量永远显示 0 / 0** —— 前端请求的是私有命令 `AT^CPMS?`，模组按惯例回 `^CPMS: "SM",<used>,<total>,...`，而原正则只匹配标准前缀 `+CPMS`。改为 `[\^+]CPMS` 后正常显示（模拟环境已复现并回归）。
- **fix(notify)**: **号码三处口径不一致** —— 推送侧 `8613800138000`、来电 `+8613800138000`、界面 `13800138000`。新增 `notify::normalize_phone_number()`，与前端 `Parse.normalizePhoneNumber` **同规则**（剥 `+`、去国家码 `86`、只留数字），三处归一。
- **feat(sms)**: 时间标注按证据强度分档 —— 发出短信的 PDU（SMS-SUBMIT）**没有发送时刻**，只有相对有效期时标「时间未知」，有绝对有效期时标「（有效期时间，非发送时刻）」，收到的短信有 TP-SCTS 才显示时刻。不编造时间。
- **verify**: 新增 `tests/mock-modem/sms-center-render.js`（极简 DOM 桩 + 真实前端代码 + 真实 PDU 夹具）**32 通过 / 0 失败**，覆盖分区顺序、区块标题、空态、时间未知标注、存储用量、会话排序。

### 测试通知文案

- **chore(notify)**: 「发送测试通知」文案改为 `喵～测试通知来啦！推送通道一切正常，链路畅通无阻喵！`。

### 测试基建（仓库内可复现，不依赖实机）

- **test**: 新增 `tests/mock-modem/` 离线模拟链路 —— mock 模组（TCP AT 口）→ 真实 Rust 后端 → 假 `uci`（**用 rustc 编译的独立可执行文件**，规避 Windows 上 `Command::new("uci")` 只补 `.exe`、`.cmd`/`.bat` 找不到的问题）→ 本地 WebHook 服务器。
- **test**: 配套 `sms-fixtures.js`（**唯一来源**的 PDU 夹具，mock 模组与前端渲染测试共用，避免样本漂移）、`hook-server.js`、`simulate-push.js`、`run-sim.sh`、`render-shot.py`（Playwright 截图）。
- **test**: `simulate-push.js` **31 通过 / 0 失败**，覆盖短信实时直发（实测 434~453 ms，远小于 5000 ms 合并窗口）、来电振铃/挂断、两段时区口径、测试通知文案，以及事后安全审计。
- **fix(test)**: PDU 夹具修正一处规范细节 —— `3GPP TS 23.040` 里**地址长度字节是普通二进制（半字节计数），不是 BCD**，只有 TP-SCTS / 绝对 TP-VP 的时间字段才是交换半字节 BCD。夹具最初把地址长度也写成 BCD，导致首个 PDU 解析整体失败；这类错误在实机上只表现为「短信列表空白」，排查成本极高。

### 安全约束：IMEI 与恢复出厂设置不可触碰

- **security**: 针对该硬约束落地**三层护栏** —— ① mock 模组 `FORBIDDEN` 命令表（IMEI/序列号写入、恢复出厂、复位一律回 `ERROR` 并留日志）；② 测试脚本 `assertSafe()` 在下发**前**拦截；③ 事后 `auditModemCommands()` 扫描整轮全部下发命令。当前审计结果：**扫描 23 条，危险命令 0 条**（被拒 3 次均为护栏自检）。只读的 `AT+CGSN` / `ATI` 保留，后端设备识别不受影响。

### 其它

- **test**: `cargo test` **126 passed / 0 failed / 2 ignored**；`cargo build --release` 成功（仅 2 条既有 `dead_code` 告警，原 `render_report` 告警已清零）。
- **docs**: 新增 `docs/release-notes/v1.14.17.md`；README 同步版本号并补充上述能力的配置说明。

## v1.14.16 (2026-10-11)

### 信号定时巡检（本轮核心修复）

- **fix(notify)**: **「信号变化通知」开关在实机是死的** —— 排查发现本模组（TDTECH / Fibocom 系）**不会主动上报** `^HCSQ` / `^CERSSI`：实机 1200 条 AT 记录里自发信号上报为 **0 条**，前端轮询也从不发这两条查询，因此 `Dispatcher::handle_signal()` 从未被调用。新增 `signalwatch` 模块，由后端在**用户指定时段内主动轮询**，让该开关真正生效；**时段外一条 AT 都不发**。
- **feat(config)**: 新增 6 项 UCI：`notify_poll_enabled`（默认 1）、`notify_poll_start`（默认 `00:00`）、`notify_poll_end`（默认 `23:59`）、`notify_poll_interval`（默认 300 秒，夹取 30~3600）、`notify_poll_all`（默认 0）、`notify_poll_delta`（默认 3 dB，夹取 1~30）。
- **feat(signalwatch)**: 时段判定支持三种形态 —— 普通区间、**跨零点**（`22:00-06:00`）、起止相同（视为全天）；格式非法时回落全天并记一次告警，避免因笔误彻底静默。区间取**闭区间**（两端都算在时段内），否则默认全天 `00:00-23:59` 会漏掉当天最后一分钟。
- **feat(signalwatch)**: 睡眠按 ≤30 秒切片，保证时段边界最多迟到 30 秒生效，而不是等满一个（最长 1 小时）的轮询间隔。
- **feat(signalwatch)**: 两种推送策略 —— 「每次巡检都推送当前状态」与「仅信号变化时推送」。后者的**基线只在推送时刷新**：若每次读数都刷新基线，信号从 -80 缓慢漂移到 -95（每次仅差 2 dB）将永远越不过阈值，用户反而收不到「信号持续变差」这个最该知道的通知。首次读数恒定推送一次，让用户立刻确认功能在工作；制式切换（LTE ↔ NR）必定推送。
- **refactor(urc)**: 抽出纯函数 `parse_signal_reading()`，URC 分发与定时巡检**共用同一套换算规则**（LTE 的 RSRP 取下标 2、其余制式取下标 1、255 视为不可测、`RSRP = raw - 140`），否则同一信号会出现两个不同的 dBm 值。
- **feat(luci)**: 通知卡片新增「信号定时巡检」子区块（启用开关 / 时段起止 / 巡检间隔 / 推送策略 / 变化阈值），时段用 `type=time` 输入；`setTimeInput()` 对 UCI 里手改的 `8:30` 这类值补零归一，与后端回落策略一致。
- **verify**: 实机以「每次巡检都推送」+ 30 秒间隔复验，确认 QQ 端真实收到巡检推送；关闭总开关后确认不再产生任何出站请求。

### 自动推送总开关（用户可手动启停）

- **feat(config)**: 新增 UCI `notify_enabled`（默认 `1`）。关闭后**不再外发任何消息**，但仍写本地通知日志（关的是「推送」而不是「记录」，便于事后追溯）；同时停止信号定时巡检，不再周期性占用串口。
- **feat(notify)**: `Notifier::notify()` 改为三级优先判定：总开关 → 事件类型开关 → 通道可用性。`flush_all()` 同样在总开关关闭时丢弃待发队列并留痕（事件可能在入队之后才被关掉，此时保留队列已无意义）。
- **feat(luci)**: 服务配置页通知卡片新增「自动推送总开关」（置于最前），关闭时**联动置灰**四个事件类型开关与整块巡检子区块，让「哪些项当前不起作用」在界面上一目了然。

### 短信 / 来电实时推送（不等合并窗口）

- **feat(notify)**: 短信与来电改走**实时直发**路径（`send_realtime()`），不再进入合并窗口。这两类是「错过了就没意义」的事件；信号与存储满保持合并窗口，避免把 QQ 主动消息频控（单关系 20 条/分钟）打满。
- **fix(notify)**: 通道尚未就绪（QQ bind 模式未绑定）时，实时事件仍会入队而不是直接丢弃，绑定成功后由 `flush_all` 补发，保持「绑定前后事件零丢失」。
- **verify**: 端到端回归用例把合并窗口设为 10 秒，断言短信/来电在 2 秒内即送达本地 WebHook —— 一旦退回入队路径，用例必然失败。

### 其它

- **test**: 新增 29 个单测与回归用例（`signalwatch` 时段判定与推送策略、`config` 轮询读取与夹取、`urc` 信号解析、`notify` 总开关与实时直发）；`cargo test` **85 passed / 0 failed / 2 ignored**。
- **docs**: README 补充自动推送总开关、实时推送与定时巡检的配置说明与 UCI 示例。

## v1.14.15 (2026-10-11)

### QQ 机器人推送「未接入任何推送数据」根因修复（核心）

- **fix(notify)**: **修复 `Notifier::run()` 启动即退出的队列死锁缺陷** —— 原实现在任务启动时若判定「没有任何可用通道」就 `return`，该任务的 `mpsc::Receiver` 随之被丢弃，此后 `notify()` 侧 `try_send` 全部失败（队列入口永久关闭）。bind 模式下用户按推荐流程发消息完成绑定后，`set_qq` 虽然热替换了发送器，但**入口早已关闭**，表现为「绑定成功却收不到任何推送数据」——这正是「机器人推送未接入任何推送数据」的真实根因，与推送通道本身、凭据、频控均无关。
- **fix(notify)**: 合并窗口任务改为**恒定运行**，不再因启动时无通道而退出；新增 `dispatch_enabled()` 把「绑定模式待绑定」（`qq_bind_pending`）也计入可用性，通道是否真的能发出去交由发送时刻判定。`flush_all` 在通道为空时**保留队列**（原实现会清空），绑定成功那一刻把窗口内积压的事件补发出去，做到绑定前后事件零丢失。
- **verify**: 实机 bind 模式全链路复验：改配置 → 重启 → 出站文本日志确认推送内容正确 → QQ 端 HTTP 200 送达。

### 推送频率（合并窗口）可配置

- **feat(config)**: 新增 UCI `notify_interval`（秒），默认 60，取值双向夹取到 `5~3600`；原硬编码常量 `NOTIFY_INTERVAL` 改为 `DEFAULT_NOTIFY_INTERVAL_SECS` / `MIN` / `MAX` 三常量。
- **feat(luci)**: 服务配置页通知卡片新增「推送频率（合并窗口）」数字输入（`min=5` / `max=3600`），附「窗口内多条事件合并为一条推送」说明。
- **verify**: 实机写入 `notify_interval='15'` 并重启，启动日志输出「通知合并窗口: 15 秒（事件在该窗口内合并为一条推送）」，确认配置真实生效。

### 自定义推送文案模板

- **feat(config)**: 新增 `NotifyTemplates` 结构 + UCI 六项：`notify_tpl_prefix`（全局前缀）、`notify_tpl_sms` / `_call` / `_signal` / `_memory` / `_batch`（五类事件模板）。支持占位符 `{sender}` / `{content}` / `{time}` / `{kind}` / `{count}`，**未知占位符原样保留**（便于发现拼写错误）；`MemoryFull` 事件正文为空时回落「短信存储空间已满」可读文本。原 `combine_messages` 写死的排版逻辑全部由模板驱动。
- **feat(config)**: 新增 `unescape_template()` —— UCI 单行限制下，模板中的换行以 `\n` 转义写入 UCI，后端读取后还原（支持 `\n` / `\t` / `\r` / `\\`，未知转义序列原样保留）；转义（写入方向）由前端负责，避免两侧逻辑互相覆盖。
- **feat(luci)**: 服务配置页新增「推送文案」卡片：全局前缀 + 五类事件共 6 个输入框、占位符说明、「恢复默认文案」按钮（内置 `TPL_DEFAULTS` 与 Rust 侧 `DEFAULT_TPL_*` 严格对齐）；新增 `tplToUci()` / `tplFromUci()` 双向往返转换，与后端 `unescape_template` 约定一致。
- **verify**: 前端转义往返用例 7 例全通过（含多行、反斜杠、空值、未知序列）；实机配置前缀 `[MT5700 验证]` + 模板 `{kind}｜{time}｜{content}`，出站文本日志与 QQ 端实收内容一致。

### 推送文案不再携带插件名

- **fix(notify)**: 「发送测试通知」文案由 `[luci-app-mt5700] 测试通知：推送通道链路正常` 改为 `测试通知：推送通道链路正常`；`#[ignore]` 冒烟用例文案同步去掉前缀。
- **fix(qqbind)**: 绑定成功确认消息由 `[luci-app-mt5700] 绑定成功（QQ 号标签: xxx）：…` 改为 `绑定成功（QQ 号标签: xxx）：后续通知将推送到本会话`。
- **verify**: 新交叉编译产物全量检索 `luci-app-mt5700` 命中数 **0**（旧二进制命中 4 处文案）；实机测试通道出站文本日志确认为 `[MT5700 验证]\n测试通知：推送通道链路正常`，无插件名。

### 出站文本可观测（排障能力）

- **feat(log)**: 合并推送与测试通道均记录**实际发出的文本** —— `推送内容（合并 N 条）: …` / `推送内容（测试通道 qq）: …`。此前排障只能看到「QQ 机器人通知发送成功」，无法得知文案模板究竟渲染成了什么；现在日志页可直接核对占位符替换结果与合并内容。（日志环形缓冲 1200 条且被 AT 指令追踪日志高速占满，建议事件发生后立即查看。）

### 验证与影响面

- **verify**: `cargo test` **56 passed / 0 failed / 2 ignored**（新增 `unescape_template` 三例、默认模板占位符、间隔上下界、模板渲染占位符替换、未知占位符保留、存储满正文回落、批量标题拼装、空前缀输出，以及 `merged_push_renders_template_and_posts_to_webhook` —— 本地 TCP 监听模拟 WebHook 接收端，断言「事件 → 入队 → 合并窗口 → 模板渲染 → HTTP 投递」整条链路**真正发出的报文内容**，是该缺陷的直接回归保护）；`node --check service.js` 通过；`cargo zigbuild --release --target aarch64-unknown-linux-musl` 交叉编译通过，实机（ImmortalWrt SNAPSHOT / mediatek filogic / aarch64_cortex-a53）部署后 md5 一致、服务正常重启。
- **未触碰**：IMEI 相关代码与数据流、`AT+EGMR` 等身份类指令，全部保持原样。

## v1.14.14 (2026-10-10)

### 网络状态页互联网承载选择修复（APN/QCI/AMBR 显示错承载）

- **fix(network-status)**: **修复「取编号最小激活 cid」导致选中 IMS 信令承载的真实缺陷** —— 原实现 `resolveActiveCid` 对 `AT+CGACT?` 的激活 cid 取 `Math.min`，而多数卡机组合下 IMS 信令承载（APN=`ims`，QCI=5，30/30 Mbps）的 cid 恰好最小，APN / QCI / AMBR 三项因此全部显示成信令承载的假数据，真正的互联网数据承载（如 `3gnet`，QCI=6，3000/300 Mbps）被跳过。现改为 `resolveDataBearer`：遍历**全部激活 cid** 逐个查询 `AT^DSAMBR=<cid>`（APN=第 4 字段、速率 kbps），**跳过 APN 为 `ims`/`sos`/`emergency` 的承载**锁定互联网承载；兜底策略为取下行速率最大的承载（APN 全部缺失或查询失败时仍能落到数据承载）。QCI 查询同步使用该承载 cid 定位 `AT+CGEQOSRDP` 对应行，失败回落首行。
- **refactor(network-status)**: 移除死代码 `resolveActiveCid` 与 `state.activeCid`（新逻辑统一走 `resolveDataBearer` + `state.dataBearer` 缓存），原「候选 [cid,1] 逐个试 + throw done/break」的探测链路一并删除。
- **verify**: `node --check` 语法通过；实机部署验证 md5 一致，网络状态页 APN/QCI/AMBR 正确显示互联网数据承载数据。

### 通知模块新增「QQ 机器人」推送通道（官方 API v2）

- **feat(notify)**: 新增 QQ 机器人推送通道，复用既有通知链路（`NotifyKind` 四类事件、60 秒合并窗口、`NOTIFY_MAX_RETRIES=3` 重试与指数退避）。鉴权按官方文档实现：`POST https://api.bot.qq.com/app/getAppAccessToken`（body `{appId, clientSecret}`）换取 `access_token`（7200 秒，官方示例 `expires_in` 为字符串，已兼容字符串/数字两种返回），后续请求携带 `Authorization: QQBot <token>` 头；服务内凭证缓存并在过期前 120 秒锁内单飞刷新，避免并发重复取凭证。
- **feat(notify)**: 目标类型三选一：群 `POST /v2/groups/{group_openid}/messages`、单聊 `POST /v2/users/{openid}/messages`、频道 `POST /channels/{channel_id}/messages`，文本消息 `msg_type=0 + content`，未知目标类型回落群聊。失败重试时会连同非 2xx 响应体前 300 字符一并记日志（QQ openapi 错误码在其中），便于排障。
- **feat(config)**: 新增 UCI 配置 `qq_app_id` / `qq_app_secret` / `qq_target_type` / `qq_target_id`；密钥支持环境变量 `QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET` 注入且优先于 UCI，避免凭据落盘。
- **feat(luci)**: 服务配置页通知卡片新增 QQ AppID / AppSecret（密码框）/ 目标类型 / 目标 ID 四个表单项，沿用既有 `Mt5700.formGroup` 风格与「保存并应用」链路。
- **feat(qqbind)**: 新增后端自动绑定模式 —— UCI `qq_target_type='bind'` 时服务启动自动连接 QQ WS 网关（`GET /gateway` → Hello(op=10) → Identify(op=2, intents `1<<25`)），监听 C2C/群消息事件：用户向机器人发一条消息，即从事件中提取 `user_openid` 写回 UCI（`qq_target_type='c2c'`、`qq_target_id=<openid>`，经 `tokio::process` 执行 `uci set/commit`）并热替换运行中的 QQ 通道实例（无需重启）。**绑定成功后立即通过新通道向用户回发一条确认消息**（「绑定成功…后续通知将推送到本会话」，含 QQ 号标签；主动推送不依赖 WS 会话，发送失败仅记日志不影响绑定生效）。UCI `qq_bind_qq` 仅作标签备注（平台事件拿不到 QQ 号）。写 UCI 失败仍热生效，下次重启自动重试；600 秒窗口未收到事件则放弃等待。
- **feat(rpc)**: 新增 `mt5700` ubus 方法 `notify_test`（参数 `channel`：`qq` / `wechat`），直发测试消息并**绕过 60 秒合并窗口**，返回逐通道成功/失败结果；失败时附具体错误（含 QQ 鉴权/发送接口的业务码与响应体摘要）。`Notifier::send` / `send_webhook` 改返回 `Result<(), String>` 以支撑结果反馈。
- **feat(rpc)**: 新增 `mt5700` ubus 方法 `qq_bind_status` —— 返回绑定进度（`state`：`idle` / `waiting` / `success` / `failed`、`left`：等待中剩余秒数（600 秒窗口倒计时）、`target_type` / `target_id`（成功时）、`error`（失败原因）），供 LuCI 轮询展示。
- **feat(luci)**: 通知卡片新增「发送测试通知」按钮 —— 按已配置通道（企业微信 webhook / QQ 机器人）并行探测，逐通道展示成功或失败原因，链路为 service.js → rpcd ucode 代理（busybox timeout 12s 上限）→ Rust TCP RPC。QQ 表单同步新增 `bind` 目标类型选项与「绑定 QQ 号」字段；**新增「绑定进度」区域**：每 2 秒轮询 `qq_bind_status`，实时展示等待中倒计时、绑定成功目标（openid 截断显示）与失败原因，页面卸载自动停止轮询；ACL 白名单增补 `notify_test` / `qq_bind_status`。
- **已知限制**（文档已注明）：本服务为单向推送、不连 WebSocket（仅绑定模式短暂连网关抓 openid），推送消息均为**主动消息**，受官方频控（群 30~60 条/分钟、单关系 20 条/分钟、1000 条/群/天）与用户端「允许主动发送」开关约束；频道主动推送官方要求机器人保持 WebSocket 在线，`channel` 模式可能被平台拒绝；QQ 号不能直接当 openid 使用（实测 code 11255），必须经绑定流程获取。
- **verify**: `cargo test` **42 passed / 0 failed / 2 ignored**（新增 QQ 通道与绑定测试：URL 按目标类型路由、未知类型回落群聊、凭据缺失不启用、目标类型归一化、`expires_in` 双类型解析与倒计时窗口、令牌刷新余量、`parse_token_response` 业务码显式检查成功/失败、绑定事件等价性与 brief 截断；另 2 项真实接口冒烟用例以 `#[ignore]` 标记、凭据走环境变量）；`node --check` 校验 `service.js` 语法通过。真实链路实测：鉴权 → C2C 推送 HTTP 200 消息送达；`getAppAccessToken` 错误 Secret 返回 HTTP 200 + 业务码 `100016`，已显式拦截。
- **deps**: Rust 侧新增 `tokio-tungstenite`（0.24，`rustls-tls-webpki-roots` + `connect` 特性，复用 ureq 的 rustls 栈）与 `futures-util`（`sink` 特性）用于绑定模式的 WS 连接。

## v1.14.13 (2026-10-10)

### 无模组场景解耦、`/dev/serial/by-id` 稳定路径与 AT 口判定修复

- **fix(serialdetect)**: **修复 AT 口判定被「Application」误命中的真实缺陷** —— 原实现用 `iface.contains("AT")` 找 AT 口，而实机接口名由模组固件写为 `TDTECH Connect - PC UI Interface` / `TDTECH Connect - Application Interface`：`PC UI` 中间有空格导致 `contains("PCUI")` 不命中，反过来 `Applic**at**ion` 含子串 `at` 导致 `contains("AT")` **误命中**。后果是 Application 口（1 分）排在真正的 PC UI 口（2 分）**前面**，自动探测先试错口、白等一个 800ms 超时；若某些固件的 Application 口恰好应答 `OK`，更会直接把错口选成 AT 口。现改为**按非字母数字切 token 后整词匹配**（`AT` 必须是独立词），并新增 `pcui_must_outrank_application` 等回归用例。实机验证：候选序首位由 `if13(Application)` 纠正为 `if12(PC UI)`，探测**首次即命中**（日志中零「无有效应答」跳过记录）。
- **feat(serialdetect)**: **新增 `bInterfaceProtocol` 二级兜底判据** —— 接口名字符串缺失（部分 OEM 固件留空）或无法识别时，回退读 USB 接口描述符的 `bInterfaceProtocol`：`0x12`=PC UI/AT 口、`0x14`=GPS（明确排除）、`0x13`/`0x1b`/`0x1c`=Application/SerialB/SerialC（已知非 AT 口）。该值写死在模组固件中，换 USB 口、换 xHCI 控制器、换主机均不变，比接口名更耐改版。
- **fix(serialdetect)**: **新增强弱信号分级与协议号交叉校验** —— 实测发现多个口可能同时命中 AT 判据（如某 OEM 把数据口也描述成 `AT Port`），此时排序退化为字典序、选谁纯属巧合。现把 `PCUI` / `PC UI` / `ATPORT` 归为**强信号**（专有叫法，直接采信），`AT` / `Modem` / `Command` 归为**弱信号**：弱信号若被协议号 `0x13/0x14/0x1b/0x1c` 明确否决，则改取协议号结论。既避免伪 AT 口抢位，又避免名字误判被反向压掉。
- **fix(serialdetect)**: **修复 by-id 路径无法解析接口名** —— `/sys/class/tty/` 下只有真实内核设备名，没有符号链接入口；原实现直接 `trim_start_matches("/dev/")` 拼接会得到 `/sys/class/tty/serial/by-id/.../device` 这种不存在的路径，导致接口名永远取不到、by-id 路径拿不到 AT 口优先权。新增 `resolve_tty_name()` 先 `canonicalize` 解出实体名再查 sysfs。
- **feat(by-id)**: **新增 `/dev/serial/by-id` 稳定设备路径支持** —— 探测顺序改为三层：① `by-id` 稳定链接（编号漂移免疫，优先）→ ② `ttyUSB*`/`ttyACM*`/`ttyAP*`（回退）→ ③ `ttyS*`/`ttyAMA*`（仅在完全无 USB 串口时）。排序元组扩为四元 `(接口分, 是否非by-id, 编号偏好, 序号)`，同分时稳定路径必定排在裸编号之前。前端下拉框按 `<optgroup>` 分组呈现「稳定路径（推荐）」与「内核编号（可能随插口变化）」，用户所选路径照常持久化到 UCI `serial_port`。
- **feat(init.d)**: **新增 `sync_serial_by_id` 维护稳定链接** —— 本机（ImmortalWrt SNAPSHOT, mediatek/filogic）既无 udev 也无 mdev，没有任何组件会创建 `/dev/serial/by-id`，故由 init.d 在服务启动时自行枚举 USB 接口并重建链接，映射到 `bind_modem_serial` 之后、接口拉起之前执行。
  - **命名取组合键 `usb-<idVendor>:<idProduct>-if<协议号>[-<iSerial 片段>][-n<N>]`**：`bInterfaceProtocol` 作主键（设备内互不相同、跨主机不变），`iSerial` 仅作可选区分片段——因为**同型号模组的 iSerial 不保证唯一**（出厂批次号+序号，可能重复甚至为空），单靠它无法区分同型号多台设备。
  - **兜底设计**：`iSerial` 为空时自动降级为不带该片段；**同型号撞名时追加 `-n2`/`-n3` 去重后缀**，保证不会互相覆盖；整批清理 `usb-*` 后重建（增量维护无法判断拔出设备对应哪个旧链接）；`ln -sf` 后以 `readlink -f` + `[ -c ]` 校验，失败即删除，避免留下断链。
  - **健壮性**：`sanitize_id_part` 清洗非法字符并将「纯点号」结果作废（`.`/`..` 在路径语义中危险）；`to_hex2` 因 **busybox `tr` 对 POSIX 字符类解析有缺陷**（`tr -d '[:space:]'` 会把 `s/p/a/c/e` 当字面字符删除、`tr '[:upper:]' '[:lower:]'` 完全无效），改用 `sed` 清洗 + `tr 'A-F' 'a-f'` 显式区间写法。
  - **注意**：`EXTRA_COMMANDS` 中登记的命令名**必须与同名函数完全一致**（rc.common 末尾执行 `$action "$@"` 按名查找函数），否则抛 `xxx: not found` 而非「未知命令」。
- **fix(acl)**: rpcd ACL 增补 `/dev/serial`、`/dev/serial/by-id`、`/dev/serial/by-id/*` 的 `list`/`stat` 权限，使前端能枚举稳定路径。
- **scope**: 未触碰任何 IMEI 相关代码与数据流（`modem_settings.js` 的 `AT+CGSN` 读取、`AT^PHYNUM=IMEI` 写入、四重验证与 `luhnValid` 全部原样）；未引入新的外部依赖（Rust 侧零新增 crate，shell 侧仅用 busybox 自带命令与 ucode `fs` 模块）。
- **verify**: ① `cargo test` **47 passed / 0 failed**（含 `serialdetect` 14 项，此前因模块条件编译而在非 Linux 宿主上全部跳过）；② 交叉编译 aarch64-musl 产物经 ELF 头校验（`ELF64`/`EM_AARCH64`/`EXEC`）后部署实机，AT 调试终端执行 `ATI` 返回真实模组信息；③ 实机场景覆盖：正常识别 / 接口名缺失（协议号兜底）/ 全无信息（字典序+探测兜底）/ by-id 混入断链（自动排除）/ 他厂 MT5700 接口名重复命中（交叉校验纠正）；④ `sync_serial_by_id` 连续三次幂等复测均为 5 条链接、0 断链，AT 口正确映射到 `/dev/ttyUSB1`。
- **docs**: README 版本号与安装示例同步至 v1.14.13；新增 `docs/release-notes/v1.14.13.md` 发布说明。

## v1.14.12 (2026-10-10)

### 注释语义校正与来源表述清理

- **docs(comment)**: 前端与后端注释按代码实际行为逐条校正，并清除指向历史实现、设计稿与外部工程的来源性表述，使注释自足可读。
- **docs(frontend-js)**: 全量审查 `htdocs/luci-static/resources/` —— ①移除「原 WebUI / 原前端 / 等价 atx.ts 的 atErrorText」等对照字样共 17 处，涉及 `at-webserver/{ui,parse,smsEncode}.js` 与 `dial / modem_settings / network_settings / scan / schedule / terminal / upgrade` 视图；②清理含「原」字的对照表述共 16 处，涉及 `rpc.js / ui.js / parse.js / mt5700.js / mt5700.css / logs.js / modem_settings.js`；③依据代码实际校正 16 个文件的注释语义（`rpc.js` 的 `_dirty` 与 `uciCommit` 行为、`mt5700.js` 的 `gauge` 返回值与 `BAR_COUNT`、`ui.js` 的 `autoRefresh` 接口、`service.js` 的多源探测与状态枚举、`dial.js` 的自动拨号写入键、`network_status.js` 的双列栅格、`smsEncode.js` 的 134 octets → 67 字符等），并删除 9 个页面头部的版本对照说明。
- **docs(css)**: 澄清歧义样式注释 —— 将 dangling 设计稿引用与「旧实现」表述改写为自足技术说明。
- **docs(rust)**: 后端 16 个文件依代码实际校正注释 —— `logger.rs` 输出流为 stderr（`eprintln!`）而非 stdout、syslog 由 init.d 重定向产生；`serialdetect.rs` 去掉版本叙事、说明子串匹配会误判；`serial_linux.rs` 明确读写两半均由 `AsyncFd` 驱动并补 8N1 位域说明；`rpcserver.rs` 修正事件类型清单为 `urc_data / new_sms / incoming_call / pdcp_data / cellscan / raw_data`，补充 `logs / task_status / task_cancel / task_list` 方法；`schedule.rs` 的 `registered` 实际下发 C5GREG / CEREG / CREG；`pdu.rs` 补充 DCS 低 2 位消息类别与 `unpack_septets` 的 LSB-first；`atclient.rs` 的独占 URC 示例改为 RING / +CLIP / +CMTI / ^CEND；`notify.rs` 补全四类通知事件；`state.rs` 修正长命令分支返回语义；`config.rs` 明确 `type_` 回落、`bind` 优先级与 `scan_timeout` 的 UCI 键。
- **scope**: 仅注释与文档 —— 前后端逻辑、AT 命令流、样式规则与 IMEI 相关代码零改动。后端注释改动经 `cargo check` 通过；前后端差异经「剥离注释放逐字符比对」确认代码完全一致。
- **verify**: 每一处改动均以 `git diff` 过滤非注释行核验，确认无一行业务代码被修改。
- **docs**: README 版本号与安装示例同步至 v1.14.12；新增 `docs/release-notes/v1.14.12.md` 发布说明。

## v1.14.11 (2026-10-10)

### 前端样式代码全量审查与清理

- **chore(css)**: 删除已废弃的 `at-status-*` 死样式共 **276 行** —— 该类为「AT 服务状态卡片」组件样式，v1.14.3 已将该卡片从全部 10 个 LuCI 页面移除，但 `mt5700.css` 中的样式层未同步清理。本次删除：主题块 `L1633-L1917`（含 `.at-status-card` / `-icon` / `-title` / `-dot` / `-main` / `-description` / `-rpc*` 与 `is-online / is-connecting / is-offline / is-unknown` 状态变体及各断点响应式）、`@media (max-width)` 内残留单行规则、`@media (prefers-reduced-motion)` 内仅供该组类使用的动画禁用块。全仓库（JS / HTML）对该组类零引用，删除为纯清理，渲染零影响。
- **style(css)**: 统一缩进风格 —— 运行日志页段（`L3136-L3590`，共 270 行）原为 Tab 缩进，与文件其余 2000 余行的 2 空格风格割裂，本次统一为 2 空格。
- **docs(css)**: 补充日志页「分层结构」说明注释 —— `.mt5700-logtabs` / `-logtab` / `-logpanel` / `-loglist` / `-logfooter` 等选择器在文件中出现两次（基础层负责尺寸 / 字号 / 字体族 / padding，主题覆盖层负责 background / border / color / opacity），两层属性集基本不重叠、不可单独删除。已在两层起点各加注释说明意图，避免后续被误判为重复代码而误删。同时修正 `--mt5700-temp-*` 的注释（原指向样式块，实际样式层为硬编码取色），并标注 `--mt5700-shadow-*` 为兼容别名。
- **style(css)**: 修正注释错位 —— 第 2661 行孤立的 `/* 减少动态效果偏好 */` 与下文温度样式块语义无关，予以移除；清理删除操作产生的连续空行。
- **scope**: 仅前端 CSS 展示层 —— JS 逻辑、AT 命令与 IMEI 相关代码流零改动；`at.css` 经审查无重复定义、无 `!important`，未改动。
- **verify**: 实机（192.168.10.1）部署验证 —— 修改前后页面渲染输出逐项一致（卡片数 11、指标数 8、关键规则齐全），确认无回归。
- **docs**: README 版本号与安装示例同步至 v1.14.11；新增 `docs/release-notes/v1.14.11.md` 发布说明。

## v1.14.10 (2026-10-10)

### Argon 主题（2.4.x）兼容修复

- **fix(theme-compat)**: 修复 luci-theme-argon 2.4.8 下模块设置页面两处显示异常（issue #12，@unolejiongg 报告并提供已验证修复样式）：
  - **开关轨道异常**：Argon 对全局 `input[type=checkbox]` 施加高优先级样式，隐藏了插件开关的自绘轨道，仅剩白色圆形旋钮。在 `mt5700.css` 末尾新增「Argon 主题（2.4.x）兼容覆盖」块，以同等优先级 + `!important` 固定 44×24 轨道尺寸与底色（未选 `--mt5700-border-subtle` / 选中 `--mt5700-accent`），压制主题背景图与 `::after` 伪元素串扰，`::before` 旋钮位移恢复正常。
  - **下拉框文字偏下被裁切**：Argon 对全局 `select` 的高度与内边距覆盖导致选中项（如 VoNR「关闭」、网卡速率「自动协商」）文字垂直偏移并被裁切。新增 `select.mt5700-select` 覆盖规则：固定 40px 高度、`0 36px 0 12px` 内边距、`line-height: normal`，恢复文字垂直居中。
- **scope**: 仅前端 CSS 展示层 —— JS 逻辑、AT 命令与 IMEI 相关代码流零改动；其他主题（含 Aurora）显示不受影响。
- **style(review)**: 复核兼容块发现回归 —— 基础覆盖的 `background !important` 会压掉原有 hover / focus-visible / disabled 规则（无 `!important`），已在兼容块内补充同优先级状态覆盖，恢复悬停反馈、键盘焦点环与禁用态。
- **docs**: README 版本号与安装示例同步至 v1.14.10；新增 `docs/release-notes/v1.14.10.md` 发布说明。

## [未发布]

### CI 不再向仓库写入构建日志

- **ci(workflow)**: **移除「日志归档（推送构建日志到 ci-logs 分支）」步骤，云编译不再产出 `ci-logs-<fmt>-<arch>` 分支** —— 原步骤（`if: always()` + `continue-on-error: true`）会用 `git checkout --orphan` 创建 `ci-logs-<fmt>-<arch>` 孤儿分支，把 `build.log` / `deps.log` / `ARCH.txt` / `artifacts.txt` 推到该分支并 force push。移除后 Actions 不再向仓库写入任何内容，构建日志仅保留在 Actions 运行日志中（保留期由 GitHub 侧控制）。
- **ci(workflow)**: 编译 job 由 8 步缩为 **7 步**（检出代码 / 环境准备 / 依赖安装 / 构建执行 / 产物校验·架构一致性 / 产物校验·单包完整性 / 产物归档），发布 job 保持 9 步不变。`permissions: contents: write` 保留 —— 「清理同名旧 Release」与「发布 GitHub Release」仍需该权限，与日志推分支无关。
- **ci(concurrency)**: 并发组注释同步 —— 原注释列出两条并发风险（`ci-logs-*` 分支 force push 撞 ref CAS、release job 对同一 tag 并发 delete+create），现仅剩后者，故删除 `ci-logs` 相关描述；`concurrency` 配置本身（`group: build-${{ github.sha }}`、`cancel-in-progress: false`）不变。
- **docs**: 工作流头部注释新增「构建日志：不向仓库写入」说明。
- **chore(repo)**: 清理远端遗留的历史 `ci-logs*` 分支共 7 个 —— 由上述已移除的步骤产生（3 格式 × 3 架构 + 早期单一 `ci-logs`），现已一并从 `refs/heads/` 移除：`ci-logs`、`ci-logs-{apk,ipk}-{aarch64_cortex-a53,aarch64_generic,x86_64}`。删除远端分支不可逆，日志内容仅存于历史提交中。
- **note**: v1.14.7 的历史条目（含「日志归档」步骤与 8 步表述）作为版本事实保留不改，仅在必要时追溯；步骤已从当前代码移除。

## v1.14.9 (2026-10-07)

### 「修改 IMEI」按钮与「系统控制」操作条样式对齐

- **style(modem-settings)**: IMEI 卡片的「修改 IMEI」操作由独立按钮行改为复用「系统控制」的 `mt-sysctl-item is-danger` 操作条结构 —— 左侧红点标识 + 操作名 + 风险说明（四重验证确认后执行），右侧红色按钮（min-width 128px），与「恢复出厂设置」操作条的样式、尺寸与排版**完全一致**。
- **security(scope)**: 仍仅限前端 UI 展示层 —— `imeiEl` 节点、四重验证流程、`AT^PHYNUM` 写入命令与数据流零改动。
- **docs**: README 版本号与安装示例同步至 v1.14.9；新增 `docs/release-notes/v1.14.9.md` 发布说明。

## v1.14.8 (2026-10-07)

### 「设备标识（IMEI）」卡片排版优化（仅 UI 展示层）

- **style(modem-settings)**: IMEI 卡片排版重构 —— 「当前 IMEI」取值由 `mt5700-inline` 行内提示改为**带边框的取值展示块**（等宽字体放大至 16px、字距加宽、左右分栏 label + value），作为卡片视觉焦点置顶；「修改 IMEI」按钮右对齐独立成行；四重验证说明与法律风险提示作为次级信息移至底部，层级更清晰。
- **security(scope)**: 本次改动**仅限前端 UI 展示层** —— `imeiEl` DOM 节点、AT+CGSN 读取回填、四重验证流程（Luhn 校验 / 一致性 / 归属验证 / 最终确认）、`AT^PHYNUM` 写入命令与数据流完全未改动；页面加载与验证过程不触发任何 IMEI 写操作。
- **docs**: README 版本号与安装示例同步至 v1.14.8；新增 `docs/release-notes/v1.14.8.md` 发布说明。

## v1.14.7 (2026-10-07)

### CI 工作流细分化与汉化 + 关闭前端 JS 压缩

- **ci(workflow)**: 构建流程细分为粒度清晰的中文命名步骤 —— 编译 job 拆为「检出仓库代码 → 环境准备 → 依赖安装（Rust 工具链 + zig）→ 构建执行（SDK 编译）→ 产物校验（架构一致性闸门）→ 日志归档 → 产物校验（单包完整性）→ 产物归档」8 步；发布 job 的 9 个步骤全部汉化；workflow 与两个 job 均带中文名称，Actions 页面可直观查看进度与定位问题。
- **ci(sdk-build)**: `sdk-build.sh` 支持 `SDK_BUILD_PHASE=deps|build|all` 阶段划分 —— 依赖安装（基础工具 + Rust 工具链 + zig）与构建执行（SDK 定位 + 编译 + 产物收集）可分两个容器运行，/opt 工具链经宿主卷跨步骤持久化；`all` 模式保持原有单次完整构建行为兼容。各阶段输出中文横幅（【依赖安装 1/3】…【构建执行 5/5】）。
- **build(minify)**: **关闭前端 JS 压缩** —— 包级 `Makefile` 设置 `LUCI_MINIFY_JS:=0`（覆盖 luci.mk 默认值，JsMin 变为空操作宏），`sdk-build.sh` 在 .config 中显式写入 `# CONFIG_LUCI_JSMIN is not set`（双保险），并在 defconfig 后校验输出中文确认。构建产物中的 .js 保持未压缩源码，便于线上排查。
- **docs**: README 版本号与安装示例同步至 v1.14.7；新增 `docs/release-notes/v1.14.7.md` 发布说明。

## v1.14.6 (2026-10-07)

### 「系统控制」区域界面重构与高危操作分级确认

- **style(modem-settings)**: 重构「系统控制」卡片排版 —— 两项操作改为「信息 + 按钮」双栏操作条布局（名称色点标识 + 风险说明 + 右侧固定 128px 按钮），「重启模组」采用新增的**琥珀色警戒级按钮**（`mt5700-btn-warn`），「恢复出厂设置」保持**红色危险级按钮**，视觉层级清晰易区分；操作条分别以琥珀/红色渐变底色与描边区分风险等级。
- **feat(modem-settings)**: 「重启模组」点击后弹出具中断时长说明的确认弹窗，确认后才下发 `AT^RESET`。
- **feat(modem-settings)**: 「恢复出厂设置」点击后**连续弹出 3 次警告弹窗**（第 1 步告知配置清空范围 → 第 2 步告知断网后果 → 第 3 步最终高危确认），全部确认后才下发 `AT&F`；任一步取消即中止。
- **security**: 本次改动仅涉及前端 UI 展示与弹窗交互逻辑，命令下发路径未做任何变更，且默认不会自动触发任何重启/恢复出厂命令。
- **docs**: README 版本号与安装示例同步至 v1.14.6；新增 `docs/release-notes/v1.14.6.md` 发布说明。

## v1.14.5 (2026-10-07)

### 全站英雄区卡片紧凑化排版

- **style(ui)**: 英雄区卡片（`Mt5700.page` / `mt5700-hero-card`，全站 12 个页面共享）整体紧凑化 —— 内边距 24×28px → **18×24px**，插画区 160×120px → **124×92px**，标题 26px → **21px**，徽标 12px → 11.5px（内边距同步收紧），描述 13.5px → 13px，栅格间隙 24px → 20px，背景光斑 260px → 220px。桌面端英雄区高度由 **170px 降至约 130px**，内容区可视空间显著增加，视觉层级更聚焦于页面主体卡片。
- **refactor(ui)**: `mt5700-hero-content` 弹性基准 500px → 420px，与缩小的插画区比例协调；移动端（≤768px）竖排自适应规则保持不变。
- **docs**: README 版本号与安装示例同步至 v1.14.5；新增 `docs/release-notes/v1.14.5.md` 发布说明。

## v1.14.4 (2026-10-07)

### status 页底部卡片栅格修复：消除空位与孤行

- **fix(status)**: 修复 status 页底部双列栅格中 3 卡行产生的**空位与孤行** —— 「连接状态 + 辅载波信号遥测 + 连接诊断」「流量统计 + IP 与 DNS + 调制方式与空间流」两组 3 张卡在 2 列网格中换行，导致连接诊断右侧留空、调制方式与空间流孤行独占，视觉上呈「中间缺卡 + 末尾多卡」。
- **refactor(status)**: `mt-row-2col` 由 `repeat(auto-fit, minmax(min(100%,460px),1fr))` 改为**确定性 2 列** `repeat(2, minmax(0,1fr))`，与「桌面双列、窄屏单列」设计语义一致；新增 `@media (max-width: 900px)` 降级单列。
- **feat(status)**: 新增奇数末卡横跨规则 `.mt-row-2col > :nth-child(odd):last-child { grid-column: 1 / -1; }` —— 3 卡行的末卡（连接诊断、调制方式与空间流）自动横跨双列全宽，栅格无空位、卡片均匀对齐，11 张卡片数量不变。
- **docs**: README 版本号与安装示例同步至 v1.14.4；新增 `docs/release-notes/v1.14.4.md` 发布说明。

## v1.14.3 (2026-10-07)

### 全页面移除「AT 服务在线」连接状态卡片

- **refactor(ui)**: 按需求将「AT 服务在线 / AT 通信服务运行正常」状态卡片（`at-status-card`，含 RPC 地址芯片）从**全部 10 个 LuCI 页面**中移除 —— 删除各页面 render 中的 `connBar` 创建与 `Mt5700.renderConnectionBar()` 调用（dial / modem_settings / network_settings / network_status / scan / schedule / sms_center / sms_settings / terminal / upgrade）。
- **refactor(ui)**: `mt5700.js` 与 `ui.js` 中的 `renderConnectionBar` 实现统一改为**空操作 stub**（返回隐藏占位节点），任何历史或未来调用均不再渲染任何内容，确保任何页面都不再显示该卡片。
- **docs**: README 版本号与安装示例同步至 v1.14.3；新增 `docs/release-notes/v1.14.3.md` 发布说明。

## v1.14.2 (2026-10-03)

### status 页统一双列布局

- **style(status)**: 在 v1.14.1 基础上按反馈统一为**双列布局** —— 「连接状态 + 辅载波信号遥测 + 连接诊断」「流量统计 + IP 与 DNS + 调制方式与空间流」由 3 列并排改为 auto-fit 双列网格（桌面 2 张并排 + 第三张换行，窄屏单列堆叠）。
- **style(status)**: 「实时速率 + 速率曲线」「载波聚合 + 模组温度」维持双列不变；「射频信号质量」维持全宽不变。
- **refactor(status)**: 移除不再使用的 `mt-row-3col` 样式与响应式断点，网格子项 `min-width: 0` 防溢出规则保留。
- **docs**: README 版本号与安装示例同步至 v1.14.2；新增 `docs/release-notes/v1.14.2.md` 发布说明。

## v1.14.1 (2026-10-03)

### status 页排版紧凑化与手机端溢出修复

- **style(status)**: 「连接状态 + 辅载波信号遥测 + 连接诊断」由原双列 + 全宽结构重组为 **3 列并排**，提升桌面空间利用率。
- **style(status)**: 「载波聚合」与「模组温度」由全宽大卡重组为 **2 列并排**；「流量统计 + IP 与 DNS + 调制方式与空间流」3 列紧凑并排。
- **style(status)**: 「射频信号质量」「实时速率」「速率曲线」三张卡片保持原有全宽 / 双列布局不变。
- **feat(status)**: 3 列网格新增响应式降级 —— 1180px 以下降为 2 列、760px 以下单列堆叠。
- **fix(status)**: 网格子项补 `min-width: 0`，修复手机端「载波聚合 / 辅载波信号遥测」宽表格撑破卡片、被卡片 `overflow: hidden` 裁剪的问题 —— 表格改为卡片内横向滚动，页面不再水平溢出。
- **docs**: README 版本号与安装示例同步至 v1.14.1；新增 `docs/release-notes/v1.14.1.md` 发布说明。

## v1.14.0 (2026-10-02)

### 重新编译发布

- **chore(release)**: **清理历史 Release 并重新编译发布** —— 移除 v1.13.0 的 Release 与 tag，版本号提升至 v1.14.0，触发 CI 重新编译，确保 apk/ipk 产物与当前 main 分支完全对应。
- **docs**: README 版本号与安装示例同步至 v1.14.0；新增 `docs/release-notes/v1.14.0.md` 发布说明。

## v1.13.0 (2026-10-02)

### 全新白色毛玻璃 UI 设计系统重构与全页面美化

- **style(ui)**: **全套白色毛玻璃设计系统（White Frosted Glass）** —— 深度引入 CSS Backdrop Filters（`blur(24px) saturate(180%)`）搭配半透明纯白底色（`rgba(255, 255, 255, 0.78~0.82)`）、纳米级白边高光（`inset 0 1px 1px rgba(255, 255, 255, 0.95)`）与多重轻柔弥散阴影，全面提升科技质感与界面通透感。
- **feat(svg)**: **高品质动态 SVG 矢量矩阵** —— 为全站 12 个 LuCI 页面定制设计独立的科技感动态 SVG 插画徽标组件（`Mt5700.heroIllustration`），支持脉冲呼吸环（Pulse Glow）、全向扫描雷达（Radar Sweep）、双向数据波（Wave Expand）、量子齿轮旋转（Spin Slow）以及微光流溢（Shimmer）等流畅关键帧动效。
- **refactor(pages)**: **全量 12 个 LuCI 业务页面彻底重构**：
  - **网络状态 (network_status)**: 毛玻璃 Hero 概览卡片、动态 5G 信号脉冲、固定字号自适应频谱网格与优雅骨架屏（Skeleton）加载占位。
  - **网络设置 (network_settings)**: 全网频段锁频策略、NSA/SA 切换与 APN 专属配置卡片毛玻璃化。
  - **拨号设置 (dial)**: 双模拨号模式、协议优先级、网卡绑定配置卡片质感升级。
  - **全网扫频 (scan)**: 声呐雷达动态旋转扫频、小区信号强度阶梯展示与频点明细网格。
  - **定时锁频 (schedule)**: 自动化定时巡检、锁频规则时间轴与任务管理卡片透光重绘。
  - **模组设置 (modem_settings)**: 硬件信息概览、USB 链路速率、IMEI 四重验证与安全卡片重构。
  - **模组升级 (upgrade)**: 动态芯片插图、FOTA 升级检测、多色相分段进度条与语义状态横幅。
  - **短信中心 (sms_center)**: 拟态交互气泡、会话流式布局、快速发信面板与未读消息微光提醒。
  - **短信设置 (sms_settings)**: 短信中心号、Webhook 转发规则与存储容量告警卡片重绘。
  - **AT 调试终端 (terminal)**: 工业级高对比终端监视器结合毛玻璃指令操作面板与常用快捷指令。
  - **运行日志 (logs)**: 实时流式日志看板、日志级别分类筛选胶囊与毛玻璃控制栏。
  - **服务配置 (service)**: 后台守护进程控制台、TCP/串口探测模式与 RPC 安全认证卡片磨砂重构。
- **feat(responsive)**: **深度适配 PC 桌面与 PE 移动端响应式布局** —— 针对手机端窄屏（≤580px）优化单列弹性卡片排版、触控友好按钮与防溢出滚动；针对 PC 宽屏优化网格利用率与双列/多列对称布局。
- **i18n(zh_Hans)**: **全量补全汉化与本地化字典** —— 补齐 `po/zh_Hans` 与 `po/templates` 翻译文件，规范移动网络、5G 模组管理、运行日志及服务配置等菜单与页面文案，确保 100% 优雅中文呈现。


### 模组设置：自动识别并显示 USB 链路速率

- **feat(settings)**: 「模组设置」页设备信息表格新增 **USB 速率** 行，自动识别模组与路由器之间的 USB 链路速率并格式化为可读文案（如 `5.0 Gbps（USB 3.0）`），并一并展示模组 product 名称（如 `TDTECH MT5700M-CN`）。
- **feat(settings)**: 数据源直接走 **sysfs**（扫描 `/sys/bus/usb/devices/*/`，按 `idVendor ≠ 1d6b` 跳过 xHCI 根集线器后定位真实 USB 模组设备），**自动识别、不硬编码**设备路径 / 产品名；全程不下发任何 AT 命令，不占用 AT 通道、不干扰模组。
- **feat(rpc)**: 新增 `mt5700.usb` RPC 方法（rpcd ucode 插件内 `fs.popen` + busybox 一行脚本在设备侧枚举 USB 设备，本函数逐行解析 `speed` / `version` / `product`）；前置 `rpc.js` 封装 `AtWs.usb()` 与 `usbSpeedText()`（速率→规范名，如 5000→USB 3.0）。
- **feat(acl)**: rpcd ACL（`rpcd/acl.d/luci-app-mt5700.json`）仅给 `mt5700` 的 **read** 方法列表追加 `usb` 只读授权，无任何写入权限变更。
- **docs**: README 功能矩阵「模组设置」补充 USB 链路速率说明。

### 5G 状态页：载波聚合卡片重构

- **fix(status)**: 修复「载波聚合 (Carrier Aggregation)」卡片在窄屏/手机上文字过小难以阅读的问题 —— 频谱展示由「SVG 整体缩放」（1200 宽 viewBox 拉伸，窄屏字号被压缩到不可读）重构为**固定字号 HTML 频谱卡片网格**，字号不再随容器缩放。
- **feat(status)**: 新增**聚合总览条**：载波数徽章（单连接 / `CA N CC 已聚合`）+ 总带宽汇总，一眼可判聚合状态；多载波（PCC + 多 SCC）场景每载波一张卡片自动网格并排（窄屏自动换行）。
- **style(status)**: 每张频谱卡带主色渐变背景 + 左侧彩条 + 发光圆点：PCC 主载波青色强调、SCC 辅载波绿色区分；频点胶囊徽章右对齐、渐变带宽占用条 + 占比脚注；卡片与下方明细表保留（卡片给频谱概览、表格给信号数值）。
- **style(status)**: 射频信号质量四联仪表盘在手机端（≤580px）改为**两列一行（2×2）**排列，桌面端保持四列一行不变。

### 全网扫频：扫描前自动断开蜂窝数据，结束后自动恢复

- **feat(scan)**: 修复「全网扫频无法使用」——MT5700M 模组在数据业务激活状态下拒绝 `AT^CELLSCAN`（`+CME ERROR: operation not allowed`），导致扫频始终失败。
- **feat(scan)**: 后端（Rust）扫频任务自动执行「断连 → 扫描 → 恢复」三步：
  - 扫频开始前查询自动拨号开关/方式与 NDIS 数据面状态；数据激活时先 `AT^SETAUTODIAL=0` 关闭自动拨号、再 `AT^NDISDUP=1,0` 断开蜂窝数据，1.5s 后下发扫频命令；
  - 扫频结束（成功/失败/超时/取消）无条件恢复：原自动拨号开启则恢复 `AT^SETAUTODIAL=1,<原方式>`（模组自会重拨，不手动 NDISDUP 以免与自动拨号争用 CID）；原自动拨号关闭但数据原已激活则手动 `AT^NDISDUP=1,1`；
  - 恢复失败仅记 WRN 日志，由 autodial_watchdog 周期对账兜底，不会长期断网；
  - 扫频期间通过 `scan_active` 标志让拨号对账守护暂停，避免与扫频恢复逻辑抢 CID。
- **feat(scan)**: 前端扫频页开始前先查询数据面状态，数据激活时弹窗警告「全网扫频需要短暂断开蜂窝数据连接（仅扫描期间，结束后自动恢复），期间无法上网」，用户确认后才下发扫频命令；数据未激活（无卡/未拨号）不弹窗直接扫。
- **chore**: 本轮未改动任何 IMEI 相关代码与 AT 命令。

### 模组设置：IMEI 独立卡片与四重验证

- **refactor(settings)**: IMEI 从「设备信息」表格拆分为**独立卡片「设备标识（IMEI）」**，卡片内展示当前 IMEI（`AT+CGSN` 读取）与修改入口。
- **feat(settings)**: 改为显式按钮 + **四重验证确认**：输入新 IMEI（15 位数字 + Luhn 校验位验证）→ 密文再次输入确认一致性 → 输入当前 IMEI 后 6 位验证设备归属（当前 IMEI 读取失败时自动跳过此重）→ 最终确认弹窗。
- **chore(settings)**: 写入命令（`AT^PHYNUM`）与读取链路完全保持原实现，本轮仅重构 UI 交互层，不改动任何 IMEI 相关命令与数据流。

### AT 终端：常用命令新增 ICCID / IMSI 查询

- **feat(terminal)**: 「常用命令」新增「查询 ICCID」快捷按钮（`AT^ICCID?`，只读查询），置于「查询 SIM 状态」之后，点击后仍需二次确认再下发。
- **feat(terminal)**: 「常用命令」新增「查询 IMSI」快捷按钮（`AT+CIMI`，只读查询），置于「查询 ICCID」之后，点击后仍需二次确认再下发。

### 文档

- **docs**: README 版本号与安装示例同步至最新发布 v1.12.11（版本徽章、apk/ipk 安装包文件名、源码目录结构中的 PKG_VERSION 注释）。

## v1.12.11 (2026-09-30)

### 升级页可视化（让检测 / 进度一眼可读，业务逻辑保持不动）

- **feat(upgrade)**: 升级页新增**状态提醒横幅** —— 发现新版本 / 正在下载 / 下载完成 / 升级中 / 升级失败等关键 FOTA 状态，升级卡底部以「图标 + 标题 + 一句说明 + 语义配色」的醒目卡片随状态实时提示，不再需要逐条看提示气泡拼状态。
- **feat(upgrade)**: 「FOTA 状态」大字按状态**语义配色**：查询中=蓝、发现新版/下载完成=绿、升级中/下载失败=红、下载挂起=橙，一眼可判当前所处阶段。
- **feat(upgrade)**: **进度更直观** —— 下载 / 升级进度改为大号数字百分比 + 阶段色进度条（下载=蓝 / 升级=红），阶段切换时颜色随之变化。
- **style(upgrade)**: 以上仅增强视觉呈现，FOTA 检测、轮询、升级链路与交互逻辑一律保持不变。

### 异步架构优化（Rust 后端）

- **feat(cache)**: 状态采集异步化 —— 新增 `state` 后台状态缓存（`state_cache`），把前端每 5s 刷新的只读 AT 查询由「串行排队下发」改为「读内存缓存毫秒级返回」：
  - 后台单任务按白名单内各自刷新周期预热，模组断开自动清空缓存，避免跨重连的陈旧数据；
  - 同一指令并发读取通过 per-command 锁去重，一个时间窗只发一条 AT；
  - 只刷新「最近仍被读取」的指令，页面离开后自动停止后台轮询，省 CPU/AT。
- **feat(tasks)**: 后台任务统一管理 —— 新增 `async_runtime` 任务管理器与取消令牌（CancellationToken）：
  - 长耗时操作（小区扫频、扫频取消等）统一以 Task 提交，拥有 task_id / 开始-结束时刻 / 进度 / 状态 / 错误 / 结果，支持 Pending/Running/Completed/Failed/Cancelled/Timeout 状态机；
  - 取消只发信号不粗鲁 drop Future，任务体自选收尾，保证扫频后的 reset 与事件广播不被中断；
  - 有界生命周期，管理器按上限淘汰已完成任务，杜绝无限队列。
- **feat(prio)**: **AT 命令按优先级调度** —— 用 `at_queue` 的异步优先级门（`PriLock`，BinaryHeap + Notify）替换原先 FIFO 的 `cmd_mu` 命令锁：
  - 优先级约定：用户终端操作=**High**、状态查询/定时锁频/读短信=**Normal**、后台缓存刷新=**Low**、扫频/长命令=**Background**；
  - High 可越过后台 Low/Background，后台长命令不再拖死用户终端操作（修「AT 终端页只有 ATI 有回复」的同源排队阻塞）；
  - `acquire` 自带排队超时与上下文取消，取消者直接从堆移除不占通道；同优先级按先到先得，保证公平。
- **fix(urc)**: 无符号计数比较修正（`total <= 0` → `total == 0`），消除 clippy 恒假分支。
- **chore**: `cargo clippy` 在异步新代码上净零警告。<br>
  *固件升级逻辑本轮保持不变。*

### Docs
- 「系统拓扑与数据链路」与「自动拨号与全链路协同机制」两处 Mermaid 图替换为高清架构位图（`docs/topology.png`、`docs/auto-dial-sequence.png`），层级与步骤与当前实现保持一致。

## v1.12.10 (2026-09-20)

### 新增

- **feat(status)**: 网络状态页整体视觉重构，改为「信号仪表盘置顶 + 双列/三列自适应栅格」布局，全部图形为按实时数据驱动的内联 SVG，不引入任何外部资源：
  - **4 联射频仪表盘**（RSRP / RSRQ / SINR / 综合信号）：240° 表盘 + 13 级放射刻度 + 发光能量弧 + 巡航游标；按 3GPP 阈值分五档（极佳 / 良好 / 一般 / 较差 / 极差），档位联动**弧长偏移、游标坐标、状态徽标、底栏进度条**四处表现。
  - **载波聚合频谱图**：按物理带宽占比绘制 PCC / SCC 分量载波占用条，块内左侧为制式与带宽、右侧为频点。
  - **芯片微热力拓扑**：PCB 矢量版图（安装孔、热传导总线、芯片定位点、内层铜箔）+ **4×2 读数矩阵**（7 通道 + 综合均温）。
  - **调制方式与空间流**：按当前 MCS **动态生成 I/Q 星座点阵**（QPSK 4 点 / 16QAM 16 点 / 64QAM 64 点），并给出上下行频谱效率利用率双轨进度条（以 28 阶 MCS 为满量程）。
  - **流量统计**：「本次连接会话」+「历史累计使用」双组看板，附上下行流量占比条。
  - **IP 与 DNS**：IPv4 寻址与 IPv6 双栈分层卡片化展示。
- **feat(status)**: **速率曲线支持悬浮查看数据** —— 鼠标（或触摸）停在曲线上即显示该采样点的相对时间、下行与上行速率，并绘制垂直指示线与上下行高亮点，移出后自动隐藏。

### 修复

- **fix(status)**: 载波聚合频谱图**始终不渲染**（表格正常、图形整块消失，且控制台无任何报错）。根因：频谱 SVG 通过 `E('div', { 'innerHTML': svg })` 注入，而 LuCI 的 `E()` 实为 `L.dom.create`，属性键一律走 `setAttribute` —— `innerHTML` 被当作普通属性名写入；HTML 属性名不区分大小写，浏览器将其规范化为小写 `innerhtml` 挂在元素上，**SVG 源码原样留在属性里，一个子节点都没生成**。现改为取回对象后赋值（`host.innerHTML = str`）。
- **fix(status)**: 载波聚合频谱图与下方表格**宽度割裂**。根因：SVG 视口宽 1198px，而 `height="46"` 仅为自然比例高度（`1198 × 50 / 600 ≈ 99.8px`）的 46%，`preserveAspectRatio` 取 `min(1.997, 0.920) = 0.920`，**内容实际只占 552px、两侧各空 323px**，而表格是 1196px 全宽。改为 viewBox `600×50 → 1200×100` + `aspect-ratio: 1200 / 100`（高度完全由宽度决定），并使载波块占满可用宽度、块内信息左右分布。
- **fix(status)**: 模组温度卡片**底部大片留白**（卡片被同行左侧卡片拉到等高，内容不足时留白约 150px）。根因：内容容器是 `.mt5700-card-body` **内部再套的一层 div**，只在 `body` 上设 `flex: 1` 无法贯通到该层。改为 `card → body → 内容容器` **三层 flex 贯通**，SVG 区与读数矩阵各占一半剩余空间。
- **fix(status)**: 温度拓扑图**文字与数值重叠**（TCXO 框高 28px 装不下 9.5px + 13px 两行字：两行仅隔 9px，而所需最小间距约 11.3px）；框高提至 36px，连线端点同步调整。
- **fix(status)**: 温度拓扑 SVG 的 `height` 小于自然比例高度，图形被按高度缩放而整体偏小；按比例校正。
- **fix(status)**: 「网络模式」恒显示原始值 `NR`。根因：`AtWs.ratLabel` 并不存在，该函数实际挂在 `Mt5700`（`mt5700.js` 的 `api.ratLabel`）；代码用 `AtWs.ratLabel ? … : fallback` 保护故不报错，但**永远走 fallback**。改为 `Mt5700.ratLabel`。

### 变更

- `htdocs/luci-static/resources/view/at-webserver/network_status.js` 由 959 行扩至 1400+ 行。
- 信号档位阈值、弧长换算、游标三角函数、频谱效率满量程等参数集中定义，便于后续调整。
- 双轨频谱效率条顺序为**上行在上、下行在下**。
- 速率曲线的图表外壳（SVG / 空态提示 / 数值浮层）只创建一次并持久，每次刷新仅更新 SVG 内部内容 —— 避免每秒重绘清掉悬浮状态。

### 文档

- README「功能矩阵」的「网络状态」行补充新增能力（4 联射频仪表盘、载波聚合频谱图、芯片热力矩阵、I/Q 星座图与频谱效率、流量双组看板、IPv4/IPv6 双栈、速率曲线悬浮查数）。
- README「界面预览」的看板说明补充上述图形能力，并更新为重构后的界面截图。

### 实机验证（Hiveton H5000M / ImmortalWrt SNAPSHOT / MT5700M-CN）

| 验证项 | 实测结果 |
|:--|:--|
| 载波聚合频谱图 | 渲染成功；SVG 内容占宽 **1168px**（表格 1196px），缩放比 **0.970** |
| 温度卡尾部留白 | **155px → 1px**；读数矩阵 8 格，每格 106px |
| 速率曲线悬浮 | 显示「12 秒前 / 下行 9.15 Mbps / 上行 267.03 Kbps」+ 2 个高亮点；移出后无残留 |
| 仪表盘几何 | 弧长偏移、游标坐标（独立按其三角函数重算）、底栏百分比、三处配色四项全部吻合 |
| 频谱效率条 | 上行 71% / 下行 39%（按实测 MCS 20 与 MCS 11 换算） |
| 控制台 | 页面零 JS 异常、零非 200 请求 |
| 残留缺陷写法 | `E('div', { 'innerHTML': … })` 计数由 1 降至 **0** |

- 悬浮查看数据的边界：历史采样从 0 累积到 60 点，**页面打开后前 60 秒内曲线只占右侧**，此时在左侧无数据区悬停不显示数值（该时段确无采样），约 1 分钟后填满，全程可查。
- PKG_VERSION 1.12.9 → 1.12.10。

## v1.12.9 (2026-09-19)

### 修复

- **fix(hcsq)**: 修复 **4G（LTE）下 SINR 读不出来**。根因：`^HCSQ` 的 LTE 分支按 `<rsrp>,<rsrq>,<sinr>` 解析，与手册 13.5 的字段表 `<lte_rssi>,<lte_rsrp>,<lte_sinr>,<lte_rsrq>` 不符 —— LTE 比 NR 前面多一个 RSSI，且 **SINR 在 value3、RSRQ 在 value4**（NR 恰好相反：SINR 在 value2、RSRQ 在 value3）。实测 `^HCSQ: "LTE",45,34,106,19` 被解成 RSRP=-106 / RSRQ=-3 / SINR=-16.2，正确应为 RSSI=-76 / RSRP=-106 / **SINR=1.2** / RSRQ=-10：真正的 SINR（106 → 1.2 dB）被当成 RSRQ 吃掉，界面上就是「4G 下 SINR 一片空白或数值明显不对」。5G 分支字段顺序本来就与手册一致，本次**保持不变**。
- **fix(hcsq)**: `255`（手册：未知或不可测）不再参与换算产出假值（此前 RSRP 会被算成 -44 dBm、RSRQ 算成 -3 dB），一律返回 `null`；非数字字段同样按「无数据」处理。
- **fix(monsc)**: 修复 **4G 下 `^MONSC` 字段整体错位**（实机二次验证时发现）。手册 13.9.3/13.9.5 中 LTE 与 NR 的 `<cell_paras>` 布局不同：LTE 是 `<mcc>,<mnc>,<tac>,<cid>,<pci>,<arfcn>,<rsrp>,<rsrq>,<rssi>` —— 没有 NR 的 flag 位、PCI/ARFCN/TAC 为十六进制、末位是 RSSI 工程值、**没有 SINR 字段**。旧实现一律套 NR 布局，4G 下 cid/pci/channel/rsrp/rsrq 全部错位（RSRP 显示成 -6、RSRQ 显示成 -67 这类乱值，channel 变成 "-85"）。现按制式分派：LTE 按手册布局解析（PCI 走十六进制），SINR 留空由 `^HCSQ` 兜底。
- **fix(status)**: `^HCSQ?` 不再是「只有 `^HFREQINFO` 一条载波都没返回时才查」。4G 下 `^HFREQINFO` 正常返回 LTE 载波、而 `^MONSC` 不带 SINR，旧判断让 4G 永远走不到 `^HCSQ`，SINR 恒显示为「—」。现改为：RSRP / RSRQ / SINR 三项里有缺就补一次 `^HCSQ?`，**只填空缺、不覆盖已取到的值**；主载波表格的信号三列改从汇总后的 `state.cell` 回填。
- **fix(urc)**: Rust 后端的 `^HCSQ` 分支同样把 `parts[1]` 当 RSRP，LTE 下取到的是 RSSI（算出 -95 dBm 而非 -106 dBm）。改为按制式取位（LTE 取下标 2），并跳过 255。
- **fix(sinr)**: `convertSinr` 的 0.2 dB 步进存在二进制浮点尾差，仪表盘会显示 `25.200000000000003` 这类数值，统一保留 1 位小数。

### 变更

- `parseHCSQ` 补齐 LTE 的 RSSI、WCDMA 的 RSCP / Ec/Io（`^HCSQ: "WCDMA",30,30,58`）；新增 `convertEcio` 并导出；`networkMode` 增加 `GSM` 显式分支。
- `parseMONSC` 新增 LTE 专属布局分支，并补出 `rssi` 字段；NR 布局解析保持原样。
- 新增单测 `tests/mock-modem/hcsq-test.js`（28 个用例：LTE / NR / WCDMA / GSM / NOSERVICE、短字段、255 无效值、`^MONSC` LTE 布局、换算边界与浮点尾差）。
- 修订 `tests/mock-modem/parse-extra-test.js` 的加载脚手架：此前缺 `L.Class` mock，且 `rpc.js` / `parse.js` 以 `return` 结尾导致附加 return 不可达，该单测**一直在首行抛错、从未真正执行过**（现已 19/19 通过）。

### 文档

- README「射频与基站 / 网络状态」补充信号字段来源（`^HCSQ` 各制式字段表、`^MONSC` LTE 布局差异与 4G 下 SINR 的兜底取数路径）。

### 实机验证（Hiveton H5000M / ImmortalWrt SNAPSHOT / MT5700M-CN）

| 场景 | `AT^HCSQ?` 实测应答 | 修复前显示 | 修复后显示 |
|:--|:--|:--|:--|
| 5G NR（回归） | `^HCSQ: "NR",77,241,31` | RSRP -63 / RSRQ -4 / SINR 28.2 | **RSRP -66 / RSRQ -9 / SINR 29（不变）**，与 `^MONSC: NR,…,-65,-9,29` 吻合 |
| 4G LTE（临时锁 LTE only） | `^HCSQ: "LTE",66,55,166,18` | SINR 空白 / 错值，RSRP、RSRQ 错乱（如 -6 / -67） | **RSRP -92 / RSRQ -11 / SINR 15.2**，全部正确 |

- 4G 下 `^MONSC` 实测只回 10 个字段且末位是 RSSI（`LTE,460,00,38400,D975244,8,24C8,-85,-10,-54`），印证 SINR 必须走 `^HCSQ` 兜底、且 MONSC 必须按 LTE 布局解析。
- 验证流程：`AT^SYSCFGEX="03",…,0,0`（7 参数格式，5 参数会报 `+CME ERROR: Incorrect parameters`）临时锁 LTE，验证后恢复 `"080302"`，设备回到 NR，全程无残留配置改动。

- PKG_VERSION 1.12.8 → 1.12.9。

## v1.12.8 (2026-09-19)

### 修复

- **fix(firewall)**: 修复「模组拨号正常、接口正常取到 IP（`ifstatus` 有地址、默认路由已建立），但路由器与内网都上不了网」。
  根因：**自动创建的模组接口从未登记到任何防火墙区域**。fw4 只为「区域内的接口」下发源地址转换（srcnat）与 `lan → 上行区域` 的转发放行；接口不在区域内时，内网源地址不会被改写，上游无法回程 —— 于是出现「有 IP 却不通网」。机型定制包预置的接口之所以正常，只是因为它同时把 `MT5700M`/`MT5700Mv6` 写进了 `wan` 区域的 `network` 列表。同一个接口，差的只有这一处登记。
- **fix(firewall)**: 新增 `ensure_firewall_zone`。目标区域判定不写死索引（区域顺序随固件而异）：① 存在名为 `wan` 的区域则用它；② 否则用带 `masq='1'` 的区域，优先其中已登记现成上行口（`wan`/`wwan`/`pppoe*`/`lte*`/`rmnet*`/`usb*`）的那个；③ 都没有则新建标准 `wan` 区域（`masq=1`、`mtu_fix=1`），并补建 `lan` 区域与 `lan → wan` 转发。
  **只做登记，不改动既有区域的 `masq`/转发等既有定义**：目标区域未开 `masq` 时只打警告，不擅自开启（避免破坏「公网地址直路由」这类刻意配置）。
- **fix(iface)**: 区域登记覆盖全部三条接口路径 —— `ensure_interfaces`（安装/升级）、`on_uplink`（后端确认拨号就绪）、`ensure_modem_interface`（开机启动），**且不只在「新建接口」分支执行**：存量设备接口早已存在，`ensure_iface_created` 会直接返回，只在新建分支登记正好漏掉它们（这正是本次问题的主要表现形式）。
- **fix(iface)**: 接口在 UCI 中不存在时不往区域里塞名字（fw4 会把解析不到的名字当噪声）；登记无改动时不提交、不重载防火墙，避免每次启动白刷一次防火墙。

### 变更

- `at-webserver` 新增内部函数 `fw_zone_list` / `fw_find_uplink_zone` / `fw_has_zone` / `fw_zone_add_iface` / `fw_ensure_forwarding` / `ensure_firewall_zone` / `fw_reload_if_dirty`；新增脏标记 `FW_ZONE_DIRTY`，把「区域改动」与 `apply_firewall_rules` 的那次重载合并，一次启动只重载一遍防火墙。
- `ensure_interfaces` 动作说明更新为「确保 V4/V6 模组接口存在**并登记到上行防火墙区域**」。

### 文档

- README「自动拨号与接口拉起」补充：责任表新增「接口登记到防火墙区域」一行；排查表新增「接口是否在上行区域」「NAT 是否对该网口生效」「有 IP 但上不了网时如何手动修复」三行；网络接口一节补充区域登记的原理与手动修复方法。

### 实机验证（Hiveton H5000M / ImmortalWrt SNAPSHOT / fw4）

| 状态 | `nft list chain inet fw4 srcnat` 的跳转 | 以 LAN 地址为源 `ping 223.5.5.5` |
|:--|:--|:--|
| 接口不在区域内（人为复现故障态） | 跳转不含模组网口 `eth2` | 100% 丢包 |
| 执行 `ensure_interfaces` 之后 | `oifname { "eth1", "eth2" } jump srcnat_wan` | 0% 丢包（~26ms） |

- 幂等：连续执行两次，第二次日志行数不变（64 → 64），无重复登记、无多余重载。
- 开机路径：`restart` 后 `MT5700M 已取到地址（第 1 次检查，设备 eth2）`，且**无**重复登记日志。
- 建区分支（隔离 UCI 目录单元测试）：空防火墙配置下正确建出 `lan` 区域 + `wan` 区域（`masq=1`）+ `lan → wan` 转发 + 接口登记，二次调用零输出。
- 安全性用例：已有 `wan` 区域但未开 `masq` 时，只输出警告，`masq` 保持未设置、区域未新建。

- PKG_VERSION 1.12.7 → 1.12.8。

## v1.12.7 (2026-09-18)

### 修复

- **fix(logs)**: 修复日志页**渲染中断**与取数失败。此前页面只渲染出前两条就停住，根因是渲染循环里的取值路径在数据未就绪时抛异常，被外层 try 整体吞掉，导致后续行全部丢失；现改为逐行容错渲染，单行异常不再影响整页。
- **fix(logs)**: 日志页 UI 样式**全部自写**，不再依赖主题的原生 button / card 组件。实测用原生按钮会被主题改成白底方框，与页面观感割裂。

### 变更

- **feat(logs)**: **AT 命令区分方向**。此前只有一句「收到 AT 命令」，分不清是页面发来的还是模组回的。现按三层记录：
  - `前端请求: ATI` —— RPC 层，页面发来的请求；
  - `发送 → 模组: AT+CMEE=2` —— 通道层，**唯一真正写串口**之处（初始化、自动拨号对齐等内部命令也在此，因此只有这一层能完整反映实际下发的命令）；
  - `接收 ← 模组: OK（共 N 行）` —— 应答汇总，只记末行 + 行数，避免多行应答刷屏（需要全文用 AT 终端页）。
  前端按方向渲染彩色徽章（请求=灰 / 发送=蓝 / 接收=绿），且发送行淡蓝、接收行淡绿，扫一眼即可判断方向。
- **fix(logs)**: AT 命令改为**保留英文原文 + 末尾附用途**，不再把 `SETAUTODIAL` 这类命令名替换成中文 —— 替换后无法与 AT 手册对照排障。用途表覆盖 33 条常用命令，命中第一条即停；键名与状态词（`enable=`→`开关=`、`Some(1)`→`1`、`PDP`→`数据承载` 等）仍中文化，不影响对照。

### 界面

- **style(logs)**: 级别下拉与刷新 / 导出按钮改为**自写配色**。下滑去掉系统外观、自绘箭头 + 主色描边 + 淡绿底，hover / focus 有反馈；刷新按钮主色实心，导出按钮描边 + hover 反色填充；清空按钮、搜索框焦点、自动刷新开关统一到同一套配色。
- **style(logs)**: 修正页面与主题**割裂**：胶囊式分段控件改为**下划线式页签**（容器无底色，激活项仅在下方留一条主色线）；面板 / 列表 / 说明条 / 页脚底色全部透明，只保留一道淡边框，斑马纹降到极淡。
- **style(logs)**: 修正**调试级别徽章看不清**。原规则只设了文字色与边框色、**没有背景色**，灰字落在浅灰行底上几乎融在一起；同时行级 `opacity: 0.72` 会把徽章一起压暗。现改为**实心紫底（`#8b5cf6`）+ 白字**，并去掉行级整体透明度、改为只淡化时间列与正文，徽章保持满对比；该行左侧色条同步改为紫色。

### 说明（踩坑记录，供维护参考）

- 级别下拉的外观**必须用内联样式**设置。主题对原生 `select` 使用了 `background` **简写**，会把单独写的 `background-color` 与 `background-image` 一并重置（实测下拉变白底、自绘箭头消失），且其样式表在本页样式之后加载，**外链 CSS 即使加 `!important` 也压不住**；内联 + `!important` 才能稳定生效，hover / focus 同理用 JS 事件设内联。

- PKG_VERSION 1.12.6 → 1.12.7。

## v1.12.6 (2026-09-18)

### 新增

- **feat(logs)**: 日志页重构为三个视图，并补齐此前**根本看不到**的过程日志：
  - **模组拨号**：后端内存日志 —— 自动拨号对齐、数据承载（PDP）与 USB 网卡状态、串口探测与选口过程、主动上报（URC）分发。这些在 syslog 里看不到：稳态下后端日志级别是 Warn，info 级的过程日志不会写 syslog，而它们恰恰是排障最需要的。
  - **接口与网络**：init.d 的 logger 输出（取自 syslog）+ 后端日志中接口相关的部分 —— 接口拉起与重试、热插拔钩子、动态地址（DHCP）与 IPv6 取址结果。
  - **通知记录**：原有通知文件（短信、来电、信号变化、存储告警）。
- **feat(logs)**: 后端新增内存环形日志缓冲（1200 条）与 RPC 方法 `logs`（按 seq 增量、可限条数），日志入缓冲**不受当前日志级别限制**，与 syslog 形成互补。
- **feat(logs)**: 界面可读性：
  - 级别中文化为 调试 / 信息 / 警告 / 错误，各配一色（左色条 + 胶囊徽章），半透明配色同时适配亮色与暗色主题；
  - 术语中文映射（`SETAUTODIAL`→自动拨号、`PDP`→数据承载、`DHCP`→动态地址分配、`hotplug`→热插拔 等），AT 命令名保持原文以免影响排障；**搜索仍按原文匹配**，两种习惯都能用；
  - 毫秒级时间列、关键词高亮、级别 + 关键词双过滤、自动刷新（页面不可见时暂停以省设备资源）、一键导出为文本、底部条数统计。

### 变更

- ACL 新增 `mt5700.logs`（读后端内存日志）与 `log.read`（读 syslog）。
- 菜单与页面标题由「通知日志」改为「运行日志」（功能已覆盖三类日志）。
- Rust 后端新增 `logger::snapshot()` 与 `LogRecord`（serde 序列化）。
- PKG_VERSION 1.12.5 → 1.12.6。

## v1.12.5 (2026-09-18)

### 修复

- **fix(arch)**: 修复「固件架构与软件包架构看起来一致却装不上」。apk 的架构是 `<base>[_<variant>]` 模型且 variant 参与严格匹配：同一颗 Cortex-A53，在 `CPU_TYPE=cortex-a53` 的目标（mediatek/filogic、qualcommax）上是 `aarch64_cortex-a53`，在未定义 `CPU_TYPE` 的目标（armsr/armv8 等，iStoreOS 25.x 亦属此类）上是 `aarch64_generic`。此前 CI 只产出 `aarch64_cortex-a53`，在声明 `aarch64_generic` 的固件上安装必然报 `error: uninstallable arch: aarch64_cortex-a53`。现矩阵扩为 3 架构 × apk/ipk 共 6 个组合，并在 Release 里附带 `ARCH-GUIDE.txt` 说明如何按 `/etc/apk/arch` 选包。
- **fix(arch)**: 产物目录改用 SDK 实际上报的 `CONFIG_TARGET_ARCH_PACKAGES` 命名，并新增 CI 闸门「矩阵期望架构 == SDK 实际架构」，把「发错架构的包」从用户侧失败提前到构建期失败。
- **fix(arch)**: `src/Makefile` 删除按宿主 `uname -m` 兜底推断 Rust 目标三元组的逻辑（交叉编译下会静默产出错误架构的二进制并打进包，运行时报 `Exec format error`），改为未命中即构建报错；映射表补齐 `aarch64_generic` / `aarch64_cortex-a72|a76` / `riscv64`，并把 `ARCH=arm` 按 `ARCH_PACKAGES` 细分到 armv5/armv6/armv7，避免 armv5/v6 目标板装上去就 `Illegal instruction`。
- **fix(arch)**: `scripts/sdk-build.sh` 不再用 `find … | head -1` 在多个 SDK 目录间挑选（readdir 顺序不确定，可能选中镜像自带但与矩阵 target 不符的那一份）；新增后端 ELF 架构自检，架构不符直接失败。
- **fix(pkg)**: 自定义 postinst 覆盖了 luci.mk 的默认 postinst（后者由 `ifndef` 保护），导致 `/etc/init.d/rpcd reload` 与 LuCI 缓存清理从未执行——新装的 ucode 插件与 ACL 不生效，页面上所有 RPC 调用报 `Access denied` / `Method not found`，重启前一直不可用。现已把这三条动作搬回自定义 postinst。
- **fix(pkg)**: `root/etc/uci-defaults/at-webserver` 在注册失败时不再无条件 `exit 0`，改为断言 `/etc/rc.d/S${START}at-webserver` 存在，失败则非零退出以触发 uci-defaults 自带的重试机制。
- **fix(dial)**: 修复「打开拨号页会把模组观测状态写成 UCI 期望值」——模组那一刻回 `enable=0` 就会被持久化为「关闭自动拨号」，之后后端主动关闭且重启不恢复。现改为以配置为准、只提示差异；仅首次安装写初值，并标记为未保存更改交由用户确认。
- **fix(dial)**: 自动拨号开启时禁用手工 PDP「激活 / 去激活」，避免与模组维护的上下文争用同一 CID 导致断网。
- **fix(autodial)**: 幂等判定纳入「拨号方式」。此前只比较开关，模组停在方式 2（转网口模式）而期望方式 1（USB 网络接口）时会直接跳过下发，USB 网口永远收不到 DHCP，接口长期没有 IP。
- **fix(autodial)**: `ensure_autodial` 增加退避重试（0/5/15/30/60/120s）与周期性对账守护（每 5 分钟检查数据面，掉线自动重新对齐），并用 `AT^NDISSTATQRY?` / `AT+CGACT?` 校验真实拨号状态，而不是只看 `^SETAUTODIAL` 的开关位。
- **fix(autodial)**: `init_modem` 每条设置命令显式检查 `resp.ok()` 并记录应答文本。此前模组回 ERROR 时 `send_command` 返回的是 `Ok(resp)`，`if let Err` 分支不触发，错误被完全静默。
- **fix(iface)**: 接口不存在时不再静默跳过，改为按「**先创建、再取址**」自动建接口 —— 不因「此刻还没拿到地址」或「缺少某个客户端」而让接口不存在。
- **fix(iface)**: V4 与 V6 接口都自动创建。V6 采用 `device=@<V4接口>` 引用语法（与机型定制包一致，实测 H5000M 的 `MT5700Mv6` 就是 `@MT5700M`，V4 换网口名时 V6 自动跟随），并开启 `extendprefix` 让上游前缀能分发到 LAN（不加这项即使拿到前缀也传不到内网）；取址策略为 `reqaddress=try` / `reqprefix=auto`，按实际网络状况获取，运营商不下发 IPv6 也不影响 IPv4 使用。
- **fix(iface)**: 接口拉起改为带间隔的重试（18 次 × 10s），并以「已取到地址」为达成判据。此前是「等设备 15s + ifup 一次 + 等 up 20s」后永久放弃，而模组冷启动整条链路（USB 枚举 → 驻网 → 下发 DHCP → 取址）常见 30~60s；同时不再用 `ifstatus` 的 `up:true` 冒充「已拿到地址」。
- **fix(iface)**: 安装与升级时也核对接口状态。新增 `ensure_interfaces` 动作，由 Makefile `postinst`（安装/升级）与 `root/etc/uci-defaults/at-webserver`（首次安装）同步调用 —— 服务里的同类检查是后台跑的，装完那一刻往往还没轮到，用户会看到「刚装完却没有接口」。可手动执行 `/etc/init.d/at-webserver ensure_interfaces` 复现同一行为。
- **fix(iface)**: 修正接口地址判定。`ifstatus` 输出是**多行美化 JSON**，原先的正则要求 `"ipv4-address": [` 之后同行还有内容，于是「接口明明有 IP」也被判成没有地址 —— 实机表现为走满 180s 重试循环并打出「MT5700M 在 180s 内未取到地址」的**误报**。改为先去掉换行再匹配数组元素，`hotplug.d/iface` 钩子里的同一处判定同步修正。修复后同一台设备启动 1 秒内即判定「已取到地址」。
- **fix(iface)**: `ensure_interfaces` 只创建接口、不做 `ifup`。`ifup` 会等待 DHCP 就绪（单接口可达数十秒），放在安装期同步调用会把 apk/opkg 拖住（实测 180s 才返回）。
- **fix(pkg)**: 修复升级后服务脚本不更新的问题。OpenWrt 的 apk 把 `/etc/init.d` 视为**受保护路径**（与 `/etc/config` 同等对待）：升级时若判定目标文件被本地修改过，就把新版写成 `<file>.apk-new` 而**不覆盖**。于是 init.d 永远停在上一个版本 —— 本插件的关键修复几乎都在 init.d 里。实测 1.12.3 → 1.12.5 后 `/etc/init.d/at-webserver` 仍是 11250 字节的旧版，新版 21753 字节躺在 `at-webserver.apk-new`。现由 `postinst` 主动合并服务脚本与 uci-defaults 的 `.apk-new` / `.opkg-new` / `-opkg`（`/etc/config` 下的 `.apk-new` 一律不动，那是用户配置）。
- **fix(serial)**: 修正串口就绪判定。`ls /dev/ttyUSB* /dev/ttyACM*` 在其中一个通配符**无匹配**时也会返回非 0（ls 对不存在的参数报错），导致「串口早已就绪」被误判成「没有串口」，每次启动都白跑一遍 USB 绑定流程并打出误导性日志。两个通配符改为分开判定（`bind_modem_serial` 内的成功判定同步修正）。
- **fix(init)**: 登记 `ensure_interfaces` / `on_uplink` 到 `EXTRA_COMMANDS`，`service at-webserver` 的帮助里可见，用户不必知道内部函数名。
- **fix(iface)**: 新增 hotplug 钩子（`hotplug.d/iface`、`hotplug.d/usb`）与后端→系统侧通知（`/usr/libexec/at-webserver/on-uplink.sh`）：后端确认拨号就绪后主动触发 `ifup`，让「拨号完成」与「网卡要地址」具备确定先后关系，而不是靠 init.d 抢跑加猜时间。
- **fix(iface)**: 移除 `/sys/class/net/eth2` 硬编码，设备名统一取自 `network.<iface>.device`（回退 `ifname`，再回退按 sysfs 的 USB 总线探测）；`MT5700Mv6` 与 v4 对称处理。
- **fix(serial)**: AT 口自动探测的候选集从 `ttyUSB*` 扩到 `ttyUSB / ttyACM / ttyAP`（完全无 USB 串口时才回落 `ttyS / ttyAMA`），与前端串口下拉框保持一致。此前默认的 `serial_port=auto` 在 AT 口枚举为 `ttyACM*` 的固件上永远报「没有找到任何 /dev/ttyUSB* 设备」，而页面上却能选到该设备。
- **fix(serial)**: 探测判定改为整行精确匹配。此前用 `seen.contains("OK")` 子串匹配，命令回显拼接或 URC 里带 OK 都会把 GPS/应用口误判成 AT 口。候选优先级也改为按 sysfs 的 USB 接口名打分（PCUI > AT/MODEM > 未知 > GPS/DIAG），不再硬编码 `ttyUSB1`；打开串口后 `tcflush` 清空驱动缓冲；候选数量设上限，避免几十个 `ttyS*` 把探测时间拖长。
- **fix(init)**: 串口绑定改为直接读 `/sys/bus/usb/devices/*/idVendor`，不再依赖未声明的 `usbutils`（`lsusb` 缺失时旧实现整段静默跳过且没有任何日志），并按 VID 匹配、PID 透传（PID 会随 `AT^SETMODE` 切换的 USB 组合变化）。
- **fix(rpc)**: ucode 代理先定位 `nc` 可执行文件（多个候选路径），缺失时返回「系统缺少 nc（busybox 未编译 nc applet）」而不是笼统的「Rust 后端无应答」，并校验应答首字符、附带截断预览便于诊断。
- **fix(build)**: CI 版本矩阵从 `main` / `23.05.5` 更新为 `25.12.5`（apk）与 `24.10.8`（ipk）。

### 变更

- 新增文件：`root/etc/hotplug.d/iface/99-at-webserver`、`root/etc/hotplug.d/usb/99-at-webserver`、`root/usr/libexec/at-webserver/on-uplink.sh`。
- `init.d` 新增 `on_uplink` 动作，可手动执行以模拟一次「拨号刚完成」。
- `root/etc/init.d/at-webserver` 拆出 `bind_modem_serial` / `ensure_modem_interface` / `apply_firewall_rules` 三个职责单元；防火墙规则名与清理列表对齐（保留 3 个历史名字仅用于清理旧版本残留）。
- 单元测试从 12 项增至 18 项（新增自动拨号状态解析、方式不匹配、NDIS/CGACT 解析等）；e2e 新增「开关+方式同时对齐」「关闭后回读」两条断言。
- Rust 后端版本 1.5.0 不变；`PKG_VERSION` 1.12.4 → 1.12.5。

## v1.12.4 (2026-09-16)

### 修复

- **fix(service)**: 修复服务永远「未注册 / 进程未运行 / procd 无实例」。根因不是 init 脚本缺失或被 overlay 白化，而是 **服务从未被 enable**：`/etc/rc.d/S99at-webserver` 软链接不存在。v1.12.2 及更早版本的 `root/etc/init.d/at-webserver` 执行位回退为 100644，安装期 enable 以 `Permission denied` 失败；enable 只在安装那一刻执行一次，错过之后即使执行位修好（v1.12.3）也不会自动重试，于是存量设备每次重启后服务都不再启动。
- **fix(service)**: `start_service` 新增开机自启注册自愈。每次 start 检查 `/etc/rc.d/S${START}at-webserver`，缺失就补权限并 `enable`，存量设备只要执行一次 `/etc/init.d/at-webserver start`（或点一次「重载服务」）即永久修好，不再随重启复发。
- **fix(pkg)**: `root/etc/uci-defaults/at-webserver` 增加显式 `enable`（先补执行位再 enable），保证新装与升级路径都把服务注册进 rc.d。
- **fix(pkg)**: Makefile 新增 `Package/luci-app-mt5700/postinst`，安装/升级后强制 `enable` + 启动（`IPKG_INSTROOT` 非空时跳过，避免污染 SDK/ImageBuilder 宿主）。
- **fix(ui)**: 「重载服务」不再只用 ubus `service.set` 直连注册实例——那条路径绕开 init.d，只是临时拉起进程，永远补不上 `/etc/rc.d` 链接，导致每次重启必然复发。现改为优先经 rpcd `rc.init` 调用 init.d（会触发自愈注册），失败才回退到 ubus 直连兜底。
- **fix(ui)**: 「未注册」状态的诊断文案修正为「未注册开机自启（rc.d 链接缺失）」优先，避免一律误导为 overlay 白化。

### 变更

- ACL `luci-app-mt5700.json` 新增 `rc` 对象授权（read: `list`，write: `init`），供前端经 rpcd 调用 init.d。
- PKG_VERSION 1.12.3 → 1.12.4。
## v1.12.3 (2026-09-15)

### 修复

- **fix(pkg)**: 修复 `root/etc/init.d/at-webserver` 执行位回退。`e186885`（v1.2.2）已通过 `git update-index --chmod=+x` 修复为 100755，但被后续提交 `b629839`（v1.3.1）静默退回 100644，导致非 SDK 构建路径（feed 集成、手工复制 `root/`）在 post-install 阶段再次出现 `Permission denied`，init 服务无法 enable、`/etc/rc.d/S99at-webserver` 软链接缺失。本次重新补回执行位；Makefile `Build/Prepare` 与 `scripts/sdk-build.sh` 的 `chmod 0755` 构建期兜底保留。
- **fix(service)**: 修复 `stop_service` 防火墙规则清理不完整。`start_service` / `reload_service` 创建并清理 7 条规则，而 `stop_service` 仅清理 5 条，`at_rpc_wan_allow` / `at_rpc_wan_block` 两条 RPC WAN 规则在停服后残留——开启过 `websocket_allow_wan=1` 的设备停服后 WAN 到 RPC 端口仍被放行。清理列表已补齐至 7 条。

### 文档

- README 版本号同步至 v1.12.3；新增「开机自启」章节，说明后端（init.d S99 + procd + UCI enabled 联动）、前端（rpcd/uhttpd 加载 menu.d / acl.d / ucode 代理）与 MT5700M / MT5700Mv6 接口自启（auto=1 + ifup）的完整链路与排查命令。

### 变更

- PKG_VERSION 1.12.2 → 1.12.3。
