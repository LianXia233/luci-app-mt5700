# Config 页面功能解耦与通知系统重构（开发中 · 未发版）

> 状态：代码已完成并通过本地门禁测试，尚未提升 `PKG_VERSION`、未打标签、未生成安装包。
> 基于 `main` 分支 `5e95bab`。本文是本次改动的设计与验收说明，也是交付文档。

## 1. 总览

把原本集中耦合在 `service.js`（1501 行）里的 Config 页面，改造成「模块化入口 + 独立配置弹窗」体系；为四类推送各自补齐独立的**频率限制**与**推送时段**控制（在执行层生效）；彻底删除已废弃的「批量汇总标题」（`notify_tpl_batch`）。

全程遵守 AGENTS.md：无 Lua、Rust/Tokio 真异步、零告警、测试全绿、LF 行尾、作者署名保留、CHANGELOG 同步。

## 2. Config 页面原有功能 → 新模块对应清单

| 原 service.js 内的功能块 | 新模块 | UCI 键（保持不变） |
| --- | --- | --- |
| 服务状态 / 重载 / 重启 | service.js 编排层（状态卡 + 底部操作区） | enabled（读） |
| 调制解调器连接 | `config-connection.js` | connection_type / network_host / network_port / serial_port / serial_baudrate / manage_interface / iface_v4 / iface_v6 |
| RPC 服务 | `config-connection.js` | websocket_port / websocket_bind / websocket_allow_wan / websocket_auth_key |
| 默认 DNS 下发 | `config-network.js` | dns_enable / dns_v4_1 / dns_v4_2 / dns_v6_1 / dns_v6_2 / dns_exclusive |
| 定时锁频总开关 | `config-network.js` | schedule_enabled |
| 界面壁纸 | `config-network.js` | wallpaper_enabled |
| 通知（开关/通道/定时/巡检/限频/测试/绑定/QQ菜单） | `config-notify.js` | notify_* / wechat_* / qq_* / notify_timer_interval / notify_poll_* / notify_signal_min_interval |
| 推送文案 | `config-templates.js` | notify_tpl_prefix / notify_tpl_sms / notify_tpl_call / notify_tpl_signal / notify_tpl_memory / notify_tpl_qq_sms_md |
| 作者署名（页脚） | service.js 编排层（原样保留） | 无 |

**没有删除、隐藏或改变任何原有配置项、默认值、配置格式与业务逻辑。** 唯一删除的是孤立的「批量汇总标题」，见第 6 节。

## 3. 解耦后的模块结构

新增公共库模块（均在 `htdocs/luci-static/resources/at-webserver/`，遵循 LuCI「require 加载 + window 实例」约定，均为 `L.Class.extend` 子类）：

| 文件 | 职责 |
| --- | --- |
| `config-common.js` | 公共工具：UCI get/set、数值/时间夹取与校验、模板 `\n` 转义、控件工厂、文案默认值。逻辑从 service.js 原样迁移 |
| `config-drawer.js` | 统一响应式配置抽屉 + 交互契约（见第 4 节） |
| `config-connection.js` | 连接 + RPC 模块，自带 by-id 串口扫描、接口联动、独立读写 |
| `config-network.js` | DNS + 定时锁频 + 界面模块 |
| `config-notify.js` | 通知模块，含四类事件开关、双通道、定时/巡检、信号最小间隔、四类频率时段门控、测试推送、绑定进度 |
| `config-templates.js` | 推送文案模块（含恢复默认） |

`service.js` 保留为菜单入口（menu.d 固定指向 `at-webserver/service`），职责收缩为：
- 服务状态多源判定与展示、重载/重启操作；
- 渲染 4 个模块入口卡片，点击打开对应抽屉；
- 作者署名、探活降级提示（`Ui.startup`）。

**低耦合保证**：每个模块只在自己的 `save(set)` 里 `set` 自己负责的 UCI 键；抽屉在保存那一刻才写入 UCI 内存，取消不写入。因此改一个模块不会覆盖另一个模块的配置，也不会出现跨模块状态污染。所有模块统一通过 `AtWs.uci.uciSave()` 走 OpenWrt 标准「保存并应用」（含 procd reload trigger），配置改动即时通过 reload 生效，无需设备重启。

## 4. 响应式弹窗实现说明

