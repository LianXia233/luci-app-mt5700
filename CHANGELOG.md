# Changelog

本文件按**版本倒序**记录每次发布的改动。格式为 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的变体：条目形如 `**类型(范围)**：说明`。

- **类型**：`feat` 新功能 / `fix` 缺陷修正 / `refactor` 重构 / `style` 样式 / `security` 安全 / `docs` 文档 / `ci` 构建流水线 / `chore` 杂项 / `note` 说明性备注（另有少量 `change` / `build` / `i18n`）
- **范围**：改动所在的模块，如 `sim`（SIM 信息）、`usage`（流量统计）、`chart`（信号趋势图）、`ui`、`apn`、`css`、`at` 等
- 每个版本另有独立发布说明（讲清「为什么改、怎么验的」），见 [`docs/release-notes/`](docs/release-notes/)

---

## v1.29.0 (2026-10-23)

### 修复短信中心打开后其它页面卡死（issue #23）：AT 通道分级预算 + 租约瘦身 + 空态立绘更新

> issue #23 反馈：打开短信中心后再进其它页面会卡住，须等「短信优先模式租约到期自动释放」（实测最长 90s+）才能恢复。根因是五层问题叠加：非短信命令一刀切等 30s、缓存刷新白占 worker、短信事务全程独占无让出、租约 TTL 90s 且续约 churn、前后端超时错配。本版逐层拆掉。

- **fix(at) 非短信命令按优先级分级预算**：`sms_mode_budget()` —— High（AT 终端/强制刷新）3s、Normal（页面查询）5s、Low/Background（巡检/缓存刷新）**零预算直接跳过本轮**。其它页面最坏 5s 内必有确定结果，不再出现前端 14s 超时导致的「卡死」观感
- **fix(state) 缓存刷新避让短信模式**：与既有长命令避让同一范式，短信模式生效时本轮直接跳过，缓存显示上一轮数据——消灭日志里每轮 6 条「通道已被占用 30s」的 worker 白占
- **feat(at) 短信事务协作让出**：事务持有超过 5s 且门外有排队者时，在命令边界主动让出一次通道再以 Sms 优先级抢回（`SmsTransaction::relinquish/restore`）。分片发送、批量删除等多步骤流程不再饿死交互命令；PDU 会话上下文不跨让出点，事务完整性不变
- **fix(sms) 租约瘦身**：TTL 90s → 30s、心跳 30s → 10s，与后端 `SMS_MODE_LEASE` 对齐；页面崩溃/忘记释放时最长阻塞 90s → 30s
- **fix(web) 续约 churn**：`openSession` 在已有会话且心跳在跑时直接返回，修掉「会话 8 释放 → 0.4s 后会话 9 上线」的模式反复开关
- **feat(web) 模块忙自动重试**：后端错误带 `sms_busy:` 前缀，前端 2s 退避自动重试一次，不计熔断、不抛给用户；`sms_skip:` 为后台跳过（无需重试）
- **feat(web) 通道状态徽章**：短信中心头部显示「优先模式生效中 · 后台暂停（剩余 Ns）」，数据转圈时有明确原因
- **feat(web) 短信事务耗时日志**：Drop 时输出 `短信事务结束: {label} 耗时 {ms}ms`，CMGL 读取等耗时可观测
- **feat(sms) 默认存储区改为 ME（模组 FLASH）**：新增 UCI 键 `sms_storage`（默认 ME）；SM 仅 40 槽位、长短信几条就满，满了模组会把后续分片溢出到另一存储区把一条短信拆成两截（实机复现：19:40 那条 5 片套餐查询前 2 片占满 SM、后 3 片落进 ME）。启动时读实际容量，与配置不符才下发（换卡/模组复位回 SM 时拉回）；界面「保存存储位置」同时写回 UCI，保存即开机默认
- **style(log) 短信占用期间日志文案优化**（issue #23 反馈）：跳过不叫「失败」——那是「不占通道、沿用旧数据」的设计行为；限流每 30s 最多一条（原每键每秒刷满日志页）；短信中心退出后补一条恢复日志，「暂停 → 恢复」有头有尾
- **fix(ui) 通道状态徽章倒计时改为 1s 秒表**：原实现只在续租事件点刷新，而续租每 10s 重置计时，徽章永远显示 ~30s 不动；现由 1s 定时器驱动，续租间隙真实递减、续租成功跳回 TTL（租约确实被延长，显示诚实）
- **style(ui) 空态立绘背景透明化**：移除 1000x1000 纯白底 rect，角色直接浮在卡片背景上（深浅色界面均不违和，角色本体零改动）
- **feat(ui) 空态立绘换新**：`mt-anime-empty-svg` 由软云星光换成「小吱-喜欢」方图（140px 注入 + 轻浮动画 + id 实例隔离）
- **chore(release) `PKG_VERSION` 1.28.0 → 1.29.0**
- **test**：`cargo test` **299 passed / 0 failed / 2 ignored**（WSL Debian 本机）；`rpc.js` / `sms_center.js` / `mt5700.js` `node --check` 通过

### r8 冗余代码清理 + 注释按实现订正

> 全仓静态审查：死代码逐个 grep 到「零引用」才删，注释逐条和当前代码核对。除下方**三处
> 行为修复**（两处 P1 缺陷 + 一处 `fix(schedule)` 推送时刻一致性）外**行为不变**——
> 发现的口径分歧只写进注释、列为待决，不擅自改前端或推送的显示值。

- **refactor(web) 前端死函数清理**：`rpc.js` 的 `parseHexValue` / `formatSpeed` / `splitSpeed` / `signalColor` / `qciLabel` / `isUnsolicitedText` 六个函数（全仓只剩「定义 + 导出口」两处命中，含 tests 亦无引用）连同 `AtWs` 导出口一并删除；`logs.js` 的 `computeCategoryCounts` 同删（真正在用的是姊妹函数 `computeCategoryTotals`）。副带收益：速率格式化此后只有 `network_status.js` 的 `formatSpeedNumber` 一份实现
- **refactor(web) `AtUci` 瘦身**：删 `uciCommit()`（自带注释就写着「与 uciSave 实现一致」，且全仓只有 `service.js` 调 `uciSave`）、`isDirty()`（零调用的取值器）与只声明从不使用的 `_dirtyFlush` 字段；删掉之后模块头「对外只暴露 uciSave 与 uciHasChanges」才与实际一致
- **refactor(rust) 后端死代码删除**：`SmsTransaction::elapsed()`（`cargo` 直接报 dead_code）、`WaitToken::make()`（与 `derive(Clone)` 逐字段等价，二者只留 derive）、`Scheduler::safe_tick()` 空壳（名为 safe 实为 `tick()` 透传，调用点直接进 `tick()`）
- **refactor(rust) 复用既有实现而非再写一份**：`atclient` 两处手写 `select!{ sleep / ctx.changed() }` 收敛到现成的 `sleep_ctx()`（命令最小间隔等待、0 字节退避），不新增抽象
- **fix(schedule) 推送时刻只取一次**：锁频切换通知的正文时间与 `Notification.time` 原为两次取值，可相差数秒，用户拿推送列表对正文会以为对不上
- **refactor(rust) `#[allow(dead_code)]` 作用域收窄**：从 `Connection` 结构体收到 `describe` 单个字段，避免将来新增的死字段被静默豁免
- **docs(rust) 注释与实现矛盾的订正**（本轮主体）：`signalgrade` 模块头引用的前端 `GAUGE_METRICS` / `GAUGE_CAPTIONS` / `capabilityAssess` / `VERDICT_TEXT` **四个标识符在 `htdocs/` 中都不存在**，改为真名 `SSB_TIERS` 并把「严格同一套阈值与文案」改成如实的「只对上一部分」；`sha256`「本模块只用于派生密钥」被 `fingerprint` / `path_for` 证伪；`ArchiveRecord.time`「发出的短信为 None」与 `sent_record` 实际写 `Some(自盖时刻)` 互相矛盾；`nettime::run`「失败等 60 秒」与三级退避（3s×10 → 60s×10 → 20min）不符；`monthly` 跨月表「每月 30 号」行的平/闰二月落点写错列（与自带单测冲突）；`localtime::from_ymdhms` 的钉住理由称「PDU 回退路径使用」实为仅单测使用；`atclient`「唯一真正写串口的地方」漏了 `interrupt()` 的绕过式写入、`pdp_ready` 兜底条件描述与控制流不符、passthrough 清单漏 `+CDSI`；`pdu` 乱码「收蝭得对」与遗留叫法「go-submit 分片」订正
- **docs(rust) 重构遗留的错挂 doc 归位**：`sms.rs` 挂在 `sent_record` 头上的正文预览说明归给 `text_preview`；`signalwatch.rs` 挂在 `sample_signal` 头上的两段（分属 `render_report_with` / `assess`）归位，并删去 `sample()` 的重复 doc 行
- **note(待决) 信号百分比两边口径不一致**：`signal_percent` 按 30 dB 跨度（-80 dBm 满格），前端 `calculateSignalPercent` 按 40 dB 跨度（-70 满格）——同一时刻 -85 dBm 网页显示 63%、推送显示 83%。本轮**只把注释改准，未改任何一边**；误导性测试名 `percent_matches_frontend_formula` 改为 `percent_uses_30db_span`
- **note(待决) 「批量汇总」模板是条死链路**：前端 `service.js` 有输入框 → UCI `notify_tpl_batch` → `config.batch` → 仅 `combine_messages` 使用，而生产路径每条通知单独渲染，`combine_messages` 只剩测试调用。`cargo check --all-targets` 现存 2 条 dead_code warning 即此二者，保留待决
- **docs(rust) 两处与函数脱节的 doc 归位**（`cargo clippy` 的 `empty_line_after_doc_comments`）：`config.rs` 里「从 UCI 读取配置；读取失败时返回默认配置」被空行隔断、孤悬在 `uci_values()` 与下一个函数之间，实际描述的是原本没有文档的 `load_config()`，归位；`localtime.rs` 测试模块里「一天 24 小时的分钟数」描述的是已被删除的常量，去掉
- **refactor(rust) 去掉两处恒等转换**：`qqbind.rs` 的 Identify 帧与心跳帧 `to_string().into()`，`into()` 的目标类型就是 `String` 本身（clippy `useless_conversion`）
- **note(clippy) 刻意保留的告警**：`config.rs` / `ringlog.rs` 共 8 处「assertion has a constant value」是**故意**的常量不变式守卫（`MIN <= DEFAULT <= MAX`），只有将来有人把顺序改乱才会失败，不作删除；`pdu.rs` 手写 `div_ceil` 已有注释说明是为兼容低版本 Rust 工具链
- **note(核查) 排除的两个假阳性**：`root/etc/config/at-webserver` 里 18 个 `schedule_{night,day}_{lte,nr}_*` 键初判「零消费方」，实际由 `schedconfig::uci_entries()` 用 `format!("{prefix}_{kind}_bands")` 拼名写入、`config.rs` 的 `band_lock()` 拼名读回，读写对称；`compat.js` 的 `api.resourceVersionInstalled` 初判「导出无人读」，实际是给 `L.env.resource_version` 打版本标签的副作用 IIFE，删不得
- **refactor(rust) `config.rs` 两处**：`secs_to_timer_minutes` 的手写 `(secs+59)/60` 补上局部 `#[allow(clippy::manual_div_ceil)]` 与理由（与 `pdu.rs` 文件头同一条工具链兼容取舍，此前只在 pdu.rs 说明过）；解析 `uci show` 输出的 `starts_with` + `key[prefix.len()..]` 改 `strip_prefix`，去掉同一件事写两遍
- **docs(rust) 两处 rustdoc 列表缺空行**（clippy `doc_lazy_continuation`）：`atclient.rs` 的 `prepare_scan_data_plane` 收尾要求「必须成对恢复」会被吞进第 4) 条、`nettime.rs` 模块头「任何一次成功都会清零计数」会被吞进第三个退避档位条目，各补一行空文档注释独立成段
- **test(state_cfg)**：校验禁用缓存指令时不再对每条规则 `cmd.to_string()`（23 条规则 × 禁用清单的无谓临时分配）
- **note(clippy) 刻意不动的风格项**：`sort_by_key`（async_runtime.rs:244、sms_store.rs:892）、`chunks_exact` 常量分块（sms_store.rs:141）、`timerpush.rs:223` 的 `used * 100 / total`（值域是几十条格位，不会溢出，改成 checked 反而掩盖真实意图）——属可读性偏好而非冗余，留给各自模块改动时顺手处理
- **refactor(rust) `notify.rs` 撤掉 impl 级 `#[allow(dead_code)]`**：该属性挂在整个 `impl Notifier`（约 425 行）上，等于把这一整块的死代码检测关掉——这正是 cargo 此前只报得出 `combine_messages` 的原因。撤掉后 cargo 立即点名两个零调用方法 `sender()`、`ready()`（后者只是 `dispatch_enabled()` 的转调壳，文档称「供状态展示与测试」但界面与单测都没用），一并删除；未再暴露其它死方法
- **refactor(rust) `rpcserver.rs` 三处死码**：`ScanPush` 结构体全仓无构造点（cellscan 事件在 5 处各自手搓同一形状），其 `allow` 注释称「保留（后续断点续扫扩展）」却既无读取方也无续扫代码；`ScanState.task_id` 只写不读（状态查询只看 running/lines，取消走 TaskManager 的 token，前端 tid 来自应答文本）；`scan_timeout` 的 else 兜底恒不可达（new 置默认、setter 忽略零值、config 按下限 10s 夹取）
- **refactor(rust) `urc.rs` 去掉孤儿事件键**：长短信合并推送里的 `isComplete` 全仓仅此一处出现，前端处理 `new_sms` 只看 `resp.data` 是否存在便重新 `list`，不读任何载荷字段
- **docs(rust) 注释失实订正（urc / rpcserver）**：`signal_level` 的「与轮询推送共用、口径一致」为假——轮询与定时推送的等级文案来自 `signalgrade::Level::caption()`，与本函数的（优秀/良好/一般/较差）是两套词表且无跨模块调用（原句尚有「口径…口径」重复字）；`query_monsc` 声称的「由调用方回退 ^HCSQ?」只存在于巡检侧，URC 路径从不回退；`handle_signal` 补注该链在实机休眠（本模组不自发上报 ^HCSQ/^CERSSI，实测 1200 条 AT 记录 0 条），换固件即生效、**勿当死代码删**；`TaskManager` 注释称扫频/锁频/固件升级都登记后台，实际只有扫频一处；`capacity` 应答的 `memFull` 注释称「界面据此提示清理」，实际前端零命中
- **note(待决) urc 与 rpcserver 新增四项**：`task_status` / `task_cancel` / `task_list` 三个 RPC 方法 ucode 白名单不导出、前端零调用（但 127.0.0.1 直连可调用，故未删）；`memFull` / `store_stats.dir` / `updatedAtMs` / `fingerprint` / `archivedAtMs` / `totalLines` / `scope` / `freedBytes` / `touched` / `channel` 等一批响应键前端不消费；`memory_full_notified` 是单向闩锁（全仓无复位点，一个进程生命周期内「存储满」最多推一次）且该路径不向前端广播结构化事件；`notify.rs` 与 `qqpush.rs` 各有一份同构的三次重试 + 线性退避实现（改超时/退避必须两处同步）
- **test**：`cargo check --all-targets` 无 error（剩上述 2 条 warning）；`cargo test` **285 passed / 0 failed / 2 ignored**（Windows 本机，Unix-only 用例不参与）；`rpc.js` / `logs.js` 通过语法校验
- **chore(release) `PKG_RELEASE` 7 → 8**

### r8 续：串口/基建/状态/ucode 层审查（第二批）

> 同批方法：每条结论先由我自己 grep 或读码复核，再落地。本批原本全部行为不变；
> 但审查中坐实一处**用户可见缺陷**（`usbCall` 硬超时），经确认后已按独立提交修复
> （见下方 note(P1) 的「已修复」说明），因此本 PR 不再是纯行为不变——除这一处外
> 其余仍是一律不变。加上第一段的 `usage_ctl` 与 `fix(schedule)`，全 PR 共三处行为变更。

- **refactor(rust) 死代码**：`serialdetect.rs` 删除恒不可达的 `chosen.is_empty()` 回退分支（前一行刚 `extend(by_id)`，必非空）；`state.rs` 用 `#[cfg(test)]` 取代 `is_cacheable()` 上的 `#[allow(dead_code)]`（既然只有单测用，cfg(test) 才是事实），并去掉 `LoopState` 从未使用的 `derive(Default)`；`async_runtime.rs` 合并 `spawn()` 上方两句重复文档
- **docs(rust) 注释按实现订正**：`async_runtime.rs` 模块头声称「小区扫频、锁频恢复、固件升级统一以 Task 提交后台」——实际只有扫频接入（锁频走 schedule 自循环、FOTA 由前端下发 `AT^FOTAOEMDL` 走 AT 队列），与同仓 `rpcserver.rs` 的说法互相矛盾；`main.rs`/`localtime.rs` 三处「必须在 spawn 任何线程之前调用」在 `#[tokio::main]` 下前提不成立（运行时线程已存在），改为「先于任何会读时间的任务与首条日志，靠启动顺序而非语言保证」；`state.rs` 的「十五个缓存键」实际是 23 条（改成不带数量，免得下次加键又过期）；`schedconfig.rs` 声称「uci 键名与 LuCI 界面完全一致」恰好相反（界面认 `AT+SCHED` 的 DTO 字段名，`schedule_` 前缀只对应 `config.rs` 读取侧）；串口探测的「候选集 + 800ms + 上限 10」**只属于本仓库 `serialdetect.rs`**，已补写进 `docs/sms-at-protocol.md` 的 §1.2（§1.1 讲的是实机 `/usr/bin/sendat`，两套独立实现、数值不可互抄）
- **docs(transport,serial_linux) 一处「写了但没实现」的保护**：两处注释称写超时「由上层 send_command / RPC 写路径负责」，实际 `exec_locked` 的 `write_all` 发生在命令超时 `select!` **之前**，写本身无任何 timeout；fd 以 O_NONBLOCK + AsyncFd 打开，串口 wedged 时写会一直 poll。改为如实说明「目前任何一层都未实现」。顺带把 `SerialWriter` 的 `#[allow(dead_code)]` 从 struct 收窄到 `write_timeout` 单字段
- **fix(P1，已修复) 自动清零日存不住**：ucode 的 `usage_ctl` 声明 `args: {action, day, _rid}` 并读 `getStr(a,'day')`，而 `rpc.js` 的 `L.rpc.declare` 写的是 `params: ['action','days']`——LuCI 按**声明名**映射位置参数，后端 `rpcserver.rs:428` 取 `params["day"]` 落空 → `monthly::normalize_day(0)` 夹成 **1**。用户设「每月 15 号清零」实际保存为 1 号，ucode 里「day 只在 set_reset_day 时带上」的注释也一直落空。修法在前端把 `'days'` 改 `'day'`（ucode 的 args 表才是这条 RPC 的权威签名，位置参数顺序不变）
- **fix(P1，已修复) usbCall 的 6s 硬超时从未生效**：`fs.popen` 等价于 `sh -c "<整串>"`，而 `usbCall` 拼的是 `timeout 6 /bin/sh -c ` + script（**缺单引号**）。script 是 `echo USB_SCAN; for x in …; done` 多语句，于是内层 sh 只执行了 `echo`（多吐一空行），真正的 sysfs 扫描在**没有 timeout 包裹**的外层 shell 里跑——注释声称的「子进程卡住会拖死 rpcd 上下文」保护并不存在。按同文件 `detectUsbNetdev` 的既有正确写法补单引号；已核对 script 正文无单引号，下游只按 `USB=` 前缀取行，消失的标记行与空行不影响解析
- **note(待实机确认) 上述两条 P1 的验收动作**：清零日设为 15 后 `uci get at-webserver.config.usage_reset_day` 应为 15（改前会是 1）；模组设置页的 USB 速率仍正常显示。本机无 ucode 解释器，`.uc` 改动无法静态校验语法，也解释了为何这两条不能只靠 `cargo test` 背书
- **note(clippy 已核查为不动) 串口探测的 is_final_line 与 atclient::is_terminator**：判据几乎相同但**有意不同**（前者多认 `NO CARRIER`、前缀不带冒号），合并会改变探测行为，列为待决而非收敛
- **note(待决) ucode 其余四项**：`nc` 预算 12s/50s 均比后端外层 13s/51s **小 1 秒**，注释里的算式（8+2+3=13 却取 12）与结论自相矛盾；`detectUsbNetdev` 只跳 `lo|br-*` 而 init.d 还跳 `eth0|eth1`，板载 USB 网卡机型上两边数的不是同一张卡；`strIndexOf` 与内建 `index()` 重复且同文件对 `index()` 可用性给出一正一反两处结论，933 行更把数组传给 `index()`，需实机 `ucode -e 'print(index(["a","b"],"b"))'` 定性；`netrate` 的 `device`、各方法的 `_rid` 参数前端从不传入（恒走 fallback），属对外契约保留但应注释点明
- **test(限制说明) 本机校验盲区**：`serial_linux.rs` 与 `serialdetect.rs` 是 `cfg(target_os = "linux")` 模块，Windows 上的 `cargo check/test` **不编译它们**（musl target 因 `ring` 的 build script 需要 C 工具链而无法使用）。本批对这两个文件只做了「注释 + 属性位置 + 删除恒假分支」三类不可能引入编译错误的改动，但仍需在 Linux/CI 复验
- **test(Linux 复核，补上本机盲区)**：`cargo check --all-targets` / `cargo test` **300 passed / 0 failed / 2 ignored**，与 main 基线**逐项一致**（Windows 本机 285 系 Unix-only 用例未参与所致）；`cargo clippy --all-targets` 相对 main **净减 9 条、新增 0 条**；`node --check` 与 `tests/` 8 个 JS 用例（179 项断言）全通过；`usbCall` 超时用等价 shell 场景实测复现（旧写法 8s 不被掐断 → 新写法 2s 被掐断、exit 124）
- **docs(review) 审查后修正三处**：① `docs/sms-at-protocol.md` §1.1「找端口」描述的是**实机 `/usr/bin/sendat`**（厂商二进制，取证无法从仓库复原），此前误按本仓库 `serialdetect.rs` 的参数改写，已回滚原文；本仓库的候选集 / 800ms / 上限 10 改记入 §1.2 并链接常量；② `README.md` 安装示例随 `PKG_RELEASE` 同步到 `-r8`；③ `signalgrade.rs` 模块头补记前端 `SIGNAL_TIERS`（4 档、阈值 -110/-95/-80、名 较差/一般/良好/极佳）与后端 `Level::caption()` 前四档**同名不同阈值**，是最易再次漂移的一处
- **ci(workflow) 发布分通道，并把 actions 升到 Node 24 运行时**：① `actions/upload-artifact` v5 → **v7.0.2**、`actions/download-artifact` v5 → **v8.0.2**、`actions/checkout` v5 → **v7.0.1**——三者 `runs.using` 均为 **node24**，消除 runner 的「Node.js 20 is deprecated … being forced to run on Node.js 24」告警；`name` / `path` / `pattern` / `merge-multiple` / `retention-days` 等输入语义在新版中不变。② 根因型修正：此前 **main 上的每次 push 都会 `gh release delete` + `gh release create` 到 `v<PKG_VERSION>`**，等于把用户正在用的正式版直接覆盖（正式版资产停在 r3、而 main 已到 r8 时就会盖掉）。改为两条通道——**push tag `v*`**（或手动派发选 `stable`）仍发正式版；**push main**（或手动派发选 `preview`，默认）发**预览版** `preview-v1.29.0-r8`，带 `--prerelease` 标记、**不成为 latest**（latest 只认最新的非草稿非预发布 Release）。③ 清理逻辑由单组改为**两组独立计数**（`^v[0-9]` 与 `^preview-v` 各自按自己的保留数），两个正则互不重叠，因此**发布预览版永远不会把正式版挤出保留名额**——是硬保护而非配置约定；新增 `keep_previews` 输入（默认保留 3 个预览版）。④ 预览版说明固定加一张来源表（分支 / 提交 / 版本 / 构建时间 / 构建矩阵）并写明不替换正式版、不抢 latest，其后接原有的 CHANGELOG 摘要与安装命令
- **ci(workflow) 预览版按「测试版本」醒目呈现**：自动构建的产物此前只标一句「预览版」，容易被当成可用版本直接装在网设备上。现在把警示提到最显眼的位置——**正文首行**固定为「⚠️ 测试版本 · 仅供验证，请勿用于生产环境」，并分列**适用**（验证最新改动、复现问题、给开发反馈）与**不适用**（生产环境 / 长期运行的设备）两种场景，加一句装前先 `sysupgrade -b` 备份；**标题**同步改为「⚠️ AT WebServer <tag>（测试版本 · 仅供验证）」，使 Releases 列表页无需点开即可分辨。下接「构建信息」表与原有的 CHANGELOG 摘要、安装命令。**`v1.29.0` 正式版全程未被触碰**（资产仍为其原有的 r3 产物，且 latest 身份未变）

