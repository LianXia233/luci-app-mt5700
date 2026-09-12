# 更新日志 (Changelog)

本项目的所有显著变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.3.0] - 2026-09-12

本轮针对实机（ImmortalWrt aarch64 · H5000M · MT5700M-CN）的五个问题做集中修复。
其中「接口拿不到 IP」导致无法联网是最高优先级缺陷。

### 修复

- **一、LuCI 保存未走 OpenWrt「保存并应用」流程（P1）**

  原实现是页面里连续调用 `L.uci.set(...)` → `L.uci.save()` → `L.uci.apply(false)`，
  与 OpenWrt 标准流程有三处偏差：缺少「未保存更改」提示（改完不点保存就切页，改动静默
  丢失，表现为「保存了但没生效」）；三段调用各自独立，失败原因无法区分；`apply()` 依赖
  配置 hash，当无待应用变更时 rpcd 返回 ubus 状态码 5（NO_DATA）而被误判为失败。

  新增 `AtWs.uci` 编排层（`rpc.js`），对外只暴露 `uciSave()` / `uciCommit()` /
  `uciHasChanges()` / `markDirty()` / `clearDirty()`，语义与 CBI 底部按钮对齐：

  | 阶段 | 行为 |
  |:--|:--|
  | 编辑 | `set()` 写内存后 `markDirty()`，`beforeunload` 拦截离开 |
  | 保存并应用 | `changes()` → `save()` → `apply(false, true)` |
  | 无待应用变更 | `NO_DATA` 视为已生效，提示「无待处理的变更」而非报错 |
  | 成功 | `clearDirty()` 解除拦截，随后重载服务 |

  「服务配置」页按钮文案由「保存配置」改为**「保存并应用」**，并增加结果状态行。

- **二、模组在线但接口无 IP，无法联网（P0）**

  取证：`ifstatus MT5700M` 为 `"up": false, "autostart": false`，而 UCI 中该接口只有
  `device`/`ifname`/`proto`/`metric`/`defaultroute`/`norelease` —— **既没有 `auto='1'`
  也没人主动 `ifup`**，netifd 因此从不启动它。即使模组拨号成功、`eth2` 已可 DHCP，
  接口也不会去申请地址。

  两条修复路径：

  1. **init.d 新增 `ensure_modem_interface()`**（`root/etc/init.d/at-webserver`）：
     幂等地把 `MT5700M` / `MT5700Mv6` 的 `auto` 置 1（写入用 `uci set network.X.auto=1`，
     不带引号，避免产生 `auto=''1''` 这样的双重引号），等待 `eth2` 枚举完成后
     `ifup` 拉起，并最多等 20s 等 DHCP 拿到地址；不硬编码 IP/网关，全部交给 dhcp 协商。
  2. **后端新增 `ensure_autodial()`**（`src/rust/src/atclient.rs`）：每次连上模组后对齐
     自动拨号状态。模组不拨号就不会向 USB 网口下发 DHCP，是接口拿不到 IP 的上游原因。
     实现为幂等：先查 `AT^SETAUTODIAL?`，已是目标值则不重复下发，避免打断已建立的 PDP 上下文。

  实测结果：`up: true`、`autostart: true`、地址 `10.6.45.224/8`、
  默认路由 `via 10.0.0.1 dev eth2`，`ping 223.5.5.5` 与 `119.29.29.29` 均 0% 丢包（约 22ms），
  DNS 正常解析。

- **三、自动拨号需默认开启（P1）**

  UCI 新增 `autodial_enable`（默认 `1`）与 `autodial_mode`（默认 `1` = USB 网络接口）。
  Rust 侧 `AtConfig` 增加对应字段，`load_config()` 读取并在 `init_modem()` 末尾调用
  `ensure_autodial()`。「拨号设置」页读取模组状态后会同步复选框，并在与 UCI 期望值不一致时
  回写持久化（仅在值变化时写盘），使该偏好跨重启生效。

