# Changelog

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