## v1.28.0 (2026-10-23)

### 推送前缀统一为 {time} {count}、三类正文排版重做、QQ 推送富文本化（独立 qqpush 模块）

> 推送是用户每天在 QQ 里直接看到的东西。这一版把三件事一次收口：**前缀**（改前每条推送自带一套装饰句，与全局前缀两套并存）、**排版**（巡检 / 网络切换 / 定时状态三类正文去 emoji、统一全角冒号、键值成行）、**富媒体能力**（QQ 推送不再只有纯文本）。QQ 机器人相关代码同时从 notify.rs 拆到独立模块 qqpush.rs，通知中枢只面向事件与模板。

- **feat(qq) 独立 QQ 推送模块 `qqpush`**：鉴权、发消息、富媒体组装、内嵌键盘、自定义菜单全部收敛到 `src/rust/src/qqpush.rs`；`notify.rs` 只保留「事件 → 模板 → 多通道投递」。`qqbind` 的凭证获取也改为复用同一实现，删掉一份重复代码
- **feat(qq) Markdown 富文本推送（msg_type=2）**：单聊/群聊自定义 Markdown 已对所有机器人开放（无需模板申请）。正文首行渲染为二级标题、全局前缀渲染为引用行、`键：值` 行渲染为列表项；全角冒号优先并兼容旧配置的半角写法，URL 行不拆
- **feat(qq) 三级降级阶梯**：Markdown+键盘失败 → 去键盘重发；仍失败且格式为 auto → 回落纯文本并进入 10 分钟冷却；格式为 markdown 时不回落，让错误暴露
- **feat(qq) 内嵌键盘**：富文本消息可附「打开管理页」跳转按钮（`qq_keyboard_enabled` / `qq_keyboard_url`，留空按 LAN IP 推导）
- **feat(qq) 自定义菜单管理**：`PUT /v2/menu` 默认菜单（查询状态 / 查询流量两项 send_message）；`qq_menu_enabled=1` 启动时自动配置，绑定成功路径补配一次；新增 `qq_menu` RPC（set/get）与 LuCI「配置 QQ 菜单」按钮
- **change(notify) 前缀统一 `{time} {count}`**：全局前缀默认值固定为「事件时刻 + 条数」；各事件模板不再自带装饰前缀，默认值首行即标题（新短信 / 来电 / 短信存储空间已满）
- **style(notify) 短信/定时推送排版细节**：多行短信正文在 QQ Markdown 下第二行起缩进为列表续行（不再跳出列表变成独立段落）；定时状态「信号」汇总行与指标行之间空一行，纯文本分组、Markdown 不误缩进
- **feat(qq) 四类富文本卡片**：新短信「信笺」卡片（`notify_tpl_qq_sms_md` 模板可改，内容分节「信笺内容」）、信号巡检报告（驻网信息 + 射频指标两张表 + 结论）、网络切换提醒/信号变动（网络状态 + 小区信息两张表 + 巡检提示）、定时状态报告（网络状态表 + 短信存储段）。前三类的表格含条件行（缺测项整行省略），由代码渲染；与纯文本推送同源同口径。`Notification` 新增 `qq_card` 预渲染字段，生产者挂卡、Notifier 按类型自动补短信卡
- **style(qq) 卡片排版约定**：分隔线一律空行包裹的 `---`（CommonMark 中紧随段落的 `---` 是 setext 二级标题下线）；页脚用斜体（`<sub>` HTML 标签已实测 QQ 不支持）；短信内容分节定名「信笺内容」与全卡隐喻一致
- **style(notify) 三类正文排版重做**：信号巡检标题改 `5G 信号巡检`；网络切换提醒（制式切换时）与信号变动通知改键值行 + 小区信息分段；定时锁频切换七行全角冒号；定时状态快照改 `信号：5G · n41 …` 与 `短信存储：3 / 50`。移除全部 emoji（📶🕒💾🔄⚡📡），半角冒号统一全角
- **feat(ui) QQ 目标 ID 提示重写**：说清 openid 是平台标识、不是 QQ 号、无法换算，绑定模式留空即可
- **feat(ui) 绑定进度条**：600 秒监听窗口剩余比例可视化（仅 waiting 显示），剩余时间改 `m:ss / 10:00` 秒表
- **feat(ui) QQ 富文本控件组**：消息格式（自动 / 富文本 / 纯文本）、键盘开关与跳转地址、菜单自动配置开关
- **feat(notify) 企业微信 / QQ 独立推送开关**：新增 `wechat_enabled` 与 `qq_enabled` 两个 UCI 开关，**均默认关闭**，互不影响；企业微信需「开关 + WebHook 非空」才发，QQ 需「开关 + 凭据齐全」才发（`bind` 模式开关关闭时跳过绑定）。LuCI 通知卡与 QQ 卡各有一个开关控件，「发送测试通知」的通道可见性同步跟随。修复「webhook 非空即启用」在脏数据（值含引号字符的伪 URL）下每轮通知白跑三次重试的问题
- **chore(release) `PKG_VERSION` 1.27.0 → 1.28.0**
- **test**：`cargo test` **288 passed / 0 failed / 2 ignored**（WSL Debian 本机）；`service.js` `node --check` 通过；新增 Markdown 组装、键值识别、降级冷却、菜单/键盘形状、凭证解析等用例

## v1.27.0 (2026-10-23)

### 全局视觉收口（看板娘防遮挡 + 弹窗重做）、运行日志按类别细分、发出时刻改取 NTP 模块时间

> 三件事。一是**英雄区的看板娘在别的页面上被切、被盖**：`mt5700.css` 一路长到 7200 行，里面叠了四套设计体系，同一个 `.mt5700-hero-card` 同时存在 `overflow: hidden` 与 `overflow: visible` 两条 `!important`，断点又把 `.mt5700-hero-art` 强拉成 `width: 100%` —— 头像被卡片自己裁掉、被相邻卡片压住、被主题的 `#floating-toolbar` 盖住。二是**弹窗内容一长就截断**：老规则 `max-height: 85vh` 配 `overflow: hidden`，正文超高时 footer 直接被切掉，两套世代的 `z-index`（9999 与 1000）互相打架。三是**运行日志只有一条时间轴**，拨号 / AT / 短信 / 系统混在一起，排障时想找一条 WRN 得肉眼扫全屏。
>
> 按要求**短信中心保持原样**：新增的每一条规则都用 `:not()` 把 `.mt5700-sms-shell`、`.mt5700-sms-hero-compact`、`.mt5700-sms-modal`、`.mt5700-sms-modal-mask`、`.mt5700-sms-prompt` 排除在外（追加的 584 行里 SMS 相关选择器 100% 是排除式，唯一例外 `.mt5700-logcat-sms` 是日志页的类别徽章，短信页不用这个类）。并做了一次逐元素对拍：同一份短信中心 DOM（页面骨架 + 读详情 / 批量删除 / 删除确认 / 输入号码四类弹窗，54 个元素 × 49 项计算属性）在「本次追加之前」与「之后」两版 CSS 下比较，1280×900 / 1280×700 / 768×900 / 390×844 四档视口 **diffCount 全部为 0**，横向溢出宽度也一致。
>
> 另外两处是经授权的功能性改动：发出时刻的来源、日志的筛选维度。

- **style(ui) 看板娘防遮挡**：`.mt5700-hero-card` 恢复 `overflow: visible`，并加 `isolation: isolate` —— 卡片自身成层叠上下文，`::before` 那团 220px 径向光斑锁在 `z-index: 0` 且 `pointer-events: none`，既盖不住头像也不会溢到下一张卡片上；`.mt5700-hero-art` 改 `width: auto` + `flex: 0 0 auto`，头像锁 76×76 正方形（≤820px 收到 64×64），层级 art:3 / avatar:4；图片缺失时的兜底从原来那块黄色补丁换成紫粉渐变；`prefers-reduced-motion` 下停掉浮动动画。历史样式里 `!important` 成片且构建会把同宽度的 `@media` 块合并重排，因此沿用项目既有写法：双类名 `.x.x` + `:not()` 链做**顺序无关**的权重
- **fix(ui) 主题工具条避让**：用 `@supports selector(body:has(*))` 包裹 `body:has(#floating-toolbar)` 检测，命中时给英雄卡加 56px 右侧避让；短信中心不参与。实测 1280px 下最坏情形原先重叠 6px，避让后头像右缘到视口右缘 57px、与工具条无交集
- **fix(ui) 全局弹窗重做**：遮罩统一 `z-index: 9400`（高于主题 chrome、低于 toast 的 10000）+ safe-area padding + `overscroll-behavior: contain`；弹窗本体改 `display: flex; flex-direction: column`、`max-height: min(86dvh, 760px)`，只让 `.mt5700-modal-body` 滚动（`flex: 1 1 auto; min-height: 0`），footer 常驻可见，长串正文 `overflow-wrap: anywhere`；≤768px 转底部抽屉（贴底、顶部圆角、进幕动画、按钮平分）
- **fix(css) `.at-modal` 缺 `box-sizing` 导致弹窗溢出视口**：`at.css` 从来没给 `.at-modal` 设过盒模型，`max-height` 落在 content box 上，768×900 实测弹窗 846px > 视口可用 810px —— 内容再多也会被顶出屏幕。补 `box-sizing: border-box`
- **feat(logs) 运行日志按类别细分**：运行时日志 / 通知记录分两个页签；条目按 `短信 → 拨号 → 网络 → AT → 系统 → 其他` 顺序归类，每条挂类别徽章，类别胶囊实时显示条数、点一下即筛；新增「仅错误+警告」过滤、DBG 级别、来源（后端环形日志 / syslog，syslog 只取 `at-webserver:` 前缀并跳过 `at-webserver-rust`）、条数上限（200 / 400 / 800 / 全部）；跨天插 sticky 日期分隔条；长正文默认折 3 行且**只有真被裁掉才出「展开」**；底部统计「共 N 条 · 错误 / 警告 / 信息 / 调试」，导出头部附类别与来源
- **fix(logs) 复审修复（Codex P2 ×2）**：短信类别正则补全 `CMGS|CMGL|CMGR|CMGW|CMSS`——原正则的 `SM` 子串匹配不到 `CMGS`（C-M-G-S），AT 通道层日志「发送 → 模组: AT+CMGS=...」原会被归进「AT 通道」，与规则表「短信在前」的设计意图相悖；级别下拉 change 时同步清除「仅错误+警告」勾选，修复「UI 显示 errors-only 生效、实际过滤已跟随所选级别」的状态错位
- **feat(sms) 发出时刻取插件 NTP 模块时间**：`sent_record()` 改用 `crate::nettime::now()`（全仓库唯一墙上时间入口，NTP 优先、设备时钟回退），格式 `%y/%m/%d,%H:%M:%S` 与前端 `archiveKey` 对齐；`time_approx` 从「一律 true」改为 `!crate::nettime::from_ntp()`，如实反映这一次是否 NTP 同源。前端 `sentTimeAnchor()` + `mergeArchived()` 优先采用归档时刻，模组回读那份只用来保留槽位 `index`（删除要靠它）
- **feat(sms) 批量删除补全选**：sticky 全选栏按当前筛选结果全选 / 再点取消，「已选 N 条」实时跟随；状态报告等无槽位条目不计入（原先它们禁用勾选却仍被算进全选）
- **style(sms) 短信中心版式收口**：桌面按 QQ 式会话排布（左列表 + 右气泡时间轴），手机端铺满屏幕且不再被 OpenWrt「保存 & 应用」与主题 `#floating-toolbar` 挤压 —— 定高逻辑去掉「按溢出迭代回扣」的收缩环，改由 CSS 的 `dvh` + safe-area 承担，避免工具条出现时把会话区越算越矮；`.at-field-control` 补 `width: 100%`（标签上下排列后输入框原先只剩两百来像素）
- **chore(ui) `MT5700_CSS_VERSION` 2.37.0 → 2.40.0、`AT_CSS_VERSION` 1.11.1 → 1.11.2**：LuCI 静态资源没有 `Cache-Control`，改样式必须同步 bump
- **fix(ui) view 模块带上版本参数**：luci.js 的 `require()` 只有在 `env.resource_version` 非空时才给模块 URL 追加 `?v=`（该值取自主题模板输出的 `luci.js?v=` 标签，部分构建为空，且即使非空也只随 luci-base 变化、插件升级时不变，而 `require` 一律 `Request.get(url, { cache: true })` 允许读缓存）。现由 compat.js（所有插件页面的最深公共依赖、先于任何视图工厂求值）把 `mt5700-<PKG_VERSION>` 并入 `L.env.resource_version`：SPA 内后续加载的 view 与公共模块 URL 一律带 `?v=`，发版 bump 版本号即整体失效；已有值追加不覆盖，luci-base 自身的缓存失效语义不变。已知边界：入口页第一个 view 模块的取回发生在补丁求值之前，升级后对入口页硬刷新一次仍是兜底
- **chore(release) `PKG_VERSION` 1.26.2 → 1.27.0**：包版本与 CHANGELOG / 发布说明对齐
- **test**：5 个前端 JS `node --check` 通过；`mt5700.css` 括号平衡（1190/1190）；短信中心 A/B 对拍四档视口 diffCount=0（见上文）；无头浏览器实测（Chromium + 假 RPC）看板娘在桌面/平板/手机三档均完整可见、`art` 占卡宽 6.4%–17.9%、头像 76×76 与 64×64、与最坏情形工具条零交集；弹窗遮罩 9400、正文可滚、footer 可见、盒体在视口内、移动端 `align-items: flex-end`；日志页 27 条（24 后端 + 3 syslog）日期分隔与类别计数正确，「仅错误+警告」只剩 WRN/ERR，syslog 来源筛选生效，通知页签下类别条 `display: none`，导出含类别与来源，移动端折叠 58px→展开 99px，桌面「假折叠」归 0，console 零报错。`cargo check --release` 与 `cargo test --release` 已于 2026-10-23 在复审环境补跑：check 零错误零警告，test **280 passed / 0 failed / 2 ignored**

## v1.26.2 (2026-10-23)

### 短信中心重做成 IM 界面，并补上「发出去的短信」这条一直缺失的记录链

> 两件事撞在一起。一是**界面上根本看不到自己发出去的短信** —— 这不是渲染问题，是 3GPP TS 23.040 的语义：`SMS-SUBMIT` 提交成功后模组**不往 SM/ME 写槽位**，`AT+CMGL=4` 读回来的永远只有收到的那一半；v1.26.1 之前界面只有「对方说的话」，一次来回在时间轴上被打散成两截。二是界面本身是列表式表单，与用户在用的 IM 客户端差得太远。这一版把发出记录**归档到路由本地**补全双向时间轴，界面按 IM 形态重做。
>
> 归档落 `/etc/at-webserver/SMS`：`/etc` 在 overlay 上持久化，而 `/var -> /tmp` 是 tmpfs，重启即失。文件名取 `sha256(归一化号码)` 前 40 位加 `.sms` —— 号码不出现在文件名里（`ls` 看不到联系人），顺带规避 `/`、`..` 这类路径穿越。容器格式：明文 JSON → ChaCha20 流加密 → 48 字节头（魔数 `AWSS` + 版本 + 每文件随机 salt + nonce + 明文长 + 写入时刻）→ 整帧位置相关异或混淆 → 尾部随机 padding（≤32 字节，让文件大小不泄露正文长度）。**威胁模型如实说明：防随手 `cat`/十六进制查看级别，密钥编译进二进制，不是抗攻击加密。**
>
> 真机验证：发 `102` 到 `10000`（本项目一贯的测试口径）后，归档 1 个会话 / 623 字节，`strings` 里搜不到 `10000` 与正文关键词，文件名是 sha256 前缀；`store_read` 能读回同一条会话里的 `sent`（`timeApprox=true`）与 `received`；勾「同时删除本地记录文件」删掉那条 sent，归档 623 B → 460 B，收到的气泡不受影响。

- **feat(sms) 短信中心界面重构为 IM 形态**：左侧会话列表（搜索框 + 全部/未读/已发三档筛选 + 底部「+ 新短信」与归档概览），右侧聊天区（会话头部、日期分隔条、左右气泡、底部输入区）。**收发双方默认展示头像**：对方用粉色系、本机用薰衣草系，两张 192×192 的 PNG 随包安装到 `htdocs/luci-static/resources/at-webserver/`。配色沿用参考稿的蓝紫色系（页面底 `#edf3fc`、发送气泡 `#2997f3`、选中态 `#e0edfc`），未改主题色
- **feat(sms) 发出记录本地归档（新增 `src/rust/src/sms_store.rs`）**：按会话独立文件、互不覆盖，单会话上限 500 条 / 512 KB，目录总配额 **2 MiB**、淘汰水位 4/5（超限先清最早记录）。去重键 `方向|正文|时刻` 是纯函数（`fingerprint()`），所以重复归档天然幂等。加密与混淆见上文容器格式；读写时自动加解密，不引入任何新依赖 —— SHA-256 与 ChaCha20 都是本文件内的纯 Rust 实现，随机数用时间戳混原子计数走 xorshift64\*（仅用于 salt/nonce/padding）
- **feat(rpc) 归档三动作接入 RPC**：`store_stats` / `store_read` / `store_drop` 走 rpcd ucode 插件，**在事务段之前分支** —— 归档只做文件读写、不占 AT 通道，不该排在短信事务后面等锁。`store_drop` 三种形态：`all=true` 清全部；`fingerprints` 与 `indices` 均空则整会话删除；否则按记录逐条删。指纹一律由后端算，前端只回传 `{direction, content, time}`
- **feat(sms) 收到与发出均归档**：`SmsService::send()` 在 `outcome == Accepted` 后记一条 `sent`（本条当时取本机时钟并一律标 `time_approx=true` —— SUBMIT 里没有发送时刻，只有 TP-VP；**v1.27.0 起改为取 NTP 模块时间、按来源标 `time_approx`，见上文**）；`urc.rs` 的 `handle_new_sms()` 读到正文、推送通知前记 `received`，长短信在 `assemble_partial()` 拼装完成后按**合并后的完整正文**记一条。归档失败只记日志，绝不影响收发结论 —— 留档是旁路，不是主链路
- **feat(ui) 归档与模组存储合并成单条时间轴**：`selectContact()` 异步拉 `store_read` 再渲染，缓存按会话号持有、发送/删除后主动失效（`invalidateArchive`）。发出气泡带「时间未知」标注而不是伪造时刻
- **fix(rpc) 短信 RPC 一直返回 `{"result":[2]}`、插件函数根本不执行**：`mt5700.uc` 的 `sms.args` 里 `indices: ''`、`enable: ''` 这些**字面量默认值就是 rpcd 的类型声明**（不是注释）—— 声明成字符串，前端传数组/布尔就被判 `UBUS_STATUS_INVALID_ARGUMENT`。改为 `indices: []`、`enable: false`，并新增 `number: ''` / `items: []` / `all: false`。这是「能发送但读不到状态和记录」「提示模组拒绝但有时候能发出」两条现象的共同根因
- **fix(ucode) 布尔参数把 `true` 判成 `false`**：`getBool()` 原先拿 JSON 布尔直接比字符串，短信设置页的开关只能下发 `false`。ucode 不是完整 JS、**不支持 `typeof`**，改用 `lc(trim('' + v))` 比对 `'1'/'true'/'yes'/'on'`
- **fix(sms) 会话内排序退化成按模组槽位号**：`conversationOrder()` 拿**消息对象当字典的键**（`keyOf[msg]`），JS 会把所有对象转成 `"[object Object]"`，于是每条消息共用同一个键、比较器恒等 —— 排序实际只按槽位号走。归档里的发出记录没有槽位号（`null`），被统一甩到会话最前面。改成与数组同下标的平行数组存排序键，归档消息用自己的真实时刻。实测顺序：`收 01:15:32 → 收 02:18:54 → 发 02:28:14 → 收 02:28:16 → 发 02:29:33 → 收 02:29:35`，一次来回不再被打散
- **fix(ui) 批量删除弹窗里没有「删除所选」按钮，整个功能不可用**：按钮对象创建了却漏了 `actions.appendChild(confirmBtn)`，弹窗里只剩「取消」。这种「创建了没挂载」的漏写不会报错、只会静默消失，已顺手扫过全文件的同类写法
- **fix(ui) 状态报告这类解析失败的 PDU 占着真实槽位却禁止勾选**：勾选框原按 `m.error` 禁用，而解析失败的条目**确实占着 SM/ME 的一个格子**，用户只能干看着它吃存储额度、删不掉。改成只看有没有真实槽位号（本地归档条目另按 `m.archived` 放行）。实测删除后存储 `used 15 → 14`
- **fix(ui) 会话内容多了会把整页顶长**：纯 CSS 算不出会话区的可用高度（导航栏、页签、hero 都随主题和屏宽变），改用 JS 量 `layout` 的文档坐标定高，再**按实际溢出量迭代回扣**（最多 3 次）直到整页不再滚动。`render()` 返回时节点还没进文档、`rect.top` 是 0，所以定高要延后两帧并在 400/1500 ms 各重校一次
- **fix(ui) 消息区与列表加触屏滚动并隔离滚动链**：`overscroll-behavior: contain` + `touch-action: pan-y` + `-webkit-overflow-scrolling: touch`，滚到尽头不把滚动甩给整页。实测消息区 `scrollTop 757 → 457` 而页面 `scrollY 0 → 0`；四种尺寸下 `docH == vh`（1440×900 / 390×844 / 360×740），1280×700 故意让整页滚 51px —— 再扣会话区就压到 320px 以下
- **fix(ui) 手机端三处挤压**：标题被操作按钮挤成「10…」（收紧按钮尺寸与间距）；窄屏进会话后切不回去（补 `is-mobile-chat` 状态类与返回按钮 `showChat()`）；主题自带的固定 `#floating-toolbar` 压住输入区（给 `.mt5700-sms-shell` 留 `padding-right: 52px` 让位）
- **chore(ui) `MT5700_CSS_VERSION` 2.29.0 → 2.37.0**：LuCI 的静态资源只有 `ETag`/`Last-Modified`、没有 `Cache-Control`，浏览器启发式缓存会继续用旧文件；CSS 靠 `mt5700.css?v=` 破缓存，改样式必须同步 bump。view 模块（`sms_center.js`）没有版本参数，**升级后需要一次硬刷新（Ctrl+F5）**
- **test**：`cargo test --release` **267 项：265 passed / 0 failed / 2 ignored**，其中新增 `sms_store` 11 项（容器往返、指纹去重、单会话淘汰、跨会话隔离、超配淘汰最早、padding 不泄露长度、ChaCha20 与 SHA-256 均对 RFC 8439 / `hashlib` 交叉验证过的权威向量）。`cargo build --release` 零告警；`aarch64-unknown-linux-musl` 交叉编译通过（zig cc 作 linker 与 CC，产物 ELF64 / AArch64 / 静态 / 2.60 MB / 无 `PT_INTERP`）；前端 3 个 JS 语法校验通过；实机端到端跑通发送、归档读写、加密形态、只删本地记录、批量删除五条链路