- **四、AT 调试终端不可用（P1）**

  后端链路经实测完全正常（`nc 127.0.0.1 8765` 直发 `ATI` 成功；
  `ubus call mt5700 at` 成功；`AT^HCSQ?` / `AT+CGSN` 均有正常应答），
  故问题在前端。逐页面实测 12 个视图渲染状态，**当前固件上终端页已正常工作**
  （实测填入 `ATI` 返回 `Manufacturer: TD Tech Ltd. / Model: MT5700M-CN ... OK`），
  第一轮修复（服务未运行）已解除其阻塞。

  排查中额外定位到一个**上游 LuCI 加载时序缺陷**并加了防御：本机 `luci.js`（26.246.30574）
  在构造函数（`luci.js:144`）中同步调用 `this.require('ui')`，而 `require()` 内部使用
  `'%s/%s.js%s'.format(...)`；`String.prototype.format` 的定义却在 `cbi.js` 里，
  `cbi.js` 由 `L.require` 之后才加载 —— 于是构造期首次 `require` 必然抛
  `TypeError: "%s/%s.js%s".format is not a function`，被 `Promise.all(...).catch(this.error)`
  吞掉。该缺陷在当前固件上被 `cbi.js` 后续补上定义所掩盖（LuCI 最终自行恢复），
  但会污染控制台并可能在其它构建上让 `setupDOM()` 永不执行。

  新增 `htdocs/luci-static/resources/at-webserver/compat.js`：幂等补齐
  `String.prototype.format`（`%s`/`%d`/`%j`/`%%`，参数不足保留占位符，多余实参追加），
  由 `rpc.js` 与 `ui.js` 最先 `require`，不覆盖上游已有实现。

- **五、菜单 `modem` 汉化（P2）**

  `root/usr/share/luci/menu.d/luci-app-mt5700.json` 中 `admin/modem.title`
  由 `"modem"` 改为**「移动网络」**；`admin/modem/5g.title` 由「5G模组管理」
  规范为「5G 模组管理」（数字与中文之间加空格）。侧边栏实测显示「移动网络 → 5G 模组管理」。

### 新增

- `htdocs/luci-static/resources/at-webserver/compat.js` —— LuCI core 兼容垫片。
- `rpc.js` 中 `AtWs.uci` 保存/应用编排层。
- Rust 单测 `parse_autodial_enable` 四例（完整形态 / 短形态与空白 / 非布尔与缺失 / 混杂行），
  连同既有 PDU 与读循环测试共 9 例通过。

### 说明

- **未改动任何 IMEI 相关命令与逻辑**（含 `AT+CGSN`、`查询 IMEI` 常用命令项）。
- 版本号 1.2.4 → 1.3.0（新增配置项与用户可见行为变更，按语义化版本升 minor）。
- 同步更新 `Makefile`（`PKG_VERSION`）、`src/rust/Cargo.toml`、
  `htdocs/.../ui.js`（`AT_CSS_VERSION`，样式缓存随包版本递增）。

### 验证

- Rust：`cargo check` 通过；`cargo test` 9 passed / 0 failed。
- JS：6 个改动文件经 `node --check` 语法校验通过。
- 实机渲染：12 个视图页全部渲染成功（`网络状态`/`网络设置`/`拨号设置`/`全网扫频`/
  `定时锁频`/`模组设置`/`模组升级`/`短信中心`/`短信设置`/`AT 调试终端`/`通知日志`/`服务配置`）。
- 实机网络：`MT5700M` `up=true` / `autostart=true` / `10.6.45.224`，
  `ping 223.5.5.5`、`119.29.29.29` 0% 丢包，DNS 正常。
- 服务配置页实测显示「运行中 · PID 10254」与「保存并应用」按钮。

## [1.2.4] - 2026-09-12

实机（ImmortalWrt aarch64 · H5000M）「服务配置」页把 5G 调制解调器服务状态错误显示为
「未运行」的修复。

### 修复