`config-drawer.js` 用 JS 创建真实浮层（非纯 CSS 视觉伪装），PC 与移动端共用一套交互逻辑：

- **PC（≥641px）**：Right Drawer，从右侧滑入，固定于视口右侧，宽 `min(520px,92vw)`、满高，内容区独立滚动、底部操作区固定，遮罩覆盖主页面。
- **移动端（≤640px）**：Bottom Sheet，从底部上滑，顶部圆角 + 拖拽指示条，安全区 `env(safe-area-inset-bottom)` 适配，内容独立滚动，底部按钮常驻（≥44px 触屏高度）。
- **视觉Viewport**：监听 `visualViewport.resize`，软键盘弹出时收紧面板最大高度，避免遮挡与横向溢出。
- **交互规则**：
  - 遮罩层 / 弹窗外部点击：不关闭（仅轻微抖动提示，防误触）；
  - 关闭按钮：走关闭逻辑；
  - ESC：有未保存修改时不直接关闭，先弹二次确认；
  - 未保存修改：任何关闭路径都弹确认，用户确认「放弃修改」后才丢弃；
  - 「保存」「取消」明确；保存中禁用所有按钮、防重复提交；
  - 保存成功：同步 UCI 状态、成功回调、关闭；保存失败：保留用户输入、显示具体错误、不关闭；
  - 焦点管理：打开聚焦首个可聚焦控件、Tab 焦点锁在弹窗内、关闭后归还焦点；
  - 滚动：打开锁定 body 滚动、关闭恢复；模块资源（如绑定轮询定时器）经 `onClose` 无条件清理。

**验证**：`tests/manual/drawer-smoke.js`（jsdom，手动运行，不纳入零依赖 CI）覆盖上述 22 项交互，全部通过；见第 8 节。

## 5. 各类通知频率与时段限制实现说明

### 5.1 配置层（config.rs）
新增 `TypePushLimit`（每类一份）与 `OutOfWindowAction`（defer/drop），四类独立 UCI 键（统一 `notify_limit_*` 前缀，与既有键隔离）：

| 键 | 含义 | 默认 |
| --- | --- | --- |
| `notify_limit_<kind>_rate_enabled` | 该类频率限制开关 | `0`（保持既有实时行为） |
| `notify_limit_<kind>_min_interval` | 最小间隔（分钟），0=不限频，上限 10080 | `60` |
| `notify_limit_<kind>_window_enabled` | 该类推送时段开关 | `0` |
| `notify_limit_<kind>_window_start` / `_window_end` | 允许时段 HH:MM，支持跨零点/全天 | `00:00` / `23:59` |
| `notify_limit_<kind>_window_action` | 窗外策略 defer/drop | `defer` |

`<kind>` ∈ `sms` / `call` / `memory` / `signal`。解析时对负数间隔、非法时间、未知策略一律校验回落，与既有配置口径一致。

### 5.2 执行层（notify.rs）
新增 `NotifyGate` 门控器，在通知**真正投递前**的 `deliver()` 里裁决：
- **按类型隔离**：`states: Mutex<[GateState;4]>`，每类独立的 `last_sent` 与延迟队列；`NotifyKind::index()` 保证与配置数组一一对应。
- **频率**：`min_interval_hold` 判定；间隔内重复被抑制且**不刷新基线**（累计变化到点即补推，不漏报）。
- **时段**：复用 `in_poll_window`（支持跨零点、相等=全天、非法=全天）；窗外按 defer（延迟到窗口开启后补发）/ drop（丢弃）处理。延迟队列每类只保留**最新一条**，窗口开启时一次性补发，避免重复轰炸。
- **并发正确**：门控状态用 `std::sync::Mutex`，临界区只有内存操作、无 `.await`（符合 AGENTS.md 锁要求）；`run()` 循环按 10s 扫描延迟队列，通道未就绪/总开关关闭时放回队列，保证不丢消息。
- **不越权**：原有信号限频（`notify_signal_min_interval`）仍在生产者侧 signalwatch/urc 生效；新增执行层门控四类默认全关，不与其叠加。定时推送（timerpush）由独立节奏控制，不受门控干扰。