## v1.26.1 (2026-10-22)

### 实机短信收发链路逐条对照（`modem.lua` + `pdul.lua` + `smssend` + `pdu_decoder` + `sendat`）：修 5 处、补 1 处超时、保留 2 处有意的差异

> 参照物这次是路由器固件里那份**真跑得通**的实现：Hiveton-H5000M（Mwrt，挂 MT5700M-CN）的 `admin/modem/smsc` 页背后是 `controller/modem.lua` 加三个小工具 —— 读 = `sendat 1 at+cmgl=4 20 | pdu_decoder --json`，发 = `/usr/bin/smssend`（内部 `lua /usr/bin/pdul.lua` 编 PDU，再单行 `AT+CMGS`），删 = 逐槽位 `AT+CMGD`。真机证据：`POST admin/modem/smssend number=10000 text=102` → `{"ok":true,"toa":"81","segments":1,"refs":[19]}`；随后 `smslist` 里那条 10000 的短信 `stat` 由 0 变 1（读列表本身就把模组里的标记洗成已读，本插件同理，见 `urc.rs` 的 9.10.2 注释）。`smssend` 头部注释直接写着「TD Tech MT5700M-CN 不实现两段式 `AT+CMGS` 握手……`sms_tool_q` 在这台模组上永远发不出去」，与上一轮的一次性写法结论同源。
>
> 取源方式记录一下，免得下次重复踩：这台机器的 dropbear 与 ttyd 里的 `/bin/login` 都不接受 Web 口令，而 Web 会话的 rpcd ACL 只放开 `uci get`（`file.read` / `rpc-sys.exec` / 厂商 `at-daemon`、`modem_ctrl`、`qmodem` 一律 Access denied）。能落 root shell 的入口是**固件自带的 ttyd（`:7681`，无鉴权）**——按 ttyd 1.7 的 WebSocket 协议驱动它跑出来的 `/bin/login`，口令与 Web 不同源。

- **fix(sms) 删除支持 0 号槽位，并按槽位从大到小下发**：实机 `smslist` 回的就是 `"indices": [0, 1]` —— **0 是真槽位**，而本插件把「头行读不出序号」的记录也记成 0，`delete` 又顺手把 0 挡掉，结果是**卡上最老的那条短信在界面上永远删不掉**（v1.25.2 遗留实机项里那条「序号是否可能从 0 开始」现在有答案了）。`pdu::CmglEntry::index` / `sms::SmsEntry::index` 改为 `Option<u32>`（读不出 = None，界面照旧禁用勾选并提示「不在模组存储中」），`delete` 不再拒绝 0，并按厂商 `action_smsdel` 的做法排序后倒着逐条 `AT+CMGD` —— 厂商注释原话：「一条命令一个槽位：模组不收槽位列表。从大到小删，免得剩下的槽位号在中途挪位」
- **fix(sms) 收件人号码按实机口径归一后再编码**：新增 `pdu::normalize_destination()`，照 `smssend.normalize()` 的四档判定走 —— 空白与 `-()` 先剥掉；`+` 或 `00` 开头算国际；**裸的 11 位 `1` 开头手机号补 `86` 并按 0x91 编码**；12 位以上且已带 `86` 同样按国际；其余（特服短号、固话）按国内 0x81 原样编。本插件原先「照用户输入的写法编码」，界面上填 `13800138000` 会以国内格式发出，与实机在网侧的写法不一致。实机 `102 → 10000` 回 `toa:"81"` 也顺手证明了短号该走国内格式，`encode_address()` 里「短号要支持得先补 TON/NPI 分支」这句话现在有了实现着落
- **fix(sms) 提交失败后先往串口写一个 ESC 再继续用**：`smssend` 拿不到 `+CMGS` 时第一件事是 `at("\x1b", 3)`，然后才 fallback / 报错退出。模组可能停在「等 PDU」的半开输入态，这时候紧跟着的 `AT+CPMS?` 会被当成 PDU 吞掉 —— 一次发送失败连带把后面的读写一起拖死。`sms::send()` 在非 Accepted 的分片后、收尾回读容量之前补同一步，`send_does_not_retry_after_unknown` 那条底线不变（清了输入态也不重发）
- **fix(urc) 新短信按 `+CMTI` 上报的存储区去读**：`handle_new_sms()` 把上报里的区名解析出来后**丢掉**，直接 `AT+CMGR=<index>`，而 `<index>` 是「当前 `<mem1>` 里的第几格」（手册 8.1.1）。`+CMTI: "SM",7` 落在 `mem1="ME"` 上时读到的是模组 FLASH 第 7 格**另一条**短信，还顺手把那条标成已读 —— 推给用户的正文与真实新短信毫无关系。现在先按上报区 `AT+CPMS` 对齐、留出 `CPMS_SWITCH_GAP` 再读；区名只认手册 8.1.3 的 SM/ME，同一个区不重复写
- **fix(sms) 清空短信后把 `AT+CPMS` 还回原值**：`purge_all()` 为了逐区删净会连着切好几次区，循环结束 `mem1` 停在最后试过的那个区上不还 —— 之后所有 `list` / `delete` / `CMGR` 都落在那个区，用户看到的是「列表莫名其妙换了一个区」。现在清空前先记下三个区、结束时原样写回（区名不安全就不写）。实机的清空压根不切区（一条 `AT+CMGD=0,4` 清当前 `mem1`），也就没这个副作用
- **fix(rpc) `delete` 的超时从来没上榜，批量删除必然被掐断并连带打开熔断**：`mt5700.uc` 的 `SMS_ACTION_TIMEOUT` 少 `delete` 一项 → 走默认 12s，而后端最坏是 排队(10) + 每槽位 2s + 收尾回读(2)，**删一条两段长短信就已经超预算**；被 `nc` 掐断的那次还会打开「后端不可用」的共享熔断，别的页面跟着 15s 全部快速失败。补 `delete: 40`（前端 `rpc.js` 同步 42s），并把批量删除按 8 个槽位一批分批下发（`sms_center.js` 的 `SMS_DELETE_CHUNK`）—— 模组不收槽位列表，一次 RPC 的耗时与槽位数成正比，一次勾满 40 条是 80s 以上，写死的超时预算对不住它。半途失败也回读一次列表，已经删掉的不该还挂在界面上
- **note(sms) 两处「实机那么干、本插件不这么干」的差异是故意的**：① 实机 `pdul.lua` 一律 UCS2、每段固定 60 字（`sendLimit = 60 * 4`），本插件按 GSM 03.38 自动在 7bit/UCS2 里挑、分片用规范的 153/160 与 67/70 —— 更省也更符合 23.040，不动；② 实机发短信总把短信中心写成 0 长度（用卡里存的 CSCA），本插件读 `AT+CSCA?` 编进 PDU，为的是「在短信设置里改过中心号」当场生效。另外记一笔实机自己的边界 bug：`pdul.lua` 在正文**恰好**等于上限时置了 UDHI 却不写 UDH，`smssend` 靠 `fix_udhi()` 事后把那一位抹掉；本插件的编码器只在真的分片时才置 UDHI，不存在这一格
- **fix(pdu) TP-VP 再纠正一次：24 小时是 `0xA7`，不是 `0xA8`**：上一轮那条结论（见下面「对照厂商 WebUI」一节的同一小标题）**自己读歪了表**，这里按 TS 23.040 §9.2.3.12 的相对有效期编码重算一遍：`0～143` = `(n+1)×5` 分钟、`144～167` = `12 小时 + (n−143)×30` 分钟（**167 = 24 小时**）、`168～196` = `(n−166)×1 天`（168 是 **2 天**）、`197～255` = `(n−192)×1 周`。上一轮把第二档的偏移写成 `n−144`（于是 167 成了 23.5 小时），又给第三档编了一条不存在的「1 天 + (n−168) 小时」（于是 168 成了 24 小时），两处偏移刚好互相掩盖，结论看着自洽但整个是错的。默认值由 `0xA8`（48 小时）改成 `0xA7`（24 小时），**顺带与厂商 WebUI 用的是同一个字节** —— 上一轮记的「厂商 0xA7 = 23.5 小时，我们差半小时」其实是「厂商 24 小时、我们 48 小时」。相邻档连续性自查：143→12h、144→12.5h、167→24h、168→48h、196→30 天、197→35 天。这张表 AT 手册里没有，来源是 23.040 与公开的 03.40 整理（见 `docs/sms-at-protocol.md` §5.4），不属真机验证项
- **note(pdu) 首字节 `0x20` 是 TP-SRR，不是 TP-RD（行为未改）**：`build_submit_parts()` 的注释把 `0x20` 说成「TP-RD 拒绝重复」，按 23.038 的 SMS-SUBMIT 首字节表，TP-RD 在 `bit2`（`0x04`），`bit5` 的 `0x20` 是 **TP-SRR —— 向网络索要状态报告**。注释已改正，但**没有动这一位**：现状是每条短信都请求回执，配合 `AT+CNMI` 的 `ds=2` 会把回执存进 MT 并经 `+CDSI` 上报，是「存储比预期快满」的可疑来源之一，已列入真机确认项（`docs/sms-at-protocol.md` §9）。厂商的编码器首字节是 `0x01`：不要回执、也不带 TP-VP
- **docs(sms) 新增《短信链路协议与命令参考》**（`docs/sms-at-protocol.md`，README 目录与功能矩阵各挂一处入口）：把发送／接收／读取三条链路的**协议与命令**单独成文 —— 传输层与通道独占（实机 `sendat` 的探端口/flock/19200 raw 对 本仓库的事务与租约）、每条 AT 的取值理由（含 `CNMI` 五个参数逐个解释）、`AT+CMGL=4` 的四个陷阱（只列 `mem1`、已发短信也在里面、读即已读、`OK` 才是判据）、`+CMTI` 的区与序号语义、SMS-SUBMIT 首字节位表与 PDU 逐字段、DCS 按 bits7-4 分组的字符集判定、号码归一四档判定表、一次性 `AT+CMGS=<len>\r<PDU>` 与两段式回退的判据矩阵、`delflag` 表与降序删除、三层超时预算对照，末尾附**已核对过的报文**与串口手工复现步骤。另有一份面向用户的《短信功能使用文档》（页面操作、提示 → 处置对照、验收清单）**按要求不入仓库**，只在本地保留，因此 README 与本文的入口一律指向这份协议参考
- **test**：`cargo test` **256 项：254 passed / 0 failed / 2 ignored**。新增 8 个用例：`pdu` 3 个（号码归一的四档判定 / 该拒的形状 / 归一结果落到 PDU 里的 TOA 与长度字节）、`sms` 4 个（0 号槽位照删、空列表不占事务、ESC 夹在失败的提交与收尾回读之间、`purge` 还原 CPMS）、`urc` 1 个（`mem_to_switch` 只认 SM/ME 且不重复切）。改写 3 个既有用例：`delete_reports_real_result_per_index` 现在断言**降序**下发，`cmgl_keeps_unparsable_entry_with_error` 补两条断言 —— 「槽位 0 是真槽位」与「序号读不出留 None」，`default_validity_is_relative_24h` 把「24 小时 = 0xA7」钉住（同一条也顺手锁 `TP-VPF` 仍是相对格式）。`TZ=UTC` / `Asia/Shanghai` / `America/New_York` 三种时区各复跑一遍同样全绿，但 Windows 的 CRT 不读 `TZ`，这一项要在 Linux 上才算真验过（见下面的「verify 的边界」）；`cargo build --release` 零警告、`cargo clippy --all-targets` 在 `pdu.rs` / `sms.rs` / `urc.rs` 三个改动文件上零新增告警（仓库基线的 14 条未动）；前端 12 个套件 **336 条断言全绿**（`sms-center-render` 57 → 62，新增场景 E 钉住「0 号槽位照实下发」与「序号读不出时不发删除」）；`node --check` 现存 35 个 JS 通过、`git diff --check` 干净
- **verify 的边界（别当成全验过了）**：本轮结论来自「厂商实现的实机行为」+「Rust 侧 mock 模组」两侧，`TZ=UTC` / `Asia/Shanghai` / `America/New_York` 三种时区各复跑一遍全绿，但 Windows 的 CRT 根本不读 `TZ`，这项复跑在 Linux 上才算真的验过；`tests/mock-modem/run-e2e.sh` **没跑**（脚本写死 `/opt/nodejs`、`/home/user/.cargo` 与 `fuser`，本机没有）；本插件的守护进程也没装到那台实机上，所以**换形重试、ESC 清理、按区读取这三条在真机上的效果仍待验收**——尤其 ESC 那一条，它是照厂商脚本的姿势补的，模组在半开输入态下认不认裸 ESC 需要一次真机观察

### 真机证据回补：短信提交形态改回手册 9.14.5 的一次性写法（分隔符是字面 `\r`，不是回车）

> 触发点是实机的一条证据链：`AT+CMGS=19` + **真 CR** + PDU + CR → 模组只回显命令本身，随后静默（无 `>`、无 `+CMGS:`、无 ERROR）；`AT+CMGS=19` + **字面 `\r`** + PDU → 立即 `+CMGS: <mr>` / OK。上一轮把业务路径改成「先等 `> ` 提示符、再写 PDU + Ctrl-Z」的标准两段式，恰好落在真机不给提示符的那一侧——于是应用层发送在实机上必然失败。手册 9.14.1 列的「可能的返回结果」里从头到尾就没有 `> `，9.14.5 的例句也写成一行，两处一起看才是这台模组的真样子。

- **fix(sms) 发送形态回到一次性**：`sms::send()` 每片只写一条命令 —— `AT+CMGS=<长度>` + 字面 `\r`（反斜杠 + 字母 r 两个字符）+ `<PDU>`，尾部真实 CR 由底层补。全程不含 0x0D 也不含 0x1A 这类控制字节，因此「浏览器 JSON → rpcd → ucode → nc → Rust」那条转义链路（issue #19 里 0x1A 变成字面量 `u001a` 的根因）从结构上再也碰不到发送路径
- **fix(sms) 不再把 `> ` 提示符当成发送的前置条件**：旧代码是 `Ok(resp) if saw_input_prompt(&resp)` 这道硬门，模组不给提示符就永远不写 PDU，用户看到的是一次「模组未给出提交确认」的失败。提示符判据保留，但只在下面的换形重试里用
- **fix(sms) 两段式降级为「本地拒绝后的一次换形重试」**：`needs_two_step_fallback()` 只在模组回 `ERROR` / `+CME ERROR`（都发生在命令解析层，PDU 没进网络侧，换形态不构成重复投递）时，退回 3GPP TS 27.005 §3.4.1 的两段式再试一次；`+CMS ERROR`（网络侧已拒）与超时静默（结果不明，可能已经发出去）一律不换形重发，守住「绝不自动重试」这条防重复计费的底线
- **fix(at) 裸 AT 终端页的一次性提交不再被提示符提前结束**：`send_command_inner()` 过去把 `ignore_prompt` 硬编码成 `false`，同一条命令在事务里和终端页里得到两套判据——终端页把「模组只给了个 `> `」当成一次成功应答返回。现在两处共用 `is_single_shot_cmgs() || is_cmgs_payload()`
- **fix(sms) 一次性判据同时认两种分隔符**：`is_single_shot_cmgs()` 原来只看真实 CR，业务路径换成字面 `\r` 后会掉出判据；现在两种都认。ucode 的 `SMS_RPC_TIMEOUT_SEC` 判据同步跟上（它原来只匹配 `/^AT\+CMGS=[0-9]+\r/`，新形态会被 nc 的 12 秒硬超时掐断，一条本来成功的短信被报成失败）
- **test(sms) 模组模型按实机语义改正**：`mock-modem.js` 现在区分三种形态——字面 `\r` 的一次性写法直接给回执；只报长度才给 `> `；进入 PDU 输入态后若这段数据不带 Ctrl+Z 就**什么都不回**（这正是真机上「长度 + 真 CR + PDU + CR 一次写完」的结局）。旧模型给提示符后的裸 PDU 也回 `+CMGS`，等于替真机兜底，测不出「显示成功但发不出去」
- **test(sms) e2e 第 5 项重写为 5 条断言**：一次性形态拿到回执、只报长度只有提示符（不得算成功）、PDU + Ctrl+Z 拿到回执、`AT+CMGS=0` 被拒、长度与 PDU 字节数不符被拒；文件末尾新增第 12 项钉住「真 CR 一次写完 → 静默」（它会让通道按 40 秒预算等满，所以刻意排在最后一条）
- **test(sms) 顺手修掉一个不诚实的夹具**：e2e 原来手写的 PDU `0001000B815221214365F70000AA0B4F60C6A21` 只有 19.5 字节，注释却写「共 21 字节」；两段式路径不校验长度，所以这个错数一直没暴露。改用手册 9.14.5 的原例（19 字节、`<length>` = 18），长度由 PDU 自己算出来，mock 侧新增按 `<length>` + SMSC 字段长度的校验，对不上就回 ERROR
- **fix(time) 顺带发现：没有时区配置时「默认北京时间」从来没生效**：`localtime::resolve()` 的优先级是 libc > 内置解析器 > 北京兜底，而 glibc/musl 的 `localtime_r` 在完全没配时区时**不报错**、静默按 UTC 返回 `gmtoff = 0`——于是启动日志写着「未配置时区，使用默认北京时间 UTC+08:00」，推给用户的「时间：」却仍是 UTC 时刻，短信/来电推送的时间戳早 8 小时。现在只有真的读到 `TZ` / `/etc/TZ` / uci 配置时才采信 libc（`libc_offset_if_configured`），没配置就直接走兜底；配了则一切照旧，libc 的夏令时结果仍然优先
- **test**：`cargo test` **263 项：261 passed / 0 failed / 2 ignored**，并在 TZ=UTC0、CST-8、EST5 三种宿主时区下各复跑一遍全绿；`tests/mock-modem/e2e-test.js` **41/41**（新增一次性形态与换形重试两条判据）；`simulate-push.js` **63 通过 / 0 失败**（修时区前是 61/2，失败的两条正是「时间戳 == 北京时间」与「不是 UTC 口径」）；前端 12 个套件 **331 条断言全绿**；`cargo build --release` 零警告；`node --check` 现存 35 个 JS 通过、`git diff --check` 干净

### 对照厂商 WebUI（inotdream/mt5700webui-openwrt-server）复核短信链路：三处佐证、两处更正，还有一个方向存疑的 CEUS

> 参照物是上游那份 OpenWrt 重打包：`files/usr/bin/at-server.py`（串口/网口 AT 代理 + WebSocket）加 `files/www/5700/*.js`（厂商官方 React bundle，含 `p__CPE__SMS__Center__index` 与 `p__CPE__SMS__Settings__index`）。本插件的页面头部注释当年写的是「等价迁移 sms/Settings.tsx」，所以这份 bundle 是**同一功能在真机上跑着的另一份实现**，可以当行为基准用。下面只写与短信有关的结论。

- **note(sms) 三处结论得到厂商实现佐证**：① 发送长度字段不含 SMSC —— 厂商编码器 `tpduLength = TPDU十六进制长度/2`，完整 PDU 是 `SMSC字段 + TPDU` 两段拼起来的，与手册 9.14.5 例句和本插件同一条；② 存储区只有 `SM`／`ME` —— 厂商设置页的存储位置单选组只有「SIM 卡=SM」「模组=ME」两项（默认 SM/SM/SM），`at-server.py` 匹配新短信用的也是 `\+CMTI: "(ME|SM)",(\d+)`，本轮把取值收紧到 8.1.3 的两个值是安全方向；③ 清空全部短信的「先切区再删」形态与 `AT+CMGD=1,4` 逐区执行一致，本插件的同一条路径没有偏差
- **fix(sms) 清空短信时给模组留出切区时间**：新增 `CPMS_SWITCH_GAP = 500ms`，在 `AT+CPMS=` 成功后、`AT+CMGD=1,4` 之前等待。依据是厂商 WebUI 的实测节奏（逐区 `CMGF=0` → 500ms → `CPMS="X","X","X"` → 500ms → `CMGD=1,4` → 1s → 下一区）：`AT+CPMS` 回 OK 只代表命令被接受，不代表读写接收介质已换完，而 8.6.2 规定删除作用在 `<mem1>` 上 —— 抢在换完之前删的是**上一个区**。手册没写这段等待，故同时记入实机确认项
- **docs(sms) 一度撤回、这里再撤回那次撤回：厂商的一次性写法是真机认的写法**：上一轮逐字节核对 bundle，确认厂商那条字符串是 `"AT+CMGS=".concat(len,"\\r").concat(pdu)`（运行时为字面的 `\` + `r` 两个字符、整条没有 0x1A），据此写下「厂商前端这条路本身发不出短信，它不能作为一次性写法可行的证据」。**这个结论是错的**，错在只验证了字节形态、没有验证模组的解析：手册 9.14.5 的举例正是 `AT+CMGS=18\r0011…`，并附注「使用 SSCOM 工具时对应的 "\r" 应改为 "\\r"」——要发到串口上的确实是反斜杠加字母 r。真机对照（见下一节）给出同一答案：字面 `\r` 形态立即拿到 `+CMGS: <mr>` / OK，而把分隔符换成真实 CR 反而只回显命令然后静默。厂商那条路不但发得出短信，它还是这台模组唯一认的形态
- **fix(pdu) TP-VP 默认值与注释不符**：注释写「0xAA = 24 小时」，按 TS 23.040 §9.2.3.12 的相对有效期编码，`168～196` 是「1 天 + (n−168) 小时」，0xAA（170）实为 **26 小时**；正好 24 小时的是 0xA8。默认值改为 0xA8 并把编码表写进注释（厂商用的是 0xA7 = 23.5 小时，差半小时，不影响送达）。手册 9.14 不含这张表，注释里注明规范来源，避免下次有人按「小时数」直接读这个字节
  ⚠ **本条的读表结论是错的，已被上一节的第一条更正**：`144～167` 的偏移应是 `n−143`（167 = 24 小时），`168～196` 是 `(n−166)×1 天`（168 = 48 小时），并不存在「1 天 + (n−168) 小时」这一档。默认值最终定为 `0xA7`
- **note(sms) `AT+CEUS` 的目标值方向存疑（未改，需真机确认）**：手册通篇（3.15 与 4.10）都没把 CEUS 与短信/IMS 关联，「开启短信要 CEUS=1」是推断。厂商 WebUI 开启短信时下发 `AT+CEUS=0`（语音中心）、关闭时下发 `AT+CEUS=1`（数据中心），**与本插件相反**，而且它是在 `AT+CFUN=0` 之后才写 CEUS（本插件刻意写在之前，理由是「不敢赌射频关了还认这条命令」——厂商的实机顺序恰好证明关了也认）。这不是手册层面的对错题，只影响真机能否收发：已把两种取值、两种顺序与验证办法写进 `run_power_enable()` 的注释；确认应为 0 时，本函数的写入值与 `power_requires_rf_restart()` 的判定值必须一起翻转
- **security(sms) 厂商实现里存在、我们已闭合的注入面**：厂商设置中心号是 `AT+CSCA="` + 用户输入 + `"` 直接拼串，页面对该输入框**没有任何校验**，一个 `"` 就能把一条命令劈成两条下发（清空流程里的 `AT+CPMS="<区名>"` 同样不加校验，只是那个值来自模组回包）。本插件两侧都走 `check_smsc_input`（3～20 位纯数字，前端镜像同一条规则），区名走 8.1.3 白名单
- **note(sms) 厂商实现里我们刻意不跟的四处差异**：① 收件人号码自动补 `86` 并转国际格式（`+86` + 11 位），本插件按用户输入原样编码，不带 `+` 时按 9.5.3 的国内格式（TOA 129）——是否要为国内运营商补这一层属产品决定，不擅自改；② 厂商发送固定 UCS2，本插件按 GSM 7bit 基本表＋扩展表自动选码并在超限时才分片；③ `at-server.py` 的 `_parse_sms` 同样用宽前缀 `startswith('+CMG')`（会把 `+CMGS: <mr>` 的回执 `OK` 当 PDU 解）、只认大写十六进制、并把 `index` 硬编码成 `"0"`（与本插件「解析失败条目兜底 0」是同一个坑，只不过厂商那里是所有条目都写 0），这三点在上一轮已各自修正；④ 厂商 CMGL 解析正则 `/\+CMGL: (\d+),(\d+),,(\d+)/` 要求保留字段为空，模组一旦回填 `<oa>`/`<reserved>` 就整条读不到，本插件按逗号分段不受此限
- **test**：本轮新增 1 条 `default_validity_is_relative_24h`（按 TPDU 逐字段走到 TP-VP，锁住「24 小时 = 0xA8」这条编码表结论）；全量复跑 `cargo test` 在 TZ=Asia/Shanghai、UTC、America/New_York 下均为 **259 项：257 passed / 0 failed / 2 ignored**；`cargo build --release` 零警告；`tests/mock-modem/run-e2e.sh` **39/39**（清空流程多了 2×500ms 切区等待，仍在 70 秒动作预算内）；前端 12 个套件 **331 条断言全绿**；`node --check` 现存 35 个 JS 通过、`git diff --check` 干净