- **服务状态仅依赖 `service.list`，无法区分四种未运行原因（P1）**：原判定为
  `inst.running || inst.pid`，而 procd 的 `service.list` **只反映已注册实例**——当
  `/etc/init.d/at-webserver` 缺失（例如被 overlay 白化覆盖）或服务从未被拉起时，它返回
  空对象 `{}`。此时界面只能给出一个红色「未运行」，用户无法区分「配置已禁用」「二进制
  缺失」「实例未注册（缺 init 脚本）」「已注册但进程崩溃」四种截然不同的故障，排查成本高。
  已改为多源交叉判定并细分状态：

  | 状态 | 颜色 | 判定依据 | 界面提示 |
  |:--|:--|:--|:--|
  | 运行中 | 绿 | 已注册且 `running`/`pid` | 附带 PID 标签 |
  | 已禁用 | 灰 | UCI `enabled=0` | 说明被刻意关闭及开启方法 |
  | 未安装 | 红 | `file.stat` 取不到二进制 | 提示重装软件包 |
  | 不可执行 | 红 | 二进制存在但无执行位 | 提示 `chmod 0755` |
  | 未注册 | 橙 | 已启用、二进制正常，但 procd 无实例 | 提示 init 脚本缺失/被白化，引导重载 |
  | 已停止 | 红 | 已注册但进程未运行 | 提示查日志后重载 |

- **重载/重启缺少结果复核，可能「提示成功但实际没起来」（P1）**：`reloadService()` 之前
  只要 `service.set` 不抛错就提示「服务已重载」。现改为下发后等待约 1.2s 再回查
  `service.list`，依据真实 `running`/`pid` 给出「服务已重载（PID xxxx）」或
  「已下发启动指令，但未检测到运行中的进程，请查看系统日志确认原因」。
- **内联 `L.rpc.declare` 改为提取复用**：`service.list`/`set`/`delete` 三处声明提到
  render 作用域统一声明，避免每次调用重建声明对象。

### 说明

- 修复仅调整状态判定与提示文案，**未改动任何 AT 命令**（含 IMEI / `AT+CGSN` 相关逻辑）。
- rpcd ACL 增补 `/usr/bin/at-webserver-rust` 的 `list`/`read`/`stat` 读权限，
  供前端 `file.stat` 判定二进制是否存在及是否可执行。

### 验证

- 实机 aarch64_cortex-a53 / ImmortalWrt SNAPSHOT：
  - 经页面同路径 `ubus call service set` 拉起后，`service.list` 返回
    `instance1.running=true, pid=12312`，`netstat` 确认 `127.0.0.1:8765` 处于 LISTEN。
  - 无头浏览器实测 `admin/modem/5g/config` 页面渲染为 **「运行中」+「PID 12312」**。
  - 五态判定逻辑逐场景回归（运行中/已禁用/未安装/未注册/已停止）输出均符合预期。

## [1.2.3] - 2026-09-12

### 修复

- **AT 调试终端回复看不清（P1）**：回复正文渲染为 `<pre class="at-console-res">`，此前只覆盖了
  `color`（浅黄 `#dcdcaa`），而 LuCI 主题会给 `pre` 铺底色（aurora：
  `background-color: var(--surface-sunken)`，浅色模式为 `#f4f7fa`），于是深色终端里出现
  「浅底 + 浅黄字」，`ATI` 等命令的结果几乎不可读。已在 `.at-console-res` 显式重置
  `pre` 的底色/边框/字体/行高，与终端深色背景一致；同时提高命令时间戳的对比度。
  **仅改样式，未改动终端任何命令（含 IMEI / `AT+CGSN`）。**
- **静态样式缓存**：`ui.js` 注入的 `at.css` 改为带版本查询串
  （`at.css?v=1.2.3`，与主题 `main.css?v=1.3.1` 的做法一致）。uhttpd 给静态资源的
  `Last-Modified` 为 1970，浏览器会长期复用缓存，不加版本号会导致升级后看不到样式修复。

## [1.2.2] - 2026-09-12

实机（ImmortalWrt aarch64 · Fibocom FM350-GL）「后端服务无法启动 / AT 全部无响应」修复。

### 修复

