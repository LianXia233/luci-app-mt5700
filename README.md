<div align="center">

# AT WebServer · MT5700M 5G 模组管理

OpenWrt / ImmortalWrt 平台下 MT5700M 5G 模组的全功能控制中心与守护套件

[![Version](https://img.shields.io/badge/Version-v1.14.21-blue.svg?style=flat-square)](https://github.com/LianXia233/luci-app-mt5700/releases)
[![OpenWrt](https://img.shields.io/badge/OpenWrt-24.10%20%7C%2025.x-00C49F.svg?style=flat-square&logo=openwrt)](https://openwrt.org/)
[![ImmortalWrt](https://img.shields.io/badge/ImmortalWrt-Compatible-orange.svg?style=flat-square)](https://immortalwrt.org/)
[![Backend](https://img.shields.io/badge/Backend-Rust%20%7C%20Tokio-DEA584.svg?style=flat-square&logo=rust)](src/rust/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Live Demo](https://img.shields.io/badge/Demo-GitHub%20Pages-4183C4.svg?style=flat-square&logo=github)](https://lianxia233.github.io/luci-app-mt5700/)

<p align="center">
  <b>单包融合交付</b>：集成 12 个原生 LuCI 现代化管理页面与高性能常驻后端 <code>/usr/bin/at-webserver-rust</code><br>
  涵盖全自动拨号对账、网络状态看板、全网扫频、智能锁频、短信收发与交互式 AT 终端
</p>

</div>

---

| 属性维度 | 设定规范 / 说明 |
|:--|:--|
| **软件包名** | `luci-app-mt5700`（独立语言包：`luci-i18n-mt5700-zh-cn`） |
| **系统服务 / 配置段** | `/etc/init.d/at-webserver` · `/etc/config/at-webserver` |
| **后端进程** | `/usr/bin/at-webserver-rust` (基于 Rust / Tokio 异步事件驱动) |
| **LuCI 入口** | 侧边栏：`移动网络` → `5G 模组管理`（访问路径：`admin/modem/5g`） |
| **在线演示** | [GitHub Pages 静态体验](https://lianxia233.github.io/luci-app-mt5700/)（展示 UI 交互，非真实模组读数） |

---

## 界面预览

<div align="center">
  <img src="docs/images/network-status.png" alt="网络状态页面" width="850" style="max-width: 100%; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" />
  <p><sub>图 1：网络状态控制台（展示 AT 通道状态、信号质谱打分及 5G NR 载波聚合参数）</sub></p>
</div>

> [!TIP]
> **看板实时状态说明**  
> 控制台每秒同步模组底层射频指标：实时监测 RSRP、RSRQ、SINR 及动态信号综合评分；精确显示驻网制式（如 5G NR 中频 2565 MHz / 100 MHz 带宽）与小区 PCI / EARFCN 标识。  
> 页面全部图形按实时数据驱动内联 SVG：**4 联射频仪表盘**（240° 表盘 + 放射刻度 + 巡航游标）、**载波聚合频谱占用图**、**芯片微热力拓扑与 4×2 读数矩阵**、**按当前 MCS 动态生成的 I/Q 星座点阵**；**速率曲线可用鼠标或触摸悬浮查看任一采样点的相对时间与上下行速率**。

> [!NOTE]
> **信号三项的取数来源（`AT^HCSQ`，手册 13.5）**  
> 不同制式的字段数、顺序都不同，插件严格按手册的字段表解析：
>
> | 制式 | value1 | value2 | value3 | value4 |
> |:--|:--|:--|:--|:--|
> | `^HCSQ: "NR",…` | 5G RSRP | 5G SINR | 5G RSRQ | — |
> | `^HCSQ: "LTE",…` | LTE RSSI | LTE RSRP | LTE **SINR** | LTE RSRQ |
> | `^HCSQ: "WCDMA",…` | RSSI | RSCP | Ec/Io | — |
> | `^HCSQ: "GSM",…` | RSSI | — | — | — |
>
> 各字段为编码值（RSRP：`-140 + n` dBm；SINR：`-20 + 0.2n` dB；RSRQ：`-19.5 + 0.5n` dB；RSSI/RSCP：`-121 + n` dBm；Ec/Io：`-32 + 0.5n` dB），`255` 表示未知或不可测，按无数据显示为「—」。
> `^MONSC` 的 LTE 布局与 NR 不同（无 SINR、末位是 RSSI、PCI/ARFCN/TAC 为十六进制），插件按制式分别解析；信号优先取 `^MONSC` 的驻留小区读数，缺项（典型是 4G 下的 SINR）再由 `^HCSQ` 补齐。

---

## 系统拓扑与数据链路

<div align="center">
  <img src="docs/topology.png" alt="系统拓扑与数据链路：LuCI WebUI 经 rpcd ucode 代理至 Rust/Tokio 常驻后端，独占管控 MT5700M 模组" width="880"/>
</div>

- **无冲突并发管控**：前端不直连串口，所有 AT 请求统一由 Rust 后端执行互斥锁调度与队列管理，杜绝多进程抢占 TTY 引起的数据截断。
- **超低资源开销**：后端基于 Tokio 异步非阻塞事件驱动，静态内存占用微量，专为低功耗嵌入式路由器优化。

---

## 功能矩阵

系统共集成 12 个独立管理页面（源码位于 `htdocs/luci-static/resources/view/at-webserver/`）：

| 业务域 | 页面名称 | 核心功能与能力说明 |
|:--|:--|:--|
| **射频与基站** | **网络状态** | 4 联射频仪表盘（RSRP / RSRQ / SINR / 综合信号）、载波聚合频谱占用图、芯片微热力拓扑与 4×2 读数矩阵、按 MCS 动态生成的 I/Q 星座图与上下行频谱效率、流量双组看板、IPv4/IPv6 双栈；速率曲线可悬浮查看采样点数据（4G/5G 均按 `^HCSQ` 手册字段表取数，见下） |
| | **网络设置** | 5G/4G 优先模式配置、SA/NSA 模式强制指定、APN 接入点配置 |
| | **全网扫频** | 全频段 / 指定频段快速扫描，导出周边邻区基站列表及物理层信号参数；扫描期间自动断开蜂窝数据、结束后自动恢复（前端有明确弹窗提示） |
| | **定时锁频** | 支持锁定频段（Band）、频点（EARFCN）与基站物理小区 ID（PCI） |
| **数据与链路** | **拨号设置** | USB NDIS 拨号 / 转网口模式切换，承载网络链路状态守护与自动对账 |
| | **模组设置** | 模组核心元数据查询（含自动识别的 USB 链路速率，sysfs 读取、不发 AT 命令）、软硬件复位重启、出厂配置重置 |
| | **模组升级** | 模组新固件远程推送检测与本地固件包上传刷写 |
| **消息与运维** | **短信中心** | 支持 PDU / Text 短信收发、长短信自动分段重组、SIM 卡短信池查看；会话呈**聊天式单时间轴**（对方在左、自己在右，跨天插日期分隔条，气泡宽度随内容收缩） |
| | **短信设置** | 自定义短信中心号（SMSC）、自动化短信转发与容量自清理策略 |
| | **AT 调试终端** | Web 原生交互式控制台，支持常用指令自动补全、历史回溯与原语调试 |
| | **通知日志** | 掉线告警、频段漂移记录，支持企业微信机器人、QQ 机器人（API v2）与 Webhook 实时推送 |
| | **服务配置** | 守护进程参数、通信串口绑定、退避重试阈值与自愈巡检开关 |

---

## 架构选型决策流

OpenWrt 的软件包架构标识为 `<base>[_<variant>]` 形式，**包管理系统执行严格的 variant 匹配**：

```mermaid
flowchart TD
    Start(["🔍 1. 设备架构查询<br/><code>cat /etc/apk/arch</code> 或 <code>grep OPENWRT_ARCH</code>"]) --> Check{"系统声明的基础架构及变体"}

    Check -->|"aarch64_cortex-a53"| A53["📦 下载 <code>aarch64_cortex-a53-luci-app-mt5700-*</code><br/><i>(常见来源: MT7986 / Qualcommax 等声明 CPU_TYPE 的固件)</i>"]
    Check -->|"aarch64_generic"| Generic["📦 下载 <code>aarch64_generic-luci-app-mt5700-*</code><br/><i>(常见来源: armsr / iStoreOS 25.x 等通用 ARMv8 固件)</i>"]
    Check -->|"x86_64"| X86["📦 下载 <code>x86_64-luci-app-mt5700-*</code><br/><i>(常见来源: PC 软路由 / PVE / ESXi 虚拟机)</i>"]

    A53 --> PreCheck["💡 2. 安装前零风险预演验证<br/><code>apk add --simulate --allow-untrusted ./包名.apk</code>"]
    Generic --> PreCheck
    X86 --> PreCheck

    PreCheck --> Pass{"输出 (1/1) Installing ?"}
    Pass -->|通过| Install(["🚀 3. 正式执行安装并自动启动服务"])
    Pass -->|报错| ErrorFix["⚠️ 常见报错排查对照处理"]

    classDef check fill:#EAECEE,stroke:#5D6D7E,stroke-width:2px,color:#1B2631;
    classDef pack fill:#E8F8F5,stroke:#1ABC9C,stroke-width:2px,color:#0E6251;
    classDef pre fill:#FEFDE8,stroke:#F1C40F,stroke-width:2px,color:#7D6608;
    classDef ok fill:#E8F6F3,stroke:#27AE60,stroke-width:2px,color:#1E8449;
    classDef err fill:#FDEDEC,stroke:#E74C3C,stroke-width:2px,color:#78281F;

    class Start,Check check;
    class A53,Generic,X86 pack;
    class PreCheck pre;
    class Install ok;
    class ErrorFix err;
```

> [!NOTE]
> `aarch64_cortex-a53` 与 `aarch64_generic` 同属于 ARMv8-A 指令集，**底层二进制完全通用**。安装被阻断仅由包管理器元数据校验引起，并非硬件不兼容。

### 1. 确认系统声明的有效架构

```sh
# apk 系统（OpenWrt 25.x / ImmortalWrt SNAPSHOT / iStoreOS 25.x）
cat /etc/apk/arch

# opkg 系统（OpenWrt 24.10 及更早版本）
grep OPENWRT_ARCH /etc/openwrt_release
```

> [!WARNING]
> 切勿使用 `apk --print-arch` 判定。该命令返回的是 apk 编译目标的预设值，并不等同于包管理器运行时依据的 `/etc/apk/arch`。必须以 `/etc/apk/arch` 的首行输出为准。

### 2. 常见包校验报错速查

| 终端报错输出 | 根因剖析 | 推荐解决方案 |
|:--|:--|:--|
| `error: uninstallable arch: aarch64_cortex-a53` | 固件声明架构为 `aarch64_generic` | 改下 `aarch64_generic` 的包；或临时执行：<br>`echo aarch64_cortex-a53 >> /etc/apk/arch` |
| `error: uninstallable arch: aarch64_generic` | 固件声明架构为 `aarch64_cortex-a53` | 重新下载并安装 `aarch64_cortex-a53` 安装包 |
| `error: uninstallable arch: all` | 语言包架构未被识别 | 实测 apk-tools 3.0.5+ 已兼容，若报错可执行：<br>`echo all >> /etc/apk/arch` |
| `luci-app-mt5700 (no such package): required by: luci-i18n-...` | 语言包依赖主包，未合并安装 | 将主包与语言包放入同一条 `apk add` / `opkg install` 指令中 |

---

## 安装与快速启动

### 软件包安装

在 [Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 页面下载与设备架构完全对应的软件包后安装（主包已内嵌 Rust 后端）：

```sh
# 【OpenWrt 25.x / ImmortalWrt SNAPSHOT (apk)】
apk add --allow-untrusted \
  ./<ARCH>-luci-app-mt5700-1.14.21-r1.apk \
  ./<ARCH>-luci-i18n-mt5700-zh-cn-*.apk

# 【OpenWrt 24.10 及更早版本 (opkg)】
opkg install ./<ARCH>-luci-app-mt5700_1.14.21_<ARCH>.ipk
opkg install ./<ARCH>-luci-i18n-mt5700-zh-cn_*.ipk
```

### 快速初始化与启动

```sh
# 1. 提交初始服务配置
uci set at-webserver.config.enabled=1
uci set at-webserver.config.connection_type=SERIAL   # 选用 PCUI 串口直连
uci set at-webserver.config.serial_port=auto         # 自动探测系统 AT 串口（优先 by-id）
uci commit at-webserver

# 2. 启动服务并验证后端
service at-webserver restart
ls -l /usr/bin/at-webserver-rust
ubus call service list '{"name":"at-webserver"}'
```

### 串口路径选择建议

`serial_port` 支持三种取值：`auto`（自动探测）、`/dev/serial/by-id/<链接名>`（**推荐**）、`/dev/ttyUSB*`（回退）。

`/dev/ttyUSB*` 的编号由内核枚举顺序决定，**同一模组换 USB 口或换控制器后会整体平移**（实测换口后 PC UI 从 `ttyUSB1` 变成 `ttyUSB2`），手工选定的路径随即失效，表现为「昨天配好能用，拔插一次就再也不通」。`/dev/serial/by-id/` 下的链接名由 `idVendor:idProduct` 与接口描述符生成，与枚举顺序无关：

```sh
# 查看当前稳定链接与 AT 口对应关系
ls -l /dev/serial/by-id/

# 固化到配置（if12 为 PC UI / AT 口）
uci set at-webserver.config.serial_port='/dev/serial/by-id/usb-XXXX:XXXX-if12-<序列号>'
uci commit at-webserver
service at-webserver restart
```

自动探测的优先级为：`by-id` 稳定链接 → `ttyUSB*`/`ttyACM*`/`ttyAP*` → `ttyS*`/`ttyAMA*`。AT 口识别依次依据**接口名整词匹配**（`PC UI` / `PCUI` / `AT PORT`）与 **`bInterfaceProtocol` 兜底**（`0x12`=PC UI、`0x14`=GPS），后者在 OEM 固件接口名留空时仍能正确认口。

---

## 自动拨号与全链路协同机制

> [!CAUTION]
> **重要认知**：模组 AT 握手在线并不等同于路由器具备上网能力。数据面打通需跨越软硬件各层级协同。

<div align="center">
  <img src="docs/auto-dial-sequence.png" alt="MT5700M 5G 模组自动拨号与网络接入时序图" width="880"/>
</div>

### 各环节职责与协同划分

| 协作环节 | 负责组件 | 运行机制与容灾方案 |
|:--|:--|:--|
| **拨号开关与方式对齐** | Rust 后端 | 建立连接后强制核验；未达成执行退避重试（0/5/15/30/60/120s），每 5 分钟定时巡检对账 |
| **可用性双判决** | Rust 后端 | 联合校验 `AT^NDISSTATQRY?` 与 `AT+CGACT?` 双重指标，杜绝假死虚挂 |
| **承载接口拉起** | init.d + hotplug | 18 次 × 10s 间隔轮询保护；`hotplug.d/iface` 与 `hotplug.d/usb` 动态补发 `ifup` |
| **接口缺失补全** | init.d | 识别到网卡硬件即按 `proto=dhcp` 自动建立 `MT5700M` 与 `MT5700Mv6` |
| **防火墙区域绑定** | init.d | 接口创建后自动登记至 `wan` 区域并重载 `fw4`，打通 `lan → wan` 的 NAT 规则 |

### 故障链路排查速查

| 检查项 | 排查命令 | 预期状态 |
|:--|:--|:--|
| **串口设备识别** | `ls -l /dev/ttyUSB* /dev/ttyACM*` | 至少存在一个可用的 AT 通信口 |
| **稳定路径链接** | `ls -l /dev/serial/by-id/` | 每个 USB 串口口对应一条链接（`if12` 为 AT 口），零断链 |
| **重建稳定链接** | `/etc/init.d/at-webserver sync_serial_by_id` | 输出「已维护 N 个 /dev/serial/by-id 稳定链接」 |
| **自动拨号对账** | `logread -e at-webserver \| grep 自动拨号` | 输出「已处于期望状态」或「复核通过」 |
| **承载接口地址** | `ifstatus MT5700M \| grep -A2 "ipv4-address"` | 存在明确分配的 `address` 字段 |
| **NAT 区域绑定** | `uci show firewall \| grep 'network=.*MT5700M'` | 有输出（**若未绑定区域，会导致有 IP 却上不了网**） |
| **防火墙规约** | `nft list chain inet fw4 srcnat` | 条目中包含模组对应网口（如 `oifname { "eth1" }`） |
| **一键自愈修复** | `/etc/init.d/at-webserver ensure_interfaces` | 重新校验接口并补全防火墙区域登记 |
| **手动重试拉起** | `/etc/init.d/at-webserver on_uplink` | 立即重试触发接口 `ifup` |

---

## 开机自启与自愈机制

- **后端常驻保护（Rust 服务）**：
  - 由 `/etc/uci-defaults/at-webserver` 与 `postinst` 协同创建软链接 `/etc/rc.d/S99at-webserver`。
  - 通过 OpenWrt 原生 `procd` 进程守护，配置 `respawn` 实现异常闪退自动拉起。
  - **自愈机制**：每次调用 `start` 若检测到 `/etc/rc.d` 软链接异常缺失，将自动补齐 `enable`，杜绝因固件文件权限回退（如 100644）造成的永久自启失效。
- **前端接入与热生效（LuCI）**：
  - rpcd 扫描加载 `/usr/share/rpcd/ucode/mt5700.uc`。
  - 安装脚本自动执行 `/etc/init.d/rpcd reload`，实现免重启系统即刻渲染 LuCI 菜单。
- **IPv4 / IPv6 双栈解耦**：
  - `MT5700M` 负责 IPv4 核心通路；`MT5700Mv6` 采用 `reqaddress=try` 动态绑定 `@MT5700M` 设备。即便运营商暂未分配 IPv6 前缀，亦绝不阻塞 IPv4 连通性。

---

## UCI 配置参考 (`/etc/config/at-webserver`)

```ini
config at-webserver 'config'
    option enabled '1'                  # 服务总开关：1=启用，0=禁用
    option connection_type 'SERIAL'     # 通信方式：SERIAL(串口) / TCP(网络回环)
    option serial_port 'auto'           # 串口定位：auto(自动探测) / /dev/serial/by-id/<链接> / /dev/ttyUSB*
    option serial_port_custom '/dev/ttyUSB1' # 手动指定时的备用路径（前端「自定义路径」写入）
    option autodial_enable '1'          # 自动拨号守护开关：1=启用，0=关闭
    option autodial_mode '1'            # 拨号工作模式：1=USB网卡，2=转以太网口模式
    option cellscan_timeout '180'       # 扫频超时阈值(秒)，最低安全下限 10
```

---

## 事件通知配置

事件通知（来电/短信/信号变化/短信存储满）支持两条推送通道 + 本地日志文件。**短信与来电实时直发**（事件一到就发），**信号与存储满同样即时直发**；此外还有一个独立定时器，每到一个间隔就推送一次**当前实际情况**（间隔可配置，单位分钟，默认 10）：

| 通道 | 配置项 | 说明 |
|:--|:--|:--|
| 总开关 | `notify_enabled` | 自动推送总开关，默认 `1`；关闭后仅写本地日志、外发全部停止 |
| 企业微信 | `wechat_webhook` | 群机器人 WebHook 地址 |
| QQ 机器人 | `qq_app_id` / `qq_app_secret` / `qq_target_type` / `qq_target_id` | 官方 API v2，目标类型 `group`（群聊）/ `c2c`（单聊）/ `channel`（频道）/ `bind`（自动绑定） |
| 定时推送间隔 | `notify_timer_interval` | 定时推送周期（**分钟**），取值 1~1440（1 分钟 ~ 24 小时），默认 10；每到一个间隔推送一次**当前实际情况**。旧键 `notify_interval`（秒，5~3600）自动迁移：**出厂默认值 60 秒落到新默认值 10 分钟**，被改过的值才按「向上取整到分钟」换算 |
| 信号巡检 | `notify_poll_enabled` / `notify_poll_start` / `notify_poll_end` / `notify_poll_interval` / `notify_poll_all` / `notify_poll_delta` | 时段内主动轮询信号（本模组不主动上报信号读数） |
| 推送文案 | `notify_tpl_prefix` / `notify_tpl_sms` / `notify_tpl_call` / `notify_tpl_signal` / `notify_tpl_memory` / `notify_tpl_batch` | 全局前缀 + 五类事件文案模板，支持占位符 |
| 日志文件 | `log_file` | 本地逐条落盘（总开关关闭时仍写） |

### 事件类型与推送路径

| 事件 | 来源 | 推送路径 |
|:--|:--|:--|
| 新短信 | 模组主动上报 `+CMTI:` | **实时直发** |
| 来电 | 模组主动上报 `RING` | **实时直发** |
| 存储满 | 模组主动上报 `^SMMEMFULL` | **实时直发** |
| 信号 | 后端定时巡检（`notify_poll_*`） | **实时直发**（巡检命中即发） |
| 当前状态 | 定时器（`notify_timer_interval`） | **周期性推送**：到点推送此刻真实状态，与「期间有没有事件发生」无关 |

### 自动推送总开关

`notify_enabled` 是全部推送的**总闸门**，默认开启。关闭后：

- 不再外发任何消息（企业微信 / QQ 均静默）；
- **仍然写本地通知日志** —— 关的是「推送」而不是「记录」，留着事后追溯；
- **停止信号定时巡检** —— 否则关了开关后台仍在周期性占用串口，看起来像开关无效。

LuCI 页面在关闭时会联动置灰四个事件类型开关与整块巡检子区块。

### 信号定时巡检

**为什么需要它**：本模组（TDTECH / Fibocom 系）**不会主动上报** `^HCSQ` / `^CERSSI` —— 实机 1200 条 AT 记录里自发信号上报为 **0 条**，因此「信号变化通知」若没有后端主动查询就永远是死的。开启巡检后，后端在指定时段内按间隔查询信号；**时段外一条 AT 都不发**。

```uci
option notify_poll_enabled '1'        # 是否启用信号定时巡检
option notify_poll_start '00:00'      # 时段起点 HH:MM（含，默认全天）
option notify_poll_end '23:59'        # 时段终点 HH:MM（含）
option notify_poll_interval '300'     # 巡检间隔（秒），范围 30-3600
option notify_poll_all '0'            # 0=仅信号变化时推送 / 1=每次巡检都推送当前状态
option notify_poll_delta '3'          # 变化阈值（dB），范围 1-30，仅 notify_poll_all=0 时生效
```

时段写法：起点晚于终点表示**跨零点**（如 `22:00` 至 `06:00`）；起止相同视为**全天**；格式非法时回落全天并记一条告警。区间为闭区间（两端都算在时段内）。

「仅信号变化时推送」策略的细节：

- **首次读数恒定推送一次**，让用户立刻确认功能在工作；
- **制式切换（LTE ↔ NR）必定推送**，即便 RSRP 数值没变；
- **基线只在推送时刷新** —— 否则信号从 -80 缓慢漂移到 -95（每次仅差 2 dB）将永远越不过阈值，用户反而收不到「信号持续变差」这个最该知道的通知。
- **推送内容**：巡检推送携带与网页「射频信号质量」卡片**等价的完整评估** —— 网络能力结论与其场景说明、信号强度 / 信号质量 / 信噪比 / 综合四项评级，以及 RSRP / RSRQ / SINR / SIGNAL 四行「基准 ≥ 阈值 → 实测值 → 结论」对照。标题给出网络代际（`5G` / `4G`），另有「频段」行给出具体频段号与带宽（如 `n41 · 2565 MHz / 100 MHz`，取自 `AT^HFREQINFO?` 的 `<band>`）。只报一个 RSRP 数字不足以判断链路是否真的可用。

### 定时推送间隔与自定义文案

- **定时推送间隔**：`notify_timer_interval` 单位是**分钟**，取值 1~1440（1 分钟 ~ 24 小时），越界会被自动夹取，默认 **10 分钟**。每到一个间隔后端就推送一次**当前实际情况**（最新信号读数 + 短信存储占用），不再看窗口内有没有事件 —— 这一轮风平浪静也照发。
- **间隔怎么选（权衡）**：间隔越短，状态越新鲜，但推送条数越多、越容易打扰，也更容易撞上 QQ 官方主动消息频控；间隔越长越安静，可**两次之间发生的变化只能等到下一个整点才被看到**，且单次推送要承载的内容更满（状态快照含信号与存储两块），读起来更费劲。日常建议 5~30 分钟；只在需要长期静默时才调到小时级。
- **为什么默认从 60 秒改成 10 分钟**：原「合并窗口」语义下 60 秒只决定「攒多久发一次」，窗口内没事件就一条都不发；改成定时推送后**每一轮必定发一条**，仍按 60 秒就是每天 1440 条，远超 QQ 频控（单关系 20 条/分钟、群 30~60 条/分钟、1000 条/群/天）。默认上调到 10 分钟（每天 144 条）是在「状态新鲜」与「不刷屏」之间取的平衡点；想要更实时，把间隔调小即可（最小 1 分钟）。
- **与信号巡检的关系**：两者**并存互不影响**。信号巡检（`notify_poll_*`）只在设定时段内跑，负责抓**突变**；定时推送负责**保底**，到点就报一次当前状态，让你确认链路还在。只想保留突变通知的话，把间隔拉到最大（1440 分钟 = 24 小时）即可近似关闭。
- **不受此配置影响**：短信与来电始终实时直发，与定时推送间隔无关。
- **老设备升级怎么迁移**：旧键 `notify_interval` 无需手工改，但** 60 秒是出厂默认值而不是你的选择** —— 包内配置原本就写死 60，若一律换算成 1 分钟，升级后每台设备都会每分钟推一条（每天 1440 条，远超 QQ 频控）。因此 60 秒落到新的默认值 10 分钟；**被你改过的值**（如 300 秒）才按「向上取整到分钟」换算成 5 分钟。
- **文案模板**：留空表示使用内置默认文案。可用占位符：

| 占位符 | 含义 |
|:--|:--|
| `{sender}` | 事件来源（发送号码 / 来电号码 / `信号监控`） |
| `{content}` | 事件正文（短信内容 / 来电号码 / 信号摘要 / 存储满提示） |
| `{time}` | 事件发生时刻 |
| `{kind}` | 事件类型（`新短信` / `来电` / `信号变化` / `存储空间已满`） |
| `{count}` | 合并消息条数（仅全局前缀与批量标题有意义） |

  未知占位符会原样保留，便于发现拼写错误。默认文案为：

```uci
option notify_tpl_prefix ''                 # 全局前缀，每条推送首行；如 '[MyRouter] {time}'
option notify_tpl_sms    '喵呜～，有新短信到啦！快来看看是谁给你发消息了喵~\n发送者: {sender}\n内容: {content}'
option notify_tpl_call   '喵呜～有电话打进来啦，快接起来看看是谁找你喵！\n{content}'
option notify_tpl_signal '{content}'
option notify_tpl_memory '喵呜～短信存储空间已经满啦，请尽快清理一下喵，不然可能收不到新的短信了哦！'
option notify_tpl_batch  '喵～有一批新通知需要查看哦，快来看看都有哪些消息吧！'
```

  UCI 单个 option 不支持真实换行，模板中的换行以 `\n` 转义写入（LuCI 页面会自动转换，手改 UCI 需自行写 `\n`）。

### 推送自检（测试推送）

通知卡片提供两个粒度的自检入口，回答的是两个不同的问题：

| 按钮 | 回答的问题 | 发送方式 |
|:--|:--|:--|
| 发送测试通知 | 这条通道**通不通** | 固定文案，直接投递，不经过事件链路 |
| 测试短信推送 / 测试来电推送 | 该类型事件的**完整链路**对不对 | 构造同形状事件走 `notify()`：总开关 → 分类开关 → 实时直发 → 文案模板 → 通道投递 |

第二组的价值在于：短信与来电**只能由模组 URC 触发**，否则想验证文案与实时性就得真收一条短信。它构造的事件与真实事件同形状，所以收到的文本一字不差；号码用掩码 `138****0000`、正文带「（测试消息，非真实…）」标注，不会被误当成真事。

- 开关没开时**不会假装成功**：后端明确返回原因（总开关关闭 / 该类型开关关闭 / 没有可用通道），页面原样转述；
- **信号不走类型化测试**：信号指标是真实读数，造一条假的「RSRP -xx dBm」测不出任何东西。验证请用真实巡检 —— 把 `notify_poll_interval` 临时调小（下限 30 秒）等一轮，或直接看通知日志里的历史巡检记录；
- 等价的 RPC 调用（供脚本化自检）：`{"method":"notify_test","params":{"channel":"sms"}}`，`channel` 可取 `qq` / `wechat` / `sms` / `call`。

### 时区与时间口径

**所有对外时间一律使用本机系统时区** —— 即 LuCI「系统 → 时间同步 → 时区」写下的 UCI `system.@system[0].timezone`；系统未配置时默认**北京时间（UTC+08:00）**。覆盖范围：通知日志时间戳、推送正文里的 `{time}`、短信中心每条短信的时刻、定时锁频的「下一次切换时刻」。

取值顺序（`/etc/init.d/at-webserver` 与后端 `crate::localtime` **完全同序**，保证服务内外口径一致）：

1. `/etc/TZ` —— 由系统时区派生的 POSIX TZ 串（如 `CST-8`）；
2. `uci -q get system.@system[0].timezone`；
3. 回落到 `CST-8`（北京时间）。

> **注意 POSIX TZ 的符号与直觉相反**：`CST-8` 表示 **UTC+8**（POSIX 中符号代表「本地时间 = UTC − 偏移」），写成 `CST+8` 会得到 UTC−8。

**为什么必须显式注入**：`TZ` 环境变量只由 `/etc/profile` 为**登录 shell** 导出，procd 拉起的守护进程拿不到；本固件又不打包 tzdata（`/usr/share/zoneinfo` 不存在），musl 的 `localtime_r` 在无 `TZ` 时会**静默退化成 UTC**。故 init.d 在启动时按上述顺序取值，并通过 `procd_set_param env TZ=...` 注入给后端。

### QQ 机器人通道说明

- **启用条件**：AppID、AppSecret、目标 ID 三项全部非空。
- **凭据安全**：AppSecret 建议不写入 UCI，改由环境变量注入（`QQ_BOT_APP_SECRET`；AppID 可用 `QQ_BOT_APP_ID`），环境变量优先于 UCI。可在 `/etc/init.d/at-webserver` 的 `procd_set_param env` 处追加。
- **目标 ID**：`group_openid` / 用户 openid / `channel_id` 由机器人事件回调（如 `GROUP_AT_MESSAGE_CREATE`）获得，**不是 QQ 号或群号**。
- **绑定自己的 QQ 号（一次性流程）**：QQ 开放平台出于隐私设计，接口层不提供「QQ 号 → openid」转换，openid 只能从机器人事件中获取。每个用户只需绑定一次：
  1. 本机执行 `pip install websocket-client`，然后运行 `python3 scripts/qq-capture-openid.py --app-id <AppID> --app-secret <AppSecret>`（或用环境变量传凭据）；
  2. 在 QQ 里给机器人发一条消息（单聊任意内容，或群里 @机器人）；
  3. 脚本输出 openid 与现成的 UCI 配置命令，粘贴执行即可。凭据与 openid 不经手第三方。
- **鉴权**：`POST https://api.bot.qq.com/app/getAppAccessToken` 换取 `access_token`（7200 秒），服务自动缓存并在过期前 120 秒刷新。
- **已知限制**：本服务为单向推送、不连 WebSocket，所有消息均为**主动消息**（不带 `msg_id`），受官方频控约束（群 30~60 条/分钟、单关系 20 条/分钟、1000 条/群/天，未认证/认证档不同），且 QQ 用户关闭「允许主动发送」后推送会失败；频道主动推送官方要求机器人保持 WebSocket 在线，`channel` 模式可能被平台拒绝。默认 10 分钟的定时推送间隔（每天 144 条）远低于上述频控；若把间隔调到 1 分钟（每天 1440 条），请先确认不会撞上限。

---

## 源码目录结构

```
luci-app-mt5700/
├── Makefile                                # 顶层软件包构建定义 (PKG_VERSION=1.14.21)
├── htdocs/luci-static/resources/
│   ├── view/at-webserver/                  # 12 个 LuCI 页面前端视图脚本
│   └── at-webserver/                       # 前端支撑库 (rpc.js / ui.js / at.css)
├── root/                                   # 系统文件系统镜像结构
│   ├── etc/config/at-webserver             # UCI 默认配置文件
│   ├── etc/init.d/at-webserver             # 核心 init.d 守护脚本 (含接口拉起与自愈)
│   ├── etc/uci-defaults/at-webserver       # 首次刷机安装自愈断言脚本
│   ├── etc/hotplug.d/iface/99-at-webserver # 网络接口变动事件响应
│   ├── etc/hotplug.d/usb/99-at-webserver   # 模组硬件插拔热插拔联动
│   └── usr/
│       ├── libexec/at-webserver/on-uplink.sh # 后端拨号对账就绪通知回调
│       └── share/rpcd/ucode/mt5700.uc      # rpcd 业务代理中间件
├── src/
│   ├── Makefile                            # Rust 后端交叉编译脚本 (带架构校验拦截)
│   └── rust/                               # Rust 后端核心源码仓库
├── po/                                     # 国际化语言包 (zh_Hans)
├── scripts/sdk-build.sh                    # OpenWrt SDK 矩阵自动化打包脚本
└── tests/mock-modem/                       # 自动化测试 Mock 模组服务与 E2E 用例
```

---

## 云编译与发布

本项目依托 GitHub Actions（`.github/workflows/build-openwrt.yml`）实现全自动化矩阵云编译：

- **系统覆盖**：针对 `25.12.5` 自动构建 `apk`；针对 `24.10.8` 自动构建 `ipk`。
- **架构矩阵**：全量覆盖 `x86_64`、`aarch64_cortex-a53`、`aarch64_generic`（共计 6 套构建组合）。
- **硬性断言防御**：构建阶段比对 SDK 输出的 `CONFIG_TARGET_ARCH_PACKAGES` 与矩阵架构标识，不一致立即阻断并硬失败，确保产物元数据绝对精确。
- 编译通过后自动推送构建产物至 [Release](https://github.com/LianXia233/luci-app-mt5700/releases)，并随包打包发布 `ARCH-GUIDE.txt`。

---

## 许可证

本项目遵循 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 开源协议。