### 短信子系统逐条对照手册第 8、9 章复核：修「读取失败被当成没有短信」，并把 mock 夹具改成真实应答形状

> 这一轮只查短信：`sms_center.js` / `sms_settings.js` 两个页面、ucode 的 `sms` 动作、后端 `sms.rs` / `pdu.rs` / `urc.rs` / `atclient.rs` 的短信路径，对照手册 8.1（CPMS）、8.3（CNMI）、8.4（`+CMTI`）、8.5（`+CDSI`）、8.6（CMGD）、9.8（CMGL PDU 模式）、9.10（CMGR PDU 模式）、9.14（CMGS PDU 模式）、9.5（CSCA），以及 3.15（CEUS）与 4.10（`^IMSSWITCH`）。主链路与手册一致（`AT+CMGF=0`、`AT+CNMI=2,1,0,2,0`、`AT+CMGD=1,4` 清空、两段式 CMGS、`<length>` 不含 SMSC 字段、UDH 的 septet 边界）；问题集中在错误处理、取值白名单，以及**测试夹具本身不合手册**。

- **test(sms) mock 夹具改成手册形状（本轮其余问题多由它暴露）**：`tests/mock-modem/sms-fixtures.js` 此前在 **PDU 模式**链路上回 Text 模式的应答（带引号的 `REC READ`、字段位置按 9.9.3），`AT+CMGR` 更把整条 PDU 塞进同一行。Rust 解析器读的是这个假形状，它按不按 9.8.1／9.10.1 解字段完全测不出来。现按手册生成 `+CMGL: <index>,<stat>,,<TPDU 字节数>` + 独立 PDU 行（`<stat>` 用 9.8.3 的数值 1／3，`<length>` 按 9.8.5 例句 `+CMGL: 1,0,,25` 扣掉整个 SMSC 字段），CMGR 按 9.10.1 回 `+CMGR: 1,,<len>`——**没有 `<index>` 字段**。Rust 侧不读 `<stat>`／`<length>`，所以夹具是这两栏唯一的漂移报警器，已在注释里写明
- **fix(sms) 「读取短信列表失败」不再被洗成「本机没有短信」**：`list()` 原来只从 `AT+CMGL=4` 的应答里挑条目，挑不出来就返回空列表——SIM 卡未就绪、切换存储区失败、`+CMS ERROR: 322` 全都显示成空收件箱，用户接着会去删根本不存在的序号。现在应答没有 `OK` 就报错并带出模组最后一行。判据只看 `OK`、不看「文本里有没有 ERROR 字样」：`^SMMEMFULL` 这类附带上报也会混进同一次应答，那时列表其实是读出来的
- **fix(pdu) `parse_cmgl_response` 不再冒充 `+CMGR`**：CMGL 与 CMGR 的头行字段数不同（9.8.1 是 `<index>,<stat>,[<reserved>],<length>`，9.10.1 没有 `<index>`），原解析函数却额外认 `+CMGR:` 前缀并按 CMGL 的下标读——真机的 `+CMGR: 1,,25` 会被解成「序号 1」加错位的长度，凭空多出一条内容错乱的短信。前缀分支删除，注释把两条命令的字段差写清楚
- **fix(urc) 短信头行前缀由 `+CMG` 收紧为 `+CMGR:` / `+CMGL:`**：`starts_with("+CMG")` 会把发送回执 `+CMGS: <mr>` 也当头行，接着把下一行的 `OK` 当 PDU 去解，日志里就成了「短信解析失败」。同处注释补记 9.10.2／9.8.2 的副作用——**读取未读短信会把它的标志翻成已读**，这是界面「未读」计数不能取模组状态位的根本原因
- **fix(urc) `+CDSI` 状态报告不再能插断 PDU 配对**：`AT+CNMI` 的 `ds=2`（8.3.3）会让模组上报 `+CDSI: "<mem>",<index>`（8.5），而 `is_exclusive_urc` 里原先只有 `+CMTI`。回执恰好在 `AT+CMGR` 等应答时到达，就会被塞进那条命令的应答行，打断「头行 + 下一行 PDU」的配对，表现为偶发的「短信正文解不出来」。现 `+CDSI` 认成主动上报，并加入 `is_passthrough_urc` 原样推给前端——本插件暂不解析回执内容，但别让它在界面上安静消失
- **fix(sms) 存储区取值按 8.1.3 收成 SM / ME**：8.1.3 写明 `<mem1>`／`<mem2>`／`<mem3>` 的可选值**只有** `SM`（(U)SIM）与 `ME`（FLASH），TS 27.005 里的 `MT`／`SR`／`BM`／`TA` 本手册一个都没定义。而「短信设置」页原来提供「自动（SIM 优先）= MT」这一项，选中即下发 `AT+CPMS="MT",…`，必被模组拒绝。前端选项、后端 `is_safe_mem_name`／`set_storage`／清空全部的回退清单同时收紧，并把原因写进报错（「不在手册 8.1.3 的可选值内」）；读侧保持宽松——固件可能回私有前缀 `^CPMS`、区名大小写不一
- **fix(sms) `parse_storage` 首行不是 CPMS 时整份容量都读不到**：解析里用 `?` 提前返回，只要读循环把回显行 `AT+CPMS?` 或空行排在应答前面，就整体返回 `None`，界面显示「容量未知」。改为 `continue` 扫到真正的 CPMS 行为止；同处注明 8.1.1 的 SET 回复只有 6 个数字、不带区名，不能按读命令解析
- **fix(sms) 短信中心号码校验收敛到一个入口，并与 PDU 编码能力对齐**：`set_smsc` 与 `power_set` 原来各判各的，同一句号码在一个界面能存、另一个界面被拒。现共用 `check_smsc_input`（可选单个前导 `+`，其后 3～20 位纯数字），`sms_settings.js` 镜像同一条规则。**有意比 9.5.3 严**：手册给 `<sca>` 的字符集含 `*`、`#`，但发送时中心号要编进 PDU 的短信中心字段，那一栏只有 BCD 数字的位置——放开的话号码能被模组收下、回读也一致，下一次发信才在编码阶段失败，「中心号设好了、短信反而发不出去」比当场拒绝难解释得多。9.5.2／9.5.4（掉电保存=Y、仅当 PDU 的 SMSC 长度为 0 时 CSCA 才生效）写进注释与发送第 2 步的说明
- **fix(sms) 序号 0 不再下发删除**：8.6.3 没写 `<index>` 的取值范围，而 0 在本插件里是「PDU 解析失败」的兜底值。列表侧 `indicesOf()` 用的 `>= 0` 会让「全选」把 0 一起带进 `AT+CMGD=0`，稳定换一句 `+CMS ERROR`；改为 `> 0`，后端 `delete()` 同步注明跳 0 的依据
- **docs(sms) CNMI 与功能开关的注释按手册重写**：`AT+CNMI=2,1,0,2,0` 现在逐字段解释（mode／mt／bm／ds／bfr），并记下 8.3.3 的约束（mode 取 0 或 2 时 `mt` 不能取 2/3、`ds` 不能取 1）、8.3.2 与 8.3.4 的行为（模组重启后 CNMI 回到 0,0,0,0,0 且不掉电保存，所以每次连接都要重设）；`run_power_enable()` 注明 `AT+CFUN=0/1` 是本插件对「开关机」的替代做法，6.1.3 定义的真正复位是 `AT+CFUN=1,1`（仅 online 模式可用、范围受 NV2391 控制），替代做法是否等价**需真机确认**；`purge_all()` 补 8.6.2／8.6.3 语义（`delflag≠0` 时 `<index>` 被忽略、删除作用在 `<mem1>` 上、4=清空首选存储区含未读）
- **docs(pdu) 小节号与字段含义校正**：`SubmitPart.tpdu_length` 注明依据 9.14.3／9.14.5（例句 `AT+CMGS=18` 配 19 字节、以 `00` 开头的 PDU，说明该长度不含 SMSC 字段），`CmglEntry.stat` 写全 9.8.3 的四个取值，`parse_cmgl_response` 的错文档（「两条命令的应答形状一样」）替换；测试辅助函数 `decode_submit_body` 的乱码标题（「直 HTTP 走的 TPDU 布局：skips SMSC →…」）与 BCD 字节数注释重写
- **refactor(sms) 孤立代码清理**：前端 `parse.js` 删除零引用的 `api.parseCMGL`（65 行，PDU 解析后端化后页面不再本地解 CMGL）与 `api.formatPDUTime`（22 行，时间串早在 v1.26.0 改由后端 `pdu.rs` 产出 `YY/MM/DD,HH:MM:SS`），两处残留的过期注释一并改指真实生产者；`pdu.rs::SubmitPart` 删从未使用的 `encoding`／`reference` 字段（连带两条 `#[allow(dead_code)]`），`urc.rs::PartialSms` 删只写不读的 `sender`；`sms_center.js` 联系人对象里再没人读的 `unreadCount` 删除。分片 TPDU 的 septet 计算收敛成一处（`CONCAT_UDH_SEPTETS + body`）——原来两种写法数值相同但要同步改两处
- **ui(sms) 编码提示与后端实际选择对齐**：`renderHint()` 原来按「全是 ASCII 就走 GSM 7bit」估，而 `pick_encoding` 查的是 GSM 7bit 基本表＋扩展表，可打印 ASCII 里唯一不在表内的是反引号 `` ` ``（0x60），它得按 UCS2 发。补上这一条例外，文案改成「需按 UCS2 编码／可按 GSM 7bit 编码／预计拆成 N 条」，160／70 与 153／67 的分片上限与后端同口径
- **docs(rpc) ucode 超时算式校正**：`mt5700.uc` 里解释 `list` 动作为何给 40 秒的注释还写着 `SMS_LIST_TIMEOUT(20)` 和「远不止 12s」，后端实际是 25 秒（`atclient.rs:37`）；口径写对，免得下次有人照注释去「对齐」
- **test**：`cargo test` 在 TZ=Asia/Shanghai、UTC、America/New_York 下均为 **256 passed / 0 failed / 2 ignored**（本轮新增 7 条：CMGL 按手册形状解析并拒绝 `+CMGR:` 前缀、解不开的条目保留模组错误原因、SMSC 拒绝「PDU 编不出来的号码」、存储区白名单跟 8.1.3、CPMS 行前的噪声、清空绝不写手册没定义的区名、模组失败不得当成空列表）；`purge_keeps_modem_reason_when_switching_mem_fails` 的应答改成 8.1.1 SET 回复的六数字形状（本节的 258 项到本节为止；随后的「对照厂商 WebUI」一节为 259 项，以那一节的数字为最新版本口径）。`tests/mock-modem/run-e2e.sh` **39/39**；前端 12 个套件 **331 条断言全绿**（`sms-center-render` 顶部流程说明与 `AT+CMGL=4` 断言改为「视图不再下发裸 CMGL」的绊线，`STORAGE.mem3`、`AT+CPMS?` 样例与 `render-shot.py` 样例里的 `MT` 全部改 `ME`；`mock-modem.js` 的 CPMS 回复同步按 8.1.3）；`cargo build --release` 零警告、`node --check` 35 个 JS 通过、`git diff --check` 干净。**遗留实机项**：真实固件的短信序号是否可能从 0 开始（决定 `> 0` 守卫会不会漏掉一条真短信）、模组会不会把长 PDU 应答折行（解析取头行的下一整行）、`AT+CFUN=0/1` 是否足以让 CEUS 生效、`+CDSI` 回执要不要做成「送达报告」界面、`^SMMEMFULL` 的触发条件与提示文案

### 依据厂商四份文档全量复核 AT 命令：修「掉线被判成已连接」等口径错误，清理孤立代码

> 对照《MT5700M-CN 5G系列模组 AT命令手册》《FOTA升级指南》《USB接口应用指南》《高精度授时功能验证指导》，逐条核对本插件下发的每一条 AT 命令、解析的每一个字段下标、界面提供的每一个取值，以及注释里引用的手册小节号。

- **fix(dial,status) `AT^NDISSTATQRY?` 的首字段是 CID，不是连接状态**：手册 16.4.1 的应答为 `^NDISSTATQRY: <cid>,<stat>[,<err>,<wx_state>,<PDP_type>]`，16.4.5 例句 `^NDISSTATQRY: 1,1,,,"IPV4",0,,,"IPV6"` 第一位是通道号；只有带 `<cid>` 参数的查询形式才以 `<ipv4_stat>` 开头。后端 `atclient.rs::parse_ndis_state`、拨号页 `ndisIsActive()`、扫频页 `ndisDataActive()` 三处都在读逗号串的第一段，于是**未连接的回包 `1,0,,,"IPV4"` 被读成「已连接」** —— 自动拨号看门狗据此永不补拨，界面同时显示在线。现统一按「cid==1 且 stat==1」判定，`<stat>` 取 2/3（手册标注暂不支持）与解析失败一律按未连接处理。mock 模组原来固定回 `^NDISSTATQRY: 1,1`，恰好把这条 bug 完整遮住，已改成手册例句形状
- **fix(dial) `AT^TDCFG?` 是多行键值文本，不是逗号串**：16.23.1 的查询应答为 `^TDCFG:` 后逐行 `Mode : <v>` / `Dmz : <v>` / `PostRoute：<v>` / `LHCM: …` / `Share-pdp：<v>`，且 16.23.1 用全角冒号、16.23.5 例句用半角。拨号页原按 `split(',')` 取值，对真实应答一条都解不出来。新增 `Parse.parseTdcfg()`（冒号全/半角、多余空格、`not cfg`、引号全部兼容，未返回的键给 `undefined` 而非 0），解析从页面收敛进 parse.js；页面里自造的第二份解析函数删除
- **fix(dial) 按 16.23.2/16.23.3 补齐 DMZ 与后路由的硬约束**：`<mode>` 只允许 1|2（界面原来多给一个文档里不存在的 `=3`「网口直通」，已删除）、`<pr_value>` 0=未配置/1=打开/2=关闭（关闭下发 2 而非 0）、DMZ 仅支持单个 IPv4 主机且**与后路由互斥**（两侧界面互斥拦截 + 提示），并按 16.23.2 注明「配置须在拨号前、删除须在断开后」「后路由需 `AT^IPFILTERSWITCH=0` → `AT+CFUN=0/1` → 再拨号」「mode/LHCM/share-pdp 需重启生效」
- **fix(dial) `AT^SETAUTODIAL=` 不再拼出 `undefined`**：按 16.18.1 完整下发 `<enable>,<dial_mode>,<protocol>,<apn>,<user>,<passwd>,<authtype>` 七段，协议取 "IP"/"IPV6"/"IPV4V6"，APN≤99、用户名与密码≤31 字符（16.18.3）；APN/用户名/密码含 `"`、CR、LF 时直接拒绝 —— 这三个字符会把一条命令劈成两条下发。`dial_mode` 补 0=模组内部拨号的文案（16.18.3），鉴权类型 3（MsChapV2）按 16.18.3 标注模组暂不支持
- **fix(at) 容忍手册自身的 `^SETAUTODAIL:` 拼写**：16.18.1 语法页把全字段应答写成 `SETAUTODAIL`（DIA↔DAI 转置），16.18.5 例句又是 `SETAUTODIAL`。后端与前端解析同时接受两种拼法，避免固件照语法页输出时读不到拨号状态
- **fix(modem-settings) 按手册收紧三处取值**：`AT^TDPMCFG` 必须 4 个参数（11.16.5 例句 `AT^TDPMCFG=1,0,0,0`，原来只发 1 个，模组一律拒绝）；`AT^TDPCIELANCFG` 只定义 1=RTL8111 千兆 / 2=RTL8125 2.5G（11.19.3），界面原来的 0「自动」和 3「十兆」删除；`AT^C5GOPTION` 的 5GC 接入文案改回手册原话「仅允许 NR 接入 5GC / 仅允许 LTE 接入 5GC」（13.17.3），并标明本页面只查询不写入
- **fix(network-settings) `AT^MONNC` 的 LTE 邻区 PCI 是十进制**：13.10.3 明确 LTE `<PCI>` 为十进制 0~503，只有 NR 才是十六进制 0~0x3EF。原来按 16 进制读 LTE 的 `25` 会得到 37，一键锁频会把用户锁到另一个小区上。邻区测量值量程（RSRP −144~−28、RSRQ −44~3、RXLEV −130~0；NR −156~−31/−43~20/−23~40，无效值 −1256/−348/−188）同步按手册写进注释与解析
- **fix(network-settings) 锁频移动性标志只认 0|1**：13.12.3/13.13.3 的 `<forbidFlag>` 只有「0=不允许重选和切换」「1=允许重选和切换」两档，界面前身的三档「移动性」映射删除；`<num>` 上限 20、`<pci>` 上限按制式分别校验
- **fix(status) `AT^CHIPTEMP?` 固定 12 字段**：17.1 定义 12 个温度通道、单位 0.1℃、`65535` 表示该通道读取失败，且超出 +120℃/−40℃ 范围读数不保证准确。解析改为按 12 字段读取并如实置 `null`，温度矩阵改为 12 通道，徽章不再恒定显示「温和」（原分级函数 `tempLevel` 已在 e89d3fe 删除，留下的是死文案），改按最高结温定级并给出均温
- **fix(upgrade) FOTA 流程按 15.3~15.7 重写**：状态机以手册定义的 10/11/12/13/14/20/30/31/40/50 为准（70 仅出现在 15.4.5「升级失败」例句中，按失败处理）；`^FOTADLQ` 的 `<index>,"<type>",<dl_size>,<file_size>` 字段下标与单位校正；`AT^FOTAOEMDL` 只在 IDLE(10) 下发且 URL 以 `/` 结尾、≤255 字节（15.4.3），HTTPS 暂未支持如实提示；取消只用 `AT^FOTADL=0` 且仅在 30/31/40 有效（15.3.3）；`^FOTASTATE` 的错误码按 15.5.3 表转文案；断点续传重试封顶 3 次，升级步骤需用户确认 `AT^FWUP`
- **docs(usb) 端口描述符注释对齐《USB接口应用指南》**：`bInterfaceProtocol` 0x12=PCUI、0x13=DIAG、0x14=GPS、0x1B=Serial_B、0x1C=Serial_C（PCUI 的 `bInterfaceNumber` 为 0x03）。`serialdetect.rs` 的判据注释与 `service.js` 的 PCUI 串口名提示（`/-if(03|12)(-|$)/`）按此校正
- **refactor(state) 后端缓存白名单 30 → 23 条**：`AT^MONC`、`AT^PCOINFO`、`AT^EMMSTATE?`、`AT^MCFGINFO?` 四条既不下发也不读取，全仓零引用，删除；`AT+CGDCONT?`（拨号页写完要立刻回读校验）、`AT^FOTASTATE?`（升级进度状态机）、`AT+CGMR`（刷完固件立刻回读版本号）属「写后读 / 状态机」类指令，命中缓存时界面最长读到 120 秒前的旧值，一并移出白名单 —— `rpcserver.rs` 的 `at` 通路对非白名单指令一律回落实时 AT（miss / 非白名单 / 抓取失败三条路径都走 live），功能不变，只是不再吃缓存。新增四条守卫测试（数组长度与声明同步、状态机与写后读指令禁止入缓存、带 `=` 的写指令禁止入缓存、键唯一），并把 `AT^PHYNUM` 加入测试侧禁止清单 —— 该命令在手册中不存在，历史版本曾用它写 IMEI
- **refactor(ui) 孤立代码清理**：`mt5700.css` 删除随 `tempLevel` 一起失效的温度着色体系（6 个 `.mt5700-metric.temp-*` 明/暗规则、6 条数值同色、`.mt5700-card.temp-has-*`，以及引用了**并不存在的** `@keyframes mt5700-temp-alert` 的动画声明），共 115 行；`Mt5700.metric()` 未使用的第 4 个 `status` 形参与「温度状态判定」空小节删除；`parse.js` 删除零引用的 `saveSentMessageToCache`/`MAX_SMS_CACHE`/`MAX_LOCK_BAND`；孤儿测试 `tests/mock-modem/temp-level-test.js`（被测函数已在 e89d3fe 删除）移除
- **docs(注释) 小节号与语义校正**：温保日志 chip 原把 `^THERMLDLOGSW` 第二个字段显示成「等级」，17.5.3 写明那是 `tempthreshold_file_switch`（日志文件存储开关 0/1），现显示「串口 开/关 · 文件 开/关」；`AT^SETMODE?` 的应答形状在 11.8.1（`^SETMODE: <mode>`）与 11.8.5（裸数字 `3`）中自相矛盾，解析改为「取应答里第一个数字」并注明依据；mode 7（MBIM）按 11.8.3 标注暂不支持
- **test**：`cargo test` 在 TZ=Asia/Shanghai、UTC、America/New_York 下均为 **249 passed / 0 failed / 2 ignored**（新增 `parse_ndis_state_reads_cid_stat_pair` 7 条、`SETAUTODAIL` 拼法 2 条、`state_cfg` 守卫 4 条等）；`tests/mock-modem/run-e2e.sh` **39/39**；前端 12 个套件 **331 条断言全绿**（apn-channel 12、ca-status 17、cellular-icon 38、parse-regression 39、pdp-addr 10、signal-chart 29、switch-rollback 6、tabmenu 28、hcsq 29、nrssbid 24、parse-extra 42、sms-center-render 57），其中 `parse-extra` 新增 4 条 TDCFG 解析用例（全角冒号语法页形状 / 半角例句 + `not cfg` / `postRoute=2` + 引号包裹的 DMZ / 键全无时全部 `undefined`）；`cargo build --release` 零警告、`node --check` 35 个 JS 文件通过、`git diff --check` 干净。**遗留实机项**：`AT^NDISSTATQRY?` 真机回包是否确实按 16.4.1 以 CID 开头（本机以 mock 例句验证）、`AT^TDCFG?` 实机冒号全/半角、省略 APN 尾参的 `AT^SETAUTODIAL=<enable>,<mode>` 是否保留原 APN 配置（后端与拨号页目前都会发短形式）、DMZ/后路由的拨号前后置约束是否被固件强制