- **init.d 启动脚本 killall 自杀（服务永远起不来，P0）**：`start_service()` 里的
  `killall -q at-webserver` 会把脚本自身一起杀掉——init.d 被直接执行时（开机
  `/etc/rc.d/S*`、`/etc/init.d/at-webserver start`、`service` 命令）进程名(comm)就是
  `at-webserver`，
  于是 `start` 在 `procd_open_instance` 之前收到 SIGTERM（exit 143），procd 从未注册
  实例，`status` 永远是 `inactive`。已删除该行；遗留进程只按 `at-webserver-rust` /
  `at-server.py` 清理，旧 procd 实例交给 procd 处理。
- **串口读循环把「0 字节读」当 EOF（刚连上就断，AT 全部「模组无响应」，P0）**：
  `AtClient::read_loop` 收到 0 字节即返回并触发重连；而 Linux tty 在
  `VMIN=0/VTIME=0` 下「暂无数据」的 `read()` 正是返回 0，于是读循环连接后立刻结束，
  此后每条命令都等 2s 超时，日志表现为每十几秒一轮「模组无响应」并反复重连
  （实机可证：进程只剩写侧一个 ttyUSB fd）。改为 0 字节读让步 50ms 重试，连续 20 次
  （约 1s）才判定链路断开并重连。
- **串口 termios 改为 `VMIN=1`**：消除「无数据 read 返回 0」的歧义——非阻塞 fd 下
  无数据返回 `EAGAIN`，交由 tokio `AsyncFd` 等待，不再空转。
- **ucode 插件解析数组必然失败（`events` 接口不可用，P1）**：该 ucode 构建的数组没有
  `push` 方法，`jsonParse` 中 `arr.push(parseVal())` 抛
  `left-hand side is not a function`，凡是应答含数组（`events`）就报「解析应答失败」。
  已改为 `arr[length(arr)] = parseVal()`（与既有「无 JSON / parseInt / s[i]」适配一致）。

### 验证

- 实机 aarch64_cortex-a53 / ImmortalWrt SNAPSHOT：`/etc/init.d/at-webserver start`
  返回 0、`status=running`；`/proc/<pid>/fd` 常驻 2 个 ttyUSB（读+写侧）；
  启动后日志 0 条 WRN；`ubus call mt5700 at '{"cmd":"ATI"}'` 与 `events` 均正常返回。
- Rust 单测 8/8（新增回归用例 `read_loop_survives_zero_reads`）。

## [1.2.1] - 2026-09-11

### 修复

- **串口自动探测导致进程 abort（exit 134）**：`serial_linux.rs::into_parts` 用
  `OwnedFd::from_raw_fd(-1)` 作占位，触发 `fd != -1` 断言，在 `panic=abort` 下整个
  服务崩溃（`/dev/ttyUSB*` 自动探测时必现）。改为 `Option<OwnedFd>::take`，
  `AsyncFd::new` 失败时退回 `/dev/null` 而非 abort。

### 变更

- 版本号 **1.2.1**；RPC 对外监听（`websocket_allow_wan` / `websocket_bind`）随本版发布

## [1.2.0] - 2026-09-11

ImmortalWrt/OpenWrt 实机适配、LuCI 界面修复、RPC 可对外监听版。

### 新增

- **菜单**：一级 `modem`，二级 **5G模组管理**，页面路径 `admin/modem/5g/*`（12 页）
- **串口下拉**：服务配置页列出系统识别的 `ttyUSB/ttyACM/ttyAMA/ttyS`，支持「自动探测 / PCUI 推荐 / 自定义路径」
- **RPC 对外监听**：`websocket_allow_wan=1` 或 `websocket_bind=0.0.0.0` 时绑定 `0.0.0.0`；服务配置页增加「RPC 监听范围」
- **连接状态条**：圆点 + 状态色 + 脉冲动画；文案按实际 bind 显示（本机 RPC / RPC 所有接口 / RPC &lt;host&gt;）
- **每次编译成功自动发布 GitHub Release**（main 推送用 `PKG_VERSION` 作为 tag）

### 修复