### 5.3 默认值策略
四类默认全关，**升级后行为完全不变**。用户按需为短信/来电/存储满/信号分别开启频率与时段。合理的差异化默认（如信号 60 分钟、QQ 10 条/分钟）沿用既有常量。

## 6. 删除「批量汇总标题」清理记录

| 文件 | 删除内容 |
| --- | --- |
| `service.js`（原） | `tplBatchInput` 控件、`批量汇总标题` 表单项、`TPL_DEFAULTS.batch`、载入/保存/恢复默认中的 batch 分支、顶部注释 |
| `config.rs` | `DEFAULT_TPL_BATCH` 常量、`NotifyTemplates.batch` 字段、default/load_config 的 batch、相关测试断言 |
| `notify.rs` | `combine_messages` 多条分支的 batch 标题拼接、`batch_uses_header_index_and_template` 测试改为 `batch_uses_index_and_template` 并加防回退断言 |
| `root/etc/config/at-webserver` | `option notify_tpl_batch` 及注释 |

**未误删**：`rpc.js` 的 `sendBatch`、ucode 的 `batch` 方法、ACL 的 `batch`（这些是「批量 AT 命令查询」，与汇总标题无关）；其它模板、通知内容、推送功能完整保留。历史 release-notes 中对该项的文字记录属存档，保留不动。

## 7. 兼容性检查

| 项 | 结论 |
| --- | --- |
| RPC 接口 | 未改动任何 ubus/RPC 方法与签名；新增配置走既有 UCI 通道 |
| ubus 调用 | 服务重载/启动逻辑原样保留 |
| UCI 配置 | 除删除孤立项 `notify_tpl_batch` 外，既有键名/格式/默认值不变；新增键全部有出厂默认，老配置升级无感 |
| ACL | 无需改动：`at-webserver` UCI 读写、相关 ubus 权限已覆盖 |
| 第三方依赖 | 未引入任何插件运行时依赖；测试用 jsdom 仅存于 tests/manual，不进包、不进 CI |
| Lua | 未引入；全部沿用 JS（Ucode 未改动） |
| 后端重写 | 未重写；仅在 config.rs/notify.rs 增量扩展，保持 Tokio 真异步、锁语义、启动/收尾顺序 |
| 低内存设备 | 门控为内存状态 + 10s 低频扫描；无新增常驻线程/轮询 |

## 8. 测试与验收结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| Rust 全量单测 | `cd src/rust && cargo test` | **379 passed, 0 failed, 2 ignored**（基线 371，新增 8） |
| Rust clippy | `cargo clippy --all-targets` | 生产段 0 warning；18 条均为 baseline 测试段常量断言 |
| Node 门禁（24 项） | `for f in tests/*-test.js; do node $f; done` | **24/24 通过** |
| 推送频率门禁 | `node tests/push-rate-test.js` | **47/47 通过**（含 5 条新增门控接线断言） |
| 抽屉交互冒烟 | `node tests/manual/drawer-smoke.js`（jsdom） | **22/22 通过** |
| JS 语法 | `node --check` 全部新模块 + service.js | 全部通过 |
| 模块导出一致性 | require / window 全局 / L.Class 导出 | 一致 |

未执行：OpenWrt SDK 实机交叉编译与真机刷入（沙箱无 OpenWrt buildroot/硬件）；建议发版前在目标设备验证一次「配置 → 保存并应用 → 推送门控生效」。

## 9. 修改文件清单

**前端**
- `htdocs/luci-static/resources/view/at-webserver/service.js`（重写为编排层）
- `htdocs/luci-static/resources/at-webserver/config-common.js`（新增）
- `htdocs/luci-static/resources/at-webserver/config-drawer.js`（新增）
- `htdocs/luci-static/resources/at-webserver/config-connection.js`（新增）
- `htdocs/luci-static/resources/at-webserver/config-network.js`（新增）
- `htdocs/luci-static/resources/at-webserver/config-notify.js`（新增）
- `htdocs/luci-static/resources/at-webserver/config-templates.js`（新增）

**后端**
- `src/rust/src/config.rs`（新增门控配置结构与解析、删除 batch）
- `src/rust/src/notify.rs`（新增 NotifyGate 与投递门控、删除 batch 标题、新增测试）