### 短信开关不再把模组留在断网状态：先读 CEUS、失败回滚射频、提交改回两段式

> 起因是 PR #20 的审查：开启短信功能这条路在最坏情况下会让整机没有网络，且失败时界面上看不到任何线索。

- **fix(sms) 开关失败后回滚射频**：`power_set` 的开启分支一旦下发过 `AT+CFUN=0`，后续任一步（`CFUN=1`、`IMSSWITCH`、`CSCA`）失败都会 best-effort 补发 `AT+CFUN=1` 并回读确认，回滚结果写进 `failedDetail` 原样显示。此前失败即中断，模组被留在「射频关闭」状态 —— 用户点一下「开启短信」换来的是整机断网，而界面只有一句拒绝原因
- **fix(sms) 先读 `AT+CEUS?` 再决定要不要重启射频**：CEUS 是「设置后需要开关机生效」的持久化项（手册 3.15.2），但 3.15.3 又写默认值就是 1（数据中心），3.15.5 的举例回读还是 0，加上旧版本应用会主动写 `CEUS=0` —— 出厂默认不能推定现网状态。读到 1 就直接跳过整套 `CFUN=0/1` 重启（实测模组侧只收到 `AT+CEUS?` + `AT^IMSSWITCH=1,0,0`，不再断网）；读不到、读到 0 或其它值一律走完整重启
- **fix(sms) 顺序改为 `CEUS=1` → `CFUN=0` → `CFUN=1`**：CEUS 必须在关射频之前写好；`CFUN=0` 与 `CFUN=1` 之间的间隔从 500ms 提到 1100ms（手册 6.1.2 要求这一对大于 1s，实测原来只剩 3ms 余量）
- **fix(sms) `AT+CFUN=1` 单独给 10 秒预算并轮询确认**：此前用的是统一 2 秒超时，5000ms 只是成功之后的 sleep。实测注入 3 秒延迟应答时，后端在 2000ms 判超时，`IMSSWITCH`/`CSCA` 一条都没发出去而射频已经关着。现在成功标准从「固定睡 5 秒」改为轮询 `AT+CFUN?`==1 且 `AT+CEREG?` 已注册（上限 15 秒；`CEREG` 读不到时按「未知」结束而不死等），整串最坏 ≈40 秒，仍在 ucode 给 power 动作的 70 秒以内
- **fix(sms) 发送恢复两段式提交**：`AT+CMGS=<长度>` → 等 `> ` 提示符 → 再写 `<PDU>` + 0x1A。v1.25.2 改用一次性写法是为了躲 0x1A 在「浏览器 JSON → rpcd → ucode → nc」链路上被转义成字面量的问题，而现在提交发生在后端事务内、0x1A 由 Rust 直接 `write_all`，不再经过任何转义层。业务路径此前与本仓库自己的 e2e 断言矛盾（`tests/mock-modem/e2e-test.js` 第 5b 项：长度+`\r`+PDU 的拼法拿不到提交回执），实测 `sms send` 被模组拒为 ERROR —— 现在应用层发送能拿到 `+CMGS` 回执。裸 AT 终端页的一次性写法仍受支持（`is_single_shot_cmgs` 保留）
- **fix(rpc) `enable` 参数类型不符直接报错**：`power` / `set_ims` 不再用 `as_bool().unwrap_or(false)`，传字符串 `"true"` 会被静默当成「关闭」并执行反向动作（实测模组侧只收到 `AT^IMSSWITCH=0,0,0`）。ucode 已把 `'1'`/`'true'` 归一为布尔，此项是为将来的其它调用方兜底
- **fix(sms) 清空全部短信不再丢掉失败原因**：`AT+CPMS=` 切换失败时带上模组原始应答（此前只有固定文案「切换存储区失败」，`+CME ERROR: 4` 这类线索丢失）；前端把 `deleted` 与 `errors` 同时表达，部分成功不再被压成一句「部分存储区未能清空」
- **fix(sms) 提交结果判定收紧**：回执必须是**以 `+CMGS` 开头的应答行**（全文 `contains` 会让回显/正文里的字样冒充回执），并合并两个同体分支
- **docs(sms) 三处过期注释校正**：`sms.rs` 的开关流程说明（原写 CEUS→IMSSWITCH→CFUN→CGDCONT→CSCA）、`rpcserver.rs` 的 power 动作注释、前端 `sms_settings.js` 顶部对开关与清空流程的描述
- **change(sms) 关闭短信不再清空短信、不再写 CEUS、不关射频**（PR #20 的语义变更，此处补记）：关闭分支只下发 `AT^IMSSWITCH=0,0,0`。开启分支也不再配置 `AT+CGDCONT=5`（IMS PDP），手册 7.1 未列该命令的掉电保存属性、且 7.1.3 说明 APN 为空时使用签约值，**实机需回读一次 `AT+CGDCONT?` 并发送一条短信确认**
- **ui(sms) 解析失败的短信可见**：PDU 解不出来的条目在会话列表里显示为「未知号码」并预览错误原因，且不允许勾选参与删除（其 index 兜底为 0）
- **test**：`cargo test` 在 TZ=Asia/Shanghai、TZ=UTC、TZ=America/New_York 三种环境下均为 245 passed / 0 failed / 2 ignored（新增 10 条：CEUS/CFUN/CEREG 解析、跳过重启、失败回滚、CEUS 被拒不动射频、关闭只动 IMS、purge 原因保留、回执行判定）。顺带修掉一条时区相关的既有脆弱用例：`pdu::tests::test_decode_ucs2_pdu` 原先用**设备时区**构造期望时间，只有设备恰好也在东八区时才成立，UTC 环境下必报「差 8 小时」；现按短信中心自身的 +08:00 偏移构造期望值；`tests/mock-modem/run-e2e.sh` 39/39（新增 `sms` 业务动作全链路 13 条，含 mock 故障钩子 `AT+TESTCEUS=0/1`、`TESTCEUSFAIL`、`TESTCFUN1FAIL`、`TESTCPMSFAIL`、`TESTIMSFALSE`）；前端行为测试 24/24，`tests/*.js` 全绿（`cellular-icon-test.js` 修复 harness 取导出写错的 `api.CELLULAR_LEVELS/LABELS`，13/14 → 38/38）；`cargo build --release`、`node --check`、`git diff --check` 通过。**遗留实机项**：`AT+CGDCONT?` 回读与重启后是否保留、真实 `CFUN=1` 应答时长与注册轮询上限是否够用、CEUS 改写后开关机是否真正生效

## v1.26.0 (2026-10-22)

### 短信模块深度重构：最高优先级调度、事务级互斥、无缓存实时语义

- **refactor(sms) 短信命令不再逐条透传**：原链路把 AT+CMGF/CSCA/CMGS/CMGR/CMGL/CMGD/CPMS 拆成多次独立 RPC，每步之间后台巡检（信号/缓存/流量/自动拨号对账）都能插队，打乱模组上下文（如刚切 PDU 模式就被别的命令打断）。现改为一次 RPC 交一个语义动作（list/send/delete/purge/capacity/set_storage/get_smsc/set_smsc/power/set_ims/get_ims），由后端在**一次事务**里跑完全部步骤，全程独占通道
- **feat(sms) Sms 最高优先级 + 暂停门（SmsMode）**：`AtPriority` 新增 `Sms=4` 最高档，短信命令排队时优先于一切其它命令放行，正在执行的普通命令不被打断、等其自然结束后下一个放行的就是短信任务；进入短信中心登记带 TTL 的租约，非短信命令申请通道前必须等模式解除（后台轮询不再插队）。租约 300s 封顶且由后台 sweep 清扫——前端崩溃 / WebSocket 断开 / 忘记释放都会自动失效，不会永久停掉其它模块轮询；AT 接收循环与 URC 派发在暂停期间保持工作
- **feat(sms) 事务级互斥（SmsTransaction）**：长短信分片发送、批量删除、开关短信功能等多步操作全程持有 `GatePermit`，中间不释放，杜绝其它命令插入事务中间；事务与取消安全绑定，超时/取消不泄漏许可
- **feat(sms) 无缓存实时语义**：列表/正文/容量/删除结果全部来自模组实时回包；localStorage 已读/已发快照依赖移除（仅保留旧缓存清理）；每次操作后回读列表+容量，删除按模组真实序号并回读确认。`AT+CMGL=4` 的结果会随新短信、删除、存储切换而变化，缓存回包会让删除按着不存在的 index 下发 `AT+CMGD` 全是 ERROR
- **fix(sms) 发送结论三档，结果不明绝不自动重发**：Accepted（模组回 `+CMGS: <ref>`）/ Rejected（`+CMS ERROR`/`+CME ERROR`）/ Unknown（超时或无响应）。结果不明时不重发已提交的片段，避免重复计费；前端对 Unknown 给出明确警示而非假成功；同一目标+正文 10 秒内去重（浏览器重试/连点保护）
- **refactor(sms) PDU 编解码后端化**：删除前端 `smsEncode.js`，编码自动选择（GSM7/UCS2/8bit）、UDH 长短信分片（8bit/16bit 参考号、septet 边界 fill bits 精确处理）、SCTS 时区四分之一小时有符号解码全部收敛到后端 `pdu.rs`；保持单次提交 `AT+CMGS=<TPDU长度>\r<PDU>`，PDU 以字符串参数直达串口不经任何转义层；提交单独超时（总预算 60s 覆盖长短信全事务），与 ucode/前端三层超时口径一致且前端大于后端
- **feat(rpc) 语义化 `sms` 方法**：ucode 侧动作白名单 + 参数逐项取值，不做命令拼接防 AT 注入；分动作超时表（send/purge/power 70s，list/capacity 40s，session 12s）；ACL 补 `sms` 读写授权
- **feat(urc) +CMTI 走短信最高优先级**：新短信到达立即调度 `AT+CMGR` 读取并推送，绕过暂停门，不被后台轮询延迟；索引必须纯数字，防 URC 注入 AT 命令
- **test**：cargo check/clippy/test 全过 —— 233 passed, 0 failed（mock 模组 e2e 覆盖：优先级排序、事务不交叉、暂停/恢复、租约过期、实时数据非缓存、发送三档、不自动重发、重复点击去重、长短信分片顺序、并发串行、删除真实结果、取消不挂起）；新增/修改代码 clippy 0 warning（基线遗留 27 条未动）；前端 `sms-center-render` 57 断言重写全过，其余既有测试全过（cellular-icon-test 为基线既有失败与本次无关）。**遗留实机项**：真实模组 CMGS 提示符时序与分片节奏、+CMTI 端到端时延、长短信 60s 预算余量、短信功能开关后模组状态观察

### 升级 rustls-webpki，修复证书校验可能接受不受信任中间证书的问题（RUSTSEC-2026-0382）

> 本节改动随 v1.26.0 一同发布。

- **security(deps)**：`rustls-webpki` 0.103.15 → 0.103.16（`src/rust/Cargo.lock`）。公告指出 0.103.16 之前的版本在校验证书路径时，只要配置的信任锚允许，可能接受包含不受信任 emSign 中间公钥的路径（对应私钥已公开）；0.103.16 / 0.104.0-alpha.8 起拒绝这些公钥
- **security(影响面)**：本项目两条出站 TLS 链路都经 rustls → rustls-webpki 做证书校验，属实际暴露面 —— `ureq`（HTTPS 调用 `https://api.bot.qq.com`，QQ 绑定与消息推送）与 `tokio-tungstenite`（`rustls-tls-webpki-roots`，QQ WebSocket 网关）；代码中未关闭证书校验
- **test**：`cargo check --locked` 通过，依赖解析无冲突，升级后正常编译

## v1.25.2 (2026-10-22)

### 修复短信「显示发送成功但实际发不出去」（issue #19 真正成因）

- **fix(sms) 提交字符 0x1A 在传输链路被改写**：v1.24.5 的修法（拆成两段式、第二步发 `PDU + 0x1A`）方向正确，但**控制字节到不了串口**。0x1A 需穿过「浏览器 JSON → rpcd → ucode → nc → Rust」四层，实测被转义成**字面量 `u001a` 六个字符**（后端日志 `发送 → 模组` 行 hexdump 为 `43 75 30 30 31 61`，无 0x1A、无转义反斜杠），模组永远等不到提交字符，前端却因拿到 `> ` 提示符显示成功 —— 与 issue #19 的现象完全一致
- **fix(sms) 改为单次写入 `AT+CMGS=<长度>\r<PDU>`**：手册 9.14.5 的示例即此写法，上游 `at-webserver` 3.0.2 也这么发（其前端 bundle 内为 `AT+CMGS=${tpduLength}\r${pdu}`）。整条命令不含任何控制字符，天然免疫这类转义破坏；尾部 `\r` 由后端统一补
- **fix(sms) 提交不再按 2 秒判超时**：模组要把 TPDU 交给网络侧，`+CMGS` 回执取决于信号与基站排队（本机 RSRP −107 dBm 属弱信号）。原统一 `COMMAND_TIMEOUT=2s` 必然超时并报「模组无响应（已等待 2000ms）」，而短信可能已经发出。现为提交单独给 `SMS_SUBMIT_TIMEOUT=40s`，其余命令维持 2s（不让整页的失败检测被拖慢）
- **fix(rpc) 三层超时配套**：前端 `sendCommand(cmd, timeoutMs)` 支持单次覆盖（提交用 45s）；ucode `rpcCall` 支持单次 nc 硬超时覆盖（提交用 50s，其余维持 12s），保证先拿到后端结论而不是被 nc 先掐断
- **test**：实机 hexdump 复核控制字节被改写；按手册 `<length>` 语义（TPDU 字节数，不含 SMSC）核对 PDU 长度；上游 3.0.2 ipk 解包比对发送写法

## v1.25.1 (2026-10-22)

### 状态页三张卡片的内容底边齐平

- **fix(ui) 网络状态卡片底部空白**：三张状态卡在同一行会被网格拉成等高，本卡自身比「信号强度」矮 75px（信息格盒子 222px、内容仅 147px）。原样式 `align-content: start` 把这 75px 全堆在信息格下方，表现为「网络状态卡片下面空了一块、与相邻两张卡不齐」
  - 改为 `grid-auto-rows: 1fr` + `align-items: center`：六格均分剩余高度、单元格在行内居中，最后一行正好落在卡片底部内边距上，与「信号强度」「流量统计」的内容底边齐平（实测三卡 1400 / 1200 / 1100px 三种宽度下内容间隙均为 1px）
  - 单列布局（≤1024px）下卡片高度由内容决定、没有多余空间可分，行为不变
- **style(ui)**：`MT5700_CSS_VERSION` 2.28.0 → 2.29.0

## v1.25.0 (2026-10-22)

### 网络状态卡片重做（SSB 波束矩阵 / 链路拓扑）；拨号成功后下发默认 DNS；服务配置页排版压缩

- **feat(ui) 信号强度改为 SSB 波束矩阵**：新增 `AT^NRSSBID?` 解析（手册 §13.28，PDF pp. 378–381）与 `parseNRSSBID()`，把原「信号强度参考」色阶图例换成**服务小区 8 个 SSB 波束的实测 RSRP(dBm) 矩阵**
  - 档位细分五档并单列「无信号」：优 ≥−80 / 良 −90~−80 / 中 −100~−90 / 弱 −110~−100 / 差 −156~−110，各档不同色；无信号用**虚线边框 + 空心点 + 灰色 + 「—」**，与实线的「弱」一眼可分
  - 无效值严格按手册处理：SSB ID `0xFF`、RSRP/SINR `0x7FFF` 一律置 `null`，按「未上报」渲染而不是当成 −127dBm 之类的怪值
  - 矩阵按 SSB ID 归位（未出现的波束保留空位），实测最强的波束用同色细环标出，不编造「主用波束」之类的说法
  - 轮询节流：每 3 轮（约 15s）查一次，失败保留上一次成功值，不因单次查询失败把界面清空
- **feat(ui) 网络状态卡片改链路拓扑**：SIM 卡 → 蜂窝基站 → 数据网络三节点，节点间虚线流动 + 两端圆点错相呼吸（`prefers-reduced-motion` 下静止）；下方信息格改为 2×3（运营商 / 网络类型 / 频段 / CA 状态 / IPv4 / IPv6），全部取自既有 state，无新增接口与命令
- **feat(ui) 信号数值补单位基线**：RSRP/RSRQ/SINR 三格加竖虚线分栏，dBm/dB 单位不再跟着数字下坠
- **test**：新增 `tests/mock-modem/nrssbid-test.js`（24 条断言，含实机真实回包与手册 §13.28.5 样例，覆盖空回包 / ERROR / 字段不足 / `undefined` 入参等失败路径）

### 拨号成功后下发默认 DNS；服务配置页排版压缩

- **feat(iface) 默认 DNS 下发**：拨号成功（`on_uplink`）后向承载接口写入一组可配置的公共 DNS 作为兜底，地址与开关集中在 UCI `at-webserver.config.dns_*`（IPv4 `119.29.29.29` / `223.5.5.5`，IPv6 `2402:4e00::` / `2400:3200::1`），改配置即可换地址，不必改脚本
  - **优先级**：实测 netifd 把 UCI 手写的 `dns` 排在 DHCP/RA 下发的 DNS **之前**（`resolv.conf.auto` 顺序已验证），所以它既是兜底也是实际优先项；`dns_exclusive` 默认 `1`（`peerdns=0`），即**只用自己的 DNS**，运营商下发的不再参与解析
  - **IPv6 硬条件**：仅当本次拨号**实际分配到 IPv6** 才写 —— 判据为 `AT+CGDCONT?` 中激活 CID 的 PDP 类型为 `IPV6`/`IPV4V6` **且** `AT+CGPADDR` 确实给出 IPv6 地址（含点分十进制形式，如 `36.9.141.90.3.72...` 需按 16 段识别）。未拿到 IPv6 时会清掉上一次留下的 IPv6 DNS，避免「无 IPv6 连通性却配着 IPv6 DNS」导致解析随机超时
  - **三态判定**：IPv6 结论分「确认有 / 确认没有 / **无法判定**」。`reload_service` 是在后端刚重启后重算的，那一刻 ubus 的 `mt5700` 对象可能尚未注册；若把「AT 查询失败」当成「没有 IPv6」，一次普通的配置保存就会把正常的 IPv6 DNS 清掉。无法判定时既不写也不清
  - **生效与清理**：改完 DNS 必须重启接口才进 `resolv.conf`（实测仅 `uci commit` 不生效），故只在接口已处于稳态时补一次 `ifup`；清理挂在两个明确且不会自我触发的时机上 —— 下次拨号按实际情况重判、以及 `stop_service`。**不挂 hotplug `ifdown`**：netifd 的 `ifup` 语义是 down→up，且 hotplug 由 procd 异步派发，实测两种自动清理方案都会误伤（刚写完被自己清掉 / 异步重算覆盖显式判定）
  - **权限边界**：`manage_interface=0` 时一律不写 DNS —— 那时接口属于用户，写进去只会覆盖他手工配的解析服务器
  - **接口**：`on_uplink` 新增可选参数 `1|0` 显式声明本次是否拿到 IPv6（不传则自行经 `ubus call mt5700 at` 查 AT 判定）；新增 `on_downlink` 动作（手动排查用）
- **feat(ui) 服务配置页新增「默认 DNS 下发」卡片**：启用开关、四个地址输入框、独占开关；保存后即时重算生效（`reload_service` 里补一次 `apply_default_dns`），无需等下一次拨号
- **style(ui) 服务配置页排版压缩**：桌面端 5332 → 3430px（−33.6%），手机端 6490 → 4503px（−30.6%），无横向溢出
  - 新增 `.mt5700-form-grid` 两列表单网格（桌面），字段组各占一格、提示块与按钮行自动横跨整行；`.mt5700-span-2` 用于路径过长需要整行的字段（串口选择器）
  - 手机端（≤768px）改「标签在上、控件在下」为「标签在左、控件在右」，一个字段只占一行；说明文字仍另起一行横跨两列，避免被压成竖条
  - 掐掉重复留白：`page-body` 的 `gap` 与 `.mt5700-card` 的 `margin-bottom` 原本叠加成 28px，只保留一份；提示字号/行高与输入框内边距各降一档
  - 按需显示的分组（自定义串口路径、IPv4/IPv6 接口名）由内联 `style.display` 改为 `hidden` 属性 —— 移动端横排用了 `display: grid !important`，内联样式压不住，实测会让这些分组在手机上全部冒出来
  - 「推送文案」卡片的「批量汇总标题」由普通单行 `input` 改为与前五项一致的两行模板框（`mkTplArea(2)`）：原本它等比字体、高度、边框都与相邻模板框不同，在同一张卡里明显像另一个控件
  - 手机端含多行文本框的分组恢复「标签在上」并占满整行宽 —— textarea 高度只由 `rows` 决定、不会跟内容长高，横排给它的右侧一列装不下换行后的模板文案，实测文字被裁掉
  - **下拉框不再溢出卡片**：网格项的 `min-width` 默认值是 `auto`，作为 grid/flex 项会被解析成「内容最小宽度」——对 `<select>` 就是最长选项不换行时的宽度（实测固定 210px）。列宽小于它时下拉框顶破卡片右边界（1024px 略溢出，768/430px 溢出 3~30px）。给网格内的 `input`/`select` 显式 `min-width: 0; max-width: 100%`，实测 375~1400px 八档宽度全部零溢出
  - **下拉框箭头留位**：压缩内边距时用了 `padding` 简写，把 `.mt5700-select` 原本的 `padding-right: 40px`（专给背景 SVG 箭头让位）一起覆盖了，长选项文字会压到箭头上、看起来像「没有箭头」。补回右侧内边距并对齐箭头位置
- **test**：实机 busybox awk 用例 5/5（点分十进制/冒号/纯 v4/多行 CGDCONT 定位）；实机验证下发、静置 20s 无抖动、`on_uplink 0` 清 IPv6 保留 IPv4、`on_uplink 1` 恢复、关闭开关清空、`on_downlink` 只清 IPv6、UI 改值保存后 `resolv.conf` 即时更新

---

## v1.24.5 (2026-10-21)

### 修复短信中心「显示发送成功但短信没发出去」（issue #19）