- **LuCI 模块加载**：库改为 `L.Class.extend` 并 `return`，修复 `factory yields invalid constructor`
- **`AtWs.client`**：改为单例实例（原先误挂工厂函数，导致 `onConnectionStateChange` 不存在）
- **页面 DOM**：`insertBefore` 改为 `appendChild`，修复 `NotFoundError`
- **`network_status`**：`carriers` 提升作用域，修复 `carriers is not defined`
- **服务配置 UCI**：与后端 `config` 段扁平键对齐；`uci/apply` ubus code 5（无变更）视为成功
- **`file.list`**：兼容多种返回结构；ACL 放行 `/dev` list
- **init.d/uci-defaults**：git 模式 `100755`，打包强制 `chmod`，修复安装 `Permission denied`
- **init.d start 不再阻塞**：先拉起 procd，防火墙/串口探测放后台（`timeout 8`），避免 `firewall reload` 挂死导致服务起不来
- **页面重载/重启**：改为 `ubus service delete` + `service set`，不再走会卡死的 init.d
- **ucode 插件**：适配 ImmortalWrt——无 `JSON`/`parseInt`/`s[i]`/`fs.connect`；参数在 `req.args`；经 `nc` 访问回环 RPC
- **Rust P0/P1/P2**（见 1.1.1）：调度 applied、RPC 行限、CNMI/CMGF、try_send、扫频正则等

### 变更

- 默认连接 **PCUI 串口**（`SERIAL` + `/dev/ttyUSB1`）
- 单包交付：前端 + `/usr/bin/at-webserver-rust`
- `LUCI_DEPENDS` 保持为空，避免 SDK 强编 libusb
- 新增 UCI 键：`websocket_bind`（可选监听地址）；`websocket_allow_wan` 恢复生效（控制是否绑 0.0.0.0）

## [Unreleased]

### 修复

- **init.d 安装后无执行权限（Permission denied）**：`root/etc/init.d/at-webserver` 与
  `root/etc/uci-defaults/at-webserver` 在 git 中为 `100644`，apk/ipk 安装后
  post-install 调用服务脚本失败。已改为 `100755`，并在 `Build/Prepare` 与
  `scripts/sdk-build.sh` 中强制 `chmod 0755` 兜底。`PKG_RELEASE=2`。

### 变更

- **每次编译成功自动发布 GitHub Release**（不再仅限 `v*` 标签）：
  - 标签推送使用标签名；main 推送使用 `Makefile` 的 `PKG_VERSION`
  - 同名 Release 先删后建，资产带架构前缀（`x86_64-` / `aarch64_cortex-a53-`）

### 修复（独立核查 P0/P1/P2）

- **服务配置页 UCI 读写与后端对齐（P0）**：`service.js` 此前按 `connection/*`、`websocket/*`
  等多 section 写入，与 Rust/ucode 读取的 `config` 段扁平键（`connection_type`、`websocket_port`…）
  完全不一致，保存后不生效。已统一为 `config` 段；webhook 键改为 `wechat_webhook`；
  服务运行状态改读 `instances.instance1.running`；去掉无效的 `connection_type=AUTO` 选项。
- **定时锁频下发失败不再标记 applied（P0）**：`schedule.rs::apply_lock` 返回成功与否，
  失败或未生成任何锁频命令时保持 `applied=false`，下周期自动重试；空 bands type=3 视为失败。
- **RPC 单行长度前置限制（P0）**：`read_line_limited` 按行 `take(8KB)`，超长行排空并断开，
  杜绝无换行超长请求 OOM。
- **ucode 读超时 3s→10s**：覆盖后端命令总超时（2s+3s），消除慢命令误报「无应答」。
- **CNMI/CMGF 初始化**：查询失败仍强制 SET（与 Go 一致），避免短信模式未启用。
- **URC/通知队列满改为 try_send 丢弃**，不再阻塞 AT 唯一读循环。
- **`long_command_ended_at` 时钟回拨安全**：`checked_sub`，避免 Instant 下溢 panic。
- **`isScanRunning` 正则**：补上 `\\^`，恢复扫频运行状态检测。
- **init.d reload**：优先 `ubus service delete` 再 start，降低与 respawn 的双实例竞态。
- **TCP Writer**：去掉每 poll 重建 timeout future 的错误实现，写超时交由上层。
- **+CMTI 索引校验**：必须为纯数字，堵住 NETWORK 模式 URC 注入面。
- **页面定时器生命周期**：`Ui.interval`/`Ui.subscribe` 在 hashchange 时自动清理，
  修复切页后幽灵 AT 轮询泄漏。