**配置 / 测试 / 文档**
- `root/etc/config/at-webserver`（新增 notify_limit_* 默认项、删除 notify_tpl_batch）
- `tests/push-rate-test.js`（迁移事实源到新模块 + 新增门控断言）
- `tests/manual/drawer-smoke.js`（新增，手动运行）
- `CHANGELOG.md`（新增开发中说明）
- `docs/release-notes/unreleased-config-refactor.md`（本文，新增）

## 10. 构建产物与安装包

本次为**开发中提交**，未提升版本号、未打标签、未生成 `.ipk`/`.apk` 安装包。按 AGENTS.md，正式安装包应在发版流程中由 SDK/CI 生成，并同步全部版本引用与下载链接资产名。本地已完成源码级全部质量门禁（见第 8 节）。

## 11. Codex Review 修复与通道增强（第二轮）

PR #57 的 Codex Review 提出两条 P2 并发缺陷，一并修复；并按用户要求新增通道能力。

### 11.1 修复：频率闸门 check+reserve 非原子（P2）
- 旧实现：`decide()` 读到旧 `last_sent` 后释放锁，别处 `mark_sent()` 才刷新；并发同类事件会双双通过，在最小间隔内连发两条。
- 新实现：`NotifyGate::admit()` 在**同一把 Mutex 临界区**内完成「频率判定 + 预约 `last_sent` + 清延迟副本」。后到者看到已被推进的基线，自然被压住。
- 补发路径 `flush_deferred()` 同样经 `admit()` 裁决，与实时事件共用一把锁，天然互斥不重复。
- 新增回归测试 `gate_admit_is_atomic_under_concurrency`：8 线程Barrier 同时 admit，断言恰好 1 条放行。

### 11.2 修复：延迟事件入队未唤醒 sweeper（P2）
- 旧实现：`deliver()` defer 事件后，若 `run()` 的 `select!` 因 `has_deferred==false` 未挂 sweep 定时器，窗口到了也永不补发。
- 新实现：`Notifier` 持有 `tokio::sync::Notify`；defer 时 `notify_one()`，run 的 `select!` 增加 `wake.notified()` 分支立即重算并重挂定时器。`Notify` 的 permit 语义保证即使消息早于进入 select 到达也不会丢失唤醒。

### 11.3 新增：企业微信 Markdown 格式（text / markdown / markdown_v2）
- UCI 新增 `wechat_msg_format`（默认 `text`，升级行为不变），前端 config-notify.js 新增下拉。
- 依企业微信官方文档（path/99110）：
  - `markdown`：标题 `##`、键值行用引用 + `<font color="comment">` 灰键名（该版本**无列表语法**），兼容旧客户端；
  - `markdown_v2`：标题 `#`、键值行用 `**键**：值` 无序列表（该版本**无字体颜色**），旧客户端显示纯文本。
- 按字节裁剪（text 2048 / markdown 4096），`truncate_utf8_bytes` 保证不切断多字节汉字。
- 端到端测试 `webhook_markdown_payload_is_correct` 校验 msgtype 与嵌套对象。

### 11.4 新增：企业微信与 QQ 共享通道节流 + 实时事件豁免
- 把 QQ 的预约制节流抽成 `ChannelThrottle`（`qqpush.rs`），QQ 与企业微信各持一实例，均读 `qq_max_per_minute`——**一个设置同步约束两个通道**，节奏算法完全一致（共享同步）。
- **短信/来电实时事件豁免通道节流**：`dispatch_body()` 按 `NotifyKind` 判定，`Sms`/`Call` 跳过 `pace_throttle`（企业微信）与走 `send_with_throttle(msg, false)`（QQ），保持实时到达；信号/存储满照常节流。逐类 NotifyGate 限频开关仍独立可用。
- QQ 新增 `send_with_throttle(msg, bool)`，`send()` 保留为走节流的默认入口，现有调用点零改动。

### 11.5 验证
- `cargo test` 385 passed（第二轮新增 6 个单测：并发原子、3 个 Markdown/格式解析、UTF-8 截断、payload 端到端）。
- Node 门禁 24/24；`push-rate-test` 55/55（新增 8 条接线断言）；抽屉冒烟 22/22。
- `cargo clippy` 本次改动段 0 新告警。
- 新增改动文件：`src/rust/src/qqpush.rs`（抽取 ChannelThrottle、send_with_throttle）。