- **fix(sms) PDU 提交补 Ctrl+Z**：PDU 模式发短信是两段式协议（`AT+CMGS=<长度>` 等 `> ` 提示符 → `<PDU>` + 0x1A 提交）。旧实现把两步拼成一条 `AT+CMGS=<长度>\r<PDU>`，后端的提示符结束逻辑把 `> ` 当成成功应答，前端弹出「发送成功」——但**提交字符 0x1A 从未下发**，模组停在输入等待态，短信根本没发出去。现拆为两条独立命令，第二步以 0x1A 结尾（0x1A 经 JSON `\u001a` 转义穿过「浏览器 → rpcd → ucode %J → serde_json → 串口」全链路，逐段已核实）
- **fix(sms) 假成功防护**：最终应答必须含 `+CMGS` 或 `OK`，只拿到提示符应答时判失败并展示模组原始响应；任一步（报长度 / 交 PDU）失败立即中断发送链，不再只检查最后一条
- **fix(sms) 模式判断收紧**：仅当确认已是 PDU 模式（应答含 `+CMGF: 0`）才跳过切换；查询失败或应答无法解析时一律强制 `AT+CMGF=0`，杜绝文本模式下 `AT+CMGS=<长度>` 被当作「发到号码 <长度>」的歧义
- **test**：mock 模组按真实协议复刻两段式交互（提示符结尾不带换行、PDU+0x1A 才回 `+CMGS/OK`、零长度 TPDU 拒答）；渲染测试改用**真实** `smsEncode.js`（原 stub 连 `buildSubmitParts` 都没有，发送流程从未被覆盖），新增 17 条断言（正常两段式 / 假成功防护 / 文本模式强制切换 / 模组拒绝），并用旧版前端反向验证测试确能抓住该 bug；e2e 新增 4 条全链路断言
- **docs**：新增 `docs/release-notes/v1.24.5.md`

## v1.24.4 (2026-10-21)

### LuCI Tab 菜单滚动位置保持 + 统一 SVG 图标；CI 不再向仓库写入构建日志

- **feat(ui) Tab 滚动位置保持**：新增 `at-webserver/tabmenu.js`（12 个视图全覆盖），页面加载后自动把选中项滚入可视区；`sessionStorage` 记忆手动滚动偏移，返回/刷新时按「选中项仍完整可见则恢复、否则居中」取舍；视口缩放、横竖屏切换、Web 字体加载完成后 debounce 150ms 重校正。对 LuCI 与主题零侵入：不改主题文件、不拦截点击、不改 href、不删节点
- **feat(ui) 统一 SVG 图标**：按 `li.tabmenu-item-<name>` 为 12 个页签注入 24×24 线性图标（`stroke=currentColor`，桌面 16px / 移动端 15px），语义逐项匹配（网络状态=脉冲、拨号=插头、扫频=雷达、锁频=时钟、短信=气泡、终端=提示符、日志=文件、服务配置=齿轮等），未知页签走同心圆兜底；`MT5700_CSS_VERSION` 2.24.0 → 2.25.0 保证缓存刷新
- **fix(ci) 不再写入 ci-logs 分支**：移除 workflow 的「日志归档」步骤（原步骤用 `git checkout --orphan` 创建孤儿分支并 force push），Actions 不再向仓库写入任何内容，构建日志仅保留在 Actions 运行日志中
- **test**：新增 `tests/tabmenu-test.js` 28 项断言（图标库与 menu.d 对齐、纯函数边界、argon/openwrt-2020/换行/异步渲染/非本插件页面守卫/兜底图标）；Chromium 复刻 LuCI Tab 渲染链路 18 项断言全部通过
- **docs**：新增 `docs/release-notes/v1.24.4.md`

## v1.24.3 (2026-10-17)

### 修复 CI：中间态 commit 不再触发完整构建

- **fix(ci) 陈旧提交跳过**：批量改动若以「一次一个文件」的方式推送，每个文件都是独立 commit，push 事件**逐 commit 触发** —— 一次 19 文件的改动就起了 24 个 run 排队。其中「改了一半」的中间 commit（例如删掉了 `localtime::now_string` 但 `signalwatch` / `urc` 还没改成 `nettime`）编译必然失败，白占 6 个架构矩阵各跑一遍 SDK 编译
  - 现在 build job 先用 `git ls-remote` 比对分支 HEAD：不是最新的提交**直接跳过**依赖安装 / 构建 / 产物校验 / 归档，release job 同步跳过（否则会因缺产物失败）
  - tag 推送与手动 dispatch 不受影响（本来就是终态）
- **note(ci) 并发策略保持不变**：`concurrency` 仍按 `github.sha` 分组且 `cancel-in-progress: false` —— 一次发布会同时产生 main push 与 tag push 两个**同 sha** 的 run，必须串行才能避免 Release 的 delete+create 竞态；改成按 ref 分组会让两者并行，反而踩回老坑
- **verify 远端代码本身可编译**：拉取 main 最新代码执行 `cargo build --release` —— **通过、零警告**。失败的红叉来自中间态 commit，不是代码缺陷
- **note(ops)**：已取消本次全部在跑/排队的 run（23 个）
- **docs**：新增 `docs/release-notes/v1.24.3.md`

## v1.24.2 (2026-10-17)

### NTP 取到即本地计时，20 分钟再同步；失败逐级退避

- **feat(nettime) 同步节奏**：**取到一次之后就本地计时**（`设备时钟 + 偏移`），不再每次取时间都去问服务器 —— `now()` / `now_ts()` / `now_ms()` 全是纯本地计算，零网络开销。稳态下每 **20 分钟**同步一次（24 小时约 72 次，每轮 48 字节请求 / 48 字节应答）
- **feat(nettime) 失败三级退避**：`3 秒 × 10 次` → `1 分钟 × 10 次` → `20 分钟` 常驻。**任何一次成功都会把连续失败计数清零**，回到 20 分钟节奏
  - 第一级 3 秒 ×10（约 30 秒窗口）：开机拨号/基站注册往往要十几秒才通，重试次数太少会白白掉到分钟级；
  - 第二级 1 分钟 ×10（约 10 分钟窗口）：覆盖拨号慢、短暂断网这类分钟级恢复；
  - 第三级 20 分钟：确认网络长期不可达后的兜底节奏，避免一直每 3 秒空转
- **refactor(nettime)**：退避档位抽成纯函数 `backoff_for(连续失败次数)`（不碰全局状态，便于单测逐级钉住），`run()` 只维护一个 `CONSECUTIVE_FAILS` 计数器
- **test**：`cargo test` **197 passed / 0 failed，零警告**（新增 3 条：稳态 20 分钟、退避三级逐级断言含 10 次边界、0 次兜底档）
- **docs**：README 版本号、安装示例同步至 **v1.24.2**；修正 v1.24.0 发布说明里已过时的「6 小时 / 5 分钟」节奏描述；新增 `docs/release-notes/v1.24.2.md`

## v1.24.1 (2026-10-17)

### 全局时间统一走 nettime（NTP 优先 / 设备时钟回退），时区仍读设备

- **refactor(time) 统一时间源**：插件里凡是「现在几点」的地方一律改走 `nettime` —— 日志时间戳（`logger`）、任务创建时间（`async_runtime`）、短信 PDU 时间兜底（`pdu`）、通知与 URC 时间（`notify` / `urc`）、信号巡检时段判定（`signalwatch::minute_of_day_now`）、定时锁频（`schedule`）。此前这些点各自取 `localtime::now()` / `SystemTime::now()`，NTP 校正后会出现「日志一个时间、通知另一个时间」的两条时间线
- **note(time) 时区仍然读设备**：`nettime` 只负责**校正 UTC 时刻**（NTP → 设备时钟回退），**时区**依旧沿用 OpenWrt 系统设置（`/etc/TZ` → uci），取不到才回落北京时间 —— 两者正交，`localtime` 收敛为纯时区层（删除了已无人调用的 `now_string` / `minute_of_day_now`）
- **fix(atclient) 间隔测量改用单调时钟**：长命令「结束于何时」原来用 `SystemTime`（墙上时间）算差值，NTP 校正或手动改时间会让这个差值失真；改为基于 `Instant` 的进程单调毫秒（`mono_ms()`），**耗时/节流/有效期一类间隔一律不碰墙上时钟**
- **test 源码级回归用例**：新增 `nettime::tests::no_direct_wall_clock_outside_time_modules`，扫描 `src/` 下除 `localtime.rs` / `nettime.rs` 外的所有源文件（剥离注释后匹配），一旦出现 `chrono::Utc::now()` / `chrono::Local` / `SystemTime::now()` 即测试失败 —— 这条约定以后由 CI 兜底，不再靠人记
- **test**：`cargo test` **194 passed / 0 failed，零警告**（v1.24.0 为 195：删除 `localtime` 已废弃的 2 条用例、新增 1 条回归用例）
- **docs**：README 版本号、安装示例同步至 **v1.24.1**，新增 `docs/release-notes/v1.24.1.md`

## v1.24.0 (2026-10-17)

### 自动清零改为「每月几号」；新增 NTP 时间源；日志文件大小封顶

- **feat(usage) 按月清零**：自动清零从「累计满 N 天」改为**每月固定几号**（UCI `usage_reset_day`，默认 **1 号**，范围 1~31）。按自然月对账，不再在月里漂移
- **feat(usage) 支持大小月**：新增 `src/rust/src/monthly.rs` 负责全部日历算术 —— 闰年（能被 4 整除且不被 100 整除，或被 400 整除）、跨年进位、**31 号这类小月没有的日子按当月最后一天触发**（平年 2 月 → 28 号，闰年 → 29 号），不会整月漏清；一个月只清一次
- **feat(nettime) NTP 时间源**：新增 `src/rust/src/nettime.rs`，依次尝试 **ntp.tencent.com → ntp.aliyun.com → time.cloudflare.com**（UDP 123，NTPv4 客户端），成功即以「NTP 时刻 − 设备时刻」为偏移持续校正；**三个都不可达则回退设备时钟**并在日志页/流量卡提示。时区仍沿用 OpenWrt 系统设置（`/etc/TZ` → uci），**取不到才回落北京时间**
- **fix(logs) 日志不再无限增长**：新增 `src/rust/src/ringlog.rs`。通知日志文件（`/tmp/at-notifications.log`）原来是纯 append、**没有任何上限**，长期跑会吃满 tmpfs；现在写入前按上限（默认 **256 KiB**，UCI `log_file_max_bytes` 可调）先按行边界裁掉最旧的一半再追加，**绝不切出半行**
- **refactor(logs) 默认走内存环形缓存**：后端日志缓冲改用 `RingLog`，**条数（1200）+ 总字节（512 KiB）双上限**淘汰 —— 只限条数不够，一条超长 URC/短信正文照样能撑大内存；日志页默认读内存环形缓存，序列化结构不变
- **refactor 新增独立模块**：`monthly.rs` / `nettime.rs` / `ringlog.rs` 三个新模块各司其职，`usage.rs` 只保留「该不该清」一句调用，未往既有模块里堆逻辑
- **note(ui)**：流量卡片「自动清零」改为「**每月清零**」+ 「号」，输入范围 1~31；NTP 不可达时卡头显示琥珀色「时间源: 设备时钟」提示（日期可能不准）
- **note(config) 配置项变更**：`usage_auto_reset_days`（天数）作废，改为 **`usage_reset_day`**（每月几号）。旧键不再读取，升级后自动清零回到默认「每月 1 号」
- **test**：`cargo test` **195 passed**（基线 165，新增 30 条：`monthly` 12 条覆盖大小月/闰年/跨年/边界，`nettime` 9 条覆盖报文解析与纪元回退，`ringlog` 9 条覆盖双上限与按行裁剪），**零警告**；`tests/parse-regression-test.js` 不受影响
- **docs**：README 版本号、安装示例同步至 **v1.24.0**，新增 `docs/release-notes/v1.24.0.md`

## v1.23.1 (2026-10-17)

### 修复「自动清零」输入框数字被遮挡 + 前端冗余样式清理

- **fix(usage) 自动清零输入框遮挡**：流量卡片「自动清零」天数输入框里输入的数字显示不全。根因是全局深度美化规则 `input[type="number"] { padding: 8px 14px !important; font-size: 13.5px !important }` 把 `.mt-usage-days` 自己的 `padding: 1px 6px` 整个顶掉 —— 58px 宽减去左右各 14px 内边距后内容区只剩约 27px，4 位数字（最大 3650）直接溢出被裁，再叠加 number 输入框自带的步进箭头（spinner）压在数字上。修复：改用更高特异性选择器 + `!important` 拿回尺寸控制权（宽 72px / padding 2px 8px / 字号 12.5px），隐藏步进箭头（键盘 ↑↓ 与输入仍可用），对齐改为居中避免残余箭头遮挡，并加 `flex: 0 0 auto` 防止被 flex 压缩
- **refactor(css) 冗余样式清理**：用「类名在全部 JS/uc/模板源码中出现性 + 动态拼接前缀识别」静态审计，删除 mt5700.css 中 64 个死类规则块（旧版 mt5700-* 仪表盘 / verdict / gauge / skeleton / spinner / 裸 modal-* / temp-* 温度着色体系等）与 24 个被后续同选择器规则完全覆盖的重复声明块、7+2 个孤儿 `@keyframes` 与 6 个孤儿 `--mt5700-temp-*` 设计令牌；at.css 删除 3 个死类块。**mt5700.css 5447 → 4919 行（-528 行）**
- **note(verify) 回归验证**：以 `docs/layout-test/status-mock.html` 为基准，在 380 / 768 / 1024 / 1440 / 1920px 五档视口下对清理前后做全页截图像素对比 —— **差异像素 0**，排版零变化；输入框用 Playwright 实测 `scrollWidth 76 > clientWidth 56`（裁切）修复为 `70 = 70`（无裁切）
- **note(css)**：样式版本 `MT5700_CSS_VERSION` 升至 **`2.23.1`**，`AT_CSS_VERSION` 升至 **`1.11.1`**（升级后强刷生效）
- **docs**：README 版本号、安装示例同步更新至 **v1.23.1**，新增 `docs/release-notes/v1.23.1.md`

## v1.23.0 (2026-10-16)

### 使用量统计改为后端常驻累计，支持自动清零

原来的累计逻辑放在 rpcd 的 ucode 插件里，由前端每秒轮询触发 —— 页面关着就不累计（只能靠内核计数器单调性在下次打开时补记）。本次把统计整体挪进 **Rust 后端常驻进程**，前端关闭 / 刷新都不再影响。

- **feat(usage) 后台常驻统计**：新增 `src/rust/src/usage.rs`，后端 1 秒一采独立累加，与前端是否打开无关；前端改为通过新 RPC `usage` 只读快照
- **feat(usage) 自动清零**：新增 `usage_auto_reset_days`（UCI，**默认 30 天**，范围 1~3650），到期由后端自行清零并重新基线，无需前端参与；流量卡片新增「自动清零」天数输入 + 保存按钮
- **fix(usage) 清零连文件一起清**：清零按钮无论持久化开关状态如何都强制重写/删除记录文件（持久化开着时把落盘文件一并清零，关着时删掉落盘文件），不再残留旧值
- **feat(usage) 限制记录文件大小**：`MAX_USAGE_FILE_BYTES = 4096`，既是写入断言也是读取准入线 —— 超限文件一律视为损坏并忽略，绝不把异常大的文件读进内存
- **refactor(usage)**：ucode 的 `netrate` 恢复为纯计数器读取（不再累加），`usage` / `usage_ctl` 改为代理到 Rust；ACL 放行 `usage`
- **fix(usage)**：承载网卡探测逻辑在 Rust 侧重实现（UCI 指定接口 → sysfs USB 网卡 → `network.MT5700M` → `eth2`），网卡读不到计数时自动重新探测
- **test**：`cargo test` 新增 9 条 `usage` 单测（正增量累加 / 计数器归零不误记 / 换网卡保留累计 / 首次只建基线 / 峰值节拍守卫 / 文件超限拒绝 / 序列化往返 / 天数夹取），**150 passed**；`parse-regression-test.js` 仍 **29/29 通过**
- **docs**：README 版本号、安装示例同步更新至 **v1.23.0**，新增 `docs/release-notes/v1.23.0.md`

## v1.22.0 (2026-10-16)

### 新增：签约速率改用厂商命令，4G 也能显示；修正制式角标写死 5G

- **feat(sim) 4G 可用**：签约速率改用厂商命令 **`AT^DSAMBR=<cid>`**（手册 16.17「签约速率查询」），返回 `^DSAMBR: <cid>,<下行>,<上行>[,<APN>,<状态>]`，单位 kbps，**4G / 5G 下都能取到真实签约速率**；`parse.js` 新增 `parseDsambr` 解析器，只按前三个位置取值，多余字段原样保留不臆测
- **feat(sim) 兜底**：`AT^DSAMBR` 取不到时才回退标准命令 `AT+C5GQOSRDP`（Session-AMBR）；两者都取不到则显示「模组未上报」，不用其它参数编造
- **fix(ui) 制式角标**：信号强度卡片角标原来**写死 `5G`**，4G 下也显示 5G。现改为与当前驻网制式同源（NR→5G / LTE→4G / WCDMA→3G / GSM→2G），取不到显示 `—`
- **fix(sim) 去掉悬浮提示**：按需求移除签约速率行的 `title` 悬浮说明
- **verify 流量统计数据源核对**：独立读取 `/sys/class/net/eth2/statistics/` 内核计数器，与页面「本次使用量」在同一时间窗内对比 —— **差值 0.30%**（残差来自页面 1s 采样粒度），确认数据源为模组上网口的真实内核计数器；同期 LAN 口 eth0 差值 1336%，证明未误用 LAN 口
- **test**：`tests/parse-regression-test.js` 新增 5 条 `parseDsambr` 用例（5G / 4G / 空值 / 无匹配），**29/29 通过**
- **docs**：对历史发布说明做**脱敏**处理（移除设备内网 IP、真实签约速率数值）；README 版本号、安装示例同步更新至 **v1.22.0**，新增 `docs/release-notes/v1.22.0.md`

## v1.21.1 (2026-10-16)

### 修正：签约速率只取数据上网上下文，不取 IMS

v1.21.0 的签约速率查询把 CID 写死成 `1`。本机 `AT+CGDCONT?` 里 CID 1 恰好就是数据上网承载（`+CGACT: 1,1`，APN 为空由核心网分配），IMS 是独立的 CID 5（APN `ims`，未激活），所以数值本身没错；但写死 CID 在别的拨号配置下会查错上下文。

- **fix(sim)**：改为查询 `pickDataContext()` 选出的**数据通道 CID**（`state.apnCid`），该函数已剔除 IMS / 紧急 / MMS / SUPL 等专用承载 APN，因此绝不会查到 IMS 那条；取不到时才退回 CID 1（默认数据上下文）
- **fix(sim)**：新增 IMS 兜底防护——若返回的 5QI 是 **1（VoLTE 语音）/ 5（IMS 信令）**，判定拿到的是 IMS 承载，直接不显示，宁可空着也不张冠李戴
- **fix(sim)**：查询后一律刷新 `state.subRate`（含清空），避免切网/摘卡后残留上一次的旧数值
- **note(ui)**：签约速率行的 `title` 说明改为标明所查的数据上下文 CID；样式版本号 `MT5700_CSS_VERSION` 升级至 **`2.22.1`**
- **docs**：README 版本号、安装示例同步更新至 **v1.21.1**，新增 `docs/release-notes/v1.21.1.md`

## v1.21.0 (2026-10-16)

### 新增：SIM 卡信息显示「签约速率」

「SIM 卡信息」页新增 **签约速率 (Session-AMBR)** 一行，显示核心网下发的上下行上限。

- **feat(sim)**：新增 `AT+C5GQOSRDP=1` 查询（5GS QoS 动态参数），在 `parse.js` 新增 `parseC5gQosRdp` 解析器，取末尾两个字段作为签约上下行速率（单位 kbps）
- **feat(sim)**：数据显示为 `↑ <上行> / ↓ <下行>` 形式；数值直接来自模组，**不做凑整**（按十进制如实换算），并附 `title` 说明数据来源
- **note(sim)**：4G 下本固件同一命令只回 `5QI=0`、速率字段全空（且所有 EPS QoS 命令 `AT+CGCONTRDP`/`AT+CGEQNEG`/`AT+CGQREQ` 均返回 ERROR），此时**如实显示"模组未上报"**，不用其它参数编造速率
- **test**：`tests/parse-regression-test.js` 新增 4 条用例（5G 有值 / 5G 非 GBR 字段为空 / 4G 为空不编造 / 无匹配返回 null），**25/25 通过**
- **docs**：README 版本号、安装示例同步更新至 **v1.21.0**，新增 `docs/release-notes/v1.21.0.md`

## v1.20.0 (2026-10-16)

### 新增：流量统计卡片「本次使用量」统计

给「流量统计」卡片加了**本次使用量**分区：下行 / 上行 / 合计 / 采样时长 / 峰值速率五项，由**设备侧**持续累计，**页面刷新不失效**（重启后归零），并附带两个小按钮。

- **feat(usage) 设备侧累计**：在 rpcd ucode 插件（`mt5700.uc`）内基于接口单调累计计数器做增量累加，统计值由设备持有，与浏览器会话无关，**刷新页面数字继续**，接口 flap（计数器归零）时只重置基线、不累加，避免把一次归零误记成巨额流量
- **feat(usage) 零磨损存储**：默认只写 `/tmp`（tmpfs，纯内存、零闪存磨损）；开启「持久化」才落盘 `/etc/at-webserver-usage.json`，且**每 10 分钟最多写一次**，稳态运行只读 tmpfs、完全不碰闪存，重启后从落盘文件恢复
- **feat(usage) 可选持久化**：新增 `持久化` 小按钮，一键切换跨重启保留 / 关闭（关闭即删除落盘文件）
- **feat(usage) 支持清零**：新增 `清零` 小按钮，通过新增 RPC 方法 `mt5700.usage_ctl` 清零本次累计（持久化开关状态保留）
- **note(ui)**：样式版本号 `MT5700_CSS_VERSION` 升级至 **`2.21.0`**
- **docs**：README 版本号、安装示例同步更新至 **v1.20.0**，新增 `docs/release-notes/v1.20.0.md`

## v1.19.1 (2026-10-16)

### 修复：手机端信号趋势需要长按才能看数据

v1.19.0 的触摸交互设计有缺陷：`pointerup` 立即收起悬浮卡，导致**单击只能闪一下**，要看数据得一直按住；而长按又会触发系统的文本选中 / 长按菜单，与取数交互冲突。

- **fix(chart)**：改为**单击常显** —— 触摸点一下数据点即固定显示该点读数，松开后不收起；拖动可在点位间移动。
- **fix(chart)**：**再次点击同一个点**收起；**点击图表以外的区域**也收起（整页仅注册一个 `document` 监听）。
- **fix(chart)**：跨重绘保持选中 —— 历史每 5 秒重绘会重建 SVG，现按**时间戳**恢复上一次选中的点，悬浮卡不再每 5 秒闪没。
- **fix(chart)**：屏蔽长按系统行为 —— 命中区加 `contextmenu` 预防，图表容器加 `user-select:none` / `-webkit-touch-callout:none` / 透明点按高亮，长按不再弹出选中或菜单。
- **note(ui)**：样式版本戳 `MT5700_CSS_VERSION` 递增至 **`2.20.1`**。
- **docs**: README 版本徽章与安装示例同步至 **v1.19.1**；新增 `docs/release-notes/v1.19.1.md`。

## v1.19.0 (2026-10-16)

### 重构：信号趋势图表全面重做

对「网络状态」页的 **信号趋势** 卡片做了整体重做，覆盖数据真实性、可视化形态、交互与移动端。