- **默认连接 PCUI**：`config.rs` 默认 `SERIAL` + `/dev/ttyUSB1`，与 UCI 一致；非 NETWORK 一律走串口。
- **LUCI_DEPENDS**：保持为空（luci-base 已带 rpcd/ucode；硬依赖 usbutils 会在 SDK 拖 libusb 编译失败）。
- **ACL**：去掉 `file.remove` 与整包 firewall 写权限。
- **单包云编译**：v1.1.0 起已为前后端一体包；workflow/sdk-build
  继续校验包内必须含 `usr/bin/at-webserver-rust`。

### 变更

- **前端与后端合并为单个包（v1.1.0 起）**：
  - 新增 `src/Makefile`：利用 luci.mk 的 `${CURDIR}/src` 机制（`Build/Compile` 调用
    `make clean compile`、`Package/install` 调用 `Build/Install/Default`），
    在编译 LuCI 包时顺带 `cargo build` 并把 `/usr/bin/at-webserver-rust` 装进同一包
  - 根 `Makefile`：`LUCI_DEPENDS` 清空（不再依赖独立后端包）、`LUCI_PKGARCH` 置空
    （包内含架构相关二进制，不能是 `all`）、新增 `PKG_PROVIDES:=at-webserver-rust` 兼容旧装
  - 删除 `src/rust/Makefile`（后端不再作为独立包构建）
  - 效果：安装只需一个包，彻底消除 `required by: luci-app-mt5700[at-webserver-rust]` 报错
- **产物校验升级为「包内必须自带后端」**：`scripts/sdk-build.sh` 与 workflow 在产出后解包
  校验 `usr/bin/at-webserver-rust` 确实存在（apk 支持 gzip/zstd，ipk 解内层 data.tar.gz），
  避免再次出现"只有前端壳子"的包被发布

### 修复

- **Rust 后端崩溃修复（P0）**：`tokio::sync::Mutex::blocking_lock()` 在异步任务内调用必然 panic
  （`Cannot block the current thread from within a runtime`），release 配置 `panic="abort"` 下进程直接崩溃：
  - `AtClient::connected()` 改原子标志（`AtomicBool`），不再取锁阻塞 —— 修复调度器每周期
    `connected()` 触发崩溃（默认 `schedule_check_interval=60`，服务启动约 60s 后必崩）
  - 扫频流式回调改 `try_lock()`（同步闭包内不能 await/阻塞）—— 修复 CELLSCAN 期间
    read_loop 任务 panic 崩溃
  - 扫频任务收尾改 `lock().await`（异步任务内可用异步锁）—— 修复扫频结束后
    `running` 状态永不复位导致全部 AT 命令被"正在扫频"挡死
  - 运行验证：修复前 75s 崩溃（exit -1073740791），修复后 75s 存活 + 扫频全流程通过
- **LuCI RPC 配置读取修复（P1）**：`mt5700.uc` 与前端 `rpc.js` 此前按不存在的
  `websocket` UCI 段读取端口/密钥，导致修改 `websocket_port` / `websocket_auth_key` 不生效；
  配置了密钥时 ucode 不带密钥被 Rust 拒绝（-32001），整个界面不可用：
  - `mt5700.uc`：改为读取 `config` 段的 `websocket_port` / `websocket_auth_key`，
    每次调用实时读取（改配置无需重启 rpcd），连接与读取均加 3s 超时（避免阻塞 rpcd worker）
  - `rpc.js::loadConfig`：同步修正 UCI 段名与键名
- **`uci show` 读取加 5s 超时**（与 Go 版一致），避免 uci 命令异常挂起卡死服务启动
- **RPC 请求行加 8KB 长度上限**（对齐 Go 版 64KB 读限的安全意图），超限断开连接
- **交叉编译映射修正**：`src/Makefile` 的 `mips`/`mips_24kc` 此前错误映射到
  `mipsel-unknown-linux-musl`（大小端相反），已改为 `mips-unknown-linux-musl`；
  `scripts/sdk-build.sh` 同步补 `mips-linux-musl` 的 zig 目标
- **非 Linux 平台可编译**：`serial_linux.rs` / `serialdetect.rs` 增加
  `#[cfg(target_os = "linux")]` 条件编译（termios/AsyncFd 仅 Linux 可用），
  其它宿主可直接 `cargo build` / `cargo test` 验证逻辑层

- **Release 缺少后端包 `at-webserver-rust`（导致 `apk add` 报依赖缺失）**：
  - 根因：SDK 的 `make defconfig` 不会自动选中后来复制到 `package/` 的包，
    未选中时 `make package/at-webserver-rust/compile` 只打印 `Nothing to be done` 并返回 0，
    CI 全程绿灯但后端包从未产出；LuCI 包仍照常声明 `Depends: at-webserver-rust`，
    于是用户安装时报 `required by: luci-app-mt5700-1.0.0-r1[at-webserver-rust]`
  - `scripts/sdk-build.sh`：编译前显式写入 `CONFIG_PACKAGE_at-webserver-rust=m`（去重后追加），
    defconfig 后校验选中状态；编译后校验 cargo 二进制确实存在；收集产物后校验后端包存在
  - `.github/workflows/build-openwrt.yml`：build job 增加「Verify required packages」闸门，
    release job 增加「Verify dist completeness」（每个包需覆盖 2 架构 × apk/ipk 共 4 个），
    缺包即失败，杜绝再次发布不可安装的 Release
  - README 新增 §8.1「安装（前端 + 后端必须成对安装）」，并标注 v1.0.0 Release 缺后端包

### 变更

- **菜单收敛为「服务 → 模组管理」，二级菜单全部置于 Plugin Top Navigation**：
  - 原 `网络 → 5G 模组`（5 页）与 `服务 → 5G 模组`（7 页）合并为
    `服务 → AT WebServer → 模组管理` 一组 12 页（网络状态/网络设置/拨号设置/全网扫频/定时锁频/
    模组设置/模组升级/短信中心/短信设置/AT 调试终端/通知日志/服务配置）
  - 页面作为模组管理下第 3 级节点，LuCI 主题将其渲染在 **Plugin Top Navigation**（页面顶部导航条），
    侧边栏只保留两级（AT WebServer → 模组管理），页面入口无丢失
- **连接默认 PCUI 优先**：
  - `connection_type` 默认值由 `NETWORK` 改为 `SERIAL`（Rust `config.rs` 与 UCI 默认配置同步）
  - AT 走串口 `/dev/ttyUSB1`（PCUI）；`auto` 探测同样优先 `ttyUSB1`；网络 TCP 20249 保留为备用
  - LuCI 服务配置页连接类型选项改为：PCUI 串口（默认）/ 自动探测（串口优先 ttyUSB1）/ 网络连接（备用）
- **通信架构改为 LuCI RPC（移除 WebSocket）**：
  - 前端 `ws.js` → `rpc.js`：`L.rpc.declare` 调用 rpcd 对象 `mt5700`（`at` 执行 AT 命令、
    `events` 拉取事件增量），实时数据由 1.5s 轮询 `events(since)` 保证；`AtWs` API 面与页面交互不变
  - 新增 rpcd ucode 插件 `root/usr/share/rpcd/ucode/mt5700.uc`：LuCI RPC ↔ Rust 后端代理
    （TCP newline-JSON，仅回环 127.0.0.1，不对外暴露端口）
  - Rust 后端 `wsserver.rs` → `rpcserver.rs`：WebSocket 传输层替换为 TCP newline-JSON-RPC，
    核心业务逻辑（伪命令 CONNECT?/SCHED?/CELLSCAN、扫频状态机、命令分发）全部保留；
    Hub 广播改为有界事件总线（500 条，单调 seq），urc/schedule/cellscan 推送语义不变
  - 认证：LuCI 登录态由 rpcd 会话/ACL 保证；UCI `websocket_auth_key` 由 ucode 代理自动附带（兼容）
  - init.d 不再生成 RPC 端口外网防火墙规则（仅回环）；`websocket_allow_wan` 键保留兼容
  - ACL 增加 `mt5700` 对象（`at`/`events`，read + write）