- **feat(chart)·数据诚实**：删除首屏**合成基线**（旧实现在首次采样时用 `curR ± 2` 等偏移伪造 5 个历史点，让曲线"立刻好看"）。现在只累积设备真实采样；缺读数在历史里写 `null`，绘图按**缺口如实断开**，绝不把缺口连成一条并不存在的平滑线。孤立采样点补绘小圆点，避免该采样在图上消失。
- **feat(chart)·可视化重做**：双 Y 轴保留（左 RSRP / 右 SINR，RSRQ 细虚线）。质量分区带更柔和并在右侧标注档位（极佳/良好/一般/较差）；末端采样点改为**呼吸脉冲点**标记"当前"；配色改为 Soft-Anime 柔和调色。
- **feat(chart)·交互升级**：图例改为**可点选开关**，点一下显隐对应曲线（曲线、端点、悬浮点、悬浮卡行同步增减）；新增 **15点 / 30点** 显示范围切换；新增 **顶部读数条**（实时 RSRP/SINR/RSRQ 大字读数 + 采样进度），隐藏的序列在读数条中一并弱化。
- **feat(chart)·触摸支持**：悬浮查看改为 **pointer 事件**，鼠标悬浮与手机触摸拖动共用同一套逻辑；命中区 `touch-action:none`，拖动查看数据点不会误触页面滚动；悬浮卡只列出当前可见序列，高度自适应。
- **fix(chart)·移动端**：窄屏图高由 300 提升到 320，刻度与悬浮字号加大；时间轴先前在窄屏被截成 `时:分`，同一分钟内多点会显示成三条一模一样的标签，现一律保留到秒。
- **note(ui)**：样式版本戳 `MT5700_CSS_VERSION` 递增至 **`2.20.0`**。
- **docs**: README 版本徽章与安装示例同步至 **v1.19.0**；新增 `docs/release-notes/v1.19.0.md`。

## v1.18.3 (2026-10-16)

### 修复：移动端看板娘头像被压成椭圆

v1.18.2 修好了英雄卡片的行布局，但暴露/残留了头像变形问题。

- **fix(ui)**: 移动端存在 `.mt-mascot-avatar { width: 75px !important; height: 65px !important }` 的**非等比**规则。桌面端另有一条 76×76 的规则在源码中更靠后、正常生效；但经 CSS 压缩重排后，75×65 这条在产物中反超，圆形头像被拉成**椭圆**（容器 75×65，内图 69×59）。
- **fix(ui)**: 在移动端修复块内以高特异性强制头像**正方形** —— `.mt5700-hero-card .mt-mascot-avatar.mt-mascot-avatar { width:72px; height:72px; aspect-ratio:1/1 }`，并确保内图 `width/height:100% + object-fit:cover + border-radius:50%`。实机（360px）复测：头像容器 **75×65 → 72×72**（正方形，圆不变形）。
- **note(ui)**: 样式版本戳 `MT5700_CSS_VERSION` 递增至 **`2.19.3`**。
- **docs**: README 版本徽章与安装示例同步至 **v1.18.3**；新增 `docs/release-notes/v1.18.3.md` 发布说明。

## v1.18.2 (2026-10-16)

### 修复：移动端英雄区看板娘排版（压缩产物中样式被反超）

v1.18.1 的看板娘移动端排版在**源码预览下正常**，但装到实机后仍不生效——根因在构建链而非样式本身。

- **fix(ui)**: **CSS 压缩会合并/重排多个 `@media (max-width: 768px)` 块**，导致「把修复块追加到文件末尾」不再等于「在产物里最后生效」。实测打包后的 `mt5700.css` 中，更早的 `.mt5700-hero-art { width: 100% !important; flex-wrap: wrap !important }`（移动端深度自适应块）被排到了本修复块**之后**并反超：看板娘占满整行、文案列被压缩成 **0 宽**（标题竖排成一列），英雄卡片在 360px 下高达 **443px**。
- **fix(ui)**: 修复块改用**重复类名提高特异性**（`.mt5700-hero-card.mt5700-hero-card`、`.mt5700-hero-art.mt5700-hero-art` 等，0,2,0 级），以权重而非源码位置稳定压过同 `!important` 的旧规则，与压缩器如何重排无关；同时给移动端文案列补 `min-width: 0`、看板娘容器补 `min-width: 0`。
- **verify**: 实机（360px 视口）Playwright 复测 —— 英雄卡片高度 **443px → 133px**，文案列宽 **0 → 211px**，看板娘 **296px → 75px** 贴右居中。
- **note(ui)**: 样式版本戳 `MT5700_CSS_VERSION` 递增至 **`2.19.2`**。
- **docs**: README 版本徽章与安装示例同步至 **v1.18.2**；新增 `docs/release-notes/v1.18.2.md` 发布说明。

## v1.18.1 (2026-10-16)

### 修复：深度网络诊断上行发射功率无数据 + 移动端英雄区看板娘排版

补丁版本，两处修复均已实机部署验收。

- **fix(status)**: **深度网络诊断「上行发射功率 (PUSCH / PUCCH)」在 5G 下恒为空**。根因是诊断链只下发 `AT^TXPOWER?`，而该命令**仅在 GUL（2G/3G/4G）下有效**——NR 注册态下模组直接返回 `ERROR`，解析结果为空、界面只剩占位符「—」。现改为在 `AT^TXPOWER?` 之后再查 **`AT^NTXPOWER?`**（NR 各信道发射功率），渲染时**优先采用 NR 读数、取不到再回退 GUL**。实机（NR，N41）验收：`AT^NTXPOWER?` 返回 `^NTXPOWER: 22,-13,25,-18,2565000`，页面显示 `22 dBm / -13 dBm`（PUCCH 随调度实时变化）。
- **feat(parse)**: 新增 `Parse.parseNrTxPower()` —— 按手册 `AT^NTXPOWER` 定义解析**最多 4 个载波**，每 5 字段一组 `<PPusch>,<PPucch>,<PSrs>,<PPrach>,<Freq(kHz)>`；无效值 `999` 与频点 `0` 统一归 `null`，多载波时按「载波 N PUSCH / PUCCH」并列展示。`Parse.parseTxPower()`（GUL）保留为纯 LTE 场景回退。
- **test**: `tests/parse-regression-test.js` 新增 6 项发射功率回归用例（实机单载波样本、手册 2CC 样本、`999` 无效值、`ERROR` 无数据、GUL 回退），全套 **21/21 通过**。
- **style(ui)**: **移动端（≤768px）英雄区看板娘排版重做**。原先窄屏继承 960px 断点的 `column` 布局，看板娘被 `flex-end` 顶到卡片右下角、左侧留下大片空白、卡片被撑高（约 233px）。现改为紧凑的「**左文右娘**」行布局：文案列占满剩余宽度自动换行、看板娘垂直居中贴右，标题/描述字号同步收敛；实测卡片高度回落至约 129px（320/360/390/768 四档均验证）。
- **note(ui)**: 样式版本戳 `MT5700_CSS_VERSION` 递增至 **`2.19.1`**，确保浏览器拉取到新版英雄区样式，避免「代码已更新、页面仍是旧样式」。
- **docs**: README 版本徽章与安装示例同步至 **v1.18.1**；新增 `docs/release-notes/v1.18.1.md` 发布说明。
- **verify**: 实机热部署后 Playwright 验收 —— 诊断行不再为空、看板娘窄屏排版正常、无新增控制台报错；回滚副本置于 `/root/mt5700-rollback/`。

## v1.18.0 (2026-10-16)

### 拨号页：常用运营商 APN 预设按四大运营商实际接入点重做

- **fix(apn)**: 修正两处与实际不符的预设。联通 `uninet` 是**公网**接入点、并非物联网专用，电信物联网卡实际也不走 `ctiot`——联通物联网改为 `unim2m.njm2mapn`（备选 `unim2m.gzm2mapn`），电信物联网按现网做法走 `ctnet` + PAP/CHAP 鉴权。
- **feat(apn)**: 物联网卡预设补齐**中国移动 5G 物联 `cmiot5g`**（移动物联卡 5G 专用接入点，与 4G 通用的 `cmiot` 分开列出）。
- **chore(apn)**: 预设**只收录 4G/5G 仍在用的接入点**——移动 `cmwap`、联通 `3gwap`/`uninet`、电信 `ctwap` 等 2G/3G 时代的 WAP 网关与旧入口已退网，不再作为预设；每个胶囊的提示里标明适用制式（`3gnet` 属特例：名字带 3G，但它是联通 4G/5G 的标准互联网入口，仍在使用）。
- **feat(apn)**: 预设按「**公众卡 / 物联网卡**」分组，胶囊直接标出运营商简称与 APN 值（原来只写「中国移动」「移动物联」，看不到会填入什么）。
- **feat(apn)**: 胶囊支持**联动填入鉴权信息**。此前只填 APN 一个字段，电信物联网卡这类需要用户名/密码的卡点完仍是空值、拨号必然失败；现在该预设会同时写入用户名 `ctnet@mycdma.cn`、密码 `vnet.mobi` 与 **CHAP 鉴权**，并用琥珀色胶囊 + 提示提醒与卡商核对。
- **fix(apn)**: 切换到不带凭据的预设时**清空**用户名与密码——此前从带鉴权的预设切到公众卡，旧凭据会残留并被一并下发，导致鉴权失败。
- **style(apn)**: 胶囊配色改用 `--mt5700-cyan` / `--mt5700-amber` 主题变量（跟随系统深色模式），保留 hover 微动效；布局由单行 wrap 改为分组两行。

## v1.17.0 (2026-10-16)

### 代码审计清理：移除死代码 / 冗余代码 / 孤立代码

全量静态审计（引用图 + AST lint + `cargo check`）后完成的一次性清理，**不改动任何业务行为**（唯一例外见最后一条）。合计 **-2309 行 / +79 行**，19 个文件；前端 CSS+JS 体积减少约 **36 KB**。

- **refactor(js)**: **`mt5700.js` 1840 → 983 行（-47%）、67847 → 34181 字节**。移除 43 个零引用导出，分四轮迭代（每轮删除后复检，直到「真实调用点」统计归零）：`signalVerdict`（170 行）、`lineChart`（113 行）、`gauge`（88 行）、`SIGNAL_ICONS`（43 行）、`SIGNAL_SPECS`、`GAUGE_PLAIN`、`TEMP_LABELS`、`TEMP_LEVELS`、`tempLabel`、`tempLevel`、`tempClass`、`signalPlain`、`signalBar`、`signalLevel`、`signalCaption`、`levelCaption`、`statusIcon`、`signalIconFor`、`CAP_ICONS`、`capIconFor`、`autoRefresh`、`clearAll`、`errorState`、`syncMetrics`、`renderConnectionBar`、`successButton`、`readonlyField`、`speedBox`、`skeleton`、`capabilityAssess`、`bandPropFor`、`bwCapFor`、`LEVEL_ORDER`、`BAND_PROP`、`BW_CAP_NR`、`BW_CAP_LTE`、`VERDICT_TEXT`、`BAR_COUNT`、`GAUGE_COLORS`、`GAUGE_CAPTIONS`、`_gradSeq` 及其附带的文档注释；`CELLULAR_LEVELS` / `CELLULAR_LABELS` 仅收敛导出（定义仍被 `cellularSignal()` 使用）。
- **refactor(js)**: **`ui.js` 472 → 331 行（-30%）**。移除 17 个零引用导出：`panel`、`field`、`kv`、`tag`、`primaryButton`、`dangerButton`、`success`、`error`、`warning`、`info`、`confirm`、`toast`、`renderConnectionBar`、`deriveNetworkMode`、`page`、`spinner`、`subscribe`。页面实际只用到 `sendCmd` / `startup` / `sleep` / `setFlightMode` / `atErrorText` / `promptModal` / `autoRefresh` / `interval` / `button`。
- **refactor(css)**: **`at.css` 25586 → 7520 字节（-71%，671 → 207 行）**，`mt5700.css` 163264 → 141705 字节（-13%）。共移除 278 条规则 + 6 个 `@keyframes`。裁剪按「类名是否仍出现在 JS/HTML 中」判定（含动态拼接前缀识别），`@media` 内部递归处理，并回收无人引用的动画定义。样式版本戳同步递增 `2.19.0` / `1.11.0`。
- **refactor(parse/rpc/compat/smsEncode)**: 移除 `Parse.parseNrTxPower`、`Parse.ipv6CapDescription`、`AtWs.PDCP_FIELDS` 导出（定义保留——`parsePDCP` 仍在使用）、`AtCompat.available` / `format`、`SmsEncode.isGsm7Char`（定义后从未被调用）。
- **refactor(view)**: 移除 `upgrade.js` 的 `fotaStateText`（FOTA 状态文案映射表，零调用）。
- **chore(deps)**: 清理 10 处未使用的 `'require ...'`（`mt5700.js` / `ui.js` / `dial.js` / `logs.js` / `service.js` / `terminal.js` / `upgrade.js` / `sms_settings.js`），并同步精简 9 个文件 `/* global */` 注释中已失效的全局声明。`network_status.js` 的 `require at-webserver/ui` **保留**——`ui.js` 在模块求值时会注入 `at.css`，属有意的副作用依赖。
- **chore(js)**: 清理 14 处未使用变量 / 无用赋值：`rpc.js`、`service.js`、`network_status.js` 的 `var self = this`，`peakDown` / `peakUp`、`tierColor` / `tierText`、`tier` / `lastItem`，`parse.js` 的 `pid`，`smsEncode.js` 的 `UCS2_MAX` / `count` / `cur` / `curSeptets` / `seq` / `scaOctets`。
- **fix(rust)**: 删除 `qqbind.rs` 中由 `cargo check` 判定的死常量 `WSS_AGENT`、`BIND_WINDOW`；`async_runtime::spawn` 收敛为 `#[cfg(test)]`（生产路径一律走 `spawn_with_timeout`——扫频需要整体超时保护），将来接入无超时的长任务时移除该标注即可。`cargo check` 现存 **0 警告**，`cargo test` **156 项全通过**。
- **chore(repo)**: `htdocs/_layout-test/status-mock.html` 移至 `docs/layout-test/`——该目录此前会随 `luci.mk` 一并装进固件 `/www`，设备上可直接访问到开发期布局 mock；删除 IDE 生成的 `.trae-html-share-packages/`。
- **fix(ui)**: 修复 `network_status.js` 中 `AtWs.ratLabel` 的**命名空间笔误**（应为 `Mt5700.ratLabel`）。该函数定义在 `mt5700.js`，因前缀写错恒为 `undefined`，导致「制式代号 → 可读标签」这条分支**从未生效**（一直走 `c.sysMode || '5G NR'` 兜底）。现修正调用点并按原语义恢复 `Mt5700.ratLabel()`。**这是本次唯一的行为变更**，主载波制式标签将改由 `RAT_CAP` 表输出（如 `5G NR` / `LTE`），建议实机确认一次状态页「网络制式」显示。

## v1.16.0 (2026-10-16)

### LuCI 原生化改造：移除独立夜间模式与英雄栏动态 SVG

- **feat(chart)**: **重绘信号趋势曲线图**（纯原生 SVG）：改为**双 Y 轴**（左轴 RSRP `-125~-53 dBm`、右轴 SINR `-5~35 dB`），避免三条不同量纲的曲线挤在同一坐标系里互相误读；背景按 RSRP 质量分区着色（极佳 / 良好 / 一般 / 较差，阈值与图标分档一致）；曲线改用 Catmull-Rom → 三次贝塞尔平滑并钳制越界点，末端标注当前 RSRP 与质量档位；RSRQ 保留为细虚线参考（量纲独立，不参与双轴刻度）；新增鼠标十字准星 + 三点指示 + 数据卡（时间 / RSRP / SINR / RSRQ / 质量）。修复原图 **左轴 RSRP 刻度与位置错位**（`-107` 与 `-72` 标反）——现刻度值与 y 位置严格对应并有单测锁定。
- **fix(ui)**: 修复状态药丸里的圆点 `.mt-beacon-dot` **垂直偏上**：`.mt-pill-tag` 是 `inline-flex` 但缺少 `align-items: center`，固定宽高的圆点退化为 `flex-start` 顶部对齐；同时空 `inline-block` 在普通文档流中默认按基线对齐也会明显偏上。现给圆点补 `vertical-align: middle` / `align-self: center`，药丸两处规则补 `align-items: center`，并加 `transform-origin: center` 避免该圆点在 SVG 内作脉冲缩放时漂移。实测「已连接 / 实时 / 信号品质」三处圆点与文字中心偏差均为 **0px**。样式版本戳同步递增 `2.18.1`。
- **style(ui)**: **手机端信号强度卡片排版重做**：数值与四格图标改为同排（数值左、图标右，图标 84→64px），大数字 34→28px、品质药丸不再换行，卡片高度由 301px 收到 198px；副指标三列间距收紧。
- **style(chart)**: 信号趋势图**字号与尺寸自适应**：字号由 8~10 放大到「可读但不喧宾夺主」的区间（桌面刻度实际约 11.7px、手机约 10.8px，与卡片正文 12~13px 协调）；窄屏改用 380×300 的 viewBox（缩放比接近 1:1，避免等比缩放把文字压到一半以下）；图表高度改由 viewBox 比例自适应（原固定 330/270px 会留白并二次压缩）。
- **style(chart)**: 趋势图内**文字全部改为英文**（不含中文）：质量档位 `Poor / Fair / Good / Excellent`、末端标注 `Quality …`、悬浮卡 `Time:` / `Quality:`、图例 `RSRP · Left` / `SINR · Right` / `RSRQ · Dashed`、空态提示 `Collecting signal samples…`。
- **fix(ui)**: 网络状态卡的「频段」等长文本原先被 `.mt-net-val { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }` **截断成省略号**，超出可视区域；现改为允许在单元格内换行（`white-space: normal` + `overflow-wrap: anywhere`），并给单元格 `min-width: 0`，载波聚合等长频段组合不再被裁掉。样式版本戳递增 `2.18.6`。
- **style(ui)**: 信号塔图标去掉原容器自带的**浅紫圆形底色与描边**（`--mt5700-accent-pale` 背景 + `border-radius: 50%` + 1px 描边），尺寸由 84px 收到 72px 与图形贴合，图标直接落在卡片背景上；样式版本戳递增 `2.18.4`。
- **feat(ui)**: 网络状态卡的信号塔改为**用户指定的发射塔图标**（1024×1024 视口，7 条 path）：颜色走 `currentColor`，由 `renderSignalUI` 按真实状态切换（`full` 绿 / `strong` 青 / `medium` 琥珀 / `weak`·`error` 红 / `searching`·`connecting` 青·紫 / `none`·`disconnected` 灰），与四格信号图标、状态药丸同一套配色；保留轻微呼吸动画并支持 `prefers-reduced-motion`；原三层波纹 SVG 及其内联 `@keyframes` 删除。
- **fix(ui)**: 状态圆点 `.mt-beacon-dot` **重做对齐**：不再依赖 inline 基线（空 `inline-block` 按基线对齐必然偏上），改为纯 flex 子项定位 —— 容器统一 `inline-flex + align-items: center + gap: 4px`，圆点自身 `display: block; flex: 0 0 auto;`，尺寸收到 6px 与 11px 字号匹配，去掉发光阴影（阴影会撑大视觉重心）、脉冲幅度收紧到 `0.85~1.05`。实测「已连接 / 实时 / 信号品质」三处圆点与文字中心偏差均为 0px。样式版本戳递增 `2.18.3`。
- **refactor(ui)**: 移除看板娘的对话气泡功能（气泡 DOM、逐页台词表、点击换台词交互与 `setBubble()` 接口，以及 `.mt-speech-bubble` 专用样式）；看板娘头像本体（`mascot.png` 与悬浮动效）完整保留。气泡会挤占英雄栏标题并在窄屏下遮挡内容。
- **feat(ui)**: 信号强度卡片改用**四格动态信号图标**（移植自 `cellular-signal-preview.html`）：`Mt5700.cellularSignal()` 以 `data-state` 驱动 9 种状态（无信号 / 1~4 格 / 搜索中 / 连接中 / 已断开 / 连接错误），配套颜色、扫描与闪烁动画、`prefers-reduced-motion` 降级全部在 `mt5700.css`。原环形仪表（`createSignalCircularGauge` / `#sig-gauge-circle` / `.mt-sig-gauge-box`）删除。
- **fix(status)**: 图标状态由真实上报数据推导（`computeCellularState()`），并与品质文案同源，杜绝图形与文字不一致：主载波查询失败 → `error`；SIM 未就绪 → `disconnected`；未注册 / 状态未知 / 等待中 → `searching`（等待态同时覆盖注册被拒与未知为 `error`）；已注册但尚无 RSRP 读数 → `connecting`；已注册且 RSRP 分档 `>= -80 full` / `-95 strong` / `-110 medium` / `>-140 weak` / 其余 `none`。实机（RSRP `-64`、CGREG 已注册、CPIN READY）渲染为 `full` 4 格绿色，文案「极佳 · 满格服务」。
- **style(chart)**: 趋势图**极简化 + 悬浮卡汉化**：图内只保留刻度数值与三条曲线，移除档位文字（Poor/Fair/Good/Excellent）、轴单位（dBm/dB）与末端 RSRP/Quality 文字标注，背景质量分区带保留；图例汉化（`RSRP · 左轴` / `SINR · 右轴` / `RSRQ · 虚线`），悬浮数据卡汉化（`时间:` / `质量:`，档位恢复中文名），空态提示恢复中文。清理随之失效的字号变量。
- **fix(status)**: 修复 APN 信息 **IPv6 无数据**：`AT+CGPADDR` 双栈时一行携带两个地址（实机 `+CGPADDR: 1,"198.51.100.10","32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1"`），旧解析每行只取第一个，IPv6（点分字节格式）被静默丢弃。现 `parseCgpaddr()` 解析行内全部地址并按 family 归类，点分字节 IPv6 转换为压缩冒号格式（`2001:db8::1`）；页面 IPv4 / IPv6 分别按 `family` 取值，不再用 `addrs[0]` 粗暴回退。
- **fix(ui)**: 修复**卡片体双重内边距**：`.mt5700-card-body` 存在三条带 `!important` 的旧规则（`22px 24px` / `16px 18px` / `14px 20px`），与卡片自身 `padding: 20px` 叠加，导致内容区被压缩（拨号页 PDP 网格只剩 300px 宽且两侧留白）。现统一为 `padding: 0`（内边距由卡片自身提供），跨页面卡片内容宽度恢复一致。
- **fix(ui)**: **拨号页 PDP 上下文管理手机端排版**：≤640px 时卡片网格单列全宽（原 300px 固定列且两侧留白）、PDP 卡片内边距收紧、操作按钮两列换行（最小 96px）；表格视图改为容器横向滑动（表格最小 620px，`-webkit-overflow-scrolling: touch`），五列内容完整可查、不再挤压。
- **fix(ui)**: 修复信号图标**频繁误报「信号读取异常」**：状态判定改为「已有 RSRP 读数即按电平分档」，不再让 `AT^HFREQINFO?` / `AT^HCSQ?` 等辅助遥测命令的偶发失败覆盖正常信号；同时 `updateNetworkInfo` 的异常分支不再无条件把 `hfreqSuccess` 置 `false`（该分支无法区分是哪一步失败，改为记录 `telemetryError`），只有主载波查询明确失败且无任何读数时才判定异常。实机连续采样 32 秒稳定为 `full`（RSRP -63~-64）。
- **fix(ui)**: 统一卡片头部度量，消除**同排卡片标题行错位**：`.mt5700-card` 此前头部自带 `padding: 14px 16px 8px` + 下分隔线、内部 `body` 另加 16px 内边距，与 `.mt-card`（卡片 20px 内边距 + 头部无 padding、无分隔线）规范不一致，两者同排或同页时标题行会相差约 6~8px。现统一为卡片 `padding: 20px`、头部 `padding: 0` + `margin-bottom: 14px`、垂直居中（移动端同步）。跨 5 个页面验证头部偏移量完全一致。
- **refactor(ui)**: 移除插件自带的夜间模式按钮 `Mt5700.themeToggle()` 及 `mt5700_theme` 存储键；英雄栏动态 SVG 插画 `Mt5700.heroIllustration()` 连同专用 CSS（`.mt5700-hero-illu-box` / `.mt5700-hero-svg` / `mt-anim-wave*` / `@keyframes mt-wave-expand`）一并删除。**看板娘完整保留**（`mascot.png`、气泡、点击换台词与浮动动画）；`constellationSvg` / `mimoSvg`（MCS 面板使用）原样保留。
- **style(css)**: 删除插件独立的 `mt-theme-dark` / `mt-theme-light` 明暗模式类，暗色配色改为跟随全局主题的 `[data-theme="dark"]` 与系统 `prefers-color-scheme`；核心观感变量（背景/卡片/文字/边框）改为优先继承当前 LuCI 主题的 CSS 变量（`--background-color` 等，未定义时回落插件配色），不同主题下自动适配。
- **fix(status)**: 修复 APN 信息误显示 IMS 的问题 —— 实机 `AT+CGDCONT?` 会同时报出 cid=5 的 `ims` 专用承载，旧逻辑在数据通道 APN 为空（核心网分配）时被后面的 ims 顶掉。现抽取 `pickDataContext()`：剔除 IMS/紧急等专用承载、优先锁定 CID 1 且不再被覆盖，并在 APN 页新增「数据通道 (CID)」行。
- **chore(ui)**: 清理确认无引用的历史残留：旧版内联 SVG 看板娘 `Mt5700.mascotSvg()`（当前看板娘使用 `mascot.png` 图片）、旧气泡样式 `.mt-anime-speech-bubble`、雷达扫描动画 `.mt-anim-sweep` / `@keyframes mt-radar-sweep`。`mt-anim-pulse/spin/stream/float` 仍被 MCS 面板、骨架屏与图标组件使用，予以保留。
- **test**: 新增 `tests/apn-channel-test.js`（12 项：IMS 识别、CID 1 锁定、专用承载排除、异常输入）与 `tests/cellular-icon-test.js`（38 项：9 种状态格数、未知状态回落、全部真实数据分档、文案完整性，以及「有 RSRP 时遥测失败不得误报异常」的回归用例）；全量前端单测 **174 项通过**（17 + 15 + 6 + 12 + 38 + 29 + 10 + 28 + 19）。
- **note(ui)**: 静态样式版本戳 `MT5700_CSS_VERSION` 提升至 `2.18.0` —— 之前多轮样式改动未同步递增，浏览器会沿用缓存的旧 `mt5700.css` 导致「代码已更新、页面仍是旧样式」的错位假象；此后样式变更需同步递增该版本号。
- **verify**: 实机热部署后 Playwright 验收：夜间模式按钮 0 个、英雄栏动态 SVG 0 个、看板娘在列；网络状态页 PCI **128**、CA 状态「单载波 (PCC)」、APN 显示「默认 (核心网自动分配) + CID 1（数据承载）」、星座图/MIMO SVG 正常渲染、无新增控制台报错。