- 测试同步：e2e 改为 TCP newline-JSON 客户端，**20/20 通过**；解析单测 19/19；Rust 7/7（0 warning）
- 依赖裁剪：移除 `tokio-tungstenite`、`futures-util`（传输层不再需要）

## [1.0.0] - 2026-09-10

### 新增

- **完整迁移原 WebUI 到 OpenWrt LuCI 插件**（`luci-app-mt5700`）
  - 12 个 LuCI 页面全部落地：网络状态 / 网络设置 / 拨号设置 / 全网扫频 / 定时锁频 / 模组设置 / 模组升级 / 短信中心 / 短信设置 / AT 调试终端 / 通知日志 / 服务配置
  - 原侧边栏菜单重构为 LuCI 顶部菜单体系：`网络 → 5G 模组` 与 `服务 → 5G 模组` 两个顶级入口，无功能入口丢失
  - 前端基于 LuCI View/JS + 原生 WebSocket 客户端（`ws.js`），保留原交互语义：确认弹窗、加载态、成功/错误提示、自动刷新、实时订阅
- **后端 Rust 重构**（`at-webserver-rust`，位于 `src/rust/`）
  - Tokio 异步：WebSocket 服务（认证/心跳/FIFO 应答匹配）、AT 客户端（命令串行 100ms、2s 超时、URC 分流）、PDU 编解码、定时锁频调度、小区扫频、企业微信通知、UCI 配置读写
  - 静态 musl 交叉编译支持（zig 链接器），适配 OpenWrt 多架构
- **全量移植原 WebUI 深层功能**
  - 载波辅助小区聚合（`^MONSSC` 8CC + `^CASCELLINFO` 4 SCELL + `^HFREQINFO` 频点对齐合并 + 孤儿小区不丢数据）
  - `^REJINFO` 网络拒绝原因实时面板（3GPP TS 24.008 原因表 + USIM 扩展原因）
  - 连接诊断面板（ENDC / 5G 核心网注册 / 发射功率 / PDP 地址）、`^SIMSQ` 卡状态、温度保护阈值与当前温保等级
- **GitHub Actions 云编译**（`.github/workflows/build-openwrt.yml`）
  - 最新主线（snapshot）→ `.apk` 包（OpenWrt 24.10+ apk 包管理器）
  - 老版本 23.05 → `.ipk` 包（opkg 兼容）
  - 架构矩阵：x86_64 / aarch64_cortex-a53 / mips_24kc(mt7621)；打 `v*` 标签自动发布 GitHub Release

### 修复

- Rust 后端：空闲期模组主动上报（来电/短信/信号）被全部丢弃，与 Go 原版语义不一致 → 按 `handleLine` 语义修复
- Rust 后端：Hub 广播在异步任务内调用 `tokio RwLock::blocking_read` 触发 panic 崩溃 → 改为 `std::sync::RwLock` + 非阻塞 `try_send`
- LuCI 页面缺少 `'require'` 依赖声明（运行时白屏）→ 全部补全
- `upgrade.js` 引用不存在的 `Parse.extractATData` → 修正为 `AtWs.extractATData`

### 测试

- Rust 单测 7/7；端到端（真实 Rust 后端 + mock 模组 + WS 客户端）**22/22**
- 前端解析层单测（carrier / reject / simsq）**19/19**
- LuCI 页面 JS 语法、菜单/ACL JSON、init.d/uci-defaults shell 语法全部通过
- 说明：OpenWrt SDK 交叉编译 / IPK·APK 实编译 / 真机安装验证需通过 GitHub Actions 云编译或本机 SDK 执行（见 `docs/02`）

[1.0.0]: https://github.com/LianXia233/luci-app-mt5700/releases/tag/v1.0.0