## v1.15.0 (2026-10-15)

### 前端重构：Soft Anime 柔和二次元设计系统与高精度矢量遥测（含隐私脱敏与 Codex 复查修复）

- **feat(ui)**: **Soft Anime 柔和二次元视觉体系**：全量 12 个 LuCI 页面（设备状态、网络设置、拨号设置、全网扫频、定时锁频、模组设置、模组升级、短信中心、短信设置、AT 调试终端、系统日志、服务配置）重构为日系清爽科技风看板 —— 柔和浅蓝 / 淡紫 / 奶白浅色主题，深海军蓝 + 低饱和霓虹暗色模式，圆角卡片、柔和阴影与高斯毛玻璃（`backdrop-filter: blur(16px)`）。
- **feat(mascot)**: **专属看板娘**：圆形头像 + 悬浮呼吸光环微动效，全 12 视图语音气泡统一称呼用户为「可可」。
- **feat(status)**: **状态首页 3 大核心卡片**：大字号 RSRP + 动态 SVG 环形仪表与 RSRQ / SINR 指标；动态信号波纹塔、运营商、具体 3GPP 频段组合（如 `N41 (2565 MHz · 100MHz)`）、CA 状态与 IP；上下行实时火花线（空闲或采样失败时如实画 0，不用随机数伪造流量）。
- **feat(chart)**: **信号趋势图与交互准星**：绘图高度扩展至 330px、5 级标尺刻度（-55 ~ -125 dBm）；鼠标悬浮准星 + 玻璃拟物数据卡实时展示时间戳 / RSRP / SINR / RSRQ，自带边缘防溢出翻转。
- **feat(band)**: **频段组合显示具体频段与中心频率**：解析 `AT^HFREQINFO?` 与 `AT^MONSC`，5G 冠 `N`、4G 冠 `B` 前缀并计算下行中心频率与带宽（如 `N41 (2565 MHz · 100MHz)`），载波聚合以 ` + ` 拼接；状态首页、网络信息 Tab 与载波聚合卡片同步生效。
- **feat(telemetry)**: **载波聚合与硬件高级遥测**：修复载波聚合卡片渲染异常，完整展示 PCC / SCC 中心频率、带宽、ARFCN 与真实 RSRP；动态矢量 QAM 星座图按调制阶数真实匹配点阵（QPSK 4 点 / 16QAM 4×4 / 64QAM 6×6 / **256QAM 16×16 = 256 点**）与 MIMO 空间流波束图；7 通道芯片结温矩阵与 ENDC / 5GC 深度诊断 —— 读数未就绪或查询失败时显示「—」占位，不再用合成默认值冒充实测。
- **feat(sim)**: **真实无星号 IMSI 与 ICCID**：只读安全 AT 命令 `AT+CIMI` 与 `AT^ICCID?` 读取模组真实全量 15 位 IMSI 与 20 位 ICCID，移除星号遮挡。
- **fix(privacy)**: **兜底展示脱敏**：清理前端写死的实机读数（公网 IPv6、CGNAT WAN IPv4、基站 CID / TAC、PCI、运营商 DNS），未就绪时统一占位符「—」，严禁向开源分发包硬编码真实设备与基站指纹。
- **fix(ui)（P1）**: `Mt5700.interval` 签名为 `(ms, fn)`，状态页调用处参数顺序写反 → `setInterval` 把 5000 当回调抛 `TypeError`，整页 render 阶段即失败；已按签名纠正。
- **fix(ui)**: 速率单位修正 —— `bits` 已乘 8，按 1e6 / 1e3 除得的是比特率，此前标注 `MB/s` / `KB/s` 使显示速率虚高 8 倍，改为 `Mbps` / `Kbps`。
- **fix(sms)**: 短信页「全部 / 未读 / 已发」筛选此前只填充未挂载、且渲染不看 `currentTab`，按钮不可见也不生效；现已挂载并按 Tab 过滤（后端无已读标志位，未读按「最新一条为收到且本页会话未点开」判定，刷新后重置）。
- **feat(responsive)**: **移动端深度自适应**：窄屏卡片单列、`overflow-x: hidden` 防横向晃动；Tab 栏触控横滑防截断；温度矩阵 2 列平铺，星座图与 MIMO 空间流单列堆叠。
- **chore**: 删除无人引用的 `mascot.jpg`（436KB），看板娘仅使用 `mascot.png`。

### PR #16 复审修复：开关状态回滚、PCI 进制兼容与 CA 状态机收口

- **fix(modem-settings)**: `makeSwitch` 统一承担「写指令失败就还原勾选」的职责（Codex P2）。此前只有 `res.success === false` 分支手写回滚，`.catch()` 分支与「高温时关闭 CA/MIMO」开关完全没有回滚 —— 模组拒绝 `AT^THERMAUTOFUN` 后开关停在新状态，界面会长期显示与模组实际热策略相反的值。现在 handler 只需返回 `Promise<boolean>`，失败 / reject / 抛异常一律由框架还原；返回 `undefined` 的老式 handler 行为不变。
- **fix(modem-settings)**: 温控采样间隔输入增加正整数校验与 1~3600 秒钳制；写入失败时回滚到上一次被模组确认的值，避免界面长期显示一个模组从未接受的采样周期。
- **fix(rpc)**: 修正本 PR 把**旧编码格式 B**（无前导制式的 `^MONSC`）PCI 由十进制改为十六进制的回归 —— 该格式的 rsrp / rsrq / sinr 同为十进制编码值，PCI 应保持一致，现恢复十进制（制式标注为 NR 时仍按十六进制）。同时给十六进制分支加「越界回退」保护：NR 上限 1007（`0x3EF`）、LTE 503、其它制式 511，十六进制解释越界而十进制解释合法时自动回退，杜绝 `500` 被读成 `1280` 这类越界值。
- **fix(parse)**: `carrierSignalFor` / `unmatchedSecondaries` 空频点健壮性 —— 空 `dlFcn` 原先被 `Number('')` 折成 `0`，既会把 `arfcn=0` 的辅小区误判为「已匹配」而丢掉，也可能把主载波信号错配给空频点载波。现统一折成 `null` 并跳过匹配。
- **fix(status)**: 载波状态判定收口为唯一出口 —— `AT^HFREQINFO?` 查询失败时，即使只解析出 1 个载波也不再判定为「单载波」（改为 `error`，数据过期则 `expired`）；两次查询都成功却没有任何载波时判定 `none`（未驻网），不再是自相矛盾的「单载波」；`hfreqSuccess` 初值 `null`（尚未查询）不再被当作成功。
- **test**: 新增 `tests/switch-rollback-test.js`（6 项开关回滚）与 `tests/parse-regression-test.js`（15 项 PCI 进制与载波匹配回归）；`tests/ca-status-test.js` 由 13 项扩到 17 项。全量前端单测 **85 项 100% 通过**（17 + 28 + 19 + 15 + 6）。
- **verify**: 实机（192.168.x.1，中国移动 NSA/NR n41）抓 `AT^MONSC` / `AT^HFREQINFO?` / `AT^MONSSC` / `AT^CASCELLINFO?` 原始响应后用修复后的解析层复算：PCI `0x80 → 128`、基站 `C28xxxxx (TAC 1xxxxx)`、ARFCN `5049xx`、辅载波 0 个（MONSSC NONE / CASCELLINFO ERROR）→ 状态 `single`，与模组实际上报一致。前端热部署到真机后 Playwright 抓取渲染结果：网络状态页 PCI **128**、基站标识带 TAC、CA 状态「单载波 (PCC)」、温控开关与 `^THERMAUTOFUN: 1 0 2` 一致，无页面报错。

### 载波聚合 (CA) 多分量波生命周期识别与信号指标对齐

- **fix(status)**: 彻底修复**实际处于载波聚合 (CA) 场景下仍误显示为单载波**的问题。将 `AT^HFREQINFO?`、`AT^MONSSC`（5G NR 辅载波）与 `AT^CASCELLINFO?`（4G LTE CA 辅小区）整合进统一多载波引擎 `syncCarriers`，通过 `Parse.carrierSignalFor` 与 `Parse.unmatchedSecondaries` 精准匹配各分量波的真实物理指标，确保辅载波 100% 不漏报。
- **fix(status)**: 信号指标取值、单位及换算严格与模组 AT 原始响应保持一致。主载波 (PCC) 与辅载波 (SCC1, SCC2...) 各自分别展示其真实 RSRP (`dBm`)、RSRQ (`dB`)、SINR (`dB`)、物理小区 (PCI)、中心频率与带宽；彻底剔除原先辅载波指标为空时错误拷贝主载波数值的伪造逻辑，未上报指标严谨展示 `—`。
- **feat(status)**: 引入载波聚合状态全生命周期管理（`pending` 待刷新、`error` 未知/异常、`expired` 数据过期）。在查询失败、超时或数据超过 15 秒未更新时严格显示未知/待刷新，避免直接当作单载波。
- **test**: 新增单测 `tests/ca-status-test.js`（17 项载波聚合生命周期、NR/LTE CA 匹配、辅载波不冒充、过期保护与状态机收口单测全部通过）。

### 物理小区 (PCI) 十六进制进制换算与基站标识错位修复

- **fix(status)**: 模组通过 `AT^MONSC` 上报的 5G NR PCI 字段为十六进制（如实机 `0x80`，手册 13.27.3 规定 0~0x3EF），前端 `rpc.js` 误用十进制 `parseInt(p[6], 10)` 导致误显为 `80`。现更正为十六进制解析 `parseInt(p[6], 16)`，实机正确输出为十进制 **`128`**，对齐 3GPP 标准与 Rust 后端 `urc.rs`。
- **fix(status)**: 修正 NR 布局中中心频点 ARFCN（`5049xx`）与跟踪区码 TAC（`1xxxxx`）反向错位映射问题，基站标识现正确带出 `(TAC 1xxxxx)`。优化 PCI 为合法 `0` 时的空值回退判断。

### 拨号设置与模组设置 UI 紧凑化与移动端响应式重构

- **fix(dial)**: 彻底解决 **PDP 上下文管理大表格长宽不适配与横向溢出**问题，重构为自适应卡片网格（宽屏双列 / 移动端单列）；链路状态卡片、动态药丸标签、现代化微交互 Switch 开关及运营商 APN 快捷预设。
- **style(modem-settings)**: **网络系统配置 (SYSCFGEX)** 双列药丸化卡片紧凑重构，大幅压缩垂直空间；**网络接入顺序 (Acquisition Order)** 超紧凑单行药丸化排列，支持直观调整优先级；适配 Soft Anime 风格卡片与移动端响应式自适应。
- **style(logs)**: 日志查看页面 (`logs.js`) Soft Anime 风格药丸化 Tab、控制栏 1+2+2 移动端对称栅格、毫秒自适应隐藏释放 35px 宽度、快捷悬浮回顶/回底。

### 安全：RPC `_rid` / `device` 注入修复

- **fix(rpc)（安全）**: `mt5700.uc` 的 `rpcCall()` 将客户端可控的 `_rid` 未过滤直接拼进临时文件路径（`/tmp/mt5700-rpc-<rid>.json`）与 `fs.popen` 的 shell 重定向命令（`nc ... < <tmp>`）。任何拥有本插件 ACL 的 LuCI 会话可通过 `_rid` 夹带 shell 元字符（如 `;`、反引号）以 **root 执行任意命令**（rpcd 以 root 运行）。现新增 `safeRid()` 白名单校验（仅 `[A-Za-z0-9_-]{1,64}`），不合法一律视为未提供并退回服务端生成的唯一号（时间戳+自增）；nc 重定向目标额外加单引号包裹作纵深防御。前端 rid（`时间戳-序号-随机数`）完全兼容白名单，页面功能不变。
- **fix(rpc)（安全）**: `netrate` 的 `device` 参数同样直接拼接 sysfs 只读路径（`/sys/class/net/<device>/statistics/*`），现补白名单 `[A-Za-z0-9._@:-]`（排除 `/`，阻断 `../` 穿越），非法值忽略并回落自动探测。
- **note**: 「越界写文件」经复核仅限 /tmp 内文件名注入 —— `/tmp/mt5700-rpc-` 前缀与第一个路径组件粘连，`../` 穿越会被目录解析失败阻断；但命令注入成立且已封堵。`fs.open` 跟随符号链接的本地低权用户竞争窗口（抢注 `/tmp/mt5700-rpc-*.json` 符号链接）作为已知残余风险保留，必要时可改为独占目录方案（启动时 root 建目录限权 0700）。

### 承载接口可选择，接口管理可关闭

- **feat(iface)**: 新增 UCI `iface_v4` / `iface_v6`（默认 `auto`）。自动扫描时，已挂在模组网口上的接口优先（例如固件自带的 `wan` → `usb0`、`wan6` → `@wan`），没有才使用 / 创建 `MT5700M` 与 `MT5700Mv6`；也可手动指定接口名，IPv6 可设为 `none`。此前固件已有指向模组网口的 `wan` / `wan6` 时，插件仍会再建 `MT5700M`，同一网卡上跑两套 DHCP、出现两条默认路由，删除后服务启动时又会重建。
- **feat(iface)**: 新增 UCI `manage_interface`（默认 `1`，行为与之前一致）。设为 `0` 时不创建、不修改任何 network / firewall 配置，拨号就绪时只对选定的承载接口补一次 `ifup`。
- **fix(iface)**: 自动扫描模式下模组网口尚未枚举时暂不创建接口，网口出现后由启动流程、hotplug 与拨号就绪回调处理，避免先建出一个多余的 `MT5700M`。
- **fix(rpc)**: `netrate` 取网卡按承载接口选择：手动指定时用该接口的网卡，自动时按 sysfs 找 USB 网卡，最后才退回 `eth2`（此前只认 `MT5700M`，接口不存在时一律读 `eth2`）。
- **feat(luci)**: 「服务配置 → 调制解调器连接」新增「自动管理网络接口」开关与 IPv4 / IPv6 承载接口选择（自动扫描、现有接口或手动填写）；接口名只接受字母、数字与下划线，保存前校验。ACL 增加 `network` 的 UCI 读权限以列出接口。
- **test**: OpenWrt 25.12.2 虚拟机上以真实 `uci` 验证 init.d 接口逻辑 16 项（关闭管理 / 自动复用现有接口 / 无接口时创建 / 网口未枚举时延后 / 手动名称 / 非法名称回退 / 关闭管理时只拉起指定接口），并以浏览器驱动服务配置页验证选项、默认值、非法名称拦截与保存。`cargo test` 156 passed / 0 failed / 2 ignored。

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
- **verify**: 实机部署验证 —— 修改前后页面渲染输出逐项一致（卡片数 11、指标数 8、关键规则齐全），确认无回归。
- **docs**: README 版本号与安装示例同步至 v1.14.11；新增 `docs/release-notes/v1.14.11.md` 发布说明。

## v1.14.10 (2026-10-10)

### Argon 主题（2.4.x）兼容修复

- **fix(theme-compat)**: 修复 luci-theme-argon 2.4.8 下模块设置页面两处显示异常（issue #12，@unolejiongg 报告并提供已验证修复样式）：
  - **开关轨道异常**：Argon 对全局 `input[type=checkbox]` 施加高优先级样式，隐藏了插件开关的自绘轨道，仅剩白色圆形旋钮。在 `mt5700.css` 末尾新增「Argon 主题（2.4.x）兼容覆盖」块，以同等优先级 + `!important` 固定 44×24 轨道尺寸与底色（未选 `--mt5700-border-subtle` / 选中 `--mt5700-accent`），压制主题背景图与 `::after` 伪元素串扰，`::before` 旋钮位移恢复正常。
  - **下拉框文字偏下被裁切**：Argon 对全局 `select` 的高度与内边距覆盖导致选中项（如 VoNR「关闭」、网卡速率「自动协商」）文字垂直偏移并被裁切。新增 `select.mt5700-select` 覆盖规则：固定 40px 高度、`0 36px 0 12px` 内边距、`line-height: normal`，恢复文字垂直居中。
- **scope**: 仅前端 CSS 展示层 —— JS 逻辑、AT 命令与 IMEI 相关代码流零改动；其他主题（含 Aurora）显示不受影响。
- **style(review)**: 复核兼容块发现回归 —— 基础覆盖的 `background !important` 会压掉原有 hover / focus-visible / disabled 规则（无 `!important`），已在兼容块内补充同优先级状态覆盖，恢复悬停反馈、键盘焦点环与禁用态。
- **docs**: README 版本号与安装示例同步至 v1.14.10；新增 `docs/release-notes/v1.14.10.md` 发布说明。

## v1.24.4 (2026-10-21)

### LuCI Tab 菜单：滚动位置保持 + 统一 SVG 图标

- **feat(tabmenu) 新增 `at-webserver/tabmenu.js`**：针对 `admin/modem/5g` 下 12 个兄弟页面的 LuCI Tab 菜单做纯 DOM 增强（由 `mt5700.js` 统一 require，12 个视图全覆盖），**不改动 LuCI 与主题本身，不拦截点击、不改 href、不删节点**，原有路由与功能逻辑零改动
  - **滚动位置保持**：横向可滚动主题（如 argon 的 `.tabs { overflow-x:auto }`）在整页跳转后 `scrollLeft` 归零，选中项（如「运行日志」「服务配置」）被滚出可视区，用户要重新滑到底部找当前页。现在每次页面加载自动把选中项水平滚入可视区（仅操作 Tab 条自身 `scrollLeft`，**不动窗口滚动**，避免刷新时页面被顶回顶部）；返回 / 刷新同样生效
  - **手动偏移记忆**：用 `sessionStorage` 按路径记住用户手动滚动的位置，点击 Tab / 离开页面前保存；返回或刷新时若选中项在该偏移处仍完整可见则恢复原偏移，否则回退为「选中项居中」
  - **自适应校正**：视口缩放、横竖屏切换、Web 字体加载完成后（debounce 150ms）重新校正选中项位置
  - **统一 SVG 图标**：按 `li.tabmenu-item-<name>` 为 12 个页签注入 24×24 线性图标（`stroke=currentColor`，`stroke-width=1.8`，round 线帽线角），颜色随主题 tab 文字色变化，激活态由 CSS 提亮；桌面端 16px、≤600px 视口 15px，语义逐项匹配（网络状态=脉冲、网络设置=滑杆、拨号=插头、扫频=雷达、锁频=时钟、模组设置=芯片、升级=圆内上箭头、短信=气泡、短信设置=气泡+省略号、终端=提示符、日志=文件、服务配置=齿轮），未知页签走同心圆兜底
- **feat(compat) 主题无关**：只识别 `li[class*="tabmenu-item-"]`（bootstrap / material / argon / openwrt-2020 的 DOM 约定一致，激活类名 `active` / `cbi-tab` 均支持，另有 href 与当前路径一致的兜底识别）；footstrap 等无 Tab 栏的主题自动跳过；仅当路径含 `/admin/modem/` 时启用，其他 LuCI 页面零副作用；换行布局主题（bootstrap/material）不会产生横向滚动
- **feat(css)**: `mt5700.css` 末尾新增「LuCI Tab 菜单增强」样式块（`.at-tabmenu-icon` 尺寸/间距/激活态/移动端适配），`MT5700_CSS_VERSION` 2.24.0 → 2.25.0 保证缓存刷新
- **test**: 新增 `tests/tabmenu-test.js`（28 项断言：图标库与 menu.d 12 页签对齐、纯函数边界、argon/openwrt-2020/换行/异步渲染/非本插件页面守卫/兜底图标全场景）
- **verify**: 本地以 Chromium 复刻 LuCI `#tabmenu` 异步渲染链路（含 argon 横向滚动与 bootstrap 换行两套 Tab 条）跑真实模块，18 项浏览器断言全部通过（图标注入、选中项居中、点击切换不重置、刷新恢复/回退、移动端 15px、视口缩放重校正）；`node tests/*.js` 存量用例无回归（`cellular-icon-test.js` 的 1 处失败为改动前已存在：测试期望 `api.CELLULAR_LABELS` 而源码为局部变量，与本次无关）
- **scope**: 仅新增 1 个前端资源文件 + 2 处挂载/样式改动，AT 命令、RPC、后端与 IMEI 相关代码流零改动

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
